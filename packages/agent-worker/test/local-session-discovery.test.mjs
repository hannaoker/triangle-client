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

// ---- Conversation titles, host-process evidence and evidence-backed presence ----
import {sanitizeSessionTitle,validSessionHost,createHostProcessProbe,withSessionPresence} from '../src/local-messaging-auth-broker.mjs';
import {readCodexSessionMetadata,readCodexSessionHost,readClaudeSessionMetadata,processTable,processAncestry} from '../src/local-messaging-cli.mjs';
import {execFileSync} from 'node:child_process';
const cp=(...codes)=>String.fromCodePoint(...codes);
const hostStart='Sat Oct 24 22:20:32 2026';
const hostKey=h=>`${h.pid}:${h.start}`;
const fakeProbe=(state,calls=[])=>async hosts=>{calls.push(hosts);return new Map(hosts.map(h=>[hostKey(h),typeof state==='function'?state(h):state]));};

test('titles are bounded one-line display text: controls, bidi marks and token-like runs never reach a label',()=>{
 assert.equal(sanitizeSessionTitle('  Fix\nthe\tbug  '),'Fix the bug');
 assert.equal(sanitizeSessionTitle(['a',cp(0x202e),'b',cp(0x200b),'c',cp(7),'d',cp(0x2028),'e'].join('')),'a b c d e');
 const long=sanitizeSessionTitle('word '.repeat(100));assert.ok([...long].length<=80);assert.ok(long.endsWith(cp(0x2026)));
 assert.equal(sanitizeSessionTitle('deploy with mesh_'+'ab12'.repeat(10)+' now'),'deploy with '+cp(0x2026)+' now');
 assert.equal(sanitizeSessionTitle('Review local-messaging-auth-broker.mjs'),'Review local-messaging-auth-broker.mjs','ordinary long identifiers are kept');
 for(const empty of ['',' \n\t ',cp(0x2026),cp(0x200b),null,undefined,42,{}])assert.equal(sanitizeSessionTitle(empty),null);
});

test('host evidence must be an exact pid, scope and start time',()=>{
 const good={pid:4242,start:hostStart,scope:'session'};
 assert.equal(validSessionHost(good),true);assert.equal(validSessionHost({...good,start:'Sat Oct  4 02:03:04 2026'}),true,'ps pads single-digit days');
 for(const bad of [null,[],'x',{...good,extra:1},{...good,pid:1},{...good,pid:0},{...good,pid:-5},{...good,pid:1.5},{...good,pid:5e9},{...good,scope:'other'},{...good,start:'yesterday'},{pid:4242,scope:'session'}])assert.equal(validSessionHost(bad),false);
});

test('title and host process are bounded descriptive metadata, covered by the event challenge and never exposed as a pid',async()=>{
 const f=fixture();try{
  const host={pid:4242,start:hostStart,scope:'session'},calls=[];
  const b=createSessionDiscoveryBroker({integrationPath:f.integrationPath,journal:f.journal,processProbe:fakeProbe('alive',calls)});
  const auth={installationId:f.integration.installationId,secret:f.integration.secret};
  const e={...f.event(randomUUID(),'start'),title:'  Plan\nthe release ',host};
  const challenge=b.challenge({...auth,event:e});
  await assert.rejects(b.report({...auth,nonce:challenge.nonce,event:{...e,title:'Other'}}),{code:'unauthorized'});
  const again=b.challenge({...auth,event:e});
  await assert.rejects(b.report({...auth,nonce:again.nonce,event:{...e,host:{...host,pid:4243}}}),{code:'unauthorized'});
  for(const bad of [{...e,host:{...host,pid:1}},{...e,host:{...host,extra:1}},{...e,host:'4242'},{...e,title:'x'.repeat(401)},{...e,title:42}])assert.throws(()=>b.challenge({...auth,event:bad}),{code:'invalid_discovery_event'});
  await f.report(b,e);
  const [row]=await b.listFor(f.reader);
  assert.equal(row.title,'Plan the release');assert.ok(row.label.startsWith('Claude · Plan the release · workspace · '));
  assert.equal(row.presence,'online');assert.equal(row.presenceEvidence.kind,'host-process');assert.equal(row.presenceEvidence.scope,'session');
  assert.equal(row.capabilities.reachable,false,'presence is not reachability');assert.equal(row.capabilities.wakeCapable,false);
  const shown=JSON.stringify(row);assert.ok(!shown.includes('_host')&&!shown.includes('4242')&&!shown.includes('"pid"'),'a reader never sees a process id');
  assert.equal(calls.length,1);assert.deepEqual(calls[0],[{pid:4242,start:hostStart,scope:'session'}]);
 }finally{await f.close();}
});

