import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";

export const PEER_ENGINE_IPC_PROTOCOL_VERSION = 1;
export const MAX_IPC_REQUEST_BYTES = 1024 * 1024;
export const MAX_IPC_RESPONSE_BYTES = 2 * 1024 * 1024;

export const PEER_ENGINE_ALLOWED_ENV_KEYS = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "HOME",
  "TMPDIR",
  "RUST_LOG",
]);

const FORBIDDEN_ENV_SUBSTRINGS = ["MESH", "WORKLOAD", "CONTROLLER", "BEARER", "SECRET", "KEY"];

function coded(code, message = code) {
  const err = new Error(message === code ? code : `${code}: ${message}`);
  err.code = code;
  return err;
}

export function filterPeerEngineEnvironment(sourceEnv = process.env) {
  const filtered = {};
  for (const key of Object.keys(sourceEnv)) {
    const upper = key.toUpperCase();
    if (FORBIDDEN_ENV_SUBSTRINGS.some((sub) => upper.includes(sub))) {
      // Strictly exclude any credential-bearing or MESH environment variables
      continue;
    }
    if (PEER_ENGINE_ALLOWED_ENV_KEYS.includes(key)) {
      if (typeof sourceEnv[key] === "string") {
        filtered[key] = sourceEnv[key];
      }
    }
  }
  // Ensure basic safe defaults if missing
  filtered.PATH = filtered.PATH || "/usr/bin:/bin";
  filtered.LANG = filtered.LANG || "C";
  filtered.LC_ALL = filtered.LC_ALL || "C";
  return filtered;
}

export function assertSafeStateRoot(stateRoot, { create = false } = {}) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot) || stateRoot.includes("\0")) {
    throw coded("unsafe_state_root", "stateRoot must be an absolute path");
  }
  if (path.resolve(stateRoot) !== stateRoot) {
    throw coded("unsafe_state_root", "stateRoot must be canonical");
  }
  if (create && !existsSync(stateRoot)) {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  }
  if (realpathSync(stateRoot) !== stateRoot) {
    throw coded("unsafe_state_root", "stateRoot must not contain symlinks");
  }
  const stat = lstatSync(stateRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw coded("unsafe_state_root", "stateRoot must be a regular directory");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw coded("unsafe_state_root", "stateRoot must be owned by the current user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw coded("unsafe_state_root", "stateRoot must have mode 0700");
  }
}

export function createIpcClient({ socketPath, timeoutMs = 30000 }) {
  if (
    typeof socketPath !== "string" ||
    !path.isAbsolute(socketPath) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  ) {
    throw coded("invalid_ipc_options", "Invalid IPC options");
  }

  return Object.freeze({
    async request(method, params = {}, { signal } = {}) {
      signal?.throwIfAborted();
      assertSafeStateRoot(path.dirname(socketPath));
      const st = lstatSync(socketPath);
      if (
        !st.isSocket() ||
        st.isSymbolicLink() ||
        (typeof process.getuid === "function" && st.uid !== process.getuid()) ||
        (st.mode & 0o077) !== 0
      ) {
        throw coded("unsafe_socket", "IPC socket has unsafe permissions or is not a socket");
      }

      const socket = net.createConnection({ path: socketPath });
      let buffer = Buffer.alloc(0);
      let pending = null;
      let fatal = null;

      const stop = (error) => {
        fatal ??= error;
        pending?.reject(fatal);
        pending = null;
        socket.destroy();
      };

      const timer = setTimeout(() => stop(coded("ipc_timeout", "IPC request timed out")), timeoutMs);
      const abort = () => stop(coded("aborted", "IPC request aborted"));
      signal?.addEventListener("abort", abort, { once: true });

      socket.on("error", (err) => stop(coded("ipc_disconnected", err.message)));
      socket.on("close", () => {
        if (pending) stop(coded("ipc_disconnected", "IPC socket closed unexpectedly"));
      });

      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_IPC_RESPONSE_BYTES + 4) {
          return stop(coded("ipc_oversized", "IPC response exceeded maximum allowed bytes"));
        }
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE(0);
          if (size < 2 || size > MAX_IPC_RESPONSE_BYTES) {
            return stop(coded("ipc_oversized", "IPC response frame invalid or oversized"));
          }
          if (buffer.length < 4 + size) return;
          let value;
          try {
            value = JSON.parse(buffer.subarray(4, 4 + size).toString("utf8"));
          } catch {
            return stop(coded("ipc_invalid", "IPC response is not valid JSON"));
          }
          buffer = buffer.subarray(4 + size);
          if (
            !pending ||
            value.protocol_version !== PEER_ENGINE_IPC_PROTOCOL_VERSION ||
            value.id !== pending.id ||
            (!Object.hasOwn(value, "result") && !value.error) ||
            (value.error && Object.hasOwn(value, "result"))
          ) {
            return stop(coded("ipc_invalid", "Malformed IPC response"));
          }
          const p = pending;
          pending = null;
          if (value.error) {
            const errCode =
              typeof value.error.code === "string" && /^[a-z_]{1,64}$/.test(value.error.code)
                ? value.error.code
                : "ipc_error";
            p.reject(coded(errCode, value.error.message || errCode));
          } else {
            p.resolve(value.result);
          }
        }
      });

      const call = (name, args) =>
        new Promise((resolve, reject) => {
          if (fatal) return reject(fatal);
          const id = randomUUID();
          const body = Buffer.from(
            JSON.stringify({
              protocol_version: PEER_ENGINE_IPC_PROTOCOL_VERSION,
              id,
              method: name,
              params: args,
            }),
          );
          if (body.length > MAX_IPC_REQUEST_BYTES) {
            return reject(coded("ipc_oversized", "IPC request exceeds max bytes"));
          }
          pending = { id, resolve, reject };
          const header = Buffer.alloc(4);
          header.writeUInt32BE(body.length);
          socket.write(Buffer.concat([header, body]));
        });

      try {
        const hello = await call("hello", {});
        if (
          hello?.protocol_version !== PEER_ENGINE_IPC_PROTOCOL_VERSION ||
          typeof hello?.endpoint_id !== "string" ||
          !/^[a-f0-9]{64}$/.test(hello.endpoint_id)
        ) {
          throw coded("ipc_invalid_hello", "Peer engine returned invalid hello response");
        }
        signal?.throwIfAborted();
        return await call(method, params);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
      }
    },
  });
}

