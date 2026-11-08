// `triangle identity upgrade-registry` and `restore-registry` (D1.3): plan first, one test per floor condition, apply with the
// exact plan id and a terminal, a backup before anything is written, a way back. Everything runs on scratch roots with a fake
// supervisor; nothing here touches an installed host.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../src/cli.mjs";
import { readSupervisorManifestVersion, renderRestorePlan, runTriangleLocalStatus } from "../src/identity-upgrade.mjs";
import { bindProfileInRegistry, makeMeshManagedBinding } from "../../agent-worker/test/local-messaging-identity-fixtures.mjs";
import { AUDIT_FILE, REGISTRY_FILE, ROOT_AUTO, START, V1, V2, clock, fixture, okStatus, sha256Hex, stamp, writeManifest } from "./identity-registry-upgrade-helpers.mjs";
import { agentBindingV2, appendAndCommit, peerBindingV2, serverlessPairing } from "../../agent-worker/test/identity-registry-v2-helpers.mjs";
import {
  backupIdentityRegistry,
  canonicalJson,
  emptyIdentityRegistry,
  readIdentityRegistry,
  updateIdentityRegistry,
  upgradeRegistryV1ToV2,
} from "../../agent-worker/src/identity-registry.mjs";

// ---- upgrade: the plan ----------------------------------------------------------------------------------------------------------
test("the plan reports the floor and the way back, writes nothing, and is deterministic", async (t) => {
  const f = fixture(t);
  const before = f.listing();
  const bytes = f.files();
  const human = await f.run("upgrade-registry");
  assert.equal(human.code, 0, human.err);
  for (const needle of [
    "Identity registry upgrade plan",
    "[ok]      registry reads, is v1, has history",
    "[ok]      supervisor runtime manifest v14 or later (found v14)",
    `[ok]      the running supervisor reports it can read ${V2} (${V1}, ${V2})`,
    "a private copy is made first",
    "restore-registry",
  ]) assert.ok(human.out.includes(needle), `${needle}\n${human.out}`);
  const plan = JSON.parse((await f.run("upgrade-registry", ["--json"])).out);
  const again = JSON.parse((await f.run("upgrade-registry", ["--json"])).out);
  assert.equal(plan.planId, again.planId);
  assert.deepEqual([plan.ready, plan.refusals, plan.registry.schema, plan.registry.sequence, plan.registry.bindings], [true, [], V1, 3, 2]);
  assert.ok(human.out.includes(`--confirm ${plan.planId}`));
  assert.deepEqual(f.listing(), before, "a plan creates no file and no directory, not even the backup directory");
  assert.deepEqual(f.files(), bytes);

  // what the plan rests on is in its id
  f.state.status = okStatus({ registry: { state: "ok", sequence: 3, schema: V1, supportedSchemas: [V1, V2, "identity_registry_v3"], rootSha256: ROOT_AUTO } });
  assert.notEqual((await f.plan()).planId, plan.planId);
});

// ---- upgrade: the floor, one test per condition ----------------------------------------------------------------------------------
async function expectBlocked(f, code, { extra } = {}) {
  const before = f.listing();
  const bytes = f.files?.() ?? null;
  const plan = JSON.parse((await f.run("upgrade-registry", ["--json"], extra)).out);
  assert.equal(plan.ready, false, code);
  assert.ok(plan.refusals.includes(code), `${code} in ${JSON.stringify(plan.refusals)}`);
  const human = await f.run("upgrade-registry", [], extra);
  assert.equal(human.code, 1, human.out);
  assert.ok(human.out.includes("[blocked]"), human.out);
  assert.ok(human.out.includes(code), human.out);
  assert.ok(!human.out.includes("To apply this plan"), "a blocked plan offers no apply command");
  // applying the exact plan is refused with that reason, and nothing is written
  const applied = await f.run("upgrade-registry", ["--confirm", plan.planId], extra);
  assert.equal(applied.code, 1, applied.err);
  assert.ok(applied.err.includes(`(${code})`), applied.err);
  assert.deepEqual(f.listing(), before, `${code}: nothing was written`);
  if (bytes) assert.deepEqual(f.files(), bytes);
  return plan;
}

test("floor 1: the registry must read, be v1, and have history", async (t) => {
  const absent = fixture(t, { registry: false });
  absent.files = undefined;
  await expectBlocked(absent, "registry_absent");

  const corrupt = fixture(t);
  fs.writeFileSync(path.join(corrupt.registry, REGISTRY_FILE), "{ not json\n");
  fs.chmodSync(path.join(corrupt.registry, REGISTRY_FILE), 0o600);
  const plan = await expectBlocked(corrupt, "registry_unreadable");
  assert.equal(plan.registry.errorCode, "registry_corrupt");

  const empty = fixture(t, { registry: false });
  fs.mkdirSync(empty.registry, { mode: 0o700 });
  const file = path.join(empty.registry, REGISTRY_FILE);
  fs.writeFileSync(file, `${canonicalJson(emptyIdentityRegistry({ now: new Date(START).toISOString() }))}\n`);
  fs.chmodSync(file, 0o600);
  empty.files = undefined;
  await expectBlocked(empty, "registry_needs_history");
});

test("an already-upgraded registry is reported as nothing to do (exit 0), and the plan id cannot be applied", async (t) => {
  const f = fixture(t);
  updateIdentityRegistry({ root: f.registry, expectedSequence: 3, action: "upgrade", subject: null, now: clock()(), mutate: (r) => upgradeRegistryV1ToV2(r) });
  const human = await f.run("upgrade-registry");
  assert.equal(human.code, 0, human.err);
  assert.ok(human.out.includes("Nothing to do: the registry is already identity_registry_v2"), human.out);
  const plan = JSON.parse((await f.run("upgrade-registry", ["--json"])).out);
  assert.deepEqual([plan.ready, plan.refusals], [false, ["registry_already_v2"]]);
  const before = f.files();
  const applied = await f.run("upgrade-registry", ["--confirm", plan.planId]);
  assert.equal(applied.code, 1);
  assert.ok(applied.err.includes("(registry_already_v2)"));
  assert.deepEqual(f.files(), before);
  assert.deepEqual(f.backups(), []);
});

