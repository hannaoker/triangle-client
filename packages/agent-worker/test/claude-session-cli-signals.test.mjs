import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {writePrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {SUPPORTED_CLAUDE_VERSION} from '../src/claude-session-delivery.mjs';

const cli=fileURLToPath(new URL('../src/local-messaging-cli.mjs',import.meta.url));
for(const signal of ['SIGINT','SIGTERM']) {
 test(`Claude MCP CLI gracefully closes on ${signal}`,{timeout:5000},async()=>{
  const base=fs.existsSync('/private/tmp')?'/private/tmp':fs.realpathSync(os.tmpdir());
  const root=fs.mkdtempSync(path.join(base,'triangle-claude-signal-'));
  fs.chmodSync(root,0o700);
  const integrationPath=path.join(root,'integration.json'),configPath=path.join(root,'config.json');
  const sessionId=randomUUID();
  writePrivateJson(integrationPath,{version:1,type:'interactive',senderId:randomBytes(32).toString('hex'),sessionId,generation:1,bindingId:randomUUID(),secret:randomBytes(32).toString('hex'),enabled:true,revoked:false});
  writePrivateJson(configPath,{version:1,enabled:true,stateRoot:root,interactive:{enabled:true,integrationPath}});
  const proc=spawn(process.execPath,[cli,'claude-session-mcp','--config',configPath,'--expected-version',SUPPORTED_CLAUDE_VERSION],{env:{PATH:process.env.PATH,CLAUDE_CODE_SESSION_ID:sessionId},stdio:['pipe','pipe','pipe']});
  const exited=once(proc,'exit');
  try {
   const initialized=new Promise((resolve,reject)=>{
    let buffer='';
    proc.stdout.on('data',chunk=>{buffer+=chunk;const line=buffer.split('\n')[0];try{const message=JSON.parse(line);if(message.id===1)resolve(message);}catch{}});
    proc.once('error',reject);
    proc.once('exit',(code,signal)=>reject(new Error(`CLI exited before initialization: ${code ?? signal}`)));
   });
   proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\n');
   const result=await initialized;
   assert.equal(result.result.serverInfo.name,'triangle-claude-session-mcp');
   assert.equal(proc.kill(signal),true);
   const [code,terminationSignal]=await exited;
   assert.equal(terminationSignal,null,'signal must follow awaited cleanup instead of default termination');
   assert.equal(code,0);
  } finally {
   if(proc.exitCode===null&&proc.signalCode===null){proc.kill('SIGKILL');await exited;}
   fs.rmSync(root,{recursive:true,force:true});
  }
 });
}
