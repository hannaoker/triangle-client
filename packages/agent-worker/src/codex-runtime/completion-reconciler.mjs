/**
 * Completion reconciliation for Phase 2 restart / reconnect recovery.
 *
 * Triangle cannot atomically commit helper store + MESH. Replay the same
 * reply→ack operations without inventing a new reply identifier after a
 * canonical reply has been returned. Never start a duplicate MESH reply.
 */

import { assertNoSecretMaterial } from "./app-server-protocol.mjs";
import { transitionExecutionState } from "./execution-state.mjs";

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export function buildCompletionIdempotencyKey({
  profileInstanceId,
  roomId,
  deliveryId,
  executionEpoch = null,
} = {}) {
  if (typeof profileInstanceId !== "string" || profileInstanceId.length < 8) {
    throw new TypeError("profileInstanceId is required");
  }
  if (typeof roomId !== "string" || !roomId.startsWith("room_")) {
    throw new TypeError("roomId is required");
  }
  const delivery =
    typeof deliveryId === "string"
      ? deliveryId
      : Number.isSafeInteger(deliveryId)
        ? `delivery_${deliveryId}`
        : null;
  if (delivery == null) throw new TypeError("deliveryId is required");
  const epochPart =
    Number.isSafeInteger(executionEpoch) && executionEpoch > 0 ? `:e${executionEpoch}` : "";
  // Keep within FileCodexConversationStore idempotency charset / length.
  const raw = `${profileInstanceId.slice(0, 16)}:${roomId}:${delivery}${epochPart}`;
  return raw.slice(0, 128);
}

/**
 * Record or replay a completion. Matching duplicates return applied:false.
 * Conflicting reply identifiers are rejected for operator quarantine.
 */
export function recordOrReplayCompletion(store, record) {
  if (store == null || typeof store.readCompletion !== "function") {
    throw new TypeError("store is required");
  }
  assertNoSecretMaterial(record, "completion record");
  const existing = store.readCompletion(record.profile_instance_id, record.idempotency_id);
  if (existing == null) {
    const written = store.writeCompletion(record);
    return Object.freeze({ applied: true, completion: written });
  }
  if (
    existing.reply_event_id === record.reply_event_id &&
    existing.delivery_id === record.delivery_id &&
    existing.mesh_room_id === record.mesh_room_id
  ) {
    return Object.freeze({ applied: false, completion: existing });
  }
  throw createCodedError(
    "completion_conflict",
    "conflicting completion for idempotency key",
    {
      idempotencyId: record.idempotency_id,
      existingReplyEventId: existing.reply_event_id,
      nextReplyEventId: record.reply_event_id,
    },
  );
}

/**
 * Reconcile one conversation after process/slot restart.
 *
 * - reply_persisted + last_reply_event_id → ack only (no new MESH reply)
 * - acked → return to idle
 * - admitted/running/result_ready → quarantine (outcome unknown); do not reply
 * - idle → no-op
 */
export async function reconcileConversationAfterRestart({
  registry,
  store = null,
  transactionProxy = null,
  profileInstanceId,
  roomId,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const record = registry.get(profileInstanceId, roomId);
  if (record == null) {
    return Object.freeze({ status: "missing", profileInstanceId, roomId });
  }

  const state = record.executionState;
  if (state === "idle") {
    return Object.freeze({ status: "idle", profileInstanceId, roomId, duplicateReply: false });
  }

  if (state === "acked") {
    registry.upsert(profileInstanceId, roomId, { executionState: "idle", activeDeliveryId: null });
    return Object.freeze({
      status: "idle",
      profileInstanceId,
      roomId,
      from: "acked",
      duplicateReply: false,
    });
  }

  if (state === "reply_persisted") {
    const replyEventId = record.lastReplyEventId;
    if (typeof replyEventId !== "string" || replyEventId.length === 0) {
      throw createCodedError(
        "completion_reply_missing",
        "reply_persisted without lastReplyEventId; quarantine",
        { profileInstanceId, roomId },
      );
    }
    assertNoSecretMaterial(replyEventId, "lastReplyEventId");

    if (store != null && record.activeDeliveryId != null) {
      const numeric =
        typeof record.activeDeliveryId === "string" && record.activeDeliveryId.startsWith("delivery_")
          ? Number(record.activeDeliveryId.slice("delivery_".length))
          : Number(record.activeDeliveryId);
      if (Number.isSafeInteger(numeric) && numeric > 0) {
        recordOrReplayCompletion(store, {
          profile_instance_id: profileInstanceId,
          mesh_room_id: roomId,
          idempotency_id: buildCompletionIdempotencyKey({
            profileInstanceId,
            roomId,
            deliveryId: record.activeDeliveryId,
            executionEpoch: record.executionEpoch,
          }),
          delivery_id: numeric,
          reply_event_id: replyEventId,
          completed_at: new Date(now()).toISOString(),
        });
      }
    }

    if (transactionProxy != null) {
      if (typeof transactionProxy.ack !== "function") {
        throw new TypeError("transactionProxy.ack is required for reply_persisted recovery");
      }
      await transactionProxy.ack({
        roomId,
        replyEventId,
        resumeOnly: true,
      });
    }

    registry.upsert(profileInstanceId, roomId, {
      executionState: transitionExecutionState("reply_persisted", "acked"),
      lastCompletedDeliveryId: record.activeDeliveryId,
      activeDeliveryId: null,
    });
    registry.upsert(profileInstanceId, roomId, { executionState: "idle" });

    logger.info?.("triangle_headless_completion_reconciled", {
      profileInstanceId,
      roomId,
      replyEventId,
      path: "ack_only",
    });

    return Object.freeze({
      status: "reconciled_ack",
      profileInstanceId,
      roomId,
      replyEventId,
      duplicateReply: false,
      meshReplyPosted: false,
    });
  }

  // admitted | running | result_ready — outcome unknown; do not invent a reply.
  logger.info?.("triangle_headless_completion_quarantined", {
    profileInstanceId,
    roomId,
    executionState: state,
    executionEpoch: record.executionEpoch,
    activeDeliveryId: record.activeDeliveryId,
  });
  return Object.freeze({
    status: "quarantined",
    profileInstanceId,
    roomId,
    executionState: state,
    executionEpoch: record.executionEpoch,
    activeDeliveryId: record.activeDeliveryId,
    duplicateReply: false,
    meshReplyPosted: false,
    requiresOperatorOrThreadReconcile: true,
  });
}

/**
 * Reconcile all durable conversations for a profile after supervisor restart.
 */
export async function reconcileProfileAfterRestart(options = {}) {
  const { registry, profileInstanceId } = options;
  if (registry == null || typeof registry.list !== "function") {
    throw new TypeError("registry.list is required");
  }
  const rows = registry
    .list()
    .filter((row) => row.profileInstanceId === profileInstanceId || row.profile_instance_id === profileInstanceId);
  const results = [];
  for (const row of rows) {
    const roomId = row.meshRoomId ?? row.mesh_room_id;
    results.push(
      await reconcileConversationAfterRestart({
        ...options,
        roomId,
      }),
    );
  }
  return Object.freeze({
    profileInstanceId,
    results: Object.freeze(results),
    quarantined: results.filter((row) => row.status === "quarantined").length,
    reconciledAck: results.filter((row) => row.status === "reconciled_ack").length,
  });
}
