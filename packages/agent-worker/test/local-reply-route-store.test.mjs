import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createLocalReplyRouteStore } from "../src/local-reply-route-store.mjs";
import { authenticateAttachedLocalSender } from "../src/local-sender-authentication.mjs";
import { createTurnCapabilityIssuer, createTurnCapabilityValidator } from "../src/local-messaging-credentials.mjs";

const local = { address: `session-${"a".repeat(64)}`, generation: 1 };
const remote = { address: "b".repeat(64), generation: 1 };

test("real SQLite restart preserves pins; rejected/failed replies cannot advance or insert", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r2-pin-"));
  const file = path.join(root, "journal.sqlite");
  let db = new DatabaseSync(file);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.exec("CREATE TABLE replies(id TEXT PRIMARY KEY, text TEXT)");
  let store = createLocalReplyRouteStore({ db });
  const route = store.pin({ requestId: "r", local, remote });
  assert.deepEqual(store.pin({ requestId: "r", local, remote }), route);
  db.close(); db = new DatabaseSync(file); store = createLocalReplyRouteStore({ db });
  assert.deepEqual(store.read(route.key), route);
  const renewed = { ...local, generation: 2 };
  assert.throws(() => store.withReply({ key: route.key, local: renewed, remote, writeReply(conn) {
    conn.prepare("INSERT INTO replies VALUES(?,?)").run("failed", "must roll back");
    throw new Error("controlled persistence failure");
  } }), /controlled persistence failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM replies").get().n, 0);
  assert.equal(store.read(route.key).local.generation, 1);
  let called = false;
  assert.throws(() => store.withReply({ key: route.key, local: { ...renewed, address: `session-${"c".repeat(64)}` }, remote, writeReply() { called = true; } }), { code: "reply_session_mismatch" });
  assert.equal(called, false);
  store.withReply({ key: route.key, local: renewed, remote, writeReply(conn) { conn.prepare("INSERT INTO replies VALUES(?,?)").run("ok", "reply"); } });
  assert.equal(store.read(route.key).local.generation, 2);
  assert.equal(db.prepare("SELECT text FROM replies WHERE id='ok'").get().text, "reply");
  assert.throws(() => store.withReply({ key: route.key, local, remote, writeReply() {} }), { code: "reply_generation_regressed" });
  assert.throws(() => store.pin({ requestId: "r", local: { ...renewed, generation: 3 }, remote }), { code: "reply_route_conflict" });
  assert.throws(() => store.withReply({ key: "unknown", local, remote, writeReply() {} }), { code: "reply_route_missing" });
  assert.throws(() => store.withReply({ key: route.key, local: renewed, remote, writeReply: async () => {} }), { code: "invalid_reply_writer" });
});

test("native signed credentials plus live broker required; payload identity is not trusted", async t => {
  const secret = "r2-authentication-secret-at-least-32-bytes";
  const issuer = createTurnCapabilityIssuer({ secret });
  const credentialValidator = createTurnCapabilityValidator({ secret });
  const claims = { senderId: local.address, senderType: "interactive", sessionId: "own-session", bindingId: "own-child", generation: 1 };
  const credential = issuer.issue(claims);
  let active = true;
  const sessionBroker = { validateRequest({ claims: verified }) {
    if (!active || verified.bindingId !== "own-child" || verified.generation !== 1) throw Object.assign(new Error("fenced"), { code: "session_fenced" });
  } };
  const options = { credential, expectedSenderId: local.address, credentialValidator, sessionBroker };
  const result = await authenticateAttachedLocalSender({ ...options, principal: `agent_${"e".repeat(32)}` });
  assert.equal(result.principal, null);
  assert.equal(result.address, local.address);
  await assert.rejects(authenticateAttachedLocalSender({ ...options, credential: credential + "broken" }), { code: "unauthorized" });
  await assert.rejects(authenticateAttachedLocalSender({ ...options, expectedSenderId: `session-${"f".repeat(64)}` }), { code: "unauthorized" });
  await assert.rejects(authenticateAttachedLocalSender({ ...options, credential: issuer.issue({ ...claims, generation: 2 }) }), { code: "session_fenced" });
  const actualNow = Date.now;
  t.mock.method(Date, "now", () => actualNow() - 10000);
  const expired = issuer.issue({ ...claims, ttlMs: 500 });
  Date.now.mock.restore();
  await assert.rejects(authenticateAttachedLocalSender({ ...options, credential: expired }), { code: "credential_expired" });
  active = false;
  await assert.rejects(authenticateAttachedLocalSender(options), { code: "session_fenced" });
});
