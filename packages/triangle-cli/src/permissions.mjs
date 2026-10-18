// Per-agent permission toggles (§4, §5.2, §6.6). Reads are conditional
// (ETag / If-None-Match against a private cache); writes are owner-signed and
// carry `expected_revision`, which is this API's If-Match: the server refuses a
// write made against a stale revision with 409 `revision_conflict`.
import { MeshApiError, LocalStateError } from "./errors.mjs";
import { buildPermissionsUpdate, PERMISSION_KEYS, PERMISSION_LABELS, revisionFromEtag } from "./protocol.mjs";

const ON = new Set(["on", "true", "yes", "1", "allow"]);
const OFF = new Set(["off", "false", "no", "0", "deny"]);

/** `dm.send=off posts.publish=on` → { "dm.send": false, "posts.publish": true }. */
export function parseChanges(args) {
  if (!args.length) throw new TypeError("Name at least one change, e.g. posts.publish=on.");
  const changes = {};
  for (const arg of args) {
    const match = /^([a-z][a-z0-9_.-]*)=([A-Za-z0-9]+)$/.exec(arg);
    if (!match) throw new TypeError(`Expected key=on|off, got ${arg}.`);
    const [, key, raw] = match;
    const value = raw.toLowerCase();
    if (!ON.has(value) && !OFF.has(value)) throw new TypeError(`${key}: use on or off.`);
    if (Object.hasOwn(changes, key)) throw new TypeError(`${key} given twice.`);
    changes[key] = ON.has(value);
  }
  return changes;
}

/** Split a server view into the toggles this client understands and the ones it shows read-only. */
export function describePermissions(view) {
  const entries = Object.entries(view.permissions ?? {}).filter(([key]) => key !== "permissions_version");
  return {
    known: PERMISSION_KEYS.filter((key) => Object.hasOwn(view.permissions ?? {}, key)).map((key) => ({ key, label: PERMISSION_LABELS[key], value: view.permissions[key] })),
    unknown: entries.filter(([key]) => !PERMISSION_KEYS.includes(key)).map(([key, value]) => ({ key, value, read_only: true })),
  };
}

function assertView(agentId, view, etag) {
  if (!view || view.agent_id !== agentId || !Number.isSafeInteger(view.revision) || typeof view.permissions !== "object" || view.permissions === null) {
    throw new LocalStateError("The MESH server returned an unexpected permissions document.");
  }
  const tagged = revisionFromEtag(etag);
  if (tagged !== null && tagged !== view.revision) throw new LocalStateError("The permissions ETag does not match the document revision.");
  return view;
}

/**
 * Current permissions. Sends If-None-Match with the cached ETag; a 304 reuses
 * the cached view. `fresh: true` skips the cache (used right before a write).
 */
export async function readPermissions(session, agentId, { fresh = false } = {}) {
  const cached = fresh ? null : session.custody.readCache("permissions", agentId);
  const headers = cached?.etag ? { "if-none-match": cached.etag } : {};
  const response = await session.ownerRequest("GET", `/api/v1/agents/${agentId}/permissions`, { headers });
  if (response.status === 304) {
    if (!cached) throw new LocalStateError("The MESH server answered 304 without a cached copy.");
    // Weak comparison (RFC 9110 §8.8.3.2): proxies may drop the W/ prefix on a 304.
    if (response.etag && revisionFromEtag(response.etag) !== revisionFromEtag(cached.etag)) throw new LocalStateError("The 304 ETag does not match the cached copy.");
    return { ...cached.view, from_cache: true };
  }
  const view = assertView(agentId, response.body, response.etag);
  session.custody.writeCache("permissions", agentId, { etag: response.etag ?? `W/"${view.revision}"`, view });
  return { ...view, from_cache: false };
}

export class RevisionConflictError extends MeshApiError {
  /** `latest` is null when the re-read itself failed (`refreshError` says why). */
  constructor(latest, changes, { refreshError = null } = {}) {
    super({ status: 409, code: "revision_conflict" });
    this.latest = latest;
    this.changes = changes;
    this.refreshError = refreshError;
  }

  toJSON() {
    return { ...super.toJSON(), latest: this.latest, requested: this.changes, ...(this.refreshError ? { refresh_error: this.refreshError } : {}) };
  }
}

function applies(view, changes) {
  return Object.entries(changes).every(([key, value]) => view.permissions[key] === value);
}

