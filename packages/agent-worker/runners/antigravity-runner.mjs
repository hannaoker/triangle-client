#!/usr/bin/env node

import path from "node:path";
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

export function createAntigravityInvocation(prompt, env = process.env) {
  const args = ["-p", prompt, "--output-format", "text", "--sandbox"];
  const tempRoot = env.TRIANGLE_INSTANCE_TEMP_ROOT;
  if (typeof tempRoot === "string" && path.isAbsolute(tempRoot)) {
    args.push("--log-file", path.join(tempRoot, "antigravity-cli.log"));
  }
  return {
    command: env.ANTIGRAVITY_CLI || env.AGY_CLI || "agy",
    args,
  };
}

export async function main(env = process.env) {
  const request = await readRequest();
  const prompt = createAgentPrompt(request);
  const invocation = createAntigravityInvocation(prompt, env);
  const text = await invoke(
    invocation.command,
    invocation.args,
  );
  writeResult(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Antigravity runner failed"}\n`);
    process.exitCode = 1;
  });
}
