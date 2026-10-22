import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setupLocalMessaging} from '../src/local-messaging-cli.mjs';
import {writePrivateJson,readPrivateJson} from '../src/local-messaging-auth-broker.mjs';
import {createInstalledLocalMessagingHost} from '../src/local-messaging-host.mjs';
import {createProfiledReasonerGate} from '../src/concurrency-gate.mjs';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../src/local-messaging-cli.mjs',import.meta.url));
test('production host executes via registered runner and preserves replies across restart',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-host-');let host,calls=0;
 const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
 try{
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'thread-current',enabled:false});
  setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'thread-current',recipients:['gravity2']});
  const config=readPrivateJson(configPath),recipient=config.recipients[0].instanceId;
  const runner={run:async request=>{calls++;assert.equal(request.senderId,'a'.repeat(64));return {status:'completed',text:'assessment '+request.text};}};
  const make=()=>createInstalledLocalMessagingHost({configPath,runners:new Map([[recipient,runner]]),gate:createProfiledReasonerGate()});
  const run=async args=>JSON.parse((await exec(process.execPath,[cli,...args,'--config',configPath])).stdout);
  host=make();await host.start();
  const sent=await run(['send','--to','gravity2','--text','inspect','--message-id','host-one','--request-id','host-request','--wait-ms','2000']);
  assert.equal(sent.replies[0].text,'assessment inspect');assert.equal(calls,1);
  const status=await run(['status']);assert.equal(status.journal.completed,1);assert.equal(status.journal.pendingReplies,1);
  await host.stop();host=make();await host.start();
  assert.equal((await run(['replies','--request-id','host-request'])).replies[0].inReplyTo,'host-one');
  await run(['send','--to','gravity2','--text','inspect','--message-id','host-one','--request-id','host-request']);
  await new Promise(r=>setTimeout(r,30));assert.equal(calls,1,'reconnect retry does not execute twice');
 }finally{await host?.stop();fs.rmSync(root,{recursive:true,force:true});}
});
