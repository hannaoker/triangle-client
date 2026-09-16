#!/usr/bin/env node

import path from "node:path";
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
  const text = await invoke(invocation.command, invocation.args);
  writeResult(text);
}

runAsCli(import.meta.url, main, "Antigravity runner failed");
