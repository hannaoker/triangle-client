import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  applyLegacyCursorAcpSessionCopy,
  buildSanitizedCursorChildEnv,
  CURSOR_ACP_LEGACY_COPY_MANIFEST,
  planLegacyCursorAcpSessionCopy,
  resolveTriangleCursorHome,
  revertLegacyCursorAcpSessionCopy,
} from "../../src/cursor-acp-runtime/runtime-home.mjs";
import { createCursorAcpProcess } from "../../src/cursor-acp-runtime/acp-process.mjs";

const SESSION_A = "97a0e930-e06e-4c34-94dc-bbf960f8a8e4";
const SESSION_B = "46671553-8e12-4b81-9f38-909bc83257d7";
const SESSION_MISSING = "00000000-0000-4000-8000-000000000000";

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

function seedLegacySession(home, sessionId, marker = sessionId) {
  const dir = path.join(home, ".cursor", "acp-sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: "/tmp/x" }));
  writeFileSync(path.join(dir, "store.db"), `db:${marker}`);
  return dir;
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

test("legacy session copy plan is read-only and classifies each referenced session", () => {
  const { home, cursorHome, dataDir, cleanup } = fixture();
  try {
    seedLegacySession(home, SESSION_A);
    seedLegacySession(home, SESSION_B);
    mkdirSync(path.join(cursorHome, "acp-sessions", SESSION_B), { recursive: true });

    const plan = planLegacyCursorAcpSessionCopy({
      home,
      cursorHome,
      sessionIds: [SESSION_A, SESSION_B, SESSION_MISSING],
    });
    assert.deepEqual(
      plan.entries.map(({ sessionId, action }) => ({ sessionId, action })),
      [
        { sessionId: SESSION_A, action: "copy" },
        { sessionId: SESSION_B, action: "already_present" },
        { sessionId: SESSION_MISSING, action: "missing_source" },
      ],
    );
    assert.equal(existsSync(path.join(cursorHome, "acp-sessions", SESSION_A)), false);
  } finally {
    cleanup();
  }
});

test("legacy session copy rejects non-UUID ids and refuses to treat ~/.cursor as the target", () => {
  const { home, cursorHome, dataDir, cleanup } = fixture();
  try {
    assert.throws(
      () => planLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds: ["../../etc"] }),
      { code: "cursor_session_id_invalid" },
    );
    assert.throws(
      () =>
        planLegacyCursorAcpSessionCopy({
          home,
          cursorHome: path.join(home, ".cursor"),
          sessionIds: [SESSION_A],
        }),
      { code: "cursor_home_user_fallback_forbidden" },
    );
  } finally {
    cleanup();
  }
});

test("legacy session copy leaves ~/.cursor untouched, never overwrites, and is reversible", () => {
  const { home, cursorHome, dataDir, cleanup } = fixture();
  try {
    const sourceA = seedLegacySession(home, SESSION_A, "legacy-a");
    seedLegacySession(home, SESSION_B, "legacy-b");
    const presentB = path.join(cursorHome, "acp-sessions", SESSION_B);
    mkdirSync(presentB, { recursive: true });
    writeFileSync(path.join(presentB, "store.db"), "db:triangle-owned-b");

    const applied = applyLegacyCursorAcpSessionCopy({
      home,
      cursorHome,
      sessionIds: [SESSION_A, SESSION_B, SESSION_MISSING],
    });
    assert.deepEqual(applied.copied, [SESSION_A]);
    assert.equal(
      readFileSync(path.join(cursorHome, "acp-sessions", SESSION_A, "store.db"), "utf8"),
      "db:legacy-a",
    );
    // Source untouched.
    assert.equal(readFileSync(path.join(sourceA, "store.db"), "utf8"), "db:legacy-a");
    // Existing Triangle-owned session not overwritten.
    assert.equal(readFileSync(path.join(presentB, "store.db"), "utf8"), "db:triangle-owned-b");

    const manifestPath = path.join(cursorHome, "acp-sessions", CURSOR_ACP_LEGACY_COPY_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(manifest.copied.map((entry) => entry.sessionId), [SESSION_A]);

    // Re-applying is idempotent.
    const again = applyLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds: [SESSION_A] });
    assert.deepEqual(again.copied, []);

    const reverted = revertLegacyCursorAcpSessionCopy({ home, cursorHome });
    assert.deepEqual(reverted.removed, [SESSION_A]);
    assert.equal(existsSync(path.join(cursorHome, "acp-sessions", SESSION_A)), false);
    assert.equal(existsSync(presentB), true);
    assert.equal(existsSync(sourceA), true);
    assert.equal(existsSync(manifestPath), false);
  } finally {
    cleanup();
  }
});

test("legacy session copy refuses symlinked source session directories", () => {
  const { home, cursorHome, dataDir, cleanup } = fixture();
  try {
    const real = seedLegacySession(home, SESSION_B);
    const link = path.join(home, ".cursor", "acp-sessions", SESSION_A);
    symlinkSync(real, link);
    const plan = planLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds: [SESSION_A] });
    assert.equal(plan.entries[0].action, "unsafe_source");
    const applied = applyLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds: [SESSION_A] });
    assert.deepEqual(applied.copied, []);
  } finally {
    cleanup();
  }
});

