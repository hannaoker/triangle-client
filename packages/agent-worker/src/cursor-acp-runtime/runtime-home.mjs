/**
 * Dedicated Triangle Cursor ACP home / child env plumbing.
 *
 * Never shares CODEX_HOME. Never copies mesh_ / mesh_watch_ credentials.
 * CURSOR_API_KEY may be injected via allowlisted extra only (not from MESH).
 *
 * Cursor CLI state isolation: the Cursor CLI resolves its config/state root as
 * `CURSOR_CONFIG_DIR` -> `$XDG_CONFIG_HOME/cursor` -> `~/.cursor` (verified in
 * cursor-agent 2026.09.10-fd3934a, `../cursor-config/dist/paths.js`). ACP
 * sessions live at `<configDir>/acp-sessions/<sessionId>/{meta.json,store.db}`
 * and CLI settings at `<configDir>/cli-config.json`. The child env therefore
 * pins `CURSOR_CONFIG_DIR` to the Triangle-owned Cursor home so Triangle never
 * reads or writes the user's `~/.cursor`. HOME is preserved on purpose: the
 * macOS login lives in the keychain (and the `~/.cursor/auth.json` fallback is
 * HOME-relative, not config-dir-relative), so the existing login is reused,
 * never replaced.
 */

import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { assertNoSecretMaterial } from "./acp-protocol.mjs";
import {
  copyFileIntoOwned,
  ensureOwnedDirectory,
  identitiesEqual,
  normalizeOwnedRelative,
  ownedFileIdentity,
  removeOwnedEmptyDirectory,
  removeOwnedFileIfUnchanged,
  resolveOwnedPath,
} from "./owned-fs.mjs";

const FORBIDDEN_CHILD_ENV = Object.freeze([
  "MESH_TOKEN",
  "MESH_BEARER",
  "MESH_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  // Only CURSOR_CONFIG_DIR may choose the Cursor state root; XDG would point
  // the CLI at a shared `$XDG_CONFIG_HOME/cursor` if CURSOR_CONFIG_DIR were
  // ever unset.
  "XDG_CONFIG_HOME",
]);

const MESH_SECRET = /mesh_(?:watch_)?[A-Za-z0-9_-]{8,}/;
const ALLOWED_CURSOR_SECRET_KEYS = Object.freeze([
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
]);

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export function defaultTriangleCursorHome({ home = process.env.HOME } = {}) {
  if (typeof home !== "string" || !home.startsWith("/")) {
    throw createCodedError("cursor_home_invalid", "HOME must be an absolute path to resolve Cursor home");
  }
  return path.join(
    home,
    "Library",
    "Application Support",
    "The Triangle",
    "model-state",
    "cursor-acp-runtime-home",
  );
}

export function resolveTriangleCursorHome({
  override = process.env.TRIANGLE_CURSOR_HOME,
  home = process.env.HOME,
  allowCreate = false,
} = {}) {
  const candidate =
    typeof override === "string" && override.length > 0
      ? override
      : defaultTriangleCursorHome({ home });

  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.includes("\0")) {
    throw createCodedError("cursor_home_invalid", "TRIANGLE_CURSOR_HOME must be an absolute path");
  }
  if (MESH_SECRET.test(candidate)) {
    throw createCodedError("secret_leak_rejected", "Cursor home path must not contain mesh_ credentials");
  }

  const userCursor = typeof home === "string" ? path.join(home, ".cursor") : null;
  if (userCursor && pathsEqual(candidate, userCursor)) {
    throw createCodedError(
      "cursor_home_user_fallback_forbidden",
      "dedicated Triangle Cursor home must not resolve to ~/.cursor",
    );
  }

  const userCodex = typeof home === "string" ? path.join(home, ".codex") : null;
  if (userCodex && pathsEqual(candidate, userCodex)) {
    throw createCodedError(
      "cursor_home_codex_forbidden",
      "dedicated Triangle Cursor home must not resolve to ~/.codex or CODEX_HOME",
    );
  }

  if (allowCreate) {
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
  }

  let resolved = candidate;
  try {
    resolved = realpathSync(candidate);
  } catch (error) {
    if (!allowCreate) {
      throw createCodedError(
        "cursor_home_missing",
        "dedicated Triangle Cursor home does not exist",
        { path: candidate, causeCode: error?.code ?? null },
      );
    }
  }

  if (userCursor && pathsEqual(resolved, userCursor)) {
    throw createCodedError(
      "cursor_home_user_fallback_forbidden",
      "dedicated Triangle Cursor home must not resolve to ~/.cursor",
    );
  }

  try {
    const mode = statSync(resolved).mode & 0o777;
    if (mode !== 0o700 && process.platform !== "win32") {
      // Soft diagnostic; Darwin store enforces 0700.
    }
  } catch {
    // ignore
  }

  return resolved;
}

