// Regression tests for the PR #104 post-merge review (fix plan §13, findings P1–P15). Each test fails on
// `main` @ 47a01ce and passes with the fixes.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";

import { createPeerDrainService, PEER_ENVELOPE_PROTOCOL } from "../src/peer-drain-service.mjs";
import { createPeerEngineManager } from "../src/peer-engine-manager.mjs";
import { createPeerLane } from "../src/peer-lane.mjs";
import { createConcurrencyGate } from "../src/concurrency-gate.mjs";
import { createIpcClient } from "../src/peer/ipc-client.mjs";
import { validatePeerWake } from "../src/client-supervisor-schema.mjs";
import { createPeerSupervisor } from "../src/peer-supervisor.mjs";

const digest = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { info() {}, warn() {}, error() {} };
const SENDER = "a".repeat(64);
const PROFILE_ID = "b".repeat(64);
const OTHER_PROFILE_ID = "c".repeat(64);
const fakeEngine = path.resolve(import.meta.dirname, "fixtures/fake-peer-engine.mjs");
const routes = () => new Map([[SENDER, { id: SENDER, addrs: [] }]]);

function tempRoot(t) {
  const root = realpathSync(mkdtempSync("/tmp/peer-post-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function requestItem(messageId, requestId = `req-${messageId}`) {
  const payload = JSON.stringify({ protocol: PEER_ENVELOPE_PROTOCOL, kind: "request", request_id: requestId, text: "hello" });
  return { seq: 1, from_endpoint_id: SENDER, message_id: messageId, payload, payload_hash: digest(payload) };
}

// A fake engine IPC that yields like socket I/O, honours abort like the real client, removes acked items
// and records every send.
function fakeIpc(items = []) {
  const inbox = [...items];
  const sent = [];
  const sentById = new Map();
  return {
    inbox,
    sent,
    async request(method, params, { signal } = {}) {
      signal?.throwIfAborted();
      await new Promise((resolve) => setImmediate(resolve));
      if (method === "inbox") return { items: inbox.slice(0, 1) };
      if (method === "ack") {
        inbox.splice(0, 1);
        return { acked: 1, already_acked: 0, unknown: [] };
      }
      if (method === "send") {
        sent.push(params);
        sentById.set(params.message_id, params.payload);
        return {};
      }
      if (method === "message_status") {
        return {
          message_id: params.message_id,
          peer_endpoint_id: SENDER,
          payload_hash: digest(sentById.get(params.message_id) ?? ""),
          state: "queued_local",
        };
      }
      throw new Error(`unexpected IPC method ${method}`);
    },
  };
}

const outcomesIn = (ipc) =>
  ipc.sent.filter((s) => s.message_id.startsWith("peer-outcome-")).map((s) => ({ id: s.message_id, ...JSON.parse(s.payload) }));

function laneConfig(stateRoot, extra = {}) {
  return {
    profile: "peer-test",
    profileInstanceId: PROFILE_ID,
    stateRoot,
    allowedPeers: [SENDER],
    routes: routes(),
    relay: "default",
    relayOnly: false,
    directOnly: true,
    relayUrl: null,
    engineBinaryPath: "/bin/echo",
    runnerConfig: { command: "/usr/bin/true", args: [], timeoutMs: 1_000 },
    runnerTimeoutMs: 1_000,
    pollIntervalMs: 100,
    ...extra,
  };
}

const readyEngine = (ipc) => ({
  state: "ready",
  endpointId: null,
  async start() {},
  async stop() {},
  getIpcClient: () => ipc,
});

test("P1: a turn queued behind the shared gate is not timed out or held before it starts", async (t) => {
  const stateRoot = tempRoot(t);
  const gate = createConcurrencyGate({ limit: 1 });
  let releaseMesh;
  const meshTurn = gate.run(() => new Promise((resolve) => { releaseMesh = resolve; }));
  let runnerStarted = false;
  const ipc = fakeIpc([requestItem("m1")]);
  const lane = createPeerLane({
    peerConfigs: [laneConfig(stateRoot, { runnerTimeoutMs: 50 })],
    createPeerEngine: () => readyEngine(ipc),
    createRunner: () => ({ run: async () => { runnerStarted = true; return { status: "completed", text: "ok" }; } }),
    gate,
    logger: quiet,
  });
  t.after(() => lane.close());

  setTimeout(() => releaseMesh(), 200); // the MESH turn holds the only slot for four runner timeouts
  const [result] = await lane.runOnce();
  await meshTurn;
  assert.equal(runnerStarted, true);
  assert.equal(result.outcome.state, "acked");
  assert.equal(outcomesIn(ipc).length, 0, "no held outcome for a turn that only waited");
});

test("P1: a shutdown while queued leaves the request unheld and unacked", async (t) => {
  const stateRoot = tempRoot(t);
  const gate = createConcurrencyGate({ limit: 1 });
  let releaseMesh;
  const meshTurn = gate.run(() => new Promise((resolve) => { releaseMesh = resolve; }));
  const ipc = fakeIpc([requestItem("m1")]);
  const lane = createPeerLane({
    peerConfigs: [laneConfig(stateRoot)],
    createPeerEngine: () => readyEngine(ipc),
    createRunner: () => ({ run: async () => ({ status: "completed", text: "ok" }) }),
    gate,
    logger: quiet,
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(lane.runOnce({ signal: controller.signal }));
  releaseMesh();
  await meshTurn;
  const [status] = await lane.peerStatus();
  assert.equal(status.held.length, 0);
  assert.equal(ipc.inbox.length, 1, "the engine keeps the item for the next run");
  await lane.close();
});

test("P2: stop() during startup cancels that start, and its timer cannot stop a newer engine", async (t) => {
  const root = tempRoot(t);
  const stateRoot = path.join(root, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  const manager = createPeerEngineManager({
    stateRoot,
    binaryPath: fakeEngine,
    logger: quiet,
    env: { PATH: process.env.PATH, RUST_LOG: "slowfirst" },
    startTimeoutMs: 400,
  });
  t.after(() => manager.stop());

  const first = manager.start().then(() => "ready", (error) => error.code);
  await sleep(200);
  await manager.stop();
  assert.equal(await Promise.race([first, sleep(2000).then(() => "pending")]), "engine_stopped");

  await manager.start();
  await sleep(700); // past the first attempt's start timeout
  assert.equal(manager.state, "ready");
  assert.equal(existsSync(path.join(stateRoot, "sigint-2")), false, "the newer engine was not signalled");
});

test("P3: an engine that logs heavily before its ready line still becomes ready", async (t) => {
  const root = tempRoot(t);
  const stateRoot = path.join(root, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  const manager = createPeerEngineManager({
    stateRoot,
    binaryPath: fakeEngine,
    logger: quiet,
    env: { PATH: process.env.PATH, RUST_LOG: "chatty" },
    startTimeoutMs: 5000,
  });
  t.after(() => manager.stop());
  const ready = await manager.start();
  assert.equal(ready.endpointId, "c".repeat(64));
});

test("P4: a transient initialization failure is retried instead of cached", async (t) => {
  const stateRoot = tempRoot(t);
  const blocker = createPeerDrainService({
    stateRoot,
    profile: "blocker",
    profileInstanceId: OTHER_PROFILE_ID,
    ipc: fakeIpc(),
    runner: { run: async () => ({}) },
    routes: routes(),
    logger: quiet,
  });
  const lane = createPeerLane({
    peerConfigs: [laneConfig(stateRoot)],
    createPeerEngine: () => readyEngine(fakeIpc()),
    createRunner: () => ({ run: async () => ({ status: "completed", text: "ok" }) }),
    logger: quiet,
  });
  t.after(() => lane.close());

  assert.equal((await lane.peerStatus())[0].lastError?.code, "drain_busy");
  blocker.close();
  assert.equal((await lane.peerStatus())[0].lastError, null);
  await assert.rejects(
    lane.consumePeerReply({ profileInstanceId: PROFILE_ID, fromEndpointId: SENDER, messageId: "m1" }),
    { code: "reply_not_found" },
  );
});

test("P5: the relay alias is validated with the same combination rules", () => {
  const base = {
    experimentalGate: true,
    engineBinaryPath: "/trusted/peer-engine",
    profile: "p",
    profileInstanceId: PROFILE_ID,
    stateRoot: "/x",
    allowedPeers: [SENDER],
    routes: { [SENDER]: { id: SENDER, addrs: [] } },
    runner: { command: "/trusted/runner", args: [], timeoutMs: 1000 },
    runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: PROFILE_ID },
  };
  assert.throws(() => validatePeerWake({ ...base, relay: "direct-only", relayUrl: "https://relay.example" }), /directOnly and relayUrl/);
  assert.throws(() => validatePeerWake({ ...base, relay: "relay-only", directOnly: true }), /directOnly and relayOnly/);
  assert.throws(() => validatePeerWake({ ...base, relay: "relay_only" }), /peerWake\.relay must be one of/);
  const ok = validatePeerWake({ ...base, relay: "relay-only", relayUrl: "https://relay.example" });
  assert.equal(ok.relayOnly, true);
  assert.equal(ok.directOnly, false);
});

test("P5: the engine manager refuses a conflicting transport and emits relay-only with its URL", async (t) => {
  const root = tempRoot(t);
  assert.throws(
    () => createPeerEngineManager({ stateRoot: path.join(root, "a"), relay: "direct-only", relayUrl: "https://relay.example", logger: quiet }),
    { code: "invalid_transport" },
  );
  let args = null;
  const manager = createPeerEngineManager({
    stateRoot: path.join(root, "b"),
    relay: "relay-only",
    relayUrl: "https://relay.example",
    binaryPath: "/bin/sleep",
    logger: quiet,
    spawnImpl: (_exe, spawnedArgs) => {
      args = spawnedArgs;
      throw Object.assign(new Error("not spawned in this test"), { code: "spawn_failed" });
    },
  });
  await assert.rejects(manager.start(), { code: "spawn_failed" });
  assert.deepEqual(args.slice(2), ["--relay-only", "--relay-url", "https://relay.example"]);
});

test("P6: a request held by crash recovery gets a held outcome", async (t) => {
  const stateRoot = tempRoot(t);
  const item = requestItem("m1");
  const ipc = fakeIpc([item]);
  const runner = { run: async () => ({ status: "completed", text: "ok" }) };
  createPeerDrainService({ stateRoot, profile: "p", profileInstanceId: PROFILE_ID, ipc, runner, routes: routes(), logger: quiet }).close();
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(path.join(stateRoot, "peer-drain.sqlite"));
  db.prepare(
    "INSERT INTO records(sender, message_id, input_hash, phase, request_id, input_payload, created_at, updated_at) VALUES(?, ?, ?, 'executing', ?, ?, 1, 1)",
  ).run(SENDER, item.message_id, item.payload_hash, "req-m1", item.payload);
  db.close();

  const drain = createPeerDrainService({ stateRoot, profile: "p", profileInstanceId: PROFILE_ID, ipc, runner, routes: routes(), logger: quiet });
  t.after(() => drain.close());
  for (let i = 0; i < 4; i++) await drain.step();
  const outcomes = outcomesIn(ipc);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].state, "held");
  assert.equal(outcomes[0].reason, "crash_recovery");
  assert.equal(ipc.inbox.length, 0, "the held item is acked");
});

test("P6: a request interrupted by shutdown gets its held outcome on the next run", async (t) => {
  const stateRoot = tempRoot(t);
  const ipc = fakeIpc([requestItem("m1")]);
  const runner = {
    run: (_request, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
    }),
  };
  const drain = createPeerDrainService({ stateRoot, profile: "p", profileInstanceId: PROFILE_ID, ipc, runner, routes: routes(), logger: quiet });
  t.after(() => drain.close());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(drain.step({ signal: controller.signal }));
  assert.equal(outcomesIn(ipc).length, 0, "the interrupted shutdown sent nothing");
  for (let i = 0; i < 3; i++) await drain.step();
  const outcomes = outcomesIn(ipc);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].state, "held");
});

