import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createHelperDurableDeliveryResolver,
  createHelperTrustedTransactionProxy,
} from "../helper-transaction-proxy.mjs";
import { createDurableConversationStore } from "./durable-conversation-store.mjs";
import { createHeadlessCodexDrain } from "./headless-drain.mjs";
import { createHeadlessCodexRuntime } from "./headless-runtime.mjs";

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INSTANCE = /^[a-f0-9]{64}$/;
const ROOM = /^room_[a-f0-9]{32}$/;

export function deriveProfileInstanceId(profile) {
  if (typeof profile !== "string" || !PROFILE.test(profile)) {
    throw new TypeError("profile is invalid");
  }
  const framed = Buffer.concat([
    Buffer.from("triangle-client-instance-v1"),
    Buffer.from([0]),
    Buffer.from(profile),
  ]);
  return crypto.createHash("sha256").update(framed).digest("hex");
}

function requiredAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

export function loadHeadlessDrainConfig({ profile, env = process.env } = {}) {
  if (typeof profile !== "string" || !PROFILE.test(profile)) {
    throw new TypeError("profile is invalid");
  }
  const home = requiredAbsolute(env.HOME, "HOME");
  const applicationRoot = path.join(home, "Library", "Application Support", "The Triangle");
  const profileInstanceId = env.TRIANGLE_INSTANCE_ID ?? deriveProfileInstanceId(profile);
  if (!INSTANCE.test(profileInstanceId)) throw new TypeError("TRIANGLE_INSTANCE_ID is invalid");
  if (profileInstanceId !== deriveProfileInstanceId(profile)) {
    throw new TypeError("TRIANGLE_INSTANCE_ID does not match profile");
  }
  const codexHome = requiredAbsolute(env.TRIANGLE_CODEX_HOME, "TRIANGLE_CODEX_HOME");
  const workingDirectory = requiredAbsolute(
    env.TRIANGLE_HEADLESS_WORKING_DIRECTORY,
    "TRIANGLE_HEADLESS_WORKING_DIRECTORY",
  );
  const helperPath = requiredAbsolute(
    env.TRIANGLE_MAILBOX_HELPER ?? path.join(applicationRoot, "bin", "triangle-mailbox"),
    "TRIANGLE_MAILBOX_HELPER",
  );
  const stateRoot = requiredAbsolute(
    env.TRIANGLE_HEADLESS_STATE_ROOT ??
      path.join(applicationRoot, "model-state", "instances", profileInstanceId, "codex-runtime"),
    "TRIANGLE_HEADLESS_STATE_ROOT",
  );
  const command = requiredAbsolute(env.CODEX_CLI, "CODEX_CLI");
  const allowedRoomId = env.TRIANGLE_HEADLESS_ROOM_ID;
  if (typeof allowedRoomId !== "string" || !ROOM.test(allowedRoomId)) {
    throw new TypeError("TRIANGLE_HEADLESS_ROOM_ID is invalid");
  }
  const pollIntervalMs = Number(env.TRIANGLE_HEADLESS_POLL_INTERVAL_MS ?? 1_000);
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
    throw new TypeError("TRIANGLE_HEADLESS_POLL_INTERVAL_MS is invalid");
  }
  const allowlist = new Set(
    String(env.TRIANGLE_HEADLESS_RUNTIME_PROFILES ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  if (env.TRIANGLE_PHASE5_MIGRATION_ENABLE !== "1" || !allowlist.has(profile)) {
    throw new TypeError("profile is not explicitly enabled for the Phase 5 headless runtime");
  }
  return Object.freeze({
    profile,
    profileInstanceId,
    codexHome,
    workingDirectory,
    helperPath,
    stateRoot,
    command,
    pollIntervalMs,
    allowedRoomId,
    env,
  });
}

export function createInstalledHeadlessDrain(config, { logger = console } = {}) {
  mkdirSync(config.stateRoot, { recursive: true, mode: 0o700 });
  const transactionProxy = createHelperTrustedTransactionProxy({
    helperPath: config.helperPath,
    profile: config.profile,
    protocol: "self-serve-drain",
  });
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: config.helperPath,
    profile: config.profile,
    protocol: "self-serve-drain",
    createProxy: () => transactionProxy,
    allowedRoomId: config.allowedRoomId,
  });
  const durableStore = createDurableConversationStore({
    root: config.stateRoot,
    enabled: true,
  });
  const runtime = createHeadlessCodexRuntime({
    profileConfig: {
      profileId: config.profile,
      profileInstanceId: config.profileInstanceId,
      executionKind: "headless-app-server",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "headless",
      deliveryMode: "event-driven",
      shadowTestProfile: false,
      workingDirectory: config.workingDirectory,
      codexPool: { preferredSize: 1, maxSize: 1 },
    },
    transactionProxy,
    codexHome: config.codexHome,
    command: config.command,
    args: ["app-server"],
    env: config.env,
    durableStore,
    profileInstanceId: config.profileInstanceId,
    ownerInstanceId: `headless-drain-${process.pid}`,
    logger,
  });
  if (!runtime.active) {
    throw Object.assign(new Error("headless runtime activation rejected"), {
      code: "headless_runtime_inactive",
      reason: runtime.reason,
    });
  }
  return createHeadlessCodexDrain({
    runtime,
    resolveDelivery,
    profileInstanceId: config.profileInstanceId,
    pollIntervalMs: config.pollIntervalMs,
    onDeliveryFailure: async (error) => {
      const reason = String(error?.code ?? "headless_delivery_failed")
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .slice(0, 64);
      await transactionProxy.recordFailure({
        reason: /^[a-z]/.test(reason) ? reason : `headless_${reason}`,
      });
    },
    logger,
  });
}

export function isDirectExecution(metaUrl, argv1 = process.argv[1]) {
  return typeof argv1 === "string" && path.resolve(argv1) === fileURLToPath(metaUrl);
}
