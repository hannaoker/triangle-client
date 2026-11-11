// AD.1: the registry snapshot hands the router the alias names of a v2 registry (and nothing else of the new collections), read from
// real registries written by the real writer.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { clearIdentityAlias, readIdentityRegistry, setIdentityAlias, updateIdentityRegistry } from "../src/identity-registry.mjs";
import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { createRegistrySnapshotProvider } from "../src/router-registry-snapshot.mjs";
import { agentBindingV1, makeRoot, makeV1Root, T2, upgradeThroughWriter } from "./identity-registry-v2-helpers.mjs";

const T3 = "2026-11-07T10:15:00.000Z";
const GRAVITY = agentBindingV1("gravity2").principal_id;
const GHOST = agentBindingV1("ghost").principal_id;
const GHOST_ID = deriveClientInstanceId("ghost");

function withRoot(fn, { upgrade = true } = {}) {
  const { base, root } = makeV1Root(["gravity2", "ghost"]);
  try {
    if (upgrade) upgradeThroughWriter(root);
    return fn(root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const seqOf = (root) => readIdentityRegistry({ root }).registry.sequence;
const setAlias = (root, alias, principalId) => setIdentityAlias({ root, expectedSequence: seqOf(root), now: T3, alias, principalId });

test("a v2 registry's aliases reach the snapshot as names and targets, sorted, with prototype names as ordinary names", () => {
  withRoot((root) => {
    setAlias(root, "builder", GRAVITY);
    setAlias(root, "constructor", GRAVITY);
    setAlias(root, "ghosty", GHOST);
    const snapshot = createRegistrySnapshotProvider({ root }).get();
    assert.equal(snapshot.state, "ok");
    assert.equal(snapshot.aliasFor("builder"), GRAVITY);
    assert.equal(snapshot.aliasFor("ghosty"), GHOST);
    assert.equal(snapshot.aliasFor("constructor"), GRAVITY);
    assert.equal(snapshot.aliasFor("nobody"), null);
    for (const inherited of ["toString", "valueOf", "hasOwnProperty", "__proto__"]) assert.equal(snapshot.aliasFor(inherited), null, inherited);
    assert.deepEqual([...snapshot.aliasesFor(GRAVITY)], ["builder", "constructor"]);
    assert.deepEqual([...snapshot.aliasesFor(GHOST)], ["ghosty"]);
    assert.equal(Object.isFrozen(snapshot.aliasesFor(GRAVITY)), true);
    assert.deepEqual([...snapshot.aliasesFor(`agent_${"9".repeat(32)}`)], []);
    assert.deepEqual([...snapshot.aliasesFor("constructor")], []);
  });
});

test("alias names are sorted by code unit, not in the order a JavaScript object lists integer-like keys", () => {
  withRoot((root) => {
    for (const name of ["9", "10", "2a", "b", "a1", "0"]) setAlias(root, name, GRAVITY);
    const snapshot = createRegistrySnapshotProvider({ root }).get();
    assert.deepEqual([...snapshot.aliasesFor(GRAVITY)], ["0", "10", "2a", "9", "a1", "b"]);
  });
});

test("alias names with punctuation are ordered by code unit too, which is the order the client checks", () => {
  withRoot((root) => {
    for (const name of ["a_b", "ab", "a-b", "b", "a9", "a.b", "a0"]) setAlias(root, name, GRAVITY);
    const snapshot = createRegistrySnapshotProvider({ root }).get();
    assert.deepEqual([...snapshot.aliasesFor(GRAVITY)], ["a-b", "a.b", "a0", "a9", "a_b", "ab", "b"], "'-' < '.' < digits < '_' < letters; a locale order would put a_b first");
  });
});

test("a v1 registry has no aliases, and neither has an absent or unreadable one", () => {
  withRoot((root) => {
    const snapshot = createRegistrySnapshotProvider({ root }).get();
    assert.equal(snapshot.schema, "identity_registry_v1");
    assert.equal(snapshot.aliasFor("builder"), null);
    assert.deepEqual([...snapshot.aliasesFor(GRAVITY)], []);
  }, { upgrade: false });

  const { base, root } = makeRoot();
  try {
    const absent = createRegistrySnapshotProvider({ root }).get();
    assert.equal(absent.state, "absent");
    assert.equal(absent.aliasFor("builder"), null);
    assert.deepEqual([...absent.aliasesFor(GRAVITY)], []);
    const unreadable = createRegistrySnapshotProvider({
      root,
      readRegistry: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
    }).get();
    assert.equal(unreadable.state, "unreadable");
    assert.equal(unreadable.aliasFor("builder"), null);
    assert.deepEqual([...unreadable.aliasesFor(GRAVITY)], []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the provider picks up a set and a clear as soon as the registry file changes", () => {
  withRoot((root) => {
    const provider = createRegistrySnapshotProvider({ root, ttlMs: 60_000 });
    assert.equal(provider.get().aliasFor("builder"), null);
    setAlias(root, "builder", GRAVITY);
    assert.equal(provider.get().aliasFor("builder"), GRAVITY, "the new file has a new stat key, so the long TTL does not hide it");
    clearIdentityAlias({ root, expectedSequence: seqOf(root), now: T3, alias: "builder" });
    assert.equal(provider.get().aliasFor("builder"), null);
  });
});

test("an alias to a revoked principal is still handed over: whether it routes is the resolver's decision", () => {
  withRoot((root) => {
    setAlias(root, "ghosty", GHOST);
    updateIdentityRegistry({
      root,
      expectedSequence: seqOf(root),
      now: T2,
      action: "revoke",
      subject: GHOST_ID,
      mutate: (registry) => { registry.bindings[GHOST_ID].revoked_at = T2; return registry; },
    });
    const snapshot = createRegistrySnapshotProvider({ root }).get();
    assert.equal(snapshot.aliasFor("ghosty"), GHOST);
    assert.deepEqual([...snapshot.bindingsFor(GHOST)], [], "a revoked binding is not handed over");
  });
});
