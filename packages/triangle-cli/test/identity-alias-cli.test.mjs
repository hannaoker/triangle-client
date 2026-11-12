// `triangle identity alias set|clear` (AD.2): scratch application roots with a client directory (and its local messaging configuration),
// a v2 identity registry built with the real writer, and a scripted supervisor status. Nothing here touches an installed host.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/cli.mjs";
import { aliasCommand, applyIdentityAlias, MAX_ALIASES, readLocalRecipients, renderAliasResult } from "../src/identity-alias.mjs";
import { LocalStateError } from "../src/errors.mjs";
import { identityStatus } from "../src/identity-status.mjs";
import { shellQuote } from "../src/identity-upgrade.mjs";
import { deriveClientInstanceId } from "../../agent-worker/src/identity-primitives.mjs";
import { clearIdentityAlias, MAX_REGISTRY_ALIASES, readIdentityRegistry, setIdentityAlias, updateIdentityRegistry } from "../../agent-worker/src/identity-registry.mjs";
import { bindProfileInRegistry, initIdentityRegistry, makeMeshManagedBinding, seedLegacyProfileBinding } from "../../agent-worker/test/local-messaging-identity-fixtures.mjs";
import { agentBindingV2, appendAndCommit, peerBindingV2, upgradeThroughWriter } from "../../agent-worker/test/identity-registry-v2-helpers.mjs";

const REGISTRY_FILE = "identity-registry-v1.json";
const AUDIT_FILE = "registry-audit.jsonl";
const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const principalOf = (profile) => makeMeshManagedBinding(profile).principal_id;
const recipientsOf = (...profiles) => profiles.map((profile) => ({ profile, instanceId: deriveClientInstanceId(profile) }));

// What a supervisor of the aliases release reports, and the variants the plan must tell apart
// a configuration the supervisor's own loader accepts (the command uses that loader), with the given recipients
const configFor = (recipients, extra = {}) => ({
  version: 1,
  enabled: true,
  stateRoot: "/tmp/alias-cli-state",
  bindingPath: "/tmp/alias-cli-state/binding.json",
  integrationPath: "/tmp/alias-cli-state/integration.json",
  recipients,
  ...extra,
});

const reportsFor = (registryRoot, over = {}) => ({
  ok: true,
  router: { enabled: true, registry: { state: "ok", sequence: 3, schema: "identity_registry_v2", supportedSchemas: ["identity_registry_v1", "identity_registry_v2"], rootSha256: sha256Hex(registryRoot), addressForms: ["alias", "id", "principal"], ...over.registry }, ...over.router },
});

