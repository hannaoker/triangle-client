import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import {
  createTurnCapabilityIssuer,
  createTurnCapabilityValidator,
} from "../src/local-messaging-credentials.mjs";
import { createPerSenderRateLimiter, createConversationLoopTracker } from "../src/local-messaging-rate-limiter.mjs";
import { writePrivateJson } from "../src/local-messaging-auth-broker.mjs";
import { createInteractiveSessionBroker } from "../src/local-messaging-interactive-session.mjs";

function setupWakeTestEnv() {
  const baseTmp = fs.existsSync("/private/tmp") ? "/private/tmp" : (fs.existsSync("/tmp") ? "/tmp" : os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(baseTmp, "tri-wake-test-"));
  fs.chmodSync(tmpDir, 0o700);
  const stateRoot = path.join(tmpDir, "state");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const socketPath = path.join(stateRoot, "local-control.sock");

  const secret = crypto.randomBytes(32).toString("hex");
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });

  const codexId = crypto.randomBytes(32).toString("hex");
  const claudeId = crypto.randomBytes(32).toString("hex");
  const runnerId = crypto.randomBytes(32).toString("hex");

  const integrationPath = path.join(stateRoot, "claude-integration.json");
  const interactiveSecret = crypto.randomBytes(32).toString("hex");
  const interactiveSessionId = crypto.randomUUID();
  const interactiveBindingId = crypto.randomUUID();

  writePrivateJson(integrationPath, {
    version: 1,
    type: "interactive",
    senderId: claudeId,
    sessionId: interactiveSessionId,
    generation: 1,
    bindingId: interactiveBindingId,
    secret: interactiveSecret,
    enabled: true,
    revoked: false,
  });

  const acl = createOwnerAcl({
    rules: {
      [codexId]: [claudeId, runnerId],
      [claudeId]: [codexId, runnerId],
      [runnerId]: [codexId, claudeId],
    },
  });

  const journal = createLocalMessagingJournal({ stateRoot });

  const interactiveBroker = createInteractiveSessionBroker({
    integrationPath,
    recipients: [codexId, runnerId],
    issue: (sender, opts) => issuer.issue({ senderId: sender, ...opts }),
  });

  const server = createLocalControlServer({
    socketPath,
    journal,
    acl,
    credentialValidator: validator,
    interactiveBroker,
    interactiveRecipients: new Set([claudeId]),
    dispatcher: {
      start: async () => {},
      stop: async () => {},
      notifyAdmission: async () => {},
    },
    rateLimiter: createPerSenderRateLimiter({ maxRequestsPerWindow: 200, windowMs: 60000 }),
    loopTracker: createConversationLoopTracker({ journal }),
  });

  return {
    tmpDir,
    stateRoot,
    socketPath,
    integrationPath,
    claudeId,
    codexId,
    runnerId,
    interactiveSessionId,
    interactiveBindingId,
    interactiveSecret,
    server,
    journal,
    interactiveBroker,
    issuer,
    async cleanup() {
      await server.close();
      await journal.close();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test("Distinct Claude binding initialized by supervisor lifecycle; never peer-supplied thread or Codex target reuse", async () => {
  const env = setupWakeTestEnv();
  try {
    await env.server.start();

    // Initialize interactive wake binding via validated supervisor lifecycle
    const binding = await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });

    assert.equal(binding.targetIdentity, env.claudeId);
    assert.equal(binding.generation, 1);
    assert.equal(binding.bindingId, env.interactiveBindingId.toLowerCase());
    assert.equal(binding.threadId, `claude-session:${env.interactiveSessionId}`);
    assert.equal(binding.deliveryState, "idle");
  } finally {
    await env.cleanup();
  }
});

