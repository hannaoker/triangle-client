import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDurableConversationStore } from "../../src/codex-runtime/durable-conversation-store.mjs";
import { createExecutionLeaseManager } from "../../src/codex-runtime/execution-lease.mjs";
import {
  createDefaultCodexProfileConfig,
  createMemoryProfileConfigStore,
  createProfileMigrationController,
  isPhase5MigrationEnabled,
  loadRuntimeManifest,
  resolveHeadlessRuntimeConfig,
  resolvePhase5MigrationConfig,
  wouldNewCodexProfileDefaultToHeadless,
  CODEX_EXECUTION_KIND,
  CODEX_PROFILE_SCHEMA_VERSION,
  classifyCodexProfileExecution,
  annotateCodexProfileSchema,
  isMcpInteractiveDesktopProfile,
} from "../../src/codex-runtime/index.mjs";

const PROFILE_ID = "codex-phase5-test";
const PROFILE_INSTANCE = "a".repeat(64);
const ROOM = `room_${"b".repeat(32)}`;

const SAFE_MANIFEST = Object.freeze({
  sharedHomeConcurrency: {
    status: "passed",
    forcedPoolSize: 4,
    desktopHandoffEnabled: false,
    fallbackToUserCodexHomeForbidden: true,
  },
  featureFlags: {
    helperConversationStore: false,
    headlessRuntime: false,
    desktopHandoff: false,
  },
});

