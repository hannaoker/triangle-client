const MAX_CONFORMANCE_REPORT_BYTES = 2_048;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_TEXT_LENGTH = 10_000;
const MAX_PARTS = 64;
const MAX_HISTORY = 100;

const DIALECTS = new Map([
  ["SendMessage", { sendMethod: "SendMessage", getTaskMethod: "GetTask" }],
  ["message/send", { sendMethod: "message/send", getTaskMethod: "tasks/get" }],
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, max = MAX_IDENTIFIER_LENGTH) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

export function verifiedOutboundDialect(peer) {
  const report = peer?.conformanceReport;
  if (
    typeof report !== "string" ||
    report.length === 0 ||
    Buffer.byteLength(report) > MAX_CONFORMANCE_REPORT_BYTES
  ) {
    throw new RangeError("Recipient has no usable verified conformance report");
  }

  let parsed;
  try {
    parsed = JSON.parse(report);
  } catch {
    throw new RangeError("Recipient has no usable verified conformance report");
  }
  const dialect = record(parsed) ? DIALECTS.get(parsed.method) : undefined;
  if (!dialect) {
    throw new RangeError("Recipient has no usable verified conformance report");
  }
  return { ...dialect };
}

export function buildOutboundRpc(action, dialect, rpcId) {
  if (action.type === "send") {
    return {
      jsonrpc: "2.0",
      id: rpcId,
      method: dialect.sendMethod,
      params: {
        message: {
          messageId: action.messageId,
          ...(action.contextId ? { contextId: action.contextId } : {}),
          role: "ROLE_USER",
          parts: [{ text: action.text }],
        },
        configuration: { returnImmediately: true },
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id: rpcId,
    method: dialect.getTaskMethod,
    params: { id: action.taskId, historyLength: 100 },
  };
}

function safeMessage(value) {
  if (!record(value) || value.role !== "ROLE_AGENT") return undefined;
  const messageId = boundedString(value.messageId);
  const taskId =
    value.taskId === undefined ? undefined : boundedString(value.taskId);
  const contextId = boundedString(value.contextId);
  if (!messageId || !contextId || value.taskId !== undefined && !taskId) {
    return undefined;
  }
  if (!Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > MAX_PARTS) {
    return undefined;
  }
  const parts = value.parts.map((part) => {
    const partText = record(part) ? boundedString(part.text, MAX_TEXT_LENGTH) : undefined;
    return partText ? { text: partText } : undefined;
  });
  if (parts.some((part) => !part)) return undefined;
  return {
    messageId,
    ...(taskId ? { taskId } : {}),
    contextId,
    role: "ROLE_AGENT",
    parts,
  };
}

function safeTask(value) {
  if (!record(value) || !record(value.status)) return undefined;
  const id = boundedString(value.id);
  const contextId = boundedString(value.contextId);
  const state = boundedString(value.status.state, 64);
  if (!id || !contextId || !state || !/^TASK_STATE_[A-Z_]+$/.test(state)) {
    return undefined;
  }
  const statusMessage =
    value.status.message === undefined ? undefined : safeMessage(value.status.message);
  if (value.status.message !== undefined && !statusMessage) return undefined;
  const history = value.history === undefined ? [] : value.history;
  if (!Array.isArray(history) || history.length > MAX_HISTORY) return undefined;
  const safeHistory = history.map(safeMessage);
  if (safeHistory.some((message) => !message)) return undefined;
  return {
    id,
    contextId,
    status: {
      state,
      ...(statusMessage ? { message: statusMessage } : {}),
    },
    history: safeHistory,
  };
}

export function normalizeOutboundPayload(actionType, payload, randomTaskId) {
  if (!record(payload) || !record(payload.result)) return payload;
  const directTask = safeTask(
    actionType === "send" ? payload.result.task : payload.result,
  );
  if (directTask) {
    return actionType === "send"
      ? { jsonrpc: payload.jsonrpc, id: payload.id, result: { task: directTask } }
      : { jsonrpc: payload.jsonrpc, id: payload.id, result: directTask };
  }
  if (actionType !== "send") return payload;

  const message = safeMessage(payload.result.message);
  if (!message) return payload;
  const taskId = message.taskId || boundedString(randomTaskId?.());
  if (!taskId) return payload;
  return {
    jsonrpc: payload.jsonrpc,
    id: payload.id,
    result: {
      task: {
        id: taskId,
        contextId: message.contextId,
        status: { state: "TASK_STATE_COMPLETED", message },
        history: [message],
      },
    },
  };
}