test('presence reports only what the evidence supports and names that evidence',async()=>{
 const f=fixture();try{
  writePrivateJson(f.integrationPath,{...f.integration,harnesses:['claude','codex']});
  const hosts={claudeAlive:{pid:11,start:hostStart,scope:'session'},codexShared:{pid:12,start:hostStart,scope:'shared'},gone:{pid:13,start:hostStart,scope:'session'},error:{pid:14,start:hostStart,scope:'session'}};
  const ids={};const base=f.broker();
  for(const [name,host] of Object.entries(hosts)){ids[name]=randomUUID();await f.report(base,{...f.event(ids[name],'start'),host,...(name==='codexShared'?{harness:'codex'}:{})});}
  ids.noHost=randomUUID();await f.report(base,f.event(ids.noHost,'start'));
  ids.ended=randomUUID();await f.report(base,{...f.event(ids.ended,'start'),host:{pid:15,start:hostStart,scope:'session'}});await f.report(base,f.event(ids.ended,'end'));
  const asked=[];
  const probe=fakeProbe(h=>{asked.push(h.pid);return {11:'alive',12:'alive',13:'gone',14:'unknown',15:'alive'}[h.pid];});
  const rows=await createSessionDiscoveryBroker({integrationPath:f.integrationPath,journal:f.journal,processProbe:probe}).listFor(f.reader);
  const byAddress=name=>rows.find(r=>r.id===sessionAddress(f.integration.installationId,f.workspace,name==='codexShared'?'codex:'+ids[name]:ids[name]));
  const view=name=>{const r=byAddress(name);return [r.presence,r.presenceEvidence.kind,r.presenceEvidence.scope];};
  assert.deepEqual(view('claudeAlive'),['online','host-process','session']);
  assert.deepEqual(view('codexShared'),['unknown','host-process','shared'],'a shared app server being up does not prove this conversation is open');
  assert.deepEqual(view('gone'),['offline','host-process-gone',undefined]);
  assert.deepEqual(view('error'),['unknown','none',undefined],'an unreadable probe is unknown, never offline');
  assert.deepEqual(view('noHost'),['unknown','none',undefined]);
  assert.deepEqual(view('ended'),['offline','end-event',undefined]);
  assert.ok(!asked.includes(15),'an ended session is not probed');
  assert.ok(rows.every(r=>!r.capabilities.reachable&&!r.capabilities.wakeCapable));
  // A probe that throws must not break the directory.
  const broken=await createSessionDiscoveryBroker({integrationPath:f.integrationPath,journal:f.journal,processProbe:async()=>{throw new Error('ps failed');}}).listFor(f.reader);
  assert.equal(broken.length,6);assert.ok(broken.filter(r=>r.lifecycle!=='ended').every(r=>r.presence==='unknown'));
 }finally{await f.close();}
});
import {sessionAddress} from '../src/local-messaging-interactive-session.mjs';

test('journal keeps the last known title and replaces the host process only when a start or a reading says so',async()=>{
 const f=fixture();try{
  const b=f.broker(),sid=randomUUID(),now=Date.now();
  const a={pid:21,start:hostStart,scope:'session'},c={pid:22,start:hostStart,scope:'session'};
  const row=async()=>(await f.journal.listDiscoveredSessions({installationId:f.integration.installationId,workspace:f.workspace}))[0];
  await f.report(b,{...f.event(sid,'start',now-50),title:'First title',host:a});
  assert.deepEqual([(await row())._host.pid,(await row()).title],[21,'First title']);
  await f.report(b,f.event(sid,'activity',now-40));
  assert.deepEqual([(await row())._host.pid,(await row()).title],[21,'First title'],'an event that could not read them keeps both');
  await f.report(b,{...f.event(sid,'activity',now-30),title:'Renamed',host:c});
  assert.deepEqual([(await row())._host.pid,(await row()).title],[22,'Renamed']);
  await f.report(b,f.event(sid,'end',now-20));
  assert.equal((await row()).lifecycle,'ended');assert.equal((await row()).title,'Renamed');
  await f.report(b,f.event(sid,'start',now-10));
  assert.equal((await row())._host,undefined,'a new start without a readable host does not keep the old process');
  assert.equal((await row()).title,'Renamed');
  await f.reopen();assert.equal((await row()).title,'Renamed');
 }finally{await f.close();}
});

