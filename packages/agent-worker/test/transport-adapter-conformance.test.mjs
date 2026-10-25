import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalAdapter } from "../src/local-adapter.mjs";
import { validateTransportAdapter, localState } from "../src/transport-adapter-contract.mjs";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createLocalMessagingDispatcher } from "../src/local-messaging-dispatcher.mjs";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import { createTurnCapabilityIssuer, createTurnCapabilityValidator } from "../src/local-messaging-credentials.mjs";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "triangle-adapter-"));
  fs.chmodSync(root, 0o700);
  const journal = createLocalMessagingJournal({ stateRoot: root });
  const secret = "transport-conformance-secret-32-bytes";
  const issuer = createTurnCapabilityIssuer({ secret });
  const clients = [];
  let calls = 0;
  const dispatcher = createLocalMessagingDispatcher({ journal, runRecipient: async job => {
    calls++;
    if (job.text === "fail") throw new Error("controlled failure");
    return { status: "completed", text: `reply:${job.text}` };
  } });
  const server = createLocalControlServer({ socketPath: path.join(root, "control.sock"), journal, dispatcher,
    credentialValidator: createTurnCapabilityValidator({ secret }),
    acl: createOwnerAcl({ rules: { alice: ["worker"], worker: ["alice"], eve: [] } }) });
  t.after(async () => {
    for (const client of clients) await client.close();
    await server.close();
    await journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await server.start();
  function adapter(senderId, allowedRecipients) {
    const client = createLocalControlClient({ socketPath: path.join(root, "control.sock"), senderId });
    clients.push(client);
    return createLocalAdapter({ client, getCredential: () => issuer.issue({ senderId, allowedRecipients }) });
  }
  return { adapter, journal, calls: () => calls };
}

async function until(fn) {
  for (let n = 0; n < 100; n++) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Controlled local dispatch did not finish");
}

test("contract does not infer delivery, reply or expiry from native phases", () => {
  assert.throws(() => validateTransportAdapter({}), { code: "invalid_transport_adapter" });
  assert.equal(localState("queued_local"), "received");
  assert.equal(localState("completed"), "completed");
  assert.equal(localState("wake_accepted"), "unknown");
  assert.equal(localState("unexpected"), "unknown");
});

test("local conformance: real SQLite, socket, dispatcher, dedupe, replies and explicit consumption", async t => {
  const env = await fixture(t);
  const alice = env.adapter("alice");
  validateTransportAdapter(alice);
  assert.equal((await alice.reach("worker")).sendEligible, true);
  assert.equal((await alice.reach("worker")).presence, "unknown");
  const input = { to: "worker", messageId: "m1", requestId: "r1", text: "freeform", metadata: { purpose: "test" } };
  const receipt = await alice.send(input);
  assert.equal(receipt.state, "received");
  const replies = await until(async () => {
    const result = await alice.replies({ requestId: "r1" });
    return result.items.length ? result.items : null;
  });
  assert.equal(replies[0].text, "reply:freeform");
  assert.equal(replies[0].inReplyTo, "m1");
  assert.equal((await alice.replies({ requestId: "r1" })).items.length, 1);
  assert.equal((await alice.send(input)).isDuplicate, true);
  assert.equal(env.calls(), 1);
  await assert.rejects(alice.send({ ...input, text: "conflict" }), { code: "duplicate_id_conflict" });
  assert.equal((await alice.status({ messageId: "m1" })).state, "completed");
  await assert.rejects(env.adapter("eve").consume({ messageId: replies[0].messageId }), { code: "foreign_access_denied" });
  await alice.consume({ messageId: replies[0].messageId });
  assert.equal((await alice.replies({ requestId: "r1" })).items.length, 0);
  await assert.rejects(alice.status({ messageId: "missing" }), { code: "not_found" });
  await env.journal.compact({ now: Date.now() + 9 * 24 * 60 * 60 * 1000 });
  await assert.rejects(alice.status({ messageId: "m1" }), { code: "not_found" });
});

test("local conformance preserves ACL, capability scope, foreign ownership and held failures", async t => {
  const env = await fixture(t);
  const alice = env.adapter("alice");
  const eve = env.adapter("eve");
  assert.deepEqual(await eve.discover(), []);
  const scoped = env.adapter("alice", []);
  assert.equal((await scoped.reach("worker")).sendEligible, false);
  await assert.rejects(scoped.send({ to: "worker", text: "x", messageId: "s1", requestId: "s1" }), { code: "recipient_not_allowed" });
  await alice.send({ to: "worker", text: "fail", messageId: "failed", requestId: "failed" });
  const status = await until(async () => {
    const state = await alice.status({ messageId: "failed" });
    return state.phase === "held" ? state : null;
  });
  assert.equal(status.state, "held");
  assert.equal(status.reason, "runtime_error");
  assert.equal((await alice.replies({ requestId: "failed" })).items.length, 0);
  await assert.rejects(eve.status({ messageId: "failed" }), { code: "foreign_access_denied" });
  await assert.rejects(eve.send({ to: "worker", text: "x", messageId: "e1", requestId: "e1" }), { code: "recipient_not_allowed" });
});

test("unsupported routes and policies fail before authentication; unknown send outcome never retries", async () => {
  let credentials = 0;
  let sends = 0;
  const client = Object.fromEntries(["listSessions", "discoverRecipients", "sendMessage", "listInbox",
    "getMessageStatus", "listReplies", "consumeReply"].map(name => [name, async () => []]));
  client.sendMessage = async () => { sends++; throw Object.assign(new Error("unknown outcome"), { code: "timeout" }); };
  const adapter = createLocalAdapter({ client, getCredential: () => { credentials++; return "credential"; } });
  const input = { to: "worker", text: "x", messageId: "stable", requestId: "stable" };
  for (const options of [{ via: "iroh" }, { via: "mesh" }, { deliverBy: 123 }, { waitMs: 1 }]) {
    await assert.rejects(adapter.send({ ...input, ...options }));
  }
  assert.equal(credentials, 0);
  await assert.rejects(adapter.send({ to: "worker", text: "missing IDs" }), { code: "invalid_message" });
  await assert.rejects(adapter.send(input), { code: "timeout" });
  assert.equal(sends, 1);
  assert.equal(credentials, 1);
  assert.equal(input.messageId, "stable");
});

test("local projection preserves inbox cursors and obtains credentials for every operation", async () => {
  const auth = [];
  const items = [{ messageId: "incoming", text: "untrusted freeform" }];
  Object.defineProperty(items, "nextCursor", { value: "opaque-cursor" });
  const client = Object.fromEntries(["listSessions", "discoverRecipients", "sendMessage", "listInbox",
    "getMessageStatus", "listReplies", "consumeReply"].map(name => [name, async () => []]));
  client.listInbox = async (input, options) => {
    assert.equal(input.cursor, "previous");
    auth.push(options.credential);
    return items;
  };
  client.getMessageStatus = async (input, options) => {
    auth.push(options.credential);
    return { messageId: input.messageId, phase: "future_phase", hasLateResult: true };
  };
  let generation = 0;
  const adapter = createLocalAdapter({ client, getCredential: () => `credential-${++generation}` });
  const inbox = await adapter.poll({ cursor: "previous" });
  assert.equal(inbox.nextCursor, "opaque-cursor");
  assert.deepEqual(inbox.items, [...items]);
  const status = await adapter.status({ messageId: "incoming" });
  assert.equal(status.state, "unknown");
  assert.equal(status.phase, "future_phase");
  assert.equal(status.hasLateResult, true);
  assert.deepEqual(auth, ["credential-1", "credential-2"]);
});
