// Archived native-desktop experiment, not a production launcher.
// Reads normal Codex state; desktop startup can mutate backend settings.
// See docs/triangle-client/codex-desktop-wake-handoff.md before reuse.
if (process.env.MESH_ALLOW_DESKTOP_EXPERIMENT !== "1") {
  throw new Error("Opt-in required; review the handoff and isolate/back up state first");
}
import {spawn} from 'node:child_process';
import net from 'node:net';
import {mkdirSync} from 'node:fs';
const root=process.env.MESH_DESKTOP_TEST_ROOT;
if (!root || !root.startsWith('/private/tmp/')) throw new Error('Set a fresh private temporary test root');
mkdirSync(root+'/ui',{mode:0o700,recursive:true});mkdirSync(root+'/codex',{mode:0o700,recursive:true});
const log=(test,data={})=>console.log(JSON.stringify({at:new Date().toISOString(),test,...data}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const backend=await port();const server=spawn('/Applications/ChatGPT.app/Contents/Resources/codex',['-c','mcp_servers.codex_app={command="/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools/scripts/launch_codex_app_tools_mcp",args=["./server.mjs"],cwd="/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools",enabled=false}','app-server','--listen',`ws://127.0.0.1:${backend}`],{cwd:root,stdio:['ignore','pipe','pipe']});server.stdout.resume();let errors='';server.stderr.on('data',b=>{errors=(errors+b).slice(-2000)});
let desktop,ws;const sockets=new Set(),methods=[];let peer=0;const target=process.env.MESH_DESKTOP_TEST_THREAD_ID;
if (!target) throw new Error('Set a disposable persisted test thread ID');let attached=false;
const proxy=net.createServer(client=>{const id=++peer;sockets.add(client);const upstream=net.connect(backend,'127.0.0.1');sockets.add(upstream);log('desktop_connection',{id});
 let outgoing=Buffer.alloc(0),headers=true;upstream.on('data',chunk=>{outgoing=Buffer.concat([outgoing,chunk]);if(headers){const n=outgoing.indexOf('\r\n\r\n');if(n<0)return;outgoing=outgoing.subarray(n+4);headers=false;}while(outgoing.length>=2){let length=outgoing[1]&127,offset=2;if(length===126){if(outgoing.length<4)return;length=outgoing.readUInt16BE(2);offset=4;}else if(length===127){if(outgoing.length<10)return;length=Number(outgoing.readBigUInt64BE(2));offset=10;}if(outgoing.length<offset+length)return;const opcode=outgoing[0]&15,payload=outgoing.subarray(offset,offset+length);outgoing=outgoing.subarray(offset+length);if(opcode!==1)continue;try{const m=JSON.parse(payload);if(['turn/started','turn/completed','thread/started'].includes(m.method))log('notification_to_desktop',{method:m.method,threadId:m.params?.threadId??m.params?.thread?.id,turnId:m.params?.turn?.id,status:m.params?.turn?.status});}catch{}}});
 let buf=Buffer.alloc(0),http=true;
 client.on('data',chunk=>{buf=Buffer.concat([buf,chunk]);if(http){const i=buf.indexOf('\r\n\r\n');if(i<0)return;log('desktop_upgrade',{id,request:buf.toString('utf8',0,buf.indexOf('\r\n'))});buf=buf.subarray(i+4);http=false;}
 while(buf.length>=2){let size=buf[1]&127,offset=2;if(size===126){if(buf.length<4)return;size=buf.readUInt16BE(2);offset=4;}else if(size===127){if(buf.length<10)return;size=Number(buf.readBigUInt64BE(2));offset=10;}const masked=!!(buf[1]&128),opcode=buf[0]&15;if(size>16*1024*1024){client.destroy();return;}if(buf.length<offset+(masked?4:0)+size)return;let mask=masked?buf.subarray(offset,offset+4):null;offset+=masked?4:0;const payload=Buffer.from(buf.subarray(offset,offset+size));buf=buf.subarray(offset+size);if(mask)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];if(opcode!==1)continue;try{const m=JSON.parse(payload);if(m.method){methods.push(m.method);log('desktop_rpc',{id,method:m.method});}}catch{}}
 });client.pipe(upstream);upstream.pipe(client);client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
});
try{
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${backend}/readyz`)).ok)break}catch{}await sleep(100);if(i===99)throw Error('backend readiness failed')}
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const front=proxy.address().port;log('ready',{backend,front,serverPid:server.pid});
 const desktopEnv={...process.env,CODEX_APP_SERVER_WS_URL:`ws://127.0.0.1:${front}/rpc`,CODEX_ELECTRON_USER_DATA_PATH:root+'/ui'};
 desktop=spawn('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',['--user-data-dir='+root+'/ui','--remote-debugging-port=63999','codex://threads/'+target],{cwd:root,env:desktopEnv,stdio:['ignore','pipe','pipe']});
 desktop.stdout.on('data',b=>{const t=b.toString();if(t.includes(target)){if(t.includes('thread_stream_view_activity_changed active=true'))attached=true;log('target_desktop_log',{text:t.split('\n').filter(l=>l.includes(target)).join('\n').slice(0,1800)});}});desktop.stderr.resume();desktop.on('error',e=>log('desktop_error',{message:e.message}));log('desktop_launched',{pid:desktop.pid});
 await sleep(30000);
 const opener=spawn('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',['--user-data-dir='+root+'/ui','codex://threads/'+target],{cwd:root,env:desktopEnv,stdio:'ignore'});
 opener.on('error',e=>log('opener_error',{message:e.message}));
 for(let i=0;i<30;i++){await sleep(1000);if(desktop.exitCode!==null){log('desktop_exited',{code:desktop.exitCode});break;}if(methods.includes('thread/resume')){log('desktop_resume_observed');attached=true;break;}}
 if(attached){
 ws=new WebSocket(`ws://127.0.0.1:${backend}`);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let seq=0;const pending=new Map();let completed;
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id!==undefined){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.j(Error(JSON.stringify(m.error))):p.r(m.result);}}else if(m.method==='turn/completed'){completed=m.params.turn;log('external_turn_completed',{status:completed.status});}};
 const call=(method,params)=>new Promise((r,j)=>{const id=++seq;pending.set(id,{r,j});ws.send(JSON.stringify({id,method,params}));});
 await call('initialize',{clientInfo:{name:'mesh_desktop_external_probe',version:'0.1'}});ws.send(JSON.stringify({method:'initialized',params:{}}));await call('thread/resume',{threadId:target});
 const turn=await call('turn/start',{threadId:target,input:[{type:'text',text:'Synthetic external desktop shared-server probe, not Bob. Do not use tools. Reply exactly DESKTOP_SHARED_WAKE_OK.'}]});log('external_turn_started',{threadId:target,turnId:turn.turn.id});
 for(let i=0;i<45&&!completed;i++)await sleep(1000);if(!completed)throw Error('model turn timed out');await sleep(20000);ws.close();
 }
 log('result',{desktopPid:desktop.pid,connected:peer>0,initialized:methods.includes('initialize'),listedThreads:methods.includes('thread/list'),methods:[...new Set(methods)]});
}catch(e){log('failure',{message:e.message,serverErrors:errors});process.exitCode=1}
finally{ws?.close();desktop?.kill('SIGTERM');await sleep(1000);if(desktop&&desktop.exitCode===null)desktop.kill('SIGKILL');for(const s of sockets)s.destroy();proxy.close();server.kill('SIGTERM');await sleep(1000);if(server.exitCode===null)server.kill('SIGKILL');log('cleanup_complete');process.exit(process.exitCode??0);}

