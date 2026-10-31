import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createOwnerApprovalCoordinator } from '../src/owner-approval.mjs';
import { createRegistryRevokeAdapter } from '../src/owner-approval-registry.mjs';
import { updateIdentityRegistry, readIdentityRegistry } from '../../agent-worker/src/identity-registry.mjs';
import { initIdentityRegistry, bindProfileInRegistry } from '../../agent-worker/test/local-messaging-identity-fixtures.mjs';

function fixture(t) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'owner-revoke-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 initIdentityRegistry(root);
 const a=bindProfileInRegistry(root,'alpha',1),b=bindProfileInRegistry(root,'beta',2);
 const revokedAt=new Date(Date.now()+60000).toISOString();
 const op={action:'profile.revoke',registryRoot:root,expectedSequence:3,profileId:a.profile_instance_id,
  before:{bindingId:a.binding_id,bindingGeneration:a.binding_generation,principalId:a.principal_id,authorityOrigin:a.authority_origin,revokedAt:null}};
 const bytes=()=>['identity-registry-v1.json','registry-audit.jsonl'].map(f=>fs.readFileSync(path.join(root,f)).toString('hex'));
 return {root,a,b,op,revokedAt,bytes,read:()=>readIdentityRegistry({root}),
  coord(authenticate=async()=> 'approved',options={}) {return createOwnerApprovalCoordinator({provider:{authenticate},
   withLockedRegistry:createRegistryRevokeAdapter(op,{now:revokedAt}),...options});}};
}

test('approved revoke uses the actual locked transaction and appends one audit; sibling stays unchanged',async t=>{
 const f=fixture(t),before=f.read(),coord=f.coord(),handle=coord.prepare(f.op);
 const result=await coord.execute(handle);assert.equal(result.registry.sequence,4);
 const after=f.read();assert.equal(after.registry.bindings[f.a.profile_instance_id].revoked_at,f.revokedAt);
 assert.deepEqual(after.registry.bindings[f.b.profile_instance_id],before.registry.bindings[f.b.profile_instance_id]);
 assert.equal(result.auditEntry.action,'revoke');assert.equal(result.auditEntry.bindingId,f.a.binding_id);
 assert.equal(result.auditEntry.at,f.revokedAt);
 const bytes=f.bytes();await assert.rejects(coord.execute(handle),{code:'owner_approval_replayed'});assert.deepEqual(f.bytes(),bytes);
});

for(const outcome of ['denied','cancelled','unavailable'])test(`${outcome} leaves real registry and audit bytes unchanged`,async t=>{
 const f=fixture(t),before=f.bytes(),coord=f.coord(async()=>outcome);
 await assert.rejects(coord.execute(coord.prepare(f.op)),{code:`owner_approval_${outcome}`});assert.deepEqual(f.bytes(),before);
});

test('state changed during authentication is refused before the audited transaction mutates anything',async t=>{
 const f=fixture(t);let changed;
 const coord=f.coord(async()=>{
  updateIdentityRegistry({root:f.root,expectedSequence:3,action:'revoke',subject:f.b.profile_instance_id,
   mutate:r=>{r.bindings[f.b.profile_instance_id].revoked_at='2026-10-30T11:59:00.000Z';return r;}});
  changed=f.bytes();return 'approved';
 });
 await assert.rejects(coord.execute(coord.prepare(f.op)),{code:'registry_sequence_conflict'});
 assert.deepEqual(f.bytes(),changed);assert.equal(f.read().registry.bindings[f.a.profile_instance_id].revoked_at,null);
});

test('wrong original binding at the same sequence is refused inside the real lock without durable changes',async t=>{
 const f=fixture(t),before=f.bytes();f.op.before.bindingGeneration++;
 const coord=f.coord();await assert.rejects(coord.execute(coord.prepare(f.op)),{code:'owner_approval_stale'});
 assert.deepEqual(f.bytes(),before);
});

test('move cannot be smuggled into the v1 revoke adapter',t=>{
 const f=fixture(t),before=f.bytes();
 assert.throws(()=>createRegistryRevokeAdapter({...f.op,action:'profile.move',after:{principalId:f.b.principal_id,authorityOrigin:f.b.authority_origin}}),{code:'owner_approval_action_unavailable'});
 assert.deepEqual(f.bytes(),before);
});

test('retained commit callback cannot mutate or append after the lock returns',t=>{
 const f=fixture(t),adapter=createRegistryRevokeAdapter(f.op);let retained;
 assert.throws(()=>adapter(f.root,state=>{retained=state.commit;}),{code:'owner_approval_unavailable'});
 const before=f.bytes();assert.throws(()=>retained(f.op),{code:'owner_approval_replayed'});assert.deepEqual(f.bytes(),before);
});

test('the adapter refuses altered commit intent and asynchronous callbacks without durable changes',async t=>{
 const f=fixture(t),adapter=createRegistryRevokeAdapter(f.op),before=f.bytes();
 assert.throws(()=>adapter(f.root,state=>state.commit({...f.op,expectedSequence:4})),{code:'owner_approval_stale'});
 assert.deepEqual(f.bytes(),before);
 assert.throws(()=>adapter(f.root,async state=>state.commit(f.op)),{code:'owner_approval_unavailable'});
 await new Promise(r=>setImmediate(r));assert.deepEqual(f.bytes(),before);
});

test('expiry while the real registry is locked refuses without durable changes',async t=>{
 const f=fixture(t);let time=1000;
 const real=createRegistryRevokeAdapter(f.op),coord=f.coord(async()=> 'approved',{
  clockMs:()=>time,withLockedRegistry(root,fn){return real(root,state=>{time=61000;return fn(state);});}});
 const before=f.bytes();await assert.rejects(coord.execute(coord.prepare(f.op)),{code:'owner_approval_expired'});assert.deepEqual(f.bytes(),before);
});


test('the revoke transaction adapter is reachable only through the guarded owner CLI bridge',()=>{
 const packages=path.resolve(import.meta.dirname,'../..');
 const offenders=[];
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);
  if(entry.isDirectory())walk(file);
  else if(entry.isFile()&&file.endsWith('.mjs')&&!file.endsWith('/owner-approval-registry.mjs')&&file!==path.join(packages,'triangle-cli/src/identity-revoke.mjs')&&fs.readFileSync(file,'utf8').includes('owner-approval-registry'))offenders.push(file);
 }}
 for(const entry of fs.readdirSync(packages,{withFileTypes:true})){
  const src=path.join(packages,entry.name,'src');if(entry.isDirectory()&&fs.existsSync(src))walk(src);
 }
 assert.deepEqual(offenders,[]);
});
