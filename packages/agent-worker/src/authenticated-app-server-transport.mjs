/**
 * Authenticated WebSocket transport for the Shared Codex App Server adapter.
 *
 * Matches the session transport contract: connect / call / onEvent / notify / close.
 * Authenticated `serverIdentity` is returned from `connect()` (WS auth handshake /
 * auth metadata). Live Codex `initialize` may omit `serverInfo.name`; identity
 * must not depend on that field.
 *
 * MESH `mesh_` / `mesh_watch_` credentials never enter this module. App Server
 * capability / signed-bearer tokens stay in helper / desktop auth (file or env
 * name resolved at connect time) and are not logged.
 */

import { readFile } from "node:fs/promises";

const ENDPOINT = /^wss?:\/\/[^\s\0]{1,500}$/i;
const SERVER_IDENTITY = /^[A-Za-z0-9._:/+=-]{1,200}$/;
const BEARER = /^Bearer [^\s\0]{1,4096}$/;

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

function positiveInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function assertEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint)) {
    throw new TypeError("endpoint is invalid");
  }
  assertNoSecretMaterial(endpoint, "endpoint");
  return endpoint;
}

function assertServerIdentity(serverIdentity) {
  if (typeof serverIdentity !== "string" || !SERVER_IDENTITY.test(serverIdentity)) {
    throw new TypeError("serverIdentity is invalid");
  }
  assertNoSecretMaterial(serverIdentity, "serverIdentity");
  return serverIdentity;
}

function normalizeAuthorization(authorization) {
  if (typeof authorization !== "string" || !BEARER.test(authorization)) {
    throw createCodedError("auth_invalid", "authorization must be a Bearer token");
  }
  assertNoSecretMaterial(authorization, "authorization");
  return authorization;
}

/**
 * Resolve an App Server WS capability token from an absolute file or env var
 * name. Returns Bearer authorization + the authenticated server identity claim
 * for the durable binding check (not from initialize).
 */
export function createCapabilityTokenAuthResolver({
  serverIdentity,
  tokenFile = null,
  tokenEnv = null,
  readTokenFile = readFile,
  env = process.env,
} = {}) {
  const identity = assertServerIdentity(serverIdentity);
  if ((tokenFile == null) === (tokenEnv == null)) {
    throw new TypeError("exactly one of tokenFile or tokenEnv is required");
  }
  if (tokenFile != null) {
    if (typeof tokenFile !== "string" || !tokenFile.startsWith("/") || tokenFile.includes("\0")) {
      throw new TypeError("tokenFile is invalid");
    }
  }
  if (tokenEnv != null) {
    if (typeof tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(tokenEnv)) {
      throw new TypeError("tokenEnv is invalid");
    }
  }

  return Object.freeze({
    serverIdentity: identity,
    async resolveAuth() {
      let raw;
      if (tokenFile != null) {
        raw = await readTokenFile(tokenFile, "utf8");
      } else {
        raw = env[tokenEnv];
        if (typeof raw !== "string") {
          throw createCodedError("auth_unavailable", `env ${tokenEnv} is not set`);
        }
      }
      const token = String(raw).trim();
      if (token.length === 0 || token.length > 4096 || /[\r\n\0]/.test(token)) {
        throw createCodedError("auth_invalid", "capability token is invalid");
      }
      assertNoSecretMaterial(token, "capability token");
      return Object.freeze({
        authorization: `Bearer ${token}`,
        serverIdentity: identity,
      });
    },
  });
}

/**
 * Default browser/Node WebSocket opener. Supports Authorization headers on
 * Node's WebSocket constructor options when provided.
 */
export async function openNodeWebSocket(url, { headers = {}, signal } = {}) {
  if (signal?.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }
  if (typeof WebSocket !== "function") {
    throw createCodedError("websocket_unavailable", "WebSocket is not available in this runtime");
  }
  const socket = Object.keys(headers).length > 0
    ? new WebSocket(url, { headers })
    : new WebSocket(url);

  await new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      try { socket.close(); } catch { /* ignore */ }
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(createCodedError("websocket_connect_failed", "WebSocket connection failed"));
    };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  return socket;
}

/**
 * Scripted auth-handshake socket for Linux unit tests (no live Codex desktop).
 *
 * Simulates: Authorization Bearer required → optional server hello carrying
 * `serverIdentity` → JSON-RPC request/response + notifications.
 */
