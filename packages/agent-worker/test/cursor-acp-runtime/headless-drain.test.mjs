import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClientSupervisor } from "../../src/client-supervisor.mjs";
import { parseClientSupervisorBootstrap } from "../../src/client-supervisor-cli.mjs";
import {
  assertCursorAcpDrainIdentity,
  createCursorAcpClaimerGuard,
  createHeadlessCursorAcpDrain,
  deriveProfileInstanceId,
  normalizeCursorAcpWakeConfig,
} from "../../src/cursor-acp-runtime/index.mjs";
import { createFakeAcpStdioProgram } from "../../src/cursor-acp-runtime/acp-process.mjs";
import { createHeadlessCursorAcpRuntime } from "../../src/cursor-acp-runtime/headless-runtime.mjs";
import { createDefaultCursorAcpShadowProfile } from "../../src/cursor-acp-runtime/config-guards.mjs";

const darwinAdvisoryLocks = process.platform !== "darwin"
  ? "advisory claimer locks require macOS (Darwin O_EXLOCK); covered on macOS hosts"
  : false;

const PROFILE = "cursor-acp-shadow-test";
const PROFILE_INSTANCE_ID = deriveProfileInstanceId(PROFILE);

function cursorAcpWake(overrides = {}) {
  return {
    profile: PROFILE,
    profileInstanceId: PROFILE_INSTANCE_ID,
    helperPath: "/trusted/bin/triangle-mailbox",
    workingDirectory: "/srv/triangle-cursor-work",
    cursorHome: "/private/cursor-acp-home",
    stateRoot: "/private/cursor-acp-state/cursor-acp-shadow-test",
    command: "/trusted/bin/agent",
    pollIntervalMs: 1_000,
    shadowTestProfile: true,
    ...overrides,
  };
}

test("normalizeCursorAcpWakeConfig accepts closed shadow wake shape", () => {
  const normalized = normalizeCursorAcpWakeConfig(cursorAcpWake());
  assert.equal(normalized.profile, PROFILE);
  assert.equal(normalized.shadowTestProfile, true);
  assert.equal(normalized.pollIntervalMs, 1_000);
  assert.equal(Object.hasOwn(normalized, "agentId"), false);
  const enrolled = normalizeCursorAcpWakeConfig(cursorAcpWake({
    agentId: "agent_cursor_acp_001",
    installationId: "inst_N7VhDq3mQ2",
  }));
  assert.equal(enrolled.agentId, "agent_cursor_acp_001");
  assert.equal(enrolled.installationId, "inst_N7VhDq3mQ2");
  assert.equal(enrolled.pollIntervalMs, 1_000);
  assert.equal(normalizeCursorAcpWakeConfig(cursorAcpWake({ shadowTestProfile: false })).shadowTestProfile, false);
  const omitted = cursorAcpWake();
  delete omitted.shadowTestProfile;
  assert.equal(normalizeCursorAcpWakeConfig(omitted).shadowTestProfile, false);
  assert.doesNotThrow(() => assertCursorAcpDrainIdentity({
    profile: PROFILE,
    shadowTestProfile: false,
  }));
  assert.throws(() => normalizeCursorAcpWakeConfig(cursorAcpWake({ shadowTestProfile: "yes" })), /shadowTestProfile/);
  assert.throws(() => normalizeCursorAcpWakeConfig(cursorAcpWake({ note: "extra" })), /schema/);
  assert.throws(() => normalizeCursorAcpWakeConfig(cursorAcpWake({ codexHome: "/x", cursorHome: undefined })), /schema|cursorHome/i);
  assert.throws(() => normalizeCursorAcpWakeConfig(cursorAcpWake({ agentId: "bad id" })), /agentId/);
});

