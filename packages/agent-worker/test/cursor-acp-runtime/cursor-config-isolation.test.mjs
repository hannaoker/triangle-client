import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
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
  // The production-shaped Cursor home is far longer than Cursor's 84-char
  // socket base, so the data dir must be a short Triangle-owned directory.
  const dataDir = realpathSync(mkdtempSync("/tmp/tcd-"));
  return {
    home,
    cursorHome,
    dataDir,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("child env points CURSOR_CONFIG_DIR at the Triangle-owned Cursor home", () => {
  const { home, cursorHome, dataDir, cleanup } = fixture();
  try {
    const child = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: { HOME: home, PATH: "/usr/bin", TRIANGLE_CURSOR_DATA_DIR: dataDir },
    });
    assert.equal(child.CURSOR_CONFIG_DIR, cursorHome);
    assert.notEqual(child.CURSOR_CONFIG_DIR, path.join(home, ".cursor"));
    assert.equal(child.TRIANGLE_CURSOR_HOME, cursorHome);
  } finally {
    cleanup();
  }
});

test("child env keeps HOME so the Cursor login (macOS keychain) is reused, not replaced", () => {
  const { home, cursorHome, dataDir, cleanup } = fixture();
  try {
    const child = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: { HOME: home, PATH: "/usr/bin", TRIANGLE_CURSOR_DATA_DIR: dataDir },
    });
    assert.equal(child.HOME, home);
  } finally {
    cleanup();
  }
});

test("parent CURSOR_CONFIG_DIR / XDG_CONFIG_HOME pointing at user state never leak into the child", () => {
  const { home, cursorHome, dataDir, cleanup } = fixture();
  try {
    const child = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: {
        HOME: home,
        PATH: "/usr/bin",
        CURSOR_CONFIG_DIR: path.join(home, ".cursor"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        TRIANGLE_CURSOR_DATA_DIR: dataDir,
      },
    });
    assert.equal(child.CURSOR_CONFIG_DIR, cursorHome);
    assert.equal(child.XDG_CONFIG_HOME, undefined);
  } finally {
    cleanup();
  }
});

test("extra cannot redirect CURSOR_CONFIG_DIR away from the Triangle home", () => {
  const { home, cursorHome, dataDir, cleanup } = fixture();
  try {
    assert.throws(
      () =>
        buildSanitizedCursorChildEnv({
          cursorHome,
          parentEnv: { HOME: home, PATH: "/usr/bin", TRIANGLE_CURSOR_DATA_DIR: dataDir },
          extra: { CURSOR_CONFIG_DIR: path.join(home, ".cursor") },
        }),
      { code: "cursor_config_dir_conflict" },
    );
    const same = buildSanitizedCursorChildEnv({
      cursorHome,
      parentEnv: { HOME: home, PATH: "/usr/bin", TRIANGLE_CURSOR_DATA_DIR: dataDir },
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
  const { home, cursorHome, dataDir, cleanup } = fixture();
  const spawned = [];
  try {
    const processHandle = createCursorAcpProcess({
      command: "agent",
      args: ["acp"],
      cursorHome,
      env: {
        HOME: home,
        PATH: "/usr/bin",
        CURSOR_CONFIG_DIR: path.join(home, ".cursor"),
        TRIANGLE_CURSOR_DATA_DIR: dataDir,
      },
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
