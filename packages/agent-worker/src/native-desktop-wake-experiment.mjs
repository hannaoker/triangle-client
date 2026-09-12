/**
 * Production-shaped native-desktop nonce wake helpers.
 *
 * Thin glue around createAuthenticatedAppServerTransport + createSharedCodexSession
 * for the Mac ChatGPT.app experiment. Linux unit tests cover guards, nonce text,
 * and the listener path with a scripted socket — they do not launch the desktop.
 *
 * MESH mesh_ / mesh_watch_ secrets never enter this module. App Server capability
 * tokens stay in an absolute file or env *name* (same custody model as supervisor
 * appServerWake).
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import {
  SHARED_CODEX_ADAPTER_VERSION,
  createAuthenticatedAppServerTransport,
  createCapabilityTokenAuthResolver,
  createSharedCodexSession,
  validateBinding,
} from "./shared-codex-app-server.mjs";

export const DESKTOP_EXPERIMENT_DEBUG_PORT = 63999;
export const DESKTOP_EXPERIMENT_PRIVATE_ROOT_PREFIX = "/private/tmp/";
export const DESKTOP_EXPERIMENT_REPLY_MARKER = "DESKTOP_SHARED_WAKE_OK";
export const DESKTOP_EXPERIMENT_SEED_REPLY_MARKER = "DESKTOP_THREAD_SEED_OK";

const INSTALLATION_ID = /^inst_[A-Za-z0-9_-]{10,75}$/;
const INSTANCE_ID = /^[a-f0-9]{64}$/;
const AGENT_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const THREAD_ID = /^[A-Za-z0-9._:-]{8,120}$/;
const TOKEN_ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SERVER_IDENTITY = /^[A-Za-z0-9._:/+=-]{1,200}$/;
const ENDPOINT = /^wss?:\/\/[^\s\0]{1,500}$/i;

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Opt-in guards shared with the archived Mac experiment.
 * Does not launch ChatGPT.app; safe to call on Linux.
 */
export function assertDesktopExperimentGuards(env = process.env) {
  if (env.MESH_ALLOW_DESKTOP_EXPERIMENT !== "1") {
    throw createCodedError(
      "desktop_experiment_opt_in_required",
      "Opt-in required; set MESH_ALLOW_DESKTOP_EXPERIMENT=1 after reviewing the handoff",
    );
  }

  const root = env.MESH_DESKTOP_TEST_ROOT;
  if (typeof root !== "string" || !root.startsWith(DESKTOP_EXPERIMENT_PRIVATE_ROOT_PREFIX)) {
    throw createCodedError(
      "desktop_experiment_root_invalid",
      `Set MESH_DESKTOP_TEST_ROOT to a fresh path under ${DESKTOP_EXPERIMENT_PRIVATE_ROOT_PREFIX}`,
    );
  }
  if (root.includes("\0") || root.length > 500) {
    throw createCodedError("desktop_experiment_root_invalid", "MESH_DESKTOP_TEST_ROOT is invalid");
  }

  // Optional override only. Default Mac path mints a thread on the ephemeral
  // app-server after readyz — do not paste a normal-Codex thread id.
  let threadId = null;
  if (env.MESH_DESKTOP_TEST_THREAD_ID != null && env.MESH_DESKTOP_TEST_THREAD_ID !== "") {
    if (typeof env.MESH_DESKTOP_TEST_THREAD_ID !== "string" || !THREAD_ID.test(env.MESH_DESKTOP_TEST_THREAD_ID)) {
      throw createCodedError(
        "desktop_experiment_thread_invalid",
        "MESH_DESKTOP_TEST_THREAD_ID override must be a disposable thread id that already exists on this app-server",
      );
    }
    threadId = env.MESH_DESKTOP_TEST_THREAD_ID;
  }

  const hasFile = typeof env.MESH_DESKTOP_AUTH_TOKEN_FILE === "string"
    && env.MESH_DESKTOP_AUTH_TOKEN_FILE.length > 0;
  const hasEnv = typeof env.MESH_DESKTOP_AUTH_TOKEN_ENV === "string"
    && env.MESH_DESKTOP_AUTH_TOKEN_ENV.length > 0;
  if (hasFile === hasEnv) {
    throw createCodedError(
      "desktop_experiment_auth_invalid",
      "Set exactly one of MESH_DESKTOP_AUTH_TOKEN_FILE or MESH_DESKTOP_AUTH_TOKEN_ENV",
    );
  }
  if (hasFile) {
    const tokenFile = env.MESH_DESKTOP_AUTH_TOKEN_FILE;
    if (!tokenFile.startsWith("/") || tokenFile.includes("\0")) {
      throw createCodedError(
        "desktop_experiment_auth_invalid",
        "MESH_DESKTOP_AUTH_TOKEN_FILE must be an absolute path",
      );
    }
  } else if (!TOKEN_ENV.test(env.MESH_DESKTOP_AUTH_TOKEN_ENV)) {
    throw createCodedError(
      "desktop_experiment_auth_invalid",
      "MESH_DESKTOP_AUTH_TOKEN_ENV must be an env var name",
    );
  }

  const serverIdentity = env.MESH_DESKTOP_SERVER_IDENTITY;
  if (typeof serverIdentity !== "string" || !SERVER_IDENTITY.test(serverIdentity)) {
    throw createCodedError(
      "desktop_experiment_identity_invalid",
      "Set MESH_DESKTOP_SERVER_IDENTITY to the durable binding identity claim",
    );
  }

  // Optional: operator's real Codex home for API auth. Default remains
  // `${MESH_DESKTOP_TEST_ROOT}/codex`. UI data stays under the private root.
  let codexHome = path.join(root, "codex");
  let codexHomeSource = "test_root";
  if (env.MESH_DESKTOP_CODEX_HOME != null && env.MESH_DESKTOP_CODEX_HOME !== "") {
    const override = env.MESH_DESKTOP_CODEX_HOME;
    if (typeof override !== "string" || !override.startsWith("/") || override.includes("\0")) {
      throw createCodedError(
        "desktop_experiment_codex_home_invalid",
        "MESH_DESKTOP_CODEX_HOME must be an absolute path",
      );
    }
    if (!existsSync(override)) {
      throw createCodedError(
        "desktop_experiment_codex_home_missing",
        "MESH_DESKTOP_CODEX_HOME does not exist",
        { codexHome: override },
      );
    }
    codexHome = override;
    codexHomeSource = "override";
  }

  return Object.freeze({
    allow: true,
    root,
    threadId,
    serverIdentity,
    authTokenFile: hasFile ? env.MESH_DESKTOP_AUTH_TOKEN_FILE : null,
    authTokenEnv: hasEnv ? env.MESH_DESKTOP_AUTH_TOKEN_ENV : null,
    debugPort: DESKTOP_EXPERIMENT_DEBUG_PORT,
    codexHome,
    codexHomeSource,
  });
}

