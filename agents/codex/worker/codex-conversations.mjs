#!/usr/bin/env node

import crypto from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STORE_VERSION = 1;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TERMINAL_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

export class WorkerRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "WorkerRequestError";
    this.status = status;
  }
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function gatewayUrl(value) {
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("CODEX_GATEWAY_URL must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

export function loadWorkerConfig(env = process.env) {
  const storePath = required(env, "CODEX_CONVERSATION_STORE");
  if (!path.isAbsolute(storePath)) {
    throw new TypeError("CODEX_CONVERSATION_STORE must be an absolute path");
  }
  return {
    gatewayUrl: gatewayUrl(required(env, "CODEX_GATEWAY_URL")),
    internalToken: required(env, "CODEX_GATEWAY_INTERNAL_TOKEN"),
    agentId: required(env, "CODEX_AGENT_ID"),
    storePath,
  };
}

function emptyStore() {
  return { version: STORE_VERSION, conversations: {} };
}

function validateStore(value) {
  if (
    !value ||
    value.version !== STORE_VERSION ||
    !value.conversations ||
    typeof value.conversations !== "object" ||
    Array.isArray(value.conversations)
  ) {
    throw new TypeError("Conversation store is invalid");
  }
  return value;
}

export async function readConversationStore(storePath) {
  try {
    return validateStore(JSON.parse(await readFile(storePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    if (error instanceof SyntaxError) {
      throw new TypeError("Conversation store is invalid");
    }
    throw error;
  }
}

async function writeConversationStore(storePath, store) {
  validateStore(store);
  const directory = path.dirname(storePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, storePath);
  await chmod(storePath, 0o600);
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new WorkerRequestError("Gateway response is too large", response.status);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new WorkerRequestError("Gateway response is too large", response.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkerRequestError("Gateway returned invalid JSON", response.status);
  }
}

async function gatewayRequest(config, action, fetchImpl) {
  const response = await fetchImpl(
    new Request(`${config.gatewayUrl}/internal/a2a/outbound`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.internalToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(action),
    }),
  );
  const payload = await readBoundedJson(response);
  if (!response.ok) {
    throw new WorkerRequestError(
      `Gateway request failed with status ${response.status}`,
      response.status,
    );
  }
  if (!payload?.task?.id || !payload.task.contextId || !payload.task.status?.state) {
    throw new WorkerRequestError("Gateway returned an invalid task", response.status);
  }
  return payload;
}

function parseInput(text) {
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) {
    throw new TypeError("Input exceeds the 64 KiB limit");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("Input must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Input must be a JSON object");
  }
  if (typeof value.text !== "string" || !value.text.trim() || value.text.trim().length > 10_000) {
    throw new TypeError("text is required and must be 10,000 characters or fewer");
  }
  return { text: value.text.trim() };
}

async function readInput(io) {
  return parseInput((await io.readStdin()).trim());
}

function responseMessages(task) {
  const candidates = [
    ...(Array.isArray(task.history) ? task.history : []),
    task.status?.message,
  ].filter(Boolean);
  const seen = new Set();
  const messages = [];
  for (const message of candidates) {
    if (
      message.role !== "ROLE_AGENT" ||
      typeof message.messageId !== "string" ||
      seen.has(message.messageId)
    ) {
      continue;
    }
    const text = Array.isArray(message.parts)
      ? message.parts
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .filter(Boolean)
          .join("\n")
      : "";
    if (!text) continue;
    seen.add(message.messageId);
    messages.push({ messageId: message.messageId, role: message.role, text });
  }
  return messages;
}

function conversation(store, conversationId) {
  const value = store.conversations[conversationId];
  if (!value) throw new TypeError(`Conversation ${conversationId} was not found`);
  return value;
}

function argument(argv, command, flag) {
  return argv[0] === command &&
    argv.length === 3 &&
    argv[1] === flag &&
    argv[2]
    ? argv[2]
    : null;
}

function usage() {
  return [
    "Usage:",
    "  codex-conversations conversation-start --recipient-id <agent_id>  # JSON from stdin",
    "  codex-conversations conversation-poll --conversation-id <id>",
    "  codex-conversations conversation-send --conversation-id <id>      # JSON from stdin",
    "  codex-conversations conversation-show --conversation-id <id>",
    "",
  ].join("\n");
}

async function readStdinBounded(stream = process.stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_INPUT_BYTES) throw new TypeError("Input exceeds the 64 KiB limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(
  argv = process.argv.slice(2),
  io = {
    stdout: process.stdout,
    stderr: process.stderr,
    readStdin: () => readStdinBounded(),
  },
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    createId = (prefix) => `${prefix}_${crypto.randomUUID()}`,
    now = () => new Date(),
  } = {},
) {
  const invalid = () => {
    io.stderr.write(usage());
    return 2;
  };
  try {
    const config = loadWorkerConfig(env);
    const recipientId = argument(
      argv,
      "conversation-start",
      "--recipient-id",
    );
    if (recipientId) {
      const input = await readInput(io);
      const conversationId = createId("conversation");
      const messageId = createId("message");
      const sent = await gatewayRequest(
        config,
        {
          operation: "send",
          recipient_agent_id: recipientId,
          message_id: messageId,
          text: input.text,
        },
        fetchImpl,
      );
      const timestamp = now().toISOString();
      const store = await readConversationStore(config.storePath);
      store.conversations[conversationId] = {
        id: conversationId,
        localAgentId: config.agentId,
        recipient: sent.peer,
        contextId: sent.task.contextId,
        createdAt: timestamp,
        updatedAt: timestamp,
        turns: [
          {
            messageId,
            taskId: sent.task.id,
            text: input.text,
            status: sent.task.status.state,
            sentAt: timestamp,
            responses: responseMessages(sent.task),
          },
        ],
      };
      await writeConversationStore(config.storePath, store);
      io.stdout.write(
        `${JSON.stringify({
          conversationId,
          contextId: sent.task.contextId,
          taskId: sent.task.id,
          status: sent.task.status.state,
        })}\n`,
      );
      return 0;
    }

    const pollId = argument(
      argv,
      "conversation-poll",
      "--conversation-id",
    );
    if (pollId) {
      const store = await readConversationStore(config.storePath);
      const current = conversation(store, pollId);
      const turn = current.turns.at(-1);
      const result = await gatewayRequest(
        config,
        {
          operation: "get_task",
          recipient_agent_id: current.recipient.id,
          task_id: turn.taskId,
        },
        fetchImpl,
      );
      turn.status = result.task.status.state;
      turn.responses = responseMessages(result.task);
      turn.polledAt = now().toISOString();
      current.updatedAt = turn.polledAt;
      await writeConversationStore(config.storePath, store);
      io.stdout.write(
        `${JSON.stringify({
          conversationId: current.id,
          contextId: current.contextId,
          taskId: turn.taskId,
          status: turn.status,
          responses: turn.responses,
        })}\n`,
      );
      return 0;
    }

    const sendId = argument(
      argv,
      "conversation-send",
      "--conversation-id",
    );
    if (sendId) {
      const store = await readConversationStore(config.storePath);
      const current = conversation(store, sendId);
      const prior = current.turns.at(-1);
      if (!TERMINAL_STATES.has(prior.status)) {
        throw new TypeError("Previous conversation turn is not terminal");
      }
      const input = await readInput(io);
      const messageId = createId("message");
      const sent = await gatewayRequest(
        config,
        {
          operation: "send",
          recipient_agent_id: current.recipient.id,
          message_id: messageId,
          context_id: current.contextId,
          text: input.text,
        },
        fetchImpl,
      );
      if (sent.task.contextId !== current.contextId) {
        throw new WorkerRequestError("Peer changed the conversation context", 502);
      }
      const timestamp = now().toISOString();
      current.turns.push({
        messageId,
        taskId: sent.task.id,
        text: input.text,
        status: sent.task.status.state,
        sentAt: timestamp,
        responses: responseMessages(sent.task),
      });
      current.updatedAt = timestamp;
      await writeConversationStore(config.storePath, store);
      io.stdout.write(
        `${JSON.stringify({
          conversationId: current.id,
          contextId: current.contextId,
          taskId: sent.task.id,
          status: sent.task.status.state,
        })}\n`,
      );
      return 0;
    }

    const showId = argument(
      argv,
      "conversation-show",
      "--conversation-id",
    );
    if (showId) {
      const store = await readConversationStore(config.storePath);
      io.stdout.write(`${JSON.stringify(conversation(store, showId))}\n`);
      return 0;
    }
    return invalid();
  } catch (error) {
    io.stderr.write(
      `${error instanceof WorkerRequestError ? `Gateway request failed${error.status ? ` (${error.status})` : ""}` : error?.message || "Codex worker failed"}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}