export function createScriptedAuthHandshakeSocket({
  expectedAuthorization,
  serverIdentity,
  initializeResult = {},
  onCall,
  requireAuthorization = true,
  emitServerHello = true,
} = {}) {
  const identity = assertServerIdentity(serverIdentity);
  if (requireAuthorization) {
    normalizeAuthorization(expectedAuthorization);
  }

  return async function openScriptedSocket(_url, { headers = {} } = {}) {
    const authorization = headers.Authorization ?? headers.authorization ?? null;
    if (requireAuthorization) {
      if (authorization !== expectedAuthorization) {
        throw createCodedError("websocket_auth_rejected", "WebSocket authorization rejected");
      }
    }

    const listeners = new Map();
    const pending = new Map();
    let closed = false;
    let nextId = 1;

    function emit(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    }

    function handleClientPayload(raw) {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message?.method && message.id === undefined) {
        // client notification (e.g. initialized)
        return;
      }
      if (message?.method && message.id !== undefined) {
        const respond = async () => {
          if (typeof onCall === "function") {
            const override = await onCall(message.method, message.params ?? {});
            if (override !== undefined) {
              emit("message", { data: JSON.stringify({ id: message.id, result: override }) });
              return;
            }
          }
          switch (message.method) {
            case "initialize":
              // Live Codex may omit serverInfo.name — keep that realistic by default.
              emit("message", {
                data: JSON.stringify({ id: message.id, result: initializeResult }),
              });
              return;
            case "thread/start": {
              const mintedId = `thread_scripted_${String(nextId).padStart(4, "0")}`;
              nextId += 1;
              emit("message", {
                data: JSON.stringify({
                  id: message.id,
                  result: { thread: { id: mintedId, status: { type: "idle" } } },
                }),
              });
              return;
            }
            case "thread/resume":
            case "thread/read":
              emit("message", {
                data: JSON.stringify({
                  id: message.id,
                  result: { thread: { id: message.params?.threadId, status: { type: "idle" }, turns: [] } },
                }),
              });
              return;
            case "turn/start": {
              const turnId = `turn_ws_${String(nextId).padStart(4, "0")}`;
              nextId += 1;
              emit("message", {
                data: JSON.stringify({
                  id: message.id,
                  result: { turn: { id: turnId, status: "in_progress" } },
                }),
              });
              queueMicrotask(() => {
                emit("message", {
                  data: JSON.stringify({
                    method: "turn/started",
                    params: { threadId: message.params?.threadId, turn: { id: turnId, status: "in_progress" } },
                  }),
                });
                queueMicrotask(() => {
                  emit("message", {
                    data: JSON.stringify({
                      method: "turn/completed",
                      params: { threadId: message.params?.threadId, turn: { id: turnId, status: "completed" } },
                    }),
                  });
                });
              });
              return;
            }
            default:
              emit("message", {
                data: JSON.stringify({
                  id: message.id,
                  error: { code: -32601, message: `method not found: ${message.method}` },
                }),
              });
          }
        };
        respond().catch((error) => {
          emit("message", {
            data: JSON.stringify({
              id: message.id,
              error: { code: -32000, message: error?.message ?? "internal error" },
            }),
          });
        });
      }
    }

    let helloSent = false;
    const socket = {
      readyState: 1,
      send(data) {
        if (closed) throw createCodedError("not_connected", "socket is closed");
        handleClientPayload(String(data));
      },
      close() {
        if (closed) return;
        closed = true;
        this.readyState = 3;
        emit("close", {});
      },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
        if (type === "message" && emitServerHello && !helloSent && !closed) {
          helloSent = true;
          queueMicrotask(() => {
            if (closed) return;
            emit("message", {
              data: JSON.stringify({
                method: "triangle/authenticated",
                params: { serverIdentity: identity },
              }),
            });
          });
        }
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      /** Test helper: push a notification as the server. */
      pushNotification(method, params) {
        emit("message", { data: JSON.stringify({ method, params }) });
      },
      pending,
    };

    return socket;
  };
}

/**
 * Production-shaped authenticated App Server WebSocket JSON-RPC transport.
 *
 * @param {object} options
 * @param {string} options.endpoint
 * @param {() => Promise<{authorization: string, serverIdentity: string}>| {authorization: string, serverIdentity: string}} options.resolveAuth
 * @param {(url: string, options: object) => Promise<object>} [options.openSocket]
 * @param {boolean} [options.awaitAuthenticatedHello=false] Wait for
 *   `triangle/authenticated` hello (scripted / helper-mediated). When false
 *   (Codex capability-token path), identity comes from resolveAuth after the
 *   authenticated upgrade succeeds.
 * @param {number} [options.handshakeTimeoutMs]
 */
