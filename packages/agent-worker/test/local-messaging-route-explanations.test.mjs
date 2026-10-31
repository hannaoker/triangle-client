import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createLocalMessagingMcpHandler } from "../src/local-messaging-mcp-adapter.mjs";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createTurnCapabilityIssuer, createTurnCapabilityValidator } from "../src/local-messaging-credentials.mjs";
import { createPerSenderRateLimiter, createConversationLoopTracker } from "../src/local-messaging-rate-limiter.mjs";
import { setupRouter } from "../src/local-messaging-cli.mjs";
import { coded } from "../src/local-messaging-errors.mjs";
import { ATTACH_HINT } from "../src/local-messaging-interactive-session.mjs";
import { REGISTRY_FILE_NAME } from "../src/identity-registry.mjs";
import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { encodeFrame, createMessageParser, createSuccessResponse, PROTOCOL_VERSION } from "../src/local-messaging-protocol.mjs";
import { initIdentityRegistry, bindProfileInRegistry, seedLegacyProfileBinding } from "./local-messaging-identity-fixtures.mjs";

// `sessions` and `discover` answer the same questions for every visible entry: who it is (label, kind, principal and
// whether "none" is known), whether this caller may send and with which address forms, and what delivery path exists
// (route, attachment and capability evidence, delivery explanation). The checks use the real router, registry snapshot,
// socket server and client; only the session brokers are scripted so every attachment case is reproducible.

const SENDER = "a".repeat(64);
const BOB = deriveClientInstanceId("bob");
const CHARLIE = deriveClientInstanceId("charlie");
const DAVE = deriveClientInstanceId("dave");
const sessionId = (char) => `session-${char.repeat(64)}`;
const S_ATTACHED = sessionId("1");
const S_IDLE = sessionId("2");
const S_ENDED = sessionId("3");
const S_VISIBLE = sessionId("4");

const stamp = (id, extra) => ({
  id,
  label: `Claude · workspace · ${id.slice(8, 16)}`,
  kind: "conversation",
  harness: "claude",
  workspace: "/workspace",
  generation: 1,
  presence: "unknown",
  lifecycle: "observed",
  lastSeenAt: 1000,
  presenceEvidence: { kind: "none" },
  ...extra,
});
const closed = { visible: true, reachable: false, wakeCapable: false };
const attachedRow = () => stamp(S_ATTACHED, {
  presence: "online",
  presenceEvidence: { kind: "mcp-lease", observedAt: 1500 },
  attachment: "attached",
  capabilities: { visible: true, reachable: true, wakeCapable: true },
});
// Online by host-process evidence, but no Triangle MCP child is attached: the visible chat cannot receive yet.
const idleRow = () => stamp(S_IDLE, {
  presence: "online",
  presenceEvidence: { kind: "host-process", scope: "session", observedAt: 1500 },
  attachment: "not-attached",
  attachmentHint: ATTACH_HINT,
  capabilities: closed,
});
const endedRow = () => stamp(S_ENDED, {
  presence: "offline",
  lifecycle: "ended",
  presenceEvidence: { kind: "end-event", observedAt: 900 },
  attachment: "ended",
  capabilities: closed,
});
// What lifecycle discovery alone lists: no attachment fields at all, and never reachable.
const visibleOnlyRow = () => stamp(S_VISIBLE, { capabilities: closed });

