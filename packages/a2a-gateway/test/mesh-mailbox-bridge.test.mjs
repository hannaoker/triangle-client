import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  MeshMailboxBridgeError,
  createMeshMailboxBridge,
} from "../src/mesh-mailbox-bridge.mjs";

const PEER_TOKEN = "mesh_peer_sender_to_codex_secret";
const AGENT_TOKEN = "mesh_gateway_agent_secret";
const RECIPIENT = "agent_codex";
const SENDER = "agent_sender";
const MESSAGE = Object.freeze({
  messageId: "msg_1",
  contextId: "ctx_1",
  taskId: "task_1",
  text: "hello",
});

function response(body, status = 200) {
  return Response.json(body, { status });
}

function meshCanonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(meshCanonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${meshCanonicalJson(value[key])}`
  ).join(",")}}`;
}

function taskPayloadHash(message = MESSAGE) {
  return crypto.createHash("sha256").update(meshCanonicalJson({
    recipient_agent_id: RECIPIENT,
    message,
  })).digest("hex");
}

function correlation(overrides = {}) {
  return Object.freeze({
    senderAgentId: SENDER,
    contextId: "ctx_1",
    taskId: "task_1",
    messageId: "msg_1",
    meshRoomId: "room_1",
    meshEventId: "evt_in",
    meshEventSequence: 1,
    payloadHash: taskPayloadHash(),
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  });
}

function roomHistory(items = [{
  id: "evt_in",
  roomId: "room_1",
  sequence: 1,
  senderAgentId: SENDER,
  type: "message.created",
  body: { text: "hello", replyRequired: true },
  createdAt: "2026-08-28T00:00:00.000Z",
}]) {
  return { roomId: "room_1", items };
}

function fixture({
  bridgeStatus = 201,
  bridgePayload,
  taskItems = [correlation()],
  listItems = [correlation()],
  nextCursor = null,
  history = roomHistory(),
  requestTimeoutMs,
  fetchOverride,
} = {}) {
  const calls = [];
  const fetchImpl = fetchOverride ?? (async (request) => {
    const url = new URL(request.url);
    calls.push({
      path: `${url.pathname}${url.search}`,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: request.method === "POST" ? await request.clone().json() : undefined,
    });
    if (url.pathname === "/api/v1/a2a/bridge") {
      return response(bridgePayload ?? {
        senderAgentId: SENDER,
        room: { id: "room_1" },
        event: { id: "evt_in", sequence: 1 },
        correlation: correlation(),
      }, bridgeStatus);
    }
    if (url.pathname === "/api/v1/a2a/tasks") {
      return response({ items: listItems, nextCursor });
    }
    if (url.pathname.startsWith("/api/v1/a2a/tasks/")) {
      return response({ items: taskItems });
    }
    return response(history);
  });
  const bridge = createMeshMailboxBridge({
    meshOrigin: "https://mesh.example",
    recipientAgentId: RECIPIENT,
    meshAgentToken: AGENT_TOKEN,
    fetchImpl,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  return { bridge, calls };
}

test("exports only the frozen stateless bridge API", () => {
  const { bridge } = fixture();
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge).sort(), ["getTask", "listTasks", "sendMessage"]);
  assert.doesNotThrow(() => createMeshMailboxBridge({
    meshOrigin: "https://mesh.example",
    recipientAgentId: RECIPIENT,
    meshAgentToken: AGENT_TOKEN,
    fetchImpl: async () => response({}),
  }));
});

test("sendMessage performs one MESH bridge write and consumes its canonical correlation", async () => {
  const { bridge, calls } = fixture();
  assert.deepEqual(await bridge.sendMessage({
    peerToken: PEER_TOKEN,
    senderAgentId: SENDER,
    message: MESSAGE,
  }), {
    id: "task_1",
    contextId: "ctx_1",
    status: { state: "TASK_STATE_SUBMITTED" },
  });
  assert.deepEqual(calls.map(({ path }) => path), ["/api/v1/a2a/bridge"]);
  assert.equal(calls[0].authorization, `Bearer ${PEER_TOKEN}`);
  assert.deepEqual(calls[0].body, {
    recipient_agent_id: RECIPIENT,
    message: MESSAGE,
  });
});

