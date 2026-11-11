// D1.1: the writer understands v2. `upgrade` is the only action that changes the schema; bind and revoke work on a v2
// registry for agent bindings; the names reserved for later slices and every serverless write are refused.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AUDIT_FILE_NAME,
  canonicalJson,
  emptyIdentityRegistry,
  IDENTITY_REGISTRY_SCHEMA,
  IDENTITY_REGISTRY_SCHEMA_V2,
  readIdentityRegistry,
  REGISTRY_FILE_NAME,
  updateIdentityRegistry,
  upgradeRegistryV1ToV2,
} from "../src/identity-registry.mjs";
import {
  agentBindingV1,
  agentBindingV2,
  appendAndCommit,
  auditLines,
  b64u,
  hex32,
  hex64,
  makeRoot,
  makeV1Root,
  peerBindingV2,
  readRaw,
  serverlessPairing as pairing,
  snapshotFiles,
  T0,
  T1,
  T2,
  upgradeThroughWriter,
} from "./identity-registry-v2-helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V1 = IDENTITY_REGISTRY_SCHEMA;
const V2 = IDENTITY_REGISTRY_SCHEMA_V2;
const clone = (value) => JSON.parse(JSON.stringify(value));

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

function bindOn(root, binding, { expectedSequence, now = T2 } = {}) {
  const sequence = expectedSequence ?? readIdentityRegistry({ root }).registry.sequence;
  return updateIdentityRegistry({
    root,
    expectedSequence: sequence,
    now,
    action: "bind",
    subject: binding.profile_instance_id,
    mutate: (r) => {
      r.bindings[binding.profile_instance_id] = binding;
      return r;
    },
  });
}

// A v2 root that also holds records the writer cannot create yet: a serverless binding, a pairing, an alias, a destination.
function withSeededV2Root(fn) {
  return withV2Root((root) => {
    const peer = peerBindingV2("peerprof");
    const pair = pairing(1, peer.principal_id);
    const agent = agentBindingV2("gravity2");
    appendAndCommit(root, {
      action: "bind",
      subject: peer.profile_instance_id,
      bindingId: peer.binding_id,
      change: (r) => ({
        ...r,
        bindings: { ...r.bindings, [peer.profile_instance_id]: peer },
        pairings: { [pair.pairing_id]: pair },
        aliases: { gravity: { principal_id: agent.principal_id, set_at: T0, generation: 1 } },
        destinations: { [agent.principal_id]: { harness: "claude", workspace: "/w", set_at: T0, generation: 1 } },
      }),
    });
    return fn(root, { peer, pair, agent });
  });
}

// ---- the upgrade --------------------------------------------------------------------------------------------------
test("the writer upgrades a v1 registry to v2 in one audited step", () => {
  withV1Root((root) => {
    const before = readIdentityRegistry({ root });
    const filesBefore = snapshotFiles(root);
    const out = upgradeThroughWriter(root);

    assert.equal(out.registry.schema, V2);
    assert.equal(out.registry.sequence, before.registry.sequence + 1);
    assert.equal(out.registry.createdAt, before.registry.createdAt);
    assert.equal(out.registry.updatedAt, T1);
    assert.deepEqual(
      { action: out.auditEntry.action, subject: out.auditEntry.subject, bindingId: out.auditEntry.bindingId, prevHash: out.auditEntry.prevHash },
      { action: "upgrade", subject: null, bindingId: null, prevHash: before.registry.auditHead.hash },
    );
    assert.equal(out.registry.auditHead.hash, out.auditEntry.hash);
    // lossless: the stored bindings are exactly the pure conversion of the old ones
    assert.equal(canonicalJson(out.registry.bindings), canonicalJson(upgradeRegistryV1ToV2(before.registry).bindings));
    assert.deepEqual([out.registry.pairings, out.registry.aliases, out.registry.destinations], [{}, {}, {}]);

    const after = readIdentityRegistry({ root });
    assert.deepEqual(after.registry, out.registry);
    assert.deepEqual(after.audit, { verifiedThrough: before.registry.sequence + 1, uncommittedTail: 0 });
    // append-only: the old audit lines are an untouched prefix
    assert.ok(readFileSync(path.join(root, AUDIT_FILE_NAME)).subarray(0, filesBefore.audit.length).equals(filesBefore.audit));
    assert.equal(auditLines(root).filter((e) => e.action === "upgrade").length, 1);
    assert.equal(lstatSync(path.join(root, REGISTRY_FILE_NAME)).mode & 0o777, 0o600);
    assert.equal(lstatSync(path.join(root, AUDIT_FILE_NAME)).mode & 0o777, 0o600);
  });
});

