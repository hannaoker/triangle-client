/**
 * Read-only installation inventory for doctor/status.
 *
 * Enumerates the full installation registry (`client/instances/*.json`), the
 * permissions v1 profile bindings (`profiles-v1/profile-<hex>.json` -> a `triangle`
 * agent key file), and every lane-specific binding (Codex v2 headless,
 * Cursor ACP, worker runtime manifests, App Server, Grok Bot), then reconciles
 * each registered profile with the binding its runtime/delivery mode requires.
 *
 * Contract:
 * - READ-ONLY. Only stat/read/readdir calls. No writes, renames, mkdirs,
 *   lock acquisition, process launches, Keychain or network access.
 * - Never returns credential material or message bodies. Workload key files are
 *   checked for custody (mode/owner/type) only; their contents are never opened.
 *   The agent record (`agent.json`) and `triangle`'s cached permissions view
 *   are secret-free and are read.
 * - Every field that the local journal/registry does not supply is reported as
 *   the literal string "unavailable" (or "unsupported" for lanes with no such
 *   concept). Nothing is inferred from absence.
 */

import { createHash } from "node:crypto";
import { accessSync, existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  deriveClientInstanceId,
  INSTANCE_ID_PATTERN as INSTANCE_ID,
  isValidProfileName,
} from "./identity-primitives.mjs";

export { deriveClientInstanceId, isValidProfileName };

export const UNAVAILABLE = "unavailable";
export const UNSUPPORTED = "unsupported";

