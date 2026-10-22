import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createTestMemoryJournal,
  createTestSqliteJournal,
} from "./local-messaging-fixtures.mjs";
import { validateJournalAdapter, REQUIRED_JOURNAL_METHODS } from "../src/local-messaging-journal-contract.mjs";
import { LocalMessagingError } from "../src/local-messaging-errors.mjs";

test("validateJournalAdapter validates explicit contract and rejects incomplete adapters", () => {
  assert.throws(
    () => validateJournalAdapter(null),
    (err) => err instanceof LocalMessagingError && err.code === "invalid_journal_adapter",
  );

  assert.throws(
    () => validateJournalAdapter({ recordSend: () => {} }),
    (err) => err instanceof LocalMessagingError && err.code === "invalid_journal_adapter",
  );

  const validMock = Object.fromEntries(REQUIRED_JOURNAL_METHODS.map((method) => [method, () => {}]));
  assert.equal(validateJournalAdapter(validMock), validMock);
});

test("the journal contract requires the execution transitions the server and dispatcher rely on", () => {
  for (const method of ["claimExecution", "completeExecution", "holdExecution", "recoverQueued"]) {
    assert.ok(REQUIRED_JOURNAL_METHODS.includes(method), `${method} is part of the contract`);
    const incomplete = Object.fromEntries(REQUIRED_JOURNAL_METHODS.filter((name) => name !== method).map((name) => [name, () => {}]));
    assert.throws(
      () => validateJournalAdapter(incomplete),
      (err) => err instanceof LocalMessagingError && err.code === "invalid_journal_adapter" && err.message.includes(method),
    );
  }
  // A journal that only records and lists (the old six methods) is no longer a valid adapter.
  const sixMethods = Object.fromEntries(["recordSend", "recordReply", "recordExecutionFailure", "listReplies", "consumeReply", "getRecord"].map((name) => [name, () => {}]));
  assert.throws(() => validateJournalAdapter(sixMethods), (err) => err.code === "invalid_journal_adapter");
});

