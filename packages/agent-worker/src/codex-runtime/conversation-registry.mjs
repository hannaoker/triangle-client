/**
 * Conversation registry for the headless Codex runtime.
 *
 * Phase 1: in-memory map `(profileInstanceId, meshRoomId) -> thread + execution`.
 * Phase 2: optional durable file store (shadow opt-in) for lease/epoch/restart
 * recovery. Survives process restart when backed by createDurableConversationStore.
 *
 * Never stores message text, assistant output, or MESH credentials.
 */

import { assertNoSecretMaterial } from "./app-server-protocol.mjs";
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

function deliveryToStored(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.startsWith("delivery_")) {
    const n = Number(value.slice("delivery_".length));
    return Number.isSafeInteger(n) ? n : value;
  }
  return value;
}

function deliveryFromStored(value) {
  if (value == null) return null;
  if (typeof value === "number") return `delivery_${value}`;
  return String(value);
}

function fromDurable(record) {
  if (record == null) return null;
  return {
    profileInstanceId: record.profile_instance_id,
    meshRoomId: record.mesh_room_id,
    codexThreadId: record.codex_thread_id ?? null,
    activeDeliveryId: deliveryFromStored(record.active_delivery_id),
    executionEpoch: record.execution_epoch ?? 0,
    executionState: record.execution_state ?? "idle",
    lastWorkerSlotId: record.last_worker_slot_id ?? null,
    lastCompletedDeliveryId: deliveryFromStored(record.last_completed_delivery_id),
    lastReplyEventId: record.last_reply_event_id ?? null,
    updatedAt: record.updated_at ?? null,
  };
}

function toDurable(record) {
  return {
    version: 1,
    profile_instance_id: record.profileInstanceId,
    mesh_room_id: record.meshRoomId,
    codex_thread_id: record.codexThreadId,
    active_delivery_id: deliveryToStored(record.activeDeliveryId),
    execution_epoch: record.executionEpoch,
    execution_state: record.executionState,
    last_worker_slot_id: record.lastWorkerSlotId,
    last_completed_delivery_id: deliveryToStored(record.lastCompletedDeliveryId),
    last_reply_event_id: record.lastReplyEventId,
  };
}

function applyUpsert(existing, profileInstanceId, meshRoomId, patch, now) {
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
  assertNoSecretMaterial(next, "conversation registry record");
  return next;
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
    const next = applyUpsert(existing, profileInstanceId, meshRoomId, patch, now);
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
    kind: "memory",
    get,
    upsert,
    setThread,
    list,
    clear,
    size: () => conversations.size,
    store: null,
  });
}

/**
 * Durable-backed registry: in-process cache + file store (helper schema mirror).
 * Activate only for shadow Phase 2 (`store.enabled === true`).
 */
export function createDurableConversationRegistry({
  store,
  now = () => Date.now(),
  profileInstanceId = null,
} = {}) {
  if (store == null || store.enabled !== true) {
    throw createCodedError(
      "registry_durable_inactive",
      "durable registry requires an enabled durable conversation store",
    );
  }

  /** @type {Map<string, object>} */
  const cache = new Map();

  function loadIntoCache(instanceId) {
    for (const row of store.listConversations(instanceId)) {
      const mapped = fromDurable(row);
      cache.set(keyFor(mapped.profileInstanceId, mapped.meshRoomId), mapped);
    }
  }

  if (profileInstanceId) loadIntoCache(profileInstanceId);

  function get(profileInstanceIdArg, meshRoomId) {
    const key = keyFor(profileInstanceIdArg, meshRoomId);
    if (cache.has(key)) return Object.freeze({ ...cache.get(key) });
    const fromDisk = fromDurable(store.readConversation(profileInstanceIdArg, meshRoomId));
    if (fromDisk != null) {
      cache.set(key, fromDisk);
      return Object.freeze({ ...fromDisk });
    }
    return null;
  }

  function upsert(profileInstanceIdArg, meshRoomId, patch = {}) {
    const existing = get(profileInstanceIdArg, meshRoomId) ?? {
      profileInstanceId: profileInstanceIdArg,
      meshRoomId,
      ...createExecutionRecord(),
      updatedAt: now(),
    };
    const next = applyUpsert(existing, profileInstanceIdArg, meshRoomId, patch, now);
    store.writeConversation(toDurable(next));
    cache.set(keyFor(profileInstanceIdArg, meshRoomId), next);
    return Object.freeze({ ...next });
  }

  function setThread(profileInstanceIdArg, meshRoomId, codexThreadId, { workerSlotId = null } = {}) {
    if (typeof codexThreadId !== "string" || codexThreadId.length === 0) {
      throw createCodedError("registry_invalid", "codexThreadId is required");
    }
    return upsert(profileInstanceIdArg, meshRoomId, {
      codexThreadId,
      lastWorkerSlotId: workerSlotId,
    });
  }

  function list() {
    if (profileInstanceId) loadIntoCache(profileInstanceId);
    return Object.freeze([...cache.values()].map((record) => Object.freeze({ ...record })));
  }

  function clear() {
    cache.clear();
    store.clear();
  }

  return Object.freeze({
    kind: "durable",
    get,
    upsert,
    setThread,
    list,
    clear,
    size: () => cache.size,
    store,
    reload: () => {
      cache.clear();
      if (profileInstanceId) loadIntoCache(profileInstanceId);
    },
  });
}
