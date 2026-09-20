/**
 * Node durable conversation / lease / completion store for Phase 2 shadow recovery.
 *
 * Mirrors the helper-owned FileCodexConversationStore schema
 * (`profile.json`, `conversations/<roomId>.json`, `completions/<id>.json`) so
 * crash-boundary and restart tests can run on Linux CI without the Darwin
 * signed helper. Production still keeps
 * `CodexRuntimeFeatureFlags.conversationStoreEnabled = false` and
 * `featureFlags.helperConversationStore = false`; this store activates only when
 * a shadow runtime explicitly passes `enabled: true` with a local root.
 *
 * Identifiers only — never message text, assistant output, or MESH credentials.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { assertNoSecretMaterial } from "./app-server-protocol.mjs";
import { assertExecutionState } from "./execution-state.mjs";

const ROOM_ID = /^room_[a-f0-9]{32}$/;
const INSTANCE_ID = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const OWNER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_BYTES = 8192;

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function assertEnabled(enabled) {
  if (!enabled) {
    throw createCodedError(
      "durable_store_inactive",
      "durable conversation store is inactive (shadow opt-in required)",
    );
  }
}

function assertProfileInstanceId(value) {
  if (typeof value !== "string" || !INSTANCE_ID.test(value)) {
    throw createCodedError("durable_store_invalid", "profileInstanceId must be a 64-hex instance id");
  }
  return value;
}

function assertRoomId(value) {
  if (typeof value !== "string" || !ROOM_ID.test(value)) {
    throw createCodedError("durable_store_invalid", "meshRoomId must be a room_<32-hex> id");
  }
  return value;
}

function assertIdempotencyId(value) {
  if (typeof value !== "string" || !IDEMPOTENCY_ID.test(value)) {
    throw createCodedError("durable_store_invalid", "idempotencyId is invalid");
  }
  return value;
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort on platforms that ignore chmod.
  }
}

function atomicWriteJson(filePath, value) {
  assertNoSecretMaterial(value, path.basename(filePath));
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(json) > MAX_BYTES) {
    throw createCodedError("durable_store_too_large", "record exceeds maximum bytes");
  }
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  writeFileSync(tmp, json, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // ignore
  }
  renameSync(tmp, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf8");
  if (Buffer.byteLength(raw) > MAX_BYTES) {
    throw createCodedError("durable_store_too_large", "on-disk record exceeds maximum bytes");
  }
  assertNoSecretMaterial(raw, path.basename(filePath));
  return JSON.parse(raw);
}

/**
 * @param {object} options
 * @param {string} options.root Absolute directory for this profile's codex-runtime store
 * @param {boolean} [options.enabled] Must be true for shadow Phase 2; default false
 * @param {() => number} [options.now]
 */
