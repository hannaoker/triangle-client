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
  isWebhookQuotaExhaustion,
  parseRetryAfterMs,
  parseQuotaResetUntilMs,
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
    assert.ok(logs.some((entry) =>
      entry.detail?.code === "webhook_rejected"
      && entry.detail?.httpStatus === 503
      && entry.detail?.reason === "startup_reconcile"));
    assert.ok(logs.every((entry) => !JSON.stringify(entry).includes("test-webhook-key-value")));
    assert.ok(logs.every((entry) => !JSON.stringify(entry).includes(httpUrl)));
    statuses.push(await bridge.stop());
  });
  assert.equal(statuses[0].status, "stopped");
});

test("wake bridge resets after watch failure so retry start is allowed", async () => {
  let polls = 0;
  const helperError = new Error("watch helper poll failed");
  helperError.code = "helper_unavailable";
  const bridge = createGrokBotWakeBridge({
    binding: validateGrokBotBinding(sampleBinding()),
    watchTransport: {
      async poll() {
        polls += 1;
        if (polls === 1) throw helperError;
        return { cursor: polls, events: [] };
      },
    },
    dispatcher: {
      wakeMode: "webhook",
      async deliver() {
        return { status: "accepted", httpStatus: 200 };
      },
    },
  });

  await assert.rejects(
    () => bridge.start({ maxCycles: 1 }),
    (error) => error.code === "helper_unavailable",
  );
  // Sticky started=true would throw already_started on the next attempt.
  const retried = await bridge.start({ maxCycles: 1 });
  assert.equal(retried.cycles, 1);
  assert.equal(polls, 2);
  assert.equal((await bridge.stop()).status, "stopped");
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

test("parseRetryAfterMs and isWebhookQuotaExhaustion classify quota signals", () => {
  assert.equal(parseRetryAfterMs("120"), 120_000);
  assert.equal(parseRetryAfterMs(""), null);
  assert.equal(parseRetryAfterMs("not-a-date"), null);
  const now = Date.parse("Thu, 01 Jan 2026 00:00:00 GMT");
  assert.equal(
    parseRetryAfterMs("Thu, 01 Jan 2026 00:00:30 GMT", { now }),
    30_000,
  );
  assert.equal(isWebhookQuotaExhaustion({ status: 429 }), true);
  assert.equal(isWebhookQuotaExhaustion({ status: 503, bodyText: "busy" }), false);
  assert.equal(
    isWebhookQuotaExhaustion({ status: 503, bodyText: '{"error":"resource_exhausted"}' }),
    true,
  );
});

test("dispatcher marks 429 as webhook_quota_exhausted and honors Retry-After", async () => {
  await withWebhookServer(({ res }) => {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "90",
    });
    res.end(JSON.stringify({ error: "resource_exhausted" }));
  }, async (httpUrl) => {
    const dispatcher = createGrokBotWakeDispatcher({
      async readCredentials() {
        return { url: httpUrl, key: "test-webhook-key-value" };
      },
      webhookUrlPath: "/private/grok-bot-webhook.url",
      webhookKeyPath: "/private/grok-bot-webhook.key",
    });
    await assert.rejects(
      () => dispatcher.deliver({
        source: "triangle-client",
        type: "mesh.mailbox.wake",
        installationId,
        instanceId,
        agentId,
        profile,
        highWatermark: 1,
        reason: "wake",
      }),
      (error) =>
        error.code === "webhook_quota_exhausted"
        && error.status === 429
        && error.quotaExhausted === true
        && error.retryAfterMs === 90_000,
    );
  });
});

