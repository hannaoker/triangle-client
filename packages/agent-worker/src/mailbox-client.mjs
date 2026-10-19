import crypto from "node:crypto";

// One JWS/DPoP implementation for the whole client (permissions v1): the
// triangle-cli protocol core. Bundled into every worker (installer manifest v8).
import { compactJws, assertPrivateJwk } from "../../triangle-cli/src/keys.mjs";
import { WORKLOAD_ID, WORKLOAD_TOKEN_PROOF_PROFILE, workloadScopes } from "../../triangle-cli/src/protocol.mjs";
import { dpopProof } from "../../triangle-cli/src/workload.mjs";

const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 100;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ID_BYTES = 120;
const MAX_TEXT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RECONCILIATION_PAGES = 12;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;
const DEFAULT_MAX_ACK_ATTEMPTS = 8;
const DEFAULT_MAX_LIST_ATTEMPTS = 3;
const LEASE_RENEW_MARGIN_MS = 15_000;
const MIN_LEASE_RENEW_DELAY_MS = 250;
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
// Structured permissions-v1 refusals (§1.4) the worker surfaces as-is.
const MESH_ERROR_CODES = new Set([
  "agent_auth_required",
  "agent_paused",
  "dpop_replay",
  "invalid_workload_proof",
  "permission_denied",
  "workload_forbidden",
]);
const PERMISSION_KEY = /^[a-z]+(?:\.[a-z]+)+$/;

export class MailboxRequestError extends Error {
  constructor(message, { status, mailboxError, meshError, permission } = {}) {
    super(message);
    this.name = "MailboxRequestError";
    this.status = status;
    this.mailboxError = ALLOWED_ERROR_CODES.has(mailboxError)
      ? mailboxError
      : undefined;
    const code = meshError ?? mailboxError;
    this.meshError = MESH_ERROR_CODES.has(code) ? code : undefined;
    this.permission =
      this.meshError === "permission_denied" && typeof permission === "string" && PERMISSION_KEY.test(permission)
        ? permission
        : undefined;
  }
}

