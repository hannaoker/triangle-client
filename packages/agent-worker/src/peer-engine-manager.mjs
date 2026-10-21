import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { privateDir } from "./peer/private-path.mjs";
import { createIpcClient } from "./peer/ipc-client.mjs";

export { createIpcClient };

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
      continue;
    }
    if (PEER_ENGINE_ALLOWED_ENV_KEYS.includes(key)) {
      if (typeof sourceEnv[key] === "string") {
        filtered[key] = sourceEnv[key];
      }
    }
  }
  filtered.PATH = filtered.PATH || "/usr/bin:/bin";
  filtered.LANG = filtered.LANG || "C";
  filtered.LC_ALL = filtered.LC_ALL || "C";
  return filtered;
}

export function assertSafeStateRoot(stateRoot, { create = false } = {}) {
  try {
    privateDir(stateRoot, { create });
  } catch (err) {
    throw coded("unsafe_state_root", err.message);
  }
}

export function validateEngineBinaryPath(specifiedPath) {
  if (typeof specifiedPath !== "string" || !path.isAbsolute(specifiedPath)) {
    throw coded("invalid_binary_path", "Engine binary path must be an absolute path");
  }
  const stat = lstatSync(specifiedPath, { throwIfNoEntry: false });
  if (!stat) {
    throw coded("ENOENT", `Engine binary not found at ${specifiedPath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw coded("unsafe_file", `Engine binary must be a regular file: ${specifiedPath}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid() && stat.uid !== 0) {
    throw coded("unsafe_file", `Engine binary must be owned by the current user or root: ${specifiedPath}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw coded("unsafe_file", `Engine binary must not be group- or world-writable: ${specifiedPath}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw coded("EACCES", `Engine binary is not executable: ${specifiedPath}`);
  }
  return specifiedPath;
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
  let state = "stopped"; // stopped | starting | ready | stopping | exited
  let endpointId = null;
  let ipcClient = null;
  let startPromise = null;
  let stopPromise = null;

  function buildArgs() {
    const args = ["--state-dir", stateRoot];
    if (directOnly || relay === "direct-only") {
      args.push("--direct-only");
    } else if (relayOnly || relay === "relay-only") {
      args.push("--relay-only");
      if (typeof relayUrl === "string" && relayUrl.startsWith("https://")) {
        args.push("--relay-url", relayUrl);
      }
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

  async function probeExistingSocket() {
    if (!existsSync(socketPath)) return;
    await new Promise((resolve, reject) => {
      const conn = net.createConnection(socketPath);
      conn.once("connect", () => {
        conn.destroy();
        reject(coded("engine_already_running", `Peer engine socket already listening at ${socketPath}`));
      });
      conn.once("error", () => {
        conn.destroy();
        try {
          rmSync(socketPath, { force: true });
        } catch {}
        resolve();
      });
    });
  }

  return Object.freeze({
    stateRoot,
    socketPath,
    get state() {
      return state;
    },
    get endpointId() {
      return endpointId;
    },
    get isRunning() {
      return state === "ready";
    },

    getIpcClient(timeoutMs = 30000) {
      if (state !== "ready") {
        throw coded("engine_not_ready", "peer-engine is not ready");
      }
      ipcClient ??= createIpcClient({ socketPath, timeoutMs });
      return ipcClient;
    },

    start({ signal } = {}) {
      try {
        if (state === "ready") {
          return Promise.resolve({ endpointId, socketPath });
        }
        if (state === "starting" && startPromise) {
          return startPromise;
        }
        if (state === "stopping") {
          return Promise.reject(coded("engine_busy", "peer-engine is stopping"));
        }

        signal?.throwIfAborted();
        assertSafeStateRoot(stateRoot, { create: true });
        const executable = validateEngineBinaryPath(binaryPath ?? "peer-engine");

        state = "starting";
        endpointId = null;
        ipcClient = null;

        const run = async () => {
          await probeExistingSocket();

        return new Promise((resolve, reject) => {
          let settled = false;
          let pollInterval = null;
          let timer = null;
          let onAbort = null;

          const cleanupTimers = () => {
            if (pollInterval) clearInterval(pollInterval);
            if (timer) clearTimeout(timer);
            if (onAbort && signal) signal.removeEventListener("abort", onAbort);
          };

          const settleResolve = (val) => {
            if (settled) return;
            settled = true;
            cleanupTimers();
            state = "ready";
            startPromise = null;
            resolve(val);
          };
          const settleReject = (err) => {
            if (settled) return;
            settled = true;
            cleanupTimers();
            startPromise = null;
            reject(err);
          };

          const args = buildArgs();
          const childEnv = filterPeerEngineEnvironment(env);

          logger.info?.("triangle_peer_engine_starting", {
            stateRoot,
            executable,
            allowedPeersCount: allowedPeers.length,
          });

          try {
            child = spawnImpl(executable, args, {
              cwd: stateRoot,
              env: childEnv,
              detached: false,
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch (err) {
            return settleReject(coded(err.code ?? "spawn_failed", err.message));
          }

          const proc = child;

          if (proc.exitCode !== null) {
            return settleReject(coded("engine_crashed", `peer-engine exited unexpectedly with code ${proc.exitCode}`));
          }

          proc.once("error", (err) => {
            settleReject(coded(err.code ?? "spawn_failed", err.message));
          });

          proc.once("exit", (code, sig) => {
            if (state === "ready") {
              state = "exited";
              logger.warn?.("triangle_peer_engine_exited", { code, signal: sig });
            } else if (state === "stopping") {
              state = "stopped";
            } else {
              settleReject(coded("engine_crashed", `peer-engine exited unexpectedly with code ${code}`));
            }
          });

          let stderrReady = false;
          let lineCount = 0;
          let droppedCount = 0;
          let resetAt = Date.now() + 1000;

          async function verifyHello() {
            try {
              const client = createIpcClient({ socketPath, timeoutMs: 2000 });
              const hello = await client.request("hello", {}, { signal });
              if (hello?.endpoint_id === endpointId) {
                settleResolve({ endpointId, socketPath });
              }
            } catch {
              // Keep waiting until timeout if socket not ready yet
            }
          }

          function drainStream(stream, isStderr) {
            if (!stream) return;
            let buf = "";
            stream.on("data", (chunk) => {
              buf += chunk.toString("utf8");
              const lines = buf.split(/\r?\n/);
              buf = lines.pop();

              const nowTime = Date.now();
              if (nowTime > resetAt) {
                if (droppedCount > 0) {
                  logger.warn?.("triangle_peer_engine_lines_dropped", { droppedCount });
                }
                lineCount = 0;
                droppedCount = 0;
                resetAt = nowTime + 1000;
              }

              for (const rawLine of lines) {
                lineCount++;
                if (lineCount > 50) {
                  droppedCount++;
                  continue;
                }
                const line = rawLine.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 500);
                if (!line) continue;

                if (isStderr) {
                  const match = line.match(/^peer-engine ready endpoint_id=([a-f0-9]{64}) ipc=(.*)$/);
                  if (match) {
                    endpointId = match[1];
                    stderrReady = true;
                    verifyHello();
                  }
                }

                if (line.includes("ERROR")) {
                  logger.error?.("triangle_peer_engine_log", { line });
                } else if (line.includes("WARN")) {
                  logger.warn?.("triangle_peer_engine_log", { line });
                }
              }
            });
          }

          drainStream(proc.stdout, false);
          drainStream(proc.stderr, true);

          // Polling fallback if ready line was emitted before listener or hello needed retry
          pollInterval = setInterval(() => {
            if (settled) {
              clearInterval(pollInterval);
              return;
            }
            if (stderrReady && existsSync(socketPath)) {
              verifyHello();
            }
          }, 100);

          timer = setTimeout(() => {
            settleReject(coded("engine_timeout", "peer-engine startup timed out waiting for socket"));
          }, 15000);

          onAbort = () => {
            settleReject(signal?.reason ?? coded("aborted", "peer-engine start aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      };

      startPromise = run().catch(async (err) => {
        await this.stop();
        throw err;
      });

      return startPromise;
    } catch (err) {
      state = "stopped";
      return Promise.reject(err);
    }
  },

    async stop() {
      if (stopPromise) return stopPromise;
      if ((state === "stopped" || state === "exited") && !child) {
        state = "stopped";
        return;
      }
      state = "stopping";
      const proc = child;
      child = null;

      stopPromise = (async () => {
        try {
          if (proc && proc.exitCode === null) {
            await new Promise((resolve) => {
              let timer = null;
              const onExit = () => {
                if (timer) clearTimeout(timer);
                resolve();
              };
              proc.once("exit", onExit);

              try {
                proc.kill("SIGINT");
              } catch {}

              if (proc.exitCode !== null) {
                proc.removeListener("exit", onExit);
                return resolve();
              }

              timer = setTimeout(() => {
                try {
                  proc.kill("SIGKILL");
                } catch {}
                resolve();
              }, 5000);
            });
          }
        } finally {
          state = "stopped";
          stopPromise = null;
        }
      })();

      return stopPromise;
    },
  });
}
