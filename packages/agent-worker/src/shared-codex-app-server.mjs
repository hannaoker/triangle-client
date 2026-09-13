/**
 * Shared Codex App Server adapter (interactive desktop wake track).
 *
 * Attaches an existing desktop conversation via the shared App Server protocol
 * and admits MESH wake work into that thread while idle. This is not the SDK
 * subprocess runner and does not block a model turn waiting for mail.
 *
 * Production MESH credentials stay in the signed helper (watch-poll / ensure).
 * This module never accepts or logs `mesh_` / `mesh_watch_` secrets.
 *
 * Slice 6 (trusted transaction proxy) remains required before production
 * Hermes / coordinator-delivery claim/reply/ack. Bob canary and optional SDK
 * are out of this scaffold.
 */

import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  createAuthenticatedAppServerTransport,
  createCapabilityTokenAuthResolver,
  createScriptedAuthHandshakeSocket,
  openNodeWebSocket,
} from "./authenticated-app-server-transport.mjs";
import {
  createFakeWatchTransport,
  createHelperWatchTransport,
  ensureHelperWatchGrant,
} from "./helper-watch-transport.mjs";
import {
  createHelperDurableDeliveryResolver,
  createHelperTrustedTransactionProxy,
  deriveTrustedClaimId,
  deriveTrustedReplyIdempotencyKey,
  resolveTrustedTransactionProxy,
} from "./helper-transaction-proxy.mjs";
import {
  createAtomicFileCursorStore,
  createMemoryCursorStore,
  createWakeClient,
} from "./wake-client.mjs";

export const SHARED_CODEX_ADAPTER_VERSION = "1";
export const MAX_COMPLETED_TURNS = 64;

const AGENT_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const INSTANCE_ID = /^[a-f0-9]{64}$/;
const INSTALLATION_ID = /^inst_[A-Za-z0-9_-]{10,75}$/;
const THREAD_ID = /^[A-Za-z0-9._:-]{8,120}$/;
const ENDPOINT = /^wss?:\/\/[^\s\0]{1,500}$/i;
const SERVER_IDENTITY = /^[A-Za-z0-9._:/+=-]{1,200}$/;
const ROOM_SCOPE = /^[A-Za-z0-9._:-]{1,120}$/;

const STATUS_VALUES = Object.freeze([
  "disabled",
  "disconnected",
  "connected",
  "subscribed",
  "pending",
  "busy",
  "running",
  "reconnecting",
  "submission_unknown",
  "transaction_stuck",
]);

function positiveInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function assertNoSecretMaterial(value, label = "value") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text === "string" && /mesh_(?:watch_)?[A-Za-z0-9_-]{8,}/.test(text)) {
    throw createCodedError("secret_leak_rejected", `${label} must not contain mesh_ credentials`);
  }
}

/**
 * Validate and normalize a durable App Server binding.
 * Fail closed when endpoint or server identity would silently change under an
 * already-enabled binding (caller compares previous vs next via assertCompatibleBinding).
 */
export function validateBinding(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("binding is invalid");
  }
  const {
    adapterVersion = SHARED_CODEX_ADAPTER_VERSION,
    enabled = false,
    installationId,
    instanceId,
    agentId,
    roomScope = null,
    serverIdentity,
    endpoint,
    threadId,
  } = input;

  if (adapterVersion !== SHARED_CODEX_ADAPTER_VERSION) {
    throw createCodedError(
      "incompatible_adapter_version",
      `adapterVersion must be ${SHARED_CODEX_ADAPTER_VERSION}`,
    );
  }
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
  if (typeof installationId !== "string" || !INSTALLATION_ID.test(installationId)) {
    throw new TypeError("installationId is invalid");
  }
  if (typeof instanceId !== "string" || !INSTANCE_ID.test(instanceId)) {
    throw new TypeError("instanceId is invalid");
  }
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) {
    throw new TypeError("agentId is invalid");
  }
  if (roomScope != null && (typeof roomScope !== "string" || !ROOM_SCOPE.test(roomScope))) {
    throw new TypeError("roomScope is invalid");
  }
  if (typeof serverIdentity !== "string" || !SERVER_IDENTITY.test(serverIdentity)) {
    throw new TypeError("serverIdentity is invalid");
  }
  if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint)) {
    throw new TypeError("endpoint is invalid");
  }
  if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) {
    throw new TypeError("threadId is invalid");
  }

  const binding = Object.freeze({
    adapterVersion: SHARED_CODEX_ADAPTER_VERSION,
    enabled,
    installationId,
    instanceId,
    agentId,
    roomScope,
    serverIdentity,
    endpoint,
    threadId,
  });
  assertNoSecretMaterial(binding, "binding");
  return binding;
}