test("Two concurrent children and identical reservation retries yield exactly one socket delivery permission", async () => {
  const env = setupWakeTestEnv();
  try {
    await env.server.start();
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });

    // Ingest a message for Claude so obligations exist
    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: "msg-" + crypto.randomUUID(),
      requestId: "req-" + crypto.randomUUID(),
      text: "hello claude",
    });

    const client1 = createLocalControlClient({ socketPath: env.socketPath, senderId: env.claudeId });
    const client2 = createLocalControlClient({ socketPath: env.socketPath, senderId: env.claudeId });

    const grant = await client1.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });
    client2.activeTurnCredential = grant.credential;

    const reservationId1 = crypto.randomUUID();
    const reservationId2 = crypto.randomUUID();

    // Concurrent reservation race with different reservation IDs
    const [res1, res2] = await Promise.all([
      client1.reserveWakeNotification({ reservationId: reservationId1 }, { credential: grant.credential }),
      client2.reserveWakeNotification({ reservationId: reservationId2 }, { credential: grant.credential }),
    ]);

    // Exactly one winner gets deliveryAllowed: true
    const permits = [res1, res2].filter((r) => r.deliveryAllowed === true);
    assert.equal(permits.length, 1, "Exactly one child must win delivery permission");

    const winnerResId = permits[0].wakeId;
    assert.equal([reservationId1, reservationId2].includes(winnerResId), true);

    // Retrying with the EXACT SAME winning reservationId returns prior metadata but deliveryAllowed: false
    const retryRes = await client1.reserveWakeNotification({ reservationId: winnerResId }, { credential: grant.credential });
    assert.equal(retryRes.deliveryAllowed, false, "Duplicate reservation retry must NOT grant deliveryAllowed");
    assert.equal(retryRes.reserved, false);
    assert.equal(retryRes.wakeId, winnerResId);

    await client1.close();
    await client2.close();
  } finally {
    await env.cleanup();
  }
});

test("Backlog fingerprint deduplication: No obligations, unchanged backlog, new inbound, min interval", async () => {
  const env = setupWakeTestEnv();
  try {
    await env.server.start();
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });

    const client = createLocalControlClient({ socketPath: env.socketPath, senderId: env.claudeId });
    const grant = await client.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    // 1. No obligations -> reserve returns deliveryAllowed: false (no_obligations)
    const emptyRes = await client.reserveWakeNotification({ reservationId: crypto.randomUUID() }, { credential: grant.credential });
    assert.equal(emptyRes.deliveryAllowed, false);
    assert.equal(emptyRes.state, "no_obligations");

    // Ingest a message
    const msgId = "msg-" + crypto.randomUUID();
    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: msgId,
      requestId: "req-" + crypto.randomUUID(),
      text: "hello backlog",
    });

    // 2. Win reservation
    const wakeId = crypto.randomUUID();
    const won = await client.reserveWakeNotification({ reservationId: wakeId }, { credential: grant.credential });
    assert.equal(won.deliveryAllowed, true);

    // Report accepted and ack
    await client.reportWakeResult({
      wakeId,
      generation: 1,
      sessionId: env.interactiveSessionId,
      bindingId: env.interactiveBindingId,
      result: "accepted",
    }, { credential: grant.credential });

    await client.ackWake({ wakeId, generation: 1 }, { credential: grant.credential });

    // 3. Unchanged backlog -> reserve returns deliveryAllowed: false (unchanged_backlog or rate_limited)
    const unchanged = await client.reserveWakeNotification({ reservationId: crypto.randomUUID() }, { credential: grant.credential });
    assert.equal(unchanged.deliveryAllowed, false);

    await client.close();
  } finally {
    await env.cleanup();
  }
});

