// L1f: Cursor ACP and worker drains record claim/reply/ack progress evidence in
// client/headless-progress.json so the doctor inventory (PR #82) can classify
// them ok instead of degraded/progress_evidence_unavailable.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { realpathSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  HEADLESS_PROGRESS_FILE,
  createClientSupervisor,
  createHeadlessProgressJournal,
  defaultHeadlessProgressClientRoot,
} from "../src/client-supervisor.mjs";
import { resolveProgressClientRoot } from "../src/client-supervisor-cli.mjs";
import { instrumentCursorAcpProgress } from "../src/cursor-acp-runtime/headless-drain-service.mjs";
import { createHeadlessCursorAcpDrain } from "../src/cursor-acp-runtime/headless-drain.mjs";

const SENTINEL_TOKEN = "mesh_SENTINEL_TOKEN_must_never_be_journaled_0123456789";
const SENTINEL_BODY = "SENTINEL BODY must never be journaled";

function instanceIdFor(profile) {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from("triangle-client-instance-v1"), Buffer.from([0]), Buffer.from(profile)]))
    .digest("hex");
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function tempClientRoot() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "l1f-progress-"));
  const app = path.join(root, "The Triangle");
  const client = path.join(app, "client");
  mkdirSync(client, { recursive: true, mode: 0o700 });
  return { root, app, client, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Hold the journal's kernel lock on a separate open file description. */
function holdLock(lockPath) {
  return fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | 0x20, 0o600);
}

/** True when some other open file description holds the exclusive lock. */
function heldByOther(lockPath) {
  if (!existsSync(lockPath)) return false;
  try {
    fs.closeSync(fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | 0x10));
    return false;
  } catch (error) {
    if (error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK") return true;
    throw error;
  }
}

function progressPause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function clock(start = Date.parse("2026-10-17T20:00:00.000Z")) {
  let current = start;
  return { now: () => current, advance(ms) { current += ms; } };
}

function registryRow(client, profile, runtimeAdapter, deliveryMode) {
  const instanceId = instanceIdFor(profile);
  writeJson(path.join(client, "instances", `${instanceId}.json`), {
    version: 1, instanceId, profile, runtimeAdapter, deliveryMode, enabled: true,
  });
  return instanceId;
}

test("journal writes claim/reply/ack per profile atomically with the doctor schema", () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const time = clock();
    const journal = createHeadlessProgressJournal({ clientRoot: client, now: time.now });
    const ghost = journal.forProfile("ghost", "cursor-acp");
    assert.equal(ghost.record("claim"), true);
    time.advance(1_000);
    assert.equal(ghost.record("reply"), true);
    time.advance(1_000);
    assert.equal(ghost.record("ack"), true);
    time.advance(1_000);
    assert.equal(journal.forProfile("gravity2", "worker").record("claim"), true);

    const filePath = path.join(client, HEADLESS_PROGRESS_FILE);
    assert.equal(journal.path, filePath);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    const doc = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(doc.version, 1);
    assert.equal(doc.updatedAt, "2026-10-17T20:00:03.000Z");
    assert.deepEqual(doc.profiles.ghost, {
      lane: "cursor-acp",
      lastClaimAt: "2026-10-17T20:00:00.000Z",
      updatedAt: "2026-10-17T20:00:02.000Z",
      lastReplyAt: "2026-10-17T20:00:01.000Z",
      lastAckAt: "2026-10-17T20:00:02.000Z",
    });
    assert.deepEqual(doc.profiles.gravity2, {
      lane: "worker",
      lastClaimAt: "2026-10-17T20:00:03.000Z",
      updatedAt: "2026-10-17T20:00:03.000Z",
    });
    // No temp files left behind; the lock file is permanent (0600) and unheld.
    assert.deepEqual(readdirSync(client).sort(), [HEADLESS_PROGRESS_FILE, `${HEADLESS_PROGRESS_FILE}.lock`]);
    assert.equal(statSync(`${filePath}.lock`).mode & 0o777, 0o600);
    assert.equal(heldByOther(`${filePath}.lock`), false);
  } finally {
    cleanup();
  }
});

