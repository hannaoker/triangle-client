#!/usr/bin/env node
// AD.3 rehearsal driver: identity aliases (AD.0 to AD.2) on a scratch application root, between the INSTALLED supervisor
// bundle (copied byte for byte from the live application root, which is only read) and a CANDIDATE client package built by
// scripts/release/build-client-package.mjs, whose supervisor bundle is staged by the package's own installer.
//
//   node rehearsal-aliases.mjs --candidate-archive FILE.tar.gz --source-commit SHA [--installed-source-commit SHA]
//                              [--installed-app-root DIR] [--repo-root DIR] [--baseline-manifest FILE]
//                              [--baseline-release VERSION] [--out DIR] [--keep]
//
// The release train it rehearses is plan section 6 of docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md:
// the installed supervisor (the D1 bundle, which reads a v2 registry and knows nothing of aliases) is restaged to the
// candidate (gate H2), the client package with the `alias` commands is installed (H3), and an alias is set and used (H4);
// then the supervisor is rolled back to the installed bundle with the aliases still in the registry, and restaged again.
// The registry, client configuration and journal are scratch; the real interfaces are used wherever the owner would use
// them: the installed `triangle-local` wrapper (send, status, discover, setup-grok, grok send), the package's own installer
// and installed `triangle` wrapper (identity alias, upgrade-registry, restore-registry, status --identity), and
// `triangle-worker-install.py` (stage-runtime, validate-runtime, rollback-runtime, commit-runtime).
//
// The senders are the paired desktop (the owner CLI) and a Grok principal (`limited`, set up with `triangle-local
// setup-grok`) whose outgoing grant covers only some recipients: it stands for a chat that may message some of the
// workers and not others, so the indistinguishability of an alias the sender may not use is shown on the production host.
//
// "Installed" means the supervisor in the live supervisor manifest. After the candidate has been installed (gate H2) that
// manifest is the candidate's, so pass --baseline-manifest with the saved pre-install manifest (the install keeps one under
// archive/) and --baseline-release with the previous client package version.
//
// What it never does: write under the installed application root, open its journal or registry, use its credentials,
// signal its processes, or touch launchd. Every process it starts runs with HOME, TMPDIR and every path inside the scratch
// root and with a clean environment, with one exception: the package's own installer verifies its archive in
// /private/tmp/triangle-package-verify.XXXXXX, which its exit trap removes. The runner records fingerprints of the
// installed root (file hashes, stat data including ctime, a digest of the baseline bundle's tree, the supervisor wrapper and
// node process) before and after, and fails if they differ.
//
// Output: results.json in --out (default: next to this file) and a one-line verdict per step on stdout. Exit 0 only when
// every step passed.
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CheckFailed, check, fingerprintLive, jsonOf, lastJsonLine, mode, octal, parseJson, run, same, sha256Buffer, sha256File, sha256Text } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const V1 = "identity_registry_v1";
const V2 = "identity_registry_v2";
const LOCAL = ["alpha", "beta", "scratch-b"]; // the client's recipients; scratch-b has no binding (D1.5's second recipient)
const BOUND = ["alpha", "beta", "ghost"]; // the profiles with a binding; ghost is bound and not a local recipient, as in the live registry
const LATE = "late"; // a profile added to the client after an alias of that name exists (the resolve-time collision)
const GROK = "limited"; // the Grok principal; may message beta, scratch-b and late, and not alpha
const BASE_AUDIT = ["bind", "bind", "bind"]; // the live registry's shape: three binds and no init entry
// The supervisor artifacts that plan section 6 lists as "exactly AD's modules".
const EXPECTED_SUPERVISOR_DIFF = [
  "packages/agent-worker/src/grok-local-session.mjs",
  "packages/agent-worker/src/identity-primitives.mjs",
  "packages/agent-worker/src/identity-registry.mjs",
  "packages/agent-worker/src/local-messaging-cli.mjs",
  "packages/agent-worker/src/local-messaging-client.mjs",
  "packages/agent-worker/src/local-messaging-journal.mjs",
  "packages/agent-worker/src/local-messaging-protocol.mjs",
  "packages/agent-worker/src/local-messaging-server.mjs",
  "packages/agent-worker/src/recipient-resolver.mjs",
  "packages/agent-worker/src/router-registry-snapshot.mjs",
  "packages/agent-worker/src/unified-router.mjs",
];
const ADDITIVE_COUNTERS = { resolved: ["alias"], errors: ["alias_unresolved"] };

