import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveApplicationRoot, resolveTrianglePaths } from "../src/paths.mjs";

test("resolveTrianglePaths builds Application Support layout", () => {
  const home = "/Users/operator";
  const paths = resolveTrianglePaths(home);
  assert.equal(paths.applicationRoot, resolveApplicationRoot(home));
  assert.equal(
    paths.helperPath,
    path.join(home, "Library/Application Support/The Triangle/bin/triangle-mailbox"),
  );
  assert.equal(
    paths.installationIdentityPath,
    path.join(home, "Library/Application Support/The Triangle/client/installation.json"),
  );
});

test("resolveApplicationRoot rejects relative homes", () => {
  assert.throws(() => resolveApplicationRoot("relative"), /absolute/);
});
