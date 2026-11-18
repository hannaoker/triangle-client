// The workspace session broker's new questions and the binding check of a chat mapping (review of #180 to #182, M1 and the tests of I1, I2, H1).
// Real policy and discovery files, a real journal and the real broker; only the clock and the binding check are scripted.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { setupLocalMessaging, setupRouter, setupSessionDiscovery, setupWorkspaceMessaging, disableWorkspaceMessaging } from "../src/local-messaging-cli.mjs";
import { readPrivateJson, writePrivateJson } from "../src/local-messaging-auth-broker.mjs";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createWorkspaceSessionBroker } from "../src/local-messaging-interactive-session.mjs";
import { createChatBindingConfirmer } from "../src/local-messaging-host.mjs";
import { confirmChatMapping, deriveChatSelectorId, setChatMapping } from "../src/local-chat-mapping.mjs";
import { createRegistrySnapshotProvider } from "../src/router-registry-snapshot.mjs";
import { agentBindingV1, makeV1Root, upgradeThroughWriter } from "./identity-registry-v2-helpers.mjs";

const NOW = 1_800_000_000_000;
const OTHER_SENDER = "e".repeat(64);
const UNKNOWN_SESSION = "session-" + "f".repeat(64);
const ORIGIN = "https://triangle.example";

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/csb-"));
  fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const wrapper = path.join(root, "triangle-local");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const configPath = path.join(root, "local.json");
  const bindingPath = path.join(root, "binding.json");
  writePrivateJson(bindingPath, { instanceId: "a".repeat(64) });
  setupLocalMessaging({ config: configPath, "desktop-binding": bindingPath, "thread-id": "attachment-test-thread", recipients: ["gravity2"] });
  setupSessionDiscovery({ config: configPath, workspace, "local-cli": wrapper });
  setupWorkspaceMessaging({ config: configPath, workspace, "local-cli": wrapper });
  const config = readPrivateJson(configPath);
  const policyPath = config.sessionMessaging.integrationPath;
  const policy = readPrivateJson(policyPath);
  const discovery = readPrivateJson(config.discovery.integrationPath);
  const desktop = readPrivateJson(config.integrationPath).senderId;
  const scope = `${policy.installationId}:${createHash("sha256").update(policy.secret).digest("hex")}`;
  const journal = createLocalMessagingJournal({ stateRoot: config.stateRoot });
  t.after(async () => {
    await journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let seen = 0;
  const rows = async () => journal.listDiscoveredSessions({ installationId: policy.installationId, workspace: policy.workspace });
  const event = async (sessionId, kind) => journal.recordDiscoveryEvent({
    installationId: policy.installationId,
    event: { eventId: randomUUID(), sessionId, kind, workspace: policy.workspace, observedAt: NOW - 1000 + (seen += 1) },
    digest: "d" + seen, receivedAt: NOW,
  });
  // A new chat as the directory lists it, with the id its start event was recorded under (the row's own id is a hash of it).
  const start = async () => {
    const before = new Set((await rows()).map((r) => r.id));
    const sessionId = randomUUID();
    await event(sessionId, "start");
    const row = (await rows()).find((r) => !before.has(r.id));
    assert.ok(row, "the start event made a row");
    return { ...row, sessionId };
  };
  const attach = async (row, { at = NOW } = {}) => journal.attachDiscoveredSession({ id: row.id, childId: randomUUID(), generation: row.generation, installationId: scope, wakeCapable: false, now: at });
  const broker = (extra = {}) => createWorkspaceSessionBroker({
    policyPath, discoveryPath: config.discovery.integrationPath, journal, issue() {}, clock: () => NOW, ownerSenderId: desktop,
    configuredRecipients: config.recipients.map((r) => r.instanceId), ...extra,
  });
  return { root, config, configPath, policy, discovery, desktop, journal, start, event, rows, attach, broker, workspace: policy.workspace };
}

test("a session that is attached and live is listed; one that is not attached, has ended or has a lapsed lease is not (I1)", async (t) => {
  const f = await fixture(t);
  const live = await f.start();
  const edgeOn = await f.start();
  const notAttached = await f.start();
  const endedLater = await f.start();
  const lapsed = await f.start();
  const edgeOff = await f.start();
  await f.attach(live);
  await f.attach(edgeOn, { at: NOW - 29_999 }); // the lease runs out in one more millisecond
  await f.attach(endedLater);
  await f.attach(lapsed, { at: NOW - 120_000 });
  await f.attach(edgeOff, { at: NOW - 30_000 }); // the lease runs out exactly now, which is out
  await f.event(endedLater.sessionId, "end");
  const listed = await f.broker().listLiveAttachedSessions();
  assert.deepEqual(listed.map((s) => s.address).sort(), [live.id, edgeOn.id].sort());
  const one = listed.find((s) => s.address === live.id);
  assert.deepEqual({ ...one }, { address: live.id, harness: live.harness, workspace: f.workspace, generation: live.generation });
  assert.equal(Object.isFrozen(one), true);
  // the same chats are the ones a send could reach: the ordinary check passes for exactly those
  for (const row of [live, edgeOn]) await f.broker().checkRecipient(f.desktop, row.id);
  for (const row of [notAttached, endedLater, lapsed, edgeOff]) await assert.rejects(f.broker().checkRecipient(f.desktop, row.id), { code: "session_offline" }, row.id);
  // a policy that is switched off lists nothing
  disableWorkspaceMessaging({ config: f.configPath });
  await assert.rejects(f.broker().listLiveAttachedSessions());
});

test("who may message a session is the receiver policy alone, whether or not the session can be reached (mayMessageSession)", async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.start();
  const [attached, unattached] = await f.rows();
  await f.attach(attached);
  const broker = f.broker();
  assert.equal(await broker.mayMessageSession(f.desktop, attached.id), true);
  assert.equal(await broker.mayMessageSession(f.desktop, unattached.id), true, "a chat that is not attached is a chat the policy allows");
  // the ordinary check asks for the lease as well, which is what this one leaves out
  await broker.checkRecipient(f.desktop, attached.id);
  await assert.rejects(broker.checkRecipient(f.desktop, unattached.id), { code: "session_offline" });
  assert.equal(await broker.mayMessageSession(OTHER_SENDER, attached.id), false, "a sender the policy does not list");
  assert.equal(await broker.mayMessageSession(OTHER_SENDER, unattached.id), false);
  assert.equal(await broker.mayMessageSession(f.desktop, UNKNOWN_SESSION), false, "a chat nobody discovered");
  for (const to of ["", "agent_" + "1".repeat(32), "a".repeat(64), null, undefined, 7]) assert.equal(await broker.mayMessageSession(f.desktop, to), false, String(to));
  // the policy's ceiling is the live owner configuration: a sender it no longer lists is no longer allowed
  const narrowed = f.broker({ ownerSenderId: OTHER_SENDER });
  assert.equal(await narrowed.mayMessageSession(f.desktop, attached.id), false);
  // a policy that is switched off allows nothing and says nothing
  disableWorkspaceMessaging({ config: f.configPath });
  assert.equal(await broker.mayMessageSession(f.desktop, attached.id), false);
});

