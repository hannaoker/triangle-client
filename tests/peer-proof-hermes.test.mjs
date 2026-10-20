import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createProofHermesRunner} from '../packages/peer-engine/tools/peer-proof-hermes.mjs';

test('Hermes proof requires native macOS sandbox',()=>{
 if(process.platform!=='darwin') assert.throws(()=>createProofHermesRunner({environment:{}}),/macOS/);
 else assert.throws(()=>createProofHermesRunner({environment:{}}),/Hermes/);
});
test('native fake Hermes: stdin, stripped secrets, bounds, cancellation, live IPC isolation',async t=>{
 if(process.platform!=='darwin')return t.skip('macOS native isolation fixture');
 if(spawnSync('/usr/bin/sandbox-exec',['-p','(version 1) (allow default)','/usr/bin/true']).status!==0)return t.skip('outer sandbox prevents native seatbelt');
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'proof-hermes-')));
 const home=path.join(root,'home'),id='a'.repeat(64),base=path.join(home,'Library/Application Support/The Triangle/model-state'),model=path.join(base,'instances',id),temp=path.join(home,'Library/Caches/The Triangle/instances',id),project=path.join(root,'project'),credential=path.join(root,'credential'),identity=path.join(root,'identity');
 for(const p of [model,temp,project,credential,identity])mkdirSync(p,{recursive:true,mode:0o700});
 const cli=path.join(model,'hermes'),entry=path.join(model,'runtime/bin/hermes');mkdirSync(path.dirname(entry),{recursive:true});writeFileSync(cli,'#!/bin/sh\nexec "'+entry+'" "$@"\n',{mode:0o700});
 writeFileSync(entry,`#!${realpathSync(process.execPath)}\nif(process.argv.includes('--help')){console.log('--query-file --toolsets --max-turns --run-budget');process.exit(0)}let p='';process.stdin.on('data',b=>p+=b);process.stdin.on('end',()=>{if(p.includes('WRITE')){require('node:fs').writeFileSync(process.env.TRIANGLE_PROJECT_ROOT+'/developer-write','ok')}if(p.includes('HANG'))return setInterval(()=>{},1000);if(p.includes('FLOOD'))return process.stdout.write('x'.repeat(1100000));console.log(JSON.stringify({p,args:process.argv.slice(2),secret:process.env.GITHUB_TOKEN}))});`,{mode:0o700});
 const environment={HOME:home,PATH:'/usr/bin:/bin',HERMES_HOME:model,HERMES_CLI:cli,TRIANGLE_PROJECT_ROOT:project,TRIANGLE_CREDENTIAL_ROOT:credential,TRIANGLE_IDENTITY_ROOT:identity,TRIANGLE_MODEL_STATE_BASE:base,TRIANGLE_MODEL_ROOTS:model,TRIANGLE_RUNTIME_ROOTS:path.dirname(realpathSync(process.execPath)),TRIANGLE_INSTANCE_ID:id,TRIANGLE_INSTANCE_TEMP_ROOT:temp,GITHUB_TOKEN:'controller-secret'};
 const socketPath=path.join(root,'peer.sock');let connections=0;const server=net.createServer(s=>{connections++;s.destroy()});await new Promise(r=>server.listen(socketPath,r));
 try{
 const runner=createProofHermesRunner({environment,timeoutMs:2000});
 assert.throws(()=>createProofHermesRunner({environment,securityMode:'typo'}),/security mode/);
 const developer=createProofHermesRunner({environment,securityMode:'developer-unsandboxed',timeoutMs:2000});
 assert.equal(developer.securityMode,'developer-unsandboxed');
 assert.equal(developer.isolationEnabled,false);
 assert.deepEqual(await developer.probe(),{isolated:false,securityMode:'developer-unsandboxed'});
 const devOut=JSON.parse((await developer.run({text:'developer test WRITE'})).text);assert.ok(devOut.p.includes('developer test'));assert.equal(devOut.secret,undefined);assert.ok(readdirSync(project).includes('developer-write'));rmSync(path.join(project,'developer-write'));
 await assert.rejects(runner.run({text:'WRITE'}),/failed/);
 assert.equal(runner.securityMode,'sandboxed');assert.equal(runner.isolationEnabled,true);

 const text='literal $(touch /tmp/no) `echo no` "quotes"';const out=JSON.parse((await runner.run({text})).text);assert.ok(out.p.includes(text));assert.ok(!out.args.join(' ').includes(text));assert.equal(out.secret,undefined);assert.ok(out.args.includes('--run-budget'));
 await assert.rejects(runner.run({text:'FLOOD'}),/limit/);
 await assert.rejects(createProofHermesRunner({environment,timeoutMs:100}).run({text:'HANG'}),/timed out/);
 const abort=new AbortController();const work=runner.run({text:'HANG'},{signal:abort.signal});setTimeout(()=>abort.abort(),50);await assert.rejects(work,{name:'AbortError'});
 await assert.rejects(runner.run({text:'x'.repeat(32769)}),/Invalid/);
 assert.deepEqual(await runner.probe({socketPath}),{isolated:true});assert.equal(connections,1);assert.deepEqual(readdirSync(credential),[]);assert.deepEqual(readdirSync(identity),[]);
 await assert.rejects(runner.probe({socketPath:path.join(root,'dead.sock')}),/live/);
 }finally{await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true})}
});
