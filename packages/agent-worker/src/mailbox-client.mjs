import crypto from "node:crypto";

const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 100;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ID_BYTES = 120;
const MAX_TEXT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RECONCILIATION_PAGES = 12;
const MAILBOX_DELIVERY_META = Symbol("mailboxDeliveryMeta");
const AGENT_ID = /^agent_[a-f0-9]{32}$/;
const ROOM_ID = /^room_[a-f0-9]{32}$/;
const EVENT_ID = /^event_[a-f0-9]{32}$/;
const CLAIM_ID = /^claim_[a-f0-9]{32}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ALLOWED_ERROR_CODES = new Set([
  "delivery_claim_conflict",
  "delivery_not_found",
  "delivery_not_pending",
  "invalid_request",
  "mailbox_service_unavailable",
  "rate_limited",
]);

export class MailboxRequestError extends Error {
  constructor(message, { status, mailboxError } = {}) {
    super(message);
    this.name = "MailboxRequestError";
    this.status = status;
    this.mailboxError = ALLOWED_ERROR_CODES.has(mailboxError)
      ? mailboxError
      : undefined;
  }
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function meshOrigin(value) {
  const url = new URL(required(value, "meshUrl"));
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
    throw new TypeError("meshUrl must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function boundedText(value, name, maxBytes = MAX_TEXT_BYTES) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (Buffer.byteLength(value) > maxBytes) {
    throw new TypeError(`${name} is too large`);
  }
  return value;
}

function boundedId(value, name, pattern) {
  const text = required(value, name);
  if (Buffer.byteLength(text) > MAX_ID_BYTES) {
    throw new TypeError(`${name} is too large`);
  }
  if (pattern && !pattern.test(text)) {
    throw new TypeError(`${name} is invalid`);
  }
  return text;
}

function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function parseReplyRequired(value) {
  if (value === undefined) return true;
  return Boolean(value);
}

function boundedJsonByteLength(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BODY_BYTES) {
    throw new TypeError("Mailbox reply body is too large");
  }
}

