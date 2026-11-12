// Regression tests for the round-1 review of PR #90: challenge binding,
// recovery-state retention, locking, transport verification, scopes, JCS input.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.mjs";
import { canonicalJson } from "../src/canonical.mjs";
import { openCustody } from "../src/custody.mjs";
import { openSession } from "../src/session.mjs";
import { createFakeAuthority } from "./fake-authority.mjs";

const AUTH = "https://mesh.test";
const tmpHome = () => path.join(mkdtempSync(path.join(os.tmpdir(), "triangle-recovery-")), "home");

function runner(fetchImpl, home) {
  return async (...argv) => {
    const out = [];
    const err = [];
    const code = await main([...argv, "--home", home], { env: {}, fetchImpl, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } });
    return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")), lines: () => out.join("\n").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
  };
}

async function joined(fake, extra = []) {
  const home = tmpHome();
  const run = runner(fake.fetchImpl, home);
  const result = await run("join", fake.mintInvite().link, "--handle", "first-agent", ...extra, "--json");
  assert.equal(result.code, 0, result.err);
  return { home, run, agentId: result.json().result.agent.agent_id };
}

const journals = (home) => (existsSync(path.join(home, "journal")) ? readdirSync(path.join(home, "journal")) : []);

test("a tampered owner challenge (different operation) is refused before signing", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { home } = await joined(fake);
  const tampering = async (input, init) => {
    const request = new Request(input, init);
    const response = await fake.fetchImpl(request);
    if (request.url.endsWith("/api/v1/owners/me/challenges")) {
      const body = await response.json();
      return new Response(JSON.stringify({ ...body, operation: "agent.delete" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return response;
  };
  const before = fake.state.requests.length;
  const result = await runner(tampering, home)("agent", "add", "--handle", "second-agent");
  assert.equal(result.code, 1);
  assert.match(result.err, /different request \(operation\)/);
  assert.equal(fake.state.requests.slice(before).some((r) => r.path === "/api/v1/agents"), false, "nothing signed was sent");
  assert.deepEqual(journals(home), []);
});

test("a response cut off after its headers keeps the journal (outcome unknown), and resume installs the key", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { home } = await joined(fake);
  let cut = true;
  const cutting = async (input, init) => {
    const request = new Request(input, init);
    const response = await fake.fetchImpl(request);
    if (cut && request.method === "POST" && new URL(request.url).pathname === "/api/v1/agents") {
      cut = false;
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"outcome":')); controller.error(new Error("socket reset")); } });
      return new Response(stream, { status: response.status, headers: response.headers });
    }
    return response;
  };
  const first = await runner(cutting, home)("agent", "add", "--handle", "cut-agent");
  assert.equal(first.code, 3, first.err);
  assert.equal(journals(home).length, 1);
  const resumed = await runner(fake.fetchImpl, home)("resume", "--json");
  assert.equal(resumed.code, 0, resumed.err);
  assert.deepEqual(resumed.lines().map((d) => d.outcome), ["replayed"]);
  assert.deepEqual(journals(home), []);
});

test("a failed replay never discards a request whose earlier outcome was unknown", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { home, run } = await joined(fake);
  fake.state.failNext = "drop-after-commit";
  fake.state.failPath = /^\/api\/v1\/agents$/;
  assert.equal((await run("agent", "add", "--handle", "kept-agent")).code, 3);
  fake.state.failNext = 429;
  fake.state.failPath = /^\/api\/v1\/agents$/;
  const throttled = await run("resume");
  assert.equal(throttled.code, 1);
  assert.match(throttled.err, /its request is kept/);
  assert.equal(journals(home).length, 1, "journal (with the only workload key) kept");
  const resumed = await run("resume", "--json");
  assert.equal(resumed.code, 0, resumed.err);
  const created = [...fake.state.agents.entries()].find(([, a]) => a.handle === "kept-agent")[0];
  assert.ok(existsSync(path.join(home, "agents", created, "workload-key.json")));
});

test("a journal recovered after a crash (never marked) is kept when its replay fails", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { home, run } = await joined(fake);
  // Simulate: process died right after the server committed (journal written, never marked).
  fake.state.failNext = "drop-after-commit";
  fake.state.failPath = /^\/api\/v1\/agents$/;
  assert.equal((await run("agent", "add", "--handle", "crash-agent")).code, 3);
  const file = path.join(home, "journal", journals(home)[0]);
  const entry = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
  delete entry.outcome_unknown;
  writeFileSync(file, JSON.stringify(entry), { mode: 0o600 });
  fake.state.failNext = 401;
  fake.state.failPath = /^\/api\/v1\/agents$/;
  assert.equal((await run("resume")).code, 1);
  assert.equal(journals(home).length, 1, "kept");
  assert.equal((await run("resume")).code, 0);
  assert.deepEqual(journals(home), []);
});

