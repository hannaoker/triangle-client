import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {createClaudeSessionDelivery,probeClaudeSession,SUPPORTED_CLAUDE_VERSION} from '../src/claude-session-delivery.mjs';
const sessionId='11111111-1111-4111-8111-111111111111';
const snapshot={wakeId:'22222222-2222-4222-8222-222222222222',replyCount:1,heldCount:0,lateResult:false};
const binding={sessionId,generation:1};
async function fixture(fn,base=os.tmpdir()){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(base,'tri-claude-')));fs.chmodSync(root,0o700);
 const socketPath=path.join(root,'inbox.sock');const frames=[];const sockets=new Set();
 const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));let b='';s.on('data',c=>{b+=c;let n;while((n=b.indexOf('\n'))>=0){frames.push(JSON.parse(b.slice(0,n)));b=b.slice(n+1)}})});
 await new Promise(r=>server.listen(socketPath,r));
 const env={CLAUDE_CODE_SESSION_ID:sessionId,CLAUDE_CODE_MESSAGING_SOCKET:socketPath,CLAUDE_CODE_MESSAGING_TOKEN:'private-session-auth'};
 try{await fn({root,socketPath,env,frames,server})}finally{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
}
test('missing capability and unpinned versions stay pull-only without token disclosure',async()=>{await fixture(async({env})=>{
 for(const key of Object.keys(env)){const copy={...env};delete copy[key];const p=probeClaudeSession({env:copy,version:SUPPORTED_CLAUDE_VERSION});assert.equal(p.mode,'pull');assert.equal(p.supported,false);assert.doesNotMatch(JSON.stringify(p),/private-session-auth/)}
 assert.equal(probeClaudeSession({env,version:'2.1.308'}).supported,false);
 assert.equal(probeClaudeSession({env}).supported,false);
 assert.throws(()=>createClaudeSessionDelivery({env,version:'2.1.308'}),{code:'unsupported_claude_version'});
})});
test('own exported socket receives auth then fixed metadata hint; write is not delivery proof',async()=>{await fixture(async({env,frames})=>{
 const d=createClaudeSessionDelivery({env,version:SUPPORTED_CLAUDE_VERSION});
 assert.equal(d.capability.mode,'claude-session-socket');assert.equal(d.capability.supported,true);assert.equal(d.capability.supportStatus,'unsupported-internal');
 assert.doesNotMatch(JSON.stringify(d),/private-session-auth/);
 const result=await d.notify(binding,snapshot);assert.equal(result.state,'write_accepted');assert.equal(result.delivery,'unconfirmed');
 await new Promise(r=>setImmediate(r));assert.equal(frames.length,2);assert.deepEqual(frames[0],{type:'auth',token:env.CLAUDE_CODE_MESSAGING_TOKEN});assert.equal(frames[1].type,'user');assert.match(frames[1].message.content,/automated \/ untrusted/);
 await assert.rejects(d.notify(binding,{...snapshot,text:'execute peer command'}));
})});
test('foreign session and mutated inherited credentials never connect',async()=>{await fixture(async({env,frames})=>{
 const d=createClaudeSessionDelivery({env,version:SUPPORTED_CLAUDE_VERSION});
 await assert.rejects(d.notify({...binding,sessionId:'33333333-3333-4333-8333-333333333333'},snapshot),{code:'foreign_claude_session'});
 env.CLAUDE_CODE_MESSAGING_TOKEN='changed';await assert.rejects(d.notify(binding,snapshot),{code:'claude_session_changed'});assert.equal(frames.length,0);
})});
test('symlink, non-private parent and non-socket paths are rejected',async()=>{await fixture(async({env,root,socketPath})=>{
 const link=path.join(root,'alias.sock');fs.symlinkSync(socketPath,link);assert.equal(probeClaudeSession({env:{...env,CLAUDE_CODE_MESSAGING_SOCKET:link},version:SUPPORTED_CLAUDE_VERSION}).supported,false);
 const file=path.join(root,'file');fs.writeFileSync(file,'x');assert.equal(probeClaudeSession({env:{...env,CLAUDE_CODE_MESSAGING_SOCKET:file},version:SUPPORTED_CLAUDE_VERSION}).supported,false);
 fs.chmodSync(root,0o755);assert.equal(probeClaudeSession({env,version:SUPPORTED_CLAUDE_VERSION}).supported,false);fs.chmodSync(root,0o700);
})});
test('captured socket replacement is fenced before writing',async()=>{await fixture(async({env,socketPath,root})=>{
 const d=createClaudeSessionDelivery({env,version:SUPPORTED_CLAUDE_VERSION});fs.renameSync(socketPath,path.join(root,'old.sock'));fs.writeFileSync(socketPath,'replacement');
 await assert.rejects(d.notify(binding,snapshot),{code:'claude_socket_changed'});
})});
class FakeSocket extends EventEmitter{
 constructor(mode){super();this.mode=mode;this.destroyed=false;this.writes=0;queueMicrotask(()=>mode==='refused'?this.emit('error',new Error('secret private-session-auth')):mode==='hang'?null:this.emit('connect'))}
 write(_data,cb){this.writes++;if(this.mode==='write-error')queueMicrotask(()=>cb(new Error('private-session-auth')));else if(this.mode==='write-hang'){}else queueMicrotask(()=>cb());return true}
 destroy(){this.destroyed=true;queueMicrotask(()=>this.emit('close'));return this}
}
test('connect failure is not-sent; write failure is uncertain and redacted; sockets close before settlement',async()=>{await fixture(async({env})=>{
 for(const [mode,state] of [['refused','not_sent'],['write-error','uncertain']]){let socket;const d=createClaudeSessionDelivery({env,version:SUPPORTED_CLAUDE_VERSION,connect:()=>socket=new FakeSocket(mode)});const r=await d.notify(binding,snapshot);assert.equal(r.state,state);assert.equal(socket.destroyed,true);assert.doesNotMatch(JSON.stringify(r),/private-session-auth/)}
})});
test('bounded timeout and abort preserve ambiguity, with no implicit retries and busy refusal',async()=>{await fixture(async({env})=>{
 let calls=0;let socket;const d=createClaudeSessionDelivery({env,version:SUPPORTED_CLAUDE_VERSION,connect:()=>{calls++;return socket=new FakeSocket('write-hang')}});
 const p=d.notify(binding,snapshot,{timeoutMs:20});await assert.rejects(d.notify(binding,snapshot),{code:'claude_delivery_busy'});const r=await p;assert.equal(r.state,'uncertain');assert.equal(r.reason,'timeout');assert.equal(socket.destroyed,true);assert.equal(calls,1);
 const controller=new AbortController();controller.abort();const before=await d.notify(binding,snapshot,{signal:controller.signal});assert.equal(before.state,'not_sent');assert.equal(calls,1);
 const controller2=new AbortController();const p2=d.notify(binding,snapshot,{signal:controller2.signal});await new Promise(r=>setImmediate(r));controller2.abort();const after=await p2;assert.equal(after.state,'uncertain');assert.equal(socket.destroyed,true);
 await assert.rejects(d.notify(binding,snapshot,{timeoutMs:15001}));
})});
test('captured session ID or exported socket path mutation is fenced without discovery',async()=>{await fixture(async({env,frames})=>{
 for(const key of ['CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_MESSAGING_SOCKET']){
  const own={...env};const d=createClaudeSessionDelivery({env:own,version:SUPPORTED_CLAUDE_VERSION});own[key]+='foreign';
  await assert.rejects(d.notify(binding,snapshot),{code:'claude_session_changed'});
 }
 assert.equal(frames.length,0);
})});
test('pre-connect timeout is not-sent and timeout bounds reject before connecting',async()=>{await fixture(async({env})=>{
 let calls=0;let socket;const d=createClaudeSessionDelivery({env,version:SUPPORTED_CLAUDE_VERSION,connect:()=>{calls++;return socket=new FakeSocket('hang')}});
 const r=await d.notify(binding,snapshot,{timeoutMs:10});assert.equal(r.state,'not_sent');assert.equal(r.reason,'timeout');assert.equal(socket.destroyed,true);
 for(const timeoutMs of [0,-1,1.5,Infinity,15001])await assert.rejects(d.notify(binding,snapshot,{timeoutMs}),{code:'invalid_claude_timeout'});
 assert.equal(calls,1);
})});