/** Mirrors Swift `MailboxTransactionIdentifier.maximumFailureCountBeforeStuck`. */
export const OPEN_TRANSACTION_MAX_FAILURES_BEFORE_STUCK = 5;
/** Default open-transaction age budget; the doctor passes its `maxOpenTxnAgeMs`. */
export const DEFAULT_MAX_OPEN_TXN_AGE_MS = 15 * 60_000;
const MAX_JOURNAL_FILES = 5000;
// Persisted enums (Swift `RuntimeAdapter`, `DeliveryMode`, `EnrollmentJournalState`).
const RUNTIME_ADAPTERS = new Set(["codex", "hermes", "antigravity", "grok-bot", "cursor-acp"]);
const DELIVERY_MODES = new Set(["worker", "mcp-interactive", "event-driven", "grok-bot", "headless-app-server", "headless-cursor-acp"]);
const REGISTRY_REQUIRED_KEYS = ["version", "instanceId", "profile", "runtimeAdapter", "enabled"];
const REGISTRY_ALLOWED_KEYS = new Set([...REGISTRY_REQUIRED_KEYS, "deliveryMode"]);
const BINDING_KEYS_REQUIRED = ["version", "keyFile"];
const BINDING_KEYS_ALLOWED = new Set(["version", "keyFile", "origin"]);
const WORKLOAD_ID = /^workload_[a-f0-9]{32}$/;
const AGENT_BOUNDS = ["agent.read", "agent.write"];
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
// Permission keys are dotted (`dm.send`, `posts.publish`, `tasks.claim`).
const PERMISSION_NAME = /^(?=.{1,64}$)[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const AGENT_ID = /^agent_[a-f0-9]{32}$/;
const MAILBOX_HANDLE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const INSTALLATION_ID = /^inst_[A-Za-z0-9_-]{10,75}$/;
const OPEN_TXN_MAX_BYTES = 4096;
const PROFILE_BINDING_MAX_BYTES = 4096;
const AGENT_RECORD_MAX_BYTES = 64 * 1024;
const INSTALLATION_IDENTITY_MAX_BYTES = 512;
const WORKER_MANIFEST_KEYS = ["version", "nodeSHA256", "projectRoot", "environment", "artifacts"];
const WORKER_MANIFEST_VERSIONS = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
const WORKER_CLI_ENV = { codex: "CODEX_CLI", hermes: "HERMES_CLI", antigravity: "ANTIGRAVITY_CLI" };
const SECRETISH_KEY = /token|secret|password|private|bearer|credential|key$/i;


function sameKeys(value, keys) {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Mirrors Swift `MeshOrigin` as decoded from disk (https only, bare origin). */
function isValidMeshOrigin(value) {
  if (typeof value !== "string") return false;
  // Swift checks the raw percent-encoded path; WHATWG URL would normalize
  // `/a/..` or `/.` to `/` and accept what the helper rejects.
  const rawPath = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(.*)$/s.exec(value);
  if (rawPath == null || (rawPath[1] !== "" && rawPath[1] !== "/")) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname.length > 0 && url.username === "" && url.password === ""
    && !value.includes("?") && !value.includes("#") && (url.pathname === "/" || url.pathname === "");
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return { present: false, value: null, error: null };
  try {
    return { present: true, value: JSON.parse(readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    return { present: true, value: null, error: error?.code ?? "unreadable" };
  }
}

function listDir(dirPath) {
  try {
    return readdirSync(dirPath);
  } catch (error) {
    return error?.code === "ENOENT" ? null : { error: error?.code ?? "unreadable" };
  }
}

function isoOrNull(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function maxIso(values) {
  let best = null;
  let bestMs = -Infinity;
  for (const value of values) {
    const iso = isoOrNull(value);
    if (iso == null) continue;
    const ms = Date.parse(iso);
    if (ms > bestMs) {
      bestMs = ms;
      best = iso;
    }
  }
  return best;
}

function ageMs(iso, now) {
  const value = isoOrNull(iso);
  if (value == null) return null;
  return Math.max(0, now - Date.parse(value));
}

/**
 * Lane classification mirrors Swift `ClientInstance.participatesIn*` so the
 * doctor reports what the supervisor would actually do with the entry.
 */
export function classifyLane({ runtimeAdapter, deliveryMode }) {
  if (deliveryMode === "headless-app-server") {
    return runtimeAdapter === "codex"
      ? { lane: "codex-headless", support: "supported", reason: null }
      : { lane: "codex-headless", support: "unsupported", reason: "headless_app_server_requires_codex_adapter" };
  }
  if (deliveryMode === "headless-cursor-acp") {
    return runtimeAdapter === "cursor-acp"
      ? { lane: "cursor-acp", support: "supported", reason: null }
      : { lane: "cursor-acp", support: "unsupported", reason: "headless_cursor_acp_requires_cursor_acp_adapter" };
  }
  if (deliveryMode === "worker") {
    if (runtimeAdapter === "antigravity") {
      return { lane: "worker", support: "experimental", reason: "antigravity_experimental_compatibility" };
    }
    if (runtimeAdapter === "hermes" || runtimeAdapter === "codex") {
      return { lane: "worker", support: "supported", reason: null };
    }
    return { lane: "worker", support: "unsupported", reason: "worker_runtime_adapter_unsupported" };
  }
  if (deliveryMode === "event-driven") {
    // prepareEventWake resolves a worker adapter (resolveAdapter): grok-bot and
    // cursor-acp have no worker runner and are omitted as runtime_ineligible.
    if (runtimeAdapter === "antigravity") {
      return { lane: "event-driven", support: "experimental", reason: "antigravity_experimental_compatibility" };
    }
    if (runtimeAdapter === "hermes" || runtimeAdapter === "codex") {
      return { lane: "event-driven", support: "supported", reason: null };
    }
    return { lane: "event-driven", support: "unsupported", reason: "event_driven_runtime_adapter_unsupported" };
  }
  if (deliveryMode === "mcp-interactive") return { lane: "app-server", support: "supported", reason: null };
  if (deliveryMode === "grok-bot") {
    // Swift still prepares a grokBotWake bootstrap, but the Node supervisor
    // (runClientSupervisor) throws on any non-null grokBotWake: the Mini Bob
    // webhook path is retired, so an enabled grok-bot profile is never served.
    return { lane: "grok-bot", support: "unsupported", reason: "grok_bot_wake_path_removed" };
  }
  return { lane: "unknown", support: "unsupported", reason: "unknown_delivery_mode" };
}

/**
 * Mirrors Swift `FileClientInstanceStore.list()` + `ClientInstance(from:)`:
 * exact key set (deliveryMode optional), version 1, enum-valid adapter and
 * delivery mode, derived instance id, file name == instance id, unique
 * profiles. A row without deliveryMode decodes as `worker` regardless of
 * adapter. Any invalid row makes Swift's list() throw, so each is a fault.
 */
const REGISTRY_MAX_BYTES = 2048;

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Swift `FileClientInstanceStore.metadataIsSafe` for a managed directory. */
function isSafeManagedDirectory(dirPath) {
  try {
    const meta = lstatSync(dirPath);
    const uid = currentUid();
    return meta.isDirectory() && (meta.mode & 0o777) === 0o700 && (uid == null || meta.uid === uid);
  } catch {
    return false;
  }
}

/** Swift `validateFile` + read cap: no-follow regular file, 0600, owner, one link, <= 2048 bytes. */
function registryFileProblem(filePath) {
  let meta;
  try {
    meta = lstatSync(filePath);
  } catch {
    return "unreadable";
  }
  const uid = currentUid();
  if (!meta.isFile() || (meta.mode & 0o777) !== 0o600 || meta.nlink !== 1 || (uid != null && meta.uid !== uid)) {
    return "unsafe_file";
  }
  return meta.size > REGISTRY_MAX_BYTES ? "oversized" : null;
}

/**
 * Custody of a Swift-managed record file: every managed directory a real 0700
 * directory owned by the user, the file a no-follow regular 0600 file owned by
 * the user (single link where the Swift store requires it) within its byte cap.
 * @returns {null|"absent"|"unsafe_storage"|"oversized"|"unreadable"}
 */
function custodyProblem(filePath, { maxBytes, singleLink = false, directories = [] }) {
  let meta;
  try {
    meta = lstatSync(filePath);
  } catch (error) {
    return error?.code === "ENOENT" ? "absent" : "unreadable";
  }
  if (directories.some((dir) => !isSafeManagedDirectory(dir))) return "unsafe_storage";
  const uid = currentUid();
  if (!meta.isFile() || (meta.mode & 0o777) !== 0o600 || (uid != null && meta.uid !== uid)
    || (singleLink && meta.nlink !== 1)) {
    return "unsafe_storage";
  }
  return meta.size > maxBytes ? "oversized" : null;
}

function readRegistry(clientRoot) {
  const dir = path.join(clientRoot, "instances");
  const listing = listDir(dir);
  if (listing == null) return { status: "absent", path: dir, entries: [], strayNames: [] };
  if (!Array.isArray(listing)) return { status: "unreadable", path: dir, entries: [], strayNames: [], error: listing.error };
  // Swift opens the application, client, and instances directories only when
  // each is a real 0700 directory owned by the user; otherwise list() throws.
  const unsafeDirectories = [path.resolve(clientRoot, ".."), clientRoot, dir].filter((d) => !isSafeManagedDirectory(d));
  if (unsafeDirectories.length > 0) {
    return { status: "unsafe", path: dir, entries: [], strayNames: [], unsafeDirectoryCount: unsafeDirectories.length };
  }
  const entries = [];
  const strayNames = [];
  for (const name of listing.sort()) {
    if (name.startsWith(".tmp-")) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name)) {
      strayNames.push(name);
      continue;
    }
    const filePath = path.join(dir, name);
    const fileId = name.slice(0, -".json".length);
    const custody = registryFileProblem(filePath);
    if (custody != null) {
      entries.push({ file: name, fileId, profile: null, valid: false, problems: [custody] });
      continue;
    }
    const { value, error } = readJsonFile(filePath);
    const problems = [];
    if (error != null || !isPlainObject(value)) {
      entries.push({ file: name, fileId, profile: null, valid: false, problems: ["unreadable"] });
      continue;
    }
    if (Object.keys(value).some((key) => !REGISTRY_ALLOWED_KEYS.has(key))) problems.push("unexpected_keys");
    if (REGISTRY_REQUIRED_KEYS.some((key) => !Object.hasOwn(value, key))) problems.push("missing_keys");
    if (value.version !== 1) problems.push("unsupported_version");
    if (!isValidProfileName(value.profile)) problems.push("invalid_profile");
    if (typeof value.instanceId !== "string" || !INSTANCE_ID.test(value.instanceId)) problems.push("invalid_instance_id");
    if (typeof value.enabled !== "boolean") problems.push("invalid_enabled");
    if (!RUNTIME_ADAPTERS.has(value.runtimeAdapter)) problems.push("invalid_runtime_adapter");
    const hasDeliveryMode = Object.hasOwn(value, "deliveryMode") && value.deliveryMode !== null;
    if (hasDeliveryMode && !DELIVERY_MODES.has(value.deliveryMode)) problems.push("invalid_delivery_mode");
    if (value.instanceId !== fileId) problems.push("file_name_instance_id_mismatch");
    if (isValidProfileName(value.profile)
      && value.instanceId !== deriveClientInstanceId(value.profile)) {
      problems.push("instance_id_not_derived_from_profile");
    }
    // Swift decoder: `decodeIfPresent(DeliveryMode) ?? .worker` (not the adapter default).
    const deliveryMode = hasDeliveryMode ? value.deliveryMode : "worker";
    entries.push({
      file: name,
      fileId,
      profile: typeof value.profile === "string" ? value.profile : null,
      instanceId: typeof value.instanceId === "string" ? value.instanceId : null,
      runtimeAdapter: typeof value.runtimeAdapter === "string" ? value.runtimeAdapter : null,
      deliveryMode,
      deliveryModeSource: hasDeliveryMode ? "registry" : "decoder_default_worker",
      enabled: typeof value.enabled === "boolean" ? value.enabled : null,
      valid: problems.length === 0,
      problems,
    });
  }
  const seen = new Map();
  for (const entry of entries) {
    if (!entry.valid) continue;
    if (seen.has(entry.profile)) {
      entry.valid = false;
      entry.problems.push("duplicate_profile");
      seen.get(entry.profile).valid = false;
      seen.get(entry.profile).problems.push("duplicate_profile");
    } else {
      seen.set(entry.profile, entry);
    }
  }
  return { status: "present", path: dir, entries, strayNames };
}

/** Swift loader: `authority.json` `via` applies only when its `authority` matches the agent's. */
function transportVia(home, authority) {
  const file = path.join(home, "authority.json");
  if (custodyProblem(file, { maxBytes: AGENT_RECORD_MAX_BYTES, singleLink: true }) != null) return null;
  const { value } = readJsonFile(file);
  // Swift compares canonical MeshOrigins, so compare URL origins, not raw strings.
  return isPlainObject(value) && isValidMeshOrigin(value.authority) && isValidMeshOrigin(authority)
    && canonicalOrigin(value.authority) === canonicalOrigin(authority) && isValidMeshOrigin(value.via) ? value.via : null;
}

function canonicalOrigin(value) {
  try { return new URL(value).origin; } catch { return null; }
}

function decodeHexProfile(hex) {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  const text = Buffer.from(hex, "hex").toString("utf8");
  // Round-trip check rejects invalid UTF-8 that Buffer would replace with U+FFFD.
  return isValidProfileName(text) && Buffer.from(text, "utf8").toString("hex") === hex ? text : null;
}

function isPrivateDirectory(dirPath) {
  try {
    const meta = lstatSync(dirPath);
    const uid = currentUid();
    return meta.isDirectory() && (meta.mode & 0o077) === 0 && (uid == null || meta.uid === uid);
  } catch {
    return false;
  }
}

/** A `triangle` permissions cache entry: `{ etag, view: { agent_id, revision, permissions } }`. */
function readCachedPermissions(home, agentId) {
  const file = path.join(home, "cache", "permissions", `${agentId}.json`);
  if (custodyProblem(file, { maxBytes: AGENT_RECORD_MAX_BYTES }) != null) return { source: UNAVAILABLE, reason: "not_cached" };
  const { value, error } = readJsonFile(file);
  const view = value?.view;
  if (error != null || !isPlainObject(view) || view.agent_id !== agentId || !Number.isSafeInteger(view.revision) || !isPlainObject(view.permissions)) {
    return { source: UNAVAILABLE, reason: "cache_invalid" };
  }
  const values = {};
  for (const [name, flag] of Object.entries(view.permissions)) {
    if (PERMISSION_NAME.test(name) && typeof flag === "boolean") values[name] = flag;
  }
  return { source: "triangle_cache", revision: view.revision, values };
}

/**
 * Mirrors Swift `FileV1ProfileBindingStore` + `V1AgentCredentialLoader`:
 * `profiles-v1/profile-<hex>.json` (0700 dir, 0600 file) points at
 * `<home>/agents/<agent_id>/workload-key.json`; the key file must be a
 * no-follow 0600 regular file (never opened here) beside a valid `agent.json`.
 */
function readProfileBindings(applicationRoot) {
  const dir = path.join(applicationRoot, "profiles-v1");
  const listing = listDir(dir);
  const byProfile = new Map();
  if (listing == null) return { status: "absent", path: dir, byProfile };
  if (!Array.isArray(listing)) return { status: "unreadable", path: dir, byProfile };
  if (!isSafeManagedDirectory(dir)) return { status: "unsafe", path: dir, byProfile };
  for (const name of listing) {
    // Swift `FileV1ProfileBindingStore.fileName`: `profile-<utf8 hex>.json`.
    const match = /^profile-([0-9a-f]+)\.json$/.exec(name);
    const profile = match ? decodeHexProfile(match[1]) : null;
    if (profile == null) continue;
    byProfile.set(profile, readOneBinding(path.join(dir, name)));
  }
  return { status: "present", path: dir, byProfile };
}

function readOneBinding(file) {
  const fail = (state, extra = {}) => ({ state, agentId: null, handle: null, keyFile: null, permissions: { source: UNAVAILABLE }, ...extra });
  const custody = custodyProblem(file, { maxBytes: PROFILE_BINDING_MAX_BYTES, singleLink: true });
  if (custody != null) return fail(custody === "oversized" ? "invalid_binding" : "unsafe_storage");
  const { value, error } = readJsonFile(file);
  if (error != null || !isPlainObject(value) || value.version !== 1
    || !BINDING_KEYS_REQUIRED.every((key) => Object.hasOwn(value, key))
    || !Object.keys(value).every((key) => BINDING_KEYS_ALLOWED.has(key))
    || typeof value.keyFile !== "string" || value.keyFile.length > 1024 || !isStandardizedAbsolute(value.keyFile)
    || (value.origin != null && !isValidMeshOrigin(value.origin))) {
    return fail("invalid_binding");
  }
  const keyFile = value.keyFile;
  const agentDir = path.dirname(keyFile);
  const home = path.dirname(path.dirname(agentDir));
  if (path.basename(keyFile) !== "workload-key.json" || path.basename(path.dirname(agentDir)) !== "agents" || !AGENT_ID.test(path.basename(agentDir))) {
    return fail("invalid_binding", { keyFile });
  }
  // Swift `V1PrivateDirectory`: the custody home, agents/ and agents/<id>/
  // must be real directories owned by this user with no group/other bits.
  if ([home, path.dirname(agentDir), agentDir].some((dir) => !isPrivateDirectory(dir))) return fail("key_unsafe", { keyFile });
  const keyCustody = custodyProblem(keyFile, { maxBytes: AGENT_RECORD_MAX_BYTES, singleLink: true });
  if (keyCustody === "absent") return fail("key_missing", { keyFile });
  if (keyCustody != null) return fail("key_unsafe", { keyFile });
  const recordFile = path.join(agentDir, "agent.json");
  if (custodyProblem(recordFile, { maxBytes: AGENT_RECORD_MAX_BYTES, singleLink: true }) != null) return fail("agent_record_invalid", { keyFile });
  const record = readJsonFile(recordFile).value;
  if (!isPlainObject(record) || typeof record.agent_id !== "string" || !AGENT_ID.test(record.agent_id)
    || typeof record.workload_id !== "string" || !WORKLOAD_ID.test(record.workload_id)
    || typeof record.handle !== "string" || !MAILBOX_HANDLE.test(record.handle)
    || Buffer.byteLength(record.handle, "utf8") < 3 || Buffer.byteLength(record.handle, "utf8") > 32
    || !isValidMeshOrigin(record.authority)) {
    return fail("agent_record_invalid", { keyFile });
  }
  if (record.agent_id !== path.basename(agentDir)) return fail("agent_mismatch", { keyFile });
  // Swift: `bounds as? [String]` filters the known bounds; anything else means all bounds.
  const stringBounds = Array.isArray(record.bounds) && record.bounds.every((bound) => typeof bound === "string");
  const bounds = stringBounds ? AGENT_BOUNDS.filter((bound) => record.bounds.includes(bound)) : [...AGENT_BOUNDS];
  if (bounds.length === 0) return fail("agent_record_invalid", { keyFile });
  return {
    state: "bound",
    agentId: record.agent_id,
    handle: record.handle,
    workloadId: record.workload_id,
    bounds,
    origin: value.origin ?? transportVia(home, record.authority) ?? record.authority,
    keyFile,
    permissions: readCachedPermissions(home, record.agent_id),
  };
}

/** Swift `URL(fileURLWithPath:).standardizedFileURL.path` equivalence. */
function isStandardizedAbsolute(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) return false;
  let normalized = path.posix.normalize(value);
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized === value;
}

function containsSymlinkComponent(absolute) {
  let current = "/";
  for (const component of absolute.split("/").filter(Boolean)) {
    current = path.posix.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // A staged suffix may not exist yet (Swift skips it too).
    }
  }
  return false;
}

/** client/installation.json as read by Swift `FileClientInstallationIdentityStore`. */
function readInstallationIdentity(clientRoot) {
  const filePath = path.join(clientRoot, "installation.json");
  // FileClientInstallationIdentityStore.resolve: 0700 application + client
  // directories, no-follow single-link 0600 owned file of at most 512 bytes.
  const custody = custodyProblem(filePath, {
    maxBytes: INSTALLATION_IDENTITY_MAX_BYTES,
    singleLink: true,
    directories: [path.resolve(clientRoot, ".."), clientRoot],
  });
  if (custody === "absent") return { status: "absent", installationId: null };
  if (custody != null) return { status: "unsafe", installationId: null };
  const { present, value, error } = readJsonFile(filePath);
  if (!present) return { status: "absent", installationId: null };
  if (error != null || !isPlainObject(value) || value.version !== 1
    || typeof value.installationId !== "string" || !INSTALLATION_ID.test(value.installationId)) {
    return { status: "invalid", installationId: null };
  }
  return { status: "present", installationId: value.installationId };
}

/**
 * Lane binding specs mirror Swift `prepareHeadlessWakes` / `prepareCursorAcpWakes`.
 * Any violation makes Swift throw `invalidBootstrap` for the whole lane, so the
 * binding is reported `invalid` (never "bound") with sanitized problem codes.
 */
const BINDING_SPECS = {
  codexHeadless: {
    version: 2,
    commonKeys: ["adapterVersion", "installationId", "workingDirectory", "codexHome", "command", "pollIntervalMs"],
    homeKey: "codexHome",
    requiredProfileKeys: ["profile", "instanceId", "stateRoot"],
    optionalProfileKeys: [],
  },
  cursorAcp: {
    version: 1,
    commonKeys: ["adapterVersion", "installationId", "workingDirectory", "cursorHome", "command", "pollIntervalMs"],
    homeKey: "cursorHome",
    requiredProfileKeys: ["profile", "instanceId", "stateRoot"],
    optionalProfileKeys: ["shadowTestProfile"],
  },
};

function validateProfileBinding(value, spec, { memberProfiles, installation }) {
  const problems = [];
  if (!sameKeys(value, ["version", "common", "profiles"])) problems.push("top_level_keys");
  if (value.version !== spec.version) problems.push("unsupported_version");
  const common = isPlainObject(value.common) ? value.common : null;
  if (common == null || !sameKeys(common, spec.commonKeys)) problems.push("common_keys");
  if (common != null) {
    if (common.adapterVersion !== "1") problems.push("adapter_version");
    if (!Number.isSafeInteger(common.pollIntervalMs) || common.pollIntervalMs < 100 || common.pollIntervalMs > 60_000) {
      problems.push("poll_interval_ms");
    }
    for (const key of ["workingDirectory", spec.homeKey, "command"]) {
      if (typeof common[key] !== "string" || !common[key].startsWith("/") || common[key].includes("\0")) problems.push(`common_${key}`);
    }
    if (installation.status !== "present") problems.push(`installation_identity_${installation.status}`);
    else if (common.installationId !== installation.installationId) problems.push("installation_id_mismatch");
  }
  const rows = Array.isArray(value.profiles) ? value.profiles : null;
  if (rows == null || rows.length === 0 || rows.length > 100) problems.push("profiles_count");
  const allowed = new Set([...spec.requiredProfileKeys, ...spec.optionalProfileKeys]);
  const seen = { profile: new Set(), instanceId: new Set(), stateRoot: new Set() };
  for (const row of rows ?? []) {
    if (!isPlainObject(row) || spec.requiredProfileKeys.some((key) => !Object.hasOwn(row, key))
      || Object.keys(row).some((key) => !allowed.has(key))) {
      problems.push("profile_keys");
      continue;
    }
    if (Object.hasOwn(row, "shadowTestProfile") && typeof row.shadowTestProfile !== "boolean") problems.push("shadow_test_profile");
    if (typeof row.profile !== "string" || typeof row.instanceId !== "string") problems.push("profile_fields");
    if (!isStandardizedAbsolute(row.stateRoot)) problems.push("state_root_not_standardized_absolute");
    else if (containsSymlinkComponent(row.stateRoot)) problems.push("state_root_symlink");
    for (const key of ["profile", "instanceId", "stateRoot"]) {
      if (seen[key].has(row[key])) problems.push(`duplicate_${key}`);
      seen[key].add(row[key]);
    }
    if (typeof row.profile === "string" && !memberProfiles.has(row.profile)) problems.push("entry_not_enabled_lane_member");
  }
  return [...new Set(problems)];
}

function readProfileBinding(filePath, spec, context) {
  const { present, value, error } = readJsonFile(filePath);
  if (!present) return { status: "absent", path: filePath, common: null, profiles: new Map(), problems: [] };
  if (error != null || !isPlainObject(value)) {
    return { status: "unreadable", path: filePath, common: null, profiles: new Map(), problems: ["unreadable"] };
  }
  const profiles = new Map();
  for (const entry of Array.isArray(value.profiles) ? value.profiles : []) {
    if (!isPlainObject(entry) || typeof entry.profile !== "string") continue;
    profiles.set(entry.profile, {
      instanceId: typeof entry.instanceId === "string" ? entry.instanceId : null,
      stateRoot: typeof entry.stateRoot === "string" ? entry.stateRoot : null,
      shadowTestProfile: entry.shadowTestProfile === true,
    });
  }
  const problems = validateProfileBinding(value, spec, context);
  const common = isPlainObject(value.common) ? value.common : {};
  return {
    status: problems.length === 0 ? "present" : "invalid",
    path: filePath,
    version: value.version ?? null,
    problems,
    common: {
      pollIntervalMs: Number.isSafeInteger(common.pollIntervalMs) ? common.pollIntervalMs : null,
      command: typeof common.command === "string" ? common.command : null,
      commandPresent: typeof common.command === "string" && common.command.startsWith("/") && isExecutableFile(common.command),
      installationId: typeof common.installationId === "string" ? common.installationId : null,
    },
    profiles,
  };
}

const APP_SERVER_BINDING_REQUIRED_STRINGS = ["roomScope", "serverIdentity", "threadId"];

/**
 * Mirrors Swift `prepareAppServerWake`: binding and `app-server-ws.token` must
 * both be readable (else members are omitted as binding_missing); then the
 * binding must carry adapterVersion "1", enabled true, non-empty roomScope /
 * serverIdentity / threadId, a ws:// or wss:// endpoint (else invalidBootstrap),
 * and instanceId / agentId / installationId that match the member, its
 * credential and client/installation.json (else binding_mismatch). Token
 * contents are never read; only readability is checked.
 */
function readAppServerBinding(filePath, tokenPath) {
  const base = readSingleBinding(filePath);
  if (base.status !== "present") return base;
  const value = base.value;
  const problems = [];
  if (value.adapterVersion !== "1") problems.push("adapter_version");
  if (value.enabled !== true) problems.push("not_enabled");
  for (const key of APP_SERVER_BINDING_REQUIRED_STRINGS) {
    if (typeof value[key] !== "string" || value[key].length === 0) problems.push(key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  }
  if (typeof value.endpoint !== "string" || !(value.endpoint.startsWith("ws://") || value.endpoint.startsWith("wss://"))) {
    problems.push("endpoint");
  }
  return {
    ...base,
    tokenReadable: isReadableFile(tokenPath),
    agentId: typeof value.agentId === "string" ? value.agentId : null,
    installationId: typeof value.installationId === "string" ? value.installationId : null,
    problems,
  };
}

/** A regular file the current user may execute (what the runtime spawn needs). */
function isExecutableFile(filePath) {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, 1); // X_OK
    return true;
  } catch {
    return false;
  }
}

