/**
 * Fail-closed secret detection for console surfaces.
 * Never display or log permanent mailbox tokens or watch grant secrets.
 */

const SECRET_PATTERNS = [
  // Check watch secrets before mailbox tokens (`mesh_watch_` also matches a naive `mesh_`).
  { name: "mesh_watch_secret", re: /\bmesh_watch_[A-Za-z0-9_-]{8,}\b/ },
  { name: "mesh_token", re: /\bmesh_(?!watch_)[A-Za-z0-9_-]{16,}\b/ },
];

/**
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, kind: string, excerpt: string }}
 */
export function findSecretLeak(value) {
  const text = stringifyForScan(value);
  for (const { name, re } of SECRET_PATTERNS) {
    const match = text.match(re);
    if (match) {
      return { ok: false, kind: name, excerpt: redactMatch(match[0]) };
    }
  }
  return { ok: true };
}

/**
 * @param {unknown} value
 * @throws {Error} when a secret-shaped string is present
 */
export function assertSecretFree(value, context = "output") {
  const result = findSecretLeak(value);
  if (!result.ok) {
    const error = new Error(
      `Refusing to surface ${context}: detected ${result.kind} (${result.excerpt})`,
    );
    error.code = "secret_leak";
    error.kind = result.kind;
    throw error;
  }
  return value;
}

/**
 * Allowed operator-status keys for profile status JSON from the helper.
 * Anything outside this set is dropped before display.
 */
export const PROFILE_STATUS_ALLOWED_KEYS = Object.freeze([
  "profile",
  "origin",
  "agentId",
  "handle",
  "lifecycle",
  "verificationTimestamp",
  "operatorAction",
]);

/**
 * Allowed keys for watch-status JSON from the helper.
 */
export const WATCH_STATUS_ALLOWED_KEYS = Object.freeze([
  "installationId",
  "origin",
  "grantId",
  "agentIds",
  "state",
  "audience",
  "purpose",
  "memberCount",
  "listenerReady",
  "operatorAction",
]);

/**
 * Allowed keys for triangle-client agent list/status summaries.
 */
export const AGENT_SUMMARY_ALLOWED_KEYS = Object.freeze([
  "profile",
  "instanceId",
  "runtimeAdapter",
  "enabled",
  "deliveryMode",
]);

/**
 * @param {Record<string, unknown>} object
 * @param {readonly string[]} allowedKeys
 */
export function pickAllowedKeys(object, allowedKeys) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new TypeError("expected a plain object");
  }
  const out = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
      out[key] = object[key];
    }
  }
  assertSecretFree(out, "filtered status object");
  return out;
}

function stringifyForScan(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactMatch(value) {
  if (value.length <= 12) return "***";
  return `${value.slice(0, 8)}…***`;
}
