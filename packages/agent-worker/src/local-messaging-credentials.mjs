import crypto from "node:crypto";
import { coded } from "./local-messaging-errors.mjs";

function base64UrlEncode(str) {
  return Buffer.from(str, "utf8").toString("base64url");
}

function base64UrlDecode(str) {
  return Buffer.from(str, "base64url").toString("utf8");
}

function computeSignature(payloadStr, secret) {
  return crypto.createHmac("sha256", secret).update(payloadStr).digest("base64url");
}

const MIN_TTL_MS = 500; // 500 ms minimum
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours maximum
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes default
const MAX_LOOP_LIMIT = 100;

export function validateClaimsShape(claims) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    throw coded("malformed_claims", "Turn claims must be an object");
  }

  const {
    senderId,
    turnId,
    issuedAt,
    expiresAt,
    allowedRecipients,
    maxLoopDepth,
    conversationId,
    parentMessageId,
    loopDepth,
    sessionId,
    generation,
    bindingId,
    senderType,
  } = claims;

  if (typeof senderId !== "string" || !senderId.trim()) {
    throw coded("malformed_claims", "senderId must be a non-empty string");
  }

  if (typeof turnId !== "string" || !turnId.trim()) {
    throw coded("malformed_claims", "turnId must be a non-empty string");
  }

  if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt) || issuedAt <= 0) {
    throw coded("malformed_claims", "issuedAt must be a positive finite timestamp");
  }

  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw coded("malformed_claims", "expiresAt must be a finite timestamp after issuedAt");
  }

  const ttl = expiresAt - issuedAt;
  if (ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) {
    throw coded("malformed_claims", `TTL must be between ${MIN_TTL_MS}ms and ${MAX_TTL_MS}ms`);
  }

  if (allowedRecipients !== null && typeof allowedRecipients !== "undefined") {
    if (!Array.isArray(allowedRecipients) || allowedRecipients.some((r) => typeof r !== "string" || !r.trim())) {
      throw coded("malformed_claims", "allowedRecipients must be null or an array of non-empty strings");
    }
  }

  if (maxLoopDepth !== null && typeof maxLoopDepth !== "undefined") {
    if (!Number.isInteger(maxLoopDepth) || maxLoopDepth < 1 || maxLoopDepth > MAX_LOOP_LIMIT) {
      throw coded("malformed_claims", `maxLoopDepth must be an integer between 1 and ${MAX_LOOP_LIMIT}`);
    }
  }

  if (conversationId !== null && typeof conversationId !== "undefined") {
    if (typeof conversationId !== "string" || !conversationId.trim()) {
      throw coded("malformed_claims", "conversationId must be a non-empty string when provided");
    }
  }

  if (parentMessageId !== null && typeof parentMessageId !== "undefined") {
    if (typeof parentMessageId !== "string" || !parentMessageId.trim()) {
      throw coded("malformed_claims", "parentMessageId must be a non-empty string when provided");
    }
  }

  if (loopDepth !== null && typeof loopDepth !== "undefined") {
    if (!Number.isInteger(loopDepth) || loopDepth < 1 || loopDepth > MAX_LOOP_LIMIT) {
      throw coded("malformed_claims", `loopDepth must be an integer between 1 and ${MAX_LOOP_LIMIT}`);
    }
  }

  if (sessionId !== null && typeof sessionId !== "undefined") {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw coded("malformed_claims", "sessionId must be a non-empty string when provided");
    }
  }

  if (generation !== null && typeof generation !== "undefined") {
    if (!Number.isInteger(generation) || generation < 1) {
      throw coded("malformed_claims", "generation must be an integer >= 1 when provided");
    }
  }

  if (bindingId !== null && typeof bindingId !== "undefined") {
    if (typeof bindingId !== "string" || !bindingId.trim()) {
      throw coded("malformed_claims", "bindingId must be a non-empty string when provided");
    }
  }

  if (senderType !== null && typeof senderType !== "undefined") {
    if (typeof senderType !== "string" || !senderType.trim()) {
      throw coded("malformed_claims", "senderType must be a non-empty string when provided");
    }
  }

  return true;
}

