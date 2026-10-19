import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const installer=resolve('scripts/release/install-linux-package.mjs');
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(version='1.2.3') {
 const root=mkdtempSync(join(tmpdir(),'triangle-package-install-')); chmodSync(root,0o700);
 mkdirSync(join(root,'home'),{mode:0o700}); const stage=join(root,'stage'); mkdirSync(stage,{mode:0o700});
 const assets={'bin/node':'runtime','packages/triangle-cli/src/cli.mjs':'console.log("help")','scripts/release/install-linux-package.mjs':'installer','LICENSES/node-LICENSE':'license','LICENSES/triangle-LICENSE':'triangle license','packages/triangle-cli/package.json':'{}'};
 const files=Object.entries(assets).map(([path,data])=>{mkdirSync(join(stage,path,'..'),{recursive:true,mode:0o700});writeFileSync(join(stage,path),data,{mode:path==='bin/node'?0o700:0o600});return {path,size:Buffer.byteLength(data),sha256:hash(data),mode:path==='bin/node'?0o700:0o600};});
 writeFileSync(join(stage,'package-manifest.json'),JSON.stringify({schema:1,version,platform:'linux',arch:process.arch,signingMode:'none',credentialCustody:'file',distribution:'owner-cli',serviceSupport:false,files}),{mode:0o600});return {root,stage};
}
function install(f,env={}) { return execFileSync(process.execPath,[installer,'--verified-stage',f.stage,'--test-root',f.root],{env:{...process.env,...env},encoding:'utf8'}); }
test('Linux builder rejects non-Linux hosts', {skip:process.platform==='linux'},()=>{assert.throws(()=>execFileSync(process.execPath,['scripts/release/build-linux-package.mjs','--version','1.2.3','--output','/tmp/no-output'],{stdio:'pipe'}),error=>/Linux packages require native Linux/.test(error.stderr?.toString()));});
test('native Linux installs, reruns and rejects changed wrapper before mutation',{skip:process.platform!=='linux'},()=>{const f=fixture();try{install(f,{XDG_DATA_HOME:'/ignored'});const wrapper=join(f.root,'home/.local/bin/triangle'); const original=readFileSync(wrapper,'utf8');assert.match(original,/releases\/1.2.3\/bin\/node/);install(f);writeFileSync(wrapper,'custom');assert.throws(()=>install(f),/Command failed/);assert.equal(readFileSync(wrapper,'utf8'),'custom');}finally{rmSync(f.root,{recursive:true,force:true});}});
test('native Linux rejects package tampering',{skip:process.platform!=='linux'},()=>{const f=fixture();try{writeFileSync(join(f.stage,'bin/node'),'changed');assert.throws(()=>install(f),/Command failed/);}finally{rmSync(f.root,{recursive:true,force:true});}});