export function createAuthenticatedAppServerTransport({
  endpoint,
  resolveAuth,
  openSocket = openNodeWebSocket,
  awaitAuthenticatedHello = false,
  handshakeTimeoutMs = 10_000,
  requestTimeoutMs = 30_000,
} = {}) {
  const url = assertEndpoint(endpoint);
  if (typeof resolveAuth !== "function") {
    throw new TypeError("resolveAuth is required");
  }
  if (typeof openSocket !== "function") {
    throw new TypeError("openSocket is required");
  }
  positiveInteger(handshakeTimeoutMs, "handshakeTimeoutMs", 1);
  positiveInteger(requestTimeoutMs, "requestTimeoutMs", 1);

  let socket = null;
  let nextId = 1;
  let serverIdentity = null;
  const pending = new Map();
  const listeners = new Set();
  const retainedEvents = [];

  function emitEvent(event) {
    retainedEvents.push(event);
    for (const listener of listeners) listener(event);
  }

  function onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw?.data ?? raw));
    } catch {
      return;
    }
    if (message?.id !== undefined && message.method === undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) {
        const error = createCodedError(
          "rpc_error",
          typeof message.error?.message === "string" ? message.error.message : "App Server RPC error",
          { rpc: message.error },
        );
        waiter.reject(error);
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (typeof message?.method === "string") {
      emitEvent({ method: message.method, params: message.params });
    }
  }

  function attachSocket(next) {
    socket = next;
    const handleMessage = (event) => onMessage(event?.data ?? event);
    const handleClose = () => {
      socket = null;
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(createCodedError("not_connected", "WebSocket closed"));
      }
    };
    next.addEventListener?.("message", handleMessage);
    next.addEventListener?.("close", handleClose);
    next.onmessage = handleMessage;
    next.onclose = handleClose;
  }

  function identityFromHello(event, expectedIdentity) {
    const identity = assertServerIdentity(event?.params?.serverIdentity);
    if (expectedIdentity != null && identity !== expectedIdentity) {
      throw createCodedError(
        "server_identity_mismatch",
        "authenticated hello identity does not match auth claim",
        { expected: expectedIdentity, actual: identity },
      );
    }
    return identity;
  }

  async function waitForAuthenticatedHello(expectedIdentity) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listeners.delete(listener);
        fn(value);
      };
      const listener = (event) => {
        if (event?.method !== "triangle/authenticated") return;
        try {
          settle(resolve, identityFromHello(event, expectedIdentity));
        } catch (error) {
          settle(reject, error);
        }
      };
      const timer = setTimeout(() => {
        settle(reject, createCodedError("auth_handshake_timeout", "authenticated hello timed out"));
      }, handshakeTimeoutMs);
      listeners.add(listener);
      const existing = retainedEvents.find((event) => event.method === "triangle/authenticated");
      if (existing) listener(existing);
    });
  }

  return Object.freeze({
    get serverIdentity() {
      return serverIdentity;
    },
    get events() {
      return retainedEvents;
    },
    onEvent(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async connect({ signal } = {}) {
      if (socket) {
        await this.close();
      }
      retainedEvents.length = 0;
      const auth = await resolveAuth({ signal });
      const authorization = normalizeAuthorization(auth?.authorization);
      const authIdentity = assertServerIdentity(auth?.serverIdentity);
      const next = await openSocket(url, {
        headers: { Authorization: authorization },
        signal,
      });
      attachSocket(next);
      if (awaitAuthenticatedHello) {
        serverIdentity = await waitForAuthenticatedHello(authIdentity);
      } else {
        serverIdentity = authIdentity;
      }
      return Object.freeze({
        connected: true,
        serverIdentity,
      });
    },
    async call(method, params = {}) {
      if (!socket) throw createCodedError("not_connected", "transport is not connected");
      if (typeof method !== "string" || method.length === 0) {
        throw new TypeError("method is required");
      }
      assertNoSecretMaterial(params, "rpc params");
      const id = nextId;
      nextId += 1;
      const payload = JSON.stringify({ id, method, params });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(createCodedError("request_timeout", `${method} timed out`, { outcome: "unknown" }));
        }, requestTimeoutMs);
        pending.set(id, {
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          socket.send(payload);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    async notify(method, params = {}) {
      if (!socket) throw createCodedError("not_connected", "transport is not connected");
      if (typeof method !== "string" || method.length === 0) {
        throw new TypeError("method is required");
      }
      assertNoSecretMaterial(params, "notify params");
      socket.send(JSON.stringify({ method, params }));
    },
    async close() {
      const current = socket;
      socket = null;
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(createCodedError("not_connected", "transport closed"));
      }
      try {
        current?.close?.();
      } catch {
        /* ignore */
      }
      serverIdentity = null;
    },
  });
}
