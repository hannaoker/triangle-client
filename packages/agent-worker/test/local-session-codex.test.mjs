import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {setupLocalMessaging,setupSessionDiscovery,setupWorkspaceMessaging,disableWorkspaceMessaging,disableSessionDiscovery,runSessionDiscoveryHook,
  CODEX_TOML_BEGIN,CODEX_TOML_END,codexMcpBlock,withCodexMcpBlock,withoutCodexMcpBlock} from '../src/local-messaging-cli.mjs';
import {readPrivateJson,writePrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {createInstalledLocalMessagingHost} from '../src/local-messaging-host.mjs';
import {createProfiledReasonerGate} from '../src/concurrency-gate.mjs';
import {createLocalControlClient} from '../src/local-messaging-client.mjs';
import {resolveLocalSocketAddress} from '../src/local-messaging-address.mjs';
import {createCodexSessionMcpChild,createAttachedClaudeSessionMcpChild,codexCallIdentity,codexWakeBinding,CODEX_MCP_TOOLS} from '../src/claude-session-mcp-child.mjs';
import {readSessionMessagingPolicy,sessionAddress} from '../src/local-messaging-interactive-session.mjs';

const cli=fileURLToPath(new URL('../src/local-messaging-cli.mjs',import.meta.url));
const uuid=()=>randomUUID();

// Owner-side files for a disposable workspace with Codex (and optionally Claude) opted in. `senders` are the exact
// senders allowed to message Codex chats (default: the bound desktop identity); `wake` pins the codex executable.
function ownerFiles({senders=null,wake=true,claude=false,codexMessaging=true}={}){
 const root=fs.mkdtempSync('/private/tmp/tri-codex-'),workspace=path.join(root,'workspace');fs.mkdirSync(workspace,{mode:0o700});
 const wrapper=path.join(root,'triangle-local');fs.writeFileSync(wrapper,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');writePrivateJson(bindingPath,{instanceId:'a'.repeat(64)});
 setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'11111111-2222-4333-8444-555555555555',recipients:['gravity2']});
 if(claude)setupSessionDiscovery({config:configPath,workspace,'local-cli':wrapper});
 setupSessionDiscovery({config:configPath,workspace,'local-cli':wrapper,harness:'codex'});
 const config=readPrivateJson(configPath),desktop=readPrivateJson(config.integrationPath);
 if(wake)writePrivateJson(configPath,{...config,wake:{enabled:true,codexPath:path.join(root,'fake-codex'),codexHome:path.join(root,'codex-home')}});
 if(claude)setupWorkspaceMessaging({config:configPath,workspace,'local-cli':wrapper});
 const codexOptions={config:configPath,workspace,'local-cli':wrapper,harness:'codex',senders:senders??[desktop.senderId]};
 if(codexMessaging)setupWorkspaceMessaging(codexOptions);
 return {root,workspace,wrapper,configPath,desktopSender:desktop.senderId,codexOptions};
}
async function fixture(options={}){
 const files=ownerFiles(options),{root,workspace,configPath}=files;
 const config=readPrivateJson(configPath),desktop=readPrivateJson(config.integrationPath),clients=[],children=[],runs=[];
 const makeHost=()=>createInstalledLocalMessagingHost({configPath,runners:new Map(config.recipients.map(r=>[r.instanceId,{run:async request=>{runs.push(request);return {status:'completed',text:'worker result'};}}])),
  gate:createProfiledReasonerGate(),wakeAdapter:{notify:async()=>({state:'accepted',receipt:{queuedId:uuid(),threadId:uuid()}})},logger:{info(){},error(){},warn(){}}});
 let host=makeHost();await host.start();
 const client=senderId=>{const c=createLocalControlClient({socketPath:resolveLocalSocketAddress({stateRoot:config.stateRoot}).socketPath,senderId});clients.push(c);return c;};
 const owner=client(desktop.senderId);
 const grant=async()=>(await owner.exchangeTurnBinding({bindingId:desktop.bindingId,threadId:desktop.threadId,secret:desktop.secret})).credential;
 const lifecycle=(sessionId,kind,harness='codex')=>runSessionDiscoveryHook({configPath,harness,input:Readable.from([JSON.stringify({session_id:sessionId,cwd:workspace,hook_event_name:kind})]),stderr:{write(){}}});
 const notifications=[];
 const codexChild=(extra={})=>{
  const child=createCodexSessionMcpChild({configPath,policyPath:config.sessionMessaging.integrationPath,cwd:workspace,heartbeatMs:0,
   notify:async(binding,snapshot,options)=>{notifications.push({binding,snapshot,options});return {state:'accepted',receipt:{queuedId:uuid(),threadId:binding.threadId}};},...extra});
  children.push(child);return child;
 };
 const policy=readSessionMessagingPolicy(config.sessionMessaging.integrationPath);
 const address=thread=>sessionAddress(policy.installationId,policy.workspace,'codex:'+thread);
 const listed=async()=>(await owner.listSessions({credential:await grant()})).filter(row=>row.harness==='codex');
 return {...files,config,desktop,runs,notifications,client,owner,grant,lifecycle,codexChild,policy,address,listed,
  async restart(){await host.stop();host=makeHost();await host.start();},
  async close(){for(const c of children)await c.close();for(const c of clients)await c.close();await host.stop();fs.rmSync(root,{recursive:true,force:true});}};
}
// A tool call as Codex 0.164 makes it: the chat's identity is in the call's own _meta.
async function call(child,thread,name,args={},meta={}){
 const response=await child.handleRequest({jsonrpc:'2.0',id:uuid(),method:'tools/call',params:{name,arguments:args,_meta:{threadId:thread,sessionId:thread,windowId:thread+':0','x-codex-turn-metadata':{thread_id:thread,session_id:thread,turn_id:uuid()},...meta}}});
 if(response.result.isError)throw new Error(response.result.content[0].text);
 return JSON.parse(response.result.content[0].text);
}

