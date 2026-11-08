// D1.0: identity_registry_v2 schema, validators, pure upgrade, audit rules and reader behavior.
// The writer still writes v1 only; these tests pin that, and pin what today's reader does with a v2 file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import {
  AUDIT_FILE_NAME,
  canonicalJson,
  emptyIdentityRegistry,
  IDENTITY_REGISTRY_SCHEMA,
  IDENTITY_REGISTRY_SCHEMA_V2,
  LOCAL_PROFILE_BINDING_SCHEMA,
  LOCAL_PROFILE_BINDING_SCHEMA_V2,
  MAX_REGISTRY_ALIASES,
  MAX_REGISTRY_BINDINGS,
  MAX_REGISTRY_BYTES,
  MAX_REGISTRY_DESTINATIONS,
  MAX_REGISTRY_PAIRINGS,
  readIdentityRegistry,
  REGISTRY_FILE_NAME,
  SERVERLESS_PAIRING_SCHEMA,
  SUPPORTED_REGISTRY_SCHEMAS,
  updateIdentityRegistry,
  upgradeRegistryV1ToV2,
  validateIdentityRegistry,
  ZERO_HASH_64,
} from "../src/identity-registry.mjs";
import { resolveRecipient } from "../src/recipient-resolver.mjs";
import { createRegistrySnapshotProvider } from "../src/router-registry-snapshot.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TMP_BASE = process.platform === "darwin" ? "/private/tmp" : realpathSync("/tmp");
const V1 = IDENTITY_REGISTRY_SCHEMA;
const V2 = IDENTITY_REGISTRY_SCHEMA_V2;
const T0 = "2026-11-07T10:00:00.000Z";
const T1 = "2026-11-07T10:05:00.000Z";
const BASELINE_COMMIT = "d418fb1"; // the last main before any v2 code: today's reader

// ---- builders ---------------------------------------------------------------------------------------------------
const hex32 = (seed) => createHash("sha256").update(String(seed), "utf8").digest("hex").slice(0, 32);
const hex64 = (seed) => createHash("sha256").update(String(seed), "utf8").digest("hex");
const b64u = (seed, bytes) => createHash("sha512").update(String(seed), "utf8").digest().subarray(0, bytes).toString("base64url");
const clone = (value) => JSON.parse(JSON.stringify(value));

function agentBinding(name = "gravity2", overrides = {}) {
  return {
    schema: LOCAL_PROFILE_BINDING_SCHEMA_V2,
    binding_id: `bind_${hex32(`bind:${name}`)}`,
    trust_mode: "mesh-managed",
    principal_id: `agent_${hex32(`agent:${name}`)}`,
    profile_name: name,
    profile_instance_id: deriveClientInstanceId(name),
    authority_origin: "https://mesh.example.test",
    principal_public_key: null,
    binding_generation: 1,
    issued_at: T0,
    revoked_at: null,
    proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
    ...overrides,
  };
}

function peerBinding(name = "peerprof", overrides = {}) {
  return {
    schema: LOCAL_PROFILE_BINDING_SCHEMA_V2,
    binding_id: `bind_${hex32(`bind:${name}`)}`,
    trust_mode: "serverless-peer",
    principal_id: `peer_${hex32(`peer:${name}`)}`,
    profile_name: name,
    profile_instance_id: deriveClientInstanceId(name),
    authority_origin: null,
    principal_public_key: b64u(`pk:${name}`, 32),
    binding_generation: 1,
    issued_at: T0,
    revoked_at: null,
    proof: { kind: "local_principal_self_sig", principal_sig: b64u(`sig:${name}`, 64) },
    ...overrides,
  };
}

function v1Binding(name = "gravity2", overrides = {}) {
  const { principal_public_key: _drop, ...rest } = agentBinding(name);
  return { ...rest, schema: LOCAL_PROFILE_BINDING_SCHEMA, ...overrides };
}

function pairing(n, localPrincipal, overrides = {}) {
  return {
    schema: SERVERLESS_PAIRING_SCHEMA,
    pairing_id: `pair_${hex32(`pair:${n}`)}`,
    local_principal_id: localPrincipal,
    remote_principal_id: `peer_${hex32(`remote:${n}`)}`,
    remote_principal_public_key: b64u(`rpk:${n}`, 32),
    remote_endpoint_ids: [hex64(`ep:${n}`)],
    petname: `friend-${n}`,
    binding_generation: 1,
    issued_at: T0,
    expires_at: "2027-11-07T10:00:00.000Z",
    remote_invitation_sig: b64u(`inv:${n}`, 64),
    local_owner_approval_sig: b64u(`app:${n}`, 64),
    next_key_digest: null,
    pending_rotation: null,
    pending_endpoint_update: null,
    revoked_at: null,
    ...overrides,
  };
}

function fullV2() {
  const agent = agentBinding("gravity2");
  const peer = peerBinding("peerprof");
  const pair = pairing(1, peer.principal_id);
  return {
    schema: V2,
    sequence: 4,
    createdAt: T0,
    updatedAt: T1,
    auditHead: { sequence: 4, hash: hex64("head") },
    bindings: { [agent.profile_instance_id]: agent, [peer.profile_instance_id]: peer },
    pairings: { [pair.pairing_id]: pair },
    aliases: {
      gravity: { principal_id: agent.principal_id, set_at: T0, generation: 1 },
      friend: { principal_id: pair.remote_principal_id, set_at: T0, generation: 2 },
    },
    destinations: {
      [agent.principal_id]: { harness: "claude", workspace: "/Users/test/Projects/The Triangle", set_at: T0, generation: 1 },
    },
  };
}

function v1Registry(names = ["gravity2"], overrides = {}) {
  const bindings = {};
  for (const name of names) {
    const b = v1Binding(name);
    bindings[b.profile_instance_id] = b;
  }
  return {
    schema: V1,
    sequence: 1,
    createdAt: T0,
    updatedAt: T1,
    auditHead: { sequence: 1, hash: hex64("v1head") },
    bindings,
    ...overrides,
  };
}

function assertRejects(value, reason) {
  assert.throws(
    () => validateIdentityRegistry(value),
    (err) => {
      assert.equal(err.code, "invalid_registry", `expected invalid_registry, got ${err.message}`);
      assert.equal(err.reason, reason, `expected reason ${reason}, got ${err.reason}`);
      assert.match(err.message, /^invalid_registry: [a-z0-9_]+$/);
      return true;
    },
  );
}

function mutated(fn) {
  const r = fullV2();
  fn(r);
  return r;
}

function firstKey(obj) {
  return Object.keys(obj)[0];
}

// ---- constants and dispatch ----------------------------------------------------------------------------------------
test("v2 exports: schema names, supported list and caps", () => {
  assert.equal(IDENTITY_REGISTRY_SCHEMA, "identity_registry_v1");
  assert.equal(IDENTITY_REGISTRY_SCHEMA_V2, "identity_registry_v2");
  assert.equal(LOCAL_PROFILE_BINDING_SCHEMA_V2, "local_profile_binding_v2");
  assert.equal(SERVERLESS_PAIRING_SCHEMA, "serverless_pairing_v1");
  assert.deepEqual([...SUPPORTED_REGISTRY_SCHEMAS], ["identity_registry_v1", "identity_registry_v2"]);
  assert.ok(Object.isFrozen(SUPPORTED_REGISTRY_SCHEMAS));
  assert.equal(MAX_REGISTRY_PAIRINGS, 256);
  assert.equal(MAX_REGISTRY_ALIASES, 256);
  assert.equal(MAX_REGISTRY_DESTINATIONS, 256);
  assert.equal(emptyIdentityRegistry({ now: T0 }).schema, V1, "new registries are still v1");
});

test("a complete v2 registry validates, is frozen and has one canonical form", () => {
  const out = validateIdentityRegistry(fullV2());
  assert.equal(out.schema, V2);
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.pairings) && Object.isFrozen(out.bindings));
  const once = canonicalJson(out);
  const twice = canonicalJson(validateIdentityRegistry(JSON.parse(once)));
  assert.equal(twice, once);
  // key order of the input does not matter
  const shuffled = fullV2();
  const reordered = { destinations: shuffled.destinations, aliases: shuffled.aliases, pairings: shuffled.pairings, bindings: shuffled.bindings, auditHead: shuffled.auditHead, updatedAt: shuffled.updatedAt, createdAt: shuffled.createdAt, sequence: shuffled.sequence, schema: shuffled.schema };
  assert.equal(canonicalJson(validateIdentityRegistry(reordered)), once);
});

