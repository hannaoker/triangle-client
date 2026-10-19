import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setup } from '../src/setup.mjs';
import { main } from '../src/cli.mjs';
import { openCustody } from '../src/custody.mjs';
import { PassThrough } from 'node:stream';
import { createSetupPrompts } from '../src/setup-prompts.mjs';
import { createFakeAuthority } from './fake-authority.mjs';

function fixture() {
  const home = path.join(mkdtempSync(path.join(os.tmpdir(), 'triangle-setup-')), 'identity');
  const fake = createFakeAuthority();
  const invite = fake.mintInvite();
  const file = path.join(path.dirname(home), 'invite');
  writeFileSync(file, invite.link, { mode: 0o600 });
  const calls = [];
  const runtime = {
    preflight: async (options) => { calls.push(['preflight', options]); },
    configure: async (options) => { calls.push(['configure', options]); return { state: 'running', verified: true }; },
    status: async () => ({ state: 'running' }),
  };
  const options = { home, harness: 'codex', profile: 'setup-agent', inviteFile: file };
  const dependencies = { runtime, platform: 'darwin', env: {}, fetchImpl: fake.fetchImpl };
  return { home, fake, invite, file, calls, runtime, options, dependencies };
}

test('setup preflights before join, configures once with a key path and reuses identity on rerun', async () => {
  const f = fixture();
  f.runtime.preflight = async () => { assert.equal(f.fake.state.requests.length, 0); f.calls.push(['preflight']); };
  const result = await setup(f.options, f.dependencies);
  assert.equal(result.state, 'running');
  assert.equal(result.agent.handle, 'setup-agent');
  const config = f.calls.find(([type]) => type === 'configure')[1];
  assert.equal(config.agent.agent_id, result.agent.agent_id);
  assert.ok(config.keyFile.endsWith('/workload-key.json'));
  assert.ok(!JSON.stringify(result).includes(f.invite.secret));
  const owner = readFileSync(path.join(f.home, 'owner', 'owner-key.json'), 'utf8');
  f.runtime.preflight = async () => {};
  const again = await setup({ ...f.options, inviteFile: undefined }, f.dependencies);
  assert.equal(again.agent.agent_id, result.agent.agent_id);
  assert.equal(f.fake.state.agents.size, 1);
  assert.equal(readFileSync(path.join(f.home, 'owner', 'owner-key.json'), 'utf8'), owner);
});

test('setup rejects unsupported service platform and failed local preflight before reading or consuming invite', async () => {
  const f = fixture();
  await assert.rejects(setup(f.options, { ...f.dependencies, platform: 'win32' }), /macOS and Linux/);
  f.runtime.preflight = async () => { throw new Error('Missing installed harness'); };
  await assert.rejects(setup(f.options, f.dependencies), /Missing installed harness/);
  assert.equal(f.fake.state.requests.length, 0);
  assert.equal(openCustody(f.home).readController(), null);
});

test('setup recovers lost join response using identical request and no duplicate identity', async () => {
  const f = fixture();
  f.fake.state.failNext = 'drop-after-commit';
  f.fake.state.failPath = /\/redeem$/;
  await assert.rejects(setup(f.options, f.dependencies), /outcome is unknown/i);
  const result = await setup({ home: f.home, resume: true }, f.dependencies);
  assert.equal(result.state, 'running');
  assert.equal(f.fake.state.agents.size, 1);
  const redeems = f.fake.state.requests.filter((r) => r.path.endsWith('/redeem'));
  assert.deepEqual(redeems[0].body, redeems[1].body);
});

test('setup persists choice after local failure, rejects changed choices, and completes on retry', async () => {
  const f = fixture();
  f.runtime.configure = async () => { throw new Error('service unavailable'); };
  await assert.rejects(setup(f.options, f.dependencies), /service unavailable/);
  await assert.rejects(setup({ ...f.options, harness: 'hermes' }, f.dependencies), /different|conflict/i);
  f.runtime.configure = async () => ({ state: 'running' });
  assert.equal((await setup({ home: f.home, resume: true }, f.dependencies)).state, 'running');
  assert.equal(f.fake.state.agents.size, 1);
});

test('identity-only works on Linux without runtime and private invite file is enforced', async () => {
  const f = fixture();
  chmodSync(f.file, 0o644);
  await assert.rejects(setup({ ...f.options, identityOnly: true }, { ...f.dependencies, platform: 'linux' }), /private|600/i);
  chmodSync(f.file, 0o600);
  const result = await setup({ ...f.options, identityOnly: true }, { ...f.dependencies, platform: 'linux', runtime: undefined });
  assert.equal(result.state, 'joined');
  assert.equal(f.calls.length, 0);
});