test("sendMessage accepts the canonical correlation hash emitted by the real MESH bridge contract", async () => {
  assert.equal(taskPayloadHash(), "b5dcdda7ea164e4cc925920e861e4fae0358211ab8d444ef017d53fc47e83bcc");
  const { bridge } = fixture({ bridgePayload: {
    senderAgentId: SENDER,
    room: { id: "room_1" },
    event: { id: "evt_in", sequence: 1 },
    correlation: correlation({
      payloadHash: "b5dcdda7ea164e4cc925920e861e4fae0358211ab8d444ef017d53fc47e83bcc",
    }),
  } });
  assert.equal((await bridge.sendMessage({
    peerToken: PEER_TOKEN,
    senderAgentId: SENDER,
    message: MESSAGE,
  })).id, "task_1");
});

const MESH_BRIDGE_HELPER = new URL("../../../mesh/app/lib/a2a-mailbox-bridge.ts", import.meta.url);

// The MESH server helper is absent from the exported client repository; the parity
// check only runs inside the monorepo.
test("gateway accepts the hash from the actual production MESH correlation helper", { skip: !fs.existsSync(MESH_BRIDGE_HELPER) && "MESH server helper not present" }, async () => {
  const { computeA2ACorrelationPayloadHash } = await import(MESH_BRIDGE_HELPER.href);
  const meshHash = await computeA2ACorrelationPayloadHash(RECIPIENT, MESSAGE);
  const { bridge } = fixture({ bridgePayload: {
    senderAgentId: SENDER,
    room: { id: "room_1" },
    event: { id: "evt_in", sequence: 1 },
    correlation: correlation({ payloadHash: meshHash }),
  } });
  assert.equal((await bridge.sendMessage({
    peerToken: PEER_TOKEN,
    senderAgentId: SENDER,
    message: MESSAGE,
  })).id, "task_1");
});

test("sendMessage derives one canonical task identity before the bridge write", async () => {
  const input = { messageId: "msg_derived", contextId: "ctx_derived", text: "hello" };
  const taskId = `task_${crypto.createHash("sha256")
    .update(JSON.stringify([SENDER, input.contextId, input.messageId]))
    .digest("base64url").slice(0, 32)}`;
  const canonical = {
    messageId: input.messageId,
    contextId: input.contextId,
    taskId,
    text: input.text,
  };
  const canonicalRow = correlation({
    contextId: input.contextId,
    taskId,
    messageId: input.messageId,
    payloadHash: taskPayloadHash(canonical),
  });
  const { bridge, calls } = fixture({
    bridgePayload: {
      senderAgentId: SENDER,
      room: { id: "room_1" },
      event: { id: "evt_in", sequence: 1 },
      correlation: canonicalRow,
    },
  });
  assert.equal((await bridge.sendMessage({
    peerToken: PEER_TOKEN,
    senderAgentId: SENDER,
    message: input,
  })).id, taskId);
  assert.deepEqual(calls[0].body.message, canonical);
});

test("sendMessage rejects mismatched MESH provenance and correlation state", async (t) => {
  await t.test("authenticated sender mismatch", async () => {
    const { bridge } = fixture({ bridgePayload: {
      senderAgentId: "agent_other",
      room: { id: "room_1" },
      event: { id: "evt_in", sequence: 1 },
      correlation: correlation(),
    } });
    await assert.rejects(
      bridge.sendMessage({ peerToken: PEER_TOKEN, senderAgentId: SENDER, message: MESSAGE }),
      (error) => error instanceof MeshMailboxBridgeError && error.status === 403,
    );
  });
  await t.test("canonical correlation mismatch", async () => {
    const { bridge } = fixture({ bridgePayload: {
      senderAgentId: SENDER,
      room: { id: "room_1" },
      event: { id: "evt_in", sequence: 1 },
      correlation: correlation({ taskId: "task_other" }),
    } });
    await assert.rejects(
      bridge.sendMessage({ peerToken: PEER_TOKEN, senderAgentId: SENDER, message: MESSAGE }),
      (error) => error instanceof MeshMailboxBridgeError && error.code === "mesh_invalid_response",
    );
  });
});

