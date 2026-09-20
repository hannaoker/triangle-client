/**
 * Execution state machine helpers for the headless Codex runtime.
 *
 * Phase 1 uses these transitions in-memory for the shadow single-slot path.
 * Durable lease/epoch recovery lands in Phase 2.
 */

export const EXECUTION_STATES = Object.freeze([
  "idle",
  "admitted",
  "running",
  "result_ready",
  "reply_persisted",
  "acked",
]);

const TRANSITIONS = Object.freeze({
  idle: Object.freeze(["admitted"]),
  admitted: Object.freeze(["running", "idle"]),
  running: Object.freeze(["result_ready", "idle"]),
  result_ready: Object.freeze(["reply_persisted", "idle"]),
  reply_persisted: Object.freeze(["acked", "idle"]),
  acked: Object.freeze(["idle"]),
});

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export function assertExecutionState(state) {
  if (typeof state !== "string" || !EXECUTION_STATES.includes(state)) {
    throw createCodedError("execution_state_invalid", `unknown execution state ${state}`);
  }
  return state;
}

export function canTransitionExecutionState(from, to) {
  const current = assertExecutionState(from);
  const next = assertExecutionState(to);
  return TRANSITIONS[current].includes(next);
}

export function transitionExecutionState(from, to) {
  if (!canTransitionExecutionState(from, to)) {
    throw createCodedError(
      "execution_state_transition_rejected",
      `cannot transition execution state ${from} -> ${to}`,
      { from, to },
    );
  }
  return to;
}

/**
 * Settlement sequence for reply-required work: reply must persist before ack.
 * Returns the ordered stage names for assertions / logging (identifiers only).
 */
export function replyBeforeAckStages() {
  return Object.freeze(["result_ready", "reply_persisted", "acked"]);
}

export function createExecutionRecord(seed = {}) {
  return {
    executionState: assertExecutionState(seed.executionState ?? "idle"),
    activeDeliveryId: seed.activeDeliveryId ?? null,
    executionEpoch: Number.isSafeInteger(seed.executionEpoch) ? seed.executionEpoch : 0,
    codexThreadId: typeof seed.codexThreadId === "string" ? seed.codexThreadId : null,
    lastWorkerSlotId: typeof seed.lastWorkerSlotId === "string" ? seed.lastWorkerSlotId : null,
    lastReplyEventId: typeof seed.lastReplyEventId === "string" ? seed.lastReplyEventId : null,
    lastCompletedDeliveryId:
      typeof seed.lastCompletedDeliveryId === "string" ? seed.lastCompletedDeliveryId : null,
  };
}
