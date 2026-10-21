import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
} from "node:fs";
import { privateDir, privateFile } from "./peer/private-path.mjs";

export const PEER_ENVELOPE_PROTOCOL = "triangle.peer/1";
export const MAX_PAYLOAD_BYTES = 256 * 1024;
export const MAX_FRAME_BYTES = 320 * 1024;
const RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
const TOMBSTONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS_CAP = 10000;

export const TERMINAL_PHASES = Object.freeze([
  "acked",
  "held",
  "rejected",
  "reply_failed",
  "reply_received",
  "discarded",
]);

const digest = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const coded = (code, message = code) =>
  Object.assign(new Error(message === code ? code : `${code}: ${message}`), { code });

export function attachOutboundContext(err, { messageId, requestId, toEndpointId } = {}) {
  const original = err instanceof Error ? err : new Error(String(err));
  const wrapped = Object.assign(new Error(original.message, { cause: original }), {
    name: original.name,
    code: original.code ?? (original.name === "AbortError" ? "aborted" : undefined),
    messageId,
    requestId,
    toEndpointId,
  });
  if (original.state) wrapped.state = original.state;
  return wrapped;
}

const isEndpoint = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const isIdentifier = (s) => typeof s === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(s);
const isText = (s) =>
  typeof s === "string" && s.trim().length > 0 && Buffer.byteLength(s, "utf8") <= MAX_PAYLOAD_BYTES;

export function deriveScopedContextId(senderEndpointId, requestId) {
  return "peer-" + digest(`${senderEndpointId}\0${requestId}`).slice(0, 40);
}

export function estimateWireFrameLen({ messageId, payload, senderEndpointId, createdAtUnixMs = 0 }) {
  const hash = digest(payload);
  const frameObj = {
    type: "message",
    message_id: messageId,
    payload_hash: hash,
    payload,
    sender_endpoint_id: senderEndpointId,
    created_at_unix_ms: createdAtUnixMs,
  };
  return Buffer.byteLength(JSON.stringify(frameObj), "utf8");
}

export function checkPayloadAndFrame(payload, { messageId, senderEndpointId, createdAtUnixMs = 0 } = {}) {
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: "payload_too_large", error: `Payload ${payloadBytes} exceeds MAX_PAYLOAD_BYTES` };
  }
  if (messageId && senderEndpointId) {
    const frameBytes = estimateWireFrameLen({ messageId, payload, senderEndpointId, createdAtUnixMs });
    if (frameBytes > MAX_FRAME_BYTES) {
      return { ok: false, reason: "payload_too_large", error: `Encoded wire frame ${frameBytes} exceeds MAX_FRAME_BYTES` };
    }
  }
  return { ok: true };
}

export function parsePeerEnvelope(payload) {
  if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    throw coded("invalid_envelope", "Payload exceeds maximum envelope size or is not a string");
  }
  let e;
  try {
    e = JSON.parse(payload);
  } catch {
    throw coded("invalid_envelope", "Payload is not valid JSON");
  }
  if (!e || typeof e !== "object" || Array.isArray(e) || e.protocol !== PEER_ENVELOPE_PROTOCOL) {
    throw coded("invalid_envelope", "Envelope has invalid structure or fields");
  }
  if (!isIdentifier(e.request_id)) {
    throw coded("invalid_envelope", "Invalid request_id");
  }

  if (e.kind === "request") {
    if (!isText(e.text)) {
      throw coded("invalid_envelope", "Invalid request text");
    }
    const expected = ["kind", "protocol", "request_id", "text"];
    if (Object.keys(e).sort().join() !== expected.join()) {
      throw coded("invalid_envelope", "Envelope has unrecognized or missing keys");
    }
    return e;
  }

  if (e.kind === "reply") {
    if (!isIdentifier(e.in_reply_to) || !isText(e.text)) {
      throw coded("invalid_envelope", "Invalid reply in_reply_to or text");
    }
    const expected = ["in_reply_to", "kind", "protocol", "request_id", "text"];
    if (Object.keys(e).sort().join() !== expected.join()) {
      throw coded("invalid_envelope", "Envelope has unrecognized or missing keys");
    }
    return e;
  }

  if (e.kind === "outcome") {
    if (
      !isIdentifier(e.in_reply_to) ||
      !["held", "rejected", "failed"].includes(e.state) ||
      !isIdentifier(e.reason)
    ) {
      throw coded("invalid_envelope", "Invalid outcome in_reply_to, state, or reason");
    }
    const expected = ["in_reply_to", "kind", "protocol", "reason", "request_id", "state"];
    if (Object.keys(e).sort().join() !== expected.join()) {
      throw coded("invalid_envelope", "Envelope has unrecognized or missing keys");
    }
    return e;
  }

  throw coded("invalid_envelope", `Unknown envelope kind: ${e.kind}`);
}

export function derivePeerReplyId(senderEndpointId, messageId) {
  if (!isEndpoint(senderEndpointId) || !isIdentifier(messageId)) {
    throw coded("invalid_identity", "Invalid sender endpoint ID or message ID for reply ID derivation");
  }
  return "peer-reply-" + digest(`triangle-peer-reply-v1\0${senderEndpointId}\0${messageId}`);
}

