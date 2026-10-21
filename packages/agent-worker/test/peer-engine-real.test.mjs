// NOTE: Without Slice R's lookup option, running peer-engine with default presets
// may publish local addresses to n0 discovery service. For local integration
// testing, direct-only mode is used in this test.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";

import { createPeerEngineManager } from "../src/peer-engine-manager.mjs";

const BINARY_PATH = process.env.PEER_ENGINE_BIN;

test("opt-in real peer-engine: start, hello, send to second engine, receipt, and graceful stop", {
  skip: !BINARY_PATH ? "PEER_ENGINE_BIN is not set; skipping real peer-engine integration test" : false,
}, async () => {
  const tmpA = realpathSync(mkdtempSync(path.join(os.tmpdir(), "p-real-a-")));
  const tmpB = realpathSync(mkdtempSync(path.join(os.tmpdir(), "p-real-b-")));

  const logsA = [];
  const logsB = [];

  const captureLogger = (dest) => ({
    info: (msg, meta) => dest.push({ level: "info", msg, meta }),
    warn: (msg, meta) => dest.push({ level: "warn", msg, meta }),
    error: (msg, meta) => dest.push({ level: "error", msg, meta }),
  });

  let mgrA = null;
  let mgrB = null;

  try {
    // Phase 1: Initialize Engine B to generate its identity and retrieve its endpoint ID
    const mgrB_init = createPeerEngineManager({
      stateRoot: tmpB,
      binaryPath: BINARY_PATH,
      directOnly: true,
      logger: captureLogger(logsB),
    });
    const readyB = await mgrB_init.start();
    assert.match(readyB.endpointId, /^[a-f0-9]{64}$/);
    await mgrB_init.stop();

    // Phase 2: Start Engine A admitting Engine B
    mgrA = createPeerEngineManager({
      stateRoot: tmpA,
      binaryPath: BINARY_PATH,
      directOnly: true,
      allowedPeers: [readyB.endpointId],
      logger: captureLogger(logsA),
    });
    const readyA = await mgrA.start();
    assert.match(readyA.endpointId, /^[a-f0-9]{64}$/);
    assert.equal(mgrA.isRunning, true);

    // Phase 3: Start Engine B admitting Engine A
    mgrB = createPeerEngineManager({
      stateRoot: tmpB,
      binaryPath: BINARY_PATH,
      directOnly: true,
      allowedPeers: [readyA.endpointId],
      logger: captureLogger(logsB),
    });
    await mgrB.start();
    assert.equal(mgrB.isRunning, true);

    // Phase 4: Test hello and status via IPC
    const clientA = mgrA.getIpcClient();
    const clientB = mgrB.getIpcClient();

    const helloA = await clientA.request("hello", {});
    assert.equal(helloA.endpoint_id, readyA.endpointId);
    assert.equal(helloA.protocol_version, 1);

    const helloB = await clientB.request("hello", {});
    assert.equal(helloB.endpoint_id, readyB.endpointId);
    assert.equal(helloB.protocol_version, 1);

    // Phase 5: Resolve Engine B's endpoint address and send message from A to B
    const addrB = await clientB.request("endpoint_addr", {});
    assert.equal(addrB.id, readyB.endpointId);
    assert.ok(Array.isArray(addrB.addrs));

    const testPayload = JSON.stringify({
      protocol: "triangle.peer-proof/1",
      kind: "request",
      request_id: "req-real-1",
      data: "hello from engine A to engine B",
    });

    const sendRes = await clientA.request("send", {
      message_id: "msg-real-1",
      peer_addr: addrB,
      payload: testPayload,
    });

    assert.equal(sendRes.status, "received_peer");
    assert.equal(sendRes.duplicate, false);
    assert.equal(sendRes.receiver_endpoint_id, readyB.endpointId);

    // Phase 6: Verify inbox receipt on Engine B
    let received = null;
    for (let i = 0; i < 30; i++) {
      const inbox = await clientB.request("inbox", { limit: 10 });
      if (inbox.items?.length > 0) {
        received = inbox.items.find((item) => item.message_id === "msg-real-1");
        if (received) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(received, "Engine B should receive message in inbox");
    assert.equal(received.from_endpoint_id, readyA.endpointId);
    assert.equal(received.payload, testPayload);

    // Ack item on Engine B
    const ackRes = await clientB.request("ack", {
      items: [
        {
          from_endpoint_id: received.from_endpoint_id,
          message_id: received.message_id,
        },
      ],
    });
    assert.equal(ackRes.acked, 1);

    // Phase 7: Stop both managers gracefully via SIGINT
    await mgrA.stop();
    assert.equal(mgrA.isRunning, false);

    await mgrB.stop();
    assert.equal(mgrB.isRunning, false);

    // Verify stdout/stderr handling: starting logs captured without crashing
    const startLogA = logsA.find((l) => l.msg === "triangle_peer_engine_starting");
    assert.ok(startLogA, "Manager A logged starting event");
  } finally {
    if (mgrA?.isRunning) await mgrA.stop().catch(() => {});
    if (mgrB?.isRunning) await mgrB.stop().catch(() => {});
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  }
});