test("the schema field selects the validator; unknown schemas and mixed shapes are refused", () => {
  assert.equal(validateIdentityRegistry(v1Registry()).schema, V1);
  assertRejects({ ...v1Registry(), schema: "identity_registry_v3" }, "invalid_registry_schema");
  assertRejects({ ...fullV2(), schema: "identity_registry_v3" }, "unknown_registry_key");
  // v2-only keys in a v1 document, and a v1 document with the v2 schema string
  assertRejects({ ...v1Registry(), pairings: {}, aliases: {}, destinations: {} }, "unknown_registry_key");
  const v1AsV2 = { ...v1Registry(), schema: V2 };
  assertRejects(v1AsV2, "missing_registry_key");
  assertRejects({ ...v1AsV2, pairings: {}, aliases: {}, destinations: {} }, "missing_binding_key");
  // a v1 binding record inside a v2 registry, and the reverse
  assertRejects(mutated((r) => { r.bindings[firstKey(r.bindings)] = v1Binding("gravity2"); }), "missing_binding_key");
  assertRejects({ ...v1Registry(), bindings: { [deriveClientInstanceId("gravity2")]: agentBinding("gravity2") } }, "unknown_binding_key");
});

// ---- v2 envelope ----------------------------------------------------------------------------------------------------
test("v2 envelope: every key is required, unknown keys and bad containers are refused", () => {
  for (const key of ["schema", "sequence", "createdAt", "updatedAt", "auditHead", "bindings", "pairings", "aliases", "destinations"]) {
    const r = fullV2();
    delete r[key];
    // without its v2 schema string a document is judged as v1, and the v2-only keys are then unknown
    assertRejects(r, key === "schema" ? "unknown_registry_key" : "missing_registry_key");
  }
  assertRejects(mutated((r) => { r.extra = 1; }), "unknown_registry_key");
  assertRejects("not an object", "registry_not_object");
  assertRejects(null, "registry_not_object");
  assertRejects(mutated((r) => { r.sequence = -1; }), "invalid_sequence");
  assertRejects(mutated((r) => { r.createdAt = "yesterday"; }), "invalid_created_at");
  assertRejects(mutated((r) => { r.updatedAt = "2026-11-07T09:00:00.000Z"; }), "updated_before_created");
  assertRejects(mutated((r) => { r.auditHead.sequence = 3; }), "invalid_audit_head_sequence");
  assertRejects(mutated((r) => { r.auditHead.hash = ZERO_HASH_64; }), "invalid_nonzero_sequence_hash");
  assertRejects(mutated((r) => { r.sequence = 0; r.auditHead = { sequence: 0, hash: hex64("x") }; }), "invalid_zero_sequence_hash");
  for (const key of ["bindings", "pairings", "aliases", "destinations"]) {
    assertRejects(mutated((r) => { r[key] = []; }), `${key}_not_object`);
    assertRejects(mutated((r) => { r[key] = null; }), `${key}_not_object`);
  }
});

// ---- v2 bindings ----------------------------------------------------------------------------------------------------
const BINDING_CASES = [
  ["agent: schema v1", (b) => { b.schema = LOCAL_PROFILE_BINDING_SCHEMA; }, "invalid_binding_schema", "agent"],
  ["agent: unknown key", (b) => { b.extra = 1; }, "unknown_binding_key", "agent"],
  ["agent: missing key", (b) => { delete b.principal_public_key; }, "missing_binding_key", "agent"],
  ["unknown trust mode", (b) => { b.trust_mode = "federated"; }, "invalid_trust_mode", "agent"],
  ["agent: peer-shaped principal", (b) => { b.principal_id = `peer_${hex32("x")}`; }, "invalid_principal_id", "agent"],
  ["agent: authority origin missing", (b) => { b.authority_origin = null; }, "invalid_authority_origin", "agent"],
  ["agent: authority origin with a path", (b) => { b.authority_origin = "https://mesh.example.test/x"; }, "invalid_authority_origin", "agent"],
  ["agent: public key present", (b) => { b.principal_public_key = b64u("k", 32); }, "invalid_principal_public_key", "agent"],
  ["agent: self-sig proof", (b) => { b.proof = { kind: "local_principal_self_sig", principal_sig: b64u("s", 64) }; }, "unknown_proof_key", "agent"],
  ["agent: verified authority claimed", (b) => { b.proof.verified_live_authority = true; }, "invalid_proof_values", "agent"],
  ["agent: proof not an object", (b) => { b.proof = "x"; }, "invalid_proof", "agent"],
  ["agent: missing proof key", (b) => { delete b.proof.observed_on_disk; }, "missing_proof_key", "agent"],
  ["agent: instance id mismatch", (b) => { b.profile_name = "other"; }, "profile_instance_id_mismatch", "agent"],
  ["agent: generation 0", (b) => { b.binding_generation = 0; }, "invalid_binding_generation", "agent"],
  ["agent: fractional generation", (b) => { b.binding_generation = 1.5; }, "invalid_binding_generation", "agent"],
  ["agent: bad issued_at", (b) => { b.issued_at = "2026-02-31T00:00:00Z"; }, "invalid_issued_at", "agent"],
  ["agent: revoked before issued", (b) => { b.revoked_at = "2026-11-07T09:00:00.000Z"; }, "revoked_before_issued", "agent"],
  ["agent: bad binding id", (b) => { b.binding_id = "bind_x"; }, "invalid_binding_id", "agent"],
  ["peer: agent-shaped principal", (b) => { b.principal_id = `agent_${hex32("x")}`; }, "invalid_principal_id", "peer"],
  ["peer: authority origin present", (b) => { b.authority_origin = "https://mesh.example.test"; }, "invalid_authority_origin", "peer"],
  ["peer: public key null", (b) => { b.principal_public_key = null; }, "invalid_principal_public_key", "peer"],
  ["peer: public key 31 bytes", (b) => { b.principal_public_key = b64u("k", 31); }, "invalid_principal_public_key", "peer"],
  ["peer: public key padded", (b) => { b.principal_public_key = `${b64u("k", 32)}=`; }, "invalid_principal_public_key", "peer"],
  ["peer: public key not canonical (tail bits)", (b) => { const s = b64u("k", 32); b.principal_public_key = `${s.slice(0, -1)}B`; }, "invalid_principal_public_key", "peer"],
  ["peer: public key standard base64 alphabet", (b) => { b.principal_public_key = `${"+".repeat(43)}`; }, "invalid_principal_public_key", "peer"],
  ["peer: disk observation proof", (b) => { b.proof = { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false }; }, "unknown_proof_key", "peer"],
  ["peer: proof without signature", (b) => { b.proof = { kind: "local_principal_self_sig" }; }, "missing_proof_key", "peer"],
  ["peer: wrong proof kind", (b) => { b.proof.kind = "mesh_dpop_bind_proof"; }, "invalid_proof_values", "peer"],
  ["peer: signature 63 bytes", (b) => { b.proof.principal_sig = b64u("s", 63); }, "invalid_principal_sig", "peer"],
  ["peer: signature empty", (b) => { b.proof.principal_sig = ""; }, "invalid_principal_sig", "peer"],
];

test("v2 binding rules: every field and the trust-mode coupling", () => {
  for (const [name, change, reason, which] of BINDING_CASES) {
    const r = fullV2();
    const key = Object.keys(r.bindings).find((k) => r.bindings[k].trust_mode === (which === "agent" ? "mesh-managed" : "serverless-peer"));
    change(r.bindings[key]);
    assertRejects(r, reason);
  }
});

test("v2 bindings: duplicate binding ids, wrong map keys and revoked records", () => {
  assertRejects(mutated((r) => { const [a, p] = Object.keys(r.bindings); r.bindings[p].binding_id = r.bindings[a].binding_id; }), "duplicate_binding_id");
  assertRejects(mutated((r) => { r.bindings.zz = r.bindings[firstKey(r.bindings)]; }), "invalid_binding_map_key");
  assertRejects(mutated((r) => { const k = firstKey(r.bindings); r.bindings[hex64("other")] = r.bindings[k]; delete r.bindings[k]; }), "binding_key_mismatch");
  // revoked records stay valid; so do two unrevoked bindings of one principal (legacy files must stay readable, the writer refuses to create them)
  const ok = fullV2();
  const k = firstKey(ok.bindings);
  ok.bindings[k].revoked_at = T1;
  assert.doesNotThrow(() => validateIdentityRegistry(ok));
  const twin = fullV2();
  const second = agentBinding("ghost", { principal_id: agentBinding("gravity2").principal_id });
  twin.bindings[second.profile_instance_id] = second;
  assert.doesNotThrow(() => validateIdentityRegistry(twin));
});

