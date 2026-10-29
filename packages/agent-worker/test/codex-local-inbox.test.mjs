import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Readable,PassThrough} from 'node:stream';
import {setupLocalMessaging,setupSessionDiscovery,setupWorkspaceMessaging,setupDesktopInbox,disableDesktopInbox,runSessionDiscoveryHook,runLocalMessagingCLI} from '../src/local-messaging-cli.mjs';
import {readPrivateJson,writePrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {createInstalledLocalMessagingHost} from '../src/local-messaging-host.mjs';
import {createProfiledReasonerGate} from '../src/concurrency-gate.mjs';
import {createLocalControlClient} from '../src/local-messaging-client.mjs';
import {resolveLocalSocketAddress} from '../src/local-messaging-address.mjs';
import {createAttachedClaudeSessionMcpChild} from '../src/claude-session-mcp-child.mjs';
import {createLocalMessagingMcpHandler} from '../src/local-messaging-mcp-adapter.mjs';
import {validateSnapshot,formatNotificationTemplate} from '../src/codex-wake-adapter.mjs';
async function fixture(){
 const root=fs.mkdtempSync('/private/tmp/tri-codex-inbox-'),workspace=path.join(root,'workspace');fs.mkdirSync(workspace,{mode:0o700});
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json'),wrapper=path.join(root,'triangle-local');fs.writeFileSync(wrapper,'#!/bin/sh\nexit 0\n',{mode:0o700});
 writePrivateJson(bindingPath,{instanceId:'a'.repeat(64)});setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'codex-inbox-proof-thread',recipients:['gravity2']});setupSessionDiscovery({config:configPath,workspace,'local-cli':wrapper});setupWorkspaceMessaging({config:configPath,workspace,'local-cli':wrapper});
 let host,owner;const clients=[],children=[],wakes=[];let runnerCalls=0;
 const config=readPrivateJson(configPath),desktop=readPrivateJson(config.integrationPath);
 writePrivateJson(configPath,{...config,wake:{enabled:true,codexPath:'/usr/bin/false',codexHome:root}});
 const client=id=>{const c=createLocalControlClient({socketPath:resolveLocalSocketAddress({stateRoot:config.stateRoot}).socketPath,senderId:id});clients.push(c);return c;};
 const start=async()=>{host=createInstalledLocalMessagingHost({configPath,runners:new Map([[config.recipients[0].instanceId,{run:async()=>{runnerCalls++;return {text:'worker',status:'completed'};}}]]),gate:createProfiledReasonerGate(),timerIntervalMs:10,wakeAdapter:{notify:async(binding,snapshot)=>{wakes.push({binding,snapshot});return {state:'accepted',receipt:{queuedId:randomUUID(),threadId:binding.threadId}};}}});await host.start();owner=client(desktop.senderId);};await start();
 const grant=async()=> (await owner.exchangeTurnBinding({bindingId:desktop.bindingId,threadId:desktop.threadId,secret:desktop.secret})).credential;
 const child=async()=>{const sid=randomUUID();await runSessionDiscoveryHook({configPath,input:Readable.from([JSON.stringify({session_id:sid,cwd:workspace,hook_event_name:'SessionStart'})])});const c=await createAttachedClaudeSessionMcpChild({configPath,cwd:workspace,policyPath:config.sessionMessaging.integrationPath,expectedVersion:'2.1.307',env:{CLAUDE_CODE_SESSION_ID:sid},wakeIntervalMs:0});children.push(c);return c;};
 const cli=async args=>{let out='';const output={write:s=>out+=s};await runLocalMessagingCLI([...args,'--config',configPath],{output});return JSON.parse(out);};
 return {root,workspace,configPath,bindingPath,config,desktop,grant,child,cli,wakes,get owner(){return owner;},get runnerCalls(){return runnerCalls;},async restart(){await owner.close();await host.stop();await start();},async close(){for(const c of children)await c.close();for(const c of clients)await c.close();await host?.stop();fs.rmSync(root,{recursive:true,force:true});}};
}
async function tool(child,name,args={}){const r=await child.handleRequest({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}});if(r.result.isError)throw new Error(r.result.content[0].text);return JSON.parse(r.result.content[0].text);}
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('condition not reached');}

