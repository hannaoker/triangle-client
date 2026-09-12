#!/usr/bin/env node
/**
 * Production-shaped native-desktop nonce wake experiment (Mac operator entrypoint).
 *
 * Uses createAuthenticatedAppServerTransport + createSharedCodexSession (not a raw
 * WebSocket probe). Opt-in guarded; not a production launcher or supervisor daemon.
 *
 * See docs/triangle-client/codex-desktop-wake-handoff.md Gate A / Mac runbook.
 *
 * Linux: supports --check-guards-only (and unit tests under packages/agent-worker).
 * Do not claim ChatGPT.app / native desktop results from a Linux environment.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import {
  DESKTOP_EXPERIMENT_DEBUG_PORT,
  DESKTOP_EXPERIMENT_REPLY_MARKER,
  assertDebugPortFree,
  assertDesktopExperimentGuards,
  buildDesktopExperimentBinding,
  createDesktopExperimentNonce,
  createDesktopResumeProbe,
  resolveDesktopExperimentThread,
  runNativeDesktopWakeListener,
} from "../../packages/agent-worker/src/native-desktop-wake-experiment.mjs";

const CHATGPT_APP = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_APP_TOOLS =
  "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools";
const MCP_LAUNCH =
  `${CODEX_APP_TOOLS}/scripts/launch_codex_app_tools_mcp`;

const checkGuardsOnly = process.argv.includes("--check-guards-only");

function log(test, data = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), test, ...data }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function killTree(child, label) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch (error) {
    log("kill_error", { label, message: error.message });
  }
}

async function forceKill(child, label) {
  if (!child || child.exitCode !== null) return;
  await sleep(1000);
  if (child.exitCode !== null) return;
  try {
    child.kill("SIGKILL");
    log("force_killed", { label, pid: child.pid });
  } catch {
    /* ignore */
  }
}


function createDesktopResumeFailure(probe, threadId) {
  const error = new Error(
    `Desktop thread/resume failed for ${threadId}; refusing to treat failed resume as attached`,
  );
  error.code = "desktop_experiment_desktop_resume_failed";
  error.threadId = threadId;
  error.resumeStatus = probe.status();
  return error;
}

const guards = assertDesktopExperimentGuards(process.env);
const nonce = process.env.MESH_DESKTOP_NONCE?.trim() || createDesktopExperimentNonce();

if (checkGuardsOnly) {
  log("guards_ok", {
    root: guards.root,
    threadId: guards.threadId,
    threadMode: guards.threadId ? "override_if_present_on_server" : "mint_after_readyz",
    serverIdentity: guards.serverIdentity,
    debugPort: guards.debugPort,
    authVia: guards.authTokenFile ? "file" : "env",
    codexHome: guards.codexHome,
    codexHomeSource: guards.codexHomeSource,
    nonce,
    platform: process.platform,
    note: "Linux-safe guard check only; native desktop not launched. Default Mac path mints+seeds a resumeable thread on the app-server after readyz. Set MESH_DESKTOP_CODEX_HOME to the operator Codex home for API auth; UI stays under MESH_DESKTOP_TEST_ROOT/ui.",
  });
  process.exit(0);
}

if (process.platform !== "darwin") {
  log("failure", {
    message: "Native desktop experiment requires macOS ChatGPT.app; use --check-guards-only on Linux",
    platform: process.platform,
  });
  process.exit(2);
}

for (const binary of [CHATGPT_APP, CODEX_BIN]) {
  if (!existsSync(binary)) {
    log("failure", { message: `Missing required binary: ${binary}` });
    process.exit(2);
  }
}

await assertDebugPortFree(DESKTOP_EXPERIMENT_DEBUG_PORT);

const root = guards.root;
const codexHome = guards.codexHome;
mkdirSync(path.join(root, "ui"), { mode: 0o700, recursive: true });
if (guards.codexHomeSource === "test_root") {
  mkdirSync(codexHome, { mode: 0o700, recursive: true });
}

