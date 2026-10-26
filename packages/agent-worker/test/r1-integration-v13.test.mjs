import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { createLocalControlServer, createRouterStatCache } from "../src/local-messaging-server.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import {
  createTurnCapabilityIssuer,
  createTurnCapabilityValidator,
} from "../src/local-messaging-credentials.mjs";
import {
  createPerSenderRateLimiter,
  createConversationLoopTracker,
  createPairExchangeLimiter,
} from "../src/local-messaging-rate-limiter.mjs";
import { LocalMessagingError } from "../src/local-messaging-errors.mjs";
import { setupRouter } from "../src/local-messaging-cli.mjs";
import {
  updateIdentityRegistry,
  LOCAL_PROFILE_BINDING_SCHEMA,
} from "../src/identity-registry.mjs";
import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { MAX_PAYLOAD_BYTES } from "../src/local-messaging-protocol.mjs";

function makeFixture() {
  const realTmp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(realTmp, "r1-v13-test-"));
  fs.chmodSync(root, 0o700);

  const stateRoot = path.join(root, "state");
  fs.mkdirSync(stateRoot, { mode: 0o700 });

  const identityRoot = path.join(stateRoot, "identity");
  fs.mkdirSync(identityRoot, { mode: 0o700 });

  const socketPath = path.join(stateRoot, "local-control.sock");
  const secret = "test-secret-32-bytes-long-1234567890";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });

  return { root, stateRoot, identityRoot, socketPath, secret, issuer, validator };
}

async function cleanupFixture(f, server = null, client = null, journal = null) {
  if (client) {
    try { await client.close(); } catch {}
  }
  if (server) {
    try { await server.close(); } catch {}
  }
  if (journal) {
    try { journal.close(); } catch {}
  }
  try {
    fs.rmSync(f.root, { recursive: true, force: true });
  } catch {}
}

function loadBaselineV12JournalModule() {
  const realTmp = fs.realpathSync(os.tmpdir());
  const v12Dir = fs.mkdtempSync(path.join(realTmp, "triangle-v12-baseline-"));
  const srcDir = path.resolve(import.meta.dirname, "../src");
  for (const file of fs.readdirSync(srcDir)) {
    if (file.endsWith(".mjs") && file !== "local-messaging-journal.mjs") {
      fs.copyFileSync(path.join(srcDir, file), path.join(v12Dir, file));
    }
  }
  const root = path.resolve(import.meta.dirname, "../../..");
  const v12Src = execSync("git show 2e07404:packages/agent-worker/src/local-messaging-journal.mjs", {
    cwd: root,
    encoding: "utf8",
  });
  fs.writeFileSync(path.join(v12Dir, "local-messaging-journal.mjs"), v12Src);
  const modUrl = pathToFileURL(path.join(v12Dir, "local-messaging-journal.mjs")).href;
  return {
    v12Dir,
    importModule: async () => import(modUrl),
    cleanup: () => fs.rmSync(v12Dir, { recursive: true, force: true }),
  };
}

const HEX_A = "a".repeat(64);
const INSTANCE_BOB = deriveClientInstanceId("bob");
const INSTANCE_CHARLIE = deriveClientInstanceId("charlie");

function makeValidBinding(profileName, overrides = {}) {
  const instanceId = deriveClientInstanceId(profileName);
  const hex32 = (str) => crypto.createHash("sha256").update(str).digest("hex").slice(0, 32);
  return {
    schema: LOCAL_PROFILE_BINDING_SCHEMA,
    binding_id: `bind_${hex32(`bind:${profileName}`)}`,
    trust_mode: "mesh-managed",
    principal_id: `agent_${hex32(`agent:${profileName}`)}`,
    profile_name: profileName,
    profile_instance_id: instanceId,
    authority_origin: "https://thetriangle.dev",
    binding_generation: 1,
    issued_at: "2026-10-25T10:00:00.000Z",
    revoked_at: null,
    proof: {
      kind: "disk_observation",
      observed_on_disk: true,
      verified_live_authority: false,
    },
    ...overrides,
  };
}

function initRegistry(root) {
  return updateIdentityRegistry({
    root,
    expectedSequence: 0,
    action: "init",
    subject: null,
    mutate: (reg) => reg,
  });
}

function bindProfile(root, profileName, seq = 1, overrides = {}) {
  const binding = makeValidBinding(profileName, overrides);
  updateIdentityRegistry({
    root,
    expectedSequence: seq,
    action: "bind",
    subject: binding.profile_instance_id,
    mutate: (reg) => {
      reg.bindings[binding.profile_instance_id] = binding;
      return reg;
    },
  });
  return binding;
}

