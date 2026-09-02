#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createOutboundClient } from "./outbound-client.mjs";

const MAX_INPUT_BYTES = 64 * 1024;

export async function executeOutbound(
  input,
  client,
  createMessageId = () => `message_${crypto.randomUUID()}`,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Input must be a JSON object");
  }
  if (input.operation === "send") {
    return client.send({
      recipientAgentId: input.recipientAgentId,
      messageId: input.messageId || createMessageId(),
      ...(input.contextId ? { contextId: input.contextId } : {}),
      text: input.text,
    });
  }
  if (input.operation === "get_task") {
    return client.getTask({
      recipientAgentId: input.recipientAgentId,
      taskId: input.taskId,
    });
  }
  throw new TypeError("operation must be send or get_task");
}

async function readInput(stream = process.stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_INPUT_BYTES) throw new TypeError("Input is too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TypeError("Input must be valid JSON");
  }
}

const SELECTOR_FLAGS = new Map([
  ["--gateway-url-env", "gatewayUrlEnv"],
  ["--internal-token-env", "internalTokenEnv"],
]);
const MAILBOX_ENV_NAMES = new Set(["MESH_ORIGIN", "MESH_AGENT_TOKEN"]);

function parseSelectors(argv) {
  const values = {};
  const counts = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = SELECTOR_FLAGS.get(flag);
    if (!key) throw new TypeError(`Unknown argument: ${flag}`);
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new TypeError(`${flag} <name> is required`);
    }
    counts.set(flag, (counts.get(flag) || 0) + 1);
    values[key] = argv[index + 1];
  }
  for (const flag of SELECTOR_FLAGS.keys()) {
    const count = counts.get(flag) || 0;
    if (count === 0) throw new TypeError(`${flag} <name> is required`);
    if (count !== 1) throw new TypeError(`${flag} must be provided exactly once`);
  }
  for (const value of Object.values(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
      throw new TypeError("environment selectors must be uppercase variable names");
    }
    if (MAILBOX_ENV_NAMES.has(value)) {
      throw new TypeError("mailbox selectors are not allowed for outbound gateway access");
    }
  }
  if (values.gatewayUrlEnv === values.internalTokenEnv) {
    throw new TypeError("selectors must name distinct environment variables");
  }
  return values;
}

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  {
    readInput: readInputImpl = readInput,
    createOutboundClient: createOutboundClientImpl = createOutboundClient,
    writeOutput = (value) => process.stdout.write(value),
  } = {},
) {
  const selectors = parseSelectors(argv);
  const clientOptions = {
    gatewayUrl: requiredEnv(env, selectors.gatewayUrlEnv),
    internalToken: requiredEnv(env, selectors.internalTokenEnv),
  };
  const client = createOutboundClientImpl(clientOptions);
  const result = await executeOutbound(await readInputImpl(), client);
  writeOutput(`${JSON.stringify(result)}\n`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Outbound request failed"}\n`);
    process.exitCode = 1;
  });
}
