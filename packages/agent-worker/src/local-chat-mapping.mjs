import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withPrivateFileLock } from "./local-messaging-auth-broker.mjs";
import {
  AGENT_ID_PATTERN,
  DESTINATION_HARNESSES,
  SELECTOR_ID_PATTERN,
  isValidBareHttpsOrigin,
  isValidWorkspacePath,
} from "./identity-primitives.mjs";

export const CHAT_MAPPING_FILENAME = "chat-mappings-v1.json";
export const CHAT_MAPPING_SCHEMA = "chat_mappings_v1";
export const CHAT_MAPPING_VERSION = 1;
export const SESSION_ADDRESS_PATTERN = /^session-[a-f0-9]{64}$/;
const MAX_CHAT_MAPPINGS_BYTES = 1024 * 1024;
const REQUIRED_TOP_KEYS = ["schema", "version", "sequence", "mappings"];
const REQUIRED_ENTRY_KEYS = [
  "selectorId",
  "harness",
  "workspace",
  "principalId",
  "authorityOrigin",
  "bindingGeneration",
  "state",
  "sessionAddress",
  "setAt",
  "confirmedAt",
];

function coded(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  const target = [...expected].sort();
  return keys.length === target.length && keys.every((key, i) => key === target[i]);
}

function assertPrivateDirectory(dirPath) {
  if (typeof dirPath !== "string" || !path.isAbsolute(dirPath) || path.resolve(dirPath) !== dirPath) {
    throw coded("chat_mapping_invalid_store_root", "Store root must be a normalized absolute path");
  }
  let lstat;
  try {
    lstat = fs.lstatSync(dirPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw coded("chat_mapping_store_missing", `Chat mapping store root is missing: ${dirPath}`);
    }
    throw error;
  }
  if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
    throw coded("chat_mapping_invalid_store_root", "Store root must be a real directory");
  }
  const realDir = fs.realpathSync(dirPath);
  if (realDir !== dirPath) {
    throw coded("chat_mapping_invalid_store_root", "Store root must be canonical without symlinks");
  }
  if (typeof process.getuid === "function" && lstat.uid !== process.getuid()) {
    throw coded("chat_mapping_store_custody", "Store root owner mismatch");
  }
  if ((lstat.mode & 0o077) !== 0) {
    throw coded("chat_mapping_store_custody", "Store root permissions must not be group/world accessible");
  }
  return dirPath;
}

function validateAndFreezeEntry(key, raw) {
  if (!SELECTOR_ID_PATTERN.test(key) || !exactKeys(raw, REQUIRED_ENTRY_KEYS)) {
    throw coded("chat_mapping_corrupt", "Invalid chat mapping entry shape");
  }
  if (
    raw.selectorId !== key ||
    !DESTINATION_HARNESSES.includes(raw.harness) ||
    !isValidWorkspacePath(raw.workspace) ||
    !AGENT_ID_PATTERN.test(raw.principalId) ||
    !isValidBareHttpsOrigin(raw.authorityOrigin) ||
    !Number.isSafeInteger(raw.bindingGeneration) ||
    raw.bindingGeneration < 1 ||
    typeof raw.setAt !== "string" ||
    raw.setAt.length === 0
  ) {
    throw coded("chat_mapping_corrupt", "Invalid chat mapping entry field");
  }
  if (raw.state === "pending") {
    if (raw.sessionAddress !== null || raw.confirmedAt !== null) {
      throw coded("chat_mapping_corrupt", "Pending chat mapping must not carry confirmed session fields");
    }
  } else if (raw.state === "confirmed") {
    if (
      typeof raw.sessionAddress !== "string" ||
      !SESSION_ADDRESS_PATTERN.test(raw.sessionAddress) ||
      typeof raw.confirmedAt !== "string" ||
      raw.confirmedAt.length === 0
    ) {
      throw coded("chat_mapping_corrupt", "Confirmed chat mapping requires valid sessionAddress and confirmedAt");
    }
  } else {
    throw coded("chat_mapping_corrupt", "Invalid chat mapping state");
  }
  return Object.freeze({ ...raw });
}

