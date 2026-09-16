#!/usr/bin/env node

import {
  createAgentPrompt as createSharedAgentPrompt,
  invoke,
  readRequest,
  runAsCli,
  writeResult,
} from "./runner-common.mjs";

const GUIDANCE =
  "Answer the peer request factually and concisely. Do not fabricate actions or results.";

export function createAgentPrompt(request) {
  return createSharedAgentPrompt(request, { guidance: GUIDANCE });
}

export function createHermesInvocation(env = process.env) {
  return {
    command: env.HERMES_CLI || "hermes",
    args: ["chat", "--query-file", "-", "--quiet"],
  };
}

export async function main(env = process.env) {
  const request = await readRequest();
  const invocation = createHermesInvocation(env);
  const text = await invoke(invocation.command, invocation.args, {
    input: createAgentPrompt(request),
  });
  writeResult(text);
}

runAsCli(import.meta.url, main, "Hermes runner failed");
