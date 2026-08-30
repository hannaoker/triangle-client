import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createAgentWorker } from "../src/runtime.mjs";

test("an empty inbox never invokes the reasoning runner", async () => {
  let runnerCalls = 0;
  const worker = createAgentWorker({
    deliveryClient: {
      async listUnread() {
        return [];
      },
      async completeAndAcknowledge() {
        throw new Error("completion must not run for an empty inbox");
      },
    },
    runner: {
      async run() {
        runnerCalls += 1;
        return { status: "completed", text: "unexpected" };
      },
    },
  });

  assert.deepEqual(await worker.runOnce(), { found: 0, processed: 0 });
  assert.equal(runnerCalls, 0);
});

test("watch drains work immediately and sleeps only after an empty poll", async () => {
  const inboxes = [[{ id: "one" }], []];
  const sleeps = [];
  const controller = new AbortController();
  const worker = createAgentWorker({
    deliveryClient: {
      async listUnread() {
        return inboxes.shift() ?? [];
      },
      async completeAndAcknowledge(message, generate) {
        await generate({ text: message.id });
      },
    },
    runner: {
      async run() {
        return { status: "completed", text: "done" };
      },
    },
    pollIntervalMs: 25,
  });

  const result = await worker.watch({
    signal: controller.signal,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      controller.abort();
    },
  });

  assert.deepEqual(sleeps, [25]);
  assert.deepEqual(result, { processed: 1, stopped: true });
});

test("runOnce preserves list, generate, persist, acknowledge order", async () => {
  const events = [];
  const message = { id: "one" };
  const worker = createAgentWorker({
    deliveryClient: {
      async listUnread() {
        events.push("list");
        return [message];
      },
      async completeAndAcknowledge(received, generate) {
        assert.equal(received, message);
        const result = await generate({ text: "prompt" });
        events.push(`persist:${result.text}`);
        events.push("ack");
      },
    },
    runner: {
      async run() {
        events.push("generate");
        return { status: "completed", text: "reply" };
      },
    },
  });
  assert.deepEqual(await worker.runOnce(), { found: 1, processed: 1 });
  assert.deepEqual(events, ["list", "generate", "persist:reply", "ack"]);
});

test("concurrent runOnce calls share one delivery cycle", async () => {
  let lists = 0;
  let completions = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const worker = createAgentWorker({
    deliveryClient: {
      async listUnread() {
        lists += 1;
        await blocked;
        return [{ id: "one" }];
      },
      async completeAndAcknowledge() {
        completions += 1;
      },
    },
    runner: { async run() { return { status: "completed", text: "reply" }; } },
  });
  const first = worker.runOnce();
  const second = worker.runOnce();
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { found: 1, processed: 1 },
    { found: 1, processed: 1 },
  ]);
  assert.equal(lists, 1);
  assert.equal(completions, 1);
});

test("watch applies bounded backoff and redacts unexpected errors", async () => {
  const sleeps = [];
  const logs = [];
  const controller = new AbortController();
  let attempts = 0;
  const worker = createAgentWorker({
    deliveryClient: {
      async listUnread() {
        attempts += 1;
        throw new Error("mesh-secret storage host");
      },
      async completeAndAcknowledge() {},
    },
    runner: { async run() { return { status: "completed", text: "reply" }; } },
    pollIntervalMs: 10,
    maxBackoffMs: 20,
    logger: { error(event, details) { logs.push({ event, details }); } },
  });
  await worker.watch({
    signal: controller.signal,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (sleeps.length === 3) controller.abort();
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [10, 20, 20]);
  assert.deepEqual(logs, [
    { event: "agent_worker_cycle_failed", details: { error: "Worker cycle failed" } },
    { event: "agent_worker_cycle_failed", details: { error: "Worker cycle failed" } },
    { event: "agent_worker_cycle_failed", details: { error: "Worker cycle failed" } },
  ]);
});

test("runOnce propagates caller abort through list, completion, and runner", async () => {
  const controller = new AbortController();
  const seen = [];
  const worker = createAgentWorker({
    deliveryClient: {
      async listUnread(options) {
        seen.push(options.signal);
        return [{ id: "one" }];
      },
      async completeAndAcknowledge(_message, generate, options) {
        seen.push(options.signal);
        return generate({ text: "prompt" }, options);
      },
    },
    runner: {
      async run(_request, options) {
        seen.push(options.signal);
        controller.abort();
        throw new Error("aborted by runner");
      },
    },
  });

  await assert.rejects(worker.runOnce({ signal: controller.signal }), /aborted/);
  assert.deepEqual(seen, [controller.signal, controller.signal, controller.signal]);
});

test("watch aborts immediately while a custom sleep ignores its signal", async () => {
  const controller = new AbortController();
  const worker = createAgentWorker({
    deliveryClient: {
      async listUnread() { return []; },
      async completeAndAcknowledge() {},
    },
    runner: { async run() { return { status: "completed", text: "unused" }; } },
    pollIntervalMs: 60_000,
  });
  const watching = worker.watch({
    signal: controller.signal,
    sleep: async () => new Promise(() => {}),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error("watch did not abort")), 50));
  assert.deepEqual(await Promise.race([watching, guard]), { processed: 0, stopped: true });
});

