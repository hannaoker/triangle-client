import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCodexAppServerProcess,
  createFakeAppServerStdioProgram,
} from "../../src/codex-runtime/app-server-process.mjs";
import {
  encodeJsonRpcRequest,
  encodeNdjsonLine,
  parseNdjsonLine,
} from "../../src/codex-runtime/app-server-protocol.mjs";

function tempHome() {
  return mkdtempSync(path.join(tmpdir(), "triangle-codex-home-"));
}

test("NDJSON framing round-trips a JSON-RPC request line", () => {
  const request = encodeJsonRpcRequest(1, "initialize", { clientInfo: { name: "t", version: "0" } });
  const line = encodeNdjsonLine(request);
  assert.equal(line.endsWith("\n"), true);
  const parsed = parseNdjsonLine(line);
  assert.equal(parsed.method, "initialize");
  assert.equal(parsed.id, 1);
  assert.throws(
    () => encodeJsonRpcRequest(2, "turn/start", { input: [{ type: "text", text: "mesh_watch_ABCDEFGHijklmnop" }] }),
    (error) => error.code === "secret_leak_rejected",
  );
});

test("stdio wrapper initialize / thread / turn against fake App Server", async () => {
  const home = tempHome();
  const fake = createFakeAppServerStdioProgram({ serverIdentity: "fake-unit" });
  const processHandle = createCodexAppServerProcess({
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
  });

  const events = [];
  processHandle.onEvent((event) => events.push(event));

  try {
    const started = await processHandle.start();
    assert.equal(started.codexHome, home);
    assert.ok(!JSON.stringify(processHandle.status()).includes("mesh_"));

    const init = await processHandle.initialize({ name: "triangle-test", version: "0.0.0" });
    assert.equal(init.serverInfo.name, "fake-unit");

    const thread = await processHandle.threadStart({
      cwd: home,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    assert.match(thread.thread.id, /^thread-/);

    const turn = await processHandle.turnStart({
      threadId: thread.thread.id,
      clientUserMessageId: "tc1:testdeadbeef012345678901",
      input: [{ type: "text", text: "hello" }],
    });
    assert.match(turn.turn.id, /^turn-/);

    const read = await processHandle.threadRead({
      threadId: thread.thread.id,
      includeTurns: true,
    });
    assert.equal(read.thread.turns.length, 1);
    assert.equal(read.thread.turns[0].items[0].clientId, "tc1:testdeadbeef012345678901");
    assert.equal(read.thread.turns[0].items[1].text, "fake-assistant-ok");

    // Wait briefly for turn/completed notification.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(events.some((event) => event.method === "turn/completed"));
  } finally {
    await processHandle.close({ signal: "SIGKILL", timeoutMs: 1_000 });
    rmSync(home, { recursive: true, force: true });
  }
});

test("pending calls fail when the child exits", async () => {
  const home = tempHome();
  const fake = createFakeAppServerStdioProgram();
  const processHandle = createCodexAppServerProcess({
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
    requestTimeoutMs: 5_000,
  });

  try {
    await processHandle.start();
    await processHandle.initialize({ name: "triangle-test", version: "0.0.0" });
    const pending = processHandle.call("thread/start", { cwd: home });
    const pendingResult = pending.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    await processHandle.close({ signal: "SIGKILL", timeoutMs: 1_000 });
    const settled = await pendingResult;
    assert.equal(settled.ok, false);
    assert.ok(
      settled.error.code === "closing" || settled.error.code === "child_exited",
      settled.error.code,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("refuses user ~/.codex as dedicated runtime home", () => {
  const home = tempHome();
  const userCodex = path.join(home, ".codex");
  assert.throws(
    () =>
      createCodexAppServerProcess({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        codexHome: userCodex,
        env: { ...process.env, HOME: home },
      }),
    (error) => error.code === "codex_home_user_fallback_forbidden",
  );
  rmSync(home, { recursive: true, force: true });
});
