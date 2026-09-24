/**
 * CursorAcpProcess — one supervised `agent acp` child over stdio NDJSON.
 *
 * Phase 0 Mini proved initialize/auth/session/new|load/prompt/cancel plus
 * unattended answers for request_permission and blocking cursor/*.
 * Unit tests inject createFakeAcpStdioProgram — no live Cursor required.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  ACP_AUTH_METHOD_CURSOR_LOGIN,
  assertAcpMode,
  assertNoSecretMaterial,
  classifyJsonRpcMessage,
  createRequestIdFactory,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeNdjsonLine,
  extractAcpAssistantText,
  parseNdjsonLine,
} from "./acp-protocol.mjs";
import {
  buildSanitizedCursorChildEnv,
  resolveTriangleCursorHome,
} from "./runtime-home.mjs";
import { createUnattendedAcpPolicy } from "./unattended-policy.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
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
 * Fake stdio ACP agent for unit tests.
 *
 * Supports initialize, authenticate, session/new, session/load,
 * session/set_config_option, session/prompt, session/cancel, plus optional
 * emission of request_permission / cursor/* so unattended policy is exercised.
 */
export function createFakeAcpStdioProgram({
  serverIdentity = "fake-cursor-acp",
  protocolVersion = 1,
  idPrefix = null,
  assistantText = "fake-cursor-assistant-ok",
  emitPermission = false,
  emitCreatePlan = false,
  emitAskQuestion = false,
  durableStorePath = null,
} = {}) {
  const prefix =
    typeof idPrefix === "string" && idPrefix.length > 0
      ? idPrefix
      : `c${Math.random().toString(16).slice(2, 10)}`;
  if (
    durableStorePath != null &&
    (typeof durableStorePath !== "string" || !durableStorePath.startsWith("/"))
  ) {
    throw new TypeError("durableStorePath must be an absolute path when provided");
  }

  const source = `
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const serverIdentity = ${JSON.stringify(serverIdentity)};
const protocolVersion = ${JSON.stringify(protocolVersion)};
const idPrefix = ${JSON.stringify(prefix)};
const defaultAssistantText = ${JSON.stringify(assistantText)};
const emitPermission = ${JSON.stringify(emitPermission === true)};
const emitCreatePlan = ${JSON.stringify(emitCreatePlan === true)};
const emitAskQuestion = ${JSON.stringify(emitAskQuestion === true)};
const durableStorePath = ${JSON.stringify(durableStorePath)};
const sessions = new Map();
let counter = 0;
let authenticated = false;
let cancelled = false;

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function mintSessionId() {
  counter += 1;
  return "sess-" + idPrefix + "-" + String(counter).padStart(4, "0") + "-" + randomUUID();
}

function loadDurable() {
  if (!durableStorePath || !existsSync(durableStorePath)) return {};
  try {
    return JSON.parse(readFileSync(durableStorePath, "utf8"));
  } catch {
    return {};
  }
}

function saveDurable(store) {
  if (!durableStorePath) return;
  mkdirSync(path.dirname(durableStorePath), { recursive: true, mode: 0o700 });
  writeFileSync(durableStorePath, JSON.stringify(store), { mode: 0o600 });
}

function persistSession(session) {
  sessions.set(session.sessionId, session);
  if (!durableStorePath) return;
  const store = loadDurable();
  store[session.sessionId] = {
    sessionId: session.sessionId,
    cwd: session.cwd,
    mode: session.mode,
    model: session.model,
    history: session.history,
  };
  saveDurable(store);
}

function restoreSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const store = loadDurable();
  const raw = store[sessionId];
  if (!raw) return null;
  const session = {
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    mode: raw.mode ?? "ask",
    model: raw.model ?? null,
    history: Array.isArray(raw.history) ? raw.history : [],
  };
  sessions.set(sessionId, session);
  return session;
}

const pendingServer = new Map();

function requestAndWait(method, params) {
  const id = "srv-" + randomUUID();
  return new Promise((resolve) => {
    pendingServer.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.method && message.id === undefined) {
    if (message.method === "session/cancel") {
      cancelled = true;
    }
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingServer.get(message.id);
    if (resolve) {
      pendingServer.delete(message.id);
      resolve(message.result ?? null);
    }
    return;
  }
  if (!message.method || message.id === undefined) return;
  const { id, method, params = {} } = message;
  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true, sse: true },
            promptCapabilities: { audio: false, embeddedContext: false, image: true },
            sessionCapabilities: { list: {} },
          },
          authMethods: [{
            id: "cursor_login",
            name: "Cursor Login",
            description: "Authenticate using existing Cursor login credentials.",
          }],
          agentInfo: { name: serverIdentity, version: "0.0.0-fake" },
        };
        break;
      case "authenticate":
        if (params.methodId !== "cursor_login") {
          write({ jsonrpc: "2.0", id, error: { code: -32000, message: "unsupported auth method" } });
          return;
        }
        authenticated = true;
        result = {};
        break;
      case "session/new": {
        if (!authenticated) {
          write({ jsonrpc: "2.0", id, error: { code: -32000, message: "not authenticated" } });
          return;
        }
        const sessionId = mintSessionId();
        const session = {
          sessionId,
          cwd: params.cwd ?? process.cwd(),
          mode: "ask",
          model: null,
          history: [],
        };
        persistSession(session);
        result = {
          sessionId,
          configOptions: [
            {
              id: "mode",
              name: "Mode",
              category: "mode",
              type: "select",
              currentValue: "ask",
              options: [
                { value: "ask", name: "Ask" },
                { value: "agent", name: "Agent" },
                { value: "plan", name: "Plan" },
              ],
            },
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: null,
              options: [
                { value: "composer-2.5[fast=true]", name: "Composer 2.5 Fast" },
              ],
            },
          ],
        };
        break;
      }
      case "session/load": {
        const session = restoreSession(params.sessionId);
        if (!session) {
          write({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "session not found: " + String(params.sessionId ?? "") },
          });
          return;
        }
        for (const entry of session.history) {
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: entry },
              },
            },
          });
        }
        result = {
          sessionId: session.sessionId,
          configOptions: [
            {
              id: "mode",
              currentValue: session.mode,
              type: "select",
              options: [
                { value: "ask", name: "Ask" },
                { value: "agent", name: "Agent" },
                { value: "plan", name: "Plan" },
              ],
            },
          ],
        };
        break;
      }
      case "session/set_config_option": {
        const session = sessions.get(params.sessionId) ?? restoreSession(params.sessionId);
        if (!session) {
          write({ jsonrpc: "2.0", id, error: { code: -32000, message: "session not found" } });
          return;
        }
        if (params.configId === "mode") {
          session.mode = params.value;
        } else if (params.configId === "model") {
          session.model = params.value;
        }
        persistSession(session);
        result = { currentValue: params.value };
        break;
      }
      case "session/prompt": {
        cancelled = false;
        const session = sessions.get(params.sessionId) ?? restoreSession(params.sessionId);
        if (!session) {
          write({ jsonrpc: "2.0", id, error: { code: -32000, message: "session not found" } });
          return;
        }
        const promptParts = Array.isArray(params.prompt) ? params.prompt : [];
        const inbound = promptParts
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .join("")
          .trim();

        if (emitPermission) {
          await requestAndWait("session/request_permission", {
            sessionId: session.sessionId,
            toolCall: { toolCallId: "tool_fake_perm", title: "echo" },
            options: [
              { optionId: "allow-once", name: "Allow once" },
              { optionId: "allow-always", name: "Allow always" },
              { optionId: "reject-once", name: "Reject" },
            ],
          });
        }
        if (emitAskQuestion) {
          await requestAndWait("cursor/ask_question", {
            toolCallId: "tool_fake_ask",
            title: "Choose",
            questions: [{ id: "q1", prompt: "pick one" }],
          });
        }
        if (emitCreatePlan) {
          await requestAndWait("cursor/create_plan", {
            toolCallId: "tool_fake_plan",
            name: "fake-plan",
            overview: "test",
            plan: "# Fake\\n",
            todos: [],
          });
        }

        if (cancelled) {
          result = { stopReason: "cancelled" };
          break;
        }

        const reply = defaultAssistantText + (inbound ? " :: " + inbound : "");
        session.history.push(reply);
        persistSession(session);
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: reply },
            },
          },
        });
        result = { stopReason: "end_turn" };
        break;
      }
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
// Do not await handle serially: session/prompt may wait on client answers to
// server requests that arrive on the same stdin stream.
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  Promise.resolve(handle(message)).catch((error) => {
    process.stderr.write(String(error?.message ?? error) + "\\n");
  });
});
rl.on("close", () => {
  process.exit(0);
});
process.stdin.on("end", () => {
  process.exit(0);
});
`;

  return Object.freeze({
    command: process.execPath,
    args: ["--input-type=module", "-e", source],
    serverIdentity,
    durableStorePath,
    emitPermission: emitPermission === true,
    emitCreatePlan: emitCreatePlan === true,
    emitAskQuestion: emitAskQuestion === true,
  });
}

