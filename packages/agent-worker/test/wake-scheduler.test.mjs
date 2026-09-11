import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createConcurrencyGate } from "../src/concurrency-gate.mjs";
import {
  createFakeHarness,
  createProfileScheduler,
  createWakeRuntime,
} from "../src/profile-scheduler.mjs";
import {
  createAtomicFileCursorStore,
  createMemoryCursorStore,
  createWakeClient,
} from "../src/wake-client.mjs";

const id = (index) => index.toString(16).padStart(64, "0");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function tempCursorPath() {
  const root = mkdtempSync(path.join(tmpdir(), "triangle-wake-cursor-"));
  return {
    root,
    filePath: path.join(root, "Library", "Application Support", "The Triangle", "client", "wake-cursor.json"),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("wake client coalesces bursts and persists the newest cursor per profile", async () => {
  const wakes = [];
  let cursor = 0;
  const transport = {
    async poll({ cursor: supplied }) {
      cursor = supplied;
      return {
        cursor: 5,
        events: [
          { agent_id: "agent_a", high_watermark: 3 },
          { agent_id: "agent_a", high_watermark: 5 },
          { agent_id: "agent_b", high_watermark: 4 },
          { agent_id: "agent_foreign", high_watermark: 9 },
        ],
      };
    },
  };
  const store = createMemoryCursorStore(0);
  const client = createWakeClient({
    profiles: [
      { instanceId: id(1), agentId: "agent_a" },
      { instanceId: id(2), agentId: "agent_b" },
    ],
    transport,
    cursorStore: store,
    coalesceMs: 5,
    onWake: async (wake) => { wakes.push(wake); },
  });

  await client.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(cursor, 0);
  assert.equal(await store.read(), 5);
  assert.deepEqual(
    wakes.sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
    [
      { instanceId: id(1), highWatermark: 5 },
      { instanceId: id(2), highWatermark: 4 },
    ],
  );
});

test("wake client resync reconciles every local profile before advancing the restart cursor", async () => {
  const store = createMemoryCursorStore(2);
  const wakes = [];
  const client = createWakeClient({
    profiles: [{ instanceId: id(1), agentId: "agent_a" }],
    transport: {
      async poll() {
        const error = new Error("resync");
        error.code = "resync_required";
        error.restartCursor = 40;
        throw error;
      },
    },
    cursorStore: store,
    coalesceMs: 1,
    onWake: async (wake) => { wakes.push(wake); },
  });
  const result = await client.runOnce();
  assert.equal(result.resync, true);
  assert.equal(await store.read(), 40);
  assert.deepEqual(wakes, [{
    instanceId: id(1),
    highWatermark: 40,
    reason: "resync_reconcile",
  }]);
});

test("scheduler retries a failed drain without requiring another wake", async () => {
  let attempts = 0;
  const scheduler = createProfileScheduler({
    gate: createConcurrencyGate({ limit: 1 }),
    harness: createFakeHarness({
      drain: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
      },
    }),
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    idleJitterRatio: 0,
    logger: { error() {} },
  });
  scheduler.submitWake({ instanceId: id(1), highWatermark: 1 });
  await scheduler.idle();
  assert.equal(attempts, 2);
});

test("scheduler retries a claim conflict without requiring another wake", async () => {
  let attempts = 0;
  const error = new Error("claim conflict");
  error.code = "claim_conflict";
  const scheduler = createProfileScheduler({
    gate: createConcurrencyGate({ limit: 1 }),
    harness: createFakeHarness({
      drain: async () => {
        attempts += 1;
        if (attempts === 1) throw error;
        return { status: "drained" };
      },
    }),
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    idleJitterRatio: 0,
    logger: { error() {} },
  });
  scheduler.submitWake({ instanceId: id(1), highWatermark: 1 });
  await scheduler.idle();
  assert.equal(attempts, 2);
  assert.equal(scheduler.snapshot()[0].lastReconciled, 1);
});

test("scheduler runs distinct profiles concurrently up to the shared gate", async () => {
  const entered = [deferred(), deferred()];
  const release = deferred();
  let active = 0;
  let peak = 0;
  const scheduler = createProfileScheduler({
    gate: createConcurrencyGate({ limit: 2 }),
    harness: createFakeHarness({
      drain: async ({ instanceId }) => {
        active += 1;
        peak = Math.max(peak, active);
        entered[Number.parseInt(instanceId.slice(-1), 16) - 1].resolve();
        await release.promise;
        active -= 1;
        return { status: "drained" };
      },
    }),
  });
  scheduler.submitWake({ instanceId: id(1), highWatermark: 1 });
  scheduler.submitWake({ instanceId: id(2), highWatermark: 2 });
  await Promise.all(entered.map((item) => item.promise));
  assert.equal(peak, 2);
  release.resolve();
  await scheduler.idle();
});

test("scheduler abort stops queued work and propagates to an active harness", async () => {
  const controller = new AbortController();
  const entered = deferred();
  let secondStarted = false;
  const scheduler = createProfileScheduler({
    gate: createConcurrencyGate({ limit: 1 }),
    signal: controller.signal,
    logger: { error() {} },
    harness: createFakeHarness({
      drain: async ({ instanceId, signal }) => {
        if (instanceId === id(2)) secondStarted = true;
        entered.resolve(signal);
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    }),
  });
  scheduler.submitWake({ instanceId: id(1), highWatermark: 1 });
  scheduler.submitWake({ instanceId: id(2), highWatermark: 2 });
  assert.equal(await entered.promise, controller.signal);
  controller.abort();
  await scheduler.idle();
  assert.equal(secondStarted, false);
});

test("scheduler abort interrupts retry backoff", async () => {
  const controller = new AbortController();
  const failed = deferred();
  const scheduler = createProfileScheduler({
    gate: createConcurrencyGate({ limit: 1 }),
    signal: controller.signal,
    initialBackoffMs: 60_000,
    maxBackoffMs: 60_000,
    logger: { error() { failed.resolve(); } },
    harness: createFakeHarness({ drain: async () => { throw new Error("retry"); } }),
  });
  scheduler.submitWake({ instanceId: id(1), highWatermark: 1 });
  await failed.promise;
  controller.abort();
  await Promise.race([
    scheduler.idle(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("abort did not interrupt backoff")), 100)),
  ]);
});

