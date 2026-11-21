#!/usr/bin/env node
// Restage prep rehearsal driver (`06e0bd2` bundle `009977d1...` -> `fd753b9` candidate).
// Exercises Gate S (supervisor-only restage, #184 host fix, #185 reply-id fix, #183 M1-M3) and
// Gate P (stale receipt fail-closed + reconciliation, scratch package install, M5 CLI) in an
// isolated /private/tmp root, leaving the installed system untouched (verified by Z1).
//
//   node rehearsal-restage.mjs --candidate-archive FILE.tar.gz --source-commit SHA
//                              [--installed-source-commit SHA] [--installed-app-root DIR]
//                              [--repo-root DIR] [--baseline-manifest FILE] [--out DIR] [--keep]
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CheckFailed,
  check,
  fingerprintLive,
  jsonOf,
  killRunningChildren,
  lastJsonLine,
  mode,
  octal,
  parseJson,
  run,
  same,
  sha256Buffer,
  sha256File,
  sha256Text,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXPECT_MANIFEST_VERSION = 15;
const EXPECTED_SUPERVISOR_DIFF = [
  "packages/agent-worker/src/client-supervisor-cli.mjs",
  "packages/agent-worker/src/grok-local-session.mjs",
  "packages/agent-worker/src/local-chat-mapping.mjs",
  "packages/agent-worker/src/local-messaging-dispatcher.mjs",
  "packages/agent-worker/src/local-messaging-host.mjs",
  "packages/agent-worker/src/local-messaging-interactive-session.mjs",
  "packages/agent-worker/src/local-messaging-journal-contract.mjs",
  "packages/agent-worker/src/local-messaging-journal.mjs",
  "packages/agent-worker/src/local-messaging-server.mjs",
  "packages/agent-worker/src/local-messaging-supervisor-seam.mjs",
  "packages/agent-worker/src/local-sender-authentication.mjs",
  "packages/agent-worker/src/unified-router.mjs",
];
const GROK_ALIAS = "restricted";

function parseArgs(argv) {
  const options = { keep: false };
  const withValue = [
    "candidate-archive",
    "installed-app-root",
    "repo-root",
    "out",
    "source-commit",
    "installed-source-commit",
    "baseline-manifest",
  ];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--keep") options.keep = true;
    else if (withValue.includes(flag.slice(2)) && argv[i + 1]) options[flag.slice(2)] = argv[++i];
    else {
      process.stderr.write(`usage: ${path.basename(fileURLToPath(import.meta.url))} --candidate-archive FILE --source-commit SHA [options]\n`);
      process.exit(64);
    }
  }
  if (!options["candidate-archive"] || !options["source-commit"]) {
    process.stderr.write("missing --candidate-archive or --source-commit\n");
    process.exit(64);
  }
  options["installed-app-root"] = path.resolve(options["installed-app-root"] ?? path.join(os.homedir(), "Library/Application Support/The Triangle"));
  options["repo-root"] = path.resolve(options["repo-root"] ?? path.join(here, "../../.."));
  options.out = path.resolve(options.out ?? here);
  options["candidate-archive"] = path.resolve(options["candidate-archive"]);
  if (options["baseline-manifest"]) options["baseline-manifest"] = path.resolve(options["baseline-manifest"]);
  return options;
}

