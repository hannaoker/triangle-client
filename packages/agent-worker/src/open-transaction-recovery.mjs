/**
 * Explicit open-mailbox-transaction recovery after claimer ownership is established.
 *
 * Lock reclaim ≠ delivery recovery. Classify durable helper `open.json` (via
 * transaction-status) by crash point, then resume / ack / quarantine — never
 * invent a second upstream claim id or silently re-run an ambiguous outcome.
 */

const EXPECTED_PROTOCOLS = new Set(["self-serve-drain", "coordinator-delivery-v1"]);

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function isOpenRecord(open) {
  return open != null && typeof open === "object" && !Array.isArray(open);
}

function deliveryIdOf(open) {
  return Number.isSafeInteger(open?.deliveryId) && open.deliveryId > 0 ? open.deliveryId : null;
}

/**
 * Pure classifier for helper status payloads (secret-free).
 *
 * @returns {{
 *   crashPoint: "before_claim"|"after_claim"|"after_reply"|"after_ack_cleanup"|"ambiguous",
 *   action: "none"|"resume_claimed"|"ack_replied"|"drain_receipt"|"quarantine"|"local_cleanup_only",
 *   reason: string|null,
 *   deliveryId: number|null,
 *   state: string|null,
 * }}
 */
export function classifyOpenTransactionRecovery({
  status = null,
  expectedProtocol = "coordinator-delivery-v1",
} = {}) {
  if (!EXPECTED_PROTOCOLS.has(expectedProtocol)) {
    throw new TypeError("expectedProtocol is invalid");
  }

  if (status == null || typeof status !== "object" || Array.isArray(status)) {
    return Object.freeze({
      crashPoint: "ambiguous",
      action: "quarantine",
      reason: "status_unreadable",
      deliveryId: null,
      state: null,
    });
  }

  if (status.transactionStuck === true) {
    return Object.freeze({
      crashPoint: "ambiguous",
      action: "quarantine",
      reason: "transaction_stuck",
      deliveryId: deliveryIdOf(status.open),
      state: isOpenRecord(status.open) ? String(status.open.state ?? "") || null : null,
    });
  }

  const reportedProtocol =
    typeof status.protocol === "string" ? status.protocol : null;
  if (reportedProtocol != null && reportedProtocol !== expectedProtocol) {
    return Object.freeze({
      crashPoint: "ambiguous",
      action: "quarantine",
      reason: "protocol_ownership_mismatch",
      deliveryId: deliveryIdOf(status.open),
      state: isOpenRecord(status.open) ? String(status.open.state ?? "") || null : null,
    });
  }

  const open = status.open;
  if (!isOpenRecord(open) || open === null) {
    // No durable open — normal discovery on next claim-next.
    return Object.freeze({
      crashPoint: "before_claim",
      action: "none",
      reason: null,
      deliveryId: null,
      state: null,
    });
  }

  const state = typeof open.state === "string" ? open.state : null;
  const deliveryId = deliveryIdOf(open);
  if (deliveryId == null || state == null) {
    return Object.freeze({
      crashPoint: "ambiguous",
      action: "quarantine",
      reason: "open_malformed",
      deliveryId,
      state,
    });
  }

  if (state === "replied") {
    // Reply durable; ack missing (or ack completed upstream but local clear pending).
    return Object.freeze({
      crashPoint: "after_reply",
      action: "ack_replied",
      reason: null,
      deliveryId,
      state,
    });
  }

  if (state === "claimed") {
    // Receipt-only claims must be settled by helper drain/claim-next, not model reply.
    if (status.replyRequired === false || status.receiptOnly === true) {
      return Object.freeze({
        crashPoint: "after_claim",
        action: "drain_receipt",
        reason: null,
        deliveryId,
        state,
      });
    }
    // Actionable claim: resume same open (claim-next / resolveDelivery); no new claim id.
    return Object.freeze({
      crashPoint: "after_claim",
      action: "resume_claimed",
      reason: null,
      deliveryId,
      state,
    });
  }

  return Object.freeze({
    crashPoint: "ambiguous",
    action: "quarantine",
    reason: `unknown_open_state:${state}`,
    deliveryId,
    state,
  });
}

/**
 * Inspect helper open transaction and apply safe recovery actions.
 * Does not delete quarantine rows and never posts a second MESH reply.
 */