test("scheduler preserves a newer wake that arrives during a negative preflight", async () => {
  const entered = deferred();
  const release = deferred();
  let preflights = 0;
  const scheduler = createProfileScheduler({
    gate: createConcurrencyGate({ limit: 1 }),
    harness: createFakeHarness({
      actionable: async () => {
        preflights += 1;
        if (preflights === 1) {
          entered.resolve();
          await release.promise;
          return false;
        }
        return true;
      },
    }),
  });
  scheduler.submitWake({ instanceId: id(1), highWatermark: 1 });
  await entered.promise;
  scheduler.submitWake({ instanceId: id(1), highWatermark: 2 });
  release.resolve();
  await scheduler.idle();
  assert.equal(preflights, 2);
  assert.equal(scheduler.snapshot()[0].lastReconciled, 2);
});

test("scheduler drains at most once per wake burst and reconciles dirty wakes after the turn", async () => {
  const gate = createConcurrencyGate({ limit: 2 });
  const release = deferred();
  let drains = 0;
  const harness = createFakeHarness({
    drain: async () => {
      drains += 1;
      if (drains === 1) await release.promise;
      return { status: "drained" };
    },
  });
  const scheduler = createProfileScheduler({
    gate,
    harness,
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    sleep: async () => {},
  });

  scheduler.submitWake({ instanceId: id(1), highWatermark: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.submitWake({ instanceId: id(1), highWatermark: 4 });
  scheduler.submitWake({ instanceId: id(1), highWatermark: 5 });
  assert.equal(drains, 1);
  release.resolve();
  await scheduler.idle();
  assert.equal(drains, 2);
  assert.equal(harness.calls.filter((call) => call.type === "drain").at(-1).highWatermark, 5);
});

test("scheduler skips model starts when preflight finds no actionable delivery", async () => {
  const harness = createFakeHarness({ actionable: async () => false });
  const scheduler = createProfileScheduler({
    gate: createConcurrencyGate({ limit: 2 }),
    harness,
    sleep: async () => {},
  });
  scheduler.submitWake({ instanceId: id(1), highWatermark: 7 });
  await scheduler.idle();
  assert.deepEqual(harness.calls.map((call) => call.type), ["preflight"]);
});

test("mixed worker and event-driven drains never exceed the shared gate of two", async () => {
  const gate = createConcurrencyGate({ limit: 2 });
  let active = 0;
  let peak = 0;
  const releases = [deferred(), deferred(), deferred()];
  const harness = createFakeHarness({
    drain: async ({ instanceId }) => {
      active += 1;
      peak = Math.max(peak, active);
      const index = Number.parseInt(instanceId.slice(-1), 16) - 1;
      await releases[index].promise;
      active -= 1;
    },
  });
  const scheduler = createProfileScheduler({
    gate,
    harness,
    sleep: async () => {},
  });
  const workerJobs = [
    gate.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await releases[2].promise;
      active -= 1;
    }),
  ];
  scheduler.submitWake({ instanceId: id(1), highWatermark: 1 });
  scheduler.submitWake({ instanceId: id(2), highWatermark: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak <= 2, true);
  releases[0].resolve();
  releases[1].resolve();
  releases[2].resolve();
  await Promise.all(workerJobs);
  await scheduler.idle();
  assert.equal(peak, 2);
});

test("ten-profile wake runtime multiplexes one transport and runs startup reconciliation", async () => {
  const profiles = Array.from({ length: 10 }, (_, index) => ({
    instanceId: id(index + 1),
    agentId: `agent_${String(index).padStart(2, "0")}`,
  }));
  const harness = createFakeHarness();
  const transport = {
    async poll({ cursor }) {
      return {
        cursor: cursor + 1,
        events: profiles.map((profile, index) => ({
          agent_id: profile.agentId,
          high_watermark: index + 1,
        })),
      };
    },
  };
  const runtime = createWakeRuntime({
    profiles,
    transport,
    gate: createConcurrencyGate({ limit: 2 }),
    harness,
    cursorStore: createMemoryCursorStore(0),
    coalesceMs: 1,
  });
  await runtime.wake.reconcileStartup();
  await runtime.scheduler.idle();
  const startupPreflights = harness.calls.filter((call) => call.type === "preflight").length;
  assert.equal(startupPreflights, 10);

  await runtime.wake.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await runtime.scheduler.idle();
  const drains = harness.calls.filter((call) => call.type === "drain");
  assert.equal(drains.length >= 10, true);
  assert.equal(new Set(drains.map((call) => call.instanceId)).size, 10);
});

test("atomic file cursor store survives reload after a durable write", async () => {
  const fixture = tempCursorPath();
  try {
    const store = createAtomicFileCursorStore({ filePath: fixture.filePath });
    assert.equal(await store.read(), 0);
    await store.write(17);
    const reloaded = createAtomicFileCursorStore({ filePath: fixture.filePath });
    assert.equal(await reloaded.read(), 17);
  } finally {
    fixture.cleanup();
  }
});

test("crash after cursor persist and before drain keeps the advanced cursor on restart", async () => {
  // Expected: flush writes the cursor before onWake; a crash mid-drain must not
  // roll the on-disk cursor backward, so restart resumes at the persisted watermark.
  const fixture = tempCursorPath();
  try {
    const store = createAtomicFileCursorStore({ filePath: fixture.filePath });
    await store.write(2);
    const enteredDrain = deferred();
    const releaseDrain = deferred();
    const client = createWakeClient({
      profiles: [{ instanceId: id(1), agentId: "agent_a" }],
      transport: {
        async poll() {
          return {
            cursor: 9,
            events: [{ agent_id: "agent_a", high_watermark: 9 }],
          };
        },
      },
      cursorStore: store,
      coalesceMs: 1,
      onWake: async () => {
        enteredDrain.resolve();
        await releaseDrain.promise;
      },
    });
    await client.runOnce();
    await enteredDrain.promise;
    assert.equal(await store.read(), 9);

    const reloaded = createAtomicFileCursorStore({ filePath: fixture.filePath });
    assert.equal(await reloaded.read(), 9);

    releaseDrain.resolve();
    await client.stop();
  } finally {
    fixture.cleanup();
  }
});

test("crash before cursor persist does not advance past the unpersisted cursor on restart", async () => {
  // Expected: a process that advances only an in-memory cursor (crash before the
  // atomic file write) leaves the on-disk value unchanged; restart resumes there.
  const fixture = tempCursorPath();
  try {
    const durable = createAtomicFileCursorStore({ filePath: fixture.filePath });
    await durable.write(4);
    const ephemeral = createMemoryCursorStore(4);
    const client = createWakeClient({
      profiles: [{ instanceId: id(1), agentId: "agent_a" }],
      transport: {
        async poll() {
          return {
            cursor: 12,
            events: [{ agent_id: "agent_a", high_watermark: 12 }],
          };
        },
      },
      cursorStore: ephemeral,
      coalesceMs: 1,
      onWake: async () => {},
    });
    await client.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await ephemeral.read(), 12);
    assert.equal(await durable.read(), 4);

    const reloaded = createAtomicFileCursorStore({ filePath: fixture.filePath });
    assert.equal(await reloaded.read(), 4);
    await client.stop();
  } finally {
    fixture.cleanup();
  }
});

