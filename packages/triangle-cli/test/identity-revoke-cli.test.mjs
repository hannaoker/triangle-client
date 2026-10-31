import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {main} from '../src/cli.mjs';
import {identityRevoke,planIdentityRevoke,loadPackagedRevokeProvider} from '../src/identity-revoke.mjs';
import {initIdentityRegistry,bindProfileInRegistry} from '../../agent-worker/test/local-messaging-identity-fixtures.mjs';
import {readIdentityRegistry,updateIdentityRegistry} from '../../agent-worker/src/identity-registry.mjs';

function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'identity-revoke-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const registry=path.join(root,'registry');initIdentityRegistry(registry);
 const a=bindProfileInRegistry(registry,'alpha',1),b=bindProfileInRegistry(registry,'beta',2);
 const bytes=()=>['identity-registry-v1.json','registry-audit.jsonl'].map(f=>fs.readFileSync(path.join(registry,f)).toString('hex'));
 return {root,registry,a,b,bytes,plan:()=>planIdentityRevoke({registryRoot:registry,profile:'alpha'}),
  async run(args=[],extra={}){const out=[],err=[];
   const code=await main(['identity','revoke','alpha','--registry-root',registry,...args],{env:{},io:{stdout:s=>out.push(s),stderr:s=>err.push(s)},...extra});
   return {code,out:out.join('\n'),err:err.join('\n')};
  }};
}

test('plan is deterministic, read-only and never authenticates',async t=>{
 const f=fixture(t),before=f.bytes();let calls=0;
 const result=await f.run(['--json'],{identityDependencies:{ownerApprovalProvider:{authenticate:async()=>{calls++;throw Error('must not authenticate');}}}});
 assert.equal(result.code,0,result.err);const plan=JSON.parse(result.out);
 assert.equal(plan.planId,f.plan().planId);assert.equal(plan.operation.profileId,f.a.profile_instance_id);
 assert.equal(calls,0);assert.deepEqual(f.bytes(),before);
});

test('missing root stays absent and inactive binding is refused',async t=>{
 const f=fixture(t),missing=path.join(f.root,'missing');
 assert.throws(()=>planIdentityRevoke({registryRoot:missing,profile:'alpha'}),{code:'identity_binding_not_active'});
 assert.equal(fs.existsSync(missing),false);
 const result=await f.run();assert.equal(result.code,0);assert.match(result.out,/Exact-id delivery and messaging grants are unchanged/i);
});

test('confirmation requires a local terminal and refuses SSH before authentication',async t=>{
 const f=fixture(t),plan=f.plan(),before=f.bytes();let calls=0;
 for(const extra of [{identityDependencies:{isTerminal:false}},{env:{SSH_CONNECTION:'fixture'},identityDependencies:{isTerminal:true}}]){
  extra.identityDependencies.ownerApprovalProvider={authenticate:async()=>{calls++;return 'approved';}};
  const result=await f.run(['--confirm',plan.planId],extra);assert.equal(result.code,2);assert.match(result.err,/local owner terminal/);
 }
 assert.equal(calls,0);assert.deepEqual(f.bytes(),before);
});

test('caller flags cannot inject approval or a provider executable',async t=>{
 const f=fixture(t),before=f.bytes();
 for(const args of [['--yes'],['--approved','true'],['--owner-approval-helper','/bin/true']]){
  const result=await f.run(args);assert.equal(result.code,2);assert.match(result.err,/unknown option/);
 }
 assert.deepEqual(f.bytes(),before);
});

test('wrong/stale plan refuses before asking provider',async t=>{
 const f=fixture(t),plan=f.plan();let calls=0;
 const deps={isTerminal:true,ownerApprovalProvider:{authenticate:async()=>{calls++;return 'approved';}}};
 const wrong=await f.run(['--confirm','0'.repeat(64)],{identityDependencies:deps});assert.equal(wrong.code,2);
 updateIdentityRegistry({root:f.registry,expectedSequence:3,action:'revoke',subject:f.b.profile_instance_id,
  mutate:r=>{r.bindings[f.b.profile_instance_id].revoked_at=new Date().toISOString();return r;}});
 const before=f.bytes(),stale=await f.run(['--confirm',plan.planId],{identityDependencies:deps});
 assert.equal(stale.code,2);assert.match(stale.err,/plan_stale/);assert.equal(calls,0);assert.deepEqual(f.bytes(),before);
});

for(const outcome of ['denied','cancelled','unavailable'])test(`CLI ${outcome} makes no durable changes`,async t=>{
 const f=fixture(t),before=f.bytes(),result=await f.run(['--confirm',f.plan().planId,'--json'],
  {identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async()=>outcome}}});
 assert.equal(result.code,1);assert.match(result.err,new RegExp(`owner_approval_${outcome}`));assert.deepEqual(f.bytes(),before);
});

test('CLI approval commits exactly one revoke through the actual registry lock and preserves siblings',async t=>{
 const f=fixture(t),plan=f.plan();let calls=0;
 const result=await f.run(['--confirm',plan.planId,'--json'],{identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async challenge=>{
  calls++;assert.equal(challenge.request.profileId,f.a.profile_instance_id);return 'approved';}}}});
 assert.equal(result.code,0,result.err);assert.equal(JSON.parse(result.out).registrySequence,4);assert.equal(calls,1);
 const after=readIdentityRegistry({root:f.registry}).registry;
 assert.ok(after.bindings[f.a.profile_instance_id].revoked_at);assert.deepEqual(after.bindings[f.b.profile_instance_id],f.b);
 const before=f.bytes(),again=await f.run(['--confirm',plan.planId],{identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async()=>{calls++;return 'approved';}}}});
 assert.equal(again.code,2);assert.equal(calls,1);assert.deepEqual(f.bytes(),before);
});

