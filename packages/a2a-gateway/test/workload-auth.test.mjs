import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import { canonicalJson } from "../../triangle-cli/src/canonical.mjs";
import { generateEd25519 } from "../../triangle-cli/src/keys.mjs";
import { createConfiguredGatewayApp } from "../src/app-factory.mjs";
import { createMeshMailboxBridge } from "../src/mesh-mailbox-bridge.mjs";
import { createOutboundA2AHandler } from "../src/outbound-a2a.mjs";
import { createWorkloadAuth, workloadFetch } from "../src/workload-auth.mjs";
import { TEST_WORKLOAD_ENV, testMeshAuth } from "./support/mesh-auth.mjs";

const require = createRequire(import.meta.url);
const { createMeshPeerIntrospector } = require("../src/protocol.cjs");
const MESH = "https://mesh.example";
const WORKLOAD = "workload_11111111111111111111111111111111";
const AGENT = "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fakeMesh(key) {
  const calls = [];
  let issued = 0;
  let reject401 = 0;
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const body = request.method === "GET" ? null : await request.json();
    calls.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body });
    if (url.pathname === "/api/v1/identity/token-challenges") {
      return Response.json({ challenge: { challenge_id: `c${issued}`, principal_id: AGENT, audience: MESH, nonce: `n${issued}` } }, { status: 201 });
    }
    if (url.pathname === "/api/v1/identity/tokens") {
      const [h, p, sig] = body.proof.split(".");
      const ok = crypto.verify(null, Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), Buffer.from(sig, "base64url"));
      if (!ok || Buffer.from(p, "base64url").toString() !== canonicalJson(JSON.parse(Buffer.from(p, "base64url")))) return Response.json({ error: "invalid_workload_proof" }, { status: 401 });
      return Response.json({ access_token: `tok_${issued++}`, token_type: "DPoP", expires_in: 300 });
    }
    if (reject401 > 0) { reject401 -= 1; return Response.json({ error: "agent_auth_required" }, { status: 401 }); }
    return Response.json({ ok: true });
  };
  return { calls, fetchImpl, rejectNext: () => { reject401 += 1; } };
}

test("workload auth: canonical proof under agent scopes, DPoP htu = full URL, one fresh exchange after 401", async () => {
  const key = generateEd25519();
  const mesh = fakeMesh(key);
  const auth = createWorkloadAuth({ meshOrigin: MESH, workloadId: WORKLOAD, workloadPrivateKey: JSON.stringify(key), fetchImpl: mesh.fetchImpl });
  const url = `${MESH}/api/v1/a2a/tasks?limit=5`;
  const first = await workloadFetch(auth, mesh.fetchImpl, url);
  assert.equal(first.status, 200);
  const tokenCall = mesh.calls.find((c) => c.url.endsWith("/identity/tokens"));
  assert.deepEqual(tokenCall.body.requested_scopes, ["agent.read", "agent.write"]);
  const call = mesh.calls.at(-1);
  assert.equal(call.headers.authorization, "Bearer tok_0");
  const dpop = JSON.parse(Buffer.from(call.headers.dpop.split(".")[1], "base64url"));
  assert.equal(dpop.htu, url);
  assert.equal(dpop.htm, "GET");
  mesh.rejectNext();
  assert.equal((await workloadFetch(auth, mesh.fetchImpl, url, { method: "POST", body: "{}" })).status, 200);
  assert.equal(mesh.calls.at(-1).headers.authorization, "Bearer tok_1", "re-exchanged after 401");
  assert.equal(await auth.agentId(), AGENT);
});

test("workload auth refuses malformed ids and keys; the gateway refuses the retired MESH_AGENT_TOKEN", () => {
  assert.throws(() => createWorkloadAuth({ meshOrigin: MESH, workloadId: "workload_x", workloadPrivateKey: TEST_WORKLOAD_ENV.MESH_WORKLOAD_PRIVATE_KEY }), /MESH_WORKLOAD_ID/);
  assert.throws(() => createWorkloadAuth({ meshOrigin: MESH, workloadId: WORKLOAD, workloadPrivateKey: "mesh_abc" }), /MESH_WORKLOAD_PRIVATE_KEY/);
  const env = { MESH_ORIGIN: MESH, ...TEST_WORKLOAD_ENV, MESH_REGISTRATION_NONCE: "n", AGENT_ORIGIN: "https://agent.example", CODEX_AGENT_ID: AGENT };
  assert.throws(() => createConfiguredGatewayApp({ gatewayKey: "codex", profile: {}, env: { ...env, MESH_AGENT_TOKEN: "mesh_x" } }), /MESH_AGENT_TOKEN is retired/);
  assert.throws(() => createOutboundA2AHandler({ env: { GATEWAY_INTERNAL_TOKEN: "internal-token-with-sufficient-entropy", MESH_ORIGIN: MESH, MESH_AGENT_TOKEN: "mesh_x" } }), /MESH_AGENT_TOKEN is retired/);
});

