#!/usr/bin/env node
/**
 * Durable Shared Codex App Server host for production appServerWake.
 *
 * Starts/resumes a listen-mode app-server, mints or reuses a thread, writes:
 *   ~/Library/Application Support/The Triangle/client/app-server-binding.json
 *   ~/Library/Application Support/The Triangle/client/app-server-ws.token
 *   ~/Library/Application Support/The Triangle/client/app-server-wake-cursor.json
 * and keeps ChatGPT attached to that thread via CODEX_APP_SERVER_WS_URL.
 *
 * Does not attach to ChatGPT's private unix app-server.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_EXPERIMENT_DEBUG_PORT,
  assertDebugPortFree,
  buildDesktopExperimentBinding,
  createDesktopResumeProbe,
  resolveDesktopExperimentThread,
} from "../packages/agent-worker/src/native-desktop-wake-experiment.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT = path.resolve(__dirname, "..");

const CHATGPT_APP = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_APP_TOOLS =
  "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools";
const MCP_LAUNCH = `${CODEX_APP_TOOLS}/scripts/launch_codex_app_tools_mcp`;

const HOME = process.env.HOME;
const CLIENT_ROOT = path.join(HOME, "Library/Application Support/The Triangle/client");
const HOST_ROOT = path.join(HOME, "Library/Application Support/The Triangle/shared-app-server");
const BINDING_PATH = path.join(CLIENT_ROOT, "app-server-binding.json");
const TOKEN_PATH = path.join(CLIENT_ROOT, "app-server-ws.token");
const CURSOR_PATH = path.join(CLIENT_ROOT, "app-server-wake-cursor.json");
const HOLD_PATH = path.join(HOST_ROOT, "hold.pids");

const INSTALLATION_ID = process.env.MESH_INSTALLATION_ID || "inst_EaA3qkuzOuQwTSFw";
const INSTANCE_ID =
  process.env.MESH_CODEX_INSTANCE_ID ||
  "8dc26a2fc9a622dc5ed9e3560fa0533a38b8f0998e7c34108cfb1301c6aaab64";
const DEFAULT_AGENT_ID = "agent_98bba387b21046008b7836dadab3d6c2";
const DEFAULT_ROOM_ID = "room_8bc8ad0e978c43dcbf9d217dade97035";
const SERVER_IDENTITY =
  process.env.MESH_DESKTOP_SERVER_IDENTITY || "codex-app-server/desktop-experiment";

function readExistingBindingFields() {
  try {
    if (!existsSync(BINDING_PATH)) return {};
    const parsed = JSON.parse(readFileSync(BINDING_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return {
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : undefined,
      roomScope: typeof parsed.roomScope === "string" ? parsed.roomScope : undefined,
      instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : undefined,
      installationId: typeof parsed.installationId === "string" ? parsed.installationId : undefined,
    };
  } catch {
    return {};
  }
}

const existingBinding = readExistingBindingFields();
const AGENT_ID =
  process.env.MESH_CODEX_AGENT_ID || existingBinding.agentId || DEFAULT_AGENT_ID;
const ROOM_ID =
  process.env.MESH_CODEX_ROOM_ID || existingBinding.roomScope || DEFAULT_ROOM_ID;
const EFFECTIVE_INSTANCE_ID =
  process.env.MESH_CODEX_INSTANCE_ID || existingBinding.instanceId || INSTANCE_ID;
const EFFECTIVE_INSTALLATION_ID =
  process.env.MESH_INSTALLATION_ID || existingBinding.installationId || INSTALLATION_ID;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(test, data = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), test, ...data }));
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function createDesktopResumeFailure(probe, threadId) {
  const error = new Error(`Desktop resume failed for ${threadId}`);
  error.code = "desktop_experiment_desktop_resume_failed";
  error.threadId = threadId;
  error.resumeStatus = probe.status();
  return error;
}

function loadExistingBinding() {
  if (!existsSync(BINDING_PATH) || !existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BINDING_PATH, "utf8"));
  } catch {
    return null;
  }
}

mkdirSync(CLIENT_ROOT, { mode: 0o700, recursive: true });
mkdirSync(HOST_ROOT, { mode: 0o700, recursive: true });
mkdirSync(path.join(HOST_ROOT, "ui"), { mode: 0o700, recursive: true });
mkdirSync(path.join(HOST_ROOT, "workspace"), { mode: 0o700, recursive: true });

if (!existsSync(TOKEN_PATH)) {
  writeFileSync(TOKEN_PATH, `triangle-appserver-${randomBytes(12).toString("hex")}\n`, { mode: 0o600 });
  log("auth_token_created", { path: TOKEN_PATH });
}
if (!existsSync(CURSOR_PATH)) {
  // Must match createAtomicFileCursorStore shape: {"cursor":N}
  writeFileSync(CURSOR_PATH, `${JSON.stringify({ cursor: 0 })}\n`, { mode: 0o600 });
}

await assertDebugPortFree(DESKTOP_EXPERIMENT_DEBUG_PORT);

const existing = loadExistingBinding();
const preferredThreadId =
  process.env.MESH_DESKTOP_THREAD_ID?.trim() ||
  (existing?.threadId && typeof existing.threadId === "string" ? existing.threadId : null);

const listenPort = await reservePort();
const listenEndpoint = `ws://127.0.0.1:${listenPort}`;
const desktopRpcEndpoint = `${listenEndpoint}/rpc`;

const codexHome = process.env.MESH_DESKTOP_CODEX_HOME || path.join(HOME, ".codex");
const serverEnv = {
  ...process.env,
  CODEX_HOME: codexHome,
  CODEX_APP_SERVER_WS_TOKEN_FILE: TOKEN_PATH,
};
const server = spawn(
  CODEX_BIN,
  [
    "-c",
    `mcp_servers.codex_app={command=${JSON.stringify(MCP_LAUNCH)},args=["./server.mjs"],cwd=${JSON.stringify(CODEX_APP_TOOLS)},enabled=false}`,
    "app-server",
    "--listen",
    listenEndpoint,
  ],
  { cwd: HOST_ROOT, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
);

let serverReady = false;
const onData = (chunk) => {
  if (String(chunk).toLowerCase().includes("listening") || String(chunk).includes("readyz")) {
    serverReady = true;
  }
};
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", onData);
server.stderr.on("data", onData);

for (let i = 0; i < 40 && !serverReady; i += 1) {
  await sleep(250);
  try {
    const res = await fetch(`http://127.0.0.1:${listenPort}/readyz`);
    if (res.ok) serverReady = true;
  } catch {
    /* retry */
  }
}
if (!serverReady) {
  log("failure", { message: "app-server readyz timeout" });
  server.kill("SIGTERM");
  process.exit(2);
}
log("backend_ready", { pid: server.pid, listenEndpoint, desktopRpcEndpoint });

