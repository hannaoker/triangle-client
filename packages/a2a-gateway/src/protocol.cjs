const { createHash } = require("node:crypto");

const A2A_PROTOCOL_VERSION = "1.0";
const A2A_JSONRPC_VERSION = "2.0";
const MESH_PROFILE_PATH = "/extensions/mesh-a2a-profile/v1";
const TASK_STATES = new Set([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);
const TERMINAL_TASK_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);
const WAIT_RETURN_STATES = new Set([
  ...TERMINAL_TASK_STATES,
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
]);
const SUPPORTED_METHODS = new Set(["SendMessage", "GetTask", "ListTasks"]);
const DEFAULT_LIMITS = Object.freeze({
  maxTasks: 1000,
  maxInboxEntries: 5000,
  maxTaskHistory: 100,
  maxArtifacts: 50,
  maxMessageBytes: 256 * 1024,
  maxTaskBytes: 1024 * 1024,
});
const DEFAULT_INTROSPECTION_DEADLINE_MS = 5000;
const DEFAULT_INTROSPECTION_MAX_BYTES = 64 * 1024;

function deriveMessageContextId(senderAgentId, messageId) {
  const digest = createHash("sha256")
    .update(JSON.stringify([senderAgentId, messageId]), "utf8")
    .digest("hex");
  return `context_${digest.slice(0, 32)}`;
}

function meshProfileUri(meshOrigin) {
  return new URL(MESH_PROFILE_PATH, meshOrigin).toString();
}

function buildAgentCard({ origin, meshOrigin, profile = {} }) {
  return {
    name: profile.name || "Codex Agent",
    description:
      profile.description ||
      "OpenAI Codex agent for software engineering, verification, local tools, and structured collaboration.",
    version: profile.version || "1.0.0",
    supportedInterfaces: [
      {
        url: new URL("/api/v1", origin).toString(),
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: meshProfileUri(meshOrigin),
          required: false,
        },
      ],
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills:
      profile.skills ||
      [
        {
          id: "software-engineering",
          name: "Software engineering",
          description: "Inspect, change, test, and explain software systems.",
          tags: ["code", "debugging", "testing", "review"],
        },
        {
          id: "agent-coordination",
          name: "Agent coordination",
          description: "Coordinate tasks and preserve context across agent handoffs.",
          tags: ["a2a", "mcp", "delegation", "verification"],
        },
      ],
  };
}

function jsonRpcError(requestId, code, message, status = 400) {
  return {
    status,
    body: {
      jsonrpc: A2A_JSONRPC_VERSION,
      id: requestId ?? null,
      error: {
        code,
        message,
      },
    },
  };
}

function jsonRpcResult(requestId, result) {
  return {
    status: 200,
    body: {
      jsonrpc: A2A_JSONRPC_VERSION,
      id: requestId,
      result,
    },
  };
}

function hasExtension(extensions, expected) {
  return String(extensions || "")
    .split(",")
    .map((value) => value.trim())
    .includes(expected);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRequestId(value) {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value))
  );
}

function isJsonValue(value, seen = new Set()) {
  if (value === null) return true;
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((entry) => isJsonValue(entry, seen));
    seen.delete(value);
    return valid;
  }
  if (
    isObject(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = Object.values(value).every((entry) =>
      isJsonValue(entry, seen),
    );
    seen.delete(value);
    return valid;
  }
  return false;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function normalizeProtoJsonBase64(value) {
  if (typeof value !== "string") return null;
  const match = /^([A-Za-z0-9+/_-]*)(={0,2})$/.exec(value);
  if (!match) return null;
  const [, body, suppliedPadding] = match;
  if (/[+/]/.test(body) && /[-_]/.test(body)) return null;
  const remainder = body.length % 4;
  if (remainder === 1) return null;
  if (
    suppliedPadding.length > 0 &&
    (value.length % 4 !== 0 ||
      suppliedPadding.length !== (4 - remainder) % 4)
  ) {
    return null;
  }
  const standardBody = body.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - remainder) % 4);
  return Buffer.from(`${standardBody}${padding}`, "base64").toString("base64");
}

function normalizePart(part) {
  return Object.prototype.hasOwnProperty.call(part, "raw")
    ? { ...part, raw: normalizeProtoJsonBase64(part.raw) }
    : { ...part };
}

function normalizeMessage(message) {
  return { ...message, parts: message.parts.map(normalizePart) };
}