export async function delay(ms, signal, customSleep) {
  if (signal?.aborted) return;
  if (typeof customSleep === "function") {
    const sleepPromise = customSleep(ms);
    if (!signal) return sleepPromise;
    let onAbort;
    const abortPromise = new Promise((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([sleepPromise, abortPromise]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    return;
  }
  return new Promise((resolve) => {
    let t;
    const onAbort = () => {
      if (t) clearTimeout(t);
      resolve();
    };
    if (signal?.aborted) return resolve();
    t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const activeStateRoots = new Set();

export function createPeerDrainService({
  stateRoot,
  profile,
  profileInstanceId,
  engineManager = null,
  ipc = null,
  runner,
  routes = new Map(),
  logger = console,
  now = Date.now,
  runnerTimeoutMs = 180000,
  pollIntervalMs = 500,
  hook = null,
} = {}) {
  if (
    typeof profile !== "string" ||
    !profile ||
    typeof profileInstanceId !== "string" ||
    !/^[a-f0-9]{64}$/.test(profileInstanceId) ||
    !Number.isSafeInteger(runnerTimeoutMs) ||
    runnerTimeoutMs < 1 ||
    runnerTimeoutMs > 600000 ||
    typeof runner?.run !== "function"
  ) {
    throw coded("invalid_drain_options", "Invalid peer drain service options");
  }

  privateDir(stateRoot, { create: true });
  if (activeStateRoots.has(stateRoot)) {
    throw coded("drain_busy", "Another peer drain service is active on this state directory");
  }

  // Defensive deep clone of routes
  const routesMap = new Map();
  if (routes instanceof Map) {
    for (const [k, v] of routes.entries()) {
      routesMap.set(k, Object.freeze({ id: v.id, addrs: Object.freeze([...(v.addrs ?? [])]) }));
    }
  } else if (routes && typeof routes === "object") {
    for (const [k, v] of Object.entries(routes)) {
      routesMap.set(k, Object.freeze({ id: v.id, addrs: Object.freeze([...(v.addrs ?? [])]) }));
    }
  }

  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

  for (const name of ["peer-drain-owner.sqlite-journal", "peer-drain.sqlite-journal"]) {
    privateFile(path.join(stateRoot, name));
  }
  for (const name of ["peer-drain-owner.sqlite", "peer-drain.sqlite"]) {
    const file = path.join(stateRoot, name);
    privateFile(file);
    if (!existsSync(file)) {
      closeSync(openSync(file, "wx", 0o600));
      const fd = openSync(stateRoot, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }

  const lock = new DatabaseSync(path.join(stateRoot, "peer-drain-owner.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw coded("drain_busy", "Failed to acquire exclusive lock on peer-drain-owner.sqlite");
  }

  activeStateRoots.add(stateRoot);
  let db;
  try {
    db = new DatabaseSync(path.join(stateRoot, "peer-drain.sqlite"));
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");

    const userVersion = db.prepare("PRAGMA user_version").get().user_version;
    if (userVersion > 1) {
      throw coded("journal_version_unsupported", `Unsupported peer drain journal version: ${userVersion}`);
    }

    // Migration in-place if v0 existed with fewer columns: add missing columns before indexes are created (Defect 5)
    if (userVersion === 0) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").all();
      if (tables.length > 0) {
        const cols = db.prepare("PRAGMA table_info(records)").all().map((c) => c.name);
        const neededCols = [
          ["in_reply_to", "TEXT"],
          ["request_id", "TEXT"],
          ["reply_id", "TEXT"],
          ["reply_payload", "TEXT"],
          ["input_payload", "TEXT"],
          ["result_payload", "TEXT"],
          ["reason", "TEXT"],
          ["execution_attempt", "INTEGER NOT NULL DEFAULT 1"],
          ["resend_attempt", "INTEGER NOT NULL DEFAULT 0"],
          ["revision", "INTEGER NOT NULL DEFAULT 1"],
          ["terminal_at", "INTEGER"],
          ["application_consumed", "INTEGER NOT NULL DEFAULT 0"],
          ["input_acked", "INTEGER NOT NULL DEFAULT 0"],
          ["created_at", "INTEGER NOT NULL DEFAULT 0"],
          ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
        ];
        for (const [colName, colDef] of neededCols) {
          if (!cols.includes(colName)) {
            db.exec(`ALTER TABLE records ADD COLUMN ${colName} ${colDef}`);
          }
        }
      }
    }

    // Schema v1
    db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        sender TEXT NOT NULL,
        message_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        phase TEXT NOT NULL,
        in_reply_to TEXT,
        request_id TEXT,
        reply_id TEXT,
        reply_payload TEXT,
        input_payload TEXT,
        result_payload TEXT,
        reason TEXT,
        execution_attempt INTEGER NOT NULL DEFAULT 1,
        resend_attempt INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        terminal_at INTEGER,
        application_consumed INTEGER NOT NULL DEFAULT 0,
        input_acked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (sender, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_records_phase ON records(phase);
      CREATE INDEX IF NOT EXISTS idx_records_in_reply_to ON records(in_reply_to);
      CREATE INDEX IF NOT EXISTS idx_records_request_id ON records(request_id);

      CREATE TABLE IF NOT EXISTS outbound (
        message_id TEXT NOT NULL PRIMARY KEY,
        to_endpoint_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        terminal_at INTEGER,
        closed_at INTEGER,
        close_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_to_req ON outbound(to_endpoint_id, request_id);

      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT NOT NULL PRIMARY KEY,
        sender TEXT NOT NULL,
        message_id TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // Ensure input_acked exists even on existing v1 databases created before this fix
    const cols = db.prepare("PRAGMA table_info(records)").all().map((c) => c.name);
    if (!cols.includes("input_acked")) {
      db.exec("ALTER TABLE records ADD COLUMN input_acked INTEGER NOT NULL DEFAULT 0");
    }

    if (userVersion === 0) {
      db.exec("PRAGMA user_version = 1;");
    }

    chmodSync(path.join(stateRoot, "peer-drain.sqlite"), 0o600);

    // Startup recovery (F2, §3):
    // If execution was in progress when process died, inference outcome is unknown.
    // Transition to 'held' with reason 'crash_recovery'; NEVER rerun automatically.
    const heldOnRecovery = db
      .prepare("UPDATE records SET phase='held', reason='crash_recovery', terminal_at=?, updated_at=? WHERE phase='executing'")
      .run(now(), now());
    if (heldOnRecovery.changes > 0) {
      logger.warn?.("triangle_peer_drain_held_on_recovery", {
        profile,
        profileInstanceId,
        count: heldOnRecovery.changes,
      });
    }
  } catch (error) {
    activeStateRoots.delete(stateRoot);
    try {
      db?.close();
    } catch {}
    try {
      lock.exec("ROLLBACK");
      lock.close();
    } catch {}
    throw coded("journal_unavailable", error.message);
  }

  let active = false;
  let closed = false;
  let loopController = null;
  let runningLoopPromise = null;
  const defaultPollIntervalMs = pollIntervalMs;
  const activeExecutions = new Map();

  function resolveIpc() {
    if (ipc) return ipc;
    if (engineManager) return engineManager.getIpcClient();
    throw coded("ipc_unavailable", "No IPC client available for peer drain");
  }

  const getRow = (sender, id) =>
    db.prepare("SELECT * FROM records WHERE sender=? AND message_id=?").get(sender, id);

  const updatePhase = (r, p) =>
    db
      .prepare("UPDATE records SET phase=?, updated_at=? WHERE sender=? AND message_id=?")
      .run(p, now(), r.sender, r.message_id);

  const replyView = (r) => {
    let envelope = null;
    let text = null;
    try {
      envelope = parsePeerEnvelope(r.reply_payload);
      text = envelope.text ?? null;
    } catch {
      // ignore
    }
    return {
      state: "reply_received",
      fromEndpointId: r.sender,
      messageId: r.message_id,
      text,
      envelope,
      replyPayload: r.reply_payload,
      updatedAt: r.updated_at,
    };
  };

  async function ackItem(r, signal) {
    if (r.sender && r.message_id) {
      const row = getRow(r.sender, r.message_id);
      if (row?.input_acked === 1) {
        return { state: "acked", messageId: r.message_id, replyId: r.reply_id };
      }
    }
    const client = resolveIpc();
    const result = await client.request(
      "ack",
      { items: [{ from_endpoint_id: r.sender, message_id: r.message_id }] },
      { signal },
    );
    if (
      !result ||
      !Number.isSafeInteger(result.acked) ||
      !Number.isSafeInteger(result.already_acked) ||
      result.acked + result.already_acked !== 1 ||
      !Array.isArray(result.unknown) ||
      result.unknown.length > 0
    ) {
      throw coded("unverified_ack", "Peer engine returned unverified ack response");
    }
    if (r.sender && r.message_id) {
      db.prepare("UPDATE records SET input_acked=1, updated_at=? WHERE sender=? AND message_id=?")
        .run(now(), r.sender, r.message_id);
    }
    return { state: "acked", messageId: r.message_id, replyId: r.reply_id };
  }

  async function sendOutcomeBestEffort(r, { state, reason, requestId, inReplyTo, route }, signal) {
    try {
      const outcomePayload = JSON.stringify({
        protocol: PEER_ENVELOPE_PROTOCOL,
        kind: "outcome",
        request_id: requestId,
        in_reply_to: inReplyTo,
        state,
        reason,
      });
      const outcomeMsgId = "peer-outcome-" + digest(`${r.sender}\0${r.message_id}\0${state}`);
      const client = resolveIpc();
      await client.request("send", {
        message_id: outcomeMsgId,
        payload: outcomePayload,
        peer_addr: route,
      }, { signal });
    } catch {
      // Best-effort: outcome failures never block the drain
    }
  }

  async function deliverReply(r, signal) {
    const route = routesMap.get(r.sender);
    if (!route || route.id !== r.sender) {
      db.prepare("UPDATE records SET phase='reply_failed', reason='route_unavailable', terminal_at=?, updated_at=? WHERE sender=? AND message_id=?")
        .run(now(), now(), r.sender, r.message_id);
      await ackItem(r, signal);
      return { state: "reply_failed", messageId: r.message_id, reason: "route_unavailable" };
    }

    const sizeCheck = checkPayloadAndFrame(r.reply_payload, {
      messageId: r.reply_id,
      senderEndpointId: r.sender,
      createdAtUnixMs: now(),
    });
    if (!sizeCheck.ok) {
      db.prepare("UPDATE records SET phase='reply_failed', reason='result_too_large', terminal_at=?, updated_at=? WHERE sender=? AND message_id=?")
        .run(now(), now(), r.sender, r.message_id);
      await ackItem(r, signal);
      return { state: "reply_failed", messageId: r.message_id, reason: "result_too_large" };
    }

    const client = resolveIpc();
    let sendError;
    try {
      await client.request(
        "send",
        { message_id: r.reply_id, payload: r.reply_payload, peer_addr: route },
        { signal },
      );
    } catch (err) {
      sendError = err;
    }

    signal?.throwIfAborted();

    if (sendError?.code === "outbox_full") {
      throw coded("outbox_full", "Peer engine outbox full");
    }
    if (["conflict", "invalid_params"].includes(sendError?.code)) {
      db.prepare("UPDATE records SET phase='reply_failed', reason=?, terminal_at=?, updated_at=? WHERE sender=? AND message_id=?")
        .run(sendError.code, now(), now(), r.sender, r.message_id);
      await ackItem(r, signal);
      return { state: "reply_failed", messageId: r.message_id, reason: sendError.code };
    }

    let status;
    try {
      status = await client.request("message_status", { message_id: r.reply_id }, { signal });
    } catch {
      throw coded("admission_unresolved", "Could not verify outbound reply admission");
    }

    if (
      !status ||
      status.message_id !== r.reply_id ||
      status.peer_endpoint_id !== r.sender ||
      status.payload_hash !== digest(r.reply_payload)
    ) {
      db.prepare("UPDATE records SET phase='reply_failed', reason='admission_mismatch', terminal_at=?, updated_at=? WHERE sender=? AND message_id=?")
        .run(now(), now(), r.sender, r.message_id);
      await ackItem(r, signal);
      return { state: "reply_failed", messageId: r.message_id, reason: "admission_mismatch" };
    }

    if (status.state === "expired" || status.state === "refused") {
      const reason = status.reason || status.state;
      db.prepare("UPDATE records SET phase='reply_failed', reason=?, terminal_at=?, updated_at=? WHERE sender=? AND message_id=?")
        .run(reason, now(), now(), r.sender, r.message_id);
      await ackItem(r, signal);
      return { state: "reply_failed", messageId: r.message_id, reason };
    }

    if (!["queued_local", "settled"].includes(status.state)) {
      db.prepare("UPDATE records SET phase='reply_failed', reason='admission_unverified', terminal_at=?, updated_at=? WHERE sender=? AND message_id=?")
        .run(now(), now(), r.sender, r.message_id);
      await ackItem(r, signal);
      return { state: "reply_failed", messageId: r.message_id, reason: "admission_unverified" };
    }

    updatePhase(r, "admitted");
    await hook?.("admitted");

    await ackItem(r, signal);
    updatePhase(r, "acked");
    db.prepare("UPDATE records SET terminal_at=? WHERE sender=? AND message_id=?").run(now(), r.sender, r.message_id);
    return { state: "acked", messageId: r.message_id, replyId: r.reply_id };
  }

  async function executeRunnerTurn(itemData, signal, { isNew = false, envelope, route } = {}) {
    const senderId = itemData.sender;
    const messageId = itemData.message_id;
    const inputHash = itemData.input_hash;
    const inputPayload = itemData.input_payload;

    if (isNew) {
      db.prepare(`
        INSERT INTO records(sender, message_id, input_hash, phase, request_id, input_payload, execution_attempt, revision, created_at, updated_at)
        VALUES(?, ?, ?, 'executing', ?, ?, ?, 1, ?, ?)
      `).run(
        senderId,
        messageId,
        inputHash,
        envelope.request_id,
        inputPayload,
        itemData.execution_attempt ?? 1,
        now(),
        now(),
      );
    } else {
      db.prepare(
        "UPDATE records SET phase='executing', updated_at=? WHERE sender=? AND message_id=?"
      ).run(now(), senderId, messageId);
    }

    await hook?.("executing");

    // Invariant 5 (X6): Not started is not held: an abort before the runner starts deletes executing record
    if (signal?.aborted) {
      if (isNew) {
        db.prepare("DELETE FROM records WHERE sender=? AND message_id=? AND phase='executing'")
          .run(senderId, messageId);
      } else {
        db.prepare("UPDATE records SET phase='held', updated_at=? WHERE sender=? AND message_id=? AND phase='executing'")
          .run(now(), senderId, messageId);
      }
      throw signal.reason ?? Object.assign(new Error("Aborted before runner start"), { name: "AbortError", code: "aborted" });
    }

    let result;
    let timeout;
    const cancellation = new AbortController();
    const runnerSignal = signal
      ? AbortSignal.any([signal, cancellation.signal])
      : cancellation.signal;
    let onAbort;

    const execKey = `${senderId}:${messageId}`;
    try {
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(coded("runner_interrupted", "Runner was interrupted"));
        runnerSignal.addEventListener("abort", onAbort, { once: true });
      });
      timeout = setTimeout(() => cancellation.abort(), runnerTimeoutMs);

      const scopedContextId = deriveScopedContextId(senderId, envelope?.request_id ?? itemData.request_id);
      const runnerRequest = {
        text: envelope?.text ?? parsePeerEnvelope(inputPayload).text,
        senderId,
        contextId: scopedContextId,
        requestId: envelope?.request_id ?? itemData.request_id,
      };

      const runnerPromise = Promise.resolve().then(() =>
        runner.run(runnerRequest, { signal: runnerSignal })
      );
      activeExecutions.set(execKey, runnerPromise);
      runnerPromise
        .catch(() => {})
        .finally(() => {
          if (activeExecutions.get(execKey) === runnerPromise) {
            activeExecutions.delete(execKey);
          }
        });

      result = await Promise.race([
        runnerPromise,
        interrupted,
      ]);

      runnerSignal.throwIfAborted();
      if (
        result?.status !== "completed" ||
        typeof result?.text !== "string" ||
        result.text.trim().length === 0
      ) {
        throw coded("invalid_runner_result", "Runner did not return a valid completed result");
      }
    } catch (err) {
      const reasonCode = cancellation.signal.aborted ? "runner_timeout" : (err.code ?? "runner_failed");
      db.prepare(
        "UPDATE records SET phase='held', reason=?, terminal_at=?, updated_at=? WHERE sender=? AND message_id=?"
      ).run(reasonCode, now(), now(), senderId, messageId);

      // Ack engine item (F2)
      await ackItem({ sender: senderId, message_id: messageId }, signal);

      // Best-effort outcome send (D3)
      const rRoute = route ?? routesMap.get(senderId);
      if (rRoute) {
        await sendOutcomeBestEffort(
          { sender: senderId, message_id: messageId },
          {
            state: "held",
            reason: reasonCode,
            requestId: envelope?.request_id ?? itemData.request_id,
            inReplyTo: messageId,
            route: rRoute,
          },
          signal,
        );
      }

      return { state: "held", messageId, reason: reasonCode };
    } finally {
      clearTimeout(timeout);
      if (onAbort) runnerSignal.removeEventListener("abort", onAbort);
      cancellation.abort();
    }

    const replyId = derivePeerReplyId(senderId, messageId);
    const replyPayload = JSON.stringify({
      protocol: PEER_ENVELOPE_PROTOCOL,
      kind: "reply",
      request_id: envelope?.request_id ?? itemData.request_id,
      in_reply_to: messageId,
      text: result.text,
    });

    const isOversized =
      Buffer.byteLength(result.text, "utf8") > MAX_PAYLOAD_BYTES ||
      !checkPayloadAndFrame(replyPayload, {
        messageId: replyId,
        senderEndpointId: senderId,
        createdAtUnixMs: now(),
      }).ok;

    if (isOversized) {
      db.prepare(`
        UPDATE records
        SET phase='reply_failed', reply_id=?, reply_payload=?, result_payload=?, reason='result_too_large', terminal_at=?, updated_at=?
        WHERE sender=? AND message_id=?
      `).run(replyId, replyPayload, result.text, now(), now(), senderId, messageId);

      await ackItem({ sender: senderId, message_id: messageId }, signal);

      // Best-effort outcome send (D3)
      const rRoute = route ?? routesMap.get(senderId);
      if (rRoute) {
        await sendOutcomeBestEffort(
          { sender: senderId, message_id: messageId },
          {
            state: "failed",
            reason: "result_too_large",
            requestId: envelope?.request_id ?? itemData.request_id,
            inReplyTo: messageId,
            route: rRoute,
          },
          signal,
        );
      }

      return { state: "reply_failed", messageId, reason: "result_too_large" };
    }

    db.prepare(`
      UPDATE records
      SET phase='result', reply_id=?, reply_payload=?, result_payload=?, updated_at=?
      WHERE sender=? AND message_id=?
    `).run(replyId, replyPayload, result.text, now(), senderId, messageId);

    await hook?.("result");

    return await deliverReply(getRow(senderId, messageId), signal);
  }

  const api = {
    profile,
    profileInstanceId,
    stateRoot,

    async step({ signal } = {}) {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      if (active) throw coded("drain_busy", "Peer drain step is already in flight");
      active = true;
      try {
        signal?.throwIfAborted();

        // 0. Retention compaction (§3)
        const retentionCutoff = now() - RETENTION_MS;
        db.prepare(`
          DELETE FROM records
          WHERE ((phase IN ('acked', 'rejected', 'discarded') AND terminal_at IS NOT NULL AND terminal_at <= ?)
             OR (phase = 'reply_received' AND application_consumed = 1 AND terminal_at IS NOT NULL AND terminal_at <= ?))
        `).run(retentionCutoff, retentionCutoff);
        db.prepare(`
          DELETE FROM outbound
          WHERE closed_at IS NOT NULL AND closed_at <= ?
        `).run(retentionCutoff);

        // 1. Recover operator resend_pending records
        const resendPending = db.prepare(
          "SELECT * FROM records WHERE phase='resend_pending' ORDER BY updated_at LIMIT 1"
        ).get();
        if (resendPending) {
          db.prepare("UPDATE records SET phase='result', updated_at=? WHERE sender=? AND message_id=?")
            .run(now(), resendPending.sender, resendPending.message_id);
          return await deliverReply(getRow(resendPending.sender, resendPending.message_id), signal);
        }

        // 2. Recover operator retry_pending records
        const retryPending = db.prepare(
          "SELECT * FROM records WHERE phase='retry_pending' ORDER BY updated_at LIMIT 1"
        ).get();
        if (retryPending) {
          return await executeRunnerTurn(retryPending, signal);
        }

        // 3. Deliver any persisted outbound replies
        const outstanding = db.prepare(
          "SELECT * FROM records WHERE phase IN ('result', 'admitted') ORDER BY updated_at LIMIT 1"
        ).get();
        if (outstanding) {
          return await deliverReply(outstanding, signal);
        }

        // 4. Check capacity cap (10k rows)
        const count = db.prepare("SELECT COUNT(*) as c FROM records").get().c;
        if (count >= MAX_RECORDS_CAP) {
          return { state: "journal_full", count };
        }

        // 5. Poll engine inbox
        const client = resolveIpc();
        const page = await client.request("inbox", { after_seq: 0, limit: 1 }, { signal });
        if (!page || !Array.isArray(page.items) || page.items.length > 1) {
          throw coded("invalid_inbox", "Malformed inbox response from peer engine");
        }
        if (!page.items.length) {
          return { state: "idle" };
        }

        const item = page.items[0];

        let r = null;
        if (isEndpoint(item.from_endpoint_id) && isIdentifier(item.message_id)) {
          r = getRow(item.from_endpoint_id, item.message_id);
        }

        // Invariant 1: If item is already recorded in a terminal phase, re-ack idempotently and skip
        if (r && TERMINAL_PHASES.includes(r.phase)) {
          await ackItem(r, signal);
          return { state: r.phase, messageId: r.message_id, reason: r.reason };
        }
        if (r && (r.phase === "result" || r.phase === "admitted")) {
          return await deliverReply(r, signal);
        }

        const rejectAndAck = async (reason) => {
          if (r) {
            db.prepare(
              "UPDATE records SET phase='rejected', reason=?, terminal_at=?, updated_at=? WHERE sender=? AND message_id=?"
            ).run(reason, now(), now(), item.from_endpoint_id, item.message_id);
          } else if (isEndpoint(item.from_endpoint_id) && isIdentifier(item.message_id)) {
            db.prepare(`
              INSERT INTO records(sender, message_id, input_hash, phase, reason, terminal_at, created_at, updated_at)
              VALUES(?, ?, ?, 'rejected', ?, ?, ?, ?)
            `).run(
              item.from_endpoint_id,
              item.message_id,
              typeof item.payload_hash === "string" ? item.payload_hash : "",
              reason,
              now(),
              now(),
              now(),
            );
          }
          await ackItem({ sender: item.from_endpoint_id, message_id: item.message_id }, signal);
          return { state: "rejected", messageId: item.message_id, reason };
        };

        if (!isEndpoint(item.from_endpoint_id) || !isIdentifier(item.message_id) || typeof item.payload !== "string") {
          return await rejectAndAck("invalid_envelope");
        }

        if (item.payload_hash !== digest(item.payload)) {
          return await rejectAndAck("hash_mismatch");
        }

        const sizeCheck = checkPayloadAndFrame(item.payload, {
          messageId: item.message_id,
          senderEndpointId: item.from_endpoint_id,
          createdAtUnixMs: now(),
        });
        if (!sizeCheck.ok) {
          return await rejectAndAck("payload_too_large");
        }

        let envelope;
        try {
          envelope = parsePeerEnvelope(item.payload);
        } catch {
          return await rejectAndAck("invalid_envelope");
        }

        const route = routesMap.get(item.from_endpoint_id);
        if (!route || route.id !== item.from_endpoint_id) {
          return await rejectAndAck("unroutable_sender");
        }

        if (r && r.input_hash !== item.payload_hash) {
          return await rejectAndAck("input_conflict");
        }

        if (envelope.kind === "reply" || envelope.kind === "outcome") {
          const outbound = db.prepare("SELECT * FROM outbound WHERE message_id=?").get(envelope.in_reply_to);
          if (!outbound || outbound.to_endpoint_id !== item.from_endpoint_id || outbound.request_id !== envelope.request_id) {
            return await rejectAndAck("unsolicited_reply");
          }
          if (outbound.closed_at !== null) {
            return await rejectAndAck("correlation_closed");
          }

          if (envelope.kind === "reply") {
            db.prepare("UPDATE outbound SET closed_at=?, close_reason='reply_received', updated_at=? WHERE message_id=?")
              .run(now(), now(), outbound.message_id);
          }

          db.prepare(`
            INSERT INTO records(sender, message_id, input_hash, phase, in_reply_to, request_id, reply_payload, input_payload, created_at, updated_at)
            VALUES(?, ?, ?, 'reply_received', ?, ?, ?, ?, ?, ?)
          `).run(
            item.from_endpoint_id,
            item.message_id,
            item.payload_hash,
            envelope.in_reply_to,
            envelope.request_id,
            item.payload,
            item.payload,
            now(),
            now(),
          );

          r = getRow(item.from_endpoint_id, item.message_id);
          await ackItem(r, signal);
          await hook?.("reply_acked");
          return replyView(r);
        }

        return await executeRunnerTurn({
          sender: item.from_endpoint_id,
          message_id: item.message_id,
          input_hash: item.payload_hash,
          input_payload: item.payload,
          request_id: envelope.request_id,
          execution_attempt: 1,
        }, signal, { isNew: true, envelope, route });
      } finally {
        active = false;
      }
    },

    pendingReplies({ inReplyTo, requestId, limit = 200 } = {}) {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      let query = `
        SELECT * FROM records
        WHERE phase='reply_received' AND application_consumed=0
      `;
      const params = [];
      if (inReplyTo !== undefined) {
        query += " AND in_reply_to=?";
        params.push(inReplyTo);
      }
      if (requestId !== undefined) {
        query += " AND request_id=?";
        params.push(requestId);
      }
      query += " ORDER BY updated_at, sender, message_id LIMIT ?";
      params.push(limit);

      return db.prepare(query).all(...params).map(replyView);
    },

    getPendingReplies(options) {
      return this.pendingReplies(options);
    },

    consumeReply({ fromEndpointId, messageId } = {}) {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      if (!isEndpoint(fromEndpointId) || !isIdentifier(messageId)) {
        throw coded("invalid_identity", "Invalid fromEndpointId or messageId");
      }
      const r = getRow(fromEndpointId, messageId);
      if (!r || r.phase !== "reply_received") {
        throw coded("reply_not_found", "No received reply found for endpoint and messageId");
      }
      db.prepare(`
        UPDATE records
        SET application_consumed=1, terminal_at=?, updated_at=?
        WHERE sender=? AND message_id=?
      `).run(now(), now(), fromEndpointId, messageId);
      return { consumed: true };
    },

    resolvePeerRecord({
      fromEndpointId,
      messageId,
      action,
      operationId,
      expectedRevision,
    } = {}) {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      if (!isEndpoint(fromEndpointId) || !isIdentifier(messageId) || !isIdentifier(operationId)) {
        throw coded("invalid_params", "Invalid endpoint, messageId, or operationId");
      }

      db.exec("BEGIN");
      try {
        const existingOp = db.prepare("SELECT * FROM operations WHERE operation_id=?").get(operationId);
        if (existingOp) {
          if (existingOp.sender === fromEndpointId && existingOp.message_id === messageId && existingOp.action === action) {
            db.exec("COMMIT");
            return JSON.parse(existingOp.result);
          }
          throw coded("operation_conflict", "Operation ID already used for a different operation");
        }

        if (action === "close_outbound") {
          const outbound = db.prepare("SELECT * FROM outbound WHERE message_id=?").get(messageId);
          if (!outbound) throw coded("record_not_found", "Outbound record not found");
          db.prepare("UPDATE outbound SET closed_at=?, close_reason='operator_closed', updated_at=? WHERE message_id=?")
            .run(now(), now(), messageId);
          const res = { operationId, action, state: "closed", messageId };
          db.prepare("INSERT INTO operations(operation_id, sender, message_id, action, result, created_at) VALUES(?, ?, ?, ?, ?, ?)")
            .run(operationId, fromEndpointId, messageId, action, JSON.stringify(res), now());
          db.exec("COMMIT");
          return res;
        }

        const r = getRow(fromEndpointId, messageId);
        if (!r) throw coded("record_not_found", "Record not found");

        if (expectedRevision !== undefined && r.revision !== expectedRevision) {
          throw coded("revision_conflict", `Revision mismatch: expected ${expectedRevision}, got ${r.revision}`);
        }

        let res;
        if (r.phase === "held") {
          if (action === "retry") {
            const execKey = `${fromEndpointId}:${messageId}`;
            if (activeExecutions.has(execKey)) {
              throw coded("execution_still_active", "Previous runner execution is still active");
            }
            db.prepare(`
              UPDATE records
              SET phase='retry_pending', execution_attempt=execution_attempt+1, revision=revision+1, updated_at=?
              WHERE sender=? AND message_id=?
            `).run(now(), fromEndpointId, messageId);
            res = { operationId, action, state: "retry_pending", messageId, revision: r.revision + 1 };
          } else if (action === "discard") {
            db.prepare(`
              UPDATE records
              SET phase='discarded', revision=revision+1, terminal_at=?, updated_at=?
              WHERE sender=? AND message_id=?
            `).run(now(), now(), fromEndpointId, messageId);
            res = { operationId, action, state: "discarded", messageId, revision: r.revision + 1 };
          } else {
            throw coded("invalid_action", `Action ${action} is invalid for phase ${r.phase}`);
          }
        } else if (r.phase === "reply_failed") {
          if (action === "resend") {
            const nextAttempt = r.resend_attempt + 1;
            const newReplyId = `${derivePeerReplyId(fromEndpointId, messageId)}-resend-${nextAttempt}`;
            db.prepare(`
              UPDATE records
              SET phase='resend_pending', reply_id=?, resend_attempt=?, revision=revision+1, updated_at=?
              WHERE sender=? AND message_id=?
            `).run(newReplyId, nextAttempt, now(), fromEndpointId, messageId);
            res = { operationId, action, state: "resend_pending", messageId, replyId: newReplyId, revision: r.revision + 1 };
          } else if (action === "discard") {
            db.prepare(`
              UPDATE records
              SET phase='discarded', revision=revision+1, terminal_at=?, updated_at=?
              WHERE sender=? AND message_id=?
            `).run(now(), now(), fromEndpointId, messageId);
            res = { operationId, action, state: "discarded", messageId, revision: r.revision + 1 };
          } else {
            throw coded("invalid_action", `Action ${action} is invalid for phase ${r.phase}`);
          }
        } else {
          throw coded("invalid_phase", `Cannot resolve record in phase ${r.phase}`);
        }

        db.prepare("INSERT INTO operations(operation_id, sender, message_id, action, result, created_at) VALUES(?, ?, ?, ?, ?, ?)")
          .run(operationId, fromEndpointId, messageId, action, JSON.stringify(res), now());
        db.exec("COMMIT");
        return res;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    },

    async start({ runLoop = true, signal, pollIntervalMs = defaultPollIntervalMs, sleep: customSleep } = {}) {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      if (!runLoop) {
        return this.step({ signal });
      }
      loopController = new AbortController();
      const runSignal = signal
        ? AbortSignal.any([signal, loopController.signal])
        : loopController.signal;

      runningLoopPromise = (async () => {
        let consecutiveErrors = 0;
        while (!runSignal.aborted) {
          try {
            const res = await this.step({ signal: runSignal });
            consecutiveErrors = 0;
            if (res?.state === "idle" || res?.state === "journal_full" || res?.state === "held") {
              await delay(pollIntervalMs, runSignal, customSleep);
            }
          } catch (err) {
            if (runSignal.aborted || err?.name === "AbortError" || err?.code === "aborted") break;
            consecutiveErrors++;
            logger.error?.("triangle_peer_drain_step_failed", {
              profile,
              error: err.message,
              code: err.code,
            });
            if (
              err?.code === "engine_not_running" ||
              err?.code === "ipc_unavailable" ||
              err?.code === "ipc_disconnected" ||
              consecutiveErrors >= 3
            ) {
              throw err;
            }
            await delay(1000, runSignal, customSleep);
          }
        }
      })();

      return runningLoopPromise;
    },

    async stop() {
      loopController?.abort();
      if (runningLoopPromise) {
        try {
          await runningLoopPromise;
        } catch {}
      }
    },

    status() {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      const count = db.prepare("SELECT COUNT(*) as c FROM records").get().c;
      const records = db
        .prepare(
          "SELECT sender, message_id, phase, reason, reply_id, updated_at, application_consumed FROM records ORDER BY updated_at",
        )
        .all();
      return Object.assign(records, {
        journalFull: count >= MAX_RECORDS_CAP,
        totalRecords: count,
      });
    },

    async sendRequest({
      toEndpointId,
      text,
      requestId,
      messageId,
      signal,
    } = {}) {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      signal?.throwIfAborted();

      if (!isEndpoint(toEndpointId)) {
        throw coded("invalid_identity", "Invalid toEndpointId");
      }
      if (!isText(text)) {
        throw coded("invalid_text", "Invalid or oversized text for peer request");
      }
      if (requestId !== undefined && requestId !== null && !isIdentifier(requestId)) {
        throw coded("invalid_identifier", "Invalid requestId");
      }
      if (messageId !== undefined && messageId !== null && !isIdentifier(messageId)) {
        throw coded("invalid_identifier", "Invalid messageId");
      }

      const resolvedRequestId = (requestId !== undefined && requestId !== null)
        ? requestId
        : randomUUID();
      const resolvedMessageId = (messageId !== undefined && messageId !== null)
        ? messageId
        : randomUUID();

      const route = routesMap.get(toEndpointId);
      if (!route || route.id !== toEndpointId) {
        throw attachOutboundContext(
          coded("route_unavailable", `No dialable route known for peer ${toEndpointId}`),
          { messageId: resolvedMessageId, requestId: resolvedRequestId, toEndpointId },
        );
      }

      const requestPayload = JSON.stringify({
        protocol: PEER_ENVELOPE_PROTOCOL,
        kind: "request",
        request_id: resolvedRequestId,
        text,
      });

      const sizeCheck = checkPayloadAndFrame(requestPayload, {
        messageId: resolvedMessageId,
        senderEndpointId: toEndpointId,
        createdAtUnixMs: now(),
      });
      if (!sizeCheck.ok) {
        throw attachOutboundContext(
          coded("invalid_params", sizeCheck.error),
          { messageId: resolvedMessageId, requestId: resolvedRequestId, toEndpointId },
        );
      }

      const payloadHash = digest(requestPayload);

      const existingOutbound = db.prepare("SELECT * FROM outbound WHERE message_id=?").get(resolvedMessageId);
      if (existingOutbound) {
        if (existingOutbound.to_endpoint_id !== toEndpointId || existingOutbound.payload_hash !== payloadHash) {
          throw attachOutboundContext(
            coded("conflict", "Message ID reused with different recipient or payload"),
            { messageId: resolvedMessageId, requestId: resolvedRequestId, toEndpointId },
          );
        }
        if (existingOutbound.closed_at !== null) {
          throw attachOutboundContext(
            coded("correlation_closed", "Outbound correlation is already closed"),
            { messageId: resolvedMessageId, requestId: resolvedRequestId, toEndpointId },
          );
        }
        const anchorTime = existingOutbound.terminal_at ?? existingOutbound.created_at;
        if (now() - anchorTime > TOMBSTONE_WINDOW_MS) {
          throw attachOutboundContext(
            coded("retry_window_expired", "Transport idempotency window has expired for this message ID"),
            { messageId: resolvedMessageId, requestId: resolvedRequestId, toEndpointId },
          );
        }
      } else {
        db.prepare(`
          INSERT INTO outbound(message_id, to_endpoint_id, request_id, payload_hash, state, created_at, updated_at)
          VALUES(?, ?, ?, ?, 'pending', ?, ?)
        `).run(resolvedMessageId, toEndpointId, resolvedRequestId, payloadHash, now(), now());
      }

      const client = resolveIpc();
      let sendError = null;
      try {
        await client.request(
          "send",
          { message_id: resolvedMessageId, payload: requestPayload, peer_addr: route },
          { signal },
        );
      } catch (err) {
        sendError = err;
      }

      if (signal?.aborted) {
        const err = signal.reason ?? Object.assign(new Error("Peer request aborted"), { name: "AbortError", code: "aborted" });
        throw attachOutboundContext(err, {
          messageId: resolvedMessageId,
          requestId: resolvedRequestId,
          toEndpointId,
        });
      }

      if (sendError?.code === "outbox_full") {
        throw attachOutboundContext(
          coded("outbox_full", "Peer engine outbox full"),
          { messageId: resolvedMessageId, requestId: resolvedRequestId, toEndpointId },
        );
      }
      if (sendError?.code === "conflict" || sendError?.code === "invalid_params") {
        db.prepare("UPDATE outbound SET state=?, updated_at=? WHERE message_id=?")
          .run(sendError.code, now(), resolvedMessageId);
        throw attachOutboundContext(
          coded(sendError.code, sendError.message),
          { messageId: resolvedMessageId, requestId: resolvedRequestId, toEndpointId },
        );
      }

      let status;
      try {
        status = await client.request(
          "message_status",
          { message_id: resolvedMessageId },
          { signal },
        );
      } catch (statusErr) {
        if (signal?.aborted || statusErr?.name === "AbortError" || statusErr?.code === "aborted") {
          const err = signal?.reason ?? statusErr ?? Object.assign(new Error("Peer request aborted"), { name: "AbortError", code: "aborted" });
          throw attachOutboundContext(err, {
            messageId: resolvedMessageId,
            requestId: resolvedRequestId,
            toEndpointId,
          });
        }
        const code = "admission_unresolved";
        const err = coded(code, statusErr?.message ? `Could not verify outbound request admission: ${statusErr.message}` : "Could not verify outbound request admission");
        if (sendError) err.cause = sendError;
        throw attachOutboundContext(err, {
          messageId: resolvedMessageId,
          requestId: resolvedRequestId,
          toEndpointId,
        });
      }

      if (
        !status ||
        status.message_id !== resolvedMessageId ||
        status.peer_endpoint_id !== toEndpointId ||
        status.payload_hash !== payloadHash
      ) {
        throw attachOutboundContext(
          coded("admission_unverified", "Outbound request admission mismatch"),
          { messageId: resolvedMessageId, requestId: resolvedRequestId, toEndpointId },
        );
      }

      if (status.state === "refused" || status.state === "expired") {
        db.prepare("UPDATE outbound SET state=?, terminal_at=?, updated_at=? WHERE message_id=?")
          .run(status.state, now(), now(), resolvedMessageId);
        const err = coded(status.state, status.reason || `Outbound request ${status.state}`);
        err.state = status.state;
        throw attachOutboundContext(err, {
          messageId: resolvedMessageId,
          requestId: resolvedRequestId,
          toEndpointId,
        });
      }

      if (!["queued_local", "settled"].includes(status.state)) {
        throw attachOutboundContext(
          coded("admission_unverified", `Unexpected message status: ${status.state}`),
          { messageId: resolvedMessageId, requestId: resolvedRequestId, toEndpointId },
        );
      }

      db.prepare("UPDATE outbound SET state=?, updated_at=? WHERE message_id=?")
        .run(status.state, now(), resolvedMessageId);

      return {
        messageId: resolvedMessageId,
        requestId: resolvedRequestId,
        toEndpointId,
        state: status.state,
        settled: status.state === "settled",
        attempts: Number.isSafeInteger(status.attempts) ? status.attempts : 0,
      };
    },

    close() {
      if (active) throw coded("drain_busy", "Cannot close drain while step is active");
      if (closed) return;
      closed = true;
      activeExecutions.clear();
      loopController?.abort();
      try {
        db.close();
      } catch {}
      try {
        lock.exec("ROLLBACK");
        lock.close();
      } catch {}
      activeStateRoots.delete(stateRoot);
    },
  };

  return Object.freeze(api);
}
