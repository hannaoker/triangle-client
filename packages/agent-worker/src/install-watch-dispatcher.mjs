/**
 * Option A install watch dispatcher (Phase 2).
 *
 * One supervisor-owned poll loop + one install cursor. Fan-out by agent_id to
 * registered handlers (Bob webhook, headless kick, …). Persist cursor only after
 * the fan-out commit barrier (wake-client D5). Membership eligibility stays
 * inactive until a gated ensure expands the grant.
 */

import path from "node:path";

import {
  createAtomicFileCursorStore,
  createMemoryCursorStore,
  createWakeClient,
} from "./wake-client.mjs";

const AGENT_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const INSTANCE_ID = /^[a-f0-9]{64}$/;

/**
 * Safe reconnect idle when MESH held-poll is down / unproven (Hobby anti-pattern
 * if empty polls return immediately under short idle).
 */
export const INSTALL_WATCH_SAFE_IDLE_POLL_MS = 30_000;
/** Short reconnect backoff after Phase 0.5 hold is live (empty tip ≥~20s). */
export const INSTALL_WATCH_HELD_POLL_IDLE_MS = 2_000;

function positiveInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

/**
 * D3: a returned `{ status: "failed" }` must not count as fan-out accept.
 * Handlers should prefer throwing; this is defense in depth for soft fails.
 */
export function assertFanOutAccepted(result, wake = null) {
  if (result && typeof result === "object" && result.status === "failed") {
    const error = new Error("fan-out handler failed");
    error.code = typeof result.code === "string" ? result.code : "fan_out_failed";
    if (wake?.instanceId) error.instanceId = wake.instanceId;
    throw error;
  }
  return result;
}

/**
 * D4: install cursor = max(retired lane cursors, existing install cursor).
 * Call before first advance under the dispatcher. Does not schedule reconcile —
 * callers must reconcile all routable members after migration.
 */
export async function migrateInstallWatchCursor({
  installCursorStore,
  laneCursorStores = [],
} = {}) {
  if (!installCursorStore || typeof installCursorStore.read !== "function" || typeof installCursorStore.write !== "function") {
    throw new TypeError("installCursorStore is required");
  }
  if (!Array.isArray(laneCursorStores)) {
    throw new TypeError("laneCursorStores must be an array");
  }
  const installCursor = positiveInteger(await installCursorStore.read(), "installCursor", 0);
  let maxCursor = installCursor;
  for (const store of laneCursorStores) {
    if (!store || typeof store.read !== "function") {
      throw new TypeError("laneCursorStores entries must expose read()");
    }
    const lane = positiveInteger(await store.read(), "laneCursor", 0);
    if (lane > maxCursor) maxCursor = lane;
  }
  if (maxCursor !== installCursor) {
    await installCursorStore.write(maxCursor);
  }
  return maxCursor;
}

/**
 * Derive the canonical install cursor path beside a retired lane cursor.
 */
export function resolveInstallWatchCursorPath(laneCursorPath) {
  if (typeof laneCursorPath !== "string" || !laneCursorPath.startsWith("/") || laneCursorPath.includes("\0")) {
    throw new TypeError("laneCursorPath is invalid");
  }
  return path.join(path.dirname(path.resolve(laneCursorPath)), "install-wake-cursor.json");
}

/**
 * @param {object} options
 * @param {Array<{ instanceId: string, agentId: string }>} options.profiles
 * @param {Map<string, function>|Record<string, function>} options.handlers
 *   instanceId → async (wake) => accepted. Must tolerate at-least-once replay.
 *   Throwing rejects the fan-out barrier (cursor not advanced).
 * @param {{ poll: Function }} options.transport
 * @param {{ read: Function, write: Function }} [options.cursorStore]
 * @param {string} [options.cursorPath] install cursor file (mutually exclusive with cursorStore)
 * @param {Array<{ read: Function, write?: Function }>} [options.laneCursorStores] D4 migration sources
 * @param {boolean} [options.migrateLaneCursors=true]
 * @param {number} [options.coalesceMs]
 * @param {number} [options.idlePollIntervalMs]
 * @param {Function} [options.wakeClientFactory]
 * @param {object} [options.logger]
 */
