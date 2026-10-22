import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setupLocalMessaging} from '../src/local-messaging-cli.mjs';
import {readPrivateJson,writePrivateJson,createDesktopCredentialBroker} from '../src/local-messaging-auth-broker.mjs';
import {createLocalMessagingSubsystem} from '../src/local-messaging-supervisor-seam.mjs';
import {createTestMemoryJournal,createTestRecoverableDispatcher} from './local-messaging-fixtures.mjs';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../src/local-messaging-cli.mjs',import.meta.url));
test('supported CLI binds explicitly, sends through one service, reconnects and consumes',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-cli-');
 let subsystem;
 try {
  const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'old-thread',enabled:false});
  const result=setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'new-thread',recipients:['gravity2']});
  assert.deepEqual(readPrivateJson(bindingPath),{instanceId:'a'.repeat(64),threadId:'old-thread',enabled:false},'production app-server binding is never rewritten');
  const config=readPrivateJson(configPath),integration=readPrivateJson(config.integrationPath),journal=createTestMemoryJournal();
  const recipient=config.recipients[0].instanceId;
  const broker=createDesktopCredentialBroker({...config,recipients:[recipient],issue:(sender,options)=>subsystem.issueTurnCredential(sender,options)});
  const dispatcher=createTestRecoverableDispatcher({journal,execute:async job=>{if(job.messageId==='wait-one')await new Promise(r=>setTimeout(r,450));return journal.recordReply({sender:recipient,recipient:integration.senderId,inReplyTo:job.messageId,requestId:job.requestId,messageId:'reply-'+job.messageId,text:'free form answer'});}});
  let exchanges=0,exchangeLimit=Infinity;
  subsystem=createLocalMessagingSubsystem({stateRoot:config.stateRoot,journal,dispatcher,registry:[integration.senderId,recipient],aclRules:{[integration.senderId]:[recipient]},credentialBroker:params=>{if(++exchanges>exchangeLimit)throw Object.assign(new Error('limited'),{code:'rate_limit_exceeded'});return {credential:broker.exchange(params),senderId:broker.senderId,threadId:broker.threadId};},statusProvider:()=>({route:'same-device',running:true})});
  await subsystem.start();
  const run=async args=>JSON.parse((await exec(process.execPath,[cli,...args,'--config',configPath])).stdout);
  assert.equal((await run(['status'])).running,true);
  const mcp=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[cli,'mcp','--config',configPath],{stdio:['pipe','pipe','pipe']});
   let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});child.on('error',reject);
   child.on('close',code=>code===0?resolve(stdout.trim().split('\n').map(line=>JSON.parse(line))):reject(new Error(stderr)));
   child.stdin.end([
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'triangle_list_recipients'}},
   ].map(v=>JSON.stringify(v)).join('\n')+'\n');
  });
  assert.deepEqual(mcp.map(v=>v.id),[1,2]);assert.equal(mcp[1].result.isError,false);
  assert.ok(!JSON.stringify(mcp).includes(integration.secret));
  const sent=await run(['send','--to','gravity2','--text','review this change','--message-id','coding-one','--request-id','request-one']);
  assert.equal(sent.senderId,result.senderId);assert.equal(sent.admission.accepted,true);
  const replies=await run(['replies','--request-id','request-one']);
  assert.equal(replies.replies[0].text,'free form answer');
  assert.equal(replies.replies[0].sender,recipient);
  await run(['consume','--message-id','reply-coding-one']);
  assert.deepEqual((await run(['replies','--request-id','request-one'])).replies,[]);
  assert.ok(!JSON.stringify(sent).includes(integration.secret));
  const previousExchanges=exchanges;exchangeLimit=exchanges+1;
  const waited=await run(['send','--to','gravity2','--text','wait','--message-id','wait-one','--request-id','request-wait','--wait-ms','1200']);
  assert.equal(waited.replies[0].text,'free form answer');
  assert.equal(exchanges,previousExchanges+1,'wait polls reuse the active credential');exchangeLimit=Infinity;
  const list=journal.listReplies.bind(journal);
  journal.listReplies=async opts=>{if(opts.requestId==='request-wait-error')throw Object.assign(new Error('unavailable'),{code:'journal_unavailable'});return list(opts);};
  const waiting=await run(['send','--to','gravity2','--text','wait error','--message-id','wait-error','--request-id','request-wait-error','--wait-ms','300']);
  assert.equal(waiting.admission.messageId,'wait-error');assert.equal(waiting.waiting,true);assert.equal(waiting.waitError,'journal_unavailable');
  journal.listReplies=list;
  await assert.rejects(exec(process.execPath,[cli,'send','--config',configPath,'--to','unconfigured','--text','x']));
 }finally{await subsystem?.stop();fs.rmSync(root,{recursive:true,force:true});}
});
test('setup keeps the desktop thread only in the integration file and never writes the app-server binding',()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-bind-');
 try{
  const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'app-server-thread',enabled:false,extra:'kept'});
  const before=fs.readFileSync(bindingPath),beforeMtime=fs.statSync(bindingPath).mtimeMs;
  const options={config:configPath,'desktop-binding':bindingPath,recipients:['gravity2']};
  // A first setup may name any explicit thread: nothing production-owned is rewritten.
  const first=setupLocalMessaging({...options,'thread-id':'conversation-one'});
  const integrationPath=readPrivateJson(configPath).integrationPath;
  assert.equal(first.threadId,'conversation-one');
  assert.equal(readPrivateJson(integrationPath).threadId,'conversation-one');
  assert.equal(readPrivateJson(integrationPath).senderId,'a'.repeat(64));
  assert.deepEqual(fs.readFileSync(bindingPath),before);assert.equal(fs.statSync(bindingPath).mtimeMs,beforeMtime);
  assert.deepEqual(fs.readdirSync(root).filter(name=>name.includes('before-local-messaging')),[],'no backup of a file that is never changed');
  // The same thread keeps the secret; another thread needs the explicit flag.
  const secret=readPrivateJson(integrationPath).secret;
  setupLocalMessaging({...options,'thread-id':'conversation-one'});assert.equal(readPrivateJson(integrationPath).secret,secret);
  assert.throws(()=>setupLocalMessaging({...options,'thread-id':'conversation-two'}),{code:'binding_changed'});
  assert.equal(readPrivateJson(integrationPath).threadId,'conversation-one','a refused rebind changes nothing');
  setupLocalMessaging({...options,'thread-id':'conversation-two',rebind:true});
  assert.equal(readPrivateJson(integrationPath).threadId,'conversation-two');assert.notEqual(readPrivateJson(integrationPath).secret,secret,'a rebind rotates the capability');
  assert.deepEqual(fs.readFileSync(bindingPath),before);assert.equal(fs.statSync(bindingPath).mtimeMs,beforeMtime);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('setup migrates cleanly to dedicated desktop-binding.json when app-server-binding is removed',()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-ded-');
 try{
  const configPath=path.join(root,'local.json');
  const stateRoot=path.join(root,'local');
  const desktopBindingPath=path.join(root,'desktop-binding.json');
  // Scenario 1: dedicated desktop-binding.json exists with senderId or instanceId
  writePrivateJson(desktopBindingPath,{version:1,senderId:'d'.repeat(64)});
  const result1=setupLocalMessaging({config:configPath,'thread-id':'thread-one',recipients:['gravity2']});
  assert.equal(result1.senderId,'d'.repeat(64));
  assert.equal(readPrivateJson(configPath).bindingPath,desktopBindingPath);
  // Scenario 2: app-server-binding was removed, desktop-binding is missing, but integration exists
  fs.unlinkSync(desktopBindingPath);
  assert.equal(fs.existsSync(desktopBindingPath),false);
  const result2=setupLocalMessaging({config:configPath,'thread-id':'thread-one',recipients:['gravity2']});
  assert.equal(result2.senderId,'d'.repeat(64));
  assert.equal(fs.existsSync(desktopBindingPath),true);
  assert.equal(readPrivateJson(desktopBindingPath).instanceId,'d'.repeat(64));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
