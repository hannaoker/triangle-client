import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createTestMemoryJournal, createTestRecoverableDispatcher, createTestSqliteJournal } from "./local-messaging-fixtures.mjs";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import {
  createTurnCapabilityIssuer,
  createTurnCapabilityValidator,
} from "../src/local-messaging-credentials.mjs";
import {
  createPerSenderRateLimiter,
  createConversationLoopTracker,
} from "../src/local-messaging-rate-limiter.mjs";
import {
  encodeFrame,
  createMessageParser,
  createSuccessResponse,
} from "../src/local-messaging-protocol.mjs";
import { LocalMessagingError } from "../src/local-messaging-errors.mjs";

function setupEnvironment() {
  const realTmp = fs.realpathSync(os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(realTmp, "triangle-server-test-"));
  fs.chmodSync(tmpDir, 0o700);
  const socketPath = path.join(tmpDir, "local-control.sock");
  const secret = "test-secret-key-32-bytes-long-1234567890";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });
  const acl = createOwnerAcl({
    rules: {
      "desktop-codex": ["gravity2"],
      "gravity2": ["desktop-codex"],
      "eve": [],
    },
  });
  const journal = createTestMemoryJournal();
  const dispatcher = createTestRecoverableDispatcher({ journal });
  const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 });
  const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });

  return {
    tmpDir,
    socketPath,
    secret,
    issuer,
    validator,
    acl,
    journal,
    dispatcher,
    rateLimiter,
    loopTracker,
  };
}

