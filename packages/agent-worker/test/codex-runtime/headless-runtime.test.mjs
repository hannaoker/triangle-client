import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFakeAppServerStdioProgram,
} from "../../src/codex-runtime/app-server-process.mjs";
import {
  isShadowHeadlessTestProfile,
  resolvePhase1ShadowRuntimeConfig,
} from "../../src/codex-runtime/config-guards.mjs";
import { replyBeforeAckStages } from "../../src/codex-runtime/execution-state.mjs";
import { createHeadlessCodexRuntime } from "../../src/codex-runtime/headless-runtime.mjs";
import { loadRuntimeManifest } from "../../src/codex-runtime/runtime-manifest.mjs";

const PROFILE_INSTANCE_ID = "a".repeat(64);
const ROOM_ID = `room_${"b".repeat(32)}`;
const INBOUND_EVENT_ID = `event_${"c".repeat(32)}`;

function tempHome() {
  return mkdtempSync(path.join(tmpdir(), "triangle-shadow-home-"));
}

function shadowProfile(overrides = {}) {
  return {
    profileId: "codex-shadow-test",
    runtimeAdapter: "codex-app-server",
    runtimeMode: "headless",
    shadowTestProfile: true,
    approvalPolicy: "never",
    sandboxClass: "read-only",
    workingDirectory: null,
    ...overrides,
  };
}

function createProxyRecorder() {
  const calls = [];
  return {
    calls,
    async reply(args) {
      calls.push({ op: "reply", ...args });
      return { replyEventId: INBOUND_EVENT_ID, state: "replied" };
    },
    async ack() {
      calls.push({ op: "ack" });
      return { acknowledged: true };
    },
  };
}

test("shadow gating: production desktop shape stays inactive", () => {
  assert.equal(
    isShadowHeadlessTestProfile({
      runtimeAdapter: "codex-app-server",
      runtimeMode: "desktop",
      shadowTestProfile: false,
    }),
    false,
  );
  const inactive = resolvePhase1ShadowRuntimeConfig(
    {
      profileId: "bob-desktop",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "desktop",
    },
    { enableShadow: true },
  );
  assert.equal(inactive.active, false);
  assert.equal(inactive.inactiveReason, "not_shadow_test_profile");
});

test("shadow gating: test profile requires operator enablement", () => {
  const profile = shadowProfile();
  const blocked = resolvePhase1ShadowRuntimeConfig(profile, {
    env: {},
    enableShadow: false,
  });
  assert.equal(blocked.active, false);
  assert.equal(blocked.inactiveReason, "shadow_not_operator_enabled");

  const viaEnv = resolvePhase1ShadowRuntimeConfig(profile, {
    env: { TRIANGLE_HEADLESS_SHADOW_ENABLE: "1" },
  });
  assert.equal(viaEnv.active, true);

  const viaAllowlist = resolvePhase1ShadowRuntimeConfig(profile, {
    env: { TRIANGLE_HEADLESS_SHADOW_PROFILES: "other,codex-shadow-test" },
  });
  assert.equal(viaAllowlist.active, true);

  const manifest = loadRuntimeManifest({ forceReload: true });
  assert.equal(manifest.featureFlags.headlessRuntime, false);
  assert.equal(manifest.sharedHomeConcurrency.forcedPoolSize, 1);
});