test("sendMessage preserves public MESH rejection codes without reflecting credentials", async () => {
  const { bridge } = fixture({ bridgeStatus: 409, bridgePayload: {
    error: "idempotency_conflict", detail: PEER_TOKEN,
  } });
  await assert.rejects(
    bridge.sendMessage({ peerToken: PEER_TOKEN, senderAgentId: SENDER, message: MESSAGE }),
    (error) => {
      assert.equal(error.code, "idempotency_conflict");
      assert.equal(error.status, 409);
      assert.doesNotMatch(`${error.message} ${error.stack}`, /mesh_peer_sender_to_codex_secret/);
      return true;
    },
  );
});

test("getTask reads correlations from MESH and projects the linked room reply", async () => {
  const history = roomHistory([
    roomHistory().items[0],
    {
      id: "evt_reply", roomId: "room_1", sequence: 2,
      senderAgentId: RECIPIENT, type: "message.created",
      body: { text: "world", replyRequired: false, inReplyToEventId: "evt_in" },
      createdAt: "2026-08-28T00:00:01.000Z",
    },
  ]);
  const { bridge, calls } = fixture({ history });
  const task = await bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" });
  assert.equal(task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(task.status.message.parts[0].text, "world");
  assert.equal(calls[0].path, "/api/v1/a2a/tasks/task_1/correlations?sender_agent_id=agent_sender");
  assert.ok(calls.every(({ authorization }) => authorization === `Bearer ${AGENT_TOKEN}`));
});

test("getTask treats an empty central task lookup as not found", async () => {
  const { bridge, calls } = fixture({ taskItems: [] });
  await assert.rejects(
    bridge.getTask({ senderAgentId: SENDER, taskId: "missing" }),
    (error) => error.code === "task_not_found" && error.status === 404,
  );
  assert.equal(calls.length, 1);
});

test("listTasks reads the central page and each task's canonical correlations", async () => {
  const { bridge, calls } = fixture({ nextCursor: "bmV4dA" });
  const result = await bridge.listTasks({
    senderAgentId: SENDER,
    contextId: "ctx_1",
    limit: 1,
    after: "cHJldg",
  });
  assert.equal(result.tasks[0].id, "task_1");
  assert.equal(result.nextCursor, "bmV4dA");
  assert.equal(
    calls[0].path,
    "/api/v1/a2a/tasks?sender_agent_id=agent_sender&limit=1&context_id=ctx_1&after=cHJldg",
  );
  assert.equal(calls[1].path, "/api/v1/a2a/tasks/task_1/correlations?sender_agent_id=agent_sender");
  assert.ok(calls.every(({ authorization }) => authorization === `Bearer ${AGENT_TOKEN}`));
});

test("listTasks rejects duplicate representatives before task detail reads", async () => {
  const duplicate = correlation({ messageId: "msg_duplicate", meshEventId: "evt_duplicate" });
  const { bridge, calls } = fixture({ listItems: [correlation(), duplicate] });
  await assert.rejects(
    bridge.listTasks({ senderAgentId: SENDER, limit: 2 }),
    (error) => error.code === "mesh_invalid_response",
  );
  assert.equal(calls.length, 1);
});

test("listTasks requires each representative to exist exactly in task detail", async () => {
  const representative = correlation();
  const detail = correlation({ messageId: "msg_other", meshEventId: "evt_other" });
  const { bridge, calls } = fixture({ listItems: [representative], taskItems: [detail] });
  await assert.rejects(
    bridge.listTasks({ senderAgentId: SENDER, limit: 1 }),
    (error) => error.code === "mesh_invalid_response",
  );
  assert.equal(calls.length, 2);
});

test("external identifiers accept exactly 180 UTF-8 bytes and reject 181", async () => {
  const exact = "é".repeat(90);
  const tooLong = `${exact}a`;
  const { bridge, calls } = fixture({ taskItems: [correlation({ taskId: exact })] });
  assert.equal((await bridge.getTask({ senderAgentId: SENDER, taskId: exact })).id, exact);
  const before = calls.length;
  await assert.rejects(
    bridge.getTask({ senderAgentId: SENDER, taskId: tooLong }),
    /taskId must be a non-empty bounded string/,
  );
  assert.equal(calls.length, before);
});

test("central task responses fail closed when malformed or over the continuation bound", async (t) => {
  for (const [name, row] of [
    ["updated before created", correlation({ updatedAt: "2026-08-27T23:59:59.999Z" })],
    ["future timestamp", correlation({
      createdAt: "9999-01-01T00:00:00.000Z",
      updatedAt: "9999-01-01T00:00:00.000Z",
    })],
  ]) {
    await t.test(name, async () => {
      const { bridge, calls } = fixture({ taskItems: [row] });
      await assert.rejects(
        bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" }),
        (error) => error.code === "mesh_invalid_response",
      );
      assert.equal(calls.length, 1);
    });
  }
  await t.test("unexpected task response field", async () => {
    let calls = 0;
    const bridge = createMeshMailboxBridge({
      meshOrigin: "https://mesh.example",
      recipientAgentId: RECIPIENT,
      meshAgentToken: AGENT_TOKEN,
      fetchImpl: async () => {
        calls += 1;
        return response({ items: [correlation()], extra: true });
      },
    });
    await assert.rejects(
      bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" }),
      (error) => error.code === "mesh_invalid_response",
    );
    assert.equal(calls, 1);
  });
  await t.test("malformed cursor", async () => {
    const { bridge } = fixture({ nextCursor: "not valid" });
    await assert.rejects(
      bridge.listTasks({ senderAgentId: SENDER }),
      (error) => error.code === "mesh_invalid_response",
    );
  });
  await t.test("65-row sentinel", async () => {
    const taskItems = Array.from({ length: 65 }, (_, index) => correlation({
      messageId: `msg_${index}`,
      meshEventId: `evt_${index}`,
      meshEventSequence: index + 1,
    }));
    const { bridge } = fixture({ taskItems });
    await assert.rejects(
      bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" }),
      (error) => error.code === "mesh_invalid_response",
    );
  });
  await t.test("foreign sender", async () => {
    const { bridge } = fixture({ taskItems: [correlation({ senderAgentId: "agent_other" })] });
    await assert.rejects(
      bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" }),
      (error) => error.code === "mesh_invalid_response",
    );
  });
});

test("strict constructor and operation validation reject caller-controlled routing", async () => {
  assert.throws(() => createMeshMailboxBridge({
    meshOrigin: "https://mesh.example/path",
    recipientAgentId: RECIPIENT,
    meshAgentToken: AGENT_TOKEN,
    fetchImpl: async () => response({}),
  }), /meshOrigin/);
  assert.throws(() => createMeshMailboxBridge({
    meshOrigin: "https://mesh.example",
    recipientAgentId: RECIPIENT,
    fetchImpl: async () => response({}),
  }), /meshAgentToken/);
  const { bridge, calls } = fixture();
  await assert.rejects(
    bridge.sendMessage({ peerToken: "not-a-ticket", senderAgentId: SENDER, message: MESSAGE }),
    /peerToken is invalid/,
  );
  await assert.rejects(
    bridge.listTasks({ senderAgentId: SENDER, recipientAgentId: "agent_other" }),
    /unexpected fields/,
  );
  assert.equal(calls.length, 0);
});

test("request timeout fails as MESH unavailable", async () => {
  const { bridge } = fixture({
    requestTimeoutMs: 10,
    fetchOverride: async () => new Promise(() => {}),
  });
  await assert.rejects(
    bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" }),
    (error) => error.code === "mesh_unavailable" && error.status === 503,
  );
});

test("history projection paginates from the correlated sequence to a later reply", async () => {
  const calls = [];
  const row = correlation({ meshEventId: "evt_in_101", meshEventSequence: 101 });
  const bridge = createMeshMailboxBridge({
    meshOrigin: "https://mesh.example",
    recipientAgentId: RECIPIENT,
    meshAgentToken: AGENT_TOKEN,
    fetchImpl: async (request) => {
      const url = new URL(request.url);
      calls.push(url);
      if (url.pathname.startsWith("/api/v1/a2a/tasks/")) return response({ items: [row] });
      const after = Number(url.searchParams.get("after_sequence"));
      if (after === 100) {
        return response({ roomId: "room_1", items: Array.from({ length: 100 }, (_, index) => ({
          id: index === 0 ? "evt_in_101" : `evt_${101 + index}`,
          roomId: "room_1", sequence: 101 + index, senderAgentId: SENDER,
          type: "message.created", body: { text: "input", replyRequired: true },
        })) });
      }
      assert.equal(after, 200);
      return response({ roomId: "room_1", items: [{
        id: "evt_reply_201", roomId: "room_1", sequence: 201,
        senderAgentId: RECIPIENT, type: "message.created",
        body: { text: "late reply", replyRequired: false, inReplyToEventId: "evt_in_101" },
      }] });
    },
  });
  const task = await bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" });
  assert.equal(task.status.message.parts[0].text, "late reply");
  assert.deepEqual(
    calls.filter((url) => url.pathname.includes("/rooms/")).map((url) => url.searchParams.get("after_sequence")),
    ["100", "200"],
  );
});

test("history projection rejects non-progressing or malformed pagination", async () => {
  const row = correlation({ meshEventId: "evt_in_101", meshEventSequence: 101 });
  let calls = 0;
  const bridge = createMeshMailboxBridge({
    meshOrigin: "https://mesh.example", recipientAgentId: RECIPIENT,
    meshAgentToken: AGENT_TOKEN,
    fetchImpl: async (request) => {
      calls += 1;
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/v1/a2a/tasks/")) return response({ items: [row] });
      return response({ roomId: "room_1", items: Array.from({ length: 100 }, (_, index) => ({
        id: index === 0 ? "evt_in_101" : `evt_${index}`,
        roomId: "room_1", sequence: 101 + index, senderAgentId: SENDER,
        type: "message.created", body: { text: "input", replyRequired: true },
      })) });
    },
  });
  await assert.rejects(
    bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" }),
    (error) => error.code === "mesh_invalid_response",
  );
  assert.equal(calls, 3);
});

test("task projection orders continuations by MESH sequence and keeps linked replies unique", async () => {
  const rows = [
    correlation({ messageId: "msg_2", meshEventId: "evt_202", meshEventSequence: 202 }),
    correlation({ messageId: "msg_1", meshEventId: "evt_101", meshEventSequence: 101 }),
  ];
  const bridge = createMeshMailboxBridge({
    meshOrigin: "https://mesh.example", recipientAgentId: RECIPIENT,
    meshAgentToken: AGENT_TOKEN,
    fetchImpl: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/v1/a2a/tasks/")) return response({ items: rows });
      const sequence = Number(url.searchParams.get("after_sequence")) + 1;
      const second = sequence === 202;
      const eventId = second ? "evt_202" : "evt_101";
      return response({ roomId: "room_1", items: [
        { id: eventId, roomId: "room_1", sequence, senderAgentId: SENDER,
          type: "message.created", body: { text: "input", replyRequired: true } },
        { id: second ? "reply_2" : "reply_1", roomId: "room_1", sequence: sequence + 1,
          senderAgentId: RECIPIENT, type: "message.created",
          body: { text: second ? "second" : "first", replyRequired: false, inReplyToEventId: eventId } },
      ] });
    },
  });
  const task = await bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" });
  assert.equal(task.status.message.parts[0].text, "second");
  assert.deepEqual(task.history.map((message) => message.messageId), ["reply_1", "reply_2"]);
});

