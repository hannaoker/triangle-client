/**
 * Kernel-managed claimer ownership for macOS.
 *
 * Ownership is an exclusive advisory lock held on an open fd for the claimer's
 * lifetime (Darwin O_EXLOCK). JSON on disk is diagnostic only. Process exit
 * releases the lock automatically — leftover JSON must not block acquire.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

/** Darwin sys/fcntl.h — not always exported on Node's fs.constants. */
export const DARWIN_O_SHLOCK = 0x10;
export const DARWIN_O_EXLOCK = 0x20;
export const DARWIN_O_NOFOLLOW = 0x100;

export function codedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Soft liveness probe for diagnostics / doctor.
 * Only ESRCH means absent. EPERM and unknown errors → alive/unknown.
 */
export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

export function assertAbsoluteLockPath(lockPath) {
  if (typeof lockPath !== "string" || !path.isAbsolute(lockPath) || lockPath.includes("\0")) {
    throw new TypeError("lockPath must be an absolute path");
  }
}

/** Reject a symlink leaf. Parent aliases (e.g. macOS /var → /private/var) are allowed. */
export function assertLockLeafNotSymlink(lockPath) {
  assertAbsoluteLockPath(lockPath);
  try {
    if (lstatSync(lockPath).isSymbolicLink()) {
      throw codedError(
        "claimer_lock_symlink",
        "claimer lock path must not be a symbolic link",
        { lockPath },
      );
    }
  } catch (error) {
    if (error?.code === "claimer_lock_symlink") throw error;
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function assertSafeRegularLockFile(fd, lockPath) {
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    throw codedError("claimer_lock_invalid", "claimer lock must be a regular file", { lockPath });
  }
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (stat.uid !== uid) {
      throw codedError("claimer_lock_invalid", "claimer lock uid mismatch", { lockPath });
    }
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw codedError("claimer_lock_invalid", "claimer lock mode must be 0600", { lockPath });
  }
  if (stat.nlink !== 1) {
    throw codedError("claimer_lock_invalid", "claimer lock must not be hard-linked", { lockPath });
  }
}

export function readClaimerDiagnostics(lockPath) {
  try {
    assertAbsoluteLockPath(lockPath);
    if (!existsSync(lockPath)) return null;
    const raw = readFileSync(lockPath, { encoding: "utf8" });
    const value = JSON.parse(raw);
    if (
      value?.version !== 1
      || typeof value.profile !== "string"
      || typeof value.owner !== "string"
      || !Number.isSafeInteger(value.pid)
    ) {
      return null;
    }
    return Object.freeze({
      version: 1,
      profile: value.profile,
      owner: value.owner,
      pid: value.pid,
      family: value.family === "codex" || value.family === "cursor-acp" ? value.family : null,
      acquiredAt: typeof value.acquiredAt === "string" ? value.acquiredAt : null,
      generation: typeof value.generation === "string" ? value.generation : null,
    });
  } catch {
    return null;
  }
}

function requireDarwinAdvisoryLocks() {
  if (process.platform !== "darwin") {
    throw codedError(
      "claimer_lock_unsupported_platform",
      "advisory claimer locks require macOS (Darwin O_EXLOCK)",
      { platform: process.platform },
    );
  }
}

/**
 * True when another process holds the exclusive advisory lock.
 * Uses a non-blocking shared lock probe (does not steal ownership).
 */
export function isAdvisoryLockHeld(lockPath, {
  platform = process.platform,
  open = openSync,
  close = closeSync,
} = {}) {
  assertAbsoluteLockPath(lockPath);
  if (!existsSync(lockPath)) return false;
  if (platform !== "darwin") {
    requireDarwinAdvisoryLocks();
  }
  try {
    const fd = open(
      lockPath,
      constants.O_RDONLY | constants.O_NONBLOCK | DARWIN_O_SHLOCK,
    );
    close(fd);
    return false;
  } catch (error) {
    if (error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK" || error?.code === "EACCES") {
      return true;
    }
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Acquire exclusive advisory ownership and write diagnostic JSON.
 * Keeps `fd` open until `release()` or process exit.
 */
export function acquireAdvisoryLock({
  lockPath,
  document,
  platform = process.platform,
  open = openSync,
  close = closeSync,
  write = writeSync,
  truncate = ftruncateSync,
  sync = fsyncSync,
  mkdir = mkdirSync,
  now = () => new Date().toISOString(),
} = {}) {
  assertLockLeafNotSymlink(lockPath);
  if (platform !== "darwin") requireDarwinAdvisoryLocks();
  if (!document || typeof document !== "object") {
    throw new TypeError("document is required");
  }

  const directory = path.dirname(lockPath);
  mkdir(directory, { recursive: true, mode: 0o700 });

  const flags = constants.O_RDWR
    | constants.O_CREAT
    | constants.O_NONBLOCK
    | DARWIN_O_EXLOCK
    | DARWIN_O_NOFOLLOW;
  let fd;
  try {
    fd = open(lockPath, flags, 0o600);
  } catch (error) {
    if (error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK" || error?.code === "EACCES") {
      const existing = readClaimerDiagnostics(lockPath);
      throw codedError(
        "claimer_lock_held",
        "another process holds the advisory claimer lock",
        { lockPath, existing },
      );
    }
    if (error?.code === "ELOOP") {
      throw codedError(
        "claimer_lock_symlink",
        "claimer lock path must not be a symbolic link",
        { lockPath },
      );
    }
    throw error;
  }

  try {
    assertSafeRegularLockFile(fd, lockPath);
    const payload = {
      version: 1,
      profile: document.profile,
      owner: document.owner,
      pid: document.pid,
      family: document.family === "codex" || document.family === "cursor-acp" ? document.family : null,
      acquiredAt: document.acquiredAt ?? now(),
      generation: document.generation ?? null,
    };
    truncate(fd, 0);
    write(fd, `${JSON.stringify(payload)}\n`, "utf8");
    try {
      sync(fd);
    } catch {
      // Best-effort; ownership is the held lock.
    }
  } catch (error) {
    try {
      close(fd);
    } catch {
      // ignore
    }
    throw error;
  }

  let released = false;
  return Object.freeze({
    fd,
    lockPath,
    release() {
      if (released) return false;
      released = true;
      try {
        close(fd);
        return true;
      } catch {
        return false;
      }
    },
  });
}
