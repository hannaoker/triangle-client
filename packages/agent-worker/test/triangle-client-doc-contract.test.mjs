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
    /two Codex profiles.*one Hermes/is,
    /transactional.*rollback/is,
    /install.*stopped.*first.*agent add.*readiness.*retire.*legacy/is,
    /same.*PID.*stability.*retire.*legacy.*activation.*poll/is,
    /cannot be.*stopped.*proven absent.*does not reactivate/is,
    /Node (?:22|v22).*globSync/is,
    /10\+ agents|ten or more agents/i,
    /uninstall/i,
  ], "README");
  assert.doesNotMatch(text, /(?:mesh_|token_)[A-Za-z0-9_-]{20,}/, "examples must not contain secret-looking values");
});

test("adapter SDK documents the exact bounded stdin/stdout schemas and controls", () => {
  const text = doc("adapter-sdk.md");
  requirePatterns(text, [
    /anonymous stdin/i,
    /1 MiB/i,
    /"messageId"/,
    /"taskId"/,
    /"contextId"/,
    /"senderId"/,
    /"recipientId"/,
    /"text"/,
    /"replyRequired"\s*:\s*true/,
    /"status"\s*:\s*"completed"/,
    /Return exactly one JSON object/i,
    /no (?:MESH )?token/i,
    /TRIANGLE_INSTANCE_ID/,
    /CODEX_HOME/,
    /HERMES_HOME/,
    /global.*FIFO.*2/is,
    /per-instance.*single-flight/is,
    /integrity|content-addressed/i,
  ], "adapter SDK");
});

test("threat model states the trusted-host and isolation boundaries", () => {
  const text = doc("threat-model.md");
  requirePatterns(text, [
    /trusted macOS host/i,
    /coordinator memory/i,
    /active service lifetime/i,
    /reasoning subprocess.*never.*token/is,
    /Keychain/i,
    /anonymous pipe|anonymous stdin/i,
    /argv/i,
    /environment/i,
    /filesystem/i,
    /logs/i,
    /profile.*SHA-256|SHA-256.*profile/is,
    /symlink/i,
    /rollback/i,
    /not.*malicious.*host|does not protect.*host/is,
  ], "threat model");
  assert.doesNotMatch(text, /token exists[^.]*briefly|briefly[^.]*token/i, "coordinator custody must not be understated as brief");
});

