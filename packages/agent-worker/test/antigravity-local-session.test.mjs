import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  setupLocalMessaging,
  setupSessionDiscovery,
  setupWorkspaceMessaging,
  setupDesktopInbox,
  runSessionDiscoveryHook,
} from "../src/local-messaging-cli.mjs";
import {
  setupAntigravity,
  readAntigravityBinding,
  updateAntigravityGrants,
  disableAntigravity,
} from "../src/antigravity-local-session.mjs";
import { readPrivateJson, writePrivateJson } from "../src/local-messaging-auth-broker.mjs";
import { createInstalledLocalMessagingHost, createDestinationPermissions, loadLocalMessagingConfig } from "../src/local-messaging-host.mjs";
import { createProfiledReasonerGate } from "../src/concurrency-gate.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { resolveLocalSocketAddress } from "../src/local-messaging-address.mjs";
import { sessionAddress, readSessionMessagingPolicy } from "../src/local-messaging-interactive-session.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/local-messaging-cli.mjs", import.meta.url));
const ownerId = "a".repeat(64);
const hash = (s) => createHash("sha256").update(s).digest("hex");

function fixture() {
  const root = fs.mkdtempSync("/private/tmp/tri-agy-local-");
  const configPath = path.join(root, "local.json");
  const bindingPath = path.join(root, "desktop.json");
  writePrivateJson(bindingPath, { instanceId: ownerId });
  setupLocalMessaging({ config: configPath, "desktop-binding": bindingPath, "thread-id": "agy-test-desktop", recipients: ["worker-one"] });
  const config = readPrivateJson(configPath);
  const worker = config.recipients[0].instanceId;
  let host = null;
  const clients = [];
  const runs = [];
  return {
    root,
    configPath,
    stateRoot: config.stateRoot,
    worker,
    runs,
    binding: (alias = "antigravity") => readAntigravityBinding(path.join(config.stateRoot, `antigravity-${alias}.json`)),
    async start() {
      host = createInstalledLocalMessagingHost({
        configPath,
        runners: new Map([[worker, { run: async (req) => { runs.push(req); return { status: "completed", text: `worker:${req.text}` }; } }]]),
        gate: createProfiledReasonerGate(),
      });
      await host.start();
    },
    async stop() {
      await host?.stop();
      host = null;
    },
    async cli(args) {
      const res = await exec(process.execPath, [cli, ...args, "--config", configPath]);
      return JSON.parse(res.stdout);
    },
    async mcp(alias, calls) {
      return new Promise((resolve, reject) => {
        const args = [cli, "antigravity-mcp", "--config", configPath, ...(alias ? ["--alias", alias] : [])];
        const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) return reject(new Error(`mcp exit ${code}: ${stderr}`));
          resolve(stdout.trim().split("\n").map((line) => JSON.parse(line)));
        });
        const requests = [
          { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          ...calls,
        ];
        child.stdin.end(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
      });
    },
    client(id) {
      const c = createLocalControlClient({ socketPath: resolveLocalSocketAddress({ stateRoot: config.stateRoot }).socketPath, senderId: id });
      clients.push(c);
      return c;
    },
    async close() {
      for (const c of clients) await c.close();
      await host?.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitForReply(f, alias, requestId) {
  for (let i = 0; i < 40; i++) {
    const res = await f.mcp(alias, [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_get_replies", arguments: { requestId } } },
    ]);
    const body = JSON.parse(res[1].result.content[0].text);
    if (body.replies.length) return body.replies[0];
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("missing worker reply");
}

test("setup-antigravity creates distinct 0600 identity, isolates grants, and sends/receives via antigravity-mcp", async () => {
  const f = fixture();
  try {
    const setup = await f.cli(["setup-antigravity", "--alias", "mini", "--recipient", "worker-one"]);
    assert.equal(setup.alias, "mini");
    assert.equal(setup.wakeCapable, false);
    assert.equal(setup.secret, undefined);
    assert.notEqual(setup.senderId, ownerId);
    assert.notEqual(setup.senderId, f.worker);
    assert.equal(setup.senderId, hash(JSON.stringify(["triangle-antigravity-v1", ownerId, "mini"])));
    assert.deepEqual(setup.allowedRecipients, [f.worker]);
    assert.deepEqual(setup.allowedSenders, []);

    const bindingFile = path.join(f.stateRoot, "antigravity-mini.json");
    assert.equal(fs.statSync(bindingFile).mode & 0o777, 0o600);
    assert.equal(loadLocalMessagingConfig(f.configPath).antigravity.bindings[0], bindingFile);

    // Setup rerun preserves antigravity section across desktop setup updates.
    setupLocalMessaging({ config: f.configPath, "desktop-binding": path.join(f.root, "desktop.json"), "thread-id": "agy-test-desktop", recipients: ["worker-one"] });
    assert.equal(loadLocalMessagingConfig(f.configPath).antigravity.enabled, true);

    await f.start();

    // Antigravity sees its own sessionStatus and only its authorized recipients.
    const statusAndDir = await f.mcp(undefined, [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_get_status", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "triangle_list_sessions", arguments: {} } },
    ]);
    assert.ok(!JSON.stringify(statusAndDir).includes(f.binding("mini").secret));
    const status = JSON.parse(statusAndDir[1].result.content[0].text);
    assert.equal(status.senderId, setup.senderId);
    assert.deepEqual(status.inbox, { queued: 0, executing: 0, held: 0 });
    const dir = JSON.parse(statusAndDir[2].result.content[0].text);
    assert.deepEqual(dir.sessions.map((r) => r.id), [f.worker]);

    // Send to authorized worker via MCP and retrieve correlated reply.
    const sendRes = await f.mcp("mini", [
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "triangle_send_message", arguments: { to: f.worker, text: "check status", messageId: "agy-msg-1", requestId: "agy-req-1" } },
      },
    ]);
    assert.equal(sendRes[1].result.isError, false);
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0].senderId, setup.senderId);

    const reply = await waitForReply(f, "mini", "agy-req-1");
    assert.equal(reply.text, "worker:check status");
    assert.equal(reply.inReplyTo, "agy-msg-1");

    // Refuses ungranted desktop destination.
    const denied = await f.mcp("mini", [
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "triangle_send_message", arguments: { to: ownerId, text: "nope", messageId: "agy-deny", requestId: "agy-deny" } },
      },
    ]);
    assert.equal(denied[1].result.isError, true);
    assert.match(denied[1].result.content[0].text, /recipient_not_allowed/);
  } finally {
    await f.close();
  }
});

