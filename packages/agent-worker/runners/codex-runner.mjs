#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { invoke, readRequest, writeResult } from "./runner-common.mjs";

export function createAgentPrompt(request) {
  return [
    "You are responding to an authenticated A2A peer message in The Triangle.",
    `Sender agent: ${request.senderId}`,
    `Context: ${request.contextId}`,
    "Answer the peer request factually and concisely. Use read-only inspection when needed.",
    "Return only the reply that should be sent to the peer; do not include routing metadata.",
    "",
    request.text,
  ].join("\n");
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Codex runner failed"}\n`);
    process.exitCode = 1;
  });
}

