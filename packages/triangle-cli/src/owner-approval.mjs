// Library only: no production provider, registry writer, command or authority is
// installed here. Dependencies are trusted in-process adapters, never MCP/CLI input.
import { randomBytes, createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from './canonical.mjs';
import {
  AGENT_ID_PATTERN,
  DESTINATION_HARNESSES,
  INSTANCE_ID_PATTERN,
  isValidBareHttpsOrigin,
  isValidWorkspacePath,
  SELECTOR_ID_PATTERN,
} from '../../agent-worker/src/identity-primitives.mjs';

const fail = code => { const error = new Error(code); error.code = code; throw error; };
const invalid = () => fail('invalid_owner_operation');
const MAX_STORE_PATH_BYTES = 4096;

function keys(value, expected) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) invalid();
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isAgentId(value) {
  return typeof value === 'string' && value.length === 38 && AGENT_ID_PATTERN.test(value);
}

function isSelectorId(value) {
  return typeof value === 'string' && value.length === 36 && SELECTOR_ID_PATTERN.test(value);
}

function isHarness(value) {
  return typeof value === 'string' && DESTINATION_HARNESSES.includes(value);
}

function canonicalExistingDir(dirPath, maxBytes = MAX_STORE_PATH_BYTES) {
  if (typeof dirPath !== 'string' || dirPath.length === 0 || !dirPath.isWellFormed() ||
      Buffer.byteLength(dirPath, 'utf8') > maxBytes ||
      /[\p{Cc}\p{Cf}\\]/u.test(dirPath) || !path.isAbsolute(dirPath) || path.resolve(dirPath) !== dirPath) {
    invalid();
  }
  try {
    if (realpathSync(dirPath) !== dirPath || !statSync(dirPath).isDirectory()) invalid();
  } catch { invalid(); }
  return dirPath;
}

function canonicalExistingWorkspace(workspace) {
  if (!isValidWorkspacePath(workspace)) invalid();
  try {
    if (realpathSync(workspace) !== workspace || !statSync(workspace).isDirectory()) invalid();
  } catch { invalid(); }
  return workspace;
}

function identity(value, binding = false) {
  keys(value, binding ? ['bindingId','bindingGeneration','principalId','authorityOrigin','revokedAt'] : ['principalId','authorityOrigin']);
  if (!isAgentId(value.principalId) || !isValidBareHttpsOrigin(value.authorityOrigin)) invalid();
  if (binding && (typeof value.bindingId !== 'string' || value.bindingId.length !== 37 || !/^bind_[a-f0-9]{32}$/.test(value.bindingId) ||
      !isPositiveInt(value.bindingGeneration) || value.revokedAt !== null)) invalid();
  return Object.freeze({ ...value });
}

function destinationState(value) {
  keys(value, ['harness', 'workspace', 'generation']);
  if (!isHarness(value.harness) || !isValidWorkspacePath(value.workspace) || !isPositiveInt(value.generation)) invalid();
  return Object.freeze({ harness: value.harness, workspace: value.workspace, generation: value.generation });
}

function chatMapState(value) {
  keys(value, ['harness', 'workspace', 'principalId', 'authorityOrigin', 'bindingGeneration']);
  if (!isHarness(value.harness) || !isValidWorkspacePath(value.workspace) || !isAgentId(value.principalId) ||
      !isValidBareHttpsOrigin(value.authorityOrigin) || !isPositiveInt(value.bindingGeneration)) invalid();
  return Object.freeze({
    harness: value.harness,
    workspace: value.workspace,
    principalId: value.principalId,
    authorityOrigin: value.authorityOrigin,
    bindingGeneration: value.bindingGeneration,
  });
}