export function createDurableConversationStore({
  root,
  enabled = false,
  now = () => Date.now(),
} = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new TypeError("root must be an absolute path");
  }
  assertNoSecretMaterial(root, "durable store root");

  const conversationsDir = path.join(root, "conversations");
  const completionsDir = path.join(root, "completions");
  const profilePath = path.join(root, "profile.json");

  function conversationPath(meshRoomId) {
    return path.join(conversationsDir, `${assertRoomId(meshRoomId)}.json`);
  }

  function completionPath(idempotencyId) {
    return path.join(completionsDir, `${assertIdempotencyId(idempotencyId)}.json`);
  }

  function readProfile(profileInstanceId) {
    assertEnabled(enabled);
    assertProfileInstanceId(profileInstanceId);
    const record = readJson(profilePath);
    if (record == null) return null;
    if (record.profile_instance_id !== profileInstanceId) {
      throw createCodedError("durable_store_invalid", "profile_instance_id mismatch");
    }
    return Object.freeze({ ...record });
  }

  function writeProfile(record) {
    assertEnabled(enabled);
    const profileInstanceId = assertProfileInstanceId(record.profile_instance_id);
    if (typeof record.owner_instance_id !== "string" || !OWNER_ID.test(record.owner_instance_id)) {
      throw createCodedError("durable_store_invalid", "owner_instance_id is invalid");
    }
    if (!Number.isSafeInteger(record.owner_generation) || record.owner_generation < 1) {
      throw createCodedError("durable_store_invalid", "owner_generation must be >= 1");
    }
    if (record.ownership_state !== "owned" && record.ownership_state !== "transferring") {
      throw createCodedError("durable_store_invalid", "ownership_state is invalid");
    }
    if (record.runtime_mode !== "headless" && record.runtime_mode !== "desktop") {
      throw createCodedError("durable_store_invalid", "runtime_mode is invalid");
    }
    const next = {
      version: 1,
      profile_instance_id: profileInstanceId,
      runtime_mode: record.runtime_mode,
      owner_instance_id: record.owner_instance_id,
      owner_generation: record.owner_generation,
      ownership_state: record.ownership_state,
      lease_renewed_at: record.lease_renewed_at ?? isoNow(now),
      lease_expires_at: record.lease_expires_at,
      active_mesh_room_id: record.active_mesh_room_id ?? null,
      updated_at: isoNow(now),
    };
    if (typeof next.lease_expires_at !== "string" || next.lease_expires_at.length === 0) {
      throw createCodedError("durable_store_invalid", "lease_expires_at is required");
    }
    if (next.active_mesh_room_id != null) assertRoomId(next.active_mesh_room_id);
    atomicWriteJson(profilePath, next);
    return Object.freeze({ ...next });
  }

  function readConversation(profileInstanceId, meshRoomId) {
    assertEnabled(enabled);
    assertProfileInstanceId(profileInstanceId);
    const record = readJson(conversationPath(meshRoomId));
    if (record == null) return null;
    if (record.profile_instance_id !== profileInstanceId || record.mesh_room_id !== meshRoomId) {
      throw createCodedError("durable_store_invalid", "conversation key mismatch");
    }
    return Object.freeze({ ...record });
  }

  function writeConversation(record) {
    assertEnabled(enabled);
    const profileInstanceId = assertProfileInstanceId(record.profile_instance_id);
    const meshRoomId = assertRoomId(record.mesh_room_id);
    assertExecutionState(record.execution_state);
    if (!Number.isSafeInteger(record.execution_epoch) || record.execution_epoch < 0) {
      throw createCodedError("durable_store_invalid", "execution_epoch is invalid");
    }
    if (typeof record.codex_thread_id !== "string" || record.codex_thread_id.length === 0) {
      // Allow null thread only while idle before first start — persist empty marker as null.
      if (record.codex_thread_id != null) {
        throw createCodedError("durable_store_invalid", "codex_thread_id is invalid");
      }
    }
    const next = {
      version: 1,
      profile_instance_id: profileInstanceId,
      mesh_room_id: meshRoomId,
      codex_thread_id: record.codex_thread_id ?? null,
      active_delivery_id: record.active_delivery_id ?? null,
      execution_epoch: record.execution_epoch,
      execution_state: record.execution_state,
      last_worker_slot_id: record.last_worker_slot_id ?? null,
      last_completed_delivery_id: record.last_completed_delivery_id ?? null,
      last_reply_event_id: record.last_reply_event_id ?? null,
      updated_at: isoNow(now),
    };
    atomicWriteJson(conversationPath(meshRoomId), next);
    return Object.freeze({ ...next });
  }

  function readCompletion(profileInstanceId, idempotencyId) {
    assertEnabled(enabled);
    assertProfileInstanceId(profileInstanceId);
    const record = readJson(completionPath(idempotencyId));
    if (record == null) return null;
    if (record.profile_instance_id !== profileInstanceId || record.idempotency_id !== idempotencyId) {
      throw createCodedError("durable_store_invalid", "completion key mismatch");
    }
    return Object.freeze({ ...record });
  }

  function writeCompletion(record) {
    assertEnabled(enabled);
    const profileInstanceId = assertProfileInstanceId(record.profile_instance_id);
    const idempotencyId = assertIdempotencyId(record.idempotency_id);
    assertRoomId(record.mesh_room_id);
    if (!Number.isSafeInteger(record.delivery_id) || record.delivery_id < 1) {
      throw createCodedError("durable_store_invalid", "delivery_id is invalid");
    }
    if (typeof record.reply_event_id !== "string" || record.reply_event_id.length === 0) {
      throw createCodedError("durable_store_invalid", "reply_event_id is required");
    }
    assertNoSecretMaterial(record.reply_event_id, "reply_event_id");
    const next = {
      version: 1,
      profile_instance_id: profileInstanceId,
      mesh_room_id: record.mesh_room_id,
      idempotency_id: idempotencyId,
      delivery_id: record.delivery_id,
      reply_event_id: record.reply_event_id,
      completed_at: record.completed_at ?? isoNow(now),
    };
    atomicWriteJson(completionPath(idempotencyId), next);
    return Object.freeze({ ...next });
  }

  function listConversations(profileInstanceId) {
    assertEnabled(enabled);
    assertProfileInstanceId(profileInstanceId);
    if (!existsSync(conversationsDir)) return Object.freeze([]);
    const names = readdirSync(conversationsDir).filter((name) => name.endsWith(".json"));
    const out = [];
    for (const name of names) {
      const record = readJson(path.join(conversationsDir, name));
      if (record?.profile_instance_id === profileInstanceId) out.push(Object.freeze({ ...record }));
    }
    return Object.freeze(out);
  }

  function clear() {
    assertEnabled(enabled);
    rmSync(root, { recursive: true, force: true });
    ensureDir(root);
  }

  return Object.freeze({
    root,
    enabled,
    readProfile,
    writeProfile,
    readConversation,
    writeConversation,
    readCompletion,
    writeCompletion,
    listConversations,
    clear,
  });
}
