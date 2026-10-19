// Composes the real owner onboarding and local adapter; only HTTP authority and
// executable/service boundaries are substituted. Every filesystem write is temporary.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setup } from '../src/setup.mjs';
import { createSetupRuntime, profileInstanceId } from '../src/setup-runtime.mjs';
import { createFakeAuthority } from './fake-authority.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('guided setup composes real enrollment, verification, private runtime staging and lifecycle, then reruns without changing identity or settings', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'triangle-setup-integration-')));
  try {
    const accountHome = path.join(root, 'account');
    const appRoot = path.join(accountHome, 'Library/Application Support/The Triangle');
    const releaseRoot = path.join(root, 'release');
    const home = path.join(appRoot, 'v1');
    const profile = 'integrated-codex';
    const nativeBin = path.join(accountHome, 'native-bin');
    for (const directory of [accountHome, path.join(appRoot, 'bin'), path.join(appRoot, 'client/instances'), path.join(appRoot, 'profiles-v1'), path.join(releaseRoot, 'bin'), path.join(releaseRoot, 'packages/agent-worker/src'), nativeBin, path.join(accountHome, '.codex')]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    for (const executable of ['triangle-mailbox', 'triangle-client']) writeFileSync(path.join(appRoot, 'bin', executable), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(path.join(nativeBin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(path.join(accountHome, '.codex/auth.json'), '{"integration":"isolated-test-sign-in"}', { mode: 0o600 });
    const userConfig = path.join(accountHome, '.codex/config.toml');
    writeFileSync(userConfig, 'model = "keep-user-choice"\n', { mode: 0o600 });
    const settingsBefore = readFileSync(userConfig);
    const artifact = 'packages/agent-worker/src/client-supervisor-cli.mjs';
    writeFileSync(path.join(releaseRoot, artifact), '// selected isolated integration artifact\n', { mode: 0o600 });
    writeFileSync(path.join(releaseRoot, 'bin/node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(path.join(releaseRoot, 'worker-artifacts.json'), JSON.stringify({ version: 8, kinds: { supervisor: [artifact], codex: [artifact] } }), { mode: 0o600 });
    const files = ['bin/node', artifact, 'worker-artifacts.json'].map((relative) => {
      const file = path.join(releaseRoot, relative);
      const bytes = readFileSync(file);
      return { path: relative, sha256: sha256(bytes), size: bytes.length, mode: statSync(file).mode & 0o777 };
    });
    writeFileSync(path.join(releaseRoot, 'package-manifest.json'), JSON.stringify({ schema: 1, version: '0.0.0-integration', credentialCustody: 'file', signingMode: 'public_ad_hoc', platform: 'darwin', arch: process.arch, files }), { mode: 0o600 });

    const authority = createFakeAuthority();
    const invite = authority.mintInvite();
    const inviteFile = path.join(root, 'private-invite');
    writeFileSync(inviteFile, invite.link, { mode: 0o600 });
    const calls = [];
    let verifiedAgentId;
    let running = false;
    const run = async (command, args, options) => {
      calls.push({ command, args, options });
      assert.equal(options.env.HOME, accountHome);
      assert.equal(options.cwd, accountHome);
      assert.ok(!JSON.stringify({ args, options }).includes(invite.secret), 'invitation never enters subprocess arguments or environment');
      let result = {};
      if (command === path.join(appRoot, 'bin/triangle-mailbox')) {
        const selectedProfile = args[args.indexOf('--profile') + 1];
        assert.equal(selectedProfile, profile);
        if (args[0] === 'bind') {
          const keyFile = args[args.indexOf('--key-file') + 1];
          verifiedAgentId = path.basename(path.dirname(keyFile));
          assert.ok(existsSync(keyFile));
          writeFileSync(path.join(appRoot, 'profiles-v1', `profile-${Buffer.from(profile).toString('hex')}.json`), JSON.stringify({ profile, keyFile }), { mode: 0o600 });
        } else assert.equal(args[0], 'status');
        result = { status: 'verified', agentId: verifiedAgentId, origin: authority.authority };
      } else if (command === path.join(appRoot, 'bin/triangle-client')) {
        assert.equal(args[0], 'agent');
        assert.ok(['add', 'enable'].includes(args[1]));
        assert.equal(args[args.indexOf('--profile') + 1], profile);
        const instance = { profile, runtimeAdapter: 'codex', enabled: true };
        writeFileSync(path.join(appRoot, 'client/instances', `${profileInstanceId(profile)}.json`), JSON.stringify(instance), { mode: 0o600 });
        running = true;
        result = { agents: [instance] };
      } else {
        assert.equal(command, '/bin/launchctl');
        assert.equal(args[0], 'print');
        return { code: running ? 0 : 1, stdout: running ? 'state = running\npid = 123\n' : '', stderr: '' };
      }
      return { code: 0, stdout: JSON.stringify(result), stderr: '' };
    };
    const env = { PATH: nativeBin };
    const runtime = createSetupRuntime({ accountHome, releaseRoot, platform: 'darwin', env, run });
    const dependencies = { accountHome, releaseRoot, platform: 'darwin', env, runtime, fetchImpl: authority.fetchImpl };
    const options = { home, profile, harness: 'codex', workdir: accountHome, inviteFile };
    const first = await setup(options, dependencies);
    assert.equal(first.state, 'running');
    assert.equal(first.agent.agent_id, verifiedAgentId);
    assert.equal(authority.state.agents.size, 1);
    assert.equal(authority.state.owners.size, 1);
    assert.ok(existsSync(path.join(appRoot, 'worker-runtime/supervisor.manifest.json')));
    assert.ok(existsSync(path.join(appRoot, 'worker-runtime/codex.manifest.json')));
    assert.equal(JSON.parse(readFileSync(path.join(appRoot, 'client/headless-runtime-binding.json'))).profiles.length, 1);
    assert.deepEqual(readFileSync(userConfig), settingsBefore);
    const ownerKeyBefore = readFileSync(path.join(home, 'owner/owner-key.json'));

    rmSync(inviteFile);
    const second = await setup({ ...options, inviteFile: undefined }, dependencies);
    assert.equal(second.state, 'running');
    assert.equal(second.agent.agent_id, first.agent.agent_id);
    assert.equal(authority.state.agents.size, 1);
    assert.equal(authority.state.owners.size, 1);
    assert.deepEqual(readFileSync(path.join(home, 'owner/owner-key.json')), ownerKeyBefore);
    assert.deepEqual(readFileSync(userConfig), settingsBefore);
    assert.deepEqual(calls.filter((call) => call.args[0] === 'agent').map((call) => call.args[1]), ['add', 'enable']);
    assert.equal(JSON.parse(readFileSync(path.join(appRoot, 'client/headless-runtime-binding.json'))).profiles.length, 1);
    assert.ok(!JSON.stringify([first, second]).includes(invite.secret));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
