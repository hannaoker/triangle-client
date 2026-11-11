// AD.0: the alias writer (docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md, sections 3.6 and 7).
// `alias_set` creates an alias and `alias_clear` removes one, both only on a stored v2 registry. A target changes only by
// clear then set. The audit entry never records a target, so `generation` is the sequence the entry commits at and never
// repeats, and `set_at` is the entry's own time.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ALIAS_PATTERN, deriveClientInstanceId, isReservedAliasName } from "../src/identity-primitives.mjs";
import {
  canonicalJson,
  clearIdentityAlias,
  MAX_REGISTRY_ALIASES,
  readIdentityRegistry,
  setIdentityAlias,
  updateIdentityRegistry,
} from "../src/identity-registry.mjs";
import {
  agentBindingV1,
  agentBindingV2,
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T3 = "2026-11-07T10:15:00.000Z";
const T4 = "2026-11-07T10:20:00.000Z";
const GRAVITY = agentBindingV1("gravity2").principal_id;
const GHOST = agentBindingV1("ghost").principal_id;
const GHOST_ID = deriveClientInstanceId("ghost");
const GRAVITY_ID = deriveClientInstanceId("gravity2");

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

function setOn(root, alias, principalId, { now = T3, expectedSequence } = {}) {
  return setIdentityAlias({ root, expectedSequence: expectedSequence ?? seqOf(root), now, alias, principalId });
}

function clearOn(root, alias, { now = T3, expectedSequence } = {}) {
  return clearIdentityAlias({ root, expectedSequence: expectedSequence ?? seqOf(root), now, alias });
}

// The generic writer, for mutations the wrappers would never make.
function rawWrite(root, action, subject, mutate, { now = T3, expectedSequence } = {}) {
  return updateIdentityRegistry({ root, expectedSequence: expectedSequence ?? seqOf(root), now, action, subject, mutate });
}

// ---- names ---------------------------------------------------------------------------------------------------------------
test("the alias pattern accepts short lowercase names and nothing else", () => {
  for (const ok of ["a", "0", "builder", "gravity2", "a.b_c-d", "x".repeat(32)]) assert.equal(ALIAS_PATTERN.test(ok), true, ok);
  for (const bad of ["", "A", "Builder", ".a", "-a", "_a", "x".repeat(33), "a b", "a/b", "é", "a\n", " a", "a ", "__proto__", "a\u0000"]) {
    assert.equal(ALIAS_PATTERN.test(bad), false, JSON.stringify(bad));
  }
});

test("reserved words and look-alikes of id forms are not allowed as new alias names", () => {
  for (const name of ["claude", "agent_", "agent_x", `agent_${hex32("p")}`, "peer_x", "session-x", "bind_x", "pair_x"]) {
    assert.equal(isReservedAliasName(name), true, name);
  }
  for (const name of ["claude2", "claudette", "my-claude", "claude-2", "agent", "agents", "peer", "session", "bound", "pairing", "builder", "gravity2"]) {
    assert.equal(isReservedAliasName(name), false, name);
  }
});

test("no id the registry or the primitives mint is shaped like an alias", () => {
  const ids = [
    deriveClientInstanceId("gravity2"),
    deriveClientInstanceId("a"),
    `session-${hex64("s")}`,
    `agent_${hex32("a")}`,
    `peer_${hex32("p")}`,
    `bind_${hex32("b")}`,
    `pair_${hex32("c")}`,
    hex64("z"),
  ];
  for (const id of ids) assert.equal(ALIAS_PATTERN.test(id), false, id);
});

test("a bad name is refused before the registry is read or created", () => {
  const { base, root } = makeRoot();
  try {
    for (const name of ["", "Builder", "a b", hex64("x"), "x".repeat(33)]) {
      expectError(() => setIdentityAlias({ root, expectedSequence: 0, now: T3, alias: name, principalId: GRAVITY }), "invalid_registry", "invalid_audit_subject");
      expectError(() => clearIdentityAlias({ root, expectedSequence: 0, now: T3, alias: name }), "invalid_registry", "invalid_audit_subject");
    }
    for (const name of ["claude", "agent_x", "peer_x", "session-x", "bind_x", "pair_x"]) {
      expectError(() => setIdentityAlias({ root, expectedSequence: 0, now: T3, alias: name, principalId: GRAVITY }), "invalid_registry", "alias_name_reserved");
    }
    assert.equal(existsSync(root), false, "nothing was created");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the subject of each action has its own shape", () => {
  withV2Root((root) => {
    const seq = seqOf(root);
    const filesBefore = snapshotFiles(root);
    // alias actions need a subject, and it must be an alias, not an instance id
    expectError(() => rawWrite(root, "alias_set", null, (r) => r), "invalid_registry", "subject_required_for_action");
    expectError(() => rawWrite(root, "alias_clear", null, (r) => r), "invalid_registry", "subject_required_for_action");
    expectError(() => rawWrite(root, "alias_set", GRAVITY_ID, (r) => r), "invalid_registry", "invalid_audit_subject");
    // bind and revoke still take an instance id only
    expectError(() => rawWrite(root, "bind", "builder", (r) => r), "invalid_registry", "invalid_audit_subject");
    expectError(() => rawWrite(root, "revoke", "builder", (r) => r), "invalid_registry", "invalid_audit_subject");
    assert.equal(seqOf(root), seq);
    assert.deepEqual(snapshotFiles(root), filesBefore);
  });
});

// ---- set and clear -------------------------------------------------------------------------------------------------------------
test("alias_set creates an alias in one audited step", () => {
  withV2Root((root) => {
    const before = readIdentityRegistry({ root });
    const seq = before.registry.sequence;
    const out = setOn(root, "builder", GRAVITY, { now: T3 });
    assert.deepEqual(out.registry.aliases.builder, { principal_id: GRAVITY, set_at: T3, generation: seq + 1 });
    assert.equal(out.registry.sequence, seq + 1);
    assert.equal(out.registry.updatedAt, T3);
    assert.deepEqual(
      { ...out.auditEntry },
      { sequence: seq + 1, at: T3, action: "alias_set", subject: "builder", bindingId: null, prevHash: before.registry.auditHead.hash, hash: out.auditEntry.hash },
    );
    assert.deepEqual(auditLines(root).at(-1), out.auditEntry);
    const after = readIdentityRegistry({ root });
    assert.equal(after.audit.uncommittedTail, 0);
    assert.equal(canonicalJson(after.registry), canonicalJson(out.registry));
    for (const name of ["bindings", "pairings", "destinations"]) {
      assert.equal(canonicalJson(after.registry[name]), canonicalJson(before.registry[name]), name);
    }
    assert.equal(after.registry.createdAt, before.registry.createdAt);
    assert.deepEqual(readRaw(root).auditHead, { sequence: seq + 1, hash: out.auditEntry.hash });
  });
});

test("alias_clear removes an alias in one audited step, and a later set gets a generation that was never used", () => {
  withV2Root((root) => {
    const seq = seqOf(root);
    const first = setOn(root, "builder", GRAVITY, { now: T2 });
    const cleared = clearOn(root, "builder", { now: T3 });
    assert.equal(Object.hasOwn(cleared.registry.aliases, "builder"), false);
    assert.deepEqual(
      { sequence: cleared.auditEntry.sequence, action: cleared.auditEntry.action, subject: cleared.auditEntry.subject, bindingId: cleared.auditEntry.bindingId },
      { sequence: seq + 2, action: "alias_clear", subject: "builder", bindingId: null },
    );
    const second = setOn(root, "builder", GHOST, { now: T4 });
    assert.deepEqual([first.registry.aliases.builder.generation, second.registry.aliases.builder.generation], [seq + 1, seq + 3]);
    assert.equal(second.registry.aliases.builder.principal_id, GHOST);
    assert.deepEqual(auditLines(root).slice(-3).map((e) => [e.action, e.subject]), [["alias_set", "builder"], ["alias_clear", "builder"], ["alias_set", "builder"]]);
    assert.equal(readIdentityRegistry({ root }).audit.uncommittedTail, 0);
  });
});

test("alias_set only creates: an existing name is refused, with the same target or another", () => {
  withV2Root((root) => {
    setOn(root, "builder", GRAVITY);
    const filesBefore = snapshotFiles(root);
    const seq = seqOf(root);
    expectError(() => setOn(root, "builder", GRAVITY, { now: T4 }), "alias_conflict", "alias_exists");
    expectError(() => setOn(root, "builder", GHOST, { now: T4 }), "alias_conflict", "alias_exists");
    // the generic writer cannot overwrite it either
    expectError(
      () => rawWrite(root, "alias_set", "builder", (r) => { r.aliases.builder = { principal_id: GHOST, set_at: T4, generation: seq + 1 }; return r; }, { now: T4 }),
      "alias_conflict",
      "alias_exists",
    );
    assert.deepEqual(snapshotFiles(root), filesBefore);
  });
});

test("the target must be the principal of an active mesh-managed binding", () => {
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
    rawWrite(root, "revoke", GHOST_ID, (r) => { r.bindings[GHOST_ID].revoked_at = T2; return r; }, { now: T2 });
    const filesBefore = snapshotFiles(root);
    // the registry itself refuses a target it does not know, or one that is not a principal at all
    expectError(() => setOn(root, "nobody", `agent_${hex32("nobody")}`), "invalid_registry", "alias_target_unknown");
    expectError(() => setOn(root, "nobody", "not-a-principal"), "invalid_registry", "invalid_alias_principal");
    // known to the registry, but not something this writer points a name at
    expectError(() => setOn(root, "revoked", GHOST), "invalid_registry", "alias_target_not_active");
    expectError(() => setOn(root, "serverless", peer.principal_id), "invalid_registry", "alias_target_not_active");
    expectError(() => setOn(root, "remote", pair.remote_principal_id), "invalid_registry", "alias_target_not_active");
    assert.deepEqual(snapshotFiles(root), filesBefore);
    assert.equal(setOn(root, "builder", GRAVITY).registry.aliases.builder.principal_id, GRAVITY);
  });
});

