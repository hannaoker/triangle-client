/**
 * Supervisor-owned Cursor ACP drain install + dual-claimer guards.
 *
 * Cursor ACP and Codex headless each keep a lock family, but both families are
 * acquired together (Codex lock first, then Cursor ACP) so the same profile
 * mailbox cannot be dual-claimed across runtimes. Shadow profiles only.
 */

import crypto from "node:crypto";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { orderedClaimerLockPaths, peerClaimerLockPath } from "../claimer-cross-runtime.mjs";
import {
  createHelperDurableDeliveryResolver,
  createHelperTrustedTransactionProxy,
} from "../helper-transaction-proxy.mjs";
import {
  createDefaultCursorAcpShadowProfile,
  CURSOR_ACP_DELIVERY_MODE,
  CURSOR_ACP_RUNTIME_ADAPTER,
} from "./config-guards.mjs";
import { createHeadlessCursorAcpDrain } from "./headless-drain.mjs";
import { createHeadlessCursorAcpRuntime } from "./headless-runtime.mjs";
import { resolveTriangleCursorHome } from "./runtime-home.mjs";

const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const INSTANCE = /^[a-f0-9]{64}$/;

export const CLIENT_SUPERVISOR_CLAIMER_OWNER = "dev.thetriangle.client";
export const DEDICATED_CURSOR_ACP_DRAIN_CLAIMER_OWNER = "dev.thetriangle.cursor-acp-drain";

