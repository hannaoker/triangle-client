import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CHAT_MAPPING_FILENAME,
  confirmChatMapping,
  deriveChatSelectorId,
  lookupConfirmedChatMappingForSession,
  readChatMappings,
  resolveChatDestinationForPrincipal,
  revokeChatMapping,
  setChatMapping,
} from "../src/local-chat-mapping.mjs";
import { createLocalMessagingJournal, listLiveAttachedSessionsReadOnly } from "../src/local-messaging-journal.mjs";
import { activeStateRoots } from "../src/shared-delivery-journal.mjs";
import { createUnifiedRouter } from "../src/unified-router.mjs";
import { classifyLane } from "../src/installation-inventory.mjs";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import { createTurnCapabilityIssuer, createTurnCapabilityValidator } from "../src/local-messaging-credentials.mjs";
import { createAttachedReplyIdentity } from "../src/local-sender-authentication.mjs";

function mkPrivateDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.chmodSync(dir, 0o700);
  return dir;
}

const PRINCIPAL_A = "agent_" + "a".repeat(32);
const PRINCIPAL_B = "agent_" + "b".repeat(32);
const SESSION_1 = "session-" + "1".repeat(64);
const SESSION_2 = "session-" + "2".repeat(64);
const ORIGIN = "https://triangle.example";