/**
 * Create a supervised Cursor ACP process owner.
 *
 * `command`/`args` default to `agent acp` but tests inject the fake.
 * Cursor home is supplied only via sanitized child env — never argv.
 */
export function createCursorAcpProcess({
  command = "agent",
  args = ["acp"],
  cursorHome,
  env = process.env,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
  unattendedPolicy = createUnattendedAcpPolicy(),
  spawnImpl = spawn,
  now = () => Date.now(),
  clientInfo = { name: "triangle-cursor-acp", version: "0.1.0" },
} = {}) {
  positiveInteger(requestTimeoutMs, "requestTimeoutMs");
  positiveInteger(promptTimeoutMs, "promptTimeoutMs");
  const resolvedHome = resolveTriangleCursorHome({
    override: cursorHome,
    home: env.HOME,
    allowCreate: true,
  });
  assertNoSecretMaterial(command, "command");
  assertNoSecretMaterial(args, "args");
  assertNoSecretMaterial(resolvedHome, "cursorHome");

  const nextId = createRequestIdFactory(1);
  const pending = new Map();
  const listeners = new Set();
  let child = null;
  let readline = null;
  let initialized = false;
  let authenticated = false;
  let closing = false;
  let childExited = false;
  let stderrBytes = 0;
  let lastStderr = "";
  let agentCapabilities = null;
  let authMethods = null;

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

  function writeMessage(message) {
    if (!child?.stdin || child.killed) {
      throw createCodedError("not_connected", "ACP child is not connected");
    }
    child.stdin.write(encodeNdjsonLine(message));
  }

  function respondToServerRequest(id, result) {
    writeMessage({ jsonrpc: "2.0", id, result });
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
    if (kind === "request") {
      emitEvent({
        type: "server_request",
        method: message.method,
        params: message.params ?? {},
        id: message.id,
      });
      const answered = unattendedPolicy.answer(message.method, message.params ?? {});
      if (answered == null) {
        respondToServerRequest(message.id, {
          outcome: { outcome: "cancelled", reason: "triangle-unattended-unsupported" },
        });
        return;
      }
      respondToServerRequest(message.id, answered.result);
      return;
    }
    if (kind === "notification") {
      emitEvent({
        type: "message",
        method: message.method,
        params: message.params ?? {},
      });
    }
  }

  async function start() {
    if (child) throw createCodedError("already_started", "ACP process already started");
    const childEnv = buildSanitizedCursorChildEnv({
      cursorHome: resolvedHome,
      parentEnv: env,
    });
    childExited = false;
    child = spawnImpl(command, args, {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    child.on("error", (error) => {
      failPending(createCodedError("spawn_failed", error.message, { cause: error }));
    });
    child.on("exit", (code, signal) => {
      childExited = true;
      const error = createCodedError("child_exited", "ACP child exited", { code, signal });
      failPending(error);
      initialized = false;
      authenticated = false;
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
    return Object.freeze({ pid: child.pid ?? null, cursorHome: resolvedHome });
  }

  function call(method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
    if (!child) {
      return Promise.reject(createCodedError("not_connected", "ACP child is not started"));
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

  async function initialize() {
    const result = await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo,
    });
    initialized = true;
    agentCapabilities = result?.agentCapabilities ?? null;
    authMethods = Array.isArray(result?.authMethods) ? result.authMethods : [];
    return result;
  }

  async function authenticate(methodId = ACP_AUTH_METHOD_CURSOR_LOGIN) {
    const result = await call("authenticate", { methodId });
    authenticated = true;
    return result;
  }

  async function ensureReady() {
    if (!child) await start();
    if (!initialized) await initialize();
    if (!authenticated) await authenticate();
  }

  async function sessionNew({ cwd = resolvedHome, mcpServers = [] } = {}) {
    await ensureReady();
    if (!Array.isArray(mcpServers)) {
      throw new TypeError("mcpServers must be an array");
    }
    return call("session/new", { cwd, mcpServers });
  }

  async function sessionLoad({ sessionId, cwd = resolvedHome, mcpServers = [] } = {}) {
    await ensureReady();
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId is required");
    }
    if (!Array.isArray(mcpServers)) {
      throw new TypeError("mcpServers must be an array");
    }
    return call("session/load", { sessionId, cwd, mcpServers });
  }

  async function setConfigOption({ sessionId, configId, value }) {
    await ensureReady();
    return call("session/set_config_option", { sessionId, configId, value });
  }

  async function setMode({ sessionId, mode }) {
    return setConfigOption({ sessionId, configId: "mode", value: assertAcpMode(mode) });
  }

  async function setModel({ sessionId, model }) {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError("model is required");
    }
    return setConfigOption({ sessionId, configId: "model", value: model });
  }

  /**
   * Run one prompt turn. Accumulates session/update chunks until the prompt
   * RPC returns (stopReason). Unattended policy answers blocking callbacks.
   */
  async function sessionPrompt({ sessionId, text, timeoutMs = promptTimeoutMs } = {}) {
    await ensureReady();
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId is required");
    }
    if (typeof text !== "string") {
      throw new TypeError("text must be a string");
    }
    assertNoSecretMaterial(text, "prompt text");

    const updates = [];
    const unsubscribe = onEvent((event) => {
      if (event?.type !== "message" || event?.method !== "session/update") return;
      if (event?.params?.sessionId != null && event.params.sessionId !== sessionId) return;
      updates.push(event.params?.update ?? event.params);
    });

    try {
      const result = await call(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text }],
        },
        { timeoutMs },
      );
      const assistantText = extractAcpAssistantText(updates, result);
      return Object.freeze({
        stopReason: result?.stopReason ?? null,
        result,
        updates: Object.freeze([...updates]),
        assistantText,
      });
    } finally {
      unsubscribe();
    }
  }

  async function sessionCancel({ sessionId } = {}) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("sessionId is required");
    }
    await notify("session/cancel", { sessionId });
  }

  async function close({ signal = "SIGTERM", timeoutMs = 5_000 } = {}) {
    if (closing) return;
    closing = true;
    failPending(createCodedError("closing", "ACP process is closing"));
    try {
      readline?.close();
    } catch {
      // ignore
    }
    if (!child) return;
    const current = child;
    if (childExited) {
      child = null;
      initialized = false;
      authenticated = false;
      return;
    }
    const exited = new Promise((resolve) => {
      if (childExited || current.exitCode != null || current.signalCode != null) {
        resolve();
        return;
      }
      current.once("exit", () => resolve());
    });
    try {
      current.stdin?.end();
    } catch {
      // ignore
    }
    try {
      current.kill(signal);
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      try {
        current.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);
    const waitFallback = new Promise((resolve) => {
      const fallbackTimer = setTimeout(resolve, timeoutMs + 100);
      fallbackTimer.unref?.();
    });
    await Promise.race([exited, waitFallback]);
    clearTimeout(timer);
    child = null;
    initialized = false;
    authenticated = false;
  }

  function onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function status() {
    return Object.freeze({
      started: child != null,
      initialized,
      authenticated,
      cursorHome: resolvedHome,
      agentCapabilities,
      authMethods,
      stderrBytes,
      lastStderr,
      pid: child?.pid ?? null,
    });
  }

  return Object.freeze({
    start,
    initialize,
    authenticate,
    ensureReady,
    sessionNew,
    sessionLoad,
    setConfigOption,
    setMode,
    setModel,
    sessionPrompt,
    sessionCancel,
    call,
    notify,
    close,
    onEvent,
    status,
  });
}
