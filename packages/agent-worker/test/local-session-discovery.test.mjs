import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createLocalMessagingJournal} from '../src/local-messaging-journal.mjs';
import {createSessionDiscoveryBroker,writePrivateJson} from '../src/local-messaging-auth-broker.mjs';

function fixture(){
 const root=fs.mkdtempSync('/private/tmp/triangle-discovery-');
 const workspace=path.join(root,'workspace');fs.mkdirSync(workspace,{mode:0o700});
 const integrationPath=path.join(root,'discovery.json'),reader='a'.repeat(64);
 const integration={version:1,enabled:true,installationId:randomUUID(),secret:'b'.repeat(64),workspace,readerIds:[reader]};
 writePrivateJson(integrationPath,integration);
 let journal=createLocalMessagingJournal({stateRoot:path.join(root,'journal')});
 const broker=()=>createSessionDiscoveryBroker({integrationPath,journal});
 const event=(sessionId,kind,observedAt=Date.now())=>({eventId:randomUUID(),sessionId,kind,workspace,observedAt});
 const report=async(b,e)=>{const auth={installationId:integration.installationId,secret:integration.secret};const challenge=b.challenge({...auth,event:e});return b.report({...auth,nonce:challenge.nonce,event:e});};
 return {root,workspace,reader,integration,integrationPath,event,report,broker,get journal(){return journal;},async reopen(){await journal.close();journal=createLocalMessagingJournal({stateRoot:path.join(root,'journal')});},async close(){await journal.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('concurrent sessions remain distinct, readable and discovery-only; state survives reopen',async()=>{
 const f=fixture();try{
  let b=f.broker();const ids=[randomUUID(),randomUUID()];
  for(const sid of ids)await f.report(b,f.event(sid,'start'));
  let rows=await b.listFor(f.reader);assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);
  assert.ok(rows.every(r=>r.label.startsWith('Claude · workspace · ')&&r.capabilities.visible&&!r.capabilities.reachable&&!r.capabilities.wakeCapable&&r.presence==='unknown'));
  assert.deepEqual(await b.listFor('c'.repeat(64)),[]);
  await f.reopen();b=f.broker();assert.deepEqual(await b.listFor(f.reader),rows);
 }finally{await f.close();}
});

test('clear/end fences stale activity; a new session and later resume do not share identity',async()=>{
 const f=fixture();try{
  const b=f.broker(),sid=randomUUID(),now=Date.now();
  const start=f.event(sid,'start',now-30);const original=await f.report(b,start);
  await f.report(b,f.event(sid,'end',now-20));
  const stale=await f.report(b,f.event(sid,'activity',now-25));assert.equal(stale.stale,true);
  await f.report(b,f.event(sid,'activity',now-10));
  let rows=await b.listFor(f.reader);assert.equal(rows[0].presence,'offline');
  await f.report(b,f.event(randomUUID(),'start',now-5));rows=await b.listFor(f.reader);assert.equal(rows.length,2);
  await f.report(b,f.event(sid,'start',now));rows=await b.listFor(f.reader);assert.equal(rows.find(r=>r.id===original.id).generation,2);
  assert.equal(rows.filter(r=>r.presence==='unknown').length,2);
 }finally{await f.close();}
});

test('nonce binds event; duplicate retry is durable; invalid secret, scope and disabled installation fail closed',async()=>{
 const f=fixture();try{
  const b=f.broker(),auth={installationId:f.integration.installationId,secret:f.integration.secret};
  const e=f.event(randomUUID(),'start');const c=b.challenge({...auth,event:e});
  await assert.rejects(b.report({...auth,nonce:c.nonce,event:{...e,sessionId:randomUUID()}}));
  const result=await f.report(b,e);const again=await f.report(b,e);assert.equal(again.duplicate,true);assert.equal(again.id,result.id);
  assert.throws(()=>b.challenge({...auth,secret:'wrong',event:e}));
  assert.throws(()=>b.challenge({...auth,event:{...e,workspace:f.root}}));
  writePrivateJson(f.integrationPath,{...f.integration,enabled:false});
  assert.deepEqual(await b.listFor(f.reader),[]);
  assert.throws(()=>b.challenge({...auth,event:e}));
 }finally{await f.close();}
});

import {setupLocalMessaging,setupSessionDiscovery,setupWorkspaceMessaging,disableSessionDiscovery,runLocalMessagingCLI} from '../src/local-messaging-cli.mjs';
import {createInstalledLocalMessagingHost} from '../src/local-messaging-host.mjs';
import {createProfiledReasonerGate} from '../src/concurrency-gate.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../src/local-messaging-cli.mjs',import.meta.url));
function invokeHook(configPath,payload){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,'discovery-hook','--config',configPath],{env:{...process.env,CLAUDE_CODE_SESSION_ID:randomUUID()}});
  let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
  child.once('error',reject);child.once('exit',code=>resolve({code,stdout,stderr}));child.stdin.end(JSON.stringify(payload));
 });
}