// ---- pairings ---------------------------------------------------------------------------------------------------------
const PAIRING_CASES = [
  ["unknown key", (p) => { p.extra = 1; }, "unknown_pairing_key"],
  ["missing key", (p) => { delete p.next_key_digest; }, "missing_pairing_key"],
  ["schema", (p) => { p.schema = "serverless_pairing_v2"; }, "invalid_pairing_schema"],
  ["id shape", (p) => { p.pairing_id = "pair_x"; }, "invalid_pairing_id"],
  ["id differs from its key", (p) => { p.pairing_id = `pair_${hex32("other")}`; }, "pairing_key_mismatch"],
  ["local principal is an agent", (p) => { p.local_principal_id = `agent_${hex32("a")}`; }, "invalid_local_principal_id"],
  ["remote principal is an agent", (p) => { p.remote_principal_id = `agent_${hex32("a")}`; }, "invalid_remote_principal_id"],
  ["pairing with itself", (p) => { p.remote_principal_id = p.local_principal_id; }, "pairing_self_reference"],
  ["remote key 31 bytes", (p) => { p.remote_principal_public_key = b64u("k", 31); }, "invalid_remote_principal_public_key"],
  ["no endpoints", (p) => { p.remote_endpoint_ids = []; }, "invalid_remote_endpoint_ids"],
  ["nine endpoints", (p) => { p.remote_endpoint_ids = Array.from({ length: 9 }, (_, i) => hex64(`e${i}`)).sort(); }, "invalid_remote_endpoint_ids"],
  ["endpoint not hex", (p) => { p.remote_endpoint_ids = ["xyz"]; }, "invalid_remote_endpoint_ids"],
  ["endpoints not an array", (p) => { p.remote_endpoint_ids = hex64("e"); }, "invalid_remote_endpoint_ids"],
  ["endpoints unsorted", (p) => { p.remote_endpoint_ids = [hex64("a"), hex64("b")].sort().reverse(); }, "remote_endpoint_ids_not_sorted"],
  ["endpoints repeated", (p) => { const e = hex64("a"); p.remote_endpoint_ids = [e, e]; }, "remote_endpoint_ids_not_sorted"],
  ["empty petname", (p) => { p.petname = ""; }, "invalid_petname"],
  ["petname with a slash", (p) => { p.petname = "a/b"; }, "invalid_petname"],
  ["petname over 64 bytes", (p) => { p.petname = "x".repeat(65); }, "invalid_petname"],
  ["generation 0", (p) => { p.binding_generation = 0; }, "invalid_binding_generation"],
  ["bad issued_at", (p) => { p.issued_at = "nope"; }, "invalid_issued_at"],
  ["bad expires_at", (p) => { p.expires_at = null; }, "invalid_expires_at"],
  ["expires at issue time", (p) => { p.expires_at = p.issued_at; }, "expires_not_after_issued"],
  ["bad revoked_at", (p) => { p.revoked_at = "nope"; }, "invalid_revoked_at"],
  ["revoked before issued", (p) => { p.revoked_at = "2026-11-07T09:00:00.000Z"; }, "revoked_before_issued"],
  ["invitation signature", (p) => { p.remote_invitation_sig = b64u("s", 63); }, "invalid_remote_invitation_sig"],
  ["approval signature", (p) => { p.local_owner_approval_sig = ""; }, "invalid_local_owner_approval_sig"],
  ["key digest", (p) => { p.next_key_digest = "abc"; }, "invalid_next_key_digest"],
];

test("v2 pairing rules: every field", () => {
  for (const [name, change, reason] of PAIRING_CASES) {
    const r = fullV2();
    change(r.pairings[firstKey(r.pairings)]);
    assertRejects(r, reason);
  }
  const ok = fullV2();
  const p = ok.pairings[firstKey(ok.pairings)];
  p.next_key_digest = hex64("next");
  p.revoked_at = T1;
  p.remote_endpoint_ids = Array.from({ length: 8 }, (_, i) => hex64(`e${i}`)).sort();
  assert.doesNotThrow(() => validateIdentityRegistry(ok));
});

test("v2 pairing pending approval rules: pending_rotation and pending_endpoint_update", () => {
  function validRotation(p, overrides = {}) {
    return {
      new_public_key: b64u("new_rotation_key", 32),
      binding_generation: p.binding_generation + 1,
      rotated_at: T1,
      sig_by_old_key: b64u("sig_old_key", 64),
      sig_by_new_key: b64u("sig_new_key", 64),
      next_key_digest: null,
      ...overrides,
    };
  }

  function validEndpointUpdate(p, overrides = {}) {
    return {
      new_endpoint_ids: [hex64("new_endpoint_1")],
      binding_generation: p.binding_generation + 1,
      issued_at: T0,
      expires_at: "2027-11-07T10:00:00.000Z",
      principal_sig: b64u("sig_endpoint_update", 64),
      ...overrides,
    };
  }

  // Positive case: valid pending_rotation with next_key_digest null and hex64
  {
    const r = fullV2();
    const p = r.pairings[firstKey(r.pairings)];
    p.pending_rotation = validRotation(p);
    assert.doesNotThrow(() => validateIdentityRegistry(r));
    p.pending_rotation = validRotation(p, { next_key_digest: hex64("future_digest") });
    assert.doesNotThrow(() => validateIdentityRegistry(r));
  }

  // Positive case: valid pending_endpoint_update (1 and up to 8 endpoints)
  {
    const r = fullV2();
    const p = r.pairings[firstKey(r.pairings)];
    p.pending_endpoint_update = validEndpointUpdate(p);
    assert.doesNotThrow(() => validateIdentityRegistry(r));
    p.pending_endpoint_update = validEndpointUpdate(p, {
      new_endpoint_ids: Array.from({ length: 8 }, (_, i) => hex64(`new_ep_${i}`)).sort(),
    });
    assert.doesNotThrow(() => validateIdentityRegistry(r));
  }

  // Positive case: both present simultaneously
  {
    const r = fullV2();
    const p = r.pairings[firstKey(r.pairings)];
    p.pending_rotation = validRotation(p);
    p.pending_endpoint_update = validEndpointUpdate(p);
    assert.doesNotThrow(() => validateIdentityRegistry(r));
  }

  // Negative cases: pending_rotation
  const rotCases = [
    ["not an object (string)", () => "bad", "invalid_pending_rotation"],
    ["not an object (array)", () => [], "invalid_pending_rotation"],
    ["unknown key", (p) => validRotation(p, { unknown_extra: "val" }), "unknown_pending_rotation_key"],
    ["missing key", (p) => { const rot = validRotation(p); delete rot.rotated_at; return rot; }, "missing_pending_rotation_key"],
    ["same key as remote_principal_public_key", (p) => validRotation(p, { new_public_key: p.remote_principal_public_key }), "invalid_pending_rotation_key"],
    ["invalid new_public_key format", (p) => validRotation(p, { new_public_key: "short" }), "invalid_pending_rotation_key"],
    ["generation not safe integer", (p) => validRotation(p, { binding_generation: 1.5 }), "invalid_pending_rotation_generation"],
    ["generation equal to pairing generation", (p) => validRotation(p, { binding_generation: p.binding_generation }), "invalid_pending_rotation_generation"],
    ["generation less than pairing generation", (p) => validRotation(p, { binding_generation: p.binding_generation - 1 }), "invalid_pending_rotation_generation"],
    ["invalid rotated_at timestamp", (p) => validRotation(p, { rotated_at: "not-a-date" }), "invalid_pending_rotation_time"],
    ["invalid sig_by_old_key", (p) => validRotation(p, { sig_by_old_key: "bad" }), "invalid_pending_rotation_signature"],
    ["invalid sig_by_new_key", (p) => validRotation(p, { sig_by_new_key: "bad" }), "invalid_pending_rotation_signature"],
    ["invalid next_key_digest (non-hex)", (p) => validRotation(p, { next_key_digest: "not-hex" }), "invalid_pending_rotation_digest"],
    ["invalid next_key_digest (number)", (p) => validRotation(p, { next_key_digest: 12345 }), "invalid_pending_rotation_digest"],
  ];
  for (const [name, makeRot, reason] of rotCases) {
    const r = fullV2();
    const p = r.pairings[firstKey(r.pairings)];
    p.pending_rotation = makeRot(p);
    assertRejects(r, reason);
  }

  // Negative cases: pending_endpoint_update
  const epCases = [
    ["not an object (string)", () => "bad", "invalid_pending_endpoint_update"],
    ["not an object (array)", () => [], "invalid_pending_endpoint_update"],
    ["unknown key", (p) => validEndpointUpdate(p, { extra_key: 1 }), "unknown_pending_endpoint_update_key"],
    ["missing key", (p) => { const u = validEndpointUpdate(p); delete u.principal_sig; return u; }, "missing_pending_endpoint_update_key"],
    ["endpoints not an array", (p) => validEndpointUpdate(p, { new_endpoint_ids: hex64("single") }), "invalid_pending_endpoint_ids"],
    ["endpoints empty array", (p) => validEndpointUpdate(p, { new_endpoint_ids: [] }), "invalid_pending_endpoint_ids"],
    ["endpoints over 8", (p) => validEndpointUpdate(p, { new_endpoint_ids: Array.from({ length: 9 }, (_, i) => hex64(`ep_${i}`)).sort() }), "invalid_pending_endpoint_ids"],
    ["endpoint format invalid", (p) => validEndpointUpdate(p, { new_endpoint_ids: ["not_hex_64"] }), "invalid_pending_endpoint_ids"],
    ["endpoint already in pairing.remote_endpoint_ids", (p) => validEndpointUpdate(p, { new_endpoint_ids: [p.remote_endpoint_ids[0]] }), "invalid_pending_endpoint_ids"],
    ["endpoints not sorted", (p) => validEndpointUpdate(p, { new_endpoint_ids: [hex64("a"), hex64("b")].sort().reverse() }), "invalid_pending_endpoint_ids"],
    ["endpoints duplicate", (p) => { const ep = hex64("dupe"); return validEndpointUpdate(p, { new_endpoint_ids: [ep, ep] }); }, "invalid_pending_endpoint_ids"],
    ["generation not safe integer", (p) => validEndpointUpdate(p, { binding_generation: "2" }), "invalid_pending_endpoint_generation"],
    ["generation equal to pairing generation", (p) => validEndpointUpdate(p, { binding_generation: p.binding_generation }), "invalid_pending_endpoint_generation"],
    ["issued_at invalid", (p) => validEndpointUpdate(p, { issued_at: "invalid-date" }), "invalid_pending_endpoint_time"],
    ["expires_at invalid", (p) => validEndpointUpdate(p, { expires_at: "invalid-date" }), "invalid_pending_endpoint_time"],
    ["expires_at equal to issued_at", (p) => validEndpointUpdate(p, { expires_at: p.issued_at }), "invalid_pending_endpoint_time"],
    ["expires_at before issued_at", (p) => validEndpointUpdate(p, { issued_at: "2027-11-07T10:00:00.000Z", expires_at: "2026-11-07T10:00:00.000Z" }), "invalid_pending_endpoint_time"],
    ["invalid principal_sig", (p) => validEndpointUpdate(p, { principal_sig: b64u("sig", 63) }), "invalid_pending_endpoint_signature"],
  ];
  for (const [name, makeEp, reason] of epCases) {
    const r = fullV2();
    const p = r.pairings[firstKey(r.pairings)];
    p.pending_endpoint_update = makeEp(p);
    assertRejects(r, reason);
  }
});