test("P7: lane.close() releases the drain even while an interrupted runner is still running", async (t) => {
  const stateRoot = tempRoot(t);
  let release;
  const stuck = new Promise((resolve) => { release = resolve; });
  const ipc = fakeIpc([requestItem("m1")]);
  const lane = createPeerLane({
    peerConfigs: [laneConfig(stateRoot, { runnerTimeoutMs: 50 })],
    createPeerEngine: () => readyEngine(ipc),
    createRunner: () => ({ run: async () => { await stuck; return { status: "completed", text: "late" }; } }),
    logger: quiet,
  });
  const [result] = await lane.runOnce();
  assert.equal(result.outcome.state, "held");
  await lane.close();
  const reopened = createPeerDrainService({ stateRoot, profile: "p", profileInstanceId: PROFILE_ID, ipc, runner: { run: async () => ({}) }, routes: routes(), logger: quiet });
  reopened.close();
  release();
});

test("P8: the quickstart names a reachable peer-supervisor entry point and describes acking accurately", () => {
  const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"));
  const quickstart = readFileSync(path.resolve(import.meta.dirname, "../../../docs/triangle-client/quickstart.md"), "utf8");
  // The experimental entry is not part of the package's public exports, so the guide must not promise that import.
  assert.equal(pkg.exports["./peer-supervisor"], undefined);
  assert.doesNotMatch(quickstart, /@the-triangle\/agent-worker\/peer-supervisor/);
  assert.match(quickstart, /packages\/agent-worker\/src\/peer-supervisor\.mjs/);
  assert.ok(existsSync(path.resolve(import.meta.dirname, "../src/peer-supervisor.mjs")));
  assert.doesNotMatch(quickstart, /acknowledged only after deterministic reply admission is verified locally/);
});

