/**
 * Host-Local Identity Registry Storage (Slice 1a Foundation).
 *
 * Implements:
 * - Closed-schema validation (`identity_registry_v1` with the reduced `local_profile_binding_v1`, and since D1.0 also
 *   `identity_registry_v2`; the reader accepts both. The writer creates v1 and converts it to v2 only through the
 *   `upgrade` action, D1.1)
 * - Deterministic canonical JSON serialization (`canonicalJson`)
 * - Safe private directory/file custody checks (reusing `delivery-private-path.mjs`)
 * - Exclusive SQLite advisory lock (`<root>/.registry.lock`) with bounded wait
 * - Atomic compare-and-set updates (`updateIdentityRegistry`)
 * - Append-only SHA-256 hash-chained audit log (`<root>/registry-audit.jsonl`)
 *
 * Limits (by design in this slice):
 * - Library-only; no default location resolution, no CLI, no network or process calls.
 * - The hash chain detects accidental or partial corruption and a partial rollback of one
 *   file, but is not signed and has no host installation key yet.
 * - No audit log rotation beyond the 8 MiB file limit.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { ancestors, privateDir, privateFile } from "./delivery-private-path.mjs";
import {
  AGENT_ID_PATTERN,
  deriveClientInstanceId,
  INSTANCE_ID_PATTERN,
  isValidBareHttpsOrigin,
  isValidProfileName,
  PEER_ID_PATTERN,
  SESSION_ID_PATTERN,
} from "./identity-primitives.mjs";

export const IDENTITY_REGISTRY_SCHEMA = "identity_registry_v1";
export const LOCAL_PROFILE_BINDING_SCHEMA = "local_profile_binding_v1";

export const REGISTRY_FILE_NAME = "identity-registry-v1.json";
export const AUDIT_FILE_NAME = "registry-audit.jsonl";
export const LOCK_FILE_NAME = ".registry.lock";

export const MAX_REGISTRY_BINDINGS = 1000;
export const MAX_REGISTRY_BYTES = 1024 * 1024; // 1 MiB
export const MAX_AUDIT_BYTES = 8 * 1024 * 1024; // 8 MiB
export const LOCK_TIMEOUT_MS = 5000;
export const READ_MAX_RETRIES = 5;
export const ZERO_HASH_64 = "0".repeat(64);

// Registry v2 (docs/plans/2026-11-07-identity-registry-v2-d1-plan.md). The reader accepts v1 and v2. The writer creates v1
// and converts it to v2 only through the `upgrade` action (D1.1); nothing in this module mints a peer_ id or verifies a signature.
export const IDENTITY_REGISTRY_SCHEMA_V2 = "identity_registry_v2";
export const LOCAL_PROFILE_BINDING_SCHEMA_V2 = "local_profile_binding_v2";
export const SERVERLESS_PAIRING_SCHEMA = "serverless_pairing_v1";
export const SUPPORTED_REGISTRY_SCHEMAS = Object.freeze([IDENTITY_REGISTRY_SCHEMA, IDENTITY_REGISTRY_SCHEMA_V2]);
export const MAX_REGISTRY_PAIRINGS = 256;
export const MAX_REGISTRY_ALIASES = 256;
export const MAX_REGISTRY_DESTINATIONS = 256;

const READ_RETRY_BACKOFF_MS = [2, 4, 8, 12, 20];
const TRANSIENT_AUDIT_REASONS = new Set([
  "audit_log_behind_registry",
  "audit_log_too_many_uncommitted_lines",
  "audit_log_missing",
  "audit_log_empty",
  "audit_line_truncated",
  "orphan_audit_log",
]);

const BINDING_ID_PATTERN = /^bind_[a-f0-9]{32}$/;
const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

const REGISTRY_TOP_KEYS = new Set([
  "schema",
  "sequence",
  "createdAt",
  "updatedAt",
  "auditHead",
  "bindings",
]);

const AUDIT_HEAD_KEYS = new Set(["sequence", "hash"]);

const BINDING_KEYS = new Set([
  "schema",
  "binding_id",
  "trust_mode",
  "principal_id",
  "profile_name",
  "profile_instance_id",
  "authority_origin",
  "binding_generation",
  "issued_at",
  "revoked_at",
  "proof",
]);

const PROOF_KEYS = new Set([
  "kind",
  "observed_on_disk",
  "verified_live_authority",
]);

const AUDIT_ENTRY_KEYS = new Set([
  "sequence",
  "at",
  "action",
  "subject",
  "bindingId",
  "prevHash",
  "hash",
]);

const AUDIT_ACTIONS = new Set(["init", "bind", "revoke"]);

// v2 knows every v1 action plus `upgrade` and the names reserved for later slices. Reserving them now means a v2 reader
// never meets an audit action it cannot parse, so a later feature does not force another compatibility cycle.
const AUDIT_ACTIONS_V2 = new Set([
  ...AUDIT_ACTIONS,
  "upgrade",
  "alias_set",
  "alias_clear",
  "destination_set",
  "destination_clear",
  "pair",
  "pair_update",
  "pair_revoke",
]);

// Audit action names that exist for later slices; the writer refuses them with `action_not_available`.
const RESERVED_AUDIT_ACTIONS = new Set(
  [...AUDIT_ACTIONS_V2].filter((name) => !AUDIT_ACTIONS.has(name) && name !== "upgrade"),
);

const PAIRING_ID_PATTERN = /^pair_[a-f0-9]{32}$/;
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const DESTINATION_HARNESSES = new Set(["claude", "codex"]);
const MAX_WORKSPACE_BYTES = 1024;
const MAX_REMOTE_ENDPOINTS = 8;

const REGISTRY_TOP_KEYS_V2 = new Set([...REGISTRY_TOP_KEYS, "pairings", "aliases", "destinations"]);
const BINDING_KEYS_V2 = new Set([...BINDING_KEYS, "principal_public_key"]);
const PROOF_KEYS_SELF_SIG = new Set(["kind", "principal_sig"]);
const PAIRING_KEYS = new Set([
  "schema",
  "pairing_id",
  "local_principal_id",
  "remote_principal_id",
  "remote_principal_public_key",
  "remote_endpoint_ids",
  "petname",
  "binding_generation",
  "issued_at",
  "expires_at",
  "remote_invitation_sig",
  "local_owner_approval_sig",
  "next_key_digest",
  "pending_rotation",
  "pending_endpoint_update",
  "revoked_at",
]);
// Pending approval state of a pairing (identity design section 6): a peer's key rotation or endpoint additions wait here until
// this host's owner approves them. The principal id and the old key are the pairing's own, so they are not repeated.
const PENDING_ROTATION_KEYS = new Set([
  "new_public_key",
  "binding_generation",
  "rotated_at",
  "sig_by_old_key",
  "sig_by_new_key",
  "next_key_digest",
]);
const PENDING_ENDPOINT_UPDATE_KEYS = new Set([
  "new_endpoint_ids",
  "binding_generation",
  "issued_at",
  "expires_at",
  "principal_sig",
]);
const ALIAS_KEYS = new Set(["principal_id", "set_at", "generation"]);
const DESTINATION_KEYS = new Set(["harness", "workspace", "set_at", "generation"]);

function codedError(code, reason) {
  const err = new Error(`${code}: ${reason}`);
  err.code = code;
  err.reason = reason;
  return err;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(obj, allowedSet) {
  const keys = Object.keys(obj);
  if (keys.length !== allowedSet.size) return false;
  for (const k of keys) {
    if (!allowedSet.has(k)) return false;
  }
  return true;
}

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Validates strict ISO-8601 UTC string (`YYYY-MM-DDTHH:MM:SS(.sss)Z`) with real calendar date/time.
 * Returns epoch milliseconds or null if invalid.
 */
function parseIsoUtc(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const m = ISO_UTC_PATTERN.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute ||
    d.getUTCSeconds() !== second
  ) {
    return null;
  }
  return ms;
}

function resolveNowIso(nowInput, errorCode = "invalid_registry") {
  let value = typeof nowInput === "function" ? nowInput() : nowInput;
  if (value === undefined) {
    return new Date().toISOString();
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      throw codedError(errorCode, "invalid_timestamp");
    }
    return value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw codedError(errorCode, "invalid_timestamp");
    }
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    if (parseIsoUtc(value) === null) {
      throw codedError(errorCode, "invalid_timestamp");
    }
    return value;
  }
  throw codedError(errorCode, "invalid_timestamp");
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function deepClonePlain(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepClonePlain);
  const out = {};
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    out[key] = deepClonePlain(value[key]);
  }
  return out;
}

/**
 * Deterministic canonical JSON serialization: sorted keys by UTF-16 code units, no whitespace.
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw codedError("invalid_registry", "non_finite_number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      throw codedError("invalid_registry", "ill_formed_string");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(compareCodeUnits);
    const parts = [];
    for (const k of keys) {
      if (!k.isWellFormed()) {
        throw codedError("invalid_registry", "ill_formed_key");
      }
      const v = value[k];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") {
        throw codedError("invalid_registry", "unsupported_value_type");
      }
      parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw codedError("invalid_registry", "unsupported_value_type");
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Creates an empty initial identity registry object (sequence 0).
 */
export function emptyIdentityRegistry({ now } = {}) {
  const ts = resolveNowIso(now, "invalid_registry");
  return validateIdentityRegistry({
    schema: IDENTITY_REGISTRY_SCHEMA,
    sequence: 0,
    createdAt: ts,
    updatedAt: ts,
    auditHead: {
      sequence: 0,
      hash: ZERO_HASH_64,
    },
    bindings: {},
  });
}

function validateBindingRecord(key, binding, seenBindingIds) {
  if (!isPlainObject(binding)) {
    throw codedError("invalid_registry", "binding_not_object");
  }
  for (const k of Object.keys(binding)) {
    if (!BINDING_KEYS.has(k)) {
      throw codedError("invalid_registry", "unknown_binding_key");
    }
  }
  if (!hasExactKeys(binding, BINDING_KEYS)) {
    throw codedError("invalid_registry", "missing_binding_key");
  }
  if (binding.schema !== LOCAL_PROFILE_BINDING_SCHEMA) {
    throw codedError("invalid_registry", "invalid_binding_schema");
  }
  if (typeof binding.binding_id !== "string" || !BINDING_ID_PATTERN.test(binding.binding_id)) {
    throw codedError("invalid_registry", "invalid_binding_id");
  }
  if (seenBindingIds.has(binding.binding_id)) {
    throw codedError("invalid_registry", "duplicate_binding_id");
  }
  seenBindingIds.add(binding.binding_id);

  if (binding.trust_mode !== "mesh-managed") {
    throw codedError("invalid_registry", "invalid_trust_mode");
  }
  if (typeof binding.principal_id !== "string" || !AGENT_ID_PATTERN.test(binding.principal_id)) {
    throw codedError("invalid_registry", "invalid_principal_id");
  }
  if (!isValidProfileName(binding.profile_name)) {
    throw codedError("invalid_registry", "invalid_profile_name");
  }
  if (
    typeof binding.profile_instance_id !== "string" ||
    !INSTANCE_ID_PATTERN.test(binding.profile_instance_id)
  ) {
    throw codedError("invalid_registry", "invalid_profile_instance_id");
  }
  const derivedInstanceId = deriveClientInstanceId(binding.profile_name);
  if (binding.profile_instance_id !== derivedInstanceId) {
    throw codedError("invalid_registry", "profile_instance_id_mismatch");
  }
  if (key !== binding.profile_instance_id) {
    throw codedError("invalid_registry", "binding_key_mismatch");
  }
  if (!isValidBareHttpsOrigin(binding.authority_origin)) {
    throw codedError("invalid_registry", "invalid_authority_origin");
  }
  if (
    typeof binding.binding_generation !== "number" ||
    !Number.isSafeInteger(binding.binding_generation) ||
    binding.binding_generation < 1
  ) {
    throw codedError("invalid_registry", "invalid_binding_generation");
  }
  const issuedMs = parseIsoUtc(binding.issued_at);
  if (issuedMs === null) {
    throw codedError("invalid_registry", "invalid_issued_at");
  }
  if (binding.revoked_at !== null) {
    const revokedMs = parseIsoUtc(binding.revoked_at);
    if (revokedMs === null) {
      throw codedError("invalid_registry", "invalid_revoked_at");
    }
    if (revokedMs < issuedMs) {
      throw codedError("invalid_registry", "revoked_before_issued");
    }
  }

  const proof = binding.proof;
  if (!isPlainObject(proof)) {
    throw codedError("invalid_registry", "invalid_proof");
  }
  for (const k of Object.keys(proof)) {
    if (!PROOF_KEYS.has(k)) {
      throw codedError("invalid_registry", "unknown_proof_key");
    }
  }
  if (!hasExactKeys(proof, PROOF_KEYS)) {
    throw codedError("invalid_registry", "missing_proof_key");
  }
  if (
    proof.kind !== "disk_observation" ||
    proof.observed_on_disk !== true ||
    proof.verified_live_authority !== false
  ) {
    throw codedError("invalid_registry", "invalid_proof_values");
  }

  return {
    schema: LOCAL_PROFILE_BINDING_SCHEMA,
    binding_id: binding.binding_id,
    trust_mode: "mesh-managed",
    principal_id: binding.principal_id,
    profile_name: binding.profile_name,
    profile_instance_id: binding.profile_instance_id,
    authority_origin: binding.authority_origin,
    binding_generation: binding.binding_generation,
    issued_at: binding.issued_at,
    revoked_at: binding.revoked_at,
    proof: {
      kind: "disk_observation",
      observed_on_disk: true,
      verified_live_authority: false,
    },
  };
}

