import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseClientSupervisorBootstrap,
  runClientSupervisorCLI,
} from "../src/client-supervisor-cli.mjs";

const instanceId = (digit) => digit.repeat(64);

function instance(digit = "a") {
  const id = instanceId(digit);
  return {
    instanceId: id,
    mailbox: {
      meshUrl: "https://mesh.example",
      meshToken: `mesh_${digit.repeat(64)}`,
      recipientId: `agent_${digit.repeat(32)}`,
      pageLimit: 10,
    },
    runner: {
      command: "/trusted/bin/node",
      args: ["/trusted/adapter.mjs"],
      timeoutMs: 600_000,
    },
    runnerEnvironment: {
      TRIANGLE_INSTANCE_ID: id,
      TRIANGLE_PROJECT_ROOT: "/trusted/release",
      CODEX_CLI: "/trusted/bin/codex",
      CODEX_HOME: `/private/model-state/${id}`,
    },
  };
}

function bootstrap(overrides = {}) {
  return {
    version: 1,
    maxConcurrentReasoners: 2,
    instances: [instance()],
    ...overrides,
  };
}

function capture() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    value: () => value,
  };
}

function eventWake(overrides = {}) {
  return {
    installationId: "inst_N7VhDq3mQ2",
    helperPath: "/trusted/triangle-mailbox",
    cursorPath: "/private/client/wake-cursor.json",
    actorProfile: "event-hermes",
    ensureBeforeWatch: true,
    profiles: [{ instanceId: instanceId("e"), agentId: "agent_event_hermes" }],
    ...overrides,
  };
}

test("version-1 bootstrap accepts only the bounded exact schema", () => {
  const parsed = parseClientSupervisorBootstrap(JSON.stringify(bootstrap()));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.maxConcurrentReasoners, 2);
  assert.deepEqual(parsed.instances, [instance()]);

  for (const candidate of [
    { ...bootstrap(), version: 2 },
    { ...bootstrap(), maxConcurrentReasoners: 0 },
    { ...bootstrap(), maxConcurrentReasoners: 17 },
    { ...bootstrap(), unexpected: true },
    { ...bootstrap(), profile: "must-not-exist" },
    { ...bootstrap(), instances: [] },
    { ...bootstrap(), instances: Array.from({ length: 101 }, () => instance()) },
    { ...bootstrap(), instances: [{ ...instance(), adapterId: "codex" }] },
    { ...bootstrap(), instances: [{ ...instance(), mailbox: { ...instance().mailbox, extra: true } }] },
    { ...bootstrap(), instances: [{ ...instance(), runner: { ...instance().runner, extra: true } }] },
    { ...bootstrap(), instances: [{ ...instance(), runnerEnvironment: { ...instance().runnerEnvironment, MESH_AGENT_TOKEN: "leak" } }] },
  ]) {
    assert.throws(
      () => parseClientSupervisorBootstrap(JSON.stringify(candidate)),
      /Invalid Triangle Client bootstrap/,
    );
  }
});

test("bootstrap accepts eventWake beside worker instances and rejects unsafe wake payloads", () => {
  const withWake = bootstrap({ eventWake: eventWake() });
  const parsed = parseClientSupervisorBootstrap(JSON.stringify(withWake));
  assert.deepEqual(parsed.eventWake, eventWake());
  assert.equal(parsed.instances.length, 1);

  const wakeOnly = {
    version: 1,
    maxConcurrentReasoners: 2,
    instances: [],
    eventWake: eventWake(),
  };
  assert.deepEqual(
    parseClientSupervisorBootstrap(JSON.stringify(wakeOnly)).eventWake.profiles[0].instanceId,
    instanceId("e"),
  );

  for (const candidate of [
    bootstrap({ eventWake: { ...eventWake(), extra: true } }),
    bootstrap({ eventWake: { ...eventWake(), installationId: "inst_short" } }),
    bootstrap({ eventWake: { ...eventWake(), helperPath: "relative/triangle-mailbox" } }),
    bootstrap({ eventWake: { ...eventWake(), ensureBeforeWatch: "yes" } }),
    bootstrap({ eventWake: { ...eventWake(), profiles: [] } }),
    bootstrap({
      eventWake: {
        ...eventWake(),
        profiles: [{ instanceId: instance().instanceId, agentId: "agent_collision" }],
      },
    }),
    bootstrap({
      eventWake: {
        ...eventWake(),
        profiles: [{ instanceId: instanceId("e"), agentId: "agent_event_hermes", mailboxToken: "mesh_x" }],
      },
    }),
  ]) {
    assert.throws(
      () => parseClientSupervisorBootstrap(JSON.stringify(candidate)),
      /Invalid Triangle Client bootstrap/,
    );
  }
});

