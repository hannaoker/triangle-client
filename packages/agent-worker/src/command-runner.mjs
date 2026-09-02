import { spawn } from "node:child_process";

const MAX_IO_BYTES = 1024 * 1024;
const ABORT_GRACE_MS = 100;
const RUNNER_ENV_KEYS = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "SYSTEMROOT", "SystemRoot",
  "COMSPEC", "ComSpec", "PATHEXT", "TERM", "COLORTERM", "NO_COLOR",
  "TRIANGLE_PROJECT_ROOT", "TRIANGLE_CREDENTIAL_ROOT", "TRIANGLE_MODEL_STATE_BASE", "TRIANGLE_MODEL_ROOTS", "TRIANGLE_RUNTIME_ROOTS", "TRIANGLE_WRITABLE_RUNTIME_ROOTS",
  "TRIANGLE_INSTANCE_ID", "TRIANGLE_INSTANCE_TEMP_ROOT",
  "TRIANGLE_CAPTURE_PATH", "TRIANGLE_EXPECTED_HASH",
  "TRIANGLE_EXPECTED_MARKER",
];
const ADAPTER_ENV_KEYS = {
  codex: ["CODEX_CLI", "CODEX_HOME"],
  hermes: ["HERMES_CLI", "HERMES_HOME"],
  antigravity: ["ANTIGRAVITY_CLI", "ANTIGRAVITY_HOME"],
};

export function createRunnerEnvironment(source = process.env) {
  const configuredAdapters = Object.entries(ADAPTER_ENV_KEYS).filter(([, keys]) =>
    keys.some((name) => typeof source[name] === "string"));
  if (configuredAdapters.length > 1) {
    throw new Error("Runner environment must configure a single active adapter without inactive CLI or home variables");
  }
  const activeKeys = configuredAdapters[0]?.[1] || [];
  return Object.fromEntries(
    [...RUNNER_ENV_KEYS, ...activeKeys].flatMap((name) =>
      typeof source[name] === "string" ? [[name, source[name]]] : []),
  );
}

function killTree(child, signal) {
  if (process.platform === "win32") return child.kill(signal);
  try { process.kill(-child.pid, signal); return true; } catch { return child.kill(signal); }
}

function runnerAbortError() {
  const error = new Error("Runner aborted");
  error.name = "AbortError";
  return error;
}

function collect(stream, name, child) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_IO_BYTES) {
        killTree(child, "SIGKILL");
        reject(new Error(`Runner ${name} exceeds ${MAX_IO_BYTES} bytes`));
        return;
      }
      chunks.push(bytes);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

function writeInput(stream, input, child) {
  let cleanup = () => {};
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Runner input failed"));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.on("error", fail);
    cleanup = () => stream.removeListener("error", fail);
    try {
      stream.end(input, (error) => {
        if (error) fail();
        else succeed();
      });
    } catch {
      fail();
    }
  });
  return { promise, cleanup: () => cleanup() };
}

function validateResult(text) {
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Runner returned invalid JSON");
  }
  if (
    !result ||
    result.status !== "completed" ||
    typeof result.text !== "string" ||
    !result.text.trim()
  ) {
    throw new Error("Runner returned an invalid completed result");
  }
  return { status: "completed", text: result.text.trim() };
}

export function createCommandRunner({
  command,
  args = [],
  timeoutMs = 600_000,
  environment = process.env,
}) {
  if (typeof command !== "string" || !command) {
    throw new TypeError("command is required");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  const childEnvironment = createRunnerEnvironment(environment);

  return {
    async run(request, { signal } = {}) {
      if (signal?.aborted) throw runnerAbortError();
      const input = `${JSON.stringify(request)}\n`;
      if (Buffer.byteLength(input) > MAX_IO_BYTES) {
        throw new Error("Runner input is too large");
      }
      const child = spawn(command, args, {
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnvironment,
      });
      const stdout = collect(child.stdout, "stdout", child);
      const stderr = collect(child.stderr, "stderr", child);

      let timer;
      let abortKillTimer;
      let exited = false;
      let aborted = false;
      let timedOut = false;
      const exit = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, exitSignal) => {
          exited = true;
          resolve({ code, signal: exitSignal });
        });
        timer = setTimeout(() => {
          timedOut = true;
          killTree(child, "SIGKILL");
        }, timeoutMs);
        timer.unref?.();
      });
      const onAbort = () => {
        if (exited || aborted) return;
        aborted = true;
        killTree(child, "SIGTERM");
        abortKillTimer = setTimeout(() => {
          if (!exited) killTree(child, "SIGKILL");
        }, ABORT_GRACE_MS);
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const stdin = writeInput(child.stdin, input, child);

      try {
        const [exitResult, stdoutResult, stderrResult, stdinResult] = await Promise.allSettled([
          exit,
          stdout,
          stderr,
          stdin.promise,
        ]);
        if (aborted) {
          await new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS));
          killTree(child, "SIGKILL");
          throw runnerAbortError();
        }
        if (timedOut) {
          throw new Error(`Runner timed out after ${timeoutMs}ms`);
        }
        if (stdinResult.status === "rejected") throw stdinResult.reason;
        if (exitResult.status === "rejected") throw exitResult.reason;
        if (stdoutResult.status === "rejected") throw stdoutResult.reason;
        if (stderrResult.status === "rejected") throw stderrResult.reason;
        const { code, signal } = exitResult.value;
        const output = stdoutResult.value;
        const errorOutput = stderrResult.value;
        if (code !== 0) {
          throw new Error(
            `Runner exited with ${signal ?? code}${errorOutput ? `: ${errorOutput.slice(0, 300)}` : ""}`,
          );
        }
        return validateResult(output);
      } finally {
        clearTimeout(timer);
        clearTimeout(abortKillTimer);
        stdin.cleanup();
        signal?.removeEventListener?.("abort", onAbort);
      }
    },
  };
}
