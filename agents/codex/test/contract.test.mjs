import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import defaultApp, { createGatewayApp } from "../api/gateway.mjs";
import { createOutboundA2AHandler } from "@the-triangle/a2a-gateway/outbound-a2a";

const REQUIRED_ROUTES = [
  "/.well-known/agent-card.json",
  "/.well-known/mesh-proof.json",
  "/health",
  "/api/v1",
  "/internal/a2a/outbound",
];

const DIRECT_ROUTE_MODULES = [
  ["../app/.well-known/agent-card.json/route.mjs", "GET"],
  ["../app/.well-known/mesh-proof.json/route.mjs", "GET"],
  ["../app/health/route.mjs", "GET"],
  ["../app/api/v1/route.mjs", "POST"],
  ["../app/internal/a2a/outbound/route.mjs", "POST"],
];

const OBSOLETE_PRIVATE_ROUTES = [
  ["../app/inbox/route.mjs", "/inbox/route"],
  ["../app/inbox/ack/route.mjs", "/inbox/ack/route"],
  ["../app/internal/tasks/update/route.mjs", "/internal/tasks/update/route"],
];

const REQUIRED_ENV = [
  "CODEX_AGENT_ID",
  "MESH_ORIGIN",
  "MESH_AGENT_TOKEN",
  "MESH_REGISTRATION_NONCE",
];

function validEnv(overrides = {}) {
  return {
    CODEX_AGENT_ID: "agent_11111111111111111111111111111111",
    MESH_ORIGIN: "https://mesh.example",
    MESH_AGENT_TOKEN: "mesh_test_agent_token",
    MESH_REGISTRATION_NONCE: "test-registration-nonce",
    AGENT_ORIGIN: "https://codex.example",
    GATEWAY_INTERNAL_TOKEN: "codex-worker-secret-with-enough-entropy",
    ...overrides,
  };
}

function dependencies() {
  const calls = {};
  return {
    calls,
    createBridgeImpl(options) {
      calls.bridge = options;
      return {
        sendMessage: async () => ({}),
        getTask: async () => ({}),
        listTasks: async () => ({ tasks: [], nextCursor: null }),
      };
    },
    createIntrospectorImpl(options) {
      calls.introspector = options;
      return async () => null;
    },
    fetchImpl: async () => {
      throw new Error("contract test must not use the network");
    },
  };
}

test("Codex app exports a default Web Handler with distinct identity and skills", async () => {
  assert.equal(typeof defaultApp?.fetch, "function");
  const deps = dependencies();
  const app = createGatewayApp({ env: validEnv(), ...deps });
  const response = await app.fetch(
    new Request("https://codex.example/.well-known/agent-card.json"),
  );
  const card = await response.json();

  assert.equal(response.status, 200);
  assert.equal(card.name, "Codex");
  assert.equal(card.supportedInterfaces[0].url, "https://codex.example/api/v1");
  assert.deepEqual(
    card.skills.map((skill) => skill.id),
    ["software-engineering", "agent-coordination", "direct-messages"],
  );
});

test("Codex wrapper does not allow dependency injection to replace its identity", async () => {
  const app = createGatewayApp({
    env: validEnv(),
    ...dependencies(),
    gatewayKey: "impostor",
    profile: { name: "Impostor", skills: [] },
  });
  const card = await (
    await app.fetch(
      new Request("https://codex.example/.well-known/agent-card.json"),
    )
  ).json();
  assert.equal(card.name, "Codex");
});

test("Codex app constructs its stateless MESH projection and introspection from injected dependencies", async () => {
  const deps = dependencies();
  const fetchImpl = deps.fetchImpl;
  const app = createGatewayApp({ env: validEnv(), ...deps });

  assert.equal(deps.calls.introspector.meshOrigin, "https://mesh.example");
  assert.equal(deps.calls.introspector.agentToken, "mesh_test_agent_token");
  assert.equal(deps.calls.introspector.fetchImpl, fetchImpl);

  const health = await app.fetch(new Request("https://codex.example/health"));
  assert.equal(health.status, 200);
  assert.equal(deps.calls.bridge.recipientAgentId, validEnv().CODEX_AGENT_ID);
});

test("Codex app validates required environment without exposing secrets to the client", () => {
  for (const name of REQUIRED_ENV) {
    const env = validEnv();
    delete env[name];
    assert.throws(
      () => createGatewayApp({ env, ...dependencies() }),
      new RegExp(`${name} is required`),
    );
  }
  const env = validEnv();
  delete env.AGENT_ORIGIN;
  delete env.VERCEL_PROJECT_PRODUCTION_URL;
  assert.throws(
    () => createGatewayApp({ env, ...dependencies() }),
    /AGENT_ORIGIN or VERCEL_PROJECT_PRODUCTION_URL is required/,
  );
});

