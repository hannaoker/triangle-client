import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test, { after } from "node:test";

import {
  SUPERVISOR_TUNING_FILE,
  readSupervisorTuning,
  runClientSupervisorCLI,
} from "../src/client-supervisor-cli.mjs";
import { deriveProfileInstanceId } from "../src/codex-runtime/headless-drain-service.mjs";

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

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "triangle-tuning-")));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function writeTuning(root, content, mode = 0o600) {
  const file = path.join(root, SUPERVISOR_TUNING_FILE);
  const bytes = typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content);
  fs.writeFileSync(file, bytes, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function read(root) {
  const stderr = capture();
  const options = readSupervisorTuning({ clientRoot: root, stderr: stderr.stream });
  return { options, stderr: stderr.value() };
}

test("no tuning file means the defaults and no output", async () => {
  const root = tempRoot();
  assert.deepEqual(read(root), { options: {}, stderr: "" });
  assert.deepEqual(read(path.join(root, "missing")), { options: {}, stderr: "" });
  for (const bad of [undefined, null, "", "relative/path", "/with\0nul", 7]) {
    assert.deepEqual(readSupervisorTuning({ clientRoot: bad, stderr: capture().stream }), {});
  }
});

test("an owner tuning file sets the claim safety interval and the watch idle sleep", async () => {
  const root = tempRoot();
  writeTuning(root, { version: 1, claimSafetyPollMs: 600_000, watchIdlePollMs: 90_000 });
  assert.deepEqual(read(root), {
    options: { claimSafetyPollIntervalMs: 600_000, watchIdlePollIntervalMs: 90_000 },
    stderr: "",
  });
  // Either key alone leaves the other at its default.
  writeTuning(root, { version: 1, watchIdlePollMs: 60_000 });
  assert.deepEqual((read(root)).options, { watchIdlePollIntervalMs: 60_000 });
  writeTuning(root, { version: 1, claimSafetyPollMs: 120_000 });
  assert.deepEqual((read(root)).options, { claimSafetyPollIntervalMs: 120_000 });
  writeTuning(root, { version: 1 });
  assert.deepEqual(read(root), { options: {}, stderr: "" });
  // 0 is the owner's switch back to every lane polling on its own timer.
  writeTuning(root, { version: 1, claimSafetyPollMs: 0 });
  assert.deepEqual((read(root)).options, { claimSafetyPollIntervalMs: 0 });
  // Bounds are inclusive.
  writeTuning(root, { version: 1, claimSafetyPollMs: 30_000, watchIdlePollMs: 10_000 });
  assert.deepEqual((read(root)).options, { claimSafetyPollIntervalMs: 30_000, watchIdlePollIntervalMs: 10_000 });
  writeTuning(root, { version: 1, claimSafetyPollMs: 3_600_000, watchIdlePollMs: 600_000 });
  assert.deepEqual((read(root)).options, { claimSafetyPollIntervalMs: 3_600_000, watchIdlePollIntervalMs: 600_000 });
  // Mode 0644 is fine: the file is configuration, only writers matter.
  writeTuning(root, { version: 1, watchIdlePollMs: 45_000 }, 0o644);
  assert.deepEqual((read(root)).options, { watchIdlePollIntervalMs: 45_000 });
  writeTuning(root, { version: 1, watchIdlePollMs: 45_000 }, 0o400);
  assert.deepEqual((read(root)).options, { watchIdlePollIntervalMs: 45_000 });
});

test("a malformed or out-of-range tuning file is ignored as a whole, with a fixed message", async () => {
  const cases = [
    ["not json", "this is not json"],
    ["empty", ""],
    ["array", "[]"],
    ["null", "null"],
    ["missing version", { claimSafetyPollMs: 600_000 }],
    ["wrong version", { version: 2, claimSafetyPollMs: 600_000 }],
    ["version as string", { version: "1", claimSafetyPollMs: 600_000 }],
    ["unknown key", { version: 1, claimSafetyPollMs: 600_000, pollMs: 5 }],
    ["duplicate key", '{"version":1,"claimSafetyPollMs":600000,"claimSafetyPollMs":120000}'],
    ["claim too small", { version: 1, claimSafetyPollMs: 29_999 }],
    ["claim too large", { version: 1, claimSafetyPollMs: 3_600_001 }],
    ["claim fractional", { version: 1, claimSafetyPollMs: 60_000.5 }],
    ["claim negative", { version: 1, claimSafetyPollMs: -1 }],
    ["claim string", { version: 1, claimSafetyPollMs: "600000" }],
    ["claim null", { version: 1, claimSafetyPollMs: null }],
    ["claim bool", { version: 1, claimSafetyPollMs: true }],
    ["watch too small", { version: 1, watchIdlePollMs: 9_999 }],
    ["watch zero", { version: 1, watchIdlePollMs: 0 }],
    ["watch too large", { version: 1, watchIdlePollMs: 600_001 }],
    ["watch string", { version: 1, watchIdlePollMs: "30000" }],
    // A good key beside a bad one must not be half applied.
    ["one good one bad", { version: 1, claimSafetyPollMs: 600_000, watchIdlePollMs: 1 }],
    ["invalid utf-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
  ];
  for (const [name, content] of cases) {
    const root = tempRoot();
    writeTuning(root, content);
    const { options, stderr } = read(root);
    assert.deepEqual(options, {}, name);
    assert.equal(stderr, "triangle-client: supervisor tuning ignored (invalid)\n", name);
  }
});

test("an unsafe tuning file is ignored", async () => {
  // Writable by group or others: anyone could retime the supervisor.
  for (const mode of [0o666, 0o664, 0o662, 0o622, 0o620, 0o602]) {
    const root = tempRoot();
    writeTuning(root, { version: 1, claimSafetyPollMs: 600_000 }, mode);
    assert.deepEqual(read(root), { options: {}, stderr: "triangle-client: supervisor tuning ignored (unsafe_file)\n" }, mode.toString(8));
  }
  // Oversized.
  {
    const root = tempRoot();
    writeTuning(root, JSON.stringify({ version: 1, claimSafetyPollMs: 600_000 }) + " ".repeat(2_000));
    assert.deepEqual(read(root), { options: {}, stderr: "triangle-client: supervisor tuning ignored (unsafe_file)\n" });
  }
  // A second hard link (e.g. one inside a model-writable root).
  {
    const root = tempRoot();
    const file = writeTuning(root, { version: 1, claimSafetyPollMs: 600_000 });
    fs.linkSync(file, path.join(root, "second-link"));
    assert.deepEqual(read(root), { options: {}, stderr: "triangle-client: supervisor tuning ignored (unsafe_file)\n" });
  }
  // A symlink is never followed, even to a perfectly good file.
  {
    const root = tempRoot();
    const target = path.join(root, "target.json");
    fs.writeFileSync(target, JSON.stringify({ version: 1, claimSafetyPollMs: 600_000 }), { mode: 0o600 });
    fs.symlinkSync(target, path.join(root, SUPERVISOR_TUNING_FILE));
    assert.deepEqual(read(root), { options: {}, stderr: "triangle-client: supervisor tuning ignored (unreadable)\n" });
  }
  // A directory in its place.
  {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, SUPERVISOR_TUNING_FILE), { mode: 0o700 });
    const { options, stderr } = read(root);
    assert.deepEqual(options, {});
    assert.match(stderr, /^triangle-client: supervisor tuning ignored \((unsafe_file|unreadable|invalid)\)\n$/);
  }
});

