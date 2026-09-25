import assert from "node:assert/strict";
import test from "node:test";

import { createClientSupervisor } from "../src/client-supervisor.mjs";
import { createConcurrencyGate } from "../src/concurrency-gate.mjs";
import { createAgentWorker } from "../src/runtime.mjs";
import {
  deriveProfileInstanceId,
} from "../src/codex-runtime/headless-drain-service.mjs";

const id = (index) => index.toString(16).padStart(64, "0");

function wakeDrain(instanceIndex, digit = "e") {
  const instanceId = id(instanceIndex);
  const agentId = `agent_${digit.repeat(32)}`;
  return {
    instanceId,
    mailbox: {
      meshUrl: "https://mesh.example",
      meshToken: `mesh_${digit.repeat(64)}`,
      recipientId: agentId,
      pageLimit: 1,
    },
    runner: { command: "/trusted/runner", args: [], timeoutMs: 1_000 },
    runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: instanceId },
  };
}

function eventWakeFixture(profileIndex = 2, digit = "e") {
  const drain = wakeDrain(profileIndex, digit);
  return {
    installationId: "inst_N7VhDq3mQ2",
    helperPath: "/trusted/triangle-mailbox",
    cursorPath: "/private/wake-cursor.json",
    actorProfile: "event-hermes",
    ensureBeforeWatch: true,
    profiles: [{ instanceId: drain.instanceId, agentId: drain.mailbox.recipientId }],
    drains: [drain],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("FIFO concurrency gate admits at most two reasoners in arrival order", async () => {
  const gate = createConcurrencyGate({ limit: 2 });
  const releases = Array.from({ length: 5 }, deferred);
  const entered = [];
  let active = 0;
  let peak = 0;
  const jobs = releases.map((release, index) => gate.run(async () => {
    entered.push(index);
    active += 1;
    peak = Math.max(peak, active);
    await release.promise;
    active -= 1;
    return index;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, [0, 1]);
  releases[1].resolve();
  await jobs[1];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, [0, 1, 2]);
  releases[0].resolve();
  await jobs[0];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, [0, 1, 2, 3]);
  releases[2].resolve();
  releases[3].resolve();
  await Promise.all([jobs[2], jobs[3]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, [0, 1, 2, 3, 4]);
  releases[4].resolve();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test("shutdown abort prevents a just-admitted queued reasoner from starting", async () => {
  const gate = createConcurrencyGate({ limit: 1 });
  const release = deferred();
  const first = gate.run(() => release.promise);
  const controller = new AbortController();
  let invoked = false;
  const second = gate.run(async () => { invoked = true; }, { signal: controller.signal });
  release.resolve();
  controller.abort();
  await first;
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(invoked, false);
});

test("one coordinator creates ten isolated loops and never gives transport credentials to runners", async () => {
  const deliveryInputs = [];
  const runnerInputs = [];
  const workers = [];
  const instances = Array.from({ length: 10 }, (_, index) => ({
    instanceId: id(index + 1),
    mailbox: {
      meshUrl: "https://thetriangle.dev",
      meshToken: `transport-secret-${index}`,
      recipientId: `agent_${index.toString(16).padStart(32, "0")}`,
    },
    runner: { command: `/trusted/adapter-${index % 2}`, args: [] },
    runnerEnvironment: {
      PATH: "/usr/bin",
      TRIANGLE_INSTANCE_ID: id(index + 1),
      TRIANGLE_INSTANCE_TEMP_ROOT: `/private/instances/${id(index + 1)}`,
      ...(index % 2 === 0
        ? { CODEX_CLI: "/trusted/codex", CODEX_HOME: `/models/${id(index + 1)}` }
        : { HERMES_CLI: "/trusted/hermes", HERMES_HOME: `/models/${id(index + 1)}` }),
    },
  }));

  const supervisor = createClientSupervisor({
    instances,
    createDeliveryClient(config) {
      deliveryInputs.push(config);
      return { instanceId: config.recipientId };
    },
    createRunner(config) {
      runnerInputs.push(config);
      return { async run() { return { status: "completed", text: "ok" }; } };
    },
    createWorker(config) {
      workers.push(config);
      return {
        async runOnce() { return { found: 0, processed: 0 }; },
        async watch() { return { processed: 0, stopped: true }; },
      };
    },
  });

  assert.equal(deliveryInputs.length, 10);
  assert.equal(runnerInputs.length, 10);
  assert.equal(workers.length, 10);
  assert.deepEqual(supervisor.instanceIds, instances.map(({ instanceId }) => instanceId));
  for (let index = 0; index < 10; index += 1) {
    assert.equal(deliveryInputs[index].meshToken, `transport-secret-${index}`);
    assert.equal(runnerInputs[index].environment.TRIANGLE_INSTANCE_ID, instances[index].instanceId);
    assert.equal(JSON.stringify(runnerInputs[index]).includes("transport-secret"), false);
    assert.equal(runnerInputs[index].meshToken, undefined);
    assert.equal(runnerInputs[index].mailbox, undefined);
  }
});

test("supervisor applies global limit while preserving per-instance single-flight", async () => {
  const releases = Array.from({ length: 4 }, deferred);
  let active = 0;
  let peak = 0;
  const workers = [];
  const supervisor = createClientSupervisor({
    instances: releases.map((_, index) => ({
      instanceId: id(index + 1),
      mailbox: { meshToken: `token-${index}` },
      runner: { command: "/trusted/runner", args: [] },
      runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: id(index + 1) },
    })),
    createDeliveryClient: () => ({}),
    createRunner: (_config, context) => ({
      async run() {
        const index = Number.parseInt(context.instanceId, 16) - 1;
        active += 1;
        peak = Math.max(peak, active);
        await releases[index].promise;
        active -= 1;
        return { status: "completed", text: "ok" };
      },
    }),
    createWorker({ runner }) {
      let running;
      const worker = {
        runOnce() {
          running ??= runner.run({}).finally(() => { running = undefined; });
          return running;
        },
        async watch() { return { processed: 0, stopped: true }; },
      };
      workers.push(worker);
      return worker;
    },
    maxConcurrentReasoners: 2,
  });

  const duplicate = workers[0].runOnce();
  const all = [duplicate, workers[0].runOnce(), ...workers.slice(1).map((worker) => worker.runOnce())];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  releases[0].resolve();
  releases[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  releases[2].resolve();
  releases[3].resolve();
  await Promise.all(all);
  assert.equal(peak, 2);
  assert.equal(all[0], all[1]);
  assert.equal(supervisor.instanceIds.length, 4);
});

test("one failing mailbox loop does not stop peers and shutdown waits for every loop", async () => {
  const stopped = [];
  const supervisor = createClientSupervisor({
    instances: [0, 1, 2].map((index) => ({
      instanceId: id(index + 1), mailbox: { meshToken: `token-${index}` },
      runner: { command: "/trusted/runner" }, runnerEnvironment: { TRIANGLE_INSTANCE_ID: id(index + 1) },
    })),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() { return { status: "completed", text: "ok" }; } }),
    createWorker(_config, context) {
      return {
        async runOnce() { return { found: 0, processed: 0 }; },
        async watch({ signal }) {
          if (context.instanceId === id(1)) throw new Error("isolated failure");
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          stopped.push(context.instanceId);
          return { processed: 0, stopped: true };
        },
      };
    },
    logger: { error() {} },
  });

  const controller = new AbortController();
  const watching = supervisor.watch({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await watching;
  assert.deepEqual(stopped, [id(2), id(3)]);
  assert.deepEqual(result.instances.map(({ instanceId, stopped: didStop }) => [instanceId, didStop]), [
    [id(1), false], [id(2), true], [id(3), true],
  ]);
});

test("runOnce reports one failed instance without discarding successful peer results", async () => {
  const supervisor = createClientSupervisor({
    instances: [0, 1, 2].map((index) => ({
      instanceId: id(index + 1), mailbox: { meshToken: `token-${index}` },
      runner: { command: "/trusted/runner" }, runnerEnvironment: { TRIANGLE_INSTANCE_ID: id(index + 1) },
    })),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() { return { status: "completed", text: "ok" }; } }),
    createWorker(_config, context) {
      return {
        async runOnce() {
          if (context.instanceId === id(2)) throw new Error("isolated cycle failure");
          return { found: 1, processed: 1 };
        },
        async watch() { return { processed: 0, stopped: true }; },
      };
    },
    logger: { error() {} },
  });

  assert.deepEqual(await supervisor.runOnce(), {
    instances: [
      { instanceId: id(1), found: 1, processed: 1 },
      { instanceId: id(2), found: null, processed: 0, failed: true },
      { instanceId: id(3), found: 1, processed: 1 },
    ],
  });
});

test("a sole failed runOnce instance stays non-idle until its retry succeeds", async () => {
  let attempts = 0;
  const supervisor = createClientSupervisor({
    instances: [{
      instanceId: id(1), mailbox: { meshToken: "token" },
      runner: { command: "/trusted/runner" }, runnerEnvironment: { TRIANGLE_INSTANCE_ID: id(1) },
    }],
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() { return { status: "completed", text: "ok" }; } }),
    createWorker() {
      return {
        async runOnce() {
          attempts += 1;
          if (attempts === 1) throw new Error("retry me");
          return { found: 0, processed: 0 };
        },
        async watch() { return { processed: 0, stopped: true }; },
      };
    },
    logger: { error() {} },
  });

  const failed = await supervisor.runOnce();
  assert.equal(failed.instances[0].failed, true);
  assert.notEqual(failed.instances[0].found, 0);
  assert.deepEqual(await supervisor.runOnce(), {
    instances: [{ instanceId: id(1), found: 0, processed: 0 }],
  });
  assert.equal(attempts, 2);
});

test("adaptive idle polling uses deterministic bounded backoff and jitter", async () => {
  const sleeps = [];
  const randomValues = [0, 1, 0.5, 0.5];
  const controller = new AbortController();
  const worker = createAgentWorker({
    deliveryClient: {
      async listUnread() { return []; },
      async completeAndAcknowledge() {},
    },
    runner: { async run() { return { status: "completed", text: "unused" }; } },
    pollIntervalMs: 10,
    maxIdlePollIntervalMs: 40,
    idleJitterRatio: 0.25,
    random: () => randomValues.shift() ?? 0.5,
  });

  await worker.watch({
    signal: controller.signal,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (sleeps.length === 4) controller.abort();
    },
  });
  assert.deepEqual(sleeps, [10, 25, 40, 40]);
});