test("legacy session manifest records every copied file with size, mtime and sha256", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const source = seedLegacySession(home, SESSION_A, "legacy-a");
    mkdirSync(path.join(source, "blobs"));
    writeFileSync(path.join(source, "blobs", "b1"), "blob-1");
    applyLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds: [SESSION_A] });
    const manifest = JSON.parse(
      readFileSync(path.join(cursorHome, "acp-sessions", CURSOR_ACP_LEGACY_COPY_MANIFEST), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 2);
    const [record] = manifest.copied;
    assert.deepEqual(
      record.files.map((file) => file.path).sort(),
      [
        `acp-sessions/${SESSION_A}/blobs/b1`,
        `acp-sessions/${SESSION_A}/meta.json`,
        `acp-sessions/${SESSION_A}/store.db`,
      ],
    );
    for (const file of record.files) {
      assert.equal(typeof file.size, "number");
      assert.equal(typeof file.mtimeMs, "number");
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
    }
    assert.deepEqual(record.createdDirs.sort(), [`acp-sessions/${SESSION_A}`, `acp-sessions/${SESSION_A}/blobs`]);
  } finally {
    cleanup();
  }
});

test("undo after use keeps a session whose copy was modified or extended; unused sessions are removed", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    const sourceA = seedLegacySession(home, SESSION_A, "legacy-a");
    seedLegacySession(home, SESSION_B, "legacy-b");
    applyLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds: [SESSION_A, SESSION_B] });
    const targetA = path.join(cursorHome, "acp-sessions", SESSION_A);
    // Synthetic "post-migration work" in session A only.
    writeFileSync(path.join(targetA, "store.db"), "db:legacy-a+new-turn");
    writeFileSync(path.join(targetA, "new-after-resume.txt"), "new accepted work");

    const reverted = revertLegacyCursorAcpSessionCopy({ home, cursorHome });
    assert.deepEqual(reverted.removed, [SESSION_B]);
    assert.equal(existsSync(path.join(cursorHome, "acp-sessions", SESSION_B)), false);
    assert.equal(reverted.kept.length, 1);
    assert.equal(reverted.kept[0].sessionId, SESSION_A);
    assert.equal(reverted.kept[0].reason, "used_after_migration");
    assert.deepEqual(reverted.kept[0].newFiles, ["new-after-resume.txt"]);
    assert.deepEqual(reverted.kept[0].modifiedFiles, ["store.db"]);
    // All of session A survives, including the unchanged meta.json.
    assert.equal(readFileSync(path.join(targetA, "store.db"), "utf8"), "db:legacy-a+new-turn");
    assert.equal(readFileSync(path.join(targetA, "new-after-resume.txt"), "utf8"), "new accepted work");
    assert.ok(existsSync(path.join(targetA, "meta.json")));
    // Manifest is preserved for the kept session; source untouched.
    const manifestPath = path.join(cursorHome, "acp-sessions", CURSOR_ACP_LEGACY_COPY_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(manifest.copied.map((entry) => entry.sessionId), [SESSION_A]);
    assert.equal(manifest.copied[0].lastRevert.reason, "used_after_migration");
    assert.equal(readFileSync(path.join(sourceA, "store.db"), "utf8"), "db:legacy-a");

    // A second undo is stable: still keeps A.
    const again = revertLegacyCursorAcpSessionCopy({ home, cursorHome });
    assert.deepEqual(again.removed, []);
    assert.equal(again.kept[0].sessionId, SESSION_A);
    assert.ok(existsSync(manifestPath));
  } finally {
    cleanup();
  }
});

test("undo never follows a symlinked session dir out of the Triangle home; manifest preserved", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    seedLegacySession(home, SESSION_A, "legacy-a");
    applyLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds: [SESSION_A] });
    const targetA = path.join(cursorHome, "acp-sessions", SESSION_A);
    // Replace the copied session dir with a symlink to unrelated data that has
    // byte-identical files (and the same mtimes) to defeat identity checks.
    const outside = path.join(home, "unrelated");
    mkdirSync(outside);
    for (const name of ["meta.json", "store.db"]) {
      writeFileSync(path.join(outside, name), readFileSync(path.join(targetA, name)));
      const stat = statSync(path.join(targetA, name));
      utimesSync(path.join(outside, name), stat.atime, stat.mtime);
    }
    rmSync(targetA, { recursive: true });
    symlinkSync(outside, targetA, "dir");

    const reverted = revertLegacyCursorAcpSessionCopy({ home, cursorHome });
    assert.deepEqual(reverted.removed, []);
    assert.equal(reverted.kept[0].reason, "unsafe_path");
    assert.ok(existsSync(path.join(outside, "store.db")));
    assert.ok(existsSync(path.join(outside, "meta.json")));
    assert.ok(existsSync(path.join(cursorHome, "acp-sessions", CURSOR_ACP_LEGACY_COPY_MANIFEST)));
  } finally {
    cleanup();
  }
});

test("apply refuses to copy through a symlinked acp-sessions root", () => {
  const { home, cursorHome, cleanup } = fixture();
  try {
    seedLegacySession(home, SESSION_A, "legacy-a");
    const outside = path.join(home, "elsewhere");
    mkdirSync(outside);
    symlinkSync(outside, path.join(cursorHome, "acp-sessions"), "dir");
    assert.throws(
      () => applyLegacyCursorAcpSessionCopy({ home, cursorHome, sessionIds: [SESSION_A] }),
      { code: "owned_path_symlink_rejected" },
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    cleanup();
  }
});