function fixture(t, { profiles = ["alpha", "beta"], recipients = profiles, config = "ok", registry = "v2", twin = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alias-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "The Triangle");
  fs.mkdirSync(app, { mode: 0o700 });
  const client = path.join(app, "client");
  fs.mkdirSync(client, { mode: 0o700 });
  const reg = path.join(app, "identity");
  const configFile = path.join(client, "local-messaging.json");
  if (config === "ok") {
    fs.writeFileSync(configFile, JSON.stringify(configFor(recipientsOf(...recipients))), { mode: 0o600 });
  } else if (config === "loose") {
    fs.writeFileSync(configFile, JSON.stringify(configFor(recipientsOf(...recipients))), { mode: 0o644 });
  } else if (config === "no-recipients") {
    fs.writeFileSync(configFile, JSON.stringify({ ...configFor([]), recipients: undefined }), { mode: 0o600 });
  } else if (config === "disabled") {
    fs.writeFileSync(configFile, JSON.stringify(configFor(recipientsOf(...recipients), { enabled: false })), { mode: 0o600 });
  } else if (config === "garbage") {
    fs.writeFileSync(configFile, "{not json", { mode: 0o600 });
  }
  if (registry !== "absent") {
    initIdentityRegistry(reg);
    profiles.forEach((profile, index) => bindProfileInRegistry(reg, profile, index + 1));
    if (twin) seedLegacyProfileBinding(reg, "twin", profiles.length + 1, { principal_id: principalOf(profiles[0]) });
    if (registry === "v2") upgradeThroughWriter(reg, { now: new Date(Date.now() + 1000).toISOString() });
  }
  // after this fixture's registry was created, as the writer requires; each fixture has its own base, so a slow run cannot overtake it
  const start = Date.now() + 60_000;
  let tick = 0;
  const state = { status: reportsFor(reg), terminal: true };
  const dependencies = (extra = {}) => ({
    isTerminal: () => state.terminal,
    now: () => new Date(start + ++tick * 1000).toISOString(),
    runSupervisorStatus: async () => {
      if (state.status instanceof Error) throw state.status;
      return state.status;
    },
    ...extra,
  });
  const run = async (args, extra = {}) => {
    const out = [];
    const err = [];
    const code = await main(["identity", "alias", ...args, "--client-root", client, ...(extra.registryRoot ? ["--registry-root", extra.registryRoot] : [])], {
      env: {},
      io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
      identityDependencies: dependencies(extra.identityDependencies),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const plan = async (action, ...args) => JSON.parse((await run([action, ...args, "--json"])).out);
  const files = () => [REGISTRY_FILE, AUDIT_FILE].map((name) => (fs.existsSync(path.join(reg, name)) ? fs.readFileSync(path.join(reg, name)).toString("hex") : null));
  const listing = () => {
    const rows = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, entry.name);
        rows.push(`${path.relative(root, full)}:${entry.isDirectory() ? "dir" : fs.statSync(full).size}`);
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(root);
    return rows;
  };
  const registryNow = () => readIdentityRegistry({ root: reg });
  const seq = () => registryNow().registry.sequence;
  return { root, app, client, registry: reg, configFile, state, run, plan, files, listing, registryNow, seq, dependencies, start };
}

const apply = async (f, action, args, extra) => {
  const planned = await f.plan(action, ...args);
  return { planned, result: await f.run([action, ...args, "--confirm", planned.planId, "--json"], extra) };
};
const aliasesOf = (f) => Object.fromEntries(Object.entries(f.registryNow().registry.aliases).map(([name, record]) => [name, record.principal_id]));
const lastAudit = (f) => fs.readFileSync(path.join(f.registry, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);

// ---- the plan writes nothing, and says what it will do ---------------------------------------------------------------------------
test("a set plan writes nothing, names the registry state, the target and what a sender will see, and prints the apply command", async (t) => {
  const f = fixture(t);
  const before = { files: f.files(), listing: f.listing() };
  const human = await f.run(["set", "builder", "alpha"]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /Identity alias plan: set \(host-local; changes no identity, authority or other route\)/);
  assert.match(human.out, /Current:  v2 · sequence \d+ · 0 aliases · audit head [0-9a-f]{12}/);
  assert.match(human.out, /Alias:    builder\n/);
  assert.ok(human.out.includes(`Target:   alpha · ${principalOf("alpha")} · binding `));
  assert.match(human.out, /\[ok\]\s+the target is an active MESH-managed binding on exactly one local recipient/);
  assert.match(human.out, /a sender that may message alpha sees `builder` among that entry's send\.aliases/);
  assert.match(human.out, /cannot tell the alias exists/);
  assert.match(human.out, /Supervisor: The running supervisor resolves aliases/);
  assert.match(human.out, /Way back: triangle identity alias clear builder --client-root /);
  const plan = await f.plan("set", "builder", "alpha");
  assert.match(human.out, new RegExp(`Plan ID: ${plan.planId}`));
  assert.ok(human.out.includes(`triangle identity alias set builder alpha --client-root ${shellQuote(f.client)} --registry-root ${shellQuote(f.registry)} --confirm ${plan.planId}`), "the command is ready to paste, paths quoted");
  assert.deepEqual({ files: f.files(), listing: f.listing() }, before, "a plan changes nothing on disk");
  assert.equal(plan.schema, "identity_alias_plan_v1");
  assert.deepEqual([plan.action, plan.alias, plan.ready, plan.refusals], ["set", "builder", true, []]);
  assert.deepEqual({ ...plan.target }, { given: "alpha", principalId: principalOf("alpha"), bindingId: makeMeshManagedBinding("alpha").binding_id, profile: "alpha", profileInstanceId: deriveClientInstanceId("alpha") });
});

test("the target may be a profile name or the agent_ id, and both plan the same alias", async (t) => {
  const f = fixture(t);
  const byName = await f.plan("set", "builder", "alpha");
  const byId = await f.plan("set", "builder", principalOf("alpha"));
  assert.deepEqual([byId.ready, byId.target.profile, byId.target.principalId], [true, "alpha", principalOf("alpha")]);
  assert.deepEqual({ ...byName, targetGiven: 0, target: { ...byName.target, given: 0 }, planId: 0, advice: 0 }, { ...byId, targetGiven: 0, target: { ...byId.target, given: 0 }, planId: 0, advice: 0 }, "the same facts but for how the target was given");
  assert.deepEqual([byName.targetGiven, byId.targetGiven], ["alpha", principalOf("alpha")]);
  assert.notEqual(byName.planId, byId.planId, "the plan id covers how it was asked, so the apply command repeats the same words");
});

// ---- apply --------------------------------------------------------------------------------------------------------------------
test("the printed apply command repeats the target as it was given", async (t) => {
  const f = fixture(t);
  for (const target of ["alpha", principalOf("alpha")]) {
    const plan = await f.plan("set", "builder", target);
    const human = await f.run(["set", "builder", target]);
    assert.ok(human.out.includes(`triangle identity alias set builder ${target} --client-root ${shellQuote(f.client)} --registry-root ${shellQuote(f.registry)} --confirm ${plan.planId}`), target);
  }
});

test("apply sets the alias through the writer: one audited step, create-only, read back", async (t) => {
  const f = fixture(t);
  const sequenceBefore = f.seq();
  const { planned, result } = await apply(f, "set", ["builder", "alpha"]);
  assert.equal(result.code, 0, result.err);
  const done = JSON.parse(result.out);
  assert.deepEqual([done.schema, done.action, done.alias, done.principal, done.profile], ["identity_alias_result_v1", "set", "builder", principalOf("alpha"), "alpha"]);
  assert.deepEqual([done.from.sequence, done.to.sequence, done.auditEntry], [sequenceBefore, sequenceBefore + 1, "alias_set"]);
  assert.deepEqual(aliasesOf(f), { builder: principalOf("alpha") });
  const record = f.registryNow().registry.aliases.builder;
  assert.equal(record.generation, sequenceBefore + 1, "the generation is the sequence the entry commits at");
  assert.equal(record.set_at, lastAudit(f).at, "set_at is the audit entry's time");
  assert.deepEqual([lastAudit(f).action, lastAudit(f).subject], ["alias_set", "builder"]);
  // the same plan id is spent: the registry moved on
  const again = await f.run(["set", "builder", "alpha", "--confirm", planned.planId]);
  assert.deepEqual([again.code, /plan_stale/.test(again.err)], [2, true]);
  // create-only: the name is taken now, however it is pointed
  for (const target of ["alpha", "beta"]) {
    const refused = await f.plan("set", "builder", target);
    assert.deepEqual([refused.ready, refused.refusals], [false, ["alias_exists"]], target);
  }
  const text = await f.run(["set", "builder", "alpha", "--confirm", (await f.plan("clear", "builder")).planId]);
  assert.equal(text.code, 2, "a plan id for another action is not this plan");
});

test("human output of an applied set and of a cleared alias", async (t) => {
  const f = fixture(t);
  const set = await f.run(["set", "builder", "alpha", "--confirm", (await f.plan("set", "builder", "alpha")).planId]);
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /Set the alias builder for alpha \(agent_[0-9a-f]{32}\); registry sequence \d+ → \d+\./);
  assert.match(set.out, /triangle-local discover/);
  const clear = await f.run(["clear", "builder", "--confirm", (await f.plan("clear", "builder")).planId]);
  assert.equal(clear.code, 0, clear.err);
  assert.match(clear.out, /Cleared the alias builder \(it named alpha, agent_[0-9a-f]{32}\); registry sequence \d+ → \d+\./);
  assert.deepEqual(aliasesOf(f), {});
  assert.deepEqual([lastAudit(f).action, lastAudit(f).subject], ["alias_clear", "builder"]);
});

test("a target changes only by clear and then set, each step planned and audited", async (t) => {
  const f = fixture(t);
  assert.equal((await apply(f, "set", ["builder", "alpha"])).result.code, 0);
  assert.equal((await apply(f, "clear", ["builder"])).result.code, 0);
  assert.equal((await apply(f, "set", ["builder", "beta"])).result.code, 0);
  assert.deepEqual(aliasesOf(f), { builder: principalOf("beta") });
  const actions = fs.readFileSync(path.join(f.registry, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line).action);
  assert.deepEqual(actions.slice(-3), ["alias_set", "alias_clear", "alias_set"]);
  const generations = [f.registryNow().registry.aliases.builder.generation];
  assert.ok(generations[0] > 3, "a later set has a generation no earlier alias had");
});

test("the plan id covers the client root: the same facts under another client directory are another plan", async (t) => {
  const f = fixture(t);
  const other = path.join(f.app, "client-b");
  fs.mkdirSync(other, { mode: 0o700 });
  fs.copyFileSync(f.configFile, path.join(other, "local-messaging.json"));
  fs.chmodSync(path.join(other, "local-messaging.json"), 0o600);
  const planFrom = async (client) => {
    const out = [];
    const code = await main(["identity", "alias", "set", "builder", "alpha", "--client-root", client, "--json"], { env: {}, io: { stdout: (s) => out.push(s), stderr: () => {} }, identityDependencies: f.dependencies() });
    assert.equal(code, 0);
    return JSON.parse(out.join("\n"));
  };
  const a = await planFrom(f.client);
  const b = await planFrom(other);
  assert.deepEqual([a.ready, b.ready, a.registry, a.localMessaging.recipients], [true, true, b.registry, b.localMessaging.recipients]);
  assert.notEqual(a.planId, b.planId);
  const applied = await f.run(["set", "builder", "alpha", "--confirm", b.planId]);
  assert.deepEqual([applied.code, /plan_stale/.test(applied.err)], [2, true], "a plan made for another client directory is not this one");
});

// ---- the terminal and the plan id --------------------------------------------------------------------------------------------------
test("apply needs a terminal and writes nothing without one", async (t) => {
  const f = fixture(t);
  const planned = await f.plan("set", "builder", "alpha");
  f.state.terminal = false;
  const before = f.files();
  const refused = await f.run(["set", "builder", "alpha", "--confirm", planned.planId]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /identity alias --confirm requires standard input and output to be a terminal/);
  assert.deepEqual(f.files(), before);
  f.state.terminal = true;
  assert.equal((await f.run(["set", "builder", "alpha", "--confirm", planned.planId])).code, 0);
});

test("the terminal gate is standard input AND standard output, when nothing stands in for it", async (t) => {
  const f = fixture(t);
  const planned = await f.plan("set", "builder", "alpha");
  const before = f.files();
  for (const [stdin, stdout] of [[true, false], [false, true], [false, false]]) {
    const refusal = await f.run(["set", "builder", "alpha", "--confirm", planned.planId], { identityDependencies: { isTerminal: undefined, stdinIsTTY: stdin, stdoutIsTTY: stdout } });
    assert.equal(refusal.code, 2, JSON.stringify([stdin, stdout]));
    assert.match(refusal.err, /requires standard input and output to be a terminal/);
  }
  assert.deepEqual(f.files(), before);
  const both = await f.run(["set", "builder", "alpha", "--confirm", planned.planId], { identityDependencies: { isTerminal: undefined, stdinIsTTY: true, stdoutIsTTY: true } });
  assert.equal(both.code, 0, both.err);
  // a function standing in for the check is asked, and its answer counts
  const g = fixture(t);
  const id = (await g.plan("set", "builder", "alpha")).planId;
  assert.equal((await g.run(["set", "builder", "alpha", "--confirm", id], { identityDependencies: { isTerminal: () => false } })).code, 2);
  assert.equal((await g.run(["set", "builder", "alpha", "--confirm", id], { identityDependencies: { isTerminal: () => true } })).code, 0);
});

test("with no stand-in the terminal check falls back to the streams themselves, and needs both", async (t) => {
  const f = fixture(t);
  const id = (await f.plan("set", "builder", "alpha")).planId;
  const pin = (stream, value) => { const had = Object.getOwnPropertyDescriptor(stream, "isTTY"); Object.defineProperty(stream, "isTTY", { value, configurable: true }); return () => { if (had) Object.defineProperty(stream, "isTTY", had); else delete stream.isTTY; }; };
  const run = async (stdin, stdout) => {
    const restore = [pin(process.stdin, stdin), pin(process.stdout, stdout)];
    try {
      return await f.run(["set", "builder", "alpha", "--confirm", id], { identityDependencies: { isTerminal: undefined } });
    } finally {
      restore.reverse().forEach((undo) => undo());
    }
  };
  assert.equal((await run(true, false)).code, 2);
  assert.equal((await run(false, true)).code, 2);
  assert.equal((await run(false, false)).code, 2);
  assert.equal((await run(true, true)).code, 0);
});

test("the confirmation must be a plan id, and a stale one is refused with nothing written", async (t) => {
  const f = fixture(t);
  for (const bad of ["", "abc", "A".repeat(64), "z".repeat(64), `${"a".repeat(63)}`]) {
    const refused = await f.run(["set", "builder", "alpha", "--confirm", bad]);
    assert.equal(refused.code, 2, JSON.stringify(bad));
    assert.match(refused.err.split("\n")[0], /--confirm must be 64 lowercase hex characters/, JSON.stringify(bad));
  }
  const wrong = await f.run(["set", "builder", "alpha", "--confirm", "0".repeat(64)]);
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /plan_stale/);
  assert.deepEqual(aliasesOf(f), {});
  // the plan id moves with every fact: the registry, the configuration, the target and the name
  const base = (await f.plan("set", "builder", "alpha")).planId;
  assert.equal((await f.plan("set", "builder", "alpha")).planId, base, "stable while nothing changes");
  assert.notEqual((await f.plan("set", "builder2", "alpha")).planId, base, "the name");
  assert.notEqual((await f.plan("set", "builder", "beta")).planId, base, "the target");
  fs.writeFileSync(f.configFile, JSON.stringify(configFor(recipientsOf("alpha", "beta", "gamma"))), { mode: 0o600 });
  const withGamma = (await f.plan("set", "builder", "alpha")).planId;
  assert.notEqual(withGamma, base, "the recipients of the client configuration, which decide the collision and locality checks");
  setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 500_000).toISOString(), alias: "other", principalId: principalOf("beta") });
  assert.notEqual((await f.plan("set", "builder", "alpha")).planId, withGamma, "the registry's sequence and audit head");
  const stale = await f.run(["set", "builder", "alpha", "--confirm", withGamma]);
  assert.deepEqual([stale.code, /plan_stale/.test(stale.err)], [2, true]);
});

