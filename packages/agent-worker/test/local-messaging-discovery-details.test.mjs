import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createLocalMessagingMcpHandler } from "../src/local-messaging-mcp-adapter.mjs";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import { createTurnCapabilityIssuer, createTurnCapabilityValidator } from "../src/local-messaging-credentials.mjs";
import {
  createPerSenderRateLimiter,
  createConversationLoopTracker,
  createPairExchangeLimiter,
} from "../src/local-messaging-rate-limiter.mjs";
import { setupRouter, setupLocalMessaging } from "../src/local-messaging-cli.mjs";
import { createInstalledLocalMessagingHost } from "../src/local-messaging-host.mjs";
import { createProfiledReasonerGate } from "../src/concurrency-gate.mjs";
import { writePrivateJson, readPrivateJson } from "../src/local-messaging-auth-broker.mjs";
import {
  encodeFrame,
  createMessageParser,
  createSuccessResponse,
  PROTOCOL_VERSION,
} from "../src/local-messaging-protocol.mjs";
import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { initIdentityRegistry, bindProfileInRegistry } from "./local-messaging-identity-fixtures.mjs";

// discover_recipients carries the legacy `recipients` list plus, while the identity router is enabled, `entries`
// ({ id, principal }). The client must hand both to the agent without ever widening what the host authorized.

const SENDER = "a".repeat(64);
const BOB = deriveClientInstanceId("bob");
const CHARLIE = deriveClientInstanceId("charlie");
const DAVE = deriveClientInstanceId("dave");
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/local-messaging-cli.mjs", import.meta.url));

function privateTmp(prefix) {
  const base = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// A host that answers every discover_recipients call with a fixed payload, however malformed.
async function withFakeHost(payload, run) {
  const dir = privateTmp("tri-disc-");
  const socketPath = path.join(dir, "host.sock");
  const server = net.createServer((socket) => {
    const parser = createMessageParser({
      onMessage: (message) => socket.write(encodeFrame(createSuccessResponse(message.id, payload))),
    });
    socket.on("data", (chunk) => parser.feed(chunk));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = createLocalControlClient({ socketPath, senderId: SENDER, turnCredential: "opaque" });
  try {
    return await run(client);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// One RPC without the client, to see exactly what the server sends.
function rawRpc(socketPath, { method, credential, senderId }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const parser = createMessageParser({
      onMessage: (message) => {
        socket.destroy();
        if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
        else resolve(message.result);
      },
      onError: (err) => {
        socket.destroy();
        reject(err);
      },
    });
    socket.on("data", (chunk) => parser.feed(chunk));
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(encodeFrame({ protocol_version: PROTOCOL_VERSION, id: "raw-1", method, params: {}, credential, senderId }));
    });
  });
}

// A real server: SENDER may message bob and charlie. The registry binds `bound` profiles (dave is bound but not
// authorized for SENDER); the router is on only when `enabled`.
async function withServer({ registry = true, bound = [], enabled = false }, run) {
  const dir = privateTmp("tri-disc-srv-");
  const stateRoot = path.join(dir, "state");
  const identityRoot = path.join(dir, "identity");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(identityRoot, { mode: 0o700 });
  const bindings = {};
  if (registry) {
    initIdentityRegistry(identityRoot);
    bound.forEach((profile, index) => {
      bindings[profile] = bindProfileInRegistry(identityRoot, profile, index + 1);
    });
  }
  if (enabled) setupRouter({ enable: true, registryRoot: identityRoot, stateRoot });
  const secret = "test-secret-32-bytes-long-1234567890";
  const journal = createLocalMessagingJournal({ stateRoot });
  const socketPath = path.join(stateRoot, "local-control.sock");
  const server = createLocalControlServer({
    socketPath,
    journal,
    acl: createOwnerAcl({ rules: { [SENDER]: [BOB, CHARLIE] } }),
    credentialValidator: createTurnCapabilityValidator({ secret }),
    dispatcher: { start() {}, stop() {}, notifyAdmission() {} },
    statusProvider: async () => ({ ok: true, version: 1 }),
    rateLimiter: createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 }),
    loopTracker: createConversationLoopTracker({ maxLoopDepth: 10, journal }),
    pairExchangeLimiter: createPairExchangeLimiter({ maxPairExchanges: 10, windowMs: 5000, journal }),
    stateRoot,
    recipientDirectory: [
      { id: BOB, label: "bob", kind: "worker" },
      { id: CHARLIE, label: "charlie", kind: "worker" },
    ],
  });
  await server.start();
  const credential = createTurnCapabilityIssuer({ secret }).issue({ senderId: SENDER });
  const client = createLocalControlClient({ socketPath, senderId: SENDER, turnCredential: credential });
  try {
    return await run({ client, socketPath, credential, bindings });
  } finally {
    await client.close();
    await server.close();
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function callListRecipients(client, credential) {
  const handler = createLocalMessagingMcpHandler({ client, turnCredential: credential });
  const response = await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "triangle_list_recipients", arguments: {} },
  });
  assert.equal(response.result.isError, false, JSON.stringify(response));
  return response.result.content[0].text;
}

