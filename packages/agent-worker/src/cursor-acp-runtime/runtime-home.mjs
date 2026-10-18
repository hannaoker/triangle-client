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
 *
 * Cursor CLI data isolation: the same bundle resolves its data root as
 * `CURSOR_DATA_DIR` -> `~/.cursor` (no XDG step; `paths.js` function `c()`),
 * and keeps `<dataDir>/projects/<workspace-slug>/` (agent transcripts, worker
 * log, terminals, canvases) plus the per-workspace local worker socket under
 * it. The child env therefore also pins `CURSOR_DATA_DIR` to a Triangle-owned
 * directory: default `~/.triangle/cursor-data` (short enough for Cursor's
 * 84-char socket base on a normal macOS HOME; created 0700 on first use),
 * override with `TRIANGLE_CURSOR_DATA_DIR` / `cursorDataDir`. The long
 * `~/Library/Application Support/...` Cursor home is NOT used as the data dir
 * because Cursor would push sockets out of it (see below).
 *
 * Socket-path preflight: Cursor derives the worker socket directory with
 * `paths.js` `kL(workspace)`: `<dataDir>/projects` if <= 84 chars, else
 * `<dataDir>` if <= 84 chars, else the shared `/tmp/.cursor`; then joins the
 * workspace slug and, past 92 chars, truncates to 84 chars + `-<sha256:7>`.
 * The socket is `<that dir>/worker.sock` (`local-worker` `getProjectSocketPath`).
 * A long data dir therefore silently moves sockets out of the isolated tree
 * (ultimately into world-shared `/tmp/.cursor`). `assertCursorSocketPathsFit`
 * fails closed with `cursor_socket_path_too_long` before that can happen.
 */

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
import { createHash } from "node:crypto";
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

/** Cursor `paths.js` `kL`: socket base dir must be <= 84 chars to stay put. */
export const CURSOR_SOCKET_BASE_MAX_CHARS = 84;
/** Cursor `paths.js` `kL`: joined socket dir past 92 chars is hash-truncated. */
export const CURSOR_SOCKET_DIR_MAX_CHARS = 92;
export const CURSOR_SOCKET_DIR_TRUNCATE_CHARS = 84;
export const CURSOR_WORKER_SOCKET_NAME = "worker.sock";
export const CURSOR_SHARED_SOCKET_FALLBACK = "/tmp/.cursor";
/**
 * Max bindable AF_UNIX path, in bytes. darwin: sun_path[104]; measured with
 * the Node bundled in cursor-agent 2026.09.10-fd3934a (v26.8.1): 104 binds,
 * 105 fails EINVAL. linux: sun_path[108] incl. NUL.
 */
export const UNIX_SOCKET_PATH_MAX_BYTES = Object.freeze({ darwin: 104, linux: 107, default: 104 });
/** Longest data dir whose `<dataDir>/projects` still fits the 84-char base. */
export const CURSOR_DATA_DIR_MAX_CHARS = CURSOR_SOCKET_BASE_MAX_CHARS - "/projects".length;

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