test("v2 pairing rules: local principal must be a serverless binding; live duplicates are refused, revoked ones are not", () => {
  assertRejects(mutated((r) => { const p = r.pairings[firstKey(r.pairings)]; p.local_principal_id = `peer_${hex32("nobody")}`; }), "pairing_local_principal_unbound");
  // the local principal of a pairing cannot be an agent binding (those are never peer_ ids), so unknown peers are the case
  const dup = (mutate) => mutated((r) => {
    const local = Object.values(r.bindings).find((b) => b.trust_mode === "serverless-peer").principal_id;
    const second = pairing(2, local);
    mutate(second, r.pairings[firstKey(r.pairings)]);
    r.pairings[second.pairing_id] = second;
  });
  assertRejects(dup((second, first) => { second.remote_principal_id = first.remote_principal_id; }), "duplicate_pairing");
  assertRejects(dup((second, first) => { second.petname = first.petname; }), "duplicate_petname");
  assertRejects(dup((second, first) => { second.remote_endpoint_ids = [first.remote_endpoint_ids[0]]; }), "duplicate_endpoint_id");
  // the same facts are fine once the older pairing is revoked
  const revoked = mutated((r) => { r.pairings[firstKey(r.pairings)].revoked_at = T1; });
  const local = Object.values(revoked.bindings).find((b) => b.trust_mode === "serverless-peer").principal_id;
  const first = revoked.pairings[firstKey(revoked.pairings)];
  const renewed = pairing(2, local, { remote_principal_id: first.remote_principal_id, petname: first.petname, remote_endpoint_ids: [...first.remote_endpoint_ids] });
  revoked.pairings[renewed.pairing_id] = renewed;
  assert.doesNotThrow(() => validateIdentityRegistry(revoked));

  // a pairing whose local serverless binding was revoked is valid
  const okRevokedLocal = fullV2();
  const localPeer = Object.values(okRevokedLocal.bindings).find((b) => b.trust_mode === "serverless-peer");
  localPeer.revoked_at = T1;
  assert.doesNotThrow(() => validateIdentityRegistry(okRevokedLocal));
});

test("v2 M1: single key per peer_ id, duplicate serverless binding, and shared endpoint rules", () => {
  // 1. duplicate_serverless_principal: at most one live serverless binding per peer_ id
  {
    const r = fullV2();
    const peer1 = Object.values(r.bindings).find((b) => b.trust_mode === "serverless-peer");
    const peer2 = peerBinding("peer2", { principal_id: peer1.principal_id });
    r.bindings[peer2.profile_instance_id] = peer2;
    assertRejects(r, "duplicate_serverless_principal");

    // But if the older binding is revoked, it validates fine
    peer1.revoked_at = T1;
    assert.doesNotThrow(() => validateIdentityRegistry(r));
  }

  // 2. peer_key_conflict: across live pairings with the same remote_principal_id
  {
    const r = fullV2();
    const local1Binding = Object.values(r.bindings).find((b) => b.trust_mode === "serverless-peer");
    const local2Binding = peerBinding("peer_local_2");
    r.bindings[local2Binding.profile_instance_id] = local2Binding;

    const p1 = r.pairings[firstKey(r.pairings)];
    const p2 = pairing(2, local2Binding.principal_id, {
      remote_principal_id: p1.remote_principal_id,
      remote_principal_public_key: b64u("conflicting_key", 32),
      petname: "other_petname",
      remote_endpoint_ids: [hex64("other_ep")],
    });
    r.pairings[p2.pairing_id] = p2;
    assertRejects(r, "peer_key_conflict");

    // Same key across both live pairings is valid
    p2.remote_principal_public_key = p1.remote_principal_public_key;
    assert.doesNotThrow(() => validateIdentityRegistry(r));

    // If p1 is revoked, p2 with a different key is valid
    p2.remote_principal_public_key = b64u("conflicting_key", 32);
    p1.revoked_at = T1;
    assert.doesNotThrow(() => validateIdentityRegistry(r));
  }

  // 3. peer_key_conflict: pairing remote_principal_id matches a live local serverless binding
  {
    const r = fullV2();
    const local1Binding = Object.values(r.bindings).find((b) => b.trust_mode === "serverless-peer");
    const local2Binding = peerBinding("peer_local_2");
    r.bindings[local2Binding.profile_instance_id] = local2Binding;

    const p1 = r.pairings[firstKey(r.pairings)];
    p1.remote_principal_id = local2Binding.principal_id;
    r.aliases.friend.principal_id = local2Binding.principal_id;
    p1.remote_principal_public_key = b64u("different_than_binding", 32);
    assertRejects(r, "peer_key_conflict");

    // Matching key is valid
    p1.remote_principal_public_key = local2Binding.principal_public_key;
    assert.doesNotThrow(() => validateIdentityRegistry(r));

    // If local2Binding is revoked, different key is valid
    local2Binding.revoked_at = T1;
    p1.remote_principal_public_key = b64u("different_than_binding", 32);
    assert.doesNotThrow(() => validateIdentityRegistry(r));
  }

  // 4. duplicate_endpoint_id: shared endpoint between live pairings
  {
    const r = fullV2();
    const local1Binding = Object.values(r.bindings).find((b) => b.trust_mode === "serverless-peer");
    const local2Binding = peerBinding("peer_local_2");
    r.bindings[local2Binding.profile_instance_id] = local2Binding;

    const p1 = r.pairings[firstKey(r.pairings)];
    const sharedEp = p1.remote_endpoint_ids[0];

    // Shared endpoint with DIFFERENT remote principal: rejected
    const p2DifferentRemote = pairing(2, local2Binding.principal_id, {
      remote_principal_id: `peer_${hex32("remote_2")}`,
      remote_endpoint_ids: [sharedEp],
    });
    r.pairings[p2DifferentRemote.pairing_id] = p2DifferentRemote;
    assertRejects(r, "duplicate_endpoint_id");

    // Shared endpoint with the SAME remote principal: valid
    delete r.pairings[p2DifferentRemote.pairing_id];
    const p2SameRemote = pairing(3, local2Binding.principal_id, {
      remote_principal_id: p1.remote_principal_id,
      remote_principal_public_key: p1.remote_principal_public_key,
      remote_endpoint_ids: [sharedEp],
    });
    r.pairings[p2SameRemote.pairing_id] = p2SameRemote;
    assert.doesNotThrow(() => validateIdentityRegistry(r));

    // If p1 is revoked, different remote principal can use sharedEp
    delete r.pairings[p2SameRemote.pairing_id];
    p1.revoked_at = T1;
    r.pairings[p2DifferentRemote.pairing_id] = p2DifferentRemote;
    assert.doesNotThrow(() => validateIdentityRegistry(r));
  }
});

