import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { privateDir, ancestors } from "./delivery-private-path.mjs";
import { coded } from "./local-messaging-errors.mjs";

export function resolveLocalSocketAddress({ stateRoot, name = "local-control.sock" }) {
  if (process.platform === "win32") {
    throw coded(
      "unsupported_platform",
      "Windows named pipes are explicitly unsupported until restricted pipe ACL support exists",
    );
  }

  if (!stateRoot || typeof stateRoot !== "string") {
    throw coded("invalid_state_root", "stateRoot must be a non-empty string");
  }

  if (!path.isAbsolute(stateRoot)) {
    throw coded("unsafe_path", "stateRoot must be an absolute path");
  }

  if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw coded("unsafe_path", "Socket name cannot contain path separators or traversal characters");
  }

  const resolved = path.resolve(stateRoot, name);
  if (Buffer.byteLength(resolved) > 100) throw coded("unsafe_path", "Local socket path is too long; choose a shorter stateRoot");
  return {
    socketPath: resolved,
    isNamedPipe: false,
  };
}

// Path safety is the shared delivery-private-path implementation (symlinks, ownership, group- and
// world-writable ancestors); this wraps its failures in the error type callers of this module expect.
function asUnsafePath(check, message) {
  try {
    check();
  } catch (error) {
    if (error?.code === "unsafe_path") throw coded("unsafe_path", message);
    if (error?.code === "ENOENT") throw coded("unsafe_path", "Directory does not exist");
    throw error;
  }
}

export function validateSafeAncestors(targetDir) {
  asUnsafePath(
    () => ancestors(path.resolve(targetDir)),
    `Unsafe ancestor of ${targetDir}: symbolic link, foreign owner, or group- or world-writable directory`,
  );
}

export function validatePrivateDirectory(dir, { create = false } = {}) {
  if (process.platform === "win32") {
    throw coded(
      "unsupported_platform",
      "Windows named pipes are explicitly unsupported until restricted pipe ACL support exists",
    );
  }

  if (!dir || typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw coded("unsafe_path", "Directory path must be absolute");
  }

  asUnsafePath(
    () => privateDir(dir, { create }),
    `Directory ${dir} must be a canonical 0700 directory owned by the current user, with no symlink, foreign-owned or group- or world-writable ancestor`,
  );
}

export function validatePrivateSocket(socketPath) {
  if (process.platform === "win32") {
    throw coded(
      "unsupported_platform",
      "Windows named pipes are explicitly unsupported until restricted pipe ACL support exists",
    );
  }

  const st = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!st) {
    throw coded("socket_not_found", `Socket does not exist: ${socketPath}`);
  }
  if (st.isSymbolicLink()) {
    throw coded("unsafe_socket", "Socket file cannot be a symbolic link");
  }
  if (!st.isSocket()) {
    throw coded("unsafe_socket", `Path exists but is not a socket file: ${socketPath}`);
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw coded("unsafe_socket", "Socket file must be owned by current user");
  }
  if ((st.mode & 0o077) !== 0) {
    throw coded("unsafe_socket", "Socket file must be 0600 owned by current user");
  }
}

export function getSocketInode(socketPath) {
  try {
    const st = fs.lstatSync(socketPath);
    if (!st.isSocket()) return null;
    return { ino: st.ino, dev: st.dev };
  } catch {
    return null;
  }
}

export async function cleanupStaleSocket(socketPath) {
  if (process.platform === "win32") {
    throw coded(
      "unsupported_platform",
      "Windows named pipes are explicitly unsupported until restricted pipe ACL support exists",
    );
  }

  const st = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!st) return true;

  if (st.isSymbolicLink()) {
    throw coded("unsafe_socket", "Cannot clean up socket: target path is a symbolic link");
  }

  if (!st.isSocket()) {
    throw coded("unsafe_socket", "Cannot clean up socket: target path is not a socket file");
  }

  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw coded("unsafe_socket", "Cannot clean up socket owned by another user");
  }

  // Only a refused (or already vanished) connection proves nobody is listening. Any other
  // outcome (EAGAIN from a full backlog, EACCES, a timeout...) cannot prove the socket is dead,
  // and unlinking a live server's socket would silently strand it.
  const outcome = await new Promise((resolve) => {
    const conn = net.createConnection({ path: socketPath });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish("unverified"), 2000);
    conn.on("connect", () => finish("active"));
    conn.on("error", (err) => finish(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? "stale" : "unverified"));
  });

  if (outcome === "active") {
    throw coded("socket_busy", "Active server already listening on socket path");
  }
  if (outcome !== "stale") {
    throw coded("socket_busy", "Cannot verify that the socket is stale; leaving it in place");
  }

  // Re-verify it is still a socket before unlinking
  const verifySt = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!verifySt) return true; // already gone
  if (!verifySt.isSocket() || verifySt.isSymbolicLink()) {
    throw coded("unsafe_socket", "Socket changed unexpectedly during stale cleanup");
  }

  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return true;
}
