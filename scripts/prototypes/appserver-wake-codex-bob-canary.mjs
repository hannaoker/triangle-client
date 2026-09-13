#!/usr/bin/env node
/**
 * Bob → codex-bob-test App Server session canary (2026-09-13 handoff).
 *
 * 1) Gate A-shaped disposable shared App Server + ChatGPT desktop thread
 * 2) Bob sends message.created with a unique nonce into the handoff room
 * 3) appServerWake resolveDelivery uses transaction-claim-next (Slice 6)
 * 4) Admit into the same idle desktop thread
 *
 * Does not flip codex-bob-test to event-driven. Leaves desktop held for visual confirm.
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
import { randomBytes } from "node:crypto";

import {
  DESKTOP_EXPERIMENT_DEBUG_PORT,
  assertDebugPortFree,
  assertDesktopExperimentGuards,
  buildDesktopExperimentBinding,
  createDesktopResumeProbe,
  resolveDesktopExperimentThread,
} from "../../packages/agent-worker/src/native-desktop-wake-experiment.mjs";
import {
  createCapabilityTokenAuthResolver,
  createSharedCodexSession,
  createAppServerWakeBridge,
  createFakeWatchTransport,
  createMemoryCursorStore,
  createProductionAppServerDeliveryResolver,
  createAuthenticatedAppServerTransport,
} from "../../packages/agent-worker/src/shared-codex-app-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT = path.resolve(__dirname, "../..");

const CHATGPT_APP = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_APP_TOOLS =
  "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools";
const MCP_LAUNCH = `${CODEX_APP_TOOLS}/scripts/launch_codex_app_tools_mcp`;

const HELPER_INSTALLED = path.join(
  process.env.HOME,
  "Library/Application Support/The Triangle/bin/triangle-mailbox",
);

const CODEX_PROFILE = "codex-bob-test";
const BOB_PROFILE = "bob";
const INSTANCE_ID =
  "8dc26a2fc9a622dc5ed9e3560fa0533a38b8f0998e7c34108cfb1301c6aaab64";
const AGENT_ID = "agent_98bba387b21046008b7836dadab3d6c2";
const ROOM_ID = "room_8bc8ad0e978c43dcbf9d217dade97035";
const INSTALLATION_ID = "inst_EaA3qkuzOuQwTSFw";

const CANARY_NONCE =
  process.env.MESH_CANARY_NONCE?.trim() ||
  `CODEX-APPSERVER-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

const PYTHON = process.env.MESH_PYTHON || "/opt/homebrew/bin/python3.12";
const MESH_CLIENT = path.join(CHECKOUT, "skills/triangle-mesh-a2a/scripts/mesh_client.py");

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

function runPythonJson(code, { timeoutMs = 90_000, profile } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-c", code], {
      env: {
        ...process.env,
        MESH_PROFILE: profile,
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

async function sendBobCanary() {
  const code = `
import json, os, sys, time, secrets
sys.path.insert(0, os.environ.get("PYTHONPATH",""))
import mesh_client as mc
nonce = ${JSON.stringify(CANARY_NONCE)}
room = ${JSON.stringify(ROOM_ID)}
res = mc.send_message(
  room,
  f"App Server wake canary for codex-bob-test. Nonce={nonce}. ReplyRequired true so Codex must answer.",
  reply_required=True,
  idempotency_key=f"appserver-canary-{int(time.time())}-{secrets.token_hex(3)}",
  profile=${JSON.stringify(BOB_PROFILE)},
)
result = (res or {}).get("result") or {}
structured = result.get("structuredContent") or result
event = structured.get("event") or structured
print(json.dumps({
  "ok": True,
  "eventId": event.get("id") or structured.get("eventId") or structured.get("id"),
  "roomId": room,
  "nonce": nonce,
  "rawKeys": sorted(list(structured.keys()))[:20],
}))
`;
  return runPythonJson(code, { profile: BOB_PROFILE });
}

async function listCodexMailbox() {
  const code = `
import json, os, sys
sys.path.insert(0, os.environ.get("PYTHONPATH",""))
import mesh_client as mc
res = mc.call_mcp("mesh.mailbox.list", {}, profile=${JSON.stringify(CODEX_PROFILE)})
items = (((res or {}).get("result") or {}).get("structuredContent") or {}).get("items") or []
print(json.dumps({"items": [
  {
    "deliveryId": it.get("deliveryId"),
    "roomId": it.get("roomId"),
    "eventId": it.get("eventId"),
    "roomSequence": it.get("roomSequence"),
    "state": it.get("state"),
    "text": ((it.get("event") or {}).get("body") or {}).get("text")
      or (it.get("body") or {}).get("text")
      or it.get("text"),
  } for it in items
]}))
`;
  return runPythonJson(code, { profile: CODEX_PROFILE });
}

function pickCanaryDelivery(items, { eventId = null, nonce = null } = {}) {
  const roomItems = (items || []).filter((item) => item.roomId === ROOM_ID);
  if (eventId) {
    const byEvent = roomItems.find((item) => item.eventId === eventId);
    if (byEvent) return byEvent;
  }
  if (nonce) {
    const byNonce = roomItems.find((item) => typeof item.text === "string" && item.text.includes(nonce));
    if (byNonce) return byNonce;
  }
  // Prefer newest room sequence so older backlog does not steal the admit.
  return roomItems
    .slice()
    .sort((a, b) => Number(b.roomSequence || 0) - Number(a.roomSequence || 0))[0] || null;
}

async function readTransactionStatus(helperPath = HELPER_INSTALLED) {
  return await new Promise((resolve) => {
    const child = spawn(
      helperPath,
      ["transaction-status", "--profile", CODEX_PROFILE, "--protocol", "self-serve-drain"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

async function abandonOpenTransaction(helperPath = HELPER_INSTALLED) {
  return await new Promise((resolve) => {
    const child = spawn(
      helperPath,
      [
        "transaction-abandon",
        "--profile",
        CODEX_PROFILE,
        "--protocol",
        "self-serve-drain",
        "--confirm",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
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
const root = guards.root;
mkdirSync(path.join(root, "ui"), { mode: 0o700, recursive: true });
if (guards.codexHomeSource === "test_root") {
  mkdirSync(guards.codexHome, { mode: 0o700, recursive: true });
}
if (guards.authTokenFile && !existsSync(guards.authTokenFile)) {
  writeFileSync(guards.authTokenFile, `desktop-canary-${Date.now()}\n`, { mode: 0o600 });
  log("auth_token_file_created", { path: guards.authTokenFile });
}

await assertDebugPortFree(DESKTOP_EXPERIMENT_DEBUG_PORT);
for (const binary of [CHATGPT_APP, CODEX_BIN, HELPER_INSTALLED]) {
  if (!existsSync(binary)) {
    log("failure", { message: `Missing required binary: ${binary}` });
    process.exit(2);
  }
}

const listenPort = await reservePort();
const listenEndpoint = `ws://127.0.0.1:${listenPort}`;
const desktopRpcEndpoint = `${listenEndpoint}/rpc`;

const serverEnv = {
  ...process.env,
  CODEX_HOME: guards.codexHome,
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  CODEX_APP_SERVER_WS_TOKEN_FILE: guards.authTokenFile,
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
  { cwd: root, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
);
writeFileSync(
  path.join(root, "hold.pids"),
  JSON.stringify(
    {
      scriptPid: process.pid,
      serverPid: server.pid,
      installationId: INSTALLATION_ID,
      root,
      nonce: CANARY_NONCE,
      profile: CODEX_PROFILE,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);

let serverReady = false;
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
const onServerData = (chunk) => {
  if (String(chunk).includes("readyz") || String(chunk).toLowerCase().includes("listening")) {
    serverReady = true;
  }
};
server.stdout.on("data", onServerData);
server.stderr.on("data", onServerData);

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
log("backend_ready", {
  pid: server.pid,
  listenEndpoint,
  desktopRpcEndpoint,
  installationId: INSTALLATION_ID,
  nonce: CANARY_NONCE,
});

const workspaceCwd = path.join(root, "workspace");
mkdirSync(workspaceCwd, { mode: 0o700, recursive: true });
const threadResolution = await resolveDesktopExperimentThread({
  endpoint: listenEndpoint,
  serverIdentity: guards.serverIdentity,
  tokenFile: guards.authTokenFile,
  tokenEnv: guards.authTokenEnv,
  preferredThreadId: guards.threadId,
  cwd: workspaceCwd,
  requestTimeoutMs: 45_000,
});
const threadId = threadResolution.threadId;
log("thread_resolved", {
  threadId,
  source: threadResolution.source,
  seedTurnId: threadResolution.seedTurnId ?? null,
  resumeVerified: threadResolution.resumeVerified === true,
});

const resumeProbe = createDesktopResumeProbe({ threadId });
const desktopEnv = {
  ...process.env,
  CODEX_HOME: guards.codexHome,
  CODEX_APP_SERVER_WS_URL: desktopRpcEndpoint,
  CODEX_ELECTRON_USER_DATA_PATH: path.join(root, "ui"),
};
const desktop = spawn(
  CHATGPT_APP,
  [
    `--user-data-dir=${path.join(root, "ui")}`,
    `--remote-debugging-port=${DESKTOP_EXPERIMENT_DEBUG_PORT}`,
    `codex://threads/${threadId}`,
  ],
  { cwd: root, env: desktopEnv, stdio: ["ignore", "pipe", "pipe"] },
);
desktop.stdout.on("data", (chunk) => {
  resumeProbe.onLog(chunk.toString());
});
desktop.stderr.resume();
log("desktop_launched", { pid: desktop.pid, debugPort: DESKTOP_EXPERIMENT_DEBUG_PORT, threadId });

await sleep(25_000);
spawn(
  CHATGPT_APP,
  [`--user-data-dir=${path.join(root, "ui")}`, `codex://threads/${threadId}`],
  { cwd: root, env: desktopEnv, stdio: "ignore" },
);

for (let i = 0; i < 40; i += 1) {
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
  throw new Error("Desktop did not confirm successful thread resume/active stream");
}

await sleep(3_000);

// Stale open claims hide pending mailbox rows and steal claim-next. Clear for canary.
const priorStatus = await readTransactionStatus();
if (priorStatus?.open?.deliveryId != null) {
  log("abandon_stale_open", {
    deliveryId: priorStatus.open.deliveryId,
    state: priorStatus.open.state,
  });
  const abandoned = await abandonOpenTransaction();
  log("abandon_stale_open_result", {
    code: abandoned.code,
    stdoutPreview: abandoned.stdout.slice(0, 240),
  });
}

let sent = { ok: true, eventId: null, roomId: ROOM_ID, nonce: CANARY_NONCE, reusedPending: false };
const existingList = await listCodexMailbox();
const existing = pickCanaryDelivery(existingList.items || [], { nonce: CANARY_NONCE });
if (existing?.eventId && typeof existing.text === "string" && existing.text.includes(CANARY_NONCE)) {
  sent = {
    ok: true,
    eventId: existing.eventId,
    roomId: ROOM_ID,
    nonce: CANARY_NONCE,
    reusedPending: true,
    deliveryId: existing.deliveryId,
  };
  log("bob_outbound_reused_pending", sent);
} else {
  sent = await sendBobCanary();
  log("bob_outbound_sent", sent);
}

let pendingTarget = null;
for (let i = 0; i < 10; i += 1) {
  await sleep(i === 0 ? 1500 : 2000);
  const listed = await listCodexMailbox();
  pendingTarget = pickCanaryDelivery(listed.items || [], {
    eventId: sent.eventId,
    nonce: CANARY_NONCE,
  });
  log("codex_mailbox_pending", {
    attempt: i + 1,
    count: (listed.items || []).filter((item) => item.roomId === ROOM_ID).length,
    target: pendingTarget
      ? {
          deliveryId: pendingTarget.deliveryId,
          eventId: pendingTarget.eventId,
          roomSequence: pendingTarget.roomSequence,
        }
      : null,
  });
  if (pendingTarget) break;
}
if (!pendingTarget) {
  log("failure", {
    message: "codex-bob-test mailbox has no pending delivery for canary after Bob send",
    eventId: sent.eventId,
    nonce: CANARY_NONCE,
  });
  process.exit(2);
}

const binding = buildDesktopExperimentBinding({
  threadId,
  endpoint: listenEndpoint,
  serverIdentity: guards.serverIdentity,
  installationId: INSTALLATION_ID,
  instanceId: INSTANCE_ID,
  agentId: AGENT_ID,
  roomScope: ROOM_ID,
});
writeFileSync(path.join(root, "binding.json"), JSON.stringify(binding, null, 2) + "\n", { mode: 0o600 });
log("binding_ready", {
  installationId: binding.installationId,
  instanceId: binding.instanceId,
  agentId: binding.agentId,
  threadId: binding.threadId,
  roomScope: binding.roomScope,
  bindingPath: path.join(root, "binding.json"),
});

const resolveDelivery = createProductionAppServerDeliveryResolver({
  helperPath: HELPER_INSTALLED,
  profile: CODEX_PROFILE,
  async run(file, args, options = {}) {
    // Installed helper may predate transaction-claim-next. Emulate list→claim
    // with existing verbs until the signed helper is rebuilt.
    if (args[0] === "transaction-claim-next") {
      const statusArgs = ["transaction-status", "--profile", CODEX_PROFILE, "--protocol", "self-serve-drain"];
      const statusProc = spawn(file, statusArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let statusOut = "";
      statusProc.stdout.setEncoding("utf8");
      statusProc.stdout.on("data", (c) => { statusOut += c; });
      const statusCode = await new Promise((resolve) => statusProc.on("close", resolve));
      if (statusCode === 0) {
        try {
          const status = JSON.parse(statusOut);
          if (status?.shouldStartModel === true && status?.open?.deliveryId != null) {
            const deliveryIdNum = Number(status.open.deliveryId);
            if (Number.isSafeInteger(deliveryIdNum) && deliveryIdNum > 0) {
              status.open.deliveryId = deliveryIdNum;
              return { code: 0, stdout: JSON.stringify(status), stderr: "" };
            }
          }
        } catch {
          /* fall through to claim path */
        }
      }

      const listed = await listCodexMailbox();
      const next =
        pickCanaryDelivery(listed.items || [], {
          eventId: sent.eventId,
          nonce: CANARY_NONCE,
        }) || pickCanaryDelivery(listed.items || []);
      if (!next) {
        return {
          code: 0,
          stdout: JSON.stringify({
            shouldStartModel: false,
            transactionStuck: false,
            open: null,
            status: "empty",
          }),
          stderr: "",
        };
      }
      const claimArgs = [
        "transaction-claim",
        "--profile",
        CODEX_PROFILE,
        "--protocol",
        "self-serve-drain",
        "--delivery-id",
        String(next.deliveryId),
        "--room-id",
        next.roomId,
        "--event-id",
        next.eventId,
      ];
      const claimProc = spawn(file, claimArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let claimOut = "";
      let claimErr = "";
      claimProc.stdout.setEncoding("utf8");
      claimProc.stderr.setEncoding("utf8");
      claimProc.stdout.on("data", (c) => { claimOut += c; });
      claimProc.stderr.on("data", (c) => { claimErr += c; });
      const claimCode = await new Promise((resolve) => claimProc.on("close", resolve));
      if (claimCode !== 0) {
        return { code: claimCode ?? 1, stdout: claimOut, stderr: claimErr };
      }
      let claimed;
      try {
        claimed = JSON.parse(claimOut);
      } catch {
        return { code: 1, stdout: claimOut, stderr: "claim json unreadable" };
      }
      const deliveryIdNum = Number(claimed.deliveryId ?? next.deliveryId);
      if (!Number.isSafeInteger(deliveryIdNum) || deliveryIdNum <= 0) {
        return { code: 1, stdout: claimOut, stderr: "claim missing numeric deliveryId" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          shouldStartModel: true,
          transactionStuck: false,
          status: "open_transaction",
          open: {
            deliveryId: deliveryIdNum,
            roomId: claimed.roomId || next.roomId,
            state: claimed.state || "claimed",
            claimId: claimed.claimId ?? null,
          },
        }),
        stderr: "",
      };
    }
    // default spawn for other helper verbs
    return await new Promise((resolve) => {
      const child = spawn(file, args, {
        stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      if (options.stdin != null) {
        child.stdin.end(typeof options.stdin === "string" ? options.stdin : Buffer.from(options.stdin));
      }
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? null }));
    });
  },
});