function normalizeArtifact(artifact) {
  return { ...artifact, parts: artifact.parts.map(normalizePart) };
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function replaceObject(target, value) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, value);
}

function replaceArray(target, value) {
  target.splice(0, target.length, ...value);
}

function persistenceFailure(requestId, error) {
  return jsonRpcError(
    requestId,
    -32603,
    "Internal error",
    error?.name === "StateRevisionConflictError" ? 409 : 500,
  );
}

function bridgeFailure(requestId, error) {
  if (error instanceof TypeError) {
    return jsonRpcError(requestId, -32602, "Invalid params");
  }
  if (error?.code === "task_not_found") {
    return jsonRpcError(requestId, -32001, "TaskNotFoundError", 404);
  }
  if (error?.code === "idempotency_conflict") {
    return jsonRpcError(requestId, -32004, "Idempotency conflict", 409);
  }
  if (error?.name === "TimeoutError") {
    return jsonRpcError(requestId, -32000, "Task did not complete before deadline", 504);
  }
  if (error?.name === "AbortError") {
    return jsonRpcError(requestId, -32000, "Request canceled", 499);
  }
  return jsonRpcError(requestId, -32603, "Internal error", 503);
}

function bridgeMessage(message, contextId = message?.contextId) {
  if (
    !isClientMessage(message) ||
    message.parts.length === 0 ||
    message.parts.some((part) => typeof part.text !== "string")
  ) {
    return null;
  }
  const text = message.parts.map((part) => part.text).join("\n");
  if (!text.trim()) return null;
  return {
    messageId: message.messageId,
    contextId,
    ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
    text,
  };
}

function waitForBridgeTask({ bridge, senderAgentId, task, signal, timeoutMs, pollMs }) {
  return new Promise((resolve, reject) => {
    const expiresAt = Date.now() + timeoutMs;
    let pollTimer;
    let deadlineTimer;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = new Error("A2A request canceled");
      error.name = "AbortError";
      finish(reject, error);
    };
    const check = async () => {
      if (signal?.aborted) return onAbort();
      if (Date.now() >= expiresAt) {
        const error = new Error("A2A task wait deadline exceeded");
        error.name = "TimeoutError";
        return finish(reject, error);
      }
      try {
        const projected = await bridge.getTask({ senderAgentId, taskId: task.id });
        if (WAIT_RETURN_STATES.has(projected?.status?.state)) {
          return finish(resolve, projected);
        }
      } catch (error) {
        return finish(reject, error);
      }
      pollTimer = setTimeout(check, Math.min(pollMs, Math.max(1, expiresAt - Date.now())));
      pollTimer.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(() => {
      const error = new Error("A2A task wait deadline exceeded");
      error.name = "TimeoutError";
      finish(reject, error);
    }, timeoutMs);
    deadlineTimer.unref?.();
    check();
  });
}

function privatePersistenceFailure(error) {
  return error?.name === "StateRevisionConflictError"
    ? { status: 409, error: "State conflict; retry request" }
    : { status: 500, error: "Internal error" };
}

function boundedInbox(inbox, message, maxEntries) {
  const next = [...inbox, message];
  while (next.length > maxEntries) {
    const safeIndex = next.findIndex((entry) => entry?.acked === true);
    if (safeIndex < 0) return null;
    next.splice(safeIndex, 1);
  }
  return next;
}

function taskRevision(task) {
  const revision = task?.metadata?.meshRevision;
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : 1;
}

