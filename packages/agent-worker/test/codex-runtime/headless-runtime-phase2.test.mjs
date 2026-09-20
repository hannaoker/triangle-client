import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFakeAppServerStdioProgram,
} from "../../src/codex-runtime/app-server-process.mjs";
import { createDurableConversationStore } from "../../src/codex-runtime/durable-conversation-store.mjs";
import { createHeadlessCodexRuntime } from "../../src/codex-runtime/headless-runtime.mjs";
import { loadRuntimeManifest } from "../../src/codex-runtime/runtime-manifest.mjs";

const PROFILE_INSTANCE_ID = "a".repeat(64);
const ROOM_ID = `room_${"b".repeat(32)}`;
const INBOUND_EVENT_ID = `event_${"c".repeat(32)}`;

function tempHome() {
  return mkdtempSync(path.join(tmpdir(), "triangle-phase2-home-"));
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
    async ack(args = {}) {
      calls.push({ op: "ack", ...args });
      return { acknowledged: true };
    },
  };
}

test("Phase 2 receipt-only: no model turn, no MESH reply, ack only", async () => {
  const home = tempHome();
  const storeRoot = path.join(home, "codex-runtime-store");
  const fake = createFakeAppServerStdioProgram({
    serverIdentity: "fake-receipt",
    idPrefix: "receipt",
  });
  const proxy = createProxyRecorder();
  const durableStore = createDurableConversationStore({
    root: storeRoot,
    enabled: true,
  });
  const runtime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    transactionProxy: proxy,
    durableStore,
    ownerInstanceId: "owner-receipt",
    profileInstanceId: PROFILE_INSTANCE_ID,
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
    logger: { info() {}, error() {} },
  });

  try {
    await runtime.start();
    const result = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_20",
      numericDeliveryId: 20,
      text: "must not reach model",
      replyRequired: false,
    });
    assert.equal(result.status, "receipt_only");
    assert.equal(result.modelAdmitted, false);
    assert.equal(result.meshReplyPosted, false);
    assert.equal(result.workerSlotReserved, false);
    assert.deepEqual(
      proxy.calls.map((call) => call.op),
      ["ack"],
    );
    assert.equal(proxy.calls[0].receiptOnly, true);
    // Pool should still be idle (no acquire for receipt-only).
    assert.equal(runtime.pool.status().busy, false);
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 1_000 });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Phase 2 durable path: lease + epoch bump on admit + completion record", async () => {
  const home = tempHome();
  const storeRoot = path.join(home, "codex-runtime-store");
  const storePath = path.join(home, "materialized-threads");
  const fake = createFakeAppServerStdioProgram({
    serverIdentity: "fake-phase2",
    idPrefix: "p2",
    requireMaterializedRollout: true,
    materializedStorePath: storePath,
  });
  const proxy = createProxyRecorder();
  const durableStore = createDurableConversationStore({
    root: storeRoot,
    enabled: true,
  });
  const runtime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    transactionProxy: proxy,
    durableStore,
    ownerInstanceId: "owner-phase2",
    profileInstanceId: PROFILE_INSTANCE_ID,
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
    logger: { info() {}, error() {} },
  });

  try {
    await runtime.start();
    const result = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_21",
      numericDeliveryId: 21,
      text: "phase2 durable hello",
      inboundEventId: INBOUND_EVENT_ID,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.executionEpoch, 1);
    assert.equal(result.ownerGeneration, 1);
    assert.equal(runtime.registry.kind, "durable");

    const lease = durableStore.readProfile(PROFILE_INSTANCE_ID);
    assert.equal(lease.owner_instance_id, "owner-phase2");
    assert.equal(lease.owner_generation, 1);

    const conversation = durableStore.readConversation(PROFILE_INSTANCE_ID, ROOM_ID);
    assert.equal(conversation.execution_state, "idle");
    assert.equal(conversation.execution_epoch, 1);
    assert.equal(conversation.codex_thread_id, result.threadId);

    const second = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_22",
      numericDeliveryId: 22,
      text: "second admit bumps epoch",
      inboundEventId: INBOUND_EVENT_ID,
    });
    assert.equal(second.executionEpoch, 2);
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 1_000 });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Phase 2 restart recovery after reply_persisted: ack only, no duplicate reply", async () => {
  const home = tempHome();
  const storeRoot = path.join(home, "codex-runtime-store");
  const durableStore = createDurableConversationStore({
    root: storeRoot,
    enabled: true,
  });
  // Simulate a crashed supervisor that left reply_persisted on disk.
  const seedRuntime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    durableStore,
    ownerInstanceId: "owner-crash",
    profileInstanceId: PROFILE_INSTANCE_ID,
    command: "false",
    args: [],
    codexHome: home,
    logger: { info() {}, error() {} },
  });
  seedRuntime.registry.setThread(PROFILE_INSTANCE_ID, ROOM_ID, "thread-crashed", {
    workerSlotId: "slot-1",
  });
  seedRuntime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, {
    executionState: "admitted",
    activeDeliveryId: "delivery_30",
    executionEpoch: 3,
  });
  seedRuntime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, { executionState: "running" });
  seedRuntime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, { executionState: "result_ready" });
  seedRuntime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, {
    executionState: "reply_persisted",
    lastReplyEventId: INBOUND_EVENT_ID,
  });

  const proxy = createProxyRecorder();
  const recovered = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    transactionProxy: proxy,
    durableStore: createDurableConversationStore({ root: storeRoot, enabled: true }),
    ownerInstanceId: "owner-recovered",
    profileInstanceId: PROFILE_INSTANCE_ID,
    command: "false",
    args: [],
    codexHome: home,
    logger: { info() {}, error() {} },
  });

  const report = await recovered.recoverAfterRestart({
    profileInstanceId: PROFILE_INSTANCE_ID,
  });
  assert.equal(report.reconciledAck, 1);
  assert.equal(report.quarantined, 0);
  assert.deepEqual(
    proxy.calls.map((call) => call.op),
    ["ack"],
  );
  assert.ok(!proxy.calls.some((call) => call.op === "reply"));
  assert.equal(recovered.registry.get(PROFILE_INSTANCE_ID, ROOM_ID).executionState, "idle");
  rmSync(home, { recursive: true, force: true });
});

