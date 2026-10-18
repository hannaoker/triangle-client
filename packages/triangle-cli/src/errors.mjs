// Structured MESH errors and the user-facing wording for each (§1.4).
import { PERMISSION_LABELS } from "./protocol.mjs";

export class MeshApiError extends Error {
  constructor({ status, code = null, permission = null, serverMessage = null, path = null }) {
    super(describeMeshError({ status, code, permission, serverMessage }));
    this.name = "MeshApiError";
    this.status = status;
    this.code = code;
    this.permission = permission;
    this.path = path;
  }

  toJSON() {
    return { error: this.code ?? `http_${this.status}`, status: this.status, permission: this.permission ?? undefined, message: this.message };
  }
}

/** The request may or may not have committed: resume by replaying the stored request, never by re-signing new keys. */
export class OutcomeUnknownError extends Error {
  constructor(message, { cause, resumeHint } = {}) {
    super(message, { cause });
    this.name = "OutcomeUnknownError";
    this.resumeHint = resumeHint ?? null;
  }
}

export class LocalStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalStateError";
  }
}

const MESSAGES = {
  agent_auth_required: "This agent's MESH credential was refused. Check `triangle doctor`; the workload key may be revoked or expired.",
  owner_auth_required: "This device's owner key was refused. It may have been revoked, or it is still waiting for approval.",
  agent_paused: "This agent is paused by its owner. Resume it with `triangle agent resume`.",
  peer_token_invalid: "The peer ticket is invalid or no longer active.",
  revision_conflict: "Someone changed these permissions first. Showing the latest; re-apply your change if you still want it.",
  invite_invalid: "This join link is invalid, expired, revoked or already used.",
  invite_already_redeemed: "This join link was already used by a different device.",
  handle_unavailable: "That handle is already taken. Pick another with --handle.",
  workload_key_in_use: "That workload key is already registered.",
  idempotency_conflict: "A different request already used this idempotency key.",
  last_controller: "This is the owner's last active device; add another device before revoking it.",
  not_found: "The MESH server does not serve that route.",
  rate_limited: "Too many requests. Wait a moment and try again.",
};

export function describeMeshError({ status, code, permission, serverMessage }) {
  if (code === "permission_denied") {
    const label = PERMISSION_LABELS[permission];
    return label
      ? `Not allowed: "${label}" (${permission}) is off for this agent. Its owner can turn it on with \`triangle permissions set <agent> ${permission}=on\`.`
      : `Not allowed by the agent's permissions${permission ? ` (${permission})` : ""}.`;
  }
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (serverMessage) return `${serverMessage}${code ? ` (${code})` : ""}`;
  return `MESH request failed with HTTP ${status}${code ? ` (${code})` : ""}.`;
}