test("an older reply does not complete a task whose newest continuation is unanswered", async () => {
  const rows = [
    correlation({ messageId: "msg_1", meshEventId: "evt_1", meshEventSequence: 1 }),
    correlation({ messageId: "msg_2", meshEventId: "evt_3", meshEventSequence: 3 }),
  ];
  const bridge = createMeshMailboxBridge({
    meshOrigin: "https://mesh.example", recipientAgentId: RECIPIENT,
    meshAgentToken: AGENT_TOKEN,
    fetchImpl: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/v1/a2a/tasks/")) return response({ items: rows });
      const after = Number(url.searchParams.get("after_sequence"));
      return after === 0
        ? response({ roomId: "room_1", items: [
            { id: "evt_1", roomId: "room_1", sequence: 1, senderAgentId: SENDER,
              type: "message.created", body: { text: "one", replyRequired: true } },
            { id: "reply_1", roomId: "room_1", sequence: 2, senderAgentId: RECIPIENT,
              type: "message.created", body: { text: "answered", replyRequired: false, inReplyToEventId: "evt_1" } },
          ] })
        : response({ roomId: "room_1", items: [{
            id: "evt_3", roomId: "room_1", sequence: 3, senderAgentId: SENDER,
            type: "message.created", body: { text: "two", replyRequired: true },
          }] });
    },
  });
  const task = await bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" });
  assert.equal(task.status.state, "TASK_STATE_SUBMITTED");
  assert.deepEqual(task.history.map((message) => message.messageId), ["reply_1"]);
});

