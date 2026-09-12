import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SHARED_CODEX_ADAPTER_VERSION,
  assertCompatibleBinding,
  createAppServerWakeBridge,
  createAtomicFileBindingStore,
  createFakeAppServerTransport,
  createFakeWatchTransport,
  createMemoryBindingStore,
  createMemoryCorrelationStore,
  createSharedCodexSession,
  createTrustedTransactionProxyStub,
  validateBinding,
} from "../src/shared-codex-app-server.mjs";

const instanceId = "a".repeat(64);
const agentId = "agent_codex_desktop_001";

function sampleBinding(overrides = {}) {
  return {
    adapterVersion: SHARED_CODEX_ADAPTER_VERSION,
    enabled: true,
    installationId: "inst_N7VhDq3mQ2",
    instanceId,
    agentId,
    roomScope: "room_test_scope",
    serverIdentity: "codex-app-server/test",
    endpoint: "ws://127.0.0.1:9999/rpc",
    threadId: "01a06f9f-2db1-7143-b8b9-08c634cc7999",
    ...overrides,
  };
}

function matchingTransport(binding, overrides = {}) {
  return createFakeAppServerTransport({
    threadId: binding.threadId,
    serverIdentity: binding.serverIdentity,
    ...overrides,
  });
}

/**
 * Non-retaining transport: emits events to listeners but does not keep an
 * events[] buffer. Completions can fire immediately during turn/start.
 */
