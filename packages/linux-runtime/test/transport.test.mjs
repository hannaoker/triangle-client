import test from "node:test";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { openCustody } from "../../triangle-cli/src/custody.mjs";
import { generateEd25519, publicJwk } from "../../triangle-cli/src/keys.mjs";
import { createFakeAuthority } from "../../triangle-cli/test/fake-authority.mjs";
import { AGENT_BOUNDS } from "../../triangle-cli/src/protocol.mjs";
import { createTransport } from "../src/transport.mjs";
import { replyDigest } from "../src/transaction.mjs";
const agentId = "agent_" + "a".repeat(32),
  workloadId = "workload_" + "b".repeat(32);
const r = {
  deliveryId: 1,
  roomId: "room_" + "c".repeat(32),
  eventId: "event_" + "d".repeat(32),
  roomSequence: 1,
  claimId: "claim_" + "e".repeat(32),
  replyKey: "reply_" + "f".repeat(32),
  replyDigest: replyDigest("answer"),
};
function setup(override) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "transport-test-")),
  );
  const c = openCustody(root).init(),
    key = generateEd25519();
  c.writeAuthority({ authority: "https://mesh.test" });
  c.writeAgent(agentId, { agent_id: agentId, workload_id: workloadId });
  c.writeWorkloadKey(agentId, key);
  // An inaccessible owner entry proves this boundary never reads owner custody.
  mkdirSync(path.join(root, "owner"));
  symlinkSync("/does/not/exist", path.join(root, "owner", "owner-key.json"));
  const fake = createFakeAuthority();
  fake.state.workloads.set(workloadId, {
    agent_id: agentId,
    jwk: publicJwk(key),
    bounds: AGENT_BOUNDS,
  });
  fake.state.agents.set(agentId, {
    state: "active",
    handle: "linux",
    permissions: { "dm.send": true },
    revision: 1,
  });
  const fetchImpl = async (url, opts) => {
    if (
      new URL(url).pathname.startsWith("/api/v1/rooms/") ||
      new URL(url).pathname.startsWith("/api/v1/mailbox")
    ) {
      const [h, p, s] = opts.headers.dpop.split(".");
      const head = JSON.parse(Buffer.from(h, "base64url"));
      const proof = JSON.parse(Buffer.from(p, "base64url"));
      assert.equal(proof.htu, url);
      assert.equal(proof.htm, opts.method);
      assert.equal(
        crypto.verify(
          null,
          Buffer.from(h + "." + p),
          crypto.createPublicKey({ key: head.jwk, format: "jwk" }),
          Buffer.from(s, "base64url"),
        ),
        true,
      );
      assert.match(opts.headers.authorization, /^Bearer at_/);
      return override(url, opts);
    }
    return fake.fetchImpl(url, opts);
  };
  return {
    transport: createTransport({
      identityHome: root,
      agentId,
      env: {},
      fetchImpl,
    }),
    fake,
  };
}
const json = (b) =>
  new Response(JSON.stringify(b), {
    headers: { "content-type": "application/json" },
  });
const event = () => ({
  id: "event_" + "1".repeat(32),
  roomId: r.roomId,
  sequence: 2,
  type: "message.created",
  senderAgentId: agentId,
  idempotencyKey: r.replyKey,
  body: { text: "answer", replyRequired: false, inReplyToEventId: r.eventId },
});
test("workload challenge and DPoP work without owner key; paused is refused", async () => {
  const f = setup();
  assert.equal((await f.transport.verify()).agentId, agentId);
  f.fake.state.agents.get(agentId).state = "paused";
  await assert.rejects(f.transport.verify(), /agent_not_active/);
});
test("reconciliation verifies exact reply body, sender, source and key", async () => {
  let e = event();
  const { transport } = setup(() => json({ roomId: r.roomId, items: [e] }));
  assert.equal((await transport.findReply(r)).eventId, e.id);
  for (const change of [
    { senderAgentId: "agent_" + "2".repeat(32) },
    { roomId: "room_" + "2".repeat(32) },
    { body: { ...event().body, text: "different" } },
    { body: { ...event().body, inReplyToEventId: "event_" + "2".repeat(32) } },
  ]) {
    e = { ...event(), ...change };
    await assert.rejects(transport.findReply(r), /invalid_authority_response/);
  }
});
test("reply and claim send exact protected protocol shapes", async () => {
  const calls = [];
  const { transport } = setup((url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (url.endsWith("/claim"))
      return json({
        claimed: true,
        claimId: r.claimId,
        idempotent: false,
        claimedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
      });
    return json({ event: event() });
  });
  await transport.claim(r);
  await transport.reply(r, "answer");
  assert.deepEqual(calls[0], { delivery_id: 1, claim_id: r.claimId });
  assert.deepEqual(calls[1], {
    type: "message.created",
    body: { text: "answer", replyRequired: false, inReplyToEventId: r.eventId },
    idempotency_key: r.replyKey,
  });
});
test("aborted token exchange returns promptly and network receives abort signal", async () => {
  let entered;
  const ready = new Promise((r) => (entered = r));
  const f = setup();
  const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "transport-abort-")),
    ),
    c = openCustody(root).init();
  c.writeAuthority({ authority: "https://mesh.test" });
  c.writeAgent(agentId, { agent_id: agentId, workload_id: workloadId });
  c.writeWorkloadKey(agentId, generateEd25519());
  let networkSignal;
  const t = createTransport({
    identityHome: root,
    agentId,
    env: {},
    fetchImpl: async (url, opts) => {
      networkSignal = opts.signal;
      entered();
      return new Promise((resolve, reject) =>
        opts.signal.addEventListener(
          "abort",
          () => reject(opts.signal.reason),
          { once: true },
        ),
      );
    },
  });
  const ac = new AbortController();
  const p = t.verify({ signal: ac.signal });
  await ready;
  ac.abort();
  await assert.rejects(p);
  assert.equal(networkSignal.aborted, true);
});
