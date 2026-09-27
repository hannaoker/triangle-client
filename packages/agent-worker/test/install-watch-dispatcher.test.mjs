import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INSTALL_WATCH_SAFE_IDLE_POLL_MS,
  assertFanOutAccepted,
  createInstallWatchDispatcher,
  createMemoryCursorStore,
  migrateInstallWatchCursor,
  resolveInstallWatchCursorPath,
} from "../src/install-watch-dispatcher.mjs";
import { createAtomicFileCursorStore } from "../src/wake-client.mjs";

const INSTANCE_A = "a".repeat(64);
const INSTANCE_B = "b".repeat(64);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("resolveInstallWatchCursorPath places install cursor beside lane cursor", () => {
  assert.equal(
    resolveInstallWatchCursorPath("/private/grok-bot-wake-cursor.json"),
    "/private/install-wake-cursor.json",
  );
});

test("D4 migrateInstallWatchCursor takes max across lane cursors", async () => {
  const install = createMemoryCursorStore(2);
  const laneA = createMemoryCursorStore(7);
  const laneB = createMemoryCursorStore(4);
  const migrated = await migrateInstallWatchCursor({
    installCursorStore: install,
    laneCursorStores: [laneA, laneB],
  });
  assert.equal(migrated, 7);
  assert.equal(await install.read(), 7);
});

test("install dispatcher fans out by agent_id and persists cursor after handlers", async () => {
  const handled = [];
  const cursorStore = createMemoryCursorStore(0);
  let writes = 0;
  const trackingStore = {
    async read() {
      return cursorStore.read();
    },
    async write(next) {
      writes += 1;
      return cursorStore.write(next);
    },
  };
  const transport = {
    async poll({ cursor }) {
      if (cursor >= 10) return { cursor, events: [] };
      return {
        cursor: 10,
        events: [
          { agent_id: "agent_bob", high_watermark: 10 },
          { agent_id: "agent_headless", high_watermark: 9 },
          { agent_id: "agent_foreign", high_watermark: 99 },
        ],
      };
    },
  };
  const dispatcher = createInstallWatchDispatcher({
    profiles: [
      { instanceId: INSTANCE_A, agentId: "agent_bob" },
      { instanceId: INSTANCE_B, agentId: "agent_headless" },
    ],
    handlers: {
      [INSTANCE_A]: async (wake) => {
        handled.push({ who: "bob", ...wake });
        return { status: "accepted" };
      },
      [INSTANCE_B]: async (wake) => {
        handled.push({ who: "headless", ...wake });
        return { status: "pending" };
      },
    },
    transport,
    cursorStore: trackingStore,
    coalesceMs: 1,
    idlePollIntervalMs: 0,
    laneCursorStores: [],
  });

  const controller = new AbortController();
  const run = dispatcher.start({ signal: controller.signal, maxCycles: 1, reconcile: false });
  await sleep(20);
  controller.abort();
  await run;

  assert.equal(handled.length, 2);
  assert.equal(handled[0].who, "bob");
  assert.equal(handled[0].instanceId, INSTANCE_A);
  assert.equal(handled[0].highWatermark, 10);
  assert.equal(handled[1].who, "headless");
  assert.equal(handled[1].instanceId, INSTANCE_B);
  assert.equal(handled[1].highWatermark, 9);
  assert.equal(await cursorStore.read(), 10);
  assert.ok(writes >= 1);
});

test("install dispatcher does not advance cursor when a handler throws", async () => {
  const cursorStore = createMemoryCursorStore(0);
  const transport = {
    async poll() {
      return {
        cursor: 5,
        events: [{ agent_id: "agent_bob", high_watermark: 5 }],
      };
    },
  };
  const dispatcher = createInstallWatchDispatcher({
    profiles: [{ instanceId: INSTANCE_A, agentId: "agent_bob" }],
    handlers: {
      [INSTANCE_A]: async () => {
        throw Object.assign(new Error("kick failed"), { code: "kick_failed" });
      },
    },
    transport,
    cursorStore,
    coalesceMs: 1,
    idlePollIntervalMs: 0,
  });

  await assert.rejects(
    () => dispatcher.start({ maxCycles: 1, reconcile: false }),
    /kick failed/,
  );
  assert.equal(await cursorStore.read(), 0);
});

test("assertFanOutAccepted rejects soft {status:failed} results", () => {
  assert.throws(
    () => assertFanOutAccepted({ status: "failed", code: "webhook_failed" }),
    (error) => error?.code === "webhook_failed",
  );
  assert.deepEqual(assertFanOutAccepted({ status: "accepted" }), { status: "accepted" });
});