test("watch kick while draining arms one trailing drain and keeps the poll timer", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let resolves = 0;
  const delays = [];
  const runtime = {
    async start() {},
    async recoverAfterRestart() { return { quarantined: 0 }; },
    async runDelivery() {
      await blocked;
      return { status: "completed", settlementTrace: ["reply_persisted", "acked"] };
    },
    async stop() {},
  };
  const drain = createHeadlessCursorAcpDrain({
    runtime,
    resolveDelivery: async () => {
      resolves += 1;
      return {
        roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        deliveryId: `delivery_${resolves}`,
        numericDeliveryId: resolves,
        text: "hint",
        inboundEventId: "event_inbound_test",
      };
    },
    profileInstanceId: PROFILE_INSTANCE_ID,
    pollIntervalMs: 1_000,
    setTimer(fn, delay) {
      delays.push(delay);
      return { fn, delay };
    },
    clearTimer() {},
  });

  await drain.start({ runLoop: true });
  assert.deepEqual(delays, [1_000]);
  const first = drain.drainOnce("timer");
  const kicked = drain.kick({ reason: "watch_hint" });
  assert.equal(kicked.status, "pending");
  assert.equal(drain.status().pendingKick, true);
  assert.equal(drain.status().pollIntervalMs, 1_000);
  const again = drain.kick({ reason: "watch_hint" });
  assert.equal(again.status, "pending");
  assert.deepEqual(delays, [1_000]);
  release();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resolves, 2);
  assert.equal(drain.status().pendingKick, false);
  assert.deepEqual(delays, [1_000]);
  await drain.stop();
});

test("stop while a trailing kick is pending does not run that drain", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let resolves = 0;
  const drain = createHeadlessCursorAcpDrain({
    runtime: {
      async start() {},
      async runDelivery() {
        await blocked;
        return { status: "completed", settlementTrace: ["reply_persisted", "acked"] };
      },
      async stop() {},
    },
    resolveDelivery: async () => {
      resolves += 1;
      return {
        roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        deliveryId: `delivery_${resolves}`,
        numericDeliveryId: resolves,
        text: "hint",
        inboundEventId: "event_inbound_test",
      };
    },
    profileInstanceId: PROFILE_INSTANCE_ID,
    pollIntervalMs: 1_000,
    setTimer() { return {}; },
    clearTimer() {},
  });
  await drain.start({ runLoop: false });
  const first = drain.drainOnce("timer");
  const kicked = drain.kick({ reason: "watch_hint" });
  assert.equal(kicked.status, "pending");
  assert.equal(drain.status().pendingKick, true);
  const stopped = drain.stop();
  release();
  await stopped;
  await first;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolves, 1);
  assert.equal(drain.status().pendingKick, false);
  assert.equal(drain.status().draining, false);
});

test("a trailing drain whose runDelivery throws is logged and does not escape kick", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let deliveries = 0;
  const logged = [];
  const drain = createHeadlessCursorAcpDrain({
    runtime: {
      async start() {},
      async runDelivery() {
        deliveries += 1;
        if (deliveries === 1) {
          await blocked;
          return { status: "completed", settlementTrace: ["reply_persisted", "acked"] };
        }
        throw Object.assign(new Error("delivery failed"), { code: "cursor_acp_delivery_failed" });
      },
      async stop() {},
    },
    resolveDelivery: async () => ({
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deliveryId: `delivery_${deliveries + 1}`,
      numericDeliveryId: deliveries + 1,
      text: "hint",
      inboundEventId: "event_inbound_test",
    }),
    profileInstanceId: PROFILE_INSTANCE_ID,
    pollIntervalMs: 1_000,
    logger: {
      error(event, fields) {
        logged.push({ event, code: fields?.code ?? null });
      },
    },
    setTimer() { return {}; },
    clearTimer() {},
  });
  await drain.start({ runLoop: false });
  const first = drain.drainOnce("timer");
  const kicked = drain.kick({ reason: "watch_hint" });
  assert.equal(kicked.status, "pending");
  release();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(deliveries, 2);
  assert.deepEqual(logged, [{
    event: "triangle_cursor_acp_drain_trailing_failed",
    code: "cursor_acp_delivery_failed",
  }]);
  await drain.stop();
});

