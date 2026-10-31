// Pins what identity-revoke-cli.test.mjs leaves implicit: each release-capability guard the loader
// alone decides (the two owner-uid checks need another OS user and are not testable here), real
// SIGINT/SIGTERM through the CLI, the operation shown before authentication, every SSH marker, and
// the printed apply command. Stand-in providers and helpers only: no OS prompt can appear.
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
// Approves anything it is asked, using the Node that runs the tests (no Python, no Command Line Tools).
const STAND_IN=`#!${process.execPath}
let input='';
process.stdin.on('data',chunk=>{input+=chunk;}).on('end',()=>{
 const request=JSON.parse(input);
 process.stdout.write(JSON.stringify({digest:request.digest,nonce:request.nonce,outcome:'approved',version:1})+'\\n');
});
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
// A well-formed challenge: the stand-in helper approves it, so 'approved' means the helper really ran.
function challengeFor(plan){
 const request={schema:'owner_operation_v1',...plan.operation,nonce:'9'.repeat(64),issuedAt:Math.floor(performance.now()),deadline:Math.floor(performance.now())+60000};
 return {request,digest:sha(canonicalJson(request)),summary:describeOwnerOperation(request)};
}
const load=(release,options={})=>loadPackagedRevokeProvider({releaseRoot:release.dir,platform:'darwin',...options});
// An already-aborted signal makes a selected macOS provider answer 'cancelled' before it checks or runs
// anything, while the unavailable provider still answers 'unavailable'. That tells the loader's own
// refusal apart from the provider's re-checks of platform, path and hash, which would hide a missing guard.
const select=(release,challenge,options={})=>load(release,options).authenticate(challenge,{signal:AbortSignal.abort()});

test('control: a valid revoke release selects exactly its manifest-pinned helper',async t=>{
 const f=fixture(t),release=releaseFixture(t),challenge=challengeFor(f.plan());
 assert.equal(await select(release,challenge),'cancelled','the loader selected the macOS provider');
 assert.equal(await load(release).authenticate(challenge),'approved','the stand-in helper ran (needs an executable temp directory)');
});

test('a helper that does not match its manifest hash is not run',async t=>{
 const f=fixture(t),release=releaseFixture(t);
 release.entry({sha256:sha('another helper')}); // well formed, so the loader selects; the provider then refuses before spawning
 assert.equal(await load(release).authenticate(challengeFor(f.plan())),'unavailable');
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
 'an upper-case helper hash':r=>r.entry({sha256:r.manifest.files[0].sha256.toUpperCase()}),
 'a short helper hash':r=>r.entry({sha256:'0'.repeat(63)}),
 'a release directory others can read':r=>fs.chmodSync(r.dir,0o755),
 'a manifest others can read':r=>fs.chmodSync(r.file,0o644),
 'a manifest with a second hard link':r=>fs.linkSync(r.file,path.join(r.root,'manifest-link')),
 'a manifest that is a symbolic link':r=>{
  const real=path.join(r.root,'real-manifest.json');fs.renameSync(r.file,real);fs.symlinkSync(real,r.file);
 },
 'a manifest over the size cap':r=>r.write(JSON.stringify(r.manifest)+' '.repeat(1024*1024)),
 'a manifest that is not JSON':r=>r.write('{not json'),
 'a missing manifest':r=>fs.rmSync(r.file),
 // Only the directory is reached through a symbolic link, so the canonical-root check is the sole refusal.
 'a release root below a symbolic link':r=>{
  const link=path.join(r.root,'root-link');fs.symlinkSync(r.root,link);return {releaseRoot:path.join(link,'release')};
 },
};
const refuse=(name,break_,options={})=>test(`release capability is refused for ${name}`,options,async t=>{
 const f=fixture(t),release=releaseFixture(t),broken=break_(release);
 assert.equal(await select(release,challengeFor(f.plan()),broken),'unavailable');
});
for(const [name,break_] of Object.entries(refusals))refuse(name,break_);
// macOS can give a symbolic link private permissions, which leaves the regular-file check as its only refusal.
refuse('a manifest that is a private symbolic link',r=>{
 const real=path.join(r.root,'real-manifest.json');fs.renameSync(r.file,real);fs.symlinkSync(real,r.file);fs.lchmodSync(r.file,0o600);
},{skip:typeof fs.lchmodSync==='function'?false:'needs fs.lchmodSync (macOS)'});

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
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',(code,received)=>{clearTimeout(timer);resolve({code,received});}); // after stderr has drained
 });
 assert.deepEqual(result,{code:exit,received:null},stderr);
 assert.match(stderr,/ABORTED/);assert.match(stderr,/Identity revocation was cancelled/);
 assert.deepEqual(f.bytes(),before);
});

// --- What the owner sees and where apply is refused. ---
test('the exact operation is on stderr, and equals the summary in the challenge, before the provider is asked',async t=>{
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
 const f=fixture(t),before=f.bytes(),id=f.plan().planId;let calls=0;
 const deps={identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async()=>{calls++;return 'approved';}}}};
 const root=/requires --registry-root ABSOLUTE_PATH/;
 // Every case carries a valid --confirm and an approving provider, so calls===0 shows the shape error came first.
 for(const [args,message] of [
  [['identity','revoke','alpha','beta','--registry-root',f.registry,'--confirm',id],root],
  [['identity','revoke','--registry-root',f.registry,'--confirm',id],root],
  [['identity','revoke','alpha','--registry-root','relative/registry','--confirm',id],root],
  [['identity','revoke','alpha','--confirm',id],root],
  [['identity','revoke','alpha','--registry-root',f.registry,'--confirm','not-hex'],/64-hex/],
 ]){const result=await run(args,deps);assert.equal(result.code,2,args.join(' '));assert.match(result.err,message,args.join(' '));}
 assert.equal(calls,0);assert.deepEqual(f.bytes(),before);
});

test('errors say what is true and what to do, without paths',async t=>{
 const f=fixture(t),broken=fixture(t,'broken'),before=f.bytes();
 fs.writeFileSync(path.join(broken.registry,'identity-registry-v1.json'),'{not json');
 const link=path.join(f.root,'registry-link');fs.symlinkSync(f.registry,link);
 const deps={identityDependencies:{isTerminal:true,ownerApprovalProvider:{authenticate:async()=>'approved'}}};
 const wrong=await run(['identity','revoke','alpha','--registry-root',f.registry,'--confirm','0'.repeat(64)],deps);
 assert.equal(wrong.code,2);assert.match(wrong.err,/plan ID does not match/);assert.doesNotMatch(wrong.err,/registry changed/);
 const errors=[wrong.err];
 for(const [args,code,patterns] of [
  [['identity','revoke','bad/name','--registry-root',f.registry],2,[/invalid_owner_operation/,/profile name or registry path is not valid/]],
  [['identity','revoke','alpha','--registry-root',link],1,[/registry_unsafe/,/not safe to use/]],
  [['identity','revoke','alpha','--registry-root',broken.registry],1,[/registry_corrupt/,/could not be read/]],
 ]){
  const result=await run(args,deps);assert.equal(result.code,code,args.join(' '));
  for(const pattern of patterns)assert.match(result.err,pattern);errors.push(result.err);
 }
 for(const text of errors)assert.equal(text.includes(f.root)||text.includes(broken.root),false,'no path in errors');
 assert.deepEqual(f.bytes(),before);
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