test("the supervisor's answer is advice: it changes what the plan says and never its id or its readiness", async (t) => {
  const f = fixture(t);
  const plans = {};
  const variants = {
    honored: reportsFor(f.registry),
    router_disabled: reportsFor(f.registry, { router: { enabled: false }, registry: { addressForms: ["id"] } }),
    router_off_but_lists_alias: reportsFor(f.registry, { router: { enabled: false } }),
    alias_missing: reportsFor(f.registry, { registry: { addressForms: ["id", "principal"] } }),
    not_reported: reportsFor(f.registry, { registry: { addressForms: undefined } }),
    another_registry: reportsFor(f.registry, { registry: { rootSha256: sha256Hex("/somewhere/else") } }),
    no_root: reportsFor(f.registry, { registry: { rootSha256: undefined } }),
    unreachable: Object.assign(new Error("down"), { code: "supervisor_unreachable", detail: "timeout" }),
  };
  for (const [label, status] of Object.entries(variants)) {
    f.state.status = status;
    plans[label] = await f.plan("set", "builder", "alpha");
    assert.equal(plans[label].ready, true, label);
  }
  assert.equal(new Set(Object.values(plans).map((plan) => plan.planId)).size, 1, "one plan id whatever the supervisor said");
  const states = Object.fromEntries(Object.entries(plans).map(([label, plan]) => [label, [plan.advice.supervisor.state, plan.advice.supervisor.reason]]));
  assert.deepEqual(states, {
    honored: ["honored", null],
    router_disabled: ["not_honored", "router_disabled"],
    router_off_but_lists_alias: ["not_honored", "router_disabled"],
    alias_missing: ["not_honored", "alias_not_among_address_forms"],
    not_reported: ["not_honored", "address_forms_not_reported"],
    another_registry: ["unknown", "supervisor_reads_another_registry"],
    no_root: ["unknown", "registry_root_not_reported"],
    unreachable: ["unknown", "supervisor_unreachable"],
  });
  f.state.status = variants.router_disabled;
  assert.match((await f.run(["set", "builder", "alpha"])).out, /Principal routing is switched off in the running supervisor \(router_disabled\), so it resolves no alias\. The alias would be recorded but not honored until routing is enabled/);
  f.state.status = variants.alias_missing;
  assert.match((await f.run(["set", "builder", "alpha"])).out, /does not resolve aliases \(alias_not_among_address_forms\)/);
  f.state.status = variants.unreachable;
  assert.match((await f.run(["set", "builder", "alpha"])).out, /could not be asked whether it resolves aliases \(supervisor_unreachable: timeout\)/);
  f.state.status = variants.another_registry;
  assert.match((await f.run(["set", "builder", "alpha"])).out, /answered about another registry directory \(supervisor_reads_another_registry\), so its answer says nothing about this one/);
  f.state.status = variants.no_root;
  assert.match((await f.run(["set", "builder", "alpha"])).out, /did not say which registry directory it reads \(registry_root_not_reported\)/);
  // applying records the alias whatever the supervisor said: it is advice, not a floor
  f.state.status = variants.router_disabled;
  assert.equal((await f.run(["set", "builder", "alpha", "--confirm", plans.honored.planId])).code, 0);
  assert.deepEqual(aliasesOf(f), { builder: principalOf("alpha") });
});

test("apply does not ask the supervisor, and a refused plan does not either", async (t) => {
  const f = fixture(t);
  let asked = 0;
  const counting = { runSupervisorStatus: async () => { asked += 1; return reportsFor(f.registry); } };
  await f.run(["set", "Builder", "alpha"], { identityDependencies: counting });
  assert.equal(asked, 0, "a refused plan");
  const planned = await f.plan("set", "builder", "alpha");
  const askedForPlan = asked;
  assert.equal((await f.run(["set", "builder", "alpha", "--confirm", planned.planId], { identityDependencies: counting })).code, 0);
  assert.equal(asked, askedForPlan, "apply");
  await f.run(["clear", "builder"], { identityDependencies: counting });
  assert.equal(asked, askedForPlan, "a clear plan");
});

// ---- the refusals, each by its code ----------------------------------------------------------------------------------------------
async function refused(f, args, code, { exit = 1 } = {}) {
  const result = await f.run([...args, "--json"]);
  assert.equal(result.code, exit, `${args.join(" ")}: ${result.err}`);
  const plan = JSON.parse(result.out);
  assert.equal(plan.ready, false, args.join(" "));
  assert.equal(plan.refusals[0], code, `${args.join(" ")}: ${plan.refusals.join()}`);
  return plan;
}

test("refusals about the name: invalid, reserved, and equal to a local profile", async (t) => {
  const f = fixture(t, { profiles: ["alpha", "Beta", "gamma"] });
  const before = f.files();
  for (const name of ["Builder", "-x", ".x", "_x", "a b", "x".repeat(33), "ünï", "a/b", "builder\n"]) await refused(f, ["set", name, "alpha"], "alias_name_invalid");
  for (const name of ["claude", "agent_x", "peer_x", "session-x", "bind_x", "pair_x", "agent_" + "a".repeat(26)]) await refused(f, ["set", name, "alpha"], "alias_name_reserved");
  for (const name of ["alpha", "beta", "gamma"]) {
    const plan = await refused(f, ["set", name, "gamma"], "alias_collides_with_label");
    assert.equal(plan.alias, name);
  }
  assert.deepEqual(f.files(), before);
  const text = await f.run(["set", "alpha", "gamma"]);
  assert.match(text.out, /\[blocked\]\s+no local profile has this name/);
  assert.match(text.out, /alias_collides_with_label: A local profile already has this name, or one that differs only in case\./);
  // a name that fits and is free is fine, including the longest and the odd punctuation
  for (const name of ["x".repeat(32), "a.b_c-d", "0", "9lives"]) assert.equal((await f.plan("set", name, "alpha")).ready, true, name);
});

