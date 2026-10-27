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
