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
test('native provider validates correlated requests without requesting authentication',
 {skip:process.platform!=='darwin'||!binary},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-owner-validation-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const op={action:'profile.revoke',registryRoot:root,expectedSequence:1,profileId:'a'.repeat(64),
  before:{bindingId:'bind_'+'b'.repeat(32),bindingGeneration:1,principalId:'agent_'+'c'.repeat(32),authorityOrigin:'https://example.test',revokedAt:null}};
 const request={schema:'owner_operation_v1',...op,nonce:'9'.repeat(64),issuedAt:1000,deadline:61000};
 const wrap=request=>({version:1,canonicalRequest:canonicalJson(request),
  digest:createHash('sha256').update(canonicalJson(request)).digest('hex'),nonce:request.nonce,summary:describeOwnerOperation(request),timeoutMs:60000});
 const valid=wrap(request);
 const run=input=>spawnSync(binary,['--validate-request'],{input:JSON.stringify(input),encoding:'utf8',timeout:5000});
 const result=run(valid);assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{version:1,digest:valid.digest,nonce:valid.nonce,outcome:'unavailable'});
 for(const input of [{...valid,digest:'0'.repeat(64)},{...valid,summary:'another operation'},
  {...valid,timeoutMs:120001},wrap({...request,nonce:request.nonce+'\n'}),wrap({...request,profileId:request.profileId+'\n'})]){
  assert.equal(run(input).status,64);
 }
 assert.equal(spawnSync(binary,[],{encoding:'utf8',timeout:5000}).status,64);
});
