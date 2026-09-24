/**
 * CursorAcpWorkerPool — dedicated ACP child pool (v1 size 1).
 *
 * Never shares slots with Codex App Server. Never hosts grok-bot.
 * Production pool>1 cutover is out of scope; preferredSize is capped at 1.
 */

import { createCursorAcpProcess } from "./acp-process.mjs";
import { resolveCursorAcpPoolGuards } from "./runtime-home.mjs";

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

export function createCursorAcpWorkerPool({
  cursorHome,
  command = "agent",
  args = ["acp"],
  env = process.env,
  preferredSize = 1,
  maxSize = 1,
  createProcess = createCursorAcpProcess,
  createSlotId = (index) => `cursor-slot-${index + 1}`,
  unattendedPolicy,
  crashThreshold = DEFAULT_CRASH_THRESHOLD,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  const guards = resolveCursorAcpPoolGuards({ preferredSize, maxSize });
  const size = positiveInteger(guards.preferredSize, "size");

  /** @type {Array<object>} */
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

  /** @type {Map<string, string>} */
  const stickyByConversation = new Map();

  /** @type {Array<object>} */
  const waiters = [];

  function slotStatus(slot) {
    return Object.freeze({
      slotId: slot.slotId,
      generation: slot.generation,
      busy: slot.busy,
      started: slot.processHandle != null,
      crashCount: slot.crashCount,
      circuitOpen: now() < slot.circuitOpenUntil,
      pid: slot.processHandle?.status?.()?.pid ?? null,
    });
  }

  async function ensureSlotStarted(slot) {
    if (now() < slot.circuitOpenUntil) {
      throw createCodedError("slot_circuit_open", "Cursor ACP slot circuit is open", {
        slotId: slot.slotId,
        circuitOpenUntil: slot.circuitOpenUntil,
      });
    }
    if (slot.processHandle != null) return slot.processHandle;
    const handle = createProcess({
      command,
      args,
      cursorHome,
      env,
      unattendedPolicy,
    });
    await handle.start();
    await handle.ensureReady();
    slot.processHandle = handle;
    slot.startedAt = now();
    slot.generation += 1;
    handle.onEvent((event) => {
      if (event?.type !== "exit") return;
      if (slot.processHandle !== handle) return;
      slot.processHandle = null;
      slot.crashCount += 1;
      if (slot.crashCount >= crashThreshold) {
        const backoff = Math.min(
          backoffMaxMs,
          backoffBaseMs * 2 ** Math.min(slot.crashCount, 8),
        );
        const jitter = Math.floor(random() * backoff * 0.2);
        slot.circuitOpenUntil = now() + backoff + jitter;
      }
      slot.busy = false;
      drainWaiters();
    });
    return handle;
  }

  function pickSlot(stickySlotId) {
    const healthy = slots.filter((slot) => now() >= slot.circuitOpenUntil);
    if (healthy.length === 0) return null;
    if (stickySlotId) {
      const sticky = healthy.find((slot) => slot.slotId === stickySlotId && !slot.busy);
      if (sticky) return sticky;
    }
    return healthy.find((slot) => !slot.busy) ?? null;
  }

  function drainWaiters() {
    while (waiters.length > 0) {
      const waiter = waiters[0];
      if (waiter.deadline != null && now() >= waiter.deadline) {
        waiters.shift();
        waiter.reject(
          createCodedError("pool_acquire_timeout", "Cursor ACP pool acquire timed out", {
            conversationKey: waiter.conversationKey,
          }),
        );
        continue;
      }
      const slot = pickSlot(waiter.stickySlotId);
      if (!slot) return;
      waiters.shift();
      slot.busy = true;
      if (waiter.conversationKey) {
        stickyByConversation.set(waiter.conversationKey, slot.slotId);
      }
      waiter.resolve({
        slotId: slot.slotId,
        generation: slot.generation,
        processHandle: null,
        async ready() {
          const handle = await ensureSlotStarted(slot);
          return Object.freeze({
            slotId: slot.slotId,
            generation: slot.generation,
            processHandle: handle,
          });
        },
        release() {
          slot.busy = false;
          drainWaiters();
        },
      });
    }
  }

  async function start() {
    for (const slot of slots) {
      await ensureSlotStarted(slot);
    }
    return status();
  }

  async function stop() {
    for (const slot of slots) {
      const handle = slot.processHandle;
      slot.processHandle = null;
      slot.busy = false;
      if (handle) {
        try {
          await handle.close();
        } catch {
          // ignore
        }
      }
    }
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.reject(createCodedError("pool_stopped", "Cursor ACP pool stopped"));
    }
  }

  function acquire({
    conversationKey = null,
    stickySlotId = null,
    waitMs = 0,
  } = {}) {
    const preferredSticky =
      stickySlotId ??
      (typeof conversationKey === "string" ? stickyByConversation.get(conversationKey) : null);
    const immediate = pickSlot(preferredSticky);
    if (immediate) {
      immediate.busy = true;
      if (conversationKey) stickyByConversation.set(conversationKey, immediate.slotId);
      return Promise.resolve({
        slotId: immediate.slotId,
        generation: immediate.generation,
        processHandle: null,
        async ready() {
          const handle = await ensureSlotStarted(immediate);
          return Object.freeze({
            slotId: immediate.slotId,
            generation: immediate.generation,
            processHandle: handle,
          });
        },
        release() {
          immediate.busy = false;
          drainWaiters();
        },
      });
    }
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
      return Promise.reject(new TypeError("waitMs must be an integer >= 0"));
    }
    if (waitMs === 0) {
      return Promise.reject(
        createCodedError("pool_overloaded", "Cursor ACP pool is saturated", {
          size,
          conversationKey,
        }),
      );
    }
    return new Promise((resolve, reject) => {
      waiters.push({
        conversationKey,
        stickySlotId: preferredSticky,
        deadline: now() + waitMs,
        resolve,
        reject,
      });
    });
  }

  async function restartSlot(slotId) {
    const slot = slots.find((entry) => entry.slotId === slotId);
    if (!slot) {
      throw createCodedError("slot_not_found", `unknown Cursor ACP slot ${slotId}`);
    }
    const prior = slot.processHandle;
    slot.processHandle = null;
    if (prior) {
      try {
        await prior.close();
      } catch {
        // ignore
      }
    }
    slot.crashCount = 0;
    slot.circuitOpenUntil = 0;
    return ensureSlotStarted(slot);
  }

  function status() {
    return Object.freeze({
      size,
      forcedPoolSize: guards.maxSize,
      guards,
      slots: slots.map(slotStatus),
      waiterCount: waiters.length,
      stickyCount: stickyByConversation.size,
    });
  }

  return Object.freeze({
    start,
    stop,
    acquire,
    restartSlot,
    status,
    size: () => size,
  });
}
