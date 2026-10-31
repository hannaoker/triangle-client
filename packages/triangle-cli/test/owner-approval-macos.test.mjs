import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {canonicalJson} from '../src/canonical.mjs';
import {describeOwnerOperation} from '../src/owner-approval.mjs';
import {createMacOSOwnerApprovalProvider} from '../src/owner-approval-macos.mjs';

function fixture(t,mode='approved',{ttlMs=5000}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'owner-macos-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const executable=path.join(root,'provider'),pidfile=path.join(root,'pid');
 fs.writeFileSync(executable,`#!/usr/bin/python3
import sys,json,os,time,signal
mode=${JSON.stringify(mode)}
if mode=='ignore': signal.signal(signal.SIGTERM,signal.SIG_IGN)
with open(${JSON.stringify(pidfile)},'w') as f: f.write(str(os.getpid()))
r=json.load(sys.stdin)
if mode in ['wait','ignore']: time.sleep(20)
outcome=mode if mode in ['approved','denied','cancelled','unavailable'] else 'approved'
if mode=='env': outcome='approved' if 'OWNER_APPROVAL_TEST_SECRET' in os.environ else 'denied'
v={'version':1,'digest':r['digest'],'nonce':r['nonce'],'outcome':outcome}
if mode=='nonce': v['nonce']='0'*64
if mode=='digest': v['digest']='0'*64
if mode=='extra': v['extra']='untrusted'
if mode=='oversize': print('x'*5000)
elif mode=='malformed': print('not json')
elif mode=='duplicate': print('{"outcome":"denied",'+json.dumps(v,sort_keys=True,separators=(',',':'))[1:])
else: print(json.dumps(v,sort_keys=True,separators=(',',':')))
if mode=='nonzero': sys.exit(1)
`,{mode:0o700});
 const op={action:'profile.revoke',registryRoot:root,expectedSequence:1,profileId:'a'.repeat(64),
  before:{bindingId:'bind_'+'b'.repeat(32),bindingGeneration:1,principalId:'agent_'+'c'.repeat(32),authorityOrigin:'https://example.test',revokedAt:null}};
 const now=Math.floor(performance.now());
 const request={schema:'owner_operation_v1',...op,nonce:'9'.repeat(64),issuedAt:now,deadline:now+ttlMs};
 const challenge={request,digest:createHash('sha256').update(canonicalJson(request)).digest('hex'),summary:describeOwnerOperation(op)};
 const options={executable,sha256:createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),platform:'darwin',killGraceMs:20};
 return {root,executable,pidfile,challenge,options,provider:()=>createMacOSOwnerApprovalProvider(options)};
}

for(const mode of ['approved','denied','cancelled','unavailable'])test(`correlated ${mode} response requires a clean child exit`,async t=>{
 const f=fixture(t,mode);assert.equal(await f.provider().authenticate(f.challenge),mode);
});
for(const mode of ['nonce','digest','extra','oversize','malformed','duplicate','nonzero'])test(`refuses ${mode} helper output`,async t=>{
 const f=fixture(t,mode);assert.equal(await f.provider().authenticate(f.challenge),'unavailable');
});

test('unsupported platform, incorrect pin and unsafe helper paths never spawn',async t=>{
 const f=fixture(t);
 for(const patch of [{platform:'linux'},{sha256:'0'.repeat(64)},{executable:'relative'}])
  assert.equal(await createMacOSOwnerApprovalProvider({...f.options,...patch}).authenticate(f.challenge),'unavailable');
 const alias=path.join(f.root,'alias');fs.symlinkSync(f.executable,alias);
 assert.equal(await createMacOSOwnerApprovalProvider({...f.options,executable:alias}).authenticate(f.challenge),'unavailable');
 fs.chmodSync(f.executable,0o777);assert.equal(await f.provider().authenticate(f.challenge),'unavailable');
 assert.equal(fs.existsSync(f.pidfile),false);
});

test('helper modified after provider construction is refused before execution',async t=>{
 const f=fixture(t),provider=f.provider();fs.appendFileSync(f.executable,'\n# changed');
 assert.equal(await provider.authenticate(f.challenge),'unavailable');assert.equal(fs.existsSync(f.pidfile),false);
});

test('changed summary or digest, expired requests and pre-cancellation never spawn',async t=>{
 const f=fixture(t),controller=new AbortController();controller.abort();
 assert.equal(await f.provider().authenticate(f.challenge,{signal:controller.signal}),'cancelled');
 for(const patch of [{summary:'approve something else'},{digest:'0'.repeat(64)},
  {request:{...f.challenge.request,deadline:f.challenge.request.issuedAt}}])
  assert.equal(await f.provider().authenticate({...f.challenge,...patch}),'unavailable');
 assert.equal(fs.existsSync(f.pidfile),false);
});

test('timeout never returns approval',async t=>{
 const f=fixture(t,'wait',{ttlMs:100});assert.equal(await f.provider().authenticate(f.challenge),'unavailable');
});

test('cancellation waits for helper exit, including a helper ignoring SIGTERM',async t=>{
 const f=fixture(t,'ignore'),controller=new AbortController(),pending=f.provider().authenticate(f.challenge,{signal:controller.signal});
 const until=Date.now()+3000;
 while(!fs.existsSync(f.pidfile)&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
 assert.ok(fs.existsSync(f.pidfile));const pid=Number(fs.readFileSync(f.pidfile,'utf8'));
 controller.abort();assert.equal(await pending,'cancelled');
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('helper receives a minimal environment rather than inherited credentials',async t=>{
 const f=fixture(t,'env');process.env.OWNER_APPROVAL_TEST_SECRET='disposable-marker';
 try{assert.equal(await f.provider().authenticate(f.challenge),'denied');}
 finally{delete process.env.OWNER_APPROVAL_TEST_SECRET;}
});

test('native candidate provider is not selected by any CLI or runtime',()=>{
 const packages=path.resolve(import.meta.dirname,'../..'),offenders=[];
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,e.name);if(e.isDirectory())walk(file);
  else if(e.isFile()&&file.endsWith('.mjs')&&!file.endsWith('/owner-approval-macos.mjs')&&fs.readFileSync(file,'utf8').includes('owner-approval-macos'))offenders.push(file);
 }}
 for(const e of fs.readdirSync(packages,{withFileTypes:true})){const src=path.join(packages,e.name,'src');if(e.isDirectory()&&fs.existsSync(src))walk(src);}
 assert.deepEqual(offenders,[]);
});

test('expiry during executable verification is rechecked before spawn',async t=>{
 const f=fixture(t);let reads=0;
 const provider=createMacOSOwnerApprovalProvider({...f.options,clockMs:()=>++reads===1?f.challenge.request.issuedAt:f.challenge.request.deadline});
 assert.equal(await provider.authenticate(f.challenge),'unavailable');assert.equal(fs.existsSync(f.pidfile),false);
});


test('nonce with a trailing newline is refused before spawning',async t=>{
 const f=fixture(t),request={...f.challenge.request,nonce:f.challenge.request.nonce+'\n'};
 const challenge={...f.challenge,request,digest:createHash('sha256').update(canonicalJson(request)).digest('hex')};
 assert.equal(await f.provider().authenticate(challenge),'unavailable');assert.equal(fs.existsSync(f.pidfile),false);
});
