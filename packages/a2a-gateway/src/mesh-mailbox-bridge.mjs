import crypto from "node:crypto";

const MAX_ID_BYTES = 180;
const MAX_AGENT_ID_BYTES = 120;
const MAX_TEXT_BYTES = 12 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TASK_PAGE_SIZE = 64;
const MAX_HISTORY_EVENTS = 100;
const MAX_HISTORY_PAGES = 100;
const MAX_TASK_CONTINUATIONS = 64;
const MAX_TASK_CORRELATION_FETCH = MAX_TASK_CONTINUATIONS + 1;
const MAX_PROJECTION_REQUESTS = 1 + (MAX_TASK_PAGE_SIZE * 2);
const MAX_PROJECTION_EVENTS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MIN_REQUEST_TIMEOUT_MS = 10;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const PEER_TICKET = /^mesh_peer_[A-Za-z0-9._~-]+$/;
const PUBLIC_UPSTREAM_ERRORS = new Set([
  "body_too_large",
  "idempotency_conflict",
  "insufficient_scope",
  "invalid_request",
  "peer_ticket_invalid",
  "quota_exceeded",
  "rate_limited",
  "recipient_not_accepting_direct_messages",
]);

export class MeshMailboxBridgeError extends Error {
  constructor(code, { status = 502 } = {}) {
    super(code === "idempotency_conflict"
      ? "Idempotency identity refers to different content"
      : code === "task_not_found"
        ? "Task not found"
        : "MESH mailbox bridge request failed");
    this.name = "MeshMailboxBridgeError";
    this.code = code;
    this.status = status;
  }
}

function requiredText(value, name, maxBytes) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > maxBytes
  ) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${name} contains unexpected fields`);
  }
}

function normalizedOrigin(value) {
  const url = new URL(requiredText(value, "meshOrigin", 2048));
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !local) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("meshOrigin must be an HTTPS origin");
  }
  return url.origin;
}

function normalizedMessage(value) {
  const expected = value?.taskId === undefined
    ? ["contextId", "messageId", "text"]
    : ["contextId", "messageId", "taskId", "text"];
  exactKeys(value, expected, "message");
  return Object.freeze({
    messageId: requiredText(value.messageId, "messageId", MAX_ID_BYTES),
    contextId: requiredText(value.contextId, "contextId", MAX_ID_BYTES),
    ...(value.taskId === undefined
      ? {}
      : { taskId: requiredText(value.taskId, "taskId", MAX_ID_BYTES) }),
    text: requiredText(value.text, "text", MAX_TEXT_BYTES),
  });
}

function derivedTaskId(senderAgentId, message) {
  if (message.taskId) return message.taskId;
  return `task_${crypto
    .createHash("sha256")
    .update(JSON.stringify([senderAgentId, message.contextId, message.messageId]))
    .digest("base64url")
    .slice(0, 32)}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function payloadHash(recipientAgentId, message) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson({ recipient_agent_id: recipientAgentId, message }))
    .digest("hex");
}

function canonicalMessage(message, taskId) {
  return Object.freeze({
    messageId: message.messageId,
    contextId: message.contextId,
    taskId,
    text: message.text,
  });
}

function submittedTask(correlation) {
  return Object.freeze({
    id: correlation.taskId,
    contextId: correlation.contextId,
    status: Object.freeze({ state: "TASK_STATE_SUBMITTED" }),
  });
}

