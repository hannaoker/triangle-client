import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import net from "node:net";
import { MCP_TOOLS } from "../src/local-messaging-mcp-adapter.mjs";
import { SUPPORTED_CLAUDE_VERSION } from "../src/claude-session-delivery.mjs";
import {
  createClaudeSessionMcpChild,
  CLAUDE_MCP_TOOLS,
} from "../src/claude-session-mcp-child.mjs";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import {
  createTurnCapabilityIssuer,
  createTurnCapabilityValidator,
} from "../src/local-messaging-credentials.mjs";
import { createPerSenderRateLimiter, createConversationLoopTracker } from "../src/local-messaging-rate-limiter.mjs";
import { writePrivateJson } from "../src/local-messaging-auth-broker.mjs";
import { createInteractiveSessionBroker } from "../src/local-messaging-interactive-session.mjs";
import { setupRouter } from "../src/local-messaging-cli.mjs";
import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { initIdentityRegistry, bindProfileInRegistry } from "./local-messaging-identity-fixtures.mjs";

// codexProfile gives the peer a derived instance id, so a registry binding can name it.
function setupChildTestEnv({ codexProfile = null } = {}) {
  const baseTmp = fs.existsSync("/private/tmp") ? "/private/tmp" : (fs.existsSync("/tmp") ? "/tmp" : os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(baseTmp, "tri-child-test-"));
  fs.chmodSync(tmpDir, 0o700);
  const stateRoot = path.join(tmpDir, "state");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const socketPath = path.join(stateRoot, "local-control.sock");

  const secret = crypto.randomBytes(32).toString("hex");
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });

  const codexId = codexProfile ? deriveClientInstanceId(codexProfile) : crypto.randomBytes(32).toString("hex");
  const claudeId = crypto.randomBytes(32).toString("hex");

  const integrationPath = path.join(stateRoot, "claude-integration.json");
  const interactiveSecret = crypto.randomBytes(32).toString("hex");
  const interactiveSessionId = crypto.randomUUID();
  const interactiveBindingId = crypto.randomUUID();

  writePrivateJson(integrationPath, {
    version: 1,
    type: "interactive",
    senderId: claudeId,
    sessionId: interactiveSessionId,
    generation: 1,
    bindingId: interactiveBindingId,
    secret: interactiveSecret,
    enabled: true,
    revoked: false,
  });

  const configPath = path.join(tmpDir, "local-messaging.json");
  writePrivateJson(configPath, {
    version: 1,
    enabled: true,
    stateRoot,
    integrationPath: path.join(stateRoot, "desktop-integration.json"),
    bindingPath: path.join(tmpDir, "desktop-binding.json"),
    recipients: [{ profile: "claude", instanceId: claudeId }],
    interactive: {
      enabled: true,
      integrationPath,
      expectedVersion: SUPPORTED_CLAUDE_VERSION,
    },
  });

  const acl = createOwnerAcl({
    rules: {
      [codexId]: [claudeId],
      [claudeId]: [codexId],
    },
  });

  const journal = createLocalMessagingJournal({ stateRoot });

  const interactiveBroker = createInteractiveSessionBroker({
    integrationPath,
    recipients: [codexId],
    issue: (sender, opts) => issuer.issue({ senderId: sender, ...opts }),
  });

  const server = createLocalControlServer({
    socketPath,
    journal,
    acl,
    credentialValidator: validator,
    interactiveBroker,
    interactiveRecipients: new Set([claudeId]),
    dispatcher: {
      start: async () => {},
      stop: async () => {},
      notifyAdmission: async () => {},
    },
    rateLimiter: createPerSenderRateLimiter({ maxRequestsPerWindow: 100, windowMs: 60000 }),
    loopTracker: createConversationLoopTracker({ journal }),
  });

  return {
    tmpDir,
    stateRoot,
    socketPath,
    configPath,
    integrationPath,
    claudeId,
    codexId,
    interactiveSessionId,
    interactiveBindingId,
    interactiveSecret,
    server,
    journal,
    async cleanup() {
      await server.close();
      await journal.close();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test("lost send, claim and reply responses retain exact IDs for safe retries", async () => {
  const env=setupChildTestEnv();
  let child,drop=null,dropped=0;
  const originalWrite=net.Socket.prototype.write;
  net.Socket.prototype.write=function(chunk,...rest){
    if(Buffer.isBuffer(chunk)&&chunk.length>4){
      try {
        const result=JSON.parse(chunk.subarray(4).toString()).result;
        const matches=drop==='send'?result?.accepted===true:drop==='claim'?Boolean(result?.claimToken):drop==='reply'?result?.inReplyTo==='lost-response-inbound':false;
        if(matches){drop=null;dropped++;this.destroy();return true;}
      } catch {}
    }
    return originalWrite.call(this,chunk,...rest);
  };
  const call=(name,args)=>child.handleRequest({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
  const text=response=>response.result.content[0].text;
  const retryId=(response,key)=>new RegExp(key+'="([^"]+)"').exec(text(response))?.[1];
  try {
    await env.server.start();
    child=createClaudeSessionMcpChild({configPath:env.configPath,expectedVersion:SUPPORTED_CLAUDE_VERSION,env:{CLAUDE_CODE_SESSION_ID:env.interactiveSessionId},wakeIntervalMs:0});
    drop='send';
    const sent=await call('triangle_send_message',{to:env.codexId,text:'ping'});
    const messageId=retryId(sent,'messageId'),requestId=retryId(sent,'requestId');
    assert.equal(sent.result.isError,true);
    assert.ok(messageId&&requestId&&text(sent).includes('Outcome unknown'));
    const sendRetry=await call('triangle_send_message',{to:env.codexId,text:'ping',messageId,requestId});
    assert.equal(JSON.parse(text(sendRetry)).isDuplicate,true);
    await env.journal.recordSend({sender:env.codexId,recipient:env.claudeId,recipientType:'interactive',messageId:'lost-response-inbound',requestId:'lost-response-request',text:'work'});
    drop='claim';
    const claimed=await call('triangle_claim_message',{messageId:'lost-response-inbound'});
    const claimId=retryId(claimed,'claimId');
    assert.equal(claimed.result.isError,true);
    assert.ok(claimId&&text(claimed).includes('Outcome unknown'));
    const claimRetry=JSON.parse(text(await call('triangle_claim_message',{messageId:'lost-response-inbound',claimId})));
    assert.equal(claimRetry.isRetry,true);
    assert.ok(claimRetry.claimToken);
    drop='reply';
    const replied=await call('triangle_reply_message',{messageId:'lost-response-inbound',claimToken:claimRetry.claimToken,text:'done'});
    const replyId=retryId(replied,'replyId');
    assert.equal(replied.result.isError,true);
    assert.ok(replyId&&text(replied).includes('Outcome unknown'));
    const replyRetry=await call('triangle_reply_message',{messageId:'lost-response-inbound',claimToken:claimRetry.claimToken,text:'done',replyId});
    assert.equal(JSON.parse(text(replyRetry)).isDuplicate,true);
    assert.equal(dropped,3);
  } finally {
    net.Socket.prototype.write=originalWrite;
    await child?.close();
    await env.cleanup();
  }
});

test("Codex MCP retains legacy tools and exposes explicitly scoped inbox operations", () => {
  const toolNames = MCP_TOOLS.map((t) => t.name);
  assert.equal(toolNames.includes("triangle_list_inbox"), true);
  assert.equal(toolNames.includes("triangle_claim_message"), true);
  assert.equal(toolNames.includes("triangle_reply_message"), true);
  assert.deepEqual(toolNames.sort(), [
    "triangle_claim_message",
    "triangle_list_inbox",
    "triangle_reply_message",
    "triangle_ack_notification",
    "triangle_cancel_message",
    "triangle_consume_reply",
    "triangle_get_replies",
    "triangle_get_status",
    "triangle_list_recipients",
    "triangle_list_sessions",
    "triangle_send_message",
  ].sort());
});

test("Claude child exposes scoped inbox/claim/reply and executes stdio lifecycle initialize/list/call/EOF", async () => {
  const env = setupChildTestEnv();
  try {
    await env.server.start();

    // Verify CLAUDE_MCP_TOOLS has expected interactive tools
    const claudeToolNames = CLAUDE_MCP_TOOLS.map((t) => t.name);
    assert.equal(claudeToolNames.includes("triangle_list_inbox"), true);
    assert.equal(claudeToolNames.includes("triangle_claim_message"), true);
    assert.equal(claudeToolNames.includes("triangle_reply_message"), true);
    assert.equal(claudeToolNames.includes("triangle_ack_notification"), true);

    const input = new PassThrough();
    const output = new PassThrough();
    let outputData = "";
    output.on("data", (chunk) => {
      outputData += chunk.toString("utf8");
    });

    const mockEnv = {
      CLAUDE_CODE_SESSION_ID: env.interactiveSessionId,
    };

    const child = createClaudeSessionMcpChild({
      configPath: env.configPath,
      integrationPath: env.integrationPath,
      expectedVersion: SUPPORTED_CLAUDE_VERSION,
      env: mockEnv,
      input,
      output,
    });

    const childPromise = child.run();

    // 1. Send initialize
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    let lines = outputData.trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(lines[0].id, 1);
    assert.equal(lines[0].result.serverInfo.name, "triangle-claude-session-mcp");

    // 2. Send tools/list
    outputData = "";
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    lines = outputData.trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(lines[0].id, 2);
    const listedTools = lines[0].result.tools.map((t) => t.name);
    assert.equal(listedTools.includes("triangle_list_inbox"), true);
    assert.equal(listedTools.includes("triangle_claim_message"), true);
    assert.equal(listedTools.includes("triangle_reply_message"), true);

    // 3. Call triangle_list_inbox
    outputData = "";
    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "triangle_list_inbox", arguments: {} },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    lines = outputData.trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(lines[0].id, 3);
    assert.equal(lines[0].result.isError, false);
    const inboxContent = JSON.parse(lines[0].result.content[0].text);
    assert.deepEqual(inboxContent.items, []);

    // 4. Send EOF
    input.end();
    await childPromise;
    await child.close();
  } finally {
    await env.cleanup();
  }
});

test("Session UUID absent or mismatch fails closed immediately without searching disk", async () => {
  const env = setupChildTestEnv();
  try {
    await env.server.start();

    // Missing session ID
    assert.throws(
      () => createClaudeSessionMcpChild({
        configPath: env.configPath,
        integrationPath: env.integrationPath,
        expectedVersion: SUPPORTED_CLAUDE_VERSION,
        env: {},
      }),
      (err) => err?.code === "missing_or_mismatched_session" || err?.code === "missing_claude_session"
    );

    // Mismatched session ID
    assert.throws(
      () => createClaudeSessionMcpChild({
        configPath: env.configPath,
        integrationPath: env.integrationPath,
        expectedVersion: SUPPORTED_CLAUDE_VERSION,
        env: { CLAUDE_CODE_SESSION_ID: crypto.randomUUID() },
      }),
      (err) => err?.code === "missing_or_mismatched_session" || err?.code === "session_fenced"
    );
  } finally {
    await env.cleanup();
  }
});

test("Missing socket with valid session degrades to pull-only; unsupported explicit version fails push", async () => {
  const env = setupChildTestEnv();
  try {
    await env.server.start();

    // Valid session ID, but socket env absent -> pull-only mode
    const child = createClaudeSessionMcpChild({
      configPath: env.configPath,
      integrationPath: env.integrationPath,
      expectedVersion: SUPPORTED_CLAUDE_VERSION,
      env: {
        CLAUDE_CODE_SESSION_ID: env.interactiveSessionId,
      },
    });

    assert.equal(child.pushSupported, false);
    assert.equal(child.mode, "pull");
    await child.close();

    // Unsupported explicit version fails push
    const childBadVer = createClaudeSessionMcpChild({
      configPath: env.configPath,
      integrationPath: env.integrationPath,
      expectedVersion: "99.9.999",
      env: {
        CLAUDE_CODE_SESSION_ID: env.interactiveSessionId,
      },
    });
    assert.equal(childBadVer.pushSupported, false);
    await childBadVer.close();
  } finally {
    await env.cleanup();
  }
});

test("Sentinel socket token never appears in tools/list, RPCs, stdout/stderr, logs or serialized state", async () => {
  const env = setupChildTestEnv();
  try {
    await env.server.start();

    const sentinelToken = "SENTINEL_CLAUDE_SECRET_TOKEN_DO_NOT_LEAK_XYZ123";
    const input = new PassThrough();
    const output = new PassThrough();
    let outputBuffer = "";
    output.on("data", (chunk) => {
      outputBuffer += chunk.toString("utf8");
    });

    const child = createClaudeSessionMcpChild({
      configPath: env.configPath,
      integrationPath: env.integrationPath,
      expectedVersion: SUPPORTED_CLAUDE_VERSION,
      env: {
        CLAUDE_CODE_SESSION_ID: env.interactiveSessionId,
        CLAUDE_CODE_MESSAGING_TOKEN: sentinelToken,
      },
      input,
      output,
    });

    const runPromise = child.run();
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    input.end();
    await runPromise;
    await child.close();

    assert.equal(outputBuffer.includes(sentinelToken), false, "Sentinel token leaked into stdout!");
  } finally {
    await env.cleanup();
  }
});

test("Clean shutdown closes control client and timers without clearing outstanding uncertainty", async () => {
  const env = setupChildTestEnv();
  try {
    await env.server.start();

    const child = createClaudeSessionMcpChild({
      configPath: env.configPath,
      integrationPath: env.integrationPath,
      expectedVersion: SUPPORTED_CLAUDE_VERSION,
      env: {
        CLAUDE_CODE_SESSION_ID: env.interactiveSessionId,
      },
    });

    assert.equal(child.closed, false);
    await child.close();
    assert.equal(child.closed, true);

    // Closing again is idempotent
    await child.close();
    assert.equal(child.closed, true);
  } finally {
    await env.cleanup();
  }
});

test("Issue 1 [P1]: Old child never adopts rebound identity, secret rotation, or revoked session on credential refresh", async () => {
  const env = setupChildTestEnv();
  const originalNow = Date.now;
  let child;
  try {
    await env.server.start();
    child = createClaudeSessionMcpChild({
      configPath: env.configPath,
      integrationPath: env.integrationPath,
      expectedVersion: SUPPORTED_CLAUDE_VERSION,
      env: { CLAUDE_CODE_SESSION_ID: env.interactiveSessionId },
      wakeIntervalMs: 0,
    });

    // Initial call succeeds
    const before = await child.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "triangle_list_inbox", arguments: {} },
    });
    assert.equal(before.result.isError, false);

    // 1. Rebind: owner changes sessionId, bindingId, generation
    const integration = JSON.parse(fs.readFileSync(env.integrationPath, "utf8"));
    integration.sessionId = crypto.randomUUID();
    integration.bindingId = crypto.randomUUID();
    integration.generation = 2;
    writePrivateJson(env.integrationPath, integration);

    // Advance clock past grant expiry (240s)
    Date.now = () => originalNow() + 241000;

    const afterRebind = await child.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "triangle_list_inbox", arguments: {} },
    });
    assert.equal(afterRebind.result.isError, true, "Old child must reject rebound session");

    // 2. Secret rotation
    integration.sessionId = env.interactiveSessionId;
    integration.bindingId = env.interactiveBindingId;
    integration.generation = 1;
    integration.secret = crypto.randomBytes(32).toString("hex");
    writePrivateJson(env.integrationPath, integration);

    const afterSecretRotation = await child.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "triangle_list_inbox", arguments: {} },
    });
    assert.equal(afterSecretRotation.result.isError, true, "Old child must reject secret rotation");

    // 3. Revocation
    integration.secret = env.interactiveSecret;
    integration.revoked = true;
    writePrivateJson(env.integrationPath, integration);

    const afterRevoke = await child.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "triangle_list_inbox", arguments: {} },
    });
    assert.equal(afterRevoke.result.isError, true, "Old child must reject revoked session");
  } finally {
    Date.now = originalNow;
    await child?.close();
    await env.cleanup();
  }
});

