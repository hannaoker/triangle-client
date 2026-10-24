import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {setupLocalMessaging,setupSessionDiscovery,setupWorkspaceMessaging,disableWorkspaceMessaging,disableSessionDiscovery,runSessionDiscoveryHook} from '../src/local-messaging-cli.mjs';
import {readPrivateJson,writePrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {createInstalledLocalMessagingHost} from '../src/local-messaging-host.mjs';
import {createProfiledReasonerGate} from '../src/concurrency-gate.mjs';
import {createLocalControlClient} from '../src/local-messaging-client.mjs';
import {resolveLocalSocketAddress} from '../src/local-messaging-address.mjs';
import {createAttachedClaudeSessionMcpChild} from '../src/claude-session-mcp-child.mjs';
import {createLocalMessagingJournal} from '../src/local-messaging-journal.mjs';
import {createWorkspaceSessionBroker} from '../src/local-messaging-interactive-session.mjs';
// Owner-side files only (no host): base config, lifecycle discovery and workspace messaging for a disposable workspace.
function ownerFiles(){
 const root=fs.mkdtempSync('/private/tmp/tri-attach-'),workspace=path.join(root,'workspace');fs.mkdirSync(workspace,{mode:0o700});
 const wrapper=path.join(root,'triangle-local');fs.writeFileSync(wrapper,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');writePrivateJson(bindingPath,{instanceId:'a'.repeat(64)});
 setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'attachment-test-thread',recipients:['gravity2']});
 setupSessionDiscovery({config:configPath,workspace,'local-cli':wrapper});
 fs.writeFileSync(path.join(workspace,'.mcp.json'),JSON.stringify({mcpServers:{unrelated:{command:'preserve'}}}));
 setupWorkspaceMessaging({config:configPath,workspace,'local-cli':wrapper});
 return {root,workspace,wrapper,configPath,bindingPath};
}
async function fixture(){
 const {root,workspace,wrapper,configPath,bindingPath}=ownerFiles();
 const config=readPrivateJson(configPath);let desktop=readPrivateJson(config.integrationPath),host;const clients=[],children=[];
 // Runners follow the owner config as it is now; extra ids model a supervisor that still holds a runner for a removed profile.
 const start=async(extraRunnerIds=[])=>{const runner={run:async()=>({status:'completed',text:'worker result'})};
  host=createInstalledLocalMessagingHost({configPath,runners:new Map([...readPrivateJson(configPath).recipients.map(r=>r.instanceId),...extraRunnerIds].map(id=>[id,runner])),gate:createProfiledReasonerGate()});await host.start();};await start();
 const client=(senderId)=>{const c=createLocalControlClient({socketPath:resolveLocalSocketAddress({stateRoot:config.stateRoot}).socketPath,senderId});clients.push(c);return c;};
 let owner=client(desktop.senderId);
 const grant=async()=> (await owner.exchangeTurnBinding({bindingId:desktop.bindingId,threadId:desktop.threadId,secret:desktop.secret})).credential;
 const lifecycle=async(sessionId,kind)=>runSessionDiscoveryHook({configPath,input:Readable.from([JSON.stringify({session_id:sessionId,cwd:workspace,hook_event_name:kind})]),stderr:{write(){}}});
 const child=async(sessionId)=>{const c=await createAttachedClaudeSessionMcpChild({configPath,cwd:workspace,policyPath:config.sessionMessaging.integrationPath,expectedVersion:'2.1.307',env:{CLAUDE_CODE_SESSION_ID:sessionId},wakeIntervalMs:0});children.push(c);return c;};
 return {root,workspace,wrapper,bindingPath,configPath,config,client,get owner(){return owner;},grant,lifecycle,child,
  async restart(extraRunnerIds=[]){await owner.close();await host.stop();desktop=readPrivateJson(readPrivateJson(configPath).integrationPath);await start(extraRunnerIds);owner=client(desktop.senderId);},async close(){for(const c of children)await c.close();for(const c of clients)await c.close();await host?.stop();fs.rmSync(root,{recursive:true,force:true});}};
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

const claimsOf=credential=>JSON.parse(Buffer.from(credential.split('.')[0],'base64url').toString('utf8'));

test('a replacement MCP child inherits the outstanding wake instead of holding it stale',async()=>{
 const f=await fixture();try{
  const sid=randomUUID();await f.lifecycle(sid,'SessionStart');
  const policy=readPrivateJson(f.config.sessionMessaging.integrationPath),transport=f.client();
  const childA={sessionId:sid,childId:randomUUID(),secret:policy.secret,installationId:policy.installationId,wakeCapable:true};
  const first=await transport.attachSession(childA),callerA=f.client(first.senderId);
  await f.owner.sendMessage({to:first.senderId,text:'task',messageId:'wake-task',requestId:'wake-task'},{credential:await f.grant()});
  const wake=await callerA.reserveWakeNotification({reservationId:randomUUID()},{credential:first.credential});
  assert.equal(wake.deliveryAllowed,true);
  await callerA.reportWakeResult({wakeId:wake.wakeId,generation:wake.generation,sessionId:first.sessionId,bindingId:childA.childId,result:'accepted'},{credential:first.credential});
  // The MCP server is restarted while the model is still working on the woken task.
  await transport.detachSession(childA);
  const second=await transport.attachSession({...childA,childId:randomUUID()}),callerB=f.client(second.senderId);
  assert.equal(second.senderId,first.senderId);assert.notEqual(second.bindingId,first.bindingId);
  // The wake is still outstanding (not stale-held): nothing new is submitted and the new child can acknowledge it.
  const outstanding=await callerB.reserveWakeNotification({reservationId:randomUUID()},{credential:second.credential});
  assert.deepEqual([outstanding.deliveryAllowed,outstanding.state],[false,'accepted_awaiting_ack']);
  assert.deepEqual(await callerB.ackWake({wakeId:wake.wakeId,generation:wake.generation},{credential:second.credential}),{acknowledged:true,wakeId:wake.wakeId,generation:wake.generation});
  // Idle again: the only gate left is the minimum wake interval, never a stale hold.
  assert.equal((await callerB.reserveWakeNotification({reservationId:randomUUID()},{credential:second.credential})).state,'rate_limited');
  // The replaced child stays fenced.
  await assert.rejects(callerA.reserveWakeNotification({reservationId:randomUUID()},{credential:first.credential}),{code:'session_fenced'});
 }finally{await f.close();}
});

test('attached-session wake binding survives child replacement, restarts on a new generation and heals a stale hold',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-wake-');let j;try{
  j=createLocalMessagingJournal({stateRoot:root});
  const target='session-'+'1'.repeat(64),session=randomUUID(),[a,b,c,d,e]=Array.from({length:5},()=>randomUUID());
  const bind=(bindingId,generation)=>j.bindAttachedSessionWake({senderId:target,sessionId:session,generation,bindingId});
  const task=n=>j.recordSend({sender:'a'.repeat(64),recipient:target,recipientType:'interactive',messageId:'wake-task-'+n,requestId:'wake-task-'+n,text:'task '+n,metadata:{}});
  const reserve=(bindingId,generation,now,reservationId=randomUUID())=>j.reserveInteractiveWake({targetIdentity:target,reservationId,sessionId:session,generation,bindingId,now});
  const ack=(wakeId,bindingId,generation,now)=>j.ackInteractiveWake({targetIdentity:target,wakeId,generation,sessionId:session,bindingId,now});
  assert.equal((await bind(a,1)).deliveryState,'idle');
  await task(1);
  const first=await reserve(a,1,1000);assert.equal(first.deliveryAllowed,true);
  await j.reportInteractiveWakeResult({targetIdentity:target,wakeId:first.wakeId,generation:1,sessionId:session,bindingId:a,result:'accepted',now:1500});
  // Heartbeats re-attach the same child: nothing is rewritten.
  const same=await bind(a,1);assert.equal((await bind(a,1)).updatedAt,same.updatedAt);
  // A replacement child inherits the outstanding wake; the replaced child is fenced.
  const moved=await bind(b,1);
  assert.deepEqual([moved.bindingId,moved.deliveryState,moved.activeWakeId],[b,'accepted_awaiting_ack',first.wakeId]);
  await assert.rejects(reserve(a,1,2000),{code:'binding_changed'});
  assert.deepEqual(await ack(first.wakeId,b,1,3000),{acknowledged:true,wakeId:first.wakeId,generation:1});
  // The wake history moved with the binding, so a replayed reservation is still recognised as a duplicate.
  assert.equal((await reserve(b,1,3500,first.wakeId)).isDuplicate,true);
  // Not wedged: the next wake is allowed once the minimum interval has passed.
  await task(2);
  const second=await reserve(b,1,17000);assert.equal(second.deliveryAllowed,true);
  // A new lifecycle generation starts a fresh epoch even with a wake outstanding; the old wake can no longer be acknowledged.
  const reset=await bind(c,2);
  assert.deepEqual([reset.bindingId,reset.generation,reset.deliveryState,reset.activeWakeId],[c,2,'idle',null]);
  await assert.rejects(ack(second.wakeId,c,1,18000),{code:'stale_wake_generation'});
  await task(3);
  assert.equal((await reserve(c,2,33000)).deliveryAllowed,true);
  // The legacy rebind rule still holds a legacy binding, but a held attached session is healed rather than permanent.
  assert.equal((await j.initInteractiveWakeBinding({senderId:target,sessionId:session,generation:2,bindingId:d})).deliveryState,'stale_held');
  assert.deepEqual([(await bind(e,2)).deliveryState,(await bind(e,2)).activeWakeId],['idle',null]);
  await task(4);
  assert.equal((await reserve(e,2,49000)).deliveryAllowed,true);
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('removing a worker from the owner config revokes session access to it; adding one needs the explicit setup',async()=>{
 const f=await fixture();try{
  const oldWorker=f.config.recipients[0].instanceId,sid=randomUUID(),childId=randomUUID();await f.lifecycle(sid,'SessionStart');
  const attach=async()=>{const policy=readPrivateJson(f.config.sessionMessaging.integrationPath),grant=await f.client().attachSession({sessionId:sid,childId,secret:policy.secret,installationId:policy.installationId,wakeCapable:false});
   return {grant,caller:f.client(grant.senderId)};};
  const send=({grant,caller},to,n)=>caller.sendMessage({to,text:'ping',messageId:'worker-'+n,requestId:'worker-'+n},{credential:grant.credential});
  // Before: the attached session may use the configured worker.
  let session=await attach();
  assert.deepEqual(claimsOf(session.grant.credential).allowedRecipients,[oldWorker]);
  assert.equal((await send(session,oldWorker,1)).accepted,true);
  // The owner replaces the worker list (same sender and thread); the supervisor still holds the old profile's runner.
  const rebase=setupLocalMessaging({config:f.configPath,'desktop-binding':f.bindingPath,'thread-id':'attachment-test-thread',recipients:['newworker']});
  assert.equal(rebase.sessionMessagingDisabled,undefined);
  await f.restart([oldWorker]);
  const newWorker=readPrivateJson(f.configPath).recipients[0].instanceId;
  session=await attach();
  assert.deepEqual(claimsOf(session.grant.credential).allowedRecipients,[]);
  assert.deepEqual(await session.caller.discoverRecipients({credential:session.grant.credential}),[]);
  await assert.rejects(send(session,oldWorker,2),{code:'recipient_not_allowed'});
  // Additions are not inherited either: the policy only grants what the owner authorized at setup.
  await assert.rejects(send(session,newWorker,3),{code:'recipient_not_allowed'});
  setupWorkspaceMessaging({config:f.configPath,workspace:f.workspace,'local-cli':f.wrapper});
  await f.restart([oldWorker]);
  session=await attach();
  assert.deepEqual(claimsOf(session.grant.credential).allowedRecipients,[newWorker]);
  assert.equal((await send(session,newWorker,4)).accepted,true);
  await assert.rejects(send(session,oldWorker,5),{code:'recipient_not_allowed'});
 }finally{await f.close();}
});

test('a replacement Codex sender does not inherit session messaging; a thread-only rebind keeps it',async()=>{
 const f=await fixture();try{
  const sid=randomUUID();await f.lifecycle(sid,'SessionStart');
  const child=await f.child(sid),address=(await tool(child,'triangle_get_status')).senderId;
  const policyPath=f.config.sessionMessaging.integrationPath,mcpPath=path.join(f.workspace,'.mcp.json');
  const base={config:f.configPath,'desktop-binding':f.bindingPath,recipients:['gravity2']};
  // Same sender, new thread: still the authorized sender, so participation stays.
  const rebound=setupLocalMessaging({...base,'thread-id':'attachment-test-thread-2',rebind:true});
  assert.equal(rebound.sessionMessagingDisabled,undefined);
  assert.equal(readPrivateJson(f.configPath).sessionMessaging.enabled,true);assert.equal(readPrivateJson(policyPath).enabled,true);
  assert.ok(JSON.parse(fs.readFileSync(mcpPath)).mcpServers['triangle-session']);
  // A replacement sender is not authorized by the old policy: participation is revoked, not inherited.
  const replacementBinding=path.join(f.root,'binding-2.json');writePrivateJson(replacementBinding,{instanceId:'b'.repeat(64)});
  const replaced=setupLocalMessaging({...base,'desktop-binding':replacementBinding,'thread-id':'attachment-test-thread-2'});
  assert.equal(replaced.sessionMessagingDisabled,true);assert.equal(replaced.mcpCleanupRequired,false);
  assert.equal('sessionMessaging' in readPrivateJson(f.configPath),false);
  assert.equal(readPrivateJson(policyPath).enabled,false);
  const mcp=JSON.parse(fs.readFileSync(mcpPath));assert.equal(mcp.mcpServers.unrelated.command,'preserve');assert.equal(mcp.mcpServers['triangle-session'],undefined);
  await assert.rejects(tool(child,'triangle_get_status'),/session_revoked/);
  await f.restart();
  const credential=await f.grant(),rows=await f.owner.listSessions({credential});
  assert.deepEqual(rows.filter(r=>r.id.startsWith('session-')),[]);
  await assert.rejects(f.owner.sendMessage({to:address,text:'inherited?',messageId:'inherit',requestId:'inherit'},{credential}),{code:'recipient_not_allowed'});
 }finally{await f.close();}
});

test('the session policy file never widens the live owner configuration',async()=>{
 const {root,configPath}=ownerFiles();let j;try{
  const config=readPrivateJson(configPath),policyPath=config.sessionMessaging.integrationPath,discoveryPath=config.discovery.integrationPath;
  const policy=readPrivateJson(policyPath),discovery=readPrivateJson(discoveryPath),owner=policy.allowedSenders[0],worker=policy.allowedRecipients[0];
  const stranger='c'.repeat(64),removed='d'.repeat(64);
  // A policy that also names another principal as a sender and a worker that is no longer configured.
  writePrivateJson(policyPath,{...policy,allowedSenders:[owner,stranger],allowedRecipients:[worker,removed]});
  j=createLocalMessagingJournal({stateRoot:config.stateRoot});
  const sid=randomUUID();
  await j.recordDiscoveryEvent({installationId:discovery.installationId,event:{eventId:randomUUID(),sessionId:sid,kind:'start',workspace:discovery.workspace,observedAt:Date.now()},digest:'policy-clamp',receivedAt:Date.now()});
  const issue=(senderId,options)=>JSON.stringify({senderId,...options});
  const attach=broker=>broker.attach({installationId:policy.installationId,secret:policy.secret,sessionId:sid,childId:randomUUID(),wakeCapable:true});
  assert.deepEqual(createWorkspaceSessionBroker({policyPath,discoveryPath,journal:j,issue}).allowedRecipients(),[worker,removed]);
  const live=createWorkspaceSessionBroker({policyPath,discoveryPath,journal:j,issue,ownerSenderId:owner,configuredRecipients:[worker]});
  assert.deepEqual(live.allowedRecipients(),[worker]);
  const grant=await attach(live);
  assert.deepEqual(JSON.parse(grant.credential).allowedRecipients,[worker]);
  await live.checkRecipient(owner,grant.senderId);
  await assert.rejects(live.checkRecipient(stranger,grant.senderId),{code:'recipient_not_allowed'});
  assert.deepEqual([await live.recipientIds(stranger),await live.recipientIds(owner)],[[],[grant.senderId]]);
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('every attached session has its own attach budget, so one chatty session cannot starve another',async()=>{
 const {root,configPath}=ownerFiles();let j;try{
  const config=readPrivateJson(configPath),policyPath=config.sessionMessaging.integrationPath,discoveryPath=config.discovery.integrationPath;
  const policy=readPrivateJson(policyPath),discovery=readPrivateJson(discoveryPath);
  j=createLocalMessagingJournal({stateRoot:config.stateRoot});
  const [a,b]=[randomUUID(),randomUUID()];
  for(const sessionId of [a,b])await j.recordDiscoveryEvent({installationId:discovery.installationId,event:{eventId:randomUUID(),sessionId,kind:'start',workspace:discovery.workspace,observedAt:Date.now()},digest:'budget-'+sessionId,receivedAt:Date.now()});
  const broker=createWorkspaceSessionBroker({policyPath,discoveryPath,journal:j,issue:(senderId,options)=>JSON.stringify({senderId,...options})});
  const tuple=sessionId=>({installationId:policy.installationId,secret:policy.secret,sessionId,childId:randomUUID(),wakeCapable:false});
  const chatty=tuple(a),quiet=tuple(b);
  // 240 attaches (tool calls plus heartbeats) fit in a minute; the next one from the same session is refused.
  for(let i=0;i<240;i++)await broker.attach(chatty);
  await assert.rejects(broker.attach(chatty),{code:'rate_limit_exceeded'});
  // Another session's budget is untouched: its heartbeats, tool-call attaches and its close still work.
  await broker.attach(quiet);await broker.attach(quiet);await broker.detach(quiet);
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('disable-discovery converges with a corrupt session policy and still removes the managed MCP entry',()=>{
 const {root,workspace,configPath}=ownerFiles();try{
  const policyPath=readPrivateJson(configPath).sessionMessaging.integrationPath;
  fs.writeFileSync(policyPath,'{ not json');fs.chmodSync(policyPath,0o600);
  assert.deepEqual(disableSessionDiscovery({config:configPath}),{discoveryEnabled:false,hooksCleanupRequired:false,mcpCleanupRequired:false});
  const after=readPrivateJson(configPath);assert.deepEqual(['discovery' in after,'sessionMessaging' in after],[false,false]);
  const mcp=JSON.parse(fs.readFileSync(path.join(workspace,'.mcp.json')));assert.equal(mcp.mcpServers.unrelated.command,'preserve');assert.equal(mcp.mcpServers['triangle-session'],undefined);
  // The damaged file cannot admit anyone, and running the disable again converges as well.
  assert.equal(disableSessionDiscovery({config:configPath}).discoveryEnabled,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('disable-discovery reports a managed MCP entry it could not remove',()=>{
 const {root,workspace,configPath}=ownerFiles();try{
  const mcp=path.join(workspace,'.mcp.json');fs.linkSync(mcp,mcp+'.hardlink'); // a hard-linked settings file is never rewritten
  const result=disableSessionDiscovery({config:configPath});
  assert.deepEqual([result.discoveryEnabled,result.mcpCleanupRequired],[false,true]);
  assert.ok(JSON.parse(fs.readFileSync(mcp)).mcpServers['triangle-session'],'the entry stays in place, and is flagged rather than forgotten');
  assert.equal('sessionMessaging' in readPrivateJson(configPath),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('disable-session-messaging needs no cleanup when it was never enabled',()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-attach-');try{
  const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');writePrivateJson(bindingPath,{instanceId:'a'.repeat(64)});
  setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'attachment-test-thread',recipients:['gravity2']});
  assert.deepEqual(disableWorkspaceMessaging({config:configPath}),{sessionMessagingEnabled:false,mcpCleanupRequired:false});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
