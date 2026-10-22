import { coded } from "./local-messaging-errors.mjs";

/**
 * Durable Local Messaging Journal Contract:
 *
 * Every journal handed to the local messaging subsystem (the production journal in
 * local-messaging-journal.mjs, or a test fixture) MUST implement this contract.
 * The subsystem has no default database: an injected durable adapter is required.
 *
 * Admission and replies:
 * - recordSend(envelope): Atomically persist message in phase 'queued_local'.
 *     Must perform complete immutable envelope comparison (sender, recipient,
 *     requestId, inReplyTo, text, metadata). Duplicate identical envelope returns
 *     existing record with isDuplicate: true, its stored phase and original requestId.
 *     Conflicting envelope throws duplicate_id_conflict.
 * - recordReply(envelope): Persist reply correlated to original request. Must verify
 *     original request's expected sender/recipient/requestId/inReplyTo.
 * - listReplies({ requester, requestId, inReplyTo, limit }): Non-consuming retrieval
 *     filtered strictly to requester. Never exposes foreign replies.
 * - consumeReply({ requester, messageId }): Explicit consumption only. Rejects foreign
 *     requester.
 * - getRecord(messageId): Inspect message by ID for sender/recipient.
 *
 * Execution transitions (relied on by the dispatcher and by restart recovery):
 * - claimExecution(messageId): Atomically move 'queued_local' to 'executing' and return
 *     the record; return null when the record is in any other phase, so work that is
 *     claimed, finished or held is never started again.
 * - completeExecution(messageId): Mark finished work 'completed' so it is never re-run
 *     after a restart.
 * - holdExecution(messageId, reason): Mark work 'held' (uncertain or refused); a held
 *     record is never automatically replayed.
 * - recoverQueued(): On start, hold every record still 'executing' (its outcome is
 *     unknown) with reason 'crash_recovery' and return { toRun, uncertain }: the
 *     'queued_local' records to run and the held uncertain ones.
 * - recordExecutionFailure({ messageId, reason, runtimeError }): Record runtime failure
 *     separately from prompt custody receipt.
 *
 * - close(): Safely flush and release journal resources.
 */

export const REQUIRED_JOURNAL_METHODS = [
  "recordSend",
  "recordReply",
  "recordExecutionFailure",
  "listReplies",
  "consumeReply",
  "getRecord",
  "claimExecution",
  "completeExecution",
  "holdExecution",
  "recoverQueued",
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
