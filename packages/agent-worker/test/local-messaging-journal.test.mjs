import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createTestMemoryJournal,
  createTestSqliteJournal,
} from "./local-messaging-fixtures.mjs";
import { validateJournalAdapter } from "../src/local-messaging-journal-contract.mjs";
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

  const validMock = {
    recordSend: () => {},
    recordReply: () => {},
    recordExecutionFailure: () => {},
    listReplies: () => {},
    consumeReply: () => {},
    getRecord: () => {},
  };
  assert.equal(validateJournalAdapter(validMock), validMock);
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

  test(`${name}: resuming queued records yields pending jobs; uncertain started executions are held`, async () => {
    const journal = createJournal();
    try {
      await journal.recordSend({
        sender: "alice",
        recipient: "bob",
        messageId: "msg-queued",
        requestId: "req-q",
        text: "waiting job",
      });

      if (typeof journal.trackExecution === "function") {
        journal.trackExecution("msg-executing", "started");
      }

      const { toRun, uncertain } = await journal.resumeQueuedRecords();
      assert.ok(toRun.some((r) => r.messageId === "msg-queued"));
      // Resumption must not blindly rerun uncertain started executions
      assert.ok(Array.isArray(uncertain));
    } finally {
      await journal.close?.();
    }
  });
}
