import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createClientSupervisor} from '../src/client-supervisor.mjs';
import {setupLocalMessaging} from '../src/local-messaging-cli.mjs';
import {readPrivateJson,writePrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {createLocalMessagingJournal} from '../src/local-messaging-journal.mjs';
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
 ['a missing recipient lane','lane','local_recipient_unavailable'],
]) {
 test(`${label} disables only the local route; MESH lanes keep running and the failure is reported`,async()=>{
  const f=localFixture(),lane=meshLane(),events=[],sleeps=[];
  try{
   if(config==='identity')writePrivateJson(f.bindingPath,{...readPrivateJson(f.bindingPath),instanceId:'b'.repeat(64)});
   const supervisor=createClientSupervisor({
    instances:[instance(config==='lane'?'2'.repeat(64):gravityId)],localMessaging:{configPath:f.configPath},createDeliveryClient:()=>({}),createWorker:lane.createWorker,
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