test('a Codex chat attaches on its first tool call, receives from an allowed sender, replies and is woken through codex queue',async()=>{
 const f=await fixture();try{
  const thread=uuid();await f.lifecycle(thread,'SessionStart');
  // Visible from its own hook, but nothing to deliver to yet: Codex tells its MCP server who is calling only in a call.
  let [row]=await f.listed();
  assert.equal(row.id,f.address(thread));assert.equal(row.attachment,'not-attached');assert.match(row.attachmentHint,/first Triangle tool call/);
  assert.equal(row.capabilities.reachable,false);assert.notEqual(row.presence,'offline');
  await assert.rejects(f.owner.sendMessage({to:row.id,text:'too early',messageId:'early',requestId:'early'},{credential:await f.grant()}),{code:'session_offline'});

  const child=f.codexChild();
  assert.equal(child.mode,'codex-queue');
  const status=await call(child,thread,'triangle_get_status');
  assert.equal(status.senderId,f.address(thread),'the chat learns its own Triangle address');
  [row]=await f.listed();
  assert.equal(row.attachment,'attached');assert.equal(row.capabilities.reachable,true);assert.equal(row.capabilities.wakeCapable,true);
  assert.equal(row.presence,'online');assert.equal(row.presenceEvidence.kind,'mcp-lease');

  await f.owner.sendMessage({to:row.id,text:'please look at the build',messageId:'codex-task',requestId:'codex-request'},{credential:await f.grant()});
  assert.equal(f.runs.length,0,'an attached chat is never executed by a runner');
  await child.heartbeat();
  assert.equal(f.notifications.length,1);
  const {binding,snapshot}=f.notifications[0];
  assert.equal(binding.threadId,thread,'the wake targets the chat that is calling, from its own context');
  assert.equal(binding.codexPath,path.join(f.root,'fake-codex'));assert.equal(binding.codexHome,path.join(f.root,'codex-home'));
  assert.equal(binding.generation,1);assert.equal(binding.enabled,true);assert.equal(snapshot.replyCount,0);assert.equal(snapshot.inboxCount,1);assert.match(snapshot.wakeId,/^[0-9a-f-]{36}$/);

  const inbox=await call(child,thread,'triangle_list_inbox');
  assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].messageId,'codex-task');
  const claim=await call(child,thread,'triangle_claim_message',{messageId:'codex-task',claimId:'codex-claim'});
  await call(child,thread,'triangle_reply_message',{messageId:'codex-task',claimToken:claim.claimToken,text:'looked: green',replyId:'codex-reply'});
  assert.deepEqual((await f.owner.listReplies({requestId:'codex-request'},{credential:await f.grant()})).map(r=>r.text),['looked: green']);
  await call(child,thread,'triangle_ack_notification',{wakeId:snapshot.wakeId,generation:1});
  await child.heartbeat();
  assert.equal(f.notifications.length,1,'an acknowledged backlog does not wake the chat again');

  for(const file of fs.readdirSync(f.config.stateRoot).filter(name=>name.includes('.sqlite'))){
   assert.equal(fs.readFileSync(path.join(f.config.stateRoot,file)).includes(Buffer.from(thread)),false,'the raw thread id is never persisted');
  }
  await child.close();
  [row]=await f.listed();
  assert.equal(row.attachment,'not-attached','closing the child detaches the chat');assert.equal(row.capabilities.reachable,false);
 }finally{await f.close();}
});

