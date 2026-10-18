import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createMailboxClient, MailboxRequestError, parseWorkloadPrivateKey, validateMailboxClientOptions } from "../src/mailbox-client.mjs";
import { TEST_WORKLOAD, testTokens } from "./support/test-workload.mjs";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function replyIdFromMessage(message) {
  const identity = {
    recipientId: message.recipientId,
    senderId: message.senderId,
    messageId: message.messageId,
    taskId: message.taskId,
    contextId: message.contextId,
  };
  return `reply_${crypto
    .createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("base64url")}`;
}

function createMailboxFetch({
  mailboxResponse = { items: [] },
  roomHistoryByRoom = new Map(),
  acknowledge = () => ({ acknowledged: 1 }),
  claim = undefined,
  appendEvent = (roomId, body, state) => {
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
      idempotency_key: body.idempotency_key,
      body: body.body,
    };
    existing.push(event);
    state.roomHistoryByRoom.set(roomId, existing);
    return {
      event,
    };
  },
} = {}) {
  const calls = [];
  const state = {
    roomHistoryByRoom,
    calls,
    claims: new Map(),
    acknowledgeCount: 0,
    appendCount: 0,
  };

  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const method = request.method;
    const body = method === "POST" ? await request.json() : undefined;
    calls.push({ request, url, method, body });

    if (url.pathname === "/api/v1/agents/me") {
      return json({ agent: { id: "agent_11111111111111111111111111111111" } });
    }

    if (url.pathname === "/api/v1/mailbox") {
      return json(mailboxResponse);
    }

    if (url.pathname.startsWith("/api/v1/rooms/") && url.pathname.endsWith("/events")) {
      const roomId = url.pathname.split("/")[4];
      if (method === "GET") {
        const after = Number(url.searchParams.get("after_sequence") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "1");
        const events = state.roomHistoryByRoom.get(roomId) ?? [];
        const filtered = events.filter((event) => event.sequence > after).slice(0, limit);
        return json({ roomId, items: filtered });
      }

      try {
        return json(appendEvent(roomId, body, state));
      } catch (error) {
        throw error;
      }
    }

    if (url.pathname === "/api/v1/mailbox/ack") {
      state.acknowledgeCount += 1;
      const response = await acknowledge(body, state);
      return response instanceof Response ? response : json(response);
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

function canonicalEvent({ id, roomId, sequence, senderAgentId, type, text, idempotencyKey }) {
  return {
    id,
    roomId,
    sequence,
    senderAgentId,
    type,
    body: { text },
    idempotencyKey,
    idempotency_key: idempotencyKey,
  };
}

function createRetryScenario(overrides = {}) {
  const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const eventId = "event_00000000000000000000000000000002";
  const mailboxResponse = { items: [{
    deliveryId: 101,
    roomId,
    eventId,
    roomSequence: 1,
    state: "pending",
    createdAt: "2026-08-07T00:00:00Z",
  }] };
  const transport = createMailboxFetch({
    mailboxResponse,
    roomHistoryByRoom: new Map([[roomId, [canonicalEvent({
      id: eventId,
      roomId,
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      type: "message.created",
      text: "retry safely",
    })]]]),
    ...overrides,
  });
  const config = {
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
  };
  return {
    ...transport,
    mailboxResponse,
    client: createMailboxClient(config, { workloadTokens: testTokens(), fetchImpl: transport.fetchImpl }),
    createSecondClient: () => createMailboxClient(config, { workloadTokens: testTokens(), fetchImpl: transport.fetchImpl }),
  };
}

test("listUnread authenticates and normalizes canonical mailbox deliveries", async () => {
  const roomHistory = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        canonicalEvent({
          id: "event_00000000000000000000000000000002",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "please reply",
        }),
      ],
    ],
  ]);

  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 12,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000002",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: roomHistory,
  });
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );

  const messages = await client.listUnread();

  assert.equal(state.calls.length, 3);
  assert.equal(state.calls[0].request.headers.get("authorization"), "Bearer mesh-secret");
  assert.equal(state.calls[0].request.cache, "no-store");
  assert.equal(state.calls[1].url.searchParams.get("after"), "0");
  assert.equal(state.calls[1].url.searchParams.get("limit"), "1");
  assert.equal(state.calls[2].url.searchParams.get("after_sequence"), "0");
  assert.equal(state.calls[2].url.searchParams.get("limit"), "1");
  assert.deepEqual(messages, [
    {
      messageId: "event_00000000000000000000000000000002",
      taskId: "event_00000000000000000000000000000002",
      contextId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      senderId: "agent_22222222222222222222222222222222",
      recipientId: "agent_11111111111111111111111111111111",
      text: "please reply",
      replyRequired: true,
    },
  ]);
});
test("listUnread does not query room history for empty mailbox", async () => {
  const { fetchImpl, state } = createMailboxFetch({});
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("secret"), fetchImpl },
  );

  assert.deepEqual(await client.listUnread(), []);
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].url.pathname, "/api/v1/mailbox");
});

test("listUnread skips unsupported events and processes later supported messages", async () => {
  let mailboxPage = 0;
  const roomHistoryByRoom = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        canonicalEvent({
          id: "event_00000000000000000000000000000013",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.updated",
          text: "unsupported",
        }),
        canonicalEvent({
          id: "event_00000000000000000000000000000012",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 2,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "please reply",
        }),
      ],
    ],
  ]);
  const mailboxPages = [
    {
      items: [
        {
          deliveryId: 30,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000013",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    {
      items: [
        {
          deliveryId: 31,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000012",
          roomSequence: 2,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
  ];
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const method = request.method;
    if (url.pathname === "/api/v1/agents/me") {
      return json({ agent: { id: "agent_11111111111111111111111111111111" } });
    }
    if (url.pathname === "/api/v1/mailbox") {
      return json(mailboxPages[Math.min(mailboxPage, mailboxPages.length - 1)], 200);
    }
    if (url.pathname.startsWith("/api/v1/rooms/") && url.pathname.endsWith("/events")) {
      if (method === "GET") {
        const after = Number(url.searchParams.get("after_sequence") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "1");
        const events = roomHistoryByRoom.get("room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") ?? [];
        const filtered = events.filter((event) => event.sequence > after).slice(0, limit);
        return json({ roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", items: filtered });
      }
    }
    if (url.pathname === "/api/v1/mailbox/ack") {
      return json({ acknowledged: 1 });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  };

  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );

  const firstPass = await client.listUnread();
  assert.equal(firstPass.length, 0);
  mailboxPage = 1;
  const secondPass = await client.listUnread();
  assert.equal(secondPass.length, 1);
  assert.equal(secondPass[0].messageId, "event_00000000000000000000000000000012");
});

for (const scenario of [
  { name: "missing text", body: {} },
  { name: "empty text", body: { text: "   " } },
  { name: "non-string text", body: { text: 12 } },
]) {
  test(`listUnread skips message.created events with ${scenario.name} and processes later supported messages`, async () => {
    let mailboxPage = 0;
    const roomHistoryByRoom = new Map([
      [
        "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        [
          {
            id: "event_00000000000000000000000000000013",
            roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            sequence: 1,
            senderAgentId: "agent_22222222222222222222222222222222",
            type: "message.created",
            body: scenario.body,
          },
          canonicalEvent({
            id: "event_00000000000000000000000000000012",
            roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            sequence: 2,
            senderAgentId: "agent_22222222222222222222222222222222",
            type: "message.created",
            text: "please reply",
          }),
        ],
      ],
    ]);

    const mailboxPages = [
      {
        items: [
          {
            deliveryId: 40,
            roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            eventId: "event_00000000000000000000000000000013",
            roomSequence: 1,
            state: "pending",
            createdAt: "2026-08-07T00:00:00Z",
          },
        ],
      },
      {
        items: [
          {
            deliveryId: 41,
            roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            eventId: "event_00000000000000000000000000000012",
            roomSequence: 2,
            state: "pending",
            createdAt: "2026-08-07T00:00:00Z",
          },
        ],
      },
    ];
    const calls = [];
    const fetchImpl = async (request) => {
      const url = new URL(request.url);
      const method = request.method;
      calls.push({
        method,
        pathname: url.pathname,
        body: method === "POST" ? await request.json() : undefined,
      });
      if (url.pathname === "/api/v1/agents/me") {
        return json({ agent: { id: "agent_11111111111111111111111111111111" } });
      }
      if (url.pathname === "/api/v1/mailbox") {
        return json(mailboxPages[Math.min(mailboxPage, mailboxPages.length - 1)], 200);
      }
      if (url.pathname.startsWith("/api/v1/rooms/") && url.pathname.endsWith("/events")) {
        if (method === "GET") {
          const after = Number(url.searchParams.get("after_sequence") ?? "0");
          const limit = Number(url.searchParams.get("limit") ?? "1");
          const events = roomHistoryByRoom.get("room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") ?? [];
          const filtered = events.filter((event) => event.sequence > after).slice(0, limit);
          return json({ roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", items: filtered });
        }
      }
      if (url.pathname === "/api/v1/mailbox/ack") {
        return json({ acknowledged: 1 });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    };

    const client = createMailboxClient(
      {
        meshUrl: "https://mesh.example",
        ...TEST_WORKLOAD,
        recipientId: "agent_11111111111111111111111111111111",
        pageLimit: 1,
      },
      { workloadTokens: testTokens("mesh-secret"), fetchImpl },
    );

    const firstPass = await client.listUnread();
    assert.equal(firstPass.length, 0);
    mailboxPage = 1;
    const secondPass = await client.listUnread();
    assert.equal(secondPass.length, 1);
    assert.equal(secondPass[0].messageId, "event_00000000000000000000000000000012");
    assert.equal(
      calls.filter((call) => call.pathname === "/api/v1/mailbox/ack").length,
      1,
    );
    assert.equal(
      calls.filter((call) => call.pathname === "/api/v1/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/events" && call.method === "GET").length,
      2,
    );
  });
}

test("completeAndAcknowledge generates once, persists reply, then acknowledges", async () => {
  const roomHistory = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        canonicalEvent({
          id: "event_00000000000000000000000000000002",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "please reply",
        }),
      ],
    ],
  ]);
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 15,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000002",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: roomHistory,
  });
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );
  const [message] = await client.listUnread();
  const expectedReplyId = replyIdFromMessage(message);
  let generateCalls = 0;

  const result = await client.completeAndAcknowledge(message, () => {
    generateCalls += 1;
    return { status: "completed", text: "reply text" };
  });

  assert.deepEqual(result, { reconciled: false, acknowledged: true });
  assert.equal(generateCalls, 1);
  assert.equal(state.appendCount, 1);
  assert.equal(state.acknowledgeCount, 1);
  const appendRequest = state.calls.find(
    (call) => call.url.pathname === "/api/v1/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/events" && call.method === "POST",
  );
  assert.equal(appendRequest.body.idempotency_key, expectedReplyId);
  assert.equal(
    Object.hasOwn(appendRequest.body, "idempotencyKey"),
    false,
  );
  assert.equal(Object.hasOwn(appendRequest.body, "idempotency_key"), true);

  const resultAgain = await client.completeAndAcknowledge(message, () => {
    generateCalls += 1;
    return { status: "completed", text: "never again" };
  });
  assert.equal(generateCalls, 1);
  assert.deepEqual(resultAgain, { reconciled: true, acknowledged: true });
  assert.equal(state.appendCount, 1);
  assert.equal(state.acknowledgeCount, 2);
});