test("discoverRecipientDetails passes on only the id and principal of authorized recipients", async () => {
  const cases = [
    {
      name: "router disabled or an older host: no entries",
      payload: { recipients: ["a", "b"] },
      expected: { recipients: ["a", "b"] },
    },
    {
      name: "well-formed entries pass through in order",
      payload: { recipients: ["a", "b"], entries: [{ id: "a", principal: "agent_1" }, { id: "b", principal: null }] },
      expected: { recipients: ["a", "b"], entries: [{ id: "a", principal: "agent_1" }, { id: "b", principal: null }] },
    },
    {
      name: "extra fields are dropped",
      payload: { recipients: ["a"], entries: [{ id: "a", principal: "agent_1", secret: "s", label: "display" }] },
      expected: { recipients: ["a"], entries: [{ id: "a", principal: "agent_1" }] },
    },
    {
      name: "an entry for an id that is not a listed recipient is dropped",
      payload: { recipients: ["a"], entries: [{ id: "a", principal: null }, { id: "zzz", principal: "agent_9" }] },
      expected: { recipients: ["a"], entries: [{ id: "a", principal: null }] },
    },
    {
      name: "a duplicate id keeps the first entry",
      payload: { recipients: ["a"], entries: [{ id: "a", principal: "agent_1" }, { id: "a", principal: "agent_2" }] },
      expected: { recipients: ["a"], entries: [{ id: "a", principal: "agent_1" }] },
    },
    {
      name: "malformed entries are dropped, valid ones kept",
      payload: {
        recipients: ["a", "b", "c"],
        entries: [null, "x", 7, { id: "a" }, { id: "b", principal: 7 }, { id: "b", principal: "" }, { id: 5, principal: null }, { id: "c", principal: null }],
      },
      expected: { recipients: ["a", "b", "c"], entries: [{ id: "c", principal: null }] },
    },
    {
      name: "entries that are not a list stay absent",
      payload: { recipients: ["a"], entries: "agent_1" },
      expected: { recipients: ["a"] },
    },
    {
      name: "nothing usable stays absent instead of looking like an empty list",
      payload: { recipients: ["a"], entries: [{ id: "zzz", principal: null }] },
      expected: { recipients: ["a"] },
    },
    {
      name: "no recipients with an empty entries list is kept",
      payload: { recipients: [], entries: [] },
      expected: { recipients: [], entries: [] },
    },
    {
      name: "missing recipients read as an empty list",
      payload: {},
      expected: { recipients: [] },
    },
  ];
  for (const { name, payload, expected } of cases) {
    await withFakeHost(payload, async (client) => {
      assert.deepEqual(await client.discoverRecipientDetails(), expected, name);
    });
  }
});

test("discoverRecipients keeps returning the plain recipients array", async () => {
  await withFakeHost({ recipients: ["a", "b"], entries: [{ id: "a", principal: "agent_1" }] }, async (client) => {
    assert.deepEqual(await client.discoverRecipients(), ["a", "b"]);
  });
});