test("Real baseline v12 journal module compatibility both ways with restart and work preservation", async () => {
  const f = makeFixture();
  const loader = loadBaselineV12JournalModule();
  let j12 = null;
  let j13 = null;
  try {
    const { createLocalMessagingJournal: createLocalMessagingJournalV12 } = await loader.importModule();

    // ==============================================================
    // PART 1: v12 DB -> v13 migration -> v12 rollback -> v13 re-open
    // ==============================================================

    // 1. v12 creates fresh journal and schema
    j12 = createLocalMessagingJournalV12({ stateRoot: f.stateRoot });

    // 1.1 Write standard runner message
    const msg12Standard = await j12.recordSend({
      sender: "sender-v12",
      recipient: "recip-v12",
      messageId: "msg-v12-std-1",
      requestId: "req-v12-std-1",
      text: "hello from baseline v12",
      metadata: { env: "v12" },
    });
    assert.ok(msg12Standard);

    // 1.2 Write interactive unconsumed inbox message
    const msg12Inbox = await j12.recordSend({
      sender: "sender-v12",
      recipient: "recip-interactive",
      recipientType: "interactive",
      messageId: "msg-v12-inbox-1",
      requestId: "req-v12-inbox-1",
      text: "inbox message from baseline v12",
      metadata: {},
    });
    assert.ok(msg12Inbox);

    // 1.3 Write interactive message and record unconsumed reply
    await j12.recordSend({
      sender: "sender-for-reply",
      recipient: "recip-for-reply",
      recipientType: "interactive",
      messageId: "msg-for-reply-1",
      requestId: "req-for-reply-1",
      text: "interactive prompt",
    });
    const claimRes = await j12.claimInboxMessage({
      messageId: "msg-for-reply-1",
      requester: "recip-for-reply",
      sessionId: "session-12",
      generation: 1,
      claimId: "claim-op-12",
    });
    assert.ok(claimRes);
    const replyRes = await j12.recordInteractiveReply({
      messageId: "msg-for-reply-1",
      claimToken: claimRes.claimToken,
      sessionId: "session-12",
      generation: 1,
      requester: "recip-for-reply",
      text: "unconsumed reply from v12",
      replyId: "reply-v12-001",
    });
    assert.ok(replyRes);

    // 1.4 Write regular message and transition to executing (uncertain work simulation)
    await j12.recordSend({
      sender: "sender-v12",
      recipient: "recip-v12-runner",
      messageId: "msg-v12-executing-1",
      requestId: "req-v12-executing-1",
      text: "in flight work",
    });
    const claimExec = await j12.claimExecution("msg-v12-executing-1");
    assert.ok(claimExec);
    assert.equal(claimExec.phase, "executing");

    await j12.close();
    j12 = null;

    // 2. v13 opens migrated database
    j13 = createLocalMessagingJournal({ stateRoot: f.stateRoot });

    // 2.1 Startup recovery: in-flight executing message moved to held with crash_recovery
    const work = await j13.recoverQueued();
    assert.ok(work.uncertain.some((u) => u.messageId === "msg-v12-executing-1" && u.phase === "held" && u.reason === "crash_recovery"));

    // 2.2 Unconsumed inbox message preserved
    const inbox13 = await j13.listInbox({ requester: "recip-interactive" });
    assert.equal(inbox13.items.length, 1);
    assert.equal(inbox13.items[0].messageId, "msg-v12-inbox-1");
    assert.equal(inbox13.items[0].to_principal, null);
    assert.equal(inbox13.items[0].resolved_via, null);

    // 2.3 Unconsumed reply preserved
    const replies13 = await j13.listReplies({ requester: "sender-for-reply" });
    assert.equal(replies13.length, 1);
    assert.equal(replies13[0].messageId, "reply-v12-001");
    assert.equal(replies13[0].consumed, false);

    // 2.4 Existing message readable with safe legacy nulls
    const stdRow13 = await j13.getRecord("msg-v12-std-1");
    assert.equal(stdRow13.messageId, "msg-v12-std-1");
    assert.equal(stdRow13.to_principal, null);
    assert.equal(stdRow13.resolved_via, null);

    // 2.5 v13 writes new messages (both principal and ID)
    const v13PrincipalMsg = await j13.recordSend({
      sender: "sender-v13",
      recipient: "recip-v13",
      messageId: "msg-v13-principal-1",
      requestId: "req-v13-p-1",
      text: "v13 principal message",
      to_principal: "agent_11111111111111111111111111111111",
      resolved_via: "principal",
    });
    assert.equal(v13PrincipalMsg.to_principal, "agent_11111111111111111111111111111111");

    const v13IdMsg = await j13.recordSend({
      sender: "sender-v13",
      recipient: "recip-v13",
      messageId: "msg-v13-id-1",
      requestId: "req-v13-id-1",
      text: "v13 id message",
      to_principal: null,
      resolved_via: "id",
    });
    assert.equal(v13IdMsg.to_principal, null);
    assert.equal(v13IdMsg.resolved_via, "id");

    await j13.close();
    j13 = null;

    // 3. v12 re-opens migrated database (Rollback simulation)
    j12 = createLocalMessagingJournalV12({ stateRoot: f.stateRoot });

    // 3.1 v12 recovers execution work without error
    const workRollback = await j12.recoverQueued();
    assert.ok(Array.isArray(workRollback.toRun));

    // 3.2 v12 reads v13-created rows seamlessly
    const readPFromV12 = await j12.getRecord("msg-v13-principal-1");
    assert.ok(readPFromV12);
    assert.equal(readPFromV12.messageId, "msg-v13-principal-1");
    assert.equal(readPFromV12.text, "v13 principal message");

    // 3.3 v12 writes a new row into the migrated v13 DB
    const rollbackWrite = await j12.recordSend({
      sender: "sender-v12-rollback",
      recipient: "recip-v12-rollback",
      messageId: "msg-v12-rollback-1",
      requestId: "req-v12-rollback-1",
      text: "written by rolled-back v12",
    });
    assert.ok(rollbackWrite);

    // 3.4 v12 consumes previously unconsumed reply
    const consumeRes = await j12.consumeReply({
      requester: "sender-for-reply",
      messageId: "reply-v12-001",
    });
    assert.equal(consumeRes.consumed, true);

    await j12.close();
    j12 = null;

    // 4. v13 re-opens again and verifies state
    j13 = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    const rollbackRowInV13 = await j13.getRecord("msg-v12-rollback-1");
    assert.ok(rollbackRowInV13);
    assert.equal(rollbackRowInV13.to_principal, null);
    assert.equal(rollbackRowInV13.resolved_via, null);

    const consumedReplies = await j13.listReplies({ requester: "sender-for-reply" });
    assert.equal(consumedReplies.length, 0); // Consumed reply no longer listed

    await j13.close();
    j13 = null;

    // ==============================================================
    // PART 2: Fresh v13 DB -> v12 open -> v13 re-open (reverse)
    // ==============================================================
    const fRev = makeFixture();
    try {
      j13 = createLocalMessagingJournal({ stateRoot: fRev.stateRoot });
      await j13.recordSend({
        sender: "sender-rev-13",
        recipient: "recip-rev-13",
        messageId: "msg-rev-13-1",
        requestId: "req-rev-13-1",
        text: "rev message 1",
        to_principal: "agent_22222222222222222222222222222222",
        resolved_via: "principal",
      });
      await j13.recordSend({
        sender: "sender-rev-13",
        recipient: "recip-rev-inbox",
        recipientType: "interactive",
        messageId: "msg-rev-inbox-1",
        requestId: "req-rev-inbox-1",
        text: "rev interactive inbox",
      });
      await j13.close();
      j13 = null;

      // Baseline v12 opens the fresh v13 database
      j12 = createLocalMessagingJournalV12({ stateRoot: fRev.stateRoot });
      const revRead13 = await j12.getRecord("msg-rev-13-1");
      assert.ok(revRead13);
      assert.equal(revRead13.text, "rev message 1");

      const revInbox12 = await j12.listInbox({ requester: "recip-rev-inbox" });
      assert.equal(revInbox12.items.length, 1);
      assert.equal(revInbox12.items[0].messageId, "msg-rev-inbox-1");

      // v12 writes into fresh v13 schema DB
      await j12.recordSend({
        sender: "sender-rev-12",
        recipient: "recip-rev-12",
        messageId: "msg-rev-12-1",
        requestId: "req-rev-12-1",
        text: "rev message from v12",
      });
      await j12.close();
      j12 = null;

      // v13 re-opens and verifies intents preserved
      j13 = createLocalMessagingJournal({ stateRoot: fRev.stateRoot });
      const revP = await j13.getRecord("msg-rev-13-1");
      assert.equal(revP.to_principal, "agent_22222222222222222222222222222222");
      assert.equal(revP.resolved_via, "principal");

      const rev12Row = await j13.getRecord("msg-rev-12-1");
      assert.equal(rev12Row.to_principal, null);
      assert.equal(rev12Row.resolved_via, null);
      await j13.close();
      j13 = null;
    } finally {
      if (j12) await j12.close?.();
      if (j13) await j13.close?.();
      fs.rmSync(fRev.root, { recursive: true, force: true });
    }
  } finally {
    if (j12) await j12.close?.();
    if (j13) await j13.close?.();
    loader.cleanup();
    await cleanupFixture(f);
  }
});

