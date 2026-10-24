import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import net from 'node:net';
import {createRequire} from 'node:module';
import {Readable,PassThrough} from 'node:stream';
import {encodeFrame,createMessageParser,createSuccessResponse,createErrorResponse} from '../src/local-messaging-protocol.mjs';
import {setupLocalMessaging,setupSessionDiscovery,setupWorkspaceMessaging,disableWorkspaceMessaging,disableSessionDiscovery,runSessionDiscoveryHook,runLocalMessagingCLI} from '../src/local-messaging-cli.mjs';
import {readPrivateJson,writePrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {createInstalledLocalMessagingHost} from '../src/local-messaging-host.mjs';
import {createProfiledReasonerGate} from '../src/concurrency-gate.mjs';
import {createLocalControlClient} from '../src/local-messaging-client.mjs';
import {resolveLocalSocketAddress} from '../src/local-messaging-address.mjs';
import {createAttachedClaudeSessionMcpChild} from '../src/claude-session-mcp-child.mjs';
import {createLocalMessagingJournal} from '../src/local-messaging-journal.mjs';
import {createWorkspaceSessionBroker,sessionAddress,attachedSessionIdentity,UUID_PATTERN} from '../src/local-messaging-interactive-session.mjs';
import {SUPPORTED_CLAUDE_VERSION} from '../src/claude-session-delivery.mjs';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
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
 const config=readPrivateJson(configPath);let desktop=readPrivateJson(config.integrationPath),host;const clients=[],children=[],runs=[],logs=[];
 // Runners follow the owner config as it is now; extra ids model a supervisor that still holds a runner for a removed profile.
 // `runs` records what workers were asked to do, `logs` what the host warned about.
 const start=async(extraRunnerIds=[])=>{const runner={run:async request=>{runs.push(request);return {status:'completed',text:'worker result'};}};
  host=createInstalledLocalMessagingHost({configPath,runners:new Map([...readPrivateJson(configPath).recipients.map(r=>r.instanceId),...extraRunnerIds].map(id=>[id,runner])),gate:createProfiledReasonerGate(),
   logger:{info(){},error(){},warn:message=>logs.push(message)}});await host.start();};await start();
 const client=(senderId)=>{const c=createLocalControlClient({socketPath:resolveLocalSocketAddress({stateRoot:config.stateRoot}).socketPath,senderId});clients.push(c);return c;};
 let owner=client(desktop.senderId);
 const grant=async()=> (await owner.exchangeTurnBinding({bindingId:desktop.bindingId,threadId:desktop.threadId,secret:desktop.secret})).credential;
 const lifecycle=async(sessionId,kind)=>runSessionDiscoveryHook({configPath,input:Readable.from([JSON.stringify({session_id:sessionId,cwd:workspace,hook_event_name:kind})]),stderr:{write(){}}});
 const child=async(sessionId,extra={})=>{const c=await createAttachedClaudeSessionMcpChild({configPath,cwd:workspace,policyPath:config.sessionMessaging.integrationPath,expectedVersion:'2.1.307',env:{CLAUDE_CODE_SESSION_ID:sessionId},wakeIntervalMs:0,...extra});children.push(c);return c;};
 return {root,workspace,wrapper,bindingPath,configPath,config,runs,logs,client,get owner(){return owner;},get desktop(){return desktop;},grant,lifecycle,child,
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
   await assert.rejects(tool(children[1-i],'triangle_claim_message',{messageId:'task-'+i,claimId:'foreign-'+i}),/foreign_access_denied/);
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
  await assert.rejects(tool(child,'triangle_get_status'),/workspace_missing/);
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

// Polls with real timers and a bounded count (never the clock, which some tests freeze).
const eventually=async(check,what)=>{for(let i=0;i<150;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('timed out waiting for '+what);};

test('the heartbeat keeps a session reachable past the lease without any tool call, and closing the child ends it',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()}); // freezes the lease clock only; real timers still drive the heartbeat
 const f=await fixture();try{
  const [beating,silent]=[randomUUID(),randomUUID()];for(const id of [beating,silent])await f.lifecycle(id,'SessionStart');
  const policy=readPrivateJson(f.config.sessionMessaging.integrationPath);
  const addressOf=sessionId=>'session-'+createHash('sha256').update(policy.installationId+'\0'+policy.workspace+'\0'+sessionId).digest('hex');
  const reachable=async()=>(await f.owner.listSessions({credential:await f.grant()})).filter(r=>r.id.startsWith('session-')&&r.capabilities?.reachable).map(r=>r.id).sort();
  const settle=()=>new Promise(resolve=>setTimeout(resolve,150)); // several 25ms heartbeats
  // One child only heartbeats (every 25ms, no tool call ever); the other attaches once through a tool call and then stays silent.
  const heart=await f.child(beating,{wakeIntervalMs:25,input:new PassThrough(),output:new PassThrough()}),running=heart.run();
  await tool(await f.child(silent),'triangle_get_status');
  await eventually(async()=>(await reachable()).length===2,'both sessions to become reachable');
  // Three 20s steps are 60s on the lease clock, twice the 30s lease: only the heartbeat renews it.
  for(let step=0;step<3;step++){t.mock.timers.tick(20000);await settle();}
  await eventually(async()=>(await reachable()).includes(addressOf(beating)),'the heartbeat to renew the lease');
  assert.deepEqual(await reachable(),[addressOf(beating)]);
  await heart.close();await running;
  assert.deepEqual(await reachable(),[]);
 }finally{await f.close();}
});

