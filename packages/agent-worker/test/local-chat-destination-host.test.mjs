// What a destination rule shows to whom, on a real installed host (real policy, ACL, session broker, MCP children, registry and router), as the
// review of #180 to #182 asked (M1, M4). The scripted-ACL tests in local-chat-destination-acl.test.mjs pin the gate's arguments; this file pins what
// the real policy does with them. Principal RHEA has a destination rule for the workspace and NORA has none.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { editSessionGrant, runSessionDiscoveryHook, setupLocalMessaging, setupRouter, setupSessionDiscovery, setupWorkspaceMessaging } from "../src/local-messaging-cli.mjs";
import { readPrivateJson, writePrivateJson } from "../src/local-messaging-auth-broker.mjs";
import { createInstalledLocalMessagingHost } from "../src/local-messaging-host.mjs";
import { createProfiledReasonerGate } from "../src/concurrency-gate.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { resolveLocalSocketAddress } from "../src/local-messaging-address.mjs";
import { createAttachedClaudeSessionMcpChild } from "../src/claude-session-mcp-child.mjs";
import { readIdentityRegistry, setIdentityDestination, updateIdentityRegistry } from "../src/identity-registry.mjs";
import { sessionAddress, sessionAddressKey } from "../src/local-messaging-interactive-session.mjs";
import { CHAT_MAPPING_FILENAME, confirmChatMapping, deriveChatSelectorId, setChatMapping } from "../src/local-chat-mapping.mjs";
import { bindProfileInRegistry, initIdentityRegistry } from "./local-messaging-identity-fixtures.mjs";
import { upgradeThroughWriter } from "./identity-registry-v2-helpers.mjs";

const SHORT_TMP = fs.existsSync("/private/tmp") ? "/private/tmp" : "/tmp"; // unix socket paths must stay short

async function tool(child, name, args = {}) {
  const r = await child.handleRequest({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } });
  if (r.result.isError) return { ok: false, text: r.result.content[0].text };
  return { ok: true, value: JSON.parse(r.result.content[0].text) };
}

