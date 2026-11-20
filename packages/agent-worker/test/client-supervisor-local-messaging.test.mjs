import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createClientSupervisor} from '../src/client-supervisor.mjs';
import {sanitizedLogger} from '../src/client-supervisor-cli.mjs';
import {setupLocalMessaging} from '../src/local-messaging-cli.mjs';
import {readPrivateJson,writePrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {createLocalMessagingJournal} from '../src/local-messaging-journal.mjs';
import {resolveLocalSocketAddress} from '../src/local-messaging-address.mjs';
import {waitFor} from './local-messaging-fixtures.mjs';
import {TEST_WORKLOAD,testKey} from './support/test-workload.mjs';
const id='1'.repeat(64);
const gravityId=createHash('sha256').update('triangle-client-instance-v1\0gravity2').digest('hex');
function instance(instanceId=id){return {instanceId,mailbox:{meshUrl:'https://mesh.example',recipientId:'agent_'+'a'.repeat(32),workloadId:TEST_WORKLOAD.workloadId,workloadPrivateKey:testKey('local')},runner:{command:'/trusted/runner',args:[],timeoutMs:1000},runnerEnvironment:{PATH:'/usr/bin',TRIANGLE_INSTANCE_ID:instanceId}};}
test('local host reuses profile runners with serialization across MESH and local work',async()=>{
 let captured,meshRunner,active=0,peak=0,hostStopped=false;
 const supervisor=createClientSupervisor({
  instances:[instance()],localMessaging:{configPath:'/private/local.json'},
  createLocalMessagingHost:opts=>{captured=opts;return {status:()=>({running:false}),stop:async()=>{hostStopped=true;},watch:async()=>{}};},
  createDeliveryClient:()=>({}),createWorker:({runner})=>{meshRunner=runner;return {runOnce:async()=>({}),watch:async()=>({})};},
  createRunner:()=>({run:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,15));active--;return {status:'completed',text:'ok'};}}),
 });
 assert.ok(captured,'configured local host is attached to existing supervisor');
 await Promise.all([meshRunner.run({}),captured.gate.run(()=>captured.runners.get(id).run({}),{instanceId:id})]);
 assert.equal(peak,1,'local and MESH turns for a profile must not overlap');
 await supervisor.close();assert.equal(hostStopped,true);
});

test('profile wait is abortable and does not occupy a global reasoning slot',async()=>{
 const {createProfiledReasonerGate}=await import('../src/concurrency-gate.mjs');
 const gate=createProfiledReasonerGate({limit:2});
 let release;const held=new Promise(r=>{release=r;});
 const running=gate.run(()=>held,{instanceId:'a'});
 await new Promise(r=>setImmediate(r));
 const abort=new AbortController();
 const queued=gate.run(()=>assert.fail('cancelled profile turn started'),{instanceId:'a',signal:abort.signal});
 const cancelled=assert.rejects(queued,{name:'AbortError'});
 abort.abort();let otherRan=false;
 const other=gate.run(()=>{otherRan=true;},{instanceId:'b'});
 await new Promise(r=>setTimeout(r,20));
 try{assert.equal(otherRan,true);await cancelled;}finally{release();await Promise.allSettled([running,queued,other]);}
});

