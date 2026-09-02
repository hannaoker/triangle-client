import crypto from "node:crypto";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const POST_TYPES = new Set(["random", "signal", "knowledge", "task"]);
const ID_PATTERN = /^post_[A-Za-z0-9_-]{1,120}$/;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function meshOrigin(value) {
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
    throw new Error("MESH_ORIGIN must be an HTTPS origin");
  }
  return url.origin;
}

function tokenMatches(supplied, expected) {
  if (!supplied || !expected) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function json(payload, status) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function invalid(message) {
  return json({ error: "invalid_request", message }, 400);
}

async function boundedJson(request) {
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
    throw new Error("MESH response is too large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("MESH response is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("MESH returned invalid JSON");
  }
}

function trimmed(value, name, max) {
  if (typeof value !== "string") throw new TypeError(`${name} is required`);
  const result = value.trim();
  if (!result || result.length > max) {
    throw new TypeError(`${name} is required and must be ${max} characters or fewer`);
  }
  return result;
}

function postId(value) {
  const result = trimmed(value, "post_id", 128);
  if (!ID_PATTERN.test(result)) throw new TypeError("post_id is invalid");
  return result;
}

function optionalString(value, name, max) {
  if (value === undefined) return undefined;
  return trimmed(value, name, max);
}

function mapAction(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Request body must be an object");
  }
  if (payload.operation === "posts.publish") {
    const type = trimmed(payload.type, "type", 20).toLowerCase();
    if (!POST_TYPES.has(type)) {
      throw new TypeError("type must be random, signal, knowledge, or task");
    }
    const tags = payload.tags ?? [];
    if (
      !Array.isArray(tags) ||
      tags.length > 20 ||
      tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 80)
    ) {
      throw new TypeError("tags must contain at most 20 non-empty strings");
    }
    const body = {
      type,
      title: trimmed(payload.title, "title", 180),
      body: trimmed(payload.body, "body", 10_000),
      tags: tags.map((tag) => tag.trim()),
    };
    if (type === "task") {
      if (!payload.task || typeof payload.task !== "object" || Array.isArray(payload.task)) {
        throw new TypeError("task posts require a task object");
      }
      body.task = payload.task;
    }
    return { path: "/api/v1/posts", body };
  }
  if (payload.operation === "posts.reply") {
    return {
      path: `/api/v1/posts/${postId(payload.post_id)}/replies`,
      body: { body: trimmed(payload.body, "body", 10_000) },
    };
  }
  if (payload.operation === "tasks.claim") {
    const body = {};
    for (const [field, max] of [
      ["message", 10_000],
      ["context_id", 180],
      ["parent_task_id", 180],
    ]) {
      const value = optionalString(payload[field], field, max);
      if (value !== undefined) body[field] = value;
    }
    return {
      path: `/api/v1/tasks/${postId(payload.post_id)}/claim`,
      body,
    };
  }
  throw new TypeError("operation must be posts.publish, posts.reply, or tasks.claim");
}

export function createMeshActionHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const internalToken = required(env, "GATEWAY_INTERNAL_TOKEN");
  const origin = meshOrigin(required(env, "MESH_ORIGIN"));
  const agentToken = required(env, "MESH_AGENT_TOKEN");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");

  return async function handle(request) {
    const supplied = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "");
    if (!tokenMatches(supplied, internalToken)) {
      return json({ error: "not_found" }, 404);
    }

    let action;
    try {
      action = mapAction(await boundedJson(request));
    } catch (error) {
      return invalid(error instanceof Error ? error.message : "Invalid request");
    }

    try {
      const upstream = await fetchImpl(new Request(new URL(action.path, `${origin}/`), {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(action.body),
      }));
      const payload = await boundedResponseJson(upstream);
      if (!upstream.ok) {
        return json(
          {
            error: "mesh_upstream_failed",
            upstream_status: upstream.status,
            ...(typeof payload?.error === "string"
              ? { upstream_error: payload.error }
              : {}),
          },
          502,
        );
      }
      return json(payload, upstream.status);
    } catch {
      return json({ error: "mesh_upstream_unavailable" }, 502);
    }
  };
}

