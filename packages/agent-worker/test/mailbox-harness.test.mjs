import assert from "node:assert/strict";
import test from "node:test";

import { createConcurrencyGate } from "../src/concurrency-gate.mjs";
import { createMailboxClient } from "../src/mailbox-client.mjs";
import {
  createMailboxHarness,
  createProfileScheduler,
} from "../src/profile-scheduler.mjs";

const id = (index) => index.toString(16).padStart(64, "0");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function canonicalEvent({ id: eventId, roomId, sequence, senderAgentId, text }) {
  return {
    id: eventId,
    roomId,
    sequence,
    senderAgentId,
    type: "message.created",
    body: { text },
    idempotencyKey: `idem_${eventId}`,
    idempotency_key: `idem_${eventId}`,
  };
}

function createMailboxFetch({
  mailboxItems = [],
  roomHistoryByRoom = new Map(),
  claim = undefined,
} = {}) {
  const calls = [];
  const state = {
    calls,
    claims: new Map(),
    acknowledgeCount: 0,
    appendCount: 0,
    mailboxItems: [...mailboxItems],
    roomHistoryByRoom,
  };

  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const method = request.method;
    const body = method === "POST" ? await request.json() : undefined;
    calls.push({ url, method, body });

    if (url.pathname === "/api/v1/agents/me") {
      return json({ agent: { id: "agent_11111111111111111111111111111111" } });
    }
    if (url.pathname === "/api/v1/mailbox") {
      return json({ items: state.mailboxItems });
    }
    if (url.pathname.startsWith("/api/v1/rooms/") && url.pathname.endsWith("/events")) {
      const roomId = url.pathname.split("/")[4];
      if (method === "GET") {
        const after = Number(url.searchParams.get("after_sequence") ?? "0");
        const events = state.roomHistoryByRoom.get(roomId) ?? [];
        return json({
          roomId,
          items: events.filter((event) => event.sequence > after).slice(0, 100),
        });
      }
      state.appendCount += 1;
      const existing = state.roomHistoryByRoom.get(roomId) ?? [];
      const maxSequence = existing.reduce((value, event) => Math.max(value, event.sequence), 0);
      const event = {
        id: `event_${String(state.appendCount).padStart(32, "0")}`,
        roomId,
        sequence: maxSequence + 1,
        senderAgentId: "agent_11111111111111111111111111111111",
        type: "message.created",
        idempotencyKey: body.idempotency_key,
        body: body.body,
      };
      existing.push(event);
      state.roomHistoryByRoom.set(roomId, existing);
      state.mailboxItems = [];
      return json({ event });
    }
    if (url.pathname === "/api/v1/mailbox/ack") {
      state.acknowledgeCount += 1;
      state.mailboxItems = state.mailboxItems.filter((item) => item.deliveryId !== body.delivery_id);
      return json({ acknowledged: 1 });
    }
    if (url.pathname === "/api/v1/mailbox/claim") {
      if (claim) {
        const response = await claim(body, state);
        return response instanceof Response ? response : json(response);
      }
      const existing = state.claims.get(body.delivery_id);
      if (existing && existing !== body.claim_id) {
        return json({ error: "delivery_claim_conflict" }, 409);
      }
      state.claims.set(body.delivery_id, body.claim_id);
      return json({
        claimed: true,
        claimId: body.claim_id,
        claimedAt: "2026-08-07T00:00:00.000Z",
        idempotent: Boolean(existing),
      });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  };

  return { fetchImpl, state };
}

function createHarnessFixture({ claim } = {}) {
  const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const eventId = "event_00000000000000000000000000000002";
  const transport = createMailboxFetch({
    mailboxItems: [{
      deliveryId: 101,
      roomId,
      eventId,
      roomSequence: 1,
      state: "pending",
      createdAt: "2026-08-07T00:00:00Z",
    }],
    roomHistoryByRoom: new Map([[roomId, [canonicalEvent({
      id: eventId,
      roomId,
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      text: "wake me",
    })]]]),
    claim,
  });
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    meshToken: "mesh-secret",
    recipientId: "agent_11111111111111111111111111111111",
  }, { fetchImpl: transport.fetchImpl });
  let generates = 0;
  const runner = {
    async run(request) {
      generates += 1;
      return { status: "completed", text: `reply:${request.text}` };
    },
  };
  const harness = createMailboxHarness({
    clients: new Map([[id(1), client]]),
    runners: new Map([[id(1), runner]]),
  });
  return { harness, transport, generates: () => generates };
}