const threadResolution = await resolveDesktopExperimentThread({
  endpoint: listenEndpoint,
  serverIdentity: SERVER_IDENTITY,
  tokenFile: TOKEN_PATH,
  tokenEnv: null,
  preferredThreadId,
  cwd: path.join(HOST_ROOT, "workspace"),
  requestTimeoutMs: 45_000,
});
const threadId = threadResolution.threadId;
log("thread_resolved", {
  threadId,
  source: threadResolution.source,
  resumeVerified: threadResolution.resumeVerified === true,
});

const binding = buildDesktopExperimentBinding({
  threadId,
  endpoint: listenEndpoint,
  serverIdentity: SERVER_IDENTITY,
  installationId: EFFECTIVE_INSTALLATION_ID,
  instanceId: EFFECTIVE_INSTANCE_ID,
  agentId: AGENT_ID,
  roomScope: ROOM_ID,
});
writeFileSync(BINDING_PATH, JSON.stringify(binding, null, 2) + "\n", { mode: 0o600 });
log("binding_written", {
  bindingPath: BINDING_PATH,
  threadId,
  endpoint: listenEndpoint,
  agentId: AGENT_ID,
  roomScope: ROOM_ID,
  instanceId: EFFECTIVE_INSTANCE_ID,
});

const resumeProbe = createDesktopResumeProbe({ threadId });
const desktopEnv = {
  ...process.env,
  CODEX_HOME: codexHome,
  CODEX_APP_SERVER_WS_URL: desktopRpcEndpoint,
  CODEX_ELECTRON_USER_DATA_PATH: path.join(HOST_ROOT, "ui"),
};
const desktop = spawn(
  CHATGPT_APP,
  [
    `--user-data-dir=${path.join(HOST_ROOT, "ui")}`,
    `--remote-debugging-port=${DESKTOP_EXPERIMENT_DEBUG_PORT}`,
    `codex://threads/${threadId}`,
  ],
  { cwd: HOST_ROOT, env: desktopEnv, stdio: ["ignore", "pipe", "pipe"] },
);
desktop.stdout.on("data", (chunk) => resumeProbe.onLog(chunk.toString()));
desktop.stderr.resume();
log("desktop_launched", { pid: desktop.pid, threadId });

await sleep(20_000);
spawn(
  CHATGPT_APP,
  [`--user-data-dir=${path.join(HOST_ROOT, "ui")}`, `codex://threads/${threadId}`],
  { cwd: HOST_ROOT, env: desktopEnv, stdio: "ignore" },
);

for (let i = 0; i < 40; i += 1) {
  await sleep(1000);
  if (desktop.exitCode !== null) break;
  if (resumeProbe.resumeFailed) throw createDesktopResumeFailure(resumeProbe, threadId);
  if (resumeProbe.attached) {
    log("desktop_resume_observed", resumeProbe.status());
    break;
  }
}
if (resumeProbe.resumeFailed) throw createDesktopResumeFailure(resumeProbe, threadId);
if (!resumeProbe.attached) {
  throw new Error("Desktop did not confirm thread resume");
}

writeFileSync(
  HOLD_PATH,
  JSON.stringify(
    {
      scriptPid: process.pid,
      serverPid: server.pid,
      desktopPid: desktop.pid,
      threadId,
      listenEndpoint,
      bindingPath: BINDING_PATH,
      checkout: CHECKOUT,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);

log("holding", {
  note: "Shared App Server + bound ChatGPT held for LaunchAgent appServerWake",
  holdPath: HOLD_PATH,
  bindingPath: BINDING_PATH,
});

const shutdown = () => {
  try {
    server.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  try {
    desktop.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});
