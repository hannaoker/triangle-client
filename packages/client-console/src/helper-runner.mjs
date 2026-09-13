/**
 * Bounded spawn wrapper for triangle-mailbox / triangle-client.
 * Mirrors the agent-worker helper transport discipline: no ambient credentials,
 * stdout size limits, stderr discarded from return values.
 */

import { spawn } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import { assertSecretFree } from "./secrets.mjs";

const DEFAULT_STDOUT_LIMIT = 64 * 1024;
const DEFAULT_STDERR_LIMIT = 16 * 1024;

/**
 * @param {string} file Absolute executable path
 */
export async function probeHelperPresence(file) {
  if (typeof file !== "string" || file.length === 0 || !file.startsWith("/")) {
    return { present: false, executable: false, reason: "path_invalid" };
  }
  try {
    await access(file, fsConstants.F_OK);
  } catch {
    return { present: false, executable: false, reason: "missing" };
  }
  try {
    await access(file, fsConstants.X_OK);
    return { present: true, executable: true, reason: "ok" };
  } catch {
    return { present: true, executable: false, reason: "not_executable" };
  }
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeoutMs?: number, signal?: AbortSignal, stdin?: string|null, env?: NodeJS.ProcessEnv, assertFree?: boolean }} [options]
 */
export function runHelper(file, args, options = {}) {
  const {
    timeoutMs = 30_000,
    signal,
    stdin = null,
    env = process.env,
    assertFree = true,
  } = options;

  if (typeof file !== "string" || file.length === 0) {
    return Promise.reject(Object.assign(new Error("helper path required"), { code: "helper_unavailable" }));
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    return Promise.reject(Object.assign(new TypeError("args must be string[]"), { code: "invalid_args" }));
  }
  // Refuse flags that look like token handoff on argv.
  for (const arg of args) {
    if (/^mesh_(watch_)?/i.test(arg) || (/token/i.test(arg) && arg.includes("="))) {
      const error = new Error("refusing helper argv that looks like a credential channel");
      error.code = "secret_argv";
      return Promise.reject(error);
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
      env: {
        PATH: env.PATH,
        HOME: env.HOME,
        LANG: env.LANG,
        LC_ALL: env.LC_ALL,
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(Object.assign(new Error("helper timed out"), { code: "helper_timeout" }));
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }

    const onAbort = () => {
      child.kill("SIGTERM");
      const error = new Error("aborted");
      error.name = "AbortError";
      finish(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    if (stdin != null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > DEFAULT_STDOUT_LIMIT) {
        child.kill("SIGTERM");
        finish(Object.assign(new Error("helper stdout exceeded limit"), { code: "helper_stdout_limit" }));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > DEFAULT_STDERR_LIMIT) {
        child.kill("SIGTERM");
        finish(Object.assign(new Error("helper stderr exceeded limit"), { code: "helper_stderr_limit" }));
      }
    });
    child.on("error", () =>
      finish(Object.assign(new Error("helper failed to start"), { code: "helper_unavailable" })),
    );
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      void stderr; // never return stderr — may contain diagnostics
      try {
        if (assertFree) assertSecretFree(stdout, "helper stdout");
        finish(null, { stdout, stderr: "", code });
      } catch (error) {
        finish(error);
      }
    });
  });
}

/**
 * Parse one JSON object from helper stdout; fail closed on secrets / shape errors.
 * @param {string} stdout
 * @param {string} label
 */
export function parseHelperJson(stdout, label = "helper") {
  const trimmed = typeof stdout === "string" ? stdout.trim() : "";
  if (!trimmed) {
    const error = new Error(`${label} returned empty stdout`);
    error.code = "helper_empty";
    throw error;
  }
  assertSecretFree(trimmed, `${label} stdout`);
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    const error = new Error(`${label} returned unreadable JSON`);
    error.code = "helper_json";
    throw error;
  }
  if (!payload || typeof payload !== "object") {
    const error = new Error(`${label} JSON was not an object or array`);
    error.code = "helper_json_shape";
    throw error;
  }
  assertSecretFree(payload, `${label} JSON`);
  return payload;
}