test("P9: unfiltered pending replies page with a cursor past the first 200", async (t) => {
  const stateRoot = tempRoot(t);
  const drain = createPeerDrainService({ stateRoot, profile: "p", profileInstanceId: PROFILE_ID, ipc: fakeIpc(), runner: { run: async () => ({}) }, routes: routes(), logger: quiet });
  t.after(() => drain.close());
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(path.join(stateRoot, "peer-drain.sqlite"));
  db.exec("BEGIN");
  for (let i = 0; i < 201; i++) {
    db.prepare(
      "INSERT INTO records(sender, message_id, input_hash, phase, in_reply_to, request_id, reply_payload, created_at, updated_at) VALUES(?, ?, 'h', 'reply_received', ?, ?, ?, ?, ?)",
    ).run(SENDER, `reply-${String(i).padStart(3, "0")}`, `out-${i}`, `req-${i}`, "{}", 1000 + i, 1000 + i);
  }
  db.exec("COMMIT");
  db.close();

  const first = drain.pendingReplies();
  assert.equal(first.length, 200);
  assert.ok(first[199].cursor);
  const second = drain.pendingReplies({ after: first[199].cursor });
  assert.deepEqual(second.map((r) => r.messageId), ["reply-200"]);
  assert.throws(() => drain.pendingReplies({ after: "not-a-cursor" }), { code: "invalid_params" });
});

