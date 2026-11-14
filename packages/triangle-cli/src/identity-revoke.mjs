// Owner-only CLI bridge. It never reads workload credentials or sends network requests.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './canonical.mjs';
import { readIdentityRegistry } from '../../agent-worker/src/identity-registry.mjs';
import { deriveClientInstanceId, isValidProfileName } from '../../agent-worker/src/identity-primitives.mjs';
import { createOwnerApprovalCoordinator, normalizeOwnerOperation, describeOwnerOperation } from './owner-approval.mjs';
import { loadPackagedOwnerApprovalProvider } from './owner-approval-package.mjs';
import { createRegistryRevokeAdapter } from './owner-approval-registry.mjs';

function fail(code) { const error = new Error(code); error.code = code; throw error; }

export function loadPackagedRevokeProvider({ releaseRoot, platform = process.platform } = {}) {
  return loadPackagedOwnerApprovalProvider({ command: 'identity.revoke', releaseRoot, platform });
}

export function planIdentityRevoke({registryRoot,profile}) {
  if(typeof registryRoot!=='string'||!path.isAbsolute(registryRoot)||!isValidProfileName(profile))fail('invalid_owner_operation');
  const read=readIdentityRegistry({root:registryRoot});
  const profileId=deriveClientInstanceId(profile),binding=read.state==='ok'?read.registry.bindings[profileId]:null;
  if(!binding||binding.revoked_at!==null)fail('identity_binding_not_active');
  // A serverless-peer binding (registry v2) is no MESH-managed agent binding: this command revokes only those, and says so
  // here, before any operation is built or any OS authentication is asked for.
  if(binding.trust_mode!=='mesh-managed')fail('identity_binding_not_supported');
  const operation=normalizeOwnerOperation({action:'profile.revoke',registryRoot,expectedSequence:read.registry.sequence,profileId,
    before:{bindingId:binding.binding_id,bindingGeneration:binding.binding_generation,principalId:binding.principal_id,authorityOrigin:binding.authority_origin,revokedAt:null}});
  const body={schema:'identity_revoke_plan_v1',scope:'local-principal-binding',profile,operation};
  return Object.freeze({...body,planId:createHash('sha256').update(canonicalJson(body)).digest('hex')});
}

export async function identityRevoke({registryRoot,profile,confirm=null,provider,releaseRoot,now,signal,onOperation=()=>{}}) {
  const plan=planIdentityRevoke({registryRoot,profile});
  if(confirm===null)return plan;
  if(typeof confirm!=='string'||confirm.length!==64||!/^[a-f0-9]{64}$/.test(confirm))fail('confirmation_mismatch');
  if(confirm!==plan.planId)fail('plan_stale');
  const coordinator=createOwnerApprovalCoordinator({provider:provider??loadPackagedRevokeProvider({releaseRoot}),
    withLockedRegistry:createRegistryRevokeAdapter(plan.operation,{now})});
  // Exact, immutable operation is displayed before OS authentication. Plan output
  // is not approval; every application creates a fresh one-use auth challenge.
  await onOperation(describeOwnerOperation(plan.operation));
  const result=await coordinator.execute(coordinator.prepare(plan.operation),{signal});
  return {schema:'identity_revoke_result_v1',scope:'local-principal-binding',profile,profileId:plan.operation.profileId,
    principal:plan.operation.before.principalId,revoked:true,registrySequence:result.registry.sequence};
}

export function renderIdentityRevokePlan(plan) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const apply = `triangle identity revoke --registry-root ${quote(plan.operation.registryRoot)} --confirm ${plan.planId} -- ${quote(plan.profile)}`;
  return `Revoke local principal binding for ${plan.profile}\n${describeOwnerOperation(plan.operation)}\nPlan: ${plan.planId}\n`+
    'This removes principal-based routing only. Exact-id delivery and messaging grants are unchanged.\n'+
    `Fresh owner authentication is required. To apply this exact plan:\n${apply}`;
}
