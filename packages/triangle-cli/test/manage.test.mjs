import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.mjs";
import { collectPermissionsModel } from "../src/read-model.mjs";
import { parseChanges } from "../src/permissions.mjs";
import { createFakeAuthority } from "./fake-authority.mjs";

const AUTH = "https://mesh.test";
const tmpHome = () => path.join(mkdtempSync(path.join(os.tmpdir(), "triangle-manage-")), "home");

function runner(fake, home) {
  return async (...argv) => {
    const out = [];
    const err = [];
    const code = await main([...argv, "--home", home], { env: {}, fetchImpl: fake.fetchImpl, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } });
    return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")), lines: () => out.join("\n").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
  };
}

async function owner(fake, handle = "alpha-agent") {
  const home = tmpHome();
  const run = runner(fake, home);
  const joined = await run("join", fake.mintInvite().link, "--name", "Owner", "--handle", handle, "--device-label", "Desk", "--json");
  assert.equal(joined.code, 0, joined.err);
  return { home, run, agentId: joined.json().result.agent.agent_id, ownerId: joined.json().result.owner_id };
}

test("parseChanges accepts on/off forms and refuses junk", () => {
  assert.deepEqual(parseChanges(["posts.publish=on", "dm.send=OFF"]), { "posts.publish": true, "dm.send": false });
  for (const bad of [[], ["posts.publish"], ["posts.publish=maybe"], ["a=on", "a=off"]]) assert.throws(() => parseChanges(bad), TypeError);
});

test("permissions show: conditional read sends If-None-Match and reuses the cache on 304", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { run } = await owner(fake);
  const first = await run("permissions", "show", "--json");
  assert.equal(first.code, 0, first.err);
  assert.equal(first.json().from_cache, false);
  assert.equal(first.json().permissions["posts.publish"], false);
  const second = await run("permissions", "show", "--json");
  assert.equal(second.json().from_cache, true);
  const gets = fake.state.requests.filter((r) => r.method === "GET" && r.path.endsWith("/permissions"));
  assert.equal(gets.at(-1).headers["if-none-match"], 'W/"1"');
  const human = await run("permissions", "show");
  assert.match(human.out, /\[off\] Post to the team feed\s+posts\.publish/);
});

test("permissions set: owner-signed full object against the read revision; the workload sees the change", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { run, home, agentId } = await owner(fake);
  const set = await run("permissions", "set", "alpha-agent", "posts.publish=on", "--json");
  assert.equal(set.code, 0, set.err);
  assert.equal(set.json().revision, 2);
  assert.equal(set.json().permissions["posts.publish"], true);
  const sent = fake.state.requests.filter((r) => r.method === "POST" && r.path === `/api/v1/agents/${agentId}/permissions`).at(-1).body;
  assert.equal(sent.expected_revision, 1);
  assert.deepEqual(Object.keys(sent.permissions).sort(), ["directory.listed", "dm.receive", "dm.send", "permissions_version", "posts.publish", "tasks.claim"]);
  assert.equal(existsSync(path.join(home, "journal")) && (await import("node:fs")).readdirSync(path.join(home, "journal")).length, 0);
  const again = await run("permissions", "set", "alpha-agent", "posts.publish=on", "--json");
  assert.equal(again.json().outcome, "unchanged", "no write when already in the requested state");
  const history = await run("permissions", "history", "alpha-agent", "--json");
  assert.deepEqual(history.json().entries.map((e) => e.revision), [2, 1]);
  assert.match((await run("permissions", "history", "--limit", "1")).out, /rev 2 .*posts\.publish on .*from Desk/);
});

test("permissions set: a concurrent change → 409 re-read; exit 4 with the latest state, nothing overwritten", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const realFetch = fake.fetchImpl;
  let raced = false;
  const fake2Home = (await owner(fake, "beta-agent")).home;
  const agent2 = [...fake.state.agents.entries()].find(([, a]) => a.handle === "beta-agent")[0];
  const racing2 = async (input, init) => {
    const request = new Request(input, init);
    if (!raced && request.method === "POST" && request.url.endsWith(`/agents/${agent2}/permissions`)) {
      raced = true;
      const agent = fake.state.agents.get(agent2);
      agent.permissions = { ...agent.permissions, "dm.send": false };
      agent.revision += 1;
    }
    return realFetch(request);
  };
  const err2 = [];
  const exit = await main(["permissions", "set", "beta-agent", "tasks.claim=on", "--home", fake2Home], { env: {}, fetchImpl: racing2, io: { stdout: () => {}, stderr: (s) => err2.push(s) } });
  assert.equal(exit, 4);
  assert.match(err2.join("\n"), /changed these permissions first/);
  assert.match(err2.join("\n"), /\[off\] Start conversations/);
  const agent = fake.state.agents.get(agent2);
  assert.equal(agent.permissions["dm.send"], false, "the other device's change survives");
  assert.equal(agent.permissions["tasks.claim"], false, "ours was not applied over it");
  assert.equal(existsSync(path.join(fake2Home, "journal")) ? (await import("node:fs")).readdirSync(path.join(fake2Home, "journal")).length : 0, 0, "a refused update leaves no journal");
});