test('Claude -> bound Codex -> original Claude uses durable inbox, scoped tools, one existing-owner wake and restart',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.owner.listInbox({},{credential:await f.grant()}),{code:'inbox_disabled'});
  const a=await f.child(),b=await f.child(),aId=(await tool(a,'triangle_get_status')).senderId;
  setupDesktopInbox({config:f.configPath,senders:[aId]});await f.restart();
  await assert.rejects(tool(b,'triangle_send_message',{to:f.desktop.senderId,text:'not allowed',messageId:'foreign',requestId:'foreign'}),/recipient_not_allowed/);
  const sessions=await tool(a,'triangle_list_sessions');assert.ok(sessions.sessions.some(r=>r.id===f.desktop.senderId));
  const envelope={to:f.desktop.senderId,text:'hello Codex',messageId:'incoming-a',requestId:'request-a'};
  await tool(a,'triangle_send_message',envelope);await until(()=>f.wakes.length===1);
  assert.equal(f.wakes[0].binding.threadId,f.desktop.threadId);assert.equal(f.wakes[0].snapshot.inboxCount,1);assert.equal(f.wakes[0].snapshot.replyCount,0);
  assert.match(formatNotificationTemplate({generation:1},validateSnapshot(f.wakes[0].snapshot)),/Pending incoming requests: 1/);
  assert.equal(f.runnerCalls,0,'no reasoning launcher owns this desktop inbox');
  await f.restart();assert.equal((await f.cli(['inbox'])).items[0].messageId,'incoming-a');
  const duplicate=await tool(a,'triangle_send_message',envelope);assert.equal(duplicate.isDuplicate,true);
  const handler=createLocalMessagingMcpHandler({client:f.owner,turnCredentialProvider:f.grant});
  const mcp=async(name,args={})=>{const response=await handler.handleRequest({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}});assert.equal(response.result.isError,false,response.result.content[0].text);return JSON.parse(response.result.content[0].text);};
  assert.equal((await mcp('triangle_list_inbox')).items[0].messageId,'incoming-a');
  await assert.rejects(tool(b,'triangle_claim_message',{messageId:'incoming-a',claimId:'foreign-claim'}),/foreign_access_denied/);
  const firstClaim=await mcp('triangle_claim_message',{messageId:'incoming-a',claimId:'claim-a'});
  const claim=await f.cli(['claim','--message-id','incoming-a','--claim-id','claim-a']);assert.equal(claim.claimToken,firstClaim.claimToken);assert.equal(claim.isRetry,true);
  assert.equal((await f.cli(['inbox'])).items.length,0,'claim removes queued visibility, not durable custody');
  const file=path.join(f.root,'claim.json');writePrivateJson(file,claim);
  await mcp('triangle_reply_message',{messageId:'incoming-a',claimToken:claim.claimToken,replyId:'reply-a',text:'hello Claude'});
  await f.cli(['reply','--message-id','incoming-a','--claim-file',file,'--reply-id','reply-a','--text','hello Claude']);
  assert.equal((await tool(a,'triangle_get_replies',{requestId:'request-a'})).replies[0].text,'hello Claude');
  assert.equal((await tool(b,'triangle_get_replies',{requestId:'request-a'})).replies.length,0);
  assert.equal((await f.cli(['status','--message-id','incoming-a'])).phase,'completed');
  await f.owner.ackWake({wakeId:f.wakes[0].snapshot.wakeId,generation:1},{credential:await f.grant()});
 }finally{await f.close();}
});

test('inbox disable/re-enable and desktop rebind fence old grants, without stealing active claims',async()=>{
 const f=await fixture();try{
  const a=await f.child(),id=(await tool(a,'triangle_get_status')).senderId;setupDesktopInbox({config:f.configPath,senders:[id]});await f.restart();
  const stale=await f.grant();
  await tool(a,'triangle_send_message',{to:f.desktop.senderId,text:'task',messageId:'fenced',requestId:'fenced'});
  const claim=await f.owner.claimInboxMessage({messageId:'fenced',claimId:'owned'},{credential:stale});
  disableDesktopInbox({config:f.configPath});await assert.rejects(f.owner.listInbox({},{credential:stale}),{code:'inbox_disabled'});
  await assert.rejects(tool(a,'triangle_send_message',{to:f.desktop.senderId,text:'disabled',messageId:'disabled',requestId:'disabled'}),/recipient_not_allowed/);
  setupDesktopInbox({config:f.configPath,senders:[id]});await assert.rejects(f.owner.listInbox({},{credential:stale}),{code:'binding_changed'});
  const fresh=await f.grant();await assert.rejects(f.owner.sendReply({messageId:'fenced',claimToken:claim.claimToken,replyId:'steal',text:'no'},{credential:fresh}));
  setupLocalMessaging({config:f.configPath,'desktop-binding':f.bindingPath,'thread-id':'different-codex-thread',rebind:true,recipients:['gravity2']});
  assert.equal(readPrivateJson(f.configPath).inbox.enabled,false);await assert.rejects(f.owner.listInbox({},{credential:fresh}));
 }finally{await f.close();}
});

