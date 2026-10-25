/**
 * Host-Local Identity Registry Storage (Slice 1a Foundation).
 *
 * Implements:
 * - Closed-schema validation (`identity_registry_v1` and reduced `local_profile_binding_v1`)
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
  INSTANCE_ID_PATTERN,
  isValidBareHttpsOrigin,
} from "./identity-inventory.mjs";
import {
  deriveClientInstanceId,
  isValidProfileName,
} from "./installation-inventory.mjs";

export const IDENTITY_REGISTRY_SCHEMA = "identity_registry_v1";
export const LOCAL_PROFILE_BINDING_SCHEMA = "local_profile_binding_v1";

export const REGISTRY_FILE_NAME = "identity-registry-v1.json";
export const AUDIT_FILE_NAME = "registry-audit.jsonl";
export const LOCK_FILE_NAME = ".registry.lock";

export const MAX_REGISTRY_BINDINGS = 1000;
export const MAX_REGISTRY_BYTES = 1024 * 1024; // 1 MiB
export const MAX_AUDIT_BYTES = 8 * 1024 * 1024; // 8 MiB
export const LOCK_TIMEOUT_MS = 5000;
export const ZERO_HASH_64 = "0".repeat(64);

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
export function validateIdentityRegistry(value) {
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

function validateAuditEntryObject(entry) {
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
  if (!AUDIT_ACTIONS.has(entry.action)) {
    throw codedError("registry_chain_broken", "invalid_audit_action");
  }
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

function assertSafeFileStat(filePath) {
  const st = lstatSync(filePath, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    throw codedError("registry_unsafe", "unsafe_file_type_or_links");
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw codedError("registry_unsafe", "file_wrong_owner");
  }
  if ((st.mode & 0o777) !== 0o600) {
    throw codedError("registry_unsafe", "file_wrong_mode");
  }
  try {
    privateFile(filePath);
  } catch {
    throw codedError("registry_unsafe", "unsafe_file");
  }
  return st;
}

function verifyRootEntriesCustody(root) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    throw codedError("registry_unsafe", "root_unreadable");
  }
  for (const name of names) {
    // Ignore leftover atomic temp files during read, but still reject symlinks if any entry is inspected
    if (name.startsWith(`${REGISTRY_FILE_NAME}.tmp-`)) {
      const tmpStat = lstatSync(path.join(root, name), { throwIfNoEntry: false });
      if (tmpStat && (tmpStat.isSymbolicLink() || !tmpStat.isFile())) {
        throw codedError("registry_unsafe", "unsafe_temp_entry");
      }
      continue;
    }
    const full = path.join(root, name);
    assertSafeFileStat(full);
  }
}

function readNoFollowBuffer(filePath, maxBytes, oversizeCode, oversizeReason) {
  const st = assertSafeFileStat(filePath);
  if (!st) return null;
  if (st.size > maxBytes) {
    throw codedError(oversizeCode, oversizeReason);
  }
  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(filePath, openFlags);
    const buf = readFileSync(fd);
    if (buf.length > maxBytes) {
      throw codedError(oversizeCode, oversizeReason);
    }
    return buf;
  } catch (err) {
    if (err?.code === oversizeCode || err?.code === "registry_unsafe") throw err;
    throw codedError("registry_unsafe", "file_open_failed");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function parseAndVerifyAuditLog(auditBuf, expectedHead) {
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
    if (expectedHead && expectedHead.sequence === 0 && expectedHead.hash === ZERO_HASH_64) {
      return { entries: [], uncommittedTail: 0, verifiedThrough: 0, committedByteLength: 0 };
    }
    throw codedError("registry_chain_broken", "audit_log_empty");
  }

  // Every line in a valid JSONL file must end with \n (no truncated partial line)
  if (!text.endsWith("\n")) {
    throw codedError("registry_chain_broken", "audit_line_truncated");
  }

  const rawLines = text.slice(0, -1).split("\n");
  const entries = [];
  let prevHash = ZERO_HASH_64;
  let byteOffset = 0;
  let committedByteLength = 0;

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
    validateAuditEntryObject(parsed);
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
    // leaves exactly 1 line with sequence 1. Any other content is broken chain.
    if (
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
    if (entries.length === 0) {
      return { entries: [], uncommittedTail: 0, verifiedThrough: 0, committedByteLength: 0 };
    }
    if (entries.length === 1 && entries[0].sequence === 1) {
      return { entries, uncommittedTail: 1, verifiedThrough: 0, committedByteLength: 0 };
    }
    throw codedError("registry_chain_broken", "unexpected_audit_entries_for_seq_zero");
  }

  if (entries.length < expectedHead.sequence) {
    throw codedError("registry_chain_broken", "audit_log_behind_registry");
  }
  if (entries.length > expectedHead.sequence + 1) {
    throw codedError("registry_chain_broken", "audit_log_too_many_uncommitted_lines");
  }

  const headEntry = entries[expectedHead.sequence - 1];
  if (!headEntry || headEntry.hash !== expectedHead.hash) {
    throw codedError("registry_chain_broken", "audit_head_hash_mismatch");
  }

  const uncommittedTail = entries.length - expectedHead.sequence;
  return {
    entries,
    uncommittedTail,
    verifiedThrough: expectedHead.sequence,
    committedByteLength,
  };
}

function readAndVerifyUnlocked(root) {
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

  verifyRootEntriesCustody(root);

  const registryPath = path.join(root, REGISTRY_FILE_NAME);
  const auditPath = path.join(root, AUDIT_FILE_NAME);

  const regBuf = readNoFollowBuffer(
    registryPath,
    MAX_REGISTRY_BYTES,
    "registry_corrupt",
    "registry_oversized",
  );
  // Read audit file up to MAX_AUDIT_BYTES + 1 MiB to parse and verify existing chain
  const auditBuf = readNoFollowBuffer(
    auditPath,
    MAX_AUDIT_BYTES + 1024 * 1024,
    "registry_corrupt",
    "audit_oversized",
  );

  if (regBuf === null) {
    if (auditBuf !== null) {
      // Check if it is a single uncommitted init line from a crashed initial write
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

  const auditResult = parseAndVerifyAuditLog(auditBuf, registry.auditHead);

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
    },
  };
}

/**
 * Reads and validates the identity registry and hash-chained audit log at `root`.
 * Read-only: never creates directories, lock files, or modifies permissions.
 */