export function normalizeOwnerOperation(value) {
  if (!value || typeof value.action !== 'string') invalid();
  switch (value.action) {
    case 'profile.move':
    case 'profile.revoke': {
      keys(value, ['action','registryRoot','expectedSequence','profileId','before',...(value.action === 'profile.move' ? ['after'] : [])]);
      const registryRoot = canonicalExistingDir(value.registryRoot);
      if (!isPositiveInt(value.expectedSequence) || typeof value.profileId !== 'string' ||
          value.profileId.length !== 64 || !INSTANCE_ID_PATTERN.test(value.profileId)) invalid();
      const before = identity(value.before, true);
      const after = value.action === 'profile.move' ? identity(value.after) : null;
      if (after && before.principalId === after.principalId && before.authorityOrigin === after.authorityOrigin) invalid();
      return Object.freeze({
        action: value.action,
        registryRoot,
        expectedSequence: value.expectedSequence,
        profileId: value.profileId,
        before,
        ...(after ? { after } : {}),
      });
    }
    case 'destination.set': {
      keys(value, ['action','registryRoot','expectedSequence','principalId','harness','workspace','before']);
      const registryRoot = canonicalExistingDir(value.registryRoot);
      if (!isPositiveInt(value.expectedSequence) || !isAgentId(value.principalId) ||
          !isHarness(value.harness) || value.before !== null) invalid();
      const workspace = canonicalExistingWorkspace(value.workspace);
      return Object.freeze({
        action: value.action,
        registryRoot,
        expectedSequence: value.expectedSequence,
        principalId: value.principalId,
        harness: value.harness,
        workspace,
        before: null,
      });
    }
    case 'destination.clear': {
      keys(value, ['action','registryRoot','expectedSequence','principalId','before']);
      const registryRoot = canonicalExistingDir(value.registryRoot);
      if (!isPositiveInt(value.expectedSequence) || !isAgentId(value.principalId)) invalid();
      // Workspace directory may already have been deleted; syntax-only check allows clearing stale rules.
      const before = destinationState(value.before);
      return Object.freeze({
        action: value.action,
        registryRoot,
        expectedSequence: value.expectedSequence,
        principalId: value.principalId,
        before,
      });
    }
    case 'chat.map.set': {
      keys(value, ['action','storeRoot','expectedSequence','selectorId','harness','workspace','principalId','authorityOrigin','bindingGeneration','before']);
      const storeRoot = canonicalExistingDir(value.storeRoot);
      if (!isNonNegativeInt(value.expectedSequence) || !isSelectorId(value.selectorId) || !isHarness(value.harness) ||
          !isAgentId(value.principalId) || !isValidBareHttpsOrigin(value.authorityOrigin) ||
          !isPositiveInt(value.bindingGeneration) || value.before !== null) invalid();
      const workspace = canonicalExistingWorkspace(value.workspace);
      return Object.freeze({
        action: value.action,
        storeRoot,
        expectedSequence: value.expectedSequence,
        selectorId: value.selectorId,
        harness: value.harness,
        workspace,
        principalId: value.principalId,
        authorityOrigin: value.authorityOrigin,
        bindingGeneration: value.bindingGeneration,
        before: null,
      });
    }
    case 'chat.map.revoke': {
      keys(value, ['action','storeRoot','expectedSequence','selectorId','before']);
      const storeRoot = canonicalExistingDir(value.storeRoot);
      if (!isPositiveInt(value.expectedSequence) || !isSelectorId(value.selectorId)) invalid();
      // Workspace directory may already have been deleted; syntax-only check allows revoking stale selectors.
      const before = chatMapState(value.before);
      return Object.freeze({
        action: value.action,
        storeRoot,
        expectedSequence: value.expectedSequence,
        selectorId: value.selectorId,
        before,
      });
    }
    default:
      invalid();
  }
}

export function describeOwnerOperation(op) {
  switch (op?.action) {
    case 'profile.move':
    case 'profile.revoke':
      return `${op.action}: ${op.profileId}\nRegistry: ${op.registryRoot}\nSequence: ${op.expectedSequence}\n` +
        `From: ${op.before.principalId} at ${op.before.authorityOrigin}\n` +
        (op.after ? `To: ${op.after.principalId} at ${op.after.authorityOrigin}` : 'Revoke this binding');
    case 'destination.set':
      return `${op.action}: ${op.principalId}\nRegistry: ${op.registryRoot}\nSequence: ${op.expectedSequence}\n` +
        `Target: ${op.harness} chat in ${op.workspace}`;
    case 'destination.clear':
      return `${op.action}: ${op.principalId}\nRegistry: ${op.registryRoot}\nSequence: ${op.expectedSequence}\n` +
        `Clear: ${op.before.harness} chat in ${op.before.workspace} (gen ${op.before.generation})`;
    case 'chat.map.set':
      return `${op.action}: ${op.selectorId}\nStore: ${op.storeRoot}\nSequence: ${op.expectedSequence}\n` +
        `Selector: ${op.harness} chat in ${op.workspace}\n` +
        `Principal: ${op.principalId} at ${op.authorityOrigin} (gen ${op.bindingGeneration})`;
    case 'chat.map.revoke':
      return `${op.action}: ${op.selectorId}\nStore: ${op.storeRoot}\nSequence: ${op.expectedSequence}\n` +
        `Selector: ${op.before.harness} chat in ${op.before.workspace}\n` +
        `Principal: ${op.before.principalId} at ${op.before.authorityOrigin} (gen ${op.before.bindingGeneration})\n` +
        'Revoke this chat mapping';
    default:
      invalid();
  }
}

