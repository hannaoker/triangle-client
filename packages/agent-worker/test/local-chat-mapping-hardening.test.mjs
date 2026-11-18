// The checks of the chat-mapping store and of destination resolution that the first tests did not pin (review of #180 to #182, M4): custody of the
// store, what a reader refuses, what a confirmation refuses, and what a destination needs before it routes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CHAT_MAPPING_FILENAME,
  confirmChatMapping,
  deriveChatSelectorId,
  inspectChatDestination,
  readChatMappings,
  resolveChatDestinationForPrincipal,
  resolveChatLiveness,
  setChatMapping,
} from "../src/local-chat-mapping.mjs";

const ORIGIN = "https://triangle.example";
const WS = (n) => `/tmp/hardening-ws-${n}`;
const PRINCIPAL = (n) => "agent_" + String(n).repeat(32);
const SESSION = (n) => "session-" + String(n).repeat(64);

function mkDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.chmodSync(dir, 0o700);
  return dir;
}

const entry = (n, over = {}) => {
  const workspace = WS(n);
  return {
    selectorId: deriveChatSelectorId({ harness: "claude", workspace }),
    harness: "claude",
    workspace,
    principalId: PRINCIPAL(n),
    authorityOrigin: ORIGIN,
    bindingGeneration: 1,
    state: "confirmed",
    sessionAddress: SESSION(n),
    setAt: "2026-11-13T00:00:00.000Z",
    confirmedAt: "2026-11-13T00:00:01.000Z",
    ...over,
  };
};

function writeStore(storeRoot, entries, { mode = 0o600, keys = null } = {}) {
  const mappings = {};
  entries.forEach((e, i) => { mappings[keys?.[i] ?? e.selectorId] = e; });
  const file = path.join(storeRoot, CHAT_MAPPING_FILENAME);
  fs.writeFileSync(file, JSON.stringify({ schema: "chat_mappings_v1", version: 1, sequence: 1, mappings }), { mode });
  fs.chmodSync(file, mode);
  return file;
}

// ---- custody