export function deriveChatSelectorId({ harness, workspace }) {
  if (!DESTINATION_HARNESSES.includes(harness) || !isValidWorkspacePath(workspace)) {
    throw coded("invalid_chat_selector", "Chat selector requires valid harness and workspace");
  }
  const digest = crypto.createHash("sha256").update(`${harness}\0${workspace}`).digest("hex").slice(0, 32);
  return `sel_${digest}`;
}

export function chatMappingFilePath(storeRoot) {
  return path.join(storeRoot, CHAT_MAPPING_FILENAME);
}

function cacheIdentity(stat) {
  if (!stat) return "absent";
  return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}:${stat.mode}:${stat.uid}:${stat.nlink}`;
}

// Send-path cache. Keyed by store root and the file's identity so a changed
// mapping is noticed without re-parsing on every message. CLI reads stay uncached.
const sendReadCache = new Map();

function openChatMappingText(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === "ENOENT") return { status: "absent" };
    if (error.code === "ELOOP" || error.code === "EFTYPE") {
      throw coded("chat_mapping_custody", "Chat mapping file must be a single-link regular file");
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw coded("chat_mapping_custody", "Chat mapping file must be a single-link regular file");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw coded("chat_mapping_custody", "Chat mapping file owner mismatch");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw coded("chat_mapping_custody", "Chat mapping file permissions must be 0600");
    }
    if (stat.size > MAX_CHAT_MAPPINGS_BYTES) {
      throw coded("chat_mapping_corrupt", "Chat mapping file exceeds maximum size");
    }
    return { status: "ok", stat, text: fs.readFileSync(fd, "utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

function absentChatMappings(storeRoot, filePath) {
  return Object.freeze({
    state: "absent",
    storeRoot,
    path: filePath,
    schema: CHAT_MAPPING_SCHEMA,
    version: CHAT_MAPPING_VERSION,
    sequence: 0,
    mappings: Object.freeze({}),
  });
}

function loadChatMappings(storeRoot) {
  assertPrivateDirectory(storeRoot);
  const filePath = chatMappingFilePath(storeRoot);
  const opened = openChatMappingText(filePath);
  if (opened.status === "absent") {
    return { store: absentChatMappings(storeRoot, filePath), cacheKey: "absent" };
  }
  let parsed;
  try {
    parsed = JSON.parse(opened.text);
  } catch {
    throw coded("chat_mapping_corrupt", "Chat mapping file contains invalid JSON");
  }
  if (
    !exactKeys(parsed, REQUIRED_TOP_KEYS) ||
    parsed.schema !== CHAT_MAPPING_SCHEMA ||
    parsed.version !== CHAT_MAPPING_VERSION ||
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence < 1 ||
    !isPlainObject(parsed.mappings)
  ) {
    throw coded("chat_mapping_corrupt", "Invalid chat mapping store header");
  }
  const mappings = {};
  const seenHarnessWorkspaces = new Set();
  const seenPrincipals = new Set();
  const seenSessions = new Set();
  for (const [key, raw] of Object.entries(parsed.mappings)) {
    const entry = validateAndFreezeEntry(key, raw);
    const hwKey = `${entry.harness}\0${entry.workspace}`;
    if (seenHarnessWorkspaces.has(hwKey)) {
      throw coded("chat_mapping_corrupt", "Duplicate (harness, workspace) in chat mappings");
    }
    seenHarnessWorkspaces.add(hwKey);
    if (seenPrincipals.has(entry.principalId)) {
      throw coded("chat_mapping_corrupt", "Duplicate principalId in chat mappings");
    }
    seenPrincipals.add(entry.principalId);
    if (entry.state === "confirmed") {
      if (seenSessions.has(entry.sessionAddress)) {
        throw coded("chat_mapping_corrupt", "Duplicate confirmed sessionAddress in chat mappings");
      }
      seenSessions.add(entry.sessionAddress);
    }
    mappings[key] = entry;
  }
  return {
    store: Object.freeze({
      state: "ok",
      storeRoot,
      path: filePath,
      schema: parsed.schema,
      version: parsed.version,
      sequence: parsed.sequence,
      mappings: Object.freeze(mappings),
    }),
    cacheKey: cacheIdentity(opened.stat),
  };
}

export function readChatMappings({ storeRoot }) {
  return loadChatMappings(storeRoot).store;
}

function writeChatMappingsAtomic(filePath, payload) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(tmpPath, flags, 0o600);
  let fdClosed = false;
  let renamed = false;
  const closeFd = () => {
    if (fdClosed) return;
    fdClosed = true;
    try { fs.closeSync(fd); } catch { /* already closed */ }
  };
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    closeFd();
    fs.renameSync(tmpPath, filePath);
    renamed = true;
    const dirFlags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0);
    const dirFd = fs.openSync(path.dirname(filePath), dirFlags);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (error) {
    closeFd();
    if (!renamed) {
      try { fs.unlinkSync(tmpPath); } catch { /* temp may already be gone */ }
    }
    throw error;
  }
  sendReadCache.delete(path.dirname(filePath));
}

export function withLockedChatMappings(storeRoot, fn) {
  assertPrivateDirectory(storeRoot);
  const filePath = chatMappingFilePath(storeRoot);
  return withPrivateFileLock(filePath, () => {
    const current = readChatMappings({ storeRoot });
    return fn(current);
  });
}

export function setChatMappingInLock(current, {
  selectorId,
  harness,
  workspace,
  principalId,
  authorityOrigin,
  bindingGeneration,
  expectedSequence,
  now = () => new Date().toISOString(),
}) {
  if (expectedSequence !== undefined && current.sequence !== expectedSequence) {
    throw coded("sequence_mismatch", "Chat mapping sequence changed before operation");
  }
  if (!SELECTOR_ID_PATTERN.test(selectorId) || !DESTINATION_HARNESSES.includes(harness) ||
      !isValidWorkspacePath(workspace) || !AGENT_ID_PATTERN.test(principalId) ||
      !isValidBareHttpsOrigin(authorityOrigin) || !Number.isSafeInteger(bindingGeneration) || bindingGeneration < 1) {
    throw coded("invalid_chat_mapping", "Invalid chat mapping fields");
  }
  const existing = Object.values(current.mappings);
  if (current.mappings[selectorId] || existing.some((e) => e.harness === harness && e.workspace === workspace)) {
    throw coded("chat_mapping_exists", "Chat selector already has a mapping; revoke first");
  }
  if (existing.some((e) => e.principalId === principalId)) {
    throw coded("chat_mapping_principal_exists", "Principal already has an active chat mapping; revoke first");
  }
  const nextMappings = {
    ...current.mappings,
    [selectorId]: {
      selectorId,
      harness,
      workspace,
      principalId,
      authorityOrigin,
      bindingGeneration,
      state: "pending",
      sessionAddress: null,
      setAt: typeof now === "function" ? now() : String(now),
      confirmedAt: null,
    },
  };
  const nextPayload = {
    schema: CHAT_MAPPING_SCHEMA,
    version: CHAT_MAPPING_VERSION,
    sequence: current.sequence + 1,
    mappings: nextMappings,
  };
  writeChatMappingsAtomic(current.path, nextPayload);
  return readChatMappings({ storeRoot: current.storeRoot });
}

export function setChatMapping(options) {
  return withLockedChatMappings(options.storeRoot, (current) => setChatMappingInLock(current, options));
}

export function confirmChatMappingInLock(current, {
  selectorId,
  attachedSessions,
  expectedSequence,
  expectedSessionAddress,
  now = () => new Date().toISOString(),
}) {
  if (expectedSequence !== undefined && current.sequence !== expectedSequence) {
    throw coded("sequence_mismatch", "Chat mapping sequence changed before confirmation");
  }
  const entry = current.mappings[selectorId];
  if (!entry) {
    throw coded("chat_mapping_not_found", "Chat mapping selector not found");
  }
  if (entry.state === "confirmed") {
    throw coded("chat_mapping_already_confirmed", "Chat mapping is already confirmed");
  }
  const matches = (attachedSessions ?? []).filter(
    (s) => s && s.harness === entry.harness && s.workspace === entry.workspace && SESSION_ADDRESS_PATTERN.test(s.address ?? "")
  );
  if (matches.length === 0) {
    throw coded("chat_mapping_no_live_session", "No live attached chat matches selector harness and workspace");
  }
  if (matches.length > 1) {
    throw coded("chat_mapping_ambiguous_session", "Multiple live attached chats match selector harness and workspace");
  }
  const sessionAddress = matches[0].address;
  if (typeof expectedSessionAddress === "string" && sessionAddress !== expectedSessionAddress) {
    throw coded("chat_mapping_session_mismatch", "Live attached chat does not match the approved session");
  }
  if (Object.values(current.mappings).some((e) => e.selectorId !== selectorId && e.sessionAddress === sessionAddress)) {
    throw coded("chat_mapping_session_conflict", "Attached chat session is already mapped to another selector");
  }
  const nextMappings = {
    ...current.mappings,
    [selectorId]: {
      ...entry,
      state: "confirmed",
      sessionAddress,
      confirmedAt: typeof now === "function" ? now() : String(now),
    },
  };
  const nextPayload = {
    schema: CHAT_MAPPING_SCHEMA,
    version: CHAT_MAPPING_VERSION,
    sequence: current.sequence + 1,
    mappings: nextMappings,
  };
  writeChatMappingsAtomic(current.path, nextPayload);
  return readChatMappings({ storeRoot: current.storeRoot });
}

export function confirmChatMapping(options) {
  return withLockedChatMappings(options.storeRoot, (current) => confirmChatMappingInLock(current, options));
}

export function revokeChatMappingInLock(current, { selectorId, before, expectedSequence }) {
  if (expectedSequence !== undefined && current.sequence !== expectedSequence) {
    throw coded("sequence_mismatch", "Chat mapping sequence changed before revoke");
  }
  const entry = current.mappings[selectorId];
  if (!entry) {
    throw coded("chat_mapping_not_found", "Chat mapping selector not found");
  }
  if (before && (
    entry.harness !== before.harness ||
    entry.workspace !== before.workspace ||
    entry.principalId !== before.principalId ||
    entry.authorityOrigin !== before.authorityOrigin ||
    entry.bindingGeneration !== before.bindingGeneration
  )) {
    throw coded("chat_mapping_mismatch", "Existing chat mapping does not match expected before state");
  }
  const nextMappings = { ...current.mappings };
  delete nextMappings[selectorId];
  const nextPayload = {
    schema: CHAT_MAPPING_SCHEMA,
    version: CHAT_MAPPING_VERSION,
    sequence: current.sequence + 1,
    mappings: nextMappings,
  };
  writeChatMappingsAtomic(current.path, nextPayload);
  return readChatMappings({ storeRoot: current.storeRoot });
}

export function revokeChatMapping(options) {
  return withLockedChatMappings(options.storeRoot, (current) => revokeChatMappingInLock(current, options));
}

export function resolveChatDestinationForPrincipal({ storeRoot, principalId, destination, attachedSessions }) {
  if (!destination || !AGENT_ID_PATTERN.test(principalId)) {
    return { ok: false, reason: "destination_not_configured" };
  }
  // The snapshot only returns a destination for an active mesh binding, and it
  // carries that binding's generation and authority. A mapping stored against a
  // revoked or older binding must not deliver.
  if (
    !Number.isSafeInteger(destination.bindingGeneration) ||
    destination.bindingGeneration < 1 ||
    typeof destination.authorityOrigin !== "string"
  ) {
    return { ok: false, reason: "destination_binding_inactive" };
  }
  const store = readChatMappings({ storeRoot });
  if (store.state === "absent") {
    return { ok: false, reason: "chat_mapping_missing" };
  }
  const entry = Object.values(store.mappings).find(
    (m) => m.principalId === principalId && m.harness === destination.harness && m.workspace === destination.workspace
  );
  if (!entry) {
    return { ok: false, reason: "chat_mapping_missing" };
  }
  if (entry.bindingGeneration !== destination.bindingGeneration || entry.authorityOrigin !== destination.authorityOrigin) {
    return { ok: false, reason: "chat_mapping_stale_generation" };
  }
  if (entry.state !== "confirmed" || !entry.sessionAddress) {
    return { ok: false, reason: "chat_mapping_unconfirmed" };
  }
  const matches = (attachedSessions ?? []).filter(
    (s) => s && s.address === entry.sessionAddress && s.harness === entry.harness && s.workspace === entry.workspace
  );
  if (matches.length === 0) {
    return { ok: false, reason: "destination_session_offline" };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "destination_session_ambiguous" };
  }
  return { ok: true, sessionAddress: matches[0].address, mapping: entry };
}

function probeMappingCacheKey(storeRoot) {
  const filePath = chatMappingFilePath(storeRoot);
  try {
    return cacheIdentity(fs.lstatSync(filePath));
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    const probe = new Error(error.code ?? "chat_mapping_unreadable");
    probe.code = error.code ?? "chat_mapping_unreadable";
    throw probe;
  }
}

function reportMappingFailure(storeRoot, error, log) {
  const code = typeof error?.code === "string" ? error.code : "chat_mapping_unreadable";
  const message = `chat mapping store at ${storeRoot} is unreadable (${code}); treating the session as unmapped`;
  if (typeof log === "function") log(message);
  else console.error(message);
}

function readChatMappingsForSend(storeRoot, log) {
  let probeKey;
  try {
    probeKey = probeMappingCacheKey(storeRoot);
  } catch (error) {
    const cached = sendReadCache.get(storeRoot);
    const key = `error:${error.code ?? "unknown"}`;
    if (cached?.key === key) return null;
    reportMappingFailure(storeRoot, error, log);
    sendReadCache.set(storeRoot, { key, store: null });
    return null;
  }
  const cached = sendReadCache.get(storeRoot);
  if (cached && cached.key === probeKey) return cached.store;
  try {
    const loaded = loadChatMappings(storeRoot);
    sendReadCache.set(storeRoot, { key: loaded.cacheKey, store: loaded.store });
    return loaded.store;
  } catch (error) {
    if (error.code === "chat_mapping_store_missing") {
      sendReadCache.set(storeRoot, { key: probeKey, store: null });
      return null;
    }
    reportMappingFailure(storeRoot, error, log);
    sendReadCache.set(storeRoot, { key: probeKey, store: null });
    return null;
  }
}

export function lookupConfirmedChatMappingForSession({
  storeRoot,
  sessionAddress,
  harness,
  workspace,
  failSoft = false,
  log = null,
} = {}) {
  if (!storeRoot || !SESSION_ADDRESS_PATTERN.test(sessionAddress ?? "")) return null;
  let store;
  if (failSoft) {
    store = readChatMappingsForSend(storeRoot, log);
    if (!store) return null;
  } else {
    try {
      store = readChatMappings({ storeRoot });
    } catch (error) {
      if (error.code === "chat_mapping_store_missing") return null;
      throw error;
    }
  }
  if (store.state === "absent") return null;
  const entry = Object.values(store.mappings).find(
    (m) =>
      m.state === "confirmed" &&
      m.sessionAddress === sessionAddress &&
      (!harness || m.harness === harness) &&
      (!workspace || m.workspace === workspace)
  );
  if (!entry) return null;
  return Object.freeze({
    selectorId: entry.selectorId,
    principal: entry.principalId,
    authorityOrigin: entry.authorityOrigin,
    bindingGeneration: entry.bindingGeneration,
  });
}