test("P10: the drain loop fails fast when the engine is not ready, and a missing socket is ipc_unavailable", async (t) => {
  const stateRoot = tempRoot(t);
  const drain = createPeerDrainService({
    stateRoot,
    profile: "p",
    profileInstanceId: PROFILE_ID,
    engineManager: { getIpcClient() { throw Object.assign(new Error("peer-engine is not ready"), { code: "engine_not_ready" }); } },
    runner: { run: async () => ({}) },
    routes: routes(),
    logger: quiet,
  });
  t.after(() => drain.close());
  const started = Date.now();
  await assert.rejects(drain.start({ runLoop: true }), { code: "engine_not_ready" });
  assert.ok(Date.now() - started < 500, "no retry delays before the profile restarts");

  const ipcDir = path.join(stateRoot, "ipc");
  mkdirSync(ipcDir, { mode: 0o700 });
  const client = createIpcClient({ socketPath: path.join(ipcDir, "peer-engine.sock") });
  await assert.rejects(client.request("hello"), { code: "ipc_unavailable" });
});

test("P11: a request held again after an operator retry gets a new outcome message ID", async (t) => {
  const stateRoot = tempRoot(t);
  const ipc = fakeIpc([requestItem("m1")]);
  const drain = createPeerDrainService({
    stateRoot,
    profile: "p",
    profileInstanceId: PROFILE_ID,
    ipc,
    runner: { run: async () => ({ status: "failed" }) },
    routes: routes(),
    logger: quiet,
  });
  t.after(() => drain.close());
  assert.equal((await drain.step()).state, "held");
  drain.resolvePeerRecord({ fromEndpointId: SENDER, messageId: "m1", action: "retry", operationId: "op-1", expectedRevision: 1 });
  assert.equal((await drain.step()).state, "held");
  const ids = outcomesIn(ipc).map((o) => o.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test("P12: a refused message ID cannot be resent more than seven days after first admission", async (t) => {
  const stateRoot = tempRoot(t);
  const day = 24 * 60 * 60 * 1000;
  let clock = 1_000_000;
  let sends = 0;
  const ipc = {
    async request(method, params) {
      if (method === "send") {
        sends++;
        return {};
      }
      if (method === "message_status") {
        const payload = JSON.stringify({ protocol: PEER_ENVELOPE_PROTOCOL, kind: "request", request_id: "req-1", text: "hello" });
        return { message_id: params.message_id, peer_endpoint_id: SENDER, payload_hash: digest(payload), state: "refused", reason: "conflict" };
      }
      throw new Error(`unexpected IPC method ${method}`);
    },
  };
  const drain = createPeerDrainService({ stateRoot, profile: "p", profileInstanceId: PROFILE_ID, ipc, runner: { run: async () => ({}) }, routes: routes(), logger: quiet, now: () => clock });
  t.after(() => drain.close());
  const request = { toEndpointId: SENDER, text: "hello", requestId: "req-1", messageId: "out-1" };
  await assert.rejects(drain.sendRequest(request), { code: "refused" });
  clock += 6 * day;
  await assert.rejects(drain.sendRequest(request), { code: "refused" });
  clock += 2 * day;
  await assert.rejects(drain.sendRequest(request), { code: "retry_window_expired" });
  assert.equal(sends, 2, "the expired resend never reached the engine");
});

test("P13: supervisor runOnce reports a failed peer lane instead of discarding the MESH results", async () => {
  const supervisor = createPeerSupervisor({
    instances: [],
    peerWakes: [{
      experimentalGate: true,
      engineBinaryPath: "/trusted/peer-engine",
      profile: "peer-agent",
      profileInstanceId: PROFILE_ID,
      stateRoot: "/tmp/peer-post-merge-unused",
      allowedPeers: [],
      runner: { command: "/trusted/runner", args: [], timeoutMs: 1_000 },
      runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: PROFILE_ID },
    }],
    createPeerLane: () => ({
      async runOnce() { throw Object.assign(new Error("runOnce cannot run while watch() is active"), { code: "peer_lane_busy" }); },
    }),
  });
  const result = await supervisor.runOnce();
  assert.deepEqual(result.instances, []);
  assert.equal(result.peerInstances.length, 1);
  assert.equal(result.peerInstances[0].failed, true);
  assert.equal(result.peerInstances[0].code, "peer_lane_busy");
});

test("P14: the drain drops its getPendingReplies alias, and the lane uses the real drain loop", async (t) => {
  const stateRoot = tempRoot(t);
  const drain = createPeerDrainService({ stateRoot, profile: "p", profileInstanceId: PROFILE_ID, ipc: fakeIpc(), runner: { run: async () => ({}) }, routes: routes(), logger: quiet });
  assert.equal("getPendingReplies" in drain, false);
  drain.close();

  let steps = 0;
  const lane = createPeerLane({
    peerConfigs: [laneConfig(path.join(stateRoot, "lane"))],
    createPeerEngine: () => readyEngine(fakeIpc()),
    createPeerDrain: () => ({ async step() { steps++; return { state: "idle" }; }, async stop() {}, close() {} }),
    createRunner: () => ({ run: async () => ({}) }),
    logger: quiet,
  });
  const errors = [];
  await lane.watch({
    signal: new AbortController().signal,
    runDurableWakeLoop: async ({ start }) => {
      try {
        return await start();
      } catch (error) {
        errors.push(error);
        return null;
      }
    },
  });
  assert.equal(steps, 0, "no silent fallback to a single step");
  assert.match(String(errors[0]?.message), /start is not a function/);
  await lane.close();
});

test("P15: the schema requires engineBinaryPath and bounds polling and route addresses", () => {
  const base = {
    experimentalGate: true,
    engineBinaryPath: "/trusted/peer-engine",
    profile: "p",
    profileInstanceId: PROFILE_ID,
    stateRoot: "/x",
    allowedPeers: [SENDER],
    routes: { [SENDER]: { id: SENDER, addrs: [{ Ip: "127.0.0.1:1234" }, { Relay: "https://relay.example" }] } },
    runner: { command: "/trusted/runner", args: [], timeoutMs: 1000 },
    runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: PROFILE_ID },
  };
  const { engineBinaryPath: _omitted, ...withoutBinary } = base;
  assert.throws(() => validatePeerWake(withoutBinary), /engineBinaryPath/);
  assert.throws(() => validatePeerWake({ ...base, pollIntervalMs: 1 }), /pollIntervalMs/);
  assert.throws(
    () => validatePeerWake({ ...base, routes: { [SENDER]: { id: SENDER, addrs: ["/ip4/127.0.0.1/udp/1234/quic-v1"] } } }),
    /invalid addrs/,
  );
  const ok = validatePeerWake(base);
  assert.deepEqual(ok.routes.get(SENDER).addrs, [{ Ip: "127.0.0.1:1234" }, { Relay: "https://relay.example" }]);
});
