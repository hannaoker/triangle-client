import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { openDeliveryJournal, activeStateRoots } from "./shared-delivery-journal.mjs";
import { privateDir, privateFile } from "./delivery-private-path.mjs";
import { coded, LocalMessagingError } from "./local-messaging-errors.mjs";

const DB_NAME = "local-messaging.sqlite";
const OWNER_DB_NAME = "local-messaging-owner.sqlite";
// Installed journals still carry the peer drain's file names, which this journal used to borrow.
const LEGACY_DB_NAME = "peer-drain.sqlite";
const LEGACY_OWNER_DB_NAME = "peer-drain-owner.sqlite";
// Finished records are compacted after the same eight days as the peer drain's.
const RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

// One-time move of an installed journal to its own file names. It runs under the
// legacy owner lock (a live old-version owner blocks it) and moves each
// journal file before its database, so an interrupted move resumes from the
// database that is still under the old name. Modes are preserved by rename.
function adoptLegacyJournalFiles(stateRoot, logger) {
  privateDir(stateRoot, { create: true });
  // An in-process owner is reported by openDeliveryJournal; nothing moves under it.
  if (activeStateRoots.has(stateRoot)) return;
  const exists = (name) => lstatSync(path.join(stateRoot, name), { throwIfNoEntry: false }) !== undefined;
  if (!exists(LEGACY_DB_NAME)) return;
  const moves = [
    [`${LEGACY_DB_NAME}-journal`, `${DB_NAME}-journal`],
    [LEGACY_DB_NAME, DB_NAME],
    [`${LEGACY_OWNER_DB_NAME}-journal`, `${OWNER_DB_NAME}-journal`],
    [LEGACY_OWNER_DB_NAME, OWNER_DB_NAME],
  ].filter(([from]) => exists(from));
  for (const [from, to] of moves) {
    privateFile(path.join(stateRoot, from));
    if (exists(to)) {
      throw coded("journal_migration_conflict", `Both ${from} and ${to} exist; refusing to choose between them`);
    }
  }
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  let lock = null;
  if (exists(LEGACY_OWNER_DB_NAME)) {
    lock = new DatabaseSync(path.join(stateRoot, LEGACY_OWNER_DB_NAME));
    try {
      lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch {
      lock.close();
      throw coded("journal_busy", `State directory is actively owned: failed to acquire exclusive lock on ${LEGACY_OWNER_DB_NAME}`);
    }
  }
  try {
    // Only a local journal moves: a peer drain sharing the directory keeps its files.
    const probe = new DatabaseSync(path.join(stateRoot, LEGACY_DB_NAME));
    let ours;
    try {
      ours = probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_messages'").get() !== undefined;
    } finally {
      probe.close();
    }
    if (!ours) return;
    // SQLite may already have recovered and removed a leftover journal while opening the database.
    for (const [from, to] of moves) if (exists(from)) renameSync(path.join(stateRoot, from), path.join(stateRoot, to));
    const dirFd = openSync(stateRoot, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    logger.warn?.("local_messaging_journal_adopted", { files: moves.length });
  } finally {
    if (lock) {
      try {
        lock.exec("ROLLBACK");
      } catch {}
      lock.close();
    }
  }
}

function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

function computeEnvelopeHash(envelope) {
  const norm = {
    sender: envelope.sender,
    recipient: envelope.recipient,
    messageId: envelope.messageId,
    requestId: envelope.requestId,
    inReplyTo: envelope.inReplyTo ?? null,
    text: envelope.text,
    metadata: envelope.metadata ?? null,
  };
  return createHash("sha256").update(canonicalJson(norm), "utf8").digest("hex");
}

function mapMessageRow(row) {
  if (!row) return null;
  const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
  const loopDepth = metadata?._loopDepth ?? undefined;
  return {
    messageId: row.message_id,
    sender: row.sender,
    recipient: row.recipient,
    requestId: row.request_id,
    inReplyTo: row.in_reply_to ?? null,
    text: row.text,
    metadata,
    loopDepth,
    phase: row.phase,
    reason: row.reason ?? null,
    runtimeError: row.runtime_error ?? null,
    // Only the presence: the late text is for owner inspection via getLateResult.
    hasLateResult: Boolean(row.late_result_text),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReplyRow(row) {
  if (!row) return null;
  const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
  const loopDepth = metadata?._loopDepth ?? undefined;
  return {
    messageId: row.message_id,
    sender: row.sender,
    recipient: row.recipient,
    requestId: row.request_id,
    inReplyTo: row.in_reply_to,
    text: row.text,
    metadata,
    loopDepth,
    consumed: Boolean(row.consumed),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createLocalMessagingJournal({ stateRoot, logger = {} } = {}) {
  adoptLegacyJournalFiles(stateRoot, logger);
  const deliveryJournal = openDeliveryJournal({
    stateRoot,
    dbName: DB_NAME,
    ownerDbName: OWNER_DB_NAME,
    busyCode: "journal_busy",
  });
  const { db } = deliveryJournal;

  let closed = false;

  function assertNotClosed() {
    if (closed || deliveryJournal.isClosed()) {
      throw coded("journal_closed", "Local messaging journal is closed");
    }
  }

  let uncertainRecords;
  try {
  // Schema initialization
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_messages (
      message_id TEXT NOT NULL PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      request_id TEXT NOT NULL,
      in_reply_to TEXT,
      text TEXT NOT NULL,
      metadata_json TEXT,
      canonical_hash TEXT NOT NULL,
      phase TEXT NOT NULL,
      reason TEXT,
      runtime_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_messages_phase ON local_messages(phase);
    CREATE INDEX IF NOT EXISTS idx_local_messages_req ON local_messages(request_id);
    CREATE INDEX IF NOT EXISTS idx_local_messages_reply ON local_messages(in_reply_to);

    CREATE TABLE IF NOT EXISTS local_replies (
      message_id TEXT NOT NULL PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      request_id TEXT NOT NULL,
      in_reply_to TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata_json TEXT,
      canonical_hash TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_replies_recip_consumed ON local_replies(recipient, consumed);
    CREATE INDEX IF NOT EXISTS idx_local_replies_req ON local_replies(request_id);
    CREATE INDEX IF NOT EXISTS idx_local_replies_reply ON local_replies(in_reply_to);
  `);

  // Additive migrations only: journals written by earlier versions hold live data.
  const messageColumns = db.prepare("PRAGMA table_info(local_messages)").all().map((c) => c.name);
  if (!messageColumns.includes("late_result_text")) {
    db.exec("ALTER TABLE local_messages ADD COLUMN late_result_text TEXT");
  }

  // Crash recovery on startup: any in-flight execution is held immediately
  const uncertainOnStartup = db
    .prepare("SELECT * FROM local_messages WHERE phase = 'executing'")
    .all();
  if (uncertainOnStartup.length > 0) {
    const now = Date.now();
    db.prepare(
      "UPDATE local_messages SET phase = 'held', reason = 'crash_recovery', updated_at = ? WHERE phase = 'executing'"
    ).run(now);
    logger.warn?.("local_messaging_held_on_recovery", {
      count: uncertainOnStartup.length,
    });
  }

  uncertainRecords = uncertainOnStartup.map((r) => ({
    ...mapMessageRow(r),
    phase: "held",
    reason: "crash_recovery",
  }));

  } catch (error) {
    deliveryJournal.close();
    throw error;
  }

  async function recordSend(envelope) {
    assertNotClosed();
    if (!envelope || typeof envelope !== "object") {
      throw coded("invalid_envelope", "Envelope must be an object");
    }
    const { sender, recipient, messageId, requestId, inReplyTo, text, metadata } = envelope;
    if (!sender || !recipient || !messageId || !requestId || typeof text !== "string") {
      throw coded("invalid_envelope", "Envelope missing required fields");
    }

    const hash = computeEnvelopeHash(envelope);
    const existing = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
    if (existing) {
      if (existing.canonical_hash === hash) {
        return { ...mapMessageRow(existing), isDuplicate: true };
      }
      throw coded("duplicate_id_conflict", `Conflicting envelope for messageId: ${messageId}`);
    }

    const now = Date.now();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    db.prepare(`
      INSERT INTO local_messages (
        message_id, sender, recipient, request_id, in_reply_to, text, metadata_json, canonical_hash, phase, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued_local', ?, ?)
    `).run(messageId, sender, recipient, requestId, inReplyTo ?? null, text, metadataJson, hash, now, now);

    const row = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
    return { ...mapMessageRow(row), isDuplicate: false };
  }

  async function recordReply(envelope) {
    assertNotClosed();
    if (!envelope || typeof envelope !== "object") {
      throw coded("invalid_envelope", "Reply envelope must be an object");
    }
    const { sender, recipient, messageId, requestId, inReplyTo, text, metadata } = envelope;
    if (!sender || !recipient || !messageId || !requestId || !inReplyTo || typeof text !== "string") {
      throw coded("invalid_envelope", "Reply envelope missing required fields");
    }

    const orig = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(inReplyTo);
    if (!orig) {
      throw coded("invalid_reply_correlation", `Original message ${inReplyTo} not found`);
    }

    if (recipient !== orig.sender) {
      throw coded("invalid_reply_recipient", `Reply recipient ${recipient} does not match original sender ${orig.sender}`);
    }
    if (sender !== orig.recipient) {
      throw coded("invalid_reply_sender", `Reply sender ${sender} does not match original recipient ${orig.recipient}`);
    }
    if (requestId !== orig.request_id) {
      throw coded("invalid_reply_correlation", `Reply requestId ${requestId} does not match original requestId ${orig.request_id}`);
    }

    const hash = computeEnvelopeHash(envelope);
    const existing = db.prepare("SELECT * FROM local_replies WHERE message_id = ?").get(messageId);
    if (existing) {
      if (existing.canonical_hash === hash) {
        return { ...mapReplyRow(existing), isDuplicate: true };
      }
      throw coded("duplicate_id_conflict", `Conflicting reply for messageId: ${messageId}`);
    }

    const now = Date.now();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    db.prepare(`
      INSERT INTO local_replies (
        message_id, sender, recipient, request_id, in_reply_to, text, metadata_json, canonical_hash, consumed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(messageId, sender, recipient, requestId, inReplyTo, text, metadataJson, hash, now, now);

    const row = db.prepare("SELECT * FROM local_replies WHERE message_id = ?").get(messageId);
    return { ...mapReplyRow(row), isDuplicate: false };
  }

  async function listReplies({ requester, requestId, inReplyTo, limit = 50, cursor = null } = {}) {
    assertNotClosed();
    if (!requester || typeof requester !== "string") {
      throw coded("invalid_params", "requester is required");
    }

    let sql = "SELECT * FROM local_replies WHERE recipient = ? AND consumed = 0";
    const params = [requester];

    if (requestId) {
      sql += " AND request_id = ?";
      params.push(requestId);
    }
    if (inReplyTo) {
      sql += " AND in_reply_to = ?";
      params.push(inReplyTo);
    }

    if (cursor) {
      let cursorVal;
      try {
        cursorVal = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      } catch {
        throw coded("invalid_cursor", "Invalid reply cursor");
      }
      if (!Array.isArray(cursorVal) || cursorVal.length !== 2) {
        throw coded("invalid_cursor", "Invalid reply cursor format");
      }
      const [cursorCreatedAt, cursorId] = cursorVal;
      sql += " AND (created_at > ? OR (created_at = ? AND message_id > ?))";
      params.push(cursorCreatedAt, cursorCreatedAt, cursorId);
    }

    sql += " ORDER BY created_at ASC, message_id ASC LIMIT ?";
    params.push(Math.min(Math.max(1, limit), 200));

    const rows = db.prepare(sql).all(...params);
    return rows.map((r) => {
      const reply = mapReplyRow(r);
      const replyCursor = Buffer.from(JSON.stringify([r.created_at, r.message_id]), "utf8").toString("base64url");
      return {
        ...reply,
        cursor: replyCursor,
      };
    });
  }

  async function consumeReply({ requester, messageId } = {}) {
    assertNotClosed();
    if (!requester || !messageId) {
      throw coded("invalid_params", "requester and messageId are required");
    }
    const reply = db.prepare("SELECT * FROM local_replies WHERE message_id = ?").get(messageId);
    if (!reply) {
      throw coded("reply_not_found", `Reply ${messageId} not found`);
    }
    if (reply.recipient !== requester) {
      throw coded("foreign_access_denied", "Cannot consume foreign reply");
    }

    const now = Date.now();
    db.prepare("UPDATE local_replies SET consumed = 1, updated_at = ? WHERE message_id = ?").run(now, messageId);
    return { consumed: true, messageId };
  }

  async function getRecord(messageId) {
    assertNotClosed();
    const msg = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
    if (msg) return mapMessageRow(msg);
    const rep = db.prepare("SELECT * FROM local_replies WHERE message_id = ?").get(messageId);
    if (rep) return mapReplyRow(rep);
    return null;
  }

  async function recoverQueued() {
    assertNotClosed();
    const stillExecuting = db.prepare("SELECT * FROM local_messages WHERE phase = 'executing'").all();
    if (stillExecuting.length > 0) {
      const now = Date.now();
      db.prepare(
        "UPDATE local_messages SET phase = 'held', reason = 'crash_recovery', updated_at = ? WHERE phase = 'executing'"
      ).run(now);
      for (const r of stillExecuting) {
        uncertainRecords.push({ ...mapMessageRow(r), phase: "held", reason: "crash_recovery" });
      }
    }

    const queuedRows = db
      .prepare("SELECT * FROM local_messages WHERE phase = 'queued_local' ORDER BY created_at ASC")
      .all();

    return {
      toRun: queuedRows.map(mapMessageRow),
      uncertain: [...uncertainRecords],
    };
  }

  async function claimExecution(messageId) {
    assertNotClosed();
    const now = Date.now();
    const res = db.prepare(
      "UPDATE local_messages SET phase = 'executing', updated_at = ? WHERE message_id = ? AND phase = 'queued_local'"
    ).run(now, messageId);
    if (res.changes === 0) return null;
    const row = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
    return mapMessageRow(row);
  }

  async function completeExecution(messageId) {
    assertNotClosed();
    const now = Date.now();
    db.prepare(
      "UPDATE local_messages SET phase = 'completed', updated_at = ? WHERE message_id = ?"
    ).run(now, messageId);
    const row = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
    return row ? mapMessageRow(row) : null;
  }

  async function holdExecution(messageId, reason = "held", { lateResultText } = {}) {
    assertNotClosed();
    const now = Date.now();
    // A result that arrives after the deadline is kept for the owner, never delivered.
    db.prepare(
      "UPDATE local_messages SET phase = 'held', reason = ?, late_result_text = COALESCE(?, late_result_text), updated_at = ? WHERE message_id = ?"
    ).run(reason, typeof lateResultText === "string" ? lateResultText : null, now, messageId);
    const row = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
    return row ? mapMessageRow(row) : null;
  }

  async function getLateResult(messageId) {
    assertNotClosed();
    const row = db.prepare("SELECT message_id, late_result_text FROM local_messages WHERE message_id = ?").get(messageId);
    return row?.late_result_text ? { messageId: row.message_id, text: row.late_result_text } : null;
  }

  async function recordExecutionFailure({ messageId, reason = "execution_failed", runtimeError = null } = {}) {
    assertNotClosed();
    const now = Date.now();
    db.prepare(
      "UPDATE local_messages SET phase = 'held', reason = ?, runtime_error = ?, updated_at = ? WHERE message_id = ?"
    ).run(reason, runtimeError ? String(runtimeError) : null, now, messageId);
    const row = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
    return row ? mapMessageRow(row) : null;
  }

  // Finished records only: held, queued and executing records and unconsumed
  // replies are never compacted. A completed message goes once every reply to it
  // is gone (consumed and itself older than the retention), so none dangles.
  async function compact({ now = Date.now(), retentionMs = RETENTION_MS } = {}) {
    assertNotClosed();
    const cutoff = now - retentionMs;
    const replies = db.prepare("DELETE FROM local_replies WHERE consumed = 1 AND updated_at <= ?").run(cutoff);
    const messages = db.prepare(`
      DELETE FROM local_messages
      WHERE phase = 'completed' AND updated_at <= ?
        AND NOT EXISTS (SELECT 1 FROM local_replies r WHERE r.in_reply_to = local_messages.message_id)
    `).run(cutoff);
    return { messages: Number(messages.changes), replies: Number(replies.changes) };
  }

  async function status() {
    assertNotClosed();
    const rows = db.prepare("SELECT phase, count(*) as count FROM local_messages GROUP BY phase").all();
    const counts = {
      queued_local: 0,
      executing: 0,
      completed: 0,
      held: 0,
    };
    for (const r of rows) {
      if (r.phase in counts) {
        counts[r.phase] = r.count;
      }
    }
    const replyRow = db.prepare("SELECT count(*) as count FROM local_replies WHERE consumed = 0").get();
    return {
      ...counts,
      queued: counts.queued_local,
      pendingReplies: replyRow ? replyRow.count : 0,
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    deliveryJournal.close();
  }

  return {
    recordSend,
    recordReply,
    recordExecutionFailure,
    listReplies,
    consumeReply,
    getRecord,
    recoverQueued,
    claimExecution,
    completeExecution,
    holdExecution,
    getLateResult,
    compact,
    status,
    close,
  };
}
