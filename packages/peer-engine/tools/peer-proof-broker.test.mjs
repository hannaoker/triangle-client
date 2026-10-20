import test from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPeerProofBroker, parseEnvelope } from "./peer-proof-broker.mjs";
const sender = "a".repeat(64),
  local = "b".repeat(64);
const payload = JSON.stringify({
  protocol: "triangle.peer-proof/1",
  kind: "request",
  request_id: "req-1",
  text: "explain durability",
});
const hash = (s) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const stateRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "peer-broker-")),
  );
  let items = [
      {
        seq: 1,
        message_id: "input-1",
        from_endpoint_id: sender,
        payload,
        payload_hash: hash(payload),
      },
    ],
    runs = 0,
    acks = 0,
    sends = 0,
    outbox = null;
  const ipc = {
    request: async (method, p) => {
      if (method === "inbox")
        return { items, next_after_seq: 1, has_more: false };
      if (method === "send") {
        sends++;
        outbox = {
          message_id: p.message_id,
          peer_endpoint_id: p.peer_addr.id,
          payload_hash: hash(p.payload),
          state: "queued_local",
        };
        return {};
      }
      if (method === "message_status") return outbox;
      if (method === "ack") {
        acks++;
        items = [];
        return { acked: 1, already_acked: 0, unknown: [] };
      }
      throw Error("unexpected");
    },
  };
  const options = {
    stateRoot,
    ipc,
    routes: new Map([[sender, { id: sender, addrs: [] }]]),
    runner: {
      run: async () => {
        runs++;
        return { status: "completed", text: "durable answer" };
      },
    },
  };
  return {
    options,
    ipc,
    counts: () => ({ runs, acks, sends }),
    restore: () => {
      items = [
        {
          seq: 1,
          message_id: "input-1",
          from_endpoint_id: sender,
          payload,
          payload_hash: hash(payload),
        },
      ];
    },
  };
}
test("durable linked reply enters authenticated sender outbox before input ack; duplicate never reruns", async () => {
  const f = fixture(),
    b = createPeerProofBroker(f.options);
  assert.equal((await b.step()).state, "acked");
  f.restore();
  await b.step();
  assert.deepEqual(f.counts(), { runs: 1, acks: 2, sends: 1 });
  b.close();
});
test("crash in inference quarantines after reopen instead of rerunning", async () => {
  const f = fixture();
  f.options.runner = {
    run: async () => {
      throw Error("unknown model outcome");
    },
  };
  let b = createPeerProofBroker(f.options);
  assert.equal((await b.step()).state, "quarantined");
  b.close();
  b = createPeerProofBroker(f.options);
  assert.equal((await b.step()).state, "quarantined");
  assert.equal(f.counts().acks, 0);
  b.close();
});
test("one broker owner excludes another while idle", () => {
  const f = fixture(),
    b = createPeerProofBroker(f.options);
  assert.throws(() => createPeerProofBroker(f.options), /busy/);
  b.close();
});
test("crash after durable result replays same reply without another inference", async () => {
  const f = fixture();
  let b = createPeerProofBroker({
    ...f.options,
    hook: async (phase) => {
      if (phase === "result") throw Error("crash");
    },
  });
  await assert.rejects(b.step());
  assert.equal(b.status()[0].phase, "result");
  b.close();
  b = createPeerProofBroker(f.options);
  await b.step();
  assert.equal(f.counts().runs, 1);
  assert.equal(f.counts().acks, 1);
  b.close();
});
test("crash after executing admission is quarantined on reopen", async () => {
  const f = fixture();
  let b = createPeerProofBroker({
    ...f.options,
    hook: async (phase) => {
      if (phase === "executing") throw Error("crash");
    },
  });
  await assert.rejects(b.step());
  assert.equal(b.status()[0].phase, "executing");
  b.close();
  b = createPeerProofBroker(f.options);
  assert.equal((await b.step()).state, "quarantined");
  assert.equal(f.counts().runs, 0);
  b.close();
});
test("outbox failure never consumes input and persisted reply retries", async () => {
  const f = fixture(),
    request = f.ipc.request;
  let fail = true;
  f.ipc.request = async (method, p) => {
    if (fail && ["send", "message_status"].includes(method))
      throw Error("offline");
    return request(method, p);
  };
  const b = createPeerProofBroker(f.options);
  await assert.rejects(b.step(), /admission_unresolved/);
  assert.equal(f.counts().acks, 0);
  assert.equal(b.status()[0].phase, "result");
  fail = false;
  await b.step();
  assert.equal(f.counts().runs, 1);
  b.close();
});
test("mismatched admitted target or body never permits ack", async () => {
  for (const key of ["peer_endpoint_id", "payload_hash"]) {
    const f = fixture(),
      original = f.ipc.request;
    f.ipc.request = async (method, p) => {
      const r = await original(method, p);
      if (method === "message_status") r[key] = "f".repeat(64);
      return r;
    };
    const b = createPeerProofBroker(f.options);
    await assert.rejects(b.step(), /admission_unverified/);
    assert.equal(f.counts().acks, 0);
    b.close();
  }
});
test("untrusted payload route fields are rejected and typed reply does not start runner", async () => {
  const f = fixture(),
    request = f.ipc.request;
  let kind = "request";
  f.ipc.request = async (method, p) => {
    if (method === "inbox") {
      const envelope =
        kind === "request"
          ? {
              protocol: "triangle.peer-proof/1",
              kind,
              request_id: "req-1",
              text: "x",
              peer_addr: { id: local },
            }
          : {
              protocol: "triangle.peer-proof/1",
              kind,
              request_id: "req-1",
              in_reply_to: "original",
              text: "answer",
            };
      const content = JSON.stringify(envelope);
      return {
        items: [
          {
            seq: 1,
            message_id: "reply-input",
            from_endpoint_id: sender,
            payload: content,
            payload_hash: hash(content),
          },
        ],
      };
    }
    return request(method, p);
  };
  const b = createPeerProofBroker(f.options);
  await assert.rejects(b.step(), /invalid_envelope/);
  kind = "reply";
  assert.equal((await b.step()).state, "reply_received");
  assert.deepEqual(f.counts(), { runs: 0, acks: 1, sends: 0 });
  b.close();
});
test("bounded inference timeout quarantines and aborts runner", async () => {
  const f = fixture();
  let stopped = false;
  f.options.runner = {
    run: async (_, { signal }) =>
      new Promise(() =>
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
          },
          { once: true },
        ),
      ),
  };
  const b = createPeerProofBroker({ ...f.options, runnerTimeoutMs: 5 });
  assert.equal((await b.step()).state, "quarantined");
  assert.equal(stopped, true);
  assert.equal(f.counts().acks, 0);
  b.close();
});
test("lost send response reconciles exact durable admission before ack", async () => {
  const f = fixture(),
    request = f.ipc.request;
  f.ipc.request = async (method, p) => {
    const result = await request(method, p);
    if (method === "send") throw Error("lost_response");
    return result;
  };
  const b = createPeerProofBroker(f.options);
  assert.equal((await b.step()).state, "acked");
  assert.equal(f.counts().runs, 1);
  b.close();
});
test("lost ack response retries persisted reply without repeating inference", async () => {
  const f = fixture(),
    request = f.ipc.request;
  let lost = true;
  f.ipc.request = async (method, p) => {
    const result = await request(method, p);
    if (method === "ack" && lost) {
      lost = false;
      throw Error("lost_ack_response");
    }
    return result;
  };
  const b = createPeerProofBroker(f.options);
  await assert.rejects(b.step(), /lost_ack_response/);
  assert.equal(b.status()[0].phase, "admitted");
  await b.step();
  assert.equal(f.counts().runs, 1);
  assert.equal(b.status()[0].phase, "acked");
  b.close();
});

test("kernel owner lock also excludes another process", async () => {
  const f = fixture(),
    broker = createPeerProofBroker(f.options);
  const code = `import {createPeerProofBroker} from ${JSON.stringify(new URL("./peer-proof-broker.mjs", import.meta.url).href)};try{const b=createPeerProofBroker({stateRoot:${JSON.stringify(f.options.stateRoot)},ipc:{request:async()=>{}},routes:new Map(),runner:{run:async()=>{}}});b.close();process.exit(2)}catch(e){process.exit(e.code==='broker_busy'?0:3)}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: "ignore",
  });
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
  broker.close();
});

test("envelope bounds measure text bytes and allow worst-case JSON escaping", () => {
  const content = JSON.stringify({
    protocol: "triangle.peer-proof/1",
    kind: "request",
    request_id: "bounds",
    text: "\u0001".repeat(32768),
  });
  assert.equal(parseEnvelope(content).text.length, 32768);
  assert.throws(
    () =>
      parseEnvelope(
        JSON.stringify({
          protocol: "triangle.peer-proof/1",
          kind: "request",
          request_id: "bounds",
          text: "x".repeat(32769),
        }),
      ),
    /invalid_envelope/,
  );
});
