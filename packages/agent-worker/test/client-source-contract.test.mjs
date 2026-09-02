import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const doc = (name) => readFileSync(path.join(root, "docs/triangle-client", name), "utf8");

function requirePatterns(text, patterns, label) {
  for (const pattern of patterns) assert.match(text, pattern, `${label} must cover ${pattern}`);
}

test("Triangle Client public guide defines the supported product and lifecycle", () => {
  const text = doc("README.md");
  requirePatterns(text, [
    /# Triangle Client/,
    /canonical source/i,
    /MESH-native/i,
    /macOS (?:13|only)/i,
    /one (?:trusted )?host.*many.*profiles/is,
    /Keychain/i,
    /never (?:shows|exports).*token/is,
    /--install-client/,
    /triangle-mailbox.*enroll/is,
    /agent add.*--profile.*--runtime/is,
    /agent (?:list|status|enable|disable|remove)/,
    /dev\.thetriangle\.client/,
    /triangle-client-service\.sh status/,
    /transactional.*rollback/is,
    /Node (?:22|v22).*globSync/is,
    /10\+ agents|ten or more agents/i,
    /uninstall/i,
  ], "README");
  assert.doesNotMatch(text, /(?:mesh_|token_)[A-Za-z0-9_-]{20,}/);
});

test("adapter SDK documents the bounded runtime contract", () => {
  const text = doc("adapter-sdk.md");
  requirePatterns(text, [
    /anonymous stdin/i,
    /1 MiB/i,
    /"messageId"/,
    /"taskId"/,
    /"contextId"/,
    /"senderId"/,
    /"recipientId"/,
    /"replyRequired"\s*:\s*true/,
    /Return exactly one JSON object/i,
    /no (?:MESH )?token/i,
    /TRIANGLE_INSTANCE_ID/,
    /global.*FIFO.*2/is,
    /per-instance.*single-flight/is,
  ], "adapter SDK");
});

test("threat model states the trusted-host and isolation boundaries", () => {
  const text = doc("threat-model.md");
  requirePatterns(text, [
    /trusted macOS host/i,
    /coordinator memory/i,
    /reasoning subprocess.*never.*token/is,
    /Keychain/i,
    /anonymous pipe|anonymous stdin/i,
    /argv/i,
    /environment/i,
    /filesystem/i,
    /logs/i,
    /symlink/i,
    /rollback/i,
    /not.*malicious.*host|does not protect.*host/is,
  ], "threat model");
});

test("repository is the complete standalone client source and contains no MESH server", () => {
  const required = [
    "LICENSE",
    "package.json",
    "packages/a2a-gateway/src/mesh-mailbox-bridge.mjs",
    "packages/agent-worker/src/client-supervisor.mjs",
    "packages/macos-mailbox-helper/Package.swift",
    "agents/antigravity/worker/agent-worker.json",
    "agents/codex/package.json",
    "agents/hermes/package.json",
    "scripts/install-macos-mailbox-helper.sh",
    "scripts/mesh",
    "skills/triangle-mesh-a2a/scripts/mesh_client.py",
  ];
  for (const entry of required) assert.ok(existsSync(path.join(root, entry)), `${entry} must exist`);
  for (const forbidden of ["mesh", ".vercel", "tests/mailbox-a2a-cutover.test.mjs", "tests/triangle-client-multi-agent.test.mjs"]) {
    assert.equal(existsSync(path.join(root, forbidden)), false, `${forbidden} is server-owned`);
  }

  const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(rootPackage.workspaces, ["agents/*", "packages/*"]);
  assert.equal(rootPackage.engines?.node, ">=22.0.0");
  for (const script of ["test", "test:runtime", "test:gateway"]) assert.ok(rootPackage.scripts[script]);

  const clientPackage = JSON.parse(readFileSync(path.join(root, "packages/agent-worker/package.json"), "utf8"));
  assert.deepEqual(Object.keys(clientPackage.exports).sort(), [
    ".", "./client-supervisor", "./concurrency-gate", "./mailbox-client", "./outbound-client",
  ]);
  assert.equal(clientPackage.engines?.node, ">=22.0.0");

  const gatewayPackage = JSON.parse(readFileSync(path.join(root, "packages/a2a-gateway/package.json"), "utf8"));
  assert.equal(gatewayPackage.repository?.url, "https://github.com/hannaoker/triangle-client.git");
  assert.equal(gatewayPackage.repository?.directory, "packages/a2a-gateway");

  const license = readFileSync(path.join(root, "LICENSE"), "utf8");
  requirePatterns(license, [/^MIT License$/m, /^Copyright \(c\) 2026 The Triangle$/m], "LICENSE");
});

test("macOS helper documentation and policy define the public custody release", () => {
  const readme = readFileSync(path.join(root, "packages/macos-mailbox-helper/README.md"), "utf8");
  requirePatterns(readme, [/Triangle Client/, /--install-client/, /triangle-client.*agent add/is, /dev\.thetriangle\.client/, /legacy.*migration|migration.*legacy/is], "helper README");

  const policy = readFileSync(path.join(root, "packages/macos-mailbox-helper/KEYCHAIN_POLICY.md"), "utf8");
  requirePatterns(policy, [/public release requires.*Developer ID/is, /application identifier/i, /Keychain entitlements/i, /disposable.*real-Keychain.*release gate/is], "Keychain policy");
  assert.doesNotMatch(policy, /Task [0-9]+/i);
});

test("first-add launch control gates retirement and polling on readiness and activation", () => {
  const source = readFileSync(path.join(root, "packages/macos-mailbox-helper/Sources/TriangleMailboxCore/TriangleClientCLI.swift"), "utf8");
  requirePatterns(source, [/ready\.json/, /parentPid/, /configDigest/, /waitForReadiness/, /restoreLegacy/, /activationMarker/, /stabilityMilliseconds/], "first-add readiness control");
  assert.match(source, /waitForReadiness[\s\S]*retireLegacy[\s\S]*writeActivationMarker/);
});
