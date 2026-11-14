// AD.5: router-registry-snapshot exports destination rules cleanly on v2 registries (agent_* only) and reacts to writes.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { clearIdentityDestination, readIdentityRegistry, setIdentityDestination } from "../src/identity-registry.mjs";
import { createRegistrySnapshotProvider } from "../src/router-registry-snapshot.mjs";
import { agentBindingV1, makeRoot, makeV1Root, peerBindingV2, T2, upgradeThroughWriter } from "./identity-registry-v2-helpers.mjs";

const T3 = "2026-11-07T10:15:00.000Z";
const GRAVITY = agentBindingV1("gravity2").principal_id;
const GHOST = agentBindingV1("ghost").principal_id;

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
const setDest = (root, principalId, harness, workspace) =>
  setIdentityDestination({ root, expectedSequence: seqOf(root), now: T3, principalId, harness, workspace });

test("v2 destination rules reach snapshot sorted by principalId with safe prototype lookups", () => {
  withRoot((root) => {
    setDest(root, GRAVITY, "claude", "/workspaces/g");
    setDest(root, GHOST, "codex", "/workspaces/gh");
    const snapshot = createRegistrySnapshotProvider({ root }).get();
    assert.equal(snapshot.state, "ok");
    const expectedOrder = [GHOST, GRAVITY].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(snapshot.destinations().map((d) => d.principalId), expectedOrder);
    assert.deepEqual(snapshot.destinationFor(GRAVITY), {
      principalId: GRAVITY,
      harness: "claude",
      workspace: "/workspaces/g",
      setAt: T3,
      generation: snapshot.destinationFor(GRAVITY).generation,
      bindingGeneration: 1,
      authorityOrigin: "https://mesh.example.test",
    });
    assert.deepEqual(snapshot.destinationFor(GHOST).harness, "codex");
    assert.equal(snapshot.destinationFor(`agent_${"9".repeat(32)}`), null);
    for (const inherited of ["toString", "valueOf", "hasOwnProperty", "__proto__", "constructor"]) {
      assert.equal(snapshot.destinationFor(inherited), null);
    }
    assert.equal(Object.isFrozen(snapshot.destinations()), true);
    assert.equal(Object.isFrozen(snapshot.destinationFor(GRAVITY)), true);
  });
});

test("v1, absent, and unreadable snapshots expose null destinationFor and empty destinations()", () => {
  withRoot((root) => {
    const snap = createRegistrySnapshotProvider({ root }).get();
    assert.equal(snap.destinationFor(GRAVITY), null);
    assert.deepEqual(snap.destinations(), []);
  }, { upgrade: false });

  const { base, root } = makeRoot();
  try {
    const absent = createRegistrySnapshotProvider({ root }).get();
    assert.equal(absent.destinationFor(GRAVITY), null);
    assert.deepEqual(absent.destinations(), []);

    const unreadable = createRegistrySnapshotProvider({
      root,
      readRegistry: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
    }).get();
    assert.equal(unreadable.destinationFor(GRAVITY), null);
    assert.deepEqual(unreadable.destinations(), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("snapshot excludes non-agent keys even on malformed inputs and reacts immediately to set/clear", () => {
  const peer = peerBindingV2("peerprof");
  const snap = createRegistrySnapshotProvider({
    root: "/fake/root",
    statRegistry: () => "stat-1",
    readRegistry: () => ({
      state: "ok",
      registry: {
        schema: "identity_registry_v2",
        sequence: 5,
        bindings: { [peer.profile_instance_id]: peer },
        aliases: {},
        destinations: {
          [peer.principal_id]: { harness: "claude", workspace: "/w", set_at: T2, generation: 5 },
          [GRAVITY]: { harness: "codex", workspace: "/w2", set_at: T3, generation: 5 },
        },
      },
    }),
  }).get();
  assert.equal(snap.destinationFor(peer.principal_id), null);
  // A well-shaped agent rule with no active mesh binding is not routable.
  assert.equal(snap.destinationFor(GRAVITY), null);
  assert.deepEqual(snap.destinations(), []);

  withRoot((root) => {
    const provider = createRegistrySnapshotProvider({ root, ttlMs: 60_000 });
    assert.equal(provider.get().destinationFor(GRAVITY), null);
    setDest(root, GRAVITY, "claude", "/workspaces/g");
    assert.equal(provider.get().destinationFor(GRAVITY).workspace, "/workspaces/g");
    clearIdentityDestination({ root, expectedSequence: seqOf(root), now: T3, principalId: GRAVITY });
    assert.equal(provider.get().destinationFor(GRAVITY), null);
  });
});
