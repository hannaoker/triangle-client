import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import {
  resolveLocalSocketAddress,
  validatePrivateDirectory,
  validateSafeAncestors,
  validatePrivateSocket,
  cleanupStaleSocket,
} from "../src/local-messaging-address.mjs";
import { LocalMessagingError } from "../src/local-messaging-errors.mjs";

function makeTmpDir(prefix) {
  const realTmp = fs.realpathSync(os.tmpdir());
  return fs.mkdtempSync(path.join(realTmp, prefix));
}

test("resolveLocalSocketAddress validates paths and rejects traversal", () => {
  if (process.platform === "win32") {
    assert.throws(
      () => resolveLocalSocketAddress({ stateRoot: "C:\\state", name: "control.sock" }),
      (err) => err instanceof LocalMessagingError && err.code === "unsupported_platform",
    );
    return;
  }

  const tmpDir = makeTmpDir("triangle-sock-test-");
  try {
    const addr = resolveLocalSocketAddress({ stateRoot: tmpDir, name: "control.sock" });
    assert.ok(addr);
    assert.equal(addr.socketPath, path.join(tmpDir, "control.sock"));

    // Relative stateRoot must be rejected
    assert.throws(
      () => resolveLocalSocketAddress({ stateRoot: "relative/path", name: "control.sock" }),
      (err) => err instanceof LocalMessagingError && err.code === "unsafe_path",
    );

    // Path traversal in socket name must be rejected
    assert.throws(
      () => resolveLocalSocketAddress({ stateRoot: tmpDir, name: "../traversal.sock" }),
      (err) => err instanceof LocalMessagingError && err.code === "unsafe_path",
    );
    assert.throws(
      () => resolveLocalSocketAddress({ stateRoot: tmpDir, name: "sub/dir.sock" }),
      (err) => err instanceof LocalMessagingError && err.code === "unsafe_path",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("validatePrivateDirectory enforces permissions, absolute paths, and disallows symlinks", { skip: process.platform === "win32" }, () => {
  const tmpDir = makeTmpDir("triangle-priv-test-");
  try {
    fs.chmodSync(tmpDir, 0o700);
    assert.doesNotThrow(() => validatePrivateDirectory(tmpDir));

    // Relative directory rejected
    assert.throws(
      () => validatePrivateDirectory("relative/test/dir"),
      (err) => err instanceof LocalMessagingError && err.code === "unsafe_path",
    );

    // World-writable directory must be rejected
    fs.chmodSync(tmpDir, 0o777);
    assert.throws(() => validatePrivateDirectory(tmpDir), (err) => {
      return err instanceof LocalMessagingError && err.code === "unsafe_path";
    });

    // Symlink directory must be rejected
    const symlinkDir = path.join(tmpDir, "symlink-dir");
    fs.symlinkSync(tmpDir, symlinkDir);
    assert.throws(() => validatePrivateDirectory(symlinkDir), (err) => {
      return err instanceof LocalMessagingError && err.code === "unsafe_path";
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("validatePrivateSocket enforces socket file permissions and disallows symlinks/regular files", { skip: process.platform === "win32" }, async () => {
  const tmpDir = makeTmpDir("triangle-sockpriv-");
  const sockPath = path.join(tmpDir, "test.sock");
  fs.chmodSync(tmpDir, 0o700);

  const server = net.createServer();
  try {
    await new Promise((res, rej) => {
      server.listen(sockPath, () => {
        fs.chmodSync(sockPath, 0o600);
        res();
      });
      server.on("error", rej);
    });

    assert.doesNotThrow(() => validatePrivateSocket(sockPath));

    // Loose socket permissions must be rejected
    fs.chmodSync(sockPath, 0o666);
    assert.throws(() => validatePrivateSocket(sockPath), (err) => {
      return err instanceof LocalMessagingError && err.code === "unsafe_socket";
    });
  } finally {
    await new Promise((res) => server.close(res));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cleanupStaleSocket never unlinks regular files or symlinks, and cleans dead sockets", { skip: process.platform === "win32" }, async () => {
  const tmpDir = makeTmpDir("triangle-stale-");
  fs.chmodSync(tmpDir, 0o700);

  // 1. Regular file protection: cleanupStaleSocket MUST NOT unlink regular files!
  const regularFile = path.join(tmpDir, "not-a-socket.txt");
  fs.writeFileSync(regularFile, "important data");
  await assert.rejects(
    async () => cleanupStaleSocket(regularFile),
    (err) => err instanceof LocalMessagingError && err.code === "unsafe_socket",
  );
  assert.equal(fs.existsSync(regularFile), true, "Regular file must NOT be unlinked!");

  // 2. Symlink protection: cleanupStaleSocket MUST NOT unlink symlinks!
  const symlinkTarget = path.join(tmpDir, "symlink-socket.sock");
  fs.symlinkSync(regularFile, symlinkTarget);
  await assert.rejects(
    async () => cleanupStaleSocket(symlinkTarget),
    (err) => err instanceof LocalMessagingError && err.code === "unsafe_socket",
  );
  assert.equal(fs.lstatSync(symlinkTarget).isSymbolicLink(), true, "Symlink must NOT be unlinked!");

  // 3. Active socket detection
  const sockPath = path.join(tmpDir, "active.sock");
  const server = net.createServer();
  await new Promise((res, rej) => {
    server.listen(sockPath, () => {
      fs.chmodSync(sockPath, 0o600);
      res();
    });
    server.on("error", rej);
  });

  try {
    await assert.rejects(
      async () => cleanupStaleSocket(sockPath),
      (err) => err instanceof LocalMessagingError && err.code === "socket_busy",
    );
  } finally {
    await new Promise((res) => server.close(res));
  }

  // 4. Dead socket cleanup: a dead process killed via SIGKILL leaves a real socket inode on disk
  const deadSockPath = path.join(tmpDir, "dead.sock");
  const childScript = `
    import net from "node:net";
    import fs from "node:fs";
    const server = net.createServer();
    server.listen("${deadSockPath}", () => {
      fs.chmodSync("${deadSockPath}", 0o600);
      process.stdout.write("BOUND\\n");
    });
  `;
  const child = spawn("node", ["--input-type=module", "-e", childScript], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("BOUND")) resolve();
    });
    child.on("error", reject);
  });

  // SIGKILL immediately terminates child without running server.close / unlinking socket file
  child.kill("SIGKILL");
  await new Promise((res) => child.on("close", res));

  // The socket file still exists and is a dead socket inode
  assert.equal(fs.existsSync(deadSockPath), true);
  assert.equal(fs.lstatSync(deadSockPath).isSocket(), true);

  const cleaned = await cleanupStaleSocket(deadSockPath);
  assert.equal(cleaned, true);
  assert.equal(fs.existsSync(deadSockPath), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("cleanupStaleSocket only removes a socket it can prove is dead, never one it merely failed to reach", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const tmpDir = makeTmpDir("triangle-stale-live-");
  fs.chmodSync(tmpDir, 0o700);
  const sockPath = path.join(tmpDir, "live.sock");
  const server = net.createServer((socket) => socket.end("alive"));
  try {
    await new Promise((res, rej) => {
      server.listen(sockPath, () => res());
      server.on("error", rej);
    });
    // A live server that cannot be connected to (EACCES) is not a stale socket.
    fs.chmodSync(sockPath, 0o000);
    await assert.rejects(
      async () => cleanupStaleSocket(sockPath),
      (err) => err instanceof LocalMessagingError && err.code === "socket_busy",
    );
    assert.equal(fs.lstatSync(sockPath).isSocket(), true, "an unverifiable socket must be left alone");
    // The server is still reachable once the permissions are restored.
    fs.chmodSync(sockPath, 0o600);
    const reply = await new Promise((resolve, reject) => {
      const conn = net.createConnection({ path: sockPath });
      let data = "";
      conn.on("data", (chunk) => { data += chunk; });
      conn.on("end", () => resolve(data));
      conn.on("error", reject);
    });
    assert.equal(reply, "alive");
  } finally {
    await new Promise((res) => server.close(res));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("private directory checks reject group-writable ancestors, as the shared journal path checks do", { skip: process.platform === "win32" }, () => {
  const base = makeTmpDir("triangle-ancestors-");
  try {
    fs.chmodSync(base, 0o700);
    const ancestor = path.join(base, "shared");
    const target = path.join(ancestor, "private");
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.chmodSync(ancestor, 0o755);
    assert.doesNotThrow(() => validateSafeAncestors(target));
    assert.doesNotThrow(() => validatePrivateDirectory(target));

    fs.chmodSync(ancestor, 0o775);
    for (const check of [() => validateSafeAncestors(target), () => validatePrivateDirectory(target)]) {
      assert.throws(check, (err) => err instanceof LocalMessagingError && err.code === "unsafe_path");
    }
    // Creating a private directory beneath such an ancestor is refused before anything is made.
    assert.throws(
      () => validatePrivateDirectory(path.join(ancestor, "new", "deeper"), { create: true }),
      (err) => err instanceof LocalMessagingError && err.code === "unsafe_path",
    );
    assert.equal(fs.existsSync(path.join(ancestor, "new")), false);
    // Non-canonical and missing directories keep their unsafe_path code.
    fs.chmodSync(ancestor, 0o755);
    assert.throws(() => validatePrivateDirectory(`${target}/`), (err) => err.code === "unsafe_path");
    assert.throws(() => validatePrivateDirectory(path.join(ancestor, "missing")), (err) => err.code === "unsafe_path");
    assert.doesNotThrow(() => validatePrivateDirectory(path.join(ancestor, "created"), { create: true }));
    assert.equal(fs.statSync(path.join(ancestor, "created")).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
