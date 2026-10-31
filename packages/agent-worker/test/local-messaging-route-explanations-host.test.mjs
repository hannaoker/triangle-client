import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import {
  setupLocalMessaging,
  setupSessionDiscovery,
  setupWorkspaceMessaging,
  setupDesktopInbox,
  setupRouter,
  runSessionDiscoveryHook,
  runLocalMessagingCLI,
} from "../src/local-messaging-cli.mjs";
import { readPrivateJson, writePrivateJson } from "../src/local-messaging-auth-broker.mjs";
import { createInstalledLocalMessagingHost } from "../src/local-messaging-host.mjs";
import { createProfiledReasonerGate } from "../src/concurrency-gate.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createLocalMessagingMcpHandler } from "../src/local-messaging-mcp-adapter.mjs";
import { resolveLocalSocketAddress } from "../src/local-messaging-address.mjs";
import { createAttachedClaudeSessionMcpChild } from "../src/claude-session-mcp-child.mjs";
import { REGISTRY_FILE_NAME } from "../src/identity-registry.mjs";
import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { ATTACH_HINT } from "../src/local-messaging-interactive-session.mjs";
import { initIdentityRegistry, bindProfileInRegistry, seedLegacyProfileBinding } from "./local-messaging-identity-fixtures.mjs";

// The same questions as the scripted-broker tests, answered by a real supervisor host: real owner configuration, receiver
// policy, lifecycle discovery, attached MCP children, identity registry and router, over the real socket, MCP handlers and
// owner CLI. Workers: gravity2 has its own principal, gravity3 and gravity4 share one.

const PROFILES = ["gravity2", "gravity3", "gravity4"];

