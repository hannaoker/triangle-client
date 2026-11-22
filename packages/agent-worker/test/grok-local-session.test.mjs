import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile,spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {setupLocalMessaging,setupSessionDiscovery,setupWorkspaceMessaging,setupDesktopInbox,runSessionDiscoveryHook} from '../src/local-messaging-cli.mjs';
import {setupGrok,readGrokBinding,disableGrok,runGrokCommand,GROK_WAIT_TIMEOUT_EXIT,waitForMatch} from '../src/grok-local-session.mjs';
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

test('a desktop request reaches a waiting Grok receiver with its window and returns a correlated acknowledgment', async () => {
 const f = fixture();
 try {
  const bob = f.pair('bob', ctxB, [ownerId], [ownerId]);
  await f.start();
  const wait = f.run(ctxB, ['grok','wait','--inbox','--timeout','5','--json']);
  await f.run(undefined, ['send','--to',bob.senderId,'--message-id','pilot','--request-id','exchange',
    '--reply-window','{"seconds":120}','--text','question']);
  assert.deepEqual((await wait).messageIds, ['pilot']);
  const incoming = (await f.run(ctxB, ['grok','inbox'])).items[0];
  assert.deepEqual(incoming.metadata.replyWindow, { seconds:120 });
  assert.equal(incoming.loopDepth, 1);
  const claimFile = path.join(f.root,'pilot-claim.json');
  await f.run(ctxB,['grok','claim','--message-id','pilot','--claim-id','claim','--claim-file',claimFile]);
  await f.run(ctxB,['grok','reply','--message-id','pilot','--reply-id','answer','--claim-file',claimFile,
    '--reply-window-ack','{"acceptedSeconds":30}'],'Watching for 30 seconds.');
  const reply = (await f.run(undefined,['replies','--request-id','exchange'])).replies[0];
  assert.deepEqual(reply.metadata.replyWindowAck, { acceptedSeconds:30 });
  assert.equal(reply.inReplyTo, 'pilot');
  await f.run(undefined,['send','--to',bob.senderId,'--message-id','followup','--request-id','exchange',
    '--in-reply-to','answer','--reply-window','{"seconds":0}','--text','done']);
  const followup = (await f.run(ctxB,['grok','inbox'])).items[0];
  assert.equal(followup.loopDepth, 3);
  assert.deepEqual(followup.metadata.replyWindow,{seconds:0});
  await errorCode(f.run(ctxB,['grok','status','--reply-window','{}']),'invalid_arguments');
  await errorCode(f.run(ctxB,['grok','send','--reply-window','{"_loopDepth":1}']),'invalid_arguments');
 } finally { await f.close(); }
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
  await errorCode(f.run(ctxA,['grok','status','--message-id','']),'invalid_request');
 }finally{await f.close();}
});