async function world({ exactOnly = false, replyIdentity = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(SHORT_TMP, "dhost-")));
  fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const realWs = fs.realpathSync(workspace);
  const wrapper = path.join(root, "triangle-local");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const configPath = path.join(root, "local.json");
  const bindingPath = path.join(root, "binding.json");
  writePrivateJson(bindingPath, { instanceId: "a".repeat(64) });
  setupLocalMessaging({ config: configPath, "desktop-binding": bindingPath, "thread-id": "dhost-thread", recipients: ["gravity2"] });
  setupSessionDiscovery({ config: configPath, workspace, "local-cli": wrapper });
  setupWorkspaceMessaging({ config: configPath, workspace, "local-cli": wrapper, ...(exactOnly ? { exactOnly: true } : {}) });
  const config = readPrivateJson(configPath);
  const identityRoot = path.join(root, "identity");
  fs.mkdirSync(identityRoot, { mode: 0o700 });
  initIdentityRegistry(identityRoot);
  bindProfileInRegistry(identityRoot, "gravity2", 1);
  const rhea = bindProfileInRegistry(identityRoot, "rhea", 2);
  const nora = bindProfileInRegistry(identityRoot, "nora", 3);
  upgradeThroughWriter(identityRoot, { now: new Date().toISOString() });
  setIdentityDestination({ root: identityRoot, expectedSequence: readIdentityRegistry({ root: identityRoot }).registry.sequence, principalId: rhea.principal_id, harness: "claude", workspace: realWs });
  setupRouter({ enable: true, registryRoot: identityRoot, stateRoot: config.stateRoot });
  if (replyIdentity) writePrivateJson(path.join(path.dirname(configPath), "reply-identity.json"), { version: 1, enabled: true });
  const runner = { run: async () => ({ status: "completed", text: "worker result" }) };
  const host = createInstalledLocalMessagingHost({
    configPath, runners: new Map(config.recipients.map((r) => [r.instanceId, runner])), gate: createProfiledReasonerGate(),
    logger: { info() {}, error() {}, warn() {} }, timerIntervalMs: 60000,
    wakeAdapter: { notify: async (binding) => ({ state: "accepted", receipt: { queuedId: randomUUID(), threadId: binding.threadId } }) },
  });
  await host.start();
  const socketPath = resolveLocalSocketAddress({ stateRoot: config.stateRoot }).socketPath;
  const desktop = readPrivateJson(config.integrationPath);
  const owner = createLocalControlClient({ socketPath, senderId: desktop.senderId });
  const grant = async () => (await owner.exchangeTurnBinding({ bindingId: desktop.bindingId, threadId: desktop.threadId, secret: desktop.secret })).credential;
  const lifecycle = (sessionId, kind) => runSessionDiscoveryHook({ configPath, input: Readable.from([JSON.stringify({ session_id: sessionId, cwd: workspace, hook_event_name: kind })]), stderr: { write() {} } });
  const children = [];
  // `started` is for a chat whose lifecycle start was announced earlier, because its address had to be known before it attached
  const chat = async ({ sid = randomUUID(), started = false } = {}) => {
    if (!started) await lifecycle(sid, "SessionStart");
    const child = await createAttachedClaudeSessionMcpChild({ configPath, cwd: workspace, policyPath: config.sessionMessaging.integrationPath, expectedVersion: "2.1.307", env: { CLAUDE_CODE_SESSION_ID: sid }, wakeIntervalMs: 0 });
    children.push(child);
    const status = await tool(child, "triangle_get_status");
    return { child, address: status.value.senderId };
  };
  return {
    config, configPath, realWs, rhea, nora, owner, grant, chat, lifecycle, identityRoot,
    async close() {
      for (const c of children) { try { await c.close(); } catch { /* already gone */ } }
      await owner.close();
      await host.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const routerOf = async (w) => (await w.owner.localStatus({ credential: await w.grant() })).router;
function delta(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before.errors), ...Object.keys(after.errors)])) {
    const d = (after.errors[k] ?? 0) - (before.errors[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  for (const k of Object.keys(after.resolved)) {
    const d = after.resolved[k] - before.resolved[k];
    if (d !== 0) out[`resolved.${k}`] = d;
  }
  return out;
}

let n = 0;
// What a chat is told, with the retry hint (which carries fresh message ids) cut off, and what the router counted for it.
async function fromChat(w, chat, to) {
  const before = await routerOf(w);
  const r = await tool(chat.child, "triangle_send_message", { to, text: "hi", messageId: `m${(n += 1)}`, requestId: `r${n}` });
  const after = await routerOf(w);
  return { answer: r.ok ? "accepted" : r.text.split(". To retry")[0], delta: delta(before, after) };
}
async function fromDesktop(w, to) {
  const credential = await w.grant();
  const before = await routerOf(w);
  let answer;
  try {
    const r = await w.owner.sendMessage({ to, text: "hi", messageId: `o${(n += 1)}` }, { credential });
    answer = r.accepted ? "accepted" : JSON.stringify(r);
  } catch (error) {
    answer = `${error.code}: ${error.message}`;
  }
  const after = await routerOf(w);
  return { answer, delta: delta(before, after) };
}

// The store states a destination can be in, each applied from scratch. `desktop` is what the desktop, which the owner policy lets message chats, is told.
function states(w, X) {
  const selectorId = deriveChatSelectorId({ harness: "claude", workspace: w.realWs });
  const file = path.join(w.config.stateRoot, CHAT_MAPPING_FILENAME);
  const reset = () => fs.rmSync(file, { force: true });
  const set = (generation = w.rhea.binding_generation) => setChatMapping({ storeRoot: w.config.stateRoot, selectorId, harness: "claude", workspace: w.realWs, principalId: w.rhea.principal_id, authorityOrigin: w.rhea.authority_origin, bindingGeneration: generation });
  const confirm = () => confirmChatMapping({ storeRoot: w.config.stateRoot, selectorId, attachedSessions: [{ address: X.address, harness: "claude", workspace: w.realWs }] });
  return [
    { name: "no store", apply: () => reset(), desktop: "chat_mapping_missing" },
    { name: "pending", apply: () => { reset(); set(); }, desktop: "chat_mapping_unconfirmed" },
    { name: "stale generation", apply: () => { reset(); set(2); }, desktop: "chat_mapping_stale_generation" },
    { name: "corrupt", apply: () => { reset(); fs.writeFileSync(file, "{ nope", { mode: 0o600 }); }, desktop: "chat_mapping_corrupt" },
    { name: "custody 0644", apply: () => { reset(); set(); fs.chmodSync(file, 0o644); }, desktop: "chat_mapping_custody" },
    { name: "confirmed, chat online", apply: () => { reset(); set(); confirm(); }, desktop: null },
  ];
}

test("a chat that the policy does not allow is answered as for a principal with no rule in every state; the desktop is told each state", async () => {
  const w = await world();
  try {
    const X = await w.chat();
    const Y = await w.chat(); // an attached chat with no grant of any kind
    for (const state of states(w, X)) {
      state.apply();
      const toRule = await fromChat(w, Y, w.rhea.principal_id);
      const toNone = await fromChat(w, Y, w.nora.principal_id);
      assert.match(toNone.answer, /route_unavailable/, `${state.name}: the baseline for a principal with no rule`);
      assert.deepEqual(toRule, toNone, `${state.name}: a chat without a grant is told what it is told for a principal with no rule`);
      assert.deepEqual(toRule.delta, { route_unavailable: 1 }, `${state.name}: and the counters move the same way`);

      const desktopRule = await fromDesktop(w, w.rhea.principal_id);
      if (state.desktop === null) {
        assert.equal(desktopRule.answer, "accepted", `${state.name}: the desktop may message the chat`);
        assert.deepEqual(desktopRule.delta, { "resolved.principal": 1 }, state.name);
      } else {
        assert.match(desktopRule.answer, new RegExp(`^${state.desktop}:`), `${state.name}: the desktop is told the state`);
        assert.deepEqual(desktopRule.delta, { [state.desktop]: 1 }, state.name);
      }
      const desktopNone = await fromDesktop(w, w.nora.principal_id);
      assert.match(desktopNone.answer, /^route_unavailable:/, `${state.name}: the desktop's baseline for a principal with no rule`);
    }
    // the mapped chat goes away: the policy still allows the desktop, so it is told; the chat without a grant is still told nothing
    await X.child.close();
    const gone = await fromDesktop(w, w.rhea.principal_id);
    assert.match(gone.answer, /^destination_session_offline:/);
    assert.deepEqual(gone.delta, { destination_session_offline: 1 });
    const toRule = await fromChat(w, Y, w.rhea.principal_id);
    const toNone = await fromChat(w, Y, w.nora.principal_id);
    assert.deepEqual(toRule, toNone, "an offline chat is no way for a chat without a grant to find the rule");
  } finally {
    await w.close();
  }
});

test("under an exact-only policy the desktop is told nothing, and a chat that holds an exact pair with the mapped chat is told once the chat is pinned", async () => {
  const w = await world({ exactOnly: true });
  try {
    const X = await w.chat();
    const Y = await w.chat();
    editSessionGrant("grant-session", { config: w.configPath, senders: [Y.address], to: X.address });
    for (const state of states(w, X)) {
      state.apply();
      const desktopRule = await fromDesktop(w, w.rhea.principal_id);
      const desktopNone = await fromDesktop(w, w.nora.principal_id);
      assert.match(desktopRule.answer, /^route_unavailable:/, `${state.name}: an exact-only policy lets the desktop message no chat, so it is told nothing`);
      assert.deepEqual(desktopRule, desktopNone, state.name);
      if (state.desktop !== null) {
        // an exact pair names one chat, so before a chat is pinned there is nothing it can answer
        const toRule = await fromChat(w, Y, w.rhea.principal_id);
        const toNone = await fromChat(w, Y, w.nora.principal_id);
        assert.deepEqual(toRule, toNone, `${state.name}: a pair holder is told nothing before a chat is pinned`);
      }
    }
    await X.child.close();
    const pairHolder = await fromChat(w, Y, w.rhea.principal_id);
    assert.match(pairHolder.answer, /destination_session_offline/, "once the mapped chat is pinned its pair holder is told what is wrong with it");
    const desktop = await fromDesktop(w, w.rhea.principal_id);
    assert.match(desktop.answer, /^route_unavailable:/, "the desktop, which has no pair, still is not");
  } finally {
    await w.close();
  }
});

test("a chat carries its principal as a sender only while the owner's mapping and the live binding both hold (M2, M3, I2)", async () => {
  const w = await world({ replyIdentity: true });
  try {
    // A chat's credential covers the receivers that are live and granted when it attaches: announce both chats, grant, attach the receiver, then the sender.
    const policy = readPrivateJson(w.config.sessionMessaging.integrationPath);
    const sids = { X: randomUUID(), Y: randomUUID() };
    const address = (sid) => sessionAddress(policy.installationId, policy.workspace, sessionAddressKey("claude", sid));
    await w.lifecycle(sids.X, "SessionStart");
    await w.lifecycle(sids.Y, "SessionStart");
    editSessionGrant("grant-session", { config: w.configPath, senders: [address(sids.X)], to: address(sids.Y) });
    const Y = await w.chat({ sid: sids.Y, started: true });
    const X = await w.chat({ sid: sids.X, started: true });
    assert.equal(X.address, address(sids.X));
    const principalSeenBy = async (messageId) => {
      const sent = await tool(X.child, "triangle_send_message", { to: Y.address, text: "request", messageId, requestId: `req-${messageId}` });
      assert.equal(sent.ok, true, sent.text);
      const inbox = await tool(Y.child, "triangle_list_inbox");
      const message = inbox.value.items.find((m) => m.messageId === messageId);
      assert.ok(message, "the request reached the receiver");
      return message.senderProvenance.principal;
    };
    assert.equal(await principalSeenBy("m-unmapped"), null, "a chat without a mapping has no principal");

    const selectorId = deriveChatSelectorId({ harness: "claude", workspace: w.realWs });
    setChatMapping({ storeRoot: w.config.stateRoot, selectorId, harness: "claude", workspace: w.realWs, principalId: w.rhea.principal_id, authorityOrigin: w.rhea.authority_origin, bindingGeneration: w.rhea.binding_generation });
    assert.equal(await principalSeenBy("m-pending"), null, "a mapping that is not confirmed gives none");
    confirmChatMapping({ storeRoot: w.config.stateRoot, selectorId, attachedSessions: [{ address: X.address, harness: "claude", workspace: w.realWs }] });
    assert.equal(await principalSeenBy("m-confirmed"), w.rhea.principal_id, "a confirmed mapping on a live binding labels the chat");

    // the owner's mapping file alone is not authority: once the binding is revoked in the registry the chat has no principal
    updateIdentityRegistry({
      root: w.identityRoot, expectedSequence: readIdentityRegistry({ root: w.identityRoot }).registry.sequence, now: new Date().toISOString(), action: "revoke", subject: w.rhea.profile_instance_id,
      mutate: (registry) => { registry.bindings[w.rhea.profile_instance_id].revoked_at = new Date().toISOString(); return registry; },
    });
    assert.equal(await principalSeenBy("m-revoked"), null, "a revoked binding takes the label away on the next send");
  } finally {
    await w.close();
  }
});