async function fixture({ router = true, workspaceMessaging = true, inbox = false } = {}) {
  const root = fs.mkdtempSync("/private/tmp/tri-route-host-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const wrapper = path.join(root, "triangle-local");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const configPath = path.join(root, "local.json");
  const bindingPath = path.join(root, "binding.json");
  writePrivateJson(bindingPath, { instanceId: "a".repeat(64) });
  setupLocalMessaging({ config: configPath, "desktop-binding": bindingPath, "thread-id": "route-host-thread", recipients: PROFILES });
  if (workspaceMessaging) {
    setupSessionDiscovery({ config: configPath, workspace, "local-cli": wrapper });
    setupWorkspaceMessaging({ config: configPath, workspace, "local-cli": wrapper });
  }
  const config = readPrivateJson(configPath);
  const identityRoot = path.join(root, "identity");
  const bindings = {};
  if (router) {
    fs.mkdirSync(identityRoot, { mode: 0o700 });
    initIdentityRegistry(identityRoot);
    bindings.gravity2 = bindProfileInRegistry(identityRoot, "gravity2", 1);
    bindings.gravity3 = bindProfileInRegistry(identityRoot, "gravity3", 2);
    bindings.gravity4 = seedLegacyProfileBinding(identityRoot, "gravity4", 3, { principal_id: bindings.gravity3.principal_id });
    setupRouter({ enable: true, registryRoot: identityRoot, stateRoot: config.stateRoot });
  }
  const desktop = readPrivateJson(config.integrationPath);
  const runs = [];
  const wakes = [];
  const clients = [];
  const children = [];
  let host;
  const start = async () => {
    const runner = { run: async (request) => { runs.push(request); return { status: "completed", text: "worker result" }; } };
    host = createInstalledLocalMessagingHost({
      configPath,
      runners: new Map(readPrivateJson(configPath).recipients.map((r) => [r.instanceId, runner])),
      gate: createProfiledReasonerGate(),
      logger: { info() {}, error() {}, warn() {} },
      timerIntervalMs: 60000,
      wakeAdapter: { notify: async (binding) => { wakes.push(binding); return { state: "accepted", receipt: { queuedId: randomUUID(), threadId: binding.threadId } }; } },
    });
    await host.start();
  };
  if (inbox) setupDesktopInbox({ config: configPath, senders: ["b".repeat(64)] });
  await start();
  const socketPath = resolveLocalSocketAddress({ stateRoot: config.stateRoot }).socketPath;
  const client = (senderId) => {
    const c = createLocalControlClient({ socketPath, senderId });
    clients.push(c);
    return c;
  };
  const owner = client(desktop.senderId);
  const grant = async () => (await owner.exchangeTurnBinding({ bindingId: desktop.bindingId, threadId: desktop.threadId, secret: desktop.secret })).credential;
  const lifecycle = (sessionId, kind) => runSessionDiscoveryHook({
    configPath,
    input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: workspace, hook_event_name: kind })]),
    stderr: { write() {} },
  });
  // An opted-in chat whose host process is demonstrably alive, with no Triangle MCP child attached.
  const registerLive = async (sessionId) => {
    const discovery = readPrivateJson(config.discovery.integrationPath);
    const hostStart = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).toString().trim();
    const event = { eventId: randomUUID(), sessionId, kind: "start", workspace, observedAt: Date.now(), host: { pid: process.pid, start: hostStart, scope: "session" } };
    const auth = { installationId: discovery.installationId, secret: discovery.secret };
    const { nonce } = await owner.discoveryChallenge({ ...auth, event });
    await owner.reportDiscovery({ ...auth, nonce, event });
  };
  const child = async (sessionId) => {
    const c = await createAttachedClaudeSessionMcpChild({
      configPath,
      cwd: workspace,
      policyPath: config.sessionMessaging.integrationPath,
      expectedVersion: "2.1.307",
      env: { CLAUDE_CODE_SESSION_ID: sessionId },
      wakeIntervalMs: 0,
    });
    children.push(c);
    return c;
  };
  const cli = async (args) => {
    let out = "";
    await runLocalMessagingCLI([...args, "--config", configPath], { output: { write: (s) => { out += s; } } });
    return JSON.parse(out);
  };
  return {
    root, workspace, configPath, config, desktop, bindings, runs, wakes, owner, grant, lifecycle, registerLive, child, cli, client, identityRoot,
    async restart() { await host.stop(); await start(); },
    async close() {
      for (const c of children) await c.close();
      for (const c of clients) await c.close();
      await host?.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function tool(child, name, args = {}) {
  const r = await child.handleRequest({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } });
  if (r.result.isError) throw new Error(r.result.content[0].text);
  return JSON.parse(r.result.content[0].text);
}

const rowOf = (rows, id) => rows.find((row) => row.id === id);
const instanceOf = (f, profile) => f.config.recipients.find((r) => r.profile === profile).instanceId;

test("a real host explains workers, an attached chat, an unattached chat and an ended chat the same way in sessions and discover", async () => {
  const f = await fixture();
  try {
    const [attachedId, idleId, endedId] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [attachedId, idleId, endedId]) await f.lifecycle(id, "SessionStart");
    const attached = await f.child(attachedId);
    const attachedAddress = (await tool(attached, "triangle_get_status")).senderId;
    await f.registerLive(idleId); // a second start event for the same chat adds the live host process evidence
    await f.lifecycle(endedId, "SessionEnd");

    const credential = await f.grant();
    const rows = await f.owner.listSessions({ credential });
    const details = await f.owner.discoverRecipientDetails({ credential });
    const g2 = rowOf(rows, instanceOf(f, "gravity2"));
    const g3 = rowOf(rows, instanceOf(f, "gravity3"));
    assert.deepEqual([g2.principal, g2.principalState, g2.route], [f.bindings.gravity2.principal_id, "bound", "local"]);
    assert.deepEqual(g2.send, { permitted: true, addressKinds: ["id", "principal"] });
    assert.deepEqual(g3.send, { permitted: true, addressKinds: ["id"] }, "a principal shared by two local workers is not an address for either");

    const live = rows.find((row) => row.id.startsWith("session-") && row.id === attachedAddress);
    assert.deepEqual([live.attachment, live.capabilities.reachable, live.send.permitted, live.principalState], ["attached", true, true, "unbound"]);

    const unattached = rows.filter((row) => row.id.startsWith("session-") && row.attachment === "not-attached");
    assert.equal(unattached.length, 1);
    const [idle] = unattached;
    assert.equal(idle.presence, "online", "its host process is alive");
    assert.equal(idle.presenceEvidence.kind, "host-process");
    assert.equal(idle.presenceEvidence.scope, "session");
    assert.equal(idle.attachmentHint, ATTACH_HINT);
    assert.equal(idle.capabilities.reachable, false);
    assert.equal(idle.delivery.state, "not_attached");
    assert.deepEqual(idle.send, { permitted: true, addressKinds: ["id"] });
    assert.equal(JSON.stringify(idle).includes(String(process.pid)), false, "no raw process detail reaches the agent");
    await assert.rejects(f.owner.sendMessage({ to: idle.id, text: "anyone?", messageId: "m-idle" }, { credential }), { code: "session_offline" });

    const ended = rows.find((row) => row.attachment === "ended");
    assert.deepEqual([ended.presence, ended.delivery.state, ended.send.permitted], ["offline", "session_ended", true]);

    // discover lists exactly the entries a send can reach now, with the same explanation as the matching session rows.
    assert.deepEqual([...details.recipients].sort(), [instanceOf(f, "gravity2"), instanceOf(f, "gravity3"), instanceOf(f, "gravity4"), attachedAddress].sort());
    for (const entry of details.entries) {
      const row = rowOf(rows, entry.id);
      assert.deepEqual({ principal: row.principal, principalState: row.principalState, route: row.route, send: row.send }, { principal: entry.principal, principalState: entry.principalState, route: entry.route, send: entry.send }, entry.id);
    }
    assert.ok(!details.recipients.includes(idle.id) && !details.recipients.includes(ended.id));

    // The owner CLI and the bound MCP tools hand on the same explanation.
    const viaCli = await f.cli(["sessions"]);
    assert.deepEqual(viaCli.sessions.map((row) => row.id).sort(), rows.map((row) => row.id).sort());
    assert.deepEqual(rowOf(viaCli.sessions, instanceOf(f, "gravity2")).send, g2.send);
    const viaCliDiscover = await f.cli(["discover"]);
    assert.deepEqual(viaCliDiscover.entries.map((entry) => entry.id).sort(), details.entries.map((entry) => entry.id).sort());
    assert.deepEqual(viaCliDiscover.entries.find((entry) => entry.id === instanceOf(f, "gravity2")).send, g2.send);

    // A chat sees the directory through its own MCP child with the same explanation, relative to that chat.
    const seenByChat = await tool(attached, "triangle_list_sessions");
    assert.deepEqual(rowOf(seenByChat.sessions, instanceOf(f, "gravity2")).send, { permitted: true, addressKinds: ["id", "principal"] });
    assert.ok(seenByChat.sessions.every((row) => row.route === "local" && typeof row.send.permitted === "boolean"));
  } finally {
    await f.close();
  }
});

