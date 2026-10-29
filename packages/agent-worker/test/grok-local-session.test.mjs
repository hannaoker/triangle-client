import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {setupLocalMessaging,setupSessionDiscovery,setupWorkspaceMessaging,setupDesktopInbox,runSessionDiscoveryHook} from '../src/local-messaging-cli.mjs';
import {setupGrok,readGrokBinding,disableGrok,runGrokCommand} from '../src/grok-local-session.mjs';
import {readPrivateJson,writePrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {createInstalledLocalMessagingHost} from '../src/local-messaging-host.mjs';
import {createProfiledReasonerGate} from '../src/concurrency-gate.mjs';
import {createLocalControlClient} from '../src/local-messaging-client.mjs';
import {resolveLocalSocketAddress} from '../src/local-messaging-address.mjs';
import {sessionAddress,readSessionMessagingPolicy} from '../src/local-messaging-interactive-session.mjs';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../src/local-messaging-cli.mjs',import.meta.url));
const ownerId='a'.repeat(64),ctxA='11111111-1111-4111-8111-111111111111',ctxB='22222222-2222-4222-8222-222222222222';
const hash=s=>createHash('sha256').update(s).digest('hex');
const grokId=ctx=>hash(JSON.stringify(['triangle-grok-conversation-v1',ownerId,hash(ctx)]));
function fixture(){
 const root=fs.mkdtempSync('/private/tmp/tri-grok-'),configPath=path.join(root,'local.json'),bindingPath=path.join(root,'desktop.json');
 writePrivateJson(bindingPath,{instanceId:ownerId});
 setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'grok-test-desktop',recipients:['gravity2']});
 const config=readPrivateJson(configPath),worker=config.recipients[0].instanceId;let host;const clients=[],runs=[];
 return {root,configPath,worker,runs,
  pair:(alias,context,senders=[],recipients=[])=>setupGrok({alias,'conversation-id':context,senders,recipients},configPath,{}),
  binding:alias=>readGrokBinding(path.join(config.stateRoot,`grok-${alias}.json`)),
  async start(){host=createInstalledLocalMessagingHost({configPath,runners:new Map([[worker,{run:async request=>{runs.push(request);return {status:'completed',text:'worker reply'};}}]]),gate:createProfiledReasonerGate()});await host.start();},
  async stop(){await host?.stop();host=null;},
  async run(context,args,body=''){
   const env={...process.env};delete env.CURSOR_CONVERSATION_ID;if(context!==undefined)env.CURSOR_CONVERSATION_ID=context;
   const child=exec(process.execPath,[cli,...args,'--config',configPath],{env});child.child.stdin.end(body);
   const res=await child;return JSON.parse(res.stdout);
  },
  client(id){const c=createLocalControlClient({socketPath:resolveLocalSocketAddress({stateRoot:config.stateRoot}).socketPath,senderId:id});clients.push(c);return c;},
  async close(){for(const c of clients)await c.close();await host?.stop();fs.rmSync(root,{recursive:true,force:true});},
 };
}
async function errorCode(action,code){await assert.rejects(action,error=>{assert.equal(JSON.parse(error.stderr).error,code);return true;});}
async function untilReply(f,ctx,requestId){for(let i=0;i<50;i++){const r=await f.run(ctx,['grok','replies','--request-id',requestId]);if(r.replies.length)return r;await new Promise(r=>setTimeout(r,20));}throw Error('missing worker reply');}

test('two Grok CLI processes send as distinct identities and retrieve only their own correlated worker replies',async()=>{
 const f=fixture();try{
  const a=f.pair('alice',ctxA,[],[f.worker]),b=f.pair('bob',ctxB,[],[f.worker]);assert.notEqual(a.senderId,b.senderId);assert.notEqual(a.senderId,ownerId);
  await f.start();
  for(const [ctx,name,id] of [[ctxA,'alice',a.senderId],[ctxB,'bob',b.senderId]]){
   const rows=(await f.run(ctx,['grok','sessions'])).sessions;assert.deepEqual(rows.map(r=>r.id),[f.worker]);
   await f.run(ctx,['grok','send','--to',f.worker,'--message-id',name+'-task','--request-id',name+'-req'],'review');
   const reply=(await untilReply(f,ctx,name+'-req')).replies[0];assert.equal(reply.text,'worker reply');assert.equal(reply.inReplyTo,name+'-task');
   await f.run(ctx,['grok','send','--to',f.worker,'--message-id',name+'-task','--request-id',name+'-req'],'review');
   assert.equal(f.runs.filter(r=>r.senderId===id).length,1,'stable retry executes only once');
   await f.run(ctx,['grok','consume','--message-id',reply.messageId]);assert.deepEqual((await f.run(ctx,['grok','replies','--request-id',name+'-req'])).replies,[]);
  }
 }finally{await f.close();}
});

