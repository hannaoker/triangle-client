/**
 * Conversation registry for the Cursor ACP runtime.
 *
 * Maps `(profileInstanceId, meshRoomId) -> cursorSessionId + execution`.
 * Continuity across process kill uses session/load with the persisted
 * sessionId (resume/close not advertised on Phase 0 Mini build).
 *
 * Never stores message text, assistant output, or MESH credentials.
 */

import {
  assertExecutionState,
  transitionExecutionState,
} from "../codex-runtime/execution-state.mjs";
import { assertNoSecretMaterial } from "./acp-protocol.mjs";

const ROOM_ID = /^room_[a-f0-9]{32}$/;
const INSTANCE_ID = /^[a-f0-9]{64}$/;

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function assertProfileInstanceId(value) {
  if (typeof value !== "string" || !INSTANCE_ID.test(value)) {
    throw createCodedError("registry_invalid", "profileInstanceId must be a 64-hex instance id");
  }
  return value;
}

function assertRoomId(value) {
  if (typeof value !== "string" || !ROOM_ID.test(value)) {
    throw createCodedError("registry_invalid", "meshRoomId must be a room_<32-hex> id");
  }
  return value;
}

function keyFor(profileInstanceId, meshRoomId) {
  return `${assertProfileInstanceId(profileInstanceId)}:${assertRoomId(meshRoomId)}`;
}

function emptyRecord(profileInstanceId, meshRoomId) {
  return {
    profileInstanceId,
    meshRoomId,
    cursorSessionId: null,
    activeDeliveryId: null,
    executionEpoch: 0,
    executionState: "idle",
    lastWorkerSlotId: null,
    lastCompletedDeliveryId: null,
    lastReplyEventId: null,
    updatedAt: null,
  };
}

function applyUpsert(existing, profileInstanceId, meshRoomId, patch, now) {
  if (
    patch.cursorSessionId != null &&
    existing.cursorSessionId != null &&
    patch.cursorSessionId !== existing.cursorSessionId
  ) {
    throw createCodedError(
      "registry_session_conflict",
      "conversation already mapped to a different Cursor ACP session",
      {
        profileInstanceId,
        meshRoomId,
        existingSessionId: existing.cursorSessionId,
        nextSessionId: patch.cursorSessionId,
      },
    );
  }

  const next = {
    ...existing,
    profileInstanceId,
    meshRoomId,
    cursorSessionId:
      patch.cursorSessionId !== undefined ? patch.cursorSessionId : existing.cursorSessionId,
    activeDeliveryId:
      patch.activeDeliveryId !== undefined ? patch.activeDeliveryId : existing.activeDeliveryId,
    executionEpoch:
      patch.executionEpoch !== undefined ? patch.executionEpoch : existing.executionEpoch,
    lastWorkerSlotId:
      patch.lastWorkerSlotId !== undefined ? patch.lastWorkerSlotId : existing.lastWorkerSlotId,
    lastCompletedDeliveryId:
      patch.lastCompletedDeliveryId !== undefined
        ? patch.lastCompletedDeliveryId
        : existing.lastCompletedDeliveryId,
    lastReplyEventId:
      patch.lastReplyEventId !== undefined ? patch.lastReplyEventId : existing.lastReplyEventId,
    updatedAt: now(),
  };

  if (patch.executionState != null) {
    if (patch.executionState === existing.executionState) {
      next.executionState = assertExecutionState(patch.executionState);
    } else {
      next.executionState = transitionExecutionState(
        existing.executionState,
        patch.executionState,
      );
    }
  } else {
    next.executionState = existing.executionState;
  }

  assertNoSecretMaterial(next, "cursor session registry record");
  return next;
}

/**
 * In-memory registry for shadow / unit tests.
 */
export function createMemoryCursorSessionRegistry({ now = () => Date.now() } = {}) {
  /** @type {Map<string, object>} */
  const records = new Map();

  function get(profileInstanceId, meshRoomId) {
    const record = records.get(keyFor(profileInstanceId, meshRoomId));
    return record == null ? null : { ...record };
  }

  function upsert(profileInstanceId, meshRoomId, patch = {}) {
    const key = keyFor(profileInstanceId, meshRoomId);
    const existing = records.get(key) ?? emptyRecord(profileInstanceId, meshRoomId);
    const next = applyUpsert(existing, profileInstanceId, meshRoomId, patch, now);
    records.set(key, next);
    return { ...next };
  }

  function listForProfile(profileInstanceId) {
    assertProfileInstanceId(profileInstanceId);
    return [...records.values()]
      .filter((record) => record.profileInstanceId === profileInstanceId)
      .map((record) => ({ ...record }));
  }

  function clear() {
    records.clear();
  }

  return Object.freeze({
    get,
    upsert,
    listForProfile,
    clear,
    size: () => records.size,
  });
}