test("request deadline covers stalled fetch and stalled response bodies", async (t) => {
  const input = { peerToken: PEER_TOKEN, senderAgentId: SENDER, message: MESSAGE };
  for (const scenario of ["fetch", "body"]) {
    await t.test(scenario, async () => {
      const { bridge } = fixture({
        requestTimeoutMs: 20,
        fetchOverride: scenario === "fetch"
          ? async () => new Promise(() => {})
          : async () => new Response(new ReadableStream({ pull() {} })),
      });
      await assert.rejects(
        bridge.sendMessage(input),
        (error) => error.code === "mesh_unavailable" && error.status === 503,
      );
    });
  }
});

test("request deadlines reject unsafe configuration bounds", () => {
  for (const requestTimeoutMs of [1, 30_001, 1.5]) {
    assert.throws(() => createMeshMailboxBridge({
      meshOrigin: "https://mesh.example", recipientAgentId: RECIPIENT,
      meshAgentToken: AGENT_TOKEN, fetchImpl: async () => response({}), requestTimeoutMs,
    }), /requestTimeoutMs/);
  }
});

test("chunked oversized responses cancel early and redact credentials", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const { bridge } = fixture({
    fetchOverride: async () => new Response(new ReadableStream({
      start(controller) {
        for (let index = 0; index < 5; index += 1) controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    })),
  });
  await assert.rejects(
    bridge.sendMessage({ peerToken: PEER_TOKEN, senderAgentId: SENDER, message: MESSAGE }),
    (error) => error.code === "mesh_invalid_response" &&
      !String(error).includes(PEER_TOKEN) && !String(error).includes(AGENT_TOKEN),
  );
  assert.equal(cancelled, true);
});

