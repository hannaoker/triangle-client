import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createHelperDurableDeliveryResolver,
  createHelperTrustedTransactionProxy,
} from "../helper-transaction-proxy.mjs";
import { orderedClaimerLockPaths, peerClaimerLockPath } from "../claimer-cross-runtime.mjs";
import { createDurableConversationStore } from "./durable-conversation-store.mjs";
import { createHeadlessCodexDrain } from "./headless-drain.mjs";
import { createHeadlessCodexRuntime } from "./headless-runtime.mjs";
import { runSharedHomeConcurrencyProbe } from "./shared-home-concurrency-probe.mjs";

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INSTANCE = /^[a-f0-9]{64}$/;
const ROOM = /^room_[a-f0-9]{32}$/;

/** Historic Mini canary identifiers. Not a product allowlist or global room pin. */
export const MINI_HEADLESS_CANARY_PROFILE = "codex-headless";
export const MINI_HEADLESS_CANARY_ROOM_ID = "room_8594d12312e14afbb291fcff60a22048";
/** @deprecated Use MINI_HEADLESS_CANARY_PROFILE. Kept for existing test fixtures. */
export const PINNED_HEADLESS_DRAIN_PROFILE = MINI_HEADLESS_CANARY_PROFILE;
/** @deprecated Use MINI_HEADLESS_CANARY_ROOM_ID. Not a required drain pin. */
export const PINNED_HEADLESS_DRAIN_ROOM_ID = MINI_HEADLESS_CANARY_ROOM_ID;
export const CLIENT_SUPERVISOR_CLAIMER_OWNER = "dev.thetriangle.client";
export const DEDICATED_HEADLESS_DRAIN_CLAIMER_OWNER = "dev.thetriangle.codex-headless-drain";

export const HEADLESS_WAKE_REQUIRED_KEYS = Object.freeze([
  "profile",
  "profileInstanceId",
  "helperPath",
  "workingDirectory",
  "codexHome",
  "stateRoot",
  "command",
  "pollIntervalMs",
]);
export const HEADLESS_WAKE_OPTIONAL_KEYS = Object.freeze([]);
export const HEADLESS_WAKE_KEYS = Object.freeze([
  ...HEADLESS_WAKE_REQUIRED_KEYS,
  ...HEADLESS_WAKE_OPTIONAL_KEYS,
]);

function codedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

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

export function isGrokBotRuntimeAdapter(runtimeAdapter) {
  return runtimeAdapter === "grok-bot";
}

/**
 * Product Codex headless drain identity. Any Codex profile may drain.
 * `allowedRoomId` is an optional claim filter, never a global pin (including
 * classic `room_77`). Conversations are keyed by each delivery's `roomId`.
 * grok-bot adapters are rejected — they stay on grokBotWake.
 */
export function assertHeadlessDrainIdentity({
  profile,
  allowedRoomId = null,
  runtimeAdapter = "codex-app-server",
} = {}) {
  if (typeof profile !== "string" || !PROFILE.test(profile)) {
    throw new TypeError("profile is invalid");
  }
  if (isGrokBotRuntimeAdapter(runtimeAdapter) || runtimeAdapter === "grok-bot") {
    throw codedError(
      "grok_bot_not_in_codex_pool",
      "grok-bot profiles cannot join the Codex headless pool",
      { profile },
    );
  }
  if (allowedRoomId != null) {
    if (typeof allowedRoomId !== "string" || !ROOM.test(allowedRoomId)) {
      throw new TypeError("allowedRoomId is invalid");
    }
  }
}

/** @deprecated Mini pin is no longer a product default. Validates identity only. */
export function assertPinnedHeadlessDrainAllowlist(args = {}) {
  assertHeadlessDrainIdentity(args);
}

export function dedicatedHeadlessDrainLaunchAgentLabel(profile) {
  if (typeof profile !== "string" || !PROFILE.test(profile)) {
    throw new TypeError("profile is invalid");
  }
  return `dev.thetriangle.codex-headless-drain.${profile}`;
}