let admittedDeliveryId = null;
async function resolveDeliveryWrapped(input) {
  log("resolve_delivery_enter", input);
  const delivery = await resolveDelivery(input);
  if (!delivery) {
    log("resolve_delivery_empty", { reason: input.reason });
    return null;
  }
  admittedDeliveryId = delivery.deliveryId;
  const text = [
    delivery.text,
    `Canary nonce must appear here: ${CANARY_NONCE}.`,
    "Reply in one short line that echoes the canary nonce exactly.",
    "Do not use tools.",
  ].join("\n");
  log("resolve_delivery_admit", {
    deliveryId: delivery.deliveryId,
    nonce: CANARY_NONCE,
    textPreview: text.slice(0, 240),
  });
  return { deliveryId: delivery.deliveryId, text };
}

const authResolver = createCapabilityTokenAuthResolver({
  serverIdentity: guards.serverIdentity,
  tokenFile: guards.authTokenFile,
  tokenEnv: guards.authTokenEnv,
});
const transport = createAuthenticatedAppServerTransport({
  endpoint: listenEndpoint,
  resolveAuth: () => authResolver.resolveAuth(),
  requestTimeoutMs: 45_000,
});
const session = createSharedCodexSession({
  binding,
  transport,
  requestTimeoutMs: 45_000,
  logger: {
    log: (line) => console.log(typeof line === "string" ? line : JSON.stringify(line)),
    error: (...args) => console.error(...args),
  },
});

