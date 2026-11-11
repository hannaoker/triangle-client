// AD.1 over the wire: owner-set aliases through the real router, registry snapshot, journal, socket server and client
// (docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md, sections 3 and 5). Aliases are written by the real
// writer into a real v2 registry. Only the access list and the session brokers are scripted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ALIAS_PATTERN, deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { clearIdentityAlias, readIdentityRegistry, setIdentityAlias } from "../src/identity-registry.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { setupInteractiveSession, setupLocalMessaging, setupRouter } from "../src/local-messaging-cli.mjs";
import { setupGrok } from "../src/grok-local-session.mjs";
import { createTurnCapabilityIssuer, createTurnCapabilityValidator } from "../src/local-messaging-credentials.mjs";
import { coded } from "../src/local-messaging-errors.mjs";
import { sessionAddress } from "../src/local-messaging-interactive-session.mjs";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createConversationLoopTracker, createPerSenderRateLimiter } from "../src/local-messaging-rate-limiter.mjs";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createMessageParser, encodeFrame, MAX_PAYLOAD_BYTES, PROTOCOL_VERSION } from "../src/local-messaging-protocol.mjs";
import { writePrivateJson } from "../src/local-messaging-auth-broker.mjs";
import { upgradeThroughWriter } from "./identity-registry-v2-helpers.mjs";
import { bindProfileInRegistry, initIdentityRegistry, makeMeshManagedBinding, seedLegacyProfileBinding } from "./local-messaging-identity-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const SENDER = "a".repeat(64);
const BOB = deriveClientInstanceId("bob");
const CHARLIE = deriveClientInstanceId("charlie");
const DAVE = deriveClientInstanceId("dave");
const ERIN = deriveClientInstanceId("erin");
const DEFAULT_DIRECTORY = [
  { id: BOB, label: "bob", kind: "worker" },
  { id: CHARLIE, label: "charlie", kind: "worker" },
  { id: DAVE, label: "dave", kind: "worker" },
];

function privateTmp(prefix) {
  const base = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function rawRpc(socketPath, { method, credential, params = {} }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const parser = createMessageParser({
      onMessage: (message) => {
        socket.destroy();
        if (message.error) reject(Object.assign(new Error(`${message.error.code}: ${message.error.message}`), { code: message.error.code }));
        else resolve(message.result);
      },
      onError: (error) => {
        socket.destroy();
        reject(error);
      },
    });
    socket.on("data", (chunk) => parser.feed(chunk));
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(encodeFrame({ protocol_version: PROTOCOL_VERSION, id: "raw-1", method, params, credential, senderId: SENDER }));
    });
  });
}

function scriptedAcl({ allowed }) {
  const listed = new Set(allowed);
  return {
    async listAuthorizedRecipients() {
      return [...listed];
    },
    async checkAllowed(_sender, to) {
      if (!listed.has(to)) throw coded("recipient_not_allowed", "Sender is not authorized for this recipient");
    },
  };
}

