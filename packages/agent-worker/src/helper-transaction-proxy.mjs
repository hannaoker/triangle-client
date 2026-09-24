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

function assertRoomId(roomId) {
  if (typeof roomId !== "string" || !/^room_[a-f0-9]{32}$/.test(roomId)) {
    throw new TypeError("roomId is invalid");
  }
  return roomId;
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
    const gate = parseHelperStderrFailure(result.stderr);
    if (gate?.code === "credential_busy" || gate?.code === "enroll_lock_busy") {
      const error = createCodedError("credential_busy", "enrollment reservation is busy");
      error.safeToRetry = gate.safeToRetry !== false;
      error.mustNotReregister = gate.mustNotReregister !== false;
      throw error;
    }
    if (gate?.code === "journal_ineligible") {
      throw createCodedError("journal_ineligible", "enrollment journal is ineligible");
    }
    throw createCodedError(fallbackCode, "transaction helper failed");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw createCodedError(fallbackCode, "transaction helper returned unreadable JSON");
  }
}

/**
 * Parse secret-free helper stderr JSON from transaction-* / gate failures.
 * Accepts both watch_operation_failed and credential_busy / operation_failed shapes.
 */
function parseHelperStderrFailure(stderr) {
  if (typeof stderr !== "string" || stderr.trim().length === 0) return null;
  try {
    const payload = JSON.parse(stderr.trim().split("\n").at(-1));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const code = typeof payload.code === "string"
      ? payload.code
      : (payload.status === "credential_busy" ? "credential_busy" : null);
    if (!code) return null;
    return {
      code,
      status: typeof payload.status === "string" ? payload.status : undefined,
      safeToRetry: payload.safeToRetry === true,
      mustNotReregister: payload.mustNotReregister === true,
      detail: typeof payload.detail === "string" ? payload.detail : undefined,
    };
  } catch {
    return null;
  }
}

