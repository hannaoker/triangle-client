import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as identityInventory from "../src/identity-inventory.mjs";
import * as installationInventory from "../src/installation-inventory.mjs";
import {
  AGENT_ID_PATTERN,
  deriveClientInstanceId,
  INSTANCE_ID_PATTERN,
  isValidBareHttpsOrigin,
  isValidProfileName,
  SESSION_ID_PATTERN,
} from "../src/identity-primitives.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

test("id patterns accept exactly the documented shapes", () => {
  assert.ok(AGENT_ID_PATTERN.test(`agent_${"a".repeat(32)}`));
  assert.ok(!AGENT_ID_PATTERN.test(`agent_${"a".repeat(31)}`));
  assert.ok(!AGENT_ID_PATTERN.test(`agent_${"A".repeat(32)}`));
  assert.ok(!AGENT_ID_PATTERN.test(`peer_${"a".repeat(32)}`));
  assert.ok(!AGENT_ID_PATTERN.test(`agent_${"a".repeat(32)}\n`));

  assert.ok(INSTANCE_ID_PATTERN.test("0".repeat(64)));
  assert.ok(!INSTANCE_ID_PATTERN.test("0".repeat(63)));
  assert.ok(!INSTANCE_ID_PATTERN.test("g".repeat(64)));

  assert.ok(SESSION_ID_PATTERN.test(`session-${"b".repeat(64)}`));
  assert.ok(!SESSION_ID_PATTERN.test(`session-${"b".repeat(63)}`));
});

test("deriveClientInstanceId follows the documented preimage", () => {
  const expected = (profile) =>
    createHash("sha256").update(`triangle-client-instance-v1\0${profile}`, "utf8").digest("hex");
  for (const profile of ["gravity2", "codex-headless", "a_b", "Zed", "名前"]) {
    assert.equal(deriveClientInstanceId(profile), expected(profile));
  }
  // The instance id recorded in the installed local messaging config for gravity2
  assert.equal(
    deriveClientInstanceId("gravity2"),
    "30966e45dadb53c15bb685a2ac5facac263ca23651010338b6cc73b9e38793c0",
  );
});

test("isValidProfileName keeps the persisted profile-name contract", () => {
  for (const ok of ["gravity2", "a_b", "a-b", "Zed", "x.y", "名前", "a".repeat(64)]) {
    assert.ok(isValidProfileName(ok), ok);
  }
  const bad = ["", "a/b", "a\\b", "a\u0000b", "a​b", "a".repeat(65), "\ud800", 5, null, undefined];
  for (const value of bad) assert.ok(!isValidProfileName(value), String(value));
});

test("isValidBareHttpsOrigin accepts only a bare https origin", () => {
  for (const ok of ["https://mesh.example.test", "https://mesh.example.test:8443", "https://thetriangle.dev"]) {
    assert.ok(isValidBareHttpsOrigin(ok), ok);
  }
  const bad = [
    "http://mesh.example.test",
    "https://mesh.example.test/",
    "https://mesh.example.test/path",
    "https://mesh.example.test?x=1",
    "https://mesh.example.test#frag",
    "https://user@mesh.example.test",
    "https://user:pw@mesh.example.test",
    "https://",
    "mesh.example.test",
    "",
    null,
    5,
  ];
  for (const value of bad) assert.ok(!isValidBareHttpsOrigin(value), String(value));
});

test("the inventories re-export the very same primitives", () => {
  assert.equal(installationInventory.deriveClientInstanceId, deriveClientInstanceId);
  assert.equal(installationInventory.isValidProfileName, isValidProfileName);
  assert.equal(identityInventory.AGENT_ID_PATTERN, AGENT_ID_PATTERN);
  assert.equal(identityInventory.INSTANCE_ID_PATTERN, INSTANCE_ID_PATTERN);
  assert.equal(identityInventory.SESSION_ID_PATTERN, SESSION_ID_PATTERN);
  assert.equal(identityInventory.isValidBareHttpsOrigin, isValidBareHttpsOrigin);
});

// Static and dynamic relative imports of a source file, by file name.
function relativeImports(file) {
  const source = readFileSync(path.join(SRC, file), "utf8");
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\b[^;'"]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s*["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(path.basename(match[1]));
  return [...found].sort();
}

function closure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...relativeImports(file));
  }
  return [...seen].sort();
}

test("the primitives are a leaf and the registry closure stays small (supervisor load)", () => {
  assert.deepEqual(relativeImports("identity-primitives.mjs"), []);
  assert.deepEqual(closure("identity-registry.mjs"), [
    "delivery-private-path.mjs",
    "identity-primitives.mjs",
    "identity-registry.mjs",
  ]);
});
