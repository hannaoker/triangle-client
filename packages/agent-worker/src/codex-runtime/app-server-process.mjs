/**
 * CodexAppServerProcess — one supervised `codex app-server` child over stdio NDJSON.
 *
 * Phase 0: unit-tested against a fake server. Does not change production
 * mcp-interactive / Shared App Server desktop profiles.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  assertNoSecretMaterial,
  classifyJsonRpcMessage,
  createRequestIdFactory,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeNdjsonLine,
  parseNdjsonLine,
} from "./app-server-protocol.mjs";
import {
  buildSanitizedCodexChildEnv,
  resolveTriangleCodexHome,
} from "./runtime-home.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 16_384;

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function positiveInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

/**
 * Fake stdio App Server for unit tests: Node child speaking NDJSON JSON-RPC.
 */
export function createFakeAppServerStdioProgram({
  serverIdentity = "fake-codex-app-server",
  version = "0.0.0-fake",
  onCall,
  idPrefix = null,
} = {}) {
  const prefix =
    typeof idPrefix === "string" && idPrefix.length > 0
      ? idPrefix
      : `f${Math.random().toString(16).slice(2, 10)}`;
  const source = `
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const serverIdentity = ${JSON.stringify(serverIdentity)};
const version = ${JSON.stringify(version)};
const idPrefix = ${JSON.stringify(prefix)};
let turnCounter = 0;
const threads = new Map();

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function emit(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

function mintId(kind) {
  turnCounter += 1;
  return kind + "-" + idPrefix + "-" + String(turnCounter).padStart(4, "0") + "-" + randomUUID();
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.method && message.id === undefined) {
    // notifications (initialized, etc.)
    return;
  }
  if (!message.method || message.id === undefined) return;
  const { id, method, params = {} } = message;
  try {
    let result;
    switch (method) {
      case "initialize":
        result = { serverInfo: { name: serverIdentity, version } };
        break;
      case "thread/start": {
        const threadId = mintId("thread");
        threads.set(threadId, { id: threadId, status: { type: "idle" }, turns: [] });
        result = { thread: { id: threadId, status: { type: "idle" } } };
        break;
      }
      case "thread/resume": {
        const threadId = params.threadId;
        if (!threads.has(threadId)) {
          threads.set(threadId, { id: threadId, status: { type: "idle" }, turns: [] });
        }
        result = { thread: { id: threadId, status: { type: "idle" } } };
        break;
      }
      case "thread/read": {
        const thread = threads.get(params.threadId) ?? {
          id: params.threadId,
          status: { type: "idle" },
          turns: [],
        };
        result = { thread };
        break;
      }
      case "turn/start": {
        const threadId = params.threadId;
        const turnId = mintId("turn");
        const clientUserMessageId = params.clientUserMessageId ?? null;
        const input = Array.isArray(params.input) ? params.input : [];
        const userItem = {
          type: "userMessage",
          id: "user_" + turnId,
          clientId: clientUserMessageId,
          content: input,
        };
        const assistantText = "fake-assistant-ok";
        const agentItem = {
          type: "agentMessage",
          id: "agent_" + turnId,
          text: assistantText,
        };
        const turn = {
          id: turnId,
          status: "completed",
          items: [userItem, agentItem],
        };
        const thread = threads.get(threadId) ?? {
          id: threadId,
          status: { type: "idle" },
          turns: [],
        };
        thread.turns = [...(thread.turns ?? []), turn];
        threads.set(threadId, thread);
        emit("turn/started", { threadId, turn: { id: turnId, status: "in_progress" } });
        result = { turn: { id: turnId, status: "in_progress" } };
        queueMicrotask(() => {
          emit("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
        });
        break;
      }
      case "turn/interrupt":
        result = {};
        break;
      default:
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found: " + method },
        });
        return;
    }
    write({ jsonrpc: "2.0", id, result });
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: String(error?.message ?? error) },
    });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  await handle(message);
}
`;
  return Object.freeze({
    command: process.execPath,
    args: ["--input-type=module", "-e", source],
    serverIdentity,
    onCall,
  });
}

/**
 * Create a CodexAppServerProcess owner.
 *
 * `command`/`args` default to `codex app-server` but tests inject the fake.
 * `codexHome` is supplied only via sanitized child env — never argv.
 */