test("Phase 2 stale-epoch events are ignored (metadata only)", () => {
  const home = tempHome();
  const runtime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    command: "false",
    args: [],
    codexHome: home,
    logger: { info() {}, error() {} },
  });
  assert.equal(
    runtime.acceptEpochEvent({ conversationEpoch: 4, eventEpoch: 4, meta: { turnId: "t1" } }),
    true,
  );
  assert.equal(
    runtime.acceptEpochEvent({ conversationEpoch: 4, eventEpoch: 2, meta: { turnId: "t0" } }),
    false,
  );
  assert.equal(runtime.status().ignoredStaleEpochEvents, 1);
  rmSync(home, { recursive: true, force: true });
});

test("Phase 2 crash-boundary: App Server exit before turn leaves claim/lease reconciliable", async () => {
  const home = tempHome();
  const storeRoot = path.join(home, "codex-runtime-store");
  // Fake that dies on turn/start.
  const source = `
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
function write(m) { process.stdout.write(JSON.stringify(m) + "\\n"); }
async function handle(message) {
  if (!message?.method || message.id === undefined) return;
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    write({ jsonrpc: "2.0", id, result: { serverInfo: { name: "fake-crash", version: "0" } } });
    return;
  }
  if (method === "thread/start") {
    const threadId = "thread-crash-" + randomUUID();
    write({ jsonrpc: "2.0", id, result: { thread: { id: threadId, status: { type: "idle" } } } });
    return;
  }
  if (method === "turn/start") {
    process.exit(2);
  }
  write({ jsonrpc: "2.0", id, result: {} });
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  try { await handle(JSON.parse(line)); } catch {}
}
`;
  const proxy = createProxyRecorder();
  const durableStore = createDurableConversationStore({
    root: storeRoot,
    enabled: true,
  });
  const runtime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    transactionProxy: proxy,
    durableStore,
    ownerInstanceId: "owner-crash-boundary",
    profileInstanceId: PROFILE_INSTANCE_ID,
    command: process.execPath,
    args: ["--input-type=module", "-e", source],
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
    turnTimeoutMs: 2_000,
    logger: { info() {}, error() {} },
  });

  try {
    await runtime.start();
    await assert.rejects(
      () =>
        runtime.runDelivery({
          profileInstanceId: PROFILE_INSTANCE_ID,
          roomId: ROOM_ID,
          deliveryId: "delivery_40",
          numericDeliveryId: 40,
          text: "will crash child",
          inboundEventId: INBOUND_EVENT_ID,
        }),
      (error) =>
        error.code === "child_exited" ||
        error.code === "turn_start_failed" ||
        error.code === "not_connected" ||
        error.code === "closing" ||
        error.message?.includes("exited"),
    );
    // No MESH reply or ack on crash before completion.
    assert.equal(proxy.calls.length, 0);
    const row = runtime.registry.get(PROFILE_INSTANCE_ID, ROOM_ID);
    assert.ok(row?.codexThreadId);
    // Lease still held / durable profile present for reconciliation.
    const lease = durableStore.readProfile(PROFILE_INSTANCE_ID);
    assert.equal(lease.owner_instance_id, "owner-crash-boundary");
    assert.ok(["admitted", "running"].includes(row.executionState));
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 1_000 }).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test("Phase 2 reconnect-oriented: slot restart then recover idle lease owner", async () => {
  const home = tempHome();
  const storeRoot = path.join(home, "codex-runtime-store");
  const material = path.join(home, "materialized-threads");
  const fake = createFakeAppServerStdioProgram({
    serverIdentity: "fake-reconnect",
    idPrefix: "rc",
    requireMaterializedRollout: true,
    materializedStorePath: material,
  });
  const proxy = createProxyRecorder();
  const durableStore = createDurableConversationStore({
    root: storeRoot,
    enabled: true,
  });
  const runtime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    transactionProxy: proxy,
    durableStore,
    ownerInstanceId: "owner-reconnect",
    profileInstanceId: PROFILE_INSTANCE_ID,
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
      deliveryId: "delivery_50",
      numericDeliveryId: 50,
      text: "before reconnect",
      inboundEventId: INBOUND_EVENT_ID,
    });
    assert.equal(first.status, "completed");

    await runtime.restartSlot({ signal: "SIGKILL", timeoutMs: 1_000 });
    const report = await runtime.recoverAfterRestart({
      profileInstanceId: PROFILE_INSTANCE_ID,
    });
    assert.equal(report.quarantined, 0);

    const second = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_51",
      numericDeliveryId: 51,
      text: "after reconnect resume",
      inboundEventId: INBOUND_EVENT_ID,
    });
    assert.equal(second.startedNewThread, false);
    assert.equal(second.threadId, first.threadId);
    assert.equal(second.executionEpoch, 2);
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 1_000 });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Phase 2 keeps global production flags off", () => {
  const manifest = loadRuntimeManifest({ forceReload: true });
  assert.equal(manifest.featureFlags.headlessRuntime, false);
  assert.equal(manifest.featureFlags.helperConversationStore, false);
  assert.equal(manifest.sharedHomeConcurrency.forcedPoolSize, 1);
});