export function createDesktopExperimentNonce(entropy = randomBytes) {
  const stamp = Date.now().toString(36);
  const bytes = typeof entropy === "function" ? entropy(6) : entropy;
  const suffix = Buffer.from(bytes).toString("hex");
  return `NDW_${stamp}_${suffix}`;
}

/**
 * Unique-nonce turn text for Gate A acceptance (server events + visible reply).
 */
export function buildNonceWakeTurnText(nonce) {
  if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 120 || /[\r\n\0]/.test(nonce)) {
    throw new TypeError("nonce is invalid");
  }
  return [
    "Synthetic external desktop shared-server probe via createAuthenticatedAppServerTransport",
    "+ createSharedCodexSession, not Bob.",
    `Nonce ${nonce}.`,
    "Do not use tools.",
    `Reply exactly ${DESKTOP_EXPERIMENT_REPLY_MARKER} ${nonce}.`,
  ].join(" ");
}

export function buildDesktopExperimentBinding({
  threadId,
  endpoint,
  serverIdentity,
  installationId = "inst_desktopexp01",
  instanceId = "b".repeat(64),
  agentId = "agent_desktop_nonce_wake",
  roomScope = "room_desktop_nonce_wake",
  enabled = true,
  adapterVersion = SHARED_CODEX_ADAPTER_VERSION,
} = {}) {
  if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint)) {
    throw new TypeError("endpoint is invalid");
  }
  if (typeof installationId !== "string" || !INSTALLATION_ID.test(installationId)) {
    throw new TypeError("installationId is invalid");
  }
  if (typeof instanceId !== "string" || !INSTANCE_ID.test(instanceId)) {
    throw new TypeError("instanceId is invalid");
  }
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) {
    throw new TypeError("agentId is invalid");
  }
  return validateBinding({
    adapterVersion,
    enabled,
    installationId,
    instanceId,
    agentId,
    roomScope,
    serverIdentity,
    endpoint,
    threadId,
  });
}

/**
 * True when nothing is listening on 127.0.0.1:port (default debug port 63999).
 */