test("an upgrade mutation that is not exactly the conversion is refused and writes nothing", () => {
  withV1Root((root) => {
    const seq = readIdentityRegistry({ root }).registry.sequence;
    const filesBefore = snapshotFiles(root);
    const attempt = (mutate) => () => updateIdentityRegistry({ root, expectedSequence: seq, now: T1, action: "upgrade", subject: null, mutate });
    const converted = (r) => clone(upgradeRegistryV1ToV2(r));

    expectError(attempt((r) => r), "invalid_registry", "mutate_modified_schema");
    expectError(attempt((r) => { const v = converted(r); Object.values(v.bindings)[0].binding_generation = 2; return v; }), "invalid_registry", "mutation_does_not_match_action");
    expectError(attempt((r) => { const v = converted(r); const extra = agentBindingV2("extra"); v.bindings[extra.profile_instance_id] = extra; return v; }), "invalid_registry", "mutation_does_not_match_action");
    expectError(attempt((r) => { const v = converted(r); delete v.bindings[firstKey(v.bindings)]; return v; }), "invalid_registry", "mutation_does_not_match_action");
    expectError(attempt((r) => { const v = converted(r); v.aliases.gravity = { principal_id: Object.values(v.bindings)[0].principal_id, set_at: T0, generation: 1 }; return v; }), "invalid_registry", "mutation_does_not_match_action");
    expectError(attempt((r) => { const v = converted(r); v.destinations[Object.values(v.bindings)[0].principal_id] = { harness: "claude", workspace: "/w", set_at: T0, generation: 1 }; return v; }), "invalid_registry", "mutation_does_not_match_action");
    expectError(attempt((r) => { const v = converted(r); v.createdAt = T1; return v; }), "invalid_registry", "mutate_modified_created_at");
    expectError(attempt((r) => { const v = converted(r); v.updatedAt = T2; return v; }), "invalid_registry", "mutate_modified_protected_fields");
    expectError(attempt((r) => { const v = converted(r); v.auditHead = { ...v.auditHead, hash: hex64("other") }; return v; }), "invalid_registry", "mutate_modified_protected_fields");
    expectError(attempt((r) => { const v = converted(r); v.sequence = 99; return v; }), "invalid_registry", "mutate_modified_protected_fields");
    assert.deepEqual(snapshotFiles(root), filesBefore);
    assert.equal(readIdentityRegistry({ root }).registry.schema, V1);
  });
});

function firstKey(obj) {
  return Object.keys(obj)[0];
}