function validateResult(result) {
  if (
    !result ||
    result.status !== "completed" ||
    typeof result.text !== "string" ||
    !result.text.trim()
  ) {
    throw new TypeError("Runner must return a completed result with non-empty text");
  }
  return result.text.trim();
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickEventIdempotencyKey(event) {
  if (event.idempotency_key !== undefined) {
    return event.idempotency_key;
  }
  if (event.idempotencyKey !== undefined) {
    return event.idempotencyKey;
  }
  return undefined;
}

function deterministicMailboxReplyMessageId(message) {
  const identity = {
    recipientId: message.recipientId,
    senderId: message.senderId,
    messageId: message.messageId,
    taskId: message.taskId,
    contextId: message.contextId,
  };
  return `reply_${crypto
    .createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("base64url")}`;
}

function normalizedRequest(message) {
  return {
    messageId: message.messageId,
    taskId: message.taskId,
    contextId: message.contextId,
    senderId: message.senderId,
    recipientId: message.recipientId,
    text: message.text,
    replyRequired: true,
  };
}

function assertResponse(response, payload) {
  if (!response.ok) {
    throw new MailboxRequestError(
      `Mailbox request failed with status ${response.status}`,
      {
        status: response.status,
        mailboxError:
          typeof payload?.error === "string" ? payload.error : undefined,
      },
    );
  }
}

async function readBoundedJson(response, fallbackStatus, observeReader = () => {}) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new MailboxRequestError("Mailbox response is too large", {
      status: fallbackStatus ?? response.status,
    });
  }

  const reader = response.body?.getReader?.();
  observeReader(reader);
  if (!reader) {
    const payload = await response.text();
    if (Buffer.byteLength(payload) > MAX_RESPONSE_BYTES) {
      throw new MailboxRequestError("Mailbox response is too large", {
        status: fallbackStatus ?? response.status,
      });
    }
    try {
      return JSON.parse(payload);
    } catch {
      throw new MailboxRequestError("Mailbox returned invalid JSON", {
        status: fallbackStatus ?? response.status,
      });
    }
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MailboxRequestError("Mailbox response is too large", {
          status: fallbackStatus ?? response.status,
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MailboxRequestError) throw error;
    throw new MailboxRequestError("Mailbox returned invalid response body", {
      status: fallbackStatus ?? response.status,
    });
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let payloadText;
  try {
    payloadText = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new MailboxRequestError("Mailbox returned invalid JSON", {
      status: fallbackStatus ?? response.status,
    });
  }

  try {
    return JSON.parse(payloadText);
  } catch {
    throw new MailboxRequestError("Mailbox returned invalid JSON", {
      status: fallbackStatus ?? response.status,
    });
  }
}

function validateMailboxDelivery(delivery, workerId) {
  if (!isObject(delivery)) {
    throw new MailboxRequestError("Mailbox response is invalid");
  }
  const deliveryId = validatePositiveInteger(
    delivery.deliveryId,
    "deliveryId",
  );
  const roomId = boundedId(delivery.roomId, "roomId", ROOM_ID);
  const eventId = boundedId(delivery.eventId, "eventId", EVENT_ID);
  const roomSequence = validatePositiveInteger(
    delivery.roomSequence,
    "roomSequence",
  );
  const state = required(delivery.state, "state");
  if (state !== "pending") {
    throw new MailboxRequestError("Mailbox delivery must be pending");
  }
  return {
    id: deliveryId,
    roomId,
    eventId,
    roomSequence,
    recipientId: workerId,
  };
}

function validateRoomEvent(event, expectedRoomId, expectedSequence, expectedEventId, workerId) {
  if (!isObject(event)) {
    throw new MailboxRequestError("Mailbox history response is invalid");
  }
  const roomId = boundedId(event.roomId, "roomId", ROOM_ID);
  const sequence = validatePositiveInteger(event.sequence, "roomSequence");
  const senderAgentId = required(event.senderAgentId, "senderAgentId");
  const eventId = boundedId(event.id, "eventId", EVENT_ID);
  const type = required(event.type, "type");
  if (roomId !== expectedRoomId || sequence !== expectedSequence || eventId !== expectedEventId) {
    throw new MailboxRequestError("Mailbox event cursor mismatch");
  }
  if (type !== "message.created") {
    throw new MailboxRequestError("Mailbox event type is unsupported");
  }
  if (senderAgentId === workerId) {
    throw new MailboxRequestError("Mailbox delivery sender must not be this worker");
  }
  const body = event.body;
  if (!isObject(body)) {
    throw new MailboxRequestError("Mailbox event body is invalid");
  }
  if (
    !Object.hasOwn(body, "text") ||
    typeof body.text !== "string" ||
    !body.text.trim()
  ) {
    throw new MailboxRequestError("Mailbox event body has no reply text");
  }
  const text = boundedText(body.text, "text");
  return {
    id: eventId,
    roomId,
    sequence,
    senderId: boundedId(senderAgentId, "senderId", AGENT_ID),
    text,
    replyRequired: parseReplyRequired(body.replyRequired),
  };
}

function isSkipEventError(error) {
  if (!(error instanceof MailboxRequestError)) return false;
  return (
    error.message === "Mailbox event type is unsupported" ||
    error.message === "Mailbox event body is invalid" ||
    error.message === "Mailbox event body has no reply text"
  );
}

export function validateMailboxClientOptions(
  { meshUrl, meshToken, recipientId, pageLimit = DEFAULT_LIMIT } = {},
) {
  const origin = meshOrigin(meshUrl);
  const token = required(meshToken, "meshToken");
  const workerId = boundedId(recipientId, "recipientId", AGENT_ID);
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_LIMIT) {
    throw new TypeError(`pageLimit must be between 1 and ${MAX_LIMIT}`);
  }
  return Object.freeze({
    meshUrl: origin,
    meshToken: token,
    recipientId: workerId,
    pageLimit,
  });
}

