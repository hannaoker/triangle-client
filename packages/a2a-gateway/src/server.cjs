/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require("node:crypto");
const http = require("node:http");
const {
  buildAgentCard,
  createMeshPeerIntrospector,
  createProtocolHandler,
} = require("./protocol.cjs");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3002;
const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_WAIT_POLL_MS = 50;
const MAX_REQUEST_BYTES = 1024 * 1024;
const RETIRED_PATHS = new Set(["/inbox", "/inbox/ack", "/internal/tasks/update"]);

class ParseBodyError extends Error {}
class BodyTooLargeError extends Error {}

function createId(prefix) { return `${prefix}_${crypto.randomBytes(16).toString("hex")}`; }
function json(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        settled = true;
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        fail(new ParseBodyError());
      }
    });
    req.on("error", fail);
  });
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createServer({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  origin = `http://localhost:${port}`,
  meshOrigin = "http://localhost:3000",
  internalToken,
  agentToken,
  introspectPeerToken: suppliedIntrospector,
  bridge,
  recipientAgentId,
  waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  waitPollMs = DEFAULT_WAIT_POLL_MS,
  id = createId,
} = {}) {
  if (!bridge || typeof bridge.sendMessage !== "function" ||
      typeof bridge.getTask !== "function" || typeof bridge.listTasks !== "function") {
    throw new TypeError("bridge is required");
  }
  if (typeof recipientAgentId !== "string" || !recipientAgentId) {
    throw new TypeError("recipientAgentId is required");
  }
  let proofNonce = null;
  const agentCard = buildAgentCard({ origin, meshOrigin });
  const introspectPeerToken = suppliedIntrospector || createMeshPeerIntrospector({ meshOrigin, agentToken });
  const handleA2A = createProtocolHandler({
    meshOrigin,
    getProofNonce: () => proofNonce,
    bridge,
    recipientAgentId,
    introspectPeerToken,
    createId: id,
    bridgeWaitTimeoutMs: waitTimeoutMs,
    bridgeWaitPollMs: waitPollMs,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (RETIRED_PATHS.has(url.pathname)) {
      json(res, 404, { error: "Not found" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
      json(res, 200, agentCard);
      return;
    }
    if (req.method === "GET" && url.pathname === "/.well-known/mesh-proof.json") {
      json(res, proofNonce ? 200 : 404, proofNonce
        ? { nonce: proofNonce }
        : { error: "No active registration proof" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { status: "ok", bridge: "available" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/internal/registration-proof") {
      if (!tokenMatches(req.headers["x-codex-internal-token"], internalToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        const body = await readBody(req);
        if (typeof body.nonce !== "string" || !body.nonce) throw new ParseBodyError();
        proofNonce = body.nonce;
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, error instanceof BodyTooLargeError ? 413 : 400, { error: "Invalid request" });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1") {
      const requestAbort = new AbortController();
      req.once("aborted", () => requestAbort.abort());
      res.once("close", () => { if (!res.writableEnded) requestAbort.abort(); });
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        if (requestAbort.signal.aborted) return;
        json(res, error instanceof BodyTooLargeError ? 413 : 400, {
          jsonrpc: "2.0", id: null, error: {
            code: error instanceof ParseBodyError ? -32700 : -32600,
            message: error instanceof ParseBodyError ? "Parse error" : "Invalid Request",
          },
        });
        return;
      }
      try {
        const result = await handleA2A({
          request: body,
          version: req.headers["a2a-version"],
          extensions: req.headers["a2a-extensions"],
          authorization: req.headers.authorization,
          signal: requestAbort.signal,
        });
        json(res, result.status, result.body);
      } catch {
        if (!requestAbort.signal.aborted) {
          json(res, 500, { jsonrpc: "2.0", id: body?.id ?? null,
            error: { code: -32603, message: "Internal error" } });
        }
      }
      return;
    }
    json(res, 404, { error: "Not found" });
  });

  return { server, config: { host, port, origin, meshOrigin, waitTimeoutMs, waitPollMs } };
}

if (require.main === module) {
  console.error("Mailbox bridge configuration is required; server not started");
  process.exitCode = 1;
}

module.exports = { DEFAULT_WAIT_TIMEOUT_MS, MAX_REQUEST_BYTES, createServer };
