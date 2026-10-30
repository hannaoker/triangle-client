import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import {
  createLocalMessagingMcpHandler,
  runMcpStdioSession,
} from "../src/local-messaging-mcp-adapter.mjs";
import { createLocalMessagingSubsystem } from "../src/local-messaging-supervisor-seam.mjs";
import { createTestMemoryJournal, createTestRecoverableDispatcher } from "./local-messaging-fixtures.mjs";
import { createTurnCapabilityIssuer } from "../src/local-messaging-credentials.mjs";

test("MCP adapter lists tools and handles initialize", async () => {
  const secret = "test-secret-key-32-bytes-long-1234567890";
  const issuer = createTurnCapabilityIssuer({ secret });
  const token = issuer.issue({ senderId: "desktop-codex" });

  const mockClient = {
    discoverRecipientDetails: async () => ({ recipients: ["gravity2"] }),
    sendMessage: async () => ({ accepted: true, messageId: "msg-1", status: "queued_local" }),
    getMessageStatus: async () => ({ messageId: "msg-1", phase: "queued_local" }),
    listReplies: async () => [],
    consumeReply: async () => ({ consumed: true }),
    cancelMessage: async () => ({ status: "unsupported" }),
  };

  const handler = createLocalMessagingMcpHandler({
    client: mockClient,
    turnCredential: token,
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
  const token = issuer.issue({ senderId: "desktop-codex" });

  const mockClient = {
    discoverRecipientDetails: async () => ({ recipients: ["gravity2"] }),
  };

  const handler = createLocalMessagingMcpHandler({
    client: mockClient,
    turnCredential: token,
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
  const handler = createLocalMessagingMcpHandler({
    client: {},
    turnCredential: "dummy",
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

  let dynamicToken = issuer.issue({ senderId: "desktop-codex" });

  const mockClient = {
    discoverRecipientDetails: async () => ({ recipients: ["gravity2"] }),
  };

  const handler = createLocalMessagingMcpHandler({
    client: mockClient,
    turnCredentialProvider: () => dynamicToken, // dynamic provider
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

test("triangle_send_message returns its IDs on success and failure so a retry is an idempotent duplicate", { skip: process.platform === "win32" }, async () => {
  const stateRoot = fs.mkdtempSync("/private/tmp/lm-mcp-");
  const journal = createTestMemoryJournal();
  const dispatcher = createTestRecoverableDispatcher({ journal });
  const subsystem = createLocalMessagingSubsystem({
    stateRoot, journal, dispatcher, registry: ["sender", "gravity2"], aclRules: { sender: ["gravity2"] },
  });
  let client;
  try {
    await subsystem.start();
    client = subsystem.createClient("sender");
    // The first send is admitted but its response is lost on the way back.
    let loseNextResponse = true;
    const flakyClient = {
      ...client,
      sendMessage: async (params, options) => {
        const receipt = await client.sendMessage(params, options);
        if (loseNextResponse) {
          loseNextResponse = false;
          throw Object.assign(new Error("Socket connection closed"), { code: "disconnected" });
        }
        return receipt;
      },
    };
    const handler = createLocalMessagingMcpHandler({
      client: flakyClient, turnCredentialProvider: () => subsystem.issueTurnCredential("sender"),
    });
    const call = (args, id = 1) => handler.handleRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "triangle_send_message", arguments: args } });

    // The error names the IDs to retry with and says the outcome is unknown.
    const lost = await call({ to: "gravity2", text: "merge PR 42" });
    assert.equal(lost.result.isError, true);
    const errorText = lost.result.content[0].text;
    const messageId = /messageId="([A-Za-z0-9._:-]+)"/.exec(errorText)?.[1];
    const requestId = /requestId="([A-Za-z0-9._:-]+)"/.exec(errorText)?.[1];
    assert.ok(messageId && requestId, errorText);
    assert.match(errorText, /outcome unknown/i);
    assert.ok(await journal.getRecord(messageId), "the lost response had in fact been admitted");

    // Retrying with the returned IDs is a duplicate: it never runs the work twice.
    const retry = await call({ to: "gravity2", text: "merge PR 42", messageId, requestId }, 2);
    assert.equal(retry.result.isError, false);
    const receipt = JSON.parse(retry.result.content[0].text);
    assert.equal(receipt.isDuplicate, true);
    assert.equal(receipt.messageId, messageId);
    assert.equal(receipt.requestId, requestId);
    assert.equal(dispatcher.dispatched.length, 1);

    // A fresh send generates IDs and returns them in the success result.
    const fresh = JSON.parse((await call({ to: "gravity2", text: "another task" }, 3)).result.content[0].text);
    assert.match(fresh.messageId, /^[0-9a-f-]{36}$/);
    assert.match(fresh.requestId, /^[0-9a-f-]{36}$/);
    assert.notEqual(fresh.messageId, messageId);
    assert.equal(fresh.isDuplicate, false);
    assert.equal(dispatcher.dispatched.length, 2);

    // A definitive rejection still reports the IDs but does not claim an unknown outcome.
    const refused = await call({ to: "not-an-allowed-recipient", text: "x" }, 4);
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /messageId="[A-Za-z0-9._:-]+" requestId="[A-Za-z0-9._:-]+"/);
    assert.doesNotMatch(refused.result.content[0].text, /outcome unknown/i);
    assert.equal(dispatcher.dispatched.length, 2);

    // The tool contract tells the model to reuse the IDs when retrying.
    const send = (await handler.handleRequest({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }))
      .result.tools.find((tool) => tool.name === "triangle_send_message");
    assert.match(send.description, /retry/i);
    assert.match(send.description, /messageId/);
    assert.match(send.inputSchema.properties.messageId.description, /retry/i);
    assert.match(send.inputSchema.properties.requestId.description, /retry/i);
  } finally {
    await client?.close();
    await subsystem.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("the adapter never holds or consults a credential validator: the server validates every RPC", async () => {
  // A validator holds the HMAC secret, so an agent-side process that could call one could mint credentials.
  const validator = { validate() { throw new Error("the adapter process must not validate credentials"); } };
  let forwarded;
  const handler = createLocalMessagingMcpHandler({
    client: { discoverRecipientDetails: async (options) => { forwarded = options; return { recipients: ["gravity2"] }; } },
    credentialValidator: validator,
    turnCredential: "opaque-token-validated-by-the-server",
  });
  const response = await handler.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "triangle_list_recipients", arguments: {} } });
  assert.equal(response.result.isError, false, JSON.stringify(response));
  assert.deepEqual(forwarded, { credential: "opaque-token-validated-by-the-server" });
  // A missing credential is still refused locally, before any RPC.
  const none = createLocalMessagingMcpHandler({ client: {} });
  const refused = await none.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "triangle_list_recipients", arguments: {} } });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /missing injected turn credential/);
});

test("triangle_list_recipients returns the host's entries beside recipients and omits them when the host sent none", async () => {
  const entries = [{ id: "gravity2", principal: "agent_0123456789abcdef0123456789abcdef" }];
  const listed = async (details) => {
    const handler = createLocalMessagingMcpHandler({
      client: { discoverRecipientDetails: async () => details },
      turnCredential: "mock-token",
    });
    const response = await handler.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "triangle_list_recipients", arguments: {} } });
    assert.equal(response.result.isError, false, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  };
  assert.deepEqual(await listed({ recipients: ["gravity2"], entries }), { recipients: ["gravity2"], entries });
  assert.deepEqual(await listed({ recipients: ["gravity2"] }), { recipients: ["gravity2"] });
});