test('executable claude-session-mcp selects workspace attachment rather than the legacy pairing',async()=>{
 const f=await fixture();try{
  const sid=randomUUID();await runSessionDiscoveryHook({configPath:f.configPath,input:Readable.from([JSON.stringify({session_id:sid,cwd:f.workspace,hook_event_name:'SessionStart'})])});
  const cli=fileURLToPath(new URL('../src/local-messaging-cli.mjs',import.meta.url));
  const env={...process.env,CLAUDE_CODE_SESSION_ID:sid};delete env.CLAUDE_CODE_MESSAGING_SOCKET;delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[cli,'claude-session-mcp','--config',f.configPath,'--workspace-messaging',f.config.sessionMessaging.integrationPath,'--expected-version','2.1.307'],{cwd:f.workspace,env,stdio:['pipe','pipe','pipe']});let out='',err='';
   const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('CLI MCP entrypoint did not settle'));},10000);
   child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error('CLI failed: '+err));else resolve(out);});
   child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'triangle_get_status',arguments:{}}})+'\n');
  });
  const frames=result.trim().split('\n').map(JSON.parse),response=frames.find(r=>r.id===2);assert.equal(response.result.isError,false,response.result.content[0].text);assert.match(JSON.parse(response.result.content[0].text).senderId,/^session-[a-f0-9]{64}$/);
 }finally{await f.close();}
});

test('bound Codex triangle_get_status: no argument is the conversation\'s own inbox view, the owner CLI keeps the host view, a disabled inbox says so',async()=>{
 const f=await fixture();try{
  const a=await f.child(),aId=(await tool(a,'triangle_get_status')).senderId;
  const makeHandler=()=>createLocalMessagingMcpHandler({client:f.owner,turnCredentialProvider:f.grant});
  let handler=makeHandler();// rebuilt after a restart, which replaces the owner client
  const call=(name,args={})=>handler.handleRequest({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}});
  const mcp=async(name,args={})=>{const response=await call(name,args);assert.equal(response.result.isError,false,response.result.content[0].text);return JSON.parse(response.result.content[0].text);};
  const disabled=await call('triangle_get_status');
  assert.equal(disabled.result.isError,true);assert.match(disabled.result.content[0].text,/inbox_disabled/,'same fail-closed code as the inbox tools');
  assert.ok((await f.cli(['status'])).journal,'owner CLI status is unchanged while the inbox is disabled');

  setupDesktopInbox({config:f.configPath,senders:[aId]});await f.restart();handler=makeHandler();
  const empty=await mcp('triangle_get_status');
  assert.equal(empty.route,'same-device');assert.equal(empty.senderId,f.desktop.senderId);assert.equal(empty.generation,1);assert.equal(typeof empty.sessionId,'string');
  assert.deepEqual(empty.inbox,{queued:0,executing:0,held:0});
  await tool(a,'triangle_send_message',{to:f.desktop.senderId,text:'hello Codex',messageId:'status-in',requestId:'status-req'});
  assert.deepEqual((await mcp('triangle_get_status')).inbox,{queued:1,executing:0,held:0});
  const claim=await mcp('triangle_claim_message',{messageId:'status-in',claimId:'status-claim'});
  assert.deepEqual((await mcp('triangle_get_status')).inbox,{queued:0,executing:1,held:0});
  await mcp('triangle_reply_message',{messageId:'status-in',claimToken:claim.claimToken,replyId:'status-reply',text:'done'});
  const own=await mcp('triangle_get_status');assert.deepEqual(own.inbox,{queued:0,executing:0,held:0});
  for(const key of ['journal','dispatcher','wake','router','discovery','replyIdentity'])assert.equal(key in own,false,'the MCP tool never exposes host status: '+key);

  const host=await f.cli(['status']);assert.ok(host.journal&&host.dispatcher&&host.router,'owner CLI keeps the host view');
  assert.equal((await mcp('triangle_get_status',{messageId:'status-in'})).phase,'completed');
 }finally{await f.close();}
});
