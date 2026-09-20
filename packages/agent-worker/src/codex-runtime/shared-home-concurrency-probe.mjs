/**
 * Dual App Server shared-home concurrency probe.
 *
 * Phase 0 scaffolds the probe and records unproved status. Live proof requires
 * Mini Darwin + authenticated dedicated CODEX_HOME. Until status === "passed",
 * pool size stays 1 and desktop handoff stays disabled.
 *
 * Live App Server materializes rollouts lazily on the first turn/start — not at
 * thread/start. Resuming before that seed turn yields `no rollout found for
 * thread id`. A failed probe must never fall back to ~/.codex.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createCodexAppServerProcess,
  createFakeAppServerStdioProgram,
  waitForAppServerTurnCompleted,
} from "./app-server-process.mjs";
import { resolveTriangleCodexHome } from "./runtime-home.mjs";

const DEFAULT_SEED_TIMEOUT_MS = 90_000;
const PROBE_SEED_TEXT =
  "Triangle shared-home concurrency probe seed turn. Do not use tools. Reply briefly.";

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Start a thread then run one seed turn so live App Server writes a durable
 * rollout before any thread/resume (same-process or cross-process).
 */
async function startMaterializedThread(
  slot,
  {
    cwd,
    seedTimeoutMs = DEFAULT_SEED_TIMEOUT_MS,
    seedText = PROBE_SEED_TEXT,
  } = {},
) {
  const started = await slot.threadStart({
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: false,
  });
  const threadId = started?.thread?.id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw createCodedError("probe_thread_start_failed", "thread/start did not return ids");
  }

  const seedDone = waitForAppServerTurnCompleted(slot, {
    threadId,
    timeoutMs: seedTimeoutMs,
  });
  const seedStarted = await slot.turnStart({
    threadId,
    input: [{ type: "text", text: seedText }],
  });
  const seedTurnId = seedStarted?.turn?.id;
  if (typeof seedTurnId !== "string" || seedTurnId.length === 0) {
    throw createCodedError(
      "probe_seed_turn_failed",
      "seed turn/start did not return a turn id",
      { threadId },
    );
  }

  const seedTurn = await seedDone;
  if (seedTurn?.status && seedTurn.status !== "completed") {
    throw createCodedError(
      "probe_seed_turn_failed",
      "seed turn did not complete successfully",
      { threadId, seedTurnId, status: seedTurn.status },
    );
  }

  return Object.freeze({ threadId, seedTurnId });
}

/**
 * Run two App Server children against the same dedicated CODEX_HOME.
 * Uses the fake stdio server by default (unit-testable). Pass `live: true`
 * plus a real `command`/`args` on Mini Darwin.
 *
 * Synthetic fakes default to live-like rollout materialization so the seed
 * ordering is regression-covered without ChatGPT.app.
 */