/**
 * Refuse silent resume when the shared server identity or endpoint changes.
 * Never treat a newly spawned SDK process as the same attachment.
 */
export function assertCompatibleBinding(previous, next) {
  const left = validateBinding(previous);
  const right = validateBinding(next);
  if (left.installationId !== right.installationId) {
    throw createCodedError("binding_installation_mismatch", "installationId changed");
  }
  if (left.instanceId !== right.instanceId || left.agentId !== right.agentId) {
    throw createCodedError("binding_profile_mismatch", "instance/agent identity changed");
  }
  if (left.serverIdentity !== right.serverIdentity) {
    throw createCodedError("binding_server_identity_changed", "serverIdentity changed; fail closed");
  }
  if (left.endpoint !== right.endpoint) {
    throw createCodedError("binding_endpoint_changed", "endpoint changed; fail closed");
  }
  if (left.threadId !== right.threadId) {
    throw createCodedError("binding_thread_changed", "threadId changed; fail closed");
  }
  return right;
}

export function createMemoryBindingStore(initial = null) {
  let binding = initial == null ? null : validateBinding(initial);
  return Object.freeze({
    async read() {
      return binding;
    },
    async write(next) {
      const validated = validateBinding(next);
      if (binding != null && binding.enabled) {
        assertCompatibleBinding(binding, validated);
      }
      binding = validated;
      return binding;
    },
  });
}

/**
 * Durable binding under a configurable path. Same atomic write pattern as the
 * wake cursor store: temp → fsync → rename → best-effort parent fsync.
 */
