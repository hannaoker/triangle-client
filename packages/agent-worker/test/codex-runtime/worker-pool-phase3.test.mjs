import assert from "node:assert/strict";
import test from "node:test";

import { createCodexWorkerPool } from "../../src/codex-runtime/worker-pool.mjs";
import { resolveCodexPoolGuards } from "../../src/codex-runtime/runtime-home.mjs";
import { resolvePhase1ShadowRuntimeConfig } from "../../src/codex-runtime/config-guards.mjs";
import { createHeadlessCodexRuntime } from "../../src/codex-runtime/headless-runtime.mjs";
import { createFakeAppServerStdioProgram } from "../../src/codex-runtime/app-server-process.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PHASE3_MANIFEST = Object.freeze({
  sharedHomeConcurrency: {
    status: "passed",
    forcedPoolSize: 4,
    desktopHandoffEnabled: false,
    fallbackToUserCodexHomeForbidden: true,
  },
  featureFlags: {
    helperConversationStore: false,
    headlessRuntime: false,
    desktopHandoff: false,
  },
});

function createFakeProcessFactory() {
  let n = 0;
  return () => {
    n += 1;
    const id = n;
    let closed = false;
    return {
      async start() {},
      async initialize() {},
      async close() {
        closed = true;
      },
      status() {
        return { connected: !closed, fakeId: id };
      },
    };
  };
}

test("Phase 3 guards: preferred 2 under forcedPoolSize 4; preferred 1 still allowed", () => {
  const two = resolveCodexPoolGuards({
    preferredSize: 2,
    maxSize: 4,
    probeStatus: "passed",
    manifest: PHASE3_MANIFEST,
  });
  assert.equal(two.preferredSize, 2);
  assert.equal(two.maxSize, 4);
  assert.equal(two.forcedPoolSize, 4);
  assert.equal(two.forcedByProbe, false);
  assert.equal(two.desktopHandoffEnabled, false);

  const one = resolveCodexPoolGuards({
    preferredSize: 1,
    maxSize: 1,
    probeStatus: "passed",
    manifest: PHASE3_MANIFEST,
  });
  assert.equal(one.preferredSize, 1);
  assert.equal(one.maxSize, 1);

  const capped = resolveCodexPoolGuards({
    preferredSize: 9,
    maxSize: 9,
    probeStatus: "passed",
    manifest: PHASE3_MANIFEST,
  });
  assert.equal(capped.preferredSize, 4);
  assert.equal(capped.maxSize, 4);

  const shadow = resolvePhase1ShadowRuntimeConfig(
    {
      profileId: "codex-shadow-test",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "headless",
      shadowTestProfile: true,
    },
    { enableShadow: true, manifest: PHASE3_MANIFEST },
  );
  assert.equal(shadow.active, true);
  assert.equal(shadow.pool.preferredSize, 2);
});

test("Phase 3 pool: two concurrent slots", async () => {
  const pool = createCodexWorkerPool({
    preferredSize: 2,
    maxSize: 4,
    manifest: PHASE3_MANIFEST,
    createProcess: createFakeProcessFactory(),
  });
  await pool.start();
  try {
    const a = await pool.acquire({ conversationKey: "room-a" });
    const b = await pool.acquire({ conversationKey: "room-b" });
    assert.notEqual(a.slotId, b.slotId);
    assert.equal(pool.status().busyCount, 2);
    assert.equal(pool.status().size, 2);
    await assert.rejects(
      () => pool.acquire({ waitMs: 0 }),
      (error) => error.code === "pool_overloaded",
    );
    a.release();
    b.release();
    assert.equal(pool.status().busyCount, 0);
  } finally {
    await pool.stop({ signal: "SIGKILL", timeoutMs: 500 });
  }
});

