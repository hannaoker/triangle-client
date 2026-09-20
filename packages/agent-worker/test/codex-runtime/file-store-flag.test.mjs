import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isHelperConversationStoreEnabled,
  resolvePhase0RuntimeConfig,
} from "../../src/codex-runtime/config-guards.mjs";
import { loadRuntimeManifest } from "../../src/codex-runtime/runtime-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

test("Node + Swift helper conversation store flags stay inactive (no profile behavior change)", () => {
  assert.equal(isHelperConversationStoreEnabled(), false);
  assert.equal(loadRuntimeManifest({ forceReload: true }).featureFlags.helperConversationStore, false);

  const config = resolvePhase0RuntimeConfig({
    runtimeAdapter: "codex-app-server",
    runtimeMode: "headless",
  });
  assert.equal(config.helperConversationStoreEnabled, false);
  assert.equal(config.headlessRuntimeEnabled, false);
  // Phase 0 must not flip production profile runtime modes.
  assert.equal(config.runtimeMode, "headless"); // echoes request only; activation gated by flag
  assert.equal(config.featureFlags.headlessRuntime, false);

  const swiftFlags = readFileSync(
    path.join(
      root,
      "packages/macos-mailbox-helper/Sources/TriangleMailboxCore/CodexRuntimeFeatureFlags.swift",
    ),
    "utf8",
  );
  assert.match(swiftFlags, /conversationStoreEnabled:\s*Bool\s*=\s*false/);
  assert.match(swiftFlags, /headlessRuntimeEnabled:\s*Bool\s*=\s*false/);
  assert.match(swiftFlags, /desktopHandoffEnabled:\s*Bool\s*=\s*false/);

  const store = readFileSync(
    path.join(
      root,
      "packages/macos-mailbox-helper/Sources/TriangleMailboxCore/FileCodexConversationStore.swift",
    ),
    "utf8",
  );
  assert.match(store, /featureInactive/);
  assert.match(store, /CodexRuntimeFeatureFlags\.conversationStoreEnabled/);
  assert.match(store, /codex-runtime/);
  assert.doesNotMatch(store, /mesh_watch_/);
});
