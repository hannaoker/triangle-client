import { coded } from "../src/local-messaging-errors.mjs";

export function deterministicMetadataEqual(a, b) {
  if (a === b) return true;
  const objA = a || {};
  const objB = b || {};
  if (typeof objA !== "object" || typeof objB !== "object") return false;
  const keysA = Object.keys(objA).sort();
  const keysB = Object.keys(objB).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i];
    if (key !== keysB[i]) return false;
    const valA = objA[key];
    const valB = objB[key];
    if (typeof valA === "object" && valA !== null && typeof valB === "object" && valB !== null) {
      if (!deterministicMetadataEqual(valA, valB)) return false;
    } else if (valA !== valB) {
      return false;
    }
  }
  return true;
}

export function isEnvelopeEqual(existing, candidate) {
  return (
    existing.sender === candidate.sender &&
    existing.recipient === candidate.recipient &&
    existing.requestId === candidate.requestId &&
    (existing.inReplyTo || null) === (candidate.inReplyTo || null) &&
    existing.text === candidate.text &&
    deterministicMetadataEqual(existing.metadata, candidate.metadata)
  );
}

export function createTestMemoryJournal() {
  const records = new Map(); // messageId -> record
  const replies = new Map(); // messageId -> replyRecord
  const executions = new Map(); // messageId -> status
  const wakeBindings = new Map(); // targetIdentity -> binding
  let isClosed = false;

  return {
    isClosed() {
      return isClosed;
    },

    async recordSend({
      sender,
      recipient,
      messageId,
      requestId,
      inReplyTo = null,
      text = "",
      metadata = {},
      to_principal = null,
      resolved_via = null,
    }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      if (!messageId || !sender || !recipient) {
        throw coded("invalid_record", "sender, recipient, and messageId are required");
      }

      const candidate = { sender, recipient, messageId, requestId, inReplyTo, text, metadata, to_principal, resolved_via };
      const existing = records.get(messageId);
      if (existing) {
        if (isEnvelopeEqual(existing, candidate)) {
          return { ...existing, isDuplicate: true };
        }
        throw coded("duplicate_id_conflict", `Message ${messageId} exists with conflicting envelope`);
      }

      const record = {
        ...candidate,
        phase: "queued_local",
        reason: null,
        runtimeError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      records.set(messageId, record);
      return { ...record, isDuplicate: false };
    },

    async recordReply({
      sender,
      recipient,
      messageId,
      requestId,
      inReplyTo,
      text = "",
      metadata = {},
    }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      if (!messageId || !sender || !recipient || !inReplyTo) {
        throw coded("invalid_reply", "sender, recipient, messageId, and inReplyTo are required");
      }

      // Verify original request correlation
      const original = records.get(inReplyTo);
      if (original) {
        if (original.sender !== recipient) {
          throw coded("invalid_reply_recipient", "Reply recipient must match original request sender");
        }
        if (original.recipient !== sender) {
          throw coded("invalid_reply_sender", "Reply sender must match original request recipient");
        }
        if (original.requestId && requestId && original.requestId !== requestId) {
          throw coded("invalid_reply_correlation", "Reply requestId does not match original request");
        }
      }

      const candidate = { sender, recipient, messageId, requestId, inReplyTo, text, metadata };
      const existing = replies.get(messageId);
      if (existing) {
        if (isEnvelopeEqual(existing, candidate)) {
          return { ...existing, isDuplicate: true };
        }
        throw coded("duplicate_id_conflict", `Reply ${messageId} exists with conflicting envelope`);
      }

      const reply = {
        ...candidate,
        consumed: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      replies.set(messageId, reply);
      return { ...reply, isDuplicate: false };
    },

    async claimExecution(messageId) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const record = records.get(messageId);
      if (!record || record.phase !== "queued_local") return null;
      record.phase = "executing";
      record.updatedAt = Date.now();
      return { ...record };
    },

    async completeExecution(messageId) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const record = records.get(messageId);
      if (!record) return null;
      record.phase = "completed";
      record.updatedAt = Date.now();
      return { ...record };
    },

    async holdExecution(messageId, reason = "held") {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const record = records.get(messageId);
      if (!record) return null;
      record.phase = "held";
      record.reason = reason;
      record.updatedAt = Date.now();
      return { ...record };
    },

    async recoverQueued() {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const toRun = [];
      const uncertain = [];
      for (const record of records.values()) {
        if (record.phase === "executing" || record.phase === "started") {
          // Outcome unknown after a restart: hold it, never replay it.
          record.phase = "held";
          record.reason = "crash_recovery";
          record.updatedAt = Date.now();
        }
        if (record.phase === "queued_local") toRun.push({ ...record });
        else if (record.phase === "held" && record.reason === "crash_recovery") uncertain.push({ ...record });
      }
      return { toRun, uncertain };
    },

    async recordExecutionFailure({ messageId, reason, runtimeError = null }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const record = records.get(messageId);
      if (record) {
        record.phase = "held";
        record.reason = reason;
        record.runtimeError = runtimeError;
        record.updatedAt = Date.now();
      }
      return record;
    },

    async listReplies({ requester, requestId = null, inReplyTo = null, limit = 50 }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      if (!requester) throw coded("invalid_requester", "requester is required");
      const results = [];
      for (const reply of replies.values()) {
        if (reply.recipient !== requester) continue;
        if (reply.consumed) continue;
        if (requestId && reply.requestId !== requestId) continue;
        if (inReplyTo && reply.inReplyTo !== inReplyTo) continue;
        results.push({ ...reply });
        if (results.length >= limit) break;
      }
      return results;
    },

    async consumeReply({ requester, messageId }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      if (!requester || !messageId) {
        throw coded("invalid_consume", "requester and messageId are required");
      }
      const reply = replies.get(messageId);
      if (!reply) {
        throw coded("not_found", `Reply ${messageId} not found`);
      }
      if (reply.recipient !== requester) {
        throw coded("foreign_access_denied", `Requester ${requester} is not authorized to consume reply ${messageId}`);
      }
      reply.consumed = true;
      reply.updatedAt = Date.now();
      return { consumed: true, messageId };
    },

    async getRecord(messageId) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      return records.get(messageId) ?? null;
    },

    async initWakeBinding({ targetIdentity, bindingId, threadId, generation }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      let binding = wakeBindings.get(targetIdentity);
      const now = Date.now();
      if (!binding) {
        binding = {
          targetIdentity,
          bindingId,
          threadId,
          generation,
          deliveryState: "idle",
          activeWakeId: null,
          activeFingerprint: null,
          lastAcknowledgedFingerprint: null,
          lastAcknowledgedWakeId: null,
          receiptQueuedId: null,
          receiptThreadId: null,
          lastSubmittedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        wakeBindings.set(targetIdentity, binding);
      } else {
        const rebind = binding.generation !== generation || binding.bindingId !== bindingId || binding.threadId !== threadId;
        if (rebind) {
          binding.bindingId = bindingId;
          binding.threadId = threadId;
          binding.generation = generation;
          binding.deliveryState = (binding.deliveryState !== "idle") ? "stale_held" : "idle";
          binding.updatedAt = now;
        }
      }
      return { ...binding };
    },

    async getWakeBinding(targetIdentity) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const b = wakeBindings.get(targetIdentity);
      return b ? { ...b } : null;
    },

    async getWakeObligations(targetIdentity) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const unreadReplies = Array.from(replies.values())
        .filter((r) => r.recipient === targetIdentity && !r.consumed)
        .sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
      const heldMessages = Array.from(records.values())
        .filter((m) => m.sender === targetIdentity && m.phase === "held")
        .sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
      const hasLateResult = heldMessages.some((m) => m.lateResultText || m.hasLateResult);

      const replyIds = unreadReplies.map((r) => r.messageId).sort();
      const replyTimestamps = unreadReplies.map((r) => r.createdAt);
      const heldIds = heldMessages.map((m) => m.messageId).sort();
      const heldTimestamps = heldMessages.map((m) => m.updatedAt || m.createdAt);

      const crypto = await import("node:crypto");
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
        replyIds,
        replyTimestamps,
        heldIds,
        heldTimestamps,
        hasLateResult,
      })).digest("hex");

      return {
        unreadReplies: unreadReplies.map((r) => ({ ...r })),
        heldMessages: heldMessages.map((m) => ({ ...m })),
        hasLateResult,
        snapshotFingerprint: fingerprint,
      };
    },

    async setWakeSubmitting({ targetIdentity, wakeId, fingerprint, submittedAt = Date.now() }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const b = wakeBindings.get(targetIdentity);
      if (!b) throw coded("unknown_wake_target", "Target identity has no wake binding");
      if (b.deliveryState !== "idle") throw coded("wake_state_conflict", "Cannot submit wake: state is " + b.deliveryState);
      b.deliveryState = "submitting";
      b.activeWakeId = wakeId;
      b.activeFingerprint = fingerprint;
      b.lastSubmittedAt = submittedAt;
      b.updatedAt = submittedAt;
      return { ...b };
    },

    async setWakeAccepted({ targetIdentity, wakeId, receipt }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const b = wakeBindings.get(targetIdentity);
      b.deliveryState = "accepted_awaiting_ack";
      b.receiptQueuedId = receipt.queuedId;
      b.receiptThreadId = receipt.threadId;
      b.updatedAt = Date.now();
      return { ...b };
    },

    async setWakeUncertain({ targetIdentity, wakeId, reason = "uncertain" }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const b = wakeBindings.get(targetIdentity);
      b.deliveryState = "uncertain";
      b.updatedAt = Date.now();
      return { ...b };
    },

    async ackWake({ requester, wakeId, generation }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const b = wakeBindings.get(requester);
      if (!b) throw coded("foreign_access_denied", "No bound wake target");
      if (b.generation !== generation) throw coded("stale_wake_generation", "Generation mismatch");
      if (b.activeWakeId !== wakeId) throw coded("stale_wake_id", "WakeId mismatch");
      b.deliveryState = "idle";
      b.lastAcknowledgedFingerprint = b.activeFingerprint;
      b.lastAcknowledgedWakeId = b.activeWakeId;
      b.activeWakeId = null;
      b.activeFingerprint = null;
      b.updatedAt = Date.now();
      return { acknowledged: true, wakeId, generation };
    },

    trackExecution(messageId, status) {
      executions.set(messageId, { status, updatedAt: Date.now() });
    },

    getActiveExecutions() {
      return Array.from(executions.entries()).map(([messageId, val]) => ({ messageId, ...val }));
    },

    async close() {
      isClosed = true;
      records.clear();
      replies.clear();
      executions.clear();
    },
  };
}

