// Trusted systemd host. Only fixed metadata messages reach the service journal.
import path from "node:path";
import { lstatSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openCustody } from "../../triangle-cli/src/custody.mjs";
import { openStore } from "./store.mjs";
import { createTransport } from "./transport.mjs";
import { createCustodian } from "./transaction.mjs";
import { createLinuxRunner } from "./runner.mjs";
import {
  profilePath,
  readProfile,
  readPrivateJSON,
  validateProfile,
  safeDirectory,
  safeFile,
} from "./paths.mjs";
const coded = (code) => Object.assign(Error(code), { code });
const busy = (e) =>
  e?.code === "store_busy" ||
  /already locked|Another triangle command is using|locked by this process/.test(
    e?.message ?? "",
  );
function safeCode(error) {
  return busy(error)
    ? "store_busy"
    : [
          "ownership_lost",
          "agent_not_active",
          "invalid_authority_response",
          "runner_failed",
        ].includes(error?.code)
      ? error.code
      : "runtime_failed";
}
export function loadHostConfig(configPath, options = {}) {
  const raw = validateProfile(readPrivateJSON(configPath));
  if (configPath !== profilePath(raw.profile, options))
    throw coded("invalid_config");
  const config = readProfile(raw.profile, options);
  if (!config || configPath !== profilePath(config.profile, options))
    throw coded("invalid_config");
  safeDirectory(config.stateRoot, { create: true });
  return config;
}
function workloadTransport(config, { env }) {
  const publicAuthority = openCustody(config.identityHome).readAuthority();
  if (
    publicAuthority?.authority !== config.authority ||
    (publicAuthority.via ?? null) !== config.via
  )
    throw coded("invalid_config");
  return createTransport({
    identityHome: config.identityHome,
    agentId: config.agentId,
    env,
  });
}
const hostLock = (root, fn) => {
  const lockRoot = path.join(root, ".host-lock");
  safeDirectory(lockRoot, { create: true });
  const file = path.join(lockRoot, ".lock.db");
  if (lstatSync(file, { throwIfNoEntry: false })) safeFile(file);
  return openCustody(lockRoot).withLock(fn);
};
export async function runHost({
  configPath,
  env = process.env,
  accountHome,
  signal,
  loadConfigImpl = loadHostConfig,
  openStoreImpl = openStore,
  createTransportImpl = workloadTransport,
  createRunnerImpl = createLinuxRunner,
  createCustodianImpl = createCustodian,
  lockImpl = hostLock,
  now = Date.now,
  sleepImpl = (ms, signal) => delay(ms, undefined, { signal }),
  heartbeatMs = 5000,
  pid = process.pid,
  log = (line) => process.stdout.write(line + "\n"),
} = {}) {
  let config;
  try {
    config = loadConfigImpl(configPath, { env, accountHome });
  } catch {
    log("triangle runtime: invalid configuration");
    throw coded("runtime_failed");
  }
  try {
    return await lockImpl(config.stateRoot, async () => {
      const store = openStoreImpl({
        root: config.stateRoot,
        agentId: config.agentId,
      });
      let heartbeat;
      let health = {
        schema: 1,
        profile: config.profile,
        agentId: config.agentId,
        pid,
        ready: false,
        verified: false,
        state: "starting",
        updatedAt: now(),
        verifiedAt: null,
        lastError: null,
        completed: 0,
      };
      const publish = (patch) => {
        health = { ...health, ...patch, updatedAt: now() };
        store.writeHealth(health);
      };
      try {
        signal?.throwIfAborted();
        publish({});
        const transport = createTransportImpl(config, { env });
        const runner = createRunnerImpl(config);
        await transport.verify({ signal });
        signal?.throwIfAborted();
        const probe = await runner.probe({ signal });
        signal?.throwIfAborted();
        if (probe?.ok !== true) throw coded("runner_failed");
        const custodian = createCustodianImpl({
          store,
          transport,
          runner,
          agentId: config.agentId,
          now,
        });
        publish({
          state: "running",
          ready: true,
          verified: true,
          verifiedAt: now(),
        });
        log("triangle runtime: ready");
        heartbeat = setInterval(() => {
          try {
            publish({});
          } catch {
            /* The next cycle observes storage failure; never print its contents. */
          }
        }, heartbeatMs);
        while (!signal?.aborted) {
          try {
            const result = await custodian.cycle({ signal });
            signal?.throwIfAborted();
            const needsAttention = ["failed", "quarantined"].includes(
              result?.state,
            );
            publish({
              state: needsAttention ? "needs_attention" : "running",
              ready: !needsAttention,
              verified: true,
              verifiedAt: now(),
              lastError: needsAttention ? "runner_failed" : null,
              completed:
                health.completed + (result?.state === "completed" ? 1 : 0),
            });
            if (result?.state === "completed")
              log("triangle runtime: delivery completed");
            else if (needsAttention)
              log("triangle runtime: delivery needs attention");
          } catch (error) {
            if (signal?.aborted) break;
            const code = safeCode(error);
            if (code !== "store_busy")
              publish({
                state: "needs_attention",
                ready: false,
                verified: false,
                lastError: code,
              });
            log(
              code === "store_busy"
                ? "triangle runtime: store busy"
                : "triangle runtime: cycle failed",
            );
          }
          try {
            await sleepImpl(config.pollIntervalMs, signal);
          } catch (error) {
            if (!signal?.aborted) throw error;
          }
        }
        publish({
          state: "stopped",
          ready: false,
          verified: false,
          lastError: null,
        });
        log("triangle runtime: stopped");
        return { state: "stopped" };
      } catch (error) {
        if (signal?.aborted) {
          publish({
            state: "stopped",
            ready: false,
            verified: false,
            lastError: null,
          });
          log("triangle runtime: stopped");
          return { state: "stopped" };
        }
        publish({
          state: "needs_attention",
          ready: false,
          verified: false,
          lastError: safeCode(error),
        });
        log("triangle runtime: startup failed");
        throw coded(safeCode(error));
      } finally {
        clearInterval(heartbeat);
        store.close();
      }
    });
  } catch (error) {
    const code = safeCode(error);
    if (code === "store_busy") log("triangle runtime: store busy");
    throw coded(code);
  }
}
export async function main(args = process.argv.slice(2)) {
  if (
    args.length !== 2 ||
    args[0] !== "--config" ||
    !path.isAbsolute(args[1])
  ) {
    process.stderr.write("triangle runtime: invalid configuration\n");
    return 1;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await runHost({ configPath: args[1], signal: controller.signal });
    return 0;
  } catch {
    return 1;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = await main();
