import path from "node:path";
import { createRequire } from "node:module";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
} from "node:fs";
import { privateDir, privateFile } from "./delivery-private-path.mjs";

const coded = (code, message = code) =>
  Object.assign(new Error(message === code ? code : `${code}: ${message}`), { code });

export const activeStateRoots = new Set();

/**
 * openDeliveryJournal:
 * Shared custody, private path/permissions, and exclusive SQLite ownership for delivery journals.
 * Enforces 0700 directories, 0600 files, and exclusive process locks.
 */
export function openDeliveryJournal({
  stateRoot,
  dbName = "peer-drain.sqlite",
  ownerDbName = "peer-drain-owner.sqlite",
  busyCode = "drain_busy",
  busyMessage = null,
} = {}) {
  if (!stateRoot || typeof stateRoot !== "string") {
    throw coded("invalid_options", "stateRoot is required and must be a string");
  }

  privateDir(stateRoot, { create: true });

  if (activeStateRoots.has(stateRoot)) {
    const msg =
      busyMessage ||
      (busyCode === "drain_busy"
        ? "Another peer drain service is active on this state directory"
        : "Another delivery service is active on this state directory");
    throw coded(busyCode, msg);
  }

  for (const name of [`${ownerDbName}-journal`, `${dbName}-journal`]) {
    privateFile(path.join(stateRoot, name));
  }

  for (const name of [ownerDbName, dbName]) {
    const file = path.join(stateRoot, name);
    privateFile(file);
    if (!existsSync(file)) {
      closeSync(openSync(file, "wx", 0o600));
      const fd = openSync(stateRoot, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }

  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const lock = new DatabaseSync(path.join(stateRoot, ownerDbName));
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    const msg =
      busyCode === "drain_busy"
        ? `Failed to acquire exclusive lock on ${ownerDbName}`
        : `State directory is actively owned: failed to acquire exclusive lock on ${ownerDbName}`;
    throw coded(busyCode, msg);
  }

  activeStateRoots.add(stateRoot);

  const dbPath = path.join(stateRoot, dbName);
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    chmodSync(dbPath, 0o600);
  } catch (error) {
    activeStateRoots.delete(stateRoot);
    try {
      db?.close();
    } catch {}
    try {
      lock.exec("ROLLBACK");
    } catch {}
    try {
      lock.close();
    } catch {}
    throw error;
  }

  let closed = false;

  return {
    db,
    lock,
    stateRoot,
    dbPath,
    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {}
      try {
        lock.exec("ROLLBACK");
      } catch {}
      try {
        lock.close();
      } catch {}
      activeStateRoots.delete(stateRoot);
    },
    isClosed() {
      return closed;
    },
  };
}
