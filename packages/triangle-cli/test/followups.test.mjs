// Follow-ups to the permissions-v1 review: ambiguous 4xx keep the journal,
// the transport headers file is read as strictly as other custody files, and a
// shared token exchange is not tied to one caller's abort signal.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.mjs";
import { loadTransportHeaders } from "../src/transport.mjs";
import { awaitWithSignal } from "../src/workload.mjs";
import { createFakeAuthority } from "./fake-authority.mjs";

const AUTH = "https://mesh.test";
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "triangle-followups-"));
const journals = (home) => (existsSync(path.join(home, "journal")) ? readdirSync(path.join(home, "journal")) : []);

function runner(fetchImpl, home) {
  return async (...argv) => {
    const out = [];
    const err = [];
    const code = await main([...argv, "--home", home], { env: {}, fetchImpl, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } });
    return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) };
  };
}

async function joined(fake) {
  const home = path.join(tmp(), "home");
  const result = await runner(fake.fetchImpl, home)("join", fake.mintInvite().link, "--handle", "first-agent", "--json");
  assert.equal(result.code, 0, result.err);
  return home;
}

function refusing(fake, status) {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST" && new URL(request.url).pathname === "/api/v1/agents") {
      return new Response(JSON.stringify({ error: "refused" }), { status, headers: { "content-type": "application/json" } });
    }
    return fake.fetchImpl(request);
  };
}

for (const status of [408, 425, 429]) {
  test(`a ${status} on the first send keeps the journal and points at resume`, async () => {
    const fake = createFakeAuthority({ authority: AUTH });
    const home = await joined(fake);
    const result = await runner(refusing(fake, status), home)("agent", "add", "--handle", "second-agent");
    assert.notEqual(result.code, 0);
    assert.match(result.err, /triangle resume/);
    assert.equal(journals(home).length, 1, "the signed request and new workload key are kept");
  });
}

test("a definitive 4xx (403) on the first send still discards the journal", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const home = await joined(fake);
  const result = await runner(refusing(fake, 403), home)("agent", "add", "--handle", "second-agent");
  assert.notEqual(result.code, 0);
  assert.deepEqual(journals(home), []);
});

test("transport headers file: private, owned, regular, valid JSON", () => {
  const dir = tmp();
  const file = path.join(dir, "headers.json");
  writeFileSync(file, JSON.stringify({ "x-bypass": "abc" }), { mode: 0o600 });
  chmodSync(file, 0o600);
  assert.deepEqual(loadTransportHeaders(file), { "x-bypass": "abc" });
  assert.throws(() => loadTransportHeaders(path.join(dir, "missing.json")), /does not exist/);
  const link = path.join(dir, "link.json");
  symlinkSync(file, link);
  assert.throws(() => loadTransportHeaders(link), /regular file/);
  const open = path.join(dir, "open.json");
  writeFileSync(open, "{}", { mode: 0o644 });
  chmodSync(open, 0o644);
  assert.throws(() => loadTransportHeaders(open), /not be readable by group or others/);
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, "{nope", { mode: 0o600 });
  chmodSync(bad, 0o600);
  assert.throws(() => loadTransportHeaders(bad), /not valid JSON/);
});

test("awaitWithSignal stops one waiter without cancelling the shared work", async () => {
  let release;
  const shared = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const impatient = awaitWithSignal(shared, controller.signal);
  const patient = awaitWithSignal(shared, undefined);
  controller.abort(new Error("gone"));
  await assert.rejects(impatient, /gone/);
  release("token");
  assert.equal(await patient, "token");
  await assert.rejects(awaitWithSignal(shared, AbortSignal.abort(new Error("already"))), /already/);
});