test("journal is monotonic, preserves foreign keys, and replaces a corrupt file", () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const filePath = path.join(client, HEADLESS_PROGRESS_FILE);
    writeJson(filePath, {
      version: 1,
      watch: { connection: "connected", grantHealth: "ok" },
      profiles: { bob: { lastAcceptedKickAt: "2026-10-17T19:00:00.000Z" }, ghost: { lastClaimAt: "2026-10-17T21:00:00.000Z" } },
    });
    const time = clock();
    const journal = createHeadlessProgressJournal({ clientRoot: client, now: time.now });
    assert.equal(journal.record({ profile: "ghost", lane: "cursor-acp", phase: "claim" }), true);
    const doc = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(doc.profiles.ghost.lastClaimAt, "2026-10-17T21:00:00.000Z", "older stamp never overwrites newer");
    assert.deepEqual(doc.profiles.bob, { lastAcceptedKickAt: "2026-10-17T19:00:00.000Z" });
    assert.deepEqual(doc.watch, { connection: "connected", grantHealth: "ok" });

    writeFileSync(filePath, "{not json");
    assert.equal(journal.record({ profile: "ghost", lane: "cursor-acp", phase: "ack" }), true);
    const repaired = JSON.parse(readFileSync(filePath, "utf8"));
    assert.deepEqual(Object.keys(repaired.profiles), ["ghost"]);
    assert.equal(repaired.profiles.ghost.lastAckAt, "2026-10-17T20:00:00.000Z");
  } finally {
    cleanup();
  }
});

test("journal is best-effort: invalid input or unwritable root returns false and never throws", () => {
  const { root, client, cleanup } = tempClientRoot();
  try {
    const errors = [];
    const logger = { error: (event, detail) => errors.push({ event, detail }) };
    const journal = createHeadlessProgressJournal({ clientRoot: client, logger });
    assert.equal(journal.record({ profile: "../etc", lane: "worker", phase: "claim" }), false);
    assert.equal(journal.record({ profile: "ghost", lane: "nope", phase: "claim" }), false);
    assert.equal(journal.record({ profile: "ghost", lane: "worker", phase: "toString" }), false);
    assert.throws(() => journal.forProfile("bad/profile", "worker"), /profile is invalid/);
    assert.throws(() => createHeadlessProgressJournal({ clientRoot: "relative" }), /absolute/);

    // clientRoot whose parent is a regular file cannot be created.
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "x");
    const broken = createHeadlessProgressJournal({ clientRoot: path.join(blocker, "client"), logger });
    assert.equal(broken.record({ profile: "ghost", lane: "cursor-acp", phase: "claim" }), false);
    assert.ok(errors.length >= 4);
    for (const { event, detail } of errors) {
      assert.equal(event, "triangle_client_progress_journal_write_failed");
      assert.deepEqual(Object.keys(detail), ["code"]);
    }
  } finally {
    cleanup();
  }
});

test("a held kernel lock makes a writer skip (never unlocked); a leftover lock file never blocks", () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const filePath = path.join(client, HEADLESS_PROGRESS_FILE);
    const lockPath = `${filePath}.lock`;
    // Leftover lock file from a crashed writer, however old: not a held lock.
    writeFileSync(lockPath, "999999:leftover");
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(lockPath, old, old);
    const journal = createHeadlessProgressJournal({ clientRoot: client, lockWaitMs: 20 });
    assert.equal(journal.record({ profile: "ghost", lane: "cursor-acp", phase: "claim" }), true);
    assert.equal(heldByOther(lockPath), false, "our lock is released after the write");

    const before = readFileSync(filePath, "utf8");
    const held = holdLock(lockPath);
    try {
      const logged = [];
      const blocked = createHeadlessProgressJournal({
        clientRoot: client, lockWaitMs: 20, logger: { error: (event, fields) => logged.push({ event, fields }) },
      });
      assert.equal(blocked.record({ profile: "ghost", lane: "cursor-acp", phase: "reply" }), false);
      assert.equal(readFileSync(filePath, "utf8"), before, "no unlocked read-modify-write");
      assert.equal(JSON.parse(before).profiles.ghost.lastReplyAt, undefined);
      assert.deepEqual(logged, [{ event: "triangle_client_progress_journal_write_failed", fields: { code: "progress_journal_lock_unavailable" } }]);
    } finally {
      fs.closeSync(held);
    }
    assert.equal(existsSync(lockPath), true, "the lock file is permanent; only the kernel lock comes and goes");
    assert.deepEqual(readdirSync(client).filter((n) => n.endsWith(".tmp")), [], "no temp files left behind");
  } finally {
    cleanup();
  }
});

test("non-macOS platforms fail closed instead of writing unlocked", () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const logged = [];
    const journal = createHeadlessProgressJournal({ clientRoot: client, platform: "linux", logger: { error: (_e, f) => logged.push(f.code) } });
    assert.equal(journal.record({ profile: "ghost", lane: "cursor-acp", phase: "claim" }), false);
    assert.deepEqual(logged, ["progress_journal_lock_unsupported_platform"]);
    assert.equal(existsSync(path.join(client, HEADLESS_PROGRESS_FILE)), false);
  } finally {
    cleanup();
  }
});