test("mailbox harness preflight is negative for an empty mailbox and never generates", async () => {
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    meshToken: "mesh-secret",
    recipientId: "agent_11111111111111111111111111111111",
  }, {
    fetchImpl: createMailboxFetch().fetchImpl,
  });
  let generates = 0;
  const harness = createMailboxHarness({
    clients: new Map([[id(1), client]]),
    runners: new Map([[id(1), {
      async run() {
        generates += 1;
        return { status: "completed", text: "nope" };
      },
    }]]),
  });
  assert.equal(await harness.preflight({ instanceId: id(1) }), false);
  assert.deepEqual(await harness.run({ instanceId: id(1) }), { status: "drained", processed: 0 });
  assert.equal(generates, 0);
});

test("mailbox harness drains through claim, generate, and ack", async () => {
  const { harness, transport, generates } = createHarnessFixture();
  assert.equal(await harness.preflight({ instanceId: id(1) }), true);
  assert.deepEqual(await harness.run({ instanceId: id(1) }), { status: "more", processed: 1 });
  assert.deepEqual(await harness.run({ instanceId: id(1) }), { status: "drained", processed: 0 });
  assert.equal(generates(), 1);
  assert.equal(transport.state.claims.size, 1);
  assert.equal(transport.state.acknowledgeCount, 1);
  assert.equal(transport.state.appendCount, 1);
  assert.equal(
    transport.state.calls.every((call) => !JSON.stringify(call.body ?? {}).includes("mesh-secret")),
    true,
  );
});

test("mailbox harness surfaces claim conflict as retryable failure", async () => {
  const { harness, generates } = createHarnessFixture({
    claim: async () => json({ error: "delivery_claim_conflict" }, 409),
  });
  assert.equal(await harness.preflight({ instanceId: id(1) }), true);
  await assert.rejects(
    () => harness.run({ instanceId: id(1) }),
    (error) => error?.code === "claim_conflict",
  );
  assert.equal(generates(), 0);
});

test("mailbox harness yields the shared gate after one completed delivery", async () => {
  let remaining = 2;
  const harness = createMailboxHarness({
    clients: new Map([[id(1), {
      async listUnread() {
        return remaining > 0 ? [{ messageId: `m${remaining}` }] : [];
      },
      async completeAndAcknowledge(_message, generate) {
        await generate({ text: "hi" });
        remaining -= 1;
        return { claimed: true, acknowledged: true };
      },
    }]]),
    runners: new Map([[id(1), {
      async run() { return { status: "completed", text: "ok" }; },
    }]]),
  });

  assert.deepEqual(await harness.run({ instanceId: id(1) }), { status: "more", processed: 1 });
  assert.equal(remaining, 1);
  assert.deepEqual(await harness.run({ instanceId: id(1) }), { status: "more", processed: 1 });
  assert.deepEqual(await harness.run({ instanceId: id(1) }), { status: "drained", processed: 0 });
});

test("scheduler + mailbox harness share one gate without double-wrapping runners", async () => {
  const gate = createConcurrencyGate({ limit: 1 });
  const release = deferred();
  let active = 0;
  let peak = 0;
  let generates = 0;

  const client = {
    async listUnread() {
      return generates === 0 ? [{ messageId: "m1", text: "hi" }] : [];
    },
    async completeAndAcknowledge(_message, generate) {
      active += 1;
      peak = Math.max(peak, active);
      await generate({ text: "hi" });
      active -= 1;
      return { reconciled: false, acknowledged: true };
    },
  };
  const runner = {
    async run() {
      generates += 1;
      await release.promise;
      return { status: "completed", text: "ok" };
    },
  };
  const harness = createMailboxHarness({
    clients: new Map([[id(1), client]]),
    runners: new Map([[id(1), runner]]),
  });
  const scheduler = createProfileScheduler({
    gate,
    harness,
    sleep: async () => {},
  });

  const workerTurn = gate.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await release.promise;
    active -= 1;
  });

  scheduler.submitWake({ instanceId: id(1), highWatermark: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak <= 1, true);
  release.resolve();
  await workerTurn;
  await scheduler.idle();
  assert.equal(generates, 1);
  assert.equal(peak, 1);
});

test("mailbox harness fails closed for unknown instance ids", async () => {
  const logs = [];
  const harness = createMailboxHarness({
    clients: new Map([[id(1), {
      async listUnread() { return []; },
      async completeAndAcknowledge() { return { acknowledged: true }; },
    }]]),
    runners: new Map([[id(1), { async run() { return { status: "completed", text: "ok" }; } }]]),
    logger: {
      error(event, details) {
        logs.push({ event, details: JSON.stringify(details ?? {}) });
      },
    },
  });
  await assert.rejects(
    () => harness.preflight({ instanceId: id(2) }),
    /no delivery client/i,
  );
  assert.equal(logs.length, 0);
});