test('mail queues with no Grok process, survives host restart, and claims/replies across separate CLI processes without leaking the token',async()=>{
 const f=fixture();try{
  const a=f.pair('alice',ctxA,[grokId(ctxB)],[grokId(ctxB)]),b=f.pair('bob',ctxB,[a.senderId],[a.senderId]);
  await f.start();const dir=(await f.run(ctxA,['grok','sessions'])).sessions;assert.equal(dir[0].capabilities.wakeCapable,false);assert.equal(dir[0].capabilities.queueable,true);
  await f.run(ctxA,['grok','send','--to',b.senderId,'--message-id','queued-one','--request-id','queued-req'],'request');
  await f.stop();await f.start();
  assert.deepEqual((await f.run(ctxB,['grok','inbox'])).items.map(i=>i.messageId),['queued-one']);
  const claimFile=path.join(f.root,'claim.json');
  const claim=await f.run(ctxB,['grok','claim','--message-id','queued-one','--claim-id','stable-claim','--claim-file',claimFile]);
  assert.equal(claim.claimToken,undefined);assert.equal(claim.claimed,true);assert.equal(fs.statSync(claimFile).mode&0o777,0o600);
  const saved=readPrivateJson(claimFile);assert.equal(typeof saved.claimToken,'string');
  await f.run(ctxB,['grok','claim','--message-id','queued-one','--claim-id','stable-claim','--claim-file',claimFile]);assert.equal(readPrivateJson(claimFile).claimToken,saved.claimToken);
  await f.run(ctxB,['grok','reply','--message-id','queued-one','--claim-file',claimFile,'--reply-id','stable-reply'],'answer');
  await f.run(ctxB,['grok','reply','--message-id','queued-one','--claim-file',claimFile,'--reply-id','stable-reply'],'answer');
  const replies=(await f.run(ctxA,['grok','replies','--request-id','queued-req'])).replies;assert.equal(replies.length,1);assert.equal(replies[0].text,'answer');
  await f.stop();await f.start();
  assert.equal((await f.run(ctxB,['grok','inbox'])).items.length,0);assert.equal(f.runs.length,0,'interactive requests never enter a worker runner');
 }finally{await f.close();}
});

test('wrong or absent provider context never falls back to Codex or another Grok alias; explicit alias mode remains usable',async()=>{
 const f=fixture();try{
  f.pair('alice',ctxA);f.pair('bob',ctxB);const alias=f.pair('manual',undefined);await f.start();
  await errorCode(f.run(ctxA,['grok','status','--alias','bob']),'grok_context_mismatch');
  await errorCode(f.run(undefined,['grok','status']),'grok_context_mismatch');
  await errorCode(f.run(undefined,['grok','status','--alias','alice']),'grok_context_mismatch');
  assert.equal((await f.run(undefined,['grok','status','--alias','manual'])).senderId,alias.senderId);
  await errorCode(f.run('ambiguous_encoded_value',['grok','status']),'unsupported_grok_context');
  assert.throws(()=>f.pair('duplicate',ctxA),{code:'identity_collision'});
  assert.throws(()=>f.pair('alice',randomUUID()),{code:'invalid_grok_alias'});
 }finally{await f.close();}
});

