/**
 * Native Grok Bot wake adapter (Bob track).
 *
 * Watches MESH installation hints via helper watch transport and POSTs a
 * secret-free wake payload to the operator-bound Grok Bot webhook. Bob owns
 * claim / reply / ack after wake — this adapter never holds mailbox tokens or
 * runs MESH claim/reply/ack.
 */

import { readFile } from "node:fs/promises";

import {
  createFakeWatchTransport,
  createHelperWatchTransport,
  ensureHelperWatchGrant,
} from "./helper-watch-transport.mjs";
import {
  createAtomicFileCursorStore,
  createMemoryCursorStore,
  createWakeClient,
} from "./wake-client.mjs";

const INSTALLATION_ID = /^inst_[A-Za-z0-9_-]{10,75}$/;
const INSTANCE_ID = /^[a-f0-9]{64}$/;
const AGENT_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const PROFILE = /^[A-Za-z0-9._-]{1,64}$/;
const GROK_AGENT_ID = /^[A-Za-z0-9._:-]{8,120}$/;
const WEBHOOK_URL = /^https:\/\/[^\s\0]{1,2000}$/i;
const BINDING_KEYS = [
  "adapterVersion",
  "agentId",
  "enabled",
  "grokAgentId",
  "installationId",
  "instanceId",
  "profile",
  "wakeMode",
];

/** Default temporary circuit-open window after webhook 429 / quota exhaustion. */
export const DEFAULT_QUOTA_BACKOFF_MS = 60_000;
/** Cap for exponential quota backoff and Retry-After honor. */
export const MAX_QUOTA_BACKOFF_MS = 15 * 60_000;
const MAX_WEBHOOK_ERROR_BODY_CHARS = 4_096;
const QUOTA_EXHAUSTION_BODY =
  /resource_exhausted|quota_exceeded|quota[\s_-]?exhaust|rate[\s_-]?limit/i;

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function createCodedError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function positiveBackoffMs(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Parse Retry-After as delta-seconds or HTTP-date. Returns null when absent/invalid.
 */
export function parseRetryAfterMs(headerValue, { now = Date.now() } = {}) {
  if (typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
    return seconds * 1000;
  }
  const when = Date.parse(trimmed);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, when - now);
}

export function isWebhookQuotaExhaustion({ status = null, bodyText = "" } = {}) {
  if (status === 429) return true;
  if (typeof bodyText === "string" && bodyText.length > 0 && QUOTA_EXHAUSTION_BODY.test(bodyText)) {
    return true;
  }
  return false;
}

async function readBoundedErrorBody(response) {
  if (!response || typeof response.text !== "function") return "";
  try {
    const text = await response.text();
    if (typeof text !== "string") return "";
    return text.length > MAX_WEBHOOK_ERROR_BODY_CHARS
      ? text.slice(0, MAX_WEBHOOK_ERROR_BODY_CHARS)
      : text;
  } catch {
    return "";
  }
}

export function validateGrokBotBinding(binding) {
  if (!hasExactKeys(binding, BINDING_KEYS)) {
    throw new TypeError("grok-bot binding schema is invalid");
  }
  if (binding.adapterVersion !== "1") {
    throw new TypeError("grok-bot binding adapterVersion is invalid");
  }
  if (typeof binding.enabled !== "boolean") {
    throw new TypeError("grok-bot binding.enabled must be a boolean");
  }
  if (typeof binding.installationId !== "string" || !INSTALLATION_ID.test(binding.installationId)) {
    throw new TypeError("grok-bot binding.installationId is invalid");
  }
  if (typeof binding.instanceId !== "string" || !INSTANCE_ID.test(binding.instanceId)) {
    throw new TypeError("grok-bot binding.instanceId is invalid");
  }
  if (typeof binding.agentId !== "string" || !AGENT_ID.test(binding.agentId)) {
    throw new TypeError("grok-bot binding.agentId is invalid");
  }
  if (typeof binding.profile !== "string" || !PROFILE.test(binding.profile)) {
    throw new TypeError("grok-bot binding.profile is invalid");
  }
  if (typeof binding.grokAgentId !== "string" || !GROK_AGENT_ID.test(binding.grokAgentId)) {
    throw new TypeError("grok-bot binding.grokAgentId is invalid");
  }
  if (binding.wakeMode !== "webhook") {
    throw new TypeError("grok-bot binding.wakeMode must be webhook");
  }
  return Object.freeze({ ...binding });
}

async function readSecretFile(filePath, label) {
  if (typeof filePath !== "string" || !filePath.startsWith("/") || filePath.includes("\0")) {
    throw new TypeError(`${label} path is invalid`);
  }
  const raw = await readFile(filePath, "utf8");
  const value = raw.replace(/\r?\n$/, "");
  if (value.length === 0 || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new TypeError(`${label} file is invalid`);
  }
  return value;
}

