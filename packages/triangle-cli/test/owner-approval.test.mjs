import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/canonical.mjs';
import { createOwnerApprovalCoordinator } from '../src/owner-approval.mjs';

function fixture(t, { authenticate = async () => 'approved', ttlMs = 60000 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'owner-approval-')));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const op = { action:'profile.move', registryRoot:root, expectedSequence:7, profileId:'a'.repeat(64),
    before:{ bindingId:'bind_'+'b'.repeat(32), bindingGeneration:2, principalId:'agent_'+'c'.repeat(32), authorityOrigin:'https://old.example.test', revokedAt:null },
    after:{ principalId:'agent_'+'d'.repeat(32), authorityOrigin:'https://new.example.test' } };
  let time = 1000, locked = false, commits = 0, calls = 0, challenge;
  const state = {sequence:7, binding:structuredClone(op.before),commit(value){
    assert.ok(locked);commits++;assert.deepEqual(value,op);return {committed:true};
  }};
  const coord = createOwnerApprovalCoordinator({clockMs:()=>time,
    provider:{async authenticate(value,options){assert.equal(locked,false);calls++;challenge=value;return authenticate(value,options);}},
    withLockedRegistry(rootArg,fn){assert.equal(rootArg,root);locked=true;try{return fn(state);}finally{locked=false;}},
  });
  return {root,op,state,coord,prepare:()=>coord.prepare(op,{ttlMs}),setTime:value=>time=value,
    get commits(){return commits;},get calls(){return calls;},get challenge(){return challenge;}};
}

test('approval commits the exact immutable operation once inside the lock, with a bound challenge',async t=>{
  const f=fixture(t),handle=f.prepare();
  assert.deepEqual(JSON.parse(JSON.stringify(handle)),{});
  assert.deepEqual(await f.coord.execute(handle),{committed:true});
  assert.equal(f.commits,1);assert.equal(f.calls,1);
  const {request,digest,summary}=f.challenge;
  assert.match(request.nonce,/^[a-f0-9]{64}$/);assert.equal(request.deadline,61000);
  assert.equal(digest,createHash('sha256').update(canonicalJson(request)).digest('hex'));
  assert.ok(summary.includes(f.op.before.principalId)&&summary.includes(f.op.after.authorityOrigin));
  assert.ok(Object.isFrozen(request)&&Object.isFrozen(request.before)&&Object.isFrozen(request.after));
  await assert.rejects(f.coord.execute(handle),{code:'owner_approval_replayed'});assert.equal(f.commits,1);
});

test('revoke is a separate bounded action without an after identity',async t=>{
  const f=fixture(t);f.op.action='profile.revoke';delete f.op.after;
  await f.coord.execute(f.prepare());assert.equal(f.commits,1);assert.match(f.challenge.summary,/Revoke/);
});

for(const [label,change] of [
  ['extra approval flag',op=>({...op,approved:true})],
  ['unknown action',op=>({...op,action:'shell.run'})],
  ['malformed profile',op=>({...op,profileId:'label'})],
  ['unknown before field',op=>({...op,before:{...op.before,key:'secret'}})],
  ['revoked before state',op=>({...op,before:{...op.before,revokedAt:'2026-10-30'}})],
  ['malformed principal',op=>({...op,after:{...op.after,principalId:'peer_'+'d'.repeat(32)}})],
  ['authority path',op=>({...op,after:{...op.after,authorityOrigin:'https://new.example.test/path'}})],
  ['unchanged identity',op=>({...op,after:{principalId:op.before.principalId,authorityOrigin:op.before.authorityOrigin}})],
  ['relative path',op=>({...op,registryRoot:'.'})],
  ['sequence zero',op=>({...op,expectedSequence:0})],
]) test(`prepare refuses ${label}`,t=>{
  const f=fixture(t);assert.throws(()=>f.coord.prepare(change(f.op)),{code:'invalid_owner_operation'});assert.equal(f.calls,0);
});

test('symlink registry and excessive deadline are refused',t=>{
  const f=fixture(t),alias=path.join(f.root,'alias');fs.symlinkSync(f.root,alias);
  assert.throws(()=>f.coord.prepare({...f.op,registryRoot:alias}),{code:'invalid_owner_operation'});
  assert.throws(()=>f.coord.prepare(f.op,{ttlMs:120001}),{code:'invalid_owner_operation'});
});

for(const [outcome,code] of [['denied','owner_approval_denied'],['cancelled','owner_approval_cancelled'],
  ['unavailable','owner_approval_unavailable'],[true,'owner_approval_unavailable'],[{approved:true},'owner_approval_unavailable']]) {
 test(`provider outcome ${JSON.stringify(outcome)} never commits`,async t=>{
  const f=fixture(t,{authenticate:async()=>outcome}),h=f.prepare();
  await assert.rejects(f.coord.execute(h),{code});assert.equal(f.commits,0);
  await assert.rejects(f.coord.execute(h),{code:'owner_approval_replayed'});
 });
}

test('no production provider defaults to unavailable without invoking a commit',async t=>{
 const f=fixture(t);let locks=0;
 const coord=createOwnerApprovalCoordinator({withLockedRegistry(){locks++;}});
 await assert.rejects(coord.execute(coord.prepare(f.op)),{code:'owner_approval_unavailable'});assert.equal(locks,0);
});