function pathsEqual(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

/**
 * Build a minimal ACP child environment. Never copies MESH credentials.
 * Never puts Cursor home secrets on argv — callers use this env map.
 * Never sets CODEX_HOME.
 */
export function buildSanitizedCursorChildEnv({
  cursorHome,
  parentEnv = process.env,
  extra = {},
} = {}) {
  const home = resolveTriangleCursorHome({
    override: cursorHome,
    home: parentEnv.HOME,
    allowCreate: false,
  });

  const child = {
    HOME: parentEnv.HOME,
    PATH: parentEnv.PATH,
    LANG: parentEnv.LANG ?? "C.UTF-8",
    LC_ALL: parentEnv.LC_ALL,
    TMPDIR: parentEnv.TMPDIR,
    USER: parentEnv.USER,
    LOGNAME: parentEnv.LOGNAME,
    TRIANGLE_CURSOR_HOME: home,
    ...extra,
  };

  if (
    extra != null &&
    Object.prototype.hasOwnProperty.call(extra, "CURSOR_CONFIG_DIR") &&
    extra.CURSOR_CONFIG_DIR != null &&
    !pathsEqual(String(extra.CURSOR_CONFIG_DIR), home)
  ) {
    throw createCodedError(
      "cursor_config_dir_conflict",
      "CURSOR_CONFIG_DIR must point at the dedicated Triangle Cursor home",
    );
  }
  // Isolate Cursor CLI state (acp-sessions, cli-config.json, ...) from ~/.cursor.
  child.CURSOR_CONFIG_DIR = home;

  for (const key of Object.keys(child)) {
    if (child[key] == null) delete child[key];
  }

  for (const forbidden of FORBIDDEN_CHILD_ENV) {
    delete child[forbidden];
  }

  // Strip any accidental MESH inheritance from extra/parent overlays.
  for (const key of Object.keys(child)) {
    if (/^MESH_/i.test(key) || /^mesh_/i.test(key)) {
      delete child[key];
    }
  }

  for (const [key, value] of Object.entries(child)) {
    if (typeof value !== "string") continue;
    if (MESH_SECRET.test(value)) {
      throw createCodedError(
        "secret_leak_rejected",
        `child env ${key} must not contain mesh_ credentials`,
      );
    }
    if (
      /mesh_(?:watch_)?/i.test(key) ||
      (key.includes("MESH") && !ALLOWED_CURSOR_SECRET_KEYS.includes(key))
    ) {
      // Defense: key names that look like MESH must not survive.
      if (/MESH/i.test(key)) {
        delete child[key];
      }
    }
  }

  assertNoSecretMaterial(child, "cursor child env");
  return Object.freeze({ ...child });
}

/**
 * v1 Cursor ACP pool stays size 1. Production pool>1 cutover is out of scope.
 */
export function resolveCursorAcpPoolGuards({
  preferredSize = 1,
  maxSize = 1,
} = {}) {
  const preferred = Number.isSafeInteger(preferredSize) && preferredSize >= 1 ? preferredSize : 1;
  const max = Number.isSafeInteger(maxSize) && maxSize >= 1 ? maxSize : 1;
  const size = Math.min(preferred, max, 1);
  return Object.freeze({
    preferredSize: size,
    maxSize: 1,
    forcedByV1Cap: preferred > 1 || max > 1,
    reason: preferred > 1 || max > 1 ? "cursor_acp_pool_v1_cap" : "cursor_acp_pool_v1",
  });
}

/**
 * Explicit, reversible transition for Triangle-owned ACP sessions that were
 * created before CURSOR_CONFIG_DIR isolation (they live under
 * `~/.cursor/acp-sessions/<id>`). Nothing here runs automatically.
 *
 * - plan: read-only classification of the referenced session ids.
 * - apply: COPIES (never moves) each regular file of a referenced session into
 *   `<cursorHome>/acp-sessions/<id>/` with exclusive create; never overwrites
 *   an existing target session; records every copied file with its snapshot
 *   identity (size, mtime, sha256) and every directory it created in a
 *   manifest. `~/.cursor` is never written. All target paths are validated
 *   physically (no symlinked ancestors; see owned-fs.mjs).
 * - revert (undo-after-use contract): per session, all-or-nothing. A session
 *   is removed only if every recorded file still matches its snapshot and the
 *   session contains no other files; then exactly the recorded files and the
 *   (now empty) recorded directories are removed — never a recursive delete.
 *   If the session was used after migration (a recorded file changed or
 *   disappeared, or a new file appeared), or any path is unsafe, the whole
 *   session is left in place, reported in `kept`, and stays in the manifest.
 *   The manifest is deleted only when no entries remain.
 *
 * Only run apply/revert while the Cursor ACP drain is stopped (store.db is
 * SQLite with a WAL; copying under a live writer can capture a torn snapshot).
 */
export const CURSOR_ACP_LEGACY_COPY_MANIFEST = ".triangle-legacy-session-copy.json";
const CURSOR_ACP_SESSIONS_DIRNAME = "acp-sessions";
const LEGACY_SESSION_MANIFEST_SCHEMA = 2;

const CURSOR_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertCursorSessionIds(sessionIds) {
  if (!Array.isArray(sessionIds)) {
    throw createCodedError("cursor_session_id_invalid", "sessionIds must be an array");
  }
  for (const id of sessionIds) {
    if (typeof id !== "string" || !CURSOR_SESSION_ID.test(id)) {
      throw createCodedError("cursor_session_id_invalid", "Cursor ACP session ids must be lowercase UUIDs");
    }
  }
  return [...new Set(sessionIds)];
}

function legacyCopyRoots({ home, cursorHome }) {
  if (typeof home !== "string" || !home.startsWith("/")) {
    throw createCodedError("cursor_home_invalid", "HOME must be an absolute path");
  }
  const anchor = resolveTriangleCursorHome({ override: cursorHome, home, allowCreate: false });
  // Legacy sources are resolved physically below realpath(HOME): `.cursor`,
  // `acp-sessions` and every session component must be real directories (a
  // symlinked ancestor would import files from outside the legacy tree).
  let sourceAnchor = null;
  try {
    sourceAnchor = realpathSync(home);
  } catch {
    sourceAnchor = null;
  }
  return {
    anchor,
    sourceAnchor,
    sourceRootRelative: `.cursor/${CURSOR_ACP_SESSIONS_DIRNAME}`,
    sourceRoot: path.join(home, ".cursor", CURSOR_ACP_SESSIONS_DIRNAME),
    targetRoot: path.join(anchor, CURSOR_ACP_SESSIONS_DIRNAME),
  };
}

/**
 * Entries below `root` (relative paths, never following symlinks): regular
 * `files`, real `dirs`, and anything else as `unsafe`.
 */
export function listRegularFilesNoFollow(root) {
  const files = [];
  const dirs = [];
  const unsafe = [];
  const visit = (relativeDir) => {
    for (const name of readdirSync(path.join(root, relativeDir)).sort()) {
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      const stat = lstatSync(path.join(root, relative));
      if (stat.isDirectory()) {
        dirs.push(relative);
        visit(relative);
      } else if (stat.isFile()) files.push(relative);
      else unsafe.push(relative);
    }
  };
  visit("");
  return { files, dirs, unsafe };
}

function ancestorDirs(relativeFiles) {
  const dirs = new Set();
  for (const relative of relativeFiles) {
    const parts = relative.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) dirs.add(parts.slice(0, depth).join("/"));
  }
  return dirs;
}