/**
 * Validates an identity registry value against the closed `identity_registry_v1` schema.
 * Returns a deep-frozen copy on success, or throws a coded `invalid_registry` error
 * with a bounded reason (never echoing caller input).
 */
function validateIdentityRegistryV1(value) {
  if (!isPlainObject(value)) {
    throw codedError("invalid_registry", "registry_not_object");
  }
  for (const k of Object.keys(value)) {
    if (!REGISTRY_TOP_KEYS.has(k)) {
      throw codedError("invalid_registry", "unknown_registry_key");
    }
  }
  if (!hasExactKeys(value, REGISTRY_TOP_KEYS)) {
    throw codedError("invalid_registry", "missing_registry_key");
  }
  if (value.schema !== IDENTITY_REGISTRY_SCHEMA) {
    throw codedError("invalid_registry", "invalid_registry_schema");
  }
  if (
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0
  ) {
    throw codedError("invalid_registry", "invalid_sequence");
  }

  const createdMs = parseIsoUtc(value.createdAt);
  if (createdMs === null) {
    throw codedError("invalid_registry", "invalid_created_at");
  }
  const updatedMs = parseIsoUtc(value.updatedAt);
  if (updatedMs === null) {
    throw codedError("invalid_registry", "invalid_updated_at");
  }
  if (updatedMs < createdMs) {
    throw codedError("invalid_registry", "updated_before_created");
  }

  const auditHead = value.auditHead;
  if (!isPlainObject(auditHead)) {
    throw codedError("invalid_registry", "invalid_audit_head");
  }
  for (const k of Object.keys(auditHead)) {
    if (!AUDIT_HEAD_KEYS.has(k)) {
      throw codedError("invalid_registry", "unknown_audit_head_key");
    }
  }
  if (!hasExactKeys(auditHead, AUDIT_HEAD_KEYS)) {
    throw codedError("invalid_registry", "missing_audit_head_key");
  }
  if (
    typeof auditHead.sequence !== "number" ||
    !Number.isSafeInteger(auditHead.sequence) ||
    auditHead.sequence < 0 ||
    auditHead.sequence !== value.sequence
  ) {
    throw codedError("invalid_registry", "invalid_audit_head_sequence");
  }
  if (typeof auditHead.hash !== "string" || !HEX_64_PATTERN.test(auditHead.hash)) {
    throw codedError("invalid_registry", "invalid_audit_head_hash");
  }
  if (value.sequence === 0 && auditHead.hash !== ZERO_HASH_64) {
    throw codedError("invalid_registry", "invalid_zero_sequence_hash");
  }
  if (value.sequence > 0 && auditHead.hash === ZERO_HASH_64) {
    throw codedError("invalid_registry", "invalid_nonzero_sequence_hash");
  }

  const rawBindings = value.bindings;
  if (!isPlainObject(rawBindings)) {
    throw codedError("invalid_registry", "bindings_not_object");
  }
  const bindingKeys = Object.keys(rawBindings).sort(compareCodeUnits);
  if (bindingKeys.length > MAX_REGISTRY_BINDINGS) {
    throw codedError("invalid_registry", "too_many_bindings");
  }

  const seenBindingIds = new Set();
  const cleanBindings = {};
  for (const k of bindingKeys) {
    if (!INSTANCE_ID_PATTERN.test(k)) {
      throw codedError("invalid_registry", "invalid_binding_map_key");
    }
    cleanBindings[k] = validateBindingRecord(k, rawBindings[k], seenBindingIds);
  }

  const cleanRegistry = {
    schema: IDENTITY_REGISTRY_SCHEMA,
    sequence: value.sequence,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    auditHead: {
      sequence: auditHead.sequence,
      hash: auditHead.hash,
    },
    bindings: cleanBindings,
  };

  const serializedBytes = Buffer.byteLength(`${canonicalJson(cleanRegistry)}\n`, "utf8");
  if (serializedBytes > MAX_REGISTRY_BYTES) {
    throw codedError("invalid_registry", "registry_oversized");
  }

  return deepFreeze(cleanRegistry);
}

/* -------------------------------------------------------------------------------------------------
 * identity_registry_v2 (D1.0). Kept apart from the v1 validator above so the v1 path stays exactly as it was.
 * Shapes follow the identity design (4.1 bindings, 4.4 pairings) as decided in the D1 plan; nothing here
 * produces these records or verifies a signature. Cross-record rules are structural only.
 * ---------------------------------------------------------------------------------------------- */

// Canonical unpadded base64url of exactly `byteLength` bytes: one representation per value, no malleable tail bits.
function isCanonicalBase64Url(value, byteLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === byteLength && decoded.toString("base64url") === value;
}

function isValidWorkspacePath(value) {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) return false;
  if (Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_BYTES) return false;
  if (/[\p{Cc}\p{Cf}\\]/u.test(value)) return false;
  if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) return false;
  return value === "/" || !value.endsWith("/");
}

function isPrincipalId(value) {
  return typeof value === "string" && (AGENT_ID_PATTERN.test(value) || PEER_ID_PATTERN.test(value));
}

function validateBindingRecordV2(key, binding, seenBindingIds) {
  if (!isPlainObject(binding)) {
    throw codedError("invalid_registry", "binding_not_object");
  }
  for (const k of Object.keys(binding)) {
    if (!BINDING_KEYS_V2.has(k)) {
      throw codedError("invalid_registry", "unknown_binding_key");
    }
  }
  if (!hasExactKeys(binding, BINDING_KEYS_V2)) {
    throw codedError("invalid_registry", "missing_binding_key");
  }
  if (binding.schema !== LOCAL_PROFILE_BINDING_SCHEMA_V2) {
    throw codedError("invalid_registry", "invalid_binding_schema");
  }
  if (typeof binding.binding_id !== "string" || !BINDING_ID_PATTERN.test(binding.binding_id)) {
    throw codedError("invalid_registry", "invalid_binding_id");
  }
  if (seenBindingIds.has(binding.binding_id)) {
    throw codedError("invalid_registry", "duplicate_binding_id");
  }
  seenBindingIds.add(binding.binding_id);

  const mode = binding.trust_mode;
  if (mode !== "mesh-managed" && mode !== "serverless-peer") {
    throw codedError("invalid_registry", "invalid_trust_mode");
  }
  const pattern = mode === "mesh-managed" ? AGENT_ID_PATTERN : PEER_ID_PATTERN;
  if (typeof binding.principal_id !== "string" || !pattern.test(binding.principal_id)) {
    throw codedError("invalid_registry", "invalid_principal_id");
  }
  if (!isValidProfileName(binding.profile_name)) {
    throw codedError("invalid_registry", "invalid_profile_name");
  }
  if (
    typeof binding.profile_instance_id !== "string" ||
    !INSTANCE_ID_PATTERN.test(binding.profile_instance_id)
  ) {
    throw codedError("invalid_registry", "invalid_profile_instance_id");
  }
  if (binding.profile_instance_id !== deriveClientInstanceId(binding.profile_name)) {
    throw codedError("invalid_registry", "profile_instance_id_mismatch");
  }
  if (key !== binding.profile_instance_id) {
    throw codedError("invalid_registry", "binding_key_mismatch");
  }
  if (mode === "mesh-managed") {
    if (!isValidBareHttpsOrigin(binding.authority_origin)) {
      throw codedError("invalid_registry", "invalid_authority_origin");
    }
    if (binding.principal_public_key !== null) {
      throw codedError("invalid_registry", "invalid_principal_public_key");
    }
  } else {
    if (binding.authority_origin !== null) {
      throw codedError("invalid_registry", "invalid_authority_origin");
    }
    if (!isCanonicalBase64Url(binding.principal_public_key, 32)) {
      throw codedError("invalid_registry", "invalid_principal_public_key");
    }
  }
  if (
    typeof binding.binding_generation !== "number" ||
    !Number.isSafeInteger(binding.binding_generation) ||
    binding.binding_generation < 1
  ) {
    throw codedError("invalid_registry", "invalid_binding_generation");
  }
  const issuedMs = parseIsoUtc(binding.issued_at);
  if (issuedMs === null) {
    throw codedError("invalid_registry", "invalid_issued_at");
  }
  if (binding.revoked_at !== null) {
    const revokedMs = parseIsoUtc(binding.revoked_at);
    if (revokedMs === null) {
      throw codedError("invalid_registry", "invalid_revoked_at");
    }
    if (revokedMs < issuedMs) {
      throw codedError("invalid_registry", "revoked_before_issued");
    }
  }

  const proof = binding.proof;
  if (!isPlainObject(proof)) {
    throw codedError("invalid_registry", "invalid_proof");
  }
  const proofKeys = mode === "mesh-managed" ? PROOF_KEYS : PROOF_KEYS_SELF_SIG;
  for (const k of Object.keys(proof)) {
    if (!proofKeys.has(k)) {
      throw codedError("invalid_registry", "unknown_proof_key");
    }
  }
  if (!hasExactKeys(proof, proofKeys)) {
    throw codedError("invalid_registry", "missing_proof_key");
  }
  let cleanProof;
  if (mode === "mesh-managed") {
    if (
      proof.kind !== "disk_observation" ||
      proof.observed_on_disk !== true ||
      proof.verified_live_authority !== false
    ) {
      throw codedError("invalid_registry", "invalid_proof_values");
    }
    cleanProof = { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false };
  } else {
    if (proof.kind !== "local_principal_self_sig") {
      throw codedError("invalid_registry", "invalid_proof_values");
    }
    if (!isCanonicalBase64Url(proof.principal_sig, 64)) {
      throw codedError("invalid_registry", "invalid_principal_sig");
    }
    cleanProof = { kind: "local_principal_self_sig", principal_sig: proof.principal_sig };
  }

  return {
    schema: LOCAL_PROFILE_BINDING_SCHEMA_V2,
    binding_id: binding.binding_id,
    trust_mode: mode,
    principal_id: binding.principal_id,
    profile_name: binding.profile_name,
    profile_instance_id: binding.profile_instance_id,
    authority_origin: binding.authority_origin,
    principal_public_key: binding.principal_public_key,
    binding_generation: binding.binding_generation,
    issued_at: binding.issued_at,
    revoked_at: binding.revoked_at,
    proof: cleanProof,
  };
}

function validatePairingRecord(key, pairing) {
  if (!isPlainObject(pairing)) {
    throw codedError("invalid_registry", "pairing_not_object");
  }
  for (const k of Object.keys(pairing)) {
    if (!PAIRING_KEYS.has(k)) {
      throw codedError("invalid_registry", "unknown_pairing_key");
    }
  }
  if (!hasExactKeys(pairing, PAIRING_KEYS)) {
    throw codedError("invalid_registry", "missing_pairing_key");
  }
  if (pairing.schema !== SERVERLESS_PAIRING_SCHEMA) {
    throw codedError("invalid_registry", "invalid_pairing_schema");
  }
  if (typeof pairing.pairing_id !== "string" || !PAIRING_ID_PATTERN.test(pairing.pairing_id)) {
    throw codedError("invalid_registry", "invalid_pairing_id");
  }
  if (pairing.pairing_id !== key) {
    throw codedError("invalid_registry", "pairing_key_mismatch");
  }
  if (typeof pairing.local_principal_id !== "string" || !PEER_ID_PATTERN.test(pairing.local_principal_id)) {
    throw codedError("invalid_registry", "invalid_local_principal_id");
  }
  if (typeof pairing.remote_principal_id !== "string" || !PEER_ID_PATTERN.test(pairing.remote_principal_id)) {
    throw codedError("invalid_registry", "invalid_remote_principal_id");
  }
  if (pairing.local_principal_id === pairing.remote_principal_id) {
    throw codedError("invalid_registry", "pairing_self_reference");
  }
  if (!isCanonicalBase64Url(pairing.remote_principal_public_key, 32)) {
    throw codedError("invalid_registry", "invalid_remote_principal_public_key");
  }
  const endpoints = pairing.remote_endpoint_ids;
  if (!Array.isArray(endpoints) || endpoints.length < 1 || endpoints.length > MAX_REMOTE_ENDPOINTS) {
    throw codedError("invalid_registry", "invalid_remote_endpoint_ids");
  }
  for (let i = 0; i < endpoints.length; i++) {
    if (typeof endpoints[i] !== "string" || !INSTANCE_ID_PATTERN.test(endpoints[i])) {
      throw codedError("invalid_registry", "invalid_remote_endpoint_ids");
    }
    // One canonical form: strictly increasing, so there are no duplicates and no reordering.
    if (i > 0 && !(endpoints[i - 1] < endpoints[i])) {
      throw codedError("invalid_registry", "remote_endpoint_ids_not_sorted");
    }
  }
  // A petname is an owner-chosen label with the profile-name contract (non-empty, at most 64 bytes, no separators or control characters).
  if (!isValidProfileName(pairing.petname)) {
    throw codedError("invalid_registry", "invalid_petname");
  }
  if (
    typeof pairing.binding_generation !== "number" ||
    !Number.isSafeInteger(pairing.binding_generation) ||
    pairing.binding_generation < 1
  ) {
    throw codedError("invalid_registry", "invalid_binding_generation");
  }
  const issuedMs = parseIsoUtc(pairing.issued_at);
  if (issuedMs === null) {
    throw codedError("invalid_registry", "invalid_issued_at");
  }
  const expiresMs = parseIsoUtc(pairing.expires_at);
  if (expiresMs === null) {
    throw codedError("invalid_registry", "invalid_expires_at");
  }
  if (expiresMs <= issuedMs) {
    throw codedError("invalid_registry", "expires_not_after_issued");
  }
  if (pairing.revoked_at !== null) {
    const revokedMs = parseIsoUtc(pairing.revoked_at);
    if (revokedMs === null) {
      throw codedError("invalid_registry", "invalid_revoked_at");
    }
    if (revokedMs < issuedMs) {
      throw codedError("invalid_registry", "revoked_before_issued");
    }
  }
  if (!isCanonicalBase64Url(pairing.remote_invitation_sig, 64)) {
    throw codedError("invalid_registry", "invalid_remote_invitation_sig");
  }
  if (!isCanonicalBase64Url(pairing.local_owner_approval_sig, 64)) {
    throw codedError("invalid_registry", "invalid_local_owner_approval_sig");
  }
  if (pairing.next_key_digest !== null && (typeof pairing.next_key_digest !== "string" || !HEX_64_PATTERN.test(pairing.next_key_digest))) {
    throw codedError("invalid_registry", "invalid_next_key_digest");
  }
  const pendingRotation = validatePendingRotation(pairing);
  const pendingEndpointUpdate = validatePendingEndpointUpdate(pairing);
  return {
    schema: SERVERLESS_PAIRING_SCHEMA,
    pairing_id: pairing.pairing_id,
    local_principal_id: pairing.local_principal_id,
    remote_principal_id: pairing.remote_principal_id,
    remote_principal_public_key: pairing.remote_principal_public_key,
    remote_endpoint_ids: [...endpoints],
    petname: pairing.petname,
    binding_generation: pairing.binding_generation,
    issued_at: pairing.issued_at,
    expires_at: pairing.expires_at,
    remote_invitation_sig: pairing.remote_invitation_sig,
    local_owner_approval_sig: pairing.local_owner_approval_sig,
    next_key_digest: pairing.next_key_digest,
    pending_rotation: pendingRotation,
    pending_endpoint_update: pendingEndpointUpdate,
    revoked_at: pairing.revoked_at,
  };
}