test("permissions: keys unknown to this client are shown read-only, preserved on write, and cannot be set", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { run, agentId } = await owner(fake);
  fake.state.extraCatalogKeys = ["calendar.read"];
  const agent = fake.state.agents.get(agentId);
  agent.permissions = { ...agent.permissions, "calendar.read": true };
  const show = await run("permissions", "show");
  assert.match(show.out, /calendar\.read \(read-only/);
  const set = await run("permissions", "set", "alpha-agent", "dm.send=off", "--json");
  assert.equal(set.code, 0, set.err);
  assert.equal(fake.state.agents.get(agentId).permissions["calendar.read"], true);
  const refused = await run("permissions", "set", "alpha-agent", "calendar.read=off");
  assert.equal(refused.code, 2);
  assert.match(refused.err, /not a permission this version of triangle can change/);
});

test("permissions set: lost response → `triangle resume` replays the signed update", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { run, agentId } = await owner(fake);
  fake.state.failNext = "drop-after-commit";
  fake.state.failPath = /\/permissions$/;
  assert.equal((await run("permissions", "set", "alpha-agent", "posts.publish=on")).code, 3);
  const resumed = await run("resume", "--json");
  assert.equal(resumed.code, 0, resumed.err);
  assert.deepEqual(resumed.lines().map((d) => [d.operation, d.outcome]), [["permissions-update", "replayed"]]);
  assert.equal(fake.state.agents.get(agentId).revision, 2, "applied exactly once");
});

test("invites: teammate link redeems for a new owner; the secret never reaches the server; revoke works", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { run } = await owner(fake);
  const invite = await run("invite", "teammate", "--role", "member", "--name-hint", "Sam", "--json");
  assert.equal(invite.code, 0, invite.err);
  const { link, invite_id: inviteId } = invite.json().invite;
  const secret = link.split(".").at(-1);
  assert.equal(JSON.stringify(fake.state.requests).includes(secret), false, "only the hash was sent");
  const teammate = runner(fake, tmpHome());
  const joined = await teammate("join", link, "--name", "Sam", "--handle", "sam-agent", "--json");
  assert.equal(joined.code, 0, joined.err);
  assert.equal(joined.json().result.owner_role, "member");
  assert.notEqual(joined.json().result.owner_id, (await run("status", "--json")).json().owner.id);
  const second = await run("invite", "teammate", "--json");
  const revoked = await run("invite", "revoke", second.json().invite.invite_id);
  assert.equal(revoked.code, 0, revoked.err);
  assert.equal((await runner(fake, tmpHome())("join", second.json().invite.link)).code, 1);
  assert.ok(inviteId);
});

test("devices: device invite → pending device → approve by fingerprint → it can manage agents; revoke protects the last device", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { run: desk } = await owner(fake);
  const invite = await desk("invite", "device", "--json");
  assert.equal(invite.code, 0, invite.err);
  const laptopHome = tmpHome();
  const laptop = runner(fake, laptopHome);
  const joined = await laptop("join", invite.json().invite.link, "--device-label", "Laptop");
  assert.equal(joined.code, 0, joined.err);
  const fp = /approve ([A-Z0-9_-]{4}(?:-[A-Z0-9_-]{4}){3})/.exec(joined.out)[1];
  const early = await laptop("permissions", "show", "alpha-agent");
  assert.equal(early.code, 1);
  assert.match(early.err, /waiting for approval/);
  assert.equal((await desk("device", "approve", "ZZZZ-ZZZZ-ZZZZ-ZZZZ")).code, 1);
  const approved = await desk("device", "approve", fp.toLowerCase());
  assert.equal(approved.code, 0, approved.err);
  assert.match(approved.out, /Laptop .* is active/);
  const direct = await laptop("permissions", "show", "alpha-agent", "--json");
  assert.equal(direct.code, 0, `a command right after approval works without a status refresh: ${direct.err}`);
  const status = await laptop("status", "--json");
  assert.equal(status.json().device.state, "active", "the laptop notices its approval");
  assert.equal(JSON.parse(readFileSync(path.join(laptopHome, "owner", "controller.json"), "utf8")).state, "active");
  const fromLaptop = await laptop("permissions", "set", "alpha-agent", "dm.receive=off", "--json");
  assert.equal(fromLaptop.code, 0, fromLaptop.err);
  assert.ok(!(await desk("status", "--json")).json().warnings.some((w) => /No backup/.test(w)));
  const devices = await desk("device", "list", "--json");
  const deskFp = devices.json().find((d) => d.this_device).fingerprint;
  assert.equal((await desk("device", "revoke", deskFp)).code, 2, "revoking this device needs --yes");
  const revokeLaptop = await desk("device", "revoke", fp);
  assert.equal(revokeLaptop.code, 0, revokeLaptop.err);
  const last = await desk("device", "revoke", deskFp, "--yes");
  assert.equal(last.code, 1);
  assert.match(last.err, /last active device/);
});