test("triangle_ack_notification calls client.ackNotification and returns result", async () => {
  let ackedArgs;
  const mockClient = {
    ackNotification: async (args, options) => {
      ackedArgs = { args, options };
      return { acknowledged: true, wakeId: args.wakeId, generation: args.generation };
    },
  };
  const handler = createLocalMessagingMcpHandler({
    client: mockClient,
    turnCredential: "mock-token",
  });
  const res = await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "triangle_ack_notification",
      arguments: { wakeId: "wake-test-mcp", generation: 3 },
    },
  });
  assert.equal(res.result.isError, false);
  const data = JSON.parse(res.result.content[0].text);
  assert.equal(data.acknowledged, true);
  assert.equal(data.wakeId, "wake-test-mcp");
  assert.equal(data.generation, 3);
  assert.deepEqual(ackedArgs.args, { wakeId: "wake-test-mcp", generation: 3 });
  assert.deepEqual(ackedArgs.options, { credential: "mock-token" });
});

test("directory tool forwards the active credential and fails visibly on an older server", async () => {
  const entry = { id: "gravity2", label: "Antigravity", kind: "worker", presence: "unknown" };
  let seen;
  const handler = createLocalMessagingMcpHandler({
    client: { listSessions: async options => { seen = options; return [entry]; } },
    turnCredentialProvider: () => "active-credential",
  });
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "triangle_list_sessions" } };
  const result = await handler.handleRequest(request);
  assert.equal(result.result.isError, false);
  assert.deepEqual(JSON.parse(result.result.content[0].text), { sessions: [entry] });
  assert.deepEqual(seen, { credential: "active-credential" });
  const older = createLocalMessagingMcpHandler({
    client: { listSessions: async () => { throw Object.assign(new Error("Unsupported directory method"), { code: "method_not_found" }); } },
    turnCredential: "credential",
  });
  assert.equal((await older.handleRequest(request)).result.isError, true);
});