function parseArgs(argv) {
  const options = { keep: false };
  const withValue = ["candidate-archive", "installed-app-root", "repo-root", "out", "source-commit", "installed-source-commit", "baseline-manifest", "baseline-release"];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--keep") options.keep = true;
    else if (withValue.includes(flag.slice(2)) && argv[i + 1]) options[flag.slice(2)] = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${flag}`);
  }
  if (!options["candidate-archive"]) throw new Error("--candidate-archive is required");
  options["installed-app-root"] = path.resolve(options["installed-app-root"] ?? path.join(os.homedir(), "Library/Application Support/The Triangle"));
  options["repo-root"] = path.resolve(options["repo-root"] ?? path.join(here, "../../.."));
  options.out = path.resolve(options.out ?? here);
  options["candidate-archive"] = path.resolve(options["candidate-archive"]);
  if (options["baseline-manifest"]) options["baseline-manifest"] = path.resolve(options["baseline-manifest"]);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Any exit that does not pass through the verdict below, a silent one included, counts as a failure.
  process.exitCode = 1;
  check(process.platform === "darwin", "this rehearsal needs macOS");
  check(Number(process.versions.node.split(".")[0]) >= 22, "this rehearsal needs Node 22 or later");
  const live = options["installed-app-root"];
  check(fs.existsSync(path.join(live, "worker-runtime/supervisor.manifest.json")), `no installed supervisor manifest under ${live}`);
  const realish = (target) => {
    let current = path.resolve(target);
    const rest = [];
    while (!fs.existsSync(current) && current !== path.dirname(current)) { rest.unshift(path.basename(current)); current = path.dirname(current); }
    return path.join(fs.realpathSync(current), ...rest);
  };
  const liveReal = realish(live);
  check(realish(options.out) !== liveReal && !realish(options.out).startsWith(liveReal + path.sep), "--out must not be inside the installed application root");
  const baselineManifestFile = options["baseline-manifest"] ?? path.join(live, "worker-runtime/supervisor.manifest.json");
  check(fs.existsSync(baselineManifestFile), `no baseline supervisor manifest at ${baselineManifestFile}`);

  const results = {
    schema: "identity_aliases_ad3_rehearsal_v1",
    startedAt: new Date().toISOString(),
    runner: { node: process.version, platform: process.platform, arch: process.arch, script: path.basename(fileURLToPath(import.meta.url)) },
    inputs: {},
    steps: [],
    verdict: "incomplete",
  };
  const steps = results.steps;
  let current = null;
  const hosts = new Map();
  let base = null;
  let pkgTestRoot = null;

  // Scratch root: short, because a unix socket path may not exceed 100 bytes.
  const makeBase = () => {
    for (const parent of [fs.realpathSync(os.tmpdir()), "/private/tmp"]) {
      const candidate = fs.mkdtempSync(path.join(parent, "ad3r-"));
      fs.chmodSync(candidate, 0o700);
      const socket = path.join(candidate, "a/client/l/local-control.sock");
      if (Buffer.byteLength(socket) <= 100) return candidate;
      fs.rmSync(candidate, { recursive: true, force: true });
    }
    throw new Error("no scratch directory short enough for a unix socket");
  };

  const step = async (id, title, fn) => {
    const record = { id, title, ok: false, ms: 0, data: {} };
    steps.push(record);
    current = record;
    const started = Date.now();
    try {
      const data = await fn(record);
      if (data !== undefined) record.data = { ...record.data, ...data };
      record.ok = true;
      process.stdout.write(`PASS ${id}  ${title}\n`);
    } catch (error) {
      record.error = { message: error.message, details: error.details ?? null };
      process.stdout.write(`FAIL ${id}  ${title}\n      ${error.message}\n`);
      throw error;
    } finally {
      record.ms = Date.now() - started;
    }
  };

  // ---- fixed layout, filled in by the first steps
  let app, client, stateRoot, registry, home, tmp, ptyRun;
  let configPath, oldBundle, oldNode, oldManifestBytes, oldBundleId, instCli, cand, candNode, wrapperPath, backupsRoot, pkgWrapper;
  let env;
  let liveBefore;
  let releaseVersion;
  let ids = {}; // profile -> instance id
  let principals = {}; // profile -> principal id
  const pairs = {}; // "sender>recipient" -> accepted sends, against the product's limit of 10 per pair per 10 minutes
  let seq = 0; // the registry sequence the runner expects

  const tl = (args, opts = {}) => run(wrapperPath, [...args, "--config", configPath], { env, ...opts });
  // The installed bundle's own owner CLI, as a client that predates the restage (an old chat's tools use the same client code).
  const oldTl = (args, opts = {}) => run(oldNode, [path.join(oldBundle, "packages/agent-worker/src/local-messaging-cli.mjs"), ...args, "--config", configPath], { env, ...opts });
  const candCli = (args, opts = {}) => run(candNode, [path.join(cand, "packages/triangle-cli/src/cli.mjs"), ...args], { env, ...opts });
  const candPty = (args) => run("/usr/bin/python3", ["-I", ptyRun, candNode, path.join(cand, "packages/triangle-cli/src/cli.mjs"), ...args], { env });
  const instCliRun = (args, opts = {}) => run(oldNode, [path.join(instCli, "packages/triangle-cli/src/cli.mjs"), ...args], { env, ...opts });
  const pkgCli = (args, opts = {}) => run(pkgWrapper, args, { env, ...opts });
  const pkgPty = (args) => run("/usr/bin/python3", ["-I", ptyRun, pkgWrapper, ...args], { env });
  const installer = (args, opts = {}) => run("/usr/bin/python3", ["-I", path.join(cand, "scripts/triangle-worker-install.py"), ...args], { env, ...opts });
  const helper = (bundle, args, opts = {}) => run(path.join(bundle, "bin/node"), [path.join(here, "alias-host.mjs"), args[0], bundle, ...args.slice(1)], { env, ...opts });
  const manifestPath = () => path.join(app, "worker-runtime/supervisor.manifest.json");
  const currentBundle = () => JSON.parse(fs.readFileSync(manifestPath(), "utf8")).projectRoot;
  const registryFile = () => path.join(registry, "identity-registry-v1.json");
  const auditFile = () => path.join(registry, "registry-audit.jsonl");
  const registryFiles = () => ({
    registry: fs.existsSync(registryFile()) ? sha256File(registryFile()) : null,
    audit: fs.existsSync(auditFile()) ? sha256File(auditFile()) : null,
  });
  const registryJson = () => JSON.parse(fs.readFileSync(registryFile(), "utf8"));
  const auditActions = () => fs.readFileSync(auditFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l).action);
  const backupListing = () => (fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot).sort() : []);
  const compareLive = async () => {
    const after = await fingerprintLive(live, releaseVersion, oldBundleId);
    const strip = (x) => JSON.parse(JSON.stringify(x));
    const differences = Object.keys(liveBefore).filter((key) => !same(strip(liveBefore[key]), strip(after[key])));
    return { identical: differences.length === 0, compared: Object.keys(liveBefore), differences, ...(differences.length ? { before: strip(liveBefore), after: strip(after) } : {}) };
  };

  const startHost = async (label) => {
    check(!hosts.has(label), `host ${label} is already running`);
    const bundle = currentBundle();
    const child = spawn(path.join(bundle, "bin/node"), [path.join(here, "alias-host.mjs"), "run", bundle, configPath], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    // The close promise exists from the moment of the spawn, so a host that dies early or late is never waited on forever.
    const closed = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
      child.on("error", (error) => resolve({ code: -1, signal: null, error: String(error) }));
    });
    let exited = false;
    closed.then(() => { exited = true; });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    hosts.set(label, { child, bundle, closed, hasExited: () => exited });
    const ready = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new CheckFailed(`host ${label} did not become ready: ${stderr.slice(0, 500)}`)), 30000);
      child.stdout.on("data", (d) => {
        buffer += d;
        const line = buffer.split("\n").find((l) => l.includes('"ready"'));
        if (line) { clearTimeout(timer); resolve(parseJson(line)); }
      });
      closed.then((result) => { clearTimeout(timer); reject(new CheckFailed(`host ${label} exited before it was ready (${result.code ?? result.signal}): ${stderr.slice(0, 500)}`)); });
    });
    return { pid: ready.pid, bundleId: path.basename(bundle), node: ready.node };
  };
  const stopHost = async (label) => {
    const host = hosts.get(label);
    if (!host) return undefined;
    hosts.delete(label);
    if (host.hasExited()) return host.closed;
    try { process.kill(host.child.pid, "SIGTERM"); } catch { /* already gone */ }
    const killTimer = setTimeout(() => { try { process.kill(-host.child.pid, "SIGKILL"); } catch { /* already gone */ } }, 10000);
    let giveUp;
    const gaveUp = new Promise((resolve) => { giveUp = setTimeout(() => resolve(null), 20000); });
    const result = await Promise.race([host.closed, gaveUp]);
    clearTimeout(killTimer);
    clearTimeout(giveUp);
    return result;
  };

  // ---- the owner CLI (the paired desktop sender) and the Grok principal, both through the installed triangle-local
  const status = async () => {
    const result = await tl(["status"]);
    check(result.code === 0, `triangle-local status failed (${result.code}): ${result.stderr.slice(0, 300)}`, result);
    return parseJson(result.stdout);
  };
  const routerBlock = async () => (await status()).router;
  const discover = async () => {
    const result = await tl(["discover"]);
    check(result.code === 0, `triangle-local discover failed (${result.code}): ${result.stderr.slice(0, 300)}`, result);
    return parseJson(result.stdout);
  };
  // The product limits accepted exchanges per sender and recipient pair; an alias counts for the recipient it resolved to.
  const bump = (sender, to, receipt) => {
    const profile = receipt?.target?.profile ?? Object.entries(ids).find(([, id]) => id === to)?.[0] ?? Object.entries(principals).find(([, p]) => p === to)?.[0] ?? to;
    const key = `${sender}>${profile}`;
    pairs[key] = (pairs[key] ?? 0) + 1;
  };
  const send = async (to, text, { messageId = crypto.randomUUID(), requestId = crypto.randomUUID(), wait = 5000, count = true } = {}) => {
    const result = await tl(["send", "--to", to, "--text", text, "--message-id", messageId, "--request-id", requestId, "--wait-ms", String(wait)]);
    const json = parseJson(result.stdout) ?? lastJsonLine(result.stdout) ?? lastJsonLine(result.stderr);
    if (result.code === 0 && count && json?.admission?.isDuplicate !== true) bump("desktop", to, json?.admission);
    return { code: result.code, json, stderr: result.stderr.trim().slice(0, 300), messageId, requestId };
  };
  const grokSend = async (to, text, { messageId = crypto.randomUUID(), requestId = crypto.randomUUID(), count = true } = {}) => {
    const file = path.join(tmp, `grok-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    const result = await tl(["grok", "send", "--alias", GROK, "--to", to, "--message-id", messageId, "--request-id", requestId, "--text-file", file]);
    fs.rmSync(file, { force: true });
    const json = parseJson(result.stdout) ?? lastJsonLine(result.stdout) ?? lastJsonLine(result.stderr);
    if (result.code === 0 && count && json?.isDuplicate !== true) bump("grok", to, json);
    return { code: result.code, json, stderr: result.stderr.trim().slice(0, 300), messageId, requestId };
  };
  const grokReply = async (requestId) => {
    for (let i = 0; i < 20; i += 1) {
      const r = await tl(["grok", "replies", "--alias", GROK, "--request-id", requestId]);
      const replies = parseJson(r.stdout)?.replies ?? [];
      if (replies.length) return replies;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return [];
  };
  const messageStatus = async (messageId) => {
    const r = await tl(["status", "--message-id", messageId]);
    return { code: r.code, json: parseJson(r.stdout), text: (r.stdout + r.stderr).trim().slice(0, 300) };
  };
  const grokStatus = async (messageId) => {
    const r = await tl(["grok", "status", "--alias", GROK, "--message-id", messageId]);
    return { code: r.code, json: parseJson(r.stdout), text: (r.stdout + r.stderr).trim().slice(0, 300) };
  };
  // What a sender is told, without the ids that differ from run to run.
  const outcome = (r) => ({ exit: r.code, state: r.json?.state ?? null, error: r.json?.error ?? null });
  const reached = (r, profile, text) => JSON.stringify(r.json ?? "").includes(`echo[${profile}]: ${text}`);
  const target = (r) => r.json?.admission?.target ?? r.json?.target ?? null;

  const strip = (x) => JSON.parse(JSON.stringify(x));
  const withoutAliases = (entries) => entries.map((e) => ({ ...e, send: Object.fromEntries(Object.entries(e.send).filter(([k]) => k !== "aliases")) }));
  let expectedEntries = null; // the discovery entries with no aliases once the late profile exists
  const countersOf = (block) => strip({ resolved: block.resolved, errors: block.errors });
  // The change in the router's counters between two blocks, without the counters that only the candidate has.
  const counterDelta = (before, after, { withAdditive = false } = {}) => {
    const out = { resolved: {}, errors: {} };
    for (const group of ["resolved", "errors"]) {
      for (const key of Object.keys(after[group] ?? {})) {
        if (!withAdditive && ADDITIVE_COUNTERS[group].includes(key)) continue;
        const delta = (after[group][key] ?? 0) - (before[group]?.[key] ?? 0);
        if (delta !== 0) out[group][key] = delta;
      }
    }
    return out;
  };
  const registrySummary = (block) => strip({ state: block.registry.state, sequence: block.registry.sequence, schema: block.registry.schema, supportedSchemas: block.registry.supportedSchemas, rootSha256: block.registry.rootSha256 });

  // The negative set of D1.5 (plan section 8, item 4), as far as it can be run without a worker: every probe is refused,
  // and the answer is part of what must not change when aliases arrive.
  const NEGATIVE_PROBES = () => [
    { id: "unknown-principal", who: "desktop", to: `agent_${"0".repeat(32)}` },
    { id: "peer-id", who: "desktop", to: `peer_${"0".repeat(32)}` },
    { id: "bound-not-local-principal", who: "desktop", to: principals.ghost },
    { id: "exact-id-outside-grant", who: "grok", to: ids.alpha },
    { id: "alias-shaped-unknown-name", who: "grok", to: "nobody" },
    { id: "alias-shaped-unknown-name-owner-cli", who: "desktop", to: "nobody" },
  ];
  const runNegativeSet = async () => {
    const before = await routerBlock();
    const answers = {};
    for (const probe of NEGATIVE_PROBES()) {
      const r = probe.who === "grok" ? await grokSend(probe.to, `negative ${probe.id}`, { count: false }) : await send(probe.to, `negative ${probe.id}`, { wait: 0, count: false });
      const lookup = await messageStatus(r.messageId);
      answers[probe.id] = { ...outcome(r), reachedARunner: JSON.stringify(r.json ?? "").includes("echo["), journalRow: lookup.code === 0 };
      check(r.code !== 0 && answers[probe.id].reachedARunner === false && answers[probe.id].journalRow === false, `negative probe ${probe.id} was not refused cleanly`, { r: r.json, stderr: r.stderr, lookup: lookup.text });
    }
    const after = await routerBlock();
    return { answers, delta: counterDelta(before, after), deltaWithAdditive: counterDelta(before, after, { withAdditive: true }) };
  };

  const stageCandidate = async () => {
    const staged = await installer(["stage-runtime", "--application-root", app, "--project-root", cand, "--agent", "supervisor", "--node", oldNode]);
    check(staged.code === 0, `stage-runtime failed: ${staged.stderr.slice(0, 400)}`, staged);
    const valid = await installer(["validate-runtime", "--manifest", manifestPath(), "--agent", "supervisor"]);
    check(valid.code === 0, `validate-runtime failed: ${valid.stderr.slice(0, 400)}`, valid);
    const names = fs.readdirSync(path.join(app, "worker-runtime")).filter((n) => n.startsWith(".rollback-supervisor-"));
    check(names.length === 1, `expected exactly one rollback record, found ${names.length}`);
    return { record: path.join(app, "worker-runtime", names[0]), bundleId: path.basename(currentBundle()) };
  };

  // ---- alias commands, through the installed triangle of the candidate package
  const aliasArgs = (action, name, target_) => ["identity", "alias", action, name, ...(target_ ? [target_] : []), "--client-root", client];
  const aliasPlan = async (action, name, target_) => {
    const r = await pkgCli([...aliasArgs(action, name, target_), "--json"]);
    return { code: r.code, plan: jsonOf(r), stderr: r.stderr.trim().slice(0, 300) };
  };
  const aliasApply = async (action, name, target_, { expectSequence = true } = {}) => {
    const planned = await aliasPlan(action, name, target_);
    check(planned.code === 0 && planned.plan?.ready === true, `alias ${action} ${name} plan is not ready`, planned);
    const before = registryFiles();
    const applied = await pkgPty([...aliasArgs(action, name, target_), "--confirm", planned.plan.planId, "--json"]);
    check(/pty-exit: 0/.test(applied.stderr), `alias ${action} ${name} apply failed: ${applied.stdout.slice(0, 500)} ${applied.stderr.slice(0, 200)}`, applied);
    const result = parseJson(applied.stdout.trim());
    check(result?.schema === "identity_alias_result_v1" && result.action === action && result.alias === name, "unexpected apply result", result);
    if (expectSequence) {
      check(result.from.sequence === seq && result.to.sequence === seq + 1, `the write did not move the sequence from ${seq} to ${seq + 1}`, result);
      seq += 1;
    }
    check(registryFiles().registry !== before.registry, "the registry did not change");
    return { plan: planned.plan, result };
  };

  try {
    // =========================================================================================== A. inputs
    await step("A1", "installed state: supervisor manifest, bundle and client package (read only)", async () => {
      const manifest = JSON.parse(fs.readFileSync(baselineManifestFile, "utf8"));
      oldBundleId = path.basename(manifest.projectRoot);
      const bundle = manifest.projectRoot;
      check(manifest.version === 14, `installed supervisor manifest is v${manifest.version}, not v14`);
      check(path.dirname(bundle) === path.join(live, "worker-runtime/bundles"), "installed projectRoot is not under the installed bundles directory");
      const install = JSON.parse(fs.readFileSync(path.join(live, "package-install.json"), "utf8"));
      releaseVersion = options["baseline-release"] ?? install.version;
      check(fs.existsSync(path.join(live, "releases", releaseVersion, "package-manifest.json")), `no release ${releaseVersion} under ${live}/releases`);
      results.inputs.installed = {
        manifestVersion: manifest.version,
        bundleId: oldBundleId,
        artifacts: Object.keys(manifest.artifacts).length,
        nodeSHA256: manifest.nodeSHA256,
        manifestSha256: sha256File(baselineManifestFile),
        baselineManifest: options["baseline-manifest"] ? "a saved manifest given with --baseline-manifest" : "the live supervisor manifest",
        clientPackageVersion: releaseVersion,
        triangleLocalSha256: sha256File(path.join(live, "bin/triangle-local")),
      };
      liveBefore = await fingerprintLive(live, releaseVersion, oldBundleId);
      return { installed: results.inputs.installed, supervisorProcesses: liveBefore.processes.length };
    });

    base = makeBase();
    const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
    check(!inside(base, live) && !inside(live, base), "the scratch root and the installed root overlap");
    app = path.join(base, "a");
    client = path.join(app, "client");
    stateRoot = path.join(client, "l");
    registry = path.join(app, "identity");
    backupsRoot = path.join(app, "identity-backups");
    home = path.join(base, "home");
    tmp = path.join(base, "tmp");
    instCli = path.join(base, "inst-cli");
    cand = path.join(base, "cand");
    ptyRun = path.join(here, "pty-run.py");
    for (const dir of [app, client, home, tmp, path.join(app, "bin"), path.join(app, "worker-runtime"), path.join(app, "worker-runtime/bundles")]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const dir of [app, client, path.join(app, "bin"), path.join(app, "worker-runtime"), path.join(app, "worker-runtime/bundles")]) fs.chmodSync(dir, 0o700);
    configPath = path.join(client, "local-messaging.json");
    wrapperPath = path.join(app, "bin/triangle-local");
    env = { HOME: home, TMPDIR: tmp, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", USER: os.userInfo().username, LOGNAME: os.userInfo().username };
    results.scratch = { root: base, applicationRoot: app };

    await step("A2", "installed bundle copied to the scratch root, byte-checked against the live manifest", async () => {
      const manifest = JSON.parse(fs.readFileSync(baselineManifestFile, "utf8"));
      const source = manifest.projectRoot;
      oldBundle = path.join(app, "worker-runtime/bundles", oldBundleId);
      fs.cpSync(source, oldBundle, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, preserveTimestamps: false });
      oldNode = path.join(oldBundle, "bin/node");
      // cpSync keeps file modes but creates directories with the umask; the installer requires exactly 0700.
      const privateDirs = (dir) => {
        fs.chmodSync(dir, 0o700);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) privateDirs(path.join(dir, entry.name));
      };
      privateDirs(oldBundle);
      let mismatches = 0;
      for (const [rel, expected] of Object.entries(manifest.artifacts)) {
        if (sha256File(path.join(oldBundle, rel)) !== expected) mismatches += 1;
      }
      check(mismatches === 0, `${mismatches} copied artifacts differ from the live manifest`);
      check(sha256File(oldNode) === manifest.nodeSHA256, "copied node differs from the live manifest's nodeSHA256");
      // The scratch manifest is the live one with the two path-bearing fields pointed at the copy.
      const scratchManifest = { ...manifest, projectRoot: oldBundle, environment: { PATH: `${oldBundle}/bin:/usr/bin:/bin`, LANG: "C", LC_ALL: "C" } };
      fs.writeFileSync(manifestPath(), JSON.stringify(scratchManifest, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(manifestPath(), 0o600);
      oldManifestBytes = fs.readFileSync(manifestPath());
      // The installed triangle-local, pointed at the scratch root (one constant line).
      const wrapper = fs.readFileSync(path.join(live, "bin/triangle-local"), "utf8");
      const constant = /^TRIANGLE_LOCAL_APPLICATION_ROOT = .*$/m;
      check(constant.test(wrapper), "installed triangle-local has no application-root constant");
      check(!/['\\\n]/.test(app), "the scratch application root path must not contain quotes, backslashes or newlines");
      const rootLine = `TRIANGLE_LOCAL_APPLICATION_ROOT = '${app}'`;
      fs.writeFileSync(wrapperPath, wrapper.replace(constant, () => rootLine), { mode: 0o700 });
      fs.chmodSync(wrapperPath, 0o700);
      check(fs.readFileSync(wrapperPath, "utf8").split("\n").includes(rootLine), "the scratch triangle-local does not name the scratch application root");
      // The installed client package's CLI code (its own node is the bundle's: same hash).
      const release = path.join(live, "releases", releaseVersion);
      fs.cpSync(path.join(release, "packages"), path.join(instCli, "packages"), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
      privateDirs(instCli);
      return {
        artifactsVerified: Object.keys(manifest.artifacts).length,
        nodeSha256: manifest.nodeSHA256,
        clientPackageNodeEqualsBundleNode: sha256File(path.join(release, "bin/node")) === manifest.nodeSHA256,
        scratchModes: { app: octal(mode(app)), manifest: octal(mode(manifestPath())), node: octal(mode(oldNode)), wrapper: octal(mode(wrapperPath)) },
      };
    });

    const git = (args) => run("/usr/bin/git", ["-C", options["repo-root"], ...args], { env: { PATH: "/usr/bin:/bin", HOME: home } });
    const gitBlob = (commit, file) => execFileSync("/usr/bin/git", ["-C", options["repo-root"], "show", `${commit}:${file}`], { env: { PATH: "/usr/bin:/bin", HOME: home }, maxBuffer: 64 * 1024 * 1024 });
    let candidateCommit;
    await step("A3", "candidate package: archive hash, contents against the commit, node, version", async () => {
      const archive = options["candidate-archive"];
      const archiveSha = sha256File(archive);
      const recorded = fs.existsSync(`${archive}.sha256`) ? fs.readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/)[0] : null;
      check(recorded === null || recorded === archiveSha, "archive hash differs from its .sha256 file");
      fs.mkdirSync(cand, { mode: 0o700 });
      const untar = await run("/usr/bin/tar", ["-xzf", archive, "-C", cand], { env: { PATH: "/usr/bin:/bin" } });
      check(untar.code === 0, `tar failed: ${untar.stderr}`);
      const manifest = JSON.parse(fs.readFileSync(path.join(cand, "package-manifest.json"), "utf8"));
      let wrong = 0;
      for (const file of manifest.files) {
        const actual = path.join(cand, file.path);
        if (!fs.existsSync(actual) || sha256File(actual) !== file.sha256 || (mode(actual) !== file.mode)) wrong += 1;
      }
      check(wrong === 0, `${wrong} packaged files differ from package-manifest.json`);
      const listed = new Set(["package-manifest.json", ...manifest.files.map((f) => f.path)]);
      const unmanifested = [];
      const walk = (dir, prefix = "") => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix + entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}/`);
          else if (!listed.has(rel)) unmanifested.push(rel);
        }
      };
      walk(cand);
      check(unmanifested.length === 0, `${unmanifested.length} extracted files are not listed in package-manifest.json`, unmanifested.slice(0, 10));
      // Tie the package to the commit: every packaged file that git tracks is the committed blob.
      const sourceRef = options["source-commit"] ?? "HEAD";
      candidateCommit = (await git(["rev-parse", `${sourceRef}^{commit}`])).stdout.trim();
      check(/^[0-9a-f]{40}$/.test(candidateCommit), `cannot resolve ${sourceRef}`);
      const tracked = new Set((await git(["ls-tree", "-r", "-z", "--name-only", candidateCommit])).stdout.split("\0").filter(Boolean));
      let compared = 0;
      for (const file of manifest.files) {
        if (!tracked.has(file.path)) continue;
        check(sha256Buffer(gitBlob(candidateCommit, file.path)) === file.sha256, `${file.path} differs from the committed blob`);
        compared += 1;
      }
      check(compared > 100, `only ${compared} packaged files are tracked sources; the comparison is too thin`);
      candNode = path.join(cand, "bin/node");
      const nodeSha = sha256File(candNode);
      check(nodeSha === results.inputs.installed.nodeSHA256, "candidate node differs from the installed bundle's node");
      for (const rel of ["packages/triangle-cli/src/identity-alias.mjs", "packages/triangle-cli/src/identity-upgrade.mjs"]) check(fs.existsSync(path.join(cand, rel)), `candidate package lacks ${rel}`);
      const sign = await run("/usr/bin/codesign", ["--verify", "--strict", path.join(cand, "bin/triangle-mailbox"), path.join(cand, "bin/triangle-client")], { env: { PATH: "/usr/bin:/bin" } });
      results.inputs.candidate = {
        commit: candidateCommit,
        version: manifest.version,
        archiveSha256: archiveSha,
        files: manifest.files.length,
        signingMode: manifest.signingMode,
        credentialCustody: manifest.credentialCustody,
        testOnly: manifest.testOnly ?? false,
      };
      check(sign.code === 0, `codesign --verify --strict failed: ${sign.stderr.slice(0, 200)}`);
      return { ...results.inputs.candidate, trackedFilesEqualCommittedBlobs: compared, nodeEqualsInstalledNode: true, codesignStrict: "passed for triangle-mailbox and triangle-client" };
    });

    await step("A4", "supervisor artifact diff, installed bundle versus candidate: exactly AD's modules, nothing added or removed", async () => {
      const wa = JSON.parse(fs.readFileSync(path.join(cand, "worker-artifacts.json"), "utf8"));
      const installed = JSON.parse(fs.readFileSync(baselineManifestFile, "utf8")).artifacts;
      const candidate = new Set(wa.kinds.supervisor);
      const changed = [];
      for (const rel of wa.kinds.supervisor) {
        if (installed[rel] !== undefined && sha256File(path.join(cand, rel)) !== installed[rel]) changed.push(rel);
      }
      changed.sort();
      const added = [...candidate].filter((rel) => installed[rel] === undefined);
      const removed = Object.keys(installed).filter((rel) => !candidate.has(rel));
      const workerOverlap = {};
      for (const kind of ["codex", "hermes", "antigravity"]) workerOverlap[kind] = changed.filter((rel) => wa.kinds[kind].includes(rel));
      results.inputs.artifactDiff = { manifestVersion: wa.version, supervisorArtifacts: wa.kinds.supervisor.length, changed, added, removed, changedFilesInWorkerBundles: Object.fromEntries(Object.entries(workerOverlap).map(([k, v]) => [k, v.length])) };
      check(wa.version === 14, "candidate manifest version is not 14");
      check(added.length === 0 && removed.length === 0, "the supervisor artifact set changed (a manifest bump would be needed)");
      check(same(changed, EXPECTED_SUPERVISOR_DIFF), "the changed supervisor artifacts are not exactly the modules plan section 6 lists", { changed, expected: EXPECTED_SUPERVISOR_DIFF });
      // Independent of the bundle: what git says changed in the supervisor group between the installed bundle's source and the candidate.
      let git_ = null;
      if (options["installed-source-commit"]) {
        const installedCommit = (await git(["rev-parse", `${options["installed-source-commit"]}^{commit}`])).stdout.trim();
        check(/^[0-9a-f]{40}$/.test(installedCommit), "cannot resolve --installed-source-commit");
        let equal = 0;
        for (const [rel, sha] of Object.entries(installed)) {
          check(sha256Buffer(gitBlob(installedCommit, rel)) === sha, `the installed bundle's ${rel} is not the blob of ${installedCommit.slice(0, 8)}`);
          equal += 1;
        }
        const diff = (await git(["diff", "--name-only", "-z", installedCommit, candidateCommit])).stdout.split("\0").filter(Boolean);
        const bySource = wa.kinds.supervisor.filter((rel) => diff.includes(rel)).sort();
        check(same(bySource, changed), "the supervisor artifacts git says changed are not the ones the bundle diff found", { bySource, changed });
        git_ = { installedSourceCommit: installedCommit, installedArtifactsEqualBlobs: equal, gitChangedSupervisorArtifacts: bySource.length, equalToBundleDiff: true };
        results.inputs.artifactDiff.git = git_;
      }
      return results.inputs.artifactDiff;
    });

    await step("A5", "client package diff, installed release versus candidate package (what the client install would change)", async () => {
      const installedManifest = JSON.parse(fs.readFileSync(path.join(live, "releases", releaseVersion, "package-manifest.json"), "utf8"));
      const candidateManifest = JSON.parse(fs.readFileSync(path.join(cand, "package-manifest.json"), "utf8"));
      const a = new Map(installedManifest.files.map((f) => [f.path, f.sha256]));
      const b = new Map(candidateManifest.files.map((f) => [f.path, f.sha256]));
      const added = [...b.keys()].filter((p) => !a.has(p)).sort();
      const removed = [...a.keys()].filter((p) => !b.has(p)).sort();
      const changed = [...b.keys()].filter((p) => a.has(p) && a.get(p) !== b.get(p)).sort();
      results.inputs.packageDiff = { installedVersion: releaseVersion, installedFiles: a.size, candidateFiles: b.size, added, removed, changed, unchanged: a.size - removed.length - changed.length };
      check(added.includes("packages/triangle-cli/src/identity-alias.mjs"), "the alias command module is not new in the candidate package");
      check(removed.length === 0, "the candidate package removes files", removed);
      return results.inputs.packageDiff;
    });

    await step("A6", "the live install receipt against the disk (read only): what gate H3's package installer will find", async () => {
      // The package installer refuses a receipt whose owned files are not unchanged (the D1.5 finding at G3), so this is
      // checked ahead of time. Nothing is written; the paths are recorded relative to the application root.
      const receipt = JSON.parse(fs.readFileSync(path.join(live, "package-install.json"), "utf8"));
      const owned = Object.entries(receipt.owned ?? {});
      const mismatches = [];
      for (const [file, sha] of owned) {
        let actual = null;
        try { actual = sha256File(file); } catch { /* missing */ }
        if (actual !== sha) mismatches.push(path.relative(live, file));
      }
      results.inputs.liveReceipt = { version: receipt.version, ownedFiles: owned.length, matchingDisk: owned.length - mismatches.length, mismatches };
      return results.inputs.liveReceipt;
    });

    // ===================================================================== B. the installed supervisor
    await step("B1", "scratch client, router, v1 registry and the Grok principal, built with the installed bundle's code and wrapper", async () => {
      const spec = { clientRoot: client, stateRoot, registryRoot: registry, local: LOCAL, bound: BOUND, init: false };
      fs.writeFileSync(path.join(tmp, "spec.json"), JSON.stringify(spec), { mode: 0o600 });
      const prepared = lastJsonLine((await helper(oldBundle, ["prepare", path.join(tmp, "spec.json")])).stdout);
      check(prepared?.ok === true, "prepare failed", prepared);
      principals = prepared.principals;
      ids = prepared.instances;
      const lateId = lastJsonLine((await helper(oldBundle, ["ids", LATE])).stdout)[LATE];
      ids[LATE] = lateId;
      seq = prepared.sequence;
      // The Grok principal, through the owner's command: it may message beta, scratch-b and late, and not alpha.
      const setup = await tl(["setup-grok", "--alias", GROK, "--recipient", ids.beta, "--recipient", ids["scratch-b"], "--recipient", lateId]);
      const grok = lastJsonLine(setup.stdout);
      check(setup.code === 0 && grok?.alias === GROK && grok.requiresServiceRestart === true, `setup-grok failed: ${setup.stderr.slice(0, 300)}`, setup);
      const read = lastJsonLine((await helper(oldBundle, ["read", registry])).stdout);
      check(read.ok && read.schema === V1 && read.sequence === 3 && read.bindings === 3 && Object.keys(read.aliases).length === 0, "the installed reader does not see the expected v1 registry", read);
      check(same(auditActions(), BASE_AUDIT), "unexpected audit log", auditActions());
      return { registry: read, recipients: LOCAL, bound: BOUND, boundNotLocal: ["ghost"], localNotBound: ["scratch-b"], grokPrincipal: { alias: GROK, mayMessage: ["beta", "scratch-b", LATE], mayNotMessage: ["alpha"] } };
    });

    let baselineBlock;
    let baselineEntries;
    let baselineMessageId;
    await step("B2", "installed supervisor (copy) serves the v1 registry: status shape, principal and exact sends, discovery", async () => {
      const started = await startHost("old");
      const block = await routerBlock();
      check(block.enabled === true && block.registry.state === "ok" && block.registry.sequence === seq && block.registry.schema === V1, "installed supervisor does not report the v1 registry ok", block);
      check(same(block.registry.supportedSchemas, [V1, V2]) && block.registry.rootSha256 === sha256Text(registry), "installed supervisor does not report supportedSchemas and rootSha256", block.registry);
      check(block.registry.addressForms === undefined && block.resolved.alias === undefined && block.errors.alias_unresolved === undefined, "the installed supervisor already reports alias fields", block);
      const viaPrincipal = await send(principals.alpha, "baseline principal send");
      const viaExact = await send(ids.beta, "baseline exact send");
      check(viaPrincipal.code === 0 && reached(viaPrincipal, "alpha", "baseline principal send"), "the principal send did not reach its runner", viaPrincipal);
      check(viaExact.code === 0 && reached(viaExact, "beta", "baseline exact send"), "the exact send did not reach its runner", viaExact);
      baselineMessageId = viaPrincipal.messageId;
      const details = await discover();
      baselineEntries = strip(details.entries);
      check(details.entries.length === 3 && details.entries.every((e) => e.send.aliases === undefined), "the installed supervisor lists aliases in discovery", details.entries);
      baselineBlock = block;
      return { host: started, registryBlock: block.registry, registryBlockKeys: Object.keys(block.registry).sort(), counters: countersOf(block), principalSend: target(viaPrincipal), discoveryEntries: baselineEntries.length };
    });

    let backupDir;
    await step("B3", "the upgrade as the owner did it (G5): candidate CLI plan against the installed host, then apply in a terminal", async () => {
      const planRun = await candCli(["identity", "upgrade-registry", "--client-root", client, "--json"]);
      const plan = jsonOf(planRun);
      check(planRun.code === 0 && plan?.ready === true && plan.refusals.length === 0, `the upgrade plan is not ready (exit ${planRun.code})`, { stdout: planRun.stdout.slice(0, 800), stderr: planRun.stderr.slice(0, 300) });
      check(plan.registry.schema === V1 && plan.registry.sequence === seq, "plan facts differ from the registry", plan.registry);
      const before = registryFiles();
      const applied = await candPty(["identity", "upgrade-registry", "--client-root", client, "--confirm", plan.planId, "--json"]);
      check(/pty-exit: 0/.test(applied.stderr), `apply failed: ${applied.stdout.slice(0, 600)} ${applied.stderr.slice(0, 300)}`, applied);
      const result = parseJson(applied.stdout.trim());
      check(result?.to?.schema === V2 && result.to.sequence === seq + 1, "unexpected upgrade result", result);
      backupDir = result.backup.dir;
      check(path.dirname(backupDir) === backupsRoot, "backup is not under identity-backups beside the registry", backupDir);
      check(sha256File(path.join(backupDir, "identity-registry-v1.json")) === before.registry && sha256File(path.join(backupDir, "registry-audit.jsonl")) === before.audit, "backup bytes differ from the pre-upgrade registry");
      seq += 1;
      check(same(auditActions(), [...BASE_AUDIT, "upgrade"]), "audit log is not the old entries plus the upgrade entry", auditActions());
      const block = await routerBlock();
      check(block.registry.state === "ok" && block.registry.schema === V2 && block.registry.sequence === seq, "the installed host (no restart) does not serve the v2 registry", block.registry);
      // Sends are spread over the recipients: the product allows 10 accepted exchanges per sender and recipient pair per 10 minutes.
      const a = await send(principals.beta, "after upgrade principal");
      const b = await send(ids["scratch-b"], "after upgrade exact");
      check(a.code === 0 && reached(a, "beta", "after upgrade principal") && b.code === 0 && reached(b, "scratch-b", "after upgrade exact"), "sends failed after the upgrade", { a: a.json, b: b.json });
      baselineBlock = block;
      return { planId: plan.planId, floor: plan.floor, backupDirName: path.basename(backupDir), registryBlock: block.registry, auditActions: auditActions() };
    });

    let baselineNegative;
    await step("B4", "installed supervisor on the v2 registry, no aliases: the negative set, counters and discovery to hold constant", async () => {
      baselineNegative = await runNegativeSet();
      const details = await discover();
      check(same(strip(details.entries), baselineEntries), "discovery changed with the v2 upgrade", { before: baselineEntries, after: details.entries });
      // The two probes by the desktop are refused by the client (peer id, unknown name); the rest are the server's answers.
      check(baselineNegative.answers["alias-shaped-unknown-name"].error === "recipient_not_allowed" && baselineNegative.answers["exact-id-outside-grant"].error === "recipient_not_allowed", "unexpected answers to names the grant does not cover", baselineNegative.answers);
      check(baselineNegative.answers["unknown-principal"].error === "recipient_not_found" && baselineNegative.answers["bound-not-local-principal"].error === "route_unavailable", "unexpected answers to principals", baselineNegative.answers);
      return { negativeSet: baselineNegative.answers, counterDelta: baselineNegative.delta };
    });

    // ===================================================================================== C. H2: the supervisor restage
    let record1;
    await step("C1", "H2: stop the installed host, stage the candidate supervisor bundle over it, validate", async () => {
      await stopHost("old");
      const staged = await stageCandidate();
      record1 = staged.record;
      const m = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
      const old = JSON.parse(oldManifestBytes.toString("utf8"));
      const differing = Object.keys(m.artifacts).filter((rel) => m.artifacts[rel] !== old.artifacts[rel]).sort();
      check(same(differing, results.inputs.artifactDiff.changed), "the staged manifest differs from the installed one in other files than the diff", differing);
      check(m.nodeSHA256 === old.nodeSHA256 && m.version === 14, "node or version changed");
      check(fs.existsSync(oldBundle), "the installed bundle copy disappeared");
      results.inputs.candidateBundleId = staged.bundleId;
      return { candidateBundleId: staged.bundleId, installedBundleId: oldBundleId, differingArtifacts: differing.length, nodeUnchanged: true, rollbackRecordWritten: path.basename(record1) };
    });

    await step("C2", "candidate host on the same v2 registry and journal, no aliases: today's results, plus the additive fields", async () => {
      const started = await startHost("new");
      const block = await routerBlock();
      check(block.enabled === true && same(registrySummary({ registry: block.registry }), registrySummary({ registry: baselineBlock.registry })), "the registry block differs from the installed host's", { installed: baselineBlock.registry, candidate: block.registry });
      check(same(block.registry.addressForms, ["alias", "id", "principal"]), "addressForms is not [alias, id, principal]", block.registry);
      check(block.resolved.alias === 0 && block.errors.alias_unresolved === 0, "the additive counters are not zero", countersOf(block));
      const keys = (x) => Object.keys(x).sort();
      check(same(keys(block), keys(baselineBlock)) && same(keys(block.registry).filter((k) => k !== "addressForms"), keys(baselineBlock.registry)), "the block has other keys than the installed host's, apart from the additive ones", { installed: keys(baselineBlock), candidate: keys(block) });
      check(same(keys(block.resolved).filter((k) => k !== "alias"), keys(baselineBlock.resolved)) && same(keys(block.errors).filter((k) => k !== "alias_unresolved"), keys(baselineBlock.errors)), "the counter groups have other keys than the installed host's, apart from the additive ones");
      const negative = await runNegativeSet();
      check(same(negative.answers, baselineNegative.answers), "a negative probe is answered differently than by the installed host", { installed: baselineNegative.answers, candidate: negative.answers });
      check(same(negative.delta, baselineNegative.delta), "the counters moved differently than on the installed host", { installed: baselineNegative.delta, candidate: negative.delta });
      check(same(negative.deltaWithAdditive, negative.delta), "an additive counter moved");
      const details = await discover();
      check(same(strip(details.entries), baselineEntries), "discovery differs from the installed host's with no aliases", { installed: baselineEntries, candidate: details.entries });
      const a = await send(principals.alpha, "candidate principal send");
      const b = await send(ids.beta, "candidate exact send");
      check(a.code === 0 && reached(a, "alpha", "candidate principal send") && b.code === 0 && reached(b, "beta", "candidate exact send"), "sends failed on the candidate host", { a: a.json, b: b.json });
      const earlier = await messageStatus(baselineMessageId);
      check(earlier.code === 0 && earlier.json?.phase === "completed", "the message sent through the installed host is not readable, completed, through the candidate host", earlier);
      return { host: started, registryBlock: block.registry, negativeSet: negative.answers, sameAsInstalled: ["registry block", "negative-set answers", "counter deltas", "discovery entries"], earlierMessageReadable: true };
    });

    // ===================================================================================== D. H3: the client package
    await step("D1", "H3: the candidate package installed into a scratch home by its own installer; the installed triangle lists the alias commands", async () => {
      const archive = options["candidate-archive"];
      const installerScript = path.join(path.dirname(archive), `triangle-install-${results.inputs.candidate.version}.sh`);
      check(fs.existsSync(installerScript), `no installer script beside the archive: ${installerScript}`);
      pkgTestRoot = fs.mkdtempSync(path.join(tmp, "triangle-package-install-"));
      fs.chmodSync(pkgTestRoot, 0o700);
      fs.mkdirSync(path.join(pkgTestRoot, "home"), { mode: 0o700 });
      fs.chmodSync(path.join(pkgTestRoot, "home"), 0o700);
      const install = await run("/bin/bash", [installerScript, "--archive", archive, "--sha256", results.inputs.candidate.archiveSha256, "--test-root", pkgTestRoot], { env: { ...env, HOME: path.join(pkgTestRoot, "home") }, timeoutMs: 180000 });
      check(install.code === 0, `the package installer failed (${install.code}): ${(install.stderr || install.stdout).slice(0, 500)}`, install);
      const installedApp = path.join(pkgTestRoot, "home/Library/Application Support/The Triangle");
      const receipt = JSON.parse(fs.readFileSync(path.join(installedApp, "package-install.json"), "utf8"));
      const installed = lastJsonLine(install.stdout);
      pkgWrapper = installed?.cli;
      check(installed?.state === "installed" && installed.version === results.inputs.candidate.version, "the installer did not report the candidate as installed", installed);
      check(pkgWrapper === path.join(pkgTestRoot, "home/.local/bin/triangle") && fs.existsSync(pkgWrapper), "the installer left no triangle wrapper inside the scratch home", installed);
      check(receipt.version === results.inputs.candidate.version, "the ownership receipt names another version", receipt);
      check(fs.existsSync(path.join(installedApp, "releases", receipt.version, "packages/triangle-cli/src/identity-alias.mjs")), "the installed release lacks identity-alias.mjs");
      const help = await pkgCli(["--help"]);
      check(help.stdout.includes("identity alias set") && help.stdout.includes("identity alias clear"), "the installed triangle does not list the alias commands", help.stdout.slice(0, 400));
      return { installScope: receipt.installScope ?? null, receiptVersion: receipt.version, helpListsAliasCommands: true, installerExit: install.code };
    });

    // ===================================================================================== E. H4: aliases
    let aliasPlanOne;
    await step("E1", "alias set builder alpha, plan: ready, the supervisor honors aliases, nothing written", async () => {
      const before = { files: registryFiles(), listing: fs.readdirSync(registry).sort(), backups: backupListing() };
      const planned = await aliasPlan("set", "builder", "alpha");
      aliasPlanOne = planned.plan;
      check(planned.code === 0 && planned.plan?.ready === true && planned.plan.refusals.length === 0, "the plan is not ready", planned);
      check(planned.plan.target.principalId === principals.alpha && planned.plan.target.profile === "alpha" && planned.plan.registry.sequence === seq, "the plan names another target or sequence", planned.plan.target);
      check(planned.plan.advice.supervisor.state === "honored", "the plan does not say the running supervisor honors aliases", planned.plan.advice);
      const human = await pkgCli(aliasArgs("set", "builder", "alpha"));
      check(human.code === 0 && human.stdout.includes(`--confirm ${planned.plan.planId}`) && /The running supervisor resolves aliases/.test(human.stdout), "the human plan does not show the apply command and the supervisor's answer", human.stdout.slice(0, 800));
      check(same(registryFiles(), before.files) && same(fs.readdirSync(registry).sort(), before.listing) && same(backupListing(), before.backups), "planning wrote something");
      return { planId: planned.plan.planId, target: planned.plan.target, advice: planned.plan.advice, refusals: planned.plan.refusals, writesNothing: true };
    });

    await step("E2", "alias set builder alpha, apply in a terminal with the plan id: audit entry, alias record, status --identity row", async () => {
      const applied = await aliasApply("set", "builder", "alpha");
      check(applied.plan.planId === aliasPlanOne.planId, "the plan id changed between the plan and the apply although nothing moved", { planned: aliasPlanOne.planId, applied: applied.plan.planId });
      check(applied.result.principal === principals.alpha && applied.result.profile === "alpha" && applied.result.auditEntry === "alias_set", "unexpected result", applied.result);
      const json = registryJson();
      check(json.schema === V2 && json.sequence === seq && same(Object.keys(json.aliases), ["builder"]), "the registry does not hold exactly the one alias", json.aliases);
      check(json.aliases.builder.principal_id === principals.alpha && json.aliases.builder.generation === seq, "the alias record is not the principal at the committing sequence", json.aliases.builder);
      check(same(auditActions(), [...BASE_AUDIT, "upgrade", "alias_set"]), "audit log", auditActions());
      const read = lastJsonLine((await helper(oldBundle, ["read", registry])).stdout);
      check(read.ok && read.sequence === seq && same(Object.keys(read.aliases), ["builder"]), "the installed reader (hash chain included) does not read the registry with the alias", read);
      const view = await pkgCli(["status", "--identity", "--client-root", client, "--registry-root", registry]);
      check(view.code === 0 && /Registry:\s+ok · v2 · sequence \d+ · pairings 0 · aliases 1 /.test(view.stdout) && /active · builder → alpha · agent_/.test(view.stdout), "status --identity does not show the alias as active", view.stdout.slice(0, 1200));
      return { result: applied.result, aliasRecord: json.aliases.builder, auditActions: auditActions(), installedReaderReadsIt: true };
    });

    let entriesWithAlias;
    await step("E3", "discovery lists the alias for exactly alpha's entry; the other entries are unchanged", async () => {
      const block = await routerBlock();
      check(block.registry.sequence === seq && block.registry.state === "ok", "the running host did not pick up the new sequence", block.registry);
      const details = await discover();
      entriesWithAlias = strip(details.entries);
      const alpha = entriesWithAlias.find((e) => e.id === ids.alpha);
      check(same(alpha.send, { permitted: true, addressKinds: ["id", "principal"], aliases: ["builder"] }), "alpha's entry does not carry the alias", alpha);
      check(same(entriesWithAlias.filter((e) => e.id !== ids.alpha), baselineEntries.filter((e) => e.id !== ids.alpha)), "another entry changed", entriesWithAlias);
      // A client from before the restage (invariant 9): it keeps the entry's send explanation, drops the field it does not know,
      // and cannot send to the name, so an alias is never usable by code that predates it.
      const oldDiscover = await oldTl(["discover"]);
      const oldEntries = strip(parseJson(oldDiscover.stdout)?.entries ?? []);
      check(oldDiscover.code === 0 && same(oldEntries.find((e) => e.id === ids.alpha)?.send, { permitted: true, addressKinds: ["id", "principal"] }), "a client from before the restage does not keep the send explanation of the entry", { exit: oldDiscover.code, entries: oldEntries });
      const oldSend = await oldTl(["send", "--to", "builder", "--text", "from an old client", "--message-id", crypto.randomUUID(), "--request-id", crypto.randomUUID()]);
      const oldOutcome = parseJson(oldSend.stdout) ?? lastJsonLine(oldSend.stderr);
      check(oldSend.code === 1 && oldOutcome?.error === "recipient_not_allowed", "a client from before the restage can send to the alias", { exit: oldSend.code, out: oldOutcome });
      return { alphaSend: alpha.send, unchangedEntries: entriesWithAlias.length - 1, clientFromBeforeTheRestage: { sendExplanationKept: oldEntries.find((e) => e.id === ids.alpha).send, aliasField: "dropped", sendToTheName: oldOutcome.error } };
    });

    let honoredId;
    await step("E4", "the honored send: send --to builder reaches alpha's runner; receipt and status name the principal, never the alias", async () => {
      const before = await routerBlock();
      const r = await send("builder", "via alias", { messageId: "ad3-alias-1", requestId: "ad3-alias-1-r" });
      honoredId = r.messageId;
      check(r.code === 0 && r.json?.admission?.accepted === true && reached(r, "alpha", "via alias"), "the alias send did not reach alpha's runner", r);
      check(same(target(r), { via: "principal", principal: principals.alpha, profile: "alpha" }), "the receipt's target is not alpha's principal", target(r));
      const looked = await messageStatus(r.messageId);
      check(looked.code === 0 && looked.json?.phase === "completed" && same(looked.json.target, { via: "principal", principal: principals.alpha, profile: "alpha" }), "the status lookup differs", looked);
      for (const [what, text] of [["the admission", JSON.stringify(r.json)], ["the status lookup", JSON.stringify(looked.json)]]) check(!text.includes("builder"), `${what} carries the alias name`, text.slice(0, 300));
      const after = await routerBlock();
      check(same(counterDelta(before, after, { withAdditive: true }), { resolved: { alias: 1 }, errors: {} }), "the counters did not move by exactly one resolved alias", counterDelta(before, after, { withAdditive: true }));
      const p = await send(principals.beta, "principal after alias");
      const e = await send(ids["scratch-b"], "exact after alias");
      check(reached(p, "beta", "principal after alias") && reached(e, "scratch-b", "exact after alias"), "principal and exact sends changed", { p: p.json, e: e.json });
      return { target: target(r), replyFromRunner: "echo[alpha]", counterDelta: counterDelta(before, after, { withAdditive: true }), aliasNameInReceipt: false };
    });

    await step("E5", "retry across clear and set: duplicates by alias and by principal, a changed principal, a cleared alias, the same principal again", async () => {
      const m = { messageId: honoredId, requestId: "ad3-alias-1-r" };
      // (a) the same intent, by the alias and by the principal; another form of the same recipient is a changed intent as ever
      const byAlias = await send("builder", "via alias", m);
      const byPrincipal = await send(principals.alpha, "via alias", m);
      check(byAlias.code === 0 && byAlias.json.admission.isDuplicate === true && byPrincipal.code === 0 && byPrincipal.json.admission.isDuplicate === true, "a retry by the alias or by the principal is not a duplicate", { byAlias: byAlias.json, byPrincipal: byPrincipal.json });
      const byExact = await send(ids.alpha, "via alias", m);
      check(byExact.code === 1 && byExact.json?.error === "duplicate_id_conflict", "a retry by exact id is not a changed intent", byExact.json);
      // (b) the visible alias of another principal, sent by Grok: a duplicate, then refused after the owner clears the alias
      await aliasApply("set", "reviewer", "beta");
      const g1 = await grokSend("reviewer", "grok via reviewer", { messageId: "ad3-grok-1", requestId: "ad3-grok-1-r" });
      check(g1.code === 0 && g1.json?.accepted === true && same(g1.json.target, { via: "principal", principal: principals.beta, profile: "beta" }), "Grok could not use the alias of a recipient it may message", g1);
      const replies = await grokReply("ad3-grok-1-r");
      check(replies.some((x) => x.text === "echo[beta]: grok via reviewer"), "the Grok send did not reach beta's runner", replies);
      const g2 = await grokSend("reviewer", "grok via reviewer", { messageId: "ad3-grok-1", requestId: "ad3-grok-1-r" });
      check(g2.code === 0 && g2.json?.isDuplicate === true, "a retry of the Grok send is not a duplicate", g2);
      await aliasApply("clear", "reviewer");
      const g3 = await grokSend("reviewer", "grok via reviewer", { messageId: "ad3-grok-1", requestId: "ad3-grok-1-r" });
      check(g3.code === 1 && g3.json?.state === "rejected" && g3.json?.error === "recipient_not_allowed", "a retry after the alias was cleared is not refused as an unknown name", g3);
      const looked = await grokStatus("ad3-grok-1");
      check(looked.code === 0 && looked.json?.messageId === "ad3-grok-1", "the original send cannot be asked about after the clear", looked);
      // (c) clear and set to another principal: a changed intent; the same principal again: a duplicate
      await aliasApply("clear", "builder");
      await aliasApply("set", "builder", "beta");
      const changed = await send("builder", "via alias", m);
      check(changed.code === 1 && changed.json?.error === "duplicate_id_conflict", "a retry under an alias that now names another principal is not refused as a changed intent", changed.json);
      await aliasApply("clear", "builder");
      await aliasApply("set", "builder", "alpha");
      const again = await send("builder", "via alias", m);
      check(again.code === 0 && again.json.admission.isDuplicate === true && same(target(again), { via: "principal", principal: principals.alpha, profile: "alpha" }), "a retry under the re-created alias of the same principal is not a duplicate", again.json);
      return {
        duplicateByAlias: true,
        duplicateByPrincipal: true,
        byExactId: outcome(byExact),
        grokVisibleAlias: { accepted: true, reachedRunner: "echo[beta]", retry: "duplicate", afterClear: outcome(g3), originalStillAskable: true },
        changedPrincipal: outcome(changed),
        samePrincipalAgain: "duplicate",
        registrySequence: seq,
        auditActions: auditActions(),
      };
    });
    await step("E6", "a sender without permission: the alias of a recipient it may not message is an unknown name, by code, text, counters and record", async () => {
      // builder -> alpha, which the Grok principal may not message
      const beforeUnknown = await routerBlock();
      const unknown = await grokSend("nobody", "probe unknown", { count: false });
      const mid = await routerBlock();
      const invisible = await grokSend("builder", "probe invisible", { count: false });
      const afterInvisible = await routerBlock();
      check(unknown.code === 1 && same(outcome(unknown), outcome(invisible)) && invisible.json?.error === "recipient_not_allowed", "the invisible alias is answered differently from an unknown name", { unknown: unknown.json, invisible: invisible.json });
      check(same(counterDelta(beforeUnknown, mid, { withAdditive: true }), counterDelta(mid, afterInvisible, { withAdditive: true })) && same(counterDelta(mid, afterInvisible, { withAdditive: true }), { resolved: { id: 1 }, errors: {} }), "the counters differ between the unknown name and the invisible alias", { unknown: counterDelta(beforeUnknown, mid, { withAdditive: true }), invisible: counterDelta(mid, afterInvisible, { withAdditive: true }) });
      for (const r of [unknown, invisible]) {
        const looked = await messageStatus(r.messageId);
        check(looked.code !== 0 && /not_found/.test(looked.text), "a refused probe left a journal row", looked);
      }
      // the Grok principal's own discovery lists nothing of alpha, so the alias cannot be learned from it
      const sessions = await tl(["grok", "sessions", "--alias", GROK]);
      const text = sessions.stdout;
      check(sessions.code === 0 && !text.includes("builder") && !text.includes(ids.alpha) && text.includes(ids.beta), "the Grok principal's discovery names the alias or alpha", text.slice(0, 600));
      // control: the desktop sender sees the same alias and uses it
      const visible = await send("builder", "desktop sees it", { count: true });
      check(visible.code === 0 && reached(visible, "alpha", "desktop sees it"), "the desktop sender cannot use the alias", visible);
      return { unknownName: outcome(unknown), invisibleAlias: outcome(invisible), counterDeltaEach: { resolved: { id: 1 } }, journalRows: 0, grokDiscoveryNamesTheAlias: false, desktopCanUseIt: true };
    });

    await step("E7", "refusals at plan time, each exit 1 and nothing written: reserved names, look-alikes, bad names, labels, an existing alias, targets that cannot route", async () => {
      const files = registryFiles();
      const cases = [
        ["claude", "alpha", "alias_name_reserved"],
        ["agent_x", "alpha", "alias_name_reserved"],
        ["peer_x", "alpha", "alias_name_reserved"],
        ["session-x", "alpha", "alias_name_reserved"],
        ["bind_x", "alpha", "alias_name_reserved"],
        ["pair_x", "alpha", "alias_name_reserved"],
        ["Builder2", "alpha", "alias_name_invalid"],
        ["-x", "alpha", "alias_name_invalid"],
        ["a".repeat(33), "alpha", "alias_name_invalid"],
        ["scratch-b", "alpha", "alias_collides_with_label"],
        ["alpha", "beta", "alias_collides_with_label"],
        ["builder", "alpha", "alias_exists"],
        ["builder", "beta", "alias_exists"],
        ["fresh", "ghost", "alias_target_not_local"],
        ["fresh", "nobody", "alias_target_not_found"],
        ["fresh", `agent_${"1".repeat(32)}`, "alias_target_not_found"],
        ["fresh", "scratch-b", "alias_target_not_found"],
      ];
      const refused = {};
      for (const [name, tgt, code] of cases) {
        const r = await aliasPlan("set", name, tgt);
        check(r.code === 1 && r.plan?.ready === false && r.plan.refusals.includes(code), `alias set ${name} ${tgt} was not refused with ${code}`, { exit: r.code, plan: r.plan?.refusals, stderr: r.stderr });
        refused[`${name.length > 12 ? `${name.slice(0, 6)}…(${name.length})` : name} → ${tgt.startsWith("agent_") ? "agent_…" : tgt}`] = r.plan.refusals;
      }
      // The apply gate: a terminal on stdin and stdout, and the plan's own id.
      const okPlan = await aliasPlan("set", "fresh", "beta");
      check(okPlan.code === 0 && okPlan.plan?.ready === true, "a plain set plan is not ready", okPlan);
      const piped = await pkgCli([...aliasArgs("set", "fresh", "beta"), "--confirm", okPlan.plan.planId]);
      check(piped.code === 2 && /terminal/.test(piped.stderr), "apply without a terminal was not refused for lack of a terminal (exit 2)", { exit: piped.code, stderr: piped.stderr.slice(0, 300) });
      const wrongId = await pkgPty([...aliasArgs("set", "fresh", "beta"), "--confirm", "0".repeat(64)]);
      check(/pty-exit: 2\b/.test(wrongId.stderr) && wrongId.stdout.includes("plan_stale"), "apply with a wrong plan id was not refused as plan_stale (exit 2)", wrongId);
      const clearMissing = await aliasPlan("clear", "never-set");
      check(clearMissing.code === 1 && clearMissing.plan?.refusals.includes("alias_not_found"), "clearing an alias that does not exist was not refused", clearMissing);
      // a refused plan's id cannot be applied
      const planned = await aliasPlan("set", "claude", "alpha");
      const forced = await pkgPty([...aliasArgs("set", "claude", "alpha"), "--confirm", planned.plan.planId]);
      check(!/pty-exit: 0/.test(forced.stderr), "applying a refused plan succeeded", forced);
      check(same(registryFiles(), files), "a refused plan changed the registry");
      return { refusals: refused, clearOfMissingAlias: clearMissing.plan.refusals, applyOfRefusedPlan: forced.stderr.match(/pty-exit: (-?\d+)/)?.[1] ?? null, applyGate: { noTerminal: { exit: piped.code, message: piped.stderr.trim().slice(0, 160) }, wrongPlanId: { exit: wrongId.stderr.match(/pty-exit: (-?\d+)/)?.[1] ?? null, message: wrongId.stdout.trim().split("\n").slice(-1)[0].slice(0, 160) } }, registryUnchanged: true, cases: cases.length };
    });

    await step("E8", "a profile added after an alias of that name: the server refuses with alias_unresolved for a sender that can see both; status --identity says collides", async () => {
      await aliasApply("set", LATE, "beta");
      await stopHost("new");
      // the same call that built the client, with one more recipient (the registry is in place and is read, not changed)
      fs.writeFileSync(path.join(tmp, "spec2.json"), JSON.stringify({ clientRoot: client, stateRoot, registryRoot: registry, local: [...LOCAL, LATE], bound: BOUND }), { mode: 0o600 });
      const filesBefore = registryFiles();
      const prepared = lastJsonLine((await helper(currentBundle(), ["prepare", path.join(tmp, "spec2.json")])).stdout);
      check(prepared?.ok === true && prepared.registryWasInPlace === true && prepared.sequence === seq && same(registryFiles(), filesBefore), "adding the recipient changed the registry", prepared);
      await startHost("new");
      const before = await routerBlock();
      const collided = await grokSend(LATE, "grok to a colliding name", { count: false });
      const after = await routerBlock();
      check(collided.code === 1 && collided.json?.state === "rejected" && collided.json?.error === "alias_unresolved", "a sender that can see the alias and the profile is not told alias_unresolved", collided.json);
      check(same(counterDelta(before, after, { withAdditive: true }), { resolved: {}, errors: { alias_unresolved: 1 } }), "the counters did not record one alias_unresolved", counterDelta(before, after, { withAdditive: true }));
      check((await messageStatus(collided.messageId)).code !== 0, "the refused send left a journal row");
      // the owner CLI maps a profile name first, so the same word reaches the profile (the documented asymmetry)
      const viaCli = await send(LATE, "owner cli to the profile", { count: true });
      check(viaCli.code === 0 && reached(viaCli, LATE, "owner cli to the profile") && target(viaCli)?.via !== "principal", "the owner CLI did not reach the profile of that name", viaCli);
      const view = await pkgCli(["status", "--identity", "--client-root", client, "--registry-root", registry]);
      check(view.code === 0 && /collides · late → beta/.test(view.stdout) && /active · builder → alpha/.test(view.stdout), "status --identity does not show the collision", view.stdout.slice(0, 1400));
      const entries = strip((await discover()).entries);
      check(!entries.some((e) => e.id === ids[LATE] && e.send.aliases), "discovery lists an alias on the colliding profile's entry");
      const lateEntry = { id: ids[LATE], principal: null, principalState: "unbound", route: "local", send: { permitted: true, addressKinds: ["id"] } };
      expectedEntries = [...baselineEntries, lateEntry];
      check(same(withoutAliases(entries), expectedEntries), "discovery after adding the profile is not the baseline plus the new unbound entry", { entries });
      await aliasApply("clear", LATE);
      // Once the alias is cleared the word is only a profile name, which the Grok principal (unlike the owner CLI) does not map to an id.
      const cleared = await grokSend(LATE, "grok after the alias is gone", { count: false });
      check(cleared.code === 1 && cleared.json?.state === "rejected" && cleared.json?.error === "recipient_not_allowed", "the cleared name is not an unknown name to the Grok principal", cleared);
      const byId = await grokSend(ids[LATE], "grok by exact id", { count: true });
      check(byId.code === 0 && byId.json?.accepted === true, "the Grok principal cannot reach the new profile by its exact id", byId);
      return { grokAnswer: outcome(collided), counterDelta: { errors: { alias_unresolved: 1 } }, ownerCliReachedTheProfile: true, statusIdentityState: "collides", afterClear: { grokByName: outcome(cleared), grokByExactId: "accepted" } };
    });

    await step("E9", "the kill switch: with the router disabled nothing resolves, and the plan says so", async () => {
      const off = await tl(["setup-router", "--disable"]);
      check(off.code === 0, `setup-router --disable failed: ${off.stderr.slice(0, 300)}`, off);
      await stopHost("new");
      await startHost("new");
      const block = await routerBlock();
      check(block.enabled === false && !(block.registry?.addressForms ?? []).includes("alias"), "the disabled router still claims to resolve aliases", block);
      const g = await grokSend("builder", "router off", { count: false });
      const d = await send("builder", "router off", { wait: 0, count: false });
      check(g.code === 1 && g.json?.error === "recipient_not_allowed" && d.code === 1 && d.json?.error === "recipient_not_allowed", "an alias is resolved or answered differently with the router disabled", { g: g.json, d: d.json });
      const planned = await aliasPlan("set", "other", "beta");
      check(planned.plan?.advice?.supervisor?.state === "not_honored", "the plan does not warn that a disabled router honors no alias", planned.plan?.advice);
      const on = await tl(["setup-router", "--enable", "--registry-root", registry]);
      check(on.code === 0, `setup-router --enable failed: ${on.stderr.slice(0, 300)}`, on);
      await stopHost("new");
      await startHost("new");
      const back = await routerBlock();
      check(back.enabled === true && back.registry.addressForms.includes("alias"), "the router did not come back", back);
      const ok = await send("builder", "router on again", { wait: 5000 });
      check(ok.code === 0 && reached(ok, "alpha", "router on again"), "the alias does not work again after the router is enabled", ok);
      return { disabled: { routerEnabled: block.enabled, addressForms: block.registry?.addressForms ?? null, grok: outcome(g), ownerCli: outcome(d), planAdvice: planned.plan.advice.supervisor }, reEnabled: { addressForms: back.registry.addressForms } };
    });

    await step("E10", "a restart of the candidate host keeps the aliases: discovery, a send, the same registry sequence", async () => {
      await stopHost("new");
      const started = await startHost("new");
      const block = await routerBlock();
      check(block.registry.sequence === seq && block.registry.state === "ok" && block.registry.addressForms.includes("alias"), "the restarted host does not serve the registry with aliases", block.registry);
      const entries = strip((await discover()).entries);
      check(entries.find((e) => e.id === ids.alpha).send.aliases?.[0] === "builder", "discovery lost the alias over the restart", entries);
      const r = await send("builder", "after restart");
      check(r.code === 0 && reached(r, "alpha", "after restart"), "the alias does not work after the restart", r);
      return { host: started, registryBlock: block.registry, aliasesListed: ["builder"] };
    });

    // ===================================================================================== F. the installed bundle meets aliases
    let aliasesAtRollback;
    await step("F1", "H2 rolled back with the aliases in the registry: the installed supervisor ignores them and fails closed; nothing else changes", async () => {
      await aliasApply("set", "reviewer", "beta"); // an alias of a recipient the Grok principal may message, for the probes below
      aliasesAtRollback = Object.keys(registryJson().aliases).sort();
      check(same(aliasesAtRollback, ["builder", "reviewer"]), "unexpected aliases", aliasesAtRollback);
      check(aliasesAtRollback.length >= 1, "no alias is left to meet the installed supervisor");
      await stopHost("new");
      const rolled = await installer(["rollback-runtime", record1]);
      check(rolled.code === 0, `rollback-runtime failed: ${rolled.stderr.slice(0, 400)}`, rolled);
      check(Buffer.compare(fs.readFileSync(manifestPath()), oldManifestBytes) === 0, "manifest is not byte-identical to the installed one after rollback");
      check(!fs.existsSync(path.join(app, "worker-runtime/bundles", results.inputs.candidateBundleId)), "the candidate bundle the stage created was not removed");
      const started = await startHost("old");
      const block = await routerBlock();
      check(block.enabled === true && block.registry.state === "ok" && block.registry.schema === V2 && block.registry.sequence === seq && block.registry.addressForms === undefined, "the installed host does not serve the registry with aliases as before", block.registry);
      const read = lastJsonLine((await helper(oldBundle, ["read", registry])).stdout);
      check(read.ok && read.schema === V2 && same(Object.keys(read.aliases).sort(), aliasesAtRollback), "the installed reader does not read the registry with aliases", read);
      // sends by principal and exact id are untouched
      const p = await send(principals.beta, "installed host, aliases in the registry, principal");
      const e = await send(ids["scratch-b"], "installed host, aliases in the registry, exact");
      check(reached(p, "beta", "installed host, aliases in the registry, principal") && reached(e, "scratch-b", "installed host, aliases in the registry, exact"), "principal or exact sends changed", { p: p.json, e: e.json });
      // an alias is an unknown name, for the grant-limited sender and for the owner CLI, with the same answers as before aliases existed
      const entries = strip((await discover()).entries);
      check(same(entries, expectedEntries), "the installed supervisor's discovery shows an alias or changed with aliases in the registry", { expected: expectedEntries, entries });
      const before = await routerBlock();
      const g = await grokSend("reviewer", "installed host sees an alias", { count: false });
      const gs = await grokSend("builder", "installed host sees an alias", { count: false });
      const d = await send("builder", "installed host sees an alias", { wait: 0, count: false });
      const after = await routerBlock();
      check([g, gs, d].every((x) => x.code === 1 && x.json?.error === "recipient_not_allowed"), "an alias is answered with something other than recipient_not_allowed by the installed supervisor", { g: g.json, gs: gs.json, d: d.json });
      check(same(counterDelta(before, after), { resolved: { id: 2 }, errors: {} }), "the installed supervisor's counters moved unexpectedly", counterDelta(before, after));
      for (const x of [g, gs, d]) check((await messageStatus(x.messageId)).code !== 0, "a refused alias send left a journal row");
      // the same negative set as before aliases existed
      const negative = await runNegativeSet();
      check(same(negative.answers, baselineNegative.answers) && same(negative.delta, baselineNegative.delta), "the negative set differs with aliases in the registry", negative);
      return { host: started, manifestByteIdentical: true, candidateBundleRemoved: true, aliasesInRegistry: aliasesAtRollback, registryBlock: block.registry, aliasAnswers: { grokVisibleAliasOfBeta: outcome(g), grokInvisibleAlias: outcome(gs), ownerCli: outcome(d) }, counterDelta: { resolved: { id: 2 } }, discoveryHasNoAliases: true, negativeSetEqualsBaseline: true };
    });

    await step("F2", "the installed client package and writer next to a registry with aliases: they read it, show the count, plan nothing wrong, and a bind leaves the aliases alone", async () => {
      const files = registryFiles();
      const view = await instCliRun(["status", "--identity", "--client-root", client, "--registry-root", registry]);
      check(view.code === 0 && /Registry:\s+ok · v2 · sequence \d+ · pairings 0 · aliases \d+ /.test(view.stdout), "the installed status --identity does not read the registry with aliases", { exit: view.code, out: view.stdout.slice(0, 800), err: view.stderr.slice(0, 300) });
      const upgradePlan = await instCliRun(["identity", "upgrade-registry", "--client-root", client, "--json"]);
      const planJson = jsonOf(upgradePlan);
      check(planJson?.ready === false && planJson.refusals.includes("registry_already_v2"), "the installed upgrade plan on a v2 registry with aliases does not say registry_already_v2", planJson);
      check(same(registryFiles(), files), "reading changed the registry");
      // the installed bundle's writer, on a copy of the registry: a bind works, the aliases are left alone, the chain still reads
      const copy = path.join(app, "identity-copy");
      fs.cpSync(registry, copy, { recursive: true });
      fs.chmodSync(copy, 0o700);
      const bound = lastJsonLine((await helper(oldBundle, ["bind", copy, "gamma", String(seq)])).stdout);
      check(bound.ok === true, "the installed writer could not bind in a registry with aliases", bound);
      const after = lastJsonLine((await helper(currentBundle(), ["read", copy])).stdout);
      check(after.ok && after.sequence === seq + 1 && after.bindings === 4 && same(after.aliases, lastJsonLine((await helper(oldBundle, ["read", registry])).stdout).aliases), "the bind changed the aliases or did not add one binding", after);
      check(same(registryFiles(), files), "the probe on the copy changed the registry");
      return { installedStatusIdentity: view.stdout.split("\n").find((l) => l.startsWith("Registry:")) ?? null, installedUpgradePlan: planJson.refusals, installedBindOnACopy: "ok, aliases untouched, chain reads", sequenceAfterBind: after.sequence };
    });

    await step("F3", "the candidate CLI against the installed supervisor: the plan is ready with the warning that the alias will not be honored; set anyway, it is recorded and ignored", async () => {
      const planned = await aliasPlan("set", "other", "beta");
      check(planned.code === 0 && planned.plan?.ready === true, "the plan is not ready (the supervisor's answer is advice, never a floor)", planned);
      check(planned.plan.advice.supervisor.state === "not_honored" && planned.plan.advice.supervisor.reason === "address_forms_not_reported", "the plan does not say the running supervisor does not honor aliases", planned.plan.advice);
      const human = await pkgCli(aliasArgs("set", "other", "beta"));
      check(/does not resolve aliases \(address_forms_not_reported\)/.test(human.stdout) && /recorded but not honored/.test(human.stdout), "the human plan carries no warning", human.stdout.slice(0, 900));
      // The owner can still set it (the advice is never a floor): recorded, ignored, nothing breaks; honored once the supervisor is restaged (F4).
      await aliasApply("set", "other", "beta");
      const block = await routerBlock();
      check(block.registry.state === "ok" && block.registry.sequence === seq && block.registry.addressForms === undefined, "the running installed host did not take the new registry sequence in its stride", block.registry);
      const g = await grokSend("other", "recorded but not honored", { count: false });
      const after = await routerBlock();
      check(g.code === 1 && g.json?.error === "recipient_not_allowed" && same(counterDelta(block, after), { resolved: { id: 1 }, errors: {} }), "an alias set under the installed supervisor is not just an unknown name to it", { g: g.json, delta: counterDelta(block, after) });
      check((await messageStatus(g.messageId)).code !== 0, "the refused send left a journal row");
      const entries = strip((await discover()).entries);
      check(same(entries, expectedEntries), "discovery changed under the installed supervisor", entries);
      return { supervisorAdvice: planned.plan.advice.supervisor, warningInHumanPlan: true, setAnyway: { alias: "other", registrySequence: seq, runningInstalledHost: "keeps serving", senderAnswer: outcome(g), discoveryUnchanged: true } };
    });

    await step("F4", "H2 again: the candidate supervisor is restaged over the same registry and honors the aliases already there, with no registry change", async () => {
      await stopHost("old");
      const filesBefore = registryFiles();
      const staged = await stageCandidate();
      record1 = staged.record;
      check(staged.bundleId === results.inputs.candidateBundleId, "restaging produced a different bundle id", staged);
      const started = await startHost("new");
      const block = await routerBlock();
      check(block.registry.sequence === seq && block.registry.addressForms.includes("alias"), "the restaged host does not serve the registry", block.registry);
      const entries = strip((await discover()).entries);
      check(entries.find((e) => e.id === ids.alpha).send.aliases?.includes("builder"), "the restaged host does not list the alias", entries);
      const r = await send("builder", "after the restage");
      check(r.code === 0 && reached(r, "alpha", "after the restage") && same(target(r), { via: "principal", principal: principals.alpha, profile: "alpha" }), "the alias does not work after the restage", r);
      // the alias recorded under the installed supervisor (F3) is honored too, for the sender that may use it
      const o = await grokSend("other", "honored after the restage", { requestId: "ad3-grok-other-r" });
      check(o.code === 0 && o.json?.accepted === true && same(o.json.target, { via: "principal", principal: principals.beta, profile: "beta" }), "the alias recorded under the installed supervisor is not honored after the restage", o);
      check((await grokReply("ad3-grok-other-r")).some((x) => x.text === "echo[beta]: honored after the restage"), "the Grok send did not reach beta's runner");
      check(same(entries.find((e) => e.id === ids.beta).send.aliases, ["other", "reviewer"]), "discovery does not list both aliases of beta", entries);
      check(same(registryFiles(), filesBefore), "the restage changed the registry");
      const committed = await installer(["commit-runtime", staged.record]);
      check(committed.code === 0, `commit-runtime failed: ${committed.stderr.slice(0, 300)}`, committed);
      check(fs.readdirSync(path.join(app, "worker-runtime")).every((n) => !n.startsWith(".rollback-")), "a rollback record was left behind");
      return { host: started, sameBundleId: true, registryUnchanged: true, aliasesHonoredWithoutAnyRegistryChange: ["builder", "reviewer", "other"], committed: true };
    });

    // ===================================================================================== G. returning to the starting state
    await step("G1", "alias clear for every alias: the sender's view returns to the start (discovery, router block); the audit chain holds every set and clear", async () => {
      for (const name of Object.keys(registryJson().aliases).sort()) await aliasApply("clear", name);
      check(Object.keys(registryJson().aliases).length === 0, "an alias is left");
      const block = await routerBlock();
      check(block.registry.sequence === seq, "the host does not serve the latest sequence", block.registry);
      const entries = strip((await discover()).entries);
      check(same(entries, expectedEntries), "discovery is not what it was before the first alias", { expected: expectedEntries, now: entries });
      const sent = await send("builder", "after every alias is cleared", { wait: 0, count: false });
      check(sent.code === 1 && sent.json?.error === "recipient_not_allowed", "the name is still an alias", sent.json);
      const actions = auditActions();
      const read = lastJsonLine((await helper(currentBundle(), ["read", registry])).stdout);
      check(read.ok && read.sequence === seq && Object.keys(read.aliases).length === 0, "the chain does not read", read);
      const sets = actions.filter((a) => a === "alias_set").length;
      const clears = actions.filter((a) => a === "alias_clear").length;
      check(sets === clears && sets >= 5, "sets and clears do not balance", { sets, clears });
      return { aliasesLeft: 0, auditActions: actions, aliasSets: sets, aliasClears: clears, registrySequence: seq };
    });

    await step("G2", "the way back to the pre-D1 backup with an alias present: restore needs --discard-v2-data and counts the aliases; applied, the aliases go and sends still route", async () => {
      await aliasApply("set", "builder", "alpha");
      check(same(strip((await discover()).entries).find((e) => e.id === ids.alpha).send.aliases, ["builder"]), "control: the alias is not listed before the restore");
      const refusedPlan = await candCli(["identity", "restore-registry", "--client-root", client, "--from", backupDir, "--json"]);
      const refused = jsonOf(refusedPlan);
      check(refusedPlan.code === 1 && refused?.ready === false && refused.refusals.includes("restore_would_lose_v2_data"), "a restore that would lose an alias is not refused without the flag", { exit: refusedPlan.code, plan: refused?.refusals });
      const planRun = await candCli(["identity", "restore-registry", "--client-root", client, "--from", backupDir, "--discard-v2-data", "--json"]);
      const plan = jsonOf(planRun);
      check(planRun.code === 0 && plan?.ready === true && plan.live.v2Data.any === true, `the restore plan with the flag is not ready (exit ${planRun.code})`, { stdout: planRun.stdout.slice(0, 900), stderr: planRun.stderr.slice(0, 300) });
      const discardedActions = plan.discarded.map((d) => d.action);
      check(discardedActions.includes("alias_set") && discardedActions[0] === "upgrade", "the plan does not list the alias entries among the discarded ones", discardedActions);
      const text = JSON.stringify(plan);
      check(!text.includes(principals.alpha), "the plan names an alias's target", text.slice(0, 200));
      const applied = await candPty(["identity", "restore-registry", "--client-root", client, "--from", backupDir, "--discard-v2-data", "--confirm", plan.planId, "--json"]);
      check(/pty-exit: 0/.test(applied.stderr), `restore failed: ${applied.stdout.slice(0, 600)} ${applied.stderr.slice(0, 300)}`, applied);
      const json = registryJson();
      check(json.schema === V1 && json.aliases === undefined && sha256File(path.join(backupDir, "identity-registry-v1.json")) === registryFiles().registry, "the live registry is not the backup's v1 file", { schema: json.schema });
      const block = await routerBlock();
      check(block.registry.state === "ok" && block.registry.schema === V1, "the running candidate host did not recover to the restored v1 registry", block.registry);
      const a = await send(principals.beta, "after the restore");
      check(reached(a, "beta", "after the restore"), "a principal send fails after the restore", a);
      const entriesAfter = strip((await discover()).entries);
      check(same(entriesAfter, expectedEntries), "discovery still lists an alias after the registry went back to v1", entriesAfter);
      const sent = await send("builder", "alias after the restore", { wait: 0, count: false });
      check(sent.code === 1 && sent.json?.error === "recipient_not_allowed", "the alias still resolves after the registry went back to v1", sent.json);
      return { refusedWithoutFlag: refused.refusals, planWithFlag: { relation: plan.relation, discardedActions, v2Data: plan.live.v2Data }, appliedExit: 0, registryAfter: { schema: json.schema, sequence: json.sequence }, aliasAfterRestore: outcome(sent) };
    });

    await step("Z1", "the installed application root is exactly as it was (as far as it is compared)", async () => {
      const comparison = await compareLive();
      results.liveRoot = { identical: comparison.identical, compared: comparison.compared, differences: comparison.differences };
      check(comparison.identical, `installed root changed: ${comparison.differences.join(", ")}`, { before: comparison.before, after: comparison.after });
      const over = Object.entries(pairs).filter(([, n]) => n > 9);
      check(over.length === 0, "a sender-recipient pair came too close to the product's limit of 10 per 10 minutes", pairs);
      return { compared: comparison.compared, hashedFiles: Object.keys(liveBefore.files).length, identityEntriesCompared: Object.keys(liveBefore.identityEntries).length, backupEntriesCompared: Object.keys(liveBefore.backupEntries).length, baselineBundleEntries: liveBefore.baselineBundleTree.entries, processesCompared: liveBefore.processes.length, identical: true, acceptedSendsPerPair: pairs };
    });

    results.verdict = steps.every((s) => s.ok) ? "pass" : "fail";
  } catch (error) {
    results.verdict = "fail";
    results.failure = { step: current?.id ?? null, message: error.message };
  } finally {
    try {
      for (const label of [...hosts.keys()]) await stopHost(label);
    } catch (error) {
      results.cleanupError = String(error?.message ?? error);
    }
    // The comparison also runs when a step failed before Z1, which is exactly when it matters.
    if (liveBefore && !results.liveRoot) {
      try {
        const comparison = await compareLive();
        results.liveRoot = { identical: comparison.identical, compared: comparison.compared, differences: comparison.differences };
      } catch (error) {
        results.liveRoot = { identical: false, error: String(error?.message ?? error) };
      }
    }
    if (results.liveRoot && !results.liveRoot.identical) results.verdict = "fail";
    results.finishedAt = new Date().toISOString();
    fs.mkdirSync(options.out, { recursive: true });
    let text = JSON.stringify(results, null, 2) + "\n";
    if (base) text = text.split(base).join("<scratch>");
    fs.writeFileSync(path.join(options.out, "results.json"), text);
    if (base && !options.keep) fs.rmSync(base, { recursive: true, force: true });
    else if (base) process.stdout.write(`scratch root kept: ${base}\n`);
  }
  process.stdout.write(`\nverdict: ${results.verdict}  (${steps.filter((s) => s.ok).length}/${steps.length} steps)\n`);
  process.exitCode = results.verdict === "pass" ? 0 : 1;
  process.exit(process.exitCode);
}

main().catch((error) => {
  process.stderr.write(`rehearsal aborted: ${error.message}\n`);
  process.exit(2);
});