function isPart(value) {
  if (!isObject(value)) return false;
  const contentFields = ["text", "raw", "url", "data"].filter((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  );
  if (contentFields.length !== 1) return false;
  const [contentField] = contentFields;
  return (
    isJsonValue(value) &&
    (value.filename === undefined || typeof value.filename === "string") &&
    (value.mediaType === undefined || typeof value.mediaType === "string") &&
    (value.metadata === undefined || isObject(value.metadata)) &&
    (contentField === "data"
      ? isJsonValue(value.data)
      : contentField === "raw"
        ? normalizeProtoJsonBase64(value.raw) !== null
      : typeof value[contentField] === "string")
  );
}

function isClientMessage(value) {
  return (
    isObject(value) &&
    isJsonValue(value) &&
    typeof value.messageId === "string" &&
    value.messageId.trim().length > 0 &&
    value.role === "ROLE_USER" &&
    (value.taskId === undefined ||
      (typeof value.taskId === "string" && value.taskId.trim().length > 0)) &&
    (value.contextId === undefined ||
      (typeof value.contextId === "string" &&
        value.contextId.trim().length > 0)) &&
    (value.metadata === undefined || isObject(value.metadata)) &&
    (value.extensions === undefined || isStringArray(value.extensions)) &&
    (value.referenceTaskIds === undefined ||
      isStringArray(value.referenceTaskIds)) &&
    Array.isArray(value.parts) &&
    value.parts.length > 0 &&
    value.parts.every(isPart)
  );
}

function isTaskMessage(
  value,
  { taskId, contextId, roles },
) {
  return (
    isObject(value) &&
    isJsonValue(value) &&
    typeof value.messageId === "string" &&
    value.messageId.trim().length > 0 &&
    roles.has(value.role) &&
    Array.isArray(value.parts) &&
    value.parts.length > 0 &&
    value.parts.every(isPart) &&
    value.taskId === taskId &&
    value.contextId === contextId &&
    (value.metadata === undefined || isObject(value.metadata)) &&
    (value.extensions === undefined || isStringArray(value.extensions)) &&
    (value.referenceTaskIds === undefined ||
      isStringArray(value.referenceTaskIds))
  );
}

function isArtifact(value) {
  return (
    isObject(value) &&
    isJsonValue(value) &&
    typeof value.artifactId === "string" &&
    value.artifactId.trim().length > 0 &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.description === undefined ||
      typeof value.description === "string") &&
    (value.metadata === undefined || isObject(value.metadata)) &&
    (value.extensions === undefined || isStringArray(value.extensions)) &&
    Array.isArray(value.parts) &&
    value.parts.length > 0 &&
    value.parts.every(isPart)
  );
}

function isRegistrationProbe(message, proofNonce, extensions, profileUri) {
  const mesh = message?.metadata?.mesh;
  const part = message?.parts?.[0];
  return (
    isClientMessage(message) &&
    typeof proofNonce === "string" &&
    proofNonce.length > 0 &&
    isObject(message.metadata) &&
    Object.keys(message.metadata).length === 1 &&
    isObject(mesh) &&
    Object.keys(mesh).length === 2 &&
    mesh?.type === "registration-conformance" &&
    mesh.registrationNonce === proofNonce &&
    Array.isArray(message.extensions) &&
    message.extensions.includes(profileUri) &&
    message.parts.length === 1 &&
    isObject(part) &&
    Object.keys(part).length === 1 &&
    part.text === "MESH registration conformance probe" &&
    hasExtension(extensions, profileUri)
  );
}

function readStoredTask(record) {
  if (!isObject(record)) return null;
  if (isObject(record.task)) {
    return {
      senderId: record.senderId,
      recipientId: record.recipientId,
      task: record.task,
    };
  }
  return {
    senderId: record.senderId || record.metadata?.sender?.id,
    recipientId: record.recipientId,
    task: record,
  };
}

function taskView(task, historyLength, includeArtifacts = true) {
  const result = {
    id: task.id,
    contextId: task.contextId,
    status: task.status,
  };
  if (typeof historyLength === "number") {
    if (historyLength > 0 && Array.isArray(task.history)) {
      result.history = task.history.slice(-historyLength);
    }
  } else if (Array.isArray(task.history)) {
    result.history = task.history;
  }
  if (includeArtifacts && Array.isArray(task.artifacts)) {
    result.artifacts = task.artifacts;
  }
  if (isObject(task.metadata)) result.metadata = task.metadata;
  return result;
}

function authenticatedTask(tasks, taskId, senderId) {
  const record = readStoredTask(tasks[taskId]);
  return record?.senderId === senderId ? record : null;
}

function taskForMessage(tasks, senderId, messageId) {
  for (const value of Object.values(tasks)) {
    const record = readStoredTask(value);
    if (record?.senderId !== senderId) continue;
    if (
      record.task?.history?.some(
        (message) =>
          message?.role === "ROLE_USER" && message?.messageId === messageId,
      )
    ) {
      return record;
    }
  }
  return null;
}


function compareTaskKeys(left, right) {
  const timestampOrder = String(right.status?.timestamp || "").localeCompare(
    String(left.status?.timestamp || ""),
  );
  if (timestampOrder !== 0) return timestampOrder;
  return String(right.id).localeCompare(String(left.id));
}