// grok wait: a read-only blocking call a waiter subagent can sit on (#144).
async function runRaw(f,context,args){
 const env={...process.env};delete env.CURSOR_CONVERSATION_ID;if(context!==undefined)env.CURSOR_CONVERSATION_ID=context;
 try{const res=await exec(process.execPath,[cli,...args,'--config',f.configPath],{env});return {code:0,stdout:res.stdout,stderr:res.stderr};}
 catch(error){if(typeof error.code!=='number')throw error;return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
}

test('grok wait returns 0 at once when a reply already exists, prints ids only, and never consumes it',async()=>{
 const f=fixture();try{
  f.pair('alice',ctxA,[],[f.worker]);await f.start();
  await f.run(ctxA,['grok','send','--to',f.worker,'--message-id','wait-task','--request-id','wait-req'],'review');
  const reply=(await untilReply(f,ctxA,'wait-req')).replies[0];
  const started=Date.now();
  const res=await runRaw(f,ctxA,['grok','wait','--request-id','wait-req','--timeout','5','--json']);
  assert.equal(res.code,0);assert.ok(Date.now()-started<4000,'returns without waiting out the timeout');
  assert.equal(res.stdout.trim().split('\n').length,1,'single summary line');
  const summary=JSON.parse(res.stdout);
  assert.deepEqual({...summary,waitedMs:undefined,polls:undefined},{operation:'wait',mode:'request',state:'ready',requestId:'wait-req',replyIds:[reply.messageId],count:1,more:false,waitedMs:undefined,polls:undefined,timeoutSeconds:5});
  assert.equal(summary.polls,1);
  assert.equal(res.stdout.includes('worker reply'),false,'never prints message bodies');
  // Plain mode is one human line, also without bodies.
  const plain=await runRaw(f,ctxA,['grok','wait','--request-id','wait-req','--timeout','5']);
  assert.equal(plain.code,0);assert.match(plain.stdout,/^grok wait: ready; 1 reply for request "wait-req": /);assert.equal(plain.stdout.includes('worker reply'),false);
  // No consume side effect: the reply is still pending until an explicit consume.
  assert.deepEqual((await f.run(ctxA,['grok','replies','--request-id','wait-req'])).replies.map(r=>r.messageId),[reply.messageId]);
  await f.run(ctxA,['grok','consume','--message-id',reply.messageId]);
  const after=await runRaw(f,ctxA,['grok','wait','--request-id','wait-req','--timeout','0.3','--json']);
  assert.equal(after.code,GROK_WAIT_TIMEOUT_EXIT,'consumed replies no longer match');
 }finally{await f.close();}
});

test('grok wait exits with the distinct timeout code when nothing arrives',async()=>{
 const f=fixture();try{
  f.pair('alice',ctxA,[],[f.worker]);await f.start();
  assert.equal(GROK_WAIT_TIMEOUT_EXIT,3);
  const started=Date.now();
  const res=await runRaw(f,ctxA,['grok','wait','--request-id','never-sent','--timeout','0.4','--json']);
  assert.equal(res.code,3);assert.ok(Date.now()-started>=400);
  const summary=JSON.parse(res.stdout);
  assert.equal(summary.state,'timeout');assert.equal(summary.count,0);assert.deepEqual(summary.replyIds,[]);assert.ok(summary.polls>=2,'polls again before giving up');
  const inbox=await runRaw(f,ctxA,['grok','wait','--inbox','--timeout','0.3']);
  assert.equal(inbox.code,3);assert.match(inbox.stdout,/^grok wait: timeout after 0\.3s; no unclaimed inbox message/);
 }finally{await f.close();}
});

test('grok wait --inbox wakes when a message lands, without claiming it',async()=>{
 const f=fixture();try{
  const a=f.pair('alice',ctxA,[],[grokId(ctxB)]),b=f.pair('bob',ctxB,[a.senderId],[]);await f.start();
  const waiting=runRaw(f,ctxB,['grok','wait','--inbox','--timeout','20','--json']);
  await new Promise(r=>setTimeout(r,600));
  await f.run(ctxA,['grok','send','--to',b.senderId,'--message-id','wake-me','--request-id','wake-req'],'secret body text');
  const res=await waiting;
  assert.equal(res.code,0);const summary=JSON.parse(res.stdout);
  assert.deepEqual(summary.messageIds,['wake-me']);assert.equal(summary.count,1);assert.equal(summary.mode,'inbox');
  assert.equal(res.stdout.includes('secret body text'),false);
  // Still unclaimed: inbox lists it and a normal claim succeeds afterwards.
  assert.deepEqual((await f.run(ctxB,['grok','inbox'])).items.map(i=>i.messageId),['wake-me']);
  const claim=await f.run(ctxB,['grok','claim','--message-id','wake-me','--claim-id','after-wait','--claim-file',path.join(f.root,'after-wait.json')]);
  assert.equal(claim.claimed,true);
  assert.equal((await runRaw(f,ctxB,['grok','wait','--inbox','--timeout','0.3'])).code,3,'claimed messages no longer match');
 }finally{await f.close();}
});

test('grok wait fails closed on context mismatch and rejects bad arguments before touching the broker',async()=>{
 const f=fixture();try{
  f.pair('alice',ctxA,[],[f.worker]);f.pair('bob',ctxB);
  // Host deliberately not started: every one of these must fail before any socket call.
  for(const [ctx,args,code] of [
   [ctxB,['grok','wait','--request-id','r','--alias','alice'],'grok_context_mismatch'],
   [undefined,['grok','wait','--request-id','r'],'grok_context_mismatch'],
   [undefined,['grok','wait','--inbox','--alias','alice'],'grok_context_mismatch'],
   ['33333333-3333-4333-8333-333333333333',['grok','wait','--inbox'],'grok_context_mismatch'],
   [ctxA,['grok','wait'],'invalid_arguments'],
   [ctxA,['grok','wait','--inbox','--request-id','r'],'invalid_arguments'],
   [ctxA,['grok','wait','--request-id','r','--timeout','761'],'invalid_arguments'],
   [ctxA,['grok','wait','--request-id','r','--timeout','0'],'invalid_arguments'],
   [ctxA,['grok','wait','--request-id','r','--timeout','-1'],'invalid_arguments'],
   [ctxA,['grok','wait','--request-id','r','--timeout','1e3'],'invalid_arguments'],
   [ctxA,['grok','wait','--request-id','r','--in-reply-to','m'],'invalid_arguments'],
   [ctxA,['grok','wait','--inbox','--inbox'],'invalid_arguments'],
   [ctxA,['grok','replies','--request-id','r','--json'],'invalid_arguments'],
   [ctxA,['grok','inbox','--timeout','5'],'invalid_arguments'],
   [undefined,['status','--inbox'],'invalid_arguments'],
  ]){
   const res=await runRaw(f,ctx,args);
   assert.equal(res.code,1,args.join(' '));assert.equal(JSON.parse(res.stderr).error,code,args.join(' '));assert.equal(res.stdout,'');
  }
  // The maximum itself is accepted (fails later only because no host is running).
  const max=await runRaw(f,ctxA,['grok','wait','--request-id','r','--timeout','760']);
  assert.equal(max.code,1);assert.notEqual(JSON.parse(max.stderr).error,'invalid_arguments');
 }finally{await f.close();}
});

test('grok wait refreshes its short-lived grant during a long wait and keeps the default/max timeouts',async()=>{
 const f=fixture();try{
  f.pair('alice',ctxA,[],[f.worker]);await f.start();
  // Virtual clock: a 750s default wait completes instantly but must re-exchange the 300s grant.
  let t=0,out='';const sleeps=[];
  const code=await runGrokCommand('wait',{'request-id':'clock-req',json:true},{configPath:f.configPath,env:{CURSOR_CONVERSATION_ID:ctxA},input:Readable.from([]),output:{write:s=>out+=s},
   waitClock:{now:()=>t,sleep:async ms=>{sleeps.push(ms);t+=ms;}}});
  assert.equal(code,3);const summary=JSON.parse(out);
  assert.equal(summary.timeoutSeconds,750);assert.equal(summary.state,'timeout');
  assert.equal(sleeps[0],250);assert.equal(Math.max(...sleeps),2000,'backoff is bounded at 2s');
  assert.ok(sleeps.slice(0,5).every((ms,i,a)=>i===0||ms>=a[i-1]),'backoff rises');
  assert.equal(sleeps.reduce((a,b)=>a+b,0),750000);
 }finally{await f.close();}
});

test('grok wait only ever calls the read-only list RPCs and re-exchanges its grant before it expires',async()=>{
 // Any client method other than the list call for the chosen mode fails the test (no consume/claim/ack/send).
 const strict=(allowed,impl)=>new Proxy({},{get:(_,name)=>{if(name!==allowed)throw Error('unexpected client call '+String(name));return impl;}});
 let t=0,grants=0,calls=0;const clock={now:()=>t,sleep:async ms=>{t+=ms;}};const grant=async()=>{grants++;return {credential:'c'+grants};};
 const seen=[];
 const replies=strict('listReplies',async(args,rpc)=>{calls++;seen.push({...args,credential:rpc.credential});return calls>=3?[{messageId:'r1',text:'body'}]:[];});
 const ready=await waitForMatch({mode:'request',requestId:'q',timeoutMs:750000},replies,grant,clock);
 assert.deepEqual({state:ready.state,ids:ready.ids,polls:ready.polls},{state:'ready',ids:['r1'],polls:3});
 assert.ok(seen.every(c=>c.requestId==='q'&&c.limit===50&&c.inReplyTo===undefined));
 t=0;grants=0;let inboxCalls=0;
 const inbox=strict('listInbox',async(args,rpc)=>{inboxCalls++;assert.equal(rpc.credential,'c'+grants);const items=[];items.nextCursor=null;return items;});
 const timedOut=await waitForMatch({mode:'inbox',requestId:null,timeoutMs:750000},inbox,grant,clock);
 assert.equal(timedOut.state,'timeout');assert.equal(t,750000);
 assert.equal(grants,4,'initial grant plus refreshes at 240s, 480s and 720s (grants live 300s)');
 assert.ok(inboxCalls>=375&&inboxCalls<=380,'about one poll per 2s once backoff saturates');
});

test('grok wait bounds slow grant renewals and list calls by the remaining budget so it ends near its timeout',async()=>{
 // Review finding: renewals kept the 30s client default and could push a 760s wait past a 780s tool call.
 let t=0,grants=0;const timeouts=[];
 const slowGrant=async({timeout})=>{grants++;timeouts.push(timeout);t+=grants===1?0:timeout;return {credential:'c'};};
 const slowList={listReplies:async(_,{timeout})=>{timeouts.push(timeout);t+=Math.min(timeout,700);return [];}};
 const out=await waitForMatch({mode:'request',requestId:'r',timeoutMs:760000},slowList,slowGrant,{now:()=>t,sleep:async ms=>{t+=ms;}});
 assert.equal(out.state,'timeout');
 assert.ok(t<=761000,`ended at ${t}ms`);
 assert.ok(timeouts.every(ms=>ms>=500&&ms<=5000),'every call has a bounded timeout');
 // A tiny timeout still polls once and returns promptly even when the first call is slow.
 let u=0;const once=await waitForMatch({mode:'inbox',requestId:null,timeoutMs:100},{listInbox:async(_,{timeout})=>{u+=timeout;const i=[];i.nextCursor=null;return i;}},async()=>({credential:'c'}),{now:()=>u,sleep:async ms=>{u+=ms;}});
 assert.equal(once.state,'timeout');assert.equal(once.polls,1);assert.ok(u<=1000);
});

test('a worker extends the live watch and its final reply survives a watcher restart', async () => {
  const f = fixture();
  try {
    const alice = f.pair('alice', ctxA, [grokId(ctxB)], [grokId(ctxB)]);
    const bob = f.pair('bob', ctxB, [alice.senderId], [alice.senderId]);
    await f.start();
    await f.run(ctxA, ['grok','send','--to',bob.senderId,'--request-id','job','--message-id','task',
      '--reply-window','{"seconds":3}'], 'Review it');
    const wait = ['grok','wait','--request-id','job','--follow-message','task','--json'];
    const chunk = async () => {
      try { await f.run(ctxA, [...wait,'--timeout','0.1']); }
      catch (error) {
        assert.equal(error.code, GROK_WAIT_TIMEOUT_EXIT);
        return JSON.parse(error.stdout).watchDeadline;
      }
      assert.fail('expected an unfinished task');
    };
    assert.equal(await chunk(),null);
    const claimFile = path.join(f.root,'long-claim.json');
    await f.run(ctxB,['grok','claim','--message-id','task','--claim-id','worker','--claim-file',claimFile]);
    const initial = await chunk();
    assert.ok(Number.isSafeInteger(initial));
    const watching = f.run(ctxA,[...wait,'--timeout','10']);
    const progress = ['grok','send','--to',alice.senderId,'--in-reply-to','task','--request-id','job',
      '--message-id','progress','--reply-window','{"seconds":10}'];
    await f.run(ctxB,progress,'Still working');
    const extended = await chunk();
    assert.ok(extended > initial);
    await f.run(ctxB,progress,'Still working');
    assert.equal(await chunk(),extended);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,initial-Date.now()+100)));
    await f.run(ctxB,['grok','reply','--message-id','task','--reply-id','finished','--claim-file',claimFile],'Done');
    assert.deepEqual((await watching).replyIds,['finished']);
    await f.stop();
    await f.start();
    assert.deepEqual((await f.run(ctxA,wait)).replyIds,['finished']);
  } finally { await f.close(); }
});

