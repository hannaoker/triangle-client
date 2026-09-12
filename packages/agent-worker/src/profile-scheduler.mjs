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

function sleepMs(ms, signal) {
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener?.("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
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

/**
 * Real mailbox drain harness for event-driven wakes.
 * Reuses mailbox-client claim / reconcile / ack via listUnread +
 * completeAndAcknowledge. Callers must pass ungated runners: the profile
 * scheduler already holds the shared reasoning gate around preflight/run.
 */
export function createMailboxHarness({
  clients,
  runners,
  logger = console,
} = {}) {
  if (!(clients instanceof Map) || !(runners instanceof Map)) {
    throw new TypeError("clients and runners Maps are required");
  }
  if (clients.size === 0 || runners.size === 0 || clients.size !== runners.size) {
    throw new TypeError("clients and runners must cover the same non-empty instance set");
  }
  for (const instanceId of clients.keys()) {
    if (!runners.has(instanceId)) {
      throw new TypeError("clients and runners instance sets must match");
    }
  }
  for (const instanceId of runners.keys()) {
    if (!clients.has(instanceId)) {
      throw new TypeError("clients and runners instance sets must match");
    }
  }

  function resolve(instanceId) {
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw new TypeError("instanceId is required");
    }
    const client = clients.get(instanceId);
    const runner = runners.get(instanceId);
    if (!client || typeof client.listUnread !== "function" || typeof client.completeAndAcknowledge !== "function") {
      throw new TypeError("mailbox harness has no delivery client for instance");
    }
    if (!runner || typeof runner.run !== "function") {
      throw new TypeError("mailbox harness has no runner for instance");
    }
    return { client, runner };
  }

  return Object.freeze({
    async preflight({ instanceId, signal } = {}) {
      const { client } = resolve(instanceId);
      const messages = await client.listUnread({ signal });
      if (!Array.isArray(messages)) {
        throw new TypeError("deliveryClient.listUnread must return an array");
      }
      return messages.length > 0;
    },

    async run({ instanceId, signal } = {}) {
      const { client, runner } = resolve(instanceId);
      const messages = await client.listUnread({ signal });
      if (!Array.isArray(messages)) {
        throw new TypeError("deliveryClient.listUnread must return an array");
      }
      if (messages.length === 0) return { status: "drained", processed: 0 };
      const completion = await client.completeAndAcknowledge(
        messages[0],
        (request, options) => runner.run(request, { ...options, signal: options?.signal ?? signal }),
        { signal },
      );
      if (completion?.claimed === false) {
        logger.error?.("triangle_mailbox_harness_claim_conflict", { instanceId });
        const error = new Error("Mailbox claim conflict requires reconciliation");
        error.code = "claim_conflict";
        throw error;
      }
      return { status: "more", processed: 1 };
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
  signal,
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
  let inFlight = 0;
  let stopped = Boolean(signal?.aborted);
  signal?.addEventListener?.("abort", () => {
    stopped = true;
    queue.length = 0;
  }, { once: true });

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

  async function waitForBackoff(ms) {
    if (!signal) return sleep(ms);
    if (signal.aborted) return;
    let onAbort;
    const aborted = new Promise((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([sleep(ms, signal), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async function runState(state) {
    try {
      const waitMs = Math.max(0, state.nextEligibleAt - now());
      if (waitMs > 0) await waitForBackoff(waitMs);
      if (stopped || signal?.aborted) return;
      const highWatermark = state.highWatermark;
      try {
        await gate.run(async () => {
          if (highWatermark <= state.lastReconciled) return;
          const actionable = await harness.preflight({
            instanceId: state.instanceId,
            highWatermark,
            signal,
          });
          if (!actionable) {
            state.lastReconciled = highWatermark;
            return;
          }
          const result = await harness.run({
            instanceId: state.instanceId,
            highWatermark,
            signal,
          });
          if (result?.status === "more") {
            state.dirty = true;
          } else {
            state.lastReconciled = highWatermark;
          }
          state.backoffMs = initialBackoffMs;
          state.failureCount = 0;
          state.nextEligibleAt = 0;
        }, { signal });
      } catch (error) {
        if (error?.name !== "AbortError" && !stopped) {
          state.failureCount += 1;
          const jitter = 1 + (random() * 2 - 1) * idleJitterRatio;
          state.backoffMs = Math.min(maxBackoffMs, Math.max(initialBackoffMs, Math.floor(state.backoffMs * 2 * jitter)));
          state.nextEligibleAt = now() + state.backoffMs;
          logger.error?.("triangle_scheduler_drain_failed", { instanceId: state.instanceId, failureCount: state.failureCount });
          state.dirty = true;
        }
      }
    } finally {
      state.active = false;
      inFlight -= 1;
      if (state.dirty && !stopped) {
        state.dirty = false;
        enqueue(state.instanceId);
      }
      queueMicrotask(pump);
    }
  }

  function pump() {
    if (pumping || stopped) return;
    pumping = true;
    try {
      while (queue.length > 0 && !stopped) {
        const state = stateFor(queue.shift());
        if (state.active) continue;
        state.active = true;
        inFlight += 1;
        runState(state).catch(() => {});
      }
    } finally {
      pumping = false;
    }
  }

  return Object.freeze({
    submitWake({ instanceId, highWatermark, reason } = {}) {
      if (typeof instanceId !== "string" || instanceId.length === 0) {
        throw new TypeError("instanceId is required");
      }
      const watermark = Number.isSafeInteger(highWatermark) ? highWatermark : 0;
      const state = stateFor(instanceId);
      if (stopped) return { queued: false, dirty: false, stopped: true };
      if (watermark > state.highWatermark) state.highWatermark = watermark;
      if (reason === "startup_reconcile" && watermark === 0) {
        state.highWatermark = Math.max(state.highWatermark, state.lastReconciled + 1);
      }
      if (state.active) {
        state.dirty = true;
        return { queued: false, dirty: true };
      }
      enqueue(instanceId);
      pump();
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
      while (pumping || queue.length > 0 || inFlight > 0 || [...states.values()].some((state) => state.active)) {
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
  const schedulerAbort = new AbortController();
  const scheduler = createProfileScheduler({ gate, harness, logger, signal: schedulerAbort.signal });
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
      const abortScheduler = () => schedulerAbort.abort();
      signal?.addEventListener?.("abort", abortScheduler, { once: true });
      if (signal?.aborted) abortScheduler();
      try {
        if (reconcile) await wake.reconcileStartup({ signal });
        await scheduler.idle();
        return await wake.watch({ signal });
      } finally {
        schedulerAbort.abort();
        await scheduler.idle();
        signal?.removeEventListener?.("abort", abortScheduler);
      }
    },
  });
}
