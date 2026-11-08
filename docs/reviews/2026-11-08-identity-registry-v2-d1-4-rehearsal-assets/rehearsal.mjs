#!/usr/bin/env node
// D1.4 rehearsal driver: identity registry v1 -> v2 -> v1 on a scratch application root, with the INSTALLED supervisor
// bundle (copied byte for byte from the live application root, which is only read), a CANDIDATE client package built
// by scripts/release/build-client-package.mjs, and a supervisor bundle staged from that package by its own installer.
//
//   node rehearsal.mjs --candidate-archive FILE.tar.gz [--source-commit SHA] [--installed-app-root DIR] [--repo-root DIR]
//                       [--out DIR] [--keep]
//
// The package's installer script must sit beside the archive (as build-client-package.mjs leaves it).
//
// What it never does: write under the installed application root, open its journal or registry, use its credentials,
// signal its processes, or touch launchd. Every process it starts runs with HOME, TMPDIR and every path inside the
// scratch root and with a clean environment. It records the installed root's file fingerprints and process list before
// and after, and fails if they differ.
//
// Output: results.json next to this file (or --out) and a one-line verdict per step on stdout. Exit 0 only when every
// step passed.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const V1 = "identity_registry_v1";
const V2 = "identity_registry_v2";
const PROFILES = ["alpha", "beta"];

// ---------------------------------------------------------------------------------------------------------- helpers