function isSameOrInside(candidate, root) {
  const resolveReal = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const relative = path.relative(resolveReal(root), resolveReal(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Default Triangle-owned `CURSOR_DATA_DIR`: `~/.triangle/cursor-data`.
 * Short on purpose: `<it>/projects` must stay <= 84 chars (Cursor socket base).
 */
export function defaultTriangleCursorDataDir({ home = process.env.HOME } = {}) {
  if (typeof home !== "string" || !home.startsWith("/")) {
    throw createCodedError("cursor_home_invalid", "HOME must be an absolute path to resolve the Cursor data dir");
  }
  return path.join(home, ".triangle", "cursor-data");
}

/**
 * Resolve the Triangle-owned `CURSOR_DATA_DIR`. Defaults to
 * `~/.triangle/cursor-data`; `TRIANGLE_CURSOR_DATA_DIR` (or `override`) may
 * point elsewhere. Never `~/.cursor` (or inside it), never `~/.codex`, never
 * `/tmp/.cursor`. `allowCreate` creates it 0700.
 */
export function resolveTriangleCursorDataDir({
  override = process.env.TRIANGLE_CURSOR_DATA_DIR,
  home = process.env.HOME,
  allowCreate = false,
} = {}) {
  const candidate =
    typeof override === "string" && override.length > 0
      ? override
      : defaultTriangleCursorDataDir({ home });
  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.includes("\0")) {
    throw createCodedError("cursor_data_dir_invalid", "TRIANGLE_CURSOR_DATA_DIR must be an absolute path");
  }
  if (MESH_SECRET.test(candidate)) {
    throw createCodedError("secret_leak_rejected", "Cursor data dir path must not contain mesh_ credentials");
  }
  const userCursor = typeof home === "string" && home.startsWith("/") ? path.join(home, ".cursor") : null;
  const userCodex = typeof home === "string" && home.startsWith("/") ? path.join(home, ".codex") : null;
  const assertNotForbidden = (value) => {
    if (userCursor && isSameOrInside(value, userCursor)) {
      throw createCodedError(
        "cursor_data_dir_user_fallback_forbidden",
        "Triangle CURSOR_DATA_DIR must not resolve to or inside ~/.cursor",
      );
    }
    if (userCodex && isSameOrInside(value, userCodex)) {
      throw createCodedError(
        "cursor_data_dir_codex_forbidden",
        "Triangle CURSOR_DATA_DIR must not resolve to or inside ~/.codex",
      );
    }
    if (isSameOrInside(value, CURSOR_SHARED_SOCKET_FALLBACK)) {
      throw createCodedError(
        "cursor_data_dir_shared_forbidden",
        "Triangle CURSOR_DATA_DIR must not be the shared /tmp/.cursor fallback",
      );
    }
  };
  assertNotForbidden(candidate);
  if (allowCreate) {
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
  }
  let resolved = candidate;
  try {
    resolved = realpathSync(candidate);
  } catch {
    // Cursor creates it on demand; keep the lexical path.
  }
  assertNotForbidden(resolved);
  return resolved;
}

/** Cursor `workspace-paths.js` `r_`: non-alphanumerics -> "-", collapsed, trimmed. */
export function cursorWorkspaceSlug(workspacePath) {
  return String(workspacePath)
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function socketByteLimit(platform) {
  return UNIX_SOCKET_PATH_MAX_BYTES[platform] ?? UNIX_SOCKET_PATH_MAX_BYTES.default;
}

/**
 * Pure re-implementation of Cursor's worker-socket derivation for `dataDir`
 * (`paths.js` `kL` + `local-worker` `getProjectSocketPath`), plus problems.
 */
export function planCursorSocketPaths({
  dataDir,
  workspacePaths = [],
  platform = process.platform,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir.startsWith("/")) {
    throw createCodedError("cursor_data_dir_invalid", "dataDir must be an absolute path");
  }
  const limitBytes = socketByteLimit(platform);
  const projectsDir = path.join(dataDir, "projects");
  let base;
  if (projectsDir.length <= CURSOR_SOCKET_BASE_MAX_CHARS) {
    base = { kind: "projects", dir: projectsDir };
  } else if (dataDir.length <= CURSOR_SOCKET_BASE_MAX_CHARS) {
    base = { kind: "data_dir", dir: dataDir };
  } else {
    base = { kind: "shared_tmp_fallback", dir: CURSOR_SHARED_SOCKET_FALLBACK };
  }
  const problems = [];
  if (base.kind === "data_dir") {
    problems.push({
      reason: "cursor_projects_dir_exceeds_socket_base",
      path: projectsDir,
      length: projectsDir.length,
      limit: CURSOR_SOCKET_BASE_MAX_CHARS,
    });
  } else if (base.kind === "shared_tmp_fallback") {
    problems.push({
      reason: "cursor_socket_dir_escapes_to_shared_tmp",
      path: projectsDir,
      length: projectsDir.length,
      limit: CURSOR_SOCKET_BASE_MAX_CHARS,
    });
  } else if (Buffer.byteLength(projectsDir) > CURSOR_SOCKET_BASE_MAX_CHARS) {
    // Cursor measures UTF-16 length; the kernel measures bytes.
    problems.push({
      reason: "cursor_projects_dir_exceeds_socket_base_bytes",
      path: projectsDir,
      length: Buffer.byteLength(projectsDir),
      limit: CURSOR_SOCKET_BASE_MAX_CHARS,
    });
  }
  const sockets = [];
  for (const workspacePath of workspacePaths) {
    if (typeof workspacePath !== "string" || !workspacePath.startsWith("/")) {
      throw createCodedError("cursor_workspace_invalid", "workspace paths must be absolute");
    }
    let dir = path.join(base.dir, cursorWorkspaceSlug(workspacePath));
    if (dir.length > CURSOR_SOCKET_DIR_MAX_CHARS) {
      const digest = createHash("sha256").update(dir).digest("hex").substring(0, 7);
      dir = `${dir.substring(0, Math.min(CURSOR_SOCKET_DIR_TRUNCATE_CHARS, dir.length))}-${digest}`;
    }
    const socketPath = path.join(dir, CURSOR_WORKER_SOCKET_NAME);
    const bytes = Buffer.byteLength(socketPath);
    sockets.push(Object.freeze({ workspacePath, socketPath, bytes }));
    if (bytes > limitBytes) {
      problems.push({
        reason: "cursor_socket_path_exceeds_os_limit",
        path: socketPath,
        length: bytes,
        limit: limitBytes,
      });
    }
  }
  return Object.freeze({
    dataDir,
    projectsDir,
    base: Object.freeze(base),
    sockets: Object.freeze(sockets),
    limitBytes,
    problems: Object.freeze(problems.map((problem) => Object.freeze(problem))),
    ok: problems.length === 0,
  });
}

/**
 * Preflight: throw `cursor_socket_path_too_long` if any Cursor socket path
 * derived from the Triangle data dir would leave `<dataDir>/projects` or
 * exceed the OS AF_UNIX limit. Returns the plan when everything fits.
 */
export function assertCursorSocketPathsFit(options = {}) {
  const plan = planCursorSocketPaths(options);
  if (plan.ok) return plan;
  const first = plan.problems[0];
  const suggestion =
    "unset TRIANGLE_CURSOR_DATA_DIR to use the default ~/.triangle/cursor-data, or set it to a " +
    `shorter Triangle-owned directory (<= ${CURSOR_DATA_DIR_MAX_CHARS} chars, not under ~/.cursor)`;
  throw createCodedError(
    "cursor_socket_path_too_long",
    `Cursor socket path preflight failed (${first.reason}: ${first.length} > ${first.limit}); ${suggestion}`,
    { reason: first.reason, problems: plan.problems, suggestion },
  );
}

/**
 * Non-throwing description of the Cursor dirs Triangle would hand the child,
 * for status / doctor surfaces: config dir, data dir (+ whether it is the
 * default or an override), and the socket preflight result.
 */
export function describeTriangleCursorDirs({
  cursorHome,
  cursorDataDir,
  env = process.env,
  workspacePaths = [],
} = {}) {
  const override = cursorDataDir ?? env.TRIANGLE_CURSOR_DATA_DIR;
  const dataDirSource =
    typeof override === "string" && override.length > 0 ? "override" : "default";
  const result = { configDir: null, dataDir: null, dataDirSource, socketPreflight: null };
  try {
    result.configDir = resolveTriangleCursorHome({ override: cursorHome, home: env.HOME, allowCreate: false });
  } catch (error) {
    result.configDirError = error?.code ?? "cursor_home_invalid";
  }
  try {
    result.dataDir = resolveTriangleCursorDataDir({ override, home: env.HOME, allowCreate: false });
    const plan = planCursorSocketPaths({ dataDir: result.dataDir, workspacePaths });
    result.socketPreflight = Object.freeze({
      ok: plan.ok,
      base: plan.base.kind,
      reasons: Object.freeze(plan.problems.map((problem) => problem.reason)),
    });
  } catch (error) {
    result.dataDirError = error?.code ?? "cursor_data_dir_invalid";
  }
  return Object.freeze(result);
}

/**
 * Build a minimal ACP child environment. Never copies MESH credentials.
 * Never puts Cursor home secrets on argv — callers use this env map.
 * Never sets CODEX_HOME.
 */
export function buildSanitizedCursorChildEnv({
  cursorHome,
  cursorDataDir,
  workspacePaths = [],
  parentEnv = process.env,
  extra = {},
} = {}) {
  const home = resolveTriangleCursorHome({
    override: cursorHome,
    home: parentEnv.HOME,
    allowCreate: false,
  });
  const dataDir = resolveTriangleCursorDataDir({
    override: cursorDataDir ?? parentEnv.TRIANGLE_CURSOR_DATA_DIR,
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

  if (
    extra != null &&
    Object.prototype.hasOwnProperty.call(extra, "CURSOR_DATA_DIR") &&
    extra.CURSOR_DATA_DIR != null &&
    !pathsEqual(String(extra.CURSOR_DATA_DIR), dataDir)
  ) {
    throw createCodedError(
      "cursor_data_dir_conflict",
      "CURSOR_DATA_DIR must point at the dedicated Triangle Cursor data dir",
    );
  }
  // Isolate Cursor CLI data (projects/<slug>: transcripts, worker socket, ...)
  // and refuse a data dir that would push sockets out of it.
  assertCursorSocketPathsFit({ dataDir, workspacePaths });
  child.CURSOR_DATA_DIR = dataDir;
  child.TRIANGLE_CURSOR_DATA_DIR = dataDir;

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
  return {
    anchor,
    sourceRoot: path.join(home, ".cursor", CURSOR_ACP_SESSIONS_DIRNAME),
    targetRoot: path.join(anchor, CURSOR_ACP_SESSIONS_DIRNAME),
  };
}

/** Regular files below `root` (relative paths); anything else is "unsafe". */
export function listRegularFilesNoFollow(root) {
  const files = [];
  const unsafe = [];
  const visit = (relativeDir) => {
    for (const name of readdirSync(path.join(root, relativeDir)).sort()) {
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      const stat = lstatSync(path.join(root, relative));
      if (stat.isDirectory()) visit(relative);
      else if (stat.isFile()) files.push(relative);
      else unsafe.push(relative);
    }
  };
  visit("");
  return { files, unsafe };
}

export function planLegacyCursorAcpSessionCopy({ home = process.env.HOME, cursorHome, sessionIds } = {}) {
  const ids = assertCursorSessionIds(sessionIds);
  const { anchor, sourceRoot, targetRoot } = legacyCopyRoots({ home, cursorHome });
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
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      return Object.freeze({ sessionId, action: "missing_source", source, target });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return Object.freeze({ sessionId, action: "unsafe_source", source, target });
    }
    const { files, unsafe } = listRegularFilesNoFollow(source);
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
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, manifestPath);
}

export function applyLegacyCursorAcpSessionCopy({
  home = process.env.HOME,
  cursorHome,
  sessionIds,
  now = () => new Date().toISOString(),
} = {}) {
  const plan = planLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds });
  const { anchor } = legacyCopyRoots({ home, cursorHome });
  const rootCreated = ensureOwnedDirectory(anchor, CURSOR_ACP_SESSIONS_DIRNAME);
  const { manifestPath, manifest } = readLegacyCopyManifest(anchor);
  manifest.schemaVersion = LEGACY_SESSION_MANIFEST_SCHEMA;
  const copied = [];
  for (const entry of plan.entries) {
    if (entry.action !== "copy") continue;
    const record = { sessionId: entry.sessionId, copiedAt: now(), files: [], createdDirs: [] };
    manifest.copied.push(record);
    try {
      record.createdDirs.push(...ensureOwnedDirectory(anchor, `${CURSOR_ACP_SESSIONS_DIRNAME}/${entry.sessionId}`)
        .filter((dir) => !rootCreated.includes(dir)));
      for (const relative of entry.files) {
        const targetRelative = `${CURSOR_ACP_SESSIONS_DIRNAME}/${entry.sessionId}/${relative}`;
        const result = copyFileIntoOwned({
          anchor,
          relative: targetRelative,
          source: path.join(entry.source, relative),
        });
        record.createdDirs.push(...result.createdDirs);
        if (result.status === "copied") {
          record.files.push({ path: targetRelative, ...result.identity });
        }
      }
    } finally {
      writeLegacyCopyManifest(manifestPath, manifest);
    }
    copied.push(entry.sessionId);
  }
  return Object.freeze({
    copied: Object.freeze(copied),
    skipped: Object.freeze(
      plan.entries
        .filter((entry) => entry.action !== "copy")
        .map(({ sessionId, action }) => Object.freeze({ sessionId, action })),
    ),
    manifestPath,
  });
}

function revertOneSession(anchor, record) {
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
    const parts = normalizeOwnedRelative(file.path);
    if (parts[0] !== CURSOR_ACP_SESSIONS_DIRNAME || parts[1] !== sessionId) {
      return { status: "kept", reason: "unsafe_path", detail: "manifest_entry_outside_session" };
    }
    recorded.set(parts.slice(2).join("/"), file);
  }
  const present = listRegularFilesNoFollow(sessionDir.absolute);
  const newFiles = present.files.filter((relative) => !recorded.has(relative));
  if (present.unsafe.length > 0) {
    return { status: "kept", reason: "unsafe_path", detail: "non_regular_entry", newFiles: present.unsafe };
  }
  const modifiedFiles = [];
  const missingFiles = [];
  for (const [relative, file] of recorded) {
    const resolved = resolveOwnedPath(anchor, `${sessionRelative}/${relative}`, { allowMissingLeaf: true });
    if (resolved.leaf == null) {
      missingFiles.push(relative);
    } else if (!identitiesEqual(ownedFileIdentity(resolved.absolute), file)) {
      modifiedFiles.push(relative);
    }
  }
  if (newFiles.length > 0 || modifiedFiles.length > 0 || missingFiles.length > 0) {
    return { status: "kept", reason: "used_after_migration", newFiles, modifiedFiles, missingFiles };
  }
  const removed = [];
  for (const [relative, file] of recorded) {
    const result = removeOwnedFileIfUnchanged({ anchor, relative: `${sessionRelative}/${relative}`, identity: file });
    if (result.status !== "removed" && result.status !== "missing") {
      return { status: "kept", reason: result.status, detail: result.reason ?? null, removedFiles: removed };
    }
    removed.push(relative);
  }
  const dirs = [...new Set(record.createdDirs ?? [])].sort((a, b) => b.length - a.length);
  const keptDirs = [];
  for (const dir of dirs) {
    const result = removeOwnedEmptyDirectory({ anchor, relative: dir });
    if (result.status === "not_empty" || result.status === "unsafe_path") keptDirs.push(dir);
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
    const outcome = revertOneSession(anchor, record);
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

/**
 * Explicit, reversible copy of a workspace's legacy Cursor transcripts from
 * `~/.cursor/projects/<slug>/agent-transcripts/` (written before
 * CURSOR_DATA_DIR isolation) into `<dataDir>/projects/<slug>/agent-transcripts/`.
 * Nothing here runs automatically; run only while the Cursor ACP drain is
 * stopped.
 *
 * - plan: read-only; classifies every regular file per workspace.
 * - apply: COPIES (never moves/deletes) regular files that are not already
 *   present (exclusive create), preserving mtimes, and records each created
 *   file's identity (size, mtime, sha256) and each created directory in a
 *   manifest. Every target path is validated physically below the realpath'd
 *   data dir (owned-fs.mjs): any symlinked or non-directory ancestor is
 *   rejected, so apply can never write outside the owned tree.
 * - revert (undo-after-use contract): per file. A copied file is removed only
 *   if it still matches its recorded identity and its path is physically
 *   inside the data dir. Files appended/modified after migration, files whose
 *   path became unsafe (e.g. a parent replaced by a symlink), and files created
 *   after migration are left in place; the first two are reported in
 *   `keptFiles` and stay in the manifest. Recorded directories are removed
 *   only when empty (never recursively). The manifest is deleted only when
 *   nothing remains.
 *
 * Only `agent-transcripts/` is copied: the rest of a project dir holds the live
 * worker socket, logs and terminal scratch that must not be duplicated.
 */
export const CURSOR_LEGACY_TRANSCRIPT_COPY_MANIFEST = ".triangle-legacy-transcript-copy.json";
export const CURSOR_TRANSCRIPTS_DIRNAME = "agent-transcripts";
const LEGACY_TRANSCRIPT_MANIFEST_SCHEMA = 2;
const PROJECTS_DIRNAME = "projects";
const TRANSCRIPT_MANIFEST_RELATIVE = `${PROJECTS_DIRNAME}/${CURSOR_LEGACY_TRANSCRIPT_COPY_MANIFEST}`;

function legacyTranscriptRoots({ home, cursorDataDir, allowCreate = false }) {
  if (typeof home !== "string" || !home.startsWith("/")) {
    throw createCodedError("cursor_home_invalid", "HOME must be an absolute path");
  }
  const anchor = resolveTriangleCursorDataDir({ override: cursorDataDir, home, allowCreate });
  return {
    anchor,
    sourceRoot: path.join(home, ".cursor", PROJECTS_DIRNAME),
    targetRoot: path.join(anchor, PROJECTS_DIRNAME),
  };
}

function assertWorkspacePaths(workspacePaths) {
  if (!Array.isArray(workspacePaths) || workspacePaths.length === 0) {
    throw createCodedError("cursor_workspace_invalid", "workspacePaths must be a non-empty array");
  }
  const slugs = new Map();
  for (const workspacePath of workspacePaths) {
    if (typeof workspacePath !== "string" || !workspacePath.startsWith("/")) {
      throw createCodedError("cursor_workspace_invalid", "workspace paths must be absolute");
    }
    const slug = cursorWorkspaceSlug(workspacePath);
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug)) {
      throw createCodedError("cursor_workspace_invalid", "workspace path has no usable Cursor slug");
    }
    if (!slugs.has(slug)) slugs.set(slug, workspacePath);
  }
  return [...slugs].map(([slug, workspacePath]) => ({ slug, workspacePath }));
}

