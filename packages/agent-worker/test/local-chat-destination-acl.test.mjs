// Who may be told what about a destination rule, and whether the ACL stays the last word (review of #180 to #182, M1 and the tests of V1/V2).
// A principal whose profile is not a local recipient and that has a destination rule resolves, at send time, to the one confirmed chat of its
// mapping. The sender must be one that may message that chat before it is told anything about the rule, the mapping or the chat; every
// other sender is answered as for a principal with no rule. The delivery itself still goes through the ACL and the credential's scope.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createTurnCapabilityIssuer, createTurnCapabilityValidator } from "../src/local-messaging-credentials.mjs";
import { createPerSenderRateLimiter, createConversationLoopTracker } from "../src/local-messaging-rate-limiter.mjs";
import { setupRouter } from "../src/local-messaging-cli.mjs";
import { coded } from "../src/local-messaging-errors.mjs";
import { createMessageParser, encodeFrame, PROTOCOL_VERSION } from "../src/local-messaging-protocol.mjs";
import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { setIdentityDestination } from "../src/identity-registry.mjs";
import { confirmChatMapping, deriveChatSelectorId, setChatMapping, CHAT_MAPPING_FILENAME } from "../src/local-chat-mapping.mjs";
import { createUnifiedRouter } from "../src/unified-router.mjs";
import { createDestinationPermissions } from "../src/local-messaging-host.mjs";
import { bindProfileInRegistry, initIdentityRegistry } from "./local-messaging-identity-fixtures.mjs";
import { upgradeThroughWriter } from "./identity-registry-v2-helpers.mjs";
import { readIdentityRegistry } from "../src/identity-registry.mjs";

const PERMITTED = "a".repeat(64); // a sender the owner policy lets message the mapped chat
const DENIED = "b".repeat(64); // a sender it does not
const HARNESS_ONLY = "c".repeat(64); // a sender the policy lets message chats of the harness, but not the mapped one
const BOB = deriveClientInstanceId("bob");
const CHAT = "session-" + "c".repeat(64);
const OTHER_CHAT = "session-" + "d".repeat(64);
const SECRET = "test-secret-32-bytes-long-1234567890";

function privateTmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(fs.existsSync("/private/tmp") ? "/private/tmp" : "/tmp", prefix)));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// What the scripted ACL says. `chats` are the chats a sender may message by the owner policy; `harness` says whether it may message chats of
// the harness at all; `blockDelivery` makes checkAllowed refuse although the policy answers yes (a lease or a grant the gate does not see).
function scriptedAcl({ policy, live, blockDelivery = false, asked = [], gateThrows = false }) {
  return {
    async listAuthorizedRecipients() { return []; },
    async checkAllowed(sender, to) {
      const p = policy[sender];
      if (blockDelivery || !p || !p.chats.has(to) || !live.has(to)) throw coded("recipient_not_allowed", "Sender is not authorized for this recipient");
    },
    async mayMessageIgnoringLiveness(sender, to) {
      asked.push(["session", sender, to]);
      if (gateThrows) throw new Error("the owner policy could not be read");
      return policy[sender]?.chats.has(to) === true;
    },
    async mayMessageHarness(sender, harness) {
      asked.push(["harness", sender, harness]);
      if (gateThrows) throw new Error("the owner policy could not be read");
      return policy[sender]?.harness === true;
    },
  };
}