function validatePendingRotation(pairing) {
  const rotation = pairing.pending_rotation;
  if (rotation === null) return null;
  if (!isPlainObject(rotation)) {
    throw codedError("invalid_registry", "invalid_pending_rotation");
  }
  for (const k of Object.keys(rotation)) {
    if (!PENDING_ROTATION_KEYS.has(k)) {
      throw codedError("invalid_registry", "unknown_pending_rotation_key");
    }
  }
  if (!hasExactKeys(rotation, PENDING_ROTATION_KEYS)) {
    throw codedError("invalid_registry", "missing_pending_rotation_key");
  }
  // The pinned key only moves through an approved rotation, so a pending one must offer a different key and a later generation.
  if (!isCanonicalBase64Url(rotation.new_public_key, 32) || rotation.new_public_key === pairing.remote_principal_public_key) {
    throw codedError("invalid_registry", "invalid_pending_rotation_key");
  }
  if (!Number.isSafeInteger(rotation.binding_generation) || rotation.binding_generation <= pairing.binding_generation) {
    throw codedError("invalid_registry", "invalid_pending_rotation_generation");
  }
  if (parseIsoUtc(rotation.rotated_at) === null) {
    throw codedError("invalid_registry", "invalid_pending_rotation_time");
  }
  if (!isCanonicalBase64Url(rotation.sig_by_old_key, 64) || !isCanonicalBase64Url(rotation.sig_by_new_key, 64)) {
    throw codedError("invalid_registry", "invalid_pending_rotation_signature");
  }
  if (rotation.next_key_digest !== null && (typeof rotation.next_key_digest !== "string" || !HEX_64_PATTERN.test(rotation.next_key_digest))) {
    throw codedError("invalid_registry", "invalid_pending_rotation_digest");
  }
  return {
    new_public_key: rotation.new_public_key,
    binding_generation: rotation.binding_generation,
    rotated_at: rotation.rotated_at,
    sig_by_old_key: rotation.sig_by_old_key,
    sig_by_new_key: rotation.sig_by_new_key,
    next_key_digest: rotation.next_key_digest,
  };
}

function validatePendingEndpointUpdate(pairing) {
  const update = pairing.pending_endpoint_update;
  if (update === null) return null;
  if (!isPlainObject(update)) {
    throw codedError("invalid_registry", "invalid_pending_endpoint_update");
  }
  for (const k of Object.keys(update)) {
    if (!PENDING_ENDPOINT_UPDATE_KEYS.has(k)) {
      throw codedError("invalid_registry", "unknown_pending_endpoint_update_key");
    }
  }
  if (!hasExactKeys(update, PENDING_ENDPOINT_UPDATE_KEYS)) {
    throw codedError("invalid_registry", "missing_pending_endpoint_update_key");
  }
  // Only additions wait for approval (removals apply at once), so none of these may already belong to the pairing.
  const ids = update.new_endpoint_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_REMOTE_ENDPOINTS) {
    throw codedError("invalid_registry", "invalid_pending_endpoint_ids");
  }
  for (let i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== "string" || !INSTANCE_ID_PATTERN.test(ids[i]) || pairing.remote_endpoint_ids.includes(ids[i])) {
      throw codedError("invalid_registry", "invalid_pending_endpoint_ids");
    }
    if (i > 0 && !(ids[i - 1] < ids[i])) {
      throw codedError("invalid_registry", "invalid_pending_endpoint_ids");
    }
  }
  if (!Number.isSafeInteger(update.binding_generation) || update.binding_generation <= pairing.binding_generation) {
    throw codedError("invalid_registry", "invalid_pending_endpoint_generation");
  }
  const issuedMs = parseIsoUtc(update.issued_at);
  const expiresMs = parseIsoUtc(update.expires_at);
  if (issuedMs === null || expiresMs === null || expiresMs <= issuedMs) {
    throw codedError("invalid_registry", "invalid_pending_endpoint_time");
  }
  if (!isCanonicalBase64Url(update.principal_sig, 64)) {
    throw codedError("invalid_registry", "invalid_pending_endpoint_signature");
  }
  return {
    new_endpoint_ids: [...ids],
    binding_generation: update.binding_generation,
    issued_at: update.issued_at,
    expires_at: update.expires_at,
    principal_sig: update.principal_sig,
  };
}

// No separate "looks like an id" checks: the pattern caps a name at 32 characters, and every id shape (agent_, peer_, session-,
// 64-hex) is longer than that, so none can match.
function validateAliasRecord(alias, record) {
  if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias)) {
    throw codedError("invalid_registry", "invalid_alias");
  }
  if (!isPlainObject(record)) {
    throw codedError("invalid_registry", "alias_not_object");
  }
  for (const k of Object.keys(record)) {
    if (!ALIAS_KEYS.has(k)) {
      throw codedError("invalid_registry", "unknown_alias_key");
    }
  }
  if (!hasExactKeys(record, ALIAS_KEYS)) {
    throw codedError("invalid_registry", "missing_alias_key");
  }
  if (!isPrincipalId(record.principal_id)) {
    throw codedError("invalid_registry", "invalid_alias_principal");
  }
  if (parseIsoUtc(record.set_at) === null) {
    throw codedError("invalid_registry", "invalid_alias_set_at");
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw codedError("invalid_registry", "invalid_alias_generation");
  }
  return { principal_id: record.principal_id, set_at: record.set_at, generation: record.generation };
}

function validateDestinationRecord(principalId, record) {
  if (!isPrincipalId(principalId)) {
    throw codedError("invalid_registry", "invalid_destination_principal");
  }
  if (!isPlainObject(record)) {
    throw codedError("invalid_registry", "destination_not_object");
  }
  for (const k of Object.keys(record)) {
    if (!DESTINATION_KEYS.has(k)) {
      throw codedError("invalid_registry", "unknown_destination_key");
    }
  }
  if (!hasExactKeys(record, DESTINATION_KEYS)) {
    throw codedError("invalid_registry", "missing_destination_key");
  }
  if (!DESTINATION_HARNESSES.has(record.harness)) {
    throw codedError("invalid_registry", "invalid_destination_harness");
  }
  if (!isValidWorkspacePath(record.workspace)) {
    throw codedError("invalid_registry", "invalid_destination_workspace");
  }
  if (parseIsoUtc(record.set_at) === null) {
    throw codedError("invalid_registry", "invalid_destination_set_at");
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw codedError("invalid_registry", "invalid_destination_generation");
  }
  return { harness: record.harness, workspace: record.workspace, set_at: record.set_at, generation: record.generation };
}

function validateIdentityRegistryV2(value) {
  if (!isPlainObject(value)) {
    throw codedError("invalid_registry", "registry_not_object");
  }
  for (const k of Object.keys(value)) {
    if (!REGISTRY_TOP_KEYS_V2.has(k)) {
      throw codedError("invalid_registry", "unknown_registry_key");
    }
  }
  if (!hasExactKeys(value, REGISTRY_TOP_KEYS_V2)) {
    throw codedError("invalid_registry", "missing_registry_key");
  }
  if (value.schema !== IDENTITY_REGISTRY_SCHEMA_V2) {
    throw codedError("invalid_registry", "invalid_registry_schema");
  }
  if (
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0
  ) {
    throw codedError("invalid_registry", "invalid_sequence");
  }
  const createdMs = parseIsoUtc(value.createdAt);
  if (createdMs === null) {
    throw codedError("invalid_registry", "invalid_created_at");
  }
  const updatedMs = parseIsoUtc(value.updatedAt);
  if (updatedMs === null) {
    throw codedError("invalid_registry", "invalid_updated_at");
  }
  if (updatedMs < createdMs) {
    throw codedError("invalid_registry", "updated_before_created");
  }
  const auditHead = value.auditHead;
  if (!isPlainObject(auditHead)) {
    throw codedError("invalid_registry", "invalid_audit_head");
  }
  for (const k of Object.keys(auditHead)) {
    if (!AUDIT_HEAD_KEYS.has(k)) {
      throw codedError("invalid_registry", "unknown_audit_head_key");
    }
  }
  if (!hasExactKeys(auditHead, AUDIT_HEAD_KEYS)) {
    throw codedError("invalid_registry", "missing_audit_head_key");
  }
  if (
    typeof auditHead.sequence !== "number" ||
    !Number.isSafeInteger(auditHead.sequence) ||
    auditHead.sequence < 0 ||
    auditHead.sequence !== value.sequence
  ) {
    throw codedError("invalid_registry", "invalid_audit_head_sequence");
  }
  if (typeof auditHead.hash !== "string" || !HEX_64_PATTERN.test(auditHead.hash)) {
    throw codedError("invalid_registry", "invalid_audit_head_hash");
  }
  if (value.sequence === 0 && auditHead.hash !== ZERO_HASH_64) {
    throw codedError("invalid_registry", "invalid_zero_sequence_hash");
  }
  if (value.sequence > 0 && auditHead.hash === ZERO_HASH_64) {
    throw codedError("invalid_registry", "invalid_nonzero_sequence_hash");
  }

  // Bindings.
  if (!isPlainObject(value.bindings)) {
    throw codedError("invalid_registry", "bindings_not_object");
  }
  const bindingKeys = Object.keys(value.bindings).sort(compareCodeUnits);
  if (bindingKeys.length > MAX_REGISTRY_BINDINGS) {
    throw codedError("invalid_registry", "too_many_bindings");
  }
  const seenBindingIds = new Set();
  const cleanBindings = {};
  const localPrincipals = new Set(); // principals of every binding, revoked or not
  const serverlessPrincipals = new Set();
  const livePeerKeys = new Map(); // peer principal_id -> principal_public_key
  const liveServerlessPrincipals = new Set(); // live serverless principal_ids
  for (const k of bindingKeys) {
    if (!INSTANCE_ID_PATTERN.test(k)) {
      throw codedError("invalid_registry", "invalid_binding_map_key");
    }
    const clean = validateBindingRecordV2(k, value.bindings[k], seenBindingIds);
    cleanBindings[k] = clean;
    localPrincipals.add(clean.principal_id);
    if (clean.trust_mode === "serverless-peer") {
      serverlessPrincipals.add(clean.principal_id);
      if (clean.revoked_at === null) {
        if (liveServerlessPrincipals.has(clean.principal_id)) {
          throw codedError("invalid_registry", "duplicate_serverless_principal");
        }
        liveServerlessPrincipals.add(clean.principal_id);
        livePeerKeys.set(clean.principal_id, clean.principal_public_key);
      }
    }
  }

  // Pairings.
  if (!isPlainObject(value.pairings)) {
    throw codedError("invalid_registry", "pairings_not_object");
  }
  const pairingKeys = Object.keys(value.pairings).sort(compareCodeUnits);
  if (pairingKeys.length > MAX_REGISTRY_PAIRINGS) {
    throw codedError("invalid_registry", "too_many_pairings");
  }
  const cleanPairings = {};
  const knownPrincipals = new Set(localPrincipals); // addressable by an alias: local principals and remote paired ones
  const livePairs = new Set();
  const livePetnames = new Set();
  const liveEndpoints = new Map(); // endpoint_id -> remote_principal_id
  for (const k of pairingKeys) {
    const clean = validatePairingRecord(k, value.pairings[k]);
    if (!serverlessPrincipals.has(clean.local_principal_id)) {
      throw codedError("invalid_registry", "pairing_local_principal_unbound");
    }
    if (clean.revoked_at === null) {
      const pairKey = `${clean.local_principal_id}|${clean.remote_principal_id}`;
      if (livePairs.has(pairKey)) {
        throw codedError("invalid_registry", "duplicate_pairing");
      }
      livePairs.add(pairKey);
      const nameKey = `${clean.local_principal_id}|${clean.petname}`;
      if (livePetnames.has(nameKey)) {
        throw codedError("invalid_registry", "duplicate_petname");
      }
      livePetnames.add(nameKey);
      const existingKey = livePeerKeys.get(clean.remote_principal_id);
      if (existingKey !== undefined && existingKey !== clean.remote_principal_public_key) {
        throw codedError("invalid_registry", "peer_key_conflict");
      }
      livePeerKeys.set(clean.remote_principal_id, clean.remote_principal_public_key);
      for (const endpointId of clean.remote_endpoint_ids) {
        const ownerRemote = liveEndpoints.get(endpointId);
        if (ownerRemote !== undefined && ownerRemote !== clean.remote_principal_id) {
          throw codedError("invalid_registry", "duplicate_endpoint_id");
        }
        liveEndpoints.set(endpointId, clean.remote_principal_id);
      }
    }
    knownPrincipals.add(clean.remote_principal_id);
    cleanPairings[k] = clean;
  }

  // Aliases.
  if (!isPlainObject(value.aliases)) {
    throw codedError("invalid_registry", "aliases_not_object");
  }
  const aliasKeys = Object.keys(value.aliases).sort(compareCodeUnits);
  if (aliasKeys.length > MAX_REGISTRY_ALIASES) {
    throw codedError("invalid_registry", "too_many_aliases");
  }
  const cleanAliases = {};
  for (const k of aliasKeys) {
    const clean = validateAliasRecord(k, value.aliases[k]);
    if (!knownPrincipals.has(clean.principal_id)) {
      throw codedError("invalid_registry", "alias_target_unknown");
    }
    cleanAliases[k] = clean;
  }

  // Destination rules: keyed by a principal bound in this registry (the receiving identity), one rule each.
  if (!isPlainObject(value.destinations)) {
    throw codedError("invalid_registry", "destinations_not_object");
  }
  const destinationKeys = Object.keys(value.destinations).sort(compareCodeUnits);
  if (destinationKeys.length > MAX_REGISTRY_DESTINATIONS) {
    throw codedError("invalid_registry", "too_many_destinations");
  }
  const cleanDestinations = {};
  for (const k of destinationKeys) {
    const clean = validateDestinationRecord(k, value.destinations[k]);
    if (!localPrincipals.has(k)) {
      throw codedError("invalid_registry", "destination_principal_unbound");
    }
    cleanDestinations[k] = clean;
  }

  const cleanRegistry = {
    schema: IDENTITY_REGISTRY_SCHEMA_V2,
    sequence: value.sequence,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    auditHead: {
      sequence: auditHead.sequence,
      hash: auditHead.hash,
    },
    bindings: cleanBindings,
    pairings: cleanPairings,
    aliases: cleanAliases,
    destinations: cleanDestinations,
  };
  const serializedBytes = Buffer.byteLength(`${canonicalJson(cleanRegistry)}\n`, "utf8");
  if (serializedBytes > MAX_REGISTRY_BYTES) {
    throw codedError("invalid_registry", "registry_oversized");
  }
  return deepFreeze(cleanRegistry);
}