function encodeTaskCursor(task) {
  return Buffer.from(
    JSON.stringify({
      timestamp: task.status?.timestamp || "",
      id: task.id,
    }),
  ).toString("base64url");
}

function decodeTaskCursor(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isObject(decoded) ||
      typeof decoded.timestamp !== "string" ||
      !Number.isFinite(Date.parse(decoded.timestamp)) ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0
    ) {
      return null;
    }
    return {
      id: decoded.id,
      status: { timestamp: decoded.timestamp },
    };
  } catch {
    return null;
  }
}

function createMeshPeerIntrospector({
  meshOrigin,
  agentToken,
  fetchImpl = globalThis.fetch,
  deadlineMs = DEFAULT_INTROSPECTION_DEADLINE_MS,
  maxResponseBytes = DEFAULT_INTROSPECTION_MAX_BYTES,
}) {
  return async function introspectPeerToken(peerToken) {
    if (
      typeof peerToken !== "string" ||
      !peerToken.startsWith("mesh_peer_") ||
      typeof agentToken !== "string" ||
      !agentToken.startsWith("mesh_") ||
      agentToken.startsWith("mesh_peer_")
    ) {
      return null;
    }

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const response = await fetchImpl(
        new URL("/api/v1/peer-tokens/introspect", meshOrigin).toString(),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${agentToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ peer_token: peerToken }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        return null;
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > maxResponseBytes
      ) {
        controller.abort();
        return null;
      }
      const reader = response.body?.getReader();
      if (!reader) {
        return null;
      }
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) {
          controller.abort();
          return null;
        }
        chunks.push(value);
      }
      const result = JSON.parse(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
          "utf8",
        ),
      );
      if (
        result?.active !== true ||
        typeof result?.sender?.id !== "string" ||
        typeof result?.sender?.name !== "string" ||
        !Array.isArray(result?.scopes) ||
        !result.scopes.includes("a2a.send")
      ) {
        return null;
      }
      return result;
    } catch {
      return null;
    } finally {
      clearTimeout(deadline);
    }
  };
}


async function preflightProtocolRequest({
  request,
  version,
  extensions,
  authorization,
  meshOrigin,
  getProofNonce,
  introspectPeerToken,
  createId,
  credential,
}) {
  const requestId = request?.id;
  if (version !== A2A_PROTOCOL_VERSION) {
    return {
      response: jsonRpcError(
        requestId,
        -32009,
        "VersionNotSupportedError",
        400,
      ),
    };
  }
  if (
    !isObject(request) ||
    request.jsonrpc !== A2A_JSONRPC_VERSION ||
    typeof request.method !== "string" ||
    !Object.prototype.hasOwnProperty.call(request, "id") ||
    !isValidRequestId(request.id)
  ) {
    return { response: jsonRpcError(null, -32600, "Invalid Request") };
  }

  const profileUri = meshProfileUri(meshOrigin);
  const message = request.params?.message;
  if (
    request.method === "SendMessage" &&
    isRegistrationProbe(
      message,
      getProofNonce(),
      extensions,
      profileUri,
    )
  ) {
    return {
      response: jsonRpcResult(requestId, {
        message: {
          messageId: createId("message"),
          contextId: message.contextId || createId("context"),
          role: "ROLE_AGENT",
          parts: [{ text: "MESH conformance verified" }],
        },
      }),
    };
  }

  if (!SUPPORTED_METHODS.has(request.method)) {
    return {
      response: jsonRpcError(requestId, -32601, "Method not found"),
    };
  }
  if (credential === undefined) {
    if (
      typeof authorization !== "string" ||
      !authorization.startsWith("Bearer mesh_peer_")
    ) {
      return {
        response: jsonRpcError(
          requestId,
          -32000,
          "Authentication required",
          401,
        ),
      };
    }
    const peerToken = authorization.slice("Bearer ".length);
    credential = await introspectPeerToken(peerToken);
  }
  if (!credential?.active || !credential?.sender?.id) {
    return {
      response: jsonRpcError(
        requestId,
        -32000,
        "Invalid or inactive MESH peer ticket",
        401,
      ),
    };
  }
  return { credential };
}

