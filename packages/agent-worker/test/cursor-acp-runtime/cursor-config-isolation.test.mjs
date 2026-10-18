import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildSanitizedCursorChildEnv,
  resolveTriangleCursorHome,
} from "../../src/cursor-acp-runtime/runtime-home.mjs";
import { createCursorAcpProcess } from "../../src/cursor-acp-runtime/acp-process.mjs";

function fixture() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "triangle-cursor-cfg-")));
  const cursorHome = resolveTriangleCursorHome({
    override: path.join(home, "Library", "Application Support", "The Triangle", "model-state", "cursor-acp-runtime-home"),
    home,
    allowCreate: true,
  });
  return { home, cursorHome, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("child env points CURSOR_CONFIG_DIR at the Triangle-owned Cursor home", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const child = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: { HOME: home, PATH: "/usr/bin" },
    });
    assert.equal(child.CURSOR_CONFIG_DIR, cursorHome);
    assert.notEqual(child.CURSOR_CONFIG_DIR, path.join(home, ".cursor"));
    assert.equal(child.TRIANGLE_CURSOR_HOME, cursorHome);
  } finally {
    cleanup();
  }
});

test("child env keeps HOME so the Cursor login (macOS keychain) is reused, not replaced", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const child = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: { HOME: home, PATH: "/usr/bin" },
    });
    assert.equal(child.HOME, home);
  } finally {
    cleanup();
  }
});

test("parent CURSOR_CONFIG_DIR / XDG_CONFIG_HOME pointing at user state never leak into the child", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const child = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: {
        HOME: home,
        PATH: "/usr/bin",
        CURSOR_CONFIG_DIR: path.join(home, ".cursor"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
      },
    });
    assert.equal(child.CURSOR_CONFIG_DIR, cursorHome);
    assert.equal(child.XDG_CONFIG_HOME, undefined);
  } finally {
    cleanup();
  }
});

test("extra cannot redirect CURSOR_CONFIG_DIR away from the Triangle home", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    assert.throws(
      () =>
        buildSanitizedCursorChildEnv({
          cursorHome,
          parentEnv: { HOME: home, PATH: "/usr/bin" },
          extra: { CURSOR_CONFIG_DIR: path.join(home, ".cursor") },
        }),
      { code: "cursor_config_dir_conflict" },
    );
    const same = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: { HOME: home, PATH: "/usr/bin" },
      extra: { CURSOR_CONFIG_DIR: cursorHome },
    });
    assert.equal(same.CURSOR_CONFIG_DIR, cursorHome);
  } finally {
    cleanup();
  }
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  };
  return child;
}

test("ACP process spawns cursor-agent with CURSOR_CONFIG_DIR set to the Triangle home", async () => {
  const { home, cursorHome, cleanup } = fixture();
  const spawned = [];
  try {
    const processHandle = createCursorAcpProcess({
      command: "agent",
      args: ["acp"],
      cursorHome,
      env: { HOME: home, PATH: "/usr/bin", CURSOR_CONFIG_DIR: path.join(home, ".cursor") },
      spawnImpl: (command, args, options) => {
        spawned.push({ command, args, env: options.env });
        return fakeChild();
      },
    });
    await processHandle.start();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].env.CURSOR_CONFIG_DIR, cursorHome);
    assert.ok(!spawned[0].args.some((arg) => String(arg).includes("CURSOR_CONFIG_DIR")));
    await processHandle.close?.().catch(() => {});
  } finally {
    cleanup();
  }
});

test("Triangle Cursor home may not be inside ~/.cursor or ~/.codex (incl. '..'-prefixed child names)", () => {
  const { home, cleanup } = fixture();
  try {
    for (const [root, code] of [[".cursor", "cursor_home_user_fallback_forbidden"], [".codex", "cursor_home_codex_forbidden"]]) {
      for (const child of ["triangle", "..triangle"]) {
        const override = path.join(home, root, child);
        assert.throws(() => resolveTriangleCursorHome({ override, home, allowCreate: true }), { code }, override);
        assert.equal(existsSync(override), false, `nothing created at ${override}`);
      }
    }
    // A sibling whose name merely starts with ".cursor" is fine.
    const sibling = resolveTriangleCursorHome({ override: path.join(home, ".cursor-triangle"), home, allowCreate: true });
    assert.equal(sibling, path.join(home, ".cursor-triangle"));
  } finally {
    cleanup();
  }
});
