import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessCodexDrain } from "../../src/codex-runtime/headless-drain.mjs";
import {
  deriveProfileInstanceId,
  loadHeadlessDrainConfig,
} from "../../src/codex-runtime/headless-drain-service.mjs";

const INSTANCE = "a".repeat(64);
const ROOM = `room_${"b".repeat(32)}`;
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

test("installed drain config is exact-profile allowlisted and derives the Swift-compatible instance id", () => {
  const profile = "codex-headless";
  const env = {
    HOME: "/Users/tester",
    CODEX_CLI: "/opt/triangle/bin/codex",
    TRIANGLE_CODEX_HOME: "/Users/tester/Library/Application Support/The Triangle/codex-home",
    TRIANGLE_HEADLESS_WORKING_DIRECTORY: "/srv/triangle-work",
    TRIANGLE_PHASE5_MIGRATION_ENABLE: "1",
    TRIANGLE_HEADLESS_RUNTIME_PROFILES: profile,
    TRIANGLE_HEADLESS_ROOM_ID: ROOM,
  };
  const config = loadHeadlessDrainConfig({ profile, env });
  assert.equal(config.profileInstanceId, deriveProfileInstanceId(profile));
  assert.match(config.profileInstanceId, /^[a-f0-9]{64}$/);
  assert.equal(config.pollIntervalMs, 1_000);
  assert.equal(config.allowedRoomId, ROOM);

  assert.throws(
    () => loadHeadlessDrainConfig({ profile: "codex-bob-test", env }),
    /not explicitly enabled/,
  );
  assert.throws(
    () => loadHeadlessDrainConfig({ profile, env: { ...env, TRIANGLE_INSTANCE_ID: "f".repeat(64) } }),
    /does not match profile/,
  );
  assert.throws(
    () => loadHeadlessDrainConfig({ profile, env: { ...env, TRIANGLE_HEADLESS_ROOM_ID: "room_invalid" } }),
    /TRIANGLE_HEADLESS_ROOM_ID/,
  );
});
