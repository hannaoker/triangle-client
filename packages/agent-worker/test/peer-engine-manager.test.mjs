import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

import {
  assertSafeStateRoot,
  createIpcClient,
  createPeerEngineManager,
  filterPeerEngineEnvironment,
  validateEngineBinaryPath,
  PEER_ENGINE_ALLOWED_ENV_KEYS,
  PEER_ENGINE_IPC_PROTOCOL_VERSION,
} from "../src/peer-engine-manager.mjs";

test("filterPeerEngineEnvironment strictly excludes MESH tokens, workload keys, and controller secrets", () => {
  const dirtyEnv = {
    PATH: "/custom/bin:/usr/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    HOME: "/Users/test",
    TMPDIR: "/tmp/test",
    RUST_LOG: "info",
    MESH_AGENT_TOKEN: "stolen-mesh-token",
    MESH_ORIGIN: "https://mesh.thetriangle.dev",
    TRIANGLE_WORKLOAD_KEY_FILE: "/secret/key.json",
    CONTROLLER_CREDENTIAL: "super-secret-controller",
    BEARER_TOKEN: "bearer-xyz",
    SECRET_KEY: "secret-abc",
    UNRELATED_SECRET: "nope",
  };

  const clean = filterPeerEngineEnvironment(dirtyEnv);

  assert.equal(clean.PATH, "/custom/bin:/usr/bin");
  assert.equal(clean.LANG, "en_US.UTF-8");
  assert.equal(clean.LC_ALL, "en_US.UTF-8");
  assert.equal(clean.HOME, "/Users/test");
  assert.equal(clean.TMPDIR, "/tmp/test");
  assert.equal(clean.RUST_LOG, "info");

  assert.equal(clean.MESH_AGENT_TOKEN, undefined);
  assert.equal(clean.MESH_ORIGIN, undefined);
  assert.equal(clean.TRIANGLE_WORKLOAD_KEY_FILE, undefined);
  assert.equal(clean.CONTROLLER_CREDENTIAL, undefined);
  assert.equal(clean.BEARER_TOKEN, undefined);
  assert.equal(clean.SECRET_KEY, undefined);
  assert.equal(clean.UNRELATED_SECRET, undefined);

  for (const key of Object.keys(clean)) {
    assert.ok(PEER_ENGINE_ALLOWED_ENV_KEYS.includes(key));
  }
});