function sleepMs(ms, signal) {
  if (signal?.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  busyRetryLimit = 5,
} = {}) {
  assertHelperPath(helperPath);
  assertProfile(profile);
  assertProtocol(protocol);
  if (!Number.isSafeInteger(busyRetryLimit) || busyRetryLimit < 1) {
    throw new TypeError("busyRetryLimit must be an integer >= 1");
  }

  async function invoke(args, { stdin, signal } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= busyRetryLimit; attempt += 1) {
      const result = await run(helperPath, args, { timeoutMs, signal, stdin });
      try {
        return parseJsonStdout(result);
      } catch (error) {
        lastError = error;
        if (error?.code === "credential_busy" && error?.safeToRetry !== false && attempt < busyRetryLimit) {
          await sleepMs(Math.min(50 * attempt, 250), signal);
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? createCodedError("helper_unavailable", "transaction helper failed");
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

    async claimNext({ roomId = null, signal } = {}) {
      if (roomId != null) assertRoomId(roomId);
      const args = ["transaction-claim-next", "--profile", profile, "--protocol", protocol];
      if (roomId != null) args.push("--room-id", roomId);
      return invoke(
        args,
        { signal },
      );
    },

    async readInbound({ signal } = {}) {
      return invoke(
        ["transaction-read-inbound", "--profile", profile, "--protocol", protocol],
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

/**
 * Production App Server `resolveDelivery`: reconcile the durable helper
 * transaction store (Slice 6) without inventing a Node `mesh_` credential path.
 *
 * Calls `transaction-claim-next` so a pending mailbox delivery can be listed,
 * preflighted, selected, and claimed before the App Server bridge starts a turn.
 * When the helper already has a verified `replied` open transaction (reply
 * persisted, ack missing), ack it before admitting more work so a crash between
 * reply and ack cannot permanently block the mailbox.
 * Returns `{ deliveryId, text }` when the helper reports `shouldStartModel` with
 * an open claim that requires a reply; otherwise `null` (empty / receipt-only → skip turn).
 */
export function createHelperDurableDeliveryResolver({
  helperPath,
  profile,
  protocol = "coordinator-delivery-v1",
  createProxy,
  run,
  allowedRoomId = null,
} = {}) {
  assertHelperPath(helperPath);
  assertProfile(profile);
  assertProtocol(protocol);
  if (allowedRoomId != null) assertRoomId(allowedRoomId);
  if (typeof createProxy !== "function") {
    throw new TypeError("createProxy is required");
  }

  const proxy = createProxy({ helperPath, profile, protocol, run });

  function isVerifiedRepliedOpen(open) {
    return (
      open &&
      typeof open === "object" &&
      !Array.isArray(open) &&
      open.state === "replied" &&
      Number.isSafeInteger(open.deliveryId) &&
      open.deliveryId > 0
    );
  }

  async function acknowledgeVerifiedReplied({ open, signal } = {}) {
    if (!isVerifiedRepliedOpen(open)) return false;
    if (typeof proxy.ack !== "function") {
      throw createCodedError(
        "ack_required",
        "helper cannot acknowledge a verified replied transaction",
      );
    }
    await proxy.ack({ signal });
    return true;
  }

  async function claimNextStatus({ signal } = {}) {
    if (typeof proxy.claimNext !== "function") return null;
    try {
      return await proxy.claimNext({ roomId: allowedRoomId, signal });
    } catch (error) {
      if (error?.code === "slice6_required" || error?.code === "helper_unavailable") {
        return null;
      }
      throw error;
    }
  }

  return Object.freeze(async function resolveDelivery({ signal } = {}) {
    let status = await claimNextStatus({ signal });
    if (!status || typeof status !== "object") {
      return null;
    }
    if (status.transactionStuck === true) {
      throw createCodedError("transaction_stuck", "transaction is stuck");
    }

    // Reply already durable in the helper: ack before admitting new work.
    if (await acknowledgeVerifiedReplied({ open: status.open, signal })) {
      status = await claimNextStatus({ signal });
      if (!status || typeof status !== "object") {
        return null;
      }
      if (status.transactionStuck === true) {
        throw createCodedError("transaction_stuck", "transaction is stuck");
      }
      if (isVerifiedRepliedOpen(status.open)) {
        throw createCodedError(
          "replied_ack_did_not_clear",
          "helper still reports a replied open transaction after ack",
        );
      }
    }

    // Absent replyRequired → true (older helpers). False / receiptOnly → never admit.
    const replyRequired = status.replyRequired !== false && status.receiptOnly !== true;
    const open = status.open;
    const hasOpenClaim =
      open &&
      typeof open === "object" &&
      !Array.isArray(open) &&
      open.state !== "replied" &&
      Number.isSafeInteger(open.deliveryId) &&
      open.deliveryId > 0;

    if (!replyRequired) {
      // New helpers claim→ack receipts inside claim-next (open already null).
      // Do not use the general ack command for an older helper's open claim:
      // its durable record cannot prove that the claim is receipt-only.
      if (hasOpenClaim) {
        throw createCodedError(
          "receipt_only_helper_upgrade_required",
          "helper must settle receipt-only claims inside transaction-claim-next",
        );
      }
      return null;
    }

    if (status.shouldStartModel !== true) {
      return null;
    }
    if (!hasOpenClaim) return null;
    if (typeof open.roomId !== "string" || !/^room_[a-f0-9]{32}$/.test(open.roomId)) {
      return null;
    }

    const deliveryId = `delivery_${open.deliveryId}`;
    const inboundEventId =
      typeof open.inboundEventId === "string" && /^event_[a-f0-9]{32}$/.test(open.inboundEventId)
        ? open.inboundEventId
        : null;
    let admitText =
      typeof status.admitText === "string" && status.admitText.length > 0 && status.admitText.length <= 32 * 1024
        ? status.admitText
        : null;
    if (admitText == null) {
      if (typeof proxy.readInbound !== "function") {
        throw createCodedError("inbound_read_required", "helper cannot read the claimed inbound event");
      }
      const inbound = await proxy.readInbound({ signal });
      const matchesClaim =
        inbound &&
        inbound.deliveryId === open.deliveryId &&
        inbound.roomId === open.roomId &&
        inbound.inboundEventId === inboundEventId;
      if (
        !matchesClaim ||
        typeof inbound.text !== "string" ||
        inbound.text.length === 0 ||
        Buffer.byteLength(inbound.text) > 32 * 1024
      ) {
        throw createCodedError("invalid_inbound_event", "helper returned an invalid claimed inbound event");
      }
      admitText = inbound.text;
    }
    return {
      deliveryId,
      text: admitText,
      roomId: open.roomId,
      inboundEventId,
      numericDeliveryId: open.deliveryId,
      replyRequired: true,
    };
  });
}