test("createWakeRuntime accepts cursorPath and reloads the file store after restart", async () => {
  const fixture = tempCursorPath();
  try {
    const profiles = [{ instanceId: id(1), agentId: "agent_a" }];
    const harness = createFakeHarness();
    const transport = {
      async poll() {
        return {
          cursor: 6,
          events: [{ agent_id: "agent_a", high_watermark: 6 }],
        };
      },
    };
    const first = createWakeRuntime({
      profiles,
      transport,
      gate: createConcurrencyGate({ limit: 1 }),
      harness,
      cursorPath: fixture.filePath,
      coalesceMs: 1,
    });
    await first.wake.runOnce();
    // runOnce only schedules the coalesce flush; stop awaits that flush so the
    // cursor is durable before we assert or tear down the temp directory.
    await first.wake.stop();
    await first.scheduler.idle();
    assert.equal(await first.cursorStore.read(), 6);

    const second = createWakeRuntime({
      profiles,
      transport: {
        async poll({ cursor }) {
          assert.equal(cursor, 6);
          return { cursor: 6, events: [] };
        },
      },
      gate: createConcurrencyGate({ limit: 1 }),
      harness: createFakeHarness(),
      cursorPath: fixture.filePath,
      coalesceMs: 1,
    });
    assert.equal(await second.cursorStore.read(), 6);
    await second.wake.runOnce();
    await second.wake.stop();
  } finally {
    fixture.cleanup();
  }
});
