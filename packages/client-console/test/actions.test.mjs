import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { enrollAction, watchEnsureAction, serviceAction } from "../src/actions.mjs";
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

test("enrollAction defaults to stdin-handoff recipe without executing", async () => {
  const recipe = await enrollAction({
    profile: "research",
    origin: "https://thetriangle.dev",
    home: "/tmp/triangle-console-test-home",
  });
  assert.equal(recipe.stub, true);
  assert.match(recipe.command[0], /triangle-mailbox$/);
  assert.equal(recipe.stdin.includes("stdin"), true);
  assert.equal(findSecretLeak(recipe).ok, true);
});

test("enrollAction execute pipes admission JSON and returns secret-free result", async () => {
  const result = await enrollAction({
    profile: "research",
    origin: "https://thetriangle.dev",
    home: "/tmp/triangle-console-test-home",
    execute: true,
    admissionJson: JSON.stringify({
      admissionToken: "one-shot",
      handle: "research",
      name: "Research",
      description: "test",
      capabilities: ["direct-messages"],
    }),
    run: runRole("mailbox"),
  });
  assert.equal(result.stub, false);
  assert.equal(result.result.lifecycle, "verified");
  assert.equal(findSecretLeak(result).ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "admissionJson"), false);
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
