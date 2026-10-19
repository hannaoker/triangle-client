import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { linuxPaths, readProfile, profilePath, safeFile, safeDirectory } from './paths.mjs';
import { LocalStateError } from '../../triangle-cli/src/errors.mjs';
const fail = message => { throw new LocalStateError(message); };
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 35000);
    child.stdout.on('data', b => { bytes += b.length; if (bytes > 262144) child.kill('SIGKILL'); else stdout += b; });
    child.stderr.on('data', b => { bytes += b.length; if (bytes > 262144) child.kill('SIGKILL'); });
    child.on('error', () => { clearTimeout(timer); reject(new LocalStateError('Unable to contact the user service manager.')); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
  });
}
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
export function renderUnit(config, configPath, xdg = {}) {
  const environment = Object.entries(xdg).map(([key, value]) => {
    if (!['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME'].includes(key) || typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid service environment.');
    return 'Environment=' + quote(key + '=' + value).replaceAll('$$', () => '$') + '\n';
  }).join('');
  for (const value of [config.node, config.releaseRoot, configPath]) if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid service path.');
  return `[Unit]\nDescription=Triangle managed agent\nAfter=network-online.target\n\n[Service]\nType=simple\n${environment}ExecStart=${[config.node, path.join(config.releaseRoot, 'packages/linux-runtime/src/host.mjs'), '--config', configPath].map(quote).join(' ')}\nUMask=0077\nKillMode=control-group\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`;
}
export function createService({ env = process.env, accountHome, run = runCommand, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), readProfileImpl = readProfile, openStoreImpl } = {}) {
  const options = { env, accountHome };
  const cleanEnv = { HOME: accountHome ?? env.HOME, PATH: '/usr/bin:/bin', ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}), ...(env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS } : {}) };
  const call = (args) => run('/usr/bin/systemctl', ['--user', ...args], { env: cleanEnv });
  const unit = profile => `triangle-${profile}.service`;
  async function manager() { if ((await call(['show-environment'])).code !== 0) fail('A working systemd user manager is required. Sign in to a Linux user session and retry.'); }
  async function status({ profile }) {
    const config = readProfileImpl(profile, options);
    if (!config) fail('This Linux service profile is not configured.');
    const result = await call(['show', unit(profile), '--property=ActiveState,MainPID', '--no-pager']);
    const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=')));
    const store = (openStoreImpl ?? (await import('./store.mjs')).openStore)({ root: config.stateRoot, agentId: config.agentId });
    let health, transaction;
    try { health = await store.readHealth(); transaction = await store.status(); } finally { await store.close(); }
    const at = health?.updatedAt;
    const ready = result.code === 0 && fields.ActiveState === 'active' && Number(fields.MainPID) > 0 && health?.pid === Number(fields.MainPID) && health?.ready === true && health?.verified === true && health?.profile === profile && health?.agentId === config.agentId && now() - at >= 0 && now() - at < Math.max(90000, config.pollIntervalMs * 3);
    return { profile, agentId: config.agentId, state: ready ? 'running' : 'needs_attention', active: fields.ActiveState === 'active', verified: ready, transaction };
  }
  const unitFile = profile => path.join(linuxPaths(options).unitsRoot, unit(profile));
  async function install(config) {
    const roots = linuxPaths(options);
    const file = unitFile(config.profile);
    safeDirectory(path.dirname(file), { create: true });
    if (existsSync(file)) safeFile(file);
    const text = renderUnit(config, profilePath(config.profile, options), { XDG_DATA_HOME: path.dirname(roots.dataRoot), XDG_STATE_HOME: path.dirname(path.dirname(roots.stateRoot)), XDG_CONFIG_HOME: path.dirname(path.dirname(roots.unitsRoot)) });
    if (existsSync(file) && readFileSync(file, 'utf8') !== text) fail('An existing service unit has different settings. No service was replaced.');
    writeFileSync(file, text, { mode: 0o600, flag: existsSync(file) ? 'r+' : 'wx' });
    if ((await call(['daemon-reload'])).code) fail('Unable to load the Linux user service.');
  }
  async function start({ profile }) {
    const config = readProfileImpl(profile, options); if (!config) fail('This Linux service profile is not configured.');
    await manager(); await install(config);
    if ((await call(['enable', '--now', unitFile(profile)])).code) fail('Unable to start the Linux user service.');
    for (let i = 0; i < 30; i++) { const result = await status({ profile }); if (result.state === 'running') return result; await sleep(1000); }
    fail('The service did not report verified readiness. Run triangle service doctor --profile ' + profile + '.');
  }
  async function stop({ profile }) { readProfileImpl(profile, options) ?? fail('This Linux service profile is not configured.'); if ((await call(['disable', '--now', unit(profile)])).code) fail('Unable to stop the Linux user service.'); return { profile, state: 'stopped' }; }
  async function logs({ profile, lines = 50 }) {
    readProfileImpl(profile, options) ?? fail('This Linux service profile is not configured.');
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000) fail('Log lines must be between 1 and 1000.');
    // Host output is metadata only. Never expose arbitrary service-manager diagnostics.
    const r = await run('/usr/bin/journalctl', ['--user', '-u', unit(profile), '-n', String(lines), '--no-pager', '-o', 'cat'], { env: cleanEnv });
    if (r.code) fail('Unable to read the user service journal.');
    return { profile, logs: r.stdout.split('\n').filter(line => /^triangle runtime: [a-z_ ]+$/.test(line)).join('\n') };
  }
  async function retry({ profile, delivery, yes }) {
    if (!yes || typeof delivery !== 'string' || !delivery.length) fail('Explicit retry requires --delivery ID --yes. Inspect the service first.');
    const config = readProfileImpl(profile, options); if (!config) fail('This Linux service profile is not configured.');
    const store = (openStoreImpl ?? (await import('./store.mjs')).openStore)({ root: config.stateRoot, agentId: config.agentId });
    try { await store.retry(delivery); } finally { await store.close(); }
    return { profile, agentId: config.agentId, state: 'retry_requested' };
  }
  return { manager, install, start, stop, status, doctor: status, logs, retry };
}
