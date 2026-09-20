/**
 * Dual App Server shared-home concurrency probe.
 *
 * Phase 0 scaffolds the probe and records unproved status. Live proof requires
 * Mini Darwin + authenticated dedicated CODEX_HOME. Until status === "passed",
 * pool size stays 1 and desktop handoff stays disabled.
 *
 * A failed probe must never fall back to ~/.codex.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createCodexAppServerProcess,
  createFakeAppServerStdioProgram,
} from "./app-server-process.mjs";
import { resolveTriangleCodexHome } from "./runtime-home.mjs";

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Run two App Server children against the same dedicated CODEX_HOME.
 * Uses the fake stdio server by default (unit-testable). Pass `live: true`
 * plus a real `command`/`args` on Mini Darwin.
 */
export async function runSharedHomeConcurrencyProbe({
  codexHome,
  live = false,
  command = null,
  args = null,
  createProcess = createCodexAppServerProcess,
  createFake = createFakeAppServerStdioProgram,
  env = process.env,
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

  const fakeA = createFake({ serverIdentity: "fake-shared-home-a", idPrefix: "slotA" });
  const fakeB = createFake({ serverIdentity: "fake-shared-home-b", idPrefix: "slotB" });

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
    error: null,
  };

  try {
    await slotA.start();
    await slotB.start();
    await slotA.initialize({ name: "triangle-probe-a", version: "0.1.0" });
    await slotB.initialize({ name: "triangle-probe-b", version: "0.1.0" });

    const startedA = await slotA.threadStart({
      cwd: home,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
    });
    const startedB = await slotB.threadStart({
      cwd: home,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
    });

    const threadA = startedA?.thread?.id;
    const threadB = startedB?.thread?.id;
    if (typeof threadA !== "string" || typeof threadB !== "string") {
      throw createCodedError("probe_thread_start_failed", "thread/start did not return ids");
    }
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
    report.finishedAt = new Date().toISOString();
    report.note = live
      ? "Live dual App Server shared-home probe passed."
      : "Synthetic fake-server probe passed unit gates only; Mini Darwin live Codex login still required before status=passed.";
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
