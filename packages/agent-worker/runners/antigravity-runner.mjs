#!/usr/bin/env node

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import {
  createAgentPrompt as createSharedAgentPrompt,
  invoke as defaultInvoke,
  readRequest,
  runAsCli,
  writeResult,
} from "./runner-common.mjs";

// --- Per-room conversation store --------------------------------------------
// Kept in this file (not a sibling module) so the installed worker manifest's
// exact artifact set is unchanged. Maps MESH room id (request.contextId) ->
// agy conversation_id. Stores ids only (never text or credentials); atomic
// tmp+rename writes with mode 0600.

export const STORE_FILE_NAME = "triangle-antigravity-conversations.json";
const STORE_VERSION = 1;
const MAX_ROOMS = 1000;
// agy conversation ids are UUIDs; accept a conservative uuid-ish charset only.
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const ROOM_KEY = /^[A-Za-z0-9_:-]{1,128}$/;

export function isValidConversationId(value) {
  return typeof value === "string" && CONVERSATION_ID.test(value);
}

export function isValidRoomKey(value) {
  return typeof value === "string" && ROOM_KEY.test(value);
}

/** Resolve the store directory from the worker env (model-root scoped). */
export function resolveStoreDirectory(env = process.env) {
  const home = env.ANTIGRAVITY_HOME;
  if (typeof home === "string" && path.isAbsolute(home) && !/[\r\n\0]/.test(home)) return home;
  const roots = typeof env.TRIANGLE_MODEL_ROOTS === "string" ? env.TRIANGLE_MODEL_ROOTS.split(path.delimiter).filter(Boolean) : [];
  if (roots.length === 1 && path.isAbsolute(roots[0]) && !/[\r\n\0]/.test(roots[0])) return roots[0];
  return null;
}

function emptyStore() {
  return { version: STORE_VERSION, rooms: {} };
}

export function createConversationStore(directory) {
  const filePath = directory ? path.join(directory, STORE_FILE_NAME) : null;

  function read() {
    if (!filePath || !existsSync(filePath)) return emptyStore();
    try {
      const value = JSON.parse(readFileSync(filePath, "utf8"));
      if (!value || value.version !== STORE_VERSION || typeof value.rooms !== "object" || value.rooms === null || Array.isArray(value.rooms)) return emptyStore();
      const rooms = {};
      for (const [room, entry] of Object.entries(value.rooms)) {
        if (isValidRoomKey(room) && entry && isValidConversationId(entry.conversationId)) {
          rooms[room] = { conversationId: entry.conversationId, updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null };
        }
      }
      return { version: STORE_VERSION, rooms };
    } catch {
      // Corrupt store: start fresh rather than failing the turn.
      return emptyStore();
    }
  }

  function write(store) {
    if (!filePath) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entries = Object.entries(store.rooms)
      .sort((a, b) => String(b[1].updatedAt ?? "").localeCompare(String(a[1].updatedAt ?? "")))
      .slice(0, MAX_ROOMS);
    const payload = `${JSON.stringify({ version: STORE_VERSION, rooms: Object.fromEntries(entries) }, null, 2)}\n`;
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, filePath);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw error;
    }
  }

  return Object.freeze({
    filePath,
    get(room) {
      if (!isValidRoomKey(room)) return null;
      return read().rooms[room]?.conversationId ?? null;
    },
    set(room, conversationId, now = new Date()) {
      if (!filePath || !isValidRoomKey(room) || !isValidConversationId(conversationId)) return false;
      const store = read();
      store.rooms[room] = { conversationId, updatedAt: now.toISOString() };
      write(store);
      return true;
    },
    delete(room) {
      if (!filePath || !isValidRoomKey(room)) return false;
      const store = read();
      if (!(room in store.rooms)) return false;
      delete store.rooms[room];
      write(store);
      return true;
    },
  });
}
// ---------------------------------------------------------------------------

const GUIDANCE =
  "Answer the peer request factually and concisely. Do not fabricate actions or results.";

export function createAgentPrompt(request) {
  return createSharedAgentPrompt(request, { guidance: GUIDANCE });
}

/**
 * Build the agy argv. `--conversation <id>` must precede `-p <prompt>`:
 * after `-p` the next token is consumed as the prompt. The prompt is always a
 * single argv element (spawned with shell: false), never interpolated.
 */
export function createAntigravityInvocation(prompt, env = process.env, { conversationId = null } = {}) {
  const args = [];
  if (conversationId !== null && conversationId !== undefined) {
    if (!isValidConversationId(conversationId)) throw new Error("Antigravity conversation id is invalid");
    args.push("--conversation", conversationId);
  }
  args.push("-p", prompt, "--output-format", "json", "--sandbox");
  const tempRoot = env.TRIANGLE_INSTANCE_TEMP_ROOT;
  if (typeof tempRoot === "string" && path.isAbsolute(tempRoot)) {
    args.push("--log-file", path.join(tempRoot, "antigravity-cli.log"));
  }
  return {
    command: env.ANTIGRAVITY_CLI || env.AGY_CLI || "agy",
    args,
  };
}

/**
 * Parse agy `--output-format json` output. Falls back to plain text when the
 * output is not a JSON envelope (older CLIs or `text` format).
 */
export function parseAntigravityOutput(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  let envelope = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    // Tolerate leading noise: take the last line that parses as an object.
    for (const line of text.split(/\r?\n/).reverse()) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) continue;
      try {
        envelope = JSON.parse(candidate);
        break;
      } catch {
        // keep scanning
      }
    }
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { text, conversationId: null, status: null, error: null, parsed: false };
  }
  const result = envelope.event === "result" && envelope.result && typeof envelope.result === "object" ? envelope.result : envelope;
  const conversationId = isValidConversationId(result.conversation_id) ? result.conversation_id : null;
  const status = typeof result.status === "string" ? result.status : null;
  const error = typeof result.error === "string" ? result.error : null;
  const reply = typeof result.response === "string" ? result.response.trim() : "";
  return { text: reply, conversationId, status, error, parsed: true };
}

function turnFailed(parsed) {
  return parsed.parsed && ((parsed.status && parsed.status !== "SUCCESS") || !parsed.text);
}

export async function runAntigravityTurn(request, env = process.env, { invoke = defaultInvoke, store } = {}) {
  const prompt = createAgentPrompt(request);
  const room = isValidRoomKey(request.contextId) ? request.contextId : null;
  const conversations = store ?? createConversationStore(resolveStoreDirectory(env));
  const storedId = room ? conversations.get(room) : null;

  const attempt = async (conversationId) => {
    const invocation = createAntigravityInvocation(prompt, env, { conversationId });
    const parsed = parseAntigravityOutput(await invoke(invocation.command, invocation.args, { env }));
    if (turnFailed(parsed)) {
      throw new Error(`Antigravity turn failed${parsed.status ? ` (${parsed.status})` : ""}${parsed.error ? `: ${parsed.error.slice(0, 300)}` : ""}`);
    }
    return parsed;
  };

  let parsed;
  if (storedId) {
    try {
      parsed = await attempt(storedId);
    } catch {
      // Stale/unknown conversation or resume failure: forget it and retry once fresh.
      conversations.delete(room);
      parsed = await attempt(null);
    }
  } else {
    parsed = await attempt(null);
  }
  if (room && parsed.conversationId && parsed.conversationId !== storedId) {
    conversations.set(room, parsed.conversationId);
  }
  return parsed;
}

export async function main(env = process.env) {
  const request = await readRequest();
  const parsed = await runAntigravityTurn(request, env);
  writeResult(parsed.text);
}

runAsCli(import.meta.url, main, "Antigravity runner failed");
