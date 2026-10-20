import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { mkdtempSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { createIpcClient } from "./peer-proof-broker.mjs";
const endpoint = "a".repeat(64);
async function server(t, respond) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "peer-ipc-"))),
    socketPath = path.join(root, "peer.sock");
  const sockets = new Set();
  const srv = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let b = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      b = Buffer.concat([b, chunk]);
      while (b.length >= 4 && b.length >= 4 + b.readUInt32BE()) {
        const n = b.readUInt32BE(),
          r = JSON.parse(b.subarray(4, 4 + n));
        b = b.subarray(4 + n);
        respond(r, socket);
      }
    });
  });
  await new Promise((r) => srv.listen(socketPath, r));
  chmodSync(socketPath, 0o600);
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => srv.close(r));
  });
  return socketPath;
}
function frame(r, result) {
  const b = Buffer.from(
      JSON.stringify({ protocol_version: 1, id: r.id, result }),
    ),
    h = Buffer.alloc(4);
  h.writeUInt32BE(b.length);
  return Buffer.concat([h, b]);
}
test("real Unix framing negotiates hello and handles fragmented replies", async (t) => {
  const calls = [];
  const socketPath = await server(t, (r, s) => {
    calls.push(r.method);
    const b = frame(
      r,
      r.method === "hello"
        ? { protocol_version: 1, endpoint_id: endpoint }
        : { inbox_count: 0 },
    );
    s.write(b.subarray(0, 2));
    setImmediate(() => s.write(b.subarray(2)));
  });
  const result = await createIpcClient({ socketPath }).request("status");
  assert.deepEqual(result, { inbox_count: 0 });
  assert.deepEqual(calls, ["hello", "status"]);
});
test("oversize frame and wrong response identity fail closed", async (t) => {
  for (const kind of ["oversize", "identity"]) {
    const socketPath = await server(t, (r, s) => {
      if (kind === "oversize") {
        const h = Buffer.alloc(4);
        h.writeUInt32BE(2 * 1024 * 1024 + 1);
        s.write(h);
      } else
        s.write(
          frame(
            { ...r, id: "wrong" },
            { protocol_version: 1, endpoint_id: endpoint },
          ),
        );
    });
    await assert.rejects(
      createIpcClient({ socketPath }).request("status"),
      kind === "oversize" ? /ipc_oversized/ : /ipc_invalid/,
    );
  }
});
test("abort and deadline close a stalled IPC call", async (t) => {
  const socketPath = await server(t, () => {}),
    client = createIpcClient({ socketPath, timeoutMs: 25 });
  await assert.rejects(client.request("status"), /ipc_timeout/);
  const controller = new AbortController(),
    p = client.request("status", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(p, /aborted/);
});
test("socket with broad permissions is refused before sending hello", async (t) => {
  let called = false;
  const socketPath = await server(t, () => {
    called = true;
  });
  chmodSync(socketPath, 0o666);
  await assert.rejects(
    createIpcClient({ socketPath }).request("status"),
    /unsafe_socket/,
  );
  assert.equal(called, false);
});