test("Phase 3 sticky: prefers last healthy slot; failovers when sticky down", async () => {
  const pool = createCodexWorkerPool({
    preferredSize: 2,
    maxSize: 4,
    manifest: PHASE3_MANIFEST,
    createProcess: createFakeProcessFactory(),
    crashThreshold: 3,
    backoffBaseMs: 10_000,
    now: () => 1_000,
    random: () => 0,
  });
  await pool.start();
  try {
    const first = await pool.acquire({ conversationKey: "room-sticky" });
    const stickyId = first.slotId;
    first.release();

    const again = await pool.acquire({
      conversationKey: "room-sticky",
      stickySlotId: stickyId,
    });
    assert.equal(again.slotId, stickyId);
    again.release();

    // Open circuit on sticky slot → acquire must failover to the other healthy slot.
    pool.noteCrash(stickyId);
    pool.noteCrash(stickyId);
    const opened = pool.noteCrash(stickyId);
    assert.equal(opened.circuitOpen, true);

    const failover = await pool.acquire({
      conversationKey: "room-sticky",
      stickySlotId: stickyId,
    });
    assert.notEqual(failover.slotId, stickyId);
    failover.release();
  } finally {
    await pool.stop({ signal: "SIGKILL", timeoutMs: 500 });
  }
});

test("Phase 3 FIFO waiters under contention", async () => {
  const pool = createCodexWorkerPool({
    preferredSize: 2,
    maxSize: 4,
    manifest: PHASE3_MANIFEST,
    createProcess: createFakeProcessFactory(),
  });
  await pool.start();
  try {
    const a = await pool.acquire();
    const b = await pool.acquire();
    const order = [];
    const waiter1 = pool.acquire({ waitMs: 2_000 }).then((lease) => {
      order.push("w1");
      return lease;
    });
    // Let w1 enqueue first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const waiter2 = pool.acquire({ waitMs: 2_000 }).then((lease) => {
      order.push("w2");
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    a.release();
    const firstGranted = await Promise.race([
      waiter1.then((lease) => ({ which: "w1", lease })),
      waiter2.then((lease) => ({ which: "w2", lease })),
    ]);
    assert.equal(firstGranted.which, "w1");
    firstGranted.lease.release();
    const second = await waiter2;
    assert.deepEqual(order, ["w1", "w2"]);
    second.release();
    b.release();
  } finally {
    await pool.stop({ signal: "SIGKILL", timeoutMs: 500 });
  }
});

test("Phase 3 circuit-open: no acquire loop / no steal when all slots open", async () => {
  let clock = 1_000;
  const pool = createCodexWorkerPool({
    preferredSize: 2,
    maxSize: 4,
    manifest: PHASE3_MANIFEST,
    createProcess: createFakeProcessFactory(),
    crashThreshold: 2,
    backoffBaseMs: 5_000,
    backoffMaxMs: 5_000,
    now: () => clock,
    random: () => 0,
  });
  await pool.start();
  try {
    for (const slot of pool.status().slots) {
      pool.noteCrash(slot.slotId);
      const opened = pool.noteCrash(slot.slotId);
      assert.equal(opened.circuitOpen, true);
    }
    await assert.rejects(
      () => pool.acquire({ waitMs: 0 }),
      (error) => error.code === "pool_circuit_open",
    );
    // Advancing past backoff clears circuit for a healthy retry.
    clock += 6_000;
    const lease = await pool.acquire({ waitMs: 0 });
    assert.ok(lease.slotId);
    lease.release();
  } finally {
    await pool.stop({ signal: "SIGKILL", timeoutMs: 500 });
  }
});

test("Phase 3 getActiveHandle requires slotId when multiple slots busy", async () => {
  const pool = createCodexWorkerPool({
    preferredSize: 2,
    maxSize: 4,
    manifest: PHASE3_MANIFEST,
    createProcess: createFakeProcessFactory(),
  });
  await pool.start();
  try {
    const a = await pool.acquire();
    const b = await pool.acquire();
    assert.equal(pool.getActiveHandle(), null);
    assert.equal(pool.getActiveHandle({ slotId: a.slotId })?.slotId, a.slotId);
    assert.equal(pool.getActiveHandle({ slotId: b.slotId })?.slotId, b.slotId);
    a.release();
    assert.equal(pool.getActiveHandle()?.slotId, b.slotId);
    b.release();
  } finally {
    await pool.stop({ signal: "SIGKILL", timeoutMs: 500 });
  }
});

