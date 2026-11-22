import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { replyBeforeAckStages } from "../../src/codex-runtime/execution-state.mjs";
import {
  createFakeAcpStdioProgram,
  createCursorAcpProcess,
} from "../../src/cursor-acp-runtime/acp-process.mjs";
import { createDefaultCursorAcpShadowProfile } from "../../src/cursor-acp-runtime/config-guards.mjs";
import { createFileCursorSessionRegistry } from "../../src/cursor-acp-runtime/session-registry.mjs";
import { createHeadlessCursorAcpRuntime } from "../../src/cursor-acp-runtime/headless-runtime.mjs";

const PROFILE_INSTANCE_ID = "a".repeat(64);
const ROOM_ID = `room_${"b".repeat(32)}`;
const INBOUND_EVENT_ID = `event_${"c".repeat(32)}`;

// macOS tmpdir() (/var/folders/...) is too long for Cursor's 84-char socket
// base (see runtime-home.mjs); keep test homes under a short /tmp root.
function shortTmpRoot() {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

function tempHome() {
  return mkdtempSync(path.join(shortTmpRoot(), "tca-"));
}

function createProxyRecorder() {
  const calls = [];
  return {
    calls,
    async reply(args) {
      calls.push({ op: "reply", ...args });
      return { replyEventId: INBOUND_EVENT_ID, state: "replied" };
    },
    async ack(args = {}) {
      calls.push({ op: "ack", ...args });
      return { acknowledged: true };
    },
  };
}

test("fake ACP: initialize, session/new, set mode/model, prompt", async () => {
  const home = tempHome();
  try {
    const fake = createFakeAcpStdioProgram({ idPrefix: "unit" });
    const processHandle = createCursorAcpProcess({
      command: fake.command,
      args: fake.args,
      cursorHome: path.join(home, "cursor-home"),
      env: { HOME: home, PATH: process.env.PATH },
    });
    await processHandle.start();
    const init = await processHandle.initialize();
    assert.equal(init.agentCapabilities.loadSession, true);
    await processHandle.authenticate();
    const created = await processHandle.sessionNew({ cwd: path.join(home, "cursor-home") });
    assert.match(created.sessionId, /^sess-/);
    const mode = await processHandle.setMode({ sessionId: created.sessionId, mode: "ask" });
    assert.equal(mode.currentValue, "ask");
    const model = await processHandle.setModel({
      sessionId: created.sessionId,
      model: "composer-2.5[fast=true]",
    });
    assert.equal(model.currentValue, "composer-2.5[fast=true]");
    const turn = await processHandle.sessionPrompt({
      sessionId: created.sessionId,
      text: "hello-cursor",
    });
    assert.equal(turn.stopReason, "end_turn");
    assert.match(turn.assistantText, /fake-cursor-assistant-ok/);
    assert.match(turn.assistantText, /hello-cursor/);
    await processHandle.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fake ACP: session/load restores history across process restart", async () => {
  const home = tempHome();
  const store = path.join(home, "sessions.json");
  try {
    const fake = createFakeAcpStdioProgram({
      idPrefix: "load",
      durableStorePath: store,
      assistantText: "TOKEN_A_restore",
    });
    const env = { HOME: home, PATH: process.env.PATH };
    const cursorHome = path.join(home, "cursor-home");

    const first = createCursorAcpProcess({
      command: fake.command,
      args: fake.args,
      cursorHome,
      env,
    });
    await first.ensureReady();
    const created = await first.sessionNew({ cwd: cursorHome });
    await first.sessionPrompt({ sessionId: created.sessionId, text: "remember me" });
    await first.close();

    const second = createCursorAcpProcess({
      command: fake.command,
      args: fake.args,
      cursorHome,
      env,
    });
    await second.ensureReady();
    const loaded = await second.sessionLoad({
      sessionId: created.sessionId,
      cwd: cursorHome,
    });
    assert.equal(loaded.sessionId, created.sessionId);
    const followUp = await second.sessionPrompt({
      sessionId: created.sessionId,
      text: "what was prior?",
    });
    assert.match(followUp.assistantText, /TOKEN_A_restore/);
    await second.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fake ACP: unattended permission + create_plan + ask_question do not hang", async () => {
  const home = tempHome();
  try {
    const fake = createFakeAcpStdioProgram({
      idPrefix: "block",
      emitPermission: true,
      emitCreatePlan: true,
      emitAskQuestion: true,
    });
    const processHandle = createCursorAcpProcess({
      command: fake.command,
      args: fake.args,
      cursorHome: path.join(home, "cursor-home"),
      env: { HOME: home, PATH: process.env.PATH },
    });
    await processHandle.ensureReady();
    const created = await processHandle.sessionNew({
      cwd: path.join(home, "cursor-home"),
    });
    const turn = await processHandle.sessionPrompt({
      sessionId: created.sessionId,
      text: "force tools",
      timeoutMs: 10_000,
    });
    assert.equal(turn.stopReason, "end_turn");
    assert.match(turn.assistantText, /fake-cursor-assistant-ok/);
    await processHandle.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("shadow runtime: start, prompt, reply-before-ack; excludes Codex/Bob", async () => {
  const home = tempHome();
  const store = path.join(home, "sessions.json");
  try {
    const inactiveCodex = createHeadlessCursorAcpRuntime({
      profileConfig: {
        runtimeAdapter: "codex-app-server",
        runtimeMode: "headless",
        deliveryMode: "headless-app-server",
      },
      enableShadow: true,
    });
    assert.equal(inactiveCodex.active, false);
    assert.equal(inactiveCodex.reason, "codex_pool_excluded");

    const inactiveGrok = createHeadlessCursorAcpRuntime({
      profileConfig: { runtimeAdapter: "grok-bot", deliveryMode: "grok-bot" },
      enableShadow: true,
    });
    assert.equal(inactiveGrok.active, false);
    assert.equal(inactiveGrok.reason, "grok_bot_excluded");

    const fake = createFakeAcpStdioProgram({
      idPrefix: "shadow",
      durableStorePath: store,
    });
    const proxy = createProxyRecorder();
    const runtime = createHeadlessCursorAcpRuntime({
      profileConfig: createDefaultCursorAcpShadowProfile({
        workingDirectory: path.join(home, "cwd"),
        workload: "conversational",
        model: "composer-2.5[fast=true]",
      }),
      enableShadow: true,
      transactionProxy: proxy,
      command: fake.command,
      args: fake.args,
      cursorHome: path.join(home, "cursor-home"),
      env: { HOME: home, PATH: process.env.PATH },
      logger: { info() {}, error() {} },
    });

    assert.equal(runtime.active, true);
    const started = await runtime.start();
    assert.equal(started.pool.size, 1);

    const result = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_1",
      numericDeliveryId: 1,
      text: "phase-cursor hello",
      inboundEventId: INBOUND_EVENT_ID,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.startedNewSession, true);
    assert.equal(result.mode, "ask");
    assert.match(result.sessionId, /^sess-/);
    assert.deepEqual(result.settlementTrace, ["result_ready", "reply_persisted", "acked"]);
    assert.deepEqual(result.expectedSettlementOrder, replyBeforeAckStages());
    assert.deepEqual(
      proxy.calls.map((call) => call.op),
      ["reply", "ack"],
    );
    assert.equal(proxy.calls[0].roomId, ROOM_ID);
    assert.match(proxy.calls[0].text, /fake-cursor-assistant-ok/);
    assert.ok(!JSON.stringify(proxy.calls).includes("mesh_"));

    const record = runtime.registry.get(PROFILE_INSTANCE_ID, ROOM_ID);
    assert.equal(record.cursorSessionId, result.sessionId);
    assert.equal(record.executionState, "idle");

    // Continuity: restart slot and load prior sessionId.
    await runtime.restartSlot(result.slotId);
    const second = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_2",
      numericDeliveryId: 2,
      text: "second turn",
      inboundEventId: INBOUND_EVENT_ID,
    });
    assert.equal(second.startedNewSession, false);
    assert.equal(second.sessionId, result.sessionId);

    await runtime.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a fresh runtime loads the room session and durably replaces a missing ACP session", async () => {
  const home = tempHome();
  const store = path.join(home, "sessions.json");
  const fake = createFakeAcpStdioProgram({ durableStorePath: store });
  async function turn(n) {
    const runtime = createHeadlessCursorAcpRuntime({
      registry: createFileCursorSessionRegistry({ stateRoot: home, profileInstanceId: PROFILE_INSTANCE_ID }),
      profileConfig: createDefaultCursorAcpShadowProfile({ workingDirectory: home }),
      enableShadow: true,
      transactionProxy: createProxyRecorder(),
      command: fake.command, args: fake.args,
      cursorHome: path.join(home, "cursor-home"),
      env: { HOME: home, PATH: process.env.PATH },
    });
    try {
      await runtime.start();
      return await runtime.runDelivery({
        profileInstanceId: PROFILE_INSTANCE_ID, roomId: ROOM_ID, deliveryId: "delivery_" + n,
        numericDeliveryId: n, text: "private turn body", inboundEventId: INBOUND_EVENT_ID,
      });
    } finally {
      await runtime.stop();
    }
  }
  try {
    const first = await turn(1);
    const next = await turn(2);
    assert.equal(next.startedNewSession, false);
    assert.equal(next.sessionId, first.sessionId);
    rmSync(store);
    const replacement = await turn(3);
    assert.equal(replacement.startedNewSession, true);
    assert.notEqual(replacement.sessionId, first.sessionId);
    assert.equal((await turn(4)).sessionId, replacement.sessionId);
    const file = path.join(home, "conversations", ROOM_ID + ".json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      version: 1, meshRoomId: ROOM_ID, profileInstanceId: PROFILE_INSTANCE_ID, cursorSessionId: replacement.sessionId,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("crash-boundary: reply-committed before ack leaves registry recoverable; recover acks", async () => {
  const home = tempHome();
  try {
    const fake = createFakeAcpStdioProgram({ idPrefix: "crash-reply" });
    const calls = [];
    let failAckOnce = true;
    const proxy = {
      calls,
      async reply(args) {
        calls.push({ op: "reply", ...args });
        return { replyEventId: INBOUND_EVENT_ID, state: "replied" };
      },
      async ack(args = {}) {
        calls.push({ op: "ack", ...args });
        if (failAckOnce) {
          failAckOnce = false;
          const error = new Error("crash after reply before ack");
          error.code = "ack_failed";
          throw error;
        }
        return { acknowledged: true };
      },
      async status() {
        calls.push({ op: "status" });
        return {
          open: {
            deliveryId: 1,
            roomId: ROOM_ID,
            state: "replied",
          },
        };
      },
    };
    const runtime = createHeadlessCursorAcpRuntime({
      profileConfig: createDefaultCursorAcpShadowProfile({
        workingDirectory: path.join(home, "cwd"),
      }),
      enableShadow: true,
      transactionProxy: proxy,
      command: fake.command,
      args: fake.args,
      cursorHome: path.join(home, "cursor-home"),
      env: { HOME: home, PATH: process.env.PATH },
      logger: { info() {}, error() {} },
    });
    await runtime.start();
    await assert.rejects(
      () => runtime.runDelivery({
        profileInstanceId: PROFILE_INSTANCE_ID,
        roomId: ROOM_ID,
        deliveryId: "delivery_1",
        numericDeliveryId: 1,
        text: "reply then crash",
        inboundEventId: INBOUND_EVENT_ID,
      }),
      (error) => error.code === "ack_failed",
    );
    assert.deepEqual(
      proxy.calls.map((call) => call.op),
      ["reply", "ack"],
    );
    const recovered = await runtime.recoverAfterRestart({
      profileInstanceId: PROFILE_INSTANCE_ID,
    });
    assert.equal(recovered.reconciledAck, 1);
    assert.ok(proxy.calls.some((call) => call.op === "status"));
    assert.equal(proxy.calls.filter((call) => call.op === "ack").length, 2);
    await runtime.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("crash-boundary: ack-committed before local clear recovers to idle", async () => {
  const home = tempHome();
  try {
    const fake = createFakeAcpStdioProgram({ idPrefix: "crash-ack" });
    const proxy = {
      async reply() {
        return { replyEventId: INBOUND_EVENT_ID, state: "replied" };
      },
      async ack() {
        return { acknowledged: true };
      },
      async status() {
        // Helper already cleared open after ack; local clear never ran.
        return { open: null };
      },
    };
    const runtime = createHeadlessCursorAcpRuntime({
      profileConfig: createDefaultCursorAcpShadowProfile({
        workingDirectory: path.join(home, "cwd"),
      }),
      enableShadow: true,
      transactionProxy: proxy,
      command: fake.command,
      args: fake.args,
      cursorHome: path.join(home, "cursor-home"),
      env: { HOME: home, PATH: process.env.PATH },
      logger: { info() {}, error() {} },
    });
    await runtime.start();
    const result = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_1",
      numericDeliveryId: 1,
      text: "complete settlement",
      inboundEventId: INBOUND_EVENT_ID,
    });
    assert.equal(result.status, "completed");
    // Simulate local crash after ack: leave registry at acked (valid path),
    // then recover clears to idle without a second helper ack.
    runtime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, {
      executionState: "admitted",
      activeDeliveryId: "delivery_1",
    });
    runtime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, { executionState: "running" });
    runtime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, { executionState: "result_ready" });
    runtime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, {
      executionState: "reply_persisted",
      lastReplyEventId: INBOUND_EVENT_ID,
    });
    runtime.registry.upsert(PROFILE_INSTANCE_ID, ROOM_ID, { executionState: "acked" });
    assert.equal(
      runtime.registry.get(PROFILE_INSTANCE_ID, ROOM_ID).executionState,
      "acked",
    );    const recovered = await runtime.recoverAfterRestart({
      profileInstanceId: PROFILE_INSTANCE_ID,
    });
    assert.equal(recovered.reconciledAck, 0);
    assert.equal(recovered.quarantined, 0);
    // Helper open is already null (ack committed); local acked → idle without re-ack.
    const record = runtime.registry.get(PROFILE_INSTANCE_ID, ROOM_ID);
    assert.equal(record.executionState, "idle");
    assert.equal(record.activeDeliveryId, null);    await runtime.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prompt timeout cancels and recycles the ACP slot so late chunks cannot bleed into retry", async () => {
  const home = tempHome();
  const store = path.join(home, "sessions.json");
  let runtime = null;
  try {
    const fake = createFakeAcpStdioProgram({
      idPrefix: "timeout-recycle",
      durableStorePath: store,
      promptDelayOnceMs: 250,
      promptDelayOnceMarkerPath: path.join(home, "prompt-delayed-once.flag"),
      postTimeoutLeakText: "LEAK_FROM_TIMED_OUT_TURN",
    });
    const proxy = createProxyRecorder();
    const logs = [];
    runtime = createHeadlessCursorAcpRuntime({
      profileConfig: createDefaultCursorAcpShadowProfile({
        workingDirectory: path.join(home, "cwd"),
      }),
      enableShadow: true,
      transactionProxy: proxy,
      command: fake.command,
      args: fake.args,
      cursorHome: path.join(home, "cursor-home"),
      env: { HOME: home, PATH: process.env.PATH },
      promptTimeoutMs: 60,
      logger: {
        info(entry) {
          logs.push(entry);
        },
        error(entry) {
          logs.push(entry);
        },
      },
    });

    await runtime.start();
    const initialPid = runtime.status().pool.slots[0].pid;

    await assert.rejects(
      () =>
        runtime.runDelivery({
          profileInstanceId: PROFILE_INSTANCE_ID,
          roomId: ROOM_ID,
          deliveryId: "delivery_timeout_1",
          numericDeliveryId: 1,
          text: "first timed out turn",
          inboundEventId: INBOUND_EVENT_ID,
        }),
      (error) => error.code === "request_timeout",
    );

    const recycledPid = runtime.status().pool.slots[0].pid;
    assert.notEqual(recycledPid, initialPid, "timed-out slot child must be replaced before reuse");
    assert.ok(
      logs.some((entry) => entry?.msg === "cursor_acp_turn_timeout_recycling_slot"),
      "expected timeout slot recycle log",
    );
    assert.deepEqual(proxy.calls, [], "timed-out turn must not reply or ack");

    const retryResult = await runtime.runDelivery({
      profileInstanceId: PROFILE_INSTANCE_ID,
      roomId: ROOM_ID,
      deliveryId: "delivery_retry_2",
      numericDeliveryId: 2,
      text: "clean retry turn",
      inboundEventId: INBOUND_EVENT_ID,
    });
    assert.equal(retryResult.status, "completed");
    assert.doesNotMatch(retryResult.assistantText, /LEAK_FROM_TIMED_OUT_TURN/);
    assert.match(retryResult.assistantText, /clean retry turn/);
    assert.deepEqual(
      proxy.calls.map((call) => call.op),
      ["reply", "ack"],
    );
  } finally {
    if (runtime) {
      await runtime.stop().catch(() => {});
    }
    rmSync(home, { recursive: true, force: true });
  }
});