export function defaultHeadlessClaimerLockPath(env = process.env, profile = null, helperPath = null) {
  let directory;
  if (typeof helperPath === "string" && helperPath.startsWith("/") && !helperPath.includes("\0")) {
    directory = path.resolve(path.dirname(helperPath), "..", "client");
  } else {
    const home = requiredAbsolute(env?.HOME, "HOME");
    directory = path.join(
      home,
      "Library",
      "Application Support",
      "The Triangle",
      "client",
    );
  }
  if (typeof profile === "string" && PROFILE.test(profile)) {
    return path.join(directory, `headless-claimer.${profile}.json`);
  }
  return path.join(directory, "headless-claimer.json");
}

function legacyHeadlessClaimerLockPath(lockPath) {
  return path.join(path.dirname(lockPath), "headless-claimer.json");
}

export function probeDedicatedHeadlessDrainLoaded(
  profile,
  { spawn = spawnSync, uid = process.getuid?.() } = {},
) {
  const label = dedicatedHeadlessDrainLaunchAgentLabel(profile);
  if (!Number.isSafeInteger(uid) || uid < 0) return false;
  try {
    const result = spawn("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Fail-closed LaunchAgent probe for the sibling Cursor ACP drain lane. */
export function probeDedicatedCursorAcpDrainLoaded(
  profile,
  { spawn = spawnSync, uid = process.getuid?.() } = {},
) {
  if (typeof profile !== "string" || !PROFILE.test(profile)) return false;
  if (!Number.isSafeInteger(uid) || uid < 0) return false;
  const label = `dev.thetriangle.cursor-acp-drain.${profile}`;
  try {
    const result = spawn("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readClaimerLock(lockPath) {
  if (typeof lockPath !== "string" || !path.isAbsolute(lockPath) || lockPath.includes("\0")) {
    return null;
  }
  if (!existsSync(lockPath)) return null;
  try {
    const raw = readFileSync(lockPath, { encoding: "utf8" });
    const value = JSON.parse(raw);
    if (
      value?.version !== 1
      || typeof value.profile !== "string"
      || typeof value.owner !== "string"
      || !Number.isSafeInteger(value.pid)
    ) {
      return null;
    }
    return Object.freeze({
      version: 1,
      profile: value.profile,
      owner: value.owner,
      pid: value.pid,
    });
  } catch {
    return null;
  }
}

function writeClaimerLockExclusive(lockPath, document) {
  const directory = path.dirname(lockPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const descriptor = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(document)}\n`, { encoding: "utf8" });
  } finally {
    closeSync(descriptor);
  }
}

export function createHeadlessClaimerGuard({
  profile,
  allowedRoomId = null,
  runtimeAdapter = "codex-app-server",
  helperPath = null,
  env = process.env,
  pid = process.pid,
  lockPath = defaultHeadlessClaimerLockPath(env, profile, helperPath),
  probeDedicatedDrain = probeDedicatedHeadlessDrainLoaded,
  probeCursorAcpDrain = probeDedicatedCursorAcpDrainLoaded,
  pidAlive = isPidAlive,
  createLockExclusive = ({ lockPath: target, document, create }) => create(target, document),
} = {}) {
  assertHeadlessDrainIdentity({ profile, allowedRoomId, runtimeAdapter });
  const cursorAcpLockPath = peerClaimerLockPath(lockPath, profile, "cursor-acp");
  const orderedLockPaths = orderedClaimerLockPaths({
    lockPath,
    profile,
    primaryFamily: "codex",
  });

  function liveLockAt(targetPath) {
    const primary = readClaimerLock(targetPath);
    if (primary?.profile === profile && pidAlive(primary.pid)) return primary;
    if (targetPath !== lockPath) return null;
    const legacyPath = legacyHeadlessClaimerLockPath(lockPath);
    const legacy = legacyPath === lockPath ? null : readClaimerLock(legacyPath);
    if (legacy?.profile === profile && pidAlive(legacy.pid)) return legacy;
    return null;
  }

  function liveLock() {
    return liveLockAt(lockPath);
  }

  function classifyForeignLock(existing) {
    if (existing?.owner === CLIENT_SUPERVISOR_CLAIMER_OWNER) {
      return "supervisor_headless_claimer_active";
    }
    if (existing?.owner === DEDICATED_HEADLESS_DRAIN_CLAIMER_OWNER) {
      return "dedicated_headless_drain_loaded";
    }
    return "cursor_acp_claimer_blocks_codex";
  }

  return Object.freeze({
    lockPath,
    cursorAcpLockPath,
    inspect() {
      const dedicatedDrainLoaded = probeDedicatedDrain(profile) === true;
      const cursorAcpDrainLoaded = typeof probeCursorAcpDrain === "function"
        ? probeCursorAcpDrain(profile) === true
        : false;
      const lock = liveLock();
      const cursorAcpLock = liveLockAt(cursorAcpLockPath);
      return Object.freeze({
        dedicatedDrainLoaded,
        cursorAcpDrainLoaded,
        cursorAcpClaimerLockActive: cursorAcpLock != null && cursorAcpLock.pid !== pid,
        supervisorLockActive: lock?.owner === CLIENT_SUPERVISOR_CLAIMER_OWNER,
        dedicatedDrainLockActive: lock?.owner === DEDICATED_HEADLESS_DRAIN_CLAIMER_OWNER,
        lock,
        cursorAcpLock,
      });
    },
    assertSupervisorMayClaim() {
      const state = this.inspect();
      if (state.cursorAcpDrainLoaded) {
        throw codedError(
          "cursor_acp_drain_blocks_codex",
          "Cursor ACP drain LaunchAgent is loaded for this profile; refusing Codex claim",
          { profile },
        );
      }
      if (state.cursorAcpClaimerLockActive) {
        throw codedError(
          "cursor_acp_claimer_blocks_codex",
          "Cursor ACP claimer lock is active for this profile; refusing Codex claim",
          { profile, cursorAcpLockPath },
        );
      }
      if (state.dedicatedDrainLoaded) {
        throw codedError(
          "dedicated_headless_drain_loaded",
          "dedicated headless drain LaunchAgent is still loaded; refusing dual claimers",
          { label: dedicatedHeadlessDrainLaunchAgentLabel(profile) },
        );
      }
      if (state.supervisorLockActive && state.lock.pid !== pid) {
        throw codedError(
          "supervisor_headless_claimer_active",
          "another client supervisor already owns the headless claimer lock",
        );
      }
      if (state.dedicatedDrainLockActive) {
        throw codedError(
          "dedicated_headless_drain_loaded",
          "dedicated headless drain still holds the claimer lock; refusing dual claimers",
        );
      }
    },
    assertDedicatedDrainMayClaim() {
      const state = this.inspect();
      if (state.supervisorLockActive) {
        throw codedError(
          "supervisor_headless_claimer_active",
          "client supervisor already owns headless mailbox admission; refusing dual claimers",
        );
      }
      if (state.cursorAcpDrainLoaded || state.cursorAcpClaimerLockActive) {
        throw codedError(
          "cursor_acp_claimer_blocks_codex",
          "Cursor ACP already owns mailbox admission for this profile; refusing dual claimers",
          { profile },
        );
      }
    },
    acquire({ owner } = {}) {
      if (owner !== CLIENT_SUPERVISOR_CLAIMER_OWNER && owner !== DEDICATED_HEADLESS_DRAIN_CLAIMER_OWNER) {
        throw new TypeError("claimer owner is invalid");
      }
      if (owner === CLIENT_SUPERVISOR_CLAIMER_OWNER) this.assertSupervisorMayClaim();
      else this.assertDedicatedDrainMayClaim();
      const document = {
        version: 1,
        profile,
        owner,
        pid,
      };
      const created = [];
      try {
        for (const target of orderedLockPaths) {
          try {
            createLockExclusive({ lockPath: target, document, create: writeClaimerLockExclusive });
            created.push(target);
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            const existing = readClaimerLock(target);
            if (existing && pidAlive(existing.pid)) {
              throw codedError(
                classifyForeignLock(existing),
                "another process already owns a cross-runtime claimer lock for this profile",
                { lockPath: target, profile },
              );
            }
            // Fail closed for stale or malformed files. Acquisition never removes
            // an existing path; operator cleanup is explicit and auditable.
            throw codedError(
              "headless_claimer_lock_stale",
              "an existing stale headless claimer lock requires operator cleanup",
              { lockPath: target },
            );
          }
        }
      } catch (error) {
        for (const target of [...created].reverse()) {
          try {
            unlinkSync(target);
          } catch {
            // Best-effort rollback of partial dual-lock acquire.
          }
        }
        throw error;
      }
    },
    release({ owner } = {}) {
      let released = false;
      for (const target of [...orderedLockPaths].reverse()) {
        const lock = readClaimerLock(target);
        if (lock == null) continue;
        if (lock.profile !== profile || lock.owner !== owner || lock.pid !== pid) continue;
        try {
          unlinkSync(target);
          released = true;
        } catch {
          // Keep trying remaining locks.
        }
      }
      return released;
    },
  });
}

export function hasHeadlessWakeKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  const optional = new Set(HEADLESS_WAKE_OPTIONAL_KEYS);
  const required = new Set(HEADLESS_WAKE_REQUIRED_KEYS);
  if (!HEADLESS_WAKE_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  return actual.every((key) => required.has(key) || optional.has(key));
}

export function normalizeHeadlessWakeConfig(headlessWake) {
  if (!hasHeadlessWakeKeys(headlessWake)) {
    throw new TypeError("headlessWake schema is invalid");
  }
  if (typeof headlessWake.profile !== "string" || !PROFILE.test(headlessWake.profile)) {
    throw new TypeError("headlessWake.profile is invalid");
  }
  if (typeof headlessWake.profileInstanceId !== "string" || !INSTANCE.test(headlessWake.profileInstanceId)) {
    throw new TypeError("headlessWake.profileInstanceId is invalid");
  }
  if (headlessWake.profileInstanceId !== deriveProfileInstanceId(headlessWake.profile)) {
    throw new TypeError("headlessWake.profileInstanceId does not match profile");
  }
  if (Object.hasOwn(headlessWake, "allowedRoomId")) throw new TypeError("headlessWake.allowedRoomId is not supported");
  assertHeadlessDrainIdentity({
    profile: headlessWake.profile,
    allowedRoomId: null,
  });
  if (!Number.isSafeInteger(headlessWake.pollIntervalMs)
    || headlessWake.pollIntervalMs < 100
    || headlessWake.pollIntervalMs > 60_000) {
    throw new TypeError("headlessWake.pollIntervalMs is invalid");
  }
  return Object.freeze({
    profile: headlessWake.profile,
    profileInstanceId: headlessWake.profileInstanceId,
    helperPath: requiredAbsolute(headlessWake.helperPath, "headlessWake.helperPath"),
    workingDirectory: requiredAbsolute(headlessWake.workingDirectory, "headlessWake.workingDirectory"),
    codexHome: requiredAbsolute(headlessWake.codexHome, "headlessWake.codexHome"),
    stateRoot: path.resolve(requiredAbsolute(headlessWake.stateRoot, "headlessWake.stateRoot")),
    command: requiredAbsolute(headlessWake.command, "headlessWake.command"),
    pollIntervalMs: headlessWake.pollIntervalMs,
  });
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
  const rawRoom = env.TRIANGLE_HEADLESS_ROOM_ID;
  const allowedRoomId =
    rawRoom == null || rawRoom === ""
      ? null
      : rawRoom;
  if (allowedRoomId != null && (typeof allowedRoomId !== "string" || !ROOM.test(allowedRoomId))) {
    throw new TypeError("TRIANGLE_HEADLESS_ROOM_ID is invalid");
  }
  const pollIntervalMs = Number(env.TRIANGLE_HEADLESS_POLL_INTERVAL_MS ?? 1_000);
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
    throw new TypeError("TRIANGLE_HEADLESS_POLL_INTERVAL_MS is invalid");
  }
  assertHeadlessDrainIdentity({ profile, allowedRoomId });
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

/**
 * Env the Mini supervisor actually applies. Launchd plist exports are ignored
 * unless this reads process.env: headless wake config has no env field.
 * This cutover caps the production pool at 2 (3 and 4 clamp to 2).
 */
export function supervisorRuntimeEnv(source = process.env) {
  const env = {
    HOME: source?.HOME,
    PATH: source?.PATH,
    LANG: source?.LANG,
    LC_ALL: source?.LC_ALL,
    TMPDIR: source?.TMPDIR,
    USER: source?.USER,
    LOGNAME: source?.LOGNAME,
  };
  if (source?.TRIANGLE_CODEX_POOL_ENABLE === "1") {
    env.TRIANGLE_CODEX_POOL_ENABLE = "1";
    const raw = source.TRIANGLE_CODEX_POOL_SIZE;
    if (raw == null || String(raw).trim() === "" || raw === "3" || raw === "4") {
      env.TRIANGLE_CODEX_POOL_SIZE = "2";
    } else {
      env.TRIANGLE_CODEX_POOL_SIZE = String(raw);
    }
  }
  if (source?.TRIANGLE_DESKTOP_HANDOFF_ENABLE === "1") {
    env.TRIANGLE_DESKTOP_HANDOFF_ENABLE = "1";
  }
  for (const key of Object.keys(env)) {
    if (env[key] == null) delete env[key];
  }
  return Object.freeze(env);
}

export const PRODUCTION_CUTOVER_POOL = Object.freeze({ preferredSize: 2, maxSize: 2 });

/** Mini wake records omit env. Fall back to the supervisor process environment. */
export function runtimeEnvForHeadlessWake(config = {}, processEnvironment = process.env) {
  return supervisorRuntimeEnv(config?.env ?? processEnvironment);
}

export function createInstalledHeadlessDrain(config, {
  logger = console,
  ownerInstanceId = `headless-drain-${process.pid}`,
  runLiveSharedHomeProbe = runSharedHomeConcurrencyProbe,
} = {}) {
  const normalized = config.profileInstanceId
    ? {
      ...config,
      helperPath: requiredAbsolute(config.helperPath, "helperPath"),
      workingDirectory: requiredAbsolute(config.workingDirectory, "workingDirectory"),
      codexHome: requiredAbsolute(config.codexHome, "codexHome"),
      stateRoot: requiredAbsolute(config.stateRoot, "stateRoot"),
      command: requiredAbsolute(config.command, "command"),
      allowedRoomId: config.allowedRoomId ?? null,
    }
    : config;
  assertHeadlessDrainIdentity({
    profile: normalized.profile,
    allowedRoomId: normalized.allowedRoomId ?? null,
  });
  mkdirSync(normalized.stateRoot, { recursive: true, mode: 0o700 });
  const transactionProxy = createHelperTrustedTransactionProxy({
    helperPath: normalized.helperPath,
    profile: normalized.profile,
    protocol: "self-serve-drain",
  });
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: normalized.helperPath,
    profile: normalized.profile,
    protocol: "self-serve-drain",
    createProxy: () => transactionProxy,
    allowedRoomId: normalized.allowedRoomId ?? null,
  });
  const durableStore = createDurableConversationStore({
    root: normalized.stateRoot,
    enabled: true,
  });
  // Mini headless wake config has no env field. Read the supervisor process
  // environment (launchd) instead of pretending a missing field is empty.
  // ENABLE still cannot raise the pool without a live shared-home probe in
  // this process. A failed probe stays at pool 1 and does not construct handoff.
  const runtimeEnv = runtimeEnvForHeadlessWake(normalized, process.env);
  const runtime = createHeadlessCodexRuntime({
    profileConfig: {
      profileId: normalized.profile,
      profileInstanceId: normalized.profileInstanceId,
      executionKind: "headless-app-server",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "headless",
      deliveryMode: "headless-app-server",
      conversationKey: "roomId",
      maxInFlightPerProfile: 1,
      shadowTestProfile: false,
      workingDirectory: normalized.workingDirectory,
      codexPool: PRODUCTION_CUTOVER_POOL,
    },
    transactionProxy,
    codexHome: normalized.codexHome,
    command: normalized.command,
    args: ["app-server"],
    env: runtimeEnv,
    enablePhase5Migration: true,
    durableStore,
    profileInstanceId: normalized.profileInstanceId,
    ownerInstanceId,
    logger,
    runLiveSharedHomeProbe: runtimeEnv.TRIANGLE_CODEX_POOL_ENABLE === "1"
      ? runLiveSharedHomeProbe
      : null,
    statusFile: path.join(normalized.stateRoot, "production-pool-handoff.json"),
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
    profileInstanceId: normalized.profileInstanceId,
    pollIntervalMs: normalized.pollIntervalMs,
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
