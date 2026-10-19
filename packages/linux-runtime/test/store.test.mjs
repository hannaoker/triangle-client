import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, symlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore } from "../src/store.mjs";
const agentId = "agent_" + "a".repeat(32);
const root = () =>
  realpathSync(mkdtempSync(path.join(tmpdir(), "store-test-")));
test("separate process cannot acquire kernel lock during awaited cycle", async () => {
  const dir = root(),
    store = openStore({ root: dir, agentId });
  await store.withLock(async () => {
    const script = `import {openStore} from ${JSON.stringify(new URL("../src/store.mjs", import.meta.url).href)};try{await openStore({root:${JSON.stringify(dir)},agentId:${JSON.stringify(agentId)}}).withLock(()=>{});process.exit(2)}catch{process.exit(0)}`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: "pipe" },
    );
    const code = await new Promise((r) => child.once("exit", r));
    assert.equal(code, 0);
  });
  await store.withLock(() => {});
});
test("health retains public host metadata and rejects error text", () => {
  const store = openStore({ root: root(), agentId });
  store.writeHealth({
    state: "running",
    updatedAt: 1,
    profile: "codex",
    pid: 123,
    ready: true,
    verified: true,
    verifiedAt: 1,
    lastError: null,
    completed: 0,
  });
  store.writeHealth({ state: "working", updatedAt: 2 });
  assert.equal(store.readHealth().pid, 123);
  assert.throws(() =>
    store.writeHealth({
      state: "failed",
      updatedAt: 3,
      lastError: "secret inbound body",
    }),
  );
  assert.throws(() => store.save({ text: "private" }), /store_lock_required/);
});
test("symlink lock file is refused", () => {
  const dir = root();
  symlinkSync(path.join(dir, "never-create"), path.join(dir, ".lock.db"));
  const store = openStore({ root: dir, agentId });
  assert.throws(() => store.withLock(() => {}), /unsafe_lock/);
});
