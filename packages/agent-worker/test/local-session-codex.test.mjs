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


test('automatic lifecycle attachment uses runtime identity without a model tool call and is a no-op for the bound thread',async()=>{
 const f=await fixture();try{
  const thread=uuid();await f.lifecycle(thread,'SessionStart');await f.lifecycle(f.desktop.threadId,'SessionStart');
  const child=f.codexChild();
  // Real Codex MCP hook metadata carries threadId without sessionId (probe 0.164.0).
  const hook=async(id,args={})=>child.handleRequest({jsonrpc:'2.0',id:uuid(),method:'tools/call',params:{name:'triangle_attach_session',arguments:args,_meta:{threadId:id}}});
  assert.equal((await f.listed()).find(r=>r.id===f.address(thread)).capabilities.reachable,false);
  let result=await hook(thread);assert.equal(result.result.isError,false);assert.equal(result.result.content[0].text,'{}');
  assert.equal((await f.listed()).find(r=>r.id===f.address(thread)).capabilities.reachable,true);
  assert.equal((await hook(thread)).result.isError,false,'repeated hooks renew the existing attachment');
  assert.equal((await hook(thread,{threadId:uuid()})).result.isError,true,'caller-supplied identity is never accepted');
  assert.equal((await hook(f.desktop.threadId)).result.isError,false,'fixed owner needs no second attachment');
  const bound=(await f.listed()).find(r=>r.id===f.address(f.desktop.threadId));assert.equal(bound.capabilities.reachable,false);assert.equal(bound.capabilities.wakeCapable,false);
  await assert.rejects(call(child,f.desktop.threadId,'triangle_get_status'),/bound_codex_context/);
  const bare=await child.handleRequest({jsonrpc:'2.0',id:uuid(),method:'tools/call',params:{name:'triangle_attach_session',arguments:{}}});
  assert.equal(bare.result.isError,true);assert.match(bare.result.content[0].text,/missing_codex_context/);
  await assert.rejects(call(child,thread,'triangle_attach_session',{},{sessionId:uuid()}),/ambiguous_codex_context/);
  assert.equal(f.notifications.length,0,'attachment itself never queues a wake or reads an inbox');
  assert.equal(f.runs.length,0);
  writePrivateJson(f.config.sessionMessaging.integrationPath,{...f.policy,codex:{...f.policy.codex,enabled:false}});
  assert.equal((await hook(thread)).result.isError,true,'revocation is enforced on every hook');
 }finally{await f.close();}
});

test('automatic attachment setup is explicit, preserves unrelated hooks and mode, and cleans up on opt-out or disable',()=>{
 const f=ownerFiles({codexMessaging:false});try{
  const hooksFile=path.join(f.workspace,'.codex','hooks.json');
  const settings=JSON.parse(fs.readFileSync(hooksFile));
  settings.hooks.UserPromptSubmit.push({matcher:'anything',hooks:[{type:'command',command:'/bin/true',timeout:7}]});
  fs.writeFileSync(hooksFile,JSON.stringify(settings));fs.chmodSync(hooksFile,0o640);
  const original=fs.readFileSync(hooksFile,'utf8');
  assert.equal(setupWorkspaceMessaging(f.codexOptions).autoAttach,false);
  assert.equal(fs.readFileSync(hooksFile,'utf8'),original,'default setup cannot opt chats in or rewrite their hook file');
  const enabled=setupWorkspaceMessaging({...f.codexOptions,autoAttach:true});assert.equal(enabled.autoAttach,true);assert.equal(enabled.requiresHarnessHookApproval,true);
  const installed=fs.readFileSync(hooksFile,'utf8'),next=JSON.parse(installed);
  for(const event of ['SessionStart','UserPromptSubmit']){
   assert.deepEqual(next.hooks[event].slice(0,-1),settings.hooks[event]);
   const hook=next.hooks[event].at(-1).hooks[0];assert.equal(hook.type,'mcp_tool');assert.equal(hook.server,'triangle-session');assert.equal(hook.tool,'triangle_attach_session');assert.deepEqual(hook.input,{});
  }
  assert.equal(fs.statSync(hooksFile).mode&0o777,0o640);
  assert.equal(setupWorkspaceMessaging({...f.codexOptions,autoAttach:true}).requiresHarnessHookApproval,false);
  assert.equal(fs.readFileSync(hooksFile,'utf8'),installed,'rerun is idempotent');
  assert.equal(setupWorkspaceMessaging(f.codexOptions).autoAttach,true,'omitting the option preserves prior opt-in');
  setupWorkspaceMessaging({...f.codexOptions,autoAttach:false});assert.deepEqual(JSON.parse(fs.readFileSync(hooksFile)),settings);
  setupWorkspaceMessaging({...f.codexOptions,autoAttach:true});
  assert.equal(disableWorkspaceMessaging({config:f.configPath,workspace:f.workspace}).mcpCleanupRequired,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksFile)),settings);
  assert.equal(fs.statSync(hooksFile).mode&0o777,0o640);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('automatic attachment preflight rejects unsafe or foreign hooks without changing policy or MCP settings',()=>{
 const f=ownerFiles();try{
  const config=readPrivateJson(f.configPath),hooksFile=path.join(f.workspace,'.codex','hooks.json'),mcpFile=path.join(f.workspace,'.codex','config.toml');
  const before=[fs.readFileSync(f.configPath,'utf8'),fs.readFileSync(config.sessionMessaging.integrationPath,'utf8'),fs.readFileSync(mcpFile,'utf8')];
  const other=path.join(f.root,'foreign-hooks.json');fs.writeFileSync(other,'{}');fs.unlinkSync(hooksFile);fs.symlinkSync(other,hooksFile);
  assert.throws(()=>setupWorkspaceMessaging({...f.codexOptions,autoAttach:true}),{code:'unsafe_path'});
  fs.unlinkSync(hooksFile);fs.writeFileSync(hooksFile,JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'mcp_tool',server:'triangle-session',tool:'triangle_attach_session',input:{arbitrary:'keep'}}]}]}}));
  assert.throws(()=>setupWorkspaceMessaging({...f.codexOptions,autoAttach:true}),{code:'integration_exists'});
  assert.deepEqual([fs.readFileSync(f.configPath,'utf8'),fs.readFileSync(config.sessionMessaging.integrationPath,'utf8'),fs.readFileSync(mcpFile,'utf8')],before);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});


