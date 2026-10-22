import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktopCredentialBroker, readPrivateJson, writePrivateJson} from '../src/local-messaging-auth-broker.mjs';

test('desktop broker authenticates a fixed binding and refuses stale thread or identity',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'triangle-broker-'));
 try {
  const bindingPath=path.join(root,'binding.json'), integrationPath=path.join(root,'integration.json');
  const data={version:1,bindingId:'desktop',senderId:'sender',threadId:'thread-current',secret:'a'.repeat(64)};
  writePrivateJson(bindingPath,{instanceId:'sender',threadId:'thread-current',enabled:false});
  writePrivateJson(integrationPath,data);
  const broker=createDesktopCredentialBroker({bindingPath,integrationPath,recipients:['recipient'],issue:(sender,opts)=>({sender,opts})});
  assert.equal(broker.exchange(data).sender,'sender');
  assert.deepEqual(broker.exchange(data).opts.allowedRecipients,['recipient']);
  assert.throws(()=>broker.exchange({...data,secret:'bad'}),{code:'unauthorized'});
  assert.throws(()=>broker.exchange({...data,threadId:'other'}),{code:'unauthorized'});
  writePrivateJson(integrationPath,{...data,secret:'b'.repeat(64)});
  assert.throws(()=>broker.exchange(data),{code:'unauthorized'});
  assert.equal(broker.exchange({...data,secret:'b'.repeat(64)}).sender,'sender');
  // The thread is fixed by the integration file, so the shared app-server host may move its own binding.
  writePrivateJson(bindingPath,{instanceId:'sender',threadId:'rebound',enabled:false});
  assert.equal(broker.exchange({...data,secret:'b'.repeat(64)}).sender,'sender');
  // The sender identity is still verified against the app-server binding.
  writePrivateJson(bindingPath,{instanceId:'someone-else',threadId:'thread-current',enabled:false});
  assert.throws(()=>broker.exchange({...data,secret:'b'.repeat(64)}),{code:'binding_changed'});
  assert.equal(readPrivateJson(bindingPath).enabled,false);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('private JSON rejects symlinks, hard links and public permissions',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'triangle-broker-'));
 try {
  const file=path.join(root,'private.json'); writePrivateJson(file,{ok:true});
  fs.symlinkSync(file,path.join(root,'link'));assert.throws(()=>readPrivateJson(path.join(root,'link')));
  fs.linkSync(file,path.join(root,'hard'));assert.throws(()=>readPrivateJson(file));fs.unlinkSync(path.join(root,'hard'));
  fs.chmodSync(file,0o644);assert.throws(()=>readPrivateJson(file));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('broker authenticates the secret before reporting any owner-side state and issues only after verification',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'triangle-broker-'));
 try {
  const bindingPath=path.join(root,'binding.json'), integrationPath=path.join(root,'integration.json');
  const data={version:1,bindingId:'desktop',senderId:'sender',threadId:'thread-current',secret:'a'.repeat(64)};
  writePrivateJson(bindingPath,{instanceId:'sender',threadId:'thread-current',enabled:false});
  writePrivateJson(integrationPath,data);
  let issued=0;
  const broker=createDesktopCredentialBroker({bindingPath,integrationPath,recipients:['recipient'],issue:()=>({credential:'c'+(++issued)})});
  broker.verify(data);assert.equal(issued,0,'verification never issues');
  assert.throws(()=>broker.verify({...data,secret:'bad'}),{code:'unauthorized'});
  assert.equal(broker.issue().credential,'c1');
  assert.equal(broker.exchange(data).credential,'c2','exchange is verification plus issuance');
  // After the owner moves the integration, an unauthenticated caller only ever sees unauthorized.
  writePrivateJson(integrationPath,{...data,threadId:'moved'});
  assert.throws(()=>broker.verify({...data,secret:'bad'}),{code:'unauthorized'});
  assert.throws(()=>broker.verify(data),{code:'unauthorized'});
  assert.throws(()=>broker.verify({...data,threadId:'moved'}),{code:'binding_changed'});
  assert.equal(issued,2);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
