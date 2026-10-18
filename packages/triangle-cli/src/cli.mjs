#!/usr/bin/env node
// triangle — join a MESH, manage this device's agents and their permissions.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { addAgent, listAgents, resolveAgent, setAgentState } from "./agents.mjs";
import { approveDevice, listDevices, renderDevices, revokeDevice } from "./devices.mjs";
import { createInvite, inviteOutcome, renderInvite, revokeInvite } from "./invites.mjs";
import { parseChanges, permissionHistory, readPermissions, RevisionConflictError, renderHistory, renderPermissions, setPermissions } from "./permissions.mjs";
import { defaultHome } from "./custody.mjs";
import { doctor, renderDoctor, TRUST_COPY } from "./doctor.mjs";
import { LocalStateError, MeshApiError, OutcomeUnknownError } from "./errors.mjs";
import { join, resumeJoin } from "./join.mjs";
import { openCustody } from "./custody.mjs";
import { openSession } from "./session.mjs";

export const USAGE = `Usage: triangle <command> [options]

  join <link> [--name NAME] [--handle HANDLE] [--agent-name NAME] [--device-label LABEL] [--device] [--via URL]
                              Join a MESH with an invite link (creates this device's owner key and, for a
                              first-owner or teammate link, your first agent).
  join --resume               Finish a join whose outcome was unknown (replays the same signed request).
  join --abandon              Forget an unfinished join (keeps this device's owner key).
  agent add --handle HANDLE [--name NAME] [--description TEXT] [--read-only]
  agent list
  agent pause|resume <agent>
  agent delete <agent> --yes  Permanently delete an agent (its key on this device is removed too).
  permissions show [agent]    Current toggles (conditional read; cached ETag).
  permissions set <agent> key=on|off ...
                              Owner-signed change against the revision you saw (conflicts are re-read, never overwritten).
  permissions history [agent] [--limit N]
  invite teammate [--role member|admin] [--name-hint NAME] [--email-hint EMAIL] [--expires SECONDS]
  invite device               A 15-minute link that adds another computer of yours as an owner device.
  invite revoke <invite_id>
  device list
  device approve <fingerprint>
  device revoke <fingerprint> [--yes]
  status | doctor             What this device controls and what needs attention.
  resume [--abandon]          Replay owner operations whose outcome was unknown (or discard them).

Global: --home DIR (default ${defaultHome()}), --json`;

