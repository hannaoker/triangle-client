import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveWorkerConfig } from "../src/cli.mjs";

const raw = {
  meshUrlEnv: "MESH_URL",
  meshTokenEnv: "MESH_TOKEN",
  agentIdEnv: "AGENT_ID",
  pollIntervalMs: 100,
  maxBackoffMs: 400,
  runnerTimeoutMs: 200,
  pageLimit: 2,
  runner: { module: "./adapter.mjs" },
};
const env = {
  MESH_URL: "https://mesh.example",
  MESH_TOKEN: "mesh-secret",
  AGENT_ID: "agent_11111111111111111111111111111111",
};

test("worker configuration is mailbox-only and resolves exact selectors", () => {
  const config = resolveWorkerConfig(raw, "/tmp/config/worker.json", env);
  assert.deepEqual(config.mailbox, {
    meshUrl: "https://mesh.example",
    meshToken: "mesh-secret",
    recipientId: "agent_11111111111111111111111111111111",
    pageLimit: 2,
  });
  assert.equal("transport" in config, false);
  assert.equal("gateway" in config, false);
  assert.deepEqual(config.runner.args, ["/tmp/config/adapter.mjs"]);
});

test("worker configuration rejects deprecated selectors and every unknown key", () => {
  for (const extra of [
    { transport: "mailbox" },
    { transport: "gateway" },
    { gatewayUrlEnv: "GATEWAY_URL" },
    { gatewayTokenEnv: "GATEWAY_TOKEN" },
    { unexpected: true },
  ]) {
    assert.throws(
      () => resolveWorkerConfig({ ...raw, ...extra }, "/tmp/config.json", env),
      /is not supported/,
    );
  }
});

test("worker configuration rejects missing selectors, secrets, URLs, identities, and bounds", () => {
  for (const key of ["meshUrlEnv", "meshTokenEnv", "agentIdEnv"]) {
    const candidate = { ...raw };
    delete candidate[key];
    assert.throws(
      () => resolveWorkerConfig(candidate, "/tmp/config.json", env),
      new RegExp(`${key} is required`),
    );
  }
  for (const [overrides, environment, pattern] of [
    [{}, { ...env, MESH_TOKEN: " " }, /MESH_TOKEN is required/],
    [{}, { ...env, MESH_URL: "http://public.example" }, /meshUrl must use HTTPS/],
    [{}, { ...env, MESH_URL: "https://mesh.example/path" }, /meshUrl must use HTTPS/],
    [{}, { ...env, AGENT_ID: "agent_test" }, /agentId is invalid/],
    [{ pageLimit: 0 }, env, /pageLimit must be between 1 and 100/],
    [{ pageLimit: 101 }, env, /pageLimit must be between 1 and 100/],
  ]) {
    assert.throws(
      () => resolveWorkerConfig({ ...raw, ...overrides }, "/tmp/config.json", environment),
      pattern,
    );
  }
});

test("package and CLI source contain no deprecated gateway transport", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    ".",
    "./client-supervisor",
    "./concurrency-gate",
    "./mailbox-client",
    "./outbound-client",
    "./profile-scheduler",
    "./wake-client",
  ]);
  const source = await readFile(new URL("../src/cli.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /gateway-client|createGatewayClient|gatewayUrlEnv|gatewayTokenEnv|\/inbox|internal\/tasks\/update/);
});
