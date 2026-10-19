import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSync, constants, copyFileSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { LocalStateError } from './errors.mjs';
import { openCustody } from './custody.mjs';
import { linuxPaths, readProfile, writeProfile, safeDirectory, safeFile } from '../../linux-runtime/src/paths.mjs';
import { createLinuxRunner } from '../../linux-runtime/src/runner.mjs';
import { createService } from '../../linux-runtime/src/service.mjs';
const fail = message => { throw new LocalStateError(message); };
function regular(file, privateMode = false) {
  let actual, s;
  try { actual = realpathSync(file); s = lstatSync(actual); } catch { fail('Required private runtime file is missing or unreadable.'); }
  if (!s.isFile() || s.mode & 0o022 || ![0, process.getuid()].includes(s.uid) || (privateMode && (actual !== file || s.mode & 0o077 || s.uid !== process.getuid()))) fail('Required file is unsafe; use private files owned by this user.');
  return actual;
}
function executable(candidates) {
  for (const file of candidates) try { const actual = regular(file); accessSync(actual, constants.X_OK); return actual; } catch {}
  fail('Required native executable is missing or unsafe. Install Codex and bubblewrap before setup.');
}
export function resolveNativeCodex(command, arch = process.arch) {
  if (readFileSync(command).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return command;
  const root = path.dirname(path.dirname(command));
  let metadata;
  try { metadata = JSON.parse(readFileSync(regular(path.join(root, 'package.json')), 'utf8')); } catch { fail('Codex must be an official native Linux installation.'); }
  if (metadata.name !== '@openai/codex' || path.basename(command) !== 'codex.js' || path.basename(path.dirname(command)) !== 'bin') fail('Unsupported Codex launcher. Install the official Codex CLI.');
  const triple = { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' }[arch];
  if (!triple) fail('Unsupported native Codex architecture.');
  const platform = 'codex-linux-' + arch;
  const candidates = [path.join(root, 'vendor', triple), path.join(root, 'node_modules/@openai', platform, 'vendor', triple), path.join(path.dirname(root), platform, 'vendor', triple)].flatMap(vendor => ['bin/codex', 'codex/codex'].map(binary => path.join(vendor, binary)));
  const native = executable(candidates);
  if (!readFileSync(native).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail('Codex native executable is invalid.');
  return native;
}
export function createSetupRuntime({ env = process.env, platform = process.platform, accountHome = os.homedir(), releaseRoot = fileURLToPath(new URL('../../../', import.meta.url)), run, runnerFactory = createLinuxRunner, service = createService({ env, accountHome, run }) } = {}) {
  const options = { env, accountHome }, roots = linuxPaths(options);
  function choices({ profile, harness, home, workdir, workdirExplicit }) {
    if (platform !== 'linux' || harness !== 'codex') fail('Linux managed runtime currently supports Codex only.');
    const current = readProfile(profile, options);
    if (current && (current.identityHome !== path.resolve(home) || current.harness !== harness)) fail('This profile is bound to another identity or harness. Choose a new profile.');
    if (current) regular(path.join(current.identityHome, 'agents', current.agentId, 'workload-key.json'), true);
    const command = resolveNativeCodex(executable([env.CODEX_CLI, ...(env.PATH ?? '/usr/bin:/bin').split(':').filter(p => path.isAbsolute(p)).map(p => path.join(p, 'codex'))].filter(Boolean)));
    if (!readFileSync(command).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail('Codex must be an installed native Linux executable.');
    const bwrap = executable(['/usr/bin/bwrap', ...(env.PATH ?? '').split(':').filter(p => path.isAbsolute(p)).map(p => path.join(p, 'bwrap'))]);
    const node = executable([path.join(releaseRoot, 'bin/node')]);
    workdir = workdirExplicit ? path.resolve(workdir) : current?.workdir ?? path.join(roots.workspacesRoot, profile);
    if (current && (current.command !== command || current.workdir !== workdir)) fail('Existing profile settings differ. Reuse its executable and working directory.');
    if (existsSync(workdir) && (realpathSync(workdir) !== workdir || !lstatSync(workdir).isDirectory())) fail('Working directory must be a canonical directory.');
    const modelHome = current?.modelHome ?? path.join(roots.modelsRoot, profile);
    const auth = existsSync(path.join(modelHome, 'auth.json')) ? path.join(modelHome, 'auth.json') : path.join(accountHome, '.codex/auth.json');
    if (!existsSync(auth)) fail('Sign in with codex login before running Linux setup.');
    regular(auth, true);
    return { current, command, bwrap, node, workdir, modelHome, auth };
  }
  async function preflight(input) {
    const checked = choices(input);
    await service.manager();
    // Probe uses an ephemeral sandbox and must not enroll or create profile state.
    await runnerFactory({ schema: 1, profile: input.profile, agentId: checked.current?.agentId ?? 'agent_' + '0'.repeat(32), identityHome: path.resolve(input.home), authority: checked.current?.authority ?? 'https://preflight.invalid', via: null, harness: 'codex', command: checked.command, bwrap: checked.bwrap, node: checked.node, releaseRoot: path.resolve(releaseRoot), workdir: checked.workdir, modelHome: checked.modelHome, stateRoot: checked.current?.stateRoot ?? path.join(roots.stateRoot, 'agents', 'agent_' + '0'.repeat(32)), pollIntervalMs: 30000, runnerTimeoutMs: 600000 }).probe();
    return { state: 'ready', platform: 'linux', harness: 'codex', workdir: checked.workdir, agentId: checked.current?.agentId };
  }
  async function configure(input) {
    const checked = choices({ ...input, workdirExplicit: true });
    const agentId = input.agent.agent_id;
    if (checked.current && checked.current.agentId !== agentId) fail('Profile already belongs to another agent. No binding was changed.');
    const key = path.join(path.resolve(input.home), 'agents', agentId, 'workload-key.json');
    if (path.resolve(input.keyFile) !== key) fail('Unexpected workload key location.');
    regular(key, true);
    for (const root of [roots.dataRoot, roots.stateRoot, roots.profilesRoot, roots.modelsRoot, roots.workspacesRoot, roots.unitsRoot, checked.modelHome, checked.workdir]) safeDirectory(root, { create: true, privateMode: root !== checked.workdir || root.startsWith(roots.workspacesRoot + path.sep) });
    const target = path.join(checked.modelHome, 'auth.json');
    if (!existsSync(target)) copyFileSync(checked.auth, target, constants.COPYFILE_EXCL);
    const authority = openCustody(input.home).readAuthority();
    const config = { schema: 1, profile: input.profile, agentId, identityHome: path.resolve(input.home), authority: authority.authority, via: authority.via ?? null, harness: 'codex', command: checked.command, bwrap: checked.bwrap, node: checked.node, releaseRoot: path.resolve(releaseRoot), workdir: checked.workdir, modelHome: checked.modelHome, stateRoot: path.join(roots.stateRoot, 'agents', agentId), pollIntervalMs: 30000, runnerTimeoutMs: 600000 };
    await runnerFactory(config).probe();
    writeProfile(config, options);
    const result = await service.start({ profile: input.profile });
    return { ...result, harness: 'codex', next_action: 'Your agent is ready to receive messages.' };
  }
  return { preflight, configure, status: service.status };
}