test("repository manifest is exact, existent, standalone, and excludes server state", () => {
  const text = doc("repository-manifest.txt");
  const lines = text.split(/\r?\n/);
  const sections = new Map();
  let section;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^\[([a-z-]+)\]$/);
    if (match) { section = match[1]; sections.set(section, []); continue; }
    assert.ok(section, `manifest entry outside section: ${line}`);
    sections.get(section).push(line);
  }
  for (const required of ["include", "copy-as", "publication-required", "exclude", "verify"]) {
    assert.ok(sections.has(required), `missing [${required}] section`);
  }
  const includes = sections.get("include");
  assert.equal(new Set(includes).size, includes.length, "include entries must be unique");
  for (const entry of includes) {
    assert.ok(!/[?*\[\]]/.test(entry), `include entries must be exact paths: ${entry}`);
    assert.ok(existsSync(path.join(root, entry)), `included path does not exist: ${entry}`);
  }
  assert.equal(includes.includes("tests/triangle-client-multi-agent.test.mjs"), false, "server/database integration fixture must not enter the client repository");
  assert.ok(sections.get("exclude").includes("tests/triangle-client-multi-agent.test.mjs"), "server/database integration fixture must be explicitly excluded");
  for (const internal of [
    "packages/agent-worker/package.json",
    "packages/agent-worker/src/outbound-cli.mjs",
    "packages/agent-worker/src/outbound-client.mjs",
  ]) assert.equal(includes.includes(internal), false, `internal outbound surface must not be exported: ${internal}`);
  const mappings = sections.get("copy-as");
  assert.deepEqual(mappings, ["docs/triangle-client/agent-worker-package.json -> packages/agent-worker/package.json"]);
  const packageTemplatePath = path.join(root, "docs/triangle-client/agent-worker-package.json");
  const materializedPackagePath = path.join(root, "packages/agent-worker/package.json");
  const reviewedPackagePath = existsSync(packageTemplatePath) ? packageTemplatePath : materializedPackagePath;
  assert.ok(existsSync(reviewedPackagePath), "reviewed client-only package manifest is missing");
  const clientPackageText = readFileSync(reviewedPackagePath, "utf8");
  const clientPackage = JSON.parse(clientPackageText);
  assert.deepEqual(Object.keys(clientPackage.exports).sort(), [
    ".", "./client-supervisor", "./concurrency-gate", "./mailbox-client",
  ]);
  assert.equal(clientPackage.engines?.node, ">=22.0.0", "standalone package must declare the enforced Node minimum");
  assert.equal(JSON.stringify(clientPackage).includes("outbound"), false, "client-only package manifest must not expose outbound compatibility code");
  const publicationRequired = sections.get("publication-required");
  assert.deepEqual(publicationRequired, ["LICENSE | satisfied: approved MIT terms and Copyright 2026 The Triangle"]);
  assert.ok(includes.includes("LICENSE"), "approved license must be exported");
  const license = readFileSync(path.join(root, "LICENSE"), "utf8");
  requirePatterns(license, [
    /^MIT License$/m,
    /^Copyright \(c\) 2026 The Triangle$/m,
    /Permission is hereby granted, free of charge/,
  ], "LICENSE");
  requirePatterns(text, [
    /^mesh\/\*\*$/m,
    /^\.vercel\/\*\*$/m,
    /server/i,
    /database/i,
    /\.env/,
    /credentials/i,
    /generated media/i,
    /dirty worktree/i,
    /npm --prefix packages\/agent-worker run test:triangle-client/,
    /TriangleMailboxHostTests/,
    /triangle-client-service\.test\.mjs/,
    /ten-agent test is a MESH server\/database integration fixture/i,
    /license attribution/i,
  ], "repository manifest");
  const exportedSource = includes
    .map((entry) => readFileSync(path.join(root, entry), "utf8"))
    .concat(clientPackageText)
    .join("\n");
  const forbiddenOutbound = new RegExp(`${["internal", "Token"].join("")}|${["", "internal", "a2a", "outbound"].join("/")}`);
  assert.doesNotMatch(exportedSource, forbiddenOutbound, "export allowlist must contain no private outbound bridge surface");
});

test("macOS helper README points operators to the single Triangle Client service", () => {
  const text = readFileSync(path.join(root, "packages/macos-mailbox-helper/README.md"), "utf8");
  requirePatterns(text, [
    /Triangle Client/,
    /--install-client/,
    /triangle-client.*agent add/is,
    /dev\.thetriangle\.client/,
    /legacy.*migration|migration.*legacy/is,
    /staged.*stopped.*first.*agent add/is,
  ], "helper README");
});

test("Keychain policy states current public release requirements without internal task placeholders", () => {
  const text = readFileSync(path.join(root, "packages/macos-mailbox-helper/KEYCHAIN_POLICY.md"), "utf8");
  requirePatterns(text, [
    /public release requires.*Developer ID/is,
    /application identifier/i,
    /Keychain entitlements/i,
    /disposable.*real-Keychain.*release gate/is,
  ], "Keychain policy");
  assert.doesNotMatch(text, /Task [0-9]+/i);
});

test("first-add launch control gates retirement and polling on stable readiness and activation", () => {
  const source = readFileSync(path.join(root, "packages/macos-mailbox-helper/Sources/TriangleMailboxCore/TriangleClientCLI.swift"), "utf8");
  requirePatterns(source, [
    /ready\.json/,
    /parentPid/,
    /configDigest/,
    /readyAtMilliseconds/,
    /waitForReadiness/,
    /dev\.thetriangle\.codex\.worker/,
    /dev\.thetriangle\.hermes\.worker/,
    /restoreLegacy/,
    /activationMarker/,
    /stabilityMilliseconds/,
  ], "first-add readiness control");
  assert.match(source, /waitForReadiness[\s\S]*retireLegacy[\s\S]*writeActivationMarker/, "activation must follow stable readiness and legacy retirement");
  assert.match(source, /bootout[\s\S]*print[\s\S]*restoreLegacy/, "legacy restoration must follow proven client absence");
});