test("a name that is a property of Object.prototype is an ordinary name, free to set and not there to clear", async (t) => {
  const f = fixture(t);
  for (const name of ["constructor", "hasownproperty", "valueof", "tostring"]) {
    const plan = await f.plan("set", name, "alpha");
    assert.deepEqual([plan.ready, plan.refusals], [true, []], name);
  }
  assert.deepEqual((await f.plan("clear", "constructor")).refusals, ["alias_not_found"]);
  assert.equal((await apply(f, "set", ["constructor", "alpha"])).result.code, 0);
  assert.deepEqual(aliasesOf(f), { constructor: principalOf("alpha") });
  assert.equal((await f.plan("clear", "constructor")).ready, true);
});

test("refusals about the target: unknown, revoked, serverless, ambiguous and not a local recipient", async (t) => {
  const f = fixture(t, { profiles: ["alpha", "beta", "gamma"], recipients: ["alpha", "beta", "twin"], twin: true });
  // unknown profile, unknown principal, junk, and names that only look like a profile: a profile is matched whole and exactly
  await refused(f, ["set", "builder", "nobody"], "alias_target_not_found");
  for (const near of ["alp", "Alpha", "ALPHA", "alpha ", " alpha", "alph*", "alpha\n"]) await refused(f, ["set", "builder", near], "alias_target_not_found");
  await refused(f, ["set", "builder", `agent_${"0".repeat(32)}`], "alias_target_not_found");
  await refused(f, ["set", "builder", "agent_short"], "alias_target_not_found");
  // bound, but its profile is not in the client configuration's recipients
  const notLocal = await refused(f, ["set", "builder", "gamma"], "alias_target_not_local");
  assert.equal(notLocal.target.profile, "gamma");
  // the same by the principal's id; and a principal none of whose bindings is local names no single profile
  const byId = await refused(f, ["set", "builder", principalOf("gamma")], "alias_target_not_local");
  assert.equal(byId.target.profile, "gamma");
  const text = await f.run(["set", "builder", "gamma"]);
  assert.match(text.out, /\[blocked\]\s+the target is an active MESH-managed binding on exactly one local recipient/);
  assert.match(text.out, /\[ok\]\s+the name fits the pattern and is not reserved/);
  // a principal with two active bindings on local recipients (the legacy duplicate "twin" shares alpha's principal)
  await refused(f, ["set", "builder", "alpha"], "alias_target_ambiguous");
  await refused(f, ["set", "builder", principalOf("alpha")], "alias_target_ambiguous");
  await refused(f, ["set", "builder", "twin"], "alias_target_ambiguous");
  // beta is fine
  assert.equal((await f.plan("set", "builder", "beta")).ready, true);
  // revoked: the profile and its principal
  updateIdentityRegistry({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 400_000).toISOString(), action: "revoke", subject: deriveClientInstanceId("beta"), mutate: (r) => { r.bindings[deriveClientInstanceId("beta")].revoked_at = new Date(f.start + 400_000).toISOString(); return r; } });
  await refused(f, ["set", "builder", "beta"], "alias_target_not_active");
  await refused(f, ["set", "builder", principalOf("beta")], "alias_target_not_active");
});

test("a duplicate binding on a profile that is not a local recipient does not make the principal ambiguous, and does not redirect a profile name", async (t) => {
  const f = fixture(t, { profiles: ["alpha", "beta"], recipients: ["alpha", "beta"], twin: true });
  // alpha and twin share a principal; only alpha is a local recipient, so a send by that principal can only reach alpha
  for (const target of ["alpha", principalOf("alpha")]) {
    const plan = await f.plan("set", "builder", target);
    assert.deepEqual([plan.ready, plan.target.profile], [true, "alpha"], target);
  }
  // naming the other one is not the same as naming the principal: twin itself cannot be reached, and the alias would go to alpha
  const named = await refused(f, ["set", "builder", "twin"], "alias_target_not_local");
  assert.equal(named.target.profile, "twin");
});

test("a profile name names that profile's own binding: a revoked profile is not quietly re-aimed at the profile its principal moved to", async (t) => {
  const f = fixture(t, { profiles: ["alpha", "beta"], recipients: ["alpha", "beta", "beta2"] });
  const at = new Date(f.start + 400_000).toISOString();
  updateIdentityRegistry({ root: f.registry, expectedSequence: f.seq(), now: at, action: "revoke", subject: deriveClientInstanceId("beta"), mutate: (r) => { r.bindings[deriveClientInstanceId("beta")].revoked_at = at; return r; } });
  const moved = agentBindingV2("beta2", { principal_id: principalOf("beta"), issued_at: new Date(f.start + 500_000).toISOString() });
  updateIdentityRegistry({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 500_000).toISOString(), action: "bind", subject: moved.profile_instance_id, mutate: (r) => { r.bindings[moved.profile_instance_id] = moved; return r; } });
  // by the revoked profile's name: refused, and the plan names no target
  const byName = await refused(f, ["set", "builder", "beta"], "alias_target_not_active");
  assert.equal(byName.target, null);
  const text = await f.run(["set", "builder", "beta"]);
  assert.match(text.out, /give its agent_ id instead/);
  assert.doesNotMatch(text.out, /To apply this plan/, "no apply command for a refused plan");
  // by the principal's id the owner chooses the principal, and sees where it is bound now
  const byId = await f.plan("set", "builder", principalOf("beta"));
  assert.deepEqual([byId.ready, byId.target.profile], [true, "beta2"]);
  // and the profile it has moved to can be named
  assert.equal((await f.plan("set", "builder", "beta2")).ready, true);
});

test("a serverless peer binding cannot have an alias", async (t) => {
  const f = fixture(t);
  const peer = peerBindingV2("peerone");
  // the writer cannot create a serverless binding yet: commit one by hand, audit line first
  appendAndCommit(f.registry, { action: "bind", subject: peer.profile_instance_id, bindingId: peer.binding_id, at: new Date(f.start + 400_000).toISOString(), change: (r) => ({ ...r, bindings: { ...r.bindings, [peer.profile_instance_id]: peer } }) });
  await refused(f, ["set", "builder", "peerone"], "alias_target_not_mesh_managed");
  await refused(f, ["set", "builder", peer.principal_id], "alias_target_not_mesh_managed");
  await refused(f, ["set", "builder", `peer_${"0".repeat(32)}`], "alias_target_not_found");
});

test("every reason that can be judged is listed, in a fixed order", async (t) => {
  const absent = fixture(t, { registry: "absent", config: "missing" });
  assert.deepEqual((await absent.plan("set", "Builder", "alpha")).refusals, ["registry_absent", "local_messaging_config_missing", "alias_name_invalid"], "the registry first, then the configuration, then the name; nothing about the target can be judged");
  const f = fixture(t);
  assert.deepEqual((await f.plan("set", "claude", "nobody")).refusals, ["alias_name_reserved", "alias_target_not_found"], "a name refusal does not hide the target's");
  assert.deepEqual((await f.plan("set", "Builder", "nobody")).refusals, ["alias_name_invalid", "alias_target_not_found"]);
  const plan = await f.run(["set", "Builder", "nobody"]);
  assert.match(plan.out, /\[blocked\]\s+the name fits the pattern and is not reserved/);
  assert.match(plan.out, /\[blocked\]\s+the target is an active MESH-managed binding on exactly one local recipient/);
  assert.match(plan.out, /\[ok\]\s+the registry reads and is a v2 registry/);
  assert.match(plan.out, /\[ok\]\s+the name is free/);
  assert.doesNotMatch(plan.out, /To apply this plan/, "no apply command for a refused plan");
});