// Local route failures must never take down the MESH lanes that share the supervisor.
function localFixture(){
 const root=fs.mkdtempSync('/private/tmp/lm-sup-');
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
 writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'thread-current',enabled:false});
 setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'thread-current',recipients:['gravity2']});
 return {root,configPath,bindingPath,stateRoot:readPrivateJson(configPath).stateRoot,secret:readPrivateJson(path.join(readPrivateJson(configPath).stateRoot,'desktop-integration.json')).secret};
}
function meshLane(){
 const lane={watching:false};
 lane.createWorker=()=>({runOnce:async()=>({}),watch:async({signal})=>{lane.watching=true;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {processed:0,stopped:true};}});
 return lane;
}
function supervisorFor(extra,lane=meshLane(),events=[]){
 return createClientSupervisor({
  instances:[instance(gravityId)],createDeliveryClient:()=>({}),createWorker:lane.createWorker,
  createRunner:()=>({run:async()=>({status:'completed',text:'ok'})}),random:()=>0,
  logger:{error:(event,detail)=>events.push({event,code:detail?.code})},...extra,
 });
}
const quickSleep=sleeps=>ms=>{sleeps.push(ms);return new Promise(r=>setTimeout(r,2));};
for(const [label,config,code] of [
 ['a changed desktop identity','identity','binding_changed'],
]) {
 test(`${label} disables only the local route; MESH lanes keep running and the failure is reported`,async()=>{
  const f=localFixture(),lane=meshLane(),events=[],sleeps=[];
  try{
   if(config==='identity')writePrivateJson(f.bindingPath,{...readPrivateJson(f.bindingPath),instanceId:'b'.repeat(64)});
   const supervisor=createClientSupervisor({
    instances:[instance(gravityId)],localMessaging:{configPath:f.configPath},createDeliveryClient:()=>({}),createWorker:lane.createWorker,
    createRunner:()=>({run:async()=>({status:'completed',text:'ok'})}),random:()=>0,logger:{error:(event,detail)=>events.push({event,code:detail?.code})},
   });
   assert.equal(supervisor.localStatus().failure.code,code,'failure is visible before watch starts');
   const controller=new AbortController();
   const watching=supervisor.watch({signal:controller.signal,sleep:quickSleep(sleeps)});
   await waitFor(()=>lane.watching,{message:'MESH lane watch'});
   await waitFor(()=>supervisor.localStatus().failure?.attempts>=3,{message:'local retries'});
   const status=supervisor.localStatus();
   assert.equal(status.enabled,true);assert.equal(status.running,false);assert.equal(status.state,'failed');assert.equal(status.failure.code,code);
   assert.deepEqual(sleeps.slice(0,2),[5000,10000],'local retries back off exponentially');
   assert.ok(events.some(e=>e.event==='triangle_client_local_messaging_failed'&&e.code===code));
   assert.ok(!JSON.stringify(status).includes(f.secret),'status never carries secrets');
   controller.abort();await watching;
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
}
// A disabled agent (no runtime for a configured recipient) must not take the local route down for
// everyone else: the route runs, the agent is listed as unavailable and its queued work waits.
test('a recipient whose runtime is not running leaves the local route running and lists it as unavailable',async()=>{
 const f=localFixture(),lane=meshLane();let written='';
 // The production logger, so the test sees what the owner sees on stderr.
 const logger=sanitizedLogger({write:chunk=>{written+=chunk;}});
 // A failed assertion must still stop the watch, or the test file never exits.
 const controller=new AbortController();let watching=null;
 try{
  const supervisor=createClientSupervisor({
   instances:[instance('2'.repeat(64))],localMessaging:{configPath:f.configPath},createDeliveryClient:()=>({}),createWorker:lane.createWorker,
   createRunner:()=>({run:async()=>({status:'completed',text:'ok'})}),random:()=>0,logger,
  });
  assert.equal(supervisor.localStatus().failure,undefined,'the host is built');
  watching=supervisor.watch({signal:controller.signal,sleep:quickSleep([])});
  await waitFor(()=>lane.watching,{message:'MESH lane watch'});
  await waitFor(()=>supervisor.localStatus().state==='running',{message:'local route running'});
  const status=supervisor.localStatus();
  assert.deepEqual(status.unavailableRecipients,['gravity2']);
  assert.equal(status.failure,undefined);
  assert.match(written,new RegExp(` triangle-client: notice \\[local_recipient_not_running\\] profile=gravity2 instance=${gravityId.slice(0,12)}\\n`),'the log names the agent that is not running');
  assert.ok(!written.includes('[local_messaging_failed]'),'no local failure is logged');
  assert.ok(!written.includes(f.secret)&&!JSON.stringify(status).includes(f.secret),'neither the log nor status carries secrets');
  controller.abort();await watching;
 }finally{controller.abort();await watching?.catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});
test('the production notice writes only a fixed event id, a valid profile name and an instance prefix',()=>{
 let written='';
 const logger=sanitizedLogger({write:chunk=>{written+=chunk;}},{now:()=>Date.parse('2026-11-20T00:00:00.000Z')});
 logger.notice('triangle_client_local_recipient_not_running',{profile:'gravity2',instanceId:'a'.repeat(64),secret:'s3cret'});
 logger.notice('Recipient gravity2 has secret s3cret',{profile:'gravity2'});
 logger.notice('triangle_client_local_recipient_not_running',{profile:'bad name s3cret',instanceId:'not-an-id'});
 assert.equal(written,'2026-11-20T00:00:00.000Z triangle-client: notice [local_recipient_not_running] profile=gravity2 instance=aaaaaaaaaaaa\n'
  +'2026-11-20T00:00:00.000Z triangle-client: notice [local_recipient_not_running]\n');
});
// The production wiring end to end (supervisor, local host, journal, production logger): what a restart that
// interrupted local work puts in the owner's log, and that a client's malformed frame, which the server answers,
// never reaches it (the server's warning about it is free-form; the production logger has no `warn`).
test('local work held after a restart is counted in the owner log, and a malformed client frame is not logged',async()=>{
 const f=localFixture(),lane=meshLane();let written='';
 const logger=sanitizedLogger({write:chunk=>{written+=chunk;}});
 const seed=createLocalMessagingJournal({stateRoot:f.stateRoot});
 await seed.recordSend({sender:'1'.repeat(64),recipient:gravityId,messageId:'m-inflight',requestId:'r-inflight',text:`in flight when the service stopped ${f.root}`});
 await seed.claimExecution('m-inflight');await seed.close();
 const controller=new AbortController();let watching=null;
 try{
  const supervisor=createClientSupervisor({
   instances:[instance(gravityId)],localMessaging:{configPath:f.configPath},createDeliveryClient:()=>({}),createWorker:lane.createWorker,
   createRunner:()=>({run:async()=>({status:'completed',text:'ok'})}),random:()=>0,logger,
  });
  watching=supervisor.watch({signal:controller.signal,sleep:quickSleep([])});
  await waitFor(()=>supervisor.localStatus().state==='running',{message:'local route running'});
  assert.match(written,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z triangle-client: notice \[local_messaging_held_on_recovery\] count=1$/m,'the owner log says how much work waits for reconciliation');
  const before=written;
  const answer=await new Promise(resolve=>{
   const socket=net.createConnection(resolveLocalSocketAddress({stateRoot:f.stateRoot}).socketPath),chunks=[];
   socket.on('data',chunk=>chunks.push(chunk));socket.on('error',()=>{});socket.on('close',()=>resolve(Buffer.concat(chunks)));
   socket.on('connect',()=>{const body=Buffer.from(`{ not json ${f.root}`),head=Buffer.alloc(4);head.writeUInt32BE(body.length);socket.write(Buffer.concat([head,body]));});
  });
  assert.equal(JSON.parse(answer.subarray(4,4+answer.readUInt32BE(0)).toString('utf8')).error.code,'invalid_json','the server took its parser-error path and told the client');
  assert.equal(written,before,'nothing about the malformed frame reaches the owner log');
  assert.ok(!written.includes(f.root)&&!written.includes(f.secret),'no paths, contents or secrets in the owner log');
  controller.abort();await watching;
 }finally{controller.abort();await watching?.catch(()=>{});fs.rmSync(f.root,{recursive:true,force:true});}
});
test('a busy local journal is retried while MESH lanes run, then the local route recovers',async()=>{
 const f=localFixture(),lane=meshLane(),events=[];
 const competing=createLocalMessagingJournal({stateRoot:f.stateRoot});
 let released=false;
 try{
  const supervisor=supervisorFor({localMessaging:{configPath:f.configPath}},lane,events);
  assert.equal(supervisor.localStatus().failure,undefined,'a valid configuration builds the host');
  const controller=new AbortController();
  const watching=supervisor.watch({signal:controller.signal,sleep:quickSleep([])});
  await waitFor(()=>lane.watching,{message:'MESH lane watch'});
  await waitFor(()=>supervisor.localStatus().failure?.code==='journal_busy',{message:'journal_busy report'});
  assert.equal(supervisor.localStatus().running,false);
  await competing.close();released=true;
  await waitFor(()=>supervisor.localStatus().running===true,{message:'local recovery'});
  assert.equal(supervisor.localStatus().failure,undefined);assert.equal(supervisor.localStatus().state,'running');
  controller.abort();await watching;
  assert.equal(supervisor.localStatus().running,false);assert.equal(supervisor.localStatus().state,'stopped');
 }finally{if(!released)await competing.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('a rejected local host watch never rejects the supervisor watch and is retried',async()=>{
 const lane=meshLane(),events=[];let attempts=0;
 const supervisor=supervisorFor({localMessaging:{configPath:'/private/local.json'},createLocalMessagingHost:()=>({
  status:()=>({running:attempts>1}),stop:async()=>{},
  watch:async({signal,onStarted})=>{
   if(++attempts===1)throw Object.assign(new Error('Another delivery service is active'),{code:'journal_busy'});
   onStarted();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));
  },
 })},lane,events);
 const controller=new AbortController();
 const watching=supervisor.watch({signal:controller.signal,sleep:quickSleep([])});
 await waitFor(()=>supervisor.localStatus().running===true,{message:'retry after rejected watch'});
 assert.ok(lane.watching);assert.ok(events.some(e=>e.code==='journal_busy'));assert.equal(supervisor.localStatus().failure,undefined);
 controller.abort();await watching;
});
test('local status is never healthy by omission and a failing host stop cannot break close',async()=>{
 const events=[];
 const quiet=supervisorFor({localMessaging:{configPath:'/private/local.json'},createLocalMessagingHost:()=>({status:()=>({}),stop:async()=>{throw new Error('stop failed');},watch:async()=>{}})},meshLane(),events);
 const before=quiet.localStatus();
 assert.equal(before.enabled,true);assert.equal(before.running,false);assert.equal(before.state,'starting');
 await quiet.close();
 assert.equal(quiet.localStatus().state,'stopped');assert.ok(events.some(e=>e.event==='triangle_client_local_messaging_stop_failed'));
 assert.deepEqual(supervisorFor({}).localStatus(),{enabled:false,route:'same-device'});
});