test('the installed CLI program accepts explicit automatic-attachment opt-in and opt-out',async()=>{
 const f=ownerFiles({codexMessaging:false});try{
  const args=['setup-session-messaging','--config',f.configPath,'--harness','codex','--workspace',f.workspace,'--local-cli',f.wrapper,'--sender',f.desktopSender];
  const enable=await runProgram([...args,'--auto-attach']);assert.equal(enable.code,0,enable.stderr);assert.equal(JSON.parse(enable.stdout).autoAttach,true);
  const disable=await runProgram([...args,'--no-auto-attach']);assert.equal(disable.code,0,disable.stderr);assert.equal(JSON.parse(disable.stdout).autoAttach,false);
  const duplicate=await runProgram([...args,'--auto-attach','--no-auto-attach']);assert.notEqual(duplicate.code,0);assert.match(duplicate.stderr,/invalid_arguments/);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});


test('automatic attachment waits for a concurrent discovery hook, but never invents a lifecycle',async()=>{
 const f=await fixture();try{
  const thread=uuid(),child=f.codexChild();
  // The real Desktop trace showed the MCP hook arriving before the discovery command finished.
  const attaching=call(child,thread,'triangle_attach_session');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal((await f.listed()).some(r=>r.id===f.address(thread)),false);
  await f.lifecycle(thread,'SessionStart');
  assert.deepEqual(await attaching,{});
  assert.equal((await f.listed()).find(r=>r.id===f.address(thread)).capabilities.reachable,true);
  await f.lifecycle(thread,'SessionEnd');await f.lifecycle(thread,'SessionStart');
  assert.deepEqual(await call(child,thread,'triangle_attach_session'),{});
  const resumed=(await f.listed()).find(r=>r.id===f.address(thread));assert.equal(resumed.generation,2);assert.equal(resumed.capabilities.reachable,true,'hook refresh cannot reuse an old generation grant');
  await assert.rejects(call(child,uuid(),'triangle_attach_session'),/session_offline/,'no lifecycle report still fails closed after the bounded wait');
 }finally{await f.close();}
});

test('exact session grants restrict directory, credentials and send-time access; revoke fences an issued credential',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const f=await fixture();try{
  const threads=[uuid(),uuid()];for(const t of threads)await f.lifecycle(t,'SessionStart');
  const children=threads.map(()=>f.codexChild());for(let i=0;i<2;i++)await call(children[i],threads[i],'triangle_get_status');
  const file=f.config.sessionMessaging.integrationPath;
  writePrivateJson(file,{...readPrivateJson(file),codex:{enabled:true,allowedSenders:[]}});
  const to=f.address(threads[0]),other=f.address(threads[1]),options={config:f.configPath,senders:[f.desktopSender],to};
  assert.equal((await f.listed()).filter(r=>r.capabilities.reachable).length,0);
  const added=editSessionGrant('grant-session',options);assert.equal(added.version,2);assert.equal(added.changed,true);
  assert.equal(editSessionGrant('grant-session',options).changed,false);
  assert.deepEqual((await f.listed()).filter(r=>r.capabilities.reachable).map(r=>r.id),[to]);
  const credential=await f.grant();
  await assert.rejects(f.owner.sendMessage({to:other,text:'denied',messageId:'pair-wrong',requestId:'pair-wrong'},{credential}),{code:'recipient_not_allowed'});
  await f.owner.sendMessage({to,text:'allowed',messageId:'pair-good',requestId:'pair-good'},{credential});
  const claim=await call(children[0],threads[0],'triangle_claim_message',{messageId:'pair-good',claimId:'pair-claim'});
  // Replies use claim custody; no reverse request grant is needed.
  await call(children[0],threads[0],'triangle_reply_message',{messageId:'pair-good',claimToken:claim.claimToken,replyId:'pair-reply',text:'answer'});
  assert.equal((await f.owner.listReplies({requestId:'pair-good'},{credential})).length,1);
  assert.equal(editSessionGrant('revoke-session',options).changed,true);
  await assert.rejects(f.owner.sendMessage({to,text:'revoked',messageId:'pair-revoked',requestId:'pair-revoked'},{credential}),{code:'recipient_not_allowed'});
  assert.equal((await f.listed()).filter(r=>r.capabilities.reachable).length,0);
  assert.equal(editSessionGrant('revoke-session',options).changed,false);
  const listing=editSessionGrant('list-session-grants',{config:f.configPath});
  assert.deepEqual(listing.workspaceWide.codex,[]);assert.equal('secret' in listing,false);
  // Existing broad grants retain their semantics and are shown explicitly.
  writePrivateJson(file,{...readPrivateJson(file),codex:{enabled:true,allowedSenders:[f.desktopSender]}});
  assert.equal((await f.listed()).length,2);
  assert.deepEqual(editSessionGrant('list-session-grants',{config:f.configPath}).workspaceWide.codex,[f.desktopSender]);
 }finally{await f.close();}
});