test("refusals about the registry and the configuration, before any write", async (t) => {
  for (const [options, code] of [
    [{ registry: "absent" }, "registry_absent"],
    [{ registry: "v1" }, "registry_not_v2"],
    [{ config: "missing" }, "local_messaging_config_missing"],
    [{ config: "loose" }, "local_messaging_config_unreadable"],
    [{ config: "garbage" }, "local_messaging_config_unreadable"],
    [{ config: "no-recipients" }, "local_messaging_config_unreadable"],
  ]) {
    const f = fixture(t, options);
    const before = f.listing();
    const plan = await refused(f, ["set", "builder", "alpha"], code);
    assert.ok(plan.refusals.includes(code), JSON.stringify(options));
    assert.deepEqual(f.listing(), before, `${JSON.stringify(options)}: a refused plan writes nothing`);
    const text = await f.run(["set", "builder", "alpha"]);
    assert.match(text.out, new RegExp(`- ${code}: `));
    // and it cannot be applied
    const applied = await f.run(["set", "builder", "alpha", "--confirm", plan.planId]);
    assert.equal(applied.code, 1, JSON.stringify(options));
    assert.match(applied.err, new RegExp(`\\(${code}\\)`));
    assert.deepEqual(f.listing(), before);
  }
  const damaged = fixture(t);
  fs.writeFileSync(path.join(damaged.registry, REGISTRY_FILE), "{ damaged");
  await refused(damaged, ["set", "builder", "alpha"], "registry_unreadable");
});

test("the registry is at its cap of 256 aliases: the 256th can still be set, the 257th cannot", async (t) => {
  assert.equal(MAX_ALIASES, MAX_REGISTRY_ALIASES, "this command's copy of the registry's cap");
  const f = fixture(t);
  const add = (index) => setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 1_000_000 + index * 1000).toISOString(), alias: `n${String(index).padStart(3, "0")}`, principalId: principalOf("alpha") });
  for (let index = 0; index < 255; index += 1) add(index);
  assert.equal((await f.plan("set", "builder", "beta")).ready, true, "255 aliases: one more fits");
  add(255);
  await refused(f, ["set", "builder", "beta"], "alias_map_full");
  // a name that is taken in a full map is both
  assert.deepEqual((await f.plan("set", "n007", "beta")).refusals, ["alias_exists", "alias_map_full"]);
  assert.equal((await f.plan("clear", "n007")).ready, true, "a full map can still be cleared");
});

// ---- clear --------------------------------------------------------------------------------------------------------------------------
test("a clear plan says what the alias is now, and refuses a name that is not there", async (t) => {
  const f = fixture(t);
  await refused(f, ["clear", "builder"], "alias_not_found");
  await refused(f, ["clear", "Builder"], "alias_name_invalid");
  setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 500_000).toISOString(), alias: "builder", principalId: principalOf("alpha") });
  const human = await f.run(["clear", "builder"]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /Identity alias plan: clear/);
  assert.match(human.out, /Alias:    builder  \(exists\)/);
  assert.ok(human.out.includes(`Target:   alpha · ${principalOf("alpha")} · set `));
  assert.match(human.out, /now active/);
  const plan = await f.plan("clear", "builder");
  assert.deepEqual([plan.ready, plan.existing.state, plan.existing.profile], [true, "active", "alpha"]);
  // a dangling alias (its profile revoked) can be cleared, and so can one with an old, reserved-looking name
  updateIdentityRegistry({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 600_000).toISOString(), action: "revoke", subject: deriveClientInstanceId("alpha"), mutate: (r) => { r.bindings[deriveClientInstanceId("alpha")].revoked_at = new Date(f.start + 600_000).toISOString(); return r; } });
  const dangling = await f.plan("clear", "builder");
  assert.deepEqual([dangling.ready, dangling.existing.state, dangling.existing.profile], [true, "dangling", null]);
  assert.equal((await apply(f, "clear", ["builder"])).result.code, 0);
  assert.deepEqual(aliasesOf(f), {});
});

test("an alias whose name the writer would now refuse (it predates the reserved words) can still be cleared", async (t) => {
  const f = fixture(t);
  const at = new Date(f.start + 300_000).toISOString();
  // committed by hand, audit line first: the writer itself refuses to set a reserved name
  appendAndCommit(f.registry, { action: "alias_set", subject: "claude", at, change: (r) => ({ ...r, aliases: { ...r.aliases, claude: { principal_id: principalOf("alpha"), set_at: at, generation: r.sequence + 1 } } }) });
  assert.deepEqual(Object.keys(f.registryNow().registry.aliases), ["claude"]);
  await refused(f, ["set", "claude", "beta"], "alias_name_reserved");
  const plan = await f.plan("clear", "claude");
  assert.deepEqual([plan.ready, plan.existing.state], [true, "active"]);
  assert.equal((await apply(f, "clear", ["claude"])).result.code, 0);
  assert.deepEqual(aliasesOf(f), {});
});

test("a clear plan shows the alias's state judged against the configuration, without resting on it, and prints the way back", async (t) => {
  const f = fixture(t, { profiles: ["alpha", "beta"], recipients: ["alpha"] });
  setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 500_000).toISOString(), alias: "builder", principalId: principalOf("beta") });
  const record = f.registryNow().registry.aliases.builder;
  const plan = await f.plan("clear", "builder");
  assert.deepEqual([plan.ready, plan.existing.state, plan.advice.currentState], [true, "active", "unroutable"], "beta is not a local recipient: unroutable, but the plan itself rests on the registry alone");
  assert.deepEqual({ ...plan.existing }, { principalId: principalOf("beta"), profile: "beta", state: "active", setAt: record.set_at, generation: record.generation });
  const human = await f.run(["clear", "builder"]);
  assert.ok(human.out.includes(`set ${record.set_at} · now unroutable`), human.out);
  assert.ok(human.out.includes(`Way back: triangle identity alias set builder ${principalOf("beta")} --client-root ${shellQuote(f.client)}`), "the way back names the principal");
  // adding a recipient moves the advice but not the plan id
  const before = plan.planId;
  fs.writeFileSync(f.configFile, JSON.stringify(configFor(recipientsOf("alpha", "beta"))), { mode: 0o600 });
  const after = await f.plan("clear", "builder");
  assert.deepEqual([after.planId, after.advice.currentState], [before, "active"]);
});

test("clear works on a registry whose client configuration is gone", async (t) => {
  const f = fixture(t);
  setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 500_000).toISOString(), alias: "builder", principalId: principalOf("alpha") });
  fs.rmSync(f.configFile);
  const plan = await f.plan("clear", "builder");
  assert.deepEqual([plan.ready, plan.localMessaging], [true, null], "a clear plan does not rest on the configuration");
  assert.equal((await apply(f, "clear", ["builder"])).result.code, 0);
});

// ---- discovery's eight names --------------------------------------------------------------------------------------------------------
test("a principal's ninth alias in code-unit order is not listed by discovery, and the plan says so", async (t) => {
  const f = fixture(t);
  const eight = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"];
  eight.forEach((alias, index) => setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 500_000 + index * 1000).toISOString(), alias, principalId: principalOf("alpha") }));
  const last = await f.plan("set", "zz", "alpha");
  assert.deepEqual([last.ready, last.advice.listing.aliasesOfPrincipal, last.advice.listing.unlisted], [true, 9, ["zz"]]);
  assert.match((await f.run(["set", "zz", "alpha"])).out, /discovery lists the first 8 names of a recipient \(9 would exist for this principal\)\. Not listed, though a send by the server still resolves them: zz\. The owner CLI refuses a name that discovery does not list\./);
  const first = await f.plan("set", "a1", "alpha");
  assert.deepEqual(first.advice.listing.unlisted, ["b8"], "a new first name pushes the old eighth out of the listing");
  const other = await f.plan("set", "zz", "beta");
  assert.deepEqual(other.advice.listing, { aliasesOfPrincipal: 1, listed: ["zz"], unlisted: [] }, "another principal has its own eight");
  assert.equal(Object.hasOwn((await f.plan("set", "b9", "alpha")).advice.listing, "unlisted"), true);
  assert.deepEqual((await f.plan("set", "b0", "alpha")).advice.listing.unlisted, ["b8"]);
});