test('each direction needs its own grant; foreign claims and revoked credentials are rejected while custody remains held',async()=>{
 const f=fixture();try{
  const a=f.pair('alice',ctxA,[],[grokId(ctxB)]),b=f.pair('bob',ctxB,[a.senderId],[]);await f.start();
  await f.run(ctxA,['grok','send','--to',b.senderId,'--message-id','claim-me','--request-id','claim-req'],'task');
  // Bob can answer this request, but cannot start a new conversation with Alice.
  assert.deepEqual((await f.run(ctxB,['grok','sessions'])).sessions,[]);
  const denied=await f.run(ctxB,['grok','send','--to',a.senderId,'--message-id','denied','--request-id','denied'],'no').catch(e=>JSON.parse(e.stdout));assert.equal(denied.error,'recipient_not_allowed');
  await errorCode(f.run(ctxA,['grok','claim','--message-id','claim-me','--claim-id','foreign','--claim-file',path.join(f.root,'foreign.json')]),'foreign_access_denied');
  const file=path.join(f.root,'claimed.json');await f.run(ctxB,['grok','claim','--message-id','claim-me','--claim-id','owner-claim','--claim-file',file]);
  const c=f.client(b.senderId),binding=f.binding('bob');const grant=await c.exchangeInteractiveSession({...binding});
  await assert.rejects(c.exchangeInteractiveSession({...binding,secret:'0'.repeat(64)}),{code:'unauthorized'});
  await assert.rejects(c.exchangeInteractiveSession({...binding,generation:2}),{code:'unauthorized'});
  disableGrok({alias:'bob'},f.configPath);
  await assert.rejects(c.localStatus({credential:grant.credential}),{code:'session_disabled'});
  await errorCode(f.run(ctxB,['grok','reply','--message-id','claim-me','--claim-file',file,'--reply-id','old-reply'],'late'),'session_disabled');
  const ac=f.client(a.senderId),ab=f.binding('alice'),ag=await ac.exchangeInteractiveSession(ab);
  assert.equal((await ac.getMessageStatus({messageId:'claim-me'},{credential:ag.credential})).phase,'executing');
  await f.stop();await f.start();assert.equal((await f.run(ctxB,['status'])).journal.held,1,'restart holds uncertain execution and does not reassign it');
 }finally{await f.close();}
});

test('explicit grants connect Grok and an attached Claude session without admitting another Claude session',async()=>{
 const f=fixture();const clients=[];try{
  const workspace=path.join(f.root,'workspace');fs.mkdirSync(workspace,{mode:0o700});const wrapper=path.join(f.root,'wrapper');fs.writeFileSync(wrapper,'#!/bin/sh\nexit 0\n',{mode:0o700});
  setupSessionDiscovery({config:f.configPath,workspace,'local-cli':wrapper});setupWorkspaceMessaging({config:f.configPath,workspace,'local-cli':wrapper});
  const conf=readPrivateJson(f.configPath),policy=readPrivateJson(conf.sessionMessaging.integrationPath),sid=randomUUID(),other=randomUUID();
  const address=sessionAddress(policy.installationId,workspace,sid),otherAddress=sessionAddress(policy.installationId,workspace,other);
  const g=f.pair('alice',ctxA,[address],[address]);await f.start();
  for(const session of [sid,other])await runSessionDiscoveryHook({configPath:f.configPath,input:Readable.from([JSON.stringify({session_id:session,cwd:workspace,hook_event_name:'SessionStart'})])});
  const fresh=readPrivateJson(conf.sessionMessaging.integrationPath);
  const attach=async sessionId=>{const c=f.client(),grant=await c.attachSession({installationId:fresh.installationId,secret:fresh.secret,sessionId,childId:randomUUID(),wakeCapable:false});return {c:f.client(grant.senderId),rpc:{credential:grant.credential}};};
  const own=await attach(sid),foreign=await attach(other);
  assert.deepEqual((await f.run(ctxA,['grok','sessions'])).sessions.map(r=>r.id),[address]);
  await f.run(ctxA,['grok','send','--to',address,'--message-id','to-claude','--request-id','to-claude'],'hello');
  assert.equal((await own.c.listInbox({},own.rpc))[0].senderId??(await own.c.listInbox({},own.rpc))[0].sender,g.senderId);
  assert.ok((await own.c.listSessions(own.rpc)).some(r=>r.id===g.senderId));
  assert.ok(!(await foreign.c.listSessions(foreign.rpc)).some(r=>r.id===g.senderId));
  await own.c.sendMessage({to:g.senderId,text:'request',messageId:'from-claude',requestId:'from-claude'},own.rpc);
  await assert.rejects(foreign.c.sendMessage({to:g.senderId,text:'denied',messageId:'foreign',requestId:'foreign'},foreign.rpc),{code:'recipient_not_allowed'});
  assert.equal((await f.run(ctxA,['grok','inbox'])).items[0].messageId,'from-claude');
  assert.notEqual(address,otherAddress);
 }finally{for(const c of clients)await c.close();await f.close();}
});


