import assert from "node:assert/strict";
import test from "node:test";
import { createVercelGatewayHandler } from "../src/vercel-handler.mjs";

const origin = "https://ada.example.test";
const meshOrigin = "https://mesh.example.test";
const recipientAgentId = "agent_11111111111111111111111111111111";

function fixture(overrides = {}) {
  const calls = [];
  let loads = 0;
  const bridge = {
    async sendMessage(input) {
      calls.push(["send", input]);
      return { id: "task_1", contextId: "ctx_1", status: { state: "TASK_STATE_SUBMITTED" } };
    },
    async getTask(input) {
      calls.push(["get", input]);
      return { id: input.taskId, contextId: "ctx_1", status: { state: "TASK_STATE_COMPLETED" } };
    },
    async listTasks(input) {
      calls.push(["list", input]);
      return { tasks: [], nextCursor: null };
    },
  };
  const handler = createVercelGatewayHandler({
    origin,
    meshOrigin,
    profile: { name: "Ada", skills: [] },
    recipientAgentId,
    proofNonce: "proof-123",
    bridgeFactory: async () => { loads += 1; return bridge; },
    introspectPeerToken: async () => ({
      active: true,
      sender: { id: "agent_sender" },
      audience_agent_id: recipientAgentId,
    }),
    bridgeWaitTimeoutMs: 100,
    bridgeWaitPollMs: 1,
    ...overrides,
  });
  return { handler, calls, loads: () => loads };
}

function a2aRequest(method, params) {
  return new Request(`${origin}/api/v1`, {
    method: "POST",
    headers: {
      authorization: "Bearer mesh_peer_valid",
      "a2a-version": "1.0",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "r1", method, params }),
  });
}

test("serverless handler requires only bridge projection dependencies", () => {
  assert.throws(() => createVercelGatewayHandler({
    origin, meshOrigin, profile: { name: "Ada" }, recipientAgentId,
    introspectPeerToken: async () => null,
  }), /bridgeFactory is required/);
});

test("retired routes are unconditional 404 without bridge initialization", async () => {
  const { handler, loads } = fixture();
  for (const path of ["/inbox", "/inbox/ack", "/internal/tasks/update"]) {
    for (const method of ["GET", "POST", "PUT", "OPTIONS"]) {
      const result = await handler(new Request(`${origin}${path}`, {
        method,
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ secret: "body" }) }),
      }));
      assert.equal(result.status, 404);
    }
  }
  assert.equal(loads(), 0);
});

test("Agent Card, proof, and identity-free health remain available", async () => {
  const { handler } = fixture();
  assert.equal((await (await handler(new Request(`${origin}/.well-known/agent-card.json`))).json()).name, "Ada");
  assert.deepEqual(await (await handler(new Request(`${origin}/.well-known/mesh-proof.json`))).json(), { nonce: "proof-123" });
  assert.deepEqual(await (await handler(new Request(`${origin}/health`))).json(), {
    status: "ok", bridge: "available",
  });
});

test("wrong audience fails before bridge initialization", async () => {
  const { handler, loads } = fixture({
    introspectPeerToken: async () => ({
      active: true, sender: { id: "agent_sender" }, audience_agent_id: "agent_other",
    }),
  });
  const response = await handler(a2aRequest("GetTask", { id: "task_1" }));
  assert.equal(response.status, 403);
  assert.equal(loads(), 0);
});

test("SendMessage waits by default and returns immediately only when requested", async () => {
  const { handler, calls } = fixture();
  const waited = await handler(a2aRequest("SendMessage", {
    message: { messageId: "msg_1", contextId: "ctx_1", role: "ROLE_USER", parts: [{ text: "work" }] },
  }));
  assert.equal((await waited.json()).result.task.status.state, "TASK_STATE_COMPLETED");
  assert.deepEqual(calls.map(([name]) => name), ["send", "get"]);
  calls.length = 0;
  const immediate = await handler(a2aRequest("SendMessage", {
    configuration: { returnImmediately: true },
    message: { messageId: "msg_2", contextId: "ctx_1", role: "ROLE_USER", parts: [{ text: "work" }] },
  }));
  assert.equal((await immediate.json()).result.task.status.state, "TASK_STATE_SUBMITTED");
  assert.deepEqual(calls.map(([name]) => name), ["send"]);
});

test("parse and request-size failures stay protocol safe", async () => {
  const { handler, loads } = fixture({ maxRequestBytes: 32 });
  const malformed = await handler(new Request(`${origin}/api/v1`, { method: "POST", body: "{" }));
  assert.equal((await malformed.json()).error.code, -32700);
  const oversized = await handler(new Request(`${origin}/api/v1`, { method: "POST", body: "x".repeat(33) }));
  assert.equal(oversized.status, 413);
  assert.equal(loads(), 0);
});
