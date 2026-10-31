// Library only: no production provider, registry writer, command or authority is
// installed here. Dependencies are trusted in-process adapters, never MCP/CLI input.
import { randomBytes, createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from './canonical.mjs';
import { AGENT_ID_PATTERN, INSTANCE_ID_PATTERN, isValidBareHttpsOrigin } from '../../agent-worker/src/identity-primitives.mjs';

const fail = code => { const error = new Error(code); error.code = code; throw error; };
const invalid = () => fail('invalid_owner_operation');
function keys(value, expected) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) invalid();
}
function identity(value, binding = false) {
  keys(value, binding ? ['bindingId','bindingGeneration','principalId','authorityOrigin','revokedAt'] : ['principalId','authorityOrigin']);
  if (typeof value.principalId !== 'string' || !AGENT_ID_PATTERN.test(value.principalId) || !isValidBareHttpsOrigin(value.authorityOrigin)) invalid();
  if (binding && (typeof value.bindingId !== 'string' || !/^bind_[a-f0-9]{32}$/.test(value.bindingId) ||
      !Number.isSafeInteger(value.bindingGeneration) || value.bindingGeneration < 1 || value.revokedAt !== null)) invalid();
  return Object.freeze({ ...value });
}
function operation(value) {
  if (!value || !['profile.move','profile.revoke'].includes(value.action)) invalid();
  keys(value, ['action','registryRoot','expectedSequence','profileId','before',...(value.action === 'profile.move' ? ['after'] : [])]);
  const root = value.registryRoot;
  if (typeof root !== 'string' || /[\p{Cc}\p{Cf}]/u.test(root) || !path.isAbsolute(root) || path.resolve(root) !== root ||
      !Number.isSafeInteger(value.expectedSequence) || value.expectedSequence < 1 ||
      typeof value.profileId !== 'string' || !INSTANCE_ID_PATTERN.test(value.profileId)) invalid();
  try { if (realpathSync(root) !== root || !statSync(root).isDirectory()) invalid(); } catch { invalid(); }
  const before = identity(value.before, true);
  const after = value.action === 'profile.move' ? identity(value.after) : null;
  if (after && before.principalId === after.principalId && before.authorityOrigin === after.authorityOrigin) invalid();
  return Object.freeze({ action: value.action, registryRoot: root, expectedSequence: value.expectedSequence,
    profileId: value.profileId, before, ...(after ? { after } : {}) });
}

export function createUnavailableOwnerApprovalProvider() {
  return Object.freeze({ authenticate: async () => 'unavailable' });
}

// withLockedRegistry(root, callback) must hold the existing exclusive registry
// lock while invoking callback once with { sequence, binding, commit }. `binding`
// is this profile's exact before projection (or null). `commit(operation)` must
// synchronously perform that exact dedicated audited mutation, retaining D2/D3
// invariants. No production adapter exists yet; fake adapters only prove protocol
// logic, not locking, OS authentication or a durable commit.
export function createOwnerApprovalCoordinator({
  provider = createUnavailableOwnerApprovalProvider(), withLockedRegistry,
  clockMs = () => Math.floor(performance.now()),
} = {}) {
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
    const op = operation(value), issuedAt = now(), deadline = issuedAt + ttlMs;
    if (!Number.isSafeInteger(deadline)) invalid();
    const request = Object.freeze({ schema: 'owner_operation_v1', ...op,
      nonce: randomBytes(32).toString('hex'), issuedAt, deadline });
    const digest = createHash('sha256').update(canonicalJson(request)).digest('hex');
    const summary = `${op.action}: ${op.profileId}\nRegistry: ${op.registryRoot}\nSequence: ${op.expectedSequence}\n` +
      `From: ${op.before.principalId} at ${op.before.authorityOrigin}\n` +
      (op.after ? `To: ${op.after.principalId} at ${op.after.authorityOrigin}` : 'Revoke this binding');
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
    if (typeof provider?.authenticate !== 'function' || typeof withLockedRegistry !== 'function') fail('owner_approval_unavailable');
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
    let entered = false;
    const result = await withLockedRegistry(record.op.registryRoot, state => {
      if (entered) fail('owner_approval_replayed');
      entered = true;
      fresh(record);
      if (signal?.aborted) fail('owner_approval_cancelled');
      if (state?.sequence !== record.op.expectedSequence || canonicalJson(state?.binding ?? null) !== canonicalJson(record.op.before)) {
        fail('owner_approval_stale');
      }
      if (typeof state.commit !== 'function') fail('owner_approval_unavailable');
      return state.commit(record.op);
    });
    if (!entered) fail('owner_approval_unavailable');
    return result;
  }
  return Object.freeze({ prepare, execute });
}
