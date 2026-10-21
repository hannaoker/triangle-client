import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";

import {
  createPeerDrainService,
  derivePeerReplyId,
  deriveScopedContextId,
  parsePeerEnvelope,
  PEER_ENVELOPE_PROTOCOL,
} from "../src/peer-drain-service.mjs";

const digest = (s) => createHash("sha256").update(s, "utf8").digest("hex");

test("peer envelope parsing and deterministic reply ID derivation", () => {
  const reqEnvelope = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "request",
    request_id: "req-12345",
    text: "Hello from peer",
  });

  const parsed = parsePeerEnvelope(reqEnvelope);
  assert.equal(parsed.protocol, PEER_ENVELOPE_PROTOCOL);
  assert.equal(parsed.kind, "request");
  assert.equal(parsed.request_id, "req-12345");
  assert.equal(parsed.text, "Hello from peer");

  const sender = "1".repeat(64);
  const replyId = derivePeerReplyId(sender, "msg-abc-001");
  assert.ok(replyId.startsWith("peer-reply-"));
  // Deterministic check
  assert.equal(replyId, derivePeerReplyId(sender, "msg-abc-001"));
  assert.notEqual(replyId, derivePeerReplyId(sender, "msg-abc-002"));

  // Reject malformed envelopes
  assert.throws(() => parsePeerEnvelope("not json"), /invalid_envelope/);
  assert.throws(
    () =>
      parsePeerEnvelope(
        JSON.stringify({
          protocol: "triangle.peer-proof/1",
          kind: "request",
          request_id: "legacy-1",
          text: "proof-only envelope",
        }),
      ),
    /invalid_envelope/,
  );
  assert.throws(
    () =>
      parsePeerEnvelope(
        JSON.stringify({
          protocol: "wrong-protocol",
          kind: "request",
          request_id: "1",
          text: "hi",
        }),
      ),
    /invalid_envelope/,
  );
  assert.throws(
    () =>
      parsePeerEnvelope(
        JSON.stringify({
          protocol: PEER_ENVELOPE_PROTOCOL,
          kind: "reply",
          request_id: "1",
          text: "hi",
        }),
      ),
    /invalid_envelope/,
  );
});

