import { AGENT_ID_PATTERN, isValidBareHttpsOrigin } from "./identity-primitives.mjs";
import { coded } from "./local-messaging-errors.mjs";

const ADDRESS = /^(?:session-)?[a-f0-9]{64}$/;
const SESSION = /^session-[a-f0-9]{64}$/;
const REQUEST = /^[A-Za-z0-9._:-]{1,256}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;

// This library is NOT a credential verifier. Only the receiving supervisor may
// supply these observations AFTER authenticating the caller and checking its
// active attachment and registry binding. Message metadata is never an input.
function observation(value, { interactive = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.address !== "string" || !(interactive ? SESSION : ADDRESS).test(value.address) || !positive(value.generation)) {
    throw coded("invalid_reply_identity", "Valid local address and generation required");
  }
  const principal = value.principal ?? null;
  const authorityOrigin = value.authorityOrigin ?? null;
  const bindingGeneration = value.bindingGeneration ?? null;
  if (principal === null) {
    if (authorityOrigin !== null || bindingGeneration !== null) {
      throw coded("invalid_reply_identity", "Unbound identities cannot claim principal authority");
    }
  } else if (typeof principal !== "string" || !AGENT_ID_PATTERN.test(principal) || !isValidBareHttpsOrigin(authorityOrigin) || !positive(bindingGeneration)) {
    throw coded("invalid_reply_identity", "Mapped principal requires origin and binding generation");
  }
  return Object.freeze({ address: value.address, generation: value.generation,
    principal, authorityOrigin, bindingGeneration });
}

function request(value) {
  if (typeof value !== "string" || !REQUEST.test(value)) {
    throw coded("invalid_reply_route", "A bounded request ID is required");
  }
  return value;
}

export function createLocalReplyRoute({ requestId, local, remote } = {}) {
  const id = request(requestId);
  const owner = observation(local, { interactive: true });
  const peer = observation(remote);
  // The host journal scopes this key. An unbound principal is not an identity:
  // retain the exact authenticated remote address, never use null as its key.
  return Object.freeze({ schema: "local_reply_route_v1", transport: "local-socket",
    key: JSON.stringify(["local-socket", peer.address, id]), requestId: id,
    local: owner, remote: peer });
}

function renew(pinned, current, code) {
  if (pinned.address !== current.address || pinned.principal !== current.principal ||
      pinned.authorityOrigin !== current.authorityOrigin) {
    throw coded(code, "Reply identity differs from the pinned identity");
  }
  if (current.generation < pinned.generation ||
      (pinned.bindingGeneration !== null && current.bindingGeneration < pinned.bindingGeneration)) {
    throw coded("reply_generation_regressed", "Reply binding generation regressed");
  }
}

export function verifyLocalReplyRoute(route, { local, remote } = {}) {
  if (route?.schema !== "local_reply_route_v1" || route.transport !== "local-socket") {
    throw coded("invalid_reply_route", "A local reply route is required");
  }
  const pinned = createLocalReplyRoute(route);
  if (route.key !== pinned.key) throw coded("invalid_reply_route", "Reply route key mismatch");
  const current = createLocalReplyRoute({ requestId: pinned.requestId, local, remote });
  renew(pinned.local, current.local, "reply_session_mismatch");
  renew(pinned.remote, current.remote, "reply_remote_mismatch");
  // The caller must persist this advance transactionally with reply admission.
  // Offline/missing current observations fail, never choose another live chat.
  return current;
}

export function createLocalSenderProvenance({ requestId, sender, recipient } = {}) {
  const from = observation(sender);
  const to = observation(recipient);
  return Object.freeze({ schema: "sender_provenance_v1", request_id: request(requestId),
    principal: from.principal, recipient_principal: to.principal,
    sender_binding_generation: from.generation, principal_binding_generation: from.bindingGeneration,
    via: Object.freeze({ transport: "local-socket", authenticated_peer: from.address }),
    assurance: Object.freeze({ kind: "local-attested", principal_binding: from.principal === null
      ? "unbound" : "owner-mapped-disk-observation" }),
    authority_origin: from.authorityOrigin });
}