test("v2 L7: petname and live-pair uniqueness scopes per local principal", () => {
  const r = fullV2();
  const local1 = Object.values(r.bindings).find((b) => b.trust_mode === "serverless-peer");
  const local2 = peerBinding("local_peer_2");
  r.bindings[local2.profile_instance_id] = local2;

  const p1 = r.pairings[firstKey(r.pairings)];

  // Different local principal can reuse the same petname for another remote principal
  const p2SamePetname = pairing(2, local2.principal_id, {
    remote_principal_id: `peer_${hex32("remote_different")}`,
    remote_principal_public_key: b64u("key_diff", 32),
    petname: p1.petname, // reuse same petname across different local principals
    remote_endpoint_ids: [hex64("ep_diff")],
  });
  r.pairings[p2SamePetname.pairing_id] = p2SamePetname;
  assert.doesNotThrow(() => validateIdentityRegistry(r));

  // Same petname under the same local principal is rejected
  const pSameLocalPetname = pairing(3, local1.principal_id, {
    remote_principal_id: `peer_${hex32("remote_diff_3")}`,
    remote_principal_public_key: b64u("key_diff_3", 32),
    petname: p1.petname,
    remote_endpoint_ids: [hex64("ep_diff_3")],
  });
  r.pairings[pSameLocalPetname.pairing_id] = pSameLocalPetname;
  assertRejects(r, "duplicate_petname");
  delete r.pairings[pSameLocalPetname.pairing_id];

  // Different local principal can pair with the same remote principal (same key)
  const p2SameRemote = pairing(4, local2.principal_id, {
    remote_principal_id: p1.remote_principal_id,
    remote_principal_public_key: p1.remote_principal_public_key,
    petname: "unique_friend",
    remote_endpoint_ids: [hex64("ep_shared_or_diff")],
  });
  delete r.pairings[p2SamePetname.pairing_id];
  r.pairings[p2SameRemote.pairing_id] = p2SameRemote;
  assert.doesNotThrow(() => validateIdentityRegistry(r));

  // Same local principal with same remote principal is rejected (duplicate_pairing)
  const p1Dupe = pairing(5, local1.principal_id, {
    remote_principal_id: p1.remote_principal_id,
    remote_principal_public_key: p1.remote_principal_public_key,
    petname: "different_petname",
    remote_endpoint_ids: [hex64("ep_diff_5")],
  });
  r.pairings[p1Dupe.pairing_id] = p1Dupe;
  assertRejects(r, "duplicate_pairing");
});

// ---- aliases and destinations ----------------------------------------------------------------------------------------
test("v2 alias rules", () => {
  const base = () => fullV2();
  for (const bad of ["", "Bad", "-x", ".x", "a b", "a/b", "é", "a".repeat(33), `agent_${hex32("a")}`, `peer_${hex32("a")}`, `session-${hex64("a")}`, hex64("a")]) {
    const r = base();
    r.aliases[bad] = { principal_id: Object.values(r.bindings)[0].principal_id, set_at: T0, generation: 1 };
    assertRejects(r, "invalid_alias");
  }
  assertRejects(mutated((r) => { r.aliases.gravity = "x"; }), "alias_not_object");
  assertRejects(mutated((r) => { r.aliases.gravity.extra = 1; }), "unknown_alias_key");
  assertRejects(mutated((r) => { delete r.aliases.gravity.generation; }), "missing_alias_key");
  assertRejects(mutated((r) => { r.aliases.gravity.principal_id = "agent_x"; }), "invalid_alias_principal");
  assertRejects(mutated((r) => { r.aliases.gravity.principal_id = `agent_${hex32("nobody")}`; }), "alias_target_unknown");
  assertRejects(mutated((r) => { r.aliases.gravity.set_at = "x"; }), "invalid_alias_set_at");
  for (const badGen of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null]) {
    assertRejects(mutated((r) => { r.aliases.gravity.generation = badGen; }), "invalid_alias_generation");
  }
  // a name of exactly 32 characters, and a target whose binding was revoked, are both valid
  const ok = base();
  ok.aliases["a".repeat(32)] = { principal_id: Object.values(ok.bindings)[0].principal_id, set_at: T0, generation: 1 };
  Object.values(ok.bindings)[0].revoked_at = T1;
  assert.doesNotThrow(() => validateIdentityRegistry(ok));
});

test("v2 destination rules", () => {
  const agent = agentBinding("gravity2").principal_id;
  const withDestination = (record) => mutated((r) => { r.destinations[agent] = record; });
  const good = { harness: "codex", workspace: "/", set_at: T0, generation: 1 };
  assert.doesNotThrow(() => validateIdentityRegistry(withDestination(good)));
  assertRejects(withDestination({ ...good, harness: "grok" }), "invalid_destination_harness");
  for (const bad of ["", "relative/dir", "/a/../b", "/a/./b", "/a//b", "/a/", "/a\\b", "/a\u0000b", "/a\nb", `/${"x".repeat(1024)}`, 42]) {
    assertRejects(withDestination({ ...good, workspace: bad }), "invalid_destination_workspace");
  }
  assert.doesNotThrow(() => validateIdentityRegistry(withDestination({ ...good, workspace: `/${"x".repeat(1023)}` })));
  assertRejects(withDestination({ ...good, set_at: "x" }), "invalid_destination_set_at");
  for (const badGen of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null]) {
    assertRejects(withDestination({ ...good, generation: badGen }), "invalid_destination_generation");
  }
  // destination for a revoked binding is valid
  const okRevokedDest = withDestination(good);
  Object.values(okRevokedDest.bindings)[0].revoked_at = T1;
  assert.doesNotThrow(() => validateIdentityRegistry(okRevokedDest));
  assertRejects(withDestination({ ...good, extra: 1 }), "unknown_destination_key");
  assertRejects(withDestination({ harness: "codex", workspace: "/" }), "missing_destination_key");
  assertRejects(withDestination("x"), "destination_not_object");
  assertRejects(mutated((r) => { r.destinations.nope = { ...good }; }), "invalid_destination_principal");
  // destinations belong to principals bound in this registry, not to remote paired ones
  const remote = Object.values(fullV2().pairings)[0].remote_principal_id;
  assertRejects(mutated((r) => { r.destinations[remote] = { ...good }; }), "destination_principal_unbound");
  assertRejects(mutated((r) => { r.destinations[`agent_${hex32("nobody")}`] = { ...good }; }), "destination_principal_unbound");
});

// ---- caps --------------------------------------------------------------------------------------------------------------
test("v2 caps: collections stop at their limits and the whole registry stops at 1 MiB", () => {
  const peer = peerBinding("peerprof");
  const base = () => ({ ...fullV2(), pairings: {}, aliases: {}, destinations: {} });
  // pairings
  const pairs = (count) => {
    const r = base();
    for (let i = 0; i < count; i++) {
      const p = pairing(i, peer.principal_id);
      r.pairings[p.pairing_id] = p;
    }
    return r;
  };
  assert.doesNotThrow(() => validateIdentityRegistry(pairs(MAX_REGISTRY_PAIRINGS)));
  assertRejects(pairs(MAX_REGISTRY_PAIRINGS + 1), "too_many_pairings");
  // aliases
  const aliases = (count) => {
    const r = base();
    const target = Object.values(r.bindings)[0].principal_id;
    for (let i = 0; i < count; i++) r.aliases[`a${String(i).padStart(4, "0")}`] = { principal_id: target, set_at: T0, generation: 1 };
    return r;
  };
  assert.doesNotThrow(() => validateIdentityRegistry(aliases(MAX_REGISTRY_ALIASES)));
  assertRejects(aliases(MAX_REGISTRY_ALIASES + 1), "too_many_aliases");
  // destinations need that many bound principals
  const destinations = (count) => {
    const r = base();
    for (let i = 0; i < count; i++) {
      const b = agentBinding(`bulk${i}`);
      r.bindings[b.profile_instance_id] = b;
      r.destinations[b.principal_id] = { harness: "codex", workspace: "/w", set_at: T0, generation: 1 };
    }
    return r;
  };
  assert.doesNotThrow(() => validateIdentityRegistry(destinations(MAX_REGISTRY_DESTINATIONS)));
  assertRejects(destinations(MAX_REGISTRY_DESTINATIONS + 1), "too_many_destinations");
  // bindings
  const bindings = (count) => {
    const r = base();
    r.bindings = {};
    for (let i = 0; i < count; i++) {
      const b = agentBinding(`b${i}`);
      r.bindings[b.profile_instance_id] = b;
    }
    return r;
  };
  assert.doesNotThrow(() => validateIdentityRegistry(bindings(MAX_REGISTRY_BINDINGS)));
  assertRejects(bindings(MAX_REGISTRY_BINDINGS + 1), "too_many_bindings");
  // size: every collection near its cap with long fields is larger than 1 MiB
  const longOrigin = `https://${"h".repeat(60)}.${"h".repeat(60)}.${"h".repeat(60)}.example.test`;
  const huge = base();
  huge.bindings = {};
  for (let i = 0; i < MAX_REGISTRY_BINDINGS - 1; i++) {
    const b = agentBinding(`n${i}`.padEnd(60, "x"), { authority_origin: longOrigin });
    huge.bindings[b.profile_instance_id] = b;
  }
  huge.bindings[peer.profile_instance_id] = peer;
  const agents = Object.values(huge.bindings).filter((b) => b.trust_mode === "mesh-managed").slice(0, MAX_REGISTRY_DESTINATIONS);
  for (const b of agents) huge.destinations[b.principal_id] = { harness: "codex", workspace: `/${"w".repeat(1000)}`, set_at: T0, generation: 1 };
  for (let i = 0; i < MAX_REGISTRY_PAIRINGS; i++) {
    const p = pairing(i, peer.principal_id, { remote_endpoint_ids: Array.from({ length: 8 }, (_, j) => hex64(`e${i}.${j}`)).sort(), petname: `p${i}`.padEnd(60, "y") });
    huge.pairings[p.pairing_id] = p;
  }
  assert.equal(Object.keys(huge.bindings).length, MAX_REGISTRY_BINDINGS);
  assert.ok(Buffer.byteLength(canonicalJson(huge)) > MAX_REGISTRY_BYTES, "fixture must exceed the cap");
  assertRejects(huge, "registry_oversized");
});