// ---- races and failures ---------------------------------------------------------------------------------------------------------------
test("a registry that changes between the plan and the write is refused with nothing changed", async (t) => {
  const f = fixture(t);
  const planned = await f.plan("set", "builder", "alpha");
  const racing = {
    setIdentityAlias: (options) => {
      // another owner command lands after the plan was re-evaluated and before the write
      setIdentityAlias({ root: f.registry, expectedSequence: options.expectedSequence, now: new Date(f.start + 700_000).toISOString(), alias: "rival", principalId: principalOf("beta") });
      return setIdentityAlias(options);
    },
  };
  const result = await f.run(["set", "builder", "alpha", "--confirm", planned.planId, "--json"], { identityDependencies: racing });
  assert.equal(result.code, 1);
  const error = JSON.parse(result.err);
  assert.deepEqual([error.error, error.nothingChanged], ["registry_sequence_conflict", true]);
  assert.equal(error.message, "The registry changed while the command ran. Nothing was changed.");
  assert.deepEqual(aliasesOf(f), { rival: principalOf("beta") }, "only the other command's alias exists");
  // and in words
  const g = fixture(t);
  const id = (await g.plan("set", "builder", "alpha")).planId;
  const spoken = await g.run(["set", "builder", "alpha", "--confirm", id], { identityDependencies: { setIdentityAlias: (options) => { setIdentityAlias({ root: g.registry, expectedSequence: options.expectedSequence, now: new Date(g.start + 700_000).toISOString(), alias: "rival", principalId: principalOf("beta") }); return setIdentityAlias(options); } } });
  assert.equal(spoken.err, "The registry changed while the command ran. Nothing was changed. (registry_sequence_conflict)");
});

test("a write that does not read back as the planned change is reported, and a later write by someone else is not a failure", async (t) => {
  const readBack = (doctor) => {
    let written = false;
    return {
      setIdentityAlias: (options) => { const result = setIdentityAlias(options); written = true; return result; },
      readIdentityRegistry: (options) => { const read = readIdentityRegistry(options); return written ? doctor(structuredClone(read)) : read; },
    };
  };
  const cases = {
    "the registry reads as it was before": (read) => ({ ...read, registry: { ...read.registry, sequence: read.registry.sequence - 1 } }),
    "the alias points at another principal": (read) => { read.registry.aliases.builder.principal_id = principalOf("beta"); return read; },
    "the alias is missing": (read) => { delete read.registry.aliases.builder; return read; },
    "the registry cannot be read": () => ({ state: "unreadable" }),
  };
  for (const [label, doctor] of Object.entries(cases)) {
    const f = fixture(t);
    const planned = await f.plan("set", "builder", "alpha");
    const result = await f.run(["set", "builder", "alpha", "--confirm", planned.planId, "--json"], { identityDependencies: readBack(doctor) });
    assert.equal(result.code, 1, label);
    const error = JSON.parse(result.err);
    assert.deepEqual([error.error, error.writeAttempted], ["alias_verification_failed", true], label);
  }
  // and for a clear: the alias still there after it
  const g = fixture(t);
  setIdentityAlias({ root: g.registry, expectedSequence: g.seq(), now: new Date(g.start + 600_000).toISOString(), alias: "builder", principalId: principalOf("alpha") });
  const clearPlan = await g.plan("clear", "builder");
  let cleared = false;
  const stillThere = {
    clearIdentityAlias: (options) => { const result = clearIdentityAlias(options); cleared = true; return result; },
    readIdentityRegistry: (options) => { const read = readIdentityRegistry(options); if (!cleared) return read; const copy = structuredClone(read); copy.registry.aliases.builder = { principal_id: principalOf("alpha"), set_at: "2026-11-07T10:00:00.000Z", generation: 3 }; return copy; },
  };
  const notCleared = await g.run(["clear", "builder", "--confirm", clearPlan.planId, "--json"], { identityDependencies: stillThere });
  assert.deepEqual([notCleared.code, JSON.parse(notCleared.err).error], [1, "alias_verification_failed"]);
  // another write lands after ours: the alias is set, and the command says so
  const f = fixture(t);
  const planned = await f.plan("set", "builder", "alpha");
  const sequence = f.seq();
  const later = { setIdentityAlias: (options) => { const written = setIdentityAlias(options); setIdentityAlias({ root: options.root, expectedSequence: options.expectedSequence + 1, now: new Date(f.start + 700_000).toISOString(), alias: "rival", principalId: principalOf("beta") }); return written; } };
  const result = await f.run(["set", "builder", "alpha", "--confirm", planned.planId, "--json"], { identityDependencies: later });
  assert.equal(result.code, 0, result.err);
  const done = JSON.parse(result.out);
  assert.deepEqual([done.from.sequence, done.to.sequence, done.laterWrites], [sequence, sequence + 2, 1]);
  assert.deepEqual(aliasesOf(f), { builder: principalOf("alpha"), rival: principalOf("beta") });
});

test("a fault at any stage of the write leaves a registry that reads, with the alias absent or complete, and the retry is told the truth", async (t) => {
  for (const stage of ["before_audit_append", "after_audit_append", "before_registry_rename", "after_registry_rename", "after_commit"]) {
    const f = fixture(t);
    const planned = await f.plan("set", "builder", "alpha");
    const faulty = { setIdentityAlias: (options) => setIdentityAlias({ ...options, faultHook: (at) => { if (at === stage) throw Object.assign(new Error("injected"), { code: "injected_fault" }); } }) };
    const result = await f.run(["set", "builder", "alpha", "--confirm", planned.planId, "--json"], { identityDependencies: faulty });
    assert.equal(result.code, 1, stage);
    assert.equal(JSON.parse(result.err).error, "injected_fault", stage);
    const read = f.registryNow();
    assert.equal(read.state, "ok", `${stage}: the registry and its audit chain still read`);
    const committed = Object.hasOwn(read.registry.aliases, "builder");
    assert.equal(committed, stage === "after_registry_rename" || stage === "after_commit", stage);
    if (committed) {
      // the alias is whole, and the old plan id is spent: a fresh plan says the name is taken
      assert.equal(read.registry.aliases.builder.principal_id, principalOf("alpha"), stage);
      const stale = await f.run(["set", "builder", "alpha", "--confirm", planned.planId]);
      assert.deepEqual([stale.code, /plan_stale/.test(stale.err)], [2, true], stage);
      assert.deepEqual((await f.plan("set", "builder", "alpha")).refusals, ["alias_exists"], stage);
    } else {
      // nothing took effect (a crash after the audit line leaves one unfinished line the next write repairs), so the same plan id still applies
      const retry = await f.run(["set", "builder", "alpha", "--confirm", planned.planId]);
      assert.equal(retry.code, 0, `${stage}: ${retry.err}`);
      assert.deepEqual(aliasesOf(f), { builder: principalOf("alpha") }, stage);
    }
  }
});