test("completeAndAcknowledge does not generate for replyRequired=false messages", async () => {
  const roomHistory = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        {
          id: "event_00000000000000000000000000000002",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          body: {
            text: "please reply",
            replyRequired: false,
          },
        },
      ],
    ],
  ]);
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 23,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000002",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: roomHistory,
  });
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );
  const [message] = await client.listUnread();
  let generateCalls = 0;
  const result = await client.completeAndAcknowledge(message, () => {
    generateCalls += 1;
    return { status: "completed", text: "should not happen" };
  });
  assert.equal(generateCalls, 0);
  assert.deepEqual(result, { reconciled: false, acknowledged: true });
  assert.equal(state.appendCount, 0);
  assert.equal(state.acknowledgeCount, 1);
});

test("completeAndAcknowledge loses append response after durable append and reconciles on retry", async () => {
  const roomHistory = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        canonicalEvent({
          id: "event_00000000000000000000000000000002",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "please reply",
        }),
      ],
    ],
  ]);
  let appendCall = 0;
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 16,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000002",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: roomHistory,
    appendEvent: (roomId, body, stateObj) => {
      stateObj.appendCount += 1;
      const existing = stateObj.roomHistoryByRoom.get(roomId) ?? [];
      const maxSequence = existing.reduce((value, event) => Math.max(value, event.sequence), 0);
      const event = {
        id: "event_00000000000000000000000000000015",
        roomId,
        sequence: maxSequence + 1,
        senderAgentId: "agent_11111111111111111111111111111111",
        type: "message.created",
        idempotencyKey: body.idempotency_key,
        body: body.body,
      };
      existing.push(event);
      stateObj.roomHistoryByRoom.set(roomId, existing);
      appendCall += 1;
      if (appendCall === 1) {
        throw new Error("reply response dropped");
      }
      return {
        event,
      };
    },
  });
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );
  const [message] = await client.listUnread();
  let generateCalls = 0;
  const generate = () => {
    generateCalls += 1;
    return { status: "completed", text: "reply text" };
  };

  await assert.rejects(client.completeAndAcknowledge(message, generate), /response dropped/);
  assert.equal(generateCalls, 1);
  assert.equal(state.appendCount, 1);
  assert.equal(state.acknowledgeCount, 0);

  const result = await client.completeAndAcknowledge(message, generate);
  assert.equal(generateCalls, 1);
  assert.deepEqual(result, { reconciled: true, acknowledged: true });
  assert.equal(state.appendCount, 1);
  assert.equal(state.acknowledgeCount, 1);
});

test("completeAndAcknowledge retries lost ack with no extra generation", async () => {
  const roomHistory = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        canonicalEvent({
          id: "event_00000000000000000000000000000002",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "please reply",
        }),
      ],
    ],
  ]);
  let ackAttempt = 0;
  let retryAckReturned = false;
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 17,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000002",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: roomHistory,
    acknowledge: () => {
      if (ackAttempt++ === 0) {
        throw new Error("ack response lost");
      }
      retryAckReturned = true;
      return { acknowledged: 0 };
    },
  });
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );

  const [message] = await client.listUnread();
  let generateCalls = 0;
  const generate = () => {
    generateCalls += 1;
    return { status: "completed", text: "retry-able reply" };
  };

  await assert.rejects(
    client.completeAndAcknowledge(message, generate),
    /ack response lost/,
  );
  assert.equal(generateCalls, 1);
  assert.equal(state.appendCount, 1);
  assert.equal(state.acknowledgeCount, 1);
  assert.equal(retryAckReturned, false);

  const result = await client.completeAndAcknowledge(message, generate);
  assert.equal(generateCalls, 1);
  assert.deepEqual(result, { reconciled: true, acknowledged: true });
  assert.equal(state.acknowledgeCount, 2);
  assert.equal(retryAckReturned, true);
});

test("completeAndAcknowledge rejects oversized generated replies before append", async () => {
  const roomHistory = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        canonicalEvent({
          id: "event_00000000000000000000000000000002",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "please reply",
        }),
      ],
    ],
  ]);
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 25,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000002",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: roomHistory,
  });
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );
  const [message] = await client.listUnread();
  await assert.rejects(
    client.completeAndAcknowledge(message, () => ({
      status: "completed",
      text: "x".repeat(MAX_BODY_BYTES + 1),
    })),
    /Mailbox reply body is too large/,
  );
  assert.equal(state.appendCount, 0);
  assert.equal(state.acknowledgeCount, 0);
});

test("completeAndAcknowledge rejects replies when append response text mismatches generated result", async () => {
  const roomHistory = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        canonicalEvent({
          id: "event_00000000000000000000000000000002",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "please reply",
        }),
      ],
    ],
  ]);
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 26,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000002",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: roomHistory,
    appendEvent: (roomId, body) => {
      state.appendCount += 1;
      return {
        event: {
          id: "event_00000000000000000000000000000009",
          roomId,
          sequence: 2,
          senderAgentId: "agent_11111111111111111111111111111111",
          type: "message.created",
          idempotency_key: body.idempotency_key,
          idempotencyKey: body.idempotency_key,
          body: {
            text: "different reply text",
            replyRequired: false,
            inReplyToEventId: "event_00000000000000000000000000000002",
          },
        },
      };
    },
  });
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );
  const [message] = await client.listUnread();
  let generateCalls = 0;
  const generate = () => {
    generateCalls += 1;
    return { status: "completed", text: "reply text" };
  };

  await assert.rejects(
    client.completeAndAcknowledge(message, generate),
    /Mailbox reply persistence returned invalid event/,
  );
  assert.equal(generateCalls, 1);
  assert.equal(state.appendCount, 1);
  assert.equal(state.acknowledgeCount, 0);
});

