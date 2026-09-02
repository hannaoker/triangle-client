#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { invoke, readRequest, writeResult } from "./runner-common.mjs";

export function createAgentPrompt(request) {
  return [
    "You are responding to an authenticated A2A peer message in The Triangle.",
    `Sender agent: ${request.senderId}`,
    `Context: ${request.contextId}`,
    "Answer the peer request factually and concisely. Do not fabricate actions or results.",
    "Return only the reply that should be sent to the peer; do not include routing metadata.",
    "",
    request.text,
  ].join("\n");
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
  const text = await invoke(
    invocation.command,
    invocation.args,
    {
      input: createAgentPrompt(request),
    },
  );
  writeResult(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Hermes runner failed"}\n`);
    process.exitCode = 1;
  });
}
