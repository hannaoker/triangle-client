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

export function createLocalControlServer({
  socketPath,
  journal,
  acl,
  credentialValidator,
  rateLimiter,
  loopTracker,
  dispatcher,
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

  if (
    !(typeof activeDispatcher.start === "function" || typeof activeDispatcher.recover === "function") ||
    !(typeof activeDispatcher.stop === "function" || typeof activeDispatcher.wait === "function")
  ) {
    throw coded("invalid_dispatcher", "Dispatcher requires recovery and shutdown hooks");
  }

  const dispatchHook =
    activeDispatcher.notifyAdmission ||
    activeDispatcher.admitExecution ||
    activeDispatcher.dispatch;
  if (typeof dispatchHook !== "function") {
    throw coded(
      "invalid_dispatcher",
      "Dispatcher must implement notifyAdmission, admitExecution, or dispatch hook",
    );
  }

  let server = null;
  let boundInode = null;
  const activeSockets = new Set();
  const inFlightExecutions = new Set();
  const inFlightRpcs = new Set();
  let isClosing = false;
  let accepting = false;
  let dispatcherActive = false;

  async function handleRpc(msg, socket, socketInFlight) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      try {
        const errResp = createErrorResponse(null, coded("invalid_request", "Malformed JSON-RPC request object"));
        socket.write(encodeFrame(errResp));
      } catch {}
      return;
    }

    const { id, method, params = {}, credential, senderId } = msg;
    if (typeof id === "undefined") return; // Notifications ignored per spec

    if (socketInFlight.size >= MAX_INFLIGHT_PER_SOCKET) {
      const errResp = createErrorResponse(
        id,
        coded("too_many_requests", "Too many concurrent requests on this connection"),
        msg.protocol_version || PROTOCOL_VERSION,
      );
      try {
        socket.write(encodeFrame(errResp));
      } catch {}
      return;
    }

    socketInFlight.add(id);

    try {
      if (msg.protocol_version !== PROTOCOL_VERSION) {
        throw coded("protocol_version_mismatch", `Expected protocol version ${PROTOCOL_VERSION}`);
      }

      // Methods requiring authentication (all except hello)
      let claims = null;
      if (method !== "hello") {
        if (!senderId || typeof senderId !== "string" || !senderId.trim()) {
          throw coded("unauthorized", "senderId is required");
        }
        claims = credentialValidator.validate({ credential, expectedSenderId: senderId.trim() });
      }

      switch (method) {
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
          const { to, text, messageId, requestId, inReplyTo, metadata = {} } = params;
          if (!to || !text || !messageId) {
            throw coded("invalid_request", "to, text, and messageId are required for send_message");
          }

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

          try {
            // 4. Conversation loop depth calculation and check
            const effectiveRequestId = requestId || messageId;
            let calculatedDepth = 1;
            if (loopTracker) {
              calculatedDepth = await loopTracker.calculateDepth({
                claims,
                inReplyTo,
                messageId,
                requestId: effectiveRequestId,
              });
            }

            // 5. Record to durable shared journal
            const record = await journal.recordSend({
              sender: senderId,
              recipient: to,
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

            const execPromise = (async () => {
              try {
                await dispatchHook.call(activeDispatcher, admissionJob);
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
            throw admissionErr;
          }
          break;
        }

        case "get_message_status": {
          const { messageId } = params;
          if (!messageId) throw coded("invalid_request", "messageId required");

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
            },
            PROTOCOL_VERSION,
          );
          socket.write(encodeFrame(resp));
          break;
        }

        case "list_replies": {
          const { requestId, inReplyTo, limit = 50 } = params;
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
          const outcome = await journal.consumeReply({
            requester: senderId,
            messageId,
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

        default:
          throw coded("method_not_found", `Unknown method: ${method}`);
      }
    } catch (err) {
      const errResp = createErrorResponse(id, err, msg?.protocol_version || PROTOCOL_VERSION);
      try {
        socket.write(encodeFrame(errResp));
      } catch {}
    } finally {
      socketInFlight.delete(id);
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
          const socketInFlight = new Set();

          const parser = createMessageParser({
            onMessage: (msg) => {
              if (isClosing) return;
              const rpc = handleRpc(msg, socket, socketInFlight);
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
        if (typeof activeDispatcher.start === "function") {
          await activeDispatcher.start({ journal });
        } else if (typeof activeDispatcher.recover === "function") {
          await activeDispatcher.recover({ journal });
        }
        accepting = true;
      } catch (startupErr) {
        accepting = false;
        for (const socket of activeSockets) socket.destroy();
        activeSockets.clear();
        if (dispatcherActive) {
          try {
            const shutdown = activeDispatcher.stop || activeDispatcher.wait;
            await shutdown.call(activeDispatcher);
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
        const shutdown = activeDispatcher.stop || activeDispatcher.wait;
        await shutdown.call(activeDispatcher);
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
