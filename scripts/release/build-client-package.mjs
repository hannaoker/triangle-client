#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const args=process.argv.slice(2), options={};
for(let i=0;i<args.length;i+=2){if(!['--version','--helper','--client','--node','--output','--test-root'].includes(args[i])||!args[i+1])throw Error('Usage: build-client-package.mjs --version VERSION --output DIR [--helper FILE --client FILE] [--node FILE]');options[args[i].slice(2)]=args[i+1];}
if(!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(options.version??''))throw Error('An explicit safe release version is required');
if(process.platform!=='darwin')throw Error('Only macOS packages are supported');
if(!options.output)throw Error('--output is required');
const scratch=mkdtempSync(join(tmpdir(),'triangle-package-build-'));
const digest=data=>createHash('sha256').update(data).digest('hex');
try{
 const stage=join(scratch,'payload');mkdirSync(stage,{mode:0o700});
 let helper=options.helper,client=options.client;
 if(Boolean(helper)!==Boolean(client))throw Error('Provide both --helper and --client');
 if(!helper){const build=join(scratch,'swift');for(const product of ['triangle-mailbox','triangle-client'])execFileSync('/usr/bin/swift',['build','-c','release','--package-path',join(root,'packages/macos-mailbox-helper'),'--scratch-path',build,'-Xswiftc','-DTRIANGLE_FILE_CUSTODY_REQUIRED','--product',product],{stdio:'inherit'});helper=join(build,'release/triangle-mailbox');client=join(build,'release/triangle-client');}
 const fixture=options['test-root'];if(fixture){const canonical=realpathSync(fixture);if(!canonical.startsWith(realpathSync(tmpdir())+'/triangle-package-install-')||canonical!==resolve(fixture))throw Error('Fake binaries require a canonical temporary test root');for(const p of [helper,client])if(!realpathSync(p).startsWith(canonical+'/'))throw Error('Fake binary must remain in test root');}
 const sourceFiles=execFileSync('git',['ls-files','-z'],{cwd:root}).toString().split('\0').filter(p=>p&&(/^(packages\/(triangle-cli|agent-worker)\/(src|runners)\/.*\.(mjs|json|sh)$)/.test(p)||/^packages\/(triangle-cli|agent-worker)\/package\.json$/.test(p)||/^scripts\/(triangle-client-service\.sh|triangle-worker-service\.sh|triangle-worker-install\.py|triangle-headless-drain-service\.sh|triangle-headless-engagement-doctor\.mjs|macos-shared-codex-app-server-host\.mjs)$/.test(p)||/^deploy\/launchd\/dev\.thetriangle\.(client|agent-worker|codex-headless-drain)\.plist\.template$/.test(p)||/^scripts\/release\/(install-client-package\.mjs|verify-client-package\.pl)$/.test(p)));
 // Only tracked, reviewed runtime source enters a package. No home directories,
 // environment files, build caches, profile registries or private keys are read.
 for(const relative of sourceFiles){const source=join(root,relative),info=lstatSync(source);if(!info.isFile()||info.isSymbolicLink())throw Error(`Nonregular source asset: ${relative}`);const target=join(stage,relative);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(source,target);chmodSync(target,0o600);}
 const binaries={'node':options.node??process.execPath,'triangle-mailbox':helper,'triangle-client':client};
 mkdirSync(join(stage,'bin'),{mode:0o700});
 for(const [name,path] of Object.entries(binaries)){const source=realpathSync(path);if(!lstatSync(source).isFile())throw Error('Binary must be regular');copyFileSync(source,join(stage,'bin',name));chmodSync(join(stage,'bin',name),0o700);if(name!=='node'&&!fixture){execFileSync('/usr/bin/codesign',['--force','--sign','-','--identifier',name==='triangle-mailbox'?'dev.thetriangle.mailbox':'dev.thetriangle.client',join(stage,'bin',name)]);execFileSync('/usr/bin/codesign',['--verify','--strict',join(stage,'bin',name)]);const version=execFileSync(join(stage,'bin',name),['--version'],{encoding:'utf8'});if(!/public_ad_hoc/.test(version))throw Error(`${name} must be a public_ad_hoc/file-custody build`);}}
 const nodeInfo=JSON.parse(execFileSync(join(stage,'bin/node'),['-p','JSON.stringify({platform:process.platform,arch:process.arch,major:Number(process.versions.node.split(".")[0])})'],{encoding:'utf8'}));if(nodeInfo.platform!=='darwin'||nodeInfo.arch!==process.arch||nodeInfo.major<22)throw Error('Bundled Node must be native macOS Node >=22');
 const paths=[...sourceFiles,...Object.keys(binaries).map(name=>'bin/'+name)].sort();
 for(const required of ['packages/triangle-cli/src/cli.mjs','scripts/triangle-worker-install.py','scripts/release/install-client-package.mjs'])if(!paths.includes(required))throw Error(`Missing tracked required asset: ${required}`);
 const manifest={schema:1,version:options.version,platform:'darwin',arch:process.arch,signingMode:'public_ad_hoc',credentialCustody:'file',testOnly:Boolean(fixture),files:paths.map(path=>({path,size:lstatSync(join(stage,path)).size,mode:path.startsWith('bin/')?0o700:0o600,sha256:digest(readFileSync(join(stage,path)))}))};
 writeFileSync(join(stage,'package-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
 mkdirSync(resolve(options.output),{recursive:true});const archive=join(resolve(options.output),`triangle-client-${options.version}-darwin-${process.arch}.tar.gz`);if(existsSync(archive))throw Error('Archive already exists; select a new output directory/version');
 execFileSync('/usr/bin/tar',['--format','ustar','-czf',archive,'-C',stage,'package-manifest.json',...paths]);const sha256=digest(readFileSync(archive));writeFileSync(archive+'.sha256',sha256+'  '+archive.split('/').at(-1)+'\n',{flag:'wx'});console.log(JSON.stringify({archive,sha256,version:manifest.version,files:paths.length,testOnly:manifest.testOnly}));
}finally{rmSync(scratch,{recursive:true,force:true});}