test("completeAndAcknowledge does not ack after failed append and retries generate", async () => {
  const roomHistory = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        canonicalEvent({
          id: "event_00000000000000000000000000000002",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "please reply",
        }),
      ],
    ],
  ]);
  let appendCall = 0;
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 18,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000002",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
  roomHistoryByRoom: roomHistory,
    appendEvent: (_, body) => {
      appendCall += 1;
      state.appendCount += 1;
      if (appendCall === 1) {
        throw new Error("append failed");
      }
      return {
        event: {
          id: "event_00000000000000000000000000000008",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 2,
          senderAgentId: "agent_11111111111111111111111111111111",
          type: "message.created",
          idempotency_key: body.idempotency_key,
          idempotencyKey: body.idempotency_key,
          body: { text: body.body.text, replyRequired: false, inReplyToEventId: "event_00000000000000000000000000000002" },
        },
      };
    },
  });
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );
  const [message] = await client.listUnread();
  let generateCalls = 0;
  const generate = () => {
    generateCalls += 1;
    return { status: "completed", text: "retry append" };
  };

  await assert.rejects(client.completeAndAcknowledge(message, generate), /append failed/);
  assert.equal(generateCalls, 1);
  assert.equal(state.appendCount, 1);
  assert.equal(state.acknowledgeCount, 0);

  const result = await client.completeAndAcknowledge(message, generate);
  assert.equal(generateCalls, 2);
  assert.deepEqual(result, { reconciled: false, acknowledged: true });
  assert.equal(state.acknowledgeCount, 1);
});

for (const acknowledged of [2, 1.5, -1]) {
  test(`completeAndAcknowledge rejects ack value ${acknowledged}`, async () => {
    const roomHistory = new Map([
      [
        "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        [
          canonicalEvent({
            id: "event_00000000000000000000000000000002",
            roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            sequence: 1,
            senderAgentId: "agent_22222222222222222222222222222222",
            type: "message.created",
            text: "please reply",
          }),
        ],
      ],
    ]);
    const { fetchImpl, state } = createMailboxFetch({
      mailboxResponse: {
        items: [
          {
            deliveryId: 24,
            roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            eventId: "event_00000000000000000000000000000002",
            roomSequence: 1,
            state: "pending",
            createdAt: "2026-08-07T00:00:00Z",
          },
        ],
      },
      roomHistoryByRoom: roomHistory,
      acknowledge: () => ({ acknowledged }),
    });
    const client = createMailboxClient(
      {
        meshUrl: "https://mesh.example",
        ...TEST_WORKLOAD,
        recipientId: "agent_11111111111111111111111111111111",
        pageLimit: 1,
      },
      { workloadTokens: testTokens("mesh-secret"), fetchImpl },
    );
    const [message] = await client.listUnread();
    await assert.rejects(
      client.completeAndAcknowledge(message, () => ({
        status: "completed",
        text: "invalid ack",
      })),
      /Mailbox did not confirm acknowledgement/,
    );
    assert.equal(state.acknowledgeCount, 1);
    assert.equal(state.appendCount, 1);
  });
}

test("findExistingReply can reconcile beyond first 100 history events", async () => {
  const message = {
    messageId: "event_00000000000000000000000000000002",
    taskId: "event_00000000000000000000000000000002",
    contextId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    senderId: "agent_22222222222222222222222222222222",
    recipientId: "agent_11111111111111111111111111111111",
    text: "ping",
  };
  const expectedReplyId = replyIdFromMessage(message);
  const events = [
    canonicalEvent({
      id: "event_00000000000000000000000000000002",
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      type: "message.created",
      text: "ping",
    }),
  ];
  for (let i = 2; i <= 100; i += 1) {
    events.push(
      canonicalEvent({
        id: `event_${String(i).padStart(32, "0")}`,
        roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sequence: i,
        senderAgentId: "agent_22222222222222222222222222222222",
        type: "message.created",
        text: `noise-${i}`,
      }),
    );
  }
  events.push({
    id: "event_00000000000000000000000000000010",
    roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sequence: 101,
    senderAgentId: "agent_11111111111111111111111111111111",
    type: "message.created",
    body: { text: "stale reply" },
    idempotencyKey: expectedReplyId,
  });
  const roomHistory = new Map([["room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", events]]);

  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 19,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000002",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: roomHistory,
  });
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );
  const [messageToAck] = await client.listUnread();
  let generateCalls = 0;

  const result = await client.completeAndAcknowledge(messageToAck, () => {
    generateCalls += 1;
    return { status: "completed", text: "new reply" };
  });

  assert.equal(generateCalls, 0);
  assert.deepEqual(result, { reconciled: true, acknowledged: true });
  assert.equal(state.appendCount, 0);
});

test("findExistingReply starts scan from source room sequence and reconciles immediately", async () => {
  const sourceSequence = 650;
  const message = {
    messageId: "event_00000000000000000000000000000002",
    taskId: "event_00000000000000000000000000000002",
    contextId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    senderId: "agent_22222222222222222222222222222222",
    recipientId: "agent_11111111111111111111111111111111",
    text: "ping",
  };
  const expectedReplyId = replyIdFromMessage(message);
  const roomHistoryByRoom = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        canonicalEvent({
          id: "event_00000000000000000000000000000007",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: sourceSequence - 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "prior noise",
        }),
        canonicalEvent({
          id: "event_00000000000000000000000000000002",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: sourceSequence,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "ping",
        }),
        {
          id: "event_00000000000000000000000000000010",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: sourceSequence + 1,
          senderAgentId: "agent_11111111111111111111111111111111",
          type: "message.created",
          body: { text: "replayed reply" },
          idempotencyKey: expectedReplyId,
        },
      ],
    ],
  ]);

  const reconciliationQueries = [];
  let appendCount = 0;
  let acknowledgeCount = 0;
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : undefined;
    if (url.pathname === "/api/v1/agents/me") {
      return json({ agent: { id: "agent_11111111111111111111111111111111" } });
    }
    if (url.pathname === "/api/v1/mailbox") {
      return json({
        items: [
          {
            deliveryId: 28,
            roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            eventId: "event_00000000000000000000000000000002",
            roomSequence: sourceSequence,
            state: "pending",
            createdAt: "2026-08-07T00:00:00Z",
          },
        ],
      });
    }
    if (url.pathname === "/api/v1/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/events") {
      if (request.method === "GET") {
        const after = Number(url.searchParams.get("after_sequence"));
        reconciliationQueries.push(after);
        const events = roomHistoryByRoom.get("room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") ?? [];
        const filtered = events.filter((event) => event.sequence > after);
        return json({ roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", items: filtered.slice(0, 100) });
      }
      appendCount += 1;
      if (body?.idempotency_key === undefined) {
        throw new Error("missing idempotency");
      }
      return json({
        event: {
          id: `event_${String(appendCount).padStart(32, "0")}`,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: sourceSequence + 1,
          senderAgentId: "agent_11111111111111111111111111111111",
          type: "message.created",
          idempotency_key: body.idempotency_key,
          body: { text: body.text, replyRequired: false, inReplyToEventId: "event_00000000000000000000000000000002" },
        },
      });
    }
    if (url.pathname === "/api/v1/mailbox/claim") {
      return json({ claimed: true, claimId: body.claim_id, claimedAt: "2026-08-07T00:00:00.000Z", idempotent: false });
    }
    if (url.pathname === "/api/v1/mailbox/ack") {
      acknowledgeCount += 1;
      return json({ acknowledged: 1 });
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`);
  };

  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );
  const [messageToAck] = await client.listUnread();
  let generateCalls = 0;
  const result = await client.completeAndAcknowledge(messageToAck, () => {
    generateCalls += 1;
    return { status: "completed", text: "new reply" };
  });

  assert.equal(generateCalls, 0);
  assert.deepEqual(result, { reconciled: true, acknowledged: true });
  assert.equal(acknowledgeCount, 1);
  assert.equal(appendCount, 0);
  assert.equal(reconciliationQueries[1], sourceSequence);
});

test("findExistingReply rejects non-progressing room history pages", async () => {
  const roomHistory = Array.from({ length: 100 }, (_, index) => ({
    id: `event_${String(index + 1).padStart(32, "0")}`,
    roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sequence: 1,
    senderAgentId: "agent_22222222222222222222222222222222",
    type: "message.created",
    body: { text: `duplicate-${index}` },
  }));
  const calls = [];
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const body =
      request.method === "POST" ? await request.json() : undefined;
    calls.push({ request: { url, method: request.method, body } });
    if (url.pathname === "/api/v1/agents/me") {
      return json({ agent: { id: "agent_11111111111111111111111111111111" } });
    }
    if (url.pathname === "/api/v1/mailbox") {
      return json({
        items: [
          {
            deliveryId: 26,
            roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000001",
            roomSequence: 1,
            state: "pending",
            createdAt: "2026-08-07T00:00:00Z",
          },
        ],
      });
    }
    if (url.pathname === "/api/v1/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/events") {
      if (request.method === "GET") {
        return json({ roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", items: roomHistory.slice(0, 100) });
      }
      return json({
        event: {
          id: "event_00000000000000000000000000000014",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 2,
          senderAgentId: "agent_11111111111111111111111111111111",
          type: "message.created",
          idempotency_key: "event_00000000000000000000000000000016",
          body: { text: "x", replyRequired: false, inReplyToEventId: "event_00000000000000000000000000000011" },
        },
      });
    }
    if (url.pathname === "/api/v1/mailbox/claim") {
      return json({ claimed: true, claimId: body.claim_id, claimedAt: "2026-08-07T00:00:00.000Z", idempotent: false });
    }
    if (url.pathname === "/api/v1/mailbox/ack") {
      return json({ acknowledged: 1 });
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`);
  };
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );
  const [message] = await client.listUnread();
  await assert.rejects(client.completeAndAcknowledge(message, () => ({ status: "completed", text: "x" })), /did not progress/);
  assert.equal(calls.filter((call) => call.request.url.pathname === "/api/v1/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/events").length > 0, true);
});

