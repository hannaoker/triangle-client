import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessCodexDrain } from "../../src/codex-runtime/headless-drain.mjs";
import {
  PINNED_HEADLESS_DRAIN_PROFILE,
  PINNED_HEADLESS_DRAIN_ROOM_ID,
  createHeadlessClaimerGuard,
  dedicatedHeadlessDrainLaunchAgentLabel,
  deriveProfileInstanceId,
  loadHeadlessDrainConfig,
  normalizeHeadlessWakeConfig,
} from "../../src/codex-runtime/headless-drain-service.mjs";

const INSTANCE = "a".repeat(64);
const ROOM = "room_8594d12312e14afbb291fcff60a22048";
const EVENT = `event_${"c".repeat(32)}`;

function delivery(overrides = {}) {
  return {
    deliveryId: "delivery_17",
    numericDeliveryId: 17,
    roomId: ROOM,
    inboundEventId: EVENT,
    text: "Review the Phase 5 drain design.",
    replyRequired: true,
    ...overrides,
  };
}

test("drain composes claimed helper delivery with the persistent headless runtime", async () => {
  const calls = [];
  const runtime = {
    async start() { calls.push("runtime.start"); },
    async recoverAfterRestart(args) { calls.push(["runtime.recover", args]); return { quarantined: 0 }; },
    async runDelivery(args) { calls.push(["runtime.runDelivery", args]); return { status: "completed" }; },
    async stop() { calls.push("runtime.stop"); },
  };
  const resolver = async () => delivery();
  const drain = createHeadlessCodexDrain({
    runtime,
    resolveDelivery: resolver,
    profileInstanceId: INSTANCE,
  });

  await drain.start({ runLoop: false });
  const result = await drain.drainOnce();
  await drain.stop();

  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [
    "runtime.start",
    ["runtime.recover", { profileInstanceId: INSTANCE }],
    ["runtime.runDelivery", { profileInstanceId: INSTANCE, ...delivery() }],
    "runtime.stop",
  ]);
});

test("empty and receipt-only helper results never admit a model turn", async () => {
  let runs = 0;
  const runtime = {
    async start() {},
    async recoverAfterRestart() { return { quarantined: 0 }; },
    async runDelivery() { runs += 1; },
    async stop() {},
  };
  const drain = createHeadlessCodexDrain({
    runtime,
    resolveDelivery: async () => null,
    profileInstanceId: INSTANCE,
  });

  await drain.start({ runLoop: false });
  assert.deepEqual(await drain.drainOnce(), { status: "idle" });
  assert.equal(runs, 0);
  await drain.stop();
});

test("concurrent wakeups single-flight and a failed turn remains unacknowledged", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let resolves = 0;
  let runs = 0;
  const runtime = {
    async start() {},
    async recoverAfterRestart() { return { quarantined: 0 }; },
    async runDelivery() {
      runs += 1;
      await blocked;
      throw Object.assign(new Error("App Server exited"), { code: "child_exited" });
    },
    async stop() {},
  };
  const drain = createHeadlessCodexDrain({
    runtime,
    resolveDelivery: async () => {
      resolves += 1;
      return delivery();
    },
    profileInstanceId: INSTANCE,
  });

  await drain.start({ runLoop: false });
  const first = drain.drainOnce();
  const second = drain.drainOnce();
  release();
  await assert.rejects(first, (error) => error.code === "child_exited");
  assert.deepEqual(await second, { status: "already_draining" });
  assert.equal(resolves, 1);
  assert.equal(runs, 1);
  await drain.stop();
});

test("restart recovery blocks new claims when a prior turn is quarantined", async () => {
  let resolved = false;
  const runtime = {
    async start() {},
    async recoverAfterRestart() { return { quarantined: 1 }; },
    async runDelivery() { throw new Error("must not run"); },
    async stop() {},
  };
  const drain = createHeadlessCodexDrain({
    runtime,
    resolveDelivery: async () => { resolved = true; return delivery(); },
    profileInstanceId: INSTANCE,
  });

  await assert.rejects(
    () => drain.start({ runLoop: false }),
    (error) => error.code === "headless_drain_recovery_blocked",
  );
  assert.equal(resolved, false);
});

