// AD.5: the destination writer (`destination_set` create-only, `destination_clear` remove), audited on stored v2 only.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import test from "node:test";

import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import {
  canonicalJson,
  clearIdentityDestination,
  MAX_REGISTRY_DESTINATIONS,
  readIdentityRegistry,
  setIdentityDestination,
  updateIdentityRegistry,
} from "../src/identity-registry.mjs";
import {
  agentBindingV1,
  appendAndCommit,
  auditLines,
  hex32,
  hex64,
  makeRoot,
  makeV1Root,
  peerBindingV2,
  readRaw,
  serverlessPairing as pairing,
  snapshotFiles,
  T2,
  upgradeThroughWriter,
} from "./identity-registry-v2-helpers.mjs";

const T3 = "2026-11-07T10:15:00.000Z";
const T4 = "2026-11-07T10:20:00.000Z";
const GRAVITY = agentBindingV1("gravity2").principal_id;
const GHOST = agentBindingV1("ghost").principal_id;
const GRAVITY_ID = deriveClientInstanceId("gravity2");
const GHOST_ID = deriveClientInstanceId("ghost");

function withV1Root(fn, names) {
  const { base, root } = makeV1Root(names);
  try {
    return fn(root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function withV2Root(fn, names) {
  return withV1Root((root) => {
    upgradeThroughWriter(root);
    return fn(root);
  }, names);
}

function expectError(fn, code, reason) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, err.message);
    if (reason !== undefined) assert.equal(err.reason, reason, err.message);
    return true;
  });
}

const seqOf = (root) => readIdentityRegistry({ root }).registry.sequence;
const setDest = (root, principalId, harness, workspace, { now = T3, expectedSequence } = {}) =>
  setIdentityDestination({
    root,
    expectedSequence: expectedSequence ?? seqOf(root),
    now,
    principalId,
    harness,
    workspace,
  });
const clearDest = (root, principalId, { now = T4, expectedSequence } = {}) =>
  clearIdentityDestination({
    root,
    expectedSequence: expectedSequence ?? seqOf(root),
    now,
    principalId,
  });
const rawWrite = (root, action, subject, mutate, { now = T3, expectedSequence } = {}) =>
  updateIdentityRegistry({
    root,
    expectedSequence: expectedSequence ?? seqOf(root),
    now,
    action,
    subject,
    mutate,
  });

