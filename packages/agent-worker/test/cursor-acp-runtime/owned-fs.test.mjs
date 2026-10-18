import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  ftruncateSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyFileIntoOwned,
  ensureOwnedDirectory,
  normalizeOwnedRelative,
  ownedFileIdentity,
  removeOwnedEmptyDirectory,
  removeOwnedFileIfUnchanged,
  resolveOwnedPath,
} from "../../src/cursor-acp-runtime/owned-fs.mjs";

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "triangle-owned-fs-")));
  const anchor = path.join(root, "owned");
  const outside = path.join(root, "outside");
  mkdirSync(anchor);
  mkdirSync(outside);
  return { root, anchor, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("relative paths: absolute, empty and '..' are rejected", () => {
  for (const bad of ["/etc/passwd", "", "a/../../b", "..", "a/.."]) {
    assert.throws(() => normalizeOwnedRelative(bad), { code: "owned_path_invalid" }, bad);
  }
  assert.deepEqual(normalizeOwnedRelative("a//b/./c"), ["a", "b", "c"]);
  if (path.sep === "/") {
    // codex #88 r2: on POSIX a backslash is an ordinary filename character.
    assert.deepEqual(normalizeOwnedRelative("a/foo\\bar"), ["a", "foo\\bar"]);
    assert.deepEqual(normalizeOwnedRelative("..\\x"), ["..\\x"]);
  }
});

test("resolveOwnedPath rejects any symlinked ancestor or leaf, and a symlinked anchor", () => {
  const { root, anchor, outside, cleanup } = fixture();
  try {
    mkdirSync(path.join(anchor, "a"));
    symlinkSync(outside, path.join(anchor, "a", "link"), "dir");
    writeFileSync(path.join(outside, "f"), "x");
    assert.throws(() => resolveOwnedPath(anchor, "a/link/f"), { code: "owned_path_symlink_rejected" });
    assert.throws(() => resolveOwnedPath(anchor, "a/link"), { code: "owned_path_symlink_rejected" });
    const anchorLink = path.join(root, "anchor-link");
    symlinkSync(anchor, anchorLink, "dir");
    assert.throws(() => resolveOwnedPath(anchorLink, "a"), { code: "owned_path_symlink_rejected" });
  } finally {
    cleanup();
  }
});

test("copy into owned tree never writes through a symlinked parent", () => {
  const { anchor, outside, cleanup } = fixture();
  try {
    const source = path.join(anchor, "..", "src.txt");
    writeFileSync(source, "payload");
    mkdirSync(path.join(anchor, "p"));
    symlinkSync(outside, path.join(anchor, "p", "q"), "dir");
    assert.throws(
      () => copyFileIntoOwned({ anchor, relative: "p/q/file.txt", source }),
      { code: "owned_path_symlink_rejected" },
    );
    assert.deepEqual(readdirSync(outside), []);
    const ok = copyFileIntoOwned({ anchor, relative: "p/r/s/file.txt", source });
    assert.equal(ok.status, "copied");
    assert.deepEqual(ok.createdDirs, ["p/r", "p/r/s"]);
    assert.equal(readFileSync(path.join(anchor, "p/r/s/file.txt"), "utf8"), "payload");
    assert.equal(copyFileIntoOwned({ anchor, relative: "p/r/s/file.txt", source }).status, "already_present");
  } finally {
    cleanup();
  }
});

test("identity-checked removal: modified, missing, symlinked-parent and swapped-parent cases", () => {
  const { root, anchor, outside, cleanup } = fixture();
  try {
    const source = path.join(root, "src.txt");
    writeFileSync(source, "original");
    const a = copyFileIntoOwned({ anchor, relative: "d/a.txt", source });
    const b = copyFileIntoOwned({ anchor, relative: "d/b.txt", source });

    writeFileSync(path.join(anchor, "d/a.txt"), "original+appended");
    assert.equal(removeOwnedFileIfUnchanged({ anchor, relative: "d/a.txt", identity: a.identity }).status, "modified");
    assert.ok(existsSync(path.join(anchor, "d/a.txt")));

    assert.equal(removeOwnedFileIfUnchanged({ anchor, relative: "d/zz.txt", identity: a.identity }).status, "missing");
    assert.equal(removeOwnedFileIfUnchanged({ anchor, relative: "d/b.txt", identity: null }).status, "modified");

    // Swap the parent for a symlink to a dir holding an identical file.
    renameSync(path.join(anchor, "d"), path.join(root, "moved-d"));
    writeFileSync(path.join(outside, "b.txt"), readFileSync(path.join(root, "moved-d", "b.txt")));
    symlinkSync(outside, path.join(anchor, "d"), "dir");
    const result = removeOwnedFileIfUnchanged({ anchor, relative: "d/b.txt", identity: b.identity });
    assert.equal(result.status, "unsafe_path");
    assert.equal(result.reason, "owned_path_symlink_rejected");
    assert.ok(existsSync(path.join(outside, "b.txt")));

    rmSync(path.join(anchor, "d"));
    renameSync(path.join(root, "moved-d"), path.join(anchor, "d"));
    assert.equal(removeOwnedFileIfUnchanged({ anchor, relative: "d/b.txt", identity: b.identity }).status, "removed");
  } finally {
    cleanup();
  }
});

test("directory removal is never recursive and never follows symlinks", () => {
  const { anchor, outside, cleanup } = fixture();
  try {
    ensureOwnedDirectory(anchor, "x/y");
    writeFileSync(path.join(anchor, "x/y/keep.txt"), "keep");
    assert.equal(removeOwnedEmptyDirectory({ anchor, relative: "x/y" }).status, "not_empty");
    assert.ok(existsSync(path.join(anchor, "x/y/keep.txt")));
    symlinkSync(outside, path.join(anchor, "z"), "dir");
    assert.equal(removeOwnedEmptyDirectory({ anchor, relative: "z" }).status, "unsafe_path");
    assert.ok(existsSync(outside));
    rmSync(path.join(anchor, "x/y/keep.txt"));
    assert.equal(removeOwnedEmptyDirectory({ anchor, relative: "x/y" }).status, "removed");
  } finally {
    cleanup();
  }
});

test("codex #88 r1: file identity hashes in chunks (files larger than one Node buffer read)", () => {
  const { anchor, cleanup } = fixture();
  try {
    // Sparse file just over readFileSync's 2 GiB cap: whole-file reads throw
    // ERR_FS_FILE_TOO_LARGE, streaming the hash must not.
    const big = path.join(anchor, "store.db");
    const fd = openSync(big, "w");
    try {
      ftruncateSync(fd, 2 ** 31 + 1);
    } finally {
      closeSync(fd);
    }
    const identity = ownedFileIdentity(big);
    assert.equal(identity.size, 2 ** 31 + 1);
    assert.match(identity.sha256, /^[0-9a-f]{64}$/);
  } finally {
    cleanup();
  }
});