function anchorExists(anchor) {
  try {
    return lstatSync(anchor).isDirectory();
  } catch {
    return false;
  }
}

/** Physical target state for an anchor-relative path; never throws. */
function ownedTargetState(anchor, relative) {
  if (!anchorExists(anchor)) return "missing";
  try {
    const resolved = resolveOwnedPath(anchor, relative, { allowMissingLeaf: true, allowMissingAncestors: true });
    return resolved.leaf == null ? "missing" : "present";
  } catch {
    return "unsafe";
  }
}

export function planLegacyCursorTranscriptCopy({
  home = process.env.HOME,
  cursorDataDir,
  workspacePaths,
} = {}) {
  const workspaces = assertWorkspacePaths(workspacePaths);
  const { anchor, sourceRoot, targetRoot } = legacyTranscriptRoots({ home, cursorDataDir });
  const planned = workspaces.map(({ slug, workspacePath }) => {
    const source = path.join(sourceRoot, slug, CURSOR_TRANSCRIPTS_DIRNAME);
    const targetRelative = `${PROJECTS_DIRNAME}/${slug}/${CURSOR_TRANSCRIPTS_DIRNAME}`;
    const target = path.join(anchor, targetRelative);
    const base = { workspacePath, slug, source, target };
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      return Object.freeze({ ...base, action: "missing_source", files: Object.freeze([]) });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return Object.freeze({ ...base, action: "unsafe_source", files: Object.freeze([]) });
    }
    if (ownedTargetState(anchor, targetRelative) === "unsafe") {
      return Object.freeze({ ...base, action: "unsafe_target", files: Object.freeze([]) });
    }
    const { files, unsafe } = listRegularFilesNoFollow(source);
    const entries = [
      ...files.map((relative) => {
        const state = ownedTargetState(anchor, `${targetRelative}/${relative}`);
        return Object.freeze({
          relative,
          action: state === "present" ? "already_present" : state === "unsafe" ? "unsafe_target" : "copy",
        });
      }),
      ...unsafe.map((relative) => Object.freeze({ relative, action: "unsafe_source" })),
    ];
    return Object.freeze({
      ...base,
      action: entries.some((entry) => entry.action === "copy") ? "copy" : "nothing_to_copy",
      files: Object.freeze(entries),
    });
  });
  return Object.freeze({ dataDir: anchor, sourceRoot, targetRoot, workspaces: Object.freeze(planned) });
}