/**
 * Validates an identity registry value against the closed `identity_registry_v1` or `identity_registry_v2` schema,
 * chosen by its `schema` field. Any other value is refused exactly as before (`invalid_registry_schema`).
 */
export function validateIdentityRegistry(value) {
  if (isPlainObject(value) && value.schema === IDENTITY_REGISTRY_SCHEMA_V2) {
    return validateIdentityRegistryV2(value);
  }
  return validateIdentityRegistryV1(value);
}

/**
 * Pure conversion of a valid v1 registry into its v2 form: every binding gains `principal_public_key: null`
 * and the new collections start empty. Sequence, timestamps and the audit head are left alone; the writer (D1.1)
 * advances them together with the audit entry. Input is never mutated, and the result is validated.
 */
export function upgradeRegistryV1ToV2(registry) {
  const v1 = validateIdentityRegistry(registry);
  if (v1.schema !== IDENTITY_REGISTRY_SCHEMA) {
    throw codedError("invalid_registry", "upgrade_requires_v1");
  }
  const plain = deepClonePlain(v1);
  const bindings = {};
  for (const [instanceId, binding] of Object.entries(plain.bindings)) {
    bindings[instanceId] = {
      ...binding,
      schema: LOCAL_PROFILE_BINDING_SCHEMA_V2,
      principal_public_key: null,
    };
  }
  return validateIdentityRegistry({
    ...plain,
    schema: IDENTITY_REGISTRY_SCHEMA_V2,
    bindings,
    pairings: {},
    aliases: {},
    destinations: {},
  });
}

/**
 * Validates and computes the hash of an audit log entry.
 */
function buildAuditEntry({ sequence, at, action, subject, bindingId, prevHash }) {
  const withoutHash = {
    sequence,
    at,
    action,
    subject,
    bindingId,
    prevHash,
  };
  const hash = sha256Hex(canonicalJson(withoutHash));
  return deepFreeze({
    ...withoutHash,
    hash,
  });
}

// Fields of the audit actions that only v2 knows. Every one of them is subject-bearing except `upgrade`; none carries a binding id.
function validateV2AuditFields(entry) {
  if (entry.bindingId !== null) {
    throw codedError("registry_chain_broken", "invalid_audit_binding_id");
  }
  if (entry.action === "upgrade") {
    if (entry.subject !== null) {
      throw codedError("registry_chain_broken", "invalid_upgrade_audit_fields");
    }
    return;
  }
  let subjectOk = false;
  if (typeof entry.subject === "string") {
    if (entry.action === "alias_set" || entry.action === "alias_clear") {
      subjectOk = ALIAS_PATTERN.test(entry.subject);
    } else if (entry.action === "destination_set" || entry.action === "destination_clear") {
      subjectOk = isPrincipalId(entry.subject);
    } else {
      subjectOk = PAIRING_ID_PATTERN.test(entry.subject); // pair, pair_update, pair_revoke
    }
  }
  if (!subjectOk) {
    throw codedError("registry_chain_broken", "invalid_audit_subject");
  }
}

// `schema` is the schema of the registry the entry belongs to. A v1 registry's log may end in an uncommitted `upgrade`
// (`tail`): the audit line is appended before the registry file is replaced, so a crash in between leaves exactly that.
function validateAuditEntryObject(entry, { schema = IDENTITY_REGISTRY_SCHEMA, tail = false } = {}) {
  if (!isPlainObject(entry)) {
    throw codedError("registry_chain_broken", "audit_entry_not_object");
  }
  for (const k of Object.keys(entry)) {
    if (!AUDIT_ENTRY_KEYS.has(k)) {
      throw codedError("registry_chain_broken", "unknown_audit_entry_key");
    }
  }
  if (!hasExactKeys(entry, AUDIT_ENTRY_KEYS)) {
    throw codedError("registry_chain_broken", "missing_audit_entry_key");
  }
  if (
    typeof entry.sequence !== "number" ||
    !Number.isSafeInteger(entry.sequence) ||
    entry.sequence < 1
  ) {
    throw codedError("registry_chain_broken", "invalid_audit_sequence");
  }
  if (parseIsoUtc(entry.at) === null) {
    throw codedError("registry_chain_broken", "invalid_audit_timestamp");
  }
  if (tail) {
    if (schema === IDENTITY_REGISTRY_SCHEMA_V2 && entry.action === "upgrade") {
      throw codedError("registry_chain_broken", "invalid_audit_action");
    }
    if (!AUDIT_ACTIONS_V2.has(entry.action)) {
      throw codedError("registry_chain_broken", "invalid_audit_action");
    }
  } else {
    const allowedActions = schema === IDENTITY_REGISTRY_SCHEMA_V2 ? AUDIT_ACTIONS_V2 : AUDIT_ACTIONS;
    if (!allowedActions.has(entry.action)) {
      throw codedError("registry_chain_broken", "invalid_audit_action");
    }
  }
  if (!AUDIT_ACTIONS.has(entry.action)) {
    validateV2AuditFields(entry);
  } else {
    if (entry.subject !== null && (typeof entry.subject !== "string" || !INSTANCE_ID_PATTERN.test(entry.subject))) {
      throw codedError("registry_chain_broken", "invalid_audit_subject");
    }
    if (entry.bindingId !== null && (typeof entry.bindingId !== "string" || !BINDING_ID_PATTERN.test(entry.bindingId))) {
      throw codedError("registry_chain_broken", "invalid_audit_binding_id");
    }
    if (entry.action === "init") {
      if (entry.subject !== null || entry.bindingId !== null) {
        throw codedError("registry_chain_broken", "invalid_init_audit_fields");
      }
    } else if (entry.subject === null || entry.bindingId === null) {
      throw codedError("registry_chain_broken", "missing_audit_subject_or_binding");
    }
  }
  if (typeof entry.prevHash !== "string" || !HEX_64_PATTERN.test(entry.prevHash)) {
    throw codedError("registry_chain_broken", "invalid_audit_prev_hash");
  }
  if (typeof entry.hash !== "string" || !HEX_64_PATTERN.test(entry.hash)) {
    throw codedError("registry_chain_broken", "invalid_audit_hash");
  }

  const withoutHash = {
    sequence: entry.sequence,
    at: entry.at,
    action: entry.action,
    subject: entry.subject,
    bindingId: entry.bindingId,
    prevHash: entry.prevHash,
  };
  const expectedHash = sha256Hex(canonicalJson(withoutHash));
  if (entry.hash !== expectedHash) {
    throw codedError("registry_chain_broken", "audit_hash_mismatch");
  }
}

function syncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF", "ENOENT"].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertRootPathSyntax(root) {
  if (typeof root !== "string" || root.length === 0 || !path.isAbsolute(root) || path.resolve(root) !== root) {
    throw codedError("registry_unsafe", "invalid_root_path");
  }
}

function checkSafeExistingRoot(root) {
  assertRootPathSyntax(root);
  try {
    ancestors(root);
  } catch {
    throw codedError("registry_unsafe", "unsafe_ancestor");
  }
  const st = lstatSync(root, { throwIfNoEntry: false });
  if (!st) return false;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw codedError("registry_unsafe", "root_not_directory");
  }
  try {
    if (realpathSync(root) !== root) {
      throw codedError("registry_unsafe", "root_not_canonical");
    }
  } catch (err) {
    if (err?.code === "registry_unsafe") throw err;
    throw codedError("registry_unsafe", "root_realpath_failed");
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw codedError("registry_unsafe", "root_wrong_owner");
  }
  if ((st.mode & 0o777) !== 0o700) {
    throw codedError("registry_unsafe", "root_wrong_mode");
  }
  try {
    privateDir(root, { create: false });
  } catch {
    throw codedError("registry_unsafe", "unsafe_root_directory");
  }
  return true;
}

function ensureSafeRootForWrite(root) {
  assertRootPathSyntax(root);
  try {
    ancestors(path.dirname(root));
  } catch {
    throw codedError("registry_unsafe", "unsafe_ancestor");
  }
  const st = lstatSync(root, { throwIfNoEntry: false });
  if (!st) {
    try {
      mkdirSync(root, { mode: 0o700 });
      syncDir(path.dirname(root));
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw codedError("registry_unsafe", "root_mkdir_failed");
      }
    }
  }
  checkSafeExistingRoot(root);
}

function hookLstatSync(filePath, fsHooks) {
  if (fsHooks && typeof fsHooks.lstatSync === "function") {
    return fsHooks.lstatSync(filePath, { throwIfNoEntry: false }, lstatSync);
  }
  return lstatSync(filePath, { throwIfNoEntry: false });
}

function hookOpenSync(filePath, flags, mode, fsHooks) {
  if (fsHooks && typeof fsHooks.openSync === "function") {
    const custom = fsHooks.openSync(filePath, flags, mode, openSync);
    if (custom !== undefined) return custom;
  }
  return openSync(filePath, flags, mode);
}

function hookFstatSync(fd, filePath, fsHooks) {
  if (fsHooks && typeof fsHooks.fstatSync === "function") {
    return fsHooks.fstatSync(fd, filePath, fstatSync);
  }
  return fstatSync(fd);
}

function hookReadFileSync(fd, filePath, fsHooks) {
  if (fsHooks && typeof fsHooks.readFileSync === "function") {
    return fsHooks.readFileSync(fd, filePath, readFileSync);
  }
  return readFileSync(fd);
}

/**
 * Checks a path's stat when not opening a descriptor (e.g., directory scan or lock check).
 * Treats `nlink === 0` or missing entry as vanished (`null`), never unsafe.
 */