test("who may message chats of a harness is the owner's sender list for it; Codex is off here, and nothing else is a harness (mayMessageHarness)", async (t) => {
  const f = await fixture(t);
  const broker = f.broker();
  assert.equal(await broker.mayMessageHarness(f.desktop, "claude"), true);
  assert.equal(await broker.mayMessageHarness(OTHER_SENDER, "claude"), false);
  assert.equal(await broker.mayMessageHarness(f.desktop, "codex"), false, "Codex messaging is not enabled in this policy");
  for (const harness of ["gemini", "", null, undefined, "Claude"]) assert.equal(await broker.mayMessageHarness(f.desktop, harness), false, String(harness));
  assert.equal(await f.broker({ ownerSenderId: OTHER_SENDER }).mayMessageHarness(f.desktop, "claude"), false);
  disableWorkspaceMessaging({ config: f.configPath });
  assert.equal(await broker.mayMessageHarness(f.desktop, "claude"), false);
});

// ---- what labels a chat with its principal (I2)

test("a chat is labelled with a principal only while a confirmed mapping holds and its binding is live (I2)", async (t) => {
  const f = await fixture(t);
  await f.start();
  const [row] = await f.rows();
  await f.attach(row);
  const selectorId = deriveChatSelectorId({ harness: "claude", workspace: f.workspace });
  const principal = "agent_" + "1".repeat(32);
  const claims = [];
  const label = async (confirmChatBinding) => f.broker({ chatMappingStoreRoot: f.config.stateRoot, confirmChatBinding, logger: { warn() {} } }).describeLocalSession(row.id);

  // no mapping at all
  assert.deepEqual({ ...(await label(() => true)) }, { address: row.id, generation: row.generation, principal: null, authorityOrigin: null, bindingGeneration: null });
  setChatMapping({ storeRoot: f.config.stateRoot, selectorId, harness: "claude", workspace: f.workspace, principalId: principal, authorityOrigin: ORIGIN, bindingGeneration: 4, expectedSequence: 0 });
  assert.equal((await label(() => true)).principal, null, "a pending mapping labels nothing");
  confirmChatMapping({ storeRoot: f.config.stateRoot, selectorId, expectedSequence: 1, attachedSessions: [{ address: row.id, harness: "claude", workspace: f.workspace }] });
  const mapped = await label((claim) => { claims.push(claim); return true; });
  assert.deepEqual({ ...mapped }, { address: row.id, generation: row.generation, principal, authorityOrigin: ORIGIN, bindingGeneration: 4 });
  assert.deepEqual(claims, [{ principalId: principal, authorityOrigin: ORIGIN, bindingGeneration: 4 }], "the binding check is asked about exactly what the mapping claims");
  // the mapping file is not authority: anything but a clear yes from the binding check leaves the chat unlabeled
  for (const answer of [false, undefined, null, "true", 1, {}]) assert.equal((await label(() => answer)).principal, null, String(answer));
  assert.equal((await label(undefined)).principal, null, "no binding check at all labels nothing");
  assert.equal((await f.broker({ confirmChatBinding: () => true }).describeLocalSession(row.id)).principal, null, "no store at all labels nothing");
});