function privateTmp(prefix) {
  const base = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// A host that answers every discover_recipients call with a fixed payload, however malformed.
async function withFakeHost(payload, run) {
  const dir = privateTmp("tri-route-fake-");
  const socketPath = path.join(dir, "host.sock");
  const server = net.createServer((socket) => {
    const parser = createMessageParser({ onMessage: (message) => socket.write(encodeFrame(createSuccessResponse(message.id, payload))) });
    socket.on("data", (chunk) => parser.feed(chunk));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = createLocalControlClient({ socketPath, senderId: SENDER, turnCredential: "opaque" });
  try {
    return await run(client);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function rawRpc(socketPath, { method, credential, senderId = SENDER, params = {} }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const parser = createMessageParser({
      onMessage: (message) => {
        socket.destroy();
        if (message.error) reject(Object.assign(new Error(`${message.error.code}: ${message.error.message}`), { code: message.error.code }));
        else resolve(message.result);
      },
      onError: (err) => {
        socket.destroy();
        reject(err);
      },
    });
    socket.on("data", (chunk) => parser.feed(chunk));
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(encodeFrame({ protocol_version: PROTOCOL_VERSION, id: "raw-1", method, params, credential, senderId }));
    });
  });
}

function scriptedAcl({ allowed, offline = [] }) {
  const listed = new Set(allowed);
  const down = new Set(offline);
  return {
    async listAuthorizedRecipients() {
      return [...listed];
    },
    async checkAllowed(_sender, to) {
      if (down.has(to)) throw coded("session_offline", "Session MCP child is offline");
      if (!listed.has(to)) throw coded("recipient_not_allowed", "Sender is not authorized for this recipient");
    },
  };
}

// SENDER may message `allowed`. `bound` binds registry profiles (an item can be { profile, principalOf } to share another
// profile's principal). `sessionRows` come from the attached-session broker (the caller's receiver policy already
// applied), `discoveredRows` from lifecycle discovery alone. The router is on only when `enabled`.
async function withWorld(options, run) {
  const {
    enabled = true,
    registry = true,
    corruptRegistry = false,
    bound = [],
    allowed = [BOB, CHARLIE, S_ATTACHED],
    offline = [S_IDLE],
    allowedRecipients = null,
    sessionRows = [attachedRow(), idleRow(), endedRow()],
    discoveredRows = [visibleOnlyRow()],
    directory = [
      { id: BOB, label: "bob", kind: "worker" },
      { id: CHARLIE, label: "charlie", kind: "worker" },
      { id: DAVE, label: "dave", kind: "worker" },
    ],
    withBrokers = true,
    // Whether the caller's credential scope is issued from the live ACL (the bound conversation and attached chats), as
    // opposed to a fixed list (the paired Claude, Grok).
    aclDerivedScope = true,
    routerOverride = null,
    filterDirectory = null,
  } = options;
  const dir = privateTmp("tri-route-srv-");
  const stateRoot = path.join(dir, "state");
  const identityRoot = path.join(dir, "identity");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(identityRoot, { mode: 0o700 });
  const bindings = {};
  if (registry) {
    initIdentityRegistry(identityRoot);
    bound.forEach((item, index) => {
      const { profile, principalOf = null } = typeof item === "string" ? { profile: item } : item;
      const overrides = principalOf ? { principal_id: bindings[principalOf].principal_id } : {};
      bindings[profile] = (principalOf ? seedLegacyProfileBinding : bindProfileInRegistry)(identityRoot, profile, index + 1, overrides);
    });
    if (corruptRegistry) fs.writeFileSync(path.join(identityRoot, REGISTRY_FILE_NAME), "{ not json", { mode: 0o600 });
  }
  if (enabled) setupRouter({ enable: true, registryRoot: identityRoot, stateRoot });
  const secret = "test-secret-32-bytes-long-1234567890";
  const journal = createLocalMessagingJournal({ stateRoot });
  const socketPath = path.join(stateRoot, "local-control.sock");
  const admitted = [];
  const server = createLocalControlServer({
    socketPath,
    journal,
    acl: scriptedAcl({ allowed, offline }),
    credentialValidator: createTurnCapabilityValidator({ secret }),
    dispatcher: { start() {}, stop() {}, notifyAdmission: (job) => admitted.push(job) },
    statusProvider: async () => ({ ok: true, version: 1 }),
    rateLimiter: createPerSenderRateLimiter({ maxRequestsPerWindow: 20, windowMs: 5000 }),
    loopTracker: createConversationLoopTracker({ maxLoopDepth: 10, journal }),
    stateRoot,
    recipientDirectory: directory,
    interactiveRecipients: { has: (id) => id.startsWith("session-") },
    ...(aclDerivedScope ? { inboxBroker: { isDesktopSender: (id) => id === SENDER, validateRequest() {} } } : {}),
    ...(routerOverride ? { router: routerOverride } : {}),
    ...(filterDirectory ? { interactiveBroker: { isInteractiveSender: () => false, validateRequest() {}, filterDirectory } } : {}),
    ...(withBrokers
      ? {
          sessionBroker: {
            async listFor() {
              return sessionRows.map((row) => structuredClone(row));
            },
            async describeLocalSession() {
              return Object.freeze({ address: S_ATTACHED, generation: 1, principal: null, authorityOrigin: null, bindingGeneration: null });
            },
          },
          discoveryBroker: {
            async listFor() {
              return discoveredRows.map((row) => structuredClone(row));
            },
          },
        }
      : {}),
  });
  await server.start();
  const credential = createTurnCapabilityIssuer({ secret }).issue({
    senderId: SENDER,
    ...(allowedRecipients ? { allowedRecipients } : {}),
  });
  const client = createLocalControlClient({ socketPath, senderId: SENDER, turnCredential: credential });
  try {
    return await run({ client, socketPath, credential, bindings, journal, admitted, identityRoot, stateRoot });
  } finally {
    await client.close();
    await server.close();
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rowOf = (rows, id) => rows.find((row) => row.id === id);
const sessionsOf = (client) => client.listSessions();

test("router on: every visible entry says who it is, whether this caller may send, and over which route", async () => {
  await withWorld({ bound: ["bob", "charlie"] }, async ({ client, bindings }) => {
    const rows = await sessionsOf(client);

    const bob = rowOf(rows, BOB);
    assert.equal(bob.route, "local");
    assert.equal(bob.principal, bindings.bob.principal_id);
    assert.equal(bob.principalState, "bound");
    assert.deepEqual(bob.send, { permitted: true, addressKinds: ["id", "principal"] });
    assert.equal(bob.delivery.state, "availability_unknown", "configured workers keep no session-style reachability invented for them");
    assert.equal(Object.hasOwn(bob, "capabilities"), false);
    assert.equal(Object.hasOwn(bob, "attachment"), false);

    const attached = rowOf(rows, S_ATTACHED);
    assert.equal(attached.route, "local");
    assert.equal(attached.principal, null);
    assert.equal(attached.principalState, "unbound", "a chat has no principal and the registry says so");
    assert.deepEqual(attached.send, { permitted: true, addressKinds: ["id"] });
    assert.deepEqual([attached.attachment, attached.capabilities.reachable], ["attached", true]);
    assert.equal(attached.delivery.state, "ready_to_queue");
  });
});

test("online but unattached: the real attachment limit is kept, permission is separate, and a send is refused without a message", async () => {
  await withWorld({ bound: ["bob"] }, async ({ client, journal, admitted }) => {
    const rows = await sessionsOf(client);
    const idle = rowOf(rows, S_IDLE);
    assert.equal(idle.presence, "online", "presence follows its evidence and is not reachability");
    assert.deepEqual(idle.presenceEvidence, { kind: "host-process", scope: "session", observedAt: 1500 });
    assert.equal(idle.attachment, "not-attached");
    assert.equal(idle.attachmentHint, ATTACH_HINT);
    assert.equal(idle.capabilities.reachable, false);
    assert.equal(idle.delivery.state, "not_attached");
    assert.deepEqual(idle.send, { permitted: true, addressKinds: ["id"] }, "the owner's receiver policy allows this caller; the missing piece is the attachment");

    const details = await client.discoverRecipientDetails();
    assert.ok(!details.recipients.includes(S_IDLE), "an unattached chat is not a current send target");
    assert.ok(!details.entries.some((entry) => entry.id === S_IDLE));

    await assert.rejects(client.sendMessage({ to: S_IDLE, text: "anyone there?", messageId: "m-idle" }), { code: "session_offline" });
    assert.equal(await journal.getRecord("m-idle"), null);
    assert.equal(admitted.length, 0);

    const ended = rowOf(rows, S_ENDED);
    assert.deepEqual([ended.presence, ended.attachment, ended.delivery.state], ["offline", "ended", "session_ended"]);
  });
});

test("a chat listed only by lifecycle discovery is visibility, not permission, and invents no attachment evidence", async () => {
  await withWorld({ bound: ["bob"] }, async ({ client }) => {
    const rows = await sessionsOf(client);
    const visible = rowOf(rows, S_VISIBLE);
    assert.equal(visible.route, "local");
    assert.deepEqual(visible.send, { permitted: false, addressKinds: [] });
    assert.equal(visible.delivery.state, "visible_only");
    assert.equal(Object.hasOwn(visible, "attachment"), false);
    assert.equal(Object.hasOwn(visible, "attachmentHint"), false);
    assert.equal(visible.capabilities.reachable, false);
    const details = await client.discoverRecipientDetails();
    assert.ok(!details.recipients.includes(S_VISIBLE));
    await assert.rejects(client.sendMessage({ to: S_VISIBLE, text: "visible is not allowed" }), { code: "recipient_not_allowed" });
  });
});

test("a credential scoped to one recipient shows every other entry as not permitted", async () => {
  await withWorld({ bound: ["bob", "charlie"], allowedRecipients: [BOB] }, async ({ client, bindings }) => {
    const rows = await sessionsOf(client);
    assert.ok(!rows.some((row) => row.id === CHARLIE), "an ACL id outside the credential scope is not listed (unchanged)");
    assert.deepEqual(rowOf(rows, BOB).send, { permitted: true, addressKinds: ["id", "principal"] });
    // Session rows come from the receiver policy, not the credential scope, so they are listed and honestly not sendable.
    assert.deepEqual(rowOf(rows, S_ATTACHED).send, { permitted: false, addressKinds: [] });
    assert.equal(rowOf(rows, S_ATTACHED).delivery.state, "not_permitted", "an attached route this credential cannot use is not ready to queue");
    await assert.rejects(client.sendMessage({ to: S_ATTACHED, text: "scoped out" }), { code: "recipient_not_allowed" });
    // A chat with no attachment cannot be in a credential issued while it was down: the receiver policy decides, and the
    // missing attachment is reported by its own evidence.
    assert.deepEqual(rowOf(rows, S_IDLE).send, { permitted: true, addressKinds: ["id"] });
    assert.equal(rowOf(rows, S_IDLE).delivery.state, "not_attached");
    const details = await client.discoverRecipientDetails();
    assert.deepEqual(details.recipients, [BOB]);
    assert.deepEqual(details.entries.map((entry) => entry.id), [BOB]);
    assert.ok(!JSON.stringify(details).includes(bindings.charlie.principal_id));
  });
});

test("duplicate labels stay separate exact addresses; a label never routes", async () => {
  const directory = [
    { id: BOB, label: "twin", kind: "worker" },
    { id: CHARLIE, label: "twin", kind: "worker" },
  ];
  await withWorld({ bound: ["bob", "charlie"], directory, allowed: [BOB, CHARLIE], sessionRows: [], discoveredRows: [] }, async ({ client, journal }) => {
    const rows = await sessionsOf(client);
    assert.deepEqual(rows.map((row) => [row.label, row.id]), [["twin", BOB], ["twin", CHARLIE]]);
    assert.notEqual(rowOf(rows, BOB).principal, rowOf(rows, CHARLIE).principal);
    for (const row of rows) assert.deepEqual(row.send, { permitted: true, addressKinds: ["id", "principal"] }, row.id);
    const details = await client.discoverRecipientDetails();
    assert.deepEqual(details.entries.map((entry) => entry.id), details.recipients);
    assert.equal(new Set(details.entries.map((entry) => entry.principal)).size, 2, "each twin keeps its own principal");

    await assert.rejects(client.sendMessage({ to: "twin", text: "by label", messageId: "m-label" }), { code: "recipient_not_allowed" });
    assert.equal(await journal.getRecord("m-label"), null);
    const sent = await client.sendMessage({ to: CHARLIE, text: "by id", messageId: "m-id" });
    assert.equal((await journal.getRecord(sent.messageId)).recipient, CHARLIE);
  });
});

test("a principal shared with a recipient the caller cannot see is flagged unusable without naming that recipient", async () => {
  // dave is configured and bound to bob's principal, but this caller may message only bob and charlie.
  const bound = ["bob", "charlie", { profile: "dave", principalOf: "bob" }];
  await withWorld({ bound, allowed: [BOB, CHARLIE], sessionRows: [], discoveredRows: [] }, async ({ client, socketPath, credential, bindings }) => {
    const sharedPrincipal = bindings.bob.principal_id;
    const rows = await sessionsOf(client);
    assert.deepEqual(rowOf(rows, BOB).send, { permitted: true, addressKinds: ["id"] }, "the shared principal is not an address for bob");
    assert.equal(rowOf(rows, BOB).principal, sharedPrincipal);
    assert.deepEqual(rowOf(rows, CHARLIE).send, { permitted: true, addressKinds: ["id", "principal"] });

    const raw = await rawRpc(socketPath, { method: "discover_recipients", credential });
    const byId = new Map(raw.entries.map((entry) => [entry.id, entry]));
    assert.deepEqual(byId.get(BOB).send, { permitted: true, addressKinds: ["id"] });
    assert.deepEqual(byId.get(CHARLIE).send, { permitted: true, addressKinds: ["id", "principal"] });
    for (const output of [JSON.stringify(rows), JSON.stringify(raw)]) {
      assert.ok(!output.includes(DAVE) && !output.includes("dave") && !output.includes(bindings.dave.binding_id), "the unseen candidate stays unseen");
    }

    // The listing and the send path agree.
    await assert.rejects(client.sendMessage({ to: sharedPrincipal, text: "which one?" }), { code: "recipient_ambiguous" });
    const viaPrincipal = await client.sendMessage({ to: bindings.charlie.principal_id, text: "unique principal" });
    assert.equal(viaPrincipal.target.via, "principal");
    const viaId = await client.sendMessage({ to: BOB, text: "exact id" });
    assert.equal(viaId.target.via, "id");
  });
});

test("router off: sessions and discover keep their exact previous shape", async () => {
  await withWorld({ enabled: false, bound: ["bob"] }, async ({ client, socketPath, credential }) => {
    const rows = await sessionsOf(client);
    assert.ok(rows.length >= 5);
    for (const row of rows) {
      for (const key of ["route", "principal", "principalState", "send"]) assert.equal(Object.hasOwn(row, key), false, `${row.id} ${key}`);
      assert.ok(row.delivery, "the delivery explanation does not depend on the router");
    }
    const raw = await rawRpc(socketPath, { method: "discover_recipients", credential });
    assert.deepEqual(Object.keys(raw), ["recipients"]);
    assert.deepEqual(await client.discoverRecipientDetails(), { recipients: raw.recipients });
    // Exactly the previous row: the directory metadata plus the delivery explanation, nothing else.
    assert.deepEqual(rowOf(rows, BOB), {
      id: BOB,
      label: "bob",
      kind: "worker",
      presence: "unknown",
      delivery: {
        state: "availability_unknown",
        summary: "The recipient is configured; live delivery availability is not established.",
        nextAction: "Send only if authorized and check the resulting message status.",
      },
    });
  });
});

test("an unreadable or absent registry says unknown or unbound, never a guess", async () => {
  await withWorld({ bound: ["bob"], corruptRegistry: true }, async ({ client, socketPath, credential }) => {
    const raw = await rawRpc(socketPath, { method: "discover_recipients", credential });
    assert.ok(raw.entries.length > 0);
    for (const entry of raw.entries) {
      assert.equal(entry.principal, null, entry.id);
      assert.equal(entry.principalState, "unknown", entry.id);
      assert.deepEqual(entry.send.addressKinds, ["id"], entry.id);
    }
    for (const row of await sessionsOf(client)) {
      assert.deepEqual([row.principal, row.principalState], [null, "unknown"], row.id);
    }
  });
  await withWorld({ registry: false }, async ({ client }) => {
    for (const row of await sessionsOf(client)) assert.deepEqual([row.principal, row.principalState], [null, "unbound"], row.id);
    const details = await client.discoverRecipientDetails();
    assert.ok(details.entries.every((entry) => entry.principalState === "unbound" && entry.principal === null));
  });
});

test("discover entries carry the same explanation as sessions, through the real client", async () => {
  await withWorld({ bound: ["bob", "charlie"] }, async ({ client, socketPath, credential, bindings }) => {
    const raw = await rawRpc(socketPath, { method: "discover_recipients", credential });
    const expected = raw.recipients.map((id) => {
      const principal = id === BOB ? bindings.bob.principal_id : id === CHARLIE ? bindings.charlie.principal_id : null;
      return {
        id,
        principal,
        principalState: principal ? "bound" : "unbound",
        route: "local",
        send: { permitted: true, addressKinds: principal ? ["id", "principal"] : ["id"] },
      };
    });
    assert.deepEqual(raw, { recipients: raw.recipients, entries: expected });
    assert.deepEqual(await client.discoverRecipientDetails(), { recipients: raw.recipients, entries: expected });
    const rows = await sessionsOf(client);
    for (const entry of expected) {
      const row = rowOf(rows, entry.id);
      assert.deepEqual({ principal: row.principal, principalState: row.principalState, route: row.route, send: row.send }, { principal: entry.principal, principalState: entry.principalState, route: entry.route, send: entry.send }, entry.id);
    }
  });
});

test("the bound MCP tools hand the explanation on unchanged", async () => {
  await withWorld({ bound: ["bob"] }, async ({ client, credential }) => {
    const handler = createLocalMessagingMcpHandler({ client, turnCredential: credential });
    const call = async (name) => {
      const response = await handler.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
      assert.equal(response.result.isError, false, JSON.stringify(response));
      return JSON.parse(response.result.content[0].text);
    };
    assert.deepEqual((await call("triangle_list_sessions")).sessions, await sessionsOf(client));
    assert.deepEqual(await call("triangle_list_recipients"), await client.discoverRecipientDetails());
  });
});

test("only the explanation fields are added: no inventory, binding, authority, process or secret detail reaches an agent", async () => {
  await withWorld({ bound: ["bob", "charlie"] }, async ({ client, bindings }) => {
    const allowedKeys = new Set([
      "id", "label", "title", "kind", "harness", "origin", "workspace", "generation", "presence", "lifecycle", "lastSeenAt",
      "presenceEvidence", "capabilities", "attachment", "attachmentHint", "delivery",
      "principal", "principalState", "route", "send",
    ]);
    const rows = await sessionsOf(client);
    for (const row of rows) {
      for (const key of Object.keys(row)) assert.ok(allowedKeys.has(key), `${row.id} exposes unexpected key ${key}`);
    }
    const everything = JSON.stringify([rows, await client.discoverRecipientDetails()]);
    for (const secret of [bindings.bob.binding_id, bindings.bob.authority_origin, "disk_observation", "mesh-managed", "binding_generation", "profile_instance_id", "_host"]) {
      assert.ok(!everything.includes(secret), `${secret} must not be published`);
    }
  });
});

test("the read-only paths admit nothing, notify nothing and leave the router's send counters and the registry alone", async () => {
  await withWorld({ bound: ["bob", "charlie"] }, async ({ client, journal, admitted, identityRoot, stateRoot }) => {
    const registryFile = path.join(identityRoot, REGISTRY_FILE_NAME);
    const routerFile = path.join(stateRoot, "router.json");
    const filesBefore = [fs.readFileSync(registryFile, "utf8"), fs.readFileSync(routerFile, "utf8")];
    const countersBefore = (await client.localStatus()).router;
    for (let i = 0; i < 3; i++) {
      await sessionsOf(client);
      await client.discoverRecipientDetails();
    }
    const after = await client.localStatus();
    assert.deepEqual(after.router.resolved, countersBefore.resolved, "listing is not a send resolution");
    assert.deepEqual(after.router.errors, countersBefore.errors);
    assert.deepEqual(admitted, []);
    assert.deepEqual([fs.readFileSync(registryFile, "utf8"), fs.readFileSync(routerFile, "utf8")], filesBefore);
    assert.equal((await journal.status()).queued_local ?? 0, 0);
    assert.equal(await journal.getRecord("anything"), null);
  });
});

test("optional explanations are dropped together when they would overflow, never the directory", async () => {
  const configured = Array.from({ length: 140 }, (_, i) => ({ id: ("r" + i).padEnd(250, "x"), label: "l".repeat(128), kind: "worker" }));
  const discovered = Array.from({ length: 90 }, (_, i) => ({
    id: "session-" + i.toString(16).padStart(64, "0"),
    title: "t".repeat(400),
    workspace: "/" + "w".repeat(900),
    capabilities: { visible: true, reachable: false },
  }));
  await withWorld({ directory: configured, allowed: configured.map((row) => row.id), offline: [], sessionRows: [], discoveredRows: discovered }, async ({ client }) => {
    const rows = await sessionsOf(client);
    assert.equal(rows.length, configured.length + discovered.length);
    for (const row of rows) {
      for (const key of ["delivery", "send", "route", "principalState"]) assert.equal(Object.hasOwn(row, key), false, `${key} is part of the optional layer`);
    }
  });
});

test("a caller with a fixed credential scope is never told an unattached chat is sendable", async () => {
  // The paired Claude's credential lists workers only, whatever the owner granted by exact pair, so the receiver policy
  // alone says nothing about what this credential can do. Its answer for a chat that is down is the scope's: not permitted.
  await withWorld({ bound: ["bob"], aclDerivedScope: false, allowedRecipients: [BOB] }, async ({ client }) => {
    const rows = await sessionsOf(client);
    assert.deepEqual(rowOf(rows, S_IDLE).send, { permitted: false, addressKinds: [] });
    assert.equal(rowOf(rows, S_IDLE).delivery.state, "not_attached", "the missing attachment is still the first limit reported");
    assert.deepEqual(rowOf(rows, S_ENDED).send, { permitted: false, addressKinds: [] });
    assert.deepEqual(rowOf(rows, S_ATTACHED).send, { permitted: false, addressKinds: [] });
    assert.equal(rowOf(rows, S_ATTACHED).delivery.state, "not_permitted");
    assert.deepEqual(rowOf(rows, BOB).send.permitted, true);
    await assert.rejects(client.sendMessage({ to: S_ATTACHED, text: "never with this credential" }), { code: "recipient_not_allowed" });
  });
});

test("an explanation that fails never makes a valid directory unreadable", async () => {
  const failing = {
    decorateSessions: ({ sessions }) => ({ sessions }),
    describeAddresses() {
      throw new Error("boom");
    },
    statusBlock: () => ({ enabled: true, registry: { state: "ok", sequence: 1 }, resolved: {}, errors: {} }),
  };
  await withWorld({ enabled: true, routerOverride: failing }, async ({ client }) => {
    const rows = await sessionsOf(client);
    assert.ok(rows.length >= 5);
    for (const row of rows) {
      assert.ok(row.delivery, "the existing delivery explanation survives");
      for (const key of ["route", "principalState", "send"]) assert.equal(Object.hasOwn(row, key), false, key);
    }
    assert.deepEqual(Object.keys(await client.discoverRecipientDetails()), ["recipients"], "entries are simply unavailable");
  });
});

test("rows removed by the sender's directory filter stay removed, and the rest are explained for that sender", async () => {
  const filterDirectory = (_sender, rows) => rows.filter((row) => row.id !== S_ENDED && row.id !== CHARLIE);
  await withWorld({ bound: ["bob"], filterDirectory }, async ({ client }) => {
    const rows = await sessionsOf(client);
    assert.ok(!rows.some((row) => row.id === S_ENDED || row.id === CHARLIE));
    assert.deepEqual(rowOf(rows, BOB).send, { permitted: true, addressKinds: ["id", "principal"] });
    assert.deepEqual(rowOf(rows, S_ATTACHED).send, { permitted: true, addressKinds: ["id"] });
    assert.ok(!JSON.stringify(rows).includes(S_ENDED));
  });
});

// ---- The client's allowlist for the new entry fields ------------------------------------------------------------------

const PA = `agent_${"a".repeat(32)}`;
const PB = `agent_${"b".repeat(32)}`;
const sendOf = (permitted, addressKinds) => ({ permitted, addressKinds });

test("the client passes the new entry fields on only when they are well formed and consistent", async () => {
  const cases = [
    {
      name: "an older host sends only id and principal",
      payload: { recipients: ["a"], entries: [{ id: "a", principal: PA }] },
      expected: { recipients: ["a"], entries: [{ id: "a", principal: PA }] },
    },
    {
      name: "a full explanation passes through in a fixed order, extra fields dropped",
      payload: { recipients: ["a", "b"], entries: [
        { id: "b", principal: null, principalState: "unknown", route: "local", send: { ...sendOf(true, ["id"]), secret: "s" }, token: "t" },
        { id: "a", principal: PA, principalState: "bound", route: "local", send: sendOf(true, ["id", "principal"]) },
      ] },
      expected: { recipients: ["a", "b"], entries: [
        { id: "a", principal: PA, principalState: "bound", route: "local", send: sendOf(true, ["id", "principal"]) },
        { id: "b", principal: null, principalState: "unknown", route: "local", send: sendOf(true, ["id"]) },
      ] },
    },
    {
      name: "a principal state that contradicts the principal is dropped",
      payload: { recipients: ["a", "b"], entries: [{ id: "a", principal: PA, principalState: "unbound" }, { id: "b", principal: null, principalState: "bound" }] },
      expected: { recipients: ["a", "b"], entries: [{ id: "a", principal: PA }, { id: "b", principal: null }] },
    },
    {
      name: "an unknown principal state is dropped",
      payload: { recipients: ["a"], entries: [{ id: "a", principal: null, principalState: "maybe" }] },
      expected: { recipients: ["a"], entries: [{ id: "a", principal: null }] },
    },
    {
      name: "a route other than local is dropped",
      payload: { recipients: ["a"], entries: [{ id: "a", principal: null, route: "iroh" }] },
      expected: { recipients: ["a"], entries: [{ id: "a", principal: null }] },
    },
    ...[
      ["permitted is not a boolean", { permitted: "yes", addressKinds: ["id"] }],
      ["an unknown address kind", { permitted: true, addressKinds: ["id", "alias"] }],
      ["a repeated address kind", { permitted: true, addressKinds: ["id", "id"] }],
      ["address kinds without permission", { permitted: false, addressKinds: ["id"] }],
      ["permission without the id address", { permitted: true, addressKinds: [] }],
      ["a principal address for an entry without a principal", { permitted: true, addressKinds: ["id", "principal"] }, null],
      ["a principal address without the id address", { permitted: true, addressKinds: ["principal"] }, PA],
      ["address kinds that are not a list", { permitted: true, addressKinds: "id" }],
      ["a send that is not an object", ["id"]],
    ].map(([why, send, principal = null]) => ({
      name: `a send explanation with ${why} is dropped`,
      payload: { recipients: ["a"], entries: [{ id: "a", principal, send }] },
      expected: { recipients: ["a"], entries: [{ id: "a", principal }] },
    })),
    {
      name: "a refused send explanation is kept",
      payload: { recipients: ["a"], entries: [{ id: "a", principal: PB, principalState: "bound", send: sendOf(false, []) }] },
      expected: { recipients: ["a"], entries: [{ id: "a", principal: PB, principalState: "bound", send: sendOf(false, []) }] },
    },
  ];
  for (const { name, payload, expected } of cases) {
    await withFakeHost(payload, async (client) => {
      assert.deepEqual(await client.discoverRecipientDetails(), expected, name);
    });
  }
});
