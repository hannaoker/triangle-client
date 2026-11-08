// `triangle identity upgrade-registry` and `restore-registry` (identity registry v2, D1.3).
//
// upgrade-registry turns the host-local identity registry from v1 into v2 in one audited step, after a backup. It writes
// nothing without a plan id, and it refuses unless three floor conditions hold: the registry reads and is a v1 with history,
// the supervisor's runtime manifest is v14 or later, and the RUNNING supervisor reports that it can read v2. restore-registry
// is the way back: it replaces the live pair with a backup, after archiving the live pair. Both are plan first, apply with the
// exact plan id; applying needs a terminal (the gate `identity migrate --confirm` has). Neither grants authority or creates an
// identity, and neither changes how any send is routed.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { canonicalJson } from "./canonical.mjs";
import { LocalStateError } from "./errors.mjs";

export const UPGRADE_PLAN_SCHEMA = "identity_registry_upgrade_plan_v1";
export const UPGRADE_RESULT_SCHEMA = "identity_registry_upgrade_result_v1";
export const RESTORE_PLAN_SCHEMA = "identity_registry_restore_plan_v1";
export const RESTORE_RESULT_SCHEMA = "identity_registry_restore_result_v1";
export const MINIMUM_RUNTIME_MANIFEST = 14;
export const BACKUP_DIRECTORY_NAME = "identity-backups";

const SCHEMA_V1 = "identity_registry_v1";
const SCHEMA_V2 = "identity_registry_v2";
const STATUS_TIMEOUT_MS = 15000;
const STATUS_MAX_BYTES = 1024 * 1024;
const MANIFEST_MAX_BYTES = 1024 * 1024;

function fail(code, message = code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : now;
  if (value === undefined) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("invalid_now", "The clock is not a valid time.");
  return date.toISOString();
}

async function loadRegistryModule(deps) {
  if (deps.registry) return deps.registry;
  try {
    return await import("../../agent-worker/src/identity-registry.mjs");
  } catch (error) {
    const err = new LocalStateError("Identity registry foundation (@the-triangle/agent-worker) is not available in this installation.");
    err.cause = error;
    throw err;
  }
}

export function applicationRootOf(clientRoot) {
  return path.dirname(path.resolve(clientRoot));
}

export function backupParentOf(clientRoot) {
  return path.join(applicationRootOf(clientRoot), BACKUP_DIRECTORY_NAME);
}

// ---- the floor ----------------------------------------------------------------------------------------------------------------

function readPrivateJsonFile(file) {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.size > MANIFEST_MAX_BYTES) {
    fail("unsafe_file", "The file is not a private regular file.");
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The version of the supervisor runtime manifest installed under the application root. */
export function readSupervisorManifestVersion(applicationRoot) {
  const file = path.join(applicationRoot, "worker-runtime", "supervisor.manifest.json");
  let manifest;
  try {
    manifest = readPrivateJsonFile(file);
  } catch (error) {
    fail(error?.code === "ENOENT" ? "runtime_manifest_missing" : "runtime_manifest_unreadable", "The supervisor runtime manifest could not be read.");
  }
  if (!Number.isSafeInteger(manifest?.version) || manifest.version < 0) {
    fail("runtime_manifest_unreadable", "The supervisor runtime manifest has no version.");
  }
  return manifest.version;
}

/**
 * Asks the running supervisor for its local status the way the owner would: by running the installed `triangle-local status`
 * (which keeps its own credential handling). Returns the parsed status object. Never reads or prints a credential.
 */
export async function runTriangleLocalStatus({ applicationRoot, clientRoot = path.join(applicationRoot, "client"), execFileImpl = execFile, timeoutMs = STATUS_TIMEOUT_MS, env = process.env }) {
  const unreachable = (detail, message) => Object.assign(new Error(message), { code: "supervisor_unreachable", detail });
  const executable = path.join(applicationRoot, "bin", "triangle-local");
  let st;
  try {
    st = lstatSync(executable);
  } catch {
    throw unreachable("triangle-local_missing", "triangle-local is not installed");
  }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o022) !== 0 || (st.mode & 0o100) === 0) {
    throw unreachable("triangle-local_unsafe", "triangle-local is not safe to run");
  }
  // the directories above it must not let anyone else swap the file: each one a directory of this user (or root), not
  // writable by group or others, no symlinks
  try {
    const { ancestors } = await import("../../agent-worker/src/delivery-private-path.mjs");
    ancestors(path.dirname(executable));
  } catch {
    throw unreachable("triangle-local_unsafe", "triangle-local is not safe to run");
  }
  const childEnv = {};
  for (const key of ["HOME", "PATH", "LANG", "TMPDIR", "USER", "LOGNAME"]) if (env[key] !== undefined) childEnv[key] = env[key];
  const config = path.join(path.resolve(clientRoot), "local-messaging.json");
  return await new Promise((resolve, reject) => {
    execFileImpl(executable, ["status", "--config", config], { timeout: timeoutMs, maxBuffer: STATUS_MAX_BYTES, env: childEnv, windowsHide: true }, (error, stdout) => {
      if (error) {
        const detail = error.killed ? "timeout" : typeof error.code === "number" ? `exit_${error.code}` : String(error.code ?? "failed");
        reject(Object.assign(new Error("The supervisor did not answer"), { code: "supervisor_unreachable", detail }));
        return;
      }
      try {
        const status = JSON.parse(String(stdout));
        if (status === null || typeof status !== "object" || Array.isArray(status)) throw new Error("not an object");
        resolve(status);
      } catch {
        reject(Object.assign(new Error("The supervisor status was not JSON"), { code: "supervisor_unreachable", detail: "status_not_json" }));
      }
    });
  });
}