// Fake watch + startup_reconcile: mcp-interactive Codex is not on the event-driven grant.
const watchTransport = createFakeWatchTransport({
  polls: [{ cursor: 1, events: [] }],
});

const bridge = createAppServerWakeBridge({
  binding,
  session,
  watchTransport,
  cursorStore: createMemoryCursorStore(0),
  helperPath: HELPER_INSTALLED,
  installationId: INSTALLATION_ID,
  actorProfile: CODEX_PROFILE,
  ensureBeforeWatch: false,
  resolveDelivery: resolveDeliveryWrapped,
  coalesceMs: 50,
  logger: {
    log: (line) => console.log(typeof line === "string" ? line : JSON.stringify(line)),
    error: (...args) => console.error(...args),
  },
});

log("bridge_start", {
  watchMode: "fake_watch_startup_reconcile",
  threadId,
  installationId: INSTALLATION_ID,
  actorProfile: CODEX_PROFILE,
  resolver: "transaction-claim-next",
});
const bridgeResult = await bridge.start({ maxCycles: 1 });
log("bridge_watch_finished", { bridgeResult });

let admitOutcome = null;
let turnId = null;
for (let i = 0; i < 90; i += 1) {
  if (admittedDeliveryId) {
    const corr = await session.correlationStore.get(admittedDeliveryId);
    if (corr) {
      admitOutcome = corr;
      turnId = corr.turnId ?? null;
      log("admit_correlation", {
        deliveryId: admittedDeliveryId,
        status: corr.status,
        turnId,
      });
      if (corr.status === "completed" || corr.status === "failed" || corr.status === "submission_unknown") {
        break;
      }
    }
  }
  await sleep(1000);
}

