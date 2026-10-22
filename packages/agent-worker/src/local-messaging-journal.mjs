import { createHash } from "node:crypto";
import { openDeliveryJournal } from "./shared-delivery-journal.mjs";
import { coded, LocalMessagingError } from "./local-messaging-errors.mjs";

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
  const deliveryJournal = openDeliveryJournal({
    stateRoot,
    dbName: "peer-drain.sqlite",
    ownerDbName: "peer-drain-owner.sqlite",
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
    status,
    close,
  };
}
