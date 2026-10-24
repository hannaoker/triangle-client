import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";

import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createLocalMessagingNotifier } from "../src/local-messaging-notifier.mjs";
import { createInstalledLocalMessagingHost, loadLocalMessagingConfig } from "../src/local-messaging-host.mjs";
import { createProfiledReasonerGate } from "../src/concurrency-gate.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { resolveLocalSocketAddress } from "../src/local-messaging-address.mjs";
import { writePrivateJson, readPrivateJson } from "../src/local-messaging-auth-broker.mjs";

function createIsolatedDir(prefix = "triangle-notifier-test-") {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

test("notifier unit: exact scoped ack, one outstanding, fingerprint dedupe, and stop custody", async () => {
  const stateRoot = createIsolatedDir();
  let journal;
  try {
    journal = createLocalMessagingJournal({ stateRoot });
    const targetIdentity = "desktop-sender-1";
    const threadId = "01a16250-9c72-7823-92f4-65eaeb67db75";
    const bindingId = "01a1624d-36d4-7520-b9f9-9f0db8be075f";
    const calls = [];

    const fakeAdapter = {
      async notify(binding, snapshot, options = {}) {
        calls.push({ binding, snapshot, options });
        return {
          state: "accepted",
          status: "accepted",
          receipt: {
            queuedId: randomUUID(),
            threadId: binding.threadId,
          },
        };
      },
    };

    const wakeConfig = {
      enabled: true,
      codexPath: "/bin/fake-codex",
      codexHome: "/tmp/fake-codex-home",
      minIntervalMs: 10,
    };

    const notifier = createLocalMessagingNotifier({
      journal,
      targetIdentity,
      threadId,
      bindingId,
      generation: 1,
      wakeConfig,
      adapter: fakeAdapter,
      minIntervalMs: 10,
      timerIntervalMs: 50,
    });

    await notifier.start();

    // Initially: no unread replies or held messages -> no wake hint sent
    assert.equal(calls.length, 0);

    // Add unread reply addressed to desktop
    await journal.recordSend({
      sender: targetIdentity,
      recipient: "worker-agent",
      messageId: "msg-1",
      requestId: "req-1",
      text: "hello",
    });
    await journal.recordReply({
      sender: "worker-agent",
      recipient: targetIdentity,
      messageId: "rep-1",
      requestId: "req-1",
      inReplyTo: "msg-1",
      text: "reply text",
    });

    // Evaluate obligations
    await notifier.evaluateObligations();

    // Exactly one wake hint sent!
    assert.equal(calls.length, 1);
    const firstCall = calls[0];
    assert.equal(firstCall.snapshot.replyCount, 1);
    assert.equal(firstCall.snapshot.heldCount, 0);
    assert.equal(firstCall.snapshot.lateResult, false);
    const wakeId1 = firstCall.snapshot.wakeId;

    // Delivery state is now accepted_awaiting_ack
    const status1 = await notifier.status();
    assert.equal(status1.deliveryState, "accepted_awaiting_ack");
    assert.equal(status1.activeWakeId, wakeId1);

    // While awaiting ack: new evaluate passes cannot submit another hint
    await notifier.evaluateObligations();
    assert.equal(calls.length, 1, "One outstanding across accepted_awaiting_ack");

    // Foreign requester cannot ack
    await assert.rejects(
      notifier.ackNotification({ requester: "stranger", wakeId: wakeId1, generation: 1 }),
      (err) => err.code === "foreign_access_denied",
    );

    // Stale generation cannot ack
    await assert.rejects(
      notifier.ackNotification({ requester: targetIdentity, wakeId: wakeId1, generation: 99 }),
      (err) => err.code === "stale_wake_generation",
    );

    // Stale wakeId cannot ack
    await assert.rejects(
      notifier.ackNotification({ requester: targetIdentity, wakeId: "00000000-0000-0000-0000-000000000000", generation: 1 }),
      (err) => err.code === "stale_wake_id",
    );

    // Authorized exact ack succeeds
    const ackRes = await notifier.ackNotification({
      requester: targetIdentity,
      wakeId: wakeId1,
      generation: 1,
    });
    assert.equal(ackRes.acknowledged, true);

    const statusAfterAck = await notifier.status();
    assert.equal(statusAfterAck.deliveryState, "idle");
    assert.equal(statusAfterAck.activeWakeId, null);

    // Unchanged backlog: reply rep-1 is still unconsumed, but fingerprint was acknowledged!
    await new Promise((r) => setTimeout(r, 20));
    await notifier.evaluateObligations();
    assert.equal(calls.length, 1, "Unchanged unread backlog never loops");

    // New reply arrives: fingerprint changes, triggers next hint after minInterval
    await journal.recordSend({
      sender: targetIdentity,
      recipient: "worker-agent",
      messageId: "msg-2",
      requestId: "req-2",
      text: "hello 2",
    });
    await journal.recordReply({
      sender: "worker-agent",
      recipient: targetIdentity,
      messageId: "rep-2",
      requestId: "req-2",
      inReplyTo: "msg-2",
      text: "reply text 2",
    });

    await new Promise((r) => setTimeout(r, 20));
    await notifier.evaluateObligations();
    assert.equal(calls.length, 2, "Changed snapshot sends next hint");
    assert.equal(calls[1].snapshot.replyCount, 2, "Coalesces unread replies");

    // Test stop custody: aborts active adapter
    let slowAbortCalled = false;
    const slowAdapter = {
      async notify(binding, snapshot, options = {}) {
        options.signal?.addEventListener("abort", () => {
          slowAbortCalled = true;
        });
        await new Promise((r) => setTimeout(r, 1000));
        return { state: "uncertain", status: "uncertain", reason: "aborted" };
      },
    };

    const ackRes2 = await notifier.ackNotification({
      requester: targetIdentity,
      wakeId: calls[1].snapshot.wakeId,
      generation: 1,
    });
    assert.equal(ackRes2.acknowledged, true);

    const slowNotifier = createLocalMessagingNotifier({
      journal,
      targetIdentity,
      threadId,
      bindingId,
      generation: 1,
      wakeConfig,
      adapter: slowAdapter,
      minIntervalMs: 0,
      timerIntervalMs: 50,
    });

    // Add a third reply
    await journal.recordSend({
      sender: targetIdentity,
      recipient: "worker-agent",
      messageId: "msg-3",
      requestId: "req-3",
      text: "hello 3",
    });
    await journal.recordReply({
      sender: "worker-agent",
      recipient: targetIdentity,
      messageId: "rep-3",
      requestId: "req-3",
      inReplyTo: "msg-3",
      text: "reply text 3",
    });

    const evalPromise = slowNotifier.evaluateObligations();
    await new Promise((r) => setTimeout(r, 20));
    await slowNotifier.stop();
    await evalPromise;
    assert.equal(slowAbortCalled, true, "Stop aborted active adapter invocation");

    await notifier.stop();
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("end-to-end local socket integration with fake adapter: request->reply->hint->ack->coalescing->restart->heldlate->shutdown", { skip: process.platform === "win32" }, async () => {
  const root = createIsolatedDir("triangle-wake-e2e-");
  const stateRoot = path.join(root, "state");
  const configDir = path.join(root, "config");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const desktopSenderId = createHash("sha256").update("desktop-sender-identity").digest("hex");
  const desktopThreadId = "01a16250-9c72-7823-92f4-65eaeb67db75";
  const desktopBindingId = createHash("sha256").update(`${desktopSenderId}\0${desktopThreadId}`).digest("hex").slice(0, 32);
  const secret = createHash("sha256").update("secret-token-1234567890abcdef").digest("hex");

  const workerInstanceId = createHash("sha256").update("worker-instance-gravity2").digest("hex");

  const bindingPath = path.join(configDir, "desktop-binding.json");
  const integrationPath = path.join(stateRoot, "desktop-integration.json");
  const configPath = path.join(configDir, "local-messaging.json");

  writePrivateJson(bindingPath, { version: 1, instanceId: desktopSenderId });
  writePrivateJson(integrationPath, {
    version: 1,
    bindingId: desktopBindingId,
    senderId: desktopSenderId,
    threadId: desktopThreadId,
    secret,
  });

  const wakeCalls = [];
  const fakeWakeAdapter = {
    async notify(binding, snapshot, options = {}) {
      wakeCalls.push({ binding, snapshot, options });
      return {
        state: "accepted",
        status: "accepted",
        receipt: {
          queuedId: randomUUID(),
          threadId: binding.threadId,
        },
      };
    },
  };

  const config = {
    version: 1,
    enabled: true,
    stateRoot,
    bindingPath,
    integrationPath,
    recipients: [{ profile: "gravity2", instanceId: workerInstanceId }],
    runnerTimeoutMs: 5000,
    wake: {
      enabled: true,
      codexPath: "/bin/mock-codex",
      codexHome: "/tmp/mock-codex-home",
      minIntervalMs: 15000,
      timerIntervalMs: 15000,
    },
  };
  writePrivateJson(configPath, config);

  // Registered runner for worker
  let replyCounter = 0;
  const runners = new Map([
    [
      workerInstanceId,
      {
        async run(req) {
          replyCounter++;
          return { status: "completed", text: `worker reply ${replyCounter}` };
        },
      },
    ],
  ]);

  const gate = createProfiledReasonerGate();

  let host = createInstalledLocalMessagingHost({
    configPath,
    runners,
    gate,
    wakeAdapter: fakeWakeAdapter,
    minIntervalMs: 10,
    timerIntervalMs: 50,
  });

  await host.start();

  const { socketPath } = resolveLocalSocketAddress({ stateRoot });
  const client = createLocalControlClient({ socketPath, senderId: desktopSenderId });

  try {
    // Authenticate desktop client
    const grant = await client.exchangeTurnBinding({
      bindingId: desktopBindingId,
      threadId: desktopThreadId,
      secret,
    });
    const credential = grant.credential;
    const rpcOpts = { credential };

    // 1. request -> reply
    const sendRes = await client.sendMessage(
      {
        to: workerInstanceId,
        text: "first request to worker",
        messageId: "msg-req-1",
        requestId: "req-1",
      },
      rpcOpts,
    );
    assert.equal(sendRes.isDuplicate, false);

    // Wait for worker reply to be produced and journaled
    const reply = await client.waitForReply({
      requestId: "req-1",
      timeoutMs: 3000,
      pollIntervalMs: 50,
    });
    assert.equal(reply.text, "worker reply 1");

    // 2. one hint delivered to fake adapter
    // Wait for notifier evaluation
    for (let i = 0; i < 50; i++) {
      if (wakeCalls.length >= 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(wakeCalls.length, 1, "Exactly one wake hint sent");
    assert.equal(wakeCalls[0].snapshot.replyCount, 1);
    assert.equal(wakeCalls[0].snapshot.heldCount, 0);
    assert.equal(wakeCalls[0].snapshot.lateResult, false);
    const firstWakeId = wakeCalls[0].snapshot.wakeId;

    // Check status via client localStatus
    const st = await client.localStatus(rpcOpts);
    assert.equal(st.wake.deliveryState, "accepted_awaiting_ack");
    assert.equal(st.wake.activeWakeId, firstWakeId);

    // 3. authorized ack
    const ackOutcome = await client.ackWake({ wakeId: firstWakeId, generation: 1 }, rpcOpts);
    assert.equal(ackOutcome.acknowledged, true);

    const stAfterAck = await client.localStatus(rpcOpts);
    assert.equal(stAfterAck.wake.deliveryState, "idle");
    assert.equal(stAfterAck.wake.activeWakeId, null);

    // 4. unchanged backlog: no repeat
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(wakeCalls.length, 1, "Unchanged unread backlog does not repeat");

    // 5. new reply coalescing
    // Send second request
    await client.sendMessage(
      {
        to: workerInstanceId,
        text: "second request",
        messageId: "msg-req-2",
        requestId: "req-2",
      },
      rpcOpts,
    );
    await client.waitForReply({ requestId: "req-2", timeoutMs: 3000 });

    for (let i = 0; i < 50; i++) {
      if (wakeCalls.length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(wakeCalls.length, 2, "Second wake hint fired");
    // Coalesced reply count: rep 1 (unconsumed) + rep 2 = 2 unread replies
    assert.equal(wakeCalls[1].snapshot.replyCount, 2);

    const secondWakeId = wakeCalls[1].snapshot.wakeId;
    await client.ackWake({ wakeId: secondWakeId, generation: 1 }, rpcOpts);

    // 6. restart unknown: if crashed in 'submitting', recovers to 'uncertain' and does NOT resend
    await host.stop();

    // Directly update journal wake state to 'submitting' with active wakeId and fingerprint to simulate a crash while submitting
    const crashedWakeId = randomUUID();
    const { DatabaseSync } = await import("node:sqlite");
    const rawDb = new DatabaseSync(path.join(stateRoot, "local-messaging.sqlite"));
    const existingBinding = rawDb.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(desktopSenderId);
    rawDb.prepare(
      "UPDATE local_wake_bindings SET delivery_state = 'submitting', active_wake_id = ?, active_fingerprint = ?"
    ).run(crashedWakeId, existingBinding.last_acknowledged_fingerprint);
    rawDb.close();

    // Restart host
    const wakeCallsBeforeRestart = wakeCalls.length;
    host = createInstalledLocalMessagingHost({
      configPath,
      runners,
      gate,
      wakeAdapter: fakeWakeAdapter,
      minIntervalMs: 10,
      timerIntervalMs: 50,
    });
    await host.start();

    // Check status after restart: crash-in-submitting must recover to 'uncertain'
    const client2 = createLocalControlClient({ socketPath, senderId: desktopSenderId });
    const grant2 = await client2.exchangeTurnBinding({
      bindingId: desktopBindingId,
      threadId: desktopThreadId,
      secret,
    });
    const stRestart = await client2.localStatus({ credential: grant2.credential });
    assert.equal(stRestart.wake.deliveryState, "uncertain", "Crashed in submitting recovered to uncertain");
    assert.equal(stRestart.wake.activeWakeId, crashedWakeId);
    assert.equal(wakeCalls.length, wakeCallsBeforeRestart, "No automatic CLI retry on uncertain recovery");

    // Acking the uncertain wake resolves it to idle
    await client2.ackWake({ wakeId: crashedWakeId, generation: 1 }, { credential: grant2.credential });
    const stAfterUncertainAck = await client2.localStatus({ credential: grant2.credential });
    assert.equal(stAfterUncertainAck.wake.deliveryState, "idle");

    // 7. heldlatechange: when a held message gets lateResultText, fingerprint changes and triggers hint
    const rawDb2 = new DatabaseSync(path.join(stateRoot, "local-messaging.sqlite"));
    const now = Date.now();
    rawDb2.prepare(`
      INSERT INTO local_messages (message_id, sender, recipient, request_id, text, canonical_hash, phase, reason, late_result_text, created_at, updated_at)
      VALUES ('held-late-1', ?, ?, 'req-hl-1', 'held text', 'hash-hl-1', 'held', 'timeout', 'late result text for owner', ?, ?)
    `).run(desktopSenderId, workerInstanceId, now, now);
    rawDb2.close();

    const preLateCalls = wakeCalls.length;
    for (let i = 0; i < 50; i++) {
      if (wakeCalls.length > preLateCalls) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(wakeCalls.length, preLateCalls + 1, "Held late result change triggered wake hint");
    const lateCall = wakeCalls[wakeCalls.length - 1];
    assert.equal(lateCall.snapshot.lateResult, true);
    assert.equal(lateCall.snapshot.heldCount, 1);
    // Crucial safety guarantee: late result text is NEVER interpolated into the hint template
    assert.ok(!JSON.stringify(lateCall.snapshot).includes("late result text for owner"));

    await client2.close();
  } finally {
    await client.close();
    await host.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("P1: setup-generated 32-hex integration binding validated by real adapter without bypass using fake runner", async () => {
  const root = createIsolatedDir("triangle-p1-test-");
  const stateRoot = path.join(root, "state");
  const configDir = path.join(root, "config");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const desktopSenderId = createHash("sha256").update("desktop-sender-p1").digest("hex");
  const desktopThreadId = "01a16250-9c72-7823-92f4-65eaeb67db75";
  // Exactly what CLI setup generates: 32-character hex string
  const desktopBindingId = createHash("sha256").update(`${desktopSenderId}\0${desktopThreadId}`).digest("hex").slice(0, 32);
  const secret = createHash("sha256").update("secret-p1-token").digest("hex");
  const workerInstanceId = createHash("sha256").update("worker-instance-p1").digest("hex");

  const bindingPath = path.join(configDir, "desktop-binding.json");
  const integrationPath = path.join(stateRoot, "desktop-integration.json");
  const configPath = path.join(configDir, "local-messaging.json");

  writePrivateJson(bindingPath, { version: 1, instanceId: desktopSenderId });
  writePrivateJson(integrationPath, {
    version: 1,
    bindingId: desktopBindingId,
    senderId: desktopSenderId,
    threadId: desktopThreadId,
    secret,
  });

  const config = {
    version: 1,
    enabled: true,
    stateRoot,
    bindingPath,
    integrationPath,
    recipients: [{ profile: "worker", instanceId: workerInstanceId }],
    runnerTimeoutMs: 5000,
    wake: {
      enabled: true,
      codexPath: "/bin/mock-codex",
      codexHome: "/tmp/mock-codex-home",
      minIntervalMs: 15000,
      timerIntervalMs: 15000,
    },
  };
  writePrivateJson(configPath, config);

  // Fake process runner simulates `codex queue` subprocess output
  let runnerInvoked = false;
  const fakeProcessRunner = async (_file, _args, _options) => {
    runnerInvoked = true;
    const queuedId = randomUUID();
    return {
      code: 0,
      stdout: `Queued message ${queuedId} for thread ${desktopThreadId}.\n`,
      stderr: "",
    };
  };

  const runners = new Map([
    [workerInstanceId, { async run() { return { status: "completed", text: "done" }; } }],
  ]);
  const gate = createProfiledReasonerGate();

  // Create host with wakeAdapter: null (uses real codex-wake-adapter.mjs!)
  // Injects fakeProcessRunner via constructor test seam `wakeRunner`
  let host = createInstalledLocalMessagingHost({
    configPath,
    runners,
    gate,
    wakeAdapter: null, // REAL ADAPTER! No validation bypass!
    wakeRunner: fakeProcessRunner,
    minIntervalMs: 10,
    timerIntervalMs: 50,
  });

  await host.start();
  const { socketPath } = resolveLocalSocketAddress({ stateRoot });
  const client = createLocalControlClient({ socketPath, senderId: desktopSenderId });

  try {
    const grant = await client.exchangeTurnBinding({
      bindingId: desktopBindingId,
      threadId: desktopThreadId,
      secret,
    });

    await client.sendMessage({
      to: workerInstanceId,
      text: "test p1",
      messageId: "msg-p1",
      requestId: "req-p1",
    }, { credential: grant.credential });

    await client.waitForReply({ requestId: "req-p1", timeoutMs: 3000 });

    // Wait for notifier evaluation
    for (let i = 0; i < 50; i++) {
      if (runnerInvoked) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(runnerInvoked, true, "Real adapter successfully validated and invoked fake process runner");

    const st = await client.localStatus({ credential: grant.credential });
    assert.equal(st.wake.deliveryState, "accepted_awaiting_ack");
    assert.ok(st.wake.activeWakeId);

    // Verify journal wake binding has durable UUID and generation
    const { DatabaseSync } = await import("node:sqlite");
    const rawDb = new DatabaseSync(path.join(stateRoot, "local-messaging.sqlite"));
    const row = rawDb.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(desktopSenderId);
    rawDb.close();

    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.ok(UUID_REGEX.test(row.binding_id), "Durable wake bindingId in journal must be a UUID");
    assert.equal(row.generation, 1);
    assert.equal(row.thread_id, desktopThreadId);

    // Same-thread restart reuses existing wakeUUID and generation
    await host.stop();
    host = createInstalledLocalMessagingHost({
      configPath,
      runners,
      gate,
      wakeAdapter: null,
      wakeRunner: fakeProcessRunner,
      minIntervalMs: 10,
      timerIntervalMs: 50,
    });
    await host.start();

    const rawDb2 = new DatabaseSync(path.join(stateRoot, "local-messaging.sqlite"));
    const row2 = rawDb2.prepare("SELECT * FROM local_wake_bindings WHERE target_identity = ?").get(desktopSenderId);
    rawDb2.close();

    assert.equal(row2.binding_id, row.binding_id, "Same-thread restart reuses existing wake UUID");
    assert.equal(row2.generation, row.generation, "Same-thread restart reuses existing generation");
  } finally {
    await client.close();
    await host.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("P2: notifier stop race, stop during start, abort/settlement before unlock, and custody retention", async () => {
  const stateRoot = createIsolatedDir("triangle-p2-test-");
  const journal = createLocalMessagingJournal({ stateRoot });
  try {
    const targetIdentity = "desktop-p2";
    const threadId = "01a16250-9c72-7823-92f4-65eaeb67db75";
    const bindingId = randomUUID();

    // 1. Parent repro: gated getWakeObligations reproduces callsAfterStopReturned=0 with fix
    let callsAfterStopReturned = 0;
    let gateResolve;
    const gatePromise = new Promise((r) => { gateResolve = r; });
    let adapterCalls = 0;
    let gateEnabled = false;

    const fakeAdapter = {
      async notify() {
        adapterCalls++;
        return { state: "accepted", receipt: { queuedId: randomUUID(), threadId } };
      },
    };

    // Proxy journal to gate getWakeObligations
    const gatedJournal = Object.create(journal);
    gatedJournal.getWakeObligations = async (...args) => {
      const res = await journal.getWakeObligations(...args);
      if (gateEnabled) {
        await gatePromise; // Await gate
      }
      return res;
    };

    const notifier = createLocalMessagingNotifier({
      journal: gatedJournal,
      targetIdentity,
      threadId,
      bindingId,
      generation: 1,
      wakeConfig: { enabled: true, codexPath: "/bin/mock", codexHome: "/tmp/mock" },
      adapter: fakeAdapter,
      minIntervalMs: 0,
      timerIntervalMs: 50,
    });
    await notifier.start();

    // Add unread reply so obligations exist AFTER start has completed
    await journal.recordSend({ sender: targetIdentity, recipient: "w", messageId: "m1", requestId: "r1", text: "hi" });
    await journal.recordReply({ sender: "w", recipient: targetIdentity, messageId: "rep1", requestId: "r1", inReplyTo: "m1", text: "rep" });

    // Enable gate now that start is done
    gateEnabled = true;

    // Start evaluation in background: it awaits gated getWakeObligations
    const evalPromise = notifier.evaluateObligations();
    await new Promise((r) => setTimeout(r, 20));

    // Call stop() while getWakeObligations is awaiting
    let stopSettled = false;
    const stopPromise = notifier.stop().then(() => { stopSettled = true; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stopSettled, false, "stop() stays pending until evaluation completes and gate is released");

    // Release gate
    gateResolve();

    // Await stop
    await stopPromise;
    await evalPromise;
    assert.equal(stopSettled, true, "stop() settles after gate release");

    if (adapterCalls > 0) {
      callsAfterStopReturned++;
    }
    assert.equal(callsAfterStopReturned, 0, "No adapter call after stop returned (callsAfterStopReturned must be 0)");
    assert.equal(adapterCalls, 0, "Adapter was never invoked because stop halted evaluation after await");

    // 2. Stop during start() cannot install timer after stop
    let initGateResolve;
    const initGatePromise = new Promise((r) => { initGateResolve = r; });
    const gatedInitJournal = Object.create(journal);
    gatedInitJournal.initWakeBinding = async (...args) => {
      await initGatePromise;
      return await journal.initWakeBinding(...args);
    };

    const notifier2 = createLocalMessagingNotifier({
      journal: gatedInitJournal,
      targetIdentity: "desktop-p2-timer",
      threadId,
      bindingId: randomUUID(),
      generation: 1,
      wakeConfig: { enabled: true, codexPath: "/bin/mock", codexHome: "/tmp/mock" },
      adapter: fakeAdapter,
      minIntervalMs: 0,
      timerIntervalMs: 20,
    });

    const startPromise = notifier2.start();
    await new Promise((r) => setTimeout(r, 10));
    // Call stop during start's await
    const stopPromise2 = notifier2.stop();
    initGateResolve();
    await startPromise;
    await stopPromise2;

    // Wait 60ms to verify no timer fires
    const callsBefore = adapterCalls;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(adapterCalls, callsBefore, "No timer installed after stop during start");

    // 3. Child settlement and journal bookkeeping before stop returns
    let childSettled = false;
    let bookkeepingCommitted = false;
    const slowAdapter = {
      async notify(_b, _s, opts) {
        return new Promise((resolve) => {
          opts.signal?.addEventListener("abort", () => {
            childSettled = true;
            resolve({ state: "uncertain", reason: "aborted" });
          });
        });
      },
    };

    // Tracking journal
    const trackJournal = Object.create(journal);
    const origSetWakeUncertain = journal.setWakeUncertain.bind(journal);
    trackJournal.setWakeUncertain = async (...args) => {
      const res = await origSetWakeUncertain(...args);
      bookkeepingCommitted = true;
      return res;
    };

    const notifier3 = createLocalMessagingNotifier({
      journal: trackJournal,
      targetIdentity: "desktop-p2-child",
      threadId,
      bindingId: randomUUID(),
      generation: 1,
      wakeConfig: { enabled: true, codexPath: "/bin/mock", codexHome: "/tmp/mock" },
      adapter: slowAdapter,
      minIntervalMs: 0,
      timerIntervalMs: 50,
    });
    await notifier3.start();

    await journal.recordSend({ sender: "desktop-p2-child", recipient: "w", messageId: "m3", requestId: "r3", text: "hi3" });
    await journal.recordReply({ sender: "w", recipient: "desktop-p2-child", messageId: "rep3", requestId: "r3", inReplyTo: "m3", text: "rep3" });

    // Trigger evaluation
    const evalPromise3 = notifier3.evaluateObligations();
    for (let i = 0; i < 50; i++) {
      const b = await journal.getWakeBinding("desktop-p2-child");
      if (b.deliveryState === "submitting") break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // Now stop
    await notifier3.stop();
    await evalPromise3;

    assert.equal(childSettled, true, "Active child was aborted and settled");
    assert.equal(bookkeepingCommitted, true, "Journal bookkeeping committed before stop returned");
    const endBinding = await journal.getWakeBinding("desktop-p2-child");
    assert.equal(endBinding.deliveryState, "uncertain");

    // 4. Host cleanup failure retains custody
    const rootDir = createIsolatedDir("triangle-custody-test-");
    const hStateRoot = path.join(rootDir, "state");
    const hConfigDir = path.join(rootDir, "config");
    fs.mkdirSync(hStateRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(hConfigDir, { recursive: true, mode: 0o700 });

    const sId = createHash("sha256").update("custody-sender").digest("hex");
    const tId = randomUUID();
    const bId = createHash("sha256").update(`${sId}\0${tId}`).digest("hex").slice(0, 32);
    const sec = createHash("sha256").update("sec").digest("hex");
    const wId = createHash("sha256").update("w").digest("hex");

    writePrivateJson(path.join(hConfigDir, "desktop-binding.json"), { version: 1, instanceId: sId });
    writePrivateJson(path.join(hStateRoot, "desktop-integration.json"), { version: 1, bindingId: bId, senderId: sId, threadId: tId, secret: sec });
    writePrivateJson(path.join(hConfigDir, "local-messaging.json"), {
      version: 1, enabled: true, stateRoot: hStateRoot,
      bindingPath: path.join(hConfigDir, "desktop-binding.json"),
      integrationPath: path.join(hStateRoot, "desktop-integration.json"),
      recipients: [{ profile: "worker", instanceId: wId }],
      wake: { enabled: true, codexPath: "/bin/mock", codexHome: "/tmp/mock", minIntervalMs: 15000, timerIntervalMs: 15000 },
    });

    const failingAdapter = {
      async notify() { return { state: "accepted", receipt: { queuedId: randomUUID(), threadId: tId } }; },
      async stop() { throw new Error("adapter cleanup failure"); },
    };

    const hostCleanup = createInstalledLocalMessagingHost({
      configPath: path.join(hConfigDir, "local-messaging.json"),
      runners: new Map([[wId, { async run() { return { status: "completed" }; } }]]),
      gate: createProfiledReasonerGate(),
      wakeAdapter: failingAdapter,
      minIntervalMs: 10,
      timerIntervalMs: 50,
    });
    await hostCleanup.start();

    // Calling stop() fails because notifier.stop() throws adapter cleanup failure
    await assert.rejects(
      hostCleanup.stop(),
      /adapter cleanup failure/,
      "Host stop does not swallow cleanup error",
    );

    // Host retained custody: competing journal on same stateRoot is rejected because exclusive lock is still held!
    assert.throws(
      () => createLocalMessagingJournal({ stateRoot: hStateRoot }),
      (err) => err.code === "journal_busy" || err.code === "journal_owned",
      "Host retained journal custody on cleanup failure",
    );

    // Clean up test host resources so the background listening socket closes
    failingAdapter.stop = async () => {};
    await hostCleanup.stop().catch(() => {});
    fs.rmSync(rootDir, { recursive: true, force: true });
  } finally {
    await journal.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("P3: strict config loader rejects unsafe intervals, timeout, forbidden runner key, disabled shapes strict", async () => {
  const root = createIsolatedDir("triangle-p3-test-");
  const stateRoot = path.join(root, "state");
  const configDir = path.join(root, "config");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const wId = createHash("sha256").update("w").digest("hex");

  const baseConfig = {
    version: 1,
    enabled: true,
    stateRoot,
    bindingPath: path.join(configDir, "desktop-binding.json"),
    integrationPath: path.join(stateRoot, "desktop-integration.json"),
    recipients: [{ profile: "w", instanceId: wId }],
  };

  const testConfig = (wakeOverrides) => {
    const p = path.join(configDir, `test-config-${randomUUID()}.json`);
    writePrivateJson(p, { ...baseConfig, wake: wakeOverrides });
    return () => loadLocalMessagingConfig(p);
  };

  // Rejects minIntervalMs < 15000 (0, 10, 14999, negative, float)
  assert.throws(testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", minIntervalMs: 0 }), /minIntervalMs/);
  assert.throws(testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", minIntervalMs: 10 }), /minIntervalMs/);
  assert.throws(testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", minIntervalMs: 14999 }), /minIntervalMs/);
  assert.throws(testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", minIntervalMs: -1 }), /minIntervalMs/);
  assert.throws(testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", minIntervalMs: 15000.5 }), /minIntervalMs/);

  // Rejects timerIntervalMs <= 0
  assert.throws(testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", timerIntervalMs: 0 }), /timerIntervalMs/);
  assert.throws(testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", timerIntervalMs: -5 }), /timerIntervalMs/);

  // Rejects 'runner' in serialized wake config
  assert.throws(testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", runner: "subprocess" }), /Invalid wake configuration/);

  // Rejects timeoutMs <= 0 or > 15000
  assert.throws(testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", timeoutMs: 0 }), /timeoutMs/);
  assert.throws(testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", timeoutMs: 15001 }), /timeoutMs/);

  // Disabled shapes strict too: invalid path or unsafe values when enabled: false
  assert.throws(testConfig({ enabled: false, codexPath: "relative/path" }), /Wake paths must be absolute/);
  assert.throws(testConfig({ enabled: false, minIntervalMs: 10 }), /minIntervalMs/);
  assert.throws(testConfig({ enabled: false, timeoutMs: 20000 }), /timeoutMs/);

  // Valid config >= 15000 passes
  const valid = testConfig({ enabled: true, codexPath: "/bin/c", codexHome: "/tmp/c", minIntervalMs: 15000, timerIntervalMs: 5000, timeoutMs: 10000 });
  assert.doesNotThrow(valid);

  fs.rmSync(root, { recursive: true, force: true });
});

test("P4: startup order: fake adapter connects to authenticated socket during first notify and retrieves/acks", async () => {
  const root = createIsolatedDir("triangle-p4-test-");
  const stateRoot = path.join(root, "state");
  const configDir = path.join(root, "config");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const desktopSenderId = createHash("sha256").update("desktop-p4").digest("hex");
  const desktopThreadId = randomUUID();
  const desktopBindingId = createHash("sha256").update(`${desktopSenderId}\0${desktopThreadId}`).digest("hex").slice(0, 32);
  const secret = createHash("sha256").update("sec-p4").digest("hex");
  const workerInstanceId = createHash("sha256").update("worker-p4").digest("hex");

  writePrivateJson(path.join(configDir, "desktop-binding.json"), { version: 1, instanceId: desktopSenderId });
  writePrivateJson(path.join(stateRoot, "desktop-integration.json"), {
    version: 1, bindingId: desktopBindingId, senderId: desktopSenderId, threadId: desktopThreadId, secret,
  });

  const { socketPath } = resolveLocalSocketAddress({ stateRoot });

  // Pre-seed journal with an unread reply so there is initial backlog at startup
  const initJournal = createLocalMessagingJournal({ stateRoot });
  await initJournal.recordSend({ sender: desktopSenderId, recipient: workerInstanceId, messageId: "m-pre", requestId: "r-pre", text: "pre" });
  await initJournal.recordReply({ sender: workerInstanceId, recipient: desktopSenderId, messageId: "rep-pre", requestId: "r-pre", inReplyTo: "m-pre", text: "reply pre" });
  await initJournal.close();

  let notifyConnectedSuccessfully = false;
  let receivedReplyText = null;
  let ackResult = null;

  const fakeConnectingAdapter = {
    async notify(binding, snapshot, _options = {}) {
      // Connect to Triangle socket immediately during first notify!
      // This verifies subsystem.start() completed BEFORE notifier.start()!
      const client = createLocalControlClient({ socketPath, senderId: desktopSenderId });
      try {
        const grant = await client.exchangeTurnBinding({
          bindingId: desktopBindingId,
          threadId: desktopThreadId,
          secret,
        });
        const replies = await client.listReplies({ limit: 10 }, { credential: grant.credential });
        receivedReplyText = replies[0]?.text;

        ackResult = await client.ackWake({ wakeId: snapshot.wakeId, generation: binding.generation }, { credential: grant.credential });
        notifyConnectedSuccessfully = true;
      } finally {
        await client.close();
      }
      return {
        state: "accepted",
        receipt: { queuedId: randomUUID(), threadId: binding.threadId },
      };
    },
  };

  const configPath = path.join(configDir, "local-messaging.json");
  writePrivateJson(configPath, {
    version: 1, enabled: true, stateRoot,
    bindingPath: path.join(configDir, "desktop-binding.json"),
    integrationPath: path.join(stateRoot, "desktop-integration.json"),
    recipients: [{ profile: "worker", instanceId: workerInstanceId }],
    wake: { enabled: true, codexPath: "/bin/mock", codexHome: "/tmp/mock", minIntervalMs: 15000, timerIntervalMs: 15000 },
  });

  const host = createInstalledLocalMessagingHost({
    configPath,
    runners: new Map([[workerInstanceId, { async run() { return { status: "completed" }; } }]]),
    gate: createProfiledReasonerGate(),
    wakeAdapter: fakeConnectingAdapter,
    minIntervalMs: 10,
    timerIntervalMs: 50,
  });

  await host.start();

  // Wait for notify to complete
  for (let i = 0; i < 50; i++) {
    if (notifyConnectedSuccessfully) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.equal(notifyConnectedSuccessfully, true, "Fake adapter connected to authenticated socket immediately during first notify");
  assert.equal(receivedReplyText, "reply pre");
  assert.equal(ackResult?.acknowledged, true);

  await host.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test("P5 rebind scope: parent repro, oldackoldgen, oldacknewgen, same-thread restart valid, rebind increments & blocks old ack", async () => {
  const stateRoot = createIsolatedDir("triangle-p5-test-");
  const journal = createLocalMessagingJournal({ stateRoot });
  try {
    const owner = "desktop-p5";
    const threadOld = "01a16250-9c72-7823-92f4-65eaeb67db75";
    const threadNew = "01a16250-9c72-7823-92f4-65eaeb67db76";
    const oldWakeId = randomUUID();

    // 1. Initial binding: owner, binding='same', thread='old', generation=1
    const b1 = await journal.initWakeBinding({
      targetIdentity: owner,
      bindingId: "same",
      threadId: threadOld,
      generation: 1,
    });
    assert.equal(b1.generation, 1);
    assert.equal(b1.threadId, threadOld);
    const initialWakeBindingUuid = b1.bindingId;

    // 2. Set wake submitting with old-wake
    await journal.setWakeSubmitting({
      targetIdentity: owner,
      wakeId: oldWakeId,
      fingerprint: "fp1",
    });
    const bSubmitting = await journal.getWakeBinding(owner);
    assert.equal(bSubmitting.deliveryState, "submitting");
    assert.equal(bSubmitting.activeWakeId, oldWakeId);

    // 3. Same-thread restart: outstanding remains valid and suppresses resend
    const bRestart = await journal.initWakeBinding({
      targetIdentity: owner,
      bindingId: "same",
      threadId: threadOld,
      generation: 1,
    });
    assert.equal(bRestart.generation, 1, "Same-thread restart reuses generation");
    assert.equal(bRestart.bindingId, initialWakeBindingUuid, "Same-thread restart reuses wake UUID");
    assert.equal(bRestart.deliveryState, "submitting", "Outstanding state preserved");
    assert.equal(bRestart.activeWakeId, oldWakeId, "Outstanding wakeId preserved");

    // 4. Actual rebind: thread changes to threadNew
    const bRebind = await journal.initWakeBinding({
      targetIdentity: owner,
      bindingId: "same",
      threadId: threadNew,
      generation: 1,
    });
    // Generation advanced!
    assert.equal(bRebind.generation, 2, "Actual rebind increments generation");
    assert.notEqual(bRebind.bindingId, initialWakeBindingUuid, "Actual rebind generates new wake UUID");
    assert.equal(bRebind.deliveryState, "stale_held", "Rebind with active wake transitions to stale_held");

    // 5. Parent repro check: oldackoldgen -> ackWake(old-wake, gen1) must be BLOCKED!
    await assert.rejects(
      journal.ackWake({ requester: owner, wakeId: oldWakeId, generation: 1 }),
      (err) => err.code === "stale_wake_rebound" || err.code === "stale_wake_generation",
      "oldackoldgen is blocked",
    );

    // 6. oldacknewgen -> ackWake(old-wake, gen2) must be BLOCKED!
    await assert.rejects(
      journal.ackWake({ requester: owner, wakeId: oldWakeId, generation: 2 }),
      (err) => err.code === "stale_wake_rebound" || err.code === "stale_wake_id",
      "oldacknewgen cannot clear rebind held state",
    );

    const bAfterFailedAcks = await journal.getWakeBinding(owner);
    assert.equal(bAfterFailedAcks.deliveryState, "stale_held", "stale_held state not cleared");
  } finally {
    await journal.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("Socket E2E: CLI and MCP ack paths, foreign/stale ack denied, per-held-record late flag fingerprint changes at same clock", async () => {
  const root = createIsolatedDir("triangle-cli-mcp-test-");
  const stateRoot = path.join(root, "state");
  const configDir = path.join(root, "config");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const desktopSenderId = createHash("sha256").update("desktop-cli-mcp").digest("hex");
  const desktopThreadId = randomUUID();
  const desktopBindingId = createHash("sha256").update(`${desktopSenderId}\0${desktopThreadId}`).digest("hex").slice(0, 32);
  const secret = createHash("sha256").update("sec-cli-mcp").digest("hex");
  const workerInstanceId = createHash("sha256").update("worker-cli-mcp").digest("hex");

  writePrivateJson(path.join(configDir, "desktop-binding.json"), { version: 1, instanceId: desktopSenderId });
  writePrivateJson(path.join(stateRoot, "desktop-integration.json"), {
    version: 1, bindingId: desktopBindingId, senderId: desktopSenderId, threadId: desktopThreadId, secret,
  });

  const wakeCalls = [];
  const fakeAdapter = {
    async notify(b, s, o) {
      wakeCalls.push({ b, s, o });
      return { state: "accepted", receipt: { queuedId: randomUUID(), threadId: b.threadId } };
    },
  };

  const configPath = path.join(configDir, "local-messaging.json");
  writePrivateJson(configPath, {
    version: 1, enabled: true, stateRoot,
    bindingPath: path.join(configDir, "desktop-binding.json"),
    integrationPath: path.join(stateRoot, "desktop-integration.json"),
    recipients: [{ profile: "worker", instanceId: workerInstanceId }],
    wake: { enabled: true, codexPath: "/bin/mock", codexHome: "/tmp/mock", minIntervalMs: 15000, timerIntervalMs: 15000 },
  });

  const host = createInstalledLocalMessagingHost({
    configPath,
    runners: new Map([[workerInstanceId, { async run() { return { status: "completed", text: "reply" }; } }]]),
    gate: createProfiledReasonerGate(),
    wakeAdapter: fakeAdapter,
    minIntervalMs: 10,
    timerIntervalMs: 50,
  });
  await host.start();

  const { socketPath } = resolveLocalSocketAddress({ stateRoot });
  const client = createLocalControlClient({ socketPath, senderId: desktopSenderId });

  try {
    const grant = await client.exchangeTurnBinding({
      bindingId: desktopBindingId,
      threadId: desktopThreadId,
      secret,
    });

    // 1. Send message to trigger wake
    await client.sendMessage({ to: workerInstanceId, text: "cli test", messageId: "m-cli", requestId: "r-cli" }, { credential: grant.credential });
    await client.waitForReply({ requestId: "r-cli", timeoutMs: 3000 });

    for (let i = 0; i < 50; i++) {
      if (wakeCalls.length >= 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(wakeCalls.length, 1);
    const wakeId1 = wakeCalls[0].s.wakeId;

    // Test CLI ack-wake path
    const { runLocalMessagingCLI } = await import("../src/local-messaging-cli.mjs");
    let cliOutput = "";
    const mockStdout = { write(chunk) { cliOutput += chunk; } };
    const mockStderr = { write() {} };

    // Foreign / stale ack via CLI denied
    await assert.rejects(
      runLocalMessagingCLI(["ack-wake", "--config", configPath, "--wake-id", "00000000-0000-0000-0000-000000000000", "--generation", "1"], {
        output: mockStdout, stderr: mockStderr,
      }),
      (err) => err.code === "stale_wake_id",
    );

    // Stale generation via CLI denied
    await assert.rejects(
      runLocalMessagingCLI(["ack-wake", "--config", configPath, "--wake-id", wakeId1, "--generation", "99"], {
        output: mockStdout, stderr: mockStderr,
      }),
      (err) => err.code === "stale_wake_generation",
    );

    // Authorized CLI ack succeeds
    const cliCode = await runLocalMessagingCLI(["ack-wake", "--config", configPath, "--wake-id", wakeId1, "--generation", "1"], {
      output: mockStdout, stderr: mockStderr,
    });
    assert.equal(cliCode, 0);
    assert.ok(cliOutput.includes('"acknowledged":true') || cliOutput.includes('"acknowledged": true'));

    const st1 = await client.localStatus({ credential: grant.credential });
    assert.equal(st1.wake.deliveryState, "idle");

    // 2. Trigger second wake for MCP ack path
    await client.sendMessage({ to: workerInstanceId, text: "mcp test", messageId: "m-mcp", requestId: "r-mcp" }, { credential: grant.credential });
    await client.waitForReply({ requestId: "r-mcp", timeoutMs: 3000 });

    for (let i = 0; i < 50; i++) {
      if (wakeCalls.length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(wakeCalls.length, 2);
    const wakeId2 = wakeCalls[1].s.wakeId;

    // Test MCP ack path via createLocalMessagingMcpHandler
    const { createLocalMessagingMcpHandler } = await import("../src/local-messaging-mcp-adapter.mjs");
    const mcpHandler = createLocalMessagingMcpHandler({
      client,
      turnCredentialProvider: () => grant.credential,
    });

    // Foreign / stale ack via MCP denied
    const mcpStaleRes = await mcpHandler.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "triangle_ack_notification",
        arguments: {
          wakeId: "00000000-0000-0000-0000-000000000000",
          generation: 1,
        },
      },
    });
    assert.equal(mcpStaleRes.result.isError, true);
    assert.ok(mcpStaleRes.result.content[0].text.includes("stale_wake_id"));

    // Authorized MCP ack succeeds
    const mcpAckRes = await mcpHandler.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "triangle_ack_notification",
        arguments: {
          wakeId: wakeId2,
          generation: 1,
        },
      },
    });
    assert.equal(mcpAckRes.result.isError, false);
    assert.ok(mcpAckRes.result.content[0].text.includes('"acknowledged":true') || mcpAckRes.result.content[0].text.includes('"acknowledged": true'));

    const st2 = await client.localStatus({ credential: grant.credential });
    assert.equal(st2.wake.deliveryState, "idle");

    // Close client and stop host before opening standalone journal for fingerprint test
    await client.close();
    await host.stop();

    // 3. Per-held-record late flag changes fingerprint even at same clock
    const { DatabaseSync } = await import("node:sqlite");
    const rawDb = new DatabaseSync(path.join(stateRoot, "local-messaging.sqlite"));
    const fixedTime = Date.now();
    rawDb.prepare(`
      INSERT INTO local_messages (message_id, sender, recipient, request_id, text, canonical_hash, phase, reason, late_result_text, created_at, updated_at)
      VALUES ('h1', ?, ?, 'rh1', 't1', 'c1', 'held', 'timeout', 'late1', ?, ?),
             ('h2', ?, ?, 'rh2', 't2', 'c2', 'held', 'timeout', NULL, ?, ?)
    `).run(desktopSenderId, workerInstanceId, fixedTime, fixedTime, desktopSenderId, workerInstanceId, fixedTime, fixedTime);

    // Get obligations
    const journal = createLocalMessagingJournal({ stateRoot });
    const ob1 = await journal.getWakeObligations(desktopSenderId);

    // Now h2 gains late_result_text at the SAME timestamps
    rawDb.prepare("UPDATE local_messages SET late_result_text = 'late2' WHERE message_id = 'h2'").run();
    rawDb.close();

    const ob2 = await journal.getWakeObligations(desktopSenderId);
    await journal.close();

    assert.notEqual(ob1.snapshotFingerprint, ob2.snapshotFingerprint, "Per-held-record late flag change alters fingerprint at identical clock timestamps");
  } finally {
    try { await client.close(); } catch {}
    try { await host.stop(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Socket E2E: real server exact duplicate retry at full pair cap, restart/compaction window, and parallel admissions", async () => {
  const root = createIsolatedDir("triangle-server-cap-test-");
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });

  const alice = "a".repeat(64);
  const bob = "b".repeat(64);
  const registry = [alice, bob];
  const aclRules = { [alice]: [bob], [bob]: [alice] };

  let journal = createLocalMessagingJournal({ stateRoot, maxPairRequests: 3, pairWindowMs: 60000 });
  const { createLocalControlServer } = await import("../src/local-messaging-server.mjs");
  const { createTurnCapabilityIssuer, createTurnCapabilityValidator } = await import("../src/local-messaging-credentials.mjs");
  const { createOwnerAcl } = await import("../src/local-messaging-acl.mjs");

  const { socketPath } = resolveLocalSocketAddress({ stateRoot });
  const secret = "test-secret-key-32-bytes-long-1234567890";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });
  const acl = createOwnerAcl({ rules: aclRules });

  const fakeDispatcher = {
    async start() {},
    async stop() {},
    async notifyAdmission() {},
  };

  let server = createLocalControlServer({
    socketPath,
    journal,
    dispatcher: fakeDispatcher,
    credentialValidator: validator,
    acl,
  });
  await server.start();

  const aliceCred = issuer.issue({ senderId: alice, allowedRecipients: [bob] });
  const bobCred = issuer.issue({ senderId: bob, allowedRecipients: [alice] });

  const aliceClient = createLocalControlClient({ socketPath, senderId: alice });
  const bobClient = createLocalControlClient({ socketPath, senderId: bob });

  try {
    // 1. Send 3 messages between Alice and Bob to reach cap of 3
    const m1 = await aliceClient.sendMessage({ to: bob, text: "m1", messageId: "msg-1", requestId: "r1" }, { credential: aliceCred });
    assert.equal(m1.isDuplicate, false);

    const m2 = await bobClient.sendMessage({ to: alice, text: "m2", messageId: "msg-2", requestId: "r2" }, { credential: bobCred });
    assert.equal(m2.isDuplicate, false);

    const m3 = await aliceClient.sendMessage({ to: bob, text: "m3", messageId: "msg-3", requestId: "r3" }, { credential: aliceCred });
    assert.equal(m3.isDuplicate, false);

    // 2. Cap of 3 is reached. Exact retry of msg-1 succeeds at full cap!
    const m1Retry = await aliceClient.sendMessage({ to: bob, text: "m1", messageId: "msg-1", requestId: "r1" }, { credential: aliceCred });
    assert.equal(m1Retry.isDuplicate, true);
    assert.equal(m1Retry.messageId, "msg-1");

    // Conflicting retry (same messageId, differing payload/requestId) is rejected with duplicate_id_conflict
    await assert.rejects(
      aliceClient.sendMessage({ to: bob, text: "conflict payload", messageId: "msg-1", requestId: "r1-conflict" }, { credential: aliceCred }),
      (err) => err.code === "duplicate_id_conflict",
    );

    // 3. New request at cap is rejected with exchange_limit_exceeded
    await assert.rejects(
      aliceClient.sendMessage({ to: bob, text: "m4 new", messageId: "msg-4", requestId: "r4" }, { credential: aliceCred }),
      (err) => err.code === "exchange_limit_exceeded",
    );

    // 4. Server restart & compaction: window evidence preserved
    await aliceClient.close();
    await bobClient.close();
    await server.close();
    await journal.close();

    // Reopen
    journal = createLocalMessagingJournal({ stateRoot, maxPairRequests: 3, pairWindowMs: 60000 });
    // Compact with retentionMs: 0
    await journal.compact({ retentionMs: 0 });

    server = createLocalControlServer({
      socketPath,
      journal,
      dispatcher: fakeDispatcher,
      credentialValidator: validator,
      acl,
    });
    await server.start();

    const aliceClient2 = createLocalControlClient({ socketPath, senderId: alice });
    const bobClient2 = createLocalControlClient({ socketPath, senderId: bob });

    try {
      // After restart and compact, new request still rejected!
      await assert.rejects(
        aliceClient2.sendMessage({ to: bob, text: "m5 new", messageId: "msg-5", requestId: "r5" }, { credential: aliceCred }),
        (err) => err.code === "exchange_limit_exceeded",
      );

      // Exact retry still succeeds
      const m2Retry = await bobClient2.sendMessage({ to: alice, text: "m2", messageId: "msg-2", requestId: "r2" }, { credential: bobCred });
      assert.equal(m2Retry.isDuplicate, true);
    } finally {
      await aliceClient2.close();
      await bobClient2.close();
    }

    await server.close();
    await journal.close();
  } finally {
    try { await aliceClient.close(); } catch {}
    try { await bobClient.close(); } catch {}
    try { await server?.close(); } catch {}
    try { await journal?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 5. Parallel admissions: concurrent client sends cannot overshoot cap
  const pRoot = createIsolatedDir("triangle-parallel-test-");
  const pState = path.join(pRoot, "state");
  fs.mkdirSync(pState, { recursive: true, mode: 0o700 });
  const pJournal = createLocalMessagingJournal({ stateRoot: pState, maxPairRequests: 4, pairWindowMs: 60000 });
  const pAddr = resolveLocalSocketAddress({ stateRoot: pState });
  const pAcl = createOwnerAcl({ rules: aclRules });
  const pServer = createLocalControlServer({
    socketPath: pAddr.socketPath,
    journal: pJournal,
    dispatcher: fakeDispatcher,
    credentialValidator: validator,
    acl: pAcl,
  });
  await pServer.start();

  const c1 = createLocalControlClient({ socketPath: pAddr.socketPath, senderId: alice });
  const c2 = createLocalControlClient({ socketPath: pAddr.socketPath, senderId: bob });
  try {
    const sends = [];
    for (let i = 0; i < 10; i++) {
      const client = i % 2 === 0 ? c1 : c2;
      const cred = i % 2 === 0 ? aliceCred : bobCred;
      const to = i % 2 === 0 ? bob : alice;
      sends.push(
        client.sendMessage({ to, text: `p ${i}`, messageId: `p-${i}`, requestId: `req-p-${i}` }, { credential: cred }),
      );
    }
    const outcomes = await Promise.allSettled(sends);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    assert.equal(fulfilled.length, 4, "Exactly maxPairRequests admissions succeed in parallel");
    assert.equal(rejected.length, 6, "Excess admissions rejected");
    for (const rej of rejected) {
      assert.equal(rej.reason?.code, "exchange_limit_exceeded");
    }
  } finally {
    await c1.close();
    await c2.close();
    await pServer.close();
    await pJournal.close();
    fs.rmSync(pRoot, { recursive: true, force: true });
  }
});

test("Backward compatibility: production wake off with omitted or disabled wake config starts cleanly", async () => {
  const root = createIsolatedDir("triangle-wakeoff-test-");
  const stateRoot = path.join(root, "state");
  const configDir = path.join(root, "config");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const sId = createHash("sha256").update("s-off").digest("hex");
  const wId = createHash("sha256").update("w-off").digest("hex");
  const tId = randomUUID();
  const bId = createHash("sha256").update(`${sId}\0${tId}`).digest("hex").slice(0, 32);
  const sec = createHash("sha256").update("sec-off").digest("hex");

  writePrivateJson(path.join(configDir, "desktop-binding.json"), { version: 1, instanceId: sId });
  writePrivateJson(path.join(stateRoot, "desktop-integration.json"), { version: 1, bindingId: bId, senderId: sId, threadId: tId, secret: sec });

  // Config without wake field
  const configPath1 = path.join(configDir, "local-1.json");
  writePrivateJson(configPath1, {
    version: 1, enabled: true, stateRoot,
    bindingPath: path.join(configDir, "desktop-binding.json"),
    integrationPath: path.join(stateRoot, "desktop-integration.json"),
    recipients: [{ profile: "w", instanceId: wId }],
  });

  const runners = new Map([[wId, { async run() { return { status: "completed" }; } }]]);
  const gate = createProfiledReasonerGate();

  let host1 = createInstalledLocalMessagingHost({ configPath: configPath1, runners, gate });
  await host1.start();
  const st1 = host1.status();
  assert.equal(st1.route, "same-device");
  await host1.stop();

  // Config with wake: { enabled: false }
  const configPath2 = path.join(configDir, "local-2.json");
  writePrivateJson(configPath2, {
    version: 1, enabled: true, stateRoot,
    bindingPath: path.join(configDir, "desktop-binding.json"),
    integrationPath: path.join(stateRoot, "desktop-integration.json"),
    recipients: [{ profile: "w", instanceId: wId }],
    wake: { enabled: false },
  });

  let host2 = createInstalledLocalMessagingHost({ configPath: configPath2, runners, gate });
  await host2.start();
  const st2 = host2.status();
  assert.equal(st2.route, "same-device");
  await host2.stop();

  fs.rmSync(root, { recursive: true, force: true });
});


test("acknowledged backlog reductions and empty inbox mode changes stay quiet across restart", async () => {
 const stateRoot=createIsolatedDir();let journal=createLocalMessagingJournal({stateRoot});
 const targetIdentity='shrink-owner',threadId='shrink-thread',bindingId=randomUUID();
 let now=100000,calls=0,notifier;
 const options={targetIdentity,threadId,bindingId,wakeConfig:{enabled:true},minIntervalMs:15000,timerIntervalMs:1000000,clock:{now:()=>now},adapter:{notify:async b=>{calls++;return {state:'accepted',receipt:{queuedId:randomUUID(),threadId:b.threadId}};}}};
 try {
  for(const id of ['one','two']){
   await journal.recordSend({sender:targetIdentity,recipient:'worker',messageId:id,requestId:id,text:id});
   await journal.recordReply({sender:'worker',recipient:targetIdentity,messageId:'reply-'+id,requestId:id,inReplyTo:id,text:'ok'});
  }
  await journal.recordSend({sender:'claude',recipient:targetIdentity,recipientType:'interactive',messageId:'incoming',requestId:'incoming',text:'ping'});
  notifier=createLocalMessagingNotifier({...options,journal,inboxEnabled:true});await notifier.start();
  const binding=await journal.getWakeBinding(targetIdentity);
  await journal.recordSend({sender:targetIdentity,recipient:'worker',messageId:'three',requestId:'three',text:'three'});
  await journal.recordReply({sender:'worker',recipient:targetIdentity,messageId:'reply-three',requestId:'three',inReplyTo:'three',text:'ok'});
  await notifier.ackNotification({requester:targetIdentity,wakeId:binding.activeWakeId,generation:1});
  now+=16000;await notifier.evaluateObligations();assert.equal(calls,2,'new reply during outstanding wake is not hidden');
  const next=await journal.getWakeBinding(targetIdentity);
  await notifier.ackNotification({requester:targetIdentity,wakeId:next.activeWakeId,generation:1});
  await journal.claimInboxMessage({requester:targetIdentity,messageId:'incoming',sessionId:'owner-session',generation:1,claimId:'claim-incoming'});
  await journal.consumeReply({requester:targetIdentity,messageId:'reply-one'});
  now+=16000;await notifier.evaluateObligations();assert.equal(calls,2,'consuming one reply does not renotify remaining replies');
  await notifier.stop();await journal.close();journal=createLocalMessagingJournal({stateRoot});
  notifier=createLocalMessagingNotifier({...options,journal,inboxEnabled:false});await notifier.start();
  assert.equal(calls,2,'restart and empty inbox mode change preserve coverage');
 } finally {await notifier?.stop();await journal.close();fs.rmSync(stateRoot,{recursive:true,force:true});}
});