function createProtocolHandler({
  meshOrigin,
  getProofNonce,
  bridge,
  recipientAgentId,
  introspectPeerToken,
  createId,
  bridgeWaitTimeoutMs = 30_000,
  bridgeWaitPollMs = 250,
}) {
  if (
    !bridge ||
    typeof bridge.sendMessage !== "function" ||
    typeof bridge.getTask !== "function" ||
    typeof bridge.listTasks !== "function"
  ) {
    throw new TypeError("bridge is required");
  }
  if (!/^agent_[a-f0-9]{32}$/.test(recipientAgentId)) {
    throw new TypeError("recipientAgentId must be canonical");
  }
  if (
    !Number.isSafeInteger(bridgeWaitTimeoutMs) ||
      bridgeWaitTimeoutMs < 1 ||
      !Number.isSafeInteger(bridgeWaitPollMs) ||
      bridgeWaitPollMs < 1 ||
      bridgeWaitPollMs > bridgeWaitTimeoutMs
  ) {
    throw new TypeError("bridge wait bounds are invalid");
  }
  return async function handleProtocol({
    request,
    version,
    extensions,
    authorization,
    signal,
    credential: authenticatedCredential,
  }) {
    const requestId = request?.id;
    const preflight = await preflightProtocolRequest({
      request,
      version,
      extensions,
      authorization,
      meshOrigin,
      getProofNonce,
      introspectPeerToken,
      createId,
      credential: authenticatedCredential,
    });
    if (preflight.response) return preflight.response;
    const credential = preflight.credential;
    const peer = credential.sender;
    const message = request.params?.message;

    if (credential.audience_agent_id !== recipientAgentId) {
      return jsonRpcError(requestId, -32000, "Peer ticket audience mismatch", 403);
    }
    try {
      if (request.method === "SendMessage") {
        let contextId = message?.contextId;
        if (contextId === undefined && isClientMessage(message)) {
          contextId = deriveMessageContextId(peer.id, message.messageId);
        }
        const projectedMessage = bridgeMessage(message, contextId);
        if (!projectedMessage) {
          return jsonRpcError(requestId, -32602, "Invalid params");
        }
        const peerToken = authorization.slice("Bearer ".length);
        const task = await bridge.sendMessage({
          peerToken,
          senderAgentId: peer.id,
          message: projectedMessage,
        });
        if (request.params?.configuration?.returnImmediately === true) {
          return jsonRpcResult(requestId, { task });
        }
        const projected = await waitForBridgeTask({
          bridge,
          senderAgentId: peer.id,
          task,
          signal,
          timeoutMs: bridgeWaitTimeoutMs,
          pollMs: bridgeWaitPollMs,
        });
        return jsonRpcResult(requestId, { task: projected });
      }
      if (request.method === "GetTask") {
        const taskId = request.params?.id;
        if (typeof taskId !== "string" || taskId.length === 0) {
          return jsonRpcError(requestId, -32602, "Invalid params");
        }
        const historyLength = request.params?.historyLength;
        if (
          historyLength !== undefined &&
          (!Number.isSafeInteger(historyLength) || historyLength < 0)
        ) {
          return jsonRpcError(requestId, -32602, "Invalid params");
        }
        const task = await bridge.getTask({ senderAgentId: peer.id, taskId });
        return jsonRpcResult(requestId, taskView(task, historyLength));
      }
      const pageSize = request.params?.pageSize ?? 50;
      const pageToken = request.params?.pageToken;
      const contextId = request.params?.contextId;
      const historyLength = request.params?.historyLength;
      if (
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 64 ||
        (pageToken !== undefined && typeof pageToken !== "string") ||
        (contextId !== undefined && (typeof contextId !== "string" || contextId.length === 0)) ||
        (historyLength !== undefined && (!Number.isSafeInteger(historyLength) || historyLength < 0))
      ) {
        return jsonRpcError(requestId, -32602, "Invalid params");
      }
      const page = await bridge.listTasks({
        senderAgentId: peer.id,
        ...(contextId === undefined ? {} : { contextId }),
        limit: pageSize,
        ...(pageToken === undefined || pageToken === "" ? {} : { after: pageToken }),
      });
      return jsonRpcResult(requestId, {
        tasks: page.tasks.map((task) => taskView(task, historyLength)),
        ...(page.nextCursor == null ? {} : { nextPageToken: page.nextCursor }),
      });
    } catch (error) {
      return bridgeFailure(requestId, error);
    }

    };
}


module.exports = {
  A2A_PROTOCOL_VERSION,
  DEFAULT_LIMITS,
  MESH_PROFILE_PATH,
  buildAgentCard,
  createMeshPeerIntrospector,
  createProtocolHandler,
  preflightProtocolRequest,
};
