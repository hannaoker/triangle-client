/**
 * Installation-scoped wake listener for event-driven profiles.
 * Correctness comes from the injected transport (MESH held poll); this module
 * owns cursor persistence, coalescing, and fan-out to the profile scheduler.
 */

import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const AGENT_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const INSTANCE_ID = /^[a-f0-9]{64}$/;

function positiveInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMemoryCursorStore(initial = 0) {
  let cursor = positiveInteger(initial, "initial", 0);
  return Object.freeze({
    async read() {
      return cursor;
    },
    async write(next) {
      cursor = positiveInteger(next, "cursor", 0);
      return cursor;
    },
  });
}

/**
 * Durable wake cursor under a configurable path (Application Support–style or
 * test temp). Mirrors helper semantics: write temp → fsync → rename → fsync
 * parent directory where the platform allows.
 */
export function createAtomicFileCursorStore({ filePath, initial = 0 } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("filePath is required");
  }
  const resolvedPath = path.resolve(filePath);
  const directory = path.dirname(resolvedPath);
  let cursor = null;
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const raw = await readFile(resolvedPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        throw new TypeError("wake cursor file is invalid");
      }
      cursor = positiveInteger(parsed.cursor, "cursor", 0);
    } catch (error) {
      if (error?.code === "ENOENT") {
        cursor = positiveInteger(initial, "initial", 0);
      } else if (error instanceof SyntaxError) {
        throw new TypeError("wake cursor file is invalid");
      } else {
        throw error;
      }
    }
    loaded = true;
  }

  async function syncDirectory() {
    try {
      const handle = await open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      // Parent-dir fsync is best-effort where unsupported.
      if (
        error?.code === "EINVAL"
        || error?.code === "ENOTSUP"
        || error?.code === "EISDIR"
        || error?.code === "EPERM"
      ) {
        return;
      }
      throw error;
    }
  }

  async function atomicWrite(value) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.tmp-wake-cursor-${randomUUID().toLowerCase()}`);
    let installed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ cursor: value })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, resolvedPath);
      installed = true;
      await syncDirectory();
    } finally {
      if (!installed) {
        await unlink(temporary).catch(() => {});
      }
    }
  }

  return Object.freeze({
    filePath: resolvedPath,
    async read() {
      await ensureLoaded();
      return cursor;
    },
    async write(next) {
      await ensureLoaded();
      const value = positiveInteger(next, "cursor", 0);
      await atomicWrite(value);
      cursor = value;
      return cursor;
    },
  });
}

export function createWakeClient({
  profiles,
  transport,
  cursorStore = createMemoryCursorStore(0),
  coalesceMs = 300,
  onWake,
  sleep = sleepMs,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 100) {
    throw new TypeError("profiles must contain between 1 and 100 entries");
  }
  if (!transport || typeof transport.poll !== "function") {
    throw new TypeError("transport.poll is required");
  }
  if (typeof onWake !== "function") {
    throw new TypeError("onWake is required");
  }
  positiveInteger(coalesceMs, "coalesceMs", 1);

  const byAgent = new Map();
  for (const profile of profiles) {
    if (!profile || typeof profile !== "object") throw new TypeError("profile is invalid");
    if (!INSTANCE_ID.test(profile.instanceId)) throw new TypeError("instanceId is invalid");
    if (typeof profile.agentId !== "string" || !AGENT_ID.test(profile.agentId)) {
      throw new TypeError("agentId is invalid");
    }
    if (byAgent.has(profile.agentId)) throw new TypeError("duplicate agentId");
    byAgent.set(profile.agentId, profile.instanceId);
  }

  let pending = new Map();
  let flushTimer = null;
  let stopped = false;

  async function flush() {
    flushTimer = null;
    if (pending.size === 0) return;
    const batch = [...pending.entries()].map(([instanceId, highWatermark]) => ({
      instanceId,
      highWatermark,
    }));
    pending = new Map();
    const maxCursor = Math.max(...batch.map((entry) => entry.highWatermark));
    await cursorStore.write(maxCursor);
    for (const wake of batch) {
      await onWake(wake);
    }
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = sleep(coalesceMs).then(() => {
      if (stopped) return;
      return flush();
    });
  }

  function acceptEvents(events) {
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const agentId = event.agent_id ?? event.agentId;
      const highWatermark = event.high_watermark ?? event.highWatermark;
      if (typeof agentId !== "string" || !byAgent.has(agentId)) continue;
      if (!Number.isSafeInteger(highWatermark) || highWatermark < 1) continue;
      const instanceId = byAgent.get(agentId);
      const previous = pending.get(instanceId) ?? 0;
      if (highWatermark > previous) pending.set(instanceId, highWatermark);
    }
    if (pending.size > 0) scheduleFlush();
  }

  return Object.freeze({
    profileCount: byAgent.size,

    async runOnce({ signal } = {}) {
      if (stopped) return { stopped: true, events: 0 };
      const cursor = await cursorStore.read();
      let response;
      try {
        response = await transport.poll({ cursor, signal });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        if (error?.code === "resync_required" && Number.isSafeInteger(error.restartCursor)) {
          for (const instanceId of byAgent.values()) {
            await onWake({
              instanceId,
              highWatermark: error.restartCursor,
              reason: "resync_reconcile",
            });
          }
          await cursorStore.write(error.restartCursor);
          logger.error?.("triangle_wake_resync", { restartCursor: error.restartCursor });
          return { resync: true, restartCursor: error.restartCursor, events: 0 };
        }
        throw error;
      }
      if (!response || typeof response !== "object") {
        throw new TypeError("wake poll response is invalid");
      }
      const events = Array.isArray(response.events) ? response.events : [];
      acceptEvents(events);
      if (events.length === 0 && Number.isSafeInteger(response.cursor) && response.cursor >= cursor) {
        await cursorStore.write(response.cursor);
      }
      return { events: events.length, cursor: await cursorStore.read() };
    },

    async watch({ signal, maxCycles = Number.POSITIVE_INFINITY } = {}) {
      let cycles = 0;
      while (!stopped && !signal?.aborted && cycles < maxCycles) {
        cycles += 1;
        await this.runOnce({ signal });
        if (flushTimer) await flushTimer;
      }
      return { cycles, cursor: await cursorStore.read() };
    },

    async reconcileStartup({ signal } = {}) {
      const cursor = await cursorStore.read();
      for (const instanceId of byAgent.values()) {
        await onWake({ instanceId, highWatermark: cursor, reason: "startup_reconcile" });
      }
      return { profiles: byAgent.size, cursor };
    },

    async stop() {
      stopped = true;
      if (flushTimer) {
        await flushTimer.catch(() => {});
        flushTimer = null;
      }
      if (pending.size > 0) await flush();
    },
  });
}