function isReadableFile(filePath) {
  try {
    accessSync(filePath, 4); // R_OK
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readSingleBinding(filePath) {
  const { present, value, error } = readJsonFile(filePath);
  if (!present) return { status: "absent", path: filePath };
  if (error != null || !isPlainObject(value)) return { status: "unreadable", path: filePath };
  return {
    status: "present",
    path: filePath,
    enabled: value.enabled === true,
    profile: typeof value.profile === "string" ? value.profile : null,
    instanceId: typeof value.instanceId === "string" ? value.instanceId : null,
    value: isPlainObject(value) ? value : {},
  };
}

/**
 * Structural mirror of Swift `FileWorkerCommandResolver.resolve` manifest
 * checks: exact keys, supported version, the exact release environment for the
 * adapter, project root == TRIANGLE_PROJECT_ROOT == first PATH entry parent,
 * content-addressed bundle directory beneath worker-runtime/bundles. Artifact
 * hashes, per-version artifact path sets, and file modes are verified only by
 * the launcher (reported as integrity "not_verified").
 */
function validateWorkerManifest(value, applicationRoot, runtimeAdapter) {
  const problems = [];
  if (!isPlainObject(value) || !sameKeys(value, WORKER_MANIFEST_KEYS)) return ["manifest_keys"];
  if (!WORKER_MANIFEST_VERSIONS.has(value.version)) problems.push("unsupported_version");
  if (typeof value.nodeSHA256 !== "string" || !/^[a-f0-9]{64}$/.test(value.nodeSHA256)) problems.push("node_sha256");
  const env = isPlainObject(value.environment) ? value.environment : null;
  const cli = WORKER_CLI_ENV[runtimeAdapter];
  const requiredEnv = ["PATH", "LANG", "LC_ALL", "TRIANGLE_PROJECT_ROOT", "TRIANGLE_RUNTIME_ROOTS", cli];
  if (env == null || !sameKeys(env, requiredEnv)) problems.push("environment_keys");
  if (env != null && Object.values(env).some((v) => typeof v !== "string" || /[\0\r\n]/.test(v))) problems.push("environment_values");
  const projectRoot = typeof value.projectRoot === "string" ? value.projectRoot : null;
  if (projectRoot == null || !projectRoot.startsWith("/")) problems.push("project_root");
  if (env != null && projectRoot != null) {
    if (env.TRIANGLE_PROJECT_ROOT !== projectRoot) problems.push("project_root_env_mismatch");
    if (typeof env.PATH !== "string" || env.PATH.split(":")[0] !== `${projectRoot}/bin`) problems.push("path_not_project_bin");
  }
  if (projectRoot != null) {
    const bundles = path.join(applicationRoot, "worker-runtime", "bundles");
    if (path.dirname(projectRoot) !== bundles || !/^[a-f0-9]{64}$/.test(path.basename(projectRoot))) problems.push("project_root_not_bundle");
    else if (!existsSync(projectRoot)) problems.push("project_root_missing");
  }
  const artifacts = isPlainObject(value.artifacts) ? value.artifacts : null;
  if (artifacts == null || Object.keys(artifacts).length === 0
    || Object.values(artifacts).some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    problems.push("artifacts");
  }
  return problems;
}

function readWorkerManifest(applicationRoot, runtimeAdapter) {
  if (!Object.hasOwn(WORKER_CLI_ENV, runtimeAdapter ?? "")) {
    return { status: "absent", path: null, problems: [] };
  }
  const filePath = path.join(applicationRoot, "worker-runtime", `${runtimeAdapter}.manifest.json`);
  const { present, value, error } = readJsonFile(filePath);
  if (!present) return { status: "absent", path: filePath, problems: [] };
  if (error != null || value == null) return { status: "unreadable", path: filePath, problems: ["unreadable"] };
  const problems = validateWorkerManifest(value, applicationRoot, runtimeAdapter);
  return {
    status: problems.length === 0 ? "present" : "invalid",
    path: filePath,
    problems,
    version: Number.isSafeInteger(value.version) ? value.version : null,
    artifactCount: isPlainObject(value.artifacts) ? Object.keys(value.artifacts).length : 0,
    integrity: "not_verified",
  };
}

function readClaimerLock(filePath, { pidAlive, advisoryHeldAt }) {
  const { present, value, error } = readJsonFile(filePath);
  if (!present) return null;
  let advisoryHeld = UNAVAILABLE;
  try {
    advisoryHeld = advisoryHeldAt(filePath);
  } catch {
    advisoryHeld = UNAVAILABLE;
  }
  if (error != null || value == null) return { path: filePath, readable: false, advisoryHeld };
  const pid = Number.isSafeInteger(value.pid) ? value.pid : null;
  return {
    path: filePath,
    readable: true,
    advisoryHeld,
    owner: typeof value.owner === "string" ? value.owner : null,
    family: typeof value.family === "string" ? value.family : null,
    pid,
    pidAlive: pid == null ? null : pidAlive(pid),
    acquiredAt: isoOrNull(value.acquiredAt),
    generation: typeof value.generation === "string" ? value.generation : null,
  };
}

/**
 * The newest MAX_JOURNAL_FILES `.json` rows by mtime (readdir order is
 * unspecified), plus the full count. Journal rows are written once by
 * atomic rename, so mtime tracks the record's own timestamp.
 */
function newestJsonFiles(dir, names) {
  const json = names.filter((name) => name.endsWith(".json"));
  if (json.length <= MAX_JOURNAL_FILES) return { total: json.length, newest: json };
  const stamped = [];
  for (const name of json) {
    try {
      stamped.push({ name, mtimeMs: lstatSync(path.join(dir, name)).mtimeMs });
    } catch {
      // Raced away; it is no longer part of the journal.
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { total: json.length, newest: stamped.slice(0, MAX_JOURNAL_FILES).map((row) => row.name) };
}

/** Codex headless drain state root: ownership row + completion journal. */
function readCodexDrainState(stateRoot, now) {
  if (typeof stateRoot !== "string" || !stateRoot.startsWith("/")) return null;
  if (!existsSync(stateRoot)) return { present: false };
  const out = { present: true };
  const owner = readJsonFile(path.join(stateRoot, "profile.json"));
  if (owner.present && owner.value) {
    const leaseExpiresAt = isoOrNull(owner.value.lease_expires_at);
    out.ownership = {
      ownershipState: owner.value.ownership_state ?? null,
      ownerGeneration: Number.isSafeInteger(owner.value.owner_generation) ? owner.value.owner_generation : null,
      runtimeMode: owner.value.runtime_mode ?? null,
      leaseRenewedAt: isoOrNull(owner.value.lease_renewed_at),
      leaseExpiresAt,
      leaseExpired: leaseExpiresAt == null ? null : Date.parse(leaseExpiresAt) < now,
      updatedAt: isoOrNull(owner.value.updated_at),
    };
  }
  const completionsDir = path.join(stateRoot, "completions");
  const completions = listDir(completionsDir);
  if (Array.isArray(completions)) {
    const { total, newest } = newestJsonFiles(completionsDir, completions);
    const stamps = [];
    for (const name of newest) {
      const row = readJsonFile(path.join(completionsDir, name));
      if (row.value) stamps.push(row.value.completed_at);
    }
    out.completions = { count: total, scanned: newest.length, scanLimited: newest.length < total, lastCompletedAt: maxIso(stamps) };
  }
  const conversationsDir = path.join(stateRoot, "conversations");
  const conversations = listDir(conversationsDir);
  if (Array.isArray(conversations)) {
    const { total, newest } = newestJsonFiles(conversationsDir, conversations);
    let active = 0;
    const updated = [];
    for (const name of newest) {
      const row = readJsonFile(path.join(conversationsDir, name));
      if (!row.value) continue;
      if (row.value.active_delivery_id != null) active += 1;
      updated.push(row.value.updated_at);
    }
    out.conversations = {
      count: total,
      scanned: newest.length,
      scanLimited: newest.length < total,
      activeDeliveries: active,
      lastUpdatedAt: maxIso(updated),
    };
  }
  return out;
}

function readGenericStateRoot(stateRoot) {
  if (typeof stateRoot !== "string" || !stateRoot.startsWith("/")) return null;
  const listing = listDir(stateRoot);
  if (listing == null) return { present: false };
  if (!Array.isArray(listing)) return { present: true, readable: false };
  return { present: true, readable: true, entryCount: listing.length };
}

/** Worker antigravity conversation map: room → updatedAt (no bodies). */
function readWorkerConversationActivity(modelInstanceRoot) {
  const listing = listDir(modelInstanceRoot);
  if (!Array.isArray(listing)) return null;
  const file = listing.find((name) => /^triangle-[a-z0-9-]+-conversations\.json$/.test(name));
  if (!file) return null;
  const row = readJsonFile(path.join(modelInstanceRoot, file));
  if (!row.value || typeof row.value.rooms !== "object" || row.value.rooms == null) return null;
  const rooms = Object.values(row.value.rooms);
  return { rooms: rooms.length, lastUpdatedAt: maxIso(rooms.map((room) => room?.updatedAt)) };
}

function prefixedTransactionDigest(prefix, domain, instanceId, deliveryId) {
  const hash = createHash("sha256");
  hash.update(Buffer.from(domain, "utf8"));
  hash.update(Buffer.from([0]));
  hash.update(Buffer.from(instanceId, "utf8"));
  hash.update(Buffer.from([0]));
  hash.update(Buffer.from(String(deliveryId), "utf8"));
  return prefix + hash.digest("hex").slice(0, 32);
}

const OPEN_TXN_KEYS = [
  "version", "instanceId", "protocol", "deliveryId", "roomId", "inboundEventId", "inboundRoomSequence", "replyRequired",
  "claimId", "replyIdempotencyKey", "state", "replyEventId", "replyResolution", "failureCount", "lastFailureReason", "createdAt",
];
const OPEN_TXN_LEGACY_OPTIONAL = new Set(["inboundEventId", "inboundRoomSequence", "replyRequired"]);
const EVENT_ID = /^event_[a-f0-9]{32}$/;

/**
 * Mirrors Swift `MailboxOpenTransaction(from:)` + `FileMailboxTransactionStore.readOpen`
 * (record must belong to this instance). Returns true when Swift would accept it.
 * (Duplicate JSON members, which Swift also rejects, are not detectable via JSON.parse.)
 */
export function isValidOpenTransactionRecord(raw, instanceId) {
  if (!isPlainObject(raw)) return false;
  const keys = Object.keys(raw);
  if (keys.some((key) => !OPEN_TXN_KEYS.includes(key))) return false;
  if (OPEN_TXN_KEYS.some((key) => !OPEN_TXN_LEGACY_OPTIONAL.has(key) && !Object.hasOwn(raw, key))) return false;
  if (raw.version !== 1 || raw.instanceId !== instanceId || !INSTANCE_ID.test(raw.instanceId)) return false;
  if (raw.protocol !== "self-serve-drain" && raw.protocol !== "coordinator-delivery-v1") return false;
  if (!Number.isSafeInteger(raw.deliveryId) || raw.deliveryId <= 0) return false;
  if (typeof raw.roomId !== "string" || !/^room_[a-f0-9]{32}$/.test(raw.roomId)) return false;
  const inboundEvent = raw.inboundEventId ?? null;
  const inboundSeq = raw.inboundRoomSequence ?? null;
  if (inboundEvent !== null && (typeof inboundEvent !== "string" || !EVENT_ID.test(inboundEvent))) return false;
  if ((inboundEvent === null) !== (inboundSeq === null)) return false;
  if (inboundSeq !== null && (!Number.isSafeInteger(inboundSeq) || inboundSeq <= 0)) return false;
  if (Object.hasOwn(raw, "replyRequired") && raw.replyRequired !== null && typeof raw.replyRequired !== "boolean") return false;
  if (raw.claimId !== prefixedTransactionDigest("claim_", "triangle-claim-v1", raw.instanceId, raw.deliveryId)) return false;
  if (raw.replyIdempotencyKey !== prefixedTransactionDigest("reply_", "triangle-reply-v1", raw.instanceId, raw.deliveryId)) return false;
  if (!Number.isSafeInteger(raw.failureCount) || raw.failureCount < 0 || raw.failureCount > 10_000) return false;
  if (raw.lastFailureReason != null && (typeof raw.lastFailureReason !== "string" || !REASON_CODE.test(raw.lastFailureReason))) return false;
  if (typeof raw.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(raw.createdAt)) return false;
  const replyEvent = raw.replyEventId ?? null;
  if (replyEvent !== null && (typeof replyEvent !== "string" || !EVENT_ID.test(replyEvent))) return false;
  const combo = `${raw.state}|${raw.replyResolution}|${replyEvent === null ? "nil" : "some"}`;
  return ["prepared|none|nil", "claimed|none|nil", "replied|created|some", "replied|idempotency_conflict|some"].includes(combo);
}

function readOpenTransaction(modelInstanceRoot, now, instanceId) {
  const dir = path.join(modelInstanceRoot, "mailbox-transactions");
  const openPath = path.join(dir, "open.json");
  const quarantine = listDir(path.join(dir, "quarantine"));
  const quarantinedCount = Array.isArray(quarantine) ? quarantine.length : 0;
  // FileMailboxTransactionStore.readOpen: 0700 managed directories down to
  // mailbox-transactions, no-follow single-link 0600 owned file <= 4096 bytes.
  const applicationRoot = path.resolve(modelInstanceRoot, "..", "..", "..");
  const custody = custodyProblem(openPath, {
    maxBytes: OPEN_TXN_MAX_BYTES,
    singleLink: true,
    directories: [applicationRoot, path.join(applicationRoot, "model-state"), path.dirname(modelInstanceRoot), modelInstanceRoot, dir],
  });
  if (custody === "absent") return { open: null, quarantinedCount, journalPresent: existsSync(dir) };
  if (custody != null) return { open: { readable: false, reason: custody }, quarantinedCount, journalPresent: true };
  const row = readJsonFile(openPath);
  if (row.value == null) return { open: { readable: false, reason: "unreadable" }, quarantinedCount, journalPresent: true };
  const raw = row.value;
  if (!isValidOpenTransactionRecord(raw, instanceId)) {
    // Swift readOpen throws invalidRecord: recovery cannot proceed.
    return { open: { readable: false, reason: "invalid_record" }, quarantinedCount, journalPresent: true };
  }
  return {
    journalPresent: true,
    quarantinedCount,
    open: {
      readable: true,
      state: raw.state,
      protocol: raw.protocol,
      deliveryId: raw.deliveryId,
      replyRequired: typeof raw.replyRequired === "boolean" ? raw.replyRequired : true,
      replyResolved: raw.replyEventId != null,
      failureCount: raw.failureCount,
      lastFailureReason: raw.lastFailureReason ?? null,
      createdAt: isoOrNull(raw.createdAt),
      ageMs: ageMs(raw.createdAt, now),
    },
  };
}

/**
 * Open-transaction health policy, applied identically to every lane that uses
 * the helper mailbox-transaction journal (Codex headless, Cursor ACP, worker,
 * event-driven). Only an *outstanding* transaction (a readable open.json) is
 * judged; an idle profile whose journal holds no open transaction is never
 * stalled, however old its last completed work is. Historical claim/reply/ack
 * timestamps never excuse an outstanding transaction.
 *
 *   stuck            failureCount >= 5 (the helper's own `isStuck`)   hard
 *   stalled_failing  age > maxOpenTxnAgeMs and failureCount >= 1      hard
 *   stalled          age > maxOpenTxnAgeMs, no recorded failure        soft
 *   failing          failureCount >= 1 within the age budget           soft
 *   age_unavailable  open.json without a valid createdAt               soft
 *   ok               within budget, no failures
 *   none             no open transaction
 */
export function evaluateOpenTransaction(open, { maxOpenTxnAgeMs = DEFAULT_MAX_OPEN_TXN_AGE_MS } = {}) {
  if (open == null) return { verdict: "none", fault: null };
  if (open.readable === false) return { verdict: "unreadable", fault: null }; // reported as unreadable_custody
  const failures = Number.isSafeInteger(open.failureCount) ? open.failureCount : 0;
  const age = Number.isFinite(open.ageMs) ? open.ageMs : null;
  const detail = `state=${open.state ?? "unknown"} ageMs=${age ?? UNAVAILABLE} failures=${failures}${open.lastFailureReason ? ` last=${open.lastFailureReason}` : ""} budgetMs=${maxOpenTxnAgeMs}`;
  if (failures >= OPEN_TRANSACTION_MAX_FAILURES_BEFORE_STUCK) {
    return { verdict: "stuck", fault: { code: "open_transaction_stuck", hard: true, reason: `open transaction stuck (${detail})` } };
  }
  const overAge = age != null && age > maxOpenTxnAgeMs;
  if (overAge && failures > 0) {
    return { verdict: "stalled_failing", fault: { code: "open_transaction_stalled", hard: true, reason: `open transaction stalled and failing (${detail})` } };
  }
  if (overAge) {
    return { verdict: "stalled", fault: { code: "open_transaction_stalled", hard: false, reason: `open transaction older than budget (${detail})` } };
  }
  if (failures > 0) {
    return { verdict: "failing", fault: { code: "open_transaction_failing", hard: false, reason: `open transaction has recorded failures (${detail})` } };
  }
  if (age == null) {
    return { verdict: "age_unavailable", fault: { code: "open_transaction_age_unavailable", hard: false, reason: `open transaction age unknown (${detail})` } };
  }
  return { verdict: "ok", fault: null };
}

function laneBinding(entry, lanes, applicationRoot, { identity = null, installation = null } = {}) {
  const { lane } = classifyLane(entry);
  if (lane === "codex-headless" || lane === "cursor-acp") {
    const source = lane === "codex-headless" ? lanes.codexHeadless : lanes.cursorAcp;
    if (source.status !== "present") {
      return {
        kind: lane,
        status: source.status === "absent" ? "missing" : source.status,
        path: source.path,
        ...(source.problems?.length ? { problems: source.problems } : {}),
      };
    }
    const row = source.profiles.get(entry.profile);
    if (!row) return { kind: lane, status: "missing", path: source.path };
    if (row.instanceId !== entry.instanceId) {
      return { kind: lane, status: "instance_id_mismatch", path: source.path, stateRoot: row.stateRoot };
    }
    return {
      kind: lane,
      status: "bound",
      path: source.path,
      stateRoot: row.stateRoot,
      shadowTestProfile: row.shadowTestProfile,
      pollIntervalMs: source.common.pollIntervalMs,
      commandPresent: source.common.commandPresent,
    };
  }
  if (lane === "worker" || lane === "event-driven") {
    const manifest = readWorkerManifest(applicationRoot, entry.runtimeAdapter);
    return {
      kind: "worker-runtime-manifest",
      status: manifest.status === "present" ? "bound" : manifest.status === "absent" ? "missing" : manifest.status,
      path: manifest.path,
      manifestVersion: manifest.version ?? null,
      artifactCount: manifest.artifactCount ?? null,
      ...(manifest.problems?.length ? { problems: manifest.problems } : {}),
      ...(manifest.integrity ? { integrity: manifest.integrity } : {}),
    };
  }
  if (lane === "app-server") {
    const b = lanes.appServer;
    if (b.status !== "present") return { kind: lane, status: b.status === "absent" ? "missing" : b.status, path: b.path };
    if (!b.tokenReadable) return { kind: lane, status: "missing", path: b.path, problems: ["auth_token_file_unreadable"] };
    if (installation?.status !== "present") {
      return { kind: lane, status: "invalid", path: b.path, problems: ["installation_identity_absent"] };
    }
    if (b.instanceId !== entry.instanceId) return { kind: lane, status: "missing", path: b.path };
    const mismatch = [];
    if (b.installationId !== installation.installationId) mismatch.push("installation_id_mismatch");
    // Swift compares agentId with the verified credential; the bound agent
    // record stands in for it here (no network).
    if (b.agentId == null || !AGENT_ID.test(b.agentId)) mismatch.push("agent_id");
    else if (identity?.state === "bound" && identity.agentId !== b.agentId) mismatch.push("agent_id_mismatch");
    if (mismatch.length > 0) return { kind: lane, status: "instance_id_mismatch", path: b.path, problems: mismatch };
    if (b.problems.length > 0) return { kind: lane, status: "invalid", path: b.path, problems: b.problems };
    return { kind: lane, status: "bound", path: b.path };
  }
  if (lane === "grok-bot") {
    const b = lanes.grokBot;
    return { kind: lane, status: b.status === "present" ? (b.enabled ? "bound" : "binding_disabled") : "missing", path: b.path };
  }
  return { kind: lane, status: UNSUPPORTED, path: null };
}

/**
 * @returns {object} frozen-friendly plain object. See module doc for contract.
 */
export function readInstallationInventory({
  clientRoot,
  now = Date.now(),
  pidAlive,
  advisoryHeldAt,
  progress = null,
  maxOpenTxnAgeMs = DEFAULT_MAX_OPEN_TXN_AGE_MS,
} = {}) {
  if (typeof clientRoot !== "string" || !clientRoot.startsWith("/")) {
    throw new TypeError("clientRoot must be an absolute path");
  }
  if (typeof pidAlive !== "function" || typeof advisoryHeldAt !== "function") {
    throw new TypeError("pidAlive and advisoryHeldAt are required");
  }
  if (typeof maxOpenTxnAgeMs !== "number" || !Number.isFinite(maxOpenTxnAgeMs) || maxOpenTxnAgeMs <= 0) {
    throw new TypeError("maxOpenTxnAgeMs must be a positive finite number");
  }
  const applicationRoot = path.resolve(clientRoot, "..");
  const registry = readRegistry(clientRoot);
  const custody = readProfileBindings(applicationRoot);
  const installation = readInstallationIdentity(clientRoot);
  // Swift lane membership (`participatesInHeadlessWake` / `participatesInCursorAcpWake`).
  const validEntries = registry.entries.filter((entry) => entry.valid && entry.enabled);
  const laneMembers = {
    codexHeadless: new Set(validEntries.filter((e) => e.runtimeAdapter === "codex" && e.deliveryMode === "headless-app-server").map((e) => e.profile)),
    cursorAcp: new Set(validEntries.filter((e) => e.runtimeAdapter === "cursor-acp" && e.deliveryMode === "headless-cursor-acp").map((e) => e.profile)),
  };
  const lanes = {
    codexHeadless: readProfileBinding(path.join(clientRoot, "headless-runtime-binding.json"), BINDING_SPECS.codexHeadless,
      { memberProfiles: laneMembers.codexHeadless, installation }),
    cursorAcp: readProfileBinding(path.join(clientRoot, "cursor-acp-runtime-binding.json"), BINDING_SPECS.cursorAcp,
      { memberProfiles: laneMembers.cursorAcp, installation }),
    appServer: readAppServerBinding(path.join(clientRoot, "app-server-binding.json"), path.join(clientRoot, "app-server-ws.token")),
    grokBot: readSingleBinding(path.join(clientRoot, "grok-bot-binding.json")),
  };
  const blockers = [];
  const warnings = [];
  const profiles = [];
  const registeredProfiles = new Set();

  if (registry.status === "absent") {
    blockers.push({ code: "registry_absent", message: "installation registry client/instances is missing; inventory cannot be complete" });
  } else if (registry.status === "unreadable") {
    blockers.push({ code: "registry_unreadable", message: "installation registry client/instances is unreadable" });
  } else if (registry.status === "unsafe") {
    blockers.push({ code: "registry_unsafe", message: `installation registry storage is unsafe (${registry.unsafeDirectoryCount} directory(ies) not 0700/owned/real)` });
  } else if (registry.entries.length === 0) {
    blockers.push({ code: "registry_empty", message: "installation registry has no profiles" });
  }
  if (registry.strayNames?.length > 0) {
    // Swift list() throws invalidRecord on any non-instance file name.
    blockers.push({ code: "registry_stray_file", message: `installation registry contains ${registry.strayNames.length} non-instance file(s)` });
  }
  if (custody.status !== "present") {
    warnings.push({ code: "profile_bindings_unavailable", message: `helper profile bindings (profiles-v1) ${custody.status}` });
  }
  for (const [key, label] of [["codexHeadless", "headless-runtime-binding.json"], ["cursorAcp", "cursor-acp-runtime-binding.json"]]) {
    const { status, problems } = lanes[key];
    if (status !== "unreadable" && status !== "invalid") continue;
    // Swift only reads a lane binding when the lane has enabled members; then
    // any violation throws invalidBootstrap for the whole lane.
    const row = {
      code: status === "unreadable" ? "binding_unreadable" : "binding_invalid",
      message: `${label} ${status}${problems.length ? `: ${problems.join(",")}` : ""}`,
    };
    (laneMembers[key].size > 0 ? blockers : warnings).push(row);
  }

  for (const entry of registry.entries) {
    if (!entry.valid) {
      blockers.push({
        code: "registry_entry_invalid",
        message: `registry entry ${entry.file.slice(0, 12)}… invalid: ${entry.problems.join(",")}`,
        profile: entry.profile,
      });
      profiles.push({
        profile: entry.profile ?? `(invalid:${entry.file.slice(0, 12)})`,
        status: "fault",
        registry: { valid: false, problems: entry.problems },
      });
      continue;
    }
    registeredProfiles.add(entry.profile);
    const classification = classifyLane(entry);
    const identity = custody.byProfile.get(entry.profile) ?? null;
    const binding = laneBinding(entry, lanes, applicationRoot, { identity, installation });
    const modelInstanceRoot = path.join(applicationRoot, "model-state", "instances", entry.instanceId);
    const transactions = readOpenTransaction(modelInstanceRoot, now, entry.instanceId);
    const openTxnHealth = evaluateOpenTransaction(transactions.open, { maxOpenTxnAgeMs });
    const credential = identity == null ? "unbound"
      : identity.state === "bound" ? "key_file_present"
        : identity.state === "key_missing" ? "key_file_missing"
          : identity.state === "key_unsafe" ? "key_file_unsafe" : UNAVAILABLE;

    const claimers = [];
    for (const prefix of ["headless-claimer", "cursor-acp-claimer"]) {
      const lock = readClaimerLock(path.join(clientRoot, `${prefix}.${entry.profile}.json`), { pidAlive, advisoryHeldAt });
      if (lock) claimers.push({ lock: prefix, ...lock });
    }
    const heldClaimers = claimers.filter((c) => c.advisoryHeld === true);
    const heldClaimer = heldClaimers[0] ?? null;

    let drain = null;
    if (binding.status === "bound" && classification.lane === "codex-headless") {
      drain = readCodexDrainState(binding.stateRoot, now);
    } else if (binding.status === "bound" && classification.lane === "cursor-acp") {
      drain = readGenericStateRoot(binding.stateRoot);
    }
    const workerActivity = classification.lane === "worker" ? readWorkerConversationActivity(modelInstanceRoot) : null;
    const profileProgress = progress?.profiles?.[entry.profile] ?? null;

    // Effective poll/watch: what the registry+binding select. Live watch
    // connection/grant health is only known if a progress journal supplies it.
    let pollWatch;
    if (classification.lane === "codex-headless") {
      pollWatch = { mode: "watch+poll", pollIntervalMs: binding.pollIntervalMs ?? UNAVAILABLE, watchMember: binding.status === "bound" };
    } else if (classification.lane === "cursor-acp") {
      pollWatch = { mode: "watch+poll", pollIntervalMs: binding.pollIntervalMs ?? UNAVAILABLE, watchMember: binding.status === "bound" };
    } else if (classification.lane === "worker") {
      pollWatch = { mode: "poll", pollIntervalMs: UNAVAILABLE, watchMember: false };
    } else if (classification.lane === "event-driven") {
      pollWatch = { mode: "watch", pollIntervalMs: UNSUPPORTED, watchMember: true };
    } else if (classification.lane === "app-server") {
      // WatchGrantService.appServerBoundInteractiveMembers: readable binding whose instanceId matches.
      const member = lanes.appServer.status === "present" && lanes.appServer.instanceId === entry.instanceId;
      pollWatch = { mode: "watch", pollIntervalMs: UNSUPPORTED, watchMember: member };
    } else {
      pollWatch = { mode: UNSUPPORTED, pollIntervalMs: UNSUPPORTED, watchMember: false };
    }
    pollWatch.watchConnection = progress?.watch?.connection ?? UNAVAILABLE;
    pollWatch.grantHealth = progress?.watch?.grantHealth ?? UNAVAILABLE;
    if (!entry.enabled) pollWatch = { mode: "not_started_disabled", pollIntervalMs: UNSUPPORTED, watchMember: false, watchConnection: UNSUPPORTED, grantHealth: UNSUPPORTED };

    const codexReplyAt = drain?.completions?.lastCompletedAt ?? null;
    const activity = {
      lastClaimAt: isoOrNull(profileProgress?.lastClaimAt) ?? UNAVAILABLE,
      lastReplyAt: isoOrNull(profileProgress?.lastReplyAt) ?? codexReplyAt ?? UNAVAILABLE,
      lastReplySource: isoOrNull(profileProgress?.lastReplyAt) ? "progress" : codexReplyAt ? "completion_journal" : null,
      lastAckAt: isoOrNull(profileProgress?.lastAckAt) ?? UNAVAILABLE,
      lastConversationUpdateAt:
        drain?.conversations?.lastUpdatedAt ?? workerActivity?.lastUpdatedAt ?? UNAVAILABLE,
      pendingCount: Number.isSafeInteger(profileProgress?.pendingCount) ? profileProgress.pendingCount : UNAVAILABLE,
      oldestPendingAgeMs: ageMs(profileProgress?.oldestPendingAt, now) ?? UNAVAILABLE,
      openTransactionAgeMs: transactions.open?.ageMs ?? (transactions.open ? UNAVAILABLE : null),
      openTransactionFailureCount: transactions.open?.failureCount ?? null,
      openTransactionHealth: openTxnHealth.verdict,
      maxOpenTransactionAgeMs: maxOpenTxnAgeMs,
      retryExpiry: UNAVAILABLE,
    };
    const hasProgressEvidence = [activity.lastClaimAt, activity.lastReplyAt, activity.lastAckAt]
      .some((value) => value !== UNAVAILABLE);

    const faults = [];
    const notes = [];
    const sameOwnerAliases = heldClaimers.length > 1 && heldClaimers.every(c =>
      Number.isSafeInteger(c.pid) && c.pid > 1 && c.pid === heldClaimers[0].pid &&
      typeof c.owner === "string" && c.owner.length > 0 && c.owner === heldClaimers[0].owner &&
      ["codex", "cursor-acp"].includes(c.family) && c.family === heldClaimers[0].family);
    if (heldClaimers.length > 1 && !sameOwnerAliases) {
      // Both claimer families hold advisory locks for one profile, whatever its lane.
      faults.push({ code: "dual_claimer_conflict", hard: true, reason: `held: ${heldClaimers.map((c) => c.lock).join(",")}` });
    }
    if (entry.enabled) {
      if (classification.support === "unsupported") {
        faults.push({ code: "lane_unsupported", hard: true, reason: classification.reason });
      }
      if (!["bound", UNAVAILABLE, UNSUPPORTED].includes(binding.status)) {
        const code = binding.status === "instance_id_mismatch" ? "binding_mismatch"
          : binding.status === "missing" || binding.status === "binding_disabled" ? "binding_missing"
            : "binding_invalid";
        faults.push({ code, hard: true, reason: `${binding.kind}:${binding.status}${binding.problems ? `:${binding.problems.join(",")}` : ""}` });
      }
      if (binding.status === "bound" && binding.commandPresent === false) {
        faults.push({ code: "runtime_command_missing", hard: true, reason: binding.kind });
      }
      if (identity == null) {
        faults.push({ code: "profile_unbound", hard: true, reason: "no helper profile binding (triangle-mailbox bind)" });
      } else if (identity.state !== "bound") {
        faults.push({ code: "profile_custody_invalid", hard: true, reason: identity.state });
      }
      if (transactions.open?.readable === false) {
        faults.push({ code: "unreadable_custody", hard: true, reason: `open transaction ${transactions.open.reason ?? "unreadable"}` });
      }
      // Outstanding-work policy for every lane (see evaluateOpenTransaction);
      // independent of, and not excused by, historical progress timestamps.
      if (openTxnHealth.fault != null && classification.support !== "unsupported") {
        faults.push(openTxnHealth.fault);
      }
      if ((classification.lane === "codex-headless" || classification.lane === "cursor-acp") && binding.status === "bound" && heldClaimer == null) {
        faults.push({ code: "claimer_not_held", hard: false, reason: "no advisory claimer lock currently held" });
      }
      if (classification.support !== "unsupported" && !hasProgressEvidence) {
        faults.push({ code: "progress_evidence_unavailable", hard: false, reason: "no claim/reply/ack evidence in local journal" });
      }
      if (classification.support === "experimental") notes.push(classification.reason);
    }
    if (drain?.ownership?.leaseExpired === true) notes.push("headless_ownership_lease_expired");
    if (!entry.enabled && transactions.open != null) notes.push(`open_transaction_while_disabled:${openTxnHealth.verdict}`);

    const status = !entry.enabled
      ? "disabled"
      : faults.some((f) => f.hard)
        ? (classification.support === "unsupported" ? "unsupported" : "fault")
        : faults.length > 0
          ? "degraded"
          : "ok";

    for (const fault of faults) {
      (fault.hard ? blockers : warnings).push({
        code: fault.code,
        message: `${entry.profile}: ${fault.reason}`,
        profile: entry.profile,
      });
    }

    profiles.push({
      profile: entry.profile,
      status,
      instanceId: entry.instanceId,
      runtimeAdapter: entry.runtimeAdapter,
      deliveryMode: entry.deliveryMode,
      deliveryModeSource: entry.deliveryModeSource,
      enabled: entry.enabled,
      lane: classification.lane,
      support: classification.support,
      identity: identity
        ? {
          state: identity.state,
          agentId: identity.agentId,
          handle: identity.handle,
          ...(identity.state === "bound" ? { workloadId: identity.workloadId, bounds: identity.bounds, origin: identity.origin } : {}),
        }
        : { state: "unbound" },
      credential,
      // Last view `triangle permissions` cached on this device (no network here).
      permissions: identity?.permissions ?? { source: UNAVAILABLE },
      binding,
      owner: {
        supervisorAdmission: UNAVAILABLE,
        claimers: claimers.map((c) => ({
          lock: c.lock,
          advisoryHeld: c.advisoryHeld,
          owner: c.owner ?? null,
          family: c.family ?? null,
          pid: c.pid ?? null,
          pidAlive: c.pidAlive ?? null,
          acquiredAt: c.acquiredAt ?? null,
          generation: c.generation ?? UNAVAILABLE,
        })),
        headlessOwnership: drain?.ownership ?? (classification.lane === "codex-headless" ? UNAVAILABLE : UNSUPPORTED),
      },
      pollWatch,
      activity,
      journal: {
        completions: drain?.completions ?? null,
        conversations: drain?.conversations ?? workerActivity ?? null,
        stateRoot: drain && classification.lane === "cursor-acp" ? drain : undefined,
        openTransaction: transactions.open,
        quarantinedCount: transactions.quarantinedCount,
      },
      faults: faults.map((f) => f.code),
      notes,
    });
  }

  // Bindings that name profiles the registry does not contain.
  const orphans = [];
  for (const [kind, source] of [["codex-headless", lanes.codexHeadless], ["cursor-acp", lanes.cursorAcp]]) {
    if (source.status !== "present" && source.status !== "invalid") continue;
    for (const profile of source.profiles.keys()) {
      if (!registeredProfiles.has(profile)) {
        orphans.push({ kind, profile });
        warnings.push({ code: "binding_orphan", message: `${kind} binding lists ${profile} which is not in the installation registry`, profile });
      }
    }
  }
  const boundUnregistered = [...custody.byProfile.entries()]
    .filter(([profile, row]) => row.state === "bound" && !registeredProfiles.has(profile))
    .map(([profile]) => profile)
    .sort();

  return {
    applicationRoot,
    registry: { status: registry.status, path: registry.path, count: registry.entries.length, strayFileCount: registry.strayNames?.length ?? 0 },
    installationIdentity: installation.status,
    bindings: {
      codexHeadless: { status: lanes.codexHeadless.status, profiles: [...lanes.codexHeadless.profiles.keys()] },
      cursorAcp: { status: lanes.cursorAcp.status, profiles: [...lanes.cursorAcp.profiles.keys()] },
      appServer: { status: lanes.appServer.status, enabled: lanes.appServer.enabled ?? null },
      grokBot: { status: lanes.grokBot.status, enabled: lanes.grokBot.enabled ?? null },
    },
    profiles: profiles.sort((a, b) => String(a.profile).localeCompare(String(b.profile))),
    orphanBindings: orphans,
    boundUnregistered,
    blockers,
    warnings,
  };
}

/** Defense in depth for output: drop any secret-looking key. */
export function stripSecretKeys(value) {
  if (Array.isArray(value)) return value.map(stripSecretKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (inner === undefined) continue;
      if (SECRETISH_KEY.test(key) && key !== "credential") continue;
      out[key] = stripSecretKeys(inner);
    }
    return out;
  }
  return value;
}