test("router enabled: the server sends one {id, principal} per authorized recipient and the client and bound MCP pass it on", async () => {
  await withServer({ bound: ["bob", "dave"], enabled: true }, async ({ client, socketPath, credential, bindings }) => {
    const principals = { [BOB]: bindings.bob.principal_id, [CHARLIE]: null };
    const authorized = await client.discoverRecipients();
    assert.deepEqual([...authorized].sort(), [BOB, CHARLIE].sort());
    const entries = authorized.map((id) => ({ id, principal: principals[id] }));

    const raw = await rawRpc(socketPath, { method: "discover_recipients", credential, senderId: SENDER });
    assert.deepEqual(raw, { recipients: authorized, entries });
    assert.deepEqual(await client.discoverRecipientDetails(), { recipients: authorized, entries });
    const text = await callListRecipients(client, credential);
    assert.deepEqual(JSON.parse(text), { recipients: authorized, entries });

    // dave is bound in the registry but not authorized for this sender: nothing about him is visible.
    for (const output of [JSON.stringify(raw), text]) {
      assert.ok(!output.includes(DAVE) && !output.includes(bindings.dave.principal_id), output);
    }
  });
});

test("router disabled: no entries anywhere and the recipients list is unchanged", async () => {
  await withServer({ bound: ["bob"], enabled: false }, async ({ client, socketPath, credential }) => {
    const authorized = await client.discoverRecipients();
    assert.deepEqual([...authorized].sort(), [BOB, CHARLIE].sort());
    const raw = await rawRpc(socketPath, { method: "discover_recipients", credential, senderId: SENDER });
    assert.deepEqual(raw, { recipients: authorized });
    assert.deepEqual(await client.discoverRecipientDetails(), { recipients: authorized });
    assert.deepEqual(JSON.parse(await callListRecipients(client, credential)), { recipients: authorized });
  });
});

test("router enabled but registry absent: principal is null (none known now), never a guess", async () => {
  await withServer({ registry: false, enabled: true }, async ({ client }) => {
    const details = await client.discoverRecipientDetails();
    assert.equal(details.entries.length, details.recipients.length);
    assert.deepEqual(details.entries.map((entry) => entry.principal), details.recipients.map(() => null));
    assert.deepEqual(details.entries.map((entry) => entry.id), details.recipients);
  });
});

test("CLI discover keeps recipients and adds entries only while the router is enabled", async () => {
  const root = fs.mkdtempSync("/private/tmp/tri-disc-cli-");
  const configPath = path.join(root, "local.json");
  const bindingPath = path.join(root, "binding.json");
  let host;
  try {
    writePrivateJson(bindingPath, { instanceId: "a".repeat(64), threadId: "thread-disc", enabled: false });
    setupLocalMessaging({ config: configPath, "desktop-binding": bindingPath, "thread-id": "thread-disc", recipients: ["gravity2"] });
    const config = readPrivateJson(configPath);
    const recipient = config.recipients[0].instanceId;
    host = createInstalledLocalMessagingHost({
      configPath,
      runners: new Map([[recipient, { run: async () => ({ status: "completed", text: "ok" }) }]]),
      gate: createProfiledReasonerGate(),
    });
    await host.start();
    const run = async (args) => JSON.parse((await exec(process.execPath, [cli, ...args, "--config", configPath])).stdout);

    const before = await run(["discover"]);
    assert.deepEqual(before.recipients, [recipient]);
    assert.equal(Object.hasOwn(before, "entries"), false);

    const identityRoot = path.join(root, "identity");
    fs.mkdirSync(identityRoot, { mode: 0o700 });
    initIdentityRegistry(identityRoot);
    const binding = bindProfileInRegistry(identityRoot, "gravity2", 1);
    setupRouter({ enable: true, registryRoot: identityRoot, stateRoot: config.stateRoot });

    const after = await run(["discover"]);
    assert.deepEqual(after.recipients, [recipient]);
    assert.deepEqual(after.entries, [{ id: recipient, principal: binding.principal_id }]);
  } finally {
    await host?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
