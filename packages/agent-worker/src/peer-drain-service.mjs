import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
} from "node:fs";
import { assertSafeStateRoot } from "./peer-engine-manager.mjs";

export const PEER_ENVELOPE_PROTOCOL = "triangle.peer/1";
const MAX_TEXT_BYTES = 32768;
const MAX_ENVELOPE_BYTES = MAX_TEXT_BYTES * 6 + 1024;

const digest = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const coded = (code, message = code) =>
  Object.assign(new Error(message === code ? code : `${code}: ${message}`), { code });
const attachOutboundContext = (err, { messageId, requestId, toEndpointId } = {}) => {
  if (err && typeof err === "object") {
    if (messageId !== undefined) err.messageId = messageId;
    if (requestId !== undefined) err.requestId = requestId;
    if (toEndpointId !== undefined) err.toEndpointId = toEndpointId;
  }
  return err;
};

const isEndpoint = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const isIdentifier = (s) => typeof s === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(s);
const isText = (s) =>
  typeof s === "string" && s.trim().length > 0 && Buffer.byteLength(s) <= MAX_TEXT_BYTES;

function privateFile(file) {
  const s = lstatSync(file, { throwIfNoEntry: false });
  if (
    s &&
    (!s.isFile() ||
      s.isSymbolicLink() ||
      (typeof process.getuid === "function" && s.uid !== process.getuid()) ||
      (s.mode & 0o077) !== 0)
  ) {
    throw coded("unsafe_file", `Unsafe file permissions or symlink for ${file}`);
  }
}

export function parsePeerEnvelope(payload) {
  if (typeof payload !== "string" || Buffer.byteLength(payload) > MAX_ENVELOPE_BYTES) {
    throw coded("invalid_envelope", "Payload exceeds maximum envelope size or is not a string");
  }
  let e;
  try {
    e = JSON.parse(payload);
  } catch {
    throw coded("invalid_envelope", "Payload is not valid JSON");
  }
  if (
    !e ||
    Array.isArray(e) ||
    e.protocol !== PEER_ENVELOPE_PROTOCOL ||
    !isIdentifier(e.request_id) ||
    !isText(e.text)
  ) {
    throw coded("invalid_envelope", "Envelope has invalid structure or fields");
  }
  const keys =
    e.kind === "request"
      ? ["protocol", "kind", "request_id", "text"]
      : e.kind === "reply"
        ? ["protocol", "kind", "request_id", "in_reply_to", "text"]
        : [];
  if (
    Object.keys(e).sort().join() !== keys.sort().join() ||
    (e.kind === "reply" && !isIdentifier(e.in_reply_to))
  ) {
    throw coded("invalid_envelope", "Envelope has unrecognized or missing keys");
  }
  return e;
}