test("floor 2: the supervisor runtime manifest must be v14 or later", async (t) => {
  await expectBlocked(fixture(t, { manifest: null }), "runtime_manifest_missing");
  const old = await expectBlocked(fixture(t, { manifest: 13 }), "runtime_upgrade_required");
  assert.equal(old.floor.manifest.version, 13);
  await expectBlocked(fixture(t, { manifest: "{ not json" }), "runtime_manifest_unreadable");
  await expectBlocked(fixture(t, { manifest: JSON.stringify({ version: "14" }) }), "runtime_manifest_unreadable");
  // a manifest that others can read is not a file this command trusts
  const loose = fixture(t, { manifest: 14 });
  fs.chmodSync(path.join(loose.app, "worker-runtime", "supervisor.manifest.json"), 0o644);
  await expectBlocked(loose, "runtime_manifest_unreadable");
});

test("floor 3: the RUNNING supervisor must say it can read v2", async (t) => {
  const unreachable = fixture(t, { status: Object.assign(new Error("down"), { code: "supervisor_unreachable", detail: "exit_1" }) });
  const plan = await expectBlocked(unreachable, "supervisor_unreachable");
  assert.equal(plan.floor.supervisor.detail, "exit_1");

  // a supervisor from before D1 reports the router block without the field, or no router block at all
  await expectBlocked(fixture(t, { status: okStatus({ registry: { state: "ok", sequence: 3 } }) }), "supervisor_cannot_read_v2");
  await expectBlocked(fixture(t, { status: { ok: true } }), "supervisor_cannot_read_v2");
  await expectBlocked(fixture(t, { status: okStatus({ registry: { state: "ok", sequence: 3, schema: V1, supportedSchemas: [V1] } }) }), "supervisor_cannot_read_v2");
  await expectBlocked(fixture(t, { status: okStatus({ registry: { state: "ok", sequence: 3, schema: V1, supportedSchemas: "identity_registry_v2" } }) }), "supervisor_cannot_read_v2");
  await expectBlocked(fixture(t, { status: okStatus({ registry: { state: "ok", sequence: 3, schema: V1, supportedSchemas: [V1, 2] } }) }), "supervisor_cannot_read_v2");
  // a disabled router still reports what the process can read, and that is enough
  const disabled = fixture(t, { status: okStatus({ enabled: false, registry: { state: "disabled", sequence: 0, schema: null, supportedSchemas: [V1, V2], rootSha256: ROOT_AUTO } }) });
  assert.equal((await disabled.plan()).ready, true);
});

test("the plan notes when the supervisor reports a registry that is not this one", async (t) => {
  const f = fixture(t, { status: okStatus({ registry: { state: "ok", sequence: 9, schema: V1, supportedSchemas: [V1, V2], rootSha256: ROOT_AUTO } }) });
  const human = await f.run("upgrade-registry");
  assert.equal(human.code, 0, human.out);
  assert.ok(human.out.includes("The supervisor currently reads: ok, v1, sequence 9."), human.out);
  assert.ok(human.out.includes("Note: that is not this registry's state."), human.out);
  const same = fixture(t);
  assert.ok(!(await same.run("upgrade-registry")).out.includes("Note: that is not this registry's state."));
});

test("a refusal under --json is one JSON object on standard error", async (t) => {
  const f = fixture(t, { manifest: 13 });
  const plan = await f.plan();
  const applied = await f.run("upgrade-registry", ["--confirm", plan.planId, "--json"]);
  assert.equal(applied.code, 1);
  const error = JSON.parse(applied.err);
  assert.deepEqual(Object.keys(error).sort(), ["error", "message"]);
  assert.equal(error.error, "runtime_upgrade_required");
  assert.match(error.message, /older than v14/);
  assert.equal(applied.out, "");
});

test("floor 3 is about the registry being upgraded: the supervisor must say which directory it reads, and it must be this one", async (t) => {
  const registryBlock = (rootSha256) => ({ state: "ok", sequence: 3, schema: V1, supportedSchemas: [V1, V2], rootSha256 });
  // another directory
  const another = fixture(t, { status: okStatus({ registry: registryBlock(sha256Hex("/somewhere/else/identity")) }) });
  const plan = await expectBlocked(another, "supervisor_reads_another_registry");
  assert.equal(plan.floor.supervisor.supportedSchemas.includes(V2), true, "it can read v2, but not for this registry");
  // not said at all, or not a digest: a supervisor that cannot say what it reads proves nothing about this registry
  for (const bad of [undefined, null, 12, "ABC", "z".repeat(64), "a".repeat(63)]) {
    const f = fixture(t, { status: okStatus({ registry: registryBlock(bad) }) });
    const blocked = await expectBlocked(f, "supervisor_cannot_read_v2");
    assert.equal(blocked.floor.supervisor.detail, "registry_root_not_reported", String(bad));
  }
  // the right directory passes
  assert.equal((await fixture(t, { status: okStatus({ registry: registryBlock(ROOT_AUTO) }) }).plan()).ready, true);
});

test("several blocked conditions are all reported, in order", async (t) => {
  const f = fixture(t, { manifest: 13, status: { ok: true } });
  const plan = await f.plan();
  assert.deepEqual(plan.refusals, ["runtime_upgrade_required", "supervisor_cannot_read_v2"]);
});

// ---- upgrade: applying ------------------------------------------------------------------------------------------------------------
test("applying needs a terminal, the exact plan id, and then makes the backup and the upgrade", async (t) => {
  const f = fixture(t);
  const plan = await f.plan();
  const v1Bytes = f.files();
  const before = f.listing();

  // not a terminal: refused before anything else
  const noTerminal = await f.run("upgrade-registry", ["--confirm", plan.planId], { identityDependencies: { isTerminal: false } });
  assert.equal(noTerminal.code, 2);
  assert.match(noTerminal.err, /requires standard input and output to be a terminal/);
  // a wrong or malformed id
  const wrong = await f.run("upgrade-registry", ["--confirm", "0".repeat(64)]);
  assert.equal(wrong.code, 2);
  assert.ok(wrong.err.includes("(plan_stale)"), wrong.err);
  const malformed = await f.run("upgrade-registry", ["--confirm", "abc"]);
  assert.equal(malformed.code, 2);
  assert.match(malformed.err, /--confirm must be 64 lowercase hex characters/);
  assert.deepEqual([f.listing(), f.files()], [before, v1Bytes]);

  const at = clock(5);
  const applied = await f.run("upgrade-registry", ["--confirm", plan.planId, "--json"], { identityDependencies: { now: at } });
  assert.equal(applied.code, 0, applied.err);
  const result = JSON.parse(applied.out);
  assert.deepEqual([result.schema, result.from, result.to.schema, result.to.sequence, result.auditEntry], ["identity_registry_upgrade_result_v1", { schema: V1, sequence: 3 }, V2, 4, "upgrade"]);

  // the backup is the v1 pair as it was, outside the registry root, and it verifies
  assert.equal(result.backup.dir, path.join(f.app, "identity-backups", `backup-v1-${stamp(at())}`));
  assert.deepEqual([path.join(result.backup.dir, REGISTRY_FILE), path.join(result.backup.dir, AUDIT_FILE)].map((file) => fs.readFileSync(file).toString("hex")), v1Bytes);
  const copy = readIdentityRegistry({ root: result.backup.dir });
  assert.deepEqual([copy.registry.schema, copy.registry.sequence], [V1, 3]);
  // the live registry reads as v2 and every binding survived
  const live = readIdentityRegistry({ root: f.registry });
  assert.deepEqual([live.registry.schema, live.registry.sequence, Object.keys(live.registry.bindings).length, live.audit.uncommittedTail], [V2, 4, 2, 0]);
  const lines = fs.readFileSync(path.join(f.registry, AUDIT_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.action), ["init", "bind", "bind", "upgrade"]);

  // the human summary names the backup, and the same plan id cannot be applied twice
  const again = await f.run("upgrade-registry", ["--confirm", plan.planId]);
  assert.equal(again.code, 2);
  assert.ok(again.err.includes("(plan_stale)"));
  assert.equal(f.backups().length, 1, "the refused retry made no second backup");
});