const privateDirs = (dir) => {
  fs.chmodSync(dir, 0o700);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) privateDirs(path.join(dir, entry.name));
  }
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.exitCode = 1;
  check(process.platform === "darwin", "this rehearsal needs macOS");
  check(Number(process.versions.node.split(".")[0]) >= 22, "this rehearsal needs Node 22 or later");

  const live = options["installed-app-root"];
  check(fs.existsSync(path.join(live, "worker-runtime/supervisor.manifest.json")), `no installed supervisor manifest under ${live}`);
  const realish = (target) => {
    let cur = path.resolve(target);
    const rest = [];
    while (!fs.existsSync(cur) && cur !== path.dirname(cur)) {
      rest.unshift(path.basename(cur));
      cur = path.dirname(cur);
    }
    return path.join(fs.realpathSync.native(cur), ...rest);
  };
  const liveReal = realish(live);
  check(realish(options.out) !== liveReal && !realish(options.out).startsWith(liveReal + path.sep), "--out must not be inside the installed application root");
  const baselineManifestFile = options["baseline-manifest"] ?? path.join(live, "worker-runtime/supervisor.manifest.json");
  check(fs.existsSync(baselineManifestFile), `no baseline supervisor manifest at ${baselineManifestFile}`);

  const results = {
    schema: "restage_prep_fd753b9_rehearsal_v1",
    startedAt: new Date().toISOString(),
    runner: { node: process.version, platform: process.platform, arch: process.arch, script: path.basename(fileURLToPath(import.meta.url)) },
    inputs: {},
    steps: [],
    warnings: [],
    verdict: "incomplete",
  };
  const steps = results.steps;
  const warn = (id, text) => {
    results.warnings.push({ step: id, text });
    process.stdout.write(`WARN ${id}  ${text}\n`);
  };
  let current = null;
  let failedStep = null;
  const hosts = new Map();
  let base = null;
  let pkgTestRoot = null;

  // Unix domain sockets must stay <= 100 bytes.
  const makeBase = () => {
    for (const parent of [fs.realpathSync(os.tmpdir()), "/private/tmp"]) {
      const candidate = fs.mkdtempSync(path.join(parent, "rstr-"));
      fs.chmodSync(candidate, 0o700);
      const sock = path.join(candidate, "a/client/local/local-control.sock");
      if (Buffer.byteLength(sock) <= 100) return candidate;
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
      failedStep = id;
      process.stdout.write(`FAIL ${id}  ${title}\n      ${error.message}\n`);
      throw error;
    } finally {
      record.ms = Date.now() - started;
      current = null;
    }
  };

  let app, client, stateRoot, registry, home, tmp, workspace, ptyRun;
  let configPath, oldBundle, oldNode, oldManifestBytes, oldBundleId, cand, candNode, wrapperPath, pkgWrapper;
  let env;
  let liveBefore;
  let releaseVersion;
  let ids = {};
  let principals = {};
  let desktopSenderId = null;

  const tl = (args, { cfg = configPath, ...opts } = {}) => run(wrapperPath, [...args, "--config", cfg], { env, ...opts });
  const pkgCli = (args, opts = {}) => run(pkgWrapper, args, { env, ...opts });
  const pkgPty = (args) => run("/usr/bin/python3", ["-I", ptyRun, pkgWrapper, ...args], { env });
  const installer = (args, opts = {}) => run("/usr/bin/python3", ["-I", path.join(cand, "scripts/triangle-worker-install.py"), ...args], { env, ...opts });
  const helper = (bundle, args, opts = {}) => run(path.join(bundle, "bin/node"), [path.join(here, "restage-host.mjs"), args[0], bundle, ...args.slice(1)], { env, ...opts });
  const manifestPath = () => path.join(app, "worker-runtime/supervisor.manifest.json");
  const currentBundle = () => JSON.parse(fs.readFileSync(manifestPath(), "utf8")).projectRoot;

  const compareLive = async () => {
    const after = await fingerprintLive(live, releaseVersion, oldBundleId);
    const strip = (x) => JSON.parse(JSON.stringify(x));
    const differences = Object.keys(liveBefore).filter((key) => !same(strip(liveBefore[key]), strip(after[key])));
    return {
      identical: differences.length === 0,
      compared: Object.keys(liveBefore),
      differences,
      ...(differences.length ? { before: strip(liveBefore), after: strip(after) } : {}),
    };
  };

  const spawnHost = async (label, { bundle = currentBundle(), cfg = configPath, omitRunners = [], noticesFile = null, expectFail = false } = {}) => {
    check(!hosts.has(label), `host ${label} is already running`);
    const extraArgs = [];
    if (omitRunners.length) extraArgs.push("--omit-runners", omitRunners.join(","));
    if (noticesFile) extraArgs.push("--notices-file", noticesFile);
    const child = spawn(
      path.join(bundle, "bin/node"),
      [path.join(here, "restage-host.mjs"), "run", bundle, cfg, ...extraArgs],
      { env, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    const closed = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
      child.on("error", (error) => resolve({ code: -1, signal: null, error: String(error) }));
    });
    let exited = false;
    closed.then(() => { exited = true; });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    hosts.set(label, { child, bundle, closed, hasExited: () => exited });
    const outcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CheckFailed(`host ${label} did not settle: ${stderr.slice(0, 400)}`)), 30000);
      child.stdout.on("data", () => {
        const line = stdout.split("\n").find((l) => l.includes('"ready"'));
        if (line) {
          clearTimeout(timer);
          resolve({ kind: "line", data: parseJson(line) });
        }
      });
      closed.then((res) => {
        clearTimeout(timer);
        const line = stdout.split("\n").find((l) => l.includes('"ready"'));
        resolve({ kind: "closed", closed: res, data: line ? parseJson(line) : null, stderr });
      });
    });
    if (expectFail) {
      hosts.delete(label);
      return outcome;
    }
    check(outcome.data?.ready === true, `host ${label} failed to start: ${JSON.stringify(outcome)}`, outcome);
    return { pid: outcome.data.pid, bundleId: path.basename(bundle), node: outcome.data.node };
  };

  const stopHost = async (label, { strict = true } = {}) => {
    const host = hosts.get(label);
    if (!host) return undefined;
    hosts.delete(label);
    let result;
    if (host.hasExited()) {
      result = await host.closed;
    } else {
      try { process.kill(host.child.pid, "SIGTERM"); } catch { /* already gone */ }
      const killTimer = setTimeout(() => { try { process.kill(-host.child.pid, "SIGKILL"); } catch { /* already gone */ } }, 10000);
      let giveUp;
      const gaveUp = new Promise((resolve) => { giveUp = setTimeout(() => resolve(null), 20000); });
      result = await Promise.race([host.closed, gaveUp]);
      clearTimeout(killTimer);
      clearTimeout(giveUp);
    }
    if (strict) check(result !== null && result?.code === 0 && result?.signal === null, `host ${label} did not stop cleanly`, result);
    return result;
  };

  const statusOf = async (cfg = configPath) => {
    const r = await tl(["status"], { cfg });
    check(r.code === 0, `triangle-local status failed (${r.code}): ${r.stderr.slice(0, 300)}`, r);
    return parseJson(r.stdout);
  };
  const discoverOf = async (cfg = configPath) => {
    const r = await tl(["discover"], { cfg });
    check(r.code === 0, `triangle-local discover failed (${r.code}): ${r.stderr.slice(0, 300)}`, r);
    return parseJson(r.stdout);
  };
  const sendCli = async (to, text, { messageId = crypto.randomUUID(), requestId = crypto.randomUUID(), wait = 5000, cfg = configPath } = {}) => {
    const r = await tl(["send", "--to", to, "--text", text, "--message-id", messageId, "--request-id", requestId, "--wait-ms", String(wait)], { cfg });
    const json = parseJson(r.stdout) ?? lastJsonLine(r.stdout) ?? lastJsonLine(r.stderr);
    return { code: r.code, json, stderr: r.stderr.trim().slice(0, 300), messageId, requestId };
  };
  const grokSend = async (to, text, { messageId = crypto.randomUUID(), requestId = crypto.randomUUID(), cfg = configPath } = {}) => {
    const file = path.join(tmp, `grok-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    const r = await tl(["grok", "send", "--alias", GROK_ALIAS, "--to", to, "--message-id", messageId, "--request-id", requestId, "--text-file", file], { cfg });
    fs.rmSync(file, { force: true });
    const json = parseJson(r.stdout) ?? lastJsonLine(r.stdout) ?? lastJsonLine(r.stderr);
    return { code: r.code, json, stderr: r.stderr.trim().slice(0, 300), messageId, requestId };
  };
  const msgStatus = async (messageId, cfg = configPath) => {
    const r = await tl(["status", "--message-id", messageId], { cfg });
    return { code: r.code, json: parseJson(r.stdout), text: (r.stdout + r.stderr).trim().slice(0, 300) };
  };
  const grokStatus = async (messageId, cfg = configPath) => {
    const r = await tl(["grok", "status", "--alias", GROK_ALIAS, "--message-id", messageId], { cfg });
    return { code: r.code, json: parseJson(r.stdout), text: (r.stdout + r.stderr).trim().slice(0, 300) };
  };
  const noRow = async (who, messageId, cfg = configPath) => {
    const looked = who === "grok" ? await grokStatus(messageId, cfg) : await msgStatus(messageId, cfg);
    return looked.code !== 0 && /not_found/.test(looked.text);
  };

  let finalizing = null;
  const finalize = () => (finalizing ??= finalizeOnce());
  const finalizeOnce = async () => {
    try {
      for (const label of [...hosts.keys()]) await stopHost(label, { strict: false });
    } catch (error) {
      results.cleanupError = String(error?.message ?? error);
    }
    if (liveBefore && !results.liveRoot) {
      try {
        const cmp = await compareLive();
        results.liveRoot = { identical: cmp.identical, compared: cmp.compared, differences: cmp.differences };
      } catch (error) {
        results.liveRoot = { identical: false, error: String(error?.message ?? error) };
      }
    }
    if (results.liveRoot && !results.liveRoot.identical) results.verdict = "fail";
    results.finishedAt = new Date().toISOString();
    fs.mkdirSync(options.out, { recursive: true });
    let text = JSON.stringify(results, null, 2) + "\n";
    for (const [val, mask] of [
      [base, "<scratch>"],
      [live, "<installed-root>"],
      [options["repo-root"], "<repo>"],
      [options["candidate-archive"], "<candidate-archive>"],
      [os.homedir(), "<home>"],
    ]) {
      if (val) text = text.split(val).join(mask);
    }
    fs.writeFileSync(path.join(options.out, "results.json"), text);
    if (base && !options.keep) fs.rmSync(base, { recursive: true, force: true });
    else if (base) process.stdout.write(`scratch root kept: ${base}\n`);
  };

  let interrupted = false;
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = true;
    process.stdout.write(`\ninterrupted by ${signal} during ${current?.id ?? "pause"}: stopping scratch hosts and cleaning up\n`);
    killRunningChildren();
    results.verdict = "interrupted";
    results.failure = { step: current?.id ?? null, message: `interrupted by ${signal}` };
    finalize().finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // ===================================================================== A. Inputs (read-only live + candidate)
    await step("A1", "installed state: v15 supervisor manifest, worker manifests, bundle and client receipt (read only)", async () => {
      const manifest = JSON.parse(fs.readFileSync(baselineManifestFile, "utf8"));
      oldBundleId = path.basename(manifest.projectRoot);
      const bundle = manifest.projectRoot;
      check(manifest.version === EXPECT_MANIFEST_VERSION, `installed supervisor manifest is v${manifest.version}, not v${EXPECT_MANIFEST_VERSION}`);
      check(path.dirname(bundle) === path.join(live, "worker-runtime/bundles"), "installed projectRoot is not under worker-runtime/bundles");
      const workers = {};
      for (const agent of ["codex", "hermes", "antigravity"]) {
        const wm = JSON.parse(fs.readFileSync(path.join(live, "worker-runtime", `${agent}.manifest.json`), "utf8"));
        check(wm.version === EXPECT_MANIFEST_VERSION, `installed ${agent} manifest is v${wm.version}`);
        workers[agent] = { version: wm.version, bundleId: path.basename(wm.projectRoot), artifacts: Object.keys(wm.artifacts).length };
      }
      const install = JSON.parse(fs.readFileSync(path.join(live, "package-install.json"), "utf8"));
      releaseVersion = install.version;
      check(fs.existsSync(path.join(live, "releases", releaseVersion, "package-manifest.json")), `no release ${releaseVersion} under ${live}/releases`);
      results.inputs.installed = {
        manifestVersion: manifest.version,
        bundleId: oldBundleId,
        artifacts: Object.keys(manifest.artifacts).length,
        nodeSHA256: manifest.nodeSHA256,
        manifestSha256: sha256File(baselineManifestFile),
        workers,
        clientPackageVersion: releaseVersion,
        triangleLocalSha256: sha256File(path.join(live, "bin/triangle-local")),
      };
      liveBefore = await fingerprintLive(live, releaseVersion, oldBundleId);
      if (liveBefore.processes.length === 0) warn("A1", "no live supervisor processes were seen");
      return {
        manifestVersion: manifest.version,
        bundleIdPrefix: oldBundleId.slice(0, 12),
        artifacts: Object.keys(manifest.artifacts).length,
        clientPackageVersion: releaseVersion,
        liveProcesses: liveBefore.processes.length,
      };
    });

    base = makeBase();
    app = path.join(base, "a");
    client = path.join(app, "client");
    configPath = path.join(client, "local-messaging.json");
    stateRoot = path.join(client, "local");
    registry = path.join(app, "identity");
    home = path.join(base, "home");
    tmp = path.join(base, "tmp");
    workspace = path.join(base, "ws");
    cand = path.join(base, "cand");
    wrapperPath = path.join(app, "bin/triangle-local");
    ptyRun = path.join(here, "pty-run.py");
    for (const dir of [
      app,
      path.join(app, "bin"),
      path.join(app, "worker-runtime"),
      path.join(app, "worker-runtime/bundles"),
      client,
      stateRoot,
      registry,
      home,
      tmp,
      workspace,
    ]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    env = { HOME: home, TMPDIR: tmp, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", USER: os.userInfo().username, LOGNAME: os.userInfo().username };
    results.scratch = { root: base, applicationRoot: app };

    await step("A2", "installed v15 bundle copied to scratch root and hash-verified", async () => {
      const manifest = JSON.parse(fs.readFileSync(baselineManifestFile, "utf8"));
      oldBundle = path.join(app, "worker-runtime/bundles", oldBundleId);
      fs.cpSync(manifest.projectRoot, oldBundle, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, preserveTimestamps: false });
      oldNode = path.join(oldBundle, "bin/node");
      privateDirs(oldBundle);
      let mismatches = 0;
      for (const [rel, expected] of Object.entries(manifest.artifacts)) {
        if (sha256File(path.join(oldBundle, rel)) !== expected) mismatches += 1;
      }
      check(mismatches === 0, `${mismatches} copied artifacts differ from live manifest`);
      check(sha256File(oldNode) === manifest.nodeSHA256, "copied node differs from live nodeSHA256");
      const scratchManifest = { ...manifest, projectRoot: oldBundle, environment: { PATH: `${oldBundle}/bin:/usr/bin:/bin`, LANG: "C", LC_ALL: "C" } };
      fs.writeFileSync(manifestPath(), JSON.stringify(scratchManifest, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(manifestPath(), 0o600);
      oldManifestBytes = fs.readFileSync(manifestPath());

      const wrapper = fs.readFileSync(path.join(live, "bin/triangle-local"), "utf8");
      const constant = /^TRIANGLE_LOCAL_APPLICATION_ROOT = .*$/m;
      check(constant.test(wrapper), "installed triangle-local has no TRIANGLE_LOCAL_APPLICATION_ROOT constant");
      fs.writeFileSync(wrapperPath, wrapper.replace(constant, () => `TRIANGLE_LOCAL_APPLICATION_ROOT = '${app}'`), { mode: 0o700 });
      fs.chmodSync(wrapperPath, 0o700);
      return { artifactsVerified: Object.keys(manifest.artifacts).length, nodeSha256: manifest.nodeSHA256 };
    });

    const git = (args) => run("/usr/bin/git", ["-C", options["repo-root"], ...args], { env: { PATH: "/usr/bin:/bin", HOME: home } });
    const gitBlob = (commit, file) =>
      execFileSync("/usr/bin/git", ["-C", options["repo-root"], "show", `${commit}:${file}`], {
        env: { PATH: "/usr/bin:/bin", HOME: home },
        maxBuffer: 64 * 1024 * 1024,
      });

    let candidateCommit;
    await step("A3", "candidate package: archive hash, tracked blobs match commit, node hash, strict codesign", async () => {
      const archive = options["candidate-archive"];
      const archiveSha = sha256File(archive);
      const recorded = fs.existsSync(`${archive}.sha256`) ? fs.readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/)[0] : null;
      check(recorded === null || recorded === archiveSha, "archive hash differs from .sha256");
      fs.mkdirSync(cand, { mode: 0o700 });
      const untar = await run("/usr/bin/tar", ["-xzf", archive, "-C", cand], { env: { PATH: "/usr/bin:/bin" } });
      check(untar.code === 0, `tar failed: ${untar.stderr}`);
      const manifest = JSON.parse(fs.readFileSync(path.join(cand, "package-manifest.json"), "utf8"));
      let wrong = 0;
      for (const file of manifest.files) {
        const actual = path.join(cand, file.path);
        if (!fs.existsSync(actual) || sha256File(actual) !== file.sha256 || mode(actual) !== file.mode) wrong += 1;
      }
      check(wrong === 0, `${wrong} packaged files differ from package-manifest.json`);
      const sourceRef = options["source-commit"] ?? "HEAD";
      candidateCommit = (await git(["rev-parse", `${sourceRef}^{commit}`])).stdout.trim();
      check(/^[0-9a-f]{40}$/.test(candidateCommit), `cannot resolve ${sourceRef}`);
      const tracked = new Set((await git(["ls-tree", "-r", "-z", "--name-only", candidateCommit])).stdout.split("\0").filter(Boolean));
      let compared = 0;
      for (const file of manifest.files) {
        if (!tracked.has(file.path)) continue;
        check(sha256Buffer(gitBlob(candidateCommit, file.path)) === file.sha256, `${file.path} differs from committed blob`);
        compared += 1;
      }
      check(compared > 100, `only ${compared} packaged files are tracked sources`);
      candNode = path.join(cand, "bin/node");
      check(sha256File(candNode) === results.inputs.installed.nodeSHA256, "candidate node differs from installed node");
      for (const rel of ["packages/triangle-cli/src/identity-destination.mjs", "packages/triangle-cli/src/identity-chat-map.mjs"]) {
        check(fs.existsSync(path.join(cand, rel)), `candidate lacks ${rel}`);
      }
      const sign = await run("/usr/bin/codesign", ["--verify", "--strict", path.join(cand, "bin/triangle-mailbox"), path.join(cand, "bin/triangle-client")], { env: { PATH: "/usr/bin:/bin" } });
      check(sign.code === 0, `codesign --verify --strict failed: ${sign.stderr.slice(0, 200)}`);
      results.inputs.candidate = {
        commit: candidateCommit,
        version: manifest.version,
        archiveSha256: archiveSha,
        files: manifest.files.length,
        signingMode: manifest.signingMode,
        credentialCustody: manifest.credentialCustody,
        testOnly: manifest.testOnly ?? false,
      };
      return { ...results.inputs.candidate, trackedFilesEqualCommittedBlobs: compared, nodeEqualsInstalledNode: true };
    });

    await step("A4", "supervisor artifact diff: exact 12 modules, manifest stays v15, 0 added/removed", async () => {
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
      check(wa.version === EXPECT_MANIFEST_VERSION, `candidate manifest version is ${wa.version}, not ${EXPECT_MANIFEST_VERSION}`);
      check(added.length === 0 && removed.length === 0, "supervisor artifact set changed", { added, removed });
      check(same(changed, EXPECTED_SUPERVISOR_DIFF), "changed supervisor artifacts differ from expected 12 modules", { changed, expected: EXPECTED_SUPERVISOR_DIFF });
      results.inputs.artifactDiff = { manifestVersion: wa.version, supervisorArtifacts: wa.kinds.supervisor.length, changed, added, removed };
      if (options["installed-source-commit"]) {
        const installedCommit = (await git(["rev-parse", `${options["installed-source-commit"]}^{commit}`])).stdout.trim();
        check(/^[0-9a-f]{40}$/.test(installedCommit), "cannot resolve --installed-source-commit");
        let equal = 0;
        for (const [rel, sha] of Object.entries(installed)) {
          check(sha256Buffer(gitBlob(installedCommit, rel)) === sha, `installed ${rel} differs from ${installedCommit.slice(0, 8)}`);
          equal += 1;
        }
        const diff = (await git(["diff", "--name-only", "-z", installedCommit, candidateCommit])).stdout.split("\0").filter(Boolean);
        const bySource = wa.kinds.supervisor.filter((rel) => diff.includes(rel)).sort();
        check(same(bySource, changed), "git diff supervisor modules differ from bundle diff", { bySource, changed });
        results.inputs.artifactDiff.git = { installedSourceCommit: installedCommit, installedArtifactsEqualBlobs: equal, equalToBundleDiff: true };
      }
      return results.inputs.artifactDiff;
    });

    await step("A5", "client package diff: 0.2.0-identity.3 (157) -> candidate (161)", async () => {
      const instM = JSON.parse(fs.readFileSync(path.join(live, "releases", releaseVersion, "package-manifest.json"), "utf8"));
      const candM = JSON.parse(fs.readFileSync(path.join(cand, "package-manifest.json"), "utf8"));
      const a = new Map(instM.files.map((f) => [f.path, f.sha256]));
      const b = new Map(candM.files.map((f) => [f.path, f.sha256]));
      const added = [...b.keys()].filter((p) => !a.has(p)).sort();
      const removed = [...a.keys()].filter((p) => !b.has(p)).sort();
      const changed = [...b.keys()].filter((p) => a.has(p) && a.get(p) !== b.get(p)).sort();
      check(removed.length === 0, "candidate removes files", removed);
      check(added.includes("packages/triangle-cli/src/identity-destination.mjs") && added.includes("packages/triangle-cli/src/identity-chat-map.mjs"), "missing slice modules in added", added);
      results.inputs.packageDiff = { installedVersion: releaseVersion, installedFiles: a.size, candidateFiles: b.size, added, removed, changed, unchanged: a.size - removed.length - changed.length };
      return results.inputs.packageDiff;
    });

    await step("A6", "live receipt audit (read only): 6 of 7 owned files mismatch; helper install-manifests match disk", async () => {
      const receipt = JSON.parse(fs.readFileSync(path.join(live, "package-install.json"), "utf8"));
      const owned = Object.entries(receipt.owned ?? {});
      const mismatches = [];
      for (const [file, sha] of owned) {
        let actual = null;
        try { actual = sha256File(file); } catch { /* missing */ }
        if (actual !== sha) mismatches.push(path.relative(live, file));
      }
      const helperManifestsValid = {};
      for (const name of ["triangle-mailbox", "triangle-client"]) {
        const binSha = sha256File(path.join(live, "bin", name));
        const shaFile = fs.readFileSync(path.join(live, "install-manifest", `${name}.sha256`), "utf8").trim();
        const meta = JSON.parse(fs.readFileSync(path.join(live, "install-manifest", `${name}-install.json`), "utf8"));
        const ok = meta.version === 1 && meta.signingMode === "public_ad_hoc" && meta.credentialCustody === "file" && meta.sha256 === binSha && shaFile === binSha;
        check(ok, `helper install-manifest ${name} does not match disk`, { binSha, shaFile, meta });
        helperManifestsValid[name] = true;
      }
      results.inputs.liveReceipt = { version: receipt.version, ownedFiles: owned.length, matchingDisk: owned.length - mismatches.length, mismatches, helperManifestsValid };
      if (mismatches.length > 0) warn("A6", `live package-install.json mismatches disk for ${mismatches.length} of ${owned.length} owned files (${mismatches.join(", ")})`);
      return results.inputs.liveReceipt;
    });

    // ===================================================================== B. Baseline outage & baseline world
    const b1Root = path.join(base, "b1");
    const b1Client = path.join(b1Root, "c");
    const b1State = path.join(b1Client, "l");
    const b1Registry = path.join(b1Root, "id");
    let b1ConfigPath;

    await step("B1", "baseline outage reproduction: v15 bundle 009977d1 fails local_recipient_unavailable when gravity2 has no runner", async () => {
      for (const d of [b1Root, b1Client, b1State, b1Registry]) {
        fs.mkdirSync(d, { recursive: true, mode: 0o700 });
        fs.chmodSync(d, 0o700);
      }
      const specPath = path.join(tmp, "b1-spec.json");
      fs.writeFileSync(specPath, JSON.stringify({
        clientRoot: b1Client,
        stateRoot: b1State,
        registryRoot: b1Registry,
        local: ["gravity2"],
        bound: ["gravity2", "ghost"],
        init: false,
        v2: true,
        alias: { name: "gemini", targetProfile: "gravity2" },
      }));
      const prep = lastJsonLine((await helper(oldBundle, ["prepare", specPath])).stdout);
      check(prep?.ok === true, "B1 prepare failed", prep);
      b1ConfigPath = prep.configPath;
      const failed = await spawnHost("b1-baseline", { bundle: oldBundle, cfg: b1ConfigPath, omitRunners: ["gravity2"], expectFail: true });
      check(failed.data?.ready === false && failed.data?.code === "local_recipient_unavailable", "baseline host did not fail with local_recipient_unavailable", failed);
      check(!fs.existsSync(path.join(b1State, "local-control.sock")), "baseline outage unexpectedly created local-control.sock");
      return { failedStartCode: failed.data.code, socketCreated: false };
    });

    await step("B2", "baseline world prepared (gravity2, helper, rhea destination, nora, m2chat, alias, grok) + queued work seeded", async () => {
      const specPath = path.join(tmp, "main-spec.json");
      fs.writeFileSync(specPath, JSON.stringify({
        clientRoot: client,
        stateRoot,
        registryRoot: registry,
        workspace,
        localCli: wrapperPath,
        local: ["gravity2", "helper"],
        bound: ["gravity2", "helper", "rhea", "nora", "m2chat"],
        init: false,
        v2: true,
        alias: { name: "gemini", targetProfile: "gravity2" },
        destination: { targetProfile: "rhea", harness: "claude", workspace },
      }));
      const prep = lastJsonLine((await helper(oldBundle, ["prepare", specPath])).stdout);
      check(prep?.ok === true, "B2 prepare failed", prep);
      ids = prep.instances;
      principals = prep.principals;
      desktopSenderId = prep.senderId;

      const setupGrok = await tl(["setup-grok", "--alias", GROK_ALIAS, "--recipient", ids.gravity2, "--recipient", ids.helper]);
      check(setupGrok.code === 0, `setup-grok failed: ${setupGrok.stderr}`, setupGrok);

      await spawnHost("old-healthy", { bundle: oldBundle });
      const st = await statusOf();
      check(st.router.registry.state === "ok" && st.router.registry.schema === "identity_registry_v2", "baseline host status not ok", st);
      const d = await discoverOf();
      const gEntry = d.entries.find((e) => e.id === ids.gravity2);
      check(same(gEntry?.send?.aliases, ["gemini"]), "baseline discovery missing gemini alias", gEntry);
      const echo = await sendCli("helper", "baseline echo");
      check(echo.code === 0 && JSON.stringify(echo.json).includes("echo[helper]: baseline echo"), "baseline send to helper failed", echo);
      await stopHost("old-healthy");

      // Seed queued work for disabled gravity2 (must stay queued_local) and removed recipient (must transition to held).
      const s1 = lastJsonLine((await helper(oldBundle, ["seed-queued", stateRoot, desktopSenderId, ids.gravity2, "pre-off-1", "pre-off-1-req", "queued before outage"])).stdout);
      const s2 = lastJsonLine((await helper(oldBundle, ["seed-queued", stateRoot, desktopSenderId, "f".repeat(64), "pre-gone-1", "pre-gone-1-req", "queued for removed agent"])).stdout);
      check(s1?.phase === "queued_local" && s2?.phase === "queued_local", "failed to seed queued messages", { s1, s2 });
      return { seeded: ["pre-off-1", "pre-gone-1"], baselineHealthy: true };
    });

    // ===================================================================== C. Gate S candidate supervisor
    let record1;
    let candidateBundleId;
    await step("C1", "Gate S: stage-runtime + validate-runtime onto scratch manifest; exact 12-module diff, v15, node unchanged", async () => {
      const staged = await installer(["stage-runtime", "--application-root", app, "--project-root", cand, "--agent", "supervisor", "--node", oldNode]);
      check(staged.code === 0, `stage-runtime failed: ${staged.stderr.slice(0, 400)}`, staged);
      const valid = await installer(["validate-runtime", "--manifest", manifestPath(), "--agent", "supervisor"]);
      check(valid.code === 0, `validate-runtime failed: ${valid.stderr.slice(0, 400)}`, valid);
      const names = fs.readdirSync(path.join(app, "worker-runtime")).filter((n) => n.startsWith(".rollback-supervisor-"));
      check(names.length === 1, `expected 1 rollback record, found ${names.length}`);
      record1 = path.join(app, "worker-runtime", names[0]);
      const m = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
      const old = JSON.parse(oldManifestBytes.toString("utf8"));
      const differing = Object.keys(m.artifacts).filter((rel) => m.artifacts[rel] !== old.artifacts[rel]).sort();
      check(same(differing, EXPECTED_SUPERVISOR_DIFF), "staged manifest differs outside expected 12 modules", differing);
      check(m.nodeSHA256 === old.nodeSHA256 && m.version === EXPECT_MANIFEST_VERSION, "node or version changed");
      candidateBundleId = path.basename(currentBundle());
      const expectedBundleId = sha256Text(
        ["supervisor", m.nodeSHA256, ...Object.keys(m.artifacts).sort().map((k) => `${k}=${m.artifacts[k]}`), ""].join("\n"),
      );
      check(candidateBundleId === expectedBundleId, "candidate bundle id does not match content address", { candidateBundleId, expectedBundleId });
      results.inputs.candidateBundleId = candidateBundleId;
      return { candidateBundleId, differingArtifacts: differing.length, nodeUnchanged: true, rollbackRecord: path.basename(record1) };
    });

    let helperReplyId = null;
    await step("C2", "#184 host fix: starts with disabled gravity2 (single-recipient & multi-recipient), notice emitted, refuses new work, preserves queued_local", async () => {
      // 1. Single-recipient Mini topology (b1): only gravity2 configured, no runners -> host stays up!
      const noticesPath = path.join(tmp, "b1-notices.jsonl");
      await spawnHost("b1-cand", { bundle: currentBundle(), cfg: b1ConfigPath, omitRunners: ["gravity2"], noticesFile: noticesPath });
      check(fs.existsSync(path.join(b1State, "local-control.sock")), "single-recipient candidate host did not create socket");
      const notices = fs.readFileSync(noticesPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      check(
        notices.some((n) => n.event === "triangle_client_local_recipient_not_running" && n.profile === "gravity2"),
        "missing triangle_client_local_recipient_not_running notice",
        notices,
      );
      const b1St = await statusOf(b1ConfigPath);
      check(same(b1St.unavailableRecipients, ["gravity2"]), "single-recipient status missing unavailableRecipients", b1St);
      for (const to of ["gravity2", b1St.recipients[0].instanceId, "gemini"]) {
        const ref = await sendCli(to, `new work to ${to}`, { cfg: b1ConfigPath, wait: 0 });
        check(ref.code !== 0 && ref.json?.error === "local_recipient_unavailable", `send to disabled ${to} not refused`, ref);
        check(await noRow("desktop", ref.messageId, b1ConfigPath), `refused send to ${to} left a journal row`);
      }
      await stopHost("b1-cand");

      // 2. Main scratch world with gravity2 omitted and helper running:
      await spawnHost("cand", { omitRunners: ["gravity2"] });
      const st = await statusOf();
      check(same(st.unavailableRecipients, ["gravity2"]), "main candidate status missing unavailableRecipients", st);
      const disc = await discoverOf();
      check(same(disc.entries.find((e) => e.id === ids.gravity2)?.send?.aliases, ["gemini"]), "gemini alias missing on discovery");

      const hSend = await sendCli("helper", "candidate helper ok");
      check(hSend.code === 0 && JSON.stringify(hSend.json).includes("echo[helper]: candidate helper ok"), "helper send failed on candidate", hSend);
      helperReplyId = hSend.json?.replies?.[0]?.messageId;
      check(typeof helperReplyId === "string" && helperReplyId.startsWith("rep-"), "missing helper replyId", hSend.json);

      // Refusal to disabled gravity2 (desktop CLI + Grok CLI)
      const dRef = await sendCli("gravity2", "refuse me", { wait: 0 });
      check(dRef.code !== 0 && dRef.json?.error === "local_recipient_unavailable", "desktop send to disabled gravity2 not refused", dRef);
      check(await noRow("desktop", dRef.messageId), "refused desktop send left a row");

      const gRef = await grokSend(ids.gravity2, "grok refuse disabled");
      check(gRef.code !== 0 && gRef.json?.state === "rejected" && gRef.json?.error === "local_recipient_unavailable", "grok send to disabled gravity2 did not return rejected/local_recipient_unavailable", gRef);
      check(await noRow("grok", gRef.messageId), "refused grok send left a row");

      // Seeded queued_local for gravity2 stays queued_local and answers exact retry; removed recipient transitions to held(runtime_error).
      const preOff = await msgStatus("pre-off-1");
      check(preOff.code === 0 && preOff.json?.phase === "queued_local", "pre-off-1 did not stay queued_local", preOff);
      const preOffRetry = await sendCli("gravity2", "queued before outage", { messageId: "pre-off-1", requestId: "pre-off-1-req", wait: 0 });
      check(preOffRetry.code === 0 && preOffRetry.json?.admission?.isDuplicate === true, "exact retry of pre-off-1 did not succeed as duplicate", preOffRetry);

      let heldOk = false;
      for (let i = 0; i < 40; i += 1) {
        const g = await msgStatus("pre-gone-1");
        if (g.code === 0 && g.json?.phase === "held" && g.json?.reason === "runtime_error") {
          heldOk = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      check(heldOk, "seeded message for removed agent did not transition to held(runtime_error)");

      return {
        singleRecipientStartsCleanly: true,
        noticeEmitted: true,
        unavailableRecipients: st.unavailableRecipients,
        helperReplyIdCaptured: true,
        grokRejectedUnavailable: true,
        preOffKeptQueuedAndRetried: true,
        preGoneHeld: true,
      };
    });

    await step("C3", "#185 reply-id reuse fix: refused message_id_in_use (server, journal, Grok); same-id message still retries", async () => {
      for (const to of ["helper", "gravity2"]) {
        const r = await sendCli(to, `reuse reply id for ${to}`, { messageId: helperReplyId, wait: 0 });
        check(r.code !== 0 && r.json?.error === "message_id_in_use", `reuse to ${to} did not fail with message_id_in_use`, r);
      }
      const looked = await msgStatus(helperReplyId);
      check(looked.code === 0 && looked.json?.messageId === helperReplyId && looked.json?.phase === undefined && looked.json?.state === "unknown", "reply record altered after refused reuse", looked);

      const gReuse = await grokSend(ids.helper, "grok reuse reply id", { messageId: helperReplyId });
      check(gReuse.code !== 0 && gReuse.json?.state === "rejected" && gReuse.json?.error === "message_id_in_use", "grok reply-id reuse did not return rejected/message_id_in_use", gReuse);

      const jGuard = lastJsonLine((await helper(currentBundle(), ["journal-reply-guard", path.join(tmp, "jguard"), desktopSenderId, ids.helper])).stdout);
      check(jGuard?.ok === true && jGuard.reuseCode === "message_id_in_use" && jGuard.sameIdRetryIsDuplicate === true, "journal reply guard failed", jGuard);
      const sGuard = lastJsonLine((await helper(currentBundle(), ["server-reply-guard", path.join(tmp, "sguard"), desktopSenderId, ids.helper])).stdout);
      check(sGuard?.ok === true && sGuard.errorCode === "message_id_in_use" && sGuard.recordSendCalled === false && sGuard.rateRolledBack === true, "server reply guard failed", sGuard);
      return { serverRefused: ["helper", "gravity2"], grokRejected: true, journalDirectGuard: jGuard, serverDirectGuard: sGuard };
    });

    await step("C4", "M1 ACL-first destination indistinguishability on running candidate host", async () => {
      const m1 = lastJsonLine((await helper(currentBundle(), ["probe-m1", configPath, workspace, principals.rhea, principals.nora])).stdout);
      check(m1?.ok === true && m1.statesChecked === 5, "M1 host probe failed", m1);
      return m1;
    });

    await step("C5", "M2 + M3 mapped chat provenance and reply pinning with reply-identity enabled", async () => {
      await stopHost("cand");
      const policyFile = path.join(client, "reply-identity.json");
      fs.writeFileSync(policyFile, JSON.stringify({ version: 1, enabled: true }) + "\n", { mode: 0o600 });
      await spawnHost("cand-ri", { omitRunners: ["gravity2"] });
      const st = await statusOf();
      check(st.replyIdentity?.enabled === true, "replyIdentity did not enable", st.replyIdentity);
      const m23 = lastJsonLine((await helper(currentBundle(), ["probe-m2-m3", configPath, workspace, registry, principals.m2chat])).stdout);
      check(
        m23?.ok === true && m23.unmapped === null && m23.pending === null && m23.confirmedPrincipal === principals.m2chat && m23.pinnedReplyReceived === true && m23.afterRevoke === null,
        "M2/M3 probe failed",
        m23,
      );
      await stopHost("cand-ri");
      fs.rmSync(policyFile, { force: true });
      return {
        unmapped: null,
        pending: null,
        confirmedPinnedReplyReceived: true,
        afterRevoke: null,
      };
    });

    // ===================================================================== D. Gate P package install & M5 CLI
    await step("D1", "Gate P: scratch package install refuses 6/7 stale receipt, succeeds cleanly after helper-verified reconciliation", async () => {
      const archive = options["candidate-archive"];
      const installerScript = path.join(path.dirname(archive), `triangle-install-${results.inputs.candidate.version}.sh`);
      check(fs.existsSync(installerScript), `missing installer script: ${installerScript}`);
      pkgTestRoot = fs.mkdtempSync(path.join(tmp, "triangle-package-install-"));
      fs.chmodSync(pkgTestRoot, 0o700);
      const pkgHome = path.join(pkgTestRoot, "home");
      const instApp = path.join(pkgHome, "Library/Application Support/The Triangle");
      for (const rel of [
        "",
        "Library",
        "Library/Application Support",
        "Library/LaunchAgents",
        "Library/Logs",
        "Library/Logs/the-triangle",
        ".local",
        ".local/bin",
        "Library/Application Support/The Triangle",
        "Library/Application Support/The Triangle/bin",
        "Library/Application Support/The Triangle/install-manifest",
        "Library/Application Support/The Triangle/releases",
        "Library/Application Support/The Triangle/credentials",
        "Library/Application Support/The Triangle/credentials/local",
        "Library/Application Support/The Triangle/worker-runtime",
        "Library/Application Support/The Triangle/model-state",
        "Library/Application Support/The Triangle/client",
      ]) {
        const dir = path.join(pkgHome, rel);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
      }

      // Seed exact replica of the live stale-receipt layout.
      fs.copyFileSync(path.join(live, "bin/triangle"), path.join(instApp, "bin/triangle"));
      fs.chmodSync(path.join(instApp, "bin/triangle"), 0o700);
      fs.symlinkSync(path.join(instApp, "bin/triangle"), path.join(pkgHome, ".local/bin/triangle"));
      for (const name of ["triangle-mailbox", "triangle-client"]) {
        fs.copyFileSync(path.join(live, "bin", name), path.join(instApp, "bin", name));
        fs.chmodSync(path.join(instApp, "bin", name), 0o700);
        for (const ext of [".sha256", "-install.json"]) {
          fs.copyFileSync(path.join(live, "install-manifest", name + ext), path.join(instApp, "install-manifest", name + ext));
          fs.chmodSync(path.join(instApp, "install-manifest", name + ext), 0o600);
        }
      }
      const liveReceipt = JSON.parse(fs.readFileSync(path.join(live, "package-install.json"), "utf8"));
      const scratchOwned = {};
      for (const [origPath, sha] of Object.entries(liveReceipt.owned)) {
        const rel = path.relative(live, origPath);
        scratchOwned[path.join(instApp, rel)] = sha;
      }
      const receiptFile = path.join(instApp, "package-install.json");
      fs.writeFileSync(receiptFile, JSON.stringify({ ...liveReceipt, owned: scratchOwned }, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(receiptFile, 0o600);

      // First run must refuse because 6 of 7 owned files mismatch the stale receipt.
      const pkgEnv = { ...env, HOME: pkgHome, TMPDIR: tmp };
      const refused = await run(
        "/bin/bash",
        [installerScript, "--archive", archive, "--sha256", results.inputs.candidate.archiveSha256, "--test-root", pkgTestRoot],
        { env: pkgEnv, timeoutMs: 180000 },
      );
      check(refused.code !== 0 && /Existing file is not an unchanged package-owned file/.test(refused.stderr + refused.stdout), "installer did not refuse stale receipt", { code: refused.code, err: refused.stderr.slice(0, 400) });

      // Reconcile the 6 helper/manifest entries only after verifying helper install-manifests match disk.
      const reconciledOwned = { ...scratchOwned };
      let updatedCount = 0;
      for (const name of ["triangle-mailbox", "triangle-client"]) {
        const binPath = path.join(instApp, "bin", name);
        const shaPath = path.join(instApp, "install-manifest", `${name}.sha256`);
        const metaPath = path.join(instApp, "install-manifest", `${name}-install.json`);
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const binDigest = sha256File(binPath);
        check(meta.version === 1 && meta.signingMode === "public_ad_hoc" && meta.credentialCustody === "file" && meta.sha256 === binDigest && fs.readFileSync(shaPath, "utf8").trim() === binDigest, `helper ${name} verification failed before reconciliation`);
        for (const p of [binPath, shaPath, metaPath]) {
          reconciledOwned[p] = sha256File(p);
          updatedCount += 1;
        }
      }
      check(updatedCount === 6, `expected 6 reconciled entries, got ${updatedCount}`);
      fs.writeFileSync(receiptFile, JSON.stringify({ ...liveReceipt, owned: reconciledOwned }, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(receiptFile, 0o600);

      const installed = await run(
        "/bin/bash",
        [installerScript, "--archive", archive, "--sha256", results.inputs.candidate.archiveSha256, "--test-root", pkgTestRoot],
        { env: pkgEnv, timeoutMs: 180000 },
      );
      check(installed.code === 0, `reconciled package install failed (${installed.code}): ${(installed.stderr || installed.stdout).slice(0, 500)}`, installed);
      const outJson = lastJsonLine(installed.stdout);
      pkgWrapper = outJson?.cli;
      check(outJson?.state === "installed" && pkgWrapper === path.join(pkgHome, ".local/bin/triangle"), "unexpected package install output", outJson);
      const finalReceipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      check(finalReceipt.version === results.inputs.candidate.version, "final receipt version mismatch", finalReceipt);
      for (const [f, sha] of Object.entries(finalReceipt.owned)) {
        check(sha256File(f) === sha, `final receipt file mismatch: ${f}`);
      }
      return { staleReceiptRefused: true, reconciledEntries: updatedCount, installedVersion: finalReceipt.version, receiptMatched: Object.keys(finalReceipt.owned).length };
    });

    await step("D2", "M5 CLI checks on scratch-installed triangle: help, status --identity, destination plan, chat-map storeRoot & --client-root, fail-closed confirm", async () => {
      const help = await pkgCli(["--help"]);
      check(help.code === 0 && help.stdout.includes("identity destination set") && help.stdout.includes("identity chat-map set"), "help missing destination/chat-map commands", help.stdout.slice(0, 400));

      const idStatus = await pkgCli(["status", "--identity", "--client-root", client, "--registry-root", registry]);
      check(idStatus.code === 0 && /Destinations \(owner-set chat routing rules\)/.test(idStatus.stdout) && /active · .*rhea/.test(idStatus.stdout), "status --identity missing active rhea destination row", idStatus.stdout.slice(0, 1200));

      const destReady = await pkgCli(["identity", "destination", "set", "nora", "--harness", "claude", "--workspace", workspace, "--client-root", client, "--registry-root", registry, "--json"]);
      const destPlan = jsonOf(destReady);
      check(destReady.code === 0 && destPlan?.ready === true && destPlan.refusals.length === 0, "destination plan for non-runner nora not ready", destReady);

      const destRunner = await pkgCli(["identity", "destination", "set", "gravity2", "--harness", "claude", "--workspace", workspace, "--client-root", client, "--registry-root", registry, "--json"]);
      check(destRunner.code === 1 && jsonOf(destRunner)?.refusals?.includes("destination_target_has_runner"), "destination plan did not refuse runner gravity2", destRunner);

      const destDup = await pkgCli(["identity", "destination", "set", "rhea", "--harness", "claude", "--workspace", workspace, "--client-root", client, "--registry-root", registry, "--json"]);
      check(destDup.code === 1 && jsonOf(destDup)?.refusals?.includes("destination_exists"), "destination plan did not refuse existing rhea rule", destDup);

      // Confirm without TTY exits 2; with PTY on plain build fails closed owner_approval_unavailable (exit 1).
      const destNoTty = await pkgCli(["identity", "destination", "set", "nora", "--harness", "claude", "--workspace", workspace, "--client-root", client, "--registry-root", registry, "--confirm", destPlan.planId]);
      check(destNoTty.code === 2, `destination --confirm without TTY exited ${destNoTty.code}, expected 2`, destNoTty);
      const destPlainPty = await pkgPty(["identity", "destination", "set", "nora", "--harness", "claude", "--workspace", workspace, "--client-root", client, "--registry-root", registry, "--confirm", destPlan.planId, "--json"]);
      check(/pty-exit: 1/.test(destPlainPty.stderr) && /owner_approval_unavailable/.test(destPlainPty.stdout + destPlainPty.stderr), "plain build destination --confirm did not fail closed with owner_approval_unavailable", destPlainPty);

      // M5: identity chat-map set WITHOUT --store-root uses stateRoot from local-messaging.json and prints --client-root!
      const cmHuman = await pkgCli(["identity", "chat-map", "set", "--principal", principals.nora, "--harness", "claude", "--workspace", workspace, "--client-root", client, "--registry-root", registry]);
      check(cmHuman.code === 0 && cmHuman.stdout.includes(`--client-root '${client}'`) && cmHuman.stdout.includes(`--store-root '${stateRoot}'`), "chat-map human plan missing --client-root or wrong --store-root", cmHuman.stdout.slice(0, 600));
      const cmJsonRun = await pkgCli(["identity", "chat-map", "set", "--principal", principals.nora, "--harness", "claude", "--workspace", workspace, "--client-root", client, "--registry-root", registry, "--json"]);
      const cmPlan = jsonOf(cmJsonRun);
      check(cmJsonRun.code === 0 && cmPlan?.operation?.storeRoot === stateRoot, "chat-map JSON plan storeRoot does not match stateRoot", cmPlan);
      const emptyClient = path.join(app, "empty-client");
      const emptyLocal = path.join(emptyClient, "local");
      fs.mkdirSync(emptyLocal, { recursive: true, mode: 0o700 });
      fs.chmodSync(emptyClient, 0o700);
      fs.chmodSync(emptyLocal, 0o700);
      const cmFallback = await pkgCli(["identity", "chat-map", "set", "--principal", principals.nora, "--harness", "claude", "--workspace", workspace, "--client-root", emptyClient, "--registry-root", registry, "--json"]);
      check(cmFallback.code === 0 && jsonOf(cmFallback)?.operation?.storeRoot === emptyLocal, "chat-map no-config fallback storeRoot mismatch", cmFallback);
      const cmNoTty = await pkgCli(["identity", "chat-map", "set", "--principal", principals.nora, "--harness", "claude", "--workspace", workspace, "--client-root", client, "--registry-root", registry, "--confirm", cmPlan.planId]);
      check(cmNoTty.code === 2, `chat-map --confirm without TTY exited ${cmNoTty.code}`, cmNoTty);
      const cmPlainPty = await pkgPty(["identity", "chat-map", "set", "--principal", principals.nora, "--harness", "claude", "--workspace", workspace, "--client-root", client, "--registry-root", registry, "--confirm", cmPlan.planId, "--json"]);
      check(/pty-exit: 1/.test(cmPlainPty.stderr) && /owner_approval_unavailable/.test(cmPlainPty.stdout + cmPlainPty.stderr), "plain build chat-map --confirm did not fail closed with owner_approval_unavailable", cmPlainPty);

      return {
        helpListsCommands: true,
        statusShowsDestinationRow: true,
        destinationPlansVerified: ["ready(nora)", "destination_target_has_runner(gravity2)", "destination_exists(rhea)"],
        chatMapStoreRootDefaultMatchesStateRoot: true,
        chatMapNoConfigFallbackVerified: true,
        plainBuildFailsClosedOwnerApprovalUnavailable: true,
      };
    });

    // ===================================================================== E. Rollback & restage determinism
    await step("E1", "journal post-stop checks, rollback-runtime, manual committed rollback, and deterministic candidate bundle ID", async () => {
      const jOff = lastJsonLine((await helper(currentBundle(), ["journal-check", stateRoot, "pre-off-1"])).stdout);
      const jGone = lastJsonLine((await helper(currentBundle(), ["journal-check", stateRoot, "pre-gone-1"])).stdout);
      const jRep = lastJsonLine((await helper(currentBundle(), ["journal-check", stateRoot, helperReplyId])).stdout);
      check(jOff?.found && jOff.phase === "queued_local", "pre-off-1 not queued_local on disk after stop", jOff);
      check(jGone?.found && jGone.phase === "held" && jGone.reason === "runtime_error", "pre-gone-1 not held(runtime_error) on disk after stop", jGone);
      check(jRep?.found === true && typeof jRep.inReplyTo === "string" && jRep.phase === null, "helper reply record missing or altered in journal after stop", jRep);

      const stagedBundlePath = currentBundle();
      const rb = await installer(["rollback-runtime", record1]);
      check(rb.code === 0, `rollback-runtime failed: ${rb.stderr}`, rb);
      check(Buffer.compare(fs.readFileSync(manifestPath()), oldManifestBytes) === 0, "rollback-runtime did not restore manifest byte-for-byte");
      check(!fs.existsSync(stagedBundlePath), "rollback-runtime left staged bundle on disk");

      // Re-stage & commit
      const s2 = await installer(["stage-runtime", "--application-root", app, "--project-root", cand, "--agent", "supervisor", "--node", oldNode]);
      check(s2.code === 0, `second stage-runtime failed: ${s2.stderr}`, s2);
      check(path.basename(currentBundle()) === candidateBundleId, "re-staged bundle id changed");
      check((await installer(["validate-runtime", "--manifest", manifestPath(), "--agent", "supervisor"])).code === 0, "second validate-runtime failed");
      const rec2Names = fs.readdirSync(path.join(app, "worker-runtime")).filter((n) => n.startsWith(".rollback-supervisor-"));
      check(rec2Names.length === 1, "missing second rollback record");
      check((await installer(["commit-runtime", path.join(app, "worker-runtime", rec2Names[0])])).code === 0, "commit-runtime failed");
      check(fs.readdirSync(path.join(app, "worker-runtime")).every((n) => !n.startsWith(".rollback-")), "leftover rollback record after commit");

      // Manual committed-install rollback (restore saved manifest + validate) -> re-stage again
      fs.writeFileSync(manifestPath(), oldManifestBytes, { mode: 0o600 });
      fs.chmodSync(manifestPath(), 0o600);
      check((await installer(["validate-runtime", "--manifest", manifestPath(), "--agent", "supervisor"])).code === 0, "manual rollback manifest failed validate-runtime");
      check(path.basename(currentBundle()) === oldBundleId, "manual rollback did not point back to baseline bundle");

      check((await installer(["stage-runtime", "--application-root", app, "--project-root", cand, "--agent", "supervisor", "--node", oldNode])).code === 0, "third stage-runtime failed");
      check(path.basename(currentBundle()) === candidateBundleId, "bundle id differed after manual rollback");
      const rec3Names = fs.readdirSync(path.join(app, "worker-runtime")).filter((n) => n.startsWith(".rollback-supervisor-"));
      check(rec3Names.length === 1 && (await installer(["commit-runtime", path.join(app, "worker-runtime", rec3Names[0])])).code === 0, "third commit-runtime failed");

      return {
        preOffQueuedLocal: true,
        preGoneHeldRuntimeError: true,
        helperReplyIntactOnDisk: true,
        stagedRollbackRestoredByteIdentical: true,
        manualRollbackRestoredBaseline: true,
        candidateBundleId,
      };
    });

    await step("Z1", "the installed application root is byte-for-byte untouched", async () => {
      const comparison = await compareLive();
      results.liveRoot = { identical: comparison.identical, compared: comparison.compared, differences: comparison.differences };
      check(comparison.identical, `installed root changed: ${comparison.differences.join(", ")}`, { before: comparison.before, after: comparison.after });
      return {
        compared: comparison.compared,
        hashedFiles: Object.keys(liveBefore.files).length,
        identityEntriesCompared: Object.keys(liveBefore.identityEntries).length,
        baselineBundleEntries: liveBefore.baselineBundleTree.entries,
        processesCompared: liveBefore.processes.length,
        identical: true,
      };
    });

    results.verdict = steps.every((s) => s.ok) ? "pass" : "fail";
  } catch (error) {
    if (!interrupted) {
      results.verdict = "fail";
      results.failure = { step: failedStep, message: error.message };
    }
  } finally {
    await finalize();
  }
  const warned = results.warnings.length;
  process.stdout.write(`\nverdict: ${results.verdict}  (${steps.filter((s) => s.ok).length}/${steps.length} steps${warned ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""})\n`);
  process.exitCode = interrupted ? 130 : results.verdict === "pass" ? 0 : 1;
  process.exit(process.exitCode);
}

main().catch((error) => {
  process.stderr.write(`rehearsal aborted: ${error.message}\n`);
  process.exit(2);
});
