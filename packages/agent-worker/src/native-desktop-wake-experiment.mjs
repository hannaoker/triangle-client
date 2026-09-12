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
import { createServer } from "node:net";

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

  const threadId = env.MESH_DESKTOP_TEST_THREAD_ID;
  if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) {
    throw createCodedError(
      "desktop_experiment_thread_invalid",
      "Set MESH_DESKTOP_TEST_THREAD_ID to a disposable persisted thread id",
    );
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

  return Object.freeze({
    allow: true,
    root,
    threadId,
    serverIdentity,
    authTokenFile: hasFile ? env.MESH_DESKTOP_AUTH_TOKEN_FILE : null,
    authTokenEnv: hasEnv ? env.MESH_DESKTOP_AUTH_TOKEN_ENV : null,
    debugPort: DESKTOP_EXPERIMENT_DEBUG_PORT,
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