test("restart recovery still blocks new Cursor ACP claims", async () => {
  let resolved = false;
  const drain = createHeadlessCursorAcpDrain({
    runtime: {
      async start() {},
      async recoverAfterRestart() { return { quarantined: 1 }; },
      async runDelivery() { throw new Error("must not run"); },
      async stop() {},
    },
    resolveDelivery: async () => { resolved = true; return { deliveryId: "delivery_1" }; },
    profileInstanceId: PROFILE_INSTANCE_ID,
  });
  await assert.rejects(
    () => drain.start({ runLoop: false }),
    (error) => error.code === "cursor_acp_drain_recovery_blocked",
  );
  assert.equal(resolved, false);
  assert.equal(drain.kick({ reason: "watch_hint" }).status, "stopped");
});

test("cursor ACP claimer fail-closed on dual claim", { skip: darwinAdvisoryLocks }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-claimer-"));
  const lockPath = path.join(root, `cursor-acp-claimer.${PROFILE}.json`);
  const first = createCursorAcpClaimerGuard({
    profile: PROFILE,
    lockPath,
    probeDedicatedDrain: () => false,
    probeCodexDrain: () => false,
  });
  first.acquire({ owner: "dev.thetriangle.client" });
  const second = createCursorAcpClaimerGuard({
    profile: PROFILE,
    lockPath,
    pid: process.pid + 1,
    probeDedicatedDrain: () => false,
    probeCodexDrain: () => false,
  });
  assert.throws(
    () => second.assertSupervisorMayClaim(),
    (error) =>
      error.code === "supervisor_cursor_acp_claimer_active"
      || error.code === "codex_claimer_blocks_cursor_acp",
  );
  first.release({ owner: "dev.thetriangle.client" });
  fs.rmSync(root, { recursive: true, force: true });
});

test("cursor ACP claimer fails closed when Codex drain is loaded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-claimer-codex-"));
  const lockPath = path.join(root, `cursor-acp-claimer.${PROFILE}.json`);
  const guard = createCursorAcpClaimerGuard({
    profile: PROFILE,
    lockPath,
    probeDedicatedDrain: () => false,
    probeCodexDrain: () => true,
  });
  assert.throws(
    () => guard.assertSupervisorMayClaim(),
    (error) => error.code === "codex_drain_blocks_cursor_acp",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("cursor ACP claimer acquires Codex lock family and blocks Codex claimer", { skip: darwinAdvisoryLocks }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-cross-runtime-"));
  const cursorLock = path.join(root, `cursor-acp-claimer.${PROFILE}.json`);
  const codexLock = path.join(root, `headless-claimer.${PROFILE}.json`);
  const cursor = createCursorAcpClaimerGuard({
    profile: PROFILE,
    lockPath: cursorLock,
    probeDedicatedDrain: () => false,
    probeCodexDrain: () => false,
  });
  cursor.acquire({ owner: "dev.thetriangle.client" });
  assert.equal(fs.existsSync(cursorLock), true);
  assert.equal(fs.existsSync(codexLock), true);

  const { createHeadlessClaimerGuard } = await import("../../src/codex-runtime/headless-drain-service.mjs");
  const codex = createHeadlessClaimerGuard({
    profile: PROFILE,
    lockPath: codexLock,
    probeDedicatedDrain: () => false,
    probeCursorAcpDrain: () => false,
    pid: process.pid + 7,
  });
  assert.throws(
    () => codex.assertSupervisorMayClaim(),
    (error) =>
      error.code === "cursor_acp_claimer_blocks_codex"
      || error.code === "supervisor_headless_claimer_active",
  );
  cursor.release({ owner: "dev.thetriangle.client" });
  // Diagnostic JSON may remain; ownership is the released advisory lock.
  const codexAfter = createHeadlessClaimerGuard({
    profile: PROFILE,
    lockPath: codexLock,
    probeDedicatedDrain: () => false,
    probeCursorAcpDrain: () => false,
    pid: process.pid + 8,
  });
  codexAfter.acquire({ owner: "dev.thetriangle.client" });
  codexAfter.release({ owner: "dev.thetriangle.client" });
  fs.rmSync(root, { recursive: true, force: true });
});

