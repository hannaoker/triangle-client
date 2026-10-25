#!/usr/bin/env node
// triangle — join a MESH, manage this device's agents and their permissions.
import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { addAgent, listAgents, resolveAgent, setAgentState } from "./agents.mjs";
import { approveDevice, listDevices, renderDevices, revokeDevice } from "./devices.mjs";
import { identityInventory, renderIdentityInventory } from "./identity-inventory.mjs";
import {
  identityMigrate,
  renderIdentityMigrateApply,
  renderIdentityMigratePartial,
  renderIdentityMigratePlan,
} from "./identity-migrate.mjs";
import { createInvite, inviteOutcome, renderInvite, revokeInvite } from "./invites.mjs";
import { parseChanges, permissionHistory, readPermissions, rereadAfterConflict, RevisionConflictError, renderHistory, renderPermissions, setPermissions } from "./permissions.mjs";
import { defaultHome } from "./custody.mjs";
import { doctor, renderDoctor, TRUST_COPY } from "./doctor.mjs";
import { LocalStateError, MeshApiError, OutcomeUnknownError } from "./errors.mjs";
import { join, resumeJoin } from "./join.mjs";
import { openCustody } from "./custody.mjs";
import { openSession } from "./session.mjs";
import { setup, renderSetup } from "./setup.mjs";

export const USAGE = `Usage: triangle <command> [options]

  setup [--harness codex|hermes|antigravity|cursor] [--profile NAME] [--invite-file FILE]
        [--identity-only] [--resume] [--name NAME] [--agent-name NAME] [--workdir DIR]
                              Guided enrollment and background service setup. Invitation input stays private.
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
  identity inventory --client-root DIR
                              Read-only projection of local identity bindings observed on disk.
  identity migrate --client-root DIR --registry-root DIR [--confirm PLAN_ID]
                              Propose or apply owner-confirmed identity mapping records.
  status | doctor             What this device controls and what needs attention.
  resume [--abandon]          Replay owner operations whose outcome was unknown (or discard them).

Linux: setup defaults to identity enrollment; --harness codex installs a managed user service.
  service start|stop|status|doctor|logs|retry --profile NAME [--lines N] [--delivery ID --yes]

Global: --home DIR (default ${defaultHome()}), --json`;

export class UsageError extends Error {}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const booleans = new Set(["json", "resume", "abandon", "device", "read-only", "yes", "identity-only"]);
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