function assertSafeFileStat(filePath, fsHooks = null) {
  let st;
  try {
    st = hookLstatSync(filePath, fsHooks);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw codedError("registry_unsafe", "unsafe_file");
  }
  if (!st || (!st.isSymbolicLink() && st.nlink === 0)) {
    return null;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    throw codedError("registry_unsafe", "unsafe_file_type_or_links");
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw codedError("registry_unsafe", "file_wrong_owner");
  }
  if ((st.mode & 0o777) !== 0o600) {
    throw codedError("registry_unsafe", "file_wrong_mode");
  }
  if (!fsHooks) {
    try {
      privateFile(filePath);
    } catch {
      const retrySt = lstatSync(filePath, { throwIfNoEntry: false });
      if (!retrySt || (!retrySt.isSymbolicLink() && retrySt.nlink === 0)) {
        return null;
      }
      throw codedError("registry_unsafe", "unsafe_file");
    }
  }
  return st;
}

/**
 * Checks the transient SQLite rollback journal `.registry.lock-journal`:
 * tolerates present, absent, or `nlink === 0`, while still rejecting symlinks,
 * non-regular files, wrong owner, or group/other permission bits.
 */
function checkTransientLockJournal(journalPath, fsHooks = null) {
  let st;
  try {
    st = hookLstatSync(journalPath, fsHooks);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw codedError("registry_unsafe", "unsafe_lock_journal");
  }
  if (!st || (!st.isSymbolicLink() && st.nlink === 0)) {
    return;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
    throw codedError("registry_unsafe", "unsafe_file_type_or_links");
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw codedError("registry_unsafe", "file_wrong_owner");
  }
  if ((st.mode & 0o077) !== 0) {
    throw codedError("registry_unsafe", "file_wrong_mode");
  }
}

function verifyRootEntriesCustody(root, fsHooks = null) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    throw codedError("registry_unsafe", "root_unreadable");
  }
  const lockJournalName = `${LOCK_FILE_NAME}-journal`;
  for (const name of names) {
    const full = path.join(root, name);
    // Ignore leftover or active atomic temp files during read, rejecting only symlinks/non-files
    if (name.startsWith(`${REGISTRY_FILE_NAME}.tmp-`)) {
      const tmpStat = hookLstatSync(full, fsHooks);
      if (tmpStat && (tmpStat.isSymbolicLink() || !tmpStat.isFile())) {
        throw codedError("registry_unsafe", "unsafe_temp_entry");
      }
      continue;
    }
    // Tolerate transient SQLite lock journal (present, absent, or nlink 0)
    if (name === lockJournalName) {
      checkTransientLockJournal(full, fsHooks);
      continue;
    }
    // Registry and audit files are verified on their open descriptors in readNoFollowBuffer;
    // still check any other file (such as .registry.lock) with nlink 0 treated as vanished.
    if (name === REGISTRY_FILE_NAME || name === AUDIT_FILE_NAME) {
      continue;
    }
    assertSafeFileStat(full, fsHooks);
  }
}

/**
 * Opens `filePath` first with `O_NOFOLLOW`, validates custody (regular file, owner,
 * mode 0600, `nlink === 1`) on `fstatSync(fd)` of that open descriptor, and reads
 * from the same descriptor so a concurrent rename cannot swap what was checked.
 * `O_NONBLOCK` keeps `open` from blocking on a FIFO planted at the path; the descriptor
 * check then rejects it as a non-regular file.
 * Returns `{ status: "ok", buffer }`, `{ status: "absent" }`, or `{ status: "vanished" }`
 * (when the opened descriptor has `nlink === 0` because a writer unlinked/replaced it).
 */
function readNoFollowDescriptor(filePath, maxBytes, oversizeCode, oversizeReason, fsHooks = null) {
  const openFlags =
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd;
  try {
    fd = hookOpenSync(filePath, openFlags, undefined, fsHooks);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { status: "absent", buffer: null };
    }
    // On macOS/POSIX, O_NOFOLLOW on a symlink yields ELOOP (or EFTYPE on some BSDs)
    if (err?.code === "ELOOP" || err?.code === "EFTYPE") {
      throw codedError("registry_unsafe", "unsafe_file_type_or_links");
    }
    throw codedError("registry_unsafe", "file_open_failed");
  }

  try {
    const st = hookFstatSync(fd, filePath, fsHooks);
    if (!st.isFile() || st.isSymbolicLink()) {
      throw codedError("registry_unsafe", "unsafe_file_type_or_links");
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw codedError("registry_unsafe", "file_wrong_owner");
    }
    if ((st.mode & 0o777) !== 0o600) {
      throw codedError("registry_unsafe", "file_wrong_mode");
    }
    if (st.nlink === 0) {
      return { status: "vanished", buffer: null };
    }
    if (st.nlink !== 1) {
      throw codedError("registry_unsafe", "unsafe_file_type_or_links");
    }
    if (st.size > maxBytes) {
      throw codedError(oversizeCode, oversizeReason);
    }
    const buf = hookReadFileSync(fd, filePath, fsHooks);
    if (buf.length > maxBytes) {
      throw codedError(oversizeCode, oversizeReason);
    }
    return { status: "ok", buffer: buf };
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

function parseAndVerifyAuditLog(auditBuf, expectedHead, schema = IDENTITY_REGISTRY_SCHEMA) {
  if (auditBuf === null) {
    if (expectedHead === null) {
      // Registry file absent, audit file absent -> absent state
      return { entries: [], uncommittedTail: 0, verifiedThrough: 0, committedByteLength: 0 };
    }
    if (expectedHead.sequence === 0 && expectedHead.hash === ZERO_HASH_64) {
      return { entries: [], uncommittedTail: 0, verifiedThrough: 0, committedByteLength: 0 };
    }
    throw codedError("registry_chain_broken", "audit_log_missing");
  }

  const text = auditBuf.toString("utf8");
  if (text.length === 0) {
    if (expectedHead === null) {
      return { entries: [], uncommittedTail: 0, verifiedThrough: 0, committedByteLength: 0 };
    }
    if (expectedHead.sequence === 0 && expectedHead.hash === ZERO_HASH_64) {
      return { entries: [], uncommittedTail: 0, verifiedThrough: 0, committedByteLength: 0 };
    }
    throw codedError("registry_chain_broken", "audit_log_empty");
  }

  const hasTornTrailingLine = !text.endsWith("\n");
  let rawLines;
  if (hasTornTrailingLine) {
    const parts = text.split("\n");
    parts.pop(); // discard the incomplete trailing fragment after the last \n
    rawLines = parts;
  } else {
    rawLines = text.slice(0, -1).split("\n");
  }

  const entries = [];
  let prevHash = ZERO_HASH_64;
  let byteOffset = 0;
  let committedByteLength = 0;
  let upgradeEntries = 0;
  let seenV2OnlyAction = false;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.length === 0) {
      throw codedError("registry_chain_broken", "empty_audit_line");
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw codedError("registry_chain_broken", "invalid_audit_json");
    }
    validateAuditEntryObject(parsed, { schema, tail: expectedHead !== null && i + 1 > expectedHead.sequence });
    const expectedSeq = i + 1;
    if (parsed.sequence !== expectedSeq) {
      throw codedError("registry_chain_broken", "audit_sequence_gap_or_reorder");
    }
    if (parsed.prevHash !== prevHash) {
      throw codedError("registry_chain_broken", "audit_prev_hash_mismatch");
    }
    if (expectedSeq === 1) {
      if (parsed.action !== "init" && parsed.action !== "bind") {
        throw codedError("registry_chain_broken", "invalid_first_audit_action");
      }
    } else if (parsed.action === "init") {
      throw codedError("registry_chain_broken", "unexpected_init_audit_action");
    }
    if (!AUDIT_ACTIONS.has(parsed.action) && parsed.action !== "upgrade") {
      seenV2OnlyAction = true;
    }
    if (parsed.action === "upgrade") {
      if (seenV2OnlyAction) {
        throw codedError("registry_chain_broken", "upgrade_after_v2_action");
      }
      upgradeEntries += 1;
      if (upgradeEntries > 1) {
        throw codedError("registry_chain_broken", "duplicate_upgrade_audit_action");
      }
    }
    prevHash = parsed.hash;
    entries.push(parsed);
    byteOffset += Buffer.byteLength(line, "utf8") + 1;
    if (expectedHead && parsed.sequence === expectedHead.sequence) {
      committedByteLength = byteOffset;
    }
  }

  if (expectedHead === null) {
    // Registry file is absent, but audit file exists!
    // Crash after step 1 (first audit append) and before step 2 (first registry write)
    // leaves either a single torn trailing fragment (0 complete lines) or 1 complete line (no torn fragment).
    if (hasTornTrailingLine && entries.length === 0) {
      return {
        entries: [],
        uncommittedTail: 1,
        verifiedThrough: 0,
        committedByteLength: 0,
      };
    }
    if (
      !hasTornTrailingLine &&
      entries.length === 1 &&
      entries[0].sequence === 1 &&
      (entries[0].action === "init" || entries[0].action === "bind")
    ) {
      return {
        entries,
        uncommittedTail: 1,
        verifiedThrough: 0,
        committedByteLength: 0,
      };
    }
    throw codedError("registry_chain_broken", "orphan_audit_log");
  }

  if (expectedHead.sequence === 0) {
    const uncommittedCount = entries.length + (hasTornTrailingLine ? 1 : 0);
    if (uncommittedCount === 0) {
      return { entries: [], uncommittedTail: 0, verifiedThrough: 0, committedByteLength: 0 };
    }
    if (uncommittedCount === 1) {
      return { entries, uncommittedTail: 1, verifiedThrough: 0, committedByteLength: 0 };
    }
    throw codedError("registry_chain_broken", "unexpected_audit_entries_for_seq_zero");
  }

  if (entries.length < expectedHead.sequence) {
    if (hasTornTrailingLine && entries.length === expectedHead.sequence - 1) {
      throw codedError("registry_chain_broken", "audit_line_truncated");
    }
    throw codedError("registry_chain_broken", "audit_log_behind_registry");
  }

  const uncommittedTail = (entries.length - expectedHead.sequence) + (hasTornTrailingLine ? 1 : 0);
  if (uncommittedTail > 1) {
    throw codedError("registry_chain_broken", "audit_log_too_many_uncommitted_lines");
  }

  const headEntry = entries[expectedHead.sequence - 1];
  if (!headEntry || headEntry.hash !== expectedHead.hash) {
    throw codedError("registry_chain_broken", "audit_head_hash_mismatch");
  }

  return {
    entries,
    uncommittedTail,
    verifiedThrough: expectedHead.sequence,
    committedByteLength,
  };
}

function readAndVerifyUnlocked(root, fsHooks = null) {
  const exists = checkSafeExistingRoot(root);
  if (!exists) {
    return {
      state: "absent",
      internal: {
        auditEntries: [],
        committedByteLength: 0,
        uncommittedTail: 0,
      },
    };
  }

  verifyRootEntriesCustody(root, fsHooks);

  const registryPath = path.join(root, REGISTRY_FILE_NAME);
  const auditPath = path.join(root, AUDIT_FILE_NAME);

  const regRes = readNoFollowDescriptor(
    registryPath,
    MAX_REGISTRY_BYTES,
    "registry_corrupt",
    "registry_oversized",
    fsHooks,
  );
  if (regRes.status === "vanished") {
    const err = codedError("registry_chain_broken", "file_vanished_during_read");
    err.transientRace = true;
    throw err;
  }

  // Read audit file up to MAX_AUDIT_BYTES + 1 MiB to parse and verify existing chain
  const auditRes = readNoFollowDescriptor(
    auditPath,
    MAX_AUDIT_BYTES + 1024 * 1024,
    "registry_corrupt",
    "audit_oversized",
    fsHooks,
  );
  if (auditRes.status === "vanished") {
    const err = codedError("registry_chain_broken", "file_vanished_during_read");
    err.transientRace = true;
    throw err;
  }

  const regBuf = regRes.buffer;
  const auditBuf = auditRes.buffer;

  if (regBuf === null) {
    if (auditBuf !== null) {
      // Check if it is a single uncommitted init/bind line from a crashed initial write,
      // or if a writer replaced/unlinked the registry file transiently while audit has >1 lines.
      const auditCheck = parseAndVerifyAuditLog(auditBuf, null);
      return {
        state: "absent",
        internal: {
          auditEntries: auditCheck.entries,
          committedByteLength: 0,
          uncommittedTail: auditCheck.uncommittedTail,
        },
      };
    }
    return {
      state: "absent",
      internal: {
        auditEntries: [],
        committedByteLength: 0,
        uncommittedTail: 0,
      },
    };
  }

  let rawRegistry;
  try {
    const text = regBuf.toString("utf8");
    if (text.trim().length === 0) {
      throw codedError("registry_corrupt", "empty_registry_file");
    }
    rawRegistry = JSON.parse(text);
  } catch (err) {
    if (err?.code === "registry_corrupt") throw err;
    throw codedError("registry_corrupt", "invalid_registry_json");
  }

  let registry;
  try {
    registry = validateIdentityRegistry(rawRegistry);
  } catch (err) {
    throw codedError("registry_corrupt", err?.reason ?? "invalid_registry_schema");
  }

  const auditResult = parseAndVerifyAuditLog(auditBuf, registry.auditHead, registry.schema);

  return {
    state: "ok",
    registry,
    audit: deepFreeze({
      verifiedThrough: auditResult.verifiedThrough,
      uncommittedTail: auditResult.uncommittedTail,
    }),
    internal: {
      auditEntries: auditResult.entries,
      committedByteLength: auditResult.committedByteLength,
      uncommittedTail: auditResult.uncommittedTail,
      registryBytes: regBuf,
      auditBytes: auditBuf,
    },
  };
}