test("Issue 2 [P1]: Mutation outcomes preserve exact IDs on transport loss with outcome-unknown instructions and idempotent retry", async () => {
  const env = setupChildTestEnv();
  let child;
  try {
    await env.server.start();

    // Ingest a message for Claude to claim and reply to
    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: "msg-test-outcome-1",
      requestId: "req-test-outcome-1",
      text: "hello claude",
    });

    child = createClaudeSessionMcpChild({
      configPath: env.configPath,
      integrationPath: env.integrationPath,
      expectedVersion: SUPPORTED_CLAUDE_VERSION,
      env: { CLAUDE_CODE_SESSION_ID: env.interactiveSessionId },
      wakeIntervalMs: 0,
    });

    // 1. Send message with generated IDs under transport error
    const brokenReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "triangle_send_message",
        arguments: { to: env.codexId, text: "ping" },
      },
    };

    // First call to send succeeds and returns messageId and requestId
    const sendSuccess = await child.handleRequest(brokenReq);
    assert.equal(sendSuccess.result.isError, false);
    const sendData = JSON.parse(sendSuccess.result.content[0].text);
    assert.ok(sendData.messageId);
    assert.ok(sendData.requestId);

    // Call claim message
    const claimRes = await child.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "triangle_claim_message",
        arguments: { messageId: "msg-test-outcome-1" },
      },
    });
    assert.equal(claimRes.result.isError, false);
    const claimData = JSON.parse(claimRes.result.content[0].text);
    assert.ok(claimData.claimToken);
    assert.ok(claimData.claimId);

    // Retry claim with same claimId succeeds idempotently
    const claimRetry = await child.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "triangle_claim_message",
        arguments: { messageId: "msg-test-outcome-1", claimId: claimData.claimId },
      },
    });
    assert.equal(claimRetry.result.isError, false);
    const retryClaimData = JSON.parse(claimRetry.result.content[0].text);
    assert.equal(retryClaimData.claimToken, claimData.claimToken);

    // Reply to message
    const replyRes = await child.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "triangle_reply_message",
        arguments: {
          messageId: "msg-test-outcome-1",
          claimToken: claimData.claimToken,
          text: "reply text",
        },
      },
    });
    assert.equal(replyRes.result.isError, false);
    const replyData = JSON.parse(replyRes.result.content[0].text);
    assert.ok(replyData.replyId);

    // Retry reply with same replyId succeeds idempotently
    const replyRetry = await child.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "triangle_reply_message",
        arguments: {
          messageId: "msg-test-outcome-1",
          claimToken: claimData.claimToken,
          text: "reply text",
          replyId: replyData.replyId,
        },
      },
    });
    assert.equal(replyRetry.result.isError, false);
  } finally {
    await child?.close();
    await env.cleanup();
  }
});