test("supervisor rejects duplicate instances and unsafe or credential-bearing runner environments", () => {
  const base = {
    instanceId: id(1), mailbox: { meshToken: "secret" }, runner: { command: "/trusted/runner" },
    runnerEnvironment: { TRIANGLE_INSTANCE_ID: id(1) },
  };
  const dependencies = {
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
  };
  assert.throws(() => createClientSupervisor({ instances: [base, base], ...dependencies }), /duplicate/i);
  assert.throws(() => createClientSupervisor({
    instances: [{ ...base, runnerEnvironment: { ...base.runnerEnvironment, MESH_AGENT_TOKEN: "leak" } }],
    ...dependencies,
  }), /runner environment/i);
});

test("supervisor launches eventWake listener beside worker loops with shared gate and helper ensure", async () => {
  const ensureCalls = [];
  const transportCalls = [];
  let capturedGate = null;
  let wakeStarted = false;
  let workerStarted = false;
  let workerEnteredGate = false;

  const supervisor = createClientSupervisor({
    instances: [{
      instanceId: id(1),
      mailbox: { meshToken: "worker-secret" },
      runner: { command: "/trusted/runner", args: [] },
      runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: id(1) },
    }],
    eventWake: eventWakeFixture(2),
    createDeliveryClient: () => ({}),
    createRunner: () => ({
      async run() {
        workerEnteredGate = true;
        return { status: "completed", text: "ok" };
      },
    }),
    createWorker({ runner }) {
      return {
        async runOnce() { return { found: 0, processed: 0 }; },
        async watch({ signal }) {
          workerStarted = true;
          await runner.run({});
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { processed: 0, stopped: true };
        },
      };
    },
    createWatchTransport({ helperPath, installationId }) {
      transportCalls.push({ helperPath, installationId });
      return {
        async poll() {
          return { cursor: 0, events: [] };
        },
      };
    },
    async ensureWatchGrant(options) {
      ensureCalls.push(options);
      return { ensured: true };
    },
    createHarness({ clients, runners }) {
      assert.equal(clients.has(id(2)), true);
      assert.equal(runners.has(id(2)), true);
      return {
        async preflight() { return false; },
        async run() { return { status: "drained" }; },
      };
    },
    createWake({ profiles, transport, gate: sharedGate, harness, cursorPath }) {
      assert.deepEqual(profiles, [{ instanceId: id(2), agentId: `agent_${"e".repeat(32)}` }]);
      assert.equal(cursorPath, "/private/wake-cursor.json");
      assert.equal(typeof transport.poll, "function");
      assert.equal(typeof harness.preflight, "function");
      assert.equal(typeof sharedGate.run, "function");
      capturedGate = sharedGate;
      return {
        async start({ signal }) {
          wakeStarted = true;
          assert.equal(ensureCalls.length, 1);
          await sharedGate.run(async () => "wake-turn");
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { cycles: 0, cursor: 0 };
        },
      };
    },
    maxConcurrentReasoners: 2,
  });

  assert.deepEqual(supervisor.eventWakeProfileIds, [id(2)]);
  assert.deepEqual(supervisor.instanceIds, [id(1)]);
  assert.deepEqual(transportCalls, [{
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
  }]);
  assert.equal(typeof capturedGate?.run, "function");

  const controller = new AbortController();
  const watching = supervisor.watch({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workerStarted, true);
  assert.equal(wakeStarted, true);
  assert.equal(workerEnteredGate, true);
  assert.deepEqual(ensureCalls[0], {
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
    actorProfile: "event-hermes",
    signal: controller.signal,
  });
  controller.abort();
  const result = await watching;
  assert.equal(result.instances.length, 1);
  assert.equal(result.eventWake?.cursor, 0);
});

