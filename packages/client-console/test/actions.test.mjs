import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { bindAction, watchEnsureAction, serviceAction } from "../src/actions.mjs";
import { findSecretLeak } from "../src/secrets.mjs";

const fakeHelper = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-helper.mjs",
);

function runRole(role) {
  return async (_file, args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fakeHelper, role, ...args], {
        stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
      });
      let stdout = "";
      if (options.stdin != null) {
        child.stdin.write(options.stdin);
        child.stdin.end();
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => {
        stdout += c;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr: "", code }));
    });
}

const KEY_FILE = "/tmp/triangle-console-test-home/triangle/agents/agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/workload-key.json";

test("bindAction defaults to the exact helper command without executing", async () => {
  const recipe = await bindAction({ profile: "research", keyFile: KEY_FILE, home: "/tmp/triangle-console-test-home" });
  assert.equal(recipe.stub, true);
  assert.match(recipe.command[0], /triangle-mailbox$/);
  assert.deepEqual(recipe.command.slice(1), ["bind", "--profile", "research", "--key-file", KEY_FILE]);
  assert.equal(findSecretLeak(recipe).ok, true);
});

test("bindAction validates the key file path and origin", async () => {
  for (const keyFile of ["relative/agents/agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/workload-key.json", "/tmp/agent.json", "/tmp/agents/agent_x/workload-key.json"]) {
    await assert.rejects(bindAction({ profile: "research", keyFile }), { code: "invalid_key_file" });
  }
  await assert.rejects(bindAction({ profile: "research", keyFile: KEY_FILE, origin: "http://x.test" }), { code: "invalid_origin" });
});

test("bindAction execute returns the secret-free verified status with permissions", async () => {
  const result = await bindAction({
    profile: "research",
    keyFile: KEY_FILE,
    origin: "https://thetriangle.dev",
    home: "/tmp/triangle-console-test-home",
    execute: true,
    run: runRole("mailbox"),
  });
  assert.equal(result.stub, false);
  assert.equal(result.result.status, "verified");
  assert.deepEqual(result.result.permissions, { send_messages: true });
  assert.equal(findSecretLeak(result).ok, true);
});

test("watchEnsureAction stub then execute", async () => {
  const stub = await watchEnsureAction({
    installationId: "inst_N7VhDq3mQ2",
    actorProfile: "research",
    home: "/tmp/triangle-console-test-home",
  });
  assert.equal(stub.stub, true);

  const done = await watchEnsureAction({
    installationId: "inst_N7VhDq3mQ2",
    actorProfile: "research",
    home: "/tmp/triangle-console-test-home",
    execute: true,
    run: runRole("mailbox"),
  });
  assert.equal(done.stub, false);
  assert.equal(done.result.state, "finalized");
  assert.equal(findSecretLeak(done).ok, true);
});

test("serviceAction start remains stubbed without --execute", async () => {
  const stub = await serviceAction({
    action: "start",
    serviceScriptPath: "/tmp/fake-triangle-client-service.sh",
  });
  assert.equal(stub.stub, true);
  assert.deepEqual(stub.command, ["/tmp/fake-triangle-client-service.sh", "start"]);
});