export async function readWebhookCredentials({ webhookUrlPath, webhookKeyPath }) {
  const url = await readSecretFile(webhookUrlPath, "webhookUrl");
  if (!WEBHOOK_URL.test(url)) {
    throw new TypeError("webhookUrl must be https");
  }
  const key = await readSecretFile(webhookKeyPath, "webhookKey");
  if (key.length < 8 || key.length > 4096) {
    throw new TypeError("webhookKey length is invalid");
  }
  return Object.freeze({ url, key });
}

/**
 * Pluggable wake-mode dispatcher. Only `webhook` is shipped today.
 */
export function createGrokBotWakeDispatcher({
  wakeMode = "webhook",
  fetchImpl = globalThis.fetch,
  readCredentials = readWebhookCredentials,
  webhookUrlPath,
  webhookKeyPath,
  timeoutMs = 15_000,
  now = Date.now,
} = {}) {
  if (wakeMode !== "webhook") {
    throw new TypeError(`unsupported grok-bot wakeMode: ${wakeMode}`);
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl is required");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  return Object.freeze({
    wakeMode: "webhook",

    async deliver(payload, { signal } = {}) {
      const { url, key } = await readCredentials({ webhookUrlPath, webhookKeyPath });
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener?.("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const status = response?.status;
        if (!Number.isSafeInteger(status) || status < 200 || status >= 300) {
          const bodyText = await readBoundedErrorBody(response);
          const retryAfterHeader =
            typeof response?.headers?.get === "function"
              ? response.headers.get("retry-after")
              : null;
          const retryAfterMs = parseRetryAfterMs(retryAfterHeader, { now: now() });
          const quotaExhausted = isWebhookQuotaExhaustion({ status, bodyText });
          const error = createCodedError(
            quotaExhausted ? "webhook_quota_exhausted" : "webhook_rejected",
            quotaExhausted
              ? `grok-bot webhook quota exhausted with status ${status ?? "unknown"}`
              : `grok-bot webhook rejected with status ${status ?? "unknown"}`,
          );
          error.status = status ?? null;
          error.retryAfterMs = retryAfterMs;
          error.quotaExhausted = quotaExhausted;
          throw error;
        }
        return { status: "accepted", httpStatus: status };
      } catch (error) {
        if (error?.code === "webhook_rejected" || error?.code === "webhook_quota_exhausted") {
          throw error;
        }
        if (signal?.aborted || error?.name === "AbortError") {
          const aborted = createCodedError("webhook_aborted", "grok-bot webhook aborted");
          aborted.cause = error;
          throw aborted;
        }
        const failed = createCodedError("webhook_failed", "grok-bot webhook delivery failed");
        failed.cause = error;
        throw failed;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      }
    },
  });
}

/**
 * Bridge MESH wake hints into a Grok Bot webhook wake.
 * Does not claim, reply, or ack — Bob's Grok session owns that after wake.
 *
 * Quota circuit breaker: after webhook 429 / resource_exhausted, suppress
 * further POSTs for a temporary window keyed by binding.instanceId. Success
 * clears the window; skipped wakes do not re-alert.
 */