test("deadline and oversize settle when stream cancellation hangs or rejects", async (t) => {
  const input = { peerToken: PEER_TOKEN, senderAgentId: SENDER, message: MESSAGE };
  for (const cancelMode of ["hang", "reject"]) {
    for (const scenario of ["deadline", "oversize"]) {
      await t.test(`${cancelMode} ${scenario}`, async () => {
        const chunk = new Uint8Array(1024 * 1024);
        const { bridge } = fixture({
          requestTimeoutMs: 20,
          fetchOverride: async () => new Response(new ReadableStream({
            start(controller) {
              if (scenario === "oversize") {
                for (let index = 0; index < 5; index += 1) controller.enqueue(chunk);
              }
            },
            cancel() {
              return cancelMode === "hang"
                ? new Promise(() => {})
                : Promise.reject(new Error("hostile cancellation"));
            },
          })),
        });
        await Promise.race([
          assert.rejects(bridge.sendMessage(input), (error) =>
            error.code === (scenario === "deadline" ? "mesh_unavailable" : "mesh_invalid_response")),
          new Promise((_, reject) => setTimeout(() => reject(new Error("operation did not settle")), 150)),
        ]);
        await new Promise((resolve) => setImmediate(resolve));
      });
    }
  }
});

test("projection admits 64 continuations and rejects the 65-row sentinel before history", async (t) => {
  for (const count of [64, 65]) {
    await t.test(String(count), async () => {
      const rows = Array.from({ length: count }, (_, index) => correlation({
        messageId: `msg_${index}`,
        meshEventId: `evt_${index + 1}`,
        meshEventSequence: index + 1,
      }));
      let historyRequests = 0;
      const bridge = createMeshMailboxBridge({
        meshOrigin: "https://mesh.example", recipientAgentId: RECIPIENT,
        meshAgentToken: AGENT_TOKEN,
        fetchImpl: async (request) => {
          const url = new URL(request.url);
          if (url.pathname.startsWith("/api/v1/a2a/tasks/")) return response({ items: rows });
          historyRequests += 1;
          const sequence = Number(url.searchParams.get("after_sequence")) + 1;
          return response({ roomId: "room_1", items: [{
            id: `evt_${sequence}`, roomId: "room_1", sequence, senderAgentId: SENDER,
            type: "message.created", body: { text: "input", replyRequired: true },
          }] });
        },
      });
      if (count === 64) {
        const task = await bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" });
        assert.equal(task.status.state, "TASK_STATE_SUBMITTED");
        assert.equal(historyRequests, 64);
      } else {
        await assert.rejects(
          bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" }),
          (error) => error.code === "mesh_invalid_response",
        );
        assert.equal(historyRequests, 0);
      }
    });
  }
});

