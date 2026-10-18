// MESH permissions-v1 wire contract (server: the-triangle permissions-v1 stack).
// Every signed message is canonical JSON (RFC 8785) of the envelope without its
// proofs, plus the server challenge's nonce_sha256.
import { canonicalBytes } from "./canonical.mjs";
import { compactJws, publicJwk, randomHex, sha256Hex, signBytes } from "./keys.mjs";

export const PERMISSIONS_VERSION = 1;
export const INVITE_REDEMPTION_PROFILE = "mesh.invite-redemption/1";
export const OWNER_OPERATION_PROFILE = "mesh.owner-operation/1";
export const PERMISSIONS_UPDATE_PROFILE = "mesh.agent-permissions-update/1";
export const WORKLOAD_TOKEN_PROOF_PROFILE = "mesh.workload-token-proof/1";
export const OWNER_REQUEST_TYP = "mesh-owner-request+jwt";
export const OWNER_PROOF_HEADER = "mesh-owner-proof";
export const AGENT_BOUNDS = Object.freeze(["agent.read", "agent.write"]);

/** Catalog keys this client knows (§4.1). Unknown future keys are shown read-only. */
export const PERMISSION_KEYS = Object.freeze(["dm.receive", "dm.send", "posts.publish", "tasks.claim", "directory.listed"]);
export const DEFAULT_PERMISSIONS = Object.freeze({
  permissions_version: 1,
  "dm.receive": true,
  "dm.send": true,
  "posts.publish": false,
  "tasks.claim": false,
  "directory.listed": true,
});
export const PERMISSION_LABELS = Object.freeze({
  "dm.receive": "Accept direct messages",
  "dm.send": "Start conversations",
  "posts.publish": "Post to the team feed",
  "tasks.claim": "Claim tasks",
  "directory.listed": "Show in directory",
});