export function createTurnCapabilityIssuer({
  secret = null,
  defaultTtlMs = DEFAULT_TTL_MS,
} = {}) {
  if (!secret || typeof secret !== "string" || secret.length < 16) {
    throw coded("invalid_issuer_options", "secret must be a private string of at least 16 bytes");
  }

  return {
    issue({
      senderId,
      turnId = crypto.randomUUID(),
      ttlMs = defaultTtlMs,
      allowedRecipients = null,
      maxLoopDepth = null,
      conversationId = null,
      parentMessageId = null,
      loopDepth = 1,
      sessionId = null,
      generation = null,
      bindingId = null,
      senderType = null,
    } = {}) {
      if (!senderId || typeof senderId !== "string" || !senderId.trim()) {
        throw coded("invalid_sender_id", "senderId must be a non-empty string");
      }

      const boundedTtl = Math.min(Math.max(Number(ttlMs) || defaultTtlMs, MIN_TTL_MS), MAX_TTL_MS);
      const now = Date.now();
      const expiresAt = now + boundedTtl;

      const claims = {
        senderId: senderId.trim(),
        turnId,
        issuedAt: now,
        expiresAt,
        allowedRecipients: Array.isArray(allowedRecipients)
          ? allowedRecipients.map((r) => r.trim()).filter(Boolean)
          : null,
        maxLoopDepth: maxLoopDepth ? Math.min(maxLoopDepth, MAX_LOOP_LIMIT) : null,
        conversationId: conversationId ? String(conversationId).trim() : null,
        parentMessageId: parentMessageId ? String(parentMessageId).trim() : null,
        loopDepth: Number.isInteger(loopDepth) && loopDepth >= 1 ? loopDepth : 1,
        sessionId: sessionId ? String(sessionId).trim() : null,
        generation: Number.isInteger(generation) && generation >= 1 ? generation : null,
        bindingId: bindingId ? String(bindingId).trim() : null,
        senderType: senderType ? String(senderType).trim() : null,
      };

      validateClaimsShape(claims);

      const payloadStr = JSON.stringify(claims);
      const payloadB64 = base64UrlEncode(payloadStr);
      const signature = computeSignature(payloadB64, secret);
      return `${payloadB64}.${signature}`;
    },
  };
}

export function createTurnCapabilityValidator({ secret }) {
  if (!secret || typeof secret !== "string" || secret.length < 16) {
    throw coded("invalid_validator_options", "secret must be a private string of at least 16 bytes");
  }

  return {
    validate({ credential, expectedSenderId = null } = {}) {
      if (!credential || typeof credential !== "string") {
        throw coded("unauthorized", "Missing or invalid turn credential");
      }

      const parts = credential.split(".");
      if (parts.length !== 2) {
        throw coded("unauthorized", "Malformed turn credential format");
      }

      const [payloadB64, signature] = parts;
      const expectedSig = computeSignature(payloadB64, secret);
      const sigBuf = Buffer.from(signature);
      const expectedBuf = Buffer.from(expectedSig);

      if (
        sigBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(sigBuf, expectedBuf)
      ) {
        throw coded("unauthorized", "Turn credential signature verification failed");
      }

      let claims;
      try {
        claims = JSON.parse(base64UrlDecode(payloadB64));
      } catch {
        throw coded("unauthorized", "Malformed turn credential payload");
      }

      validateClaimsShape(claims);

      if (Date.now() > claims.expiresAt) {
        throw coded("credential_expired", "Turn credential has expired");
      }

      if (expectedSenderId && claims.senderId !== expectedSenderId) {
        throw coded("unauthorized", "Turn credential sender mismatch");
      }

      return Object.freeze(claims);
    },
  };
}
