import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  acquireAdvisoryLock,
  isAdvisoryLockHeld,
  isPidAlive,
  readClaimerDiagnostics,
} from "../src/claimer-advisory-lock.mjs";

test("isPidAlive treats only ESRCH as absent", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(1), false);
  assert.equal(isPidAlive(-1), false);
  // Unused high PID typically returns ESRCH on Darwin.
  assert.equal(isPidAlive(2_147_483_646), false);
});

test("advisory lock: leftover JSON does not block acquire; concurrent exclusive fails", () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(path.join(tmpdir(), "claimer-advisory-"));
  const lockPath = path.join(root, "headless-claimer.demo.json");
  writeFileSync(
    lockPath,
    `${JSON.stringify({ version: 1, profile: "demo", owner: "dev.thetriangle.client", pid: 99 })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  assert.equal(isAdvisoryLockHeld(lockPath), false);
  const first = acquireAdvisoryLock({
    lockPath,
    document: { profile: "demo", owner: "dev.thetriangle.client", pid: 1001 },
  });
  try {
    assert.equal(isAdvisoryLockHeld(lockPath), true);
    assert.equal(readClaimerDiagnostics(lockPath)?.pid, 1001);
    assert.throws(
      () => acquireAdvisoryLock({
        lockPath,
        document: { profile: "demo", owner: "dev.thetriangle.client", pid: 1002 },
      }),
      (error) => error.code === "claimer_lock_held",
    );
  } finally {
    first.release();
    assert.equal(isAdvisoryLockHeld(lockPath), false);
    assert.match(readFileSync(lockPath, "utf8"), /"pid":1001/);
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory lock rejects symlink leaf", () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(path.join(tmpdir(), "claimer-symlink-"));
  const target = path.join(root, "target.json");
  const lockPath = path.join(root, "claimer.json");
  writeFileSync(target, "{}\n", { encoding: "utf8", mode: 0o600 });
  symlinkSync(target, lockPath);
  assert.throws(
    () => acquireAdvisoryLock({
      lockPath,
      document: { profile: "demo", owner: "o", pid: 2 },
    }),
    (error) => error.code === "claimer_lock_symlink",
  );
  rmSync(root, { recursive: true, force: true });
});