test('thrown provider errors are sanitized and do not commit',async t=>{
 const f=fixture(t,{authenticate:async()=>{throw Error('secret detail');}});
 await assert.rejects(f.coord.execute(f.prepare()),{code:'owner_approval_unavailable',message:'owner_approval_unavailable'});assert.equal(f.commits,0);
});

for(const kind of ['sequence','principal','origin','generation','bindingId','removed'])test(`changed ${kind} during authentication refuses under lock`,async t=>{
 let f;f=fixture(t,{authenticate:async()=>{
  if(kind==='sequence')f.state.sequence++;
  else if(kind==='removed')f.state.binding=null;
  else f.state.binding[{principal:'principalId',origin:'authorityOrigin',generation:'bindingGeneration',bindingId:'bindingId'}[kind]]='changed';
  return 'approved';
 }});
 await assert.rejects(f.coord.execute(f.prepare()),{code:'owner_approval_stale'});assert.equal(f.commits,0);
});

test('expiry before authentication, after authentication, and clock regression all refuse',async t=>{
 const f=fixture(t),h=f.prepare();f.setTime(61000);
 await assert.rejects(f.coord.execute(h),{code:'owner_approval_expired'});assert.equal(f.calls,0);
 let g;g=fixture(t,{authenticate:async()=>{g.setTime(61000);return 'approved';}});
 await assert.rejects(g.coord.execute(g.prepare()),{code:'owner_approval_expired'});assert.equal(g.commits,0);
 const k=fixture(t),kh=k.prepare();k.setTime(999);
 await assert.rejects(k.coord.execute(kh),{code:'owner_approval_expired'});
});

test('timeout cancels the provider and ignores a late approval',async t=>{
 let complete,providerSignal;
 const f=fixture(t,{ttlMs:20,authenticate:async(_,{signal})=>{providerSignal=signal;return await new Promise(r=>complete=r);}});
 await assert.rejects(f.coord.execute(f.prepare()),{code:'owner_approval_expired'});
 assert.equal(providerSignal.aborted,true);complete('approved');await new Promise(r=>setImmediate(r));assert.equal(f.commits,0);
});

test('cancellation before or during authentication does not commit',async t=>{
 const f=fixture(t),before=new AbortController();before.abort();
 await assert.rejects(f.coord.execute(f.prepare(),{signal:before.signal}),{code:'owner_approval_cancelled'});assert.equal(f.calls,0);
 const during=new AbortController(),g=fixture(t,{authenticate:async()=>{during.abort();return 'approved';}});
 await assert.rejects(g.coord.execute(g.prepare(),{signal:during.signal}),{code:'owner_approval_cancelled'});assert.equal(g.commits,0);
});

test('same handle cannot authenticate concurrently or in another coordinator',async t=>{
 let release;
 const f=fixture(t,{authenticate:async()=>await new Promise(r=>release=r)}),h=f.prepare(),first=f.coord.execute(h);
 await assert.rejects(f.coord.execute(h),{code:'owner_approval_replayed'});
 const other=fixture(t);await assert.rejects(other.coord.execute(h),{code:'owner_approval_invalid_handle'});
 await assert.rejects(other.coord.execute(JSON.parse(JSON.stringify(h))),{code:'owner_approval_invalid_handle'});
 release('approved');await first;assert.equal(f.commits,1);
});

test('mutation of caller inputs cannot change the operation after prepare',async t=>{
 const f=fixture(t),original=structuredClone(f.op),h=f.prepare();
 f.op.after.principalId='agent_'+'f'.repeat(32);
 f.state.commit=op=>{assert.deepEqual(op,original);return 'exact';};
 assert.equal(await f.coord.execute(h),'exact');
});

test('expiry is rechecked after waiting for the lock',async t=>{
 const f=fixture(t);let time=1000,commits=0;
 const coord=createOwnerApprovalCoordinator({clockMs:()=>time,provider:{authenticate:async()=> 'approved'},
  async withLockedRegistry(_root,fn){time=61000;return fn({sequence:7,binding:f.op.before,commit(){commits++;}});}});
 await assert.rejects(coord.execute(coord.prepare(f.op)),{code:'owner_approval_expired'});assert.equal(commits,0);
});

test('missing lock adapter does not even ask the provider, and an adapter that never enters refuses',async t=>{
 const f=fixture(t);let calls=0;
 const coord=createOwnerApprovalCoordinator({provider:{authenticate:async()=>{calls++;return 'approved';}}});
 await assert.rejects(coord.execute(coord.prepare(f.op)),{code:'owner_approval_unavailable'});assert.equal(calls,0);
 const empty=createOwnerApprovalCoordinator({provider:{authenticate:async()=> 'approved'},withLockedRegistry:()=>undefined});
 await assert.rejects(empty.execute(empty.prepare(f.op)),{code:'owner_approval_unavailable'});
});

test('immediate cancellation and expiry before provider dispatch never request authentication',async t=>{
 const f=fixture(t),controller=new AbortController(),first=f.coord.execute(f.prepare(),{signal:controller.signal});
 controller.abort();await assert.rejects(first,{code:'owner_approval_cancelled'});assert.equal(f.calls,0);
 const g=fixture(t),second=g.coord.execute(g.prepare());g.setTime(61000);
 await assert.rejects(second,{code:'owner_approval_expired'});assert.equal(g.calls,0);
});