const SUPERVISOR_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "client-supervisor.mjs"),
).href;

function childRecordSource(client, profile, count = 1) {
  return `import {createHeadlessProgressJournal} from ${JSON.stringify(SUPERVISOR_URL)};
const j = createHeadlessProgressJournal({clientRoot: ${JSON.stringify(client)}});
const out = [];
for (let i = 0; i < ${count}; i += 1) out.push(j.record({profile: ${JSON.stringify(profile)}, lane: "worker", phase: "claim"}));
console.log(JSON.stringify(out));`;
}

test("two-process contention: a writer that cannot lock returns false and cannot erase or be erased (review F5 repro)", async () => {
  const { client, cleanup } = tempClientRoot();
  const filePath = path.join(client, HEADLESS_PROGRESS_FILE);
  const realRename = fs.renameSync;
  let child = null;
  try {
    // Writer A (this process) is suspended at its document rename while it
    // still owns the lock; writer B (a real child process, default lock wait)
    // runs to completion in that window.
    fs.renameSync = (src, dst) => {
      if (dst === filePath && child == null) {
        child = spawnSync(process.execPath, ["--input-type=module", "-e", childRecordSource(client, "bob")], { encoding: "utf8" });
      }
      return realRename(src, dst);
    };
    syncBuiltinESMExports();
    const journal = createHeadlessProgressJournal({ clientRoot: client });
    const aResult = journal.record({ profile: "alice", lane: "worker", phase: "claim" });
    fs.renameSync = realRename;
    syncBuiltinESMExports();

    assert.equal(child.status, 0, child.stderr);
    const [bResult] = JSON.parse(child.stdout.trim());
    const final = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(aResult, true);
    assert.equal(bResult, false, "B must not report success for an unlocked write");
    // Invariant: every writer that reported success is in the final document.
    for (const [profile, ok] of [["alice", aResult], ["bob", bResult]]) {
      if (ok) assert.ok(Object.hasOwn(final.profiles, profile), `${profile} succeeded but was erased`);
    }
    assert.equal(Object.hasOwn(final.profiles, "bob"), false);

    // After A releases, B's retry succeeds and preserves A.
    const retry = spawnSync(process.execPath, ["--input-type=module", "-e", childRecordSource(client, "bob")], { encoding: "utf8" });
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(JSON.parse(retry.stdout.trim()), [true]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(filePath, "utf8")).profiles).sort(), ["alice", "bob"]);
    assert.equal(heldByOther(`${filePath}.lock`), false);
  } finally {
    fs.renameSync = realRename;
    syncBuiltinESMExports();
    cleanup();
  }
});

test("concurrent real processes: no successful write is ever lost", async () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const profiles = ["p0", "p1", "p2", "p3", "p4", "p5"];
    const runs = await Promise.all(profiles.map((profile) => new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ["--input-type=module", "-e", childRecordSource(client, profile, 15)], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      proc.stdout.on("data", (chunk) => { out += chunk; });
      proc.stderr.on("data", (chunk) => { err += chunk; });
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve({ profile, results: JSON.parse(out.trim()) }) : reject(new Error(err))));
    })));
    const final = JSON.parse(readFileSync(path.join(client, HEADLESS_PROGRESS_FILE), "utf8"));
    let successes = 0;
    for (const { profile, results } of runs) {
      if (results.some(Boolean)) {
        successes += 1;
        assert.ok(Object.hasOwn(final.profiles, profile), `${profile} reported success but is missing`);
      }
    }
    assert.ok(successes > 0);
    assert.equal(heldByOther(path.join(client, `${HEADLESS_PROGRESS_FILE}.lock`)), false);
    assert.deepEqual(readdirSync(client).filter((n) => n.endsWith(".tmp") || n.endsWith(".stale")), []);
  } finally {
    cleanup();
  }
});