test('a concurrent registry change during provider authentication is not overwritten',async t=>{
 const f=fixture(t),plan=f.plan();let changed;
 const result=await f.run(['--confirm',plan.planId],{identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async()=>{
  updateIdentityRegistry({root:f.registry,expectedSequence:3,action:'revoke',subject:f.b.profile_instance_id,
   mutate:r=>{r.bindings[f.b.profile_instance_id].revoked_at=new Date().toISOString();return r;}});
  changed=f.bytes();return 'approved';}}}});
 assert.equal(result.code,1);assert.match(result.err,/registry_sequence_conflict/);assert.deepEqual(f.bytes(),changed);
});

test('source CLI and candidate manifests do not select a provider',async t=>{
 const f=fixture(t),release=path.join(f.root,'release');fs.mkdirSync(release,{mode:0o700});
 for(const manifest of [{schema:1,platform:'darwin',arch:process.arch,testOnly:false,ownerApprovalCandidate:{activation:'disabled'}},
  {schema:1,platform:'darwin',arch:process.arch,testOnly:true,ownerApproval:{version:1,binary:'bin/triangle-owner-approval',commands:['identity.revoke']},files:[]}]){
  fs.writeFileSync(path.join(release,'package-manifest.json'),JSON.stringify(manifest),{mode:0o600});
  assert.equal(await loadPackagedRevokeProvider({releaseRoot:release,platform:'darwin'}).authenticate({}),'unavailable');
 }
 const before=f.bytes(),result=await f.run(['--confirm',f.plan().planId],{identityDependencies:{isTerminal:true}});
 assert.equal(result.code,1);assert.match(result.err,/owner_approval_unavailable/);assert.deepEqual(f.bytes(),before);
});

test('an explicit release capability uses only its manifest-pinned helper (stand-in, not OS acceptance)',async t=>{
 const {createHash}=await import('node:crypto');
 const {canonicalJson}=await import('../src/canonical.mjs');
 const {describeOwnerOperation}=await import('../src/owner-approval.mjs');
 const {performance}=await import('node:perf_hooks');
 const f=fixture(t),release=path.join(f.root,'release'),bin=path.join(release,'bin');fs.mkdirSync(bin,{recursive:true,mode:0o700});
 const executable=path.join(bin,'triangle-owner-approval');
 fs.writeFileSync(executable,`#!/usr/bin/python3
import sys,json
r=json.load(sys.stdin)
print(json.dumps({'version':1,'digest':r['digest'],'nonce':r['nonce'],'outcome':'approved'},sort_keys=True,separators=(',',':')))
`,{mode:0o700});
 const manifest={schema:1,platform:'darwin',arch:process.arch,testOnly:false,signingMode:'public_ad_hoc',credentialCustody:'file',
  ownerApproval:{version:1,binary:'bin/triangle-owner-approval',commands:['identity.revoke']},
  files:[{path:'bin/triangle-owner-approval',mode:0o700,sha256:createHash('sha256').update(fs.readFileSync(executable)).digest('hex')}]};
 fs.writeFileSync(path.join(release,'package-manifest.json'),JSON.stringify(manifest),{mode:0o600});
 const request={schema:'owner_operation_v1',...f.plan().operation,nonce:'9'.repeat(64),issuedAt:Math.floor(performance.now()),deadline:Math.floor(performance.now())+5000};
 const challenge={request,digest:createHash('sha256').update(canonicalJson(request)).digest('hex'),summary:describeOwnerOperation(request)};
 const provider=loadPackagedRevokeProvider({releaseRoot:release,platform:'darwin'});
 assert.equal(await provider.authenticate(challenge),'approved');
 fs.appendFileSync(executable,'\n# changed');assert.equal(await provider.authenticate(challenge),'unavailable');
});


test('missing worker dependencies fail cleanly only when the revoke command is invoked',async t=>{
 const {pathToFileURL}=await import('node:url');
 const f=fixture(t),copy=path.join(f.root,'isolated-cli');
 fs.cpSync(path.resolve(import.meta.dirname,'../src'),path.join(copy,'src'),{recursive:true});
 const {main:isolated}=await import(pathToFileURL(path.join(copy,'src/cli.mjs')));
 const out=[],err=[];
 const code=await isolated(['identity','revoke','alpha','--registry-root',f.registry,'--json'],{env:{},io:{stdout:s=>out.push(s),stderr:s=>err.push(s)}});
 assert.equal(code,1);assert.equal(out.length,0);
 assert.equal(JSON.parse(err[0]).error,'owner_approval_unavailable');assert.equal(err.join('').includes(f.root),false);
});

test('cancellation reaches the provider and preserves bytes; CLI restores its interrupt listeners',async t=>{
 const f=fixture(t),before=f.bytes(),controller=new AbortController();
 await assert.rejects(identityRevoke({registryRoot:f.registry,profile:'alpha',confirm:f.plan().planId,signal:controller.signal,
  provider:{authenticate:async(_,{signal})=>{controller.abort();assert.equal(signal.aborted,true);return 'approved';}}}),{code:'owner_approval_cancelled'});
 assert.deepEqual(f.bytes(),before);
 const counts=['SIGINT','SIGTERM'].map(s=>process.listenerCount(s));
 const result=await f.run(['--confirm',f.plan().planId],{identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async()=> 'cancelled'}}});
 assert.equal(result.code,1);assert.deepEqual(['SIGINT','SIGTERM'].map(s=>process.listenerCount(s)),counts);assert.deepEqual(f.bytes(),before);
});
