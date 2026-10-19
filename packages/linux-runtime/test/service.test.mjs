import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderUnit, createService } from '../src/service.mjs';
test('systemd unit quotes special paths and contains only bundled host arguments', () => {
 const unit = renderUnit({ node: '/opt/triangle 100%/bin/node', releaseRoot: '/opt/triangle 100%' }, '/tmp/profile "$x".json');
 assert.match(unit, /100%%/);
 assert.match(unit, /\$\$x/);
 assert.match(unit, /UMask=0077/);
 assert.match(unit, /KillMode=control-group/);
 assert.match(unit, /Restart=on-failure/);
 assert.doesNotMatch(unit, /Environment=|auth\.json|workload-key|owner-key/);
});
test('systemd unit refuses control-character path injection', () => {
 assert.throws(() => renderUnit({ node: '/bin/node\nEnvironment=SECRET', releaseRoot: '/opt/release' }, '/tmp/profile.json'), /Invalid service path/);
});

test('active process is ready only with fresh matching verified health', async () => {
 const config = { agentId: 'agent-test', stateRoot: '/tmp/state', pollIntervalMs: 30000 };
 let health = { profile: 'valid', agentId: 'agent-test', pid: 42, ready: true, verified: true, updatedAt: 10000 };
 const service = createService({ now: () => 11000, run: async () => ({ code: 0, stdout: 'ActiveState=active\nMainPID=42\n' }), readProfileImpl: () => config, openStoreImpl: () => ({ readHealth: () => health, status: () => ({ phase: 'quarantined' }), close() {} }) });
 assert.equal((await service.status({ profile: 'valid' })).state, 'running');
 for (const patch of [{ pid: 43 }, { verified: false }, { ready: false }, { agentId: 'other' }, { profile: 'other' }, { updatedAt: -100000 }]) {
   const original = health; health = { ...health, ...patch };
   assert.equal((await service.status({ profile: 'valid' })).state, 'needs_attention'); health = original;
 }
});
test('retry requires explicit consent and delivery before touching journal', async () => {
 const service = createService({ readProfileImpl: () => { throw Error('must not read'); } });
 await assert.rejects(service.retry({ profile: 'valid', delivery: '1' }), /--delivery ID --yes/);
});

test('systemd preserves explicit XDG roots without expanding dollars or percent specifiers', () => {
 const unit=renderUnit({node:'/opt/release/bin/node',releaseRoot:'/opt/release'}, '/tmp/profile.json', {XDG_DATA_HOME:'/tmp/data $literal 10%',XDG_STATE_HOME:'/tmp/state',XDG_CONFIG_HOME:'/tmp/config'});
 assert.match(unit,/Environment="XDG_DATA_HOME=\/tmp\/data \$literal 10%%"/);
 assert.match(unit,/Environment="XDG_STATE_HOME=\/tmp\/state"/);
 assert.match(unit,/Environment="XDG_CONFIG_HOME=\/tmp\/config"/);
 assert.throws(()=>renderUnit({node:'/opt/release/bin/node',releaseRoot:'/opt/release'}, '/tmp/profile.json', {TOKEN:'secret'}), /Invalid service environment/);
});

test('custom XDG unit is enabled by absolute path and carries matching host roots', async () => {
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'triangle-unit-')));
 try {
 const env={HOME:root,XDG_STATE_HOME:path.join(root,'state'),XDG_DATA_HOME:path.join(root,'data'),XDG_CONFIG_HOME:path.join(root,'configuration')};
 const calls=[];const config={profile:'valid',node:'/opt/release/bin/node',releaseRoot:'/opt/release',agentId:'agent-test',stateRoot:path.join(root,'journal'),pollIntervalMs:30000};
 const health={profile:'valid',agentId:'agent-test',pid:42,ready:true,verified:true,updatedAt:10000};
 const service=createService({env,accountHome:root,now:()=>11000,readProfileImpl:()=>config,run:async(_command,args)=>{calls.push(args);return {code:0,stdout:'ActiveState=active\nMainPID=42\n'};},openStoreImpl:()=>({readHealth:()=>health,status:()=>({}),close(){}})});
 assert.equal((await service.start({profile:'valid'})).state,'running');
 const file=path.join(env.XDG_CONFIG_HOME,'systemd/user/triangle-valid.service');
 assert.ok(calls.some(args=>args.includes('enable')&&args.includes(file)));
 const unit=readFileSync(file,'utf8');
 for(const key of ['XDG_STATE_HOME','XDG_DATA_HOME','XDG_CONFIG_HOME'])assert.ok(unit.includes(key+'='+env[key]));
 }finally{rmSync(root,{recursive:true,force:true});}
});