test("D4 chat-mappings store: custody, set, D5-B confirm, lookup, destination resolution, and revoke", () => {
  const storeRoot = mkPrivateDir("triangle-chat-map-");
  try {
    const empty = readChatMappings({ storeRoot });
    assert.equal(empty.state, "absent");
    assert.equal(empty.sequence, 0);

    const workspace = mkPrivateDir("triangle-ws-");
    const realWs = fs.realpathSync(workspace);
    const selectorId = deriveChatSelectorId({ harness: "claude", workspace: realWs });

    const setRes = setChatMapping({
      storeRoot,
      selectorId,
      harness: "claude",
      workspace: realWs,
      principalId: PRINCIPAL_A,
      authorityOrigin: ORIGIN,
      bindingGeneration: 1,
      expectedSequence: 0,
      now: () => "2026-11-13T00:00:00.000Z",
    });
    assert.equal(setRes.state, "ok");
    assert.equal(setRes.sequence, 1);
    assert.equal(setRes.mappings[selectorId].state, "pending");

    const mode = fs.statSync(path.join(storeRoot, CHAT_MAPPING_FILENAME)).mode & 0o777;
    assert.equal(mode, 0o600);

    // CD-5 create-only: setting same selector or same principal fails before revoke
    assert.throws(() => setChatMapping({
      storeRoot,
      selectorId,
      harness: "claude",
      workspace: realWs,
      principalId: PRINCIPAL_A,
      authorityOrigin: ORIGIN,
      bindingGeneration: 1,
      expectedSequence: 1,
    }), { code: "chat_mapping_exists" });

    assert.throws(() => setChatMapping({
      storeRoot,
      selectorId: deriveChatSelectorId({ harness: "codex", workspace: realWs }),
      harness: "codex",
      workspace: realWs,
      principalId: PRINCIPAL_A,
      authorityOrigin: ORIGIN,
      bindingGeneration: 1,
      expectedSequence: 1,
    }), { code: "chat_mapping_principal_exists" });

    // Pending mapping cannot resolve destination or session lookup
    assert.deepEqual(resolveChatDestinationForPrincipal({
      storeRoot,
      principalId: PRINCIPAL_A,
      destination: { harness: "claude", workspace: realWs, bindingGeneration: 1, authorityOrigin: ORIGIN },
      attachedSessions: [{ address: SESSION_1, harness: "claude", workspace: realWs }],
    }), { ok: false, reason: "chat_mapping_unconfirmed" });
    assert.equal(lookupConfirmedChatMappingForSession({ storeRoot, sessionAddress: SESSION_1 }), null);

    // D5-B confirm requires exact 1 live attached chat matching (harness, workspace)
    assert.throws(() => confirmChatMapping({
      storeRoot,
      selectorId,
      attachedSessions: [],
    }), { code: "chat_mapping_no_live_session" });

    assert.throws(() => confirmChatMapping({
      storeRoot,
      selectorId,
      attachedSessions: [
        { address: SESSION_1, harness: "claude", workspace: realWs },
        { address: SESSION_2, harness: "claude", workspace: realWs },
      ],
    }), { code: "chat_mapping_ambiguous_session" });

    const confirmed = confirmChatMapping({
      storeRoot,
      selectorId,
      attachedSessions: [{ address: SESSION_1, harness: "claude", workspace: realWs }],
      expectedSequence: 1,
      now: () => "2026-11-13T00:01:00.000Z",
    });
    assert.equal(confirmed.sequence, 2);
    assert.equal(confirmed.mappings[selectorId].state, "confirmed");
    assert.equal(confirmed.mappings[selectorId].sessionAddress, SESSION_1);

    const resolved = resolveChatDestinationForPrincipal({
      storeRoot,
      principalId: PRINCIPAL_A,
      destination: { harness: "claude", workspace: realWs, bindingGeneration: 1, authorityOrigin: ORIGIN },
      attachedSessions: [{ address: SESSION_1, harness: "claude", workspace: realWs }],
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.sessionAddress, SESSION_1);
    assert.equal(resolveChatDestinationForPrincipal({
      storeRoot,
      principalId: PRINCIPAL_A,
      destination: { harness: "claude", workspace: realWs, bindingGeneration: 2, authorityOrigin: ORIGIN },
      attachedSessions: [{ address: SESSION_1, harness: "claude", workspace: realWs }],
    }).reason, "chat_mapping_stale_generation");
    assert.equal(resolveChatDestinationForPrincipal({
      storeRoot,
      principalId: PRINCIPAL_A,
      destination: { harness: "claude", workspace: realWs },
      attachedSessions: [{ address: SESSION_1, harness: "claude", workspace: realWs }],
    }).reason, "destination_binding_inactive");

    const lookedUp = lookupConfirmedChatMappingForSession({
      storeRoot,
      sessionAddress: SESSION_1,
      harness: "claude",
      workspace: realWs,
    });
    assert.equal(lookedUp.principal, PRINCIPAL_A);
    assert.equal(lookedUp.authorityOrigin, ORIGIN);
    assert.equal(lookedUp.bindingGeneration, 1);

    // Offline session fails closed
    assert.deepEqual(resolveChatDestinationForPrincipal({
      storeRoot,
      principalId: PRINCIPAL_A,
      destination: { harness: "claude", workspace: realWs, bindingGeneration: 1, authorityOrigin: ORIGIN },
      attachedSessions: [],
    }), { ok: false, reason: "destination_session_offline" });

    // Revoke removes entry and frees selector
    const revoked = revokeChatMapping({
      storeRoot,
      selectorId,
      expectedSequence: 2,
      before: {
        harness: "claude",
        workspace: realWs,
        principalId: PRINCIPAL_A,
        authorityOrigin: ORIGIN,
        bindingGeneration: 1,
      },
    });
    assert.equal(revoked.sequence, 3);
    assert.equal(revoked.mappings[selectorId], undefined);
    fs.rmSync(workspace, { recursive: true, force: true });
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("journal persists sender_provenance_json even when replyRoute is omitted", async () => {
  const dir = mkPrivateDir("triangle-journal-prov-");
  const journal = createLocalMessagingJournal({ stateRoot: dir });
  try {
    const prov = {
      schema: "sender_provenance_v1",
      request_id: "req-1",
      principal: PRINCIPAL_A,
      recipient_principal: PRINCIPAL_B,
      sender_binding_generation: 1,
      principal_binding_generation: 2,
      via: { transport: "local-socket", authenticated_peer: SESSION_1 },
      assurance: { kind: "local-attested", principal_binding: "owner-mapped-disk-observation" },
      authority_origin: ORIGIN,
    };
    await journal.recordSend({
      sender: SESSION_1,
      recipient: SESSION_2,
      text: "hello",
      messageId: "msg-prov-1",
      requestId: "req-1",
      recipientType: "interactive",
    }, {
      senderProvenance: prov,
    });
    const rec = await journal.getRecord("msg-prov-1");
    assert.equal(rec.senderProvenance.principal, PRINCIPAL_A);
    assert.equal(rec.senderProvenance.recipient_principal, PRINCIPAL_B);
    assert.equal(await journal.getReplyRouteForMessage("msg-prov-1"), null);
  } finally {
    await journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unified-router resolves non-runner destination principal via resolveDestinationPrincipal", async () => {
  const snapshot = {
    schema: "identity_registry_v2",
    bindings: [],
    aliases: [],
    destinationFor: (principalId) =>
      principalId === PRINCIPAL_A ? { harness: "claude", workspace: "/tmp/ws", generation: 1 } : null,
  };
  const router = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => snapshot },
    recipients: [],
    resolveDestinationPrincipal: async ({ principalId, destination }) => {
      assert.equal(principalId, PRINCIPAL_A);
      assert.equal(destination.harness, "claude");
      return { ok: true, sessionAddress: SESSION_1 };
    },
  });
  const res = await router.resolveSend({ senderId: "a".repeat(64), to: PRINCIPAL_A });
  assert.equal(res.ok, true);
  assert.equal(res.resolvedTo, SESSION_1);
  assert.equal(res.recipientType, "interactive");
  assert.equal(res.principal, PRINCIPAL_A);
});

test("router fallback fails closed for revoked and stale-generation principals", async () => {
  const storeRoot = mkPrivateDir("triangle-chat-route-");
  const workspace = mkPrivateDir("triangle-chat-route-ws-");
  try {
    const realWs = fs.realpathSync(workspace);
    const selectorId = deriveChatSelectorId({ harness: "claude", workspace: realWs });
    setChatMapping({
      storeRoot, selectorId, harness: "claude", workspace: realWs,
      principalId: PRINCIPAL_A, authorityOrigin: ORIGIN, bindingGeneration: 1, expectedSequence: 0,
    });
    confirmChatMapping({
      storeRoot, selectorId, expectedSequence: 1,
      attachedSessions: [{ address: SESSION_1, harness: "claude", workspace: realWs }],
    });
    const attached = [{ address: SESSION_1, harness: "claude", workspace: realWs }];
    const activeDestination = {
      harness: "claude", workspace: realWs, generation: 3, bindingGeneration: 1, authorityOrigin: ORIGIN,
    };
    let calls = 0;
    const revoked = createUnifiedRouter({
      enabled: true,
      snapshotProvider: { get: () => ({ state: "ok", bindingsFor: () => [], destinationFor: () => null }) },
      recipients: [],
      resolveDestinationPrincipal: async () => { calls += 1; return { ok: true, sessionAddress: SESSION_1 }; },
    });
    await assert.rejects(
      () => revoked.resolveSend({ senderId: "a".repeat(64), to: PRINCIPAL_A }),
      { code: "recipient_not_found" },
    );
    assert.equal(calls, 0);

    const stale = createUnifiedRouter({
      enabled: true,
      snapshotProvider: {
        get: () => ({
          state: "ok",
          bindingsFor: () => [],
          destinationFor: () => ({ ...activeDestination, bindingGeneration: 2 }),
        }),
      },
      recipients: [],
      resolveDestinationPrincipal: ({ principalId, destination }) => resolveChatDestinationForPrincipal({
        storeRoot, principalId, destination, attachedSessions: attached,
      }),
    });
    await assert.rejects(
      () => stale.resolveSend({ senderId: "a".repeat(64), to: PRINCIPAL_A }),
      { code: "chat_mapping_stale_generation" },
    );

    const live = createUnifiedRouter({
      enabled: true,
      snapshotProvider: {
        get: () => ({ state: "ok", bindingsFor: () => [], destinationFor: () => activeDestination }),
      },
      recipients: [],
      resolveDestinationPrincipal: ({ principalId, destination }) => resolveChatDestinationForPrincipal({
        storeRoot, principalId, destination, attachedSessions: attached,
      }),
    });
    const routed = await live.resolveSend({ senderId: "a".repeat(64), to: PRINCIPAL_A });
    assert.equal(routed.ok, true);
    assert.equal(routed.resolvedTo, SESSION_1);
    assert.equal(routed.recipientType, "interactive");
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("server records a chat-mapped destination as interactive and does not dispatch a runner", async () => {
  const root = mkPrivateDir("triangle-dest-server-");
  const socketPath = path.join(root, "control.sock");
  const sender = "a".repeat(64);
  const secret = "destination-server-secret-32-bytes!!";
  const issuer = createTurnCapabilityIssuer({ secret });
  const validator = createTurnCapabilityValidator({ secret });
  const journal = createLocalMessagingJournal({ stateRoot: root });
  const admissions = [];
  const router = createUnifiedRouter({
    enabled: true,
    snapshotProvider: {
      get: () => ({
        state: "ok",
        bindingsFor: () => [],
        destinationFor: (id) => id === PRINCIPAL_A
          ? { harness: "claude", workspace: "/tmp/ws", generation: 1, bindingGeneration: 1, authorityOrigin: ORIGIN }
          : null,
      }),
    },
    recipients: [],
    resolveDestinationPrincipal: async () => ({ ok: true, sessionAddress: SESSION_1 }),
  });
  const server = createLocalControlServer({
    socketPath,
    journal,
    acl: createOwnerAcl({ rules: { [sender]: [SESSION_1] } }),
    credentialValidator: validator,
    dispatcher: { start: async () => {}, stop: async () => {}, notifyAdmission: async (job) => { admissions.push(job); } },
    router,
  });
  const client = createLocalControlClient({
    socketPath,
    senderId: sender,
    turnCredential: issuer.issue({ senderId: sender }),
  });
  try {
    await server.start();
    const receipt = await client.sendMessage({ to: PRINCIPAL_A, text: "route me", messageId: "dest-msg", requestId: "dest-req" });
    assert.equal(receipt.accepted, true);
    assert.equal((await journal.getRecord("dest-msg")).recipientType, "interactive");
    assert.equal((await journal.getRecord("dest-msg")).recipient, SESSION_1);
    assert.deepEqual(admissions, []);
  } finally {
    await client.close();
    await server.close();
    await journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("send lookup fails soft on a bad mapping file and caches until the file changes", () => {
  const storeRoot = mkPrivateDir("triangle-chat-soft-");
  const file = path.join(storeRoot, CHAT_MAPPING_FILENAME);
  try {
    fs.writeFileSync(file, "{", { mode: 0o600 });
    const logs = [];
    assert.equal(lookupConfirmedChatMappingForSession({
      storeRoot, sessionAddress: SESSION_1, failSoft: true, log: (message) => logs.push(message),
    }), null);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /chat_mapping_corrupt/);
    assert.equal(lookupConfirmedChatMappingForSession({
      storeRoot, sessionAddress: SESSION_1, failSoft: true, log: (message) => logs.push(message),
    }), null);
    assert.equal(logs.length, 1, "unchanged unreadable file is not re-read");
    assert.throws(() => readChatMappings({ storeRoot }), { code: "chat_mapping_corrupt" });
    fs.chmodSync(file, 0o644);
    assert.equal(lookupConfirmedChatMappingForSession({
      storeRoot, sessionAddress: SESSION_1, failSoft: true, log: (message) => logs.push(message),
    }), null);
    assert.equal(logs.length, 2);
    assert.match(logs[1], /chat_mapping_custody/);
    fs.rmSync(file);
    fs.symlinkSync("/tmp/elsewhere", file);
    assert.throws(() => readChatMappings({ storeRoot }), { code: "chat_mapping_custody" });
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("chat-map confirm can list live chats without taking the journal owner lock", async () => {
  const storeRoot = mkPrivateDir("triangle-ro-journal-");
  const installationId = randomUUID();
  const sessionId = randomUUID();
  let journal = createLocalMessagingJournal({ stateRoot: storeRoot });
  try {
    const now = Date.now();
    await journal.recordDiscoveryEvent({
      installationId,
      event: { eventId: randomUUID(), sessionId, kind: "start", workspace: storeRoot, observedAt: now },
      digest: "read-only",
      receivedAt: now,
    });
    const discovered = await journal.listDiscoveredSessions({ installationId, workspace: storeRoot });
    await journal.attachDiscoveredSession({
      id: discovered[0].id, childId: randomUUID(), generation: discovered[0].generation,
      installationId, wakeCapable: false, now,
    });
    await journal.close();
    assert.equal(activeStateRoots.has(storeRoot), false);
    const rows = listLiveAttachedSessionsReadOnly({ stateRoot: storeRoot, now: now + 1000 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].address, discovered[0].id);
    assert.equal(activeStateRoots.has(storeRoot), false);
    journal = createLocalMessagingJournal({ stateRoot: storeRoot });
    const whileHostRuns = listLiveAttachedSessionsReadOnly({ stateRoot: storeRoot, now: now + 1000 });
    assert.equal(whileHostRuns.length, 1);
    assert.equal(whileHostRuns[0].address, discovered[0].id);
    assert.throws(() => createLocalMessagingJournal({ stateRoot: storeRoot }), { code: "journal_busy" });
    const { DatabaseSync } = await import("node:sqlite");
    const writer = new DatabaseSync(path.join(storeRoot, "local-messaging.sqlite"));
    writer.exec("BEGIN EXCLUSIVE");
    try {
      assert.throws(() => listLiveAttachedSessionsReadOnly({ stateRoot: storeRoot }), { code: "journal_busy" });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  } finally {
    await journal.close();
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("prepareSend stays quiet when pinning is off and does not invent a runner generation", async () => {
  let described = 0;
  const broker = {
    async describeLocalSession(id) {
      described += 1;
      return { address: id, generation: 4, principal: null, authorityOrigin: null, bindingGeneration: null };
    },
    async validateRequest() {},
  };
  const validator = { validate() { throw new Error("must not authenticate"); } };
  const sender = SESSION_1;
  const recipient = SESSION_2;
  const off = createAttachedReplyIdentity({ credentialValidator: validator, sessionBroker: broker, enabled: false });
  assert.equal(await off.prepareSend({ credential: "cred", senderId: sender, recipientId: recipient, requestId: "off" }), null);
  assert.equal(described, 0);
  const on = createAttachedReplyIdentity({ credentialValidator: validator, sessionBroker: broker, enabled: true });
  assert.equal(await on.prepareSend({ credential: "cred", senderId: sender, recipientId: "c".repeat(64), requestId: "runner" }), null);
  assert.equal(described, 0);
});

test("classifyLane recognizes router deliveryMode", () => {
  assert.deepEqual(classifyLane({ runtimeAdapter: "codex", deliveryMode: "router" }), {
    lane: "router",
    support: "supported",
    reason: null,
  });
});