async function checkRegistry(readRegistry, registryRoot) {
  let read;
  try {
    read = readRegistry({ root: registryRoot });
  } catch (error) {
    return { ok: false, code: "registry_unreadable", state: "unreadable", errorCode: `${error?.code ?? "unknown"}`, schema: null, sequence: null, auditHead: null, bindings: null, uncommittedTail: null };
  }
  if (read.state === "absent") {
    return { ok: false, code: "registry_absent", state: "absent", errorCode: null, schema: null, sequence: null, auditHead: null, bindings: null, uncommittedTail: null };
  }
  const registry = read.registry;
  const facts = {
    state: "ok",
    errorCode: null,
    schema: registry.schema,
    sequence: registry.sequence,
    auditHead: { sequence: registry.auditHead.sequence, hash: registry.auditHead.hash },
    bindings: Object.keys(registry.bindings).length,
    // at most one line: the writer discards it (this is also how a crashed upgrade is retried)
    uncommittedTail: read.audit.uncommittedTail,
  };
  if (registry.schema === SCHEMA_V2) return { ok: false, code: "registry_already_v2", ...facts };
  if (registry.schema !== SCHEMA_V1) return { ok: false, code: "registry_schema_unknown", ...facts };
  if (registry.sequence < 1) return { ok: false, code: "registry_needs_history", ...facts };
  return { ok: true, code: null, ...facts };
}

async function checkManifest(readManifestVersion, applicationRoot) {
  try {
    const version = await readManifestVersion(applicationRoot);
    if (!Number.isSafeInteger(version) || version < MINIMUM_RUNTIME_MANIFEST) {
      return { ok: false, code: "runtime_upgrade_required", version: Number.isSafeInteger(version) ? version : null };
    }
    return { ok: true, code: null, version };
  } catch (error) {
    return { ok: false, code: typeof error?.code === "string" && error.code.startsWith("runtime_manifest_") ? error.code : "runtime_manifest_unreadable", version: null };
  }
}

// Text that came from the supervisor's answer is shown to the owner, so only plain tokens of bounded length get through.
const safeToken = (value) => String(value).replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 64);