function canonicalCorrelation(value, expected = {}) {
  const keys = [
    "senderAgentId", "contextId", "taskId", "messageId", "meshRoomId",
    "meshEventId", "meshEventSequence", "payloadHash", "createdAt", "updatedAt",
  ];
  try {
    exactKeys(value, keys, "correlation");
    const correlation = Object.freeze({
      senderAgentId: requiredText(value.senderAgentId, "correlation.senderAgentId", MAX_AGENT_ID_BYTES),
      contextId: requiredText(value.contextId, "correlation.contextId", MAX_ID_BYTES),
      taskId: requiredText(value.taskId, "correlation.taskId", MAX_ID_BYTES),
      messageId: requiredText(value.messageId, "correlation.messageId", MAX_ID_BYTES),
      meshRoomId: requiredText(value.meshRoomId, "correlation.meshRoomId", 120),
      meshEventId: requiredText(value.meshEventId, "correlation.meshEventId", 120),
      meshEventSequence: value.meshEventSequence,
      payloadHash: value.payloadHash,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    });
    const canonicalTimestamp = (timestamp) => {
      if (typeof timestamp !== "string") return false;
      const instant = new Date(timestamp);
      return !Number.isNaN(instant.valueOf()) && instant.toISOString() === timestamp;
    };
    const createdAtMs = Date.parse(correlation.createdAt);
    const updatedAtMs = Date.parse(correlation.updatedAt);
    if (
      !Number.isSafeInteger(correlation.meshEventSequence) ||
      correlation.meshEventSequence < 1 ||
      typeof correlation.payloadHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(correlation.payloadHash) ||
      !canonicalTimestamp(correlation.createdAt) ||
      !canonicalTimestamp(correlation.updatedAt) ||
      updatedAtMs < createdAtMs ||
      createdAtMs > Date.now() + MAX_CLOCK_SKEW_MS ||
      updatedAtMs > Date.now() + MAX_CLOCK_SKEW_MS ||
      Object.entries(expected).some(([key, wanted]) => correlation[key] !== wanted)
    ) {
      throw new TypeError();
    }
    return correlation;
  } catch {
    throw new MeshMailboxBridgeError("mesh_invalid_response");
  }
}

function correlationItems(payload, maximum, expected = {}) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray(payload.items) ||
    payload.items.length > maximum
  ) {
    throw new MeshMailboxBridgeError("mesh_invalid_response");
  }
  return payload.items.map((item) => canonicalCorrelation(item, expected));
}

function sameCorrelation(left, right) {
  return left.senderAgentId === right.senderAgentId &&
    left.contextId === right.contextId &&
    left.taskId === right.taskId &&
    left.messageId === right.messageId &&
    left.meshRoomId === right.meshRoomId &&
    left.meshEventId === right.meshEventId &&
    left.meshEventSequence === right.meshEventSequence &&
    left.payloadHash === right.payloadHash &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt;
}

function exactResponseKeys(payload, keys, name) {
  try {
    exactKeys(payload, keys, name);
  } catch {
    throw new MeshMailboxBridgeError("mesh_invalid_response");
  }
}

function cancelBestEffort(reader) {
  try {
    Promise.resolve(reader.cancel()).catch(() => {});
  } catch {}
}

async function boundedJson(response, deadline) {
  if (!response.body) throw new MeshMailboxBridgeError("mesh_invalid_response");
  const reader = response.body.getReader();
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    cancelBestEffort(reader);
    throw new MeshMailboxBridgeError("mesh_invalid_response");
  }
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        cancelBestEffort(reader);
        throw new MeshMailboxBridgeError("mesh_invalid_response");
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelBestEffort(reader);
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
  } catch {
    throw new MeshMailboxBridgeError("mesh_invalid_response");
  }
}

function upstreamError(response, payload) {
  if (response.status >= 500) {
    return new MeshMailboxBridgeError("mesh_unavailable", { status: 503 });
  }
  const code = PUBLIC_UPSTREAM_ERRORS.has(payload?.error)
    ? payload.error
    : "mesh_request_rejected";
  return new MeshMailboxBridgeError(code, { status: response.status });
}

function validEvent(value, roomId, previousSequence) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const id = requiredText(value.id, "event.id", 120);
    const eventRoomId = requiredText(value.roomId, "event.roomId", 120);
    const senderAgentId = requiredText(value.senderAgentId, "event.senderAgentId", 120);
    if (
      eventRoomId !== roomId ||
      value.type !== "message.created" ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence <= previousSequence ||
      !value.body ||
      typeof value.body !== "object" ||
      Array.isArray(value.body)
    ) {
      return null;
    }
    return { ...value, id, roomId: eventRoomId, senderAgentId };
  } catch {
    return null;
  }
}

function historyEvents(correlation, payload, afterSequence) {
  if (
    !payload ||
    payload.roomId !== correlation.meshRoomId ||
    !Array.isArray(payload.items) ||
    payload.items.length > MAX_HISTORY_EVENTS
  ) {
    throw new MeshMailboxBridgeError("mesh_invalid_response");
  }
  const events = [];
  let previousSequence = afterSequence;
  for (const candidate of payload.items) {
    const event = validEvent(candidate, correlation.meshRoomId, previousSequence);
    if (!event) throw new MeshMailboxBridgeError("mesh_invalid_response");
    previousSequence = event.sequence;
    events.push(event);
  }
  return events;
}