test('watch reconstruction ignores unrelated updates and enforces hard and soft expiry', async () => {
  const {createLocalMessagingJournal} = await import('../src/local-messaging-journal.mjs');
  const root = fs.mkdtempSync('/private/tmp/tri-window-');
  const journal = createLocalMessagingJournal({stateRoot:root});
  try {
    const start = 10000;
    const original = await journal.recordSend({sender:'alice',recipient:'bob',messageId:'root',
      requestId:'job',text:'work',metadata:{_loopDepth:1,replyWindow:{seconds:100}}},{now:start});
    const update = (id,offset,overrides={}) => journal.recordSend({sender:'bob',recipient:'alice',
      messageId:id,requestId:'job',inReplyTo:'root',text:'working',
      metadata:{_loopDepth:2,replyWindow:{seconds:9999}},...overrides},{now:start+offset});
    await update('foreign',1000,{sender:'charlie'});
    await update('other',1000,{requestId:'other'});
    await update('deep',1000,{metadata:{_loopDepth:3,replyWindow:{seconds:600}}});
    await update('late',100001);
    assert.equal(journal.replyWindowDeadline(original),start+100000);
    await update('on-time',90000);
    assert.equal(journal.replyWindowDeadline(original),start+700001);
    await update('next',690000);
    await update('last',1280000);
    assert.equal(journal.replyWindowDeadline(original),start+1800000);
  } finally { await journal.close(); fs.rmSync(root,{recursive:true,force:true}); }
});

test('claimed progress extends a wait without creating inbox work, then retires on final consumption', async () => {
  const f = fixture();
  try {
    const alice = f.pair('alice', ctxA, [grokId(ctxB)], [grokId(ctxB)]);
    const bob = f.pair('bob', ctxB, [alice.senderId], [alice.senderId]);
    await f.start();
    await f.run(ctxA,['grok','send','--to',bob.senderId,'--message-id','task','--request-id','job',
      '--reply-window','{"seconds":5}'],'Review');
    const claim = ['--message-id','task','--claim-file',path.join(f.root,'work.json')];
    await f.run(ctxB,['grok','claim',...claim,'--claim-id','claim']);
    const update = ['grok','progress',...claim,'--event-id','tests','--seconds','15'];
    const event = await f.run(ctxB,update,'Testing');
    assert.equal(event.kind,'progress');
    assert.equal(event.seq,1);
    assert.equal((await f.run(ctxB,update,'Testing')).isDuplicate,true);
    await errorCode(f.run(ctxB,update,'changed'),'duplicate_id_conflict');
    assert.deepEqual((await f.run(ctxA,['grok','inbox'])).items,[]);
    assert.deepEqual((await f.run(ctxA,['grok','replies','--request-id','job'])).replies,[]);
    const status = () => f.run(ctxA,['grok','status','--message-id','task']);
    assert.deepEqual((await status()).progress,[event]);
    const wait = ['grok','wait','--request-id','job','--follow-message','task','--json'];
    await assert.rejects(f.run(ctxA,[...wait,'--timeout','0.1']),error=>{
      const result=JSON.parse(error.stdout);
      assert.equal(error.code,GROK_WAIT_TIMEOUT_EXIT);
      assert.deepEqual(result.progressIds,['tests']);
      assert.equal(result.watchDeadline,event.watchDeadline);
      return true;
    });
    const close = await f.run(ctxB,['grok','progress',...claim,'--event-id','close','--seconds','0'],'Done watching');
    assert.equal(close.kind,'close');
    await errorCode(f.run(ctxB,['grok','progress',...claim,'--event-id','late','--seconds','10'],'Again'),'window_closed');
    await f.run(ctxB,['grok','reply',...claim,'--reply-id','final'],'Finished');
    await f.stop(); await f.start();
    assert.deepEqual((await f.run(ctxA,wait)).replyIds,['final']);
    assert.equal((await status()).progress.length,2);
    await f.run(ctxA,['grok','consume','--message-id','final']);
    assert.equal((await status()).progress,undefined);
    const history=await f.run(ctxA,['grok','status','--message-id','task','--history']);
    assert.deepEqual(history.progress.map(row=>row.eventId),['tests','close']);
  } finally { await f.close(); }
});