export function createUnavailableOwnerApprovalProvider() {
  return Object.freeze({ authenticate: async () => 'unavailable' });
}

// withLockedRegistry / withLockedStore (root, callback) must hold the exclusive
// lock synchronously while invoking callback once with { sequence, binding|before, commit }.
// `commit(operation)` must synchronously perform that exact audited mutation.
export function createOwnerApprovalCoordinator({
  provider = createUnavailableOwnerApprovalProvider(),
  withLockedRegistry,
  withLockedStore,
  clockMs = () => Math.floor(performance.now()),
} = {}) {
  const lockAdapter = withLockedStore ?? withLockedRegistry;
  const pending = new WeakMap();
  function now() {
    const value = clockMs();
    if (!Number.isSafeInteger(value) || value < 0) fail('owner_approval_clock_invalid');
    return value;
  }
  function fresh(record) {
    const time = now();
    if (time < record.issuedAt || time >= record.deadline) fail('owner_approval_expired');
  }
  function prepare(value, { ttlMs = 60000 } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120000) invalid();
    const op = normalizeOwnerOperation(value), issuedAt = now(), deadline = issuedAt + ttlMs;
    if (!Number.isSafeInteger(deadline)) invalid();
    const request = Object.freeze({ schema: 'owner_operation_v1', ...op,
      nonce: randomBytes(32).toString('hex'), issuedAt, deadline });
    const digest = createHash('sha256').update(canonicalJson(request)).digest('hex');
    const summary = describeOwnerOperation(op);
    const challenge = Object.freeze({ request, digest, summary });
    const handle = Object.freeze({}); // no serializable approval or reusable receipt
    pending.set(handle, { op, issuedAt, deadline, challenge, used: false });
    return handle;
  }
  async function execute(handle, { signal } = {}) {
    const record = handle && typeof handle === 'object' ? pending.get(handle) : null;
    if (!record) fail('owner_approval_invalid_handle');
    if (record.used) fail('owner_approval_replayed');
    record.used = true; // one attempt, including denial, failure and concurrent calls
    fresh(record);
    if (signal?.aborted) fail('owner_approval_cancelled');
    if (typeof provider?.authenticate !== 'function' || typeof lockAdapter !== 'function') fail('owner_approval_unavailable');
    const controller = new AbortController();
    let timer, onAbort;
    let outcome;
    try {
      outcome = await new Promise((resolve, reject) => {
        const refuse = code => { controller.abort(); const error = new Error(code); error.code = code; reject(error); };
        onAbort = () => refuse('owner_approval_cancelled');
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => refuse('owner_approval_expired'), Math.max(1, record.deadline - now()));
        Promise.resolve().then(() => {
          // Cancellation/expiry may occur before this microtask starts. Do not
          // open an OS prompt after the operation has already been refused.
          if (controller.signal.aborted) return;
          try { fresh(record); } catch (error) { controller.abort(); reject(error); return; }
          return provider.authenticate(record.challenge, { signal: controller.signal });
        }).then(resolve, () => refuse('owner_approval_unavailable'));
      });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    if (signal?.aborted) fail('owner_approval_cancelled');
    fresh(record);
    if (outcome !== 'approved') {
      if (outcome === 'denied') fail('owner_approval_denied');
      if (outcome === 'cancelled') fail('owner_approval_cancelled');
      fail('owner_approval_unavailable');
    }
    let entered = false, transactionOpen = true;
    let result;
    const storeRoot = record.op.registryRoot ?? record.op.storeRoot;
    try {
      result = lockAdapter(storeRoot, state => {
        if (!transactionOpen) fail('owner_approval_unavailable');
        if (entered) fail('owner_approval_replayed');
        entered = true;
        fresh(record);
        if (signal?.aborted) fail('owner_approval_cancelled');
        const currentBefore = state && Object.hasOwn(state, 'before') ? state.before : (state?.binding ?? null);
        if (state?.sequence !== record.op.expectedSequence || canonicalJson(currentBefore) !== canonicalJson(record.op.before)) {
          fail('owner_approval_stale');
        }
        if (typeof state.commit !== 'function') fail('owner_approval_unavailable');
        return state.commit(record.op);
      });
    } finally { transactionOpen = false; }
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      fail('owner_approval_unavailable');
    }
    if (!entered) fail('owner_approval_unavailable');
    return result;
  }
  return Object.freeze({ prepare, execute });
}