function describeRefusal(status, payload) {
  const code = typeof payload?.error === "string" ? payload.error : undefined;
  if (code === "permission_denied") {
    const key = typeof payload?.permission === "string" && PERMISSION_KEY.test(payload.permission) ? payload.permission : null;
    return `Not allowed by this agent's permissions${key ? `: ${key} is off (its owner can turn it on with \`triangle permissions set <agent> ${key}=on\`)` : ""}`;
  }
  if (code === "agent_paused") return "This agent is paused by its owner (`triangle agent resume` turns it back on)";
  if (code === "agent_auth_required") return "This agent's workload credential was refused (check `triangle doctor`)";
  return `Mailbox request failed with status ${status}`;
}

export class MailboxOwnershipError extends MailboxRequestError {
  constructor(message = "Mailbox claim ownership was lost") {
    super(message);
    this.name = "MailboxOwnershipError";
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
      describeRefusal(response.status, payload),
      {
        status: response.status,
        mailboxError:
          typeof payload?.error === "string" ? payload.error : undefined,
        permission: payload?.permission,
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
  {
    meshUrl,
    recipientId,
    pageLimit = DEFAULT_LIMIT,
    workloadId,
    workloadPrivateKey,
    workloadScopes: scopes,
    ...rest
  } = {},
) {
  // Permissions v1: the worker authenticates only with its agent's workload
  // key (WL + DPoP). There is no bearer-token fallback.
  if (Object.hasOwn(rest, "meshToken")) {
    throw new TypeError("meshToken is no longer supported; configure workloadId and workloadPrivateKey");
  }
  const origin = meshOrigin(meshUrl);
  const workerId = boundedId(recipientId, "recipientId", AGENT_ID);
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_LIMIT) {
    throw new TypeError(`pageLimit must be between 1 and ${MAX_LIMIT}`);
  }
  const id = required(workloadId, "workloadId");
  if (!WORKLOAD_ID.test(id)) throw new TypeError("workloadId is invalid");
  const key = required(workloadPrivateKey, "workloadPrivateKey");
  parseWorkloadPrivateKey(key);
  return Object.freeze({
    meshUrl: origin,
    recipientId: workerId,
    pageLimit,
    workloadId: id,
    workloadPrivateKey: key,
    // Registered bounds, only when supplied (absent → both, like agent.json).
    ...(scopes === undefined ? {} : { workloadScopes: Object.freeze(workloadScopes(scopes, "workloadScopes")) }),
  });
}

/**
 * The workload private key as the custody stores it: a private Ed25519 JWK
 * (JSON text, as in `agents/<id>/workload-key.json`) or its 43-character
 * base64url `d` seed. Returns the private JWK.
 */
export function parseWorkloadPrivateKey(value) {
  const text = typeof value === "string" ? value.trim() : "";
  let jwk;
  if (/^[A-Za-z0-9_-]{43}$/.test(text)) {
    const seed = Buffer.from(text, "base64url");
    if (seed.length !== 32) throw new TypeError("workloadPrivateKey is invalid");
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der",
      type: "pkcs8",
    });
    const { x } = crypto.createPublicKey(privateKey).export({ format: "jwk" });
    jwk = { crv: "Ed25519", d: text, kty: "OKP", x };
  } else if (text.startsWith("{")) {
    try { jwk = JSON.parse(text); } catch { throw new TypeError("workloadPrivateKey is invalid"); }
  } else {
    throw new TypeError("workloadPrivateKey must be a private Ed25519 JWK or its base64url seed");
  }
  try {
    return assertPrivateJwk(jwk);
  } catch {
    throw new TypeError("workloadPrivateKey is invalid");
  }
}

/**
 * Workload tokens (§4.2) via the shared triangle-cli core: the challenge is
 * signed with canonical JSON (RFC 8785) under the v1 scopes, and each request
 * carries a DPoP proof whose `htu` is the full request URL.
 */
export function createWorkloadTokenManager({
  origin,
  workloadId,
  workloadPrivateKey,
  scopes,
  fetchImpl,
  now = () => Date.now(),
}) {
  const workloadKey = parseWorkloadPrivateKey(workloadPrivateKey);
  // The agent's registered bounds; a read-only agent asks for agent.read only.
  const requestedScopes = workloadScopes(scopes, "workloadScopes");
  let cachedToken = null;
  let cachedTokenExpiresAt = 0;
  let refreshPromise = null;

  async function postJson(path, body, signal) {
    const response = await fetchImpl(
      new Request(new URL(path, `${origin}/`), {
        method: "POST",
        cache: "no-store",
        // Never follow a redirect: the proof body must only reach this origin.
        redirect: "manual",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    );
    const payload = await readBoundedJson(response, response.status);
    if (!response.ok) {
      // Only allowlisted codes reach the message; free text from MESH never does.
      const code = MESH_ERROR_CODES.has(payload?.error) ? payload.error : null;
      throw new MailboxRequestError(
        `Workload token request failed with status ${response.status}${code ? ` (${code})` : ""}`,
        { status: response.status, meshError: code ?? undefined, permission: payload?.permission },
      );
    }
    return payload;
  }

  async function fetchToken(signal, { refresh = false } = {}) {
    if (!refresh && cachedToken && cachedTokenExpiresAt - 30_000 > now()) {
      return cachedToken;
    }
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const challengePayload = await postJson("/api/v1/identity/token-challenges", { workload_id: workloadId }, signal);
        const ch = challengePayload?.challenge;
        if (!ch?.challenge_id || !ch.nonce || !ch.principal_id || !ch.audience) {
          throw new MailboxRequestError("Workload token challenge is invalid");
        }
        const proof = compactJws(
          { alg: "EdDSA", kid: workloadId, typ: "mesh-workload-proof+jwt" },
          {
            audience: ch.audience,
            challenge_id: ch.challenge_id,
            nonce: ch.nonce,
            principal_id: ch.principal_id,
            profile: WORKLOAD_TOKEN_PROOF_PROFILE,
            requested_scopes: requestedScopes,
            workload_id: workloadId,
          },
          workloadKey,
        );
        const tokenPayload = await postJson(
          "/api/v1/identity/tokens",
          { challenge_id: ch.challenge_id, proof, requested_scopes: requestedScopes },
          signal,
        );
        if (typeof tokenPayload?.access_token !== "string" || tokenPayload.token_type !== "DPoP") {
          throw new MailboxRequestError("Workload token response is invalid");
        }
        const lifetime = Number.isSafeInteger(tokenPayload.expires_in) && tokenPayload.expires_in > 0
          ? tokenPayload.expires_in
          : 300;
        cachedToken = tokenPayload.access_token;
        cachedTokenExpiresAt = now() + lifetime * 1000;
        return cachedToken;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function createDpopProof(method, fullUrl, accessToken) {
    return dpopProof({ workloadKey, method, url: fullUrl, accessToken, now: now() });
  }

  function invalidate(token) {
    if (token === undefined || token === cachedToken) {
      cachedToken = null;
      cachedTokenExpiresAt = 0;
    }
  }

  return Object.freeze({ fetchToken, createDpopProof, invalidate });
}

export function createMailboxClient(
  options,
  {
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    maxDeliveryAttempts = DEFAULT_MAX_DELIVERY_ATTEMPTS,
    maxAckAttempts = DEFAULT_MAX_ACK_ATTEMPTS,
    maxListAttempts = DEFAULT_MAX_LIST_ATTEMPTS,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    // Progress evidence hook: called with { phase: "claim" | "reply" | "ack" }
    // after a won claim, a persisted reply, and an owned ack. Never carries ids,
    // bodies, or credentials; listener failures never affect delivery.
    onProgress = null,
    workloadTokens = null,
  } = {},
) {
  const {
    meshUrl: origin,
    recipientId: workerId,
    pageLimit,
    workloadId,
    workloadPrivateKey,
    workloadScopes: scopes,
  } = validateMailboxClientOptions(options);
  validatePositiveInteger(requestTimeoutMs, "requestTimeoutMs");
  validatePositiveInteger(maxDeliveryAttempts, "maxDeliveryAttempts");
  validatePositiveInteger(maxAckAttempts, "maxAckAttempts");
  validatePositiveInteger(maxListAttempts, "maxListAttempts");
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("setTimeoutFn and clearTimeoutFn must be functions");
  }
  if (onProgress != null && typeof onProgress !== "function") {
    throw new TypeError("onProgress must be a function");
  }

  function emitProgress(phase) {
    if (onProgress == null) return;
    try {
      const pending = onProgress(Object.freeze({ phase }));
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch {
      // Evidence is best-effort; never let it change delivery outcome.
    }
  }

  // Tests may inject a token source; production always derives it from the key.
  const workloadTokenManager = workloadTokens ?? createWorkloadTokenManager({
    origin,
    workloadId,
    workloadPrivateKey,
    scopes,
    fetchImpl,
    now,
  });

  let identityPromise;
  const activeDeliveries = new Map();
  // This process may retry only claims it won itself. The queue is deliberately
  // memory-only: after a process crash the durable claim remains fail-closed and
  // is never released or exposed to a different worker automatically.
  const retryDeliveries = new Map();
  // Poison deliveries are held locally for operator inspection and are skipped
  // via the mailbox after-cursor so they cannot permanently head-of-line block.
  const quarantinedDeliveries = new Map();
  const listFailureCounts = new Map();
  let listAfterCursor = 0;

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
    // Attach a rejection sink for the whole request so deadline rejections during
    // token acquisition / body read never become unhandled rejections (C3).
    const deadlineGuard = deadline.catch(() => {});
    let accessToken;
    try {
      const fullUrl = new URL(path, `${origin}/`).toString();
      for (let attempt = 0; ; attempt += 1) {
        accessToken = await Promise.race([
          Promise.resolve(workloadTokenManager.fetchToken(controller.signal, { refresh: attempt > 0 })),
          deadline,
        ]);
        // A fresh DPoP proof (new jti) per request, bound to the full URL.
        const dpopHeader = workloadTokenManager.createDpopProof(method, fullUrl, accessToken);
        const fetchPromise = Promise.resolve(fetchImpl(
          new Request(fullUrl, {
            method,
            cache: "no-store",
            // Never follow a redirect: the DPoP proof is bound to this URL only.
            redirect: "manual",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${accessToken}`,
              dpop: dpopHeader,
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
        // A 401 means the request was not authenticated (so not applied): an
        // expired or revoked access token gets exactly one fresh exchange.
        if (response.status === 401 && attempt === 0) {
          workloadTokenManager.invalidate?.(accessToken);
          continue;
        }
        assertResponse(response, payload);
        return payload;
      }
    } catch (error) {
      // Keep a rejection sink so a late deadline reject cannot become unhandled,
      // but do not await the full timeout window on ordinary request failures.
      void deadlineGuard;
      if (timedOut) {
        throw new MailboxRequestError("Mailbox request timed out");
      }
      if (callerAborted || error?.name === "AbortError") {
        throw new MailboxRequestError("Mailbox request aborted");
      }
      const text = String(error?.message ?? error);
      const leaks = (accessToken && text.includes(accessToken)) || text.includes(workloadPrivateKey);
      if (error instanceof MailboxRequestError) {
        if (!leaks) throw error;
        throw new MailboxRequestError("Mailbox request failed", { status: error.status, meshError: error.meshError, permission: error.permission });
      }
      if (leaks) throw new MailboxRequestError("Mailbox request failed");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abort);
    }
  }

  async function ensureActorIdentity(signal) {
    if (identityPromise !== undefined) return identityPromise;
    identityPromise = (async () => {
      const actorId = boundedId(workerId, "recipientId", AGENT_ID);
      // Always confirm the workload key belongs to the configured agent.
      const response = await request("/api/v1/agents/me", { signal });
      if (!response?.agent || typeof response.agent.id !== "string") {
        throw new MailboxRequestError("Mailbox actor identity is invalid");
      }
      const verifiedActorId = boundedId(response.agent.id, "agent.id", AGENT_ID);
      if (verifiedActorId !== actorId) {
        throw new MailboxRequestError(
          "Configured recipientId does not match authenticated actor",
        );
      }
      return verifiedActorId;
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

  function advanceListCursor(deliveryId) {
    if (Number.isSafeInteger(deliveryId) && deliveryId > listAfterCursor) {
      listAfterCursor = deliveryId;
    }
  }

  function quarantineDelivery(deliveryId, reason, message = null) {
    retryDeliveries.delete(deliveryId);
    listFailureCounts.delete(deliveryId);
    advanceListCursor(deliveryId);
    quarantinedDeliveries.set(deliveryId, {
      deliveryId,
      reason,
      quarantinedAt: new Date(now()).toISOString(),
      message,
    });
  }

  function parseLeaseExpiresAt(value) {
    if (value === undefined || value === null) return undefined;
    if (
      typeof value !== "string" ||
      !CANONICAL_TIMESTAMP.test(value) ||
      !Number.isFinite(Date.parse(value))
    ) {
      throw new MailboxRequestError("Mailbox claim response is invalid");
    }
    return value;
  }

  // Discard/unsupported paths may omit claims. Owned processing must bind claim_id.
  async function ackDelivery(deliveryId, signal, claimId) {
    const body = {
      delivery_ids: [deliveryId],
      status: "processed",
    };
    if (claimId !== undefined) {
      body.claims = [{ delivery_id: deliveryId, claim_id: claimId }];
    }
    const response = await request("/api/v1/mailbox/ack", {
      method: "POST",
      body,
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
      if (response.renewed !== undefined && typeof response.renewed !== "boolean") {
        throw new MailboxRequestError("Mailbox claim response is invalid");
      }
      return {
        claimed: true,
        claimId: response.claimId,
        claimedAt: response.claimedAt,
        idempotent: response.idempotent,
        renewed: response.renewed === true,
        leaseExpiresAt: parseLeaseExpiresAt(response.leaseExpiresAt),
      };
    } catch (error) {
      if (
        error instanceof MailboxRequestError &&
        error.status === 409 &&
        error.mailboxError === "delivery_claim_conflict"
      ) {
        return null;
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
      const claimed = await claimDelivery(metadata.id, metadata.claimId, signal);
      if (!claimed) {
        retryDeliveries.delete(metadata.id);
        return false;
      }
      metadata.owned = true;
      if (claimed.leaseExpiresAt !== undefined) {
        metadata.leaseExpiresAt = claimed.leaseExpiresAt;
      }
      return true;
    } catch (error) {
      if (isDefinitiveClaimDenial(error)) {
        retryDeliveries.delete(metadata.id);
      }
      throw error;
    }
  }

  function renewDelayMs(leaseExpiresAt) {
    const expiresMs = Date.parse(leaseExpiresAt);
    if (!Number.isFinite(expiresMs)) return null;
    const remaining = expiresMs - now();
    if (remaining <= 0) return 0;
    const halfLife = Math.floor(remaining / 2);
    const marginDelay = remaining - LEASE_RENEW_MARGIN_MS;
    const delay = Math.min(halfLife, marginDelay);
    return Math.max(MIN_LEASE_RENEW_DELAY_MS, delay);
  }

  async function withClaimCustody(metadata, signal, work) {
    const ownership = new AbortController();
    const forwardAbort = () => ownership.abort();
    signal?.addEventListener?.("abort", forwardAbort, { once: true });
    if (signal?.aborted) ownership.abort();

    let renewTimer;
    let renewInFlight = false;
    let stopped = false;

    const stopRenewal = () => {
      stopped = true;
      if (renewTimer !== undefined) {
        clearTimeoutFn(renewTimer);
        renewTimer = undefined;
      }
    };

    const markOwnershipLost = () => {
      metadata.owned = false;
      metadata.ownershipLost = true;
      stopRenewal();
      if (!ownership.signal.aborted) ownership.abort();
    };

    const scheduleRenew = () => {
      if (stopped || !metadata.leaseExpiresAt || ownership.signal.aborted) return;
      const delay = renewDelayMs(metadata.leaseExpiresAt);
      if (delay === null) return;
      renewTimer = setTimeoutFn(() => {
        void (async () => {
          if (stopped || renewInFlight || ownership.signal.aborted) return;
          renewInFlight = true;
          try {
            const renewed = await claimDelivery(
              metadata.id,
              metadata.claimId,
              ownership.signal,
            );
            if (!renewed) {
              markOwnershipLost();
              return;
            }
            if (renewed.leaseExpiresAt !== undefined) {
              metadata.leaseExpiresAt = renewed.leaseExpiresAt;
            }
            renewInFlight = false;
            scheduleRenew();
          } catch (error) {
            renewInFlight = false;
            if (isDefinitiveClaimDenial(error) || error instanceof MailboxRequestError) {
              markOwnershipLost();
              return;
            }
            markOwnershipLost();
          }
        })();
      }, delay);
    };

    scheduleRenew();
    try {
      return await work(ownership.signal);
    } finally {
      stopRenewal();
      signal?.removeEventListener?.("abort", forwardAbort);
    }
  }

  function assertStillOwner(metadata, ownedSignal) {
    if (metadata.ownershipLost || metadata.owned === false) {
      throw new MailboxOwnershipError();
    }
    if (ownedSignal?.aborted) {
      throw new MailboxRequestError("Mailbox request aborted");
    }
  }

  async function listUnread({ signal } = {}) {
    await ensureActorIdentity(signal);
    const retries = Array.from(retryDeliveries.values()).filter((message) => {
      const id = message?.[MAILBOX_DELIVERY_META]?.id;
      return Number.isSafeInteger(id) && !quarantinedDeliveries.has(id);
    });
    if (retries.length > 0) {
      return retries.slice(0, pageLimit);
    }

    const query = new URLSearchParams({
      after: String(listAfterCursor),
      limit: String(pageLimit),
    });
    const page = await request(`/api/v1/mailbox?${query}`, { signal });
    if (!isObject(page) || !Array.isArray(page.items)) {
      throw new MailboxRequestError("Mailbox response is invalid");
    }

    const messages = [];
    for (const delivery of page.items) {
      const normalizedDelivery = validateMailboxDelivery(delivery, workerId);
      if (quarantinedDeliveries.has(normalizedDelivery.id)) {
        advanceListCursor(normalizedDelivery.id);
        continue;
      }

      let normalizedEvent;
      try {
        normalizedEvent = await listRoomEvent(
          normalizedDelivery.roomId,
          normalizedDelivery.roomSequence,
          normalizedDelivery.eventId,
          signal,
        );
        listFailureCounts.delete(normalizedDelivery.id);
      } catch (error) {
        if (isSkipEventError(error)) {
          // Unsupported/discarded deliveries may ack without a claim.
          await ackDelivery(normalizedDelivery.id, signal);
          advanceListCursor(normalizedDelivery.id);
          continue;
        }
        const failures = (listFailureCounts.get(normalizedDelivery.id) ?? 0) + 1;
        listFailureCounts.set(normalizedDelivery.id, failures);
        if (failures >= maxListAttempts) {
          quarantineDelivery(
            normalizedDelivery.id,
            error?.message ?? "list_validation_failed",
          );
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
          owned: false,
          replyPersisted: false,
          processingAttempts: 0,
          ackAttempts: 0,
        },
        enumerable: false,
      });
      messages.push(message);
    }

    return messages;
  }

  async function acknowledgeOwned(metadata, signal) {
    assertStillOwner(metadata);
    try {
      await ackDelivery(metadata.id, signal, metadata.claimId);
    } catch (error) {
      metadata.ackAttempts = (metadata.ackAttempts ?? 0) + 1;
      if (metadata.ackAttempts >= maxAckAttempts) {
        quarantineDelivery(metadata.id, "ack_retry_exhausted");
        return { quarantined: true, acknowledged: false };
      }
      throw error;
    }
    retryDeliveries.delete(metadata.id);
    advanceListCursor(metadata.id);
    emitProgress("ack");
    return { quarantined: false, acknowledged: true };
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
    if (quarantinedDeliveries.has(metadata.id)) {
      return {
        claimed: false,
        reconciled: false,
        acknowledged: false,
        quarantined: true,
      };
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

    const recordProcessingFailure = (error) => {
      // Ack-only failures after a durable reply must not burn the runner budget
      // or re-enter model execution.
      if (metadata.replyPersisted) return error;
      metadata.processingAttempts = (metadata.processingAttempts ?? 0) + 1;
      if (metadata.processingAttempts >= maxDeliveryAttempts) {
        quarantineDelivery(
          metadata.id,
          error?.message ?? "processing_retry_exhausted",
          message,
        );
        return null;
      }
      retryDeliveries.set(metadata.id, message);
      return error;
    };

    try {
      if (!(await establishClaim(message, metadata, signal))) {
        return { claimed: false, reconciled: false, acknowledged: false };
      }
      emitProgress("claim");

      return await withClaimCustody(metadata, signal, async (ownedSignal) => {
        if (normalized.replyRequired === false) {
          assertStillOwner(metadata, ownedSignal);
          const ack = await acknowledgeOwned(metadata, signal);
          if (ack.quarantined) {
            return {
              claimed: false,
              reconciled: false,
              acknowledged: false,
              quarantined: true,
            };
          }
          return {
            reconciled: false,
            acknowledged: true,
          };
        }

        const replyMessageId = deterministicMailboxReplyMessageId(normalized);
        let reconciled = metadata.replyPersisted === true;
        if (!metadata.replyPersisted) {
          const existing = await findExistingReply(
            normalized.contextId,
            replyMessageId,
            metadata.roomSequence,
            ownedSignal,
          );
          if (existing.found) {
            metadata.replyPersisted = true;
            reconciled = true;
            // A verified durable reply (e.g. its append response was lost) is
            // reply evidence too; the stamp is when it was verified.
            emitProgress("reply");
          } else {
            assertStillOwner(metadata, ownedSignal);
            // Runner calls are at-least-once; adapters must dedupe using messageId/taskId.
            const replyText = validateResult(
              await generate(normalizedRequest(normalized), { signal: ownedSignal }),
            );
            assertStillOwner(metadata, ownedSignal);
            await appendReply(normalized, replyText, replyMessageId, ownedSignal);
            metadata.replyPersisted = true;
            reconciled = false;
            emitProgress("reply");
          }
        }

        assertStillOwner(metadata, ownedSignal);
        const ack = await acknowledgeOwned(metadata, signal);
        if (ack.quarantined) {
          return {
            claimed: false,
            reconciled,
            acknowledged: false,
            quarantined: true,
          };
        }
        return {
          reconciled,
          acknowledged: true,
        };
      });
    } catch (error) {
      if (error instanceof MailboxOwnershipError || metadata.ownershipLost) {
        // Never ack after ownership loss; durable replies remain idempotent for reclaim.
        retryDeliveries.delete(metadata.id);
        return {
          claimed: false,
          reconciled: metadata.replyPersisted === true,
          acknowledged: false,
          ownershipLost: true,
        };
      }
      if (isDefinitiveClaimDenial(error)) {
        retryDeliveries.delete(metadata.id);
        throw error;
      }
      if (metadata.replyPersisted) {
        // Ack failures are counted in acknowledgeOwned; keep custody for retry only.
        retryDeliveries.set(metadata.id, message);
        throw error;
      }
      const recorded = recordProcessingFailure(error);
      if (recorded === null) {
        return {
          claimed: false,
          reconciled: false,
          acknowledged: false,
          quarantined: true,
        };
      }
      throw recorded;
    }
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

  function listQuarantined() {
    return Array.from(quarantinedDeliveries.values()).map((entry) => ({
      deliveryId: entry.deliveryId,
      reason: entry.reason,
      quarantinedAt: entry.quarantinedAt,
    }));
  }

  return {
    listUnread,
    completeAndAcknowledge,
    listQuarantined,
  };
}