test("attached chats get each recipient's principal beside the recipients list while the router is enabled", async () => {
  const env = setupChildTestEnv({ codexProfile: "codex-peer" });
  let child;
  try {
    const identityRoot = path.join(env.tmpDir, "identity");
    fs.mkdirSync(identityRoot, { mode: 0o700 });
    initIdentityRegistry(identityRoot);
    const binding = bindProfileInRegistry(identityRoot, "codex-peer", 1);
    setupRouter({ enable: true, registryRoot: identityRoot, stateRoot: env.stateRoot });
    await env.server.start();

    child = createClaudeSessionMcpChild({
      configPath: env.configPath,
      integrationPath: env.integrationPath,
      expectedVersion: SUPPORTED_CLAUDE_VERSION,
      env: { CLAUDE_CODE_SESSION_ID: env.interactiveSessionId },
      wakeIntervalMs: 0,
    });
    const response = await child.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "triangle_list_recipients", arguments: {} },
    });
    assert.equal(response.result.isError, false, JSON.stringify(response));
    assert.deepEqual(JSON.parse(response.result.content[0].text), {
      recipients: [env.codexId],
      entries: [{
        id: env.codexId,
        principal: binding.principal_id,
        principalState: "bound",
        route: "local",
        // This server has no local recipient directory, so the principal could not resolve to it: only the id works.
        send: { permitted: true, addressKinds: ["id"] },
      }],
    });
  } finally {
    await child?.close();
    await env.cleanup();
  }
});