for (const [name, createJournal] of [
  ["MemoryJournal", () => createTestMemoryJournal()],
  ["SqliteJournal", () => {
    const realTmp = fs.realpathSync(os.tmpdir());
    const tmp = fs.mkdtempSync(path.join(realTmp, "triangle-journal-test-"));
    const dbPath = path.join(tmp, "local-messages.sqlite");
    return createTestSqliteJournal({ dbPath });
  }],
]) {
  test(`${name}: records send with complete immutable envelope comparison and deterministic metadata`, async () => {
    const journal = createJournal();
    try {
      const record1 = await journal.recordSend({
        sender: "alice",
        recipient: "bob",
        messageId: "msg-1",
        requestId: "req-1",
        inReplyTo: null,
        text: "hello world",
        metadata: { priority: "high", tags: ["a", "b"] },
      });

      assert.equal(record1.messageId, "msg-1");
      assert.equal(record1.requestId, "req-1");
      assert.equal(record1.phase, "queued_local");
      assert.equal(record1.isDuplicate, false);

      // Idempotent duplicate: identical envelope including metadata with different key ordering
      const recordDup = await journal.recordSend({
        sender: "alice",
        recipient: "bob",
        messageId: "msg-1",
        requestId: "req-1",
        inReplyTo: null,
        text: "hello world",
        metadata: { tags: ["a", "b"], priority: "high" }, // different key order, same content
      });
      assert.equal(recordDup.messageId, "msg-1");
      assert.equal(recordDup.requestId, "req-1");
      assert.equal(recordDup.isDuplicate, true);

      // Conflict: same messageId but different requestId
      await assert.rejects(
        async () => journal.recordSend({
          sender: "alice",
          recipient: "bob",
          messageId: "msg-1",
          requestId: "req-DIFFERENT",
          inReplyTo: null,
          text: "hello world",
          metadata: { priority: "high", tags: ["a", "b"] },
        }),
        (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
      );

      // Conflict: same messageId but different text
      await assert.rejects(
        async () => journal.recordSend({
          sender: "alice",
          recipient: "bob",
          messageId: "msg-1",
          requestId: "req-1",
          inReplyTo: null,
          text: "different payload",
          metadata: { priority: "high", tags: ["a", "b"] },
        }),
        (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
      );

      // Conflict: same messageId but different metadata
      await assert.rejects(
        async () => journal.recordSend({
          sender: "alice",
          recipient: "bob",
          messageId: "msg-1",
          requestId: "req-1",
          inReplyTo: null,
          text: "hello world",
          metadata: { priority: "low" },
        }),
        (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
      );
    } finally {
      await journal.close?.();
    }
  });

  test(`${name}: reply persistence verifies original request and rejects forged recipients and correlation`, async () => {
    const journal = createJournal();
    try {
      // Alice sends request to Bob
      await journal.recordSend({
        sender: "alice",
        recipient: "bob",
        messageId: "msg-orig-1",
        requestId: "req-orig-1",
        text: "request body",
      });

      // Forged recipient: Bob replies but addresses Charlie instead of Alice
      await assert.rejects(
        async () => journal.recordReply({
          sender: "bob",
          recipient: "charlie", // Forged!
          messageId: "rep-1",
          requestId: "req-orig-1",
          inReplyTo: "msg-orig-1",
          text: "reply body",
        }),
        (err) => err instanceof LocalMessagingError && err.code === "invalid_reply_recipient",
      );

      // Wrong correlation: wrong requestId
      await assert.rejects(
        async () => journal.recordReply({
          sender: "bob",
          recipient: "alice",
          messageId: "rep-2",
          requestId: "req-WRONG",
          inReplyTo: "msg-orig-1",
          text: "reply body",
        }),
        (err) => err instanceof LocalMessagingError && err.code === "invalid_reply_correlation",
      );

      // Valid reply
      const reply = await journal.recordReply({
        sender: "bob",
        recipient: "alice",
        messageId: "rep-valid",
        requestId: "req-orig-1",
        inReplyTo: "msg-orig-1",
        text: "correct reply",
      });
      assert.equal(reply.consumed, false);

      // Duplicate reply with identical envelope
      const dupReply = await journal.recordReply({
        sender: "bob",
        recipient: "alice",
        messageId: "rep-valid",
        requestId: "req-orig-1",
        inReplyTo: "msg-orig-1",
        text: "correct reply",
      });
      assert.equal(dupReply.isDuplicate, true);

      // Duplicate reply with conflicting envelope
      await assert.rejects(
        async () => journal.recordReply({
          sender: "bob",
          recipient: "alice",
          messageId: "rep-valid",
          requestId: "req-orig-1",
          inReplyTo: "msg-orig-1",
          text: "conflicting text",
        }),
        (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
      );
    } finally {
      await journal.close?.();
    }
  });

  test(`${name}: enforces foreign reply isolation and explicit consumption`, async () => {
    const journal = createJournal();
    try {
      await journal.recordSend({
        sender: "alice",
        recipient: "bob",
        messageId: "msg-req-1",
        requestId: "req-1",
        text: "calculate 2+2",
      });

      await journal.recordReply({
        sender: "bob",
        recipient: "alice",
        messageId: "msg-rep-1",
        requestId: "req-1",
        inReplyTo: "msg-req-1",
        text: "result is 4",
      });

      // Alice can list pending replies
      const aliceReplies = await journal.listReplies({
        requester: "alice",
        requestId: "req-1",
      });
      assert.equal(aliceReplies.length, 1);
      assert.equal(aliceReplies[0].text, "result is 4");
      assert.equal(aliceReplies[0].consumed, false);

      // Listing does not consume (no consume before delivery)
      const stillPending = await journal.listReplies({
        requester: "alice",
        requestId: "req-1",
      });
      assert.equal(stillPending.length, 1);

      // Eve cannot list or consume Alice's reply
      const eveReplies = await journal.listReplies({
        requester: "eve",
        requestId: "req-1",
      });
      assert.equal(eveReplies.length, 0);

      await assert.rejects(
        async () => journal.consumeReply({
          requester: "eve",
          messageId: "msg-rep-1",
        }),
        (err) => err instanceof LocalMessagingError && err.code === "foreign_access_denied",
      );

      // Alice consumes reply
      const consumeRes = await journal.consumeReply({
        requester: "alice",
        messageId: "msg-rep-1",
      });
      assert.equal(consumeRes.consumed, true);

      const afterConsume = await journal.listReplies({
        requester: "alice",
        requestId: "req-1",
      });
      assert.equal(afterConsume.length, 0);
    } finally {
      await journal.close?.();
    }
  });

  test(`${name}: records runtime failure separately from custody receipt`, async () => {
    const journal = createJournal();
    try {
      await journal.recordSend({
        sender: "alice",
        recipient: "bob",
        messageId: "msg-2",
        requestId: "req-2",
        text: "fail please",
      });

      await journal.recordExecutionFailure({
        messageId: "msg-2",
        reason: "adapter_process_crashed",
        runtimeError: "Runner crashed",
      });

      const record = await journal.getRecord("msg-2");
      assert.equal(record.phase, "reply_failed");
      assert.equal(record.reason, "adapter_process_crashed");
      assert.equal(record.runtimeError, "Runner crashed");
    } finally {
      await journal.close?.();
    }
  });

  test(`${name}: satisfies the journal contract and moves work through claim, complete, hold and recovery`, async () => {
    const journal = createJournal();
    try {
      assert.equal(validateJournalAdapter(journal), journal);
      for (const id of ["a", "b", "c", "d"]) {
        await journal.recordSend({ sender: "alice", recipient: "bob", messageId: `msg-${id}`, requestId: `req-${id}`, text: id });
      }
      const claimed = await journal.claimExecution("msg-a");
      assert.equal(claimed.phase, "executing");
      assert.equal(await journal.claimExecution("msg-a"), null, "a claimed record cannot be claimed twice");
      await journal.completeExecution("msg-a");
      assert.equal((await journal.getRecord("msg-a")).phase, "completed");
      assert.equal(await journal.claimExecution("msg-a"), null, "completed work is never claimed again");
      await journal.holdExecution("msg-b", "operator_hold");
      const held = await journal.getRecord("msg-b");
      assert.equal(held.phase, "held");
      assert.equal(held.reason, "operator_hold");
      assert.equal(await journal.claimExecution("msg-b"), null, "held work is never claimed");
      await journal.claimExecution("msg-c"); // in flight when the process died

      const { toRun, uncertain } = await journal.recoverQueued();
      assert.deepEqual(toRun.map((r) => r.messageId), ["msg-d"], "only still-queued work is resumed");
      assert.deepEqual(uncertain.map((r) => r.messageId), ["msg-c"]);
      const recovered = await journal.getRecord("msg-c");
      assert.equal(recovered.phase, "held", "an uncertain execution is held, not replayed");
      assert.equal(recovered.reason, "crash_recovery");
      assert.deepEqual((await journal.recoverQueued()).toRun.map((r) => r.messageId), ["msg-d"]);
    } finally {
      await journal.close?.();
    }
  });
}