test("server requires credentialValidator and ACL (no auth-optional fallback)", () => {
  const env = setupEnvironment();
  try {
    assert.throws(
      () => createLocalControlServer({ socketPath: env.socketPath, journal: env.journal, acl: null, credentialValidator: env.validator, dispatcher: env.dispatcher }),
      (err) => err instanceof LocalMessagingError && err.code === "invalid_options",
    );
    assert.throws(
      () => createLocalControlServer({ socketPath: env.socketPath, journal: env.journal, acl: env.acl, credentialValidator: null, dispatcher: env.dispatcher }),
      (err) => err instanceof LocalMessagingError && err.code === "invalid_options",
    );
    // Missing dispatcher
    assert.throws(
      () => createLocalControlServer({ socketPath: env.socketPath, journal: env.journal, acl: env.acl, credentialValidator: env.validator }),
      (err) => err instanceof LocalMessagingError && err.code === "dispatcher_required",
    );
    for (const dispatcher of [
      { notifyAdmission: async () => {} },
      { notifyAdmission: async () => {}, start: async () => {} },
      { notifyAdmission: async () => {}, stop: async () => {} },
    ]) {
      assert.throws(
        () => createLocalControlServer({ socketPath: env.socketPath, journal: env.journal, acl: env.acl, credentialValidator: env.validator, dispatcher }),
        (err) => err.code === "invalid_dispatcher",
      );
    }
    // A stray admitExecution option is not a dispatcher
    assert.throws(
      () => createLocalControlServer({ socketPath: env.socketPath, journal: env.journal, acl: env.acl, credentialValidator: env.validator, admitExecution: async () => {} }),
      (err) => err instanceof LocalMessagingError && err.code === "dispatcher_required",
    );
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("local control server and client lifecycle, send, retrieval, and reconnect", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  let admittedExecution = null;

  const dispatcher = createTestRecoverableDispatcher({
    journal: env.journal,
    execute: async (job) => {
      admittedExecution = job;
      setTimeout(async () => {
        await env.journal.recordReply({
          sender: job.recipient,
          recipient: job.sender,
          messageId: "reply-msg-1",
          requestId: job.requestId,
          inReplyTo: job.messageId,
          text: `Processed: ${job.text}`,
        });
      }, 50);
    },
  });

  const server = createLocalControlServer({
    socketPath: env.socketPath,
    journal: env.journal,
    acl: env.acl,
    credentialValidator: env.validator,
    rateLimiter: env.rateLimiter,
    loopTracker: env.loopTracker,
    dispatcher,
  });

  try {
    await server.start();

    const codexToken = env.issuer.issue({ senderId: "desktop-codex" });
    const client = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: codexToken,
      senderId: "desktop-codex",
    });

    const recipients = await client.discoverRecipients();
    assert.deepEqual(recipients, ["gravity2"]);

    const sendReceipt = await client.sendMessage({
      to: "gravity2",
      text: "hello gravity2",
      messageId: "msg-001",
      requestId: "req-001",
    });

    assert.equal(sendReceipt.accepted, true);
    assert.equal(sendReceipt.messageId, "msg-001");
    assert.equal(sendReceipt.status, "queued_local");
    assert.equal(admittedExecution?.text, "hello gravity2");

    await client.close();

    // Reconnect with fresh client and retrieve reply
    const client2 = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: codexToken,
      senderId: "desktop-codex",
    });

    const reply = await client2.waitForReply({
      requestId: "req-001",
      timeoutMs: 2000,
      pollIntervalMs: 20,
    });

    assert.ok(reply);
    assert.equal(reply.text, "Processed: hello gravity2");
    assert.equal(reply.sender, "gravity2");

    const pending = await client2.listReplies({ requestId: "req-001" });
    assert.equal(pending.length, 1);

    const consumeRes = await client2.consumeReply({ messageId: reply.messageId });
    assert.equal(consumeRes.consumed, true);

    const afterConsume = await client2.listReplies({ requestId: "req-001" });
    assert.equal(afterConsume.length, 0);

    const cancelRes = await client2.cancelMessage({ messageId: "msg-001" });
    assert.equal(cancelRes.status, "unsupported");

    await client2.close();
  } finally {
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("get_message_status enforces requester ownership and redacts runtime errors", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  const server = createLocalControlServer({
    socketPath: env.socketPath,
    journal: env.journal,
    acl: env.acl,
    credentialValidator: env.validator,
    rateLimiter: env.rateLimiter,
    loopTracker: env.loopTracker,
    dispatcher: env.dispatcher,
  });

  try {
    await server.start();

    // Record a failed message sent by desktop-codex to gravity2
    await env.journal.recordSend({
      sender: "desktop-codex",
      recipient: "gravity2",
      messageId: "msg-status-1",
      requestId: "req-status-1",
      text: "test status",
    });
    await env.journal.recordExecutionFailure({
      messageId: "msg-status-1",
      reason: "runner_failed",
      runtimeError: "SECRET_TOKEN=xyz123 Fatal crash",
    });

    const codexToken = env.issuer.issue({ senderId: "desktop-codex" });
    const codexClient = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: codexToken,
      senderId: "desktop-codex",
    });

    // 1. Authorized sender gets status with redacted fixed error message (never raw error/token)
    const status = await codexClient.getMessageStatus({ messageId: "msg-status-1" });
    assert.equal(status.messageId, "msg-status-1");
    assert.equal(status.phase, "reply_failed");
    assert.equal(status.reason, "runner_failed");
    assert.equal(status.runtimeError, "Execution failure occurred"); // fixed redacted message!
    assert.ok(!status.runtimeError.includes("SECRET_TOKEN"));

    // 2. Foreign requester (eve) attempting to access status is denied
    const eveToken = env.issuer.issue({ senderId: "eve" });
    const eveClient = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: eveToken,
      senderId: "eve",
    });

    await assert.rejects(
      async () => eveClient.getMessageStatus({ messageId: "msg-status-1" }),
      (err) => err instanceof LocalMessagingError && err.code === "foreign_access_denied",
    );

    // 3. Unknown messageId returns not_found
    await assert.rejects(
      async () => codexClient.getMessageStatus({ messageId: "non-existent-msg" }),
      (err) => err instanceof LocalMessagingError && err.code === "not_found",
    );

    await codexClient.close();
    await eveClient.close();
  } finally {
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("duplicate send returns stored requestId; conflicting envelope is rejected", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  const server = createLocalControlServer({
    socketPath: env.socketPath,
    journal: env.journal,
    acl: env.acl,
    credentialValidator: env.validator,
    rateLimiter: env.rateLimiter,
    loopTracker: env.loopTracker,
    dispatcher: env.dispatcher,
  });

  try {
    await server.start();
    const token = env.issuer.issue({ senderId: "desktop-codex" });
    const client = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: token,
      senderId: "desktop-codex",
    });

    const receipt1 = await client.sendMessage({
      to: "gravity2",
      text: "first send",
      messageId: "msg-idemp-1",
      requestId: "req-ORIGINAL",
    });
    assert.equal(receipt1.requestId, "req-ORIGINAL");
    assert.equal(receipt1.isDuplicate, false);

    // Identical duplicate: returns original stored requestId
    const receipt2 = await client.sendMessage({
      to: "gravity2",
      text: "first send",
      messageId: "msg-idemp-1",
      requestId: "req-ORIGINAL",
    });
    assert.equal(receipt2.requestId, "req-ORIGINAL");
    assert.equal(receipt2.isDuplicate, true);

    // Conflicting duplicate with new requestId or payload must be rejected
    await assert.rejects(
      async () => client.sendMessage({
        to: "gravity2",
        text: "first send",
        messageId: "msg-idemp-1",
        requestId: "req-NEW-DIFFERENT",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );

    await client.close();
  } finally {
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("failed startup and close of competing server does NOT unlink active owner's socket", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  const server1 = createLocalControlServer({
    socketPath: env.socketPath,
    journal: env.journal,
    acl: env.acl,
    credentialValidator: env.validator,
    rateLimiter: env.rateLimiter,
    loopTracker: env.loopTracker,
    dispatcher: env.dispatcher,
  });

  const server2 = createLocalControlServer({
    socketPath: env.socketPath,
    journal: env.journal,
    acl: env.acl,
    credentialValidator: env.validator,
    rateLimiter: env.rateLimiter,
    loopTracker: env.loopTracker,
    dispatcher: env.dispatcher,
  });

  try {
    await server1.start();

    // Server 2 attempts to start and fails
    await assert.rejects(
      async () => server2.start(),
      (err) => err instanceof LocalMessagingError && err.code === "socket_busy",
    );

    // Closing server 2 MUST NOT unlink server 1's active socket!
    await server2.close();
    assert.equal(fs.existsSync(env.socketPath), true, "Active socket must still exist after competing server close!");

    // Server 1 is still operating normally
    const token = env.issuer.issue({ senderId: "desktop-codex" });
    const client = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: token,
      senderId: "desktop-codex",
    });
    const recipients = await client.discoverRecipients();
    assert.deepEqual(recipients, ["gravity2"]);
    await client.close();
  } finally {
    await server1.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("protocol parsing handles coalesced frames, rejects oversized single frame, and handles null/scalars safely", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  const server = createLocalControlServer({
    socketPath: env.socketPath,
    journal: env.journal,
    acl: env.acl,
    credentialValidator: env.validator,
    rateLimiter: env.rateLimiter,
    loopTracker: env.loopTracker,
    dispatcher: env.dispatcher,
  });

  try {
    await server.start();
    const token = env.issuer.issue({ senderId: "desktop-codex" });

    // Raw socket test for protocol framing and edge cases
    const rawSock = net.createConnection({ path: env.socketPath });
    await new Promise((res) => rawSock.on("connect", res));

    const receivedFrames = [];
    const parser = createMessageParser({
      onMessage: (msg) => receivedFrames.push(msg),
    });
    rawSock.on("data", (chunk) => parser.feed(chunk));

    // 1. Send null/scalar: should safely return JSON-RPC error without crashing server or unhandled rejection
    const nullPayload = Buffer.from("null", "utf8");
    const nullFrame = Buffer.alloc(4 + nullPayload.length);
    nullFrame.writeUInt32BE(nullPayload.length, 0);
    nullPayload.copy(nullFrame, 4);
    rawSock.write(nullFrame);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(receivedFrames.length >= 1);
    assert.equal(receivedFrames[0].error.code, "invalid_request");

    // 2. Coalesced multiple valid frames in a single chunk
    receivedFrames.length = 0;
    const frame1 = encodeFrame({ protocol_version: 1, id: "c1", method: "discover_recipients", credential: token, senderId: "desktop-codex" });
    const frame2 = encodeFrame({ protocol_version: 1, id: "c2", method: "discover_recipients", credential: token, senderId: "desktop-codex" });
    const combined = Buffer.concat([frame1, frame2]);
    rawSock.write(combined);

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(receivedFrames.length, 2);
    assert.equal(receivedFrames[0].id, "c1");
    assert.equal(receivedFrames[1].id, "c2");

    rawSock.destroy();
  } finally {
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("client connect timeout, close during connect, and waitForReply deadline compliance", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();

  // 1. Connection to non-existent / absent socket fails cleanly
  const badClient = createLocalControlClient({
    socketPath: path.join(env.tmpDir, "absent.sock"),
    turnCredential: "dummy",
    senderId: "desktop-codex",
    connectTimeoutMs: 200,
  });

  await assert.rejects(
    async () => badClient.discoverRecipients(),
    (err) => err instanceof LocalMessagingError && (err.code === "connection_error" || err.code === "connection_timeout"),
  );
  await badClient.close();

  // 2. waitForReply respects overall caller deadline (stops in ~200ms when asked 200ms)
  const server = createLocalControlServer({
    socketPath: env.socketPath,
    journal: env.journal,
    acl: env.acl,
    credentialValidator: env.validator,
    rateLimiter: env.rateLimiter,
    loopTracker: env.loopTracker,
    dispatcher: env.dispatcher,
  });

  try {
    await server.start();
    const token = env.issuer.issue({ senderId: "desktop-codex" });
    const client = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: token,
      senderId: "desktop-codex",
      timeoutMs: 30000, // default client timeout is 30s!
    });

    const start = Date.now();
    await assert.rejects(
      async () => client.waitForReply({ requestId: "non-existent", timeoutMs: 200, pollIntervalMs: 30 }),
      (err) => err instanceof LocalMessagingError && err.code === "wait_timeout",
    );
    const elapsed = Date.now() - start;
    // Must respect 200ms deadline, NOT block 30s!
    assert.ok(elapsed < 1000, `Expected waitForReply to stop near 200ms, took ${elapsed}ms`);

    await client.close();
  } finally {
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("rate limiter: concurrent sends with maxRequestsPerWindow=1 admits only 1, rolls back rejected/conflicting sends, prevents infinite retry bypass", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  const tightRateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 1, windowMs: 60000 });
  const server = createLocalControlServer({
    socketPath: env.socketPath,
    journal: env.journal,
    acl: env.acl,
    credentialValidator: env.validator,
    rateLimiter: tightRateLimiter,
    loopTracker: env.loopTracker,
    dispatcher: env.dispatcher,
  });

  try {
    await server.start();
    const token = env.issuer.issue({ senderId: "desktop-codex" });
    const client = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: token,
      senderId: "desktop-codex",
    });

    // 1. Repro Promise.all 3 sends with maxRequestsPerWindow 1 must accept only 1
    const results = await Promise.allSettled([
      client.sendMessage({ to: "gravity2", text: "msg 1", messageId: "msg-conc-1" }),
      client.sendMessage({ to: "gravity2", text: "msg 2", messageId: "msg-conc-2" }),
      client.sendMessage({ to: "gravity2", text: "msg 3", messageId: "msg-conc-3" }),
    ]);

    const accepted = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(accepted.length, 1, "Exactly one of the concurrent sends must be accepted");
    assert.equal(rejected.length, 2, "Other two concurrent sends must be rejected");
    for (const rej of rejected) {
      assert.equal(rej.reason.code, "rate_limit_exceeded");
    }

    // 2. No infinite retry bypass: immediate duplicate retry cannot bypass rate limit
    await assert.rejects(
      async () => client.sendMessage({ to: "gravity2", text: "msg 1", messageId: accepted[0].value.messageId }),
      (err) => err instanceof LocalMessagingError && err.code === "rate_limit_exceeded",
    );

    // 3. Preserve no rate use for rejected sends
    // Use an independent sender 'bob' with limit 1
    const bobToken = env.issuer.issue({ senderId: "eve" }); // eve has empty ACL rules
    const bobClient = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: bobToken,
      senderId: "eve",
    });

    // Eve attempts an invalid send (recipient not in ACL)
    await assert.rejects(
      async () => bobClient.sendMessage({ to: "gravity2", text: "bad", messageId: "eve-msg-0" }),
      (err) => err instanceof LocalMessagingError && err.code === "recipient_not_allowed",
    );

    // 4. Preserve no rate use for conflicting duplicate send
    // Store a message first directly in journal
    await env.journal.recordSend({
      sender: "desktop-codex",
      recipient: "gravity2",
      messageId: "stored-conflict-test",
      requestId: "orig-req-stored",
      text: "stored content",
    });

    // Reset rate limiter for clean conflict check
    tightRateLimiter.reset();

    // Send conflicting payload for same messageId
    await assert.rejects(
      async () => client.sendMessage({
        to: "gravity2",
        text: "conflict text",
        messageId: "stored-conflict-test",
        requestId: "different-req-id",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );

    // Conflicting send reservation rolled back; sender quota preserved, fresh message succeeds!
    const freshReceipt = await client.sendMessage({
      to: "gravity2",
      text: "fresh message after conflict",
      messageId: "fresh-msg-after-conflict",
    });
    assert.equal(freshReceipt.accepted, true);

    await client.close();
    await bobClient.close();
  } finally {
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("recoverable dispatcher: persistent queued records recovered once, uncertain started never rerun, duplicate notification never overlaps, close waits dispatcher", { skip: process.platform === "win32" }, async () => {
  const realTmp = fs.realpathSync(os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(realTmp, "triangle-recov-test-"));
  fs.chmodSync(tmpDir, 0o700);
  const dbPath = path.join(tmpDir, "recoverable.sqlite");
  const socketPath = path.join(tmpDir, "local-control.sock");

  const journal = createTestSqliteJournal({ dbPath });

  // 1. Pre-seed journal with:
  // - a queued record before start
  // - an uncertain started execution (crashed in flight)
  await journal.recordSend({
    sender: "desktop-codex",
    recipient: "gravity2",
    messageId: "msg-queued-prestart",
    requestId: "req-q-1",
    text: "queued before start",
  });

  // Pre-seed uncertain record in SQLite
  const db = new (await import("node:sqlite")).DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO local_messages (message_id, sender, recipient, request_id, in_reply_to, text, metadata, phase, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "msg-uncertain-started",
    "desktop-codex",
    "gravity2",
    "req-unc-1",
    null,
    "uncertain started job",
    "{}",
    "started",
    Date.now(),
    Date.now(),
  );
  db.close();

  const dispatchedJobs = [];
  const slowExecutionResolve = [];
  let overlapDetected = false;
  let activeSlowExecutions = 0;

  const dispatcher = createTestRecoverableDispatcher({
    journal,
    execute: async (job) => {
      dispatchedJobs.push(job);
      if (job.messageId === "msg-slow-dup") {
        activeSlowExecutions++;
        if (activeSlowExecutions > 1) {
          overlapDetected = true;
        }
        await new Promise((res) => slowExecutionResolve.push(res));
        activeSlowExecutions--;
      }
    },
  });

  const acl = createOwnerAcl({ rules: { "desktop-codex": ["gravity2"] } });
  const validator = createTurnCapabilityValidator({ secret: "test-secret-key-32-bytes-long-1234567890" });
  const server = createLocalControlServer({
    socketPath,
    journal,
    acl,
    credentialValidator: validator,
    dispatcher,
  });

  try {
    // Start server: must claim queued records and hold uncertain started ones
    await server.start();

    // 1. Fixture persistent queued-before-start -> recovery dispatched once
    assert.equal(dispatchedJobs.some((j) => j.messageId === "msg-queued-prestart"), true);
    const initialDispatchedCount = dispatchedJobs.length;

    // Trigger recovery again: must NOT rerun
    await dispatcher.start({ journal });
    assert.equal(dispatchedJobs.length, initialDispatchedCount, "Queued record must only be dispatched once");

    // 2. Uncertain started records must NEVER be rerun
    assert.equal(dispatcher.uncertainHeld.includes("msg-uncertain-started"), true);
    assert.equal(dispatchedJobs.some((j) => j.messageId === "msg-uncertain-started"), false, "Uncertain started execution must never be rerun");

    // Even if duplicate notification arrives for uncertain started record, it is ignored
    await dispatcher.notifyAdmission({ messageId: "msg-uncertain-started" });
    assert.equal(dispatchedJobs.some((j) => j.messageId === "msg-uncertain-started"), false);

    // 3. Duplicate notification / retry never overlaps
    const p1 = dispatcher.notifyAdmission({ messageId: "msg-slow-dup", text: "slow" });
    const p2 = dispatcher.notifyAdmission({ messageId: "msg-slow-dup", text: "slow" });
    assert.equal(overlapDetected, false);

    // Complete the slow execution
    while (slowExecutionResolve.length > 0) {
      slowExecutionResolve.shift()();
    }
    await Promise.all([p1, p2]);
    assert.equal(overlapDetected, false, "Duplicate notification must never run concurrently overlapping");

    // 4. Close waits dispatcher before journal is closed
    let journalClosedPrematurely = false;

    // Start an active execution on the dispatcher
    const slowClosePromise = dispatcher.notifyAdmission({
      messageId: "msg-closing-wait",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 60));
        try {
          await journal.recordSend({
            sender: "desktop-codex",
            recipient: "gravity2",
            messageId: "msg-written-during-close",
            requestId: "req-c-1",
            text: "written during close wait",
          });
        } catch {
          journalClosedPrematurely = true;
        }
      },
    });

    // Close server (which waits dispatcher) then close journal
    await server.close();
    await journal.close();

    assert.equal(journalClosedPrematurely, false, "Close must wait for dispatcher before journal is closed");
  } finally {
    try { await server.close(); } catch {}
    try { await journal.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("an oversized reply is listed truncated, waited for and consumed, and its full text stays journaled", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  const server = createLocalControlServer({
    socketPath: env.socketPath,
    journal: env.journal,
    acl: env.acl,
    credentialValidator: env.validator,
    rateLimiter: env.rateLimiter,
    loopTracker: env.loopTracker,
    dispatcher: env.dispatcher,
  });

  try {
    await server.start();
    const client = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: env.issuer.issue({ senderId: "desktop-codex" }),
      senderId: "desktop-codex",
    });
    const bigText = "x".repeat(300 * 1024);
    for (const [name, text] of [["big", bigText], ["small", "done"]]) {
      await env.journal.recordSend({ sender: "desktop-codex", recipient: "gravity2", messageId: `m-${name}`, requestId: `r-${name}`, text: "job" });
      await env.journal.recordReply({ sender: "gravity2", recipient: "desktop-codex", messageId: `rep-${name}`, requestId: `r-${name}`, inReplyTo: `m-${name}`, text });
    }

    // Unfiltered listings always make progress: the oversized reply comes first, truncated.
    const all = await client.listReplies({});
    assert.deepEqual(all.map((r) => r.messageId), ["rep-big"]);
    assert.equal(all[0].truncated, true);
    assert.equal(all[0].originalTextBytes, bigText.length);
    assert.ok(bigText.startsWith(all[0].text));

    // It can be found by its own request and waited for, which never worked before.
    const byRequest = await client.listReplies({ requestId: "r-big" });
    assert.equal(byRequest.length, 1);
    assert.equal(byRequest[0].truncated, true);
    const waited = await client.waitForReply({ requestId: "r-big", timeoutMs: 1000, pollIntervalMs: 20 });
    assert.equal(waited.messageId, "rep-big");

    // The full text is untouched in the journal.
    const [stored] = await env.journal.listReplies({ requester: "desktop-codex", requestId: "r-big" });
    assert.equal(stored.text.length, bigText.length);
    assert.equal(stored.truncated, undefined);

    // It is consumable, and consuming it exposes the next reply.
    assert.equal((await client.consumeReply({ messageId: "rep-big" })).consumed, true);
    const rest = await client.listReplies({});
    assert.deepEqual(rest.map((r) => r.messageId), ["rep-small"]);
    assert.equal(rest[0].truncated, undefined);
    await client.close();
  } finally {
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("per-message status exposes only the presence of a late result, never its text", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  const journal = createLocalMessagingJournal({ stateRoot: env.tmpDir });
  const server = createLocalControlServer({
    socketPath: env.socketPath,
    journal,
    acl: env.acl,
    credentialValidator: env.validator,
    dispatcher: createTestRecoverableDispatcher({ journal }),
  });
  try {
    await server.start();
    const client = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: env.issuer.issue({ senderId: "desktop-codex" }),
      senderId: "desktop-codex",
    });
    for (const id of ["with-late", "without-late"]) {
      await journal.recordSend({ sender: "desktop-codex", recipient: "gravity2", messageId: id, requestId: `r-${id}`, text: "job" });
    }
    await journal.holdExecution("with-late", "runner_timeout", { lateResultText: "SENSITIVE late output" });
    await journal.holdExecution("without-late", "runner_timeout");

    const withLate = await client.getMessageStatus({ messageId: "with-late" });
    assert.equal(withLate.phase, "held");
    assert.equal(withLate.reason, "runner_timeout");
    assert.equal(withLate.hasLateResult, true);
    assert.ok(!JSON.stringify(withLate).includes("SENSITIVE"));
    assert.equal((await client.getMessageStatus({ messageId: "without-late" })).hasLateResult, false);
    assert.deepEqual(await client.listReplies({}), [], "a late result is never listed as a reply");
    await client.close();
  } finally {
    await server.close();
    await journal.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rawConnection(socketPath) {
  const sock = net.createConnection({ path: socketPath });
  await new Promise((resolve) => sock.on("connect", resolve));
  const frames = [];
  const parser = createMessageParser({ onMessage: (message) => frames.push(message) });
  sock.on("data", (chunk) => parser.feed(chunk));
  return { sock, frames };
}

test("a connection cannot bypass the in-flight cap by reusing one request id", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  let release;
  let gate = new Promise((resolve) => { release = resolve; });
  let statusCalls = 0;
  const server = createLocalControlServer({
    socketPath: env.socketPath,
    journal: env.journal,
    acl: env.acl,
    credentialValidator: env.validator,
    dispatcher: env.dispatcher,
    statusProvider: async () => { statusCalls++; await gate; return { route: "same-device" }; },
  });
  let connection;
  try {
    await server.start();
    const token = env.issuer.issue({ senderId: "desktop-codex" });
    connection = await rawConnection(env.socketPath);
    const send = (id) => connection.sock.write(encodeFrame({ protocol_version: 1, id, method: "local_status", credential: token, senderId: "desktop-codex" }));

    // The same id sixty times: only one may be in flight, the others are refused immediately.
    for (let i = 0; i < 60; i++) send("same-id");
    await sleep(100);
    assert.equal(statusCalls, 1, "a reused id must not multiply concurrent work");
    const refused = connection.frames.filter((frame) => frame.error);
    assert.equal(refused.length, 59);
    assert.ok(refused.every((frame) => frame.error.code === "invalid_request"));
    release();
    await sleep(50);
    assert.equal(connection.frames.filter((frame) => frame.result).length, 1);

    // Distinct ids are still capped per connection, and the count recovers when requests finish.
    for (const round of [0, 1]) {
      connection.frames.length = 0;
      statusCalls = 0;
      gate = new Promise((resolve) => { release = resolve; });
      for (let i = 0; i < 60; i++) send(`distinct-${round}-${i}`);
      await sleep(100);
      assert.equal(statusCalls, 50, `round ${round}: exactly the cap is in flight`);
      assert.equal(connection.frames.filter((frame) => frame.error?.code === "too_many_requests").length, 10);
      release();
      await sleep(100);
      assert.equal(connection.frames.filter((frame) => frame.result).length, 50);
    }
    // An id may be reused once its request has finished.
    connection.frames.length = 0;
    gate = Promise.resolve();
    send("same-id");
    await sleep(50);
    assert.equal(connection.frames.filter((frame) => frame.result).length, 1);
  } finally {
    release?.();
    connection?.sock.destroy();
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("message identifiers must be bounded identifier strings; existing ID shapes keep working", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  const instanceId = "ab".repeat(32);
  const acl = createOwnerAcl({ rules: { "desktop-codex": ["gravity2", instanceId], gravity2: ["desktop-codex"] } });
  const server = createLocalControlServer({
    socketPath: env.socketPath, journal: env.journal, acl, credentialValidator: env.validator,
    rateLimiter: env.rateLimiter, loopTracker: env.loopTracker, dispatcher: env.dispatcher,
  });
  try {
    await server.start();
    const client = createLocalControlClient({ socketPath: env.socketPath, turnCredential: env.issuer.issue({ senderId: "desktop-codex" }), senderId: "desktop-codex" });
    const invalid = async (promise, label) => assert.rejects(promise, (err) => err instanceof LocalMessagingError && err.code === "invalid_request", label);
    const hostile = ["has space", "x".repeat(257), "../../etc/passwd", "line\nbreak", "semi;colon", "quote\"", "\u0000nul", "\u00e9"];
    for (const bad of hostile) {
      await invalid(client.sendMessage({ to: "gravity2", text: "t", messageId: bad }), `messageId ${JSON.stringify(bad)}`);
      await invalid(client.sendMessage({ to: "gravity2", text: "t", messageId: "ok-id", requestId: bad }), `requestId ${JSON.stringify(bad)}`);
      await invalid(client.sendMessage({ to: "gravity2", text: "t", messageId: "ok-id", inReplyTo: bad }), `inReplyTo ${JSON.stringify(bad)}`);
      await invalid(client.sendMessage({ to: bad, text: "t", messageId: "ok-id" }), `to ${JSON.stringify(bad)}`);
      await invalid(client.getMessageStatus({ messageId: bad }), `status ${JSON.stringify(bad)}`);
      await invalid(client.consumeReply({ messageId: bad }), `consume ${JSON.stringify(bad)}`);
      await invalid(client.listReplies({ requestId: bad }), `list requestId ${JSON.stringify(bad)}`);
      await invalid(client.listReplies({ inReplyTo: bad }), `list inReplyTo ${JSON.stringify(bad)}`);
    }
    for (const notAString of [5, true, {}, ["a"]]) {
      await invalid(client.sendMessage({ to: "gravity2", text: "t", messageId: notAString }), `messageId ${JSON.stringify(notAString)}`);
    }
    assert.equal(await env.journal.getRecord("ok-id"), null, "nothing malformed was admitted");

    // UUIDs, rep-<uuid> reply IDs, 64-hex instance IDs and dotted/colon/underscore IDs all still work.
    const uuid = crypto.randomUUID();
    for (const messageId of [uuid, `rep-${uuid}`, "msg.v1:alpha_beta-1", "a".repeat(256)]) {
      assert.equal((await client.sendMessage({ to: "gravity2", text: "t", messageId, requestId: uuid })).accepted, true, messageId);
    }
    assert.equal((await client.sendMessage({ to: instanceId, text: "t", messageId: "to-instance" })).accepted, true);
    assert.equal((await client.getMessageStatus({ messageId: uuid })).messageId, uuid);
    assert.deepEqual(await client.listReplies({ requestId: uuid, inReplyTo: null }), []);
    await client.close();
  } finally {
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("the server decides with the signed claims' sender, not the client's senderId string", { skip: process.platform === "win32" }, async () => {
  const env = setupEnvironment();
  const server = createLocalControlServer({
    socketPath: env.socketPath, journal: env.journal, acl: env.acl, credentialValidator: env.validator,
    rateLimiter: env.rateLimiter, loopTracker: env.loopTracker, dispatcher: env.dispatcher,
  });
  try {
    await server.start();
    // The signed token is for "desktop-codex"; the caller pads the claimed sender with whitespace.
    const client = createLocalControlClient({
      socketPath: env.socketPath,
      turnCredential: env.issuer.issue({ senderId: "desktop-codex" }),
      senderId: "  desktop-codex  ",
    });
    assert.deepEqual(await client.discoverRecipients(), ["gravity2"], "ACL lookups use the signed sender");
    const receipt = await client.sendMessage({ to: "gravity2", text: "padded sender", messageId: "claims-sender" });
    assert.equal(receipt.accepted, true);
    assert.equal((await env.journal.getRecord("claims-sender")).sender, "desktop-codex", "the journal records the signed sender");
    assert.equal((await client.getMessageStatus({ messageId: "claims-sender" })).phase !== undefined, true, "ownership uses the signed sender");
    await env.journal.recordReply({ sender: "gravity2", recipient: "desktop-codex", messageId: "claims-reply", requestId: receipt.requestId, inReplyTo: "claims-sender", text: "ok" });
    assert.deepEqual((await client.listReplies({})).map((reply) => reply.messageId), ["claims-reply"]);
    assert.equal((await client.consumeReply({ messageId: "claims-reply" })).consumed, true);
    await client.close();

    // A genuinely different sender is still refused.
    const impostor = createLocalControlClient({ socketPath: env.socketPath, turnCredential: env.issuer.issue({ senderId: "desktop-codex" }), senderId: "gravity2" });
    await assert.rejects(impostor.discoverRecipients(), (err) => err.code === "unauthorized");
    await impostor.close();
  } finally {
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("the dispatcher contract is exactly start, stop and notifyAdmission", () => {
  const env = setupEnvironment();
  try {
    const hooks = { start: async () => {}, stop: async () => {}, notifyAdmission: async () => {} };
    const build = (dispatcher) => () => createLocalControlServer({ socketPath: env.socketPath, journal: env.journal, acl: env.acl, credentialValidator: env.validator, dispatcher });
    assert.doesNotThrow(build(hooks));
    for (const aliasOnly of [
      { recover: async () => {}, wait: async () => {}, admitExecution: async () => {} },
      { recover: async () => {}, wait: async () => {}, dispatch: async () => {} },
      { start: async () => {}, wait: async () => {}, notifyAdmission: async () => {} },
      { recover: async () => {}, stop: async () => {}, notifyAdmission: async () => {} },
      { start: async () => {}, stop: async () => {}, admitExecution: async () => {} },
      { start: async () => {}, stop: async () => {}, dispatch: async () => {} },
    ]) {
      assert.throws(build(aliasOnly), (err) => err instanceof LocalMessagingError && err.code === "invalid_dispatcher", JSON.stringify(Object.keys(aliasOnly)));
    }
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("sendMessage forwards exactly its documented fields (no dead loopCount)", async () => {
  const realTmp = fs.realpathSync(os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(realTmp, "triangle-client-fields-"));
  fs.chmodSync(tmpDir, 0o700);
  const socketPath = path.join(tmpDir, "fields.sock");
  let seen;
  const fake = net.createServer((socket) => {
    const parser = createMessageParser({
      onMessage: (message) => {
        seen = message.params;
        socket.write(encodeFrame(createSuccessResponse(message.id, { accepted: true })));
      },
    });
    socket.on("data", (chunk) => parser.feed(chunk));
  });
  await new Promise((resolve) => fake.listen(socketPath, resolve));
  const client = createLocalControlClient({ socketPath, turnCredential: "t", senderId: "desktop-codex" });
  try {
    await client.sendMessage({ to: "gravity2", text: "hi", messageId: "m", requestId: "r", loopCount: 3 });
    assert.deepEqual(Object.keys(seen).sort(), ["inReplyTo", "messageId", "metadata", "requestId", "text", "to"]);
  } finally {
    await client.close();
    await new Promise((resolve) => fake.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("readable directory preserves ACL and capability scope without changing legacy discovery", async () => {
  const env = setupEnvironment();
  const server = createLocalControlServer({
    ...env,
    credentialValidator: env.validator,
    recipientDirectory: [
      { id: "gravity2", label: "Antigravity worker", kind: "worker" },
      { id: "eve", label: "Hidden conversation", kind: "conversation" },
    ],
  });
  let client;
  try {
    await server.start();
    client = createLocalControlClient({
      socketPath: env.socketPath, senderId: "desktop-codex",
      turnCredential: env.issuer.issue({ senderId: "desktop-codex" }),
    });
    const rows=await client.listSessions();
    assert.deepEqual(rows.map(({delivery,...legacy})=>legacy), [
      { id: "gravity2", label: "Antigravity worker", kind: "worker", presence: "unknown" },
    ]);
    assert.equal(rows[0].delivery.state,'availability_unknown');
    assert.deepEqual(await client.discoverRecipients(), ["gravity2"]);
    const restricted = env.issuer.issue({ senderId: "desktop-codex", allowedRecipients: [] });
    assert.deepEqual(await client.listSessions({ credential: restricted }), []);
    await assert.rejects(client.listSessions({ credential: "invalid" }));
  } finally {
    await client?.close();
    await server.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test("directory rejects ambiguous or unbounded owner metadata before serving", () => {
  const env = setupEnvironment();
  try {
    for (const recipientDirectory of [null, {}, [{ id: "gravity2", label: "bad\nlabel", kind: "worker" }],
      [{ id: "gravity2", label: "x".repeat(129), kind: "worker" }],
      [{ id: "gravity2", label: "one", kind: "worker" }, { id: "gravity2", label: "two", kind: "conversation" }]]) {
      assert.throws(() => createLocalControlServer({ ...env, credentialValidator: env.validator, recipientDirectory }));
    }
  } finally { fs.rmSync(env.tmpDir, { recursive: true, force: true }); }
});
