import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPeerLane } from "../src/peer-lane.mjs";

const id = (index) => index.toString(16).padStart(64, "0");

function makePeerConfig(index, extra = {}) {
  const profile = `peer-${index}`;
  const profileInstanceId = id(index);
  const routePeerId = id(999);
  return {
    profile,
    profileInstanceId,
    stateRoot: path.join(os.tmpdir(), `peer-lane-test-${index}-${Date.now()}`),
    allowedPeers: [routePeerId],
    routes: new Map([[routePeerId, { id: routePeerId, addrs: ["/ip4/127.0.0.1/udp/1234/quic-v1"] }]]),
    relay: false,
    relayOnly: false,
    directOnly: true,
    relayUrl: null,
    engineBinaryPath: "/bin/echo",
    runnerConfig: { command: "/usr/bin/true", args: [], timeoutMs: 1_000 },
    runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: profileInstanceId },
    runnerTimeoutMs: 1_000,
    pollIntervalMs: 10,
    ...extra,
  };
}

test("createPeerLane validates at construction and delays engine/drain creation lazily (X4)", () => {
  assert.throws(() => createPeerLane({ peerConfigs: "not-an-array" }), /must be an array/);

  let engineFactoryCalled = 0;
  let drainFactoryCalled = 0;

  const config = makePeerConfig(1);
  const lane = createPeerLane({
    peerConfigs: [config],
    createPeerEngine: () => {
      engineFactoryCalled++;
      return { async start() {}, async stop() {}, get state() { return "ready"; } };
    },
    createPeerDrain: () => {
      drainFactoryCalled++;
      return { step: async () => ({ state: "idle" }), close: () => {} };
    },
    createRunner: () => ({ run: async () => ({ status: "completed", text: "ok" }) }),
  });

  // Construction did not invoke factories
  assert.equal(engineFactoryCalled, 0);
  assert.equal(drainFactoryCalled, 0);
  assert.equal(lane.isWatching, false);
});

test("initialization failure becomes profile status and does not throw at construction (X4)", async () => {
  const config = makePeerConfig(2);
  const lane = createPeerLane({
    peerConfigs: [config],
    createPeerEngine: () => {
      const err = new Error("Engine binary not executable");
      err.code = "engine_binary_invalid";
      throw err;
    },
    createPeerDrain: () => {
      throw new Error("unreachable");
    },
    createRunner: () => ({ run: async () => {} }),
  });

  // peerStatus captures the init error as lastError without throwing
  const statusList = await lane.peerStatus();
  assert.equal(statusList.length, 1);
  assert.equal(statusList[0].profile, config.profile);
  assert.equal(statusList[0].engineState, "stopped");
  assert.equal(statusList[0].lastError?.code, "engine_binary_invalid");
});

test("D2: engine ownership rules (send outside watch fails; runOnce while watching fails)", async () => {
  let engineStarted = 0;
  let engineStopped = 0;
  const config = makePeerConfig(3);

  const mockEngine = {
    get state() { return engineStarted > engineStopped ? "ready" : "stopped"; },
    async start() { engineStarted++; },
    async stop() { engineStopped++; },
    getIpcClient() { return {}; },
  };

  const mockDrain = {
    async step() { return { state: "idle" }; },
    async sendRequest({ toEndpointId, text }) {
      return { state: "queued_local", toEndpointId, text };
    },
    close() {},
  };

  const lane = createPeerLane({
    peerConfigs: [config],
    createPeerEngine: () => mockEngine,
    createPeerDrain: () => mockDrain,
    createRunner: () => ({ run: async () => {} }),
  });

  // 1. sendPeerMessage outside watch() fails with peer_lane_not_running
  await assert.rejects(
    lane.sendPeerMessage({
      profileInstanceId: config.profileInstanceId,
      toEndpointId: id(999),
      text: "hello",
    }),
    { code: "peer_lane_not_running" },
  );

  // 2. Start watch()
  const ac = new AbortController();
  let runLoopStarted = false;
  const fakeRunDurableWakeLoop = async ({ start, stop }) => {
    runLoopStarted = true;
    try {
      return await start();
    } catch (err) {
      await stop?.();
      throw err;
    }
  };

  const watchPromise = lane.watch({
    signal: ac.signal,
    sleep: async () => {},
    runDurableWakeLoop: fakeRunDurableWakeLoop,
  });

  assert.equal(lane.isWatching, true);
  assert.equal(runLoopStarted, true);
  assert.equal(engineStarted, 1);

  // 3. runOnce while watch() is active fails with peer_lane_busy
  await assert.rejects(
    lane.runOnce(),
    { code: "peer_lane_busy" },
  );

  // 4. A second watch() while watching fails with peer_lane_busy
  await assert.rejects(
    lane.watch({
      signal: ac.signal,
      sleep: async () => {},
      runDurableWakeLoop: fakeRunDurableWakeLoop,
    }),
    { code: "peer_lane_busy" },
  );

  // 5. sendPeerMessage succeeds while watch() is active
  const sendResult = await lane.sendPeerMessage({
    profileInstanceId: config.profileInstanceId,
    toEndpointId: id(999),
    text: "hello within watch",
  });
  assert.equal(sendResult.state, "queued_local");

  // 6. Abort stops watch cleanly and releases engines
  ac.abort();
  await watchPromise;
  assert.equal(lane.isWatching, false);
  assert.equal(engineStopped, 1);
});