test("the human result names the backup and how to check it", async (t) => {
  const f = fixture(t);
  const plan = await f.plan();
  const applied = await f.run("upgrade-registry", ["--confirm", plan.planId]);
  assert.equal(applied.code, 0, applied.err);
  assert.ok(applied.out.includes("Upgraded the identity registry to identity_registry_v2 (sequence 3 → 4)."), applied.out);
  assert.ok(applied.out.includes(path.join(f.app, "identity-backups")), applied.out);
  assert.ok(applied.out.includes("triangle status --identity"));
});

test("a plan is stale if the registry changed after it was made, and nothing is written", async (t) => {
  const f = fixture(t);
  const plan = await f.plan();
  bindProfileInRegistry(f.registry, "gamma", 3);
  const bytes = f.files();
  const applied = await f.run("upgrade-registry", ["--confirm", plan.planId]);
  assert.equal(applied.code, 2);
  assert.ok(applied.err.includes("(plan_stale)"));
  assert.deepEqual([f.files(), f.backups()], [bytes, []]);
});

test("a write that lands between the plan and the backup stops the upgrade; one that lands after the backup stops it at the compare-and-set", async (t) => {
  // before the backup: the backup would be of a different registry than the plan describes
  const early = fixture(t);
  const earlyPlan = await early.plan();
  const real = (await import("../../agent-worker/src/identity-registry.mjs")).backupIdentityRegistry;
  const earlyRun = await early.run("upgrade-registry", ["--confirm", earlyPlan.planId], {
    identityDependencies: {
      backupIdentityRegistry: (args) => {
        bindProfileInRegistry(early.registry, "gamma", 3);
        return real(args);
      },
    },
  });
  assert.equal(earlyRun.code, 2, earlyRun.err);
  assert.ok(earlyRun.err.includes("(plan_stale)"));
  assert.equal(readIdentityRegistry({ root: early.registry }).registry.schema, V1);
  // the command's own words win, and it says the backup is not needed (restoring it would drop the newer write)
  assert.match(earlyRun.err, /The registry changed while the backup was taken\. Nothing was upgraded\./);
  assert.match(earlyRun.err, /The backup taken just before is kept; it is not needed: /);
  assert.ok(!earlyRun.err.includes("To put the clean pair back"), earlyRun.err);

  // after the backup: the upgrade is a compare-and-set on the backed-up sequence
  const late = fixture(t);
  const latePlan = await late.plan();
  const lateRun = await late.run("upgrade-registry", ["--confirm", latePlan.planId], {
    identityDependencies: {
      backupIdentityRegistry: (args) => {
        const backup = real(args);
        bindProfileInRegistry(late.registry, "gamma", 3);
        return backup;
      },
    },
  });
  assert.equal(lateRun.code, 1, lateRun.err);
  assert.ok(lateRun.err.includes("(registry_sequence_conflict)"), lateRun.err);
  assert.match(lateRun.err, /The registry changed after the backup was taken\. Nothing was upgraded\./);
  assert.match(lateRun.err, /The backup taken just before is kept; it is not needed: /);
  assert.ok(!lateRun.err.includes("To put the clean pair back"), lateRun.err);
  assert.deepEqual([readIdentityRegistry({ root: late.registry }).registry.schema, readIdentityRegistry({ root: late.registry }).registry.sequence], [V1, 4]);
});

test("the terminal gate needs both standard input and standard output to be terminals", async (t) => {
  const f = fixture(t);
  const wrong = "0".repeat(64);
  const viaTty = (stdinIsTTY, stdoutIsTTY) => f.run("upgrade-registry", ["--confirm", wrong], { identityDependencies: { isTerminal: undefined, stdinIsTTY, stdoutIsTTY } });
  for (const [a, b] of [[true, false], [false, true], [false, false]]) {
    const refused = await viaTty(a, b);
    assert.equal(refused.code, 2, `${a} ${b}`);
    assert.match(refused.err, /requires standard input and output to be a terminal/);
  }
  const through = await viaTty(true, true);
  assert.equal(through.code, 2);
  assert.ok(through.err.includes("(plan_stale)"), through.err);
});

test("the registry has to sit beside the client directory, in the application root the floor and the backups belong to", async (t) => {
  const f = fixture(t);
  for (const sub of ["upgrade-registry", "restore-registry"]) {
    const result = await f.run(sub, ["--registry-root", path.join(f.root, "elsewhere", "identity"), ...(sub === "restore-registry" ? ["--from", path.join(f.root, "b")] : [])]);
    assert.equal(result.code, 2, sub);
    assert.match(result.err, /--registry-root must be a directory beside --client-root/);
  }
  // a different name in the same application root is fine
  const ok = await f.run("upgrade-registry", ["--registry-root", path.join(f.app, "identity-copy"), "--json"]);
  assert.equal(JSON.parse(ok.out).refusals[0], "registry_absent");
});

