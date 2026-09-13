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
} = {}) {
  if (wakeMode !== "webhook") {
    throw new TypeError(`unsupported grok-bot wakeMode: ${wakeMode}`);
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl is required");
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
          const error = createCodedError(
            "webhook_rejected",
            `grok-bot webhook rejected with status ${status ?? "unknown"}`,
          );
          error.status = status ?? null;
          throw error;
        }
        return { status: "accepted", httpStatus: status };
      } catch (error) {
        if (error?.code === "webhook_rejected") throw error;
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
} = {}) {
  const validated = validateGrokBotBinding(binding);
  if (!watchTransport || typeof watchTransport.poll !== "function") {
    throw new TypeError("watchTransport.poll is required");
  }
  const mode = wakeMode ?? validated.wakeMode;
  const wakeDispatcher = dispatcher ?? createGrokBotWakeDispatcher({
    wakeMode: mode,
    webhookUrlPath,
    webhookKeyPath,
  });

  const wakeProfiles = profiles ?? [
    { instanceId: validated.instanceId, agentId: validated.agentId },
  ];

  let wakeClient = null;
  let started = false;

  async function handleWake(wake) {
    if (wake?.instanceId !== validated.instanceId) return { status: "ignored_profile" };
    const highWatermark = wake.highWatermark;
    if (!Number.isSafeInteger(highWatermark) || highWatermark < 0) {
      throw new TypeError("wake.highWatermark is invalid");
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
    return wakeDispatcher.deliver(payload);
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