test("findExistingReply enforces reconciliation scan bounds", async () => {
  let page = 0;
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : undefined;
    if (url.pathname === "/api/v1/agents/me") {
      return json({ agent: { id: "agent_11111111111111111111111111111111" } });
    }
    if (url.pathname === "/api/v1/mailbox") {
      return json({
        items: [
        {
          deliveryId: 27,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000001",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
        ],
      });
    }
    if (url.pathname === "/api/v1/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/events") {
      const base = page * 100;
      page += 1;
      if (request.method === "GET") {
        const items = Array.from({ length: 100 }, (_, index) => ({
          id: `event_${String(base + index + 1).padStart(32, "0")}`,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: base + index + 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          body: { text: `noise-${base + index + 1}` },
        }));
        return json({ roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", items });
      }
      if (body?.idempotency_key === undefined) {
        throw new Error("missing idempotency");
      }
      return json({
        event: {
          id: "event_00000000000000000000000000000014",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 2000,
          senderAgentId: "agent_11111111111111111111111111111111",
          type: "message.created",
          idempotency_key: body.idempotency_key,
          body: { text: "new", replyRequired: false, inReplyToEventId: "event_00000000000000000000000000000002" },
        },
      });
    }
    if (url.pathname === "/api/v1/mailbox/claim") {
      return json({ claimed: true, claimId: body.claim_id, claimedAt: "2026-08-07T00:00:00.000Z", idempotent: false });
    }
    if (url.pathname === "/api/v1/mailbox/ack") {
      return json({ acknowledged: 1 });
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`);
  };

  const roomHistory = new Map([
    [
      "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      [
        canonicalEvent({
          id: "event_00000000000000000000000000000002",
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sequence: 1,
          senderAgentId: "agent_22222222222222222222222222222222",
          type: "message.created",
          text: "ping",
        }),
      ],
    ],
  ]);
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );

  const [message] = await client.listUnread();
  await assert.rejects(
    client.completeAndAcknowledge(message, () => ({ status: "completed", text: "x".repeat(4) })),
    /reconciliation scan exceeded safe bounds/,
  );
});

test("listUnread rejects invalid delivery state and event identity", async () => {
  const { fetchImpl } = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 20,
          roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          eventId: "event_00000000000000000000000000000002",
          roomSequence: 1,
          state: "processed",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: new Map(),
  });
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl },
  );
  await assert.rejects(client.listUnread(), /pending/);
  const badCursor = createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 21,
          roomId: "room_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          eventId: "event_00000000000000000000000000000004",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: new Map([
      [
        "room_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        [
          canonicalEvent({
            id: "event_00000000000000000000000000000003",
            roomId: "room_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            sequence: 1,
            senderAgentId: "agent_22222222222222222222222222222222",
            type: "message.created",
            text: "cursor mismatch",
          }),
        ],
      ],
    ]),
  });
  const badCursorClient = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl: badCursor.fetchImpl },
  );
  await assert.rejects(
    badCursorClient.listUnread(),
    /Mailbox event cursor mismatch/,
  );

  const badSender = await createMailboxFetch({
    mailboxResponse: {
      items: [
        {
          deliveryId: 22,
          roomId: "room_cccccccccccccccccccccccccccccccc",
          eventId: "event_00000000000000000000000000000005",
          roomSequence: 1,
          state: "pending",
          createdAt: "2026-08-07T00:00:00Z",
        },
      ],
    },
    roomHistoryByRoom: new Map([
      [
        "room_cccccccccccccccccccccccccccccccc",
        [
          canonicalEvent({
            id: "event_00000000000000000000000000000005",
            roomId: "room_cccccccccccccccccccccccccccccccc",
            sequence: 1,
            senderAgentId: "agent_11111111111111111111111111111111",
            type: "message.created",
            text: "self message",
          }),
        ],
      ],
    ]),
  });
  const badSenderClient = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl: badSender.fetchImpl },
  );
  await assert.rejects(badSenderClient.listUnread(), /must not be this worker/);
});

test("listUnread rejects malformed payloads, and oversized responses", async () => {
  const nonCanonical = createMailboxFetch({
    mailboxResponse: {
      deliveries: [{ delivery_id: 1 }],
    },
  });
  const nonCanonicalClient = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl: nonCanonical.fetchImpl },
  );
  await assert.rejects(nonCanonicalClient.listUnread(), /invalid/);

  const oversized = createMailboxFetch();
  oversized.fetchImpl = async () =>
    new Response("a".repeat(MAX_RESPONSE_BYTES + 1), {
      status: 200,
      headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
    });
  const clientOversize = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl: oversized.fetchImpl },
  );
  await assert.rejects(clientOversize.listUnread(), /too large/);

  const oversizedChunkedFetch = createMailboxFetch({
    mailboxResponse: { items: [] },
  });
  oversizedChunkedFetch.fetchImpl = async () =>
    new Response("a".repeat(MAX_RESPONSE_BYTES + 1), { status: 200 });
  const clientChunked = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl: oversizedChunkedFetch.fetchImpl },
  );
  await assert.rejects(clientChunked.listUnread(), /too large/);
});

test("mailbox errors do not leak mesh token", async () => {
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
      pageLimit: 1,
    },
    { workloadTokens: testTokens("very-secret-token"),
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    },
  );
  await assert.rejects(
    client.listUnread(),
    (error) => !/very-secret-token/.test(String(error.message)),
  );
});

test("one request deadline bounds a fetch that ignores abort", async () => {
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
    },
    { workloadTokens: testTokens("secret"), fetchImpl: async () => new Promise(() => {}), requestTimeoutMs: 10 },
  );

  await assert.rejects(client.listUnread(), /timed out/);
});

test("one request deadline bounds a reader and cancel that never settle", async () => {
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
    },
    { workloadTokens: testTokens("secret"),
      requestTimeoutMs: 10,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            return {
              read: async () => new Promise(() => {}),
              cancel: async () => new Promise(() => {}),
            };
          },
        },
      }),
    },
  );

  await assert.rejects(client.listUnread(), /timed out/);
});

test("caller abort stops a request whose transport ignores abort", async () => {
  const controller = new AbortController();
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
    },
    { workloadTokens: testTokens("secret"), fetchImpl: async () => new Promise(() => {}), requestTimeoutMs: 60_000 },
  );
  const pending = client.listUnread({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test("canonical construction rejects malformed actor IDs before effects", () => {
  let calls = 0;
  for (const recipientId of [
    "agent_bad",
    "agent_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "agent_../../../../../../etc/passwd",
  ]) {
    assert.throws(
      () => createMailboxClient(
        { meshUrl: "https://mesh.example", ...TEST_WORKLOAD, recipientId },
        { workloadTokens: testTokens("secret"), fetchImpl: async () => { calls += 1; } },
      ),
      /recipientId is invalid/,
    );
  }
  assert.equal(calls, 0);
});

test("malformed room, event, and sender IDs are rejected before claim or ack effects", async () => {
  const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const eventId = "event_00000000000000000000000000000002";
  const cases = [
    {
      delivery: { roomId: "room_../../etc/passwd", eventId },
      history: new Map(),
    },
    {
      delivery: { roomId, eventId: "event_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      history: new Map(),
    },
    {
      delivery: { roomId, eventId },
      history: new Map([[roomId, [canonicalEvent({
        id: eventId,
        roomId,
        sequence: 1,
        senderAgentId: "agent_short",
        type: "message.created",
        text: "bad sender",
      })]]]),
    },
  ];
  for (const current of cases) {
    const { fetchImpl, state } = createMailboxFetch({
      mailboxResponse: { items: [{
        deliveryId: 88,
        roomId: current.delivery.roomId,
        eventId: current.delivery.eventId,
        roomSequence: 1,
        state: "pending",
        createdAt: "2026-08-07T00:00:00Z",
      }] },
      roomHistoryByRoom: current.history,
    });
    const client = createMailboxClient({
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
    }, { workloadTokens: testTokens("mesh-secret"), fetchImpl });
    await assert.rejects(client.listUnread(), /invalid/);
    assert.equal(state.claims.size, 0);
    assert.equal(state.acknowledgeCount, 0);
    assert.equal(state.appendCount, 0);
  }
});

test("hostile server errors expose only generic allowlisted metadata", async () => {
  const hostile = "mesh-secret hostile-body";
  const client = createMailboxClient(
    {
      meshUrl: "https://mesh.example",
      ...TEST_WORKLOAD,
      recipientId: "agent_11111111111111111111111111111111",
    },
    { workloadTokens: testTokens("mesh-secret"), fetchImpl: async () => json({ error: hostile, token: hostile }, 500) },
  );
  await assert.rejects(client.listUnread(), (error) => {
    const serialized = JSON.stringify(error);
    return !String(error.message).includes(hostile)
      && !serialized.includes(hostile)
      && error.mailboxError === undefined;
  });
});

test("durable claim elects one worker before generation and acknowledgement", async () => {
  const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const eventId = "event_00000000000000000000000000000002";
  const roomHistoryByRoom = new Map([[roomId, [canonicalEvent({
    id: eventId,
    roomId,
    sequence: 1,
    senderAgentId: "agent_22222222222222222222222222222222",
    type: "message.created",
    text: "reply once",
  })]]]);
  const mailboxResponse = { items: [{
    deliveryId: 99,
    roomId,
    eventId,
    roomSequence: 1,
    state: "pending",
    createdAt: "2026-08-07T00:00:00Z",
  }] };
  const { fetchImpl, state } = createMailboxFetch({ mailboxResponse, roomHistoryByRoom });
  const config = {
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
  };
  const first = createMailboxClient(config, { workloadTokens: testTokens(), fetchImpl });
  const second = createMailboxClient(config, { workloadTokens: testTokens(), fetchImpl });
  const [[firstMessage], [secondMessage]] = await Promise.all([
    first.listUnread(),
    second.listUnread(),
  ]);
  let generations = 0;
  const generate = async () => {
    generations += 1;
    return { status: "completed", text: "only reply" };
  };
  const results = await Promise.all([
    first.completeAndAcknowledge(firstMessage, generate),
    second.completeAndAcknowledge(secondMessage, generate),
  ]);

  assert.equal(generations, 1);
  assert.equal(state.appendCount, 1);
  assert.equal(state.acknowledgeCount, 1);
  assert.equal(results.filter((result) => result.claimed === false).length, 1);
});

test("malformed claim responses are rejected before generation or acknowledgement", async () => {
  const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const eventId = "event_00000000000000000000000000000002";
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: { items: [{
      deliveryId: 100,
      roomId,
      eventId,
      roomSequence: 1,
      state: "pending",
      createdAt: "2026-08-07T00:00:00Z",
    }] },
    roomHistoryByRoom: new Map([[roomId, [canonicalEvent({
      id: eventId,
      roomId,
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      type: "message.created",
      text: "do not run",
    })]]]),
    claim: (_body) => ({
      claimed: true,
      claimId: "claim_BAD",
      claimedAt: "not-a-time",
      idempotent: false,
    }),
  });
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
  }, { workloadTokens: testTokens("mesh-secret"), fetchImpl });
  const [message] = await client.listUnread();
  let generations = 0;
  await assert.rejects(client.completeAndAcknowledge(message, async () => {
    generations += 1;
    return { status: "completed", text: "bad" };
  }), /claim response is invalid/);
  assert.equal(generations, 0);
  assert.equal(state.acknowledgeCount, 0);
});

test("a lost successful claim response retries the exact tentative ownership", async () => {
  let claimAttempts = 0;
  const scenario = createRetryScenario({
    claim(body, state) {
      claimAttempts += 1;
      const existing = state.claims.get(body.delivery_id);
      if (existing && existing !== body.claim_id) {
        return json({ error: "delivery_claim_conflict" }, 409);
      }
      state.claims.set(body.delivery_id, body.claim_id);
      if (claimAttempts === 1) throw new Error("claim response lost after insert");
      return {
        claimed: true,
        claimId: body.claim_id,
        claimedAt: "2026-08-07T00:00:00.000Z",
        idempotent: true,
      };
    },
  });
  const [message] = await scenario.client.listUnread();
  await assert.rejects(
    scenario.client.completeAndAcknowledge(message, async () => {
      throw new Error("runner must not execute before claim confirmation");
    }),
    /claim response lost after insert/,
  );
  const durableClaimId = scenario.state.claims.get(101);

  scenario.mailboxResponse.items.length = 0;
  const [retry] = await scenario.client.listUnread();
  assert.equal(retry, message);
  let generations = 0;
  await scenario.client.completeAndAcknowledge(retry, async () => {
    generations += 1;
    return { status: "completed", text: "one recovered reply" };
  });

  const claimIds = scenario.state.calls
    .filter((call) => call.url.pathname === "/api/v1/mailbox/claim")
    .map((call) => call.body.claim_id);
  assert.deepEqual(claimIds, [durableClaimId, durableClaimId]);
  assert.equal(generations, 1);
  assert.equal(scenario.state.appendCount, 1);
  assert.equal(scenario.state.acknowledgeCount, 1);
  assert.deepEqual(await scenario.client.listUnread(), []);
});

test("a definitive invalid claim denial removes tentative retry ownership", async () => {
  const scenario = createRetryScenario({
    claim: () => json({ error: "invalid_request" }, 400),
  });
  const [message] = await scenario.client.listUnread();
  await assert.rejects(
    scenario.client.completeAndAcknowledge(message, async () => {
      throw new Error("runner must not execute");
    }),
    (error) => error?.status === 400 && error?.mailboxError === "invalid_request",
  );
  scenario.mailboxResponse.items.length = 0;
  assert.deepEqual(await scenario.client.listUnread(), []);
});

for (const label of ["runner failure", "effect then throw"]) {
  test(`claimed work keeps the exact claim across a fresh poll after ${label}`, async () => {
    const scenario = createRetryScenario();
    const [message] = await scenario.client.listUnread();
    let effects = 0;
    await assert.rejects(scenario.client.completeAndAcknowledge(message, async () => {
      effects += 1;
      throw new Error(label);
    }), new RegExp(label));
    const firstClaim = scenario.state.calls.find(
      (call) => call.url.pathname === "/api/v1/mailbox/claim",
    ).body.claim_id;

    scenario.mailboxResponse.items.length = 0;
    assert.deepEqual(await scenario.createSecondClient().listUnread(), []);
    const [retry] = await scenario.client.listUnread();
    assert.equal(retry, message);
    await scenario.client.completeAndAcknowledge(retry, async () => {
      effects += 1;
      return { status: "completed", text: "recovered" };
    });
    const claimIds = scenario.state.calls
      .filter((call) => call.url.pathname === "/api/v1/mailbox/claim")
      .map((call) => call.body.claim_id);
    assert.deepEqual(claimIds, [firstClaim, firstClaim]);
    assert.equal(effects, 2);
    assert.equal(scenario.state.appendCount, 1);
    assert.equal(scenario.state.acknowledgeCount, 1);
    assert.deepEqual(await scenario.client.listUnread(), []);
  });
}

test("append failure stays retryable with the same durable claim", async () => {
  let appendAttempts = 0;
  const scenario = createRetryScenario({
    appendEvent(roomId, body, state) {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error("append failed after claim");
      state.appendCount += 1;
      const existing = state.roomHistoryByRoom.get(roomId) ?? [];
      const event = {
        id: "event_99999999999999999999999999999999",
        roomId,
        sequence: 2,
        senderAgentId: "agent_11111111111111111111111111111111",
        type: "message.created",
        idempotencyKey: body.idempotency_key,
        idempotency_key: body.idempotency_key,
        body: body.body,
      };
      existing.push(event);
      state.roomHistoryByRoom.set(roomId, existing);
      return { event };
    },
  });
  const [message] = await scenario.client.listUnread();
  let generations = 0;
  const generate = async () => {
    generations += 1;
    return { status: "completed", text: "append retry" };
  };
  await assert.rejects(
    scenario.client.completeAndAcknowledge(message, generate),
    /append failed after claim/,
  );
  scenario.mailboxResponse.items.length = 0;
  const [retry] = await scenario.client.listUnread();
  await scenario.client.completeAndAcknowledge(retry, generate);
  const claimIds = scenario.state.calls
    .filter((call) => call.url.pathname === "/api/v1/mailbox/claim")
    .map((call) => call.body.claim_id);
  assert.equal(new Set(claimIds).size, 1);
  assert.equal(generations, 2);
  assert.equal(appendAttempts, 2);
  assert.equal(scenario.state.acknowledgeCount, 1);
});

test("ack failure retries the same claim and reconciles without regenerating", async () => {
  let ackAttempts = 0;
  const scenario = createRetryScenario({
    acknowledge() {
      ackAttempts += 1;
      if (ackAttempts === 1) throw new Error("ack failed after append");
      return { acknowledged: 1 };
    },
  });
  const [message] = await scenario.client.listUnread();
  let generations = 0;
  const generate = async () => {
    generations += 1;
    return { status: "completed", text: "persisted once" };
  };
  await assert.rejects(
    scenario.client.completeAndAcknowledge(message, generate),
    /ack failed after append/,
  );
  scenario.mailboxResponse.items.length = 0;
  const [retry] = await scenario.client.listUnread();
  await scenario.client.completeAndAcknowledge(retry, generate);
  const claimIds = scenario.state.calls
    .filter((call) => call.url.pathname === "/api/v1/mailbox/claim")
    .map((call) => call.body.claim_id);
  assert.equal(new Set(claimIds).size, 1);
  assert.equal(generations, 1);
  assert.equal(scenario.state.appendCount, 1);
  assert.equal(ackAttempts, 2);
  assert.deepEqual(await scenario.client.listUnread(), []);
});

test("ack payloads include matching claims for owned deliveries (C1)", async () => {
  const scenario = createRetryScenario();
  const [message] = await scenario.client.listUnread();
  await scenario.client.completeAndAcknowledge(message, async () => ({
    status: "completed",
    text: "claimed ack",
  }));

  const claimId = scenario.state.calls.find(
    (call) => call.url.pathname === "/api/v1/mailbox/claim",
  ).body.claim_id;
  const ackBodies = scenario.state.calls
    .filter((call) => call.url.pathname === "/api/v1/mailbox/ack")
    .map((call) => call.body);
  assert.equal(ackBodies.length, 1);
  assert.deepEqual(ackBodies[0], {
    delivery_ids: [101],
    status: "processed",
    claims: [{ delivery_id: 101, claim_id: claimId }],
  });
});

test("unsupported deliveries still ack without claims", async () => {
  const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [{
        deliveryId: 7,
        roomId,
        eventId: "event_00000000000000000000000000000002",
        roomSequence: 1,
        state: "pending",
        createdAt: "2026-08-07T00:00:00Z",
      }],
    },
    roomHistoryByRoom: new Map([[roomId, [{
      id: "event_00000000000000000000000000000002",
      roomId,
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      type: "room.member_added",
      body: {},
    }]]]),
  });
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
    pageLimit: 1,
  }, { workloadTokens: testTokens("mesh-secret"), fetchImpl });

  assert.deepEqual(await client.listUnread(), []);
  const ackBody = state.calls.find((call) => call.url.pathname === "/api/v1/mailbox/ack").body;
  assert.deepEqual(ackBody, {
    delivery_ids: [7],
    status: "processed",
  });
  assert.equal(ackBody.claims, undefined);
});

test("poison delivery retries are capped and quarantined without blocking later work (C2)", async () => {
  const roomA = "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const roomB = "room_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const eventA = "event_00000000000000000000000000000002";
  const eventB = "event_00000000000000000000000000000003";
  const mailboxResponse = {
    items: [{
      deliveryId: 201,
      roomId: roomA,
      eventId: eventA,
      roomSequence: 1,
      state: "pending",
      createdAt: "2026-08-07T00:00:00Z",
    }],
  };
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse,
    roomHistoryByRoom: new Map([
      [roomA, [canonicalEvent({
        id: eventA,
        roomId: roomA,
        sequence: 1,
        senderAgentId: "agent_22222222222222222222222222222222",
        type: "message.created",
        text: "poison",
      })]],
      [roomB, [canonicalEvent({
        id: eventB,
        roomId: roomB,
        sequence: 1,
        senderAgentId: "agent_22222222222222222222222222222222",
        type: "message.created",
        text: "healthy",
      })]],
    ]),
  });
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
    pageLimit: 1,
  }, { workloadTokens: testTokens("mesh-secret"), fetchImpl, maxDeliveryAttempts: 2 });

  const [poison] = await client.listUnread();
  await assert.rejects(
    client.completeAndAcknowledge(poison, async () => {
      throw new Error("runner always fails");
    }),
    /runner always fails/,
  );
  const quarantined = await client.completeAndAcknowledge(poison, async () => {
    throw new Error("runner always fails");
  });
  assert.deepEqual(quarantined, {
    claimed: false,
    reconciled: false,
    acknowledged: false,
    quarantined: true,
  });
  const listedQuarantine = client.listQuarantined();
  assert.equal(listedQuarantine.length, 1);
  assert.equal(listedQuarantine[0].deliveryId, 201);
  assert.equal(listedQuarantine[0].reason, "runner always fails");
  assert.equal(state.acknowledgeCount, 0);

  mailboxResponse.items = [{
    deliveryId: 202,
    roomId: roomB,
    eventId: eventB,
    roomSequence: 1,
    state: "pending",
    createdAt: "2026-08-07T00:00:01Z",
  }];
  const [healthy] = await client.listUnread();
  assert.equal(healthy.text, "healthy");
  const healthyResult = await client.completeAndAcknowledge(healthy, async () => ({
    status: "completed",
    text: "ok",
  }));
  assert.equal(healthyResult.acknowledged, true);
  assert.equal(state.acknowledgeCount, 1);
  const healthyAck = state.calls.find((call) => (
    call.url.pathname === "/api/v1/mailbox/ack" && call.body.delivery_ids[0] === 202
  ));
  assert.ok(healthyAck.body.claims);
});

test("claim lease renews during long processing and stops side effects after ownership loss", async () => {
  const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const eventId = "event_00000000000000000000000000000002";
  let claimCount = 0;
  let nowMs = Date.parse("2026-08-07T00:00:00.000Z");
  const timers = [];
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: {
      items: [{
        deliveryId: 301,
        roomId,
        eventId,
        roomSequence: 1,
        state: "pending",
        createdAt: "2026-08-07T00:00:00Z",
      }],
    },
    roomHistoryByRoom: new Map([[roomId, [canonicalEvent({
      id: eventId,
      roomId,
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      type: "message.created",
      text: "long running",
    })]]]),
    claim(body, claimState) {
      claimCount += 1;
      const existing = claimState.claims.get(body.delivery_id);
      if (existing && existing !== body.claim_id) {
        return json({ error: "delivery_claim_conflict" }, 409);
      }
      if (claimCount >= 3) {
        return json({ error: "delivery_claim_conflict" }, 409);
      }
      claimState.claims.set(body.delivery_id, body.claim_id);
      return {
        claimed: true,
        claimId: body.claim_id,
        claimedAt: "2026-08-07T00:00:00.000Z",
        idempotent: Boolean(existing),
        renewed: claimCount > 1,
        leaseExpiresAt: new Date(nowMs + 60_000).toISOString(),
      };
    },
  });

  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
  }, { workloadTokens: testTokens("mesh-secret"),
    fetchImpl,
    now: () => nowMs,
    setTimeoutFn: (fn, delay) => {
      const handle = { fn, delay, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      if (handle) handle.cleared = true;
    },
  });

  const [message] = await client.listUnread();
  let generateStarted;
  const generateGate = new Promise((resolve) => {
    generateStarted = resolve;
  });
  let releaseGenerate;
  const generateHold = new Promise((resolve) => {
    releaseGenerate = resolve;
  });

  const completionPromise = client.completeAndAcknowledge(message, async () => {
    generateStarted();
    await generateHold;
    return { status: "completed", text: "should not persist after loss" };
  });

  await generateGate;
  assert.equal(claimCount, 1);
  assert.equal(timers.length, 1);

  nowMs += timers[0].delay;
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claimCount, 2);

  const secondTimer = timers.find((timer) => !timer.cleared && timer !== timers[0]);
  assert.ok(secondTimer);
  nowMs += secondTimer.delay;
  secondTimer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claimCount, 3);

  releaseGenerate();
  const result = await completionPromise;
  assert.equal(result.ownershipLost, true);
  assert.equal(result.acknowledged, false);
  assert.equal(state.appendCount, 0);
  assert.equal(state.acknowledgeCount, 0);
});

test("permissions v1: the workload key exchanges a canonical token proof (agent scopes), verifies agents/me, and DPoP-binds every call to its full URL", async () => {
  const { generateEd25519 } = await import("../../triangle-cli/src/keys.mjs");
  const { canonicalJson } = await import("../../triangle-cli/src/canonical.mjs");
  const key = generateEd25519();
  const workloadId = "workload_11111111111111111111111111111111";
  const agentId = "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const calls = [];
  const tokens = ["wl_token_1", "wl_token_2"];
  let issued = 0;
  let rejectNextMailbox = false;
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const body = request.method === "GET" ? null : await request.json();
    calls.push({ url, method: request.method, headers: Object.fromEntries(request.headers.entries()), body, redirect: request.redirect });
    if (url.pathname === "/api/v1/identity/token-challenges") {
      return json({ challenge: { challenge_id: `challenge_${issued}`, workload_id: workloadId, principal_id: agentId, audience: "https://mesh.test", nonce: `nonce_${issued}` } }, 201);
    }
    if (url.pathname === "/api/v1/identity/tokens") {
      return json({ access_token: tokens[issued++], token_type: "DPoP", expires_in: 300 });
    }
    if (url.pathname === "/api/v1/agents/me") return json({ agent: { id: agentId, handle: "wl-agent" }, state: "active" });
    if (url.pathname === "/api/v1/mailbox") {
      if (rejectNextMailbox) { rejectNextMailbox = false; return json({ error: "agent_auth_required" }, 401); }
      return json({ items: [] });
    }
    return json({ error: "not_found" }, 404);
  };
  const client = createMailboxClient(
    { meshUrl: "https://mesh.test", recipientId: agentId, workloadId, workloadPrivateKey: JSON.stringify(key) },
    { fetchImpl },
  );

  assert.deepEqual(await client.listUnread(), []);
  assert.deepEqual(calls.map((c) => c.url.pathname), [
    "/api/v1/identity/token-challenges",
    "/api/v1/identity/tokens",
    "/api/v1/agents/me",
    "/api/v1/mailbox",
  ]);
  // Redirects are never followed: proof bodies and DPoP headers stay on the origin (round 4 P2).
  assert.ok(calls.every((c) => c.redirect === "manual"), "every token exchange and agent call refuses redirects");
  assert.equal(calls[0].body.workload_id, workloadId);
  assert.deepEqual(calls[1].body.requested_scopes, ["agent.read", "agent.write"]);
  const [h, p, sig] = calls[1].body.proof.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const payload = JSON.parse(Buffer.from(p, "base64url"));
  assert.deepEqual(header, { alg: "EdDSA", kid: workloadId, typ: "mesh-workload-proof+jwt" });
  assert.equal(Buffer.from(p, "base64url").toString(), canonicalJson(payload), "proof payload is RFC 8785 canonical");
  assert.equal(payload.profile, "mesh.workload-token-proof/1");
  assert.ok(crypto.verify(null, Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), Buffer.from(sig, "base64url")));

  const mailbox = calls[3];
  assert.equal(mailbox.headers.authorization, "Bearer wl_token_1");
  const [dh, dp] = mailbox.headers.dpop.split(".");
  const dpopHeader = JSON.parse(Buffer.from(dh, "base64url"));
  const dpop = JSON.parse(Buffer.from(dp, "base64url"));
  assert.equal(dpopHeader.typ, "dpop+jwt");
  assert.equal(dpopHeader.jwk.x, key.x);
  assert.equal(dpopHeader.jwk.d, undefined, "never the private part");
  assert.equal(dpop.htu, "https://mesh.test/api/v1/mailbox?after=0&limit=1", "htu includes the query");
  assert.equal(dpop.ath, crypto.createHash("sha256").update("wl_token_1", "ascii").digest("base64url"));

  // An expired/revoked access token: one fresh exchange, then the call succeeds.
  rejectNextMailbox = true;
  assert.deepEqual(await client.listUnread(), []);
  assert.equal(calls.filter((c) => c.url.pathname === "/api/v1/identity/tokens").length, 2);
  assert.equal(calls.at(-1).headers.authorization, "Bearer wl_token_2");
});

test("permissions v1: agents/me must name the configured agent", async () => {
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/agents/me") return json({ agent: { id: "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } });
    return json({ items: [] });
  };
  const client = createMailboxClient(
    { meshUrl: "https://mesh.test", recipientId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ...TEST_WORKLOAD },
    { workloadTokens: testTokens(), fetchImpl },
  );
  await assert.rejects(client.listUnread(), /does not match authenticated actor/);
});

test("permissions v1: permission_denied and agent_paused surface their code and the permission key", async () => {
  for (const [status, payload, pattern] of [
    [403, { error: "permission_denied", permission: "dm.receive" }, /dm\.receive is off/],
    [403, { error: "agent_paused" }, /paused by its owner/],
  ]) {
    const fetchImpl = async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/agents/me") return json({ agent: { id: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
      return json(payload, status);
    };
    const client = createMailboxClient(
      { meshUrl: "https://mesh.test", recipientId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ...TEST_WORKLOAD },
      { workloadTokens: testTokens(), fetchImpl },
    );
    const error = await client.listUnread().catch((e) => e);
    assert.ok(error instanceof MailboxRequestError);
    assert.match(error.message, pattern);
    assert.equal(error.meshError, payload.error);
    assert.equal(error.permission, payload.permission);
  }
});

test("permissions v1: options refuse a mesh_ bearer and require a valid workload key", () => {
  const base = { meshUrl: "https://mesh.test", recipientId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  assert.throws(() => validateMailboxClientOptions({ ...base, ...TEST_WORKLOAD, meshToken: "mesh_x" }), /meshToken is no longer supported/);
  assert.throws(() => validateMailboxClientOptions(base), /workloadId is required/);
  assert.throws(() => validateMailboxClientOptions({ ...base, workloadId: "workload_x", workloadPrivateKey: TEST_WORKLOAD.workloadPrivateKey }), /workloadId is invalid/);
  assert.throws(() => validateMailboxClientOptions({ ...base, workloadId: TEST_WORKLOAD.workloadId, workloadPrivateKey: "not-a-key" }), /workloadPrivateKey/);
  assert.throws(() => validateMailboxClientOptions({ ...base, workloadId: TEST_WORKLOAD.workloadId, workloadPrivateKey: Buffer.alloc(32).toString("hex") }), /workloadPrivateKey/);
  const ok = validateMailboxClientOptions({ ...base, ...TEST_WORKLOAD });
  assert.equal(ok.workloadId, TEST_WORKLOAD.workloadId);
  assert.equal(Object.hasOwn(ok, "meshToken"), false);
});

test("onProgress reports claim, reply, then ack for an owned delivery (no ids or bodies)", async () => {
  const phases = [];
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: { items: [{
      deliveryId: 41,
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      eventId: "event_00000000000000000000000000000002",
      roomSequence: 1,
      state: "pending",
      createdAt: "2026-08-07T00:00:00Z",
    }] },
    roomHistoryByRoom: new Map([["room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [canonicalEvent({
      id: "event_00000000000000000000000000000002",
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      type: "message.created",
      text: "please reply",
    })]]]),
  });
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
    pageLimit: 1,
  }, { workloadTokens: testTokens("mesh-secret"),
    fetchImpl,
    onProgress(event) {
      assert.deepEqual(Object.keys(event), ["phase"]);
      phases.push(event.phase);
    },
  });
  const [message] = await client.listUnread();
  const result = await client.completeAndAcknowledge(message, () => ({ status: "completed", text: "reply text" }));
  assert.deepEqual(result, { reconciled: false, acknowledged: true });
  assert.deepEqual(phases, ["claim", "reply", "ack"]);
  assert.equal(state.appendCount, 1);
  assert.equal(state.acknowledgeCount, 1);
});

test("onProgress reports claim+ack for replyRequired=false and never throws into delivery", async () => {
  const phases = [];
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: { items: [{
      deliveryId: 42,
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      eventId: "event_00000000000000000000000000000002",
      roomSequence: 1,
      state: "pending",
      createdAt: "2026-08-07T00:00:00Z",
    }] },
    roomHistoryByRoom: new Map([["room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [{
      id: "event_00000000000000000000000000000002",
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      type: "message.created",
      body: { text: "fyi", replyRequired: false },
    }]]]),
  });
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
    pageLimit: 1,
  }, { workloadTokens: testTokens("mesh-secret"),
    fetchImpl,
    onProgress(event) {
      phases.push(event.phase);
      throw new Error("journal unavailable");
    },
  });
  const [message] = await client.listUnread();
  const result = await client.completeAndAcknowledge(message, () => assert.fail("must not generate"));
  assert.deepEqual(result, { reconciled: false, acknowledged: true });
  assert.deepEqual(phases, ["claim", "ack"]);
  assert.equal(state.acknowledgeCount, 1);
});

test("onProgress records no reply/ack when the reply append fails", async () => {
  const phases = [];
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: { items: [{
      deliveryId: 43,
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      eventId: "event_00000000000000000000000000000002",
      roomSequence: 1,
      state: "pending",
      createdAt: "2026-08-07T00:00:00Z",
    }] },
    roomHistoryByRoom: new Map([["room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [canonicalEvent({
      id: "event_00000000000000000000000000000002",
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      type: "message.created",
      text: "please reply",
    })]]]),
    appendEvent: () => { throw new Error("append down"); },
  });
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
    pageLimit: 1,
  }, { workloadTokens: testTokens("mesh-secret"), fetchImpl, onProgress: (event) => phases.push(event.phase) });
  const [message] = await client.listUnread();
  await assert.rejects(client.completeAndAcknowledge(message, () => ({ status: "completed", text: "reply text" })));
  assert.deepEqual(phases, ["claim"]);
  assert.equal(state.acknowledgeCount, 0);
});

test("onProgress must be a function when provided", () => {
  assert.throws(() => createMailboxClient({
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
  }, { workloadTokens: testTokens("mesh-secret"), fetchImpl: async () => json({}), onProgress: "nope" }), /onProgress must be a function/);
});

test("onProgress records reply evidence when a retry verifies a reply whose append response was lost (Codex review r3)", async () => {
  const phases = [];
  let appendCall = 0;
  const { fetchImpl, state } = createMailboxFetch({
    mailboxResponse: { items: [{
      deliveryId: 44,
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      eventId: "event_00000000000000000000000000000002",
      roomSequence: 1,
      state: "pending",
      createdAt: "2026-08-07T00:00:00Z",
    }] },
    roomHistoryByRoom: new Map([["room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [canonicalEvent({
      id: "event_00000000000000000000000000000002",
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      type: "message.created",
      text: "please reply",
    })]]]),
    appendEvent: (roomId, body, stateObj) => {
      stateObj.appendCount += 1;
      const existing = stateObj.roomHistoryByRoom.get(roomId) ?? [];
      const event = {
        id: "event_00000000000000000000000000000016",
        roomId,
        sequence: existing.reduce((value, row) => Math.max(value, row.sequence), 0) + 1,
        senderAgentId: "agent_11111111111111111111111111111111",
        type: "message.created",
        idempotencyKey: body.idempotency_key,
        body: body.body,
      };
      existing.push(event);
      stateObj.roomHistoryByRoom.set(roomId, existing);
      appendCall += 1;
      if (appendCall === 1) throw new Error("reply response dropped");
      return { event };
    },
  });
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    ...TEST_WORKLOAD,
    recipientId: "agent_11111111111111111111111111111111",
    pageLimit: 1,
  }, { workloadTokens: testTokens("mesh-secret"), fetchImpl, onProgress: (event) => phases.push(event.phase) });
  const [message] = await client.listUnread();
  const generate = () => ({ status: "completed", text: "reply text" });
  await assert.rejects(client.completeAndAcknowledge(message, generate), /response dropped/);
  assert.deepEqual(phases, ["claim"], "an unconfirmed append is not evidence");
  const result = await client.completeAndAcknowledge(message, generate);
  assert.deepEqual(result, { reconciled: true, acknowledged: true });
  assert.equal(state.appendCount, 1);
  assert.deepEqual(phases, ["claim", "claim", "reply", "ack"]);
});

test("permissions v1: a refused token refresh never echoes MESH free text or the previous access token", async () => {
  const { generateEd25519 } = await import("../../triangle-cli/src/keys.mjs");
  const key = generateEd25519();
  const workloadId = "workload_11111111111111111111111111111111";
  const agentId = "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let exchanges = 0;
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/identity/token-challenges") {
      exchanges += 1;
      if (exchanges > 1) return json({ error: "stale token wl_token_previous_secret", message: "wl_token_previous_secret" }, 401);
      return json({ challenge: { challenge_id: "challenge_1", workload_id: workloadId, principal_id: agentId, audience: "https://mesh.test", nonce: "nonce_1" } }, 201);
    }
    if (url.pathname === "/api/v1/identity/tokens") return json({ access_token: "wl_token_previous_secret", token_type: "DPoP", expires_in: 300 });
    if (url.pathname === "/api/v1/agents/me") return json({ agent: { id: agentId, handle: "wl-agent" }, state: "active" });
    if (url.pathname === "/api/v1/mailbox") return json({ error: "agent_auth_required" }, 401);
    return json({ error: "not_found" }, 404);
  };
  const client = createMailboxClient(
    { meshUrl: "https://mesh.test", recipientId: agentId, workloadId, workloadPrivateKey: JSON.stringify(key) },
    { fetchImpl },
  );
  const error = await client.listUnread().catch((e) => e);
  assert.equal(error.name, "MailboxRequestError");
  assert.equal(error.status, 401);
  assert.doesNotMatch(`${error.message} ${String(error.stack)} ${JSON.stringify(error)}`, /wl_token_previous_secret|stale token/);
});

test("the Swift helper's bootstrap key handoff (raw seed, base64url unpadded) is accepted (permissions v1 PR D)", () => {
  // Swift `V1AgentMaterial.workloadPrivateKeySeed` = Base64URL(Curve25519 rawRepresentation),
  // i.e. the 32-byte seed without padding. RFC 8032 §7.1 test 1 pins the public key.
  const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex").toString("base64url");
  assert.equal(seed.length, 43);
  const jwk = parseWorkloadPrivateKey(seed);
  assert.equal(Buffer.from(jwk.x, "base64url").toString("hex"), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  assert.equal(jwk.d, seed);
  // Exactly the five keys the Swift supervisor bootstrap writes.
  const mailbox = validateMailboxClientOptions({
    meshUrl: "https://mesh.example.test",
    recipientId: "agent_0123456789abcdef0123456789abcdef",
    pageLimit: 20,
    workloadId: "workload_0123456789abcdef0123456789abcdef",
    workloadPrivateKey: seed,
  });
  assert.deepEqual(Object.keys(mailbox).sort(), ["meshUrl", "pageLimit", "recipientId", "workloadId", "workloadPrivateKey"]);
  // Padded or truncated seeds are refused rather than reinterpreted.
  assert.throws(() => parseWorkloadPrivateKey(`${seed}=`), /workloadPrivateKey/);
  assert.throws(() => parseWorkloadPrivateKey(seed.slice(0, 42)), /workloadPrivateKey/);
});