export function createCodexAppServerProcess({
  command = "codex",
  args = ["app-server"],
  codexHome,
  env = process.env,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  spawnImpl = spawn,
  now = () => Date.now(),
} = {}) {
  positiveInteger(requestTimeoutMs, "requestTimeoutMs");
  const resolvedHome = resolveTriangleCodexHome({
    override: codexHome,
    home: env.HOME,
    allowCreate: true,
  });
  assertNoSecretMaterial(command, "command");
  assertNoSecretMaterial(args, "args");
  assertNoSecretMaterial(resolvedHome, "codexHome");

  const nextId = createRequestIdFactory(1);
  const pending = new Map();
  const listeners = new Set();
  let child = null;
  let readline = null;
  let initialized = false;
  let closing = false;
  let stderrBytes = 0;
  let lastStderr = "";
  let serverInfo = null;

  function failPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function emitEvent(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // listener isolation
      }
    }
  }

  function handleLine(line) {
    let message;
    try {
      message = parseNdjsonLine(line);
    } catch (error) {
      emitEvent({ type: "protocol_error", error });
      return;
    }
    if (message == null) return;
    const kind = classifyJsonRpcMessage(message);
    if (kind === "response" || kind === "error") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (kind === "error") {
        entry.reject(
          createCodedError("rpc_error", message.error?.message ?? "JSON-RPC error", {
            rpcCode: message.error?.code,
            data: message.error?.data,
          }),
        );
        return;
      }
      entry.resolve(message.result);
      return;
    }
    if (kind === "notification" || kind === "request") {
      emitEvent({ type: "message", method: message.method, params: message.params ?? {}, id: message.id });
    }
  }

  async function start() {
    if (child) throw createCodedError("already_started", "App Server process already started");
    const childEnv = buildSanitizedCodexChildEnv({
      codexHome: resolvedHome,
      parentEnv: env,
    });
    child = spawnImpl(command, args, {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    child.on("error", (error) => {
      failPending(createCodedError("spawn_failed", error.message, { cause: error }));
    });
    child.on("exit", (code, signal) => {
      const error = createCodedError("child_exited", "App Server child exited", { code, signal });
      failPending(error);
      initialized = false;
      emitEvent({ type: "exit", code, signal });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrBytes += Buffer.byteLength(text);
      if (lastStderr.length < MAX_STDERR_BYTES) {
        lastStderr = (lastStderr + text).slice(0, MAX_STDERR_BYTES);
      }
    });
    readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
    readline.on("line", handleLine);
    return Object.freeze({ pid: child.pid ?? null, codexHome: resolvedHome });
  }

  function writeMessage(message) {
    if (!child?.stdin || child.killed) {
      throw createCodedError("not_connected", "App Server child is not connected");
    }
    child.stdin.write(encodeNdjsonLine(message));
  }

  function call(method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
    if (!child) {
      return Promise.reject(createCodedError("not_connected", "App Server child is not started"));
    }
    const id = nextId();
    const request = encodeJsonRpcRequest(id, method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(createCodedError("request_timeout", `${method} timed out`, { outcome: "unknown" }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method, startedAt: now() });
      try {
        writeMessage(request);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  async function notify(method, params = {}) {
    writeMessage(encodeJsonRpcNotification(method, params));
  }

  async function initialize(clientInfo = { name: "triangle-codex-runtime", version: "0.1.0" }) {
    const result = await call("initialize", {
      clientInfo,
      capabilities: {},
    });
    await notify("initialized", {});
    initialized = true;
    serverInfo = result?.serverInfo ?? null;
    return result;
  }

  async function close({ signal = "SIGTERM", timeoutMs = 5_000 } = {}) {
    if (closing) return;
    closing = true;
    failPending(createCodedError("closing", "App Server process is closing"));
    try {
      readline?.close();
    } catch {
      // ignore
    }
    if (!child) return;
    const exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
    });
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    child.kill(signal);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);
    await exited;
    clearTimeout(timer);
    child = null;
    initialized = false;
  }

  function onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function status() {
    return Object.freeze({
      started: child != null,
      initialized,
      pid: child?.pid ?? null,
      codexHome: resolvedHome,
      pending: pending.size,
      serverInfo,
      stderrBytes,
      lastStderrRedacted: lastStderr.replace(/mesh_(?:watch_)?[A-Za-z0-9_-]{8,}/g, "[redacted]"),
    });
  }

  return Object.freeze({
    start,
    initialize,
    call,
    notify,
    close,
    onEvent,
    status,
    threadStart: (params) => call("thread/start", params),
    threadResume: (params) => call("thread/resume", params),
    threadRead: (params) => call("thread/read", params),
    turnStart: (params) => call("turn/start", params),
    turnInterrupt: (params) => call("turn/interrupt", params),
  });
}
