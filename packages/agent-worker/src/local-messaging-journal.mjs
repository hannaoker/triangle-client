import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { openDeliveryJournal, activeStateRoots } from "./shared-delivery-journal.mjs";
import { privateDir, privateFile } from "./delivery-private-path.mjs";
import { coded, LocalMessagingError } from "./local-messaging-errors.mjs";
import { sessionAddress } from "./local-messaging-interactive-session.mjs";
import { sanitizeSessionTitle } from "./local-messaging-auth-broker.mjs";

const DB_NAME = "local-messaging.sqlite";
const OWNER_DB_NAME = "local-messaging-owner.sqlite";
// Installed journals still carry the peer drain's file names, which this journal used to borrow.
const LEGACY_DB_NAME = "peer-drain.sqlite";
const LEGACY_OWNER_DB_NAME = "peer-drain-owner.sqlite";
// Finished records are compacted after the same eight days as the peer drain's.
const RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
// Fingerprints are opaque journal strings. V2 retains per-obligation hashes so
// removing handled work cannot turn the remaining backlog into a new event.
export function wakeSnapshotCovered(current, acknowledged) {
  if (current === acknowledged) return true;
  try {
    const now = JSON.parse(current), prior = JSON.parse(acknowledged);
    if (now?.v !== 2 || prior?.v !== 2 || !Array.isArray(now.items) || !Array.isArray(prior.items)) return false;
    const covered = new Set(prior.items);
    return now.items.every(item => covered.has(item));
  } catch { return false; } // Legacy hash-only fingerprints retain exact matching.
}

