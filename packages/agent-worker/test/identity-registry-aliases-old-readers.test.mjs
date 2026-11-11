// AD.0: what the code that is installed TODAY does with a registry that holds aliases. The old code is the real thing: the
// agent-worker sources frozen at 62b75c1 (the D1-complete runtime that reads v2 and knows nothing of aliases), extracted with
// `git archive` and run against the files this release writes. It needs git history (a worktree, not a history-less archive);
// without it the test skips and says so.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { canonicalJson, readIdentityRegistry, setIdentityAlias } from "../src/identity-registry.mjs";
import { agentBindingV1, agentBindingV2, auditLines, makeV1Root, T2, upgradeThroughWriter } from "./identity-registry-v2-helpers.mjs";

const BASELINE_COMMIT = "62b75c1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = "packages/agent-worker/src";
const T3 = "2026-11-07T10:15:00.000Z";
const GRAVITY = agentBindingV1("gravity2").principal_id;
const GHOST = agentBindingV1("ghost").principal_id;
const GRAVITY_ID = deriveClientInstanceId("gravity2");
const GHOST_ID = deriveClientInstanceId("ghost");
const RECIPIENTS = [{ id: GRAVITY_ID, label: "gravity2" }];

// The frozen modules, or null when the history is not here.
async function loadFrozenRuntime(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "frozen-d1-")));
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

// A v2 root (gravity2 and ghost bound) that already holds two aliases, written by this release's writer.
async function withAliasedRoot(fn) {
  const { base, root } = makeV1Root(["gravity2", "ghost"]);
  try {
    upgradeThroughWriter(root);
    setIdentityAlias({ root, expectedSequence: readIdentityRegistry({ root }).registry.sequence, now: T2, alias: "builder", principalId: GRAVITY });
    setIdentityAlias({ root, expectedSequence: readIdentityRegistry({ root }).registry.sequence, now: T2, alias: "ghosty", principalId: GHOST });
    return await fn(root);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const send = (router, to) => router.resolveSend({ senderId: "s1", to }, { throwOnError: false });

test("today's reader reads a registry with aliases, keeps them, and verifies the chain through the alias entries", async (t) => {
  const frozen = await loadFrozenRuntime(t);
  if (!frozen) return;
  await withAliasedRoot((root) => {
    const mine = readIdentityRegistry({ root });
    const old = frozen.registry.readIdentityRegistry({ root });
    assert.equal(old.state, "ok");
    assert.equal(old.audit.uncommittedTail, 0);
    assert.equal(old.registry.schema, "identity_registry_v2");
    assert.equal(canonicalJson(old.registry), canonicalJson(mine.registry));
    assert.deepEqual(Object.keys(old.registry.aliases).sort(), ["builder", "ghosty"]);
    assert.deepEqual(auditLines(root).slice(-2).map((e) => e.action), ["alias_set", "alias_set"]);
  });
});

test("today's router ignores aliases: the name is an exact id that nothing routes, and principal and exact-id sends are unchanged", async (t) => {
  const frozen = await loadFrozenRuntime(t);
  if (!frozen) return;
  await withAliasedRoot(async (root) => {
    const provider = frozen.snapshot.createRegistrySnapshotProvider({ root });
    const router = frozen.router.createUnifiedRouter({ enabled: true, snapshotProvider: provider, recipients: RECIPIENTS });
    const alias = await send(router, "builder");
    assert.deepEqual([alias.ok, alias.via, alias.resolvedTo, alias.principal], [true, "id", "builder", null]);
    const principal = await send(router, GRAVITY);
    assert.deepEqual([principal.ok, principal.via, principal.resolvedTo], [true, "principal", GRAVITY_ID]);
    const exact = await send(router, GRAVITY_ID);
    assert.deepEqual([exact.ok, exact.via, exact.resolvedTo, exact.principal], [true, "id", GRAVITY_ID, GRAVITY]);
    const block = router.statusBlock();
    assert.deepEqual([block.registry.state, block.registry.schema, block.registry.supportedSchemas.includes("identity_registry_v2")], ["ok", "identity_registry_v2", true]);
  });
});

test("today's writer still binds and revokes in a registry that has aliases, and leaves them as they are", async (t) => {
  const frozen = await loadFrozenRuntime(t);
  if (!frozen) return;
  await withAliasedRoot((root) => {
    const aliasesBefore = canonicalJson(readIdentityRegistry({ root }).registry.aliases);
    const extra = agentBindingV2("codex-headless");
    const sequence = () => readIdentityRegistry({ root }).registry.sequence;
    frozen.registry.updateIdentityRegistry({
      root, expectedSequence: sequence(), now: T3, action: "bind", subject: extra.profile_instance_id,
      mutate: (r) => { r.bindings[extra.profile_instance_id] = extra; return r; },
    });
    frozen.registry.updateIdentityRegistry({
      root, expectedSequence: sequence(), now: T3, action: "revoke", subject: GHOST_ID,
      mutate: (r) => { r.bindings[GHOST_ID].revoked_at = T3; return r; },
    });
    // this release reads what the old writer wrote, aliases intact (one of them now dangles)
    const after = readIdentityRegistry({ root });
    assert.equal(after.audit.uncommittedTail, 0);
    assert.equal(canonicalJson(after.registry.aliases), aliasesBefore);
    assert.equal(after.registry.bindings[GHOST_ID].revoked_at, T3);
    assert.ok(after.registry.bindings[extra.profile_instance_id]);
  });
});

test("today's writer refuses the alias actions, and this release's writer does not", async (t) => {
  const frozen = await loadFrozenRuntime(t);
  if (!frozen) return;
  await withAliasedRoot((root) => {
    const sequence = readIdentityRegistry({ root }).registry.sequence;
    for (const [action, subject] of [["alias_set", "fresh"], ["alias_clear", "builder"]]) {
      assert.throws(
        () => frozen.registry.updateIdentityRegistry({ root, expectedSequence: sequence, now: T3, action, subject, mutate: (r) => r }),
        (err) => err.code === "invalid_registry" && err.reason === "action_not_available",
        action,
      );
    }
    const out = setIdentityAlias({ root, expectedSequence: sequence, now: T3, alias: "fresh", principalId: GRAVITY });
    assert.equal(out.registry.aliases.fresh.principal_id, GRAVITY);
    assert.equal(readIdentityRegistry({ root }).audit.uncommittedTail, 0);
  });
});
