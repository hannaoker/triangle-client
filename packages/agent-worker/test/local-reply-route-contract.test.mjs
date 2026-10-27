import test from "node:test";
import assert from "node:assert/strict";
import { createLocalReplyRoute, verifyLocalReplyRoute, createLocalSenderProvenance } from "../src/local-reply-route-contract.mjs";

const identity = (hex, extra = {}) => ({ address: `session-${hex.repeat(64)}`, generation: 1, ...extra });
const local = identity("a");
const remote = identity("b");
const mapped = { principal: `agent_${"c".repeat(32)}`, authorityOrigin: "https://example.test", bindingGeneration: 2 };

test("unbound senders with equal request IDs never share a route key", () => {
  const first = createLocalReplyRoute({ requestId: "same", local, remote });
  const other = createLocalReplyRoute({ requestId: "same", local, remote: identity("c") });
  assert.notEqual(first.key, other.key);
  assert.equal(first.remote.principal, null);
  assert.ok(Object.isFrozen(first.local));
});

test("same session renews monotonically across serialized restart; inputs unchanged", () => {
  const pinned = createLocalReplyRoute({ requestId: "r", local: { ...local, ...mapped }, remote });
  const serialized = JSON.stringify(pinned);
  const next = verifyLocalReplyRoute(JSON.parse(serialized), { local: { ...local, ...mapped, generation: 2, bindingGeneration: 3 }, remote: { ...remote, generation: 2 } });
  assert.equal(next.key, pinned.key);
  assert.equal(next.local.generation, 2);
  assert.equal(next.local.bindingGeneration, 3);
  assert.equal(JSON.stringify(pinned), serialized);
  assert.throws(() => verifyLocalReplyRoute(next, { local: { ...local, ...mapped }, remote }), { code: "reply_generation_regressed" });
});

test("different session, principal or authority cannot take over a pinned reply", () => {
  const bound = { ...local, ...mapped };
  const route = createLocalReplyRoute({ requestId: "r", local: bound, remote });
  for (const patch of [{ address: identity("d").address }, { principal: `agent_${"e".repeat(32)}` }, { authorityOrigin: "https://other.test" }]) {
    assert.throws(() => verifyLocalReplyRoute(route, { local: { ...bound, ...patch }, remote }), { code: "reply_session_mismatch" });
  }
  assert.throws(() => verifyLocalReplyRoute(route, { local: bound, remote: identity("e") }), { code: "reply_remote_mismatch" });
  assert.throws(() => verifyLocalReplyRoute(route, { local: bound, remote: null }), { code: "invalid_reply_identity" });
  assert.throws(() => verifyLocalReplyRoute({ ...route, transport: "iroh-peer" }, { local: bound, remote }), { code: "invalid_reply_route" });
  assert.throws(() => verifyLocalReplyRoute({ ...route, key: "forged" }, { local: bound, remote }), { code: "invalid_reply_route" });
});

test("provenance projects authenticated observations, never payload assertions", () => {
  const sender = { ...remote, ...mapped, token: "DO_NOT_EXPORT", sender_provenance: { principal: "forged" } };
  const result = createLocalSenderProvenance({ requestId: "r", sender, recipient: local, metadata: { principal: "forged" } });
  assert.equal(result.principal, mapped.principal);
  assert.equal(result.recipient_principal, null);
  assert.equal(result.via.authenticated_peer, remote.address);
  assert.equal(result.assurance.principal_binding, "owner-mapped-disk-observation");
  assert.ok(!JSON.stringify(result).includes("DO_NOT_EXPORT"));
  assert.ok(!JSON.stringify(result).includes("forged"));
  assert.equal(createLocalSenderProvenance({ requestId: "r", sender: remote, recipient: local }).assurance.principal_binding, "unbound");
});

test("malformed identity or partial authority cannot create a route", () => {
  for (const bad of [null, {}, { ...local, generation: 0 }, { ...local, generation: Number.MAX_SAFE_INTEGER + 1 }, { ...local, principal: mapped.principal }, { ...local, authorityOrigin: mapped.authorityOrigin }, { ...local, ...mapped, authorityOrigin: "https://user:secret@example.test" }]) {
    assert.throws(() => createLocalReplyRoute({ requestId: "r", local: bad, remote }), { code: "invalid_reply_identity" });
  }
  assert.throws(() => createLocalReplyRoute({ requestId: "", local, remote }), { code: "invalid_reply_route" });
});
