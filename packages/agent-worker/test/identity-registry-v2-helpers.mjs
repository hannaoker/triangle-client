// Shared builders and disk helpers for the registry v2 writer tests (D1.1).
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import {
  AUDIT_FILE_NAME,
  canonicalJson,
  LOCAL_PROFILE_BINDING_SCHEMA,
  LOCAL_PROFILE_BINDING_SCHEMA_V2,
  readIdentityRegistry,
  REGISTRY_FILE_NAME,
  SERVERLESS_PAIRING_SCHEMA,
  updateIdentityRegistry,
  upgradeRegistryV1ToV2,
} from "../src/identity-registry.mjs";

export const TMP_BASE = process.platform === "darwin" ? "/private/tmp" : realpathSync("/tmp");
export const T0 = "2026-11-07T10:00:00.000Z";
export const T1 = "2026-11-07T10:05:00.000Z";
export const T2 = "2026-11-07T10:10:00.000Z";

export const hex32 = (seed) => createHash("sha256").update(String(seed), "utf8").digest("hex").slice(0, 32);
export const hex64 = (seed) => createHash("sha256").update(String(seed), "utf8").digest("hex");
export const b64u = (seed, bytes) => createHash("sha512").update(String(seed), "utf8").digest().subarray(0, bytes).toString("base64url");

export function agentBindingV1(name, overrides = {}) {
  return {
    schema: LOCAL_PROFILE_BINDING_SCHEMA,
    binding_id: `bind_${hex32(`bind:${name}`)}`,
    trust_mode: "mesh-managed",
    principal_id: `agent_${hex32(`agent:${name}`)}`,
    profile_name: name,
    profile_instance_id: deriveClientInstanceId(name),
    authority_origin: "https://mesh.example.test",
    binding_generation: 1,
    issued_at: T0,
    revoked_at: null,
    proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
    ...overrides,
  };
}

export function agentBindingV2(name, overrides = {}) {
  return { ...agentBindingV1(name), schema: LOCAL_PROFILE_BINDING_SCHEMA_V2, principal_public_key: null, ...overrides };
}

export function peerBindingV2(name, overrides = {}) {
  return {
    ...agentBindingV2(name),
    trust_mode: "serverless-peer",
    principal_id: `peer_${hex32(`peer:${name}`)}`,
    authority_origin: null,
    principal_public_key: b64u(`pk:${name}`, 32),
    proof: { kind: "local_principal_self_sig", principal_sig: b64u(`sig:${name}`, 64) },
    ...overrides,
  };
}

// A live serverless pairing (the writer cannot create one yet): `n` seeds every derived value.
export function serverlessPairing(n, localPrincipal, overrides = {}) {
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

export function makeRoot(prefix = "id-reg-v2w-") {
  const base = mkdtempSync(path.join(TMP_BASE, prefix));
  chmodSync(base, 0o700);
  return { base, root: path.join(base, "identity") };
}

// A v1 root built with the real writer: init, then one bind per name.
export function makeV1Root(names = ["gravity2", "ghost"]) {
  const { base, root } = makeRoot();
  updateIdentityRegistry({ root, expectedSequence: 0, now: T0, action: "init", subject: null, mutate: (r) => r });
  names.forEach((name, i) => {
    const b = agentBindingV1(name);
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

// The upgrade through the real writer, the way the D1.3 command will call it.
export function upgradeThroughWriter(root, { now = T1, faultHook = null } = {}) {
  const current = readIdentityRegistry({ root }).registry;
  return updateIdentityRegistry({
    root,
    expectedSequence: current.sequence,
    now,
    action: "upgrade",
    subject: null,
    mutate: (r) => upgradeRegistryV1ToV2(r),
    faultHook,
  });
}

export function readRaw(root) {
  return JSON.parse(readFileSync(path.join(root, REGISTRY_FILE_NAME), "utf8"));
}

export function snapshotFiles(root) {
  return {
    registry: readFileSync(path.join(root, REGISTRY_FILE_NAME)),
    audit: readFileSync(path.join(root, AUDIT_FILE_NAME)),
  };
}

export function auditLines(root) {
  return readFileSync(path.join(root, AUDIT_FILE_NAME), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function auditEntry({ sequence, at = T1, action, subject = null, bindingId = null, prevHash }) {
  const withoutHash = { sequence, at, action, subject, bindingId, prevHash };
  return { ...withoutHash, hash: createHash("sha256").update(canonicalJson(withoutHash), "utf8").digest("hex") };
}

// Hand-craft a committed step on a v2 root: audit line first, registry file second. For fixtures the real writer
// cannot yet produce (serverless records).
export function appendAndCommit(root, { action, subject = null, bindingId = null, at = T2, change = (r) => r }) {
  const current = readRaw(root);
  const entry = auditEntry({ sequence: current.sequence + 1, at, action, subject, bindingId, prevHash: current.auditHead.hash });
  appendFileSync(path.join(root, AUDIT_FILE_NAME), `${canonicalJson(entry)}\n`);
  const next = change({ ...current, sequence: entry.sequence, updatedAt: at, auditHead: { sequence: entry.sequence, hash: entry.hash } });
  const file = path.join(root, REGISTRY_FILE_NAME);
  writeFileSync(file, `${canonicalJson(next)}\n`);
  chmodSync(file, 0o600);
  return entry;
}
