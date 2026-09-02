import crypto from "node:crypto";

import {
  buildOutboundRpc,
  normalizeOutboundPayload,
  verifiedOutboundDialect,
} from "./outbound-a2a-dialect.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROFILE_PATH = "/extensions/mesh-a2a-profile/v1";
const AGENT_ID = /^agent_[A-Za-z0-9_-]{1,160}$/;
const VALUE_ID = /^[A-Za-z][A-Za-z0-9_-]{1,180}$/;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function origin(value, name) {
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !local) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  return url.origin;
}

function tokenMatches(supplied, expected) {
  if (!supplied || !expected) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function responseJson(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function boundedRequestJson(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new TypeError("Request body is too large");
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) {
    throw new TypeError("Request body is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("Request body must be valid JSON");
  }
}

async function boundedResponseJson(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Upstream response is too large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("Upstream response is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Upstream returned invalid JSON");
  }
}

function id(value, name, pattern = VALUE_ID) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function text(value) {
  if (typeof value !== "string") throw new TypeError("text is required");
  const result = value.trim();
  if (!result || result.length > 10_000) {
    throw new TypeError("text is required and must be 10,000 characters or fewer");
  }
  return result;
}

function operation(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Request body must be an object");
  }
  const recipientAgentId = id(
    payload.recipient_agent_id,
    "recipient_agent_id",
    AGENT_ID,
  );
  if (payload.operation === "send") {
    return {
      type: "send",
      recipientAgentId,
      messageId: id(payload.message_id, "message_id"),
      ...(payload.context_id === undefined
        ? {}
        : { contextId: id(payload.context_id, "context_id") }),
      text: text(payload.text),
    };
  }
  if (payload.operation === "get_task") {
    return {
      type: "get_task",
      recipientAgentId,
      taskId: id(payload.task_id, "task_id"),
    };
  }
  throw new TypeError("operation must be send or get_task");
}

function endpoint(peer) {
  if (
    peer?.conformanceStatus !== "verified" ||
    peer.protocolBinding !== "JSONRPC" ||
    peer.protocolVersion !== "1.0"
  ) {
    throw new RangeError("Recipient is not a verified A2A 1.0 JSONRPC peer");
  }
  const url = new URL(peer.endpointUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RangeError("Recipient endpoint is not a public HTTPS URL");
  }
  return url.toString();
}

async function upstreamJson(fetchImpl, request) {
  const response = await fetchImpl(request);
  return { response, payload: await boundedResponseJson(response) };
}

export function createOutboundA2AHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const internalToken = required(env, "GATEWAY_INTERNAL_TOKEN");
  const meshOrigin = origin(required(env, "MESH_ORIGIN"), "MESH_ORIGIN");
  const agentToken = required(env, "MESH_AGENT_TOKEN");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");

  return async function handle(request) {
    const supplied = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "");
    if (!tokenMatches(supplied, internalToken)) {
      return responseJson({ error: "not_found" }, 404);
    }

    let action;
    try {
      action = operation(await boundedRequestJson(request));
    } catch (error) {
      return responseJson(
        {
          error: "invalid_request",
          message: error instanceof Error ? error.message : "Invalid request",
        },
        400,
      );
    }

    try {
      const registry = await upstreamJson(
        fetchImpl,
        new Request(`${meshOrigin}/api/v1/agents?limit=100`, {
          headers: { accept: "application/json" },
          redirect: "error",
        }),
      );
      if (!registry.response.ok) {
        return responseJson(
          {
            error: "mesh_registry_failed",
            upstream_status: registry.response.status,
            ...(typeof registry.payload?.error === "string"
              ? { upstream_error: registry.payload.error }
              : {}),
          },
          502,
        );
      }
      const peer = registry.payload?.agents?.find(
        (candidate) => candidate?.id === action.recipientAgentId,
      );
      if (!peer) {
        return responseJson({ error: "recipient_not_found" }, 404);
      }

      let peerEndpoint;
      let dialect;
      try {
        peerEndpoint = endpoint(peer);
        dialect = verifiedOutboundDialect(peer);
      } catch (error) {
        return responseJson(
          {
            error: "recipient_not_callable",
            message: error instanceof Error ? error.message : "Recipient is not callable",
          },
          409,
        );
      }

      const ticket = await upstreamJson(
        fetchImpl,
        new Request(`${meshOrigin}/api/v1/peer-tokens`, {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${agentToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            recipient_agent_id: peer.id,
            lifetime_seconds: 300,
          }),
        }),
      );
      if (!ticket.response.ok || typeof ticket.payload?.token !== "string") {
        return responseJson(
          {
            error: "mesh_ticket_failed",
            upstream_status: ticket.response.status,
            ...(typeof ticket.payload?.error === "string"
              ? { upstream_error: ticket.payload.error }
              : {}),
          },
          502,
        );
      }

      const rpcId = `rpc_${crypto.randomUUID()}`;
      const rpc = buildOutboundRpc(action, dialect, rpcId);
      const called = await upstreamJson(
        fetchImpl,
        new Request(peerEndpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${ticket.payload.token}`,
            "content-type": "application/json",
            "A2A-Version": "1.0",
            "A2A-Extensions": `${meshOrigin}${PROFILE_PATH}`,
          },
          body: JSON.stringify(rpc),
        }),
      );
      if (!called.response.ok || called.payload?.error) {
        return responseJson(
          {
            error: "peer_rpc_failed",
            upstream_status: called.response.status,
            ...(Number.isInteger(called.payload?.error?.code)
              ? { rpc_code: called.payload.error.code }
              : {}),
            ...(typeof called.payload?.error?.message === "string"
              ? { rpc_message: called.payload.error.message.slice(0, 300) }
              : {}),
          },
          502,
        );
      }
      called.payload = normalizeOutboundPayload(
        action.type,
        called.payload,
        () => `task_${crypto.randomUUID()}`,
      );
      const task =
        action.type === "send"
          ? called.payload?.result?.task
          : called.payload?.result;
      if (
        !task ||
        typeof task.id !== "string" ||
        typeof task.contextId !== "string" ||
        typeof task.status?.state !== "string"
      ) {
        return responseJson({ error: "peer_rpc_invalid_result" }, 502);
      }
      return responseJson({
        peer: { id: peer.id, name: peer.name },
        task,
      });
    } catch {
      return responseJson({ error: "outbound_a2a_unavailable" }, 502);
    }
  };
}