// ---- the pure upgrade -------------------------------------------------------------------------------------------------
test("upgradeRegistryV1ToV2 is lossless, deterministic and leaves the input alone", () => {
  const v1 = validateIdentityRegistry(v1Registry(["gravity2", "ghost", "codex-headless"]));
  const v2 = upgradeRegistryV1ToV2(v1);
  assert.equal(v2.schema, V2);
  for (const key of ["sequence", "createdAt", "updatedAt"]) assert.equal(v2[key], v1[key]);
  assert.deepEqual(v2.auditHead, v1.auditHead);
  assert.deepEqual(v2.pairings, {});
  assert.deepEqual(v2.aliases, {});
  assert.deepEqual(v2.destinations, {});
  assert.deepEqual(Object.keys(v2.bindings), Object.keys(v1.bindings));
  for (const [id, b] of Object.entries(v2.bindings)) {
    const { principal_public_key, schema, ...rest } = b;
    const { schema: oldSchema, ...oldRest } = v1.bindings[id];
    assert.equal(schema, LOCAL_PROFILE_BINDING_SCHEMA_V2);
    assert.equal(oldSchema, LOCAL_PROFILE_BINDING_SCHEMA);
    assert.equal(principal_public_key, null);
    assert.deepEqual(rest, oldRest);
  }
  assert.ok(Object.isFrozen(v2));
  // deterministic, and a serialized copy reads back identically
  assert.equal(canonicalJson(upgradeRegistryV1ToV2(v1)), canonicalJson(v2));
  assert.equal(canonicalJson(validateIdentityRegistry(JSON.parse(canonicalJson(v2)))), canonicalJson(v2));
  // the input was a deep-frozen validated value and was not touched; a plain unfrozen copy is not touched either
  const plain = clone(v1Registry(["gravity2"]));
  const before = canonicalJson(plain);
  upgradeRegistryV1ToV2(plain);
  assert.equal(canonicalJson(plain), before);
});

test("upgradeRegistryV1ToV2 refuses v2 input, invalid input and junk", () => {
  assert.throws(() => upgradeRegistryV1ToV2(fullV2()), (e) => e.code === "invalid_registry" && e.reason === "upgrade_requires_v1");
  assert.throws(() => upgradeRegistryV1ToV2({ ...v1Registry(), extra: 1 }), (e) => e.reason === "unknown_registry_key");
  assert.throws(() => upgradeRegistryV1ToV2(null), (e) => e.reason === "registry_not_object");
  assert.throws(() => upgradeRegistryV1ToV2(undefined), (e) => e.reason === "registry_not_object");
});

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: random v1 registries upgrade to valid v2 registries that project back to the original", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rnd = prng(seed);
    const count = Math.floor(rnd() * 25);
    const bindings = {};
    for (let i = 0; i < count; i++) {
      const name = `p${seed}-${i}`;
      const revoked = rnd() < 0.3;
      const b = v1Binding(name, {
        binding_generation: 1 + Math.floor(rnd() * 5),
        revoked_at: revoked ? "2026-11-07T11:00:00.000Z" : null,
        authority_origin: rnd() < 0.5 ? "https://mesh.example.test" : "https://other.example.test:8443",
      });
      bindings[b.profile_instance_id] = b;
    }
    const sequence = 1 + Math.floor(rnd() * 50);
    const v1 = validateIdentityRegistry({
      schema: V1,
      sequence,
      createdAt: T0,
      updatedAt: T1,
      auditHead: { sequence, hash: hex64(`h${seed}`) },
      bindings,
    });
    const v2 = upgradeRegistryV1ToV2(v1);
    assert.equal(Object.keys(v2.bindings).length, count);
    // project v2 back to v1 by dropping what v2 added
    const projected = {
      ...clone(v2),
      schema: V1,
      bindings: Object.fromEntries(Object.entries(clone(v2.bindings)).map(([id, b]) => {
        const { principal_public_key, ...rest } = b;
        return [id, { ...rest, schema: LOCAL_PROFILE_BINDING_SCHEMA }];
      })),
    };
    delete projected.pairings;
    delete projected.aliases;
    delete projected.destinations;
    assert.equal(canonicalJson(projected), canonicalJson(v1), `seed ${seed}`);
    assert.equal(canonicalJson(upgradeRegistryV1ToV2(v1)), canonicalJson(v2), `seed ${seed} deterministic`);
  }
});

// ---- disk: reader, audit chain and writer -----------------------------------------------------------------------------------
function makeRoot() {
  const base = mkdtempSync(path.join(TMP_BASE, "id-reg-v2-"));
  chmodSync(base, 0o700);
  return { base, root: path.join(base, "identity") };
}

function makeV1Root(names = ["gravity2", "ghost"]) {
  const { base, root } = makeRoot();
  updateIdentityRegistry({ root, expectedSequence: 0, now: T0, action: "init", subject: null, mutate: (r) => r });
  names.forEach((name, i) => {
    const b = v1Binding(name);
    updateIdentityRegistry({
      root,
      expectedSequence: i + 1,
      now: T0,
      action: "bind",
      subject: b.profile_instance_id,
      mutate: (r) => {
        r.bindings[b.profile_instance_id] = b;
        return r;
      },
    });
  });
  return { base, root };
}

function auditEntry({ sequence, at = T1, action, subject = null, bindingId = null, prevHash }) {
  const withoutHash = { sequence, at, action, subject, bindingId, prevHash };
  return { ...withoutHash, hash: createHash("sha256").update(canonicalJson(withoutHash), "utf8").digest("hex") };
}

function writeRegistry(root, registry) {
  const file = path.join(root, REGISTRY_FILE_NAME);
  writeFileSync(file, `${canonicalJson(registry)}\n`);
  chmodSync(file, 0o600);
}

function readRaw(root) {
  return JSON.parse(readFileSync(path.join(root, REGISTRY_FILE_NAME), "utf8"));
}

// Append one audit entry and replace the registry file, the way a (future) writer would: audit line first, registry second.
function appendAndCommit(root, { action, subject = null, bindingId = null, at = T1, change = (r) => r }) {
  const current = readRaw(root);
  const entry = auditEntry({ sequence: current.sequence + 1, at, action, subject, bindingId, prevHash: current.auditHead.hash });
  appendFileSync(path.join(root, AUDIT_FILE_NAME), `${canonicalJson(entry)}\n`);
  const next = change({ ...current, sequence: entry.sequence, updatedAt: at, auditHead: { sequence: entry.sequence, hash: entry.hash } });
  writeRegistry(root, next);
  return entry;
}

function craftUpgrade(root) {
  const current = readIdentityRegistry({ root }).registry;
  const upgraded = clone(upgradeRegistryV1ToV2(current));
  return appendAndCommit(root, { action: "upgrade", change: (r) => ({ ...upgraded, sequence: r.sequence, updatedAt: r.updatedAt, auditHead: r.auditHead }) });
}

function appendAuditOnly(root, { action, subject = null, bindingId = null, at = T1 }) {
  const current = readRaw(root);
  const entry = auditEntry({ sequence: current.sequence + 1, at, action, subject, bindingId, prevHash: current.auditHead.hash });
  appendFileSync(path.join(root, AUDIT_FILE_NAME), `${canonicalJson(entry)}\n`);
  return entry;
}