async function world(options, run) {
  const { mapping = "confirmed", rule = true, router = true, corrupt = false, mappingGeneration = 1, live = [CHAT], policy, scope = null, blockDelivery = false, gateThrows = false } = options;
  const dir = privateTmp("dacl-");
  const stateRoot = path.join(dir, "s");
  const identityRoot = path.join(dir, "identity");
  const workspace = path.join(dir, "ws");
  for (const d of [stateRoot, identityRoot, workspace]) fs.mkdirSync(d, { mode: 0o700 });
  initIdentityRegistry(identityRoot);
  bindProfileInRegistry(identityRoot, "bob", 1);
  const rhea = bindProfileInRegistry(identityRoot, "rhea", 2);
  upgradeThroughWriter(identityRoot, { now: new Date().toISOString() });
  if (rule) {
    setIdentityDestination({ root: identityRoot, expectedSequence: readIdentityRegistry({ root: identityRoot }).registry.sequence, principalId: rhea.principal_id, harness: "claude", workspace });
  }
  const selectorId = deriveChatSelectorId({ harness: "claude", workspace });
  if (mapping !== "none") {
    setChatMapping({ storeRoot: stateRoot, selectorId, harness: "claude", workspace, principalId: rhea.principal_id, authorityOrigin: rhea.authority_origin, bindingGeneration: mappingGeneration, expectedSequence: 0 });
    if (mapping === "confirmed") {
      confirmChatMapping({ storeRoot: stateRoot, selectorId, expectedSequence: 1, attachedSessions: [{ address: CHAT, harness: "claude", workspace }] });
    }
  }
  if (corrupt) fs.writeFileSync(path.join(stateRoot, CHAT_MAPPING_FILENAME), "{ not json", { mode: 0o600 });
  if (router) setupRouter({ enable: true, registryRoot: identityRoot, stateRoot });
  const journal = createLocalMessagingJournal({ stateRoot });
  const socketPath = path.join(stateRoot, "c.sock");
  const admitted = [];
  const asked = [];
  const acl = scriptedAcl({ policy, live: new Set(live), blockDelivery, asked, gateThrows });
  const server = createLocalControlServer({
    socketPath,
    journal,
    acl,
    credentialValidator: createTurnCapabilityValidator({ secret: SECRET }),
    dispatcher: { start() {}, stop() {}, notifyAdmission: (job) => admitted.push(job) },
    statusProvider: async () => ({ ok: true, version: 1 }),
    rateLimiter: createPerSenderRateLimiter({ maxRequestsPerWindow: 200, windowMs: 5000 }),
    loopTracker: createConversationLoopTracker({ maxLoopDepth: 10, journal }),
    stateRoot,
    recipientDirectory: [{ id: BOB, label: "bob", kind: "worker" }],
    interactiveRecipients: { has: (id) => id.startsWith("session-") },
    inboxBroker: { isDesktopSender: () => false, validateRequest() {} },
    sessionBroker: {
      async listFor() { return []; },
      async listLiveAttachedSessions() { return live.map((address) => ({ address, harness: "claude", workspace, generation: 1 })); },
      async describeLocalSession(id) { return Object.freeze({ address: id, generation: 1, principal: null, authorityOrigin: null, bindingGeneration: null }); },
    },
    discoveryBroker: { async listFor() { return []; } },
  });
  await server.start();
  const issuer = createTurnCapabilityIssuer({ secret: SECRET });
  const clientFor = (senderId, allowedRecipients = scope) => {
    const credential = issuer.issue({ senderId, ...(allowedRecipients ? { allowedRecipients } : {}) });
    return { credential, client: createLocalControlClient({ socketPath, senderId, turnCredential: credential }) };
  };
  const clients = [];
  const as = (senderId, allowedRecipients) => { const c = clientFor(senderId, allowedRecipients); clients.push(c.client); return c; };
  try {
    return await run({ as, journal, admitted, asked, rhea, socketPath, stateRoot, identityRoot, workspace });
  } finally {
    for (const c of clients) await c.close();
    await server.close();
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function answer(promise) {
  try {
    const receipt = await promise;
    return { ok: true, accepted: receipt.accepted, target: receipt.target ?? null };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
}

function localStatus(socketPath, credential, senderId) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const parser = createMessageParser({ onMessage: (m) => { socket.destroy(); if (m.error) reject(m.error); else resolve(m.result); }, onError: reject });
    socket.on("data", (d) => parser.feed(d));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(encodeFrame({ protocol_version: PROTOCOL_VERSION, id: "s1", method: "local_status", params: {}, credential, senderId })));
  });
}

const POLICY = () => ({
  [PERMITTED]: { chats: new Set([CHAT]), harness: true },
  [DENIED]: { chats: new Set(), harness: false },
  [HARNESS_ONLY]: { chats: new Set([OTHER_CHAT]), harness: true },
});

// The states a destination rule can be in, and what a sender that may message the mapped chat is told in each. The first is today's: no rule.
const STATES = [
  ["no rule", { rule: false, mapping: "none" }, "route_unavailable"],
  ["rule, no store", { mapping: "none" }, "chat_mapping_missing"],
  ["rule, pending mapping", { mapping: "pending" }, "chat_mapping_unconfirmed"],
  ["rule, mapping of an older binding generation", { mapping: "pending", mappingGeneration: 2 }, "chat_mapping_stale_generation"],
  ["rule, store that is not JSON", { mapping: "none", corrupt: true }, "chat_mapping_corrupt"],
  ["rule, confirmed, chat offline", { live: [] }, "destination_session_offline"],
  ["rule, confirmed, only another chat online", { live: [OTHER_CHAT] }, "destination_session_offline"],
  ["rule, confirmed, chat online", {}, null],
];