test("principal, legacy id, profile and session addressing all keep working, and the listing predicts which succeed", async () => {
  const f = await fixture();
  try {
    const sid = randomUUID();
    await f.lifecycle(sid, "SessionStart");
    const attached = await f.child(sid);
    const address = (await tool(attached, "triangle_get_status")).senderId;
    const credential = await f.grant();
    const send = (to, suffix) => f.owner.sendMessage({ to, text: `hello ${suffix}`, messageId: `m-${suffix}`, requestId: `r-${suffix}` }, { credential });

    const byPrincipal = await send(f.bindings.gravity2.principal_id, "principal");
    assert.deepEqual([byPrincipal.accepted, byPrincipal.target.via, byPrincipal.target.profile], [true, "principal", "gravity2"]);
    const byId = await send(instanceOf(f, "gravity3"), "id");
    assert.deepEqual([byId.accepted, byId.target.via], [true, "id"]);
    const bySession = await send(address, "session");
    assert.equal(bySession.accepted, true);
    await assert.rejects(send(f.bindings.gravity3.principal_id, "ambiguous"), { code: "recipient_ambiguous" });

    const viaProfile = await f.cli(["send", "--to", "gravity4", "--text", "by profile", "--message-id", "m-profile", "--request-id", "r-profile"]);
    assert.equal(viaProfile.admission.accepted, true);

    const rows = await f.owner.listSessions({ credential: await f.grant() });
    assert.ok(rows.filter((row) => row.send?.permitted).every((row) => row.send.addressKinds.includes("id")));
    assert.equal(rowOf(rows, instanceOf(f, "gravity3")).send.addressKinds.includes("principal"), false, "the listing agreed with the refused principal send");
  } finally {
    await f.close();
  }
});

