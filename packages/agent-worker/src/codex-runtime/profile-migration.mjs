/**
 * Phase 5 — explicit one-profile migrate-to-headless / rollback-to-desktop.
 *
 * Fail-closed, transactional, no dual mailbox consumers. Existing
 * mcp-interactive / Shared App Server bindings are never rewritten by
 * installation alone; migrate snapshots the prior config + binding and only
 * proceeds when Phase 5 enablement is on and the profile is idle.
 *
 * Does **not** flip global featureFlags.headlessRuntime.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import { NON_IDLE_EXECUTION_STATES } from "./execution-state.mjs";
import {
  CODEX_EXECUTION_KIND,
  CODEX_PROFILE_SCHEMA_VERSION,
  annotateCodexProfileSchema,
  classifyCodexProfileExecution,
  isDesktopAppServerExecution,
  isHeadlessAppServerExecution,
} from "./profile-schema.mjs";

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
}

function readJsonIfPresent(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * In-memory profile config store for tests and Node-side migration.
 * Production wiring may replace this with the helper ClientInstance store.
 */
export function createMemoryProfileConfigStore(initial = new Map()) {
  const map = new Map(initial);
  return Object.freeze({
    async read(profileId) {
      const value = map.get(profileId);
      return value == null ? null : Object.freeze({ ...value });
    },
    async write(profileId, config) {
      map.set(profileId, Object.freeze({ ...config, profileId }));
      return map.get(profileId);
    },
  });
}

/**
 * @param {object} options
 * @param {object} options.profileConfigStore `{ read(profileId), write(profileId, config) }`
 * @param {string} options.profileId
 * @param {string} [options.profileInstanceId]
 * @param {ReturnType<import('./durable-conversation-store.mjs').createDurableConversationStore> | null} [options.store]
 * @param {ReturnType<import('./execution-lease.mjs').createExecutionLeaseManager> | null} [options.leaseManager]
 * @param {{ read?: Function, write?: Function } | null} [options.bindingStore]
 * @param {{
 *   pauseDesktop?: Function,
 *   stopDesktop?: Function,
 *   isDesktopActive?: Function,
 *   startDesktop?: Function,
 *   pauseHeadless?: Function,
 *   stopHeadless?: Function,
 *   isHeadlessActive?: Function,
 *   startHeadless?: Function,
 * }} [options.mailboxConsumers]
 * @param {() => Promise<{ ok: boolean, reason?: string }> | { ok: boolean, reason?: string }} [options.proveHeadlessReady]
 * @param {() => Promise<{ ok: boolean, reason?: string }> | { ok: boolean, reason?: string }} [options.proveDesktopReady]
 * @param {boolean} [options.enabled]
 * @param {string} [options.snapshotRoot] Directory for durable migration snapshots
 * @param {() => number} [options.now]
 */
