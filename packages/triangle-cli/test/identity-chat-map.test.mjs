import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../src/cli.mjs";
import {
  defaultChatMapStoreRoot,
  identityChatMapConfirm,
  identityChatMapRevoke,
  identityChatMapSet,
  renderChatMapPlan,
} from "../src/identity-chat-map.mjs";
import { deriveClientInstanceId } from "../../agent-worker/src/identity-primitives.mjs";
import { updateIdentityRegistry } from "../../agent-worker/src/identity-registry.mjs";
import { deriveChatSelectorId, readChatMappings } from "../../agent-worker/src/local-chat-mapping.mjs";
import { agentBindingV1, peerBindingV2, upgradeThroughWriter } from "../../agent-worker/test/identity-registry-v2-helpers.mjs";
import { markerRelease } from "./owner-approval-release-fixture.mjs";

const PRINCIPAL_MESH = "agent_" + "1".repeat(32);
const PRINCIPAL_PEER = "peer_" + "2".repeat(32);
const SESSION_ADDR = "session-" + "9".repeat(64);
const ORIGIN = "https://triangle.example";

function mkDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.chmodSync(dir, 0o700);
  return dir;
}

const meshBinding = agentBindingV1("claude", {
  principal_id: PRINCIPAL_MESH,
  authority_origin: ORIGIN,
  binding_generation: 1,
});
const peerBinding = peerBindingV2("peer-one", {
  principal_id: PRINCIPAL_PEER,
  binding_generation: 1,
});

function setupRegistry(registryRoot) {
  updateIdentityRegistry({
    root: registryRoot,
    expectedSequence: 0,
    actor: "owner",
    action: "init",
    now: "2026-11-12T00:00:00.000Z",
    mutate: (reg) => reg,
  });
  updateIdentityRegistry({
    root: registryRoot,
    expectedSequence: 1,
    actor: "owner",
    action: "bind",
    subject: meshBinding.profile_instance_id,
    now: "2026-11-12T00:00:00.000Z",
    mutate: (reg) => {
      reg.bindings[meshBinding.profile_instance_id] = meshBinding;
      return reg;
    },
  });
  upgradeThroughWriter(registryRoot, { now: "2026-11-12T00:01:00.000Z" });
}

function mockApprovalProvider() {
  return {
    authenticate() {
      return 'approved';
    },
  };
}