test("alias_clear needs an existing alias, and may remove one that alias_set would refuse", () => {
  withV2Root((root) => {
    expectError(() => clearOn(root, "builder"), "invalid_registry", "alias_not_found");
    // an alias with a reserved name can exist (the reader accepts it), so the writer must be able to remove it
    const seq = seqOf(root);
    appendAndCommit(root, {
      action: "alias_set",
      subject: "claude",
      at: T2,
      change: (r) => ({ ...r, aliases: { claude: { principal_id: GRAVITY, set_at: T2, generation: r.sequence } } }),
    });
    expectError(() => setOn(root, "claude", GHOST), "invalid_registry", "alias_name_reserved");
    const out = clearOn(root, "claude");
    assert.deepEqual(out.registry.aliases, {});
    assert.equal(out.registry.sequence, seq + 2);
  });
});

test("a mutation that is not exactly the action is refused and writes nothing", () => {
  withV2Root((root) => {
    setOn(root, "builder", GRAVITY, { now: T2 });
    setOn(root, "other", GHOST, { now: T2 });
    const filesBefore = snapshotFiles(root);
    const seq = seqOf(root);
    const record = (over = {}) => ({ principal_id: GRAVITY, set_at: T3, generation: seq + 1, ...over });
    const mismatch = ["invalid_registry", "mutation_does_not_match_action"];

    const setCases = {
      "a set_at that is not the entry's time": (r) => { r.aliases.fresh = record({ set_at: T2 }); return r; },
      "a generation below the committing sequence": (r) => { r.aliases.fresh = record({ generation: seq }); return r; },
      "a generation above the committing sequence": (r) => { r.aliases.fresh = record({ generation: seq + 2 }); return r; },
      "two aliases at once": (r) => { r.aliases.fresh = record(); r.aliases.fresh2 = record(); return r; },
      "another name than the subject": (r) => { r.aliases.elsewhere = record(); return r; },
      "no alias at all": (r) => r,
      "a binding changed as well": (r) => { r.aliases.fresh = record(); r.bindings[GRAVITY_ID].issued_at = T3; return r; },
      "a destination added as well": (r) => { r.aliases.fresh = record(); r.destinations[GRAVITY] = { harness: "claude", workspace: "/w", set_at: T3, generation: seq + 1 }; return r; },
      "an existing alias changed as well": (r) => { r.aliases.fresh = record(); r.aliases.other.generation = 99; return r; },
      "an existing alias removed as well": (r) => { r.aliases.fresh = record(); delete r.aliases.other; return r; },
    };
    for (const [label, mutate] of Object.entries(setCases)) {
      expectError(() => rawWrite(root, "alias_set", "fresh", mutate), ...mismatch);
      assert.deepEqual(snapshotFiles(root), filesBefore, label);
    }

    const clearCases = {
      "nothing removed": (r) => r,
      "two removed": (r) => { delete r.aliases.builder; delete r.aliases.other; return r; },
      "the wrong one removed": (r) => { delete r.aliases.other; return r; },
      "removed and another added": (r) => { delete r.aliases.builder; r.aliases.fresh = record(); return r; },
      "removed and a binding changed": (r) => { delete r.aliases.builder; r.bindings[GRAVITY_ID].issued_at = T3; return r; },
      "changed instead of removed": (r) => { r.aliases.builder = record(); return r; },
    };
    for (const [label, mutate] of Object.entries(clearCases)) {
      expectError(() => rawWrite(root, "alias_clear", "builder", mutate), ...mismatch);
      assert.deepEqual(snapshotFiles(root), filesBefore, label);
    }

    // shapes the registry validator itself refuses
    const invalid = {
      "an extra key": [(r) => { r.aliases.fresh = { ...record(), note: "x" }; return r; }, "unknown_alias_key"],
      "a generation of zero": [(r) => { r.aliases.fresh = record({ generation: 0 }); return r; }, "invalid_alias_generation"],
      "a set_at that is not a time": [(r) => { r.aliases.fresh = record({ set_at: "yesterday" }); return r; }, "invalid_alias_set_at"],
    };
    for (const [label, [mutate, reason]] of Object.entries(invalid)) {
      expectError(() => rawWrite(root, "alias_set", "fresh", mutate), "invalid_registry", reason);
      assert.deepEqual(snapshotFiles(root), filesBefore, label);
    }
  });
});