test('owner opt-in preserves settings; real hook/host/CLI discovers existing and future chats without send authority',async()=>{
 const root=fs.mkdtempSync('/private/tmp/triangle-discovery-live-');let host;
 try{
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace,{mode:0o700});fs.mkdirSync(path.join(workspace,'.claude'),{mode:0o700});
  const settingsPath=path.join(workspace,'.claude/settings.local.json');
  const prior={permissions:{allow:['Bash(echo *)']},hooks:{SessionStart:[{hooks:[{type:'command',command:'echo unrelated'}]}]}};
  fs.writeFileSync(settingsPath,JSON.stringify(prior),{mode:0o600});
  const wrapper=path.join(root,"triangle'local");fs.writeFileSync(wrapper,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'discovery-thread',enabled:false});
  setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'discovery-thread',recipients:['gravity2']});
  const options={config:configPath,workspace,'local-cli':wrapper};setupSessionDiscovery(options);setupSessionDiscovery(options);
  const settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
  assert.deepEqual(settings.permissions,prior.permissions);assert.deepEqual(settings.hooks.SessionStart[0],prior.hooks.SessionStart[0]);
  assert.equal(settings.hooks.SessionStart.length,2);assert.equal(settings.hooks.UserPromptSubmit.length,1);
  assert.ok(settings.hooks.SessionStart[1].hooks[0].command.includes("'\\''"),'quotes in wrapper path are shell-escaped');
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));let executions=0;
  host=createInstalledLocalMessagingHost({configPath,runners:new Map([[config.recipients[0].instanceId,{run:async()=>{executions++;return {status:'completed',text:'unused'};}}]]),gate:createProfiledReasonerGate()});
  await host.start();
  async function run(args){let text='';await runLocalMessagingCLI([...args,'--config',configPath],{output:{write:x=>text+=x}});return JSON.parse(text);}
  const ids=[randomUUID(),randomUUID()];
  // Existing chats report on their next prompt; future chats report at start.
  for(const [i,sid] of ids.entries()){
   const response=await invokeHook(configPath,{session_id:sid,cwd:workspace,hook_event_name:i?'SessionStart':'UserPromptSubmit',prompt:'DO_NOT_STORE_PROMPT',transcript_path:'DO_NOT_STORE_PATH'});
   assert.deepEqual(response,{code:0,stdout:'',stderr:''});
  }
  let sessions=(await run(['sessions'])).sessions;
  const discovered=sessions.filter(row=>row.harness==='claude');assert.equal(discovered.length,2);
  assert.ok(discovered.every(row=>!row.capabilities.reachable&&!row.capabilities.wakeCapable));
  assert.ok(discovered.every(row=>ids.some(id=>row.label.endsWith(createHash('sha256').update(id).digest('hex').slice(0,8)))));
  assert.ok(!JSON.stringify(discovered).includes('DO_NOT_STORE'));
  const databaseBytes=fs.readFileSync(path.join(config.stateRoot,'local-messaging.sqlite'));
  for(const id of ids)assert.equal(databaseBytes.includes(Buffer.from(id)),false,'raw session IDs are not retained');
  assert.equal((await run(['discover'])).recipients.length,1,'legacy discovery does not acquire new routes');
  await assert.rejects(run(['send','--to',discovered[0].id,'--text','must not run']),/recipient|authorized|allowed/i);
  assert.equal(executions,0);
  await invokeHook(configPath,{session_id:ids[0],cwd:workspace,hook_event_name:'SessionEnd'});
  sessions=(await run(['sessions'])).sessions;assert.equal(sessions.filter(row=>row.presence==='offline').length,1);
  fs.renameSync(workspace,workspace+'-moved');
  assert.equal((await run(['sessions'])).sessions.length,1,'B1: configured recipient still lists when workspace is gone');
  fs.renameSync(workspace+'-moved',workspace);
  fs.unlinkSync(config.discovery.integrationPath);
  assert.equal((await run(['sessions'])).sessions.length,1,'B1: missing integration cannot break existing directory');
  await run(['disable-discovery']);assert.equal((await run(['sessions'])).sessions.filter(row=>row.harness==='claude').length,0);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath,'utf8')),prior,'disable removes only managed hooks');
  assert.equal('discovery' in JSON.parse(fs.readFileSync(configPath,'utf8')),false,'old hosts accept rollback configuration');
 }finally{await host?.stop();fs.rmSync(root,{recursive:true,force:true});}
});

