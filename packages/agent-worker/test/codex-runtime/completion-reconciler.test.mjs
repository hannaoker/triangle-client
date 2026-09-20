import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCompletionIdempotencyKey,
  recordOrReplayCompletion,
  reconcileConversationAfterRestart,
  reconcileProfileAfterRestart,
} from "../../src/codex-runtime/completion-reconciler.mjs";
import { createDurableConversationStore } from "../../src/codex-runtime/durable-conversation-store.mjs";
import { createDurableConversationRegistry } from "../../src/codex-runtime/conversation-registry.mjs";
import {
  matchesCancellationScope,
  shouldAcceptExecutionEpochEvent,
} from "../../src/codex-runtime/execution-state.mjs";

const PROFILE = "a".repeat(64);
const ROOM = `room_${"b".repeat(32)}`;
const REPLY = `event_${"d".repeat(32)}`;

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "triangle-reconcile-"));
}

test("stale execution epoch events are rejected", () => {
  assert.equal(
    shouldAcceptExecutionEpochEvent({ conversationEpoch: 2, eventEpoch: 2 }),
    true,
  );
  assert.equal(
    shouldAcceptExecutionEpochEvent({ conversationEpoch: 2, eventEpoch: 1 }),
    false,
  );
  assert.equal(
    shouldAcceptExecutionEpochEvent({ conversationEpoch: 0, eventEpoch: 1 }),
    false,
  );
});

test("cancellation scope requires matching delivery + epoch", () => {
  const record = {
    activeDeliveryId: "delivery_9",
    executionEpoch: 4,
  };
  assert.equal(
    matchesCancellationScope(record, { deliveryId: "delivery_9", executionEpoch: 4 }),
    true,
  );
  assert.equal(
    matchesCancellationScope(record, { deliveryId: "delivery_9", executionEpoch: 3 }),
    false,
  );
  assert.equal(
    matchesCancellationScope(record, { deliveryId: "delivery_8", executionEpoch: 4 }),
    false,
  );
});

test("completion record replays matching duplicate and rejects conflicts", () => {
  const root = tempRoot();
  try {
    const store = createDurableConversationStore({ root, enabled: true });
    const key = buildCompletionIdempotencyKey({
      profileInstanceId: PROFILE,
      roomId: ROOM,
      deliveryId: "delivery_3",
      executionEpoch: 2,
    });
    const first = recordOrReplayCompletion(store, {
      profile_instance_id: PROFILE,
      mesh_room_id: ROOM,
      idempotency_id: key,
      delivery_id: 3,
      reply_event_id: REPLY,
    });
    assert.equal(first.applied, true);

    const replay = recordOrReplayCompletion(store, {
      profile_instance_id: PROFILE,
      mesh_room_id: ROOM,
      idempotency_id: key,
      delivery_id: 3,
      reply_event_id: REPLY,
    });
    assert.equal(replay.applied, false);
    assert.equal(replay.completion.reply_event_id, REPLY);

    assert.throws(
      () =>
        recordOrReplayCompletion(store, {
          profile_instance_id: PROFILE,
          mesh_room_id: ROOM,
          idempotency_id: key,
          delivery_id: 3,
          reply_event_id: `event_${"e".repeat(32)}`,
        }),
      (error) => error.code === "completion_conflict",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovery: reply_persisted acks without duplicate MESH reply", async () => {
  const root = tempRoot();
  const proxyCalls = [];
  try {
    const store = createDurableConversationStore({ root, enabled: true });
    const registry = createDurableConversationRegistry({
      store,
      profileInstanceId: PROFILE,
    });
    registry.setThread(PROFILE, ROOM, "thread-r1", { workerSlotId: "slot-1" });
    registry.upsert(PROFILE, ROOM, {
      executionState: "admitted",
      activeDeliveryId: "delivery_5",
      executionEpoch: 5,
    });
    registry.upsert(PROFILE, ROOM, { executionState: "running" });
    registry.upsert(PROFILE, ROOM, { executionState: "result_ready" });
    registry.upsert(PROFILE, ROOM, {
      executionState: "reply_persisted",
      lastReplyEventId: REPLY,
    });

    const proxy = {
      async reply() {
        proxyCalls.push("reply");
        throw new Error("must not reply again");
      },
      async ack(args) {
        proxyCalls.push({ op: "ack", ...args });
        return { acknowledged: true };
      },
    };

    const result = await reconcileConversationAfterRestart({
      registry,
      store,
      transactionProxy: proxy,
      profileInstanceId: PROFILE,
      roomId: ROOM,
      logger: { info() {} },
    });

    assert.equal(result.status, "reconciled_ack");
    assert.equal(result.meshReplyPosted, false);
    assert.equal(result.duplicateReply, false);
    assert.deepEqual(
      proxyCalls.map((call) => (typeof call === "string" ? call : call.op)),
      ["ack"],
    );
    assert.equal(registry.get(PROFILE, ROOM).executionState, "idle");
    assert.equal(registry.get(PROFILE, ROOM).lastCompletedDeliveryId, "delivery_5");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovery: running delivery is quarantined (no reply)", async () => {
  const root = tempRoot();
  try {
    const store = createDurableConversationStore({ root, enabled: true });
    const registry = createDurableConversationRegistry({
      store,
      profileInstanceId: PROFILE,
    });
    registry.setThread(PROFILE, ROOM, "thread-q", { workerSlotId: "slot-1" });
    registry.upsert(PROFILE, ROOM, {
      executionState: "admitted",
      activeDeliveryId: "delivery_6",
      executionEpoch: 2,
    });
    registry.upsert(PROFILE, ROOM, { executionState: "running" });

    const report = await reconcileProfileAfterRestart({
      registry,
      store,
      profileInstanceId: PROFILE,
      transactionProxy: {
        async reply() {
          throw new Error("no reply");
        },
        async ack() {
          throw new Error("no ack");
        },
      },
      logger: { info() {} },
    });
    assert.equal(report.quarantined, 1);
    assert.equal(report.results[0].status, "quarantined");
    assert.equal(report.results[0].meshReplyPosted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