test('pre-title journal migrates additively and keeps its handle',async()=>{
 const f=fixture();try{
  const sid=randomUUID(),b=f.broker();const original=await f.report(b,{...f.event(sid,'start'),title:'Old',host:{pid:31,start:hostStart,scope:'session'}});
  await f.journal.close();
  const db=new DatabaseSync(path.join(f.root,'journal/local-messaging.sqlite'));
  db.exec('ALTER TABLE local_discovered_sessions DROP COLUMN title; ALTER TABLE local_discovered_sessions DROP COLUMN host_pid; ALTER TABLE local_discovered_sessions DROP COLUMN host_start; ALTER TABLE local_discovered_sessions DROP COLUMN host_scope');db.close();
  await f.reopen();
  const [row]=await createSessionDiscoveryBroker({integrationPath:f.integrationPath,journal:f.journal,processProbe:fakeProbe('alive')}).listFor(f.reader);
  assert.equal(row.id,original.id);assert.equal(row.title,undefined);assert.equal(row.presence,'unknown');assert.match(row.label,/^Claude · workspace · /);
  await f.report(f.broker(),{...f.event(sid,'activity'),title:'New'});assert.equal((await f.journal.listDiscoveredSessions({installationId:f.integration.installationId,workspace:f.workspace}))[0].title,'New');
 }finally{await f.close();}
});

test('host probe compares pid and exact start time, batches one ps call, caches briefly and says unknown when it cannot tell',async()=>{
 const child=spawn('/bin/sleep',['60']);await new Promise(resolve=>child.once('spawn',resolve));
 try{
  const start=execFileSync('/bin/ps',['-o','lstart=','-p',String(child.pid)],{env:{PATH:'/usr/bin:/bin',LC_ALL:'C',TZ:'UTC'}}).toString().trim();
  const real=createHostProcessProbe();
  const answer=await real([{pid:child.pid,start},{pid:child.pid,start:'Mon Jan 1 00:00:00 2001'},{pid:2147483,start}]);
  assert.equal(answer.get(hostKey({pid:child.pid,start})),'alive');
  assert.equal(answer.get(hostKey({pid:child.pid,start:'Mon Jan 1 00:00:00 2001'})),'gone','a reused pid with another start time is a different process');
  assert.equal(answer.get(hostKey({pid:2147483,start})),'gone');
  child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));
  assert.equal((await createHostProcessProbe()([{pid:child.pid,start}])).get(hostKey({pid:child.pid,start})),'gone');
 }finally{child.kill('SIGKILL');}
 let calls=0,now=1000;const out='   77 Sat Oct 24 22:20:32 2026\n';
 const counting=createHostProcessProbe({ps:async args=>{calls++;assert.deepEqual(args,['-axo','pid=,lstart=']);return out;},ttlMs:5000,clock:()=>now});
 const host={pid:77,start:hostStart};
 assert.equal((await counting([host,{pid:78,start:hostStart}])).get(hostKey(host)),'alive');assert.equal(calls,1,'all hosts in one call');
 await counting([host]);assert.equal(calls,1,'cached');now+=5001;await counting([host]);assert.equal(calls,2);
 const failing=createHostProcessProbe({ps:async()=>null});
 assert.equal((await failing([host])).get(hostKey(host)),'unknown');
 const rows=await withSessionPresence([{id:'x',lifecycle:'observed',lastSeenAt:1,_host:{...host,scope:'session'}}],{probe:failing});
 assert.equal(rows[0].presence,'unknown');assert.equal('_host' in rows[0],false);
});