export async function runSharedHomeConcurrencyProbe({
  codexHome,
  live = false,
  command = null,
  args = null,
  createProcess = createCodexAppServerProcess,
  createFake = createFakeAppServerStdioProgram,
  env = process.env,
  seedTimeoutMs = DEFAULT_SEED_TIMEOUT_MS,
} = {}) {
  if (live && (!command || !args)) {
    throw createCodedError(
      "probe_misconfigured",
      "live shared-home probe requires command and args for the bundled Codex binary",
    );
  }

  const home = resolveTriangleCodexHome({
    override: codexHome,
    home: env.HOME,
    allowCreate: true,
  });

  const userCodex = path.join(env.HOME ?? "", ".codex");
  if (home === userCodex || home.startsWith(`${userCodex}/`)) {
    throw createCodedError(
      "codex_home_user_fallback_forbidden",
      "shared-home probe refused user ~/.codex fallback",
    );
  }

  // Live-like fake: resume before first turn fails with no rollout found.
  // Shared store simulates durable CODEX_HOME rollouts across fake process restarts.
  const materializedStorePath = path.join(home, ".triangle-probe-materialized-threads");
  const fakeA = createFake({
    serverIdentity: "fake-shared-home-a",
    idPrefix: "slotA",
    requireMaterializedRollout: true,
    materializedStorePath,
  });
  const fakeB = createFake({
    serverIdentity: "fake-shared-home-b",
    idPrefix: "slotB",
    requireMaterializedRollout: true,
    materializedStorePath,
  });

  const slotA = createProcess({
    command: live ? command : fakeA.command,
    args: live ? args : fakeA.args,
    codexHome: home,
    env,
  });
  const slotB = createProcess({
    command: live ? command : fakeB.command,
    args: live ? args : fakeB.args,
    codexHome: home,
    env,
  });

  const report = {
    status: "failed",
    codexHome: home,
    live,
    startedAt: new Date().toISOString(),
    threads: [],
    seedTurnIds: [],
    error: null,
  };

  try {
    await slotA.start();
    await slotB.start();
    await slotA.initialize({ name: "triangle-probe-a", version: "0.1.0" });
    await slotB.initialize({ name: "triangle-probe-b", version: "0.1.0" });

    // Concurrent materialization on one dedicated home (distinct threads).
    const [materializedA, materializedB] = await Promise.all([
      startMaterializedThread(slotA, { cwd: home, seedTimeoutMs }),
      startMaterializedThread(slotB, { cwd: home, seedTimeoutMs }),
    ]);

    const threadA = materializedA.threadId;
    const threadB = materializedB.threadId;
    if (threadA === threadB) {
      throw createCodedError("probe_thread_collision", "slots minted identical thread ids");
    }

    const resumedA = await slotA.threadResume({ threadId: threadA });
    const resumedB = await slotB.threadResume({ threadId: threadB });
    if (resumedA?.thread?.id !== threadA || resumedB?.thread?.id !== threadB) {
      throw createCodedError("probe_resume_mismatch", "thread/resume identity mismatch");
    }

    // Forced restart of slot A, then resume on a replacement process.
    await slotA.close({ signal: "SIGKILL", timeoutMs: 2_000 });
    const slotA2 = createProcess({
      command: live ? command : fakeA.command,
      args: live ? args : fakeA.args,
      codexHome: home,
      env,
    });
    await slotA2.start();
    await slotA2.initialize({ name: "triangle-probe-a-restart", version: "0.1.0" });
    const afterRestart = await slotA2.threadResume({ threadId: threadA });
    if (afterRestart?.thread?.id !== threadA) {
      throw createCodedError(
        "probe_restart_resume_failed",
        "forced restart could not resume distinct thread",
      );
    }
    await slotA2.close();
    await slotB.close();

    report.status = live ? "passed" : "synthetic-passed";
    report.threads = [threadA, threadB];
    report.seedTurnIds = [materializedA.seedTurnId, materializedB.seedTurnId];
    report.finishedAt = new Date().toISOString();
    report.note = live
      ? "Live dual App Server shared-home probe passed (seed turns materialized rollouts before resume)."
      : "Synthetic live-like fake probe passed unit gates only; Mini Darwin live Codex login still required before status=passed.";
    return Object.freeze(report);
  } catch (error) {
    report.status = "failed";
    report.error = {
      code: error?.code ?? "probe_failed",
      message: typeof error?.message === "string" ? error.message : "probe failed",
    };
    report.finishedAt = new Date().toISOString();
    try {
      await slotA.close({ signal: "SIGKILL", timeoutMs: 1_000 });
    } catch {
      // ignore
    }
    try {
      await slotB.close({ signal: "SIGKILL", timeoutMs: 1_000 });
    } catch {
      // ignore
    }
    // Never suggest ~/.codex as a recovery path.
    report.recovery = Object.freeze({
      fallbackToUserCodexHome: false,
      action: "fix dedicated TRIANGLE_CODEX_HOME and re-run probe on Mini",
    });
    return Object.freeze(report);
  }
}

/**
 * Write a probe result artifact under a temp or provided directory.
 * Does not mutate the immutable runtime manifest (Mini promotes status).
 */
export function writeProbeReport(report, { directory = null } = {}) {
  const root =
    directory ??
    mkdtempSync(path.join(tmpdir(), "triangle-codex-shared-home-probe-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "shared-home-concurrency-probe.json");
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function cleanupProbeDirectory(directory) {
  rmSync(directory, { recursive: true, force: true });
}

export { startMaterializedThread, PROBE_SEED_TEXT, DEFAULT_SEED_TIMEOUT_MS };
