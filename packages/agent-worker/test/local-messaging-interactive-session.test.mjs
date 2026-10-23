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
import { writePrivateJson, readPrivateJson } from "../src/local-messaging-auth-broker.mjs";
import { createInteractiveSessionBroker, validateInteractiveIntegration } from "../src/local-messaging-interactive-session.mjs";
import { setupInteractiveSession, activateInteractiveSession, revokeInteractiveSession, setupLocalMessaging } from "../src/local-messaging-cli.mjs";
import { createInstalledLocalMessagingHost } from "../src/local-messaging-host.mjs";
import { createProfiledReasonerGate } from "../src/concurrency-gate.mjs";
import { resolveLocalSocketAddress } from "../src/local-messaging-address.mjs";

function setupTestEnv() {
  const baseTmp = fs.existsSync("/private/tmp") ? "/private/tmp" : (fs.existsSync("/tmp") ? "/tmp" : os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(baseTmp, "tri-is-"));
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

  const interactiveIntegrationPath = path.join(stateRoot, "claude-integration.json");
  const interactiveSecret = crypto.randomBytes(32).toString("hex");
  const interactiveSessionId = crypto.randomUUID();
  const interactiveBindingId = crypto.randomUUID();

  writePrivateJson(interactiveIntegrationPath, {
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
    integrationPath: interactiveIntegrationPath,
    recipients: [codexId, runnerId],
    issue: (sender, opts) => issuer.issue({ senderId: sender, ...opts }),
  });

  const dispatcherJobs = [];
  const dispatcher = {
    start: async () => {},
    stop: async () => {},
    notifyAdmission: async (job) => {
      dispatcherJobs.push(job);
    },
  };

  const statusProvider = async () => ({
    route: "same-device",
    ownerStatus: "global-owner-state",
    allAgentCounts: 42,
  });

  const server = createLocalControlServer({
    socketPath,
    journal,
    acl,
    credentialValidator: validator,
    interactiveBroker,
    interactiveRecipients: new Set([claudeId]),
    statusProvider,
    dispatcher,
    rateLimiter: createPerSenderRateLimiter({ maxRequestsPerWindow: 50, windowMs: 60000 }),
    loopTracker: createConversationLoopTracker({ journal }),
  });

  return {
    tmpDir,
    stateRoot,
    socketPath,
    secret,
    issuer,
    validator,
    codexId,
    claudeId,
    runnerId,
    interactiveIntegrationPath,
    interactiveSecret,
    interactiveSessionId,
    interactiveBindingId,
    interactiveBroker,
    journal,
    dispatcher,
    dispatcherJobs,
    server,
  };
}