test('desktop worker can report three extensions on a 120-second watch and still close it', async () => {
  const f = fixture();
  try {
    const bob = f.pair('bob',ctxB,[ownerId],[ownerId]);
    setupDesktopInbox({config:f.configPath,senders:[bob.senderId]});
    await f.start();
    await f.run(ctxB,['grok','send','--to',ownerId,'--message-id','support','--request-id','req','--watch'],'Question');
    const incoming = (await f.run(undefined,['inbox'])).items[0];
    assert.equal(incoming.metadata.replyWindow.seconds,120);
    const claim = await f.run(undefined,['claim','--message-id','support','--claim-id','work']);
    const file = path.join(f.root,'desktop-claim.json');
    writePrivateJson(file,claim);
    const args=['progress','--message-id','support','--claim-file',file,'--text','Working'];
    for (const i of [1,2,3]) {
      const receipt=await f.run(undefined,[...args,'--event-id','step-'+i,'--seconds','300']);
      assert.equal(receipt.seq,i);
    }
    await errorCode(f.run(undefined,[...args,'--event-id','extra','--seconds','300']),'progress_limit');
    writePrivateJson(file,{...claim,claimToken:'incorrect'});
    await errorCode(f.run(undefined,[...args,'--event-id','step-1','--seconds','300']),'invalid_claim_token');
    writePrivateJson(file,claim);
    const close=await f.run(undefined,[...args,'--event-id','end','--seconds','0']);
    assert.equal(close.seq,4);
    assert.equal((await f.run(ctxB,['grok','status','--message-id','support'])).phase,'executing');
  } finally { await f.close(); }
});

test('delayed receiver pickup starts one full window per returned or directly claimed task', async () => {
  const { createLocalMessagingJournal } = await import('../src/local-messaging-journal.mjs');
  const stateRoot = fs.mkdtempSync('/private/tmp/tri-pickup-');
  let journal = createLocalMessagingJournal({stateRoot});
  try {
    const sent = 10_000, pickup = sent + 180_000;
    const envelope = {sender:'alice', recipient:'bob', recipientType:'interactive', text:'work',
      metadata:{_loopDepth:1,replyWindow:{seconds:120}}};
    for (const id of ['a','b']) {
      await journal.recordSend({...envelope,messageId:id,requestId:id},{now:sent});
    }
    const deadline = async id => journal.replyWindowDeadline(await journal.getRecord(id));
    assert.equal(await deadline('a'),null);
    assert.equal((await journal.listInbox({requester:'alice',now:pickup})).length,0);
    const first = await journal.listInbox({requester:'bob',now:pickup,limit:1});
    assert.deepEqual(first.map(row=>row.messageId),['a']);
    assert.equal(await deadline('a'),pickup+120_000);
    assert.equal(await deadline('b'),null,'the lookahead row is still unseen');

    await journal.close();
    journal = createLocalMessagingJournal({stateRoot});
    await journal.listInbox({requester:'bob',now:pickup+130_000,limit:1});
    assert.equal(await deadline('a'),pickup+120_000,'an expired window stays closed');
    const claim = {requester:'bob',sessionId:'session',generation:1,claimId:'work'};
    await journal.claimInboxMessage({...claim,messageId:'a',now:pickup+130_000});
    assert.equal(await deadline('a'),pickup+120_000);
    const direct = await journal.claimInboxMessage({...claim,messageId:'b',now:pickup+131_000});
    await journal.claimInboxMessage({...claim,messageId:'b',now:pickup+132_000});
    assert.equal(await deadline('b'),pickup+251_000,'direct claim starts once and retries preserve it');
    const event = await journal.recordInteractiveProgress({...claim, messageId:'b', claimToken:direct.claimToken,
      eventId:'ext', seconds:300, text:'Reviewing', now:pickup+134_000});
    assert.equal(event.watchDeadline,pickup+434_000,'the extension budget also starts at pickup');
    assert.equal(await deadline('b'),event.watchDeadline);
  } finally {
    await journal.close();
    fs.rmSync(stateRoot,{recursive:true,force:true});
  }
});

test('upgrading a queued interactive task preserves its original watch deadline', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createLocalMessagingJournal } = await import('../src/local-messaging-journal.mjs');
  const stateRoot = fs.mkdtempSync('/private/tmp/tri-legacy-watch-');
  let journal = createLocalMessagingJournal({stateRoot});
  try {
    await journal.recordSend({sender:'alice',recipient:'bob',recipientType:'interactive',text:'work',
      messageId:'old',requestId:'old',metadata:{_loopDepth:1,replyWindow:{seconds:120}}},{now:1000});
    await journal.close();
    const db = new DatabaseSync(path.join(stateRoot,'local-messaging.sqlite'));
    try { db.exec('ALTER TABLE local_messages DROP COLUMN watch_started_at'); } finally { db.close(); }
    journal = createLocalMessagingJournal({stateRoot});
    await journal.listInbox({requester:'bob',now:181_000});
    assert.equal(journal.replyWindowDeadline(await journal.getRecord('old')),121_000);
  } finally { await journal.close(); fs.rmSync(stateRoot,{recursive:true,force:true}); }
});