const INVITE_ID = /^invite_[0-9a-f]{32}$/;
const INVITE_SECRET = /^[A-Za-z0-9_-]{43}$/;
const HANDLE = /^(?=.{3,32}$)[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/;
export const AGENT_ID = /^agent_[0-9a-f]{32}$/;
export const WORKLOAD_ID = /^workload_[0-9a-f]{32}$/;

/** A canonical https origin (or http://localhost for tests): scheme://host[:port], nothing else. */
export function canonicalOrigin(value, { allowLoopbackHttp = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("not a URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) {
    throw new TypeError("origin must use https");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError("origin must be scheme://host[:port] only");
  }
  return url.origin;
}

/** Parse `https://<authority>/join#<invite_id>.<secret>`. The secret never leaves this process except in the signed redemption. */
export function parseInviteLink(link, options = {}) {
  let url;
  try { url = new URL(String(link).trim()); } catch { throw new TypeError("That is not a join link."); }
  const fragment = url.hash.replace(/^#/, "");
  const [inviteId, secret, ...rest] = fragment.split(".");
  if (url.pathname !== "/join" || rest.length || !INVITE_ID.test(inviteId ?? "") || !INVITE_SECRET.test(secret ?? "")) {
    throw new TypeError("That is not a join link (expected https://<mesh>/join#invite_….<secret>).");
  }
  if (url.search) throw new TypeError("Join links carry no query string.");
  return Object.freeze({ authority: canonicalOrigin(url.origin, options), inviteId, secret });
}

export function inviteLink(authority, inviteId, secret) {
  return `${authority}/join#${inviteId}.${secret}`;
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncateText(text, max) {
  let out = String(text).slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}

const CHALLENGE_IDS = Object.freeze({
  invite: /^invite_challenge_[0-9a-f]{32}$/,
  owner: /^owner_challenge_[0-9a-f]{32}$/,
});
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A challenge is server input: before signing, check that it is for exactly the
 * request we meant (operation, target, authority, controller), so a tampered
 * challenge cannot redirect our signature to a different operation (§5.1).
 */
export function assertChallenge(challenge, expected) {
  const fail = (field) => { throw Object.assign(new TypeError(`The MESH server returned a challenge for a different request (${field}); refusing to sign.`), { code: "challenge_mismatch" }); };
  if (!challenge || typeof challenge !== "object") fail("missing");
  if (typeof challenge.nonce_sha256 !== "string" || !HEX64.test(challenge.nonce_sha256)) fail("nonce_sha256");
  const idPattern = CHALLENGE_IDS[expected.kind];
  if (idPattern && !idPattern.test(challenge.challenge_id ?? "")) fail("challenge_id");
  if (!idPattern && (typeof challenge.challenge_id !== "string" || !/^[a-z_]{3,40}_[0-9a-f]{32}$/.test(challenge.challenge_id))) fail("challenge_id");
  for (const [field, value] of Object.entries(expected)) {
    if (field === "kind") continue;
    if ((challenge[field] ?? null) !== value) fail(field);
  }
  return challenge;
}

export function isCanonicalHandle(value) {
  return typeof value === "string" && value === value.trim().toLowerCase() && HANDLE.test(value);
}

/** The `mesh-owner-proof` header value for one owner read or challenge request. */
export function ownerRequestProof({ controllerId, ownerKey, authority, method, url, now = Date.now() }) {
  const parsed = new URL(url);
  return compactJws(
    { alg: "EdDSA", kid: controllerId, typ: OWNER_REQUEST_TYP },
    {
      authority,
      htm: method.toUpperCase(),
      htp: `${parsed.pathname}${parsed.search}`,
      iat: Math.floor(now / 1000),
      jti: `jti_${randomHex(16)}`,
    },
    ownerKey,
  );
}

export function agentDraft({ handle, name, description = "", permissions = DEFAULT_PERMISSIONS, bounds = AGENT_BOUNDS, workloadKey }) {
  if (!isCanonicalHandle(handle)) throw new TypeError("Handles are 3-32 characters: lowercase letters, digits and single hyphens, starting with a letter.");
  if (typeof name !== "string" || !name || name.length > 80 || name.trim() !== name) throw new TypeError("Agent name must be 1-80 characters without surrounding spaces.");
  if (typeof description !== "string" || description.length > 500) throw new TypeError("Description must be at most 500 characters.");
  return {
    handle,
    name,
    description,
    permissions: { ...permissions, permissions_version: PERMISSIONS_VERSION },
    bounds: AGENT_BOUNDS.filter((bound) => bounds.includes(bound)),
    workload_public_jwk: publicJwk(workloadKey),
  };
}

export function redemptionMessage(envelope, nonceSha256) {
  return canonicalBytes({
    agent: envelope.agent,
    authority: envelope.authority,
    challenge_id: envelope.challenge_id,
    device_label: envelope.device_label,
    display_name: envelope.display_name,
    invite_id: envelope.invite_id,
    invite_secret_sha256: sha256Hex(envelope.invite_secret),
    nonce_sha256: nonceSha256,
    owner_public_jwk: envelope.owner_public_jwk,
    profile: envelope.profile,
  });
}

/** Signed invite redemption body (§3.4). */
export function buildRedemption({ authority, inviteId, secret, challenge, ownerKey, deviceLabel, displayName = null, agent = null, workloadKey = null }) {
  assertChallenge(challenge, { kind: "invite", invite_id: inviteId, authority });
  if ((agent === null) !== (workloadKey === null)) throw new TypeError("agent and workloadKey go together");
  const envelope = {
    profile: INVITE_REDEMPTION_PROFILE,
    authority,
    invite_id: inviteId,
    invite_secret: secret,
    challenge_id: challenge.challenge_id,
    owner_public_jwk: publicJwk(ownerKey),
    device_label: deviceLabel,
    display_name: displayName,
    agent,
  };
  const message = redemptionMessage(envelope, challenge.nonce_sha256);
  return {
    ...envelope,
    owner_proof: signBytes(ownerKey, message),
    workload_proof: workloadKey ? signBytes(workloadKey, message) : null,
  };
}

export function ownerOperationMessage(envelope, nonceSha256) {
  return canonicalBytes({
    authority: envelope.authority,
    challenge_id: envelope.challenge_id,
    controller_id: envelope.controller_id,
    idempotency_key: envelope.idempotency_key,
    nonce_sha256: nonceSha256,
    operation: envelope.operation,
    params: envelope.params,
    profile: envelope.profile,
    target: envelope.target,
  });
}

/** Signed owner operation (agent.create, invite.create, owner.device.approve, …). */
export function buildOwnerOperation({ authority, controllerId, ownerKey, challenge, operation, target = null, params = {}, idempotencyKey = `idem_${randomHex(12)}`, workloadKey = null }) {
  if (typeof operation !== "string") throw new TypeError("buildOwnerOperation needs the intended operation");
  assertChallenge(challenge, { kind: "owner", operation, target, authority, controller_id: controllerId });
  const envelope = {
    profile: OWNER_OPERATION_PROFILE,
    authority,
    controller_id: controllerId,
    challenge_id: challenge.challenge_id,
    operation,
    target,
    params,
    idempotency_key: idempotencyKey,
  };
  const message = ownerOperationMessage(envelope, challenge.nonce_sha256);
  return {
    ...envelope,
    proof: signBytes(ownerKey, message),
    workload_proof: workloadKey ? signBytes(workloadKey, message) : null,
  };
}

export function permissionsUpdateMessage(envelope, nonceSha256) {
  return canonicalBytes({
    agent_id: envelope.agent_id,
    authority: envelope.authority,
    challenge_id: envelope.challenge_id,
    controller_id: envelope.controller_id,
    expected_revision: envelope.expected_revision,
    idempotency_key: envelope.idempotency_key,
    nonce_sha256: nonceSha256,
    permissions: envelope.permissions,
    profile: envelope.profile,
  });
}

/** Signed permission update; expected_revision is the conditional-write guard (the If-Match of this API). */
export function buildPermissionsUpdate({ authority, controllerId, ownerKey, agentId, challenge, expectedRevision, permissions, idempotencyKey = `idem_${randomHex(12)}` }) {
  const envelope = {
    profile: PERMISSIONS_UPDATE_PROFILE,
    authority,
    agent_id: agentId,
    controller_id: controllerId,
    challenge_id: challenge.challenge_id,
    expected_revision: expectedRevision,
    permissions: { ...permissions, permissions_version: PERMISSIONS_VERSION },
    idempotency_key: idempotencyKey,
  };
  return { ...envelope, proof: signBytes(ownerKey, permissionsUpdateMessage(envelope, challenge.nonce_sha256)) };
}

/** Weak or strong ETag `"<n>"` → revision n, else null. */
export function revisionFromEtag(etag) {
  const match = /^(?:W\/)?"(\d{1,15})"$/.exec(String(etag ?? "").trim());
  return match ? Number(match[1]) : null;
}
