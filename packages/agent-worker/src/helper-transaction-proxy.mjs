/**
 * Node boundary for Slice 6 trusted transaction proxy via signed helper CLI.
 *
 * Production Hermes / coordinator-delivery claim/reply/ack must call:
 *   triangle-mailbox transaction-claim|reply|ack|…
 * rather than inventing claim/reply IDs in Node.
 *
 * Environments without the helper keep the fail-closed stub.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const PROTOCOLS = new Set(["self-serve-drain", "coordinator-delivery-v1"]);

function createCodedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertHelperPath(helperPath) {
  if (typeof helperPath !== "string" || helperPath.length === 0 || !helperPath.startsWith("/") || helperPath.includes("\0")) {
    throw new TypeError("helperPath is invalid");
  }
  return helperPath;
}

function assertProfile(profile) {
  if (typeof profile !== "string" || profile.length === 0 || profile.includes("\0") || profile.includes("/")) {
    throw new TypeError("profile is invalid");
  }
  return profile;
}

function assertProtocol(protocol) {
  if (!PROTOCOLS.has(protocol)) {
    throw new TypeError("protocol is invalid");
  }
  return protocol;
}

/**
 * Pure ID derivation mirrored from Swift `MailboxTransactionIdentifier`.
 * Used by Linux unit tests; production IDs still come from the helper.
 */
export function deriveTrustedClaimId(instanceId, deliveryId) {
  if (typeof instanceId !== "string" || !/^[a-f0-9]{64}$/.test(instanceId)) {
    throw new TypeError("instanceId is invalid");
  }
  if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) {
    throw new TypeError("deliveryId is invalid");
  }
  const framed = Buffer.concat([
    Buffer.from("triangle-claim-v1"),
    Buffer.from([0]),
    Buffer.from(instanceId),
    Buffer.from([0]),
    Buffer.from(String(deliveryId)),
  ]);
  return `claim_${createHash("sha256").update(framed).digest("hex").slice(0, 32)}`;
}

export function deriveTrustedReplyIdempotencyKey(instanceId, deliveryId) {
  if (typeof instanceId !== "string" || !/^[a-f0-9]{64}$/.test(instanceId)) {
    throw new TypeError("instanceId is invalid");
  }
  if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) {
    throw new TypeError("deliveryId is invalid");
  }
  const framed = Buffer.concat([
    Buffer.from("triangle-reply-v1"),
    Buffer.from([0]),
    Buffer.from(instanceId),
    Buffer.from([0]),
    Buffer.from(String(deliveryId)),
  ]);
  return `reply_${createHash("sha256").update(framed).digest("hex").slice(0, 32)}`;
}

export async function runHelper(
  helperPath,
  args,
  { timeoutMs = 60_000, signal, stdin } = {},
) {
  return await new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(createCodedError("helper_unavailable", "transaction helper timed out"));
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 256 * 1024) {
        child.kill("SIGKILL");
        finish(createCodedError("helper_unavailable", "transaction helper stdout exceeded limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) {
        child.kill("SIGKILL");
        finish(createCodedError("helper_unavailable", "transaction helper stderr exceeded limit"));
      }
    });
    child.on("error", () => finish(createCodedError("helper_unavailable", "transaction helper failed to start")));
    child.on("close", (code) => {
      finish(null, { stdout, stderr, code: code ?? null });
    });
    if (signal) {
      const onAbort = () => {
        child.kill("SIGKILL");
        const error = new Error("aborted");
        error.name = "AbortError";
        finish(error);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (stdin != null) {
      child.stdin.end(typeof stdin === "string" ? stdin : Buffer.from(stdin));
    } else {
      child.stdin.end();
    }
  });
}

function parseJsonStdout(result, fallbackCode = "helper_unavailable") {
  if (result.code === 4) {
    throw createCodedError("transaction_stuck", "transaction is stuck");
  }
  if (result.code === 5) {
    throw createCodedError("unverified_reply_conflict", "reply conflict was not verified");
  }
  if (result.code !== 0) {
    throw createCodedError(fallbackCode, "transaction helper failed");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw createCodedError(fallbackCode, "transaction helper returned unreadable JSON");
  }
}

