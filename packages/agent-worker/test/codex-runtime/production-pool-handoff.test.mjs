import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFakeAppServerStdioProgram } from "../../src/codex-runtime/app-server-process.mjs";
import {
  createDefaultCodexProfileConfig,
  createHeadlessCodexRuntime,
  isDesktopHandoffEnabled,
  LIVE_SHARED_HOME_PROBE_FILE_ENV,
  LIVE_SHARED_HOME_PROBE_MAX_AGE_MS,
  resolveDesktopHandoffGate,
  resolveHeadlessRuntimeConfig,
  resolveLiveSharedHomeProbe,
  resolvePhase4DesktopHandoffConfig,
  resolveProductionCodexPoolConfig,
} from "../../src/codex-runtime/index.mjs";

const PASSED_MANIFEST = Object.freeze({
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

const UNPROVED_MANIFEST = Object.freeze({
  sharedHomeConcurrency: {
    status: "unproved",
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

function livePassedProbe(overrides = {}) {
  return {
    status: "passed",
    live: true,
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

function productionProfile(overrides = {}) {
  return {
    profileId: "codex-headless",
    executionKind: "headless-app-server",
    runtimeAdapter: "codex-app-server",
    runtimeMode: "headless",
    deliveryMode: "headless-app-server",
    shadowTestProfile: false,
    approvalPolicy: "never",
    sandboxClass: "read-only",
    ...overrides,
  };
}

test("production defaults stay pool 1 and handoff off even when probe is passed", () => {
  const profile = productionProfile({
    codexPool: { preferredSize: 2, maxSize: 4 },
  });
  const resolved = resolveHeadlessRuntimeConfig(profile, {
    manifest: PASSED_MANIFEST,
    env: {},
  });
  assert.equal(resolved.active, true);
  assert.equal(resolved.activationMode, "headless_app_server");
  assert.equal(resolved.pool.preferredSize, 1);
  assert.equal(resolved.pool.maxSize, 1);
  assert.equal(resolved.pool.productionPoolOptIn, false);
  assert.equal(resolved.pool.productionPoolInactiveReason, "production_pool_not_enabled");
  assert.equal(resolved.desktopHandoffEnabled, false);
  assert.equal(isDesktopHandoffEnabled(PASSED_MANIFEST), false);

  const factory = createDefaultCodexProfileConfig({
    profileId: "codex-new",
    manifest: PASSED_MANIFEST,
    env: {},
  });
  assert.equal(factory.codexPool.preferredSize, 1);
  assert.equal(factory.codexPool.maxSize, 1);
});

test("TRIANGLE_CODEX_POOL_ENABLE stays at pool 1 without a live probe even when on-disk status is passed", () => {
  const profile = productionProfile();
  const disabled = resolveProductionCodexPoolConfig(profile, {
    manifest: PASSED_MANIFEST,
    env: { TRIANGLE_CODEX_POOL_SIZE: "3" },
  });
  assert.equal(disabled.preferredSize, 1);
  assert.equal(disabled.productionPoolOptIn, false);

  const enableNoLive = resolveHeadlessRuntimeConfig(profile, {
    manifest: PASSED_MANIFEST,
    env: { TRIANGLE_CODEX_POOL_ENABLE: "1" },
  });
  assert.equal(enableNoLive.active, true);
  assert.equal(enableNoLive.pool.preferredSize, 1);
  assert.equal(enableNoLive.pool.maxSize, 1);
  assert.equal(enableNoLive.pool.productionPoolOptIn, true);
  assert.equal(enableNoLive.pool.productionPoolInactiveReason, "live_shared_home_probe_missing");
  assert.equal(enableNoLive.pool.forcedByProbe, true);

  const enableSizeNoLive = resolveHeadlessRuntimeConfig(profile, {
    manifest: PASSED_MANIFEST,
    env: { TRIANGLE_CODEX_POOL_ENABLE: "1", TRIANGLE_CODEX_POOL_SIZE: "3" },
  });
  assert.equal(enableSizeNoLive.pool.preferredSize, 1);
  assert.equal(enableSizeNoLive.pool.productionPoolInactiveReason, "live_shared_home_probe_missing");

  const invalid = resolveHeadlessRuntimeConfig(profile, {
    manifest: PASSED_MANIFEST,
    env: { TRIANGLE_CODEX_POOL_ENABLE: "1", TRIANGLE_CODEX_POOL_SIZE: "9" },
    liveSharedHomeProbe: livePassedProbe(),
  });
  assert.equal(invalid.pool.preferredSize, 1);
  assert.equal(invalid.pool.productionPoolInactiveReason, "pool_size_env_invalid");
});

test("TRIANGLE_CODEX_POOL_ENABLE raises production pool only after a live probe in this run", () => {
  const profile = productionProfile();
  const enabled = resolveHeadlessRuntimeConfig(profile, {
    manifest: PASSED_MANIFEST,
    env: { TRIANGLE_CODEX_POOL_ENABLE: "1" },
    liveSharedHomeProbe: livePassedProbe(),
  });
  assert.equal(enabled.active, true);
  assert.equal(enabled.pool.preferredSize, 2);
  assert.equal(enabled.pool.maxSize, 4);
  assert.equal(enabled.pool.productionPoolOptIn, true);
  assert.equal(enabled.pool.productionPoolInactiveReason, null);
  assert.equal(enabled.desktopHandoffEnabled, false);

  const sized = resolveHeadlessRuntimeConfig(profile, {
    manifest: PASSED_MANIFEST,
    env: { TRIANGLE_CODEX_POOL_ENABLE: "1", TRIANGLE_CODEX_POOL_SIZE: "3" },
    liveSharedHomeProbe: livePassedProbe(),
  });
  assert.equal(sized.pool.preferredSize, 3);
  assert.equal(sized.pool.maxSize, 4);

  const liveOverridesDisk = resolveHeadlessRuntimeConfig(profile, {
    manifest: UNPROVED_MANIFEST,
    env: { TRIANGLE_CODEX_POOL_ENABLE: "1", TRIANGLE_CODEX_POOL_SIZE: "3" },
    liveSharedHomeProbe: livePassedProbe(),
  });
  assert.equal(liveOverridesDisk.active, true);
  assert.equal(liveOverridesDisk.pool.preferredSize, 3);
  assert.equal(liveOverridesDisk.pool.maxSize, 4);
  assert.equal(liveOverridesDisk.pool.forcedByProbe, false);
});

test("missing expired stale and synthetic probe files fail closed at pool 1", () => {
  const profile = productionProfile();
  const root = mkdtempSync(path.join(tmpdir(), "triangle-live-probe-"));
  const now = Date.parse("2026-09-22T04:00:00.000Z");
  try {
    const missing = resolveHeadlessRuntimeConfig(profile, {
      manifest: PASSED_MANIFEST,
      env: {
        TRIANGLE_CODEX_POOL_ENABLE: "1",
        [LIVE_SHARED_HOME_PROBE_FILE_ENV]: path.join(root, "missing.json"),
      },
      now,
    });
    assert.equal(missing.pool.preferredSize, 1);
    assert.equal(missing.pool.productionPoolInactiveReason, "live_shared_home_probe_missing");

    const stalePath = path.join(root, "stale.json");
    writeFileSync(stalePath, `${JSON.stringify({ status: "passed", live: true })}\n`);
    const stale = resolveHeadlessRuntimeConfig(profile, {
      manifest: PASSED_MANIFEST,
      env: { TRIANGLE_CODEX_POOL_ENABLE: "1", [LIVE_SHARED_HOME_PROBE_FILE_ENV]: stalePath },
      now,
    });
    assert.equal(stale.pool.preferredSize, 1);
    assert.equal(stale.pool.productionPoolInactiveReason, "live_shared_home_probe_stale");

    const expiredPath = path.join(root, "expired.json");
    writeFileSync(
      expiredPath,
      `${JSON.stringify({
        status: "passed",
        live: true,
        finishedAt: new Date(now - LIVE_SHARED_HOME_PROBE_MAX_AGE_MS - 1).toISOString(),
      })}\n`,
    );
    const expired = resolveHeadlessRuntimeConfig(profile, {
      manifest: PASSED_MANIFEST,
      env: { TRIANGLE_CODEX_POOL_ENABLE: "1", [LIVE_SHARED_HOME_PROBE_FILE_ENV]: expiredPath },
      now,
    });
    assert.equal(expired.pool.preferredSize, 1);
    assert.equal(expired.pool.productionPoolInactiveReason, "live_shared_home_probe_expired");

    const syntheticPath = path.join(root, "synthetic.json");
    writeFileSync(
      syntheticPath,
      `${JSON.stringify({
        status: "synthetic-passed",
        live: false,
        finishedAt: new Date(now).toISOString(),
      })}\n`,
    );
    const synthetic = resolveHeadlessRuntimeConfig(profile, {
      manifest: PASSED_MANIFEST,
      env: { TRIANGLE_CODEX_POOL_ENABLE: "1", [LIVE_SHARED_HOME_PROBE_FILE_ENV]: syntheticPath },
      now,
    });
    assert.equal(synthetic.pool.preferredSize, 1);
    assert.equal(synthetic.pool.productionPoolInactiveReason, "live_shared_home_probe_not_live");

    const freshPath = path.join(root, "fresh.json");
    writeFileSync(freshPath, `${JSON.stringify(livePassedProbe({ finishedAt: new Date(now).toISOString() }))}\n`);
    const fresh = resolveHeadlessRuntimeConfig(profile, {
      manifest: PASSED_MANIFEST,
      env: { TRIANGLE_CODEX_POOL_ENABLE: "1", [LIVE_SHARED_HOME_PROBE_FILE_ENV]: freshPath },
      now,
    });
    assert.equal(fresh.pool.preferredSize, 2);
    assert.equal(fresh.pool.productionPoolInactiveReason, null);
    assert.equal(resolveLiveSharedHomeProbe({ env: { [LIVE_SHARED_HOME_PROBE_FILE_ENV]: freshPath }, now }).passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grok-bot and mcp-interactive stay out of the Codex pool and handoff gate", () => {
  const grok = resolveHeadlessRuntimeConfig(
    {
      profileId: "bob",
      executionKind: "headless-app-server",
      runtimeAdapter: "grok-bot",
      runtimeMode: "headless",
      deliveryMode: "grok-bot",
    },
    {
      manifest: PASSED_MANIFEST,
      env: {
        TRIANGLE_CODEX_POOL_ENABLE: "1",
        TRIANGLE_DESKTOP_HANDOFF_ENABLE: "1",
      },
    },
  );
  assert.equal(grok.active, false);
  assert.equal(grok.inactiveReason, "grok_bot_not_in_codex_pool");
  assert.equal(grok.desktopHandoffEnabled, false);

  const desktop = resolveHeadlessRuntimeConfig(
    {
      profileId: "codex-bob-test",
      executionKind: "desktop-app-server",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "desktop",
      deliveryMode: "mcp-interactive",
    },
    {
      manifest: PASSED_MANIFEST,
      env: {
        TRIANGLE_CODEX_POOL_ENABLE: "1",
        TRIANGLE_DESKTOP_HANDOFF_ENABLE: "1",
      },
    },
  );
  assert.equal(desktop.active, false);
  assert.equal(desktop.desktopHandoffEnabled, false);

  const desktopHandoff = resolvePhase4DesktopHandoffConfig(
    {
      profileId: "codex-bob-test",
      executionKind: "desktop-app-server",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "desktop",
      deliveryMode: "mcp-interactive",
    },
    { manifest: PASSED_MANIFEST, env: { TRIANGLE_DESKTOP_HANDOFF_ENABLE: "1" } },
  );
  assert.equal(desktopHandoff.active, false);
  assert.equal(desktopHandoff.eligible, false);
});

test("TRIANGLE_DESKTOP_HANDOFF_ENABLE opts production headless into idle-only handoff", () => {
  const profile = productionProfile();
  const off = resolveDesktopHandoffGate(profile, { manifest: PASSED_MANIFEST, env: {} });
  assert.equal(off.active, false);
  assert.equal(off.desktopHandoffEnabled, false);

  const on = resolveHeadlessRuntimeConfig(profile, {
    manifest: PASSED_MANIFEST,
    env: { TRIANGLE_DESKTOP_HANDOFF_ENABLE: "1" },
  });
  assert.equal(on.active, true);
  assert.equal(on.desktopHandoffEnabled, true);
  assert.equal(on.handoff.eligible, true);
  assert.equal(on.pool.preferredSize, 1);

  const unproved = resolveHeadlessRuntimeConfig(profile, {
    manifest: UNPROVED_MANIFEST,
    env: { TRIANGLE_DESKTOP_HANDOFF_ENABLE: "1" },
  });
  assert.equal(unproved.active, true);
  assert.equal(unproved.desktopHandoffEnabled, false);
  assert.equal(unproved.handoff.inactiveReason, "shared_home_concurrency_unproved");
});

test("production opt-in starts two pool slots; default production stays one", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "triangle-prod-pool-"));
  const store = path.join(home, "materialized-threads");
  const fake = createFakeAppServerStdioProgram({
    serverIdentity: "fake-prod-pool",
    idPrefix: "pp",
    requireMaterializedRollout: true,
    materializedStorePath: store,
  });
  const proxy = {
    async reply() {
      return { replyEventId: `event_${"d".repeat(32)}`, state: "replied" };
    },
    async ack() {
      return { acknowledged: true };
    },
  };
  const profile = productionProfile({ workingDirectory: home });
  const logger = { info() {}, error() {} };
  const env = { ...process.env, HOME: path.dirname(home) };

  const runtimeOptions = {
    profileConfig: profile,
    transactionProxy: proxy,
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env,
    logger,
  };

  const defaultRuntime = createHeadlessCodexRuntime(runtimeOptions);
  try {
    const defaultStarted = await defaultRuntime.start();
    assert.equal(defaultStarted.pool.size, 1);
  } finally {
    await defaultRuntime.stop({ signal: "SIGKILL", timeoutMs: 1_000 }).catch(() => {});
  }

  const enableWithoutLive = createHeadlessCodexRuntime({
    ...runtimeOptions,
    enableProductionPool: true,
  });
  try {
    const started = await enableWithoutLive.start();
    assert.equal(started.pool.size, 1);
  } finally {
    await enableWithoutLive.stop({ signal: "SIGKILL", timeoutMs: 1_000 }).catch(() => {});
  }

  const opted = createHeadlessCodexRuntime({
    ...runtimeOptions,
    enableProductionPool: true,
    liveSharedHomeProbe: livePassedProbe(),
  });
  try {
    const optedStarted = await opted.start();
    assert.equal(optedStarted.pool.size, 2);
    assert.equal(optedStarted.pool.forcedPoolSize, 4);

    const profileInstanceId = "c".repeat(64);
    const [left, right] = await Promise.all([
      opted.runDelivery({
        profileInstanceId,
        roomId: `room_${"a".repeat(32)}`,
        deliveryId: "delivery_1",
        numericDeliveryId: 1,
        text: "left",
      }),
      opted.runDelivery({
        profileInstanceId,
        roomId: `room_${"b".repeat(32)}`,
        deliveryId: "delivery_2",
        numericDeliveryId: 2,
        text: "right",
      }),
    ]);
    assert.equal(left.status, "completed");
    assert.equal(right.status, "completed");
    assert.notEqual(left.slotId, right.slotId);
  } finally {
    await opted.stop({ signal: "SIGKILL", timeoutMs: 1_000 }).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});
