import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createLocalMessagingJournal, listHeldRecords, readHeldLateResult } from "../src/local-messaging-journal.mjs";
import { describeMessageDelivery } from "../src/local-messaging-server.mjs";
import { localState } from "../src/transport-adapter-contract.mjs";
import { setupLocalMessaging, runLocalMessagingCLI } from "../src/local-messaging-cli.mjs";
import { readPrivateJson, writePrivateJson } from "../src/local-messaging-auth-broker.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const DB_FILE = "local-messaging.sqlite";
const HOUR = 3600 * 1000;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function fixture() {
  const root = fs.mkdtempSync("/private/tmp/tri-reconcile-");
  let journal = createLocalMessagingJournal({ stateRoot: root });
  return {
    root,
    chat: "session-" + "c".repeat(64),
    sid: randomUUID(),
    get j() { return journal; },
    async reopen() { await journal.close(); journal = createLocalMessagingJournal({ stateRoot: root }); return journal; },
    async close() { await journal?.close(); journal = null; },
    raw(sql, ...args) {
      const db = new DatabaseSync(path.join(root, DB_FILE));
      try { return db.prepare(sql).run(...args); } finally { db.close(); }
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// One held record per cause: crash recovery, runner timeout with a late result, and an interactive reply after the lease.
async function seed(f) {
  await f.j.recordSend({ sender: "alice", recipient: "worker", messageId: "crash", requestId: "crash-req", text: "BODY_CRASH" });
  await f.j.claimExecution("crash");
  await f.reopen();
  await f.j.recordSend({ sender: "alice", recipient: "worker", messageId: "late", requestId: "late-req", text: "BODY_LATE" });
  await f.j.claimExecution("late");
  await f.j.holdExecution("late", "runner_timeout", { lateResultText: "LATE_TEXT" });
  await f.j.recordSend({ sender: "alice", recipient: f.chat, messageId: "chat", requestId: "chat-req", text: "BODY_CHAT", recipientType: "interactive" });
  const claim = await f.j.claimInboxMessage({ messageId: "chat", requester: f.chat, sessionId: f.sid, generation: 1, claimId: "claim-chat", now: 1000, leaseDurationMs: 1000 });
  await assert.rejects(
    f.j.recordInteractiveReply({ messageId: "chat", claimToken: claim.claimToken, sessionId: f.sid, generation: 1, requester: f.chat, text: "CHAT_LATE", replyId: "chat-reply", now: 5000 }),
    { code: "lease_expired" },
  );
  return { claim };
}

const later = (f, text, replyId, claim, now) => f.j.recordInteractiveReply({
  messageId: "chat", claimToken: claim.claimToken, sessionId: f.sid, generation: 1, requester: f.chat, text, replyId, now,
});

test("held lists reconcilable records read-only, without bodies, and shows executing rows as held on next open", async () => {
  const f = fixture();
  try {
    const { claim } = await seed(f);
    await f.j.recordSend({ sender: "alice", recipient: "worker", messageId: "running", requestId: "run-req", text: "BODY_RUNNING" });
    await f.j.claimExecution("running");
    await f.close();

    const dbFile = path.join(f.root, DB_FILE);
    const before = fs.readFileSync(dbFile);
    const items = listHeldRecords({ stateRoot: f.root });
    assert.deepEqual(fs.readFileSync(dbFile), before, "listing leaves the database byte-identical");
    assert.deepEqual(items.map((i) => i.messageId).sort(), ["chat", "crash", "late", "running"]);
    const by = Object.fromEntries(items.map((i) => [i.messageId, i]));

    assert.equal(by.crash.reason, "crash_recovery");
    assert.equal(by.crash.hasLateResult, false);
    assert.deepEqual(by.crash.actions, ["mark-failed"]);
    assert.equal(by.late.reason, "runner_timeout");
    assert.equal(by.late.lateResultBytes, Buffer.byteLength("LATE_TEXT"));
    assert.equal(by.late.lateResultSha256, sha("LATE_TEXT"));
    assert.deepEqual(by.late.actions, ["mark-failed", "accept-late-result"]);
    assert.equal(by.chat.reason, "lease_expired");
    assert.equal(by.chat.lateResultSha256, sha("CHAT_LATE"));
    assert.equal(by.chat.recipientType, "interactive");
    assert.equal(by.running.phase, "executing");
    assert.equal(by.running.effectivePhase, "held");
    assert.equal(by.running.effectiveReason, "crash_recovery");
    assert.deepEqual(by.running.actions, [], "an executing row becomes reconcilable once the next open holds it");
    for (const item of items) assert.match(item.version, /^[0-9a-f]{64}$/);

    const text = JSON.stringify(items);
    for (const secret of ["BODY_", "LATE_TEXT", "CHAT_LATE", claim.claimToken]) assert.equal(text.includes(secret), false, secret);
  } finally { await f.close(); f.cleanup(); }
});

test("held refuses while a journal owner is active and creates nothing when there is no journal", async () => {
  const f = fixture();
  const empty = fs.mkdtempSync("/private/tmp/tri-reconcile-empty-");
  try {
    assert.throws(() => listHeldRecords({ stateRoot: f.root }), { code: "journal_busy" });
    assert.deepEqual(listHeldRecords({ stateRoot: empty }), []);
    assert.deepEqual(fs.readdirSync(empty), [], "looking never creates journal files");
  } finally { await f.close(); f.cleanup(); fs.rmSync(empty, { recursive: true, force: true }); }
});

test("late text is shown only on request, with its hash and an untrusted marker", async () => {
  const f = fixture();
  try {
    await seed(f);
    await f.close();
    const shown = readHeldLateResult({ stateRoot: f.root, messageId: "late" });
    assert.deepEqual(shown, { messageId: "late", sha256: sha("LATE_TEXT"), bytes: 9, untrusted: true, text: "LATE_TEXT" });
    assert.throws(() => readHeldLateResult({ stateRoot: f.root, messageId: "crash" }), { code: "late_result_missing" });
    assert.throws(() => readHeldLateResult({ stateRoot: f.root, messageId: "missing" }), { code: "not_found" });
  } finally { await f.close(); f.cleanup(); }
});

test("mark-failed closes a held record once: no reply, late text cleared, sender sees closed_by_owner, retries are exact", async () => {
  const f = fixture();
  try {
    const { claim } = await seed(f);
    const j = f.j;
    const view = await j.getHeldView("late");
    const args = { messageId: "late", reconcileId: "rc-fail-1", action: "mark-failed", expectVersion: view.version, note: "owner closed" };

    const result = await j.reconcileMessage(args);
    assert.deepEqual(result, { reconcileId: "rc-fail-1", messageId: "late", action: "mark-failed", outcomePhase: "failed", replyMessageId: null, isDuplicate: false });
    const record = await j.getRecord("late");
    assert.equal(record.phase, "failed");
    assert.equal(record.reason, "owner_marked_failed");
    assert.equal(record.hasLateResult, false);
    assert.deepEqual(await j.listReplies({ requester: "alice" }), [], "closing produces no reply");
    assert.equal(localState("failed"), "failed");
    const delivery = describeMessageDelivery(record);
    assert.equal(delivery.state, "closed_by_owner");
    assert.match(delivery.nextAction, /new IDs/);
    assert.equal(JSON.stringify(delivery).includes("owner closed"), false, "the owner's note is never shown to senders");
    assert.deepEqual((await j.getWakeObligations("alice")).heldMessages.map((m) => m.messageId).sort(), ["chat", "crash"]);

    assert.deepEqual(await j.reconcileMessage(args), { ...result, isDuplicate: true });
    await assert.rejects(j.reconcileMessage({ ...args, action: "accept-late-result", expectLateHash: sha("LATE_TEXT") }), { code: "duplicate_id_conflict" });
    await assert.rejects(j.reconcileMessage({ ...args, reconcileId: "rc-fail-2" }), { code: "not_reconcilable" });
    assert.equal((await j.getReconciliation("rc-fail-1")).note, "owner closed");
    assert.equal(await j.getReconciliation("rc-fail-2"), null);

    // An interactive chat answering after the owner closed its record stores nothing.
    const chatView = await j.getHeldView("chat");
    await j.reconcileMessage({ messageId: "chat", reconcileId: "rc-fail-chat", action: "mark-failed", expectVersion: chatView.version });
    await assert.rejects(later(f, "EVEN_LATER", "again", claim, 9000), { code: "reply_not_accepted" });
    assert.equal(await j.getLateResult("chat"), null);

    // Closed records compact with completed ones.
    assert.ok(await j.getRecord("late"));
    await j.compact({ now: Date.now() + 9 * 24 * HOUR });
    assert.equal(await j.getRecord("late"), null);
    assert.ok(await j.getRecord("crash"), "held records are never compacted");
  } finally { await f.close(); f.cleanup(); }
});

test("reconcile refuses unknown, non-held and stale requests and bad arguments without writing anything", async () => {
  const f = fixture();
  try {
    await seed(f);
    const j = f.j;
    await j.recordSend({ sender: "alice", recipient: "worker", messageId: "queued", requestId: "queued-req", text: "BODY_QUEUED" });
    const base = { reconcileId: "rc-x", action: "mark-failed", expectVersion: "a".repeat(64) };
    await assert.rejects(j.reconcileMessage({ ...base, messageId: "missing" }), { code: "not_found" });
    await assert.rejects(j.reconcileMessage({ ...base, messageId: "queued" }), { code: "not_reconcilable" });
    await assert.rejects(j.reconcileMessage({ ...base, messageId: "crash" }), { code: "stale_view" });
    for (const bad of [
      { reconcileId: "bad id!" }, { reconcileId: "x".repeat(129) }, { action: "requeue" }, { action: "replay" },
      { expectVersion: "short" }, { note: "n".repeat(257) }, { messageId: "" },
    ]) {
      await assert.rejects(j.reconcileMessage({ messageId: "crash", ...base, ...bad }), { code: "invalid_params" }, JSON.stringify(bad));
    }
    assert.equal(await j.getReconciliation("rc-x"), null, "no refusal leaves an audit row");
    assert.equal((await j.getRecord("crash")).phase, "held");
  } finally { await f.close(); f.cleanup(); }
});

test("accept-late-result turns the exact late text into one owner-reconciled reply, once", async () => {
  const f = fixture();
  try {
    await seed(f);
    const j = f.j;
    const view = await j.getHeldView("late");
    const args = { messageId: "late", reconcileId: "rc-accept-1", action: "accept-late-result", expectVersion: view.version, expectLateHash: sha("LATE_TEXT") };

    await assert.rejects(j.reconcileMessage({ ...args, expectLateHash: undefined }), { code: "invalid_params" });
    await assert.rejects(j.reconcileMessage({ ...args, expectLateHash: sha("OTHER") }), { code: "late_result_mismatch" });
    assert.equal((await j.getRecord("late")).phase, "held", "a refused accept changes nothing");

    const result = await j.reconcileMessage(args);
    assert.deepEqual(result, { reconcileId: "rc-accept-1", messageId: "late", action: "accept-late-result", outcomePhase: "completed", replyMessageId: "rep-rc-rc-accept-1", isDuplicate: false });
    const record = await j.getRecord("late");
    assert.equal(record.phase, "completed");
    assert.equal(record.hasLateResult, false);
    const replies = await j.listReplies({ requester: "alice" });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].messageId, "rep-rc-rc-accept-1");
    assert.equal(replies[0].sender, "worker");
    assert.equal(replies[0].recipient, "alice");
    assert.equal(replies[0].requestId, "late-req");
    assert.equal(replies[0].inReplyTo, "late");
    assert.equal(replies[0].text, "LATE_TEXT");
    assert.equal(replies[0].metadata._loopDepth, 2);
    assert.deepEqual(replies[0].reconciled, { reconcileId: "rc-accept-1" });
    assert.equal(describeMessageDelivery(record).state, "completed");
    const audit = await j.getReconciliation("rc-accept-1");
    assert.equal(audit.lateResultSha256, sha("LATE_TEXT"));
    assert.equal(JSON.stringify(audit).includes("LATE_TEXT"), false, "the audit keeps a hash, never the text");

    assert.deepEqual(await j.reconcileMessage(args), { ...result, isDuplicate: true });
    assert.equal((await j.listReplies({ requester: "alice" })).length, 1, "an exact retry never creates a second reply");
    await assert.rejects(j.reconcileMessage({ ...args, reconcileId: "rc-accept-2" }), { code: "not_reconcilable" });
  } finally { await f.close(); f.cleanup(); }
});

test("a replaced late result cannot be accepted by its old hash; the chat's later reply is a duplicate or a conflict", async () => {
  const f = fixture();
  try {
    const { claim } = await seed(f);
    const j = f.j;
    const first = await j.getHeldView("chat");
    await assert.rejects(later(f, "CHAT_LATER", "r2", claim, 6000), { code: "reply_not_accepted" });
    const second = await j.getHeldView("chat");
    assert.notEqual(second.version, first.version);
    assert.equal(second.lateResultSha256, sha("CHAT_LATER"));

    const base = { messageId: "chat", reconcileId: "rc-chat", action: "accept-late-result", expectVersion: second.version };
    await assert.rejects(j.reconcileMessage({ ...base, expectLateHash: sha("CHAT_LATE") }), { code: "late_result_mismatch" });
    await assert.rejects(j.reconcileMessage({ ...base, expectVersion: first.version, expectLateHash: sha("CHAT_LATER") }), { code: "stale_view" });
    const accepted = await j.reconcileMessage({ ...base, expectLateHash: sha("CHAT_LATER") });
    assert.equal(accepted.outcomePhase, "completed");
    const reply = (await j.listReplies({ requester: "alice" }))[0];
    assert.equal(reply.sender, f.chat);
    assert.equal(reply.text, "CHAT_LATER");

    const same = await later(f, "CHAT_LATER", undefined, claim, 7000);
    assert.equal(same.isDuplicate, true);
    await assert.rejects(later(f, "SOMETHING_ELSE", undefined, claim, 7000), { code: "duplicate_id_conflict" });
  } finally { await f.close(); f.cleanup(); }
});

test("accept refuses pinned records and records without late text; mark-failed still works on a pinned record", async () => {
  const f = fixture();
  try {
    await seed(f);
    const j = f.j;
    f.raw("UPDATE local_messages SET reply_route_key = 'pin-key' WHERE message_id = ?", "late");
    const pinned = await j.getHeldView("late");
    assert.equal(pinned.pinned, true);
    assert.deepEqual(pinned.actions, ["mark-failed"]);
    await assert.rejects(j.reconcileMessage({ messageId: "late", reconcileId: "rc-pin", action: "accept-late-result", expectVersion: pinned.version, expectLateHash: sha("LATE_TEXT") }), { code: "reply_route_pinned" });

    const crash = await j.getHeldView("crash");
    await assert.rejects(j.reconcileMessage({ messageId: "crash", reconcileId: "rc-none", action: "accept-late-result", expectVersion: crash.version, expectLateHash: sha("x") }), { code: "late_result_missing" });
    const closed = await j.reconcileMessage({ messageId: "late", reconcileId: "rc-pin-close", action: "mark-failed", expectVersion: pinned.version });
    assert.equal(closed.outcomePhase, "failed");
  } finally { await f.close(); f.cleanup(); }
});

test("a failure inside the transaction writes nothing and the retry then succeeds", async () => {
  const f = fixture();
  try {
    await seed(f);
    const j = f.j;
    const view = await j.getHeldView("late");
    const args = { messageId: "late", reconcileId: "rc-atomic", action: "accept-late-result", expectVersion: view.version, expectLateHash: sha("LATE_TEXT") };
    f.raw("CREATE TRIGGER inject BEFORE UPDATE ON local_messages WHEN NEW.phase = 'completed' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await assert.rejects(j.reconcileMessage(args), /injected failure/);
    assert.equal((await j.getRecord("late")).phase, "held");
    assert.deepEqual(await j.listReplies({ requester: "alice" }), []);
    assert.equal(await j.getReconciliation("rc-atomic"), null);
    f.raw("DROP TRIGGER inject");
    assert.equal((await j.reconcileMessage(args)).isDuplicate, false);
    assert.equal((await j.listReplies({ requester: "alice" })).length, 1);
  } finally { await f.close(); f.cleanup(); }
});

test("held and reconcile-message run offline through the CLI and refuse while the service owns the journal", async () => {
  const root = fs.mkdtempSync("/private/tmp/tri-reconcile-cli-");
  try {
    const configPath = path.join(root, "local.json");
    const bindingPath = path.join(root, "desktop.json");
    writePrivateJson(bindingPath, { instanceId: "a".repeat(64) });
    setupLocalMessaging({ config: configPath, "desktop-binding": bindingPath, "thread-id": "reconcile-cli-thread", recipients: ["gravity2"] });
    const config = readPrivateJson(configPath);
    const cli = async (args) => {
      let out = "";
      await runLocalMessagingCLI([...args, "--config", configPath], { output: { write: (s) => { out += s; } } });
      return JSON.parse(out);
    };

    let j = createLocalMessagingJournal({ stateRoot: config.stateRoot });
    await j.recordSend({ sender: "alice", recipient: "worker", messageId: "late", requestId: "late-req", text: "BODY_LATE" });
    await j.claimExecution("late");
    await j.holdExecution("late", "runner_timeout", { lateResultText: "LATE_TEXT" });
    await assert.rejects(cli(["held"]), { code: "journal_busy" });
    await assert.rejects(cli(["reconcile-message", "--message-id", "late", "--reconcile-id", "rc", "--expect-version", "a".repeat(64), "--action", "mark-failed"]), { code: "journal_busy" });
    await j.close();

    const listing = await cli(["held"]);
    assert.equal(JSON.stringify(listing).includes("LATE_TEXT"), false);
    const item = listing.items.find((i) => i.messageId === "late");
    assert.equal(item.lateResultSha256, sha("LATE_TEXT"));
    const shown = await cli(["held", "--show-late-result", "late"]);
    assert.equal(shown.lateResult.text, "LATE_TEXT");
    assert.equal(shown.lateResult.untrusted, true);

    const args = ["reconcile-message", "--message-id", "late", "--reconcile-id", "rc-cli-1", "--expect-version", item.version, "--action", "accept-late-result", "--expect-late-hash", sha("LATE_TEXT"), "--note", "reviewed"];
    const done = await cli(args);
    assert.equal(done.outcomePhase, "completed");
    assert.equal(done.isDuplicate, false);
    assert.equal((await cli(args)).isDuplicate, true);
    await assert.rejects(cli(["reconcile-message", "--message-id", "late", "--reconcile-id", "rc-cli-2", "--expect-version", item.version, "--action", "mark-failed"]), { code: "not_reconcilable" });
    await assert.rejects(cli(["reconcile-message", "--message-id", "late"]), { code: "invalid_arguments" });

    j = createLocalMessagingJournal({ stateRoot: config.stateRoot });
    assert.equal((await j.getRecord("late")).phase, "completed");
    await j.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function loadBaselineJournalModule() {
  const srcDir = path.resolve(import.meta.dirname, "../src");
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "triangle-baseline-"));
  for (const file of fs.readdirSync(srcDir)) {
    if (file.endsWith(".mjs") && file !== "local-messaging-journal.mjs") fs.copyFileSync(path.join(srcDir, file), path.join(dir, file));
  }
  const source = execSync("git show 451eb44:packages/agent-worker/src/local-messaging-journal.mjs", { cwd: path.resolve(import.meta.dirname, "../../.."), encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "local-messaging-journal.mjs"), source);
  return { importModule: () => import(pathToFileURL(path.join(dir, "local-messaging-journal.mjs")).href), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the previous runtime opens a journal with closed and reconciled records and never replays them", async () => {
  const f = fixture();
  const baseline = loadBaselineJournalModule();
  try {
    await seed(f);
    const j = f.j;
    await j.reconcileMessage({ messageId: "late", reconcileId: "rc-old-1", action: "accept-late-result", expectVersion: (await j.getHeldView("late")).version, expectLateHash: sha("LATE_TEXT") });
    await j.reconcileMessage({ messageId: "crash", reconcileId: "rc-old-2", action: "mark-failed", expectVersion: (await j.getHeldView("crash")).version });
    await f.close();

    const { createLocalMessagingJournal: openOld } = await baseline.importModule();
    const old = openOld({ stateRoot: f.root });
    try {
      assert.equal((await old.getRecord("crash")).phase, "failed", "the old reader sees the new phase as plain data");
      assert.equal(await old.claimExecution("crash"), null, "closed work is never started again");
      const recovered = await old.recoverQueued();
      assert.equal(recovered.toRun.some((r) => r.messageId === "crash"), false);
      const status = await old.status();
      assert.equal(status.held, 1, "only the untouched chat record is still held");
      assert.equal(status.completed, 1);
      const replies = await old.listReplies({ requester: "alice" });
      assert.equal(replies.length, 1);
      assert.equal(replies[0].text, "LATE_TEXT");
      await old.compact({ now: Date.now() + 9 * 24 * HOUR });
      assert.ok(await old.getRecord("crash"), "the old compaction leaves closed records in place, which is harmless");
    } finally { await old.close(); }
  } finally { baseline.cleanup(); await f.close(); f.cleanup(); }
});