function readTranscriptManifest(anchor) {
  const resolved = resolveOwnedPath(anchor, TRANSCRIPT_MANIFEST_RELATIVE, {
    allowMissingLeaf: true,
    allowMissingAncestors: true,
  });
  if (resolved.leaf == null) {
    return {
      manifestPath: resolved.absolute,
      manifest: { schemaVersion: LEGACY_TRANSCRIPT_MANIFEST_SCHEMA, createdFiles: [], createdDirs: [] },
    };
  }
  if (!resolved.leaf.isFile()) {
    throw createCodedError("cursor_legacy_manifest_invalid", "legacy transcript copy manifest is not a regular file");
  }
  const manifest = JSON.parse(readFileSync(resolved.absolute, "utf8"));
  if (!Array.isArray(manifest?.createdFiles) || !Array.isArray(manifest?.createdDirs)) {
    throw createCodedError("cursor_legacy_manifest_invalid", "legacy transcript copy manifest is invalid");
  }
  return { manifestPath: resolved.absolute, manifest };
}

function writeTranscriptManifest(anchor, manifest) {
  // Re-validate the manifest location physically right before writing.
  const resolved = resolveOwnedPath(anchor, TRANSCRIPT_MANIFEST_RELATIVE, { allowMissingLeaf: true });
  writeLegacyCopyManifest(resolved.absolute, manifest);
  return resolved.absolute;
}