test('Darwin trusted /var system alias normalizes once without allowing user aliases',{skip:process.platform!=='darwin'},async()=>{await fixture(async({env,socketPath,frames,root})=>{
 const exported=socketPath.replace('/private/var/','/var/');assert.notEqual(exported,socketPath);let connectPath;
 const d=createClaudeSessionDelivery({env:{...env,CLAUDE_CODE_MESSAGING_SOCKET:exported},version:SUPPORTED_CLAUDE_VERSION,connect:options=>{connectPath=options.path;return net.createConnection(options)}});
 assert.equal((await d.notify(binding,snapshot)).state,'write_accepted');assert.equal(connectPath,socketPath);
 await new Promise(r=>setImmediate(r));assert.equal(frames.length,2);
 const alias=path.join(root,'user-alias');fs.symlinkSync(root,alias);
 const foreign=path.join(alias,'inbox.sock');assert.equal(probeClaudeSession({env:{...env,CLAUDE_CODE_MESSAGING_SOCKET:foreign},version:SUPPORTED_CLAUDE_VERSION}).supported,false);
 const finalAlias=path.join(root,'final-alias');fs.symlinkSync(socketPath,finalAlias);assert.equal(probeClaudeSession({env:{...env,CLAUDE_CODE_MESSAGING_SOCKET:finalAlias.replace('/private/var/','/var/')},version:SUPPORTED_CLAUDE_VERSION}).supported,false);
},fs.realpathSync(os.tmpdir()))});
