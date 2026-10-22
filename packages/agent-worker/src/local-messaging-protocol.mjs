import { coded, sanitizeError } from "./local-messaging-errors.mjs";

export const PROTOCOL_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB
export const MAX_FRAME_BYTES = 320 * 1024; // 320 KB
export const MAX_FIELD_STRING_LENGTH = 128 * 1024; // 128 KB for text field

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