test('native Linux upgrade preserves identity and unrelated state',{skip:process.platform!=='linux'},()=>{const f=fixture();try{install(f);const state=join(f.root,'home/.local/state/triangle/v1');mkdirSync(state,{recursive:true,mode:0o700});writeFileSync(join(state,'identity.json'),'private identity');const manifestPath=join(f.stage,'package-manifest.json');const m=JSON.parse(readFileSync(manifestPath));m.version='1.2.4';writeFileSync(manifestPath,JSON.stringify(m),{mode:0o600});install(f);assert.equal(readFileSync(join(state,'identity.json'),'utf8'),'private identity');assert.match(readFileSync(join(f.root,'home/.local/bin/triangle'),'utf8'),/releases\/1.2.4/);}finally{rmSync(f.root,{recursive:true,force:true});}});
test('native Linux rejects unrelated wrapper without creating releases',{skip:process.platform!=='linux'},()=>{const f=fixture();try{mkdirSync(join(f.root,'home/.local/bin'),{recursive:true,mode:0o700});writeFileSync(join(f.root,'home/.local/bin/triangle'),'unrelated',{mode:0o700});assert.throws(()=>install(f));assert.equal(existsSync(join(f.root,'home/.local/share/triangle')),false);}finally{rmSync(f.root,{recursive:true,force:true});}});
test('native Linux rejects symlink destinations and modified releases',{skip:process.platform!=='linux'},()=>{const f=fixture();try{mkdirSync(join(f.root,'home/.local'),{mode:0o700});symlinkSync(f.stage,join(f.root,'home/.local/share'));assert.throws(()=>install(f));rmSync(join(f.root,'home/.local/share'));install(f);writeFileSync(join(f.root,'home/.local/share/triangle/releases/1.2.3/bin/node'),'edited');assert.throws(()=>install(f));}finally{rmSync(f.root,{recursive:true,force:true});}});
test('native Linux rolls back wrapper and release when receipt publication fails',{skip:process.platform!=='linux'},()=>{const f=fixture();try{
 install(f);const wrapper=join(f.root,'home/.local/bin/triangle');const original=readFileSync(wrapper,'utf8');const manifestPath=join(f.stage,'package-manifest.json');const manifest=JSON.parse(readFileSync(manifestPath));manifest.version='1.2.4';writeFileSync(manifestPath,JSON.stringify(manifest),{mode:0o600});
 const receipt=join(f.root,'home/.local/share/triangle/package-install.json');const before=readFileSync(receipt,'utf8');
 const script=`import {writeFileSync} from 'node:fs';process.argv=[process.execPath,${JSON.stringify(installer)},'--verified-stage',${JSON.stringify(f.stage)},'--test-root',${JSON.stringify(f.root)}];writeFileSync(${JSON.stringify(receipt)}+'.intent-stage-'+process.pid,'collision',{mode:0o600});await import(${JSON.stringify('file://'+installer)});`;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','--eval',script],{stdio:'pipe'}));assert.equal(readFileSync(wrapper,'utf8'),original);assert.equal(readFileSync(receipt,'utf8'),before);assert.equal(existsSync(join(f.root,'home/.local/share/triangle/releases/1.2.4')),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}});
test('native Linux builder packages real Node, bootstrap installs with an empty tool PATH, and output is immutable',{skip:process.platform!=='linux'||!existsSync('/usr/local/LICENSE')},()=>{
 const output=mkdtempSync(join(tmpdir(),'triangle-linux-artifacts-'));
 const root=mkdtempSync(join(tmpdir(),'triangle-package-install-'));chmodSync(root,0o700);mkdirSync(join(root,'home'),{mode:0o700});
 try {
  const args=['scripts/release/build-linux-package.mjs','--version','0.0.0-native-test','--output',output,'--node',process.execPath,'--node-license','/usr/local/LICENSE'];
  const result=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}));
  assert.ok(existsSync(result.archive));
  assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe'}),e=>/Release output already exists/.test(e.stderr?.toString()));
  const manifest=JSON.parse(execFileSync('tar',['-xOf',result.archive,'package-manifest.json'],{encoding:'utf8'}));
  assert.equal(manifest.distribution,'managed-runtime');assert.equal(manifest.serviceSupport,true);assert.equal(manifest.runtime.version,process.version);
  assert.ok(manifest.files.every(f=>f.path==='bin/node'||f.path==='LICENSES/node-LICENSE'||f.path==='LICENSES/triangle-LICENSE'||f.path==='scripts/release/install-linux-package.mjs'||/^packages\/(triangle-cli|linux-runtime|agent-worker)\/package\.json$/.test(f.path)||/^packages\/(triangle-cli|linux-runtime|agent-worker)\/(src|runners)\//.test(f.path)));
  const isolatedEnv={...process.env,PATH:'/nonexistent'};
  execFileSync('/bin/bash',[result.installer,'--archive',result.archive,'--sha256',result.sha256,'--test-root',root],{env:isolatedEnv,encoding:'utf8'});
  const wrapper=join(root,'home/.local/bin/triangle');
  const help=execFileSync(wrapper,['--help'],{env:isolatedEnv,encoding:'utf8'});assert.match(help,/Triangle|triangle/);
  const release=join(root,'home/.local/share/triangle/releases/0.0.0-native-test');
  execFileSync(join(release,'bin/node'),['--input-type=module','--eval',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');if(db.prepare('select 1 as ok').get().ok!==1)process.exit(1);db.close();"],{env:isolatedEnv,stdio:'pipe'});
  assert.equal(existsSync(join(root,'home/.config/systemd')),false);
 } finally {rmSync(output,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});}
});
test('ELF dependencies permit only standard libraries and the architecture loader',async()=>{
 const {validateELFDependencies}=await import('../scripts/release/build-linux-package.mjs');
 const dynamic=' 0x0000000000000001 (NEEDED) Shared library: [libc.so.6]\n 0x0000000000000001 (NEEDED) Shared library: [libstdc++.so.6]';
 const interpreter=' [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]';
 assert.doesNotThrow(()=>validateELFDependencies(dynamic,interpreter,'x64'));
 for(const bad of [' 0x1 (RPATH) Library rpath: [/opt/private]',' 0x1 (RUNPATH) Library runpath: [/opt/private]',' 0x1 (NEEDED) Shared library: [/opt/private/libc.so.6]',' 0x1 (NEEDED) Shared library: [libssl.so.3]'])assert.throws(()=>validateELFDependencies(dynamic+'\n'+bad,interpreter,'x64'));
 assert.throws(()=>validateELFDependencies(dynamic,interpreter,'arm64'));
 assert.throws(()=>validateELFDependencies('',interpreter,'x64'));
 assert.throws(()=>validateELFDependencies(dynamic,'','x64'));
 assert.doesNotThrow(()=>validateELFDependencies(dynamic,' [Requesting program interpreter: /lib/ld-linux-aarch64.so.1]','arm64'));
});
test('native Linux interrupted release copy leaves no published version and retry succeeds',{skip:process.platform!=='linux'},()=>{
 const f=fixture();try {
  const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.copyFileSync;let copies=0;fs.copyFileSync=(...args)=>{original(...args);if(++copies===1)process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();process.argv=[process.execPath,${JSON.stringify(installer)},'--verified-stage',${JSON.stringify(f.stage)},'--test-root',${JSON.stringify(f.root)}];await import(${JSON.stringify('file://'+installer)});`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','--eval',script],{stdio:'pipe'}));
  assert.equal(existsSync(join(f.root,'home/.local/share/triangle/releases/1.2.3')),false);
  install(f);assert.ok(existsSync(join(f.root,'home/.local/share/triangle/releases/1.2.3/bin/node')));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('native Linux serializes parallel versions and a crashed lock holder releases the account lock',{skip:process.platform!=='linux'},async()=>{
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');
 const f=fixture(), next=fixture('1.2.4');let holder,children=[];
 try {
  const lock=join(f.root,'home/.triangle-package-install.sqlite');writeFileSync(lock,'',{mode:0o600});
  const script=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(lock)});db.exec('BEGIN IMMEDIATE');process.stdout.write('locked');setInterval(()=>{},1000);`;
  holder=spawn(process.execPath,['--input-type=module','--eval',script],{stdio:['ignore','pipe','pipe']});await once(holder.stdout,'data');
  let closed=0;
  children=[f.stage,next.stage].map(stage=>{const child=spawn(process.execPath,[installer,'--verified-stage',stage,'--test-root',f.root],{stdio:['ignore','pipe','pipe']});child.on('close',()=>closed++);return child;});
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(closed,0,'both installers wait while the account lock is held');
  const completions=children.map(child=>once(child,'close'));holder.kill('SIGKILL');
  for(const [code] of await Promise.all(completions))assert.equal(code,0);
  const receipt=JSON.parse(readFileSync(join(f.root,'home/.local/share/triangle/package-install.json')));
  assert.match(readFileSync(join(f.root,'home/.local/bin/triangle'),'utf8'),new RegExp('releases/'+receipt.version.replaceAll('.','\\.')));
  assert.equal(receipt.owned[join(f.root,'home/.local/bin/triangle')],hash(readFileSync(join(f.root,'home/.local/bin/triangle'))));
 }finally{holder?.kill('SIGKILL');for(const child of children)child.kill('SIGKILL');rmSync(f.root,{recursive:true,force:true});rmSync(next.root,{recursive:true,force:true});}
});
test('native Linux recovers SIGKILL after fresh and upgrade wrapper publication and rejects edits',{skip:process.platform!=='linux'},()=>{
 for(const mode of ['fresh','upgrade','edited']){
  const f=fixture();try{
   if(mode==='upgrade'){install(f);const path=join(f.stage,'package-manifest.json'),m=JSON.parse(readFileSync(path));m.version='1.2.4';writeFileSync(path,JSON.stringify(m),{mode:0o600});}
   const wrapper=join(f.root,'home/.local/bin/triangle');
   const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.renameSync;fs.renameSync=(from,to)=>{original(from,to);if(to===${JSON.stringify(wrapper)})process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();process.argv=[process.execPath,${JSON.stringify(installer)},'--verified-stage',${JSON.stringify(f.stage)},'--test-root',${JSON.stringify(f.root)}];await import(${JSON.stringify('file://'+installer)});`;
   assert.throws(()=>execFileSync(process.execPath,['--input-type=module','--eval',script],{stdio:'pipe'}));
   const intent=join(f.root,'home/.triangle-package-install-intent.json');assert.ok(existsSync(intent));
   if(mode==='edited'){writeFileSync(wrapper,'custom edit');assert.throws(()=>install(f));assert.equal(readFileSync(wrapper,'utf8'),'custom edit');assert.ok(existsSync(intent));}
   else{install(f);assert.equal(existsSync(intent),false);const receipt=JSON.parse(readFileSync(join(f.root,'home/.local/share/triangle/package-install.json')));assert.equal(receipt.owned[wrapper],hash(readFileSync(wrapper)));assert.equal(receipt.version,mode==='upgrade'?'1.2.4':'1.2.3');}
  }finally{rmSync(f.root,{recursive:true,force:true});}
 }
});

test('validateNode enforces expected Node SHA-256 digest before ELF inspection', async () => {
 const { validateNode } = await import('../scripts/release/build-linux-package.mjs');
 const file = mkdtempSync(join(tmpdir(), 'node-digest-test-')) + '/dummy-node';
 writeFileSync(file, 'dummy content');
 try {
  assert.throws(() => validateNode(file, file, 'invalid-hex'), /Invalid --node-sha256 digest/);
  assert.throws(() => validateNode(file, file, '0'.repeat(64)), /Bundled Node digest mismatch/);
 } finally {
  rmSync(dirname(file), { recursive: true, force: true });
 }
});
test('installer safePath and syncDir durably validate paths and handle directories', async () => {
 const { safePath, syncDir } = await import('../scripts/release/install-linux-package.mjs');
 const dir = mkdtempSync(join(tmpdir(), 'installer-safepath-test-'));
 try {
  chmodSync(dir, 0o700);
  assert.doesNotThrow(() => safePath(dir, { privateMode: true }));
  assert.doesNotThrow(() => syncDir(dir));
  const link = join(dir, 'link-dest');
  symlinkSync(dir, link);
  assert.throws(() => safePath(link, { directory: true }), /Unsafe symlink path/);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test('installer safePath rejects user-created ancestor symlinks and destination symlinks', async () => {
 const { safePath } = await import('../scripts/release/install-linux-package.mjs');
 const root = mkdtempSync(join(tmpdir(), 'installer-symlink-test-'));
 try {
  chmodSync(root, 0o700);
  const realDir = join(root, 'real');
  mkdirSync(realDir, { mode: 0o700 });
  const realFile = join(realDir, 'file');
  writeFileSync(realFile, 'hello', { mode: 0o600 });
  const symlinkDir = join(root, 'symdir');
  symlinkSync(realDir, symlinkDir);
  // Destination symlink is rejected
  assert.throws(() => safePath(symlinkDir, { directory: true }), /Unsafe symlink path/);
  // User-owned ancestor symlink is rejected
  assert.throws(() => safePath(join(symlinkDir, 'file'), { directory: false }), /Unsafe symlink path/);
 } finally {
  rmSync(root, { recursive: true, force: true });
 }
});

test('native Linux managed runtime packages require host and runner closure', {skip:process.platform!=='linux'}, () => {
 const f=fixture();try {const file=join(f.stage,'package-manifest.json');const m=JSON.parse(readFileSync(file));m.distribution='managed-runtime';m.serviceSupport=true;writeFileSync(file,JSON.stringify(m));assert.throws(()=>install(f));assert.equal(existsSync(join(f.root,'home/.local/share/triangle')),false);}finally{rmSync(f.root,{recursive:true,force:true});}
});