test('expired and replayed challenges cannot register; rotation invalidates pending challenges',async()=>{
 const f=fixture();try{
  let now=Date.now();const b=createSessionDiscoveryBroker({integrationPath:f.integrationPath,journal:f.journal,clock:()=>now});
  const auth={installationId:f.integration.installationId,secret:f.integration.secret},e=f.event(randomUUID(),'start',now);
  const expired=b.challenge({...auth,event:e});now+=5001;
  await assert.rejects(b.report({...auth,nonce:expired.nonce,event:e}));
  const c=b.challenge({...auth,event:e});await b.report({...auth,nonce:c.nonce,event:e});
  await assert.rejects(b.report({...auth,nonce:c.nonce,event:e}));
  const pending=b.challenge({...auth,event:e});
  const next={...f.integration,secret:'e'.repeat(64)};writePrivateJson(f.integrationPath,next);
  await assert.rejects(b.report({...auth,secret:next.secret,nonce:pending.nonce,event:e}));
  assert.equal((await b.listFor(f.reader)).length,1);
 }finally{await f.close();}
});

test('compaction/resume with same identity retains handle and delayed end cannot close newer generation',async()=>{
 const f=fixture();try{
  const b=f.broker(),sid=randomUUID(),now=Date.now();
  const first=await f.report(b,f.event(sid,'start',now-100));
  const compact=await f.report(b,f.event(sid,'start',now-90));assert.equal(compact.id,first.id);assert.equal(compact.generation,1);
  await f.report(b,f.event(sid,'end',now-80));
  const resumed=await f.report(b,f.event(sid,'start',now-60));assert.equal(resumed.id,first.id);assert.equal(resumed.generation,2);
  const late=await f.report(b,f.event(sid,'end',now-70));assert.equal(late.stale,true);
  const rows=await b.listFor(f.reader);assert.equal(rows.length,1);assert.equal(rows[0].presence,'unknown');assert.equal(rows[0].generation,2);
 }finally{await f.close();}
});

test('B1: missing workspace or invalid integration hides discovery without failing listing',async()=>{
 const f=fixture();try{
  const b=f.broker();fs.renameSync(f.workspace,f.workspace+'-moved');
  assert.deepEqual(await b.listFor(f.reader),[]);
  fs.unlinkSync(f.integrationPath);assert.deepEqual(await b.listFor(f.reader),[]);
  fs.writeFileSync(f.integrationPath,'not JSON',{mode:0o600});assert.deepEqual(await b.listFor(f.reader),[]);
 }finally{await f.close();}
});

function ownerFixture(){
 const root=fs.mkdtempSync('/private/tmp/triangle-discovery-recovery-'),workspace=path.join(root,'workspace');
 fs.mkdirSync(workspace,{mode:0o700});
 const wrapper=path.join(root,'triangle-local');fs.writeFileSync(wrapper,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
 writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'recovery-thread',enabled:false});
 const setup={config:configPath,'desktop-binding':bindingPath,'thread-id':'recovery-thread',recipients:['gravity2']};
 setupLocalMessaging(setup);setupSessionDiscovery({config:configPath,workspace,'local-cli':wrapper});
 return {root,workspace,configPath,setup,settingsPath:path.join(workspace,'.claude/settings.local.json'),integrationPath:path.join(root,'local/session-discovery.json')};
}