async function checkSupervisor(runStatus, applicationRoot, clientRoot) {
  const none = { supportedSchemas: null, routerEnabled: null, observedRegistry: null };
  let status;
  try {
    status = await runStatus({ applicationRoot, clientRoot });
  } catch (error) {
    return { ok: false, code: "supervisor_unreachable", detail: typeof error?.detail === "string" ? error.detail : null, ...none };
  }
  const registry = status?.router?.registry;
  const supported = registry?.supportedSchemas;
  const observedRegistry = registry && typeof registry === "object"
    ? {
        state: typeof registry.state === "string" ? safeToken(registry.state) : null,
        schema: typeof registry.schema === "string" ? safeToken(registry.schema) : null,
        sequence: Number.isSafeInteger(registry.sequence) ? registry.sequence : null,
      }
    : null;
  const routerEnabled = typeof status?.router?.enabled === "boolean" ? status.router.enabled : null;
  if (!Array.isArray(supported) || !supported.every((value) => typeof value === "string")) {
    // a supervisor from before D1 does not report the field at all, which reads as "cannot read v2"
    return { ok: false, code: "supervisor_cannot_read_v2", detail: "supportedSchemas_not_reported", supportedSchemas: null, routerEnabled, observedRegistry };
  }
  const shown = supported.map(safeToken).sort();
  if (!supported.includes(SCHEMA_V2)) {
    return { ok: false, code: "supervisor_cannot_read_v2", detail: "v2_not_supported", supportedSchemas: shown, routerEnabled, observedRegistry };
  }
  return { ok: true, code: null, detail: null, supportedSchemas: shown, routerEnabled, observedRegistry };
}

// ---- upgrade ------------------------------------------------------------------------------------------------------------------

/**
 * Evaluates the floor and describes the upgrade. Read-only: it creates no directory and writes no file. The plan id covers
 * every fact the decision rests on (the registry's sequence and audit head, the manifest version, what the supervisor said it
 * can read), but not the time or the name of the backup directory, which is chosen when the upgrade is applied.
 */
export async function planRegistryUpgrade({ clientRoot, registryRoot, ...deps } = {}) {
  const worker = await loadRegistryModule(deps);
  const applicationRoot = applicationRootOf(clientRoot);
  const backupParent = backupParentOf(clientRoot);
  const readRegistry = deps.readIdentityRegistry ?? worker.readIdentityRegistry;
  const readManifestVersion = deps.readSupervisorManifestVersion ?? readSupervisorManifestVersion;
  const runStatus = deps.runSupervisorStatus ?? ((args) => runTriangleLocalStatus({ ...args, env: deps.env ?? process.env }));

  const registry = await checkRegistry(readRegistry, registryRoot);
  const manifest = await checkManifest(readManifestVersion, applicationRoot);
  const supervisor = await checkSupervisor(runStatus, applicationRoot, path.resolve(clientRoot));

  const refusals = [];
  if (!registry.ok) refusals.push(registry.code);
  if (!manifest.ok) refusals.push(manifest.code);
  if (!supervisor.ok) refusals.push(supervisor.code);

  const { observedRegistry, ...supervisorFloor } = supervisor;
  const body = {
    schema: UPGRADE_PLAN_SCHEMA,
    registryRoot,
    backupParent,
    registry,
    floor: { manifest, supervisor: supervisorFloor },
    ready: refusals.length === 0,
    refusals,
  };
  return Object.freeze({
    ...body,
    // what the supervisor itself reports reading right now: shown, but not part of the plan id (it moves while it is read)
    observed: Object.freeze({ supervisorRegistry: observedRegistry }),
    planId: sha256Hex(canonicalJson(body)),
  });
}

/**
 * Applies the exact plan: takes the backup, then upgrades with a compare-and-set on the backed-up sequence. Re-evaluates the
 * floor first, so a plan that was true a minute ago but is not any more is refused (`plan_stale`).
 */