test("a registry swapped for another one with the same sequence between the plan and the backup is caught by the audit head", async (t) => {
  const f = fixture(t);
  const other = fixture(t);
  const plan = await f.plan();
  const real = (await import("../../agent-worker/src/identity-registry.mjs")).backupIdentityRegistry;
  const swapped = await f.run("upgrade-registry", ["--confirm", plan.planId], {
    identityDependencies: {
      backupIdentityRegistry: (args) => {
        for (const name of [REGISTRY_FILE, AUDIT_FILE]) {
          fs.copyFileSync(path.join(other.registry, name), path.join(f.registry, name));
          fs.chmodSync(path.join(f.registry, name), 0o600);
        }
        return real(args);
      },
    },
  });
  assert.equal(readIdentityRegistry({ root: f.registry }).registry.sequence, plan.registry.sequence, "same sequence, different registry");
  assert.equal(swapped.code, 2, swapped.err);
  assert.ok(swapped.err.includes("(plan_stale)"), swapped.err);
  assert.equal(readIdentityRegistry({ root: f.registry }).registry.schema, V1);
});

test("a plan id from before an upgrade and a restore does not come back to life when the registry looks the same again", async (t) => {
  const f = fixture(t);
  const first = await f.plan();
  const upgradedBackup = await (async () => {
    const applied = await f.run("upgrade-registry", ["--confirm", first.planId, "--json"], { identityDependencies: { now: clock(5) } });
    assert.equal(applied.code, 0, applied.err);
    return JSON.parse(applied.out).backup.dir;
  })();
  const restorePlan = JSON.parse((await f.run("restore-registry", ["--from", upgradedBackup, "--json"])).out);
  const restored = await f.run("restore-registry", ["--from", upgradedBackup, "--confirm", restorePlan.planId, "--json"], { identityDependencies: { now: clock(9) } });
  assert.equal(restored.code, 0, restored.err);
  // the registry is byte for byte what it was when the first plan was made, but the backup folder is not
  assert.equal((await f.plan()).registry.sequence, first.registry.sequence);
  const replay = await f.run("upgrade-registry", ["--confirm", first.planId]);
  assert.equal(replay.code, 2, replay.err);
  assert.ok(replay.err.includes("(plan_stale)"));
  assert.equal(readIdentityRegistry({ root: f.registry }).registry.schema, V1);
  // and the restore plan from before the restore is stale too
  const replayRestore = await f.run("restore-registry", ["--from", upgradedBackup, "--confirm", restorePlan.planId]);
  assert.equal(replayRestore.code, 2);
});

test("a restore plan id is stale as soon as another backup or archive appears", async (t) => {
  const f = fixture(t);
  const backup = backupIdentityRegistry({ root: f.registry, backupParent: path.join(f.app, "identity-backups"), now: clock(1)() });
  const plan = JSON.parse((await f.run("restore-registry", ["--from", backup.dir, "--json"])).out);
  backupIdentityRegistry({ root: f.registry, backupParent: path.join(f.app, "identity-backups"), now: clock(2)() });
  const stale = await f.run("restore-registry", ["--from", backup.dir, "--confirm", plan.planId]);
  assert.equal(stale.code, 2, stale.err);
  assert.ok(stale.err.includes("(plan_stale)"));
  const fresh = JSON.parse((await f.run("restore-registry", ["--from", backup.dir, "--json"])).out);
  assert.notEqual(fresh.planId, plan.planId);
});

test("the upgrade also compares the audit head under the lock: a different registry of the same sequence is not upgraded", async (t) => {
  const f = fixture(t);
  const other = fixture(t);
  const plan = await f.plan();
  const real = (await import("../../agent-worker/src/identity-registry.mjs")).backupIdentityRegistry;
  const run = await f.run("upgrade-registry", ["--confirm", plan.planId], {
    identityDependencies: {
      backupIdentityRegistry: (args) => {
        const backup = real(args); // the backup is of the planned registry ...
        for (const name of [REGISTRY_FILE, AUDIT_FILE]) { // ... and then a registry with the same sequence takes its place
          fs.copyFileSync(path.join(other.registry, name), path.join(f.registry, name));
          fs.chmodSync(path.join(f.registry, name), 0o600);
        }
        return backup;
      },
    },
  });
  assert.equal(run.code, 1, run.err);
  assert.ok(run.err.includes("(registry_sequence_conflict)"), run.err);
  assert.match(run.err, /not the one that was backed up\. Nothing was upgraded\./);
  assert.equal(readIdentityRegistry({ root: f.registry }).registry.schema, V1);
});

test("a restore that fails after it archived the live files says where they are", async (t) => {
  const f = fixture(t);
  const backup = backupIdentityRegistry({ root: f.registry, backupParent: path.join(f.app, "identity-backups"), now: clock(1)() });
  bindProfileInRegistry(f.registry, "gamma", 3);
  const plan = JSON.parse((await f.run("restore-registry", ["--from", backup.dir, "--json"])).out);
  const failed = await f.run("restore-registry", ["--from", backup.dir, "--confirm", plan.planId], {
    identityDependencies: {
      now: clock(9),
      faultHook: (stage) => { if (stage === "after_audit_replace") fs.appendFileSync(path.join(f.registry, REGISTRY_FILE), "\n"); },
    },
  });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /The files that were being replaced are archived in: .*before-restore-v1-/);
});

test("the rendering tells apart a backup that shares part of the history from one that shares none", () => {
  const base = {
    registryRoot: "/a/identity", archiveParent: "/a/identity-backups", discarded: [], routing: { added: [], removed: [], reactivated: [], revoked: [], changed: [] },
    routingAcknowledgement: [], refusals: [], ready: true, planId: "1".repeat(64), acceptRoutingChanges: false, discardV2Data: false,
    backup: { dir: "/a/identity-backups/b", schema: V1, sequence: 3, bindings: 2, auditHead: { hash: "a".repeat(64) } },
    live: { state: "ok", schema: V1, sequence: 4, bindings: 2, auditHead: { hash: "b".repeat(64) }, v2Data: null, uncommittedTail: 0 },
  };
  const diverged = renderRestorePlan({ ...base, relation: "diverged", commonPrefix: 2 });
  assert.ok(diverged.includes("share their first 2 audit entries and differ after that"), diverged);
  const unrelated = renderRestorePlan({ ...base, relation: "unrelated", commonPrefix: 0 });
  assert.ok(unrelated.includes("no audit entry in common: they are different registries"), unrelated);
});

