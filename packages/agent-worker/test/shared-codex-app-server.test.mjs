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
  createTrustedTransactionProxy,
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
  const transport = createFakeAppServerTransport({ threadId: binding.threadId });
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

test("admission queues while busy and drains after completion", async () => {
  const binding = validateBinding(sampleBinding());
  let releaseFirst;
  const firstDone = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const transport = createFakeAppServerTransport({
    threadId: binding.threadId,
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

test("empty mailbox resolveDelivery causes zero model turns", async () => {
  const binding = validateBinding(sampleBinding());
  const transport = createFakeAppServerTransport({ threadId: binding.threadId });
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
  const transport = createFakeAppServerTransport({ threadId: binding.threadId });
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
  const transport = createFakeAppServerTransport({
    threadId: binding.threadId,
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
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

test("trusted transaction proxy stub fails closed until helper is present", async () => {
  const proxy = createTrustedTransactionProxyStub();
  await assert.rejects(() => proxy.claim(), (error) => error.code === "slice6_required");
  await assert.rejects(() => proxy.reply(), (error) => error.code === "slice6_required");
  await assert.rejects(() => proxy.ack(), (error) => error.code === "slice6_required");
});

test("createTrustedTransactionProxy uses helper when path and profile are set", () => {
  const proxy = createTrustedTransactionProxy({
    helperPath: "/trusted/triangle-mailbox",
    profile: "hermes-bot",
    protocol: "coordinator-delivery-v1",
  });
  assert.equal(proxy.name, "slice6_helper_trusted_transaction_proxy");
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