test("projection rejects a 130th request across list, task, and history reads", async () => {
  const rows = Array.from({ length: 64 }, (_, index) => correlation({
    contextId: `ctx_${index}`, taskId: `task_${index}`, messageId: `msg_${index}`,
    meshRoomId: `room_${index}`, meshEventId: `evt_${index}`,
  }));
  let requests = 0;
  const bridge = createMeshMailboxBridge({
    meshOrigin: "https://mesh.example", recipientAgentId: RECIPIENT,
    meshAgentToken: AGENT_TOKEN,
    fetchImpl: async (request) => {
      requests += 1;
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/a2a/tasks") return response({ items: rows, nextCursor: null });
      if (url.pathname.startsWith("/api/v1/a2a/tasks/")) {
        const taskId = decodeURIComponent(url.pathname.split("/").at(-2));
        return response({ items: [rows.find((row) => row.taskId === taskId)] });
      }
      const roomId = decodeURIComponent(url.pathname.split("/").at(-2));
      const row = rows.find((candidate) => candidate.meshRoomId === roomId);
      const after = Number(url.searchParams.get("after_sequence"));
      const isLast = roomId === "room_63";
      return response({ roomId, items: isLast
        ? Array.from({ length: 100 }, (_, index) => ({
            id: index === 0 ? row.meshEventId : `dense_${index}`,
            roomId, sequence: after + 1 + index, senderAgentId: SENDER,
            type: "message.created", body: { text: "dense", replyRequired: true },
          }))
        : [{
            id: row.meshEventId, roomId, sequence: 1, senderAgentId: SENDER,
            type: "message.created", body: { text: "input", replyRequired: true },
          }] });
    },
  });
  await assert.rejects(
    bridge.listTasks({ senderAgentId: SENDER, limit: 64 }),
    (error) => error.code === "mesh_invalid_response",
  );
  assert.equal(requests, 129);
});

