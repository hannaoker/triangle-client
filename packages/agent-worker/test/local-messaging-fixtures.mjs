import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { coded } from "../src/local-messaging-errors.mjs";

/**
 * TEST FIXTURES ONLY.
 *
 * CUSTODY SEMANTICS DISCLAIMER:
 * These journal implementations (Memory and SQLite) are strictly test fixtures designed
 * to verify the local messaging server, client, protocol, and adapter contract.
 * They do NOT represent the production SQLite journal's durability or schema. They do
 * implement the journal contract, including the execution transitions (claim, complete,
 * hold, recover) that keep finished work from running again after a restart.
 */

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
    }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      if (!messageId || !sender || !recipient) {
        throw coded("invalid_record", "sender, recipient, and messageId are required");
      }

      const candidate = { sender, recipient, messageId, requestId, inReplyTo, text, metadata };
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
        record.phase = "reply_failed";
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

export function createTestSqliteJournal({ dbPath }) {
  if (!dbPath) throw coded("invalid_path", "dbPath is required");
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_messages (
      message_id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      request_id TEXT NOT NULL,
      in_reply_to TEXT,
      text TEXT NOT NULL,
      metadata TEXT,
      phase TEXT NOT NULL,
      reason TEXT,
      runtime_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_replies (
      message_id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      request_id TEXT NOT NULL,
      in_reply_to TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata TEXT,
      consumed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {}
  }

  const stmtGetMsg = db.prepare("SELECT * FROM local_messages WHERE message_id = ?");
  const stmtInsertMsg = db.prepare(`
    INSERT INTO local_messages (message_id, sender, recipient, request_id, in_reply_to, text, metadata, phase, reason, runtime_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtUpdateFail = db.prepare(`
    UPDATE local_messages SET phase = 'reply_failed', reason = ?, runtime_error = ?, updated_at = ? WHERE message_id = ?
  `);
  const stmtInsertReply = db.prepare(`
    INSERT INTO local_replies (message_id, sender, recipient, request_id, in_reply_to, text, metadata, consumed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const stmtClaim = db.prepare("UPDATE local_messages SET phase = 'executing', updated_at = ? WHERE message_id = ? AND phase = 'queued_local'");
  const stmtSetPhase = db.prepare("UPDATE local_messages SET phase = ?, reason = COALESCE(?, reason), updated_at = ? WHERE message_id = ?");
  const stmtGetReply = db.prepare("SELECT * FROM local_replies WHERE message_id = ?");
  const stmtConsumeReply = db.prepare("UPDATE local_replies SET consumed = 1, updated_at = ? WHERE message_id = ?");

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
    }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const existing = stmtGetMsg.get(messageId);
      const candidate = {
        sender,
        recipient,
        messageId,
        requestId: requestId || messageId,
        inReplyTo: inReplyTo || null,
        text,
        metadata,
      };

      if (existing) {
        let existingMeta = {};
        try {
          existingMeta = JSON.parse(existing.metadata || "{}");
        } catch {}

        const existingRecord = {
          sender: existing.sender,
          recipient: existing.recipient,
          messageId: existing.message_id,
          requestId: existing.request_id,
          inReplyTo: existing.in_reply_to || null,
          text: existing.text,
          metadata: existingMeta,
          phase: existing.phase,
        };

        if (isEnvelopeEqual(existingRecord, candidate)) {
          return {
            ...existingRecord,
            isDuplicate: true,
          };
        }
        throw coded("duplicate_id_conflict", `Message ${messageId} exists with conflicting envelope`);
      }

      const now = Date.now();
      stmtInsertMsg.run(
        messageId,
        sender,
        recipient,
        candidate.requestId,
        candidate.inReplyTo,
        text,
        JSON.stringify(metadata),
        "queued_local",
        null,
        null,
        now,
        now,
      );

      return {
        messageId,
        sender,
        recipient,
        requestId: candidate.requestId,
        inReplyTo: candidate.inReplyTo,
        phase: "queued_local",
        text,
        metadata,
        isDuplicate: false,
      };
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

      // Verify against original message
      const orig = stmtGetMsg.get(inReplyTo);
      if (orig) {
        if (orig.sender !== recipient) {
          throw coded("invalid_reply_recipient", "Reply recipient must match original request sender");
        }
        if (orig.recipient !== sender) {
          throw coded("invalid_reply_sender", "Reply sender must match original request recipient");
        }
        if (orig.request_id && requestId && orig.request_id !== requestId) {
          throw coded("invalid_reply_correlation", "Reply requestId does not match original request");
        }
      }

      const existing = stmtGetReply.get(messageId);
      const candidate = {
        sender,
        recipient,
        messageId,
        requestId: requestId || messageId,
        inReplyTo,
        text,
        metadata,
      };

      if (existing) {
        let existingMeta = {};
        try {
          existingMeta = JSON.parse(existing.metadata || "{}");
        } catch {}
        const existingReply = {
          sender: existing.sender,
          recipient: existing.recipient,
          messageId: existing.message_id,
          requestId: existing.request_id,
          inReplyTo: existing.in_reply_to,
          text: existing.text,
          metadata: existingMeta,
        };

        if (isEnvelopeEqual(existingReply, candidate)) {
          return { ...existingReply, isDuplicate: true };
        }
        throw coded("duplicate_id_conflict", `Reply ${messageId} exists with conflicting envelope`);
      }

      const now = Date.now();
      stmtInsertReply.run(
        messageId,
        sender,
        recipient,
        candidate.requestId,
        inReplyTo,
        text,
        JSON.stringify(metadata),
        now,
        now,
      );
      return {
        ...candidate,
        consumed: false,
        isDuplicate: false,
      };
    },

    async claimExecution(messageId) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      if (stmtClaim.run(Date.now(), messageId).changes === 0) return null;
      return this.getRecord(messageId);
    },

    async completeExecution(messageId) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      stmtSetPhase.run("completed", null, Date.now(), messageId);
      return this.getRecord(messageId);
    },

    async holdExecution(messageId, reason = "held") {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      stmtSetPhase.run("held", reason, Date.now(), messageId);
      return this.getRecord(messageId);
    },

    async recoverQueued() {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      // Outcome unknown after a restart: hold it, never replay it.
      db.prepare("UPDATE local_messages SET phase = 'held', reason = 'crash_recovery', updated_at = ? WHERE phase IN ('executing', 'started')").run(Date.now());
      const toRun = [];
      const uncertain = [];
      for (const row of db.prepare("SELECT message_id, phase, reason FROM local_messages WHERE phase = 'queued_local' OR (phase = 'held' AND reason = 'crash_recovery') ORDER BY created_at").all()) {
        const record = await this.getRecord(row.message_id);
        (row.phase === "queued_local" ? toRun : uncertain).push(record);
      }
      return { toRun, uncertain };
    },

    async recordExecutionFailure({ messageId, reason, runtimeError = null }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      stmtUpdateFail.run(reason, runtimeError, Date.now(), messageId);
      return this.getRecord(messageId);
    },

    async listReplies({ requester, requestId = null, inReplyTo = null, limit = 50 }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      if (!requester) throw coded("invalid_requester", "requester is required");
      let query = "SELECT * FROM local_replies WHERE recipient = ? AND consumed = 0";
      const params = [requester];
      if (requestId) {
        query += " AND request_id = ?";
        params.push(requestId);
      }
      if (inReplyTo) {
        query += " AND in_reply_to = ?";
        params.push(inReplyTo);
      }
      query += " ORDER BY created_at ASC LIMIT ?";
      params.push(Math.min(limit, 100));

      const rows = db.prepare(query).all(...params);
      return rows.map((r) => {
        let meta = {};
        try {
          meta = JSON.parse(r.metadata || "{}");
        } catch {}
        return {
          messageId: r.message_id,
          sender: r.sender,
          recipient: r.recipient,
          requestId: r.request_id,
          inReplyTo: r.in_reply_to,
          text: r.text,
          metadata: meta,
          consumed: r.consumed === 1,
          createdAt: r.created_at,
        };
      });
    },

    async consumeReply({ requester, messageId }) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const row = stmtGetReply.get(messageId);
      if (!row) throw coded("not_found", `Reply ${messageId} not found`);
      if (row.recipient !== requester) {
        throw coded("foreign_access_denied", `Requester ${requester} cannot consume foreign reply ${messageId}`);
      }
      stmtConsumeReply.run(Date.now(), messageId);
      return { consumed: true, messageId };
    },

    async getRecord(messageId) {
      if (isClosed) throw coded("journal_closed", "Journal is closed");
      const row = stmtGetMsg.get(messageId);
      if (!row) return null;
      let meta = {};
      try {
        meta = JSON.parse(row.metadata || "{}");
      } catch {}
      return {
        messageId: row.message_id,
        sender: row.sender,
        recipient: row.recipient,
        requestId: row.request_id,
        inReplyTo: row.in_reply_to,
        text: row.text,
        metadata: meta,
        phase: row.phase,
        reason: row.reason,
        runtimeError: row.runtime_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    async close() {
      if (isClosed) return;
      isClosed = true;
      try {
        db.close();
      } catch {}
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
