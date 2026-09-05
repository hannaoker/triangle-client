/**
 * Node boundary for MESH held-poll via the signed macOS helper CLI.
 *
 * Production wake clients must not hold `mesh_watch_` secrets. They invoke:
 *   triangle-mailbox watch-poll --installation <id> --cursor <n>
 * which reads the Keychain-backed grant and returns secret-free JSON.
 */

import { spawn } from "node:child_process";

function positiveInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function createResyncError(restartCursor) {
  const error = new Error("watch cursor requires resync");
  error.code = "resync_required";
  error.restartCursor = restartCursor;
  return error;
}

function createHelperUnavailableError(message = "watch helper is unavailable") {
  const error = new Error(message);
  error.code = "helper_unavailable";
  return error;
}

/**
 * @param {object} options
 * @param {string} options.helperPath Absolute path to triangle-mailbox
 * @param {string} options.installationId Installation-scoped grant id (`inst_…`)
 * @param {(file: string, args: string[], options: object) => Promise<{stdout: string, stderr: string, code: number|null}>} [options.run]
 * @param {number} [options.timeoutMs]
 */
export function createHelperWatchTransport({
  helperPath,
  installationId,
  run = runHelper,
  timeoutMs = 35_000,
} = {}) {
  if (typeof helperPath !== "string" || helperPath.length === 0) {
    throw new TypeError("helperPath is required");
  }
  if (typeof installationId !== "string" || !/^inst_[A-Za-z0-9_-]{10,75}$/.test(installationId)) {
    throw new TypeError("installationId is invalid");
  }
  positiveInteger(timeoutMs, "timeoutMs", 1);

  return Object.freeze({
    async poll({ cursor, signal } = {}) {
      const supplied = positiveInteger(cursor ?? 0, "cursor", 0);
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      const result = await run(
        helperPath,
        ["watch-poll", "--installation", installationId, "--cursor", String(supplied)],
        { timeoutMs, signal },
      );
      const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
      if (result.code === 3) {
        let payload;
        try {
          payload = JSON.parse(stdout);
        } catch {
          throw createHelperUnavailableError("watch helper returned unreadable resync payload");
        }
        if (payload?.error === "resync_required" && Number.isSafeInteger(payload.restart_cursor)) {
          throw createResyncError(payload.restart_cursor);
        }
        throw createHelperUnavailableError("watch helper returned invalid resync payload");
      }
      if (result.code !== 0) {
        throw createHelperUnavailableError("watch helper poll failed");
      }
      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {
        throw createHelperUnavailableError("watch helper returned unreadable poll payload");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw createHelperUnavailableError("watch helper poll payload is invalid");
      }
      if (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0) {
        throw createHelperUnavailableError("watch helper poll cursor is invalid");
      }
      if (!Array.isArray(payload.events)) {
        throw createHelperUnavailableError("watch helper poll events are invalid");
      }
      return {
        cursor: payload.cursor,
        events: payload.events,
      };
    },
  });
}

/**
 * Fake/mock transport for Node tests that mirrors helper poll JSON without Keychain.
 * Never accepts real `mesh_watch_` credentials in production paths.
 */
export function createFakeWatchTransport({
  polls = [],
} = {}) {
  if (!Array.isArray(polls)) throw new TypeError("polls must be an array");
  let index = 0;
  return Object.freeze({
    async poll({ cursor, signal } = {}) {
      positiveInteger(cursor ?? 0, "cursor", 0);
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      if (index >= polls.length) {
        throw createHelperUnavailableError("fake watch transport exhausted");
      }
      const next = polls[index];
      index += 1;
      if (typeof next === "function") return next({ cursor, signal });
      if (next?.error === "resync_required") {
        throw createResyncError(next.restart_cursor ?? next.restartCursor);
      }
      return next;
    },
  });
}

function runHelper(file, args, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(createHelperUnavailableError("watch helper timed out"));
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

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) {
        child.kill("SIGTERM");
        finish(createHelperUnavailableError("watch helper stdout exceeded limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 16 * 1024) {
        child.kill("SIGTERM");
        finish(createHelperUnavailableError("watch helper stderr exceeded limit"));
      }
    });
    child.on("error", () => finish(createHelperUnavailableError("watch helper failed to start")));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      // Never return stderr text to callers; it may contain diagnostics.
      void stderr;
      finish(null, { stdout, stderr: "", code });
    });
  });
}
