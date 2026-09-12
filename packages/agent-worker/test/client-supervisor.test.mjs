import assert from "node:assert/strict";
import test from "node:test";

import { createClientSupervisor } from "../src/client-supervisor.mjs";
import { createConcurrencyGate } from "../src/concurrency-gate.mjs";
import { createAgentWorker } from "../src/runtime.mjs";

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
  assert.deepEqual(ensured, ["event-codex"]);
  assert.equal(result.appServerWake?.cycles, 1);
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