export function applyLegacyCursorTranscriptCopy({
  home = process.env.HOME,
  cursorDataDir,
  workspacePaths,
  now = () => new Date().toISOString(),
} = {}) {
  const { anchor } = legacyTranscriptRoots({ home, cursorDataDir, allowCreate: true });
  const plan = planLegacyCursorTranscriptCopy({ home, cursorDataDir: anchor, workspacePaths });
  ensureOwnedDirectory(anchor, PROJECTS_DIRNAME);
  const { manifestPath, manifest } = readTranscriptManifest(anchor);
  manifest.schemaVersion = LEGACY_TRANSCRIPT_MANIFEST_SCHEMA;
  const copied = [];
  const skipped = [];
  try {
    for (const workspace of plan.workspaces) {
      if (workspace.action !== "copy" && workspace.action !== "nothing_to_copy") {
        skipped.push(Object.freeze({ slug: workspace.slug, action: workspace.action }));
        continue;
      }
      for (const entry of workspace.files) {
        if (entry.action !== "copy") {
          skipped.push(Object.freeze({ slug: workspace.slug, relative: entry.relative, action: entry.action }));
          continue;
        }
        const relative = `${PROJECTS_DIRNAME}/${workspace.slug}/${CURSOR_TRANSCRIPTS_DIRNAME}/${entry.relative}`;
        const result = copyFileIntoOwned({
          anchor,
          relative,
          source: path.join(workspace.source, entry.relative),
        });
        manifest.createdDirs.push(...result.createdDirs);
        if (result.status !== "copied") {
          skipped.push(Object.freeze({ slug: workspace.slug, relative: entry.relative, action: result.status }));
          continue;
        }
        manifest.createdFiles.push({ path: relative, ...result.identity, copiedAt: now() });
        copied.push(relative);
        writeTranscriptManifest(anchor, manifest);
      }
    }
  } finally {
    writeTranscriptManifest(anchor, manifest);
  }
  return Object.freeze({
    copied: Object.freeze(copied),
    skipped: Object.freeze(skipped),
    manifestPath,
  });
}