// `bound` binds registry profiles (an item can be { profile, principalOf } for a legacy duplicate that shares another
// profile's principal). `aliases` maps an alias name to the profile whose principal it names. SENDER may message `allowed`.
async function withAliasWorld(options, run) {
  const {
    enabled = true,
    bound = ["bob", "charlie"],
    aliases = {},
    allowed = [BOB],
    scope = null,
    directory = DEFAULT_DIRECTORY,
    sessionRows = () => [],
    upgrade = true,
  } = options;
  const dir = privateTmp("tri-alias-srv-");
  const stateRoot = path.join(dir, "state");
  const identityRoot = path.join(dir, "identity");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(identityRoot, { mode: 0o700 });
  const bindings = {};
  initIdentityRegistry(identityRoot);
  bound.forEach((item, index) => {
    const { profile, principalOf = null } = typeof item === "string" ? { profile: item } : item;
    const overrides = principalOf ? { principal_id: bindings[principalOf].principal_id } : {};
    bindings[profile] = (principalOf ? seedLegacyProfileBinding : bindProfileInRegistry)(identityRoot, profile, index + 1, overrides);
  });
  if (upgrade) {
    upgradeThroughWriter(identityRoot, { now: new Date().toISOString() });
    for (const [alias, profile] of Object.entries(aliases)) {
      setIdentityAlias({ root: identityRoot, expectedSequence: readIdentityRegistry({ root: identityRoot }).registry.sequence, alias, principalId: bindings[profile].principal_id });
    }
  }
  if (enabled) setupRouter({ enable: true, registryRoot: identityRoot, stateRoot });
  const secret = "test-secret-32-bytes-long-1234567890";
  const journal = createLocalMessagingJournal({ stateRoot });
  const socketPath = path.join(stateRoot, "local-control.sock");
  const admitted = [];
  const server = createLocalControlServer({
    socketPath,
    journal,
    acl: scriptedAcl({ allowed }),
    credentialValidator: createTurnCapabilityValidator({ secret }),
    dispatcher: { start() {}, stop() {}, notifyAdmission: (job) => admitted.push(job) },
    statusProvider: async () => ({ ok: true, version: 1 }),
    rateLimiter: createPerSenderRateLimiter({ maxRequestsPerWindow: 200, windowMs: 5000 }),
    loopTracker: createConversationLoopTracker({ maxLoopDepth: 10, journal }),
    stateRoot,
    recipientDirectory: directory,
    interactiveRecipients: { has: (id) => id.startsWith("session-") },
    inboxBroker: { isDesktopSender: (id) => id === SENDER, validateRequest() {} },
    sessionBroker: {
      async listFor() {
        return sessionRows().map((row) => structuredClone(row));
      },
      async describeLocalSession() {
        return Object.freeze({ address: `session-${"1".repeat(64)}`, generation: 1, principal: null, authorityOrigin: null, bindingGeneration: null });
      },
    },
    discoveryBroker: {
      async listFor() {
        return [];
      },
    },
  });
  await server.start();
  // `scope`: the recipients the turn credential itself is limited to (the second half of the send gate, after the access list)
  const credential = createTurnCapabilityIssuer({ secret }).issue({ senderId: SENDER, ...(scope ? { allowedRecipients: scope } : {}) });
  const client = createLocalControlClient({ socketPath, senderId: SENDER, turnCredential: credential });
  try {
    return await run({ client, socketPath, credential, bindings, journal, admitted, identityRoot });
  } finally {
    await client.close();
    await server.close();
    journal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const routerStatus = async ({ socketPath, credential }) => (await rawRpc(socketPath, { method: "local_status", credential })).router;
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { code: error.code, message: error.message };
  }
  return null;
};
const entryOf = (details, id) => details.entries.find((entry) => entry.id === id);

// ---- sending ----------------------------------------------------------------------------------------------------------------------
test("a send by an alias the sender can see is admitted for the aliased recipient and journalled as the principal's", async () => {
  await withAliasWorld({ aliases: { builder: "bob" }, allowed: [BOB] }, async ({ client, bindings, journal, admitted, socketPath, credential }) => {
    const receipt = await client.sendMessage({ to: "builder", text: "hello", messageId: "m-alias", requestId: "r-alias" });
    assert.equal(receipt.accepted, true);
    assert.deepEqual(receipt.target, { via: "principal", principal: bindings.bob.principal_id, profile: "bob" });
    assert.equal(receipt.route, "local");
    for (const raw of ["resolved_via", "to_principal"]) assert.equal(Object.hasOwn(receipt, raw), false, raw);
    assert.deepEqual(admitted.map((job) => job.recipient), [BOB]);

    const record = await journal.getRecord("m-alias");
    assert.deepEqual([record.recipient, record.to_principal, record.resolved_via], [BOB, bindings.bob.principal_id, "alias"]);
    assert.equal(JSON.stringify(record).includes("builder"), false, "the alias name is not stored: the principal is the fact");

    const status = await client.getMessageStatus({ messageId: "m-alias" });
    assert.deepEqual(status.target, { via: "principal", principal: bindings.bob.principal_id, profile: "bob" });

    const router = await routerStatus({ socketPath, credential });
    assert.deepEqual([router.resolved.alias, router.resolved.id, router.errors.alias_unresolved], [1, 0, 0]);
  });
});

