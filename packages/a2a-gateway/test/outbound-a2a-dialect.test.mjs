import assert from "node:assert/strict";
import test from "node:test";

import { createOutboundA2AHandler } from "../src/outbound-a2a.mjs";
import {
  buildOutboundRpc,
  normalizeOutboundPayload,
  verifiedOutboundDialect,
} from "../src/outbound-a2a-dialect.mjs";

const env = {
  GATEWAY_INTERNAL_TOKEN: "internal-token-with-sufficient-entropy",
  MESH_ORIGIN: "https://mesh.example",
  MESH_AGENT_TOKEN: "mesh_sender_token",
};

function peer(method = "SendMessage") {
  return {
    id: "agent_recipient",
    name: "Recipient",
    endpointUrl: "https://recipient.example/api/v1",
    protocolBinding: "JSONRPC",
    protocolVersion: "1.0",
    conformanceStatus: "verified",
    conformanceReport: JSON.stringify({
      method,
      responseKind: method === "message/send" ? "message" : "task",
    }),
  };
}

function request(operation = "send") {
  return new Request("https://sender.example/internal/a2a/outbound", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GATEWAY_INTERNAL_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      operation === "send"
        ? {
            operation,
            recipient_agent_id: "agent_recipient",
            message_id: "message_1",
            context_id: "context_1",
            text: "Hello",
          }
        : {
            operation,
            recipient_agent_id: "agent_recipient",
            task_id: "task_1",
          },
    ),
  });
}

test("selects only exact allowlisted methods from a bounded stored report", () => {
  assert.deepEqual(verifiedOutboundDialect(peer("SendMessage")), {
    sendMethod: "SendMessage",
    getTaskMethod: "GetTask",
  });
  assert.deepEqual(verifiedOutboundDialect(peer("message/send")), {
    sendMethod: "message/send",
    getTaskMethod: "tasks/get",
  });

  for (const conformanceReport of [
    undefined,
    "",
    "not-json",
    "[]",
    JSON.stringify({}),
    JSON.stringify({ method: "tasks/send" }),
    JSON.stringify({ method: "SendMessage", extra: "x".repeat(2_100) }),
  ]) {
    assert.throws(
      () => verifiedOutboundDialect({ ...peer(), conformanceReport }),
      /verified conformance report/i,
    );
  }
});

test("builds dialect-correct send and get_task RPC envelopes", () => {
  const action = {
    type: "send",
    messageId: "message_1",
    contextId: "context_1",
    text: "Hello",
  };
  const modern = { sendMethod: "message/send", getTaskMethod: "tasks/get" };
  const pascal = { sendMethod: "SendMessage", getTaskMethod: "GetTask" };

  assert.deepEqual(buildOutboundRpc(action, modern, "rpc_1"), {
    jsonrpc: "2.0",
    id: "rpc_1",
    method: "message/send",
    params: {
      message: {
        messageId: "message_1",
        contextId: "context_1",
        role: "ROLE_USER",
        parts: [{ text: "Hello" }],
      },
      configuration: { returnImmediately: true },
    },
  });
  assert.equal(buildOutboundRpc(action, pascal, "rpc_2").method, "SendMessage");
  assert.deepEqual(
    buildOutboundRpc({ type: "get_task", taskId: "task_1" }, modern, "rpc_3"),
    {
      jsonrpc: "2.0",
      id: "rpc_3",
      method: "tasks/get",
      params: { id: "task_1", historyLength: 100 },
    },
  );
  assert.equal(
    buildOutboundRpc({ type: "get_task", taskId: "task_1" }, pascal, "rpc_4").method,
    "GetTask",
  );
});

test("normalizes a standard message result without reflecting arbitrary fields", () => {
  const payload = normalizeOutboundPayload(
    "send",
    {
      jsonrpc: "2.0",
      result: {
        message: {
          messageId: "reply_1",
          taskId: "task_1",
          contextId: "context_1",
          role: "ROLE_AGENT",
          parts: [{ text: "Done", ignored: "not reflected" }],
          ignored: "not reflected",
        },
        ignored: "not reflected",
      },
    },
    () => "task_generated",
  );
  assert.deepEqual(payload.result.task, {
    id: "task_1",
    contextId: "context_1",
    status: {
      state: "TASK_STATE_COMPLETED",
      message: {
        messageId: "reply_1",
        taskId: "task_1",
        contextId: "context_1",
        role: "ROLE_AGENT",
        parts: [{ text: "Done" }],
      },
    },
    history: [
      {
        messageId: "reply_1",
        taskId: "task_1",
        contextId: "context_1",
        role: "ROLE_AGENT",
        parts: [{ text: "Done" }],
      },
    ],
  });
  assert.equal("ignored" in payload.result, false);
});

test("message/send integration dispatches and safely normalizes a message reply", async () => {
  const seen = [];
  const recipient = peer("message/send");
  const handler = createOutboundA2AHandler({
    env,
    fetchImpl: async (outbound) => {
      seen.push(outbound);
      const path = new URL(outbound.url).pathname;
      if (path === "/api/v1/agents") return Response.json({ agents: [recipient] });
      if (path === "/api/v1/peer-tokens") {
        return Response.json({ token: "mesh_peer_ticket" }, { status: 201 });
      }
      const rpc = await outbound.json();
      assert.equal(rpc.method, "message/send");
      assert.equal(outbound.headers.get("a2a-version"), "1.0");
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          message: {
            messageId: "reply_1",
            taskId: "task_1",
            contextId: "context_1",
            role: "ROLE_AGENT",
            parts: [{ text: "Done" }],
          },
        },
      });
    },
  });

  const response = await handler(request("send"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).task.id, "task_1");
  assert.equal(seen.length, 3);
});

test("verified peers with unusable reports fail before ticket issuance", async () => {
  for (const conformanceReport of [undefined, "{", '{"method":"arbitrary"}']) {
    const seen = [];
    const handler = createOutboundA2AHandler({
      env,
      fetchImpl: async (outbound) => {
        seen.push(outbound);
        return Response.json({
          agents: [{ ...peer(), conformanceReport }],
        });
      },
    });
    const response = await handler(request("send"));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "recipient_not_callable");
    assert.equal(seen.length, 1);
  }
});
