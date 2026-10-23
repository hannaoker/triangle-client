import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readPrivateJson } from "./local-messaging-auth-broker.mjs";
import { createPerSenderRateLimiter } from "./local-messaging-rate-limiter.mjs";
import { coded } from "./local-messaging-errors.mjs";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HEX64_PATTERN = /^[a-f0-9]{64}$/;
const KNOWN_KEYS = new Set([
  "version",
  "type",
  "senderId",
  "sessionId",
  "generation",
  "bindingId",
  "secret",
  "enabled",
  "revoked",
]);

function equalSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateInteractiveIntegration(file) {
  const current = readPrivateJson(file);
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw coded("invalid_interactive_integration", "Invalid interactive integration file schema");
  }
  const keys = Object.keys(current);
  if (keys.length !== KNOWN_KEYS.size || keys.some((k) => !KNOWN_KEYS.has(k))) {
    throw coded("invalid_interactive_integration", "Invalid interactive integration file schema: unknown or missing keys");
  }
  if (
    current.version !== 1 ||
    current.type !== "interactive" ||
    typeof current.senderId !== "string" ||
    !HEX64_PATTERN.test(current.senderId) ||
    typeof current.secret !== "string" ||
    !HEX64_PATTERN.test(current.secret) ||
    typeof current.sessionId !== "string" ||
    !UUID_PATTERN.test(current.sessionId) ||
    !Number.isSafeInteger(current.generation) ||
    current.generation < 1 ||
    typeof current.bindingId !== "string" ||
    !UUID_PATTERN.test(current.bindingId) ||
    typeof current.enabled !== "boolean" ||
    typeof current.revoked !== "boolean"
  ) {
    throw coded("invalid_interactive_integration", "Invalid interactive integration file schema");
  }
  return current;
}

export function createInteractiveSessionBroker({
  integrationPath,
  recipients = [],
  issue,
}) {
  if (typeof integrationPath !== "string" || !path.isAbsolute(integrationPath)) {
    throw coded("invalid_broker_options", "integrationPath must be an absolute path");
  }
  if (!Array.isArray(recipients) || recipients.some((r) => typeof r !== "string")) {
    throw coded("invalid_broker_options", "recipients must be an array of strings");
  }
  if (typeof issue !== "function") {
    throw coded("invalid_broker_options", "issue function is required");
  }

  const integration = validateInteractiveIntegration(integrationPath);
  const failureLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 30, windowMs: 60000 });
  const successLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 120, windowMs: 60000 });

  function getCurrent() {
    return validateInteractiveIntegration(integrationPath);
  }

  function verifyTuple(request) {
    const current = getCurrent();
    if (current.enabled !== true) {
      throw coded("session_disabled", "Interactive session is disabled");
    }
    if (current.revoked !== false) {
      throw coded("session_revoked", "Interactive session is revoked");
    }
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      request.bindingId !== current.bindingId ||
      request.sessionId !== current.sessionId ||
      request.generation !== current.generation ||
      !equalSecret(request.secret, current.secret)
    ) {
      throw coded("unauthorized", "Invalid interactive integration credential");
    }
    if (current.senderId !== integration.senderId) {
      throw coded("binding_changed", "Interactive identity changed");
    }
    return current;
  }

  function validateRequest({ claims, senderId }) {
    const current = getCurrent();
    if (current.enabled !== true) {
      throw coded("session_disabled", "Interactive session is disabled");
    }
    if (current.revoked !== false) {
      throw coded("session_revoked", "Interactive session is revoked");
    }
    if (current.senderId !== integration.senderId) {
      throw coded("binding_changed", "Interactive identity changed");
    }
    if (senderId && senderId !== current.senderId) {
      throw coded("unauthorized", "Interactive sender mismatch");
    }
    if (!claims || typeof claims !== "object") {
      throw coded("unauthorized", "Interactive claims required");
    }
    if (claims.senderType !== "interactive") {
      throw coded("unauthorized", "Interactive senderType required");
    }
    if (claims.senderId !== current.senderId) {
      throw coded("unauthorized", "Interactive sender mismatch");
    }
    if (claims.sessionId !== current.sessionId) {
      throw coded("session_fenced", "Interactive session mismatch");
    }
    if (claims.generation !== current.generation) {
      throw coded("generation_fenced", "Interactive generation mismatch");
    }
    if (claims.bindingId !== current.bindingId) {
      throw coded("binding_changed", "Interactive binding mismatch");
    }
    return current;
  }

  function issueGrant(current) {
    const credential = issue(current.senderId, {
      turnId: randomUUID(),
      ttlMs: 300000,
      allowedRecipients: [...recipients],
      sessionId: current.sessionId,
      generation: current.generation,
      bindingId: current.bindingId,
      senderType: "interactive",
    });
    return {
      credential,
      senderId: current.senderId,
      sessionId: current.sessionId,
      generation: current.generation,
      bindingId: current.bindingId,
    };
  }

  return Object.freeze({
    senderId: integration.senderId,
    integrationPath,
    isInteractiveSender(id) {
      return id === integration.senderId;
    },
    verify: verifyTuple,
    validateRequest,
    exchange(request) {
      let current;
      try {
        current = verifyTuple(request);
      } catch (err) {
        failureLimiter.checkAndConsume("failed");
        throw err;
      }
      successLimiter.checkAndConsume("interactive");
      return issueGrant(current);
    },
  });
}