test("Delivery failure and ambiguity: failed-before-write, timeout, lost RPC response retain non-idle uncertain state without resend", async () => {
  const env = setupWakeTestEnv();
  try {
    await env.server.start();
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });

    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: "msg-" + crypto.randomUUID(),
      requestId: "req-" + crypto.randomUUID(),
      text: "test failure",
    });

    const client = createLocalControlClient({ socketPath: env.socketPath, senderId: env.claudeId });
    const grant = await client.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    const wakeId = crypto.randomUUID();
    const won = await client.reserveWakeNotification({ reservationId: wakeId }, { credential: grant.credential });
    assert.equal(won.deliveryAllowed, true);

    // Pre-write connect failure reported as 'failed' -> transitions to UNCERTAIN (NOT IDLE!)
    const reportRes = await client.reportWakeResult({
      wakeId,
      generation: 1,
      sessionId: env.interactiveSessionId,
      bindingId: env.interactiveBindingId,
      result: "failed",
    }, { credential: grant.credential });

    assert.equal(reportRes.state, "uncertain");

    // Verify binding in DB is uncertain
    const b = await env.journal.getWakeBinding(env.claudeId);
    assert.equal(b.deliveryState, "uncertain");

    // Subsequent reserve attempt is refused: state is uncertain, no implicit resend!
    const nextTry = await client.reserveWakeNotification({ reservationId: crypto.randomUUID() }, { credential: grant.credential });
    assert.equal(nextTry.deliveryAllowed, false);
    assert.equal(nextTry.state, "uncertain");

    await client.close();
  } finally {
    await env.cleanup();
  }
});

test("Early ack racing accepted/uncertain reports: late report never resurrects acknowledged wake", async () => {
  const env = setupWakeTestEnv();
  try {
    await env.server.start();
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });

    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: "msg-" + crypto.randomUUID(),
      requestId: "req-" + crypto.randomUUID(),
      text: "early ack test",
    });

    const client = createLocalControlClient({ socketPath: env.socketPath, senderId: env.claudeId });
    const grant = await client.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    const wakeId = crypto.randomUUID();
    const won = await client.reserveWakeNotification({ reservationId: wakeId }, { credential: grant.credential });
    assert.equal(won.deliveryAllowed, true);

    // Early ack: ack arrives WHILE binding is in 'submitting' (before report RPC!)
    const ackRes = await client.ackWake({ wakeId, generation: 1 }, { credential: grant.credential });
    assert.equal(ackRes.acknowledged, true);

    const afterAckBinding = await env.journal.getWakeBinding(env.claudeId);
    assert.equal(afterAckBinding.deliveryState, "idle");
    assert.equal(afterAckBinding.lastAcknowledgedWakeId, wakeId);

    // Now late report arrives with 'accepted'
    const lateReport = await client.reportWakeResult({
      wakeId,
      generation: 1,
      sessionId: env.interactiveSessionId,
      bindingId: env.interactiveBindingId,
      result: "accepted",
    }, { credential: grant.credential });

    // Late report must NOT resurrect the wake back to accepted_awaiting_ack or change idle state
    const finalBinding = await env.journal.getWakeBinding(env.claudeId);
    assert.equal(finalBinding.deliveryState, "idle");
    assert.equal(finalBinding.activeWakeId, null);

    await client.close();
  } finally {
    await env.cleanup();
  }
});

test("Rebind fencing and stale_held rejection: stale generation reports and acks fail closed", async () => {
  const env = setupWakeTestEnv();
  try {
    await env.server.start();
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });

    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: "msg-" + crypto.randomUUID(),
      requestId: "req-" + crypto.randomUUID(),
      text: "rebind fence test",
    });

    const client = createLocalControlClient({ socketPath: env.socketPath, senderId: env.claudeId });
    const grantGen1 = await client.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    const wakeId = crypto.randomUUID();
    await client.reserveWakeNotification({ reservationId: wakeId }, { credential: grantGen1.credential });

    // Rebind to generation 2 while wake was in-flight -> moves state to stale_held
    const newBindingId = crypto.randomUUID();
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 2,
      bindingId: newBindingId,
    });

    const reboundBinding = await env.journal.getWakeBinding(env.claudeId);
    assert.equal(reboundBinding.generation, 2);
    assert.equal(reboundBinding.deliveryState, "stale_held");

    // Stale generation ack fails closed
    await assert.rejects(
      async () => client.ackWake({ wakeId, generation: 1 }, { credential: grantGen1.credential }),
      (err) => err?.code === "generation_fenced" || err?.code === "stale_wake_generation" || err?.code === "stale_wake_rebound"
    );

    // Stale generation report fails closed
    await assert.rejects(
      async () => client.reportWakeResult({
        wakeId,
        generation: 1,
        sessionId: env.interactiveSessionId,
        bindingId: env.interactiveBindingId,
        result: "accepted",
      }, { credential: grantGen1.credential }),
      (err) => err?.code === "generation_fenced" || err?.code === "stale_wake_generation" || err?.code === "stale_wake_rebound"
    );

    await client.close();
  } finally {
    await env.cleanup();
  }
});