export async function recoverOpenMailboxTransaction({
  transactionProxy = null,
  expectedProtocol = "coordinator-delivery-v1",
  logger = console,
} = {}) {
  if (transactionProxy == null || typeof transactionProxy.status !== "function") {
    return Object.freeze({
      inspected: false,
      quarantined: 0,
      reconciledAck: 0,
      resumePending: 0,
      receiptDrained: 0,
      crashPoint: "before_claim",
      action: "none",
      reason: "no_transaction_proxy",
    });
  }

  let status;
  try {
    status = await transactionProxy.status();
  } catch (error) {
    const code = error?.code ?? null;
    // Incompatible ownership (e.g. grok/self-serve open under coordinator headless).
    if (
      code === "protocol_mismatch"
      || code === "protocolMismatch"
      || /protocol/i.test(String(error?.message ?? ""))
    ) {
      logger.info?.("triangle_open_txn_quarantined", {
        reason: "protocol_ownership_mismatch",
        code,
      });
      return Object.freeze({
        inspected: true,
        quarantined: 1,
        reconciledAck: 0,
        resumePending: 0,
        receiptDrained: 0,
        crashPoint: "ambiguous",
        action: "quarantine",
        reason: "protocol_ownership_mismatch",
        deliveryId: null,
        state: null,
      });
    }
    throw error;
  }

  const classified = classifyOpenTransactionRecovery({ status, expectedProtocol });

  if (classified.action === "none") {
    return Object.freeze({
      inspected: true,
      quarantined: 0,
      reconciledAck: 0,
      resumePending: 0,
      receiptDrained: 0,
      ...classified,
    });
  }

  if (classified.action === "quarantine") {
    logger.info?.("triangle_open_txn_quarantined", {
      reason: classified.reason,
      deliveryId: classified.deliveryId,
      state: classified.state,
      crashPoint: classified.crashPoint,
    });
    return Object.freeze({
      inspected: true,
      quarantined: 1,
      reconciledAck: 0,
      resumePending: 0,
      receiptDrained: 0,
      ...classified,
    });
  }

  if (classified.action === "ack_replied") {
    if (typeof transactionProxy.ack !== "function") {
      throw createCodedError(
        "ack_required",
        "helper cannot acknowledge a verified replied open transaction",
      );
    }
    await transactionProxy.ack({ resumeOnly: true });
    logger.info?.("triangle_open_txn_reconciled", {
      path: "ack_only",
      deliveryId: classified.deliveryId,
      crashPoint: classified.crashPoint,
    });
    return Object.freeze({
      inspected: true,
      quarantined: 0,
      reconciledAck: 1,
      resumePending: 0,
      receiptDrained: 0,
      ...classified,
    });
  }

  if (classified.action === "drain_receipt") {
    if (typeof transactionProxy.drainReceipts === "function") {
      await transactionProxy.drainReceipts();
      logger.info?.("triangle_open_txn_reconciled", {
        path: "drain_receipt",
        deliveryId: classified.deliveryId,
        crashPoint: classified.crashPoint,
      });
      return Object.freeze({
        inspected: true,
        quarantined: 0,
        reconciledAck: 0,
        resumePending: 0,
        receiptDrained: 1,
        ...classified,
      });
    }
    // Older proxy: leave for claim-next helper path; do not invent ack.
    logger.info?.("triangle_open_txn_resume_pending", {
      path: "receipt_via_claim_next",
      deliveryId: classified.deliveryId,
    });
    return Object.freeze({
      inspected: true,
      quarantined: 0,
      reconciledAck: 0,
      resumePending: 1,
      receiptDrained: 0,
      ...classified,
      action: "resume_claimed",
    });
  }

  if (classified.action === "resume_claimed") {
    // Do not claim with a new id here — next resolveDelivery/claim-next resumes open.json.
    logger.info?.("triangle_open_txn_resume_pending", {
      deliveryId: classified.deliveryId,
      crashPoint: classified.crashPoint,
    });
    return Object.freeze({
      inspected: true,
      quarantined: 0,
      reconciledAck: 0,
      resumePending: 1,
      receiptDrained: 0,
      ...classified,
    });
  }

  return Object.freeze({
    inspected: true,
    quarantined: 1,
    reconciledAck: 0,
    resumePending: 0,
    receiptDrained: 0,
    crashPoint: "ambiguous",
    action: "quarantine",
    reason: "unhandled_action",
    deliveryId: classified.deliveryId,
    state: classified.state,
  });
}
