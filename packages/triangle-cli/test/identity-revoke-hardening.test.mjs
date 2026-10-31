// Pins what identity-revoke-cli.test.mjs leaves implicit: each single release-capability guard,
// real SIGINT/SIGTERM through the CLI, the operation shown before authentication, every SSH
// marker, and the printed apply command. Stand-in providers and helpers only: no OS prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {main} from '../src/cli.mjs';
import {canonicalJson} from '../src/canonical.mjs';
import {describeOwnerOperation} from '../src/owner-approval.mjs';
import {identityRevoke,planIdentityRevoke,loadPackagedRevokeProvider} from '../src/identity-revoke.mjs';
import {initIdentityRegistry,bindProfileInRegistry} from '../../agent-worker/test/local-messaging-identity-fixtures.mjs';
import {readIdentityRegistry} from '../../agent-worker/src/identity-registry.mjs';

const sha=data=>createHash('sha256').update(data).digest('hex');
function temporary(t,prefix){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),prefix)));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}

function fixture(t,name='registry'){
 const root=temporary(t,'identity-revoke-hardening-'),registry=path.join(root,name);
 initIdentityRegistry(registry);
 const a=bindProfileInRegistry(registry,'alpha',1),b=bindProfileInRegistry(registry,'beta',2);
 const bytes=()=>['identity-registry-v1.json','registry-audit.jsonl'].map(file=>fs.readFileSync(path.join(registry,file)).toString('hex'));
 return {root,registry,a,b,bytes,plan:()=>planIdentityRevoke({registryRoot:registry,profile:'alpha'})};
}
async function run(args,extra={}){
 const out=[],err=[];
 const code=await main(args,{env:{},io:{stdout:s=>out.push(s),stderr:s=>err.push(s)},...extra});
 return {code,out:out.join('\n'),err:err.join('\n')};
}
const confirmArgs=f=>['identity','revoke','alpha','--registry-root',f.registry,'--confirm',f.plan().planId];

