// The guarded owner CLI bridge connects its trusted approval coordinator to
// the existing synchronous, locked, audited v1 revoke transaction. A move needs
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

export function createRegistryRevokeAdapter(value, { now } = {}) {
  const op = normalizeOwnerOperation(value);
  if (op.action !== 'profile.revoke') fail('owner_approval_action_unavailable');
  const exactOperation = canonicalJson(op);
  return function withLockedRegistry(root, inspect) {
    if (root !== op.registryRoot || typeof inspect !== 'function') fail('invalid_owner_operation');
    const date = new Date(typeof now === 'function' ? now() : now ?? Date.now());
    if (!Number.isFinite(date.getTime())) fail('invalid_owner_operation');
    const revokedAt = date.toISOString();
    return updateIdentityRegistry({ root, expectedSequence: op.expectedSequence, now: revokedAt,
      action: 'revoke', subject: op.profileId,
      mutate(registry) {
        let open = true, committed = false;
        try {
          const result = inspect(Object.freeze({ sequence: registry.sequence,
            binding: observation(registry.bindings[op.profileId]),
            commit(approvedOperation) {
              if (!open || committed) fail('owner_approval_replayed');
              if (canonicalJson(approvedOperation) !== exactOperation) fail('owner_approval_stale');
              const binding = registry.bindings[op.profileId];
              if (canonicalJson(observation(binding)) !== canonicalJson(op.before)) fail('owner_approval_stale');
              // One captured timestamp covers both revocation and its audit entry.
              binding.revoked_at = revokedAt;
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
        } finally { open = false; }
      },
    });
  };
}
