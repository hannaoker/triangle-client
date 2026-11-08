// D1.3: what the code that is installed TODAY does with a registry this command upgraded. The old code is the real thing: the
// agent-worker sources frozen at d418fb1 (the last main before any v2 code, the v14 runtime), extracted with `git archive` and
// run against the files this release writes. It needs git history (a worktree, not a history-less archive), like the v12
// baseline test in r1-integration-v13; without it the test skips and says so.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { main } from "../src/cli.mjs";
import { planRegistryUpgrade } from "../src/identity-upgrade.mjs";
import { makeMeshManagedBinding } from "../../agent-worker/test/local-messaging-identity-fixtures.mjs";
import { createRegistrySnapshotProvider } from "../../agent-worker/src/router-registry-snapshot.mjs";
import { createUnifiedRouter } from "../../agent-worker/src/unified-router.mjs";
import { AUDIT_FILE, REGISTRY_FILE, V1, V2, clock, fixture, sha256Hex } from "./identity-registry-upgrade-helpers.mjs";

const BASELINE_COMMIT = "d418fb1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = "packages/agent-worker/src";

// The frozen modules, or null when the history is not here.
async function loadFrozenRuntime(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "frozen-v14-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync("git", ["cat-file", "-e", `${BASELINE_COMMIT}^{commit}`], { cwd: REPO_ROOT, stdio: "ignore" });
    const tarball = execFileSync("git", ["archive", "--format=tar", BASELINE_COMMIT, SRC], { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", dir], { input: tarball });
  } catch {
    t.skip(`git history for ${BASELINE_COMMIT} is not available here`);
    return null;
  }
  const url = (name) => pathToFileURL(path.join(dir, SRC, name)).href;
  return {
    registry: await import(url("identity-registry.mjs")),
    snapshot: await import(url("router-registry-snapshot.mjs")),
    router: await import(url("unified-router.mjs")),
  };
}

async function upgrade(f) {
  const plan = await f.plan();
  const applied = await f.run("upgrade-registry", ["--confirm", plan.planId, "--json"], { identityDependencies: { now: clock(5) } });
  assert.equal(applied.code, 0, applied.err);
  return JSON.parse(applied.out);
}

const ALPHA = makeMeshManagedBinding("alpha");
const RECIPIENTS = [{ id: ALPHA.profile_instance_id, label: "alpha" }];
const send = (router, to) => router.resolveSend({ senderId: "s1", to }, { throwOnError: false });

test("today's reader refuses the upgraded registry loudly, and still reads the backup and the registry before the upgrade", async (t) => {
  const frozen = await loadFrozenRuntime(t);
  if (!frozen) return;
  const f = fixture(t);
  assert.equal(frozen.registry.readIdentityRegistry({ root: f.registry }).registry.schema, V1, "control: the old reader reads the v1 registry");
  const result = await upgrade(f);

  assert.throws(
    () => frozen.registry.readIdentityRegistry({ root: f.registry }),
    (err) => err.code === "registry_corrupt" && err.reason === "unknown_registry_key",
  );
  // the backup is a plain v1 pair: a rolled-back runtime can read it, and so could a restore
  const backup = frozen.registry.readIdentityRegistry({ root: result.backup.dir });
  assert.deepEqual([backup.registry.schema, backup.registry.sequence, backup.audit.uncommittedTail], [V1, 3, 0]);
});

test("with the upgraded registry today's router fails principal sends closed, keeps exact-id sends working, and shows no v2 capability", async (t) => {
  const frozen = await loadFrozenRuntime(t);
  if (!frozen) return;
  const f = fixture(t);
  const frozenRouter = frozen.router.createUnifiedRouter({ enabled: true, snapshotProvider: frozen.snapshot.createRegistrySnapshotProvider({ root: f.registry }), recipients: RECIPIENTS });
  const before = await send(frozenRouter, ALPHA.principal_id);
  assert.deepEqual([before.ok, before.via, before.resolvedTo], [true, "principal", ALPHA.profile_instance_id], "control: before the upgrade the old router resolves the principal");

  await upgrade(f);
  // a fresh provider, as a restarted supervisor would have (the cached one would re-read the replaced file anyway)
  const oldProvider = frozen.snapshot.createRegistrySnapshotProvider({ root: f.registry });
  const snapshot = oldProvider.get();
  assert.deepEqual([snapshot.state, snapshot.errorCode], ["unreadable", "registry_corrupt"]);
  const router = frozen.router.createUnifiedRouter({ enabled: true, snapshotProvider: oldProvider, recipients: RECIPIENTS });
  const principal = await send(router, ALPHA.principal_id);
  assert.deepEqual([principal.ok, principal.code, principal.reason], [false, "route_unavailable", "registry_unreadable"]);
  const exact = await send(router, ALPHA.profile_instance_id);
  assert.deepEqual([exact.ok, exact.via, exact.resolvedTo, exact.principal], [true, "id", ALPHA.profile_instance_id, null]);
  const peer = await send(router, `peer_${"1".repeat(32)}`);
  assert.deepEqual([peer.ok, peer.code, peer.reason], [false, "recipient_not_found", "peer_not_supported"]);

  // what that router reports in local_status, and what the upgrade floor makes of it
  const reported = router.statusBlock();
  assert.deepEqual([reported.registry.state, "supportedSchemas" in reported.registry], ["unreadable", false]);
  const verdict = await planRegistryUpgrade({
    clientRoot: f.client,
    registryRoot: f.registry,
    readSupervisorManifestVersion: () => 14,
    runSupervisorStatus: async () => ({ router: reported }),
  });
  assert.equal(verdict.floor.supervisor.code, "supervisor_cannot_read_v2");
});

test("the floor passes only for a router that reports it can read v2: today's does not, this release's does", async (t) => {
  const frozen = await loadFrozenRuntime(t);
  if (!frozen) return;
  const f = fixture(t);
  // the server adds the digest of the registry directory it reads to the router's block; the old one knows no such field
  const withRoot = (block) => (block.registry ? { ...block, registry: { ...block.registry, rootSha256: sha256Hex(f.registry) } } : block);
  const verdictFor = async (router) => (await planRegistryUpgrade({
    clientRoot: f.client,
    registryRoot: f.registry,
    readSupervisorManifestVersion: () => 14,
    runSupervisorStatus: async () => ({ router: withRoot(router.statusBlock()) }),
  })).floor.supervisor;
  const oldRouter = frozen.router.createUnifiedRouter({ enabled: true, snapshotProvider: frozen.snapshot.createRegistrySnapshotProvider({ root: f.registry }), recipients: RECIPIENTS });
  const newRouter = createUnifiedRouter({ enabled: true, snapshotProvider: createRegistrySnapshotProvider({ root: f.registry }), recipients: RECIPIENTS });
  const old = await verdictFor(oldRouter);
  assert.deepEqual([old.ok, old.code, old.detail], [false, "supervisor_cannot_read_v2", "supportedSchemas_not_reported"]);
  const current = await verdictFor(newRouter);
  assert.deepEqual([current.ok, current.supportedSchemas], [true, [V1, V2]]);
});

test("a crashed upgrade leaves a registry today's reader cannot read; the backup and the restore put the clean pair back", async (t) => {
  const frozen = await loadFrozenRuntime(t);
  if (!frozen) return;
  const f = fixture(t);
  const plan = await f.plan();
  const crashed = await f.run("upgrade-registry", ["--confirm", plan.planId], {
    identityDependencies: { now: clock(5), faultHook: (stage) => { if (stage === "after_audit_append") throw Object.assign(new Error("boom"), { code: "boom" }); } },
  });
  assert.equal(crashed.code, 1);
  // this release still reads it (v1 with one unfinished line); an older reader chokes on the unknown action in that line
  assert.equal((await f.plan()).registry.uncommittedTail, 1);
  assert.throws(
    () => frozen.registry.readIdentityRegistry({ root: f.registry }),
    (err) => err.code === "registry_chain_broken" && err.reason === "invalid_audit_action",
  );
  // the failure message says how to put the clean pair back, and that does
  // the hint is a command that can be pasted: every path quoted (the default location has a space in it), both roots named
  assert.match(crashed.err, /To put the clean pair back: triangle identity restore-registry --client-root '[^']*The Triangle\/client' --registry-root '[^']*The Triangle\/identity' --from '[^']*identity-backups\/backup-v1-[^']*'/);
  const backup = crashed.err.match(/A backup was made first: (.+)/)[1];
  const restorePlan = JSON.parse((await f.run("restore-registry", ["--from", backup, "--json"])).out);
  const restored = await f.run("restore-registry", ["--from", backup, "--confirm", restorePlan.planId], { identityDependencies: { now: clock(9) } });
  assert.equal(restored.code, 0, restored.err);
  const read = frozen.registry.readIdentityRegistry({ root: f.registry });
  assert.deepEqual([read.registry.schema, read.registry.sequence, read.audit.uncommittedTail], [V1, 3, 0]);
  assert.ok(fs.readFileSync(path.join(f.registry, AUDIT_FILE), "utf8").split("\n").filter(Boolean).every((line) => !line.includes('"upgrade"')));
  assert.ok(fs.existsSync(path.join(f.registry, REGISTRY_FILE)));
});
