import { coded, sanitizeError } from "./local-messaging-errors.mjs";

export const PROTOCOL_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB
export const MAX_FRAME_BYTES = 320 * 1024; // 320 KB
export const MAX_FIELD_STRING_LENGTH = 128 * 1024; // 128 KB for text field

// One description for triangle_get_status on every MCP surface (the bound adapter and attached chats).
export const STATUS_TOOL_DESCRIPTION = "Show this conversation's Triangle address and inbox counts, or pass messageId for the status of a message you sent or received: its phase plus a delivery state, explanation and next action. Notification acceptance is not execution or approval, and approval state may be unknown.";

// One text for triangle_list_recipients and triangle_send_message on every MCP surface. Labels are never routing keys;
// `entries` exists only while the owner has enabled principal routing, and a null principal means none is known right now.
export const LIST_RECIPIENTS_TOOL_DESCRIPTION = "Discover authorized local agent recipients on this host: recipients lists the exact ids you may send to. When the owner has enabled principal routing, entries also pairs each id with its principal (an agent_ id you may send to instead of the id), or null when none is known right now; null does not mean the recipient has no identity. Presence and reachability come from triangle_list_sessions.";
export const SEND_TOOL_DESCRIPTION = "Send a message to an authorized local recipient agent on this host. The result, and any error, carries messageId and requestId. If a call fails or times out the message may already be admitted: retry with the SAME messageId and requestId so it is recognised as a duplicate instead of running the task twice. Never send a new message just to retry.";
export const SEND_TOOL_ARGUMENT_DESCRIPTIONS = Object.freeze({
  to: "Exact recipient id from triangle_list_recipients or triangle_list_sessions, never a label. When triangle_list_recipients lists a principal (an agent_ id) for a recipient you may send to that instead. peer_ addresses are not supported.",
  text: "Message body text",
  messageId: "Stable message ID for idempotency. Optional on the first call (one is generated and returned); on a retry always pass the messageId returned by the earlier attempt.",
  requestId: "Correlation request ID. Optional on the first call (one is generated and returned); on a retry always pass the requestId returned by the earlier attempt.",
  inReplyTo: "Message ID being replied to",
});

export function encodeFrame(message) {
  if (!message || typeof message !== "object") {
    throw coded("invalid_message", "Message must be an object");
  }

  const payloadStr = JSON.stringify(message);
  const bodyBuf = Buffer.from(payloadStr, "utf8");
  if (bodyBuf.length > MAX_PAYLOAD_BYTES) {
    throw coded(
      "payload_too_large",
      `Message payload size ${bodyBuf.length} exceeds limit ${MAX_PAYLOAD_BYTES}`,
    );
  }
  const frameBuf = Buffer.alloc(4 + bodyBuf.length);
  frameBuf.writeUInt32BE(bodyBuf.length, 0);
  bodyBuf.copy(frameBuf, 4);
  if (frameBuf.length > MAX_FRAME_BYTES) {
    throw coded(
      "frame_too_large",
      `Frame size ${frameBuf.length} exceeds limit ${MAX_FRAME_BYTES}`,
    );
  }
  return frameBuf;
}

export function createMessageParser({
  onMessage,
  onError,
  maxFrameBytes = MAX_FRAME_BYTES,
}) {
  let buffer = Buffer.alloc(0);

  return {
    feed(chunk) {
      if (!chunk || !chunk.length) return;
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 4) {
        const bodyLength = buffer.readUInt32BE(0);

        // Enforce frame limit on EACH individual frame, not concatenated stream buffer
        if (bodyLength > maxFrameBytes) {
          onError?.(
            coded(
              "frame_too_large",
              `Frame length ${bodyLength} exceeds maximum allowed frame size of ${maxFrameBytes}`,
            ),
          );
          buffer = Buffer.alloc(0);
          return;
        }

        if (buffer.length < 4 + bodyLength) {
          // Waiting for remaining bytes of this single frame
          break;
        }

        const bodyBuf = buffer.subarray(4, 4 + bodyLength);
        buffer = buffer.subarray(4 + bodyLength);

        try {
          const parsed = JSON.parse(bodyBuf.toString("utf8"));
          onMessage?.(parsed);
        } catch {
          onError?.(coded("invalid_json", "Failed to parse frame JSON payload"));
        }
      }

      // Guard against unbounded accumulation of partial frames
      if (buffer.length > maxFrameBytes + 4) {
        onError?.(
          coded(
            "frame_too_large",
            "Partial frame buffer exceeded maximum allowed frame size",
          ),
        );
        buffer = Buffer.alloc(0);
      }
    },

    reset() {
      buffer = Buffer.alloc(0);
    },
  };
}

export function createSuccessResponse(id, result = {}, protocolVersion = PROTOCOL_VERSION) {
  return {
    protocol_version: protocolVersion,
    id,
    result,
  };
}

export function createErrorResponse(id, err, protocolVersion = PROTOCOL_VERSION) {
  const { code, message } = sanitizeError(err);
  return {
    protocol_version: protocolVersion,
    id: typeof id !== "undefined" ? id : null,
    error: { code, message },
  };
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// Returns the reply cut to fit roomBytes once serialized, flagged so the
// caller can tell. The full text stays in the journal.
function truncateReplyToFit(reply, roomBytes) {
  const text = typeof reply.text === "string" ? reply.text : "";
  const originalTextBytes = Buffer.byteLength(text, "utf8");
  const framed = (slice, base = reply) => ({ ...base, text: slice, truncated: true, originalTextBytes });
  // Never end on half of a surrogate pair; the binary search below measures real JSON size.
  const prefix = (length) => {
    const cut = length > 0 && (text.charCodeAt(length - 1) & 0xfc00) === 0xd800 ? length - 1 : length;
    return text.slice(0, cut);
  };
  const base = jsonBytes(framed("")) <= roomBytes ? reply : { ...reply, metadata: null };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes(framed(prefix(mid), base)) <= roomBytes) low = mid;
    else high = mid - 1;
  }
  return framed(prefix(low), base);
}

// A listing always makes progress: the first reply is returned even when it
// alone exceeds one response (truncated and flagged); later replies that do not
// fit wait, whole, for the next listing.
export function boundRepliesToEnvelope(replies, maxBytes = MAX_PAYLOAD_BYTES - 1024) {
  if (!Array.isArray(replies)) return [];
  const bounded = [];
  let currentBytes = 64; // base JSON envelope estimate
  for (const reply of replies) {
    const itemBytes = jsonBytes(reply);
    if (currentBytes + itemBytes <= maxBytes) {
      currentBytes += itemBytes;
      bounded.push(reply);
      continue;
    }
    if (bounded.length === 0) bounded.push(truncateReplyToFit(reply, maxBytes - currentBytes));
    break;
  }
  return bounded;
}
