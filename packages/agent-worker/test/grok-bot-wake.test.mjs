import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFakeWatchTransport,
  createGrokBotWakeBridge,
  createGrokBotWakeDispatcher,
  createMemoryCursorStore,
  readWebhookCredentials,
  validateGrokBotBinding,
} from "../src/grok-bot-wake.mjs";

const installationId = "inst_EaA3qkuzOuQwTSFw";
const instanceId = "3356f7bfb8e902f4b519d8238e3555e4974217898af96bed249cf0cfb729c1eb";
const agentId = "agent_582567705a9348c38f18c91d2bac9dd8";
const profile = "bob";
const grokAgentId = "12aedccc-8662-4a7f-84da-3d35c9e97842";

function sampleBinding(overrides = {}) {
  return {
    adapterVersion: "1",
    enabled: true,
    installationId,
    instanceId,
    agentId,
    profile,
    grokAgentId,
    wakeMode: "webhook",
    ...overrides,
  };
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-bot-wake-"));
  return run(dir);
}

async function withWebhookServer(handler, run) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      handler({ req, body, res });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}/wake`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("validateGrokBotBinding accepts the durable metadata schema", () => {
  const binding = validateGrokBotBinding(sampleBinding());
  assert.equal(binding.wakeMode, "webhook");
  assert.equal(binding.profile, "bob");
  assert.throws(() => validateGrokBotBinding(sampleBinding({ wakeMode: "poll" })));
  assert.throws(() => validateGrokBotBinding(sampleBinding({ enabled: false, extra: true })));
});

test("readWebhookCredentials loads https URL and key from 0600 files", async () => {
  await withTempDir(async (dir) => {
    const urlPath = path.join(dir, "grok-bot-webhook.url");
    const keyPath = path.join(dir, "grok-bot-webhook.key");
    await writeFile(urlPath, "https://hooks.example.test/mesh-bob-wake-drain\n", { mode: 0o600 });
    await writeFile(keyPath, "test-webhook-key-value\n", { mode: 0o600 });
    await chmod(urlPath, 0o600);
    await chmod(keyPath, 0o600);
    const creds = await readWebhookCredentials({ webhookUrlPath: urlPath, webhookKeyPath: keyPath });
    assert.equal(creds.url, "https://hooks.example.test/mesh-bob-wake-drain");
    assert.equal(creds.key, "test-webhook-key-value");

    const insecureUrl = path.join(dir, "insecure.url");
    await writeFile(insecureUrl, "http://insecure.example/wake\n", { mode: 0o600 });
    await assert.rejects(
      () => readWebhookCredentials({ webhookUrlPath: insecureUrl, webhookKeyPath: keyPath }),
      /https/,
    );
  });
});

test("webhook dispatcher POSTs bearer wake payload and accepts 2xx", async () => {
  const seen = [];
  await withWebhookServer(({ req, body, res }) => {
    seen.push({
      method: req.method,
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      body: JSON.parse(body),
    });
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (httpUrl) => {
    // Dispatcher requires https credentials; inject via readCredentials mock.
    const dispatcher = createGrokBotWakeDispatcher({
      wakeMode: "webhook",
      async readCredentials() {
        return { url: httpUrl, key: "test-webhook-key-value" };
      },
      webhookUrlPath: "/private/grok-bot-webhook.url",
      webhookKeyPath: "/private/grok-bot-webhook.key",
    });
    const result = await dispatcher.deliver({
      source: "triangle-client",
      type: "mesh.mailbox.wake",
      installationId,
      instanceId,
      agentId,
      profile,
      highWatermark: 42,
      reason: "wake",
    });
    assert.equal(result.status, "accepted");
    assert.equal(result.httpStatus, 202);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].auth, "Bearer test-webhook-key-value");
    assert.match(seen[0].contentType, /application\/json/);
    assert.deepEqual(seen[0].body, {
      source: "triangle-client",
      type: "mesh.mailbox.wake",
      installationId,
      instanceId,
      agentId,
      profile,
      highWatermark: 42,
      reason: "wake",
    });
  });
});

test("wake bridge posts on MESH hint and keeps watching after webhook failure", async () => {
  let calls = 0;
  const statuses = [];
  await withWebhookServer(({ res }) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "busy" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (httpUrl) => {
    const binding = validateGrokBotBinding(sampleBinding());
    const watchTransport = createFakeWatchTransport({
      polls: [
        { cursor: 1, events: [] },
        { cursor: 5, events: [{ agent_id: agentId, high_watermark: 5 }] },
        { cursor: 8, events: [{ agent_id: agentId, high_watermark: 8 }] },
      ],
    });
    const cursorStore = createMemoryCursorStore(0);
    const logs = [];
    const bridge = createGrokBotWakeBridge({
      binding,
      watchTransport,
      cursorStore,
      coalesceMs: 5,
      dispatcher: createGrokBotWakeDispatcher({
        async readCredentials() {
          return { url: httpUrl, key: "test-webhook-key-value" };
        },
        webhookUrlPath: "/private/grok-bot-webhook.url",
        webhookKeyPath: "/private/grok-bot-webhook.key",
      }),
      logger: {
        error(event, detail) {
          logs.push({ event, detail });
        },
      },
    });

    // startup_reconcile + first wake (503) + second wake (200)
    const result = await bridge.start({ maxCycles: 3 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(result.cycles, 3);
    assert.equal(calls, 3); // reconcile + two wakes
    assert.ok(logs.some((entry) => entry.event === "triangle_grok_bot_wake_failed"));
    assert.ok(logs.every((entry) => !JSON.stringify(entry).includes("test-webhook-key-value")));
    assert.ok(logs.every((entry) => !JSON.stringify(entry).includes(httpUrl)));
    statuses.push(await bridge.stop());
  });
  assert.equal(statuses[0].status, "stopped");
});

test("wake bridge does not claim reply or ack and ignores other profiles", async () => {
  const posted = [];
  const bridge = createGrokBotWakeBridge({
    binding: validateGrokBotBinding(sampleBinding()),
    watchTransport: createFakeWatchTransport({ polls: [] }),
    dispatcher: {
      wakeMode: "webhook",
      async deliver(payload) {
        posted.push(payload);
        return { status: "accepted", httpStatus: 200 };
      },
    },
  });
  const ignored = await bridge.handleWake({
    instanceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    highWatermark: 9,
    reason: "wake",
  });
  assert.equal(ignored.status, "ignored_profile");
  assert.equal(posted.length, 0);
  const accepted = await bridge.handleWake({
    instanceId,
    highWatermark: 11,
    reason: "startup_reconcile",
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "mesh.mailbox.wake");
  assert.equal(posted[0].reason, "startup_reconcile");
  assert.equal(posted[0].profile, "bob");
  // No claim/reply/ack fields in the wake payload.
  assert.equal(posted[0].deliveryId, undefined);
  assert.equal(posted[0].claimId, undefined);
});

test("atomic cursor file uses {\"cursor\":N} shape", async () => {
  const { createAtomicFileCursorStore } = await import("../src/grok-bot-wake.mjs");
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "grok-bot-wake-cursor.json");
    const store = createAtomicFileCursorStore({ filePath, initial: 0 });
    await store.write(17);
    const raw = await readFile(filePath, "utf8");
    assert.deepEqual(JSON.parse(raw), { cursor: 17 });
    assert.equal(await store.read(), 17);
  });
});