test("wake bridge opens instance-keyed backoff on 429 and skips POSTs until reset", async () => {
  let calls = 0;
  let clock = 1_000_000;
  const logs = [];
  const timers = new Map();
  let nextTimerId = 1;
  await withWebhookServer(({ res }) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "30",
      });
      res.end(JSON.stringify({ error: "resource_exhausted" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (httpUrl) => {
    const bridge = createGrokBotWakeBridge({
      binding: validateGrokBotBinding(sampleBinding()),
      watchTransport: createFakeWatchTransport({ polls: [] }),
      initialQuotaBackoffMs: 10_000,
      maxQuotaBackoffMs: 60_000,
      now: () => clock,
      setTimeoutImpl(fn, ms) {
        const id = nextTimerId++;
        timers.set(id, { fn, fireAt: clock + ms });
        return id;
      },
      clearTimeoutImpl(id) {
        timers.delete(id);
      },
      dispatcher: createGrokBotWakeDispatcher({
        async readCredentials() {
          return { url: httpUrl, key: "test-webhook-key-value" };
        },
        webhookUrlPath: "/private/grok-bot-webhook.url",
        webhookKeyPath: "/private/grok-bot-webhook.key",
        now: () => clock,
      }),
      logger: {
        error(event, detail) {
          logs.push({ event, detail });
        },
      },
    });

    const first = await bridge.handleWake({
      instanceId,
      highWatermark: 3,
      reason: "wake",
    });
    assert.equal(first.status, "backoff");
    assert.equal(first.code, "webhook_quota_exhausted");
    assert.equal(first.httpStatus, 429);
    assert.equal(first.backoffMs, 30_000); // Retry-After wins over initial 10s
    assert.equal(first.untilMs, clock + 30_000);
    assert.equal(first.pendingRetryWatermark, 3);
    assert.equal(calls, 1);
    assert.equal(bridge.getQuotaBackoffState()?.instanceId, instanceId);
    assert.equal(timers.size, 1);
    assert.equal(
      logs.filter((entry) => entry.event === "triangle_grok_bot_quota_backoff").length,
      1,
    );
    assert.equal(
      logs.filter((entry) => entry.event === "triangle_grok_bot_wake_failed").length,
      0,
    );

    // Subsequent hints during the window must not POST or re-alert.
    const skipped = await bridge.handleWake({
      instanceId,
      highWatermark: 4,
      reason: "wake",
    });
    assert.equal(skipped.status, "skipped_backoff");
    assert.equal(skipped.untilMs, clock + 30_000);
    assert.equal(skipped.pendingRetryWatermark, 4);
    assert.equal(calls, 1);
    assert.equal(timers.size, 1); // same untilMs — do not double-arm
    assert.equal(
      logs.filter((entry) => entry.event === "triangle_grok_bot_quota_backoff").length,
      1,
    );

    // After the window expires, delivery resumes and clears alert/backoff state.
    clock += 30_000;
    assert.equal(bridge.getQuotaBackoffState()?.pendingRetryWatermark, 4);
    const recovered = await bridge.handleWake({
      instanceId,
      highWatermark: 5,
      reason: "wake",
    });
    assert.equal(recovered.status, "accepted");
    assert.equal(calls, 2);
    assert.equal(bridge.getQuotaBackoffState(), null);
    assert.equal(timers.size, 0);
    assert.ok(logs.every((entry) => !JSON.stringify(entry).includes("test-webhook-key-value")));
    assert.ok(logs.every((entry) => !JSON.stringify(entry).includes(httpUrl)));
  });
});

test("wake bridge does not open backoff on non-quota webhook failures", async () => {
  let calls = 0;
  const logs = [];
  await withWebhookServer(({ res }) => {
    calls += 1;
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "busy" }));
  }, async (httpUrl) => {
    const bridge = createGrokBotWakeBridge({
      binding: validateGrokBotBinding(sampleBinding()),
      watchTransport: createFakeWatchTransport({ polls: [] }),
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

    await assert.rejects(
      () => bridge.handleWake({ instanceId, highWatermark: 1, reason: "wake" }),
      (error) => error.code === "webhook_rejected" && error.status === 503,
    );
    assert.equal(bridge.getQuotaBackoffState(), null);

    await assert.rejects(
      () => bridge.handleWake({ instanceId, highWatermark: 2, reason: "wake" }),
      (error) => error.code === "webhook_rejected",
    );
    assert.equal(calls, 2);
    assert.equal(logs.length, 0); // handleWake rethrows; start()/onWake owns wake_failed logs
  });
});