test('B1/R1: disable repairs missing/corrupt integration and key loss, preserving unrelated hooks',()=>{
 for(const failure of ['missing','corrupt','key-loss']){
  const f=ownerFixture();try{
   const config=JSON.parse(fs.readFileSync(f.configPath));
   if(failure==='missing')fs.unlinkSync(f.integrationPath);
   if(failure==='corrupt')fs.writeFileSync(f.integrationPath,'not JSON');
   if(failure==='key-loss'){delete config.discovery;writePrivateJson(f.configPath,config);}
   const result=disableSessionDiscovery({config:f.configPath});
   assert.equal(result.discoveryEnabled,false);
   assert.equal('discovery' in JSON.parse(fs.readFileSync(f.configPath)),false);
   assert.ok(!JSON.parse(fs.readFileSync(f.settingsPath)).hooks,'managed hooks removed despite damaged state');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 }
});

test('R1: base setup preserves optional integrations so disable can remove managed hooks',()=>{
 const f=ownerFixture();try{
  const before=JSON.parse(fs.readFileSync(f.configPath));
  setupLocalMessaging(f.setup);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)).discovery,before.discovery);
  disableSessionDiscovery({config:f.configPath});
  assert.ok(!JSON.parse(fs.readFileSync(f.settingsPath)).hooks);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('N1: setup preserves wake activation only for the same sender and thread',()=>{
 for(const change of ['same','thread','sender','missing-integration']){
  const f=ownerFixture();try{
   const config=JSON.parse(fs.readFileSync(f.configPath));
   const wake={enabled:true,adapter:'codex-queue',coalesceMs:123};
   const interactive={enabled:false},runnerTimeoutMs=7200000;
   writePrivateJson(f.configPath,{...config,wake,interactive,runnerTimeoutMs});
   const setup={...f.setup};
   if(change==='thread'){setup['thread-id']='replacement-thread';setup.rebind=true;}
   if(change==='sender')writePrivateJson(f.setup['desktop-binding'],{instanceId:'b'.repeat(64)});
   if(change==='missing-integration')fs.unlinkSync(config.integrationPath);
   setupLocalMessaging(setup);
   const after=JSON.parse(fs.readFileSync(f.configPath));
   assert.deepEqual(after.wake,{...wake,enabled:change==='same'});
   assert.deepEqual(after.discovery,config.discovery);
   assert.deepEqual(after.interactive,interactive);
   assert.equal(after.runnerTimeoutMs,runnerTimeoutMs);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 }
});

test('R2: full directory evicts oldest ended row, retaining its end fence across restart',async()=>{
 const f=fixture();try{
  let n=0;const now=Date.now(),ended=randomUUID();
  const report=(sid,kind,at)=>f.journal.recordDiscoveryEvent({installationId:f.integration.installationId,event:f.event(sid,kind,at),digest:'test-'+n++,receivedAt:now});
  const old=await report(ended,'end',now-100);
  for(let i=1;i<128;i++)await report(randomUUID(),'start',now-90);
  await report(randomUUID(),'start',now-50);
  let rows=await f.journal.listDiscoveredSessions({installationId:f.integration.installationId,workspace:f.workspace});
  assert.equal(rows.length,128);assert.ok(!rows.some(row=>row.id===old.id));
  await f.reopen();
  const stale=await report(ended,'activity',now-10);assert.equal(stale.stale,true);
  rows=await f.journal.listDiscoveredSessions({installationId:f.integration.installationId,workspace:f.workspace});assert.equal(rows.length,128);
  await assert.rejects(report(randomUUID(),'start',now),{code:'directory_full'});
  const status=await f.broker().status();assert.equal(status.used,128);assert.equal(status.capacity,128);
 }finally{await f.close();}
});

test('Codex opt-in is explicit, namespaces equal UUIDs and binds harness into the challenge',async()=>{
 const f=fixture();try{
  const b=f.broker(),sid=randomUUID(),e={...f.event(sid,'start'),harness:'codex'};
  assert.throws(()=>b.challenge({installationId:f.integration.installationId,secret:f.integration.secret,event:e}),{code:'invalid_discovery_event'});
  writePrivateJson(f.integrationPath,{...f.integration,harnesses:['claude','codex']});
  const auth={installationId:f.integration.installationId,secret:f.integration.secret};
  const challenge=b.challenge({...auth,event:e});
  await assert.rejects(b.report({...auth,nonce:challenge.nonce,event:{...e,harness:'claude'}}),{code:'unauthorized'});
  const codex=await f.report(b,e),claude=await f.report(b,f.event(sid,'start'));
  assert.notEqual(codex.id,claude.id);
  let rows=await b.listFor(f.reader);assert.deepEqual(new Set(rows.map(r=>r.harness)),new Set(['claude','codex']));
  assert.ok(rows.find(r=>r.id===codex.id).label.startsWith('Codex · '));
  assert.ok(rows.every(r=>!r.capabilities.reachable&&!r.capabilities.wakeCapable));
  await f.report(b,{...f.event(sid,'end'),harness:'codex'});
  rows=await b.listFor(f.reader);assert.equal(rows.find(r=>r.id===claude.id).presence,'unknown');
  await f.reopen();rows=await f.broker().listFor(f.reader);assert.equal(rows.find(r=>r.id===codex.id).presence,'offline');
  writePrivateJson(f.integrationPath,f.integration);rows=await f.broker().listFor(f.reader);
  assert.deepEqual(rows.map(r=>r.harness),['claude'],'removing opt-in hides retained Codex metadata');
 }finally{await f.close();}
});

test('Codex and Claude hook setup coexist, preserve unrelated settings, and disable together',()=>{
 const f=ownerFixture();try{
  const codexDir=path.join(f.workspace,'.codex');fs.mkdirSync(codexDir,{mode:0o700});
  const codexFile=path.join(codexDir,'hooks.json');
  const prior={description:'owner hooks',hooks:{SessionStart:[{hooks:[{type:'command',command:'echo owner'}]}]}};
  fs.writeFileSync(codexFile,JSON.stringify(prior),{mode:0o600});
  const args={config:f.configPath,workspace:f.workspace,'local-cli':path.join(f.root,'triangle-local'),harness:'codex'};
  setupSessionDiscovery(args);setupSessionDiscovery(args);
  const after=JSON.parse(fs.readFileSync(codexFile));
  assert.deepEqual(after.hooks.SessionStart[0],prior.hooks.SessionStart[0]);
  assert.equal(after.hooks.SessionStart.length,2);assert.equal(after.hooks.SessionEnd[0].hooks[0].timeout,3);
  assert.ok(after.hooks.SessionStart[1].hooks[0].command.endsWith('--harness codex'));
  assert.deepEqual(new Set(JSON.parse(fs.readFileSync(f.integrationPath)).harnesses),new Set(['claude','codex']));
  assert.throws(()=>setupSessionDiscovery({...args,harness:'unknown'}),{code:'invalid_arguments'});
  const result=disableSessionDiscovery({config:f.configPath});assert.equal(result.hooksCleanupRequired,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(codexFile)),prior);
  assert.ok(!JSON.parse(fs.readFileSync(f.settingsPath)).hooks);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('Codex hook reaches real isolated host with payload identity, not inherited process identity',async()=>{
 const f=ownerFixture();let host;
 try{
  setupSessionDiscovery({config:f.configPath,workspace:f.workspace,'local-cli':path.join(f.root,'triangle-local'),harness:'codex'});
  const config=JSON.parse(fs.readFileSync(f.configPath));
  let executions=0;
  host=createInstalledLocalMessagingHost({configPath:f.configPath,runners:new Map([[config.recipients[0].instanceId,{run:async()=>{executions++;return {status:'completed',text:'unexpected'};}}]]),gate:createProfiledReasonerGate()});
  await host.start();
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  const codexHome=path.join(f.root,'codex-home');fs.mkdirSync(codexHome,{mode:0o700});
  const metadata=new DatabaseSync(path.join(codexHome,'state_5.sqlite'));
  metadata.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,source TEXT)');
  for(const [i,sid] of ids.entries())if(i<2)metadata.prepare('INSERT INTO threads VALUES(?,?)').run(sid,i?'exec':'cli');
  metadata.close();fs.chmodSync(path.join(codexHome,'state_5.sqlite'),0o600);
  const invoke=async(sid,eventName)=>{
   const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,'discovery-hook','--config',f.configPath,'--harness','codex'],{env:{...process.env,CODEX_HOME:codexHome,CODEX_THREAD_ID:randomUUID()}});
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
    child.once('error',reject);child.once('exit',code=>resolve({code,stdout,stderr}));
    child.stdin.end(JSON.stringify({session_id:sid,cwd:f.workspace,hook_event_name:eventName,source:'startup',prompt:'DO_NOT_RETAIN',transcript_path:'DO_NOT_READ'}));
   });assert.equal(result.code,0);assert.equal(result.stdout,'');
   assert.equal(result.stderr.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g,''),'');
  };
  for(const sid of ids)await invoke(sid,'SessionStart');
  let output='';await runLocalMessagingCLI(['sessions','--config',f.configPath],{output:{write:x=>output+=x}});
  const sessions=JSON.parse(output).sessions.filter(r=>r.harness==='codex');assert.equal(sessions.length,3);
  assert.deepEqual(new Set(sessions.map(r=>r.origin)),new Set(['cli','exec','unknown']));
  assert.ok(sessions.every(r=>ids.some(id=>r.label.endsWith(createHash('sha256').update(id).digest('hex').slice(0,8)))));
  for(const row of sessions){
   await assert.rejects(runLocalMessagingCLI(['send','--config',f.configPath,'--to',row.id,'--text','must not run'],{output:{write(){}}}),/recipient|authorized|allowed/i);
  }
  const bytes=fs.readFileSync(path.join(config.stateRoot,'local-messaging.sqlite'));
  for(const sid of ids)assert.equal(bytes.includes(Buffer.from(sid)),false);
  assert.equal(bytes.includes(Buffer.from('DO_NOT_RETAIN')),false);assert.equal(executions,0);
  fs.unlinkSync(path.join(codexHome,'state_5.sqlite'));
  for(const sid of ids)await invoke(sid,'SessionEnd');
  output='';await runLocalMessagingCLI(['sessions','--config',f.configPath],{output:{write:x=>output+=x}});
  const ended=JSON.parse(output).sessions.filter(r=>r.harness==='codex');
  assert.ok(ended.every(r=>r.presence==='offline'),'missing optional metadata must not suppress end hooks');
  assert.deepEqual(new Set(ended.map(r=>r.origin)),new Set(['cli','exec','unknown']),'unknown end metadata preserves known origin');
 }finally{await host?.stop();fs.rmSync(f.root,{recursive:true,force:true});}
});