function parseArgs(argv) {
  const options = { keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--keep") options.keep = true;
    else if (["--candidate-archive", "--installed-app-root", "--repo-root", "--out", "--source-commit"].includes(flag) && argv[i + 1]) options[flag.slice(2)] = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${flag}`);
  }
  if (!options["candidate-archive"]) throw new Error("--candidate-archive is required");
  options["installed-app-root"] = path.resolve(options["installed-app-root"] ?? path.join(os.homedir(), "Library/Application Support/The Triangle"));
  options["repo-root"] = path.resolve(options["repo-root"] ?? path.join(here, "../../.."));
  options.out = path.resolve(options.out ?? here);
  options["candidate-archive"] = path.resolve(options["candidate-archive"]);
  return options;
}

const sha256Buffer = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const sha256File = (file) => sha256Buffer(fs.readFileSync(file));
const sha256Text = (text) => sha256Buffer(Buffer.from(text, "utf8"));
const mode = (file) => fs.lstatSync(file).mode & 0o7777;
const octal = (value) => `0${value.toString(8)}`;

function run(command, args, { env, cwd, timeoutMs = 60000, label } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started, timedOut: killed, label: label ?? `${path.basename(command)} ${args[0] ?? ""}` });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: String(error), ms: Date.now() - started, timedOut: false, label });
    });
  });
}

const parseJson = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};
const jsonOf = (result) => parseJson(result.stdout) ?? lastJsonLine(result.stdout) ?? lastJsonLine(result.stderr);
const lastJsonLine = (text) => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const value = parseJson(lines[i]);
    if (value !== null) return value;
  }
  return null;
};

class CheckFailed extends Error {}
function check(condition, message, details) {
  if (!condition) {
    const error = new CheckFailed(message);
    error.details = details;
    throw error;
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------------------------------- live-root fingerprint

function briefStat(file) {
  try {
    const s = fs.lstatSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs, mode: octal(s.mode & 0o7777), ino: s.ino };
  } catch (error) {
    return { error: error.code ?? "error" };
  }
}

async function processList(live) {
  // The supervisor is launchd's `triangle-mailbox run-supervisor` wrapper and its child node process (the installed
  // bundle's node). Other processes of the installed system, such as `watch-poll` helpers and per-session MCP
  // children, come and go on their own, so they are not part of the comparison.
  const result = await run("/bin/ps", ["-axo", "pid=,ppid=,command="], { env: { PATH: "/usr/bin:/bin" } });
  const rows = result.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  const wrappers = rows.filter((r) => r.command.startsWith(`${live}/bin/triangle-mailbox run-supervisor`));
  const children = rows.filter((r) => wrappers.some((w) => w.pid === r.ppid) && r.command.startsWith(`${live}/worker-runtime/bundles/`));
  return [...wrappers, ...children].map((r) => `${r.pid} ${r.ppid} ${r.command.replace(/\s+/g, " ").slice(0, 200)}`).sort();
}

async function fingerprintLive(live, releaseVersion) {
  // Content hashes only for files that carry no secret; names and stat data for everything else.
  const hashed = [
    "worker-runtime/supervisor.manifest.json",
    "worker-runtime/codex.manifest.json",
    "worker-runtime/hermes.manifest.json",
    "worker-runtime/antigravity.manifest.json",
    "bin/triangle-local",
    "bin/triangle",
    "package-install.json",
    `releases/${releaseVersion}/package-manifest.json`,
  ];
  const files = {};
  for (const rel of hashed) {
    const file = path.join(live, rel);
    files[rel] = fs.existsSync(file) ? { sha256: sha256File(file), ...briefStat(file) } : { absent: true };
  }
  const listing = (rel) => (fs.existsSync(path.join(live, rel)) ? fs.readdirSync(path.join(live, rel)).sort() : null);
  const identity = {};
  for (const name of listing("identity") ?? []) identity[name] = briefStat(path.join(live, "identity", name));
  return {
    files,
    identityEntries: identity,
    bundles: listing("worker-runtime/bundles"),
    releases: listing("releases"),
    backupsDirectoryExists: fs.existsSync(path.join(live, "identity-backups")),
    processes: await processList(live),
  };
}

// ------------------------------------------------------------------------------------------------ the rehearsal

async function main() {
  const options = parseArgs(process.argv.slice(2));
  check(process.platform === "darwin", "this rehearsal needs macOS");
  check(Number(process.versions.node.split(".")[0]) >= 22, "this rehearsal needs Node 22 or later");
  const live = options["installed-app-root"];
  check(fs.existsSync(path.join(live, "worker-runtime/supervisor.manifest.json")), `no installed supervisor manifest under ${live}`);

  const results = {
    schema: "identity_registry_v2_d1_4_rehearsal_v1",
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

  // Scratch root: short, because a unix socket path may not exceed 100 bytes.
  const makeBase = () => {
    for (const parent of [fs.realpathSync(os.tmpdir()), "/private/tmp"]) {
      const candidate = fs.mkdtempSync(path.join(parent, "d14r-"));
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

  // ---- fixed layout, filled in by the first step
  let app, client, stateRoot, registry, home, tmp;
  let configPath, oldBundle, oldNode, oldManifestBytes, oldBundleId, instCli, cand, candNode, wrapperPath, backupsRoot;
  let env;
  let principals = {};
  let liveBefore;
  let releaseVersion;

  const tl = (args, opts = {}) => run(wrapperPath, [...args, "--config", configPath], { env, ...opts });
  const candCli = (args, opts = {}) => run(candNode, [path.join(cand, "packages/triangle-cli/src/cli.mjs"), ...args], { env, ...opts });
  const instCliRun = (args, opts = {}) => run(oldNode, [path.join(instCli, "packages/triangle-cli/src/cli.mjs"), ...args], { env, ...opts });
  const candPty = (args) => run("/usr/bin/python3", ["-I", path.join(here, "pty-run.py"), candNode, path.join(cand, "packages/triangle-cli/src/cli.mjs"), ...args], { env });
  const installer = (args, opts = {}) => run("/usr/bin/python3", [path.join(cand, "scripts/triangle-worker-install.py"), ...args], { env, ...opts });
  const helper = (bundle, args, opts = {}) => run(path.join(bundle, "bin/node"), [path.join(here, "host.mjs"), args[0], bundle, ...args.slice(1)], { env, ...opts });
  const manifestPath = () => path.join(app, "worker-runtime/supervisor.manifest.json");
  const currentBundle = () => JSON.parse(fs.readFileSync(manifestPath(), "utf8")).projectRoot;
  const registryFiles = () => ({
    registry: fs.existsSync(path.join(registry, "identity-registry-v1.json")) ? sha256File(path.join(registry, "identity-registry-v1.json")) : null,
    audit: fs.existsSync(path.join(registry, "registry-audit.jsonl")) ? sha256File(path.join(registry, "registry-audit.jsonl")) : null,
  });
  const backupListing = () => (fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot).sort() : []);

  const startHost = async (label) => {
    check(!hosts.has(label), `host ${label} is already running`);
    const bundle = currentBundle();
    const child = spawn(path.join(bundle, "bin/node"), [path.join(here, "host.mjs"), "run", bundle, configPath], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const ready = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new CheckFailed(`host ${label} did not become ready: ${stderr.slice(0, 500)}`)), 30000);
      child.stdout.on("data", (d) => {
        buffer += d;
        const line = buffer.split("\n").find((l) => l.includes('"ready"'));
        if (line) { clearTimeout(timer); resolve(parseJson(line)); }
      });
      child.on("close", (code) => { clearTimeout(timer); reject(new CheckFailed(`host ${label} exited early (${code}): ${stderr.slice(0, 500)}`)); });
    });
    hosts.set(label, { child, bundle });
    return { pid: ready.pid, bundleId: path.basename(bundle), node: ready.node };
  };
  const stopHost = async (label) => {
    const host = hosts.get(label);
    if (!host) return;
    hosts.delete(label);
    const closed = new Promise((resolve) => host.child.on("close", (code, signal) => resolve({ code, signal })));
    try { process.kill(host.child.pid, "SIGTERM"); } catch { /* gone */ }
    const timer = setTimeout(() => { try { process.kill(-host.child.pid, "SIGKILL"); } catch { /* gone */ } }, 10000);
    const result = await closed;
    clearTimeout(timer);
    return result;
  };

  const status = async () => {
    const result = await tl(["status"]);
    check(result.code === 0, `triangle-local status failed (${result.code}): ${result.stderr.slice(0, 300)}`, result);
    return parseJson(result.stdout);
  };
  const send = async (to, text) => {
    const id = crypto.randomUUID();
    const result = await tl(["send", "--to", to, "--text", text, "--message-id", id, "--request-id", crypto.randomUUID(), "--wait-ms", "5000"]);
    const json = parseJson(result.stdout) ?? lastJsonLine(result.stderr);
    return { code: result.code, json, stderr: result.stderr.trim().slice(0, 300), messageId: id };
  };

  try {
    // =========================================================================================== A. inputs
    await step("A1", "installed state: supervisor manifest, bundle and client package (read only)", async () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(live, "worker-runtime/supervisor.manifest.json"), "utf8"));
      oldBundleId = path.basename(manifest.projectRoot);
      const bundle = manifest.projectRoot;
      check(manifest.version === 14, `installed supervisor manifest is v${manifest.version}, not v14`);
      check(path.dirname(bundle) === path.join(live, "worker-runtime/bundles"), "installed projectRoot is not under the installed bundles directory");
      const install = JSON.parse(fs.readFileSync(path.join(live, "package-install.json"), "utf8"));
      releaseVersion = install.version;
      results.inputs.installed = {
        manifestVersion: manifest.version,
        bundleId: oldBundleId,
        artifacts: Object.keys(manifest.artifacts).length,
        nodeSHA256: manifest.nodeSHA256,
        manifestSha256: sha256File(path.join(live, "worker-runtime/supervisor.manifest.json")),
        clientPackageVersion: releaseVersion,
        triangleLocalSha256: sha256File(path.join(live, "bin/triangle-local")),
      };
      liveBefore = await fingerprintLive(live, releaseVersion);
      return { installed: results.inputs.installed, supervisorProcesses: liveBefore.processes.length };
    });

    base = makeBase();
    app = path.join(base, "a");
    client = path.join(app, "client");
    stateRoot = path.join(client, "l");
    registry = path.join(app, "identity");
    backupsRoot = path.join(app, "identity-backups");
    home = path.join(base, "home");
    tmp = path.join(base, "tmp");
    instCli = path.join(base, "inst-cli");
    cand = path.join(base, "cand");
    for (const dir of [app, client, home, tmp, path.join(app, "bin"), path.join(app, "worker-runtime"), path.join(app, "worker-runtime/bundles")]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const dir of [app, client, path.join(app, "bin"), path.join(app, "worker-runtime"), path.join(app, "worker-runtime/bundles")]) fs.chmodSync(dir, 0o700);
    configPath = path.join(client, "local-messaging.json");
    wrapperPath = path.join(app, "bin/triangle-local");
    env = { HOME: home, TMPDIR: tmp, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", USER: os.userInfo().username, LOGNAME: os.userInfo().username };
    results.scratch = { root: base, applicationRoot: app };

    await step("A2", "installed bundle copied to the scratch root, byte-checked against the live manifest", async () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(live, "worker-runtime/supervisor.manifest.json"), "utf8"));
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
      fs.writeFileSync(wrapperPath, wrapper.replace(constant, `TRIANGLE_LOCAL_APPLICATION_ROOT = ${JSON.stringify(app).replace(/"/g, "'")}`), { mode: 0o700 });
      fs.chmodSync(wrapperPath, 0o700);
      // The installed client package's CLI code (its own node is the bundle's: same hash).
      const release = path.join(live, "releases", releaseVersion);
      fs.cpSync(path.join(release, "packages"), path.join(instCli, "packages"), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
      privateDirs(instCli);
      const releaseNodeSha = sha256File(path.join(release, "bin/node"));
      return {
        artifactsVerified: Object.keys(manifest.artifacts).length,
        nodeSha256: manifest.nodeSHA256,
        clientPackageNodeEqualsBundleNode: releaseNodeSha === manifest.nodeSHA256,
        scratchModes: { app: octal(mode(app)), manifest: octal(mode(manifestPath())), node: octal(mode(oldNode)), wrapper: octal(mode(wrapperPath)) },
      };
    });

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
      // Tie the package to the commit: every packaged file that git tracks is the committed blob.
      const git = (args) => run("/usr/bin/git", ["-C", options["repo-root"], ...args], { env: { PATH: "/usr/bin:/bin", HOME: home } });
      const sourceRef = options["source-commit"] ?? "HEAD";
      const head = (await git(["rev-parse", `${sourceRef}^{commit}`])).stdout.trim();
      check(/^[0-9a-f]{40}$/.test(head), `cannot resolve ${sourceRef}`);
      const tracked = new Set((await git(["ls-tree", "-r", "-z", "--name-only", head])).stdout.split("\0").filter(Boolean));
      let compared = 0;
      for (const file of manifest.files) {
        if (!tracked.has(file.path)) continue;
        const blob = execFileSync("/usr/bin/git", ["-C", options["repo-root"], "show", `${head}:${file.path}`], { env: { PATH: "/usr/bin:/bin", HOME: home }, maxBuffer: 64 * 1024 * 1024 });
        check(sha256Buffer(blob) === file.sha256, `${file.path} differs from the committed blob`);
        compared += 1;
      }
      check(compared > 100, `only ${compared} packaged files are tracked sources; the comparison is too thin`);
      candNode = path.join(cand, "bin/node");
      const nodeSha = sha256File(candNode);
      check(nodeSha === results.inputs.installed.nodeSHA256, "candidate node differs from the installed bundle's node");
      check(fs.existsSync(path.join(cand, "packages/triangle-cli/src/identity-upgrade.mjs")), "candidate package lacks identity-upgrade.mjs");
      const sign = await run("/usr/bin/codesign", ["--verify", "--strict", path.join(cand, "bin/triangle-mailbox"), path.join(cand, "bin/triangle-client")], { env: { PATH: "/usr/bin:/bin" } });
      results.inputs.candidate = {
        commit: head,
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

    await step("A4", "supervisor artifact diff, installed bundle versus candidate package", async () => {
      const wa = JSON.parse(fs.readFileSync(path.join(cand, "worker-artifacts.json"), "utf8"));
      const installed = JSON.parse(fs.readFileSync(path.join(live, "worker-runtime/supervisor.manifest.json"), "utf8")).artifacts;
      const candidate = new Set(wa.kinds.supervisor);
      const changed = [];
      for (const rel of wa.kinds.supervisor) {
        if (installed[rel] !== undefined && sha256File(path.join(cand, rel)) !== installed[rel]) changed.push(rel);
      }
      const added = [...candidate].filter((rel) => installed[rel] === undefined);
      const removed = Object.keys(installed).filter((rel) => !candidate.has(rel));
      const workerOverlap = {};
      for (const kind of ["codex", "hermes", "antigravity"]) workerOverlap[kind] = changed.filter((rel) => wa.kinds[kind].includes(rel));
      results.inputs.artifactDiff = { manifestVersion: wa.version, supervisorArtifacts: wa.kinds.supervisor.length, changed, added, removed, changedFilesInWorkerBundles: workerOverlap };
      check(wa.version === 14, "candidate manifest version is not 14");
      check(added.length === 0 && removed.length === 0, "the supervisor artifact set changed (a manifest bump would be needed)");
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
      results.inputs.packageDiff = {
        installedVersion: releaseVersion,
        installedFiles: a.size,
        candidateFiles: b.size,
        added,
        removed,
        changed,
        unchanged: a.size - removed.length - changed.length,
      };
      return results.inputs.packageDiff;
    });

    // ===================================================================== B. baseline: installed supervisor, v1
    await step("B1", "scratch client, router and v1 registry built with the installed bundle's code", async () => {
      const result = await helper(oldBundle, ["prepare", client, stateRoot, registry, ...PROFILES]);
      const out = lastJsonLine(result.stdout);
      check(result.code === 0 && out?.ok, `prepare failed: ${result.stderr.slice(0, 400)}`, result);
      principals = out.principals;
      const read = lastJsonLine((await helper(oldBundle, ["read", registry])).stdout);
      check(read.ok && read.schema === V1 && read.sequence === 3 && read.bindings === 2, "registry is not v1 at sequence 3 with 2 bindings", read);
      return { registry: read, principals };
    });

    let baselineSend;
    await step("B2", "installed supervisor (copy) serves the v1 registry: status shape, principal and exact sends", async () => {
      const started = await startHost("old");
      const st = await status();
      check(st.router?.enabled === true && st.router.registry?.state === "ok" && st.router.registry.sequence === 3, "installed supervisor does not report registry ok at sequence 3", st.router);
      // The installed supervisor reports no schema information: this is what the floor refuses on.
      const keys = Object.keys(st.router.registry).sort();
      check(!keys.includes("supportedSchemas") && !keys.includes("rootSha256") && !keys.includes("schema"), "installed supervisor already reports schema fields", keys);
      const viaPrincipal = await send(principals.alpha, "baseline principal send");
      const viaProfile = await send("beta", "baseline exact send");
      check(viaPrincipal.code === 0, `principal send failed: ${viaPrincipal.stderr}`, viaPrincipal);
      check(viaProfile.code === 0, `exact send failed: ${viaProfile.stderr}`, viaProfile);
      baselineSend = { principal: viaPrincipal.json, exact: viaProfile.json, messageId: viaPrincipal.messageId };
      const principalText = JSON.stringify(viaPrincipal.json);
      check(principalText.includes("echo[alpha]: baseline principal send"), "principal send did not reach alpha's runner", viaPrincipal.json);
      check(JSON.stringify(viaProfile.json).includes("echo[beta]: baseline exact send"), "exact send did not reach beta's runner", viaProfile.json);
      return { host: started, registryBlock: st.router.registry, registryBlockKeys: keys, principalSend: { exit: viaPrincipal.code, reachedRunner: "alpha" }, exactSend: { exit: viaProfile.code, reachedRunner: "beta" } };
    });

    let preUpgradeFiles;
    await step("B3", "candidate CLI against the installed supervisor: the floor refuses and writes nothing", async () => {
      preUpgradeFiles = registryFiles();
      const plan = await candCli(["identity", "upgrade-registry", "--client-root", client, "--json"]);
      const json = jsonOf(plan);
      check(plan.code === 1 && json && json.ready === false, `expected a blocked plan (exit 1), got exit ${plan.code}`, { stdout: plan.stdout.slice(0, 600), stderr: plan.stderr.slice(0, 300) });
      check(json.refusals.includes("supervisor_cannot_read_v2"), "the plan does not refuse with supervisor_cannot_read_v2", json.refusals);
      const apply = await candPty(["identity", "upgrade-registry", "--client-root", client, "--confirm", json.planId]);
      check(!apply.stderr.includes("pty-exit: 0"), "applying a blocked plan must not succeed", apply);
      check(same(registryFiles(), preUpgradeFiles), "registry bytes changed");
      check(backupListing().length === 0 && !fs.existsSync(backupsRoot), "a backup directory was created");
      return { planRefusals: json.refusals, planExit: plan.code, applyExit: /pty-exit: (-?\d+)/.exec(apply.stderr)?.[1], applyMessage: apply.stdout.trim().split("\n").slice(-3).join(" | ").slice(0, 300), registryUnchanged: true, noBackupDirectory: true };
    });

    // ===================================================================================== C. G2: restage
    let record1;
    const findRecord = () => {
      const names = fs.readdirSync(path.join(app, "worker-runtime")).filter((n) => n.startsWith(".rollback-supervisor-"));
      check(names.length === 1, `expected exactly one rollback record, found ${names.length}`);
      return path.join(app, "worker-runtime", names[0]);
    };
    const stageCandidate = async () => {
      const staged = await installer(["stage-runtime", "--application-root", app, "--project-root", cand, "--agent", "supervisor", "--node", oldNode]);
      check(staged.code === 0, `stage-runtime failed: ${staged.stderr.slice(0, 400)}`, staged);
      const valid = await installer(["validate-runtime", "--manifest", manifestPath(), "--agent", "supervisor"]);
      check(valid.code === 0, `validate-runtime failed: ${valid.stderr.slice(0, 400)}`, valid);
      return { record: findRecord(), bundleId: path.basename(currentBundle()) };
    };

    await step("C1", "G2 transaction: stop installed host, stage candidate supervisor bundle, validate", async () => {
      await stopHost("old");
      const staged = await stageCandidate();
      record1 = staged.record;
      const m = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
      const old = JSON.parse(oldManifestBytes.toString("utf8"));
      const differing = Object.keys(m.artifacts).filter((rel) => m.artifacts[rel] !== old.artifacts[rel]).sort();
      check(same(differing, results.inputs.artifactDiff.changed.slice().sort()), "the staged manifest differs from the installed one in other files than the diff", differing);
      check(m.nodeSHA256 === old.nodeSHA256 && m.version === 14, "node or version changed");
      check(fs.existsSync(oldBundle), "the installed bundle copy disappeared");
      results.inputs.candidateBundleId = staged.bundleId;
      return { candidateBundleId: staged.bundleId, installedBundleId: oldBundleId, differingArtifacts: differing, nodeUnchanged: true, rollbackRecordWritten: path.basename(record1) };
    });

    await step("C2", "candidate host on the same v1 registry and journal: schema block, rootSha256, sends", async () => {
      const started = await startHost("new");
      const st = await status();
      const block = st.router.registry;
      check(block.state === "ok" && block.sequence === 3 && block.schema === V1, "candidate host does not report v1 ok at sequence 3", block);
      check(same(block.supportedSchemas, [V1, V2]), "supportedSchemas is not [v1, v2]", block);
      check(block.rootSha256 === sha256Text(registry), "rootSha256 is not the digest of the registry directory", block);
      const viaPrincipal = await send(principals.alpha, "candidate principal send");
      const viaProfile = await send("beta", "candidate exact send");
      check(viaPrincipal.code === 0 && JSON.stringify(viaPrincipal.json).includes("echo[alpha]: candidate principal send"), "principal send failed on the candidate host", viaPrincipal);
      check(viaProfile.code === 0 && JSON.stringify(viaProfile.json).includes("echo[beta]: candidate exact send"), "exact send failed on the candidate host", viaProfile);
      // Work sent through the installed host is still there: same journal.
      const earlier = await tl(["status", "--message-id", baselineSend.messageId]);
      return { host: started, registryBlock: block, principalSend: { exit: viaPrincipal.code }, exactSend: { exit: viaProfile.code }, journalSharedWithInstalledHost: earlier.code === 0 ? "earlier message still readable" : `earlier message lookup exit ${earlier.code}` };
    });

    await step("C3", "G2 rollback: restore the saved manifest, installed host serves again, then restage", async () => {
      await stopHost("new");
      const rolled = await installer(["rollback-runtime", record1]);
      check(rolled.code === 0, `rollback-runtime failed: ${rolled.stderr.slice(0, 400)}`, rolled);
      check(Buffer.compare(fs.readFileSync(manifestPath()), oldManifestBytes) === 0, "manifest is not byte-identical to the installed one after rollback");
      check(!fs.existsSync(path.join(app, "worker-runtime/bundles", results.inputs.candidateBundleId)), "the candidate bundle the stage created was not removed");
      const started = await startHost("old");
      const st = await status();
      check(st.router.registry.state === "ok" && st.router.registry.sequence === 3 && st.router.registry.supportedSchemas === undefined, "installed host does not behave as before", st.router.registry);
      const principalSend = await send(principals.alpha, "after rollback");
      check(principalSend.code === 0, "principal send failed after rollback", principalSend);
      await stopHost("old");
      const staged = await stageCandidate();
      record1 = staged.record;
      check(staged.bundleId === results.inputs.candidateBundleId, "restaging produced a different bundle id", staged);
      return { manifestByteIdentical: true, candidateBundleRemoved: true, installedHostAfterRollback: started, restagedBundleId: staged.bundleId, sameBundleId: true };
    });

    // ===================================================================================== D. G5: the upgrade
    let plan, backupDir, upgradeResult;
    await step("D1", "candidate host running: the floor passes and the plan is ready", async () => {
      await startHost("new");
      const planRun = await candCli(["identity", "upgrade-registry", "--client-root", client, "--json"]);
      plan = jsonOf(planRun);
      check(planRun.code === 0 && plan?.ready === true && plan.refusals.length === 0, `plan is not ready (exit ${planRun.code})`, { stdout: planRun.stdout.slice(0, 800), stderr: planRun.stderr.slice(0, 300) });
      check(plan.registry.schema === V1 && plan.registry.sequence === 3 && plan.registry.bindings === 2, "plan facts differ from the registry", plan.registry);
      check(!fs.existsSync(backupsRoot), "planning created the backup directory");
      check(same(registryFiles(), preUpgradeFiles), "planning changed the registry");
      const human = await candCli(["identity", "upgrade-registry", "--client-root", client]);
      check(human.stdout.includes(`--confirm ${plan.planId}`), "the human plan does not show the apply command");
      return { planId: plan.planId, floor: plan.floor, registry: plan.registry, refusals: plan.refusals };
    });

    await step("D1b", "router.json without registryRoot: the default registry directory is the one reported and planned", async () => {
      const routerFile = path.join(stateRoot, "router.json");
      const original = fs.readFileSync(routerFile);
      check(JSON.parse(original.toString("utf8")).registryRoot === registry, "precondition: router.json names the registry directory");
      try {
        fs.writeFileSync(routerFile, JSON.stringify({ version: 1, enabled: true }) + "\n");
        fs.chmodSync(routerFile, 0o600);
        const st = await status();
        check(st.router.registry.state === "ok" && st.router.registry.rootSha256 === sha256Text(registry), "the default registry directory is not the one reported", st.router.registry);
        const planRun = await candCli(["identity", "upgrade-registry", "--client-root", client, "--json"]);
        const planJson = jsonOf(planRun);
        check(planRun.code === 0 && planJson?.ready === true && planJson.refusals.length === 0, `the plan is not ready with the default registry directory (exit ${planRun.code})`, { stdout: planRun.stdout.slice(0, 600) });
        return { routerJson: "enabled, no registryRoot", reportedRootEqualsDefaultDirectory: true, planReady: true };
      } finally {
        fs.writeFileSync(routerFile, original);
        fs.chmodSync(routerFile, 0o600);
      }
    });

    await step("D2", "apply with the plan id in a terminal: backup, upgrade, audit entry", async () => {
      const before = registryFiles();
      const applied = await candPty(["identity", "upgrade-registry", "--client-root", client, "--confirm", plan.planId, "--json"]);
      check(/pty-exit: 0/.test(applied.stderr), `apply failed: ${applied.stdout.slice(0, 600)} ${applied.stderr.slice(0, 300)}`, applied);
      upgradeResult = parseJson(applied.stdout.trim());
      check(upgradeResult?.schema === "identity_registry_upgrade_result_v1" && upgradeResult.to.schema === V2 && upgradeResult.to.sequence === 4 && upgradeResult.auditEntry === "upgrade", "unexpected result", upgradeResult);
      backupDir = upgradeResult.backup.dir;
      check(path.dirname(backupDir) === backupsRoot, "backup is not under identity-backups beside the registry", backupDir);
      const names = fs.readdirSync(backupDir).sort();
      check(same(names, ["identity-registry-v1.json", "registry-audit.jsonl"]), "backup does not hold exactly the two registry files", names);
      check(sha256File(path.join(backupDir, "identity-registry-v1.json")) === before.registry && sha256File(path.join(backupDir, "registry-audit.jsonl")) === before.audit, "backup bytes differ from the pre-upgrade registry");
      check(octal(mode(backupDir)) === "0700" && names.every((n) => octal(mode(path.join(backupDir, n))) === "0600"), "backup modes are not 0700/0600");
      const live = lastJsonLine((await helper(currentBundle(), ["read", registry])).stdout);
      check(live.ok && live.schema === V2 && live.sequence === 4 && live.bindings === 2, "live registry is not v2 at sequence 4 with 2 bindings", live);
      const audit = fs.readFileSync(path.join(registry, "registry-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      check(audit.length === 4 && audit[3].action === "upgrade", "audit log does not end with the upgrade entry", audit.map((a) => a.action));
      return { result: { from: upgradeResult.from, to: upgradeResult.to, auditEntry: upgradeResult.auditEntry }, backupDirName: path.basename(backupDir), backupFiles: names, backupEqualsPreUpgradeBytes: true, auditActions: audit.map((a) => a.action) };
    });

    let postUpgradeFiles;
    await step("D3", "candidate host after the upgrade (no restart): v2 block, same principals, same routes", async () => {
      postUpgradeFiles = registryFiles();
      const st = await status();
      const block = st.router.registry;
      check(block.state === "ok" && block.schema === V2 && block.sequence === 4, "host does not report v2 ok at sequence 4", block);
      const a = await send(principals.alpha, "after upgrade principal");
      const b = await send(principals.beta, "after upgrade principal beta");
      const c = await send("alpha", "after upgrade exact");
      for (const [name, r, needle] of [["alpha by principal", a, "echo[alpha]: after upgrade principal"], ["beta by principal", b, "echo[beta]: after upgrade principal beta"], ["alpha exact", c, "echo[alpha]: after upgrade exact"]]) {
        check(r.code === 0 && JSON.stringify(r.json).includes(needle), `${name} failed after the upgrade`, r);
      }
      const again = await candCli(["identity", "upgrade-registry", "--client-root", client, "--json"]);
      const againJson = jsonOf(again);
      check(again.code === 0 && againJson?.ready === false && againJson.refusals.includes("registry_already_v2"), "a second plan is not 'already v2'", { exit: again.code, out: again.stdout.slice(0, 300) });
      return { registryBlock: block, sends: { alphaByPrincipal: "reached alpha", betaByPrincipal: "reached beta", alphaExact: "reached alpha" }, secondPlan: againJson.refusals };
    });

    await step("D4", "candidate host restarted on the v2 registry keeps serving", async () => {
      await stopHost("new");
      const started = await startHost("new");
      const st = await status();
      check(st.router.registry.state === "ok" && st.router.registry.schema === V2 && st.router.registry.sequence === 4, "restarted host does not serve v2", st.router.registry);
      const a = await send(principals.alpha, "after restart");
      check(a.code === 0 && JSON.stringify(a.json).includes("echo[alpha]: after restart"), "principal send failed after the restart", a);
      return { host: started, registryBlock: st.router.registry };
    });

    // ============================================================ E. the installed code meets a v2 registry
    await step("E1", "installed reader and writer (bundle copy) against the v2 registry: refuse, change nothing", async () => {
      const read = lastJsonLine((await helper(oldBundle, ["read", registry])).stdout);
      check(read.ok === false && typeof read.code === "string", "the installed reader accepted the v2 registry", read);
      const bind = lastJsonLine((await helper(oldBundle, ["bind", registry, "gamma", "4"])).stdout);
      check(bind.ok === false && typeof bind.code === "string", "the installed writer accepted a write on the v2 registry", bind);
      check(same(registryFiles(), postUpgradeFiles), "the registry changed under the installed writer");
      return { installedReader: read, installedWriterAttempt: bind, registryUnchanged: true };
    });

    await step("E2", "G2 rollback after the upgrade: installed host on v2 fails principals closed, exact ids keep routing", async () => {
      await stopHost("new");
      const rolled = await installer(["rollback-runtime", record1]);
      check(rolled.code === 0, `rollback-runtime failed: ${rolled.stderr.slice(0, 300)}`, rolled);
      check(Buffer.compare(fs.readFileSync(manifestPath()), oldManifestBytes) === 0, "manifest is not byte-identical after rollback");
      check(!fs.existsSync(path.join(app, "worker-runtime/bundles", results.inputs.candidateBundleId)), "the candidate bundle the stage created was not removed");
      const started = await startHost("old");
      const st = await status();
      const block = st.router?.registry ?? null;
      check(st.router?.enabled !== true || !block || block.state !== "ok", "the installed host reports the v2 registry as ok", st.router);
      const viaPrincipal = await send(principals.alpha, "installed host on v2, principal");
      check(viaPrincipal.code !== 0, "a principal send succeeded on the installed host against v2", viaPrincipal);
      const lookup = await tl(["status", "--message-id", viaPrincipal.messageId]);
      check(!JSON.stringify(viaPrincipal.json).includes("echo[alpha]"), "the refused principal send reached a runner", viaPrincipal);
      const viaProfile = await send("beta", "installed host on v2, exact");
      check(viaProfile.code === 0 && JSON.stringify(viaProfile.json).includes("echo[beta]: installed host on v2, exact"), "exact-id send did not keep working", viaProfile);
      const floor = await candCli(["identity", "upgrade-registry", "--client-root", client, "--json"]);
      const floorJson = jsonOf(floor);
      return {
        host: started,
        registryBlock: block,
        topLevelRouter: { enabled: st.router.enabled, error: st.router.error ?? null },
        principalSend: { exit: viaPrincipal.code, outcome: viaPrincipal.json, afterwards: { statusLookupExit: lookup.code, statusLookup: (lookup.stdout || lookup.stderr).trim().slice(0, 300) } },
        exactSend: { exit: viaProfile.code, reachedRunner: "beta" },
        planOnV2WithInstalledHost: { exit: floor.code, refusals: floorJson?.refusals ?? null },
      };
    });

    await step("E3", "installed client package CLI (0.2.0-identity.1 copy) against the v2 registry: refuses loudly, changes nothing", async () => {
      const migrate = await instCliRun(["identity", "migrate", "--client-root", client, "--registry-root", registry, "--json"]);
      const view = await instCliRun(["status", "--identity", "--client-root", client, "--registry-root", registry]);
      check(migrate.code !== 0, "installed `identity migrate` accepted the v2 registry", migrate);
      check(same(registryFiles(), postUpgradeFiles), "the registry changed under the installed CLI");
      return {
        migrate: { exit: migrate.code, stderrHead: migrate.stderr.trim().split("\n").slice(0, 6).map((l) => l.slice(0, 160)), stdoutHead: migrate.stdout.trim().slice(0, 200) },
        statusIdentity: { exit: view.code, message: (view.stderr || view.stdout).trim().split("\n").filter((l) => /registry|identity/i.test(l)).slice(0, 3).join(" | ").slice(0, 320) },
        registryUnchanged: true,
      };
    });

    // ================================================================================== F. the way back
    let restorePlan;
    await step("F1", "restore plan from the backup: relation, discarded entries, no routing change", async () => {
      const planRun = await candCli(["identity", "restore-registry", "--client-root", client, "--from", backupDir, "--json"]);
      restorePlan = jsonOf(planRun);
      check(planRun.code === 0 && restorePlan?.ready === true, `restore plan is not ready (exit ${planRun.code})`, { stdout: planRun.stdout.slice(0, 900), stderr: planRun.stderr.slice(0, 300) });
      return { plan: restorePlan };
    });

    await step("F2", "apply the restore in a terminal: live files equal the backup, v2 pair archived", async () => {
      const applied = await candPty(["identity", "restore-registry", "--client-root", client, "--from", backupDir, "--confirm", restorePlan.planId, "--json"]);
      check(/pty-exit: 0/.test(applied.stderr), `restore failed: ${applied.stdout.slice(0, 600)} ${applied.stderr.slice(0, 300)}`, applied);
      const result = parseJson(applied.stdout.trim());
      check(sha256File(path.join(registry, "identity-registry-v1.json")) === preUpgradeFiles.registry && sha256File(path.join(registry, "registry-audit.jsonl")) === preUpgradeFiles.audit, "live registry bytes are not the pre-upgrade bytes");
      const archives = backupListing().filter((n) => n.startsWith("before-restore-"));
      check(archives.length === 1, "expected exactly one before-restore archive", backupListing());
      const archived = fs.readdirSync(path.join(backupsRoot, archives[0])).sort();
      check(sha256File(path.join(backupsRoot, archives[0], "identity-registry-v1.json")) === postUpgradeFiles.registry, "the archived pair is not the v2 pair");
      return { result: result && { schema: result.schema, from: result.from, to: result.to }, archive: archives[0], archivedFiles: archived, liveEqualsBackupBytes: true, archiveEqualsV2Pair: true };
    });

    await step("F3", "installed host (no restart) reads the restored v1 registry again; principals route; restart keeps it", async () => {
      const st = await status();
      check(st.router.registry.state === "ok" && st.router.registry.sequence === 3, "installed host did not recover without restart", st.router.registry);
      const a = await send(principals.alpha, "after restore principal");
      check(a.code === 0 && JSON.stringify(a.json).includes("echo[alpha]: after restore principal"), "principal send failed after the restore", a);
      await stopHost("old");
      const started = await startHost("old");
      const again = await status();
      check(again.router.registry.state === "ok" && again.router.registry.sequence === 3, "restarted installed host does not serve the restored registry", again.router.registry);
      const b = await send(principals.beta, "after restore and restart");
      check(b.code === 0 && JSON.stringify(b.json).includes("echo[beta]: after restore and restart"), "principal send failed after restart", b);
      return { recoveredWithoutRestart: st.router.registry, afterRestart: { host: started, registryBlock: again.router.registry }, principalSends: "alpha and beta reached their runners" };
    });

    // ====================================== E4/F4: the installed host is RUNNING when the registry flips behind its back
    await step("E4", "installed host running when a v2 write lands without the floor: principals fail closed, same process keeps answering", async () => {
      const before = await status();
      check(before.router.registry.state === "ok" && before.router.registry.sequence === 3, "precondition: the installed host serves v1 at sequence 3", before.router.registry);
      const forced = lastJsonLine((await helper(cand, ["force-upgrade", registry])).stdout);
      check(forced?.ok === true && forced.schema === V2 && forced.sequence === 4, "the forced upgrade did not apply", forced);
      const st = await status();
      const block = st.router?.registry ?? null;
      check(st.router?.enabled !== true || !block || block.state !== "ok", "the running installed host still reports the registry as ok", st.router);
      const principal = await send(principals.alpha, "running installed host, v2 flip");
      check(principal.code !== 0 && !JSON.stringify(principal.json).includes("echo[alpha]"), "a principal send was delivered by the installed host on v2", principal);
      const exact = await send("beta", "running installed host, exact after flip");
      check(exact.code === 0 && JSON.stringify(exact.json).includes("echo[beta]: running installed host, exact after flip"), "exact-id send stopped working", exact);
      return { forcedWrite: forced, registryBlock: block, principalSend: { exit: principal.code, outcome: principal.json }, exactSend: { exit: exact.code, reachedRunner: "beta" } };
    });

    await step("F4", "restore from the backup: the running installed host recovers without a restart", async () => {
      const planRun = await candCli(["identity", "restore-registry", "--client-root", client, "--from", backupDir, "--json"]);
      const planJson = jsonOf(planRun);
      check(planRun.code === 0 && planJson?.ready === true, `restore plan is not ready (exit ${planRun.code})`, { stdout: planRun.stdout.slice(0, 900), stderr: planRun.stderr.slice(0, 300) });
      const applied = await candPty(["identity", "restore-registry", "--client-root", client, "--from", backupDir, "--confirm", planJson.planId, "--json"]);
      check(/pty-exit: 0/.test(applied.stderr), `restore failed: ${applied.stdout.slice(0, 600)} ${applied.stderr.slice(0, 300)}`, applied);
      check(sha256File(path.join(registry, "identity-registry-v1.json")) === preUpgradeFiles.registry && sha256File(path.join(registry, "registry-audit.jsonl")) === preUpgradeFiles.audit, "live registry bytes are not the pre-upgrade bytes");
      const st = await status();
      check(st.router.registry.state === "ok" && st.router.registry.sequence === 3, "the running installed host did not recover", st.router.registry);
      const a = await send(principals.alpha, "after the second restore");
      check(a.code === 0 && JSON.stringify(a.json).includes("echo[alpha]: after the second restore"), "principal send failed after the second restore", a);
      return { relation: planJson.relation ?? null, recoveredWithoutRestart: st.router.registry, principalSend: "reached alpha", archives: backupListing() };
    });

    // ===================================================================== G. client package wrapper, negatives
    await step("G1", "G3 variant: wrapper installed by the candidate installer; restaged host; plan still passes the floor", async () => {
      await stopHost("old");
      const wrapperInstall = await installer(["install-local-wrapper", "--application-root", app]);
      check(wrapperInstall.code === 0, `install-local-wrapper failed: ${wrapperInstall.stderr.slice(0, 300)}`, wrapperInstall);
      // The earlier rollback record was consumed by the rollback in E2; this is a fresh, committed install.
      const staged = await stageCandidate();
      const committed = await installer(["commit-runtime", staged.record]);
      check(committed.code === 0, `commit-runtime failed: ${committed.stderr.slice(0, 300)}`, committed);
      check(fs.readdirSync(path.join(app, "worker-runtime")).every((n) => !n.startsWith(".rollback-")), "a rollback record was left behind");
      const started = await startHost("new");
      const planRun = await candCli(["identity", "upgrade-registry", "--client-root", client, "--json"]);
      const planJson = jsonOf(planRun);
      check(planRun.code === 0 && planJson?.ready === true, "plan is not ready with the candidate wrapper", { out: planRun.stdout.slice(0, 600) });
      return { wrapperSha256: sha256File(wrapperPath), host: started, planReady: true, floor: planJson.floor };
    });

    await step("G2", "negatives: no terminal, another registry directory, a plan id that is not the plan's", async () => {
      const planRun = await candCli(["identity", "upgrade-registry", "--client-root", client, "--json"]);
      const planJson = jsonOf(planRun);
      const before = { files: registryFiles(), backups: backupListing() };
      const piped = await candCli(["identity", "upgrade-registry", "--client-root", client, "--confirm", planJson.planId]);
      check(piped.code !== 0, "apply without a terminal succeeded", piped);
      const wrongId = await candPty(["identity", "upgrade-registry", "--client-root", client, "--confirm", "0".repeat(64)]);
      check(!/pty-exit: 0/.test(wrongId.stderr), "apply with a wrong plan id succeeded", wrongId);
      // A second v1 registry directory in the same application root, which the running supervisor does not read.
      const other = path.join(app, "identity-other");
      fs.cpSync(registry, other, { recursive: true });
      fs.chmodSync(other, 0o700);
      const otherPlan = await candCli(["identity", "upgrade-registry", "--client-root", client, "--registry-root", other, "--json"]);
      const otherJson = jsonOf(otherPlan);
      check(otherPlan.code === 1 && same(otherJson?.refusals, ["supervisor_reads_another_registry"]), "another registry directory is not refused for exactly that reason", { out: otherPlan.stdout.slice(0, 500) });
      check(same(registryFiles(), before.files) && same(backupListing(), before.backups), "a negative probe changed the registry or the backups");
      return {
        noTerminal: { exit: piped.code, message: piped.stderr.trim().slice(0, 200) },
        wrongPlanId: { exit: /pty-exit: (-?\d+)/.exec(wrongId.stderr)?.[1], message: wrongId.stdout.trim().split("\n").slice(-1)[0].slice(0, 200) },
        anotherRegistryDirectory: { exit: otherPlan.code, refusals: otherJson.refusals },
        nothingChanged: true,
      };
    });

    await step("G3", "G3 variant: the candidate package installed into a scratch home by its own installer; the installed triangle runs the plan", async () => {
      const archive = options["candidate-archive"];
      const installerScript = path.join(path.dirname(archive), `triangle-install-${results.inputs.candidate.version}.sh`);
      check(fs.existsSync(installerScript), `no installer script beside the archive: ${installerScript}`);
      const testRoot = fs.mkdtempSync(path.join(tmp, "triangle-package-install-"));
      fs.chmodSync(testRoot, 0o700);
      fs.mkdirSync(path.join(testRoot, "home"), { mode: 0o700 });
      fs.chmodSync(path.join(testRoot, "home"), 0o700);
      try {
        const install = await run("/bin/bash", [installerScript, "--archive", archive, "--sha256", results.inputs.candidate.archiveSha256, "--test-root", testRoot], { env: { ...env, TMPDIR: tmp, HOME: path.join(testRoot, "home") }, timeoutMs: 180000 });
        check(install.code === 0, `the package installer failed (${install.code}): ${(install.stderr || install.stdout).slice(0, 500)}`, install);
        const installedApp = path.join(testRoot, "home/Library/Application Support/The Triangle");
        const receipt = JSON.parse(fs.readFileSync(path.join(installedApp, "package-install.json"), "utf8"));
        const installed = lastJsonLine(install.stdout);
        const wrapper = installed?.cli;
        check(installed?.state === "installed" && installed.version === results.inputs.candidate.version, "the installer did not report the candidate as installed", installed);
        check(wrapper === path.join(testRoot, "home/.local/bin/triangle") && fs.existsSync(wrapper), "the installer left no triangle wrapper inside the scratch home", installed);
        check(receipt.version === results.inputs.candidate.version, "the ownership receipt names another version", receipt);
        check(fs.existsSync(path.join(installedApp, "releases", receipt.version, "packages/triangle-cli/src/identity-upgrade.mjs")), "the installed release lacks identity-upgrade.mjs");
        const planRun = await run(wrapper, ["identity", "upgrade-registry", "--client-root", client, "--json"], { env });
        const planJson = jsonOf(planRun);
        check(planRun.code === 0 && planJson?.ready === true && planJson.refusals.length === 0, `the installed triangle's plan is not ready (exit ${planRun.code})`, { stdout: planRun.stdout.slice(0, 600), stderr: planRun.stderr.slice(0, 300) });
        const help = await run(wrapper, ["--help"], { env });
        check(help.stdout.includes("identity upgrade-registry") && help.stdout.includes("identity restore-registry"), "the installed triangle does not list the new commands");
        return { installScope: receipt.installScope ?? null, receiptVersion: receipt.version, installedWrapperPlan: { exit: planRun.code, ready: planJson.ready, planId: planJson.planId }, helpListsNewCommands: true, installerExit: install.code };
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    });

    await step("H1", "the installed application root is exactly as it was", async () => {
      const after = await fingerprintLive(live, releaseVersion);
      const strip = (x) => JSON.parse(JSON.stringify(x));
      const diffs = [];
      for (const key of Object.keys(liveBefore)) if (!same(strip(liveBefore[key]), strip(after[key]))) diffs.push(key);
      check(diffs.length === 0, `installed root changed: ${diffs.join(", ")}`, { before: strip(liveBefore), after: strip(after) });
      return { compared: Object.keys(liveBefore), hashedFiles: Object.keys(liveBefore.files).length, identityEntriesCompared: Object.keys(liveBefore.identityEntries).length, processesCompared: liveBefore.processes.length, identical: true };
    });

    results.verdict = steps.every((s) => s.ok) ? "pass" : "fail";
  } catch (error) {
    results.verdict = "fail";
    results.failure = { step: current?.id ?? null, message: error.message };
  } finally {
    for (const label of [...hosts.keys()]) await stopHost(label);
    results.finishedAt = new Date().toISOString();
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, "results.json"), JSON.stringify(results, null, 2) + "\n");
    if (base && !options.keep) fs.rmSync(base, { recursive: true, force: true });
    else if (base) process.stdout.write(`scratch root kept: ${base}\n`);
  }
  process.stdout.write(`\nverdict: ${results.verdict}  (${steps.filter((s) => s.ok).length}/${steps.length} steps)\n`);
  process.exit(results.verdict === "pass" ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`rehearsal aborted: ${error.message}\n`);
  process.exit(2);
});