test("direction-isolated inbox: desktop sends to Antigravity by alias, Antigravity claims & replies via MCP, foreign claim refused", async () => {
  const f = fixture();
  try {
    const ag = setupAntigravity({ alias: "mini", senders: [ownerId], recipients: [] }, f.configPath);
    setupDesktopInbox({ config: f.configPath, senders: [ag.senderId] });
    await f.start();

    // Desktop discovers Antigravity as pull_only with harness "antigravity" and sends by alias.
    const desktopSessions = (await f.cli(["sessions"])).sessions;
    const agRow = desktopSessions.find((r) => r.id === ag.senderId);
    assert.equal(agRow.harness, "antigravity");
    assert.equal(agRow.delivery.state, "pull_only");

    const sent = await f.cli(["send", "--to", "mini", "--text", "review PR", "--message-id", "desk-to-agy", "--request-id", "desk-req"]);
    assert.equal(sent.admission.accepted, true);
    assert.equal(f.runs.length, 0);

    // Foreign caller (even with enabled desktop inbox) cannot claim Antigravity's inbox.
    await assert.rejects(f.cli(["claim", "--message-id", "desk-to-agy", "--claim-id", "foreign"]), /foreign_access_denied/i);
    const inboxRes = await f.mcp("mini", [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_list_inbox", arguments: {} } },
    ]);
    const inbox = JSON.parse(inboxRes[1].result.content[0].text);
    assert.deepEqual(inbox.items.map((i) => i.messageId), ["desk-to-agy"]);

    const claimRes = await f.mcp("mini", [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_claim_message", arguments: { messageId: "desk-to-agy", claimId: "claim-1" } } },
    ]);
    const claim = JSON.parse(claimRes[1].result.content[0].text);
    assert.equal(typeof claim.claimToken, "string");

    const replyRes = await f.mcp("mini", [
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "triangle_reply_message", arguments: { messageId: "desk-to-agy", claimToken: claim.claimToken, replyId: "rep-1", text: "looks good" } },
      },
    ]);
    assert.equal(replyRes[1].result.isError, false);

    const desktopReplies = await f.cli(["replies", "--request-id", "desk-req"]);
    assert.equal(desktopReplies.replies[0].text, "looks good");
  } finally {
    await f.close();
  }
});