function isRetryableReadTimingError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.transientRace === true) return true;
  if (err.code === "registry_chain_broken" && TRANSIENT_AUDIT_REASONS.has(err.reason)) {
    return true;
  }
  return false;
}

/**
 * Reads and validates the identity registry and hash-chained audit log at `root`.
 * Read-only: never creates directories, lock files, or modifies permissions.
 * Retries up to 5 times with 2–20 ms backoff when a transient writer race occurs.
 * Optional `fsHooks` is a test-only seam for deterministically simulating stat/open/read races.
 */
export function readIdentityRegistry({ root, fsHooks = null } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= READ_MAX_RETRIES; attempt++) {
    try {
      const result = readAndVerifyUnlocked(root, fsHooks);
      if (result.state === "absent") {
        return deepFreeze({ state: "absent" });
      }
      return deepFreeze({
        state: "ok",
        registry: result.registry,
        audit: result.audit,
      });
    } catch (err) {
      lastError = err;
      if (attempt < READ_MAX_RETRIES && isRetryableReadTimingError(err)) {
        sleepSyncMs(READ_RETRY_BACKOFF_MS[attempt] ?? 20);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

const HELD_LOCKS = new Set();
const require = createRequire(import.meta.url);
let sqliteModule = null;

function getSqlite() {
  if (sqliteModule) return sqliteModule;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    if (type === "ExperimentalWarning" && /SQLite/i.test(String(warning?.message ?? warning))) {
      return undefined;
    }
    return originalEmitWarning.call(this, warning, ...rest);
  };
  try {
    sqliteModule = require("node:sqlite");
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  return sqliteModule;
}

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSyncMs(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // spin fallback if Atomics.wait is unavailable on main thread
    }
  }
}

function withRegistryLock(root, timeoutMs, fn) {
  if (HELD_LOCKS.has(root)) {
    throw codedError("registry_busy", "already_locked_in_process");
  }
  const lockPath = path.join(root, LOCK_FILE_NAME);
  const journalPath = `${lockPath}-journal`;
  checkTransientLockJournal(journalPath);
  const st = assertSafeFileStat(lockPath);
  if (!st) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      closeSync(fd);
      syncDir(root);
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw codedError("registry_unsafe", "lock_create_failed");
      }
    }
    assertSafeFileStat(lockPath);
  }

  const { DatabaseSync } = getSqlite();
  let db;
  try {
    db = new DatabaseSync(lockPath);
  } catch {
    throw codedError("registry_unsafe", "lock_open_failed");
  }

  const boundedTimeout = Math.min(
     LOCK_TIMEOUT_MS,
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? Math.floor(timeoutMs)
      : LOCK_TIMEOUT_MS,
  );
  const deadline = Date.now() + boundedTimeout;
  let acquired = false;

  try {
    while (true) {
      try {
        db.exec("PRAGMA busy_timeout = 0");
        db.exec("BEGIN EXCLUSIVE");
        acquired = true;
        break;
      } catch (err) {
        const msg = String(err?.message ?? "");
        if (!/locked|busy/i.test(msg)) {
          throw codedError("registry_unsafe", "lock_acquire_failed");
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw codedError("registry_busy", "lock_timeout");
        }
        sleepSyncMs(Math.min(25, remaining));
      }
    }
    // Ensure SQLite did not relax lock file mode
    const afterStat = assertSafeFileStat(lockPath);
    if (!afterStat) {
      throw codedError("registry_unsafe", "lock_missing");
    }
  } catch (err) {
    try {
      db.close();
    } catch {}
    throw err;
  }

  HELD_LOCKS.add(root);
  const release = () => {
    HELD_LOCKS.delete(root);
    try {
      db.exec("ROLLBACK");
    } catch {}
    try {
      db.close();
    } catch {}
  };

  let res;
  try {
    res = fn();
  } catch (err) {
    release();
    throw err;
  }
  if (res && typeof res.then === "function") {
    return res.finally(release);
  }
  release();
  return res;
}

function writeBufferAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (!(written > 0)) {
      throw codedError("registry_corrupt", "short_write");
    }
    offset += written;
  }
}