test("Real journal+control socket end-to-end: inbound message -> wake reserve -> mock socket delivery -> inbox claim/reply -> peer receives response", async () => {
  const env = setupWakeTestEnv();
  try {
    await env.server.start();
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });

    const clientCodex = createLocalControlClient({ socketPath: env.socketPath, senderId: env.codexId });
    const codexGrant = env.issuer.issue({
      senderId: env.codexId,
      turnId: crypto.randomUUID(),
      allowedRecipients: [env.claudeId],
    });
    clientCodex.activeTurnCredential = codexGrant;

    const clientClaude = createLocalControlClient({ socketPath: env.socketPath, senderId: env.claudeId });

    // 1. Inbound message from Codex to Claude
    const msgId = "msg-" + crypto.randomUUID();
    const reqId = "req-" + crypto.randomUUID();
    const sendResult = await clientCodex.sendMessage({
      to: env.claudeId,
      text: "hello claude peer",
      messageId: msgId,
      requestId: reqId,
    }, { credential: codexGrant });
    assert.equal(sendResult.status, "queued_local");

    // 2. Interactive credential exchange
    const claudeGrant = await clientClaude.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });
    assert.equal(claudeGrant.senderId, env.claudeId);
    assert.equal(claudeGrant.sessionId, env.interactiveSessionId);

    // 3. Reserve wake notification
    const reservationId = crypto.randomUUID();
    const reserveRes = await clientClaude.reserveWakeNotification({ reservationId }, { credential: claudeGrant.credential });
    assert.equal(reserveRes.deliveryAllowed, true);
    assert.equal(reserveRes.reserved, true);
    assert.equal(reserveRes.wakeId, reservationId);
    assert.equal(reserveRes.snapshot.replyCount, 0);
    assert.equal(reserveRes.snapshot.inboxCount, 1);

    // 4. Mock socket delivery (simulate delivery primitive write_accepted)
    // 5. Report wake result
    const reportRes = await clientClaude.reportWakeResult({
      wakeId: reservationId,
      generation: 1,
      sessionId: env.interactiveSessionId,
      bindingId: env.interactiveBindingId,
      result: "accepted",
    }, { credential: claudeGrant.credential });
    assert.equal(reportRes.success, true);
    assert.equal(reportRes.state, "accepted_awaiting_ack");

    // 6. Claude lists inbox
    const inbox = await clientClaude.listInbox({}, { credential: claudeGrant.credential });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].messageId, msgId);
    assert.equal(inbox[0].text, "hello claude peer");

    // 7. Claude claims message
    const claimRes = await clientClaude.claimInboxMessage({
      messageId: msgId,
      claimId: "claim-" + crypto.randomUUID(),
    }, { credential: claudeGrant.credential });
    assert.equal(claimRes.messageId, msgId);
    assert.equal(typeof claimRes.claimToken, "string");

    // 8. Claude replies to message
    const replyRes = await clientClaude.sendReply({
      messageId: msgId,
      claimToken: claimRes.claimToken,
      text: "hello codex, I processed your task",
    }, { credential: claudeGrant.credential });
    assert.equal(replyRes.isDuplicate, false);
    assert.equal(typeof replyRes.messageId, "string");

    // 9. Claude acks wake notification
    const ackRes = await clientClaude.ackWake({
      wakeId: reservationId,
      generation: 1,
    }, { credential: claudeGrant.credential });
    assert.equal(ackRes.acknowledged, true);

    const b = await env.journal.getWakeBinding(env.claudeId);
    assert.equal(b.deliveryState, "idle");

    // 10. Codex receives reply
    const replies = await clientCodex.listReplies({
      requestId: reqId,
      inReplyTo: msgId,
    }, { credential: codexGrant });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].sender, env.claudeId);
    assert.equal(replies[0].text, "hello codex, I processed your task");

    await clientCodex.close();
    await clientClaude.close();
  } finally {
    await env.cleanup();
  }
});