test("agent lifecycle: pause blocks the workload, resume restores it, delete needs --yes and removes the local key", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { run, home, agentId } = await owner(fake);
  assert.match((await run("agent", "pause", "alpha-agent")).out, /alpha-agent is paused/);
  assert.ok((await run("status", "--json")).json().warnings.some((w) => /alpha-agent is paused/.test(w)));
  assert.match((await run("agent", "resume", "alpha-agent")).out, /is active/);
  const refused = await run("agent", "delete", "alpha-agent");
  assert.equal(refused.code, 2);
  assert.ok(existsSync(path.join(home, "agents", agentId, "workload-key.json")));
  const deleted = await run("agent", "delete", "alpha-agent", "--yes");
  assert.equal(deleted.code, 0, deleted.err);
  assert.equal(existsSync(path.join(home, "agents", agentId)), false);
  assert.equal(fake.state.requests.find((r) => r.path === `/api/v1/agents/${agentId}` && r.method !== "GET").method, "DELETE");
  assert.equal(fake.state.agents.get(agentId)?.state ?? "deleted", "deleted");
});

test("agent delete: a lost response is replayed with DELETE by `triangle resume`", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { run, home, agentId } = await owner(fake);
  fake.state.failNext = "drop-after-commit";
  fake.state.failPath = new RegExp(`/agents/${agentId}$`);
  assert.equal((await run("agent", "delete", "alpha-agent", "--yes")).code, 3);
  const resumed = await run("resume", "--json");
  assert.equal(resumed.code, 0, resumed.err);
  assert.deepEqual(resumed.lines().map((d) => [d.operation, d.outcome]), [["agent.delete", "replayed"]]);
  assert.ok(fake.state.requests.filter((r) => r.path === `/api/v1/agents/${agentId}`).every((r) => r.method === "DELETE"));
  assert.equal(existsSync(path.join(home, "agents", agentId)), false);
});

test("resume: each invite link is printed before its journal is removed, even if a later replay fails", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { home } = await owner(fake);
  for (let i = 0; i < 2; i += 1) {
    fake.state.failNext = "network";
    fake.state.failPath = /\/invites$/;
    assert.equal((await runner(fake, home)("invite", "teammate")).code, 3);
  }
  let posts = 0;
  const throttling = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST" && new URL(request.url).pathname === "/api/v1/invites" && ++posts === 2) {
      return new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), { status: 429, headers: { "content-type": "application/json" } });
    }
    return fake.fetchImpl(request);
  };
  const out = [];
  const exit = await main(["resume", "--home", home], { env: {}, fetchImpl: throttling, io: { stdout: (s) => out.push(s), stderr: () => {} } });
  assert.equal(exit, 1);
  assert.match(out.join("\n"), /link: https:\/\/mesh\.test\//, "the first link was delivered");
  const { readdirSync } = await import("node:fs");
  assert.equal(readdirSync(path.join(home, "journal")).filter((n) => n.startsWith("op-")).length, 1, "only the undelivered invite stays journaled");
});

test("resume: a stored permission update refused with revision_conflict is retired; latest state shown; exit 4", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { run, home, agentId } = await owner(fake);
  fake.state.failNext = "network";
  fake.state.failPath = /\/permissions$/;
  assert.equal((await run("permissions", "set", "alpha-agent", "tasks.claim=on")).code, 3);
  const agent = fake.state.agents.get(agentId);
  agent.permissions = { ...agent.permissions, "dm.send": false };
  agent.revision += 1;
  const resumed = await run("resume", "--json");
  assert.equal(resumed.code, 4, resumed.err);
  const [item] = resumed.lines();
  assert.equal(item.outcome, "revision_conflict");
  assert.equal(item.latest.revision, agent.revision);
  assert.equal(fake.state.agents.get(agentId).permissions["tasks.claim"], false, "not applied");
  const { readdirSync } = await import("node:fs");
  assert.equal(readdirSync(path.join(home, "journal")).filter((n) => n.startsWith("perm-")).length, 0);
  assert.equal((await run("resume")).code, 0, "nothing left to retry");
});