test("a sender that may not message the mapped chat gets the answer of a principal with no rule, in every state, with the same counters", async () => {
  let baseline = null;
  for (const [name, options] of STATES) {
    const seen = await world({ ...options, policy: POLICY() }, async ({ as, admitted, rhea, socketPath }) => {
      const { client, credential } = as(DENIED);
      const before = (await localStatus(socketPath, credential, DENIED)).router.errors;
      const result = await answer(client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "m-denied", requestId: "r-denied" }));
      const after = (await localStatus(socketPath, credential, DENIED)).router.errors;
      const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (before[k] ?? 0)]).filter(([, v]) => v !== 0));
      return { result, delta, admitted: admitted.length };
    });
    assert.equal(seen.result.ok, false, `${name}: a denied sender must never be accepted`);
    assert.equal(seen.admitted, 0, name);
    baseline ??= seen;
    assert.deepEqual(seen, baseline, `${name}: answered differently from a principal with no rule`);
  }
  assert.equal(baseline.result.code, "route_unavailable");
  assert.deepEqual(baseline.delta, { route_unavailable: 1 });
});

test("a sender that may message the mapped chat is told why delivery is not possible, and is accepted when it is", async () => {
  for (const [name, options, expected] of STATES) {
    const seen = await world({ ...options, policy: POLICY() }, async ({ as, admitted, rhea }) => {
      const { client } = as(PERMITTED);
      const result = await answer(client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "m-ok", requestId: "r-ok" }));
      return { result, admitted: admitted.length };
    });
    if (expected === null) {
      assert.equal(seen.result.ok, true, name);
      assert.equal(seen.result.accepted, true, name);
      assert.equal(seen.admitted, 0, "a chat is not a runner: nothing is dispatched");
    } else {
      assert.equal(seen.result.ok, false, name);
      assert.equal(seen.result.code, expected, name);
      assert.equal(seen.admitted, 0, name);
    }
  }
});

test("a gate that cannot answer is a no: the sender is told what a principal with no rule would be told", async () => {
  for (const [name, options] of [["a pinned chat", {}], ["no chat pinned yet", { mapping: "pending" }]]) {
    const seen = await world({ ...options, policy: POLICY(), gateThrows: true }, async ({ as, admitted, asked, rhea }) => {
      const result = await answer(as(PERMITTED).client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "m-throws", requestId: "r-throws" }));
      return { result, admitted: admitted.length, asked: asked.length };
    });
    assert.equal(seen.asked, 1, `${name}: the gate was asked`);
    assert.equal(seen.result.ok, false, name);
    assert.equal(seen.result.code, "route_unavailable", name);
    assert.equal(seen.admitted, 0, name);
  }
});

test("the gate asks the owner policy about the pinned chat when there is one, and about the harness when there is none", async () => {
  await world({ policy: POLICY() }, async ({ as, asked, rhea }) => {
    await answer(as(PERMITTED).client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "m1", requestId: "r1" }));
    assert.deepEqual(asked, [["session", PERMITTED, CHAT]]);
  });
  await world({ mapping: "pending", policy: POLICY() }, async ({ as, asked, rhea }) => {
    await answer(as(PERMITTED).client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "m2", requestId: "r2" }));
    assert.deepEqual(asked, [["harness", PERMITTED, "claude"]]);
  });
  // A sender that may message chats of the harness but not the pinned one is told nothing once a chat is pinned, and the reasons before that.
  await world({ policy: POLICY() }, async ({ as, rhea }) => {
    const r = await answer(as(HARNESS_ONLY).client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "m3", requestId: "r3" }));
    assert.equal(r.code, "route_unavailable");
  });
  await world({ mapping: "pending", policy: POLICY() }, async ({ as, rhea }) => {
    const r = await answer(as(HARNESS_ONLY).client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "m4", requestId: "r4" }));
    assert.equal(r.code, "chat_mapping_unconfirmed");
  });
});