test("cursor ACP claimer fails closed when live Codex claimer lock exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-codex-lock-"));
  const cursorLock = path.join(root, `cursor-acp-claimer.${PROFILE}.json`);
  const codexLock = path.join(root, `headless-claimer.${PROFILE}.json`);
  fs.writeFileSync(
    codexLock,
    `${JSON.stringify({
      version: 1,
      profile: PROFILE,
      owner: "dev.thetriangle.client",
      pid: process.pid + 11,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const guard = createCursorAcpClaimerGuard({
    profile: PROFILE,
    lockPath: cursorLock,
    probeDedicatedDrain: () => false,
    probeCodexDrain: () => false,
    advisoryHeld: (target) => target === codexLock,
  });
  assert.throws(
    () => guard.assertSupervisorMayClaim(),
    (error) => error.code === "codex_claimer_blocks_cursor_acp",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI accepts cursorAcpWakes bootstrap", () => {
  const wake = cursorAcpWake();
  const parsed = parseClientSupervisorBootstrap(JSON.stringify({
    version: 1,
    maxConcurrentReasoners: 2,
    instances: [],
    cursorAcpWakes: [wake],
  }));
  assert.deepEqual(parsed.cursorAcpWakes.map(({ profile }) => profile), [PROFILE]);
});

test("supervisor starts Cursor ACP drain from cursorAcpWakes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-home-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-state-"));
  const wake = cursorAcpWake({
    cursorHome: home,
    stateRoot,
    command: process.execPath,
  });
  let started = false;
  let stopped = false;
  const deliveries = [];
  const supervisor = createClientSupervisor({
    instances: [],
    cursorAcpWakes: [wake],
    createCursorAcpDrain: () => ({
      async start() {
        started = true;
        return { started: true };
      },
      async stop() {
        stopped = true;
        return { started: false };
      },
    }),
    createCursorAcpClaimer: () => ({
      assertSupervisorMayClaim() {},
      acquire() {},
      release() { return true; },
    }),
  });
  assert.deepEqual(supervisor.cursorAcpInstanceIds, [PROFILE_INSTANCE_ID]);
  const controller = new AbortController();
  const watch = supervisor.watch({ signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await watch;
  assert.equal(started, true);
  assert.equal(stopped, true);
  void deliveries;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("headless Cursor ACP drain runs fake ACP claim→prompt→reply settlement", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-runtime-home-"));
  const replies = [];
  const acks = [];
  const fake = createFakeAcpStdioProgram({ idPrefix: "drain" });
  const runtime = createHeadlessCursorAcpRuntime({
    profileConfig: createDefaultCursorAcpShadowProfile({
      profileId: PROFILE,
      workingDirectory: home,
    }),
    cursorHome: path.join(home, "cursor-home"),
    enableShadow: true,
    command: fake.command,
    args: fake.args,
    env: { HOME: home, PATH: process.env.PATH, TRIANGLE_CURSOR_ACP_SHADOW_ENABLE: "1" },
    logger: { info() {}, error() {} },
    transactionProxy: {
      async reply(request) {
        replies.push(request);
        return { replyEventId: "event_reply_test" };
      },
      async ack() {
        acks.push(true);
        return { ok: true };
      },
    },
  });
  assert.equal(runtime.active, true);
  const drain = createHeadlessCursorAcpDrain({
    runtime,
    profileInstanceId: PROFILE_INSTANCE_ID,
    pollIntervalMs: 100,
    resolveDelivery: async () => ({
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deliveryId: "delivery_1",
      numericDeliveryId: 1,
      text: "Say hello once.",
      inboundEventId: "event_inbound_test",
      workingDirectory: home,
    }),
  });
  await drain.start({ runLoop: false });
  const result = await drain.drainOnce();
  assert.equal(result.status, "completed");
  assert.equal(replies.length, 1);
  assert.equal(acks.length, 1);
  assert.equal(result.settlementTrace.includes("reply_persisted"), true);
  assert.equal(result.settlementTrace.includes("acked"), true);
  await drain.stop();
  fs.rmSync(home, { recursive: true, force: true });
});