// ---- the binding check the host gives the broker (H1)

// A real v2 registry with a mesh binding for each name, and a client state root beside it, the layout the supervisor runs on.
function registryWorld(names = ["gravity2", "ghost"]) {
  const { base, root } = makeV1Root(names);
  upgradeThroughWriter(root);
  const stateRoot = path.join(base, "client", "local");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const binding = agentBindingV1(names[0]);
  return { dir: base, stateRoot, identityRoot: root, claim: { principalId: binding.principal_id, authorityOrigin: binding.authority_origin, bindingGeneration: binding.binding_generation } };
}

test("the binding check reads the registry the router reads, and a mapping against anything else does not hold (H1)", () => {
  const w = registryWorld();
  const other = makeV1Root(["someone-else"]);
  try {
    upgradeThroughWriter(other.root);
    setupRouter({ enable: true, registryRoot: w.identityRoot, stateRoot: w.stateRoot });
    const confirm = createChatBindingConfirmer({ stateRoot: w.stateRoot });
    assert.equal(confirm(w.claim), true);
    assert.equal(confirm({ ...w.claim, bindingGeneration: w.claim.bindingGeneration + 1 }), false);
    assert.equal(confirm({ ...w.claim, authorityOrigin: "https://other.example" }), false);
    assert.equal(confirm({ ...w.claim, principalId: "agent_" + "9".repeat(32) }), false);
    assert.equal(confirm({}), false);
    // the router names another registry: the check follows it, and a principal that is not bound there is not confirmed
    setupRouter({ enable: true, registryRoot: other.root, stateRoot: w.stateRoot });
    assert.equal(confirm(w.claim), false);
    setupRouter({ enable: true, registryRoot: w.identityRoot, stateRoot: w.stateRoot });
    assert.equal(confirm(w.claim), true, "and follows it back");
  } finally {
    fs.rmSync(w.dir, { recursive: true, force: true });
    fs.rmSync(other.base, { recursive: true, force: true });
  }
});

test("the binding check says no when anything goes wrong in asking, and asks again only when the registry root changes", () => {
  const claim = { principalId: "agent_" + "1".repeat(32), authorityOrigin: ORIGIN, bindingGeneration: 1 };
  const binding = { principal_id: claim.principalId, revoked_at: null, trust_mode: "mesh-managed", authority_origin: ORIGIN, binding_generation: 1 };
  const made = [];
  const provider = (root) => { made.push(root); return { get: () => ({ state: "ok", bindingsFor: () => [binding] }) }; };
  let registryRoot = "/fake/a";
  const confirm = createChatBindingConfirmer({ stateRoot: "/fake/client/local", loadRouter: () => ({ registryRoot }), createProvider: ({ root }) => provider(root) });
  assert.equal(confirm(claim), true);
  assert.equal(confirm(claim), true);
  assert.deepEqual(made, ["/fake/a"], "one provider while the root is the same");
  registryRoot = "/fake/b";
  assert.equal(confirm(claim), true);
  assert.deepEqual(made, ["/fake/a", "/fake/b"]);
  // without a configured root the registry is the one beside the client directory
  const defaulted = [];
  createChatBindingConfirmer({ stateRoot: "/fake/app/client/local", loadRouter: () => ({}), createProvider: ({ root }) => { defaulted.push(root); return { get: () => ({ state: "ok", bindingsFor: () => [binding] }) }; } })(claim);
  assert.deepEqual(defaulted, ["/fake/app/identity"]);
  // fail closed
  assert.equal(createChatBindingConfirmer({ stateRoot: "/x", loadRouter: () => { throw new Error("router.json is damaged"); } })(claim), false);
  assert.equal(createChatBindingConfirmer({ stateRoot: "/x", loadRouter: () => ({ registryRoot: "/fake/c" }), createProvider: () => ({ get() { throw new Error("registry unreadable"); } }) })(claim), false);
  assert.equal(createChatBindingConfirmer({ stateRoot: "/x", loadRouter: () => ({ registryRoot: "/fake/c" }), createProvider: () => ({ get: () => ({ state: "unreadable", bindingsFor: () => [binding] }) }) })(claim), false);
  void createRegistrySnapshotProvider;
});