test("an alias the sender may not use gets the very answer an unknown name gets: same code, same text, same counters, nothing stored", async () => {
  await withAliasWorld({ aliases: { reviewer: "charlie", builder: "bob" }, allowed: [BOB] }, async ({ client, journal, admitted, socketPath, credential }) => {
    const unknown = await rejection(client.sendMessage({ to: "nobody", text: "x", messageId: "m-unknown" }));
    const before = await routerStatus({ socketPath, credential });
    const invisible = await rejection(client.sendMessage({ to: "reviewer", text: "x", messageId: "m-invisible" }));
    const after = await routerStatus({ socketPath, credential });
    assert.equal(unknown.code, "recipient_not_allowed");
    assert.deepEqual(invisible, unknown, "code and text are the same");
    assert.deepEqual([after.resolved.id - before.resolved.id, after.resolved.alias, after.errors.alias_unresolved], [1, 0, 0], "counted as one more exact id, like the unknown name");
    assert.deepEqual([await journal.getRecord("m-unknown"), await journal.getRecord("m-invisible")], [null, null]);
    assert.equal(admitted.length, 0);
    // for a sender that can see the alias nothing is hidden: the name is usable
    assert.equal((await client.sendMessage({ to: "builder", text: "x", messageId: "m-visible" })).accepted, true);
  });
});

test("a visible alias that cannot be used as it stands fails as alias_unresolved with a reason, and admits nothing", async () => {
  // the name `charlie` is also the label of a recipient this sender may message
  await withAliasWorld({ aliases: { charlie: "bob" }, allowed: [BOB, CHARLIE] }, async ({ client, journal, admitted, socketPath, credential }) => {
    const failure = await rejection(client.sendMessage({ to: "charlie", text: "x", messageId: "m-collide" }));
    assert.deepEqual(failure, { code: "alias_unresolved", message: "alias_collides_with_label" });
    assert.equal(await journal.getRecord("m-collide"), null);
    assert.equal(admitted.length, 0);
    const router = await routerStatus({ socketPath, credential });
    assert.deepEqual([router.errors.alias_unresolved, router.resolved.alias, router.resolved.id], [1, 0, 0]);
    // discovery does not offer the unusable name
    const details = await client.discoverRecipientDetails();
    assert.equal(Object.hasOwn(entryOf(details, BOB).send, "aliases"), false);
  });
  // a sender that may not message the label's recipient has no collision: the alias is just usable, and discovery says so in both
  // tools, whichever half of the send gate (the access list, or the credential's own scope) keeps that recipient out of reach
  for (const world of [{ allowed: [BOB] }, { allowed: [BOB, CHARLIE], scope: [BOB] }]) {
    await withAliasWorld({ aliases: { charlie: "bob" }, ...world }, async ({ client, admitted }) => {
      const receipt = await client.sendMessage({ to: "charlie", text: "x", messageId: "m-no-collision" });
      assert.equal(receipt.accepted, true);
      assert.deepEqual(admitted.map((job) => job.recipient), [BOB]);
      assert.deepEqual(entryOf(await client.discoverRecipientDetails(), BOB).send.aliases, ["charlie"], JSON.stringify(world));
      assert.deepEqual((await client.listSessions()).find((row) => row.id === BOB).send.aliases, ["charlie"], JSON.stringify(world));
    });
  }
  // a principal bound to two local profiles (a legacy duplicate) is ambiguous
  await withAliasWorld({ bound: ["bob", { profile: "erin", principalOf: "bob" }], aliases: { twin: "bob" }, allowed: [BOB], directory: [...DEFAULT_DIRECTORY, { id: ERIN, label: "erin", kind: "worker" }] }, async ({ client }) => {
    assert.deepEqual(await rejection(client.sendMessage({ to: "twin", text: "x", messageId: "m-twin" })), { code: "alias_unresolved", message: "ambiguous_binding" });
  });
});