// ---- usage ---------------------------------------------------------------------------------------------------------------------------
test("usage errors are caught before anything is read", async (t) => {
  const f = fixture(t);
  const before = f.listing();
  const bad = async (args, pattern, { client = true } = {}) => {
    const out = [];
    const err = [];
    const code = await main(["identity", "alias", ...args, ...(client ? ["--client-root", f.client] : [])], { env: {}, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, identityDependencies: f.dependencies() });
    assert.equal(code, 2, `${args.join(" ")}: ${err.join()}`);
    assert.equal(out.join(""), "", args.join(" "));
    assert.match(err.join("\n").split("\n")[0], pattern, args.join(" "));
  };
  await bad([], /identity alias needs set or clear/);
  await bad(["frob", "x"], /identity alias needs set or clear/);
  await bad(["set"], /identity alias set takes NAME and TARGET/);
  await bad(["set", "x"], /identity alias set takes NAME and TARGET/);
  await bad(["set", "x", "alpha", "extra"], /identity alias set takes NAME and TARGET/);
  await bad(["clear"], /identity alias clear takes NAME/);
  await bad(["clear", "x", "y"], /identity alias clear takes NAME/);
  await bad(["set", "x", "alpha"], /requires --client-root/, { client: false });
  await bad(["set", "x", "alpha", "--client-root", "relative/path"], /--client-root must be an absolute path/, { client: false });
  await bad(["set", "x", "alpha", "--registry-root", "relative"], /--registry-root must be an absolute path/);
  await bad(["set", "x", "alpha", "--registry-root", f.client], /registry root must not equal client root/);
  await bad(["set", "x", "alpha", "--client-root", "/"], /--client-root must not be the filesystem root/, { client: false });
  await bad(["set", "x", "alpha", "--registry-root", "/"], /--registry-root must not be the filesystem root/);
  await bad(["set", "x", "alpha", "--registry-root", path.join(f.root, "elsewhere")], /beside --client-root/);
  await bad(["set", "x", "alpha", "--confirm", "nothex"], /--confirm must be 64 lowercase hex characters/);
  await bad(["set", "x", "alpha", "--bogus", "1"], /unknown option --bogus/);
  assert.deepEqual(f.listing(), before);
});

test("the result text and the printed commands are safe to paste and to print", async (t) => {
  const result = renderAliasResult({ action: "set", registryRoot: "/r\u0007oot", alias: "builder", principal: "agent_x", profile: "p\u001b[31mq\u202ez", from: { sequence: 1 }, to: { sequence: 2 }, laterWrites: 0 });
  assert.doesNotMatch(result, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/);
  assert.match(renderAliasResult({ action: "clear", registryRoot: "/r", alias: "builder", principal: "agent_x", profile: null, from: { sequence: 1 }, to: { sequence: 3 }, laterWrites: 1 }), /Another write landed after this one \(1 entry\)/);
  const command = aliasCommand({ action: "set", name: "$(touch x)", target: "it's a profile", clientRoot: "/a b/client", registryRoot: "/a b/identity", confirm: "a".repeat(64) });
  assert.equal(command, `triangle identity alias set '$(touch x)' 'it'\\''s a profile' --client-root '/a b/client' --registry-root '/a b/identity' --confirm ${"a".repeat(64)}`);
  assert.equal(aliasCommand({ action: "clear", name: "builder", clientRoot: "/c", registryRoot: "/i" }), "triangle identity alias clear builder --client-root /c --registry-root /i");
  // a refused plan echoes what was typed, quoted in its way-back line, and prints no apply command
  const f = fixture(t);
  const refusedPlan = await f.run(["set", "$(touch /tmp/not-created)", "alpha"]);
  assert.match(refusedPlan.out, /Way back: triangle identity alias clear '\$\(touch \/tmp\/not-created\)' --client-root /);
  assert.doesNotMatch(refusedPlan.out, /alias clear \$\(touch/);
  assert.equal(fs.existsSync("/tmp/not-created"), false);
  // format characters (a bidi override) typed by the owner never reach the terminal either
  const bidi = await f.run(["set", "ab\u202ec", "alpha"]);
  assert.doesNotMatch(bidi.out + bidi.err, /\p{Cf}/u);
});

test("an error from the write that this command has no words for says the registry may have changed; a LocalStateError is reported as itself", async (t) => {
  const f = fixture(t);
  const id = (await f.plan("set", "builder", "alpha")).planId;
  const io = new Error("input/output error");
  io.code = "EIO";
  const raw = await f.run(["set", "builder", "alpha", "--confirm", id], { identityDependencies: { setIdentityAlias: () => { throw io; } } });
  assert.equal(raw.code, 1);
  assert.equal(raw.err, "input/output error (EIO) The registry may or may not have changed: make a fresh plan, or check it with triangle status --identity.");
  const json = JSON.parse((await f.run(["set", "builder", "alpha", "--confirm", id, "--json"], { identityDependencies: { setIdentityAlias: () => { throw io; } } })).err);
  assert.deepEqual([json.error, json.writeAttempted], ["EIO", true]);
  assert.match(json.message, /may or may not have changed/);
  // a reason it does have words for needs no such hint
  const clock = Object.assign(new Error("x"), { code: "invalid_registry", reason: "updated_before_created" });
  const known = await f.run(["set", "builder", "alpha", "--confirm", id], { identityDependencies: { setIdentityAlias: () => { throw clock; } } });
  assert.equal(known.err, "This computer's clock is earlier than the registry's last write. Check the date and time, then make a fresh plan. (updated_before_created)");
  // a LocalStateError is passed on to the command line's own handler: its message, as itself, exit 1
  const gone = await f.run(["set", "builder", "alpha", "--confirm", id], { identityDependencies: { setIdentityAlias: () => { throw new LocalStateError("the state directory is gone"); } } });
  assert.deepEqual([gone.code, gone.err], [1, "the state directory is gone"]);
});

test("applying a refused plan, or with something that is not a plan id, is refused with the reasons", async (t) => {
  const f = fixture(t);
  const refusedPlan = await f.plan("set", "Builder", "nobody");
  const result = await f.run(["set", "Builder", "nobody", "--confirm", refusedPlan.planId, "--json"]);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.err);
  assert.deepEqual([error.error, error.refusals], ["alias_name_invalid", ["alias_name_invalid", "alias_target_not_found"]]);
  // the module's own guard, for a caller that is not the command line
  await assert.rejects(applyIdentityAlias({ action: "set", name: "builder", target: "alpha", clientRoot: f.client, registryRoot: f.registry, confirm: "nope" }), { code: "confirmation_mismatch" });
  // two targets that cannot be resolved are still two plans
  const a = await f.plan("set", "builder", "ghost");
  const b = await f.plan("set", "builder", "ghost2");
  assert.deepEqual([a.target, b.target, a.planId === b.planId], [null, null, false]);
});

test("the help text lists both commands", async () => {
  const out = [];
  const code = await main(["--help"], { env: {}, io: { stdout: (s) => out.push(s), stderr: () => {} } });
  assert.equal(code, 0);
  const help = out.join("\n");
  assert.match(help, /identity alias set NAME TARGET --client-root DIR \[--registry-root DIR\] \[--confirm PLAN_ID\]/);
  assert.match(help, /identity alias clear NAME --client-root DIR \[--registry-root DIR\] \[--confirm PLAN_ID\]/);
  assert.match(help, /created, never overwritten: clear it to change it/);
});

test("names and targets from the command line never put control characters on the terminal", async (t) => {
  const f = fixture(t);
  const evil = "x\u001b[31mred\u0007\u0000";
  for (const args of [["set", evil, "alpha"], ["set", "builder", evil], ["clear", evil]]) {
    const result = await f.run(args);
    assert.doesNotMatch(result.out + result.err, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, args.join(" "));
    assert.equal(result.code, 1);
  }
});

