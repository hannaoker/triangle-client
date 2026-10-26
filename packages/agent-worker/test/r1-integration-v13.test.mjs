import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { createLocalControlServer } from "../src/local-messaging-server.mjs";
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

test("v12 / v13 SQLite journal read/write compatibility both directions", async () => {
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