test("a crash during the upgrade keeps the backup, and the upgrade can be planned and applied again", async (t) => {
  const f = fixture(t);
  const plan = await f.plan();
  const v1Bytes = f.files();
  const crashed = await f.run("upgrade-registry", ["--confirm", plan.planId], {
    identityDependencies: { now: clock(5), faultHook: (stage) => { if (stage === "after_audit_append") throw Object.assign(new Error("boom"), { code: "boom" }); } },
  });
  assert.equal(crashed.code, 1);
  assert.match(crashed.err, /A backup was made first: /);
  const mid = readIdentityRegistry({ root: f.registry });
  assert.deepEqual([mid.registry.schema, mid.audit.uncommittedTail], [V1, 1], "the registry is still v1, with the unfinished upgrade line");
  assert.equal(f.backups().length, 1);

  // the plan says so and is still ready; applying it finishes the job with exactly one upgrade entry and a second backup
  const human = await f.run("upgrade-registry");
  assert.equal(human.code, 0, human.out);
  assert.ok(human.out.includes("An interrupted write left an unfinished audit line; the upgrade discards it."), human.out);
  const retryPlan = await f.plan();
  assert.equal(retryPlan.ready, true);
  const retried = await f.run("upgrade-registry", ["--confirm", retryPlan.planId], { identityDependencies: { now: clock(10) } });
  assert.equal(retried.code, 0, retried.err);
  const lines = fs.readFileSync(path.join(f.registry, AUDIT_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.action), ["init", "bind", "bind", "upgrade"]);
  assert.equal(f.backups().length, 2);
  // the second backup does not carry the stale line: it is the clean v1 pair
  const second = path.join(f.app, "identity-backups", f.backups()[1]);
  assert.deepEqual([path.join(second, REGISTRY_FILE), path.join(second, AUDIT_FILE)].map((file) => fs.readFileSync(file).toString("hex")), v1Bytes);
});

