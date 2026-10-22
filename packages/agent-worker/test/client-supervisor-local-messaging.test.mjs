import test from 'node:test';
import assert from 'node:assert/strict';
import {createClientSupervisor} from '../src/client-supervisor.mjs';
import {TEST_WORKLOAD,testKey} from './support/test-workload.mjs';
const id='1'.repeat(64);
function instance(){return {instanceId:id,mailbox:{meshUrl:'https://mesh.example',recipientId:'agent_'+'a'.repeat(32),workloadId:TEST_WORKLOAD.workloadId,workloadPrivateKey:testKey('local')},runner:{command:'/trusted/runner',args:[],timeoutMs:1000},runnerEnvironment:{PATH:'/usr/bin',TRIANGLE_INSTANCE_ID:id}};}
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
