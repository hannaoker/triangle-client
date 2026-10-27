import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createLocalReplyRouteStore } from "../src/local-reply-route-store.mjs";
import { createAttachedReplyIdentity } from "../src/local-sender-authentication.mjs";
import { createLocalControlServer } from "../src/local-messaging-server.mjs";
import { createLocalControlClient } from "../src/local-messaging-client.mjs";
import { createOwnerAcl } from "../src/local-messaging-acl.mjs";
import { createTurnCapabilityIssuer, createTurnCapabilityValidator } from "../src/local-messaging-credentials.mjs";

const a = `session-${"a".repeat(64)}`, b = `session-${"b".repeat(64)}`;

test("native socket admission pins a chat; renewed same-chat reply stays with an offline original sender", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r2-server-"));fs.chmodSync(root,0o700);
  const states = new Map([[a,{generation:1,active:true,child:'child-a'}],[b,{generation:1,active:true,child:'child-b'}]]);
  const secret = "real-socket-r2-credential-secret-32-bytes";
  const issuer = createTurnCapabilityIssuer({secret}), validator = createTurnCapabilityValidator({secret});
  const broker = {
    isInteractiveSender: id => states.has(id),
    async validateRequest({claims,senderId}) {
      const state=states.get(senderId);
      if(!state?.active||claims.generation!==state.generation||claims.bindingId!==state.child)throw Object.assign(new Error('fenced'),{code:'session_fenced'});
    },
    async describeLocalSession(id) {
      const state=states.get(id);
      if(!state?.active)throw Object.assign(new Error('offline'),{code:'session_offline'});
      return {address:id,generation:state.generation,principal:null,authorityOrigin:null,bindingGeneration:null};
    },
  };
  let journal=createLocalMessagingJournal({stateRoot:root,replyRouteStoreFactory:createLocalReplyRouteStore});
  const control=new DatabaseSync(path.join(root,'local-messaging.sqlite'));
  for(const id of [a,b]) {
    control.prepare("INSERT INTO local_discovered_sessions(id,installation_id,workspace,session_id,lifecycle,generation,event_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)").run(id,'scope',root,'hash','observed',1,Date.now(),Date.now());
    await journal.attachDiscoveredSession({id,childId:states.get(id).child,generation:1,installationId:'scope',wakeCapable:false});
  }
  const socketPath=path.join(root,'control.sock');
  const replyIdentity=createAttachedReplyIdentity({credentialValidator:validator,sessionBroker:broker});
  const server=createLocalControlServer({socketPath,journal,credentialValidator:validator,interactiveBroker:broker,replyIdentity,
    interactiveRecipients:new Set([a,b]),acl:createOwnerAcl({rules:{[a]:[b],[b]:[a]}}),
    dispatcher:{start:async()=>{},stop:async()=>{},notifyAdmission:async()=>{throw new Error('interactive request must not run a worker');}}});
  const clients=[];
  const client=id=>{const state=states.get(id),credential=issuer.issue({senderId:id,senderType:'interactive',sessionId:'raw-'+id.slice(-1),generation:state.generation,bindingId:state.child,allowedRecipients:[id===a?b:a]});const c=createLocalControlClient({socketPath,senderId:id,turnCredential:credential});clients.push(c);return c;};
  t.after(async()=>{for(const c of clients)await c.close();await server.close();control.close();journal.close();fs.rmSync(root,{recursive:true,force:true});});
  await server.start();
  const sender=client(a),recipient=client(b);
  const envelope={to:b,text:'untrusted task',messageId:'native-request',requestId:'native-conversation',metadata:{sender_provenance:{principal:'forged'},senderProvenance:{principal:'forged'}}};
  const receipt=await sender.sendMessage(envelope);assert.equal(receipt.accepted,true);
  const route=await journal.getReplyRouteForMessage('native-request');assert.equal(route.local.address,b);assert.equal(route.remote.address,a);
  const inbox=await recipient.listInbox();assert.equal(inbox.length,1);assert.equal(Object.hasOwn(inbox[0],'reply_route_key'),false);
  assert.equal(inbox[0].senderProvenance.via.authenticated_peer,a);
  assert.equal(inbox[0].senderProvenance.principal,null);
  assert.equal(inbox[0].metadata.sender_provenance,undefined);
  assert.equal(inbox[0].metadata.senderProvenance,undefined);
  const claim=await recipient.claimInboxMessage({messageId:'native-request',claimId:'native-claim'});
  states.set(b,{generation:2,active:true,child:'new-child-b'});
  control.prepare('UPDATE local_discovered_sessions SET generation=2 WHERE id=?').run(b);
  await journal.detachDiscoveredSession({id:b,childId:'child-b'});
  await journal.attachDiscoveredSession({id:b,childId:'new-child-b',generation:2,installationId:'scope',wakeCapable:false});
  await assert.rejects(recipient.sendReply({messageId:'native-request',claimToken:claim.claimToken,text:'old child',replyId:'old-reply'}),{code:'session_fenced'});
  const renewed=client(b);
  // Broker validation happened, then the lease changed before the journal transaction.
  const originalDescribe=broker.describeLocalSession;
  broker.describeLocalSession=async id=>{
    const value=await originalDescribe(id);
    if(id===a)control.prepare("UPDATE local_session_attachments SET child_id='other-child' WHERE id=?").run(b);
    return value;
  };
  await assert.rejects(renewed.sendReply({messageId:'native-request',claimToken:claim.claimToken,text:'raced reply',replyId:'raced-reply'}),{code:'session_fenced'});
  assert.equal((await journal.getReplyRouteForMessage('native-request')).local.generation,1);
  broker.describeLocalSession=originalDescribe;
  control.prepare('UPDATE local_session_attachments SET child_id=? WHERE id=?').run('new-child-b',b);
  states.get(a).active=false;
  const reply=await renewed.sendReply({messageId:'native-request',claimToken:claim.claimToken,text:'verified result',replyId:'native-reply'});
  assert.equal(reply.recipient,a);assert.equal((await journal.getReplyRouteForMessage('native-request')).local.generation,2);
  states.get(a).active=true;
  const replies=await sender.listReplies({requestId:'native-conversation'});assert.equal(replies.length,1);assert.equal(replies[0].text,'verified result');assert.equal(replies[0].senderProvenance.via.authenticated_peer,b);assert.equal(replies[0].senderProvenance.sender_binding_generation,2);
  assert.equal((await sender.getMessageStatus({messageId:'native-request'})).senderProvenance.via.authenticated_peer,a);
  assert.equal((await sender.sendMessage(envelope)).isDuplicate,true);
});