function resolveBinaryPath(specifiedPath) {
  if (specifiedPath) {
    if (!path.isAbsolute(specifiedPath)) {
      throw coded("invalid_binary_path", "Engine binary path must be absolute");
    }
    if (!existsSync(specifiedPath)) {
      throw coded("binary_not_found", `Engine binary not found at ${specifiedPath}`);
    }
    return specifiedPath;
  }

  const projectRoot = process.env.TRIANGLE_PROJECT_ROOT;
  const home = process.env.HOME;
  const candidates = [
    projectRoot ? path.join(projectRoot, "bin/peer-engine") : null,
    home ? path.join(home, "Library/Application Support/The Triangle/bin/peer-engine") : null,
    path.resolve(import.meta.dirname, "../../../peer-engine/target/release/peer-engine"),
    path.resolve(import.meta.dirname, "../../../peer-engine/target/debug/peer-engine"),
    "/usr/local/bin/peer-engine",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const stat = lstatSync(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          return candidate;
        }
      } catch {}
    }
  }

  // Fallback to searching PATH if available
  return "peer-engine";
}

export function createPeerEngineManager({
  stateRoot,
  allowedPeers = [],
  relay = "default",
  relayOnly = false,
  directOnly = false,
  relayUrl = null,
  binaryPath = null,
  logger = console,
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  assertSafeStateRoot(stateRoot, { create: true });
  const socketPath = path.join(stateRoot, "ipc/peer-engine.sock");
  let child = null;
  let running = false;
  let stopping = false;
  const exitListeners = new Set();
  let endpointId = null;
  let ipcClient = null;

  function buildArgs() {
    const args = ["--state-dir", stateRoot];
    if (directOnly || relay === "direct-only") {
      args.push("--direct-only");
    } else if (relayOnly || relay === "relay-only") {
      args.push("--relay-only");
    } else if (typeof relayUrl === "string" && relayUrl.startsWith("https://")) {
      args.push("--relay-url", relayUrl);
    }
    for (const peer of allowedPeers) {
      if (typeof peer === "string" && /^[a-f0-9]{64}$/.test(peer)) {
        args.push("--allow-peer", peer);
      }
    }
    return args;
  }

  async function waitForReady(timeoutMs = 15000, signal = null) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      signal?.throwIfAborted();
      if (!child || child.exitCode !== null) {
        throw coded("engine_crashed", "peer-engine process exited unexpectedly before ready");
      }
      if (existsSync(socketPath)) {
        try {
          const client = createIpcClient({ socketPath, timeoutMs: 2000 });
          const status = await client.request("status", {}, { signal });
          if (status?.endpoint_id) {
            endpointId = status.endpoint_id;
            return { endpointId, socketPath };
          }
        } catch {
          // Socket might not be listening yet, retry
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw coded("engine_timeout", "peer-engine startup timed out waiting for socket");
  }

  return Object.freeze({
    stateRoot,
    socketPath,
    get endpointId() {
      return endpointId;
    },
    get isRunning() {
      return running;
    },
    getIpcClient(timeoutMs = 30000) {
      if (!running && !existsSync(socketPath)) {
        throw coded("engine_not_running", "peer-engine is not running");
      }
      ipcClient ??= createIpcClient({ socketPath, timeoutMs });
      return ipcClient;
    },
    async start({ signal } = {}) {
      if (running) {
        return { endpointId, socketPath };
      }
      signal?.throwIfAborted();
      assertSafeStateRoot(stateRoot, { create: true });
      const executable = resolveBinaryPath(binaryPath);
      const args = buildArgs();
      const childEnv = filterPeerEngineEnvironment(env);

      logger.info?.("triangle_peer_engine_starting", {
        stateRoot,
        executable,
        allowedPeersCount: allowedPeers.length,
      });

      child = spawnImpl(executable, args, {
        cwd: stateRoot,
        env: childEnv,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      running = true;
      child.on("exit", (code, sig) => {
        running = false;
        logger.info?.("triangle_peer_engine_exited", { stateRoot, code, signal: sig });
      });

      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.includes("WARN") || text.includes("ERROR")) {
          logger.warn?.("triangle_peer_engine_stderr", { message: text.trim().slice(0, 500) });
        }
      });

      try {
        const ready = await waitForReady(15000, signal);
        return ready;
      } catch (err) {
        await this.stop();
        throw err;
      }
    },
    async stop() {
      if (!child && !running) return;
      running = false;
      const proc = child;
      child = null;
      if (proc && proc.exitCode === null) {
        try {
          const client = createIpcClient({ socketPath, timeoutMs: 2000 });
          await client.request("shutdown", {});
        } catch {
          // Fall through to process termination
        }
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              if (process.platform !== "win32") {
                process.kill(-proc.pid, "SIGKILL");
              } else {
                proc.kill("SIGKILL");
              }
            } catch {}
            resolve();
          }, 2000);
          proc.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  });
}
