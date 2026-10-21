#!/usr/bin/env node
import net from "node:net";
import path from "node:path";
import { chmodSync, mkdirSync, rmSync, writeFileSync, writeSync } from "node:fs";

const stateDir = process.argv[process.argv.indexOf("--state-dir") + 1];
const ipcDir = path.join(stateDir, "ipc");
mkdirSync(ipcDir, { recursive: true, mode: 0o700 });
chmodSync(ipcDir, 0o700);
const sock = path.join(ipcDir, "peer-engine.sock");
rmSync(sock, { force: true });
const endpoint = "c".repeat(64);
let written = 0;
const server = net.createServer((conn) => {
  let buf = Buffer.alloc(0);
  conn.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      const body = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      buf = buf.subarray(4 + len);
      const result = body.method === "hello"
        ? { protocol_version: 1, endpoint_id: endpoint, engine_version: "fake", alpn: "triangle-peer/1" }
        : body.method === "status" ? { endpoint_id: endpoint, written }
        : body.method === "shutdown" ? { shutdown: true } : null;
      const resp = Buffer.from(JSON.stringify({ protocol_version: 1, id: body.id, result }));
      const h = Buffer.alloc(4);
      h.writeUInt32BE(resp.length);
      conn.write(Buffer.concat([h, resp]));
      if (body.method === "shutdown") conn.end();
    }
  });
});
server.listen(sock, () => {
  chmodSync(sock, 0o600);
  process.stderr.write(`peer-engine ready endpoint_id=${endpoint} ipc=${sock}\n`);
  if (process.env.RUST_LOG === "flood") {
    setInterval(() => {
      writeSync(1, `INFO log line ${"x".repeat(4000)}\n`);
      written += 4016;
    }, 25);
  }
});
process.on("SIGINT", () => {
  writeFileSync(path.join(stateDir, "graceful-exit"), "ctrl_c handled\n");
  server.close();
  process.exit(0);
});
