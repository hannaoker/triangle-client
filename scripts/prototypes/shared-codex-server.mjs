import { spawn } from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const cwd = mkdtempSync(path.join(tmpdir(), 'mesh-shared-codex-'));
const binary = process.env.MESH_CODEX_BINARY || 'codex';
const reservation = net.createServer();
await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const endpoint = `ws://127.0.0.1:${port}`;
const server = spawn(binary, ['app-server', '--listen', endpoint], {cwd, stdio:['ignore','pipe','pipe']});
let logs=''; server.stderr.on('data',b=>{logs=(logs+b).slice(-6000)});
server.stdout.resume();
const clients=[]; let target;
const deadline = setTimeout(()=>{console.error('overall deadline');server.kill('SIGTERM');process.exitCode=2; for(const c of clients)c.ws.close();},180000);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function record(test,data={}) {console.log(JSON.stringify({at:new Date().toISOString(),test,...data}));}
class Client {
 constructor(name,ws){this.name=name;this.ws=ws;this.next=1;this.pending=new Map();this.events=[];
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);
 if(m.id!==undefined && !m.method){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}}
 else if(m.method && m.id!==undefined){ws.send(JSON.stringify({id:m.id,error:{code:-32601,message:'No interactive tools in protocol probe'}}));}
 else {this.events.push(m);if(['turn/started','turn/completed'].includes(m.method))record(m.method,{client:name,threadId:m.params?.threadId,turnId:m.params?.turn?.id,status:m.params?.turn?.status});}});
 }
 async call(method,params={}){const id=this.next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${this.name} ${method} timeout`))},30000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 async wait(method,predicate=()=>true,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const found=this.events.find(e=>e.method===method&&predicate(e));if(found)return found;await pause(20)}throw Error(`${this.name}: missing ${method}`)}
}
async function connect(name){const ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});const c=new Client(name,ws);clients.push(c);await c.call('initialize',{clientInfo:{name,title:name,version:'0.1.0'}});ws.send(JSON.stringify({method:'initialized',params:{}}));return c;}
const input=text=>[{type:'text',text}];
try{
 for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${port}/readyz`);if(r.ok)break}catch{} if(i===99)throw Error('server failed readiness');await pause(100)}
 record('server_ready',{pid:server.pid,endpoint});
 const ui=await connect('mesh_probe_ui'),bridge=await connect('mesh_probe_listener');
 const started=await ui.call('thread/start',{cwd,approvalPolicy:'never',sandbox:'read-only',ephemeral:false});target=started.thread.id;
 record('thread_created',{threadId:target});
 const baseline=await ui.call('turn/start',{threadId:target,input:input('Protocol test. Do not use tools. Reply exactly: UI_READY')});
 const baseDone=await ui.wait('turn/completed',e=>e.params.turn.id===baseline.turn.id);assert.equal(baseDone.params.turn.status,'completed');
 const attached=await bridge.call('thread/resume',{threadId:target});assert.equal(attached.thread.id,target);
 record('two_clients_one_thread');
 const state=await bridge.call('thread/read',{threadId:target});assert.equal(state.thread.status.type,'idle');record('idle_state',{status:state.thread.status});
 const wakeAt=Date.now();const wake=await bridge.call('turn/start',{threadId:target,input:input('Synthetic external MESH test event, not Bob. Do not use tools. Reply exactly: WAKE_RECEIVED')});
 await ui.wait('turn/started',e=>e.params.turn.id===wake.turn.id);record('idle_wake_visible_to_ui',{latencyMs:Date.now()-wakeAt});
 const queued={id:'synthetic-busy-1',text:'Synthetic MESH event queued during previous turn. Do not use tools. Reply exactly: QUEUED_RECEIVED'};
 assert.ok(!bridge.events.some(e=>e.method==='turn/completed'&&e.params.turn.id===wake.turn.id), 'wake turn must still be busy');
 record('event_queued_while_busy',{eventId:queued.id,activeTurnId:wake.turn.id});
 const finished=await bridge.wait('turn/completed',e=>e.params.turn.id===wake.turn.id);assert.equal(finished.params.turn.status,'completed');
 const queuedTurn=await bridge.call('turn/start',{threadId:target,input:input(queued.text)});
 const done=await ui.wait('turn/completed',e=>e.params.turn.id===queuedTurn.turn.id);assert.equal(done.params.turn.status,'completed');
 record('queued_event_completed_after_prior_turn');
 bridge.ws.close();const reconnected=await connect('mesh_probe_reconnected');const resumed=await reconnected.call('thread/resume',{threadId:target});assert.equal(resumed.thread.id,target);
 const history=await reconnected.call('thread/read',{threadId:target,includeTurns:true});
 record('reconnect_same_thread',{turnCount:history.thread.turns?.length,turns:history.thread.turns?.map(t=>({id:t.id,status:t.status,text:t.items?.filter(i=>i.type==='agentMessage').map(i=>i.text)}))});
 assert.equal(history.thread.turns?.length,3);
 assert.deepEqual(history.thread.turns.map(t=>t.items.filter(i=>i.type==='agentMessage').map(i=>i.text).join('')), ['UI_READY','WAKE_RECEIVED','QUEUED_RECEIVED']);
 record('PASS');
}catch(e){record('FAIL',{message:e.message,serverLogTail:logs.slice(-2500)});process.exitCode=1}
finally{clearTimeout(deadline);for(const c of clients)c.ws.close();server.kill('SIGTERM');const kill=setTimeout(()=>server.kill('SIGKILL'),3000);await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));clearTimeout(kill);record('server_stopped');}