function replyMessage(correlation, events, recipientAgentId) {
  const reply = events.find((event) =>
    event.senderAgentId === recipientAgentId &&
    event.body.inReplyToEventId === correlation.meshEventId &&
    event.body.replyRequired === false &&
    typeof event.body.text === "string" &&
    event.body.text.trim() &&
    Buffer.byteLength(event.body.text) <= 64 * 1024
  );
  if (!reply) return null;
  const message = Object.freeze({
    messageId: reply.id,
    contextId: correlation.contextId,
    taskId: correlation.taskId,
    role: "ROLE_AGENT",
    parts: Object.freeze([Object.freeze({ text: reply.body.text })]),
  });
  return message;
}

export function createMeshMailboxBridge({
  meshOrigin,
  recipientAgentId,
  meshAgentToken,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const origin = normalizedOrigin(meshOrigin);
  const recipient = requiredText(
    recipientAgentId,
    "recipientAgentId",
    MAX_AGENT_ID_BYTES,
  );
  const agentToken = requiredText(meshAgentToken, "meshAgentToken", 2048);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS ||
    requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new TypeError(
      `requestTimeoutMs must be between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
  function projectionBudget() {
    return {
      expiresAt: Date.now() + requestTimeoutMs,
      requests: 0,
      events: 0,
    };
  }

  async function meshRequest(path, { method = "GET", token, body, budget } = {}) {
    if (budget) {
      budget.requests += 1;
      if (budget.requests > MAX_PROJECTION_REQUESTS) {
        throw new MeshMailboxBridgeError("mesh_invalid_response");
      }
    }
    const controller = new AbortController();
    let timeoutId;
    const remainingMs = budget
      ? Math.min(requestTimeoutMs, budget.expiresAt - Date.now())
      : requestTimeoutMs;
    if (remainingMs <= 0) {
      throw new MeshMailboxBridgeError("mesh_unavailable", { status: 503 });
    }
    const deadline = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("MESH request deadline exceeded"));
      }, remainingMs);
    });
    try {
      const response = await Promise.race([fetchImpl(new Request(new URL(path, `${origin}/`), {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })), deadline]);
      const payload = await boundedJson(response, deadline);
      if (!response.ok) throw upstreamError(response, payload);
      return payload;
    } catch (error) {
      if (error instanceof MeshMailboxBridgeError) throw error;
      throw new MeshMailboxBridgeError("mesh_unavailable", { status: 503 });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function sendMessage(input) {
    exactKeys(input, ["peerToken", "senderAgentId", "message"], "sendMessage input");
    const peerToken = requiredText(input.peerToken, "peerToken", 2048);
    if (!PEER_TICKET.test(peerToken)) throw new TypeError("peerToken is invalid");
    const senderAgentId = requiredText(
      input.senderAgentId,
      "senderAgentId",
      MAX_AGENT_ID_BYTES,
    );
    const inputMessage = normalizedMessage(input.message);
    const taskId = derivedTaskId(senderAgentId, inputMessage);
    const message = canonicalMessage(inputMessage, taskId);
    const hash = payloadHash(recipient, message);
    const payload = await meshRequest("/api/v1/a2a/bridge", {
      method: "POST",
      token: peerToken,
      body: { recipient_agent_id: recipient, message },
    });
    let authenticatedSenderAgentId;
    let meshRoomId;
    let meshEventId;
    try {
      exactKeys(payload, ["senderAgentId", "room", "event", "correlation"], "bridge response");
      exactKeys(payload.room, ["id"], "bridge response room");
      exactKeys(payload.event, ["id", "sequence"], "bridge response event");
      authenticatedSenderAgentId = requiredText(
        payload?.senderAgentId,
        "senderAgentId",
        MAX_AGENT_ID_BYTES,
      );
      meshRoomId = requiredText(payload?.room?.id, "room.id", 120);
      meshEventId = requiredText(payload?.event?.id, "event.id", 120);
      if (!Number.isSafeInteger(payload?.event?.sequence) || payload.event.sequence < 1) {
        throw new TypeError();
      }
      if (authenticatedSenderAgentId !== senderAgentId) {
        throw new MeshMailboxBridgeError("mesh_request_rejected", { status: 403 });
      }
    } catch {
      if (
        typeof payload?.senderAgentId === "string" &&
        payload.senderAgentId !== senderAgentId
      ) {
        throw new MeshMailboxBridgeError("mesh_request_rejected", { status: 403 });
      }
      throw new MeshMailboxBridgeError("mesh_invalid_response");
    }
    const correlation = canonicalCorrelation(payload?.correlation, {
      senderAgentId,
      contextId: message.contextId,
      taskId,
      messageId: message.messageId,
      meshRoomId,
      meshEventId,
      meshEventSequence: payload.event.sequence,
      payloadHash: hash,
    });
    return submittedTask(correlation);
  }

  async function getTask(input) {
    exactKeys(input, ["senderAgentId", "taskId"], "getTask input");
    const senderAgentId = requiredText(input.senderAgentId, "senderAgentId", MAX_AGENT_ID_BYTES);
    const taskId = requiredText(input.taskId, "taskId", MAX_ID_BYTES);
    const budget = projectionBudget();
    const payload = await meshRequest(
      `/api/v1/a2a/tasks/${encodeURIComponent(taskId)}/correlations?sender_agent_id=${encodeURIComponent(senderAgentId)}`,
      { token: agentToken, budget },
    );
    exactResponseKeys(payload, ["items"], "task correlations response");
    const taskCorrelations = correlationItems(payload, MAX_TASK_CORRELATION_FETCH, {
      senderAgentId,
      taskId,
    });
    if (taskCorrelations.length === 0) {
      throw new MeshMailboxBridgeError("task_not_found", { status: 404 });
    }
    return projectTask(taskCorrelations, budget, { senderAgentId, taskId });
  }

  async function projectCorrelation(correlation, budget) {
    let afterSequence = correlation.meshEventSequence - 1;
    let inputSeen = false;
    for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
      const payload = await meshRequest(
        `/api/v1/rooms/${encodeURIComponent(correlation.meshRoomId)}/events?after_sequence=${afterSequence}&limit=${MAX_HISTORY_EVENTS}`,
        { token: agentToken, budget },
      );
      const events = historyEvents(correlation, payload, afterSequence);
      budget.events += events.length;
      if (budget.events > MAX_PROJECTION_EVENTS) {
        throw new MeshMailboxBridgeError("mesh_invalid_response");
      }
      inputSeen ||= events.some((event) =>
        event.id === correlation.meshEventId &&
        event.sequence === correlation.meshEventSequence
      );
      const message = replyMessage(correlation, events, recipient);
      if (message && inputSeen) return message;
      if (events.length < MAX_HISTORY_EVENTS) {
        if (!inputSeen) throw new MeshMailboxBridgeError("mesh_invalid_response");
        return null;
      }
      const nextSequence = events.at(-1)?.sequence;
      if (!Number.isSafeInteger(nextSequence) || nextSequence <= afterSequence) {
        throw new MeshMailboxBridgeError("mesh_invalid_response");
      }
      afterSequence = nextSequence;
    }
    throw new MeshMailboxBridgeError("mesh_invalid_response");
  }

  async function projectTask(taskCorrelations, budget, expectedIdentity) {
    if (taskCorrelations.length > MAX_TASK_CONTINUATIONS) {
      throw new MeshMailboxBridgeError("mesh_invalid_response");
    }
    if (taskCorrelations.some((correlation) =>
      !correlation ||
      typeof correlation !== "object" ||
      !Number.isSafeInteger(correlation.meshEventSequence) ||
      correlation.meshEventSequence < 1 ||
      typeof correlation.senderAgentId !== "string" ||
      typeof correlation.taskId !== "string" ||
      typeof correlation.contextId !== "string" ||
      typeof correlation.meshRoomId !== "string" ||
      typeof correlation.messageId !== "string")) {
      throw new MeshMailboxBridgeError("mesh_invalid_response");
    }
    const canonical = [...taskCorrelations].sort((left, right) =>
      left.meshEventSequence - right.meshEventSequence ||
      left.messageId.localeCompare(right.messageId));
    const lineage = canonical[0];
    for (let index = 0; index < canonical.length; index += 1) {
      const correlation = canonical[index];
      const previous = canonical[index - 1];
      if (
        correlation.senderAgentId !== expectedIdentity.senderAgentId ||
        correlation.taskId !== expectedIdentity.taskId ||
        correlation.senderAgentId !== lineage?.senderAgentId ||
        correlation.taskId !== lineage?.taskId ||
        correlation.contextId !== lineage?.contextId ||
        correlation.meshRoomId !== lineage?.meshRoomId ||
        previous?.meshEventSequence === correlation.meshEventSequence
      ) {
        throw new MeshMailboxBridgeError("mesh_invalid_response");
      }
    }
    const messages = [];
    const messageIds = new Set();
    let latestReply = null;
    for (const correlation of canonical) {
      const message = await projectCorrelation(correlation, budget);
      latestReply = message;
      if (message && !messageIds.has(message.messageId)) {
        messageIds.add(message.messageId);
        messages.push(message);
      }
    }
    const latestCorrelation = canonical.at(-1);
    if (!latestReply) {
      if (messages.length === 0) return submittedTask(latestCorrelation);
      return Object.freeze({
        ...submittedTask(latestCorrelation),
        history: Object.freeze(messages),
      });
    }
    return Object.freeze({
      id: latestCorrelation.taskId,
      contextId: latestCorrelation.contextId,
      status: Object.freeze({
        state: "TASK_STATE_COMPLETED",
        message: latestReply,
      }),
      history: Object.freeze(messages),
    });
  }

  async function listTasks(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("listTasks input must be an object");
    }
    const allowed = ["after", "contextId", "limit", "senderAgentId"];
    if (Object.keys(input).some((key) => !allowed.includes(key))) {
      throw new TypeError("listTasks input contains unexpected fields");
    }
    const senderAgentId = requiredText(input.senderAgentId, "senderAgentId", MAX_AGENT_ID_BYTES);
    const contextId = input.contextId === undefined
      ? undefined
      : requiredText(input.contextId, "contextId", MAX_ID_BYTES);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TASK_PAGE_SIZE) {
      throw new TypeError(`limit must be between 1 and ${MAX_TASK_PAGE_SIZE}`);
    }
    const query = new URLSearchParams({ sender_agent_id: senderAgentId, limit: String(limit) });
    if (contextId !== undefined) query.set("context_id", contextId);
    if (input.after !== undefined) query.set("after", requiredText(input.after, "after", 2048));
    const budget = projectionBudget();
    const page = await meshRequest(`/api/v1/a2a/tasks?${query}`, { token: agentToken, budget });
    exactResponseKeys(page, ["items", "nextCursor"], "task list response");
    const pageItems = correlationItems(page, limit, { senderAgentId });
    if (new Set(pageItems.map((item) => item.taskId)).size !== pageItems.length) {
      throw new MeshMailboxBridgeError("mesh_invalid_response");
    }
    if (!(
      page.nextCursor === null ||
      (typeof page.nextCursor === "string" &&
        page.nextCursor.length > 0 &&
        Buffer.byteLength(page.nextCursor) <= 2048 &&
        /^[A-Za-z0-9_-]+$/.test(page.nextCursor))
    )) {
      throw new MeshMailboxBridgeError("mesh_invalid_response");
    }
    const tasks = [];
    for (const correlation of pageItems) {
      const taskPayload = await meshRequest(
        `/api/v1/a2a/tasks/${encodeURIComponent(correlation.taskId)}/correlations?sender_agent_id=${encodeURIComponent(senderAgentId)}`,
        { token: agentToken, budget },
      );
      exactResponseKeys(taskPayload, ["items"], "task correlations response");
      const taskCorrelations = correlationItems(taskPayload, MAX_TASK_CORRELATION_FETCH, {
        senderAgentId,
        taskId: correlation.taskId,
      });
      if (
        taskCorrelations.length === 0 ||
        !taskCorrelations.some((detail) => sameCorrelation(correlation, detail))
      ) {
        throw new MeshMailboxBridgeError("mesh_invalid_response");
      }
      tasks.push(await projectTask(taskCorrelations, budget, {
        senderAgentId,
        taskId: correlation.taskId,
      }));
    }
    return Object.freeze({
      tasks: Object.freeze(tasks),
      nextCursor: page.nextCursor,
    });
  }

  return Object.freeze({ sendMessage, getTask, listTasks });
}