test("join: if saving local state fails after the server committed, the journal survives and --resume finishes", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const home = tmpHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, "agents"), "not a directory");
  const run = runner(fake.fetchImpl, home);
  const first = await run("join", fake.mintInvite().link, "--handle", "saved-agent");
  assert.equal(first.code, 1);
  assert.match(first.err, /triangle join --resume/);
  assert.deepEqual(journals(home), ["join.json"]);
  rmSync(path.join(home, "agents"));
  const resumed = await run("join", "--resume", "--json");
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(resumed.json().outcome, "replayed");
  assert.ok(existsSync(path.join(home, "agents", resumed.json().result.agent.agent_id, "workload-key.json")));
});

/**
 * Hold the lock on `home` from a child process until it is killed, and return as soon as the child says "held".
 *
 * `withLock` keeps the SQLite connection (and so the lock) alive only through the `.finally(release)` handler it attaches to the
 * promise the callback returns. If nothing else references that pending promise, V8 collects it, the connection goes with it and
 * the lock is released; here that happens within a few milliseconds of "held" (one scavenge follows the module load), so a holder
 * written that way passes a test only while the parent gets to the lock first. The child therefore keeps the promise on
 * `globalThis`, and `settled` waits past that window and checks the holder is still running, so a holder that stops holding the lock
 * fails every run instead of some runs. The child also exits when its stdin closes, that is when this test process goes away, so
 * a killed run cannot leave a lock holder behind.
 */