test("identity chat-map set, confirm and revoke (each D5-C) lifecycle on the installed layout", async () => {
  // The installed layout: <application root>/client is --client-root, its state root is client/local, and the registry is a sibling of client.
  const root = mkDir("triangle-cli-chat-map-");
  const clientRoot = path.join(root, "client");
  const storeRoot = path.join(clientRoot, "local");
  const registryRoot = path.join(root, "identity");
  const workspace = mkDir("triangle-ws-");
  fs.mkdirSync(clientRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(registryRoot, { recursive: true, mode: 0o700 });
  setupRegistry(registryRoot);
  const realWs = fs.realpathSync(workspace);

  try {
    // CD-2: rejects serverless peer principal
    await assert.rejects(() => identityChatMapSet({
      storeRoot,
      registryRoot,
      principal: PRINCIPAL_PEER,
      harness: "claude",
      workspace: realWs,
    }), { code: "invalid_owner_operation" });

    // 1. Plan & Apply Set (D5-C)
    const setPlan = await identityChatMapSet({
      storeRoot,
      registryRoot,
      principal: PRINCIPAL_MESH,
      harness: "claude",
      workspace: realWs,
    });
    assert.equal(setPlan.action, "set");
    const setRes = await identityChatMapSet({
      storeRoot,
      registryRoot,
      principal: PRINCIPAL_MESH,
      harness: "claude",
      workspace: realWs,
      confirm: setPlan.planId,
      provider: mockApprovalProvider(),
    });
    assert.equal(setRes.state, "pending");
    assert.equal(setRes.sequence, 1);

    // 2. Plan & Apply Confirm (D5-C: OS owner approval of the exact session)
    const live = [{ address: SESSION_ADDR, harness: "claude", workspace: realWs }];
    const confirmPlan = await identityChatMapConfirm({
      storeRoot,
      selectorId: setRes.selectorId,
      attachedSessions: live,
    });
    assert.equal(confirmPlan.sessionAddress, SESSION_ADDR);
    assert.equal(confirmPlan.bindingGeneration, 1);

    await assert.rejects(() => identityChatMapConfirm({
      storeRoot,
      selectorId: setRes.selectorId,
      attachedSessions: live,
      confirm: confirmPlan.planId,
      provider: { authenticate: async () => "denied" },
    }), { code: "owner_approval_denied" });
    assert.equal((await import("../../agent-worker/src/local-chat-mapping.mjs")).readChatMappings({ storeRoot }).mappings[setRes.selectorId].state, "pending");

    const confirmed = await identityChatMapConfirm({
      storeRoot,
      selectorId: setRes.selectorId,
      attachedSessions: live,
      confirm: confirmPlan.planId,
      provider: mockApprovalProvider(),
    });
    assert.equal(confirmed.state, "confirmed");
    assert.equal(confirmed.sessionAddress, SESSION_ADDR);
    assert.equal(confirmed.sequence, 2);

    // 3. Plan & Apply Revoke via CLI (`main`)
    const outPlan = [];
    const code1 = await main([
      "identity", "chat-map", "revoke",
      "--selector", setRes.selectorId,
      "--client-root", clientRoot,
      "--json",
    ], {
      io: { stdout: (s) => outPlan.push(s), stderr: () => {} },
      env: {},
    });
    assert.equal(code1, 0);
    const revokePlan = JSON.parse(outPlan.join(""));

    const outApply = [];
    const code2 = await main([
      "identity", "chat-map", "revoke",
      "--selector", setRes.selectorId,
      "--client-root", clientRoot,
      "--confirm", revokePlan.planId,
      "--json",
    ], {
      io: { stdout: (s) => outApply.push(s), stderr: () => {} },
      env: {},
      identityDependencies: {
        isTerminal: true,
        chatMapProvider: mockApprovalProvider(),
      },
    });
    assert.equal(code2, 0);
    const revokeRes = JSON.parse(outApply.join(""));
    assert.equal(revokeRes.revoked, true);
    assert.equal(revokeRes.sequence, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function releaseFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-map-release-")));
  const release = path.join(root, "release");
  const executable = path.join(release, "bin/triangle-owner-approval");
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
  fs.chmodSync(release, 0o700);
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const manifest = {
    schema: 1,
    platform: "darwin",
    arch: process.arch,
    testOnly: false,
    signingMode: "public_ad_hoc",
    credentialCustody: "file",
    ownerApproval: { version: 1, binary: "bin/triangle-owner-approval", commands: ["identity.chat-map"] },
    files: [{ path: "bin/triangle-owner-approval", mode: 0o700, sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") }],
  };
  fs.writeFileSync(path.join(release, "package-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return { root, release };
}

test("packaged chat-map set, confirm, and revoke use the identity.chat-map allowlist", async () => {
  const release = releaseFixture();
  const root = mkDir("triangle-cli-chat-map-allow-");
  const storeRoot = path.join(root, "store");
  const registryRoot = path.join(root, "identity");
  const workspace = mkDir("triangle-ws-allow-");
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(registryRoot, { recursive: true, mode: 0o700 });
  setupRegistry(registryRoot);
  const realWs = fs.realpathSync(workspace);
  const live = [{ address: SESSION_ADDR, harness: "claude", workspace: realWs }];
  const packaged = { releaseRoot: release.release, platform: "darwin", signal: AbortSignal.abort() };
  try {
    const setPlan = await identityChatMapSet({ storeRoot, registryRoot, principal: PRINCIPAL_MESH, harness: "claude", workspace: realWs });
    await assert.rejects(() => identityChatMapSet({
      storeRoot, registryRoot, principal: PRINCIPAL_MESH, harness: "claude", workspace: realWs,
      confirm: setPlan.planId, ...packaged,
    }), { code: "owner_approval_cancelled" });
    await identityChatMapSet({
      storeRoot, registryRoot, principal: PRINCIPAL_MESH, harness: "claude", workspace: realWs,
      confirm: setPlan.planId, provider: mockApprovalProvider(),
    });
    const confirmPlan = await identityChatMapConfirm({ storeRoot, harness: "claude", workspace: realWs, attachedSessions: live });
    await assert.rejects(() => identityChatMapConfirm({
      storeRoot, harness: "claude", workspace: realWs, attachedSessions: live,
      confirm: confirmPlan.planId, ...packaged,
    }), { code: "owner_approval_cancelled" });
    await identityChatMapConfirm({
      storeRoot, harness: "claude", workspace: realWs, attachedSessions: live,
      confirm: confirmPlan.planId, provider: mockApprovalProvider(),
    });
    const revokePlan = await identityChatMapRevoke({ storeRoot, harness: "claude", workspace: realWs });
    await assert.rejects(() => identityChatMapRevoke({
      storeRoot, harness: "claude", workspace: realWs, confirm: revokePlan.planId, ...packaged,
    }), { code: "owner_approval_cancelled" });
  } finally {
    fs.rmSync(release.root, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- the layout, the printed commands and the gates (review of #180 to #182, M4 and M5)

// The installed layout, with a space in the path as "The Triangle" has: <app>/client is --client-root, <app>/identity is the registry. Without a
// `stateRoot` the client has no configuration and its state root is client/local; with one, the configuration names it.
function chatWorld(t, { stateRoot = null, appName = "The Triangle" } = {}) {
  const base = mkDir("triangle-cli-cm-");
  const app = path.join(base, appName);
  const clientRoot = path.join(app, "client");
  const registryRoot = path.join(app, "identity");
  const workspace = mkDir("triangle-ws-");
  fs.mkdirSync(clientRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(registryRoot, { mode: 0o700 });
  const state = stateRoot ? path.join(base, stateRoot) : path.join(clientRoot, "local");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  if (stateRoot) {
    fs.writeFileSync(path.join(clientRoot, "local-messaging.json"), JSON.stringify({
      version: 1, enabled: true, stateRoot: state, bindingPath: path.join(state, "binding.json"), integrationPath: path.join(state, "integration.json"),
      recipients: [{ profile: "alpha", instanceId: deriveClientInstanceId("alpha") }],
    }), { mode: 0o600 });
  }
  setupRegistry(registryRoot);
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const realWs = fs.realpathSync(workspace);
  const selectorId = deriveChatSelectorId({ harness: "claude", workspace: realWs });
  const live = [{ address: SESSION_ADDR, harness: "claude", workspace: realWs }];
  const calls = { n: 0 };
  const provider = { authenticate() { calls.n += 1; return "approved"; } };
  const run = async (args, { env = {}, terminal = true } = {}) => {
    const out = [];
    const err = [];
    const code = await main(["identity", "chat-map", ...args], {
      env,
      io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
      identityDependencies: { isTerminal: terminal, chatMapProvider: provider, attachedSessions: live },
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const target = ["--client-root", clientRoot];
  const setArgs = ["set", "--principal", PRINCIPAL_MESH, "--harness", "claude", "--workspace", realWs, ...target];
  const confirmArgs = ["confirm", "--selector", selectorId, ...target];
  const revokeArgs = ["revoke", "--selector", selectorId, ...target];
  const plan = async (args) => JSON.parse((await run([...args, "--json"])).out);
  const storeFile = path.join(state, "chat-mappings-v1.json");
  const store = () => { try { return fs.readFileSync(storeFile, "utf8"); } catch { return null; } };
  const library = { storeRoot: state, registryRoot, principal: PRINCIPAL_MESH, harness: "claude", workspace: realWs };
  return { clientRoot, registryRoot, state, realWs, selectorId, live, calls, provider, run, plan, setArgs, confirmArgs, revokeArgs, store, library };
}

// The words of a command line as the plan prints it: single quotes, with '\'' for a quote inside.
function shellWords(line) {
  const words = [];
  let current = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'") {
      current ??= "";
      for (i += 1; i < line.length && line[i] !== "'"; i += 1) current += line[i];
    } else if (c === "\\") {
      current = (current ?? "") + line[(i += 1)];
    } else if (c === " ") {
      if (current !== null) words.push(current);
      current = null;
    } else {
      current = (current ?? "") + c;
    }
  }
  if (current !== null) words.push(current);
  return words;
}

test("the store is in the state root of the client configuration, in client/local without one, and --store-root wins (M5)", async (t) => {
  const plain = chatWorld(t);
  const p = await plain.plan(plain.setArgs);
  assert.equal(p.operation.storeRoot, path.join(plain.clientRoot, "local"));
  const applied = await plain.run([...plain.setArgs, "--confirm", p.planId]);
  assert.equal(applied.code, 0, applied.err);
  assert.equal(readChatMappings({ storeRoot: plain.state }).mappings[plain.selectorId].state, "pending");

  // a configuration that names another state root: the store is there, and nothing is made in client/local
  const configured = chatWorld(t, { stateRoot: "custom-state" });
  const q = await configured.plan(configured.setArgs);
  assert.equal(q.operation.storeRoot, configured.state);
  const done = await configured.run([...configured.setArgs, "--confirm", q.planId]);
  assert.equal(done.code, 0, done.err);
  assert.equal(readChatMappings({ storeRoot: configured.state }).mappings[configured.selectorId].state, "pending");
  assert.equal(fs.existsSync(path.join(configured.clientRoot, "local")), false);
  const revokePlan = await configured.plan(configured.revokeArgs);
  assert.equal(revokePlan.operation.storeRoot, configured.state, "the other actions read the same store");

  // an explicit --store-root is used as given
  const elsewhere = mkDir("triangle-cli-store-");
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  assert.equal((await configured.plan([...configured.setArgs, "--store-root", elsewhere])).operation.storeRoot, elsewhere);

  // a configuration the supervisor would refuse is not trusted: the file readable by others
  const configFile = path.join(configured.clientRoot, "local-messaging.json");
  assert.equal(await defaultChatMapStoreRoot(configured.clientRoot), configured.state);
  fs.chmodSync(configFile, 0o644);
  assert.equal(await defaultChatMapStoreRoot(configured.clientRoot), path.join(configured.clientRoot, "local"));
});

test("defaultChatMapStoreRoot uses a canonical absolute state root of the configuration and the client's local directory otherwise (M5)", async () => {
  const client = "/nowhere/client";
  const fallback = path.join(client, "local");
  const answering = (config) => () => config;
  assert.equal(await defaultChatMapStoreRoot(client, { loadConfig: answering({ stateRoot: "/var/state/triangle" }) }), "/var/state/triangle");
  for (const stateRoot of ["relative/state", "/var/state/../state", "/var/state/", "/var//state", "", null, 7, undefined]) {
    assert.equal(await defaultChatMapStoreRoot(client, { loadConfig: answering({ stateRoot }) }), fallback, String(stateRoot));
  }
  assert.equal(await defaultChatMapStoreRoot(client, { loadConfig: answering(null) }), fallback);
  assert.equal(await defaultChatMapStoreRoot(client, { loadConfig: () => { throw new Error("damaged"); } }), fallback);
  const asked = [];
  await defaultChatMapStoreRoot(client, { loadConfig: (file) => { asked.push(file); return {}; } });
  assert.deepEqual(asked, [path.join(client, "local-messaging.json")]);
  assert.equal(await defaultChatMapStoreRoot("/nowhere/no-such-client"), "/nowhere/no-such-client/local", "no configuration at all");
});

test("the apply command a plan prints runs as printed, with the client root it was planned with (M5)", async (t) => {
  const w = chatWorld(t);
  const lastLine = (r) => r.out.trim().split("\n").at(-1);
  const runPrinted = async (planned) => {
    assert.equal(planned.code, 0, planned.err);
    const words = shellWords(lastLine(planned));
    assert.deepEqual(words.slice(0, 3), ["triangle", "identity", "chat-map"]);
    assert.equal(words[words.indexOf("--client-root") + 1], w.clientRoot, "the client root, with the space of its path");
    return w.run(words.slice(3));
  };
  const set = await runPrinted(await w.run(w.setArgs));
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /Set pending chat mapping/);
  const confirm = await runPrinted(await w.run(w.confirmArgs));
  assert.equal(confirm.code, 0, confirm.err);
  assert.match(confirm.out, /Confirmed chat mapping/);
  const revoke = await runPrinted(await w.run(w.revokeArgs));
  assert.equal(revoke.code, 0, revoke.err);
  assert.match(revoke.out, /Revoked chat mapping/);
  assert.equal(w.calls.n, 3, "each was approved once");

  // a library caller that has no client root prints commands without one
  const libraryPlan = await identityChatMapSet(w.library);
  assert.doesNotMatch(renderChatMapPlan(libraryPlan), /--client-root/);
  assert.match(renderChatMapPlan(libraryPlan, { clientRoot: "/a b/client" }), / --client-root '\/a b\/client' --store-root /);
});

test("applying needs a local owner terminal: not without one, and not over SSH, for set, confirm and revoke (B1, B3)", async (t) => {
  const w = chatWorld(t);
  const gates = [
    ["no terminal", { terminal: false, env: {} }],
    ["SSH_CONNECTION", { terminal: true, env: { SSH_CONNECTION: "10.0.0.1 51000 10.0.0.2 22" } }],
    ["SSH_CLIENT", { terminal: true, env: { SSH_CLIENT: "10.0.0.1 51000 22" } }],
    ["SSH_TTY", { terminal: true, env: { SSH_TTY: "/dev/ttys001" } }],
  ];
  const refused = async (args, planId) => {
    const before = w.store();
    for (const [name, gate] of gates) {
      const r = await w.run([...args, "--confirm", planId], gate);
      assert.equal(r.code, 2, `${args[0]} ${name}`);
      assert.match(r.err, /requires a local owner terminal/, `${args[0]} ${name}`);
      assert.equal(w.store(), before, `${args[0]} ${name}: nothing changed`);
    }
    assert.equal(w.calls.n, applied, "nobody was asked");
  };
  let applied = 0;
  const apply = async (args) => {
    const planId = (await w.plan(args)).planId;
    await refused(args, planId);
    const r = await w.run([...args, "--confirm", planId]);
    assert.equal(r.code, 0, r.err);
    applied += 1;
    assert.equal(w.calls.n, applied);
  };
  await apply(w.setArgs);
  await apply(w.confirmArgs);
  await apply(w.revokeArgs);
});

test("a plan id that is not the current plan applies nothing, for set, confirm and revoke (B4)", async (t) => {
  const w = chatWorld(t);
  const zeros = "0".repeat(64);
  const refuses = async (args) => {
    const before = w.store();
    const wrong = await w.run([...args, "--confirm", zeros]);
    assert.equal(wrong.code, 2, args[0]);
    assert.match(wrong.err, /plan_stale/, args[0]);
    for (const malformed of ["abc", "A".repeat(64), "g".repeat(64), "0".repeat(63), "0".repeat(65)]) {
      assert.notEqual((await w.run([...args, "--confirm", malformed])).code, 0, `${args[0]} ${malformed}`);
    }
    assert.equal(w.store(), before, `${args[0]}: nothing changed`);
    assert.equal(w.calls.n, applied, `${args[0]}: nobody was asked`);
  };
  let applied = 0;
  const apply = async (args) => {
    const r = await w.run([...args, "--confirm", (await w.plan(args)).planId]);
    assert.equal(r.code, 0, r.err);
    applied += 1;
  };
  await refuses(w.setArgs);
  await apply(w.setArgs);
  await refuses(w.confirmArgs);
  const staleRevoke = (await w.plan(w.revokeArgs)).planId;
  await apply(w.confirmArgs);
  await refuses(w.revokeArgs);
  // a plan that was right when it was made and is not any more
  const afterConfirm = w.store();
  const stale = await w.run([...w.revokeArgs, "--confirm", staleRevoke]);
  assert.equal(stale.code, 2);
  assert.match(stale.err, /plan_stale/);
  assert.equal(w.store(), afterConfirm);
  await apply(w.revokeArgs);

  // the library says the same with codes
  const fresh = chatWorld(t);
  await assert.rejects(identityChatMapSet({ ...fresh.library, confirm: zeros, provider: fresh.provider }), { code: "plan_stale" });
  await assert.rejects(identityChatMapSet({ ...fresh.library, confirm: "abc", provider: fresh.provider }), { code: "confirmation_mismatch" });
  await assert.rejects(identityChatMapSet({ ...fresh.library, confirm: 7, provider: fresh.provider }), { code: "confirmation_mismatch" });
  assert.equal(fresh.calls.n, 0);
  assert.equal(fresh.store(), null);
});

test("each chat-map action asks the packaged approval for the identity.chat-map capability and no other (P7)", async (t) => {
  const wrong = markerRelease(["identity.destination"]);
  const right = markerRelease(["identity.chat-map"]);
  t.after(() => { wrong.cleanup(); right.cleanup(); });
  for (const [label, release, shouldStart] of [["a package that allows only identity.destination", wrong, false], ["a package that allows identity.chat-map", right, true]]) {
    for (const action of ["set", "confirm", "revoke"]) {
      const w = chatWorld(t);
      if (action !== "set") {
        const planned = await identityChatMapSet(w.library);
        await identityChatMapSet({ ...w.library, confirm: planned.planId, provider: w.provider });
      }
      const common = { storeRoot: w.state, selectorId: w.selectorId, platform: "darwin", releaseRoot: release.release };
      let attempt;
      if (action === "set") {
        const planned = await identityChatMapSet(w.library);
        attempt = () => identityChatMapSet({ ...w.library, confirm: planned.planId, platform: "darwin", releaseRoot: release.release });
      } else if (action === "confirm") {
        const planned = await identityChatMapConfirm({ storeRoot: w.state, selectorId: w.selectorId, attachedSessions: w.live });
        attempt = () => identityChatMapConfirm({ ...common, attachedSessions: w.live, confirm: planned.planId });
      } else {
        const planned = await identityChatMapRevoke({ storeRoot: w.state, selectorId: w.selectorId });
        attempt = () => identityChatMapRevoke({ ...common, confirm: planned.planId });
      }
      release.reset();
      const before = w.store();
      await assert.rejects(attempt, { code: "owner_approval_unavailable" }, `${action} with ${label}`);
      assert.equal(release.started(), shouldStart, `${action} with ${label}: the approval binary ${shouldStart ? "is" : "is not"} started`);
      assert.equal(w.store(), before, `${action} with ${label}: nothing changed`);
    }
  }
});

test("the help text says what applying needs and where the store is (M5)", async () => {
  const out = [];
  assert.equal(await main(["--help"], { env: {}, io: { stdout: (s) => out.push(s), stderr: () => {} } }), 0);
  const help = out.join("\n");
  assert.match(help, /identity chat-map set --principal AGENT_ID --harness claude\|codex --workspace DIR --client-root DIR/);
  assert.match(help, /Applying set, confirm or revoke needs a local owner terminal and OS authentication\./);
  assert.match(help, /The store is in the state root of the client configuration unless --store-root says otherwise\./);
  assert.doesNotMatch(help, /D5-B/);
});

test("an explicit --store-root must be an absolute path, and is refused before anything is read (M5)", async (t) => {
  const w = chatWorld(t);
  for (const bad of ["relative/store", "./store", "store"]) {
    for (const args of [w.setArgs, w.confirmArgs, w.revokeArgs]) {
      const r = await w.run([...args, "--store-root", bad]);
      assert.notEqual(r.code, 0, `${args[0]} ${bad}`);
      assert.match(r.err, /--store-root must be an absolute path/, `${args[0]} ${bad}`);
    }
  }
  // given without a value it is not a path either
  const missing = await w.run([...w.revokeArgs, "--store-root"]);
  assert.notEqual(missing.code, 0);
  assert.equal(w.store(), null);
  assert.equal(w.calls.n, 0);
});

test("the printed apply commands survive a real shell for application roots with quotes, dollar signs, backticks, parentheses, globs and spaces (M5)", async (t) => {
  for (const [label, appName] of [["a quote", "it's here"], ["a dollar sign and a backtick", "a $HOME `id` $(id) b"], ["a glob", "a*b?[c]"], ["spaces and parentheses", "The (Triangle) app"]]) {
    const w = chatWorld(t, { appName });
    // The shell reads the printed line as a call of a function that prints its arguments NUL-separated, so nothing is expanded or run.
    const parse = (out) => {
      const command = out.split("To apply this exact plan:\n")[1];
      const script = 'triangle(){ for a in "$@"; do printf "%s\\0" "$a"; done; }\n' + command + "\n";
      return execFileSync("/bin/bash", ["-c", script], { encoding: "utf8" }).split("\0").slice(0, -1);
    };
    for (const [action, args] of [["set", w.setArgs], ["confirm", w.confirmArgs], ["revoke", w.revokeArgs]]) {
      const planned = await w.run(args);
      assert.equal(planned.code, 0, `${label} ${action}: ${planned.err}`);
      const words = parse(planned.out);
      assert.deepEqual(words.slice(0, 3), ["identity", "chat-map", action], label);
      assert.equal(words[words.indexOf("--client-root") + 1], w.clientRoot, `${label} ${action}: the client root as planned`);
      assert.equal(words[words.indexOf("--store-root") + 1], w.state, `${label} ${action}: the store root as planned`);
      const applied = await w.run(words.slice(2));
      assert.equal(applied.code, 0, `${label} ${action}: ${applied.err}`);
    }
  }
});