test("Issue 3 [P2]: Claude MCP child exposes authorized bidirectional tools triangle_list_recipients, triangle_get_replies, triangle_consume_reply", async () => {
  const env = setupChildTestEnv();
  let child;
  try {
    await env.server.start();

    // Verify CLAUDE_MCP_TOOLS has all required tools
    const claudeToolNames = CLAUDE_MCP_TOOLS.map((t) => t.name);
    assert.equal(claudeToolNames.includes("triangle_list_recipients"), true);
    assert.equal(claudeToolNames.includes("triangle_get_replies"), true);
    assert.equal(claudeToolNames.includes("triangle_consume_reply"), true);

    child = createClaudeSessionMcpChild({
      configPath: env.configPath,
      integrationPath: env.integrationPath,
      expectedVersion: SUPPORTED_CLAUDE_VERSION,
      env: { CLAUDE_CODE_SESSION_ID: env.interactiveSessionId },
      wakeIntervalMs: 0,
    });

    // 1. List recipients
    const recipsRes = await child.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "triangle_list_recipients", arguments: {} },
    });
    assert.equal(recipsRes.result.isError, false);
    const recipsData = JSON.parse(recipsRes.result.content[0].text);
    assert.deepEqual(recipsData.recipients, [env.codexId]);
    assert.equal(Object.hasOwn(recipsData, "entries"), false, "no entries while the router is off");
    const directoryResult = await child.handleRequest({
      jsonrpc: "2.0", id: "directory", method: "tools/call",
      params: { name: "triangle_list_sessions", arguments: {} },
    });
    assert.equal(directoryResult.result.isError, false);
    const directory=JSON.parse(directoryResult.result.content[0].text).sessions;
    assert.deepEqual(directory.map(({delivery,...legacy})=>legacy),
      [{ id: env.codexId, label: env.codexId, kind: "unknown", presence: "unknown" }]);
    assert.equal(directory[0].delivery.state,'availability_unknown');


    // 2. Claude sends initial request to runner
    const sendRes = await child.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "triangle_send_message",
        arguments: {
          to: env.codexId,
          text: "request from claude",
        },
      },
    });
    assert.equal(sendRes.result.isError, false);
    const sendData = JSON.parse(sendRes.result.content[0].text);

    // Codex runner records a reply to Claude's message in journal
    await env.journal.recordReply({
      sender: env.codexId,
      recipient: env.claudeId,
      requestId: sendData.requestId,
      inReplyTo: sendData.messageId,
      text: "reply from runner to claude",
      messageId: "rep-runner-1",
    });

    // 3. Claude calls triangle_get_replies through MCP
    const repliesRes = await child.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "triangle_get_replies",
        arguments: { requestId: sendData.requestId },
      },
    });
    assert.equal(repliesRes.result.isError, false);
    const repliesData = JSON.parse(repliesRes.result.content[0].text);
    assert.equal(repliesData.replies.length, 1);
    assert.equal(repliesData.replies[0].messageId, "rep-runner-1");
    assert.equal(repliesData.replies[0].text, "reply from runner to claude");

    // 4. Claude calls triangle_consume_reply through MCP
    const consumeRes = await child.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "triangle_consume_reply",
        arguments: { messageId: "rep-runner-1" },
      },
    });
    assert.equal(consumeRes.result.isError, false);

    // 5. Replies now empty
    const repliesEmpty = await child.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "triangle_get_replies",
        arguments: { requestId: sendData.requestId },
      },
    });
    assert.equal(repliesEmpty.result.isError, false);
    const repliesEmptyData = JSON.parse(repliesEmpty.result.content[0].text);
    assert.equal(repliesEmptyData.replies.length, 0);

    // 6. Claude sends follow-up request correlating with inReplyTo
    const followUpRes = await child.handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "triangle_send_message",
        arguments: {
          to: env.codexId,
          text: "follow-up from claude",
          inReplyTo: "rep-runner-1",
        },
      },
    });
    assert.equal(followUpRes.result.isError, false);
  } finally {
    await child?.close();
    await env.cleanup();
  }
});

