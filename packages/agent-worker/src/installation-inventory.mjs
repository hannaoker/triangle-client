/**
 * Read-only installation inventory for doctor/status.
 *
 * Enumerates the full installation registry (`client/instances/*.json`), the
 * enrollment journal, and every lane-specific binding (Codex v2 headless,
 * Cursor ACP, worker runtime manifests, App Server, Grok Bot), then reconciles
 * each registered profile with the binding its runtime/delivery mode requires.
 *
 * Contract:
 * - READ-ONLY. Only stat/read/readdir calls. No writes, renames, mkdirs,
 *   lock acquisition, process launches, Keychain or network access.
 * - Never returns credential material or message bodies. Credential files are
 *   checked for existence only; their contents are never opened.
 * - Every field that the local journal/registry does not supply is reported as
 *   the literal string "unavailable" (or "unsupported" for lanes with no such
 *   concept). Nothing is inferred from absence.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const UNAVAILABLE = "unavailable";
export const UNSUPPORTED = "unsupported";

const INSTANCE_ID = /^[a-f0-9]{64}$/;
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_JOURNAL_FILES = 5000;
const SECRETISH_KEY = /token|secret|password|private|bearer|credential|key$/i;

/** Mirrors Swift `ClientInstanceID.derive(profile:)`. */
export function deriveClientInstanceId(profile) {
  const hash = createHash("sha256");
  hash.update(Buffer.from("triangle-client-instance-v1", "utf8"));
  hash.update(Buffer.from([0]));
  hash.update(Buffer.from(profile, "utf8"));
  return hash.digest("hex");
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

function hexProfile(profile) {
  return Buffer.from(profile, "utf8").toString("hex");
}

function decodeHexProfile(hex) {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  const text = Buffer.from(hex, "hex").toString("utf8");
  return PROFILE_NAME.test(text) ? text : null;
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
  if (deliveryMode === "event-driven") return { lane: "event-driven", support: "supported", reason: null };
  if (deliveryMode === "mcp-interactive") return { lane: "app-server", support: "supported", reason: null };
  if (deliveryMode === "grok-bot") {
    return { lane: "grok-bot", support: "unsupported", reason: "grok_bot_wake_path_removed" };
  }
  return { lane: "unknown", support: "unsupported", reason: "unknown_delivery_mode" };
}

function readRegistry(clientRoot) {
  const dir = path.join(clientRoot, "instances");
  const listing = listDir(dir);
  if (listing == null) return { status: "absent", path: dir, entries: [] };
  if (!Array.isArray(listing)) return { status: "unreadable", path: dir, entries: [], error: listing.error };
  const entries = [];
  for (const name of listing.sort()) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(dir, name);
    const fileId = name.slice(0, -".json".length);
    const { value, error } = readJsonFile(filePath);
    const problems = [];
    if (error != null || value == null || typeof value !== "object") {
      entries.push({ file: name, fileId, profile: null, valid: false, problems: ["unreadable"] });
      continue;
    }
    if (value.version !== 1) problems.push("unsupported_version");
    if (typeof value.profile !== "string" || !PROFILE_NAME.test(value.profile)) problems.push("invalid_profile");
    if (typeof value.instanceId !== "string" || !INSTANCE_ID.test(value.instanceId)) problems.push("invalid_instance_id");
    if (typeof value.enabled !== "boolean") problems.push("invalid_enabled");
    if (typeof value.runtimeAdapter !== "string") problems.push("invalid_runtime_adapter");
    if (value.instanceId !== fileId) problems.push("file_name_instance_id_mismatch");
    if (typeof value.profile === "string" && PROFILE_NAME.test(value.profile)
      && value.instanceId !== deriveClientInstanceId(value.profile)) {
      problems.push("instance_id_not_derived_from_profile");
    }
    // Legacy rows without deliveryMode get the Swift default for their adapter.
    let deliveryMode = typeof value.deliveryMode === "string" ? value.deliveryMode : null;
    let deliveryModeSource = "registry";
    if (deliveryMode == null) {
      deliveryModeSource = "adapter_default";
      deliveryMode = {
        codex: "headless-app-server",
        "grok-bot": "grok-bot",
        "cursor-acp": "headless-cursor-acp",
        hermes: "worker",
        antigravity: "worker",
      }[value.runtimeAdapter] ?? null;
    }
    entries.push({
      file: name,
      fileId,
      profile: typeof value.profile === "string" ? value.profile : null,
      instanceId: typeof value.instanceId === "string" ? value.instanceId : null,
      runtimeAdapter: typeof value.runtimeAdapter === "string" ? value.runtimeAdapter : null,
      deliveryMode,
      deliveryModeSource,
      enabled: typeof value.enabled === "boolean" ? value.enabled : null,
      valid: problems.length === 0,
      problems,
    });
  }
  return { status: "present", path: dir, entries };
}

