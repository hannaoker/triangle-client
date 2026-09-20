import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDurableConversationStore } from "../../src/codex-runtime/durable-conversation-store.mjs";
import { createExecutionLeaseManager } from "../../src/codex-runtime/execution-lease.mjs";
import { createDurableConversationRegistry } from "../../src/codex-runtime/conversation-registry.mjs";

const PROFILE = "a".repeat(64);
const ROOM = `room_${"b".repeat(32)}`;

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "triangle-lease-"));
}

function createClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    set(ms) {
      now = ms;
    },
  };
}

test("durable store stays inactive until shadow enables it", () => {
  const root = tempRoot();
  try {
    const store = createDurableConversationStore({ root, enabled: false });
    assert.throws(
      () => store.writeProfile({ profile_instance_id: PROFILE }),
      (error) => error.code === "durable_store_inactive",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lease acquire / renew / CAS replace / conflict / stale-generation", () => {
  const root = tempRoot();
  const clock = createClock();
  try {
    const store = createDurableConversationStore({
      root,
      enabled: true,
      now: clock.now,
    });
    const ownerA = createExecutionLeaseManager({
      store,
      ownerInstanceId: "owner-a",
      now: clock.now,
      leaseDurationMs: 10_000,
    });
    const ownerB = createExecutionLeaseManager({
      store,
      ownerInstanceId: "owner-b",
      now: clock.now,
      leaseDurationMs: 10_000,
    });

    const first = ownerA.acquire({ profileInstanceId: PROFILE });
    assert.equal(first.owner_generation, 1);
    assert.equal(first.owner_instance_id, "owner-a");

    const renewed = ownerA.renew({ profileInstanceId: PROFILE, activeMeshRoomId: ROOM });
    assert.equal(renewed.owner_generation, 1);
    assert.equal(renewed.active_mesh_room_id, ROOM);

    assert.throws(
      () => ownerB.acquire({ profileInstanceId: PROFILE }),
      (error) => error.code === "lease_conflict",
    );

    assert.throws(
      () => ownerA.rejectStaleGeneration({ profileInstanceId: PROFILE, claimedGeneration: 99 }),
      (error) => error.code === "lease_stale_generation",
    );

    // Expire idle lease, then CAS replace.
    clock.advance(11_000);
    assert.equal(ownerA.status({ profileInstanceId: PROFILE }).expired, true);

    const replaced = ownerB.replaceExpiredIdle({
      profileInstanceId: PROFILE,
      expectedGeneration: 1,
    });
    assert.equal(replaced.owner_generation, 2);
    assert.equal(replaced.owner_instance_id, "owner-b");

    assert.throws(
      () =>
        ownerA.replaceExpiredIdle({
          profileInstanceId: PROFILE,
          expectedGeneration: 1,
        }),
      (error) => error.code === "lease_cas_conflict",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-idle no-steal even when lease wall-clock expired", () => {
  const root = tempRoot();
  const clock = createClock();
  try {
    const store = createDurableConversationStore({
      root,
      enabled: true,
      now: clock.now,
    });
    const registry = createDurableConversationRegistry({
      store,
      now: clock.now,
      profileInstanceId: PROFILE,
    });
    const ownerA = createExecutionLeaseManager({
      store,
      ownerInstanceId: "owner-a",
      now: clock.now,
      leaseDurationMs: 5_000,
    });
    const ownerB = createExecutionLeaseManager({
      store,
      ownerInstanceId: "owner-b",
      now: clock.now,
      leaseDurationMs: 5_000,
    });

    ownerA.acquire({ profileInstanceId: PROFILE });
    registry.setThread(PROFILE, ROOM, "thread-1", { workerSlotId: "slot-1" });
    registry.upsert(PROFILE, ROOM, {
      executionState: "admitted",
      activeDeliveryId: "delivery_1",
      executionEpoch: 1,
    });
    registry.upsert(PROFILE, ROOM, { executionState: "running" });

    clock.advance(10_000);
    assert.throws(
      () =>
        ownerB.replaceExpiredIdle({
          profileInstanceId: PROFILE,
          expectedGeneration: 1,
        }),
      (error) => error.code === "lease_non_idle_no_steal",
    );
    assert.throws(
      () => ownerB.acquire({ profileInstanceId: PROFILE, afterRestart: true }),
      (error) => error.code === "lease_non_idle_no_steal",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clock skew freezes lease admission", () => {
  const root = tempRoot();
  const clock = createClock(1_000_000);
  try {
    const store = createDurableConversationStore({
      root,
      enabled: true,
      now: clock.now,
    });
    const owner = createExecutionLeaseManager({
      store,
      ownerInstanceId: "owner-a",
      now: clock.now,
      leaseDurationMs: 60_000,
      maxClockSkewMs: 1_000,
    });
    owner.acquire({ profileInstanceId: PROFILE });
    // Move wall clock backwards so renewed_at appears far in the future.
    clock.set(1_000_000 - 60_000);
    assert.throws(
      () => owner.renew({ profileInstanceId: PROFILE }),
      (error) => error.code === "lease_clock_skew",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable registry survives process-equivalent reload", () => {
  const root = tempRoot();
  try {
    const store = createDurableConversationStore({ root, enabled: true });
    const registry = createDurableConversationRegistry({
      store,
      profileInstanceId: PROFILE,
    });
    registry.setThread(PROFILE, ROOM, "thread-persist", { workerSlotId: "slot-1" });
    registry.upsert(PROFILE, ROOM, {
      executionState: "admitted",
      activeDeliveryId: "delivery_7",
      executionEpoch: 3,
    });

    const reloaded = createDurableConversationRegistry({
      store: createDurableConversationStore({ root, enabled: true }),
      profileInstanceId: PROFILE,
    });
    const row = reloaded.get(PROFILE, ROOM);
    assert.equal(row.codexThreadId, "thread-persist");
    assert.equal(row.executionEpoch, 3);
    assert.equal(row.executionState, "admitted");
    assert.doesNotMatch(JSON.stringify(row), /mesh_/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
