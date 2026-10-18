// Regression tests for the round-1 review of PR #90: challenge binding,
// recovery-state retention, locking, transport verification, scopes, JCS input.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
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
  assert.deepEqual(resumed.json().map((d) => d.outcome), ["replayed"]);
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

test("lock: no same-process re-entry; a dead holder is taken over; a live or just-created lock is respected; release is owner-checked", async () => {
  const custody = openCustody(tmpHome()).init();
  const lock = path.join(custody.root, ".lock");
  custody.withLock(() => {
    assert.throws(() => custody.withLock(() => {}), /already locked by this process/);
  });
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, "999999:deadbeef", { mode: 0o600 });
  assert.equal(custody.withLock(() => "took over"), "took over");
  writeFileSync(lock, `${process.ppid}:other`, { mode: 0o600 });
  assert.throws(() => custody.withLock(() => {}), /Another triangle command/);
  writeFileSync(lock, "", { mode: 0o600 });
  assert.throws(() => custody.withLock(() => {}), /starting on/);
  rmSync(lock);
  await custody.withLock(async () => {
    writeFileSync(lock, "999999:replaced", { mode: 0o600 }); // someone broke our lock
  });
  assert.equal(existsSync(lock), true, "release does not delete a lock that is not ours");
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
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, ".lock"), `${process.ppid}:busy`, { mode: 0o600 });
  const abandon = await run("join", "--abandon");
  assert.equal(abandon.code, 1);
  assert.match(abandon.err, /Another triangle command/);
});

test("canonical JSON refuses lone surrogates and sparse arrays", () => {
  assert.throws(() => canonicalJson({ a: "\uD800" }), /lone surrogates/);
  assert.throws(() => canonicalJson({ ["\uDC00"]: 1 }), /lone surrogates/);
  assert.throws(() => canonicalJson([, 1]), /sparse/); // eslint-disable-line no-sparse-arrays
  assert.equal(canonicalJson({ e: "😀" }), '{"e":"😀"}');
});
