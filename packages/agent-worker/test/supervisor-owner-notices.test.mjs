// What the supervisor's warnings put in the owner's log (the supervisor's stderr, client.error.log on macOS).
// The production logger (sanitizedLogger) has no `warn`: a warning the owner needs is sent to `notice` by its
// call site, as a fixed event id and validated fields. These tests drive the real modules with the real
// production logger, pin each line it writes, and show that free-form text (messages, paths, contents) stays off it.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sanitizedLogger } from "../src/client-supervisor-cli.mjs";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createSessionDiscoveryBroker, readPrivateJson, writePrivateJson } from "../src/local-messaging-auth-broker.mjs";
import { createWorkspaceSessionBroker } from "../src/local-messaging-interactive-session.mjs";
import { CHAT_MAPPING_FILENAME } from "../src/local-chat-mapping.mjs";
import { setupLocalMessaging, setupSessionDiscovery, setupWorkspaceMessaging } from "../src/local-messaging-cli.mjs";

const STAMP = "2026-11-20T00:00:00.000Z triangle-client: notice";
// The brokers' own clock (lifecycle events and leases), independent of the log's timestamp.
const CLOCK = 1_800_000_000_000;

function productionLog() {
  const log = { text: "" };
  log.logger = sanitizedLogger({ write: (chunk) => { log.text += chunk; } }, { now: () => Date.parse("2026-11-20T00:00:00.000Z") });
  return log;
}
const lines = (...rows) => rows.map((row) => `${STAMP} ${row}\n`).join("");

function privateRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", prefix)));
}

// The owner's files for a disposable workspace: local messaging, session discovery and workspace session messaging.
function ownerFiles() {
  const root = privateRoot("tri-notice-");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const wrapper = path.join(root, "triangle-local");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const configPath = path.join(root, "local.json");
  const bindingPath = path.join(root, "binding.json");
  writePrivateJson(bindingPath, { instanceId: "a".repeat(64) });
  setupLocalMessaging({ config: configPath, "desktop-binding": bindingPath, "thread-id": "notice-test-thread", recipients: ["gravity2"] });
  setupSessionDiscovery({ config: configPath, workspace, "local-cli": wrapper });
  setupWorkspaceMessaging({ config: configPath, workspace, "local-cli": wrapper });
  return { root, workspace, config: readPrivateJson(configPath) };
}

// ---- the notice itself

test("a notice writes a fixed event id and only validated fields, in a fixed order", () => {
  const log = productionLog();
  log.logger.notice("triangle_client_local_session_messaging_unavailable", { code: "invalid_private_file" });
  log.logger.notice("local_messaging_held_on_recovery", { count: 3 });
  log.logger.notice("triangle_client_local_chat_mapping_unreadable", { code: "EACCES" });
  log.logger.notice("triangle_client_local_session_discovery_unavailable", { code: "ERR_SQLITE_ERROR" });
  log.logger.notice("triangle_client_example", { count: 0, code: "journal_busy", instanceId: "a".repeat(64), profile: "gravity2" });
  assert.equal(log.text, lines(
    "[local_session_messaging_unavailable] code=invalid_private_file",
    "[local_messaging_held_on_recovery] count=3",
    "[local_chat_mapping_unreadable] code=EACCES",
    "[local_session_discovery_unavailable] code=ERR_SQLITE_ERROR",
    "[example] profile=gravity2 instance=aaaaaaaaaaaa code=journal_busy count=0",
  ));
});

test("a notice drops a code or a count that is not one, and never prints text, paths or tokens", () => {
  const log = productionLog();
  const event = "triangle_client_local_chat_mapping_unreadable";
  const notCodes = [
    "chat mapping store at /private/tmp/owner-state is unreadable", // a message
    "/private/tmp/owner-state", // a path
    "ENOENT: no such file or directory, open '/private/tmp/owner-state'", // a Node error message
    "SyntaxError", // a class name, not a code
    "mesh_watch_token", "invalid_mesh_secret", "EMESH_TOKEN", // credential-shaped
    "deadbeefdeadbeef", "key_0123456789abcdef0123", "EABCDEF0123456789", // runs of hex: keys and ids
    `e${"a".repeat(64)}`, "", // too long, empty
    42, null, undefined, { code: "invalid_private_file" }, ["invalid_private_file"],
  ];
  for (const code of notCodes) log.logger.notice(event, { code });
  const notCounts = [-1, 1.5, "3", Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null, { count: 1 }];
  for (const count of notCounts) log.logger.notice(event, { count });
  log.logger.notice(event, "free-form detail /private/tmp/owner-state");
  log.logger.notice(event, null);
  // Not an event id: nothing at all is written.
  log.logger.notice("Chat mapping store at /private/tmp/owner-state is unreadable", { code: "chat_mapping_corrupt" });
  log.logger.notice("triangle_client_mesh_watch_rejected", { code: "watch_rejected" });
  assert.equal(log.text, lines(...Array(notCodes.length + notCounts.length + 2).fill("[local_chat_mapping_unreadable]")));
});