function readEnrollmentJournal(applicationRoot) {
  const dir = path.join(applicationRoot, "enrollment-journal");
  const listing = listDir(dir);
  const byProfile = new Map();
  if (listing == null) return { status: "absent", path: dir, byProfile };
  if (!Array.isArray(listing)) return { status: "unreadable", path: dir, byProfile };
  for (const name of listing) {
    const match = /^profile-([0-9a-f]+)\.json$/.exec(name);
    if (!match) continue; // backups (*.bak-*) are never authoritative
    const profile = decodeHexProfile(match[1]);
    if (profile == null) continue;
    const { value, error } = readJsonFile(path.join(dir, name));
    if (error != null || value == null) {
      byProfile.set(profile, { state: "unreadable", reasonCode: null, agentId: null, handle: null });
      continue;
    }
    byProfile.set(profile, {
      state: typeof value.state === "string" ? value.state : null,
      reasonCode: typeof value.reasonCode === "string" ? value.reasonCode : null,
      agentId: typeof value.agentID === "string" ? value.agentID : null,
      handle: typeof value.handle === "string" ? value.handle : null,
      origin: typeof value.origin === "string" ? value.origin : null,
    });
  }
  return { status: "present", path: dir, byProfile };
}

function readProfileBinding(filePath, expectedVersion) {
  const { present, value, error } = readJsonFile(filePath);
  if (!present) return { status: "absent", path: filePath, common: null, profiles: new Map() };
  if (error != null || value == null || typeof value !== "object") {
    return { status: "unreadable", path: filePath, common: null, profiles: new Map() };
  }
  if (value.version !== expectedVersion || !Array.isArray(value.profiles)) {
    return { status: "unsupported_version", path: filePath, version: value.version ?? null, common: null, profiles: new Map() };
  }
  const profiles = new Map();
  for (const entry of value.profiles) {
    if (!entry || typeof entry.profile !== "string") continue;
    profiles.set(entry.profile, {
      instanceId: typeof entry.instanceId === "string" ? entry.instanceId : null,
      stateRoot: typeof entry.stateRoot === "string" ? entry.stateRoot : null,
      shadowTestProfile: entry.shadowTestProfile === true,
    });
  }
  const common = value.common && typeof value.common === "object" ? value.common : {};
  return {
    status: "present",
    path: filePath,
    version: value.version,
    common: {
      pollIntervalMs: Number.isSafeInteger(common.pollIntervalMs) ? common.pollIntervalMs : null,
      command: typeof common.command === "string" ? common.command : null,
      commandPresent: typeof common.command === "string" && common.command.startsWith("/") && existsSync(common.command),
      installationId: typeof common.installationId === "string" ? common.installationId : null,
    },
    profiles,
  };
}

function readSingleBinding(filePath) {
  const { present, value, error } = readJsonFile(filePath);
  if (!present) return { status: "absent", path: filePath };
  if (error != null || value == null) return { status: "unreadable", path: filePath };
  return {
    status: "present",
    path: filePath,
    enabled: value.enabled === true,
    profile: typeof value.profile === "string" ? value.profile : null,
    instanceId: typeof value.instanceId === "string" ? value.instanceId : null,
  };
}

