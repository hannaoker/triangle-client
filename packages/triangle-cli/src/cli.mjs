#!/usr/bin/env node
// triangle — join a MESH, manage this device's agents and their permissions.
import { pathToFileURL } from "node:url";

import { addAgent, listAgents } from "./agents.mjs";
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
  status | doctor             What this device controls and what needs attention.
  resume                      Replay owner operations whose outcome was unknown.

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
        if (flags.abandon) {
          openCustody(home).removeJournal("join");
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
        throw new UsageError(`unknown agent command ${sub ?? ""}`);
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
        allowOnly(flags, []);
        const session = openSession({ home, env, fetchImpl });
        const names = session.custody.listJournal().filter((name) => name.startsWith("op-"));
        const done = [];
        for (const name of names) {
          const { entry, result } = await session.replayOperation(name);
          done.push({ operation: entry.operation, target: entry.target, outcome: result?.outcome });
        }
        print(io, flags, done, (items) => items.map((d) => `${d.operation} ${d.target ?? ""} → ${d.outcome}`).join("\n") || "Nothing to resume.");
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
        io.stdout(USAGE);
        return command ? 0 : 2;
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
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

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
