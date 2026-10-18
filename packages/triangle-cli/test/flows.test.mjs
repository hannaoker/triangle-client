import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.mjs";
import { openSession } from "../src/session.mjs";
import { MeshApiError } from "../src/errors.mjs";
import { createFakeAuthority } from "./fake-authority.mjs";

const AUTH = "https://mesh.test";
const tmpHome = () => path.join(mkdtempSync(path.join(os.tmpdir(), "triangle-flow-")), "home");

function runner(fake, home) {
  return async (...argv) => {
    const out = [];
    const err = [];
    const code = await main([...argv, "--home", home], { env: {}, fetchImpl: fake.fetchImpl, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } });
    return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")), lines: () => out.join("\n").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
  };
}

function allFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

async function bootstrap(fake, home, handle = "jerry-mini") {
  const run = runner(fake, home);
  const { link } = fake.mintInvite();
  const result = await run("join", link, "--name", "Jerry", "--handle", handle, "--device-label", "Jerry's Mac mini", "--json");
  assert.equal(result.code, 0, result.err);
  return { run, result: result.json() };
}

test("join (bootstrap): one action creates owner key, device controller and first agent; secrets stay 0600 and out of non-secret files", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const home = tmpHome();
  const { run, result } = await bootstrap(fake, home);
  assert.equal(result.outcome, "applied");
  assert.equal(result.result.owner_role, "admin");
  assert.equal(result.result.agent.handle, "jerry-mini");
  const files = allFiles(home);
  for (const file of files) assert.equal(statSync(file).mode & 0o077, 0, `${file} is private`);
  const ownerKey = JSON.parse(readFileSync(path.join(home, "owner", "owner-key.json"), "utf8"));
  const agentId = result.result.agent.agent_id;
  for (const file of files.filter((f) => !f.endsWith("owner-key.json"))) {
    assert.equal(readFileSync(file, "utf8").includes(ownerKey.d), false, `owner key must not appear in ${file}`);
  }
  assert.ok(files.some((f) => f.endsWith(path.join(agentId, "workload-key.json"))));
  assert.equal(files.some((f) => f.includes(`${path.sep}journal${path.sep}`)), false, "journal cleared after success");
  const status = await run("status", "--json");
  assert.equal(status.code, 0, status.err);
  const report = status.json();
  assert.equal(report.agents[0].on_this_device, true);
  assert.ok(report.warnings.some((w) => /No backup owner device/.test(w)));
  const human = await run("status");
  assert.match(human.out, /Agents on this computer run as you/);
});

test("join: lost response after commit → exit 3, `join --resume` replays the identical request (no new keys)", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const home = tmpHome();
  const run = runner(fake, home);
  const { link } = fake.mintInvite();
  fake.state.failNext = "drop-after-commit";
  fake.state.failPath = /\/redeem$/;
  const first = await run("join", link, "--handle", "resumed-agent");
  assert.equal(first.code, 3);
  assert.match(first.err, /triangle join --resume/);
  const journal = JSON.parse(readFileSync(path.join(home, "journal", "join.json"), "utf8"));
  const resumed = await run("join", "--resume", "--json");
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(resumed.json().outcome, "replayed");
  const redeems = fake.state.requests.filter((r) => r.path.endsWith("/redeem"));
  assert.equal(redeems.length, 2);
  assert.deepEqual(redeems[0].body, redeems[1].body, "byte-identical replay");
  const workloadKey = JSON.parse(readFileSync(path.join(home, "agents", resumed.json().result.agent.agent_id, "workload-key.json"), "utf8"));
  assert.equal(workloadKey.x, journal.workload_key.x, "the journaled workload key is the one installed");
});

test("join: request never arrived and challenge was consumed → resume re-signs the same keys with a fresh challenge", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const home = tmpHome();
  const run = runner(fake, home);
  const { link } = fake.mintInvite();
  fake.state.failNext = "network";
  fake.state.failPath = /\/redeem$/;
  assert.equal((await run("join", link, "--handle", "late-agent")).code, 3);
  const journal = JSON.parse(readFileSync(path.join(home, "journal", "join.json"), "utf8"));
  fake.state.challenges.get(journal.body.challenge_id).used = true; // the challenge expired meanwhile
  const resumed = await run("join", "--resume", "--json");
  assert.equal(resumed.code, 0, resumed.err);
  const sent = fake.state.requests.filter((r) => r.path.endsWith("/redeem")).at(-1).body;
  assert.equal(sent.owner_public_jwk.x, journal.owner_key.x);
  assert.equal(sent.agent.workload_public_jwk.x, journal.workload_key.x);
  assert.notEqual(sent.challenge_id, journal.body.challenge_id);
});

