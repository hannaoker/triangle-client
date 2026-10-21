import net from "node:net";
import path from "node:path";
import { lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { coded, privateDir } from "./private-path.mjs";

export const MAX_REQUEST = 1024 * 1024;
export const MAX_RESPONSE = 2 * 1024 * 1024;

const endpoint = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);

/** Each RPC negotiates hello on a fresh private Unix connection, so retries reconnect safely. */
export function createIpcClient({ socketPath, timeoutMs = 30000 }) {
  if (
    !path.isAbsolute(socketPath) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  ) {
    throw coded("invalid_ipc_options");
  }
  return Object.freeze({
    async request(method, params = {}, { signal } = {}) {
      signal?.throwIfAborted();
      privateDir(path.dirname(socketPath));
      const st = lstatSync(socketPath);
      if (
        !st.isSocket() ||
        st.isSymbolicLink() ||
        st.uid !== process.getuid() ||
        (st.mode & 0o077) !== 0
      ) {
        throw coded("unsafe_socket");
      }
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
        if (buffer.length > MAX_RESPONSE + 4) {
          return stop(coded("ipc_oversized"));
        }
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE(0);
          if (size < 2 || size > MAX_RESPONSE) {
            return stop(coded("ipc_oversized"));
          }
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
          ) {
            return stop(coded("ipc_invalid"));
          }
          const p = pending;
          pending = null;
          if (value.error) {
            const code =
              typeof value.error.code === "string" &&
              /^[a-z_]{1,64}$/.test(value.error.code)
                ? value.error.code
                : "ipc_error";
            p.reject(coded(code));
          } else {
            p.resolve(value.result);
          }
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
        if (hello?.protocol_version !== 1 || !endpoint(hello.endpoint_id)) {
          throw coded("ipc_invalid_hello");
        }
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
