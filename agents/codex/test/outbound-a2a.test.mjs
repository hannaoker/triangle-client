import assert from "node:assert/strict";
import test from "node:test";

import { createOutboundA2AHandler } from "@the-triangle/a2a-gateway/outbound-a2a";

const env = {
  GATEWAY_INTERNAL_TOKEN: "codex-worker-secret-with-enough-entropy",
  MESH_ORIGIN: "https://mesh.example",
  MESH_AGENT_TOKEN: "mesh_codex_production",
};
const hermes = {
  id: "agent_hermes",
  name: "Hermes",
  endpointUrl: "https://hermes.example/api/v1",
  protocolBinding: "JSONRPC",
  protocolVersion: "1.0",
  conformanceStatus: "verified",
  conformanceReport: JSON.stringify({ method: "SendMessage", responseKind: "task" }),
  status: "online",
};

function privateRequest(body, token = env.GATEWAY_INTERNAL_TOKEN) {
  return new Request("https://codex.example/internal/a2a/outbound", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function json(body, status = 200) {
  return Response.json(body, { status });
}

test("outbound bridge rejects missing and incorrect worker authentication before fetch", async () => {
  let calls = 0;
  const handler = createOutboundA2AHandler({
    env,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not fetch");
    },
  });
  const missing = await handler(
    new Request("https://codex.example/internal/a2a/outbound", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  const incorrect = await handler(privateRequest({}, "incorrect-token-value"));
  assert.equal(missing.status, 404);
  assert.equal(incorrect.status, 404);
  assert.equal(calls, 0);
});

test("send resolves a verified peer, renews a ticket, and sends standard A2A", async () => {
  const requests = [];
  const handler = createOutboundA2AHandler({
    env,
    fetchImpl: async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/agents") {
        return json({ agents: [hermes] });
      }
      if (url.pathname === "/api/v1/peer-tokens") {
        return json({ token: "mesh_peer_fresh", audience_agent_id: hermes.id }, 201);
      }
      if (request.url === hermes.endpointUrl) {
        return json({
          jsonrpc: "2.0",
          id: "rpc_1",
          result: {
            task: {
              id: "task_1",
              contextId: "ctx_1",
              status: { state: "TASK_STATE_SUBMITTED" },
              history: [],
            },
          },
        });
      }
      throw new Error(`Unexpected request ${request.url}`);
    },
  });
  const response = await handler(
    privateRequest({
      operation: "send",
      recipient_agent_id: hermes.id,
      message_id: "message_1",
      context_id: "ctx_1",
      text: "Hello Hermes",
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    peer: { id: hermes.id, name: "Hermes" },
    task: {
      id: "task_1",
      contextId: "ctx_1",
      status: { state: "TASK_STATE_SUBMITTED" },
      history: [],
    },
  });
  assert.equal(requests.length, 3);
  assert.equal(
    requests[1].headers.get("authorization"),
    `Bearer ${env.MESH_AGENT_TOKEN}`,
  );
  assert.deepEqual(await requests[1].json(), {
    recipient_agent_id: hermes.id,
    lifetime_seconds: 300,
  });
  assert.equal(requests[2].headers.get("authorization"), "Bearer mesh_peer_fresh");
  assert.equal(requests[2].headers.get("a2a-version"), "1.0");
  const rpc = await requests[2].json();
  assert.equal(rpc.method, "SendMessage");
  assert.deepEqual(rpc.params, {
    message: {
      messageId: "message_1",
      contextId: "ctx_1",
      role: "ROLE_USER",
      parts: [{ text: "Hello Hermes" }],
    },
    configuration: { returnImmediately: true },
  });
});

test("get_task renews authorization and normalizes the standard task result", async () => {
  const requests = [];
  const task = {
    id: "task_1",
    contextId: "ctx_1",
    status: {
      state: "TASK_STATE_COMPLETED",
      message: {
        messageId: "reply_1",
        taskId: "task_1",
        contextId: "ctx_1",
        role: "ROLE_AGENT",
        parts: [{ text: "Hello Codex" }],
      },
    },
    history: [],
  };
  const handler = createOutboundA2AHandler({
    env,
    fetchImpl: async (request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/agents") return json({ agents: [hermes] });
      if (path === "/api/v1/peer-tokens") {
        return json({ token: "mesh_peer_renewed" }, 201);
      }
      return json({ jsonrpc: "2.0", id: "rpc_get", result: task });
    },
  });
  const response = await handler(
    privateRequest({
      operation: "get_task",
      recipient_agent_id: hermes.id,
      task_id: task.id,
    }),
  );
  assert.deepEqual(await response.json(), {
    peer: { id: hermes.id, name: "Hermes" },
    task,
  });
  const rpc = await requests.at(-1).json();
  assert.equal(rpc.method, "GetTask");
  assert.deepEqual(rpc.params, { id: task.id, historyLength: 100 });
});

test("send accepts a standard message result and normalizes it as a completed task", async () => {
  const responseMessage = {
    messageId: "reply_1",
    contextId: "ctx_1",
    role: "ROLE_AGENT",
    parts: [{ text: "Hello Codex" }],
  };
  const handler = createOutboundA2AHandler({
    env,
    fetchImpl: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/agents") return json({ agents: [hermes] });
      if (path === "/api/v1/peer-tokens") {
        return json({ token: "mesh_peer_fresh" });
      }
      if (request.url === hermes.endpointUrl) {
        const rpc = await request.json();
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { message: responseMessage },
        });
      }
      throw new Error(`Unexpected request ${request.url}`);
    },
  });

  const response = await handler(
    privateRequest({
      operation: "send",
      recipient_agent_id: hermes.id,
      message_id: "message_1",
      context_id: "ctx_1",
      text: "Hello Hermes",
    }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.peer.id, hermes.id);
  assert.equal(payload.task.contextId, "ctx_1");
  assert.match(payload.task.id, /^task_/);
  assert.deepEqual(payload.task.status, {
    state: "TASK_STATE_COMPLETED",
    message: responseMessage,
  });
  assert.deepEqual(payload.task.history, [responseMessage]);
});

