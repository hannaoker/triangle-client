/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const protocol = require("../src/protocol.cjs");
const {
  A2A_PROTOCOL_VERSION,
  MESH_PROFILE_PATH,
  buildAgentCard,
  createMeshPeerIntrospector,
  createProtocolHandler,
} = protocol;

test("protocol exposes only the bridge projection surface", () => {
  assert.deepEqual(Object.keys(protocol).sort(), [
    "A2A_PROTOCOL_VERSION",
    "DEFAULT_LIMITS",
    "MESH_PROFILE_PATH",
    "buildAgentCard",
    "createMeshPeerIntrospector",
    "createProtocolHandler",
    "preflightProtocolRequest",
  ]);
});

test("local file-state compatibility validates without importing protocol internals", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/state-store.cjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /require\(["']\.\/protocol\.cjs["']\)/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "triangle-state-"));
  try {
    const { createStateStore } = require("../src/state-store.cjs");
    const store = createStateStore({ directory });
    assert.deepEqual(store.state, { inbox: [], tasks: {} });
    assert.doesNotThrow(() => store.save(store.state));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const origin = "http://localhost:3002";
const meshOrigin = "http://localhost:3000";
const profileUri = `${meshOrigin}${MESH_PROFILE_PATH}`;
const now = "2026-07-29T12:00:00.000Z";
const sender = {
  id: "agent-sender",
  name: "Sender",
  endpointUrl: "https://sender.example.com/a2a",
};
const invalidRawValues = [
  "A",
  "%%%not-base64%%%",
  "AQ=I",
  "AQI==",
  "+_",
];

function request(method, params, id = "request-1") {
  return { jsonrpc: "2.0", id, method, params };
}

function userMessage(overrides = {}) {
  return {
    messageId: "message-1",
    contextId: "context-1",
    role: "ROLE_USER",
    parts: [{ text: "Please inspect the repository." }],
    ...overrides,
  };
}

function taskMessage(taskId = "task-1", overrides = {}) {
  return userMessage({ taskId, contextId: "context-1", ...overrides });
}

function harness(overrides = {}) {
  const inbox = overrides.inbox || [];
  const tasks = overrides.tasks || {};
  const idCounts = {};
  let introspectionCalls = 0;
  const handler = createProtocolHandler({
    meshOrigin,
    getProofNonce: () => "registration-secret",
    recipientAgentId: "agent_11111111111111111111111111111111",
    bridge: {
      sendMessage: async () => assert.fail("unexpected bridge send"),
      getTask: async () => assert.fail("unexpected bridge get"),
      listTasks: async () => assert.fail("unexpected bridge list"),
    },
    inbox,
    tasks,
    now: () => new Date(now),
    createId: (prefix) => {
      idCounts[prefix] = (idCounts[prefix] || 0) + 1;
      return `${prefix}-${idCounts[prefix]}`;
    },
    saveInbox: () => {},
    saveTasks: () => {},
    saveState: () => {},
    introspectPeerToken: async (token) => {
      introspectionCalls += 1;
      assert.equal(token, "mesh_peer_secret");
      return {
        active: true,
        sender,
        audience_agent_id: "agent_11111111111111111111111111111111",
        scopes: ["a2a.send"],
        expires_at: "2026-07-29T12:05:00.000Z",
      };
    },
    ...overrides,
  });
  return {
    handler,
    inbox,
    tasks,
    introspectionCalls: () => introspectionCalls,
  };
}

async function peerCall(handler, body, overrides = {}) {
  return handler({
    request: body,
    version: A2A_PROTOCOL_VERSION,
    extensions: "",
    authorization: "Bearer mesh_peer_secret",
    ...overrides,
  });
}

test("protocol construction requires a canonical bridge projection", () => {
  const legacyInbox = [];
  const legacyTasks = {};
  assert.throws(
    () => createProtocolHandler({
      meshOrigin,
      getProofNonce: () => "registration-secret",
      inbox: legacyInbox,
      tasks: legacyTasks,
      saveState: () => assert.fail("legacy state must not be persisted"),
      waitForTask: () => assert.fail("legacy tasks must not be awaited"),
      introspectPeerToken: async () => ({ active: true, sender }),
      createId: () => "legacy-id",
    }),
    /bridge is required/,
  );
  assert.deepEqual(legacyInbox, []);
  assert.deepEqual(legacyTasks, {});

  const bridge = {
    sendMessage: async () => ({}),
    getTask: async () => ({}),
    listTasks: async () => ({ tasks: [], nextCursor: null }),
  };
  for (const recipientAgentId of [undefined, "", "agent-codex", "agent_ABCDEF0123456789abcdef0123456789"]) {
    assert.throws(
      () => createProtocolHandler({ bridge, recipientAgentId }),
      /recipientAgentId must be canonical/,
    );
  }
});

test("builds the canonical A2A 1.0 JSONRPC Agent Card with the optional MESH profile", () => {
  const card = buildAgentCard({ origin, meshOrigin });

  assert.equal(card.supportedInterfaces.length, 1);
  assert.deepEqual(card.supportedInterfaces[0], {
    url: `${origin}/api/v1`,
    protocolBinding: "JSONRPC",
    protocolVersion: "1.0",
  });
  assert.deepEqual(card.capabilities.extensions, [
    { uri: profileUri, required: false },
  ]);
});

test("rejects missing or unsupported A2A versions with VersionNotSupportedError", async () => {
  const { handler, introspectionCalls } = harness();

  for (const version of [undefined, "", "0.3", "1.1"]) {
    const response = await handler({
      request: request("SendMessage", { message: userMessage() }),
      version,
      authorization: "Bearer mesh_peer_secret",
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, -32009);
    assert.equal(response.body.error.message, "VersionNotSupportedError");
    assert.equal("data" in response.body.error, false);
  }
  assert.equal(introspectionCalls(), 0);
});

test("requires every JSON-RPC request to have a non-null string or finite integer id", async () => {
  const { handler, introspectionCalls } = harness();
  for (const id of [undefined, null, {}, 1.5, Number.POSITIVE_INFINITY]) {
    const body = request("ListTasks", {}, id);
    if (id === undefined) delete body.id;
    const response = await peerCall(handler, body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, -32600);
    assert.equal(response.body.id, null);
  }
  assert.equal(introspectionCalls(), 0);
});

test("allows only the nonce-bound MESH registration probe without authentication", async () => {
  const { handler, inbox, tasks, introspectionCalls } = harness();
  const response = await handler({
    request: request("SendMessage", {
      message: userMessage({
        parts: [{ text: "MESH registration conformance probe" }],
        metadata: {
          mesh: {
            type: "registration-conformance",
            registrationNonce: "registration-secret",
          },
        },
        extensions: [profileUri],
      }),
    }),
    version: "1.0",
    extensions: profileUri,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.result.message.role, "ROLE_AGENT");
  assert.equal(response.body.result.message.contextId, "context-1");
  assert.equal(response.body.result.message.parts[0].text, "MESH conformance verified");
  assert.equal(inbox.length, 0);
  assert.deepEqual(tasks, {});
  assert.equal(introspectionCalls(), 0);
});

test("requires the exact MESH probe message shape for unauthenticated conformance", async () => {
  const { handler } = harness({
    introspectPeerToken: async () => assert.fail("missing credentials must not be introspected"),
  });
  const registrationMessage = userMessage({
    parts: [{ text: "MESH registration conformance probe" }],
    metadata: {
      mesh: {
        type: "registration-conformance",
        registrationNonce: "registration-secret",
      },
    },
    extensions: [profileUri],
  });

  for (const [message, extensions] of [
    [{ ...registrationMessage, role: "ROLE_AGENT" }, profileUri],
    [{ ...registrationMessage, extensions: [] }, profileUri],
    [{ ...registrationMessage, parts: [{ text: "almost" }] }, profileUri],
    [
      {
        ...registrationMessage,
        parts: [
          { text: "MESH registration conformance probe" },
          { text: "extra" },
        ],
      },
      profileUri,
    ],
    [
      {
        ...registrationMessage,
        metadata: {
          mesh: {
            type: "registration-conformance",
            registrationNonce: "wrong-secret",
          },
        },
      },
      profileUri,
    ],
    [registrationMessage, ""],
  ]) {
    const response = await handler({
      request: request("SendMessage", { message }),
      version: "1.0",
      extensions,
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, -32000);
  }
});

test("introspects only peer tickets with the gateway permanent credential", async () => {
  const calls = [];
  const introspect = createMeshPeerIntrospector({
    meshOrigin,
    agentToken: "mesh_codex_permanent",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          active: true,
          sender,
          audience_agent_id: "agent-codex",
          scopes: ["a2a.send"],
          expires_at: "2026-07-29T12:05:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(await introspect("mesh_permanent_from_caller"), null);
  assert.equal(calls.length, 0);

  const result = await introspect("mesh_peer_secret");
  assert.equal(result.sender.id, sender.id);
  assert.equal(calls[0].url, `${meshOrigin}/api/v1/peer-tokens/introspect`);
  assert.equal(
    new Headers(calls[0].init.headers).get("authorization"),
    "Bearer mesh_codex_permanent",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    peer_token: "mesh_peer_secret",
  });
});

test("peer introspection aborts at its deadline and rejects oversized JSON", async () => {
  let sawAbort = false;
  const aborting = createMeshPeerIntrospector({
    meshOrigin,
    agentToken: "mesh_codex_permanent",
    deadlineMs: 5,
    fetchImpl: async (_url, init) => {
      if (!init.signal) {
        return new Response(
          JSON.stringify({
            active: true,
            sender,
            audience_agent_id: "agent-codex",
            scopes: ["a2a.send"],
          }),
        );
      }
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      });
    },
  });
  assert.equal(await aborting("mesh_peer_secret"), null);
  assert.equal(sawAbort, true);

  const oversized = createMeshPeerIntrospector({
    meshOrigin,
    agentToken: "mesh_codex_permanent",
    maxResponseBytes: 64,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          active: true,
          sender,
          audience_agent_id: "agent-codex",
          scopes: ["a2a.send"],
          padding: "x".repeat(100),
        }),
      ),
  });
  assert.equal(await oversized("mesh_peer_secret"), null);
});

test("the localhost retired routes are rejected before A2A dispatch", () => {
  const card = buildAgentCard({ origin, meshOrigin });
  const serverSource = fs.readFileSync(
    new URL("../src/server.cjs", `file://${__filename}`),
    "utf8",
  );

  assert.equal(JSON.stringify(card).includes("/internal/tasks/update"), false);
  assert.match(serverSource, /RETIRED_PATHS\.has\(url\.pathname\)/);
  assert.doesNotMatch(serverSource, /url\.pathname === "\/internal\/tasks\/update"/);
  assert.match(serverSource, /new AbortController\(\)/);
  assert.match(serverSource, /signal: requestAbort\.signal/);
});

test("mailbox projection mode delegates all task methods without mutable gateway state", async () => {
  const calls = [];
  const bridge = {
    async sendMessage(input) {
      calls.push(["send", input]);
      return { id: "task-bridge", contextId: "context-1", status: { state: "TASK_STATE_SUBMITTED" } };
    },
    async getTask(input) {
      calls.push(["get", input]);
      return { id: input.taskId, contextId: "context-1", status: { state: "TASK_STATE_COMPLETED" } };
    },
    async listTasks(input) {
      calls.push(["list", input]);
      return { tasks: [], nextCursor: "next" };
    },
  };
  const handler = createProtocolHandler({
    meshOrigin,
    recipientAgentId: "agent_11111111111111111111111111111111",
    getProofNonce: () => "registration-secret",
    introspectPeerToken: async () => ({
      active: true,
      sender,
      audience_agent_id: "agent_11111111111111111111111111111111",
    }),
    createId: (prefix) => `${prefix}-1`,
    bridge,
  });

  const sent = await peerCall(handler, request("SendMessage", {
    message: userMessage(),
    configuration: { returnImmediately: true },
  }));
  const got = await peerCall(handler, request("GetTask", { id: "task-bridge" }));
  const listed = await peerCall(handler, request("ListTasks", { pageSize: 12, pageToken: "cursor" }));

  assert.equal(sent.body.result.task.id, "task-bridge");
  assert.equal(got.body.result.id, "task-bridge");
  assert.deepEqual(listed.body.result, { tasks: [], nextPageToken: "next" });
  assert.deepEqual(calls.map(([method]) => method), ["send", "get", "list"]);
  assert.equal(calls[0][1].peerToken, "mesh_peer_secret");
  assert.equal(calls[0][1].message.text, "Please inspect the repository.");
  assert.deepEqual(calls[2][1], { senderAgentId: "agent-sender", limit: 12, after: "cursor" });
});

test("mailbox SendMessage derives one deterministic context across races and handler instances", async () => {
  const calls = [];
  const bridge = {
    async sendMessage(input) {
      calls.push(input);
      return {
        id: input.message.taskId || "task-bridge",
        contextId: input.message.contextId,
        status: { state: "TASK_STATE_SUBMITTED" },
      };
    },
    async getTask() { throw new Error("unused"); },
    async listTasks() { throw new Error("unused"); },
  };
  const makeHandler = (createId) => createProtocolHandler({
    meshOrigin,
    recipientAgentId: "agent_11111111111111111111111111111111",
    getProofNonce: () => "registration-secret",
    introspectPeerToken: async () => ({
      active: true,
      sender,
      audience_agent_id: "agent_11111111111111111111111111111111",
    }),
    createId,
    bridge,
  });
  const handler = makeHandler(() => "context_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const secondHandler = makeHandler(() => "context_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const withoutContext = userMessage();
  delete withoutContext.contextId;

  const [first, replay, crossInstance] = await Promise.all([
    peerCall(handler, request("SendMessage", {
      message: withoutContext,
      configuration: { returnImmediately: true },
    })),
    peerCall(handler, request("SendMessage", {
      message: withoutContext,
      configuration: { returnImmediately: true },
    }, "request-2")),
    peerCall(secondHandler, request("SendMessage", {
      message: withoutContext,
      configuration: { returnImmediately: true },
    }, "request-3")),
  ]);
  const explicit = await peerCall(handler, request("SendMessage", {
    message: userMessage({ contextId: "Context-Byte_Identical" }),
    configuration: { returnImmediately: true },
  }, "request-4"));

  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(crossInstance.status, 200);
  assert.equal(explicit.status, 200);
  assert.equal(calls[0].message.contextId, "context_db4b8dd4210cdc6169debb384e923878");
  assert.equal(calls[1].message.contextId, calls[0].message.contextId);
  assert.equal(calls[2].message.contextId, calls[0].message.contextId);
  assert.equal(calls[3].message.contextId, "Context-Byte_Identical");
  assert.equal(calls[0].message.messageId, "message-1");
  assert.equal(calls[0].message.text, "Please inspect the repository.");
  assert.equal("contextId" in withoutContext, false);
});

test("missing-context derivation separates sender and message ID", async () => {
  const contexts = [];
  const makeHandler = (peer) => createProtocolHandler({
    meshOrigin,
    recipientAgentId: "agent_11111111111111111111111111111111",
    getProofNonce: () => "registration-secret",
    introspectPeerToken: async () => ({
      active: true,
      sender: peer,
      audience_agent_id: "agent_11111111111111111111111111111111",
    }),
    createId: () => "context_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    bridge: {
      async sendMessage(input) {
        contexts.push(input.message.contextId);
        return { id: "task", contextId: input.message.contextId, status: { state: "TASK_STATE_SUBMITTED" } };
      },
      async getTask() { throw new Error("unused"); },
      async listTasks() { throw new Error("unused"); },
    },
  });
  const first = userMessage();
  delete first.contextId;
  const second = userMessage({ messageId: "message-2" });
  delete second.contextId;
  await peerCall(makeHandler(sender), request("SendMessage", { message: first, configuration: { returnImmediately: true } }));
  await peerCall(makeHandler({ ...sender, id: "agent-other" }), request("SendMessage", { message: first, configuration: { returnImmediately: true } }));
  await peerCall(makeHandler(sender), request("SendMessage", { message: second, configuration: { returnImmediately: true } }));
  assert.deepEqual(contexts, [
    "context_db4b8dd4210cdc6169debb384e923878",
    "context_89a6f22521231caacbeb2a6f89adc8ef",
    "context_529dfa742e5a19166a666c766cc10e78",
  ]);
  assert.equal(new Set(contexts).size, 3);
});

test("missing-context allocation has no side effect before auth and audience validation", async () => {
  let allocations = 0;
  let bridgeCalls = 0;
  const makeHandler = (credential) => createProtocolHandler({
    meshOrigin,
    recipientAgentId: "agent_11111111111111111111111111111111",
    getProofNonce: () => "registration-secret",
    introspectPeerToken: async () => credential,
    createId: () => { allocations += 1; return "context_valid"; },
    bridge: {
      sendMessage: async () => { bridgeCalls += 1; },
      getTask: async () => { bridgeCalls += 1; },
      listTasks: async () => { bridgeCalls += 1; },
    },
  });
  const message = userMessage();
  delete message.contextId;
  const body = request("SendMessage", {
    message,
    configuration: { returnImmediately: true },
  });

  const unauthenticated = await makeHandler(null)({
    request: body,
    version: A2A_PROTOCOL_VERSION,
    extensions: "",
  });
  const wrongAudience = await peerCall(makeHandler({
    active: true,
    sender,
    audience_agent_id: "agent_other",
  }), body);

  assert.equal(unauthenticated.status, 401);
  assert.equal(wrongAudience.status, 403);
  assert.equal(allocations, 0);
  assert.equal(bridgeCalls, 0);
});

test("mailbox projection rejects a peer ticket issued for another audience", async () => {
  let calls = 0;
  const handler = createProtocolHandler({
    meshOrigin,
    recipientAgentId: "agent_11111111111111111111111111111111",
    getProofNonce: () => "registration-secret",
    introspectPeerToken: async () => ({
      active: true,
      sender,
      audience_agent_id: "agent-other",
    }),
    createId: (prefix) => `${prefix}-1`,
    bridge: {
      sendMessage: async () => { calls += 1; },
      getTask: async () => { calls += 1; },
      listTasks: async () => { calls += 1; },
    },
  });
  const result = await peerCall(handler, request("GetTask", { id: "task-bridge" }));
  assert.equal(result.status, 403);
  assert.equal(calls, 0);
});

test("mailbox SendMessage waits through bounded projections unless explicitly immediate", async () => {
  let getCalls = 0;
  const bridge = {
    sendMessage: async () => ({
      id: "task-wait",
      contextId: "context-1",
      status: { state: "TASK_STATE_SUBMITTED" },
    }),
    getTask: async () => {
      getCalls += 1;
      return {
        id: "task-wait",
        contextId: "context-1",
        status: { state: "TASK_STATE_COMPLETED" },
      };
    },
    listTasks: async () => ({ tasks: [], nextCursor: null }),
  };
  const makeHandler = () => createProtocolHandler({
    meshOrigin,
    recipientAgentId: "agent_11111111111111111111111111111111",
    bridge,
    getProofNonce: () => "registration-secret",
    introspectPeerToken: async () => ({ active: true, sender, audience_agent_id: "agent_11111111111111111111111111111111" }),
    createId: (prefix) => `${prefix}-1`,
    bridgeWaitTimeoutMs: 100,
    bridgeWaitPollMs: 1,
  });
  const waited = await peerCall(makeHandler(), request("SendMessage", {
    message: userMessage(),
    configuration: { returnImmediately: false },
  }));
  assert.equal(waited.body.result.task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(getCalls, 1);
  getCalls = 0;
  const immediate = await peerCall(makeHandler(), request("SendMessage", {
    message: userMessage(),
    configuration: { returnImmediately: true },
  }));
  assert.equal(immediate.body.result.task.status.state, "TASK_STATE_SUBMITTED");
  assert.equal(getCalls, 0);
});

test("mailbox projection wait deadline bounds a stalled task read", async () => {
  const handler = createProtocolHandler({
    meshOrigin,
    recipientAgentId: "agent_11111111111111111111111111111111",
    bridge: {
      sendMessage: async () => ({ id: "task-wait", contextId: "context-1", status: { state: "TASK_STATE_SUBMITTED" } }),
      getTask: async () => new Promise((resolve) => setTimeout(() => resolve({
        id: "task-wait",
        contextId: "context-1",
        status: { state: "TASK_STATE_COMPLETED" },
      }), 20)),
      listTasks: async () => ({ tasks: [], nextCursor: null }),
    },
    getProofNonce: () => "registration-secret",
    introspectPeerToken: async () => ({ active: true, sender, audience_agent_id: "agent_11111111111111111111111111111111" }),
    createId: (prefix) => `${prefix}-1`,
    bridgeWaitTimeoutMs: 5,
    bridgeWaitPollMs: 1,
  });
  const result = await peerCall(handler, request("SendMessage", { message: userMessage() }));
  assert.equal(result.status, 504);
  assert.equal(result.body.error.message, "Task did not complete before deadline");
});

test("mailbox task projections honor history and context filters without skipping cursor matches", async () => {
  const listCalls = [];
  const handler = createProtocolHandler({
    meshOrigin,
    recipientAgentId: "agent_11111111111111111111111111111111",
    bridge: {
      sendMessage: async () => { throw new Error("unused"); },
      getTask: async () => ({ id: "task", contextId: "context-1", history: [1, 2], status: { state: "TASK_STATE_COMPLETED" } }),
      listTasks: async (input) => {
        listCalls.push(input);
        return {
          tasks: [{ id: "match", contextId: "context-1", history: [1, 2, 3] }],
          nextCursor: "c2",
        };
      },
    },
    getProofNonce: () => "registration-secret",
    introspectPeerToken: async () => ({ active: true, sender, audience_agent_id: "agent_11111111111111111111111111111111" }),
    createId: (prefix) => `${prefix}-1`,
  });
  const got = await peerCall(handler, request("GetTask", { id: "task", historyLength: 0 }));
  assert.equal("history" in got.body.result, false);
  const listed = await peerCall(handler, request("ListTasks", {
    contextId: "context-1",
    historyLength: 1,
    pageSize: 1,
  }));
  assert.deepEqual(listed.body.result.tasks.map((task) => task.id), ["match"]);
  assert.deepEqual(listed.body.result.tasks[0].history, [3]);
  assert.equal(listed.body.result.nextPageToken, "c2");
  assert.equal(listCalls.length, 1);
  assert.deepEqual(listCalls[0], {
    senderAgentId: "agent-sender",
    contextId: "context-1",
    limit: 1,
  });
});