/**
 * createTestRecoverableDispatcher:
 * Test fixture demonstrating host-owned recoverable dispatcher contract.
 *
 * Implements:
 * - start: recovers queued records on start; uncertain executions are held, not rerun.
 * - notifyAdmission: dedupes notifications, prevents concurrent overlap, and
 *   claims each message in the journal first, so claimed, finished or held work never runs
 *   again, including after a restart. Finished work is marked completed.
 * - stop: awaits active executions to complete before shutdown.
 */
// Recovery-only fixture: intentionally models completion without producing replies.
// Atomic reply persistence is exercised through the production dispatcher tests.
export function createTestRecoverableDispatcher({
  execute = async () => {},
  journal = null,
} = {}) {
  const dispatched = [];
  const running = new Map();
  const completed = new Set();
  const uncertainHeld = new Set();
  let activeJournal = journal;
  let recoveryCount = 0;
  let isClosing = false;

  async function runJob(job) {
    const messageId = job?.messageId;
    if (!messageId) return;

    // Uncertain started executions must NEVER be rerun
    if (uncertainHeld.has(messageId)) {
      return;
    }

    // Duplicate notification / retry never overlaps an active execution
    if (running.has(messageId)) {
      return running.get(messageId);
    }

    // Dedupe notifications: if already completed, do not rerun
    if (completed.has(messageId)) {
      return;
    }

    const promise = (async () => {
      try {
        // One claimant per message: work that is claimed, finished or held is skipped.
        if (activeJournal && !(await activeJournal.claimExecution(messageId))) return;
        dispatched.push(job);
        try {
          await execute(job);
        } catch (error) {
          await activeJournal?.holdExecution(messageId, "runtime_error");
          throw error;
        }
        completed.add(messageId);
        await activeJournal?.completeExecution(messageId);
      } finally {
        running.delete(messageId);
      }
    })();

    running.set(messageId, promise);
    return promise;
  }

  return {
    get dispatched() {
      return [...dispatched];
    },

    get uncertainHeld() {
      return Array.from(uncertainHeld);
    },

    get runningCount() {
      return running.size;
    },

    get recoveryCount() {
      return recoveryCount;
    },

    async start({ journal: startJournal } = {}) {
      activeJournal = startJournal || journal;
      recoveryCount++;
      if (activeJournal) {
        const { toRun = [], uncertain = [] } = await activeJournal.recoverQueued();
        for (const rec of uncertain) {
          uncertainHeld.add(rec.messageId);
        }
        for (const rec of toRun) {
          await runJob(rec);
        }
      }
    },

    async notifyAdmission(job) {
      if (isClosing) return;
      return runJob(job);
    },

    async stop() {
      isClosing = true;
      if (running.size > 0) {
        await Promise.allSettled(Array.from(running.values()));
      }
    },
  };
}

/**
 * Polls until the predicate is truthy. Dispatcher tests use this instead of
 * stop(), which no longer drains queued work.
 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 5, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