test('who may message a Codex chat is its own exact list: the Claude list does not reach it, naming a Claude session does',async()=>{
 const claudeSession=uuid();
 const f=await fixture({claude:true});try{
  const thread=uuid();await f.lifecycle(thread,'SessionStart');
  const codex=f.codexChild();await call(codex,thread,'triangle_get_status');
  await f.lifecycle(claudeSession,'SessionStart','claude');
  const claude=await createAttachedClaudeSessionMcpChild({configPath:f.configPath,cwd:f.workspace,policyPath:f.config.sessionMessaging.integrationPath,expectedVersion:'2.1.307',env:{CLAUDE_CODE_SESSION_ID:claudeSession},wakeIntervalMs:0});
  const claudeTool=async(name,args={},fresh=false)=>{
   const r=await claude.handleRequest({jsonrpc:'2.0',id:uuid(),method:'tools/call',params:{name,arguments:args}},{fresh});
   if(r.result.isError)throw new Error(r.result.content[0].text);return JSON.parse(r.result.content[0].text);
  };
  try{
   const claudeAddress=(await claudeTool('triangle_get_status')).senderId;
   // A Claude chat is not a Codex sender until the owner names it.
   await assert.rejects(claudeTool('triangle_send_message',{to:f.address(thread),text:'not listed',messageId:'c1',requestId:'c1'},true),/recipient_not_allowed/);
   assert.equal((await claudeTool('triangle_list_sessions')).sessions.some(row=>row.id===f.address(thread)),false,'and does not see it as a receiver');
   // The owner lists the exact Claude session; the rest of the setup is unchanged and existing chats stay attached.
   setupWorkspaceMessaging({...f.codexOptions,senders:[f.desktopSender,claudeAddress]});
   const sent=await claudeTool('triangle_send_message',{to:f.address(thread),text:'from the Claude chat',messageId:'c2',requestId:'c2'},true);
   assert.equal(sent.accepted,true);
   const inbox=await call(codex,thread,'triangle_list_inbox');
   assert.deepEqual(inbox.items.map(item=>item.messageId),['c2']);
   const claim=await call(codex,thread,'triangle_claim_message',{messageId:'c2',claimId:'c2-claim'});
   await call(codex,thread,'triangle_reply_message',{messageId:'c2',claimToken:claim.claimToken,text:'codex answers',replyId:'c2-reply'});
   assert.deepEqual((await claudeTool('triangle_get_replies',{requestId:'c2'})).replies.map(r=>r.text),['codex answers']);
   // Receiving does not let the Codex chat start conversations with sessions: its recipients are the owner's list.
   await assert.rejects(call(codex,thread,'triangle_send_message',{to:claudeAddress,text:'unsolicited',messageId:'x1',requestId:'x1'}),/recipient_not_allowed|not permitted/);
  }finally{await claude.close();}
 }finally{await f.close();}
});