/** Resolves once the text is written (an invite secret's journal is removed only after). */
function print(io, flags, value, human) {
  return io.stdout(flags.json ? JSON.stringify(value, null, 2) : human(value));
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

/** Streams that already have a standing error listener (see writeLine). */
const GUARDED = new WeakSet();

/**
 * Write a line and settle when the stream has accepted it (rejects on e.g. EPIPE).
 * On EPIPE Node calls the write callback first and emits `error` afterwards, so a
 * standing no-op listener keeps that later event from crashing the process; the
 * failure itself is reported through the callback.
 */
export function writeLine(stream, text) {
  if (!GUARDED.has(stream)) {
    stream.on("error", () => {});
    GUARDED.add(stream);
  }
  return new Promise((resolve, reject) => {
    stream.write(`${text}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

/** An invite link that could not be written keeps its journal; say how to get it back. */
async function keepIfUnwritten(written) {
  try {
    await written;
  } catch (error) {
    throw new OutcomeUnknownError("The result could not be written to stdout; nothing was lost. Run `triangle resume` to print it again.", { cause: error, resumeHint: "triangle resume" });
  }
}

const PROCESS_IO = { stdout: (s) => writeLine(process.stdout, s), stderr: (s) => { process.stderr.write(`${s}\n`); } };

export async function main(argv, { env = process.env, io = PROCESS_IO, fetchImpl = globalThis.fetch, setupDependencies = {}, serviceDependencies = {}, identityDependencies = {} } = {}) {
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
      case "setup": {
        allowOnly(flags, ["harness", "profile", "invite-file", "identity-only", "resume", "name", "agent-name", "workdir"]);
        if (sub !== undefined) throw new UsageError("setup takes no positional arguments; use hidden invitation input or --invite-file FILE");
        const result = await setup({
          home, harness: flags.harness, profile: flags.profile, inviteFile: flags["invite-file"],
          identityOnly: flags["identity-only"], resume: flags.resume, name: flags.name,
          agentName: flags["agent-name"], workdir: flags.workdir,
        }, { ...setupDependencies, env, fetchImpl });
        await print(io, flags, result, renderSetup);
        return 0;
      }
      case "service": {
        allowOnly(flags, ["profile", "lines", "delivery", "yes"]);
        if (rest.length || !["start", "stop", "status", "doctor", "logs", "retry"].includes(sub)) throw new UsageError("service needs start, stop, status, doctor, logs or retry");
        if (!/^[a-z][a-z0-9_-]{2,31}$/.test(flags.profile ?? "")) throw new UsageError("service needs --profile NAME");
        if (sub !== "logs" && flags.lines !== undefined || sub !== "retry" && (flags.delivery !== undefined || flags.yes)) throw new UsageError("option does not apply to this service command");
        if (flags.lines !== undefined && !/^\d{1,4}$/.test(flags.lines)) throw new UsageError("--lines must be 1-1000");
        const service = serviceDependencies.service ?? (await import('../../linux-runtime/src/service.mjs')).createService({ env, ...serviceDependencies });
        const result = await service[sub]({ profile: flags.profile, delivery: flags.delivery, yes: flags.yes, ...(flags.lines ? { lines: Number(flags.lines) } : {}) });
        await print(io, flags, result, value => value.logs ?? `Service ${value.profile}: ${value.state}`);
        return sub === "doctor" && result.state !== "running" ? 1 : 0;
      }
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
        await print(io, flags, outcome, renderJoin);
        return 0;
      }
      case "agent": {
        const session = openSession({ home, env, fetchImpl });
        if (sub === "add") {
          allowOnly(flags, ["handle", "name", "description", "read-only"]);
          if (!flags.handle) throw new UsageError("agent add needs --handle");
          const agent = await addAgent(session, { handle: flags.handle, name: flags.name ?? flags.handle, description: flags.description ?? "", readOnly: Boolean(flags["read-only"]) });
          await print(io, flags, agent, (a) => `Created ${a.handle} (${a.agent_id}); its workload key is stored on this device.`);
          return 0;
        }
        if (sub === "list") {
          allowOnly(flags, []);
          const view = await listAgents(session);
          await print(io, flags, view.agents, (agents) => agents.map((a) => `${a.handle}\t${a.agent_id}\t${a.state}\trev ${a.revision ?? "?"}${a.on_this_device ? "\t(this device)" : ""}`).join("\n") || "No agents.");
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
          await print(io, flags, result, (r) => `${handle} is ${r.state}${r.outcome === "replayed" ? " (already applied)" : ""}.`);
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
          await print(io, flags, view, (v) => renderPermissions(handleOf(agentId), v));
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
            await print(io, flags, view, (v) => renderPermissions(handleOf(agentId), v));
            return 0;
          } catch (error) {
            if (!(error instanceof RevisionConflictError)) throw error;
            if (flags.json) io.stderr(JSON.stringify(error.toJSON()));
            else if (error.latest) io.stderr(`${error.message}\n\nLatest:\n${renderPermissions(handleOf(agentId), error.latest)}`);
            else io.stderr(`${error.message}\n\nNot applied: someone changed it first. Could not read the latest state (${error.refreshError}); run \`triangle permissions show\`.`);
            return 4;
          }
        }
        if (sub === "history") {
          allowOnly(flags, ["limit"]);
          if (rest.length > 1) throw new UsageError("permissions history takes one agent");
          const agentId = resolveAgent(session, rest[0], agents);
          if (flags.limit !== undefined && !/^\d{1,3}$/.test(flags.limit)) throw new UsageError("--limit must be 1-200");
          const history = await permissionHistory(session, agentId, { limit: flags.limit === undefined ? undefined : Number(flags.limit) });
          await print(io, flags, history, (h) => renderHistory(handleOf(agentId), h));
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
          }, { deliver: (outcome) => keepIfUnwritten(print(io, flags, outcome, renderInvite)) });
          return 0;
        }
        if (sub === "revoke") {
          allowOnly(flags, []);
          if (rest.length !== 1) throw new UsageError("invite revoke <invite_id>");
          const result = await revokeInvite(session, rest[0]);
          await print(io, flags, result, (r) => `Revoked ${r.invite_id ?? rest[0]}.`);
          return 0;
        }
        throw new UsageError(`unknown invite command ${sub ?? ""}`);
      }
      case "device": {
        const session = openSession({ home, env, fetchImpl });
        if (sub === "list") {
          allowOnly(flags, []);
          const devices = await listDevices(session);
          await print(io, flags, devices, renderDevices);
          return 0;
        }
        if (sub === "approve" || sub === "revoke") {
          allowOnly(flags, sub === "revoke" ? ["yes"] : []);
          if (rest.length !== 1) throw new UsageError(`device ${sub} <fingerprint>`);
          const result = sub === "approve" ? await approveDevice(session, rest[0]) : await revokeDevice(session, rest[0], { allowSelf: Boolean(flags.yes) });
          await print(io, flags, result, (r) => `${r.device_label ?? "Device"} (${r.fingerprint}) is ${r.state}.`);
          return 0;
        }
        throw new UsageError(`unknown device command ${sub ?? ""}`);
      }
      case "identity": {
        if (sub === "inventory") {
          if (rest.length) throw new UsageError("identity inventory takes no positional arguments");
          allowOnly(flags, ["client-root"]);
          const clientRoot = flags["client-root"];
          if (!clientRoot) throw new UsageError("identity inventory requires --client-root ABSOLUTE_PATH");
          if (typeof clientRoot !== "string" || !isAbsolute(clientRoot)) throw new UsageError("--client-root must be an absolute path");
          const report = await identityInventory({ clientRoot, ...identityDependencies });
          await print(io, flags, report, renderIdentityInventory);
          return 0;
        }
        if (sub === "migrate") {
          if (rest.length) throw new UsageError("identity migrate takes no positional arguments");
          allowOnly(flags, ["client-root", "registry-root", "confirm"]);
          const clientRoot = flags["client-root"];
          const registryRoot = flags["registry-root"];
          if (!clientRoot) throw new UsageError("identity migrate requires --client-root ABSOLUTE_PATH");
          if (!registryRoot) throw new UsageError("identity migrate requires --registry-root ABSOLUTE_PATH");
          if (typeof clientRoot !== "string" || !isAbsolute(clientRoot)) throw new UsageError("--client-root must be an absolute path");
          if (typeof registryRoot !== "string" || !isAbsolute(registryRoot)) throw new UsageError("--registry-root must be an absolute path");

          const normClient = resolve(clientRoot);
          const normRegistry = resolve(registryRoot);
          if (normRegistry === normClient) {
            throw new UsageError("registry root must not equal client root");
          }
          if (normClient.startsWith(normRegistry + sep)) {
            throw new UsageError("registry root must not contain client root");
          }
          if (normRegistry.startsWith(normClient + sep)) {
            throw new UsageError("registry root must not be inside client root");
          }

          if (flags.confirm !== undefined) {
            const confirm = flags.confirm;
            if (typeof confirm !== "string" || !/^[a-f0-9]{64}$/.test(confirm)) {
              throw new UsageError("--confirm must be 64 lowercase hex characters");
            }

            const isTerm =
              identityDependencies.isTerminal !== undefined
                ? (typeof identityDependencies.isTerminal === "function"
                    ? identityDependencies.isTerminal()
                    : Boolean(identityDependencies.isTerminal))
                : Boolean(
                    (identityDependencies.stdinIsTTY ?? io?.stdin?.isTTY ?? process.stdin?.isTTY) &&
                    (identityDependencies.stdoutIsTTY ?? io?.stdout?.isTTY ?? process.stdout?.isTTY)
                  );

            if (!isTerm) {
              io.stderr("identity migrate --confirm requires standard input and output to be a terminal");
              return 2;
            }

            try {
              const result = await identityMigrate({
                clientRoot,
                registryRoot,
                confirm,
                ...identityDependencies,
              });
              await print(io, flags, result, renderIdentityMigrateApply);
              return 0;
            } catch (err) {
              if (err.code === "plan_stale" || err.code === "confirmation_mismatch") {
                io.stderr(`identity migrate failed: ${err.message ?? err.code}`);
                return 2;
              }
              if (err.applied !== undefined) {
                await print(
                  io,
                  flags,
                  {
                    applied: err.applied,
                    failed: err.failed,
                    remaining: err.remaining,
                  },
                  renderIdentityMigratePartial
                );
                return 1;
              }
              throw err;
            }
          }

          const plan = await identityMigrate({
            clientRoot,
            registryRoot,
            confirm: null,
            ...identityDependencies,
          });
          await print(io, flags, plan, (p) => renderIdentityMigratePlan(p, { clientRoot, registryRoot }));
          return 0;
        }
        throw new UsageError(`unknown identity command ${sub ?? ""}`);
      }
      case "status":
      case "doctor": {
        allowOnly(flags, []);
        const session = openSession({ home, env, fetchImpl, requireJoined: false });
        const report = await doctor(session);
        await print(io, flags, report, renderDoctor);
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
          await print(io, flags, dropped, (items) => (items.length ? `Discarded ${items.length} unfinished request(s). If one had been applied, its effect stays on the server (an agent created that way has no key here).` : "Nothing to discard."));
          return 0;
        }
        return await session.custody.withLock(async () => {
        const names = session.custody.listJournal().filter((name) => name.startsWith("op-") || name.startsWith("perm-"));
        const done = [];
        const conflicts = [];
        // Each result is printed as soon as it is known (an invite link before its
        // journal is removed), so a later failure cannot swallow earlier output.
        const emit = async (item) => {
          done.push(item);
          const conflictNote = item.outcome !== "revision_conflict" ? ""
            : item.latest ? `\n  not applied: someone changed it first (now revision ${item.latest.revision}); re-run \`triangle permissions set\` if still wanted`
              : `\n  not applied: someone changed it first; could not read the latest state (${item.refresh_error}); run \`triangle permissions show\``;
          const text = flags.json ? JSON.stringify(item) : (`${item.operation} ${item.target ?? ""} → ${item.outcome}${item.invite ? `\n  link: ${item.invite.link}` : ""}${conflictNote}`);
          const written = io.stdout(text);
          // Only an invite's journal is still held (it is the sole copy of the link).
          await (item.invite ? keepIfUnwritten(written) : written);
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
              conflicts.push(name);
              const { latest, refreshError } = await rereadAfterConflict(session, pending.agent_id);
              await emit({ operation: pending.kind, target: pending.agent_id, outcome: "revision_conflict", latest, ...(refreshError ? { refresh_error: refreshError } : {}) });
              continue;
            }
            throw error;
          }
          const { entry, result } = replayed;
          const item = { operation: entry.operation ?? entry.kind, target: entry.target ?? entry.agent_id ?? null, outcome: result?.outcome };
          if (isInvite) item.invite = inviteOutcome(session, result, entry.invite_secret).invite;
          await emit(item);
          if (isInvite) session.custody.removeJournal(name);
        }
        if (!done.length) await print(io, flags, [], () => "Nothing to resume.");
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