test("supervisor fails closed when watch-ensure preflight fails before worker loops", async () => {
  let workerStarted = false;
  const supervisor = createClientSupervisor({
    instances: [{
      instanceId: id(1),
      mailbox: { meshToken: "worker-secret" },
      runner: { command: "/trusted/runner", args: [] },
      runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: id(1) },
    }],
    eventWake: eventWakeFixture(2),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() { return { status: "completed", text: "ok" }; } }),
    createWorker() {
      return {
        async runOnce() { return { found: 0, processed: 0 }; },
        async watch() {
          workerStarted = true;
          return { processed: 0, stopped: true };
        },
      };
    },
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    async ensureWatchGrant() {
      const error = new Error("watch helper ensure failed");
      error.code = "helper_unavailable";
      throw error;
    },
    createHarness: () => ({
      async preflight() { return false; },
      async run() { return { status: "drained" }; },
    }),
    createWake: () => ({
      async start() { throw new Error("wake must not start"); },
    }),
    logger: { error() {} },
  });

  await assert.rejects(
    () => supervisor.watch({ signal: new AbortController().signal }),
    (error) => error.code === "helper_unavailable",
  );
  assert.equal(workerStarted, false);
});

test("supervisor rejects eventWake collision with worker instance ids", () => {
  assert.throws(() => createClientSupervisor({
    instances: [{
      instanceId: id(1),
      mailbox: { meshToken: "secret" },
      runner: { command: "/trusted/runner", args: [] },
      runnerEnvironment: { TRIANGLE_INSTANCE_ID: id(1) },
    }],
    eventWake: eventWakeFixture(1, "1"),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
    createWake: () => ({ async start() {} }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    ensureWatchGrant: async () => ({ ensured: true }),
    createHarness: () => ({
      async preflight() { return false; },
      async run() {},
    }),
  }), /collides/i);
});

test("supervisor builds real mailbox harness clients without double-gating drain runners", async () => {
  const gateEntries = [];
  let harnessRunnerCalls = 0;
  const supervisor = createClientSupervisor({
    instances: [],
    eventWake: eventWakeFixture(2),
    createDeliveryClient(options) {
      assert.equal(options.meshToken, `mesh_${"e".repeat(64)}`);
      let remaining = 1;
      return {
        async listUnread() {
          if (remaining <= 0) return [];
          return [{ messageId: "pending" }];
        },
        async completeAndAcknowledge(_message, generate) {
          remaining -= 1;
          await generate({ text: "hi" });
          return { reconciled: false, acknowledged: true };
        },
      };
    },
    createRunner() {
      return {
        async run() {
          harnessRunnerCalls += 1;
          return { status: "completed", text: "ok" };
        },
      };
    },
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    ensureWatchGrant: async () => ({ ensured: true }),
    createWake({ gate, harness }) {
      return {
        async start() {
          await gate.run(async () => {
            gateEntries.push("wake");
            assert.equal(await harness.preflight({ instanceId: id(2) }), true);
            const result = await harness.run({ instanceId: id(2) });
            assert.deepEqual(result, { status: "more", processed: 1 });
            assert.deepEqual(await harness.run({ instanceId: id(2) }), { status: "drained", processed: 0 });
          });
          return { cycles: 1, cursor: 1 };
        },
      };
    },
    maxConcurrentReasoners: 1,
    logger: { error() {} },
  });

  const result = await supervisor.watch({ signal: AbortSignal.timeout(1_000) });
  assert.equal(result.eventWake?.cycles, 1);
  assert.equal(harnessRunnerCalls, 1);
  assert.deepEqual(gateEntries, ["wake"]);
});

function appServerWakeFixture(instanceIndex = 3) {
  const instanceId = id(instanceIndex);
  return {
    installationId: "inst_N7VhDq3mQ2",
    helperPath: "/trusted/triangle-mailbox",
    cursorPath: "/private/app-server-wake-cursor.json",
    bindingPath: "/private/app-server-binding.json",
    actorProfile: "event-codex",
    ensureBeforeWatch: true,
    authTokenFile: "/private/codex-ws.token",
    authTokenEnv: null,
    binding: {
      adapterVersion: "1",
      enabled: true,
      installationId: "inst_N7VhDq3mQ2",
      instanceId,
      agentId: "agent_codex_desktop_001",
      roomScope: "room_test_scope",
      serverIdentity: "codex-app-server/test",
      endpoint: "ws://127.0.0.1:9999/rpc",
      threadId: "01a06f9f-2db1-7143-b8b9-08c634cc7999",
    },
  };
}

test("supervisor bootstraps opt-in appServerWake beside workers", async () => {
  const ensured = [];
  let bridgeStarted = false;
  const supervisor = createClientSupervisor({
    instances: [{
      instanceId: id(1),
      mailbox: { meshToken: "secret" },
      runner: { command: "/trusted/runner", args: [] },
      runnerEnvironment: { TRIANGLE_INSTANCE_ID: id(1) },
    }],
    appServerWake: appServerWakeFixture(3),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({
      async watch() { return { processed: 0, stopped: true }; },
      async runOnce() { return { found: null, processed: 0 }; },
    }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    ensureWatchGrant: async (options) => {
      ensured.push(options.actorProfile);
      return { ensured: true };
    },
    createAuthResolver: ({ serverIdentity, tokenFile }) => {
      assert.equal(serverIdentity, "codex-app-server/test");
      assert.equal(tokenFile, "/private/codex-ws.token");
      return { async resolveAuth() { return { authorization: "Bearer test", serverIdentity }; } };
    },
    createAppServerTransport: () => ({
      async connect() { return { connected: true, serverIdentity: "codex-app-server/test" }; },
      async call() { return {}; },
      onEvent() { return () => {}; },
      async close() {},
    }),
    createBindingStore: () => ({ async read() { return null; }, async write(v) { return v; } }),
    createCursorStore: () => ({ async read() { return 0; }, async write() {} }),
    createSession: () => ({
      async connect() { return { status: "subscribed" }; },
      async shutdown() { return { status: "disconnected" }; },
      admit: async () => ({ status: "completed" }),
      status: () => ({ status: "subscribed" }),
    }),
    createWakeBridge: () => ({
      async start() {
        bridgeStarted = true;
        return { status: "stopped", cycles: 1 };
      },
      async stop() {},
    }),
    logger: { error() {} },
  });

  assert.equal(supervisor.appServerInstanceId, id(3));
  assert.equal(supervisor.appServerWake.binding.threadId, "01a06f9f-2db1-7143-b8b9-08c634cc7999");
  const result = await supervisor.watch({ signal: AbortSignal.timeout(1_000) });
  assert.equal(bridgeStarted, true);
  // appServer-only supervisors do not ensure here: grant refresh requires an
  // event-driven actor (wakeConfig), and the bridge itself skips ensure.
  assert.deepEqual(ensured, []);
  assert.equal(result.appServerWake?.cycles, 1);
});

test("supervisor wires production durable resolveDelivery into App Server wake bridge", async () => {
  let bridgeResolver;
  createClientSupervisor({
    instances: [],
    appServerWake: appServerWakeFixture(3),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    ensureWatchGrant: async () => ({ ensured: true }),
    createAuthResolver: () => ({
      async resolveAuth() {
        return { authorization: "Bearer test", serverIdentity: "codex-app-server/test" };
      },
    }),
    createAppServerTransport: () => ({
      async connect() { return { connected: true, serverIdentity: "codex-app-server/test" }; },
      async call() { return {}; },
      onEvent() { return () => {}; },
      async close() {},
    }),
    createBindingStore: () => ({ async read() { return null; }, async write(v) { return v; } }),
    createCursorStore: () => ({ async read() { return 0; }, async write() {} }),
    createSession: () => ({
      async connect() { return { status: "subscribed" }; },
      async shutdown() { return { status: "disconnected" }; },
      admit: async () => ({ status: "completed" }),
      status: () => ({ status: "subscribed" }),
    }),
    createWakeBridge({ resolveDelivery }) {
      bridgeResolver = resolveDelivery;
      return { async start() { return { status: "stopped", cycles: 0 }; }, async stop() {} };
    },
    logger: { error() {} },
  });
  assert.equal(typeof bridgeResolver, "function");
  assert.equal(bridgeResolver.name, "resolveDelivery");
});

test("supervisor rejects appServerWake collision with worker instance ids", () => {
  assert.throws(() => createClientSupervisor({
    instances: [{
      instanceId: id(3),
      mailbox: { meshToken: "secret" },
      runner: { command: "/trusted/runner", args: [] },
      runnerEnvironment: { TRIANGLE_INSTANCE_ID: id(3) },
    }],
    appServerWake: appServerWakeFixture(3),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    ensureWatchGrant: async () => ({ ensured: true }),
    createAuthResolver: () => ({ async resolveAuth() { return { authorization: "Bearer x", serverIdentity: "s" }; } }),
    createAppServerTransport: () => ({ async connect() {}, async call() {}, onEvent() { return () => {}; }, async close() {} }),
    createBindingStore: () => ({ async read() { return null; }, async write(v) { return v; } }),
    createCursorStore: () => ({ async read() { return 0; }, async write() {} }),
    createSession: () => ({ async connect() {}, async shutdown() {}, admit: async () => ({}), status: () => ({}) }),
    createWakeBridge: () => ({ async start() {}, async stop() {} }),
  }), /collides/i);
});

function grokBotWakeFixture(instanceIndex = 4) {
  const instanceId = id(instanceIndex);
  return {
    installationId: "inst_N7VhDq3mQ2",
    helperPath: "/trusted/triangle-mailbox",
    cursorPath: "/private/grok-bot-wake-cursor.json",
    bindingPath: "/private/grok-bot-binding.json",
    webhookUrlPath: "/private/grok-bot-webhook.url",
    webhookKeyPath: "/private/grok-bot-webhook.key",
    actorProfile: "bob",
    ensureBeforeWatch: true,
    binding: {
      adapterVersion: "1",
      enabled: true,
      installationId: "inst_N7VhDq3mQ2",
      instanceId,
      agentId: "agent_582567705a9348c38f18c91d2bac9dd8",
      profile: "bob",
      grokAgentId: "12aedccc-8662-4a7f-84da-3d35c9e97842",
      wakeMode: "webhook",
    },
  };
}

test("supervisor bootstraps opt-in grokBotWake beside workers", async () => {
  const ensured = [];
  let bridgeStarted = false;
  const supervisor = createClientSupervisor({
    instances: [{
      instanceId: id(1),
      mailbox: { meshToken: "secret" },
      runner: { command: "/trusted/runner", args: [] },
      runnerEnvironment: { TRIANGLE_INSTANCE_ID: id(1) },
    }],
    grokBotWake: grokBotWakeFixture(4),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({
      async watch() { return { processed: 0, stopped: true }; },
      async runOnce() { return { found: null, processed: 0 }; },
    }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    ensureWatchGrant: async (options) => {
      ensured.push(options.actorProfile);
      return { ensured: true };
    },
    createCursorStore: () => ({ async read() { return 0; }, async write() {} }),
    createGrokBotBridge: (options) => {
      assert.equal(options.webhookUrlPath, "/private/grok-bot-webhook.url");
      assert.equal(options.webhookKeyPath, "/private/grok-bot-webhook.key");
      assert.equal(options.binding.wakeMode, "webhook");
      return {
        async start() {
          bridgeStarted = true;
          return { status: "stopped", cycles: 1 };
        },
        async stop() {},
      };
    },
    logger: { error() {} },
  });

  assert.equal(supervisor.grokBotInstanceId, id(4));
  assert.equal(supervisor.grokBotWake.binding.grokAgentId, "12aedccc-8662-4a7f-84da-3d35c9e97842");
  const result = await supervisor.watch({ signal: AbortSignal.timeout(1_000) });
  assert.equal(bridgeStarted, true);
  assert.deepEqual(ensured, ["bob"]);
  assert.equal(result.grokBotWake?.cycles, 1);
});

test("supervisor rejects grokBotWake collision with worker and appServerWake", () => {
  assert.throws(() => createClientSupervisor({
    instances: [{
      instanceId: id(4),
      mailbox: { meshToken: "secret" },
      runner: { command: "/trusted/runner", args: [] },
      runnerEnvironment: { TRIANGLE_INSTANCE_ID: id(4) },
    }],
    grokBotWake: grokBotWakeFixture(4),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    ensureWatchGrant: async () => ({ ensured: true }),
    createCursorStore: () => ({ async read() { return 0; }, async write() {} }),
    createGrokBotBridge: () => ({ async start() {}, async stop() {} }),
  }), /collides/i);

  assert.throws(() => createClientSupervisor({
    instances: [],
    appServerWake: appServerWakeFixture(3),
    grokBotWake: {
      ...grokBotWakeFixture(3),
      binding: {
        ...grokBotWakeFixture(3).binding,
        instanceId: id(3),
      },
    },
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    ensureWatchGrant: async () => ({ ensured: true }),
    createAuthResolver: () => ({ async resolveAuth() { return { authorization: "Bearer x", serverIdentity: "s" }; } }),
    createAppServerTransport: () => ({ async connect() {}, async call() {}, onEvent() { return () => {}; }, async close() {} }),
    createBindingStore: () => ({ async read() { return null; }, async write(v) { return v; } }),
    createCursorStore: () => ({ async read() { return 0; }, async write() {} }),
    createSession: () => ({ async connect() {}, async shutdown() {}, admit: async () => ({}), status: () => ({}) }),
    createWakeBridge: () => ({ async start() {}, async stop() {} }),
    createGrokBotBridge: () => ({ async start() {}, async stop() {} }),
  }), /collides/i);
});

test("supervisor stops App Server and Grok Bot bridges before wake retry", async () => {
  const logs = [];
  const appServer = { starts: 0, stops: 0 };
  const grokBot = { starts: 0, stops: 0 };

  const supervisor = createClientSupervisor({
    instances: [],
    appServerWake: appServerWakeFixture(3),
    grokBotWake: grokBotWakeFixture(4),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    ensureWatchGrant: async () => ({ ensured: true }),
    createAuthResolver: () => ({
      async resolveAuth() {
        return { authorization: "Bearer test", serverIdentity: "codex-app-server/test" };
      },
    }),
    createAppServerTransport: () => ({
      async connect() { return { connected: true, serverIdentity: "codex-app-server/test" }; },
      async call() { return {}; },
      onEvent() { return () => {}; },
      async close() {},
    }),
    createBindingStore: () => ({ async read() { return null; }, async write(v) { return v; } }),
    createCursorStore: () => ({ async read() { return 0; }, async write() {} }),
    createSession: () => ({
      async connect() { return { status: "subscribed" }; },
      async shutdown() { return { status: "disconnected" }; },
      admit: async () => ({ status: "completed" }),
      status: () => ({ status: "subscribed" }),
    }),
    createWakeBridge: () => ({
      async start() {
        appServer.starts += 1;
        if (appServer.starts === 1) {
          const helper = new Error("watch helper poll failed");
          helper.code = "helper_unavailable";
          throw helper;
        }
        return { status: "stopped", cycles: 1 };
      },
      async stop() {
        appServer.stops += 1;
      },
    }),
    createGrokBotBridge: () => ({
      async start() {
        grokBot.starts += 1;
        if (grokBot.starts === 1) {
          const helper = new Error("watch helper poll failed");
          helper.code = "helper_unavailable";
          throw helper;
        }
        return { status: "stopped", cycles: 1 };
      },
      async stop() {
        grokBot.stops += 1;
      },
    }),
    logger: {
      error(event, detail) {
        logs.push({ event, code: detail?.code });
      },
    },
  });

  const result = await supervisor.watch({
    signal: AbortSignal.timeout(1_000),
    sleep: async () => {},
  });

  assert.equal(appServer.starts, 2);
  assert.equal(appServer.stops, 1);
  assert.equal(grokBot.starts, 2);
  assert.equal(grokBot.stops, 1);
  assert.equal(result.appServerWake?.cycles, 1);
  assert.equal(result.grokBotWake?.cycles, 1);
  assert.ok(logs.some((entry) => entry.event === "triangle_client_app_server_wake_failed" && entry.code === "helper_unavailable"));
  assert.ok(logs.some((entry) => entry.event === "triangle_client_grok_bot_wake_failed" && entry.code === "helper_unavailable"));
  assert.equal(logs.some((entry) => entry.code === "already_started"), false);
});

test("supervisor shares one watch transport poll across App Server and Grok Bot wakes", async () => {
  const { createWakeClient } = await import("../src/wake-client.mjs");
  const transportCalls = [];
  let underlyingPolls = 0;
  let releasePoll;
  const held = new Promise((resolve) => { releasePoll = resolve; });
  const appAgent = "agent_codex_desktop_001";
  const grokAgent = "agent_582567705a9348c38f18c91d2bac9dd8";
  const appWakes = [];
  const grokWakes = [];
  /** @type {{ poll: Function } | null} */
  let sharedTransport = null;

  const supervisor = createClientSupervisor({
    instances: [],
    appServerWake: appServerWakeFixture(3),
    grokBotWake: grokBotWakeFixture(4),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
    createWatchTransport({ helperPath, installationId }) {
      transportCalls.push({ helperPath, installationId });
      return {
        async poll({ cursor }) {
          underlyingPolls += 1;
          await held;
          return {
            cursor: cursor + 1,
            events: [
              { agent_id: appAgent, high_watermark: cursor + 1 },
              { agent_id: grokAgent, high_watermark: cursor + 1 },
            ],
          };
        },
      };
    },
    ensureWatchGrant: async () => ({ ensured: true }),
    createAuthResolver: () => ({
      async resolveAuth() {
        return { authorization: "Bearer test", serverIdentity: "codex-app-server/test" };
      },
    }),
    createAppServerTransport: () => ({
      async connect() { return { connected: true, serverIdentity: "codex-app-server/test" }; },
      async call() { return {}; },
      onEvent() { return () => {}; },
      async close() {},
    }),
    createBindingStore: () => ({ async read() { return null; }, async write(v) { return v; } }),
    createCursorStore: () => {
      let cursor = 32;
      return {
        async read() { return cursor; },
        async write(next) { cursor = next; return cursor; },
      };
    },
    createSession: () => ({
      async connect() { return { status: "subscribed" }; },
      async shutdown() { return { status: "disconnected" }; },
      admit: async () => ({ status: "completed" }),
      status: () => ({ status: "subscribed" }),
    }),
    createWakeBridge({ binding, watchTransport, cursorStore }) {
      sharedTransport = watchTransport;
      const client = createWakeClient({
        profiles: [{ instanceId: binding.instanceId, agentId: binding.agentId }],
        transport: watchTransport,
        cursorStore,
        coalesceMs: 1,
        onWake: async (wake) => {
          appWakes.push(wake);
          return { status: "empty" };
        },
      });
      return {
        async start({ signal }) {
          return client.watch({ signal, maxCycles: 1 });
        },
        async stop() {
          await client.stop();
        },
      };
    },
    createGrokBotBridge({ binding, watchTransport, cursorStore }) {
      assert.equal(watchTransport, sharedTransport);
      const client = createWakeClient({
        profiles: [{ instanceId: binding.instanceId, agentId: binding.agentId }],
        transport: watchTransport,
        cursorStore,
        coalesceMs: 1,
        onWake: async (wake) => {
          grokWakes.push(wake);
          return { status: "accepted" };
        },
      });
      return {
        async start({ signal }) {
          return client.watch({ signal, maxCycles: 1 });
        },
        async stop() {
          await client.stop();
        },
      };
    },
    logger: { error() {} },
  });

  assert.equal(transportCalls.length, 1);
  assert.deepEqual(transportCalls[0], {
    helperPath: "/trusted/triangle-mailbox",
    installationId: "inst_N7VhDq3mQ2",
  });

  const watching = supervisor.watch({
    signal: AbortSignal.timeout(2_000),
    sleep: async () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(underlyingPolls, 1);
  releasePoll();
  const result = await watching;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(underlyingPolls, 1);
  assert.equal(result.appServerWake?.cycles, 1);
  assert.equal(result.grokBotWake?.cycles, 1);
  assert.equal(appWakes.length, 1);
  assert.equal(grokWakes.length, 1);
  assert.equal(appWakes[0].highWatermark, 33);
  assert.equal(grokWakes[0].highWatermark, 33);
  assert.equal(appWakes[0].instanceId, id(3));
  assert.equal(grokWakes[0].instanceId, id(4));
});

test("supervisor renews one expired shared watch grant and resumes both wake cursors exactly once", async () => {
  const { createWakeClient } = await import("../src/wake-client.mjs");
  const appAgent = "agent_codex_desktop_001";
  const grokAgent = "agent_582567705a9348c38f18c91d2bac9dd8";
  const ensureCalls = [];
  const observedCursors = [];
  const appWakes = [];
  const grokWakes = [];
  let polls = 0;
  let credentialValid = false;

  const supervisor = createClientSupervisor({
    instances: [],
    appServerWake: appServerWakeFixture(3),
    grokBotWake: grokBotWakeFixture(4),
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
    createWatchTransport: () => ({
      async poll({ cursor }) {
        polls += 1;
        observedCursors.push(cursor);
        if (!credentialValid) {
          const error = new Error("watch helper poll failed (watch_credential_invalid)");
          error.code = "helper_unavailable";
          error.rejectedCode = "watch_credential_invalid";
          throw error;
        }
        return {
          cursor: 42,
          events: [
            { agent_id: appAgent, high_watermark: 42 },
            { agent_id: grokAgent, high_watermark: 42 },
          ],
        };
      },
    }),
    ensureWatchGrant: async (options) => {
      ensureCalls.push(options.actorProfile);
      if (ensureCalls.length > 1) credentialValid = true;
      return { ensured: true };
    },
    createAuthResolver: () => ({
      async resolveAuth() {
        return { authorization: "Bearer test", serverIdentity: "codex-app-server/test" };
      },
    }),
    createAppServerTransport: () => ({
      async connect() { return { connected: true, serverIdentity: "codex-app-server/test" }; },
      async call() { return {}; },
      onEvent() { return () => {}; },
      async close() {},
    }),
    createBindingStore: () => ({ async read() { return null; }, async write(v) { return v; } }),
    createCursorStore: ({ filePath }) => {
      let cursor = filePath.includes("app-server") ? 40 : 41;
      return {
        async read() { return cursor; },
        async write(next) { cursor = next; return cursor; },
      };
    },
    createSession: () => ({
      async connect() { return { status: "subscribed" }; },
      async shutdown() { return { status: "disconnected" }; },
      admit: async () => ({ status: "completed" }),
      status: () => ({ status: "subscribed" }),
    }),
    createWakeBridge({ binding, watchTransport, cursorStore }) {
      let client = null;
      return {
        async start({ signal }) {
          client = createWakeClient({
            profiles: [{ instanceId: binding.instanceId, agentId: binding.agentId }],
            transport: watchTransport,
            cursorStore,
            coalesceMs: 1,
            onWake: async (wake) => { appWakes.push(wake); return { status: "empty" }; },
          });
          return client.watch({ signal, maxCycles: 1 });
        },
        async stop() { await client?.stop(); client = null; },
      };
    },
    createGrokBotBridge({ binding, watchTransport, cursorStore }) {
      let client = null;
      return {
        async start({ signal }) {
          client = createWakeClient({
            profiles: [{ instanceId: binding.instanceId, agentId: binding.agentId }],
            transport: watchTransport,
            cursorStore,
            coalesceMs: 1,
            onWake: async (wake) => { grokWakes.push(wake); return { status: "accepted" }; },
          });
          return client.watch({ signal, maxCycles: 1 });
        },
        async stop() { await client?.stop(); client = null; },
      };
    },
    logger: { error() {} },
  });

  const result = await supervisor.watch({
    signal: AbortSignal.timeout(2_000),
    sleep: async () => {},
  });

  assert.deepEqual(ensureCalls, ["bob", "bob"]);
  assert.ok(observedCursors.includes(40));
  assert.ok(observedCursors.includes(41));
  assert.equal(observedCursors.every((cursor) => cursor === 40 || cursor === 41), true);
  assert.equal(appWakes.length, 1);
  assert.equal(grokWakes.length, 1);
  assert.equal(appWakes[0].highWatermark, 42);
  assert.equal(grokWakes[0].highWatermark, 42);
  assert.equal(result.appServerWake?.cursor, 42);
  assert.equal(result.grokBotWake?.cursor, 42);
});

function headlessWakeFixture(overrides = {}) {
  const profile = overrides.profile ?? "codex-bob-test";
  return {
    profile,
    profileInstanceId: deriveProfileInstanceId(profile),
    helperPath: "/trusted/triangle-mailbox",
    workingDirectory: "/srv/triangle-work",
    codexHome: "/private/codex-home",
    stateRoot: "/private/headless-state",
    command: "/trusted/bin/codex",
    pollIntervalMs: 1_000,
    ...overrides,
  };
}

function fakeClaimerGuard({ failCode = null } = {}) {
  const events = [];
  return {
    events,
    create() {
      return {
        assertSupervisorMayClaim() {
          events.push("assert");
          if (failCode) {
            const error = new Error(failCode);
            error.code = failCode;
            throw error;
          }
        },
        acquire() { events.push("acquire"); },
        release() { events.push("release"); },
      };
    },
  };
}

test("supervisor composes one Codex headless drain and no other claimer", async () => {
  const claimer = fakeClaimerGuard();
  const drainEvents = [];
  let created = 0;
  const fixture = headlessWakeFixture();
  const supervisor = createClientSupervisor({
    instances: [],
    headlessWakes: [fixture],
    createHeadlessDrain(config) {
      created += 1;
      assert.equal(config.profile, "codex-bob-test");
      assert.equal(Object.hasOwn(config, "allowedRoomId"), false);
      assert.equal(config.profileInstanceId, deriveProfileInstanceId("codex-bob-test"));
      return {
        async start() {
          drainEvents.push("start");
          return { started: true };
        },
        async stop() {
          drainEvents.push("stop");
          return { started: false };
        },
      };
    },
    createClaimerGuard: claimer.create,
    logger: { error() {} },
  });

  assert.equal(created, 1);
  assert.deepEqual(supervisor.headlessInstanceIds, [deriveProfileInstanceId("codex-bob-test")]);
  assert.deepEqual(supervisor.headlessWakeSkipReasons, {});
  const controller = new AbortController();
  const watching = supervisor.watch({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await watching;
  assert.equal(result.headlessWakes[0]?.skipped, false);
  assert.deepEqual(drainEvents, ["start", "stop"]);
  assert.deepEqual(claimer.events, ["assert", "acquire", "release"]);
});

test("supervisor skips headless admission when the dedicated drain LaunchAgent is loaded", async () => {
  const claimer = fakeClaimerGuard({ failCode: "dedicated_headless_drain_loaded" });
  let created = 0;
  const logs = [];
  const supervisor = createClientSupervisor({
    instances: [{
      instanceId: id(1),
      mailbox: { meshToken: "secret" },
      runner: { command: "/trusted/runner", args: [] },
      runnerEnvironment: { TRIANGLE_INSTANCE_ID: id(1) },
    }],
    headlessWakes: [headlessWakeFixture()],
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({
      async watch() { return { processed: 0, stopped: true }; },
      async runOnce() { return { found: null, processed: 0 }; },
    }),
    createHeadlessDrain() {
      created += 1;
      throw new Error("must not create a second claimer");
    },
    createClaimerGuard: claimer.create,
    logger: {
      error(event, detail) {
        logs.push({ event, code: detail?.code });
      },
    },
  });

  assert.equal(created, 0);
  assert.equal(supervisor.headlessWakeSkipReasons["codex-bob-test"], "dedicated_headless_drain_loaded");
  const result = await supervisor.watch({ signal: AbortSignal.timeout(50) });
  assert.deepEqual(result.headlessWakes[0], {
    skipped: true,
    reason: "dedicated_headless_drain_loaded",
    profileInstanceId: deriveProfileInstanceId("codex-bob-test"),
  });
  assert.equal(logs.some((entry) => entry.event === "triangle_client_headless_wake_skipped"), true);
});

test("supervisor rejects headlessWake collision with every other mailbox claimer", () => {
  const headlessId = deriveProfileInstanceId("codex-bob-test");
  const factories = {
    createDeliveryClient: () => ({}),
    createRunner: () => ({ async run() {} }),
    createWorker: () => ({ async watch() {}, async runOnce() {} }),
    createWake: () => ({ async start() {} }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    ensureWatchGrant: async () => ({ ensured: true }),
    createHarness: () => ({ async preflight() { return false; }, async run() {} }),
    createAuthResolver: () => ({ async resolveAuth() { return { authorization: "Bearer x", serverIdentity: "s" }; } }),
    createAppServerTransport: () => ({ async connect() {}, async call() {}, onEvent() { return () => {}; }, async close() {} }),
    createBindingStore: () => ({ async read() { return null; }, async write(v) { return v; } }),
    createCursorStore: () => ({ async read() { return 0; }, async write() {} }),
    createSession: () => ({ async connect() {}, async shutdown() {}, admit: async () => ({}), status: () => ({}) }),
    createWakeBridge: () => ({ async start() {}, async stop() {} }),
    createGrokBotBridge: () => ({ async start() {}, async stop() {} }),
    createHeadlessDrain: () => ({ async start() {}, async stop() {} }),
    createClaimerGuard: fakeClaimerGuard().create,
  };

  assert.throws(() => createClientSupervisor({
    instances: [{
      instanceId: headlessId,
      mailbox: { meshToken: "secret" },
      runner: { command: "/trusted/runner", args: [] },
      runnerEnvironment: { TRIANGLE_INSTANCE_ID: headlessId },
    }],
    headlessWakes: [headlessWakeFixture()],
    ...factories,
  }), /collides/i);

  assert.throws(() => createClientSupervisor({
    instances: [],
    eventWake: {
      ...eventWakeFixture(2),
      profiles: [{ instanceId: headlessId, agentId: `agent_${"e".repeat(32)}` }],
      drains: [{
        ...wakeDrain(2),
        instanceId: headlessId,
        runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: headlessId },
      }],
    },
    headlessWakes: [headlessWakeFixture()],
    ...factories,
  }), /collides/i);

  assert.throws(() => createClientSupervisor({
    instances: [],
    appServerWake: {
      ...appServerWakeFixture(3),
      binding: { ...appServerWakeFixture(3).binding, instanceId: headlessId },
    },
    headlessWakes: [headlessWakeFixture()],
    ...factories,
  }), /collides/i);

  assert.throws(() => createClientSupervisor({
    instances: [],
    grokBotWake: {
      ...grokBotWakeFixture(4),
      binding: { ...grokBotWakeFixture(4).binding, instanceId: headlessId },
    },
    headlessWakes: [headlessWakeFixture()],
    ...factories,
  }), /collides/i);
});

test("supervisor does not put grok-bot on the Codex headless pool", () => {
  const factories = {
    createHeadlessDrain: () => ({ async start() {}, async stop() {} }),
    createClaimerGuard: fakeClaimerGuard().create,
    createGrokBotBridge: () => ({ async start() {}, async stop() {} }),
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    createCursorStore: () => ({ async read() { return 0; }, async write() {} }),
  };
  const grok = grokBotWakeFixture(4);
  const headless = headlessWakeFixture();
  const supervisor = createClientSupervisor({
    instances: [],
    grokBotWake: grok,
    headlessWakes: [headless],
    ...factories,
  });
  assert.equal(supervisor.grokBotInstanceId, grok.binding.instanceId);
  assert.deepEqual(supervisor.headlessInstanceIds, [headless.profileInstanceId]);
  assert.notEqual(supervisor.grokBotInstanceId, supervisor.headlessInstanceIds[0]);
});

test("supervisor accepts Codex headless without Mini pin or classic room_77 pin", () => {
  const factories = {
    createHeadlessDrain: () => ({ async start() {}, async stop() {} }),
    createClaimerGuard: fakeClaimerGuard().create,
  };
  const supervisor = createClientSupervisor({
    instances: [],
    headlessWakes: [headlessWakeFixture({
      profile: "codex-bob-test",
      profileInstanceId: deriveProfileInstanceId("codex-bob-test"),
    })],
    ...factories,
  });
  assert.equal(supervisor.headlessWakes[0].profile, "codex-bob-test");
  assert.equal(Object.hasOwn(supervisor.headlessWakes[0], "allowedRoomId"), false);
});

test("supervisor constructs and exposes one isolated drain per sorted headless profile", () => {
  const createdDrains = [];
  const createdGuards = [];
  const wakes = [
    headlessWakeFixture({ profile: "codex-headless", profileInstanceId: deriveProfileInstanceId("codex-headless"), stateRoot: "/state/headless" }),
    headlessWakeFixture({ stateRoot: "/state/bob" }),
  ];
  const supervisor = createClientSupervisor({
    instances: [], headlessWakes: wakes,
    createHeadlessDrain(config) { createdDrains.push(config.profile); return { async start() {}, async stop() {} }; },
    createClaimerGuard(options) { createdGuards.push(options); return fakeClaimerGuard().create(); },
  });
  assert.deepEqual(supervisor.headlessInstanceIds, wakes.slice().sort((a, b) => a.profile.localeCompare(b.profile)).map((wake) => wake.profileInstanceId));
  assert.deepEqual(createdDrains, ["codex-bob-test", "codex-headless"]);
  assert.deepEqual(createdGuards.map(({ profile }) => profile), ["codex-bob-test", "codex-headless"]);
  assert.equal(Object.isFrozen(supervisor.headlessWakes), true);
});

test("supervisor rolls back multi-drain startup and shuts down in reverse order", async () => {
  const events = [];
  const wakes = [
    headlessWakeFixture({ stateRoot: "/state/bob" }),
    headlessWakeFixture({ profile: "codex-headless", profileInstanceId: deriveProfileInstanceId("codex-headless"), stateRoot: "/state/headless" }),
  ];
  const supervisor = createClientSupervisor({
    instances: [], headlessWakes: wakes,
    createClaimerGuard({ profile }) { return { assertSupervisorMayClaim() {}, acquire() { events.push(`acquire:${profile}`); }, release() { events.push(`release:${profile}`); } }; },
    createHeadlessDrain({ profile }) { return { async start() { events.push(`start:${profile}`); if (profile === "codex-headless") throw new Error("boom"); }, async stop() { events.push(`stop:${profile}`); } }; },
    logger: { error() {} },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await supervisor.watch({ signal: controller.signal });
  assert.ok(events.indexOf("stop:codex-headless") < events.indexOf("stop:codex-bob-test"));
  assert.ok(events.indexOf("release:codex-headless") < events.indexOf("release:codex-bob-test"));
  assert.ok(events.indexOf("stop:codex-headless") < events.indexOf("release:codex-headless"));
  assert.ok(events.indexOf("stop:codex-bob-test") < events.indexOf("release:codex-bob-test"));
});

test("supervisor fails closed for the whole headless pool when either guard conflicts", async () => {
  const created = [];
  const started = [];
  const wakes = [
    headlessWakeFixture({ stateRoot: "/state/bob" }),
    headlessWakeFixture({ profile: "codex-headless", profileInstanceId: deriveProfileInstanceId("codex-headless"), stateRoot: "/state/headless" }),
  ];
  const supervisor = createClientSupervisor({
    instances: [], headlessWakes: wakes,
    createClaimerGuard({ profile }) {
      return {
        assertSupervisorMayClaim() {
          if (profile === "codex-headless") {
            const error = new Error("dedicated loaded");
            error.code = "dedicated_headless_drain_loaded";
            throw error;
          }
        },
        acquire() { throw new Error("must not acquire any pool guard"); },
        release() {},
      };
    },
    createHeadlessDrain({ profile }) {
      created.push(profile);
      return { async start() { started.push(profile); }, async stop() {} };
    },
    logger: { error() {} },
  });
  assert.deepEqual(created, []);
  const result = await supervisor.watch({ signal: AbortSignal.timeout(20) });
  assert.deepEqual(started, []);
  assert.equal(supervisor.headlessWakeSkipReasons["codex-headless"], "dedicated_headless_drain_loaded");
  assert.equal(result.headlessWakes.length, 2);
  assert.equal(result.headlessWakes.every(({ skipped }) => skipped), true);
});

test("supervisor rejects the retired singleton headlessWake API", () => {
  assert.throws(
    () => createClientSupervisor({ instances: [], headlessWake: headlessWakeFixture() }),
    /headlessWake.*not supported/i,
  );
});

test("supervisor rejects canonical state-root collisions and room-pinned v2 wakes", () => {
  const bob = headlessWakeFixture({ stateRoot: "/state/a/../shared" });
  const headless = headlessWakeFixture({ profile: "codex-headless", profileInstanceId: deriveProfileInstanceId("codex-headless"), stateRoot: "/state/shared" });
  assert.throws(() => createClientSupervisor({ instances: [], headlessWakes: [bob, headless] }), /stateRoot/i);
  assert.throws(() => createClientSupervisor({
    instances: [],
    headlessWakes: [headlessWakeFixture({ allowedRoomId: "room_77aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })],
  }), /allowedRoomId|schema/i);
});

test("supervisor parks wake loop on binding_endpoint_changed terminal error without repeating retries", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const errors = [];
  const supervisor = createClientSupervisor({
    instances: [],
    eventWake: {
      ...eventWakeFixture(2),
      ensureBeforeWatch: false,
    },
    createWake: () => ({
      async start() {
        attempts += 1;
        const err = new Error("endpoint changed");
        err.code = "binding_endpoint_changed";
        throw err;
      },
    }),
    logger: {
      error(event, detail) {
        errors.push({ event, code: detail.code });
      },
    },
  });

  const watchPromise = supervisor.watch({ signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "binding_endpoint_changed");
  controller.abort();
  await watchPromise;
});

test("supervisor enforces cooldown backoff on HTTP 402 payment required / deployment disabled", async () => {
  let attempts = 0;
  const sleeps = [];
  const controller = new AbortController();
  const supervisor = createClientSupervisor({
    instances: [],
    eventWake: {
      ...eventWakeFixture(2),
      ensureBeforeWatch: false,
    },
    createWake: () => ({
      async start() {
        attempts += 1;
        const err = new Error("deployment disabled");
        err.httpStatus = 402;
        throw err;
      },
    }),
    logger: { error() {} },
  });

  await supervisor.watch({
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
      controller.abort();
    },
  });
  assert.equal(attempts, 1);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0] >= 15 * 60_000, true);
});

test("supervisor enforces cooldown backoff when grant renewal receives HTTP 402", async () => {
  let attempts = 0;
  let renewals = 0;
  const sleeps = [];
  const controller = new AbortController();
  const supervisor = createClientSupervisor({
    instances: [],
    eventWake: {
      ...eventWakeFixture(2),
      ensureBeforeWatch: true,
    },
    createWake: () => ({
      async start() {
        attempts += 1;
        const err = new Error("watch grant invalid");
        err.rejectedCode = "watch_credential_invalid";
        throw err;
      },
    }),
    ensureWatchGrant: async () => {
      renewals += 1;
      if (renewals === 1) {
        // Initial ensureBeforeWatch succeeds
        return { ensured: true };
      }
      // Renewal attempt fails with 402
      const err = new Error("payment required");
      err.status = 402;
      throw err;
    },
    logger: { error() {} },
  });

  await supervisor.watch({
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
      controller.abort();
    },
  });
  assert.equal(attempts, 1);
  assert.equal(renewals, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0] >= 15 * 60_000, true);
});
