// The guarded owner CLI bridge connects its trusted approval coordinator to
// the existing synchronous, locked, audited revoke transaction. A move needs
// a separately versioned audit action; never disguise it as a v1 bind/revoke.
import { updateIdentityRegistry } from '../../agent-worker/src/identity-registry.mjs';
import { canonicalJson } from './canonical.mjs';
import { normalizeOwnerOperation } from './owner-approval.mjs';

function fail(code) { const error = new Error(code); error.code = code; throw error; }

function observation(binding) {
  if (!binding) return null;
  return Object.freeze({ bindingId: binding.binding_id, bindingGeneration: binding.binding_generation,
    principalId: binding.principal_id, authorityOrigin: binding.authority_origin, revokedAt: binding.revoked_at });
}

function destinationObservation(record) {
  if (!record) return null;
  return Object.freeze({ harness: record.harness, workspace: record.workspace, generation: record.generation });
}

function createLockedRegistryAdapter(op, { now, action, subject, obsKey, readBefore, applyMutation }) {
  const exactOperation = canonicalJson(op);
  return function withLockedRegistry(root, inspect) {
    if (root !== op.registryRoot || typeof inspect !== 'function') fail('invalid_owner_operation');
    const date = new Date(typeof now === 'function' ? now() : now ?? Date.now());
    if (!Number.isFinite(date.getTime())) fail('invalid_owner_operation');
    const timestamp = date.toISOString();
    return updateIdentityRegistry({
      root,
      expectedSequence: op.expectedSequence,
      now: timestamp,
      action,
      subject,
      mutate(registry) {
        let open = true;
        let committed = false;
        try {
          const result = inspect(Object.freeze({
            sequence: registry.sequence,
            [obsKey]: readBefore(registry),
            commit(approvedOperation) {
              if (!open || committed) fail('owner_approval_replayed');
              if (canonicalJson(approvedOperation) !== exactOperation) fail('owner_approval_stale');
              if (canonicalJson(readBefore(registry)) !== canonicalJson(op.before)) fail('owner_approval_stale');
              applyMutation(registry, timestamp);
              committed = true;
              return registry;
            },
          }));
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch(() => {});
            fail('owner_approval_unavailable');
          }
          if (!committed) fail('owner_approval_unavailable');
          return registry;
        } finally {
          open = false;
        }
      },
    });
  };
}

export function createRegistryRevokeAdapter(value, { now } = {}) {
  const op = normalizeOwnerOperation(value);
  if (op.action !== 'profile.revoke') fail('owner_approval_action_unavailable');
  return createLockedRegistryAdapter(op, {
    now,
    action: 'revoke',
    subject: op.profileId,
    obsKey: 'binding',
    readBefore: (registry) => observation(registry.bindings[op.profileId]),
    // One captured timestamp covers both revocation and its audit entry.
    applyMutation: (registry, revokedAt) => { registry.bindings[op.profileId].revoked_at = revokedAt; },
  });
}

export function createRegistryDestinationAdapter(value, { now } = {}) {
  const op = normalizeOwnerOperation(value);
  if (op.action !== 'destination.set' && op.action !== 'destination.clear') {
    fail('owner_approval_action_unavailable');
  }
  const set = op.action === 'destination.set';
  return createLockedRegistryAdapter(op, {
    now,
    action: set ? 'destination_set' : 'destination_clear',
    subject: op.principalId,
    obsKey: 'before',
    readBefore: (registry) => destinationObservation(registry.destinations[op.principalId]),
    applyMutation: (registry, setAt) => {
      if (set) {
        registry.destinations[op.principalId] = {
          harness: op.harness,
          workspace: op.workspace,
          set_at: setAt,
          generation: op.expectedSequence + 1,
        };
      } else {
        delete registry.destinations[op.principalId];
      }
    },
  });
}
