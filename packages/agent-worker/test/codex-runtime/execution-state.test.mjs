import assert from "node:assert/strict";
import test from "node:test";

import {
  canTransitionExecutionState,
  createExecutionRecord,
  replyBeforeAckStages,
  transitionExecutionState,
} from "../../src/codex-runtime/execution-state.mjs";
import { createMemoryConversationRegistry } from "../../src/codex-runtime/conversation-registry.mjs";

const PROFILE = "a".repeat(64);
const ROOM = `room_${"b".repeat(32)}`;

test("execution state enforces reply-before-ack transitions", () => {
  assert.equal(canTransitionExecutionState("result_ready", "reply_persisted"), true);
  assert.equal(canTransitionExecutionState("result_ready", "acked"), false);
  assert.equal(canTransitionExecutionState("reply_persisted", "acked"), true);
  assert.deepEqual(replyBeforeAckStages(), ["result_ready", "reply_persisted", "acked"]);

  let state = "idle";
  state = transitionExecutionState(state, "admitted");
  state = transitionExecutionState(state, "running");
  state = transitionExecutionState(state, "result_ready");
  state = transitionExecutionState(state, "reply_persisted");
  state = transitionExecutionState(state, "acked");
  assert.equal(state, "acked");
  assert.throws(
    () => transitionExecutionState("running", "acked"),
    (error) => error.code === "execution_state_transition_rejected",
  );
});

test("memory conversation registry maps room to thread without secrets", () => {
  const registry = createMemoryConversationRegistry();
  const record = registry.setThread(PROFILE, ROOM, "thread-abc", { workerSlotId: "slot-1" });
  assert.equal(record.codexThreadId, "thread-abc");
  assert.equal(record.executionState, "idle");
  assert.equal(registry.get(PROFILE, ROOM).lastWorkerSlotId, "slot-1");

  registry.upsert(PROFILE, ROOM, {
    executionState: "admitted",
    activeDeliveryId: "delivery_1",
    executionEpoch: 1,
  });
  assert.equal(registry.get(PROFILE, ROOM).executionEpoch, 1);
  assert.doesNotMatch(JSON.stringify(registry.list()), /mesh_/);
  assert.equal(createExecutionRecord().executionState, "idle");
});