test("the production logger has no channel for free-form warnings", () => {
  const log = productionLog();
  assert.equal(log.logger.warn, undefined, "no warn: modules that warn with messages, paths or child output stay quiet");
  assert.equal(log.logger.info, undefined);
  // The free-form warnings the supervisor can reach, as their call sites write them.
  for (const text of [
    "Socket parser error: Failed to parse frame JSON payload",
    "Session discovery unavailable; configured recipients remain available",
    "Workspace session messaging unavailable (invalid_private_file); configured recipients remain available",
    "chat mapping store at /private/tmp/owner-state is unreadable (chat_mapping_corrupt); treating the session as unmapped",
  ]) {
    log.logger.warn?.(text);
    log.logger.info?.(text);
    log.logger.notice(text, { code: "chat_mapping_corrupt" });
  }
  assert.equal(log.text, "");
});

// ---- the local journal

test("local work held after a restart is counted in the owner's log, once, without its text", async () => {
  const stateRoot = privateRoot("tri-notice-held-");
  try {
    const before = createLocalMessagingJournal({ stateRoot });
    for (const n of [1, 2]) {
      await before.recordSend({ sender: "alice", recipient: "bob", messageId: `m-${n}`, requestId: `r-${n}`, text: `in flight ${n} ${stateRoot}` });
      await before.claimExecution(`m-${n}`);
    }
    await before.recordSend({ sender: "alice", recipient: "bob", messageId: "m-queued", requestId: "r-queued", text: "still queued" });
    await before.close();

    const log = productionLog();
    const after = createLocalMessagingJournal({ stateRoot, logger: log.logger });
    assert.equal((await after.getRecord("m-1")).reason, "crash_recovery");
    assert.equal((await after.getRecord("m-queued")).phase, "queued_local", "queued work is not held, and not counted");
    await after.close();
    assert.equal(log.text, lines("[local_messaging_held_on_recovery] count=2"));

    // Work that is already held stays held: the next start has nothing new to say.
    const again = createLocalMessagingJournal({ stateRoot, logger: log.logger });
    await again.close();
    assert.equal(log.text, lines("[local_messaging_held_on_recovery] count=2"));
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("a journal moved from its old file names is reported once, with the number of files moved", async () => {
  const stateRoot = privateRoot("tri-notice-adopt-");
  try {
    const old = createLocalMessagingJournal({ stateRoot });
    await old.recordSend({ sender: "alice", recipient: "bob", messageId: "m-old", requestId: "r-old", text: "queued before the rename" });
    await old.close();
    fs.renameSync(path.join(stateRoot, "local-messaging.sqlite"), path.join(stateRoot, "peer-drain.sqlite"));
    fs.renameSync(path.join(stateRoot, "local-messaging-owner.sqlite"), path.join(stateRoot, "peer-drain-owner.sqlite"));

    const log = productionLog();
    const adopted = createLocalMessagingJournal({ stateRoot, logger: log.logger });
    assert.equal((await adopted.getRecord("m-old")).text, "queued before the rename");
    await adopted.close();
    assert.equal(log.text, lines("[local_messaging_journal_adopted] count=2"));

    const again = createLocalMessagingJournal({ stateRoot, logger: log.logger });
    await again.close();
    assert.equal(log.text, lines("[local_messaging_journal_adopted] count=2"), "only the move itself is reported");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ---- session discovery and workspace session messaging

test("session discovery that cannot be read is reported once per outage, as a code", async () => {
  const f = ownerFiles();
  const journal = createLocalMessagingJournal({ stateRoot: f.config.stateRoot });
  try {
    const integrationPath = f.config.discovery.integrationPath;
    const good = fs.readFileSync(integrationPath, "utf8");
    const reader = JSON.parse(good).readerIds[0];
    const log = productionLog();
    const broker = createSessionDiscoveryBroker({ integrationPath, journal, logger: log.logger });
    assert.deepEqual(await broker.listFor(reader), []);
    assert.equal(log.text, "", "a healthy listing says nothing");

    fs.writeFileSync(integrationPath, `{ not json ${f.root}`);
    for (let i = 0; i < 3; i += 1) assert.deepEqual(await broker.listFor(reader), []);
    assert.equal(log.text, lines("[local_session_discovery_unavailable] code=invalid_private_file"));

    // A listing that works again ends the outage; the next one is reported on its own.
    fs.writeFileSync(integrationPath, good);
    assert.deepEqual(await broker.listFor(reader), []);
    fs.rmSync(integrationPath);
    await broker.listFor(reader);
    await broker.listFor(reader);
    assert.equal(log.text, lines(
      "[local_session_discovery_unavailable] code=invalid_private_file",
      "[local_session_discovery_unavailable] code=ENOENT",
    ));
    assert.ok(!log.text.includes(f.root) && !log.text.includes("not json"), "no paths, no contents");
  } finally {
    await journal.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("workspace session messaging that cannot be read is reported once per failure, as a code", async () => {
  const f = ownerFiles();
  const journal = createLocalMessagingJournal({ stateRoot: f.config.stateRoot });
  try {
    const policyPath = f.config.sessionMessaging.integrationPath;
    const good = fs.readFileSync(policyPath, "utf8");
    const owner = JSON.parse(good).allowedSenders[0];
    const log = productionLog();
    const broker = createWorkspaceSessionBroker({ policyPath, discoveryPath: f.config.discovery.integrationPath, journal, issue() {}, logger: log.logger });
    const probe = async () => [await broker.listFor(owner), broker.allowedRecipients().length];
    assert.deepEqual(await probe(), [[], 1]);
    assert.equal(log.text, "");

    fs.writeFileSync(policyPath, `{ not json ${f.root}`);
    for (let i = 0; i < 3; i += 1) assert.deepEqual(await probe(), [[], 0]);
    assert.equal(log.text, lines("[local_session_messaging_unavailable] code=invalid_private_file"));

    // Recovery is silent; a different failure is reported on its own, and so is the first one after a recovery.
    fs.writeFileSync(policyPath, good);
    assert.deepEqual(await probe(), [[], 1]);
    fs.renameSync(f.workspace, `${f.workspace}-moved`);
    await probe();
    fs.renameSync(`${f.workspace}-moved`, f.workspace);
    assert.deepEqual(await probe(), [[], 1]);
    fs.writeFileSync(policyPath, "{ not json");
    await probe();
    assert.equal(log.text, lines(
      "[local_session_messaging_unavailable] code=invalid_private_file",
      "[local_session_messaging_unavailable] code=workspace_missing",
      "[local_session_messaging_unavailable] code=invalid_private_file",
    ));
    assert.ok(!log.text.includes(f.root) && !log.text.includes("not json"), "no paths, no contents");
  } finally {
    await journal.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

// ---- the chat mapping store

test("an unreadable chat mapping store is reported as a code, never with its path, and nothing goes to console.error", async () => {
  const f = ownerFiles();
  const journal = createLocalMessagingJournal({ stateRoot: f.config.stateRoot });
  const printed = [];
  const consoleError = console.error;
  try {
    const policyPath = f.config.sessionMessaging.integrationPath;
    const policy = readPrivateJson(policyPath);
    const scope = `${policy.installationId}:${createHash("sha256").update(policy.secret).digest("hex")}`;
    // A live, attached chat, as the directory lists it.
    await journal.recordDiscoveryEvent({
      installationId: policy.installationId,
      event: { eventId: randomUUID(), sessionId: randomUUID(), kind: "start", workspace: policy.workspace, observedAt: CLOCK - 1000 },
      digest: "d1", receivedAt: CLOCK,
    });
    const [row] = await journal.listDiscoveredSessions({ installationId: policy.installationId, workspace: policy.workspace });
    await journal.attachDiscoveredSession({ id: row.id, childId: randomUUID(), generation: row.generation, installationId: scope, wakeCapable: false, now: CLOCK });
    const log = productionLog();
    const broker = createWorkspaceSessionBroker({
      policyPath, discoveryPath: f.config.discovery.integrationPath, journal, issue() {}, clock: () => CLOCK,
      ownerSenderId: readPrivateJson(f.config.integrationPath).senderId, configuredRecipients: f.config.recipients.map((r) => r.instanceId),
      chatMappingStoreRoot: f.config.stateRoot, confirmChatBinding: () => true, logger: log.logger,
    });
    const mappingFile = path.join(f.config.stateRoot, CHAT_MAPPING_FILENAME);
    fs.writeFileSync(mappingFile, `{ ${f.root}`, { mode: 0o600 });

    console.error = (...args) => { printed.push(args.join(" ")); };
    assert.equal((await broker.describeLocalSession(row.id)).principal, null, "the chat stays unlabeled");
    await broker.describeLocalSession(row.id);
    assert.equal(log.text, lines("[local_chat_mapping_unreadable] code=chat_mapping_corrupt"), "an unchanged file is reported once");
    fs.chmodSync(mappingFile, 0o644);
    await broker.describeLocalSession(row.id);
    console.error = consoleError;

    assert.equal(log.text, lines(
      "[local_chat_mapping_unreadable] code=chat_mapping_corrupt",
      "[local_chat_mapping_unreadable] code=chat_mapping_custody",
    ));
    assert.deepEqual(printed, [], "the store's message (it names the path) is not printed some other way");
    assert.ok(!log.text.includes(f.root), "no paths");
  } finally {
    console.error = consoleError;
    await journal.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