test("assertSafeStateRoot enforces 0700 canonical directory and rejects symlinks or permissive modes", () => {
  const tmp = realpathSync(mkdtempSync("/tmp/p-mgr-"));
  try {
    const validDir = path.join(tmp, "valid-state");
    mkdirSync(validDir, { mode: 0o700 });
    assert.doesNotThrow(() => assertSafeStateRoot(validDir));

    // Permissive mode (e.g. 0755) fails
    const badMode = path.join(tmp, "bad-mode");
    mkdirSync(badMode, { mode: 0o755 });
    chmodSync(badMode, 0o755);
    assert.throws(() => assertSafeStateRoot(badMode), /unsafe_state_root/);

    // Symlink fails
    const symlinkPath = path.join(tmp, "symlink-state");
    symlinkSync(validDir, symlinkPath);
    assert.throws(() => assertSafeStateRoot(symlinkPath), /unsafe_state_root/);

    // Relative path fails
    assert.throws(() => assertSafeStateRoot("relative/path"), /unsafe_state_root/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("createIpcClient completes hello negotiation and handles requests/responses with length framing", async () => {
  const tmp = realpathSync(mkdtempSync("/tmp/p-ipc-"));
  const socketDir = path.join(tmp, "ipc");
  mkdirSync(socketDir, { mode: 0o700 });
  const socketPath = path.join(socketDir, "peer-engine.sock");
  const testEndpointId = "a".repeat(64);

  const server = net.createServer((conn) => {
    let buf = Buffer.alloc(0);
    conn.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const body = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
        buf = buf.subarray(4 + len);

        let resp;
        if (body.method === "hello") {
          resp = {
            protocol_version: PEER_ENGINE_IPC_PROTOCOL_VERSION,
            id: body.id,
            result: {
              protocol_version: PEER_ENGINE_IPC_PROTOCOL_VERSION,
              endpoint_id: testEndpointId,
              engine_version: "0.1.0",
              alpn: "triangle-peer/1",
            },
          };
        } else if (body.method === "status") {
          resp = {
            protocol_version: PEER_ENGINE_IPC_PROTOCOL_VERSION,
            id: body.id,
            result: {
              endpoint_id: testEndpointId,
              inbox_count: 3,
            },
          };
        } else {
          resp = {
            protocol_version: PEER_ENGINE_IPC_PROTOCOL_VERSION,
            id: body.id,
            error: { code: "unknown_method", message: "Unknown method" },
          };
        }

        const respBytes = Buffer.from(JSON.stringify(resp));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(respBytes.length);
        conn.write(Buffer.concat([header, respBytes]));
      }
    });
  });

  await new Promise((resolve) => server.listen(socketPath, resolve));
  chmodSync(socketPath, 0o600);

  try {
    const client = createIpcClient({ socketPath });
    const status = await client.request("status", {});
    assert.equal(status.endpoint_id, testEndpointId);
    assert.equal(status.inbox_count, 3);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("createPeerEngineManager handles spawn, ready negotiation, and clean stop", async () => {
  const tmp = realpathSync(mkdtempSync("/tmp/p-spw-"));
  const stateRoot = path.join(tmp, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  const socketDir = path.join(stateRoot, "ipc");
  mkdirSync(socketDir, { mode: 0o700 });
  const socketPath = path.join(socketDir, "peer-engine.sock");
  const testEndpointId = "b".repeat(64);

  const server = net.createServer((conn) => {
    let buf = Buffer.alloc(0);
    conn.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const body = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
        buf = buf.subarray(4 + len);

        let resp;
        if (body.method === "hello") {
          resp = {
            protocol_version: PEER_ENGINE_IPC_PROTOCOL_VERSION,
            id: body.id,
            result: {
              protocol_version: PEER_ENGINE_IPC_PROTOCOL_VERSION,
              endpoint_id: testEndpointId,
              engine_version: "0.1.0",
              alpn: "triangle-peer/1",
            },
          };
        } else if (body.method === "status") {
          resp = {
            protocol_version: PEER_ENGINE_IPC_PROTOCOL_VERSION,
            id: body.id,
            result: { endpoint_id: testEndpointId, inbox_count: 0 },
          };
        } else if (body.method === "shutdown") {
          resp = {
            protocol_version: PEER_ENGINE_IPC_PROTOCOL_VERSION,
            id: body.id,
            result: { shutdown: true },
          };
        }
        const respBytes = Buffer.from(JSON.stringify(resp));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(respBytes.length);
        conn.write(Buffer.concat([header, respBytes]));
      }
    });
  });

  // Fake child process that stays alive until stop()
  const fakeChild = new EventEmitter();
  fakeChild.pid = 12345;
  fakeChild.exitCode = null;
  fakeChild.stderr = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.kill = (sig) => {
    fakeChild.emit(sig);
    setTimeout(() => {
      fakeChild.exitCode = 0;
      fakeChild.emit("exit", 0, sig);
    }, 10);
  };

  let spawnedArgs = null;
  let spawnedEnv = null;
  const mockSpawn = (cmd, args, options) => {
    spawnedArgs = args;
    spawnedEnv = options.env;
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      fakeChild.stderr.emit(
        "data",
        `peer-engine ready endpoint_id=${testEndpointId} ipc=${socketPath}\n`,
      );
    });
    return fakeChild;
  };

  const manager = createPeerEngineManager({
    stateRoot,
    allowedPeers: ["c".repeat(64)],
    directOnly: true,
    spawnImpl: mockSpawn,
    binaryPath: "/bin/echo",
  });

  try {
    const ready = await manager.start();
    assert.equal(ready.endpointId, testEndpointId);
    assert.equal(manager.isRunning, true);
    assert.ok(spawnedArgs.includes("--direct-only"));
    assert.ok(spawnedArgs.includes("--allow-peer"));
    assert.ok(spawnedArgs.includes("c".repeat(64)));

    // Ensure clean environment without MESH tokens
    assert.equal(spawnedEnv.MESH_AGENT_TOKEN, undefined);

    // Stop shuts down cleanly
    setTimeout(() => {
      fakeChild.exitCode = 0;
      fakeChild.emit("exit", 0, null);
    }, 50);
    await manager.stop();
    assert.equal(manager.isRunning, false);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validateEngineBinaryPath enforces absolute path, regular file, not symlink, secure mode, executable", () => {
  const tmp = realpathSync(mkdtempSync("/tmp/p-bin-"));
  try {
    // Relative path
    assert.throws(() => validateEngineBinaryPath("relative/peer-engine"), /invalid_binary_path/);

    // Non-existent
    assert.throws(() => validateEngineBinaryPath(path.join(tmp, "missing")), /ENOENT/);

    // Regular file but not executable (0600)
    const nonExec = path.join(tmp, "non-exec");
    writeFileSync(nonExec, "#!/bin/sh\n", { mode: 0o600 });
    assert.throws(() => validateEngineBinaryPath(nonExec), /EACCES/);

    // Group-writable (0775)
    const groupWritable = path.join(tmp, "group-writable");
    writeFileSync(groupWritable, "#!/bin/sh\n");
    chmodSync(groupWritable, 0o775);
    assert.throws(() => validateEngineBinaryPath(groupWritable), /unsafe_file/);

    // Symlink
    const valid = path.join(tmp, "valid-bin");
    writeFileSync(valid, "#!/bin/sh\n", { mode: 0o700 });
    const symlink = path.join(tmp, "symlink-bin");
    symlinkSync(valid, symlink);
    assert.throws(() => validateEngineBinaryPath(symlink), /unsafe_file/);

    // Valid executable
    assert.equal(validateEngineBinaryPath(valid), valid);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("peer engine manager start is single-flight and getIpcClient throws when not ready", async () => {
  const tmp = realpathSync(mkdtempSync("/tmp/p-sf-"));
  const stateRoot = path.join(tmp, "state");
  mkdirSync(stateRoot, { mode: 0o700 });

  const fakeChild = new EventEmitter();
  fakeChild.pid = 999;
  fakeChild.exitCode = null;
  fakeChild.stderr = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.kill = (sig) => {
    fakeChild.exitCode = 0;
    fakeChild.emit("exit", 0, sig);
  };

  const manager = createPeerEngineManager({
    stateRoot,
    binaryPath: "/bin/echo",
    spawnImpl: () => fakeChild,
  });

  try {
    // Before start: getIpcClient throws engine_not_ready
    assert.throws(() => manager.getIpcClient(), (err) => err.code === "engine_not_ready");

    // Concurrent start calls share the same promise
    const p1 = manager.start();
    const p2 = manager.start();
    assert.equal(p1, p2);

    await new Promise((r) => setImmediate(r));

    // Emit error to abort start
    fakeChild.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
    await assert.rejects(p1, (err) => err.code === "ENOENT");
    await assert.rejects(p2, (err) => err.code === "ENOENT");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("peer engine manager runs fake-peer-engine fixture, reads stderr ready, and stops via SIGINT", async () => {
  const tmp = realpathSync(mkdtempSync("/tmp/p-fake-"));
  const stateRoot = path.join(tmp, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  const fakeFixture = path.resolve(import.meta.dirname, "fixtures/fake-peer-engine.mjs");

  const manager = createPeerEngineManager({
    stateRoot,
    binaryPath: fakeFixture,
    allowedPeers: ["f".repeat(64)],
  });

  try {
    const ready = await manager.start();
    assert.ok(ready.endpointId);
    assert.equal(manager.isRunning, true);

    const client = manager.getIpcClient();
    const st = await client.request("status", {});
    assert.equal(st.endpoint_id, ready.endpointId);

    // Stop sends SIGINT
    await manager.stop();
    assert.equal(manager.isRunning, false);

    // Graceful SIGINT creates graceful-exit file
    assert.ok(existsSync(path.join(stateRoot, "graceful-exit")), "fake-peer-engine should handle SIGINT gracefully");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