// --- Release-capability selection: one broken condition per case, everything else valid. ---
const STAND_IN=`#!/usr/bin/python3
import sys,json
r=json.load(sys.stdin)
print(json.dumps({'version':1,'digest':r['digest'],'nonce':r['nonce'],'outcome':'approved'},sort_keys=True,separators=(',',':')))
`;
function releaseFixture(t){
 const root=temporary(t,'identity-revoke-release-'),dir=path.join(root,'release'),executable=path.join(dir,'bin/triangle-owner-approval');
 fs.mkdirSync(path.dirname(executable),{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
 fs.writeFileSync(executable,STAND_IN,{mode:0o700});
 const manifest={schema:1,platform:'darwin',arch:process.arch,testOnly:false,signingMode:'public_ad_hoc',credentialCustody:'file',
  ownerApproval:{version:1,binary:'bin/triangle-owner-approval',commands:['identity.revoke']},
  files:[{path:'bin/triangle-owner-approval',mode:0o700,sha256:sha(fs.readFileSync(executable))}]};
 const file=path.join(dir,'package-manifest.json');
 const write=(value=manifest)=>{fs.rmSync(file,{force:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});};
 write();
 return {root,dir,executable,manifest,file,write,
  with:patch=>write({...manifest,...patch}),
  policy:patch=>write({...manifest,ownerApproval:{...manifest.ownerApproval,...patch}}),
  entry:patch=>write({...manifest,files:[{...manifest.files[0],...patch}]})};
}
// A well-formed challenge: the stand-in helper approves it, so 'approved' means the helper was selected.
function challengeFor(plan){
 const request={schema:'owner_operation_v1',...plan.operation,nonce:'9'.repeat(64),issuedAt:Math.floor(performance.now()),deadline:Math.floor(performance.now())+60000};
 return {request,digest:sha(canonicalJson(request)),summary:describeOwnerOperation(request)};
}
const select=(release,challenge,options={})=>loadPackagedRevokeProvider({releaseRoot:release.dir,platform:'darwin',...options}).authenticate(challenge);

test('control: a valid revoke release selects exactly its manifest-pinned helper',async t=>{
 const f=fixture(t),release=releaseFixture(t);
 assert.equal(await select(release,challengeFor(f.plan())),'approved');
});

const refusals={
 'a non-darwin platform':()=>({platform:'linux'}),
 'another schema':r=>r.with({schema:2}),
 'another manifest platform':r=>r.with({platform:'linux'}),
 'another architecture':r=>r.with({arch:'not-'+process.arch}),
 'a test-only build':r=>r.with({testOnly:true}),
 'a build that does not say it is not test-only':r=>r.with({testOnly:undefined}),
 'a candidate marker beside a valid policy':r=>r.with({ownerApprovalCandidate:{activation:'disabled'}}),
 'another signing mode':r=>r.with({signingMode:'unsigned'}),
 'another credential custody':r=>r.with({credentialCustody:'keychain'}),
 'an ordinary package without the capability':r=>r.with({ownerApproval:undefined}),
 'another policy version':r=>r.policy({version:2}),
 'another helper path':r=>{
  const other='bin/other-helper';fs.copyFileSync(r.executable,path.join(r.dir,other));fs.chmodSync(path.join(r.dir,other),0o700);
  r.write({...r.manifest,ownerApproval:{...r.manifest.ownerApproval,binary:other},files:[{...r.manifest.files[0],path:other}]});
 },
 'no commands':r=>r.policy({commands:[]}),
 'an extra command':r=>r.policy({commands:['identity.revoke','profile.move']}),
 'a different command':r=>r.policy({commands:['profile.move']}),
 'a repeated command':r=>r.policy({commands:['identity.revoke','identity.revoke']}),
 'a command that is not a list':r=>r.policy({commands:'identity.revoke'}),
 'no helper entry':r=>r.with({files:[]}),
 'a duplicated helper entry':r=>r.with({files:[r.manifest.files[0],r.manifest.files[0]]}),
 'a helper entry that is not private':r=>r.entry({mode:0o755}),
 'a helper hash that does not match the file':r=>r.entry({sha256:sha('another helper')}),
 'an upper-case helper hash':r=>r.entry({sha256:r.manifest.files[0].sha256.toUpperCase()}),
 'a short helper hash':r=>r.entry({sha256:'0'.repeat(63)}),
 'a release directory others can read':r=>fs.chmodSync(r.dir,0o755),
 'a manifest others can read':r=>fs.chmodSync(r.file,0o644),
 'a manifest with a second hard link':r=>fs.linkSync(r.file,path.join(r.root,'manifest-link')),
 'a manifest that is a symbolic link':r=>{
  const real=path.join(r.root,'real-manifest.json');fs.renameSync(r.file,real);fs.symlinkSync(real,r.file);
 },
 // macOS can give a symbolic link private permissions, which leaves the regular-file check as its only refusal.
 ...(typeof fs.lchmodSync==='function'?{'a manifest that is a private symbolic link':r=>{
  const real=path.join(r.root,'real-manifest.json');fs.renameSync(r.file,real);fs.symlinkSync(real,r.file);fs.lchmodSync(r.file,0o600);
 }}:{}),
 'a manifest over the size cap':r=>r.write(JSON.stringify(r.manifest)+' '.repeat(1024*1024)),
 'a manifest that is not JSON':r=>r.write('{not json'),
 'a missing manifest':r=>fs.rmSync(r.file),
 'a release root reached through a symbolic link':r=>{
  const link=path.join(r.root,'release-link');fs.symlinkSync(r.dir,link);return {releaseRoot:link};
 },
};
for(const [name,break_] of Object.entries(refusals))test(`release capability is refused for ${name}`,async t=>{
 const f=fixture(t),release=releaseFixture(t),options=break_(release);
 assert.equal(await select(release,challengeFor(f.plan()),options),'unavailable');
});

// --- Real signals through the CLI. ---
const cliUrl=pathToFileURL(path.resolve(import.meta.dirname,'../src/cli.mjs')).href;
for(const [signal,exit] of [['SIGINT',130],['SIGTERM',143]])test(`${signal} reaches the provider through the CLI, exits ${exit} and changes nothing`,async t=>{
 const f=fixture(t),before=f.bytes(),planId=f.plan().planId;
 const script=`const [,registry,planId]=process.argv;
  const {main}=await import(${JSON.stringify(cliUrl)});
  const provider={authenticate:(_,{signal})=>new Promise(resolve=>{process.stderr.write('READY\\n');
   signal.addEventListener('abort',()=>{process.stderr.write('ABORTED\\n');resolve('cancelled');});})};
  process.exitCode=await main(['identity','revoke','alpha','--registry-root',registry,'--confirm',planId],
   {env:{},identityDependencies:{isTerminal:true,ownerApprovalProvider:provider}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,f.registry,planId],{stdio:['ignore','ignore','pipe']});
 let stderr='',sent=false;
 const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('child did not finish: '+stderr));},20000);
  child.stderr.on('data',chunk=>{stderr+=chunk;if(!sent&&stderr.includes('READY')){sent=true;child.kill(signal);}});
  child.once('error',reject);
  child.once('exit',(code,received)=>{clearTimeout(timer);resolve({code,received});});
 });
 assert.deepEqual(result,{code:exit,received:null},stderr);
 assert.match(stderr,/ABORTED/);assert.match(stderr,/Identity revocation was cancelled/);
 assert.deepEqual(f.bytes(),before);
});

// --- What the owner sees and where apply is refused. ---
test('the exact operation is on stderr, and equals the OS challenge summary, before the provider is asked',async t=>{
 const f=fixture(t),plan=f.plan(),err=[];let shown=null,summary=null;
 const code=await main(confirmArgs(f),{env:{},io:{stdout(){},stderr:s=>err.push(s)},identityDependencies:{isTerminal:true,
  ownerApprovalProvider:{authenticate:async challenge=>{shown=err.join('\n');summary=challenge.summary;return 'cancelled';}}}});
 assert.equal(code,1);
 assert.equal(shown,describeOwnerOperation(plan.operation));assert.equal(summary,shown);
 for(const part of [plan.operation.profileId,plan.operation.registryRoot,plan.operation.before.principalId,plan.operation.before.authorityOrigin,'Revoke this binding'])assert.ok(shown.includes(part),part);
});

for(const variable of ['SSH_CONNECTION','SSH_CLIENT','SSH_TTY'])test(`${variable} refuses apply before authentication`,async t=>{
 const f=fixture(t),before=f.bytes();let calls=0;
 const result=await run(confirmArgs(f),{env:{[variable]:'fixture'},identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async()=>{calls++;return 'approved';}}}});
 assert.equal(result.code,2);assert.match(result.err,/local owner terminal/);assert.equal(calls,0);assert.deepEqual(f.bytes(),before);
});

test('argument-shape errors are usage errors that never authenticate',async t=>{
 const f=fixture(t),before=f.bytes();let calls=0;
 const deps={identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async()=>{calls++;return 'approved';}}}};
 const root=/requires --registry-root ABSOLUTE_PATH/;
 for(const [args,message] of [
  [['identity','revoke','alpha','beta','--registry-root',f.registry],root],
  [['identity','revoke','--registry-root',f.registry],root],
  [['identity','revoke','alpha','--registry-root','relative/registry'],root],
  [['identity','revoke','alpha'],root],
  [['identity','revoke','alpha','--registry-root',f.registry,'--confirm','not-hex'],/64-hex/],
 ]){const result=await run(args,deps);assert.equal(result.code,2,args.join(' '));assert.match(result.err,message,args.join(' '));}
 assert.equal(calls,0);assert.deepEqual(f.bytes(),before);
});

test('a malformed confirmation never reaches the provider, even when the bridge is called directly',async t=>{
 const f=fixture(t),before=f.bytes(),id=f.plan().planId;let calls=0;
 const provider={authenticate:async()=>{calls++;return 'approved';}};
 for(const confirm of ['not-hex',id.toUpperCase(),id+'0',''])
  await assert.rejects(identityRevoke({registryRoot:f.registry,profile:'alpha',confirm,provider}),{code:'confirmation_mismatch'},confirm);
 assert.equal(calls,0);assert.deepEqual(f.bytes(),before);
});

test('the printed apply command, parsed by a shell, applies exactly the plan it printed',async t=>{
 const f=fixture(t,"it's a $HOME registry"),plan=f.plan();
 const planned=await run(['identity','revoke','alpha','--registry-root',f.registry]);assert.equal(planned.code,0,planned.err);
 const line=planned.out.split('\n').find(text=>text.startsWith('triangle identity revoke '));assert.ok(line,planned.out);
 const shell=spawnSync('/bin/sh',['-c','set -- '+line.slice('triangle '.length)+'; for a in "$@"; do printf "%s\\0" "$a"; done'],{encoding:'utf8'});
 assert.equal(shell.status,0,shell.stderr);
 const argv=shell.stdout.split('\0').slice(0,-1);
 assert.ok(argv.includes(f.registry),'the registry path survives quoting');assert.ok(argv.includes(plan.planId));
 const audit=()=>fs.readFileSync(path.join(f.registry,'registry-audit.jsonl'),'utf8').trim().split('\n');
 const lines=audit().length;let calls=0;
 const applied=await run(argv,{identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async()=>{calls++;return 'approved';}}}});
 assert.equal(applied.code,0,applied.err);assert.equal(calls,1);
 const entries=audit(),last=JSON.parse(entries.at(-1));
 assert.equal(entries.length,lines+1);assert.deepEqual([last.action,last.subject],['revoke',plan.operation.profileId]);
 const after=readIdentityRegistry({root:f.registry}).registry;
 assert.ok(after.bindings[f.a.profile_instance_id].revoked_at);assert.deepEqual(after.bindings[f.b.profile_instance_id],f.b);
 const again=await run(argv,{identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async()=>{calls++;return 'approved';}}}});
 assert.equal(again.code,2);assert.match(again.err,/identity_binding_not_active/);assert.equal(calls,1);
});