export const DEFAULT_MAX_PAIR_EXCHANGES = 10;
export const DEFAULT_PAIR_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function pairKeyFor(a, b) {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

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
    recipientType: row.recipient_type ?? "runner",
    requestId: row.request_id,
    inReplyTo: row.in_reply_to ?? null,
    text: row.text,
    metadata,
    loopDepth,
    phase: row.phase,
    reason: row.reason ?? null,
    runtimeError: row.runtime_error ?? null,
    claimSessionId: row.claim_session_id ?? null,
    claimGeneration: row.claim_generation ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    // Only the presence: the late text is for owner inspection via getLateResult.
    hasLateResult: Boolean(row.late_result_text),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    to_principal: row.to_principal ?? null,
    resolved_via: row.resolved_via ?? null,
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

export function createLocalMessagingJournal({
  stateRoot,
  logger = {},
  maxPairRequests = DEFAULT_MAX_PAIR_EXCHANGES,
  pairWindowMs = DEFAULT_PAIR_WINDOW_MS,
  // Owner choice (`discovery.titles`): when false, conversation titles are neither stored nor shown, including
  // ones stored earlier, which stay in the file only until their entry ages out.
  titles = true,
} = {}) {
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
    CREATE TABLE IF NOT EXISTS local_discovered_sessions (
      id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, workspace TEXT NOT NULL,
      session_id TEXT NOT NULL, lifecycle TEXT NOT NULL, generation INTEGER NOT NULL,
      event_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_discovery_ended (
      id TEXT PRIMARY KEY, event_at INTEGER NOT NULL, generation INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_discovery_events (
      event_id TEXT PRIMARY KEY, digest TEXT NOT NULL, result_json TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );
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
      updated_at INTEGER NOT NULL,
      to_principal TEXT,
      resolved_via TEXT
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

    CREATE TABLE IF NOT EXISTS local_pair_admissions (
      pair_key TEXT NOT NULL,
      message_id TEXT NOT NULL PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_pair_admissions_key_time ON local_pair_admissions(pair_key, created_at);

    CREATE TABLE IF NOT EXISTS local_wake_bindings (
      target_identity TEXT NOT NULL PRIMARY KEY,
      binding_id TEXT NOT NULL,
      auth_binding_id TEXT,
      thread_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'idle',
      active_wake_id TEXT,
      active_fingerprint TEXT,
      last_acknowledged_fingerprint TEXT,
      last_acknowledged_wake_id TEXT,
      receipt_queued_id TEXT,
      receipt_thread_id TEXT,
      last_submitted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_session_attachments (
      id TEXT PRIMARY KEY, child_id TEXT NOT NULL, generation INTEGER NOT NULL,
      installation_id TEXT NOT NULL, expires_at INTEGER NOT NULL, wake_capable INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_interactive_wake_history (
      target_identity TEXT NOT NULL,
      session_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      wake_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (target_identity, session_id, binding_id, generation, wake_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wake_history_lookup ON local_interactive_wake_history(target_identity, session_id, binding_id, generation, wake_id);
  `);

  // Additive migrations only: journals written by earlier versions hold live data.
  const discoveryColumns = db.prepare("PRAGMA table_info(local_discovered_sessions)").all().map(c=>c.name);
  if (!discoveryColumns.includes('harness')) {
    db.exec("ALTER TABLE local_discovered_sessions ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude'");
  }
  if (!discoveryColumns.includes('origin')) {
    db.exec("ALTER TABLE local_discovered_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown'");
  }
  // Descriptive title and the session's host process (pid, exact start time, scope), all nullable and optional.
  for (const [column, type] of [['title', 'TEXT'], ['host_pid', 'INTEGER'], ['host_start', 'TEXT'], ['host_scope', 'TEXT']]) {
    if (!discoveryColumns.includes(column)) db.exec(`ALTER TABLE local_discovered_sessions ADD COLUMN ${column} ${type}`);
  }
  const messageColumns = db.prepare("PRAGMA table_info(local_messages)").all().map((c) => c.name);
  if (!messageColumns.includes("late_result_text")) {
    db.exec("ALTER TABLE local_messages ADD COLUMN late_result_text TEXT");
  }
  if (!messageColumns.includes("recipient_type")) {
    db.exec("ALTER TABLE local_messages ADD COLUMN recipient_type TEXT NOT NULL DEFAULT 'runner'");
  }
  if (!messageColumns.includes("claim_token")) {
    db.exec("ALTER TABLE local_messages ADD COLUMN claim_token TEXT");
  }
  if (!messageColumns.includes("claim_session_id")) {
    db.exec("ALTER TABLE local_messages ADD COLUMN claim_session_id TEXT");
  }
  if (!messageColumns.includes("claim_generation")) {
    db.exec("ALTER TABLE local_messages ADD COLUMN claim_generation INTEGER");
  }
  if (!messageColumns.includes("lease_expires_at")) {
    db.exec("ALTER TABLE local_messages ADD COLUMN lease_expires_at INTEGER");
  }
  if (!messageColumns.includes("claim_operation_id")) {
    db.exec("ALTER TABLE local_messages ADD COLUMN claim_operation_id TEXT");
  }
  if (!messageColumns.includes("to_principal")) {
    db.exec("ALTER TABLE local_messages ADD COLUMN to_principal TEXT");
  }
  if (!messageColumns.includes("resolved_via")) {
    db.exec("ALTER TABLE local_messages ADD COLUMN resolved_via TEXT");
  }
  const wakeColumns = db.prepare("PRAGMA table_info(local_wake_bindings)").all().map((c) => c.name);
  if (!wakeColumns.includes("auth_binding_id")) {
    db.exec("ALTER TABLE local_wake_bindings ADD COLUMN auth_binding_id TEXT");
  }

  // Indices on additive columns created AFTER migrations
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_local_messages_recip_phase_type ON local_messages(recipient, phase, recipient_type);
    CREATE INDEX IF NOT EXISTS idx_local_messages_claim_token ON local_messages(claim_token);
  `);

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

  // Crash recovery on startup for wake bindings: any submitting binding is reset to uncertain
  db.prepare(
    "UPDATE local_wake_bindings SET delivery_state = 'uncertain', updated_at = ? WHERE delivery_state = 'submitting'"
  ).run(Date.now());

  uncertainRecords = uncertainOnStartup.map((r) => ({
    ...mapMessageRow(r),
    phase: "held",
    reason: "crash_recovery",
  }));

  // Wake state crash recovery: crash-in-submitting recovers uncertain, no CLI retry
  db.prepare(
    "UPDATE local_wake_bindings SET delivery_state = 'uncertain', updated_at = ? WHERE delivery_state = 'submitting'"
  ).run(Date.now());

  } catch (error) {
    deliveryJournal.close();
    throw error;
  }

  async function recordSend(envelope, options = {}) {
    assertNotClosed();
    if (!envelope || typeof envelope !== "object") {
      throw coded("invalid_envelope", "Envelope must be an object");
    }
    const { sender, recipient, messageId, requestId, inReplyTo, text, metadata } = envelope;
    if (!sender || !recipient || !messageId || !requestId || typeof text !== "string") {
      throw coded("invalid_envelope", "Envelope missing required fields");
    }
    const to_principal = envelope.to_principal ?? options.to_principal ?? null;
    const resolved_via = envelope.resolved_via ?? options.resolved_via ?? null;

    const recipientType = envelope.recipientType ?? options.recipientType ?? "runner";
    const hash = computeEnvelopeHash(envelope);

    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
      if (existing) {
        if (existing.canonical_hash === hash && (existing.recipient_type ?? "runner") === recipientType) {
          db.exec("COMMIT");
          return { ...mapMessageRow(existing), isDuplicate: true };
        }
        throw coded("duplicate_id_conflict", `Conflicting envelope for messageId: ${messageId}`);
      }

      // Check pair window admission limit atomically with insertion
      const effectiveMax = options.maxPairRequests ?? maxPairRequests;
      const effectiveWindow = options.pairWindowMs ?? pairWindowMs;
      const now = options.now ?? Date.now();
      const pairKey = pairKeyFor(sender, recipient);
      const cutoff = now - effectiveWindow;

      const countRow = db.prepare(
        "SELECT count(*) as count FROM local_pair_admissions WHERE pair_key = ? AND created_at > ?"
      ).get(pairKey, cutoff);

      if (countRow && countRow.count >= effectiveMax) {
        throw coded(
          "exchange_limit_exceeded",
          `More than ${effectiveMax} requests between these agents within ${effectiveWindow}ms; assuming a conversation loop`,
        );
      }

      const metadataJson = metadata ? JSON.stringify(metadata) : null;
      db.prepare(`
        INSERT INTO local_messages (
          message_id, sender, recipient, recipient_type, request_id, in_reply_to, text, metadata_json, canonical_hash, phase, created_at, updated_at, to_principal, resolved_via
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued_local', ?, ?, ?, ?)
      `).run(messageId, sender, recipient, recipientType, requestId, inReplyTo ?? null, text, metadataJson, hash, now, now, to_principal, resolved_via);

      db.prepare(`
        INSERT INTO local_pair_admissions (pair_key, message_id, created_at)
        VALUES (?, ?, ?)
      `).run(pairKey, messageId, now);

      const row = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
      db.exec("COMMIT");
      return { ...mapMessageRow(row), isDuplicate: false };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
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
      .prepare("SELECT * FROM local_messages WHERE phase = 'queued_local' AND recipient_type = 'runner' ORDER BY created_at ASC")
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
      "UPDATE local_messages SET phase = 'executing', updated_at = ? WHERE message_id = ? AND phase = 'queued_local' AND recipient_type = 'runner'"
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

    // Prune pair admissions ONLY when older than effective window AND older than cutoff.
    // This preserves window evidence even if caller supplies retentionMs: 0!
    const pairCutoff = Math.min(cutoff, now - pairWindowMs);
    db.prepare("DELETE FROM local_pair_admissions WHERE created_at <= ?").run(pairCutoff);

    // Per-session custody and wake state outlives nothing: it goes once its discovery row is gone.
    pruneOrphanedSessionState();

    return { messages: Number(messages.changes), replies: Number(replies.changes) };
  }

  function mapWakeBindingRow(row) {
    if (!row) return null;
    return {
      targetIdentity: row.target_identity,
      bindingId: row.binding_id,
      authBindingId: row.auth_binding_id ?? null,
      threadId: row.thread_id,
      generation: row.generation,
      deliveryState: row.delivery_state,
      activeWakeId: row.active_wake_id ?? null,
      activeFingerprint: row.active_fingerprint ?? null,
      lastAcknowledgedFingerprint: row.last_acknowledged_fingerprint ?? null,
      lastAcknowledgedWakeId: row.last_acknowledged_wake_id ?? null,
      receiptQueuedId: row.receipt_queued_id ?? null,
      receiptThreadId: row.receipt_thread_id ?? null,
      lastSubmittedAt: row.last_submitted_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  async function initWakeBinding({ targetIdentity, bindingId, authBindingId, threadId, generation }) {
    assertNotClosed();
    if (!targetIdentity || !threadId) {
      throw coded("invalid_params", "targetIdentity and threadId are required");
    }
    const now = Date.now();
    const existing = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity);
    const effectiveAuthBinding = authBindingId ?? (bindingId && !UUID_PATTERN.test(bindingId) ? bindingId : null);

    if (!existing) {
      const wakeBindingId = (bindingId && UUID_PATTERN.test(bindingId)) ? bindingId.toLowerCase() : randomUUID();
      const initialGen = typeof generation === "number" && generation >= 1 ? generation : 1;
      db.prepare(`
        INSERT INTO local_wake_bindings (
          target_identity, binding_id, auth_binding_id, thread_id, generation, delivery_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)
      `).run(targetIdentity, wakeBindingId, effectiveAuthBinding, threadId, initialGen, now, now);
    } else {
      const threadChanged = existing.thread_id !== threadId;
      const authBindingChanged = Boolean(effectiveAuthBinding && existing.auth_binding_id && existing.auth_binding_id !== effectiveAuthBinding);
      const uuidBindingChanged = Boolean(bindingId && UUID_PATTERN.test(bindingId) && existing.binding_id !== bindingId.toLowerCase());
      const isRebind = threadChanged || authBindingChanged || uuidBindingChanged;

      if (isRebind) {
        const nextGen = existing.generation + 1;
        const nextBindingId = (bindingId && UUID_PATTERN.test(bindingId)) ? bindingId.toLowerCase() : randomUUID();
        const nextState = existing.delivery_state !== "idle" ? "stale_held" : "idle";
        db.prepare(`
          UPDATE local_wake_bindings
          SET binding_id = ?, auth_binding_id = COALESCE(?, auth_binding_id), thread_id = ?, generation = ?, delivery_state = ?, updated_at = ?
          WHERE target_identity = ?
        `).run(nextBindingId, effectiveAuthBinding, threadId, nextGen, nextState, now, targetIdentity);
      }
    }
    const row = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity);
    return mapWakeBindingRow(row);
  }

  async function getWakeBinding(targetIdentity) {
    assertNotClosed();
    const row = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity);
    return mapWakeBindingRow(row);
  }

  function getWakeObligationsSync(targetIdentity, options = {}) {
    assertNotClosed();
    const binding = db.prepare("SELECT thread_id FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity);
    const isInteractive = options.isInteractive === true || Boolean(binding?.thread_id?.startsWith("claude-session:"));

    const unreadReplies = db.prepare(
      "SELECT * FROM local_replies WHERE recipient = ? AND consumed = 0 ORDER BY created_at ASC, message_id ASC"
    ).all(targetIdentity);

    const heldMessages = db.prepare(
      "SELECT * FROM local_messages WHERE sender = ? AND phase = 'held' ORDER BY created_at ASC, message_id ASC"
    ).all(targetIdentity);

    const lateRow = db.prepare(
      "SELECT 1 FROM local_messages WHERE sender = ? AND phase = 'held' AND late_result_text IS NOT NULL LIMIT 1"
    ).get(targetIdentity);
    const hasLateResult = lateRow !== undefined;

    let queuedMessages = [];
    if (isInteractive) {
      queuedMessages = db.prepare(
        "SELECT * FROM local_messages WHERE recipient = ? AND phase = 'queued_local' AND recipient_type = 'interactive' ORDER BY created_at ASC, message_id ASC"
      ).all(targetIdentity);
    }

    const itemHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const items = [
      ...unreadReplies.map(r => itemHash(["reply", r.message_id, r.created_at])),
      ...heldMessages.map(m => itemHash(["held", m.message_id, m.updated_at || m.created_at, Boolean(m.late_result_text)])),
      ...queuedMessages.map(m => itemHash(["queued", m.message_id, m.updated_at || m.created_at])),
    ].sort();
    const fingerprint = JSON.stringify({ v: 2, items });

    return {
      unreadReplies: unreadReplies.map(mapReplyRow),
      heldMessages: heldMessages.map(mapMessageRow),
      queuedMessages: queuedMessages.map(mapMessageRow),
      hasLateResult,
      snapshotFingerprint: fingerprint,
    };
  }

  async function getWakeObligations(targetIdentity, options = {}) {
    return getWakeObligationsSync(targetIdentity, options);
  }

  let immediateTxQueue = Promise.resolve();
  function withImmediateTransaction(fn) {
    const next = immediateTxQueue.then(() => {
      assertNotClosed();
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    });
    immediateTxQueue = next.catch(() => {});
    return next;
  }

  async function initInteractiveWakeBinding({ senderId, sessionId, generation, bindingId }) {
    assertNotClosed();
    if (!senderId || !sessionId || !bindingId || typeof generation !== "number") {
      throw coded("invalid_params", "senderId, sessionId, generation, and bindingId are required");
    }
    const now = Date.now();
    const canonicalBindingId = bindingId.toLowerCase();
    const threadId = `claude-session:${sessionId}`;
    const existing = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(senderId);

    if (!existing) {
      db.prepare(`
        INSERT INTO local_wake_bindings (
          target_identity, binding_id, thread_id, generation, delivery_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'idle', ?, ?)
      `).run(senderId, canonicalBindingId, threadId, generation, now, now);
    } else {
      const isRebind = existing.binding_id !== canonicalBindingId ||
                       existing.generation !== generation ||
                       existing.thread_id !== threadId;
      if (isRebind) {
        const nextState = existing.delivery_state !== "idle" ? "stale_held" : "idle";
        db.prepare(`
          UPDATE local_wake_bindings
          SET binding_id = ?, thread_id = ?, generation = ?, delivery_state = ?, updated_at = ?
          WHERE target_identity = ?
        `).run(canonicalBindingId, threadId, generation, nextState, now, senderId);
      }
    }
    const row = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(senderId);
    return mapWakeBindingRow(row);
  }

  // Wake state of an attached session belongs to its address and lifecycle generation, not to the MCP
  // child process. A replacement child inherits an outstanding wake instead of holding it stale (session
  // addresses have no operator reconcile path), and a new lifecycle generation starts a fresh wake epoch.
  // Legacy single-session bindings keep using initInteractiveWakeBinding.
  async function bindAttachedSessionWake({ senderId, sessionId, generation, bindingId }) {
    assertNotClosed();
    if (!senderId || !sessionId || !bindingId || !Number.isSafeInteger(generation) || generation < 1) {
      throw coded("invalid_params", "senderId, sessionId, bindingId, and a positive generation are required");
    }
    const canonicalBindingId = bindingId.toLowerCase();
    const threadId = `claude-session:${sessionId}`;
    const read = () => db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(senderId);
    const isCurrent = (row) => Boolean(row) && row.binding_id === canonicalBindingId &&
      row.generation === generation && row.thread_id === threadId && row.delivery_state !== "stale_held";

    // Heartbeats re-attach every few seconds: the unchanged case must not write.
    const quick = read();
    if (isCurrent(quick)) return mapWakeBindingRow(quick);

    return withImmediateTransaction(() => {
      const now = Date.now();
      const existing = read();
      if (!existing) {
        db.prepare(`
          INSERT INTO local_wake_bindings (
            target_identity, binding_id, thread_id, generation, delivery_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'idle', ?, ?)
        `).run(senderId, canonicalBindingId, threadId, generation, now, now);
      } else if (!isCurrent(existing)) {
        if (existing.generation === generation && existing.thread_id === threadId && existing.delivery_state !== "stale_held") {
          // Same lifecycle, new MCP child: keep the delivery state and carry the wake history over.
          db.prepare("UPDATE local_wake_bindings SET binding_id = ?, updated_at = ? WHERE target_identity = ?")
            .run(canonicalBindingId, now, senderId);
          db.prepare(`
            UPDATE local_interactive_wake_history SET binding_id = ?
            WHERE target_identity = ? AND session_id = ? AND generation = ? AND binding_id = ?
          `).run(canonicalBindingId, senderId, sessionId, generation, existing.binding_id);
        } else {
          // New lifecycle generation, or a hold left by an earlier build: a fresh wake epoch. The old wake can
          // no longer be acknowledged (acks are fenced by generation), so keeping it would block this session's
          // wakes forever. Acknowledgement fingerprints and the minimum wake interval carry over.
          db.prepare(`
            UPDATE local_wake_bindings
            SET binding_id = ?, thread_id = ?, generation = ?, delivery_state = 'idle',
                active_wake_id = NULL, active_fingerprint = NULL,
                receipt_queued_id = NULL, receipt_thread_id = NULL, updated_at = ?
            WHERE target_identity = ?
          `).run(canonicalBindingId, threadId, generation, now, senderId);
        }
      }
      return mapWakeBindingRow(read());
    });
  }

  async function reserveInteractiveWake({ targetIdentity, reservationId, sessionId, generation, bindingId, now = Date.now() }) {
    assertNotClosed();
    if (
      !targetIdentity ||
      typeof targetIdentity !== "string" ||
      !reservationId ||
      typeof reservationId !== "string" ||
      !sessionId ||
      typeof sessionId !== "string" ||
      !bindingId ||
      typeof bindingId !== "string" ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      throw coded("invalid_params", "targetIdentity, reservationId, sessionId, valid positive generation, and bindingId are required");
    }
    const canonicalBindingId = bindingId.toLowerCase();

    return withImmediateTransaction(() => {
      const binding = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity);
      if (!binding) {
        throw coded("foreign_access_denied", `No wake binding for target ${targetIdentity}`);
      }
      if (binding.delivery_state === "stale_held") {
        throw coded("stale_wake_rebound", "Cannot reserve wake on stale_held binding");
      }
      if (binding.thread_id !== `claude-session:${sessionId}`) {
        throw coded("session_fenced", `Session ID ${sessionId} does not match active binding ${binding.thread_id}`);
      }
      if (binding.generation !== generation) {
        throw coded("stale_wake_generation", `Stale wake generation ${generation} !== ${binding.generation}`);
      }
      if (binding.binding_id !== canonicalBindingId) {
        throw coded("binding_changed", "Binding ID mismatch");
      }

      // Check durable used-reservation tombstones/history (Issue 6)
      const existingHistory = db.prepare(`
        SELECT * FROM local_interactive_wake_history
        WHERE target_identity = ? AND session_id = ? AND binding_id = ? AND generation = ? AND wake_id = ?
      `).get(targetIdentity, sessionId, canonicalBindingId, generation, reservationId);

      if (existingHistory) {
        return {
          reserved: false,
          deliveryAllowed: false,
          isDuplicate: true,
          wakeId: reservationId,
          generation: binding.generation,
          state: existingHistory.state,
        };
      }

      // Active wake duplicate check
      if (binding.active_wake_id === reservationId) {
        return {
          reserved: false,
          deliveryAllowed: false,
          isDuplicate: true,
          wakeId: reservationId,
          generation: binding.generation,
          state: binding.delivery_state,
        };
      }

      if (binding.delivery_state !== "idle") {
        return {
          reserved: false,
          deliveryAllowed: false,
          state: binding.delivery_state,
        };
      }

      // Min-interval check: 15 seconds
      if (binding.last_submitted_at && (now - binding.last_submitted_at < 15000)) {
        return {
          reserved: false,
          deliveryAllowed: false,
          state: "rate_limited",
          reason: "min_interval",
        };
      }

      // Check obligations synchronously
      const obligations = getWakeObligationsSync(targetIdentity, { isInteractive: true });
      const totalCount = obligations.unreadReplies.length + obligations.heldMessages.length + obligations.queuedMessages.length;
      if (totalCount === 0) {
        return {
          reserved: false,
          deliveryAllowed: false,
          state: "no_obligations",
        };
      }

      if (wakeSnapshotCovered(obligations.snapshotFingerprint, binding.last_acknowledged_fingerprint)) {
        return {
          reserved: false,
          deliveryAllowed: false,
          state: "unchanged_backlog",
        };
      }

      // Record durable tombstone in local_interactive_wake_history
      db.prepare(`
        INSERT INTO local_interactive_wake_history (
          target_identity, session_id, binding_id, generation, wake_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?)
      `).run(targetIdentity, sessionId, canonicalBindingId, generation, reservationId, now, now);

      // Atomic update
      const updateResult = db.prepare(`
        UPDATE local_wake_bindings
        SET delivery_state = 'submitting',
            active_wake_id = ?,
            active_fingerprint = ?,
            last_submitted_at = ?,
            updated_at = ?
        WHERE target_identity = ?
          AND generation = ?
          AND binding_id = ?
          AND delivery_state = 'idle'
      `).run(reservationId, obligations.snapshotFingerprint, now, now, targetIdentity, binding.generation, binding.binding_id);

      if (updateResult.changes === 0) {
        return {
          reserved: false,
          deliveryAllowed: false,
          state: "race_lost",
        };
      }

      return {
        reserved: true,
        deliveryAllowed: true,
        wakeId: reservationId,
        generation: binding.generation,
        sessionId,
        bindingId: binding.binding_id,
        snapshot: {
          wakeId: reservationId,
          replyCount: obligations.unreadReplies.length,
          inboxCount: obligations.queuedMessages.length,
          heldCount: obligations.heldMessages.length,
          lateResult: obligations.hasLateResult,
        },
      };
    });
  }

  async function reportInteractiveWakeResult({ targetIdentity, wakeId, generation, sessionId, bindingId, result, now = Date.now() }) {
    assertNotClosed();
    if (
      !targetIdentity ||
      typeof targetIdentity !== "string" ||
      !wakeId ||
      typeof wakeId !== "string" ||
      !result ||
      typeof result !== "string" ||
      !sessionId ||
      typeof sessionId !== "string" ||
      !bindingId ||
      typeof bindingId !== "string" ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      throw coded("invalid_params", "targetIdentity, wakeId, sessionId, bindingId, positive safe integer generation, and result are required");
    }
    const canonicalBindingId = bindingId.toLowerCase();

    return withImmediateTransaction(() => {
      const binding = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity);
      if (!binding) {
        throw coded("foreign_access_denied", `No wake binding for target ${targetIdentity}`);
      }
      if (binding.delivery_state === "stale_held") {
        throw coded("stale_wake_rebound", "Binding is in stale_held state");
      }
      if (binding.thread_id !== `claude-session:${sessionId}`) {
        throw coded("session_fenced", `Session ID ${sessionId} does not match active binding ${binding.thread_id}`);
      }
      if (binding.generation !== generation) {
        throw coded("stale_wake_generation", `Stale wake generation ${generation} !== ${binding.generation}`);
      }
      if (binding.binding_id !== canonicalBindingId) {
        throw coded("binding_changed", "Binding ID mismatch");
      }

      // Early ack race protection: if already acknowledged, do not resurrect!
      if (binding.last_acknowledged_wake_id === wakeId && binding.active_wake_id !== wakeId) {
        return { success: true, alreadyAcknowledged: true, state: binding.delivery_state };
      }

      if (binding.active_wake_id !== wakeId) {
        throw coded("stale_wake_id", `Report wakeId ${wakeId} does not match active wake ${binding.active_wake_id}`);
      }

      const nextState = result === "accepted" ? "accepted_awaiting_ack" : "uncertain";
      db.prepare(`
        UPDATE local_wake_bindings
        SET delivery_state = ?, updated_at = ?
        WHERE target_identity = ? AND active_wake_id = ?
      `).run(nextState, now, targetIdentity, wakeId);

      // Update history table
      db.prepare(`
        UPDATE local_interactive_wake_history
        SET state = ?, updated_at = ?
        WHERE target_identity = ? AND session_id = ? AND binding_id = ? AND generation = ? AND wake_id = ?
      `).run(nextState, now, targetIdentity, sessionId, canonicalBindingId, generation, wakeId);

      return { success: true, state: nextState };
    });
  }

  async function ackInteractiveWake({ targetIdentity, wakeId, generation, sessionId, bindingId, now = Date.now() }) {
    assertNotClosed();
    if (
      !targetIdentity ||
      typeof targetIdentity !== "string" ||
      !wakeId ||
      typeof wakeId !== "string" ||
      !sessionId ||
      typeof sessionId !== "string" ||
      !bindingId ||
      typeof bindingId !== "string" ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      throw coded("invalid_params", "targetIdentity, wakeId, sessionId, bindingId, and valid generation are required");
    }
    const canonicalBindingId = bindingId.toLowerCase();

    return withImmediateTransaction(() => {
      const binding = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity);
      if (!binding) {
        throw coded("foreign_access_denied", `No wake binding for target ${targetIdentity}`);
      }
      if (binding.delivery_state === "stale_held") {
        throw coded("stale_wake_rebound", "Cannot acknowledge wake in stale_held state");
      }
      if (binding.thread_id !== `claude-session:${sessionId}`) {
        throw coded("session_fenced", `Session ID ${sessionId} does not match active binding ${binding.thread_id}`);
      }
      if (binding.generation !== generation) {
        throw coded("stale_wake_generation", `Ack generation ${generation} does not match active generation ${binding.generation}`);
      }
      if (binding.binding_id !== canonicalBindingId) {
        throw coded("binding_changed", "Binding ID mismatch");
      }

      // If active_wake_id is different from wakeId, check if it was previously acknowledged or in history
      if (binding.active_wake_id !== wakeId) {
        if (binding.last_acknowledged_wake_id === wakeId) {
          return { acknowledged: true, wakeId, generation: binding.generation, duplicate: true };
        }
        const hist = db.prepare(`
          SELECT * FROM local_interactive_wake_history
          WHERE target_identity = ? AND session_id = ? AND binding_id = ? AND generation = ? AND wake_id = ?
        `).get(targetIdentity, sessionId, canonicalBindingId, generation, wakeId);
        if (hist) {
          return { acknowledged: true, wakeId, generation: binding.generation, duplicate: true };
        }
        throw coded("stale_wake_id", `Ack wakeId ${wakeId} does not match active wake ${binding.active_wake_id}`);
      }

      // Valid delivery states for ack: submitting, accepted_awaiting_ack, uncertain
      db.prepare(`
        UPDATE local_wake_bindings
        SET delivery_state = 'idle',
            last_acknowledged_fingerprint = active_fingerprint,
            last_acknowledged_wake_id = active_wake_id,
            active_wake_id = NULL,
            active_fingerprint = NULL,
            updated_at = ?
        WHERE target_identity = ? AND active_wake_id = ?
      `).run(now, targetIdentity, wakeId);

      // Update history table to acknowledged
      db.prepare(`
        UPDATE local_interactive_wake_history
        SET state = 'acknowledged', updated_at = ?
        WHERE target_identity = ? AND session_id = ? AND binding_id = ? AND generation = ? AND wake_id = ?
      `).run(now, targetIdentity, sessionId, canonicalBindingId, generation, wakeId);

      return { acknowledged: true, wakeId, generation: binding.generation };
    });
  }

  async function setWakeSubmitting({ targetIdentity, wakeId, fingerprint, submittedAt = Date.now() }) {
    assertNotClosed();
    const binding = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity);
    if (!binding) {
      throw coded("unknown_wake_target", `Target identity ${targetIdentity} has no wake binding`);
    }
    if (binding.delivery_state !== "idle") {
      throw coded("wake_state_conflict", `Cannot submit wake: binding is in state ${binding.delivery_state}`);
    }
    db.prepare(`
      UPDATE local_wake_bindings
      SET delivery_state = 'submitting', active_wake_id = ?, active_fingerprint = ?, last_submitted_at = ?, updated_at = ?
      WHERE target_identity = ?
    `).run(wakeId, fingerprint, submittedAt, submittedAt, targetIdentity);
    return mapWakeBindingRow(db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity));
  }

  async function setWakeAccepted({ targetIdentity, wakeId, receipt }) {
    assertNotClosed();
    const now = Date.now();
    db.prepare(`
      UPDATE local_wake_bindings
      SET delivery_state = 'accepted_awaiting_ack', receipt_queued_id = ?, receipt_thread_id = ?, updated_at = ?
      WHERE target_identity = ? AND active_wake_id = ?
    `).run(receipt.queuedId, receipt.threadId, now, targetIdentity, wakeId);
    return mapWakeBindingRow(db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity));
  }

  async function setWakeUncertain({ targetIdentity, wakeId, reason = "uncertain" }) {
    assertNotClosed();
    const now = Date.now();
    db.prepare(`
      UPDATE local_wake_bindings
      SET delivery_state = 'uncertain', updated_at = ?
      WHERE target_identity = ? AND active_wake_id = ?
    `).run(now, targetIdentity, wakeId);
    return mapWakeBindingRow(db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(targetIdentity));
  }

  // Offline operator recovery only: intentionally not exposed by the socket/MCP.
  // Caller must hold this journal's exclusive owner lock and validate private config.
  async function reconcileStaleWake({ requester, threadId, authBindingId, wakeId, generation }) {
    assertNotClosed();
    const binding = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(requester);
    if (!binding) throw coded("foreign_access_denied", "No wake binding for this desktop identity");
    if (binding.delivery_state !== "stale_held") throw coded("wake_not_stale", "Only stale_held wakes may be reconciled");
    if (!Number.isSafeInteger(generation) || binding.generation !== generation) throw coded("stale_wake_generation", "Current wake generation required");
    if (!wakeId || binding.active_wake_id !== wakeId) throw coded("stale_wake_id", "Exact held wake ID required");
    if (binding.thread_id !== threadId || !authBindingId || binding.auth_binding_id !== authBindingId) throw coded("binding_changed", "Current desktop integration does not match wake binding");
    db.prepare(`UPDATE local_wake_bindings SET delivery_state = 'idle',
      active_wake_id = NULL, active_fingerprint = NULL,
      last_acknowledged_fingerprint = NULL, last_acknowledged_wake_id = NULL,
      receipt_queued_id = NULL, receipt_thread_id = NULL, last_submitted_at = NULL,
      updated_at = ? WHERE target_identity = ?`).run(Date.now(), requester);
    return {reconciled: true, wakeId, generation, threadId};
  }

  async function ackWake({ requester, wakeId, generation }) {
    assertNotClosed();
    if (!requester || !wakeId || typeof generation !== "number") {
      throw coded("invalid_params", "requester, wakeId, and generation are required");
    }
    const binding = db.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(requester);
    if (!binding) {
      throw coded("foreign_access_denied", `Requester ${requester} has no bound wake target`);
    }
    if (binding.delivery_state === "stale_held") {
      throw coded("stale_wake_rebound", `Cannot acknowledge wake in stale_held state`);
    }
    if (binding.generation !== generation) {
      throw coded("stale_wake_generation", `Ack generation ${generation} does not match active generation ${binding.generation}`);
    }
    if (binding.active_wake_id !== wakeId) {
      throw coded("stale_wake_id", `Ack wakeId ${wakeId} does not match active wake ${binding.active_wake_id}`);
    }

    const now = Date.now();
    db.prepare(`
      UPDATE local_wake_bindings
      SET delivery_state = 'idle',
          last_acknowledged_fingerprint = active_fingerprint,
          last_acknowledged_wake_id = active_wake_id,
          active_wake_id = NULL,
          active_fingerprint = NULL,
          updated_at = ?
      WHERE target_identity = ?
    `).run(now, requester);

    return { acknowledged: true, wakeId, generation };
  }

  const cursorSecret = randomBytes(32);

  function encodeCursor({ requester, createdAt, messageId }) {
    const payload = JSON.stringify({ r: requester, t: createdAt, m: messageId });
    const b64 = Buffer.from(payload, "utf8").toString("base64url");
    const hmac = createHmac("sha256", cursorSecret).update(b64).digest("base64url");
    return `${b64}.${hmac}`;
  }

  function decodeCursor(cursor, requester) {
    if (typeof cursor !== "string") {
      throw coded("invalid_cursor", "Cursor must be a string");
    }
    const dotIndex = cursor.indexOf(".");
    if (dotIndex === -1) {
      throw coded("invalid_cursor", "Malformed cursor format");
    }
    const b64 = cursor.slice(0, dotIndex);
    const hmac = cursor.slice(dotIndex + 1);
    const expectedHmac = createHmac("sha256", cursorSecret).update(b64).digest("base64url");
    const hmacBuf = Buffer.from(hmac);
    const expectedBuf = Buffer.from(expectedHmac);
    if (hmacBuf.length !== expectedBuf.length || !timingSafeEqual(hmacBuf, expectedBuf)) {
      throw coded("invalid_cursor", "Invalid or tampered cursor signature");
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    } catch {
      throw coded("invalid_cursor", "Malformed cursor payload");
    }
    if (!parsed || parsed.r !== requester || typeof parsed.t !== "number" || typeof parsed.m !== "string") {
      throw coded("invalid_cursor", "Cursor requester mismatch or invalid fields");
    }
    return { createdAt: parsed.t, messageId: parsed.m };
  }

  async function listInbox({ requester, limit = 50, cursor = null, now = Date.now } = {}) {
    assertNotClosed();
    if (!requester || typeof requester !== "string") {
      throw coded("invalid_params", "requester is required");
    }
    const currentTime = typeof now === "function" ? now() : now;
    // Reap expired claims
    db.prepare(`
      UPDATE local_messages
      SET phase = 'held', reason = 'lease_expired', updated_at = ?
      WHERE recipient = ? AND phase = 'executing' AND recipient_type = 'interactive'
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(currentTime, requester, currentTime);

    let cursorObj = null;
    if (cursor) {
      cursorObj = decodeCursor(cursor, requester);
    }

    const maxCount = Math.min(Math.max(1, limit), 100);
    let candidateRows;
    if (cursorObj) {
      candidateRows = db.prepare(`
        SELECT * FROM local_messages
        WHERE recipient = ? AND phase = 'queued_local' AND recipient_type = 'interactive'
          AND (created_at > ? OR (created_at = ? AND message_id > ?))
        ORDER BY created_at ASC, message_id ASC
        LIMIT ?
      `).all(requester, cursorObj.createdAt, cursorObj.createdAt, cursorObj.messageId, maxCount + 1);
    } else {
      candidateRows = db.prepare(`
        SELECT * FROM local_messages
        WHERE recipient = ? AND phase = 'queued_local' AND recipient_type = 'interactive'
        ORDER BY created_at ASC, message_id ASC
        LIMIT ?
      `).all(requester, maxCount + 1);
    }

    const MAX_INBOX_PAYLOAD_BYTES = 180 * 1024;
    let totalBytes = 64;
    const items = [];
    let nextCursor = null;

    for (let i = 0; i < candidateRows.length; i++) {
      if (items.length >= maxCount) {
        const lastItem = items[items.length - 1];
        nextCursor = encodeCursor({
          requester,
          createdAt: lastItem.createdAt,
          messageId: lastItem.messageId,
        });
        break;
      }

      const row = candidateRows[i];
      const mapped = mapMessageRow(row);
      const rowBytes = Buffer.byteLength(JSON.stringify(mapped), "utf8") + 2;

      if (items.length > 0 && totalBytes + rowBytes > MAX_INBOX_PAYLOAD_BYTES) {
        const lastItem = items[items.length - 1];
        nextCursor = encodeCursor({
          requester,
          createdAt: lastItem.createdAt,
          messageId: lastItem.messageId,
        });
        break;
      }

      items.push(mapped);
      totalBytes += rowBytes;
    }

    items.nextCursor = nextCursor;
    items.items = items;
    return items;
  }

  const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

  async function claimInboxMessage({ messageId, requester, sessionId, generation, claimId, leaseDurationMs = 3600000, now = Date.now } = {}) {
    assertNotClosed();
    if (
      !messageId ||
      !requester ||
      !sessionId ||
      typeof generation !== "number" ||
      !claimId ||
      typeof claimId !== "string" ||
      !IDENTIFIER_PATTERN.test(claimId)
    ) {
      throw coded("invalid_params", "messageId, requester, sessionId, generation, and valid nonempty claimId are required");
    }
    const currentTime = typeof now === "function" ? now() : now;
    const row = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
    if (!row) {
      throw coded("not_found", `Message ${messageId} not found`);
    }
    if (row.recipient !== requester) {
      throw coded("foreign_access_denied", "Only recipient may claim this message");
    }
    if ((row.recipient_type ?? "runner") !== "interactive") {
      throw coded("invalid_recipient_type", "Message is not an interactive message");
    }

    if (row.phase === "executing") {
      if (row.lease_expires_at && row.lease_expires_at <= currentTime) {
        db.prepare(
          "UPDATE local_messages SET phase = 'held', reason = 'lease_expired', updated_at = ? WHERE message_id = ?"
        ).run(currentTime, messageId);
        throw coded("lease_expired", "Claim lease expired and execution was held");
      }
      if (row.claim_session_id === sessionId && row.claim_generation === generation) {
        if (row.claim_operation_id === claimId) {
          return {
            messageId: row.message_id,
            claimToken: row.claim_token,
            claimId: row.claim_operation_id,
            leaseExpiresAt: row.lease_expires_at,
            requestId: row.request_id,
            isRetry: true,
          };
        }
        return null;
      }
      return null;
    }

    if (row.phase !== "queued_local") {
      return null;
    }

    const claimToken = createHash("sha256").update(randomUUID() + "\0" + currentTime).digest("hex");
    const boundedLease = Math.min(Math.max(Number(leaseDurationMs) || 3600000, 1000), 3600000);
    const leaseExpiresAt = currentTime + boundedLease;

    const res = db.prepare(`
      UPDATE local_messages
      SET phase = 'executing',
          claim_token = ?,
          claim_session_id = ?,
          claim_generation = ?,
          claim_operation_id = ?,
          lease_expires_at = ?,
          updated_at = ?
      WHERE message_id = ? AND recipient = ? AND phase = 'queued_local' AND recipient_type = 'interactive'
    `).run(claimToken, sessionId, generation, claimId, leaseExpiresAt, currentTime, messageId, requester);

    if (res.changes === 0) {
      return null;
    }

    return {
      messageId,
      claimToken,
      claimId,
      leaseExpiresAt,
      requestId: row.request_id,
      isRetry: false,
    };
  }

  async function recordInteractiveReply({ messageId, claimToken, sessionId, generation, requester, text, replyId, metadata = {}, now = Date.now } = {}) {
    assertNotClosed();
    if (!messageId || !claimToken || typeof text !== "string" || !requester || !sessionId || typeof generation !== "number") {
      throw coded("invalid_params", "messageId, claimToken, requester, sessionId, generation, and text are required");
    }

    const currentTime = typeof now === "function" ? now() : now;

    db.exec("BEGIN IMMEDIATE");
    try {
      const orig = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
      if (!orig) {
        throw coded("invalid_reply_correlation", `Original message ${messageId} not found`);
      }
      if (orig.recipient !== requester) {
        throw coded("foreign_access_denied", "Only original recipient can reply");
      }
      if ((orig.recipient_type ?? "runner") !== "interactive") {
        throw coded("invalid_reply_recipient", "Not an interactive message");
      }

      // Claim tuple validation MUST happen BEFORE ANY duplicate acceptance or mutation/late evidence
      if (!orig.claim_token || !orig.claim_session_id || typeof orig.claim_generation !== "number") {
        throw coded("claim_failed", "Message is not claimed");
      }
      if (orig.claim_session_id !== sessionId) {
        throw coded("session_fenced", "Claim session mismatch");
      }
      if (orig.claim_generation !== generation) {
        throw coded("generation_fenced", "Claim generation mismatch");
      }
      if (orig.claim_token !== claimToken) {
        throw coded("invalid_claim_token", "Claim token mismatch");
      }

      if (orig.phase === "completed") {
        const existingReply = db.prepare("SELECT * FROM local_replies WHERE in_reply_to = ?").get(messageId);
        if (!existingReply) {
          throw coded("reply_not_accepted", "Completed message has no recorded reply");
        }
        if (replyId && replyId !== existingReply.message_id) {
          throw coded("duplicate_id_conflict", `Reply ID ${replyId} does not match existing reply ID ${existingReply.message_id}`);
        }
        const parentMetadata = orig.metadata_json ? JSON.parse(orig.metadata_json) : null;
        const parentDepth = parentMetadata?._loopDepth ?? 1;
        const monotonicDepth = parentDepth + 1;
        const replyMetadata = {
          ...(metadata || {}),
          _loopDepth: monotonicDepth,
        };
        const candidateEnvelope = {
          sender: requester,
          recipient: orig.sender,
          messageId: existingReply.message_id,
          requestId: orig.request_id,
          inReplyTo: messageId,
          text,
          metadata: replyMetadata,
        };
        const candidateHash = computeEnvelopeHash(candidateEnvelope);
        if (
          existingReply.sender === requester &&
          existingReply.text === text &&
          existingReply.canonical_hash === candidateHash
        ) {
          db.exec("COMMIT");
          return { ...mapReplyRow(existingReply), isDuplicate: true };
        }
        throw coded("duplicate_id_conflict", "Conflicting reply content or metadata for already completed message");
      }

      if (orig.phase === "held") {
        db.prepare(
          "UPDATE local_messages SET late_result_text = COALESCE(?, late_result_text), updated_at = ? WHERE message_id = ?"
        ).run(text, currentTime, messageId);
        db.exec("COMMIT");
        throw coded("reply_not_accepted", "Message is in phase held; late result retained as held evidence");
      }

      if (orig.phase !== "executing") {
        throw coded("reply_not_accepted", `Message is in phase ${orig.phase}`);
      }

      if (orig.lease_expires_at && orig.lease_expires_at <= currentTime) {
        db.prepare(
          "UPDATE local_messages SET phase = 'held', reason = 'lease_expired', late_result_text = ?, updated_at = ? WHERE message_id = ?"
        ).run(text, currentTime, messageId);
        db.exec("COMMIT");
        throw coded("lease_expired", "Claim lease expired; late result retained as held evidence");
      }

      const parentMetadata = orig.metadata_json ? JSON.parse(orig.metadata_json) : null;
      const parentDepth = parentMetadata?._loopDepth ?? 1;
      const monotonicDepth = parentDepth + 1;
      const replyMetadata = {
        ...(metadata || {}),
        _loopDepth: monotonicDepth,
      };

      const effectiveReplyId = replyId || ("rep-" + randomUUID());
      const replyEnvelope = {
        sender: requester,
        recipient: orig.sender,
        messageId: effectiveReplyId,
        requestId: orig.request_id,
        inReplyTo: messageId,
        text,
        metadata: replyMetadata,
      };
      const replyHash = computeEnvelopeHash(replyEnvelope);

      const existingWithId = db.prepare("SELECT * FROM local_replies WHERE message_id = ?").get(effectiveReplyId);
      if (existingWithId) {
        if (existingWithId.canonical_hash === replyHash) {
          db.exec("COMMIT");
          return { ...mapReplyRow(existingWithId), isDuplicate: true };
        }
        throw coded("duplicate_id_conflict", `Conflicting reply ID: ${effectiveReplyId}`);
      }

      db.prepare(`
        INSERT INTO local_replies (
          message_id, sender, recipient, request_id, in_reply_to, text, metadata_json, canonical_hash, consumed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(effectiveReplyId, requester, orig.sender, orig.request_id, messageId, text, JSON.stringify(replyMetadata), replyHash, currentTime, currentTime);

      db.prepare(
        "UPDATE local_messages SET phase = 'completed', updated_at = ? WHERE message_id = ?"
      ).run(currentTime, messageId);

      const row = db.prepare("SELECT * FROM local_replies WHERE message_id = ?").get(effectiveReplyId);
      db.exec("COMMIT");
      return { ...mapReplyRow(row), isDuplicate: false };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  async function getInteractiveInboxCounts(recipient) {
    assertNotClosed();
    const queued = db.prepare("SELECT count(*) as count FROM local_messages WHERE recipient = ? AND phase = 'queued_local' AND recipient_type = 'interactive'").get(recipient)?.count || 0;
    const executing = db.prepare("SELECT count(*) as count FROM local_messages WHERE recipient = ? AND phase = 'executing' AND recipient_type = 'interactive'").get(recipient)?.count || 0;
    const held = db.prepare("SELECT count(*) as count FROM local_messages WHERE recipient = ? AND phase = 'held' AND recipient_type = 'interactive'").get(recipient)?.count || 0;
    return { queued, executing, held };
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

  async function recordDiscoveryEvent({installationId,event,digest,receivedAt}) {
    assertNotClosed();
    const harness=event.harness||'claude';
    if(!['claude','codex'].includes(harness))throw coded('invalid_discovery_event','Unsupported discovery harness');
    const id=sessionAddress(installationId,event.workspace,harness==='codex'?'codex:'+event.sessionId:event.sessionId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous=db.prepare('SELECT * FROM local_discovery_events WHERE event_id=?').get(event.eventId);
      if(previous){
        if(previous.digest!==digest)throw coded('duplicate_id_conflict','Lifecycle event ID reused with different metadata');
        db.exec('COMMIT');return {...JSON.parse(previous.result_json),duplicate:true};
      }
      const cutoff=receivedAt-RETENTION_MS;
      db.prepare('DELETE FROM local_discovery_events WHERE received_at < ?').run(cutoff);
      let removed=Number(db.prepare('DELETE FROM local_discovered_sessions WHERE last_seen_at < ?').run(cutoff).changes);
      db.prepare('DELETE FROM local_discovery_ended WHERE last_seen_at < ?').run(cutoff);
      const stored=db.prepare('SELECT * FROM local_discovered_sessions WHERE id=?').get(id);
      const tombstone=stored?null:db.prepare('SELECT * FROM local_discovery_ended WHERE id=?').get(id);
      const old=stored||(tombstone?{...tombstone,lifecycle:'ended'}:null);
      const stale=!!old&&(event.observedAt<old.event_at||
        (event.observedAt===old.event_at&&event.kind!=='end')||
        (old.lifecycle==='ended'&&event.kind==='activity'));
      if(!stored&&!stale&&db.prepare('SELECT count(*) AS n FROM local_discovered_sessions').get().n>=128){
        const ended=db.prepare("SELECT * FROM local_discovered_sessions WHERE lifecycle='ended' ORDER BY last_seen_at,id LIMIT 1").get();
        if(!ended)throw coded('directory_full','Session directory is full');
        db.prepare('INSERT OR REPLACE INTO local_discovery_ended(id,event_at,generation,last_seen_at) VALUES(?,?,?,?)').run(ended.id,ended.event_at,ended.generation,ended.last_seen_at);
        db.prepare('DELETE FROM local_discovered_sessions WHERE id=?').run(ended.id);
        removed++;
      }
      const generation=old ? old.generation+(old.lifecycle==='ended'&&event.kind==='start'&&!stale?1:0) : 1;
      if(!stale){
        // A title that cannot be read now keeps the last known one. A start is a new run of the session, so its
        // host process replaces the old one even when it could not be read; other events only refine it.
        const host=event.host??null;
        db.prepare(`INSERT INTO local_discovered_sessions(id,installation_id,workspace,session_id,lifecycle,generation,event_at,last_seen_at,harness,origin,title,host_pid,host_start,host_scope)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lifecycle=excluded.lifecycle,
          generation=excluded.generation,session_id=excluded.session_id,event_at=excluded.event_at,last_seen_at=excluded.last_seen_at,
          origin=CASE WHEN excluded.origin='unknown' THEN local_discovered_sessions.origin ELSE excluded.origin END,
          title=COALESCE(excluded.title,local_discovered_sessions.title),
          host_pid=CASE WHEN excluded.host_pid IS NULL AND ? THEN local_discovered_sessions.host_pid ELSE excluded.host_pid END,
          host_start=CASE WHEN excluded.host_pid IS NULL AND ? THEN local_discovered_sessions.host_start ELSE excluded.host_start END,
          host_scope=CASE WHEN excluded.host_pid IS NULL AND ? THEN local_discovered_sessions.host_scope ELSE excluded.host_scope END`)
          .run(id,installationId,event.workspace,createHash('sha256').update(event.sessionId).digest('hex'),event.kind==='end'?'ended':'observed',generation,event.observedAt,receivedAt,harness,event.origin||'unknown',
            titles?event.title??null:null,host?host.pid:null,host?host.start:null,host?host.scope:null,
            ...(event.kind==='start'?[0,0,0]:[1,1,1]));
      }
      if(!stale){
        if(event.kind==='end')db.prepare(`INSERT INTO local_discovery_ended(id,event_at,generation,last_seen_at) VALUES(?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET event_at=excluded.event_at,generation=excluded.generation,last_seen_at=excluded.last_seen_at`).run(id,event.observedAt,generation,receivedAt);
        else db.prepare('DELETE FROM local_discovery_ended WHERE id=?').run(id);
      }
      if(removed>0)pruneOrphanedSessionState();
      const result={id,generation,stale,duplicate:false};
      db.prepare('INSERT INTO local_discovery_events(event_id,digest,result_json,received_at) VALUES(?,?,?,?)').run(event.eventId,digest,JSON.stringify(result),receivedAt);
      db.exec('COMMIT');return result;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }

  // `_host` is internal: brokers turn it into presence evidence and never hand a pid to a reader. The title is
  // sanitized again here because it is untrusted text that ends up in a label other agents read.
  const discoveredSessionView=(row,workspace)=>{
    const title=titles?sanitizeSessionTitle(row.title):null;
    return {
      id:row.id,label:`${row.harness==='codex'?'Codex':'Claude'} · ${title?title+' · ':''}${path.basename(workspace).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,48)} · ${row.session_id.slice(0,8)}`,
      ...(title?{title}:{}),kind:'conversation',harness:row.harness,...(row.harness==='codex'?{origin:row.origin}:{ }),workspace,generation:row.generation,
      presence:row.lifecycle==='ended'?'offline':'unknown',lifecycle:row.lifecycle,lastSeenAt:row.last_seen_at,
      capabilities:{visible:true,reachable:false,wakeCapable:false},
      ...(row.host_pid?{_host:{pid:row.host_pid,start:row.host_start,scope:row.host_scope}}:{}),
    };
  };
  async function listDiscoveredSessions({installationId,workspace}) {
    assertNotClosed();
    return db.prepare('SELECT * FROM local_discovered_sessions WHERE installation_id=? AND workspace=? ORDER BY id').all(installationId,workspace).map(row=>discoveredSessionView(row,workspace));
  }
  // One session by address, for the paths that already know which one they want (no scan of the whole directory).
  async function getDiscoveredSession({id,installationId,workspace}) {
    assertNotClosed();
    const row=db.prepare('SELECT * FROM local_discovered_sessions WHERE id=? AND installation_id=? AND workspace=?').get(id,installationId,workspace);
    return row?discoveredSessionView(row,workspace):null;
  }

  // Attachment custody is durable across supervisor restart; no raw session UUID is stored.
  async function attachDiscoveredSession({id,childId,generation,installationId,wakeCapable,now=Date.now()}) {
    assertNotClosed();
    const row=db.prepare('SELECT * FROM local_session_attachments WHERE id=?').get(id);
    if(row&&row.installation_id===installationId&&row.expires_at>now&&row.child_id!==childId)throw coded('attachment_busy','Another MCP child owns this session');
    db.prepare(`INSERT INTO local_session_attachments(id,child_id,generation,installation_id,expires_at,wake_capable)
      VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET child_id=excluded.child_id,generation=excluded.generation,
      installation_id=excluded.installation_id,expires_at=excluded.expires_at,wake_capable=excluded.wake_capable`)
      .run(id,childId,generation,installationId,now+30000,wakeCapable?1:0);
  }
  async function getSessionAttachment(id){assertNotClosed();return db.prepare('SELECT * FROM local_session_attachments WHERE id=?').get(id)??null;}
  async function listSessionAttachments(){assertNotClosed();return db.prepare('SELECT * FROM local_session_attachments').all();}
  async function detachDiscoveredSession({id,childId}){assertNotClosed();db.prepare('UPDATE local_session_attachments SET expires_at=0 WHERE id=? AND child_id=?').run(id,childId);}

  // A session address exists only while its discovery row does. Once the row has aged out or been evicted nothing
  // can address the session (reachability needs the row first) and a resumed one attaches afresh, so its custody
  // lease, wake binding and wake history go with it. Legacy bindings (hex senders) are never touched.
  function pruneOrphanedSessionState() {
    const live="(SELECT id FROM local_discovered_sessions)";
    db.prepare(`DELETE FROM local_interactive_wake_history WHERE target_identity LIKE 'session-%' AND target_identity NOT IN ${live}`).run();
    db.prepare(`DELETE FROM local_wake_bindings WHERE target_identity LIKE 'session-%' AND target_identity NOT IN ${live}`).run();
    db.prepare(`DELETE FROM local_session_attachments WHERE id NOT IN ${live}`).run();
  }

  async function close() {
    if (closed) return;
    closed = true;
    deliveryJournal.close();
  }

  return {
    hasDurablePairLimiter: true,
    discoveryUsage: async()=>{assertNotClosed();return {used:db.prepare('SELECT count(*) AS n FROM local_discovered_sessions').get().n};},
    attachDiscoveredSession,
    getSessionAttachment,
    listSessionAttachments,
    getDiscoveredSession,
    detachDiscoveredSession,
    recordDiscoveryEvent,
    listDiscoveredSessions,
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
    listInbox,
    claimInboxMessage,
    recordInteractiveReply,
    getInteractiveInboxCounts,
    compact,
    initWakeBinding,
    getWakeBinding,
    getWakeObligations,
    setWakeSubmitting,
    setWakeAccepted,
    setWakeUncertain,
    ackWake,
    reconcileStaleWake,
    initInteractiveWakeBinding,
    bindAttachedSessionWake,
    reserveInteractiveWake,
    reportInteractiveWakeResult,
    ackInteractiveWake,
    status,
    close,
  };
}