test("watch clears the real default polling timer on shutdown", () => {
  const runtimeUrl = new URL("../src/runtime.mjs", import.meta.url).href;
  const script = `
    import { createAgentWorker } from ${JSON.stringify(runtimeUrl)};
    const controller = new AbortController();
    const worker = createAgentWorker({
      deliveryClient: { async listUnread() { return []; }, async completeAndAcknowledge() {} },
      runner: { async run() { return { status: "completed", text: "unused" }; } },
      pollIntervalMs: 300000,
    });
    const watching = worker.watch({ signal: controller.signal });
    setImmediate(() => controller.abort());
    await watching;
    process.stdout.write("stopped");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 500,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout, "stopped");
});

test("polling rejects non-finite jitter configuration and random samples", async () => {
  const dependencies = {
    deliveryClient: { async listUnread() { return []; }, async completeAndAcknowledge() {} },
    runner: { async run() { return { status: "completed", text: "unused" }; } },
    pollIntervalMs: 10,
  };
  assert.throws(
    () => createAgentWorker({ ...dependencies, idleJitterRatio: Number.NaN }),
    /idleJitterRatio must be a finite number between 0 and 1/,
  );
  const worker = createAgentWorker({
    ...dependencies,
    idleJitterRatio: 0.1,
    random: () => Number.NaN,
    logger: { error() {} },
  });
  const controller = new AbortController();
  await assert.rejects(
    worker.watch({
      signal: controller.signal,
      sleep: async () => { controller.abort(); },
    }),
    /random must return a finite number between 0 and 1/,
  );
});

test("watch aborts immediately during backoff when custom sleep never settles", async () => {
  const controller = new AbortController();
  const worker = createAgentWorker({
    deliveryClient: {
      async listUnread() { throw new Error("retry"); },
      async completeAndAcknowledge() {},
    },
    runner: { async run() { return { status: "completed", text: "unused" }; } },
    pollIntervalMs: 60_000,
    logger: { error() {} },
  });
  const watching = worker.watch({
    signal: controller.signal,
    sleep: async () => new Promise(() => {}),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error("backoff did not abort")), 50));
  assert.deepEqual(await Promise.race([watching, guard]), { processed: 0, stopped: true });
});

test("contention is processed as zero and sleeps on every adversarial cycle", async () => {
  const controller = new AbortController();
  let polls = 0;
  let completions = 0;
  const sleeps = [];
  const worker = createAgentWorker({
    deliveryClient: {
      async listUnread() {
        polls += 1;
        return [{ id: "contended" }];
      },
      async completeAndAcknowledge() {
        completions += 1;
        return { claimed: false, reconciled: false, acknowledged: false };
      },
    },
    runner: { async run() { throw new Error("runner must not execute"); } },
    pollIntervalMs: 7,
  });
  const result = await worker.watch({
    signal: controller.signal,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (sleeps.length === 100) controller.abort();
    },
  });
  assert.equal(polls, 100);
  assert.equal(completions, 100);
  assert.deepEqual(sleeps, Array(100).fill(7));
  assert.deepEqual(result, { processed: 0, stopped: true });
});