test("workspace session harness & exact-pair grants isolate attached Codex/Claude chats dynamically and revoke cleanly", async () => {
  const f = fixture();
  const extraClients = [];
  try {
    const workspace = path.join(f.root, "ws");
    fs.mkdirSync(workspace, { mode: 0o700 });
    const wrapper = path.join(f.root, "local-cli");
    fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    setupSessionDiscovery({ config: f.configPath, workspace, "local-cli": wrapper });
    setupSessionDiscovery({ config: f.configPath, workspace, "local-cli": wrapper, harness: "codex" });
    setupWorkspaceMessaging({ config: f.configPath, workspace, "local-cli": wrapper });
    setupWorkspaceMessaging({ config: f.configPath, workspace, "local-cli": wrapper, harness: "codex", senders: [ownerId] });

    const ag = setupAntigravity({ alias: "mini", codexSessions: true }, f.configPath);
    const conf = readPrivateJson(f.configPath);
    const policy = readSessionMessagingPolicy(conf.sessionMessaging.integrationPath);
    assert.ok(policy.codex.allowedSenders.includes(ag.senderId));
    assert.ok(!policy.allowedSenders.includes(ag.senderId));

    const codexSid = randomUUID();
    const claudeSid = randomUUID();
    const codexAddr = sessionAddress(policy.installationId, workspace, `codex:${codexSid}`);
    const claudeAddr = sessionAddress(policy.installationId, workspace, claudeSid);

    await f.start();
    for (const [sid, harness] of [[codexSid, "codex"], [claudeSid, "claude"]]) {
      await runSessionDiscoveryHook({
        configPath: f.configPath,
        harness,
        input: Readable.from([JSON.stringify({ session_id: sid, cwd: workspace, hook_event_name: "SessionStart" })]),
      });
    }
    const attach = async (sid, harness) => {
      const c = f.client();
      extraClients.push(c);
      const grant = await c.attachSession({ installationId: policy.installationId, secret: policy.secret, sessionId: sid, childId: randomUUID(), harness, wakeCapable: false });
      return { c: f.client(grant.senderId), rpc: { credential: grant.credential } };
    };
    const codexAttached = await attach(codexSid, "codex");
    await attach(claudeSid, "claude");

    // Antigravity dynamically sees and reaches newly attached Codex chat, NOT ungranted Claude chat.
    const listed = JSON.parse((await f.mcp("mini", [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_list_sessions", arguments: {} } },
    ]))[1].result.content[0].text);
    assert.deepEqual(listed.sessions.map((r) => r.id), [codexAddr]);

    const toCodex = await f.mcp("mini", [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_send_message", arguments: { to: codexAddr, text: "run checks", messageId: "to-cdx-1", requestId: "req-cdx-1" } } },
    ]);
    assert.equal(toCodex[1].result.isError, false);
    assert.equal((await codexAttached.c.listInbox({}, codexAttached.rpc)).items?.[0]?.messageId ?? (await codexAttached.c.listInbox({}, codexAttached.rpc))[0].messageId, "to-cdx-1");

    const toClaudeDenied = await f.mcp("mini", [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_send_message", arguments: { to: claudeAddr, text: "no", messageId: "to-cld-deny", requestId: "req-cld-deny" } } },
    ]);
    assert.equal(toClaudeDenied[1].result.isError, true);
    assert.match(toClaudeDenied[1].result.content[0].text, /recipient_not_allowed/);

    // Revoking codex-sessions updates policy, flags restart required, and blocks exchange until restarted.
    const revoked = updateAntigravityGrants("revoke", { alias: "mini", codexSessions: true }, f.configPath);
    assert.equal(revoked.changed, true);
    assert.equal(revoked.requiresServiceRestart, true);
    const updatedPolicy = readSessionMessagingPolicy(conf.sessionMessaging.integrationPath);
    assert.ok(!updatedPolicy.codex.allowedSenders.includes(ag.senderId));

    // Host fails closed with binding_changed before restart, and enforces empty grants after restart.
    const staleCall = await f.mcp("mini", [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_get_status", arguments: {} } }]);
    assert.equal(staleCall[1].result.isError, true);
    assert.match(staleCall[1].result.content[0].text, /binding_changed/);
    await f.stop();
    await f.start();
    const afterRestart = await f.mcp("mini", [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_send_message", arguments: { to: codexAddr, text: "late", messageId: "to-cdx-2", requestId: "req-cdx-2" } } },
    ]);
    assert.equal(afterRestart[1].result.isError, true);
    assert.match(afterRestart[1].result.content[0].text, /recipient_not_allowed/);

    // Exact session-* grant admits only that session, not a second session of the same harness.
    const exactSecond = updateAntigravityGrants("grant", { alias: "mini", recipients: [claudeAddr] }, f.configPath);
    assert.deepEqual(exactSecond.allowedRecipients, [claudeAddr]);
    await f.stop();
    await f.start();
    const exactSend = await f.mcp("mini", [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_send_message", arguments: { to: claudeAddr, text: "exact", messageId: "to-cld-exact", requestId: "req-cld-exact" } } },
    ]);
    assert.equal(exactSend[1].result.isError, false);

    // Disabling immediately fences live use and new MCP launches.
    disableAntigravity({ alias: "mini" }, f.configPath);
    await assert.rejects(
      f.mcp("mini", [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_get_status", arguments: {} } }]),
      /session_disabled/
    );
  } finally {
    for (const c of extraClients) await c.close();
    await f.close();
  }
});

test("createDestinationPermissions enforces Antigravity session and harness grants cleanly", async () => {
  const perms = createDestinationPermissions({
    sessionBroker: {
      mayMessageSession: async () => true,
      mayMessageHarness: async () => true,
      sessionHarness: async () => "codex",
    },
    antigravityBroker: {
      has: (id) => id === "ag",
      allowsHarness: (_id, h) => h === "codex",
      checkAllowed: async (s, _to, sb) => {
        if (s === "ag" && (await sb.sessionHarness(_to)) !== "codex") throw new Error("denied");
      },
    },
  });
  assert.equal(await perms.mayMessageHarness("ag", "codex"), true);
  assert.equal(await perms.mayMessageHarness("ag", "claude"), false);
  assert.equal(await perms.mayMessageIgnoringLiveness("ag", `session-${"b".repeat(64)}`), true);
});