// ---- the supervisor probe, for real --------------------------------------------------------------------------------------------
function fakeTriangleLocal(app, body, mode = 0o700) {
  const bin = path.join(app, "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const file = path.join(bin, "triangle-local");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, mode);
  return file;
}

test("the real probe runs the installed triangle-local status with a clean environment and reads the answer", async (t) => {
  const f = fixture(t);
  const dump = path.join(f.root, "dump");
  const answer = okStatus();
  answer.router.registry.rootSha256 = sha256Hex(f.registry); // what a real supervisor of this release says about the directory it reads
  fakeTriangleLocal(f.app, `printf '%s\\n' "$@" > '${dump}.args'\nenv | sort > '${dump}.env'\nprintf '%s' '${JSON.stringify(answer)}'`);
  const status = await runTriangleLocalStatus({ applicationRoot: f.app, env: { HOME: "/home/x", PATH: "/usr/bin:/bin", SUPER_SECRET_TOKEN: "do-not-pass" } });
  assert.deepEqual(status.router.registry.supportedSchemas, [V1, V2]);
  assert.deepEqual(fs.readFileSync(`${dump}.args`, "utf8").trim().split("\n"), ["status", "--config", path.join(f.app, "client", "local-messaging.json")]);
  const env = fs.readFileSync(`${dump}.env`, "utf8");
  assert.ok(!env.includes("SUPER_SECRET_TOKEN"), "the parent environment is not handed on");
  assert.ok(env.includes("HOME=/home/x"));

  // and the whole plan works through it, with no injection
  const out = [];
  const code = await main(["identity", "upgrade-registry", "--client-root", f.client, "--json"], {
    env: {},
    io: { stdout: (s) => out.push(s), stderr: () => {} },
    identityDependencies: { isTerminal: true, now: clock() },
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.join("\n")).ready, true);
});

test("the real probe reports why it could not ask", async (t) => {
  const f = fixture(t);
  const ask = () => runTriangleLocalStatus({ applicationRoot: f.app, env: { HOME: "/h", PATH: "/usr/bin:/bin" }, timeoutMs: 400 });
  await assert.rejects(ask, { code: "supervisor_unreachable", detail: "triangle-local_missing" });
  fakeTriangleLocal(f.app, "exit 1");
  await assert.rejects(ask, { code: "supervisor_unreachable", detail: "exit_1" });
  fakeTriangleLocal(f.app, "echo not json");
  await assert.rejects(ask, { code: "supervisor_unreachable", detail: "status_not_json" });
  fakeTriangleLocal(f.app, "echo '[1]'");
  await assert.rejects(ask, { code: "supervisor_unreachable", detail: "status_not_json" });
  fakeTriangleLocal(f.app, "sleep 5");
  await assert.rejects(ask, { code: "supervisor_unreachable", detail: "timeout" });
  fakeTriangleLocal(f.app, "echo '{}'", 0o775);
  await assert.rejects(ask, { code: "supervisor_unreachable", detail: "triangle-local_unsafe" });
  fs.rmSync(path.join(f.app, "bin", "triangle-local"));
  fs.symlinkSync("/bin/echo", path.join(f.app, "bin", "triangle-local"));
  await assert.rejects(ask, { code: "supervisor_unreachable", detail: "triangle-local_unsafe" });
});

test("the real probe refuses a triangle-local that is not executable or whose directories others can write, and reads the config beside the client root it was given", async (t) => {
  const f = fixture(t);
  const bin = path.join(f.app, "bin");
  const ask = (extra = {}) => runTriangleLocalStatus({ applicationRoot: f.app, env: { HOME: "/h", PATH: "/usr/bin:/bin" }, timeoutMs: 2000, ...extra });
  fakeTriangleLocal(f.app, "echo '{}'", 0o600);
  await assert.rejects(ask, { code: "supervisor_unreachable", detail: "triangle-local_unsafe" }, "not executable");
  fakeTriangleLocal(f.app, "echo '{}'", 0o700);
  assert.deepEqual(await ask(), {});
  for (const dir of [bin, f.app]) {
    fs.chmodSync(dir, 0o777);
    try {
      await assert.rejects(ask, { code: "supervisor_unreachable", detail: "triangle-local_unsafe" }, `${dir} others can write`);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  }
  // the config named is the one beside the client directory that was given, whatever that directory is called
  const dump = path.join(f.root, "args");
  fakeTriangleLocal(f.app, `printf '%s\\n' "$@" > '${dump}'\necho '{}'`);
  await ask({ clientRoot: path.join(f.app, "my-client") });
  assert.deepEqual(fs.readFileSync(dump, "utf8").trim().split("\n"), ["status", "--config", path.join(f.app, "my-client", "local-messaging.json")]);
});

test("the probe's time limit is hard: a child that ignores TERM, or leaves a grandchild holding the pipe, is not waited for", async (t) => {
  const f = fixture(t);
  const ask = (timeoutMs = 300) => runTriangleLocalStatus({ applicationRoot: f.app, env: { HOME: "/h", PATH: "/usr/bin:/bin" }, timeoutMs });
  const timed = async (expectation) => {
    const started = Date.now();
    await assert.rejects(ask(), expectation);
    return Date.now() - started;
  };
  fakeTriangleLocal(f.app, "trap '' TERM\nsleep 6");
  assert.ok((await timed({ code: "supervisor_unreachable", detail: "timeout" })) < 2500, "TERM ignored");
  fakeTriangleLocal(f.app, "(sleep 6 &) ; sleep 6");
  assert.ok((await timed({ code: "supervisor_unreachable", detail: "timeout" })) < 2500, "a grandchild");
  // output beyond the cap is refused without being kept
  fakeTriangleLocal(f.app, "head -c 2000000 /dev/zero | tr '\\0' 'a'");
  await assert.rejects(ask(5000), { code: "supervisor_unreachable", detail: "status_too_large" });
  // an answer that arrives and a child that exits are enough, even if a grandchild keeps the pipe open afterwards
  fakeTriangleLocal(f.app, "(sleep 3 &) ; echo '{\"router\":{}}'");
  assert.deepEqual(await ask(2000), { router: {} });
});

test("what the supervisor says is shown only as plain tokens, never as terminal control characters", async (t) => {
  const evil = "bad\u001b[2Jname\u0007";
  const f = fixture(t, { status: okStatus({ registry: { state: "o\u001bk", sequence: 9, schema: "identity_registry_v1\u0007", supportedSchemas: [V1, V2, evil], rootSha256: ROOT_AUTO } }) });
  const human = await f.run("upgrade-registry");
  assert.equal(human.code, 0, human.out);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(human.out), JSON.stringify(human.out));
  const plan = await f.plan();
  assert.ok(plan.floor.supervisor.supportedSchemas.includes("bad??2Jname?"), JSON.stringify(plan.floor.supervisor.supportedSchemas));
  assert.equal(plan.observed.supervisorRegistry.schema, "identity_registry_v1?");
});

test("the manifest reader returns the version and refuses what is not a private file in directories only its owner can write", async (t) => {
  const f = fixture(t, { manifest: 14 });
  assert.equal(await readSupervisorManifestVersion(f.app), 14);
  writeManifest(f.app, 15);
  assert.equal(await readSupervisorManifestVersion(f.app), 15);
  for (const dir of [path.join(f.app, "worker-runtime"), f.app]) {
    fs.chmodSync(dir, 0o777);
    try {
      await assert.rejects(readSupervisorManifestVersion(f.app), { code: "runtime_manifest_unreadable" }, `${dir} others can write`);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  }
  writeManifest(f.app, 15, 0o640);
  await assert.rejects(readSupervisorManifestVersion(f.app), { code: "runtime_manifest_unreadable" });
  fs.rmSync(path.join(f.app, "worker-runtime"), { recursive: true });
  await assert.rejects(readSupervisorManifestVersion(f.app), { code: "runtime_manifest_missing" });
});

// ---- restore -------------------------------------------------------------------------------------------------------------------
// a bind on a v2 registry takes a v2-shaped binding
function bindV2(registry, name, offset = 12) {
  const binding = agentBindingV2(name);
  const sequence = readIdentityRegistry({ root: registry }).registry.sequence;
  return updateIdentityRegistry({
    root: registry,
    expectedSequence: sequence,
    now: new Date(START + offset * 1000).toISOString(),
    action: "bind",
    subject: binding.profile_instance_id,
    mutate: (r) => {
      r.bindings[binding.profile_instance_id] = binding;
      return r;
    },
  });
}

async function upgraded(f, offset = 5) {
  const plan = await f.plan();
  const applied = JSON.parse((await f.run("upgrade-registry", ["--confirm", plan.planId, "--json"], { identityDependencies: { now: clock(offset) } })).out);
  return applied.backup.dir;
}

test("restore plans first: what is live, what the backup is, what would be discarded, and writes nothing", async (t) => {
  const f = fixture(t);
  const v1Bytes = f.files();
  const backup = await upgraded(f);
  bindV2(f.registry, "gamma");
  void v1Bytes;
  const before = f.listing();
  const human = await f.run("restore-registry", ["--from", backup]);
  assert.equal(human.code, 0, human.err);
  for (const needle of [
    "Identity registry restore plan",
    "Live:     v2",
    "sequence 5",
    `Backup:   ${backup}`,
    "sequence 3",
    "The live registry has this backup's history and more.",
    "Would discard 2 audit entries",
    "upgrade",
    "bind",
    "before-restore-<state>-<time>",
    "To apply this plan (needs a terminal):",
  ]) assert.ok(human.out.includes(needle), `${needle}\n${human.out}`);
  assert.deepEqual(f.listing(), before, "a restore plan writes nothing");
});

test("a restore puts the backup pair back, archives what it replaced, and is the way back from an upgrade", async (t) => {
  const f = fixture(t);
  const v1Bytes = f.files();
  const backup = await upgraded(f);
  const v2Bytes = f.files();
  const plan = JSON.parse((await f.run("restore-registry", ["--from", backup, "--json"])).out);
  assert.deepEqual([plan.ready, plan.relation, plan.discarded.map((e) => e.action)], [true, "ahead", ["upgrade"]]);

  const noTerminal = await f.run("restore-registry", ["--from", backup, "--confirm", plan.planId], { identityDependencies: { isTerminal: false } });
  assert.equal(noTerminal.code, 2);
  const wrong = await f.run("restore-registry", ["--from", backup, "--confirm", "f".repeat(64)]);
  assert.equal(wrong.code, 2);
  assert.ok(wrong.err.includes("(plan_stale)"));
  assert.deepEqual(f.files(), v2Bytes);

  const applied = await f.run("restore-registry", ["--from", backup, "--confirm", plan.planId, "--json"], { identityDependencies: { now: clock(20) } });
  assert.equal(applied.code, 0, applied.err);
  const result = JSON.parse(applied.out);
  assert.deepEqual([result.schema, result.restored.schema, result.restored.sequence, result.previous.schema, result.relation], ["identity_registry_restore_result_v1", V1, 3, V2, "ahead"]);
  assert.deepEqual(f.files(), v1Bytes, "the registry is byte for byte what it was before the upgrade");
  assert.equal(result.archive.dir, path.join(f.app, "identity-backups", `before-restore-v2-${stamp(clock(20)())}`));
  assert.deepEqual([path.join(result.archive.dir, REGISTRY_FILE), path.join(result.archive.dir, AUDIT_FILE)].map((file) => fs.readFileSync(file).toString("hex")), v2Bytes);
  assert.equal(readIdentityRegistry({ root: f.registry }).registry.schema, V1);

  // and the upgrade can be planned again from there
  assert.equal((await f.plan()).ready, true);
  const human = await f.run("restore-registry", ["--from", backup, "--confirm", (JSON.parse((await f.run("restore-registry", ["--from", backup, "--json"])).out)).planId]);
  assert.equal(human.code, 0, human.err);
  assert.ok(human.out.includes("Restored the identity registry to identity_registry_v1 (sequence 3)."), human.out);
});

test("a restore says what it changes for routing: a revoke it would undo, a binding it adds or removes", async (t) => {
  const f = fixture(t);
  const backup = backupIdentityRegistry({ root: f.registry, backupParent: path.join(f.app, "identity-backups"), now: clock(1)() });
  const beta = makeMeshManagedBinding("beta");
  updateIdentityRegistry({
    root: f.registry,
    expectedSequence: 3,
    action: "revoke",
    subject: beta.profile_instance_id,
    now: clock(2)(),
    mutate: (r) => { r.bindings[beta.profile_instance_id].revoked_at = clock(2)(); return r; },
  });
  bindProfileInRegistry(f.registry, "gamma", 4);
  const human = await f.run("restore-registry", ["--from", backup.dir]);
  assert.equal(human.code, 1, "a plan that cannot be applied yet exits 1");
  assert.ok(human.out.includes("What changes for routing (principal sends):"), human.out);
  assert.match(human.out, /! beta \(agent_[a-f0-9]{32}\): a REVOKE IS UNDONE, this binding routes again/);
  assert.match(human.out, /- gamma \(agent_[a-f0-9]{32}\): removed \(the live registry has it, the backup does not\)/);
  // a plan that would undo a revoke is not ready until the owner accepts the routing changes, and says so
  assert.ok(human.out.includes("restore_would_change_routing"), human.out);
  assert.ok(!human.out.includes("To apply this plan"), human.out);
  const blocked = JSON.parse((await f.run("restore-registry", ["--from", backup.dir, "--json"])).out);
  assert.deepEqual([blocked.ready, blocked.refusals, blocked.routingAcknowledgement], [false, ["restore_would_change_routing"], ["reactivates_revoked_binding"]]);
  const refused = await f.run("restore-registry", ["--from", backup.dir, "--confirm", blocked.planId]);
  assert.equal(refused.code, 1);
  assert.ok(refused.err.includes("(restore_would_change_routing)"), refused.err);
  assert.equal(readIdentityRegistry({ root: f.registry }).registry.bindings[beta.profile_instance_id].revoked_at !== null, true, "still revoked");

  const accepted = await f.run("restore-registry", ["--from", backup.dir, "--accept-routing-changes"]);
  assert.equal(accepted.code, 0, accepted.err);
  assert.ok(accepted.out.includes("You accepted these routing changes (--accept-routing-changes)"), accepted.out);
  assert.match(accepted.out, /restore-registry --client-root .* --accept-routing-changes --confirm [a-f0-9]{64}/);
  const plan = JSON.parse((await f.run("restore-registry", ["--from", backup.dir, "--accept-routing-changes", "--json"])).out);
  assert.notEqual(plan.planId, blocked.planId, "the acceptance is part of the plan id");
  assert.deepEqual([plan.ready, plan.routing.reactivated.map((x) => x.profile), plan.routing.removed.map((x) => x.profile)], [true, ["beta"], ["gamma"]]);
  const withoutFlag = await f.run("restore-registry", ["--from", backup.dir, "--confirm", plan.planId]);
  assert.equal(withoutFlag.code, 2, "the id of the accepted plan does not work without the flag");
  const applied = await f.run("restore-registry", ["--from", backup.dir, "--accept-routing-changes", "--confirm", plan.planId], { identityDependencies: { now: clock(9) } });
  assert.equal(applied.code, 0, applied.err);
  assert.ok(applied.out.includes("Revoked bindings that route again: beta. Revoke them again with triangle identity revoke if that is not wanted."), applied.out);
  assert.equal(readIdentityRegistry({ root: f.registry }).registry.bindings[beta.profile_instance_id].revoked_at, null);
});

test("a restore that would lose v2-only data needs --discard-v2-data, which is part of the plan id", async (t) => {
  const f = fixture(t);
  const backup = await upgraded(f);
  const peer = peerBindingV2("peerprof");
  const pair = serverlessPairing(1, peer.principal_id);
  appendAndCommit(f.registry, {
    action: "bind",
    subject: peer.profile_instance_id,
    bindingId: peer.binding_id,
    at: new Date(START + 30_000).toISOString(),
    change: (r) => ({ ...r, bindings: { ...r.bindings, [peer.profile_instance_id]: peer }, pairings: { [pair.pairing_id]: pair } }),
  });
  const bytes = f.files();
  const blocked = await f.run("restore-registry", ["--from", backup]);
  assert.equal(blocked.code, 1);
  assert.ok(blocked.out.includes("Would lose v2-only data: 1 serverless binding, 1 pairing, 0 aliases, 0 destinations."), blocked.out);
  assert.ok(blocked.out.includes("restore_would_lose_v2_data"));
  assert.ok(!blocked.out.includes("To apply this plan"));
  const plain = JSON.parse((await f.run("restore-registry", ["--from", backup, "--json"])).out);
  const refused = await f.run("restore-registry", ["--from", backup, "--confirm", plain.planId]);
  assert.equal(refused.code, 1);
  assert.ok(refused.err.includes("(restore_would_lose_v2_data)"), refused.err);
  assert.deepEqual(f.files(), bytes);

  const withFlag = JSON.parse((await f.run("restore-registry", ["--from", backup, "--discard-v2-data", "--json"])).out);
  assert.equal(withFlag.ready, true);
  assert.notEqual(withFlag.planId, plain.planId);
  // the id made without the flag cannot be used with it
  const mismatched = await f.run("restore-registry", ["--from", backup, "--discard-v2-data", "--confirm", plain.planId]);
  assert.equal(mismatched.code, 2);
  const done = await f.run("restore-registry", ["--from", backup, "--discard-v2-data", "--confirm", withFlag.planId, "--json"], { identityDependencies: { now: clock(40) } });
  assert.equal(done.code, 0, done.err);
  assert.equal(readIdentityRegistry({ root: f.registry }).registry.schema, V1);
  assert.deepEqual(readIdentityRegistry({ root: JSON.parse(done.out).archive.dir }).registry.schema, V2);
});

test("a restore is refused for a backup that is not a clean v1 copy, and for live files that changed since the plan", async (t) => {
  const f = fixture(t);
  const backup = await upgraded(f);
  // the v2 pair is not a restorable backup
  const asBackup = path.join(f.app, "identity-backups", "copy-of-live");
  fs.mkdirSync(asBackup, { mode: 0o700 });
  for (const name of [REGISTRY_FILE, AUDIT_FILE]) {
    fs.writeFileSync(path.join(asBackup, name), fs.readFileSync(path.join(f.registry, name)));
    fs.chmodSync(path.join(asBackup, name), 0o600);
  }
  const notV1 = await f.run("restore-registry", ["--from", asBackup]);
  assert.equal(notV1.code, 1);
  assert.ok(notV1.err.includes("(restore_backup_not_v1)"), notV1.err);
  const missing = await f.run("restore-registry", ["--from", path.join(f.app, "identity-backups", "nope")]);
  assert.equal(missing.code, 1);
  assert.ok(missing.err.includes("(restore_backup_unreadable)"), missing.err);
  const inside = await f.run("restore-registry", ["--from", path.join(f.registry, "inner")]);
  assert.equal(inside.code, 1);
  assert.ok(inside.err.includes("(backup_overlaps_registry_root)"), inside.err);

  // live files that changed after the plan
  const plan = JSON.parse((await f.run("restore-registry", ["--from", backup, "--json"])).out);
  const seq = readIdentityRegistry({ root: f.registry }).registry.sequence;
  updateIdentityRegistry({ root: f.registry, expectedSequence: seq, action: "revoke", subject: JSON.parse(fs.readFileSync(path.join(f.registry, REGISTRY_FILE), "utf8")).bindings && Object.keys(readIdentityRegistry({ root: f.registry }).registry.bindings)[0], now: new Date(START + 50_000).toISOString(), mutate: (r) => { const id = Object.keys(r.bindings)[0]; r.bindings[id].revoked_at = new Date(START + 50_000).toISOString(); return r; } });
  const bytes = f.files();
  const stale = await f.run("restore-registry", ["--from", backup, "--confirm", plan.planId]);
  assert.equal(stale.code, 2);
  assert.ok(stale.err.includes("(plan_stale)"));
  assert.deepEqual(f.files(), bytes);
});

test("a restore plan shows an unfinished audit line in the live registry, which the archive keeps", async (t) => {
  const f = fixture(t);
  const backup = backupIdentityRegistry({ root: f.registry, backupParent: path.join(f.app, "identity-backups"), now: clock(1)() });
  const gamma = makeMeshManagedBinding("gamma");
  assert.throws(
    () => updateIdentityRegistry({
      root: f.registry,
      expectedSequence: 3,
      action: "bind",
      subject: gamma.profile_instance_id,
      now: clock(2)(),
      mutate: (r) => { r.bindings[gamma.profile_instance_id] = gamma; return r; },
      faultHook: (stage) => { if (stage === "after_audit_append") throw new Error("boom"); },
    }),
    /boom/,
  );
  assert.equal(readIdentityRegistry({ root: f.registry }).audit.uncommittedTail, 1);
  const human = await f.run("restore-registry", ["--from", backup.dir]);
  assert.equal(human.code, 0, human.err);
  assert.ok(human.out.includes("An interrupted write left an unfinished audit line; it is archived with the live files."), human.out);
  const plan = JSON.parse((await f.run("restore-registry", ["--from", backup.dir, "--json"])).out);
  assert.equal(plan.live.uncommittedTail, 1);
  const applied = JSON.parse((await f.run("restore-registry", ["--from", backup.dir, "--confirm", plan.planId, "--json"], { identityDependencies: { now: clock(9) } })).out);
  const archived = fs.readFileSync(path.join(applied.archive.dir, AUDIT_FILE), "utf8").trim().split("\n");
  assert.equal(archived.length, 4, "the unfinished line is in the archive");
  assert.equal(readIdentityRegistry({ root: f.registry }).audit.uncommittedTail, 0);
});

// ---- the command line -----------------------------------------------------------------------------------------------------------
test("usage errors: roots, flags and positional arguments", async (t) => {
  const f = fixture(t);
  const call = async (argv) => {
    const err = [];
    const code = await main(argv, { env: {}, io: { stdout: () => {}, stderr: (s) => err.push(s) }, identityDependencies: { isTerminal: true, runSupervisorStatus: async () => okStatus(), now: clock() } });
    return { code, err: err.join("\n") };
  };
  const base = ["identity", "upgrade-registry"];
  assert.match((await call(base)).err, /requires --client-root ABSOLUTE_PATH/);
  assert.match((await call([...base, "--client-root", "relative"])).err, /--client-root must be an absolute path/);
  assert.match((await call([...base, "--client-root", "/"])).err, /must not be the filesystem root/);
  assert.match((await call([...base, "--client-root", f.client, "--registry-root", "rel"])).err, /--registry-root must be an absolute path/);
  assert.match((await call([...base, "--client-root", f.client, "--registry-root", f.client])).err, /registry root must not equal client root/);
  assert.match((await call([...base, "--client-root", f.client, "--registry-root", path.join(f.client, "inside")])).err, /must not be inside client root/);
  assert.match((await call([...base, "--client-root", f.client, "extra"])).err, /takes no positional arguments/);
  assert.match((await call([...base, "--client-root", f.client, "--from", "/x"])).err, /unknown option --from/);
  assert.match((await call([...base, "--client-root", f.client, "--discard-v2-data"])).err, /unknown option --discard-v2-data/);
  assert.match((await call([...base, "--client-root", f.client, "--accept-routing-changes"])).err, /unknown option --accept-routing-changes/);
  const restore = ["identity", "restore-registry", "--client-root", f.client];
  assert.match((await call(restore)).err, /requires --from BACKUP_DIR/);
  assert.match((await call([...restore, "--from", "relative"])).err, /--from must be an absolute path/);
  for (const argv of [base, restore]) assert.equal((await call(argv)).code, 2);
  assert.deepEqual(f.backups(), []);
});

test("the usage text lists both commands", async () => {
  const out = [];
  await main(["--help"], { env: {}, io: { stdout: (s) => out.push(s), stderr: (s) => out.push(s) } });
  const text = out.join("\n");
  assert.ok(text.includes("identity upgrade-registry --client-root DIR"));
  assert.ok(text.includes("identity restore-registry --client-root DIR --from BACKUP_DIR"));
});