export function planLegacyCursorAcpSessionCopy({ home = process.env.HOME, cursorHome, sessionIds } = {}) {
  const ids = assertCursorSessionIds(sessionIds);
  const { anchor, sourceAnchor, sourceRootRelative, sourceRoot, targetRoot } = legacyCopyRoots({ home, cursorHome });
  const entries = ids.map((sessionId) => {
    const source = path.join(sourceRoot, sessionId);
    const target = path.join(targetRoot, sessionId);
    let targetState;
    try {
      targetState = resolveOwnedPath(anchor, `${CURSOR_ACP_SESSIONS_DIRNAME}/${sessionId}`, {
        allowMissingLeaf: true,
        allowMissingAncestors: true,
      });
    } catch {
      return Object.freeze({ sessionId, action: "unsafe_target", source, target });
    }
    if (targetState.leaf != null) return Object.freeze({ sessionId, action: "already_present", source, target });
    if (sourceAnchor == null) return Object.freeze({ sessionId, action: "missing_source", source, target });
    let sourceState;
    try {
      sourceState = resolveOwnedPath(sourceAnchor, `${sourceRootRelative}/${sessionId}`, {
        allowMissingLeaf: true,
        allowMissingAncestors: true,
      });
    } catch {
      return Object.freeze({ sessionId, action: "unsafe_source", source, target });
    }
    if (sourceState.leaf == null) return Object.freeze({ sessionId, action: "missing_source", source, target });
    if (!sourceState.leaf.isDirectory()) {
      return Object.freeze({ sessionId, action: "unsafe_source", source, target });
    }
    const { files, unsafe } = listRegularFilesNoFollow(sourceState.absolute);
    if (unsafe.length > 0) {
      return Object.freeze({ sessionId, action: "unsafe_source", source, target });
    }
    return Object.freeze({ sessionId, action: "copy", source, target, files: Object.freeze(files) });
  });
  return Object.freeze({ sourceRoot, targetRoot, entries: Object.freeze(entries) });
}

