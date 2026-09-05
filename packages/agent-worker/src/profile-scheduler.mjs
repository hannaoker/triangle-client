/**
 * Shared profile scheduler for event-driven wakes.
 * Enforces per-profile single flight, dirty-after-turn reconciliation,
 * FIFO fairness across profiles, and the shared global reasoning gate.
 */

import { createAtomicFileCursorStore, createMemoryCursorStore, createWakeClient } from "./wake-client.mjs";

function positiveInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFakeHarness({
  actionable = async () => true,
  drain = async () => ({ status: "drained" }),
} = {}) {
  const calls = [];
  return Object.freeze({
    calls,
    async preflight(input) {
      calls.push({ type: "preflight", ...input });
      return actionable(input);
    },
    async run(input) {
      calls.push({ type: "drain", ...input });
      return drain(input);
    },
  });
}

export function createProfileScheduler({
  gate,
  harness,
  initialBackoffMs = 15_000,
  maxBackoffMs = 300_000,
  idleJitterRatio = 0.1,
  random = Math.random,
  sleep = sleepMs,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (!gate || typeof gate.run !== "function") {
    throw new TypeError("gate.run is required");
  }
  if (!harness || typeof harness.preflight !== "function" || typeof harness.run !== "function") {
    throw new TypeError("harness.preflight and harness.run are required");
  }
  positiveInteger(initialBackoffMs, "initialBackoffMs");
  positiveInteger(maxBackoffMs, "maxBackoffMs");

  const states = new Map();
  const queue = [];
  let pumping = false;

  function stateFor(instanceId) {
    let state = states.get(instanceId);
    if (!state) {
      state = {
        instanceId,
        active: false,
        dirty: false,
        highWatermark: 0,
        lastReconciled: 0,
        backoffMs: initialBackoffMs,
        nextEligibleAt: 0,
        failureCount: 0,
      };
      states.set(instanceId, state);
    }
    return state;
  }

  function enqueue(instanceId) {
    if (!queue.includes(instanceId)) queue.push(instanceId);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const instanceId = queue.shift();
        const state = stateFor(instanceId);
        if (state.active) continue;
        const waitMs = Math.max(0, state.nextEligibleAt - now());
        if (waitMs > 0) {
          await sleep(waitMs);
        }
        if (state.active) {
          enqueue(instanceId);
          continue;
        }
        state.active = true;
        const highWatermark = state.highWatermark;
        try {
          await gate.run(async () => {
            if (highWatermark <= state.lastReconciled) {
              return;
            }
            const actionable = await harness.preflight({
              instanceId,
              highWatermark,
            });
            if (!actionable) {
              state.lastReconciled = highWatermark;
              return;
            }
            await harness.run({
              instanceId,
              highWatermark,
            });
            state.lastReconciled = highWatermark;
            state.backoffMs = initialBackoffMs;
            state.failureCount = 0;
            state.nextEligibleAt = 0;
          });
        } catch (error) {
          state.failureCount += 1;
          const jitter = 1 + (random() * 2 - 1) * idleJitterRatio;
          state.backoffMs = Math.min(
            maxBackoffMs,
            Math.max(initialBackoffMs, Math.floor(state.backoffMs * 2 * jitter)),
          );
          state.nextEligibleAt = now() + state.backoffMs;
          logger.error?.("triangle_scheduler_drain_failed", {
            instanceId,
            failureCount: state.failureCount,
          });
          if (error?.name === "AbortError") throw error;
          state.dirty = true;
        } finally {
          state.active = false;
          if (state.dirty) {
            state.dirty = false;
            enqueue(instanceId);
          }
        }
      }
    } finally {
      pumping = false;
      if (queue.length > 0) {
        queueMicrotask(() => {
          pump().catch(() => {});
        });
      }
    }
  }

  return Object.freeze({
    submitWake({ instanceId, highWatermark, reason } = {}) {
      if (typeof instanceId !== "string" || instanceId.length === 0) {
        throw new TypeError("instanceId is required");
      }
      const watermark = Number.isSafeInteger(highWatermark) ? highWatermark : 0;
      const state = stateFor(instanceId);
      if (watermark > state.highWatermark) state.highWatermark = watermark;
      if (reason === "startup_reconcile" && watermark === 0) {
        state.highWatermark = Math.max(state.highWatermark, state.lastReconciled + 1);
      }
      if (state.active) {
        state.dirty = true;
        return { queued: false, dirty: true };
      }
      enqueue(instanceId);
      pump().catch(() => {});
      return { queued: true, dirty: false };
    },

    snapshot() {
      return [...states.values()].map((state) => ({
        instanceId: state.instanceId,
        active: state.active,
        dirty: state.dirty,
        highWatermark: state.highWatermark,
        lastReconciled: state.lastReconciled,
        failureCount: state.failureCount,
      }));
    },

    async idle() {
      while (pumping || queue.length > 0 || [...states.values()].some((state) => state.active)) {
        await sleep(1);
      }
    },
  });
}

export function createWakeRuntime({
  profiles,
  transport,
  gate,
  harness,
  cursorStore,
  cursorPath,
  coalesceMs = 300,
  logger = console,
} = {}) {
  if (cursorStore && cursorPath) {
    throw new TypeError("provide cursorStore or cursorPath, not both");
  }
  const resolvedStore = cursorStore
    ?? (cursorPath
      ? createAtomicFileCursorStore({ filePath: cursorPath })
      : createMemoryCursorStore(0));
  const scheduler = createProfileScheduler({ gate, harness, logger });
  const wake = createWakeClient({
    profiles,
    transport,
    cursorStore: resolvedStore,
    coalesceMs,
    logger,
    onWake: (entry) => scheduler.submitWake(entry),
  });
  return Object.freeze({
    scheduler,
    wake,
    cursorStore: resolvedStore,
    async start({ signal, reconcile = true } = {}) {
      if (reconcile) await wake.reconcileStartup({ signal });
      await scheduler.idle();
      return wake.watch({ signal });
    },
  });
}