export async function assertDebugPortFree(port = DESKTOP_EXPERIMENT_DEBUG_PORT) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("port is invalid");
  }
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw createCodedError(
        "desktop_experiment_debug_port_busy",
        `Debug port ${port} is in use; free it before launching ChatGPT.app`,
        { port },
      );
    }
    throw error;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  return true;
}

/**
 * After app-server readyz: authenticate, then mint a disposable thread on *this*
 * server (default) or resume an override id that already exists here.
 *
 * Never assumes a thread from the operator's ordinary Codex home exists on an
 * ephemeral MESH_DESKTOP_TEST_ROOT CODEX_HOME.
 */

/**
 * Confirm a thread is resumeable/readable on the current authenticated connection.
 * Live App Server fails closed with "no rollout found" when the thread is not durable yet.
 */
export async function assertThreadResumeable(transport, threadId) {
  if (!transport || typeof transport.call !== "function") {
    throw new TypeError("transport.call is required");
  }
  if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) {
    throw createCodedError("desktop_experiment_thread_invalid", "threadId is invalid");
  }
  const resumed = await transport.call("thread/resume", { threadId });
  const resumedId = resumed?.thread?.id;
  if (resumedId !== threadId) {
    throw createCodedError(
      "desktop_experiment_thread_not_resumeable",
      "thread/resume did not return the expected thread id",
      { threadId, resumedId: resumedId ?? null },
    );
  }
  const read = await transport.call("thread/read", { threadId, includeTurns: true });
  const readId = read?.thread?.id;
  if (readId !== threadId) {
    throw createCodedError(
      "desktop_experiment_thread_not_resumeable",
      "thread/read did not return the expected thread id",
      { threadId, readId: readId ?? null },
    );
  }
  return Object.freeze({ resumed, read });
}

/**
 * Wait for turn/completed on the same transport (used to persist rollout after mint).
 */
export async function waitForTurnCompleted(transport, turnId, { timeoutMs = 45_000 } = {}) {
  if (typeof turnId !== "string" || turnId.length === 0) {
    throw new TypeError("turnId is required");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs is invalid");
  }
  const existing = [...(transport.events ?? [])].find(
    (event) => event?.method === "turn/completed" && event?.params?.turn?.id === turnId,
  );
  if (existing) return existing.params.turn;

  if (typeof transport.onEvent !== "function") {
    throw createCodedError(
      "desktop_experiment_seed_timeout",
      "transport.onEvent is required to wait for seed turn completion",
      { turnId },
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { unsubscribe?.(); } catch { /* ignore */ }
      fn(value);
    };
    const timer = setTimeout(() => {
      settle(reject, createCodedError(
        "desktop_experiment_seed_timeout",
        "seed turn completion timed out",
        { turnId, outcome: "unknown" },
      ));
    }, timeoutMs);
    unsubscribe = transport.onEvent((event) => {
      if (event?.method !== "turn/completed") return;
      if (event?.params?.turn?.id !== turnId) return;
      settle(resolve, event.params.turn);
    });
  });
}

/**
 * Parse desktop logs for a successful resume/active stream — never treat a bare
 * `thread/resume` method name (including -32600 failures) as attachment.
 */
