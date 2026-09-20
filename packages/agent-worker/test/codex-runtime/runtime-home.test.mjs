import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSanitizedCodexChildEnv,
  resolveCodexPoolGuards,
  resolveTriangleCodexHome,
} from "../../src/codex-runtime/runtime-home.mjs";
import {
  runSharedHomeConcurrencyProbe,
  writeProbeReport,
} from "../../src/codex-runtime/shared-home-concurrency-probe.mjs";
import {
  isDesktopHandoffEnabled,
  isHelperConversationStoreEnabled,
  resolvePhase0RuntimeConfig,
} from "../../src/codex-runtime/config-guards.mjs";
import { loadRuntimeManifest } from "../../src/codex-runtime/runtime-manifest.mjs";

test("dedicated CODEX_HOME is env-only and never the user ~/.codex", () => {
  const root = mkdtempSync(path.join(tmpdir(), "triangle-home-root-"));
  const dedicated = path.join(root, "Library", "Application Support", "The Triangle", "model-state", "codex-runtime-home");
  const resolved = resolveTriangleCodexHome({
    override: dedicated,
    home: root,
    allowCreate: true,
  });
  assert.equal(resolved, realpathSync(dedicated));

  const childEnv = buildSanitizedCodexChildEnv({
    codexHome: dedicated,
    parentEnv: {
      HOME: root,
      PATH: "/usr/bin",
      MESH_TOKEN: "mesh_watch_ABCDEFGHijklmnop",
      OPENAI_API_KEY: "sk-test",
    },
  });
  assert.equal(childEnv.CODEX_HOME, realpathSync(dedicated));
  assert.equal(childEnv.MESH_TOKEN, undefined);
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
  assert.equal(Object.hasOwn(childEnv, "CODEX_HOME"), true);

  assert.throws(
    () =>
      resolveTriangleCodexHome({
        override: path.join(root, ".codex"),
        home: root,
        allowCreate: true,
      }),
    (error) => error.code === "codex_home_user_fallback_forbidden",
  );
  rmSync(root, { recursive: true, force: true });
});

test("unproved probe forces pool to 1; passed probe unlocks Phase 3 preferred 2 / cap 4", () => {
  const unproved = resolveCodexPoolGuards({
    preferredSize: 2,
    maxSize: 4,
    desktopHandoffRequested: true,
    probeStatus: "unproved",
    manifest: {
      sharedHomeConcurrency: {
        status: "unproved",
        forcedPoolSize: 4,
        desktopHandoffEnabled: false,
        fallbackToUserCodexHomeForbidden: true,
      },
    },
  });
  assert.equal(unproved.preferredSize, 1);
  assert.equal(unproved.maxSize, 1);
  assert.equal(unproved.desktopHandoffEnabled, false);
  assert.equal(unproved.forcedByProbe, true);
  assert.equal(unproved.userFallbackForbidden, true);

  // Mini promoted shared-home to passed; Phase 3 raises the manifest cap to 4
  // while shadow defaults prefer size 2 (not 4).
  const phase3 = resolveCodexPoolGuards({
    preferredSize: 2,
    maxSize: 4,
    desktopHandoffRequested: true,
    probeStatus: "passed",
  });
  assert.equal(phase3.preferredSize, 2);
  assert.equal(phase3.maxSize, 4);
  assert.equal(phase3.forcedPoolSize, 4);
  assert.equal(phase3.forcedByManifest, false);
  assert.equal(phase3.desktopHandoffEnabled, false);

  const shadowOne = resolveCodexPoolGuards({
    preferredSize: 1,
    maxSize: 1,
    probeStatus: "passed",
  });
  assert.equal(shadowOne.preferredSize, 1);
  assert.equal(shadowOne.maxSize, 1);

  const config = resolvePhase0RuntimeConfig({
    runtimeMode: "headless",
    codexPool: { preferredSize: 2, maxSize: 4 },
  });
  assert.equal(config.pool.preferredSize, 2);
  assert.equal(config.desktopHandoffEnabled, false);
  assert.equal(config.headlessRuntimeEnabled, false);
  assert.equal(isDesktopHandoffEnabled(), false);
});

test("synthetic shared-home concurrency probe passes with fake servers and never falls back", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "triangle-probe-root-"));
  const dedicated = path.join(root, "codex-runtime-home");
  const report = await runSharedHomeConcurrencyProbe({
    codexHome: dedicated,
    env: { ...process.env, HOME: root },
  });
  assert.equal(report.status, "synthetic-passed");
  assert.equal(report.threads.length, 2);
  assert.equal(report.seedTurnIds.length, 2);
  assert.notEqual(report.threads[0], report.threads[1]);
  assert.equal(report.codexHome, realpathSync(dedicated));
  assert.doesNotMatch(JSON.stringify(report), /\.codex/);

  const file = writeProbeReport(report, { directory: path.join(root, "out") });
  assert.match(file, /shared-home-concurrency-probe\.json$/);

  const manifest = loadRuntimeManifest({ forceReload: true });
  assert.equal(manifest.sharedHomeConcurrency.status, "passed");
  assert.equal(manifest.sharedHomeConcurrency.forcedPoolSize, 4);
  assert.equal(manifest.sharedHomeConcurrency.fallbackToUserCodexHomeForbidden, true);
  rmSync(root, { recursive: true, force: true });
});

test("live-like fake rejects resume before seed; probe seed ordering avoids Mini no-rollout failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "triangle-probe-rollout-"));
  const dedicated = path.join(root, "codex-runtime-home");
  const store = path.join(dedicated, ".triangle-probe-materialized-threads");
  mkdirSync(dedicated, { recursive: true, mode: 0o700 });

  const { createFakeAppServerStdioProgram, createCodexAppServerProcess } = await import(
    "../../src/codex-runtime/app-server-process.mjs"
  );

  const fake = createFakeAppServerStdioProgram({
    serverIdentity: "fake-live-like",
    idPrefix: "liveLike",
    requireMaterializedRollout: true,
    materializedStorePath: store,
  });
  const slot = createCodexAppServerProcess({
    command: fake.command,
    args: fake.args,
    codexHome: dedicated,
    env: { ...process.env, HOME: root },
  });

  try {
    await slot.start();
    await slot.initialize({ name: "triangle-rollout-repro", version: "0.0.0" });
    const started = await slot.threadStart({
      cwd: dedicated,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
    });
    const threadId = started.thread.id;
    await assert.rejects(
      () => slot.threadResume({ threadId }),
      (error) =>
        error.code === "rpc_error" &&
        /no rollout found for thread id/.test(error.message),
    );
  } finally {
    await slot.close({ signal: "SIGKILL", timeoutMs: 1_000 });
  }

  const report = await runSharedHomeConcurrencyProbe({
    codexHome: dedicated,
    env: { ...process.env, HOME: root },
  });
  assert.equal(report.status, "synthetic-passed");
  assert.equal(report.seedTurnIds.length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("helper conversation store feature flag is inactive in Phase 0", () => {
  assert.equal(isHelperConversationStoreEnabled(), false);
  const flags = loadRuntimeManifest({ forceReload: true }).featureFlags;
  assert.equal(flags.helperConversationStore, false);
  assert.equal(flags.headlessRuntime, false);
  assert.equal(flags.desktopHandoff, false);
});
