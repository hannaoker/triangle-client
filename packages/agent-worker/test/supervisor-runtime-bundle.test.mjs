import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const installer = path.join(repo, 'scripts/triangle-worker-install.py');
const python = '/usr/bin/python3';
function installed(run) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'triangle-supervisor-')));
  chmodSync(root, 0o700);
  try {
    execFileSync(python, [installer, 'stage-runtime', '--agent', 'supervisor', '--application-root', root, '--project-root', repo, '--node', realpathSync(process.execPath)]);
    const manifest = path.join(root, 'worker-runtime/supervisor.manifest.json');
    run(manifest, JSON.parse(readFileSync(manifest)));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function validate(manifest) { return spawnSync(python, [installer, 'validate-runtime', '--agent', 'supervisor', '--manifest', manifest], { encoding: 'utf8' }); }
test('Cursor-only supervisor installs with Node alone and runs the complete coordinator import closure', () => installed((manifest, value) => {
  assert.equal(validate(manifest).status, 0);
  assert.deepEqual(value.environment, { PATH: `${value.projectRoot}/bin:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C' });
  assert.equal(value.version, 8);
  assert.ok(!Object.keys(value.artifacts).some(p => p.includes('/agents/') || /runners\/(codex|hermes|antigravity)-runner/.test(p)));
  execFileSync(path.join(value.projectRoot, 'bin/node'), ['--input-type=module', '-e', `await import(${JSON.stringify(path.join(value.projectRoot, 'packages/agent-worker/src/client-supervisor.mjs'))})`], { env: value.environment });
}));
for (const mutation of ['artifact', 'node', 'environment', 'extra', 'mode', 'untracked-file', 'symlink']) {
  test(`supervisor validation rejects ${mutation} corruption`, () => installed((manifest, value) => {
    if (mutation === 'artifact') writeFileSync(path.join(value.projectRoot, Object.keys(value.artifacts)[0]), 'tampered');
    if (mutation === 'node') value.nodeSHA256 = '0'.repeat(64);
    if (mutation === 'environment') value.environment.CODEX_CLI = '/usr/bin/true';
    if (mutation === 'extra') value.artifacts['agents/codex/worker/agent-worker.json'] = '0'.repeat(64);
    if (mutation === 'untracked-file') writeFileSync(path.join(value.projectRoot, 'untracked.mjs'), 'untrusted');
    if (mutation === 'symlink') { const file = path.join(value.projectRoot, Object.keys(value.artifacts)[0]); rmSync(file); symlinkSync('/etc/hosts', file); }
    if (mutation === 'mode') chmodSync(path.join(value.projectRoot, 'bin/node'), 0o700);
    if (['node', 'environment', 'extra'].includes(mutation)) writeFileSync(manifest, JSON.stringify(value));
    assert.notEqual(validate(manifest).status, 0);
  }));
}

test('service preparation accepts a validated standalone supervisor without any harness CLI', () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'triangle-supervisor-service-')));
  chmodSync(home, 0o700);
  try {
    execFileSync(python, [installer, 'ensure-tree', '--home', home]);
    const root = path.join(home, 'Library/Application Support/The Triangle');
    execFileSync(python, [installer, 'stage-runtime', '--agent', 'supervisor', '--application-root', root, '--project-root', repo, '--node', realpathSync(process.execPath)]);
    execFileSync('/bin/bash', [path.join(repo, 'scripts/triangle-client-service.sh'), 'prepare-runtime'], { env: { HOME: home, PATH: '/usr/bin:/bin' } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
