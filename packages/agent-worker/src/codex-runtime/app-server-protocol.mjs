/**
 * Protocol helpers for Codex App Server JSON-RPC over stdio NDJSON.
 */

const JSONRPC = "2.0";

export const APP_SERVER_METHODS = Object.freeze([
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/read",
  "turn/start",
  "turn/interrupt",
]);

export const APP_SERVER_NOTIFICATIONS = Object.freeze(["initialized"]);

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export function assertNoSecretMaterial(value, label = "value") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text === "string" && /mesh_(?:watch_)?[A-Za-z0-9_-]{8,}/.test(text)) {
    throw createCodedError("secret_leak_rejected", `${label} must not contain mesh_ credentials`);
  }
}

export function encodeJsonRpcRequest(id, method, params = {}) {
  if (!Number.isSafeInteger(id) && typeof id !== "string") {
    throw new TypeError("id must be a safe integer or string");
  }
  if (typeof method !== "string" || method.length === 0) {
    throw new TypeError("method is required");
  }
  assertNoSecretMaterial(params, `${method} params`);
  return Object.freeze({ jsonrpc: JSONRPC, id, method, params });
}

export function encodeJsonRpcNotification(method, params = {}) {
  if (typeof method !== "string" || method.length === 0) {
    throw new TypeError("method is required");
  }
  assertNoSecretMaterial(params, `${method} params`);
  return Object.freeze({ jsonrpc: JSONRPC, method, params });
}

export function encodeNdjsonLine(message) {
  assertNoSecretMaterial(message, "jsonrpc message");
  return `${JSON.stringify(message)}\n`;
}

export function parseNdjsonLine(line) {
  if (typeof line !== "string") {
    throw createCodedError("protocol_malformed", "NDJSON line must be a string");
  }
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    throw createCodedError("protocol_malformed", "NDJSON line is not valid JSON");
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw createCodedError("protocol_malformed", "JSON-RPC message must be an object");
  }
  assertNoSecretMaterial(message, "jsonrpc message");
  return message;
}

export function classifyJsonRpcMessage(message) {
  if (message.error != null && message.id !== undefined) return "error";
  if (message.result !== undefined && message.id !== undefined) return "response";
  if (typeof message.method === "string" && message.id !== undefined) return "request";
  if (typeof message.method === "string") return "notification";
  throw createCodedError("protocol_malformed", "unrecognized JSON-RPC message shape");
}

export function createRequestIdFactory(start = 1) {
  let next = start;
  return () => {
    const id = next;
    next += 1;
    return id;
  };
}