test("peer drain executes request, persists admission, verifies status, and ACKs inbound", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-happy-")));
  const senderId = "2".repeat(64);
  const messageId = "msg-inbound-001";
  const requestPayload = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "request",
    request_id: "req-001",
    text: "Calculate 2 + 2",
  });
  const inputHash = digest(requestPayload);

  let sentPayload = null;
  let ackedItems = null;
  let runnerCalled = 0;

  const mockIpc = {
    async request(method, params) {
      if (method === "inbox") {
        if (ackedItems) return { items: [] };
        return {
          items: [
            {
              seq: 1,
              from_endpoint_id: senderId,
              message_id: messageId,
              payload: requestPayload,
              payload_hash: inputHash,
              ts_unix_ms: Date.now(),
            },
          ],
        };
      }
      if (method === "send") {
        sentPayload = params.payload;
        return { status: "received_peer" };
      }
      if (method === "message_status") {
        return {
          message_id: params.message_id,
          peer_endpoint_id: senderId,
          payload_hash: digest(sentPayload),
          state: "queued_local",
        };
      }
      if (method === "ack") {
        ackedItems = params.items;
        return { acked: 1, already_acked: 0, unknown: [] };
      }
      throw new Error(`Unhandled mock method: ${method}`);
    },
  };

  const mockRunner = {
    async run(req) {
      runnerCalled++;
      assert.equal(req.text, "Calculate 2 + 2");
      assert.equal(req.senderId, senderId);
      assert.equal(req.contextId, deriveScopedContextId(senderId, "req-001"));
      assert.equal(req.requestId, "req-001");
      return { status: "completed", text: "Result is 4" };
    },
  };

  const routes = new Map([[senderId, { id: senderId, addrs: ["/ip4/127.0.0.1/udp/1234/quic-v1"] }]]);

  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "test-agent",
    profileInstanceId: "3".repeat(64),
    ipc: mockIpc,
    runner: mockRunner,
    routes,
  });

  try {
    const outcome = await drain.step();
    assert.equal(outcome.state, "acked");
    assert.equal(outcome.messageId, messageId);
    assert.equal(runnerCalled, 1);
    assert.ok(sentPayload);
    const replyEnvelope = JSON.parse(sentPayload);
    assert.equal(replyEnvelope.text, "Result is 4");
    assert.equal(replyEnvelope.in_reply_to, messageId);
    assert.deepEqual(ackedItems, [{ from_endpoint_id: senderId, message_id: messageId }]);
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("failed reply admission: terminal failure enters reply_failed and acks; transient failure retries without acking", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-reply-fail-")));
  const senderId = "4".repeat(64);
  const messageId = "msg-inbound-002";
  const requestPayload = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "request",
    request_id: "req-002",
    text: "Unadmitted work",
  });

  let ackCalled = false;
  let statusState = "expired";
  const mockIpc = {
    async request(method, params) {
      if (method === "inbox") {
        return {
          items: [
            {
              seq: 1,
              from_endpoint_id: senderId,
              message_id: messageId,
              payload: requestPayload,
              payload_hash: digest(requestPayload),
              ts_unix_ms: Date.now(),
            },
          ],
        };
      }
      if (method === "send") {
        if (statusState === "outbox_full") {
          const err = new Error("outbox full");
          err.code = "outbox_full";
          throw err;
        }
        return {};
      }
      if (method === "message_status") {
        return {
          message_id: params.message_id,
          peer_endpoint_id: senderId,
          payload_hash: "wrong_hash",
          state: statusState,
          reason: "terminal reason",
        };
      }
      if (method === "ack") {
        ackCalled = true;
        return { acked: 1, already_acked: 0, unknown: [] };
      }
      throw new Error(`Unhandled mock method: ${method}`);
    },
  };

  const routes = new Map([[senderId, { id: senderId, addrs: [] }]]);

  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "test-agent",
    profileInstanceId: "5".repeat(64),
    ipc: mockIpc,
    runner: { async run() { return { status: "completed", text: "Unadmitted result" }; } },
    routes,
  });

  try {
    // 1. Terminal failure (expired/admission_mismatch) enters reply_failed, ACKs the inbound item
    const outcome = await drain.step();
    assert.equal(outcome.state, "reply_failed");
    assert.equal(ackCalled, true);
    assert.equal(drain.status().find((r) => r.message_id === messageId).phase, "reply_failed");

    // 2. Transient failure (outbox_full) does NOT ack and throws
    ackCalled = false;
    statusState = "outbox_full";
    const tmp2 = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-transient-")));
    const drain2 = createPeerDrainService({
      stateRoot: tmp2,
      profile: "test-agent",
      profileInstanceId: "6".repeat(64),
      ipc: mockIpc,
      runner: { async run() { return { status: "completed", text: "Transient result" }; } },
      routes,
    });
    try {
      await assert.rejects(drain2.step(), (err) => err.code === "outbox_full");
      assert.equal(ackCalled, false);
    } finally {
      drain2.close();
      rmSync(tmp2, { recursive: true, force: true });
    }
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("duplicate input is handled without re-executing; conflict is rejected", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-dedupe-")));
  const senderId = "6".repeat(64);
  const messageId = "msg-inbound-003";
  const requestPayload = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "request",
    request_id: "req-003",
    text: "Deduplicated work",
  });
  const inputHash = digest(requestPayload);

  let runnerCalls = 0;
  const mockIpc = {
    async request(method, params) {
      if (method === "inbox") {
        return {
          items: [
            {
              seq: 1,
              from_endpoint_id: senderId,
              message_id: messageId,
              payload: requestPayload,
              payload_hash: inputHash,
              ts_unix_ms: Date.now(),
            },
          ],
        };
      }
      if (method === "send") return { status: "received_peer" };
      if (method === "message_status") {
        return {
          message_id: params.message_id,
          peer_endpoint_id: senderId,
          payload_hash: digest(
            JSON.stringify({
              protocol: PEER_ENVELOPE_PROTOCOL,
              kind: "reply",
              request_id: "req-003",
              in_reply_to: messageId,
              text: "Reply 1",
            }),
          ),
          state: "queued_local",
        };
      }
      if (method === "ack") return { acked: 1, already_acked: 0, unknown: [] };
      throw new Error(`Unhandled mock method: ${method}`);
    },
  };

  const routes = new Map([[senderId, { id: senderId, addrs: [] }]]);
  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "test-agent",
    profileInstanceId: "7".repeat(64),
    ipc: mockIpc,
    runner: {
      async run() {
        runnerCalls++;
        return { status: "completed", text: "Reply 1" };
      },
    },
    routes,
  });

  try {
    // First execution succeeds
    const first = await drain.step();
    assert.equal(first.state, "acked");
    assert.equal(runnerCalls, 1);

    // Second redelivery of the exact same message: returns acked without re-running!
    const second = await drain.step();
    assert.equal(second.state, "acked");
    assert.equal(runnerCalls, 1); // runner was NOT called again
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("crash during execution recovers to held on restart and never re-runs", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-held-")));
  const senderId = "8".repeat(64);
  const messageId = "msg-inbound-004";
  const requestPayload = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "request",
    request_id: "req-004",
    text: "Crashing work",
  });

  let runnerCalls = 0;
  const mockIpc = {
    async request(method) {
      if (method === "inbox") {
        return {
          items: [
            {
              seq: 1,
              from_endpoint_id: senderId,
              message_id: messageId,
              payload: requestPayload,
              payload_hash: digest(requestPayload),
              ts_unix_ms: Date.now(),
            },
          ],
        };
      }
      if (method === "ack") {
        return { acked: 1, already_acked: 0, unknown: [] };
      }
      return {};
    },
  };

  const routes = new Map([[senderId, { id: senderId, addrs: [] }]]);

  // First session: runner throws / crashes
  const drain1 = createPeerDrainService({
    stateRoot: tmp,
    profile: "test-agent",
    profileInstanceId: "9".repeat(64),
    ipc: mockIpc,
    runner: {
      async run() {
        runnerCalls++;
        throw new Error("Runner sudden failure");
      },
    },
    routes,
  });

  const outcome1 = await drain1.step();
  assert.equal(outcome1.state, "held");
  assert.equal(runnerCalls, 1);
  drain1.close();

  // Second session (restart recovery):
  // Opening the DB recovers any lingering 'executing' to 'held',
  // and subsequent delivery of the same message stays held!
  const drain2 = createPeerDrainService({
    stateRoot: tmp,
    profile: "test-agent",
    profileInstanceId: "9".repeat(64),
    ipc: mockIpc,
    runner: {
      async run() {
        runnerCalls++;
        return { status: "completed", text: "Should not run" };
      },
    },
    routes,
  });

  try {
    const outcome2 = await drain2.step();
    assert.equal(outcome2.state, "held");
    assert.equal(runnerCalls, 1); // Not called again!
  } finally {
    drain2.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("received peer replies stay retrievable after ack and process restart until consumed", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-received-reply-")));
  const senderId = "a".repeat(64);
  const messageId = "msg-reply-001";
  const payload = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "reply",
    request_id: "req-001",
    in_reply_to: "msg-outbound-001",
    text: "The remote agent says hello.",
  });
  let acked = false;
  const ipc = {
    async request(method, params) {
      if (method === "send") return {};
      if (method === "message_status") {
        return {
          message_id: params.message_id,
          peer_endpoint_id: senderId,
          payload_hash: digest(JSON.stringify({
            protocol: PEER_ENVELOPE_PROTOCOL,
            kind: "request",
            request_id: "req-001",
            text: "initial",
          })),
          state: "queued_local",
        };
      }
      if (method === "inbox") {
        return {
          items: acked
            ? []
            : [{
              seq: 1,
              from_endpoint_id: senderId,
              message_id: messageId,
              payload,
              payload_hash: digest(payload),
              ts_unix_ms: Date.now(),
            }],
        };
      }
      if (method === "ack") {
        acked = true;
        assert.deepEqual(params.items, [{ from_endpoint_id: senderId, message_id: messageId }]);
        return { acked: 1, already_acked: 0, unknown: [] };
      }
      throw new Error(`Unhandled mock method: ${method}`);
    },
  };
  const options = {
    stateRoot: tmp,
    profile: "test-agent",
    profileInstanceId: "b".repeat(64),
    ipc,
    routes: new Map([[senderId, { id: senderId, addrs: [] }]]),
    runner: { async run() { throw new Error("reply must not invoke the runner"); } },
  };

  let drain = createPeerDrainService(options);
  try {
    await drain.sendRequest({ toEndpointId: senderId, text: "initial", requestId: "req-001", messageId: "msg-outbound-001" });
    const result = await drain.step();
    assert.equal(result.state, "reply_received");
    assert.equal(result.text, "The remote agent says hello.");
    assert.equal(acked, true);
    assert.equal(drain.pendingReplies()[0].messageId, messageId);
  } finally {
    drain.close();
  }

  drain = createPeerDrainService(options);
  try {
    assert.equal(drain.pendingReplies()[0].text, "The remote agent says hello.");
    assert.deepEqual(drain.consumeReply({ fromEndpointId: senderId, messageId }), { consumed: true });
    assert.deepEqual(drain.pendingReplies(), []);
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("outbound peer request verifies durable admission and preserves IDs across ambiguous send", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-outbound-")));
  const recipientId = "c".repeat(64);
  const route = { id: recipientId, addrs: ["/ip4/127.0.0.1/udp/1234/quic-v1"] };
  const sent = [];
  let sendError = Object.assign(new Error("connection reset after write"), { code: "ipc_disconnected" });
  let statusState = "queued_local";
  const ipc = {
    async request(method, params) {
      if (method === "send") {
        sent.push(params);
        if (sendError) {
          const error = sendError;
          sendError = null;
          throw error;
        }
        return {};
      }
      if (method === "message_status") {
        return {
          message_id: params.message_id,
          peer_endpoint_id: recipientId,
          payload_hash: digest(sent.at(-1).payload),
          state: statusState,
          attempts: 2,
        };
      }
      throw new Error(`Unhandled mock method: ${method}`);
    },
  };
  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "sender",
    profileInstanceId: "d".repeat(64),
    ipc,
    runner: { async run() { throw new Error("outbound send must not invoke runner"); } },
    routes: new Map([[recipientId, route]]),
  });

  try {
    const first = await drain.sendRequest({
      toEndpointId: recipientId,
      text: "Hello over Iroh",
      requestId: "request-001",
      messageId: "message-001",
    });
    assert.deepEqual(first, {
      messageId: "message-001",
      requestId: "request-001",
      toEndpointId: recipientId,
      state: "queued_local",
      settled: false,
      attempts: 2,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message_id, "message-001");
    assert.deepEqual(sent[0].peer_addr, route);
    assert.deepEqual(JSON.parse(sent[0].payload), {
      protocol: PEER_ENVELOPE_PROTOCOL,
      kind: "request",
      request_id: "request-001",
      text: "Hello over Iroh",
    });

    statusState = "settled";
    const retry = await drain.sendRequest({
      toEndpointId: recipientId,
      text: "Hello over Iroh",
      requestId: "request-001",
      messageId: "message-001",
    });
    assert.equal(retry.state, "settled");
    assert.equal(retry.settled, true);
    assert.equal(sent[1].message_id, "message-001");

    await assert.rejects(
      drain.sendRequest({ toEndpointId: recipientId, text: "x", messageId: "m".repeat(257) }),
      (error) => error.code === "invalid_identifier",
    );
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("outbound peer request rejects unverified admission and keeps the generated ID on the error", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-outbound-bad-")));
  const recipientId = "e".repeat(64);
  const sent = [];
  const ipc = {
    async request(method, params) {
      if (method === "send") {
        sent.push(params);
        return {};
      }
      if (method === "message_status") {
        return {
          message_id: params.message_id,
          peer_endpoint_id: recipientId,
          payload_hash: "wrong-hash",
          state: "queued_local",
        };
      }
      throw new Error(`Unhandled mock method: ${method}`);
    },
  };
  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "sender",
    profileInstanceId: "f".repeat(64),
    ipc,
    runner: { async run() {} },
    routes: new Map([[recipientId, { id: recipientId, addrs: [] }]]),
  });
  try {
    await assert.rejects(
      drain.sendRequest({ toEndpointId: recipientId, text: "Hello" }),
      (error) => error.code === "admission_unverified"
        && typeof error.messageId === "string"
        && error.messageId === sent[0].message_id
        && typeof error.requestId === "string",
    );
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("outbound peer request exposes its stable message ID when status reconciliation is unavailable", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-outbound-unknown-")));
  const recipientId = "1".repeat(64);
  let sentMessageId = null;
  const ipc = {
    async request(method, params) {
      if (method === "send") {
        sentMessageId = params.message_id;
        throw Object.assign(new Error("socket closed after write"), { code: "ipc_disconnected" });
      }
      if (method === "message_status") {
        throw Object.assign(new Error("engine unavailable"), { code: "ipc_disconnected" });
      }
      throw new Error(`Unhandled mock method: ${method}`);
    },
  };
  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "sender",
    profileInstanceId: "2".repeat(64),
    ipc,
    runner: { async run() {} },
    routes: new Map([[recipientId, { id: recipientId, addrs: [] }]]),
  });
  try {
    await assert.rejects(
      drain.sendRequest({ toEndpointId: recipientId, text: "Maybe delivered" }),
      (error) => error.code === "admission_unresolved"
        && error.messageId === sentMessageId
        && typeof error.requestId === "string",
    );
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("operator recovery resolvePeerRecord supports retry, resend, discard with idempotency and revision tracking", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-operator-")));
  const senderId = "3".repeat(64);
  const route = { id: senderId, addrs: [] };
  let runnerCalls = 0;
  let sentPayload = null;

  const mockIpc = {
    async request(method, params) {
      if (method === "inbox") return { items: [] };
      if (method === "send") {
        sentPayload = params.payload;
        return {};
      }
      if (method === "message_status") {
        return {
          message_id: params.message_id,
          peer_endpoint_id: senderId,
          payload_hash: digest(sentPayload),
          state: "queued_local",
        };
      }
      if (method === "ack") return { acked: 1, already_acked: 0, unknown: [] };
      throw new Error(`Unhandled mock method: ${method}`);
    },
  };

  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "operator-test",
    profileInstanceId: "4".repeat(64),
    ipc: mockIpc,
    runner: {
      async run() {
        runnerCalls++;
        if (runnerCalls === 1) throw new Error("first attempt crashes");
        return { status: "completed", text: "second attempt succeeds" };
      },
    },
    routes: new Map([[senderId, route]]),
  });

  try {
    // 1. Initial turn fails -> enters 'held', acked
    const reqPayload = JSON.stringify({
      protocol: PEER_ENVELOPE_PROTOCOL,
      kind: "request",
      request_id: "req-held-1",
      text: "Task that crashes",
    });
    // Inject into inbox for step 1
    let inboxItem = {
      seq: 1,
      from_endpoint_id: senderId,
      message_id: "msg-held-1",
      payload: reqPayload,
      payload_hash: digest(reqPayload),
      ts_unix_ms: Date.now(),
    };
    mockIpc.request = async (method, params) => {
      if (method === "inbox") {
        const items = inboxItem ? [inboxItem] : [];
        inboxItem = null;
        return { items };
      }
      if (method === "send") {
        sentPayload = params.payload;
        return {};
      }
      if (method === "message_status") {
        return {
          message_id: params.message_id,
          peer_endpoint_id: senderId,
          payload_hash: digest(sentPayload),
          state: "queued_local",
        };
      }
      if (method === "ack") return { acked: 1, already_acked: 0, unknown: [] };
      throw new Error(`Unhandled method: ${method}`);
    };

    const first = await drain.step();
    assert.equal(first.state, "held");
    assert.equal(runnerCalls, 1);
    let st = drain.status().find((r) => r.message_id === "msg-held-1");
    assert.equal(st.phase, "held");

    // 2. Conflicting operation ID fails
    await assert.rejects(
      async () => {
        drain.resolvePeerRecord({
          fromEndpointId: senderId,
          messageId: "msg-held-1",
          action: "invalid_action",
          operationId: "op-1",
          expectedRevision: 1,
        });
      },
      (err) => err.code === "invalid_action",
    );

    // 3. Stale revision fails
    assert.throws(
      () => drain.resolvePeerRecord({
        fromEndpointId: senderId,
        messageId: "msg-held-1",
        action: "retry",
        operationId: "op-1",
        expectedRevision: 99,
      }),
      (err) => err.code === "revision_conflict",
    );

    // 4. Operator admits retry -> enters retry_pending, incrementing revision and attempt
    const opResult = drain.resolvePeerRecord({
      fromEndpointId: senderId,
      messageId: "msg-held-1",
      action: "retry",
      operationId: "op-1",
      expectedRevision: 1,
    });
    assert.deepEqual(opResult, {
      operationId: "op-1",
      action: "retry",
      state: "retry_pending",
      messageId: "msg-held-1",
      revision: 2,
    });

    // Idempotent re-submission returns identical result
    const idempResult = drain.resolvePeerRecord({
      fromEndpointId: senderId,
      messageId: "msg-held-1",
      action: "retry",
      operationId: "op-1",
      expectedRevision: 1,
    });
    assert.deepEqual(idempResult, opResult);

    // Same op ID with different action throws conflict
    assert.throws(
      () => drain.resolvePeerRecord({
        fromEndpointId: senderId,
        messageId: "msg-held-1",
        action: "discard",
        operationId: "op-1",
      }),
      (err) => err.code === "operation_conflict",
    );

    // 5. Next step() services retry_pending without inbox item
    const retryOutcome = await drain.step();
    assert.equal(retryOutcome.state, "acked");
    assert.equal(runnerCalls, 2);
    st = drain.status().find((r) => r.message_id === "msg-held-1");
    assert.equal(st.phase, "acked");

    // 6. Test operator resend for reply_failed
    // Inject a reply_failed record
    const { DatabaseSync } = await import("node:sqlite");
    const rawDb = new DatabaseSync(path.join(tmp, "peer-drain.sqlite"));
    rawDb.prepare(`
      INSERT INTO records(sender, message_id, input_hash, phase, reply_id, reply_payload, result_payload, revision, terminal_at, created_at, updated_at)
      VALUES(?, 'msg-fail-1', 'h1', 'reply_failed', 'reply-fail-1', '{"protocol":"triangle.peer/1","kind":"reply","request_id":"r1","in_reply_to":"msg-fail-1","text":"saved answer"}', 'saved answer', 1, ?, ?, ?)
    `).run(senderId, Date.now(), Date.now(), Date.now());
    rawDb.close();

    const resendOp = drain.resolvePeerRecord({
      fromEndpointId: senderId,
      messageId: "msg-fail-1",
      action: "resend",
      operationId: "op-resend-1",
      expectedRevision: 1,
    });
    assert.equal(resendOp.state, "resend_pending");
    assert.ok(resendOp.replyId.includes("-resend-1"));

    // Servicing resend_pending never invokes runner!
    const runnerCallsBeforeResend = runnerCalls;
    const resendOutcome = await drain.step();
    assert.equal(resendOutcome.state, "acked");
    assert.equal(runnerCalls, runnerCallsBeforeResend); // Runner was NOT rerun!

    // 7. Explicit outbound closure
    await drain.sendRequest({ toEndpointId: senderId, text: "Req for close", requestId: "req-close", messageId: "msg-close" });
    const closeOp = drain.resolvePeerRecord({
      fromEndpointId: senderId,
      messageId: "msg-close",
      action: "close_outbound",
      operationId: "op-close-1",
    });
    assert.equal(closeOp.state, "closed");

    // Late reply against closed outbound correlation is rejected
    inboxItem = {
      seq: 2,
      from_endpoint_id: senderId,
      message_id: "reply-late-1",
      payload: JSON.stringify({
        protocol: PEER_ENVELOPE_PROTOCOL,
        kind: "reply",
        request_id: "req-close",
        in_reply_to: "msg-close",
        text: "too late",
      }),
      payload_hash: digest(JSON.stringify({
        protocol: PEER_ENVELOPE_PROTOCOL,
        kind: "reply",
        request_id: "req-close",
        in_reply_to: "msg-close",
        text: "too late",
      })),
      ts_unix_ms: Date.now(),
    };
    const lateReplyOutcome = await drain.step();
    assert.equal(lateReplyOutcome.state, "rejected");
    assert.equal(lateReplyOutcome.reason, "correlation_closed");
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("retention compaction deletes records older than 8 days but preserves active custody", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-retention-")));
  const senderId = "5".repeat(64);
  const nowMs = 1700000000000;
  const oldMs = nowMs - (9 * 24 * 60 * 60 * 1000); // 9 days old

  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "retention-test",
    profileInstanceId: "6".repeat(64),
    ipc: { async request(m) { if (m === "inbox") return { items: [] }; throw new Error(m); } },
    runner: { async run() {} },
    now: () => nowMs,
    routes: new Map([[senderId, { id: senderId, addrs: [] }]]),
  });

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const rawDb = new DatabaseSync(path.join(tmp, "peer-drain.sqlite"));

    // Insert old terminal record (acked) -> should be deleted
    rawDb.prepare(`
      INSERT INTO records(sender, message_id, input_hash, phase, terminal_at, created_at, updated_at)
      VALUES(?, 'msg-old-acked', 'h1', 'acked', ?, ?, ?)
    `).run(senderId, oldMs, oldMs, oldMs);

    // Insert old held record -> MUST BE PRESERVED
    rawDb.prepare(`
      INSERT INTO records(sender, message_id, input_hash, phase, terminal_at, created_at, updated_at)
      VALUES(?, 'msg-old-held', 'h2', 'held', ?, ?, ?)
    `).run(senderId, oldMs, oldMs, oldMs);

    // Insert old reply_failed record -> MUST BE PRESERVED
    rawDb.prepare(`
      INSERT INTO records(sender, message_id, input_hash, phase, terminal_at, created_at, updated_at)
      VALUES(?, 'msg-old-failed', 'h3', 'reply_failed', ?, ?, ?)
    `).run(senderId, oldMs, oldMs, oldMs);

    // Insert old closed outbound -> should be deleted
    rawDb.prepare(`
      INSERT INTO outbound(message_id, to_endpoint_id, request_id, payload_hash, state, created_at, updated_at, closed_at)
      VALUES('out-old-closed', ?, 'r1', 'h4', 'settled', ?, ?, ?)
    `).run(senderId, oldMs, oldMs, oldMs);

    // Insert old unclosed outbound -> MUST BE PRESERVED
    rawDb.prepare(`
      INSERT INTO outbound(message_id, to_endpoint_id, request_id, payload_hash, state, created_at, updated_at)
      VALUES('out-old-open', ?, 'r2', 'h5', 'settled', ?, ?)
    `).run(senderId, oldMs, oldMs);

    rawDb.close();

    // Trigger step() which runs retention compaction
    await drain.step();

    const remaining = drain.status().map((r) => r.message_id);
    assert.ok(!remaining.includes("msg-old-acked"), "Old acked record should be compacted");
    assert.ok(remaining.includes("msg-old-held"), "Old held record MUST be preserved");
    assert.ok(remaining.includes("msg-old-failed"), "Old reply_failed record MUST be preserved");

    const rawDbCheck = new DatabaseSync(path.join(tmp, "peer-drain.sqlite"));
    const remainingOutbound = rawDbCheck.prepare("SELECT message_id FROM outbound").all().map((r) => r.message_id);
    rawDbCheck.close();
    assert.ok(!remainingOutbound.includes("out-old-closed"), "Old closed outbound record should be compacted");
    assert.ok(remainingOutbound.includes("out-old-open"), "Old unclosed outbound record MUST be preserved");
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("invariant 5: abort before runner start deletes executing record rather than holding it", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-abort-pre-")));
  const senderId = "7".repeat(64);
  const messageId = "msg-pre-abort";
  const reqPayload = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "request",
    request_id: "req-abort-1",
    text: "Will be aborted before run",
  });

  const mockIpc = {
    async request(m) {
      if (m === "inbox") {
        return {
          items: [{
            seq: 1,
            from_endpoint_id: senderId,
            message_id: messageId,
            payload: reqPayload,
            payload_hash: digest(reqPayload),
            ts_unix_ms: Date.now(),
          }],
        };
      }
      throw new Error(`Unexpected IPC: ${m}`);
    },
  };

  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "abort-test",
    profileInstanceId: "8".repeat(64),
    ipc: mockIpc,
    runner: {
      async run() {
        throw new Error("Runner should never be called when aborted");
      },
    },
    routes: new Map([[senderId, { id: senderId, addrs: [] }]]),
  });

  try {
    const ac = new AbortController();
    ac.abort(); // already aborted

    await assert.rejects(
      drain.step({ signal: ac.signal }),
      (err) => err.code === "aborted" || err.name === "AbortError",
    );

    // Record MUST NOT exist in records (deleted, not held)
    const st = drain.status().find((r) => r.message_id === messageId);
    assert.equal(st, undefined, "Executing admission should be deleted on pre-runner abort");
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("cap backpressure: at 10,000 records, pauses intake without acking or spinning", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-cap-")));
  const senderId = "9".repeat(64);

  let inboxPolled = false;
  const mockIpc = {
    async request(m) {
      if (m === "inbox") {
        inboxPolled = true;
        return { items: [] };
      }
      throw new Error(`Unexpected IPC: ${m}`);
    },
  };

  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "cap-test",
    profileInstanceId: "a".repeat(64),
    ipc: mockIpc,
    runner: { async run() {} },
    routes: new Map([[senderId, { id: senderId, addrs: [] }]]),
  });

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const rawDb = new DatabaseSync(path.join(tmp, "peer-drain.sqlite"));
    rawDb.exec("BEGIN");
    for (let i = 0; i < 10000; i++) {
      rawDb.prepare(`
        INSERT INTO records(sender, message_id, input_hash, phase, created_at, updated_at)
        VALUES(?, ?, 'h', 'held', 0, 0)
      `).run(senderId, `cap-msg-${i}`);
    }
    rawDb.exec("COMMIT");
    rawDb.close();

    const res = await drain.step();
    assert.equal(res.state, "journal_full");
    assert.equal(inboxPolled, false, "Inbox must NOT be polled when journal is at capacity");
    assert.equal(drain.status().journalFull, true);
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("operator retry rejects with execution_still_active while runner is still active", async () => {
  const tmp = realpathSync(mkdtempSync("/tmp/p-active-"));
  const senderId = "a".repeat(64);
  let runnerResolve;
  const runnerPromise = new Promise((resolve) => {
    runnerResolve = resolve;
  });

  const payload = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "request",
    request_id: "req-slow-1",
    text: "take your time",
  });

  let acks = 0;
  const mockIpc = {
    async request(m) {
      if (m === "inbox") {
        return {
          items: [{
            from_endpoint_id: senderId,
            message_id: "slow-msg-1",
            payload_hash: digest(payload),
            payload,
          }],
        };
      }
      if (m === "ack") {
        acks++;
        return { acked: 1, already_acked: 0, unknown: [] };
      }
      if (m === "send") {
        return { duplicate: false, status: "queued_local" };
      }
      throw new Error(`Unexpected IPC: ${m}`);
    },
  };

  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "active-test",
    profileInstanceId: "a".repeat(64),
    ipc: mockIpc,
    runnerTimeoutMs: 20,
    runner: {
      async run() {
        return runnerPromise;
      },
    },
    routes: new Map([[senderId, { id: senderId, addrs: [] }]]),
  });

  try {
    const stepRes = await drain.step();
    assert.equal(stepRes.state, "held");
    assert.equal(stepRes.reason, "runner_timeout");

    // While runnerPromise is still unresolved, retry must fail with execution_still_active
    await assert.rejects(
      async () => {
        drain.resolvePeerRecord({
          fromEndpointId: senderId,
          messageId: "slow-msg-1",
          action: "retry",
          operationId: "op-retry-1",
        });
      },
      (err) => err.code === "execution_still_active",
    );

    // Now complete the runner
    runnerResolve({ status: "completed", text: "done finally" });
    await new Promise((r) => setImmediate(r));

    // Once runner is settled, retry must succeed
    const retryRes = drain.resolvePeerRecord({
      fromEndpointId: senderId,
      messageId: "slow-msg-1",
      action: "retry",
      operationId: "op-retry-2",
    });
    assert.equal(retryRes.state, "retry_pending");
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("recovery after acknowledgement retention avoids duplicate engine ack and does not wedge", async () => {
  const tmp = realpathSync(mkdtempSync("/tmp/p-ack-ret-"));
  const senderId = "a".repeat(64);
  let tombstoneExpired = false;
  let acks = 0;
  let sentPayload = null;

  const payload = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "request",
    request_id: "req-tomb-1",
    text: "will fail first",
  });

  const mockIpc = {
    async request(m, p) {
      if (m === "inbox") {
        return {
          items: [{
            from_endpoint_id: senderId,
            message_id: "tomb-msg-1",
            payload_hash: digest(payload),
            payload,
          }],
        };
      }
      if (m === "ack") {
        acks++;
        if (tombstoneExpired) {
          // Emulate expired tombstone after 8 days
          return { acked: 0, already_acked: 0, unknown: p.items };
        }
        return { acked: 1, already_acked: 0, unknown: [] };
      }
      if (m === "send") {
        sentPayload = p.payload;
        return { duplicate: false, status: "queued_local" };
      }
      if (m === "message_status") {
        return {
          message_id: p.message_id,
          peer_endpoint_id: senderId,
          payload_hash: digest(sentPayload),
          state: "settled",
          reason: null,
        };
      }
      throw new Error(`Unexpected IPC: ${m}`);
    },
  };

  let failFirst = true;
  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "ack-ret-test",
    profileInstanceId: "a".repeat(64),
    ipc: mockIpc,
    runner: {
      async run() {
        if (failFirst) {
          throw new Error("inference failed initially");
        }
        return { status: "completed", text: "recovered reply text" };
      },
    },
    routes: new Map([[senderId, { id: senderId, addrs: [] }]]),
  });

  try {
    const step1 = await drain.step();
    assert.equal(step1.state, "held");
    assert.equal(acks, 1, "Initial failure must ack engine item");

    // Emulate 9 days elapsed: engine tombstone expired
    tombstoneExpired = true;
    failFirst = false;

    // Operator retries
    drain.resolvePeerRecord({
      fromEndpointId: senderId,
      messageId: "tomb-msg-1",
      action: "retry",
      operationId: "op-retry-tomb",
    });

    // Run drain step: should deliver reply and NOT call engine ack again (avoiding unverified_ack)
    const step2 = await drain.step();
    assert.equal(step2.state, "acked");
    assert.equal(acks, 1, "Engine ack must NOT be repeated for already-acknowledged input");
    assert.equal(drain.status().find((r) => r.message_id === "tomb-msg-1")?.phase, "acked");
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("oversized successful results are retained with result_saved=1 as reply_failed(result_too_large)", async () => {
  const tmp = realpathSync(mkdtempSync("/tmp/p-oversized-"));
  const senderId = "a".repeat(64);
  let ackedItems = 0;

  const hugeText = "A".repeat(300 * 1024); // 300 KiB > 256 KiB
  const payload = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "request",
    request_id: "req-over-1",
    text: "give me huge output",
  });

  const mockIpc = {
    async request(m, p) {
      if (m === "inbox") {
        return {
          items: [{
            from_endpoint_id: senderId,
            message_id: "oversized-msg-1",
            payload_hash: digest(payload),
            payload,
          }],
        };
      }
      if (m === "ack") {
        ackedItems += p.items?.length ?? 1;
        return { acked: 1, already_acked: 0, unknown: [] };
      }
      if (m === "send") {
        return { duplicate: false, status: "queued_local" };
      }
      throw new Error(`Unexpected IPC: ${m}`);
    },
  };

  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "oversize-test",
    profileInstanceId: "a".repeat(64),
    ipc: mockIpc,
    runner: {
      async run() {
        return { status: "completed", text: hugeText };
      },
    },
    routes: new Map([[senderId, { id: senderId, addrs: [] }]]),
  });

  try {
    const res = await drain.step();
    assert.equal(res.state, "reply_failed");
    assert.equal(res.reason, "result_too_large");

    // Verify record in DB has result_payload saved
    const { DatabaseSync } = await import("node:sqlite");
    const rawDb = new DatabaseSync(path.join(tmp, "peer-drain.sqlite"));
    const row = rawDb.prepare("SELECT * FROM records WHERE message_id=?").get("oversized-msg-1");
    rawDb.close();

    assert.ok(row, "Record must exist in DB");
    assert.equal(row.phase, "reply_failed");
    assert.equal(row.reason, "result_too_large");
    assert.equal(row.result_payload, hugeText, "Oversized result MUST be retained locally in result_payload");
    assert.equal(ackedItems, 1, "Inbound item must be acknowledged");
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("original draft database schema migrates columns before indexes without error", async () => {
  const tmp = realpathSync(mkdtempSync("/tmp/p-mig-v0-"));
  const { DatabaseSync } = await import("node:sqlite");
  const { chmodSync } = await import("node:fs");

  // Create database in v0 draft schema (as in commit 5e255d4, without in_reply_to, request_id, etc.)
  const dbPath = path.join(tmp, "peer-drain.sqlite");
  const rawDb = new DatabaseSync(dbPath);
  rawDb.exec(`
    CREATE TABLE records (
      sender TEXT NOT NULL,
      message_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      phase TEXT NOT NULL,
      reply_id TEXT,
      reply_payload TEXT,
      PRIMARY KEY (sender, message_id)
    );
    CREATE INDEX idx_records_phase ON records(phase);
    PRAGMA user_version = 0;
  `);
  rawDb.close();
  chmodSync(dbPath, 0o600);

  // Opening with createPeerDrainService must migrate columns before indexes and succeed without journal_unavailable
  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "mig-test",
    profileInstanceId: "a".repeat(64),
    ipc: { async request() { return { items: [] }; } },
    runner: { async run() {} },
  });

  try {
    const status = drain.status();
    assert.ok(Array.isArray(status));

    // Verify user_version is now 1 and new columns exist
    const checkDb = new DatabaseSync(dbPath);
    const uv = checkDb.prepare("PRAGMA user_version").get().user_version;
    assert.equal(uv, 1);
    const cols = checkDb.prepare("PRAGMA table_info(records)").all().map((c) => c.name);
    assert.ok(cols.includes("in_reply_to"));
    assert.ok(cols.includes("request_id"));
    assert.ok(cols.includes("input_acked"));
    checkDb.close();
  } finally {
    drain.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