test("introspection authenticates with the workload credential and retries once after 401", async () => {
  const seen = [];
  let first = true;
  const auth = testMeshAuth("tok");
  const introspect = createMeshPeerIntrospector({
    meshOrigin: MESH,
    meshAuth: auth,
    fetchImpl: async (url, init) => {
      seen.push(new Headers(init.headers));
      if (first) { first = false; return Response.json({ error: "agent_auth_required" }, { status: 401 }); }
      return Response.json({ active: true, sender: { id: "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "B" }, scopes: ["a2a.send"] });
    },
  });
  const result = await introspect("mesh_peer_ticket");
  assert.equal(result.sender.name, "B");
  assert.deepEqual(auth.calls.map((c) => c.refresh), [false, true]);
  assert.equal(seen[1].get("dpop"), "test-dpop.POST");
  assert.equal(await createMeshPeerIntrospector({ meshOrigin: MESH, fetchImpl: async () => { throw new Error("no call"); } })("mesh_peer_x"), null, "no credential → no introspection");
});

test("outbound: the sender's permission_denied (dm.send off) is a 403 naming the permission", async () => {
  const peerId = `agent_${"c".repeat(32)}`;
  const handler = createOutboundA2AHandler({
    env: { GATEWAY_INTERNAL_TOKEN: "internal-token-with-sufficient-entropy", MESH_ORIGIN: MESH, ...TEST_WORKLOAD_ENV },
    createWorkloadAuthImpl: () => testMeshAuth(),
    fetchImpl: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === `/api/v1/agents/${peerId}`) {
        return Response.json({ agent: { id: peerId, endpointUrl: "https://peer.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0", conformanceStatus: "verified", conformanceReport: JSON.stringify({ method: "SendMessage", responseKind: "task" }) } });
      }
      if (path === "/api/v1/peer-tokens") return Response.json({ error: "permission_denied", permission: "dm.send" }, { status: 403 });
      throw new Error(`unexpected ${path}`);
    },
  });
  const response = await handler(new Request("https://sender.example/internal/a2a/outbound", {
    method: "POST",
    headers: { authorization: "Bearer internal-token-with-sufficient-entropy", "content-type": "application/json" },
    body: JSON.stringify({ operation: "send", recipient_agent_id: peerId, text: "hi", message_id: "msg_1", context_id: "ctx_1" }),
  }));
  const body = await response.json();
  assert.equal(response.status, 403, JSON.stringify(body));
  assert.deepEqual(body, { error: "permission_denied", permission: "dm.send" });
});

test("bridge: permission_denied from MESH keeps its code and permission", async () => {
  const bridge = createMeshMailboxBridge({
    meshOrigin: MESH,
    recipientAgentId: AGENT,
    meshAuth: testMeshAuth(),
    fetchImpl: async () => Response.json({ error: "permission_denied", permission: "dm.receive" }, { status: 403 }),
  });
  const error = await bridge.listTasks({ senderAgentId: `agent_${"b".repeat(32)}`, limit: 1 }).catch((e) => e);
  assert.equal(error.code, "permission_denied");
  assert.equal(error.permission, "dm.receive");
});

function refusingExchange(status, payload) {
  const seen = [];
  return {
    seen,
    fetchImpl: async (request) => {
      const path = new URL(request.url).pathname;
      seen.push(path);
      if (path === "/api/v1/identity/token-challenges") return Response.json(payload, { status });
      // The peer card is public; only the ticket needs the workload credential.
      if (path.startsWith("/api/v1/agents/agent_")) {
        const id = path.split("/").at(-1);
        return Response.json({ agent: { id, endpointUrl: "https://peer.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0", conformanceStatus: "verified", conformanceReport: JSON.stringify({ method: "SendMessage", responseKind: "task" }) } });
      }
      throw new Error(`unexpected ${path}`);
    },
  };
}

test("token-exchange refusals keep an allowlisted cause (not an outage) and never echo MESH free text", async () => {
  const mesh = refusingExchange(403, { error: "workload_forbidden", message: "free text sk_live_should_not_leak" });
  const realAuth = (options) => createWorkloadAuth({ ...options, fetchImpl: mesh.fetchImpl });
  const handler = createOutboundA2AHandler({
    env: { GATEWAY_INTERNAL_TOKEN: "internal-token-with-sufficient-entropy", MESH_ORIGIN: MESH, ...TEST_WORKLOAD_ENV },
    createWorkloadAuthImpl: realAuth,
    fetchImpl: mesh.fetchImpl,
  });
  const response = await handler(new Request("https://sender.example/internal/a2a/outbound", {
    method: "POST",
    headers: { authorization: "Bearer internal-token-with-sufficient-entropy", "content-type": "application/json" },
    body: JSON.stringify({ operation: "send", recipient_agent_id: `agent_${"c".repeat(32)}`, text: "hi", message_id: "msg_1", context_id: "ctx_1" }),
  }));
  const body = await response.json();
  assert.equal(response.status, 502, JSON.stringify(body));
  assert.deepEqual(body, { error: "mesh_auth_failed", upstream_status: 403, upstream_error: "workload_forbidden" });

  const odd = refusingExchange(400, { error: "sk_live_should_not_leak" });
  const bridge = createMeshMailboxBridge({
    meshOrigin: MESH,
    recipientAgentId: AGENT,
    meshAuth: createWorkloadAuth({ meshOrigin: MESH, workloadId: TEST_WORKLOAD_ENV.MESH_WORKLOAD_ID, workloadPrivateKey: TEST_WORKLOAD_ENV.MESH_WORKLOAD_PRIVATE_KEY, fetchImpl: odd.fetchImpl }),
    fetchImpl: odd.fetchImpl,
  });
  const error = await bridge.listTasks({ senderAgentId: `agent_${"b".repeat(32)}`, limit: 1 }).catch((e) => e);
  assert.equal(error.code, "mesh_auth_failed");
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /sk_live/);

  const paused = refusingExchange(403, { error: "agent_paused" });
  const pausedBridge = createMeshMailboxBridge({
    meshOrigin: MESH,
    recipientAgentId: AGENT,
    meshAuth: createWorkloadAuth({ meshOrigin: MESH, workloadId: TEST_WORKLOAD_ENV.MESH_WORKLOAD_ID, workloadPrivateKey: TEST_WORKLOAD_ENV.MESH_WORKLOAD_PRIVATE_KEY, fetchImpl: paused.fetchImpl }),
    fetchImpl: paused.fetchImpl,
  });
  const pausedError = await pausedBridge.listTasks({ senderAgentId: `agent_${"b".repeat(32)}`, limit: 1 }).catch((e) => e);
  assert.equal(pausedError.code, "agent_paused");
  assert.equal(pausedError.status, 403);
});