function readWorkerManifest(applicationRoot, runtimeAdapter) {
  if (typeof runtimeAdapter !== "string" || !/^[a-z0-9-]+$/.test(runtimeAdapter)) {
    return { status: "absent", path: null };
  }
  const filePath = path.join(applicationRoot, "worker-runtime", `${runtimeAdapter}.manifest.json`);
  const { present, value, error } = readJsonFile(filePath);
  if (!present) return { status: "absent", path: filePath };
  if (error != null || value == null) return { status: "unreadable", path: filePath };
  return {
    status: "present",
    path: filePath,
    version: Number.isSafeInteger(value.version) ? value.version : null,
    artifactCount: value.artifacts && typeof value.artifacts === "object" ? Object.keys(value.artifacts).length : 0,
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
  const completions = listDir(path.join(stateRoot, "completions"));
  if (Array.isArray(completions)) {
    const files = completions.filter((name) => name.endsWith(".json")).slice(0, MAX_JOURNAL_FILES);
    const stamps = [];
    for (const name of files) {
      const row = readJsonFile(path.join(stateRoot, "completions", name));
      if (row.value) stamps.push(row.value.completed_at);
    }
    out.completions = { count: files.length, lastCompletedAt: maxIso(stamps) };
  }
  const conversations = listDir(path.join(stateRoot, "conversations"));
  if (Array.isArray(conversations)) {
    let active = 0;
    const updated = [];
    for (const name of conversations.filter((n) => n.endsWith(".json")).slice(0, MAX_JOURNAL_FILES)) {
      const row = readJsonFile(path.join(stateRoot, "conversations", name));
      if (!row.value) continue;
      if (row.value.active_delivery_id != null) active += 1;
      updated.push(row.value.updated_at);
    }
    out.conversations = { count: updated.length, activeDeliveries: active, lastUpdatedAt: maxIso(updated) };
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

function readOpenTransaction(modelInstanceRoot, now) {
  const dir = path.join(modelInstanceRoot, "mailbox-transactions");
  const openPath = path.join(dir, "open.json");
  const quarantine = listDir(path.join(dir, "quarantine"));
  const quarantinedCount = Array.isArray(quarantine) ? quarantine.length : 0;
  const row = readJsonFile(openPath);
  if (!row.present) return { open: null, quarantinedCount, journalPresent: existsSync(dir) };
  if (row.value == null) return { open: { readable: false }, quarantinedCount, journalPresent: true };
  const raw = row.value;
  return {
    journalPresent: true,
    quarantinedCount,
    open: {
      readable: true,
      state: typeof raw.state === "string" ? raw.state : null,
      protocol: typeof raw.protocol === "string" ? raw.protocol : null,
      deliveryId: Number.isSafeInteger(raw.deliveryId) ? raw.deliveryId : null,
      replyRequired: typeof raw.replyRequired === "boolean" ? raw.replyRequired : null,
      replyResolved: raw.replyEventId != null,
      failureCount: Number.isSafeInteger(raw.failureCount) ? raw.failureCount : null,
      lastFailureReason: typeof raw.lastFailureReason === "string" ? raw.lastFailureReason.slice(0, 80) : null,
      createdAt: isoOrNull(raw.createdAt),
      ageMs: ageMs(raw.createdAt, now),
    },
  };
}

function laneBinding(entry, lanes, applicationRoot) {
  const { lane } = classifyLane(entry);
  if (lane === "codex-headless" || lane === "cursor-acp") {
    const source = lane === "codex-headless" ? lanes.codexHeadless : lanes.cursorAcp;
    if (source.status !== "present") {
      return { kind: lane, status: source.status === "absent" ? "missing" : source.status, path: source.path };
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
  if (lane === "worker") {
    const manifest = readWorkerManifest(applicationRoot, entry.runtimeAdapter);
    return {
      kind: "worker-runtime-manifest",
      status: manifest.status === "present" ? "bound" : manifest.status === "absent" ? "missing" : manifest.status,
      path: manifest.path,
      manifestVersion: manifest.version ?? null,
      artifactCount: manifest.artifactCount ?? null,
    };
  }
  if (lane === "app-server") {
    const b = lanes.appServer;
    if (b.status !== "present") return { kind: lane, status: b.status === "absent" ? "missing" : b.status, path: b.path };
    if (b.instanceId !== entry.instanceId) return { kind: lane, status: "missing", path: b.path };
    return { kind: lane, status: b.enabled ? "bound" : "binding_disabled", path: b.path };
  }
  if (lane === "grok-bot") {
    const b = lanes.grokBot;
    return { kind: lane, status: b.status === "present" ? (b.enabled ? "bound" : "binding_disabled") : "missing", path: b.path };
  }
  if (lane === "event-driven") return { kind: lane, status: UNAVAILABLE, path: null };
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
} = {}) {
  if (typeof clientRoot !== "string" || !clientRoot.startsWith("/")) {
    throw new TypeError("clientRoot must be an absolute path");
  }
  if (typeof pidAlive !== "function" || typeof advisoryHeldAt !== "function") {
    throw new TypeError("pidAlive and advisoryHeldAt are required");
  }
  const applicationRoot = path.resolve(clientRoot, "..");
  const registry = readRegistry(clientRoot);
  const journal = readEnrollmentJournal(applicationRoot);
  const lanes = {
    codexHeadless: readProfileBinding(path.join(clientRoot, "headless-runtime-binding.json"), 2),
    cursorAcp: readProfileBinding(path.join(clientRoot, "cursor-acp-runtime-binding.json"), 1),
    appServer: readSingleBinding(path.join(clientRoot, "app-server-binding.json")),
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
  } else if (registry.entries.length === 0) {
    blockers.push({ code: "registry_empty", message: "installation registry has no profiles" });
  }
  if (journal.status !== "present") {
    warnings.push({ code: "enrollment_journal_unavailable", message: `enrollment journal ${journal.status}` });
  }
  for (const [key, label] of [["codexHeadless", "headless-runtime-binding.json"], ["cursorAcp", "cursor-acp-runtime-binding.json"]]) {
    const status = lanes[key].status;
    if (status === "unreadable" || status === "unsupported_version") {
      blockers.push({ code: "binding_unreadable", message: `${label} ${status}` });
    }
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
    const enrollment = journal.byProfile.get(entry.profile) ?? null;
    const binding = laneBinding(entry, lanes, applicationRoot);
    const modelInstanceRoot = path.join(applicationRoot, "model-state", "instances", entry.instanceId);
    const transactions = readOpenTransaction(modelInstanceRoot, now);
    const credentialFile = path.join(applicationRoot, "credentials", "local", "mailbox", `${entry.profile}.json`);
    const credential = existsSync(credentialFile) ? "file_present" : `${UNAVAILABLE}:keychain_not_inspected`;

    const claimers = [];
    for (const prefix of ["headless-claimer", "cursor-acp-claimer"]) {
      const lock = readClaimerLock(path.join(clientRoot, `${prefix}.${entry.profile}.json`), { pidAlive, advisoryHeldAt });
      if (lock) claimers.push({ lock: prefix, ...lock });
    }
    const heldClaimer = claimers.find((c) => c.advisoryHeld === true) ?? null;

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
    } else if (classification.lane === "event-driven" || classification.lane === "app-server") {
      pollWatch = { mode: "watch", pollIntervalMs: UNSUPPORTED, watchMember: true };
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
      retryExpiry: UNAVAILABLE,
    };
    const hasProgressEvidence = [activity.lastClaimAt, activity.lastReplyAt, activity.lastAckAt]
      .some((value) => value !== UNAVAILABLE);

    const faults = [];
    const notes = [];
    if (entry.enabled) {
      if (classification.support === "unsupported") {
        faults.push({ code: "lane_unsupported", hard: true, reason: classification.reason });
      }
      if (!["bound", UNAVAILABLE, UNSUPPORTED].includes(binding.status)) {
        faults.push({ code: binding.status === "instance_id_mismatch" ? "binding_mismatch" : "binding_missing", hard: true, reason: `${binding.kind}:${binding.status}` });
      }
      if (binding.status === "bound" && binding.commandPresent === false) {
        faults.push({ code: "runtime_command_missing", hard: true, reason: binding.kind });
      }
      if (enrollment == null) {
        faults.push({ code: "enrollment_missing", hard: true, reason: "no enrollment journal entry" });
      } else if (enrollment.state !== "verified") {
        faults.push({ code: "enrollment_unverified", hard: true, reason: `${enrollment.state}:${enrollment.reasonCode}` });
      }
      if (transactions.open?.readable === false) {
        faults.push({ code: "unreadable_custody", hard: true, reason: "open transaction unreadable" });
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
      enrollment: enrollment
        ? { state: enrollment.state, reasonCode: enrollment.reasonCode, agentId: enrollment.agentId, handle: enrollment.handle }
        : { state: "missing" },
      credential,
      capabilities: UNAVAILABLE,
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
    if (source.status !== "present") continue;
    for (const profile of source.profiles.keys()) {
      if (!registeredProfiles.has(profile)) {
        orphans.push({ kind, profile });
        warnings.push({ code: "binding_orphan", message: `${kind} binding lists ${profile} which is not in the installation registry`, profile });
      }
    }
  }
  const enrolledUnregistered = [...journal.byProfile.entries()]
    .filter(([profile, row]) => row.state === "verified" && !registeredProfiles.has(profile))
    .map(([profile]) => profile)
    .sort();

  return {
    applicationRoot,
    registry: { status: registry.status, path: registry.path, count: registry.entries.length },
    bindings: {
      codexHeadless: { status: lanes.codexHeadless.status, profiles: [...lanes.codexHeadless.profiles.keys()] },
      cursorAcp: { status: lanes.cursorAcp.status, profiles: [...lanes.cursorAcp.profiles.keys()] },
      appServer: { status: lanes.appServer.status, enabled: lanes.appServer.enabled ?? null },
      grokBot: { status: lanes.grokBot.status, enabled: lanes.grokBot.enabled ?? null },
    },
    profiles: profiles.sort((a, b) => String(a.profile).localeCompare(String(b.profile))),
    orphanBindings: orphans,
    enrolledUnregistered,
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

export { hexProfile as enrollmentJournalProfileHex };
