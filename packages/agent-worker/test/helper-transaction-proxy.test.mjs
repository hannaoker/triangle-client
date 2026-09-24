import assert from "node:assert/strict";
import test from "node:test";

import {
  createHelperDurableDeliveryResolver,
  createHelperTrustedTransactionProxy,
  deriveTrustedClaimId,
  deriveTrustedReplyIdempotencyKey,
  resolveTrustedTransactionProxy,
} from "../src/helper-transaction-proxy.mjs";
import {
  createProductionAppServerDeliveryResolver,
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

test("helper proxy maps unverified_reply_conflict exit code", async () => {
  const proxy = createHelperTrustedTransactionProxy({
    helperPath: "/trusted/triangle-mailbox",
    profile: "hermes-bot",
    protocol: "coordinator-delivery-v1",
    async run() {
      return { code: 5, stdout: JSON.stringify({ error: "unverified_reply_conflict" }), stderr: "" };
    },
  });
  await assert.rejects(
    () => proxy.reply({ roomId, text: "unverified" }),
    (error) => error.code === "unverified_reply_conflict",
  );
});

test("helper proxy retries credential_busy then succeeds", async () => {
  const calls = [];
  const proxy = createHelperTrustedTransactionProxy({
    helperPath: "/trusted/triangle-mailbox",
    profile: "bob",
    protocol: "self-serve-drain",
    busyRetryLimit: 3,
    async run(_file, args) {
      calls.push(args[0]);
      if (calls.length < 3) {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            status: "credential_busy",
            code: "credential_busy",
            mustNotReregister: true,
            safeToRetry: true,
            detail: "Enrollment reservation is busy; retry without reminting or reregistering.",
          }),
        };
      }
      return { code: 0, stdout: JSON.stringify({ acknowledged: true }), stderr: "" };
    },
  });
  const acked = await proxy.ack();
  assert.equal(acked.acknowledged, true);
  assert.deepEqual(calls, ["transaction-ack", "transaction-ack", "transaction-ack"]);
});

test("helper proxy surfaces credential_busy after retries and never journal_ineligible for lock", async () => {
  let attempts = 0;
  const proxy = createHelperTrustedTransactionProxy({
    helperPath: "/trusted/triangle-mailbox",
    profile: "bob",
    protocol: "self-serve-drain",
    busyRetryLimit: 2,
    async run() {
      attempts += 1;
      return {
        code: 1,
        stdout: "",
        stderr: JSON.stringify({
          status: "credential_busy",
          code: "credential_busy",
          mustNotReregister: true,
          safeToRetry: true,
          detail: "Enrollment reservation is busy",
        }),
      };
    },
  });
  await assert.rejects(
    () => proxy.ack(),
    (error) => (
      error.code === "credential_busy"
      && error.safeToRetry === true
      && error.code !== "journal_ineligible"
    ),
  );
  assert.equal(attempts, 2);
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

test("durable delivery resolver returns null when helper status is empty", async () => {
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "event-codex",
    protocol: "self-serve-drain",
    createProxy: createTrustedTransactionProxy,
    async run(_file, args) {
      assert.equal(args[0], "transaction-claim-next");
      return {
        code: 0,
        stdout: JSON.stringify({
          shouldStartModel: false,
          transactionStuck: false,
          open: null,
          status: "idle",
        }),
        stderr: "",
      };
    },
  });
  assert.equal(await resolveDelivery({ reason: "wake" }), null);
});

test("durable delivery resolver pins claim-next to the configured room", async () => {
  const calls = [];
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "event-codex",
    protocol: "self-serve-drain",
    allowedRoomId: roomId,
    createProxy: createTrustedTransactionProxy,
    async run(_file, args) {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({ shouldStartModel: false, transactionStuck: false, open: null }),
        stderr: "",
      };
    },
  });

  assert.equal(await resolveDelivery(), null);
  assert.deepEqual(calls[0].slice(-2), ["--room-id", roomId]);
});