test("CLI forwards eventWake into supervisor creation", async () => {
  let received;
  const stderr = capture();
  const result = await runClientSupervisorCLI({
    argv: [],
    input: Readable.from([JSON.stringify(bootstrap({ eventWake: eventWake() }))]),
    stderr: stderr.stream,
    processEvents: new EventEmitter(),
    createSupervisor(options) {
      received = options;
      return { async watch() { return { instances: [], eventWake: null }; } };
    },
  });
  assert.equal(result, 0);
  assert.deepEqual(received.eventWake, eventWake());
  assert.equal(stderr.value(), "");
});

test("bootstrap applies canonical mailbox semantics and bounded Node timer values before supervisor creation", async () => {
  for (const timeoutMs of [1, 2_147_483_647]) {
    const candidate = instance();
    candidate.runner.timeoutMs = timeoutMs;
    assert.equal(
      parseClientSupervisorBootstrap(JSON.stringify(bootstrap({ instances: [candidate] }))).instances[0].runner.timeoutMs,
      timeoutMs,
    );
  }
  const local = instance();
  local.mailbox.meshUrl = "http://127.0.0.1:8787";
  assert.equal(
    parseClientSupervisorBootstrap(JSON.stringify(bootstrap({ instances: [local] }))).instances[0].mailbox.meshUrl,
    "http://127.0.0.1:8787",
  );

  const invalid = [
    { ...instance().mailbox, meshUrl: "http://mesh.example" },
    { ...instance().mailbox, meshUrl: "https://mesh.example/path" },
    { ...instance().mailbox, recipientId: "agent_not-canonical" },
    { ...instance().mailbox, meshToken: " " },
    { ...instance().mailbox, pageLimit: 0 },
    { ...instance().mailbox, pageLimit: 101 },
  ];
  for (const mailbox of invalid) {
    const candidate = instance();
    candidate.mailbox = mailbox;
    assert.throws(
      () => parseClientSupervisorBootstrap(JSON.stringify(bootstrap({ instances: [candidate] }))),
      /Invalid Triangle Client bootstrap/,
    );
  }
  for (const timeoutMs of [0, 2_147_483_648]) {
    const candidate = instance();
    candidate.runner.timeoutMs = timeoutMs;
    assert.throws(
      () => parseClientSupervisorBootstrap(JSON.stringify(bootstrap({ instances: [candidate] }))),
      /Invalid Triangle Client bootstrap/,
    );
  }

  const rejected = capture();
  const candidate = instance();
  candidate.mailbox.meshUrl = "http://public.example";
  assert.equal(await runClientSupervisorCLI({
    argv: [],
    input: Readable.from([JSON.stringify(bootstrap({ instances: [candidate] }))]),
    stderr: rejected.stream,
    processEvents: new EventEmitter(),
    createSupervisor() { throw new Error("semantic validation happened too late"); },
  }), 64);
  assert.equal(rejected.value(), "triangle-client: invalid bootstrap\n");
});

test("bootstrap rejects duplicate JSON keys at every level and duplicate instances", () => {
  const valid = JSON.stringify(bootstrap());
  const duplicateTop = valid.replace('{"version":1', '{"version":1,"version":1');
  const duplicateMailbox = valid.replace('{"meshUrl":', '{"meshUrl":"https://decoy.invalid","meshUrl":');
  const duplicateEnvironment = valid.replace('{"TRIANGLE_INSTANCE_ID":', '{"TRIANGLE_INSTANCE_ID":"' + instanceId("b") + '","TRIANGLE_INSTANCE_ID":');
  for (const raw of [duplicateTop, duplicateMailbox, duplicateEnvironment]) {
    assert.throws(() => parseClientSupervisorBootstrap(raw), /Invalid Triangle Client bootstrap/);
  }
  assert.throws(
    () => parseClientSupervisorBootstrap(JSON.stringify(bootstrap({ instances: [instance(), instance()] }))),
    /Invalid Triangle Client bootstrap/,
  );
});