test("an ACL that cannot answer without the chat's lease asks the ordinary question instead, and a sender it denies is told nothing", async () => {
  // The ACL object of the server tests: only checkAllowed, no policy-only methods.
  const dir = privateTmp("dacl-plain-");
  const stateRoot = path.join(dir, "s");
  const identityRoot = path.join(dir, "identity");
  const workspace = path.join(dir, "ws");
  for (const d of [stateRoot, identityRoot, workspace]) fs.mkdirSync(d, { mode: 0o700 });
  initIdentityRegistry(identityRoot);
  const rhea = bindProfileInRegistry(identityRoot, "rhea", 1);
  upgradeThroughWriter(identityRoot, { now: new Date().toISOString() });
  setIdentityDestination({ root: identityRoot, expectedSequence: readIdentityRegistry({ root: identityRoot }).registry.sequence, principalId: rhea.principal_id, harness: "claude", workspace });
  const selectorId = deriveChatSelectorId({ harness: "claude", workspace });
  setChatMapping({ storeRoot: stateRoot, selectorId, harness: "claude", workspace, principalId: rhea.principal_id, authorityOrigin: rhea.authority_origin, bindingGeneration: 1, expectedSequence: 0 });
  confirmChatMapping({ storeRoot: stateRoot, selectorId, expectedSequence: 1, attachedSessions: [{ address: CHAT, harness: "claude", workspace }] });
  setupRouter({ enable: true, registryRoot: identityRoot, stateRoot });
  const journal = createLocalMessagingJournal({ stateRoot });
  const socketPath = path.join(stateRoot, "c.sock");
  const allowed = new Set([`${PERMITTED}>${CHAT}`]);
  const server = createLocalControlServer({
    socketPath, journal,
    acl: { async listAuthorizedRecipients() { return []; }, async checkAllowed(s, to) { if (!allowed.has(`${s}>${to}`)) throw coded("recipient_not_allowed", "denied"); } },
    credentialValidator: createTurnCapabilityValidator({ secret: SECRET }),
    dispatcher: { start() {}, stop() {}, notifyAdmission() {} },
    statusProvider: async () => ({ ok: true, version: 1 }),
    rateLimiter: createPerSenderRateLimiter({ maxRequestsPerWindow: 200, windowMs: 5000 }),
    loopTracker: createConversationLoopTracker({ maxLoopDepth: 10, journal }),
    stateRoot,
    recipientDirectory: [],
    interactiveRecipients: { has: (id) => id.startsWith("session-") },
    inboxBroker: { isDesktopSender: () => false, validateRequest() {} },
    sessionBroker: {
      async listFor() { return []; },
      async listLiveAttachedSessions() { return [{ address: CHAT, harness: "claude", workspace, generation: 1 }]; },
      async describeLocalSession(id) { return Object.freeze({ address: id, generation: 1, principal: null, authorityOrigin: null, bindingGeneration: null }); },
    },
    discoveryBroker: { async listFor() { return []; } },
  });
  await server.start();
  const issuer = createTurnCapabilityIssuer({ secret: SECRET });
  const clients = [];
  const as = (senderId) => { const c = createLocalControlClient({ socketPath, senderId, turnCredential: issuer.issue({ senderId }) }); clients.push(c); return c; };
  try {
    assert.equal((await answer(as(PERMITTED).sendMessage({ to: rhea.principal_id, text: "hi", messageId: "p1", requestId: "p1" }))).accepted, true);
    assert.equal((await answer(as(DENIED).sendMessage({ to: rhea.principal_id, text: "hi", messageId: "d1", requestId: "d1" }))).code, "route_unavailable");
  } finally {
    for (const c of clients) await c.close();
    await server.close();
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the ACL still decides delivery for a destination-resolved send: a gate that says yes is not enough (V1)", async () => {
  await world({ policy: POLICY(), blockDelivery: true }, async ({ as, admitted, journal, rhea }) => {
    const r = await answer(as(PERMITTED).client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "v1", requestId: "v1" }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "recipient_not_allowed");
    assert.equal(await journal.getRecord("v1"), null);
    assert.equal(admitted.length, 0);
  });
});

test("the credential's scope still decides delivery for a destination-resolved send, and its refusal does not name the chat (V2)", async () => {
  await world({ policy: POLICY() }, async ({ as, journal, rhea }) => {
    const r = await answer(as(PERMITTED, [BOB]).client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "v2", requestId: "v2" }));
    assert.equal(r.ok, false);
    assert.equal(r.code, "recipient_not_allowed");
    assert.equal(r.message.includes(CHAT), false, "the resolved chat address stays out of the answer");
    assert.equal(await journal.getRecord("v2"), null);
    // a scope that names the chat lets it through
    const ok = await answer(as(PERMITTED, [CHAT]).client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "v2b", requestId: "v2b" }));
    assert.equal(ok.accepted, true);
  });
});