export function revertLegacyCursorTranscriptCopy({ home = process.env.HOME, cursorDataDir } = {}) {
  const { anchor } = legacyTranscriptRoots({ home, cursorDataDir });
  if (!anchorExists(anchor)) {
    return Object.freeze({
      removedFiles: Object.freeze([]),
      removedDirs: Object.freeze([]),
      keptFiles: Object.freeze([]),
      keptDirs: Object.freeze([]),
      manifestPath: null,
    });
  }
  const { manifestPath, manifest } = readTranscriptManifest(anchor);
  const removedFiles = [];
  const removedDirs = [];
  const keptFiles = [];
  const keptDirs = [];
  const remainingFiles = [];
  for (const file of manifest.createdFiles) {
    const identity = typeof file?.sha256 === "string" ? file : null;
    const result = identity
      ? removeOwnedFileIfUnchanged({ anchor, relative: file.path, identity })
      : { status: "modified", reason: "no_snapshot" };
    if (result.status === "removed" || result.status === "missing") {
      if (result.status === "removed") removedFiles.push(file.path);
      continue;
    }
    const reason = result.status === "modified" ? (result.reason ?? "modified_after_migration") : result.status;
    keptFiles.push(Object.freeze({ path: file.path, reason, detail: result.reason ?? null }));
    remainingFiles.push({ ...file, lastRevert: { reason, detail: result.reason ?? null } });
  }
  const remainingDirs = [];
  const dirs = [...new Set(manifest.createdDirs)].sort((a, b) => b.length - a.length);
  for (const relative of dirs) {
    const result = removeOwnedEmptyDirectory({ anchor, relative });
    if (result.status === "removed") removedDirs.push(relative);
    if (result.status === "not_empty" || result.status === "unsafe_path") {
      keptDirs.push(relative);
      remainingDirs.push(relative);
    }
  }
  if (remainingFiles.length === 0 && remainingDirs.length === 0) {
    const resolved = resolveOwnedPath(anchor, TRANSCRIPT_MANIFEST_RELATIVE, {
      allowMissingLeaf: true,
      allowMissingAncestors: true,
    });
    if (resolved.leaf?.isFile()) unlinkSync(resolved.absolute);
  } else {
    writeTranscriptManifest(anchor, { ...manifest, createdFiles: remainingFiles, createdDirs: remainingDirs });
  }
  return Object.freeze({
    removedFiles: Object.freeze(removedFiles),
    removedDirs: Object.freeze(removedDirs),
    keptFiles: Object.freeze(keptFiles),
    keptDirs: Object.freeze(keptDirs),
    manifestPath,
  });
}
