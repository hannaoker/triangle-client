/**
 * CodexWorkerPool — Phase 3 bounded pool for shadow / test profiles.
 *
 * Owns a bounded set of supervised `codex app-server` children.
 * Default Phase 3 size is 2 (preferred); manifest `forcedPoolSize` may allow
 * up to 4. Production desktop / mcp-interactive paths stay single-consumer via
 * shadow gating + inactive global `featureFlags.headlessRuntime`.
 *
 * Phase 3 proves:
 * - concurrent slots (at most one active turn per slot);
 * - sticky assignment (prefer last healthy slot for a conversation);
 * - FIFO waiters under contention;
 * - overload fail-closed when waitMs=0 (leave work durable in MESH);
 * - per-slot crash backoff + circuit-open (no lease steal / busy loop).
 *
 * Idle slots are not "busy" and must not consume a global reasoner permit
 * (host scheduler composes permits; this pool only tracks Codex slots).
 */

import {
  createCodexAppServerProcess,
} from "./app-server-process.mjs";
import { resolveCodexPoolGuards } from "./runtime-home.mjs";
import { loadRuntimeManifest } from "./runtime-manifest.mjs";

const DEFAULT_CRASH_THRESHOLD = 3;
const DEFAULT_BACKOFF_BASE_MS = 100;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

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
 * @param {number} [options.preferredSize] Phase 3 default 2
 * @param {number} [options.maxSize] Absolute preferred bound; capped by manifest
 * @param {typeof createCodexAppServerProcess} [options.createProcess]
 * @param {(index: number) => string} [options.createSlotId]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random] Returns [0,1) for backoff jitter
 */