test('an attached session may send to a configured worker, and to nothing else',async()=>{
 const f=await fixture();try{
  const worker=f.config.recipients[0].instanceId,[a,b]=[randomUUID(),randomUUID()];for(const id of [a,b])await f.lifecycle(id,'SessionStart');
  const [childA,childB]=await Promise.all([a,b].map(id=>f.child(id)));
  const [addressA,addressB]=await Promise.all([childA,childB].map(async child=>(await tool(child,'triangle_get_status')).senderId));
  const send=(to,n)=>tool(childA,'triangle_send_message',{to,text:'ping '+n,messageId:'out-'+n,requestId:'out-'+n});
  // The configured worker accepts the request and sees the attached session as its sender.
  assert.equal((await send(worker,1)).accepted,true);
  await eventually(()=>f.runs.length===1,'the worker to run');
  assert.deepEqual([f.runs[0].senderId,f.runs[0].text],[addressA,'ping 1']);
  // Another reachable session, itself, the Codex owner and an unknown recipient are all refused by the ACL.
  for(const [n,to] of [[2,addressB],[3,addressA],[4,f.desktop.senderId],[5,'e'.repeat(64)]])await assert.rejects(send(to,n),/recipient_not_allowed/);
  assert.deepEqual((await tool(childB,'triangle_list_inbox')).items,[]);
  assert.equal(f.runs.length,1);
 }finally{await f.close();}
});

test('triangle-local send reaches a reachable attached session and refuses addresses that are not',async()=>{
 const f=await fixture();try{
  const sid=randomUUID();await f.lifecycle(sid,'SessionStart');
  const child=await f.child(sid),address=(await tool(child,'triangle_get_status')).senderId;
  const send=async to=>{const out=[];const code=await runLocalMessagingCLI(['send','--config',f.configPath,'--to',to,'--text','from the CLI'],{output:{write:chunk=>out.push(chunk)}});return {code,result:JSON.parse(out.join(''))};};
  const sent=await send(address);
  assert.equal(sent.code,0);assert.equal(sent.result.admission.accepted,true);
  assert.equal((await tool(child,'triangle_list_inbox')).items[0].messageId,sent.result.admission.messageId);
  // A well-formed address nobody holds, a malformed one, and an address whose child has gone away are refused up front.
  await assert.rejects(send('session-'+'0'.repeat(64)),{code:'recipient_not_allowed'});
  await assert.rejects(send('session-not-an-address'),{code:'recipient_not_allowed'});
  await child.close();
  await assert.rejects(send(address),{code:'recipient_not_allowed'});
 }finally{await f.close();}
});