test('a tool call must name exactly one chat that its own hook registered; chats in one process stay apart',async()=>{
 const f=await fixture();try{
  const child=f.codexChild(),first=uuid(),second=uuid(),unregistered=uuid();
  await f.lifecycle(first,'SessionStart');await f.lifecycle(second,'SessionStart');
  // No identity, or a call naming two conversations (a subagent thread), is refused without attaching anything.
  const bare=await child.handleRequest({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'triangle_get_status',arguments:{}}});
  assert.equal(bare.result.isError,true);assert.match(bare.result.content[0].text,/missing_codex_context/);
  await assert.rejects(call(child,first,'triangle_get_status',{},{sessionId:uuid()}),/ambiguous_codex_context/);
  await assert.rejects(call(child,first,'triangle_get_status',{},{'x-codex-turn-metadata':{thread_id:uuid()}}),/ambiguous_codex_context/);
  assert.equal((await f.listed()).filter(row=>row.attachment==='attached').length,0);
  // A chat whose own lifecycle hook has not registered it cannot attach, whatever it claims.
  await assert.rejects(call(child,unregistered,'triangle_get_status'),/session_offline/);
  // Two chats served by one process get their own addresses, leases and inboxes.
  const a=await call(child,first,'triangle_get_status'),b=await call(child,second,'triangle_get_status');
  assert.notEqual(a.senderId,b.senderId);
  await f.owner.sendMessage({to:a.senderId,text:'for the first',messageId:'for-first',requestId:'for-first'},{credential:await f.grant()});
  assert.equal((await call(child,second,'triangle_list_inbox')).items.length,0);
  assert.equal((await call(child,first,'triangle_list_inbox')).items.length,1);
  await assert.rejects(call(child,second,'triangle_claim_message',{messageId:'for-first',claimId:'steal'}),/foreign_access_denied/);
  // Ending the first chat fences it; the second is untouched.
  await f.lifecycle(first,'SessionEnd');
  await assert.rejects(call(child,first,'triangle_get_status'),/session_offline/);
  assert.equal((await call(child,second,'triangle_get_status')).senderId,b.senderId);
  // A resumed chat gets a new lifecycle generation and attaches again on its next call.
  await f.lifecycle(first,'SessionStart');
  assert.equal((await call(child,first,'triangle_get_status')).senderId,a.senderId);
 }finally{await f.close();}
});

test('wake outcomes are reported and never retried; without the owner pins the chat is pull-only',async()=>{
 const f=await fixture();try{
  const thread=uuid();await f.lifecycle(thread,'SessionStart');
  let attempts=0;
  const child=f.codexChild({notify:async()=>{attempts++;throw new Error('codex queue failed');}});
  await call(child,thread,'triangle_get_status');
  await f.owner.sendMessage({to:f.address(thread),text:'wake me',messageId:'w1',requestId:'w1'},{credential:await f.grant()});
  await child.heartbeat();assert.equal(attempts,1);
  await child.heartbeat();assert.equal(attempts,1,'an uncertain wake waits for the chat itself instead of being retried');
  let deferred=0;
  const other=uuid();await f.lifecycle(other,'SessionStart');
  const second=f.codexChild({notify:async()=>{deferred++;return {state:'deferred',reason:'executable_unavailable'};}});
  await call(second,other,'triangle_get_status');
  await f.owner.sendMessage({to:f.address(other),text:'wake me too',messageId:'w2',requestId:'w2'},{credential:await f.grant()});
  await second.heartbeat();assert.equal(deferred,1,'a deferred submission is reported, not retried in a loop');
 }finally{await f.close();}
 const pull=await fixture({wake:false});try{
  const thread=uuid();await pull.lifecycle(thread,'SessionStart');
  let attempts=0;
  const child=pull.codexChild({notify:async()=>{attempts++;return {state:'accepted'};}});
  assert.equal(child.mode,'pull');
  await call(child,thread,'triangle_get_status');
  const [row]=await pull.listed();assert.equal(row.capabilities.reachable,true);assert.equal(row.capabilities.wakeCapable,false);
  await pull.owner.sendMessage({to:row.id,text:'poll me',messageId:'p1',requestId:'p1'},{credential:await pull.grant()});
  await child.heartbeat();assert.equal(attempts,0);
  assert.equal((await call(child,thread,'triangle_list_inbox')).items.length,1,'the inbox still works without wake');
 }finally{await pull.close();}
});

