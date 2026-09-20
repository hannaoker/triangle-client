import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDurableConversationStore } from "../../src/codex-runtime/durable-conversation-store.mjs";
import { createHeadlessCodexRuntime } from "../../src/codex-runtime/headless-runtime.mjs";
import { createFakeAppServerStdioProgram } from "../../src/codex-runtime/app-server-process.mjs";

const PROFILE_INSTANCE_ID = "a".repeat(64);
const ROOM_ID = `room_${"b".repeat(32)}`;
const INBOUND_EVENT_ID = `event_${"c".repeat(32)}`;

function tempHome() {
  return mkdtempSync(path.join(tmpdir(), "triangle-p1-fixers-"));
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

function createProxyRecorder({ replyEventId = INBOUND_EVENT_ID } = {}) {
  const calls = [];
  return {
    calls,
    async reply(args) {
      calls.push({ op: "reply", ...args });
      if (replyEventId === undefined) {
        return { state: "replied" };
      }
      return { replyEventId, state: "replied" };
    },
    async ack(args = {}) {
      calls.push({ op: "ack", ...args });
      return { acknowledged: true };
    },
  };
}

test("P1 cancel: interrupt uses owning handle without a second pool acquire", async () => {
  const home = tempHome();
  const acquires = [];
  const interrupts = [];
  const processHandle = {
    async turnInterrupt(params) {
      interrupts.push(params);
      return {};
    },
    status() {
      return { codexHome: home, connected: true };
    },
  };
  const pool = {
    async start() {
      return this.status();
    },
    async stop() {
      return this.status();
    },
    async restartSlot() {
      return { slotId: "slot-1", generation: 2, processHandle };
    },
    async acquire() {
      acquires.push(Date.now());
      return Object.freeze({
        slotId: "slot-1",
        generation: 1,
        processHandle,
        release() {},
      });
    },
    getActiveHandle() {
      return Object.freeze({
        slotId: "slot-1",
        generation: 1,
        processHandle,
      });
    },
    status() {
      return Object.freeze({
        started: true,
        busy: true,
        size: 1,
        forcedPoolSize: 1,
        slot: { slotId: "slot-1", generation: 1 },
      });
    },
  };

  const runtime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    pool,
    command: "false",
    args: [],
    codexHome: home,
    logger: { info() {}, error() {} },
  });

  try {
    await runtime.start();
    runtime.registry.setThread(PROFILE_INSTANCE_ID, ROOM_ID, "thread-cancel", {
      workerSlotId: "slot-1",
    });
    runtime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, {
      executionState: "admitted",
      activeDeliveryId: "delivery_60",
      executionEpoch: 4,
    });
    runtime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, { executionState: "running" });

    const beforeAcquires = acquires.length;
    const result = await runtime.cancelDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_60",
      executionEpoch: 4,
    });

    assert.equal(result.cancelled, true);
    assert.equal(result.interrupted, true);
    assert.equal(acquires.length, beforeAcquires, "cancel must not acquire a second pool slot");
    assert.equal(interrupts.length, 1);
    assert.equal(interrupts[0].threadId, "thread-cancel");
    assert.equal(runtime.registry.get(PROFILE_INSTANCE_ID, ROOM_ID).executionState, "idle");
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 500 }).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test("P1 timeout: unknown turn outcome restarts slot and leaves delivery quarantined", async () => {
  const home = tempHome();
  const storeRoot = path.join(home, "codex-runtime-store");
  // Fake that acknowledges turn/start but never emits turn/completed.
  const source = `
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
function write(m) { process.stdout.write(JSON.stringify(m) + "\\n"); }
async function handle(message) {
  if (!message?.method || message.id === undefined) return;
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    write({ jsonrpc: "2.0", id, result: { serverInfo: { name: "fake-hang", version: "0" } } });
    return;
  }
  if (method === "thread/start") {
    const threadId = "thread-hang-" + randomUUID();
    write({ jsonrpc: "2.0", id, result: { thread: { id: threadId, status: { type: "idle" } } } });
    return;
  }
  if (method === "turn/start") {
    const turnId = "turn-hang-" + randomUUID();
    write({ jsonrpc: "2.0", id, result: { turn: { id: turnId, status: "in_progress" } } });
    // Intentionally never emit turn/completed.
    return;
  }
  if (method === "turn/interrupt") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
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
    ownerInstanceId: "owner-timeout",
    profileInstanceId: PROFILE_INSTANCE_ID,
    command: process.execPath,
    args: ["--input-type=module", "-e", source],
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
    turnTimeoutMs: 200,
    logger: { info() {}, error() {} },
  });

  try {
    await runtime.start();
    const generationBefore = Math.max(
      0,
      ...(runtime.pool.status().slots ?? []).map((slot) => slot.generation),
      runtime.pool.status().slot?.generation ?? 0,
    );
    await assert.rejects(
      () =>
        runtime.runDelivery({
          profileInstanceId: PROFILE_INSTANCE_ID,
          roomId: ROOM_ID,
          deliveryId: "delivery_61",
          numericDeliveryId: 61,
          text: "will time out",
          inboundEventId: INBOUND_EVENT_ID,
        }),
      (error) => error.code === "seed_turn_timeout" && error.outcome === "unknown",
    );
    assert.equal(proxy.calls.length, 0);
    const row = runtime.registry.get(PROFILE_INSTANCE_ID, ROOM_ID);
    assert.ok(["admitted", "running"].includes(row.executionState));
    assert.equal(row.activeDeliveryId, "delivery_61");
    // Slot process replaced so the next delivery cannot reuse a still-running child.
    const statusAfter = runtime.pool.status();
    const generations = (statusAfter.slots ?? []).map((slot) => slot.generation);
    assert.ok(
      generations.some((generation) => generation > generationBefore) ||
        (statusAfter.slot?.generation ?? 0) > generationBefore,
    );
    assert.equal(statusAfter.busy, false);
    assert.equal(statusAfter.busyCount, 0);

    const report = await runtime.recoverAfterRestart({
      profileInstanceId: PROFILE_INSTANCE_ID,
    });
    assert.equal(report.quarantined, 1);
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 1_000 }).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test("P1 durable reply proof: missing replyEventId fails closed before reply_persisted/ack", async () => {
  const home = tempHome();
  const storeRoot = path.join(home, "codex-runtime-store");
  const material = path.join(home, "materialized-threads");
  const fake = createFakeAppServerStdioProgram({
    serverIdentity: "fake-missing-reply",
    idPrefix: "mr",
    requireMaterializedRollout: true,
    materializedStorePath: material,
  });
  const proxy = createProxyRecorder({ replyEventId: null });
  const durableStore = createDurableConversationStore({
    root: storeRoot,
    enabled: true,
  });
  const runtime = createHeadlessCodexRuntime({
    profileConfig: shadowProfile({ workingDirectory: home }),
    enableShadow: true,
    transactionProxy: proxy,
    durableStore,
    ownerInstanceId: "owner-missing-reply",
    profileInstanceId: PROFILE_INSTANCE_ID,
    command: fake.command,
    args: fake.args,
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
          deliveryId: "delivery_62",
          numericDeliveryId: 62,
          text: "reply without event id",
          inboundEventId: INBOUND_EVENT_ID,
        }),
      (error) => error.code === "completion_reply_missing",
    );
    assert.deepEqual(
      proxy.calls.map((call) => call.op),
      ["reply"],
    );
    assert.ok(!proxy.calls.some((call) => call.op === "ack"));
    const row = runtime.registry.get(PROFILE_INSTANCE_ID, ROOM_ID);
    assert.equal(row.executionState, "result_ready");
    assert.equal(row.lastReplyEventId, null);
    assert.equal(
      durableStore.readCompletion(
        PROFILE_INSTANCE_ID,
        `${PROFILE_INSTANCE_ID.slice(0, 16)}:${ROOM_ID}:delivery_62:e1`.slice(0, 128),
      ),
      null,
    );
  } finally {
    await runtime.stop({ signal: "SIGKILL", timeoutMs: 1_000 }).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});