test("permissions set: a conflict whose winner chose the same values is still a conflict (exit 4)", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { home, agentId } = await owner(fake);
  let raced = false;
  const racing = async (input, init) => {
    const request = new Request(input, init);
    if (!raced && request.method === "POST" && request.url.endsWith(`/agents/${agentId}/permissions`)) {
      raced = true;
      const agent = fake.state.agents.get(agentId);
      agent.permissions = { ...agent.permissions, "tasks.claim": true };
      agent.revision += 1;
    }
    return fake.fetchImpl(request);
  };
  const exit = await main(["permissions", "set", "alpha-agent", "tasks.claim=on", "--home", home], { env: {}, fetchImpl: racing, io: { stdout: () => {}, stderr: () => {} } });
  assert.equal(exit, 4);
});

test("invite: a link that cannot be written to stdout keeps its journal (exit 3); resume prints it", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { home } = await owner(fake);
  const broken = { stdout: async () => { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); }, stderr: () => {} };
  const exit = await main(["invite", "teammate", "--home", home], { env: {}, fetchImpl: fake.fetchImpl, io: broken });
  assert.equal(exit, 3);
  const { readdirSync } = await import("node:fs");
  assert.equal(readdirSync(path.join(home, "journal")).filter((n) => n.startsWith("op-")).length, 1, "the only copy of the secret is kept");
  const resumed = await runner(fake, home)("resume");
  assert.equal(resumed.code, 0, resumed.err);
  assert.match(resumed.out, /link: https:\/\/mesh\.test\/join#/);
  assert.equal(readdirSync(path.join(home, "journal")).filter((n) => n.startsWith("op-")).length, 0);
});

function conflictThenUnreadable(fake, agentId) {
  let raced = false;
  return async (input, init) => {
    const request = new Request(input, init);
    const isPermissions = new URL(request.url).pathname === `/api/v1/agents/${agentId}/permissions`;
    if (!raced && request.method === "POST" && isPermissions) {
      raced = true;
      const agent = fake.state.agents.get(agentId);
      agent.permissions = { ...agent.permissions, "dm.send": false };
      agent.revision += 1;
    } else if (raced && request.method === "GET" && isPermissions) {
      return new Response(JSON.stringify({ error: { code: "unavailable", message: "try later" } }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return fake.fetchImpl(request);
  };
}

test("permissions set: a confirmed conflict stays exit 4 when the re-read fails", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { home, agentId } = await owner(fake);
  const err = [];
  const exit = await main(["permissions", "set", "alpha-agent", "tasks.claim=on", "--json", "--home", home], { env: {}, fetchImpl: conflictThenUnreadable(fake, agentId), io: { stdout: () => {}, stderr: (s) => err.push(s) } });
  assert.equal(exit, 4);
  const body = JSON.parse(err.join("\n"));
  assert.equal(body.latest, null);
  assert.ok(body.refresh_error);
});

test("resume: a confirmed conflict stays exit 4 when the re-read fails", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { run, home, agentId } = await owner(fake);
  fake.state.failNext = "network";
  fake.state.failPath = /\/permissions$/;
  assert.equal((await run("permissions", "set", "alpha-agent", "tasks.claim=on")).code, 3);
  const out = [];
  const exit = await main(["resume", "--json", "--home", home], { env: {}, fetchImpl: conflictThenUnreadable(fake, agentId), io: { stdout: (s) => out.push(s), stderr: () => {} } });
  assert.equal(exit, 4);
  const [item] = out.map((line) => JSON.parse(line));
  assert.equal(item.outcome, "revision_conflict");
  assert.equal(item.latest, null);
  assert.ok(item.refresh_error);
});

test("read model for client-console: secret-free, labelled toggles per agent", async () => {
  const fake = createFakeAuthority({ authority: AUTH });
  const { home } = await owner(fake);
  const model = await collectPermissionsModel({ home, env: {}, fetchImpl: fake.fetchImpl });
  assert.equal(model.joined, true);
  assert.equal(model.agents[0].permissions.find((p) => p.key === "posts.publish").label, "Post to the team feed");
  const ownerKey = JSON.parse(readFileSync(path.join(home, "owner", "owner-key.json"), "utf8"));
  assert.equal(JSON.stringify(model).includes(ownerKey.d), false);
  assert.equal(/"d":/.test(JSON.stringify(model)), false);
  const empty = await collectPermissionsModel({ home: tmpHome(), env: {}, fetchImpl: fake.fetchImpl });
  assert.equal(empty.joined, false);
});
