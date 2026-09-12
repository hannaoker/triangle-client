import assert from "node:assert/strict";
import test from "node:test";

import {
  createHelperTrustedTransactionProxy,
  deriveTrustedClaimId,
  deriveTrustedReplyIdempotencyKey,
  resolveTrustedTransactionProxy,
} from "../src/helper-transaction-proxy.mjs";
import {
  createTrustedTransactionProxy,
  createTrustedTransactionProxyStub,
} from "../src/shared-codex-app-server.mjs";

const instanceId = "a".repeat(64);
const roomId = `room_${"a".repeat(32)}`;
const eventId = `event_${"b".repeat(32)}`;

test("deterministic claim/reply IDs match framed SHA-256 contract", () => {
  const claim = deriveTrustedClaimId(instanceId, 12);
  const reply = deriveTrustedReplyIdempotencyKey(instanceId, 12);
  assert.match(claim, /^claim_[a-f0-9]{32}$/);
  assert.match(reply, /^reply_[a-f0-9]{32}$/);
  assert.notEqual(claim, reply);
  assert.equal(deriveTrustedClaimId(instanceId, 12), claim);
});

test("stub remains fail-closed without helper", async () => {
  const proxy = createTrustedTransactionProxy({});
  assert.equal(proxy.name, "slice6_trusted_transaction_proxy_stub");
  await assert.rejects(() => proxy.claim(), (error) => error.code === "slice6_required");
});

test("coordinator-delivery without profile stays fail-closed", () => {
  const proxy = createTrustedTransactionProxy({
    helperPath: "/trusted/triangle-mailbox",
    protocol: "coordinator-delivery-v1",
  });
  assert.equal(proxy.name, "slice6_trusted_transaction_proxy_stub");
});

test("helper proxy invokes claim/reply/ack CLI with secret-free args", async () => {
  const calls = [];
  const proxy = createHelperTrustedTransactionProxy({
    helperPath: "/trusted/triangle-mailbox",
    profile: "hermes-bot",
    protocol: "coordinator-delivery-v1",
    async run(file, args, options = {}) {
      calls.push({ file, args, stdin: options.stdin ?? null });
      if (args[0] === "transaction-claim") {
        return {
          code: 0,
          stdout: JSON.stringify({
            deliveryId: 12,
            roomId,
            claimId: deriveTrustedClaimId(instanceId, 12),
            replyIdempotencyKey: deriveTrustedReplyIdempotencyKey(instanceId, 12),
            state: "claimed",
            protocol: "coordinator-delivery-v1",
          }),
          stderr: "",
        };
      }
      if (args[0] === "transaction-reply") {
        assert.equal(typeof options.stdin, "string");
        assert.match(options.stdin, /"text":"hello"/);
        assert.ok(!args.includes("hello"), "reply text must not appear in argv");
        return {
          code: 0,
          stdout: JSON.stringify({
            deliveryId: 12,
            state: "replied",
            replyResolution: "created",
            replyIdempotencyKey: deriveTrustedReplyIdempotencyKey(instanceId, 12),
            replyEventId: eventId,
          }),
          stderr: "",
        };
      }
      if (args[0] === "transaction-ack") {
        return { code: 0, stdout: JSON.stringify({ acknowledged: true }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  });

  const claimed = await proxy.claim({ deliveryId: 12, roomId, eventId });
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.claimId, deriveTrustedClaimId(instanceId, 12));

  const replied = await proxy.reply({ roomId, text: "hello" });
  assert.equal(replied.state, "replied");

  const acked = await proxy.ack();
  assert.equal(acked.acknowledged, true);

  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ["transaction-claim", "transaction-reply", "transaction-ack"],
  );
  assert.ok(calls[0].args.includes("--protocol"));
  assert.ok(calls[0].args.includes("coordinator-delivery-v1"));
});

test("helper proxy maps transaction_stuck exit code", async () => {
  const proxy = createHelperTrustedTransactionProxy({
    helperPath: "/trusted/triangle-mailbox",
    profile: "hermes-bot",
    protocol: "coordinator-delivery-v1",
    async run() {
      return { code: 4, stdout: JSON.stringify({ error: "transaction_stuck" }), stderr: "" };
    },
  });
  await assert.rejects(
    () => proxy.status(),
    (error) => error.code === "transaction_stuck",
  );
});

test("resolveTrustedTransactionProxy prefers helper when available", () => {
  const proxy = resolveTrustedTransactionProxy({
    helperPath: "/trusted/triangle-mailbox",
    profile: "hermes-bot",
    protocol: "coordinator-delivery-v1",
    createStub: createTrustedTransactionProxyStub,
  });
  assert.equal(proxy.name, "slice6_helper_trusted_transaction_proxy");
});

test("malicious helper path is rejected before spawn", () => {
  assert.throws(
    () =>
      createHelperTrustedTransactionProxy({
        helperPath: "relative/triangle-mailbox",
        profile: "hermes-bot",
        protocol: "coordinator-delivery-v1",
      }),
    /helperPath/,
  );
});