export const CURSOR_ACP_WAKE_REQUIRED_KEYS = Object.freeze([
  "profile",
  "profileInstanceId",
  "helperPath",
  "workingDirectory",
  "cursorHome",
  "stateRoot",
  "command",
  "pollIntervalMs",
  "shadowTestProfile",
]);
export const CURSOR_ACP_WAKE_OPTIONAL_KEYS = Object.freeze([]);
export const CURSOR_ACP_WAKE_KEYS = Object.freeze([
  ...CURSOR_ACP_WAKE_REQUIRED_KEYS,
  ...CURSOR_ACP_WAKE_OPTIONAL_KEYS,
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

export function assertCursorAcpDrainIdentity({
  profile,
  runtimeAdapter = CURSOR_ACP_RUNTIME_ADAPTER,
  shadowTestProfile = true,
} = {}) {
  if (typeof profile !== "string" || !PROFILE.test(profile)) {
    throw new TypeError("profile is invalid");
  }
  if (runtimeAdapter === "grok-bot" || runtimeAdapter === "codex" || runtimeAdapter === "codex-app-server") {
    throw codedError(
      "cursor_acp_pool_excluded",
      "Codex and grok-bot profiles cannot join the Cursor ACP drain lane",
      { profile, runtimeAdapter },
    );
  }
  if (runtimeAdapter !== CURSOR_ACP_RUNTIME_ADAPTER) {
    throw codedError(
      "cursor_acp_adapter_mismatch",
      "Cursor ACP drain requires runtimeAdapter cursor-acp",
      { profile, runtimeAdapter },
    );
  }
  if (shadowTestProfile !== true) {
    throw codedError(
      "cursor_acp_not_shadow_test_profile",
      "Cursor ACP drain admits shadow test profiles only",
      { profile },
    );
  }
}

export function dedicatedCursorAcpDrainLaunchAgentLabel(profile) {
  assertCursorAcpDrainIdentity({ profile });
  return `${DEDICATED_CURSOR_ACP_DRAIN_CLAIMER_OWNER}.${profile}`;
}

export function defaultCursorAcpClaimerLockPath(env = process.env, profile, helperPath = null) {
  assertCursorAcpDrainIdentity({ profile });
  const home = typeof env.HOME === "string" && env.HOME.startsWith("/")
    ? env.HOME
    : null;
  if (home == null) throw new TypeError("HOME must be absolute for Cursor ACP claimer lock");
  return path.join(
    home,
    "Library",
    "Application Support",
    "The Triangle",
    "client",
    `cursor-acp-claimer.${profile}.json`,
  );
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readClaimerLock(lockPath) {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      raw?.version !== 1
      || typeof raw.profile !== "string"
      || typeof raw.owner !== "string"
      || !Number.isSafeInteger(raw.pid)
    ) {
      return null;
    }
    return raw;
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

export function probeDedicatedCursorAcpDrainLoaded(profile, {
  spawnSync = defaultSpawnSync,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (typeof profile !== "string" || !PROFILE.test(profile)) return false;
  if (uid == null || !Number.isSafeInteger(uid)) return false;
  const label = dedicatedCursorAcpDrainLaunchAgentLabel(profile);
  const result = spawnSync("launchctl", ["print", `gui/${uid}/${label}`], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return result?.status === 0;
}

/** Fail-closed LaunchAgent probe for the sibling Codex headless drain lane. */
export function probeDedicatedCodexHeadlessDrainLoaded(profile, {
  spawnSync = defaultSpawnSync,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (typeof profile !== "string" || !PROFILE.test(profile)) return false;
  if (uid == null || !Number.isSafeInteger(uid)) return false;
  const label = `dev.thetriangle.codex-headless-drain.${profile}`;
  const result = spawnSync("launchctl", ["print", `gui/${uid}/${label}`], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return result?.status === 0;
}

export function createCursorAcpClaimerGuard({
  profile,
  runtimeAdapter = CURSOR_ACP_RUNTIME_ADAPTER,
  shadowTestProfile = true,
  helperPath = null,
  env = process.env,
  pid = process.pid,
  lockPath = defaultCursorAcpClaimerLockPath(env, profile, helperPath),
  probeDedicatedDrain = probeDedicatedCursorAcpDrainLoaded,
  probeCodexDrain = probeDedicatedCodexHeadlessDrainLoaded,
  pidAlive = isPidAlive,
  createLockExclusive = ({ lockPath: target, document, create }) => create(target, document),
} = {}) {
  assertCursorAcpDrainIdentity({ profile, runtimeAdapter, shadowTestProfile });
  const codexLockPath = peerClaimerLockPath(lockPath, profile, "codex");
  const orderedLockPaths = orderedClaimerLockPaths({
    lockPath,
    profile,
    primaryFamily: "cursor-acp",
  });

  function liveLockAt(targetPath) {
    const lock = readClaimerLock(targetPath);
    if (lock == null || lock.profile !== profile) return null;
    if (!pidAlive(lock.pid)) return null;
    return lock;
  }

  function liveLock() {
    return liveLockAt(lockPath);
  }

  function classifyForeignLock(existing) {
    if (existing?.owner === CLIENT_SUPERVISOR_CLAIMER_OWNER) {
      return "supervisor_cursor_acp_claimer_active";
    }
    if (existing?.owner === DEDICATED_CURSOR_ACP_DRAIN_CLAIMER_OWNER) {
      return "dedicated_cursor_acp_drain_loaded";
    }
    return "codex_claimer_blocks_cursor_acp";
  }

  return Object.freeze({
    lockPath,
    codexLockPath,
    inspect() {
      const dedicatedDrainLoaded = probeDedicatedDrain(profile) === true;
      const codexDrainLoaded = typeof probeCodexDrain === "function"
        ? probeCodexDrain(profile) === true
        : false;
      const lock = liveLock();
      const codexLock = liveLockAt(codexLockPath);
      return Object.freeze({
        dedicatedDrainLoaded,
        codexDrainLoaded,
        codexClaimerLockActive: codexLock != null && codexLock.pid !== pid,
        supervisorLockActive: lock?.owner === CLIENT_SUPERVISOR_CLAIMER_OWNER,
        dedicatedDrainLockActive: lock?.owner === DEDICATED_CURSOR_ACP_DRAIN_CLAIMER_OWNER,
        lock,
        codexLock,
      });
    },
    assertSupervisorMayClaim() {
      const state = this.inspect();
      if (state.codexDrainLoaded) {
        throw codedError(
          "codex_drain_blocks_cursor_acp",
          "Codex headless drain LaunchAgent is loaded for this profile; refusing Cursor ACP claim",
          { profile },
        );
      }
      if (state.codexClaimerLockActive) {
        throw codedError(
          "codex_claimer_blocks_cursor_acp",
          "Codex headless claimer lock is active for this profile; refusing Cursor ACP claim",
          { profile, codexLockPath },
        );
      }
      if (state.dedicatedDrainLoaded) {
        throw codedError(
          "dedicated_cursor_acp_drain_loaded",
          "dedicated Cursor ACP drain LaunchAgent is still loaded; refusing dual claimers",
          { label: dedicatedCursorAcpDrainLaunchAgentLabel(profile) },
        );
      }
      if (state.supervisorLockActive && state.lock.pid !== pid) {
        throw codedError(
          "supervisor_cursor_acp_claimer_active",
          "another client supervisor already owns the Cursor ACP claimer lock",
        );
      }
      if (state.dedicatedDrainLockActive) {
        throw codedError(
          "dedicated_cursor_acp_drain_loaded",
          "dedicated Cursor ACP drain still holds the claimer lock; refusing dual claimers",
        );
      }
    },
    acquire({ owner } = {}) {
      if (owner !== CLIENT_SUPERVISOR_CLAIMER_OWNER && owner !== DEDICATED_CURSOR_ACP_DRAIN_CLAIMER_OWNER) {
        throw new TypeError("claimer owner is invalid");
      }
      if (owner === CLIENT_SUPERVISOR_CLAIMER_OWNER) this.assertSupervisorMayClaim();
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
            throw codedError(
              "cursor_acp_claimer_lock_stale",
              "an existing stale Cursor ACP claimer lock requires operator cleanup",
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

export function hasCursorAcpWakeKeys(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const optional = new Set(CURSOR_ACP_WAKE_OPTIONAL_KEYS);
  const required = new Set(CURSOR_ACP_WAKE_REQUIRED_KEYS);
  if (!CURSOR_ACP_WAKE_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  return Object.keys(value).every((key) => required.has(key) || optional.has(key));
}

export function normalizeCursorAcpWakeConfig(cursorAcpWake) {
  if (!hasCursorAcpWakeKeys(cursorAcpWake)) {
    throw new TypeError("cursorAcpWake schema is invalid");
  }
  const profile = cursorAcpWake.profile;
  const profileInstanceId = cursorAcpWake.profileInstanceId;
  if (typeof profile !== "string" || !PROFILE.test(profile)) {
    throw new TypeError("profile is invalid");
  }
  if (typeof profileInstanceId !== "string" || !INSTANCE.test(profileInstanceId)) {
    throw new TypeError("profileInstanceId is invalid");
  }
  if (deriveProfileInstanceId(profile) !== profileInstanceId) {
    throw new TypeError("profileInstanceId does not match profile");
  }
  if (cursorAcpWake.shadowTestProfile !== true) {
    throw new TypeError("shadowTestProfile must be true");
  }
  const pollIntervalMs = cursorAcpWake.pollIntervalMs;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
    throw new TypeError("pollIntervalMs must be between 100 and 60000");
  }
  return Object.freeze({
    profile,
    profileInstanceId,
    helperPath: requiredAbsolute(cursorAcpWake.helperPath, "helperPath"),
    workingDirectory: requiredAbsolute(cursorAcpWake.workingDirectory, "workingDirectory"),
    cursorHome: requiredAbsolute(cursorAcpWake.cursorHome, "cursorHome"),
    stateRoot: path.resolve(requiredAbsolute(cursorAcpWake.stateRoot, "stateRoot")),
    command: requiredAbsolute(cursorAcpWake.command, "command"),
    pollIntervalMs,
    shadowTestProfile: true,
  });
}

export function createInstalledCursorAcpDrain(config, {
  logger = console,
  ownerInstanceId = `cursor-acp-drain-${process.pid}`,
  env = process.env,
} = {}) {
  const normalized = normalizeCursorAcpWakeConfig(config);
  assertCursorAcpDrainIdentity({
    profile: normalized.profile,
    shadowTestProfile: normalized.shadowTestProfile,
  });
  mkdirSync(normalized.stateRoot, { recursive: true, mode: 0o700 });
  const cursorHome = resolveTriangleCursorHome({
    override: normalized.cursorHome,
    home: env.HOME,
    allowCreate: true,
  });
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
  });
  const profileConfig = createDefaultCursorAcpShadowProfile({
    profileId: normalized.profile,
    workingDirectory: normalized.workingDirectory,
  });
  const runtime = createHeadlessCursorAcpRuntime({
    profileConfig,
    transactionProxy,
    cursorHome,
    command: normalized.command,
    args: ["acp"],
    env: {
      ...env,
      TRIANGLE_CURSOR_HOME: cursorHome,
      TRIANGLE_CURSOR_ACP_SHADOW_ENABLE: "1",
    },
    enableShadow: true,
    logger,
  });
  if (!runtime.active) {
    throw Object.assign(new Error("Cursor ACP runtime activation rejected"), {
      code: "cursor_acp_runtime_inactive",
      reason: runtime.reason,
      ownerInstanceId,
    });
  }
  return createHeadlessCursorAcpDrain({
    runtime,
    resolveDelivery,
    profileInstanceId: normalized.profileInstanceId,
    pollIntervalMs: normalized.pollIntervalMs,
    onDeliveryFailure: async (error) => {
      const reason = String(error?.code ?? "cursor_acp_delivery_failed")
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .slice(0, 64);
      await transactionProxy.recordFailure({
        reason: /^[a-z]/.test(reason) ? reason : `cursor_acp_${reason}`,
      });
    },
    logger,
  });
}

export function isDirectExecution(metaUrl, argv1 = process.argv[1]) {
  return typeof argv1 === "string" && path.resolve(argv1) === fileURLToPath(metaUrl);
}

export { CURSOR_ACP_DELIVERY_MODE, CURSOR_ACP_RUNTIME_ADAPTER };
