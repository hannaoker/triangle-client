// Reply pins between attached chats when an owner mapping gives a chat a principal (review of #180 to #182, M2).
// Both ends of a pin come from one description of the chat: the way it is described as a recipient (`describeLocalSession`) and the way it is
// authenticated as a sender must agree on its principal, or a mapped chat could never answer a request that was pinned to it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createLocalReplyRouteStore } from "../src/local-reply-route-store.mjs";
import { authenticateAttachedLocalSender, createAttachedReplyIdentity } from "../src/local-sender-authentication.mjs";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import { createTurnCapabilityIssuer, createTurnCapabilityValidator } from "../src/local-messaging-credentials.mjs";

const A = `session-${"a".repeat(64)}`;
const B = `session-${"b".repeat(64)}`;
const P_A = "agent_" + "a".repeat(32);
const P_B = "agent_" + "b".repeat(32);
const ORIGIN = "https://triangle.example";
const mapping = (principal, generation = 1) => ({ principal, authorityOrigin: ORIGIN, bindingGeneration: generation });

async function world(t, mapped) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r2m-"));
  fs.chmodSync(root, 0o700);
  const states = new Map([[A, { generation: 1, child: "child-a" }], [B, { generation: 1, child: "child-b" }]]);
  const secret = "mapped-chat-reply-secret-32-bytes!!";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });
  const offline = new Set();
  const gone = () => Object.assign(new Error("Session MCP child is offline"), { code: "session_offline" });
  const broker = {
    isInteractiveSender: (id) => states.has(id),
    async validateRequest({ claims, senderId }) {
      if (offline.has(senderId)) throw gone();
      const state = states.get(senderId);
      if (!state || claims.generation !== state.generation || claims.bindingId !== state.child) throw Object.assign(new Error("fenced"), { code: "session_fenced" });
    },
    async describeLocalSession(id) {
      if (offline.has(id)) throw gone();
      const state = states.get(id);
      const m = mapped.get(id) ?? null;
      return { address: id, generation: state.generation, principal: m?.principal ?? null, authorityOrigin: m?.authorityOrigin ?? null, bindingGeneration: m?.bindingGeneration ?? null };
    },
  };
  const journal = createLocalMessagingJournal({ stateRoot: root, replyRouteStoreFactory: createLocalReplyRouteStore });
  const control = new DatabaseSync(path.join(root, "local-messaging.sqlite"));
  for (const id of [A, B]) {
    control.prepare("INSERT INTO local_discovered_sessions(id,installation_id,workspace,session_id,lifecycle,generation,event_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "scope", root, "hash", "observed", 1, Date.now(), Date.now());
    await journal.attachDiscoveredSession({ id, childId: states.get(id).child, generation: 1, installationId: "scope", wakeCapable: false });
  }
  const replyIdentity = createAttachedReplyIdentity({ credentialValidator: validator, sessionBroker: broker, enabled: true });
  const server = createLocalControlServer({
    socketPath: path.join(root, "control.sock"), journal, credentialValidator: validator, interactiveBroker: broker, replyIdentity,
    interactiveRecipients: new Set([A, B]), acl: createOwnerAcl({ rules: { [A]: [B], [B]: [A] } }),
    dispatcher: { start: async () => {}, stop: async () => {}, notifyAdmission: async () => { throw new Error("an interactive request must not run a worker"); } },
  });
  const clients = [];
  const client = (id) => {
    const state = states.get(id);
    const credential = issuer.issue({ senderId: id, senderType: "interactive", sessionId: "raw-" + id.slice(-1), generation: state.generation, bindingId: state.child, allowedRecipients: [id === A ? B : A] });
    const c = createLocalControlClient({ socketPath: path.join(root, "control.sock"), senderId: id, turnCredential: credential });
    clients.push(c);
    return c;
  };
  t.after(async () => {
    for (const c of clients) await c.close();
    await server.close();
    control.close();
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await server.start();
  return { client, journal, broker, validator, issuer, states, offline };
}

async function requestAndReply(w, { requestId }) {
  const sender = w.client(A);
  const recipient = w.client(B);
  const receipt = await sender.sendMessage({ to: B, text: "task", messageId: `msg-${requestId}`, requestId });
  assert.equal(receipt.accepted, true);
  const inbox = await recipient.listInbox();
  const claim = await recipient.claimInboxMessage({ messageId: `msg-${requestId}`, claimId: `claim-${requestId}` });
  return { sender, recipient, claim, inbox };
}

test("a chat that is mapped as the recipient answers a request pinned to it, and the pin carries its principal", async (t) => {
  const w = await world(t, new Map([[B, mapping(P_B)]]));
  const { sender, recipient, claim, inbox } = await requestAndReply(w, { requestId: "to-mapped" });
  const route = await w.journal.getReplyRouteForMessage("msg-to-mapped");
  assert.equal(route.local.principal, P_B);
  assert.equal(route.remote.principal, null);
  assert.equal(inbox[0].senderProvenance.principal, null);
  assert.equal(inbox[0].senderProvenance.recipient_principal, P_B);
  const reply = await recipient.sendReply({ messageId: "msg-to-mapped", claimToken: claim.claimToken, text: "done", replyId: "reply-to-mapped" });
  assert.equal(reply.recipient, A);
  const replies = await sender.listReplies({ requestId: "to-mapped" });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].senderProvenance.principal, P_B, "the reply names the chat's principal as its sender");
});

