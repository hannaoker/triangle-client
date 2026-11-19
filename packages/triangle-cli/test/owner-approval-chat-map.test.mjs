// What an owner approval of a chat mapping or a destination rule binds to (review of #180 to #182, M4: A4, A7, R2, R6, R7).
// The operation is validated before anyone is asked, and the adapter commits only that operation, against the store as it is at commit time.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createOwnerApprovalCoordinator, normalizeOwnerOperation } from "../src/owner-approval.mjs";
import { createChatMappingApprovalAdapter } from "../src/owner-approval-registry.mjs";
import { deriveChatSelectorId, readChatMappings, setChatMapping } from "../../agent-worker/src/local-chat-mapping.mjs";

const PRINCIPAL = "agent_" + "c".repeat(32);
const OTHER_PRINCIPAL = "agent_" + "d".repeat(32);
const ORIGIN = "https://triangle.example";
const SESSION_A = "session-" + "a".repeat(64);
const SESSION_B = "session-" + "b".repeat(64);
const T = "2026-11-17T00:00:00.000Z";

function mkDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function world(t) {
  const storeRoot = mkDir("owner-chat-store-");
  const workspace = mkDir("owner-chat-ws-");
  t.after(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const selectorId = deriveChatSelectorId({ harness: "claude", workspace });
  const before = { harness: "claude", workspace, principalId: PRINCIPAL, authorityOrigin: ORIGIN, bindingGeneration: 1 };
  const setOp = { action: "chat.map.set", storeRoot, expectedSequence: 0, selectorId, ...before, before: null };
  const confirmOp = (sessionAddress = SESSION_A) => ({ action: "chat.map.confirm", storeRoot, expectedSequence: 1, selectorId, sessionAddress, before });
  const revokeOp = { action: "chat.map.revoke", storeRoot, expectedSequence: 1, selectorId, before };
  const file = () => { try { return fs.readFileSync(path.join(storeRoot, "chat-mappings-v1.json"), "utf8"); } catch { return null; } };
  const pending = () => setChatMapping({ storeRoot, selectorId, ...before, expectedSequence: 0, now: () => T });
  return { storeRoot, workspace, selectorId, before, setOp, confirmOp, revokeOp, file, pending };
}

// ---- what is validated before anyone is asked (A4, A7)

test("a workspace of a destination rule or a chat mapping must be a real directory under its own canonical path (A4)", (t) => {
  const base = mkDir("owner-chat-link-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, "real");
  fs.mkdirSync(path.join(real, "sub"), { recursive: true, mode: 0o700 });
  const link = path.join(base, "link");
  fs.symlinkSync(real, link);
  const file = path.join(base, "a-file");
  fs.writeFileSync(file, "x", { mode: 0o600 });
  const registryRoot = mkDir("owner-chat-reg-");
  const storeRoot = mkDir("owner-chat-store2-");
  t.after(() => { fs.rmSync(registryRoot, { recursive: true, force: true }); fs.rmSync(storeRoot, { recursive: true, force: true }); });
  const destination = (workspace) => ({ action: "destination.set", registryRoot, expectedSequence: 1, principalId: PRINCIPAL, harness: "claude", workspace, before: null });
  const chat = (workspace) => ({
    action: "chat.map.set", storeRoot, expectedSequence: 0, selectorId: deriveChatSelectorId({ harness: "claude", workspace: real }),
    harness: "claude", workspace, principalId: PRINCIPAL, authorityOrigin: ORIGIN, bindingGeneration: 1, before: null,
  });
  for (const make of [destination, chat]) {
    assert.equal(normalizeOwnerOperation(make(real)).workspace, real, "the canonical directory is accepted");
    assert.equal(normalizeOwnerOperation(make(path.join(real, "sub"))).workspace, path.join(real, "sub"));
    for (const workspace of [link, path.join(link, "sub"), file, path.join(base, "missing")]) {
      assert.throws(() => normalizeOwnerOperation(make(workspace)), { code: "invalid_owner_operation" }, workspace);
    }
  }
});

test("a confirmation names one session address of the exact shape (A7)", (t) => {
  const w = world(t);
  assert.equal(normalizeOwnerOperation(w.confirmOp(SESSION_A)).sessionAddress, SESSION_A);
  for (const bad of [
    "session-" + "a".repeat(63), "session-" + "a".repeat(65), "session-" + "A".repeat(64), "session-" + "g".repeat(64),
    "Session-" + "a".repeat(64), "x" + SESSION_A, SESSION_A + "\n", SESSION_A + " ", "", "agent_" + "a".repeat(32), null, undefined, 7, {},
  ]) {
    assert.throws(() => normalizeOwnerOperation({ ...w.confirmOp(), sessionAddress: bad }), { code: "invalid_owner_operation" }, String(bad));
  }
});

// ---- what the adapter commits (R2, R6, R7)

test("the adapter commits only the operation that was approved, for set, confirm and revoke (R2)", (t) => {
  const w = world(t);
  const commitWith = (adapter, op) => adapter(w.storeRoot, (state) => state.commit(op));
  // set: another principal, another generation, another sequence, another selector, another action
  const setAdapter = createChatMappingApprovalAdapter(w.setOp, { now: () => T });
  const setNormal = normalizeOwnerOperation(w.setOp);
  for (const other of [
    { ...setNormal, principalId: OTHER_PRINCIPAL }, { ...setNormal, bindingGeneration: 2 }, { ...setNormal, authorityOrigin: "https://other.example" },
    { ...setNormal, expectedSequence: 5 }, { ...setNormal, harness: "codex" }, { ...setNormal, action: "chat.map.revoke" },
  ]) {
    assert.throws(() => commitWith(setAdapter, other), { code: "owner_approval_stale" }, JSON.stringify(other));
  }
  assert.equal(w.file(), null, "nothing was written by a refused commit");
  assert.equal(commitWith(setAdapter, setNormal).registry.sequence, 1);
  assert.equal(readChatMappings({ storeRoot: w.storeRoot }).mappings[w.selectorId].state, "pending");

  const confirmNormal = normalizeOwnerOperation(w.confirmOp());
  const confirmAdapter = createChatMappingApprovalAdapter(w.confirmOp(), { now: () => T, listAttachedSessions: () => [{ address: SESSION_A, harness: "claude", workspace: w.workspace }] });
  const before = w.file();
  for (const other of [{ ...confirmNormal, sessionAddress: SESSION_B }, { ...confirmNormal, selectorId: "sel_" + "1".repeat(32) }, { ...confirmNormal, expectedSequence: 2 }]) {
    assert.throws(() => commitWith(confirmAdapter, other), { code: "owner_approval_stale" }, JSON.stringify(other));
  }
  assert.equal(w.file(), before);
  assert.equal(commitWith(confirmAdapter, confirmNormal).registry.sequence, 2);

  const revokeNormal = normalizeOwnerOperation(w.revokeOp);
  const revokeAdapter = (op) => createChatMappingApprovalAdapter(op, { now: () => T });
  const confirmed = w.file();
  assert.throws(() => commitWith(revokeAdapter({ ...w.revokeOp, expectedSequence: 2 }), revokeNormal), { code: "owner_approval_stale" }, "another operation than the one the adapter was made for");
  assert.throws(() => commitWith(revokeAdapter(w.revokeOp), { ...revokeNormal, before: { ...w.before, bindingGeneration: 9 } }), { code: "owner_approval_stale" });
  assert.equal(w.file(), confirmed);
});

test("a confirmation binds the session that was approved, and refuses another that took its place (R6)", (t) => {
  const w = world(t);
  w.pending();
  const live = (address) => () => [{ address, harness: "claude", workspace: w.workspace }];
  const approved = normalizeOwnerOperation(w.confirmOp(SESSION_A));
  const before = w.file();
  // the approved chat ended and another one started in the same workspace while the owner was being asked
  const swapped = createChatMappingApprovalAdapter(w.confirmOp(SESSION_A), { now: () => T, listAttachedSessions: live(SESSION_B) });
  assert.throws(() => swapped(w.storeRoot, (state) => state.commit(approved)), { code: "chat_mapping_session_mismatch" });
  assert.equal(w.file(), before, "the mapping stays pending");
  const same = createChatMappingApprovalAdapter(w.confirmOp(SESSION_A), { now: () => T, listAttachedSessions: live(SESSION_A) });
  same(w.storeRoot, (state) => state.commit(approved));
  const entry = readChatMappings({ storeRoot: w.storeRoot }).mappings[w.selectorId];
  assert.equal(entry.state, "confirmed");
  assert.equal(entry.sessionAddress, SESSION_A);
});

test("the live chats are listed when the confirmation commits, inside the lock, from the store root (R7)", (t) => {
  const w = world(t);
  w.pending();
  const calls = [];
  let sessions = [{ address: SESSION_A, harness: "claude", workspace: w.workspace }];
  const adapter = createChatMappingApprovalAdapter(w.confirmOp(), { now: () => T, listAttachedSessions: (root) => { calls.push(root); return sessions; } });
  assert.deepEqual(calls, [], "nothing is listed when the adapter is made");
  const approved = normalizeOwnerOperation(w.confirmOp());
  const before = w.file();
  // the approved chat is gone at commit time: its approval does not bring it back
  sessions = [];
  assert.throws(() => adapter(w.storeRoot, (state) => { assert.deepEqual(calls, [], "nor while the transaction is inspected"); return state.commit(approved); }), { code: "chat_mapping_no_live_session" });
  assert.deepEqual(calls, [w.storeRoot]);
  assert.equal(w.file(), before);
  // it is back: the same adapter lists again, so the answer is as fresh as the commit
  sessions = [{ address: SESSION_A, harness: "claude", workspace: w.workspace }];
  adapter(w.storeRoot, (state) => state.commit(approved));
  assert.deepEqual(calls, [w.storeRoot, w.storeRoot]);
  assert.equal(readChatMappings({ storeRoot: w.storeRoot }).mappings[w.selectorId].state, "confirmed");
});

test("a chat that changes while the owner is asked is refused after the approval, with the mapping left pending", async (t) => {
  const w = world(t);
  w.pending();
  let sessions = [{ address: SESSION_A, harness: "claude", workspace: w.workspace }];
  const coordinator = createOwnerApprovalCoordinator({
    clockMs: () => 1000,
    provider: { authenticate: async () => { sessions = [{ address: SESSION_B, harness: "claude", workspace: w.workspace }]; return "approved"; } },
    withLockedRegistry: createChatMappingApprovalAdapter(w.confirmOp(SESSION_A), { now: () => T, listAttachedSessions: () => sessions }),
  });
  const before = w.file();
  await assert.rejects(coordinator.execute(coordinator.prepare(w.confirmOp(SESSION_A))), { code: "chat_mapping_session_mismatch" });
  assert.equal(w.file(), before);
});