export function createMailboxClient(
  options,
  { fetchImpl = globalThis.fetch, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  const {
    meshUrl: origin,
    meshToken: token,
    recipientId: workerId,
    pageLimit,
  } = validateMailboxClientOptions(options);
  validatePositiveInteger(requestTimeoutMs, "requestTimeoutMs");
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  let identityPromise;
  const activeDeliveries = new Map();
  // This process may retry only claims it won itself. The queue is deliberately
  // memory-only: after a process crash the durable claim remains fail-closed and
  // is never released or exposed to a different worker automatically.
  const retryDeliveries = new Map();

  async function request(path, { method = "GET", body, signal } = {}) {
    const controller = new AbortController();
    let reader;
    let timedOut = false;
    let callerAborted = false;
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      try {
        Promise.resolve(reader?.cancel?.()).catch(() => {});
      } catch {}
      rejectDeadline(new MailboxRequestError("Mailbox request timed out"));
    }, requestTimeoutMs);
    const abort = () => {
      callerAborted = true;
      controller.abort();
      rejectDeadline(new MailboxRequestError("Mailbox request aborted"));
    };
    signal?.addEventListener?.("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const fetchPromise = Promise.resolve(fetchImpl(
        new Request(new URL(path, `${origin}/`), {
          method,
          cache: "no-store",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          signal: controller.signal,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      ));
      const response = await Promise.race([fetchPromise, deadline]);
      const bodyPromise = readBoundedJson(response, response.status, (value) => {
        reader = value;
      });
      const payload = await Promise.race([bodyPromise, deadline]);
      assertResponse(response, payload);
      return payload;
    } catch (error) {
      if (timedOut) {
        throw new MailboxRequestError("Mailbox request timed out");
      }
      if (callerAborted || error?.name === "AbortError") {
        throw new MailboxRequestError("Mailbox request aborted");
      }
      if (String(error?.message ?? error).includes(token)) {
        throw new MailboxRequestError("Mailbox request failed");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abort);
    }
  }

  async function ensureActorIdentity(signal) {
    if (identityPromise !== undefined) return identityPromise;
    identityPromise = (async () => {
      const response = await request("/api/v1/agents/me", { signal });
      if (!response?.agent || typeof response.agent.id !== "string") {
        throw new MailboxRequestError("Mailbox actor identity is invalid");
      }
      const actorId = boundedId(response.agent.id, "agent.id", AGENT_ID);
      if (actorId !== workerId) {
        throw new MailboxRequestError(
          "Configured recipientId does not match authenticated actor",
        );
      }
      return actorId;
    })();

    try {
      return await identityPromise;
    } catch (error) {
      identityPromise = undefined;
      throw error;
    }
  }

  async function listRoomEvent(roomId, roomSequence, eventId, signal) {
    const query = new URLSearchParams({
      after_sequence: String(Math.max(0, roomSequence - 1)),
      limit: "1",
    });
    const page = await request(`/api/v1/rooms/${encodeURIComponent(roomId)}/events?${query}`, { signal });
    if (!isObject(page) || page.roomId !== roomId || !Array.isArray(page.items)) {
      throw new MailboxRequestError("Mailbox history response is invalid");
    }
    const [event] = page.items;
    if (!event) {
      throw new MailboxRequestError("Mailbox history response is empty");
    }
    return validateRoomEvent(event, roomId, roomSequence, eventId, workerId);
  }

  async function findExistingReply(roomId, replyMessageId, startSequence = 0, signal) {
    let afterSequence = Math.max(0, startSequence);
    const limit = 100;
    let pagesScanned = 0;
    let lastSequence = 0;
    while (pagesScanned < MAX_RECONCILIATION_PAGES) {
      const query = new URLSearchParams({
        after_sequence: String(afterSequence),
        limit: String(limit),
      });
      const page = await request(`/api/v1/rooms/${encodeURIComponent(roomId)}/events?${query}`, { signal });
      pagesScanned += 1;
      if (!isObject(page) || page.roomId !== roomId || !Array.isArray(page.items)) {
        throw new MailboxRequestError("Mailbox history response is invalid");
      }

      for (const event of page.items) {
        if (!isObject(event)) continue;
        if (
          event.senderAgentId === workerId &&
          pickEventIdempotencyKey(event) === replyMessageId
        ) {
          return {
            found: true,
            eventId: boundedId(event.id, "eventId", EVENT_ID),
          };
        }
      }

      if (page.items.length < limit) {
        return { found: false };
      }

      const lastEvent = page.items[page.items.length - 1];
      if (!isObject(lastEvent)) break;
      const nextSequence = validatePositiveInteger(lastEvent.sequence, "roomSequence");
      if (nextSequence <= afterSequence || nextSequence === lastSequence) {
        throw new MailboxRequestError("Mailbox history scan did not progress");
      }
      lastSequence = nextSequence;
      afterSequence = nextSequence;
    }
    throw new MailboxRequestError("Mailbox history reconciliation scan exceeded safe bounds");
  }

  function buildReplyPayload(message, replyText, replyMessageId) {
    const payload = {
      type: "message.created",
      body: {
        text: replyText,
        replyRequired: false,
        inReplyToEventId: message.messageId,
      },
      idempotency_key: replyMessageId,
    };
    boundedJsonByteLength(payload);
    return payload;
  }

  function validateAppendResponse(message, replyText, replyMessageId, response) {
    if (!response || !isObject(response.event)) {
      throw new MailboxRequestError("Mailbox reply persistence returned invalid event");
    }
    const event = response.event;
    const eventRoomId = boundedId(event.roomId, "roomId", ROOM_ID);
    validatePositiveInteger(event.sequence, "roomSequence");
    boundedId(event.id, "eventId", EVENT_ID);
    if (eventRoomId !== message.contextId) {
      throw new MailboxRequestError("Mailbox reply persistence returned invalid event");
    }
    if (event.type !== "message.created") {
      throw new MailboxRequestError("Mailbox reply persistence returned invalid event");
    }
    const senderAgentId = boundedId(event.senderAgentId, "senderAgentId", AGENT_ID);
    if (senderAgentId !== workerId) {
      throw new MailboxRequestError("Mailbox reply persistence returned invalid event");
    }
    const eventIdempotencyKey = pickEventIdempotencyKey(event);
    if (eventIdempotencyKey !== replyMessageId) {
      throw new MailboxRequestError("Mailbox reply persistence returned invalid event");
    }
    const body = event.body;
    if (!isObject(body)) {
      throw new MailboxRequestError("Mailbox reply persistence returned invalid event");
    }
    if (body.text !== replyText) {
      throw new MailboxRequestError("Mailbox reply persistence returned invalid event");
    }
    boundedText(body.text, "text");
    if (body.replyRequired !== false) {
      throw new MailboxRequestError("Mailbox reply persistence returned invalid event");
    }
    if (boundedId(body.inReplyToEventId, "inReplyToEventId", EVENT_ID) !== message.messageId) {
      throw new MailboxRequestError("Mailbox reply persistence returned invalid event");
    }
    return { eventId: event.id, sequence: event.sequence };
  }

  async function appendReply(message, replyText, replyMessageId, signal) {
    const payload = buildReplyPayload(message, replyText, replyMessageId);
    const response = await request(`/api/v1/rooms/${encodeURIComponent(message.contextId)}/events`, {
      method: "POST",
      body: payload,
      signal,
    });
    return validateAppendResponse(message, replyText, replyMessageId, response);
  }

  async function ackDelivery(deliveryId, signal) {
    const response = await request("/api/v1/mailbox/ack", {
      method: "POST",
      body: {
        delivery_ids: [deliveryId],
        status: "processed",
      },
      signal,
    });
    if (
      !response ||
      !Number.isSafeInteger(response.acknowledged) ||
      response.acknowledged < 0 ||
      response.acknowledged > 1
    ) {
      throw new MailboxRequestError("Mailbox did not confirm acknowledgement");
    }
  }

  async function claimDelivery(deliveryId, claimId, signal) {
    try {
      const response = await request("/api/v1/mailbox/claim", {
        method: "POST",
        body: { delivery_id: deliveryId, claim_id: claimId },
        signal,
      });
      if (
        !isObject(response) ||
        response.claimed !== true ||
        typeof response.claimId !== "string" ||
        !CLAIM_ID.test(response.claimId) ||
        response.claimId !== claimId ||
        typeof response.claimedAt !== "string" ||
        !CANONICAL_TIMESTAMP.test(response.claimedAt) ||
        !Number.isFinite(Date.parse(response.claimedAt)) ||
        typeof response.idempotent !== "boolean"
      ) {
        throw new MailboxRequestError("Mailbox claim response is invalid");
      }
      return true;
    } catch (error) {
      if (
        error instanceof MailboxRequestError &&
        error.status === 409 &&
        error.mailboxError === "delivery_claim_conflict"
      ) {
        return false;
      }
      throw error;
    }
  }

  function isDefinitiveClaimDenial(error) {
    if (!(error instanceof MailboxRequestError)) return false;
    if (error.status === 401 || error.status === 403) return true;
    return (
      (error.status === 400 && error.mailboxError === "invalid_request") ||
      (error.status === 404 && error.mailboxError === "delivery_not_found") ||
      (error.status === 409 && error.mailboxError === "delivery_not_pending")
    );
  }

  async function establishClaim(message, metadata, signal) {
    // Claim responses can be lost after the server commits. Retain the exact
    // message and claim ID before the request so only this process can retry
    // that ambiguous outcome idempotently.
    retryDeliveries.set(metadata.id, message);
    try {
      if (await claimDelivery(metadata.id, metadata.claimId, signal)) {
        return true;
      }
      retryDeliveries.delete(metadata.id);
      return false;
    } catch (error) {
      if (isDefinitiveClaimDenial(error)) {
        retryDeliveries.delete(metadata.id);
      }
      throw error;
    }
  }

  async function listUnread({ signal } = {}) {
    await ensureActorIdentity(signal);
    if (retryDeliveries.size > 0) {
      return Array.from(retryDeliveries.values()).slice(0, pageLimit);
    }
    const query = new URLSearchParams({
      after: "0",
      limit: String(pageLimit),
    });
    const page = await request(`/api/v1/mailbox?${query}`, { signal });
    if (!isObject(page) || !Array.isArray(page.items)) {
      throw new MailboxRequestError("Mailbox response is invalid");
    }

    const messages = [];
    for (const delivery of page.items) {
      const normalizedDelivery = validateMailboxDelivery(delivery, workerId);
      let normalizedEvent;
      try {
        normalizedEvent = await listRoomEvent(
          normalizedDelivery.roomId,
          normalizedDelivery.roomSequence,
          normalizedDelivery.eventId,
          signal,
        );
      } catch (error) {
        if (isSkipEventError(error)) {
          await ackDelivery(normalizedDelivery.id, signal);
          continue;
        }
        throw error;
      }

      const message = {
        messageId: normalizedEvent.id,
        taskId: normalizedEvent.id,
        contextId: normalizedEvent.roomId,
        senderId: normalizedEvent.senderId,
        recipientId: workerId,
        text: normalizedEvent.text,
        replyRequired: normalizedEvent.replyRequired,
      };
      Object.defineProperty(message, MAILBOX_DELIVERY_META, {
        value: {
          ...normalizedDelivery,
          claimId: `claim_${crypto.randomBytes(16).toString("hex")}`,
        },
        enumerable: false,
      });
      messages.push(message);
    }

    return messages;
  }

  async function executeDelivery(message, generate, signal) {
    if (!message || typeof message !== "object") {
      throw new TypeError("message must be an object");
    }
    const metadata = message[MAILBOX_DELIVERY_META];
    if (!metadata) {
      throw new TypeError("Mailbox message is missing delivery metadata");
    }
    if (typeof generate !== "function") {
      throw new TypeError("generate must be a function");
    }
    await ensureActorIdentity(signal);

    if (!Number.isSafeInteger(metadata.id) || metadata.id <= 0) {
      throw new TypeError("Mailbox delivery metadata is invalid");
    }

    const normalized = {
      ...message,
      messageId: boundedId(message.messageId, "messageId", EVENT_ID),
      taskId: boundedId(message.taskId, "taskId", EVENT_ID),
      contextId: boundedId(message.contextId, "contextId", ROOM_ID),
      senderId: boundedId(message.senderId, "senderId", AGENT_ID),
      recipientId: boundedId(message.recipientId, "recipientId", AGENT_ID),
      text: boundedText(message.text, "text"),
      replyRequired: parseReplyRequired(message.replyRequired),
    };

    if (normalized.recipientId !== workerId) {
      throw new TypeError(
        "Mailbox message recipientId does not match worker identity",
      );
    }

    if (normalized.replyRequired === false) {
      if (!(await establishClaim(message, metadata, signal))) {
        return { claimed: false, reconciled: false, acknowledged: false };
      }
      await ackDelivery(metadata.id, signal);
      retryDeliveries.delete(metadata.id);
      return {
        reconciled: false,
        acknowledged: true,
      };
    }

    const replyMessageId = deterministicMailboxReplyMessageId(normalized);
    if (!(await establishClaim(message, metadata, signal))) {
      return { claimed: false, reconciled: false, acknowledged: false };
    }
    const existing = await findExistingReply(
      normalized.contextId,
      replyMessageId,
      metadata.roomSequence,
      signal,
    );
    if (!existing.found) {
      // Runner calls are at-least-once; adapters must dedupe using messageId/taskId.
      const replyText = validateResult(await generate(normalizedRequest(normalized), { signal }));
      // Runner execution is at-least-once for mailbox polling; adapters must dedupe by message/task identity.
      await appendReply(normalized, replyText, replyMessageId, signal);
    }

    await ackDelivery(metadata.id, signal);
    retryDeliveries.delete(metadata.id);
    return {
      reconciled: existing.found,
      acknowledged: true,
    };
  }

  function completeAndAcknowledge(message, generate, { signal } = {}) {
    const metadata = message?.[MAILBOX_DELIVERY_META];
    const key = metadata?.id;
    if (Number.isSafeInteger(key) && activeDeliveries.has(key)) {
      return activeDeliveries.get(key);
    }
    const operation = executeDelivery(message, generate, signal).finally(() => {
      if (Number.isSafeInteger(key)) activeDeliveries.delete(key);
    });
    if (Number.isSafeInteger(key)) activeDeliveries.set(key, operation);
    return operation;
  }

  return {
    listUnread,
    completeAndAcknowledge,
  };
}