// ---- what stays refused ----------------------------------------------------------------------------------------------------
test("alias actions need a stored v2 registry: v1 and absent are refused and nothing is written", () => {
  withV1Root((root) => {
    const filesBefore = snapshotFiles(root);
    const seq = seqOf(root);
    expectError(() => setIdentityAlias({ root, expectedSequence: seq, now: T3, alias: "builder", principalId: GRAVITY }), "invalid_registry", "action_not_available");
    expectError(() => clearIdentityAlias({ root, expectedSequence: seq, now: T3, alias: "builder" }), "invalid_registry", "action_not_available");
    // the schema is looked at before the sequence
    expectError(() => setIdentityAlias({ root, expectedSequence: seq + 5, now: T3, alias: "builder", principalId: GRAVITY }), "invalid_registry", "action_not_available");
    assert.deepEqual(snapshotFiles(root), filesBefore);
  });
  const { base, root } = makeRoot();
  try {
    expectError(() => setIdentityAlias({ root, expectedSequence: 0, now: T3, alias: "builder", principalId: GRAVITY }), "invalid_registry", "registry_absent");
    expectError(() => clearIdentityAlias({ root, expectedSequence: 0, now: T3, alias: "builder" }), "invalid_registry", "registry_absent");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a stale expected sequence is a conflict on v2", () => {
  withV2Root((root) => {
    const seq = seqOf(root);
    expectError(() => setIdentityAlias({ root, expectedSequence: seq - 1, now: T3, alias: "builder", principalId: GRAVITY }), "registry_sequence_conflict", "sequence_mismatch");
    expectError(() => clearIdentityAlias({ root, expectedSequence: seq + 1, now: T3, alias: "builder" }), "registry_sequence_conflict", "sequence_mismatch");
  });
});

test("revoking a binding leaves its aliases in place: they dangle until cleared and cannot be created again", () => {
  withV2Root((root) => {
    setOn(root, "ghosty", GHOST, { now: T2 });
    rawWrite(root, "revoke", GHOST_ID, (r) => { r.bindings[GHOST_ID].revoked_at = T3; return r; }, { now: T3 });
    const mid = readIdentityRegistry({ root });
    assert.equal(mid.audit.uncommittedTail, 0);
    assert.equal(mid.registry.aliases.ghosty.principal_id, GHOST, "the alias survived the revoke");
    expectError(() => setOn(root, "ghost2", GHOST), "invalid_registry", "alias_target_not_active");
    clearOn(root, "ghosty");
    assert.deepEqual(readIdentityRegistry({ root }).registry.aliases, {});
  });
});

test("names that are properties of Object.prototype are ordinary names", () => {
  withV2Root((root) => {
    expectError(() => clearOn(root, "constructor"), "invalid_registry", "alias_not_found");
    const out = setOn(root, "constructor", GRAVITY);
    assert.equal(Object.hasOwn(out.registry.aliases, "constructor"), true);
    expectError(() => setOn(root, "constructor", GRAVITY), "alias_conflict", "alias_exists");
    assert.equal(readIdentityRegistry({ root }).registry.aliases.constructor.principal_id, GRAVITY);
    clearOn(root, "constructor");
    assert.equal(Object.hasOwn(readIdentityRegistry({ root }).registry.aliases, "constructor"), false);
  });
});

test("the alias cap holds at the writer: the 257th is refused, and a freed slot can be used", () => {
  withV2Root((root) => {
    appendAndCommit(root, {
      action: "alias_set",
      subject: "n0",
      at: T2,
      change: (r) => ({
        ...r,
        aliases: Object.fromEntries(Array.from({ length: MAX_REGISTRY_ALIASES }, (_, i) => [`n${i}`, { principal_id: GRAVITY, set_at: T2, generation: r.sequence }])),
      }),
    });
    const filesBefore = snapshotFiles(root);
    expectError(() => setOn(root, "extra", GRAVITY), "invalid_registry", "too_many_aliases");
    assert.deepEqual(snapshotFiles(root), filesBefore);
    clearOn(root, "n7");
    setOn(root, "extra", GRAVITY);
    assert.equal(Object.keys(readIdentityRegistry({ root }).registry.aliases).length, MAX_REGISTRY_ALIASES);
  });
});

test("set and clear sit in the same audit chain as bind, revoke and upgrade", () => {
  withV2Root((root) => {
    const extra = agentBindingV2("codex-headless");
    rawWrite(root, "bind", extra.profile_instance_id, (r) => { r.bindings[extra.profile_instance_id] = extra; return r; }, { now: T2 });
    setOn(root, "builder", extra.principal_id, { now: T3 });
    rawWrite(root, "revoke", GHOST_ID, (r) => { r.bindings[GHOST_ID].revoked_at = T3; return r; }, { now: T3 });
    clearOn(root, "builder", { now: T4 });
    const lines = auditLines(root);
    assert.deepEqual(lines.map((e) => e.action), ["init", "bind", "bind", "upgrade", "bind", "alias_set", "revoke", "alias_clear"]);
    lines.forEach((entry, i) => {
      assert.equal(entry.sequence, i + 1);
      if (i > 0) assert.equal(entry.prevHash, lines[i - 1].hash);
    });
    const final = readIdentityRegistry({ root });
    assert.equal(final.registry.sequence, lines.length);
    assert.equal(final.audit.uncommittedTail, 0);
    assert.deepEqual(readRaw(root).auditHead, { sequence: lines.length, hash: lines.at(-1).hash });
  });
});

// ---- crashes ------------------------------------------------------------------------------------------------------------
test("a crash at any stage of an alias write leaves the registry as it was or committed, and a retry finishes it", () => {
  const stages = [
    { stage: "before_audit_append", tail: 0, committed: false },
    { stage: "after_audit_append", tail: 1, committed: false },
    { stage: "before_registry_rename", tail: 1, committed: false },
    { stage: "after_registry_rename", tail: 0, committed: true },
    { stage: "after_commit", tail: 0, committed: true },
  ];
  for (const action of ["alias_set", "alias_clear"]) {
    for (const { stage, tail, committed } of stages) {
      withV2Root((root) => {
        if (action === "alias_clear") setOn(root, "builder", GRAVITY, { now: T2 });
        const seq = seqOf(root);
        const label = `${action} @ ${stage}`;
        const run = (faultHook = null) => (action === "alias_set"
          ? setIdentityAlias({ root, expectedSequence: seq, now: T3, alias: "builder", principalId: GRAVITY, faultHook })
          : clearIdentityAlias({ root, expectedSequence: seq, now: T3, alias: "builder", faultHook }));
        expectError(() => run((s) => { if (s === stage) throw new Error(`boom_${stage}`); }), undefined);
        const mid = readIdentityRegistry({ root });
        assert.equal(mid.audit.uncommittedTail, tail, label);
        assert.equal(mid.registry.sequence, committed ? seq + 1 : seq, label);
        if (committed) {
          // a retry of a write that did commit is refused cleanly, not applied twice
          expectError(() => run(), "registry_sequence_conflict", "sequence_mismatch");
        } else {
          run();
        }
        const final = readIdentityRegistry({ root });
        assert.equal(final.registry.sequence, seq + 1, label);
        assert.equal(final.audit.uncommittedTail, 0, label);
        assert.equal(Object.hasOwn(final.registry.aliases, "builder"), action === "alias_set", label);
        assert.equal(auditLines(root).length, seq + 1, `${label}: no stale line`);
        assert.equal(auditLines(root).at(-1).action, action, label);
      });
    }
  }
});

test("a crashed alias write is discarded by the next write of any kind", () => {
  withV2Root((root) => {
    const seq = seqOf(root);
    expectError(
      () => setIdentityAlias({ root, expectedSequence: seq, now: T3, alias: "builder", principalId: GRAVITY, faultHook: (s) => { if (s === "after_audit_append") throw new Error("boom"); } }),
      undefined,
    );
    assert.equal(readIdentityRegistry({ root }).audit.uncommittedTail, 1);
    const extra = agentBindingV2("codex-headless");
    rawWrite(root, "bind", extra.profile_instance_id, (r) => { r.bindings[extra.profile_instance_id] = extra; return r; }, { now: T4, expectedSequence: seq });
    assert.equal(auditLines(root).some((e) => e.action === "alias_set"), false, "the stale line is gone");
    assert.equal(readIdentityRegistry({ root }).audit.uncommittedTail, 0);
    setOn(root, "builder", GRAVITY, { now: T4 });
    assert.equal(auditLines(root).filter((e) => e.action === "alias_set").length, 1);
  });
});

// ---- processes racing -----------------------------------------------------------------------------------------------------------
test("alias writers, a binder and a reader racing end with one consistent registry", async () => {
  const registryUrl = pathToFileURL(path.join(HERE, "../src/identity-registry.mjs")).href;
  const primitivesUrl = pathToFileURL(path.join(HERE, "../src/identity-primitives.mjs")).href;
  const script = `
    import { readIdentityRegistry, setIdentityAlias, updateIdentityRegistry } from ${JSON.stringify(registryUrl)};
    import { deriveClientInstanceId } from ${JSON.stringify(primitivesUrl)};
    import { createHash } from "node:crypto";
    const cfg = JSON.parse(process.env.AD0_CFG);
    const hex32 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 32);
    function binding(name) {
      return {
        schema: "local_profile_binding_v2", binding_id: "bind_" + hex32("bind:" + name), trust_mode: "mesh-managed",
        principal_id: "agent_" + hex32("agent:" + name), profile_name: name, profile_instance_id: deriveClientInstanceId(name),
        authority_origin: "https://mesh.example.test", binding_generation: 1, issued_at: cfg.now, revoked_at: null,
        proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false }, principal_public_key: null,
      };
    }
    const out = { role: cfg.role, done: 0, retries: 0, reads: 0, errors: 0, regressions: 0 };
    const deadline = Date.now() + 90000;
    if (cfg.role === "reader") {
      let last = -1;
      while (Date.now() < deadline) {
        try {
          const reg = readIdentityRegistry({ root: cfg.root }).registry;
          out.reads += 1;
          if (reg.sequence < last) out.regressions += 1;
          last = reg.sequence;
          if (reg.sequence >= cfg.finalSequence) break;
        } catch (err) {
          out.errors += 1;
          out.lastError = err.code + ":" + err.reason;
        }
      }
      console.log(JSON.stringify(out));
      process.exit(0);
    }
    while (Date.now() < deadline && out.done < cfg.count) {
      try {
        const reg = readIdentityRegistry({ root: cfg.root }).registry;
        if (cfg.role === "aliaser") {
          setIdentityAlias({ root: cfg.root, expectedSequence: reg.sequence, now: cfg.now, alias: cfg.prefix + out.done, principalId: cfg.principal });
        } else {
          const b = binding(cfg.prefix + out.done);
          updateIdentityRegistry({ root: cfg.root, expectedSequence: reg.sequence, now: cfg.now, action: "bind", subject: b.profile_instance_id,
            mutate: (r) => { r.bindings[b.profile_instance_id] = b; return r; } });
        }
        out.done += 1;
      } catch (err) {
        if (err.code === "registry_sequence_conflict" || err.code === "registry_busy") { out.retries += 1; continue; }
        console.log(JSON.stringify({ failed: true, code: err.code, reason: err.reason, message: err.message }));
        process.exit(2);
      }
    }
    console.log(JSON.stringify(out));
  `;
  const run = (cfg) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, AD0_CFG: JSON.stringify(cfg) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });

  const { base, root } = makeV1Root(["gravity2", "ghost"]);
  try {
    upgradeThroughWriter(root);
    const baseSeq = seqOf(root);
    const perAliaser = 8;
    const binds = 8;
    const finalSequence = baseSeq + 3 * perAliaser + binds;
    const results = await Promise.all([
      run({ root, now: T3, role: "aliaser", prefix: "a", count: perAliaser, principal: GRAVITY }),
      run({ root, now: T3, role: "aliaser", prefix: "b", count: perAliaser, principal: GRAVITY }),
      run({ root, now: T3, role: "aliaser", prefix: "c", count: perAliaser, principal: GHOST }),
      run({ root, now: T3, role: "binder", prefix: "p", count: binds }),
      run({ root, role: "reader", finalSequence }),
    ]);
    for (const r of results) assert.equal(r.code, 0, `${r.out} ${r.err}`);
    const reports = results.map((r) => JSON.parse(r.out));
    const reader = reports.find((r) => r.role === "reader");
    assert.deepEqual([reader.errors, reader.regressions], [0, 0], `the reader never saw a broken or regressing registry: ${reader.lastError ?? ""}`);

    const final = readIdentityRegistry({ root });
    assert.equal(final.registry.sequence, finalSequence);
    assert.equal(final.audit.uncommittedTail, 0);
    const names = Object.keys(final.registry.aliases).sort();
    assert.deepEqual(names, ["a", "b", "c"].flatMap((p) => Array.from({ length: perAliaser }, (_, i) => `${p}${i}`)).sort());
    const lines = auditLines(root);
    assert.equal(lines.length, finalSequence);
    // every alias was committed by exactly one audit line, and its generation is the sequence of that line
    for (const name of names) {
      const entries = lines.filter((e) => e.action === "alias_set" && e.subject === name);
      assert.equal(entries.length, 1, name);
      assert.equal(final.registry.aliases[name].generation, entries[0].sequence, name);
      assert.equal(final.registry.aliases[name].set_at, entries[0].at, name);
    }
    assert.equal(new Set(Object.values(final.registry.aliases).map((a) => a.generation)).size, names.length, "generations never repeat");
    assert.deepEqual(readRaw(root).auditHead, { sequence: finalSequence, hash: lines.at(-1).hash });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