import {DatabaseSync} from 'node:sqlite';
test('pre-Codex journal migration keeps Claude handles and lifecycle across reopen',async()=>{
 const f=fixture();try{
  const sid=randomUUID(),b=f.broker();const original=await f.report(b,f.event(sid,'start'));
  await f.journal.close();
  const db=new DatabaseSync(path.join(f.root,'journal/local-messaging.sqlite'));
  db.exec('ALTER TABLE local_discovered_sessions DROP COLUMN harness; ALTER TABLE local_discovered_sessions DROP COLUMN origin');db.close();
  await f.reopen();
  const rows=await f.broker().listFor(f.reader);
  assert.equal(rows.length,1);assert.equal(rows[0].id,original.id);assert.equal(rows[0].harness,'claude');assert.equal(rows[0].generation,1);
 }finally{await f.close();}
});

test('twenty mixed sessions retain distinct handles across end/resume and journal restart',async()=>{
 const f=fixture();try{
  writePrivateJson(f.integrationPath,{...f.integration,harnesses:['claude','codex']});
  const sessions=Array.from({length:20},(_,i)=>({sid:randomUUID(),harness:i%2?'codex':'claude'}));
  const now=Date.now();const event=(s,kind,offset)=>({...f.event(s.sid,kind,now+offset),harness:s.harness});
  let b=f.broker();
  for(const s of sessions)await f.report(b,event(s,'start',-30));
  const before=await b.listFor(f.reader);assert.equal(new Set(before.map(r=>r.id)).size,20);
  for(const s of sessions)await f.report(b,event(s,'end',-20));
  assert.ok((await b.listFor(f.reader)).every(r=>r.presence==='offline'));
  await f.reopen();b=f.broker();
  for(const s of sessions)await f.report(b,event(s,'start',-10));
  const after=await b.listFor(f.reader);assert.deepEqual(after.map(r=>r.id),before.map(r=>r.id));
  assert.ok(after.every(r=>r.generation===2&&!r.capabilities.reachable&&!r.capabilities.wakeCapable));
  assert.equal(after.filter(r=>r.harness==='codex').length,10);
 }finally{await f.close();}
});