/**
 * Sign and send a full permission object: the server's current object with
 * only `changes` applied. Keys this client does not know are kept exactly as
 * the server has them and cannot be changed here. On `revision_conflict` the
 * latest state is re-read and a RevisionConflictError (exit 4) carries it, even
 * when it happens to match the request: the precondition failed and scripts
 * must see that (we never silently re-apply over someone else's change).
 */
export async function setPermissions(session, agentId, changes) {
  for (const key of Object.keys(changes)) {
    if (!PERMISSION_KEYS.includes(key)) throw new TypeError(`${key} is not a permission this version of triangle can change (known: ${PERMISSION_KEYS.join(", ")}).`);
  }
  return session.custody.withLock(async () => {
    const current = await readPermissions(session, agentId, { fresh: true });
    for (const key of Object.keys(changes)) {
      if (!Object.hasOwn(current.permissions, key)) throw new TypeError(`${key} is not in this MESH's permission catalog.`);
    }
    if (applies(current, changes)) return { outcome: "unchanged", ...stripLocal(current) };
    const { body: challenge } = await session.ownerRequest("POST", `/api/v1/agents/${agentId}/permissions/challenges`, { mutating: false });
    const { from_cache, ...base } = current;
    const permissions = { ...base.permissions, ...changes };
    const body = buildPermissionsUpdate({
      authority: session.transport.authority,
      controllerId: session.owner.controller_id,
      ownerKey: session.owner.key,
      agentId,
      challenge,
      expectedRevision: base.revision,
      permissions,
    });
    const name = `perm-${body.idempotency_key}`;
    const entry = { kind: "permissions-update", agent_id: agentId, path: `/api/v1/agents/${agentId}/permissions`, body, changes, created_at: new Date().toISOString() };
    session.custody.writeJournal(name, entry);
    try {
      const response = await session.sendJournaled(name, entry, { original: true });
      const { receipt, ...view } = response.body;
      return view;
    } catch (error) {
      if (!(error instanceof MeshApiError) || error.code !== "revision_conflict") throw error;
      // The conflict is confirmed; a failed re-read must not turn it into a generic failure.
      const { latest, refreshError } = await rereadAfterConflict(session, agentId);
      throw new RevisionConflictError(latest, changes, { refreshError });
    }
  });
}

/** Re-read after a confirmed conflict; reports a read failure instead of throwing it. */
export async function rereadAfterConflict(session, agentId) {
  try {
    return { latest: stripLocal(await readPermissions(session, agentId, { fresh: true })), refreshError: null };
  } catch (error) {
    return { latest: null, refreshError: error?.message ?? String(error) };
  }
}

function stripLocal(view) {
  const { from_cache, ...rest } = view;
  return rest;
}

export async function permissionHistory(session, agentId, { limit } = {}) {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) throw new TypeError("--limit must be 1-200.");
  const query = limit ? `?limit=${limit}` : "";
  const { body } = await session.ownerRequest("GET", `/api/v1/agents/${agentId}/permissions/history${query}`);
  return body;
}

export function renderPermissions(handle, view) {
  const { known, unknown } = describePermissions(view);
  const lines = [`${handle} · revision ${view.revision}${view.agent_state && view.agent_state !== "active" ? ` · ${view.agent_state}` : ""}${view.outcome === "unchanged" ? " · no change needed" : ""}`];
  for (const item of known) lines.push(`  [${item.value ? "on " : "off"}] ${item.label.padEnd(24)} ${item.key}`);
  for (const item of unknown) lines.push(`  [${item.value === true ? "on " : item.value === false ? "off" : " ? "}] ${item.key} (read-only: newer than this triangle)`);
  if (view.updated_by?.device_label) lines.push(`  last changed from ${view.updated_by.device_label}${view.updated_at ? ` at ${view.updated_at}` : ""}`);
  return lines.join("\n");
}

export function renderHistory(handle, history) {
  if (!history.entries?.length) return `${handle}: no permission changes yet.`;
  return history.entries.map((entry) => {
    const changed = Object.keys(entry.next ?? {}).filter((key) => key !== "permissions_version" && entry.previous && entry.previous[key] !== entry.next[key]);
    const what = entry.previous ? (changed.map((key) => `${key} ${entry.next[key] ? "on" : "off"}`).join(", ") || "no change") : "created";
    return `rev ${entry.revision}  ${entry.created_at ?? ""}  ${what}${entry.device_label ? `  (from ${entry.device_label})` : ""}`;
  }).join("\n");
}
