/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { once } = require("node:events");
const { createServer } = require("../src/server.cjs");

function bridgeFixture() {
  const calls = [];
  return {
    calls,
    bridge: {
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
    },
  };
}

async function startServer(t, overrides = {}) {
  const fixture = bridgeFixture();
  const created = createServer({
    port: 0,
    origin: "http://localhost:0",
    bridge: fixture.bridge,
    recipientAgentId: "agent_11111111111111111111111111111111",
    introspectPeerToken: async () => ({
      active: true,
      sender: { id: "agent_sender" },
      audience_agent_id: "agent_11111111111111111111111111111111",
    }),
    ...overrides,
  });
  created.server.listen(0, "127.0.0.1");
  await once(created.server, "listening");
  t.after(() => {
    created.server.closeAllConnections();
    created.server.close();
  });
  return {
    ...created,
    calls: fixture.calls,
    origin: `http://127.0.0.1:${created.server.address().port}`,
  };
}

test("local server requires the mailbox bridge before construction", () => {
  assert.throws(() => createServer(), /bridge is required/);
});

test("retired routes are 404 for every method and never touch the bridge", async (t) => {
  const created = await startServer(t);
  for (const path of ["/inbox", "/inbox/ack", "/internal/tasks/update"]) {
    for (const method of ["GET", "POST", "PUT", "OPTIONS"]) {
      const result = await fetch(`${created.origin}${path}`, {
        method,
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ secret: "body" }) }),
      });
      assert.equal(result.status, 404);
    }
  }
  assert.equal(created.calls.length, 0);
});

test("local metadata and identity-free health remain available", async (t) => {
  const created = await startServer(t);
  const card = await (await fetch(`${created.origin}/.well-known/agent-card.json`)).json();
  assert.equal(card.name, "Codex Agent");
  assert.deepEqual(await (await fetch(`${created.origin}/health`)).json(), {
    status: "ok", bridge: "available",
  });
});

test("local A2A delegates to the mailbox bridge", async (t) => {
  const created = await startServer(t);
  const response = await fetch(`${created.origin}/api/v1`, {
    method: "POST",
    headers: {
      authorization: "Bearer mesh_peer_secret",
      "a2a-version": "1.0",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "r1", method: "SendMessage", params: {
        configuration: { returnImmediately: true },
        message: { messageId: "msg_1", contextId: "ctx_1", role: "ROLE_USER", parts: [{ text: "work" }] },
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.task.id, "task_1");
  assert.deepEqual(created.calls.map(([name]) => name), ["send"]);
});

test("standalone executable has no mutable fallback and fails before listening", () => {
  const source = fs.readFileSync(new URL("../src/server.cjs", `file://${__filename}`), "utf8");
  assert.doesNotMatch(source, /state-store|state\.json|legacyStateMode/);
  assert.match(source, /server not started/);
  assert.doesNotMatch(source, /require\.main[\s\S]*\.listen\(/);
});