function appendAuditEntrySync(root, auditPath, committedByteLength, uncommittedTail, entryLineBuffer) {
  const existingSt = assertSafeFileStat(auditPath);
  const finalSize = (existingSt ? committedByteLength : 0) + entryLineBuffer.length;
  if (finalSize > MAX_AUDIT_BYTES) {
    throw codedError("registry_audit_full", "audit_file_limit_exceeded");
  }

  let fd;
  let created = false;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  try {
    if (!existingSt) {
      fd = openSync(
        auditPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      created = true;
    } else {
      fd = openSync(auditPath, constants.O_RDWR | noFollow, 0o600);
      if (uncommittedTail > 0 || existingSt.size !== committedByteLength) {
        ftruncateSync(fd, committedByteLength);
      }
    }
    let offset = 0;
    let pos = existingSt ? committedByteLength : 0;
    while (offset < entryLineBuffer.length) {
      const written = writeSync(fd, entryLineBuffer, offset, entryLineBuffer.length - offset, pos);
      if (!(written > 0)) {
        throw codedError("registry_corrupt", "audit_short_write");
      }
      offset += written;
      pos += written;
    }
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  if (created) {
    syncDir(root);
  }
}

function assertMutationMatchesAction(current, oldRegistry, nextRegistry, action, subject) {
  const oldBindings = oldRegistry.bindings;
  const nextBindings = nextRegistry.bindings;
  if (action === "init") {
    if (current.state !== "absent" || Object.keys(nextBindings).length !== 0) {
      throw codedError("invalid_registry", "mutation_does_not_match_action");
    }
    return null;
  }
  if (action === "upgrade") {
    // The conversion is a pure function, so recompute it and compare: a mutation cannot smuggle any other change into an upgrade.
    if (
      current.state !== "ok" ||
      oldRegistry.schema !== IDENTITY_REGISTRY_SCHEMA ||
      nextRegistry.schema !== IDENTITY_REGISTRY_SCHEMA_V2
    ) {
      throw codedError("invalid_registry", "mutation_does_not_match_action");
    }
    const expected = upgradeRegistryV1ToV2(current.registry);
    for (const name of ["bindings", "pairings", "aliases", "destinations"]) {
      if (canonicalJson(nextRegistry[name]) !== canonicalJson(expected[name])) {
        throw codedError("invalid_registry", "mutation_does_not_match_action");
      }
    }
    return null;
  }
  // Past this point the schema cannot change: take it from the stored registry and insist the mutation kept it.
  const storedV2 = oldRegistry.schema === IDENTITY_REGISTRY_SCHEMA_V2;
  if (nextRegistry.schema !== oldRegistry.schema) {
    throw codedError("invalid_registry", "mutate_modified_schema");
  }
  if (storedV2) {
    // Bind and revoke leave the other collections alone; their own actions are reserved for later slices.
    for (const name of ["pairings", "aliases", "destinations"]) {
      if (canonicalJson(nextRegistry[name]) !== canonicalJson(oldRegistry[name])) {
        throw codedError("invalid_registry", "mutation_does_not_match_action");
      }
    }
  }

  // Every binding other than `subject` must be identical to oldBindings (and no extra bindings added)
  for (const [instId, oldB] of Object.entries(oldBindings)) {
    if (instId === subject) continue;
    if (!Object.hasOwn(nextBindings, instId)) {
      throw codedError("invalid_registry", "mutation_does_not_match_action");
    }
    if (canonicalJson(nextBindings[instId]) !== canonicalJson(oldB)) {
      throw codedError("invalid_registry", "mutation_does_not_match_action");
    }
  }
  for (const instId of Object.keys(nextBindings)) {
    if (instId === subject) continue;
    if (!Object.hasOwn(oldBindings, instId)) {
      throw codedError("invalid_registry", "mutation_does_not_match_action");
    }
  }

  const nextB = nextBindings[subject];
  if (!nextB) {
    throw codedError("invalid_registry", "mutation_does_not_match_action");
  }
  const oldB = Object.hasOwn(oldBindings, subject) ? oldBindings[subject] : null;

  // Serverless records are written by a later slice (pairing, key custody and its approval gate); until then this writer
  // neither creates nor changes one.
  if (
    storedV2 &&
    (nextB.trust_mode !== "mesh-managed" || (oldB !== null && oldB.trust_mode !== "mesh-managed"))
  ) {
    throw codedError("invalid_registry", "action_not_available");
  }

  if (action === "bind") {
    if (oldB === null) {
      // Subject absent before: new binding must have binding_generation === 1 and revoked_at === null
      if (nextB.binding_generation !== 1 || nextB.revoked_at !== null) {
        throw codedError("invalid_registry", "mutation_does_not_match_action");
      }
    } else {
      // Subject present before: rebind
      if (
        nextB.binding_generation !== oldB.binding_generation + 1 ||
        nextB.revoked_at !== null ||
        nextB.binding_id === oldB.binding_id ||
        nextB.profile_name !== oldB.profile_name ||
        nextB.profile_instance_id !== oldB.profile_instance_id
      ) {
        throw codedError("invalid_registry", "mutation_does_not_match_action");
      }
      // A plain bind renews the same identity; moving principal or authority needs
      // a separate owner-confirmed operation, including after revocation.
      if (nextB.principal_id !== oldB.principal_id || nextB.authority_origin !== oldB.authority_origin) {
        throw codedError("binding_conflict", "identity_change_requires_move");
      }
    }
    // Enforce uniqueness at the locked mutation boundary, not only in inventory
    // planning. Keep old v1 files readable so duplicate legacy bindings can be revoked.
    if (Object.entries(nextBindings).some(([instanceId, binding]) =>
      instanceId !== subject && binding.revoked_at === null && binding.principal_id === nextB.principal_id)) {
      throw codedError("binding_conflict", "principal_already_bound");
    }
    return nextB.binding_id;
  }

  if (action === "revoke") {
    if (oldB === null || oldB.revoked_at !== null || nextB.revoked_at === null) {
      throw codedError("invalid_registry", "mutation_does_not_match_action");
    }
    const expectedRevoked = {
      ...oldB,
      revoked_at: nextB.revoked_at,
    };
    if (canonicalJson(nextB) !== canonicalJson(expectedRevoked)) {
      throw codedError("invalid_registry", "mutation_does_not_match_action");
    }
    return nextB.binding_id;
  }

  throw codedError("invalid_registry", "mutation_does_not_match_action");
}

function writeAtomicRegistrySync(root, registryPath, contentBuffer, faultHook) {
  const tempPath = `${registryPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(tempPath, "wx", 0o600);
  let installed = false;
  let closed = false;
  try {
    writeBufferAll(fd, contentBuffer);
    fsyncSync(fd);
    closed = true;
    closeSync(fd);
    chmodSync(tempPath, 0o600);
    if (typeof faultHook === "function") {
      faultHook("before_registry_rename", { tempPath, registryPath });
    }
    renameSync(tempPath, registryPath);
    installed = true;
    if (typeof faultHook === "function") {
      faultHook("after_registry_rename", { tempPath, registryPath });
    }
  } finally {
    if (!installed) {
      if (!closed) {
        try {
          closeSync(fd);
        } catch {}
      }
      try {
        rmSync(tempPath, { force: true });
      } catch {}
    }
  }
  syncDir(root);
}

/**
 * Performs an atomic compare-and-set update on the identity registry and appends
 * a hash-chained entry to `registry-audit.jsonl`.
 */
export function updateIdentityRegistry({
  root,
  expectedSequence,
  now,
  action,
  subject = null,
  mutate,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  faultHook = null,
} = {}) {
  if (
    typeof expectedSequence !== "number" ||
    !Number.isSafeInteger(expectedSequence) ||
    expectedSequence < 0
  ) {
    throw codedError("invalid_registry", "invalid_expected_sequence");
  }
  // The names reserved for later slices exist in the audit vocabulary but no writer implements them yet.
  if (RESERVED_AUDIT_ACTIONS.has(action)) {
    throw codedError("invalid_registry", "action_not_available");
  }
  if (!AUDIT_ACTIONS.has(action) && action !== "upgrade") {
    throw codedError("invalid_registry", "invalid_audit_action");
  }
  if (subject !== null && (typeof subject !== "string" || !INSTANCE_ID_PATTERN.test(subject))) {
    throw codedError("invalid_registry", "invalid_audit_subject");
  }
  if (action === "init" && subject !== null) {
    throw codedError("invalid_registry", "init_subject_must_be_null");
  }
  if (action === "upgrade" && subject !== null) {
    throw codedError("invalid_registry", "upgrade_subject_must_be_null");
  }
  if ((action === "bind" || action === "revoke") && subject === null) {
    throw codedError("invalid_registry", "subject_required_for_action");
  }
  if (typeof mutate !== "function") {
    throw codedError("invalid_registry", "mutate_must_be_function");
  }
  const nowIso = resolveNowIso(now, "invalid_registry");

  ensureSafeRootForWrite(root);

  return withRegistryLock(root, lockTimeoutMs, () => {
    const current = readAndVerifyUnlocked(root);
    const storedSchema = current.state === "ok" ? current.registry.schema : IDENTITY_REGISTRY_SCHEMA;
    // `upgrade` turns a stored v1 registry into v2 and is the only action that changes the schema; everything else keeps it.
    // These checks come before the sequence check so a retry after a successful upgrade learns why it cannot run again.
    if (action === "upgrade") {
      if (current.state !== "ok") {
        throw codedError("invalid_registry", "upgrade_requires_registry");
      }
      if (storedSchema !== IDENTITY_REGISTRY_SCHEMA) {
        throw codedError("invalid_registry", "registry_already_v2");
      }
      // Audit line 1 of a chain must be an init or a bind, so an upgrade can never be the first line.
      if (current.registry.sequence === 0) {
        throw codedError("invalid_registry", "upgrade_requires_history");
      }
    }
    const resultSchema = action === "upgrade" ? IDENTITY_REGISTRY_SCHEMA_V2 : storedSchema;
    const currentSeq = current.state === "absent" ? 0 : current.registry.sequence;

    if (currentSeq !== expectedSequence) {
      throw codedError("registry_sequence_conflict", "sequence_mismatch");
    }

    if (current.state === "absent" && action !== "init" && action !== "bind") {
      throw codedError("invalid_registry", "mutation_does_not_match_action");
    }

    const baseRegistry =
      current.state === "absent"
        ? {
            schema: IDENTITY_REGISTRY_SCHEMA,
            sequence: 0,
            createdAt: nowIso,
            updatedAt: nowIso,
            auditHead: {
              sequence: 0,
              hash: ZERO_HASH_64,
            },
            bindings: {},
          }
        : deepClonePlain(current.registry);

    const cloneForMutate = deepClonePlain(baseRegistry);

    const rawMutated = mutate(cloneForMutate);
    if (!isPlainObject(rawMutated)) {
      throw codedError("invalid_registry", "mutate_returned_non_object");
    }
    const mutated = deepClonePlain(rawMutated);
    if (mutated.schema !== resultSchema) {
      throw codedError("invalid_registry", "mutate_modified_schema");
    }

    // mutate must not touch sequence, updatedAt or auditHead
    if (
      mutated.sequence !== baseRegistry.sequence ||
      mutated.updatedAt !== baseRegistry.updatedAt ||
      !isPlainObject(mutated.auditHead) ||
      mutated.auditHead.sequence !== baseRegistry.auditHead.sequence ||
      mutated.auditHead.hash !== baseRegistry.auditHead.hash
    ) {
      throw codedError("invalid_registry", "mutate_modified_protected_fields");
    }

    if (current.state === "ok" && mutated.createdAt !== current.registry.createdAt) {
      throw codedError("invalid_registry", "mutate_modified_created_at");
    }

    const nextSeq = currentSeq + 1;
    const prevHash =
      current.state === "absent" ? ZERO_HASH_64 : current.registry.auditHead.hash;

    // Validate candidate registry structure (closed schema, valid bindings) before diffing
    const placeholderRegistry = validateIdentityRegistry({
      ...mutated,
      sequence: nextSeq,
      updatedAt: nowIso,
      auditHead: {
        sequence: nextSeq,
        hash: "a".repeat(64),
      },
    });
    if (placeholderRegistry.schema !== resultSchema) {
      throw codedError("invalid_registry", "mutate_modified_schema");
    }

    const bindingId = assertMutationMatchesAction(
      current,
      baseRegistry,
      placeholderRegistry,
      action,
      subject,
    );

    const auditEntry = buildAuditEntry({
      sequence: nextSeq,
      at: nowIso,
      action,
      subject,
      bindingId,
      prevHash,
    });
    validateAuditEntryObject(auditEntry, { schema: resultSchema });

    const validatedRegistry = validateIdentityRegistry({
      ...placeholderRegistry,
      auditHead: {
        sequence: nextSeq,
        hash: auditEntry.hash,
      },
    });
    const registryBuffer = Buffer.from(`${canonicalJson(validatedRegistry)}\n`, "utf8");
    const auditLineBuffer = Buffer.from(`${canonicalJson(auditEntry)}\n`, "utf8");

    const auditPath = path.join(root, AUDIT_FILE_NAME);
    const registryPath = path.join(root, REGISTRY_FILE_NAME);

    // Pre-check audit size before writing anything
    const existingAuditSt = assertSafeFileStat(auditPath);
    const projectedAuditBytes =
      (existingAuditSt ? current.internal.committedByteLength : 0) + auditLineBuffer.length;
    if (projectedAuditBytes > MAX_AUDIT_BYTES) {
      throw codedError("registry_audit_full", "audit_file_limit_exceeded");
    }

    if (typeof faultHook === "function") {
      faultHook("before_audit_append", { root, auditPath, registryPath });
    }

    // Step 1: Append and fsync audit line (truncating uncommittedTail === 1 if present)
    appendAuditEntrySync(
      root,
      auditPath,
      current.internal.committedByteLength,
      current.internal.uncommittedTail,
      auditLineBuffer,
    );

    if (typeof faultHook === "function") {
      faultHook("after_audit_append", { root, auditPath, registryPath });
    }

    // Step 2: Atomically replace the registry file (commit point)
    writeAtomicRegistrySync(root, registryPath, registryBuffer, faultHook);

    if (typeof faultHook === "function") {
      faultHook("after_commit", { root, auditPath, registryPath });
    }

    return deepFreeze({
      registry: validatedRegistry,
      auditEntry,
    });
  });
}

// ---- backups and restore (D1.3) -------------------------------------------------------------------------------------------------
//
// A backup is a private directory OUTSIDE the registry root that holds exactly the two files a reader accepts (the registry
// file and the committed bytes of the audit log). It must live outside: the root custody check refuses any directory inside
// the root, so a backup there would make every read and write fail. Both functions below hold the registry lock while they
// copy, so a backup is always a pair that was consistent at one instant, and a restore cannot interleave with a writer.

const RAW_COPY_MAX_BYTES = 64 * 1024 * 1024;

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isSameOrInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertDisjointDirs(a, b, reason) {
  if (isSameOrInside(a, b) || isSameOrInside(b, a)) {
    throw codedError("invalid_registry", reason);
  }
}

function stampFromIso(nowIso) {
  return `${nowIso.slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function createPrivateChildDir(parent, baseName) {
  for (let n = 1; n <= 99; n += 1) {
    const dir = path.join(parent, n === 1 ? baseName : `${baseName}-${n}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if (err?.code === "EEXIST") continue;
      throw codedError("registry_unsafe", "backup_mkdir_failed");
    }
    chmodSync(dir, 0o700);
    return dir;
  }
  throw codedError("registry_unsafe", "backup_name_exhausted");
}

function writePrivateFileSync(filePath, buffer) {
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeBufferAll(fd, buffer);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(filePath, 0o600);
}

function removeOwnDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/**
 * Copies the verified registry pair into a new private directory under `backupParent` (created 0700 when missing).
 * Needs a readable registry; copies the registry file and only the committed bytes of the audit log, so a stale uncommitted
 * line (for example a crashed upgrade) is never carried into a backup. The copy is read back with the registry reader and
 * compared byte for byte before it is reported. Returns where it is and what it holds.
 */
export function backupIdentityRegistry({ root, backupParent, now, lockTimeoutMs = LOCK_TIMEOUT_MS, faultHook = null } = {}) {
  const nowIso = resolveNowIso(now, "invalid_registry");
  assertRootPathSyntax(root);
  assertRootPathSyntax(backupParent);
  assertDisjointDirs(root, backupParent, "backup_parent_overlaps_registry_root");
  // Reading must not create anything: a missing root, or a root without a registry file, is refused before the lock (which
  // would create the root's lock file).
  if (!checkSafeExistingRoot(root) || !lstatSync(path.join(root, REGISTRY_FILE_NAME), { throwIfNoEntry: false })) {
    throw codedError("invalid_registry", "backup_requires_registry");
  }
  return withRegistryLock(root, lockTimeoutMs, () => {
    const live = readAndVerifyUnlocked(root);
    if (live.state !== "ok") {
      throw codedError("invalid_registry", "backup_requires_registry");
    }
    const registryBytes = live.internal.registryBytes;
    const auditBytes = live.internal.auditBytes === null ? null : live.internal.auditBytes.subarray(0, live.internal.committedByteLength);
    ensureSafeRootForWrite(backupParent);
    const dir = createPrivateChildDir(backupParent, `backup-${live.registry.schema === IDENTITY_REGISTRY_SCHEMA_V2 ? "v2" : "v1"}-${stampFromIso(nowIso)}`);
    try {
      if (typeof faultHook === "function") faultHook("before_backup_write", { dir });
      writePrivateFileSync(path.join(dir, REGISTRY_FILE_NAME), registryBytes);
      if (auditBytes !== null && auditBytes.length > 0) {
        writePrivateFileSync(path.join(dir, AUDIT_FILE_NAME), auditBytes);
      }
      syncDir(dir);
      syncDir(backupParent);
      if (typeof faultHook === "function") faultHook("after_backup_write", { dir });
      const copy = readAndVerifyUnlocked(dir);
      if (
        copy.state !== "ok" ||
        copy.registry.schema !== live.registry.schema ||
        copy.registry.sequence !== live.registry.sequence ||
        copy.registry.auditHead.hash !== live.registry.auditHead.hash ||
        copy.internal.uncommittedTail !== 0 ||
        !copy.internal.registryBytes.equals(registryBytes) ||
        (auditBytes !== null && auditBytes.length > 0 && !copy.internal.auditBytes?.equals(auditBytes))
      ) {
        throw codedError("registry_corrupt", "backup_verification_failed");
      }
      if (typeof faultHook === "function") faultHook("after_backup_verify", { dir });
    } catch (err) {
      removeOwnDir(dir);
      throw err;
    }
    return deepFreeze({
      dir,
      schema: live.registry.schema,
      sequence: live.registry.sequence,
      auditHead: live.registry.auditHead,
      bindings: Object.keys(live.registry.bindings).length,
      registrySha256: sha256Buffer(registryBytes),
      auditSha256: auditBytes === null || auditBytes.length === 0 ? null : sha256Buffer(auditBytes),
      takenAt: nowIso,
    });
  });
}

function readRawFilePair(root) {
  const reg = readNoFollowDescriptor(path.join(root, REGISTRY_FILE_NAME), RAW_COPY_MAX_BYTES, "registry_corrupt", "registry_oversized");
  const aud = readNoFollowDescriptor(path.join(root, AUDIT_FILE_NAME), RAW_COPY_MAX_BYTES, "registry_corrupt", "audit_oversized");
  if (reg.status === "vanished" || aud.status === "vanished") {
    const err = codedError("registry_chain_broken", "file_vanished_during_read");
    err.transientRace = true;
    throw err;
  }
  return { registryBytes: reg.buffer, auditBytes: aud.buffer };
}

function fingerprintOf(bytes) {
  return {
    registry: bytes.registryBytes === null ? null : sha256Buffer(bytes.registryBytes),
    audit: bytes.auditBytes === null ? null : sha256Buffer(bytes.auditBytes),
  };
}

function countV2OnlyData(registry) {
  if (registry.schema !== IDENTITY_REGISTRY_SCHEMA_V2) {
    return { serverlessBindings: 0, pairings: 0, aliases: 0, destinations: 0, any: false };
  }
  const serverlessBindings = Object.values(registry.bindings).filter((b) => b.trust_mode === "serverless-peer").length;
  const pairings = Object.keys(registry.pairings).length;
  const aliases = Object.keys(registry.aliases).length;
  const destinations = Object.keys(registry.destinations).length;
  return { serverlessBindings, pairings, aliases, destinations, any: serverlessBindings + pairings + aliases + destinations > 0 };
}

// What the live root holds, read once. A root whose entries or files are unsafe is refused (`registry_unsafe`); a registry that
// fails validation or its chain is described as "unreadable" so it can still be replaced from a backup.
function describeLiveRegistry(root) {
  let verified;
  try {
    verified = readAndVerifyUnlocked(root);
  } catch (err) {
    if (err?.code === "registry_unsafe" || err?.transientRace === true) throw err;
    const bytes = readRawFilePair(root);
    return {
      state: "unreadable",
      errorCode: `${err?.code ?? "unknown"}:${err?.reason ?? ""}`,
      registry: null,
      entries: [],
      uncommittedTail: null,
      v2Data: null,
      bytes,
      fingerprint: fingerprintOf(bytes),
    };
  }
  if (verified.state === "absent") {
    const bytes = checkSafeExistingRoot(root) ? readRawFilePair(root) : { registryBytes: null, auditBytes: null };
    return { state: "absent", errorCode: null, registry: null, entries: [], uncommittedTail: null, v2Data: null, bytes, fingerprint: fingerprintOf(bytes) };
  }
  const bytes = { registryBytes: verified.internal.registryBytes, auditBytes: verified.internal.auditBytes };
  return {
    state: "ok",
    errorCode: null,
    registry: verified.registry,
    entries: verified.internal.auditEntries.slice(0, verified.registry.auditHead.sequence),
    uncommittedTail: verified.internal.uncommittedTail,
    v2Data: countV2OnlyData(verified.registry),
    bytes,
    fingerprint: fingerprintOf(bytes),
  };
}

function describeBackupDir(backupDir) {
  let verified;
  try {
    verified = readAndVerifyUnlocked(backupDir);
  } catch (err) {
    const wrapped = codedError("invalid_registry", "restore_backup_unreadable");
    wrapped.detail = `${err?.code ?? "unknown"}:${err?.reason ?? ""}`;
    throw wrapped;
  }
  if (verified.state !== "ok") {
    const wrapped = codedError("invalid_registry", "restore_backup_unreadable");
    wrapped.detail = "absent";
    throw wrapped;
  }
  if (verified.registry.schema !== IDENTITY_REGISTRY_SCHEMA) {
    throw codedError("invalid_registry", "restore_backup_not_v1");
  }
  if (verified.internal.uncommittedTail !== 0) {
    throw codedError("invalid_registry", "restore_backup_unfinished_write");
  }
  return {
    dir: backupDir,
    registry: verified.registry,
    entries: verified.internal.auditEntries,
    registryBytes: verified.internal.registryBytes,
    auditBytes: verified.internal.auditBytes,
  };
}

function leadingEqualCount(a, b) {
  const limit = Math.min(a.length, b.length);
  let n = 0;
  while (n < limit && a[n].hash === b[n].hash) n += 1;
  return n;
}

function compareHistories(live, backup) {
  if (live.state !== "ok") {
    return { relation: "unknown", discarded: [] };
  }
  const common = leadingEqualCount(live.entries, backup.entries);
  const liveSeq = live.registry.sequence;
  const backupSeq = backup.registry.sequence;
  let relation = "diverged";
  if (common === liveSeq && common === backupSeq) relation = "same";
  else if (common === backupSeq && liveSeq > common) relation = "ahead";
  else if (common === liveSeq && backupSeq > common) relation = "behind";
  const discarded = live.entries
    .slice(common)
    .map((e) => ({ sequence: e.sequence, at: e.at, action: e.action, subject: e.subject, bindingId: e.bindingId }));
  return { relation, discarded };
}

function bindingSummary(instanceId, binding) {
  return {
    instanceId,
    profile: binding.profile_name,
    principal: binding.principal_id,
    trustMode: binding.trust_mode,
    generation: binding.binding_generation,
  };
}

function sortSummaries(list) {
  return list.sort((a, b) => compareCodeUnits(a.profile, b.profile) || compareCodeUnits(a.instanceId, b.instanceId));
}

/**
 * What a restore changes for routing, binding by binding: `added` (the backup holds an active binding the live registry does
 * not), `removed` (an active live binding the backup lacks), `reactivated` (revoked live, active in the backup: the restore
 * undoes a revoke), `revoked` (active live, revoked in the backup) and `changed` (active in both with another principal,
 * origin or trust mode). With no readable live registry every active backup binding is `added`.
 */
function compareBindings(liveRegistry, backupRegistry) {
  const live = liveRegistry === null ? {} : liveRegistry.bindings;
  const out = { added: [], removed: [], reactivated: [], revoked: [], changed: [] };
  for (const [instanceId, binding] of Object.entries(backupRegistry.bindings)) {
    const was = live[instanceId];
    const active = binding.revoked_at === null;
    if (!was) {
      if (active) out.added.push(bindingSummary(instanceId, binding));
      continue;
    }
    const wasActive = was.revoked_at === null;
    if (!wasActive && active) out.reactivated.push(bindingSummary(instanceId, binding));
    else if (wasActive && !active) out.revoked.push(bindingSummary(instanceId, binding));
    else if (wasActive && active && (was.principal_id !== binding.principal_id || was.authority_origin !== binding.authority_origin || was.trust_mode !== binding.trust_mode)) {
      out.changed.push(bindingSummary(instanceId, binding));
    }
  }
  for (const [instanceId, was] of Object.entries(live)) {
    if (!Object.hasOwn(backupRegistry.bindings, instanceId) && was.revoked_at === null) out.removed.push(bindingSummary(instanceId, was));
  }
  for (const list of Object.values(out)) sortSummaries(list);
  return out;
}

function publicLive(live) {
  return {
    state: live.state,
    errorCode: live.errorCode,
    schema: live.registry === null ? null : live.registry.schema,
    sequence: live.registry === null ? null : live.registry.sequence,
    auditHead: live.registry === null ? null : live.registry.auditHead,
    bindings: live.registry === null ? null : Object.keys(live.registry.bindings).length,
    uncommittedTail: live.uncommittedTail,
    v2Data: live.v2Data,
    fingerprint: live.fingerprint,
  };
}

function publicBackup(backup) {
  return {
    dir: backup.dir,
    schema: backup.registry.schema,
    sequence: backup.registry.sequence,
    auditHead: backup.registry.auditHead,
    bindings: Object.keys(backup.registry.bindings).length,
    registrySha256: sha256Buffer(backup.registryBytes),
    auditSha256: backup.auditBytes === null ? null : sha256Buffer(backup.auditBytes),
  };
}

/**
 * Read-only description of what restoring `backupDir` over `root` would do: the live registry (or that it is absent or
 * unreadable), the backup, how their histories relate (`same`, `ahead` = the live registry has the backup's history and more,
 * `behind`, `diverged`, or `unknown` when the live registry cannot be read), the audit entries a restore would discard, what it
 * changes for routing binding by binding (including revokes it would undo), the v2-only data it would lose, and the
 * fingerprint of the live files a restore must be confirmed against. Writes nothing and
 * creates nothing. A backup that cannot be restored is refused with the same errors `restoreIdentityRegistry` gives.
 */
export function inspectIdentityRegistryRestore({ root, backupDir } = {}) {
  assertRootPathSyntax(root);
  assertRootPathSyntax(backupDir);
  assertDisjointDirs(root, backupDir, "backup_overlaps_registry_root");
  const backup = describeBackupDir(backupDir);
  let live;
  for (let attempt = 0; ; attempt += 1) {
    try {
      live = describeLiveRegistry(root);
      break;
    } catch (err) {
      if (attempt < READ_MAX_RETRIES && isRetryableReadTimingError(err)) {
        sleepSyncMs(READ_RETRY_BACKOFF_MS[attempt] ?? 20);
        continue;
      }
      throw err;
    }
  }
  const { relation, discarded } = compareHistories(live, backup);
  return deepFreeze({
    live: publicLive(live),
    backup: publicBackup(backup),
    relation,
    discarded,
    routing: compareBindings(live.registry, backup.registry),
    willLoseV2Data: live.v2Data !== null && live.v2Data.any,
  });
}

function validateLiveFingerprint(value) {
  const ok = (v) => v === null || (typeof v === "string" && HEX_64_PATTERN.test(v));
  if (!isPlainObject(value) || !hasExactKeys(value, new Set(["registry", "audit"])) || !ok(value.registry) || !ok(value.audit)) {
    throw codedError("invalid_registry", "expected_live_fingerprint_required");
  }
}

/**
 * Replaces the live registry pair with the pair in `backupDir` (a v1 backup that reads and verifies), under the registry
 * lock. `expectedLiveFingerprint` and `expectedBackup` (both from `inspectIdentityRegistryRestore`) are the compare-and-set:
 * if the live files, or the backup's bytes, are not the ones that were planned, nothing is touched (`registry_changed`). The live registry may be absent or unreadable (that is
 * what a restore is for). A readable v2 registry that holds v2-only data (a serverless binding, pairing, alias or
 * destination) is refused unless `discardV2Data` is set. Before anything is replaced the live files are copied byte for byte
 * into a new `before-restore-...` directory under `archiveParent`. The registry file is replaced first and then the audit log,
 * so a crash between the two leaves either a readable registry with one stale audit line (which the next write discards) or an
 * unreadable pair that running the restore again replaces; nothing is lost either way, the archive has the previous files.
 */
export function restoreIdentityRegistry({
  root,
  backupDir,
  archiveParent,
  expectedLiveFingerprint,
  expectedBackup,
  discardV2Data = false,
  now,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  faultHook = null,
} = {}) {
  const nowIso = resolveNowIso(now, "invalid_registry");
  assertRootPathSyntax(root);
  assertRootPathSyntax(backupDir);
  assertRootPathSyntax(archiveParent);
  assertDisjointDirs(root, backupDir, "backup_overlaps_registry_root");
  assertDisjointDirs(root, archiveParent, "backup_parent_overlaps_registry_root");
  validateLiveFingerprint(expectedLiveFingerprint);
  if (!isPlainObject(expectedBackup) || !HEX_64_PATTERN.test(expectedBackup.registrySha256 ?? "") || !(expectedBackup.auditSha256 === null || HEX_64_PATTERN.test(expectedBackup.auditSha256 ?? ""))) {
    throw codedError("invalid_registry", "expected_backup_required");
  }
  const backup = describeBackupDir(backupDir);
  // the bytes that will be written are the bytes that were planned, not whatever the directory holds now
  if (
    sha256Buffer(backup.registryBytes) !== expectedBackup.registrySha256 ||
    (backup.auditBytes === null ? null : sha256Buffer(backup.auditBytes)) !== expectedBackup.auditSha256
  ) {
    throw codedError("registry_changed", "backup_changed_since_plan");
  }
  ensureSafeRootForWrite(root);
  return withRegistryLock(root, lockTimeoutMs, () => {
    const live = describeLiveRegistry(root);
    if (live.fingerprint.registry !== expectedLiveFingerprint.registry || live.fingerprint.audit !== expectedLiveFingerprint.audit) {
      throw codedError("registry_changed", "live_registry_changed_since_plan");
    }
    if (live.state === "ok" && live.v2Data.any && discardV2Data !== true) {
      throw codedError("restore_refused", "restore_would_lose_v2_data");
    }
    const { relation, discarded } = compareHistories(live, backup);
    const routing = compareBindings(live.registry, backup.registry);

    let archive = null;
    if (live.bytes.registryBytes !== null || live.bytes.auditBytes !== null) {
      ensureSafeRootForWrite(archiveParent);
      if (typeof faultHook === "function") faultHook("before_archive", { root, backupDir });
      const tag = live.state === "ok" ? (live.registry.schema === IDENTITY_REGISTRY_SCHEMA_V2 ? "v2" : "v1") : live.state;
      const dir = createPrivateChildDir(archiveParent, `before-restore-${tag}-${stampFromIso(nowIso)}`);
      try {
        const files = [];
        for (const [name, bytes] of [[REGISTRY_FILE_NAME, live.bytes.registryBytes], [AUDIT_FILE_NAME, live.bytes.auditBytes]]) {
          if (bytes === null) continue;
          writePrivateFileSync(path.join(dir, name), bytes);
          files.push({ name, sha256: sha256Buffer(bytes) });
        }
        syncDir(dir);
        syncDir(archiveParent);
        if (typeof faultHook === "function") faultHook("after_archive_write", { root, archiveDir: dir });
        for (const { name, sha256 } of files) {
          const back = readNoFollowDescriptor(path.join(dir, name), RAW_COPY_MAX_BYTES, "registry_corrupt", "archive_oversized");
          if (back.status !== "ok" || sha256Buffer(back.buffer) !== sha256) {
            throw codedError("registry_corrupt", "archive_verification_failed");
          }
        }
        archive = { dir, files };
      } catch (err) {
        removeOwnDir(dir);
        throw err;
      }
      if (typeof faultHook === "function") faultHook("after_archive", { root, archiveDir: archive.dir });
    }

    const registryPath = path.join(root, REGISTRY_FILE_NAME);
    const auditPath = path.join(root, AUDIT_FILE_NAME);
    const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
    const registryTemp = `${registryPath}.tmp-restore-${suffix}`;
    const auditTemp = `${registryPath}.tmp-restore-audit-${suffix}`;
    const stagedAudit = backup.auditBytes !== null && backup.auditBytes.length > 0;
    try {
      writePrivateFileSync(registryTemp, backup.registryBytes);
      if (stagedAudit) writePrivateFileSync(auditTemp, backup.auditBytes);
      if (typeof faultHook === "function") faultHook("before_registry_replace", { root, backupDir });
      renameSync(registryTemp, registryPath);
      if (typeof faultHook === "function") faultHook("after_registry_replace", { root, backupDir });
      if (stagedAudit) {
        renameSync(auditTemp, auditPath);
      } else {
        rmSync(auditPath, { force: true });
      }
      syncDir(root);
      if (typeof faultHook === "function") faultHook("after_audit_replace", { root, backupDir });
    } finally {
      for (const temp of [registryTemp, auditTemp]) {
        try {
          rmSync(temp, { force: true });
        } catch {}
      }
    }

    const after = readAndVerifyUnlocked(root);
    if (
      after.state !== "ok" ||
      after.registry.schema !== backup.registry.schema ||
      after.registry.sequence !== backup.registry.sequence ||
      after.registry.auditHead.hash !== backup.registry.auditHead.hash ||
      after.internal.uncommittedTail !== 0 ||
      !after.internal.registryBytes.equals(backup.registryBytes)
    ) {
      throw codedError("registry_corrupt", "restore_verification_failed");
    }
    return deepFreeze({
      restored: { schema: after.registry.schema, sequence: after.registry.sequence, auditHead: after.registry.auditHead },
      archive,
      live: { state: live.state, schema: live.registry === null ? null : live.registry.schema, sequence: live.registry === null ? null : live.registry.sequence },
      relation,
      discarded,
      routing,
    });
  });
}
