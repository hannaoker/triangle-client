import { createLocalReplyRoute, createLocalSenderProvenance, verifyLocalReplyRoute } from "./local-reply-route-contract.mjs";
import { coded } from "./local-messaging-errors.mjs";

const SESSION = /^session-[a-f0-9]{64}$/;

// Adapter over the real HMAC validator and live workspace-session broker.
// This is intentionally limited to attached chats: the current registry binds
// profiles, not discovered sessions. Never infer a chat principal from a label,
// caller-supplied principal field, or a same-harness profile.
export async function authenticateAttachedLocalSender({
  credential, expectedSenderId, credentialValidator, sessionBroker,
} = {}) {
  if (typeof credentialValidator?.validate !== "function" ||
      typeof sessionBroker?.validateRequest !== "function") {
    throw coded("invalid_sender_verifier", "Credential validator and live session broker required");
  }
  if (typeof expectedSenderId !== "string" || !SESSION.test(expectedSenderId)) {
    throw coded("unauthorized", "An attached local chat address is required");
  }
  const claims = credentialValidator.validate({ credential, expectedSenderId });
  if (claims.senderId !== expectedSenderId || claims.senderType !== "interactive" ||
      typeof claims.sessionId !== "string" || !claims.sessionId ||
      typeof claims.bindingId !== "string" || !claims.bindingId ||
      !Number.isSafeInteger(claims.generation) || claims.generation < 1) {
    throw coded("unauthorized", "Interactive session claims required");
  }
  // The broker rechecks owner policy, discovery, lease, child and generation.
  await sessionBroker.validateRequest({ claims, senderId: expectedSenderId });
  return Object.freeze({ address: expectedSenderId, generation: claims.generation,
    principal: null, authorityOrigin: null, bindingGeneration: null });
}

// Explicit opt-in seam for the server. Only attached-chat pairs are covered in
// this slice; profile workers and bound desktop identities retain legacy flow.
export function createAttachedReplyIdentity({ credentialValidator, sessionBroker, enabled = true } = {}) {
  if (typeof sessionBroker?.describeLocalSession !== "function") {
    throw coded("invalid_sender_verifier", "Live session observations required");
  }
  const authenticate = (credential, senderId) => authenticateAttachedLocalSender({
    credential, expectedSenderId: senderId, credentialValidator, sessionBroker,
  });
  return Object.freeze({
    async prepareSend({ credential, senderId, recipientId, requestId, existingRoute = null }) {
      // The switch controls new pins, not authentication of existing pinned retries.
      if (!existingRoute && !(typeof enabled === "function" ? enabled() : enabled)) return null;
      if (!SESSION.test(senderId) || !SESSION.test(recipientId)) return null;
      const remote = await authenticate(credential, senderId);
      const local = await sessionBroker.describeLocalSession(recipientId);
      if (existingRoute) verifyLocalReplyRoute(existingRoute, { local, remote });
      return { replyRoute: createLocalReplyRoute({ requestId, local, remote }),
        senderProvenance: createLocalSenderProvenance({ requestId, sender: remote, recipient: local }) };
    },
    async prepareReply({ credential, senderId, route }) {
      const local = await authenticate(credential, senderId);
      let remote;
      try { remote = await sessionBroker.describeLocalSession(route.remote.address); }
      catch (error) {
        // A reply may wait for its ORIGINAL offline chat; never reroute it.
        if (error.code !== "session_offline" || route.remote.principal !== null) throw error;
        remote = route.remote;
      }
      return { local, remote, senderProvenance: createLocalSenderProvenance({ requestId: route.requestId, sender: local, recipient: remote }) };
    },
  });
}
