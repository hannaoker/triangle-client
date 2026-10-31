// Owner-only CLI bridge. It never reads workload credentials or sends network requests.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './canonical.mjs';
import { readIdentityRegistry } from '../../agent-worker/src/identity-registry.mjs';
import { deriveClientInstanceId, isValidProfileName } from '../../agent-worker/src/identity-primitives.mjs';
import { createOwnerApprovalCoordinator, normalizeOwnerOperation, describeOwnerOperation, createUnavailableOwnerApprovalProvider } from './owner-approval.mjs';
import { createRegistryRevokeAdapter } from './owner-approval-registry.mjs';
import { createMacOSOwnerApprovalProvider } from './owner-approval-macos.mjs';

function fail(code) { const error = new Error(code); error.code = code; throw error; }
const releaseDefault=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
export function loadPackagedRevokeProvider({releaseRoot=releaseDefault,platform=process.platform}={}) {
  const unavailable=()=>createUnavailableOwnerApprovalProvider();
  try {
    if(platform!=='darwin'||realpathSync(releaseRoot)!==releaseRoot)return unavailable();
    const dir=lstatSync(releaseRoot),file=path.join(releaseRoot,'package-manifest.json'),stat=lstatSync(file);
    if(!dir.isDirectory()||dir.uid!==process.getuid()||(dir.mode&0o077)!==0||!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600||stat.size>1024*1024)return unavailable();
    const manifest=JSON.parse(readFileSync(file,'utf8')),policy=manifest.ownerApproval;
    if(manifest.schema!==1||manifest.platform!=='darwin'||manifest.arch!==process.arch||manifest.testOnly!==false||manifest.ownerApprovalCandidate!==undefined||manifest.signingMode!=='public_ad_hoc'||manifest.credentialCustody!=='file'||
       !policy||policy.version!==1||policy.binary!=='bin/triangle-owner-approval'||
       canonicalJson(policy.commands)!==canonicalJson(['identity.revoke']))return unavailable();
    const entries=manifest.files?.filter(entry=>entry.path===policy.binary);
    if(entries?.length!==1||entries[0].mode!==0o700||typeof entries[0].sha256!=='string'||!/^[a-f0-9]{64}$/.test(entries[0].sha256)||entries[0].sha256.length!==64)return unavailable();
    return createMacOSOwnerApprovalProvider({executable:path.join(releaseRoot,policy.binary),sha256:entries[0].sha256,platform});
  }catch{return unavailable();}
}

export function planIdentityRevoke({registryRoot,profile}) {
  if(typeof registryRoot!=='string'||!path.isAbsolute(registryRoot)||!isValidProfileName(profile))fail('invalid_owner_operation');
  const read=readIdentityRegistry({root:registryRoot});
  const profileId=deriveClientInstanceId(profile),binding=read.state==='ok'?read.registry.bindings[profileId]:null;
  if(!binding||binding.revoked_at!==null)fail('identity_binding_not_active');
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