export function createAtomicFileBindingStore({ filePath, initial = null } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("filePath is required");
  }
  const resolvedPath = path.resolve(filePath);
  const directory = path.dirname(resolvedPath);
  let binding = null;
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const raw = await readFile(resolvedPath, "utf8");
      binding = validateBinding(JSON.parse(raw));
    } catch (error) {
      if (error?.code === "ENOENT") {
        binding = initial == null ? null : validateBinding(initial);
      } else if (error instanceof SyntaxError) {
        throw new TypeError("app server binding file is invalid");
      } else {
        throw error;
      }
    }
    loaded = true;
  }

  async function syncDirectory() {
    try {
      const handle = await open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (
        error?.code === "EINVAL"
        || error?.code === "ENOTSUP"
        || error?.code === "EISDIR"
        || error?.code === "EPERM"
      ) {
        return;
      }
      throw error;
    }
  }

  async function atomicWrite(value) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.tmp-app-server-binding-${randomUUID().toLowerCase()}`);
    let installed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, resolvedPath);
      installed = true;
      await syncDirectory();
    } finally {
      if (!installed) {
        await unlink(temporary).catch(() => {});
      }
    }
  }

  return Object.freeze({
    filePath: resolvedPath,
    async read() {
      await ensureLoaded();
      return binding;
    },
    async write(next) {
      await ensureLoaded();
      const validated = validateBinding(next);
      if (binding != null && binding.enabled) {
        assertCompatibleBinding(binding, validated);
      }
      await atomicWrite(validated);
      binding = validated;
      return binding;
    },
  });
}

/**
 * In-memory delivery→turn correlation for admission. Production should persist
 * before submission; this store is the unit-testable contract surface.
 */
export function createMemoryCorrelationStore() {
  const byDelivery = new Map();
  return Object.freeze({
    async record({ deliveryId, threadId, turnId = null, status = "pending" } = {}) {
      if (typeof deliveryId !== "string" || deliveryId.length === 0) {
        throw new TypeError("deliveryId is required");
      }
      if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) {
        throw new TypeError("threadId is invalid");
      }
      const entry = Object.freeze({
        deliveryId,
        threadId,
        turnId,
        status,
        recordedAt: Date.now(),
      });
      byDelivery.set(deliveryId, entry);
      return entry;
    },
    async get(deliveryId) {
      return byDelivery.get(deliveryId) ?? null;
    },
    async update(deliveryId, patch = {}) {
      const previous = byDelivery.get(deliveryId);
      if (!previous) return null;
      const next = Object.freeze({ ...previous, ...patch });
      byDelivery.set(deliveryId, next);
      return next;
    },
  });
}

/**
 * Tiny Slice 6 placeholder. Production Hermes / coordinator-delivery paths must
 * use `resolveTrustedTransactionProxy` / `createHelperTrustedTransactionProxy`
 * when the signed helper is present. Self-serve mailbox drain can proceed
 * without it for local adapter tests only.
 */
export function createTrustedTransactionProxyStub() {
  return Object.freeze({
    name: "slice6_trusted_transaction_proxy_stub",
    async status() {
      return Object.freeze({
        shouldStartModel: false,
        transactionStuck: false,
        open: null,
        status: "idle",
      });
    },
    async claimNext() {
      return Object.freeze({
        shouldStartModel: false,
        transactionStuck: false,
        open: null,
        status: "idle",
      });
    },
    async claim() {
      throw createCodedError(
        "slice6_required",
        "trusted transaction proxy (Slice 6) is required before production claim",
      );
    },
    async reply() {
      throw createCodedError(
        "slice6_required",
        "trusted transaction proxy (Slice 6) is required before production reply",
      );
    },
    async ack() {
      throw createCodedError(
        "slice6_required",
        "trusted transaction proxy (Slice 6) is required before production ack",
      );
    },
  });
}

/**
 * Production App Server wake delivery resolver via Slice 6 helper status.
 * Never invents a Node-side `mesh_` credential path.
 */
export function createProductionAppServerDeliveryResolver(options = {}) {
  return createHelperDurableDeliveryResolver({
    ...options,
    createProxy: options.createProxy ?? createTrustedTransactionProxy,
  });
}

/**
 * Production entry: helper CLI proxy when `helperPath` + profile are present;
 * otherwise the fail-closed stub (never a silent Node-side bypass for
 * coordinator-delivery).
 */
export function createTrustedTransactionProxy(options = {}) {
  return resolveTrustedTransactionProxy({
    ...options,
    createStub: createTrustedTransactionProxyStub,
    createHelper: createHelperTrustedTransactionProxy,
  });
}

/**
 * Fake App Server JSON-RPC transport for unit tests (no real WebSocket / Codex).
 */
export function createFakeAppServerTransport({
  threadId,
  serverIdentity = "fake-codex-app-server",
  initialStatus = { type: "idle" },
  onCall,
} = {}) {
  if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) {
    throw new TypeError("threadId is invalid");
  }
  let connected = false;
  let turnCounter = 0;
  let status = initialStatus;
  const events = [];
  const calls = [];
  const listeners = new Set();

  function emit(method, params) {
    const event = { method, params };
    events.push(event);
    for (const listener of listeners) listener(event);
  }

  return Object.freeze({
    serverIdentity,
    events,
    calls,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async connect() {
      connected = true;
      return { connected: true, serverIdentity };
    },
    async call(method, params = {}) {
      if (!connected) throw createCodedError("not_connected", "transport is not connected");
      calls.push({ method, params });
      if (typeof onCall === "function") {
        const override = await onCall(method, params, { emit, status, setStatus: (next) => { status = next; } });
        if (override !== undefined) return override;
      }
      switch (method) {
        case "initialize":
          return { serverInfo: { name: serverIdentity, version: "0.0.0-fake" } };
        case "thread/start":
          // Mint path for desktop experiments: reuse the fake's bound thread id.
          return { thread: { id: threadId, status } };
        case "thread/resume": {
          if (params.threadId !== threadId) {
            throw createCodedError("thread_not_found", "threadId does not match binding");
          }
          return { thread: { id: threadId, status } };
        }
        case "thread/read": {
          if (params.threadId !== threadId) {
            throw createCodedError("thread_not_found", "threadId does not match binding");
          }
          return { thread: { id: threadId, status, turns: [] } };
        }
        case "turn/start": {
          if (params.threadId !== threadId) {
            throw createCodedError("thread_not_found", "threadId does not match binding");
          }
          if (status?.type === "busy" || status?.type === "running") {
            throw createCodedError("thread_busy", "thread is busy");
          }
          turnCounter += 1;
          const turnId = `turn_fake_${String(turnCounter).padStart(4, "0")}`;
          status = { type: "busy", turnId };
          emit("turn/started", { threadId, turn: { id: turnId, status: "in_progress" } });
          queueMicrotask(() => {
            status = { type: "idle" };
            emit("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
          });
          return { turn: { id: turnId, status: "in_progress" } };
        }
        default:
          throw createCodedError("method_not_found", `unknown method ${method}`);
      }
    },
    async close() {
      connected = false;
    },
  });
}

/**
 * Opt-in shared App Server session: initialize, resume, read, turn/start,
 * notification wait, reconnect, shutdown, and doctor-facing status.
 */
export function createSharedCodexSession({
  binding,
  transport,
  bindingStore = null,
  correlationStore = createMemoryCorrelationStore(),
  transactionProxy = null,
  requestTimeoutMs = 30_000,
  maxQueue = 8,
  maxConsecutiveFailures = 5,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const validated = validateBinding(binding);
  if (!transport || typeof transport.call !== "function" || typeof transport.connect !== "function") {
    throw new TypeError("transport.connect and transport.call are required");
  }
  positiveInteger(requestTimeoutMs, "requestTimeoutMs", 1);
  positiveInteger(maxQueue, "maxQueue", 1);
  positiveInteger(maxConsecutiveFailures, "maxConsecutiveFailures", 1);
  if (transactionProxy != null) {
    if (typeof transactionProxy.reply !== "function" || typeof transactionProxy.ack !== "function") {
      throw new TypeError("transactionProxy.reply and transactionProxy.ack are required");
    }
  }

  let phase = validated.enabled ? "disconnected" : "disabled";
  let lastSuccessfulWakeAt = null;
  let lastError = null;
  let activeTurnId = null;
  let queueDepth = 0;
  let retryCount = 0;
  let consecutiveFailures = 0;
  let initialized = false;
  let unsubscribe = null;
  const pendingTurns = new Map();
  /** Session-retained turn completions so waiters do not depend on transport event buffers. */
  const completedTurns = new Map();
  const queue = [];
  let draining = false;
  let stopped = false;

  function setPhase(next) {
    if (!STATUS_VALUES.includes(next)) {
      throw new TypeError(`invalid status ${next}`);
    }
    phase = next;
  }

  function doctorStatus() {
    return Object.freeze({
      status: phase,
      enabled: validated.enabled,
      adapterVersion: validated.adapterVersion,
      installationId: validated.installationId,
      instanceId: validated.instanceId,
      agentId: validated.agentId,
      roomScope: validated.roomScope,
      serverIdentity: validated.serverIdentity,
      endpoint: validated.endpoint,
      threadId: validated.threadId,
      queueDepth,
      retryCount,
      consecutiveFailures,
      activeTurnId,
      lastSuccessfulWakeAt,
      lastError: lastError
        ? { code: lastError.code ?? "error", message: lastError.message }
        : null,
    });
  }

  async function call(method, params) {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(createCodedError("request_timeout", `${method} timed out`, { outcome: "unknown" }));
      }, requestTimeoutMs);
    });
    try {
      return await Promise.race([transport.call(method, params), timeoutPromise]);
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  function collectAuthenticatedIdentities(connectResult, initializeResult) {
    const identities = [];
    const push = (value) => {
      if (typeof value === "string" && value.length > 0) identities.push(value);
    };
    push(connectResult?.serverIdentity);
    push(connectResult?.serverInfo?.name);
    push(initializeResult?.serverInfo?.name);
    push(initializeResult?.serverIdentity);
    return identities;
  }

  function onTransportEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.method === "turn/started") {
      activeTurnId = event.params?.turn?.id ?? activeTurnId;
      if (phase !== "submission_unknown" && phase !== "transaction_stuck") {
        setPhase("running");
      }
    }
    if (event.method === "turn/completed") {
      const turnId = event.params?.turn?.id;
      const turn = event.params?.turn;
      if (turnId && turn) {
        const waiter = pendingTurns.get(turnId);
        if (waiter) {
          pendingTurns.delete(turnId);
          completedTurns.delete(turnId);
          waiter.resolve(turn);
        } else {
          completedTurns.set(turnId, turn);
          while (completedTurns.size > MAX_COMPLETED_TURNS) {
            const oldest = completedTurns.keys().next().value;
            completedTurns.delete(oldest);
          }
        }
      }
      activeTurnId = null;
      if (phase !== "submission_unknown" && phase !== "transaction_stuck") {
        setPhase(queueDepth > 0 ? "pending" : "subscribed");
      }
      queueMicrotask(() => {
        pumpQueue().catch((error) => {
          lastError = error;
          logger.error?.("triangle_app_server_queue_pump_failed", {
            code: error?.code,
            message: error?.message,
          });
        });
      });
    }
  }

  async function connect() {
    // Durable supervisor stop→start cycles call shutdown() then connect() again.
    // Re-arm so a prior stop does not permanently brick the shared session.
    stopped = false;
    if (!validated.enabled) {
      setPhase("disabled");
      return doctorStatus();
    }
    if (bindingStore) {
      const stored = await bindingStore.read();
      if (stored != null) assertCompatibleBinding(stored, validated);
      await bindingStore.write(validated);
    }
    setPhase("reconnecting");
    const connectResult = await transport.connect();
    if (typeof transport.onEvent === "function") {
      unsubscribe?.();
      unsubscribe = transport.onEvent(onTransportEvent);
    }
    const initializeResult = await call("initialize", {
      clientInfo: {
        name: "triangle-shared-codex-listener",
        title: "Triangle shared Codex listener",
        version: SHARED_CODEX_ADAPTER_VERSION,
      },
    });
    const candidates = collectAuthenticatedIdentities(connectResult, initializeResult);
    const mismatch = candidates.find((identity) => identity !== validated.serverIdentity);
    if (candidates.length === 0 || mismatch != null) {
      lastError = createCodedError(
        "server_identity_mismatch",
        "connected server identity does not match durable binding",
        {
          expected: validated.serverIdentity,
          actual: mismatch ?? null,
        },
      );
      setPhase("disconnected");
      initialized = false;
      unsubscribe?.();
      unsubscribe = null;
      if (typeof transport.close === "function") await transport.close();
      throw lastError;
    }
    if (typeof transport.notify === "function") {
      await transport.notify("initialized", {});
    }
    initialized = true;
    setPhase("connected");
    await call("thread/resume", { threadId: validated.threadId });
    setPhase("subscribed");
    lastError = null;
    return doctorStatus();
  }

  async function readThread({ includeTurns = false } = {}) {
    return call("thread/read", { threadId: validated.threadId, includeTurns });
  }

  function findRetainedCompletion(turnId) {
    const sessionRetained = completedTurns.get(turnId);
    if (sessionRetained) return sessionRetained;
    const existing = [...(transport.events ?? [])].find(
      (event) => event.method === "turn/completed" && event.params?.turn?.id === turnId,
    );
    return existing?.params?.turn ?? null;
  }

  async function waitForTurn(turnId, { timeoutMs = requestTimeoutMs } = {}) {
    if (typeof turnId !== "string" || turnId.length === 0) {
      throw new TypeError("turnId is required");
    }
    // Register the waiter before inspecting retained events so a completion that
    // arrives between the check and pendingTurns.set cannot be missed.
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        pendingTurns.delete(turnId);
        reject(createCodedError("request_timeout", "turn completion timed out", { outcome: "unknown" }));
      }, timeoutMs);
      const settle = (turn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingTurns.delete(turnId);
        completedTurns.delete(turnId);
        resolve(turn);
      };
      pendingTurns.set(turnId, { resolve: settle });
      const existing = findRetainedCompletion(turnId);
      if (existing) settle(existing);
    });
  }

  async function startTurn({ input, deliveryId = null } = {}) {
    if (!initialized) throw createCodedError("not_connected", "session is not connected");
    if (!Array.isArray(input) || input.length === 0) {
      throw new TypeError("input is required");
    }
    assertNoSecretMaterial(input, "turn input");
    if (deliveryId) {
      await correlationStore.record({
        deliveryId,
        threadId: validated.threadId,
        status: "submitting",
      });
    }
    setPhase("busy");
    let result;
    try {
      result = await call("turn/start", { threadId: validated.threadId, input });
    } catch (error) {
      if (error?.outcome === "unknown" || error?.code === "request_timeout") {
        setPhase("submission_unknown");
        lastError = error;
        if (deliveryId) {
          await correlationStore.update(deliveryId, { status: "submission_unknown" });
        }
        logger.error?.("triangle_app_server_submission_unknown", {
          threadId: validated.threadId,
          deliveryId,
        });
        throw error;
      }
      throw error;
    }
    const turnId = result?.turn?.id;
    if (typeof turnId !== "string") {
      setPhase("submission_unknown");
      throw createCodedError("submission_unknown", "turn/start returned no turn id", {
        outcome: "unknown",
      });
    }
    // Completions that fire during/immediately after turn/start are retained in
    // completedTurns by onTransportEvent (independent of transport event buffers).
    const alreadyCompleted = findRetainedCompletion(turnId) != null;
    if (alreadyCompleted) {
      activeTurnId = null;
      if (phase !== "submission_unknown" && phase !== "transaction_stuck") {
        setPhase(queueDepth > 0 ? "pending" : "subscribed");
      }
    } else {
      activeTurnId = turnId;
      if (phase !== "submission_unknown" && phase !== "transaction_stuck") {
        setPhase("running");
      }
    }
    if (deliveryId) {
      await correlationStore.update(deliveryId, {
        turnId,
        status: alreadyCompleted ? "completed" : "running",
      });
    }
    return result;
  }

  function extractAssistantText(turn) {
    const items = [];
    const pushText = (value) => {
      if (typeof value === "string" && value.trim().length > 0) items.push(value.trim());
    };
    const walk = (node) => {
      if (node == null) return;
      if (typeof node === "string") {
        pushText(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (typeof node !== "object") return;
      if (typeof node.text === "string") pushText(node.text);
      if (typeof node.content === "string") pushText(node.content);
      if (Array.isArray(node.content)) walk(node.content);
      if (Array.isArray(node.items)) walk(node.items);
      if (Array.isArray(node.output)) walk(node.output);
      if (Array.isArray(node.message?.content)) walk(node.message.content);
    };
    walk(turn?.assistantMessage);
    walk(turn?.assistant_message);
    walk(turn?.output);
    walk(turn?.items);
    walk(turn?.messages);
    const unique = [...new Set(items)];
    return unique.join("\n").trim();
  }

  async function settleMeshTransaction(item, turn) {
    if (!transactionProxy) return;
    const roomId = item.roomId;
    const text = extractAssistantText(turn);
    if (typeof roomId !== "string" || !/^room_[a-f0-9]{32}$/.test(roomId)) {
      throw createCodedError("mesh_reply_context_missing", "roomId missing for MESH reply");
    }
    if (!text) {
      throw createCodedError("assistant_text_missing", "completed turn had no assistant text for MESH reply");
    }
    assertNoSecretMaterial({ text }, "mesh reply");
    await transactionProxy.reply({
      roomId,
      text,
      inReplyToEventId: item.inboundEventId ?? null,
    });
    await transactionProxy.ack();
  }

  async function pumpQueue() {
    if (draining || stopped) return;
    draining = true;
    try {
      while (queue.length > 0 && !stopped) {
        if (phase === "submission_unknown" || phase === "transaction_stuck") break;
        if (phase === "running" || phase === "busy") break;
        const item = queue.shift();
        queueDepth = queue.length;
        try {
          const started = await startTurn({
            input: item.input,
            deliveryId: item.deliveryId,
          });
          const turn = await waitForTurn(started.turn.id);
          if (turn?.status !== "completed") {
            throw createCodedError("turn_failed", "turn did not complete successfully");
          }
          await settleMeshTransaction(item, turn);
          consecutiveFailures = 0;
          retryCount = 0;
          lastSuccessfulWakeAt = now();
          if (item.deliveryId) {
            await correlationStore.update(item.deliveryId, { status: "completed" });
          }
          item.resolve?.({ status: "completed", turn });
        } catch (error) {
          consecutiveFailures += 1;
          retryCount += 1;
          lastError = error;
          if (item.deliveryId) {
            try {
              await correlationStore.update(item.deliveryId, {
                status: "failed",
                error: { code: error?.code ?? "error", message: error?.message },
              });
            } catch {
              /* ignore correlation write failures */
            }
          }
          if (consecutiveFailures >= maxConsecutiveFailures) {
            setPhase("transaction_stuck");
            logger.error?.("triangle_app_server_transaction_stuck", {
              threadId: validated.threadId,
              consecutiveFailures,
            });
          }
          item.reject?.(error);
          if (phase === "transaction_stuck" || phase === "submission_unknown") break;
        }
      }
    } finally {
      draining = false;
    }
  }

  /**
   * Admit work into the bound chat. Queues when busy; does not steer/interrupt.
   * Hints must be coalesced by the wake client; distinct deliveries stay distinct.
   */
  async function admit({
    deliveryId,
    text,
    input = null,
    roomId = null,
    inboundEventId = null,
  } = {}) {
    if (stopped) throw createCodedError("stopped", "session is stopped");
    if (!validated.enabled) {
      setPhase("disabled");
      return { status: "disabled" };
    }
    if (phase === "transaction_stuck") {
      throw createCodedError("transaction_stuck", "session is stuck after repeated turn failures");
    }
    if (phase === "submission_unknown") {
      // turn/start timed out once; soft-returning here permanently wedged the
      // LaunchAgent session (claim succeeded, admit never retried). Reconnect
      // and clear the unknown state before accepting new admissions.
      logger.error?.("triangle_app_server_submission_unknown_recover", {
        threadId: validated.threadId,
        deliveryId,
      });
      await reconnect();
      if (phase === "submission_unknown" || phase === "transaction_stuck") {
        throw createCodedError(
          "submission_unknown",
          "session still unknown after reconnect",
          { outcome: "unknown" },
        );
      }
    }
    if (typeof deliveryId !== "string" || deliveryId.length === 0) {
      throw new TypeError("deliveryId is required");
    }
    const existing = await correlationStore.get(deliveryId);
    if (existing && (existing.status === "completed" || existing.status === "running")) {
      return { status: "duplicate", correlation: existing };
    }
    const turnInput = input ?? [{ type: "text", text }];
    if (!Array.isArray(turnInput) || turnInput.length === 0) {
      throw new TypeError("text or input is required");
    }
    assertNoSecretMaterial(turnInput, "admit input");
    if (queue.length >= maxQueue) {
      throw createCodedError("queue_full", "admission queue is full");
    }
    await correlationStore.record({
      deliveryId,
      threadId: validated.threadId,
      status: "queued",
      roomId: roomId ?? null,
      inboundEventId: inboundEventId ?? null,
    });
    const outcome = await new Promise((resolve, reject) => {
      queue.push({
        deliveryId,
        input: turnInput,
        roomId: roomId ?? null,
        inboundEventId: inboundEventId ?? null,
        resolve,
        reject,
      });
      queueDepth = queue.length;
      if (phase === "subscribed" || phase === "connected" || phase === "pending") {
        setPhase("pending");
      }
      queueMicrotask(() => {
        pumpQueue().catch((error) => {
          lastError = error;
          logger.error?.("triangle_app_server_queue_pump_failed", {
            code: error?.code,
            message: error?.message,
          });
        });
      });
    });
    return outcome;
  }

  async function reconnect() {
    setPhase("reconnecting");
    unsubscribe?.();
    unsubscribe = null;
    initialized = false;
    if (typeof transport.close === "function") await transport.close();
    return connect();
  }

  async function shutdown() {
    stopped = true;
    unsubscribe?.();
    unsubscribe = null;
    for (const item of queue.splice(0)) {
      item.reject?.(createCodedError("stopped", "session stopped before admission"));
    }
    queueDepth = 0;
    if (typeof transport.close === "function") await transport.close();
    initialized = false;
    setPhase(validated.enabled ? "disconnected" : "disabled");
    return doctorStatus();
  }

  return Object.freeze({
    binding: validated,
    status: doctorStatus,
    connect,
    readThread,
    startTurn,
    waitForTurn,
    admit,
    reconnect,
    shutdown,
    correlationStore,
  });
}

/**
 * Bridge MESH wake hints (helper watch transport / fake transport) into an
 * App Server session without holding mesh_ secrets in the Node process.
 *
 * Wake events are hints only: `resolveDelivery` must reconcile durable mailbox
 * state (empty → skip turn). Production claim/reply/ack for Hermes still needs
 * Slice 6; this bridge only schedules attachment-side turns.
 */
export function createAppServerWakeBridge({
  binding,
  session,
  profiles,
  watchTransport,
  cursorStore = createMemoryCursorStore(0),
  helperPath = null,
  installationId = null,
  actorProfile = null,
  ensureBeforeWatch = false,
  ensureGrant = ensureHelperWatchGrant,
  resolveDelivery,
  coalesceMs = 300,
  wakeClientFactory = createWakeClient,
  logger = console,
} = {}) {
  const validated = validateBinding(binding);
  if (!session || typeof session.admit !== "function") {
    throw new TypeError("session.admit is required");
  }
  if (typeof resolveDelivery !== "function") {
    throw new TypeError("resolveDelivery is required");
  }
  if (!watchTransport || typeof watchTransport.poll !== "function") {
    throw new TypeError("watchTransport.poll is required");
  }

  const wakeProfiles = profiles ?? [
    { instanceId: validated.instanceId, agentId: validated.agentId },
  ];

  let wakeClient = null;
  let started = false;

  async function handleWake(wake) {
    if (wake?.instanceId !== validated.instanceId) return { status: "ignored_profile" };
    const delivery = await resolveDelivery({
      instanceId: wake.instanceId,
      highWatermark: wake.highWatermark,
      reason: wake.reason ?? "wake",
    });
    if (!delivery) return { status: "empty" };
    if (delivery === false) return { status: "empty" };
    const deliveryId = delivery.deliveryId ?? delivery.id;
    const text = delivery.text ?? delivery.prompt;
    if (typeof deliveryId !== "string" || typeof text !== "string" || text.length === 0) {
      throw new TypeError("resolveDelivery must return { deliveryId, text } or null");
    }
    assertNoSecretMaterial({ deliveryId, text }, "delivery");
    return session.admit({
      deliveryId,
      text,
      roomId: delivery.roomId ?? null,
      inboundEventId: delivery.inboundEventId ?? null,
    });
  }

  return Object.freeze({
    binding: validated,

    /**
     * Prefer `createHelperWatchTransport` in production. Exposed for tests /
     * docs so callers never pass raw mesh_watch_ credentials into Node.
     */
    createProductionWatchTransport() {
      if (typeof helperPath !== "string" || helperPath.length === 0) {
        throw new TypeError("helperPath is required for production watch transport");
      }
      const id = installationId ?? validated.installationId;
      return createHelperWatchTransport({ helperPath, installationId: id });
    },

    async start({ signal, maxCycles = Number.POSITIVE_INFINITY } = {}) {
      if (started) throw createCodedError("already_started", "wake bridge already started");
      if (!validated.enabled) {
        return { status: "disabled" };
      }
      if (ensureBeforeWatch) {
        const id = installationId ?? validated.installationId;
        const profile = actorProfile ?? validated.agentId;
        if (typeof helperPath !== "string" || helperPath.length === 0) {
          throw new TypeError("helperPath is required when ensureBeforeWatch is true");
        }
        await ensureGrant({
          helperPath,
          installationId: id,
          actorProfile: profile,
          signal,
        });
      }
      await session.connect();
      wakeClient = wakeClientFactory({
        profiles: wakeProfiles,
        transport: watchTransport,
        cursorStore,
        coalesceMs,
        logger,
        async onWake(wake) {
          try {
            return await handleWake(wake);
          } catch (error) {
            // Admit failures must not tear down the bound wake listener; the
            // next notify/reconcile still needs a live App Server bridge.
            logger.error?.("triangle_app_server_wake_admit_failed", {
              code: error?.code,
              message: error?.message,
              instanceId: wake?.instanceId,
            });
            return { status: "failed", code: error?.code ?? null };
          }
        },
      });
      started = true;
      try {
        await wakeClient.reconcileStartup({ signal });
        return await wakeClient.watch({ signal, maxCycles });
      } catch (error) {
        // Failed start must not leave `started` sticky — supervisor retries
        // call start() again and would otherwise spam already_started.
        try {
          await wakeClient?.stop();
        } catch {
          /* ignore cleanup errors */
        }
        wakeClient = null;
        started = false;
        throw error;
      }
    },

    async stop() {
      await wakeClient?.stop();
      wakeClient = null;
      started = false;
      return session.shutdown();
    },

    handleWake,
  });
}

export {
  createAuthenticatedAppServerTransport,
  createCapabilityTokenAuthResolver,
  createScriptedAuthHandshakeSocket,
  openNodeWebSocket,
  createFakeWatchTransport,
  createHelperWatchTransport,
  createMemoryCursorStore,
  createAtomicFileCursorStore,
  ensureHelperWatchGrant,
  createHelperDurableDeliveryResolver,
  createHelperTrustedTransactionProxy,
  deriveTrustedClaimId,
  deriveTrustedReplyIdempotencyKey,
  resolveTrustedTransactionProxy,
};
