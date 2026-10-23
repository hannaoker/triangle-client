import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import {
  validatePrivateDirectory,
  validatePrivateSocket,
  cleanupStaleSocket,
  getSocketInode,
} from "./local-messaging-address.mjs";
import {
  encodeFrame,
  createMessageParser,
  createSuccessResponse,
  createErrorResponse,
  boundRepliesToEnvelope,
  PROTOCOL_VERSION,
  MAX_FIELD_STRING_LENGTH,
} from "./local-messaging-protocol.mjs";
import { coded, sanitizeError } from "./local-messaging-errors.mjs";

const MAX_INFLIGHT_PER_SOCKET = 50;
const MAX_REQUEST_ID_LENGTH = 128;
// Message, request and recipient identifiers: UUIDs, rep-<uuid> reply IDs and 64-hex instance IDs all match.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

function identifier(value, name, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw coded("invalid_request", `${name} must be a bounded identifier string`);
  }
  return value;
}

export function createLocalControlServer({
  socketPath,
  journal,
  acl,
  credentialValidator,
  credentialBroker = null,
  interactiveBroker = null,
  interactiveRecipients = null,
  statusProvider = null,
  recipientDirectory = [],
  discoveryBroker = null,
  rateLimiter,
  exchangeLimiter = null,
  loopTracker,
  dispatcher,
  notifier = null,
  logger = { info() {}, warn() {}, error() {} },
} = {}) {
  if (!socketPath || typeof socketPath !== "string") {
    throw coded("invalid_options", "socketPath is required");
  }

  if (!journal) {
    throw coded("invalid_options", "journal is required");
  }

  // Server strictly requires credentialValidator and ACL (no auth-optional fallback)
  if (!credentialValidator || typeof credentialValidator.validate !== "function") {
    throw coded("invalid_options", "credentialValidator is required and must implement validate");
  }

  if (!acl || typeof acl.checkAllowed !== "function") {
    throw coded("invalid_options", "acl is required and must implement checkAllowed");
  }

  // The host owns execution recovery and shutdown; no optional no-op adapter.
  const activeDispatcher = dispatcher;

  if (!activeDispatcher) {
    throw coded(
      "dispatcher_required",
      "Execution dispatcher is required. Missing explicit dispatch implementation.",
    );
  }

  for (const hook of ["start", "stop", "notifyAdmission"]) {
    if (typeof activeDispatcher[hook] !== "function") {
      throw coded("invalid_dispatcher", `Dispatcher must implement ${hook}`);
    }
  }

  // Owner-configured labels are display metadata, never routing or authority.
  if (!Array.isArray(recipientDirectory) || recipientDirectory.length > 256) {
    throw coded("invalid_options", "Recipient directory must be a bounded array");
  }
  const directory = new Map();
  for (const entry of recipientDirectory) {
    identifier(entry?.id, "directory id");
    if (directory.has(entry.id) || typeof entry.label !== "string" ||
        entry.label.length < 1 || entry.label.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(entry.label) ||
        !["worker", "conversation"].includes(entry.kind)) {
      throw coded("invalid_options", "Invalid recipient directory entry");
    }
    directory.set(entry.id, { id: entry.id, label: entry.label, kind: entry.kind, presence: "unknown" });
  }

  let server = null;
  let boundInode = null;
  const activeSockets = new Set();
  const inFlightExecutions = new Set();
  const inFlightRpcs = new Set();
  let isClosing = false;
  let accepting = false;
  let dispatcherActive = false;

  async function handleRpc(msg, socket, connection) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      try {
        const errResp = createErrorResponse(null, coded("invalid_request", "Malformed JSON-RPC request object"));
        socket.write(encodeFrame(errResp));
      } catch {}
      return;
    }

    const { id, method, params = {}, credential, senderId: claimedSenderId } = msg;
    if (typeof id === "undefined") return; // Notifications ignored per spec

    const reject = (responseId, error) => {
      try {
        socket.write(encodeFrame(createErrorResponse(responseId, error, msg.protocol_version || PROTOCOL_VERSION)));
      } catch {}
    };

    const validId =
      (typeof id === "string" && id.length > 0 && id.length <= MAX_REQUEST_ID_LENGTH) ||
      (typeof id === "number" && Number.isFinite(id));
    if (!validId) {
      reject(null, coded("invalid_request", "Request id must be a bounded string or a number"));
      return;
    }
    // A reused id must not multiply in-flight work, so it is refused while its first use runs.
    if (connection.ids.has(id)) {
      reject(id, coded("invalid_request", "Request id is already in flight on this connection"));
      return;
    }
    if (connection.active >= MAX_INFLIGHT_PER_SOCKET) {
      reject(id, coded("too_many_requests", "Too many concurrent requests on this connection"));
      return;
    }

    connection.ids.add(id);
    connection.active += 1;

    try {
      if (msg.protocol_version !== PROTOCOL_VERSION) {
        throw coded("protocol_version_mismatch", `Expected protocol version ${PROTOCOL_VERSION}`);
      }
      if (params === null || typeof params !== "object" || Array.isArray(params)) {
        throw coded("invalid_request", "params must be an object");
      }

      // Methods requiring authentication (all except hello). Every decision below uses the
      // sender from the signed claims; the client's senderId is only an assertion that must match.
      let claims = null;
      let senderId = null;
      if (method !== "hello" && method !== "issue_turn" && method !== "exchange_session" && method !== "discovery_challenge" && method !== "discovery_report") {
        if (!claimedSenderId || typeof claimedSenderId !== "string" || !claimedSenderId.trim()) {
          throw coded("unauthorized", "senderId is required");
        }
        claims = credentialValidator.validate({ credential, expectedSenderId: claimedSenderId.trim() });
        senderId = claims.senderId;

        // Enforce expiry and active session/revocation on EVERY authenticated request
        if (claims.senderType === "interactive" || (interactiveBroker && interactiveBroker.isInteractiveSender(senderId))) {
          if (!interactiveBroker) {
            throw coded("unauthorized", "Interactive sessions are not supported or disabled");
          }
          interactiveBroker.validateRequest({ claims, senderId });
        }
      }

      switch (method) {
        case "discovery_challenge":
        case "discovery_report": {
          if(!discoveryBroker)throw coded("unsupported", "Session discovery is not enabled");
          const result=method==="discovery_challenge"
            ? discoveryBroker.challenge(params) : await discoveryBroker.report(params);
          socket.write(encodeFrame(createSuccessResponse(id,result)));
          break;
        }
        case "local_status": {
          if (claims?.senderType === "interactive" || (interactiveBroker && interactiveBroker.isInteractiveSender(senderId))) {
            const inbox = await journal.getInteractiveInboxCounts?.(senderId) ?? { queued: 0, executing: 0, held: 0 };
            const statusRes = {
              route: "same-device",
              senderId,
              sessionId: claims.sessionId,
              generation: claims.generation,
              inbox,
            };
            socket.write(encodeFrame(createSuccessResponse(id, statusRes)));
            break;
          }
          if (typeof statusProvider !== "function") throw coded("unsupported", "No local host status provider");
          socket.write(encodeFrame(createSuccessResponse(id, await statusProvider())));
          break;
        }
        case "exchange_session": {
          if (!interactiveBroker || typeof interactiveBroker.exchange !== "function") {
            throw coded("unsupported", "No interactive session broker configured");
          }
          const grant = await interactiveBroker.exchange(params);
          socket.write(encodeFrame(createSuccessResponse(id, grant)));
          break;
        }
        case "issue_turn": {
          if (typeof credentialBroker !== "function") throw coded("unsupported", "No desktop credential broker configured");
          const grant = await credentialBroker(params);
          socket.write(encodeFrame(createSuccessResponse(id, grant)));
          break;
        }
        case "hello": {
          const resp = createSuccessResponse(
            id,
            {
              server: "triangle-local-control",
              protocol_version: PROTOCOL_VERSION,
            },
            PROTOCOL_VERSION,
          );
          socket.write(encodeFrame(resp));
          break;
        }

        case "list_sessions": {
          let ids = acl.listAuthorizedRecipients(senderId);
          if (claims?.allowedRecipients) {
            const allowed = new Set(claims.allowedRecipients);
            ids = ids.filter(id => allowed.has(id));
          }
          // Filter before looking up metadata, so hidden names never leak.
          const sessions = ids.map(id => directory.get(id) ?? {
            id, label: id, kind: "unknown", presence: "unknown",
          });
          if(discoveryBroker){
            const discovered=await discoveryBroker.listFor(senderId);
            const known=new Set(sessions.map(entry=>entry.id));
            sessions.push(...discovered.filter(entry=>!known.has(entry.id)));
          }
          socket.write(encodeFrame(createSuccessResponse(id, { sessions }, PROTOCOL_VERSION)));
          break;
        }
        case "discover_recipients": {
          let recipients = acl.listAuthorizedRecipients(senderId);
          if (claims?.allowedRecipients) {
            const allowedSet = new Set(claims.allowedRecipients);
            recipients = recipients.filter((r) => allowedSet.has(r));
          }
          const resp = createSuccessResponse(id, { recipients }, PROTOCOL_VERSION);
          socket.write(encodeFrame(resp));
          break;
        }

        case "send_message": {
          const { to, text, messageId, metadata = {} } = params;
          if (!to || !text || !messageId) {
            throw coded("invalid_request", "to, text, and messageId are required for send_message");
          }
          identifier(to, "to");
          identifier(messageId, "messageId");
          const requestId = identifier(params.requestId, "requestId", { optional: true }) ?? undefined;
          const inReplyTo = identifier(params.inReplyTo, "inReplyTo", { optional: true }) ?? undefined;

          if (typeof text !== "string" || text.length > MAX_FIELD_STRING_LENGTH) {
            throw coded("payload_too_large", `Message text exceeds field limit of ${MAX_FIELD_STRING_LENGTH}`);
          }

          // 1. ACL check
          acl.checkAllowed(senderId, to);

          // 2. Turn claims recipient check (fail closed)
          if (claims?.allowedRecipients && !claims.allowedRecipients.includes(to)) {
            throw coded("recipient_not_allowed", `Recipient ${to} is not permitted by turn credential claims`);
          }

          // 3. Rate limiter check and reserve BEFORE first await
          let rateReservation = null;
          if (rateLimiter) {
            if (typeof rateLimiter.reserve === "function") {
              rateReservation = rateLimiter.reserve(senderId);
            } else {
              rateLimiter.check(senderId);
            }
          }

          // 4. Dedupe check & persisted loop depth before unique pair charge
          const existingRecord = await journal.getRecord(messageId);
          const effectiveRequestId = requestId || messageId;
          let calculatedDepth = 1;

          if (existingRecord) {
            calculatedDepth = existingRecord.loopDepth || existingRecord.metadata?._loopDepth || 1;
          } else {
            if (loopTracker) {
              calculatedDepth = await loopTracker.calculateDepth({
                claims,
                inReplyTo,
                messageId,
                requestId: effectiveRequestId,
              });
            }
          }

          let pairReservation = null;
          try {
            // Pair cap fallback only for injected test journals lacking durable pair limiter:
            // Do NOT charge for known duplicates!
            if (!journal.hasDurablePairLimiter && exchangeLimiter && !existingRecord) {
              pairReservation = exchangeLimiter.reserve(senderId, to);
            }

            // 5. Record to durable shared journal
            const recipientType = (interactiveRecipients && (typeof interactiveRecipients.has === "function" ? interactiveRecipients.has(to) : interactiveRecipients.includes(to)))
              ? "interactive"
              : "runner";

            const record = await journal.recordSend({
              sender: senderId,
              recipient: to,
              recipientType,
              messageId,
              requestId: effectiveRequestId,
              inReplyTo,
              text,
              metadata: {
                ...(metadata || {}),
                _loopDepth: calculatedDepth,
              },
            });

            // 6. Limits committed only AFTER successful admission
            if (rateReservation) {
              rateReservation.commit();
            } else if (rateLimiter) {
              rateLimiter.consume(senderId);
            }
            // A duplicate retry is not a new exchange.
            if (record.isDuplicate) pairReservation?.rollback();
            else pairReservation?.commit();

            if (loopTracker) {
              loopTracker.commitAdmission({
                messageId,
                requestId: effectiveRequestId,
                depth: calculatedDepth,
                isDuplicate: record.isDuplicate || false,
              });
            }

            // 7. Track execution via injected recoverable dispatcher
            // Dispatches admission; dispatcher owns deduping and avoiding concurrent overlap
            const admissionJob = {
              sender: senderId,
              recipient: to,
              messageId,
              requestId: record.requestId,
              inReplyTo,
              text,
              metadata,
              loopDepth: calculatedDepth,
              isDuplicate: record.isDuplicate || false,
            };

            // Defense in depth: a duplicate of work that is already claimed, finished or held
            // must never reach the dispatcher again, whatever the dispatcher would do with it.
            // Interactive recipients are claimed and executed by the interactive session, never the runner dispatcher.
            if (recipientType !== "interactive" && (!record.isDuplicate || (record.phase ?? "queued_local") === "queued_local")) {
              const execPromise = (async () => {
                try {
                  await activeDispatcher.notifyAdmission(admissionJob);
                } catch (execErr) {
                  const sanitized = sanitizeError(execErr);
                  logger.error?.(`Local execution admission failed: ${sanitized.message}`);
                  await journal.recordExecutionFailure({
                    messageId,
                    reason: "admission_failure",
                    runtimeError: "Execution admission failed",
                  }).catch(() => {});
                }
              })();

              inFlightExecutions.add(execPromise);
              execPromise.finally(() => inFlightExecutions.delete(execPromise));
            }

            // 8. Return custody receipt promptly carrying original stored requestId
            const resp = createSuccessResponse(
              id,
              {
                accepted: true,
                messageId: record.messageId,
                requestId: record.requestId,
                status: record.phase || "queued_local",
                isDuplicate: record.isDuplicate || false,
              },
              PROTOCOL_VERSION,
            );
            socket.write(encodeFrame(resp));
          } catch (admissionErr) {
            // Rollback reservation on rejected admission or conflict
            rateReservation?.rollback?.();
            pairReservation?.rollback();
            throw admissionErr;
          }
          break;
        }

        case "get_message_status": {
          const { messageId } = params;
          if (!messageId) throw coded("invalid_request", "messageId required");
          identifier(messageId, "messageId");

          const record = await journal.getRecord(messageId);
          if (!record) throw coded("not_found", `Message ${messageId} not found`);

          // Enforce requester ownership: disclosure permitted only to original sender or recipient
          if (record.sender !== senderId && record.recipient !== senderId) {
            throw coded("foreign_access_denied", "Requester is not authorized to access status for this message");
          }

          // Redact unknown or raw errors to fixed safe message; never disclose raw credential-bearing errors
          let safeRuntimeError = null;
          if (record.runtimeError) {
            safeRuntimeError = "Execution failure occurred";
          }

          const resp = createSuccessResponse(
            id,
            {
              messageId: record.messageId,
              phase: record.phase,
              reason: record.reason || null,
              runtimeError: safeRuntimeError,
              // Presence only: a result that arrived after a timeout is for the owner, not the sender.
              hasLateResult: record.hasLateResult === true,
            },
            PROTOCOL_VERSION,
          );
          socket.write(encodeFrame(resp));
          break;
        }

        case "list_replies": {
          const { limit = 50 } = params;
          const requestId = identifier(params.requestId, "requestId", { optional: true }) ?? undefined;
          const inReplyTo = identifier(params.inReplyTo, "inReplyTo", { optional: true }) ?? undefined;
          const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
          const replies = await journal.listReplies({
            requester: senderId,
            requestId,
            inReplyTo,
            limit: cappedLimit,
          });

          // Ensure reply list strictly fits within envelope limits
          const bounded = boundRepliesToEnvelope(replies);
          const resp = createSuccessResponse(id, { replies: bounded }, PROTOCOL_VERSION);
          socket.write(encodeFrame(resp));
          break;
        }

        case "consume_reply": {
          const { messageId } = params;
          if (!messageId) throw coded("invalid_request", "messageId required");
          identifier(messageId, "messageId");
          const outcome = await journal.consumeReply({
            requester: senderId,
            messageId,
          });
          const resp = createSuccessResponse(id, outcome, PROTOCOL_VERSION);
          socket.write(encodeFrame(resp));
          break;
        }

        case "ack_notification": {
          const { wakeId, generation } = params;
          if (!wakeId) throw coded("invalid_request", "wakeId required");
          identifier(wakeId, "wakeId");
          if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
            throw coded("invalid_request", "generation must be a safe integer >= 0");
          }

          let outcome;
          if (claims?.senderType === "interactive" || (interactiveBroker && interactiveBroker.isInteractiveSender(senderId))) {
            if (!claims?.sessionId || !claims?.bindingId || typeof claims?.generation !== "number" || !Number.isSafeInteger(claims.generation) || claims.generation < 1) {
              throw coded("unauthorized", "Interactive credential missing required session claims");
            }
            if (generation !== claims.generation) {
              throw coded("generation_fenced", "Ack generation does not match authenticated claims");
            }
            outcome = await journal.ackInteractiveWake({
              targetIdentity: senderId,
              wakeId,
              generation: claims.generation,
              sessionId: claims.sessionId,
              bindingId: claims.bindingId,
            });
          } else if (notifier && typeof notifier.ackNotification === "function") {
            outcome = await notifier.ackNotification({
              requester: senderId,
              wakeId,
              generation,
            });
          } else if (typeof journal.ackWake === "function") {
            outcome = await journal.ackWake({
              requester: senderId,
              wakeId,
              generation,
            });
          } else {
            throw coded("unsupported", "Wake notifications are not configured on this host");
          }

          const resp = createSuccessResponse(id, outcome, PROTOCOL_VERSION);
          socket.write(encodeFrame(resp));
          break;
        }

        case "reserve_wake_notification": {
          if (claims?.senderType !== "interactive" || !interactiveBroker?.isInteractiveSender(senderId)) {
            throw coded("unauthorized", "Interactive credential required for reserve_wake_notification");
          }
          if (!claims?.sessionId || !claims?.bindingId || typeof claims?.generation !== "number" || !Number.isSafeInteger(claims.generation) || claims.generation < 1) {
            throw coded("unauthorized", "Interactive credential missing required session claims");
          }
          const { reservationId } = params;
          if (!reservationId || typeof reservationId !== "string") {
            throw coded("invalid_request", "reservationId required");
          }
          identifier(reservationId, "reservationId");
          const outcome = await journal.reserveInteractiveWake({
            targetIdentity: senderId,
            reservationId,
            sessionId: claims.sessionId,
            generation: claims.generation,
            bindingId: claims.bindingId,
          });
          const resp = createSuccessResponse(id, outcome, PROTOCOL_VERSION);
          socket.write(encodeFrame(resp));
          break;
        }

        case "report_wake_result": {
          if (claims?.senderType !== "interactive" || !interactiveBroker?.isInteractiveSender(senderId)) {
            throw coded("unauthorized", "Interactive credential required for report_wake_result");
          }
          if (!claims?.sessionId || !claims?.bindingId || typeof claims?.generation !== "number" || !Number.isSafeInteger(claims.generation) || claims.generation < 1) {
            throw coded("unauthorized", "Interactive credential missing required session claims");
          }
          const { wakeId, generation, sessionId, bindingId, result } = params;
          if (!wakeId || typeof wakeId !== "string") {
            throw coded("invalid_request", "wakeId required");
          }
          identifier(wakeId, "wakeId");
          if (!result || typeof result !== "string" || !["accepted", "uncertain", "failed"].includes(result)) {
            throw coded("invalid_request", "result must be one of: accepted, uncertain, failed");
          }
          if (typeof generation !== "undefined") {
            if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
              throw coded("invalid_request", "generation must be a positive safe integer");
            }
            if (generation !== claims.generation) {
              throw coded("generation_fenced", "Supplied generation does not match authenticated claims");
            }
          }
          if (typeof sessionId !== "undefined" && sessionId !== claims.sessionId) {
            throw coded("session_fenced", "Supplied sessionId does not match authenticated claims");
          }
          if (typeof bindingId !== "undefined" && bindingId.toLowerCase() !== claims.bindingId.toLowerCase()) {
            throw coded("binding_changed", "Supplied bindingId does not match authenticated claims");
          }
          const outcome = await journal.reportInteractiveWakeResult({
            targetIdentity: senderId,
            wakeId,
            generation: claims.generation,
            sessionId: claims.sessionId,
            bindingId: claims.bindingId,
            result,
          });
          const resp = createSuccessResponse(id, outcome, PROTOCOL_VERSION);
          socket.write(encodeFrame(resp));
          break;
        }

        case "cancel_message": {
          const resp = createSuccessResponse(
            id,
            {
              status: "unsupported",
              message: "Cancellation is not supported for local route messages",
            },
            PROTOCOL_VERSION,
          );
          socket.write(encodeFrame(resp));
          break;
        }

        case "list_inbox": {
          const { limit = 50, cursor = null } = params;
          const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
          const result = await journal.listInbox({
            requester: senderId,
            limit: cappedLimit,
            cursor,
          });
          const resp = createSuccessResponse(id, { items: result.items, nextCursor: result.nextCursor ?? null }, PROTOCOL_VERSION);
          socket.write(encodeFrame(resp));
          break;
        }

        case "claim_inbox_message": {
          const { messageId, claimId } = params;
          if (!messageId) throw coded("invalid_request", "messageId required");
          if (!claimId) throw coded("invalid_request", "claimId required");
          identifier(messageId, "messageId");
          identifier(claimId, "claimId");
          const record = await journal.getRecord(messageId);
          if (record && record.recipient !== senderId) {
            throw coded("foreign_access_denied", "Only recipient may claim this message");
          }
          if (!claims?.sessionId || typeof claims?.generation !== "number") {
            throw coded("unauthorized", "Interactive session credential required");
          }
          const outcome = await journal.claimInboxMessage({
            messageId,
            claimId,
            requester: senderId,
            sessionId: claims.sessionId,
            generation: claims.generation,
            leaseDurationMs: 3600000,
          });
          if (!outcome) {
            throw coded("claim_failed", "Message is not available for claim");
          }
          const resp = createSuccessResponse(id, outcome, PROTOCOL_VERSION);
          socket.write(encodeFrame(resp));
          break;
        }

        case "send_reply": {
          const { messageId, claimToken, text, replyId, metadata = {} } = params;
          if (!messageId || !claimToken || typeof text !== "string") {
            throw coded("invalid_request", "messageId, claimToken, and text are required for send_reply");
          }
          identifier(messageId, "messageId");
          if (replyId) identifier(replyId, "replyId");
          if (text.length > MAX_FIELD_STRING_LENGTH) {
            throw coded("payload_too_large", `Reply text exceeds field limit of ${MAX_FIELD_STRING_LENGTH}`);
          }
          if (!claims?.sessionId || typeof claims?.generation !== "number") {
            throw coded("unauthorized", "Interactive session credential required");
          }
          const outcome = await journal.recordInteractiveReply({
            messageId,
            claimToken,
            sessionId: claims.sessionId,
            generation: claims.generation,
            requester: senderId,
            text,
            replyId,
            metadata,
          });
          notifier?.notifyObligationChange?.();
          const resp = createSuccessResponse(id, outcome, PROTOCOL_VERSION);
          socket.write(encodeFrame(resp));
          break;
        }

        default:
          throw coded("method_not_found", `Unknown method: ${method}`);
      }
    } catch (err) {
      const errResp = createErrorResponse(id, err, msg?.protocol_version || PROTOCOL_VERSION);
      try {
        socket.write(encodeFrame(errResp));
      } catch {}
    } finally {
      connection.ids.delete(id);
      connection.active -= 1;
    }
  }

  return {
    async start() {
      if (server) throw coded("already_started", "Server is already running");
      isClosing = false;

      const parentDir = path.dirname(socketPath);
      validatePrivateDirectory(parentDir, { create: true });
      await cleanupStaleSocket(socketPath);

      let createdServer = null;
      try {
        createdServer = net.createServer((socket) => {
          if (isClosing || !accepting) {
            socket.destroy();
            return;
          }
          activeSockets.add(socket);
          const connection = { ids: new Set(), active: 0 };

          const parser = createMessageParser({
            onMessage: (msg) => {
              if (isClosing) return;
              const rpc = handleRpc(msg, socket, connection);
              inFlightRpcs.add(rpc);
              const finish = () => inFlightRpcs.delete(rpc);
              rpc.then(finish, finish);
            },
            onError: (err) => {
              const sanitized = sanitizeError(err);
              logger.warn?.(`Socket parser error: ${sanitized.message}`);
              // Send actionable error response if socket is still writable
              try {
                socket.write(encodeFrame(createErrorResponse(null, err)));
              } catch {}
              socket.destroy();
            },
          });

          socket.on("data", (chunk) => parser.feed(chunk));
          socket.on("error", () => activeSockets.delete(socket));
          socket.on("close", () => activeSockets.delete(socket));
        });

        await new Promise((resolve, reject) => {
          createdServer.listen(socketPath, () => {
            if (process.platform !== "win32") {
              try {
                fs.chmodSync(socketPath, 0o600);
              } catch (chmodErr) {
                reject(chmodErr);
                return;
              }
            }
            resolve();
          });
          createdServer.on("error", reject);
        });

        if (process.platform !== "win32") {
          validatePrivateSocket(socketPath);
        }

        server = createdServer;
        boundInode = getSocketInode(socketPath);

        // No requests are accepted until recovery has established execution ownership.
        dispatcherActive = true;
        // Host-owned recoverable dispatcher claims queued records upon start
        await activeDispatcher.start({ journal });
        accepting = true;
      } catch (startupErr) {
        accepting = false;
        for (const socket of activeSockets) socket.destroy();
        activeSockets.clear();
        if (dispatcherActive) {
          try {
            await activeDispatcher.stop();
          } catch {}
          dispatcherActive = false;
        }
        server = null;
        boundInode = null;
        // Rollback on startup failure without unlinking another server's socket
        if (createdServer) {
          try {
            await new Promise((res) => createdServer.close(res));
          } catch {}
        }
        throw startupErr;
      }
    },

    async close() {
      isClosing = true;
      accepting = false;
      for (const sock of activeSockets) {
        try {
          sock.destroy();
        } catch {}
      }
      activeSockets.clear();

      if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
      }

      // A socket disconnect does not cancel an admitted RPC or its journal write.
      // Finish those writes/notifications before stopping their execution owner.
      while (inFlightRpcs.size > 0) {
        await Promise.allSettled(Array.from(inFlightRpcs));
      }

      // Safely wait for dispatcher to complete active executions before closing journal
      if (dispatcherActive) {
        await activeDispatcher.stop();
        dispatcherActive = false;
      }

      // Safely wait for all in-flight admissions before releasing resources
      if (inFlightExecutions.size > 0) {
        await Promise.allSettled(Array.from(inFlightExecutions));
        inFlightExecutions.clear();
      }

      // ONLY unlink the socket if it is the exact inode bound by THIS server
      if (boundInode && process.platform !== "win32") {
        const currentInode = getSocketInode(socketPath);
        if (
          currentInode &&
          currentInode.ino === boundInode.ino &&
          currentInode.dev === boundInode.dev
        ) {
          try {
            fs.unlinkSync(socketPath);
          } catch {}
        }
        boundInode = null;
      }
    },
  };
}