test('attached session pairs work in both harnesses without reverse initiation or replacement inheritance',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const f=await fixture({claude:true});try{
  const source=uuid(),target=uuid(),replacement=uuid();
  await f.lifecycle(source,'SessionStart','claude');await f.lifecycle(target,'SessionStart');await f.lifecycle(replacement,'SessionStart');
  const policy=readPrivateJson(f.config.sessionMessaging.integrationPath);
  const transport=f.client();const sourceGrant=await transport.attachSession({harness:'claude',sessionId:source,childId:uuid(),secret:policy.secret,installationId:policy.installationId});
  const sender=sourceGrant.senderId,to=f.address(target),other=f.address(replacement);
  const children=[f.codexChild(),f.codexChild()];await call(children[0],target,'triangle_get_status');await call(children[1],replacement,'triangle_get_status');
  const options={config:f.configPath,senders:[sender],to};editSessionGrant('grant-session',options);
  // Refresh the session's credential after the owner grant, through the actual broker.
  const childId=uuid(); // use a distinct source session for direct credential capture below
  const source2=uuid();await f.lifecycle(source2,'SessionStart','claude');
  const source2Address=sessionAddress(policy.installationId,policy.workspace,source2);
  editSessionGrant('grant-session',{...options,senders:[source2Address]});
  const grant=await transport.attachSession({harness:'claude',sessionId:source2,childId,secret:policy.secret,installationId:policy.installationId});
  const client=f.client(grant.senderId);
  assert.deepEqual((await client.listSessions({credential:grant.credential})).filter(r=>r.harness==='codex').map(r=>r.id),[to]);
  await client.sendMessage({to,text:'exact',messageId:'session-pair',requestId:'session-pair'},{credential:grant.credential});
  await assert.rejects(client.sendMessage({to:other,text:'wrong',messageId:'session-wrong',requestId:'session-wrong'},{credential:grant.credential}),{code:'recipient_not_allowed'});
  await assert.rejects(call(children[0],target,'triangle_send_message',{to:source2Address,text:'reverse',messageId:'reverse',requestId:'reverse'}),/recipient_not_allowed/);
  const claim=await call(children[0],target,'triangle_claim_message',{messageId:'session-pair',claimId:'session-pair-claim'});
  await call(children[0],target,'triangle_reply_message',{messageId:'session-pair',claimToken:claim.claimToken,text:'pair reply',replyId:'session-pair-reply'});
  assert.equal((await client.listReplies({requestId:'session-pair'},{credential:grant.credential})).length,1);
  editSessionGrant('revoke-session',{...options,senders:[source2Address]});
  await assert.rejects(client.sendMessage({to,text:'revoked',messageId:'session-revoked',requestId:'session-revoked'},{credential:grant.credential}),{code:'recipient_not_allowed'});
  // Grant to Claude works too; this used to only populate Codex credential recipients.
  editSessionGrant('grant-session',{config:f.configPath,senders:[to],to:source2Address});
  await children[0].heartbeat();
  await call(children[0],target,'triangle_send_message',{to:source2Address,text:'Claude target',messageId:'to-claude',requestId:'to-claude'});
  // Reattachment of the same target preserves the exact address; no grant to a replacement chat.
  await children[0].close();const reopened=f.codexChild();await call(reopened,target,'triangle_get_status');
  assert.equal((await call(reopened,target,'triangle_get_status')).senderId,to);
 }finally{await f.close();}
});

