/**
 * Node boundary for MESH held-poll via the signed macOS helper CLI.
 *
 * Production wake clients must not hold `mesh_watch_` secrets. They invoke:
 *   triangle-mailbox watch-poll --installation <id> --cursor <n>
 * which reads the Keychain-backed grant and returns secret-free JSON.
 *
 * Before long-poll, production paths call:
 *   triangle-mailbox watch-ensure --installation <id> --actor-profile <profile>
 * so the held poll has a Keychain credential (fail closed otherwise).
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

function createHelperUnavailableError(message = "watch helper is unavailable", diagnosis = null) {
  const rejectedCode = typeof diagnosis?.rejectedCode === "string" ? diagnosis.rejectedCode : null;
  const failureCode = typeof diagnosis?.code === "string" ? diagnosis.code : null;
  const suffix = rejectedCode || failureCode;
  const error = new Error(suffix ? `${message} (${suffix})` : message);
  error.code = "helper_unavailable";
  if (diagnosis && typeof diagnosis === "object") {
    error.diagnosis = diagnosis;
    if (failureCode) error.failureCode = failureCode;
    if (rejectedCode) error.rejectedCode = rejectedCode;
    if (Number.isSafeInteger(diagnosis.rejectedStatusCode)) {
      error.httpStatus = diagnosis.rejectedStatusCode;
      error.status = diagnosis.rejectedStatusCode;
    }
    if (typeof diagnosis.gate === "string") error.gate = diagnosis.gate;
    if (typeof diagnosis.operatorAction === "string") error.operatorAction = diagnosis.operatorAction;
  }
  return error;
}

function createAbortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function settleWithSignal(promise, signal) {
  if (signal?.aborted) throw createAbortError();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function parseWatchFailureDiagnosis(stderr) {
  if (typeof stderr !== "string" || stderr.trim().length === 0) return null;
  try {
    const payload = JSON.parse(stderr.trim().split("\n").at(-1));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    if (payload.status !== "watch_operation_failed") return null;
    if (typeof payload.code !== "string" || typeof payload.gate !== "string") return null;
    return {
      status: payload.status,
      code: payload.code,
      gate: payload.gate,
      operatorAction: typeof payload.operatorAction === "string" ? payload.operatorAction : undefined,
      safeToRetry: payload.safeToRetry === true,
      detail: typeof payload.detail === "string" ? payload.detail : undefined,
      rejectedCode: typeof payload.rejectedCode === "string" ? payload.rejectedCode : undefined,
      rejectedStatusCode: Number.isSafeInteger(payload.rejectedStatusCode)
        ? payload.rejectedStatusCode
        : undefined,
    };
  } catch {
    return null;
  }
}

function assertInstallationId(installationId) {
  if (typeof installationId !== "string" || !/^inst_[A-Za-z0-9_-]{10,75}$/.test(installationId)) {
    throw new TypeError("installationId is invalid");
  }
  return installationId;
}

function isStaleWatchCredentialDiagnosis(diagnosis) {
  if (!diagnosis || typeof diagnosis !== "object") return false;
  const rejected = diagnosis.rejectedCode;
  return rejected === "replacement_unauthorized" || rejected === "watch_credential_invalid";
}

function isCredentialBusyDiagnosis(diagnosis) {
  if (!diagnosis || typeof diagnosis !== "object") return false;
  return diagnosis.code === "credential_busy" || diagnosis.code === "enroll_lock_busy";
}

function sleepMs(ms, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Cheap local-credential probe. Held poll may block when the secret is valid;
 * treat helper timeout as "accepted & held" (usable). Immediate 401-style
 * rejection means the on-disk credential is dead even if watch-status looks ready.
 */
async function probeLocalWatchCredential({
  helperPath,
  installationId,
  run,
  timeoutMs = 5_000,
  signal,
} = {}) {
  try {
    const result = await run(
      helperPath,
      ["watch-poll", "--installation", installationId, "--cursor", "0"],
      { timeoutMs, signal },
    );
    if (result.code === 0 || result.code === 3) {
      return { usable: true };
    }
    const diagnosis = parseWatchFailureDiagnosis(result.stderr);
    return { usable: false, diagnosis };
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && error.code === "helper_unavailable"
      && typeof error.message === "string"
      && /timed out/i.test(error.message)
    ) {
      // Server accepted the credential and held the poll until our probe timeout.
      return { usable: true, held: true };
    }
    throw error;
  }
}

/**
 * @param {object} options
 * @param {string} options.helperPath Absolute path to triangle-mailbox
 * @param {string} options.installationId Installation-scoped grant id (`inst_…`)
 * @param {string} options.actorProfile Event-driven actor profile for ensure
 * @param {(file: string, args: string[], options: object) => Promise<{stdout: string, stderr: string, code: number|null}>} [options.run]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.busyRetryLimit] Retries when helper reports credential_busy
 */