test("the store root must be private: group or world access of any kind is refused (C1)", () => {
  const storeRoot = mkDir("chat-hard-custody-");
  try {
    assert.equal(readChatMappings({ storeRoot }).state, "absent");
    for (const mode of [0o750, 0o710, 0o770, 0o705, 0o701, 0o707, 0o755]) {
      fs.chmodSync(storeRoot, mode);
      assert.throws(() => readChatMappings({ storeRoot }), { code: "chat_mapping_store_custody" }, mode.toString(8));
    }
    fs.chmodSync(storeRoot, 0o700);
    assert.equal(readChatMappings({ storeRoot }).state, "absent");
  } finally {
    fs.chmodSync(storeRoot, 0o700);
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("the store file must be a single-link regular file (C2), and the root a canonical path without symlinks (B8)", () => {
  const storeRoot = mkDir("chat-hard-links-");
  const elsewhere = mkDir("chat-hard-elsewhere-");
  try {
    const file = writeStore(storeRoot, [entry(1)]);
    assert.equal(readChatMappings({ storeRoot }).state, "ok");
    fs.linkSync(file, path.join(elsewhere, "second-name"));
    assert.throws(() => readChatMappings({ storeRoot }), { code: "chat_mapping_custody" }, "a second hard link");
    fs.rmSync(path.join(elsewhere, "second-name"));
    assert.equal(readChatMappings({ storeRoot }).state, "ok");

    // a symlinked ancestor: the path is a real directory, but not the canonical one
    const real = mkDir("chat-hard-real-");
    fs.mkdirSync(path.join(real, "store"), { mode: 0o700 });
    const link = path.join(elsewhere, "link");
    fs.symlinkSync(real, link);
    assert.throws(() => readChatMappings({ storeRoot: path.join(link, "store") }), { code: "chat_mapping_invalid_store_root" });
    // a symlinked root and a relative or non-normalized path are refused too
    assert.throws(() => readChatMappings({ storeRoot: link }), { code: "chat_mapping_invalid_store_root" });
    assert.throws(() => readChatMappings({ storeRoot: "relative/store" }), { code: "chat_mapping_invalid_store_root" });
    assert.throws(() => readChatMappings({ storeRoot: storeRoot + "/../" + path.basename(storeRoot) }), { code: "chat_mapping_invalid_store_root" });
    fs.rmSync(real, { recursive: true, force: true });
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

// ---- what a reader refuses

test("a store that breaks one of its own rules is refused whole, and the same store without the break is read (C6 to C9, B15)", () => {
  const storeRoot = mkDir("chat-hard-reader-");
  try {
    writeStore(storeRoot, [entry(1), entry(2), entry(3, { state: "pending", sessionAddress: null, confirmedAt: null })]);
    const good = readChatMappings({ storeRoot });
    assert.equal(good.state, "ok");
    assert.equal(Object.keys(good.mappings).length, 3);

    const refuse = (entries, options, why) => {
      writeStore(storeRoot, entries, options);
      assert.throws(() => readChatMappings({ storeRoot }), { code: "chat_mapping_corrupt" }, why);
    };
    refuse([entry(1), entry(2, { principalId: PRINCIPAL(1) })], {}, "one principal in two mappings (C6)");
    refuse([entry(1), entry(2, { sessionAddress: SESSION(1) })], {}, "one chat confirmed for two mappings (C7)");
    // the same (harness, workspace) under two selector keys (C8): neither key is derived here, which is not what this rule is about
    const twin = entry(2, { workspace: WS(1), selectorId: "sel_" + "e".repeat(32) });
    refuse([entry(1), twin], {}, "one harness and workspace twice (C8)");
    refuse([entry(1), entry(2)], { keys: [entry(1).selectorId, "sel_" + "f".repeat(32)] }, "a key that is not the entry's selector id (C9)");
    refuse([entry(1, { sessionAddress: "session-not-a-real-address" })], {}, "a confirmed mapping with a malformed chat address (B15)");
    refuse([entry(1, { sessionAddress: SESSION(1).toUpperCase() })], {}, "an upper-case chat address");
    refuse([entry(1, { state: "pending" })], {}, "a pending mapping that carries a chat");
    refuse([entry(1, { state: "confirmed", sessionAddress: null })], {}, "a confirmed mapping without a chat");
    refuse([entry(1, { state: "revoked" })], {}, "a state the lifecycle does not have");
    refuse([entry(1, { extra: true })], {}, "an extra field");
    refuse([entry(1, { harness: "gemini" })], {}, "a harness that has no chats");
    refuse([entry(1, { bindingGeneration: 0 })], {}, "a binding generation below one");
    refuse([entry(1, { authorityOrigin: "https://x.example/with/path" })], {}, "an authority that is not a bare origin");
    // two pending mappings may share nothing either, and two confirmed ones with distinct chats are fine
    writeStore(storeRoot, [entry(1), entry(2)]);
    assert.equal(readChatMappings({ storeRoot }).state, "ok");
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

// ---- what a confirmation refuses

test("confirming binds exactly the chat that was approved, and never a chat another mapping holds (C14, C15)", () => {
  const storeRoot = mkDir("chat-hard-confirm-");
  try {
    const sel1 = deriveChatSelectorId({ harness: "claude", workspace: WS(1) });
    const sel2 = deriveChatSelectorId({ harness: "claude", workspace: WS(2) });
    const base = { harness: "claude", authorityOrigin: ORIGIN, bindingGeneration: 1 };
    setChatMapping({ storeRoot, selectorId: sel1, workspace: WS(1), principalId: PRINCIPAL(1), expectedSequence: 0, ...base });
    setChatMapping({ storeRoot, selectorId: sel2, workspace: WS(2), principalId: PRINCIPAL(2), expectedSequence: 1, ...base });
    const live = (address, n) => ({ address, harness: "claude", workspace: WS(n) });

    // the approved chat is X; only Y is live: nothing is bound
    assert.throws(() => confirmChatMapping({ storeRoot, selectorId: sel1, expectedSequence: 2, expectedSessionAddress: SESSION(8), attachedSessions: [live(SESSION(9), 1)] }),
      { code: "chat_mapping_session_mismatch" });
    assert.equal(readChatMappings({ storeRoot }).mappings[sel1].state, "pending");
    // X is the live chat: it is bound, and only it
    const confirmed = confirmChatMapping({ storeRoot, selectorId: sel1, expectedSequence: 2, expectedSessionAddress: SESSION(8), attachedSessions: [live(SESSION(8), 1)] });
    assert.equal(confirmed.mappings[sel1].sessionAddress, SESSION(8));

    // the same chat cannot be bound to another selector, even when it shows up as that selector's live chat
    assert.throws(() => confirmChatMapping({ storeRoot, selectorId: sel2, expectedSequence: 3, attachedSessions: [live(SESSION(8), 2)] }),
      { code: "chat_mapping_session_conflict" });
    assert.equal(readChatMappings({ storeRoot }).mappings[sel2].state, "pending");

    // without an approved address (the library call, not the owner's command) the one live chat is bound
    const second = confirmChatMapping({ storeRoot, selectorId: sel2, expectedSequence: 3, attachedSessions: [live(SESSION(7), 2)] });
    assert.equal(second.mappings[sel2].sessionAddress, SESSION(7));
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

// ---- what a destination needs before it routes

const DESTINATION = { harness: "claude", workspace: WS(1), generation: 3, bindingGeneration: 1, authorityOrigin: ORIGIN };

test("inspectChatDestination says what the store says, never throws, and never carries a path", () => {
  const storeRoot = mkDir("chat-hard-inspect-");
  try {
    const at = (over = {}, principalId = PRINCIPAL(1)) => inspectChatDestination({ storeRoot, principalId, destination: { ...DESTINATION, ...over } });
    assert.deepEqual(inspectChatDestination({ storeRoot, principalId: PRINCIPAL(1), destination: null }), { ok: false, reason: "destination_not_configured", entry: null });
    assert.equal(inspectChatDestination({ storeRoot, principalId: "peer_" + "1".repeat(32), destination: DESTINATION }).reason, "destination_not_configured");
    assert.equal(at({ bindingGeneration: 0 }).reason, "destination_binding_inactive");
    assert.equal(at({ bindingGeneration: undefined }).reason, "destination_binding_inactive");
    assert.equal(at({ authorityOrigin: null }).reason, "destination_binding_inactive");
    assert.equal(at().reason, "chat_mapping_missing", "no store file");

    writeStore(storeRoot, [entry(1, { state: "pending", sessionAddress: null, confirmedAt: null })]);
    assert.equal(at().reason, "chat_mapping_unconfirmed");
    assert.equal(at({ bindingGeneration: 2 }).reason, "chat_mapping_stale_generation", "another binding generation");
    assert.equal(at({ authorityOrigin: "https://other.example" }).reason, "chat_mapping_stale_generation", "another authority at the same generation (C19)");
    assert.equal(at({ workspace: WS(2) }).reason, "chat_mapping_missing", "a rule for another workspace");
    assert.equal(at({ harness: "codex" }).reason, "chat_mapping_missing", "a rule for another harness");
    assert.equal(at({}, PRINCIPAL(2)).reason, "chat_mapping_missing", "another principal");

    writeStore(storeRoot, [entry(1)]);
    const ok = at();
    assert.equal(ok.ok, true);
    assert.equal(ok.entry.sessionAddress, SESSION(1));

    // an unreadable store is a reason, not an exception, and the reason is a code
    fs.writeFileSync(path.join(storeRoot, CHAT_MAPPING_FILENAME), "{ not json", { mode: 0o600 });
    assert.deepEqual(at(), { ok: false, reason: "chat_mapping_corrupt", entry: null });
    fs.chmodSync(path.join(storeRoot, CHAT_MAPPING_FILENAME), 0o644);
    assert.deepEqual(at(), { ok: false, reason: "chat_mapping_custody", entry: null });
    const missing = inspectChatDestination({ storeRoot: path.join(storeRoot, "nowhere"), principalId: PRINCIPAL(1), destination: DESTINATION });
    assert.equal(missing.ok, false);
    assert.equal(JSON.stringify(missing).includes(storeRoot), false, "no path in the answer");
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("a confirmed destination resolves to the chat it was confirmed for and to no other live chat (C20)", () => {
  const e = entry(1);
  const live = (address, over = {}) => ({ address, harness: "claude", workspace: WS(1), generation: 1, ...over });
  assert.deepEqual(resolveChatLiveness({ entry: e, attachedSessions: [live(SESSION(1))] }), { ok: true, sessionAddress: SESSION(1), mapping: e });
  // another chat of the same harness and workspace is live, the confirmed one is not: nothing is delivered
  assert.deepEqual(resolveChatLiveness({ entry: e, attachedSessions: [live(SESSION(2))] }), { ok: false, reason: "destination_session_offline" });
  // the confirmed one among others still resolves to itself
  assert.equal(resolveChatLiveness({ entry: e, attachedSessions: [live(SESSION(2)), live(SESSION(1)), live(SESSION(3))] }).sessionAddress, SESSION(1));
  assert.equal(resolveChatLiveness({ entry: e, attachedSessions: [] }).reason, "destination_session_offline");
  assert.equal(resolveChatLiveness({ entry: e, attachedSessions: null }).reason, "destination_session_offline");
  // the same address in another workspace or harness is not the chat that was confirmed
  assert.equal(resolveChatLiveness({ entry: e, attachedSessions: [live(SESSION(1), { workspace: WS(2) })] }).reason, "destination_session_offline");
  assert.equal(resolveChatLiveness({ entry: e, attachedSessions: [live(SESSION(1), { harness: "codex" })] }).reason, "destination_session_offline");
  assert.equal(resolveChatLiveness({ entry: e, attachedSessions: [live(SESSION(1)), live(SESSION(1))] }).reason, "destination_session_ambiguous");
  assert.equal(resolveChatLiveness({ entry: e, attachedSessions: [null, undefined, live(SESSION(1))] }).ok, true);
});

test("resolveChatDestinationForPrincipal is the inspection followed by the liveness, in that order", () => {
  const storeRoot = mkDir("chat-hard-resolve-");
  try {
    const attached = [{ address: SESSION(1), harness: "claude", workspace: WS(1), generation: 1 }];
    const resolve = (over = {}) => resolveChatDestinationForPrincipal({ storeRoot, principalId: PRINCIPAL(1), destination: { ...DESTINATION, ...over }, attachedSessions: attached });
    assert.deepEqual(resolve(), { ok: false, reason: "chat_mapping_missing" });
    writeStore(storeRoot, [entry(1)]);
    assert.deepEqual(resolve(), { ok: true, sessionAddress: SESSION(1), mapping: entry(1) });
    assert.equal(resolve({ bindingGeneration: 2 }).reason, "chat_mapping_stale_generation");
    assert.equal(resolveChatDestinationForPrincipal({ storeRoot, principalId: PRINCIPAL(1), destination: DESTINATION, attachedSessions: [] }).reason, "destination_session_offline");
    fs.writeFileSync(path.join(storeRoot, CHAT_MAPPING_FILENAME), "{ not json", { mode: 0o600 });
    assert.deepEqual(resolve(), { ok: false, reason: "chat_mapping_corrupt" }, "an unreadable store is a reason, not an exception");
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});
