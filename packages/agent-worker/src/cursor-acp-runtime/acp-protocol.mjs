/**
 * Cursor ACP protocol constants and helpers.
 *
 * Transport is stdio NDJSON JSON-RPC 2.0 (same framing family as Codex App
 * Server). Cursor-specific method names and unattended callback shapes live
 * here. Generic encode/parse helpers are reused from the Codex protocol module
 * so secret-confinement stays identical across lanes.
 */

import {
  assertNoSecretMaterial,
  classifyJsonRpcMessage,
  createRequestIdFactory,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeNdjsonLine,
  parseNdjsonLine,
} from "../codex-runtime/app-server-protocol.mjs";

export {
  assertNoSecretMaterial,
  classifyJsonRpcMessage,
  createRequestIdFactory,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeNdjsonLine,
  parseNdjsonLine,
};

/** Client → agent methods used by the Triangle ACP host. */
export const ACP_CLIENT_METHODS = Object.freeze([
  "initialize",
  "authenticate",
  "session/new",
  "session/load",
  "session/prompt",
  "session/set_config_option",
  "session/cancel",
]);

/** Agent → client blocking requests that must be answered unattended. */
export const ACP_SERVER_REQUEST_METHODS = Object.freeze([
  "session/request_permission",
  "cursor/ask_question",
  "cursor/create_plan",
]);

/** Agent → client notifications (non-blocking). */
export const ACP_NOTIFICATIONS = Object.freeze([
  "session/update",
  "cursor/update_todos",
  "cursor/task",
  "cursor/generate_image",
]);

export const ACP_AUTH_METHOD_CURSOR_LOGIN = "cursor_login";

export const ACP_MODES = Object.freeze(["ask", "agent", "plan"]);

export const ACP_PERMISSION_OPTION_IDS = Object.freeze([
  "allow-once",
  "allow-always",
  "reject-once",
]);

export const ACP_STOP_REASONS = Object.freeze([
  "end_turn",
  "cancelled",
  "max_tokens",
  "refusal",
]);

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export function assertAcpMode(mode) {
  if (!ACP_MODES.includes(mode)) {
    throw createCodedError("acp_mode_invalid", `unsupported ACP mode: ${mode}`, { mode });
  }
  return mode;
}

/**
 * Workload → mode policy. Conversational-only traffic uses ask; authorized
 * tool/shell/edit work uses agent; planning uses plan. Never unconditional ask.
 */
export function resolveWorkloadMode(workload) {
  if (workload === "conversational" || workload === "ask") return "ask";
  if (workload === "tools" || workload === "agent") return "agent";
  if (workload === "planning" || workload === "plan") return "plan";
  throw createCodedError(
    "acp_workload_invalid",
    `unsupported workload policy: ${workload}`,
    { workload },
  );
}

/**
 * Extract assistant text from ACP session/update stream chunks and/or the
 * prompt result. Prefer streamed agent_message_chunk text.
 *
 * Accepts either a flat update (`{ sessionUpdate, content }`) or a wrapper
 * (`{ update: { sessionUpdate, content } }`).
 */
export function extractAcpAssistantText(updates = [], promptResult = null) {
  const parts = [];
  const push = (value) => {
    if (typeof value === "string" && value.length > 0) parts.push(value);
  };

  for (const update of updates) {
    if (update == null || typeof update !== "object") continue;
    const sessionUpdate =
      update.update && typeof update.update === "object"
        ? update.update
        : update;
    const kind =
      typeof sessionUpdate.sessionUpdate === "string"
        ? sessionUpdate.sessionUpdate
        : sessionUpdate.type ?? sessionUpdate.kind;
    if (
      kind === "agent_message_chunk" ||
      kind === "agent_message" ||
      kind === "message_chunk"
    ) {
      const content = sessionUpdate.content ?? sessionUpdate.text ?? sessionUpdate.delta;
      if (typeof content === "string") push(content);
      else if (content && typeof content === "object" && typeof content.text === "string") {
        push(content.text);
      }
    } else if (typeof sessionUpdate.text === "string") {
      push(sessionUpdate.text);
    }
  }

  if (parts.length === 0 && promptResult != null) {
    if (typeof promptResult === "string") push(promptResult);
    else if (typeof promptResult?.text === "string") push(promptResult.text);
    else if (Array.isArray(promptResult?.content)) {
      for (const part of promptResult.content) {
        if (typeof part === "string") push(part);
        else if (part?.type === "text" && typeof part.text === "string") push(part.text);
      }
    }
  }

  return parts.join("").trim();
}
