/**
 * Execution state machine helpers for the headless Codex runtime.
 *
 * Phase 1 uses these transitions in-memory for the shadow single-slot path.
 * Phase 2 renews the profile lease while any conversation is non-idle and
 * scopes cancellation / late events to `(conversation, delivery, execution_epoch)`.
 */

export const EXECUTION_STATES = Object.freeze([
  "idle",
  "admitted",
  "running",
  "result_ready",
  "reply_persisted",
  "acked",
]);

/** States that keep the profile lease non-stealable even after wall-clock expiry. */
export const NON_IDLE_EXECUTION_STATES = Object.freeze([
  "admitted",
  "running",
  "result_ready",
  "reply_persisted",
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

export function isNonIdleExecutionState(state) {
  return NON_IDLE_EXECUTION_STATES.includes(assertExecutionState(state));
}

/**
 * Late App Server / MESH events from a stale epoch are ignored (metadata-only).
 * Returns true when the event epoch matches the admitted conversation epoch.
 */
export function shouldAcceptExecutionEpochEvent({ conversationEpoch, eventEpoch } = {}) {
  if (!Number.isSafeInteger(conversationEpoch) || conversationEpoch < 1) return false;
  if (!Number.isSafeInteger(eventEpoch) || eventEpoch < 1) return false;
  return conversationEpoch === eventEpoch;
}

/**
 * Cancellation is scoped to `(conversation, delivery, execution_epoch)`.
 */
export function matchesCancellationScope(
  record,
  { deliveryId, executionEpoch } = {},
) {
  if (record == null) return false;
  if (!Number.isSafeInteger(executionEpoch) || executionEpoch < 1) return false;
  if (record.executionEpoch !== executionEpoch) return false;
  const active = record.activeDeliveryId ?? null;
  if (active == null || deliveryId == null) return false;
  return String(active) === String(deliveryId);
}
