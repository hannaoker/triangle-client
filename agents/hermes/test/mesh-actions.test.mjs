import assert from "node:assert/strict";
import test from "node:test";

import { createMeshActionHandler } from "../lib/mesh-actions.mjs";

const env = {
  GATEWAY_INTERNAL_TOKEN: "worker-secret-with-enough-entropy",
  MESH_ORIGIN: "https://mesh.example",
  MESH_AGENT_TOKEN: "mesh_production_hermes_token",
};

function request(body, token = env.GATEWAY_INTERNAL_TOKEN) {
  return new Request("https://hermes.example/internal/mesh/actions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

test("private MESH bridge rejects missing and incorrect worker credentials before fetch", async () => {
  let calls = 0;
  const handler = createMeshActionHandler({
    env,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not fetch");
    },
  });
  const missing = await handler(
    new Request("https://hermes.example/internal/mesh/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  const incorrect = await handler(request({}, "wrong-secret-same-ish-length"));

  assert.equal(missing.status, 404);
  assert.equal(incorrect.status, 404);
  assert.equal(calls, 0);
});

test("posts.publish maps only validated fields to MESH with Hermes server credential", async () => {
  const calls = [];
  const handler = createMeshActionHandler({
    env,
    fetchImpl: async (upstream) => {
      calls.push(upstream);
      return Response.json(
        { post: { id: "post_1", title: "Useful finding" } },
        { status: 201 },
      );
    },
  });
  const response = await handler(
    request({
      operation: "posts.publish",
      type: "knowledge",
      title: " Useful finding ",
      body: " A bounded body. ",
      tags: ["mesh", "research"],
    }),
  );

  assert.deepEqual(await responseJson(response), {
    status: 201,
    body: { post: { id: "post_1", title: "Useful finding" } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://mesh.example/api/v1/posts");
  assert.equal(calls[0].method, "POST");
  assert.equal(
    calls[0].headers.get("authorization"),
    `Bearer ${env.MESH_AGENT_TOKEN}`,
  );
  assert.deepEqual(await calls[0].json(), {
    type: "knowledge",
    title: "Useful finding",
    body: "A bounded body.",
    tags: ["mesh", "research"],
  });
});

test("posts.reply maps the post identifier into the REST path", async () => {
  const calls = [];
  const handler = createMeshActionHandler({
    env,
    fetchImpl: async (upstream) => {
      calls.push(upstream);
      return Response.json({ reply: { id: "reply_1" } }, { status: 201 });
    },
  });
  const response = await handler(
    request({
      operation: "posts.reply",
      post_id: "post_abc123",
      body: "Hermes adds a thought.",
    }),
  );

  assert.equal(response.status, 201);
  assert.equal(
    calls[0].url,
    "https://mesh.example/api/v1/posts/post_abc123/replies",
  );
  assert.deepEqual(await calls[0].json(), {
    body: "Hermes adds a thought.",
  });
});

test("tasks.claim maps task metadata without accepting arbitrary paths", async () => {
  const calls = [];
  const handler = createMeshActionHandler({
    env,
    fetchImpl: async (upstream) => {
      calls.push(upstream);
      return Response.json({ task: { id: "task_1" } });
    },
  });
  const response = await handler(
    request({
      operation: "tasks.claim",
      post_id: "post_task123",
      message: "Hermes will handle this.",
      context_id: "ctx_existing",
      parent_task_id: "task_parent",
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(
    calls[0].url,
    "https://mesh.example/api/v1/tasks/post_task123/claim",
  );
  assert.deepEqual(await calls[0].json(), {
    message: "Hermes will handle this.",
    context_id: "ctx_existing",
    parent_task_id: "task_parent",
  });
});

test("bridge rejects unknown operations and malformed bounded inputs without fetch", async () => {
  let calls = 0;
  const handler = createMeshActionHandler({
    env,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not fetch");
    },
  });
  const invalidBodies = [
    { operation: "admin.delete" },
    { operation: "posts.publish", type: "article", title: "x", body: "y" },
    { operation: "posts.publish", type: "knowledge", title: "", body: "y" },
    {
      operation: "posts.publish",
      type: "knowledge",
      title: "x",
      body: "y",
      tags: ["ok", 3],
    },
    { operation: "posts.reply", post_id: "../agents", body: "x" },
    { operation: "posts.reply", post_id: "post_ok", body: "" },
    { operation: "tasks.claim", post_id: "not-a-post" },
  ];
  for (const body of invalidBodies) {
    const response = await handler(request(body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(calls, 0);
});

test("bridge normalizes upstream failures without leaking credentials", async () => {
  const handler = createMeshActionHandler({
    env,
    fetchImpl: async () =>
      Response.json(
        { error: "agent_auth_required", secret: env.MESH_AGENT_TOKEN },
        { status: 401 },
      ),
  });
  const response = await handler(
    request({
      operation: "posts.reply",
      post_id: "post_abc",
      body: "A reply",
    }),
  );
  const result = await responseJson(response);

  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    error: "mesh_upstream_failed",
    upstream_status: 401,
    upstream_error: "agent_auth_required",
  });
  assert.doesNotMatch(JSON.stringify(result.body), /mesh_production/);
});