test("runOnce executes one cycle per profile and stops engine in finally (D2)", async () => {
  let engineStarted = 0;
  let engineStopped = 0;
  let drainSteps = 0;
  const config = makePeerConfig(4);

  const mockEngine = {
    get state() { return engineStarted > engineStopped ? "ready" : "stopped"; },
    async start() { engineStarted++; },
    async stop() { engineStopped++; },
    getIpcClient() { return {}; },
  };

  const mockDrain = {
    async step() {
      drainSteps++;
      return { state: "acked", messageId: "msg-400" };
    },
    close() {},
  };

  const lane = createPeerLane({
    peerConfigs: [config],
    createPeerEngine: () => mockEngine,
    createPeerDrain: () => mockDrain,
    createRunner: () => ({ run: async () => {} }),
  });

  const results = await lane.runOnce();
  assert.equal(results.length, 1);
  assert.equal(results[0].profileInstanceId, config.profileInstanceId);
  assert.equal(results[0].outcome.state, "acked");
  assert.equal(drainSteps, 1);
  assert.equal(engineStarted, 1);
  assert.equal(engineStopped, 1);
});

test("per-profile isolated loops: failing profile does not stop or restart healthy profile (F8)", async () => {
  const configA = makePeerConfig(10, { profile: "profile-alpha" });
  const configB = makePeerConfig(11, { profile: "profile-beta" });

  const starts = { "profile-alpha": 0, "profile-beta": 0 };
  const stops = { "profile-alpha": 0, "profile-beta": 0 };

  const ac = new AbortController();

  const lane = createPeerLane({
    peerConfigs: [configA, configB],
    createPeerEngine: ({ profile }) => {
      const p = profile;
      return {
        get state() { return starts[p] > stops[p] ? "ready" : "stopped"; },
        async start() { starts[p]++; },
        async stop() { stops[p]++; },
        getIpcClient() { return {}; },
      };
    },
    createPeerDrain: ({ profile }) => {
      return {
        async step() {
          if (profile === "profile-alpha") {
            const err = new Error("alpha connection dropped");
            err.code = "ipc_disconnected";
            throw err;
          }
          return { state: "idle" };
        },
        close() {},
      };
    },
    createRunner: () => ({ run: async () => {} }),
  });

  // Emulate runDurableWakeLoop: restarts failed start() with backoff
  let alphaRestarts = 0;
  const runnerLoops = async ({ start, stop, logEvent }) => {
    while (!ac.signal.aborted) {
      try {
        await start();
        return;
      } catch (err) {
        if (ac.signal.aborted) return;
        alphaRestarts++;
        await stop?.();
        // Give event loop a tick before retry
        await new Promise((r) => setImmediate(r));
        if (alphaRestarts >= 2) {
          // Break alpha out after 2 attempts for the test
          return;
        }
      }
    }
  };

  const watchPromise = lane.watch({
    signal: ac.signal,
    sleep: async () => {},
    runDurableWakeLoop: runnerLoops,
  });

  // Wait a bit for loops to run
  await new Promise((r) => setTimeout(r, 50));

  // Beta started once and never stopped
  assert.equal(starts["profile-beta"], 1);
  assert.equal(stops["profile-beta"], 0);

  // Alpha failed and restarted
  assert.equal(starts["profile-alpha"] >= 2, true);
  assert.equal(stops["profile-alpha"] >= 1, true);

  ac.abort();
  await watchPromise;
});