test("distinct identity and wrong session/secret exchange rejects unauthorized access", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const client = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });

    // 1. Wrong secret fails
    await assert.rejects(
      client.exchangeInteractiveSession({
        bindingId: env.interactiveBindingId,
        sessionId: env.interactiveSessionId,
        generation: 1,
        secret: "wrong-secret-" + "0".repeat(64),
      }),
      (err) => err.code === "unauthorized"
    );

    // 2. Wrong sessionId fails
    await assert.rejects(
      client.exchangeInteractiveSession({
        bindingId: env.interactiveBindingId,
        sessionId: crypto.randomUUID(),
        generation: 1,
        secret: env.interactiveSecret,
      }),
      (err) => err.code === "unauthorized"
    );

    // 3. Wrong bindingId fails
    await assert.rejects(
      client.exchangeInteractiveSession({
        bindingId: crypto.randomUUID(),
        sessionId: env.interactiveSessionId,
        generation: 1,
        secret: env.interactiveSecret,
      }),
      (err) => err.code === "unauthorized"
    );

    // 4. Correct credentials succeed and return session-scoped grant
    const grant = await client.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    assert.ok(grant.credential);
    assert.strictEqual(grant.senderId, env.claudeId);
    assert.strictEqual(grant.sessionId, env.interactiveSessionId);
    assert.strictEqual(grant.generation, 1);

    await client.close();
  } finally {
    await env.server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("scope isolation: local_status for interactive recipient hides global owner state", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const claudeClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    await claudeClient.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    const claudeStatus = await claudeClient.localStatus();
    assert.strictEqual(claudeStatus.route, "same-device");
    assert.strictEqual(claudeStatus.senderId, env.claudeId);
    assert.strictEqual(claudeStatus.sessionId, env.interactiveSessionId);
    assert.strictEqual(claudeStatus.generation, 1);
    assert.ok(claudeStatus.inbox);
    // Must NOT contain global owner counts or IDs
    assert.strictEqual(claudeStatus.ownerStatus, undefined);
    assert.strictEqual(claudeStatus.allAgentCounts, undefined);

    // Codex owner client gets global status
    const codexCred = env.issuer.issue({ senderId: env.codexId });
    const codexClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.codexId,
      turnCredential: codexCred,
    });

    const codexStatus = await codexClient.localStatus();
    assert.strictEqual(codexStatus.ownerStatus, "global-owner-state");
    assert.strictEqual(codexStatus.allAgentCounts, 42);

    await claudeClient.close();
    await codexClient.close();
  } finally {
    await env.server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("expiry AND revoked issued grant enforced on EVERY authenticated request", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const client = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    await client.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    // Valid call succeeds
    const inbox = await client.listInbox();
    assert.deepStrictEqual(inbox, []);

    // Now revoke in the integration file
    writePrivateJson(env.interactiveIntegrationPath, {
      version: 1,
      type: "interactive",
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
      secret: env.interactiveSecret,
      enabled: true,
      revoked: true,
    });

    // Next request MUST fail immediately even though JWT has not expired!
    await assert.rejects(
      client.listInbox(),
      (err) => err.code === "session_revoked"
    );

    await client.close();
  } finally {
    await env.server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("runner recovery excludes interactive rows and claimExecution excludes them", async () => {
  const env = setupTestEnv();

  const interactiveMsg = await env.journal.recordSend({
    sender: env.codexId,
    recipient: env.claudeId,
    recipientType: "interactive",
    messageId: "msg-interactive-1",
    requestId: "req-1",
    text: "hello claude",
  });
  assert.strictEqual(interactiveMsg.recipientType, "interactive");

  const runnerMsg = await env.journal.recordSend({
    sender: env.codexId,
    recipient: env.runnerId,
    recipientType: "runner",
    messageId: "msg-runner-1",
    requestId: "req-2",
    text: "hello runner",
  });
  assert.strictEqual(runnerMsg.recipientType, "runner");

  const recovered = await env.journal.recoverQueued();
  const recoveredIds = recovered.toRun.map((m) => m.messageId);
  assert.ok(recoveredIds.includes("msg-runner-1"));
  assert.ok(!recoveredIds.includes("msg-interactive-1"));

  const runnerClaim = await env.journal.claimExecution("msg-interactive-1");
  assert.strictEqual(runnerClaim, null);

  const validRunnerClaim = await env.journal.claimExecution("msg-runner-1");
  assert.ok(validRunnerClaim);
  assert.strictEqual(validRunnerClaim.messageId, "msg-runner-1");

  await env.journal.close();
  fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

test("foreign/parallel claims and exact retry stable", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const codexCred = env.issuer.issue({ senderId: env.codexId });
    const codexClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.codexId,
      turnCredential: codexCred,
    });
    const admission = await codexClient.sendMessage({
      to: env.claudeId,
      text: "task for claude",
      messageId: "msg-claim-1",
      requestId: "req-claim-1",
    });
    assert.strictEqual(admission.accepted, true);

    const runnerCred = env.issuer.issue({ senderId: env.runnerId });
    const runnerClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.runnerId,
      turnCredential: runnerCred,
    });
    await assert.rejects(
      runnerClient.claimInboxMessage({ messageId: "msg-claim-1", claimId: "op-claim-runner" }),
      (err) => err.code === "foreign_access_denied"
    );

    const status = await codexClient.getMessageStatus({ messageId: "msg-claim-1" });
    assert.strictEqual(status.phase, "queued_local");
    await assert.rejects(
      codexClient.claimInboxMessage({ messageId: "msg-claim-1", claimId: "op-claim-codex" }),
      (err) => err.code === "foreign_access_denied"
    );

    const claudeClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    await claudeClient.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    const inbox = await claudeClient.listInbox();
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].messageId, "msg-claim-1");

    const claim1 = await claudeClient.claimInboxMessage({ messageId: "msg-claim-1", claimId: "op-claim-claude" });
    assert.ok(claim1.claimToken);
    assert.strictEqual(typeof claim1.claimToken, "string");
    assert.ok(claim1.claimToken.length >= 32);
    assert.ok(claim1.leaseExpiresAt > Date.now());
    assert.strictEqual(claim1.isRetry, false);

    const claimRetry = await claudeClient.claimInboxMessage({ messageId: "msg-claim-1", claimId: "op-claim-claude" });
    assert.strictEqual(claimRetry.claimToken, claim1.claimToken);
    assert.strictEqual(claimRetry.isRetry, true);

    const otherSessionId = crypto.randomUUID();
    const otherSessionCred = env.issuer.issue({
      senderId: env.claudeId,
      sessionId: otherSessionId,
      generation: 1,
      senderType: "interactive",
    });
    const parallelClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
      turnCredential: otherSessionCred,
    });
    await assert.rejects(
      parallelClient.claimInboxMessage({ messageId: "msg-claim-1", claimId: "op-claim-parallel" }),
      (err) => err.code === "session_fenced" || err.code === "claim_failed"
    );

    await codexClient.close();
    await runnerClient.close();
    await claudeClient.close();
    await parallelClient.close();
  } finally {
    await env.server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("claim-generation replay / fencing across session reopen", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const codexCred = env.issuer.issue({ senderId: env.codexId });
    const codexClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.codexId,
      turnCredential: codexCred,
    });
    await codexClient.sendMessage({
      to: env.claudeId,
      text: "task for claude gen 1",
      messageId: "msg-gen-1",
      requestId: "req-gen-1",
    });

    const claudeClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    await claudeClient.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    const claim = await claudeClient.claimInboxMessage({ messageId: "msg-gen-1", claimId: "op-claim-gen" });
    assert.ok(claim.claimToken);

    // Reopen session with generation 2
    writePrivateJson(env.interactiveIntegrationPath, {
      version: 1,
      type: "interactive",
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 2,
      bindingId: env.interactiveBindingId,
      secret: env.interactiveSecret,
      enabled: true,
      revoked: false,
    });

    await assert.rejects(
      claudeClient.sendReply({
        messageId: "msg-gen-1",
        claimToken: claim.claimToken,
        text: "gen 1 reply",
      }),
      (err) => err.code === "generation_fenced"
    );

    await codexClient.close();
    await claudeClient.close();
  } finally {
    await env.server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("duplicate and conflicting reply with monotonic loop depth and no pair budget cost", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const codexCred = env.issuer.issue({ senderId: env.codexId, loopDepth: 3 });
    const codexClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.codexId,
      turnCredential: codexCred,
    });
    await codexClient.sendMessage({
      to: env.claudeId,
      text: "ping message",
      messageId: "msg-reply-1",
      requestId: "req-reply-1",
      metadata: { _loopDepth: 3 },
    });

    const claudeClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    await claudeClient.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    const claim = await claudeClient.claimInboxMessage({ messageId: "msg-reply-1", claimId: "op-claim-reply" });

    const reply1 = await claudeClient.sendReply({
      messageId: "msg-reply-1",
      claimToken: claim.claimToken,
      text: "pong reply",
      replyId: "rep-pong-1",
    });
    assert.strictEqual(reply1.isDuplicate, false);
    assert.strictEqual(reply1.text, "pong reply");
    assert.strictEqual(reply1.loopDepth, 4);

    const replyDup = await claudeClient.sendReply({
      messageId: "msg-reply-1",
      claimToken: claim.claimToken,
      text: "pong reply",
      replyId: "rep-pong-1",
    });
    assert.strictEqual(replyDup.isDuplicate, true);

    await assert.rejects(
      claudeClient.sendReply({
        messageId: "msg-reply-1",
        claimToken: claim.claimToken,
        text: "conflicting text",
        replyId: "rep-pong-1",
      }),
      (err) => err.code === "duplicate_id_conflict"
    );

    const replies = await codexClient.listReplies({ requestId: "req-reply-1" });
    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].text, "pong reply");
    assert.strictEqual(replies[0].loopDepth, 4);

    await codexClient.close();
    await claudeClient.close();
  } finally {
    await env.server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("crash / lease expiry + late evidence", async () => {
  let virtualTime = 1000000;
  const now = () => virtualTime;

  const env = setupTestEnv();

  await env.journal.recordSend({
    sender: env.codexId,
    recipient: env.claudeId,
    recipientType: "interactive",
    messageId: "msg-lease-1",
    requestId: "req-lease-1",
    text: "time bounded task",
  });

  const claim = await env.journal.claimInboxMessage({
    messageId: "msg-lease-1",
    requester: env.claudeId,
    sessionId: env.interactiveSessionId,
    generation: 1,
    claimId: "op-claim-lease",
    leaseDurationMs: 1000,
    now,
  });
  assert.ok(claim.claimToken);

  virtualTime += 2000;

  await assert.rejects(
    env.journal.recordInteractiveReply({
      messageId: "msg-lease-1",
      claimToken: claim.claimToken,
      sessionId: env.interactiveSessionId,
      generation: 1,
      requester: env.claudeId,
      text: "late answer from claude",
      now,
    }),
    (err) => err.code === "lease_expired" || err.code === "reply_not_accepted"
  );

  const record = await env.journal.getRecord("msg-lease-1");
  assert.strictEqual(record.phase, "held");
  assert.strictEqual(record.reason, "lease_expired");
  assert.strictEqual(record.hasLateResult, true);

  const lateResult = await env.journal.getLateResult("msg-lease-1");
  assert.strictEqual(lateResult.text, "late answer from claude");

  const replies = await env.journal.listReplies({ requester: env.codexId });
  assert.strictEqual(replies.length, 0);

  await env.journal.recordSend({
    sender: env.codexId,
    recipient: env.claudeId,
    recipientType: "interactive",
    messageId: "msg-crash-1",
    requestId: "req-crash-1",
    text: "will crash",
  });
  await env.journal.claimInboxMessage({
    messageId: "msg-crash-1",
    requester: env.claudeId,
    sessionId: env.interactiveSessionId,
    generation: 1,
    claimId: "op-claim-crash",
    leaseDurationMs: 60000,
    now,
  });
  await env.journal.close();

  const reopenedJournal = createLocalMessagingJournal({ stateRoot: env.stateRoot });
  const crashRecord = await reopenedJournal.getRecord("msg-crash-1");
  assert.strictEqual(crashRecord.phase, "held");
  assert.strictEqual(crashRecord.reason, "crash_recovery");

  await reopenedJournal.close();
  fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

test("setupInteractiveSession CLI owner setup function", () => {
  const baseTmp = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(baseTmp, "tri-cli-setup-"));
  fs.chmodSync(tmpDir, 0o700);

  try {
    const configPath = path.join(tmpDir, "local-messaging.json");
    const integrationPath = path.join(tmpDir, "claude-integration.json");

    const result = setupInteractiveSession({
      configPath,
      integrationPath,
      recipients: ["gravity2"],
    });

    assert.ok(result.senderId);
    assert.ok(/^[a-f0-9]{64}$/.test(result.senderId));
    assert.ok(result.sessionId);
    assert.strictEqual(result.generation, 1);
    assert.ok(result.bindingId);
    assert.ok(fs.existsSync(integrationPath));

    const content = JSON.parse(fs.readFileSync(integrationPath, "utf8"));
    assert.strictEqual(content.version, 1);
    assert.strictEqual(content.type, "interactive");
    assert.strictEqual(content.senderId, result.senderId);
    assert.strictEqual(content.secret.length, 64);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("transaction atomicity injected failure rolls back completely", async () => {
  const env = setupTestEnv();

  await env.journal.recordSend({
    sender: env.codexId,
    recipient: env.claudeId,
    recipientType: "interactive",
    messageId: "msg-atomic-1",
    requestId: "req-atomic-1",
    text: "atomic test message",
  });

  const claim = await env.journal.claimInboxMessage({
    messageId: "msg-atomic-1",
    requester: env.claudeId,
    sessionId: env.interactiveSessionId,
    generation: 1,
    claimId: "op-claim-atomic",
  });
  assert.ok(claim.claimToken);

  await assert.rejects(
    env.journal.recordInteractiveReply({
      messageId: "msg-atomic-1",
      claimToken: "wrong-claim-token",
      sessionId: env.interactiveSessionId,
      generation: 1,
      requester: env.claudeId,
      text: "should not be committed",
    }),
    (err) => err.code === "invalid_claim_token"
  );

  const msgState = await env.journal.getRecord("msg-atomic-1");
  assert.strictEqual(msgState.phase, "executing");
  assert.strictEqual(msgState.claimSessionId, env.interactiveSessionId);
  assert.strictEqual(msgState.claimGeneration, 1);

  const replies = await env.journal.listReplies({ requester: env.codexId, requestId: "req-atomic-1" });
  assert.strictEqual(replies.length, 0);

  await env.journal.close();
  fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

test("frame bounds and durable retry at full cap unaffected", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const claudeClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    await claudeClient.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    const hugeText = "x".repeat(128 * 1024 + 1);
    await assert.rejects(
      claudeClient.sendMessage({
        to: env.codexId,
        text: hugeText,
        messageId: "msg-oversized-1",
      }),
      (err) => err.code === "payload_too_large"
    );

    for (let i = 0; i < 10; i++) {
      const res = await claudeClient.sendMessage({
        to: env.codexId,
        text: `ping ${i}`,
        messageId: `msg-cap-${i}`,
        requestId: `req-cap-${i}`,
      });
      assert.strictEqual(res.accepted, true);
      assert.strictEqual(res.isDuplicate, false);
    }

    await assert.rejects(
      claudeClient.sendMessage({
        to: env.codexId,
        text: "ping 11 exceeding cap",
        messageId: "msg-cap-11",
        requestId: "req-cap-11",
      }),
      (err) => err.code === "exchange_limit_exceeded"
    );

    const retryRes = await claudeClient.sendMessage({
      to: env.codexId,
      text: "ping 0",
      messageId: "msg-cap-0",
      requestId: "req-cap-0",
    });
    assert.strictEqual(retryRes.accepted, true);
    assert.strictEqual(retryRes.isDuplicate, true);

    await claudeClient.close();
  } finally {
    await env.server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("Item A: Reply claim fencing - exact tuple validation, completed duplicates, and held late evidence", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const codexCred = env.issuer.issue({ senderId: env.codexId });
    const codexClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.codexId,
      turnCredential: codexCred,
    });

    await codexClient.sendMessage({
      to: env.claudeId,
      text: "task A 1",
      messageId: "msg-a-1",
      requestId: "req-a-1",
    });

    await assert.rejects(
      env.journal.recordInteractiveReply({
        messageId: "msg-a-1",
        claimToken: "wrong-token-abc",
        sessionId: env.interactiveSessionId,
        generation: 1,
        requester: env.claudeId,
        text: "forged late text",
      }),
      (err) => err.code === "claim_failed"
    );

    const unclaimedRow = await env.journal.getRecord("msg-a-1");
    assert.strictEqual(unclaimedRow.phase, "queued_local");
    assert.strictEqual(unclaimedRow.hasLateResult, false);

    const claim1 = await env.journal.claimInboxMessage({
      messageId: "msg-a-1",
      requester: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      claimId: "op-claim-a-1",
    });
    assert.ok(claim1.claimToken);

    const validReply = await env.journal.recordInteractiveReply({
      messageId: "msg-a-1",
      claimToken: claim1.claimToken,
      sessionId: env.interactiveSessionId,
      generation: 1,
      requester: env.claudeId,
      text: "valid completion text",
      replyId: "rep-a-1",
    });
    assert.strictEqual(validReply.isDuplicate, false);
    assert.strictEqual(validReply.messageId, "rep-a-1");

    await assert.rejects(
      env.journal.recordInteractiveReply({
        messageId: "msg-a-1",
        claimToken: "wrong-claim-token",
        sessionId: env.interactiveSessionId,
        generation: 1,
        requester: env.claudeId,
        text: "valid completion text",
        replyId: "rep-a-1",
      }),
      (err) => err.code === "invalid_claim_token"
    );

    await assert.rejects(
      env.journal.recordInteractiveReply({
        messageId: "msg-a-1",
        claimToken: claim1.claimToken,
        sessionId: crypto.randomUUID(),
        generation: 1,
        requester: env.claudeId,
        text: "valid completion text",
        replyId: "rep-a-1",
      }),
      (err) => err.code === "session_fenced"
    );

    await assert.rejects(
      env.journal.recordInteractiveReply({
        messageId: "msg-a-1",
        claimToken: claim1.claimToken,
        sessionId: env.interactiveSessionId,
        generation: 99,
        requester: env.claudeId,
        text: "valid completion text",
        replyId: "rep-a-1",
      }),
      (err) => err.code === "generation_fenced"
    );

    await assert.rejects(
      env.journal.recordInteractiveReply({
        messageId: "msg-a-1",
        claimToken: claim1.claimToken,
        sessionId: env.interactiveSessionId,
        generation: 1,
        requester: env.claudeId,
        text: "valid completion text",
        replyId: "rep-a-different",
      }),
      (err) => err.code === "duplicate_id_conflict"
    );

    await assert.rejects(
      env.journal.recordInteractiveReply({
        messageId: "msg-a-1",
        claimToken: claim1.claimToken,
        sessionId: env.interactiveSessionId,
        generation: 1,
        requester: env.claudeId,
        text: "valid completion text",
        replyId: "rep-a-1",
        metadata: { changed: "field" },
      }),
      (err) => err.code === "duplicate_id_conflict"
    );

    const dupReply = await env.journal.recordInteractiveReply({
      messageId: "msg-a-1",
      claimToken: claim1.claimToken,
      sessionId: env.interactiveSessionId,
      generation: 1,
      requester: env.claudeId,
      text: "valid completion text",
      replyId: "rep-a-1",
    });
    assert.strictEqual(dupReply.isDuplicate, true);
    assert.strictEqual(dupReply.messageId, "rep-a-1");

    await codexClient.sendMessage({
      to: env.claudeId,
      text: "task A 2 for lease expiry",
      messageId: "msg-a-2",
      requestId: "req-a-2",
    });

    let vTime = 100000;
    const now = () => vTime;

    const claim2 = await env.journal.claimInboxMessage({
      messageId: "msg-a-2",
      requester: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      claimId: "op-claim-a-2",
      leaseDurationMs: 1000,
      now,
    });
    assert.ok(claim2.claimToken);

    vTime += 2000;

    await assert.rejects(
      env.journal.recordInteractiveReply({
        messageId: "msg-a-2",
        claimToken: "bad-token-xyz",
        sessionId: env.interactiveSessionId,
        generation: 1,
        requester: env.claudeId,
        text: "unauthorized late result",
        now,
      }),
      (err) => err.code === "invalid_claim_token"
    );
    const checkAfterBadToken = await env.journal.getRecord("msg-a-2");
    assert.strictEqual(checkAfterBadToken.hasLateResult, false);

    await assert.rejects(
      env.journal.recordInteractiveReply({
        messageId: "msg-a-2",
        claimToken: claim2.claimToken,
        sessionId: crypto.randomUUID(),
        generation: 1,
        requester: env.claudeId,
        text: "unauthorized late result",
        now,
      }),
      (err) => err.code === "session_fenced"
    );
    const checkAfterBadSession = await env.journal.getRecord("msg-a-2");
    assert.strictEqual(checkAfterBadSession.hasLateResult, false);

    await assert.rejects(
      env.journal.recordInteractiveReply({
        messageId: "msg-a-2",
        claimToken: claim2.claimToken,
        sessionId: env.interactiveSessionId,
        generation: 1,
        requester: env.claudeId,
        text: "valid late held result",
        now,
      }),
      (err) => err.code === "lease_expired" || err.code === "reply_not_accepted"
    );
    const checkAfterValid = await env.journal.getRecord("msg-a-2");
    assert.strictEqual(checkAfterValid.phase, "held");
    assert.strictEqual(checkAfterValid.hasLateResult, true);
    const late = await env.journal.getLateResult("msg-a-2");
    assert.strictEqual(late.text, "valid late held result");

    await codexClient.close();
  } finally {
    await env.server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("Item B: setupInteractiveSession - default disabled, no resurrection, option validation, identity collision", () => {
  const baseTmp = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(baseTmp, "tri-b-"));
  fs.chmodSync(tmpDir, 0o700);

  try {
    const configPath = path.join(tmpDir, "local.json");
    const integrationPath = path.join(tmpDir, "claude-integration.json");

    const setup1 = setupInteractiveSession({
      configPath,
      integrationPath,
    });
    assert.strictEqual(setup1.enabled, false);
    assert.strictEqual(setup1.revoked, false);
    const file1 = readPrivateJson(integrationPath);
    assert.strictEqual(file1.enabled, false);
    assert.strictEqual(file1.revoked, false);

    const setupRetry = setupInteractiveSession({
      configPath,
      integrationPath,
    });
    assert.strictEqual(setupRetry.enabled, false);
    assert.strictEqual(setupRetry.revoked, false);
    assert.strictEqual(setupRetry.secret, setup1.secret);

    assert.throws(
      () => setupInteractiveSession({ configPath, integrationPath, enabled: true }),
      (err) => err.code === "unsupported_operation"
    );

    writePrivateJson(integrationPath, { ...file1, revoked: true });
    assert.throws(
      () => setupInteractiveSession({ configPath, integrationPath, revoked: false }),
      (err) => err.code === "unsupported_operation"
    );
    const setupPreserveRevoke = setupInteractiveSession({ configPath, integrationPath });
    assert.strictEqual(setupPreserveRevoke.revoked, true);

    const activated = activateInteractiveSession({ integrationPath });
    assert.strictEqual(activated.enabled, true);
    assert.strictEqual(activated.revoked, false);
    assert.strictEqual(activated.generation, 2);
    assert.notStrictEqual(activated.secret, setup1.secret);

    // Regressions for Blocker 1:
    // Requested disable against an active session throws and does not report success or alter state
    assert.throws(
      () => setupInteractiveSession({ configPath, integrationPath, enabled: false }),
      (err) => err.code === "unsupported_operation"
    );
    const afterDisableAttempt = readPrivateJson(integrationPath);
    assert.strictEqual(afterDisableAttempt.enabled, true);
    assert.strictEqual(afterDisableAttempt.revoked, false);

    // Requested revoke against an unrevoked session throws and does not report success or alter state
    assert.throws(
      () => setupInteractiveSession({ configPath, integrationPath, revoked: true }),
      (err) => err.code === "unsupported_operation"
    );
    const afterRevokeAttempt = readPrivateJson(integrationPath);
    assert.strictEqual(afterRevokeAttempt.enabled, true);
    assert.strictEqual(afterRevokeAttempt.revoked, false);

    // Exact setup retry preserves existing active state
    const activeRetry = setupInteractiveSession({ configPath, integrationPath });
    assert.strictEqual(activeRetry.enabled, true);
    assert.strictEqual(activeRetry.revoked, false);

    // Identical flags explicitly supplied succeed
    const activeRetryIdentical = setupInteractiveSession({
      configPath,
      integrationPath,
      enabled: true,
      revoked: false,
    });
    assert.strictEqual(activeRetryIdentical.enabled, true);
    assert.strictEqual(activeRetryIdentical.revoked, false);

    // Explicit revoke operation transitions state
    const revokedRecord = revokeInteractiveSession({ integrationPath });
    assert.strictEqual(revokedRecord.revoked, true);
    assert.strictEqual(revokedRecord.enabled, false);

    const fileRevoked = readPrivateJson(integrationPath);
    assert.strictEqual(fileRevoked.revoked, true);
    assert.strictEqual(fileRevoked.enabled, false);

    // Re-enable / un-revoke via setup rejected on revoked record (no resurrection)
    assert.throws(
      () => setupInteractiveSession({ configPath, integrationPath, revoked: false }),
      (err) => err.code === "unsupported_operation"
    );
    assert.throws(
      () => setupInteractiveSession({ configPath, integrationPath, enabled: true }),
      (err) => err.code === "unsupported_operation"
    );

    // Re-activate via activateInteractiveSession for subsequent tests
    activateInteractiveSession({ integrationPath });

    assert.throws(() => setupInteractiveSession({ configPath, unknownKey: "bad" }), { code: "invalid_options" });
    assert.throws(() => setupInteractiveSession({ configPath, senderId: "not-64-hex" }), { code: "invalid_options" });
    assert.throws(() => setupInteractiveSession({ configPath, secret: "short" }), { code: "invalid_options" });
    assert.throws(() => setupInteractiveSession({ configPath, sessionId: "not-uuid" }), { code: "invalid_options" });
    assert.throws(() => setupInteractiveSession({ configPath, bindingId: "not-uuid" }), { code: "invalid_options" });
    assert.throws(() => setupInteractiveSession({ configPath, generation: 0 }), { code: "invalid_options" });
    assert.throws(() => setupInteractiveSession({ configPath, generation: -1 }), { code: "invalid_options" });
    assert.throws(() => setupInteractiveSession({ configPath, enabled: "not-bool" }), { code: "invalid_options" });
    assert.throws(() => setupInteractiveSession({ configPath, revoked: "not-bool" }), { code: "invalid_options" });

    const bindingPath = path.join(tmpDir, "binding.json");
    const codexId = "c".repeat(64);
    const runnerId = "b".repeat(64);
    const codexSecret = "a".repeat(64);
    writePrivateJson(bindingPath, { instanceId: codexId, threadId: "t-1", enabled: false });
    const localConfigPath = path.join(tmpDir, "local-coll.json");
    writePrivateJson(localConfigPath, {
      version: 1,
      enabled: true,
      stateRoot: path.join(tmpDir, "state-coll"),
      bindingPath,
      integrationPath: path.join(tmpDir, "codex-integ.json"),
      recipients: [{ profile: "gravity2", instanceId: runnerId }],
      interactive: { enabled: true, integrationPath },
    });
    writePrivateJson(path.join(tmpDir, "codex-integ.json"), {
      version: 1,
      senderId: codexId,
      threadId: "t-1",
      secret: codexSecret,
      bindingId: "b".repeat(32),
    });

    writePrivateJson(integrationPath, {
      ...activated,
      senderId: codexId,
    });
    assert.throws(
      () => createInstalledLocalMessagingHost({
        configPath: localConfigPath,
        runners: new Map([[runnerId, { run: async () => ({}) }]]),
        gate: createProfiledReasonerGate(),
      }),
      (err) => err.code === "identity_collision"
    );

    writePrivateJson(integrationPath, {
      ...activated,
      senderId: runnerId,
    });
    assert.throws(
      () => createInstalledLocalMessagingHost({
        configPath: localConfigPath,
        runners: new Map([[runnerId, { run: async () => ({}) }]]),
        gate: createProfiledReasonerGate(),
      }),
      (err) => err.code === "identity_collision"
    );

    writePrivateJson(localConfigPath, {
      version: 1,
      enabled: true,
      stateRoot: path.join(tmpDir, "state-coll"),
      bindingPath,
      integrationPath: path.join(tmpDir, "codex-integ.json"),
      recipients: [{ profile: "claude", instanceId: runnerId }],
      interactive: { enabled: true, integrationPath },
    });
    writePrivateJson(integrationPath, {
      ...activated,
      senderId: "f".repeat(64),
    });
    assert.throws(
      () => createInstalledLocalMessagingHost({
        configPath: localConfigPath,
        runners: new Map([[runnerId, { run: async () => ({}) }]]),
        gate: createProfiledReasonerGate(),
      }),
      (err) => err.code === "identity_collision"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Item C: Interactive broker failclosed schema, legacy rejection, post-revoke RPC cutoff, exchange rate limit", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const testFile = path.join(env.tmpDir, "test-schema.json");

    const validBase = {
      version: 1,
      type: "interactive",
      senderId: "a".repeat(64),
      sessionId: crypto.randomUUID(),
      generation: 1,
      bindingId: crypto.randomUUID(),
      secret: "b".repeat(64),
      enabled: true,
      revoked: false,
    };

    writePrivateJson(testFile, { ...validBase, extraUnknownKey: "evil" });
    assert.throws(() => validateInteractiveIntegration(testFile), { code: "invalid_interactive_integration" });

    const missingEnabled = { ...validBase };
    delete missingEnabled.enabled;
    writePrivateJson(testFile, missingEnabled);
    assert.throws(() => validateInteractiveIntegration(testFile), { code: "invalid_interactive_integration" });

    writePrivateJson(testFile, { ...validBase, enabled: "yes" });
    assert.throws(() => validateInteractiveIntegration(testFile), { code: "invalid_interactive_integration" });

    const legacyCred = env.issuer.issue({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });
    const legacyClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
      turnCredential: legacyCred,
    });
    await assert.rejects(
      legacyClient.localStatus(),
      (err) => err.code === "unauthorized"
    );
    await legacyClient.close();

    const claudeClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    await claudeClient.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    const stBefore = await claudeClient.localStatus();
    assert.strictEqual(stBefore.senderId, env.claudeId);

    writePrivateJson(env.interactiveIntegrationPath, {
      version: 1,
      type: "interactive",
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
      secret: env.interactiveSecret,
      enabled: true,
      revoked: true,
    });

    await assert.rejects(claudeClient.localStatus(), (err) => err.code === "session_revoked");
    await assert.rejects(claudeClient.listInbox(), (err) => err.code === "session_revoked");
    await assert.rejects(claudeClient.claimInboxMessage({ messageId: "msg-any", claimId: "op-claim-any" }), (err) => err.code === "session_revoked");
    await assert.rejects(claudeClient.sendReply({ messageId: "msg-any", claimToken: "tok", text: "t" }), (err) => err.code === "session_revoked");
    await assert.rejects(claudeClient.sendMessage({ to: env.runnerId, text: "t", messageId: "m1" }), (err) => err.code === "session_revoked");
    await assert.rejects(claudeClient.discoverRecipients(), (err) => err.code === "session_revoked");

    await claudeClient.close();

    writePrivateJson(env.interactiveIntegrationPath, {
      version: 1,
      type: "interactive",
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
      secret: env.interactiveSecret,
      enabled: true,
      revoked: false,
    });

    const unauthClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    const badTuple = {
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: "0".repeat(64),
    };

    const failCodes = [];
    for (let i = 0; i < 35; i++) {
      try {
        await unauthClient.exchangeInteractiveSession(badTuple);
      } catch (e) {
        failCodes.push(e.code);
      }
    }
    assert.ok(failCodes.includes("unauthorized"));
    assert.ok(failCodes.includes("rate_limit_exceeded"));

    // Regression for Blocker 2:
    // Enough invalid exchanges hit their failure limit, then valid exchange still succeeds; invalid requests remain rate-limited
    const validClaudeClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    const validGrant = await validClaudeClient.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });
    assert.ok(validGrant.credential);
    assert.strictEqual(validGrant.senderId, env.claudeId);
    assert.strictEqual(validGrant.generation, 1);
    await validClaudeClient.close();

    // Invalid requests remain rate-limited
    await assert.rejects(
      unauthClient.exchangeInteractiveSession(badTuple),
      (err) => err.code === "rate_limit_exceeded"
    );

    await unauthClient.close();
  } finally {
    await env.server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("Item D: Inbox frame bounds - 3x 100KB Unicode messages, stable pagination cursor, tamper rejection", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const codexCred = env.issuer.issue({ senderId: env.codexId });
    const codexClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.codexId,
      turnCredential: codexCred,
    });

    const bigUnicode1 = "你好世界🚀-1-" + "a".repeat(100 * 1024);
    const bigUnicode2 = "你好世界🚀-2-" + "b".repeat(100 * 1024);
    const bigUnicode3 = "你好世界🚀-3-" + "c".repeat(100 * 1024);

    await codexClient.sendMessage({ to: env.claudeId, text: bigUnicode1, messageId: "msg-big-1", requestId: "req-big-1" });
    await codexClient.sendMessage({ to: env.claudeId, text: bigUnicode2, messageId: "msg-big-2", requestId: "req-big-2" });
    await codexClient.sendMessage({ to: env.claudeId, text: bigUnicode3, messageId: "msg-big-3", requestId: "req-big-3" });

    const claudeClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    await claudeClient.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    const page1 = await claudeClient.listInbox({ limit: 50 });
    assert.strictEqual(page1.length, 1);
    assert.strictEqual(page1[0].messageId, "msg-big-1");
    assert.strictEqual(page1[0].claimToken, undefined);
    assert.ok(page1.nextCursor);

    const page2 = await claudeClient.listInbox({ cursor: page1.nextCursor });
    assert.strictEqual(page2.length, 1);
    assert.strictEqual(page2[0].messageId, "msg-big-2");
    assert.strictEqual(page2[0].claimToken, undefined);
    assert.ok(page2.nextCursor);

    const page3 = await claudeClient.listInbox({ cursor: page2.nextCursor });
    assert.strictEqual(page3.length, 1);
    assert.strictEqual(page3[0].messageId, "msg-big-3");
    assert.strictEqual(page3.nextCursor, null);

    await assert.rejects(
      claudeClient.listInbox({ cursor: page1.nextCursor + "-tampered" }),
      (err) => err.code === "invalid_cursor"
    );

    const runnerCred = env.issuer.issue({ senderId: env.runnerId });
    const runnerClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.runnerId,
      turnCredential: runnerCred,
    });
    await assert.rejects(
      runnerClient.listInbox({ cursor: page1.nextCursor }),
      (err) => err.code === "invalid_cursor"
    );

    await codexClient.close();
    await claudeClient.close();
    await runnerClient.close();
  } finally {
    await env.server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("Item E: REAL createInstalledLocalMessagingHost integration with Claude interactive destination", async () => {
  const baseTmp = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(baseTmp, "tri-host-int-"));
  fs.chmodSync(tmpDir, 0o700);

  let host = null;
  let codexClient = null;
  let claudeClient = null;

  try {
    const configPath = path.join(tmpDir, "local.json");
    const bindingPath = path.join(tmpDir, "desktop-binding.json");
    const codexIntegPath = path.join(tmpDir, "codex-integ.json");
    const claudeIntegPath = path.join(tmpDir, "claude-integ.json");
    const stateRoot = path.join(tmpDir, "state");

    const codexSenderId = "1".repeat(64);
    const claudeSenderId = "2".repeat(64);
    const runnerInstanceId = "3".repeat(64);
    const codexSecret = "4".repeat(64);
    const claudeSecret = "5".repeat(64);
    const claudeSessionId = crypto.randomUUID();
    const claudeBindingId = crypto.randomUUID();

    writePrivateJson(bindingPath, { instanceId: codexSenderId, threadId: "thread-desktop", enabled: false });
    writePrivateJson(codexIntegPath, {
      version: 1,
      senderId: codexSenderId,
      threadId: "thread-desktop",
      secret: codexSecret,
      bindingId: "bind-desktop",
    });

    writePrivateJson(claudeIntegPath, {
      version: 1,
      type: "interactive",
      senderId: claudeSenderId,
      sessionId: claudeSessionId,
      generation: 1,
      bindingId: claudeBindingId,
      secret: claudeSecret,
      enabled: true,
      revoked: false,
    });

    writePrivateJson(configPath, {
      version: 1,
      enabled: true,
      stateRoot,
      bindingPath,
      integrationPath: codexIntegPath,
      recipients: [{ profile: "gravity2", instanceId: runnerInstanceId }],
      interactive: {
        enabled: true,
        integrationPath: claudeIntegPath,
      },
      runnerTimeoutMs: 3600000,
    });

    let runnerExecuted = false;
    let runnerRequestReceived = null;
    const runner = {
      run: async (request) => {
        runnerExecuted = true;
        runnerRequestReceived = request;
        return { status: "completed", text: "runner result: " + request.text };
      },
    };

    host = createInstalledLocalMessagingHost({
      configPath,
      runners: new Map([[runnerInstanceId, runner]]),
      gate: createProfiledReasonerGate(),
    });
    await host.start();

    const socketPath = resolveLocalSocketAddress({ stateRoot }).socketPath;

    codexClient = createLocalControlClient({
      socketPath,
      senderId: codexSenderId,
    });
    await codexClient.exchangeTurnBinding({
      bindingId: "bind-desktop",
      threadId: "thread-desktop",
      secret: codexSecret,
    });

    const discovered = await codexClient.discoverRecipients();
    assert.ok(discovered.includes(runnerInstanceId));
    assert.ok(discovered.includes(claudeSenderId));

    const sendRes = await codexClient.sendMessage({
      to: claudeSenderId,
      text: "hello claude task",
      messageId: "msg-codex-to-claude",
      requestId: "req-c2c-1",
    });
    assert.strictEqual(sendRes.accepted, true);
    assert.strictEqual(runnerExecuted, false, "runner must NOT be invoked for interactive destination");

    claudeClient = createLocalControlClient({
      socketPath,
      senderId: claudeSenderId,
    });
    await claudeClient.exchangeInteractiveSession({
      bindingId: claudeBindingId,
      sessionId: claudeSessionId,
      generation: 1,
      secret: claudeSecret,
    });

    const claudeInbox = await claudeClient.listInbox();
    assert.strictEqual(claudeInbox.length, 1);
    assert.strictEqual(claudeInbox[0].messageId, "msg-codex-to-claude");

    const claimRes = await claudeClient.claimInboxMessage({ messageId: "msg-codex-to-claude", claimId: "op-c2c" });
    assert.ok(claimRes.claimToken);

    const replyRes = await claudeClient.sendReply({
      messageId: "msg-codex-to-claude",
      claimToken: claimRes.claimToken,
      text: "terminal reply from claude to codex",
      replyId: "rep-claude-1",
    });
    assert.strictEqual(replyRes.isDuplicate, false);

    const replies = await codexClient.listReplies({ requestId: "req-c2c-1" });
    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].text, "terminal reply from claude to codex");

    const claudeToRunner = await claudeClient.sendMessage({
      to: runnerInstanceId,
      text: "process batch 42",
      messageId: "msg-claude-to-runner",
      requestId: "req-c2r-1",
    });
    assert.strictEqual(claudeToRunner.accepted, true);

    let runnerReplies = [];
    for (let i = 0; i < 20; i++) {
      runnerReplies = await claudeClient.listReplies({ requestId: "req-c2r-1" });
      if (runnerReplies.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(runnerExecuted, true);
    assert.strictEqual(runnerRequestReceived.senderId, claudeSenderId);
    assert.strictEqual(runnerReplies.length, 1);
    assert.strictEqual(runnerReplies[0].text, "runner result: process batch 42");

    await codexClient.close();
    await claudeClient.close();
    await host.stop();
    host = null;
  } finally {
    await codexClient?.close();
    await claudeClient?.close();
    await host?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Item F: Claim runtime 1-hour bounded lease, stable claimId retry vs distinct parallel claims", async () => {
  const env = setupTestEnv();
  await env.server.start();

  try {
    const codexCred = env.issuer.issue({ senderId: env.codexId });
    const codexClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.codexId,
      turnCredential: codexCred,
    });
    await codexClient.sendMessage({
      to: env.claudeId,
      text: "task for claim test",
      messageId: "msg-claim-f1",
      requestId: "req-claim-f1",
    });

    const claudeClient = createLocalControlClient({
      socketPath: env.socketPath,
      senderId: env.claudeId,
    });
    await claudeClient.exchangeInteractiveSession({
      bindingId: env.interactiveBindingId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      secret: env.interactiveSecret,
    });

    // Missing claimId must be rejected
    await assert.rejects(
      claudeClient.claimInboxMessage({ messageId: "msg-claim-f1" }),
      (err) => err.code === "invalid_request"
    );
    await assert.rejects(
      claudeClient.claimInboxMessage({ messageId: "msg-claim-f1", claimId: "" }),
      (err) => err.code === "invalid_request"
    );

    // Parallel claims with missing IDs are rejected
    const [missing1, missing2] = await Promise.allSettled([
      claudeClient.claimInboxMessage({ messageId: "msg-claim-f1" }),
      claudeClient.claimInboxMessage({ messageId: "msg-claim-f1" }),
    ]);
    assert.strictEqual(missing1.status, "rejected");
    assert.strictEqual(missing1.reason?.code, "invalid_request");
    assert.strictEqual(missing2.status, "rejected");
    assert.strictEqual(missing2.reason?.code, "invalid_request");

    // Parallel claims with distinct IDs produce exactly one winner
    const now = Date.now();
    const [race1, race2] = await Promise.allSettled([
      claudeClient.claimInboxMessage({ messageId: "msg-claim-f1", claimId: "op-claim-1" }),
      claudeClient.claimInboxMessage({ messageId: "msg-claim-f1", claimId: "op-claim-2" }),
    ]);
    const fulfilled = [race1, race2].filter((r) => r.status === "fulfilled");
    const rejected = [race1, race2].filter((r) => r.status === "rejected");
    assert.strictEqual(fulfilled.length, 1);
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].reason?.code, "claim_failed");
    assert.ok(fulfilled[0].value?.claimToken);
    const winningId = fulfilled[0].value.claimId;
    const losingId = winningId === "op-claim-1" ? "op-claim-2" : "op-claim-1";

    assert.strictEqual(fulfilled[0].value.isRetry, false);
    assert.ok(fulfilled[0].value.leaseExpiresAt >= now + 3590000);
    assert.ok(fulfilled[0].value.leaseExpiresAt <= now + 3610000);

    // Exact retry with winning ID succeeds with same token
    const retryClaim = await claudeClient.claimInboxMessage({
      messageId: "msg-claim-f1",
      claimId: winningId,
    });
    assert.strictEqual(retryClaim.claimToken, fulfilled[0].value.claimToken);
    assert.strictEqual(retryClaim.isRetry, true);

    // Retry with losing ID or missing ID fails
    await assert.rejects(
      claudeClient.claimInboxMessage({
        messageId: "msg-claim-f1",
        claimId: losingId,
      }),
      (err) => err.code === "claim_failed"
    );
    await assert.rejects(
      claudeClient.claimInboxMessage({ messageId: "msg-claim-f1" }),
      (err) => err.code === "invalid_request"
    );

    // Direct journal API rejects missing / invalid claimId
    await assert.rejects(
      env.journal.claimInboxMessage({
        messageId: "msg-claim-f1",
        requester: env.claudeId,
        sessionId: env.interactiveSessionId,
        generation: 1,
      }),
      (err) => err.code === "invalid_params"
    );
    await assert.rejects(
      env.journal.claimInboxMessage({
        messageId: "msg-claim-f1",
        requester: env.claudeId,
        sessionId: env.interactiveSessionId,
        generation: 1,
        claimId: "",
      }),
      (err) => err.code === "invalid_params"
    );

    await assert.rejects(
      claudeClient.claimInboxMessage({
        messageId: "msg-claim-f1",
        claimId: "op-claim-2",
      }),
      (err) => err.code === "claim_failed"
    );

    let vTime = 2000000;
    const clk = () => vTime;
    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: "msg-claim-f2",
      requestId: "req-f2",
      text: "no replay",
    });
    await env.journal.claimInboxMessage({
      messageId: "msg-claim-f2",
      requester: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      claimId: "op-claim-f2",
      leaseDurationMs: 1000,
      now: clk,
    });
    vTime += 2000;

    const inboxReaped = await env.journal.listInbox({ requester: env.claudeId, now: clk });
    assert.strictEqual(inboxReaped.length, 0);

    const reapedMsg = await env.journal.getRecord("msg-claim-f2");
    assert.strictEqual(reapedMsg.phase, "held");

    await codexClient.close();
    await claudeClient.close();
    await env.server.close();
    await env.journal.close();

    const restarted = createLocalMessagingJournal({ stateRoot: env.stateRoot });
    const restartMsg = await restarted.getRecord("msg-claim-f2");
    assert.strictEqual(restartMsg.phase, "held");
    const recovered = await restarted.recoverQueued();
    assert.strictEqual(recovered.toRun.some((m) => m.messageId === "msg-claim-f2"), false);
    await restarted.close();
  } finally {
    await env.server.close().catch(() => {});
    await env.journal.close().catch(() => {});
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});