test("the ignore message never echoes the file", async () => {
  const root = tempRoot();
  writeTuning(root, { version: 1, claimSafetyPollMs: 31337, watchIdlePollMs: 4242, secret: "mesh_do_not_print" });
  const { stderr } = read(root);
  assert.doesNotMatch(stderr, /31337|4242|mesh_|secret/);
});

// --- the supervisor CLI applies it ---

function layout() {
  const root = tempRoot();
  const client = path.join(root, "client");
  fs.mkdirSync(client, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "bin"), { mode: 0o700 });
  const helperPath = path.join(root, "bin", "triangle-mailbox");
  const profile = "codex-bob-test";
  const wake = {
    profile,
    profileInstanceId: deriveProfileInstanceId(profile),
    helperPath,
    workingDirectory: "/srv/triangle-work",
    codexHome: "/private/codex-home",
    stateRoot: "/private/headless-state",
    command: "/trusted/bin/codex",
    pollIntervalMs: 30_000,
    agentId: "agent_headless_codex_001",
    installationId: "inst_N7VhDq3mQ2",
  };
  return { client, bootstrap: { version: 1, maxConcurrentReasoners: 2, instances: [], headlessWakes: [wake] } };
}

async function runCli(bootstrap) {
  let received;
  const stderr = capture();
  const code = await runClientSupervisorCLI({
    input: Readable.from([JSON.stringify(bootstrap)]),
    stderr: stderr.stream,
    processEvents: new EventEmitter(),
    createProgressJournal: () => null,
    createSupervisor(options) {
      received = options;
      return { async watch() { return { instances: [], headlessWakes: [] }; } };
    },
  });
  return { code, received, stderr: stderr.value() };
}

test("the supervisor CLI passes the owner's cadence to the supervisor", async () => {
  const { client, bootstrap } = layout();
  writeTuning(client, { version: 1, claimSafetyPollMs: 600_000, watchIdlePollMs: 90_000 });
  const { code, received, stderr } = await runCli(bootstrap);
  assert.equal(code, 0);
  assert.equal(received.claimSafetyPollIntervalMs, 600_000);
  assert.equal(received.watchIdlePollIntervalMs, 90_000);
  assert.equal(stderr, "");
  // The bootstrap still decides everything else.
  assert.equal(received.useInstallWatchDispatcher, true);
  assert.equal(received.headlessWakes.length, 1);
});

test("without a tuning file the supervisor gets no cadence options and uses its defaults", async () => {
  const { bootstrap } = layout();
  const { code, received, stderr } = await runCli(bootstrap);
  assert.equal(code, 0);
  assert.equal(Object.hasOwn(received, "claimSafetyPollIntervalMs"), false);
  assert.equal(Object.hasOwn(received, "watchIdlePollIntervalMs"), false);
  assert.equal(stderr, "");
});

test("a bad tuning file never stops the supervisor", async () => {
  const { client, bootstrap } = layout();
  writeTuning(client, { version: 1, claimSafetyPollMs: 5, watchIdlePollMs: 90_000 });
  const { code, received, stderr } = await runCli(bootstrap);
  assert.equal(code, 0, "the supervisor still starts");
  assert.equal(Object.hasOwn(received, "claimSafetyPollIntervalMs"), false);
  assert.equal(Object.hasOwn(received, "watchIdlePollIntervalMs"), false, "nothing is half applied");
  assert.equal(stderr, "triangle-client: supervisor tuning ignored (invalid)\n");
});
