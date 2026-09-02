import assert from "node:assert/strict";
import test from "node:test";

import { createOutboundClient } from "../src/outbound-client.mjs";

test("outbound client sends and polls through the private gateway bridge", async () => {
  const requests = [];
  const client = createOutboundClient(
    {
      gatewayUrl: "https://sender.example",
      internalToken: "private-token",
    },
    {
      fetchImpl: async (request) => {
        requests.push({ request, body: await request.json() });
        return Response.json({
          peer: { id: "agent_peer", name: "Peer" },
          task: {
            id: "task_1",
            contextId: "context_1",
            status: { state: "TASK_STATE_SUBMITTED" },
          },
        });
      },
    },
  );

  await client.send({
    recipientAgentId: "agent_peer",
    messageId: "message_1",
    contextId: "context_1",
    text: "hello",
  });
  await client.getTask({ recipientAgentId: "agent_peer", taskId: "task_1" });

  assert.equal(requests[0].request.headers.get("authorization"), "Bearer private-token");
  assert.deepEqual(requests[0].body, {
    operation: "send",
    recipient_agent_id: "agent_peer",
    message_id: "message_1",
    context_id: "context_1",
    text: "hello",
  });
  assert.deepEqual(requests[1].body, {
    operation: "get_task",
    recipient_agent_id: "agent_peer",
    task_id: "task_1",
  });
});