test("a crashed lock owner is released by the kernel, so the next writer proceeds (Codex review r2)", async () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const filePath = path.join(client, HEADLESS_PROGRESS_FILE);
    const lockPath = `${filePath}.lock`;
    const source = `import fs from "node:fs";
fs.openSync(${JSON.stringify(lockPath)}, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | 0x20, 0o600);
console.log("held");
setInterval(() => {}, 1000);`;
    const proc = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      proc.stdout.on("data", (chunk) => { if (String(chunk).includes("held")) resolve(); });
      proc.on("error", reject);
      proc.on("close", (code) => reject(new Error(`holder exited ${code}`)));
    });
    const journal = createHeadlessProgressJournal({ clientRoot: client, lockWaitMs: 20 });
    assert.equal(journal.record({ profile: "ghost", lane: "cursor-acp", phase: "claim" }), false, "held by a live process");
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill("SIGKILL");
    await exited;
    assert.equal(journal.record({ profile: "ghost", lane: "cursor-acp", phase: "claim" }), true, "released by the kernel on exit");
    assert.deepEqual(readdirSync(client).filter((n) => n.endsWith(".tmp") || n.endsWith(".stale")), []);
  } finally {
    cleanup();
  }
});

test("a live owner keeps the lock however long it holds it (Codex review r1/r2)", () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const filePath = path.join(client, HEADLESS_PROGRESS_FILE);
    const lockPath = `${filePath}.lock`;
    const held = holdLock(lockPath);
    try {
      progressPause(60);
      const journal = createHeadlessProgressJournal({ clientRoot: client, lockWaitMs: 20 });
      assert.equal(journal.record({ profile: "ghost", lane: "cursor-acp", phase: "claim" }), false);
      assert.equal(existsSync(filePath), false);
    } finally {
      fs.closeSync(held);
    }
  } finally {
    cleanup();
  }
});

test("two processes: a paused writer keeps its lock, so no successful write is overwritten (Codex review r1/r2)", () => {
  const { client, cleanup } = tempClientRoot();
  const filePath = path.join(client, HEADLESS_PROGRESS_FILE);
  const realRename = fs.renameSync;
  let child = null;
  try {
    // A (this live process) pauses at its rename well past B's lock wait.
    fs.renameSync = (src, dst) => {
      if (dst === filePath && child == null) {
        const source = `import {createHeadlessProgressJournal} from ${JSON.stringify(SUPERVISOR_URL)};
const j = createHeadlessProgressJournal({clientRoot: ${JSON.stringify(client)}, lockWaitMs: 300});
console.log(JSON.stringify([j.record({profile: "bob", lane: "worker", phase: "claim"})]));`;
        child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
      }
      return realRename(src, dst);
    };
    syncBuiltinESMExports();
    const journal = createHeadlessProgressJournal({ clientRoot: client });
    const aResult = journal.record({ profile: "alice", lane: "worker", phase: "claim" });
    fs.renameSync = realRename;
    syncBuiltinESMExports();
    assert.equal(child.status, 0, child.stderr);
    const [bResult] = JSON.parse(child.stdout.trim());
    const final = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(aResult, true);
    assert.equal(bResult, false, "B must not take over a live writer's lock");
    for (const [profile, ok] of [["alice", aResult], ["bob", bResult]]) {
      if (ok) assert.ok(Object.hasOwn(final.profiles, profile), `${profile} succeeded but was erased`);
    }
  } finally {
    fs.renameSync = realRename;
    syncBuiltinESMExports();
    cleanup();
  }
});

test("progress accepts every Swift ProfileName (spaces, non-ASCII, dots, 64 bytes) via forInstance and forProfile (Codex review r1)", () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const names = ["Agent One", "café", "Agent_One.v2", `w${"é".repeat(31)}x`.slice(0, 33), "x".repeat(64)];
    const journal = createHeadlessProgressJournal({ clientRoot: client });
    for (const name of names) {
      assert.ok(Buffer.byteLength(name) <= 64, name);
      const id = registryRow(client, name, "hermes", "worker");
      const recorder = journal.forInstance(id, "worker");
      assert.ok(recorder, `forInstance(${name})`);
      assert.equal(recorder.profile, name);
      assert.equal(recorder.record("claim"), true);
    }
    const doc = JSON.parse(readFileSync(path.join(client, HEADLESS_PROGRESS_FILE), "utf8"));
    assert.deepEqual(Object.keys(doc.profiles).sort(), [...names].sort());
    for (const bad of ["", "a/b", "a\\b", "x".repeat(65), "tab\tname", "zero\u200bwidth"]) {
      assert.equal(journal.record({ profile: bad, lane: "worker", phase: "claim" }), false, JSON.stringify(bad));
      assert.throws(() => journal.forProfile(bad, "worker"), TypeError);
    }
  } finally {
    cleanup();
  }
});

