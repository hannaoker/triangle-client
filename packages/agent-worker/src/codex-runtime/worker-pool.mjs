/**
 * CodexWorkerPool — Phase 1 single-slot shadow pool.
 *
 * Owns at most one supervised `codex app-server` child. Pool size is forced to
 * 1 by `resolveCodexPoolGuards` / manifest `forcedPoolSize` for Phase 1.
 * Multi-slot fairness, sticky assignment, and circuit breakers arrive in Phase 3.
 */

import {
  createCodexAppServerProcess,
} from "./app-server-process.mjs";
import { resolveCodexPoolGuards } from "./runtime-home.mjs";
import { loadRuntimeManifest } from "./runtime-manifest.mjs";

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function positiveInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

/**
 * @param {object} options
 * @param {string} [options.codexHome]
 * @param {string} [options.command]
 * @param {string[]} [options.args]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.manifest]
 * @param {typeof createCodexAppServerProcess} [options.createProcess]
 * @param {() => string} [options.createSlotId]
 */
export function createCodexWorkerPool({
  codexHome,
  command = "codex",
  args = ["app-server"],
  env = process.env,
  preferredSize = 1,
  maxSize = 1,
  manifest = loadRuntimeManifest(),
  createProcess = createCodexAppServerProcess,
  createSlotId = () => `slot-1`,
  clientInfo = { name: "triangle-headless-shadow", version: "0.1.0" },
} = {}) {
  const guards = resolveCodexPoolGuards({
    preferredSize,
    maxSize,
    desktopHandoffRequested: false,
    probeStatus: manifest.sharedHomeConcurrency?.status ?? "unproved",
    manifest,
  });
  // Phase 1 hard gate: never start more than one slot.
  const size = 1;
  if (guards.preferredSize !== 1 || guards.maxSize !== 1) {
    throw createCodedError(
      "pool_size_phase1_cap",
      "Phase 1 shadow pool requires forced pool size 1",
      { guards },
    );
  }
  positiveInteger(size, "size");

  let slot = null;
  let started = false;
  let busy = false;
  let generation = 0;

  async function ensureSlot() {
    if (slot?.processHandle) return slot;
    const slotId = createSlotId();
    const processHandle = createProcess({
      command,
      args,
      codexHome,
      env,
    });
    await processHandle.start();
    await processHandle.initialize(clientInfo);
    generation += 1;
    slot = Object.freeze({
      slotId,
      generation,
      processHandle,
      startedAt: Date.now(),
    });
    return slot;
  }

  async function start() {
    if (started) return status();
    await ensureSlot();
    started = true;
    return status();
  }

  async function stop({ signal = "SIGTERM", timeoutMs = 5_000 } = {}) {
    started = false;
    busy = false;
    const current = slot;
    slot = null;
    if (current?.processHandle) {
      await current.processHandle.close({ signal, timeoutMs });
    }
    return status();
  }

  /**
   * Kill and replace the single slot. Conversation registry (parent process)
   * is untouched — callers resume the persisted threadId on the new child.
   */
  async function restartSlot({ signal = "SIGKILL", timeoutMs = 2_000 } = {}) {
    if (!started) {
      throw createCodedError("pool_not_started", "worker pool is not started");
    }
    const previous = slot;
    busy = false;
    slot = null;
    if (previous?.processHandle) {
      await previous.processHandle.close({ signal, timeoutMs });
    }
    return ensureSlot();
  }

  async function acquire({ waitMs = 0 } = {}) {
    if (!started) {
      throw createCodedError("pool_not_started", "worker pool is not started");
    }
    if (busy) {
      if (waitMs <= 0) {
        throw createCodedError("pool_slot_busy", "Phase 1 single slot is busy");
      }
      const deadline = Date.now() + waitMs;
      while (busy && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (busy) {
        throw createCodedError("pool_slot_busy", "Phase 1 single slot is busy");
      }
    }
    const current = await ensureSlot();
    busy = true;
    return Object.freeze({
      slotId: current.slotId,
      generation: current.generation,
      processHandle: current.processHandle,
      release() {
        busy = false;
      },
    });
  }

  function status() {
    return Object.freeze({
      started,
      size,
      busy,
      forcedPoolSize: guards.forcedPoolSize,
      forcedByProbe: guards.forcedByProbe,
      forcedByManifest: guards.forcedByManifest,
      probeStatus: guards.probeStatus,
      slot: slot
        ? Object.freeze({
            slotId: slot.slotId,
            generation: slot.generation,
            process: slot.processHandle.status(),
          })
        : null,
    });
  }

  return Object.freeze({
    start,
    stop,
    restartSlot,
    acquire,
    status,
    guards,
  });
}