test('pending device enrollment never configures service', async () => {
  const f = fixture();
  await setup({ ...f.options, identityOnly: true }, f.dependencies);
  const owner = openCustody(f.home).readController().owner_id;
  const second = fixture();
  const invite = f.fake.mintInvite({ kind: 'device', target_owner_id: owner });
  writeFileSync(second.file, invite.link, { mode: 0o600 });
  const result = await setup(second.options, { ...second.dependencies, fetchImpl: f.fake.fetchImpl });
  assert.equal(result.state, 'pending_approval');
  assert.ok(result.next_action.includes('triangle device approve'));
  assert.equal(second.calls.filter(([kind]) => kind === 'configure').length, 0);
  assert.equal(f.fake.state.agents.size, 1);
});

test('setup CLI forbids positional invite secrets and does not echo them', async () => {
  const f = fixture();
  const out = [], err = [];
  const code = await main(['setup', f.invite.link], { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } });
  assert.equal(code, 2);
  assert.ok(![...out, ...err].join().includes(f.invite.secret));
});

test('setup recovers a lost agent-create response after approved device enrollment', async () => {
  const f = fixture();
  await setup({ ...f.options, identityOnly: true }, f.dependencies);
  const second = fixture();
  const invite = f.fake.mintInvite({ kind: 'device', target_owner_id: openCustody(f.home).readController().owner_id });
  writeFileSync(second.file, invite.link);
  assert.equal((await setup(second.options, { ...second.dependencies, fetchImpl: f.fake.fetchImpl })).state, 'pending_approval');
  const controller = openCustody(second.home).readController();
  f.fake.state.controllers.get(controller.controller_id).state = 'active';
  f.fake.state.failNext = 'drop-after-commit';
  f.fake.state.failPath = /^\/api\/v1\/agents$/;
  const deps = { ...second.dependencies, fetchImpl: f.fake.fetchImpl };
  // Keep the existing owner's handle distinct from the device's new agent.
  const original = [...f.fake.state.agents.values()][0];
  original.handle = 'original-owner';
  await assert.rejects(setup({ home: second.home, resume: true }, deps), /outcome is unknown/);
  assert.equal(f.fake.state.agents.size, 2);
  const result = await setup({ home: second.home, resume: true }, deps);
  assert.equal(result.state, 'running');
  assert.equal(f.fake.state.agents.size, 2);
  const creates = f.fake.state.requests.filter((r) => r.path === '/api/v1/agents');
  assert.deepEqual(creates[0].body, creates[1].body);
});

test('setup redacts invitation secrets from server error messages', async () => {
  const f = fixture();
  const fetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/redeem')) return new Response(JSON.stringify({ error: `bad_input_${f.invite.secret}`, message: `Refused ${f.invite.link} secret ${f.invite.secret}` }), { status: 400, headers: { 'content-type': 'application/json' } });
    return f.fake.fetchImpl(input, init);
  };
  await assert.rejects(setup(f.options, { ...f.dependencies, fetchImpl }), (error) => !JSON.stringify(error.toJSON()).includes(f.invite.secret) && error.message.includes('[redacted]'));
  const journal = openCustody(f.home).readJournal('setup');
  assert.ok(!JSON.stringify(journal).includes(f.invite.secret));
});

test('setup CLI happy path prints secret-free states and preserves existing command help', async () => {
  const f = fixture();
  const out = [], err = [];
  const code = await main(['setup', '--profile', 'setup-agent', '--harness', 'codex', '--invite-file', f.file, '--home', f.home, '--json'], { env: {}, fetchImpl: f.fake.fetchImpl, setupDependencies: { runtime: f.runtime, platform: 'darwin' }, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } });
  assert.equal(code, 0, err.join());
  assert.equal(JSON.parse(out.join()).state, 'running');
  assert.ok(![...out, ...err].join().includes(f.invite.secret));
});

test('hidden invitation prompt never echoes input and restores terminal on submit and cancellation', async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough(), output = new PassThrough();
    input.isTTY = output.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (enabled) => { input.isRaw = enabled; };
    let written = '';
    output.on('data', (data) => { written += data.toString(); });
    const response = createSetupPrompts({ input, output }).invite();
    assert.equal(input.isRaw, true);
    input.write(`https://mesh.test/join#private-secret${cancel ? '\u0003' : '\r'}`);
    if (cancel) await assert.rejects(response, /cancelled/);
    else assert.equal(await response, 'https://mesh.test/join#private-secret');
    assert.equal(input.isRaw, false);
    assert.ok(!written.includes('private-secret'));
    assert.equal(input.listenerCount('data'), 0);
  }
});