test("with the router off, or on a registry that is still v1, an alias-shaped name is an exact id that nothing permits", async () => {
  for (const options of [{ enabled: false, aliases: { builder: "bob" } }, { upgrade: false }]) {
    await withAliasWorld({ allowed: [BOB], ...options }, async ({ client, admitted }) => {
      const failure = await rejection(client.sendMessage({ to: "builder", text: "x", messageId: "m-off" }));
      assert.equal(failure.code, "recipient_not_allowed");
      assert.equal(admitted.length, 0);
    });
  }
});

// ---- retries ----------------------------------------------------------------------------------------------------------------------------
test("a retry of an alias send is a duplicate, by the alias or by the principal; a changed principal or a cleared alias is not", async () => {
  await withAliasWorld({ aliases: { builder: "bob", other: "charlie" }, allowed: [BOB, CHARLIE] }, async ({ client, bindings, identityRoot, admitted }) => {
    const sent = { text: "same text", messageId: "m-retry", requestId: "r-retry" };
    const first = await client.sendMessage({ to: "builder", ...sent });
    assert.equal(first.isDuplicate, false);
    assert.equal((await client.sendMessage({ to: "builder", ...sent })).isDuplicate, true, "the same alias");
    assert.equal((await client.sendMessage({ to: bindings.bob.principal_id, ...sent })).isDuplicate, true, "the principal it resolved to is the same intent");
    // every admission the server hands the dispatcher is for that one message and recipient (the dispatcher dedupes retries)
    assert.deepEqual([...new Set(admitted.map((job) => `${job.messageId}:${job.recipient}`))], [`m-retry:${BOB}`]);
    // another principal under the same message id is a changed intent, however it is addressed
    await assert.rejects(client.sendMessage({ to: "other", ...sent }), { code: "duplicate_id_conflict" });
    await assert.rejects(client.sendMessage({ to: bindings.charlie.principal_id, ...sent }), { code: "duplicate_id_conflict" });
    // a retry by exact id is a different intent as well, as it always was for a principal send
    await assert.rejects(client.sendMessage({ to: BOB, ...sent }), { code: "duplicate_id_conflict" });
    // once the owner clears the alias the name is not an alias: the retry is refused as any unknown name is, not answered
    clearIdentityAlias({ root: identityRoot, expectedSequence: readIdentityRegistry({ root: identityRoot }).registry.sequence, alias: "builder" });
    await assert.rejects(client.sendMessage({ to: "builder", ...sent }), { code: "recipient_not_allowed" });
    // the message is still there to ask about
    const status = await client.getMessageStatus({ messageId: "m-retry" });
    assert.equal(status.messageId, "m-retry");
  });
});

// ---- discovery --------------------------------------------------------------------------------------------------------------------------
test("discovery lists the aliases of an entry the caller may message, in the recipients tool and in the sessions tool alike", async () => {
  await withAliasWorld({ aliases: { builder: "bob", alpha: "bob", reviewer: "charlie" }, allowed: [BOB] }, async ({ client, bindings, socketPath, credential }) => {
    const details = await client.discoverRecipientDetails();
    assert.deepEqual(details.recipients, [BOB]);
    assert.deepEqual(entryOf(details, BOB).send, { permitted: true, addressKinds: ["id", "principal"], aliases: ["alpha", "builder"] });
    assert.equal(entryOf(details, BOB).principal, bindings.bob.principal_id);

    const rows = await client.listSessions();
    const bob = rows.find((row) => row.id === BOB);
    assert.deepEqual(bob.send, { permitted: true, addressKinds: ["id", "principal"], aliases: ["alpha", "builder"] });
    // a recipient the caller may not message shows no alias, in either tool
    assert.equal(rows.some((row) => row.id === CHARLIE && row.send?.aliases !== undefined), false);
    // the raw frames carry the same field
    const raw = await rawRpc(socketPath, { method: "discover_recipients", credential });
    assert.deepEqual(raw.entries.find((entry) => entry.id === BOB).send.aliases, ["alpha", "builder"]);
  });
});