function readLegacyCopyManifest(anchor) {
  const relative = `${CURSOR_ACP_SESSIONS_DIRNAME}/${CURSOR_ACP_LEGACY_COPY_MANIFEST}`;
  const resolved = resolveOwnedPath(anchor, relative, { allowMissingLeaf: true, allowMissingAncestors: true });
  if (resolved.leaf == null) {
    return {
      manifestPath: resolved.absolute,
      manifest: { schemaVersion: LEGACY_SESSION_MANIFEST_SCHEMA, copied: [] },
    };
  }
  if (!resolved.leaf.isFile()) {
    throw createCodedError("cursor_legacy_manifest_invalid", "legacy session copy manifest is not a regular file");
  }
  const manifest = JSON.parse(readFileSync(resolved.absolute, "utf8"));
  if (!Array.isArray(manifest?.copied)) {
    throw createCodedError("cursor_legacy_manifest_invalid", "legacy session copy manifest is invalid");
  }
  return { manifestPath: resolved.absolute, manifest };
}

function writeLegacyCopyManifest(manifestPath, manifest) {
  // Unique temp name (a stale temp from a crashed run cannot block writes);
  // the temp is removed if the write or rename fails.
  const temporary = `${manifestPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, manifestPath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // never created / already renamed
    }
    throw error;
  }
}

/**
 * Best-effort rollback of a session whose copy failed midway: remove only the
 * files this apply copied (identity-checked) and the directories it created
 * (empty only). Returns true when nothing of the attempt remains.
 */
function rollbackIncompleteSession(anchor, record) {
  let clean = true;
  const remainingFiles = [];
  for (const file of record.files) {
    let status;
    try {
      status = removeOwnedFileIfUnchanged({ anchor, relative: file.path, identity: file }).status;
    } catch {
      status = "error";
    }
    if (status !== "removed" && status !== "missing") {
      clean = false;
      remainingFiles.push(file);
    }
  }
  record.files = remainingFiles;
  for (const dir of [...new Set(record.createdDirs)].sort((a, b) => b.length - a.length)) {
    let status;
    try {
      status = removeOwnedEmptyDirectory({ anchor, relative: dir }).status;
    } catch {
      status = "error";
    }
    if (status !== "removed" && status !== "missing") clean = false;
  }
  return clean;
}

export function applyLegacyCursorAcpSessionCopy({
  home = process.env.HOME,
  cursorHome,
  sessionIds,
  now = () => new Date().toISOString(),
} = {}) {
  const plan = planLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds });
  const { anchor, sourceAnchor, sourceRootRelative } = legacyCopyRoots({ home, cursorHome });
  const rootCreated = ensureOwnedDirectory(anchor, CURSOR_ACP_SESSIONS_DIRNAME);
  const { manifestPath, manifest } = readLegacyCopyManifest(anchor);
  manifest.schemaVersion = LEGACY_SESSION_MANIFEST_SCHEMA;
  const copied = [];
  const failed = [];
  for (const entry of plan.entries) {
    if (entry.action !== "copy") continue;
    const record = { sessionId: entry.sessionId, copiedAt: now(), files: [], createdDirs: [] };
    try {
      record.createdDirs.push(...ensureOwnedDirectory(anchor, `${CURSOR_ACP_SESSIONS_DIRNAME}/${entry.sessionId}`)
        .filter((dir) => !rootCreated.includes(dir)));
      for (const relative of entry.files) {
        const targetRelative = `${CURSOR_ACP_SESSIONS_DIRNAME}/${entry.sessionId}/${relative}`;
        let result;
        try {
          result = copyFileIntoOwned({
            anchor,
            relative: targetRelative,
            sourceAnchor,
            sourceRelative: `${sourceRootRelative}/${entry.sessionId}/${relative}`,
          });
        } catch (error) {
          if (Array.isArray(error?.createdDirs)) record.createdDirs.push(...error.createdDirs);
          throw error;
        }
        record.createdDirs.push(...result.createdDirs);
        if (result.status !== "copied") {
          // The target appeared under us: the copy is no longer a faithful snapshot.
          throw createCodedError("cursor_legacy_copy_target_changed", "session target changed during copy");
        }
        record.files.push({ path: targetRelative, ...result.identity });
      }
    } catch (error) {
      // A partial copy must never look like a migrated session: roll back what
      // this attempt created; if that is not fully possible, record it as
      // incomplete so revert can still clean it up identity-checked.
      const clean = rollbackIncompleteSession(anchor, record);
      if (!clean) {
        manifest.copied.push({ ...record, incomplete: true });
        try {
          writeLegacyCopyManifest(manifestPath, manifest);
        } catch {
          // Reported below via rolledBack:false.
        }
      }
      failed.push(Object.freeze({
        sessionId: entry.sessionId,
        code: typeof error?.code === "string" ? error.code : "cursor_legacy_copy_failed",
        rolledBack: clean,
      }));
      continue;
    }
    manifest.copied.push(record);
    try {
      writeLegacyCopyManifest(manifestPath, manifest);
    } catch (error) {
      // Never leave a copied session that no manifest knows about: roll it
      // back (identity-checked). If rollback cannot finish, the session is
      // reported with rolledBack:false and its record stays in memory only.
      manifest.copied.pop();
      const clean = rollbackIncompleteSession(anchor, record);
      failed.push(Object.freeze({
        sessionId: entry.sessionId,
        code: typeof error?.code === "string" ? error.code : "cursor_legacy_manifest_write_failed",
        rolledBack: clean,
      }));
      continue;
    }
    copied.push(entry.sessionId);
  }
  return Object.freeze({
    copied: Object.freeze(copied),
    failed: Object.freeze(failed),
    skipped: Object.freeze(
      plan.entries
        .filter((entry) => entry.action !== "copy")
        .map(({ sessionId, action }) => Object.freeze({ sessionId, action })),
    ),
    manifestPath,
  });
}

function safeOwnedParts(relative) {
  try {
    return normalizeOwnedRelative(relative);
  } catch {
    return null;
  }
}

function revertOneSession(anchor, record, persistProgress = () => {}) {
  const { sessionId } = record;
  assertCursorSessionIds([sessionId]);
  if (!Array.isArray(record.files)) {
    return { status: "kept", reason: "no_snapshot" };
  }
  const sessionRelative = `${CURSOR_ACP_SESSIONS_DIRNAME}/${sessionId}`;
  let sessionDir;
  try {
    sessionDir = resolveOwnedPath(anchor, sessionRelative, { allowMissingLeaf: true });
  } catch (error) {
    return { status: "kept", reason: "unsafe_path", detail: error?.code ?? null };
  }
  if (sessionDir.leaf == null) return { status: "gone" };
  if (!sessionDir.leaf.isDirectory()) return { status: "kept", reason: "unsafe_path", detail: "owned_path_not_directory" };

  const recorded = new Map();
  for (const file of record.files) {
    const parts = safeOwnedParts(file?.path);
    if (parts == null || parts[0] !== CURSOR_ACP_SESSIONS_DIRNAME || parts[1] !== sessionId || parts.length < 3) {
      return { status: "kept", reason: "unsafe_path", detail: "manifest_entry_outside_session" };
    }
    recorded.set(parts.slice(2).join("/"), file);
  }
  const dirs = [...new Set(record.createdDirs ?? [])].sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    const parts = safeOwnedParts(dir);
    if (parts == null || parts[0] !== CURSOR_ACP_SESSIONS_DIRNAME || parts[1] !== sessionId) {
      return { status: "kept", reason: "unsafe_path", detail: "manifest_entry_outside_session" };
    }
  }
  // Full preflight BEFORE any unlink: the session tree must contain exactly
  // the recorded regular files and their ancestor directories, each file
  // still identical. Any extra entry (file, directory, symlink, socket), type
  // change, modification or missing file keeps the whole session.
  const present = listRegularFilesNoFollow(sessionDir.absolute);
  if (present.unsafe.length > 0) {
    return { status: "kept", reason: "unsafe_path", detail: "non_regular_entry", newFiles: present.unsafe };
  }
  const expectedDirs = ancestorDirs(recorded.keys());
  const newFiles = [
    ...present.files.filter((relative) => !recorded.has(relative)),
    ...present.dirs.filter((relative) => !expectedDirs.has(relative) && !recorded.has(relative)).map((dir) => `${dir}/`),
  ];
  const modifiedFiles = [];
  const missingFiles = [];
  for (const [relative, file] of recorded) {
    let resolved;
    try {
      resolved = resolveOwnedPath(anchor, `${sessionRelative}/${relative}`, { allowMissingLeaf: true });
    } catch (error) {
      return { status: "kept", reason: "unsafe_path", detail: error?.code ?? null };
    }
    if (resolved.leaf == null) {
      // A revert interrupted after it started unlinking (write-ahead flag
      // persisted below) legitimately leaves recorded files missing.
      if (record.revertInProgress !== true) missingFiles.push(relative);
    } else if (!resolved.leaf.isFile() || !identitiesEqual(ownedFileIdentity(resolved.absolute), file)) {
      modifiedFiles.push(relative);
    }
  }
  if (newFiles.length > 0 || modifiedFiles.length > 0 || missingFiles.length > 0) {
    return { status: "kept", reason: "used_after_migration", newFiles, modifiedFiles, missingFiles };
  }
  // From here on progress is reported file by file (`removedFiles`), so an
  // I/O error midway (EACCES, EPERM, ...) leaves a manifest that a later
  // revert can resume instead of treating already-removed files as missing.
  // Write-ahead: persist that unlinking has started, so a crash or a failed
  // manifest write after some unlinks can be resumed instead of looking like
  // post-migration use (missing files).
  if (record.revertInProgress !== true) {
    record.revertInProgress = true;
    try {
      persistProgress();
    } catch (error) {
      delete record.revertInProgress;
      return { status: "kept", reason: "remove_failed", detail: error?.code ?? "manifest_write_failed" };
    }
  }
  const removed = [];
  for (const [relative, file] of recorded) {
    let result;
    try {
      result = removeOwnedFileIfUnchanged({ anchor, relative: `${sessionRelative}/${relative}`, identity: file });
    } catch (error) {
      return { status: "kept", reason: "remove_failed", detail: error?.code ?? null, removedFiles: removed };
    }
    if (result.status !== "removed" && result.status !== "missing") {
      return { status: "kept", reason: result.status, detail: result.reason ?? null, removedFiles: removed };
    }
    removed.push(relative);
  }
  const keptDirs = [];
  for (const dir of dirs) {
    let status;
    try {
      status = removeOwnedEmptyDirectory({ anchor, relative: dir }).status;
    } catch {
      status = "error";
    }
    if (status !== "removed" && status !== "missing") keptDirs.push(dir);
  }
  if (keptDirs.length > 0) {
    return { status: "kept", reason: "directory_not_empty", removedFiles: removed, keptDirs };
  }
  return { status: "removed", removedFiles: removed };
}

export function revertLegacyCursorAcpSessionCopy({ home = process.env.HOME, cursorHome } = {}) {
  const { anchor } = legacyCopyRoots({ home, cursorHome });
  const { manifestPath, manifest } = readLegacyCopyManifest(anchor);
  const removed = [];
  const kept = [];
  const remaining = [];
  for (const record of manifest.copied) {
    const outcome = revertOneSession(anchor, record, () => writeLegacyCopyManifest(manifestPath, manifest));
    if (outcome.status === "removed" || outcome.status === "gone") {
      removed.push(record.sessionId);
      continue;
    }
    const { status: _status, ...details } = outcome;
    kept.push(Object.freeze({ sessionId: record.sessionId, ...details }));
    if (outcome.removedFiles?.length) {
      const removedSet = new Set(outcome.removedFiles);
      record.files = record.files.filter(
        (file) => !removedSet.has(normalizeOwnedRelative(file.path).slice(2).join("/")),
      );
    }
    remaining.push({ ...record, lastRevert: { ...details } });
  }
  if (remaining.length === 0) {
    const resolved = resolveOwnedPath(
      anchor,
      `${CURSOR_ACP_SESSIONS_DIRNAME}/${CURSOR_ACP_LEGACY_COPY_MANIFEST}`,
      { allowMissingLeaf: true, allowMissingAncestors: true },
    );
    if (resolved.leaf?.isFile()) unlinkSync(resolved.absolute);
  } else {
    writeLegacyCopyManifest(manifestPath, { ...manifest, copied: remaining });
  }
  return Object.freeze({ removed: Object.freeze(removed), kept: Object.freeze(kept), manifestPath });
}
