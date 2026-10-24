import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLocalMessagingSubsystem } from "../src/local-messaging-supervisor-seam.mjs";
import { createTestMemoryJournal, createTestRecoverableDispatcher, createTestSqliteJournal, waitFor } from "./local-messaging-fixtures.mjs";
import { LocalMessagingError } from "../src/local-messaging-errors.mjs";
import { createPairExchangeLimiter } from "../src/local-messaging-rate-limiter.mjs";

test("supervisor seam enforces required journal and rejects missing durability adapter", () => {
  const realTmp = fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir());
  const stateRoot = fs.mkdtempSync(path.join(realTmp, "triangle-seam-test-"));
  try {
    assert.throws(
      () => createLocalMessagingSubsystem({ stateRoot }),
      (err) => err instanceof LocalMessagingError && err.code === "journal_required",
    );
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("supervisor seam enforces registry identities and refuses unknown profile issuance", { skip: process.platform === "win32" }, async () => {
  const realTmp = fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir());
  const stateRoot = fs.mkdtempSync(path.join(realTmp, "triangle-seam-test-"));
  fs.chmodSync(stateRoot, 0o700);
  const journal = createTestMemoryJournal();

  const subsystem = createLocalMessagingSubsystem({
    stateRoot,
    journal,
    dispatcher: createTestRecoverableDispatcher({ journal }),
    registry: [
      { profile: "desktop-codex", instanceId: "desktop-codex" },
      { profile: "gravity2", instanceId: "gravity2" },
    ],
    aclRules: {
      "desktop-codex": ["gravity2"],
    },
  });

  try {
    // Known profile: issuance succeeds
    const token = subsystem.issueTurnCredential("desktop-codex");
    assert.ok(typeof token === "string" && token.length > 0);

    // Unknown profile: issuance MUST be refused!
    assert.throws(
      () => subsystem.issueTurnCredential("unknown-impostor"),
      (err) => err instanceof LocalMessagingError && err.code === "unknown_profile",
    );

    // Client creation never gives validators or private key to clients
    const client = subsystem.createClient("desktop-codex");
    assert.equal(typeof client.credentialValidator, "undefined");
    assert.equal(typeof client.secret, "undefined");
    await client.close();
  } finally {
    await subsystem.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("supervisor seam manages lifecycle, admission, and client operations", { skip: process.platform === "win32" }, async () => {
  const realTmp = fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir());
  const stateRoot = fs.mkdtempSync(path.join(realTmp, "triangle-seam-test-"));
  fs.chmodSync(stateRoot, 0o700);
  const journal = createTestMemoryJournal();

  let admitted = null;
  const dispatcher = createTestRecoverableDispatcher({
    journal,
    execute: async (job) => {
      admitted = job;
    },
  });
  const subsystem = createLocalMessagingSubsystem({
    stateRoot,
    journal,
    dispatcher,
    registry: [
      { profile: "desktop-codex", instanceId: "desktop-codex" },
      { profile: "gravity2", instanceId: "gravity2" },
    ],
    aclRules: {
      "desktop-codex": ["gravity2"],
      "gravity2": ["desktop-codex"],
    },
  });

  try {
    assert.equal(subsystem.running, false);
    const initialStatus = subsystem.status();
    assert.equal(initialStatus.route, "same-device");
    assert.equal(initialStatus.running, false);
    assert.deepEqual(initialStatus.registeredProfiles, ["desktop-codex", "gravity2"]);

    await subsystem.start();
    assert.equal(subsystem.running, true);

    const client = subsystem.createClient("desktop-codex");
    const recipients = await client.discoverRecipients();
    assert.deepEqual(recipients, ["gravity2"]);

    const receipt = await client.sendMessage({
      to: "gravity2",
      text: "hello from seam",
      messageId: "msg-seam-1",
    });

    assert.equal(receipt.accepted, true);
    assert.equal(receipt.status, "queued_local");

    // Give microtask tick for async admission
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(admitted?.text, "hello from seam");
    assert.equal(admitted?.sender, "desktop-codex");

    await client.close();
  } finally {
    await subsystem.stop();
    assert.equal(subsystem.running, false);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("supervisor seam requires explicit dispatcher dependency and refuses construction when missing", () => {
  const realTmp = fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir());
  const stateRoot = fs.mkdtempSync(path.join(realTmp, "triangle-seam-test-"));
  const journal = createTestMemoryJournal();

  try {
    // 1. Missing dispatcher completely
    assert.throws(
      () => createLocalMessagingSubsystem({ stateRoot, journal }),
      (err) => err instanceof LocalMessagingError && err.code === "dispatcher_required",
    );

    // 2. A stray admitExecution option is not a dispatcher
    assert.throws(
      () => createLocalMessagingSubsystem({
        stateRoot,
        journal,
        admitExecution: async () => {},
      }),
      (err) => err instanceof LocalMessagingError && err.code === "dispatcher_required",
    );

    // 3. Dispatcher missing dispatch hook
    assert.throws(
      () => createLocalMessagingSubsystem({
        stateRoot,
        journal,
        dispatcher: { start: async () => {}, stop: async () => {} },
      }),
      (err) => err instanceof LocalMessagingError && err.code === "invalid_dispatcher",
    );
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("shutdown retains journal until a pending RPC persistence completes", { skip: process.platform === "win32" }, async () => {
  const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "triangle-close-rpc-"));
  const journal = createTestMemoryJournal();
  const persist = journal.recordSend.bind(journal);
  const releaseJournal = journal.close.bind(journal);
  let releaseWrite;
  let markEntered;
  let journalClosed = false;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const blocked = new Promise(resolve => { releaseWrite = resolve; });
  journal.recordSend = async envelope => {
    markEntered();
    await blocked;
    assert.equal(journalClosed, false);
    return persist(envelope);
  };
  journal.close = async () => { journalClosed = true; await releaseJournal(); };
  const subsystem = createLocalMessagingSubsystem({
    stateRoot, journal, dispatcher: createTestRecoverableDispatcher({ journal }),
    registry: ["sender", "recipient"], aclRules: { sender: ["recipient"] },
  });
  let client;
  let stopping;
  try {
    await subsystem.start();
    client = subsystem.createClient("sender");
    const send = client.sendMessage({to: "recipient", text: "hello", messageId: "blocked-write"}).catch(() => {});
    await entered;
    stopping = subsystem.stop();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(journalClosed, false, "pending persistence must retain journal custody");
    releaseWrite();
    await stopping;
    await send;
    assert.equal(journalClosed, true);
  } finally {
    releaseWrite();
    await stopping?.catch(() => {});
    await client?.close();
    await subsystem.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("failed dispatcher recovery rolls back and permits retry and cleanup", { skip: process.platform === "win32" }, async () => {
  const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "triangle-start-fail-"));
  const journal = createTestMemoryJournal();
  let attempts = 0;
  let stops = 0;
  const subsystem = createLocalMessagingSubsystem({
    stateRoot, journal,
    dispatcher: {
      async start() { if (++attempts === 1) throw new Error("recovery failed"); },
      async stop() { stops++; }, async notifyAdmission() {},
    },
  });
  try {
    await assert.rejects(subsystem.start(), /recovery failed/);
    assert.equal(stops, 1, "failed recovery must release partial dispatcher custody");
    await subsystem.start();
    assert.equal(subsystem.running, true);
    await subsystem.stop();
    assert.equal(stops, 2);
  } finally {
    await subsystem.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("MCP refresh uses the current credential on the real socket", { skip: process.platform === "win32" }, async () => {
  const { createLocalMessagingMcpHandler } = await import("../src/local-messaging-mcp-adapter.mjs");
  const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "triangle-token-roll-"));
  const journal = createTestMemoryJournal();
  const subsystem = createLocalMessagingSubsystem({
    stateRoot, journal, dispatcher: createTestRecoverableDispatcher({ journal }),
    registry: ["sender", "recipient"], aclRules: { sender: ["recipient"] },
  });
  let client;
  try {
    await subsystem.start();
    client = subsystem.createClient("sender", { ttlMs: 500 });
    await new Promise(resolve => setTimeout(resolve, 550));
    const handler = createLocalMessagingMcpHandler({
      client, turnCredentialProvider: () => subsystem.issueTurnCredential("sender"),
    });
    const reply = await handler.handleRequest({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "triangle_list_recipients"}});
    assert.equal(reply.result.isError, false, JSON.stringify(reply));
    assert.deepEqual(JSON.parse(reply.result.content[0].text).recipients, ["recipient"]);
  } finally {
    await client?.close();
    await subsystem.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("completed work is never executed again after a restart, and a retry after the restart is a duplicate", { skip: process.platform === "win32" }, async () => {
  const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "triangle-restart-"));
  fs.chmodSync(stateRoot, 0o700);
  const dbPath = path.join(stateRoot, "journal.sqlite");
  const runs = [];
  async function boot() {
    const journal = createTestSqliteJournal({ dbPath });
    const dispatcher = createTestRecoverableDispatcher({
      journal,
      execute: async (job) => {
        runs.push(job.messageId);
        await journal.recordReply({ sender: job.recipient, recipient: job.sender, messageId: `reply-${job.messageId}`, requestId: job.requestId, inReplyTo: job.messageId, text: "merged" });
      },
    });
    const subsystem = createLocalMessagingSubsystem({ stateRoot, journal, dispatcher, registry: ["desktop-codex", "gravity2"], aclRules: { "desktop-codex": ["gravity2"] } });
    await subsystem.start();
    return { subsystem, journal };
  }
  let booted = await boot();
  try {
    const client = booted.subsystem.createClient("desktop-codex");
    await client.sendMessage({ to: "gravity2", text: "merge PR 42", messageId: "m-1", requestId: "r-1" });
    await waitFor(() => runs.length === 1, { message: "first execution" });
    await waitFor(async () => (await booted.journal.getRecord("m-1")).phase === "completed", { message: "completion is recorded" });
    await client.close();
    await booted.subsystem.stop(); // a clean supervisor restart
    booted = await boot();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(runs, ["m-1"], "recovery must not run finished work again");

    const retryClient = booted.subsystem.createClient("desktop-codex");
    const retry = await retryClient.sendMessage({ to: "gravity2", text: "merge PR 42", messageId: "m-1", requestId: "r-1" });
    assert.equal(retry.isDuplicate, true);
    assert.equal(retry.status, "completed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(runs, ["m-1"]);
    await retryClient.close();
  } finally {
    await booted.subsystem.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("the server never dispatches a duplicate send whose stored phase is not queued_local", { skip: process.platform === "win32" }, async () => {
  const { createLocalMessagingJournal } = await import("../src/local-messaging-journal.mjs");
  const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "triangle-dup-phase-"));
  const journal = createLocalMessagingJournal({ stateRoot });
  const notified = [];
  const subsystem = createLocalMessagingSubsystem({
    stateRoot, journal, registry: ["sender", "recipient"], aclRules: { sender: ["recipient"] },
    dispatcher: { async start() {}, async stop() {}, async notifyAdmission(job) { notified.push(job.messageId); } },
  });
  let client;
  try {
    await subsystem.start();
    client = subsystem.createClient("sender");
    const send = (id) => client.sendMessage({ to: "recipient", text: `work ${id}`, messageId: id, requestId: `req-${id}` });
    for (const id of ["queued", "claimed", "finished", "held"]) assert.equal((await send(id)).isDuplicate, false);
    assert.deepEqual(notified, ["queued", "claimed", "finished", "held"]);
    await journal.claimExecution("claimed");
    await journal.claimExecution("finished");
    await journal.completeExecution("finished");
    await journal.holdExecution("held", "operator_hold");
    notified.length = 0;

    for (const [id, status] of [["claimed", "executing"], ["finished", "completed"], ["held", "held"]]) {
      const duplicate = await send(id);
      assert.equal(duplicate.isDuplicate, true);
      assert.equal(duplicate.status, status);
    }
    assert.deepEqual(notified, [], "work that is claimed, finished or held never reaches the dispatcher again");
    // A duplicate that is still queued may be dispatched again (the dispatcher and claimExecution dedupe it).
    assert.equal((await send("queued")).isDuplicate, true);
    assert.deepEqual(notified, ["queued"]);
  } finally {
    await client?.close();
    await subsystem.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

// Callers that never link their messages (no inReplyTo, no parent in the signed token) restart at depth 1,
// so ping-pong must be bounded by a server-side cap that does not depend on that linking.
async function pingPong(subsystemOptions, { linked }) {
  const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "triangle-pingpong-"));
  fs.chmodSync(stateRoot, 0o700);
  const journal = createTestMemoryJournal();
  const subsystem = createLocalMessagingSubsystem({
    stateRoot, journal, dispatcher: createTestRecoverableDispatcher({ journal }),
    registry: ["desktop-codex", "gravity2"],
    aclRules: { "desktop-codex": ["gravity2"], gravity2: ["desktop-codex"] },
    ...subsystemOptions,
  });
  await subsystem.start();
  const a = subsystem.createClient("desktop-codex");
  const b = subsystem.createClient("gravity2");
  const outcome = { accepted: 0, refused: null };
  try {
    let previous = null;
    for (let i = 0; i < 15; i++) {
      const [from, to] = i % 2 === 0 ? [a, "gravity2"] : [b, "desktop-codex"];
      try {
        await from.sendMessage({ to, text: `round ${i}`, messageId: `${linked ? "ln" : "pp"}-${i}`, ...(linked ? { inReplyTo: previous } : {}) });
        previous = `${linked ? "ln" : "pp"}-${i}`;
        outcome.accepted++;
      } catch (error) {
        outcome.refused = error.code;
        break;
      }
    }
  } finally {
    await a.close();
    await b.close();
    await subsystem.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
  return outcome;
}

test("unlinked ping-pong is bounded by the server-side pair exchange cap", { skip: process.platform === "win32" }, async () => {
  assert.deepEqual(await pingPong({}, { linked: false }), { accepted: 10, refused: "exchange_limit_exceeded" });
  assert.deepEqual(await pingPong({ exchangeLimiter: createPairExchangeLimiter({ maxExchanges: 4 }) }, { linked: false }), { accepted: 4, refused: "exchange_limit_exceeded" }, "the cap is configurable");
});

test("linked ping-pong is still bounded by depth tracking, independent of the pair cap", { skip: process.platform === "win32" }, async () => {
  const depthOnly = { exchangeLimiter: createPairExchangeLimiter({ maxExchanges: 1000 }) };
  assert.deepEqual(await pingPong(depthOnly, { linked: true }), { accepted: 10, refused: "loop_limit_exceeded" });
  // With the default cap the linked chain is bounded too.
  const withDefaults = await pingPong({}, { linked: true });
  assert.equal(withDefaults.accepted, 10);
  assert.ok(["exchange_limit_exceeded", "loop_limit_exceeded"].includes(withDefaults.refused));
});

test("duplicate retries are not exchanges and one-way traffic uses the same pair budget", { skip: process.platform === "win32" }, async () => {
  const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "triangle-pair-dup-"));
  fs.chmodSync(stateRoot, 0o700);
  const journal = createTestMemoryJournal();
  const subsystem = createLocalMessagingSubsystem({
    stateRoot, journal, dispatcher: createTestRecoverableDispatcher({ journal }),
    registry: ["desktop-codex", "gravity2"], aclRules: { "desktop-codex": ["gravity2"] },
    exchangeLimiter: createPairExchangeLimiter({ maxExchanges: 3 }),
  });
  await subsystem.start();
  const client = subsystem.createClient("desktop-codex");
  try {
    const task = { to: "gravity2", text: "task", messageId: "task-1", requestId: "req-task-1" };
    await client.sendMessage(task);
    for (let retry = 0; retry < 6; retry++) {
      assert.equal((await client.sendMessage(task)).isDuplicate, true);
    }
    await client.sendMessage({ to: "gravity2", text: "task 2", messageId: "task-2" });
    await client.sendMessage({ to: "gravity2", text: "task 3", messageId: "task-3" });
    await assert.rejects(client.sendMessage({ to: "gravity2", text: "task 4", messageId: "task-4" }), (err) => err.code === "exchange_limit_exceeded");
    assert.equal(await journal.getRecord("task-4"), null, "a refused message is not admitted");
    // Duplicate retry at full cap MUST succeed
    assert.equal((await client.sendMessage(task)).isDuplicate, true, "duplicate retry succeeds at full cap");
  } finally {
    await client.close();
    await subsystem.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("an empty or missing registry issues no credentials", { skip: process.platform === "win32" }, async () => {
  const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "triangle-empty-registry-"));
  fs.chmodSync(stateRoot, 0o700);
  try {
    for (const registry of [undefined, [], ["  "], [{}]]) {
      const journal = createTestMemoryJournal();
      const subsystem = createLocalMessagingSubsystem({
        stateRoot, journal, dispatcher: createTestRecoverableDispatcher({ journal }),
        ...(registry === undefined ? {} : { registry }),
      });
      assert.throws(() => subsystem.issueTurnCredential("anyone-at-all"), (err) => err instanceof LocalMessagingError && err.code === "unknown_profile");
      assert.throws(() => subsystem.createClient("anyone-at-all"), (err) => err.code === "unknown_profile");
      assert.deepEqual(subsystem.status().registeredProfiles, []);
    }
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("the seam and the fixture dispatcher use one name per hook: start, stop, notifyAdmission", () => {
  const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "triangle-hooks-"));
  const journal = createTestMemoryJournal();
  try {
    const fixture = createTestRecoverableDispatcher({ journal });
    for (const alias of ["recover", "wait", "admitExecution", "dispatch"]) {
      assert.equal(alias in fixture, false, `fixture dispatcher must not expose the ${alias} alias`);
    }
    for (const hook of ["start", "stop", "notifyAdmission"]) assert.equal(typeof fixture[hook], "function");
    const build = (dispatcher) => () => createLocalMessagingSubsystem({ stateRoot, journal, dispatcher });
    assert.doesNotThrow(build(fixture));
    for (const aliasOnly of [
      { recover: async () => {}, wait: async () => {}, admitExecution: async () => {} },
      { recover: async () => {}, wait: async () => {}, dispatch: async () => {} },
      { start: async () => {}, stop: async () => {}, admitExecution: async () => {} },
      { start: async () => {}, wait: async () => {}, notifyAdmission: async () => {} },
      { recover: async () => {}, stop: async () => {}, notifyAdmission: async () => {} },
    ]) {
      assert.throws(build(aliasOnly), (err) => err instanceof LocalMessagingError && err.code === "invalid_dispatcher", JSON.stringify(Object.keys(aliasOnly)));
    }
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("session credentials are issued for session addresses only and leave the profile registry alone", { skip: process.platform === "win32" }, async () => {
  const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(process.platform === "darwin" ? "/private/tmp" : os.tmpdir()), "triangle-session-credential-"));
  fs.chmodSync(stateRoot, 0o700);
  const journal = createTestMemoryJournal();
  const subsystem = createLocalMessagingSubsystem({
    stateRoot, journal, dispatcher: createTestRecoverableDispatcher({ journal }), registry: ["desktop-codex"],
  });
  try {
    const address = `session-${"a".repeat(64)}`;
    const credential = subsystem.issueSessionCredential(address, { sessionId: "pseudonym", generation: 1, bindingId: "child", ttlMs: 30000 });
    const claims = JSON.parse(Buffer.from(credential.split(".")[0], "base64url").toString("utf8"));
    assert.deepEqual([claims.senderId, claims.senderType, claims.generation], [address, "interactive", 1]);

    // Dynamic principals never enter the profile registry, however many come and go.
    for (let i = 0; i < 200; i += 1) subsystem.issueSessionCredential(`session-${i.toString(16).padStart(64, "0")}`);
    assert.deepEqual(subsystem.status().registeredProfiles, ["desktop-codex"]);

    // Only session addresses qualify: a profile or a malformed address is refused, and the ordinary path still wants registration.
    for (const refused of ["desktop-codex", "session-short", `session-${"A".repeat(64)}`, `Session-${"a".repeat(64)}`, 42]) {
      assert.throws(() => subsystem.issueSessionCredential(refused), (err) => err.code === "invalid_sender_id");
    }
    assert.throws(() => subsystem.issueTurnCredential(address), (err) => err instanceof LocalMessagingError && err.code === "unknown_profile");
  } finally {
    await subsystem.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