test("installed drain config accepts any Codex profile and does not pin a global room", () => {
  const profile = "codex-bob-test";
  const env = {
    HOME: "/Users/tester",
    CODEX_CLI: "/opt/triangle/bin/codex",
    TRIANGLE_CODEX_HOME: "/Users/tester/Library/Application Support/The Triangle/codex-home",
    TRIANGLE_HEADLESS_WORKING_DIRECTORY: "/srv/triangle-work",
  };
  const config = loadHeadlessDrainConfig({ profile, env });
  assert.equal(config.profileInstanceId, deriveProfileInstanceId(profile));
  assert.match(config.profileInstanceId, /^[a-f0-9]{64}$/);
  assert.equal(config.pollIntervalMs, 1_000);
  assert.equal(config.allowedRoomId, null);

  assert.throws(
    () => loadHeadlessDrainConfig({ profile, env: { ...env, TRIANGLE_INSTANCE_ID: "f".repeat(64) } }),
    /does not match profile/,
  );
  assert.throws(
    () => loadHeadlessDrainConfig({ profile, env: { ...env, TRIANGLE_HEADLESS_ROOM_ID: "room_invalid" } }),
    /TRIANGLE_HEADLESS_ROOM_ID/,
  );
  const filtered = loadHeadlessDrainConfig({
    profile,
    env: { ...env, TRIANGLE_HEADLESS_ROOM_ID: "room_77aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  });
  assert.equal(filtered.allowedRoomId, "room_77aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("headless wake config accepts any Codex profile and keys conversations by delivery roomId", () => {
  const profile = "codex-bob-test";
  const profileInstanceId = deriveProfileInstanceId(profile);
  const valid = {
    profile,
    profileInstanceId,
    helperPath: "/trusted/triangle-mailbox",
    workingDirectory: "/srv/triangle-work",
    codexHome: "/private/codex-home",
    stateRoot: "/private/headless-state",
    command: "/trusted/bin/codex",
    pollIntervalMs: 1_000,
  };
  assert.deepEqual(normalizeHeadlessWakeConfig(valid), { ...valid, allowedRoomId: null });
  const withRoom = {
    ...valid,
    allowedRoomId: "room_77aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  assert.equal(normalizeHeadlessWakeConfig(withRoom).allowedRoomId, withRoom.allowedRoomId);
  assert.throws(
    () => normalizeHeadlessWakeConfig({ ...valid, allowedRoomId: "room_invalid" }),
    /allowedRoomId/,
  );
  assert.throws(
    () => createHeadlessClaimerGuard({
      profile: "bob",
      runtimeAdapter: "grok-bot",
      env: { HOME: "/Users/tester" },
      lockPath: `/tmp/triangle-headless-claimer-grok-${process.pid}.json`,
    }),
    (error) => error.code === "grok_bot_not_in_codex_pool",
  );
});

test("drain passes each delivery roomId through as the conversation key", async () => {
  const rooms = [];
  const runtime = {
    async start() {},
    async recoverAfterRestart() { return { quarantined: 0 }; },
    async runDelivery(args) {
      rooms.push(args.roomId);
      return { status: "completed" };
    },
    async stop() {},
  };
  const deliveries = [
    delivery({ roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    delivery({ roomId: "room_77aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
  ];
  let index = 0;
  const drain = createHeadlessCodexDrain({
    runtime,
    resolveDelivery: async () => deliveries[index++] ?? null,
    profileInstanceId: INSTANCE,
  });
  await drain.start({ runLoop: false });
  await drain.drainOnce();
  await drain.drainOnce();
  await drain.stop();
  assert.deepEqual(rooms, [
    "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "room_77aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]);
});

test("claimer guard refuses dual consumers on the same profile", () => {
  const profile = PINNED_HEADLESS_DRAIN_PROFILE;
  const lockPath = `/tmp/triangle-headless-claimer-${process.pid}.json`;
  const supervisor = createHeadlessClaimerGuard({
    profile,
    allowedRoomId: PINNED_HEADLESS_DRAIN_ROOM_ID,
    pid: 4_001,
    lockPath,
    probeDedicatedDrain: () => false,
    pidAlive: (candidate) => candidate === 4_001 || candidate === 4_002,
  });
  supervisor.acquire({ owner: "dev.thetriangle.client" });
  try {
    const dedicated = createHeadlessClaimerGuard({
      profile,
      allowedRoomId: PINNED_HEADLESS_DRAIN_ROOM_ID,
      pid: 4_002,
      lockPath,
      probeDedicatedDrain: () => false,
      pidAlive: (candidate) => candidate === 4_001 || candidate === 4_002,
    });
    assert.throws(
      () => dedicated.assertDedicatedDrainMayClaim(),
      (error) => error.code === "supervisor_headless_claimer_active",
    );
    const blockedSupervisor = createHeadlessClaimerGuard({
      profile,
      allowedRoomId: PINNED_HEADLESS_DRAIN_ROOM_ID,
      pid: 4_003,
      lockPath,
      probeDedicatedDrain: () => true,
      pidAlive: () => false,
    });
    assert.equal(
      dedicatedHeadlessDrainLaunchAgentLabel(profile),
      "dev.thetriangle.codex-headless-drain.codex-headless",
    );
    assert.throws(
      () => blockedSupervisor.assertSupervisorMayClaim(),
      (error) => error.code === "dedicated_headless_drain_loaded",
    );
  } finally {
    supervisor.release({ owner: "dev.thetriangle.client" });
  }
});