test("install dispatcher rejects soft failed status and does not advance cursor", async () => {
  const cursorStore = createMemoryCursorStore(0);
  const transport = {
    async poll() {
      return {
        cursor: 6,
        events: [{ agent_id: "agent_bob", high_watermark: 6 }],
      };
    },
  };
  const dispatcher = createInstallWatchDispatcher({
    profiles: [{ instanceId: INSTANCE_A, agentId: "agent_bob" }],
    handlers: {
      [INSTANCE_A]: async () => ({ status: "failed", code: "webhook_failed" }),
    },
    transport,
    cursorStore,
    coalesceMs: 1,
    idlePollIntervalMs: 0,
  });

  await assert.rejects(
    () => dispatcher.start({ maxCycles: 1, reconcile: false }),
    (error) => error?.code === "webhook_failed",
  );
  assert.equal(await cursorStore.read(), 0);
});

test("failed fan-out leaves cursor unadvanced so a later poll can replay", async () => {
  const cursorStore = createMemoryCursorStore(0);
  let attempts = 0;
  const handled = [];
  const transport = {
    async poll({ cursor }) {
      if (cursor >= 8) return { cursor, events: [] };
      return {
        cursor: 8,
        events: [{ agent_id: "agent_bob", high_watermark: 8 }],
      };
    },
  };
  const handlers = {
    [INSTANCE_A]: async (wake) => {
      attempts += 1;
      handled.push(wake.highWatermark);
      if (attempts === 1) {
        throw Object.assign(new Error("webhook down"), { code: "webhook_failed" });
      }
      return { status: "accepted" };
    },
  };

  const first = createInstallWatchDispatcher({
    profiles: [{ instanceId: INSTANCE_A, agentId: "agent_bob" }],
    handlers,
    transport,
    cursorStore,
    coalesceMs: 1,
    idlePollIntervalMs: 0,
  });
  await assert.rejects(
    () => first.start({ maxCycles: 1, reconcile: false }),
    /webhook down/,
  );
  assert.equal(await cursorStore.read(), 0);

  const second = createInstallWatchDispatcher({
    profiles: [{ instanceId: INSTANCE_A, agentId: "agent_bob" }],
    handlers,
    transport,
    cursorStore,
    coalesceMs: 1,
    idlePollIntervalMs: 0,
    migrateLaneCursors: false,
  });
  await second.start({ maxCycles: 1, reconcile: false });
  assert.equal(await cursorStore.read(), 8);
  assert.deepEqual(handled, [8, 8]);
});

test("install dispatcher defaults to safe 30s idle until held-poll is proven", () => {
  const dispatcher = createInstallWatchDispatcher({
    profiles: [{ instanceId: INSTANCE_A, agentId: "agent_bob" }],
    handlers: { [INSTANCE_A]: async () => ({ status: "ok" }) },
    transport: { async poll() { return { cursor: 0, events: [] }; } },
  });
  assert.equal(dispatcher.idlePollIntervalMs, INSTALL_WATCH_SAFE_IDLE_POLL_MS);
  assert.equal(INSTALL_WATCH_SAFE_IDLE_POLL_MS, 30_000);
});

test("install dispatcher migrates lane cursors from disk before first poll", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "install-watch-"));
  const lanePath = path.join(root, "grok-bot-wake-cursor.json");
  const installPath = resolveInstallWatchCursorPath(lanePath);
  await writeFile(lanePath, `${JSON.stringify({ cursor: 42 })}\n`, "utf8");

  let polledCursor = null;
  const transport = {
    async poll({ cursor }) {
      polledCursor = cursor;
      return { cursor, events: [] };
    },
  };
  const dispatcher = createInstallWatchDispatcher({
    profiles: [{ instanceId: INSTANCE_A, agentId: "agent_bob" }],
    handlers: {
      [INSTANCE_A]: async () => ({ status: "ok" }),
    },
    transport,
    cursorPath: installPath,
    laneCursorStores: [createAtomicFileCursorStore({ filePath: lanePath })],
    coalesceMs: 1,
    idlePollIntervalMs: 0,
  });

  await dispatcher.start({ maxCycles: 1, reconcile: false });
  assert.equal(polledCursor, 42);
  const raw = JSON.parse(await readFile(installPath, "utf8"));
  assert.equal(raw.cursor, 42);
});

test("install dispatcher rejects profiles without handlers", () => {
  assert.throws(() => createInstallWatchDispatcher({
    profiles: [{ instanceId: INSTANCE_A, agentId: "agent_bob" }],
    handlers: {},
    transport: { async poll() { return { cursor: 0, events: [] }; } },
  }), /handlers must contain at least one entry|no handler/);
});