test('Stage 1: requester close-watch closes pre-pickup and executing watches, enforces idempotency/conflicts, survives restart, and keeps eventual reply retrievable',async()=>{
 const f=fixture();try{
  const a=f.pair('alice',ctxA,[grokId(ctxB)],[grokId(ctxB)]),b=f.pair('bob',ctxB,[a.senderId],[a.senderId]);
  f.pair('charlie','33333333-3333-4333-8333-333333333333',[],[b.senderId]);
  await f.start();
  await f.run(ctxA,['grok','send','--to',b.senderId,'--message-id','cw-pre','--request-id','cw-pre-req','--reply-window','{"seconds":120}'],'early stop task');
  const preStatus=await f.run(ctxA,['grok','status','--message-id','cw-pre']);
  assert.equal(preStatus.watchLimits.initialSeconds,120);
  const ba=f.binding('alice'),clientA=f.client(a.senderId);
  await clientA.exchangeInteractiveSession({bindingId:ba.bindingId,sessionId:ba.sessionId,generation:ba.generation,secret:ba.secret,contextHash:ba.contextHash});
  const watchPre=await clientA.getMessageStatus({messageId:'cw-pre',watchRequestId:'cw-pre-req'});
  assert.equal(watchPre.watchPending,true);
  assert.equal(watchPre.watchDeadline,null);

  await errorCode(f.run('33333333-3333-4333-8333-333333333333',['grok','close-watch','--message-id','cw-pre','--request-id','cw-pre-req','--event-id','foreign-cw'],'nope'),'foreign_access_denied');
  const closed=await f.run(ctxA,['grok','close-watch','--message-id','cw-pre','--request-id','cw-pre-req','--event-id','cw-1','--note','stop waiting']);
  assert.equal(closed.actor,'requester');
  assert.equal(closed.kind,'close');
  const watchAfter=await clientA.getMessageStatus({messageId:'cw-pre',watchRequestId:'cw-pre-req'});
  assert.equal(watchAfter.watchPending,undefined);
  assert.equal(watchAfter.watchDeadline,closed.watchDeadline);
  const dupClosed=await f.run(ctxA,['grok','close-watch','--message-id','cw-pre','--request-id','cw-pre-req','--event-id','cw-1','--note','stop waiting']);
  assert.equal(dupClosed.isDuplicate,true);
  await errorCode(f.run(ctxA,['grok','close-watch','--message-id','cw-pre','--request-id','cw-pre-req','--event-id','cw-1','--note','changed note']),'duplicate_id_conflict');

  // Survives broker restart before pickup and keeps task queued for worker
  await clientA.close();
  await f.stop();await f.start();
  const afterRestart=await f.run(ctxA,['grok','status','--message-id','cw-pre']);
  assert.equal(afterRestart.phase,'queued_local');
  assert.equal(afterRestart.progress.length,1);
  assert.equal(afterRestart.progress[0].eventId,'cw-1');

  const claimFile=path.join(f.root,'claim-cw.json');
  await f.run(ctxB,['grok','claim','--message-id','cw-pre','--claim-id','claim-cw-1','--claim-file',claimFile]);
  await errorCode(f.run(ctxB,['grok','progress','--message-id','cw-pre','--claim-file',claimFile,'--event-id','p-after-close','--seconds','30'],'trying to extend'),'window_closed');

  await f.run(ctxB,['grok','reply','--message-id','cw-pre','--claim-file',claimFile,'--reply-id','rep-cw-pre'],'eventual answer');
  // Retry close-watch AFTER completion still behaves idempotently without losing reply
  const postCompleteDup=await f.run(ctxA,['grok','close-watch','--message-id','cw-pre','--request-id','cw-pre-req','--event-id','cw-1','--note','stop waiting']);
  assert.equal(postCompleteDup.isDuplicate,true);
  const replies=await f.run(ctxA,['grok','replies','--request-id','cw-pre-req']);
  assert.deepEqual(replies.replies.map(r=>r.text),['eventual answer']);
 }finally{await f.close();}
});

test('Stage 1: simultaneous requester closeWatch and worker sendReply preserve eventual reply cleanly',async()=>{
 const f=fixture();try{
  const a=f.pair('alice',ctxA,[grokId(ctxB)],[grokId(ctxB)]),b=f.pair('bob',ctxB,[a.senderId],[a.senderId]);
  await f.start();
  const ba=f.binding('alice'),bb=f.binding('bob');
  const clientA=f.client(a.senderId),clientB=f.client(b.senderId);
  await clientA.exchangeInteractiveSession({bindingId:ba.bindingId,sessionId:ba.sessionId,generation:ba.generation,secret:ba.secret,contextHash:ba.contextHash});
  await clientB.exchangeInteractiveSession({bindingId:bb.bindingId,sessionId:bb.sessionId,generation:bb.generation,secret:bb.secret,contextHash:bb.contextHash});
  for(let i=0;i<5;i++){
   const msgId=`race-msg-${i}`,reqId=`race-req-${i}`;
   await f.run(ctxA,['grok','send','--to',b.senderId,'--message-id',msgId,'--request-id',reqId,'--reply-window','{"seconds":120}'],`task ${i}`);
   const claimFile=path.join(f.root,`race-claim-${i}.json`);
   await f.run(ctxB,['grok','claim','--message-id',msgId,'--claim-id',`race-c-${i}`,'--claim-file',claimFile]);
   const {claimToken}=readPrivateJson(claimFile);
   const [closeRes,replyRes]=await Promise.allSettled([
    clientA.closeWatch({messageId:msgId,requestId:reqId,eventId:`race-cw-${i}`,text:'simultaneous close'}),
    clientB.sendReply({messageId:msgId,claimToken,text:`race reply ${i}`,replyId:`race-rep-${i}`}),
   ]);
   assert.equal(replyRes.status,'fulfilled',JSON.stringify(replyRes));
   assert.ok(closeRes.status==='fulfilled'||closeRes.reason?.code==='window_closed',JSON.stringify(closeRes));
   const found=await f.run(ctxA,['grok','replies','--request-id',reqId]);
   assert.deepEqual(found.replies.map(r=>r.text),[`race reply ${i}`]);
  }
 }finally{await f.close();}
});