test("an alias that is set or cleared shows up in discovery as soon as the registry changes", async () => {
  await withAliasWorld({ aliases: { builder: "bob" }, allowed: [BOB] }, async ({ client, identityRoot, bindings }) => {
    const seq = () => readIdentityRegistry({ root: identityRoot }).registry.sequence;
    assert.deepEqual(entryOf(await client.discoverRecipientDetails(), BOB).send.aliases, ["builder"]);
    setIdentityAlias({ root: identityRoot, expectedSequence: seq(), alias: "second", principalId: bindings.bob.principal_id });
    assert.deepEqual(entryOf(await client.discoverRecipientDetails(), BOB).send.aliases, ["builder", "second"]);
    clearIdentityAlias({ root: identityRoot, expectedSequence: seq(), alias: "builder" });
    clearIdentityAlias({ root: identityRoot, expectedSequence: seq(), alias: "second" });
    assert.equal(Object.hasOwn(entryOf(await client.discoverRecipientDetails(), BOB).send, "aliases"), false);
  });
});

test("alias names with punctuation reach the client in the order it checks, so the list is not dropped", async () => {
  const names = ["a_b", "ab", "a-b", "b", "a9", "a.b", "a0"];
  const sorted = ["a-b", "a.b", "a0", "a9", "a_b", "ab", "b"]; // by code unit; a locale order would put a_b first and the client would drop the list
  await withAliasWorld({ aliases: Object.fromEntries(names.map((name) => [name, "bob"])), allowed: [BOB] }, async ({ client, socketPath, credential }) => {
    assert.deepEqual(entryOf(await client.discoverRecipientDetails(), BOB).send.aliases, sorted);
    assert.deepEqual((await client.listSessions()).find((row) => row.id === BOB).send.aliases, sorted);
    assert.deepEqual((await rawRpc(socketPath, { method: "discover_recipients", credential })).entries.find((entry) => entry.id === BOB).send.aliases, sorted);
  });
});

test("a client from before aliases (62b75c1) keeps its whole send explanation when the host lists alias names", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "frozen-client-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync("git", ["cat-file", "-e", "62b75c1^{commit}"], { cwd: REPO_ROOT, stdio: "ignore" });
  } catch {
    t.skip("git history for 62b75c1 is not available here");
    return;
  }
  const tarball = execFileSync("git", ["archive", "--format=tar", "62b75c1", "packages/agent-worker/src"], { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: tarball });
  const frozen = await import(pathToFileURL(path.join(dir, "packages/agent-worker/src/local-messaging-client.mjs")).href);
  await withAliasWorld({ aliases: { builder: "bob" }, allowed: [BOB] }, async ({ socketPath, credential }) => {
    const old = frozen.createLocalControlClient({ socketPath, senderId: SENDER, turnCredential: credential });
    try {
      const details = await old.discoverRecipientDetails();
      assert.deepEqual(entryOf(details, BOB).send, { permitted: true, addressKinds: ["id", "principal"] }, "kept whole; the field it does not know is dropped");
      assert.equal(entryOf(details, BOB).principalState, "bound");
    } finally {
      await old.close();
    }
  });
});