test('exact grant policy rejects malformed, duplicate and over-capacity input without changing private policy',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const f=ownerFiles();try{
  const config=readPrivateJson(f.configPath),file=config.sessionMessaging.integrationPath,old=readPrivateJson(file);
  const pair={sender:f.desktopSender,recipient:'session-'+'b'.repeat(64)};
  for(const exactPairs of [[pair,pair],[{...pair,extra:true}],[{...pair,recipient:'label'}],Array.from({length:129},(_,i)=>({...pair,recipient:'session-'+i.toString(16).padStart(64,'0')}))]){
   writePrivateJson(file,{...old,version:2,exactPairs});assert.throws(()=>readSessionMessagingPolicy(file),{code:'invalid_session_policy'});
  }
  writePrivateJson(file,{...old,exactPairs:[]});assert.throws(()=>readSessionMessagingPolicy(file),{code:'invalid_session_policy'});
  writePrivateJson(file,old);
  const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>editSessionGrant('grant-session',{config:f.configPath,senders:[f.desktopSender],to:'pretty title'}),{code:'invalid_arguments'});
  assert.equal(fs.readFileSync(file,'utf8'),before);
  editSessionGrant('grant-session',{config:f.configPath,senders:[f.desktopSender],to:pair.recipient});
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  setupWorkspaceMessaging(f.codexOptions);assert.equal(readSessionMessagingPolicy(file).exactPairs.length,1,'setup preserves exact grants');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('exact-only setup is explicit and preserves same-owner pairs on ordinary setup',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const f=ownerFiles();try{
  setupWorkspaceMessaging({...f.codexOptions,senders:undefined,exactOnly:true});
  const config=readPrivateJson(f.configPath),file=config.sessionMessaging.integrationPath;
  assert.deepEqual(readSessionMessagingPolicy(file).codex.allowedSenders,[]);
  editSessionGrant('grant-session',{config:f.configPath,senders:[f.desktopSender],to:'session-'+'c'.repeat(64)});
  const before=readSessionMessagingPolicy(file);
  setupLocalMessaging({config:f.configPath,'desktop-binding':config.bindingPath,'thread-id':'11111111-2222-4333-8444-555555555555',recipients:['gravity2']});
  assert.equal(readPrivateJson(f.configPath).sessionMessaging.enabled,true);
  assert.deepEqual(readSessionMessagingPolicy(file),before);
  editSessionGrant('revoke-session',{config:f.configPath,senders:[f.desktopSender],to:'session-'+'c'.repeat(64)});
  setupLocalMessaging({config:f.configPath,'desktop-binding':config.bindingPath,'thread-id':'11111111-2222-4333-8444-555555555555',recipients:['gravity2']});
  assert.equal(readPrivateJson(f.configPath).sessionMessaging.enabled,true,'empty exact-only policy survives ordinary setup');
  assert.throws(()=>setupWorkspaceMessaging({...f.codexOptions,exactOnly:true}),{code:'invalid_arguments'});
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('owner policy writers fail closed under contention and concurrent revoke cannot be lost',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const {withPrivateFileLock}=await import('../src/local-messaging-auth-broker.mjs');
 const f=ownerFiles();try{
  const file=readPrivateJson(f.configPath).sessionMessaging.integrationPath;
  const options={config:f.configPath,senders:[f.desktopSender],to:'session-'+'d'.repeat(64)};
  editSessionGrant('grant-session',options);
  withPrivateFileLock(file,()=>{
   assert.throws(()=>editSessionGrant('revoke-session',options),{code:'policy_busy'});
   assert.throws(()=>setupWorkspaceMessaging(f.codexOptions),{code:'policy_busy'});
   assert.throws(()=>disableWorkspaceMessaging({config:f.configPath}),{code:'policy_busy'});
  });
  assert.equal(fs.existsSync(file+'.lock'),false);
  const moduleUrl=new URL('../src/local-messaging-cli.mjs',import.meta.url).href;
  const run=(command,opts)=>new Promise((resolve,reject)=>{
   const code=`import {editSessionGrant} from ${JSON.stringify(moduleUrl)}; const [command,opts]=JSON.parse(process.argv[1]); for(let i=0;;i++){try{editSessionGrant(command,opts);break;}catch(e){if(e.code!=='policy_busy'||i>=100)throw e;await new Promise(r=>setTimeout(r,5));}}`;
   const child=spawn(process.execPath,['--input-type=module','-e',code,JSON.stringify([command,opts])],{stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(errors)));
  });
  const other={...options,to:'session-'+'e'.repeat(64)};
  await Promise.all([run('revoke-session',options),run('grant-session',other)]);
  assert.deepEqual(readSessionMessagingPolicy(file).exactPairs,[{sender:f.desktopSender,recipient:other.to}]);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('disabled harness and removed owner principal cannot retain exact-pair delivery',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const {createWorkspaceSessionBroker}=await import('../src/local-messaging-interactive-session.mjs');
 const f=await fixture({claude:true});try{
  const thread=uuid();await f.lifecycle(thread,'SessionStart');const child=f.codexChild();await call(child,thread,'triangle_get_status');
  const file=f.config.sessionMessaging.integrationPath,to=f.address(thread);
  writePrivateJson(file,{...readPrivateJson(file),codex:{enabled:true,allowedSenders:[]}});
  editSessionGrant('grant-session',{config:f.configPath,senders:[f.desktopSender],to});
  const credential=await f.grant();
  writePrivateJson(file,{...readPrivateJson(file),codex:{enabled:false,allowedSenders:[]}});
  assert.equal((await f.listed()).some(r=>r.capabilities.reachable),false);
  await assert.rejects(f.owner.sendMessage({to,text:'disabled',messageId:'disabled-pair',requestId:'disabled-pair'},{credential}),{code:'session_offline'});
  // Exact pairs for an unconfigured 64-hex principal do not confer sender authority.
  const unknown='f'.repeat(64);
  editSessionGrant('grant-session',{config:f.configPath,senders:[unknown],to});
  writePrivateJson(file,{...readPrivateJson(file),codex:{enabled:true,allowedSenders:[]}});
  await assert.rejects(f.client(unknown).listSessions({credential}),{code:'unauthorized'});
  const broker=createWorkspaceSessionBroker({policyPath:file,discoveryPath:f.config.discovery.integrationPath,journal:{},issue(){},ownerSenderId:f.desktopSender,codexSenderPrincipals:[f.desktopSender]});
  assert.deepEqual(await broker.listFor(unknown),[],'unconfigured principal exact pairs are filtered before any journal access');
 }finally{await f.close();}
});


test('CLI program creates and revokes v2 exact grants without exposing secrets',async()=>{
 const f=ownerFiles();try{
  const setup=await runProgram(['setup-session-messaging','--config',f.configPath,'--harness','codex','--workspace',f.workspace,'--local-cli',f.wrapper,'--exact-only']);
  assert.equal(setup.code,0,setup.stderr);assert.deepEqual(JSON.parse(setup.stdout).allowedSenders,[]);
  const args=['--config',f.configPath,'--sender',f.desktopSender,'--to','session-'+'b'.repeat(64)];
  const grant=await runProgram(['grant-session',...args]);assert.equal(grant.code,0,grant.stderr);
  const added=JSON.parse(grant.stdout);assert.equal(added.version,2);assert.equal(added.changed,true);assert.equal('secret' in added,false);
  const listing=await runProgram(['list-session-grants','--config',f.configPath]);assert.equal(JSON.parse(listing.stdout).exactPairs.length,1);
  const revoke=await runProgram(['revoke-session',...args]);assert.equal(revoke.code,0,revoke.stderr);assert.deepEqual(JSON.parse(revoke.stdout).exactPairs,[]);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('class grant policy is version 3 only, strict, and never names a harness to itself',()=>{
 const f=ownerFiles({claude:true});try{
  const file=readPrivateJson(f.configPath).sessionMessaging.integrationPath,old=readPrivateJson(file);
  const grant={senderHarness:'claude',recipientHarness:'codex'},reverse={senderHarness:'codex',recipientHarness:'claude'};
  writePrivateJson(file,{...old,version:3,exactPairs:[],classGrants:[grant],classRevision:0});assert.deepEqual(readSessionMessagingPolicy(file).classGrants,[grant]);
  writePrivateJson(file,{...old,version:3,exactPairs:[],classGrants:[],classRevision:7});assert.deepEqual(readSessionMessagingPolicy(file).classGrants,[]);
  writePrivateJson(file,{...old,version:3,exactPairs:[],classGrants:[grant,reverse],classRevision:1});assert.equal(readSessionMessagingPolicy(file).classGrants.length,2);
  const v3={version:3,exactPairs:[],classRevision:0};
  for(const patch of [
   {version:3,exactPairs:[],classRevision:0},{version:3,classGrants:[grant],classRevision:0},{version:2,exactPairs:[],classGrants:[grant]},{version:1,classGrants:[grant]},
   {version:2,exactPairs:[],classRevision:0},{...v3,classGrants:[grant,grant]},{...v3,classGrants:[grant,reverse,grant]},
   {...v3,classGrants:[{senderHarness:'claude',recipientHarness:'claude'}]},
   {...v3,classGrants:[{senderHarness:'claude',recipientHarness:'grok'}]},
   {...v3,classGrants:[{...grant,extra:true}]},{...v3,classGrants:[{senderHarness:'claude'}]},
   {...v3,classGrants:'claude>codex'},{version:4,exactPairs:[],classGrants:[],classRevision:0},
   {version:3,exactPairs:[],classGrants:[]},{...v3,classGrants:[],classRevision:-1},{...v3,classGrants:[],classRevision:1.5},{...v3,classGrants:[],classRevision:'1'},
  ]){
   writePrivateJson(file,{...old,...patch});assert.throws(()=>readSessionMessagingPolicy(file),{code:'invalid_session_policy'},JSON.stringify(patch));
  }
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a class grant is a two-step owner action: plan, then confirm from a terminal; revoking needs neither',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const f=ownerFiles({claude:true});try{
  const file=readPrivateJson(f.configPath).sessionMessaging.integrationPath;
  const base={config:f.configPath,'sender-harness':'claude','to-harness':'codex'};
  const before=fs.readFileSync(file,'utf8');
  const plan=editSessionGrant('grant-session-class',base);
  assert.equal(plan.applied,false);assert.equal(plan.requiresTerminal,true);assert.match(plan.planId,/^[a-f0-9]{64}$/);assert.match(plan.apply,/--confirm [a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(file,'utf8'),before,'a plan changes nothing');assert.equal(JSON.stringify(plan).includes(readPrivateJson(file).secret),false,'a plan never carries the capability secret');
  // The plan's id covers the policy except its capability secret, so it is not a hash anyone could test secret guesses against.
  const original=readPrivateJson(file);writePrivateJson(file,{...original,secret:'a'.repeat(64)});
  assert.equal(editSessionGrant('grant-session-class',base).planId,plan.planId);writePrivateJson(file,original);
  // Only an interactive terminal applies a plan: not a script, a pipe or an agent shell.
  assert.throws(()=>editSessionGrant('grant-session-class',{...base,confirm:plan.planId}),{code:'owner_terminal_required'});
  assert.throws(()=>editSessionGrant('grant-session-class',{...base,confirm:plan.planId,interactive:false}),{code:'owner_terminal_required'});
  assert.throws(()=>editSessionGrant('grant-session-class',{...base,confirm:'0'.repeat(64),interactive:true}),{code:'plan_stale'});
  assert.throws(()=>editSessionGrant('grant-session-class',{...base,confirm:'short',interactive:true}),{code:'invalid_arguments'});
  assert.equal(fs.readFileSync(file,'utf8'),before);
  // The plan is bound to the policy it described: any other change makes it stale.
  editSessionGrant('grant-session',{config:f.configPath,senders:[f.desktopSender],to:'session-'+'b'.repeat(64)});
  assert.throws(()=>editSessionGrant('grant-session-class',{...base,confirm:plan.planId,interactive:true}),{code:'plan_stale'});
  const fresh=editSessionGrant('grant-session-class',base);assert.notEqual(fresh.planId,plan.planId);
  const applied=editSessionGrant('grant-session-class',{...base,confirm:fresh.planId,interactive:true});
  assert.equal(applied.version,3);assert.equal(applied.changed,true);assert.equal(applied.minimumPolicyReaderVersion,3);assert.equal('secret' in applied,false);
  assert.deepEqual(applied.classGrants,[{senderHarness:'claude',recipientHarness:'codex'}]);assert.equal(applied.exactPairs.length,1);
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(readSessionMessagingPolicy(file).version,3);
  assert.equal(editSessionGrant('grant-session-class',base).changed,false,'already granted: nothing to plan or apply');
  // Exact grants keep working on a version 3 policy; they never lower its version or drop class grants.
  const pair={config:f.configPath,senders:[f.desktopSender],to:'session-'+'c'.repeat(64)};
  const exact=editSessionGrant('grant-session',pair);assert.equal(exact.version,3);assert.equal(exact.minimumPolicyReaderVersion,3);assert.equal(exact.classGrants.length,1);
  assert.equal(editSessionGrant('revoke-session',pair).version,3);
  assert.equal(editSessionGrant('list-session-grants',{config:f.configPath}).classGrants.length,1);
  // Revoking only removes authority, so it needs no plan and no terminal, and the policy stays version 3.
  assert.equal(readSessionMessagingPolicy(file).classRevision,1);
  const revoked=editSessionGrant('revoke-session-class',base);
  assert.equal(revoked.changed,true);assert.deepEqual(revoked.classGrants,[]);assert.equal(revoked.version,3);assert.equal(readSessionMessagingPolicy(file).version,3);
  assert.equal(editSessionGrant('revoke-session-class',base).changed,false);
  assert.equal(readSessionMessagingPolicy(file).classRevision,2);
  // A revoke is a change a printed plan must not outlive: grant, revoke, and the policy holds the same content as before except
  // for its revision, so an old apply command from a shell history or a transcript must not bring the grant back.
  const replayed=editSessionGrant('grant-session-class',base);
  editSessionGrant('grant-session-class',{...base,confirm:replayed.planId,interactive:true});
  editSessionGrant('revoke-session-class',base);
  assert.deepEqual(readSessionMessagingPolicy(file).classGrants,[]);
  assert.throws(()=>editSessionGrant('grant-session-class',{...base,confirm:replayed.planId,interactive:true}),{code:'plan_stale'},'a plan cannot be replayed after its grant was revoked');
  assert.deepEqual(readSessionMessagingPolicy(file).classGrants,[]);
  assert.throws(()=>editSessionGrant('revoke-session-class',{...base,confirm:plan.planId}),{code:'invalid_arguments'});
  for(const bad of [{'sender-harness':'claude','to-harness':'claude'},{'sender-harness':'grok','to-harness':'codex'},{'sender-harness':'claude'},{'to-harness':'codex'},{...base,senders:[f.desktopSender]},{...base,to:'session-'+'d'.repeat(64)}]){
   assert.throws(()=>editSessionGrant('grant-session-class',{config:f.configPath,...bad}),{code:'invalid_arguments'},JSON.stringify(bad));
  }
  assert.throws(()=>editSessionGrant('grant-session',{...pair,'sender-harness':'claude'}),{code:'invalid_arguments'},'class flags are not valid for exact grants');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('the CLI program prints a class-grant plan but refuses to apply it without a terminal',async()=>{
 const f=ownerFiles({claude:true});try{
  const file=readPrivateJson(f.configPath).sessionMessaging.integrationPath;
  const args=['--config',f.configPath,'--sender-harness','claude','--to-harness','codex'];
  const plan=await runProgram(['grant-session-class',...args]);assert.equal(plan.code,0,plan.stderr);
  const shown=JSON.parse(plan.stdout);assert.equal(shown.applied,false);assert.match(shown.apply,/^triangle-local grant-session-class --config '.*' --sender-harness claude --to-harness codex --confirm [a-f0-9]{64}$/);
  const apply=await runProgram(['grant-session-class',...args,'--confirm',shown.planId]);
  assert.notEqual(apply.code,0);assert.match(apply.stderr,/owner_terminal_required/);assert.equal(readSessionMessagingPolicy(file).version,1,'nothing was written');
  // The flags of this command mean nothing elsewhere.
  const stray=await runProgram(['list-session-grants','--config',f.configPath,'--confirm',shown.planId]);assert.notEqual(stray.code,0);assert.match(stray.stderr,/invalid_arguments/);
  const strayHarness=await runProgram(['status','--config',f.configPath,'--sender-harness','claude']);assert.notEqual(strayHarness.code,0);assert.match(strayHarness.stderr,/invalid_arguments/);
  const strayRevoke=await runProgram(['revoke-session-class',...args,'--confirm',shown.planId]);assert.notEqual(strayRevoke.code,0);assert.match(strayRevoke.stderr,/invalid_arguments/);
  assert.deepEqual(JSON.parse((await runProgram(['list-session-grants','--config',f.configPath])).stdout).classGrants,[]);
  const revoke=await runProgram(['revoke-session-class',...args]);assert.equal(revoke.code,0,revoke.stderr);assert.equal(JSON.parse(revoke.stdout).changed,false);
  // Detail is printed for the command's own codes only: any other error must not carry a file path.
  const missing=await runProgram(['grant-session-class','--config','/private/tmp/tri-no-such-dir/local.json','--sender-harness','claude','--to-harness','codex']);
  assert.notEqual(missing.code,0);assert.equal(missing.stderr.includes('tri-no-such-dir'),false);assert.match(missing.stderr,/Triangle local command failed/);
  const same=await runProgram(['grant-session-class','--config',f.configPath,'--sender-harness','claude','--to-harness','claude']);
  assert.notEqual(same.code,0);assert.match(same.stderr,/Choose --sender-harness and --to-harness as claude and codex/);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('applying a class grant needs both stdin and stdout to be terminals, as identity migrate does',async()=>{
 const {runLocalMessagingCLI}=await import('../src/local-messaging-cli.mjs');
 const f=ownerFiles({claude:true});try{
  const file=readPrivateJson(f.configPath).sessionMessaging.integrationPath;
  const args=['grant-session-class','--config',f.configPath,'--sender-harness','claude','--to-harness','codex'];
  const sink=isTTY=>({isTTY,chunks:[],write(text){this.chunks.push(text);return true;}});
  const planned=sink(false);assert.equal(await runLocalMessagingCLI(args,{input:{isTTY:false},output:planned}),0);
  const {planId}=JSON.parse(planned.chunks.join(''));
  // A terminal on stdin with the result piped or captured does not count, and neither does the reverse.
  for(const [input,output] of [[true,false],[false,true],[false,false],[undefined,true],[true,undefined]]){
   await assert.rejects(runLocalMessagingCLI([...args,'--confirm',planId],{input:{isTTY:input},output:sink(output)}),{code:'owner_terminal_required'},JSON.stringify([input,output]));
  }
  assert.equal(readSessionMessagingPolicy(file).version,1,'nothing was written');
  const done=sink(true);assert.equal(await runLocalMessagingCLI([...args,'--confirm',planId],{input:{isTTY:true},output:done}),0);
  assert.equal(JSON.parse(done.chunks.join('')).changed,true);assert.equal(readSessionMessagingPolicy(file).version,3);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a class grant admits every live session of the harness, new ones included, with no per-session grant',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const f=await fixture({claude:true});try{
  const file=f.config.sessionMessaging.integrationPath,policy=readPrivateJson(file);
  // Nobody is listed for Codex chats, so only a class grant can admit a Claude session.
  writePrivateJson(file,{...policy,codex:{enabled:true,allowedSenders:[]}});
  const claudeChat=async()=>{
   const sessionId=uuid(),childId=uuid();await f.lifecycle(sessionId,'SessionStart','claude');
   const attach=()=>f.client().attachSession({harness:'claude',sessionId,childId,secret:policy.secret,installationId:policy.installationId});
   const first=await attach();return {address:first.senderId,client:f.client(first.senderId),attach};
  };
  const codexChat=async()=>{const thread=uuid();await f.lifecycle(thread,'SessionStart');const child=f.codexChild();await call(child,thread,'triangle_get_status');return {thread,child,address:f.address(thread)};};
  // A fresh credential, as the chat's heartbeat renews it, and what that credential lists as reachable Codex chats.
  const reach=async chat=>{const grant=await chat.attach();const rows=await chat.client.listSessions({credential:grant.credential});
   // `rows` is the session part of the directory; the configured workers are listed beside it and are not under test here.
   return {grant,rows:rows.filter(r=>r.id.startsWith('session-')),visible:rows.filter(r=>r.harness==='codex'&&r.capabilities.reachable).map(r=>r.id).sort()};};
  const apply=(from,to)=>{const base={config:f.configPath,'sender-harness':from,'to-harness':to};return editSessionGrant('grant-session-class',{...base,confirm:editSessionGrant('grant-session-class',base).planId,interactive:true});};

  const claudeA=await claudeChat(),codexA=await codexChat();
  const before=await reach(claudeA);assert.deepEqual(before.visible,[],'no class grant yet');
  await assert.rejects(claudeA.client.sendMessage({to:codexA.address,text:'early',messageId:'cg-early',requestId:'cg-early'},{credential:before.grant.credential}),{code:'recipient_not_allowed'});

  assert.equal(apply('claude','codex').version,3);
  // Sessions that start after the grant need nothing more: not a new Claude chat, not a new Codex chat.
  const claudeB=await claudeChat(),codexB=await codexChat();
  const idle=uuid();await f.lifecycle(idle,'SessionStart');   // a Codex chat that never attached
  const expected=[codexA.address,codexB.address].sort();
  const a=await reach(claudeA);assert.deepEqual(a.visible,expected);
  // A class grant admits a reader to the chats it can reach right now, not to idle or ended ones or to their titles, and not to its own harness.
  assert.deepEqual(a.rows.map(r=>r.id).sort(),expected);
  await assert.rejects(claudeA.client.sendMessage({to:claudeB.address,text:'peer',messageId:'cg-peer',requestId:'cg-peer'},{credential:a.grant.credential}),{code:'recipient_not_allowed'},'a harness never gets a class grant to itself');
  await assert.rejects(claudeA.client.sendMessage({to:f.address(idle),text:'idle',messageId:'cg-idle',requestId:'cg-idle'},{credential:a.grant.credential}),error=>['session_offline','recipient_not_allowed'].includes(error.code));
  const b=await reach(claudeB);assert.deepEqual(b.visible,expected);
  await claudeB.client.sendMessage({to:codexB.address,text:'hello',messageId:'cg-1',requestId:'cg-1'},{credential:b.grant.credential});
  const claim=await call(codexB.child,codexB.thread,'triangle_claim_message',{messageId:'cg-1',claimId:'cg-1-claim'});
  // Replies follow claim custody; a class grant is a grant to start a conversation only.
  await call(codexB.child,codexB.thread,'triangle_reply_message',{messageId:'cg-1',claimToken:claim.claimToken,text:'hi',replyId:'cg-1-reply'});
  assert.deepEqual((await claudeB.client.listReplies({requestId:'cg-1'},{credential:b.grant.credential})).map(r=>r.text),['hi']);

  // The grant is one-way and for sessions: the reverse direction and the bound owner principal are untouched.
  await assert.rejects(call(codexA.child,codexA.thread,'triangle_send_message',{to:claudeA.address,text:'reverse',messageId:'cg-rev',requestId:'cg-rev'}),/recipient_not_allowed/);
  await assert.rejects(f.owner.sendMessage({to:codexA.address,text:'owner',messageId:'cg-owner',requestId:'cg-owner'},{credential:await f.grant()}),{code:'recipient_not_allowed'});
  apply('codex','claude');await codexA.child.heartbeat();
  await call(codexA.child,codexA.thread,'triangle_send_message',{to:claudeA.address,text:'reverse',messageId:'cg-rev2',requestId:'cg-rev2'});

  // An ended chat and the bound Codex conversation are never targets.
  await f.lifecycle(codexA.thread,'SessionEnd');
  const afterEnd=await reach(claudeA);assert.deepEqual(afterEnd.visible,[codexB.address]);
  assert.deepEqual(afterEnd.rows.map(r=>r.id),[codexB.address],'an ended chat and its title leave the class-granted directory');
  await assert.rejects(claudeA.client.sendMessage({to:codexA.address,text:'ended',messageId:'cg-ended',requestId:'cg-ended'},{credential:afterEnd.grant.credential}),{code:'session_offline'});
  const bound=f.address('11111111-2222-4333-8444-555555555555');await f.lifecycle('11111111-2222-4333-8444-555555555555','SessionStart');
  const withBound=await reach(claudeA);assert.equal(withBound.visible.includes(bound),false);
  await assert.rejects(claudeA.client.sendMessage({to:bound,text:'bound',messageId:'cg-bound',requestId:'cg-bound'},{credential:withBound.grant.credential}),error=>['session_offline','recipient_not_allowed'].includes(error.code));

  // The recipient harness's own switch still governs a class grant: with Codex messaging off nothing is listed or deliverable.
  const original=readPrivateJson(file);writePrivateJson(file,{...original,codex:{...original.codex,enabled:false}});
  const off=await reach(claudeB);assert.deepEqual(off.rows,[]);
  await assert.rejects(claudeB.client.sendMessage({to:codexB.address,text:'off',messageId:'cg-off',requestId:'cg-off'},{credential:off.grant.credential}),error=>['session_offline','recipient_not_allowed'].includes(error.code));
  writePrivateJson(file,original);

  // Revoking fences a credential that was issued while the grant stood, at the next send.
  const stale=await reach(claudeB);assert.deepEqual(stale.visible,[codexB.address]);
  assert.equal(editSessionGrant('revoke-session-class',{config:f.configPath,'sender-harness':'claude','to-harness':'codex'}).changed,true);
  await assert.rejects(claudeB.client.sendMessage({to:codexB.address,text:'revoked',messageId:'cg-revoked',requestId:'cg-revoked'},{credential:stale.grant.credential}),{code:'recipient_not_allowed'});
  assert.deepEqual((await reach(claudeB)).visible,[]);
 }finally{await f.close();}
});

test('ordinary setup keeps class grants; exact-only setup drops the ones that admit into that harness',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const f=ownerFiles({claude:true});try{
  const file=readPrivateJson(f.configPath).sessionMessaging.integrationPath;
  for(const [from,to] of [['claude','codex'],['codex','claude']]){
   const base={config:f.configPath,'sender-harness':from,'to-harness':to};
   editSessionGrant('grant-session-class',{...base,confirm:editSessionGrant('grant-session-class',base).planId,interactive:true});
  }
  assert.equal(readSessionMessagingPolicy(file).classGrants.length,2);
  setupWorkspaceMessaging(f.codexOptions);
  assert.equal(readSessionMessagingPolicy(file).version,3);assert.equal(readSessionMessagingPolicy(file).classGrants.length,2,'ordinary setup keeps class grants');
  setupWorkspaceMessaging({...f.codexOptions,senders:undefined,exactOnly:true});
  assert.deepEqual(readSessionMessagingPolicy(file).classGrants,[{senderHarness:'codex',recipientHarness:'claude'}],'exact-only for Codex drops the grant into Codex and keeps the other');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('setup reports and repairs class grants, exact-only for Claude drops the ones into Claude, and a fresh policy starts without any',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const f=ownerFiles({claude:true});try{
  const file=readPrivateJson(f.configPath).sessionMessaging.integrationPath;
  const apply=(from,to)=>{const base={config:f.configPath,'sender-harness':from,'to-harness':to};return editSessionGrant('grant-session-class',{...base,confirm:editSessionGrant('grant-session-class',base).planId,interactive:true});};
  apply('claude','codex');apply('codex','claude');
  assert.equal(setupWorkspaceMessaging(f.codexOptions).classGrants.length,2,'the setup result shows the standing grants');
  // exact-only for Claude drops only the grant into Claude, and that counts as a class grant change.
  const revision=readSessionMessagingPolicy(file).classRevision;
  const claudeSetup=setupWorkspaceMessaging({config:f.configPath,workspace:f.workspace,'local-cli':f.wrapper,exactOnly:true});
  assert.deepEqual(claudeSetup.classGrants,[{senderHarness:'claude',recipientHarness:'codex'}]);
  assert.equal(readSessionMessagingPolicy(file).classRevision,revision+1);
  // What an older release's setup leaves behind: version 3 without the fields it did not know. Setup repairs it to hold none.
  const damaged=readPrivateJson(file);delete damaged.classGrants;delete damaged.classRevision;delete damaged.exactPairs;writePrivateJson(file,damaged);
  assert.throws(()=>readSessionMessagingPolicy(file),{code:'invalid_session_policy'});
  assert.deepEqual(setupWorkspaceMessaging(f.codexOptions).classGrants,[]);
  const repaired=readSessionMessagingPolicy(file);assert.equal(repaired.version,3);assert.deepEqual(repaired.classGrants,[]);assert.deepEqual(repaired.exactPairs,[]);
  // Disabling and setting up again starts a fresh version 1 policy.
  apply('claude','codex');disableWorkspaceMessaging({config:f.configPath});setupWorkspaceMessaging(f.codexOptions);
  const fresh=readSessionMessagingPolicy(file);assert.equal(fresh.version,1);assert.equal(fresh.classGrants,undefined);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a class grant for a harness that is not on is flagged dormant, and setup shows it once it is',async()=>{
 const {editSessionGrant}=await import('../src/local-messaging-cli.mjs');
 const f=ownerFiles({claude:true,codexMessaging:false});try{
  const base={config:f.configPath,'sender-harness':'claude','to-harness':'codex'};
  const plan=editSessionGrant('grant-session-class',base);
  assert.equal(plan.dormant,true);assert.match(plan.effect,/nothing changes until it is/);assert.match(plan.effect,/without a person in the loop/);
  const applied=editSessionGrant('grant-session-class',{...base,confirm:plan.planId,interactive:true});assert.equal(applied.dormant,true);
  // Codex messaging arrives later; the owner sees the standing grant in the setup result instead of learning of it from behavior.
  const setup=setupWorkspaceMessaging(f.codexOptions);assert.deepEqual(setup.classGrants,[{senderHarness:'claude',recipientHarness:'codex'}]);
  editSessionGrant('revoke-session-class',base);
  assert.equal(editSessionGrant('grant-session-class',base).dormant,false,'both harnesses are on now');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