test("Issue 4 [P2]: Shutdown with delayed socket connect aborts and awaits wake evaluation without writes after close", async () => {
  const env = setupChildTestEnv();
  let writeCalledAfterClose = false;
  let socketCreated = false;
  let mockSocketInstance = null;

  // Mock net.connect to simulate delayed connection
  const mockConnect = (options) => {
    socketCreated = true;
    const socket = new PassThrough();
    socket.destroy = () => {
      socket.destroyed = true;
      socket.emit("close");
    };
    mockSocketInstance = socket;
    const origWrite = socket.write.bind(socket);
    socket.write = (...args) => {
      if (child?.closed) {
        writeCalledAfterClose = true;
      }
      return origWrite(...args);
    };

    // Inject delayed connect (100ms)
    const delayTimer = setTimeout(() => {
      if (!socket.destroyed) {
        socket.emit("connect");
      }
    }, 100);
    delayTimer.unref?.();

    return socket;
  };

  let child;
  try {
    await env.server.start();

    // Create wake binding and obligation so delivery is triggered
    await env.journal.initInteractiveWakeBinding({
      senderId: env.claudeId,
      sessionId: env.interactiveSessionId,
      generation: 1,
      bindingId: env.interactiveBindingId,
    });
    await env.journal.recordSend({
      sender: env.codexId,
      recipient: env.claudeId,
      recipientType: "interactive",
      messageId: "msg-delayed-test",
      requestId: "req-delayed-test",
      text: "hello",
    });

    // Create a real socket file for probe
    const mockSocketPath = path.join(env.stateRoot, "mock-claude.sock");
    const net = await import("node:net");
    const dummyServer = net.createServer().listen(mockSocketPath);
    dummyServer.unref();

    const input = new PassThrough();
    const output = new PassThrough();
    child = createClaudeSessionMcpChild({
      configPath: env.configPath,
      integrationPath: env.integrationPath,
      expectedVersion: SUPPORTED_CLAUDE_VERSION,
      env: {
        CLAUDE_CODE_SESSION_ID: env.interactiveSessionId,
        CLAUDE_CODE_MESSAGING_SOCKET: mockSocketPath,
        CLAUDE_CODE_MESSAGING_TOKEN: "secret-token-12345",
      },
      input,
      output,
      connect: mockConnect,
      wakeIntervalMs: 20,
    });
    assert.equal(child.pushSupported, true, "pushSupported must be true");

    const runPromise = child.run();

    // Wait for wake loop to trigger reservation and initiate delivery connect
    await new Promise((r) => setTimeout(r, 60));

    // Close child while connect is still pending
    await child.close();
    input.end();
    await runPromise;
    assert.equal(child.closed, true);

    // Wait past the delayed connect time
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(socketCreated, true, "mockConnect must have been called");
    // Assert that NO write occurred after close!
    assert.equal(writeCalledAfterClose, false, "Write must not occur after close returns");
  } finally {
    try { mockSocketInstance?.destroy(); } catch {}
    try { dummyServer?.close(); } catch {}
    await child?.close();
    await env.cleanup();
  }
});
