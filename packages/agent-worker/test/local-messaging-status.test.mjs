import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {describeMessageDelivery,describeRecipientDelivery,createLocalControlServer} from '../src/local-messaging-server.mjs';
import {createLocalMessagingJournal} from '../src/local-messaging-journal.mjs';
import {createLocalControlClient} from '../src/local-messaging-client.mjs';
import {createTurnCapabilityIssuer,createTurnCapabilityValidator} from '../src/local-messaging-credentials.mjs';

const queued={messageId:'status-canary',phase:'queued_local',recipientType:'interactive'};
test('status never treats a notification as execution or infers an approval prompt',()=>{
 const unknown=describeMessageDelivery(queued);assert.equal(unknown.state,'queued');
 const accepted=describeMessageDelivery(queued,{notification:'accepted'});
 assert.equal(accepted.state,'notified_unclaimed');assert.equal(accepted.approval,'unknown');assert.match(accepted.summary,/not been claimed/);
 assert.equal(describeMessageDelivery(queued,{notification:'acknowledged'}).state,'notified_unclaimed');
 assert.equal(describeMessageDelivery(queued,{recipientAvailable:false,notification:'accepted'}).state,'waiting_for_recipient');
 assert.equal(describeMessageDelivery(queued,{pullOnly:true}).state,'waiting_for_poll');
});
test('held and expired claims require reconciliation while raw execution phase remains untouched',()=>{
 const held={...queued,phase:'held',hasLateResult:true};assert.match(describeMessageDelivery(held).nextAction,/reconcile/);assert.match(describeMessageDelivery(held).summary,/late result/);
 const executing={...queued,phase:'executing',leaseExpiresAt:100};assert.equal(describeMessageDelivery(executing,{now:101}).state,'lease_expired');assert.equal(executing.phase,'executing');
 assert.equal(describeMessageDelivery({...executing,leaseExpiresAt:200},{now:101}).state,'executing');
 assert.equal(describeMessageDelivery({...queued,phase:'completed'}).state,'completed');
 const failed=describeMessageDelivery({...queued,phase:'reply_failed',runtimeError:'SECRET_TOKEN'});assert.equal(failed.state,'failed');assert.equal(JSON.stringify(failed).includes('SECRET_TOKEN'),false);
 assert.equal(describeMessageDelivery({...queued,phase:'future_version'}).state,'unknown');
});
test('recipient descriptions separate discovery, attachment and pull-only delivery',()=>{
 assert.equal(describeRecipientDelivery({capabilities:{visible:true,reachable:false}}).state,'visible_only');
 assert.equal(describeRecipientDelivery({attachment:'not-attached',capabilities:{visible:true,reachable:false}}).state,'not_attached');
 assert.equal(describeRecipientDelivery({attachment:'ended',capabilities:{visible:true}}).state,'session_ended');
 assert.equal(describeRecipientDelivery({capabilities:{reachable:true}}).state,'ready_to_queue');
 assert.equal(describeRecipientDelivery({capabilities:{queueable:true,pullInbox:true,wakeCapable:false}}).state,'pull_only');
 assert.equal(describeRecipientDelivery({kind:'worker'}).state,'availability_unknown');
});
test('wake evidence matches the exact queued request rather than an unrelated or older wake',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-status-');let j;
 try{
  j=createLocalMessagingJournal({stateRoot:root});const recipient='recipient',sender='sender';
  await j.initWakeBinding({targetIdentity:recipient,threadId:'claude-session:test'});
  await j.recordSend({sender,recipient,messageId:'one',requestId:'one',text:'data',recipientType:'interactive'});
  const obligations=await j.getWakeObligations(recipient,{isInteractive:true});
  await j.recordSend({sender,recipient,messageId:'two',requestId:'two',text:'data',recipientType:'interactive'});
  const wakeId=randomUUID();await j.setWakeSubmitting({targetIdentity:recipient,wakeId,fingerprint:obligations.snapshotFingerprint});
  assert.equal(await j.getMessageWakeEvidence('one'),'unknown','submission alone is not acceptance');
  await j.setWakeAccepted({targetIdentity:recipient,wakeId,receipt:{queuedId:randomUUID(),threadId:randomUUID()}});
  assert.equal(await j.getMessageWakeEvidence('one'),'accepted');assert.equal(await j.getMessageWakeEvidence('two'),'unknown');
  await j.ackWake({requester:recipient,wakeId,generation:1});assert.equal(await j.getMessageWakeEvidence('one'),'acknowledged');assert.equal(await j.getMessageWakeEvidence('two'),'unknown');
  assert.equal(await j.getMessageWakeEvidence('missing'),'unknown');
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('wire status exposes only safe delivery hints after requester authorization',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-status-wire-');let j,server;const clients=[];
 try{
  j=createLocalMessagingJournal({stateRoot:root});const socketPath=root+'/control.sock',secret='test-status-secret-12345678901234567890';
  const issuer=createTurnCapabilityIssuer({secret}),validator=createTurnCapabilityValidator({secret});
  const recipient='session-'+'b'.repeat(64),sender='sender';
  const row=await j.recordSend({sender,recipient,messageId:'wire',requestId:'wire',text:'PRIVATE_BODY',recipientType:'interactive'});
  await j.initWakeBinding({targetIdentity:recipient,threadId:'claude-session:test'});
  const obligations=await j.getWakeObligations(recipient,{isInteractive:true}),wakeId=randomUUID();await j.setWakeSubmitting({targetIdentity:recipient,wakeId,fingerprint:obligations.snapshotFingerprint});await j.setWakeAccepted({targetIdentity:recipient,wakeId,receipt:{queuedId:randomUUID(),threadId:randomUUID()}});
  let observationReads=0,available=true;
  server=createLocalControlServer({socketPath,journal:j,acl:{checkAllowed(){},listAuthorizedRecipients(){return[];}},credentialValidator:validator,dispatcher:{start:async()=>{},stop:async()=>{},notifyAdmission:async()=>{}},recipientDirectory:[{id:'grok-recipient',label:'Grok test',kind:'conversation',harness:'grok'}],sessionBroker:{describeLocalSession:async()=>{observationReads++;if(!available)throw Object.assign(new Error('unavailable'),{code:'session_offline'});return{};}}});await server.start();
  const client=id=>{const c=createLocalControlClient({socketPath,senderId:id,turnCredential:issuer.issue({senderId:id})});clients.push(c);return c;};
  const status=await client(sender).getMessageStatus({messageId:'wire'});assert.equal(status.phase,row.phase);assert.equal(status.delivery.state,'notified_unclaimed');assert.equal(status.delivery.approval,'unknown');
  assert.equal(JSON.stringify(status).includes('PRIVATE_BODY'),false);assert.equal(JSON.stringify(status).includes(wakeId),false);
  const before=observationReads;await assert.rejects(client('foreign').getMessageStatus({messageId:'wire'}),{code:'foreign_access_denied'});assert.equal(observationReads,before,'unauthorized callers cannot probe delivery observations');
  available=false;assert.equal((await client(sender).getMessageStatus({messageId:'wire'})).delivery.state,'waiting_for_recipient');available=true;
  await j.recordSend({sender,recipient:'grok-recipient',messageId:'pull',requestId:'pull',text:'data',recipientType:'interactive'});
  assert.equal((await client(sender).getMessageStatus({messageId:'pull'})).delivery.state,'waiting_for_poll');
  await j.claimInboxMessage({messageId:'wire',requester:recipient,sessionId:randomUUID(),generation:1,claimId:'claim-wire',now:Date.now()-2000,leaseDurationMs:1000});
  const expired=await client(sender).getMessageStatus({messageId:'wire'});assert.equal(expired.phase,'executing');assert.equal(expired.delivery.state,'lease_expired');
  assert.equal((await j.getRecord('wire')).phase,'executing','status does not mutate expired claims');
  assert.equal(await j.getMessageWakeEvidence('wire'),'unknown','a claimed request is not presented as merely notified');
 }finally{for(const c of clients)await c.close();await server?.close();await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('optional directory explanations cannot overflow a previously valid metadata response',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-status-size-');let j,server,client;
 try{
  j=createLocalMessagingJournal({stateRoot:root});const secret='status-size-secret-1234567890123456789',socketPath=root+'/control.sock';
  const configured=Array.from({length:256},(_,i)=>({id:('r'+i).padEnd(256,'x'),label:'l'.repeat(128),kind:'worker'}));
  const discovered=Array.from({length:90},(_,i)=>({id:'session-'+i.toString(16).padStart(64,'0'),title:'t'.repeat(400),workspace:'/'+'w'.repeat(900),capabilities:{visible:true,reachable:false}}));
  server=createLocalControlServer({socketPath,journal:j,credentialValidator:createTurnCapabilityValidator({secret}),acl:{listAuthorizedRecipients:()=>configured.map(r=>r.id),checkAllowed(){}},recipientDirectory:configured,discoveryBroker:{listFor:async()=>discovered},dispatcher:{start:async()=>{},stop:async()=>{},notifyAdmission:async()=>{}}});await server.start();
  client=createLocalControlClient({socketPath,senderId:'sender',turnCredential:createTurnCapabilityIssuer({secret}).issue({senderId:'sender'})});
  const rows=await client.listSessions();assert.equal(rows.length,configured.length+discovered.length);assert.equal(rows.some(r=>r.delivery),false,'hints are omitted rather than losing authorized directory entries');
 }finally{await client?.close();await server?.close();await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});


test('uncertain, legacy and malformed wake records cannot establish notification acceptance',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-status-unknown-');let j;
 try{
  j=createLocalMessagingJournal({stateRoot:root});
  for(const label of ['uncertain','legacy','malformed']){
   const recipient='recipient-'+label;await j.initWakeBinding({targetIdentity:recipient,threadId:'claude-session:'+label});
   await j.recordSend({sender:'sender',recipient,messageId:label,requestId:label,text:'data',recipientType:'interactive'});
   const snapshot=await j.getWakeObligations(recipient,{isInteractive:true}),wakeId=randomUUID();
   const fingerprint=label==='legacy'?'old-hash-only':label==='malformed'?'{broken':snapshot.snapshotFingerprint;
   await j.setWakeSubmitting({targetIdentity:recipient,wakeId,fingerprint});
   if(label==='uncertain')await j.setWakeUncertain({targetIdentity:recipient,wakeId});else await j.setWakeAccepted({targetIdentity:recipient,wakeId,receipt:{queuedId:randomUUID(),threadId:randomUUID()}});
   assert.equal(await j.getMessageWakeEvidence(label),'unknown');
  }
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('session_status answers only the caller\'s own inbox view for attached and bound conversations; local_status keeps its host view',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-session-status-');let j,server;const clients=[];
 try{
  j=createLocalMessagingJournal({stateRoot:root});const socketPath=root+'/control.sock',secret='test-session-status-secret-1234567890';
  const issuer=createTurnCapabilityIssuer({secret}),validator=createTurnCapabilityValidator({secret});
  const chat='session-'+'c'.repeat(64),bound='b'.repeat(64);
  await j.recordSend({sender:'sender',recipient:chat,messageId:'chat-1',requestId:'chat-1',text:'PRIVATE_BODY',recipientType:'interactive'});
  for(const n of [1,2])await j.recordSend({sender:'sender',recipient:bound,messageId:'bound-'+n,requestId:'bound-'+n,text:'PRIVATE_BODY',recipientType:'interactive'});
  const hostView={journal:{held:7},dispatcher:{running:true},wake:{enabled:true}};
  server=createLocalControlServer({socketPath,journal:j,acl:{checkAllowed(){},listAuthorizedRecipients(){return[];}},credentialValidator:validator,dispatcher:{start:async()=>{},stop:async()=>{},notifyAdmission:async()=>{}},statusProvider:async()=>hostView,
   interactiveBroker:{isInteractiveSender:id=>id===chat,validateRequest:async()=>{}},
   inboxBroker:{isDesktopSender:id=>id===bound,validateRequest:async({claims})=>{if(claims.senderType!=='desktop-inbox')throw Object.assign(new Error('Desktop inbox binding changed'),{code:'binding_changed'});}}});await server.start();
  const client=(id,claims={})=>{const c=createLocalControlClient({socketPath,senderId:id,turnCredential:issuer.issue({senderId:id,...claims})});clients.push(c);return c;};
  const chatClient=client(chat,{senderType:'interactive',sessionId:'chat-session',generation:2,bindingId:'child-1'});
  const boundClient=client(bound,{senderType:'desktop-inbox',sessionId:'binding-1',generation:1,bindingId:'epoch-1'});

  const chatView=await chatClient.sessionStatus();
  assert.deepEqual(chatView,{route:'same-device',senderId:chat,sessionId:'chat-session',generation:2,inbox:{queued:1,executing:0,held:0}});
  assert.deepEqual(await chatClient.localStatus(),chatView,'attached chats see the same own view from local_status as before');

  const boundView=await boundClient.sessionStatus();
  assert.deepEqual(boundView,{route:'same-device',senderId:bound,sessionId:'binding-1',generation:1,inbox:{queued:2,executing:0,held:0}});
  assert.equal(JSON.stringify(boundView).includes('PRIVATE_BODY'),false);
  for(const key of ['journal','dispatcher','wake','router'])assert.equal(key in boundView,false,key);
  await j.initWakeBinding({targetIdentity:bound,threadId:'bound-thread',generation:2});
  assert.equal((await boundClient.sessionStatus()).generation,2,'the bound view reports the wake binding generation, which acknowledgments check and a rebind moves');
  const host=await boundClient.localStatus();assert.equal(host.journal.held,7,'local_status still gives the bound identity (owner CLI) the host view');assert.ok(host.router);

  await assert.rejects(client(bound).sessionStatus(),{code:'binding_changed'});
  await assert.rejects(client('sender').sessionStatus(),{code:'unsupported'});
  await assert.rejects(client('sender',{senderType:'desktop-inbox'}).sessionStatus(),{code:'unsupported'});
 }finally{for(const c of clients)await c.close();await server?.close();await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});
