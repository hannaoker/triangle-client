import path from "node:path";
import fs from "node:fs";
import net from "node:net";
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

export function validateSafeAncestors(targetDir) {
  let curr = path.resolve(targetDir);
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(curr)) {
      const st = fs.lstatSync(curr);
      if (st.isSymbolicLink()) {
        throw coded("unsafe_path", `Ancestor directory ${curr} is a symbolic link`);
      }
      // World-writable directory without sticky bit is unsafe
      if ((st.mode & 0o002) !== 0 && (st.mode & 0o1000) === 0) {
        throw coded("unsafe_path", `Ancestor directory ${curr} is world-writable without sticky bit`);
      }
    }
    curr = path.dirname(curr);
  }
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

  validateSafeAncestors(dir);

  if (create && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (!fs.existsSync(dir)) {
    throw coded("unsafe_path", `Directory does not exist: ${dir}`);
  }

  const real = fs.realpathSync(dir);
  if (real !== dir) {
    throw coded("unsafe_path", "Symlinks in directory path are disallowed");
  }

  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw coded("unsafe_path", "Directory cannot be a symbolic link");
  }
  if (!st.isDirectory()) {
    throw coded("unsafe_path", "Target path is not a directory");
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw coded("unsafe_path", "Directory must be owned by current user");
  }
  if ((st.mode & 0o077) !== 0) {
    throw coded("unsafe_path", "Directory must be 0700 owned by current user");
  }
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

  // Attempt connection to test if process is actively listening
  const isActive = await new Promise((resolve) => {
    const conn = net.createConnection({ path: socketPath });
    let resolved = false;
    conn.on("connect", () => {
      if (!resolved) {
        resolved = true;
        conn.destroy();
        resolve(true);
      }
    });
    conn.on("error", () => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });
  });

  if (isActive) {
    throw coded("socket_busy", "Active server already listening on socket path");
  }

  // Re-verify it is still a socket before unlinking
  const verifySt = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!verifySt || !verifySt.isSocket() || verifySt.isSymbolicLink()) {
    throw coded("unsafe_socket", "Socket changed unexpectedly during stale cleanup");
  }

  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return true;
}
