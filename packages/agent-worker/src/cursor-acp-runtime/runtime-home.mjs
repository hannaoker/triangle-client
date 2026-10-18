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

import { mkdirSync, realpathSync, statSync } from "node:fs";
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
  const userCodex = typeof home === "string" ? path.join(home, ".codex") : null;
  // Neither ~/.cursor nor ~/.codex, nor anything inside them (canonicalized,
  // projected through existing symlinked ancestors), checked before mkdir and
  // again on the resolved path.
  const assertNotForbidden = (value) => {
    if (userCursor && isSameOrInside(value, userCursor)) {
      throw createCodedError(
        "cursor_home_user_fallback_forbidden",
        "dedicated Triangle Cursor home must not resolve to or inside ~/.cursor",
      );
    }
    if (userCodex && isSameOrInside(value, userCodex)) {
      throw createCodedError(
        "cursor_home_codex_forbidden",
        "dedicated Triangle Cursor home must not resolve to or inside ~/.codex or CODEX_HOME",
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
  } catch (error) {
    if (!allowCreate) {
      throw createCodedError(
        "cursor_home_missing",
        "dedicated Triangle Cursor home does not exist",
        { path: candidate, causeCode: error?.code ?? null },
      );
    }
  }

  assertNotForbidden(resolved);

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
  // Only an exact `..` component means "outside": `..triangle` is a child name.
  return relative === "" || !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
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
