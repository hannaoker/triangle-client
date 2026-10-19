import test from 'node:test';
import assert from 'node:assert/strict';
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
