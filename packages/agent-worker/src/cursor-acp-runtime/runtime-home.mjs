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
 * directory (default: the Triangle Cursor home; override with
 * `TRIANGLE_CURSOR_DATA_DIR`).
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
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { assertNoSecretMaterial } from "./acp-protocol.mjs";

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
 * Resolve the Triangle-owned `CURSOR_DATA_DIR`. Defaults to the Triangle Cursor
 * home; `TRIANGLE_CURSOR_DATA_DIR` (or `override`) may point at a shorter
 * Triangle-owned directory when the home is too long for Cursor's socket base.
 * Never `~/.cursor` (or inside it), never `~/.codex`, never `/tmp/.cursor`.
 */
export function resolveTriangleCursorDataDir({
  override = process.env.TRIANGLE_CURSOR_DATA_DIR,
  cursorHome,
  home = process.env.HOME,
  allowCreate = false,
} = {}) {
  const candidate =
    typeof override === "string" && override.length > 0 ? override : cursorHome;
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
    "set TRIANGLE_CURSOR_DATA_DIR to a shorter Triangle-owned directory " +
    `(<= ${CURSOR_DATA_DIR_MAX_CHARS} chars, not under ~/.cursor), e.g. ~/.triangle/cursor-data`;
  throw createCodedError(
    "cursor_socket_path_too_long",
    `Cursor socket path preflight failed (${first.reason}: ${first.length} > ${first.limit}); ${suggestion}`,
    { reason: first.reason, problems: plan.problems, suggestion },
  );
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
    cursorHome: home,
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
 * - apply: COPIES (never moves) each referenced session directory into
 *   `<cursorHome>/acp-sessions/<id>`; never overwrites an existing target;
 *   records what it created in a manifest. `~/.cursor` is left untouched.
 * - revert: removes only the directories recorded in the manifest.
 *
 * Only run apply while the Cursor ACP drain is stopped (store.db is SQLite
 * with a WAL; copying under a live writer can capture a torn snapshot).
 */
export const CURSOR_ACP_LEGACY_COPY_MANIFEST = ".triangle-legacy-session-copy.json";

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
  const target = resolveTriangleCursorHome({ override: cursorHome, home, allowCreate: false });
  return {
    sourceRoot: path.join(home, ".cursor", "acp-sessions"),
    targetRoot: path.join(target, "acp-sessions"),
  };
}

export function planLegacyCursorAcpSessionCopy({ home = process.env.HOME, cursorHome, sessionIds } = {}) {
  const ids = assertCursorSessionIds(sessionIds);
  const { sourceRoot, targetRoot } = legacyCopyRoots({ home, cursorHome });
  const entries = ids.map((sessionId) => {
    const source = path.join(sourceRoot, sessionId);
    const target = path.join(targetRoot, sessionId);
    if (existsSync(target)) return Object.freeze({ sessionId, action: "already_present", source, target });
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      return Object.freeze({ sessionId, action: "missing_source", source, target });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return Object.freeze({ sessionId, action: "unsafe_source", source, target });
    }
    return Object.freeze({ sessionId, action: "copy", source, target });
  });
  return Object.freeze({ sourceRoot, targetRoot, entries: Object.freeze(entries) });
}

function readLegacyCopyManifest(targetRoot) {
  const manifestPath = path.join(targetRoot, CURSOR_ACP_LEGACY_COPY_MANIFEST);
  if (!existsSync(manifestPath)) return { manifestPath, manifest: { schemaVersion: 1, copied: [] } };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest?.copied)) {
    throw createCodedError("cursor_legacy_manifest_invalid", "legacy session copy manifest is invalid");
  }
  return { manifestPath, manifest };
}

function writeLegacyCopyManifest(manifestPath, manifest) {
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, manifestPath);
}

export function applyLegacyCursorAcpSessionCopy({
  home = process.env.HOME,
  cursorHome,
  sessionIds,
  now = () => new Date().toISOString(),
} = {}) {
  const plan = planLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds });
  mkdirSync(plan.targetRoot, { recursive: true, mode: 0o700 });
  const { manifestPath, manifest } = readLegacyCopyManifest(plan.targetRoot);
  const copied = [];
  for (const entry of plan.entries) {
    if (entry.action !== "copy") continue;
    cpSync(entry.source, entry.target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    copied.push(entry.sessionId);
    manifest.copied.push({ sessionId: entry.sessionId, copiedAt: now() });
    writeLegacyCopyManifest(manifestPath, manifest);
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

export function revertLegacyCursorAcpSessionCopy({ home = process.env.HOME, cursorHome } = {}) {
  const { targetRoot } = legacyCopyRoots({ home, cursorHome });
  const { manifestPath, manifest } = readLegacyCopyManifest(targetRoot);
  const removed = [];
  for (const { sessionId } of manifest.copied) {
    assertCursorSessionIds([sessionId]);
    const target = path.join(targetRoot, sessionId);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed.push(sessionId);
    }
  }
  rmSync(manifestPath, { force: true });
  return Object.freeze({ removed: Object.freeze(removed) });
}