export function createInstallWatchDispatcher({
  profiles,
  handlers,
  transport,
  cursorStore = null,
  cursorPath = null,
  laneCursorStores = [],
  migrateLaneCursors = true,
  coalesceMs = 300,
  // Default safe cadence until held-poll is measured (see Phase 0.5 note).
  idlePollIntervalMs = INSTALL_WATCH_SAFE_IDLE_POLL_MS,
  wakeClientFactory = createWakeClient,
  logger = console,
} = {}) {
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 100) {
    throw new TypeError("profiles must contain between 1 and 100 entries");
  }
  if (!transport || typeof transport.poll !== "function") {
    throw new TypeError("transport.poll is required");
  }
  if (cursorStore && cursorPath) {
    throw new TypeError("provide cursorStore or cursorPath, not both");
  }

  const handlerMap = handlers instanceof Map
    ? handlers
    : new Map(Object.entries(handlers ?? {}));
  if (handlerMap.size < 1) {
    throw new TypeError("handlers must contain at least one entry");
  }

  const byAgent = new Map();
  for (const profile of profiles) {
    if (!profile || typeof profile !== "object") throw new TypeError("profile is invalid");
    if (!INSTANCE_ID.test(profile.instanceId)) throw new TypeError("instanceId is invalid");
    if (typeof profile.agentId !== "string" || !AGENT_ID.test(profile.agentId)) {
      throw new TypeError("agentId is invalid");
    }
    if (byAgent.has(profile.agentId)) throw new TypeError("duplicate agentId");
    if (byAgent.size > 0 && [...byAgent.values()].includes(profile.instanceId)) {
      throw new TypeError("duplicate instanceId");
    }
    if (!handlerMap.has(profile.instanceId)) {
      throw new TypeError(`no handler registered for instanceId ${profile.instanceId}`);
    }
    if (typeof handlerMap.get(profile.instanceId) !== "function") {
      throw new TypeError("handlers must be functions");
    }
    byAgent.set(profile.agentId, profile.instanceId);
  }
  for (const instanceId of handlerMap.keys()) {
    if (![...byAgent.values()].includes(instanceId)) {
      throw new TypeError(`handler instanceId ${instanceId} has no profile`);
    }
  }

  const resolvedStore = cursorStore
    ?? (cursorPath
      ? createAtomicFileCursorStore({ filePath: cursorPath })
      : createMemoryCursorStore(0));

  let wakeClient = null;
  let started = false;
  let migrated = false;

  async function ensureMigrated() {
    if (!migrateLaneCursors || migrated) return;
    await migrateInstallWatchCursor({
      installCursorStore: resolvedStore,
      laneCursorStores,
    });
    migrated = true;
  }

  async function dispatchWake(wake) {
    const handler = handlerMap.get(wake?.instanceId);
    if (typeof handler !== "function") {
      return { status: "ignored_profile" };
    }
    const result = await handler(wake);
    return assertFanOutAccepted(result, wake);
  }

  return Object.freeze({
    profileCount: byAgent.size,
    idlePollIntervalMs,
    cursorStore: resolvedStore,
    profiles: Object.freeze(profiles.map((profile) => Object.freeze({
      instanceId: profile.instanceId,
      agentId: profile.agentId,
    }))),

    async start({ signal, maxCycles = Number.POSITIVE_INFINITY, reconcile = true } = {}) {
      if (started) {
        const error = new Error("install watch dispatcher already started");
        error.code = "already_started";
        throw error;
      }
      await ensureMigrated();
      wakeClient = wakeClientFactory({
        profiles: [...byAgent.entries()].map(([agentId, instanceId]) => ({ agentId, instanceId })),
        transport,
        cursorStore: resolvedStore,
        coalesceMs,
        idlePollIntervalMs,
        logger,
        async onWake(wake) {
          return dispatchWake(wake);
        },
      });
      started = true;
      try {
        if (reconcile) await wakeClient.reconcileStartup({ signal });
        return await wakeClient.watch({ signal, maxCycles });
      } catch (error) {
        try {
          await wakeClient?.stop();
        } catch {
          /* ignore cleanup */
        }
        wakeClient = null;
        started = false;
        throw error;
      }
    },

    async stop() {
      await wakeClient?.stop();
      wakeClient = null;
      started = false;
      return { status: "stopped" };
    },

    /** Test / recovery: invoke one handler without polling. */
    async handleWake(wake) {
      return dispatchWake(wake);
    },
  });
}

export {
  createAtomicFileCursorStore,
  createMemoryCursorStore,
};