test("a chat that is mapped as the sender gets its answer, and the request names its principal", async (t) => {
  const w = await world(t, new Map([[A, mapping(P_A)]]));
  const { sender, recipient, claim, inbox } = await requestAndReply(w, { requestId: "from-mapped" });
  const route = await w.journal.getReplyRouteForMessage("msg-from-mapped");
  assert.equal(route.remote.principal, P_A, "the sender is pinned as the principal it authenticated as");
  assert.equal(inbox[0].senderProvenance.principal, P_A);
  await recipient.sendReply({ messageId: "msg-from-mapped", claimToken: claim.claimToken, text: "done", replyId: "reply-from-mapped" });
  assert.equal((await sender.listReplies({ requestId: "from-mapped" })).length, 1);
});

test("both chats mapped to their own principals", async (t) => {
  const w = await world(t, new Map([[A, mapping(P_A)], [B, mapping(P_B)]]));
  const { sender, recipient, claim, inbox } = await requestAndReply(w, { requestId: "both" });
  assert.equal(inbox[0].senderProvenance.principal, P_A);
  assert.equal(inbox[0].senderProvenance.recipient_principal, P_B);
  await recipient.sendReply({ messageId: "msg-both", claimToken: claim.claimToken, text: "done", replyId: "reply-both" });
  assert.equal((await sender.listReplies({ requestId: "both" })).length, 1);
});

test("a mapping revoked after the request fails the reply closed, and a mapping confirmed after it does the same", async (t) => {
  const mapped = new Map([[B, mapping(P_B)]]);
  const w = await world(t, mapped);
  const { recipient, claim } = await requestAndReply(w, { requestId: "revoked" });
  mapped.delete(B);
  await assert.rejects(recipient.sendReply({ messageId: "msg-revoked", claimToken: claim.claimToken, text: "late", replyId: "reply-revoked" }), { code: "reply_session_mismatch" });

  const later = new Map();
  const w2 = await world(t, later);
  const second = await requestAndReply(w2, { requestId: "confirmed-later" });
  later.set(B, mapping(P_B));
  await assert.rejects(second.recipient.sendReply({ messageId: "msg-confirmed-later", claimToken: second.claim.claimToken, text: "late", replyId: "reply-confirmed-later" }), { code: "reply_session_mismatch" });
});

test("a binding generation that went backwards fails the reply closed", async (t) => {
  const mapped = new Map([[B, mapping(P_B, 3)]]);
  const w = await world(t, mapped);
  const { recipient, claim } = await requestAndReply(w, { requestId: "regressed" });
  mapped.set(B, mapping(P_B, 2));
  await assert.rejects(recipient.sendReply({ messageId: "msg-regressed", claimToken: claim.claimToken, text: "late", replyId: "reply-regressed" }), { code: "reply_generation_regressed" });
});