const finalStatus = session.status();
const result = {
  watchMode: "fake_watch_startup_reconcile",
  installationId: INSTALLATION_ID,
  profile: CODEX_PROFILE,
  threadId,
  turnId,
  admitStatus: admitOutcome?.status ?? null,
  sessionStatus: finalStatus.status,
  nonce: CANARY_NONCE,
  bobEventId: sent.eventId ?? null,
  admittedDeliveryId,
  bindingPath: path.join(root, "binding.json"),
  expectedVisualNonce: CANARY_NONCE,
  humanRequired: [
    `Open the isolated ChatGPT window for thread ${threadId}`,
    `Confirm renderer shows an admitted turn embedding ${CANARY_NONCE}`,
    "Confirm assistant reply echoes the canary nonce",
    "Ordinary ChatGPT desktop is separate; this uses MESH_DESKTOP_TEST_ROOT/ui",
  ],
};
log("result", result);
writeFileSync(path.join(root, "canary-result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });

const holdMinutes = Number(process.env.MESH_CANARY_HOLD_MINUTES || 15);
log("holding_for_visual_confirm", {
  root,
  serverPid: server.pid,
  desktopPid: desktop.pid,
  scriptPid: process.pid,
  holdMinutes,
});
writeFileSync(
  path.join(root, "TEARDOWN.txt"),
  [
    "Tear down:",
    `  kill ${process.pid} ${server.pid} ${desktop.pid}`,
    `Look for nonce: ${CANARY_NONCE}`,
    `Thread: ${threadId}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

await sleep(holdMinutes * 60_000);
server.kill("SIGTERM");
desktop.kill("SIGTERM");
log("cleanup_complete", { note: "Script exit is evidence only; confirm visual nonce reply" });
