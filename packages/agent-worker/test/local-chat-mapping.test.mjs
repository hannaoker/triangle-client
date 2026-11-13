import test from "node:test";
import assert from "node:assert/strict";
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
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createUnifiedRouter } from "../src/unified-router.mjs";
import { classifyLane } from "../src/installation-inventory.mjs";

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
      destination: { harness: "claude", workspace: realWs },
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
      destination: { harness: "claude", workspace: realWs },
      attachedSessions: [{ address: SESSION_1, harness: "claude", workspace: realWs }],
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.sessionAddress, SESSION_1);

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
      destination: { harness: "claude", workspace: realWs },
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

test("classifyLane recognizes router deliveryMode", () => {
  assert.deepEqual(classifyLane({ runtimeAdapter: "codex", deliveryMode: "router" }), {
    lane: "router",
    support: "supported",
    reason: null,
  });
});