test("listTasks admits 64 central tasks within the aggregate budget and rejects 65", async () => {
  const rows = Array.from({ length: 64 }, (_, index) => correlation({
    contextId: `ctx_${index}`, taskId: `task_${index}`, messageId: `msg_${index}`,
    meshRoomId: `room_${index}`, meshEventId: `evt_${index}`,
  }));
  let requests = 0;
  const bridge = createMeshMailboxBridge({
    meshOrigin: "https://mesh.example", recipientAgentId: RECIPIENT,
    meshAgentToken: AGENT_TOKEN,
    fetchImpl: async (request) => {
      requests += 1;
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/a2a/tasks") return response({ items: rows, nextCursor: null });
      if (url.pathname.startsWith("/api/v1/a2a/tasks/")) {
        const taskId = decodeURIComponent(url.pathname.split("/").at(-2));
        return response({ items: [rows.find((row) => row.taskId === taskId)] });
      }
      const roomId = decodeURIComponent(url.pathname.split("/").at(-2));
      const row = rows.find((candidate) => candidate.meshRoomId === roomId);
      return response({ roomId, items: [{
        id: row.meshEventId, roomId, sequence: 1, senderAgentId: SENDER,
        type: "message.created", body: { text: "input", replyRequired: true },
      }] });
    },
  });
  const page = await bridge.listTasks({ senderAgentId: SENDER, limit: 64 });
  assert.equal(page.tasks.length, 64);
  assert.equal(requests, 129);
  await assert.rejects(
    bridge.listTasks({ senderAgentId: SENDER, limit: 65 }),
    /limit must be between 1 and 64/i,
  );
  assert.equal(requests, 129);
});

test("malformed history and operational failures fail closed without reflecting credentials", async (t) => {
  for (const scenario of ["malformed", "failure"]) {
    await t.test(scenario, async () => {
      const { bridge } = fixture({
        fetchOverride: async (request) => {
          const url = new URL(request.url);
          if (url.pathname.startsWith("/api/v1/a2a/tasks/")) {
            return response({ items: [correlation()] });
          }
          return scenario === "malformed"
            ? response({ roomId: "room_1", items: [{ id: "wrong" }] })
            : response({ error: "secret", detail: AGENT_TOKEN }, 503);
        },
      });
      await assert.rejects(
        bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" }),
        (error) =>
          error.code === (scenario === "malformed" ? "mesh_invalid_response" : "mesh_unavailable") &&
          !String(error).includes(PEER_TOKEN) && !String(error).includes(AGENT_TOKEN),
      );
    });
  }
});

test("task projection rejects incompatible lineage and duplicate sequence before history reads", async (t) => {
  for (const [name, mutate] of [
    ["context", (row) => ({ ...row, contextId: "ctx_other", meshEventSequence: 2 })],
    ["room", (row) => ({ ...row, meshRoomId: "room_other", meshEventSequence: 2 })],
    ["sequence", (row) => ({ ...row, messageId: "msg_other", meshEventId: "evt_other" })],
  ]) {
    await t.test(name, async () => {
      const base = correlation();
      let requests = 0;
      const bridge = createMeshMailboxBridge({
        meshOrigin: "https://mesh.example", recipientAgentId: RECIPIENT,
        meshAgentToken: AGENT_TOKEN,
        fetchImpl: async () => {
          requests += 1;
          return response({ items: [base, mutate(base)] });
        },
      });
      await assert.rejects(
        bridge.getTask({ senderAgentId: SENDER, taskId: "task_1" }),
        (error) => error.code === "mesh_invalid_response",
      );
      assert.equal(requests, 1);
    });
  }
});
