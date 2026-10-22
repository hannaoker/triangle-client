import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import {
  createPerSenderRateLimiter,
  createPairExchangeLimiter,
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

test("pair exchange limiter counts both directions of a pair in a sliding window and ignores rolled-back reservations", async () => {
  const limiter = createPairExchangeLimiter({ maxExchanges: 3, windowMs: 60 });
  limiter.reserve("agent-a", "agent-b").commit();
  limiter.reserve("agent-b", "agent-a").commit(); // the reverse direction shares the budget
  const third = limiter.reserve("agent-a", "agent-b");
  assert.throws(
    () => limiter.reserve("agent-b", "agent-a"),
    (err) => err instanceof LocalMessagingError && err.code === "exchange_limit_exceeded",
  );
  third.rollback(); // a duplicate retry or rejected admission is not an exchange
  limiter.reserve("agent-b", "agent-a").commit();
  assert.throws(() => limiter.reserve("agent-a", "agent-b"), (err) => err.code === "exchange_limit_exceeded");
  // Other pairs are independent, including a ring that never repeats a pair.
  limiter.reserve("agent-a", "agent-c").commit();
  limiter.reserve("agent-b", "agent-c").commit();
  // The window slides: once the old exchanges age out the pair may talk again.
  await new Promise((resolve) => setTimeout(resolve, 80));
  limiter.reserve("agent-a", "agent-b").commit();
  assert.throws(() => limiter.reserve("", "agent-b"), (err) => err.code === "invalid_sender");
  assert.throws(() => createPairExchangeLimiter({ maxExchanges: 0 }), (err) => err.code === "invalid_limiter_options");
});

test("loop tracker memory is a bounded LRU that falls back to the durable journal", async () => {
  const journal = createTestMemoryJournal();
  const lookups = [];
  const getRecord = journal.getRecord.bind(journal);
  journal.getRecord = async (id) => { lookups.push(id); return getRecord(id); };
  const tracker = createConversationLoopTracker({ maxLoopDepth: 50, journal, maxTrackedMessages: 3 });
  for (let depth = 1; depth <= 6; depth++) {
    await journal.recordSend({ sender: "agent-a", recipient: "agent-b", messageId: `m-${depth}`, requestId: `r-${depth}`, text: "t", metadata: { _loopDepth: depth } });
    tracker.commitAdmission({ messageId: `m-${depth}`, requestId: `r-${depth}`, depth });
  }
  // Memory holds only the three most recent entries.
  assert.equal(tracker.getDepth("m-6"), 6);
  assert.equal(tracker.getDepth("m-4"), 4);
  assert.equal(tracker.getDepth("m-1"), 1, "an evicted entry is no longer held in memory (default depth)");
  assert.equal(tracker.getDepth("r-2"), 1);
  // Recent parents resolve from memory; evicted ones resolve from the journal with the true depth.
  assert.equal(await tracker.resolveParentDepth("m-6"), 6);
  assert.deepEqual(lookups, []);
  assert.equal(await tracker.resolveParentDepth("m-2"), 2);
  assert.deepEqual(lookups, ["m-2"]);
  assert.equal(await tracker.calculateDepth({ inReplyTo: "m-1", messageId: "m-7", requestId: "r-7" }), 2, "ancestry survives eviction");
  // Reading an entry keeps it recent: the least recently used one is evicted.
  const recency = createConversationLoopTracker({ maxLoopDepth: 50, maxTrackedMessages: 2 });
  recency.commitAdmission({ messageId: "x1", depth: 5 });
  recency.commitAdmission({ messageId: "x2", depth: 6 });
  recency.getDepth("x1");
  recency.commitAdmission({ messageId: "x3", depth: 7 });
  assert.equal(recency.getDepth("x1"), 5);
  assert.equal(recency.getDepth("x2"), 1, "the least recently used entry was evicted");
  assert.equal(recency.getDepth("x3"), 7);
  assert.throws(() => createConversationLoopTracker({ maxTrackedMessages: 0 }), (err) => err.code === "invalid_tracker_options");
});
