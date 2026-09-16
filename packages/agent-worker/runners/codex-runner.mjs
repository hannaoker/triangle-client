#!/usr/bin/env node

import {
  createAgentPrompt as createSharedAgentPrompt,
  invoke,
  readRequest,
  runAsCli,
  writeResult,
} from "./runner-common.mjs";

const GUIDANCE =
  "Answer the peer request factually and concisely. Use read-only inspection when needed.";

export function createAgentPrompt(request) {
  return createSharedAgentPrompt(request, { guidance: GUIDANCE });
}

export async function main(env = process.env) {
  const request = await readRequest();
  const text = await invoke(
    env.CODEX_CLI || "codex",
    [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      env.TRIANGLE_PROJECT_ROOT || process.cwd(),
      "-",
    ],
    { input: createAgentPrompt(request) },
  );
  writeResult(text);
}

runAsCli(import.meta.url, main, "Codex runner failed");
