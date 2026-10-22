import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLocalMessagingSubsystem } from "../src/local-messaging-supervisor-seam.mjs";
import { createTestMemoryJournal, createTestRecoverableDispatcher } from "./local-messaging-fixtures.mjs";
import { LocalMessagingError } from "../src/local-messaging-errors.mjs";

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

    // 2. admitExecution without mandatory recover hook
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
      client, senderId: "sender", turnCredentialProvider: () => subsystem.issueTurnCredential("sender"),
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