function tempRoot(prefix = "triangle-phase5-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createClock(start = 2_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

function createConsumerTracker() {
  let desktopActive = true;
  let headlessActive = false;
  return {
    get desktopActive() {
      return desktopActive;
    },
    get headlessActive() {
      return headlessActive;
    },
    api: {
      isDesktopActive: () => desktopActive,
      isHeadlessActive: () => headlessActive,
      async pauseDesktop() {
        desktopActive = false;
      },
      async stopDesktop() {
        desktopActive = false;
      },
      async startDesktop() {
        if (headlessActive) {
          throw new Error("dual consumer");
        }
        desktopActive = true;
      },
      async pauseHeadless() {
        headlessActive = false;
      },
      async stopHeadless() {
        headlessActive = false;
      },
      async startHeadless() {
        if (desktopActive) {
          throw new Error("dual consumer");
        }
        headlessActive = true;
      },
    },
  };
}

function createBindingStore(initial) {
  let binding = initial == null ? null : { ...initial };
  return {
    async read() {
      return binding == null ? null : { ...binding };
    },
    async write(next) {
      binding = { ...next };
      return binding;
    },
  };
}

test("Phase 5 feature gate stays operator-disableable; headless is the product default", () => {
  assert.equal(isPhase5MigrationEnabled({ manifest: SAFE_MANIFEST, env: {} }), true);
  assert.equal(loadRuntimeManifest({ forceReload: true }).featureFlags.headlessRuntime, false);

  const on = resolvePhase5MigrationConfig(
    { profileId: "codex-bob-test" },
    { manifest: SAFE_MANIFEST, env: {} },
  );
  assert.equal(on.active, true);
  assert.equal(on.newProfileDefaultHeadless, true);
  assert.equal(on.migrationOperationsEnabled, true);
  assert.equal(on.globalHeadlessRuntimeFlag, false);

  const viaDisable = resolvePhase5MigrationConfig(
    { profileId: "codex-bob-test" },
    { manifest: SAFE_MANIFEST, env: { TRIANGLE_PHASE5_MIGRATION_ENABLE: "0" } },
  );
  assert.equal(viaDisable.active, false);
  assert.equal(viaDisable.newProfileDefaultHeadless, true);
  assert.equal(viaDisable.inactiveReason, "phase5_migration_not_enabled");

  const viaFlag = resolvePhase5MigrationConfig(
    { profileId: "x" },
    { manifest: SAFE_MANIFEST, env: {}, enablePhase5Migration: true },
  );
  assert.equal(viaFlag.active, true);
});

test("production headless runtime activates any Codex profile without Mini allowlist", () => {
  const profile = {
    profileId: "codex-headless",
    executionKind: CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER,
    runtimeAdapter: "codex-app-server",
    runtimeMode: "headless",
    shadowTestProfile: false,
    codexPool: { preferredSize: 1, maxSize: 1 },
  };

  const enabled = resolveHeadlessRuntimeConfig(profile, { manifest: SAFE_MANIFEST, env: {} });
  assert.equal(enabled.active, true);
  assert.equal(enabled.activationMode, "headless_app_server");
  assert.equal(enabled.pool.preferredSize, 1);
  assert.equal(enabled.desktopHandoffEnabled, false);

  const production = resolveHeadlessRuntimeConfig(
    { ...profile, profileId: "codex-bob-test" },
    { manifest: SAFE_MANIFEST, env: {} },
  );
  assert.equal(production.active, true);
  assert.equal(production.profileId, "codex-bob-test");

  const grok = resolveHeadlessRuntimeConfig(
    {
      profileId: "bob",
      executionKind: CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER,
      runtimeAdapter: "grok-bot",
      runtimeMode: "headless",
      deliveryMode: "grok-bot",
    },
    { manifest: SAFE_MANIFEST, env: {} },
  );
  assert.equal(grok.active, false);
  assert.equal(grok.inactiveReason, "grok_bot_not_in_codex_pool");

  const desktop = resolveHeadlessRuntimeConfig(
    {
      profileId: "codex-bob-test",
      executionKind: CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER,
      runtimeAdapter: "codex-app-server",
      runtimeMode: "desktop",
      deliveryMode: "mcp-interactive",
    },
    { manifest: SAFE_MANIFEST, env: {} },
  );
  assert.equal(desktop.active, false);
});

test("profile schema classifies legacy vs desktop vs headless App Server", () => {
  assert.equal(
    classifyCodexProfileExecution({
      deliveryMode: "event-driven",
      runtimeAdapter: "codex",
    }),
    CODEX_EXECUTION_KIND.LEGACY_COMMAND,
  );
  assert.equal(
    classifyCodexProfileExecution({
      deliveryMode: "mcp-interactive",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "desktop",
    }),
    CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER,
  );
  assert.equal(
    classifyCodexProfileExecution({
      runtimeAdapter: "codex-app-server",
      runtimeMode: "headless",
    }),
    CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER,
  );

  const annotated = annotateCodexProfileSchema({
    deliveryMode: "mcp-interactive",
    runtimeAdapter: "codex-app-server",
    runtimeMode: "desktop",
  });
  assert.equal(annotated.schemaVersion, CODEX_PROFILE_SCHEMA_VERSION.DESKTOP_APP_SERVER);
  assert.equal(annotated.executionKind, CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER);
  assert.equal(isMcpInteractiveDesktopProfile(annotated), true);
});

test("new Codex profile defaults to headless App Server; grok-bot cannot use the factory", () => {
  const productionDefault = createDefaultCodexProfileConfig({
    profileId: "codex-bob-test",
    manifest: SAFE_MANIFEST,
    env: {},
  });
  assert.equal(productionDefault.phase5DefaultApplied, true);
  assert.equal(productionDefault.deliveryMode, "headless-app-server");
  assert.equal(productionDefault.runtimeMode, "headless");
  assert.equal(productionDefault.runtimeAdapter, "codex-app-server");
  assert.equal(productionDefault.executionKind, CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER);
  assert.equal(productionDefault.conversationKey, "roomId");
  assert.equal(productionDefault.codexPool.preferredSize, 1);
  assert.equal(wouldNewCodexProfileDefaultToHeadless({ manifest: SAFE_MANIFEST, env: {} }), true);

  const another = createDefaultCodexProfileConfig({
    profileId: "codex-new-headless",
    manifest: SAFE_MANIFEST,
    env: {},
  });
  assert.equal(another.runtimeMode, "headless");
  assert.equal(another.runtimeAdapter, "codex-app-server");
  assert.equal(another.executionKind, CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER);
  assert.equal(another.schemaVersion, CODEX_PROFILE_SCHEMA_VERSION.HEADLESS_APP_SERVER);
  assert.equal(another.deliveryMode, "headless-app-server");

  assert.throws(
    () => createDefaultCodexProfileConfig({
      profileId: "bob",
      manifest: SAFE_MANIFEST,
      env: {},
      overrides: { runtimeAdapter: "grok-bot" },
    }),
    (error) => error.code === "grok_bot_not_in_codex_pool",
  );
});

test("existing mcp-interactive unchanged without migrate; migrate rejects when disabled", async () => {
  const configStore = createMemoryProfileConfigStore();
  const desktop = {
    profileId: PROFILE_ID,
    profileInstanceId: PROFILE_INSTANCE,
    deliveryMode: "mcp-interactive",
    runtimeAdapter: "codex-app-server",
    runtimeMode: "desktop",
    executionKind: CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER,
    schemaVersion: CODEX_PROFILE_SCHEMA_VERSION.DESKTOP_APP_SERVER,
  };
  await configStore.write(PROFILE_ID, desktop);

  const disabled = createProfileMigrationController({
    profileConfigStore: configStore,
    profileId: PROFILE_ID,
    enabled: false,
  });
  await assert.rejects(() => disabled.migrateToHeadless(), (error) => {
    assert.equal(error.code, "phase5_migration_disabled");
    return true;
  });

  const still = await configStore.read(PROFILE_ID);
  assert.equal(still.deliveryMode, "mcp-interactive");
  assert.equal(still.runtimeMode, "desktop");
});

test("migrate-to-headless + rollback-to-desktop are transactional and single-consumer", async () => {
  const root = tempRoot();
  const clock = createClock();
  const consumers = createConsumerTracker();
  const bindingStore = createBindingStore({
    enabled: true,
    installationId: "inst_test",
    threadId: "01a06f9f-2db1-7143-b8b9-08c634cc7999",
    serverIdentity: "codex-app-server/test",
  });
  const configStore = createMemoryProfileConfigStore();
  await configStore.write(PROFILE_ID, {
    profileId: PROFILE_ID,
    profileInstanceId: PROFILE_INSTANCE,
    deliveryMode: "mcp-interactive",
    runtimeAdapter: "codex-app-server",
    runtimeMode: "desktop",
    executionKind: CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER,
    schemaVersion: CODEX_PROFILE_SCHEMA_VERSION.DESKTOP_APP_SERVER,
    appServerWake: { actorProfile: PROFILE_ID },
  });

  const store = createDurableConversationStore({
    root,
    enabled: true,
    now: clock.now,
  });
  const leaseManager = createExecutionLeaseManager({
    store,
    ownerInstanceId: "desktop-owner-1",
    now: clock.now,
    leaseDurationMs: 60_000,
  });
  leaseManager.acquire({
    profileInstanceId: PROFILE_INSTANCE,
    runtimeMode: "desktop",
  });
  store.writeProfile({
    ...store.readProfile(PROFILE_INSTANCE),
    bound_codex_thread_id: "thread-migrate-001",
  });

  const migration = createProfileMigrationController({
    profileConfigStore: configStore,
    profileId: PROFILE_ID,
    profileInstanceId: PROFILE_INSTANCE,
    store,
    leaseManager,
    bindingStore,
    mailboxConsumers: consumers.api,
    snapshotRoot: root,
    enabled: true,
    now: clock.now,
    proveHeadlessReady: async () => ({ ok: true }),
    proveDesktopReady: async () => ({ ok: true }),
  });

  try {
    assert.equal(consumers.desktopActive, true);
    assert.equal(consumers.headlessActive, false);

    const migrated = await migration.migrateToHeadless();
    assert.equal(migrated.ok, true);
    assert.equal(migrated.action, "migrate-to-headless");
    assert.equal(migrated.executionKind, CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER);
    assert.equal(consumers.desktopActive, false);
    assert.equal(consumers.headlessActive, true);
    assert.equal((await bindingStore.read()).enabled, false);

    const after = await configStore.read(PROFILE_ID);
    assert.equal(after.runtimeMode, "headless");
    assert.equal(after.deliveryMode, "headless-app-server");
    assert.equal(after.executionKind, CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER);
    assert.equal(store.readProfile(PROFILE_INSTANCE).runtime_mode, "headless");

    const rolled = await migration.rollbackToDesktop();
    assert.equal(rolled.ok, true);
    assert.equal(rolled.action, "rollback-to-desktop");
    assert.equal(consumers.desktopActive, true);
    assert.equal(consumers.headlessActive, false);
    assert.equal((await bindingStore.read()).enabled, true);

    const restored = await configStore.read(PROFILE_ID);
    assert.equal(restored.deliveryMode, "mcp-interactive");
    assert.equal(restored.runtimeMode, "desktop");
    assert.equal(store.readProfile(PROFILE_INSTANCE).runtime_mode, "desktop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate rejects while non-idle, transferring, or frozen", async () => {
  const root = tempRoot();
  const clock = createClock();
  const configStore = createMemoryProfileConfigStore();
  await configStore.write(PROFILE_ID, {
    profileId: PROFILE_ID,
    profileInstanceId: PROFILE_INSTANCE,
    deliveryMode: "mcp-interactive",
    runtimeAdapter: "codex-app-server",
    runtimeMode: "desktop",
  });

  const store = createDurableConversationStore({
    root,
    enabled: true,
    now: clock.now,
  });
  const leaseManager = createExecutionLeaseManager({
    store,
    ownerInstanceId: "desktop-owner-1",
    now: clock.now,
    leaseDurationMs: 60_000,
  });
  leaseManager.acquire({
    profileInstanceId: PROFILE_INSTANCE,
    runtimeMode: "desktop",
  });

  const migration = createProfileMigrationController({
    profileConfigStore: configStore,
    profileId: PROFILE_ID,
    profileInstanceId: PROFILE_INSTANCE,
    store,
    leaseManager,
    mailboxConsumers: createConsumerTracker().api,
    snapshotRoot: root,
    enabled: true,
    now: clock.now,
  });

  try {
    // Non-idle conversation
    store.writeConversation({
      version: 1,
      profile_instance_id: PROFILE_INSTANCE,
      mesh_room_id: ROOM,
      codex_thread_id: "thread-busy",
      active_delivery_id: "delivery-1",
      execution_epoch: 1,
      execution_state: "running",
      last_worker_slot_id: null,
      last_completed_delivery_id: null,
      last_reply_event_id: null,
      updated_at: new Date(clock.now()).toISOString(),
    });

    await assert.rejects(() => migration.migrateToHeadless(), (error) => {
      assert.equal(error.code, "migration_not_idle");
      return true;
    });

    // Clear to idle, then transfer
    store.writeConversation({
      version: 1,
      profile_instance_id: PROFILE_INSTANCE,
      mesh_room_id: ROOM,
      codex_thread_id: "thread-busy",
      active_delivery_id: null,
      execution_epoch: 1,
      execution_state: "idle",
      last_worker_slot_id: null,
      last_completed_delivery_id: null,
      last_reply_event_id: null,
      updated_at: new Date(clock.now()).toISOString(),
    });

    const profile = store.readProfile(PROFILE_INSTANCE);
    leaseManager.beginTransfer({
      profileInstanceId: PROFILE_INSTANCE,
      expectedGeneration: profile.owner_generation,
      transferOwnerInstanceId: "transfer-actor",
      targetRuntimeMode: "headless",
    });

    await assert.rejects(() => migration.migrateToHeadless(), (error) => {
      assert.equal(error.code, "migration_transferring");
      return true;
    });

    // Rollback transfer and freeze
    const transferring = store.readProfile(PROFILE_INSTANCE);
    leaseManager.rollbackTransfer({
      profileInstanceId: PROFILE_INSTANCE,
      expectedTransferGeneration: transferring.owner_generation,
    });
    leaseManager.freezeAdmissionAfterCommit({
      profileInstanceId: PROFILE_INSTANCE,
      expectedGeneration: store.readProfile(PROFILE_INSTANCE).owner_generation,
    });

    await assert.rejects(() => migration.migrateToHeadless(), (error) => {
      assert.equal(error.code, "migration_admission_frozen");
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed headless readiness restores desktop without dual consumers", async () => {
  const root = tempRoot();
  const clock = createClock();
  const consumers = createConsumerTracker();
  const bindingStore = createBindingStore({
    enabled: true,
    installationId: "inst_test",
    threadId: "01a06f9f-2db1-7143-b8b9-08c634cc7999",
    serverIdentity: "codex-app-server/test",
  });
  const configStore = createMemoryProfileConfigStore();
  await configStore.write(PROFILE_ID, {
    profileId: PROFILE_ID,
    profileInstanceId: PROFILE_INSTANCE,
    deliveryMode: "mcp-interactive",
    runtimeAdapter: "codex-app-server",
    runtimeMode: "desktop",
  });

  const store = createDurableConversationStore({
    root,
    enabled: true,
    now: clock.now,
  });
  const leaseManager = createExecutionLeaseManager({
    store,
    ownerInstanceId: "desktop-owner-1",
    now: clock.now,
    leaseDurationMs: 60_000,
  });
  leaseManager.acquire({
    profileInstanceId: PROFILE_INSTANCE,
    runtimeMode: "desktop",
  });

  const migration = createProfileMigrationController({
    profileConfigStore: configStore,
    profileId: PROFILE_ID,
    profileInstanceId: PROFILE_INSTANCE,
    store,
    leaseManager,
    bindingStore,
    mailboxConsumers: consumers.api,
    snapshotRoot: root,
    enabled: true,
    now: clock.now,
    proveHeadlessReady: async () => ({ ok: false, reason: "first_start_gate_failed" }),
  });

  try {
    await assert.rejects(() => migration.migrateToHeadless(), (error) => {
      assert.equal(error.code, "migration_headless_not_ready");
      return true;
    });

    assert.equal(consumers.desktopActive, true);
    assert.equal(consumers.headlessActive, false);
    assert.equal((await bindingStore.read()).enabled, true);
    const restored = await configStore.read(PROFILE_ID);
    assert.equal(restored.deliveryMode, "mcp-interactive");
    assert.equal(restored.runtimeMode, "desktop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