test("upgrade preconditions: a registry, v1, the current sequence and no subject", () => {
  // no registry
  const { base, root } = makeRoot();
  try {
    expectError(
      () => updateIdentityRegistry({ root, expectedSequence: 0, now: T1, action: "upgrade", subject: null, mutate: (r) => r }),
      "invalid_registry",
      "upgrade_requires_registry",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  withV1Root((v1Root) => {
    const seq = readIdentityRegistry({ root: v1Root }).registry.sequence;
    const call = (overrides) => () => updateIdentityRegistry({ root: v1Root, expectedSequence: seq, now: T1, action: "upgrade", subject: null, mutate: (r) => upgradeRegistryV1ToV2(r), ...overrides });
    expectError(call({ expectedSequence: seq - 1 }), "registry_sequence_conflict");
    expectError(call({ subject: hex64("x") }), "invalid_registry", "upgrade_subject_must_be_null");
    call({})();
    expectError(call({}), "invalid_registry", "registry_already_v2");
    expectError(call({ expectedSequence: seq + 1 }), "invalid_registry", "registry_already_v2");
  });
});

test("upgrade needs history: on a sequence-0 registry it would commit a chain the reader refuses", () => {
  const { base, root } = makeRoot();
  try {
    mkdirSync(root, { mode: 0o700 });
    const file = path.join(root, REGISTRY_FILE_NAME);
    writeFileSync(file, `${canonicalJson(emptyIdentityRegistry({ now: T0 }))}\n`);
    chmodSync(file, 0o600);
    const read = readIdentityRegistry({ root });
    assert.deepEqual([read.state, read.registry.schema, read.registry.sequence], ["ok", V1, 0]);
    expectError(
      () => updateIdentityRegistry({ root, expectedSequence: 0, now: T1, action: "upgrade", subject: null, mutate: (r) => upgradeRegistryV1ToV2(r) }),
      "invalid_registry",
      "upgrade_requires_history",
    );
    assert.equal(existsSync(path.join(root, AUDIT_FILE_NAME)), false, "nothing was appended");
    assert.equal(readIdentityRegistry({ root }).registry.schema, V1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---- crashes ------------------------------------------------------------------------------------------------------------
test("a crash at any stage of the upgrade leaves a v1 or a v2 registry, never a half state", () => {
  const cases = [
    { stage: "before_audit_append", committed: false, tail: 0 },
    { stage: "after_audit_append", committed: false, tail: 1 },
    { stage: "before_registry_rename", committed: false, tail: 1 },
    { stage: "after_registry_rename", committed: true, tail: 0 },
    { stage: "after_commit", committed: true, tail: 0 },
  ];
  for (const { stage, committed, tail } of cases) {
    withV1Root((root) => {
      const before = readIdentityRegistry({ root }).registry;
      const registryBytes = readFileSync(path.join(root, REGISTRY_FILE_NAME));
      expectError(
        () => upgradeThroughWriter(root, { faultHook: (s) => { if (s === stage) throw new Error(`boom_${stage}`); } }),
        undefined,
      );
      const read = readIdentityRegistry({ root });
      if (committed) {
        assert.equal(read.registry.schema, V2, stage);
        assert.equal(read.registry.sequence, before.sequence + 1, stage);
        expectError(() => upgradeThroughWriter(root), "invalid_registry", "registry_already_v2");
      } else {
        assert.equal(read.registry.schema, V1, stage);
        assert.equal(read.registry.sequence, before.sequence, stage);
        assert.ok(readFileSync(path.join(root, REGISTRY_FILE_NAME)).equals(registryBytes), `${stage}: registry file untouched`);
        // a retry discards a stale tail and commits exactly one upgrade
        const retried = upgradeThroughWriter(root);
        assert.equal(retried.registry.sequence, before.sequence + 1, stage);
      }
      assert.equal(read.audit.uncommittedTail, tail, stage);
      const final = readIdentityRegistry({ root });
      assert.equal(final.registry.schema, V2, stage);
      assert.equal(final.audit.uncommittedTail, 0, stage);
      assert.equal(auditLines(root).filter((e) => e.action === "upgrade").length, 1, `${stage}: exactly one upgrade line`);
      assert.equal(auditLines(root).length, before.sequence + 1, `${stage}: no stale line left`);
    });
  }
});

test("after a crashed upgrade another v1 action discards the stale line, and the upgrade can still run later", () => {
  withV1Root((root) => {
    const seq = readIdentityRegistry({ root }).registry.sequence;
    expectError(() => upgradeThroughWriter(root, { faultHook: (s) => { if (s === "after_audit_append") throw new Error("boom"); } }), undefined);
    assert.equal(readIdentityRegistry({ root }).audit.uncommittedTail, 1);
    const third = agentBindingV1("third");
    updateIdentityRegistry({
      root,
      expectedSequence: seq,
      now: T2,
      action: "bind",
      subject: third.profile_instance_id,
      mutate: (r) => {
        r.bindings[third.profile_instance_id] = third;
        return r;
      },
    });
    assert.equal(auditLines(root).some((e) => e.action === "upgrade"), false, "the stale upgrade line is gone");
    upgradeThroughWriter(root, { now: T2 });
    const final = readIdentityRegistry({ root });
    assert.equal(final.registry.schema, V2);
    assert.equal(Object.keys(final.registry.bindings).length, 3);
    assert.equal(auditLines(root).filter((e) => e.action === "upgrade").length, 1);
  });
});

test("a crashed write on a v2 registry is discarded by the next write", () => {
  withV2Root((root) => {
    const seq = readIdentityRegistry({ root }).registry.sequence;
    const first = agentBindingV2("first");
    expectError(
      () => updateIdentityRegistry({
        root, expectedSequence: seq, now: T2, action: "bind", subject: first.profile_instance_id,
        mutate: (r) => { r.bindings[first.profile_instance_id] = first; return r; },
        faultHook: (s) => { if (s === "after_audit_append") throw new Error("boom"); },
      }),
      undefined,
    );
    const mid = readIdentityRegistry({ root });
    assert.equal(mid.registry.schema, V2);
    assert.equal(mid.audit.uncommittedTail, 1);
    bindOn(root, first, { expectedSequence: seq });
    const after = readIdentityRegistry({ root });
    assert.equal(after.audit.uncommittedTail, 0);
    assert.equal(after.registry.sequence, seq + 1);
    assert.equal(auditLines(root).length, seq + 1);
  });
});

test("a crash at any stage of a v2 bind leaves the registry as it was or committed, and a retry finishes it", () => {
  const cases = [
    { stage: "before_audit_append", tail: 0, committed: false },
    { stage: "after_audit_append", tail: 1, committed: false },
    { stage: "before_registry_rename", tail: 1, committed: false },
    { stage: "after_registry_rename", tail: 0, committed: true },
    { stage: "after_commit", tail: 0, committed: true },
  ];
  for (const { stage, tail, committed } of cases) {
    withV2Root((root) => {
      const seq = readIdentityRegistry({ root }).registry.sequence;
      const b = agentBindingV2("faulty");
      expectError(
        () => updateIdentityRegistry({
          root, expectedSequence: seq, now: T2, action: "bind", subject: b.profile_instance_id,
          mutate: (r) => { r.bindings[b.profile_instance_id] = b; return r; },
          faultHook: (s) => { if (s === stage) throw new Error(`boom_${stage}`); },
        }),
        undefined,
      );
      const mid = readIdentityRegistry({ root });
      assert.equal(mid.registry.schema, V2, stage);
      assert.equal(mid.audit.uncommittedTail, tail, stage);
      assert.equal(mid.registry.sequence, committed ? seq + 1 : seq, stage);
      if (!committed) bindOn(root, b, { expectedSequence: seq });
      const final = readIdentityRegistry({ root });
      assert.equal(final.registry.sequence, seq + 1, stage);
      assert.equal(final.audit.uncommittedTail, 0, stage);
      assert.ok(final.registry.bindings[b.profile_instance_id], stage);
      assert.equal(auditLines(root).length, seq + 1, `${stage}: no stale line`);
    });
  }
});

// ---- bind and revoke on v2 -----------------------------------------------------------------------------------------------
test("bind and revoke work on a v2 registry with the D2 and D3 guards", () => {
  withV2Root((root) => {
    const codex = agentBindingV2("codex-headless");
    const bound = bindOn(root, codex);
    assert.equal(bound.registry.schema, V2);
    assert.deepEqual([bound.auditEntry.action, bound.auditEntry.subject, bound.auditEntry.bindingId], ["bind", codex.profile_instance_id, codex.binding_id]);
    assert.deepEqual([bound.registry.pairings, bound.registry.aliases, bound.registry.destinations], [{}, {}, {}]);

    // a plain rebind renews the same identity and raises the generation
    const renewed = { ...codex, binding_id: `bind_${hex32("renewed")}`, binding_generation: 2 };
    assert.equal(bindOn(root, renewed).registry.bindings[codex.profile_instance_id].binding_generation, 2);
    // D2: moving the principal or the authority origin is not a bind
    expectError(() => bindOn(root, { ...renewed, binding_id: `bind_${hex32("moved")}`, binding_generation: 3, principal_id: `agent_${hex32("other")}` }), "binding_conflict", "identity_change_requires_move");
    expectError(() => bindOn(root, { ...renewed, binding_id: `bind_${hex32("moved2")}`, binding_generation: 3, authority_origin: "https://other.example.test" }), "binding_conflict", "identity_change_requires_move");
    // D3: one live binding per principal
    expectError(() => bindOn(root, agentBindingV2("twin", { principal_id: codex.principal_id })), "binding_conflict", "principal_already_bound");
    // a v1-shaped record does not belong in a v2 registry
    expectError(() => bindOn(root, agentBindingV1("legacy")), "invalid_registry", "missing_binding_key");

    // revoke
    const seq = readIdentityRegistry({ root }).registry.sequence;
    const revoked = updateIdentityRegistry({
      root, expectedSequence: seq, now: T2, action: "revoke", subject: codex.profile_instance_id,
      mutate: (r) => { r.bindings[codex.profile_instance_id].revoked_at = T2; return r; },
    });
    assert.equal(revoked.registry.bindings[codex.profile_instance_id].revoked_at, T2);
    assert.equal(revoked.auditEntry.action, "revoke");
    expectError(
      () => updateIdentityRegistry({ root, expectedSequence: seq + 1, now: T2, action: "revoke", subject: codex.profile_instance_id, mutate: (r) => r }),
      "invalid_registry",
      "mutation_does_not_match_action",
    );
    // init belongs to an absent registry only
    expectError(() => updateIdentityRegistry({ root, expectedSequence: seq + 1, now: T2, action: "init", subject: null, mutate: (r) => r }), "invalid_registry", "mutation_does_not_match_action");
    assert.equal(readIdentityRegistry({ root }).audit.uncommittedTail, 0);
  });
});

// ---- what stays refused ----------------------------------------------------------------------------------------------------
test("the names reserved for later slices are refused on v1 and on v2, unknown names stay invalid", () => {
  // alias_set and alias_clear left this list with AD.0; test/identity-registry-aliases.test.mjs covers them
  const reserved = ["destination_set", "destination_clear", "pair", "pair_update", "pair_revoke"];
  const run = (root) => {
    const seq = readIdentityRegistry({ root }).registry.sequence;
    const filesBefore = snapshotFiles(root);
    for (const action of reserved) {
      expectError(() => updateIdentityRegistry({ root, expectedSequence: seq, now: T2, action, subject: null, mutate: (r) => r }), "invalid_registry", "action_not_available");
    }
    expectError(() => updateIdentityRegistry({ root, expectedSequence: seq, now: T2, action: "rotate", subject: null, mutate: (r) => r }), "invalid_registry", "invalid_audit_action");
    assert.deepEqual(snapshotFiles(root), filesBefore);
  };
  withV1Root(run);
  withV2Root(run);
});

test("this writer neither creates nor changes a serverless record", () => {
  withV2Root((root) => {
    expectError(() => bindOn(root, peerBindingV2("peerprof")), "invalid_registry", "action_not_available");
  });
  withSeededV2Root((root, { peer }) => {
    const seq = readIdentityRegistry({ root }).registry.sequence;
    // rebinding or revoking the serverless binding
    expectError(() => bindOn(root, { ...peer, binding_id: `bind_${hex32("again")}`, binding_generation: 2 }), "invalid_registry", "action_not_available");
    expectError(
      () => updateIdentityRegistry({
        root, expectedSequence: seq, now: T2, action: "revoke", subject: peer.profile_instance_id,
        mutate: (r) => { r.bindings[peer.profile_instance_id].revoked_at = T2; return r; },
      }),
      "invalid_registry",
      "action_not_available",
    );
    // turning the serverless profile into an agent binding would unbind the pairing's local principal: the integrity rule refuses first
    expectError(() => bindOn(root, agentBindingV2("peerprof", { binding_id: `bind_${hex32("asagent")}`, binding_generation: 2 })), "invalid_registry", "pairing_local_principal_unbound");
    // an agent bind next to it is fine and leaves it exactly as it was
    const out = bindOn(root, agentBindingV2("codex-headless"));
    assert.equal(canonicalJson(out.registry.bindings[peer.profile_instance_id]), canonicalJson(peer));
  });
});

test("a serverless binding that no pairing needs still cannot be turned into an agent binding", () => {
  withV2Root((root) => {
    const peer = peerBindingV2("lonely");
    appendAndCommit(root, {
      action: "bind",
      subject: peer.profile_instance_id,
      bindingId: peer.binding_id,
      change: (r) => ({ ...r, bindings: { ...r.bindings, [peer.profile_instance_id]: peer } }),
    });
    const filesBefore = snapshotFiles(root);
    expectError(
      () => bindOn(root, agentBindingV2("lonely", { binding_id: `bind_${hex32("lonely-agent")}`, binding_generation: 2 })),
      "invalid_registry",
      "action_not_available",
    );
    assert.deepEqual(snapshotFiles(root), filesBefore);
  });
});

test("bind and revoke cannot change pairings, aliases or destinations", () => {
  withSeededV2Root((root, { pair, agent }) => {
    const extra = agentBindingV2("codex-headless");
    const filesBefore = snapshotFiles(root);
    const bindWith = (change) => () => updateIdentityRegistry({
      root, expectedSequence: readIdentityRegistry({ root }).registry.sequence, now: T2, action: "bind", subject: extra.profile_instance_id,
      mutate: (r) => { r.bindings[extra.profile_instance_id] = extra; change(r); return r; },
    });
    expectError(bindWith((r) => { delete r.pairings[pair.pairing_id]; }), "invalid_registry", "mutation_does_not_match_action");
    // the alias target is valid (this very mutation binds it), so it is the action check that refuses the new alias
    expectError(bindWith((r) => { r.aliases.codex = { principal_id: extra.principal_id, set_at: T0, generation: 1 }; }), "invalid_registry", "mutation_does_not_match_action");
    expectError(bindWith((r) => { delete r.aliases.gravity; }), "invalid_registry", "mutation_does_not_match_action");
    expectError(bindWith((r) => { r.destinations[agent.principal_id].workspace = "/elsewhere"; }), "invalid_registry", "mutation_does_not_match_action");
    expectError(bindWith((r) => { r.pairings[pair.pairing_id].petname = "renamed"; }), "invalid_registry", "mutation_does_not_match_action");
    // the same holds for revoke
    const gravity = agentBindingV2("gravity2");
    expectError(
      () => updateIdentityRegistry({
        root, expectedSequence: readIdentityRegistry({ root }).registry.sequence, now: T2, action: "revoke", subject: gravity.profile_instance_id,
        mutate: (r) => { r.bindings[gravity.profile_instance_id].revoked_at = T2; delete r.aliases.gravity; return r; },
      }),
      "invalid_registry",
      "mutation_does_not_match_action",
    );
    assert.deepEqual(snapshotFiles(root), filesBefore);
  });
});

// ---- processes racing across the upgrade ---------------------------------------------------------------------------------------
test("binders, two upgraders and a reader racing across the upgrade end with one consistent v2 registry", async () => {
  const registryUrl = pathToFileURL(path.join(HERE, "../src/identity-registry.mjs")).href;
  const primitivesUrl = pathToFileURL(path.join(HERE, "../src/identity-primitives.mjs")).href;
  const script = `
    import { readIdentityRegistry, updateIdentityRegistry, upgradeRegistryV1ToV2 } from ${JSON.stringify(registryUrl)};
    import { deriveClientInstanceId } from ${JSON.stringify(primitivesUrl)};
    import { createHash } from "node:crypto";
    const cfg = JSON.parse(process.env.D11_CFG);
    const hex32 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 32);
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    function binding(name, v2) {
      const b = {
        schema: v2 ? "local_profile_binding_v2" : "local_profile_binding_v1",
        binding_id: "bind_" + hex32("bind:" + name), trust_mode: "mesh-managed", principal_id: "agent_" + hex32("agent:" + name),
        profile_name: name, profile_instance_id: deriveClientInstanceId(name), authority_origin: "https://mesh.example.test",
        binding_generation: 1, issued_at: cfg.now, revoked_at: null,
        proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
      };
      if (v2) b.principal_public_key = null;
      return b;
    }
    const out = { role: cfg.role, done: 0, upgraded: 0, lost: 0, retries: 0, reads: 0, errors: 0, regressions: 0, sawV2: false };
    const deadline = Date.now() + 90000;
    if (cfg.role === "reader") {
      let lastSequence = -1, lastWasV2 = false;
      while (Date.now() < deadline) {
        try {
          const reg = readIdentityRegistry({ root: cfg.root }).registry;
          out.reads += 1;
          const isV2 = reg.schema === "identity_registry_v2";
          if (isV2) out.sawV2 = true;
          if (reg.sequence < lastSequence || (lastWasV2 && !isV2)) out.regressions += 1;
          lastSequence = reg.sequence;
          lastWasV2 = isV2;
          if (reg.sequence >= cfg.finalSequence) break;
        } catch (err) {
          out.errors += 1;
          out.lastError = err.code + ":" + err.reason;
        }
      }
      console.log(JSON.stringify(out));
      process.exit(0);
    }
    while (Date.now() < deadline) {
      const reg = readIdentityRegistry({ root: cfg.root }).registry;
      try {
        if (cfg.role === "upgrader") {
          if (reg.schema === "identity_registry_v2") { out.lost += 1; break; }
          if (reg.sequence < cfg.minSequence) { sleep(5); continue; }
          updateIdentityRegistry({ root: cfg.root, expectedSequence: reg.sequence, now: cfg.now, action: "upgrade", subject: null, mutate: (r) => upgradeRegistryV1ToV2(r) });
          out.upgraded += 1;
          break;
        }
        if (out.done >= cfg.count) break;
        // After gateAfter binds a binder waits for the upgrade, so binds on both sides of it are guaranteed whatever the
        // process start-up skew; the binds before the gate are what race the upgrader.
        if (out.done >= cfg.gateAfter && reg.schema !== "identity_registry_v2") { sleep(5); continue; }
        const b = binding(cfg.prefix + out.done, reg.schema === "identity_registry_v2");
        updateIdentityRegistry({ root: cfg.root, expectedSequence: reg.sequence, now: cfg.now, action: "bind", subject: b.profile_instance_id,
          mutate: (r) => { r.bindings[b.profile_instance_id] = b; return r; } });
        out.done += 1;
      } catch (err) {
        if (err.code === "registry_sequence_conflict" || err.code === "registry_busy") { out.retries += 1; continue; }
        if (cfg.role === "upgrader" && err.reason === "registry_already_v2") { out.lost += 1; break; }
        console.log(JSON.stringify({ failed: true, code: err.code, reason: err.reason, message: err.message }));
        process.exit(2);
      }
    }
    console.log(JSON.stringify(out));
  `;
  const run = (cfg) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, D11_CFG: JSON.stringify(cfg) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });

  const { base, root } = makeV1Root(["gravity2", "ghost"]);
  try {
    const baseSeq = readIdentityRegistry({ root }).registry.sequence;
    const perBinder = 10;
    const gateAfter = 7; // 3 binders x 7 binds are far more than the 6 the upgraders wait for, so the gate cannot deadlock
    const finalSequence = baseSeq + 3 * perBinder + 1;
    const results = await Promise.all([
      run({ root, now: T2, role: "binder", prefix: "a", count: perBinder, gateAfter }),
      run({ root, now: T2, role: "binder", prefix: "b", count: perBinder, gateAfter }),
      run({ root, now: T2, role: "binder", prefix: "c", count: perBinder, gateAfter }),
      run({ root, now: T2, role: "upgrader", minSequence: baseSeq + 6 }),
      run({ root, now: T2, role: "upgrader", minSequence: baseSeq + 6 }),
      run({ root, now: T2, role: "reader", finalSequence }),
    ]);
    for (const r of results) assert.equal(r.code, 0, `${r.out} ${r.err}`);
    const reports = results.map((r) => JSON.parse(r.out));
    const reader = reports.find((r) => r.role === "reader");
    assert.equal(reports.reduce((n, r) => n + r.upgraded, 0), 1, "exactly one process performed the upgrade");
    assert.equal(reports.filter((r) => r.role === "upgrader").reduce((n, r) => n + r.upgraded + r.lost, 0), 2, "the other upgrader lost cleanly");
    assert.deepEqual([reader.errors, reader.regressions], [0, 0], `the reader never saw a broken or regressing registry: ${reader.lastError ?? ""}`);
    assert.ok(reader.reads > 0);

    const final = readIdentityRegistry({ root });
    assert.equal(final.registry.schema, V2);
    assert.equal(final.registry.sequence, finalSequence);
    assert.equal(Object.keys(final.registry.bindings).length, 2 + 3 * perBinder);
    assert.equal(final.audit.uncommittedTail, 0);
    assert.ok(Object.values(final.registry.bindings).every((b) => b.schema === "local_profile_binding_v2"));
    const lines = auditLines(root);
    assert.equal(lines.length, final.registry.sequence);
    const upgradeAt = lines.findIndex((e) => e.action === "upgrade");
    assert.equal(lines.filter((e) => e.action === "upgrade").length, 1);
    // binds on both sides of the upgrade, by construction: the upgraders wait for 6 binds, the binders for the upgrade
    assert.ok(lines.slice(0, upgradeAt).filter((e) => e.action === "bind").length >= 2 + 6, "binds before the upgrade");
    assert.ok(lines.slice(upgradeAt + 1).filter((e) => e.action === "bind").length >= 3 * (perBinder - gateAfter), "binds after the upgrade");
    assert.deepEqual(readRaw(root).auditHead, { sequence: final.registry.sequence, hash: lines[lines.length - 1].hash });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
