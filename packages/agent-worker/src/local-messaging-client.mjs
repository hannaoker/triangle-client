import net from "node:net";
import crypto from "node:crypto";
import {
  encodeFrame,
  createMessageParser,
  PROTOCOL_VERSION,
} from "./local-messaging-protocol.mjs";
import { coded } from "./local-messaging-errors.mjs";

// Keeps only the { id, principal } of entries that name a listed recipient. Anything else the host sent, a repeated id
// and malformed entries are dropped. Returns undefined, not an empty list, when entries were absent or none were usable.
function projectRecipientEntries(recipients, entries) {
  if (!Array.isArray(entries)) return undefined;
  const listed = new Set(recipients);
  const seen = new Set();
  const projected = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const { id, principal } = entry;
    if (typeof id !== "string" || !listed.has(id) || seen.has(id)) continue;
    if (principal !== null && (typeof principal !== "string" || principal === "")) continue;
    seen.add(id);
    projected.push({ id, principal });
  }
  return projected.length === 0 && recipients.length > 0 ? undefined : projected;
}

export function createLocalControlClient({
  socketPath,
  turnCredential,
  senderId,
  timeoutMs = 30000,
  connectTimeoutMs = 5000,
}) {
  if (!socketPath || typeof socketPath !== "string") {
    throw coded("invalid_client_options", "socketPath is required");
  }

  let socket = null;
  const pendingRequests = new Map();
  let isClosed = false;
  let connectingPromise = null;
  let activeConnectingSocket = null;
  let activeConnectTimer = null;

  function ensureConnection(overrideTimeoutMs = null) {
    if (isClosed) throw coded("client_closed", "Client is closed");
    if (socket && !socket.destroyed && !socket.connecting) {
      return Promise.resolve(socket);
    }
    if (connectingPromise) return connectingPromise;

    const effectiveConnectTimeout = Math.min(
      typeof overrideTimeoutMs === "number" ? overrideTimeoutMs : connectTimeoutMs,
      timeoutMs,
    );

    connectingPromise = new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: socketPath });
      activeConnectingSocket = sock;

      const timer = setTimeout(() => {
        sock.destroy();
        if (connectingPromise) connectingPromise = null;
        activeConnectingSocket = null;
        reject(
          coded(
            "connection_timeout",
            `Connection to socket ${socketPath} timed out after ${effectiveConnectTimeout}ms`,
          ),
        );
      }, effectiveConnectTimeout);

      activeConnectTimer = timer;

      const parser = createMessageParser({
        onMessage: (msg) => {
          if (isClosed) return;
          const { id, result, error } = msg;
          const pending = pendingRequests.get(id);
          if (!pending) return;
          pendingRequests.delete(id);
          clearTimeout(pending.timer);

          if (error) {
            pending.reject(coded(error.code || "unknown_error", error.message));
          } else {
            pending.resolve(result);
          }
        },
        onError: (err) => {
          if (isClosed) return;
          for (const pending of pendingRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(err);
          }
          pendingRequests.clear();
          sock.destroy();
        },
      });

      sock.on("connect", () => {
        clearTimeout(timer);
        activeConnectTimer = null;
        activeConnectingSocket = null;
        connectingPromise = null;

        if (isClosed) {
          sock.destroy();
          reject(coded("client_closed", "Client closed during connection"));
          return;
        }

        socket = sock;
        resolve(sock);
      });

      sock.on("data", (chunk) => {
        if (isClosed) return;
        parser.feed(chunk);
      });

      sock.on("error", (err) => {
        clearTimeout(timer);
        activeConnectTimer = null;
        activeConnectingSocket = null;
        connectingPromise = null;

        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timer);
          pending.reject(coded("connection_error", err.message));
        }
        pendingRequests.clear();
        reject(coded("connection_error", err.message));
      });

      sock.on("close", () => {
        clearTimeout(timer);
        activeConnectTimer = null;
        activeConnectingSocket = null;
        connectingPromise = null;
        socket = null;

        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timer);
          pending.reject(coded("disconnected", "Socket connection closed"));
        }
        pendingRequests.clear();
      });
    });

    return connectingPromise;
  }

  async function callRpc(method, params = {}, { timeout = timeoutMs, credential = activeTurnCredential } = {}) {
    if (isClosed) throw coded("client_closed", "Client is closed");
    const sock = await ensureConnection(timeout);
    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(coded("timeout", `RPC call ${method} timed out after ${timeout}ms`));
      }, timeout);

      pendingRequests.set(id, { resolve, reject, timer });

      const payload = {
        protocol_version: PROTOCOL_VERSION,
        id,
        method,
        params,
        credential,
        senderId,
      };

      try {
        const frame = encodeFrame(payload);
        sock.write(frame);
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  let activeTurnCredential = turnCredential;

  return {
    setTurnCredential(cred) {
      activeTurnCredential = cred;
    },
    async localStatus(options = {}) { return callRpc("local_status", {}, options); },
    // The caller's own inbox view only. localStatus gives non-interactive callers (the owner CLI) the host status.
    async sessionStatus(options = {}) { return callRpc("session_status", {}, options); },
    async exchangeTurnBinding(binding) {
      const grant = await callRpc("issue_turn", binding);
      if (grant?.credential) {
        activeTurnCredential = grant.credential;
      }
      return grant;
    },
    async attachSession(tuple,options={}) {
      try{return await callRpc('attach_session',tuple,options);}
      catch(error){
        if(!['connection_error','disconnected'].includes(error?.code))throw error;
        // The tuple is stable and attachment renewal is idempotent. A restart may
        // close a cached socket before its close event reaches this process.
        await new Promise(resolve=>setImmediate(resolve));
        return callRpc('attach_session',tuple,options);
      }
    },
    async detachSession(tuple,options={}) {return callRpc('detach_session',tuple,options);},
    async exchangeInteractiveSession(tuple, options = {}) {
      const grant = await callRpc("exchange_session", tuple, options);
      if (grant?.credential) {
        activeTurnCredential = grant.credential;
      }
      return grant;
    },
    async listInbox({ limit = 50, cursor = null } = {}, options = {}) {
      const res = await callRpc("list_inbox", { limit, cursor }, options);
      const items = res.items || [];
      Object.defineProperty(items, "nextCursor", {
        value: res.nextCursor ?? null,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(items, "items", {
        value: items,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      return items;
    },
    async claimInboxMessage({ messageId, claimId } = {}, options = {}) {
      return await callRpc("claim_inbox_message", { messageId, claimId }, options);
    },
    async sendReply({ messageId, claimToken, text, replyId = null, metadata = {} } = {}, options = {}) {
      return await callRpc("send_reply", { messageId, claimToken, text, replyId, metadata }, options);
    },
    async reserveWakeNotification({ reservationId, clientFingerprint = null } = {}, options = {}) {
      return await callRpc("reserve_wake_notification", { reservationId, clientFingerprint }, options);
    },
    async reportWakeResult({ wakeId, generation, sessionId, bindingId, result } = {}, options = {}) {
      return await callRpc("report_wake_result", { wakeId, generation, sessionId, bindingId, result }, options);
    },
    async discoveryChallenge(params, options = {}) {
      return callRpc("discovery_challenge", params, options);
    },
    async reportDiscovery(params, options = {}) {
      return callRpc("discovery_report", params, options);
    },
    async listSessions(options = {}) {
      const res = await callRpc("list_sessions", {}, options);
      return res.sessions || [];
    },
    async discoverRecipients(options = {}) {
      const res = await callRpc("discover_recipients", {}, options);
      return res.recipients || [];
    },
    // The same call with the router's per-recipient metadata, for agent-facing surfaces. `entries` ({ id, principal })
    // exists only while the host's identity router is enabled, and each one is checked against `recipients`, so an agent
    // never sees an id or a field the host did not list as authorized. No `entries` means the metadata is unavailable.
    async discoverRecipientDetails(options = {}) {
      const res = await callRpc("discover_recipients", {}, options);
      const recipients = Array.isArray(res?.recipients) ? res.recipients : [];
      const entries = projectRecipientEntries(recipients, res?.entries);
      return entries === undefined ? { recipients } : { recipients, entries };
    },

    async sendMessage({
      to,
      text,
      messageId = crypto.randomUUID(),
      requestId = crypto.randomUUID(),
      inReplyTo = null,
      metadata = {},
    }, options = {}) {
      return await callRpc("send_message", {
        to,
        text,
        messageId,
        requestId,
        inReplyTo,
        metadata,
      }, options);
    },

    async getMessageStatus({ messageId }, options = {}) {
      return await callRpc("get_message_status", { messageId }, options);
    },

    async listReplies({ requestId = null, inReplyTo = null, limit = 50 } = {}, options = {}) {
      const res = await callRpc("list_replies", { requestId, inReplyTo, limit }, options);
      return res.replies || [];
    },

    async consumeReply({ messageId }, options = {}) {
      return await callRpc("consume_reply", { messageId }, options);
    },

    async ackNotification({ wakeId, generation }, options = {}) {
      if (!wakeId || typeof generation !== "number") {
        throw coded("invalid_params", "wakeId and generation are required");
      }
      return await callRpc("ack_notification", { wakeId, generation }, options);
    },

    async ackWake({ wakeId, generation }, options = {}) {
      return await this.ackNotification({ wakeId, generation }, options);
    },

    async cancelMessage({ messageId }, options = {}) {
      return await callRpc("cancel_message", { messageId }, options);
    },

    async waitForReply({
      requestId = null,
      inReplyTo = null,
      timeoutMs: waitTimeoutMs = 10000,
      pollIntervalMs = 50,
      credential = activeTurnCredential,
    } = {}) {
      const deadline = Date.now() + waitTimeoutMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const boundedRpcTimeout = Math.min(remaining, timeoutMs);

        const replies = await this.listReplies(
          { requestId, inReplyTo, limit: 1 },
          { timeout: boundedRpcTimeout, credential },
        );
        if (replies.length > 0) {
          return replies[0];
        }

        const waitSlice = Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()));
        if (Date.now() + waitSlice > deadline) break;
        await new Promise((r) => setTimeout(r, waitSlice));
      }
      throw coded("wait_timeout", `Timed out waiting for reply to requestId ${requestId}`);
    },

    async close() {
      isClosed = true;
      if (activeConnectTimer) {
        clearTimeout(activeConnectTimer);
        activeConnectTimer = null;
      }
      if (activeConnectingSocket) {
        try {
          activeConnectingSocket.destroy();
        } catch {}
        activeConnectingSocket = null;
      }
      connectingPromise = null;

      if (socket) {
        try {
          socket.destroy();
        } catch {}
        socket = null;
      }

      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(coded("client_closed", "Client closed"));
      }
      pendingRequests.clear();
    },
  };
}
