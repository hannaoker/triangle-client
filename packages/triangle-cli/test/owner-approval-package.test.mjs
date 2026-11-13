// Pins release-capability selection and caller boundaries across all owner-approved commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from '../src/canonical.mjs';
import { describeOwnerOperation } from '../src/owner-approval.mjs';
import { loadPackagedOwnerApprovalProvider, SUPPORTED_OWNER_APPROVAL_COMMANDS } from '../src/owner-approval-package.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');

function releaseFixture(t, commands = ['identity.revoke', 'identity.destination', 'identity.chat-map']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-pkg-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = path.join(root, 'release');
  const executable = path.join(release, 'bin/triangle-owner-approval');
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
  fs.chmodSync(release, 0o700);
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const manifest = {
    schema: 1,
    platform: 'darwin',
    arch: process.arch,
    testOnly: false,
    signingMode: 'public_ad_hoc',
    credentialCustody: 'file',
    ownerApproval: {
      version: 1,
      binary: 'bin/triangle-owner-approval',
      commands,
    },
    files: [{ path: 'bin/triangle-owner-approval', mode: 0o700, sha256: sha(fs.readFileSync(executable)) }],
  };
  fs.writeFileSync(path.join(release, 'package-manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return { root, release, manifest };
}

function makeChallenge(root) {
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true, mode: 0o700 });
  const op = {
    action: 'destination.set',
    registryRoot: root,
    expectedSequence: 1,
    principalId: 'agent_' + 'c'.repeat(32),
    harness: 'claude',
    workspace: ws,
    before: null,
  };
  const request = { schema: 'owner_operation_v1', ...op, nonce: '9'.repeat(64), issuedAt: Math.floor(performance.now()), deadline: Math.floor(performance.now()) + 5000 };
  return { request, digest: sha(canonicalJson(request)), summary: describeOwnerOperation(op) };
}

test('multi-command owner approval manifest selects the macOS provider for every authorized command', async t => {
  const f = releaseFixture(t);
  const challenge = makeChallenge(f.root);
  for (const command of SUPPORTED_OWNER_APPROVAL_COMMANDS) {
    const provider = loadPackagedOwnerApprovalProvider({ command, releaseRoot: f.release, platform: 'darwin' });
    assert.equal(await provider.authenticate(challenge, { signal: AbortSignal.abort() }), 'cancelled', command);
  }
});

test('narrow or mismatched command manifests fail closed with unavailable', async t => {
  const f = releaseFixture(t, ['identity.revoke']);
  const challenge = makeChallenge(f.root);
  assert.equal(await loadPackagedOwnerApprovalProvider({ command: 'identity.revoke', releaseRoot: f.release, platform: 'darwin' }).authenticate(challenge, { signal: AbortSignal.abort() }), 'cancelled');
  for (const command of ['identity.destination', 'identity.chat-map', 'profile.move', undefined, '']) {
    assert.equal(await loadPackagedOwnerApprovalProvider({ command, releaseRoot: f.release, platform: 'darwin' }).authenticate(challenge, { signal: AbortSignal.abort() }), 'unavailable');
  }
});

test('duplicate or unsupported command entries in package-manifest refuse every command', async t => {
  for (const commands of [
    ['identity.revoke', 'identity.revoke'],
    ['identity.destination', 'profile.move'],
    ['identity.chat-map', 'shell.run'],
  ]) {
    const f = releaseFixture(t, commands);
    const challenge = makeChallenge(f.root);
    assert.equal(await loadPackagedOwnerApprovalProvider({ command: commands[0], releaseRoot: f.release, platform: 'darwin' }).authenticate(challenge, { signal: AbortSignal.abort() }), 'unavailable');
  }
});

test('packaged capability loader is reachable only through approved owner CLI bridges', () => {
  const packages = path.resolve(import.meta.dirname, '../..');
  const allowed = new Set([
    path.join(packages, 'triangle-cli/src/owner-approval-package.mjs'),
    path.join(packages, 'triangle-cli/src/identity-revoke.mjs'),
    path.join(packages, 'triangle-cli/src/identity-destination.mjs'),
    path.join(packages, 'triangle-cli/src/identity-chat-map.mjs'),
  ]);
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && file.endsWith('.mjs') && !allowed.has(file) && fs.readFileSync(file, 'utf8').includes('owner-approval-package')) {
        offenders.push(file);
      }
    }
  }
  for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
    const src = path.join(packages, entry.name, 'src');
    if (entry.isDirectory() && fs.existsSync(src)) walk(src);
  }
  assert.deepEqual(offenders, []);
});