test('Claude title and host come from the exact registry record of an ancestor that is this session, nothing else',async()=>{
 const f=ownerFixture();let host;
 try{
  const config=JSON.parse(fs.readFileSync(f.configPath));
  host=createInstalledLocalMessagingHost({configPath:f.configPath,runners:new Map([[config.recipients[0].instanceId,{run:async()=>({status:'completed',text:'x'})}]]),gate:createProfiledReasonerGate()});
  await host.start();
  const claudeHome=path.join(f.root,'claude-home'),sessions=path.join(claudeHome,'sessions');fs.mkdirSync(sessions,{recursive:true,mode:0o700});
  // The hook is spawned by this test process, so this process is its nearest ancestor.
  const start=execFileSync('/bin/ps',['-o','lstart=','-p',String(process.pid)],{env:{PATH:'/usr/bin:/bin',LC_ALL:'C',TZ:'UTC'}}).toString().trim().replace(/\s+/g,' ');
  const sid=randomUUID(),record={pid:process.pid,sessionId:sid,procStart:start,name:'Runtime discovery and acceptance todos',status:'busy',kind:'interactive',entrypoint:'claude-desktop',peerToken:'DO_NOT_READ_OR_STORE'};
  const registry=path.join(sessions,`${process.pid}.json`);fs.writeFileSync(registry,JSON.stringify(record),{mode:0o644});
  fs.writeFileSync(path.join(sessions,`${process.pid}.${'0'.repeat(64)}.key`),JSON.stringify({peerToken:'SECRET_KEY_FILE_SENTINEL'}),{mode:0o600});
  const hook=async(sessionId,eventName='UserPromptSubmit')=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[cli,'discovery-hook','--config',f.configPath],{env:{...process.env,CLAUDE_CONFIG_DIR:claudeHome}});
   let stderr='';child.stderr.on('data',x=>stderr+=x);child.once('error',reject);child.once('exit',code=>resolve({code,stderr}));
   child.stdin.end(JSON.stringify({session_id:sessionId,cwd:f.workspace,hook_event_name:eventName}));
  });
  const list=async()=>{let out='';await runLocalMessagingCLI(['sessions','--config',f.configPath],{output:{write:x=>out+=x}});return JSON.parse(out).sessions.filter(r=>r.harness==='claude');};
  assert.deepEqual(await hook(sid),{code:0,stderr:''});
  let [row]=await list();
  assert.equal(row.title,'Runtime discovery and acceptance todos');assert.ok(row.label.includes('Runtime discovery and acceptance todos'));
  assert.equal(row.presence,'online');assert.deepEqual([row.presenceEvidence.kind,row.presenceEvidence.scope],['host-process','session']);
  assert.equal(row.capabilities.reachable,false);assert.ok(!JSON.stringify(row).includes(String(process.pid)));
  // A different session in the same process tree gets none of it: the record names another session.
  const other=randomUUID();assert.deepEqual(await hook(other),{code:0,stderr:''});
  const rows=await list();const otherRow=rows.find(r=>r.label.endsWith(createHash('sha256').update(other).digest('hex').slice(0,8)));
  assert.equal(otherRow.title,undefined);assert.equal(otherRow.presence,'unknown');
  // A record left by an earlier owner of the pid (another start time) is not this process.
  fs.writeFileSync(registry,JSON.stringify({...record,procStart:'Mon Jan 1 00:00:00 2001'}),{mode:0o644});
  const reused=randomUUID();await hook(reused);
  assert.equal((await list()).find(r=>r.label.endsWith(createHash('sha256').update(reused).digest('hex').slice(0,8))).title,undefined);
  // Neither the secret key file nor any raw id is stored.
  const bytes=fs.readFileSync(path.join(config.stateRoot,'local-messaging.sqlite'));
  for(const secret of ['DO_NOT_READ_OR_STORE','SECRET_KEY_FILE_SENTINEL',sid])assert.equal(bytes.includes(Buffer.from(secret)),false);
  // Owners can keep titles out of the directory; presence evidence is unaffected.
  setupSessionDiscovery({config:f.configPath,workspace:f.workspace,'local-cli':path.join(f.root,'triangle-local'),titles:false});
  assert.equal(JSON.parse(fs.readFileSync(f.configPath)).discovery.titles,false);
  fs.writeFileSync(registry,JSON.stringify(record),{mode:0o644});
  await host.stop();host=createInstalledLocalMessagingHost({configPath:f.configPath,runners:new Map([[config.recipients[0].instanceId,{run:async()=>({status:'completed',text:'x'})}]]),gate:createProfiledReasonerGate()});await host.start();
  const quiet=randomUUID();fs.writeFileSync(registry,JSON.stringify({...record,sessionId:quiet}),{mode:0o644});await hook(quiet);
  const quietRow=(await list()).find(r=>r.label.endsWith(createHash('sha256').update(quiet).digest('hex').slice(0,8)));
  assert.equal(quietRow.title,undefined);assert.equal(quietRow.presenceEvidence.kind,'host-process');
 }finally{await host?.stop();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('the titles choice is kept across setups and can be turned back on',()=>{
 const f=ownerFixture();try{
  const args={config:f.configPath,workspace:f.workspace,'local-cli':path.join(f.root,'triangle-local')};
  assert.equal(setupSessionDiscovery({...args,titles:false}).titles,false);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath)).discovery.titles,false);
  assert.equal(setupSessionDiscovery({...args,harness:'codex'}).titles,false,'rerunning for another harness keeps the choice');
  assert.equal(setupSessionDiscovery({...args,titles:true}).titles,true);
  assert.equal('titles' in JSON.parse(fs.readFileSync(f.configPath)).discovery,false);
  const state=JSON.parse(fs.readFileSync(f.configPath));
  writePrivateJson(f.configPath,{...state,discovery:{...state.discovery,titles:'no'}});
  assert.throws(()=>createInstalledLocalMessagingHost({configPath:f.configPath,runners:new Map(),gate:createProfiledReasonerGate()}),{code:'invalid_local_config'});
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('Codex title prefers the name the user gave the chat, falls back to the generated one, and degrades to origin only',()=>{
 const root=fs.mkdtempSync('/private/tmp/triangle-codex-title-');
 try{
  const file=path.join(root,'state_5.sqlite'),env={CODEX_HOME:root},db=new DatabaseSync(file);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,source TEXT,name TEXT,title TEXT)');
  const ids=Array.from({length:4},()=>randomUUID());
  for(const [i,row] of [['cli','Review reason-network repo','Check this repo, I think they are doing the same'],['vscode',null,'Generated first-message title'],['exec','   ','Blank name falls back'],['cli',null,'']].entries())db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run(ids[i],...row);
  db.close();fs.chmodSync(file,0o600);
  assert.deepEqual(readCodexSessionMetadata(ids[0],env),{origin:'cli',title:'Review reason-network repo'});
  assert.deepEqual(readCodexSessionMetadata(ids[1],env),{origin:'vscode',title:'Generated first-message title'});
  assert.deepEqual(readCodexSessionMetadata(ids[2],env),{origin:'exec',title:'Blank name falls back'});
  assert.deepEqual(readCodexSessionMetadata(ids[3],env),{origin:'cli'});
  assert.deepEqual(readCodexSessionMetadata(randomUUID(),env),{origin:'unknown'});
  // An older or changed schema without the title columns still yields the origin.
  const old=path.join(root,'old');fs.mkdirSync(old,{mode:0o700});const oldDb=new DatabaseSync(path.join(old,'state_5.sqlite'));
  oldDb.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,source TEXT)');oldDb.prepare('INSERT INTO threads VALUES(?,?)').run(ids[0],'cli');oldDb.close();fs.chmodSync(path.join(old,'state_5.sqlite'),0o600);
  assert.deepEqual(readCodexSessionMetadata(ids[0],{CODEX_HOME:old}),{origin:'cli'});
  fs.chmodSync(file,0o666);assert.deepEqual(readCodexSessionMetadata(ids[0],env),{origin:'unknown'},'a database others can write is not trusted');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('process table and ancestry: parsed from one ps listing, bounded, cycle-safe; Codex host scope follows the app server',()=>{
 const listing=[
  '    1     0 Sat Oct 24 08:00:00 2026 /sbin/launchd',
  '  500     1 Sat Oct 24 09:00:00 2026 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enable',
  '  510   500 Sat Oct 24 09:00:05 2026 /bin/sh -c triangle-local discovery-hook --harness codex',
  '  520   510 Sat Oct 24 09:00:06 2026 node /x/triangle-local discovery-hook',
  '  600     1 Sat Oct  4 09:00:00 2026 /opt/homebrew/bin/codex exec --json hello',
  '  610   600 Sat Oct  4 09:00:01 2026 sh -c hook',
  '  700     1 Sat Oct 24 09:00:00 2026 /Applications/Some Tool/codex-helper run',
  '  710   700 Sat Oct 24 09:00:01 2026 sh -c hook',
  '  800   801 Sat Oct 24 09:00:00 2026 loop-a',
  '  801   800 Sat Oct 24 09:00:00 2026 loop-b',
  'garbage line',
 ].join('\n');
 const table=processTable(()=>listing);
 assert.equal(table.size,10);assert.equal(table.get(600).start,'Sat Oct 4 09:00:00 2026','start times are whitespace-normalized');
 assert.deepEqual(processAncestry(table,520).map(p=>p.pid),[520,510,500]);
 assert.deepEqual(readCodexSessionHost(processTableWith(table,520)),{pid:500,start:'Sat Oct 24 09:00:00 2026',scope:'shared'});
 assert.deepEqual(readCodexSessionHost(processTableWith(table,610)),{pid:600,start:'Sat Oct 4 09:00:00 2026',scope:'session'});
 assert.equal(readCodexSessionHost(processTableWith(table,710)),undefined,'no guess from a similarly named helper');
 assert.ok(processAncestry(table,800).length<=2,'a cycle ends the walk');
 assert.equal(processTable(()=>null),null);assert.deepEqual(processAncestry(null,5),[]);
 assert.deepEqual(readClaudeSessionMetadata(randomUUID(),{CLAUDE_CONFIG_DIR:'/private/tmp/does-not-exist'},table),{});
 assert.deepEqual(readClaudeSessionMetadata('not-a-uuid',{},table),{});
});
// readCodexSessionHost walks from this process's parent; tests present the synthetic table as if `pid` were that parent.
function processTableWith(table,pid){
 const shifted=new Map(table);shifted.set(process.ppid,{ppid:pid,start:'Sat Oct 24 09:10:00 2026',command:'node test'});return shifted;
}

import {reportDiscoveryEvent} from '../src/local-messaging-cli.mjs';
test('a hook newer than the supervisor falls back to the bare lifecycle event; other failures are not retried',async()=>{
 const seen=[];
 const client={discoveryChallenge:async({event})=>{seen.push(Object.keys(event).sort());if(event.title||event.host)throw Object.assign(new Error('strict schema'),{code:'invalid_discovery_event'});return {nonce:'n'};},reportDiscovery:async()=>({})};
 const event={eventId:randomUUID(),sessionId:randomUUID(),kind:'start',workspace:'/w',observedAt:1,title:'T',host:{pid:5,start:hostStart,scope:'session'}};
 await reportDiscoveryEvent(client,{installationId:'i',secret:'s'},event);
 assert.equal(seen.length,2);assert.deepEqual(seen[1],['eventId','kind','observedAt','sessionId','workspace']);
 let calls=0;
 await assert.rejects(reportDiscoveryEvent({discoveryChallenge:async()=>{calls++;throw Object.assign(new Error('no'),{code:'unauthorized'});}},{},event),{code:'unauthorized'});
 assert.equal(calls,1);
 calls=0;const {title,host,...bare}=event;
 await assert.rejects(reportDiscoveryEvent({discoveryChallenge:async()=>{calls++;throw Object.assign(new Error('bad'),{code:'invalid_discovery_event'});}},{},bare),{code:'invalid_discovery_event'});
 assert.equal(calls,1,'a bare event that is refused is a real failure');
});

test('titles off neither stores nor shows titles, including ones stored earlier',async()=>{
 const f=fixture();try{
  const sid=randomUUID(),scope={installationId:f.integration.installationId,workspace:f.workspace};
  await f.report(f.broker(),{...f.event(sid,'start'),title:'Stored while on'});
  assert.equal((await f.journal.listDiscoveredSessions(scope))[0].title,'Stored while on');
  await f.journal.close();
  const off=createLocalMessagingJournal({stateRoot:path.join(f.root,'journal'),titles:false});
  try{
   let [row]=await off.listDiscoveredSessions(scope);
   assert.equal(row.title,undefined);assert.match(row.label,/^Claude · workspace · /,'a stored title is hidden at once');
   await off.recordDiscoveryEvent({installationId:scope.installationId,event:{...f.event(sid,'activity'),title:'Typed while off'},digest:'off-1',receivedAt:Date.now()});
   [row]=await off.listDiscoveredSessions(scope);assert.equal(row.title,undefined);
  }finally{await off.close();}
  await f.reopen();
  assert.equal((await f.journal.listDiscoveredSessions(scope))[0].title,'Stored while on','nothing typed while off was stored, and nothing earlier was erased');
 }finally{await f.close();}
});