export function createGrokBotWakeBridge({
  binding,
  profiles,
  watchTransport,
  cursorStore = createMemoryCursorStore(0),
  helperPath = null,
  installationId = null,
  actorProfile = null,
  ensureBeforeWatch = false,
  ensureGrant = ensureHelperWatchGrant,
  webhookUrlPath,
  webhookKeyPath,
  wakeMode = null,
  dispatcher = null,
  coalesceMs = 300,
  wakeClientFactory = createWakeClient,
  logger = console,
  now = Date.now,
  initialQuotaBackoffMs = DEFAULT_QUOTA_BACKOFF_MS,
  maxQuotaBackoffMs = MAX_QUOTA_BACKOFF_MS,
} = {}) {
  const validated = validateGrokBotBinding(binding);
  if (!watchTransport || typeof watchTransport.poll !== "function") {
    throw new TypeError("watchTransport.poll is required");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  const initialBackoff = positiveBackoffMs(initialQuotaBackoffMs, "initialQuotaBackoffMs");
  const maxBackoff = positiveBackoffMs(maxQuotaBackoffMs, "maxQuotaBackoffMs");
  if (initialBackoff > maxBackoff) {
    throw new TypeError("initialQuotaBackoffMs must be <= maxQuotaBackoffMs");
  }

  const mode = wakeMode ?? validated.wakeMode;
  const wakeDispatcher = dispatcher ?? createGrokBotWakeDispatcher({
    wakeMode: mode,
    webhookUrlPath,
    webhookKeyPath,
    now,
  });

  const wakeProfiles = profiles ?? [
    { instanceId: validated.instanceId, agentId: validated.agentId },
  ];

  let wakeClient = null;
  let started = false;
  // Keyed by binding.instanceId (one bridge owns one Bob profile binding).
  /** @type {{ instanceId: string, untilMs: number, backoffMs: number, alertLogged: boolean } | null} */
  let quotaBackoff = null;

  function clearQuotaBackoff() {
    quotaBackoff = null;
  }

  function openQuotaBackoff({ retryAfterMs = null } = {}) {
    const nowMs = now();
    const previous = quotaBackoff?.instanceId === validated.instanceId
      ? quotaBackoff.backoffMs
      : null;
    const exponential = previous == null
      ? initialBackoff
      : Math.min(maxBackoff, previous * 2);
    const fromHeader = Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : 0;
    // Fail-closed on quota: take the longer of exponential vs Retry-After, capped.
    const backoffMs = Math.min(maxBackoff, Math.max(exponential, fromHeader));
    const alreadyOpen = quotaBackoff != null
      && quotaBackoff.instanceId === validated.instanceId
      && nowMs < quotaBackoff.untilMs;
    quotaBackoff = {
      instanceId: validated.instanceId,
      untilMs: nowMs + backoffMs,
      backoffMs,
      // Preserve "already alerted" while the circuit remains open so routine
      // watch hints do not re-fire failure/alert logs.
      alertLogged: alreadyOpen ? quotaBackoff.alertLogged : false,
    };
    return quotaBackoff;
  }

  function activeQuotaBackoff(nowMs = now()) {
    if (!quotaBackoff) return null;
    if (quotaBackoff.instanceId !== validated.instanceId) return null;
    if (nowMs >= quotaBackoff.untilMs) return null;
    return quotaBackoff;
  }

  async function handleWake(wake) {
    if (wake?.instanceId !== validated.instanceId) return { status: "ignored_profile" };
    const highWatermark = wake.highWatermark;
    if (!Number.isSafeInteger(highWatermark) || highWatermark < 0) {
      throw new TypeError("wake.highWatermark is invalid");
    }

    const open = activeQuotaBackoff();
    if (open) {
      return {
        status: "skipped_backoff",
        code: "webhook_quota_exhausted",
        instanceId: validated.instanceId,
        untilMs: open.untilMs,
        backoffMs: open.backoffMs,
      };
    }

    const payload = {
      source: "triangle-client",
      type: "mesh.mailbox.wake",
      installationId: validated.installationId,
      instanceId: validated.instanceId,
      agentId: validated.agentId,
      profile: validated.profile,
      highWatermark,
      reason: typeof wake.reason === "string" && wake.reason.length > 0 ? wake.reason : "wake",
    };

    try {
      const result = await wakeDispatcher.deliver(payload);
      // Successful delivery clears circuit + alert/logging state.
      clearQuotaBackoff();
      return result;
    } catch (error) {
      const quotaExhausted = error?.code === "webhook_quota_exhausted"
        || error?.quotaExhausted === true
        || error?.status === 429;
      if (!quotaExhausted) throw error;

      const state = openQuotaBackoff({ retryAfterMs: error?.retryAfterMs ?? null });
      if (!state.alertLogged) {
        logger.error?.("triangle_grok_bot_quota_backoff", {
          code: "webhook_quota_exhausted",
          message: error?.message,
          instanceId: validated.instanceId,
          httpStatus: error?.status ?? null,
          backoffMs: state.backoffMs,
          untilMs: state.untilMs,
          reason: typeof wake?.reason === "string" ? wake.reason.slice(0, 64) : undefined,
        });
        state.alertLogged = true;
      }
      return {
        status: "backoff",
        code: "webhook_quota_exhausted",
        httpStatus: error?.status ?? null,
        instanceId: validated.instanceId,
        untilMs: state.untilMs,
        backoffMs: state.backoffMs,
      };
    }
  }

  return Object.freeze({
    binding: validated,

    createProductionWatchTransport() {
      if (typeof helperPath !== "string" || helperPath.length === 0) {
        throw new TypeError("helperPath is required for production watch transport");
      }
      const id = installationId ?? validated.installationId;
      return createHelperWatchTransport({ helperPath, installationId: id });
    },

    getQuotaBackoffState() {
      const open = activeQuotaBackoff();
      if (!open) return null;
      return Object.freeze({
        instanceId: open.instanceId,
        untilMs: open.untilMs,
        backoffMs: open.backoffMs,
        alertLogged: open.alertLogged,
      });
    },

    async start({ signal, maxCycles = Number.POSITIVE_INFINITY } = {}) {
      if (started) throw createCodedError("already_started", "wake bridge already started");
      if (!validated.enabled) {
        return { status: "disabled" };
      }
      if (ensureBeforeWatch) {
        const id = installationId ?? validated.installationId;
        const profile = actorProfile ?? validated.profile;
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
            // Webhook failures must not tear down the watch loop; next notify
            // still needs a live bridge. Never log the webhook key or URL.
            logger.error?.("triangle_grok_bot_wake_failed", {
              code: error?.code,
              message: error?.message,
              instanceId: wake?.instanceId,
              httpStatus: error?.status ?? null,
              reason: typeof wake?.reason === "string" ? wake.reason.slice(0, 64) : undefined,
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
      return { status: "stopped" };
    },

    handleWake,
  });
}

export {
  createFakeWatchTransport,
  createHelperWatchTransport,
  createMemoryCursorStore,
  createAtomicFileCursorStore,
  ensureHelperWatchGrant,
};