test("durable delivery resolver reads exact claimed inbound text when list omits admitText", async () => {
  const commands = [];
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "event-codex",
    protocol: "self-serve-drain",
    allowedRoomId: roomId,
    createProxy: createTrustedTransactionProxy,
    async run(_file, args) {
      commands.push(args[0]);
      if (args[0] === "transaction-claim-next") {
        return { code: 0, stderr: "", stdout: JSON.stringify({
          shouldStartModel: true,
          replyRequired: true,
          open: { deliveryId: 77, roomId, inboundEventId: eventId, state: "claimed" },
        }) };
      }
      assert.equal(args[0], "transaction-read-inbound");
      return { code: 0, stderr: "", stdout: JSON.stringify({
        deliveryId: 77,
        roomId,
        inboundEventId: eventId,
        text: "exact peer request",
      }) };
    },
  });

  const delivery = await resolveDelivery();
  assert.equal(delivery.text, "exact peer request");
  assert.deepEqual(commands, ["transaction-claim-next", "transaction-read-inbound"]);
});

test("durable delivery resolver maps open helper status into admit payload", async () => {
  const resolveDelivery = createProductionAppServerDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "event-codex",
    async run(_file, args) {
      if (args[0] === "transaction-read-inbound") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ deliveryId: 42, roomId, inboundEventId: eventId, text: "peer request 42" }) };
      }
      assert.equal(args[0], "transaction-claim-next");
      assert.ok(args.includes("coordinator-delivery-v1"));
      return {
        code: 0,
        stdout: JSON.stringify({
          shouldStartModel: true,
          transactionStuck: false,
          open: {
            deliveryId: 42,
            roomId,
            inboundEventId: eventId,
            state: "claimed",
          },
        }),
        stderr: "",
      };
    },
  });
  const delivery = await resolveDelivery({ reason: "wake", highWatermark: 7 });
  assert.equal(delivery.deliveryId, "delivery_42");
  assert.equal(delivery.text, "peer request 42");
  assert.doesNotMatch(delivery.text, /mesh_/);
});

test("durable delivery resolver claims next from pending mailbox with no open transaction", async () => {
  const calls = [];
  const resolveDelivery = createProductionAppServerDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "event-codex",
    async run(_file, args) {
      calls.push(args[0]);
      if (args[0] === "transaction-read-inbound") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ deliveryId: 51, roomId, inboundEventId: eventId, text: "peer request 51" }) };
      }
      assert.equal(args[0], "transaction-claim-next");
      // Helper performed list → preflight → claim; Node only sees the resulting open claim.
      return {
        code: 0,
        stdout: JSON.stringify({
          shouldStartModel: true,
          transactionStuck: false,
          status: "open_transaction",
          open: {
            deliveryId: 51,
            roomId,
            inboundEventId: eventId,
            state: "claimed",
          },
        }),
        stderr: "",
      };
    },
  });
  const delivery = await resolveDelivery({ reason: "wake" });
  assert.deepEqual(calls, ["transaction-claim-next", "transaction-read-inbound"]);
  assert.equal(delivery.deliveryId, "delivery_51");
  assert.equal(delivery.text, "peer request 51");
  assert.doesNotMatch(delivery.text, /mesh_/);
});

test("durable delivery resolver prefers admitText and inboundEventId from claim-next", async () => {
  const inboundEventId = "event_" + "f".repeat(32);
  const resolveDelivery = createProductionAppServerDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "event-codex",
    async run(_file, args) {
      assert.equal(args[0], "transaction-claim-next");
      return {
        code: 0,
        stdout: JSON.stringify({
          shouldStartModel: true,
          transactionStuck: false,
          status: "open_transaction",
          admitText: "Bob says hello with nonce CODEX-APPSERVER-test",
          open: {
            deliveryId: 91,
            roomId,
            state: "claimed",
            inboundEventId,
          },
        }),
        stderr: "",
      };
    },
  });
  const delivery = await resolveDelivery({ reason: "wake" });
  assert.equal(delivery.deliveryId, "delivery_91");
  assert.equal(delivery.roomId, roomId);
  assert.equal(delivery.inboundEventId, inboundEventId);
  assert.equal(delivery.text, "Bob says hello with nonce CODEX-APPSERVER-test");
  assert.doesNotMatch(delivery.text, /mesh_/);
});

test("durable delivery resolver skips admit for helper receipt-only claim-next", async () => {
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "event-codex",
    protocol: "self-serve-drain",
    createProxy: createTrustedTransactionProxy,
    async run(_file, args) {
      assert.equal(args[0], "transaction-claim-next");
      return {
        code: 0,
        stdout: JSON.stringify({
          shouldStartModel: false,
          transactionStuck: false,
          replyRequired: false,
          receiptOnly: true,
          open: null,
          status: "empty",
        }),
        stderr: "",
      };
    },
  });
  assert.equal(await resolveDelivery({ reason: "wake" }), null);
});