test("Issue 5 [P2]: Wake session fencing strictly derives authority from validated claims and rejects foreign/missing/malformed session tuples", async () => {
  const env = setupWakeTestEnv();
  try {
    await env.server.start();
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });

    // 1. Direct journal reserveInteractiveWake fencing
    // Mismatched sessionId
    await assert.rejects(
      async () => env.journal.reserveInteractiveWake({
        targetIdentity: env.claudeId,
        reservationId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        generation: 1,
        bindingId: env.interactiveBindingId,
      }),
      (err) => err?.code === "session_fenced"
    );

    // Missing sessionId
    await assert.rejects(
      async () => env.journal.reserveInteractiveWake({
        targetIdentity: env.claudeId,
        reservationId: crypto.randomUUID(),
        sessionId: null,
        generation: 1,
        bindingId: env.interactiveBindingId,
      }),
      (err) => err?.code === "invalid_params"
    );

    // Invalid generation (not safe integer or < 1)
    await assert.rejects(
      async () => env.journal.reserveInteractiveWake({
        targetIdentity: env.claudeId,
        reservationId: crypto.randomUUID(),
        sessionId: env.interactiveSessionId,
        generation: -1,
        bindingId: env.interactiveBindingId,
      }),
      (err) => err?.code === "invalid_params"
    );

    // Stale generation
    await assert.rejects(
      async () => env.journal.reserveInteractiveWake({
        targetIdentity: env.claudeId,
        reservationId: crypto.randomUUID(),
        sessionId: env.interactiveSessionId,
        generation: 2,
        bindingId: env.interactiveBindingId,
      }),
      (err) => err?.code === "stale_wake_generation"
    );

    // Mismatched bindingId
    await assert.rejects(
      async () => env.journal.reserveInteractiveWake({
        targetIdentity: env.claudeId,
        reservationId: crypto.randomUUID(),
        sessionId: env.interactiveSessionId,
        generation: 1,
        bindingId: crypto.randomUUID(),
      }),
      (err) => err?.code === "binding_changed"
    );

    // 2. Direct journal reportInteractiveWakeResult fencing
    await assert.rejects(
      async () => env.journal.reportInteractiveWakeResult({
        targetIdentity: env.claudeId,
        wakeId: "wake-1",
        sessionId: crypto.randomUUID(),
        generation: 1,
        bindingId: env.interactiveBindingId,
        result: "accepted",
      }),
      (err) => err?.code === "session_fenced"
    );

    // 3. Direct journal ackInteractiveWake fencing
    await assert.rejects(
      async () => env.journal.ackInteractiveWake({
        targetIdentity: env.claudeId,
        wakeId: "wake-1",
        sessionId: crypto.randomUUID(),
        generation: 1,
        bindingId: env.interactiveBindingId,
      }),
      (err) => err?.code === "session_fenced"
    );

    // 4. Real RPC report_wake_result parameter override prevention
    const client = createLocalControlClient({ socketPath: env.socketPath, senderId: env.claudeId });
    const grant = await client.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    // Caller attempts to override generation to 99 in params
    await assert.rejects(
      async () => client.reportWakeResult({
        wakeId: "wake-1",
        generation: 99,
        sessionId: env.interactiveSessionId,
        bindingId: env.interactiveBindingId,
        result: "accepted",
      }, { credential: grant.credential }),
      (err) => err?.code === "generation_fenced"
    );

    // Caller attempts to override sessionId in params
    await assert.rejects(
      async () => client.reportWakeResult({
        wakeId: "wake-1",
        generation: 1,
        sessionId: crypto.randomUUID(),
        bindingId: env.interactiveBindingId,
        result: "accepted",
      }, { credential: grant.credential }),
      (err) => err?.code === "session_fenced"
    );

    await client.close();
  } finally {
    await env.cleanup();
  }
});

