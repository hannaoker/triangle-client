import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setupLocalMessaging, runLocalMessagingCLI } from "../src/local-messaging-cli.mjs";
import { readPrivateJson, writePrivateJson } from "../src/local-messaging-auth-broker.mjs";
import { createInstalledLocalMessagingHost } from "../src/local-messaging-host.mjs";
import { createProfiledReasonerGate } from "../src/concurrency-gate.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { resolveLocalSocketAddress } from "../src/local-messaging-address.mjs";
import { createLocalMessagingMcpHandler } from "../src/local-messaging-mcp-adapter.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail("condition not reached");
    await sleep(25);
  }
}

// A disposable installed-style host: the bound Codex identity sends tasks to a runner that overruns the 1 s timeout,
// so each task is held with a late result. The wake adapter is a stub that records the notifications it is given.
async function lifecycle() {
  const root = fs.mkdtempSync("/private/tmp/tri-reconcile-life-");
  const configPath = path.join(root, "local.json");
  const bindingPath = path.join(root, "binding.json");
  writePrivateJson(bindingPath, { instanceId: "a".repeat(64) });
  setupLocalMessaging({ config: configPath, "desktop-binding": bindingPath, "thread-id": "reconcile-life-thread", recipients: ["gravity2"] });
  const base = readPrivateJson(configPath);
  writePrivateJson(configPath, { ...base, runnerTimeoutMs: 1000, wake: { enabled: true, codexPath: "/usr/bin/false", codexHome: root } });
  const config = readPrivateJson(configPath);
  const desktop = readPrivateJson(config.integrationPath);
  const wakes = [];
  const clients = [];
  let host;
  let owner;
  const client = (id) => {
    const c = createLocalControlClient({ socketPath: resolveLocalSocketAddress({ stateRoot: config.stateRoot }).socketPath, senderId: id });
    clients.push(c);
    return c;
  };
  const start = async () => {
    host = createInstalledLocalMessagingHost({
      configPath,
      runners: new Map([[config.recipients[0].instanceId, { run: async () => { await sleep(1600); return { text: "LATE_FROM_RUNNER", status: "completed" }; } }]]),
      gate: createProfiledReasonerGate(),
      timerIntervalMs: 10,
      wakeAdapter: { notify: async (binding, snapshot) => { wakes.push({ binding, snapshot }); return { state: "accepted", receipt: { queuedId: randomUUID(), threadId: binding.threadId } }; } },
    });
    await host.start();
    owner = client(desktop.senderId);
  };
  const stop = async () => { await owner.close(); await host.stop(); };
  const grant = async () => (await owner.exchangeTurnBinding({ bindingId: desktop.bindingId, threadId: desktop.threadId, secret: desktop.secret })).credential;
  const mcp = async (name, args = {}) => {
    const handler = createLocalMessagingMcpHandler({ client: owner, turnCredentialProvider: grant });
    const response = await handler.handleRequest({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } });
    assert.equal(response.result.isError, false, response.result.content[0].text);
    return JSON.parse(response.result.content[0].text);
  };
  const cli = async (args) => {
    let out = "";
    await runLocalMessagingCLI([...args, "--config", configPath], { output: { write: (s) => { out += s; } } });
    return JSON.parse(out);
  };
  await start();
  return {
    wakes,
    mcp,
    cli,
    start,
    stop,
    grant,
    get owner() { return owner; },
    // Send a task the runner will overrun, wait until it is held and the sender has been woken about it, and acknowledge.
    async holdOne(id) {
      await mcp("triangle_send_message", { to: config.recipients[0].instanceId, text: `task ${id}`, messageId: id, requestId: `${id}-req` });
      await waitFor(async () => (await mcp("triangle_get_status", { messageId: id })).phase === "held");
      const wake = await waitFor(() => wakes.find((w) => w.snapshot.heldCount >= 1 && w.snapshot.lateResult === true && !w.acked));
      await owner.ackWake({ wakeId: wake.snapshot.wakeId, generation: 1 }, { credential: await grant() });
      wake.acked = true;
    },
    async close() {
      for (const c of clients) await c.close().catch(() => {});
      await host?.stop().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("stop, list, accept the late result, restart: the sender gets the reply and a wake, and its status says completed", async () => {
  const f = await lifecycle();
  try {
    await f.holdOne("life-accept");
    await f.stop();

    const listing = await f.cli(["held"]);
    const item = listing.items.find((i) => i.messageId === "life-accept");
    assert.equal(item.reason, "runner_timeout");
    assert.equal(item.lateResultSha256, sha("LATE_FROM_RUNNER"));
    assert.deepEqual(item.actions, ["mark-failed", "accept-late-result"]);
    const done = await f.cli(["reconcile-message", "--message-id", "life-accept", "--reconcile-id", "rc-life-accept", "--expect-version", item.version, "--action", "accept-late-result", "--expect-late-hash", sha("LATE_FROM_RUNNER")]);
    assert.equal(done.outcomePhase, "completed");

    const wakesBefore = f.wakes.length;
    await f.start();
    const wake = await waitFor(() => f.wakes.slice(wakesBefore).find((w) => w.snapshot.replyCount === 1 && w.snapshot.heldCount === 0));
    assert.equal(wake.snapshot.lateResult, false);

    const status = await f.mcp("triangle_get_status", { messageId: "life-accept" });
    assert.equal(status.phase, "completed");
    assert.equal(status.delivery.state, "completed");
    const replies = (await f.mcp("triangle_get_replies", { requestId: "life-accept-req" })).replies;
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, "LATE_FROM_RUNNER");
    assert.equal(replies[0].reconciled.reconcileId, "rc-life-accept");
    await f.mcp("triangle_consume_reply", { messageId: replies[0].messageId });
  } finally { await f.close(); }
});

test("stop, list, close as failed, restart: the sender's status says closed_by_owner and no wake follows", async () => {
  const f = await lifecycle();
  try {
    await f.holdOne("life-fail");
    await f.stop();

    const item = (await f.cli(["held"])).items.find((i) => i.messageId === "life-fail");
    const closed = await f.cli(["reconcile-message", "--message-id", "life-fail", "--reconcile-id", "rc-life-fail", "--expect-version", item.version, "--action", "mark-failed", "--expect-late-hash", sha("LATE_FROM_RUNNER"), "--note", "owner closed it"]);
    assert.equal(closed.outcomePhase, "failed");

    const wakesBefore = f.wakes.length;
    await f.start();
    const status = await waitFor(async () => {
      const s = await f.mcp("triangle_get_status", { messageId: "life-fail" });
      return s.delivery?.state === "closed_by_owner" ? s : null;
    });
    assert.equal(status.phase, "failed");
    assert.equal(JSON.stringify(status).includes("owner closed it"), false, "the owner's note never reaches the sender");
    await sleep(600);
    assert.equal(f.wakes.length, wakesBefore, "closing a record does not wake the sender");
    assert.deepEqual((await f.mcp("triangle_get_replies", { requestId: "life-fail-req" })).replies, []);
  } finally { await f.close(); }
});