// A read-only agent (`triangle agent add --read-only`) is registered with
// bounds ["agent.read"]. MESH refuses any request beyond the bounds with
// `workload_forbidden` and never narrows it, so the gateway must ask for
// exactly its registered bounds (MESH_WORKLOAD_SCOPES).
function readOnlyMesh() {
  const calls = [];
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const body = request.method === "GET" ? null : await request.json();
    calls.push({ url: request.url, body });
    if (url.pathname === "/api/v1/identity/token-challenges") {
      return Response.json({ challenge: { challenge_id: "c0", principal_id: AGENT, audience: MESH, nonce: "n0" } }, { status: 201 });
    }
    if (url.pathname === "/api/v1/identity/tokens") {
      const signed = JSON.parse(Buffer.from(body.proof.split(".")[1], "base64url")).requested_scopes;
      if ([...body.requested_scopes, ...signed].some((scope) => scope !== "agent.read")) {
        return Response.json({ error: "workload_forbidden" }, { status: 403 });
      }
      return Response.json({ access_token: "tok_ro", token_type: "DPoP", expires_in: 300 });
    }
    return Response.json({ ok: true });
  };
  return { calls, fetchImpl };
}

test("workload auth: a read-only agent requests only its registered agent.read bound", async () => {
  const key = generateEd25519();
  const mesh = readOnlyMesh();
  const auth = createWorkloadAuth({ meshOrigin: MESH, workloadId: WORKLOAD, workloadPrivateKey: JSON.stringify(key), scopes: "agent.read", fetchImpl: mesh.fetchImpl });
  assert.equal((await workloadFetch(auth, mesh.fetchImpl, `${MESH}/api/v1/agents/me`)).status, 200);
  const tokenCall = mesh.calls.find((c) => c.url.endsWith("/identity/tokens"));
  assert.deepEqual(tokenCall.body.requested_scopes, ["agent.read"]);
  assert.deepEqual(JSON.parse(Buffer.from(tokenCall.body.proof.split(".")[1], "base64url")).requested_scopes, ["agent.read"], "signed scopes match");

  // Without the bound the old behavior (both scopes) is refused by MESH.
  const unbounded = createWorkloadAuth({ meshOrigin: MESH, workloadId: WORKLOAD, workloadPrivateKey: JSON.stringify(key), fetchImpl: readOnlyMesh().fetchImpl });
  await assert.rejects(() => unbounded.headers("GET", `${MESH}/api/v1/agents/me`), (error) => /workload_forbidden|403/.test(`${error.code ?? ""} ${error.status ?? ""} ${error.message}`));

  // Invalid bounds fail closed at construction.
  for (const scopes of ["", "agent.admin", "agent.read,agent.read", []]) {
    assert.throws(() => createWorkloadAuth({ meshOrigin: MESH, workloadId: WORKLOAD, workloadPrivateKey: JSON.stringify(key), scopes, fetchImpl: mesh.fetchImpl }), /MESH_WORKLOAD_SCOPES/);
  }
});