test("durable delivery resolver fails closed when an older helper leaves a receipt claim open", async () => {
  const calls = [];
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "event-codex",
    protocol: "self-serve-drain",
    createProxy: createTrustedTransactionProxy,
    async run(_file, args) {
      calls.push(args[0]);
      if (args[0] === "transaction-claim-next") {
        return {
          code: 0,
          stdout: JSON.stringify({
            shouldStartModel: true,
            transactionStuck: false,
            replyRequired: false,
            open: {
              deliveryId: 77,
              roomId,
              state: "claimed",
            },
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected helper command ${args[0]}`);
    },
  });
  await assert.rejects(
    resolveDelivery({ reason: "wake" }),
    (error) => error?.code === "receipt_only_helper_upgrade_required",
  );
  assert.deepEqual(calls, ["transaction-claim-next"]);
});

test("durable delivery resolver acks verified replied open before admitting more work", async () => {
  const calls = [];
  let claimPhase = 0;
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "event-codex",
    protocol: "self-serve-drain",
    createProxy: createTrustedTransactionProxy,
    async run(_file, args) {
      calls.push(args[0]);
      if (args[0] === "transaction-claim-next") {
        claimPhase += 1;
        if (claimPhase === 1) {
          return {
            code: 0,
            stdout: JSON.stringify({
              shouldStartModel: false,
              transactionStuck: false,
              replyRequired: true,
              open: {
                deliveryId: 42,
                roomId,
                state: "replied",
                inboundEventId: eventId,
              },
            }),
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            shouldStartModel: true,
            transactionStuck: false,
            replyRequired: true,
            admitText: "next turn after replied ack",
            open: {
              deliveryId: 43,
              roomId,
              state: "claimed",
              inboundEventId: eventId,
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "transaction-ack") {
        return { code: 0, stdout: JSON.stringify({ acknowledged: true }), stderr: "" };
      }
      throw new Error(`unexpected helper command ${args[0]}`);
    },
  });
  const delivery = await resolveDelivery({ reason: "wake" });
  assert.equal(delivery.deliveryId, "delivery_43");
  assert.equal(delivery.text, "next turn after replied ack");
  assert.deepEqual(calls, [
    "transaction-claim-next",
    "transaction-ack",
    "transaction-claim-next",
  ]);
});

test("durable delivery resolver crash-boundary: reply-committed before ack is settled on next poll", async () => {
  const calls = [];
  let claimPhase = 0;
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "cursor-acp-shadow-test",
    protocol: "self-serve-drain",
    createProxy: createTrustedTransactionProxy,
    async run(_file, args) {
      calls.push(args[0]);
      if (args[0] === "transaction-claim-next") {
        claimPhase += 1;
        if (claimPhase === 1) {
          // Crash window: reply persisted, ack never happened.
          return {
            code: 0,
            stdout: JSON.stringify({
              shouldStartModel: true,
              transactionStuck: false,
              replyRequired: true,
              open: {
                deliveryId: 9,
                roomId,
                state: "replied",
                inboundEventId: eventId,
              },
            }),
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            shouldStartModel: false,
            transactionStuck: false,
            replyRequired: true,
            open: null,
            status: "empty",
          }),
          stderr: "",
        };
      }
      if (args[0] === "transaction-ack") {
        return { code: 0, stdout: JSON.stringify({ acknowledged: true }), stderr: "" };
      }
      throw new Error(`unexpected helper command ${args[0]}`);
    },
  });
  assert.equal(await resolveDelivery({ reason: "recover" }), null);
  assert.deepEqual(calls, [
    "transaction-claim-next",
    "transaction-ack",
    "transaction-claim-next",
  ]);
});

test("durable delivery resolver crash-boundary: ack-committed before local clear is idle", async () => {
  const calls = [];
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "cursor-acp-shadow-test",
    protocol: "self-serve-drain",
    createProxy: createTrustedTransactionProxy,
    async run(_file, args) {
      calls.push(args[0]);
      assert.equal(args[0], "transaction-claim-next");
      // Ack already committed in helper; open cleared; local process died before clear.
      return {
        code: 0,
        stdout: JSON.stringify({
          shouldStartModel: false,
          transactionStuck: false,
          replyRequired: true,
          open: null,
          status: "empty",
        }),
        stderr: "",
      };
    },
  });
  assert.equal(await resolveDelivery({ reason: "recover" }), null);
  assert.deepEqual(calls, ["transaction-claim-next"]);
});