export function derivePeerReplyId(senderEndpointId, messageId) {
  if (!isEndpoint(senderEndpointId) || !isIdentifier(messageId)) {
    throw coded("invalid_identity", "Invalid sender endpoint ID or message ID for reply ID derivation");
  }
  return "peer-reply-" + digest(`triangle-peer-reply-v1\0${senderEndpointId}\0${messageId}`);
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

  assertSafeStateRoot(stateRoot, { create: true });
  if (activeStateRoots.has(stateRoot)) {
    throw coded("drain_busy", "Another peer drain service is active on this state directory");
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
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records(sender TEXT NOT NULL, message_id TEXT NOT NULL, input_hash TEXT NOT NULL, phase TEXT NOT NULL, reply_id TEXT, reply_payload TEXT, updated_at INTEGER NOT NULL, application_consumed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sender, message_id));",
    );
    if (
      !db
        .prepare("PRAGMA table_info(records)")
        .all()
        .some((column) => column.name === "application_consumed")
    ) {
      db.exec(
        "ALTER TABLE records ADD COLUMN application_consumed INTEGER NOT NULL DEFAULT 0",
      );
    }
    chmodSync(path.join(stateRoot, "peer-drain.sqlite"), 0o600);

    // INVARIANT 6: If execution was in progress when process died, inference outcome is unknown.
    // Quarantine and require explicit recovery; NEVER rerun automatically.
    const quarantined = db
      .prepare("UPDATE records SET phase='quarantined', updated_at=? WHERE phase='executing'")
      .run(now());
    if (quarantined.changes > 0) {
      logger.warn?.("triangle_peer_drain_quarantined_on_recovery", {
        profile,
        profileInstanceId,
        count: quarantined.changes,
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
      text = envelope.text;
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

  const pendingReplyRows = () =>
    db
      .prepare(
        "SELECT * FROM records WHERE reply_id IS NULL AND reply_payload IS NOT NULL AND application_consumed=0 ORDER BY updated_at, sender, message_id LIMIT 200",
      )
      .all();

  async function ackItem(r, signal) {
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
    updatePhase(r, "acked");
    return { state: "acked", messageId: r.message_id, replyId: r.reply_id };
  }

  async function acknowledgeReply(r, signal) {
    const ackRes = await ackItem(r, signal);
    await hook?.("reply_acked");
    return r.application_consumed
      ? ackRes
      : replyView(r);
  }

  async function deliverReply(r, signal) {
    const route = routes instanceof Map ? routes.get(r.sender) : routes?.[r.sender];
    if (!route || route.id !== r.sender) {
      throw coded("route_unavailable", `No dialable route known for peer ${r.sender}`);
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
    let status;
    try {
      status = await client.request("message_status", { message_id: r.reply_id }, { signal });
    } catch {
      throw coded(
        sendError?.code === "outbox_full" ? "outbox_full" : "admission_unresolved",
        "Could not verify outbound reply admission",
      );
    }

    // INVARIANT 6: ACK only after send + message_status verifies durable outbound
    // queued_local or settled state and matching peer/hash.
    if (
      status?.message_id !== r.reply_id ||
      status.peer_endpoint_id !== r.sender ||
      status.payload_hash !== digest(r.reply_payload) ||
      !["queued_local", "settled"].includes(status.state)
    ) {
      throw coded("admission_unverified", "Outbound reply admission could not be verified");
    }

    updatePhase(r, "admitted");
    await hook?.("admitted");

    return ackItem(r, signal);
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

        // 1. Recover unacknowledged received replies before consuming new inputs.
        const unackedReply = db
          .prepare(
            "SELECT * FROM records WHERE phase='received_reply' ORDER BY updated_at LIMIT 1",
          )
          .get();
        if (unackedReply) {
          return await acknowledgeReply(unackedReply, signal);
        }

        // 2. Deliver any persisted outbound replies before consuming new inputs.
        const outstanding = db
          .prepare(
            "SELECT * FROM records WHERE phase IN ('result', 'admitted') ORDER BY updated_at LIMIT 1",
          )
          .get();
        if (outstanding) {
          return await deliverReply(outstanding, signal);
        }

        // 2. Poll inbox for next unconsumed message.
        const client = resolveIpc();
        const page = await client.request("inbox", { after_seq: 0, limit: 1 }, { signal });
        if (!page || !Array.isArray(page.items) || page.items.length > 1) {
          throw coded("invalid_inbox", "Malformed inbox response from peer engine");
        }
        if (!page.items.length) {
          return { state: "idle" };
        }

        const item = page.items[0];
        if (
          !isEndpoint(item.from_endpoint_id) ||
          !isIdentifier(item.message_id) ||
          typeof item.payload !== "string" ||
          Buffer.byteLength(item.payload) > MAX_ENVELOPE_BYTES ||
          item.payload_hash !== digest(item.payload)
        ) {
          throw coded("invalid_inbox", "Invalid inbox item fields or checksum");
        }

        const envelope = parsePeerEnvelope(item.payload);
        let r = getRow(item.from_endpoint_id, item.message_id);

        if (r && r.input_hash !== item.payload_hash) {
          throw coded("input_conflict", "Message ID reused with different payload");
        }

        if (r) {
          if (r.phase === "quarantined") {
            return { state: "quarantined", messageId: r.message_id };
          }
          if (r.phase === "acked") {
            return await ackItem(r, signal);
          }
          if (r.phase === "received_reply") {
            return await acknowledgeReply(r, signal);
          }
          return await deliverReply(r, signal);
        }

        if (envelope.kind === "reply") {
          db.prepare(
            "INSERT INTO records(sender, message_id, input_hash, phase, reply_payload, updated_at, application_consumed) VALUES(?, ?, ?, 'received_reply', ?, ?, 0)",
          ).run(item.from_endpoint_id, item.message_id, item.payload_hash, item.payload, now());
          r = getRow(item.from_endpoint_id, item.message_id);
          return await acknowledgeReply(r, signal);
        }

        // Validate route exists for sender before executing
        const route = routes instanceof Map ? routes.get(item.from_endpoint_id) : routes?.[item.from_endpoint_id];
        if (!route || route.id !== item.from_endpoint_id) {
          throw coded("route_unavailable", `No dialable route known for peer ${item.from_endpoint_id}`);
        }

        // INVARIANT 6: Persist execution admission before invoking runner.
        db.prepare(
          "INSERT INTO records(sender, message_id, input_hash, phase, updated_at) VALUES(?, ?, ?, 'executing', ?)",
        ).run(item.from_endpoint_id, item.message_id, item.payload_hash, now());
        r = getRow(item.from_endpoint_id, item.message_id);
        await hook?.("executing");

        let result;
        let timeout;
        const cancellation = new AbortController();
        const runnerSignal = signal
          ? AbortSignal.any([signal, cancellation.signal])
          : cancellation.signal;
        let onAbort;

        try {
          runnerSignal.throwIfAborted();
          const interrupted = new Promise((_, reject) => {
            onAbort = () => reject(coded("runner_interrupted", "Runner was interrupted"));
            runnerSignal.addEventListener("abort", onAbort, { once: true });
          });
          timeout = setTimeout(() => cancellation.abort(), runnerTimeoutMs);

          const runnerRequest = {
            text: envelope.text,
            senderId: item.from_endpoint_id,
            contextId: envelope.request_id,
            requestId: envelope.request_id,
          };

          result = await Promise.race([
            runner.run(runnerRequest, { signal: runnerSignal }),
            interrupted,
          ]);

          runnerSignal.throwIfAborted();
          if (result?.status !== "completed" || !isText(result.text)) {
            throw coded("invalid_runner_result", "Runner did not return a valid completed result");
          }
        } catch {
          // If runner failed or timed out: quarantine and do NOT retry automatically
          updatePhase(r, "quarantined");
          return { state: "quarantined", messageId: r.message_id };
        } finally {
          clearTimeout(timeout);
          if (onAbort) runnerSignal.removeEventListener("abort", onAbort);
          cancellation.abort();
        }

        // Derive deterministic reply ID and payload
        const replyId = derivePeerReplyId(r.sender, r.message_id);
        const replyPayload = JSON.stringify({
          protocol: envelope.protocol,
          kind: "reply",
          request_id: envelope.request_id,
          in_reply_to: r.message_id,
          text: result.text,
        });

        // Persist deterministic reply before sending
        db.prepare(
          "UPDATE records SET phase='result', reply_id=?, reply_payload=?, updated_at=? WHERE sender=? AND message_id=?",
        ).run(replyId, replyPayload, now(), r.sender, r.message_id);
        await hook?.("result");

        return await deliverReply(getRow(r.sender, r.message_id), signal);
      } finally {
        active = false;
      }
    },

    /**
     * Retrieve pending received replies stored durably in SQLite.
     * Guaranteed to persist across ack and process restarts until consumed.
     * Optionally filtered by inReplyTo and/or requestId.
     * Returns Array<{ state: "reply_received", fromEndpointId, messageId, text, envelope, replyPayload, updatedAt }>.
     */
    pendingReplies({ inReplyTo, requestId } = {}) {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      let replies = pendingReplyRows().map(replyView);
      if (inReplyTo !== undefined) {
        replies = replies.filter((reply) => reply.envelope?.in_reply_to === inReplyTo);
      }
      if (requestId !== undefined) {
        replies = replies.filter((reply) => reply.envelope?.request_id === requestId);
      }
      return replies;
    },

    getPendingReplies(options) {
      return this.pendingReplies(options);
    },

    /**
     * Mark a received reply as consumed by the application/profile.
     * Consumed replies no longer appear in pendingReplies().
     */
    consumeReply({ fromEndpointId, messageId } = {}) {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      if (active) throw coded("drain_busy", "Cannot consume reply while step is active");
      if (!isEndpoint(fromEndpointId) || !isIdentifier(messageId)) {
        throw coded("invalid_identity", "Invalid fromEndpointId or messageId");
      }
      const r = getRow(fromEndpointId, messageId);
      if (
        !r ||
        r.reply_id !== null ||
        !r.reply_payload ||
        parsePeerEnvelope(r.reply_payload).kind !== "reply"
      ) {
        throw coded("reply_not_found", "No received reply found for endpoint and messageId");
      }
      db.prepare(
        "UPDATE records SET application_consumed=1, updated_at=? WHERE sender=? AND message_id=?",
      ).run(now(), fromEndpointId, messageId);
      return { consumed: true };
    },

    async start({ runLoop = true, signal, pollIntervalMs = 500 } = {}) {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      if (!runLoop) {
        return this.step({ signal });
      }
      loopController = new AbortController();
      const runSignal = signal
        ? AbortSignal.any([signal, loopController.signal])
        : loopController.signal;
      let consecutiveErrors = 0;
      while (!runSignal.aborted) {
        try {
          const res = await this.step({ signal: runSignal });
          consecutiveErrors = 0;
          if (res?.state === "idle") {
            await new Promise((resolve) => {
              const t = setTimeout(resolve, pollIntervalMs);
              runSignal.addEventListener("abort", () => clearTimeout(t), { once: true });
            });
          }
        } catch (err) {
          if (runSignal.aborted || err?.name === "AbortError") break;
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
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    },

    async stop() {
      loopController?.abort();
    },

    status() {
      if (closed) throw coded("drain_closed", "Peer drain service is closed");
      return db
        .prepare(
          "SELECT sender, message_id, phase, reply_id, updated_at, application_consumed FROM records ORDER BY updated_at",
        )
        .all();
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

      const route = routes instanceof Map ? routes.get(toEndpointId) : routes?.[toEndpointId];
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
      const payloadHash = digest(requestPayload);

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
        const code = sendError?.code === "outbox_full"
          ? "outbox_full"
          : sendError?.code === "conflict"
            ? "conflict"
            : "admission_unresolved";
        const err = coded(
          code,
          statusErr?.message
            ? `Could not verify outbound request admission: ${statusErr.message}`
            : "Could not verify outbound request admission",
        );
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
        status.payload_hash !== payloadHash ||
        !["queued_local", "settled"].includes(status.state)
      ) {
        let code = "admission_unverified";
        let message = "Outbound request admission could not be verified";
        if (status?.state === "refused") {
          code = "refused";
          message = status.reason || "Outbound request refused by peer";
        } else if (status?.state === "expired") {
          code = "expired";
          message = status.reason || "Outbound request expired";
        } else if (status && status.message_id !== resolvedMessageId) {
          message = `Status message ID mismatch: expected ${resolvedMessageId}, got ${status.message_id}`;
        } else if (status && status.peer_endpoint_id !== toEndpointId) {
          message = `Status peer endpoint ID mismatch: expected ${toEndpointId}, got ${status.peer_endpoint_id}`;
        } else if (status && status.payload_hash !== payloadHash) {
          message = `Status payload hash mismatch: expected ${payloadHash}, got ${status.payload_hash}`;
        }
        const err = coded(code, message);
        if (status?.state) err.state = status.state;
        throw attachOutboundContext(err, {
          messageId: resolvedMessageId,
          requestId: resolvedRequestId,
          toEndpointId,
        });
      }

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