test("watch loop skips webhook POSTs while quota backoff is open", async () => {
  let calls = 0;
  let clock = 5_000_000;
  const logs = [];
  const timers = new Map();
  let nextTimerId = 1;
  await withWebhookServer(({ res }) => {
    calls += 1;
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "resource_exhausted" }));
  }, async (httpUrl) => {
    const bridge = createGrokBotWakeBridge({
      binding: validateGrokBotBinding(sampleBinding()),
      watchTransport: createFakeWatchTransport({
        polls: [
          { cursor: 1, events: [] },
          { cursor: 5, events: [{ agent_id: agentId, high_watermark: 5 }] },
          { cursor: 8, events: [{ agent_id: agentId, high_watermark: 8 }] },
        ],
      }),
      cursorStore: createMemoryCursorStore(0),
      coalesceMs: 5,
      initialQuotaBackoffMs: 60_000,
      maxQuotaBackoffMs: 60_000,
      now: () => clock,
      setTimeoutImpl(fn, ms) {
        const id = nextTimerId++;
        timers.set(id, { fn, fireAt: clock + ms });
        return id;
      },
      clearTimeoutImpl(id) {
        timers.delete(id);
      },
      dispatcher: createGrokBotWakeDispatcher({
        async readCredentials() {
          return { url: httpUrl, key: "test-webhook-key-value" };
        },
        webhookUrlPath: "/private/grok-bot-webhook.url",
        webhookKeyPath: "/private/grok-bot-webhook.key",
        now: () => clock,
      }),
      logger: {
        error(event, detail) {
          logs.push({ event, detail });
        },
      },
    });

    const result = await bridge.start({ maxCycles: 3 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(result.cycles, 3);
    // startup_reconcile opens backoff; later wakes are skipped without POSTs.
    assert.equal(calls, 1);
    assert.equal(timers.size, 1);
    assert.equal(
      logs.filter((entry) => entry.event === "triangle_grok_bot_quota_backoff").length,
      1,
    );
    assert.equal(
      logs.filter((entry) => entry.event === "triangle_grok_bot_wake_failed").length,
      0,
    );
    assert.equal(bridge.getQuotaBackoffState()?.backoffMs, 60_000);
    await bridge.stop();
    assert.equal(timers.size, 0);
  });
});

test("quota backoff schedules autonomous retry without a new MESH event", async () => {
  let calls = 0;
  let clock = 2_000_000;
  const posted = [];
  const timers = new Map();
  let nextTimerId = 1;

  async function runDueTimers() {
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.fireAt <= clock)
      .sort((a, b) => a[1].fireAt - b[1].fireAt);
    for (const [id, timer] of due) {
      timers.delete(id);
      await timer.fn();
    }
  }

  await withWebhookServer(({ req, body, res }) => {
    calls += 1;
    posted.push({
      auth: req.headers.authorization,
      payload: JSON.parse(body),
    });
    if (calls === 1) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "15",
      });
      res.end(JSON.stringify({ error: "resource_exhausted" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (httpUrl) => {
    const bridge = createGrokBotWakeBridge({
      binding: validateGrokBotBinding(sampleBinding()),
      watchTransport: createFakeWatchTransport({ polls: [] }),
      initialQuotaBackoffMs: 10_000,
      maxQuotaBackoffMs: 60_000,
      now: () => clock,
      setTimeoutImpl(fn, ms) {
        const id = nextTimerId++;
        timers.set(id, { fn, fireAt: clock + ms });
        return id;
      },
      clearTimeoutImpl(id) {
        timers.delete(id);
      },
      dispatcher: createGrokBotWakeDispatcher({
        async readCredentials() {
          return { url: httpUrl, key: "test-webhook-key-value" };
        },
        webhookUrlPath: "/private/grok-bot-webhook.url",
        webhookKeyPath: "/private/grok-bot-webhook.key",
        now: () => clock,
      }),
      logger: { error() {} },
    });

    const first = await bridge.handleWake({
      instanceId,
      highWatermark: 7,
      reason: "wake",
    });
    assert.equal(first.status, "backoff");
    assert.equal(calls, 1);
    assert.equal(timers.size, 1);
    assert.equal(bridge.getQuotaBackoffState()?.pendingRetryWatermark, 7);

    // No additional MESH event — only the armed untilMs retry may POST again.
    clock += 15_000;
    await runDueTimers();
    assert.equal(calls, 2);
    assert.equal(posted[1].payload.highWatermark, 7);
    assert.equal(posted[1].payload.reason, "quota_backoff_retry");
    assert.equal(posted[1].auth, "Bearer test-webhook-key-value");
    assert.equal(bridge.getQuotaBackoffState(), null);
    assert.equal(timers.size, 0);
    assert.ok(posted.every((entry) => !JSON.stringify(entry).includes(httpUrl)));
  });
});

test("quota-expiry timer and simultaneous MESH wake share one webhook attempt", async () => {
  let clock = 10_000;
  let timerCallback = null;
  const delivered = [];
  let releaseDelivery;
  const deliveryGate = new Promise((resolve) => {
    releaseDelivery = resolve;
  });
  const bridge = createGrokBotWakeBridge({
    binding: validateGrokBotBinding(sampleBinding()),
    watchTransport: createFakeWatchTransport({ polls: [] }),
    initialQuotaBackoffMs: 1_000,
    maxQuotaBackoffMs: 1_000,
    now: () => clock,
    setTimeoutImpl(fn) {
      timerCallback = fn;
      return 1;
    },
    clearTimeoutImpl() {},
    dispatcher: {
      async deliver(payload) {
        delivered.push(payload);
        if (delivered.length === 1) {
          const error = new Error("quota exhausted");
          error.code = "webhook_quota_exhausted";
          error.status = 429;
          throw error;
        }
        await deliveryGate;
        return { status: "accepted" };
      },
    },
    logger: { error() {} },
  });

  await bridge.handleWake({ instanceId, highWatermark: 1, reason: "wake" });
  assert.equal(delivered.length, 1);
  clock += 1_000;
  const retry = timerCallback();
  await new Promise((resolve) => setImmediate(resolve));
  const concurrentWake = bridge.handleWake({ instanceId, highWatermark: 2, reason: "wake" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 2, "concurrent expiry paths must not duplicate the webhook POST");

  releaseDelivery();
  await Promise.all([retry, concurrentWake]);
  assert.equal(delivered.length, 2);
});

test("an in-flight quota retry cannot re-arm after bridge stop", async () => {
  let clock = 3_000_000;
  let calls = 0;
  let releaseRetry;
  const timers = new Map();
  let nextTimerId = 1;
  const quotaError = () => Object.assign(new Error("quota exhausted"), {
    code: "webhook_quota_exhausted",
    quotaExhausted: true,
    status: 429,
  });

  const bridge = createGrokBotWakeBridge({
    binding: validateGrokBotBinding(sampleBinding()),
    watchTransport: createFakeWatchTransport({ polls: [] }),
    initialQuotaBackoffMs: 10_000,
    maxQuotaBackoffMs: 60_000,
    now: () => clock,
    setTimeoutImpl(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, fireAt: clock + ms });
      return id;
    },
    clearTimeoutImpl(id) {
      timers.delete(id);
    },
    dispatcher: {
      async deliver() {
        calls += 1;
        if (calls === 1) throw quotaError();
        return new Promise((resolve, reject) => {
          releaseRetry = () => reject(quotaError());
        });
      },
    },
    logger: { error() {} },
  });

  const first = await bridge.handleWake({ instanceId, highWatermark: 9, reason: "wake" });
  assert.equal(first.status, "backoff");
  clock += 10_000;
  const [[timerId, timer]] = timers;
  timers.delete(timerId);
  const retry = timer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);

  await bridge.stop();
  releaseRetry();
  await retry;

  assert.equal(timers.size, 0);
  assert.equal(bridge.getQuotaBackoffState(), null);
});

