import net from "node:net";
import crypto from "node:crypto";
import {
  encodeFrame,
  createMessageParser,
  PROTOCOL_VERSION,
} from "./local-messaging-protocol.mjs";
import { coded } from "./local-messaging-errors.mjs";

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

  async function callRpc(method, params = {}, { timeout = timeoutMs, credential = turnCredential } = {}) {
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

  return {
    async localStatus(options = {}) { return callRpc("local_status", {}, options); },
    async exchangeTurnBinding(binding) {
      return callRpc("issue_turn", binding);
    },
    async discoverRecipients(options = {}) {
      const res = await callRpc("discover_recipients", {}, options);
      return res.recipients || [];
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

    async cancelMessage({ messageId }, options = {}) {
      return await callRpc("cancel_message", { messageId }, options);
    },

    async waitForReply({
      requestId = null,
      inReplyTo = null,
      timeoutMs: waitTimeoutMs = 10000,
      pollIntervalMs = 50,
    } = {}) {
      const deadline = Date.now() + waitTimeoutMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const boundedRpcTimeout = Math.min(remaining, timeoutMs);

        const replies = await this.listReplies(
          { requestId, inReplyTo, limit: 1 },
          { timeout: boundedRpcTimeout },
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
