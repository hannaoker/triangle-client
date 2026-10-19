import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const installer=resolve('scripts/release/install-linux-package.mjs');
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(version='1.2.3') {
 const root=mkdtempSync(join(tmpdir(),'triangle-package-install-')); chmodSync(root,0o700);
 mkdirSync(join(root,'home'),{mode:0o700}); const stage=join(root,'stage'); mkdirSync(stage,{mode:0o700});
 const assets={'bin/node':'runtime','packages/triangle-cli/src/cli.mjs':'console.log("help")','scripts/release/install-linux-package.mjs':'installer','LICENSES/node-LICENSE':'license','packages/triangle-cli/package.json':'{}'};
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