test("triangle_get_status takes an optional messageId: none asks only for this conversation's own view, never the host status", async () => {
  const calls = [];
  const client = {
    sessionStatus: async (options) => {
      calls.push(["sessionStatus", options]);
      return { route: "same-device", senderId: "desktop-codex", inbox: { queued: 1, executing: 0, held: 0 } };
    },
    getMessageStatus: async (params, options) => {
      calls.push(["getMessageStatus", params, options]);
      return { messageId: params.messageId, phase: "queued_local" };
    },
    localStatus: async () => { throw new Error("the MCP tool must never ask for the host status"); },
  };
  const handler = createLocalMessagingMcpHandler({ client, turnCredential: "mock-token" });
  const request = (id, method, params) => handler.handleRequest({ jsonrpc: "2.0", id, method, params });

  const listed = await request(1, "tools/list", {});
  const status = listed.result.tools.find((tool) => tool.name === "triangle_get_status");
  assert.equal(status.inputSchema.required, undefined, "messageId is optional");
  assert.equal(status.inputSchema.properties.messageId.type, "string");

  const own = await request(2, "tools/call", { name: "triangle_get_status", arguments: {} });
  assert.equal(own.result.isError, false, JSON.stringify(own));
  assert.deepEqual(JSON.parse(own.result.content[0].text).inbox, { queued: 1, executing: 0, held: 0 });
  const message = await request(3, "tools/call", { name: "triangle_get_status", arguments: { messageId: "msg-1" } });
  assert.deepEqual(JSON.parse(message.result.content[0].text), { messageId: "msg-1", phase: "queued_local" });
  assert.deepEqual(calls, [
    ["sessionStatus", { credential: "mock-token" }],
    ["getMessageStatus", { messageId: "msg-1" }, { credential: "mock-token" }],
  ]);
  await request(4, "tools/call", { name: "triangle_get_status", arguments: { messageId: "" } });
  assert.deepEqual(calls[2], ["getMessageStatus", { messageId: "" }, { credential: "mock-token" }], "an empty ID goes to the server to be refused, not to the own view");
});

test("an older server without session_status makes the no-argument status fail visibly instead of answering with host status", async () => {
  const handler = createLocalMessagingMcpHandler({
    client: {
      sessionStatus: async () => { throw Object.assign(new Error("Unsupported method"), { code: "method_not_found" }); },
      localStatus: async () => ({ journal: { held: 7 } }),
    },
    turnCredential: "credential",
  });
  const res = await handler.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "triangle_get_status", arguments: {} } });
  assert.equal(res.result.isError, true);
  assert.doesNotMatch(res.result.content[0].text, /journal/);
});