import {readCodexSessionOrigin} from '../src/local-messaging-cli.mjs';
test('Codex origin is optional metadata, including unattended sources, and never creates or edits a database',()=>{
 const root=fs.mkdtempSync('/private/tmp/triangle-codex-source-');
 try{
  const file=path.join(root,'state_5.sqlite'),env={CODEX_HOME:root};
  assert.deepEqual(readCodexSessionOrigin(randomUUID(),env),'unknown');
  assert.equal(fs.existsSync(file),false,'optional reader never creates a missing database');
  const db=new DatabaseSync(file);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, source TEXT)');
  const ids={};for(const source of ['cli','vscode','exec','app-server','subagent','future-source']){
   ids[source]=randomUUID();db.prepare('INSERT INTO threads VALUES(?,?)').run(ids[source],source);
  }
  db.close();fs.chmodSync(file,0o600);const before=fs.readFileSync(file);
  for(const source of ['cli','vscode','exec','app-server','subagent'])assert.equal(readCodexSessionOrigin(ids[source],env),source);
  assert.equal(readCodexSessionOrigin(ids['future-source'],env),'unknown');
  assert.equal(readCodexSessionOrigin(randomUUID(),env),'unknown');
  assert.equal(readCodexSessionOrigin('bad',env),'unknown');
  assert.deepEqual(fs.readFileSync(file),before,'origin queries do not change source database');
  fs.chmodSync(file,0o666);assert.equal(readCodexSessionOrigin(ids.cli,env),'unknown');
  fs.chmodSync(file,0o600);fs.renameSync(file,file+'.saved');fs.symlinkSync(file+'.saved',file);
  assert.equal(readCodexSessionOrigin(ids.cli,env),'unknown');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('origin is bounded descriptive metadata and is covered by the event challenge',async()=>{
 const f=fixture();try{
  writePrivateJson(f.integrationPath,{...f.integration,harnesses:['codex']});
  const b=f.broker(),auth={installationId:f.integration.installationId,secret:f.integration.secret};
  const e={...f.event(randomUUID(),'start'),harness:'codex',origin:'exec'};
  const challenge=b.challenge({...auth,event:e});
  await assert.rejects(b.report({...auth,nonce:challenge.nonce,event:{...e,origin:'cli'}}),{code:'unauthorized'});
  assert.throws(()=>b.challenge({...auth,event:{...e,origin:'UNBOUNDED_OR_INJECTED'}}),{code:'invalid_discovery_event'});
  await f.report(b,e);const [row]=await b.listFor(f.reader);
  assert.equal(row.origin,'exec');assert.equal(row.capabilities.reachable,false);assert.equal(row.capabilities.wakeCapable,false);
 }finally{await f.close();}
});

test('pre-origin Codex journal keeps its namespaced handle and defaults descriptive origin to unknown',async()=>{
 const f=fixture();try{
  writePrivateJson(f.integrationPath,{...f.integration,harnesses:['codex']});
  const sid=randomUUID(),e={...f.event(sid,'start'),harness:'codex',origin:'exec'};
  const original=await f.report(f.broker(),e);
  await f.journal.close();
  const db=new DatabaseSync(path.join(f.root,'journal/local-messaging.sqlite'));
  db.exec('ALTER TABLE local_discovered_sessions DROP COLUMN origin');db.close();
  await f.reopen();const [row]=await f.broker().listFor(f.reader);
  assert.equal(row.id,original.id);assert.equal(row.harness,'codex');assert.equal(row.origin,'unknown');
  assert.equal(row.capabilities.reachable,false);assert.equal(row.capabilities.wakeCapable,false);
 }finally{await f.close();}
});

test('Codex-only discovery rejects Claude messaging setup before changing owner files',()=>{
 const f=ownerFixture();try{
  const integration=JSON.parse(fs.readFileSync(f.integrationPath));
  writePrivateJson(f.integrationPath,{...integration,harnesses:['codex']});
  const beforeConfig=fs.readFileSync(f.configPath),beforeIntegration=fs.readFileSync(f.integrationPath);
  const stateRoot=JSON.parse(beforeConfig).stateRoot,priorFiles=fs.readdirSync(stateRoot).sort();
  assert.throws(()=>setupWorkspaceMessaging({config:f.configPath,workspace:f.workspace,'local-cli':path.join(f.root,'triangle-local')}),{code:'claude_discovery_required'});
  assert.deepEqual(fs.readFileSync(f.configPath),beforeConfig);assert.deepEqual(fs.readFileSync(f.integrationPath),beforeIntegration);
  assert.deepEqual(fs.readdirSync(stateRoot).sort(),priorFiles);assert.equal(fs.existsSync(path.join(f.workspace,'.mcp.json')),false);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
