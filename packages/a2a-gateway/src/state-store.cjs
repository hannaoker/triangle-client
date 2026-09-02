/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_STATE_BYTES = 16 * 1024 * 1024;

function readOptionalJson(fsImpl, filename, maxStateBytes) {
  try {
    if (fsImpl.statSync(filename).size > maxStateBytes) {
      throw new Error("Agent state is too large");
    }
    const contents = fsImpl.readFileSync(filename);
    if (contents.byteLength > maxStateBytes) {
      throw new Error("Agent state is too large");
    }
    return { found: true, value: JSON.parse(contents.toString("utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { found: false };
    throw new Error("Agent state is corrupt or invalid", { cause: error });
  }
}

function validateState(value, validator) {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.inbox) ||
    typeof value.tasks !== "object" ||
    value.tasks === null ||
    Array.isArray(value.tasks)
  ) {
    throw new Error("Agent state is corrupt or invalid");
  }
  validator(value);
  return value;
}

function defaultValidator(value) {
  const seen = new Set();
  const isJsonValue = (candidate) => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return true;
    }
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate !== "object" || seen.has(candidate)) return false;
    seen.add(candidate);
    const valid = Array.isArray(candidate)
      ? candidate.every(isJsonValue)
      : Object.values(candidate).every(isJsonValue);
    seen.delete(candidate);
    return valid;
  };
  if (!isJsonValue(value)) {
    throw new Error("Agent state is corrupt or invalid");
  }
}

function migrateRecognizableRevisions(state) {
  let changed = false;
  const taskRecords =
    state.tasks &&
    typeof state.tasks === "object" &&
    !Array.isArray(state.tasks)
      ? Object.values(state.tasks)
      : [];
  for (const record of taskRecords) {
    const task = record?.task || record;
    const recognizable =
      record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      task &&
      typeof task === "object" &&
      !Array.isArray(task) &&
      typeof record.senderId === "string" &&
      typeof record.recipientId === "string" &&
      typeof task.id === "string" &&
      typeof task.contextId === "string" &&
      task.status &&
      typeof task.status === "object" &&
      typeof task.status.state === "string" &&
      typeof task.status.timestamp === "string" &&
      Array.isArray(task.history);
    if (!recognizable) continue;
    if (task.metadata === undefined) {
      task.metadata = { meshRevision: 1 };
      changed = true;
    } else if (
      task.metadata &&
      typeof task.metadata === "object" &&
      !Array.isArray(task.metadata) &&
      task.metadata.meshRevision === undefined
    ) {
      task.metadata.meshRevision = 1;
      changed = true;
    }
  }
  const inboxEntries = Array.isArray(state.inbox) ? state.inbox : [];
  for (const entry of inboxEntries) {
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      entry.taskRevision === undefined &&
      typeof entry.messageId === "string" &&
      typeof entry.contextId === "string" &&
      typeof entry.taskId === "string" &&
      typeof entry.role === "string" &&
      typeof entry.sender === "string" &&
      typeof entry.senderId === "string" &&
      typeof entry.recipientId === "string" &&
      Array.isArray(entry.parts) &&
      typeof entry.text === "string" &&
      typeof entry.timestamp === "string" &&
      typeof entry.acked === "boolean"
    ) {
      const task = state.tasks?.[entry.taskId]?.task || state.tasks?.[entry.taskId];
      if (
        Number.isSafeInteger(task?.metadata?.meshRevision) &&
        task.metadata.meshRevision >= 1
      ) {
        entry.taskRevision = task.metadata.meshRevision;
        changed = true;
      }
    }
  }
  return { state, changed };
}

function writeAtomic({
  fsImpl,
  directory,
  filename,
  serialized,
}) {
  const temporary = path.join(
    directory,
    `.state-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, serialized, "utf8");
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporary, filename);
    try {
      const directoryDescriptor = fsImpl.openSync(directory, "r");
      try {
        fsImpl.fsyncSync(directoryDescriptor);
      } finally {
        fsImpl.closeSync(directoryDescriptor);
      }
    } catch {
      // Directory fsync is not supported by every platform/filesystem.
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch {
        // Preserve the original persistence error.
      }
    }
    try {
      fsImpl.unlinkSync(temporary);
    } catch {
      // The temporary file may not exist or may already have been renamed.
    }
    throw new Error("Unable to persist agent state", { cause: error });
  }
}

function createStateStore({
  directory,
  fsImpl = fs,
  maxStateBytes = DEFAULT_MAX_STATE_BYTES,
  validator = defaultValidator,
}) {
  fsImpl.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "state.json");
  const unified = readOptionalJson(fsImpl, filename, maxStateBytes);
  let state;
  let needsRewrite = false;

  if (unified.found) {
    const migrated = migrateRecognizableRevisions(unified.value);
    state = validateState(migrated.state, validator);
    needsRewrite = migrated.changed;
  } else {
    const legacyInbox = readOptionalJson(
      fsImpl,
      path.join(directory, "inbox.json"),
      maxStateBytes,
    );
    const legacyTasks = readOptionalJson(
      fsImpl,
      path.join(directory, "tasks.json"),
      maxStateBytes,
    );
    const inbox = legacyInbox.found ? legacyInbox.value : [];
    const tasks = legacyTasks.found ? legacyTasks.value : {};
    const migrated = migrateRecognizableRevisions({ inbox, tasks });
    state = validateState(migrated.state, validator);
    needsRewrite = true;
  }

  const save = (nextState) => {
    validateState(nextState, validator);
    const serialized = `${JSON.stringify(nextState, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > maxStateBytes) {
      throw new Error("Unable to persist agent state");
    }
    writeAtomic({ fsImpl, directory, filename, serialized });
  };

  if (needsRewrite) save(state);
  return { state, save, filename };
}

module.exports = {
  DEFAULT_MAX_STATE_BYTES,
  createStateStore,
};
