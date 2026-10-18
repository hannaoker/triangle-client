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

/**
 * Physical projection of a possibly-missing path: realpath of its deepest
 * existing ancestor joined with the missing suffix. A not-yet-created dir
 * below a symlink therefore projects to where it WOULD be created.
 */
function physicalProjection(value) {
  let existing = path.resolve(value);
  const suffix = [];
  for (;;) {
    try {
      return path.join(realpathSync(existing), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(value);
      suffix.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isSameOrInside(candidate, root) {
  const relative = path.relative(physicalProjection(root), physicalProjection(candidate));
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
  // `.`/`..` segments are rejected outright: lexical collapsing (`alias/..`)
  // differs from filesystem traversal through a symlinked `alias`, which
  // could otherwise slip a forbidden target past the containment check.
  if (candidate.split("/").some((part) => part === "." || part === "..")) {
    throw createCodedError(
      "cursor_data_dir_invalid",
      "TRIANGLE_CURSOR_DATA_DIR must be a normalized absolute path (no '.' or '..' segments)",
    );
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
  // `isSameOrInside` projects through existing symlinked ancestors, so a
  // missing dir below a symlink into ~/.cursor or ~/.codex is rejected here,
  // BEFORE mkdir can create anything inside the forbidden tree.
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
  defaultWorkspaceToConfigDir = false,
} = {}) {
  const override = cursorDataDir ?? env.TRIANGLE_CURSOR_DATA_DIR ?? null;
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
    const workspaces =
      workspacePaths.length > 0
        ? workspacePaths
        : defaultWorkspaceToConfigDir && result.configDir
          ? [result.configDir]
          : [];
    const plan = planCursorSocketPaths({ dataDir: result.dataDir, workspacePaths: workspaces });
    result.socketPreflight = Object.freeze({
      ok: plan.ok,
      workspacePaths: Object.freeze([...workspaces]),
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
    override: cursorDataDir ?? parentEnv.TRIANGLE_CURSOR_DATA_DIR ?? null,
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
      // back (identity-checked). If rollback cannot finish, retry persisting
      // it as `incomplete` so revert can clean it; if the manifest is still
      // unwritable, return the exact leftover files (path + identity) in
      // `failed[].untrackedFiles` and stop migrating further sessions.
      manifest.copied.pop();
      const clean = rollbackIncompleteSession(anchor, record);
      const code = typeof error?.code === "string" ? error.code : "cursor_legacy_manifest_write_failed";
      if (clean) {
        failed.push(Object.freeze({ sessionId: entry.sessionId, code, rolledBack: true }));
        continue;
      }
      manifest.copied.push({ ...record, incomplete: true });
      let recorded = true;
      try {
        writeLegacyCopyManifest(manifestPath, manifest);
      } catch {
        recorded = false;
        manifest.copied.pop();
      }
      failed.push(Object.freeze({
        sessionId: entry.sessionId,
        code,
        rolledBack: false,
        recordedIncomplete: recorded,
        ...(recorded
          ? {}
          : {
              untrackedFiles: Object.freeze(record.files.map((file) => Object.freeze({ ...file }))),
              untrackedDirs: Object.freeze([...record.createdDirs]),
            }),
      }));
      if (!recorded) break;
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
  if (record == null || typeof record !== "object" || typeof record.sessionId !== "string" ||
    !CURSOR_SESSION_ID.test(record.sessionId)) {
    return { status: "kept", reason: "unsafe_path", detail: "manifest_record_invalid" };
  }
  const { sessionId } = record;
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
  const dirs = [...new Set(Array.isArray(record.createdDirs) ? record.createdDirs : [])]
    .sort((a, b) => String(b).length - String(a).length);
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
  // Directories this migration created stay "expected" even once a resumed
  // revert has emptied them (their files are no longer in `recorded`).
  const expectedDirs = ancestorDirs(recorded.keys());
  for (const dir of dirs) {
    const parts = safeOwnedParts(dir);
    if (parts.length > 2) expectedDirs.add(parts.slice(2).join("/"));
  }
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
    let outcome;
    try {
      outcome = revertOneSession(anchor, record, () => writeLegacyCopyManifest(manifestPath, manifest));
    } catch (error) {
      // One bad record never aborts the revert of the others.
      outcome = { status: "kept", reason: "revert_error", detail: error?.code ?? null };
    }
    const sessionId = typeof record?.sessionId === "string" ? record.sessionId : null;
    if (outcome.status === "removed" || outcome.status === "gone") {
      removed.push(sessionId);
      continue;
    }
    const { status: _status, ...details } = outcome;
    kept.push(Object.freeze({ sessionId, ...details }));
    if (record == null || typeof record !== "object") {
      remaining.push(record); // preserved verbatim for manual inspection
      continue;
    }
    if (outcome.removedFiles?.length) {
      const removedSet = new Set(outcome.removedFiles);
      record.files = record.files.filter(
        (file) => !removedSet.has((safeOwnedParts(file?.path) ?? []).slice(2).join("/")),
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
  let sourceAnchor = null;
  try {
    sourceAnchor = realpathSync(home);
  } catch {
    sourceAnchor = null;
  }
  return {
    anchor,
    sourceAnchor,
    sourceRootRelative: `.cursor/${PROJECTS_DIRNAME}`,
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
  const { anchor, sourceAnchor, sourceRootRelative, sourceRoot, targetRoot } = legacyTranscriptRoots({
    home,
    cursorDataDir,
  });
  const planned = workspaces.map(({ slug, workspacePath }) => {
    const source = path.join(sourceRoot, slug, CURSOR_TRANSCRIPTS_DIRNAME);
    const sourceRelative = `${sourceRootRelative}/${slug}/${CURSOR_TRANSCRIPTS_DIRNAME}`;
    const targetRelative = `${PROJECTS_DIRNAME}/${slug}/${CURSOR_TRANSCRIPTS_DIRNAME}`;
    const target = path.join(anchor, targetRelative);
    const base = { workspacePath, slug, source, sourceRelative, target };
    if (sourceAnchor == null) {
      return Object.freeze({ ...base, action: "missing_source", files: Object.freeze([]) });
    }
    // Physical source check below realpath(HOME): `.cursor`, `projects`, the
    // slug dir and `agent-transcripts` must all be real directories.
    let sourceState;
    try {
      sourceState = resolveOwnedPath(sourceAnchor, sourceRelative, {
        allowMissingLeaf: true,
        allowMissingAncestors: true,
      });
    } catch {
      return Object.freeze({ ...base, action: "unsafe_source", files: Object.freeze([]) });
    }
    if (sourceState.leaf == null) {
      return Object.freeze({ ...base, action: "missing_source", files: Object.freeze([]) });
    }
    if (!sourceState.leaf.isDirectory()) {
      return Object.freeze({ ...base, action: "unsafe_source", files: Object.freeze([]) });
    }
    if (ownedTargetState(anchor, targetRelative) === "unsafe") {
      return Object.freeze({ ...base, action: "unsafe_target", files: Object.freeze([]) });
    }
    const { files, unsafe } = listRegularFilesNoFollow(sourceState.absolute);
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
  const socketPlan = planCursorSocketPaths({
    dataDir: anchor,
    workspacePaths: workspaces.map((entry) => entry.workspacePath),
  });
  return Object.freeze({
    dataDir: anchor,
    sourceRoot,
    targetRoot,
    socketPreflight: Object.freeze({
      ok: socketPlan.ok,
      reasons: Object.freeze(socketPlan.problems.map((problem) => problem.reason)),
    }),
    workspaces: Object.freeze(planned),
  });
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
  // Fail closed BEFORE creating or copying anything: never migrate context
  // into a data dir the ACP runtime would refuse (cursor_socket_path_too_long).
  {
    const { anchor: candidate } = legacyTranscriptRoots({ home, cursorDataDir });
    assertCursorSocketPathsFit({
      dataDir: candidate,
      workspacePaths: assertWorkspacePaths(workspacePaths).map((entry) => entry.workspacePath),
    });
  }
  const { anchor, sourceAnchor } = legacyTranscriptRoots({ home, cursorDataDir, allowCreate: true });
  const plan = planLegacyCursorTranscriptCopy({ home, cursorDataDir: anchor, workspacePaths });
  const projectsCreated = ensureOwnedDirectory(anchor, PROJECTS_DIRNAME).length > 0;
  const { manifestPath, manifest } = readTranscriptManifest(anchor);
  manifest.schemaVersion = LEGACY_TRANSCRIPT_MANIFEST_SCHEMA;
  // Remember that apply created `projects/` so revert can remove it (when
  // empty) once the manifest that lives inside it is gone.
  if (projectsCreated) manifest.createdProjectsRoot = true;
  const copied = [];
  const skipped = [];
  let failure = null;
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
        let result;
        try {
          result = copyFileIntoOwned({
            anchor,
            relative,
            sourceAnchor,
            sourceRelative: `${workspace.sourceRelative}/${entry.relative}`,
          });
        } catch (error) {
          if (Array.isArray(error?.createdDirs)) manifest.createdDirs.push(...error.createdDirs);
          throw error;
        }
        manifest.createdDirs.push(...result.createdDirs);
        if (result.status !== "copied") {
          skipped.push(Object.freeze({ slug: workspace.slug, relative: entry.relative, action: result.status }));
          continue;
        }
        const record = { path: relative, ...result.identity, copiedAt: now() };
        manifest.createdFiles.push(record);
        try {
          writeTranscriptManifest(anchor, manifest);
        } catch (error) {
          // Never leave a copy no manifest knows about: roll this file (and
          // the empty dirs its copy created) back, identity-checked.
          manifest.createdFiles.pop();
          let status;
          try {
            status = removeOwnedFileIfUnchanged({ anchor, relative, identity: record }).status;
          } catch {
            status = "error";
          }
          const rolledBack = status === "removed" || status === "missing";
          if (rolledBack) {
            for (const dir of [...result.createdDirs].reverse()) {
              let dirStatus;
              try {
                dirStatus = removeOwnedEmptyDirectory({ anchor, relative: dir }).status;
              } catch {
                dirStatus = "error";
              }
              if (dirStatus === "removed" || dirStatus === "missing") {
                const index = manifest.createdDirs.lastIndexOf(dir);
                if (index >= 0) manifest.createdDirs.splice(index, 1);
              }
            }
          } else {
            manifest.createdFiles.push(record); // final write below may still record it
          }
          throw Object.assign(error, { rolledBack, transcript: relative, identity: record });
        }
        copied.push(relative);
      }
    }
  } catch (error) {
    failure = error;
  }
  // Best-effort final persist (also records dirs created before a failure).
  try {
    writeTranscriptManifest(anchor, manifest);
  } catch (error) {
    if (failure == null) failure = error;
    else if (failure.rolledBack === false) {
      // Durable record impossible: surface the exact untracked file.
      failure.untrackedFiles = [{ ...failure.identity }];
    }
  }
  if (failure != null) throw failure;
  return Object.freeze({
    copied: Object.freeze(copied),
    skipped: Object.freeze(skipped),
    manifestPath,
  });
}

const TRANSCRIPT_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Manifest file entries must be `projects/<slug>/agent-transcripts/<file...>`. */
function isTranscriptFileEntry(relative) {
  const parts = safeOwnedParts(relative);
  return (
    parts != null &&
    parts.length >= 4 &&
    parts[0] === PROJECTS_DIRNAME &&
    TRANSCRIPT_SLUG.test(parts[1]) &&
    parts[2] === CURSOR_TRANSCRIPTS_DIRNAME
  );
}

/** Manifest dir entries: `projects/<slug>` or `projects/<slug>/agent-transcripts[/...]`. */
function isTranscriptDirEntry(relative) {
  const parts = safeOwnedParts(relative);
  return (
    parts != null &&
    parts.length >= 2 &&
    parts[0] === PROJECTS_DIRNAME &&
    TRANSCRIPT_SLUG.test(parts[1]) &&
    (parts.length === 2 || parts[2] === CURSOR_TRANSCRIPTS_DIRNAME)
  );
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
    if (!isTranscriptFileEntry(file?.path)) {
      const reason = "unsafe_path";
      const detail = "manifest_entry_outside_transcripts";
      keptFiles.push(Object.freeze({ path: file?.path ?? null, reason, detail }));
      remainingFiles.push({ ...file, lastRevert: { reason, detail } });
      continue;
    }
    const identity = typeof file?.sha256 === "string" ? file : null;
    let result;
    try {
      result = identity
        ? removeOwnedFileIfUnchanged({ anchor, relative: file.path, identity })
        : { status: "modified", reason: "no_snapshot" };
    } catch (error) {
      result = { status: "remove_failed", reason: error?.code ?? null };
    }
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
    if (!isTranscriptDirEntry(relative)) {
      keptDirs.push(relative);
      remainingDirs.push(relative);
      continue;
    }
    let result;
    try {
      result = removeOwnedEmptyDirectory({ anchor, relative });
    } catch (error) {
      result = { status: "remove_failed", reason: error?.code ?? null };
    }
    if (result.status === "removed") removedDirs.push(relative);
    if (result.status !== "removed" && result.status !== "missing") {
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
    if (manifest.createdProjectsRoot === true) {
      let result;
      try {
        result = removeOwnedEmptyDirectory({ anchor, relative: PROJECTS_DIRNAME });
      } catch {
        result = { status: "remove_failed" };
      }
      if (result.status === "removed") removedDirs.push(PROJECTS_DIRNAME);
      else if (result.status !== "missing") keptDirs.push(PROJECTS_DIRNAME);
    }
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