test("join: a device link adds this computer as pending (no agent); approval by fingerprint activates it", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const homeA = tmpHome();
  const { run: runA, result } = await bootstrap(fake, homeA);
  const ownerId = result.result.owner_id;
  const deviceInvite = fake.mintInvite({ kind: "device", role: null, target_owner_id: ownerId });
  const homeB = tmpHome();
  const runB = runner(fake, homeB);
  const joined = await runB("join", deviceInvite.link, "--device-label", "MacBook Air");
  assert.equal(joined.code, 0, joined.err);
  assert.match(joined.out, /waiting for approval/);
  const fp = /triangle device approve ([A-Z0-9_-]{4}(?:-[A-Z0-9_-]{4}){3})/.exec(joined.out)[1];
  const statusB = await runB("status", "--json");
  assert.ok(statusB.json().warnings.some((w) => w.includes(fp)));
  assert.equal(readdirSync(homeB).includes("agents"), false, "device joins create no agent");
  const listA = await runA("agent", "list", "--json");
  assert.equal(listA.code, 0, listA.err);
  const ctrl = [...fake.state.controllers.values()].find((c) => c.device_label === "MacBook Air");
  assert.equal(ctrl.state, "pending_approval");
});

test("join: refuses a second join on the same home and a --via that serves another authority", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const home = tmpHome();
  const { run } = await bootstrap(fake, home);
  const again = await run("join", fake.mintInvite({ kind: "teammate", role: "member" }).link);
  assert.equal(again.code, 1);
  assert.match(again.err, /already joined/);
  const other = runner(fake, tmpHome());
  const via = await other("join", fake.mintInvite().link, "--via", "https://elsewhere.test");
  assert.notEqual(via.code, 0);
});

test("agent add: owner-signed agent.create with workload proof; the key is installed only for the created agent", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const home = tmpHome();
  const { run } = await bootstrap(fake, home);
  const added = await run("agent", "add", "--handle", "helper-two", "--name", "Helper two", "--json");
  assert.equal(added.code, 0, added.err);
  const agentId = added.json().agent_id;
  assert.ok(statSync(path.join(home, "agents", agentId, "workload-key.json")).isFile());
  const taken = await run("agent", "add", "--handle", "helper-two");
  assert.equal(taken.code, 1);
  assert.match(taken.err, /already taken/);
  assert.equal(readdirSync(path.join(home, "agents")).length, 2, "a refused create installs no key");
  const list = await run("agent", "list", "--json");
  assert.deepEqual(list.json().map((a) => a.handle).sort(), ["helper-two", "jerry-mini"]);
});

test("agent add: lost response → `triangle resume` replays and installs the journaled key", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const home = tmpHome();
  const { run } = await bootstrap(fake, home);
  fake.state.failNext = "drop-after-commit";
  fake.state.failPath = /^\/api\/v1\/agents$/;
  const first = await run("agent", "add", "--handle", "flaky-net");
  assert.equal(first.code, 3);
  assert.match(first.err, /triangle resume/);
  const resumed = await run("resume", "--json");
  assert.equal(resumed.code, 0, resumed.err);
  assert.deepEqual(resumed.lines().map((d) => d.outcome), ["replayed"]);
  const created = [...fake.state.agents.entries()].find(([, a]) => a.handle === "flaky-net")[0];
  assert.ok(statSync(path.join(home, "agents", created, "workload-key.json")).isFile());
  assert.equal(fake.state.agents.size, 2, "exactly one agent created");
});

test("workload session: token exchange + canonical DPoP; permission_denied surfaces the key", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const home = tmpHome();
  const { result } = await bootstrap(fake, home);
  const session = openSession({ home, env: {}, fetchImpl: fake.fetchImpl });
  const wl = session.workloadSession(result.result.agent.agent_id);
  const me = await wl.request("GET", "/api/v1/agents/me");
  assert.equal(me.body.agent.id, result.result.agent.agent_id);
  await assert.rejects(wl.request("POST", "/api/v1/posts", { body: { type: "signal", title: "t", body: "b" } }), (error) => error instanceof MeshApiError && error.code === "permission_denied" && error.permission === "posts.publish" && /Post to the team feed/.test(error.message));
  const readOnly = session.workloadSession(result.result.agent.agent_id, { scopes: ["agent.read"] });
  assert.equal((await readOnly.request("GET", "/api/v1/agents/me")).status, 200);
});