test('setup adopts preflight shared workdir only when no workdir was explicitly selected', async () => {
  const f = fixture();
  const shared = path.join(path.dirname(f.home), 'shared-harness-workdir');
  f.runtime.preflight = async (options) => {
    assert.equal(options.workdirExplicit, false);
    return { state: 'ready', workdir: shared };
  };
  await setup(f.options, f.dependencies);
  assert.equal(f.calls.find(([kind]) => kind === 'configure')[1].workdir, shared);
  assert.equal(openCustody(f.home).readCache('setup', f.options.profile).workdir, shared);

  const explicit = fixture();
  const workdir = path.join(path.dirname(explicit.home), 'explicit');
  explicit.runtime.preflight = async (options) => {
    assert.equal(options.workdirExplicit, true);
    return { state: 'ready', workdir: shared };
  };
  await setup({ ...explicit.options, workdir }, explicit.dependencies);
  assert.equal(explicit.calls.find(([kind]) => kind === 'configure')[1].workdir, workdir);
});

test('setup creates an explicitly requested new profile identity rather than binding the sole existing agent', async () => {
  const f = fixture();
  const first = await setup(f.options, f.dependencies);
  const next = await setup({ ...f.options, profile: 'second-profile', inviteFile: undefined }, f.dependencies);
  assert.equal(next.agent.handle, 'second-profile');
  assert.notEqual(next.agent.agent_id, first.agent.agent_id);
  assert.equal(f.fake.state.agents.size, 2);
  const again = await setup({ ...f.options, profile: 'second-profile', inviteFile: undefined }, f.dependencies);
  assert.equal(again.agent.agent_id, next.agent.agent_id);
  assert.equal(f.fake.state.agents.size, 2);
});

test('setup preserves legacy verified binding when runtime profile and agent handle differ', async () => {
  const f = fixture();
  const original = await setup(f.options, f.dependencies);
  f.runtime.preflight = async () => ({ state: 'ready', agentId: original.agent.agent_id });
  const before = f.fake.state.requests.filter((r) => r.path === '/api/v1/agents').length;
  const adopted = await setup({ ...f.options, profile: 'legacy-worker', inviteFile: undefined }, f.dependencies);
  assert.equal(adopted.agent.agent_id, original.agent.agent_id);
  assert.equal(adopted.agent.handle, 'setup-agent');
  assert.equal(f.fake.state.agents.size, 1);
  assert.equal(f.fake.state.requests.filter((r) => r.path === '/api/v1/agents').length, before);
  assert.equal(openCustody(f.home).readCache('setup', 'legacy-worker').agentId, original.agent.agent_id);
});

test('setup rejects unknown or cached-conflicting runtime identity before remote mutation', async () => {
  const f = fixture();
  const first = await setup(f.options, f.dependencies);
  const second = await setup({ ...f.options, profile: 'second-identity', inviteFile: undefined }, f.dependencies);
  const requestCount = f.fake.state.requests.length;
  f.runtime.preflight = async () => ({ state: 'ready', agentId: 'agent_' + 'f'.repeat(32) });
  await assert.rejects(setup({ ...f.options, profile: 'legacy-worker', inviteFile: undefined }, f.dependencies), /missing locally|unknown/i);
  assert.equal(f.fake.state.requests.length, requestCount);
  f.runtime.preflight = async () => ({ state: 'ready', agentId: second.agent.agent_id });
  await assert.rejects(setup({ ...f.options, inviteFile: undefined }, f.dependencies), /conflict|different identity/i);
  assert.equal(f.fake.state.requests.length, requestCount);
  assert.equal(openCustody(f.home).readCache('setup', f.options.profile).agentId, first.agent.agent_id);
  assert.equal(f.fake.state.agents.size, 2);
});

test('Linux packaged setup defaults to portable enrollment and resumes without a runtime or new keys', async () => {
  const f = fixture();
  const options = { home:f.home, profile:'linux-agent', inviteFile:f.file };
  const dependencies = {...f.dependencies, platform:'linux', runtime:undefined, prompts:{ask:()=>{throw Error('Unexpected harness prompt');},invite:()=>{throw Error('Unexpected invite prompt');}}};
  f.fake.state.failNext='drop-after-commit';
  f.fake.state.failPath=/\/redeem$/;
  await assert.rejects(setup(options,dependencies),/unknown/i);
  const ownerBefore=readFileSync(path.join(f.home,'owner/owner-key.json'),'utf8');
  const result=await setup({home:f.home,resume:true},dependencies);
  assert.equal(result.state,'joined');
  assert.match(result.next_action,/Background service was not configured/);
  assert.equal(f.fake.state.agents.size,1);
  assert.equal(readFileSync(path.join(f.home,'owner/owner-key.json'),'utf8'),ownerBefore);
  const again=await setup({...options,inviteFile:undefined},dependencies);
  assert.equal(again.state,'joined');
  assert.equal(f.fake.state.agents.size,1);
  assert.deepEqual(f.calls,[]);
});

 test('Linux rejects unsupported harness before invitation or enrollment', async () => {
  const f = fixture();
  await assert.rejects(setup({ ...f.options, harness: 'hermes' }, { ...f.dependencies, platform: 'linux' }), /Codex only/);
  assert.equal(f.fake.state.requests.length, 0);
});