test("Phase 3 restartSlot targets one slot and leaves the sibling up", async () => {
  const pool = createCodexWorkerPool({
    preferredSize: 2,
    maxSize: 4,
    manifest: PHASE3_MANIFEST,
    createProcess: createFakeProcessFactory(),
  });
  await pool.start();
  try {
    const before = pool.status().slots.map((slot) => ({
      slotId: slot.slotId,
      generation: slot.generation,
      fakeId: slot.process.fakeId,
    }));
    const restarted = await pool.restartSlot({ slotId: "slot-1" });
    assert.equal(restarted.slotId, "slot-1");
    const after = pool.status().slots;
    assert.ok(after[0].generation > before[0].generation);
    assert.equal(after[1].generation, before[1].generation);
    assert.equal(after[1].process.fakeId, before[1].fakeId);
  } finally {
    await pool.stop({ signal: "SIGKILL", timeoutMs: 500 });
  }
});

test("Phase 3 headless runtime: two concurrent deliveries on distinct slots", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "triangle-phase3-conc-"));
  const store = path.join(home, "materialized-threads");
  const fake = createFakeAppServerStdioProgram({
    serverIdentity: "fake-phase3",
    idPrefix: "p3",
    requireMaterializedRollout: true,
    materializedStorePath: store,
  });
  const proxy = {
    async reply() {
      return { replyEventId: `event_${"d".repeat(32)}`, state: "replied" };
    },
    async ack() {
      return { acknowledged: true };
    },
  };
  const roomA = `room_${"a".repeat(32)}`;
  const roomB = `room_${"b".repeat(32)}`;
  const profileInstanceId = "c".repeat(64);
  const runtime = createHeadlessCodexRuntime({
    profileConfig: {
      profileId: "codex-shadow-test",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "headless",
      shadowTestProfile: true,
      approvalPolicy: "never",
      sandboxClass: "read-only",
      workingDirectory: home,
    },
    enableShadow: true,
    transactionProxy: proxy,
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
    logger: { info() {}, error() {} },
  });

  try {
    const started = await runtime.start();
    assert.equal(started.pool.size, 2);
    assert.equal(started.pool.forcedPoolSize, 4);
    assert.equal(started.pool.slots.length, 2);

    const [left, right] = await Promise.all([
      runtime.runDelivery({
        profileInstanceId,
        roomId: roomA,
        deliveryId: "delivery_1",
        numericDeliveryId: 1,
        text: "concurrent left",
      }),
      runtime.runDelivery({
        profileInstanceId,
        roomId: roomB,
        deliveryId: "delivery_2",
        numericDeliveryId: 2,
        text: "concurrent right",
      }),
    ]);
    assert.equal(left.status, "completed");
    assert.equal(right.status, "completed");
    assert.notEqual(left.slotId, right.slotId);

    // Overload: hold both slots via pool, then runtime fail-closes.
    const poolLeaseA = await runtime.pool.acquire({ conversationKey: "hold-a" });
    const poolLeaseB = await runtime.pool.acquire({ conversationKey: "hold-b" });
    await assert.rejects(
      () =>
        runtime.runDelivery({
          profileInstanceId,
          roomId: `room_${"e".repeat(32)}`,
          deliveryId: "delivery_3",
          numericDeliveryId: 3,
          text: "should overload",
        }),
      (error) => error.code === "pool_overloaded",
    );
    poolLeaseA.release();
    poolLeaseB.release();

    // Sticky preference: same room reuses lastWorkerSlotId when healthy.
    const stickyRoom = roomA;
    const prior = runtime.registry.get(profileInstanceId, stickyRoom);
    const third = await runtime.runDelivery({
      profileInstanceId,
      roomId: stickyRoom,
      deliveryId: "delivery_4",
      numericDeliveryId: 4,
      text: "sticky resume",
    });
    assert.equal(third.startedNewThread, false);
    assert.equal(third.slotId, prior.lastWorkerSlotId);
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 1_000 });
    rmSync(home, { recursive: true, force: true });
  }
});
