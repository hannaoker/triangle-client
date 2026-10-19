#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
const hash=data=>createHash('sha256').update(data).digest('hex');
export function validateELFDependencies(dynamic, programHeaders, arch) {
 const loader = { x64: '/lib64/ld-linux-x86-64.so.2', arm64: '/lib/ld-linux-aarch64.so.1' }[arch];
 const interpreters = [...programHeaders.matchAll(/\[Requesting program interpreter:\s*([^\]]+)\]/g)].map(match=>match[1]);
 if (!loader || interpreters.length !== 1 || interpreters[0] !== loader) throw Error('Bundled Node requires the standard architecture ELF interpreter');
 if (/\((?:RPATH|RUNPATH)\)/.test(dynamic)) throw Error('Bundled Node must not specify RPATH or RUNPATH');
 const allowed = new Set(['libc.so.6','libstdc++.so.6','libgcc_s.so.1','libm.so.6','libdl.so.2','libpthread.so.0','librt.so.1',loader.split('/').at(-1)]);
 const neededLines = dynamic.split('\n').filter(line=>/\(NEEDED\)/.test(line));
 if (!neededLines.length) throw Error('Bundled Node must declare standard dynamic libraries');
 for (const line of neededLines) {
  const soname = line.match(/\(NEEDED\)\s+Shared library:\s*\[([^\]]+)\]\s*$/)?.[1];
  if (!soname || !allowed.has(soname)) throw Error('Bundled Node depends on a non-system dynamic library');
 }
}
export function validateNode(node, license, expectedSha256) {
 const env={...process.env}; delete env.NODE_OPTIONS; delete env.NODE_PATH;
 const bytes=readFileSync(node);
 const nodeDigest=hash(bytes);
 if (expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw Error('Invalid --node-sha256 digest');
  if (nodeDigest !== expectedSha256) throw Error(`Bundled Node digest mismatch: expected ${expectedSha256}, got ${nodeDigest}`);
 }
 if(bytes.subarray(0,4).toString('hex')!=='7f454c46' || bytes[4]!==2 || bytes[5]!==1 || bytes.readUInt16LE(18)!==({x64:62,arm64:183}[process.arch])) throw Error('Bundled Node must be a native Linux ELF executable');
 const info=JSON.parse(execFileSync(node,['-p','JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})'],{env,encoding:'utf8',timeout:10000}));
 if(info.platform!=='linux'||info.arch!==process.arch||Number(info.version.slice(1).split('.')[0])<22)throw Error('Bundled Node must be native Linux Node >=22');
 execFileSync(node,['--input-type=module','--eval',"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');if(db.prepare('select 1 as ok').get().ok!==1)throw Error('SQLite failed');db.close();"],{env,timeout:10000,stdio:'pipe'});
 // Inspect ELF metadata without executing its loader's trace mode. That mode
 // crashes under some QEMU x64 environments even when Node and SQLite run.
 // readelf (binutils) is a maintainer build prerequisite, never an install one.
 const readELF = flags => execFileSync('readelf',[flags,'--wide',node],{encoding:'utf8',env:{...env,LC_ALL:'C'},timeout:10000});
 validateELFDependencies(readELF('-d'),readELF('-l'),process.arch);
 // Node has no runtime license API. The caller must supply the LICENSE from
 // the same Node distribution; its exact bytes are hashed into the manifest.
 const licenseInfo=lstatSync(license);
 if(!licenseInfo.isFile()||licenseInfo.isSymbolicLink())throw Error('Matching Node LICENSE must be a regular file');
 const text=readFileSync(license,'utf8');
 if(text.length<1000||!text.includes('Node.js')||!text.includes('Permission is hereby granted, free of charge'))throw Error('Matching Node distribution LICENSE is required (--node-license)');
 return { ...info, sha256: nodeDigest };
}
function main() {
 const options={};const args=process.argv.slice(2);
 for(let i=0;i<args.length;i+=2){if(!['--version','--output','--node','--node-license','--node-sha256'].includes(args[i])||!args[i+1])throw Error('Usage: build-linux-package.mjs --version VERSION --output DIR [--node FILE --node-license FILE --node-sha256 DIGEST]');options[args[i].slice(2)]=args[i+1];}
 if(process.platform!=='linux'||!['x64','arm64'].includes(process.arch))throw Error('Linux packages require native Linux x64 or arm64');
 if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(options.version??''))throw Error('Explicit safe release version required');
 if(!options.output)throw Error('--output is required');
 const root=resolve(import.meta.dirname,'../..'),node=realpathSync(options.node??process.execPath);
 const license=options['node-license']??join(dirname(node),'../LICENSE');
 const runtime=validateNode(node,license,options['node-sha256']);
 const output=resolve(options.output);mkdirSync(output,{recursive:true,mode:0o700});
 const info=lstatSync(output);if(!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o022)||realpathSync(output)!==output)throw Error('Unsafe release output directory');
 const archive=join(output,`triangle-client-${options.version}-linux-${process.arch}.tar.gz`),installer=join(output,`triangle-install-${options.version}.sh`);
 for(const path of [archive,archive+'.sha256',installer,installer+'.sha256']) {try{lstatSync(path);throw Error('Release output already exists');}catch(e){if(e.code!=='ENOENT')throw e;}}
 const scratch=mkdtempSync(join(tmpdir(),'triangle-linux-build-'));
 try{
 const stage=join(scratch,'payload');mkdirSync(stage,{mode:0o700});
 const source=execFileSync('git',['ls-files','-z'],{cwd:root}).toString().split('\0').filter(p=>p&&(/^packages\/(triangle-cli|linux-runtime|agent-worker)\/(src|runners)\/.*\.(mjs|json)$/.test(p)||/^packages\/(triangle-cli|linux-runtime|agent-worker)\/package\.json$/.test(p)||p==='scripts/release/install-linux-package.mjs'));
 for(const required of ['packages/triangle-cli/src/cli.mjs','scripts/release/install-linux-package.mjs','packages/triangle-cli/package.json','packages/linux-runtime/src/host.mjs','packages/linux-runtime/src/runner.mjs','packages/agent-worker/runners/codex-runner.mjs'])if(!source.includes(required))throw Error(`Missing tracked asset: ${required}`);
 const dirty=execFileSync('git',['status','--porcelain','--',...source,'LICENSE','scripts/install.sh'],{cwd:root,encoding:'utf8'}).trim();
 if(dirty) throw Error('Refusing to build package from dirty working tree:\n'+dirty);
 const files=[];
 for(const [path,from,mode] of [...source.map(p=>[p,join(root,p),0o600]),['bin/node',node,0o700],['LICENSES/node-LICENSE',license,0o600],['LICENSES/triangle-LICENSE',join(root,'LICENSE'),0o600]]){
 const info=lstatSync(from);if(!info.isFile()||info.isSymbolicLink())throw Error(`Nonregular asset: ${path}`);
 const target=join(stage,path);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(from,target);chmodSync(target,mode);files.push({path,size:info.size,mode,sha256:hash(readFileSync(target))});
 }
 files.sort((a,b)=>a.path.localeCompare(b.path));
 const manifest={schema:1,version:options.version,platform:'linux',arch:process.arch,credentialCustody:'file',signingMode:'none',distribution:'managed-runtime',serviceSupport:true,runtime:{name:'node',version:runtime.version,sha256:runtime.sha256,license:'LICENSES/node-LICENSE',licenseSHA256:hash(readFileSync(license))},files};
 writeFileSync(join(stage,'package-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
 const temporaryArchive=join(scratch,'archive.tar.gz');
 execFileSync('tar',['--format=ustar','--owner=0','--group=0','--numeric-owner','-czf',temporaryArchive,'-C',stage,'package-manifest.json',...files.map(f=>f.path)],{env:{...process.env,COPYFILE_DISABLE:'1',TAR_OPTIONS:''}});
 const bytes=readFileSync(temporaryArchive);writeFileSync(archive,bytes,{flag:'wx',mode:0o600});
 writeFileSync(archive+'.sha256',hash(bytes)+'  '+archive.split('/').at(-1)+'\n',{flag:'wx',mode:0o600});
 const bootstrap=readFileSync(join(root,'scripts/install.sh'));writeFileSync(installer,bootstrap,{flag:'wx',mode:0o700});writeFileSync(installer+'.sha256',hash(bootstrap)+'  '+installer.split('/').at(-1)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({archive,sha256:hash(bytes),installer,installerSHA256:hash(bootstrap),version:manifest.version,files:files.length}));
 }finally{rmSync(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))main();
