#!/usr/bin/env node

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function resolveConversationStorePath(env = process.env) {
  const root =
    (typeof env.TRIANGLE_MODEL_ROOTS === "string" && env.TRIANGLE_MODEL_ROOTS) ||
    (typeof env.ANTIGRAVITY_HOME === "string" && env.ANTIGRAVITY_HOME) ||
    (typeof env.TRIANGLE_INSTANCE_TEMP_ROOT === "string" && env.TRIANGLE_INSTANCE_TEMP_ROOT);
  if (!root || !path.isAbsolute(root)) return null;
  return path.join(root, "antigravity-sessions.json");
}

export function loadConversationId(contextId, env = process.env) {
  if (!contextId || typeof contextId !== "string") return null;
  const filePath = resolveConversationStorePath(env);
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    const entry = data?.[contextId];
    if (typeof entry === "string") return entry;
    if (entry && typeof entry.conversationId === "string") return entry.conversationId;
  } catch {
    // Ignore corrupt store, fallback gracefully
  }
  return null;
}

export function saveConversationId(contextId, conversationId, env = process.env) {
  if (
    !contextId ||
    typeof contextId !== "string" ||
    !conversationId ||
    typeof conversationId !== "string"
  ) {
    return;
  }
  const filePath = resolveConversationStorePath(env);
  if (!filePath) return;
  try {
    let data = {};
    if (existsSync(filePath)) {
      try {
        data = JSON.parse(readFileSync(filePath, "utf8")) || {};
      } catch {
        data = {};
      }
    }
    data[contextId] = {
      conversationId,
      updatedAt: new Date().toISOString(),
    };
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tempPath = path.join(dir, `.sessions-${crypto.randomBytes(8).toString("hex")}.tmp`);
    writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch {
    // Best-effort session persistence
  }
}

export function extractAntigravityResponse(stdoutText) {
  let parsed;
  try {
    parsed = typeof stdoutText === "string" ? JSON.parse(stdoutText) : null;
  } catch {
    throw new Error("Antigravity CLI returned an invalid response");
  }
  // The invocation requests JSON. Metadata and failure envelopes must never
  // become peer replies or advance the persisted conversation.
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || parsed.status !== "SUCCESS"
    || typeof parsed.response !== "string" || !parsed.response.trim()
  ) {
    throw new Error("Antigravity CLI returned an invalid response");
  }
  return {
    text: parsed.response.trim(),
    conversationId: typeof parsed.conversation_id === "string" ? parsed.conversation_id : null,
  };
}

export function createAntigravityInvocation(prompt, env = process.env, { conversationId, format = "json" } = {}) {
  const args = ["-p", prompt, "--output-format", format, "--sandbox"];
  if (typeof conversationId === "string" && conversationId.trim()) {
    args.push("--conversation", conversationId.trim());
  }
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
  const contextId = request.contextId || request.roomId;
  const conversationId = loadConversationId(contextId, env);
  const prompt = createAgentPrompt(request);
  const invocation = createAntigravityInvocation(prompt, env, { conversationId });
  const rawOutput = await invoke(invocation.command, invocation.args);
  const { text, conversationId: newConversationId } = extractAntigravityResponse(rawOutput);
  if (contextId && newConversationId) {
    saveConversationId(contextId, newConversationId, env);
  }
  writeResult(text);
}

runAsCli(import.meta.url, main, "Antigravity runner failed");