export async function ensureHelperWatchGrant({
  helperPath,
  installationId,
  actorProfile,
  run = runHelper,
  timeoutMs = 60_000,
  signal,
  busyRetryLimit = 5,
} = {}) {
  if (typeof helperPath !== "string" || helperPath.length === 0) {
    throw new TypeError("helperPath is required");
  }
  assertInstallationId(installationId);
  if (typeof actorProfile !== "string" || actorProfile.length === 0 || actorProfile.includes("\0")) {
    throw new TypeError("actorProfile is invalid");
  }
  positiveInteger(timeoutMs, "timeoutMs", 1);
  positiveInteger(busyRetryLimit, "busyRetryLimit", 1);
  if (signal?.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }

  let diagnosis = null;
  for (let attempt = 1; attempt <= busyRetryLimit; attempt += 1) {
    const result = await run(
      helperPath,
      ["watch-ensure", "--installation", installationId, "--actor-profile", actorProfile],
      { timeoutMs, signal },
    );
    if (result.code === 0) {
      return { ensured: true };
    }

    diagnosis = parseWatchFailureDiagnosis(result.stderr);
    if (isCredentialBusyDiagnosis(diagnosis) && attempt < busyRetryLimit) {
      await sleepMs(Math.min(50 * attempt, 250), signal);
      continue;
    }
    break;
  }

  // Current helpers keep the local binding until recreate succeeds, then replace.
  // Older helpers may still surface replacement_unauthorized while watch-status
  // looks finalized. Never treat status alone as proof the local credential can
  // poll — probe with a short watch-poll instead.
  if (isStaleWatchCredentialDiagnosis(diagnosis)) {
    const probe = await probeLocalWatchCredential({
      helperPath,
      installationId,
      run,
      timeoutMs: Math.min(timeoutMs, 5_000),
      signal,
    });
    if (probe.usable) {
      return { ensured: true, reusedExisting: true };
    }
    const failedDiagnosis = {
      ...(diagnosis || {}),
      ...(probe.diagnosis || {}),
      operatorAction:
        probe.diagnosis?.operatorAction
        || diagnosis?.operatorAction
        || "replace_watch_grant",
      detail:
        probe.diagnosis?.detail
        || diagnosis?.detail
        || "Local watch credential is invalid; re-run watch-ensure so the helper can recreate without replacement.",
    };
    throw createHelperUnavailableError("watch helper ensure failed", failedDiagnosis);
  }

  throw createHelperUnavailableError("watch helper ensure failed", diagnosis);
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
  assertInstallationId(installationId);
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
        throw createHelperUnavailableError(
          "watch helper poll failed",
          parseWatchFailureDiagnosis(result.stderr),
        );
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
 * Coalesce concurrent held polls onto one underlying transport.
 *
 * MESH admits one poll per installation. App Server + Grok Bot bridges that
 * share an installation must not each spawn `watch-poll` or the second gets
 * `poll_limit_exceeded`. This wrapper joins identical in-flight cursors and
 * serializes divergent cursors so only one helper invocation runs at a time.
 */
export function createSharedWatchTransport({ transport } = {}) {
  if (!transport || typeof transport.poll !== "function") {
    throw new TypeError("transport.poll is required");
  }

  /** @type {{ cursor: number, promise: Promise<{cursor: number, events: unknown[]}> } | null} */
  let inFlight = null;

  return Object.freeze({
    async poll({ cursor, signal } = {}) {
      const supplied = positiveInteger(cursor ?? 0, "cursor", 0);
      if (signal?.aborted) throw createAbortError();

      while (inFlight) {
        if (inFlight.cursor === supplied) {
          // Same cursor: fan the held poll out to every waiter.
          return settleWithSignal(inFlight.promise, signal);
        }
        // Behind/ahead bridges wait out the active hold, then claim a turn.
        await settleWithSignal(
          inFlight.promise.then(() => null, () => null),
          signal,
        );
      }

      let resolveTracked;
      let rejectTracked;
      const tracked = new Promise((resolve, reject) => {
        resolveTracked = resolve;
        rejectTracked = reject;
      });
      // Claim the slot synchronously so a twin poll() in this turn joins us.
      inFlight = { cursor: supplied, promise: tracked };
      try {
        const pending = transport.poll({ cursor: supplied, signal });
        Promise.resolve(pending).then(
          (value) => {
            if (inFlight?.promise === tracked) inFlight = null;
            resolveTracked(value);
          },
          (error) => {
            if (inFlight?.promise === tracked) inFlight = null;
            rejectTracked(error);
          },
        );
      } catch (error) {
        if (inFlight?.promise === tracked) inFlight = null;
        rejectTracked(error);
      }
      return settleWithSignal(tracked, signal);
    },
  });
}

/**
 * Cache shared coalescing transports by installation id so supervisor bridges
 * that reuse one MESH grant share one helper held poll.
 */
export function createInstallationWatchTransportFactory(createWatchTransport) {
  if (typeof createWatchTransport !== "function") {
    throw new TypeError("createWatchTransport is required");
  }
  const byInstallation = new Map();
  return function createInstallationWatchTransport(options = {}) {
    const installationId = assertInstallationId(options.installationId);
    const helperPath = options.helperPath;
    if (typeof helperPath !== "string" || helperPath.length === 0) {
      throw new TypeError("helperPath is required");
    }
    const existing = byInstallation.get(installationId);
    if (existing) {
      if (existing.helperPath !== helperPath) {
        throw new TypeError("shared watch transport helperPath mismatch for installation");
      }
      return existing.transport;
    }
    const underlying = createWatchTransport(options);
    if (!underlying || typeof underlying.poll !== "function") {
      throw new TypeError("createWatchTransport must return a transport");
    }
    const transport = createSharedWatchTransport({ transport: underlying });
    byInstallation.set(installationId, { helperPath, transport });
    return transport;
  };
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
        ...(process.env.TRIANGLE_FILE_CREDENTIALS
          ? { TRIANGLE_FILE_CREDENTIALS: process.env.TRIANGLE_FILE_CREDENTIALS }
          : {}),
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
      // Return secret-free watch diagnosis JSON on stderr for ensure/status callers.
      // Poll success paths ignore stderr; failure parsers only accept watch_operation_failed.
      finish(null, { stdout, stderr, code });
    });
  });
}
