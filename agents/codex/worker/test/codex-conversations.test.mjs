import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadWorkerConfig,
  main,
  readConversationStore,
} from "../codex-conversations.mjs";

const gatewayUrl = "https://codex.example";
const internalToken = "codex-worker-secret-with-enough-entropy";
const hermesId = "agent_hermes";

function env(storePath) {
  return {
    CODEX_GATEWAY_URL: gatewayUrl,
    CODEX_GATEWAY_INTERNAL_TOKEN: internalToken,
    CODEX_AGENT_ID: "agent_codex",
    CODEX_CONVERSATION_STORE: storePath,
  };
}

function io(input = "") {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    value: {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
      readStdin: async () => input,
    },
  };
}

function response(body, status = 200) {
  return Response.json(body, { status });
}

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-conversations-"));
  return path.join(dir, "conversations.json");
}

test("worker configuration requires only gateway, identity, and durable store settings", () => {
  const config = loadWorkerConfig({
    CODEX_GATEWAY_URL: `${gatewayUrl}/`,
    CODEX_GATEWAY_INTERNAL_TOKEN: internalToken,
    CODEX_AGENT_ID: "agent_codex",
    CODEX_CONVERSATION_STORE: "/tmp/conversations.json",
  });
  assert.deepEqual(config, {
    gatewayUrl,
    internalToken,
    agentId: "agent_codex",
    storePath: "/tmp/conversations.json",
  });
  for (const missing of [
    "CODEX_GATEWAY_URL",
    "CODEX_GATEWAY_INTERNAL_TOKEN",
    "CODEX_AGENT_ID",
    "CODEX_CONVERSATION_STORE",
  ]) {
    const values = {
      CODEX_GATEWAY_URL: gatewayUrl,
      CODEX_GATEWAY_INTERNAL_TOKEN: internalToken,
      CODEX_AGENT_ID: "agent_codex",
      CODEX_CONVERSATION_STORE: "/tmp/conversations.json",
    };
    delete values[missing];
    assert.throws(() => loadWorkerConfig(values), new RegExp(`${missing} is required`));
  }
});

test("conversation-start sends the first task and atomically persists a private ledger", async () => {
  const storePath = await tempStore();
  const consoleIo = io('{"text":"Hello Hermes"}');
  const requests = [];
  const exitCode = await main(
    ["conversation-start", "--recipient-id", hermesId],
    consoleIo.value,
    {
      env: env(storePath),
      now: () => new Date("2026-07-31T09:00:00.000Z"),
      createId: (prefix) => `${prefix}_fixed`,
      fetchImpl: async (request) => {
        requests.push(request);
        return response({
          peer: { id: hermesId, name: "Hermes" },
          task: {
            id: "task_1",
            contextId: "context_1",
            status: { state: "TASK_STATE_SUBMITTED" },
          },
        });
      },
    },
  );
  assert.equal(exitCode, 0);
  const output = JSON.parse(consoleIo.stdout.join(""));
  assert.equal(output.conversationId, "conversation_fixed");
  assert.equal(output.taskId, "task_1");
  const sent = await requests[0].json();
  assert.deepEqual(sent, {
    operation: "send",
    recipient_agent_id: hermesId,
    message_id: "message_fixed",
    text: "Hello Hermes",
  });
  assert.equal(requests[0].headers.get("authorization"), `Bearer ${internalToken}`);

  const store = await readConversationStore(storePath);
  const conversation = store.conversations.conversation_fixed;
  assert.equal(conversation.contextId, "context_1");
  assert.equal(conversation.turns[0].taskId, "task_1");
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
});

test("conversation-poll renews through the gateway and records a peer reply idempotently", async () => {
  const storePath = await tempStore();
  const startIo = io('{"text":"Hello Hermes"}');
  let taskState = "TASK_STATE_SUBMITTED";
  const fetchImpl = async (request) => {
    const body = await request.json();
    if (body.operation === "send") {
      return response({
        peer: { id: hermesId, name: "Hermes" },
        task: {
          id: "task_1",
          contextId: "context_1",
          status: { state: "TASK_STATE_SUBMITTED" },
        },
      });
    }
    return response({
      peer: { id: hermesId, name: "Hermes" },
      task: {
        id: "task_1",
        contextId: "context_1",
        status: {
          state: taskState,
          message:
            taskState === "TASK_STATE_COMPLETED"
              ? {
                  messageId: "reply_1",
                  taskId: "task_1",
                  contextId: "context_1",
                  role: "ROLE_AGENT",
                  parts: [{ text: "Hello Codex" }],
                }
              : undefined,
        },
      },
    });
  };
  await main(
    ["conversation-start", "--recipient-id", hermesId],
    startIo.value,
    {
      env: env(storePath),
      createId: (prefix) => `${prefix}_fixed`,
      fetchImpl,
    },
  );
  taskState = "TASK_STATE_COMPLETED";
  for (let count = 0; count < 2; count += 1) {
    const pollIo = io();
    assert.equal(
      await main(
        ["conversation-poll", "--conversation-id", "conversation_fixed"],
        pollIo.value,
        { env: env(storePath), fetchImpl },
      ),
      0,
    );
  }
  const turn =
    (await readConversationStore(storePath)).conversations.conversation_fixed
      .turns[0];
  assert.equal(turn.status, "TASK_STATE_COMPLETED");
  assert.deepEqual(turn.responses, [
    { messageId: "reply_1", role: "ROLE_AGENT", text: "Hello Codex" },
  ]);
});

