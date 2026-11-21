/**
 * Conversation registry for the Cursor ACP runtime.
 *
 * Maps `(profileInstanceId, meshRoomId) -> cursorSessionId + execution`.
 * Continuity across process kill uses session/load with the persisted
 * sessionId (resume/close not advertised on Phase 0 Mini build).
 *
 * Never stores message text, assistant output, or MESH credentials.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
    patch.cursorSessionId !== existing.cursorSessionId &&
    patch.replacesSessionId !== existing.cursorSessionId
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
  return createRegistry(now);
}

function createRegistry(now, storage = null) {
  /** @type {Map<string, object>} */
  const records = new Map();

  function get(profileInstanceId, meshRoomId) {
    const key = keyFor(profileInstanceId, meshRoomId);
    if (!records.has(key) && storage) {
      const id = storage.read(profileInstanceId, meshRoomId);
      if (id !== null) records.set(key, { ...emptyRecord(profileInstanceId, meshRoomId), cursorSessionId: id });
    }
    const record = records.get(key);
    return record == null ? null : { ...record };
  }

  function upsert(profileInstanceId, meshRoomId, patch = {}) {
    const key = keyFor(profileInstanceId, meshRoomId);
    const existing = get(profileInstanceId, meshRoomId) ?? emptyRecord(profileInstanceId, meshRoomId);
    const next = applyUpsert(existing, profileInstanceId, meshRoomId, patch, now);
    if (storage && next.cursorSessionId !== existing.cursorSessionId) {
      storage.write(profileInstanceId, meshRoomId, next.cursorSessionId);
    }
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

// Each installed drain owns one profile state root. Persist only the conversation
// identity: the mailbox helper owns transaction recovery after a process exit.
export function createFileCursorSessionRegistry({ stateRoot, profileInstanceId, now = Date.now }) {
  assertProfileInstanceId(profileInstanceId);
  if (!path.isAbsolute(stateRoot)) throw new TypeError("stateRoot must be absolute");
  const directory = path.join(stateRoot, "conversations");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw createCodedError("registry_invalid", "conversation directory must be private");
  }

  function filename(instance, room) {
    if (instance !== profileInstanceId) throw createCodedError("registry_invalid", "wrong profile instance");
    return path.join(directory, assertRoomId(room) + ".json");
  }
  function validateId(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(id)) {
      throw createCodedError("registry_invalid", "invalid Cursor session id");
    }
    assertNoSecretMaterial(id, "Cursor session id");
    return id;
  }
  return createRegistry(now, {
    read(instance, room) {
      const file = filename(instance, room);
      let fd;
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 4096) {
          throw createCodedError("registry_invalid", "invalid conversation record file");
        }
        const row = JSON.parse(fs.readFileSync(fd, "utf8"));
        if (row.profileInstanceId !== instance || row.meshRoomId !== room || row.version !== 1) {
          throw createCodedError("registry_invalid", "conversation record identity mismatch");
        }
        return validateId(row.cursorSessionId);
      } finally {
        fs.closeSync(fd);
      }
    },
    write(instance, room, id) {
      const file = filename(instance, room);
      const temp = file + "." + randomUUID() + ".tmp";
      const record = { version: 1, profileInstanceId: instance, meshRoomId: room, cursorSessionId: validateId(id) };
      try {
        fs.writeFileSync(temp, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx", flush: true });
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    },
  });
}