test("profile names that are Object.prototype keys are stored as own properties (Codex review r2)", () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const journal = createHeadlessProgressJournal({ clientRoot: client });
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      assert.equal(journal.forProfile(name, "worker").record("claim"), true, name);
    }
    assert.equal(journal.record({ profile: "__proto__", lane: "worker", phase: "reply" }), true);
    const raw = readFileSync(path.join(client, HEADLESS_PROGRESS_FILE), "utf8");
    const doc = JSON.parse(raw);
    assert.deepEqual(Object.keys(doc.profiles).sort(), ["__proto__", "constructor", "hasOwnProperty", "toString"]);
    assert.ok(Object.hasOwn(doc.profiles, "__proto__"));
    assert.equal(typeof doc.profiles.__proto__.lastClaimAt, "string");
    assert.equal(typeof doc.profiles.__proto__.lastReplyAt, "string");
    assert.equal(Object.getPrototypeOf(doc.profiles), Object.prototype, "JSON stays a plain object");
  } finally {
    cleanup();
  }
});

test("forInstance resolves profiles from the installation registry and rejects mismatches", () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const gravityId = registryRow(client, "gravity2", "antigravity", "worker");
    const forged = instanceIdFor("someone-else");
    writeJson(path.join(client, "instances", `${forged}.json`), { version: 1, instanceId: forged, profile: "gravity2" });
    const journal = createHeadlessProgressJournal({ clientRoot: client });
    assert.equal(journal.forInstance(gravityId, "worker").profile, "gravity2");
    assert.equal(journal.forInstance(forged, "worker"), null);
    assert.equal(journal.forInstance(instanceIdFor("absent"), "worker"), null);
    assert.equal(journal.forInstance("not-an-id", "worker"), null);
  } finally {
    cleanup();
  }
});

test("progress client root follows the helper install, else HOME", () => {
  assert.equal(
    resolveProgressClientRoot({ cursorAcpWakes: [{ helperPath: "/Users/u/Library/Application Support/The Triangle/bin/triangle-mailbox" }] }, {}),
    "/Users/u/Library/Application Support/The Triangle/client",
  );
  assert.equal(
    resolveProgressClientRoot({ instances: [] }, { HOME: "/Users/u" }),
    "/Users/u/Library/Application Support/The Triangle/client",
  );
  assert.equal(defaultHeadlessProgressClientRoot({}), null);
});

function fakeCursorAcpRuntime(proxy, { failReply = false } = {}) {
  return {
    async start() {},
    async stop() {},
    async runDelivery({ roomId, inboundEventId }) {
      if (failReply) {
        await assert.rejects(proxy.reply({ roomId, text: SENTINEL_BODY, inReplyToEventId: inboundEventId }));
        throw Object.assign(new Error("reply failed"), { code: "reply_failed" });
      }
      await proxy.reply({ roomId, text: SENTINEL_BODY, inReplyToEventId: inboundEventId });
      await proxy.ack();
      return { status: "completed" };
    },
  };
}

function fakeHelperProxy({ failReply = false } = {}) {
  const calls = [];
  return {
    calls,
    proxy: Object.freeze({
      protocol: "self-serve-drain",
      async reply(args) {
        calls.push("reply");
        if (failReply) throw Object.assign(new Error("helper down"), { code: "helper_unavailable" });
        return { replyEventId: "event_reply" };
      },
      async ack() { calls.push("ack"); return { acknowledged: true }; },
      async recordFailure() { calls.push("recordFailure"); },
    }),
  };
}

const DELIVERY = Object.freeze({
  deliveryId: "delivery_7",
  numericDeliveryId: 7,
  roomId: `room_${"a".repeat(32)}`,
  inboundEventId: `event_${"b".repeat(32)}`,
  text: SENTINEL_BODY,
  replyRequired: true,
});

