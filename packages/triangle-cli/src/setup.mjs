// Guided onboarding composes existing journaled owner APIs with the local service adapter.
import os from 'node:os';
import path from 'node:path';
import { addAgent } from './agents.mjs';
import { defaultHome, openCustody } from './custody.mjs';
import { LocalStateError, OutcomeUnknownError } from './errors.mjs';
import { defaultHandle, join, resumeJoin } from './join.mjs';
import { openSession } from './session.mjs';
import { createSetupPrompts, readPrivateInvite } from './setup-prompts.mjs';

const HARNESSES = new Set(['codex', 'hermes', 'antigravity', 'cursor']);
const PROFILE = /^[a-z][a-z0-9_-]{2,31}$/;
const JOURNAL = 'setup';

function redactError(error, invite) {
  if (!invite) return error;
  const fragments = [invite, invite.split('#')[1], invite.split('.').at(-1)].filter((s) => s?.length >= 8);
  for (const secret of fragments) {
    for (const field of ['message', 'code', 'permission', 'path', 'resumeHint']) {
      if (typeof error[field] === 'string') error[field] = error[field].split(secret).join('[redacted]');
    }
  }
  return error;
}

/** options contain paths and public choices only. Dependencies support fake authorities and isolated runtime tests. */
export async function setup(options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const home = path.resolve(options.home ?? defaultHome(env, platform));
  // A separate setup lock composes with join/owner operations' own custody lock.
  // SQLite releases this lock on process exit, so interrupted setup is resumable.
  return openCustody(path.join(home, '.setup-lock')).withLock(async () => {
    const custody = openCustody(home);
    const pending = custody.readJournal(JOURNAL);
    const prompts = dependencies.prompts ?? createSetupPrompts();
    const identityOnly = options.identityOnly ?? pending?.identityOnly ?? false;
    const profile = options.profile ?? pending?.profile ?? (identityOnly ? 'identity' : await prompts.ask('Profile name', 'my-agent'));
    const harness = options.harness ?? pending?.harness ?? (identityOnly ? null : await prompts.ask('Harness (codex, hermes, antigravity, cursor)', 'codex'));
    if (!PROFILE.test(profile)) throw new LocalStateError('Profile must be 3–32 lowercase letters, digits, underscores or hyphens, starting with a letter.');
    if (harness !== null && !HARNESSES.has(harness)) throw new LocalStateError('Choose codex, hermes, antigravity or cursor.');
    const handle = defaultHandle(profile);
    let workdir = path.resolve(options.workdir ?? pending?.workdir ?? process.cwd());
    const choice = { profile, harness, workdir, home, identityOnly };
    if (pending && ['profile', 'harness', 'workdir', 'identityOnly'].some((field) => pending[field] !== choice[field])) {
      throw new LocalStateError('An unfinished setup has different choices. Run `triangle setup --resume` with the same --home.');
    }
    const previous = custody.readCache('setup', profile);
    if (previous && previous.harness !== harness && !identityOnly) throw new LocalStateError('This profile already has a different harness; choose a different profile.');
    let runtime;
    if (!identityOnly) {
      if (platform !== 'darwin') throw new LocalStateError('Background service setup currently supports macOS. Use --identity-only on this platform.');
      runtime = dependencies.runtime ?? (await import('./setup-runtime.mjs')).createSetupRuntime({ env, platform, accountHome: dependencies.accountHome ?? os.homedir(), releaseRoot: dependencies.releaseRoot, run: dependencies.run });
      const workdirExplicit = Boolean(options.workdir ?? pending?.workdir);
      const ready = await runtime.preflight({ ...choice, workdirExplicit });
      if (!workdirExplicit && ready?.workdir) {
        workdir = path.resolve(ready.workdir);
        choice.workdir = workdir;
      }
    }
    custody.withLock(() => custody.writeJournal(JOURNAL, { ...choice, ...(pending?.agentId ? { agentId: pending.agentId } : {}) }));
    const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
    let invite;
    try {
      if (custody.readJournal('join')) {
        invite = custody.readJournal('join').invite_secret;
        await resumeJoin({ home, env, fetchImpl });
      }
      else if (!custody.readController()) {
        if (options.resume) throw new LocalStateError('No saved join request to resume. Run setup with an invitation.');
        invite = options.inviteFile ? readPrivateInvite(options.inviteFile) : await prompts.invite();
        await join({ home, env, fetchImpl, link: invite, displayName: options.name, handle, agentName: options.agentName ?? profile });
      }
      const session = openSession({ home, env, fetchImpl });
      if (await session.refreshController() !== 'active') {
        return { state: 'pending_approval', joined: true, profile, next_action: `On an approved device run: triangle device approve ${session.owner.fingerprint}. Then run triangle setup --resume.` };
      }
      if (identityOnly) {
        custody.withLock(() => custody.removeJournal(JOURNAL));
        return { state: 'joined', joined: true, authority: custody.readAuthority().authority, profile, agent: custody.listAgents()[0] ?? null, next_action: 'Identity is ready. Background service was not configured.' };
      }
      // Only replay an agent creation for this setup's handle. Never replace an
      // unknown operation with fresh keys after a lost response.
      const unfinished = custody.listJournal().filter((name) => name.startsWith('op-')).map((name) => ({ name, entry: custody.readJournal(name) }));
      for (const { name, entry } of unfinished) {
        if (entry.operation === 'agent.create' && entry.body?.params?.handle === handle) await custody.withLock(() => session.replayOperation(name));
        else if (entry.operation === 'agent.create') throw new LocalStateError('Another agent creation is unfinished. Run `triangle resume` before setup.');
      }
      let local = custody.listAgents();
      const boundId = pending?.agentId ?? previous?.agentId;
      let agent = boundId ? local.find((a) => a.agent_id === boundId) : local.find((a) => a.handle === handle);
      if (boundId && !agent) throw new LocalStateError('The saved setup identity is missing locally; run `triangle doctor`. No replacement was created.');
      if (!agent) {
        await addAgent(session, { handle, name: options.agentName ?? profile });
        agent = custody.listAgents().find((a) => a.handle === handle);
      }
      if (!agent || !custody.readWorkloadKey(agent.agent_id)) throw new LocalStateError('The agent workload key is missing. No replacement identity was created.');
      custody.withLock(() => custody.writeJournal(JOURNAL, { ...choice, agentId: agent.agent_id }));
      const result = await runtime.configure({ ...choice, agent, keyFile: custody.workloadKeyPath(agent.agent_id) });
      const report = { ...result, joined: true, profile, harness, agent: { agent_id: agent.agent_id, handle: agent.handle, name: agent.name } };
      if (result.state !== 'running') return report;
      custody.withLock(() => { custody.writeCache('setup', profile, { ...choice, agentId: agent.agent_id }); custody.removeJournal(JOURNAL); });
      return report;
    } catch (error) {
      if (error instanceof OutcomeUnknownError) {
        error.message = 'Setup outcome is unknown; the same keys and request are saved. Run `triangle setup --resume` with the same --home.';
        error.resumeHint = 'triangle setup --resume';
      }
      throw redactError(error, invite);
    }
  });
}

export function renderSetup(result) {
  return [
    `Setup: ${result.state}`,
    ...(result.agent ? [`Agent: ${result.agent.handle} (${result.agent.agent_id})`] : []),
    ...(result.harness ? [`Profile: ${result.profile} · ${result.harness}`] : []),
    ...(result.next_action ? [result.next_action] : []),
  ].join('\n');
}
