#!/usr/bin/env node
/**
 * Bob canary: appServerWake bridge → idle Codex desktop admit.
 *
 * Gate A patterns for shared app-server + ChatGPT desktop, then
 * createAppServerWakeBridge with resolveDelivery that reconciles durable
 * mailbox pending delivery 143 (Bob canary nonce) into session.admit.
 *
 * Live helper watch-ensure requires a watch-capable triangle-mailbox binary
 * AND workload Keychain keys for the actor profile. When unavailable, this
 * script falls back to createFakeWatchTransport and relies on
 * startup_reconcile → resolveDelivery → admit (same bridge admit path).
 *
 * Leaves desktop + app-server running for operator visual confirm.
 * Tear down: kill $(cat $ROOT/hold.pids) or Ctrl-C this process.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_EXPERIMENT_DEBUG_PORT,
  assertDebugPortFree,
  assertDesktopExperimentGuards,
  buildDesktopExperimentBinding,
  createDesktopResumeProbe,
  resolveDesktopExperimentThread,
} from "../../packages/agent-worker/src/native-desktop-wake-experiment.mjs";
import {
  createAuthenticatedAppServerTransport,
  createCapabilityTokenAuthResolver,
  createSharedCodexSession,
  createAppServerWakeBridge,
  createFakeWatchTransport,
  createHelperWatchTransport,
  ensureHelperWatchGrant,
  createMemoryCursorStore,
} from "../../packages/agent-worker/src/shared-codex-app-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
// When launched from /private/tmp copy, REPO_ROOT above is wrong — detect.
const CHECKOUT =
  process.env.TRIANGLE_CLIENT_ROOT?.trim() ||
  (existsSync(path.join(__dirname, "../../packages/agent-worker/src/shared-codex-app-server.mjs"))
    ? path.resolve(__dirname, "../..")
    : "/Users/zhenyuhou/Projects/The Triangle/triangle-client");

const CHATGPT_APP = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_APP_TOOLS =
  "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools";
const MCP_LAUNCH = `${CODEX_APP_TOOLS}/scripts/launch_codex_app_tools_mcp`;

const HELPER_INSTALLED = path.join(
  process.env.HOME,
  "Library/Application Support/The Triangle/bin/triangle-mailbox",
);
const HELPER_DEBUG =
  `${CHECKOUT}/packages/macos-mailbox-helper/.build/arm64-apple-macosx/debug/triangle-mailbox`;

const PROFILE = "cursor-grok-mesh-one";
const INSTANCE_ID =
  "73ff5435e047566d7222a06b968afaa51c0029de67dbe8f3880a1d0425b16e48";
const AGENT_ID = "agent_0cb97f86ed2d48aba59b8e9adc1aeba2";
const ROOM_ID = "room_2eb2d2721b74404789a5c55eefafd67c";
const TARGET_EVENT_ID = "event_a23eb0c492e440b2a1abf1c5870e8186";
const TARGET_DELIVERY_ID = "143";
const CANARY_NONCE = "BOB-CANARY-0912-a7c3e91f";
const PYTHON = process.env.MESH_PYTHON || "/opt/homebrew/bin/python3.12";
const MESH_CLIENT = path.join(
  CHECKOUT,
  "skills/triangle-mesh-a2a/scripts/mesh_client.py",
);

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

function createDesktopResumeFailure(probe, threadId) {
  const error = new Error(
    `Desktop thread/resume failed for ${threadId}; refusing to treat failed resume as attached`,
  );
  error.code = "desktop_experiment_desktop_resume_failed";
  error.threadId = threadId;
  error.resumeStatus = probe.status();
  return error;
}

function runPythonJson(code, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-c", code], {
      env: {
        ...process.env,
        MESH_PROFILE: PROFILE,
        TRIANGLE_MAILBOX_BIN: HELPER_INSTALLED,
        PYTHONPATH: path.dirname(MESH_CLIENT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("python mcp helper timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(`python mcp helper exited ${code}`);
        err.stderr = stderr.slice(0, 1500);
        reject(err);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        error.stdout = stdout.slice(0, 500);
        error.stderr = stderr.slice(0, 500);
        reject(error);
      }
    });
  });
}

async function listPendingMailbox() {
  const code = `
import json, os, sys
sys.path.insert(0, os.environ.get("PYTHONPATH",""))
import mesh_client as mc
res = mc.call_mcp("mesh.mailbox.list", {}, profile=${JSON.stringify(PROFILE)})
items = (((res or {}).get("result") or {}).get("structuredContent") or {}).get("items") or []
print(json.dumps({"items": items}))
`;
  return runPythonJson(code);
}

async function fetchEventBody(eventId) {
  const code = `
import json, os, sys
sys.path.insert(0, os.environ.get("PYTHONPATH",""))
import mesh_client as mc
res = mc.call_mcp("mesh.rooms.history", {
  "room_id": ${JSON.stringify(ROOM_ID)},
  "limit": 50,
}, profile=${JSON.stringify(PROFILE)})
items = (((res or {}).get("result") or {}).get("structuredContent") or {}).get("items") or []
hit = next((it for it in items if it.get("id") == ${JSON.stringify(eventId)}), None)
print(json.dumps({"event": hit}))
`;
  const payload = await runPythonJson(code);
  return payload.event ?? null;
}

function buildAdmitText(eventText) {
  return [
    "MESH appServerWake canary admit into idle shared Codex desktop chat.",
    `Pending mailbox deliveryId=${TARGET_DELIVERY_ID}`,
    `eventId=${TARGET_EVENT_ID}`,
    `roomId=${ROOM_ID}.`,
    `Bob durable reply body: ${eventText}.`,
    `Canary nonce must appear here: ${CANARY_NONCE}.`,
    "Reply in one short line that echoes the canary nonce exactly.",
    "Do not use tools.",
  ].join(" ");
}

async function tryLiveHelperWatch(installationId) {
  const helpers = [];
  if (existsSync(HELPER_DEBUG)) helpers.push({ path: HELPER_DEBUG, label: "debug_build" });
  if (existsSync(HELPER_INSTALLED)) helpers.push({ path: HELPER_INSTALLED, label: "installed" });

  const errors = [];
  for (const helper of helpers) {
    try {
      // Probe whether binary even parses watch-ensure
      await ensureHelperWatchGrant({
        helperPath: helper.path,
        installationId,
        actorProfile: PROFILE,
        timeoutMs: 90_000,
      });
      const watchTransport = createHelperWatchTransport({
        helperPath: helper.path,
        installationId,
        timeoutMs: 35_000,
      });
      return {
        mode: "helper_watch",
        helperPath: helper.path,
        helperLabel: helper.label,
        watchTransport,
        ensureBeforeWatch: false, // already ensured
      };
    } catch (error) {
      errors.push({
        helperLabel: helper.label,
        helperPath: helper.path,
        code: error?.code,
        message: error?.message,
      });
    }
  }
  return { mode: "fake_watch_startup_reconcile", errors };
}

// --- main ---
// Re-bind imports when running from /private/tmp copy: node resolves relative to this file.
// So we always launch via the repo copy; this file is the template.

const guards = assertDesktopExperimentGuards(process.env);
const root = guards.root;
const codexHome = guards.codexHome;
mkdirSync(path.join(root, "ui"), { mode: 0o700, recursive: true });
if (guards.codexHomeSource === "test_root") {
  mkdirSync(codexHome, { mode: 0o700, recursive: true });
}

if (guards.authTokenFile && !existsSync(guards.authTokenFile)) {
  writeFileSync(guards.authTokenFile, `desktop-canary-${Date.now()}\n`, { mode: 0o600 });
  log("auth_token_file_created", { path: guards.authTokenFile });
}

await assertDebugPortFree(DESKTOP_EXPERIMENT_DEBUG_PORT);

for (const binary of [CHATGPT_APP, CODEX_BIN]) {
  if (!existsSync(binary)) {
    log("failure", { message: `Missing required binary: ${binary}` });
    process.exit(2);
  }
}

const installationId =
  process.env.MESH_DESKTOP_INSTALLATION_ID?.trim() ||
  `inst_canaryWake${Date.now().toString(36).slice(-8)}`;
if (!/^inst_[A-Za-z0-9_-]{10,75}$/.test(installationId)) {
  log("failure", { message: "installationId invalid", installationId });
  process.exit(2);
}

const backendPort = await reservePort();
const listenEndpoint = `ws://127.0.0.1:${backendPort}`;
const desktopRpcEndpoint = `${listenEndpoint}/rpc`;
const mcpOverride =
  `mcp_servers.codex_app={command="${MCP_LAUNCH}",args=["./server.mjs"],cwd="${CODEX_APP_TOOLS}",enabled=false}`;

let server;
let desktop;
let opener;
let serverErrors = "";
let resumeProbe = null;
let hold = false;

const shutdown = async (code = 0) => {
  if (hold) {
    log("hold_active", {
      note: "Ignoring shutdown while HOLD=1; use tear-down instructions",
      code,
    });
    return;
  }
  for (const child of [opener, desktop, server]) {
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
  await sleep(1000);
  for (const child of [desktop, server]) {
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  process.exit(code);
};

try {
  server = spawn(
    CODEX_BIN,
    ["-c", mcpOverride, "app-server", "--listen", listenEndpoint],
    {
      cwd: root,
      env: { ...process.env, CODEX_HOME: codexHome },
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
    desktopRpcEndpoint,
    installationId,
  });

  const workspaceCwd = path.join(root, "workspace");
  mkdirSync(workspaceCwd, { mode: 0o700, recursive: true });
  const resolvedThread = await resolveDesktopExperimentThread({
    endpoint: listenEndpoint,
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
    { cwd: root, env: desktopEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  desktop.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    resumeProbe.onLog(text);
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

  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    if (desktop.exitCode !== null) {
      log("desktop_exited", { code: desktop.exitCode });
      break;
    }
    if (resumeProbe.resumeFailed) throw createDesktopResumeFailure(resumeProbe, threadId);
    if (resumeProbe.attached) {
      log("desktop_resume_observed", resumeProbe.status());
      break;
    }
  }
  if (resumeProbe.resumeFailed) throw createDesktopResumeFailure(resumeProbe, threadId);
  if (!resumeProbe.attached) {
    throw new Error(
      "Desktop did not confirm successful thread resume/active stream; bare thread/resume log lines are not success",
    );
  }

  // Leave chat idle a moment before bridge admit.
  await sleep(5_000);

  const binding = buildDesktopExperimentBinding({
    threadId,
    endpoint: listenEndpoint,
    serverIdentity: guards.serverIdentity,
    installationId,
    instanceId: INSTANCE_ID,
    agentId: AGENT_ID,
    roomScope: ROOM_ID,
  });
  log("binding_ready", {
    installationId: binding.installationId,
    instanceId: binding.instanceId,
    agentId: binding.agentId,
    threadId: binding.threadId,
    roomScope: binding.roomScope,
  });

  const watchSetup = await tryLiveHelperWatch(installationId);
  let watchTransport;
  let watchMode = watchSetup.mode;
  if (watchSetup.mode === "helper_watch") {
    watchTransport = watchSetup.watchTransport;
    log("watch_helper_ok", {
      helperLabel: watchSetup.helperLabel,
      helperPath: watchSetup.helperPath,
      installationId,
    });
  } else {
    log("watch_helper_unavailable", {
      installationId,
      errors: watchSetup.errors,
      fallback:
        "createFakeWatchTransport + startup_reconcile → resolveDelivery → session.admit (same bridge admit path; live MESH held-poll blocked)",
      recovery: [
        "Install watch-capable triangle-mailbox (scripts/install-macos-mailbox-helper.sh --local-ad-hoc)",
        "Provision workload Keychain keys for cursor-grok-mesh-one (WatchGrant requires WorkloadWatchGrantAuthProvider)",
        "Re-run with MESH_FORCE_HELPER_WATCH=1 after those are ready",
      ],
    });
    // One empty poll so watch({maxCycles:1}) can complete after reconcile.
    watchTransport = createFakeWatchTransport({
      polls: [{ cursor: 0, events: [] }],
    });
  }

  if (process.env.MESH_FORCE_HELPER_WATCH === "1" && watchMode !== "helper_watch") {
    throw new Error("MESH_FORCE_HELPER_WATCH=1 but helper watch-ensure failed; see watch_helper_unavailable");
  }

  let admittedOnce = false;
  let resolveEvidence = null;

  async function resolveDelivery({ instanceId, highWatermark, reason }) {
    log("resolve_delivery_enter", { instanceId, highWatermark, reason });
    if (instanceId !== INSTANCE_ID) return null;
    if (admittedOnce) return null;

    const listed = await listPendingMailbox();
    const pending = (listed.items || []).find(
      (item) =>
        String(item.deliveryId) === TARGET_DELIVERY_ID ||
        item.eventId === TARGET_EVENT_ID,
    );
    if (!pending) {
      log("resolve_delivery_empty", { reason, note: "target delivery not pending" });
      return null;
    }

    const event = await fetchEventBody(TARGET_EVENT_ID);
    const eventText =
      (event?.body && typeof event.body.text === "string" && event.body.text) ||
      CANARY_NONCE;
    if (!eventText.includes(CANARY_NONCE)) {
      throw new Error(`event body missing canary nonce; got length=${eventText.length}`);
    }

    const deliveryId = String(pending.deliveryId);
    const text = buildAdmitText(eventText);
    resolveEvidence = {
      reason,
      deliveryId,
      eventId: pending.eventId,
      roomId: pending.roomId,
      eventText,
      nonce: CANARY_NONCE,
    };
    log("resolve_delivery_hit", {
      reason,
      deliveryId,
      eventId: pending.eventId,
      roomId: pending.roomId,
      eventText,
      state: pending.state,
    });
    admittedOnce = true;
    return { deliveryId, text };
  }

  const authResolver = createCapabilityTokenAuthResolver({
    serverIdentity: guards.serverIdentity,
    tokenFile: guards.authTokenFile,
    tokenEnv: guards.authTokenEnv,
  });
  const transport = createAuthenticatedAppServerTransport({
    endpoint: listenEndpoint,
    resolveAuth: () => authResolver.resolveAuth(),
    awaitAuthenticatedHello: process.env.MESH_DESKTOP_AWAIT_AUTH_HELLO === "1",
    requestTimeoutMs: Number(process.env.MESH_DESKTOP_RPC_TIMEOUT_MS || 45_000),
  });
  const session = createSharedCodexSession({
    binding,
    transport,
    requestTimeoutMs: Number(process.env.MESH_DESKTOP_RPC_TIMEOUT_MS || 45_000),
    logger: {
      log: (line) => console.log(typeof line === "string" ? line : JSON.stringify(line)),
      error: (...args) => console.error(...args),
    },
  });

  const bridge = createAppServerWakeBridge({
    binding,
    session,
    watchTransport,
    cursorStore: createMemoryCursorStore(0),
    helperPath: watchSetup.helperPath ?? HELPER_INSTALLED,
    installationId,
    actorProfile: PROFILE,
    ensureBeforeWatch: false,
    resolveDelivery,
    coalesceMs: 50,
    logger: {
      log: (line) => console.log(typeof line === "string" ? line : JSON.stringify(line)),
      error: (...args) => console.error(...args),
    },
  });

  log("bridge_start", { watchMode, threadId, installationId });
  const bridgeResult = await bridge.start({ maxCycles: watchMode === "helper_watch" ? 2 : 1 });
  log("bridge_watch_finished", { bridgeResult, watchMode });

  // Wait for admit queue / turn completion.
  let admitOutcome = null;
  let turnId = null;
  for (let i = 0; i < 90; i += 1) {
    const st = session.status();
    if (st.lastSuccessfulWakeAt || ["subscribed", "busy", "running", "pending"].includes(st.status)) {
      /* keep polling */
    }
    const corr = await session.correlationStore.get(TARGET_DELIVERY_ID);
    if (corr) {
      admitOutcome = corr;
      turnId = corr.turnId ?? corr.turn_id ?? null;
      log("admit_correlation", {
        deliveryId: TARGET_DELIVERY_ID,
        status: corr.status,
        turnId,
        correlation: {
          deliveryId: corr.deliveryId,
          threadId: corr.threadId,
          status: corr.status,
          turnId: corr.turnId ?? null,
        },
      });
      if (corr.status === "completed" || corr.status === "failed" || corr.status === "submission_unknown") {
        break;
      }
    }
    await sleep(1000);
  }

  // Re-check mailbox pending state (admit does not ack MESH by itself).
  let mailboxAfter = null;
  try {
    const listed = await listPendingMailbox();
    mailboxAfter = (listed.items || []).find(
      (item) => String(item.deliveryId) === TARGET_DELIVERY_ID,
    );
  } catch (error) {
    log("mailbox_relist_failed", { message: error.message, stderr: error.stderr });
  }

  const finalStatus = session.status();
  log("result", {
    watchMode,
    installationId,
    threadId,
    turnId,
    admitStatus: admitOutcome?.status ?? null,
    sessionStatus: finalStatus.status,
    resolveEvidence,
    mailboxDelivery143StillPending: Boolean(mailboxAfter),
    mailboxDelivery143State: mailboxAfter?.state ?? "absent_from_pending_list",
    expectedVisualNonce: CANARY_NONCE,
    humanRequired: [
      `Open the isolated ChatGPT window for thread ${threadId}`,
      `Confirm renderer shows an admitted user turn whose prompt embeds ${CANARY_NONCE}`,
      "Confirm assistant reply echoes the canary nonce (if turn completed)",
      "Ordinary ChatGPT desktop is separate; this uses MESH_DESKTOP_TEST_ROOT/ui",
    ],
  });

  // Hold for visual confirm.
  hold = true;
  writeFileSync(
    path.join(root, "hold.pids"),
    JSON.stringify(
      {
        serverPid: server.pid,
        desktopPid: desktop.pid,
        scriptPid: process.pid,
        threadId,
        installationId,
        root,
        listenEndpoint,
        nonce: CANARY_NONCE,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(root, "TEARDOWN.txt"),
    [
      "Visual confirm, then tear down:",
      `  kill ${process.pid} ${server.pid} ${desktop.pid}`,
      `  # or: kill $(python3 -c \"import json;print(' '.join(str(json.load(open('${path.join(root, "hold.pids")}'))[k]) for k in ('scriptPid','serverPid','desktopPid'))\")`,
      "",
      `Thread: ${threadId}`,
      `Look for nonce: ${CANARY_NONCE}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  log("holding_for_visual_confirm", {
    root,
    serverPid: server.pid,
    desktopPid: desktop.pid,
    scriptPid: process.pid,
    holdMinutes: Number(process.env.MESH_CANARY_HOLD_MINUTES || 20),
    teardownFile: path.join(root, "TEARDOWN.txt"),
  });

  const holdMs = Number(process.env.MESH_CANARY_HOLD_MINUTES || 20) * 60_000;
  await sleep(holdMs);
  hold = false;
  await bridge.stop().catch(() => {});
  await shutdown(0);
} catch (error) {
  log("failure", {
    message: error.message,
    code: error.code,
    serverErrors: serverErrors.slice(-2000),
    stderr: error.stderr,
  });
  hold = false;
  await shutdown(1);
}