test('Stage 2: live progress visibility via stream-progress, include-progress, status, client APIs, and history retention without interrupting wait or claiming',async()=>{
 const f=fixture();try{
  const a=f.pair('alice',ctxA,[grokId(ctxB)],[grokId(ctxB)]),b=f.pair('bob',ctxB,[a.senderId],[a.senderId]);
  await f.start();
  await f.run(ctxA,['grok','send','--to',b.senderId,'--message-id','prog-msg','--request-id','prog-req','--reply-window','{"seconds":60,"maxExtensions":3,"maxTotalSeconds":180}'],'long job');

  const env={...process.env,CURSOR_CONVERSATION_ID:ctxA};
  const waiter=spawn(process.execPath,[cli,'grok','wait','--request-id','prog-req','--follow-message','prog-msg','--stream-progress','--timeout','10','--json','--config',f.configPath],{env});
  let waitOut='',waitErr='';
  waiter.stdout.on('data',d=>{waitOut+=d;});
  waiter.stderr.on('data',d=>{waitErr+=d;});

  const claimFile=path.join(f.root,'prog-claim.json');
  await f.run(ctxB,['grok','claim','--message-id','prog-msg','--claim-id','prog-c','--claim-file',claimFile]);
  await f.run(ctxB,['grok','progress','--message-id','prog-msg','--claim-file',claimFile,'--event-id','p1','--seconds','30'],'step 1');
  // Wait for first streamed NDJSON progress line
  for(let i=0;i<50&&!waitOut.includes('"p1"');i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(waitOut.includes('"p1"'),`expected streamed p1, got stdout=${waitOut} stderr=${waitErr}`);
  assert.equal(waiter.exitCode,null,'wait must remain running after progress receipt');

  // Duplicate eventId is accepted but never emitted twice by stream-progress
  await f.run(ctxB,['grok','progress','--message-id','prog-msg','--claim-file',claimFile,'--event-id','p1','--seconds','30'],'step 1');
  await f.run(ctxB,['grok','progress','--message-id','prog-msg','--claim-file',claimFile,'--event-id','p2','--seconds','30'],'step 2');
  for(let i=0;i<50&&!waitOut.includes('"p2"');i++)await new Promise(r=>setTimeout(r,20));

  // Read-only status exposes progress & limits to both sender and recipient; replies --include-progress returns progress without consuming
  const senderStatus=await f.run(ctxA,['grok','status','--message-id','prog-msg']);
  const workerStatus=await f.run(ctxB,['grok','status','--message-id','prog-msg']);
  assert.deepEqual(senderStatus.progress.map(p=>p.eventId),['p1','p2']);
  assert.deepEqual(workerStatus.progress.map(p=>p.eventId),['p1','p2']);
  assert.equal(senderStatus.watchLimits.extensionsUsed,2);
  const preReplyView=await f.run(ctxA,['grok','replies','--request-id','prog-req','--include-progress']);
  assert.deepEqual(preReplyView.replies,[]);
  assert.deepEqual(preReplyView.progress.map(p=>p.note),['step 1','step 2']);

  // client.listReplies({ includeProgress: true }) keeps array JSON shape via non-enumerable .progress
  const ba=f.binding('alice'),clientA=f.client(a.senderId);
  await clientA.exchangeInteractiveSession({bindingId:ba.bindingId,sessionId:ba.sessionId,generation:ba.generation,secret:ba.secret,contextHash:ba.contextHash});
  const arrReplies=await clientA.listReplies({requestId:'prog-req',inReplyTo:'prog-msg',includeProgress:true});
  assert.equal(Array.isArray(arrReplies),true);
  assert.equal(arrReplies.length,0);
  assert.equal(JSON.stringify(arrReplies),'[]');
  assert.deepEqual(arrReplies.progress.map(p=>p.eventId),['p1','p2']);

  // Older client mode (no --include-progress) returns only replies
  const legacyReplies=await f.run(ctxA,['grok','replies','--request-id','prog-req']);
  assert.equal(legacyReplies.progress,undefined);

  await f.run(ctxB,['grok','reply','--message-id','prog-msg','--claim-file',claimFile,'--reply-id','prog-final'],'all done');
  const exitCode=await new Promise(resolve=>waiter.once('close',resolve));
  assert.equal(exitCode,0,`wait failed stderr=${waitErr}`);
  const lines=waitOut.trim().split('\n').map(l=>JSON.parse(l));
  assert.deepEqual(lines.filter(l=>l.state==='progress').map(l=>l.eventId),['p1','p2']);
  assert.equal(lines.at(-1).state,'ready');
  assert.deepEqual(lines.at(-1).progressIds,['p1','p2']);
  assert.deepEqual(lines.at(-1).replyIds,['prog-final']);

  // wait was read-only: final reply is still unconsumed and retrievable via grok replies --include-progress
  const finalView=await f.run(ctxA,['grok','replies','--request-id','prog-req','--include-progress']);
  assert.deepEqual(finalView.replies.map(r=>r.text),['all done']);
  assert.deepEqual(finalView.progress.map(p=>p.eventId),['p1','p2']);

  // Default wait without --stream-progress remains single-JSON compatible
  const legacyWait=await f.run(ctxA,['grok','wait','--request-id','prog-req','--follow-message','prog-msg','--timeout','5','--json']);
  assert.equal(legacyWait.state,'ready');

  // client.waitForReply({ includeProgress, onProgress }) delivers progress callback and final reply
  const streamed=[];
  await f.run(ctxA,['grok','send','--to',b.senderId,'--message-id','prog-msg-2','--request-id','prog-req-2','--reply-window','{"seconds":60}'],'job 2');
  const claimFile2=path.join(f.root,'prog-claim-2.json');
  await f.run(ctxB,['grok','claim','--message-id','prog-msg-2','--claim-id','prog-c-2','--claim-file',claimFile2]);
  const waitReplyPromise=clientA.waitForReply({requestId:'prog-req-2',inReplyTo:'prog-msg-2',includeProgress:true,timeoutMs:5000,pollIntervalMs:50,onProgress:e=>streamed.push(e.eventId)});
  await f.run(ctxB,['grok','progress','--message-id','prog-msg-2','--claim-file',claimFile2,'--event-id','cb-1','--seconds','30'],'via client');
  for(let i=0;i<50&&!streamed.includes('cb-1');i++)await new Promise(r=>setTimeout(r,20));
  await f.run(ctxB,['grok','reply','--message-id','prog-msg-2','--claim-file',claimFile2,'--reply-id','rep-2'],'done 2');
  const awaitedReply=await waitReplyPromise;
  assert.deepEqual(streamed,['cb-1']);
  assert.equal(awaitedReply.text,'done 2');

  // Consuming final reply retires default progress view while preserving --history
  await f.run(ctxA,['grok','consume','--message-id',finalView.replies[0].messageId]);
  const retiredDefault=await f.run(ctxA,['grok','status','--message-id','prog-msg']);
  assert.equal(retiredDefault.progress,undefined);
  const retiredHistory=await f.run(ctxA,['grok','status','--message-id','prog-msg','--history']);
  assert.equal(retiredHistory.progress.length,2);
 }finally{await f.close();}
});

test('Stage 3 & compat: configurable replyWindow limits clamp/enforce maxExtensions & maxTotalSeconds, reject expired progress, and validate CLI flags',async()=>{
 const {createLocalMessagingJournal}=await import('../src/local-messaging-journal.mjs');
 const stateRoot=fs.mkdtempSync('/private/tmp/tri-limits-');
 let journal=createLocalMessagingJournal({stateRoot});
 try{
  // 1. Oversized limits clamp to broker limits (600, 10, 1800)
  await journal.recordSend({sender:'alice',recipient:'bob',recipientType:'interactive',text:'big',messageId:'lim-big',requestId:'req-big',
   metadata:{_loopDepth:1,replyWindow:{seconds:9999,maxExtensions:99,maxTotalSeconds:9999}}},{now:1000});
  assert.deepEqual(journal.replyWindowLimits(await journal.getRecord('lim-big')),{
   initialSeconds:600,maxExtensions:10,maxTotalSeconds:1800,extensionsUsed:0,extensionsRemaining:10
  });

  // 2. maxTotalSeconds < seconds clamps initialSeconds and deadline (starting on pickup)
  await journal.recordSend({sender:'alice',recipient:'bob',recipientType:'interactive',text:'tight',messageId:'lim-tight',requestId:'req-tight',
   metadata:{_loopDepth:1,replyWindow:{seconds:300,maxExtensions:1,maxTotalSeconds:45}}},{now:1000});
  const tightLimits=journal.replyWindowLimits(await journal.getRecord('lim-tight'));
  assert.equal(tightLimits.initialSeconds,45);
  assert.equal(tightLimits.maxTotalSeconds,45);
  assert.equal(journal.replyWindowDeadline(await journal.getRecord('lim-tight')),null);
  await journal.claimInboxMessage({messageId:'lim-tight',claimId:'ct',requester:'bob',sessionId:'s1',generation:1,now:1000});
  assert.equal(journal.replyWindowDeadline(await journal.getRecord('lim-tight')),46000);

  // 3. Enforce maxExtensions, maxTotalSeconds ceiling, and expiration
  await journal.recordSend({sender:'alice',recipient:'bob',recipientType:'interactive',text:'bounded',messageId:'lim-bnd',requestId:'req-bnd',
   metadata:{_loopDepth:1,replyWindow:{seconds:10,maxExtensions:1,maxTotalSeconds:15}}},{now:1000});
  const claim=await journal.claimInboxMessage({messageId:'lim-bnd',claimId:'c1',requester:'bob',sessionId:'s1',generation:1,now:2000});
  const p1=await journal.recordInteractiveProgress({messageId:'lim-bnd',claimToken:claim.claimToken,sessionId:'s1',generation:1,requester:'bob',text:'ext 1',now:10000,eventId:'e1',seconds:10});
  assert.equal(p1.watchDeadline,17000,'capped at pickup(2000) + maxTotalSeconds(15s)');
  await assert.rejects(()=>journal.recordInteractiveProgress({messageId:'lim-bnd',claimToken:claim.claimToken,sessionId:'s1',generation:1,requester:'bob',text:'ext 2',now:11000,eventId:'e2',seconds:5}),e=>e.code==='progress_limit');
  await assert.rejects(()=>journal.recordInteractiveProgress({messageId:'lim-bnd',claimToken:claim.claimToken,sessionId:'s1',generation:1,requester:'bob',text:'late close',now:17000,eventId:'e3',seconds:0}),e=>e.code==='window_closed');
  await journal.recordInteractiveReply({messageId:'lim-bnd',claimToken:claim.claimToken,sessionId:'s1',generation:1,requester:'bob',text:'still completes',replyId:'rep-bnd',now:18000});
  assert.deepEqual((await journal.listReplies({requester:'alice',requestId:'req-bnd'})).map(r=>r.text),['still completes']);
 }finally{await journal.close();fs.rmSync(stateRoot,{recursive:true,force:true});}

 const f=fixture();try{
  const a=f.pair('alice',ctxA,[],[grokId(ctxB)]),b=f.pair('bob',ctxB,[a.senderId],[]);
  await f.start();
  await errorCode(f.run(ctxA,['grok','status','--stream-progress']),'invalid_arguments');
  await errorCode(f.run(ctxA,['grok','send','--to',b.senderId,'--include-progress','--message-id','m1','--request-id','r1'],'hi'),'invalid_arguments');
  await errorCode(f.run(ctxA,['grok','send','--to',b.senderId,'--message-id','m2','--request-id','r2','--reply-window','{"maxExtensions":-1}'],'hi'),'invalid_arguments');
  await f.run(ctxA,['grok','send','--to',b.senderId,'--message-id','m3','--request-id','r3','--reply-window','{"seconds":60}'],'hi');
  const claimFile=path.join(f.root,'c3.json');
  await f.run(ctxB,['grok','claim','--message-id','m3','--claim-id','c3','--claim-file',claimFile]);
  await errorCode(f.run(ctxB,['grok','reply','--message-id','m3','--claim-file',claimFile,'--reply-id','rep3','--reply-window','{"seconds":30,"maxExtensions":1}'],'nope'),'invalid_arguments');
 }finally{await f.close();}
});

test('mixed-version legacy updates and progress receipts share the same extension count and remaining budget',async()=>{
 const {createLocalMessagingJournal}=await import('../src/local-messaging-journal.mjs');
 const stateRoot=fs.mkdtempSync('/private/tmp/tri-mixed-ext-');
 const journal=createLocalMessagingJournal({stateRoot});
 try{
  // 1. Explicit maxExtensions: legacy updates and progress receipts consume the shared budget in sync
  const start=10000;
  await journal.recordSend({sender:'alice',recipient:'bob',recipientType:'interactive',text:'explicit-mixed',messageId:'mix-exp',requestId:'req-exp',
   metadata:{_loopDepth:1,replyWindow:{seconds:20,maxExtensions:2,maxTotalSeconds:180}}},{now:start});
  const claim1=await journal.claimInboxMessage({messageId:'mix-exp',claimId:'c-exp',requester:'bob',sessionId:'s1',generation:1,now:start});
  // Unrelated / invalid legacy messages must not consume budget
  await journal.recordSend({sender:'bob',recipient:'alice',messageId:'exp-deep',requestId:'req-exp',inReplyTo:'mix-exp',text:'deep',
   metadata:{_loopDepth:3,replyWindow:{seconds:20}}},{now:start+1000});
  await journal.recordSend({sender:'charlie',recipient:'alice',messageId:'exp-foreign',requestId:'req-exp',inReplyTo:'mix-exp',text:'foreign',
   metadata:{_loopDepth:2,replyWindow:{seconds:20}}},{now:start+1000});
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-exp')).extensionsUsed,0);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-exp')).extensionsRemaining,2);

  // Legacy update #1 uses 1 of 2 extensions
  await journal.recordSend({sender:'bob',recipient:'alice',messageId:'exp-u1',requestId:'req-exp',inReplyTo:'mix-exp',text:'legacy 1',
   metadata:{_loopDepth:2,replyWindow:{seconds:20}}},{now:start+10000});
  assert.equal(journal.replyWindowDeadline(await journal.getRecord('mix-exp')),start+30000);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-exp')).extensionsUsed,1);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-exp')).extensionsRemaining,1);

  // Progress receipt #1 uses 2 of 2 extensions
  await journal.recordInteractiveProgress({messageId:'mix-exp',claimToken:claim1.claimToken,sessionId:'s1',generation:1,requester:'bob',text:'receipt 1',now:start+20000,eventId:'r1',seconds:20});
  assert.equal(journal.replyWindowDeadline(await journal.getRecord('mix-exp')),start+40000);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-exp')).extensionsUsed,2);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-exp')).extensionsRemaining,0);

  // Neither another progress receipt nor another legacy update can exceed maxExtensions: 2
  await assert.rejects(()=>journal.recordInteractiveProgress({messageId:'mix-exp',claimToken:claim1.claimToken,sessionId:'s1',generation:1,requester:'bob',text:'receipt 2',now:start+25000,eventId:'r2',seconds:30}),e=>e.code==='progress_limit');
  await journal.recordSend({sender:'bob',recipient:'alice',messageId:'exp-u2',requestId:'req-exp',inReplyTo:'mix-exp',text:'legacy 2 ignored',
   metadata:{_loopDepth:2,replyWindow:{seconds:60}}},{now:start+26000});
  assert.equal(journal.replyWindowDeadline(await journal.getRecord('mix-exp')),start+40000);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-exp')).extensionsUsed,2);

  // 2. Default maxExtensions (3) in legacy-first order
  await journal.recordSend({sender:'carol',recipient:'dave',recipientType:'interactive',text:'default-legacy-first',messageId:'mix-def1',requestId:'req-def1',
   metadata:{_loopDepth:1,replyWindow:{seconds:20}}},{now:start});
  const claim2=await journal.claimInboxMessage({messageId:'mix-def1',claimId:'c-def1',requester:'dave',sessionId:'s2',generation:1,now:start});
  await journal.recordSend({sender:'dave',recipient:'carol',messageId:'d1-u1',requestId:'req-def1',inReplyTo:'mix-def1',text:'u1',
   metadata:{_loopDepth:2,replyWindow:{seconds:20}}},{now:start+5000});
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-def1')).extensionsUsed,1);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-def1')).extensionsRemaining,2);
  await journal.recordInteractiveProgress({messageId:'mix-def1',claimToken:claim2.claimToken,sessionId:'s2',generation:1,requester:'dave',text:'p1',now:start+10000,eventId:'p1',seconds:20});
  await journal.recordInteractiveProgress({messageId:'mix-def1',claimToken:claim2.claimToken,sessionId:'s2',generation:1,requester:'dave',text:'p2',now:start+15000,eventId:'p2',seconds:20});
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-def1')).extensionsUsed,3);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-def1')).extensionsRemaining,0);
  await assert.rejects(()=>journal.recordInteractiveProgress({messageId:'mix-def1',claimToken:claim2.claimToken,sessionId:'s2',generation:1,requester:'dave',text:'p3',now:start+16000,eventId:'p3',seconds:30}),e=>e.code==='progress_limit');
  await journal.recordSend({sender:'dave',recipient:'carol',messageId:'d1-u2',requestId:'req-def1',inReplyTo:'mix-def1',text:'u2 ignored',
   metadata:{_loopDepth:2,replyWindow:{seconds:60}}},{now:start+17000});
  assert.equal(journal.replyWindowDeadline(await journal.getRecord('mix-def1')),start+35000);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-def1')).extensionsUsed,3);

  // 3. Default maxExtensions (3) in receipt-first order
  await journal.recordSend({sender:'erin',recipient:'frank',recipientType:'interactive',text:'default-receipt-first',messageId:'mix-def2',requestId:'req-def2',
   metadata:{_loopDepth:1,replyWindow:{seconds:20}}},{now:start});
  const claim3=await journal.claimInboxMessage({messageId:'mix-def2',claimId:'c-def2',requester:'frank',sessionId:'s3',generation:1,now:start});
  await journal.recordInteractiveProgress({messageId:'mix-def2',claimToken:claim3.claimToken,sessionId:'s3',generation:1,requester:'frank',text:'p1',now:start+5000,eventId:'p1',seconds:20});
  await journal.recordSend({sender:'frank',recipient:'erin',messageId:'d2-u1',requestId:'req-def2',inReplyTo:'mix-def2',text:'u1',
   metadata:{_loopDepth:2,replyWindow:{seconds:20}}},{now:start+10000});
  await journal.recordSend({sender:'frank',recipient:'erin',messageId:'d2-u2',requestId:'req-def2',inReplyTo:'mix-def2',text:'u2',
   metadata:{_loopDepth:2,replyWindow:{seconds:20}}},{now:start+15000});
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-def2')).extensionsUsed,3);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-def2')).extensionsRemaining,0);
  await journal.recordSend({sender:'frank',recipient:'erin',messageId:'d2-u3',requestId:'req-def2',inReplyTo:'mix-def2',text:'u3 ignored',
   metadata:{_loopDepth:2,replyWindow:{seconds:60}}},{now:start+17000});
  await assert.rejects(()=>journal.recordInteractiveProgress({messageId:'mix-def2',claimToken:claim3.claimToken,sessionId:'s3',generation:1,requester:'frank',text:'p2',now:start+18000,eventId:'p2',seconds:30}),e=>e.code==='progress_limit');
  assert.equal(journal.replyWindowDeadline(await journal.getRecord('mix-def2')),start+35000);
  assert.equal(journal.replyWindowLimits(await journal.getRecord('mix-def2')).extensionsUsed,3);
 }finally{await journal.close();fs.rmSync(stateRoot,{recursive:true,force:true});}
});