test("with the router disabled a destination is not looked at", async () => {
  await world({ policy: POLICY(), router: false }, async ({ as, rhea }) => {
    const r = await answer(as(PERMITTED).client.sendMessage({ to: rhea.principal_id, text: "hi", messageId: "off", requestId: "off" }));
    assert.equal(r.code, "recipient_not_allowed");
  });
});

// ---- the router on its own

function destinationRouter({ resolveDestinationPrincipal, canMessage = null }) {
  const principal = "agent_" + "9".repeat(32);
  const destination = { harness: "claude", workspace: "/tmp/ws", generation: 1, bindingGeneration: 1, authorityOrigin: "https://thetriangle.dev" };
  const router = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => ({ state: "ok", bindingsFor: () => [], destinationFor: (id) => (id === principal ? destination : null) }) },
    recipients: [],
    canMessage,
    resolveDestinationPrincipal,
  });
  return { router, principal, destination };
}

test("the router hands the resolver the sender and the permission question, and answers `hidden` as for a principal with no rule", async () => {
  const calls = [];
  const canMessage = async () => true;
  const { router, principal, destination } = destinationRouter({
    canMessage,
    resolveDestinationPrincipal: async (args) => { calls.push(args); return { ok: false, hidden: true, reason: "chat_mapping_unconfirmed", message: "must not be shown" }; },
  });
  const noRule = createUnifiedRouter({ enabled: true, snapshotProvider: { get: () => ({ state: "ok", bindingsFor: () => [], destinationFor: () => null }) }, recipients: [] });
  const expected = await noRule.resolveSend({ senderId: PERMITTED, to: principal }, { throwOnError: false });
  const got = await router.resolveSend({ senderId: PERMITTED, to: principal }, { throwOnError: false });
  assert.equal(got.ok, false);
  assert.deepEqual([got.code, got.reason], [expected.code, expected.reason]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].principalId, principal);
  assert.equal(calls[0].senderId, PERMITTED);
  assert.deepEqual(calls[0].destination, destination);
  assert.equal(calls[0].canMessage, canMessage);
});

test("a resolver that throws gives the answer for a principal with no rule, never its own error", async () => {
  const { router, principal } = destinationRouter({ resolveDestinationPrincipal: async () => { throw coded("chat_mapping_corrupt", "/secret/path is unreadable"); } });
  const noRule = createUnifiedRouter({ enabled: true, snapshotProvider: { get: () => ({ state: "ok", bindingsFor: () => [], destinationFor: () => null }) }, recipients: [] });
  const expected = await noRule.resolveSend({ senderId: PERMITTED, to: principal }, { throwOnError: false });
  const got = await router.resolveSend({ senderId: PERMITTED, to: principal }, { throwOnError: false });
  assert.equal(got.ok, false);
  assert.deepEqual([got.code, got.reason], [expected.code, expected.reason]);
  assert.equal(String(got.reason).includes("secret"), false);
});

test("a reason from the resolver reaches a sender it was meant for, with its own code", async () => {
  const { router, principal } = destinationRouter({ resolveDestinationPrincipal: async () => ({ ok: false, reason: "destination_session_offline" }) });
  await assert.rejects(router.resolveSend({ senderId: PERMITTED, to: principal }), { code: "destination_session_offline" });
});

// ---- the permission questions the host answers

function stubBrokers({ session = true, harness = true, grokHas = () => false, grokAllows = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    sessionBroker: {
      async mayMessageSession(sender, to) { calls.push(["session", sender, to]); if (session === "throw") throw new Error("broker down"); return session; },
      async mayMessageHarness(sender, h) { calls.push(["harness", sender, h]); if (harness === "throw") throw new Error("broker down"); return harness; },
    },
    grokBroker: { has: grokHas, checkAllowed: (s, to) => { calls.push(["grok", s, to]); grokAllows(s, to); } },
  };
}