/**
 * @param {object} options
 * @param {string} options.helperPath
 * @param {string} options.profile
 * @param {"self-serve-drain"|"coordinator-delivery-v1"} options.protocol
 * @param {(file: string, args: string[], options?: object) => Promise<{stdout: string, stderr: string, code: number|null}>} [options.run]
 */
export function createHelperTrustedTransactionProxy({
  helperPath,
  profile,
  protocol,
  run = runHelper,
  timeoutMs = 60_000,
} = {}) {
  assertHelperPath(helperPath);
  assertProfile(profile);
  assertProtocol(protocol);

  async function invoke(args, { stdin, signal } = {}) {
    const result = await run(helperPath, args, { timeoutMs, signal, stdin });
    return parseJsonStdout(result);
  }

  return Object.freeze({
    name: "slice6_helper_trusted_transaction_proxy",
    protocol,
    profile,
    helperPath,

    async preflight({ candidates = [], signal } = {}) {
      return invoke(
        ["transaction-preflight", "--profile", profile, "--protocol", protocol],
        { stdin: JSON.stringify({ candidates }), signal },
      );
    },

    async status({ signal } = {}) {
      return invoke(
        ["transaction-status", "--profile", profile, "--protocol", protocol],
        { signal },
      );
    },

    async claim({ deliveryId, roomId, eventId, signal } = {}) {
      if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) {
        throw new TypeError("deliveryId is invalid");
      }
      if (typeof roomId !== "string" || !/^room_[a-f0-9]{32}$/.test(roomId)) {
        throw new TypeError("roomId is invalid");
      }
      if (typeof eventId !== "string" || !/^event_[a-f0-9]{32}$/.test(eventId)) {
        throw new TypeError("eventId is invalid");
      }
      return invoke(
        [
          "transaction-claim",
          "--profile",
          profile,
          "--protocol",
          protocol,
          "--delivery-id",
          String(deliveryId),
          "--room-id",
          roomId,
          "--event-id",
          eventId,
        ],
        { signal },
      );
    },

    async reply({ roomId, text, inReplyToEventId = null, signal } = {}) {
      if (typeof roomId !== "string" || !/^room_[a-f0-9]{32}$/.test(roomId)) {
        throw new TypeError("roomId is invalid");
      }
      if (typeof text !== "string" || text.length === 0 || Buffer.byteLength(text) > 32 * 1024) {
        throw new TypeError("text is invalid");
      }
      const body = { roomId, text };
      if (inReplyToEventId != null) body.inReplyToEventId = inReplyToEventId;
      return invoke(
        ["transaction-reply", "--profile", profile, "--protocol", protocol],
        { stdin: JSON.stringify(body), signal },
      );
    },

    async ack({ signal } = {}) {
      return invoke(
        ["transaction-ack", "--profile", profile, "--protocol", protocol],
        { signal },
      );
    },

    async abandon({ signal } = {}) {
      return invoke(
        ["transaction-abandon", "--profile", profile, "--protocol", protocol, "--confirm"],
        { signal },
      );
    },

    async recordFailure({ reason, signal } = {}) {
      if (typeof reason !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(reason)) {
        throw new TypeError("reason is invalid");
      }
      return invoke(
        [
          "transaction-record-failure",
          "--profile",
          profile,
          "--protocol",
          protocol,
          "--reason",
          reason,
        ],
        { signal },
      );
    },
  });
}

/**
 * Resolve production proxy: helper when available, otherwise fail-closed stub.
 * Never silently bypass Slice 6 for coordinator-delivery.
 */
export function resolveTrustedTransactionProxy({
  helperPath = null,
  profile = null,
  protocol = "coordinator-delivery-v1",
  createStub,
  createHelper = createHelperTrustedTransactionProxy,
  run,
} = {}) {
  if (typeof createStub !== "function") {
    throw new TypeError("createStub is required");
  }
  if (!helperPath) {
    return createStub();
  }
  if (protocol === "coordinator-delivery-v1" && (!profile || typeof profile !== "string")) {
    // Fail closed rather than invent a Node-side path.
    return createStub();
  }
  try {
    return createHelper({ helperPath, profile, protocol, run });
  } catch {
    return createStub();
  }
}