export async function applyRegistryUpgrade({ clientRoot, registryRoot, confirm, now, faultHook = null, ...deps } = {}) {
  if (typeof confirm !== "string" || !/^[a-f0-9]{64}$/.test(confirm)) {
    fail("confirmation_mismatch", "The confirmation is not a plan id.");
  }
  const worker = await loadRegistryModule(deps);
  const plan = await planRegistryUpgrade({ clientRoot, registryRoot, ...deps });
  if (plan.planId !== confirm) {
    fail("plan_stale", "That plan id does not match what is true now. Make a fresh plan and use its id.");
  }
  if (!plan.ready) {
    fail(plan.refusals[0], "The upgrade is refused; see the plan.", { refusals: plan.refusals });
  }
  const at = nowIso(now);
  const backupIdentityRegistry = deps.backupIdentityRegistry ?? worker.backupIdentityRegistry;
  const updateIdentityRegistry = deps.updateIdentityRegistry ?? worker.updateIdentityRegistry;
  const backup = backupIdentityRegistry({ root: registryRoot, backupParent: plan.backupParent, now: at });
  if (backup.sequence !== plan.registry.sequence || backup.auditHead.hash !== plan.registry.auditHead.hash) {
    // someone wrote between the plan and the backup: nothing was upgraded, and the backup directory stays where it is
    fail("plan_stale", "The registry changed while the backup was taken. Nothing was upgraded.", { backup });
  }
  let written;
  try {
    written = updateIdentityRegistry({
      root: registryRoot,
      expectedSequence: backup.sequence,
      now: at,
      action: "upgrade",
      subject: null,
      mutate: (registry) => worker.upgradeRegistryV1ToV2(registry),
      faultHook,
    });
  } catch (error) {
    error.backup = backup;
    throw error;
  }
  const after = (deps.readIdentityRegistry ?? worker.readIdentityRegistry)({ root: registryRoot });
  if (after.state !== "ok" || after.registry.schema !== SCHEMA_V2 || after.registry.sequence !== backup.sequence + 1) {
    fail("upgrade_verification_failed", "The registry did not read back as the upgraded registry.", { backup });
  }
  return Object.freeze({
    schema: UPGRADE_RESULT_SCHEMA,
    registryRoot,
    from: Object.freeze({ schema: SCHEMA_V1, sequence: backup.sequence }),
    to: Object.freeze({ schema: after.registry.schema, sequence: after.registry.sequence, auditHead: after.registry.auditHead }),
    backup: Object.freeze({ dir: backup.dir, sequence: backup.sequence, registrySha256: backup.registrySha256, auditSha256: backup.auditSha256 }),
    auditEntry: written.auditEntry.action,
  });
}

// ---- restore ------------------------------------------------------------------------------------------------------------------

/** Describes what restoring the backup would do. Read-only. A backup that cannot be restored throws with the reason. */
export async function planRegistryRestore({ clientRoot, registryRoot, from, discardV2Data = false, ...deps } = {}) {
  const worker = await loadRegistryModule(deps);
  const inspect = deps.inspectIdentityRegistryRestore ?? worker.inspectIdentityRegistryRestore;
  const inspected = inspect({ root: registryRoot, backupDir: from });
  const refusals = [];
  if (inspected.willLoseV2Data && discardV2Data !== true) refusals.push("restore_would_lose_v2_data");
  const body = {
    schema: RESTORE_PLAN_SCHEMA,
    registryRoot,
    archiveParent: backupParentOf(clientRoot),
    backup: inspected.backup,
    live: inspected.live,
    relation: inspected.relation,
    discarded: inspected.discarded,
    routing: inspected.routing,
    discardV2Data: discardV2Data === true,
    ready: refusals.length === 0,
    refusals,
  };
  return Object.freeze({ ...body, planId: sha256Hex(canonicalJson(body)) });
}

/** Applies the exact restore plan under the registry lock, against the live files that were planned. */
export async function applyRegistryRestore({ clientRoot, registryRoot, from, discardV2Data = false, confirm, now, faultHook = null, ...deps } = {}) {
  if (typeof confirm !== "string" || !/^[a-f0-9]{64}$/.test(confirm)) {
    fail("confirmation_mismatch", "The confirmation is not a plan id.");
  }
  const worker = await loadRegistryModule(deps);
  const plan = await planRegistryRestore({ clientRoot, registryRoot, from, discardV2Data, ...deps });
  if (plan.planId !== confirm) {
    fail("plan_stale", "That plan id does not match what is true now. Make a fresh plan and use its id.");
  }
  if (!plan.ready) {
    fail(plan.refusals[0], "The restore is refused; see the plan.", { refusals: plan.refusals });
  }
  const restore = deps.restoreIdentityRegistry ?? worker.restoreIdentityRegistry;
  const result = restore({
    root: registryRoot,
    backupDir: from,
    archiveParent: plan.archiveParent,
    expectedLiveFingerprint: plan.live.fingerprint,
    expectedBackup: { registrySha256: plan.backup.registrySha256, auditSha256: plan.backup.auditSha256 },
    discardV2Data: plan.discardV2Data,
    now: nowIso(now),
    faultHook,
  });
  return Object.freeze({
    schema: RESTORE_RESULT_SCHEMA,
    registryRoot,
    restored: result.restored,
    previous: result.live,
    relation: result.relation,
    discarded: result.discarded,
    routing: result.routing,
    archive: result.archive === null ? null : Object.freeze({ dir: result.archive.dir, files: result.archive.files }),
  });
}

