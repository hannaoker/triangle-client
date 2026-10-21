import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  createLocalMessagingMcpHandler,
  runMcpStdioSession,
} from "../src/local-messaging-mcp-adapter.mjs";
import {
  createTurnCapabilityIssuer,
  createTurnCapabilityValidator,
} from "../src/local-messaging-credentials.mjs";

test("MCP adapter lists tools and handles initialize", async () => {
  const secret = "test-secret-key-32-bytes-long-1234567890";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });
  const token = issuer.issue({ senderId: "desktop-codex" });

  const mockClient = {
    discoverRecipients: async () => ["gravity2"],
    sendMessage: async () => ({ accepted: true, messageId: "msg-1", status: "queued_local" }),
    getMessageStatus: async () => ({ messageId: "msg-1", phase: "queued_local" }),
    listReplies: async () => [],
    consumeReply: async () => ({ consumed: true }),
    cancelMessage: async () => ({ status: "unsupported" }),
  };

  const handler = createLocalMessagingMcpHandler({
    client: mockClient,
    credentialValidator: validator,
    turnCredential: token,
    senderId: "desktop-codex",
  });

  // 1. Initialize
  const initRes = await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "test-codex", version: "1.0.0" } },
  });
  assert.equal(initRes.result.serverInfo.name, "triangle-local-messaging-mcp");

  // 2. List tools
  const toolsRes = await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assert.ok(Array.isArray(toolsRes.result.tools));
  const toolNames = toolsRes.result.tools.map((t) => t.name);
  assert.ok(toolNames.includes("triangle_list_recipients"));
  assert.ok(toolNames.includes("triangle_send_message"));
  assert.ok(toolNames.includes("triangle_get_replies"));
  assert.ok(toolNames.includes("triangle_consume_reply"));
  assert.ok(toolNames.includes("triangle_cancel_message"));

  // 3. Call tool: list recipients
  const callRes = await handler.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "triangle_list_recipients", arguments: {} },
  });
  assert.equal(callRes.result.isError, false);
  const data = JSON.parse(callRes.result.content[0].text);
  assert.deepEqual(data.recipients, ["gravity2"]);
});

test("MCP stdio regression: initialize -> initialized notification (no response) -> tools/list -> tools/call", async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const secret = "test-secret-key-32-bytes-long-1234567890";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });
  const token = issuer.issue({ senderId: "desktop-codex" });

  const mockClient = {
    discoverRecipients: async () => ["gravity2"],
  };

  const handler = createLocalMessagingMcpHandler({
    client: mockClient,
    credentialValidator: validator,
    turnCredential: token,
    senderId: "desktop-codex",
  });

  const sessionPromise = runMcpStdioSession({ input, output, handler });

  const lines = [];
  output.on("data", (chunk) => {
    const rawLines = chunk.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
    for (const l of rawLines) lines.push(JSON.parse(l));
  });

  // 1. Send initialize
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 1);

  // 2. Send initialized notification (MUST NOT emit any response per JSON-RPC 2.0 / MCP spec)
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lines.length, 1, "Notification must NOT produce an output line!");

  // 3. Send tools/list
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].id, 2);

  // 4. Send tools/call
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "triangle_list_recipients", arguments: {} } }) + "\n");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lines.length, 3);
  assert.equal(lines[2].id, 3);
  assert.equal(lines[2].result.isError, false);

  input.end();
  await sessionPromise;
});

test("MCP adapter safely handles invalid scalar/null requests and bounds line length", async () => {
  const secret = "test-secret-key-32-bytes-long-1234567890";
  const validator = createTurnCapabilityValidator({ secret });

  const handler = createLocalMessagingMcpHandler({
    client: {},
    credentialValidator: validator,
    turnCredential: "dummy",
    senderId: "desktop-codex",
  });

  // Scalar / null request
  const nullRes = await handler.handleRequest(null);
  assert.equal(nullRes.error.code, -32600);

  const scalarRes = await handler.handleRequest("just a string");
  assert.equal(scalarRes.error.code, -32600);

  // Stdio line length bound test
  const input = new PassThrough();
  const output = new PassThrough();
  const sessionPromise = runMcpStdioSession({ input, output, handler });

  let outData = "";
  output.on("data", (chunk) => { outData += chunk.toString("utf8"); });

  // Send an oversized line > 320 KB
  const oversizedLine = "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"test\",\"text\":\"" + "a".repeat(330 * 1024) + "\"}\n";
  input.write(oversizedLine);
  await new Promise((r) => setTimeout(r, 50));

  input.end();
  await sessionPromise;

  const parsed = JSON.parse(outData.trim());
  assert.equal(parsed.error.code, -32700);
  assert.ok(parsed.error.message.includes("exceeds maximum allowed frame size"));
});

test("MCP adapter supports dynamic per-turn injection seam", async () => {
  const secret = "test-secret-key-32-bytes-long-1234567890";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });

  let dynamicToken = issuer.issue({ senderId: "desktop-codex" });

  const mockClient = {
    discoverRecipients: async () => ["gravity2"],
  };

  const handler = createLocalMessagingMcpHandler({
    client: mockClient,
    credentialValidator: validator,
    turnCredentialProvider: () => dynamicToken, // dynamic provider
    senderId: "desktop-codex",
  });

  const res1 = await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "triangle_list_recipients", arguments: {} },
  });
  assert.equal(res1.result.isError, false);

  // Next turn: dynamic token refreshes
  dynamicToken = issuer.issue({ senderId: "desktop-codex" });
  const res2 = await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "triangle_list_recipients", arguments: {} },
  });
  assert.equal(res2.result.isError, false);
});