test("v12 / v13 raw schema SQL column interop", async () => {
  const f = makeFixture();
  let j13 = null;
  try {
    const journalDbPath = path.join(f.stateRoot, "local-messaging.sqlite");

    // 1. Create a pure v12 schema SQLite database (prior to R1.4, no to_principal, resolved_via)
    const db12 = new DatabaseSync(journalDbPath);
    db12.exec(`
      CREATE TABLE local_messages (
        message_id TEXT NOT NULL PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        request_id TEXT NOT NULL,
        in_reply_to TEXT,
        text TEXT NOT NULL,
        metadata_json TEXT,
        canonical_hash TEXT NOT NULL,
        phase TEXT NOT NULL,
        reason TEXT,
        runtime_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Insert a v12 row
    db12.prepare(`
      INSERT INTO local_messages (
        message_id, sender, recipient, request_id, in_reply_to, text,
        metadata_json, canonical_hash, phase, reason, runtime_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "msg-v12-001", "sender-v12", "recip-v12", "req-v12-001", null, "hello from v12",
      "{}", "hash-001", "queued_local", null, null, 1000, 1000
    );
    db12.close();
    fs.chmodSync(journalDbPath, 0o600);

    // 2. Open with v13 createLocalMessagingJournal -> safe presence migration adds nullable columns
    j13 = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    const rowOld = await j13.getRecord("msg-v12-001");
    assert.ok(rowOld);
    assert.equal(rowOld.messageId, "msg-v12-001");
    assert.equal(rowOld.to_principal, null);
    assert.equal(rowOld.resolved_via, null);

    // Write a v13 row with to_principal and resolved_via
    const rec13 = await j13.recordSend({
      sender: "sender-v13",
      recipient: "recip-v13",
      messageId: "msg-v13-002",
      requestId: "req-v13-002",
      text: "hello from v13",
      metadata: {},
      to_principal: "agent_0123456789abcdef0123456789abcdef",
      resolved_via: "registry",
    });
    assert.equal(rec13.to_principal, "agent_0123456789abcdef0123456789abcdef");
    assert.equal(rec13.resolved_via, "registry");

    const rowNew = await j13.getRecord("msg-v13-002");
    assert.equal(rowNew.to_principal, "agent_0123456789abcdef0123456789abcdef");
    assert.equal(rowNew.resolved_via, "registry");
    j13.close();
    j13 = null;

    // 3. Open with a raw DB simulating a v12 reader (selecting v12 columns)
    const dbSim12 = new DatabaseSync(journalDbPath);
    const readSim12 = dbSim12.prepare(`
      SELECT message_id, request_id, sender, recipient, text
      FROM local_messages WHERE message_id = ?
    `).get("msg-v13-002");
    assert.ok(readSim12);
    assert.equal(readSim12.message_id, "msg-v13-002");
    assert.equal(readSim12.recipient, "recip-v13");
    assert.equal(readSim12.text, "hello from v13");

    // Write another row simulating v12 (inserting without naming to_principal / resolved_via)
    dbSim12.prepare(`
      INSERT INTO local_messages (
        message_id, sender, recipient, request_id, in_reply_to, text,
        metadata_json, canonical_hash, phase, reason, runtime_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "msg-v12-003", "sender-v12", "recip-v12", "req-v12-003", null, "legacy write",
      "{}", "hash-003", "queued_local", null, null, 3000, 3000
    );
    dbSim12.close();
    fs.chmodSync(journalDbPath, 0o600);

    // 4. Read back with v13 journal
    const j13Again = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    const row3 = await j13Again.getRecord("msg-v12-003");
    assert.ok(row3);
    assert.equal(row3.to_principal, null);
    assert.equal(row3.resolved_via, null);
    j13Again.close();
  } finally {
    await cleanupFixture(f, null, null, j13);
  }
});

test("setupRouter CLI commands, private file safety, schema validation, and atomic writes", async () => {
  const f = makeFixture();
  try {
    const configPath = path.join(f.stateRoot, "router.json");

    // Enable router
    setupRouter({ enable: true, stateRoot: f.stateRoot });
    assert.ok(fs.existsSync(configPath));
    const stat = fs.statSync(configPath);
    assert.equal(stat.mode & 0o777, 0o600);
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(cfg.version, 1);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.registryRoot, undefined);

    // Disable router
    setupRouter({ disable: true, stateRoot: f.stateRoot });
    const cfg2 = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(cfg2.version, 1);
    assert.equal(cfg2.enabled, false);

    // Enable with explicit registryRoot
    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });
    const cfg3 = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(cfg3.version, 1);
    assert.equal(cfg3.enabled, true);
    assert.equal(cfg3.registryRoot, f.identityRoot);

    // CLI refuses relative registryRoot
    assert.throws(
      () => setupRouter({ enable: true, registryRoot: "relative/path", stateRoot: f.stateRoot }),
      /registryRoot must be an absolute path/,
    );
  } finally {
    await cleanupFixture(f);
  }
});

test("Server wiring: kill switch, invalid config diagnostics, per-request statcache reload", async () => {
  const f = makeFixture();
  let server = null;
  let client = null;
  let journal = null;
  try {
    journal = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB] } });
    const dispatcher = { start() {}, stop() {}, notifyAdmission() {} };
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 10, windowMs: 5000, journal });

    // Populate identity registry with bob -> INSTANCE_BOB
    initRegistry(f.identityRoot);
    const bobBinding = bindProfile(f.identityRoot, "bob", 1);
    const bobPrincipal = bobBinding.principal_id;

    server = createLocalControlServer({
      socketPath: f.socketPath,
      journal,
      acl,
      credentialValidator: f.validator,
      dispatcher,
      statusProvider: async () => ({ ok: true, version: 1 }),
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: f.stateRoot,
      recipientDirectory: [
        { id: INSTANCE_BOB, label: "bob", kind: "worker" },
      ],
    });
    await server.start();

    const tokenA = f.issuer.issue({ senderId: HEX_A });
    client = createLocalControlClient({
      socketPath: f.socketPath,
      senderId: HEX_A,
      turnCredential: tokenA,
    });

    // 1. Initial state: router.json absent -> router disabled by default
    const status1 = await client.localStatus();
    assert.equal(status1.router.enabled, false);
    assert.equal(status1.router.error, undefined);

    // Send to principal in disabled mode -> passes through as literal id and gets rejected by ACL
    await assert.rejects(
      () => client.sendMessage({
        to: bobPrincipal,
        text: "hello",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "recipient_not_allowed",
    );

    // Legacy send in disabled mode -> succeeds and raw fields are stripped
    const legacyReceipt = await client.sendMessage({
      to: INSTANCE_BOB,
      text: "hello legacy",
    });
    assert.ok(legacyReceipt.messageId);
    assert.equal(legacyReceipt.to_principal, undefined);
    assert.equal(legacyReceipt.resolved_via, undefined);
    assert.equal(legacyReceipt.principal, undefined);

    // 2. Enable router via setupRouter -> per-request statcache reloads immediately
    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });

    const status2 = await client.localStatus();
    assert.equal(status2.router.enabled, true);
    assert.equal(status2.router.error, undefined);
    assert.equal(status2.router.registry.state, "ok");

    // Principal send now succeeds!
    const principalReceipt = await client.sendMessage({
      to: bobPrincipal,
      text: "hello principal",
    });
    assert.ok(principalReceipt.messageId);
    assert.equal(principalReceipt.target.principal, bobPrincipal);
    assert.equal(principalReceipt.target.via, "principal");
    assert.equal(principalReceipt.to_principal, undefined);
    assert.equal(principalReceipt.resolved_via, undefined);

    // Check message status decorates principal and strips raw fields
    const msgStatus = await client.getMessageStatus({
      messageId: principalReceipt.messageId,
    });
    assert.equal(msgStatus.target.principal, bobPrincipal);
    assert.equal(msgStatus.target.via, "principal");
    assert.equal(msgStatus.to_principal, undefined);
    assert.equal(msgStatus.resolved_via, undefined);

    // 3. Dynamic kill switch: disable router -> next send immediately fails for principal
    setupRouter({ disable: true, stateRoot: f.stateRoot });

    const status3 = await client.localStatus();
    assert.equal(status3.router.enabled, false);

    await assert.rejects(
      () => client.sendMessage({
        to: bobPrincipal,
        text: "hello again",
      }),
      (err) => err instanceof LocalMessagingError,
    );

    // 4. Invalid config (e.g. wrong file permissions 0666) -> fails closed to disabled with diagnostic error
    const configPath = path.join(f.stateRoot, "router.json");
    fs.chmodSync(configPath, 0o666);

    const status4 = await client.localStatus();
    assert.equal(status4.router.enabled, false);
    assert.equal(status4.router.error, "unsafe_router_config");
  } finally {
    await cleanupFixture(f, server, client, journal);
  }
});

test("Resolution before ACL and capabilities: denial on concrete recipient, no authority added", async () => {
  const f = makeFixture();
  let server = null;
  let client = null;
  let journal = null;
  try {
    journal = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    // ACL allows HEX_A -> INSTANCE_BOB, but forbids HEX_A -> INSTANCE_CHARLIE
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB] } });
    const dispatcher = { start() {}, stop() {}, notifyAdmission() {} };
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 10, windowMs: 5000, journal });

    initRegistry(f.identityRoot);
    const charlieBinding = bindProfile(f.identityRoot, "charlie", 1);
    const bobBinding = bindProfile(f.identityRoot, "bob", 2);

    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });

    server = createLocalControlServer({
      socketPath: f.socketPath,
      journal,
      acl,
      credentialValidator: f.validator,
      dispatcher,
      statusProvider: async () => ({ ok: true, version: 1 }),
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: f.stateRoot,
      recipientDirectory: [
        { id: INSTANCE_BOB, label: "bob", kind: "worker" },
        { id: INSTANCE_CHARLIE, label: "charlie", kind: "worker" },
      ],
    });
    await server.start();

    const tokenA = f.issuer.issue({ senderId: HEX_A });
    client = createLocalControlClient({
      socketPath: f.socketPath,
      senderId: HEX_A,
      turnCredential: tokenA,
    });

    // 1. ACL denial: HEX_A attempts to send to charliePrincipal -> resolves to INSTANCE_CHARLIE, denied by ACL
    await assert.rejects(
      () => client.sendMessage({
        to: charlieBinding.principal_id,
        text: "hello charlie",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "recipient_not_allowed",
    );

    // 2. Capability scope denial: token has restricted recipient scope allowing only HEX_A -> INSTANCE_CHARLIE
    // But attempting to message bobPrincipal (resolves to INSTANCE_BOB) -> denied by capability check on concrete recipient
    const tokenRestricted = f.issuer.issue({
      senderId: HEX_A,
      allowedRecipients: [INSTANCE_CHARLIE], // only allowed to message INSTANCE_CHARLIE
    });

    await assert.rejects(
      () => client.sendMessage({
        to: bobBinding.principal_id,
        text: "hello bob",
      }, { credential: tokenRestricted }),
      (err) => err instanceof LocalMessagingError && (err.code === "recipient_not_allowed" || err.code === "capability_denied"),
    );
  } finally {
    await cleanupFixture(f, server, client, journal);
  }
});

test("Single limiter charge, duplicate retry stability, changed resolved recipient conflict", async () => {
  const f = makeFixture();
  let server = null;
  let client = null;
  let journal = null;
  try {
    journal = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB, INSTANCE_CHARLIE] } });
    let admissions = 0;
    const dispatcher = {
      start() {},
      stop() {},
      async notifyAdmission(job) {
        admissions++;
        await journal.claimExecution({
          messageId: job.messageId,
          claimSessionId: "claim-session-1",
          leaseExpiresAt: Date.now() + 60000,
        });
      },
    };
    // Rate limiter with maxRequestsPerWindow = 10
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 10, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 10, windowMs: 5000, journal });

    initRegistry(f.identityRoot);
    const bobBinding = bindProfile(f.identityRoot, "bob", 1);

    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });

    server = createLocalControlServer({
      socketPath: f.socketPath,
      journal,
      acl,
      credentialValidator: f.validator,
      dispatcher,
      statusProvider: async () => ({ ok: true, version: 1 }),
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: f.stateRoot,
      recipientDirectory: [
        { id: INSTANCE_BOB, label: "bob", kind: "worker" },
        { id: INSTANCE_CHARLIE, label: "charlie", kind: "worker" },
      ],
    });
    await server.start();

    const tokenA = f.issuer.issue({ senderId: HEX_A });
    client = createLocalControlClient({
      socketPath: f.socketPath,
      senderId: HEX_A,
      turnCredential: tokenA,
    });

    const messageId = "fixed-msg-id-123";
    const requestId = "fixed-req-id-123";

    // First send: 1 rate limit charged, 1 admission
    const receipt1 = await client.sendMessage({
      to: bobBinding.principal_id,
      messageId,
      requestId,
      text: "hello idempotent",
    });
    assert.equal(admissions, 1);
    assert.equal(receipt1.requestId, requestId);

    // Duplicate retry with same messageId, requestId and text:
    // Succeeded stably, returns stored receipt, does NOT charge limiter, does NOT notify dispatcher
    const receipt2 = await client.sendMessage({
      to: bobBinding.principal_id,
      messageId,
      requestId,
      text: "hello idempotent",
    });
    assert.equal(admissions, 1); // No new admission because original was claimed
    assert.equal(receipt2.messageId, receipt1.messageId);

    // Conflict test: Send with same messageId but different payload -> rejected with duplicate_id_conflict
    await assert.rejects(
      () => client.sendMessage({
        to: bobBinding.principal_id,
        messageId,
        requestId,
        text: "altered text",
      }),
      (err) => err instanceof LocalMessagingError && (err.code === "duplicate_id_conflict" || err.code === "idempotency_conflict"),
    );

    // Send a 2nd distinct request: new message admitted
    const receipt3 = await client.sendMessage({
      to: bobBinding.principal_id,
      messageId: "second-msg-456",
      requestId: "second-req-456",
      text: "second message",
    });
    assert.equal(admissions, 2);
  } finally {
    await cleanupFixture(f, server, client, journal);
  }
});

test("Registry corruption fails closed for principal sends only; legacy sends continue", async () => {
  const f = makeFixture();
  let server = null;
  let client = null;
  let journal = null;
  try {
    journal = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB] } });
    const dispatcher = { start() {}, stop() {}, notifyAdmission() {} };
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 10, windowMs: 5000, journal });

    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });

    // Corrupt registry.json
    fs.writeFileSync(path.join(f.identityRoot, "registry.json"), "CORRUPTED_NOT_JSON{", { mode: 0o600 });

    server = createLocalControlServer({
      socketPath: f.socketPath,
      journal,
      acl,
      credentialValidator: f.validator,
      dispatcher,
      statusProvider: async () => ({ ok: true, version: 1 }),
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: f.stateRoot,
      recipientDirectory: [
        { id: INSTANCE_BOB, label: "bob", kind: "worker" },
      ],
    });
    await server.start();

    const tokenA = f.issuer.issue({ senderId: HEX_A });
    client = createLocalControlClient({
      socketPath: f.socketPath,
      senderId: HEX_A,
      turnCredential: tokenA,
    });

    const bobPrincipal = "agent_0123456789abcdef0123456789abcdef";

    // Principal send fails closed (route_unavailable or recipient_not_found)
    await assert.rejects(
      () => client.sendMessage({
        to: bobPrincipal,
        text: "hello",
      }),
      (err) => err instanceof LocalMessagingError && (err.code === "route_unavailable" || err.code === "recipient_not_found"),
    );

    // Legacy send to INSTANCE_BOB still succeeds without disruption!
    const legacyReceipt = await client.sendMessage({
      to: INSTANCE_BOB,
      text: "hello legacy while registry is corrupt",
    });
    assert.ok(legacyReceipt.messageId);
  } finally {
    await cleanupFixture(f, server, client, journal);
  }
});

test("Ambiguity filtering through both ACL and capability scope; unauthorized labels never leaked", async () => {
  const f = makeFixture();
  let server = null;
  let client = null;
  let journal = null;
  try {
    journal = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    // ACL allows HEX_A -> INSTANCE_BOB only, NOT INSTANCE_CHARLIE
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB] } });
    const dispatcher = { start() {}, stop() {}, notifyAdmission() {} };
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 10, windowMs: 5000, journal });

    // Both bob and charlie are bound to the SAME shared principal ID
    const sharedPrincipal = "agent_11112222333344445555666677778888";
    initRegistry(f.identityRoot);
    bindProfile(f.identityRoot, "bob", 1, { principal_id: sharedPrincipal });
    bindProfile(f.identityRoot, "charlie", 2, { principal_id: sharedPrincipal });

    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });

    server = createLocalControlServer({
      socketPath: f.socketPath,
      journal,
      acl,
      credentialValidator: f.validator,
      dispatcher,
      statusProvider: async () => ({ ok: true, version: 1 }),
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: f.stateRoot,
      recipientDirectory: [
        { id: INSTANCE_BOB, label: "bob", kind: "worker" },
        { id: INSTANCE_CHARLIE, label: "charlie", kind: "worker" },
      ],
    });
    await server.start();

    const tokenA = f.issuer.issue({ senderId: HEX_A });
    client = createLocalControlClient({
      socketPath: f.socketPath,
      senderId: HEX_A,
      turnCredential: tokenA,
    });

    // 1. Sender has permission to message INSTANCE_BOB only (not INSTANCE_CHARLIE).
    // Ambiguity filtering removes INSTANCE_CHARLIE and retains only authorized candidate without leaking unauthorized labels!
    await assert.rejects(
      () => client.sendMessage({
        to: sharedPrincipal,
        text: "hello filtered recipient",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "recipient_ambiguous",
    );

    // 2. Sender token restricted to an unrelated recipient -> 0 allowed candidates -> fails closed
    const tokenRestricted = f.issuer.issue({
      senderId: HEX_A,
      allowedRecipients: ["unrelated-instance-id"],
    });

    await assert.rejects(
      () => client.sendMessage({
        to: sharedPrincipal,
        text: "hello should fail closed",
      }, { credential: tokenRestricted }),
      (err) => err instanceof LocalMessagingError && (err.code === "recipient_not_found" || err.code === "route_unavailable" || err.code === "recipient_ambiguous"),
    );
  } finally {
    await cleanupFixture(f, server, client, journal);
  }
});

test("Change of resolved concrete recipient causes idempotency conflict on retry", async () => {
  const f = makeFixture();
  let server = null;
  let client = null;
  let journal = null;
  try {
    journal = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    // ACL allows HEX_A to message both INSTANCE_BOB and INSTANCE_CHARLIE
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB, INSTANCE_CHARLIE] } });
    const dispatcher = { start() {}, stop() {}, notifyAdmission() {} };
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 10, windowMs: 5000, journal });

    const principalId = "agent_99998888777766665555444433332222";
    initRegistry(f.identityRoot);
    // Initially bound to bob
    bindProfile(f.identityRoot, "bob", 1, { principal_id: principalId });

    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });

    server = createLocalControlServer({
      socketPath: f.socketPath,
      journal,
      acl,
      credentialValidator: f.validator,
      dispatcher,
      statusProvider: async () => ({ ok: true, version: 1 }),
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: f.stateRoot,
      recipientDirectory: [
        { id: INSTANCE_BOB, label: "bob", kind: "worker" },
        { id: INSTANCE_CHARLIE, label: "charlie", kind: "worker" },
      ],
    });
    await server.start();

    const tokenA = f.issuer.issue({ senderId: HEX_A });
    client = createLocalControlClient({
      socketPath: f.socketPath,
      senderId: HEX_A,
      turnCredential: tokenA,
    });

    const fixedMessageId = "msg-mapping-conflict-test";

    // First send to principal -> resolves to INSTANCE_BOB and is stored in journal
    const receipt1 = await client.sendMessage({
      to: principalId,
      messageId: fixedMessageId,
      requestId: "req-mapping-1",
      text: "hello mapping change",
    });
    assert.equal(receipt1.target.profile, "bob");

    // Now re-bind principalId to charlie (revoking bob)
    updateIdentityRegistry({
      root: f.identityRoot,
      expectedSequence: 2,
      action: "revoke",
      subject: INSTANCE_BOB,
      mutate: (reg) => {
        reg.bindings[INSTANCE_BOB] = {
          ...reg.bindings[INSTANCE_BOB],
          revoked_at: new Date().toISOString(),
        };
        return reg;
      },
    });
    bindProfile(f.identityRoot, "charlie", 3, { principal_id: principalId });

    // Retry the same messageId with the same principal:
    // It now resolves to INSTANCE_CHARLIE, which conflicts with the stored envelope recipient (INSTANCE_BOB)!
    await assert.rejects(
      () => client.sendMessage({
        to: principalId,
        messageId: fixedMessageId,
        requestId: "req-mapping-1",
        text: "hello mapping change",
      }),
      (err) => err instanceof LocalMessagingError && (err.code === "duplicate_id_conflict" || err.code === "idempotency_conflict"),
    );
  } finally {
    await cleanupFixture(f, server, client, journal);
  }
});

test("Public DTO decoration: discover_recipients, list_replies, get_message_status, list_sessions", async () => {
  const f = makeFixture();
  let server = null;
  let client = null;
  let journal = null;
  try {
    journal = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB] } });
    const dispatcher = { start() {}, stop() {}, notifyAdmission() {} };
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 10, windowMs: 5000, journal });

    initRegistry(f.identityRoot);
    const bobBinding = bindProfile(f.identityRoot, "bob", 1);
    const bobPrincipal = bobBinding.principal_id;

    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });

    server = createLocalControlServer({
      socketPath: f.socketPath,
      journal,
      acl,
      credentialValidator: f.validator,
      dispatcher,
      statusProvider: async () => ({ ok: true, version: 1 }),
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: f.stateRoot,
      recipientDirectory: [
        { id: INSTANCE_BOB, label: "bob", kind: "worker" },
      ],
    });
    await server.start();

    const tokenA = f.issuer.issue({ senderId: HEX_A });
    client = createLocalControlClient({
      socketPath: f.socketPath,
      senderId: HEX_A,
      turnCredential: tokenA,
    });

    // 1. discoverRecipients decorated with entries including principal
    const disc = await client.discoverRecipients();
    assert.deepEqual(disc, [INSTANCE_BOB]);

    // 2. Send message and check replies
    const sendRes = await client.sendMessage({
      to: bobPrincipal,
      text: "hello bob for reply",
    });
    assert.equal(sendRes.target.principal, bobPrincipal);

    // Record reply in journal
    await journal.recordReply({
      sender: INSTANCE_BOB,
      recipient: HEX_A,
      messageId: "reply-001",
      requestId: sendRes.requestId,
      inReplyTo: sendRes.messageId,
      text: "reply text",
    });

    const replies = await client.listReplies();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].messageId, "reply-001");
    // Raw journal columns must be stripped
    assert.equal(replies[0].to_principal, undefined);
    assert.equal(replies[0].resolved_via, undefined);
  } finally {
    await cleanupFixture(f, server, client, journal);
  }
});

test("Interactive inbox raw columns stripped at public RPC projection in both modes; retains internal journal metadata and stable pagination", async () => {
  // Test in ENABLED mode first
  const fEnabled = makeFixture();
  let serverE = null;
  let clientE = null;
  let journalE = null;

  try {
    journalE = createLocalMessagingJournal({ stateRoot: fEnabled.stateRoot });
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB] } });
    const dispatcher = { start() {}, stop() {}, notifyAdmission() {} };
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal: journalE });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 10, windowMs: 5000, journal: journalE });

    initRegistry(fEnabled.identityRoot);
    bindProfile(fEnabled.identityRoot, "bob", 1);
    setupRouter({ enable: true, registryRoot: fEnabled.identityRoot, stateRoot: fEnabled.stateRoot });

    serverE = createLocalControlServer({
      socketPath: fEnabled.socketPath,
      journal: journalE,
      acl,
      credentialValidator: fEnabled.validator,
      dispatcher,
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: fEnabled.stateRoot,
      recipientDirectory: [{ id: INSTANCE_BOB, label: "bob", kind: "worker" }],
      interactiveRecipients: [INSTANCE_BOB],
      interactiveBroker: { isInteractiveSender: () => true, validateRequest: async () => true },
    });
    await serverE.start();

    // 1. Independent real journal probe
    await journalE.recordSend({
      sender: HEX_A,
      recipient: INSTANCE_BOB,
      recipientType: "interactive",
      messageId: "msg-probe-inbox-1",
      requestId: "req-probe-1",
      text: "probe interactive text",
      to_principal: "agent_" + "a".repeat(32),
      resolved_via: "principal",
    });

    // 2. Internal journal listInbox retains raw columns for internal metadata / audit
    const internalList = await journalE.listInbox({ requester: INSTANCE_BOB });
    assert.equal(internalList.items.length, 1);
    assert.equal(internalList.items[0].to_principal, "agent_" + "a".repeat(32));
    assert.equal(internalList.items[0].resolved_via, "principal");

    // 3. Public RPC over Unix socket strips raw columns in ENABLED mode
    const tokenBob = fEnabled.issuer.issue({
      senderId: INSTANCE_BOB,
      senderType: "interactive",
      sessionId: "sess-bob-1",
      generation: 1,
    });
    clientE = createLocalControlClient({
      socketPath: fEnabled.socketPath,
      senderId: INSTANCE_BOB,
      turnCredential: tokenBob,
    });

    const publicListE = await clientE.listInbox({ limit: 10 });
    assert.equal(publicListE.items.length, 1);
    const itemE = publicListE.items[0];
    assert.equal(itemE.messageId, "msg-probe-inbox-1");
    assert.equal(itemE.to_principal, undefined);
    assert.equal(itemE.resolved_via, undefined);

    // 4. Audit claim_inbox_message over socket
    const claimRes = await clientE.claimInboxMessage({
      messageId: "msg-probe-inbox-1",
      claimId: "claim-test-1",
    });
    assert.equal(claimRes.messageId, "msg-probe-inbox-1");
    assert.equal(claimRes.to_principal, undefined);
    assert.equal(claimRes.resolved_via, undefined);
  } finally {
    await cleanupFixture(fEnabled, serverE, clientE, journalE);
  }

  // Test in DISABLED mode and compare against v12 public shape
  const fDisabled = makeFixture();
  let serverD = null;
  let clientD = null;
  let journalD = null;

  try {
    journalD = createLocalMessagingJournal({ stateRoot: fDisabled.stateRoot });
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB] } });
    const dispatcher = { start() {}, stop() {}, notifyAdmission() {} };
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal: journalD });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 10, windowMs: 5000, journal: journalD });

    setupRouter({ disable: true, stateRoot: fDisabled.stateRoot });

    serverD = createLocalControlServer({
      socketPath: fDisabled.socketPath,
      journal: journalD,
      acl,
      credentialValidator: fDisabled.validator,
      dispatcher,
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: fDisabled.stateRoot,
      recipientDirectory: [{ id: INSTANCE_BOB, label: "bob", kind: "worker" }],
      interactiveRecipients: [INSTANCE_BOB],
      interactiveBroker: { isInteractiveSender: () => true, validateRequest: async () => true },
    });
    await serverD.start();

    // Probe in journal with raw columns even in disabled mode (e.g. from prior DB state)
    await journalD.recordSend({
      sender: HEX_A,
      recipient: INSTANCE_BOB,
      recipientType: "interactive",
      messageId: "msg-probe-dis-1",
      requestId: "req-probe-dis-1",
      text: "probe disabled text",
      to_principal: "agent_" + "a".repeat(32),
      resolved_via: "principal",
    });

    const tokenBobD = fDisabled.issuer.issue({
      senderId: INSTANCE_BOB,
      senderType: "interactive",
      sessionId: "sess-bob-2",
      generation: 1,
    });
    clientD = createLocalControlClient({
      socketPath: fDisabled.socketPath,
      senderId: INSTANCE_BOB,
      turnCredential: tokenBobD,
    });

    const publicListD = await clientD.listInbox({ limit: 10 });
    assert.equal(publicListD.items.length, 1);
    const itemD = publicListD.items[0];
    assert.equal(itemD.to_principal, undefined);
    assert.equal(itemD.resolved_via, undefined);

    // Baseline v12 public shape verification:
    const V12_EXPECTED_KEYS = [
      "claimGeneration",
      "claimSessionId",
      "createdAt",
      "hasLateResult",
      "inReplyTo",
      "leaseExpiresAt",
      "messageId",
      "metadata",
      "phase",
      "reason",
      "recipient",
      "recipientType",
      "requestId",
      "runtimeError",
      "sender",
      "text",
      "updatedAt",
    ];
    assert.deepEqual(Object.keys(itemD).sort(), V12_EXPECTED_KEYS.sort());

    // 5. Stable pagination check over socket without raw columns
    for (let i = 2; i <= 6; i++) {
      await journalD.recordSend({
        sender: HEX_A,
        recipient: INSTANCE_BOB,
        recipientType: "interactive",
        messageId: `msg-pag-${i}`,
        requestId: `req-pag-${i}`,
        text: `paginated item ${i}`,
      });
    }

    const page1 = await clientD.listInbox({ limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    for (const item of page1.items) {
      assert.equal(item.to_principal, undefined);
      assert.equal(item.resolved_via, undefined);
    }

    const page2 = await clientD.listInbox({ limit: 2, cursor: page1.nextCursor });
    assert.equal(page2.items.length, 2);
    for (const item of page2.items) {
      assert.equal(item.to_principal, undefined);
      assert.equal(item.resolved_via, undefined);
    }
    assert.notEqual(page1.items[0].messageId, page2.items[0].messageId);
  } finally {
    await cleanupFixture(fDisabled, serverD, clientD, journalD);
  }
});

test("Route intent immutability on retry: different principal, principal-to-ID retry, remap, restart, and disabled rollback", async () => {
  const f = makeFixture();
  let server = null;
  let client = null;
  let journal = null;

  try {
    const INSTANCE_CHARLIE2 = deriveClientInstanceId("charlie2");
    journal = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB, INSTANCE_CHARLIE, INSTANCE_CHARLIE2] } });
    const dispatcher = { start() {}, stop() {}, notifyAdmission() {} };
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 50, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 50, windowMs: 5000, journal });

    initRegistry(f.identityRoot);
    const bobBinding = bindProfile(f.identityRoot, "bob", 1);
    const bobPrincipalA = bobBinding.principal_id;

    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });

    server = createLocalControlServer({
      socketPath: f.socketPath,
      journal,
      acl,
      credentialValidator: f.validator,
      dispatcher,
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: f.stateRoot,
      recipientDirectory: [
        { id: INSTANCE_BOB, label: "bob", kind: "worker" },
        { id: INSTANCE_CHARLIE, label: "charlie", kind: "worker" },
        { id: INSTANCE_CHARLIE2, label: "charlie2", kind: "worker" },
      ],
    });
    await server.start();

    const tokenA = f.issuer.issue({ senderId: HEX_A });
    client = createLocalControlClient({
      socketPath: f.socketPath,
      senderId: HEX_A,
      turnCredential: tokenA,
    });

    // Case 1: Different principal / same recipient -> must reject on retry
    await journal.recordSend({
      sender: HEX_A,
      recipient: INSTANCE_BOB,
      messageId: "msg-diff-principal-1",
      requestId: "req-diff-p-1",
      text: "hello principal A",
      to_principal: "agent_" + "a".repeat(32),
      resolved_via: "principal",
    });

    await assert.rejects(
      async () => journal.recordSend({
        sender: HEX_A,
        recipient: INSTANCE_BOB,
        messageId: "msg-diff-principal-1",
        requestId: "req-diff-p-1",
        text: "hello principal A", // same envelope body
        to_principal: "agent_" + "b".repeat(32),
        resolved_via: "principal",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );

    // Stored message must not have been silently relabeled to principal B
    const stored1 = await journal.getRecord("msg-diff-principal-1");
    assert.equal(stored1.to_principal, "agent_" + "a".repeat(32));

    // Case 2: Principal-to-ID retry -> must reject on retry
    const resSend2 = await client.sendMessage({
      to: bobPrincipalA,
      messageId: "msg-p-to-id-1",
      requestId: "req-p-id-1",
      text: "hello principal for id retry",
    });
    assert.equal(resSend2.target.principal, bobPrincipalA);

    await assert.rejects(
      async () => client.sendMessage({
        to: INSTANCE_BOB,
        messageId: "msg-p-to-id-1",
        requestId: "req-p-id-1",
        text: "hello principal for id retry",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );

    // Case 3: ID-to-principal retry -> must reject on retry
    const resSend3 = await client.sendMessage({
      to: INSTANCE_BOB,
      messageId: "msg-id-to-p-1",
      requestId: "req-id-p-1",
      text: "hello id first",
    });
    assert.equal(resSend3.target.via, "id");

    await assert.rejects(
      async () => client.sendMessage({
        to: bobPrincipalA,
        messageId: "msg-id-to-p-1",
        requestId: "req-id-p-1",
        text: "hello id first",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );

    // Case 4: Registry remap -> must reject when recipient mapping changes
    const charliePrincipal = "agent_44445555666677778888999900001111";
    bindProfile(f.identityRoot, "charlie", 2, { principal_id: charliePrincipal });

    const resSend4 = await client.sendMessage({
      to: charliePrincipal,
      messageId: "msg-remap-1",
      requestId: "req-remap-1",
      text: "hello before remap",
    });
    assert.equal(resSend4.accepted, true);

    // Remap charliePrincipal to INSTANCE_CHARLIE2: revoke charlie, bind charlie2 with same principal
    updateIdentityRegistry({
      root: f.identityRoot,
      expectedSequence: 3,
      action: "revoke",
      subject: INSTANCE_CHARLIE,
      mutate: (reg) => {
        reg.bindings[INSTANCE_CHARLIE] = {
          ...reg.bindings[INSTANCE_CHARLIE],
          revoked_at: new Date().toISOString(),
        };
        return reg;
      },
    });
    bindProfile(f.identityRoot, "charlie2", 4, { principal_id: charliePrincipal });

    await assert.rejects(
      async () => client.sendMessage({
        to: charliePrincipal,
        messageId: "msg-remap-1",
        requestId: "req-remap-1",
        text: "hello before remap",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );

    // Case 5: Exact retries -> must succeed as isDuplicate: true and describe stored principal
    const resExact1 = await client.sendMessage({
      to: bobPrincipalA,
      messageId: "msg-exact-retry-1",
      requestId: "req-exact-1",
      text: "hello exact",
    });
    assert.equal(resExact1.isDuplicate, false);

    const resExact2 = await client.sendMessage({
      to: bobPrincipalA,
      messageId: "msg-exact-retry-1",
      requestId: "req-exact-1",
      text: "hello exact",
    });
    assert.equal(resExact2.isDuplicate, true);
    assert.equal(resExact2.target.principal, bobPrincipalA);
    assert.equal(resExact2.target.via, "principal");

    // Case 6: Exact retry across restart
    const resRestart1 = await client.sendMessage({
      to: bobPrincipalA,
      messageId: "msg-restart-retry-1",
      requestId: "req-restart-1",
      text: "hello restart",
    });
    assert.equal(resRestart1.isDuplicate, false);

    // Stop and restart server & journal
    await client.close();
    await server.close();
    journal.close();

    journal = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    server = createLocalControlServer({
      socketPath: f.socketPath,
      journal,
      acl,
      credentialValidator: f.validator,
      dispatcher,
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: f.stateRoot,
      recipientDirectory: [
        { id: INSTANCE_BOB, label: "bob", kind: "worker" },
      ],
    });
    await server.start();

    client = createLocalControlClient({
      socketPath: f.socketPath,
      senderId: HEX_A,
      turnCredential: tokenA,
    });

    const resRestart2 = await client.sendMessage({
      to: bobPrincipalA,
      messageId: "msg-restart-retry-1",
      requestId: "req-restart-1",
      text: "hello restart",
    });
    assert.equal(resRestart2.isDuplicate, true);
    assert.equal(resRestart2.target.principal, bobPrincipalA);

    // Case 7: Disabled rollback behavior and safe legacy null handling
    setupRouter({ disable: true, stateRoot: f.stateRoot });

    // Send a message in disabled mode (stored with null to_principal, null resolved_via)
    const resDis1 = await client.sendMessage({
      to: INSTANCE_BOB,
      messageId: "msg-dis-rollback-1",
      requestId: "req-dis-1",
      text: "disabled send",
    });
    assert.equal(resDis1.isDuplicate, false);

    // Exact retry in disabled mode
    const resDisRetry = await client.sendMessage({
      to: INSTANCE_BOB,
      messageId: "msg-dis-rollback-1",
      requestId: "req-dis-1",
      text: "disabled send",
    });
    assert.equal(resDisRetry.isDuplicate, true);

    // Re-enable router
    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });

    // Retry the legacy message in enabled mode by ID -> safe legacy null matches ID send!
    const resLegToId = await client.sendMessage({
      to: INSTANCE_BOB,
      messageId: "msg-dis-rollback-1",
      requestId: "req-dis-1",
      text: "disabled send",
    });
    assert.equal(resLegToId.isDuplicate, true);

    // Retry the legacy message with principal -> must reject (cannot relabel stored message)
    await assert.rejects(
      async () => client.sendMessage({
        to: bobPrincipalA,
        messageId: "msg-dis-rollback-1",
        requestId: "req-dis-1",
        text: "disabled send",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );

    // Rollback of principal-addressed message:
    // Message sent to principal in enabled mode:
    const resPEnabled = await client.sendMessage({
      to: bobPrincipalA,
      messageId: "msg-p-enabled-1",
      requestId: "req-p-en-1",
      text: "principal addressed",
    });
    assert.equal(resPEnabled.accepted, true);

    // Disable router and retry as raw ID send -> must reject because stored intent was principal
    setupRouter({ disable: true, stateRoot: f.stateRoot });
    await assert.rejects(
      async () => client.sendMessage({
        to: INSTANCE_BOB,
        messageId: "msg-p-enabled-1",
        requestId: "req-p-en-1",
        text: "principal addressed",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );
  } finally {
    await cleanupFixture(f, server, client, journal);
  }
});

test("Reply envelope bounds evaluated AFTER route decoration to prevent overflow; replies not lost", async () => {
  const f = makeFixture();
  let server = null;
  let client = null;
  let journal = null;

  try {
    journal = createLocalMessagingJournal({ stateRoot: f.stateRoot });
    const acl = createOwnerAcl({ rules: { [HEX_A]: [INSTANCE_BOB] } });
    const dispatcher = { start() {}, stop() {}, notifyAdmission() {} };
    const rateLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 50, windowMs: 5000 });
    const loopTracker = createConversationLoopTracker({ maxLoopDepth: 10, journal });
    const pairExchangeLimiter = createPairExchangeLimiter({ maxPairExchanges: 50, windowMs: 5000, journal });

    setupRouter({ enable: true, stateRoot: f.stateRoot });

    server = createLocalControlServer({
      socketPath: f.socketPath,
      journal,
      acl,
      credentialValidator: f.validator,
      dispatcher,
      rateLimiter,
      loopTracker,
      pairExchangeLimiter,
      stateRoot: f.stateRoot,
      recipientDirectory: [{ id: INSTANCE_BOB, label: "bob", kind: "worker" }],
    });
    await server.start();

    const tokenA = f.issuer.issue({ senderId: HEX_A });
    client = createLocalControlClient({
      socketPath: f.socketPath,
      senderId: HEX_A,
      turnCredential: tokenA,
    });

    // Seed original message for reply correlation
    await journal.recordSend({
      sender: HEX_A,
      recipient: INSTANCE_BOB,
      messageId: "msg-orig-shared",
      requestId: "req-orig-shared",
      text: "orig message for replies",
    });

    // Seed multiple large replies.
    // Each reply has ~1.6KB text.
    // 180 replies of ~1.8KB decorated = ~324KB, exceeding MAX_PAYLOAD_BYTES (256KB) - 1024.
    const textChunk = "x".repeat(1600);
    for (let i = 0; i < 180; i++) {
      await journal.recordReply({
        sender: INSTANCE_BOB,
        recipient: HEX_A,
        messageId: `rep-large-${i}`,
        requestId: "req-orig-shared",
        inReplyTo: "msg-orig-shared",
        text: textChunk,
      });
    }

    // Call list_replies over socket
    const replies = await client.listReplies({ limit: 180 });
    assert.ok(replies.length > 0);
    assert.ok(replies.length < 180, "Batch must be bounded to fit envelope");

    // Every returned reply must be decorated with route: "local"
    for (const rep of replies) {
      assert.equal(rep.route, "local");
      assert.equal(rep.to_principal, undefined);
      assert.equal(rep.resolved_via, undefined);
    }

    // Verify remaining replies in journal are NOT consumed and NOT lost
    const allJournalReplies = await journal.listReplies({ requester: HEX_A, limit: 180 });
    assert.equal(allJournalReplies.length, 180, "No replies lost or premature consumed");

    // Consume first batch of replies
    for (const rep of replies) {
      await client.consumeReply({ messageId: rep.messageId });
    }

    // Next call fetches subsequent unconsumed replies
    const nextReplies = await client.listReplies({ limit: 180 });
    assert.ok(nextReplies.length > 0);
    assert.notEqual(nextReplies[0].messageId, replies[0].messageId);
  } finally {
    await cleanupFixture(f, server, client, journal);
  }
});

test("Router config statcache custody invalidation: hard links and stateRoot parent permissions fail closed", async () => {
  const f = makeFixture();
  try {
    initRegistry(f.identityRoot);
    setupRouter({ enable: true, registryRoot: f.identityRoot, stateRoot: f.stateRoot });

    const cache = createRouterStatCache(f.stateRoot);
    const initial = cache.get();
    assert.equal(initial.enabled, true);
    assert.equal(initial.error, null);

    const routerPath = path.join(f.stateRoot, "router.json");
    const hardlinkPath = path.join(f.stateRoot, "router-hardlink.json");

    // 1. Attacker creates hard link without touching file mtime/size/inode
    fs.linkSync(routerPath, hardlinkPath);
    const afterLink = cache.get();
    assert.equal(afterLink.enabled, false);
    assert.equal(afterLink.error, "unsafe_router_config");

    // 2. Remove hard link -> recovers to valid enabled
    fs.unlinkSync(hardlinkPath);
    const afterUnlink = cache.get();
    assert.equal(afterUnlink.enabled, true);
    assert.equal(afterUnlink.error, null);

    // 3. Parent directory stateRoot custody tampered (e.g. chmod 0777)
    fs.chmodSync(f.stateRoot, 0o777);
    const afterDirTamper = cache.get();
    assert.equal(afterDirTamper.enabled, false);
    assert.equal(afterDirTamper.error, "unsafe_router_config");

    // 4. Restore stateRoot mode -> recovers to valid enabled
    fs.chmodSync(f.stateRoot, 0o700);
    const afterDirRestore = cache.get();
    assert.equal(afterDirRestore.enabled, true);
    assert.equal(afterDirRestore.error, null);
  } finally {
    await cleanupFixture(f);
  }
});
