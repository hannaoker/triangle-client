import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOpenTransactionRecovery,
  recoverOpenMailboxTransaction,
} from "../src/open-transaction-recovery.mjs";

const ROOM = `room_${"a".repeat(32)}`;

test("classify: before claim → none", () => {
  const result = classifyOpenTransactionRecovery({
    status: { protocol: "coordinator-delivery-v1", open: null, transactionStuck: false },
  });
  assert.equal(result.crashPoint, "before_claim");
  assert.equal(result.action, "none");
});

test("classify: after claim → resume_claimed (no new claim id)", () => {
  const result = classifyOpenTransactionRecovery({
    status: {
      protocol: "coordinator-delivery-v1",
      open: { deliveryId: 7, roomId: ROOM, state: "claimed" },
      replyRequired: true,
      transactionStuck: false,
    },
  });
  assert.equal(result.crashPoint, "after_claim");
  assert.equal(result.action, "resume_claimed");
  assert.equal(result.deliveryId, 7);
});

test("classify: receipt-only claimed → drain_receipt", () => {
  const result = classifyOpenTransactionRecovery({
    status: {
      protocol: "coordinator-delivery-v1",
      open: { deliveryId: 8, roomId: ROOM, state: "claimed" },
      replyRequired: false,
      transactionStuck: false,
    },
  });
  assert.equal(result.action, "drain_receipt");
});

test("classify: after reply → ack_replied", () => {
  const result = classifyOpenTransactionRecovery({
    status: {
      protocol: "coordinator-delivery-v1",
      open: {
        deliveryId: 9,
        roomId: ROOM,
        state: "replied",
        replyEventId: `event_${"b".repeat(32)}`,
      },
      transactionStuck: false,
    },
  });
  assert.equal(result.crashPoint, "after_reply");
  assert.equal(result.action, "ack_replied");
});

test("classify: stuck / protocol mismatch / unknown → quarantine", () => {
  assert.equal(
    classifyOpenTransactionRecovery({
      status: { protocol: "coordinator-delivery-v1", open: null, transactionStuck: true },
    }).action,
    "quarantine",
  );
  assert.equal(
    classifyOpenTransactionRecovery({
      status: {
        protocol: "self-serve-drain",
        open: { deliveryId: 1, state: "claimed" },
      },
      expectedProtocol: "coordinator-delivery-v1",
    }).reason,
    "protocol_ownership_mismatch",
  );
  assert.equal(
    classifyOpenTransactionRecovery({
      status: {
        protocol: "coordinator-delivery-v1",
        open: { deliveryId: 1, state: "weird" },
      },
    }).action,
    "quarantine",
  );
});

test("recover: ack replied open without posting another reply", async () => {
  const calls = [];
  const report = await recoverOpenMailboxTransaction({
    expectedProtocol: "coordinator-delivery-v1",
    logger: { info() {} },
    transactionProxy: {
      protocol: "coordinator-delivery-v1",
      async status() {
        return {
          protocol: "coordinator-delivery-v1",
          open: { deliveryId: 11, roomId: ROOM, state: "replied" },
          transactionStuck: false,
        };
      },
      async ack(args) {
        calls.push(["ack", args]);
        return { acknowledged: true };
      },
      async reply() {
        calls.push(["reply"]);
        throw new Error("must not reply");
      },
      async claimNext() {
        calls.push(["claimNext"]);
        throw new Error("must not claim");
      },
    },
  });
  assert.equal(report.reconciledAck, 1);
  assert.equal(report.quarantined, 0);
  assert.deepEqual(calls.map((c) => c[0]), ["ack"]);
  assert.equal(calls[0][1]?.resumeOnly, true);
});

test("recover: claimed open marks resumePending without reclaim", async () => {
  const calls = [];
  const report = await recoverOpenMailboxTransaction({
    logger: { info() {} },
    transactionProxy: {
      async status() {
        return {
          protocol: "coordinator-delivery-v1",
          open: { deliveryId: 12, roomId: ROOM, state: "claimed" },
          replyRequired: true,
        };
      },
      async claim() {
        calls.push("claim");
      },
      async claimNext() {
        calls.push("claimNext");
      },
    },
  });
  assert.equal(report.resumePending, 1);
  assert.equal(report.quarantined, 0);
  assert.deepEqual(calls, []);
});

test("recover: protocol ownership mismatch quarantines visibly", async () => {
  const report = await recoverOpenMailboxTransaction({
    logger: { info() {} },
    transactionProxy: {
      async status() {
        const error = new Error("protocol_mismatch");
        error.code = "protocol_mismatch";
        throw error;
      },
    },
  });
  assert.equal(report.quarantined, 1);
  assert.equal(report.reason, "protocol_ownership_mismatch");
});

test("recover: drain_receipt settles receipt-only claimed open", async () => {
  const calls = [];
  const report = await recoverOpenMailboxTransaction({
    logger: { info() {} },
    transactionProxy: {
      async status() {
        return {
          protocol: "coordinator-delivery-v1",
          open: { deliveryId: 13, roomId: ROOM, state: "claimed" },
          replyRequired: false,
        };
      },
      async drainReceipts() {
        calls.push("drainReceipts");
        return { open: null };
      },
    },
  });
  assert.equal(report.receiptDrained, 1);
  assert.deepEqual(calls, ["drainReceipts"]);
});