test("gateway entry points pass MESH_WORKLOAD_SCOPES through as the registered bounds", () => {
  const seen = [];
  const capture = (options) => { seen.push(options.scopes); return testMeshAuth(); };
  createOutboundA2AHandler({
    env: { ...TEST_WORKLOAD_ENV, GATEWAY_INTERNAL_TOKEN: "internal", MESH_ORIGIN: MESH, MESH_WORKLOAD_SCOPES: "agent.read" },
    fetchImpl: async () => Response.json({}),
    createWorkloadAuthImpl: capture,
  });
  createOutboundA2AHandler({
    env: { ...TEST_WORKLOAD_ENV, GATEWAY_INTERNAL_TOKEN: "internal", MESH_ORIGIN: MESH },
    fetchImpl: async () => Response.json({}),
    createWorkloadAuthImpl: capture,
  });
  assert.deepEqual(seen, ["agent.read", undefined]);
});

test("workloadFetch does not retry a streamed body after 401, and one caller's abort does not cancel the shared exchange", async () => {
  const key = generateEd25519();
  const mesh = fakeMesh(key);
  const auth = createWorkloadAuth({ meshOrigin: MESH, workloadId: WORKLOAD, workloadPrivateKey: JSON.stringify(key), fetchImpl: mesh.fetchImpl });
  const url = `${MESH}/api/v1/a2a/tasks`;
  await workloadFetch(auth, mesh.fetchImpl, url);
  mesh.rejectNext();
  const streamed = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); } });
  const before = mesh.calls.length;
  const response = await workloadFetch(auth, mesh.fetchImpl, url, { method: "POST", body: streamed, duplex: "half" });
  assert.equal(response.status, 401, "401 is returned, not retried with a consumed stream");
  assert.equal(mesh.calls.length - before, 1);

  const fresh = createWorkloadAuth({ meshOrigin: MESH, workloadId: WORKLOAD, workloadPrivateKey: JSON.stringify(key), fetchImpl: mesh.fetchImpl });
  const aborted = new AbortController();
  const first = fresh.headers("GET", url, { signal: aborted.signal });
  const second = fresh.headers("GET", url);
  aborted.abort(new Error("caller gone"));
  await assert.rejects(first, /caller gone/);
  const headers = await second;
  assert.match(headers.authorization, /^Bearer tok_/, "the other waiter still gets its token");
});