test("bootstrap rejects every mailbox token reflected outside its exact mailbox field", () => {
  const first = instance("a");
  const second = instance("b");
  const secret = first.mailbox.meshToken;
  const candidates = [
    [{ ...first, runner: { ...first.runner, command: `/trusted/${secret}/node` } }],
    [{ ...first, runner: { ...first.runner, args: [`prefix-${secret}-suffix`] } }],
    [{ ...first, runnerEnvironment: { ...first.runnerEnvironment, CODEX_HOME: `/private/${secret}/home` } }],
    [first, { ...second, runner: { ...second.runner, args: [first.mailbox.meshToken] } }],
    [first, { ...second, mailbox: { ...second.mailbox, meshToken: first.mailbox.meshToken } }],
  ];
  for (const instances of candidates) {
    let error;
    try { parseClientSupervisorBootstrap(JSON.stringify(bootstrap({ instances }))); }
    catch (caught) { error = caught; }
    assert.match(String(error), /Invalid Triangle Client bootstrap/);
    assert.doesNotMatch(String(error), new RegExp(secret));
  }

  const reflected = bootstrap({
    instances: [{ ...first, runner: { ...first.runner, args: [`prefix-${secret}-suffix`] } }],
  });
  const raw = JSON.stringify(reflected);
  const secondOccurrence = raw.indexOf(secret, raw.indexOf(secret) + secret.length);
  assert.notEqual(secondOccurrence, -1);
  const escapedSecret = `\\u006desh_${"a".repeat(64)}`;
  const escaped = raw.slice(0, secondOccurrence) + escapedSecret + raw.slice(secondOccurrence + secret.length);
  assert.throws(
    () => parseClientSupervisorBootstrap(escaped),
    /Invalid Triangle Client bootstrap/,
  );
});

test("bootstrap is read only from bounded stdin and never echoed or sourced from argv or environment", async () => {
  const secret = instance().mailbox.meshToken;
  const stderr = capture();
  let received;
  const result = await runClientSupervisorCLI({
    argv: [],
    input: Readable.from([JSON.stringify(bootstrap())]),
    stderr: stderr.stream,
    environment: { MESH_AGENT_TOKEN: "ambient-secret" },
    processEvents: new EventEmitter(),
    createSupervisor(options) {
      received = options;
      return { async watch() { return { instances: [] }; } };
    },
  });
  assert.equal(result, 0);
  assert.equal(received.version, undefined);
  assert.equal(received.instances[0].mailbox.meshToken, secret);
  assert.equal(stderr.value(), "");

  for (const argv of [["--profile", "research"], [secret], ["--config", "/tmp/bootstrap.json"]]) {
    const rejected = capture();
    assert.equal(await runClientSupervisorCLI({
      argv,
      input: Readable.from([JSON.stringify(bootstrap())]),
      stderr: rejected.stream,
      environment: { MESH_AGENT_TOKEN: secret },
      processEvents: new EventEmitter(),
      createSupervisor() { throw new Error("must not run"); },
    }), 64);
    assert.equal(rejected.value(), "triangle-client: invalid invocation\n");
    assert.doesNotMatch(rejected.value(), new RegExp(secret));
  }

  const oversized = capture();
  assert.equal(await runClientSupervisorCLI({
    argv: [],
    input: Readable.from([" ".repeat((1024 * 1024) + 1)]),
    stderr: oversized.stream,
    processEvents: new EventEmitter(),
    createSupervisor() { throw new Error("must not run"); },
  }), 64);
  assert.equal(oversized.value(), "triangle-client: invalid bootstrap\n");

  const malformedDocument = Buffer.from(JSON.stringify(bootstrap()));
  malformedDocument[malformedDocument.indexOf(Buffer.from(instance().mailbox.meshToken)) + 8] = 0xff;
  const malformed = capture();
  let created = false;
  assert.equal(await runClientSupervisorCLI({
    argv: [],
    input: Readable.from([malformedDocument]),
    stderr: malformed.stream,
    processEvents: new EventEmitter(),
    createSupervisor() { created = true; throw new Error("must not run"); },
  }), 64);
  assert.equal(created, false);
  assert.equal(malformed.value(), "triangle-client: invalid bootstrap\n");
});