test('owner CLI pairing is secret-free, context-bound and independently opt-in for the desktop inbox',async()=>{
 const f=fixture();try{
  const a=await f.run(undefined,['setup-grok','--alias','alice','--conversation-id',ctxA,'--sender',ownerId,'--recipient',ownerId]);
  assert.equal(a.identityMode,'paired-conversation');assert.equal(a.secret,undefined);assert.equal(a.wakeCapable,false);
  const b=f.binding('alice');assert.equal(fs.statSync(path.join(readPrivateJson(f.configPath).stateRoot,'grok-alice.json')).mode&0o777,0o600);
  assert.equal(JSON.stringify(b).includes(ctxA),false);await f.start();
  const denied=await f.run(ctxA,['grok','send','--to',ownerId,'--message-id','no-inbox','--request-id','no-inbox'],'request').catch(e=>JSON.parse(e.stdout));
  assert.equal(denied.error,'recipient_not_allowed');assert.equal(denied.state,'rejected');
  await f.stop();setupDesktopInbox({config:f.configPath,senders:[a.senderId]});await f.start();
  assert.equal((await f.run(undefined,['sessions'])).sessions.find(r=>r.id===a.senderId).harness,'grok');
  await f.run(undefined,['send','--to',a.senderId,'--message-id','from-desktop','--request-id','from-desktop','--text','hello']);
  assert.equal((await f.run(ctxA,['grok','inbox'])).items[0].messageId,'from-desktop');
  await f.run(ctxA,['grok','send','--to',ownerId,'--message-id','to-desktop','--request-id','to-desktop'],'request');
  const claim=await f.run(undefined,['claim','--message-id','to-desktop','--claim-id','desktop-claim']);const file=path.join(f.root,'desktop-claim.json');writePrivateJson(file,claim);
  await f.run(undefined,['reply','--message-id','to-desktop','--claim-file',file,'--reply-id','desktop-reply','--text','desktop answer']);
  assert.equal((await f.run(ctxA,['grok','replies','--request-id','to-desktop'])).replies[0].text,'desktop answer');
  await f.run(undefined,['disable-grok','--alias','alice']);
  await errorCode(f.run(ctxA,['grok','status']),'session_disabled');
 }finally{await f.close();}
});

test('private claim files cannot be reused for another message or through a symlink',async()=>{
 const f=fixture();try{
  const a=f.pair('alice',ctxA,[],[grokId(ctxB)]),b=f.pair('bob',ctxB,[a.senderId],[]);await f.start();
  for(const id of ['one','two'])await f.run(ctxA,['grok','send','--to',b.senderId,'--message-id',id,'--request-id',id],'task');
  const file=path.join(f.root,'claim.json');await f.run(ctxB,['grok','claim','--message-id','one','--claim-id','first','--claim-file',file]);
  const token=readPrivateJson(file).claimToken;
  await errorCode(f.run(ctxB,['grok','claim','--message-id','two','--claim-id','second','--claim-file',file]),'claim_file_mismatch');
  assert.equal(readPrivateJson(file).claimToken,token);assert.equal((await f.run(ctxB,['grok','inbox'])).items[0].messageId,'two');
  const link=path.join(f.root,'link.json');fs.symlinkSync(file,link);
  await errorCode(f.run(ctxB,['grok','claim','--message-id','two','--claim-id','second','--claim-file',link]),'unsafe_path');
 }finally{await f.close();}
});


test('owner pairs a probed context hash while runtime still requires the actual inherited context',async()=>{
 const f=fixture();try{
  const paired=await f.run(undefined,['setup-grok','--alias','hashed','--context-hash',hash(ctxA),'--recipient',f.worker]);
  assert.equal(paired.senderId,grokId(ctxA));assert.equal(paired.identityMode,'paired-conversation');
  await f.start();assert.equal((await f.run(ctxA,['grok','status'])).senderId,paired.senderId);
  await errorCode(f.run(ctxB,['grok','status','--alias','hashed']),'grok_context_mismatch');
  await errorCode(f.run(undefined,['grok','status','--context-hash',hash(ctxA)]),'grok_context_mismatch');
  await errorCode(f.run(undefined,['setup-grok','--alias','ambiguous','--context-hash',hash(ctxA),'--conversation-id',ctxB]),'invalid_grok_context');
  await errorCode(f.run(undefined,['setup-grok','--alias','invalid','--context-hash','not-a-hash']),'invalid_grok_context');
 }finally{await f.close();}
});


test('send and reply preserve UTF-8 split across single-byte stdin reads',async()=>{
 const f=fixture();try{
  const a=f.pair('alice',ctxA,[],[grokId(ctxB)]),b=f.pair('bob',ctxB,[a.senderId],[]);await f.start();
  const invoke=async(context,operation,options,text)=>{
   const bytes=Buffer.from(text);let out='';
   const code=await runGrokCommand(operation,options,{configPath:f.configPath,env:{CURSOR_CONVERSATION_ID:context},input:Readable.from([...bytes].map(byte=>Buffer.from([byte]))),output:{write:part=>out+=part}});
   assert.equal(code,0);return JSON.parse(out);
  };
  const text='你好🌍';
  await invoke(ctxA,'send',{to:b.senderId,'message-id':'utf8-request','request-id':'utf8-request'},text);
  assert.equal((await f.run(ctxB,['grok','inbox'])).items[0].text,text);
  const claim=path.join(f.root,'utf8-claim.json');await f.run(ctxB,['grok','claim','--message-id','utf8-request','--claim-id','utf8-claim','--claim-file',claim]);
  await invoke(ctxB,'reply',{'message-id':'utf8-request','reply-id':'utf8-reply','claim-file':claim},text);
  assert.equal((await f.run(ctxA,['grok','replies','--request-id','utf8-request'])).replies[0].text,text);
 }finally{await f.close();}
});