test("authenticateAttachedLocalSender describes the chat the way the broker does, and nothing else", async () => {
  const secret = "mapped-chat-auth-secret-32-bytes-long";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });
  const credential = issuer.issue({ senderId: A, senderType: "interactive", sessionId: "raw-a", generation: 4, bindingId: "child-a" });
  let described = 0;
  const brokerFor = (answer) => ({
    async validateRequest() {},
    async describeLocalSession(id) { described += 1; return { address: id, generation: 4, ...answer }; },
  });
  const mapped = await authenticateAttachedLocalSender({ credential, expectedSenderId: A, credentialValidator: validator, sessionBroker: brokerFor(mapping(P_A, 7)) });
  assert.deepEqual({ ...mapped }, { address: A, generation: 4, principal: P_A, authorityOrigin: ORIGIN, bindingGeneration: 7 });
  const unmapped = await authenticateAttachedLocalSender({ credential, expectedSenderId: A, credentialValidator: validator, sessionBroker: brokerFor({ principal: null, authorityOrigin: null, bindingGeneration: null }) });
  assert.deepEqual({ ...unmapped }, { address: A, generation: 4, principal: null, authorityOrigin: null, bindingGeneration: null });
  assert.equal(described, 2);
  // the generation is the credential's, which the broker has just checked against the chat
  const other = await authenticateAttachedLocalSender({ credential, expectedSenderId: A, credentialValidator: validator, sessionBroker: { async validateRequest() {}, async describeLocalSession(id) { return { address: id, generation: 99, ...mapping(P_A) }; } } });
  assert.equal(other.generation, 4);
  // a broker that cannot describe a chat leaves it unbound; a broker that cannot validate a request still refuses it
  const bare = await authenticateAttachedLocalSender({ credential, expectedSenderId: A, credentialValidator: validator, sessionBroker: { async validateRequest() {} } });
  assert.equal(bare.principal, null);
  await assert.rejects(authenticateAttachedLocalSender({ credential, expectedSenderId: A, credentialValidator: validator, sessionBroker: { async validateRequest() { throw Object.assign(new Error("fenced"), { code: "session_fenced" }); }, async describeLocalSession() { return mapping(P_A); } } }), { code: "session_fenced" });
  // a broker's description is not trusted past its shape: a mapped principal needs its authority and generation
  await assert.rejects(authenticateAttachedLocalSender({ credential, expectedSenderId: A, credentialValidator: validator, sessionBroker: brokerFor({ principal: P_A, authorityOrigin: null, bindingGeneration: null }) }).then(async (identity) => {
    const { createLocalReplyRoute } = await import("../src/local-reply-route-contract.mjs");
    return createLocalReplyRoute({ requestId: "r", local: identity, remote: identity });
  }), { code: "invalid_reply_identity" });
});

test("a reply waits for a requester that is offline when it has no principal, and is refused while it is offline when it was pinned with one", async (t) => {
  // without a principal the reply is queued for its original chat, as it always was
  const plain = await world(t, new Map());
  const first = await requestAndReply(plain, { requestId: "offline-plain" });
  plain.offline.add(A);
  const queued = await first.recipient.sendReply({ messageId: "msg-offline-plain", claimToken: first.claim.claimToken, text: "done", replyId: "reply-offline-plain" });
  assert.equal(queued.recipient, A, "the reply is addressed to the chat that asked");

  // with a principal its binding cannot be checked while the chat is away, so the reply does not wait on an unchecked pin
  const mapped = await world(t, new Map([[A, mapping(P_A)]]));
  const second = await requestAndReply(mapped, { requestId: "offline-mapped" });
  mapped.offline.add(A);
  await assert.rejects(second.recipient.sendReply({ messageId: "msg-offline-mapped", claimToken: second.claim.claimToken, text: "done", replyId: "reply-offline-mapped" }), { code: "session_offline" });
  assert.equal((await mapped.journal.getReplyRouteForMessage("msg-offline-mapped")).remote.principal, P_A, "the pin is untouched");
  // the replier retries when the chat is back, with the same claim
  mapped.offline.delete(A);
  const retried = await second.recipient.sendReply({ messageId: "msg-offline-mapped", claimToken: second.claim.claimToken, text: "done", replyId: "reply-offline-mapped" });
  assert.equal(retried.recipient, A);
});

test("a mapping of the requester that changed after the request fails the reply closed, as one of the replier does (M2, L-5)", async (t) => {
  const mapped = new Map([[A, mapping(P_A)]]);
  const w = await world(t, mapped);
  const { recipient, claim } = await requestAndReply(w, { requestId: "requester-revoked" });
  mapped.delete(A);
  await assert.rejects(recipient.sendReply({ messageId: "msg-requester-revoked", claimToken: claim.claimToken, text: "late", replyId: "reply-requester-revoked" }), { code: "reply_remote_mismatch" });
  // the same chat mapped to another principal is no better
  mapped.set(A, mapping(P_B));
  await assert.rejects(recipient.sendReply({ messageId: "msg-requester-revoked", claimToken: claim.claimToken, text: "late", replyId: "reply-requester-revoked" }), { code: "reply_remote_mismatch" });
  // and the original mapping again is the pin that was made
  mapped.set(A, mapping(P_A));
  assert.equal((await recipient.sendReply({ messageId: "msg-requester-revoked", claimToken: claim.claimToken, text: "ok", replyId: "reply-requester-revoked" })).recipient, A);
});

test("a chat that cannot be described cannot authenticate: the failure is the broker's, not a chat without a principal", async () => {
  const secret = "mapped-chat-describe-secret-32-bytes!";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });
  const credential = issuer.issue({ senderId: A, senderType: "interactive", sessionId: "raw-a", generation: 1, bindingId: "child-a" });
  const gone = Object.assign(new Error("Session MCP child is offline"), { code: "session_offline" });
  await assert.rejects(authenticateAttachedLocalSender({ credential, expectedSenderId: A, credentialValidator: validator, sessionBroker: { async validateRequest() {}, async describeLocalSession() { throw gone; } } }), { code: "session_offline" });
});