test("runtime errors are sanitized and SIGINT or SIGTERM aborts with deterministic success", async () => {
  const secret = instance().mailbox.meshToken;
  const failed = capture();
  assert.equal(await runClientSupervisorCLI({
    argv: [],
    input: Readable.from([JSON.stringify(bootstrap())]),
    stderr: failed.stream,
    processEvents: new EventEmitter(),
    createSupervisor() {
      return { async watch() { throw new Error(`failure with ${secret}`); } };
    },
  }), 70);
  assert.equal(failed.value(), "triangle-client: supervisor failed\n");
  assert.doesNotMatch(failed.value(), new RegExp(secret));

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const events = new EventEmitter();
    let sawAbort = false;
    const running = runClientSupervisorCLI({
      argv: [],
      input: Readable.from([JSON.stringify(bootstrap())]),
      stderr: capture().stream,
      processEvents: events,
      createSupervisor() {
        return {
          watch({ signal: abortSignal }) {
            return new Promise((resolve) => {
              abortSignal.addEventListener("abort", () => {
                sawAbort = true;
                resolve({ instances: [] });
              }, { once: true });
            });
          },
        };
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    events.emit(signal);
    assert.equal(await running, 0);
    assert.equal(sawAbort, true);
    assert.equal(events.listenerCount("SIGINT"), 0);
    assert.equal(events.listenerCount("SIGTERM"), 0);
  }
});

test("the executable terminates cleanly on SIGTERM even while its private stdin pipe is open", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/client-supervisor-cli.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: {},
  });
  child.stdin.end(JSON.stringify({ version: 1, maxConcurrentReasoners: 1, instances: [instance("a")] }));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("supervisor CLI did not signal readiness")), 1_000);
      child.once("message", (message) => {
        clearTimeout(timeout);
        if (message?.type === "triangle-client-supervisor-ready") resolve();
        else reject(new Error("supervisor CLI sent an invalid readiness signal"));
      });
    });
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 1_000);
  const [code, signal] = await exited;
  clearTimeout(forced);
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("readiness is acknowledged only after bootstrap validation and supervisor construction", async () => {
  let notifications = 0;
  let constructions = 0;
  const invalid = await runClientSupervisorCLI({
    argv: [],
    input: Readable.from(["{}"]),
    stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    processEvents: new EventEmitter(),
    createSupervisor() { constructions += 1; throw new Error("must not construct"); },
    notifyReady() { notifications += 1; },
  });
  assert.equal(invalid, 64);
  assert.equal(constructions, 0);
  assert.equal(notifications, 0);
});

test("mailbox polling remains gated until the matching private activation arrives", async () => {
  const events = [];
  const result = await runClientSupervisorCLI({
    argv: [],
    input: Readable.from([JSON.stringify(bootstrap())]),
    stderr: capture().stream,
    processEvents: new EventEmitter(),
    createSupervisor() {
      return { async watch() { events.push("watch"); } };
    },
    notifyReady(message) { events.push(`ready:${message.generation}`); },
    async awaitActivation({ generation, parentPid, configDigest }) {
      assert.match(generation, /^[0-9a-f-]{36}$/);
      assert.equal(parentPid, process.ppid);
      assert.match(configDigest, /^[0-9a-f]{64}$/);
      events.push(`activate:${generation}`);
    },
  });
  assert.equal(result, 0);
  assert.equal(events.length, 3);
  assert.match(events[0], /^ready:/);
  assert.equal(events[1], events[0].replace("ready:", "activate:"));
  assert.equal(events[2], "watch");
});