test('swallowed broker failures are logged once per failure and again after recovery, with codes only',async()=>{
 const {root,configPath}=ownerFiles();let j;try{
  const config=readPrivateJson(configPath),policyPath=config.sessionMessaging.integrationPath,discoveryPath=config.discovery.integrationPath;
  const good=fs.readFileSync(policyPath,'utf8'),owner=JSON.parse(good).allowedSenders[0],real=JSON.parse(good).workspace;
  j=createLocalMessagingJournal({stateRoot:config.stateRoot});
  const warnings=[];
  const broker=createWorkspaceSessionBroker({policyPath,discoveryPath,journal:j,issue(){},logger:{warn:message=>warnings.push(message)}});
  const probe=async()=>[await broker.listFor(owner),broker.allowedRecipients().length];
  const unavailable=code=>`Workspace session messaging unavailable (${code}); configured recipients remain available`;
  assert.deepEqual(await probe(),[[],1]);assert.deepEqual(warnings,[]);
  // A damaged policy hides everything and says why, once, however often it is asked.
  fs.writeFileSync(policyPath,'{ not json');
  assert.deepEqual(await probe(),[[],0]);await probe();
  assert.deepEqual(warnings,[unavailable('invalid_private_file')]);
  // Recovery is silent; a different failure is reported on its own; the first one is reported again after a recovery.
  fs.writeFileSync(policyPath,good);
  assert.deepEqual(await probe(),[[],1]);
  fs.renameSync(real,real+'-moved');await probe();
  assert.deepEqual(warnings,[unavailable('invalid_private_file'),unavailable('workspace_missing')]);
  fs.renameSync(real+'-moved',real);
  assert.deepEqual(await probe(),[[],1]);
  fs.writeFileSync(policyPath,'{ not json');await probe();
  assert.deepEqual(warnings.slice(2),[unavailable('invalid_private_file')]);
  assert.ok(warnings.every(message=>!/not json|tri-attach|secret|[a-f0-9]{64}/.test(message)),'codes only: no contents, paths or identifiers');
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('the host hands its logger to the session broker, so a damaged policy is reported once',async()=>{
 const f=await fixture();try{
  fs.writeFileSync(f.config.sessionMessaging.integrationPath,'{ not json');
  for(let i=0;i<2;i++)await f.owner.listSessions({credential:await f.grant()});
  assert.deepEqual(f.logs.filter(message=>/session messaging/i.test(message)),['Workspace session messaging unavailable (invalid_private_file); configured recipients remain available']);
 }finally{await f.close();}
});

test('a session has one address: discovery, the broker and the MCP child agree on it, and it is pinned',async()=>{
 // Known answer: changing the derivation would silently orphan every stored address, lease and wake binding.
 const [installation,workspace,session]=['11111111-1111-4111-8111-111111111111','/private/tmp/example-workspace','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
 assert.equal(sessionAddress(installation,workspace,session),'session-0cb12e86aa3fd9e5ef02a9b8e8bda7af11ab31592992b1f9b40b0187d8eec5e6');
 assert.equal(sessionAddress(installation,workspace,session.toUpperCase()),sessionAddress(installation,workspace,session));
 assert.notEqual(sessionAddress(installation,workspace+'-other',session),sessionAddress(installation,workspace,session));
 const f=await fixture();try{
  const sid=randomUUID(),policy=readPrivateJson(f.config.sessionMessaging.integrationPath),expected=sessionAddress(policy.installationId,policy.workspace,sid);
  await f.lifecycle(sid,'SessionStart');
  // The journal's discovery row, the broker's grant and the child's own pin are three independent derivations.
  const discovered=(await f.owner.listSessions({credential:await f.grant()})).filter(r=>r.id.startsWith('session-')).map(r=>r.id);
  const attached=(await tool(await f.child(sid),'triangle_get_status')).senderId;
  assert.deepEqual(discovered,[expected]);assert.equal(attached,expected);
 }finally{await f.close();}
});

test('the pseudonymous session identity depends on the session id alone',()=>{
 const sid=randomUUID(),identity=attachedSessionIdentity(sid);
 assert.deepEqual(Object.keys(identity),['pseudoSessionId']);
 assert.match(identity.pseudoSessionId,UUID_PATTERN);
 assert.equal(attachedSessionIdentity(sid.toUpperCase()).pseudoSessionId,identity.pseudoSessionId);
 assert.notEqual(attachedSessionIdentity(randomUUID()).pseudoSessionId,identity.pseudoSessionId);
 assert.notEqual(identity.pseudoSessionId,sid,'the raw harness id is never what gets stored');
});

// A stand-in supervisor socket that answers attach and detach the way the real one does, so an attached child can
// run against it, and hands every other request to `handle`. `observe` sees every message first; `onAttach` may stall.
async function standInSupervisor(config,sessionId,{observe=()=>{},onAttach=async()=>{},handle=async()=>({})}={}){
 const policy=readPrivateJson(config.sessionMessaging.integrationPath);let attaches=0;
 const server=net.createServer(socket=>{
  const parser=createMessageParser({onError:()=>socket.destroy(),onMessage:async message=>{
   try{
    observe(message);
    let result;
    if(message.method==='attach_session'){
     await onAttach(message);
     result={senderId:sessionAddress(policy.installationId,policy.workspace,sessionId),sessionId:attachedSessionIdentity(sessionId).pseudoSessionId,generation:1,bindingId:message.params.childId,credential:'grant-'+(++attaches)};
    }else if(message.method==='detach_session')result={detached:true};
    else result=await handle(message);
    socket.write(encodeFrame(createSuccessResponse(message.id,result)));
   }catch(error){socket.write(encodeFrame(createErrorResponse(message.id,error)));}
  }});
  socket.on('data',chunk=>parser.feed(chunk));socket.on('error',()=>{});
 });
 await new Promise(resolve=>server.listen(resolveLocalSocketAddress({stateRoot:config.stateRoot}).socketPath,resolve));
 return {get attaches(){return attaches;},close:()=>new Promise(resolve=>server.close(resolve))};
}

test('close() waits for an in-flight heartbeat before it detaches, so the detach is the last word on the lease',async()=>{
 const {root,workspace,configPath}=ownerFiles();let supervisor,child;try{
  const config=readPrivateJson(configPath),sid=randomUUID(),events=[];
  // The attach answers slowly, so a heartbeat is still in flight when the child closes.
  supervisor=await standInSupervisor(config,sid,{
   observe:message=>events.push(message.method+' received'),
   onAttach:async()=>{await new Promise(resolve=>setTimeout(resolve,150));events.push('attach_session answered');},
  });
  child=await createAttachedClaudeSessionMcpChild({configPath,cwd:workspace,policyPath:config.sessionMessaging.integrationPath,expectedVersion:'2.1.307',env:{CLAUDE_CODE_SESSION_ID:sid},input:new PassThrough(),output:new PassThrough(),wakeIntervalMs:20});
  const running=child.run();
  await eventually(()=>events.includes('attach_session received'),'the first heartbeat to arrive');
  await child.close();await running;
  // A heartbeat answered after the detach would have renewed the lease the close had just released.
  assert.deepEqual(events.slice(0,3),['attach_session received','attach_session answered','detach_session received']);
 }finally{await child?.close();await supervisor?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('the managed MCP entry pins the supported Claude version instead of a copy of it',()=>{
 const {root,workspace}=ownerFiles();try{
  const args=JSON.parse(fs.readFileSync(path.join(workspace,'.mcp.json'))).mcpServers['triangle-session'].args;
  assert.equal(args[args.indexOf('--expected-version')+1],SUPPORTED_CLAUDE_VERSION);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('workspace files are replaced atomically and flushed first: a failed flush keeps the old file and leaves no debris',t=>{
 const {root,workspace,configPath,wrapper}=ownerFiles();try{
  const mcp=path.join(workspace,'.mcp.json'),settings=path.join(workspace,'.claude','settings.local.json');
  const before=[mcp,settings].map(file=>fs.readFileSync(file,'utf8'));
  // Fail the flush of exactly the replacement temp files; everything else (policy and config writes included) behaves normally.
  const opened=new Map(),flushed=[],realOpen=fs.openSync,realFsync=fs.fsyncSync;
  t.mock.method(fs,'openSync',(file,...rest)=>{const fd=realOpen(file,...rest);opened.set(fd,String(file));return fd;});
  t.mock.method(fs,'fsyncSync',fd=>{const file=opened.get(fd)??'';flushed.push(path.basename(file));
   if(/(mcp\.json|settings\.local\.json)\.triangle-/.test(file))throw Object.assign(new Error('no space left on device'),{code:'ENOSPC'});return realFsync(fd);});
  // Disabling reports the managed entry it could not rewrite, and the file is exactly as it was.
  assert.equal(disableWorkspaceMessaging({config:configPath}).mcpCleanupRequired,true);
  assert.equal(fs.readFileSync(mcp,'utf8'),before[0]);
  // Setting the entry up again fails loudly instead of leaving a half-written file.
  assert.throws(()=>setupWorkspaceMessaging({config:configPath,workspace,'local-cli':wrapper}),{code:'ENOSPC'});
  assert.equal(fs.readFileSync(mcp,'utf8'),before[0]);
  // The Claude hook settings take the same path.
  assert.equal(disableSessionDiscovery({config:configPath}).hooksCleanupRequired,true);
  assert.equal(fs.readFileSync(settings,'utf8'),before[1]);
  assert.ok(flushed.some(name=>/^\.mcp\.json\.triangle-/.test(name))&&flushed.some(name=>/^settings\.local\.json\.triangle-/.test(name)),'each replacement is flushed before it is renamed into place');
  for(const directory of [workspace,path.dirname(settings)])assert.deepEqual(fs.readdirSync(directory).filter(name=>/\.triangle-/.test(name)),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('listing and looking up sessions costs the same few reads however many sessions there are',async t=>{
 const {root,configPath}=ownerFiles();let j;try{
  const config=readPrivateJson(configPath),policyPath=config.sessionMessaging.integrationPath,discoveryPath=config.discovery.integrationPath;
  const policy=readPrivateJson(policyPath),discovery=readPrivateJson(discoveryPath),owner=policy.allowedSenders[0];
  j=createLocalMessagingJournal({stateRoot:config.stateRoot});
  const calls={};
  const counted=new Proxy(j,{get:(target,name)=>typeof target[name]==='function'?(...args)=>{calls[name]=(calls[name]??0)+1;return target[name](...args);}:target[name]});
  const broker=createWorkspaceSessionBroker({policyPath,discoveryPath,journal:counted,issue:(senderId,options)=>JSON.stringify({senderId,...options})});
  const tuple=sessionId=>({installationId:policy.installationId,secret:policy.secret,sessionId,childId:randomUUID(),wakeCapable:false});
  const ids=Array.from({length:40},()=>randomUUID()),tuples=ids.map(tuple);
  for(const [index,sessionId] of ids.entries()){
   await j.recordDiscoveryEvent({installationId:discovery.installationId,event:{eventId:randomUUID(),sessionId,kind:'start',workspace:discovery.workspace,observedAt:Date.now()},digest:'cost-'+index,receivedAt:Date.now()});
   await broker.attach(tuples[index]);
  }
  // Count the opens of the two owner files and the journal calls made by one operation.
  let opens=0;const realOpen=fs.openSync;
  t.mock.method(fs,'openSync',(file,...rest)=>{if(file===policyPath||file===discoveryPath)opens++;return realOpen(file,...rest);});
  const measure=async operation=>{opens=0;for(const name of Object.keys(calls))delete calls[name];const result=await operation();return {result,opens,calls:{...calls}};};
  const address=sessionAddress(policy.installationId,policy.workspace,ids[7]);
  // All 40 sessions listed: the policy and the discovery file once each, one directory listing, one attachment listing.
  const listing=await measure(()=>broker.listFor(owner));
  assert.equal(listing.result.filter(row=>row.capabilities.reachable).length,40);
  assert.equal(listing.opens,2);assert.deepEqual(listing.calls,{listDiscoveredSessions:1,listSessionAttachments:1});
  // One session checked: the same two reads and two primary-key lookups, not a scan.
  const lookup=await measure(()=>broker.checkRecipient(owner,address));
  assert.equal(lookup.opens,2);assert.deepEqual(lookup.calls,{getDiscoveredSession:1,getSessionAttachment:1});
  // A renewal reads the owner files once, not twice.
  const renewal=await measure(()=>broker.attach(tuples[7]));
  assert.equal(renewal.opens,2);assert.deepEqual(renewal.calls,{getDiscoveredSession:1,attachDiscoveredSession:1,bindAttachedSessionWake:1});
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('tool calls reuse the latest attach grant, and a grant that a supervisor restart outdated is replaced once',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const {root,workspace,configPath}=ownerFiles();let supervisor,child;try{
  const config=readPrivateJson(configPath),policyPath=config.sessionMessaging.integrationPath,sid=randomUUID(),presented=[];
  let refuse=null; // which presented credentials the supervisor currently refuses, as it would after a restart re-keyed them
  supervisor=await standInSupervisor(config,sid,{handle:async message=>{
   presented.push(message.credential);
   if(refuse?.(message.credential))throw Object.assign(new Error('Turn credential signature verification failed'),{code:'unauthorized'});
   return {credential:message.credential};
  }});
  child=await createAttachedClaudeSessionMcpChild({configPath,cwd:workspace,policyPath,expectedVersion:'2.1.307',env:{CLAUDE_CODE_SESSION_ID:sid},input:new PassThrough(),output:new PassThrough(),wakeIntervalMs:0});
  const status=async()=>(await tool(child,'triangle_get_status')).credential;
  // Calls reuse the grant of the one attach instead of attaching each time.
  assert.deepEqual([await status(),await status(),await status()],['grant-1','grant-1','grant-1']);assert.equal(supervisor.attaches,1);
  // A restart re-keys credentials: the refused call is replaced by one fresh attach and retried.
  refuse=credential=>credential==='grant-1';
  assert.equal(await status(),'grant-2');assert.equal(supervisor.attaches,2);
  refuse=null;assert.equal(await status(),'grant-2');
  // A refusal that persists is retried once, not forever, and then reaches the caller.
  presented.length=0;refuse=()=>true;
  await assert.rejects(status(),/unauthorized/);
  assert.equal(supervisor.attaches,3);assert.deepEqual(presented,['grant-2','grant-3']);
  refuse=null;
  // A grant older than half its life is not reused.
  t.mock.timers.tick(16000);
  assert.equal(await status(),'grant-4');
  // Reuse never outlives a revocation: the policy is checked on every call before any grant is considered.
  presented.length=0;writePrivateJson(policyPath,{...readPrivateJson(policyPath),secret:'f'.repeat(64)});
  await assert.rejects(status(),/session_revoked/);assert.deepEqual(presented,[]);
 }finally{await child?.close();await supervisor?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('the heartbeat attaches on every tick, even while the latest grant is still fresh enough for tool calls to reuse',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()}); // frozen: no grant ever ages, so only the heartbeat can cause an attach
 const {root,workspace,configPath}=ownerFiles();let supervisor,child;try{
  const config=readPrivateJson(configPath),sid=randomUUID();
  supervisor=await standInSupervisor(config,sid);
  child=await createAttachedClaudeSessionMcpChild({configPath,cwd:workspace,policyPath:config.sessionMessaging.integrationPath,expectedVersion:'2.1.307',env:{CLAUDE_CODE_SESSION_ID:sid},input:new PassThrough(),output:new PassThrough(),wakeIntervalMs:20});
  const running=child.run();
  await eventually(()=>supervisor.attaches>=4,'the heartbeat to attach again and again');
  await child.close();await running;
 }finally{await child?.close();await supervisor?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('custody, wake binding and wake history go when their discovery row ages out, and only then',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-prune-');let j,inspect;try{
  j=createLocalMessagingJournal({stateRoot:root});
  inspect=new DatabaseSync(path.join(root,'local-messaging.sqlite'),{readOnly:true});
  const installationId=randomUUID(),workspace='/private/tmp/tri-prune-workspace',day=24*60*60*1000,t0=Date.UTC(2026,0,1);
  const event=(sessionId,at,kind='start')=>j.recordDiscoveryEvent({installationId,event:{eventId:randomUUID(),sessionId,kind,workspace,observedAt:at},digest:randomUUID(),receivedAt:at});
  // A session with everything a live attach leaves behind: a custody lease, a wake binding and one wake in the history.
  const adopt=async(sessionId,at)=>{
   const id=sessionAddress(installationId,workspace,sessionId),pseudo=attachedSessionIdentity(sessionId).pseudoSessionId,childId=randomUUID();
   const {generation}=await event(sessionId,at);
   await j.attachDiscoveredSession({id,childId,generation,installationId:'scope',wakeCapable:true,now:at});
   await j.bindAttachedSessionWake({senderId:id,sessionId:pseudo,generation,bindingId:childId});
   await j.recordSend({sender:'a'.repeat(64),recipient:id,recipientType:'interactive',messageId:'prune-'+sessionId,requestId:'prune-'+sessionId,text:'task',metadata:{}});
   assert.equal((await j.reserveInteractiveWake({targetIdentity:id,reservationId:randomUUID(),sessionId:pseudo,generation,bindingId:childId,now:at})).deliveryAllowed,true);
   return id;
  };
  const counts=()=>Object.fromEntries(['local_session_attachments','local_wake_bindings','local_interactive_wake_history'].map(table=>[table,inspect.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  const legacy='f'.repeat(64);await j.initInteractiveWakeBinding({senderId:legacy,sessionId:randomUUID(),generation:1,bindingId:randomUUID()});
  const addressA=await adopt(randomUUID(),t0),addressB=await adopt(randomUUID(),t0+5*day);
  assert.deepEqual(counts(),{local_session_attachments:2,local_wake_bindings:3,local_interactive_wake_history:2});
  // Nine days on, A has aged out of the directory (eight days of retention) and B has not.
  await event(randomUUID(),t0+9*day);
  assert.equal(await j.getSessionAttachment(addressA),null);assert.equal(await j.getWakeBinding(addressA),null);
  assert.ok(await j.getSessionAttachment(addressB));assert.ok(await j.getWakeBinding(addressB));
  assert.ok(await j.getWakeBinding(legacy),'a legacy binding is not session state');
  assert.deepEqual(counts(),{local_session_attachments:1,local_wake_bindings:2,local_interactive_wake_history:1});
  // State orphaned some other way (an older build, a restored file) is collected by the periodic compaction.
  const orphan='session-'+'9'.repeat(64);
  await j.attachDiscoveredSession({id:orphan,childId:randomUUID(),generation:1,installationId:'scope',wakeCapable:false,now:t0});
  await j.bindAttachedSessionWake({senderId:orphan,sessionId:randomUUID(),generation:1,bindingId:randomUUID()});
  assert.deepEqual(counts(),{local_session_attachments:2,local_wake_bindings:3,local_interactive_wake_history:1});
  await j.compact({now:t0+9*day});
  assert.deepEqual(counts(),{local_session_attachments:1,local_wake_bindings:2,local_interactive_wake_history:1});
 }finally{inspect?.close();await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('evicting an ended session from a full directory takes its custody and wake state with it',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-evict-');let j,inspect;try{
  j=createLocalMessagingJournal({stateRoot:root});
  inspect=new DatabaseSync(path.join(root,'local-messaging.sqlite'),{readOnly:true});
  const installationId=randomUUID(),workspace='/private/tmp/tri-evict-workspace',t0=Date.UTC(2026,0,1);
  const event=(sessionId,at,kind='start')=>j.recordDiscoveryEvent({installationId,event:{eventId:randomUUID(),sessionId,kind,workspace,observedAt:at},digest:randomUUID(),receivedAt:at});
  const counts=()=>Object.fromEntries(['local_session_attachments','local_wake_bindings'].map(table=>[table,inspect.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  const sessions=Array.from({length:128},()=>randomUUID()),addresses=[];
  for(const [index,sessionId] of sessions.entries()){
   const id=sessionAddress(installationId,workspace,sessionId),at=t0+index*1000,{generation}=await event(sessionId,at),childId=randomUUID();
   await j.attachDiscoveredSession({id,childId,generation,installationId:'scope',wakeCapable:false,now:at});
   await j.bindAttachedSessionWake({senderId:id,sessionId:attachedSessionIdentity(sessionId).pseudoSessionId,generation,bindingId:childId});
   await event(sessionId,at+500,'end');addresses.push(id);
  }
  assert.deepEqual(counts(),{local_session_attachments:128,local_wake_bindings:128});
  // A 129th session needs room: the oldest ended one is evicted and its state goes with its discovery row.
  await event(randomUUID(),t0+200000);
  assert.deepEqual(counts(),{local_session_attachments:127,local_wake_bindings:127});
  assert.equal(await j.getSessionAttachment(addresses[0]),null);assert.ok(await j.getSessionAttachment(addresses[1]));
 }finally{inspect?.close();await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});
