import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
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

import {setupLocalMessaging,setupSessionDiscovery,runLocalMessagingCLI} from '../src/local-messaging-cli.mjs';
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
  assert.ok(discovered.every(row=>ids.some(id=>row.label.endsWith(id.slice(0,8)))));
  assert.ok(!JSON.stringify(discovered).includes('DO_NOT_STORE'));
  assert.equal((await run(['discover'])).recipients.length,1,'legacy discovery does not acquire new routes');
  await assert.rejects(run(['send','--to',discovered[0].id,'--text','must not run']),/recipient|authorized|allowed/i);
  assert.equal(executions,0);
  await invokeHook(configPath,{session_id:ids[0],cwd:workspace,hook_event_name:'SessionEnd'});
  sessions=(await run(['sessions'])).sessions;assert.equal(sessions.filter(row=>row.presence==='offline').length,1);
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
