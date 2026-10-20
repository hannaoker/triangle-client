// Isolated proof adapter, not a production roster or MESH integration.
import net from "node:net";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
export const PROTOCOL = "triangle.peer-proof/1";
const MAX_TEXT = 32768,
  MAX_ENVELOPE = MAX_TEXT * 6 + 1024,
  MAX_REQUEST = 1024 * 1024,
  MAX_RESPONSE = 2 * 1024 * 1024;
const digest = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const coded = (code) => Object.assign(Error(code), { code });
const endpoint = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const identifier = (s) =>
  typeof s === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(s);
const text = (s) =>
  typeof s === "string" &&
  s.trim().length > 0 &&
  Buffer.byteLength(s) <= MAX_TEXT;
function ancestors(root) {
  let p = path.parse(root).root;
  for (const part of root.slice(p.length).split(path.sep).filter(Boolean)) {
    p = path.join(p, part);
    const s = lstatSync(p, { throwIfNoEntry: false });
    if (
      s &&
      (s.isSymbolicLink() ||
        !s.isDirectory() ||
        ![0, process.getuid()].includes(s.uid) ||
        (s.mode & 0o022 && !(s.mode & 0o1000 && s.uid === 0)))
    )
      throw coded("unsafe_path");
  }
}
function privateDir(root, { create = false } = {}) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root)
    throw coded("unsafe_path");
  ancestors(root);
  if (create && !existsSync(root))
    mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw coded("unsafe_path");
  const s = lstatSync(root);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o077) !== 0)
    throw coded("unsafe_path");
}
function privateFile(file) {
  const s = lstatSync(file, { throwIfNoEntry: false });
  if (
    s &&
    (!s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      s.uid !== process.getuid() ||
      (s.mode & 0o077) !== 0)
  )
    throw coded("unsafe_path");
}
export function parseEnvelope(payload) {
  if (typeof payload !== "string" || Buffer.byteLength(payload) > MAX_ENVELOPE)
    throw coded("invalid_envelope");
  let e;
  try {
    e = JSON.parse(payload);
  } catch {
    throw coded("invalid_envelope");
  }
  if (
    !e ||
    Array.isArray(e) ||
    e.protocol !== PROTOCOL ||
    !identifier(e.request_id) ||
    !text(e.text)
  )
    throw coded("invalid_envelope");
  const keys =
    e.kind === "request"
      ? ["protocol", "kind", "request_id", "text"]
      : e.kind === "reply"
        ? ["protocol", "kind", "request_id", "in_reply_to", "text"]
        : [];
  if (
    Object.keys(e).sort().join() !== keys.sort().join() ||
    (e.kind === "reply" && !identifier(e.in_reply_to))
  )
    throw coded("invalid_envelope");
  return e;
}
export function deriveReplyId(sender, messageId) {
  if (!endpoint(sender) || !identifier(messageId))
    throw coded("invalid_identity");
  return (
    "peer-reply-" +
    digest(`triangle-peer-proof-reply-v1\0${sender}\0${messageId}`)
  );
}
/** Each RPC negotiates hello on a fresh private Unix connection, so retries reconnect safely. */
export function createIpcClient({ socketPath, timeoutMs = 30000 }) {
  if (
    !path.isAbsolute(socketPath) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw coded("invalid_ipc_options");
  return Object.freeze({
    async request(method, params = {}, { signal } = {}) {
      signal?.throwIfAborted();
      privateDir(path.dirname(socketPath));
      const st = lstatSync(socketPath);
      if (
        !st.isSocket() ||
        st.isSymbolicLink() ||
        st.uid !== process.getuid() ||
        st.mode & 0o077
      )
        throw coded("unsafe_socket");
      const socket = net.createConnection({ path: socketPath });
      let buffer = Buffer.alloc(0),
        pending = null,
        fatal = null;
      const stop = (error) => {
        fatal ??= error;
        pending?.reject(fatal);
        pending = null;
        socket.destroy();
      };
      const timer = setTimeout(() => stop(coded("ipc_timeout")), timeoutMs);
      const abort = () => stop(coded("aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      socket.on("error", () => stop(coded("ipc_disconnected")));
      socket.on("close", () => {
        if (pending) stop(coded("ipc_disconnected"));
      });
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_RESPONSE + 4)
          return stop(coded("ipc_oversized"));
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE(0);
          if (size < 2 || size > MAX_RESPONSE)
            return stop(coded("ipc_oversized"));
          if (buffer.length < 4 + size) return;
          let value;
          try {
            value = JSON.parse(buffer.subarray(4, 4 + size).toString("utf8"));
          } catch {
            return stop(coded("ipc_invalid"));
          }
          buffer = buffer.subarray(4 + size);
          if (
            !pending ||
            value.protocol_version !== 1 ||
            value.id !== pending.id ||
            (!Object.hasOwn(value, "result") && !value.error) ||
            (value.error && Object.hasOwn(value, "result"))
          )
            return stop(coded("ipc_invalid"));
          const p = pending;
          pending = null;
          if (value.error) {
            const code =
              typeof value.error.code === "string" &&
              /^[a-z_]{1,64}$/.test(value.error.code)
                ? value.error.code
                : "ipc_error";
            p.reject(coded(code));
          } else p.resolve(value.result);
        }
      });
      const call = (name, args) =>
        new Promise((resolve, reject) => {
          if (fatal) return reject(fatal);
          const id = randomUUID(),
            body = Buffer.from(
              JSON.stringify({
                protocol_version: 1,
                id,
                method: name,
                params: args,
              }),
            );
          if (body.length > MAX_REQUEST) return reject(coded("ipc_oversized"));
          pending = { id, resolve, reject };
          const header = Buffer.alloc(4);
          header.writeUInt32BE(body.length);
          socket.write(Buffer.concat([header, body]));
        });
      try {
        const hello = await call("hello", {});
        if (hello?.protocol_version !== 1 || !endpoint(hello.endpoint_id))
          throw coded("ipc_invalid_hello");
        signal?.throwIfAborted();
        return await call(method, params);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
      }
    },
  });
}
const held = new Set();
/** Durable per authenticated-sender/message custody. The owner lock spans idle periods. */
export function createPeerProofBroker({
  stateRoot,
  ipc,
  routes,
  runner,
  now = Date.now,
  hook,
  runnerTimeoutMs = 180000,
}) {
  if (
    !Number.isSafeInteger(runnerTimeoutMs) ||
    runnerTimeoutMs < 1 ||
    runnerTimeoutMs > 600000 ||
    typeof ipc?.request !== "function" ||
    typeof runner?.run !== "function"
  )
    throw coded("invalid_broker_options");
  privateDir(stateRoot, { create: true });
  if (held.has(stateRoot)) throw coded("broker_busy");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  for (const name of ["owner.sqlite-journal", "broker.sqlite-journal"])
    privateFile(path.join(stateRoot, name));
  for (const name of ["owner.sqlite", "broker.sqlite"]) {
    const file = path.join(stateRoot, name);
    privateFile(file);
    if (!existsSync(file)) {
      closeSync(openSync(file, "wx", 0o600));
      const fd = openSync(stateRoot, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  const lock = new DatabaseSync(path.join(stateRoot, "owner.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw coded("broker_busy");
  }
  held.add(stateRoot);
  let db;
  try {
    db = new DatabaseSync(path.join(stateRoot, "broker.sqlite"));
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records(sender TEXT NOT NULL,message_id TEXT NOT NULL,input_hash TEXT NOT NULL,phase TEXT NOT NULL,reply_id TEXT,reply_payload TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(sender,message_id));",
    );
    chmodSync(path.join(stateRoot, "broker.sqlite"), 0o600);
    // Executing survived process death, so its inference outcome is unknown.
    db.prepare(
      "UPDATE records SET phase='quarantined',updated_at=? WHERE phase='executing'",
    ).run(now());
  } catch (error) {
    held.delete(stateRoot);
    try {
      db?.close();
    } catch {}
    try {
      lock.exec("ROLLBACK");
      lock.close();
    } catch {}
    throw coded("journal_unavailable");
  }
  let active = false,
    closed = false;
  const row = (sender, id) =>
    db
      .prepare("SELECT * FROM records WHERE sender=? AND message_id=?")
      .get(sender, id);
  const phase = (r, p) =>
    db
      .prepare(
        "UPDATE records SET phase=?,updated_at=? WHERE sender=? AND message_id=?",
      )
      .run(p, now(), r.sender, r.message_id);
  const ack = async (r, signal) => {
    const result = await ipc.request(
      "ack",
      { items: [{ from_endpoint_id: r.sender, message_id: r.message_id }] },
      { signal },
    );
    if (
      !result ||
      !Number.isSafeInteger(result.acked) ||
      !Number.isSafeInteger(result.already_acked) ||
      result.acked + result.already_acked !== 1 ||
      !Array.isArray(result.unknown) ||
      result.unknown.length
    )
      throw coded("unverified_ack");
    phase(r, "acked");
    return { state: "acked", messageId: r.message_id, replyId: r.reply_id };
  };
  async function deliver(r, signal) {
    const route =
      routes instanceof Map ? routes.get(r.sender) : routes?.[r.sender];
    if (!route || route.id !== r.sender) throw coded("route_unavailable");
    let sentError;
    try {
      await ipc.request(
        "send",
        { message_id: r.reply_id, payload: r.reply_payload, peer_addr: route },
        { signal },
      );
    } catch (error) {
      sentError = error;
    }
    signal?.throwIfAborted();
    let status;
    try {
      status = await ipc.request(
        "message_status",
        { message_id: r.reply_id },
        { signal },
      );
    } catch {
      throw coded(
        sentError?.code === "outbox_full"
          ? "outbox_full"
          : "admission_unresolved",
      );
    }
    if (
      status?.message_id !== r.reply_id ||
      status.peer_endpoint_id !== r.sender ||
      status.payload_hash !== digest(r.reply_payload) ||
      !["queued_local", "settled"].includes(status.state)
    )
      throw coded("admission_unverified");
    phase(r, "admitted");
    await hook?.("admitted");
    return ack(r, signal);
  }
  const api = {
    async step({ signal } = {}) {
      if (closed) throw coded("broker_closed");
      if (active) throw coded("broker_busy");
      active = true;
      try {
        signal?.throwIfAborted();
        // Recover persisted replies before consuming further inputs.
        const outstanding = db
          .prepare(
            "SELECT * FROM records WHERE phase IN ('result','admitted') ORDER BY updated_at LIMIT 1",
          )
          .get();
        if (outstanding) return await deliver(outstanding, signal);
        const page = await ipc.request(
          "inbox",
          { after_seq: 0, limit: 1 },
          { signal },
        );
        if (!page || !Array.isArray(page.items) || page.items.length > 1)
          throw coded("invalid_inbox");
        if (!page.items.length) return { state: "idle" };
        const item = page.items[0];
        if (
          !endpoint(item.from_endpoint_id) ||
          !identifier(item.message_id) ||
          typeof item.payload !== "string" ||
          Buffer.byteLength(item.payload) > MAX_ENVELOPE ||
          item.payload_hash !== digest(item.payload)
        )
          throw coded("invalid_inbox");
        const input = parseEnvelope(item.payload);
        let r = row(item.from_endpoint_id, item.message_id);
        if (r && r.input_hash !== item.payload_hash)
          throw coded("input_conflict");
        if (r) {
          if (r.phase === "quarantined")
            return { state: "quarantined", messageId: r.message_id };
          if (r.phase === "acked") return await ack(r, signal);
          if (r.phase === "received_reply") {
            await ack(r, signal);
            return {
              state: "reply_received",
              fromEndpointId: r.sender,
              messageId: r.message_id,
              envelope: parseEnvelope(r.reply_payload),
            };
          }
          return await deliver(r, signal);
        }
        if (db.prepare("SELECT count(*) AS n FROM records").get().n >= 10000)
          throw coded("journal_full");
        if (input.kind === "reply") {
          db.prepare(
            "INSERT INTO records(sender,message_id,input_hash,phase,reply_payload,updated_at) VALUES(?,?,?,?,?,?)",
          ).run(
            item.from_endpoint_id,
            item.message_id,
            item.payload_hash,
            "received_reply",
            item.payload,
            now(),
          );
          r = row(item.from_endpoint_id, item.message_id);
          await ack(r, signal);
          return {
            state: "reply_received",
            fromEndpointId: r.sender,
            messageId: r.message_id,
            envelope: input,
          };
        }
        const route =
          routes instanceof Map
            ? routes.get(item.from_endpoint_id)
            : routes?.[item.from_endpoint_id];
        if (!route || route.id !== item.from_endpoint_id)
          throw coded("route_unavailable");
        db.prepare(
          "INSERT INTO records(sender,message_id,input_hash,phase,updated_at) VALUES(?,?,?,?,?)",
        ).run(
          item.from_endpoint_id,
          item.message_id,
          item.payload_hash,
          "executing",
          now(),
        );
        r = row(item.from_endpoint_id, item.message_id);
        await hook?.("executing");
        let result, timeout;
        const cancellation = new AbortController();
        const runnerSignal = signal
          ? AbortSignal.any([signal, cancellation.signal])
          : cancellation.signal;
        let onAbort;
        try {
          runnerSignal.throwIfAborted();
          const interrupted = new Promise((resolve, reject) => {
            onAbort = () => reject(coded("runner_interrupted"));
            runnerSignal.addEventListener("abort", onAbort, { once: true });
          });
          timeout = setTimeout(() => cancellation.abort(), runnerTimeoutMs);
          result = await Promise.race([
            runner.run(
              {
                requestId: input.request_id,
                messageId: item.message_id,
                fromEndpointId: item.from_endpoint_id,
                text: input.text,
              },
              { signal: runnerSignal },
            ),
            interrupted,
          ]);
          runnerSignal.throwIfAborted();
          if (result?.status !== "completed" || !text(result.text))
            throw coded("invalid_runner_result");
        } catch {
          phase(r, "quarantined");
          return { state: "quarantined", messageId: r.message_id };
        } finally {
          clearTimeout(timeout);
          if (onAbort) runnerSignal.removeEventListener("abort", onAbort);
          cancellation.abort();
        }
        const replyId = deriveReplyId(r.sender, r.message_id),
          replyPayload = JSON.stringify({
            protocol: PROTOCOL,
            kind: "reply",
            request_id: input.request_id,
            in_reply_to: r.message_id,
            text: result.text,
          });
        db.prepare(
          "UPDATE records SET phase='result',reply_id=?,reply_payload=?,updated_at=? WHERE sender=? AND message_id=?",
        ).run(replyId, replyPayload, now(), r.sender, r.message_id);
        await hook?.("result");
        return await deliver(row(r.sender, r.message_id), signal);
      } finally {
        active = false;
      }
    },
    status() {
      if (closed) throw coded("broker_closed");
      return db
        .prepare(
          "SELECT sender,message_id,phase,reply_id,updated_at FROM records ORDER BY updated_at",
        )
        .all();
    },
    close() {
      if (active) throw coded("broker_busy");
      if (closed) return;
      closed = true;
      db.close();
      lock.exec("ROLLBACK");
      lock.close();
      held.delete(stateRoot);
    },
  };
  return Object.freeze(api);
}