function withRoot(fn, names) {
  const { base, root } = makeV1Root(names);
  try {
    return fn(root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function assertReadFails(root, code, reason) {
  assert.throws(
    () => readIdentityRegistry({ root }),
    (err) => {
      assert.equal(err.code, code, err.message);
      assert.equal(err.reason, reason, err.message);
      return true;
    },
  );
}

test("the reader returns a v2 registry whose chain contains the upgrade", () => {
  withRoot((root) => {
    const before = readIdentityRegistry({ root });
    assert.equal(before.registry.schema, V1);
    const entry = craftUpgrade(root);
    const after = readIdentityRegistry({ root });
    assert.equal(after.state, "ok");
    assert.equal(after.registry.schema, V2);
    assert.equal(after.registry.sequence, before.registry.sequence + 1);
    assert.equal(after.registry.auditHead.hash, entry.hash);
    assert.deepEqual(after.audit, { verifiedThrough: before.registry.sequence + 1, uncommittedTail: 0 });
    assert.equal(Object.keys(after.registry.bindings).length, 2);
  });
});

test("a crash between the audit append and the registry replace of an upgrade leaves a readable v1 registry", () => {
  withRoot((root) => {
    const before = readIdentityRegistry({ root });
    appendAuditOnly(root, { action: "upgrade" });
    const mid = readIdentityRegistry({ root });
    assert.equal(mid.registry.schema, V1);
    assert.equal(mid.audit.uncommittedTail, 1);
    assert.equal(mid.registry.sequence, before.registry.sequence);
    // the v1 writer discards the stale tail and carries on
    const b = v1Binding("third");
    const out = updateIdentityRegistry({
      root,
      expectedSequence: before.registry.sequence,
      now: T1,
      action: "bind",
      subject: b.profile_instance_id,
      mutate: (r) => {
        r.bindings[b.profile_instance_id] = b;
        return r;
      },
    });
    assert.equal(out.registry.schema, V1);
    const after = readIdentityRegistry({ root });
    assert.equal(after.audit.uncommittedTail, 0);
    assert.equal(after.registry.sequence, before.registry.sequence + 1);
  });
});

test("audit rules: v1 registries accept no committed v2 action, v2 registries accept exactly one upgrade", () => {
  // a v1-shaped registry whose committed chain contains an upgrade
  withRoot((root) => {
    const entry = appendAuditOnly(root, { action: "upgrade" });
    const current = readRaw(root);
    writeRegistry(root, { ...current, sequence: entry.sequence, updatedAt: T1, auditHead: { sequence: entry.sequence, hash: entry.hash } });
    assertReadFails(root, "registry_chain_broken", "invalid_audit_action");
  });
  // two upgrades in one chain
  withRoot((root) => {
    craftUpgrade(root);
    appendAndCommit(root, { action: "upgrade" });
    assertReadFails(root, "registry_chain_broken", "duplicate_upgrade_audit_action");
  });
  // reserved actions are structurally valid in v2 with the right subject, and nothing else
  withRoot((root) => {
    craftUpgrade(root);
    const agent = agentBinding("gravity2").principal_id;
    appendAndCommit(root, { action: "alias_set", subject: "gravity" });
    appendAndCommit(root, { action: "alias_clear", subject: "gravity" });
    appendAndCommit(root, { action: "destination_set", subject: agent });
    appendAndCommit(root, { action: "destination_clear", subject: `peer_${hex32("p")}` });
    appendAndCommit(root, { action: "pair", subject: `pair_${hex32("1")}` });
    appendAndCommit(root, { action: "pair_update", subject: `pair_${hex32("1")}` });
    appendAndCommit(root, { action: "pair_revoke", subject: `pair_${hex32("1")}` });
    const r = readIdentityRegistry({ root });
    assert.equal(r.registry.schema, V2);
    assert.equal(r.audit.uncommittedTail, 0);
  });
  const bad = [
    ["alias_set with a bad alias", { action: "alias_set", subject: "Bad Alias" }, "invalid_audit_subject"],
    ["alias_set without subject", { action: "alias_set", subject: null }, "invalid_audit_subject"],
    ["destination_set with an instance id", { action: "destination_set", subject: hex64("i") }, "invalid_audit_subject"],
    ["pair with a profile id", { action: "pair", subject: hex64("i") }, "invalid_audit_subject"],
    ["pair with a binding id", { action: "pair", subject: `pair_${hex32("1")}`, bindingId: `bind_${hex32("b")}` }, "invalid_audit_binding_id"],
    ["upgrade with a binding id", { action: "upgrade", bindingId: `bind_${hex32("b")}` }, "invalid_audit_binding_id"],
    ["upgrade with a subject", { action: "upgrade", subject: hex64("i") }, "invalid_upgrade_audit_fields"],
    ["unknown action", { action: "rotate", subject: null }, "invalid_audit_action"],
  ];
  for (const [name, entry, reason] of bad) {
    withRoot((root) => {
      craftUpgrade(root);
      appendAndCommit(root, entry);
      assert.throws(() => readIdentityRegistry({ root }), (err) => err.code === "registry_chain_broken" && err.reason === reason, name);
    });
  }
  // v1 actions keep their v1 field rules inside a v2 chain
  withRoot((root) => {
    craftUpgrade(root);
    appendAndCommit(root, { action: "bind", subject: null, bindingId: null });
    assertReadFails(root, "registry_chain_broken", "missing_audit_subject_or_binding");
  });
});

test("audit rules: L2 tail lines, L4 absent-registry tail, and L5 v2 ordering rules", () => {
  function appendTail(root, prev, { action, subject = null, bindingId = null, at = T1 }) {
    const entry = auditEntry({ sequence: prev.sequence + 1, at, action, subject, bindingId, prevHash: prev.hash });
    appendFileSync(path.join(root, AUDIT_FILE_NAME), `${canonicalJson(entry)}\n`);
    return entry;
  }

  // L2: uncommitted tail entry in a v1 log can be any v2 action; two tail lines give audit_log_too_many_uncommitted_lines
  withRoot((root) => {
    const before = readIdentityRegistry({ root });
    const t1 = appendAuditOnly(root, { action: "alias_set", subject: "gravity" });
    const mid = readIdentityRegistry({ root });
    assert.equal(mid.registry.schema, V1);
    assert.equal(mid.audit.uncommittedTail, 1);
    assert.equal(mid.registry.sequence, before.registry.sequence);

    // Second tail line triggers transient audit_log_too_many_uncommitted_lines
    appendTail(root, t1, { action: "alias_clear", subject: "gravity" });
    assertReadFails(root, "registry_chain_broken", "audit_log_too_many_uncommitted_lines");
  });

  // L2: race across upgrade: v1@N + audit upgrade + audit alias_set gives audit_log_too_many_uncommitted_lines
  withRoot((root) => {
    const t1 = appendAuditOnly(root, { action: "upgrade" });
    appendTail(root, t1, { action: "alias_set", subject: "gravity" });
    assertReadFails(root, "registry_chain_broken", "audit_log_too_many_uncommitted_lines");
  });

  // L2: in a v2 registry tail, upgrade is invalid (invalid_audit_action)
  withRoot((root) => {
    craftUpgrade(root);
    appendAuditOnly(root, { action: "upgrade" });
    assertReadFails(root, "registry_chain_broken", "invalid_audit_action");
  });

  // L2: in a v2 registry tail, other v2 action is valid tail; two tail lines give too_many_uncommitted_lines
  withRoot((root) => {
    craftUpgrade(root);
    const before = readIdentityRegistry({ root });
    const t1 = appendAuditOnly(root, { action: "alias_set", subject: "gravity" });
    const mid = readIdentityRegistry({ root });
    assert.equal(mid.registry.schema, V2);
    assert.equal(mid.audit.uncommittedTail, 1);

    appendTail(root, t1, { action: "alias_clear", subject: "gravity" });
    assertReadFails(root, "registry_chain_broken", "audit_log_too_many_uncommitted_lines");
  });

  // L4: absent registry + [init, upgrade] throws invalid_audit_action (not orphan_audit_log)
  withRoot((root) => {
    rmSync(path.join(root, REGISTRY_FILE_NAME), { force: true });
    rmSync(path.join(root, AUDIT_FILE_NAME), { force: true });
    const e1 = auditEntry({ sequence: 1, at: T0, action: "init", subject: null, bindingId: null, prevHash: "0".repeat(64) });
    const e2 = auditEntry({ sequence: 2, at: T1, action: "upgrade", subject: null, bindingId: null, prevHash: e1.hash });
    const auditFile = path.join(root, AUDIT_FILE_NAME);
    writeFileSync(auditFile, `${canonicalJson(e1)}\n${canonicalJson(e2)}\n`);
    chmodSync(auditFile, 0o600);
    assertReadFails(root, "registry_chain_broken", "invalid_audit_action");
  });

  // L4: lone upgrade on absent registry throws invalid_audit_action
  withRoot((root) => {
    rmSync(path.join(root, REGISTRY_FILE_NAME), { force: true });
    rmSync(path.join(root, AUDIT_FILE_NAME), { force: true });
    const e1 = auditEntry({ sequence: 1, at: T0, action: "upgrade", subject: null, bindingId: null, prevHash: "0".repeat(64) });
    const auditFile = path.join(root, AUDIT_FILE_NAME);
    writeFileSync(auditFile, `${canonicalJson(e1)}\n`);
    chmodSync(auditFile, 0o600);
    assertReadFails(root, "registry_chain_broken", "invalid_audit_action");
  });

  // L7: upgrade as line 1 in a committed v2 registry throws invalid_first_audit_action
  withRoot((root) => {
    rmSync(path.join(root, REGISTRY_FILE_NAME), { force: true });
    rmSync(path.join(root, AUDIT_FILE_NAME), { force: true });
    const e1 = auditEntry({ sequence: 1, at: T0, action: "upgrade", subject: null, bindingId: null, prevHash: "0".repeat(64) });
    const auditFile = path.join(root, AUDIT_FILE_NAME);
    writeFileSync(auditFile, `${canonicalJson(e1)}\n`);
    chmodSync(auditFile, 0o600);
    writeRegistry(root, {
      schema: V2,
      sequence: 1,
      createdAt: T0,
      updatedAt: T0,
      auditHead: { sequence: 1, hash: e1.hash },
      bindings: {},
      pairings: {},
      aliases: {},
      destinations: {},
    });
    assertReadFails(root, "registry_chain_broken", "invalid_first_audit_action");
  });

  // L7: a v1 registry with an unsupported action in tail throws invalid_audit_action
  withRoot((root) => {
    appendAuditOnly(root, { action: "unsupported_action" });
    assertReadFails(root, "registry_chain_broken", "invalid_audit_action");
  });

  // L5: once an upgrade entry exists, no v2-only action may precede it (upgrade_after_v2_action)
  withRoot((root) => {
    appendAndCommit(root, { action: "alias_set", subject: "gravity" });
    const eUpgrade = appendAndCommit(root, { action: "upgrade" });
    const current = readRaw(root);
    const upgraded = upgradeRegistryV1ToV2({ ...current, schema: V1 });
    writeRegistry(root, {
      ...upgraded,
      sequence: eUpgrade.sequence,
      auditHead: { sequence: eUpgrade.sequence, hash: eUpgrade.hash },
      aliases: { gravity: { principal_id: Object.values(upgraded.bindings)[0].principal_id, set_at: T1, generation: 1 } },
    });
    assertReadFails(root, "registry_chain_broken", "upgrade_after_v2_action");
  });

  // L5: zero upgrades in a v2 chain stays allowed (future native v2 init)
  withRoot((root) => {
    const entry = appendAndCommit(root, { action: "alias_set", subject: "gravity" });
    const current = readRaw(root);
    const upgraded = upgradeRegistryV1ToV2({ ...current, schema: V1 });
    const v2Reg = {
      ...upgraded,
      sequence: entry.sequence,
      updatedAt: T1,
      auditHead: { sequence: entry.sequence, hash: entry.hash },
      aliases: { gravity: { principal_id: Object.values(upgraded.bindings)[0].principal_id, set_at: T1, generation: 1 } },
    };
    writeRegistry(root, v2Reg);
    const r = readIdentityRegistry({ root });
    assert.equal(r.state, "ok");
    assert.equal(r.registry.schema, V2);
    assert.equal(r.audit.uncommittedTail, 0);
  });
});

test("the writer refuses a v2 registry and never changes its files", () => {
  withRoot((root) => {
    craftUpgrade(root);
    const registryBefore = readFileSync(path.join(root, REGISTRY_FILE_NAME));
    const auditBefore = readFileSync(path.join(root, AUDIT_FILE_NAME));
    const current = readIdentityRegistry({ root }).registry;
    for (const action of ["bind", "revoke"]) {
      assert.throws(
        () => updateIdentityRegistry({ root, expectedSequence: current.sequence, now: T1, action, subject: deriveClientInstanceId("gravity2"), mutate: (r) => r }),
        (err) => err.code === "invalid_registry" && err.reason === "writer_requires_v1",
      );
    }
    assert.deepEqual(readFileSync(path.join(root, REGISTRY_FILE_NAME)), registryBefore);
    assert.deepEqual(readFileSync(path.join(root, AUDIT_FILE_NAME)), auditBefore);
  });
});

test("the v1 writer cannot switch a registry to v2", () => {
  withRoot((root) => {
    const current = readIdentityRegistry({ root }).registry;
    assert.throws(
      () => updateIdentityRegistry({
        root,
        expectedSequence: current.sequence,
        now: T1,
        action: "bind",
        subject: deriveClientInstanceId("gravity2"),
        mutate: (r) => ({ ...r, schema: V2, pairings: {}, aliases: {}, destinations: {} }),
      }),
      (err) => err.code === "invalid_registry" && err.reason === "mutate_modified_schema",
    );
    assert.equal(readIdentityRegistry({ root }).registry.schema, V1);

    // L1: getter yielding v1 then v2 on an existing root cannot bypass schema check
    let reads = 0;
    assert.throws(
      () => updateIdentityRegistry({
        root,
        expectedSequence: current.sequence,
        now: T1,
        action: "bind",
        subject: deriveClientInstanceId("gravity2"),
        mutate: (r) => {
          const o = { ...r, pairings: {}, aliases: {}, destinations: {} };
          delete o.schema;
          Object.defineProperty(o, "schema", {
            enumerable: true,
            get: () => (reads++ === 0 ? V1 : V2),
          });
          return o;
        },
      }),
    );
    assert.equal(readIdentityRegistry({ root }).registry.schema, V1);
  });

  // L1: getter yielding v1 then v2 on init with an absent root; nothing may be written
  withRoot((root) => {
    rmSync(path.join(root, REGISTRY_FILE_NAME), { force: true });
    rmSync(path.join(root, AUDIT_FILE_NAME), { force: true });
    assert.equal(readIdentityRegistry({ root }).state, "absent");

    let reads = 0;
    assert.throws(
      () => updateIdentityRegistry({
        root,
        expectedSequence: 0,
        now: T0,
        action: "init",
        mutate: (r) => {
          const o = { ...r, pairings: {}, aliases: {}, destinations: {} };
          delete o.schema;
          Object.defineProperty(o, "schema", {
            enumerable: true,
            get: () => (reads++ === 0 ? V1 : V2),
          });
          return o;
        },
      }),
    );
    assert.equal(readIdentityRegistry({ root }).state, "absent");
    assert.equal(existsSync(path.join(root, REGISTRY_FILE_NAME)), false);
    assert.equal(existsSync(path.join(root, AUDIT_FILE_NAME)), false);
  });
});

test("the snapshot provider and the resolver cope with a v2 registry (D1.2 pins the full behavior)", () => {
  withRoot((root) => {
    craftUpgrade(root);
    // Add a serverless binding to the upgraded v2 registry
    const current = readIdentityRegistry({ root }).registry;
    const peer = peerBinding("serverless_smoke");
    const withPeer = {
      ...current,
      bindings: {
        ...current.bindings,
        [peer.profile_instance_id]: peer,
      },
    };
    writeRegistry(root, withPeer);

    const snapshot = createRegistrySnapshotProvider({ root }).get();
    assert.equal(snapshot.state, "ok");
    const gravity = agentBinding("gravity2");
    assert.equal(snapshot.bindingsFor(gravity.principal_id).length, 1);
    // serverless bindings are skipped by the snapshot provider (invariant 3)
    assert.equal(snapshot.bindingsFor(peer.principal_id).length, 0);

    const resolved = resolveRecipient({
      to: gravity.principal_id,
      recipients: [{ id: gravity.profile_instance_id, label: "gravity2" }],
      snapshot,
    });
    assert.equal(resolved.kind, "resolved");
    assert.equal(resolved.recipientId, gravity.profile_instance_id);
    // peer ids are still refused before the snapshot is consulted
    const refused = resolveRecipient({
      to: peer.principal_id,
      recipients: [{ id: peer.profile_instance_id, label: "serverless_smoke" }],
      snapshot,
    });
    assert.equal(refused.kind, "error");
    assert.equal(refused.reason, "peer_not_supported");
  });
});

// ---- today's reader ---------------------------------------------------------------------------------------------------------
test("today's reader (frozen at the last main before v2) refuses a v2 registry and still reads v1", async (t) => {
  const dir = mkdtempSync(path.join(TMP_BASE, "id-reg-old-reader-"));
  try {
    for (const file of ["identity-registry.mjs", "identity-primitives.mjs", "delivery-private-path.mjs"]) {
      let source;
      try {
        source = execFileSync("git", ["show", `${BASELINE_COMMIT}:packages/agent-worker/src/${file}`], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch {
        t.skip(`git history for ${BASELINE_COMMIT} is not available here`);
        return;
      }
      writeFileSync(path.join(dir, file), source);
    }
    const oldReader = await import(pathToFileURL(path.join(dir, "identity-registry.mjs")).href);
    withRoot((root) => {
      assert.equal(oldReader.readIdentityRegistry({ root }).state, "ok", "control: the old reader reads v1");
      craftUpgrade(root);
      assert.throws(
        () => oldReader.readIdentityRegistry({ root }),
        (err) => err.code === "registry_corrupt" && err.reason === "unknown_registry_key",
      );
      // it is the registry file, not the audit log, that stops it: the new reader is fine with both
      assert.equal(readIdentityRegistry({ root }).registry.schema, V2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