test("Codex app safely derives its origin from Vercel production URL", async () => {
  const deps = dependencies();
  const env = validEnv({
    AGENT_ORIGIN: "",
    VERCEL_PROJECT_PRODUCTION_URL: "codex-production.vercel.app",
  });
  const app = createGatewayApp({ env, ...deps });
  const response = await app.fetch(
    new Request("https://preview.invalid/.well-known/agent-card.json"),
  );
  const card = await response.json();
  assert.equal(
    card.supportedInterfaces[0].url,
    "https://codex-production.vercel.app/api/v1",
  );
});

test("Codex exposes every gateway endpoint through a direct Next.js route module", async () => {
  for (const [path, method] of DIRECT_ROUTE_MODULES) {
    const route = await import(new URL(path, import.meta.url));
    assert.equal(typeof route[method], "function", `${path} must export ${method}`);
  }
});

test("Codex removes obsolete private worker routes from source and built manifests", async () => {
  for (const [path] of OBSOLETE_PRIVATE_ROUTES) {
    await assert.rejects(readFile(new URL(path, import.meta.url)));
  }
  try {
    const manifest = JSON.parse(await readFile(
      new URL("../.next/server/app-paths-manifest.json", import.meta.url),
      "utf8",
    ));
    for (const [, route] of OBSOLETE_PRIVATE_ROUTES) {
      assert.equal(Object.hasOwn(manifest, route), false, `${route} must not be built`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
});

test("Codex inbound worker uses only canonical MESH mailbox configuration", async () => {
  const config = JSON.parse(await readFile(
    new URL("../worker/agent-worker.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(config, {
    meshUrlEnv: "MESH_ORIGIN",
    meshTokenEnv: "MESH_AGENT_TOKEN",
    agentIdEnv: "CODEX_AGENT_ID",
    pollIntervalMs: 15000,
    maxBackoffMs: 300000,
    runnerTimeoutMs: 600000,
    pageLimit: 1,
    runner: { module: "../../../packages/agent-worker/runners/codex-runner.mjs" },
  });
  assert.doesNotMatch(JSON.stringify(config), /gateway|transport/i);
  const documentation = await readFile(new URL("../worker/README.md", import.meta.url), "utf8");
  for (const variable of ["MESH_ORIGIN", "MESH_AGENT_TOKEN", "CODEX_AGENT_ID"]) {
    assert.match(documentation, new RegExp(variable));
  }
  assert.match(documentation, /polls (?:its )?MESH mailbox/i);
  assert.match(documentation, /agent_[a-f0-9]{32}/);
  assert.match(documentation, /public A2A.*compatib/i);
});

test("Codex outbound CLI selects compatibility credentials without coupling to mailbox config", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["agent-send"],
    "node --env-file-if-exists=worker/.env.local ../../packages/agent-worker/src/outbound-cli.mjs --gateway-url-env AGENT_ORIGIN --internal-token-env GATEWAY_INTERNAL_TOKEN",
  );
  assert.doesNotMatch(packageJson.scripts["agent-send"], /--config|MESH_ORIGIN|MESH_AGENT_TOKEN/);
});

test("Codex Vercel config uses Next.js without forbidden well-known rewrites", async () => {
  const config = JSON.parse(
    await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  );
  assert.equal(config.framework, "nextjs");
  assert.ok(
    !(config.rewrites || []).some((rewrite) =>
      rewrite.source.startsWith("/.well-known"),
    ),
  );
  assert.equal(REQUIRED_ROUTES.length, DIRECT_ROUTE_MODULES.length);
});

test("Codex environment template contains server-only gateway variables and no credentials", async () => {
  const template = await readFile(
    new URL("../.env.example", import.meta.url),
    "utf8",
  );
  const entries = Object.fromEntries(
    template.trim().split("\n").map((line) => line.split("=", 2)),
  );
  assert.deepEqual(Object.keys(entries).sort(), [...REQUIRED_ENV, "AGENT_ORIGIN", "GATEWAY_INTERNAL_TOKEN"].sort());
  assert.ok(Object.values(entries).every((value) => value === ""));
  assert.equal(entries.CODEX_AGENT_ID, "");
  assert.equal(entries.GATEWAY_INTERNAL_TOKEN, "");
  assert.doesNotThrow(() => createGatewayApp({ env: validEnv(), ...dependencies() }));
  assert.doesNotThrow(() => createOutboundA2AHandler({ env: validEnv(), fetchImpl: async () => assert.fail("constructor must not fetch") }));
  for (const name of ["MESH_ORIGIN", "MESH_AGENT_TOKEN", "MESH_REGISTRATION_NONCE", "AGENT_ORIGIN"]) {
    assert.match(template, new RegExp(`^${name}=$`, "m"));
  }
  assert.doesNotMatch(template, /^TURSO_(?:DATABASE_URL|AUTH_TOKEN)=/m);
  assert.doesNotMatch(template, /NEXT_PUBLIC_|OPENAI|ANTHROPIC|GOOGLE_API_KEY/);

  const source = await readFile(
    new URL("../api/gateway.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /NEXT_PUBLIC_/);
  assert.doesNotMatch(source, /mesh_[A-Za-z0-9_-]{12,}/);
  assert.doesNotMatch(source, /libsql:\/\/[^"'`\s]+/);
});