export function createCodexWorkerPool({
  codexHome,
  command = "codex",
  args = ["app-server"],
  env = process.env,
  preferredSize = 2,
  maxSize = 4,
  manifest = loadRuntimeManifest(),
  createProcess = createCodexAppServerProcess,
  createSlotId = (index) => `slot-${index + 1}`,
  clientInfo = { name: "triangle-headless-shadow", version: "0.1.0" },
  crashThreshold = DEFAULT_CRASH_THRESHOLD,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  const guards = resolveCodexPoolGuards({
    preferredSize,
    maxSize,
    desktopHandoffRequested: false,
    probeStatus: manifest.sharedHomeConcurrency?.status ?? "unproved",
    manifest,
  });
  const size = positiveInteger(guards.preferredSize, "size");
  if (size > guards.maxSize) {
    throw createCodedError(
      "pool_size_cap",
      "preferred pool size exceeds resolved maxSize",
      { guards },
    );
  }

  /** @type {Array<{
   *   slotId: string,
   *   generation: number,
   *   processHandle: object | null,
   *   startedAt: number | null,
   *   busy: boolean,
   *   crashCount: number,
   *   circuitOpenUntil: number,
   * }>} */
  const slots = [];
  for (let i = 0; i < size; i += 1) {
    slots.push({
      slotId: createSlotId(i),
      generation: 0,
      processHandle: null,
      startedAt: null,
      busy: false,
      crashCount: 0,
      circuitOpenUntil: 0,
    });
  }

  /** Conversation key → last healthy slotId (in-process sticky hint). */
  /** @type {Map<string, string>} */
  const stickyByConversation = new Map();

  /**
   * FIFO waiters. Each entry is resolved when a healthy free slot appears or
   * the waiter deadline expires.
   * @type {Array<{
   *   stickySlotId: string | null,
   *   conversationKey: string | null,
   *   deadline: number,
   *   resolve: (lease: object) => void,
   *   reject: (error: Error) => void,
   * }>}
   */
  const waiters = [];

  let started = false;
  let draining = false;

  function isCircuitOpen(slot) {
    return slot.circuitOpenUntil > now();
  }

  function isHealthy(slot) {
    return slot.processHandle != null && !isCircuitOpen(slot);
  }

  function refreshCircuit(slot) {
    if (slot.circuitOpenUntil > 0 && slot.circuitOpenUntil <= now()) {
      // Half-open: allow one acquire; leave crashCount until success clears it.
      slot.circuitOpenUntil = 0;
    }
  }

  function computeBackoffMs(crashCount) {
    const exp = Math.max(0, crashCount - 1);
    const raw = Math.min(backoffMaxMs, backoffBaseMs * 2 ** exp);
    const jitter = Math.floor(random() * raw * 0.25);
    return raw + jitter;
  }

  async function ensureSlotProcess(slot) {
    if (slot.processHandle) return slot;
    const processHandle = createProcess({
      command,
      args,
      codexHome,
      env,
    });
    await processHandle.start();
    await processHandle.initialize(clientInfo);
    slot.generation += 1;
    slot.processHandle = processHandle;
    slot.startedAt = now();
    return slot;
  }

  function findSlot(slotId) {
    return slots.find((entry) => entry.slotId === slotId) ?? null;
  }

  function pickSlot(stickySlotId) {
    for (const slot of slots) refreshCircuit(slot);

    if (typeof stickySlotId === "string" && stickySlotId.length > 0) {
      const sticky = findSlot(stickySlotId);
      if (sticky && !sticky.busy && isHealthy(sticky)) {
        return sticky;
      }
      // Sticky unavailable (busy / circuit / missing process): failover below.
    }

    for (const slot of slots) {
      if (!slot.busy && isHealthy(slot)) return slot;
    }
    // Allow lazy-start of a non-busy slot whose process is not yet up, unless
    // its circuit is open.
    for (const slot of slots) {
      if (!slot.busy && !isCircuitOpen(slot) && slot.processHandle == null) {
        return slot;
      }
    }
    return null;
  }

  function busyCount() {
    return slots.filter((slot) => slot.busy).length;
  }

  function healthyFreeCount() {
    for (const slot of slots) refreshCircuit(slot);
    return slots.filter((slot) => !slot.busy && !isCircuitOpen(slot)).length;
  }

  function allCircuitsOpen() {
    for (const slot of slots) refreshCircuit(slot);
    return slots.every((slot) => isCircuitOpen(slot));
  }

  function tryReserveSlot(stickySlotId) {
    const slot = pickSlot(stickySlotId);
    if (slot == null) return null;
    // Atomic with pick: no await between free check and busy=true.
    slot.busy = true;
    return slot;
  }

  async function grantReservedSlot(slot, { conversationKey = null } = {}) {
    try {
      await ensureSlotProcess(slot);
      if (slot.processHandle == null || isCircuitOpen(slot)) {
        slot.busy = false;
        throw createCodedError(
          "pool_slot_unavailable",
          "selected slot became unavailable before grant",
          { slotId: slot.slotId },
        );
      }
    } catch (error) {
      slot.busy = false;
      drainWaiters();
      throw error;
    }
    const grantedSlotId = slot.slotId;
    const grantedGeneration = slot.generation;
    const processHandle = slot.processHandle;
    return Object.freeze({
      slotId: grantedSlotId,
      generation: grantedGeneration,
      processHandle,
      release({ success = true } = {}) {
        const current = findSlot(grantedSlotId);
        if (current == null) return;
        // Ignore stale releases after a restart replaced the generation.
        if (current.generation !== grantedGeneration) {
          drainWaiters();
          return;
        }
        current.busy = false;
        if (success) {
          current.crashCount = 0;
          current.circuitOpenUntil = 0;
        }
        if (typeof conversationKey === "string" && conversationKey.length > 0) {
          stickyByConversation.set(conversationKey, grantedSlotId);
        }
        drainWaiters();
      },
    });
  }

  function drainWaiters() {
    while (waiters.length > 0) {
      const next = waiters[0];
      const remaining = next.deadline - now();
      if (remaining <= 0) {
        waiters.shift();
        next.reject(
          createCodedError("pool_slot_busy", "timed out waiting for a free pool slot", {
            size,
            busy: busyCount(),
          }),
        );
        continue;
      }
      const sticky =
        next.stickySlotId ??
        (next.conversationKey ? stickyByConversation.get(next.conversationKey) : null) ??
        null;
      const slot = tryReserveSlot(sticky);
      if (slot == null) {
        if (allCircuitsOpen()) {
          waiters.shift();
          next.reject(
            createCodedError(
              "pool_circuit_open",
              "all pool slots are circuit-open; coalesce wakes without claim",
              { size },
            ),
          );
          continue;
        }
        return;
      }
      waiters.shift();
      grantReservedSlot(slot, { conversationKey: next.conversationKey }).then(
        next.resolve,
        (error) => {
          next.reject(error);
          drainWaiters();
        },
      );
    }
  }

  async function start() {
    if (started) return status();
    draining = false;
    // Eagerly warm preferred slots so concurrent admits do not serialize on boot.
    for (const slot of slots) {
      await ensureSlotProcess(slot);
    }
    started = true;
    return status();
  }

  async function stop({ signal = "SIGTERM", timeoutMs = 5_000 } = {}) {
    started = false;
    draining = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.reject(
        createCodedError("pool_draining", "worker pool is draining; no new admissions"),
      );
    }
    for (const slot of slots) {
      slot.busy = false;
      const handle = slot.processHandle;
      slot.processHandle = null;
      slot.startedAt = null;
      if (handle) {
        await handle.close({ signal, timeoutMs });
      }
    }
    stickyByConversation.clear();
    return status();
  }

  /**
   * Kill and replace one slot (or every slot when `slotId` omitted).
   * Conversation registry / sticky map in the parent process are untouched —
   * callers resume the persisted threadId on a healthy child.
   */
  async function restartSlot({
    slotId = null,
    signal = "SIGKILL",
    timeoutMs = 2_000,
    recordCrash = false,
  } = {}) {
    if (!started) {
      throw createCodedError("pool_not_started", "worker pool is not started");
    }
    const targets =
      typeof slotId === "string" && slotId.length > 0
        ? [findSlot(slotId)].filter(Boolean)
        : [...slots];
    if (targets.length === 0) {
      throw createCodedError("pool_slot_missing", "unknown slot id", { slotId });
    }

    let last = null;
    for (const slot of targets) {
      const previous = slot.processHandle;
      slot.busy = false;
      slot.processHandle = null;
      slot.startedAt = null;
      if (previous) {
        await previous.close({ signal, timeoutMs });
      }
      if (recordCrash) {
        noteCrash(slot.slotId, { restart: false });
      }
      // Circuit-open slots stay down until backoff elapses (no busy restart loop).
      if (!isCircuitOpen(slot)) {
        last = await ensureSlotProcess(slot);
      } else {
        last = slot;
      }
    }
    drainWaiters();
    return Object.freeze({
      slotId: last.slotId,
      generation: last.generation,
      processHandle: last.processHandle,
      circuitOpen: isCircuitOpen(last),
      crashCount: last.crashCount,
    });
  }

  /**
   * Record a slot crash. After `crashThreshold` failures opens the circuit with
   * exponential backoff + jitter. Circuit-open slots are skipped by acquire;
   * callers must leave MESH work unclaimed and coalesce wake watermarks.
   */
  function noteCrash(slotId, { restart = true } = {}) {
    const slot = findSlot(slotId);
    if (slot == null) {
      throw createCodedError("pool_slot_missing", "unknown slot id", { slotId });
    }
    slot.crashCount += 1;
    if (slot.crashCount >= crashThreshold) {
      const backoffMs = computeBackoffMs(slot.crashCount);
      slot.circuitOpenUntil = now() + backoffMs;
    }
    if (restart && started && !isCircuitOpen(slot)) {
      // Fire-and-forget replacement is not used; callers use restartSlot.
    }
    return Object.freeze({
      slotId: slot.slotId,
      crashCount: slot.crashCount,
      circuitOpen: isCircuitOpen(slot),
      circuitOpenUntil: slot.circuitOpenUntil,
      backoffMs: Math.max(0, slot.circuitOpenUntil - now()),
    });
  }

  /**
   * Acquire one healthy free slot.
   *
   * @param {object} [options]
   * @param {string} [options.stickySlotId] Prefer this slot when healthy+free
   * @param {string} [options.conversationKey] Sticky map key (room id)
   * @param {number} [options.waitMs] 0 = fail closed immediately when saturated
   */
  async function acquire({
    stickySlotId = null,
    conversationKey = null,
    waitMs = 0,
  } = {}) {
    if (!started) {
      throw createCodedError("pool_not_started", "worker pool is not started");
    }
    if (draining) {
      throw createCodedError("pool_draining", "worker pool is draining; no new admissions");
    }

    const sticky =
      stickySlotId ??
      (typeof conversationKey === "string"
        ? stickyByConversation.get(conversationKey) ?? null
        : null);

    if (allCircuitsOpen()) {
      throw createCodedError(
        "pool_circuit_open",
        "all pool slots are circuit-open; coalesce wakes without claim",
        { size, crashThreshold },
      );
    }

    const immediate = tryReserveSlot(sticky);
    if (immediate != null) {
      return grantReservedSlot(immediate, { conversationKey });
    }

    // Saturated: fail closed unless the caller opts into a bounded wait.
    // Overload policy: leave work durable in MESH; do not claim beyond capacity.
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      throw createCodedError(
        "pool_overloaded",
        "all pool slots are busy; leave delivery unclaimed",
        {
          size,
          busy: busyCount(),
          waitPolicy: "fail_closed",
          waitMs: 0,
        },
      );
    }

    const deadline = now() + waitMs;
    return new Promise((resolve, reject) => {
      waiters.push({
        stickySlotId: sticky,
        conversationKey,
        deadline,
        resolve,
        reject,
      });
      // FIFO: only the head can be granted; drainWaiters walks in order.
      drainWaiters();
      const wait = deadline - now();
      if (wait > 0) {
        setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) {
            waiters.splice(index, 1);
            reject(
              createCodedError("pool_slot_busy", "timed out waiting for a free pool slot", {
                size,
                busy: busyCount(),
                waitPolicy: "bounded_wait",
                waitMs,
              }),
            );
          }
        }, wait);
      }
    });
  }

  /**
   * Return a busy slot's process handle without a second acquire.
   * Used by cancel/timeout paths that must interrupt the owning delivery.
   *
   * With multiple busy slots, `slotId` is required; omitting it only works when
   * exactly one slot is busy (Phase 1 single-slot compatibility).
   */
  function getActiveHandle({ slotId = null } = {}) {
    if (!started) return null;
    if (typeof slotId === "string" && slotId.length > 0) {
      const slot = findSlot(slotId);
      if (slot == null || !slot.busy || slot.processHandle == null) return null;
      return Object.freeze({
        slotId: slot.slotId,
        generation: slot.generation,
        processHandle: slot.processHandle,
      });
    }
    const busySlots = slots.filter((slot) => slot.busy && slot.processHandle != null);
    if (busySlots.length !== 1) return null;
    const slot = busySlots[0];
    return Object.freeze({
      slotId: slot.slotId,
      generation: slot.generation,
      processHandle: slot.processHandle,
    });
  }

  function rememberSticky(conversationKey, slotId) {
    if (typeof conversationKey !== "string" || conversationKey.length === 0) return;
    if (typeof slotId !== "string" || slotId.length === 0) return;
    stickyByConversation.set(conversationKey, slotId);
  }

  function status() {
    for (const slot of slots) refreshCircuit(slot);
    return Object.freeze({
      started,
      size,
      busy: busyCount() > 0,
      busyCount: busyCount(),
      healthyFreeCount: healthyFreeCount(),
      waiterCount: waiters.length,
      draining,
      forcedPoolSize: guards.forcedPoolSize,
      forcedByProbe: guards.forcedByProbe,
      forcedByManifest: guards.forcedByManifest,
      probeStatus: guards.probeStatus,
      overloadPolicy: "fail_closed_when_wait_ms_0",
      stickyCount: stickyByConversation.size,
      // Compat: first slot summary (Phase 1 tests read `.slot.generation`).
      slot: slots[0]?.processHandle
        ? Object.freeze({
            slotId: slots[0].slotId,
            generation: slots[0].generation,
            process: slots[0].processHandle.status(),
            busy: slots[0].busy,
            circuitOpen: isCircuitOpen(slots[0]),
            crashCount: slots[0].crashCount,
          })
        : null,
      slots: Object.freeze(
        slots.map((slot) =>
          Object.freeze({
            slotId: slot.slotId,
            generation: slot.generation,
            busy: slot.busy,
            circuitOpen: isCircuitOpen(slot),
            circuitOpenUntil: slot.circuitOpenUntil,
            crashCount: slot.crashCount,
            process: slot.processHandle ? slot.processHandle.status() : null,
          }),
        ),
      ),
    });
  }

  return Object.freeze({
    start,
    stop,
    restartSlot,
    acquire,
    getActiveHandle,
    noteCrash,
    rememberSticky,
    status,
    guards,
  });
}
