import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { validateJournalAdapter, REQUIRED_JOURNAL_METHODS } from "../src/local-messaging-journal-contract.mjs";
import { LocalMessagingError } from "../src/local-messaging-errors.mjs";

function createIsolatedStateRoot(prefix = "triangle-prod-journal-") {
  const realTmp = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(realTmp, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

test("production journal implements REQUIRED_JOURNAL_METHODS and contract validation", async () => {
  const stateRoot = createIsolatedStateRoot();
  let journal;
  try {
    journal = createLocalMessagingJournal({ stateRoot });
    assert.equal(validateJournalAdapter(journal), journal);

    for (const method of REQUIRED_JOURNAL_METHODS) {
      assert.equal(typeof journal[method], "function", `Missing required method ${method}`);
    }
    for (const method of ["recoverQueued", "claimExecution", "completeExecution", "holdExecution", "status", "close"]) {
      assert.equal(typeof journal[method], "function", `Missing lifecycle/execution method ${method}`);
    }
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("production journal enforces 0700 directory and 0600 file permissions and rejects symlinks", async () => {
  const stateRoot = createIsolatedStateRoot();
  let journal;
  try {
    journal = createLocalMessagingJournal({ stateRoot });
    await journal.recordSend({
      sender: "alice",
      recipient: "bob",
      messageId: "msg-perm-1",
      requestId: "req-1",
      text: "hello",
    });

    const dbFile = path.join(stateRoot, "local-messaging.sqlite");
    assert.ok(fs.existsSync(dbFile), "journal db file must exist");
    const stat = fs.statSync(dbFile);
    assert.equal(stat.mode & 0o777, 0o600, "database file must have 0600 mode");

    await journal.close();

    // Rejects symlink state root
    const symlinkRoot = path.join(stateRoot, "symlink-dir");
    fs.symlinkSync(stateRoot, symlinkRoot);
    assert.throws(
      () => createLocalMessagingJournal({ stateRoot: symlinkRoot }),
      (err) => err.code === "unsafe_path" || err.code === "unsafe_state_root",
    );
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("exclusive owner: competing journal on same stateRoot is rejected and close releases ownership", async () => {
  const stateRoot = createIsolatedStateRoot();
  let j1;
  let j2;
  try {
    j1 = createLocalMessagingJournal({ stateRoot });

    // Competing open fails with busy code
    assert.throws(
      () => createLocalMessagingJournal({ stateRoot }),
      (err) => err.code === "journal_busy" || err.code === "drain_busy",
      "Competing journal instance on same stateRoot must fail",
    );

    // After close, reopening succeeds
    await j1.close();

    j2 = createLocalMessagingJournal({ stateRoot });
    const stat = await j2.status();
    assert.ok(stat, "reopened journal provides status");
  } finally {
    await j1?.close();
    await j2?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("real SQLite reopening persistence preserves queued and reply records", async () => {
  const stateRoot = createIsolatedStateRoot();
  let j1;
  let j2;
  try {
    j1 = createLocalMessagingJournal({ stateRoot });
    await j1.recordSend({
      sender: "alice",
      recipient: "bob",
      messageId: "msg-reopen-1",
      requestId: "req-1",
      text: "preserve me",
      metadata: { priority: "high", _loopDepth: 1 },
    });

    await j1.recordReply({
      sender: "bob",
      recipient: "alice",
      messageId: "rep-reopen-1",
      requestId: "req-1",
      inReplyTo: "msg-reopen-1",
      text: "preserved reply",
    });

    await j1.close();

    // Reopen in new instance
    j2 = createLocalMessagingJournal({ stateRoot });
    const msg = await j2.getRecord("msg-reopen-1");
    assert.ok(msg);
    assert.equal(msg.messageId, "msg-reopen-1");
    assert.equal(msg.text, "preserve me");
    assert.equal(msg.metadata.priority, "high");
    assert.equal(msg.metadata._loopDepth, 1);

    const replies = await j2.listReplies({ requester: "alice", requestId: "req-1" });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].messageId, "rep-reopen-1");
    assert.equal(replies[0].text, "preserved reply");
  } finally {
    await j1?.close();
    await j2?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("atomic full immutable envelope duplicate returns isDuplicate: true; conflict throws duplicate_id_conflict", async () => {
  const stateRoot = createIsolatedStateRoot();
  let journal;
  try {
    journal = createLocalMessagingJournal({ stateRoot });

    const rec = await journal.recordSend({
      sender: "alice",
      recipient: "bob",
      messageId: "msg-dup-1",
      requestId: "req-1",
      inReplyTo: null,
      text: "deterministic content",
      metadata: { keyA: 1, keyB: { nested: true, tags: ["x", "y"] } },
    });
    assert.equal(rec.isDuplicate, false);
    assert.equal(rec.phase, "queued_local");

    // Identical envelope with different key ordering
    const dup = await journal.recordSend({
      sender: "alice",
      recipient: "bob",
      messageId: "msg-dup-1",
      requestId: "req-1",
      inReplyTo: null,
      text: "deterministic content",
      metadata: { keyB: { tags: ["x", "y"], nested: true }, keyA: 1 },
    });
    assert.equal(dup.isDuplicate, true);

    // Conflicting text
    await assert.rejects(
      async () => journal.recordSend({
        sender: "alice",
        recipient: "bob",
        messageId: "msg-dup-1",
        requestId: "req-1",
        inReplyTo: null,
        text: "changed content",
        metadata: { keyA: 1, keyB: { nested: true, tags: ["x", "y"] } },
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );

    // Conflicting requestId
    await assert.rejects(
      async () => journal.recordSend({
        sender: "alice",
        recipient: "bob",
        messageId: "msg-dup-1",
        requestId: "req-different",
        inReplyTo: null,
        text: "deterministic content",
        metadata: { keyA: 1, keyB: { nested: true, tags: ["x", "y"] } },
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );

    // Conflicting metadata
    await assert.rejects(
      async () => journal.recordSend({
        sender: "alice",
        recipient: "bob",
        messageId: "msg-dup-1",
        requestId: "req-1",
        inReplyTo: null,
        text: "deterministic content",
        metadata: { keyA: 2 },
      }),
      (err) => err instanceof LocalMessagingError && err.code === "duplicate_id_conflict",
    );
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("reply correlation verifies expected sender, recipient, and requestId, rejecting forgeries", async () => {
  const stateRoot = createIsolatedStateRoot();
  let journal;
  try {
    journal = createLocalMessagingJournal({ stateRoot });

    await journal.recordSend({
      sender: "alice",
      recipient: "bob",
      messageId: "msg-req-corr",
      requestId: "req-corr",
      text: "request body",
    });

    // Forged recipient (not addressed to original sender)
    await assert.rejects(
      async () => journal.recordReply({
        sender: "bob",
        recipient: "eve",
        messageId: "rep-forged-1",
        requestId: "req-corr",
        inReplyTo: "msg-req-corr",
        text: "reply",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "invalid_reply_recipient",
    );

    // Forged sender (not sent by original recipient)
    await assert.rejects(
      async () => journal.recordReply({
        sender: "eve",
        recipient: "alice",
        messageId: "rep-forged-2",
        requestId: "req-corr",
        inReplyTo: "msg-req-corr",
        text: "reply",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "invalid_reply_sender",
    );

    // Mismatched requestId
    await assert.rejects(
      async () => journal.recordReply({
        sender: "bob",
        recipient: "alice",
        messageId: "rep-forged-3",
        requestId: "req-wrong",
        inReplyTo: "msg-req-corr",
        text: "reply",
      }),
      (err) => err instanceof LocalMessagingError && err.code === "invalid_reply_correlation",
    );

    // Valid reply succeeds
    const rep = await journal.recordReply({
      sender: "bob",
      recipient: "alice",
      messageId: "rep-corr-valid",
      requestId: "req-corr",
      inReplyTo: "msg-req-corr",
      text: "valid reply",
    });
    assert.equal(rep.isDuplicate, false);
    assert.equal(rep.consumed, false);
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("foreign reply isolation, byte-bounded retrieval, and explicit consumption", async () => {
  const stateRoot = createIsolatedStateRoot();
  let journal;
  try {
    journal = createLocalMessagingJournal({ stateRoot });

    await journal.recordSend({
      sender: "alice",
      recipient: "bob",
      messageId: "msg-isolation-1",
      requestId: "req-iso-1",
      text: "task 1",
    });
    await journal.recordReply({
      sender: "bob",
      recipient: "alice",
      messageId: "rep-iso-1",
      requestId: "req-iso-1",
      inReplyTo: "msg-isolation-1",
      text: "reply 1 " + "a".repeat(100),
    });
    await journal.recordReply({
      sender: "bob",
      recipient: "alice",
      messageId: "rep-iso-2",
      requestId: "req-iso-1",
      inReplyTo: "msg-isolation-1",
      text: "reply 2 " + "b".repeat(100),
    });

    // Foreign requester sees nothing
    const eveList = await journal.listReplies({ requester: "eve" });
    assert.equal(eveList.length, 0);

    // Foreign consume rejected
    await assert.rejects(
      async () => journal.consumeReply({ requester: "eve", messageId: "rep-iso-1" }),
      (err) => err instanceof LocalMessagingError && err.code === "foreign_access_denied",
    );

    // Bounded paging progress with limit
    const page1 = await journal.listReplies({ requester: "alice", limit: 1 });
    assert.equal(page1.length, 1);
    assert.equal(page1[0].messageId, "rep-iso-1");
    assert.ok(page1[0].cursor, "cursor must be present for paging progress");

    const page2 = await journal.listReplies({ requester: "alice", limit: 1, cursor: page1[0].cursor });
    assert.equal(page2.length, 1);
    assert.equal(page2[0].messageId, "rep-iso-2");

    // Explicit consumption
    const consumeRes = await journal.consumeReply({ requester: "alice", messageId: "rep-iso-1" });
    assert.equal(consumeRes.consumed, true);

    const remaining = await journal.listReplies({ requester: "alice" });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].messageId, "rep-iso-2");
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("recoverQueued resumes queued records and holds uncertain executing records without replay", async () => {
  const stateRoot = createIsolatedStateRoot();
  let j1;
  let j2;
  try {
    j1 = createLocalMessagingJournal({ stateRoot });

    await j1.recordSend({
      sender: "alice",
      recipient: "bob",
      messageId: "msg-queued-pending",
      requestId: "req-1",
      text: "still in queue",
    });

    await j1.recordSend({
      sender: "alice",
      recipient: "bob",
      messageId: "msg-was-executing",
      requestId: "req-2",
      text: "was in-flight when process died",
    });

    // Claim second execution to move to 'executing'
    const claimed = await j1.claimExecution("msg-was-executing");
    assert.ok(claimed);

    const recBeforeCrash = await j1.getRecord("msg-was-executing");
    assert.equal(recBeforeCrash.phase, "executing");

    await j1.close();

    // Recover in new process instance
    j2 = createLocalMessagingJournal({ stateRoot });
    const recovery = await j2.recoverQueued();

    // Queued work resumes
    assert.ok(recovery.toRun.some((r) => r.messageId === "msg-queued-pending"));

    // Uncertain started execution is held, NOT in toRun
    assert.equal(recovery.toRun.some((r) => r.messageId === "msg-was-executing"), false);
    assert.ok(recovery.uncertain.some((r) => r.messageId === "msg-was-executing"));

    const recAfterRecovery = await j2.getRecord("msg-was-executing");
    assert.equal(recAfterRecovery.phase, "held");
    assert.equal(recAfterRecovery.reason, "crash_recovery");
  } finally {
    await j1?.close();
    await j2?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("claimExecution is atomic, completeExecution marks completed, holdExecution marks held", async () => {
  const stateRoot = createIsolatedStateRoot();
  let journal;
  try {
    journal = createLocalMessagingJournal({ stateRoot });

    await journal.recordSend({
      sender: "alice",
      recipient: "bob",
      messageId: "msg-exec-lifecycle",
      requestId: "req-life",
      text: "execute me",
    });

    // First claim succeeds
    const c1 = await journal.claimExecution("msg-exec-lifecycle");
    assert.ok(c1);

    // Second claim fails (already executing)
    const c2 = await journal.claimExecution("msg-exec-lifecycle");
    assert.equal(c2, null);

    // Complete execution
    await journal.completeExecution("msg-exec-lifecycle");
    const recCompleted = await journal.getRecord("msg-exec-lifecycle");
    assert.equal(recCompleted.phase, "completed");

    // Hold another message
    await journal.recordSend({
      sender: "alice",
      recipient: "bob",
      messageId: "msg-to-hold",
      requestId: "req-hold",
      text: "hold me",
    });
    await journal.holdExecution("msg-to-hold", "quota_exceeded");
    const recHeld = await journal.getRecord("msg-to-hold");
    assert.equal(recHeld.phase, "held");
    assert.equal(recHeld.reason, "quota_exceeded");

    // Status aggregates bounds
    const stat = await journal.status();
    assert.equal(stat.completed, 1);
    assert.equal(stat.held, 1);
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('failed schema initialization releases journal ownership for repair',async()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'tri-schema-'));
 const {DatabaseSync}=await import('node:sqlite');
 const dbPath=path.join(root,'local-messaging.sqlite');
 const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE local_messages(message_id TEXT)');db.close();fs.chmodSync(dbPath,0o600);
 try{
  assert.throws(()=>createLocalMessagingJournal({stateRoot:root}),e=>e.code==='ERR_SQLITE_ERROR');
  assert.throws(()=>createLocalMessagingJournal({stateRoot:root}),e=>e.code==='ERR_SQLITE_ERROR');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("the late-result column is added to an existing journal without touching rows and is idempotent", async () => {
  const stateRoot = createIsolatedStateRoot();
  const { DatabaseSync } = await import("node:sqlite");
  const columns = (file) => {
    const db = new DatabaseSync(file);
    try { return db.prepare("PRAGMA table_info(local_messages)").all().map((c) => c.name); } finally { db.close(); }
  };
  try {
    const first = createLocalMessagingJournal({ stateRoot });
    await first.recordSend({ sender: "alice", recipient: "bob", messageId: "msg-old-1", requestId: "req-1", text: "queued work", metadata: { _loopDepth: 3 } });
    await first.recordSend({ sender: "alice", recipient: "bob", messageId: "msg-old-2", requestId: "req-2", text: "held work" });
    await first.holdExecution("msg-old-2", "operator_hold");
    await first.close();
    const dbFile = path.join(stateRoot, fs.readdirSync(stateRoot).find((name) => name.endsWith(".sqlite") && !name.includes("owner")));
    // Recreate a journal written before the column existed.
    const raw = new DatabaseSync(dbFile);
    raw.exec("ALTER TABLE local_messages DROP COLUMN late_result_text");
    raw.close();
    assert.ok(!columns(dbFile).includes("late_result_text"));

    const second = createLocalMessagingJournal({ stateRoot });
    assert.ok(columns(dbFile).includes("late_result_text"));
    const queued = await second.getRecord("msg-old-1");
    assert.equal(queued.text, "queued work");assert.equal(queued.phase, "queued_local");assert.equal(queued.metadata._loopDepth, 3);assert.equal(queued.hasLateResult, false);
    const held = await second.getRecord("msg-old-2");
    assert.equal(held.phase, "held");assert.equal(held.reason, "operator_hold");assert.equal(held.hasLateResult, false);
    await second.holdExecution("msg-old-1", "runner_timeout", { lateResultText: "late text" });
    await second.close();

    const third = createLocalMessagingJournal({ stateRoot });
    assert.deepEqual(columns(dbFile).filter((name) => name === "late_result_text"), ["late_result_text"], "migration is idempotent");
    assert.equal((await third.getRecord("msg-old-1")).hasLateResult, true);
    assert.equal((await third.getLateResult("msg-old-1")).text, "late text");
    assert.deepEqual((await third.status()).held, 2);
    await third.close();
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ---- journal file names (finding 9) ----
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_FILES = ["peer-drain.sqlite", "peer-drain-owner.sqlite"];
const NEW_FILES = ["local-messaging.sqlite", "local-messaging-owner.sqlite"];
const modeOf = (file) => fs.statSync(file).mode & 0o777;

// Builds the layout an installed service has today: a real journal under the peer drain's file names.
async function writeLegacyJournal(stateRoot) {
  const journal = createLocalMessagingJournal({ stateRoot });
  await journal.recordSend({ sender: "alice", recipient: "bob", messageId: "msg-legacy-1", requestId: "req-legacy-1", text: "queued before the rename", metadata: { _loopDepth: 2 } });
  await journal.recordSend({ sender: "alice", recipient: "bob", messageId: "msg-legacy-2", requestId: "req-legacy-2", text: "finished before the rename" });
  await journal.claimExecution("msg-legacy-2");
  await journal.recordReply({ sender: "bob", recipient: "alice", messageId: "rep-legacy-2", requestId: "req-legacy-2", inReplyTo: "msg-legacy-2", text: "legacy reply" });
  await journal.completeExecution("msg-legacy-2");
  await journal.close();
  const dbName = fs.readdirSync(stateRoot).find((name) => name.endsWith(".sqlite") && !name.includes("owner"));
  const ownerName = fs.readdirSync(stateRoot).find((name) => name.endsWith("-owner.sqlite"));
  if (dbName !== LEGACY_FILES[0]) fs.renameSync(path.join(stateRoot, dbName), path.join(stateRoot, LEGACY_FILES[0]));
  if (ownerName !== LEGACY_FILES[1]) fs.renameSync(path.join(stateRoot, ownerName), path.join(stateRoot, LEGACY_FILES[1]));
}

async function assertLegacyDataIntact(journal) {
  const queued = await journal.getRecord("msg-legacy-1");
  assert.equal(queued.text, "queued before the rename");assert.equal(queued.phase, "queued_local");assert.equal(queued.metadata._loopDepth, 2);
  assert.equal((await journal.getRecord("msg-legacy-2")).phase, "completed");
  const replies = await journal.listReplies({ requester: "alice" });
  assert.deepEqual(replies.map((r) => [r.messageId, r.text]), [["rep-legacy-2", "legacy reply"]]);
}

test("a fresh state directory uses only the local journal file names", async () => {
  const stateRoot = createIsolatedStateRoot();
  try {
    const journal = createLocalMessagingJournal({ stateRoot });
    await journal.recordSend({ sender: "alice", recipient: "bob", messageId: "m", requestId: "r", text: "t" });
    await journal.close();
    assert.deepEqual(fs.readdirSync(stateRoot).sort(), [...NEW_FILES].sort());
    for (const name of NEW_FILES) assert.equal(modeOf(path.join(stateRoot, name)), 0o600);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("an installed journal under the old peer-drain file names is adopted once with its rows and 0600 modes", async () => {
  const stateRoot = createIsolatedStateRoot();
  try {
    await writeLegacyJournal(stateRoot);
    assert.deepEqual(fs.readdirSync(stateRoot).sort(), [...LEGACY_FILES].sort());
    // A leftover journal file travels with its database.
    fs.writeFileSync(path.join(stateRoot, "peer-drain.sqlite-journal"), "", { mode: 0o600 });

    const journal = createLocalMessagingJournal({ stateRoot });
    const names = fs.readdirSync(stateRoot);
    assert.ok(NEW_FILES.every((name) => names.includes(name)), names.join());
    assert.ok(!names.some((name) => name.startsWith("peer-drain")), `legacy files must be gone: ${names.join()}`);
    for (const name of NEW_FILES) assert.equal(modeOf(path.join(stateRoot, name)), 0o600);
    await assertLegacyDataIntact(journal);
    assert.deepEqual(await journal.status(), { queued_local: 1, executing: 0, completed: 1, held: 0, queued: 1, pendingReplies: 1 });
    await journal.recordSend({ sender: "alice", recipient: "bob", messageId: "msg-after", requestId: "req-after", text: "new work" });
    await journal.close();

    // Idempotent: reopening changes nothing.
    const again = createLocalMessagingJournal({ stateRoot });
    await assertLegacyDataIntact(again);
    assert.equal((await again.getRecord("msg-after")).text, "new work");
    await again.close();
    assert.ok(!fs.readdirSync(stateRoot).some((name) => name.startsWith("peer-drain")));
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("old and new journal files together are refused with a clear code and nothing moves", async () => {
  const stateRoot = createIsolatedStateRoot();
  const other = createIsolatedStateRoot();
  try {
    await writeLegacyJournal(stateRoot);
    const stray = createLocalMessagingJournal({ stateRoot: other });
    await stray.close();
    for (const name of NEW_FILES) fs.copyFileSync(path.join(other, name), path.join(stateRoot, name));
    for (const name of NEW_FILES) fs.chmodSync(path.join(stateRoot, name), 0o600);
    const before = fs.readdirSync(stateRoot).sort();
    const sizes = before.map((name) => fs.statSync(path.join(stateRoot, name)).size);

    assert.throws(() => createLocalMessagingJournal({ stateRoot }), (error) => error.code === "journal_migration_conflict");
    assert.deepEqual(fs.readdirSync(stateRoot).sort(), before);
    assert.deepEqual(before.map((name) => fs.statSync(path.join(stateRoot, name)).size), sizes);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("the legacy owner lock is respected: a live old-version owner blocks the move", async () => {
  const stateRoot = createIsolatedStateRoot();
  const { DatabaseSync } = await import("node:sqlite");
  try {
    await writeLegacyJournal(stateRoot);
    const oldOwner = new DatabaseSync(path.join(stateRoot, LEGACY_FILES[1]));
    oldOwner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    assert.throws(() => createLocalMessagingJournal({ stateRoot }), (error) => error.code === "journal_busy");
    const held = fs.readdirSync(stateRoot);
    assert.ok(LEGACY_FILES.every((name) => held.includes(name)) && !held.some((name) => name.startsWith("local-messaging")), `nothing moves under a live owner: ${held.join()}`);
    oldOwner.exec("ROLLBACK");
    oldOwner.close();
    const journal = createLocalMessagingJournal({ stateRoot });
    await assertLegacyDataIntact(journal);
    await journal.close();
    assert.ok(NEW_FILES.every((name) => fs.existsSync(path.join(stateRoot, name))));
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("a database under the old names that is not a local journal is never moved", async () => {
  const stateRoot = createIsolatedStateRoot();
  const { DatabaseSync } = await import("node:sqlite");
  try {
    const peerDb = path.join(stateRoot, LEGACY_FILES[0]);
    const peer = new DatabaseSync(peerDb);
    peer.exec("CREATE TABLE records (sender TEXT, message_id TEXT); INSERT INTO records VALUES ('peer', 'p-1')");
    peer.close();
    fs.chmodSync(peerDb, 0o600);
    fs.writeFileSync(path.join(stateRoot, LEGACY_FILES[1]), "", { mode: 0o600 });

    const journal = createLocalMessagingJournal({ stateRoot });
    await journal.recordSend({ sender: "alice", recipient: "bob", messageId: "m", requestId: "r", text: "t" });
    await journal.close();
    assert.ok(NEW_FILES.every((name) => fs.existsSync(path.join(stateRoot, name))), "a fresh journal is created beside it");
    const check = new DatabaseSync(peerDb);
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name), ["records"], "the peer database is untouched");
    assert.equal(check.prepare("SELECT count(*) AS n FROM records").get().n, 1);
    check.close();
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("legacy journal files with unsafe permissions are refused and left in place", async () => {
  const stateRoot = createIsolatedStateRoot();
  try {
    await writeLegacyJournal(stateRoot);
    fs.chmodSync(path.join(stateRoot, LEGACY_FILES[0]), 0o644);
    assert.throws(() => createLocalMessagingJournal({ stateRoot }), (error) => error.code === "unsafe_path");
    assert.deepEqual(fs.readdirSync(stateRoot).sort(), [...LEGACY_FILES].sort());
    assert.equal(modeOf(path.join(stateRoot, LEGACY_FILES[0])), 0o644, "modes are never silently rewritten");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("an interrupted move resumes: a journal file or the database may already be under the new name", async () => {
  const resumedBeforeDatabase = createIsolatedStateRoot();
  const resumedAfterDatabase = createIsolatedStateRoot();
  try {
    // The journal file moved first, then the process died before the database moved.
    await writeLegacyJournal(resumedBeforeDatabase);
    fs.writeFileSync(path.join(resumedBeforeDatabase, "local-messaging.sqlite-journal"), "", { mode: 0o600 });
    const first = createLocalMessagingJournal({ stateRoot: resumedBeforeDatabase });
    await assertLegacyDataIntact(first);
    await first.close();
    assert.ok(!fs.readdirSync(resumedBeforeDatabase).some((name) => name.startsWith("peer-drain")));

    // The database moved, then the process died before the owner file did.
    await writeLegacyJournal(resumedAfterDatabase);
    fs.renameSync(path.join(resumedAfterDatabase, LEGACY_FILES[0]), path.join(resumedAfterDatabase, NEW_FILES[0]));
    const second = createLocalMessagingJournal({ stateRoot: resumedAfterDatabase });
    await assertLegacyDataIntact(second);
    await second.close();
    assert.ok(NEW_FILES.every((name) => modeOf(path.join(resumedAfterDatabase, name)) === 0o600));
  } finally {
    fs.rmSync(resumedBeforeDatabase, { recursive: true, force: true });
    fs.rmSync(resumedAfterDatabase, { recursive: true, force: true });
  }
});

// ---- retention (finding 10) ----
test("compaction removes only finished, consumed records older than eight days", async () => {
  const stateRoot = createIsolatedStateRoot();
  const { DatabaseSync } = await import("node:sqlite");
  let journal;
  try {
    journal = createLocalMessagingJournal({ stateRoot });
    const raw = new DatabaseSync(path.join(stateRoot, "local-messaging.sqlite"));
    const age = (table, id, days) => raw.prepare(`UPDATE ${table} SET created_at = ?, updated_at = ? WHERE message_id = ?`).run(Date.now() - days * DAY_MS, Date.now() - days * DAY_MS, id);
    const send = (id) => journal.recordSend({ sender: "alice", recipient: "bob", messageId: id, requestId: `req-${id}`, text: id });
    const reply = (id) => journal.recordReply({ sender: "bob", recipient: "alice", messageId: `rep-${id}`, requestId: `req-${id}`, inReplyTo: id, text: `reply ${id}` });
    const finish = async (id) => { await send(id); await journal.claimExecution(id); await reply(id); await journal.completeExecution(id); };

    await finish("done-consumed-old");     await journal.consumeReply({ requester: "alice", messageId: "rep-done-consumed-old" });
    await finish("done-unconsumed-old");
    await finish("done-reply-consumed-recently"); await journal.consumeReply({ requester: "alice", messageId: "rep-done-reply-consumed-recently" });
    await finish("done-recent");           await journal.consumeReply({ requester: "alice", messageId: "rep-done-recent" });
    await send("done-no-reply-old"); await journal.claimExecution("done-no-reply-old"); await journal.completeExecution("done-no-reply-old");
    await send("queued-old");
    await send("executing-old"); await journal.claimExecution("executing-old");
    await send("held-old"); await journal.holdExecution("held-old", "runner_timeout", { lateResultText: "kept for the owner" });
    await reply("held-old");               // an unconsumed reply to a held message

    for (const id of ["done-consumed-old", "done-unconsumed-old", "done-no-reply-old", "queued-old", "executing-old", "held-old", "done-reply-consumed-recently"]) age("local_messages", id, id === "queued-old" || id === "executing-old" || id === "held-old" ? 30 : 9);
    age("local_replies", "rep-done-consumed-old", 9);
    age("local_replies", "rep-done-unconsumed-old", 30);
    age("local_replies", "rep-held-old", 30);
    // consumed two days ago, although its message completed nine days ago
    age("local_replies", "rep-done-reply-consumed-recently", 2);

    const removed = await journal.compact();
    assert.deepEqual(removed, { messages: 2, replies: 1 });
    const kept = raw.prepare("SELECT message_id FROM local_messages ORDER BY message_id").all().map((row) => row.message_id);
    assert.deepEqual(kept, ["done-recent", "done-reply-consumed-recently", "done-unconsumed-old", "executing-old", "held-old", "queued-old"]);
    const keptReplies = raw.prepare("SELECT message_id FROM local_replies ORDER BY message_id").all().map((row) => row.message_id);
    assert.deepEqual(keptReplies, ["rep-done-recent", "rep-done-reply-consumed-recently", "rep-done-unconsumed-old", "rep-held-old"]);
    assert.equal((await journal.getLateResult("held-old")).text, "kept for the owner");
    // Unconsumed replies stay retrievable however old they are.
    assert.deepEqual((await journal.listReplies({ requester: "alice" })).map((r) => r.messageId), ["rep-done-unconsumed-old", "rep-held-old"]);

    // Consuming a reply starts its own eight days; once those pass the pair is compacted.
    await journal.consumeReply({ requester: "alice", messageId: "rep-held-old" });
    assert.deepEqual(await journal.compact(), { messages: 0, replies: 0 });
    assert.deepEqual(await journal.compact({ now: Date.now() + 9 * DAY_MS }), { messages: 2, replies: 3 });
    assert.deepEqual(raw.prepare("SELECT message_id FROM local_messages ORDER BY message_id").all().map((row) => row.message_id), ["done-unconsumed-old", "executing-old", "held-old", "queued-old"].sort());
    // Only the unconsumed reply (and so its message) is left, however old.
    assert.deepEqual(await journal.compact({ now: Date.now() + 365 * DAY_MS }), { messages: 0, replies: 0 });
    assert.deepEqual((await journal.listReplies({ requester: "alice" })).map((r) => r.messageId), ["rep-done-unconsumed-old"]);
    assert.equal((await journal.getRecord("done-unconsumed-old")).phase, "completed");
    raw.close();
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