if (guards.authTokenFile && !existsSync(guards.authTokenFile)) {
  // Disposable local capability token for the experiment path (not a MESH secret).
  writeFileSync(guards.authTokenFile, `desktop-experiment-${nonce}\n`, { mode: 0o600 });
  log("auth_token_file_created", { path: guards.authTokenFile });
}

const backendPort = await reservePort();
const listenEndpoint = `ws://127.0.0.1:${backendPort}`;
const listenerEndpoint = process.env.MESH_DESKTOP_LISTENER_ENDPOINT?.trim() || listenEndpoint;
const desktopRpcEndpoint = `${listenEndpoint}/rpc`;

const mcpOverride =
  `mcp_servers.codex_app={command="${MCP_LAUNCH}",args=["./server.mjs"],cwd="${CODEX_APP_TOOLS}",enabled=false}`;

let server;
let desktop;
let opener;
let serverErrors = "";
const desktopMethods = [];
let resumeProbe = null;

try {
  server = spawn(
    CODEX_BIN,
    ["-c", mcpOverride, "app-server", "--listen", listenEndpoint],
    {
      cwd: root,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.resume();
  server.stderr.on("data", (chunk) => {
    serverErrors = (serverErrors + chunk.toString()).slice(-4000);
  });
  server.on("error", (error) => log("server_error", { message: error.message }));

  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${backendPort}/readyz`)).ok) break;
    } catch {
      /* retry */
    }
    await sleep(100);
    if (i === 99) throw new Error("backend readiness failed");
  }
  log("backend_ready", {
    pid: server.pid,
    listenEndpoint,
    listenerEndpoint,
    desktopRpcEndpoint,
    nonce,
  });

  // Mint (default) or resume override on *this* ephemeral app-server before desktop.
  // A normal-Codex thread id from the operator's home does not exist here.
  const workspaceCwd = path.join(root, "workspace");
  mkdirSync(workspaceCwd, { mode: 0o700, recursive: true });
  const resolvedThread = await resolveDesktopExperimentThread({
    endpoint: listenerEndpoint,
    serverIdentity: guards.serverIdentity,
    tokenFile: guards.authTokenFile,
    tokenEnv: guards.authTokenEnv,
    preferredThreadId: guards.threadId,
    cwd: workspaceCwd,
    awaitAuthenticatedHello: process.env.MESH_DESKTOP_AWAIT_AUTH_HELLO === "1",
    requestTimeoutMs: Number(process.env.MESH_DESKTOP_RPC_TIMEOUT_MS || 45_000),
  });
  const threadId = resolvedThread.threadId;
  log("thread_resolved", {
    threadId,
    source: resolvedThread.source,
    seedTurnId: resolvedThread.seedTurnId ?? null,
    resumeVerified: resolvedThread.resumeVerified === true,
    preferredThreadId: guards.threadId,
    codexHome,
    codexHomeSource: guards.codexHomeSource,
  });

  resumeProbe = createDesktopResumeProbe({ threadId });

  const desktopEnv = {
    ...process.env,
    CODEX_APP_SERVER_WS_URL: desktopRpcEndpoint,
    CODEX_ELECTRON_USER_DATA_PATH: path.join(root, "ui"),
    CODEX_HOME: codexHome,
  };

  desktop = spawn(
    CHATGPT_APP,
    [
      `--user-data-dir=${path.join(root, "ui")}`,
      `--remote-debugging-port=${DESKTOP_EXPERIMENT_DEBUG_PORT}`,
      `codex://threads/${threadId}`,
    ],
    {
      cwd: root,
      env: desktopEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  desktop.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    resumeProbe.onLog(text);
    if (text.includes(threadId) || text.includes("thread/resume")) {
      log("target_desktop_log", {
        text: text.split("\n").filter((line) =>
          line.includes(threadId) || line.includes("thread/resume") || /errorCode|-32600|rollout/i.test(line)
        ).join("\n").slice(0, 1800),
        resumeStatus: resumeProbe.status(),
      });
    }
    for (const method of ["initialize", "thread/list", "thread/resume"]) {
      if (text.includes(method)) desktopMethods.push(method);
    }
  });
  desktop.stderr.resume();
  desktop.on("error", (error) => log("desktop_error", { message: error.message }));
  log("desktop_launched", {
    pid: desktop.pid,
    debugPort: DESKTOP_EXPERIMENT_DEBUG_PORT,
    threadId,
  });

  await sleep(30_000);
  opener = spawn(
    CHATGPT_APP,
    [`--user-data-dir=${path.join(root, "ui")}`, `codex://threads/${threadId}`],
    { cwd: root, env: desktopEnv, stdio: "ignore" },
  );
  opener.on("error", (error) => log("opener_error", { message: error.message }));

  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    if (desktop.exitCode !== null) {
      log("desktop_exited", { code: desktop.exitCode });
      break;
    }
    if (resumeProbe.resumeFailed) {
      throw createDesktopResumeFailure(resumeProbe, threadId);
    }
    if (resumeProbe.attached) {
      log("desktop_resume_observed", resumeProbe.status());
      break;
    }
  }

  if (resumeProbe.resumeFailed) {
    throw createDesktopResumeFailure(resumeProbe, threadId);
  }
  if (!resumeProbe.attached) {
    throw new Error(
      "Desktop did not confirm successful thread resume/active stream; bare thread/resume log lines (including -32600) are not success",
    );
  }

  const binding = buildDesktopExperimentBinding({
    threadId,
    endpoint: listenerEndpoint,
    serverIdentity: guards.serverIdentity,
    installationId: process.env.MESH_DESKTOP_INSTALLATION_ID || "inst_desktopexp01",
    instanceId: process.env.MESH_DESKTOP_INSTANCE_ID || "b".repeat(64),
    agentId: process.env.MESH_DESKTOP_AGENT_ID || "agent_desktop_nonce_wake",
    roomScope: process.env.MESH_DESKTOP_ROOM_SCOPE || "room_desktop_nonce_wake",
  });

  const evidence = await runNativeDesktopWakeListener({
    binding,
    nonce,
    tokenFile: guards.authTokenFile,
    tokenEnv: guards.authTokenEnv,
    awaitAuthenticatedHello: process.env.MESH_DESKTOP_AWAIT_AUTH_HELLO === "1",
    waitTimeoutMs: Number(process.env.MESH_DESKTOP_TURN_TIMEOUT_MS || 45_000),
    requestTimeoutMs: Number(process.env.MESH_DESKTOP_RPC_TIMEOUT_MS || 45_000),
    logger: {
      log: (line) => console.log(line),
      error: (...args) => console.error(...args),
    },
  });

  // Allow renderer time to paint before operator inspection.
  await sleep(20_000);

  log("result", {
    connected: true,
    attached: resumeProbe.attached,
    resumeStatus: resumeProbe.status(),
    nonce: evidence.nonce,
    turnId: evidence.turnId,
    turnStatus: evidence.turnStatus,
    sessionStatus: evidence.sessionStatus,
    expectedReply: `${DESKTOP_EXPERIMENT_REPLY_MARKER} ${evidence.nonce}`,
    humanRequired: [
      "Confirm desktop thread/resume and idle subscribed chat",
      `Confirm renderer shows prompt + assistant reply containing ${DESKTOP_EXPERIMENT_REPLY_MARKER} ${evidence.nonce}`,
      "Compare backend config snapshot before/after; isolated UI data does not isolate backend mutations",
    ],
  });
} catch (error) {
  log("failure", {
    message: error.message,
    code: error.code,
    serverErrors: serverErrors.slice(-2000),
  });
  process.exitCode = 1;
} finally {
  killTree(opener, "opener");
  killTree(desktop, "desktop");
  await forceKill(desktop, "desktop");
  killTree(server, "server");
  await forceKill(server, "server");
  log("cleanup_complete", {
    note: "Script exit is evidence only; Mac operator must verify resume + renderer nonce reply",
  });
  process.exit(process.exitCode ?? 0);
}
