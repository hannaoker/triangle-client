/**
 * Dedicated Triangle runtime CODEX_HOME plumbing.
 *
 * Path is supplied through the sanitized child environment only — never argv.
 * Authentication cookies/tokens are never copied into the MESH helper.
 * A failed shared-home probe never falls back to the user's ~/.codex.
 */

import { mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { loadRuntimeManifest } from "./runtime-manifest.mjs";

const FORBIDDEN_CHILD_ENV = Object.freeze([
  "MESH_TOKEN",
  "MESH_BEARER",
  "MESH_API_KEY",
  "OPENAI_API_KEY", // not copied from parent; dedicated home owns auth
]);

const MESH_SECRET = /mesh_(?:watch_)?[A-Za-z0-9_-]{8,}/;

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export function defaultTriangleCodexHome({ home = process.env.HOME } = {}) {
  if (typeof home !== "string" || !home.startsWith("/")) {
    throw createCodedError("codex_home_invalid", "HOME must be an absolute path to resolve CODEX_HOME");
  }
  return path.join(
    home,
    "Library",
    "Application Support",
    "The Triangle",
    "model-state",
    "codex-runtime-home",
  );
}

export function resolveTriangleCodexHome({
  override = process.env.TRIANGLE_CODEX_HOME,
  home = process.env.HOME,
  allowCreate = false,
} = {}) {
  const candidate =
    typeof override === "string" && override.length > 0
      ? override
      : defaultTriangleCodexHome({ home });

  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.includes("\0")) {
    throw createCodedError("codex_home_invalid", "TRIANGLE_CODEX_HOME must be an absolute path");
  }
  if (MESH_SECRET.test(candidate)) {
    throw createCodedError("secret_leak_rejected", "CODEX_HOME path must not contain mesh_ credentials");
  }

  const userCodex = typeof home === "string" ? path.join(home, ".codex") : null;
  if (userCodex && pathsEqual(candidate, userCodex)) {
    throw createCodedError(
      "codex_home_user_fallback_forbidden",
      "dedicated Triangle CODEX_HOME must not resolve to ~/.codex",
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
        "codex_home_missing",
        "dedicated Triangle CODEX_HOME does not exist",
        { path: candidate, causeCode: error?.code ?? null },
      );
    }
  }

  if (userCodex && pathsEqual(resolved, userCodex)) {
    throw createCodedError(
      "codex_home_user_fallback_forbidden",
      "dedicated Triangle CODEX_HOME must not resolve to ~/.codex",
    );
  }

  try {
    const mode = statSync(resolved).mode & 0o777;
    if (mode !== 0o700 && process.platform !== "win32") {
      // Soft diagnostic only in Phase 0; Darwin helper store enforces 0700.
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
 * Build a minimal child environment. Never copies MESH credentials.
 * Never puts CODEX_HOME on argv — callers must use this env map.
 */
export function buildSanitizedCodexChildEnv({
  codexHome,
  parentEnv = process.env,
  extra = {},
} = {}) {
  const home = resolveTriangleCodexHome({
    override: codexHome,
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
    CODEX_HOME: home,
    ...extra,
  };

  for (const key of Object.keys(child)) {
    if (child[key] == null) delete child[key];
  }

  for (const forbidden of FORBIDDEN_CHILD_ENV) {
    delete child[forbidden];
  }

  for (const [key, value] of Object.entries(child)) {
    if (typeof value === "string" && MESH_SECRET.test(value)) {
      throw createCodedError(
        "secret_leak_rejected",
        `child env ${key} must not contain mesh_ credentials`,
      );
    }
  }

  // Defense in depth: never inherit mesh_ from parent even if someone adds keys.
  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value === "string" && MESH_SECRET.test(value) && key in child) {
      throw createCodedError(
        "secret_leak_rejected",
        `refusing to propagate secret-bearing env ${key}`,
      );
    }
  }

  return Object.freeze({ ...child });
}

/**
 * Pool / handoff guards driven by the shared-home concurrency probe status.
 * Until the probe passes, pool size is forced to 1 and desktop handoff is off.
 */
export function resolveCodexPoolGuards({
  preferredSize = 2,
  maxSize = 4,
  desktopHandoffRequested = false,
  probeStatus = loadRuntimeManifest().sharedHomeConcurrency?.status ?? "unproved",
  manifest = loadRuntimeManifest(),
} = {}) {
  const forced =
    probeStatus !== "passed" ||
    manifest.sharedHomeConcurrency?.status !== "passed";

  if (forced) {
    return Object.freeze({
      preferredSize: 1,
      maxSize: 1,
      desktopHandoffEnabled: false,
      forcedByProbe: true,
      probeStatus,
      reason: "shared_home_concurrency_unproved",
      userFallbackForbidden: true,
    });
  }

  const preferred = clampInt(preferredSize, 1, 4);
  const maximum = clampInt(maxSize, preferred, 4);
  return Object.freeze({
    preferredSize: preferred,
    maxSize: maximum,
    desktopHandoffEnabled: desktopHandoffRequested === true,
    forcedByProbe: false,
    probeStatus: "passed",
    reason: null,
    userFallbackForbidden: true,
  });
}

function clampInt(value, min, max) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("pool size must be a safe integer");
  }
  return Math.min(max, Math.max(min, value));
}
