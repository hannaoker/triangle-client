// macOS proof only. The controller supplies isolated model state and prefetched PR data.
import path from 'node:path';
import {writeFileSync,rmSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {sandboxCommand} from '../../agent-worker/runners/runner-common.mjs';
import {createRunnerEnvironment} from '../../agent-worker/src/command-runner.mjs';

function execute(command,args,{env,input='',signal,timeoutMs}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(Object.assign(Error('Proof aborted'),{name:'AbortError'}));
  const child=spawn(command,args,{env,cwd:env.TRIANGLE_INSTANCE_TEMP_ROOT,shell:false,detached:true,stdio:['pipe','pipe','pipe']});
  let bytes=0,done=false;const chunks=[];
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort)};
  const fail=error=>{if(done)return;done=true;cleanup();try{process.kill(-child.pid,'SIGKILL')}catch{child.kill('SIGKILL')}reject(error)};
  const abort=()=>fail(Object.assign(Error('Proof aborted'),{name:'AbortError'}));
  const timer=setTimeout(()=>fail(Error('Proof runner timed out; outcome unknown')),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  for(const [stream,capture] of [[child.stdout,true],[child.stderr,false]])stream.on('data',b=>{bytes+=b.length;if(bytes>1048576)fail(Error('Proof output limit'));else if(capture)chunks.push(b)});
  child.once('error',()=>fail(Error('Proof process unavailable')));
  child.once('close',code=>{if(done)return;done=true;cleanup();if(code!==0)reject(Object.assign(Error('Proof process failed; outcome unknown'),{exitCode:code}));else resolve(Buffer.concat(chunks).toString('utf8').trim())});
  child.stdin.on('error',()=>fail(Error('Proof input failed')));child.stdin.end(input);
 });
}
function confirmLiveSocket(socketPath,signal){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(Object.assign(Error('Proof aborted'),{name:'AbortError'}));
  const socket=net.createConnection(socketPath);let settled=false;
  const finish=e=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();e?reject(e):resolve()};
  const abort=()=>finish(Object.assign(Error('Proof aborted'),{name:'AbortError'}));
  const timer=setTimeout(()=>finish(Error('Probe requires a live peer socket')),2000);
  socket.once('connect',()=>finish());socket.once('error',()=>finish(Error('Probe requires a live peer socket')));signal?.addEventListener('abort',abort,{once:true});
 });
}
export function createProofHermesRunner({environment,timeoutMs=180000}={}){
 if(process.platform!=='darwin')throw Error('Hermes proof requires macOS native sandbox');
 const env=createRunnerEnvironment(environment);
 if(!env.HERMES_HOME||!env.HERMES_CLI)throw Error('Hermes proof requires isolated Hermes environment');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw Error('Invalid proof timeout');
 const sandbox=(command,args)=>{
  const s=sandboxCommand(command,args,env);
  if(s.command!=='/usr/bin/sandbox-exec'||s.args[0]!=='-p'||!s.args[1].includes('(allow network*)'))throw Error('Proof native sandbox unavailable');
  const argsCopy=[...s.args];argsCopy[1]=argsCopy[1].replace('(allow network*)','(allow network-outbound (remote ip))\n(allow network-bind)\n(allow network-outbound (literal "/private/var/run/mDNSResponder"))');
  return {...s,args:argsCopy};
 };
 // Validate roots and mandatory native policy before any child is launched.
 sandbox(env.HERMES_CLI,[]);
 const launch=(command,args,options={})=>{const s=sandbox(command,args);return execute(s.command,s.args,{env:{...env,...s.env},timeoutMs,...options})};
 let help;
 async function probeHelp({signal}={}){const text=await launch(env.HERMES_CLI,['chat','--help'],{signal});if(!text.includes('--query-file'))throw Error('Hermes CLI lacks stdin query-file capability');return text}
 return {
  probeHelp,
  async run(request,{signal}={}){
   if(typeof request?.text!=='string'||!request.text.trim()||Buffer.byteLength(request.text)>32768)throw Error('Invalid peer request');
   help??=await probeHelp({signal});
   const args=['chat','--query-file','-','--quiet'];
   for(const [flag,value] of [['--toolsets','terminal'],['--max-turns','3'],['--run-budget','60']])if(help.includes(flag))args.push(flag,value);
   const text=await launch(env.HERMES_CLI,args,{input:'Review only the prefetched PR data below. The controller owns GitHub access. Do not access credentials, identity state, or communication controls.\n\n'+request.text+'\n',signal});
   if(!text||Buffer.byteLength(text)>32768)throw Error('Invalid peer result');return {status:'completed',text};
  },
  async probe({socketPath,signal}={}){
   if(typeof socketPath!=='string'||!path.isAbsolute(socketPath))throw Error('Probe requires a live peer socket');
   await confirmLiveSocket(socketPath,signal);
   const suffix=randomUUID();const canaries=[env.TRIANGLE_CREDENTIAL_ROOT,env.TRIANGLE_IDENTITY_ROOT].map(root=>path.join(root,`proof-${suffix}`));const projectWrite=path.join(env.TRIANGLE_PROJECT_ROOT,`proof-${suffix}`);
   try{
    for(const p of canaries)writeFileSync(p,'proof-canary',{mode:0o600,flag:'wx'});
    const script=`const fs=require('node:fs');function denied(fn,code){try{fn();process.exit(code)}catch(e){if(!['EPERM','EACCES'].includes(e.code))process.exit(25)}}for(const p of ${JSON.stringify(canaries)})denied(()=>fs.readFileSync(p),21);denied(()=>fs.writeFileSync(${JSON.stringify(projectWrite)},'x'),22);const s=require('node:net').connect(${JSON.stringify(socketPath)});s.on('connect',()=>process.exit(23));s.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))process.exit(26);console.log('ISOLATED')});setTimeout(()=>process.exit(24),3000).unref();`;
    const out=await launch(realpathSync(process.execPath),['-e',script],{signal,timeoutMs:10000});if(out!=='ISOLATED')throw Error('Isolation probe failed');return {isolated:true};
   }finally{for(const p of [...canaries,projectWrite])rmSync(p,{force:true})}
  }
 };
}
