import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";

import {
  createPeerDrainService,
  derivePeerReplyId,
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
      assert.equal(req.contextId, "req-001");
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

test("failed reply admission does NOT ack inbound item", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-no-ack-")));
  const senderId = "4".repeat(64);
  const messageId = "msg-inbound-002";
  const requestPayload = JSON.stringify({
    protocol: PEER_ENVELOPE_PROTOCOL,
    kind: "request",
    request_id: "req-002",
    text: "Unadmitted work",
  });

  let ackCalled = false;
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
        return { status: "refused" };
      }
      if (method === "message_status") {
        // Return unverified state (e.g. refused or expired)
        return {
          message_id: params.message_id,
          peer_endpoint_id: senderId,
          payload_hash: "wrong_hash",
          state: "refused",
        };
      }
      if (method === "ack") {
        ackCalled = true;
        return { acked: 1, already_acked: 0, unknown: [] };
      }
      throw new Error(`Unhandled mock method: ${method}`);
    },
  };

  const mockRunner = {
    async run() {
      return { status: "completed", text: "Unadmitted result" };
    },
  };

  const routes = new Map([[senderId, { id: senderId, addrs: [] }]]);

  const drain = createPeerDrainService({
    stateRoot: tmp,
    profile: "test-agent",
    profileInstanceId: "5".repeat(64),
    ipc: mockIpc,
    runner: mockRunner,
    routes,
  });

  try {
    await assert.rejects(drain.step(), /admission_unverified/);
    // INVARIANT 6: ACK must NOT be sent if outbound admission failed verification
    assert.equal(ackCalled, false);
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

test("crash during execution recovers to quarantined on restart and never re-runs", async () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "peer-drain-quarantine-")));
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
  assert.equal(outcome1.state, "quarantined");
  assert.equal(runnerCalls, 1);
  drain1.close();

  // Second session (restart recovery):
  // Opening the DB recovers any lingering 'executing' to 'quarantined',
  // and subsequent delivery of the same message stays quarantined!
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
    assert.equal(outcome2.state, "quarantined");
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
    runner: { async run() { throw new Error("reply must not invoke the runner"); } },
  };

  let drain = createPeerDrainService(options);
  try {
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
    assert.equal(sent[0].peer_addr, route);
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