async function holdLockInChild(home) {
  const { spawn } = await import("node:child_process");
  const custodyUrl = new URL("../src/custody.mjs", import.meta.url).href;
  const script = `const { openCustody } = await import(${JSON.stringify(custodyUrl)}); `
    + "process.stdin.on(\"end\", () => process.exit(0)).resume(); "
    + `openCustody(${JSON.stringify(home)}).withLock(() => (globalThis.holdForever = new Promise(() => { setInterval(() => {}, 60_000); console.log("held"); })));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("exit", reject); });
  return child;
}

/** Wait until a holder that let go of its lock would have done so, and check that it is still running. */
async function settled(child) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, "the lock holder is still running");
}

/** Kill a child from holdLockInChild and wait until it is gone, so a failed assertion cannot leave it keeping the test process alive. */
async function killAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

test("lock: OS-level exclusive lock; no re-entry; a crashed holder releases it automatically", async () => {
  const custody = openCustody(tmpHome()).init();
  custody.withLock(() => {
    assert.throws(() => custody.withLock(() => {}), /already locked by this process/);
  });
  assert.equal(custody.withLock(() => "free again"), "free again");
  const child = await holdLockInChild(custody.root);
  try {
    assert.throws(() => custody.withLock(() => {}), /Another triangle command/);
    await settled(child);
    assert.throws(() => custody.withLock(() => {}), /Another triangle command/, "still held after the time a holder that lets go would have released it");
  } finally {
    await killAndWait(child);
  }
  assert.equal(custody.withLock(() => "after crash"), "after crash", "no stale lock to clean up");
  assert.equal((statSync(path.join(custody.root, ".lock.db")).mode & 0o077), 0);
});

test("--via is re-verified by every later session before anything signed is sent", async () => {
  const fake = createFakeAuthority({ authority: AUTH, transportBase: "https://preview.test" });
  const home = tmpHome();
  const run = runner(fake.fetchImpl, home);
  assert.equal((await run("join", fake.mintInvite().link, "--handle", "via-agent", "--via", "https://preview.test")).code, 0);
  fake.state.servedAuthority = "https://elsewhere.test";
  const before = fake.state.requests.length;
  const status = await run("agent", "list");
  assert.equal(status.code, 1);
  assert.match(status.err, /does not serve the MESH authority/);
  assert.equal(fake.state.requests.slice(before).some((r) => r.headers["mesh-owner-proof"]), false);
});

test("read-only agents get agent.read tokens by default and cannot ask for write", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { home, run } = await joined(fake);
  const added = await run("agent", "add", "--handle", "reader-agent", "--read-only", "--json");
  assert.equal(added.code, 0, added.err);
  const session = openSession({ home, env: {}, fetchImpl: fake.fetchImpl });
  const wl = session.workloadSession(added.json().agent_id);
  assert.equal((await wl.request("GET", "/api/v1/agents/me")).status, 200);
  assert.throws(() => session.workloadSession(added.json().agent_id, { scopes: ["agent.read", "agent.write"] }), /limited to agent\.read/);
});

test("CLI: --help works; contradictory join modes are refused; recovery commands take the lock", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const home = tmpHome();
  const run = runner(fake.fetchImpl, home);
  assert.equal((await run("--help")).code, 0);
  assert.equal((await run("join", "--resume", "--abandon")).code, 2);
  assert.equal((await run("join", "--abandon")).code, 0, "abandon on a fresh home is a no-op");
  const child = await holdLockInChild(home);
  try {
    await settled(child);
    const abandon = await run("join", "--abandon");
    assert.equal(abandon.code, 1);
    assert.match(abandon.err, /Another triangle command/);
  } finally {
    await killAndWait(child);
  }
  const swallowed = await run("agent", "add", "--handle", "x-agent", "--name", "--read-only");
  assert.equal(swallowed.code, 2, "an option-looking value is refused");
  assert.match(swallowed.err, /use --name=VALUE/);
});

test("canonical JSON refuses lone surrogates and sparse arrays", () => {
  assert.throws(() => canonicalJson({ a: "\uD800" }), /lone surrogates/);
  assert.throws(() => canonicalJson({ ["\uDC00"]: 1 }), /lone surrogates/);
  assert.throws(() => canonicalJson([, 1]), /sparse/); // eslint-disable-line no-sparse-arrays
  assert.equal(canonicalJson({ e: "😀" }), '{"e":"😀"}');
});

test("DPoP htu is the full request URL including the query (what MESH compares)", async () => {
  const { dpopProof } = await import("../src/workload.mjs");
  const { generateEd25519 } = await import("../src/keys.mjs");
  const key = generateEd25519();
  const proof = dpopProof({ workloadKey: key, method: "get", url: "https://mesh.test/api/v1/mailbox?limit=5&after=0", accessToken: "t" });
  const payload = JSON.parse(Buffer.from(proof.split(".")[1], "base64url").toString("utf8"));
  assert.equal(payload.htu, "https://mesh.test/api/v1/mailbox?limit=5&after=0");
  assert.equal(payload.htm, "GET");
  assert.throws(() => dpopProof({ workloadKey: key, method: "GET", url: "https://mesh.test/x#frag", accessToken: "t" }), /Invalid DPoP URL/);
  const fake = createFakeAuthority({ authority: AUTH });
  const { home, agentId } = await joined(fake);
  const wl = openSession({ home, env: {}, fetchImpl: fake.fetchImpl }).workloadSession(agentId);
  assert.equal((await wl.request("GET", "/api/v1/agents/me?view=full")).status, 200);
});