test("parseQuotaResetUntilMs detects multi-day reset timestamps", () => {
  const futureIso = "2026-09-28T12:00:00.000Z";
  const nowMs = Date.parse("2026-09-24T00:00:00.000Z");
  const msg = `included usage limit reached, resets at ${futureIso}`;
  const parsed = parseQuotaResetUntilMs(msg, { now: nowMs });
  assert.equal(parsed, Date.parse(futureIso));

  const invalid = "temporary rate limit exceeded";
  assert.equal(parseQuotaResetUntilMs(invalid, { now: nowMs }), null);
});

test("pre-wake receipt filtering settles receipts via helper and suppresses wake", async () => {
  let webhookCalls = 0;
  const helperCalls = [];

  const fakeProxy = {
    async status() {
      return { open: null };
    },
    async claimNext() {
      helperCalls.push("claimNext");
      if (helperCalls.length === 1) {
        // Simulate receipt-only delivery settled by helper
        return {
          receiptOnly: true,
          replyRequired: false,
          open: null,
        };
      }
      return null;
    },
  };

  const bridge = createGrokBotWakeBridge({
    binding: validateGrokBotBinding(sampleBinding()),
    watchTransport: createFakeWatchTransport({ polls: [] }),
    filterReceipts: true,
    helperPath: "/dummy/path/triangle-mailbox",
    createTransactionProxy: () => fakeProxy,
    dispatcher: {
      async deliver() {
        webhookCalls += 1;
        return { ok: true };
      },
    },
    logger: { info() {}, error() {} },
  });

  const res = await bridge.handleWake({ instanceId, highWatermark: 5, reason: "wake" });
  assert.equal(res.status, "skipped_receipt_settled");
  assert.equal(webhookCalls, 0, "webhook must not be called when receipts are settled");
  assert.ok(helperCalls.length > 0);
});

