import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveWorkerConfig } from "../src/cli.mjs";
import { TEST_WORKLOAD } from "./support/test-workload.mjs";

const AGENT = "agent_11111111111111111111111111111111";
// A triangle custody layout in a temp dir: agents/<id>/{workload-key.json,agent.json}, 0600.
function custody({ agentId = AGENT, keyMode = 0o600, agentJson = { agent_id: agentId, workload_id: TEST_WORKLOAD.workloadId } } = {}) {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "worker-cli-")), "agents", agentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, "workload-key.json");
  writeFileSync(keyFile, TEST_WORKLOAD.workloadPrivateKey, { mode: 0o600 });
  chmodSync(keyFile, keyMode);
  writeFileSync(path.join(dir, "agent.json"), JSON.stringify(agentJson), { mode: 0o600 });
  return keyFile;
}

const raw = {
  meshUrlEnv: "MESH_URL",
  workloadKeyFileEnv: "TRIANGLE_WORKLOAD_KEY_FILE",
  agentIdEnv: "AGENT_ID",
  pollIntervalMs: 100,
  maxBackoffMs: 400,
  runnerTimeoutMs: 200,
  pageLimit: 2,
  runner: { module: "./adapter.mjs" },
};
const env = {
  MESH_URL: "https://mesh.example",
  TRIANGLE_WORKLOAD_KEY_FILE: custody(),
  AGENT_ID: AGENT,
};

test("worker configuration is mailbox-only and resolves exact selectors", () => {
  const config = resolveWorkerConfig(raw, "/tmp/config/worker.json", env);
  assert.deepEqual(config.mailbox, {
    meshUrl: "https://mesh.example",
    recipientId: AGENT,
    pageLimit: 2,
    workloadId: TEST_WORKLOAD.workloadId,
    workloadPrivateKey: TEST_WORKLOAD.workloadPrivateKey,
    workloadScopes: ["agent.read", "agent.write"],
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
  for (const key of ["meshUrlEnv", "workloadKeyFileEnv", "agentIdEnv"]) {
    const candidate = { ...raw };
    delete candidate[key];
    assert.throws(
      () => resolveWorkerConfig(candidate, "/tmp/config.json", env),
      new RegExp(`${key} is required`),
    );
  }
  for (const [overrides, environment, pattern] of [
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: " " }, /TRIANGLE_WORKLOAD_KEY_FILE is required/],
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: "relative/key.json" }, /absolute path/],
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: custody({ keyMode: 0o644 }) }, /chmod 600/],
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: custody({ agentId: "agent_22222222222222222222222222222222" }) }, /different agent/],
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: custody({ agentJson: { agent_id: AGENT } }) }, /agent\.json is invalid/],
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: (() => { const real = custody(); const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "worker-cli-")), "agents", AGENT); mkdirSync(dir, { recursive: true, mode: 0o700 }); const link = path.join(dir, "workload-key.json"); symlinkSync(real, link); return link; })() }, /regular file/],
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: (() => { const real = custody(); linkSync(real, `${real}.second`); return real; })() }, /hard links/],
    // Parent directories match Swift V1PrivateDirectory: agents/ must be a real 0700 directory.
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: (() => { const real = custody(); chmodSync(path.dirname(path.dirname(real)), 0o755); return real; })() }, /agents\/ directory must not be accessible by group or others/],
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: (() => { const real = custody(); chmodSync(path.dirname(real), 0o750); return real; })() }, /agent custody directory must not be accessible/],
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: (() => {
      // A symlinked agents/ parent: O_NOFOLLOW only guards the last component, so the loader must lstat each parent.
      const real = custody();
      const home = mkdtempSync(path.join(os.tmpdir(), "worker-cli-link-"));
      symlinkSync(path.dirname(path.dirname(real)), path.join(home, "agents"));
      return path.join(home, "agents", AGENT, "workload-key.json");
    })() }, /agents\/ directory must be a real directory/],
    [{}, { ...env, TRIANGLE_WORKLOAD_KEY_FILE: (() => { const real = custody(); const other = path.join(path.dirname(path.dirname(path.dirname(real))), "keys", AGENT); mkdirSync(other, { recursive: true, mode: 0o700 }); return path.join(other, "workload-key.json"); })() }, /not under the custody agents\/ directory/],
    [{ meshTokenEnv: "MESH_AGENT_TOKEN" }, env, /meshTokenEnv is not supported/],
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
    "./app-server-host-support",
    "./client-supervisor",
    "./concurrency-gate",
    "./cursor-acp-runtime",
    "./grok-bot-wake",
    "./mailbox-client",
    "./outbound-client",
    "./profile-scheduler",
    "./shared-codex-app-server",
    "./wake-client",
  ]);
  const source = await readFile(new URL("../src/cli.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /gateway-client|createGatewayClient|gatewayUrlEnv|gatewayTokenEnv|\/inbox|internal\/tasks\/update/);
});

test("worker requests the agent's registered bounds from agent.json (read-only agent)", () => {
  const readOnly = custody({ agentJson: { agent_id: AGENT, workload_id: TEST_WORKLOAD.workloadId, bounds: ["agent.read"] } });
  const config = resolveWorkerConfig(raw, "/tmp/config/worker.json", { ...env, TRIANGLE_WORKLOAD_KEY_FILE: readOnly });
  assert.deepEqual(config.mailbox.workloadScopes, ["agent.read"]);
  const both = custody({ agentJson: { agent_id: AGENT, workload_id: TEST_WORKLOAD.workloadId, bounds: ["agent.write", "agent.read"] } });
  assert.deepEqual(resolveWorkerConfig(raw, "/tmp/config/worker.json", { ...env, TRIANGLE_WORKLOAD_KEY_FILE: both }).mailbox.workloadScopes, ["agent.read", "agent.write"]);
  for (const bounds of [[], ["agent.admin"], "agent.read", ["agent.read", "agent.read"]]) {
    const bad = custody({ agentJson: { agent_id: AGENT, workload_id: TEST_WORKLOAD.workloadId, bounds } });
    assert.throws(() => resolveWorkerConfig(raw, "/tmp/config.json", { ...env, TRIANGLE_WORKLOAD_KEY_FILE: bad }), /agent\.json bounds are invalid/, JSON.stringify(bounds));
  }
});
