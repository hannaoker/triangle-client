import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { main, parseCommand, MAX_INPUT, MAX_OUTPUT } from '../peer-proof-ctl.mjs';
const capture=()=>{let value='';return {stream:new Writable({write(b,_e,done){value+=b;done();}}),get:()=>value};};
async function call(raw,clientFactory){const out=capture(),err=capture();const code=await main(['--socket','/private/tmp/proof.sock'],{input:Readable.from([raw]),output:out.stream,error:err.stream,clientFactory});return {code,stdout:out.get(),stderr:err.get()};}
test('exact command envelope and bounded input validated before IPC', async()=>{
 for(const raw of ['{}','[]','{"method":"status","params":{},"extra":1}','{"method":"unknown","params":{}}','{"method":"status","params":[]}','x'.repeat(MAX_INPUT+1)]){
 const result=await call(raw,()=>{throw Error('must not connect');});assert.equal(result.code,1);assert.equal(result.stdout,'');
 }
 assert.deepEqual(parseCommand('{"method":"status","params":{}}'),{method:'status',params:{}});
});
test('32KiB send input remains stdin only and request response roundtrips',async()=>{
 let requested;const params={payload:'a'.repeat(32768),message_id:'test',peer_addr:{id:'peer'}};
 const result=await call(JSON.stringify({method:'send',params}),options=>{assert.equal(options.socketPath,'/private/tmp/proof.sock');return {request:async(method,value)=>{requested={method,params:value};return {status:'received_peer'};}};});
 assert.equal(result.code,0);assert.deepEqual(requested,{method:'send',params});assert.deepEqual(JSON.parse(result.stdout),{status:'received_peer'});
});
test('bounded output and private errors do not leak exception content',async()=>{
 const large=await call('{"method":"status","params":{}}',()=>({request:async()=>({x:'a'.repeat(MAX_OUTPUT)})}));assert.equal(large.stderr,'output_too_large\n');assert.equal(large.stdout,'');
 const error=await call('{"method":"status","params":{}}',()=>({request:async()=>{throw Error('private payload secret');}}));assert.equal(error.stderr,'ipc_request_failed\n');
});
