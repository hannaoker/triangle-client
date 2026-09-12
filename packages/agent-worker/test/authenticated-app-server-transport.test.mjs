import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SHARED_CODEX_ADAPTER_VERSION,
  createAuthenticatedAppServerTransport,
  createCapabilityTokenAuthResolver,
  createScriptedAuthHandshakeSocket,
  createSharedCodexSession,
  validateBinding,
} from "../src/shared-codex-app-server.mjs";

const instanceId = "a".repeat(64);
const agentId = "agent_codex_desktop_001";
const serverIdentity = "codex-app-server/ws-auth";
const endpoint = "ws://127.0.0.1:9999/rpc";
const authorization = "Bearer capability-token-for-tests-only";

function sampleBinding(overrides = {}) {
  return validateBinding({
    adapterVersion: SHARED_CODEX_ADAPTER_VERSION,
    enabled: true,
    installationId: "inst_N7VhDq3mQ2",
    instanceId,
    agentId,
    roomScope: "room_test_scope",
    serverIdentity,
    endpoint,
    threadId: "01a06f9f-2db1-7143-b8b9-08c634cc7999",
    ...overrides,
  });
}

test("capability token auth resolver reads file and rejects mesh secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "triangle-ws-auth-"));
  const tokenFile = path.join(root, "ws.token");
  await writeFile(tokenFile, "codex-ws-capability-token\n", "utf8");
  const resolver = createCapabilityTokenAuthResolver({
    serverIdentity,
    tokenFile,
  });
  const auth = await resolver.resolveAuth();
  assert.equal(auth.authorization, "Bearer codex-ws-capability-token");
  assert.equal(auth.serverIdentity, serverIdentity);

  await writeFile(tokenFile, "mesh_watch_ABCDEFGHijklmnop\n", "utf8");
  await assert.rejects(
    () => resolver.resolveAuth(),
    (error) => error.code === "secret_leak_rejected",
  );

  assert.throws(
    () => createCapabilityTokenAuthResolver({
      serverIdentity,
      tokenFile,
      tokenEnv: "CODEX_APP_SERVER_WS_TOKEN",
    }),
    /exactly one/,
  );
});

test("scripted auth handshake rejects missing Authorization", async () => {
  const openSocket = createScriptedAuthHandshakeSocket({
    expectedAuthorization: authorization,
    serverIdentity,
  });
  const transport = createAuthenticatedAppServerTransport({
    endpoint,
    openSocket,
    awaitAuthenticatedHello: true,
    async resolveAuth() {
      return { authorization: "Bearer wrong-token", serverIdentity };
    },
  });
  await assert.rejects(
    () => transport.connect(),
    (error) => error.code === "websocket_auth_rejected",
  );
});

test("authenticated WS connect returns serverIdentity without initialize serverInfo.name", async () => {
  const openSocket = createScriptedAuthHandshakeSocket({
    expectedAuthorization: authorization,
    serverIdentity,
    // Realistic live Codex initialize payload: no serverInfo.name.
    initializeResult: {
      userAgent: "codex_cli_rs/0.153.0",
      platformFamily: "unix",
      platformOs: "linux",
    },
  });
  const transport = createAuthenticatedAppServerTransport({
    endpoint,
    openSocket,
    awaitAuthenticatedHello: true,
    async resolveAuth() {
      return { authorization, serverIdentity };
    },
  });

  const connected = await transport.connect();
  assert.equal(connected.connected, true);
  assert.equal(connected.serverIdentity, serverIdentity);
  assert.equal(transport.serverIdentity, serverIdentity);

  const initialize = await transport.call("initialize", {
    clientInfo: { name: "triangle-test", version: "1" },
  });
  assert.equal(initialize.serverInfo?.name, undefined);
  await transport.notify("initialized", {});
  await transport.close();
});

test("session connects via authenticated WS when initialize omits serverInfo.name", async () => {
  const binding = sampleBinding();
  const openSocket = createScriptedAuthHandshakeSocket({
    expectedAuthorization: authorization,
    serverIdentity: binding.serverIdentity,
    initializeResult: { userAgent: "codex_cli_rs/test" },
  });
  const transport = createAuthenticatedAppServerTransport({
    endpoint: binding.endpoint,
    openSocket,
    awaitAuthenticatedHello: true,
    async resolveAuth() {
      return { authorization, serverIdentity: binding.serverIdentity };
    },
  });
  const session = createSharedCodexSession({ binding, transport });
  const status = await session.connect();
  assert.equal(status.status, "subscribed");
  assert.equal(status.serverIdentity, binding.serverIdentity);

  const started = await session.startTurn({
    deliveryId: "delivery_ws_1",
    input: [{ type: "text", text: "Reply WAKE_OK" }],
  });
  const turn = await session.waitForTurn(started.turn.id);
  assert.equal(turn.status, "completed");
  await session.shutdown();
});

test("identity mismatch still fails closed with authenticated WS transport", async () => {
  const binding = sampleBinding({ serverIdentity: "expected-server" });
  const openSocket = createScriptedAuthHandshakeSocket({
    expectedAuthorization: authorization,
    serverIdentity: "different-server",
    initializeResult: {},
  });
  const transport = createAuthenticatedAppServerTransport({
    endpoint: binding.endpoint,
    openSocket,
    awaitAuthenticatedHello: true,
    async resolveAuth() {
      return { authorization, serverIdentity: "different-server" };
    },
  });
  const session = createSharedCodexSession({ binding, transport });
  await assert.rejects(
    () => session.connect(),
    (error) =>
      error.code === "server_identity_mismatch"
      && error.expected === "expected-server"
      && error.actual === "different-server",
  );
  assert.equal(session.status().status, "disconnected");
});

test("capability-token path uses resolveAuth identity without hello", async () => {
  const openSocket = createScriptedAuthHandshakeSocket({
    expectedAuthorization: authorization,
    serverIdentity,
    emitServerHello: false,
    initializeResult: {},
  });
  const transport = createAuthenticatedAppServerTransport({
    endpoint,
    openSocket,
    awaitAuthenticatedHello: false,
    async resolveAuth() {
      return { authorization, serverIdentity };
    },
  });
  const connected = await transport.connect();
  assert.equal(connected.serverIdentity, serverIdentity);
  await transport.close();
});