test("createDestinationPermissions: a session address is decided by the session broker, anything else is no", async () => {
  const b = stubBrokers();
  const p = createDestinationPermissions({ sessionBroker: b.sessionBroker });
  assert.equal(await p.mayMessageIgnoringLiveness(PERMITTED, CHAT), true);
  assert.deepEqual(b.calls, [["session", PERMITTED, CHAT]]);
  for (const to of [BOB, "agent_" + "1".repeat(32), "", null, undefined, 7]) assert.equal(await p.mayMessageIgnoringLiveness(PERMITTED, to), false, String(to));
  assert.equal(b.calls.length, 1, "no question for anything that is not a session address");
  assert.equal(await createDestinationPermissions({ sessionBroker: stubBrokers({ session: false }).sessionBroker }).mayMessageIgnoringLiveness(PERMITTED, CHAT), false);
  assert.equal(await createDestinationPermissions({ sessionBroker: stubBrokers({ session: "throw" }).sessionBroker }).mayMessageIgnoringLiveness(PERMITTED, CHAT), false);
  assert.equal(await createDestinationPermissions({}).mayMessageIgnoringLiveness(PERMITTED, CHAT), false);
  // only a boolean true counts
  assert.equal(await createDestinationPermissions({ sessionBroker: stubBrokers({ session: "yes" }).sessionBroker }).mayMessageIgnoringLiveness(PERMITTED, CHAT), false);
});

test("createDestinationPermissions: a Grok principal's outgoing grant is part of the answer, for the sender and for the recipient side", async () => {
  const grokSender = "e".repeat(64);
  const deny = () => { throw coded("recipient_not_allowed", "grant denies"); };
  const open = stubBrokers({ grokHas: (id) => id === grokSender });
  const pOpen = createDestinationPermissions({ sessionBroker: open.sessionBroker, grokBroker: open.grokBroker });
  assert.equal(await pOpen.mayMessageIgnoringLiveness(grokSender, CHAT), true);
  assert.deepEqual(open.calls, [["grok", grokSender, CHAT], ["session", grokSender, CHAT]], "the grant is asked first, then the policy");
  const closed = stubBrokers({ grokHas: (id) => id === grokSender, grokAllows: deny });
  const pClosed = createDestinationPermissions({ sessionBroker: closed.sessionBroker, grokBroker: closed.grokBroker });
  assert.equal(await pClosed.mayMessageIgnoringLiveness(grokSender, CHAT), false);
  assert.equal(closed.calls.some((c) => c[0] === "session"), false, "a denied grant is not asked past");
  // a Grok principal on the recipient side is covered too
  const recipientSide = stubBrokers({ grokHas: (id) => id === CHAT, grokAllows: deny });
  assert.equal(await createDestinationPermissions({ sessionBroker: recipientSide.sessionBroker, grokBroker: recipientSide.grokBroker }).mayMessageIgnoringLiveness(PERMITTED, CHAT), false);
  // a sender the Grok broker does not know goes straight to the policy
  const none = stubBrokers();
  assert.equal(await createDestinationPermissions({ sessionBroker: none.sessionBroker, grokBroker: none.grokBroker }).mayMessageIgnoringLiveness(PERMITTED, CHAT), true);
  assert.equal(none.calls.some((c) => c[0] === "grok"), false);
});

test("createDestinationPermissions: harness-level permission is the session broker's, and never a Grok principal's", async () => {
  const b = stubBrokers();
  const p = createDestinationPermissions({ sessionBroker: b.sessionBroker });
  assert.equal(await p.mayMessageHarness(PERMITTED, "claude"), true);
  assert.deepEqual(b.calls, [["harness", PERMITTED, "claude"]]);
  assert.equal(await createDestinationPermissions({ sessionBroker: stubBrokers({ harness: false }).sessionBroker }).mayMessageHarness(PERMITTED, "claude"), false);
  assert.equal(await createDestinationPermissions({ sessionBroker: stubBrokers({ harness: "throw" }).sessionBroker }).mayMessageHarness(PERMITTED, "claude"), false);
  assert.equal(await createDestinationPermissions({}).mayMessageHarness(PERMITTED, "claude"), false);
  const grokSender = "e".repeat(64);
  const g = stubBrokers({ grokHas: (id) => id === grokSender });
  assert.equal(await createDestinationPermissions({ sessionBroker: g.sessionBroker, grokBroker: g.grokBroker }).mayMessageHarness(grokSender, "claude"), false);
  assert.equal(g.calls.length, 0);
  assert.equal(await createDestinationPermissions({ sessionBroker: g.sessionBroker, grokBroker: g.grokBroker }).mayMessageHarness(PERMITTED, "claude"), true);
  assert.equal(await createDestinationPermissions({ sessionBroker: stubBrokers({ harness: "yes" }).sessionBroker }).mayMessageHarness(PERMITTED, "claude"), false);
});