// ---- the client's projection ----------------------------------------------------------------------------------------------------------
async function viaFakeHost(entrySend, run, entryOverrides = {}) {
  const dir = privateTmp("tri-alias-fake-");
  const socketPath = path.join(dir, "host.sock");
  const principal = `agent_${"1".repeat(32)}`;
  const payload = { recipients: [BOB], entries: [{ id: BOB, principal, principalState: "bound", route: "local", send: entrySend, ...entryOverrides }] };
  const server = net.createServer((socket) => {
    const parser = createMessageParser({
      onMessage: (message) => socket.write(encodeFrame({ protocol_version: PROTOCOL_VERSION, id: message.id, result: payload })),
    });
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

test("the client passes on a well-formed alias list for a permitted entry, and drops a malformed one without losing the rest", async () => {
  const kinds = ["id", "principal"];
  const projected = async (send) => (await viaFakeHost(send, (client) => client.discoverRecipientDetails())).entries[0].send;
  assert.deepEqual(await projected({ permitted: true, addressKinds: kinds, aliases: ["alpha", "builder"] }), { permitted: true, addressKinds: kinds, aliases: ["alpha", "builder"] });
  assert.deepEqual(await projected({ permitted: true, addressKinds: kinds, aliases: ["a", "b", "c", "d", "e", "f", "g", "h"] }), { permitted: true, addressKinds: kinds, aliases: ["a", "b", "c", "d", "e", "f", "g", "h"] });
  const bad = {
    "more than eight": ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
    "not sorted": ["builder", "alpha"],
    "a repeat": ["alpha", "alpha"],
    "a capital": ["Alpha"],
    "an id": [BOB],
    "empty": [],
    "not a list": "alpha",
    "a non-string": [5],
    "a name too long": ["x".repeat(33)],
  };
  for (const [label, aliases] of Object.entries(bad)) {
    assert.deepEqual(await projected({ permitted: true, addressKinds: kinds, aliases }), { permitted: true, addressKinds: kinds }, label);
  }
  // an entry the caller may not message carries no alias, whatever the host says
  assert.deepEqual(await projected({ permitted: false, addressKinds: [], aliases: ["alpha"] }), { permitted: false, addressKinds: [] });
  // an alias names a principal: an entry that has none keeps no alias list, whatever the host says
  const unbound = await viaFakeHost({ permitted: true, addressKinds: ["id"], aliases: ["alpha"] }, (client) => client.discoverRecipientDetails(), { principal: null, principalState: "unbound" });
  assert.deepEqual(unbound.entries[0].send, { permitted: true, addressKinds: ["id"] });
  // an address kind this client does not know still drops the whole explanation, which is why aliases are not a kind
  assert.equal(Object.hasOwn((await viaFakeHost({ permitted: true, addressKinds: ["id", "alias"], aliases: ["alpha"] }, (client) => client.discoverRecipientDetails())).entries[0], "send"), false);
});

// ---- status -----------------------------------------------------------------------------------------------------------------------------
test("local_status reports the address forms of this process, enabled or not", async () => {
  await withAliasWorld({ aliases: { builder: "bob" } }, async ({ socketPath, credential }) => {
    assert.deepEqual((await routerStatus({ socketPath, credential })).registry.addressForms, ["alias", "id", "principal"]);
  });
  await withAliasWorld({ enabled: false, aliases: { builder: "bob" } }, async ({ socketPath, credential }) => {
    const router = await routerStatus({ socketPath, credential });
    assert.deepEqual(router.registry.addressForms, ["id"]);
    assert.equal(router.enabled, false);
  });
});

// ---- size -------------------------------------------------------------------------------------------------------------------------------
test("a directory that alias names push over the payload limit falls back to the plain one, which is still a valid directory", async () => {
  const stamp = (id, pad) => ({
    id,
    label: `chat ${id.slice(8, 16)}${"x".repeat(pad)}`,
    kind: "conversation",
    harness: "claude",
    workspace: "/workspace",
    generation: 1,
    presence: "online",
    lifecycle: "observed",
    lastSeenAt: 1000,
    presenceEvidence: { kind: "mcp-lease", observedAt: 1500 },
    attachment: "attached",
    capabilities: { visible: true, reachable: true, wakeCapable: true },
  });
  const rowCount = 60;
  const ids = Array.from({ length: rowCount }, (_, i) => `session-${String(i).padStart(64, "0")}`);
  let pad = 0;
  await withAliasWorld({ allowed: [BOB, ...ids], sessionRows: () => ids.map((id) => stamp(id, pad)) }, async ({ client, identityRoot, bindings }) => {
    // Whether the directory comes back explained. A directory too big even without explanations is an error, which counts as "not explained".
    const explained = async () => {
      let rows;
      try {
        rows = await client.listSessions();
      } catch (error) {
        if (error.code === "payload_too_large") return false;
        throw error;
      }
      assert.ok(ids.every((id) => rows.some((row) => row.id === id)) && rows.some((row) => row.id === BOB), "every row is listed either way");
      return rows.find((row) => row.id === BOB).send !== undefined;
    };
    // the largest padding at which the explained directory still fits
    let low = 0;
    let high = 8000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      pad = mid;
      if (await explained()) low = mid;
      else high = mid - 1;
    }
    pad = low;
    assert.ok(pad > 100 && pad < 8000, `calibrated at a padding of ${pad}`);
    assert.equal(await explained(), true, "at the calibrated size the directory is explained");
    // eight alias names on one entry add more bytes than the slack that is left
    for (let i = 1; i <= 8; i += 1) {
      setIdentityAlias({ root: identityRoot, expectedSequence: readIdentityRegistry({ root: identityRoot }).registry.sequence, alias: `name${i}`, principalId: bindings.bob.principal_id });
    }
    assert.equal(await explained(), false, "the explanations are dropped, the directory is not");
    const sizeOfPlain = Buffer.byteLength(JSON.stringify({ sessions: await client.listSessions() }), "utf8");
    assert.ok(sizeOfPlain < MAX_PAYLOAD_BYTES);
    // a little less padding fits again, aliases included
    pad = low - 400;
    assert.equal(await explained(), true);
  });
});

// ---- what agents are told ---------------------------------------------------------------------------------------------------------------
test("the tool texts tell an agent where alias names come from, and what to do when one fails", async () => {
  const protocol = await import("../src/local-messaging-protocol.mjs");
  assert.match(protocol.SEND_TOOL_ARGUMENT_DESCRIPTIONS.to, /owner-set alias only when it appears in that entry's send\.aliases/);
  assert.match(protocol.SEND_TOOL_ARGUMENT_DESCRIPTIONS.to, /alias_unresolved/);
  assert.match(protocol.SEND_TOOL_ARGUMENT_DESCRIPTIONS.to, /never a label/);
  assert.match(protocol.LIST_RECIPIENTS_TOOL_DESCRIPTION, /send\.aliases/);
  assert.match(protocol.LIST_SESSIONS_TOOL_DESCRIPTION, /aliases, when present/);
});

// ---- ids ----------------------------------------------------------------------------------------------------------------------------------
test("no id this host mints is shaped like an alias", () => {
  const dir = privateTmp("tri-alias-ids-");
  try {
    const configPath = path.join(dir, "local.json");
    const bindingPath = path.join(dir, "binding.json");
    writePrivateJson(bindingPath, { instanceId: "a".repeat(64), threadId: "old-thread", enabled: false });
    setupLocalMessaging({ config: configPath, "desktop-binding": bindingPath, "thread-id": "new-thread", recipients: ["gravity2"] });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const integration = JSON.parse(fs.readFileSync(config.integrationPath, "utf8"));
    const interactive = setupInteractiveSession({ configPath, stateRoot: path.join(dir, "local") });
    const grok = setupGrok({ alias: "researcher", senders: [], recipients: [] }, configPath, {});
    const minted = {
      "the desktop integration's sender id": integration.senderId,
      "the interactive Claude conversation's sender id": interactive.senderId,
      "a Grok conversation's sender id": grok.senderId,
      "a configured recipient's instance id": config.recipients[0].instanceId,
      "a profile instance id": deriveClientInstanceId("gravity2"),
      "a chat's session address": sessionAddress("a".repeat(32), "/workspace", "chat-1"),
      "a Codex chat's session address": sessionAddress("a".repeat(32), "/workspace", "codex:thread-1"),
      "a principal": makeMeshManagedBinding("gravity2").principal_id,
      "a binding id": makeMeshManagedBinding("gravity2").binding_id,
      "a message id": "5d3b7b1e-9a6f-4c1e-8f43-0a5e1d7c2b11",
    };
    for (const [label, id] of Object.entries(minted)) assert.equal(ALIAS_PATTERN.test(id), false, `${label}: ${id}`);
    // the one thing the host mints that is short, the desktop binding's `bindingId`, is never an address (the check above does not cover it on purpose)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