export function readIdentityRegistry({ root } = {}) {
  const result = readAndVerifyUnlocked(root);
  if (result.state === "absent") {
    return deepFreeze({ state: "absent" });
  }
  return deepFreeze({
    state: "ok",
    registry: result.registry,
    audit: result.audit,
  });
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
  assertSafeFileStat(journalPath);
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
  if (!AUDIT_ACTIONS.has(action)) {
    throw codedError("invalid_registry", "invalid_audit_action");
  }
  if (subject !== null && (typeof subject !== "string" || !INSTANCE_ID_PATTERN.test(subject))) {
    throw codedError("invalid_registry", "invalid_audit_subject");
  }
  if (action === "init" && subject !== null) {
    throw codedError("invalid_registry", "init_subject_must_be_null");
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
    const currentSeq = current.state === "absent" ? 0 : current.registry.sequence;

    if (currentSeq !== expectedSequence) {
      throw codedError("registry_sequence_conflict", "sequence_mismatch");
    }

    if (current.state === "absent" && action !== "init" && action !== "bind") {
      throw codedError("invalid_registry", "cannot_revoke_when_absent");
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

    const oldBindings = baseRegistry.bindings;
    const cloneForMutate = deepClonePlain(baseRegistry);

    const mutated = mutate(cloneForMutate);
    if (!isPlainObject(mutated)) {
      throw codedError("invalid_registry", "mutate_returned_non_object");
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

    // Validate candidate bindings and registry structure before determining bindingId
    if (!isPlainObject(mutated.bindings)) {
      throw codedError("invalid_registry", "bindings_not_object");
    }

    // Enforce monotonic binding_generation and no-delete rule
    for (const [instId, oldB] of Object.entries(oldBindings)) {
      if (!Object.hasOwn(mutated.bindings, instId)) {
        throw codedError("invalid_registry", "binding_deleted");
      }
      const nextB = mutated.bindings[instId];
      if (!isPlainObject(nextB)) {
        throw codedError("invalid_registry", "binding_not_object");
      }
      if (
        typeof nextB.binding_generation !== "number" ||
        !Number.isSafeInteger(nextB.binding_generation) ||
        nextB.binding_generation < oldB.binding_generation
      ) {
        throw codedError("invalid_registry", "binding_generation_decreased");
      }
    }

    let bindingId = null;
    if (action === "bind" || action === "revoke") {
      const targetBinding = mutated.bindings[subject];
      if (!isPlainObject(targetBinding)) {
        throw codedError("invalid_registry", "subject_binding_missing");
      }
      if (action === "revoke" && targetBinding.revoked_at === null) {
        throw codedError("invalid_registry", "revoke_action_requires_revoked_at");
      }
      if (typeof targetBinding.binding_id !== "string" || !BINDING_ID_PATTERN.test(targetBinding.binding_id)) {
        throw codedError("invalid_registry", "invalid_binding_id");
      }
      bindingId = targetBinding.binding_id;
    } else if (action === "init") {
      if (Object.keys(mutated.bindings).length > 0) {
        throw codedError("invalid_registry", "init_must_not_contain_bindings");
      }
    }

    const auditEntry = buildAuditEntry({
      sequence: nextSeq,
      at: nowIso,
      action,
      subject,
      bindingId,
      prevHash,
    });
    validateAuditEntryObject(auditEntry);

    const candidateRegistry = {
      ...mutated,
      sequence: nextSeq,
      updatedAt: nowIso,
      auditHead: {
        sequence: nextSeq,
        hash: auditEntry.hash,
      },
    };

    const validatedRegistry = validateIdentityRegistry(candidateRegistry);
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