test("pre-wake receipt filtering preserves wake for actionable work", async () => {
  let webhookCalls = 0;
  let claimCount = 0;

  const fakeProxy = {
    async status() {
      return { open: null };
    },
    async claimNext() {
      claimCount += 1;
      if (claimCount === 1) {
        // Receipt first
        return { receiptOnly: true, replyRequired: false, open: null };
      }
      // Followed by actionable work
      return { shouldStartModel: true, replyRequired: true, open: { deliveryId: 10 } };
    },
  };

  const bridge = createGrokBotWakeBridge({
    binding: validateGrokBotBinding(sampleBinding()),
    watchTransport: createFakeWatchTransport({ polls: [] }),
    filterReceipts: true,
    helperPath: "/dummy/path/triangle-mailbox",
    createTransactionProxy: () => fakeProxy,
    dispatcher: {
      async deliver() {
        webhookCalls += 1;
        return { ok: true };
      },
    },
    logger: { info() {}, error() {} },
  });

  const res = await bridge.handleWake({ instanceId, highWatermark: 6, reason: "wake" });
  assert.equal(res.ok, true);
  assert.equal(webhookCalls, 1, "webhook must be called when actionable work is present");
  assert.equal(claimCount, 2);
});

test("production webhook 429 carries bodyText with multi-day reset to bridge and persists across restart", async () => {
  await withTempDir(async (dir) => {
    let clock = 1_000_000;
    const futureIso = new Date(clock + 3 * 24 * 3600 * 1000).toISOString();
    const quotaResetStorePath = path.join(dir, `grok-bot-quota-reset.${instanceId}.json`);

    await withWebhookServer(({ res }) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `included usage limit reached, resets at ${futureIso}` }));
    }, async (httpUrl) => {
      const createBridge = () => createGrokBotWakeBridge({
        binding: validateGrokBotBinding(sampleBinding()),
        watchTransport: createFakeWatchTransport({ polls: [] }),
        now: () => clock,
        quotaResetStorePath,
        dispatcher: createGrokBotWakeDispatcher({
          async readCredentials() {
            return { url: httpUrl, key: "test-webhook-key-value" };
          },
          webhookUrlPath: "/private/grok-bot-webhook.url",
          webhookKeyPath: "/private/grok-bot-webhook.key",
          now: () => clock,
        }),
        logger: { info() {}, error() {} },
      });

      const bridge1 = createBridge();
      const firstRes = await bridge1.handleWake({ instanceId, highWatermark: 10, reason: "wake" });
      assert.equal(firstRes.status, "backoff");
      assert.equal(firstRes.untilMs, Date.parse(futureIso));

      // Verify file persistence
      const savedRaw = await readFile(quotaResetStorePath, "utf8");
      assert.equal(JSON.parse(savedRaw).resetsAt, Date.parse(futureIso));

      // Stop bridge1 — should NOT erase persisted reset
      await bridge1.stop();
      const afterStopRaw = await readFile(quotaResetStorePath, "utf8");
      assert.equal(JSON.parse(afterStopRaw).resetsAt, Date.parse(futureIso));

      // Start bridge2 (simulating restart)
      const bridge2 = createBridge();
      await bridge2.loadPersistedQuotaReset();
      const state = bridge2.getQuotaBackoffState();
      assert.equal(state.untilMs, Date.parse(futureIso));

      // A wake attempt on bridge2 is immediately skipped due to persisted backoff
      const skippedRes = await bridge2.handleWake({ instanceId, highWatermark: 11, reason: "wake" });
      assert.equal(skippedRes.status, "skipped_backoff");
      assert.equal(skippedRes.untilMs, Date.parse(futureIso));

      await bridge2.stop();
    });
  });
});

test("pre-wake receipt filtering defers when Bob already holds open claim", async () => {
  let webhookCalls = 0;

  const fakeProxy = {
    async status() {
      return { open: { deliveryId: 42, state: "claimed" } };
    },
    async claimNext() {
      throw new Error("should not be called when open claim exists");
    },
  };

  const bridge = createGrokBotWakeBridge({
    binding: validateGrokBotBinding(sampleBinding()),
    watchTransport: createFakeWatchTransport({ polls: [] }),
    filterReceipts: true,
    helperPath: "/dummy/path/triangle-mailbox",
    createTransactionProxy: () => fakeProxy,
    dispatcher: {
      async deliver() {
        webhookCalls += 1;
        return { ok: true };
      },
    },
    logger: { info() {}, error() {} },
  });

  const res = await bridge.handleWake({ instanceId, highWatermark: 7, reason: "wake" });
  assert.equal(res.ok, true);
  assert.equal(webhookCalls, 1, "webhook should proceed and defer to open claim");
});