// ---- wording ------------------------------------------------------------------------------------------------------------------

const REFUSALS = {
  registry_absent: "There is no identity registry here yet; there is nothing to upgrade.",
  registry_unreadable: "The identity registry cannot be read, so it cannot be backed up or upgraded. Check `triangle status --identity`; do not edit the files by hand.",
  registry_already_v2: "The registry is already identity_registry_v2.",
  registry_schema_unknown: "The registry has a schema this command does not know.",
  registry_needs_history: "The registry has no history yet (sequence 0), and an upgrade cannot be the first audit entry.",
  runtime_manifest_missing: "No supervisor runtime manifest was found under this application root.",
  runtime_manifest_unreadable: "The supervisor runtime manifest could not be read.",
  runtime_upgrade_required: `The supervisor runtime is older than v${MINIMUM_RUNTIME_MANIFEST}; install a current runtime first.`,
  supervisor_unreachable: "The running supervisor could not be asked what it can read (is it running, and is local messaging set up?).",
  supervisor_cannot_read_v2: "The running supervisor does not say it can read identity_registry_v2; install and restart into a runtime that does, first.",
  restore_would_lose_v2_data: "The live registry holds v2-only data (a serverless binding, pairing, alias or destination) that a v1 backup does not have. Pass --discard-v2-data to restore anyway; it is archived first.",
  restore_backup_unreadable: "The backup does not read or verify as a registry.",
  restore_backup_not_v1: "Only a v1 backup (the kind upgrade-registry makes) can be restored.",
  restore_backup_unfinished_write: "The backup ends in an unfinished write; it is not a clean copy.",
  backup_overlaps_registry_root: "The backup must be outside the registry directory.",
  registry_changed: "The registry changed after the plan was made. Make a fresh plan.",
  backup_changed_since_plan: "The backup changed after the plan was made. Make a fresh plan.",
  live_registry_changed_since_plan: "The registry changed after the plan was made. Make a fresh plan.",
  plan_stale: "That plan id does not match what is true now. Make a fresh plan and use its id.",
  confirmation_mismatch: "The confirmation must be the 64-hex plan id printed by the plan.",
};

export function describeRefusal(code) {
  return REFUSALS[code] ?? null;
}