export function createDesktopResumeProbe({ threadId }) {
  if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) {
    throw createCodedError("desktop_experiment_thread_invalid", "threadId is invalid");
  }
  let resumeSeen = false;
  let resumeFailed = false;
  let attached = false;
  let failReason = null;
  const failurePattern = /errorCode\s*[:=]\s*-32600|-32600|no rollout found|failed to (?:load|resume)|thread_not_found/i;
  const successPattern = /thread_stream_view_activity_changed\s+active=true|thread\/resume[^\n]*(?:ok|success|status["']?\s*:\s*["']?ok)/i;

  function onLog(text) {
    if (typeof text !== "string" || text.length === 0) return;
    for (const line of text.split(/\r?\n/)) {
      if (line.includes("thread/resume")) {
        resumeSeen = true;
        if (failurePattern.test(line) || (line.includes(threadId) && failurePattern.test(line))) {
          resumeFailed = true;
          attached = false;
          failReason = line.slice(0, 500);
        }
      }
      if (line.includes(threadId) && failurePattern.test(line)) {
        resumeFailed = true;
        attached = false;
        failReason = line.slice(0, 500);
      }
      if (line.includes(threadId) && /active\s*=\s*true/i.test(line) && !failurePattern.test(line) && !resumeFailed) {
        attached = true;
      }
      if (line.includes(threadId) && successPattern.test(line) && !resumeFailed) {
        attached = true;
      }
    }
  }

  return Object.freeze({
    onLog,
    get attached() {
      return attached && !resumeFailed;
    },
    get resumeSeen() {
      return resumeSeen;
    },
    get resumeFailed() {
      return resumeFailed;
    },
    get failReason() {
      return failReason;
    },
    status() {
      return Object.freeze({
        attached: attached && !resumeFailed,
        resumeSeen,
        resumeFailed,
        failReason,
        threadId,
      });
    },
  });
}

export async function resolveDesktopExperimentThread({
  endpoint,
  serverIdentity,
  tokenFile = null,
  tokenEnv = null,
  resolveAuth = null,
  preferredThreadId = null,
  cwd,
  awaitAuthenticatedHello = false,
  openSocket,
  requestTimeoutMs = 45_000,
  createTransport = createAuthenticatedAppServerTransport,
  createAuthResolver = createCapabilityTokenAuthResolver,
  threadStartParams = null,
} = {}) {
  if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint)) {
    throw new TypeError("endpoint is invalid");
  }
  if (typeof serverIdentity !== "string" || !SERVER_IDENTITY.test(serverIdentity)) {
    throw new TypeError("serverIdentity is invalid");
  }
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    throw new TypeError("cwd is required");
  }
  if (preferredThreadId != null) {
    if (typeof preferredThreadId !== "string" || !THREAD_ID.test(preferredThreadId)) {
      throw createCodedError(
        "desktop_experiment_thread_invalid",
        "preferredThreadId is invalid",
      );
    }
  }

  let authResolve = resolveAuth;
  if (authResolve == null) {
    const resolver = createAuthResolver({
      serverIdentity,
      tokenFile,
      tokenEnv,
    });
    authResolve = () => resolver.resolveAuth();
  }
  if (typeof authResolve !== "function") {
    throw new TypeError("resolveAuth is required");
  }

  const transportOptions = {
    endpoint,
    resolveAuth: authResolve,
    awaitAuthenticatedHello,
    requestTimeoutMs,
  };
  if (openSocket != null) transportOptions.openSocket = openSocket;

  const transport = createTransport(transportOptions);
  try {
    await transport.connect();
    await transport.call("initialize", {
      clientInfo: {
        name: "triangle-desktop-experiment-mint",
        title: "Triangle desktop experiment thread mint",
        version: SHARED_CODEX_ADAPTER_VERSION,
      },
    });
    if (typeof transport.notify === "function") {
      await transport.notify("initialized", {});
    }

    if (preferredThreadId != null) {
      try {
        await assertThreadResumeable(transport, preferredThreadId);
        return Object.freeze({
          threadId: preferredThreadId,
          source: "override",
          seedTurnId: null,
          resumeVerified: true,
          serverIdentity: transport.serverIdentity ?? serverIdentity,
        });
      } catch (error) {
        if (error?.code === "desktop_experiment_thread_missing") throw error;
        throw createCodedError(
          "desktop_experiment_thread_missing",
          "MESH_DESKTOP_TEST_THREAD_ID override was not found on this app-server; omit it to mint a disposable thread",
          {
            preferredThreadId,
            causeCode: error?.code ?? null,
            causeMessage: typeof error?.message === "string" ? error.message : null,
          },
        );
      }
    }

    const startParams = threadStartParams ?? {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
    };
    const started = await transport.call("thread/start", startParams);
    const mintedId = started?.thread?.id;
    if (typeof mintedId !== "string" || !THREAD_ID.test(mintedId)) {
      throw createCodedError(
        "desktop_experiment_thread_mint_failed",
        "thread/start did not return a usable thread id",
        { resultType: typeof mintedId },
      );
    }

    // Live App Server often has no durable rollout until a seed turn completes.
    // Persist on this same connection, then prove resume/read before desktop launch.
    const seedStarted = await transport.call("turn/start", {
      threadId: mintedId,
      input: [{
        type: "text",
        text: [
          "Desktop experiment seed turn to persist rollout.",
          "Do not use tools.",
          `Reply exactly ${DESKTOP_EXPERIMENT_SEED_REPLY_MARKER}.`,
        ].join(" "),
      }],
    });
    const seedTurnId = seedStarted?.turn?.id;
    if (typeof seedTurnId !== "string" || seedTurnId.length === 0) {
      throw createCodedError(
        "desktop_experiment_thread_mint_failed",
        "seed turn/start did not return a turn id",
        { threadId: mintedId },
      );
    }
    const seedTurn = await waitForTurnCompleted(transport, seedTurnId, {
      timeoutMs: requestTimeoutMs,
    });
    if (seedTurn?.status && seedTurn.status !== "completed") {
      throw createCodedError(
        "desktop_experiment_thread_mint_failed",
        "seed turn did not complete successfully",
        { threadId: mintedId, seedTurnId, status: seedTurn.status },
      );
    }

    try {
      await assertThreadResumeable(transport, mintedId);
    } catch (error) {
      throw createCodedError(
        "desktop_experiment_thread_not_resumeable",
        "minted thread is not resumeable after seed turn; refusing to launch desktop",
        {
          threadId: mintedId,
          seedTurnId,
          causeCode: error?.code ?? null,
          causeMessage: typeof error?.message === "string" ? error.message : null,
        },
      );
    }

    return Object.freeze({
      threadId: mintedId,
      source: "minted",
      seedTurnId,
      resumeVerified: true,
      serverIdentity: transport.serverIdentity ?? serverIdentity,
    });
  } finally {
    try {
      await transport.close();
    } catch {
      /* ignore close races */
    }
  }
}