function createNonRetainingImmediateTransport({ threadId, serverIdentity }) {
  let connected = false;
  let turnCounter = 0;
  const listeners = new Set();
  const calls = [];

  function emit(method, params) {
    const event = { method, params };
    for (const listener of listeners) listener(event);
  }

  return Object.freeze({
    serverIdentity,
    // Intentionally no retained events array — waiters must not rely on it.
    calls,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async connect() {
      connected = true;
      return { connected: true, serverIdentity };
    },
    async call(method, params = {}) {
      if (!connected) throw new Error("not connected");
      calls.push({ method, params });
      switch (method) {
        case "initialize":
          return { serverInfo: { name: serverIdentity, version: "0.0.0-fake" } };
        case "thread/resume":
        case "thread/read":
          return { thread: { id: threadId, status: { type: "idle" }, turns: [] } };
        case "turn/start": {
          turnCounter += 1;
          const turnId = `turn_imm_${String(turnCounter).padStart(4, "0")}`;
          emit("turn/started", { threadId, turn: { id: turnId, status: "in_progress" } });
          // Complete synchronously before turn/start returns — classic race vs
          // waitForTurn registering after the response.
          emit("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
          return { turn: { id: turnId, status: "in_progress" } };
        }
        default:
          throw new Error(`unknown method ${method}`);
      }
    },
    async close() {
      connected = false;
    },
  });
}

test("validateBinding accepts a complete opt-in binding and rejects secrets", () => {
  const binding = validateBinding(sampleBinding());
  assert.equal(binding.adapterVersion, "1");
  assert.equal(binding.enabled, true);
  assert.throws(
    () => validateBinding(sampleBinding({ endpoint: "http://example.com" })),
    /endpoint/,
  );
  assert.throws(
    () => validateBinding(sampleBinding({ serverIdentity: "x".repeat(201) })),
    /serverIdentity/,
  );
  assert.throws(
    () =>
      validateBinding(
        sampleBinding({
          serverIdentity: "mesh_watch_ABCDEFGHijklmnop",
        }),
      ),
    (error) => error.code === "secret_leak_rejected",
  );
});

test("assertCompatibleBinding fails closed on endpoint or server identity change", () => {
  const previous = validateBinding(sampleBinding());
  assert.throws(
    () => assertCompatibleBinding(previous, sampleBinding({ endpoint: "ws://127.0.0.1:10000/rpc" })),
    (error) => error.code === "binding_endpoint_changed",
  );
  assert.throws(
    () => assertCompatibleBinding(previous, sampleBinding({ serverIdentity: "other-server" })),
    (error) => error.code === "binding_server_identity_changed",
  );
  assert.equal(
    assertCompatibleBinding(previous, sampleBinding({ enabled: false })).enabled,
    false,
  );
});

test("memory and atomic binding stores persist validated bindings", async () => {
  const memory = createMemoryBindingStore();
  assert.equal(await memory.read(), null);
  await memory.write(sampleBinding());
  assert.equal((await memory.read()).threadId, sampleBinding().threadId);

  const root = await mkdtemp(path.join(tmpdir(), "triangle-app-server-binding-"));
  const filePath = path.join(root, "binding.json");
  const store = createAtomicFileBindingStore({ filePath });
  await store.write(sampleBinding({ enabled: true }));
  const reloaded = createAtomicFileBindingStore({ filePath });
  const binding = await reloaded.read();
  assert.equal(binding.serverIdentity, "codex-app-server/test");
  const raw = await readFile(filePath, "utf8");
  assert.doesNotMatch(raw, /mesh_watch_/);
  await assert.rejects(
    () => reloaded.write(sampleBinding({ endpoint: "ws://127.0.0.1:1/rpc" })),
    (error) => error.code === "binding_endpoint_changed",
  );
});

test("fake transport session connects, resumes, and completes an idle turn", async () => {
  const binding = validateBinding(sampleBinding());
  const transport = matchingTransport(binding);
  const session = createSharedCodexSession({ binding, transport });
  const status = await session.connect();
  assert.equal(status.status, "subscribed");
  assert.equal(status.threadId, binding.threadId);

  const started = await session.startTurn({
    deliveryId: "delivery_idle_1",
    input: [{ type: "text", text: "Reply exactly WAKE_OK" }],
  });
  const turn = await session.waitForTurn(started.turn.id);
  assert.equal(turn.status, "completed");
  assert.equal(session.status().status, "subscribed");
  assert.equal(await session.correlationStore.get("delivery_idle_1").then((e) => e.turnId), started.turn.id);
});

test("connect fails closed when authenticated server identity mismatches binding", async () => {
  const binding = validateBinding(sampleBinding({ serverIdentity: "expected-server" }));
  const transport = createFakeAppServerTransport({
    threadId: binding.threadId,
    serverIdentity: "different-server",
  });
  const session = createSharedCodexSession({ binding, transport });
  await assert.rejects(
    () => session.connect(),
    (error) =>
      error.code === "server_identity_mismatch"
      && error.expected === "expected-server"
      && error.actual === "different-server",
  );
  assert.equal(session.status().status, "disconnected");
  assert.equal(session.status().lastError?.code, "server_identity_mismatch");
  assert.equal(
    transport.calls.some((call) => call.method === "thread/resume"),
    false,
    "must not resume thread after identity mismatch",
  );
});

test("admission queues while busy and drains after completion", async () => {
  const binding = validateBinding(sampleBinding());
  let releaseFirst;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const transport = matchingTransport(binding, {
    async onCall(method, params, { emit, setStatus }) {
      if (method !== "turn/start") return undefined;
      const turnId = `turn_manual_${params.input[0].text}`;
      setStatus({ type: "busy", turnId });
      emit("turn/started", { threadId: binding.threadId, turn: { id: turnId, status: "in_progress" } });
      if (params.input[0].text === "first") {
        firstDone.then(() => {
          setStatus({ type: "idle" });
          emit("turn/completed", {
            threadId: binding.threadId,
            turn: { id: turnId, status: "completed" },
          });
        });
      } else {
        queueMicrotask(() => {
          setStatus({ type: "idle" });
          emit("turn/completed", {
            threadId: binding.threadId,
            turn: { id: turnId, status: "completed" },
          });
        });
      }
      return { turn: { id: turnId, status: "in_progress" } };
    },
  });
  const session = createSharedCodexSession({ binding, transport });
  await session.connect();

  const first = session.admit({ deliveryId: "d1", text: "first" });
  // Allow first turn to start before enqueueing the busy follow-up.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.status().status, "running");
  const second = session.admit({ deliveryId: "d2", text: "second" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.status().queueDepth, 1);
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "completed");
  assert.equal(secondResult.status, "completed");
  assert.equal(session.status().queueDepth, 0);
  assert.ok(session.status().lastSuccessfulWakeAt);
});

test("waitForTurn observes immediate completion on a non-retaining transport", async () => {
  const binding = validateBinding(sampleBinding());
  const transport = createNonRetainingImmediateTransport({
    threadId: binding.threadId,
    serverIdentity: binding.serverIdentity,
  });
  const session = createSharedCodexSession({
    binding,
    transport,
    requestTimeoutMs: 50,
  });
  await session.connect();
  const started = await session.startTurn({
    deliveryId: "delivery_race_1",
    input: [{ type: "text", text: "fast" }],
  });
  assert.equal(transport.events, undefined);
  const turn = await session.waitForTurn(started.turn.id, { timeoutMs: 50 });
  assert.equal(turn.status, "completed");
  assert.equal(turn.id, started.turn.id);
  assert.notEqual(session.status().status, "submission_unknown");
  const admitted = await session.admit({ deliveryId: "delivery_race_2", text: "queued-after" });
  assert.equal(admitted.status, "completed");
});

test("empty mailbox resolveDelivery causes zero model turns", async () => {
  const binding = validateBinding(sampleBinding());
  const transport = matchingTransport(binding);
  const session = createSharedCodexSession({ binding, transport });
  const watchTransport = createFakeWatchTransport({
    polls: [
      {
        cursor: 3,
        events: [{ agent_id: agentId, high_watermark: 3 }],
      },
    ],
  });
  let resolveCalls = 0;
  const bridge = createAppServerWakeBridge({
    binding,
    session,
    watchTransport,
    coalesceMs: 5,
    async resolveDelivery() {
      resolveCalls += 1;
      return null;
    },
  });

  await bridge.start({ maxCycles: 1 });
  assert.equal(resolveCalls, 2); // startup reconcile + wake
  assert.equal(transport.calls.filter((call) => call.method === "turn/start").length, 0);
  await bridge.stop();
});

test("wake bridge admits a delivery through helper-shaped fake watch transport", async () => {
  const binding = validateBinding(sampleBinding());
  const transport = matchingTransport(binding);
  const session = createSharedCodexSession({ binding, transport });
  const watchTransport = createFakeWatchTransport({
    polls: [
      { cursor: 1, events: [] },
      {
        cursor: 4,
        events: [{ agent_id: agentId, high_watermark: 4 }],
      },
    ],
  });
  const admitted = [];
  const bridge = createAppServerWakeBridge({
    binding,
    session,
    watchTransport,
    coalesceMs: 5,
    async resolveDelivery(input) {
      if (input.reason === "startup_reconcile") return null;
      admitted.push(input);
      return { deliveryId: `delivery_${input.highWatermark}`, text: "WAKE_FROM_MESH" };
    },
  });

  await bridge.start({ maxCycles: 2 });
  // Allow coalesce + queue drain.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].highWatermark, 4);
  assert.equal(transport.calls.filter((call) => call.method === "turn/start").length, 1);
  assert.ok(["subscribed", "pending"].includes(session.status().status));
  assert.doesNotMatch(JSON.stringify(session.status()), /mesh_watch_/);
  await bridge.stop();
  assert.equal(session.status().status, "disconnected");
});

test("submission timeout becomes submission_unknown and stops auto-resubmit", async () => {
  const binding = validateBinding(sampleBinding());
  const transport = matchingTransport(binding, {
    async onCall(method) {
      if (method === "turn/start") {
        await new Promise(() => {});
      }
      return undefined;
    },
  });
  const session = createSharedCodexSession({
    binding,
    transport,
    requestTimeoutMs: 20,
  });
  await session.connect();
  await assert.rejects(
    () => session.startTurn({ deliveryId: "lost", input: [{ type: "text", text: "x" }] }),
    (error) => error.code === "request_timeout" && error.outcome === "unknown",
  );
  assert.equal(session.status().status, "submission_unknown");
  const skipped = await session.admit({ deliveryId: "next", text: "should not run" });
  assert.equal(skipped.status, "submission_unknown");
});

test("successful App Server calls clear timeout timers promptly", async () => {
  const binding = validateBinding(sampleBinding());
  const transport = matchingTransport(binding);
  const session = createSharedCodexSession({
    binding,
    transport,
    // A retained losing timer at this deadline would dominate wall clock.
    requestTimeoutMs: 30_000,
  });
  const startedAt = Date.now();
  await session.connect();
  const started = await session.startTurn({
    deliveryId: "delivery_timer_1",
    input: [{ type: "text", text: "timer-clear" }],
  });
  await session.waitForTurn(started.turn.id);
  await session.shutdown();
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs < 5_000,
    `focused calls should finish without waiting out requestTimeoutMs (elapsed ${elapsedMs}ms)`,
  );
});

test("trusted transaction proxy stub fails closed until Slice 6 lands", async () => {
  const proxy = createTrustedTransactionProxyStub();
  await assert.rejects(() => proxy.claim(), (error) => error.code === "slice6_required");
  await assert.rejects(() => proxy.reply(), (error) => error.code === "slice6_required");
  await assert.rejects(() => proxy.ack(), (error) => error.code === "slice6_required");
});

test("correlation store records delivery-to-turn mapping before completion", async () => {
  const store = createMemoryCorrelationStore();
  await store.record({ deliveryId: "d1", threadId: sampleBinding().threadId, status: "queued" });
  await store.update("d1", { turnId: "turn_1", status: "running" });
  assert.deepEqual(await store.get("d1"), {
    deliveryId: "d1",
    threadId: sampleBinding().threadId,
    turnId: "turn_1",
    status: "running",
    recordedAt: (await store.get("d1")).recordedAt,
  });
});