test('pairing at the workspace permission ceiling fails before changing any owner state',async()=>{
 const f=fixture();try{
  setupLocalMessaging({config:f.configPath,'desktop-binding':path.join(f.root,'desktop.json'),'thread-id':'grok-test-desktop',recipients:Array.from({length:32},(_,i)=>'worker-'+i)});
  setupDesktopInbox({config:f.configPath,senders:['f'.repeat(64)]});
  const workspace=path.join(f.root,'workspace');fs.mkdirSync(workspace,{mode:0o700});const wrapper=path.join(f.root,'wrapper');fs.writeFileSync(wrapper,'#!/bin/sh\nexit 0\n',{mode:0o700});
  setupSessionDiscovery({config:f.configPath,workspace,'local-cli':wrapper});setupWorkspaceMessaging({config:f.configPath,workspace,'local-cli':wrapper});
  const peer='session-'+'b'.repeat(64);
  for(let i=0;i<31;i++)f.pair('participant-'+i,randomUUID(),[peer],[]);
  const config=readPrivateJson(f.configPath),policyFile=config.sessionMessaging.integrationPath;
  assert.equal(readSessionMessagingPolicy(policyFile).allowedRecipients.length,64);
  const priorConfig=fs.readFileSync(f.configPath),priorPolicy=fs.readFileSync(policyFile);
  assert.throws(()=>f.pair('overflow',randomUUID(),[peer],[]),{code:'grok_policy_capacity'});
  assert.deepEqual(fs.readFileSync(f.configPath),priorConfig);assert.deepEqual(fs.readFileSync(policyFile),priorPolicy);
  assert.equal(fs.existsSync(path.join(config.stateRoot,'grok-overflow.json')),false);
  assert.equal(readSessionMessagingPolicy(policyFile).allowedRecipients.length,64);
  // The independent outgoing ceiling has the same non-mutating failure contract.
  const policy=readSessionMessagingPolicy(policyFile);
  writePrivateJson(policyFile,{...policy,allowedSenders:Array.from({length:64},(_,i)=>createHash('sha256').update('sender-'+i).digest('hex'))});
  const fullSenders=fs.readFileSync(policyFile);
  assert.throws(()=>f.pair('outgoing-overflow',randomUUID(),[],[peer]),{code:'grok_policy_capacity'});
  assert.deepEqual(fs.readFileSync(policyFile),fullSenders);assert.deepEqual(fs.readFileSync(f.configPath),priorConfig);
 }finally{await f.close();}
});

test('grok status --message-id returns that message\'s status for its sender or recipient, never the session view, and refuses foreign callers',async()=>{
 const f=fixture();const ctxC='33333333-3333-4333-8333-333333333333';try{
  const a=f.pair('alice',ctxA,[grokId(ctxB)],[grokId(ctxB)]),b=f.pair('bob',ctxB,[a.senderId],[a.senderId]);f.pair('carol',ctxC,[],[]);
  await f.start();
  await f.run(ctxA,['grok','send','--to',b.senderId,'--message-id','status-one','--request-id','status-req'],'request');
  const own=await f.run(ctxA,['grok','status']);assert.equal(own.senderId,a.senderId);assert.equal(own.messageId,undefined,'no argument is the session view');
  const sent=await f.run(ctxA,['grok','status','--message-id','status-one']);
  assert.equal(sent.messageId,'status-one');assert.equal(sent.phase,'queued_local');assert.equal(sent.delivery.state,'waiting_for_poll');
  assert.equal(sent.senderId,undefined,'a message id never falls back to the session view');
  assert.equal((await f.run(ctxB,['grok','status','--message-id','status-one'])).messageId,'status-one','the recipient may read it too');
  await errorCode(f.run(ctxC,['grok','status','--message-id','status-one']),'foreign_access_denied');
  await errorCode(f.run(ctxA,['grok','status','--message-id','missing-one']),'not_found');
 }finally{await f.close();}
});