test("peerStatus surfaces phase counts, held/reply_failed/rejected IDs/reasons without bodies", async () => {
  const config = makePeerConfig(5);

  const mockDrain = {
    step: async () => ({ state: "idle" }),
    status() {
      const records = [
        { sender: id(90), message_id: "msg-1", phase: "held", reason: "runner_timeout", reply_id: null },
        { sender: id(90), message_id: "msg-2", phase: "reply_failed", reason: "refused", reply_id: "rep-2" },
        { sender: id(91), message_id: "msg-3", phase: "rejected", reason: "input_conflict", reply_id: null },
        { sender: id(91), message_id: "msg-4", phase: "acked", reason: null, reply_id: null },
      ];
      return Object.assign(records, { totalRecords: 4, journalFull: false });
    },
    close() {},
  };

  const lane = createPeerLane({
    peerConfigs: [config],
    createPeerEngine: () => ({
      get state() { return "stopped"; },
      endpointId: "e".repeat(64),
      async start() {},
      async stop() {},
    }),
    createPeerDrain: () => mockDrain,
    createRunner: () => ({ run: async () => {} }),
  });

  const statuses = await lane.peerStatus();
  assert.equal(statuses.length, 1);
  const s = statuses[0];
  assert.equal(s.profile, config.profile);
  assert.equal(s.profileInstanceId, config.profileInstanceId);
  assert.equal(s.engineState, "stopped");
  assert.equal(s.endpointId, "e".repeat(64));
  assert.deepEqual(s.phaseCounts, { held: 1, reply_failed: 1, rejected: 1, acked: 1 });
  assert.deepEqual(s.held, [{ messageId: "msg-1", fromEndpointId: id(90), reason: "runner_timeout" }]);
  assert.deepEqual(s.replyFailed, [{ messageId: "msg-2", fromEndpointId: id(90), reason: "refused" }]);
  assert.deepEqual(s.rejected, [{ messageId: "msg-3", fromEndpointId: id(91), reason: "input_conflict" }]);
  assert.equal(s.totalRecords, 4);
  assert.equal(s.journalFull, false);
  // Confirms no body or raw payload is present
  assert.equal(s.held[0].text, undefined);
  assert.equal(s.held[0].payload, undefined);
});

test("pendingPeerReplies and consumePeerReply are async and delegate to drain", async () => {
  const config = makePeerConfig(6);
  let consumedArgs = null;

  const mockDrain = {
    step: async () => ({ state: "idle" }),
    pendingReplies({ inReplyTo, requestId } = {}) {
      return [{ messageId: "rep-10", inReplyTo, requestId, text: "hi" }];
    },
    consumeReply(args) {
      consumedArgs = args;
      return { consumed: true, messageId: args.messageId };
    },
    close() {},
  };

  const lane = createPeerLane({
    peerConfigs: [config],
    createPeerEngine: () => ({ get state() { return "stopped"; } }),
    createPeerDrain: () => mockDrain,
    createRunner: () => ({ run: async () => {} }),
  });

  const pending = await lane.pendingPeerReplies({
    profileInstanceId: config.profileInstanceId,
    inReplyTo: "out-1",
    requestId: "req-1",
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].messageId, "rep-10");
  assert.equal(pending[0].inReplyTo, "out-1");

  const consumed = await lane.consumePeerReply({
    profileInstanceId: config.profileInstanceId,
    fromEndpointId: id(90),
    messageId: "rep-10",
  });
  assert.equal(consumed.consumed, true);
  assert.deepEqual(consumedArgs, { fromEndpointId: id(90), messageId: "rep-10" });
});