test("bridge rejects unverified peers, arbitrary URLs, methods, and malformed inputs", async () => {
  let peer = { ...hermes, conformanceStatus: "pending" };
  let directCalls = 0;
  const handler = createOutboundA2AHandler({
    env,
    fetchImpl: async (request) => {
      if (new URL(request.url).pathname === "/api/v1/agents") {
        return json({ agents: [peer] });
      }
      directCalls += 1;
      throw new Error("must not call peer");
    },
  });
  const base = {
    operation: "send",
    recipient_agent_id: hermes.id,
    message_id: "message_1",
    text: "hello",
  };
  assert.equal((await handler(privateRequest(base))).status, 409);
  peer = { ...hermes, endpointUrl: "http://localhost:3001/api/v1" };
  assert.equal((await handler(privateRequest(base))).status, 409);
  peer = { ...hermes, protocolBinding: "HTTP+JSON" };
  assert.equal((await handler(privateRequest(base))).status, 409);
  for (const payload of [
    { operation: "delete", recipient_agent_id: hermes.id },
    { ...base, recipient_agent_id: "../admin" },
    { ...base, message_id: "" },
    { ...base, text: "" },
    { ...base, text: "x".repeat(10_001) },
    {
      operation: "get_task",
      recipient_agent_id: hermes.id,
      task_id: "../task",
    },
  ]) {
    assert.equal((await handler(privateRequest(payload))).status, 400);
  }
  assert.equal(directCalls, 0);
});

test("bridge returns bounded safe errors for MESH and peer failures", async () => {
  const handler = createOutboundA2AHandler({
    env,
    fetchImpl: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/agents") return json({ agents: [hermes] });
      if (path === "/api/v1/peer-tokens") {
        return json(
          { error: "agent_auth_required", secret: env.MESH_AGENT_TOKEN },
          401,
        );
      }
      throw new Error("unexpected");
    },
  });
  const response = await handler(
    privateRequest({
      operation: "send",
      recipient_agent_id: hermes.id,
      message_id: "message_1",
      text: "hello",
    }),
  );
  const payload = await response.json();
  assert.equal(response.status, 502);
  assert.deepEqual(payload, {
    error: "mesh_ticket_failed",
    upstream_status: 401,
    upstream_error: "agent_auth_required",
  });
  assert.doesNotMatch(JSON.stringify(payload), /mesh_codex_production/);
});
