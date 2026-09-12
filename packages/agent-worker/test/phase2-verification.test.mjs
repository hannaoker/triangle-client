/**
 * Phase 2 verification gates runnable on Linux:
 * - helper ensure + durable cursor restart resume
 * - reconnect-storm at a configured admission limit
 * - crash after claim before ack / after generation before ack (same-claim reclaim)
 * - short fake-harness soak slice (wall 24h via scripts/soak-fake-wake.mjs)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConcurrencyGate } from "../src/concurrency-gate.mjs";
import {
  createFakeWatchTransport,
  ensureHelperWatchGrant,
} from "../src/helper-watch-transport.mjs";
import { createMailboxClient } from "../src/mailbox-client.mjs";
import {
  createFakeHarness,
  createProfileScheduler,
  createWakeRuntime,
} from "../src/profile-scheduler.mjs";
import { createAtomicFileCursorStore } from "../src/wake-client.mjs";

const id = (n) => n.toString(16).padStart(64, "0");

function tempDir(prefix) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function canonicalEvent({ id: eventId, roomId, sequence, senderAgentId, text, idempotencyKey }) {
  return {
    id: eventId,
    roomId,
    sequence,
    senderAgentId,
    type: "message.created",
    body: { text },
    idempotencyKey,
    idempotency_key: idempotencyKey,
  };
}

function createMailboxFetchFixture({
  mailboxResponse,
  roomHistoryByRoom,
  appendEvent = (roomId, body, state) => {
    state.appendCount += 1;
    const existing = state.roomHistoryByRoom.get(roomId) ?? [];
    const maxSequence = existing.reduce((value, event) => Math.max(value, event.sequence), 0);
    const event = {
      id: `event_${String(state.appendCount).padStart(32, "0")}`,
      roomId,
      sequence: maxSequence + 1,
      senderAgentId: "agent_11111111111111111111111111111111",
      type: "message.created",
      idempotencyKey: body.idempotency_key,
      idempotency_key: body.idempotency_key,
      body: body.body,
    };
    existing.push(event);
    state.roomHistoryByRoom.set(roomId, existing);
    return { event };
  },
  acknowledge = () => ({ acknowledged: 1 }),
} = {}) {
  const state = {
    roomHistoryByRoom,
    claims: new Map(),
    acknowledgeCount: 0,
    appendCount: 0,
  };
  const fetchImpl = async (request) => {
    const url = new URL(request.url);
    const method = request.method;
    const body = method === "POST" ? await request.json() : undefined;
    if (url.pathname === "/api/v1/agents/me") {
      return json({ agent: { id: "agent_11111111111111111111111111111111" } });
    }
    if (url.pathname === "/api/v1/mailbox") return json(mailboxResponse);
    if (url.pathname.startsWith("/api/v1/rooms/") && url.pathname.endsWith("/events")) {
      const roomId = url.pathname.split("/")[4];
      if (method === "GET") {
        const after = Number(url.searchParams.get("after_sequence") ?? "0");
        const items = (state.roomHistoryByRoom.get(roomId) ?? [])
          .filter((event) => event.sequence > after);
        return json({ roomId, items });
      }
      return json(appendEvent(roomId, body, state));
    }
    if (url.pathname === "/api/v1/mailbox/claim") {
      const existing = state.claims.get(body.delivery_id);
      if (existing && existing !== body.claim_id) {
        return json({ error: "delivery_claim_conflict" }, 409);
      }
      state.claims.set(body.delivery_id, body.claim_id);
      return json({
        claimed: true,
        claimId: body.claim_id,
        claimedAt: "2026-08-07T00:00:00.000Z",
        idempotent: Boolean(existing),
      });
    }
    if (url.pathname === "/api/v1/mailbox/ack") {
      const response = await acknowledge(body, state);
      state.acknowledgeCount += 1;
      return json(response);
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  };
  return { fetchImpl, state };
}

test("helper ensure plus durable cursor resumes after stop/restart", async () => {
  const fixture = tempDir("triangle-wake-restart-");
  try {
    const cursorPath = path.join(fixture.root, "wake-cursor.json");
    const ensureCalls = [];
    await ensureHelperWatchGrant({
      helperPath: "/trusted/triangle-mailbox",
      installationId: "inst_N7VhDq3mQ2",
      actorProfile: "event-hermes",
      async run(file, args) {
        ensureCalls.push({ file, args });
        return { code: 0, stdout: "{\"state\":\"finalized\"}\n", stderr: "" };
      },
    });
    assert.equal(ensureCalls.length, 1);

    const transport = createFakeWatchTransport({
      polls: [
        { cursor: 6, events: [{ agent_id: "agent_a", high_watermark: 6 }] },
        { cursor: 6, events: [] },
      ],
    });
    const first = createWakeRuntime({
      profiles: [{ instanceId: id(1), agentId: "agent_a" }],
      transport,
      gate: createConcurrencyGate({ limit: 2 }),
      harness: createFakeHarness(),
      cursorPath,
      coalesceMs: 1,
    });
    await first.wake.runOnce();
    await first.wake.stop();
    await first.scheduler.idle();
    assert.equal(await first.cursorStore.read(), 6);
    assert.equal(JSON.parse(fs.readFileSync(cursorPath, "utf8")).cursor, 6);
    assert.equal(await createAtomicFileCursorStore({ filePath: cursorPath }).read(), 6);

    const second = createWakeRuntime({
      profiles: [{ instanceId: id(1), agentId: "agent_a" }],
      transport,
      gate: createConcurrencyGate({ limit: 2 }),
      harness: createFakeHarness(),
      cursorPath,
      coalesceMs: 1,
    });
    assert.equal(await second.cursorStore.read(), 6);
    await second.wake.runOnce();
    await second.wake.stop();
  } finally {
    fixture.cleanup();
  }
});

test("reconnect storm admits at most the configured global connection limit", async () => {
  const globalLimit = 3;
  let active = 0;
  let peak = 0;
  let rejected = 0;
  const transport = {
    async poll() {
      if (active >= globalLimit) {
        rejected += 1;
        const error = new Error("connection limit");
        error.code = "connection_limit";
        throw error;
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { cursor: 1, events: [] };
    },
  };
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => transport.poll()));
  assert.equal(peak, globalLimit);
  assert.ok(rejected >= 1);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, globalLimit);
  assert.equal(results.filter((entry) => entry.status === "rejected").length, 12 - globalLimit);
});

test("crash after claim before ack leaves work unacked for same-claim reclaim", async () => {
  let appendAttempts = 0;
  const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const eventId = "event_00000000000000000000000000000002";
  const mailboxResponse = { items: [{
    deliveryId: 201,
    roomId,
    eventId,
    roomSequence: 1,
    state: "pending",
    createdAt: "2026-08-07T00:00:00Z",
  }] };
  const { fetchImpl, state } = createMailboxFetchFixture({
    mailboxResponse,
    roomHistoryByRoom: new Map([[roomId, [canonicalEvent({
      id: eventId,
      roomId,
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      text: "claim then crash",
    })]]]),
    appendEvent(roomIdValue, body, stateObj) {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error("crash after claim before durable append");
      stateObj.appendCount += 1;
      const existing = stateObj.roomHistoryByRoom.get(roomIdValue) ?? [];
      const event = {
        id: "event_99999999999999999999999999999999",
        roomId: roomIdValue,
        sequence: 2,
        senderAgentId: "agent_11111111111111111111111111111111",
        type: "message.created",
        idempotencyKey: body.idempotency_key,
        idempotency_key: body.idempotency_key,
        body: body.body,
      };
      existing.push(event);
      stateObj.roomHistoryByRoom.set(roomIdValue, existing);
      return { event };
    },
  });
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    meshToken: "mesh-secret",
    recipientId: "agent_11111111111111111111111111111111",
  }, { fetchImpl });
  const [message] = await client.listUnread();
  let generations = 0;
  const generate = () => {
    generations += 1;
    return { status: "completed", text: "recovered" };
  };
  await assert.rejects(
    () => client.completeAndAcknowledge(message, generate),
    /crash after claim/,
  );
  assert.equal(state.acknowledgeCount, 0);

  // Same process keeps claim ownership; mailbox page can go empty while retry queue holds work.
  mailboxResponse.items.length = 0;
  const [retry] = await client.listUnread();
  await client.completeAndAcknowledge(retry, generate);
  assert.equal(state.acknowledgeCount, 1);
  assert.equal(appendAttempts, 2);
  assert.equal(generations, 2);
});

test("crash after generation before ack does not regenerate when reply is durable", async () => {
  let generateCount = 0;
  let failAckOnce = true;
  const roomId = "room_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const eventId = "event_00000000000000000000000000000003";
  const mailboxResponse = { items: [{
    deliveryId: 202,
    roomId,
    eventId,
    roomSequence: 1,
    state: "pending",
    createdAt: "2026-08-07T00:00:00Z",
  }] };
  const { fetchImpl, state } = createMailboxFetchFixture({
    mailboxResponse,
    roomHistoryByRoom: new Map([[roomId, [canonicalEvent({
      id: eventId,
      roomId,
      sequence: 1,
      senderAgentId: "agent_22222222222222222222222222222222",
      text: "generate then crash",
    })]]]),
    acknowledge() {
      if (failAckOnce) {
        failAckOnce = false;
        throw new Error("crash after generation before ack");
      }
      return { acknowledged: 1 };
    },
  });
  const client = createMailboxClient({
    meshUrl: "https://mesh.example",
    meshToken: "mesh-secret",
    recipientId: "agent_11111111111111111111111111111111",
  }, { fetchImpl });
  const generate = () => {
    generateCount += 1;
    return { status: "completed", text: "durable-reply" };
  };
  const [message] = await client.listUnread();
  await assert.rejects(() => client.completeAndAcknowledge(message, generate), /crash after generation/);
  assert.equal(generateCount, 1);
  assert.equal(state.appendCount, 1);
  assert.equal(state.acknowledgeCount, 0);

  mailboxResponse.items.length = 0;
  const [retry] = await client.listUnread();
  await client.completeAndAcknowledge(retry, generate);
  assert.equal(generateCount, 1, "retry must not regenerate a durable reply");
  assert.equal(state.appendCount, 1, "retry must not re-append a durable reply");
  assert.equal(state.acknowledgeCount, 1);
});

test("shared gate + fake harness soak slice preserves single-flight and cap", async () => {
  const gate = createConcurrencyGate({ limit: 2 });
  let active = 0;
  let peak = 0;
  const harness = createFakeHarness({
    actionable: async () => true,
    drain: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: "drained" };
    },
  });
  const scheduler = createProfileScheduler({ gate, harness });
  for (let cycle = 0; cycle < 40; cycle += 1) {
    scheduler.submitWake({ instanceId: id((cycle % 5) + 1), highWatermark: cycle + 1 });
  }
  await scheduler.idle();
  assert.ok(peak <= 2);
  assert.ok(harness.calls.filter((call) => call.type === "drain").length >= 5);
});

test("standalone soak report proves every submitted profile watermark reconciled", () => {
  const script = fileURLToPath(new URL("../../../scripts/soak-fake-wake.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--cycles", "500"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.lostWakeProfiles, 0);
  assert.equal(report.finalWatermarks.length, 5);
  assert.ok(report.retainedObservationCount <= 10);
  assert.equal(
    report.finalWatermarks.every(({ expected, reconciled }) => expected === reconciled),
    true,
  );
});