test("resolvePeerRecord validates profile and delegates to drain", async () => {
  const config = makePeerConfig(7);
  let resolvedArgs = null;

  const mockDrain = {
    step: async () => ({ state: "idle" }),
    resolvePeerRecord(args) {
      resolvedArgs = args;
      return { state: "retry_pending", messageId: args.messageId, revision: 2 };
    },
    close() {},
  };

  const lane = createPeerLane({
    peerConfigs: [config],
    createPeerEngine: () => ({ get state() { return "stopped"; } }),
    createPeerDrain: () => mockDrain,
    createRunner: () => ({ run: async () => {} }),
  });

  await assert.rejects(
    lane.resolvePeerRecord({ profileInstanceId: "unknown", messageId: "m-1" }),
    /Unknown peer profileInstanceId/,
  );

  const res = await lane.resolvePeerRecord({
    profileInstanceId: config.profileInstanceId,
    fromEndpointId: id(90),
    messageId: "m-1",
    action: "retry",
    operationId: "op-1",
  });
  assert.equal(res.state, "retry_pending");
  assert.deepEqual(resolvedArgs, {
    fromEndpointId: id(90),
    messageId: "m-1",
    action: "retry",
    operationId: "op-1",
    expectedRevision: undefined,
  });
});

test("close() closes drains and stops engine managers, then rejects operations", async () => {
  const config = makePeerConfig(8);
  let drainClosed = false;
  let engineStopped = false;

  const mockEngine = {
    get state() { return "ready"; },
    async stop() { engineStopped = true; },
  };

  const mockDrain = {
    step: async () => ({ state: "idle" }),
    async close() { drainClosed = true; },
  };

  const lane = createPeerLane({
    peerConfigs: [config],
    createPeerEngine: () => mockEngine,
    createPeerDrain: () => mockDrain,
    createRunner: () => ({ run: async () => {} }),
  });

  // Trigger lazy creation
  await lane.runOnce();
  assert.equal(drainClosed, false);

  await lane.close();
  assert.equal(drainClosed, true);
  assert.equal(engineStopped, true);

  await assert.rejects(lane.runOnce(), { code: "peer_lane_closed" });
  await assert.rejects(lane.watch({ runDurableWakeLoop: async () => {} }), { code: "peer_lane_closed" });
  await assert.rejects(lane.sendPeerMessage(), { code: "peer_lane_closed" });
  await assert.rejects(lane.pendingPeerReplies(), { code: "peer_lane_closed" });
  await assert.rejects(lane.consumePeerReply({ profileInstanceId: config.profileInstanceId }), { code: "peer_lane_closed" });
  await assert.rejects(lane.resolvePeerRecord({ profileInstanceId: config.profileInstanceId }), { code: "peer_lane_closed" });
});

test("configured pollIntervalMs is forwarded to createPeerDrain and drain.start", async () => {
  const config = makePeerConfig(9, { pollIntervalMs: 37 });
  let drainFactoryOptions = null;
  let drainStartOptions = null;

  const mockDrain = {
    start: async (opts) => {
      drainStartOptions = opts;
      return { state: "stopped" };
    },
    step: async () => ({ state: "idle" }),
    close: async () => {},
  };

  const lane = createPeerLane({
    peerConfigs: [config],
    createPeerEngine: () => ({
      start: async () => {},
      stop: async () => {},
      get state() { return "ready"; },
      getIpcClient: () => ({}),
    }),
    createPeerDrain: (opts) => {
      drainFactoryOptions = opts;
      return mockDrain;
    },
    createRunner: () => ({ run: async () => {} }),
  });

  const ac = new AbortController();
  await lane.watch({
    signal: ac.signal,
    sleep: async () => {},
    runDurableWakeLoop: async ({ start }) => {
      ac.abort();
      return start();
    },
  });

  assert.equal(drainFactoryOptions?.pollIntervalMs, 37, "createPeerDrain received pollIntervalMs");
  assert.equal(drainStartOptions?.pollIntervalMs, 37, "drain.start received pollIntervalMs");
});
