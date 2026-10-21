import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import {
  createPerSenderRateLimiter,
  createConversationLoopTracker,
} from "../src/local-messaging-rate-limiter.mjs";
import { createTestMemoryJournal } from "./local-messaging-fixtures.mjs";
import { LocalMessagingError } from "../src/local-messaging-errors.mjs";

test("owner ACL filters recipient discovery and validates targets", () => {
  const acl = createOwnerAcl({
    rules: {
      "desktop-codex": ["gravity2", "reviewer-bob"],
      "gravity2": ["desktop-codex"],
      "rogue-agent": [],
    },
  });

  assert.deepEqual(acl.listAuthorizedRecipients("desktop-codex"), ["gravity2", "reviewer-bob"]);
  assert.deepEqual(acl.listAuthorizedRecipients("gravity2"), ["desktop-codex"]);
  assert.deepEqual(acl.listAuthorizedRecipients("rogue-agent"), []);
  assert.deepEqual(acl.listAuthorizedRecipients("unknown-agent"), []);

  assert.equal(acl.isAllowed("desktop-codex", "gravity2"), true);
  assert.equal(acl.isAllowed("desktop-codex", "unauthorized-target"), false);
  assert.throws(
    () => acl.checkAllowed("desktop-codex", "unauthorized-target"),
    (err) => err instanceof LocalMessagingError && err.code === "recipient_not_allowed",
  );
});

test("rate limiter enforces per-sender limit and tracks quota only after admission", () => {
  const limiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 2, windowMs: 1000 });

  // Checking quota does not consume it
  assert.equal(limiter.check("agent-alice"), true);
  assert.equal(limiter.check("agent-alice"), true);

  // Consume 1
  limiter.consume("agent-alice");
  assert.equal(limiter.check("agent-alice"), true);

  // Consume 2
  limiter.consume("agent-alice");

  // Now 3rd attempt is rejected
  assert.throws(
    () => limiter.check("agent-alice"),
    (err) => err instanceof LocalMessagingError && err.code === "rate_limit_exceeded",
  );

  // Independent sender should succeed
  assert.equal(limiter.check("agent-bob"), true);
});

test("conversation loop tracker supports 8-hop alternating chain with distinct UUIDs and prevents caller reset", async () => {
  const journal = createTestMemoryJournal();
  const tracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });

  let prevMessageId = null;
  const agents = ["agent-A", "agent-B"];

  // Run 8-hop alternating conversation chain
  for (let hop = 1; hop <= 8; hop++) {
    const sender = agents[(hop - 1) % 2];
    const recipient = agents[hop % 2];
    const messageId = crypto.randomUUID();
    const requestId = crypto.randomUUID();

    // Supervisor child turn context carries restricted claims
    const claims = {
      senderId: sender,
      loopDepth: hop,
      parentMessageId: prevMessageId,
      maxLoopDepth: 10,
    };

    const depth = await tracker.calculateDepth({
      claims,
      inReplyTo: prevMessageId,
      messageId,
      requestId,
    });

    assert.equal(depth, hop, `Hop ${hop} must have depth ${hop}, but got ${depth}`);

    // Commit to journal and tracker
    await journal.recordSend({
      sender,
      recipient,
      messageId,
      requestId,
      inReplyTo: prevMessageId,
      text: `Hop ${hop} text`,
      metadata: { _loopDepth: depth },
    });

    tracker.commitAdmission({ messageId, requestId, depth, isDuplicate: false });
    prevMessageId = messageId;
  }

  // Duplicate retry must not advance depth
  tracker.commitAdmission({ messageId: prevMessageId, requestId: "retry-req", depth: 8, isDuplicate: true });
  assert.equal(tracker.getDepth(prevMessageId), 8);

  // Caller reset attempt: caller attempts to reset ancestry by claiming loopDepth 1 or omitting inReplyTo
  // but supervisor-issued child turn context has loopDepth 9
  const resetClaims = {
    senderId: "agent-A",
    loopDepth: 9,
    parentMessageId: prevMessageId,
    maxLoopDepth: 10,
  };

  const depthWithResetAttempt = await tracker.calculateDepth({
    claims: resetClaims,
    inReplyTo: null, // caller tried omitting inReplyTo
    messageId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
  });
  // Must bind to supervisor turn claims (depth 9), caller cannot reset to 1
  assert.equal(depthWithResetAttempt, 9);

  // 11th hop exceeds maxLoopDepth (10)
  const excessiveClaims = {
    senderId: "agent-B",
    loopDepth: 11,
    parentMessageId: prevMessageId,
    maxLoopDepth: 10,
  };
  await assert.rejects(
    async () => tracker.calculateDepth({
      claims: excessiveClaims,
      inReplyTo: prevMessageId,
      messageId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
    }),
    (err) => err instanceof LocalMessagingError && err.code === "loop_limit_exceeded",
  );

  // Fail closed for missing parent
  await assert.rejects(
    async () => tracker.calculateDepth({
      inReplyTo: "non-existent-parent-uuid",
      messageId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
    }),
    (err) => err instanceof LocalMessagingError && err.code === "parent_not_found",
  );
});

