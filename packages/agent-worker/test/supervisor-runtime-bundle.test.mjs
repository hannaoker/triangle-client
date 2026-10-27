import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
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
  assert.equal(value.version, 14);
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

test('Claude MCP entry initializes and lists tools from the validated v11 bundle', () => installed((manifest,value) => {
  const appRoot=path.dirname(path.dirname(manifest));
  execFileSync(python,[installer,'install-local-wrapper','--application-root',appRoot]);
  const base=process.platform==='darwin'?'/private/tmp':realpathSync(tmpdir());
  const state=mkdtempSync(path.join(base,'tri-mcp-'));
  chmodSync(state,0o700);
  try {
    const sessionId=randomUUID(),integrationPath=path.join(state,'integration.json'),configPath=path.join(state,'config.json');
    writeFileSync(integrationPath,JSON.stringify({version:1,type:'interactive',senderId:randomBytes(32).toString('hex'),sessionId,generation:1,bindingId:randomUUID(),secret:randomBytes(32).toString('hex'),enabled:true,revoked:false}),{mode:0o600});
    writeFileSync(configPath,JSON.stringify({version:1,enabled:true,stateRoot:state,interactive:{enabled:true,integrationPath}}),{mode:0o600});
    const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{}},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}].map(JSON.stringify).join('\n')+'\n';
    const output=execFileSync(path.join(appRoot,'bin/triangle-local'),['claude-session-mcp','--config',configPath,'--expected-version','2.1.307'],{input,encoding:'utf8',timeout:5000,env:{...value.environment,CLAUDE_CODE_SESSION_ID:sessionId}});
    const responses=output.trim().split('\n').map(JSON.parse);
    assert.equal(responses[0].result.serverInfo.name,'triangle-claude-session-mcp');
    const names=responses[1].result.tools.map(tool=>tool.name);
    for(const name of ['triangle_list_inbox','triangle_get_replies','triangle_consume_reply','triangle_list_recipients'])assert.ok(names.includes(name));
  } finally {rmSync(state,{recursive:true,force:true});}
}));

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
