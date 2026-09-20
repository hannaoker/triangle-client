/**
 * In-process conversation registry for Phase 1 shadow runtime.
 *
 * Maps `(profileInstanceId, meshRoomId) -> Codex thread + execution record`.
 * Survives App Server *slot* restart within the same Node process. Durable
 * helper-backed FileCodexConversationStore remains behind an inactive flag
 * until Phase 2 recovery work.
 *
 * Never stores message text, assistant output, or MESH credentials.
 */

import { createExecutionRecord, transitionExecutionState } from "./execution-state.mjs";

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

/**
 * Create an in-memory conversation registry.
 */
export function createMemoryConversationRegistry({ now = () => Date.now() } = {}) {
  /** @type {Map<string, object>} */
  const conversations = new Map();

  function get(profileInstanceId, meshRoomId) {
    const key = keyFor(profileInstanceId, meshRoomId);
    const record = conversations.get(key);
    return record ? Object.freeze({ ...record }) : null;
  }

  function upsert(profileInstanceId, meshRoomId, patch = {}) {
    const key = keyFor(profileInstanceId, meshRoomId);
    const existing = conversations.get(key) ?? {
      profileInstanceId,
      meshRoomId,
      ...createExecutionRecord(),
      updatedAt: now(),
    };
    if (
      patch.codexThreadId != null &&
      existing.codexThreadId != null &&
      patch.codexThreadId !== existing.codexThreadId
    ) {
      throw createCodedError(
        "registry_thread_conflict",
        "conversation already mapped to a different Codex thread",
        {
          profileInstanceId,
          meshRoomId,
          existing: existing.codexThreadId,
          next: patch.codexThreadId,
        },
      );
    }
    let executionState = existing.executionState;
    if (patch.executionState != null && patch.executionState !== existing.executionState) {
      executionState = transitionExecutionState(existing.executionState, patch.executionState);
    }
    const next = {
      ...existing,
      ...patch,
      profileInstanceId,
      meshRoomId,
      executionState,
      updatedAt: now(),
    };
    conversations.set(key, next);
    return Object.freeze({ ...next });
  }

  function setThread(profileInstanceId, meshRoomId, codexThreadId, { workerSlotId = null } = {}) {
    if (typeof codexThreadId !== "string" || codexThreadId.length === 0) {
      throw createCodedError("registry_invalid", "codexThreadId is required");
    }
    return upsert(profileInstanceId, meshRoomId, {
      codexThreadId,
      lastWorkerSlotId: workerSlotId,
    });
  }

  function list() {
    return Object.freeze([...conversations.values()].map((record) => Object.freeze({ ...record })));
  }

  function clear() {
    conversations.clear();
  }

  return Object.freeze({
    get,
    upsert,
    setThread,
    list,
    clear,
    size: () => conversations.size,
  });
}