test("Issue 6 [P2]: Reservation reuse after ack: used-reservation tombstones prevent duplicate delivery permit after ack and interval", async () => {
  const env = setupWakeTestEnv();
  const originalNow = Date.now;
  try {
    await env.server.start();
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });

    // Ingest obligation
    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: "msg-reuse-1",
      requestId: "req-reuse-1",
      text: "first task",
    });

    const resId = crypto.randomUUID();
    const reserve1 = await env.journal.reserveInteractiveWake({
      targetIdentity: env.claudeId,
      reservationId: resId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
      now: originalNow(),
    });
    assert.equal(reserve1.deliveryAllowed, true);

    // Report accepted then ack
    await env.journal.reportInteractiveWakeResult({
      targetIdentity: env.claudeId,
      wakeId: resId,
      generation: 1,
      sessionId: env.interactiveSessionId,
      bindingId: env.interactiveBindingId,
      result: "accepted",
      now: originalNow() + 1000,
    });
    await env.journal.ackInteractiveWake({
      targetIdentity: env.claudeId,
      wakeId: resId,
      generation: 1,
      sessionId: env.interactiveSessionId,
      bindingId: env.interactiveBindingId,
      now: originalNow() + 2000,
    });

    // Ingest another obligation
    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: "msg-reuse-2",
      requestId: "req-reuse-2",
      text: "second task",
    });

    // Retry with SAME reservationId at +16s must NOT obtain deliveryAllowed: true
    const retrySame = await env.journal.reserveInteractiveWake({
      targetIdentity: env.claudeId,
      reservationId: resId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
      now: originalNow() + 16000,
    });
    assert.equal(retrySame.deliveryAllowed, false, "Must never obtain second delivery permit for same wakeId");
    assert.equal(retrySame.isDuplicate, true);

    // Brand new reservation ID succeeds
    const newResId = crypto.randomUUID();
    const reserveNew = await env.journal.reserveInteractiveWake({
      targetIdentity: env.claudeId,
      reservationId: newResId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
      now: originalNow() + 16000,
    });
    assert.equal(reserveNew.deliveryAllowed, true, "New reservationId must win delivery permit");

    // Stale ack for resId must NOT clear or disrupt the new active wake!
    const staleAck = await env.journal.ackInteractiveWake({
      targetIdentity: env.claudeId,
      wakeId: resId,
      generation: 1,
      sessionId: env.interactiveSessionId,
      bindingId: env.interactiveBindingId,
      now: originalNow() + 17000,
    });
    assert.equal(staleAck.duplicate, true);

    const bindingAfterStaleAck = await env.journal.getWakeBinding(env.claudeId);
    assert.equal(bindingAfterStaleAck.activeWakeId, newResId, "Stale ack must not clear new active wake");
  } finally {
    Date.now = originalNow;
    await env.cleanup();
  }
});

test("Issue 7 [P2]: Transaction held across await: concurrent direct reservations and batched frames succeed without ERR_SQLITE_ERROR", async () => {
  const env = setupWakeTestEnv();
  try {
    await env.server.start();
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });

    // Ingest obligation
    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: "msg-race-direct",
      requestId: "req-race-direct",
      text: "task",
    });

    // Direct concurrent calls on same journal instance
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    const results = await Promise.allSettled([
      env.journal.reserveInteractiveWake({
        targetIdentity: env.claudeId,
        reservationId: id1,
        sessionId: env.interactiveSessionId,
        generation: 1,
        bindingId: env.interactiveBindingId,
      }),
      env.journal.reserveInteractiveWake({
        targetIdentity: env.claudeId,
        reservationId: id2,
        sessionId: env.interactiveSessionId,
        generation: 1,
        bindingId: env.interactiveBindingId,
      }),
    ]);

    // Neither call should reject with ERR_SQLITE_ERROR!
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 0, `Concurrent reservations threw error: ${rejected.map(r => r.reason?.code || r.reason?.message).join(", ")}`);

    const fulfilled = results.map((r) => r.value);
    const permits = fulfilled.filter((r) => r.deliveryAllowed === true);
    assert.equal(permits.length, 1, "Exactly one call must receive deliveryAllowed: true");
  } finally {
    await env.cleanup();
  }
});