// ---- status and doctor ------------------------------------------------------------------------------------------------------------------
async function statusReport(f, { command = "doctor", json = true, extra = {} } = {}) {
  const out = [];
  const err = [];
  const home = path.join(f.root, "home");
  const emptyInventory = { schema: "identity_inventory_v1", scope: "host-local", summary: { identityCount: 0, unmappedProfileCount: 0, sessionCount: 0, faultCount: 0, warningCount: 0, omittedHealthDiagnosticCount: 0 }, identities: [], unmappedProfiles: [], sessions: [], diagnostics: [] };
  const code = await main([command, "--identity", "--client-root", f.client, "--registry-root", f.registry, "--home", home, ...(json ? ["--json"] : [])], {
    env: {},
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    identityDependencies: { identityInventory: async () => emptyInventory, ...extra },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("status --identity and doctor --identity list the aliases and warn on each that does not simply work", async (t) => {
  const f = fixture(t, { profiles: ["alpha", "beta", "gamma"], recipients: ["alpha", "beta"] });
  const at = (offset) => new Date(f.start + offset).toISOString();
  setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: at(100_000), alias: "builder", principalId: principalOf("alpha") });
  setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: at(101_000), alias: "reviewer", principalId: principalOf("beta") });
  setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: at(102_000), alias: "gamma-agent", principalId: principalOf("gamma") });
  updateIdentityRegistry({ root: f.registry, expectedSequence: f.seq(), now: at(103_000), action: "revoke", subject: deriveClientInstanceId("beta"), mutate: (r) => { r.bindings[deriveClientInstanceId("beta")].revoked_at = at(103_000); return r; } });

  const status = await statusReport(f, { command: "status" });
  assert.equal(status.code, 0, status.err);
  const report = JSON.parse(status.out);
  assert.deepEqual(report.identity.aliases.map((row) => [row.name, row.state]), [["builder", "active"], ["gamma-agent", "unroutable"], ["reviewer", "dangling"]]);
  const warnings = report.identity.diagnostics.filter((d) => d.code.startsWith("alias_")).map((d) => d.code);
  assert.deepEqual(warnings.sort(), ["alias_dangling", "alias_unroutable"]);

  const text = await statusReport(f, { command: "status", json: false });
  assert.match(text.out, /Registry:  ok · v2 · sequence \d+ · pairings 0 · aliases 3 · destinations 0/);
  assert.match(text.out, /Aliases \(owner-set sending names\):/);
  assert.match(text.out, new RegExp(`  - active · builder → alpha · ${principalOf("alpha")}`));
  assert.match(text.out, new RegExp(`  - unroutable · gamma-agent → gamma · ${principalOf("gamma")}`));
  assert.match(text.out, new RegExp(`  - dangling · reviewer → - · ${principalOf("beta")}`));
  assert.match(text.out, /\[warn\] Alias reviewer points at a principal that has no active binding.* Clear it with triangle identity alias clear reviewer/);

  const doctor = await statusReport(f, { command: "doctor", json: false });
  assert.equal(doctor.code, 1, "doctor warns on every state except active");
  assert.match(doctor.out, /! Identity: Alias gamma-agent points at gamma that is not a local recipient/);
  assert.match(doctor.out, /! Identity: Alias reviewer points at a principal that has no active binding/);
  assert.doesNotMatch(doctor.out, /! Identity: Alias builder/);
});

test("an ambiguous alias is listed with every profile its principal is bound to", async (t) => {
  const f = fixture(t, { profiles: ["alpha", "beta"], recipients: ["alpha", "beta", "twin"] });
  setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 100_000).toISOString(), alias: "builder", principalId: principalOf("alpha") });
  // a legacy duplicate binding appears afterwards (the writer would refuse to create it)
  const twin = agentBindingV2("twin", { principal_id: principalOf("alpha") });
  appendAndCommit(f.registry, { action: "bind", subject: twin.profile_instance_id, bindingId: twin.binding_id, at: new Date(f.start + 200_000).toISOString(), change: (r) => ({ ...r, bindings: { ...r.bindings, [twin.profile_instance_id]: twin } }) });
  const text = await statusReport(f, { command: "status", json: false });
  assert.match(text.out, new RegExp(`  - ambiguous · builder → alpha, twin · ${principalOf("alpha")}`));
  assert.match(text.out, /\[warn\] Alias builder points at a principal bound to several profiles \(alpha, twin\)/);
  const row = JSON.parse((await statusReport(f, { command: "status" })).out).identity.aliases[0];
  assert.deepEqual([row.state, row.profile, [...row.profiles]], ["ambiguous", null, ["alpha", "twin"]]);
});

test("without aliases, and on a v1 registry, status prints what it always did", async (t) => {
  for (const options of [{ registry: "v1" }, { registry: "v2" }]) {
    const f = fixture(t, options);
    const text = await statusReport(f, { command: "status", json: false });
    assert.doesNotMatch(text.out, /Aliases \(owner-set sending names\)/);
    const json = JSON.parse((await statusReport(f, { command: "status" })).out);
    assert.equal(Object.hasOwn(json.identity, "aliases"), options.registry === "v2");
    if (options.registry === "v2") assert.deepEqual(json.identity.aliases, []);
  }
});

test("the client configuration is read for the alias rows only when there are aliases, and an unreadable one is a warning, not a failure", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const counting = { readLocalRecipients: async (clientRoot) => { reads += 1; return readLocalRecipients(clientRoot); } };
  await statusReport(f, { command: "status", extra: counting });
  assert.equal(reads, 0, "no aliases, no read");
  setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 100_000).toISOString(), alias: "builder", principalId: principalOf("alpha") });
  await statusReport(f, { command: "status", extra: counting });
  assert.equal(reads, 1);
  fs.chmodSync(f.configFile, 0o644);
  const report = JSON.parse((await statusReport(f, { command: "doctor" })).out);
  assert.deepEqual(report.identity.aliases.map((row) => [row.name, row.state]), [["builder", "active"]]);
  assert.ok(report.identity.diagnostics.some((d) => d.code === "alias_routing_unchecked"));
  assert.ok(report.warnings.some((w) => /whether the aliases reach a local recipient was not checked/.test(w)));
});

test("identityStatus passes the configured recipients to the view", async (t) => {
  const f = fixture(t);
  setIdentityAlias({ root: f.registry, expectedSequence: f.seq(), now: new Date(f.start + 100_000).toISOString(), alias: "beta", principalId: principalOf("alpha") });
  const view = await identityStatus({ clientRoot: f.client, registryRoot: f.registry, identityInventory: async () => ({ schema: "identity_inventory_v1", scope: "host-local", summary: {}, identities: [], unmappedProfiles: [], sessions: [], diagnostics: [] }) });
  assert.deepEqual(view.aliases.map((row) => [row.name, row.state]), [["beta", "collides"]], "the alias has the name of the local profile beta");
});

test("readLocalRecipients takes only profile names and instance ids, sorted, from a file the supervisor would load, and from no other", async (t) => {
  const f = fixture(t, { recipients: ["beta", "alpha"] });
  fs.writeFileSync(f.configFile, JSON.stringify(configFor(recipientsOf("beta", "alpha"), { runnerTimeoutMs: 5000 })), { mode: 0o600 });
  const read = await readLocalRecipients(f.client);
  assert.deepEqual(read, { ok: true, code: null, recipients: recipientsOf("alpha", "beta") });
  assert.equal(JSON.stringify(read).includes("alias-cli-state"), false, "nothing else of the file is kept");
  // the supervisor's rules, not looser ones: the same file is refused here and there
  const refused = {
    "not enabled": configFor(recipientsOf("alpha"), { enabled: false }),
    "no version": { ...configFor(recipientsOf("alpha")), version: undefined },
    "an extra key": configFor(recipientsOf("alpha"), { unexpected: 1 }),
    "a duplicate profile": configFor([...recipientsOf("alpha"), { profile: "alpha", instanceId: deriveClientInstanceId("other") }]),
    "a duplicate instance id": configFor([...recipientsOf("alpha"), { profile: "other", instanceId: deriveClientInstanceId("alpha") }]),
    "a profile with a slash": configFor([{ profile: "a/b", instanceId: deriveClientInstanceId("a/b") }]),
    "a bidi override in a profile": configFor([{ profile: "al\u202epha", instanceId: deriveClientInstanceId("x") }]),
    "an extra recipient key": configFor([{ ...recipientsOf("alpha")[0], token: "SECRET" }]),
    "a null recipient": configFor([null]),
    "no recipients": configFor([]),
    "33 recipients": configFor(Array.from({ length: 33 }, (_, i) => ({ profile: `p${i}`, instanceId: deriveClientInstanceId(`p${i}`) }))),
    "a bad instance id": configFor([{ profile: "alpha", instanceId: "not-an-id" }]),
  };
  for (const [label, config] of Object.entries(refused)) {
    fs.writeFileSync(f.configFile, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(await readLocalRecipients(f.client), { ok: false, code: "local_messaging_config_unreadable", recipients: null }, label);
  }
  fs.rmSync(f.configFile);
  assert.deepEqual(await readLocalRecipients(f.client), { ok: false, code: "local_messaging_config_missing", recipients: null });
  // and a plan on a configuration the supervisor would refuse is refused
  const disabled = fixture(t, { config: "disabled" });
  assert.equal((await disabled.plan("set", "builder", "alpha")).refusals[0], "local_messaging_config_unreadable");
});
