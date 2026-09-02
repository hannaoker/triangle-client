import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildAgentCard, createProtocolHandler, preflightProtocolRequest } = require("./protocol.cjs");

export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_INBOX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_INBOX_PAGE_LIMIT = 50;
export const MAX_INBOX_PAGE_LIMIT = 100;

const RETIRED_PATHS = new Set(["/inbox", "/inbox/ack", "/internal/tasks/update"]);
class InvalidJsonError extends Error {}
class RequestTooLargeError extends Error {}

function response(status, body) {
  return new Response(JSON.stringify(body), { status, headers: {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  } });
}

async function readJson(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RequestTooLargeError();
  const reader = request.body?.getReader();
  const chunks = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        Promise.resolve(reader.cancel()).catch(() => {});
        throw new RequestTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new InvalidJsonError();
  }
}

function methodNotAllowed() { return response(405, { error: "Method not allowed" }); }
function randomId(prefix) { return `${prefix}_${crypto.randomBytes(16).toString("hex")}`; }

export function createVercelGatewayHandler({
  origin, meshOrigin, profile, recipientAgentId, proofNonce,
  getProofNonce = () => proofNonce, bridgeFactory, introspectPeerToken,
  createId = randomId, maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  bridgeWaitTimeoutMs, bridgeWaitPollMs,
}) {
  if (!profile || typeof profile.name !== "string" || !profile.name) throw new TypeError("profile.name is required");
  if (typeof bridgeFactory !== "function") throw new TypeError("bridgeFactory is required");
  if (typeof recipientAgentId !== "string" || !recipientAgentId) throw new TypeError("recipientAgentId is required");
  if (typeof introspectPeerToken !== "function") throw new TypeError("introspectPeerToken is required");
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new TypeError("maxRequestBytes must be a positive safe integer");
  const agentCard = buildAgentCard({ origin, meshOrigin, profile });

  async function loadBridge() {
    const bridge = await bridgeFactory();
    if (!bridge || typeof bridge.sendMessage !== "function" ||
        typeof bridge.getTask !== "function" || typeof bridge.listTasks !== "function") {
      throw new Error("Mailbox bridge unavailable");
    }
    return bridge;
  }

  return async function handle(request) {
    const pathname = new URL(request.url).pathname;
    if (RETIRED_PATHS.has(pathname)) return response(404, { error: "Not found" });
    if (pathname === "/.well-known/agent-card.json") {
      return request.method === "GET" ? response(200, agentCard) : methodNotAllowed();
    }
    if (pathname === "/.well-known/mesh-proof.json") {
      if (request.method !== "GET") return methodNotAllowed();
      const nonce = getProofNonce();
      return typeof nonce === "string" && nonce.length > 0
        ? response(200, { nonce })
        : response(404, { error: "No active registration proof" });
    }
    if (pathname === "/health") {
      if (request.method !== "GET") return methodNotAllowed();
      try {
        await loadBridge();
        return response(200, { status: "ok", bridge: "available" });
      } catch {
        return response(503, { status: "unavailable" });
      }
    }
    if (pathname !== "/api/v1") return response(404, { error: "Not found" });
    if (request.method !== "POST") return methodNotAllowed();

    let body;
    try {
      body = await readJson(request, maxRequestBytes);
    } catch (error) {
      const tooLarge = error instanceof RequestTooLargeError;
      return response(tooLarge ? 413 : 400, { jsonrpc: "2.0", id: null, error: {
        code: tooLarge ? -32600 : -32700,
        message: tooLarge ? "Invalid Request" : "Parse error",
      } });
    }
    try {
      const authorization = request.headers.get("authorization");
      const extensions = request.headers.get("a2a-extensions");
      const version = request.headers.get("a2a-version");
      const preflight = await preflightProtocolRequest({
        request: body, version, extensions, authorization, meshOrigin,
        getProofNonce, introspectPeerToken, createId,
      });
      if (preflight.response) return response(preflight.response.status, preflight.response.body);
      if (preflight.credential.audience_agent_id !== recipientAgentId) {
        return response(403, { jsonrpc: "2.0", id: body.id, error: {
          code: -32000, message: "Peer ticket audience mismatch",
        } });
      }
      const handleProtocol = createProtocolHandler({
        meshOrigin, getProofNonce, bridge: await loadBridge(), recipientAgentId,
        introspectPeerToken, createId,
        ...(bridgeWaitTimeoutMs === undefined ? {} : { bridgeWaitTimeoutMs }),
        ...(bridgeWaitPollMs === undefined ? {} : { bridgeWaitPollMs }),
      });
      const result = await handleProtocol({
        request: body, version, extensions, authorization,
        signal: request.signal, credential: preflight.credential,
      });
      return response(result.status, result.body);
    } catch {
      return response(500, { jsonrpc: "2.0", id: body?.id ?? null,
        error: { code: -32603, message: "Internal error" } });
    }
  };
}
