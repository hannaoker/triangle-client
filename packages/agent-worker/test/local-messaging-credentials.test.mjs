import test from "node:test";
import assert from "node:assert/strict";
import {
  createTurnCapabilityIssuer,
  createTurnCapabilityValidator,
} from "../src/local-messaging-credentials.mjs";
import { LocalMessagingError } from "../src/local-messaging-errors.mjs";

test("issues and validates a valid turn capability credential with claims", () => {
  const secret = "test-secret-32-bytes-long-key-for-test!!";
  const issuer = createTurnCapabilityIssuer({ secret, defaultTtlMs: 60000 });
  const validator = createTurnCapabilityValidator({ secret });

  const token = issuer.issue({
    senderId: "agent-alice",
    turnId: "turn-123",
    allowedRecipients: ["agent-bob"],
    maxLoopDepth: 5,
    conversationId: "conv-001",
    parentMessageId: "msg-parent",
    loopDepth: 2,
  });

  assert.ok(typeof token === "string" && token.length > 0);

  const claims = validator.validate({
    credential: token,
    expectedSenderId: "agent-alice",
  });

  assert.equal(claims.senderId, "agent-alice");
  assert.equal(claims.turnId, "turn-123");
  assert.deepEqual(claims.allowedRecipients, ["agent-bob"]);
  assert.equal(claims.maxLoopDepth, 5);
  assert.equal(claims.conversationId, "conv-001");
  assert.equal(claims.parentMessageId, "msg-parent");
  assert.equal(claims.loopDepth, 2);
  assert.ok(claims.expiresAt > Date.now());
});

test("rejects expired credentials", () => {
  const secret = "test-secret-32-bytes-long-key-for-test!!";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });

  // Issue with tiny TTL and wait for expiration
  const token = issuer.issue({
    senderId: "agent-alice",
    turnId: "turn-expired",
    ttlMs: 500, // min valid TTL
  });

  // Artificially wait for expiration
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        assert.throws(
          () => validator.validate({ credential: token, expectedSenderId: "agent-alice" }),
          (err) => err instanceof LocalMessagingError && err.code === "credential_expired",
        );
        resolve();
      } catch (e) {
        reject(e);
      }
    }, 550);
  });
});

test("rejects mismatched sender (caller spoofing different sender)", () => {
  const secret = "test-secret-32-bytes-long-key-for-test!!";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });

  const token = issuer.issue({
    senderId: "agent-alice",
    turnId: "turn-alice",
  });

  // Expected sender is bob, but token is for alice
  assert.throws(
    () => validator.validate({ credential: token, expectedSenderId: "agent-bob" }),
    (err) => err instanceof LocalMessagingError && err.code === "unauthorized",
  );
});

test("rejects malformed or tampered credentials", () => {
  const secret = "test-secret-32-bytes-long-key-for-test!!";
  const validator = createTurnCapabilityValidator({ secret });

  assert.throws(
    () => validator.validate({ credential: "bad.token.format", expectedSenderId: "agent-alice" }),
    (err) => err instanceof LocalMessagingError && err.code === "unauthorized",
  );

  assert.throws(
    () => validator.validate({ credential: "", expectedSenderId: "agent-alice" }),
    (err) => err instanceof LocalMessagingError && err.code === "unauthorized",
  );
});

test("enforces claims shape and bounded finite validation", () => {
  const secret = "test-secret-32-bytes-long-key-for-test!!";
  const issuer = createTurnCapabilityIssuer({ secret });

  // Empty senderId
  assert.throws(
    () => issuer.issue({ senderId: "" }),
    (err) => err instanceof LocalMessagingError && err.code === "invalid_sender_id",
  );

  // Insufficient secret length
  assert.throws(
    () => createTurnCapabilityIssuer({ secret: "short" }),
    (err) => err instanceof LocalMessagingError && err.code === "invalid_issuer_options",
  );
  assert.throws(
    () => createTurnCapabilityValidator({ secret: "short" }),
    (err) => err instanceof LocalMessagingError && err.code === "invalid_validator_options",
  );
});