test("read-only discovery and status enroll nothing, send nothing and wake nothing", async () => {
  const f = await fixture({ inbox: true });
  try {
    const sid = randomUUID();
    await f.lifecycle(sid, "SessionStart");
    const attached = await f.child(sid);
    await tool(attached, "triangle_get_status");
    await f.registerLive(randomUUID());
    const credential = await f.grant();
    const files = [
      path.join(f.identityRoot, REGISTRY_FILE_NAME),
      path.join(f.config.stateRoot, "router.json"),
      f.configPath,
      f.config.sessionMessaging.integrationPath,
      f.config.discovery.integrationPath,
      f.config.integrationPath,
    ].filter((file) => fs.existsSync(file));
    const bytes = () => files.map((file) => fs.readFileSync(file, "utf8"));
    const observe = async () => {
      const status = await f.owner.localStatus({ credential });
      return JSON.stringify({ journal: status.journal, dispatcher: status.dispatcher, wake: status.wake, resolved: status.router.resolved, errors: status.router.errors, discovery: status.discovery });
    };
    const before = { files: bytes(), state: await observe(), runs: f.runs.length, wakes: f.wakes.length };

    const bound = createLocalMessagingMcpHandler({ client: f.owner, turnCredentialProvider: f.grant });
    const callBound = (name) => bound.handleRequest({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: {} } });
    for (let i = 0; i < 3; i++) {
      await f.owner.listSessions({ credential });
      await f.owner.discoverRecipientDetails({ credential });
      await callBound("triangle_list_sessions");
      await callBound("triangle_list_recipients");
      await callBound("triangle_get_status");
      await tool(attached, "triangle_list_sessions");
      await tool(attached, "triangle_list_recipients");
      await tool(attached, "triangle_get_status");
      await f.cli(["sessions"]);
      await f.cli(["discover"]);
      await f.cli(["status"]);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(bytes(), before.files, "no configuration, policy or registry file changed");
    assert.equal(await observe(), before.state, "journal, dispatcher, wake, discovery and router counters did not move");
    assert.equal(f.runs.length, before.runs);
    assert.equal(f.wakes.length, before.wakes);
  } finally {
    await f.close();
  }
});

test("the owner status explains disabled reply identity and unbound chats without changing either", async () => {
  const f = await fixture();
  try {
    const policyPath = path.join(path.dirname(f.configPath), "reply-identity.json");
    const status = async () => (await f.cli(["status"]));

    let host = await status();
    assert.deepEqual(host.replyIdentity, { enabled: false, scope: "attached-chat-pairs" }, "the existing block keeps its exact shape");
    assert.deepEqual(Object.keys(host.identity.replyIdentity).sort(), ["nextAction", "reason", "state", "summary"]);
    assert.deepEqual([host.identity.replyIdentity.state, host.identity.replyIdentity.reason], ["disabled", "policy_absent"]);
    assert.match(host.identity.replyIdentity.summary, /not pinned/);
    assert.match(host.identity.replyIdentity.summary, /already pinned/i);
    assert.match(host.identity.replyIdentity.nextAction, /setup-reply-identity/);
    assert.match(host.identity.replyIdentity.nextAction, /owner/i);
    assert.deepEqual(Object.keys(host.identity.chats).sort(), ["binding", "nextAction", "summary"]);
    assert.equal(host.identity.chats.binding, "unbound");
    assert.match(host.identity.chats.summary, /no principal/i);
    assert.match(host.identity.chats.summary, /local-attested/);
    assert.match(host.identity.chats.nextAction, /owner decision/i);

    writePrivateJson(policyPath, { version: 1, enabled: false });
    host = await status();
    assert.deepEqual([host.identity.replyIdentity.state, host.identity.replyIdentity.reason, host.replyIdentity.enabled], ["disabled", "policy_disabled", false]);

    writePrivateJson(policyPath, { version: 1, enabled: "invalid" });
    host = await status();
    assert.deepEqual([host.identity.replyIdentity.state, host.identity.replyIdentity.reason, host.replyIdentity.error], ["disabled", "policy_invalid", "invalid_reply_identity_policy"]);
    assert.match(host.identity.replyIdentity.summary, /fail/i);

    writePrivateJson(policyPath, { version: 1, enabled: true });
    host = await status();
    assert.deepEqual([host.identity.replyIdentity.state, host.identity.replyIdentity.reason, host.replyIdentity.enabled], ["enabled", "policy_enabled", true]);

    // The explanation only reads: the policy file is exactly what the owner wrote.
    assert.deepEqual(readPrivateJson(policyPath), { version: 1, enabled: true });
    // No path, secret or binding value is repeated in any policy state.
    const forbidden = [f.root, policyPath, "secret", f.desktop.secret, f.desktop.bindingId, f.config.sessionMessaging.integrationPath, f.config.integrationPath];
    const states = [null, { version: 1, enabled: false }, { version: 1, enabled: "invalid" }, { version: 1, enabled: true }, { version: 2, enabled: true, extra: 1 }];
    for (const policy of states) {
      if (policy === null) fs.rmSync(policyPath, { force: true });
      else writePrivateJson(policyPath, policy);
      const text = JSON.stringify((await status()).identity);
      for (const value of forbidden) assert.ok(!text.includes(value), `${value} must not be repeated for ${JSON.stringify(policy)}`);
    }
  } finally {
    await f.close();
  }
});