test("conversation-send reuses context but creates a distinct task after terminal completion", async () => {
  const storePath = await tempStore();
  let sendCount = 0;
  const requests = [];
  const fetchImpl = async (request) => {
    const body = await request.json();
    requests.push(body);
    if (body.operation === "get_task") {
      return response({
        peer: { id: hermesId, name: "Hermes" },
        task: {
          id: "task_1",
          contextId: "context_1",
          status: { state: "TASK_STATE_COMPLETED" },
        },
      });
    }
    sendCount += 1;
    return response({
      peer: { id: hermesId, name: "Hermes" },
      task: {
        id: `task_${sendCount}`,
        contextId: "context_1",
        status: { state: "TASK_STATE_SUBMITTED" },
      },
    });
  };
  await main(
    ["conversation-start", "--recipient-id", hermesId],
    io('{"text":"First turn"}').value,
    {
      env: env(storePath),
      createId: (prefix) => `${prefix}_${sendCount + 1}`,
      fetchImpl,
    },
  );
  await main(
    ["conversation-poll", "--conversation-id", "conversation_1"],
    io().value,
    { env: env(storePath), fetchImpl },
  );
  const sendIo = io('{"text":"Second turn"}');
  assert.equal(
    await main(
      ["conversation-send", "--conversation-id", "conversation_1"],
      sendIo.value,
      {
        env: env(storePath),
        createId: (prefix) => `${prefix}_2`,
        fetchImpl,
      },
    ),
    0,
  );
  const sent = requests.at(-1);
  assert.equal(sent.context_id, "context_1");
  assert.equal(sent.message_id, "message_2");
  assert.equal("task_id" in sent, false);
  const conversation =
    (await readConversationStore(storePath)).conversations.conversation_1;
  assert.equal(conversation.turns.length, 2);
  assert.notEqual(conversation.turns[0].taskId, conversation.turns[1].taskId);
});

test("conversation-send refuses a new turn while the prior task is nonterminal", async () => {
  const storePath = await tempStore();
  await main(
    ["conversation-start", "--recipient-id", hermesId],
    io('{"text":"First"}').value,
    {
      env: env(storePath),
      createId: (prefix) => `${prefix}_1`,
      fetchImpl: async () =>
        response({
          peer: { id: hermesId, name: "Hermes" },
          task: {
            id: "task_1",
            contextId: "context_1",
            status: { state: "TASK_STATE_SUBMITTED" },
          },
        }),
    },
  );
  let calls = 0;
  const sendIo = io('{"text":"Too soon"}');
  assert.equal(
    await main(
      ["conversation-send", "--conversation-id", "conversation_1"],
      sendIo.value,
      {
        env: env(storePath),
        fetchImpl: async () => {
          calls += 1;
          throw new Error("must not fetch");
        },
      },
    ),
    1,
  );
  assert.equal(calls, 0);
  assert.match(sendIo.stderr.join(""), /not terminal/);
});

test("conversation-show is local-only and malformed secret-bearing arguments are rejected", async () => {
  const storePath = await tempStore();
  await main(
    ["conversation-start", "--recipient-id", hermesId],
    io('{"text":"First"}').value,
    {
      env: env(storePath),
      createId: (prefix) => `${prefix}_1`,
      fetchImpl: async () =>
        response({
          peer: { id: hermesId, name: "Hermes" },
          task: {
            id: "task_1",
            contextId: "context_1",
            status: { state: "TASK_STATE_SUBMITTED" },
          },
        }),
    },
  );
  const showIo = io();
  assert.equal(
    await main(
      ["conversation-show", "--conversation-id", "conversation_1"],
      showIo.value,
      {
        env: env(storePath),
        fetchImpl: async () => assert.fail("show must not fetch"),
      },
    ),
    0,
  );
  assert.equal(JSON.parse(showIo.stdout.join("")).id, "conversation_1");
  const invalidIo = io("not-json");
  assert.equal(
    await main(
      ["conversation-start", "--recipient-id", hermesId, "secret"],
      invalidIo.value,
      {
        env: env(storePath),
        fetchImpl: async () => assert.fail("invalid CLI must not fetch"),
      },
    ),
    2,
  );
  assert.doesNotMatch(invalidIo.stderr.join(""), /secret|not-json/);
});

test("worker template declares mailbox selectors without exposing credentials to the conversation runner", async () => {
  const [source, template, packageJson] = await Promise.all([
    readFile(new URL("../codex-conversations.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ]);
  for (const key of [
    "MESH_ORIGIN",
    "MESH_AGENT_TOKEN",
    "CODEX_GATEWAY_URL",
    "CODEX_GATEWAY_INTERNAL_TOKEN",
    "CODEX_AGENT_ID",
    "CODEX_CONVERSATION_STORE",
  ]) {
    assert.match(template, new RegExp(`^${key}=$`, "m"));
  }
  assert.doesNotMatch(
    source,
    /MESH_AGENT_TOKEN|OPENAI|ANTHROPIC|GOOGLE_API_KEY|mesh_[A-Za-z0-9_-]{12,}/,
  );
  assert.match(
    JSON.parse(packageJson).scripts.worker,
    /--env-file-if-exists=worker\/\.env\.local/,
  );
});
