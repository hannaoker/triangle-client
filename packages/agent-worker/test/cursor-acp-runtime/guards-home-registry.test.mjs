import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSanitizedCursorChildEnv,
  resolveCursorAcpPoolGuards,
  resolveTriangleCursorHome,
} from "../../src/cursor-acp-runtime/runtime-home.mjs";
import {
  createDefaultCursorAcpShadowProfile,
  isCursorAcpProfile,
  resolveCursorAcpRuntimeConfig,
} from "../../src/cursor-acp-runtime/config-guards.mjs";
import { createMemoryCursorSessionRegistry } from "../../src/cursor-acp-runtime/session-registry.mjs";

function tempHome() {
  return mkdtempSync(path.join(tmpdir(), "triangle-cursor-home-"));
}

test("Cursor home rejects user ~/.cursor and mesh secrets", () => {
  const home = tempHome();
  try {
    const cursorHome = resolveTriangleCursorHome({
      override: path.join(home, "cursor-acp-runtime-home"),
      home,
      allowCreate: true,
    });
    assert.ok(cursorHome.endsWith("cursor-acp-runtime-home"));

    assert.throws(
      () =>
        resolveTriangleCursorHome({
          override: path.join(home, ".cursor"),
          home,
          allowCreate: true,
        }),
      { code: "cursor_home_user_fallback_forbidden" },
    );

    assert.throws(
      () =>
        resolveTriangleCursorHome({
          override: path.join(home, "mesh_watch_ABCDEFGH12345678"),
          home,
          allowCreate: true,
        }),
      { code: "secret_leak_rejected" },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sanitized child env never carries mesh_ or CODEX_HOME", () => {
  const home = tempHome();
  try {
    const cursorHome = resolveTriangleCursorHome({
      override: path.join(home, "cursor-home"),
      home,
      allowCreate: true,
    });
    const child = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: {
        HOME: home,
        PATH: "/usr/bin",
        MESH_TOKEN: "mesh_ABCDEFGH12345678",
        CODEX_HOME: path.join(home, ".codex"),
      },
      extra: {
        CURSOR_API_KEY: "test-key",
      },
    });
    assert.equal(child.TRIANGLE_CURSOR_HOME, cursorHome);
    assert.equal(child.CURSOR_API_KEY, "test-key");
    assert.equal(child.CODEX_HOME, undefined);
    assert.equal(child.MESH_TOKEN, undefined);
    assert.ok(!JSON.stringify(child).includes("mesh_"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("v1 pool guards cap at size 1", () => {
  const guards = resolveCursorAcpPoolGuards({ preferredSize: 4, maxSize: 4 });
  assert.equal(guards.preferredSize, 1);
  assert.equal(guards.maxSize, 1);
  assert.equal(guards.forcedByV1Cap, true);
});

test("config guards exclude Codex and grok-bot; require shadow enablement", () => {
  assert.equal(
    isCursorAcpProfile({ runtimeAdapter: "codex-app-server", runtimeMode: "headless" }),
    false,
  );
  assert.equal(
    resolveCursorAcpRuntimeConfig({ runtimeAdapter: "grok-bot" }).inactiveReason,
    "grok_bot_excluded",
  );
  assert.equal(
    resolveCursorAcpRuntimeConfig({
      runtimeAdapter: "codex-app-server",
      runtimeMode: "headless",
      deliveryMode: "headless-app-server",
    }).inactiveReason,
    "codex_pool_excluded",
  );

  const profile = createDefaultCursorAcpShadowProfile({ profileId: "cursor-acp-shadow-test" });
  assert.equal(isCursorAcpProfile(profile), true);
  assert.equal(
    resolveCursorAcpRuntimeConfig(profile, { env: {} }).inactiveReason,
    "shadow_not_operator_enabled",
  );
  assert.equal(
    resolveCursorAcpRuntimeConfig(profile, { enableShadow: true }).active,
    true,
  );
});

test("session registry maps roomId→sessionId without secrets", () => {
  const registry = createMemoryCursorSessionRegistry();
  const instanceId = "a".repeat(64);
  const roomId = `room_${"b".repeat(32)}`;
  registry.upsert(instanceId, roomId, {
    cursorSessionId: "sess-1",
    executionState: "admitted",
  });
  const record = registry.get(instanceId, roomId);
  assert.equal(record.cursorSessionId, "sess-1");
  assert.throws(
    () =>
      registry.upsert(instanceId, roomId, {
        cursorSessionId: "sess-2",
      }),
    { code: "registry_session_conflict" },
  );
  assert.throws(
    () =>
      registry.upsert(instanceId, `room_${"d".repeat(32)}`, {
        lastReplyEventId: "mesh_ABCDEFGH12345678",
      }),
    { code: "secret_leak_rejected" },
  );
});