test("bad principal subjects are refused before reading or creating root", () => {
  const { base, root } = makeRoot();
  try {
    for (const bad of ["", "builder", GRAVITY_ID, "agent_short", hex64("a")]) {
      expectError(
        () => setIdentityDestination({ root, expectedSequence: 0, now: T3, principalId: bad, harness: "claude", workspace: "/w" }),
        "invalid_registry",
        "invalid_audit_subject",
      );
      expectError(
        () => clearIdentityDestination({ root, expectedSequence: 0, now: T3, principalId: bad }),
        "invalid_registry",
        "invalid_audit_subject",
      );
    }
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("subject shape rules for destination actions", () => {
  withV2Root((root) => {
    const seq = seqOf(root);
    const filesBefore = snapshotFiles(root);
    expectError(() => rawWrite(root, "destination_set", null, (r) => r), "invalid_registry", "subject_required_for_action");
    expectError(() => rawWrite(root, "destination_clear", null, (r) => r), "invalid_registry", "subject_required_for_action");
    expectError(() => rawWrite(root, "destination_set", GRAVITY_ID, (r) => r), "invalid_registry", "invalid_audit_subject");
    assert.equal(seqOf(root), seq);
    assert.deepEqual(snapshotFiles(root), filesBefore);
  });
});

test("destination_set creates a rule in one audited step, clear removes it, and re-set advances generation", () => {
  withV2Root((root) => {
    const before = readIdentityRegistry({ root });
    const seq = before.registry.sequence;
    const set1 = setDest(root, GRAVITY, "claude", "/workspaces/app");
    assert.deepEqual(set1.registry.destinations[GRAVITY], {
      harness: "claude",
      workspace: "/workspaces/app",
      set_at: T3,
      generation: seq + 1,
    });
    assert.deepEqual(
      { ...set1.auditEntry },
      {
        sequence: seq + 1,
        at: T3,
        action: "destination_set",
        subject: GRAVITY,
        bindingId: null,
        prevHash: before.registry.auditHead.hash,
        hash: set1.auditEntry.hash,
      },
    );
    assert.deepEqual(auditLines(root).at(-1), set1.auditEntry);
    for (const name of ["bindings", "pairings", "aliases"]) {
      assert.equal(canonicalJson(set1.registry[name]), canonicalJson(before.registry[name]), name);
    }

    // Create-only: overwrite without clear is refused.
    const filesMid = snapshotFiles(root);
    expectError(() => setDest(root, GRAVITY, "codex", "/workspaces/app"), "destination_conflict", "destination_exists");
    assert.deepEqual(snapshotFiles(root), filesMid);

    // Clear removes it with audited destination_clear.
    const cleared = clearDest(root, GRAVITY);
    assert.deepEqual(cleared.registry.destinations, {});
    assert.equal(cleared.auditEntry.action, "destination_clear");
    assert.equal(cleared.auditEntry.subject, GRAVITY);
    assert.equal(cleared.auditEntry.bindingId, null);

    // Re-setting after clear gets the new sequence as generation.
    const set2 = setDest(root, GRAVITY, "codex", "/workspaces/app2", { now: T4 });
    assert.equal(set2.registry.destinations[GRAVITY].generation, seq + 3);
    assert.equal(set2.registry.destinations[GRAVITY].harness, "codex");
    assert.deepEqual(readRaw(root).auditHead, { sequence: seq + 3, hash: set2.auditEntry.hash });
  });
});

test("destination_set enforces active mesh-managed targets; destination_clear removes even dangling rules", () => {
  withV2Root((root) => {
    const peer = peerBindingV2("peerprof");
    const pair = pairing(1, peer.principal_id);
    appendAndCommit(root, {
      action: "bind",
      subject: peer.profile_instance_id,
      bindingId: peer.binding_id,
      change: (r) => ({
        ...r,
        bindings: { ...r.bindings, [peer.profile_instance_id]: peer },
        pairings: { [pair.pairing_id]: pair },
      }),
    });
    // Set destination for GHOST while active, then revoke GHOST.
    setDest(root, GHOST, "claude", "/workspaces/ghost");
    rawWrite(root, "revoke", GHOST_ID, (r) => { r.bindings[GHOST_ID].revoked_at = T2; return r; }, { now: T2 });
    const filesBefore = snapshotFiles(root);

    // Clear on missing rule fails; clear on now-revoked (dangling) GHOST succeeds.
    expectError(() => clearDest(root, GRAVITY), "invalid_registry", "destination_not_found");
    expectError(() => setDest(root, GHOST, "claude", "/workspaces/ghost"), "destination_conflict", "destination_exists");
    expectError(() => setDest(root, peer.principal_id, "codex", "/w"), "invalid_registry", "destination_target_not_mesh_managed");
    expectError(() => setDest(root, pair.remote_principal_id, "codex", "/w"), "invalid_registry", "destination_principal_unbound");
    expectError(() => setDest(root, `agent_${hex32("nobody")}`, "codex", "/w"), "invalid_registry", "destination_principal_unbound");
    assert.deepEqual(snapshotFiles(root), filesBefore);

    // Clearing the dangling GHOST destination works.
    const cleared = clearDest(root, GHOST);
    assert.equal(cleared.registry.destinations[GHOST], undefined);
    // Re-setting revoked GHOST is refused as inactive.
    expectError(() => setDest(root, GHOST, "claude", "/workspaces/ghost"), "invalid_registry", "destination_target_not_active");
  });
});

test("mutations that do not match destination_set or destination_clear fail closed", () => {
  const EXTRA = agentBindingV1("extra").principal_id;
  withV2Root((root) => {
    setDest(root, GRAVITY, "claude", "/workspaces/a", { now: T2 });
    const filesBefore = snapshotFiles(root);
    const seq = seqOf(root);
    const rec = (over = {}) => ({ harness: "codex", workspace: "/workspaces/b", set_at: T3, generation: seq + 1, ...over });
    const mismatch = ["invalid_registry", "mutation_does_not_match_action"];

    const setCases = {
      "wrong set_at": (r) => { r.destinations[GHOST] = rec({ set_at: T2 }); return r; },
      "wrong generation": (r) => { r.destinations[GHOST] = rec({ generation: seq }); return r; },
      "no change": (r) => r,
      "other principal added": (r) => { r.destinations[EXTRA] = rec(); return r; },
      "two principals added": (r) => { r.destinations[GHOST] = rec(); r.destinations[EXTRA] = rec(); return r; },
      "alias added too": (r) => { r.destinations[GHOST] = rec(); r.aliases.foo = { principal_id: GRAVITY, set_at: T3, generation: seq + 1 }; return r; },
      "binding mutated too": (r) => { r.destinations[GHOST] = rec(); r.bindings[GHOST_ID].issued_at = T3; return r; },
      "existing destination changed": (r) => { r.destinations[GHOST] = rec(); r.destinations[GRAVITY].workspace = "/other"; return r; },
    };
    for (const [label, mutate] of Object.entries(setCases)) {
      expectError(() => rawWrite(root, "destination_set", GHOST, mutate), ...mismatch);
      assert.deepEqual(snapshotFiles(root), filesBefore, label);
    }

    const clearCases = {
      "nothing removed": (r) => r,
      "wrong principal removed": (r) => { delete r.destinations[GHOST]; return r; },
      "modified instead of removed": (r) => { r.destinations[GRAVITY] = rec(); return r; },
      "alias modified while clearing": (r) => { delete r.destinations[GRAVITY]; r.aliases.foo = { principal_id: GHOST, set_at: T3, generation: seq + 1 }; return r; },
    };
    for (const [label, mutate] of Object.entries(clearCases)) {
      expectError(() => rawWrite(root, "destination_clear", GRAVITY, mutate), ...mismatch);
      assert.deepEqual(snapshotFiles(root), filesBefore, label);
    }

    expectError(() => setDest(root, GHOST, "grok", "/w"), "invalid_registry", "invalid_destination_harness");
    expectError(() => setDest(root, GHOST, "claude", "/a/../b"), "invalid_registry", "invalid_destination_workspace");
    assert.deepEqual(snapshotFiles(root), filesBefore);
  }, ["gravity2", "ghost", "extra"]);
});

test("v1 and absent registries refuse destination actions before sequence check", () => {
  withV1Root((root) => {
    const filesBefore = snapshotFiles(root);
    const seq = seqOf(root);
    expectError(() => setDest(root, GRAVITY, "claude", "/w", { expectedSequence: seq }), "invalid_registry", "action_not_available");
    expectError(() => clearDest(root, GRAVITY, { expectedSequence: seq }), "invalid_registry", "action_not_available");
    expectError(() => setDest(root, GRAVITY, "claude", "/w", { expectedSequence: seq + 5 }), "invalid_registry", "action_not_available");
    assert.deepEqual(snapshotFiles(root), filesBefore);
  });

  const { base, root } = makeRoot();
  try {
    expectError(() => setDest(root, GRAVITY, "claude", "/w", { expectedSequence: 0 }), "invalid_registry", "registry_absent");
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("fault injection and destination cap", () => {
  withV2Root((root) => {
    const before = readIdentityRegistry({ root }).registry.sequence;
    assert.throws(
      () => setIdentityDestination({
        root,
        expectedSequence: before,
        now: T3,
        principalId: GRAVITY,
        harness: "claude",
        workspace: "/w",
        faultHook: (stage) => { if (stage === "before_audit_append") throw new Error("boom"); },
      }),
      /boom/,
    );
    assert.equal(readIdentityRegistry({ root }).registry.sequence, before);
    assert.deepEqual(readIdentityRegistry({ root }).registry.destinations, {});
  });

  const names = Array.from({ length: MAX_REGISTRY_DESTINATIONS + 1 }, (_, i) => `prof-${i}`);
  withV2Root((root) => {
    for (let i = 0; i < MAX_REGISTRY_DESTINATIONS; i += 1) {
      setDest(root, agentBindingV1(`prof-${i}`).principal_id, "codex", `/w/${i}`);
    }
    expectError(
      () => setDest(root, agentBindingV1(`prof-${MAX_REGISTRY_DESTINATIONS}`).principal_id, "codex", "/w/extra"),
      "invalid_registry",
      "too_many_destinations",
    );
  }, names);
});