test('Codex setup writes a marked block into the workspace config only, refuses a foreign entry, and disable removes just the block',()=>{
 const f=ownerFiles({codexMessaging:false});try{
  const file=path.join(f.workspace,'.codex','config.toml');
  const foreign='[mcp_servers.other]\ncommand = "/bin/other"\n\n[projects."x"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(file,foreign,{mode:0o640});fs.chmodSync(file,0o640); // the umask must not decide what mode is expected
  const policyFile=readPrivateJson(f.configPath).sessionMessaging?.integrationPath;
  assert.equal(policyFile,undefined,'no workspace messaging yet');
  const result=setupWorkspaceMessaging(f.codexOptions);
  assert.equal(result.harness,'codex');assert.equal(result.requiresProjectTrust,true);assert.equal(result.wakeConfigured,true);assert.deepEqual(result.allowedSenders,[f.desktopSender]);
  const text=fs.readFileSync(file,'utf8');
  assert.ok(text.startsWith(foreign),'unrelated settings come first and are untouched');
  assert.equal(fs.statSync(file).mode&0o777,0o640,'the file keeps its mode');
  assert.ok(text.includes(CODEX_TOML_BEGIN)&&text.includes(CODEX_TOML_END));
  assert.ok(text.includes(`command = "${f.wrapper}"`));
  assert.ok(text.includes('"codex-session-mcp"')&&text.includes('"--workspace-messaging"'));
  for(const tool of CODEX_MCP_TOOLS.map(t=>t.name)){
   assert.equal(text.includes(`[mcp_servers.triangle-session.tools.${tool}]`),tool!=='triangle_send_message',`${tool} approval entry`);
  }
  // Rerunning is idempotent and keeps the capability secret, so attached chats are not fenced.
  const secret=readPrivateJson(readPrivateJson(f.configPath).sessionMessaging.integrationPath).secret;
  setupWorkspaceMessaging(f.codexOptions);
  assert.equal(fs.readFileSync(file,'utf8'),text);
  assert.equal(readPrivateJson(readPrivateJson(f.configPath).sessionMessaging.integrationPath).secret,secret);
  // Disable removes only the block.
  const outcome=disableWorkspaceMessaging({config:f.configPath,workspace:f.workspace});
  assert.equal(outcome.mcpCleanupRequired,false);
  assert.equal(fs.readFileSync(file,'utf8').trim(),foreign.trim());
  assert.equal(readPrivateJson(readPrivateJson(f.configPath).sessionMessaging?.integrationPath??path.join(readPrivateJson(f.configPath).stateRoot,'session-messaging.json')).enabled,false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a file holding only the managed block is removed on disable; a foreign or damaged entry blocks setup without writing anything',()=>{
 const f=ownerFiles();try{
  const file=path.join(f.workspace,'.codex','config.toml'),config=readPrivateJson(f.configPath);
  assert.ok(fs.readFileSync(file,'utf8').includes(CODEX_TOML_BEGIN));
  disableWorkspaceMessaging({config:f.configPath,workspace:f.workspace});
  assert.equal(fs.existsSync(file),false,'nothing else was in it');
  const policyBefore=fs.readFileSync(path.join(config.stateRoot,'session-messaging.json'));
  fs.writeFileSync(file,'[mcp_servers.triangle-session]\ncommand = "/bin/their-own"\n',{mode:0o600});
  assert.throws(()=>setupWorkspaceMessaging(f.codexOptions),{code:'integration_exists'});
  assert.equal(fs.readFileSync(file,'utf8'),'[mcp_servers.triangle-session]\ncommand = "/bin/their-own"\n');
  assert.deepEqual(fs.readFileSync(path.join(config.stateRoot,'session-messaging.json')),policyBefore,'a refused setup does not touch the policy');
  fs.writeFileSync(file,`${CODEX_TOML_BEGIN}\n[mcp_servers.triangle-session]\n`,{mode:0o600});
  assert.throws(()=>setupWorkspaceMessaging(f.codexOptions),{code:'invalid_settings'});
  fs.unlinkSync(file);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('Codex setup needs Codex discovery and exact senders; Claude setup keeps the Codex list; the policy schema is strict',()=>{
 const claudeOnly=ownerFiles({codexMessaging:false});
 try{
  const config=readPrivateJson(claudeOnly.configPath),discovery=readPrivateJson(config.discovery.integrationPath);
  writePrivateJson(config.discovery.integrationPath,{...discovery,harnesses:['claude']});
  assert.throws(()=>setupWorkspaceMessaging(claudeOnly.codexOptions),{code:'codex_discovery_required'});
  writePrivateJson(config.discovery.integrationPath,discovery);
  for(const senders of [undefined,[],['not-an-id'],['a'.repeat(64),'a'.repeat(64)],['A'.repeat(64)]]){
   assert.throws(()=>setupWorkspaceMessaging({...claudeOnly.codexOptions,senders}),{code:'invalid_arguments'});
  }
  assert.throws(()=>setupWorkspaceMessaging({...claudeOnly.codexOptions,harness:'grok'}),{code:'invalid_arguments'});
 }finally{fs.rmSync(claudeOnly.root,{recursive:true,force:true});}

 const f=ownerFiles({claude:true,senders:['session-'+'c'.repeat(64)]});
 try{
  const config=readPrivateJson(f.configPath),file=config.sessionMessaging.integrationPath;
  const afterCodex=readPrivateJson(file);
  assert.deepEqual(afterCodex.codex,{enabled:true,allowedSenders:['session-'+'c'.repeat(64)]});
  assert.deepEqual(afterCodex.allowedSenders,[f.desktopSender],'the Claude receiver list is its own');
  setupWorkspaceMessaging({config:f.configPath,workspace:f.workspace,'local-cli':f.wrapper});
  assert.deepEqual(readPrivateJson(file).codex,afterCodex.codex,'rerunning Claude setup keeps the Codex section');
  const policy=readPrivateJson(file);
  for(const bad of [{...policy.codex,extra:1},{enabled:true},{enabled:'yes',allowedSenders:[]},{enabled:true,allowedSenders:'x'},{enabled:true,allowedSenders:['z'.repeat(64)]},{enabled:true,allowedSenders:['a'.repeat(64),'a'.repeat(64)]},[]]){
   writePrivateJson(file,{...policy,codex:bad});
   assert.throws(()=>readSessionMessagingPolicy(file),{code:'invalid_session_policy'});
  }
  writePrivateJson(file,policy);
  assert.deepEqual(readSessionMessagingPolicy(file).codex,afterCodex.codex);
  disableSessionDiscovery({config:f.configPath});
  assert.equal(fs.existsSync(path.join(f.workspace,'.codex','config.toml')),false,'disabling discovery also removes the Codex entry');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('managed block helpers add and remove exactly the block, whatever surrounds it',()=>{
 const block=codexMcpBlock({wrapper:'/Users/o/Library/Application Support/The Triangle/bin/triangle-local',configPath:'/c/local-messaging.json',policyPath:'/c/session-messaging.json'});
 assert.ok(block.startsWith(CODEX_TOML_BEGIN)&&block.endsWith(CODEX_TOML_END));
 assert.ok(block.includes('command = "/Users/o/Library/Application Support/The Triangle/bin/triangle-local"'),'spaces in paths are fine');
 assert.throws(()=>codexMcpBlock({wrapper:'/a"b\nc',configPath:'/c',policyPath:'/p'}),{code:'unsafe_path'});
 assert.ok(codexMcpBlock({wrapper:'/w"x',configPath:'/c',policyPath:'/p'}).includes('command = "/w\\"x"'),'quotes are escaped');
 for(const original of ['','a = 1\n','a = 1\n\n[x]\ny = 2\n','# only a comment\n']){
  const added=withCodexMcpBlock(original,block);
  assert.ok(added.includes(block));
  assert.equal(withCodexMcpBlock(added,block),added,'adding twice changes nothing');
  assert.equal(withoutCodexMcpBlock(added).trim(),original.trim());
 }
 const moved=`a = 1\n${block}\nb = 2\n`;
 assert.equal(withoutCodexMcpBlock(moved).trim(),'a = 1\nb = 2');
 assert.equal(withoutCodexMcpBlock('nothing here\n'),'nothing here\n');
});

test('call identity and wake pins are read strictly',()=>{
 const t=uuid();
 assert.equal(codexCallIdentity({threadId:t.toUpperCase(),sessionId:t}),t,'case is normalized');
 assert.equal(codexCallIdentity({threadId:t,'x-codex-turn-metadata':{thread_id:t,session_id:t}}),t);
 for(const meta of [undefined,null,{},{threadId:'x'},{threadId:42},{sessionId:t}])assert.throws(()=>codexCallIdentity(meta),{code:'missing_codex_context'});
 for(const meta of [{threadId:t,sessionId:uuid()},{threadId:t,'x-codex-turn-metadata':{thread_id:uuid()}},{threadId:t,'x-codex-turn-metadata':{session_id:uuid()}}])assert.throws(()=>codexCallIdentity(meta),{code:'ambiguous_codex_context'});
 const pins={enabled:true,codexPath:'/opt/codex',codexHome:'/home/.codex',timeoutMs:9000};
 assert.deepEqual(codexWakeBinding(pins),{codexPath:'/opt/codex',codexHome:'/home/.codex',timeoutMs:9000});
 assert.equal(codexWakeBinding({...pins,timeoutMs:60000}).timeoutMs,undefined,'an out-of-range timeout falls back to the adapter default');
 for(const bad of [null,undefined,{},{...pins,enabled:false},{...pins,codexPath:'codex'},{...pins,codexHome:'~/.codex'},{...pins,codexPath:'/a\0b'},{enabled:true}])assert.equal(codexWakeBinding(bad),null);
});

test('the installed codex-session-mcp entry speaks MCP over stdio, attaches on the first call and detaches when its input closes',async()=>{
 const f=await fixture();try{
  const thread=uuid();await f.lifecycle(thread,'SessionStart');
  const child=spawn(process.execPath,[cli,'codex-session-mcp','--config',f.configPath,'--workspace-messaging',f.config.sessionMessaging.integrationPath],{cwd:f.workspace,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';const waiting=new Map();
  child.stdout.on('data',chunk=>{stdout+=chunk;let index;while((index=stdout.indexOf('\n'))>=0){const line=stdout.slice(0,index);stdout=stdout.slice(index+1);const message=JSON.parse(line);waiting.get(message.id)?.(message);}});
  child.stderr.on('data',chunk=>stderr+=chunk);
  const rpc=(id,method,params)=>new Promise(resolve=>{waiting.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const exited=new Promise(resolve=>child.once('exit',code=>resolve(code)));
  try{
   const init=await rpc(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-mcp-client',version:'0.164.0'}});
   assert.equal(init.result.serverInfo.name,'triangle-codex-session-mcp');assert.equal(init.result.protocolVersion,'2025-06-18');
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
   const tools=await rpc(2,'tools/list',{_meta:{progressToken:0}});
   assert.deepEqual(tools.result.tools.map(tool=>tool.name),CODEX_MCP_TOOLS.map(tool=>tool.name));
   assert.deepEqual((await f.listed()).map(row=>row.attachment),['not-attached'],'initialize and tools/list attach nothing');
   const status=await rpc(3,'tools/call',{name:'triangle_get_status',arguments:{},_meta:{threadId:thread,sessionId:thread,'x-codex-turn-metadata':{thread_id:thread,session_id:thread}}});
   assert.equal(status.result.isError,false);assert.equal(JSON.parse(status.result.content[0].text).senderId,f.address(thread));
   assert.deepEqual((await f.listed()).map(row=>row.attachment),['attached']);
  }finally{child.stdin.end();}
  assert.equal(await exited,0);assert.equal(stderr,'');
  assert.deepEqual((await f.listed()).map(row=>row.attachment),['not-attached'],'closing the input detaches the chat');
 }finally{await f.close();}
});

// The CLI is also a program. These run setup and disable as the program, the way the installed wrapper does:
// the module-level constants must be initialized before the entry point runs (importing the module hid this).
function runProgram(args,options={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,...args],{stdio:['ignore','pipe','pipe'],...options});
  let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
  child.once('error',reject);child.once('exit',code=>resolve({code,stdout,stderr:stderr.replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n(\(Use `node --trace-warnings[^\n]*\n)?/g,'')}));
 });
}
test('setup and disable work when the CLI file is run as the program, as the installed wrapper runs it',async()=>{
 const f=ownerFiles({codexMessaging:false});try{
  const file=path.join(f.workspace,'.codex','config.toml');
  const setup=await runProgram(['setup-session-messaging','--config',f.configPath,'--harness','codex','--workspace',f.workspace,'--local-cli',f.wrapper,'--sender',f.desktopSender]);
  assert.equal(setup.stderr,'');assert.equal(setup.code,0);
  const result=JSON.parse(setup.stdout);assert.equal(result.harness,'codex');assert.deepEqual(result.allowedSenders,[f.desktopSender]);
  assert.ok(fs.readFileSync(file,'utf8').includes(CODEX_TOML_BEGIN));
  const rerun=await runProgram(['setup-session-messaging','--config',f.configPath,'--harness','codex','--workspace',f.workspace,'--local-cli',f.wrapper,'--sender',f.desktopSender]);
  assert.equal(rerun.code,0,'rerunning is fine');
  const disable=await runProgram(['disable-session-messaging','--config',f.configPath,'--workspace',f.workspace]);
  assert.equal(disable.stderr,'');assert.equal(disable.code,0);assert.equal(JSON.parse(disable.stdout).mcpCleanupRequired,false);
  assert.equal(fs.existsSync(file),false,'the block was removed (and the file, which held nothing else)');
  // The refusals are reported by code, not swallowed.
  const refused=await runProgram(['setup-session-messaging','--config',f.configPath,'--harness','codex','--workspace',f.workspace,'--local-cli',f.wrapper]);
  assert.equal(refused.code,1);assert.equal(JSON.parse(refused.stderr).error,'invalid_arguments');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

 test('the bound Codex thread cannot attach a second inbox through either child or broker, including after rebind and restart',async()=>{
 const f=await fixture();try{
  const bound=f.desktop.threadId,other=uuid();
  await f.lifecycle(bound,'SessionStart');await f.lifecycle(other,'SessionStart');
  const child=f.codexChild();
  await assert.rejects(call(child,bound,'triangle_get_status'),/bound_codex_context/);
  const direct=f.client(f.address(bound));
  const attach=()=>direct.attachSession({installationId:f.policy.installationId,secret:f.policy.secret,sessionId:bound,childId:uuid(),harness:'codex',wakeCapable:true});
  await assert.rejects(attach(),{code:'bound_codex_context'});
  const before=(await f.listed()).find(r=>r.id===f.address(bound));
  assert.equal(before.capabilities.reachable,false);assert.equal(before.capabilities.wakeCapable,false);
  assert.equal((await call(child,other,'triangle_get_status')).senderId,f.address(other));
  // The live integration is authoritative even for a child/broker started before a rebind.
  const credential=await f.grant();
  writePrivateJson(f.config.integrationPath,{...f.desktop,threadId:other});
  await assert.rejects(call(child,other,'triangle_get_status'),/bound_codex_context/);
  const receiver=f.client(f.address(other));
  await assert.rejects(receiver.attachSession({installationId:f.policy.installationId,secret:f.policy.secret,sessionId:other,childId:uuid(),harness:'codex'}),{code:'bound_codex_context'});
  const after=(await f.owner.listSessions({credential})).find(r=>r.id===f.address(other));assert.equal(after.capabilities.reachable,false);assert.equal(after.capabilities.wakeCapable,false);
  const restarted=f.codexChild();await assert.rejects(call(restarted,other,'triangle_get_status'),/bound_codex_context/);
  writePrivateJson(f.config.integrationPath,f.desktop);
  await f.restart();
  await assert.rejects(call(f.codexChild(),bound,'triangle_get_status'),/bound_codex_context/);
  await assert.rejects(attach(),{code:'bound_codex_context'});
  assert.equal(f.notifications.length,0);
 }finally{await f.close();}
 });