test("Phase 1 single-slot: start, turn, reply-before-ack ordering", async () => {
  const home = tempHome();
  const store = path.join(home, "materialized-threads");
  const fake = createFakeAppServerStdioProgram({
    serverIdentity: "fake-shadow",
    idPrefix: "shadow",
    requireMaterializedRollout: true,
    materializedStorePath: store,
  });
  const proxy = createProxyRecorder();
  const runtime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    transactionProxy: proxy,
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
    logger: { info() {}, error() {} },
  });

  try {
    assert.equal(runtime.active, true);
    const started = await runtime.start();
    assert.equal(started.pool.size, 1);
    assert.equal(started.pool.forcedPoolSize, 1);
    assert.equal(started.pool.slot.slotId, "slot-1");

    const result = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_1",
      numericDeliveryId: 1,
      text: "phase1 shadow hello",
      inboundEventId: INBOUND_EVENT_ID,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.startedNewThread, true);
    assert.match(result.threadId, /^thread-/);
    assert.match(result.turnId, /^turn-/);
    assert.deepEqual(result.settlementTrace, ["result_ready", "reply_persisted", "acked"]);
    assert.deepEqual(result.expectedSettlementOrder, replyBeforeAckStages());
    assert.deepEqual(
      proxy.calls.map((call) => call.op),
      ["reply", "ack"],
    );
    assert.equal(proxy.calls[0].roomId, ROOM_ID);
    assert.equal(proxy.calls[0].text, "fake-assistant-ok");
    assert.ok(!JSON.stringify(proxy.calls).includes("mesh_"));

    const mapped = runtime.registry.get(PROFILE_INSTANCE_ID, ROOM_ID);
    assert.equal(mapped.codexThreadId, result.threadId);
    assert.equal(mapped.executionState, "idle");
    assert.equal(mapped.lastCompletedDeliveryId, "delivery_1");
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 1_000 });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Phase 1 thread resume continuity after forced slot restart", async () => {
  const home = tempHome();
  const store = path.join(home, "materialized-threads");
  const fake = createFakeAppServerStdioProgram({
    serverIdentity: "fake-shadow-resume",
    idPrefix: "resume",
    requireMaterializedRollout: true,
    materializedStorePath: store,
  });
  const proxy = createProxyRecorder();
  const runtime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    transactionProxy: proxy,
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
    logger: { info() {}, error() {} },
  });

  try {
    await runtime.start();
    const first = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_10",
      numericDeliveryId: 10,
      text: "first turn materializes rollout",
      inboundEventId: INBOUND_EVENT_ID,
    });
    assert.equal(first.startedNewThread, true);
    const threadId = first.threadId;
    const generationBefore = first.generation;

    const restarted = await runtime.restartSlot({ signal: "SIGKILL", timeoutMs: 1_000 });
    assert.equal(restarted.slotId, "slot-1");
    assert.ok(restarted.generation > generationBefore);

    // Registry kept the thread id across slot restart (parent process).
    assert.equal(runtime.registry.get(PROFILE_INSTANCE_ID, ROOM_ID).codexThreadId, threadId);

    const second = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_11",
      numericDeliveryId: 11,
      text: "resume same thread after restart",
      inboundEventId: INBOUND_EVENT_ID,
    });
    assert.equal(second.startedNewThread, false);
    assert.equal(second.threadId, threadId);
    assert.ok(second.generation > generationBefore);
    assert.deepEqual(second.settlementTrace, ["result_ready", "reply_persisted", "acked"]);
    assert.deepEqual(
      proxy.calls.map((call) => call.op),
      ["reply", "ack", "reply", "ack"],
    );
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 1_000 });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Phase 1 refuses empty / [NO_REPLY] before ack", async () => {
  const home = tempHome();
  // Custom fake that returns [NO_REPLY]
  const source = `
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
function write(m) { process.stdout.write(JSON.stringify(m) + "\\n"); }
function emit(method, params) { write({ jsonrpc: "2.0", method, params }); }
const threads = new Map();
let n = 0;
async function handle(message) {
  if (!message?.method || message.id === undefined) return;
  const { id, method, params = {} } = message;
  let result;
  switch (method) {
    case "initialize":
      result = { serverInfo: { name: "fake-noreply", version: "0" } };
      break;
    case "thread/start": {
      const threadId = "thread-nr-" + randomUUID();
      threads.set(threadId, { id: threadId, turns: [] });
      result = { thread: { id: threadId, status: { type: "idle" } } };
      break;
    }
    case "turn/start": {
      const turnId = "turn-nr-" + (++n) + "-" + randomUUID();
      const turn = {
        id: turnId,
        status: "completed",
        items: [{ type: "agentMessage", id: "a1", text: "[NO_REPLY]" }],
      };
      const thread = threads.get(params.threadId) ?? { id: params.threadId, turns: [] };
      thread.turns.push(turn);
      threads.set(params.threadId, thread);
      emit("turn/started", { threadId: params.threadId, turn: { id: turnId, status: "in_progress" } });
      result = { turn: { id: turnId, status: "in_progress" } };
      queueMicrotask(() => emit("turn/completed", { threadId: params.threadId, turn }));
      break;
    }
    default:
      result = {};
  }
  write({ jsonrpc: "2.0", id, result });
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  try { await handle(JSON.parse(line)); } catch {}
}
`;
  const proxy = createProxyRecorder();
  const runtime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    transactionProxy: proxy,
    command: process.execPath,
    args: ["--input-type=module", "-e", source],
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
    logger: { info() {}, error() {} },
  });

  try {
    await runtime.start();
    await assert.rejects(
      () =>
        runtime.runDelivery({
          profileInstanceId: PROFILE_INSTANCE_ID,
          roomId: ROOM_ID,
          deliveryId: "delivery_99",
          numericDeliveryId: 99,
          text: "should fail settlement",
        }),
      (error) => error.code === "assistant_text_missing",
    );
    assert.equal(proxy.calls.length, 0);
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 1_000 });
    rmSync(home, { recursive: true, force: true });
  }
});

test("inactive runtime does not start a slot for non-shadow profiles", async () => {
  const home = tempHome();
  const fake = createFakeAppServerStdioProgram();
  const runtime = createHeadlessCodexRuntime({
    profileConfig: {
      profileId: "mcp-interactive-bob",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "desktop",
    },
    enableShadow: true,
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
  });
  assert.equal(runtime.active, false);
  await assert.rejects(() => runtime.start(), (error) => error.code === "shadow_runtime_inactive");
  rmSync(home, { recursive: true, force: true });
});

// Silence unused import warning in some tooling; realpath used for parity with Phase 0.
void realpathSync;