test("conversation loop tracker reconstructs depth across restarts from journal", async () => {
  const journal = createTestMemoryJournal();
  const messageId = "msg-root-1";
  const requestId = "req-root-1";

  // Simulate stored message in journal
  await journal.recordSend({
    sender: "agent-A",
    recipient: "agent-B",
    messageId,
    requestId,
    text: "root msg",
    metadata: { _loopDepth: 1 },
  });

  // Create a brand new loop tracker (simulating restart) with the same journal
  const restartedTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });

  // Replying to messageId should find parent in journal and increment depth to 2
  const nextDepth = await restartedTracker.calculateDepth({
    inReplyTo: messageId,
    messageId: "msg-child-1",
    requestId: "req-child-1",
  });
  assert.equal(nextDepth, 2);
});

test("conversation loop tracker always honors parent regardless loopDepth and fails unknown parent (no untrusted reset)", async () => {
  const journal = createTestMemoryJournal();
  const parentId = "parent-msg-depth-3";
  const parentRequestId = "parent-req-3";

  // Parent stored at depth 3
  await journal.recordSend({
    sender: "agent-A",
    recipient: "agent-B",
    messageId: parentId,
    requestId: parentRequestId,
    text: "depth 3 message",
    metadata: { _loopDepth: 3 },
  });

  const tracker = createConversationLoopTracker({ maxLoopDepth: 3, journal });

  // Caller attempts untrusted reset: signed claims has parentMessageId pointing to depth 3,
  // but caller claims loopDepth 1 and omits inReplyTo with a brand new requestId
  const claimsWithDepth1 = {
    senderId: "agent-B",
    parentMessageId: parentId,
    loopDepth: 1,
    maxLoopDepth: 3,
  };

  await assert.rejects(
    async () => tracker.calculateDepth({
      claims: claimsWithDepth1,
      inReplyTo: null, // omitted inReplyTo
      messageId: "child-msg-reset-attempt",
      requestId: "new-request-uuid-attempt",
    }),
    (err) => err instanceof LocalMessagingError && err.code === "loop_limit_exceeded",
  );

  // Unknown parent fails closed regardless of loopDepth
  const claimsWithUnknownParent = {
    senderId: "agent-B",
    parentMessageId: "completely-unknown-parent-id",
    loopDepth: 1,
    maxLoopDepth: 3,
  };

  await assert.rejects(
    async () => tracker.calculateDepth({
      claims: claimsWithUnknownParent,
      inReplyTo: null,
      messageId: "child-msg-unknown-parent",
      requestId: "new-req-unknown",
    }),
    (err) => err instanceof LocalMessagingError && err.code === "parent_not_found",
  );
});

test("rate limiter reserve supports atomic reservation, rollback, and commit", () => {
  const limiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 1, windowMs: 10000 });

  // First reservation succeeds
  const res1 = limiter.reserve("agent-alice");
  assert.ok(res1);

  // Immediate second reservation is rejected synchronously
  assert.throws(
    () => limiter.reserve("agent-alice"),
    (err) => err instanceof LocalMessagingError && err.code === "rate_limit_exceeded",
  );

  // Rollback releases the reserved quota
  res1.rollback();

  // Now reservation succeeds again
  const res2 = limiter.reserve("agent-alice");
  assert.ok(res2);

  // Commit keeps quota consumed
  res2.commit();

  // Subsequent reservation still rejected
  assert.throws(
    () => limiter.reserve("agent-alice"),
    (err) => err instanceof LocalMessagingError && err.code === "rate_limit_exceeded",
  );
});