/**
 * Thin runner: authenticated transport + shared session startTurn/waitForTurn.
 * Injectable openSocket for Linux scripted tests.
 */
export async function runNativeDesktopWakeListener({
  binding,
  nonce,
  tokenFile = null,
  tokenEnv = null,
  resolveAuth = null,
  awaitAuthenticatedHello = false,
  openSocket,
  requestTimeoutMs = 45_000,
  waitTimeoutMs = 45_000,
  createTransport = createAuthenticatedAppServerTransport,
  createSession = createSharedCodexSession,
  createAuthResolver = createCapabilityTokenAuthResolver,
  logger = console,
} = {}) {
  const validated = validateBinding(binding);
  const wakeNonce = typeof nonce === "string" ? nonce : createDesktopExperimentNonce();
  const text = buildNonceWakeTurnText(wakeNonce);
  const deliveryId = `desktop_nonce_${wakeNonce}`;

  let authResolve = resolveAuth;
  if (authResolve == null) {
    const resolver = createAuthResolver({
      serverIdentity: validated.serverIdentity,
      tokenFile,
      tokenEnv,
    });
    authResolve = () => resolver.resolveAuth();
  }
  if (typeof authResolve !== "function") {
    throw new TypeError("resolveAuth is required");
  }

  const transportOptions = {
    endpoint: validated.endpoint,
    resolveAuth: authResolve,
    awaitAuthenticatedHello,
    requestTimeoutMs,
  };
  if (openSocket != null) transportOptions.openSocket = openSocket;

  const transport = createTransport(transportOptions);
  const session = createSession({
    binding: validated,
    transport,
    requestTimeoutMs,
    logger,
  });

  const evidence = {
    nonce: wakeNonce,
    deliveryId,
    threadId: validated.threadId,
    endpoint: validated.endpoint,
    serverIdentity: validated.serverIdentity,
    turnText: text,
    turnId: null,
    turnStatus: null,
    sessionStatus: null,
  };

  try {
    const connected = await session.connect();
    evidence.sessionStatus = connected.status;
    logger.log?.(JSON.stringify({
      at: new Date().toISOString(),
      test: "listener_subscribed",
      status: connected.status,
      threadId: validated.threadId,
      serverIdentity: validated.serverIdentity,
      nonce: wakeNonce,
    }));

    const started = await session.startTurn({
      deliveryId,
      input: [{ type: "text", text }],
    });
    evidence.turnId = started?.turn?.id ?? null;
    logger.log?.(JSON.stringify({
      at: new Date().toISOString(),
      test: "listener_turn_started",
      threadId: validated.threadId,
      turnId: evidence.turnId,
      nonce: wakeNonce,
    }));

    if (typeof evidence.turnId !== "string") {
      throw createCodedError("submission_unknown", "turn/start returned no turn id", {
        outcome: "unknown",
      });
    }

    const turn = await session.waitForTurn(evidence.turnId, { timeoutMs: waitTimeoutMs });
    evidence.turnStatus = turn?.status ?? null;
    evidence.sessionStatus = session.status().status;
    logger.log?.(JSON.stringify({
      at: new Date().toISOString(),
      test: "listener_turn_completed",
      threadId: validated.threadId,
      turnId: evidence.turnId,
      status: evidence.turnStatus,
      nonce: wakeNonce,
      expectedReply: `${DESKTOP_EXPERIMENT_REPLY_MARKER} ${wakeNonce}`,
    }));
    return Object.freeze(evidence);
  } finally {
    try {
      await session.shutdown();
    } catch {
      /* ignore shutdown races during cleanup */
    }
  }
}
