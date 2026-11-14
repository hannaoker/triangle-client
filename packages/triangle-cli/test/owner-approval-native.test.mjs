// Opt-in native check. Always validation-only: it never invokes --authenticate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../src/canonical.mjs';
import {describeOwnerOperation} from '../src/owner-approval.mjs';

const binary=process.env.TRIANGLE_OWNER_APPROVAL_NATIVE_BIN;
test('native provider validates all owner-operation kinds without requesting authentication',
 {skip:process.platform!=='darwin'||!binary},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-owner-validation-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const workspace=path.join(root,'ws');fs.mkdirSync(workspace,{mode:0o700});
 const principal='agent_'+'c'.repeat(32),selectorId='sel_'+'e'.repeat(32);
 const validOps=[
  {action:'profile.revoke',registryRoot:root,expectedSequence:1,profileId:'a'.repeat(64),
   before:{bindingId:'bind_'+'b'.repeat(32),bindingGeneration:1,principalId:principal,authorityOrigin:'https://example.test',revokedAt:null}},
  {action:'profile.move',registryRoot:root,expectedSequence:2,profileId:'a'.repeat(64),
   before:{bindingId:'bind_'+'b'.repeat(32),bindingGeneration:1,principalId:principal,authorityOrigin:'https://example.test',revokedAt:null},
   after:{principalId:'agent_'+'d'.repeat(32),authorityOrigin:'https://other.example.test'}},
  {action:'destination.set',registryRoot:root,expectedSequence:3,principalId:principal,harness:'codex',workspace,before:null},
  {action:'destination.clear',registryRoot:root,expectedSequence:4,principalId:principal,before:{harness:'codex',workspace,generation:4}},
  {action:'chat.map.set',storeRoot:root,expectedSequence:0,selectorId,harness:'claude',workspace,principalId:principal,authorityOrigin:'https://example.test',bindingGeneration:1,before:null},
  {action:'chat.map.revoke',storeRoot:root,expectedSequence:1,selectorId,before:{harness:'claude',workspace,principalId:principal,authorityOrigin:'https://example.test',bindingGeneration:1}},
 ];
 const wrapRaw=(canonicalRequest,op)=>{
  const parsed=JSON.parse(canonicalRequest);
  return {version:1,canonicalRequest,digest:createHash('sha256').update(canonicalRequest).digest('hex'),
   nonce:parsed.nonce,summary:op.action?describeOwnerOperation(op):'x',timeoutMs:60000};
 };
 const wrap=(request,op=request)=>wrapRaw(canonicalJson(request),op);
 const run=input=>spawnSync(binary,['--validate-request'],{input:JSON.stringify(input),encoding:'utf8',timeout:5000});

 for(const op of validOps){
  const request={schema:'owner_operation_v1',...op,nonce:'9'.repeat(64),issuedAt:1000,deadline:61000};
  const valid=wrap(request,op);
  const result=run(valid);
  assert.equal(result.status,0,`${op.action}: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout),{version:1,digest:valid.digest,nonce:valid.nonce,outcome:'unavailable'});
 }

 const baseRevoke={schema:'owner_operation_v1',...validOps[0],nonce:'9'.repeat(64),issuedAt:1000,deadline:61000};
 const baseDest=validOps[2],baseChat=validOps[4];
 const makeReq=op=>({schema:'owner_operation_v1',...op,nonce:'9'.repeat(64),issuedAt:1000,deadline:61000});
 const invalidWraps=[
  {...wrap(baseRevoke),digest:'0'.repeat(64)},
  {...wrap(baseRevoke),summary:'another operation'},
  {...wrap(baseRevoke),timeoutMs:120001},
  {...wrap(baseRevoke),version:true},
  wrap({...baseRevoke,nonce:baseRevoke.nonce+'\n'},baseRevoke),
  wrap({...baseRevoke,profileId:baseRevoke.profileId+'\n'},baseRevoke),
  wrap({...baseRevoke,expectedSequence:true},baseRevoke),
  wrapRaw(canonicalJson(baseRevoke).replace('"expectedSequence":1','"expectedSequence":1.5'),baseRevoke),
  wrap({...baseRevoke,deadline:122000},baseRevoke),
  wrap(makeReq({...baseDest,before:{}}),baseDest),
  wrap(makeReq({...baseDest,workspace:`${workspace}/`}),baseDest),
  wrap(makeReq({...baseDest,workspace:'/tmp/../etc'}),baseDest),
  wrap(makeReq({...baseDest,harness:'cursor'}),baseDest),
  wrap(makeReq({...baseChat,expectedSequence:-1}),baseChat),
  wrap(makeReq({...baseChat,selectorId:'agent_'+'e'.repeat(32)}),baseChat),
  wrap(makeReq({...baseChat,authorityOrigin:'https://example.test/path'}),baseChat),
  wrap(makeReq({...baseChat,extra:1}),baseChat),
 ];
 for(const bad of invalidWraps){
  assert.equal(run(bad).status,64);
 }
 assert.equal(spawnSync(binary,[],{encoding:'utf8',timeout:5000}).status,64);
});