test("Cursor ACP drain records claim, reply, and ack through the instrumented helper proxy", async () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const time = clock();
    const journal = createHeadlessProgressJournal({ clientRoot: client, now: () => { time.advance(1); return time.now(); } });
    const helper = fakeHelperProxy();
    const instrumentation = instrumentCursorAcpProgress({
      transactionProxy: helper.proxy,
      progress: journal.forProfile("ghost", "cursor-acp"),
    });
    assert.equal(instrumentation.transactionProxy.protocol, "self-serve-drain");
    assert.equal(typeof instrumentation.transactionProxy.recordFailure, "function");
    let pending = [DELIVERY];
    const drain = createHeadlessCursorAcpDrain({
      runtime: fakeCursorAcpRuntime(instrumentation.transactionProxy),
      resolveDelivery: instrumentation.wrapResolveDelivery(async () => pending.shift() ?? null),
      profileInstanceId: instanceIdFor("ghost"),
      logger: { error() {} },
    });
    await drain.start({ runLoop: false });
    assert.equal((await drain.drainOnce("test")).status, "completed");
    assert.equal((await drain.drainOnce("test")).status, "idle");
    await drain.stop();

    assert.deepEqual(helper.calls, ["reply", "ack"]);
    const raw = readFileSync(path.join(client, HEADLESS_PROGRESS_FILE), "utf8");
    const ghost = JSON.parse(raw).profiles.ghost;
    assert.equal(ghost.lane, "cursor-acp");
    for (const field of ["lastClaimAt", "lastReplyAt", "lastAckAt"]) {
      assert.ok(Number.isFinite(Date.parse(ghost[field])), `${field} recorded`);
    }
    assert.ok(Date.parse(ghost.lastClaimAt) < Date.parse(ghost.lastReplyAt));
    assert.ok(Date.parse(ghost.lastReplyAt) < Date.parse(ghost.lastAckAt));
    for (const secret of [SENTINEL_BODY, DELIVERY.roomId, DELIVERY.inboundEventId, "event_reply"]) {
      assert.equal(raw.includes(secret), false, "journal never carries bodies or ids");
    }
  } finally {
    cleanup();
  }
});

test("Cursor ACP drain records no reply/ack when the helper reply fails, and errors still propagate", async () => {
  const { client, cleanup } = tempClientRoot();
  try {
    const journal = createHeadlessProgressJournal({ clientRoot: client });
    const helper = fakeHelperProxy({ failReply: true });
    const instrumentation = instrumentCursorAcpProgress({
      transactionProxy: helper.proxy,
      progress: journal.forProfile("ghost", "cursor-acp"),
    });
    const drain = createHeadlessCursorAcpDrain({
      runtime: fakeCursorAcpRuntime(instrumentation.transactionProxy, { failReply: true }),
      resolveDelivery: instrumentation.wrapResolveDelivery(async () => DELIVERY),
      profileInstanceId: instanceIdFor("ghost"),
      logger: { error() {} },
    });
    await drain.start({ runLoop: false });
    await assert.rejects(drain.drainOnce("test"), { code: "reply_failed" });
    await drain.stop();
    const ghost = JSON.parse(readFileSync(path.join(client, HEADLESS_PROGRESS_FILE), "utf8")).profiles.ghost;
    assert.ok(ghost.lastClaimAt);
    assert.equal(ghost.lastReplyAt, undefined);
    assert.equal(ghost.lastAckAt, undefined);
  } finally {
    cleanup();
  }
});

test("Cursor ACP instrumentation is a no-op without a recorder and survives a throwing recorder", async () => {
  const helper = fakeHelperProxy();
  const passthrough = instrumentCursorAcpProgress({ transactionProxy: helper.proxy });
  assert.equal(passthrough.transactionProxy, helper.proxy);
  const resolver = async () => null;
  assert.equal(passthrough.wrapResolveDelivery(resolver), resolver);

  const errors = [];
  const throwing = instrumentCursorAcpProgress({
    transactionProxy: helper.proxy,
    progress: { record() { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } },
    logger: { error: (event, detail) => errors.push({ event, detail }) },
  });
  assert.deepEqual(await throwing.transactionProxy.reply({}), { replyEventId: "event_reply" });
  assert.deepEqual(await throwing.transactionProxy.ack(), { acknowledged: true });
  assert.deepEqual(await throwing.wrapResolveDelivery(async () => DELIVERY)(), DELIVERY);
  assert.equal(errors.length, 3);
  assert.ok(errors.every((entry) => entry.detail.code === "ENOSPC"));
});

function workerInstance(profile) {
  const instanceId = instanceIdFor(profile);
  return {
    instanceId,
    mailbox: {
      meshUrl: "https://mesh.example",
      meshToken: SENTINEL_TOKEN,
      recipientId: `agent_${"e".repeat(32)}`,
      pageLimit: 1,
    },
    runner: { command: "/trusted/runner", args: [], timeoutMs: 1_000 },
    runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: instanceId },
  };
}