const short = (hash) => (typeof hash === "string" ? hash.slice(0, 12) : "-");
// Paths and names come from the command line and the file system: control characters never reach the owner's terminal.
export const printable = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
const shellQuote = (value) => (/^[A-Za-z0-9_\/.:@%+=,-]+$/.test(String(value)) ? String(value) : `'${String(value).replaceAll("'", `'\\''`)}'`);

/** The restore command for a backup, ready to paste: every path quoted, both roots named. */
export function restoreCommand({ clientRoot, registryRoot, from, discardV2Data = false, confirm = null }) {
  return [
    "triangle identity restore-registry",
    `--client-root ${shellQuote(clientRoot)}`,
    `--registry-root ${shellQuote(registryRoot)}`,
    `--from ${shellQuote(from)}`,
    ...(discardV2Data ? ["--discard-v2-data"] : []),
    ...(confirm ? [`--confirm ${confirm}`] : []),
  ].join(" ");
}

export function renderUpgradePlan(plan, { clientRoot } = {}) {
  const lines = [];
  const reg = plan.registry;
  lines.push("Identity registry upgrade plan (host-local; changes no identity, authority or route)");
  lines.push(`Registry: ${plan.registryRoot}`);
  if (reg.state === "ok") {
    lines.push(`Current:  ${reg.schema.replace(/^identity_registry_/, "")} · sequence ${reg.sequence} · ${reg.bindings} binding(s) · audit head ${short(reg.auditHead.hash)}`);
    if (reg.uncommittedTail === 1) lines.push("          An interrupted write left an unfinished audit line; the upgrade discards it.");
  } else {
    lines.push(`Current:  ${reg.state}${reg.errorCode ? ` (${reg.errorCode})` : ""}`);
  }
  if (reg.code === "registry_already_v2") {
    lines.push("Nothing to do: the registry is already identity_registry_v2.");
    lines.push(`Plan ID: ${plan.planId}`);
    return lines.map(printable).join("\n");
  }
  lines.push("Floor (each must hold; nothing is written otherwise):");
  const mark = (ok) => (ok ? "[ok]     " : "[blocked]");
  lines.push(`  ${mark(plan.registry.ok)} registry reads, is v1, has history${plan.registry.ok ? "" : ` (${plan.registry.code})`}`);
  lines.push(`  ${mark(plan.floor.manifest.ok)} supervisor runtime manifest v${MINIMUM_RUNTIME_MANIFEST} or later${plan.floor.manifest.version !== null ? ` (found v${plan.floor.manifest.version})` : ""}${plan.floor.manifest.ok ? "" : ` (${plan.floor.manifest.code})`}`);
  const sup = plan.floor.supervisor;
  lines.push(`  ${mark(sup.ok)} the running supervisor reports it can read ${SCHEMA_V2}${sup.supportedSchemas ? ` (${sup.supportedSchemas.join(", ")})` : ""}${sup.ok ? "" : ` (${sup.code}${sup.detail ? `: ${sup.detail}` : ""})`}`);
  for (const code of plan.refusals) {
    const text = describeRefusal(code);
    if (text) lines.push(`  - ${code}: ${text}`);
  }
  const seen = plan.observed?.supervisorRegistry;
  if (seen && seen.schema) lines.push(`The supervisor currently reads: ${seen.state}, ${seen.schema.replace(/^identity_registry_/, "")}, sequence ${seen.sequence ?? "?"}.`);
  if (seen && seen.state === "ok" && reg.state === "ok" && (seen.sequence !== reg.sequence || seen.schema !== reg.schema)) {
    lines.push("Note: that is not this registry's state. The supervisor may be reading another registry directory (check --client-root and --registry-root name the pair it uses), or a write just landed.");
  }
  lines.push(`Backup:   a private copy is made first in ${plan.backupParent}${path.sep}backup-v1-<time> and read back; the upgrade does not run if it does not verify.`);
  lines.push("Change:   every binding is rewritten as local_profile_binding_v2, three empty collections (pairings, aliases, destinations) are added, and one `upgrade` audit entry is appended.");
  lines.push("Older runtimes: a supervisor or CLI from before this release cannot read a v2 registry and fails closed (agent_ principal sends are refused with route_unavailable; exact-id sends keep working).");
  lines.push(`Way back: ${restoreCommand({ clientRoot: clientRoot ?? "DIR", registryRoot: plan.registryRoot, from: "BACKUP_DIR" })}   (it plans first and archives what it replaces)`);
  lines.push(`Plan ID: ${plan.planId}`);
  if (plan.ready && clientRoot) {
    lines.push("");
    lines.push("To apply this plan (needs a terminal):");
    lines.push(`  triangle identity upgrade-registry --client-root ${shellQuote(clientRoot)} --registry-root ${shellQuote(plan.registryRoot)} --confirm ${plan.planId}`);
  }
  return lines.map(printable).join("\n");
}

export function renderUpgradeResult(result) {
  return [
    `Upgraded the identity registry to ${result.to.schema} (sequence ${result.from.sequence} → ${result.to.sequence}).`,
    `Registry: ${result.registryRoot}`,
    `Backup:   ${result.backup.dir}`,
    `          (registry ${short(result.backup.registrySha256)}…, audit ${short(result.backup.auditSha256)}…; read back and verified before the upgrade)`,
    "Check it with: triangle status --identity   (the schema and record counts are shown).",
  ].map(printable).join("\n");
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function renderRestorePlan(plan, { clientRoot, from } = {}) {
  const lines = [];
  const live = plan.live;
  lines.push("Identity registry restore plan (replaces the live registry files with a backup)");
  lines.push(`Registry: ${plan.registryRoot}`);
  if (live.state === "ok") {
    lines.push(`Live:     ${live.schema.replace(/^identity_registry_/, "")} · sequence ${live.sequence} · ${plural(live.bindings, "binding")} · audit head ${short(live.auditHead.hash)}`);
  } else {
    lines.push(`Live:     ${live.state}${live.errorCode ? ` (${live.errorCode})` : ""}`);
  }
  const b = plan.backup;
  lines.push(`Backup:   ${b.dir}`);
  lines.push(`          ${b.schema.replace(/^identity_registry_/, "")} · sequence ${b.sequence} · ${plural(b.bindings, "binding")} · audit head ${short(b.auditHead.hash)}`);
  if (live.uncommittedTail === 1) lines.push("          An interrupted write left an unfinished audit line; it is archived with the live files.");
  const relation = {
    same: "The live registry is exactly this backup's history; nothing is discarded.",
    ahead: "The live registry has this backup's history and more.",
    behind: "This backup is newer than the live registry.",
    diverged: "The live registry and this backup have different histories from some point on.",
    unknown: "The live registry cannot be compared with the backup.",
  }[plan.relation];
  lines.push(`History:  ${relation}`);
  if (plan.discarded.length > 0) {
    lines.push(`Would discard ${plural(plan.discarded.length, "audit entry", "audit entries")} (anything done since the backup must be redone):`);
    for (const entry of plan.discarded.slice(0, 20)) lines.push(`  - #${entry.sequence} ${entry.at} ${entry.action}${entry.subject ? ` ${entry.subject.slice(0, 12)}…` : ""}`);
    if (plan.discarded.length > 20) lines.push(`  … and ${plan.discarded.length - 20} more`);
  }
  const v2 = live.v2Data;
  if (v2 && v2.any) {
    lines.push(`Would lose v2-only data: ${plural(v2.serverlessBindings, "serverless binding")}, ${plural(v2.pairings, "pairing")}, ${plural(v2.aliases, "alias", "aliases")}, ${plural(v2.destinations, "destination")}.`);
  }
  const routing = plan.routing;
  if (routing && ["reactivated", "added", "changed", "revoked", "removed"].some((key) => routing[key].length > 0)) {
    const rows = [
      ...routing.reactivated.map((x) => `  ! ${x.profile} (${x.principal}): a REVOKE IS UNDONE, this binding routes again`),
      ...routing.added.map((x) => `  + ${x.profile} (${x.principal}): added (the backup has it, the live registry does not)`),
      ...routing.changed.map((x) => `  ~ ${x.profile} (${x.principal}): another principal, origin or trust mode than the live registry`),
      ...routing.revoked.map((x) => `  - ${x.profile} (${x.principal}): revoked in the backup`),
      ...routing.removed.map((x) => `  - ${x.profile} (${x.principal}): removed (the live registry has it, the backup does not)`),
    ];
    lines.push("What changes for routing (principal sends):");
    for (const row of rows.slice(0, 30)) lines.push(row);
    if (rows.length > 30) lines.push(`  \u2026 and ${rows.length - 30} more`);
  }
  for (const code of plan.refusals) {
    const text = describeRefusal(code);
    if (text) lines.push(`  - ${code}: ${text}`);
  }
  lines.push(`Archive:  the live files are copied first into ${plan.archiveParent}${path.sep}before-restore-<state>-<time>.`);
  lines.push(`Plan ID: ${plan.planId}`);
  if (plan.ready && clientRoot) {
    lines.push("");
    lines.push("To apply this plan (needs a terminal):");
    lines.push(`  ${restoreCommand({ clientRoot, registryRoot: plan.registryRoot, from: from ?? b.dir, discardV2Data: plan.discardV2Data, confirm: plan.planId })}`);
  }
  return lines.map(printable).join("\n");
}

export function renderRestoreResult(result) {
  const lines = [
    `Restored the identity registry to ${result.restored.schema} (sequence ${result.restored.sequence}).`,
    `Registry: ${result.registryRoot}`,
  ];
  if (result.archive) lines.push(`Archive:  ${result.archive.dir}   (the files it replaced)`);
  if (result.discarded.length > 0) lines.push(`Discarded ${plural(result.discarded.length, "audit entry", "audit entries")}; redo anything that mattered.`);
  if (result.routing && result.routing.reactivated.length > 0) {
    lines.push(`Revoked bindings that route again: ${result.routing.reactivated.map((x) => x.profile).join(", ")}. Revoke them again with triangle identity revoke if that is not wanted.`);
  }
  lines.push("Check it with: triangle status --identity");
  return lines.map(printable).join("\n");
}