export function createProfileMigrationController({
  profileConfigStore,
  profileId,
  profileInstanceId = null,
  store = null,
  leaseManager = null,
  bindingStore = null,
  mailboxConsumers = null,
  proveHeadlessReady = null,
  proveDesktopReady = null,
  enabled = true,
  snapshotRoot = null,
  now = () => Date.now(),
} = {}) {
  if (profileConfigStore == null || typeof profileConfigStore.read !== "function") {
    throw new TypeError("profileConfigStore.read is required");
  }
  if (typeof profileConfigStore.write !== "function") {
    throw new TypeError("profileConfigStore.write is required");
  }
  if (typeof profileId !== "string" || profileId.length === 0) {
    throw new TypeError("profileId is required");
  }

  const consumers = mailboxConsumers ?? {};
  const snapshotPath =
    typeof snapshotRoot === "string" && snapshotRoot.length > 0
      ? path.join(snapshotRoot, "phase5-migration-snapshot.json")
      : null;

  function assertEnabled() {
    if (enabled !== true) {
      throw createCodedError(
        "phase5_migration_disabled",
        "migrate-to-headless is disabled; set enablePhase5Migration or omit TRIANGLE_PHASE5_MIGRATION_ENABLE=0",
      );
    }
  }

  function resolveInstanceId(config) {
    return (
      profileInstanceId ??
      config?.profileInstanceId ??
      (typeof config?.instanceId === "string" ? config.instanceId : null)
    );
  }

  function listConversations(instanceId) {
    if (store == null || typeof store.listConversations !== "function" || instanceId == null) {
      return [];
    }
    return store.listConversations(instanceId);
  }

  function assertMigrationIdle(instanceId, { allowFrozen = false } = {}) {
    if (leaseManager != null && typeof leaseManager.status === "function" && instanceId != null) {
      const lease = leaseManager.status({ profileInstanceId: instanceId });
      if (lease?.ownershipState === "transferring") {
        throw createCodedError(
          "migration_transferring",
          "migrate rejected while ownership is transferring",
          { ownershipState: lease.ownershipState },
        );
      }
      if (lease?.admissionFrozen === true && !allowFrozen) {
        throw createCodedError(
          "migration_admission_frozen",
          "migrate rejected while admission is frozen; recover or rollback handoff first",
        );
      }
    }

    if (store != null && instanceId != null) {
      const profile = store.readProfile(instanceId);
      if (profile?.ownership_state === "transferring") {
        throw createCodedError(
          "migration_transferring",
          "migrate rejected while ownership is transferring",
        );
      }
      if (profile?.admission_frozen === true && !allowFrozen) {
        throw createCodedError(
          "migration_admission_frozen",
          "migrate rejected while admission is frozen",
        );
      }
    }

    const rows = listConversations(instanceId);
    const nonIdle = rows.filter((row) => NON_IDLE_EXECUTION_STATES.includes(row.execution_state));
    if (nonIdle.length > 0) {
      throw createCodedError("migration_not_idle", "migrate rejected while conversation non-idle", {
        states: nonIdle.map((row) => row.execution_state),
      });
    }
    const open = rows.filter((row) => row.active_delivery_id != null);
    if (open.length > 0) {
      throw createCodedError("migration_open_delivery", "migrate rejected while delivery is open", {
        openDeliveryCount: open.length,
      });
    }
  }

  async function readBindingSnapshot() {
    if (bindingStore == null || typeof bindingStore.read !== "function") return null;
    const binding = await bindingStore.read();
    return binding == null ? null : { ...binding };
  }

  async function writeBindingSnapshot(binding) {
    if (bindingStore == null || typeof bindingStore.write !== "function") return;
    if (binding == null) return;
    await bindingStore.write(binding);
  }

  function writeDurableSnapshot(snapshot) {
    if (snapshotPath == null) return;
    atomicWriteJson(snapshotPath, snapshot);
  }

  function readDurableSnapshot() {
    if (snapshotPath == null) return null;
    return readJsonIfPresent(snapshotPath);
  }

  function clearDurableSnapshot() {
    if (snapshotPath == null || !existsSync(snapshotPath)) return;
    rmSync(snapshotPath);
  }

  async function ensureSingleConsumer({ active }) {
    const desktopActive =
      typeof consumers.isDesktopActive === "function" ? consumers.isDesktopActive() === true : false;
    const headlessActive =
      typeof consumers.isHeadlessActive === "function" ? consumers.isHeadlessActive() === true : false;
    if (desktopActive && headlessActive) {
      throw createCodedError(
        "migration_dual_mailbox_consumer",
        "refusing to proceed with both desktop and headless mailbox consumers active",
      );
    }
    if (active === "desktop" && headlessActive) {
      throw createCodedError(
        "migration_dual_mailbox_consumer",
        "headless consumer still active while restoring desktop",
      );
    }
    if (active === "headless" && desktopActive) {
      throw createCodedError(
        "migration_dual_mailbox_consumer",
        "desktop consumer still active while activating headless",
      );
    }
  }

  async function pauseDesktopConsumer() {
    if (typeof consumers.pauseDesktop === "function") await consumers.pauseDesktop();
    if (typeof consumers.stopDesktop === "function") await consumers.stopDesktop();
  }

  async function pauseHeadlessConsumer() {
    if (typeof consumers.pauseHeadless === "function") await consumers.pauseHeadless();
    if (typeof consumers.stopHeadless === "function") await consumers.stopHeadless();
  }

  async function startDesktopConsumer() {
    await pauseHeadlessConsumer();
    await ensureSingleConsumer({ active: "none" });
    if (typeof consumers.startDesktop === "function") await consumers.startDesktop();
    await ensureSingleConsumer({ active: "desktop" });
  }

  async function startHeadlessConsumer() {
    await pauseDesktopConsumer();
    await ensureSingleConsumer({ active: "none" });
    if (typeof consumers.startHeadless === "function") await consumers.startHeadless();
    await ensureSingleConsumer({ active: "headless" });
  }

  async function runProve(fn, code) {
    if (typeof fn !== "function") return { ok: true };
    const result = await fn();
    if (result?.ok !== true) {
      throw createCodedError(code, result?.reason ?? "readiness gate failed", {
        reason: result?.reason ?? null,
      });
    }
    return result;
  }

  function buildHeadlessConfig(prior) {
    return annotateCodexProfileSchema({
      ...prior,
      profileId,
      profileInstanceId: resolveInstanceId(prior),
      schemaVersion: CODEX_PROFILE_SCHEMA_VERSION.HEADLESS_APP_SERVER,
      executionKind: CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER,
      runtimeAdapter: "codex-app-server",
      runtimeMode: "headless",
      deliveryMode: "headless-app-server",
      // Keep binding bytes for rollback; do not activate desktop wake.
      appServerBinding:
        prior.appServerBinding == null
          ? null
          : { ...prior.appServerBinding, enabled: false },
      appServerWake: null,
      migratedFrom: CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER,
      phase5MigratedAt: new Date(now()).toISOString(),
    });
  }

  function buildDesktopConfigFromSnapshot(snapshot) {
    const prior = snapshot.priorProfileConfig;
    return annotateCodexProfileSchema({
      ...prior,
      profileId,
      schemaVersion: CODEX_PROFILE_SCHEMA_VERSION.DESKTOP_APP_SERVER,
      executionKind: CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER,
      runtimeAdapter: prior.runtimeAdapter ?? "codex-app-server",
      runtimeMode: "desktop",
      deliveryMode: prior.deliveryMode ?? "mcp-interactive",
      appServerBinding: snapshot.priorBinding,
      appServerWake: snapshot.priorAppServerWake ?? prior.appServerWake ?? null,
      migratedFrom: null,
      phase5MigratedAt: null,
      phase5RolledBackAt: new Date(now()).toISOString(),
    });
  }

  /**
   * Operator: migrate one mcp-interactive / desktop App Server profile to
   * headless App Server. Fail closed; restore prior on any gate failure.
   */
  async function migrateToHeadless() {
    assertEnabled();

    const prior = await profileConfigStore.read(profileId);
    if (prior == null) {
      throw createCodedError("migration_profile_missing", "profile config not found");
    }

    const kind = classifyCodexProfileExecution(prior);
    if (kind === CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER) {
      throw createCodedError(
        "migration_already_headless",
        "profile is already headless App Server; nothing to migrate",
      );
    }
    if (kind === CODEX_EXECUTION_KIND.LEGACY_COMMAND) {
      throw createCodedError(
        "migration_legacy_not_supported",
        "legacy command / event-driven adapters are not migrated by migrate-to-headless; configure headless App Server explicitly",
        { executionKind: kind },
      );
    }
    if (!isDesktopAppServerExecution(prior) && prior.deliveryMode !== "mcp-interactive") {
      throw createCodedError(
        "migration_wrong_kind",
        "migrate-to-headless requires a desktop App Server / mcp-interactive profile",
        { executionKind: kind },
      );
    }

    const instanceId = resolveInstanceId(prior);
    assertMigrationIdle(instanceId);

    const priorBinding = await readBindingSnapshot();
    const snapshot = {
      version: 1,
      profileId,
      profileInstanceId: instanceId,
      direction: "desktop_to_headless",
      createdAt: new Date(now()).toISOString(),
      priorProfileConfig: { ...prior },
      priorBinding,
      priorAppServerWake: prior.appServerWake ?? null,
    };
    writeDurableSnapshot(snapshot);

    // Pause desktop first — never activate headless while desktop still claims.
    await pauseDesktopConsumer();
    await ensureSingleConsumer({ active: "none" });

    // Soft-disable binding file without deleting (rollback path).
    if (priorBinding != null && priorBinding.enabled === true) {
      await writeBindingSnapshot({ ...priorBinding, enabled: false });
    }

    let applied = null;
    try {
      applied = buildHeadlessConfig(prior);
      await profileConfigStore.write(profileId, applied);

      if (store != null && instanceId != null && typeof store.writeProfile === "function") {
        const lease = store.readProfile(instanceId);
        if (lease != null) {
          store.writeProfile({
            ...lease,
            runtime_mode: "headless",
            // Clear desktop attachment markers; keep bound thread for continuity.
            chatgpt_attachment_state: "absent",
          });
        }
      }

      await runProve(proveHeadlessReady, "migration_headless_not_ready");
      await startHeadlessConsumer();
      await ensureSingleConsumer({ active: "headless" });

      return Object.freeze({
        ok: true,
        action: "migrate-to-headless",
        profileId,
        profileInstanceId: instanceId,
        executionKind: CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER,
        schemaVersion: CODEX_PROFILE_SCHEMA_VERSION.HEADLESS_APP_SERVER,
        priorExecutionKind: kind,
        bindingPreserved: priorBinding != null,
        bindingEnabled: false,
      });
    } catch (error) {
      // Restore previous runtime/service config; never leave dual consumers.
      try {
        await pauseHeadlessConsumer();
        await profileConfigStore.write(profileId, snapshot.priorProfileConfig);
        if (snapshot.priorBinding != null) {
          await writeBindingSnapshot(snapshot.priorBinding);
        }
        if (store != null && instanceId != null && typeof store.writeProfile === "function") {
          const lease = store.readProfile(instanceId);
          if (lease != null) {
            store.writeProfile({
              ...lease,
              runtime_mode: "desktop",
            });
          }
        }
        await startDesktopConsumer();
      } catch (rollbackError) {
        throw createCodedError(
          "migration_rollback_failed",
          "migrate failed and rollback could not restore desktop consumer",
          {
            cause: error,
            rollbackCause: rollbackError,
          },
        );
      }
      clearDurableSnapshot();
      throw error;
    }
  }

  /**
   * Operator: rollback one migrated profile to the prior desktop binding.
   */
  async function rollbackToDesktop() {
    assertEnabled();

    const current = await profileConfigStore.read(profileId);
    if (current == null) {
      throw createCodedError("migration_profile_missing", "profile config not found");
    }

    const snapshot = readDurableSnapshot();
    if (snapshot == null || snapshot.priorProfileConfig == null) {
      throw createCodedError(
        "migration_snapshot_missing",
        "no Phase 5 migration snapshot; cannot rollback-to-desktop",
      );
    }
    if (snapshot.profileId !== profileId) {
      throw createCodedError("migration_snapshot_mismatch", "snapshot profileId mismatch");
    }

    if (!isHeadlessAppServerExecution(current) && current.executionKind !== CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER) {
      // Allow rollback if snapshot exists even if classify is ambiguous post-partial write.
      if (classifyCodexProfileExecution(current) !== CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER) {
        throw createCodedError(
          "migration_wrong_kind",
          "rollback-to-desktop requires a migrated headless App Server profile",
          { executionKind: classifyCodexProfileExecution(current) },
        );
      }
    }

    const instanceId = resolveInstanceId(current) ?? snapshot.profileInstanceId;
    assertMigrationIdle(instanceId);

    await pauseHeadlessConsumer();
    await ensureSingleConsumer({ active: "none" });

    const restored = buildDesktopConfigFromSnapshot(snapshot);
    try {
      await profileConfigStore.write(profileId, restored);
      if (snapshot.priorBinding != null) {
        await writeBindingSnapshot(snapshot.priorBinding);
      }

      if (store != null && instanceId != null && typeof store.writeProfile === "function") {
        const lease = store.readProfile(instanceId);
        if (lease != null) {
          store.writeProfile({
            ...lease,
            runtime_mode: "desktop",
          });
        }
      }

      await runProve(proveDesktopReady, "migration_desktop_not_ready");
      await startDesktopConsumer();
      await ensureSingleConsumer({ active: "desktop" });
      clearDurableSnapshot();

      return Object.freeze({
        ok: true,
        action: "rollback-to-desktop",
        profileId,
        profileInstanceId: instanceId,
        executionKind: CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER,
        schemaVersion: CODEX_PROFILE_SCHEMA_VERSION.DESKTOP_APP_SERVER,
        bindingRestored: snapshot.priorBinding != null,
      });
    } catch (error) {
      // Fail closed: keep headless paused; do not start desktop if prove failed
      // mid-restore without a verified single consumer. Attempt to re-apply
      // headless config from `current` so mailbox is not dual-owned.
      try {
        await pauseDesktopConsumer();
        await profileConfigStore.write(profileId, current);
        if (typeof consumers.startHeadless === "function") {
          await startHeadlessConsumer();
        }
      } catch (restoreError) {
        throw createCodedError(
          "migration_rollback_failed",
          "rollback-to-desktop failed and could not restore prior headless consumer",
          { cause: error, restoreCause: restoreError },
        );
      }
      throw error;
    }
  }

  function doctor() {
    const snap = readDurableSnapshot();
    return Object.freeze({
      profileId,
      profileInstanceId,
      enabled,
      hasMigrationSnapshot: snap != null,
      snapshotDirection: snap?.direction ?? null,
      desktopActive:
        typeof consumers.isDesktopActive === "function" ? consumers.isDesktopActive() === true : null,
      headlessActive:
        typeof consumers.isHeadlessActive === "function" ? consumers.isHeadlessActive() === true : null,
    });
  }

  return Object.freeze({
    migrateToHeadless,
    rollbackToDesktop,
    doctor,
    snapshotPath,
  });
}