test("supervisor wires worker mailbox progress and Cursor ACP drain progress into the journal", () => {
  const { client, cleanup } = tempClientRoot();
  try {
    registryRow(client, "gravity2", "antigravity", "worker");
    registryRow(client, "ghost", "cursor-acp", "headless-cursor-acp");
    const journal = createHeadlessProgressJournal({ clientRoot: client });
    const deliveryContexts = [];
    const drainOptions = [];
    createClientSupervisor({
      instances: [workerInstance("gravity2")],
      cursorAcpWakes: [{
        profile: "ghost",
        profileInstanceId: instanceIdFor("ghost"),
        helperPath: "/trusted/triangle-mailbox",
        workingDirectory: "/srv/work",
        cursorHome: "/private/cursor-home",
        stateRoot: "/private/cursor-acp-state/ghost",
        command: "/trusted/bin/agent",
        pollIntervalMs: 1_000,
      }],
      progressJournal: journal,
      createDeliveryClient: (_mailbox, context) => {
        deliveryContexts.push(context);
        return { async listUnread() { return []; }, async completeAndAcknowledge() { return {}; } };
      },
      createRunner: () => ({ async run() { return { status: "completed", text: "x" }; } }),
      createCursorAcpClaimer: () => ({ assertSupervisorMayClaim() {}, acquire() {}, release() {} }),
      createCursorAcpDrain: (_config, options) => {
        drainOptions.push(options);
        return { async start() {}, async stop() {}, kick() { return { status: "accepted" }; } };
      },
      logger: { error() {} },
    });
    assert.equal(deliveryContexts.length, 1);
    assert.equal(deliveryContexts[0].instanceId, instanceIdFor("gravity2"));
    assert.equal(typeof deliveryContexts[0].onProgress, "function");
    for (const phase of ["claim", "reply", "ack"]) deliveryContexts[0].onProgress({ phase });

    assert.equal(drainOptions.length, 1);
    assert.equal(drainOptions[0].progress.profile, "ghost");
    assert.equal(drainOptions[0].progress.lane, "cursor-acp");
    drainOptions[0].progress.record("claim");

    const raw = readFileSync(journal.path, "utf8");
    const doc = JSON.parse(raw);
    assert.equal(doc.profiles.gravity2.lane, "worker");
    for (const field of ["lastClaimAt", "lastReplyAt", "lastAckAt"]) assert.ok(doc.profiles.gravity2[field]);
    assert.ok(doc.profiles.ghost.lastClaimAt);
    assert.equal(raw.includes(SENTINEL_TOKEN), false);
  } finally {
    cleanup();
  }
});

test("supervisor without a journal leaves delivery contexts and drain options unchanged", () => {
  const contexts = [];
  const drainOptions = [];
  createClientSupervisor({
    instances: [workerInstance("gravity2")],
    createDeliveryClient: (_mailbox, context) => {
      contexts.push(context);
      return { async listUnread() { return []; }, async completeAndAcknowledge() { return {}; } };
    },
    createRunner: () => ({ async run() { return { status: "completed", text: "x" }; } }),
    logger: { error() {} },
  });
  assert.deepEqual(contexts, [{ instanceId: instanceIdFor("gravity2") }]);
  assert.throws(() => createClientSupervisor({
    instances: [workerInstance("gravity2")],
    progressJournal: {},
  }), /progressJournal must provide/);
  assert.deepEqual(drainOptions, []);
});

/** Doctor inventory classification. The module lands with PR #82 (l1c/doctor-inventory). */
/**
 * The #82 inventory plus its Swift-shaped fixture helpers. Null when #82 (or a
 * #82 head that predates its strict decoders and helpers) is not in this tree.
 */