test("without workspace messaging there are no attached chats to pin, and the owner status says so", async () => {
  const f = await fixture({ workspaceMessaging: false });
  try {
    const host = await f.cli(["status"]);
    assert.deepEqual(host.replyIdentity, { enabled: false, scope: "attached-chat-pairs" });
    assert.deepEqual([host.identity.replyIdentity.state, host.identity.replyIdentity.reason], ["not_applicable", "attached_chats_not_enabled"]);
    assert.equal(host.identity.chats.binding, "unbound");
  } finally {
    await f.close();
  }
});

test("status means one thing everywhere: an agent without a message ID gets its own view, the owner CLI the host's, a message ID that message's", async () => {
  const f = await fixture({ inbox: true });
  try {
    const sid = randomUUID();
    await f.lifecycle(sid, "SessionStart");
    const attached = await f.child(sid);
    const own = await tool(attached, "triangle_get_status");
    const ownKeys = ["generation", "inbox", "route", "senderId", "sessionId"];
    assert.deepEqual(Object.keys(own).sort(), ownKeys);

    const bound = createLocalMessagingMcpHandler({ client: f.owner, turnCredentialProvider: f.grant });
    const callBound = async (args) => {
      const response = await bound.handleRequest({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "triangle_get_status", arguments: args } });
      assert.equal(response.result.isError, false, response.result.content[0].text);
      return JSON.parse(response.result.content[0].text);
    };
    const boundOwn = await callBound({});
    assert.deepEqual(Object.keys(boundOwn).sort(), ownKeys);
    assert.equal(boundOwn.senderId, f.desktop.senderId);

    const hostOnly = ["journal", "dispatcher", "wake", "discovery", "router", "identity", "replyIdentity", "recipients"];
    for (const view of [own, boundOwn]) for (const key of hostOnly) assert.equal(key in view, false, `an agent's own view never has ${key}`);
    const host = await f.cli(["status"]);
    for (const key of hostOnly) assert.ok(key in host, `the owner view has ${key}`);

    // With a message ID every surface answers with that message's delivery observations. A chat's queue is stable
    // (nothing claims it), so the two readers see the same observation.
    const credential = await f.grant();
    const toChat = await f.owner.sendMessage({ to: own.senderId, text: "status probe", messageId: "m-status", requestId: "r-status" }, { credential });
    const viaBound = await callBound({ messageId: toChat.messageId });
    const viaCli = await f.cli(["status", "--message-id", toChat.messageId]);
    const viaRecipient = await tool(attached, "triangle_get_status", { messageId: toChat.messageId });
    for (const view of [viaBound, viaCli, viaRecipient]) {
      assert.equal(view.messageId, toChat.messageId);
      assert.ok(view.delivery.state && view.delivery.summary && view.delivery.nextAction);
      assert.ok(!("journal" in view) && !("inbox" in view));
    }
    assert.deepEqual(viaBound.delivery, viaCli.delivery);
    assert.deepEqual(viaRecipient.delivery, viaCli.delivery);
    // Someone who neither sent nor received the message is refused, on the attached surface too.
    const toWorker = await f.owner.sendMessage({ to: instanceOf(f, "gravity2"), text: "not yours", messageId: "m-private", requestId: "r-private" }, { credential });
    await assert.rejects(tool(attached, "triangle_get_status", { messageId: toWorker.messageId }), /foreign_access_denied/);
  } finally {
    await f.close();
  }
});

test("router off: the real host keeps the previous sessions and discover shapes", async () => {
  const f = await fixture({ router: false });
  try {
    const credential = await f.grant();
    const rows = await f.owner.listSessions({ credential });
    assert.ok(rows.length >= 3);
    for (const row of rows) for (const key of ["route", "principal", "principalState", "send"]) assert.equal(key in row, false, `${row.id} ${key}`);
    assert.deepEqual(Object.keys(await f.owner.discoverRecipientDetails({ credential })), ["recipients"]);
    assert.equal(deriveClientInstanceId("gravity2"), instanceOf(f, "gravity2"));
  } finally {
    await f.close();
  }
});
