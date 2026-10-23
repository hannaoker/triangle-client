import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {setupLocalMessaging,setupSessionDiscovery,setupWorkspaceMessaging,disableWorkspaceMessaging,runSessionDiscoveryHook} from '../src/local-messaging-cli.mjs';
import {readPrivateJson,writePrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {createInstalledLocalMessagingHost} from '../src/local-messaging-host.mjs';
import {createProfiledReasonerGate} from '../src/concurrency-gate.mjs';
import {createLocalControlClient} from '../src/local-messaging-client.mjs';
import {resolveLocalSocketAddress} from '../src/local-messaging-address.mjs';
import {createAttachedClaudeSessionMcpChild} from '../src/claude-session-mcp-child.mjs';
import {createLocalMessagingJournal} from '../src/local-messaging-journal.mjs';
async function fixture(){
 const root=fs.mkdtempSync('/private/tmp/tri-attach-'),workspace=path.join(root,'workspace');fs.mkdirSync(workspace,{mode:0o700});
 const wrapper=path.join(root,'triangle-local');fs.writeFileSync(wrapper,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');writePrivateJson(bindingPath,{instanceId:'a'.repeat(64)});
 setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'attachment-test-thread',recipients:['gravity2']});
 setupSessionDiscovery({config:configPath,workspace,'local-cli':wrapper});
 fs.writeFileSync(path.join(workspace,'.mcp.json'),JSON.stringify({mcpServers:{unrelated:{command:'preserve'}}}));
 setupWorkspaceMessaging({config:configPath,workspace,'local-cli':wrapper});
 const config=readPrivateJson(configPath),desktop=readPrivateJson(config.integrationPath);let host;const clients=[],children=[];
 const start=async()=>{host=createInstalledLocalMessagingHost({configPath,runners:new Map([[config.recipients[0].instanceId,{run:async()=>({status:'completed',text:'worker result'})}]]),gate:createProfiledReasonerGate()});await host.start();};await start();
 const client=(senderId)=>{const c=createLocalControlClient({socketPath:resolveLocalSocketAddress({stateRoot:config.stateRoot}).socketPath,senderId});clients.push(c);return c;};
 let owner=client(desktop.senderId);
 const grant=async()=> (await owner.exchangeTurnBinding({bindingId:desktop.bindingId,threadId:desktop.threadId,secret:desktop.secret})).credential;
 const lifecycle=async(sessionId,kind)=>runSessionDiscoveryHook({configPath,input:Readable.from([JSON.stringify({session_id:sessionId,cwd:workspace,hook_event_name:kind})]),stderr:{write(){}}});
 const child=async(sessionId)=>{const c=await createAttachedClaudeSessionMcpChild({configPath,cwd:workspace,policyPath:config.sessionMessaging.integrationPath,expectedVersion:'2.1.307',env:{CLAUDE_CODE_SESSION_ID:sessionId},wakeIntervalMs:0});children.push(c);return c;};
 return {root,workspace,configPath,config,client,get owner(){return owner;},grant,lifecycle,child,async restart(){await owner.close();await host.stop();await start();owner=client(desktop.senderId);},async close(){for(const c of children)await c.close();for(const c of clients)await c.close();await host?.stop();fs.rmSync(root,{recursive:true,force:true});}};
}
async function tool(child,name,args={}){const r=await child.handleRequest({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}});if(r.result.isError)throw new Error(r.result.content[0].text);return JSON.parse(r.result.content[0].text);}
test('two own-session MCP children route and reply independently, including after supervisor restart',async()=>{
 const f=await fixture();try{
  const ids=[randomUUID(),randomUUID()];for(const id of ids)await f.lifecycle(id,'SessionStart');
  const children=await Promise.all(ids.map(id=>f.child(id))),status=await Promise.all(children.map(c=>tool(c,'triangle_get_status')));assert.notEqual(status[0].senderId,status[1].senderId);
  let credential=await f.grant();assert.equal((await f.owner.listSessions({credential})).filter(r=>r.id.startsWith('session-')&&r.capabilities.reachable).length,2);
  for(let i=0;i<2;i++)await f.owner.sendMessage({to:status[i].senderId,text:'task '+i,messageId:'task-'+i,requestId:'request-'+i},{credential});
  for(let i=0;i<2;i++){
   const inbox=await tool(children[i],'triangle_list_inbox');assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].messageId,'task-'+i);
   await assert.rejects(tool(children[1-i],'triangle_claim_message',{messageId:'task-'+i,claimId:'foreign-'+i}));
   const claim=await tool(children[i],'triangle_claim_message',{messageId:'task-'+i,claimId:'claim-'+i});
   await tool(children[i],'triangle_reply_message',{messageId:'task-'+i,claimToken:claim.claimToken,text:'answer '+i,replyId:'reply-'+i});
  }
  await f.restart();credential=await f.grant();assert.deepEqual((await f.owner.listReplies({},{credential})).map(r=>r.text).sort(),['answer 0','answer 1']);
  for(let i=0;i<2;i++)assert.equal((await tool(children[i],'triangle_get_status')).senderId,status[i].senderId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace,'.mcp.json'))).mcpServers.unrelated.command,'preserve');
  for(const file of fs.readdirSync(f.config.stateRoot).filter(name=>name.includes('.sqlite'))){
   const bytes=fs.readFileSync(path.join(f.config.stateRoot,file));for(const id of ids)assert.equal(bytes.includes(Buffer.from(id)),false,'raw harness session UUID is not persisted');
  }
 }finally{await f.close();}
});
test('discovery credentials, competing child, lifecycle end, close and revocation are fenced',async()=>{
 const f=await fixture();try{
  const sid=randomUUID();await f.lifecycle(sid,'SessionStart');let credential=await f.grant();const row=(await f.owner.listSessions({credential})).find(r=>r.id.startsWith('session-'));
  await assert.rejects(f.owner.sendMessage({to:row.id,text:'not attached',messageId:'before',requestId:'before'},{credential}),{code:'session_offline'});
  const d=readPrivateJson(f.config.discovery.integrationPath);await assert.rejects(f.client().attachSession({installationId:d.installationId,secret:d.secret,sessionId:sid,childId:randomUUID()}),{code:'unauthorized'});
  const child=await f.child(sid),status=await tool(child,'triangle_get_status');const competing=await f.child(sid);await assert.rejects(tool(competing,'triangle_get_status'),/attachment_busy/);
  await f.lifecycle(sid,'SessionEnd');await assert.rejects(tool(child,'triangle_get_status'),/session_offline/);
  credential=await f.grant();await assert.rejects(f.owner.sendMessage({to:status.senderId,text:'ended',messageId:'ended',requestId:'ended'},{credential}),{code:'session_offline'});
  const nextId=randomUUID();await f.lifecycle(nextId,'SessionStart');const next=await f.child(nextId),nextAddress=(await tool(next,'triangle_get_status')).senderId;await next.close();
  credential=await f.grant();await assert.rejects(f.owner.sendMessage({to:nextAddress,text:'closed',messageId:'closed',requestId:'closed'},{credential}),{code:'session_offline'});
  const otherId=randomUUID();await f.lifecycle(otherId,'SessionStart');const other=await f.child(otherId);disableWorkspaceMessaging({config:f.configPath});await assert.rejects(tool(other,'triangle_get_status'),/session_revoked/);
  const mcp=JSON.parse(fs.readFileSync(path.join(f.workspace,'.mcp.json')));assert.equal(mcp.mcpServers.unrelated.command,'preserve');assert.equal(mcp.mcpServers['triangle-session'],undefined);
 }finally{await f.close();}
});
test('attachment custody survives restart and expires without letting an old child detach the new one',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-lease-');let j;try{
  j=createLocalMessagingJournal({stateRoot:root});const b={id:'session-test',installationId:randomUUID(),generation:1,wakeCapable:true};await j.attachDiscoveredSession({...b,childId:'first',now:1000});
  await assert.rejects(j.attachDiscoveredSession({...b,childId:'second',now:2000}),{code:'attachment_busy'});await j.close();j=createLocalMessagingJournal({stateRoot:root});
  await assert.rejects(j.attachDiscoveredSession({...b,childId:'second',now:3000}),{code:'attachment_busy'});await j.attachDiscoveredSession({...b,childId:'second',now:31001});
  await j.detachDiscoveredSession({id:b.id,childId:'first'});assert.equal((await j.getSessionAttachment(b.id)).child_id,'second');
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('MCP initialization precedes registration without granting authority; ended lifecycle fences existing signed credentials',async()=>{
 const f=await fixture();try{
  const sid=randomUUID(),child=await f.child(sid);
  const initialized=await child.handleRequest({jsonrpc:'2.0',id:1,method:'initialize'});assert.ok(initialized.result.capabilities.tools);
  await assert.rejects(tool(child,'triangle_get_status'),/session_offline/);
  await f.lifecycle(sid,'SessionStart');const status=await tool(child,'triangle_get_status');assert.ok(status.senderId.startsWith('session-'));
  // A second independent session obtains a signed grant. Test revocation at the
  // server, rather than relying only on the MCP child's local credential check.
  const other=randomUUID();await f.lifecycle(other,'SessionStart');const policy=readPrivateJson(f.config.sessionMessaging.integrationPath),transport=f.client();
  const tuple={sessionId:other,childId:randomUUID(),secret:policy.secret,installationId:policy.installationId,wakeCapable:false};
  const grant=await transport.attachSession(tuple),caller=f.client(grant.senderId);
  assert.equal((await caller.localStatus({credential:grant.credential})).senderId,grant.senderId);
  await f.lifecycle(other,'SessionEnd');await assert.rejects(caller.localStatus({credential:grant.credential}),{code:'session_offline'});
  await f.lifecycle(other,'SessionStart');
  await assert.rejects(transport.attachSession({...tuple,generation:grant.generation}),{code:'session_fenced'});
 }finally{await f.close();}
});

test('rotating participation capability fences issued credentials and old MCP children immediately',async()=>{
 const f=await fixture();try{
  const sid=randomUUID();await f.lifecycle(sid,'SessionStart');const policy=readPrivateJson(f.config.sessionMessaging.integrationPath),transport=f.client();
  const tuple={sessionId:sid,childId:randomUUID(),secret:policy.secret,installationId:policy.installationId};
  const grant=await transport.attachSession(tuple),caller=f.client(grant.senderId);
  writePrivateJson(f.config.sessionMessaging.integrationPath,{...policy,secret:'f'.repeat(64)});
  await assert.rejects(caller.localStatus({credential:grant.credential}),{code:'session_offline'});
  await assert.rejects(transport.attachSession(tuple),{code:'unauthorized'});
  // The old lease cannot block the new policy owner or revive the old grant.
  const replacement=await transport.attachSession({...tuple,secret:'f'.repeat(64),childId:randomUUID()});
  assert.equal(replacement.senderId,grant.senderId);
  await assert.rejects(caller.localStatus({credential:grant.credential}),{code:'session_fenced'});
 }finally{await f.close();}
});

test('missing workspace hides attachments without disrupting configured recipients',async()=>{
 const f=await fixture();try{
  const sid=randomUUID();await f.lifecycle(sid,'SessionStart');const child=await f.child(sid);await tool(child,'triangle_get_status');
  fs.renameSync(f.workspace,f.workspace+'-moved');
  const credential=await f.grant(),rows=await f.owner.listSessions({credential});assert.deepEqual(rows.map(r=>r.label),['gravity2']);
  await assert.rejects(tool(child,'triangle_get_status'));
 }finally{await f.close();}
});