async function loadInventory() {
  try {
    const inventory = await import("../src/installation-inventory.mjs");
    const helpers = await import("./inventory-fixture-helpers.mjs");
    return Object.assign(Object.create(null), inventory, { helpers });
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

function inventoryFixture(helpers) {
  const fixture = tempClientRoot();
  const { root, app, client } = fixture;
  const agent = path.join(root, "agent");
  writeFileSync(agent, "#!/bin/sh\n", { mode: 0o700 });
  registryRow(client, "ghost", "cursor-acp", "headless-cursor-acp");
  registryRow(client, "gravity2", "antigravity", "worker");
  for (const profile of ["ghost", "gravity2"]) helpers.writeEnrollment(app, profile);
  helpers.writeInstallationIdentity(client);
  writeJson(path.join(client, "cursor-acp-runtime-binding.json"), {
    version: 1,
    common: { adapterVersion: "1", installationId: helpers.FIXTURE_INSTALLATION_ID, workingDirectory: root, cursorHome: path.join(app, "cursor-home"), command: agent, pollIntervalMs: 30000 },
    profiles: [{ profile: "ghost", instanceId: instanceIdFor("ghost"), stateRoot: path.join(app, "model-state", "cursor-acp-drain", "ghost") }],
  });
  mkdirSync(path.join(app, "model-state", "cursor-acp-drain", "ghost"), { recursive: true });
  helpers.writeWorkerManifest(app, "antigravity");
  writeJson(path.join(client, "cursor-acp-claimer.ghost.json"), {
    version: 1, profile: "ghost", owner: "dev.thetriangle.client", pid: 609, family: "cursor-acp", acquiredAt: "2026-10-17T04:31:02.793Z",
  });
  return fixture;
}

test("doctor inventory: ghost and gravity2 are degraded without evidence and ok once the drains record it", async (t) => {
  const inventory = await loadInventory();
  if (inventory == null) {
    t.skip("installation-inventory.mjs (PR #82) not on this branch");
    return;
  }
  const fixture = inventoryFixture(inventory.helpers);
  try {
    const NOW = Date.parse("2026-10-17T20:00:00.000Z");
    const read = (progress) => inventory.readInstallationInventory({
      clientRoot: fixture.client,
      now: NOW,
      pidAlive: () => true,
      advisoryHeldAt: () => true,
      progress,
    });
    const before = read(null);
    for (const profile of ["ghost", "gravity2"]) {
      const row = before.profiles.find((entry) => entry.profile === profile);
      assert.equal(row.status, "degraded", `${profile} degraded without evidence`);
      assert.ok(JSON.stringify(row).includes("progress_evidence_unavailable"));
    }

    const time = clock(NOW - 60_000);
    const journal = createHeadlessProgressJournal({ clientRoot: fixture.client, now: () => { time.advance(1_000); return time.now(); } });
    // Cursor ACP drain path (instrumented helper proxy + resolver).
    const helper = fakeHelperProxy();
    const acp = instrumentCursorAcpProgress({ transactionProxy: helper.proxy, progress: journal.forProfile("ghost", "cursor-acp") });
    await acp.wrapResolveDelivery(async () => DELIVERY)();
    await acp.transactionProxy.reply({});
    await acp.transactionProxy.ack();
    // Worker path (mailbox client onProgress via registry-resolved recorder).
    const worker = journal.forInstance(instanceIdFor("gravity2"), "worker");
    for (const phase of ["claim", "reply", "ack"]) worker.record(phase);

    const progress = JSON.parse(readFileSync(journal.path, "utf8"));
    const after = read(progress);
    for (const profile of ["ghost", "gravity2"]) {
      const row = after.profiles.find((entry) => entry.profile === profile);
      assert.equal(row.status, "ok", `${profile} ok with evidence: ${JSON.stringify(row.faults ?? row)}`);
      assert.equal(JSON.stringify(row).includes("progress_evidence_unavailable"), false);
    }
  } finally {
    fixture.cleanup();
  }
});

test("doctor inventory: a drain's first claim stamp never masks a stalled open transaction (review F3 with #85)", async (t) => {
  const inventory = await loadInventory();
  if (inventory == null || typeof inventory.evaluateOpenTransaction !== "function") {
    t.skip("installation-inventory.mjs with the open-transaction policy (PR #82) not on this branch");
    return;
  }
  const fixture = inventoryFixture(inventory.helpers);
  try {
    const NOW = Date.parse("2026-10-17T20:00:00.000Z");
    const TWO_HOURS_AGO = NOW - 2 * 60 * 60_000;
    // Only the claim is recorded (execution never replied or acked).
    const journal = createHeadlessProgressJournal({ clientRoot: fixture.client, now: () => TWO_HOURS_AGO });
    assert.equal(journal.forProfile("ghost", "cursor-acp").record("claim"), true);
    assert.equal(journal.forInstance(instanceIdFor("gravity2"), "worker").record("claim"), true);
    for (const profile of ["ghost", "gravity2"]) {
      writeJson(
        path.join(fixture.app, "model-state", "instances", instanceIdFor(profile), "mailbox-transactions", "open.json"),
        inventory.helpers.openTransactionRecord(instanceIdFor(profile), {
          failureCount: 3, lastFailureReason: "runtime_failed", createdAt: new Date(TWO_HOURS_AGO).toISOString(),
        }),
      );
    }
    const result = inventory.readInstallationInventory({
      clientRoot: fixture.client,
      now: NOW,
      pidAlive: () => true,
      advisoryHeldAt: () => true,
      progress: JSON.parse(readFileSync(journal.path, "utf8")),
    });
    for (const profile of ["ghost", "gravity2"]) {
      const row = result.profiles.find((entry) => entry.profile === profile);
      assert.notEqual(row.activity.lastClaimAt, "unavailable");
      assert.equal(row.status, "fault", `${profile}: ${JSON.stringify(row.faults)}`);
      assert.ok(row.faults.includes("open_transaction_stalled"));
    }
  } finally {
    fixture.cleanup();
  }
});