export class UsageError extends Error {}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const booleans = new Set(["json", "resume", "abandon", "device", "read-only", "yes"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith("--")) {
      const [rawName, inline] = arg.slice(2).split(/=(.*)/s, 2);
      if (booleans.has(rawName)) { if (inline !== undefined) throw new UsageError(`--${rawName} takes no value`); flags[rawName] = true; continue; }
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${rawName} needs a value`);
      // `--name --read-only` must not swallow the flag; use --name=--x for such a value.
      if (inline === undefined && value.startsWith("-")) throw new UsageError(`--${rawName} needs a value (got ${value}); use --${rawName}=VALUE`);
      if (Object.hasOwn(flags, rawName)) throw new UsageError(`--${rawName} given twice`);
      flags[rawName] = value;
    } else positional.push(arg);
  }
  return { positional, flags };
}

function allowOnly(flags, allowed) {
  for (const name of Object.keys(flags)) if (!allowed.includes(name) && !["home", "json"].includes(name)) throw new UsageError(`unknown option --${name}`);
}

function print(io, flags, value, human) {
  io.stdout(flags.json ? JSON.stringify(value, null, 2) : human(value));
}

function renderJoin({ outcome, result }) {
  const lines = [];
  if (result.controller.state === "pending_approval") {
    lines.push(`This device was added and is waiting for approval.`);
    lines.push(`On one of your other devices, run:  triangle device approve ${result.controller.fingerprint}`);
    lines.push(`Check that it shows this fingerprint: ${result.controller.fingerprint}`);
  } else {
    lines.push(`Joined ${result.authority} as ${result.owner_role ?? "owner"}${outcome === "replayed" ? " (already applied; replayed)" : ""}.`);
    lines.push(`This device: ${result.controller.device_label} · ${result.controller.fingerprint}`);
    if (result.agent) lines.push(`Your agent: ${result.agent.handle} (${result.agent.agent_id})`);
  }
  lines.push("", ...TRUST_COPY.map((line) => `  ${line}`));
  if (result.controller.state !== "pending_approval") lines.push("", "  Add a backup now: triangle invite device   (run the printed command on your other computer)");
  return lines.join("\n");
}

export async function main(argv, { env = process.env, io = { stdout: (s) => process.stdout.write(`${s}\n`), stderr: (s) => process.stderr.write(`${s}\n`) }, fetchImpl = globalThis.fetch } = {}) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    io.stdout(USAGE);
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.stderr(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { positional, flags } = parsed;
  const home = flags.home ?? defaultHome(env);
  const [command, sub, ...rest] = positional;
  try {
    switch (command) {
      case "join": {
        allowOnly(flags, ["resume", "abandon", "name", "handle", "agent-name", "device-label", "device", "via"]);
        if (flags.abandon && flags.resume) throw new UsageError("use --resume or --abandon, not both");
        if ((flags.abandon || flags.resume) && (sub !== undefined || Object.keys(flags).some((f) => !["abandon", "resume", "home", "json"].includes(f)))) throw new UsageError("join --resume/--abandon take no link or other options");
        if (flags.abandon) {
          const custody = openCustody(home);
          custody.withLock(() => custody.removeJournal("join"));
          io.stdout("Forgot the unfinished join.");
          return 0;
        }
        const outcome = flags.resume
          ? await resumeJoin({ home, env, fetchImpl })
          : await join({
            home, env, fetchImpl,
            link: sub ?? (() => { throw new UsageError("join needs a link"); })(),
            via: flags.via ?? env.TRIANGLE_MESH_TRANSPORT ?? null,
            displayName: flags.name ?? null,
            handle: flags.handle,
            agentName: flags["agent-name"],
            deviceLabel: flags["device-label"],
            device: Boolean(flags.device),
          });
        print(io, flags, outcome, renderJoin);
        return 0;
      }
      case "agent": {
        const session = openSession({ home, env, fetchImpl });
        if (sub === "add") {
          allowOnly(flags, ["handle", "name", "description", "read-only"]);
          if (!flags.handle) throw new UsageError("agent add needs --handle");
          const agent = await addAgent(session, { handle: flags.handle, name: flags.name ?? flags.handle, description: flags.description ?? "", readOnly: Boolean(flags["read-only"]) });
          print(io, flags, agent, (a) => `Created ${a.handle} (${a.agent_id}); its workload key is stored on this device.`);
          return 0;
        }
        if (sub === "list") {
          allowOnly(flags, []);
          const view = await listAgents(session);
          print(io, flags, view.agents, (agents) => agents.map((a) => `${a.handle}\t${a.agent_id}\t${a.state}\trev ${a.revision ?? "?"}${a.on_this_device ? "\t(this device)" : ""}`).join("\n") || "No agents.");
          return 0;
        }
        if (sub === "pause" || sub === "resume" || sub === "delete") {
          allowOnly(flags, sub === "delete" ? ["yes"] : []);
          if (rest.length > 1) throw new UsageError(`agent ${sub} takes one agent`);
          const agents = (await listAgents(session)).agents;
          const agentId = resolveAgent(session, rest[0], agents);
          const handle = agents.find((a) => a.agent_id === agentId)?.handle ?? agentId;
          if (sub === "delete" && !flags.yes) throw new UsageError(`Deleting ${handle} is permanent. Re-run with --yes.`);
          const result = await setAgentState(session, agentId, sub);
          print(io, flags, result, (r) => `${handle} is ${r.state}${r.outcome === "replayed" ? " (already applied)" : ""}.`);
          return 0;
        }
        throw new UsageError(`unknown agent command ${sub ?? ""}`);
      }
      case "permissions": {
        const session = openSession({ home, env, fetchImpl });
        const agents = (await listAgents(session)).agents;
        const handleOf = (id) => agents.find((a) => a.agent_id === id)?.handle ?? id;
        if (sub === "show" || sub === undefined) {
          allowOnly(flags, []);
          if (rest.length > 1) throw new UsageError("permissions show takes one agent");
          const agentId = resolveAgent(session, rest[0], agents);
          const view = await readPermissions(session, agentId);
          print(io, flags, view, (v) => renderPermissions(handleOf(agentId), v));
          return 0;
        }
        if (sub === "set") {
          allowOnly(flags, []);
          const [ref, ...changeArgs] = rest;
          if (!ref || !changeArgs.length) throw new UsageError("permissions set <agent> key=on|off ...");
          const agentId = resolveAgent(session, ref, agents);
          const changes = parseChanges(changeArgs);
          try {
            const view = await setPermissions(session, agentId, changes);
            print(io, flags, view, (v) => renderPermissions(handleOf(agentId), v));
            return 0;
          } catch (error) {
            if (!(error instanceof RevisionConflictError)) throw error;
            if (flags.json) io.stderr(JSON.stringify(error.toJSON()));
            else io.stderr(`${error.message}\n\nLatest:\n${renderPermissions(handleOf(agentId), error.latest)}`);
            return 4;
          }
        }
        if (sub === "history") {
          allowOnly(flags, ["limit"]);
          if (rest.length > 1) throw new UsageError("permissions history takes one agent");
          const agentId = resolveAgent(session, rest[0], agents);
          if (flags.limit !== undefined && !/^\d{1,3}$/.test(flags.limit)) throw new UsageError("--limit must be 1-200");
          const history = await permissionHistory(session, agentId, { limit: flags.limit === undefined ? undefined : Number(flags.limit) });
          print(io, flags, history, (h) => renderHistory(handleOf(agentId), h));
          return 0;
        }
        throw new UsageError(`unknown permissions command ${sub}`);
      }
      case "invite": {
        const session = openSession({ home, env, fetchImpl });
        if (sub === "teammate" || sub === "device") {
          allowOnly(flags, sub === "teammate" ? ["role", "name-hint", "email-hint", "expires"] : []);
          if (rest.length) throw new UsageError(`invite ${sub} takes no arguments`);
          if (flags.expires !== undefined && !/^\d{1,7}$/.test(flags.expires)) throw new UsageError("--expires is a number of seconds");
          await createInvite(session, {
            kind: sub,
            role: sub === "teammate" ? flags.role ?? "member" : null,
            displayNameHint: flags["name-hint"] ?? null,
            emailHint: flags["email-hint"] ?? null,
            expiresInSeconds: flags.expires === undefined ? null : Number(flags.expires),
          }, { deliver: (outcome) => print(io, flags, outcome, renderInvite) });
          return 0;
        }
        if (sub === "revoke") {
          allowOnly(flags, []);
          if (rest.length !== 1) throw new UsageError("invite revoke <invite_id>");
          const result = await revokeInvite(session, rest[0]);
          print(io, flags, result, (r) => `Revoked ${r.invite_id ?? rest[0]}.`);
          return 0;
        }
        throw new UsageError(`unknown invite command ${sub ?? ""}`);
      }
      case "device": {
        const session = openSession({ home, env, fetchImpl });
        if (sub === "list") {
          allowOnly(flags, []);
          const devices = await listDevices(session);
          print(io, flags, devices, renderDevices);
          return 0;
        }
        if (sub === "approve" || sub === "revoke") {
          allowOnly(flags, sub === "revoke" ? ["yes"] : []);
          if (rest.length !== 1) throw new UsageError(`device ${sub} <fingerprint>`);
          const result = sub === "approve" ? await approveDevice(session, rest[0]) : await revokeDevice(session, rest[0], { allowSelf: Boolean(flags.yes) });
          print(io, flags, result, (r) => `${r.device_label ?? "Device"} (${r.fingerprint}) is ${r.state}.`);
          return 0;
        }
        throw new UsageError(`unknown device command ${sub ?? ""}`);
      }
      case "status":
      case "doctor": {
        allowOnly(flags, []);
        const session = openSession({ home, env, fetchImpl, requireJoined: false });
        const report = await doctor(session);
        print(io, flags, report, renderDoctor);
        return report.warnings.length && command === "doctor" ? 1 : 0;
      }
      case "resume": {
        allowOnly(flags, ["abandon"]);
        const session = openSession({ home, env, fetchImpl });
        if (flags.abandon) {
          const dropped = session.custody.withLock(() => {
            const pending = session.custody.listJournal().filter((name) => name !== "join");
            for (const name of pending) session.custody.removeJournal(name);
            return pending;
          });
          print(io, flags, dropped, (items) => (items.length ? `Discarded ${items.length} unfinished request(s). If one had been applied, its effect stays on the server (an agent created that way has no key here).` : "Nothing to discard."));
          return 0;
        }
        return await session.custody.withLock(async () => {
        const names = session.custody.listJournal().filter((name) => name.startsWith("op-") || name.startsWith("perm-"));
        const done = [];
        const conflicts = [];
        // Each result is printed as soon as it is known (an invite link before its
        // journal is removed), so a later failure cannot swallow earlier output.
        const emit = (item) => {
          done.push(item);
          if (flags.json) io.stdout(JSON.stringify(item));
          else io.stdout(`${item.operation} ${item.target ?? ""} → ${item.outcome}${item.invite ? `\n  link: ${item.invite.link}` : ""}${item.latest ? `\n  not applied: someone changed it first (now revision ${item.latest.revision}); re-run \`triangle permissions set\` if still wanted` : ""}`);
        };
        for (const name of names) {
          const pending = session.custody.readJournal(name);
          const isInvite = pending?.operation === "invite.create" && Boolean(pending.invite_secret);
          let replayed;
          try {
            replayed = await session.replayOperation(name, { retain: isInvite });
          } catch (error) {
            // Receipts are checked before the revision, so a replayed update that
            // gets revision_conflict never committed: retire it and report the latest state.
            if (pending?.kind === "permissions-update" && error instanceof MeshApiError && error.code === "revision_conflict") {
              session.custody.removeJournal(name);
              const latest = await readPermissions(session, pending.agent_id, { fresh: true });
              const { from_cache, ...view } = latest;
              conflicts.push(name);
              emit({ operation: pending.kind, target: pending.agent_id, outcome: "revision_conflict", latest: view });
              continue;
            }
            throw error;
          }
          const { entry, result } = replayed;
          const item = { operation: entry.operation ?? entry.kind, target: entry.target ?? entry.agent_id ?? null, outcome: result?.outcome };
          if (isInvite) item.invite = inviteOutcome(session, result, entry.invite_secret).invite;
          emit(item);
          if (isInvite) session.custody.removeJournal(name);
        }
        if (!done.length) print(io, flags, [], () => "Nothing to resume.");
        return conflicts.length ? 4 : 0;
        });
      }
      case undefined:
        io.stdout(USAGE);
        return 2;
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error?.code === "challenge_mismatch") {
      io.stderr(error.message);
      return 1;
    }
    if (error instanceof UsageError || error instanceof TypeError && !(error instanceof MeshApiError)) {
      io.stderr(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : error.message);
      return 2;
    }
    if (error instanceof OutcomeUnknownError) {
      io.stderr(error.message + (error.resumeHint && !error.message.includes(error.resumeHint) ? ` Run \`${error.resumeHint}\`.` : ""));
      return 3;
    }
    if (error instanceof MeshApiError || error instanceof LocalStateError) {
      io.stderr(flags.json ? JSON.stringify(error.toJSON?.() ?? { error: error.name, message: error.message }) : error.message);
      return 1;
    }
    throw error;
  }
}

function invokedDirectly() {
  // npm installs `triangle` as a symlink; compare real paths.
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || "")).href; } catch { return false; }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
