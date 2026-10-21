import { coded } from "./local-messaging-errors.mjs";

/**
 * Shared Durable Local Messaging Journal Contract:
 *
 * All implementations provided to the local messaging subsystem (e.g. peer drain
 * seam adapter or test harness fixtures) MUST adhere to this explicit contract.
 *
 * Production runtime DOES NOT provide a standalone SQLite or in-memory default database.
 * An injected durable shared-journal adapter is strictly required. Shared peer integration
 * remains explicitly gated on PR #104 peer fix extraction.
 *
 * Required Methods:
 * - recordSend(envelope): Atomically persist message in phase 'queued_local'.
 *     Must perform complete immutable envelope comparison (sender, recipient,
 *     requestId, inReplyTo, text, metadata). Duplicate identical envelope returns
 *     existing record with isDuplicate: true and original requestId. Conflicting envelope
 *     throws duplicate_id_conflict.
 * - recordReply(envelope): Persist reply correlated to original request. Must verify
 *     original request's expected sender/recipient/requestId/inReplyTo.
 * - recordExecutionFailure({ messageId, reason, runtimeError }): Record runtime failure
 *     separately from prompt custody receipt.
 * - listReplies({ requester, requestId, inReplyTo, limit }): Non-consuming retrieval
 *     filtered strictly to requester. Never exposes foreign replies.
 * - consumeReply({ requester, messageId }): Explicit consumption only. Rejects foreign
 *     requester.
 * - getRecord(messageId): Inspect message by ID for sender/recipient.
 * - close(): Safely flush and release journal resources.
 *
 * Optional / Recommended Recovery Hooks:
 * - resumeQueuedRecords(): Yields queued_local records for execution recovery.
 *     Uncertain started/executing records must be held/visible, NOT re-executed.
 */

export const REQUIRED_JOURNAL_METHODS = [
  "recordSend",
  "recordReply",
  "recordExecutionFailure",
  "listReplies",
  "consumeReply",
  "getRecord",
];

export function validateJournalAdapter(journal) {
  if (!journal || typeof journal !== "object") {
    throw coded(
      "invalid_journal_adapter",
      "Durable journal adapter is required and must be an object",
    );
  }

  for (const method of REQUIRED_JOURNAL_METHODS) {
    if (typeof journal[method] !== "function") {
      throw coded(
        "invalid_journal_adapter",
        `Durable journal adapter is missing required method: ${method}`,
      );
    }
  }

  return journal;
}
