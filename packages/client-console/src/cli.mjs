#!/usr/bin/env node
/**
 * triangle-client-console — local operator console (scaffold).
 *
 * Usage:
 *   triangle-client-console status [--human] [--installation inst_…] [--service-script PATH]
 *   triangle-client-console bind --profile NAME --key-file PATH [--origin URL] [--execute]
 *   triangle-client-console watch-ensure --installation inst_… --actor-profile NAME [--execute]
 *   triangle-client-console service status|start|stop --script PATH [--execute]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDashboard, readTrianglePermissions } from "./status.mjs";
import { formatDashboardHuman } from "./format.mjs";
import { bindAction, watchEnsureAction, serviceAction } from "./actions.mjs";
import { assertSecretFree } from "./secrets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_SERVICE_SCRIPT = path.join(REPO_ROOT, "scripts", "triangle-client-service.sh");

async function main(argv) {
  const [command = "status", ...rest] = argv;
  switch (command) {
    case "status":
    case "dashboard":
      return runStatus(rest);
    case "bind":
      return runBind(rest);
    case "watch-ensure":
      return runWatchEnsure(rest);
    case "service":
      return runService(rest);
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      return 64;
  }
}

async function runStatus(args) {
  const flags = parseFlags(args, {
    human: "boolean",
    installation: "string",
    "service-script": "string",
    home: "string",
    "triangle-home": "string",
  });
  const serviceScriptPath =
    flags["service-script"] ??
    (process.platform === "darwin" ? DEFAULT_SERVICE_SCRIPT : undefined);

  const dashboard = await collectDashboard({
    home: flags.home,
    readPermissions: readTrianglePermissions,
    triangleHome: flags["triangle-home"],
    installationId: flags.installation,
    serviceScriptPath,
  });
  assertSecretFree(dashboard, "cli dashboard");
  if (flags.human) {
    process.stdout.write(formatDashboardHuman(dashboard));
  } else {
    process.stdout.write(`${JSON.stringify(dashboard, null, 2)}\n`);
  }
  return dashboard.helper?.present ? 0 : 1;
}

async function runBind(args) {
  const flags = parseFlags(args, {
    profile: "string",
    "key-file": "string",
    origin: "string",
    execute: "boolean",
    home: "string",
  });
  if (!flags.profile || !flags["key-file"]) {
    console.error("bind requires --profile and --key-file");
    return 64;
  }
  const result = await bindAction({
    profile: flags.profile,
    keyFile: flags["key-file"],
    origin: flags.origin ?? null,
    home: flags.home,
    execute: Boolean(flags.execute),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.stub ? 0 : result.exitCode === 0 ? 0 : 1;
}

async function runWatchEnsure(args) {
  const flags = parseFlags(args, {
    installation: "string",
    "actor-profile": "string",
    execute: "boolean",
    home: "string",
  });
  if (!flags.installation || !flags["actor-profile"]) {
    console.error("watch-ensure requires --installation and --actor-profile");
    return 64;
  }
  const result = await watchEnsureAction({
    installationId: flags.installation,
    actorProfile: flags["actor-profile"],
    home: flags.home,
    execute: Boolean(flags.execute),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.stub ? 0 : result.exitCode === 0 ? 0 : 1;
}

async function runService(args) {
  const [action, ...rest] = args;
  if (!action || !["status", "start", "stop"].includes(action)) {
    console.error("service requires status|start|stop");
    return 64;
  }
  const flags = parseFlags(rest, {
    script: "string",
    execute: "boolean",
  });
  const serviceScriptPath = flags.script ?? DEFAULT_SERVICE_SCRIPT;
  const result = await serviceAction({
    action,
    serviceScriptPath,
    execute: action === "status" ? true : Boolean(flags.execute),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.stub ? 0 : result.exitCode === 0 ? 0 : 1;
}

function parseFlags(args, schema) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      throw Object.assign(new Error(`Unexpected argument: ${token}`), { code: "bad_argv" });
    }
    const key = token.slice(2);
    const kind = schema[key];
    if (!kind) {
      throw Object.assign(new Error(`Unknown flag: ${token}`), { code: "bad_argv" });
    }
    if (kind === "boolean") {
      out[key] = true;
      continue;
    }
    const value = args[i + 1];
    if (value == null || value.startsWith("--")) {
      throw Object.assign(new Error(`Flag ${token} requires a value`), { code: "bad_argv" });
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

function printHelp() {
  process.stdout.write(`triangle-client-console — Triangle Client local operator console (scaffold)

Commands:
  status [--human] [--installation inst_…] [--service-script PATH] [--triangle-home DIR]
  bind --profile NAME --key-file <TRIANGLE_HOME>/agents/<agent_id>/workload-key.json [--origin URL] [--execute]
  watch-ensure --installation inst_… --actor-profile NAME [--execute]
  service status|start|stop [--script PATH] [--execute]

Security:
  Never pass mesh_ / mesh_watch_ secrets on argv. Status paths fail closed if helper output leaks secrets.
  bind passes only the key file path; the helper reads the 0600 key itself and verifies it with MESH.
`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error?.code === "secret_leak"
      ? error.message
      : error?.message ?? String(error);
    console.error(message);
    process.exitCode = error?.code === "bad_argv" ? 64 : 1;
  });
