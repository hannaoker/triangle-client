import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createConfiguredGatewayApp } from "../src/app-factory.mjs";

const workspaceRoot = new URL("../../../", import.meta.url);

test("deployment app factory has no gateway-local database dependency", async () => {
  const source = await readFile(
    new URL("../src/app-factory.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /@libsql\/client/);
  assert.match(source, /createMeshMailboxBridge/);
  assert.doesNotMatch(source, /createTursoCorrelationStore|createTursoStateStore/);
  assert.doesNotMatch(source, /GATEWAY_INTERNAL_TOKEN/);
});

test("gateway builds have no obsolete LibSQL trace-verifier coupling", async () => {
  for (const app of ["codex", "hermes"]) {
    const manifest = JSON.parse(
      await readFile(new URL(`agents/${app}/package.json`, workspaceRoot), "utf8"),
    );
    assert.equal(
      manifest.scripts.build,
      "next build",
    );
  }
  await assert.rejects(
    readFile(new URL("../scripts/verify-next-traces.mjs", import.meta.url)),
    { code: "ENOENT" },
  );
});

function gatewayEnv(identityName, identity) {
  return {
    MESH_ORIGIN: "https://mesh.example",
    MESH_AGENT_TOKEN: "mesh_agent_token",
    MESH_REGISTRATION_NONCE: "nonce",
    AGENT_ORIGIN: "https://agent.example",
    [identityName]: identity,
  };
}

function bridgeDependencies(record, createBridgeImpl) {
  return {
    createIntrospectorImpl: () => async () => null,
    createBridgeImpl: createBridgeImpl ?? ((options) => {
      record.push(options.recipientAgentId);
      return {
        sendMessage: async () => ({}),
        getTask: async () => ({}),
        listTasks: async () => ({ tasks: [], nextCursor: null }),
      };
    }),
  };
}

test("Codex and Hermes wrappers use their trusted canonical MESH identity inputs", async () => {
  for (const [app, identityName, identity] of [
    ["codex", "CODEX_AGENT_ID", "agent_11111111111111111111111111111111"],
    ["hermes", "HERMES_AGENT_ID", "agent_22222222222222222222222222222222"],
  ]) {
    const { createGatewayApp } = await import(new URL(`../../../agents/${app}/api/gateway.mjs`, import.meta.url));
    const recipients = [];
    const gateway = createGatewayApp({
      env: gatewayEnv(identityName, identity),
      ...bridgeDependencies(recipients),
    });
    assert.equal((await gateway.fetch(new Request("https://agent.example/health"))).status, 200);
    assert.deepEqual(recipients, [identity]);
    for (const invalid of [undefined, "agent_codex", "agent_ABCDEF11111111111111111111111111"]) {
      const env = gatewayEnv(identityName, invalid);
      if (invalid === undefined) delete env[identityName];
      assert.throws(() => createGatewayApp({ env, ...bridgeDependencies([]) }), new RegExp(identityName));
    }
  }
});

test("rejected bridge initialization clears the single-flight cache for retry", async () => {
  let attempts = 0;
  const gateway = createConfiguredGatewayApp({
    gatewayKey: "codex",
    profile: { name: "Codex" },
    env: gatewayEnv("CODEX_AGENT_ID", "agent_11111111111111111111111111111111"),
    ...bridgeDependencies([], () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary initialization failure");
      return {
        sendMessage: async () => ({}),
        getTask: async () => ({}),
        listTasks: async () => ({ tasks: [], nextCursor: null }),
      };
    }),
  });
  const [first, concurrent] = await Promise.all([
    gateway.fetch(new Request("https://agent.example/health")),
    gateway.fetch(new Request("https://agent.example/health")),
  ]);
  assert.equal(first.status, 503);
  assert.equal(concurrent.status, 503);
  assert.equal(attempts, 1);
  assert.equal((await gateway.fetch(new Request("https://agent.example/health"))).status, 200);
  assert.equal(attempts, 2);
});

test("production handlers contain no legacy mutable projection path", async () => {
  const [serverSource, vercelSource] = await Promise.all([
    readFile(new URL("../src/server.cjs", import.meta.url), "utf8"),
    readFile(new URL("../src/vercel-handler.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of [serverSource, vercelSource]) {
    assert.doesNotMatch(source, /legacyStateMode|stateStoreFactory|createStateStore/);
    assert.doesNotMatch(source, /url\.pathname === "\/(?:inbox|inbox\/ack|internal\/tasks\/update)"/);
  }
});
