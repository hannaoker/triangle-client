import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setupLocalMessaging} from '../src/local-messaging-cli.mjs';
import {writePrivateJson,readPrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {createInstalledLocalMessagingHost,loadLocalMessagingConfig} from '../src/local-messaging-host.mjs';
import {createProfiledReasonerGate} from '../src/concurrency-gate.mjs';
import {createLocalControlClient} from '../src/local-messaging-client.mjs';
import {resolveLocalSocketAddress} from '../src/local-messaging-address.mjs';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../src/local-messaging-cli.mjs',import.meta.url));
test('production host executes via registered runner and preserves replies across restart',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-host-');let host,calls=0;
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
 try{
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'thread-current',enabled:false});
  setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'thread-current',recipients:['gravity2']});
  const config=readPrivateJson(configPath),recipient=config.recipients[0].instanceId;
  assert.equal(config.runnerTimeoutMs,3600000);
  writePrivateJson(configPath,{...config,runnerTimeoutMs:86400000});assert.equal(loadLocalMessagingConfig(configPath).runnerTimeoutMs,86400000);
  writePrivateJson(configPath,{...config,runnerTimeoutMs:86400001});assert.throws(()=>loadLocalMessagingConfig(configPath),{code:'invalid_local_config'});
  writePrivateJson(configPath,config);
  const runner={run:async (request,options)=>{assert.equal(options.timeoutMs,3600000);calls++;assert.equal(request.senderId,'a'.repeat(64));return {status:'completed',text:'assessment '+request.text};}};
  const make=()=>createInstalledLocalMessagingHost({configPath,runners:new Map([[recipient,runner]]),gate:createProfiledReasonerGate()});
  const run=async args=>JSON.parse((await exec(process.execPath,[cli,...args,'--config',configPath])).stdout);
  host=make();await host.start();
  assert.deepEqual((await run(['sessions'])).sessions,[{id:recipient,label:'gravity2',kind:'worker',presence:'unknown'}]);
  const sent=await run(['send','--to','gravity2','--text','inspect','--message-id','host-one','--request-id','host-request','--wait-ms','2000']);
  assert.equal(sent.replies[0].text,'assessment inspect');assert.equal(calls,1);
  assert.equal((await run(['status','--message-id','host-one'])).phase,'completed');
  const status=await run(['status']);assert.deepEqual(status.replyIdentity,{enabled:false,scope:'attached-chat-pairs'});assert.equal(status.journal.completed,1);assert.equal(status.journal.pendingReplies,1);
  await host.stop();host=make();await host.start();
  assert.equal((await run(['replies','--request-id','host-request'])).replies[0].inReplyTo,'host-one');
  await run(['send','--to','gravity2','--text','inspect','--message-id','host-one','--request-id','host-request']);
  await new Promise(r=>setTimeout(r,30));assert.equal(calls,1,'reconnect retry does not execute twice');
 }finally{await host?.stop();fs.rmSync(root,{recursive:true,force:true});}
});
test('an oversized reply is retrievable through the installed CLI, truncated and explicitly flagged, and can be consumed',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-big-');let host;
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
 try{
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'thread-current',enabled:false});
  setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'thread-current',recipients:['gravity2']});
  const recipient=readPrivateJson(configPath).recipients[0].instanceId;
  const runner={run:async()=>({status:'completed',text:'x'.repeat(300*1024)})};
  host=createInstalledLocalMessagingHost({configPath,runners:new Map([[recipient,runner]]),gate:createProfiledReasonerGate()});await host.start();
  const run=async args=>JSON.parse((await exec(process.execPath,[cli,...args,'--config',configPath])).stdout);
  const sent=await run(['send','--to','gravity2','--text','write a long report','--message-id','big-1','--request-id','big-req','--wait-ms','3000']);
  assert.equal(sent.waiting,undefined,'the wait receives the reply');
  assert.equal(sent.replies[0].truncated,true);assert.equal(sent.replies[0].originalTextBytes,300*1024);
  assert.equal((await run(['status','--message-id','big-1'])).phase,'completed');
  const listed=await run(['replies','--request-id','big-req']);assert.equal(listed.replies.length,1);
  await run(['consume','--message-id',sent.replies[0].messageId]);
  assert.deepEqual((await run(['replies','--request-id','big-req'])).replies,[]);
 }finally{await host?.stop();fs.rmSync(root,{recursive:true,force:true});}
});
test('the shared app-server host moving its own thread binding never breaks the installed local route',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-move-');let host;
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
 try{
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'app-server-thread',enabled:false});
  setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'conversation-one',recipients:['gravity2']});
  const recipient=readPrivateJson(configPath).recipients[0].instanceId;
  host=createInstalledLocalMessagingHost({configPath,runners:new Map([[recipient,{run:async()=>({status:'completed',text:'ok'})}]]),gate:createProfiledReasonerGate()});await host.start();
  const run=async args=>JSON.parse((await exec(process.execPath,[cli,...args,'--config',configPath])).stdout);
  assert.equal((await run(['discover'])).threadId,'conversation-one');
  // The production host rewrites its binding on every start and may mint a new thread.
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'freshly-minted-thread',enabled:false});
  const discovered=await run(['discover']);assert.equal(discovered.threadId,'conversation-one');assert.deepEqual(discovered.recipients,[recipient]);
  // A rebuilt host (supervisor retry or restart) also keeps working.
  await host.stop();host=createInstalledLocalMessagingHost({configPath,runners:new Map([[recipient,{run:async()=>({status:'completed',text:'ok'})}]]),gate:createProfiledReasonerGate()});await host.start();
  assert.equal((await run(['status'])).running,true);
 }finally{await host?.stop();fs.rmSync(root,{recursive:true,force:true});}
});
test('unauthenticated exchanges cannot exhaust the desktop bucket; only verified exchanges are charged to it',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-limit-');let host,client;
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
 try{
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'thread-current',enabled:false});
  setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'thread-current',recipients:['gravity2']});
  const config=readPrivateJson(configPath),integration=readPrivateJson(config.integrationPath),recipient=config.recipients[0].instanceId;
  host=createInstalledLocalMessagingHost({configPath,runners:new Map([[recipient,{run:async()=>({status:'completed',text:'ok'})}]]),gate:createProfiledReasonerGate()});await host.start();
  client=createLocalControlClient({socketPath:resolveLocalSocketAddress({stateRoot:config.stateRoot}).socketPath,senderId:integration.senderId});
  const good={bindingId:integration.bindingId,threadId:integration.threadId,secret:integration.secret};
  // A flood of failing attempts is throttled in its own bucket.
  const codes=[];
  for(let i=0;i<150;i++)await client.exchangeTurnBinding({...good,secret:'0'.repeat(64)}).catch(error=>codes.push(error.code));
  assert.ok(codes.includes('unauthorized'));assert.ok(codes.includes('rate_limit_exceeded'),'failed attempts are rate limited');
  assert.deepEqual([...new Set(codes)].sort(),['rate_limit_exceeded','unauthorized']);
  // ...so the real desktop is not locked out, and its own successful exchanges use its own bucket.
  let granted=0,limited=null;
  for(let i=0;i<130&&!limited;i++){try{assert.equal(typeof (await client.exchangeTurnBinding(good)).credential,'string');granted++;}catch(error){limited=error.code;}}
  assert.equal(granted,120);assert.equal(limited,'rate_limit_exceeded');
 }finally{await client?.close();await host?.stop();fs.rmSync(root,{recursive:true,force:true});}
});
