import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore } from "../src/store.mjs";
import { createCustodian } from "../src/transaction.mjs";
const agentId = "agent_" + "a".repeat(32);
function fixture(
  hook,
  run = async () => ({ status: "completed", text: "secret reply" }),
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-test-")));
  const store = openStore({ root, agentId });
  let ack = 0,
    reply = 0;
  const delivery = {
    deliveryId: 1,
    roomId: "room_" + "b".repeat(32),
    eventId: "event_" + "c".repeat(32),
    roomSequence: 1,
  };
  const transport = {
    verify: async () => {},
    list: async () => [delivery],
    claim: async () => ({
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
    inbound: async () => ({ text: "secret inbound", replyRequired: true }),
    findReply: async () => null,
    reply: async () => {
      reply++;
      return { eventId: "event_" + "d".repeat(32) };
    },
    ack: async () => {
      ack++;
    },
  };
  return {
    root,
    store,
    transport,
    counts: () => ({ ack, reply }),
    custodian: createCustodian({
      store,
      transport,
      runner: { run },
      agentId,
      hook,
    }),
  };
}
test("completes without persisting message bodies", async () => {
  const f = fixture();
  await f.custodian.cycle();
  assert.equal(f.store.get(), null);
  assert.deepEqual(f.counts(), { ack: 1, reply: 1 });
  assert.doesNotMatch(
    readFileSync(path.join(f.root, "health.json"), "utf8"),
    /secret/,
  );
});
test("crash executing quarantines on restart without another model", async () => {
  let runs = 0;
  const f = fixture(
    async (phase) => {
      if (phase === "executing") throw Error("crash");
    },
    async () => {
      runs++;
      return { status: "completed", text: "reply" };
    },
  );
  await assert.rejects(f.custodian.cycle());
  assert.equal(f.store.get().phase, "executing");
  await createCustodian({
    ...f,
    runner: {
      run: async () => {
        runs++;
      },
    },
    agentId,
  }).cycle();
  assert.equal(f.store.get().phase, "quarantined");
  assert.equal(runs, 0);
  assert.equal(f.counts().ack, 0);
});
test("lock spans awaited work", async () => {
  const f = fixture();
  let release;
  const p = f.store.withLock(() => new Promise((r) => (release = r)));
  assert.throws(
    () => openStore({ root: f.root, agentId }).withLock(() => {}),
    /locked|using/,
  );
  release();
  await p;
});
test("prepared crash replays stable claim without changing identifiers", async () => {
  const f = fixture(async (p) => {
    if (p === "prepared") throw Error("crash");
  });
  await assert.rejects(f.custodian.cycle());
  const before = f.store.get();
  let claim;
  f.transport.claim = async (r) => {
    claim = r.claimId;
    return { leaseExpiresAt: new Date(Date.now() + 60000).toISOString() };
  };
  await createCustodian({
    ...f,
    runner: { run: async () => ({ status: "completed", text: "x" }) },
    agentId,
  }).cycle();
  assert.equal(claim, before.claimId);
  assert.equal(f.counts().ack, 1);
});
test("lost reply response reconciles durable reply before ACK", async () => {
  const f = fixture();
  f.transport.reply = async () => {
    throw Error("response_lost");
  };
  f.transport.findReply = async () => ({ eventId: "event_" + "d".repeat(32) });
  await f.custodian.cycle();
  assert.equal(f.counts().ack, 1);
});
test("lost ACK response resumes ACK only without runner", async () => {
  let runs = 0;
  const f = fixture(undefined, async () => {
    runs++;
    return { status: "completed", text: "x" };
  });
  f.transport.ack = async () => {
    throw Error("lost_ack");
  };
  await assert.rejects(f.custodian.cycle());
  assert.equal(f.store.get().phase, "replied");
  f.transport.findReply = async () => ({ eventId: "event_" + "d".repeat(32) });
  let ack = 0;
  f.transport.ack = async () => {
    ack++;
  };
  await f.custodian.cycle();
  assert.equal(runs, 1);
  assert.equal(ack, 1);
});
test("receipt-only delivery does not invoke model", async () => {
  const f = fixture(undefined, async () => {
    throw Error("must not run");
  });
  f.transport.inbound = async () => ({ text: "receipt", replyRequired: false });
  await f.custodian.cycle();
  assert.deepEqual(f.counts(), { ack: 1, reply: 0 });
});
test("known runner failure retries with bound and explicit retry releases quarantine", async () => {
  let clock = Date.now(),
    runs = 0;
  const f = fixture(undefined, async () => {
    runs++;
    throw Object.assign(Error("private provider text"), { knownFailure: true });
  });
  const c = createCustodian({
    ...f,
    runner: {
      run: async () => {
        runs++;
        throw Object.assign(Error("private provider text"), {
          knownFailure: true,
        });
      },
    },
    agentId,
    now: () => clock,
  });
  f.transport.claim = async () => ({
    leaseExpiresAt: new Date(clock + 60000).toISOString(),
  });
  for (let i = 0; i < 3; i++) {
    await c.cycle();
    clock += 70000;
  }
  assert.equal(f.store.get().phase, "quarantined");
  assert.equal(runs, 3);
  await c.cycle();
  assert.equal(runs, 3);
  await assert.rejects(c.retry(2));
  await c.retry(1);
  assert.equal(f.store.get().phase, "prepared");
  assert.doesNotMatch(
    readFileSync(path.join(f.root, "transaction.json"), "utf8"),
    /private provider/,
  );
});
test("lease renewal failure aborts model and never replies or ACKs", async (t) => {
  // Admission fsyncs can outlast a tiny real lease under a busy combined suite.
  // Advance only the renewal timer after the model has actually entered.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  let entered;
  const runnerEntered = new Promise((resolve) => {
    entered = resolve;
  });
  let claims = 0,
    aborted = false;
  f.transport.claim = async () => {
    if (++claims > 1) {
      await runnerEntered;
      throw Error("lease_lost");
    }
    return { leaseExpiresAt: new Date(Date.now() + 60000).toISOString() };
  };
  const c = createCustodian({
    ...f,
    agentId,
    runner: {
      run: async (_, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
          entered();
        }),
    },
  });
  const cycle = c.cycle();
  const rejected = assert.rejects(cycle);
  await runnerEntered;
  t.mock.timers.tick(20001);
  await rejected;
  assert.equal(claims, 2);
  assert.equal(aborted, true);
  assert.deepEqual(f.counts(), { ack: 0, reply: 0 });
  assert.equal(f.store.readHealth().state, "ownership_lost");
});
test("paused agent verification prevents claims and execution", async () => {
  const f = fixture();
  let called = false;
  f.transport.verify = async () => {
    throw Error("agent_paused");
  };
  f.transport.claim = async () => {
    called = true;
  };
  await assert.rejects(f.custodian.cycle());
  assert.equal(called, false);
  assert.equal(f.store.get(), null);
});
test("lease expiry aborts even when renewal never responds", async () => {
  const f = fixture();
  let n = 0;
  f.transport.claim = async () => {
    if (++n === 1)
      return { leaseExpiresAt: new Date(Date.now() + 45).toISOString() };
    return new Promise((resolve, reject) =>
      setTimeout(() => reject(Error("renew_timeout")), 75),
    );
  };
  const c = createCustodian({
    ...f,
    agentId,
    runner: { run: async () => new Promise(() => {}) },
  });
  await assert.rejects(c.cycle());
  assert.deepEqual(f.counts(), { reply: 0, ack: 0 });
});
test("conflicting reply history quarantines without acknowledgement", async () => {
  const f = fixture();
  f.transport.reply = async () => {
    throw Error("conflict");
  };
  f.transport.findReply = async () => {
    throw Object.assign(Error("invalid_authority_response"), {
      code: "invalid_authority_response",
    });
  };
  assert.deepEqual(await f.custodian.cycle(), { state: "quarantined" });
  assert.equal(f.store.get().phase, "quarantined");
  assert.equal(f.counts().ack, 0);
});
