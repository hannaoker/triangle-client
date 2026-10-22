// Every worker bundle (codex, hermes, antigravity) can host the coordinator
// (WorkerLauncher.resolveCoordinator picks the first resolvable instance's
// bundle), so each v7 artifact set must contain the full static import closure
// of client-supervisor-cli.mjs plus the worker's own runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const installer = path.join(repoRoot, "scripts/triangle-worker-install.py");
const python = existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";

function expectedArtifacts(agent) {
  const code = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('twi', sys.argv[1])",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "print(json.dumps(m.expected_artifacts(sys.argv[2], m.CURRENT_MANIFEST_VERSION)))",
  ].join("\n");
  return new Set(JSON.parse(execFileSync(python, ["-c", code, installer, agent], { encoding: "utf8" })));
}

function importClosure(entryRelative) {
  const seen = new Set();
  const queue = [entryRelative];
  const pattern = /(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|^\s*import\s*["'](\.{1,2}\/[^"']+)["']/gm;
  while (queue.length) {
    const relative = queue.pop();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const source = readFileSync(path.join(repoRoot, relative), "utf8");
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      queue.push(resolved);
    }
  }
  return seen;
}

for (const agent of ["codex", "hermes", "antigravity"]) {
  test(`current-manifest ${agent} bundle contains every module the coordinator, its runner and the worker CLI import`, () => {
    const artifacts = expectedArtifacts(agent);
    const needed = new Set([
      ...importClosure("packages/agent-worker/src/client-supervisor-cli.mjs"),
      ...importClosure(`packages/agent-worker/runners/${agent}-runner.mjs`),
      ...importClosure("packages/agent-worker/src/cli.mjs"),
      ...importClosure("packages/agent-worker/src/local-messaging-cli.mjs"),
      ...importClosure("packages/agent-worker/src/local-messaging-host.mjs"),
    ]);
    const missing = [...needed].filter((relative) => !artifacts.has(relative)).sort();
    assert.deepEqual(missing, [], `${agent} bundle missing coordinator/runner imports`);
  });
}

test("Swift launcher requires codex-runtime in every v7+ bundle and the workload core in v8 (mirrors installer)", () => {
  const swift = readFileSync(
    path.join(repoRoot, "packages/macos-mailbox-helper/Sources/TriangleMailboxCore/WorkerLauncher.swift"),
    "utf8",
  );
  assert.match(swift, /if worker == \.codex \|\| manifestVersion >= 7 \{\s*artifacts\.formUnion\(\[\s*"packages\/agent-worker\/src\/codex-runtime\//);
  const code = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('twi', sys.argv[1])",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "print(json.dumps(m.WORKLOAD_CORE_ARTIFACTS))",
  ].join("\n");
  const core = JSON.parse(execFileSync(python, ["-c", code, installer], { encoding: "utf8" }));
  const v8 = /if manifestVersion >= 8 \{\s*artifacts\.formUnion\(\[([^\]]*)\]\)/.exec(swift);
  assert.ok(v8, "Swift v8 block");
  assert.deepEqual([...v8[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...core].sort());
});

test("installer runtime roots for antigravity include both agy state directories", () => {
  const home = mkdtempSync(path.join(tmpdir(), "triangle-agy-roots-"));
  try {
    const bin = path.join(home, ".local", "bin");
    for (const directory of [bin, path.join(home, ".gemini", "antigravity-cli"), path.join(home, ".gemini", "config")]) {
      mkdirSync(directory, { recursive: true });
    }
    const cli = path.join(bin, "agy");
    writeFileSync(cli, "#!/bin/sh\nexit 0\n");
    chmodSync(cli, 0o755);
    const code = [
      "import importlib.util, sys",
      "spec = importlib.util.spec_from_file_location('twi', sys.argv[1])",
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "print(m.discover_runtime_roots('antigravity', sys.argv[2]))",
    ].join("\n");
    const roots = execFileSync(python, ["-c", code, installer, cli], { encoding: "utf8", env: { ...process.env, HOME: home } })
      .trim().split(":");
    const real = realpathSync(home);
    assert.ok(roots.includes(path.join(real, ".gemini", "antigravity-cli")), roots.join(":"));
    assert.ok(roots.includes(path.join(real, ".gemini", "config")), roots.join(":"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Swift launcher marks both agy state directories writable (mirrors installer)", () => {
  const swift = readFileSync(
    path.join(repoRoot, "packages/macos-mailbox-helper/Sources/TriangleMailboxCore/WorkerLauncher.swift"),
    "utf8",
  );
  assert.match(swift, /for name in \["antigravity-cli", "config"\]/);
  assert.match(swift, /TRIANGLE_WRITABLE_RUNTIME_ROOTS"\] = writable\.joined\(separator: ":"\)/);
});

test("production supervisor closure contains no peer modules", () => {
  const closure = importClosure("packages/agent-worker/src/client-supervisor-cli.mjs");
  for (const relative of closure) {
    assert.ok(
      !path.basename(relative).startsWith("peer-") && !relative.split("/").includes("peer"),
      `production supervisor closure must not include peer module: ${relative}`,
    );
  }
});

test("v9 packages installed messaging in every harness and retains v8 supervisor manifests", () => {
  const code = ["import importlib.util,json,sys", "spec=importlib.util.spec_from_file_location('twi',sys.argv[1])", "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)", "print(json.dumps({'version':m.CURRENT_MANIFEST_VERSION,'legacy':m.expected_artifacts('supervisor',8)}))"].join("\n");
  const contract=JSON.parse(execFileSync(python,["-c",code,installer],{encoding:"utf8"}));
  assert.equal(contract.version,9);
  assert.ok(!contract.legacy.some(p=>p.includes('local-messaging')));
  for(const agent of ['codex','hermes','antigravity','supervisor']) {
    const artifacts=expectedArtifacts(agent);
    for(const name of ['shared-delivery-journal','local-messaging-cli','local-messaging-host','local-messaging-journal','local-messaging-dispatcher','local-messaging-auth-broker']) assert.ok(artifacts.has(`packages/agent-worker/src/${name}.mjs`),`${agent} missing ${name}`);
  }
});

test("installed local wrapper refuses unrelated replacements and validates manifest before execution", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "triangle-local-wrapper-")));
  try {
    chmodSync(root, 0o700);
    mkdirSync(path.join(root, "bin"), { mode: 0o700 });
    const wrapper = path.join(root, "bin", "triangle-local");
    writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    assert.throws(() => execFileSync(python, [installer, "install-local-wrapper", "--application-root", root], { stdio: "pipe" }), /Command failed/);
    assert.match(readFileSync(wrapper, "utf8"), /exit 0/);
    rmSync(wrapper);
    execFileSync(python, [installer, "install-local-wrapper", "--application-root", root]);
    assert.match(readFileSync(wrapper, "utf8"), /TRIANGLE_MANAGED_LOCAL_WRAPPER_V1/);
    execFileSync(python, [installer, "install-local-wrapper", "--application-root", root]);
    assert.throws(() => execFileSync(python, [wrapper, "discover"], { stdio: "pipe" }), /Command failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installed local wrapper executes only the verified packaged CLI and rejects tampering", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "triangle-local-exec-")));
  try {
    chmodSync(root, 0o700);
    const project = path.join(root, "source");
    mkdirSync(project, { mode: 0o700 });
    for (const relative of expectedArtifacts("supervisor")) {
      const target = path.join(project, relative);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, relative.endsWith("local-messaging-cli.mjs") ? 'console.log(JSON.stringify(process.argv.slice(2)));\n' : "// fixture\n", { mode: 0o600 });
    }
    const app = path.join(root, "app");
    mkdirSync(app, { mode: 0o700 });
    mkdirSync(path.join(app, "worker-runtime"), { mode: 0o700 });
    execFileSync(python, [installer, "stage-runtime", "--application-root", app, "--project-root", project, "--agent", "supervisor", "--node", process.execPath], { stdio: "pipe" });
    execFileSync(python, [installer, "install-local-wrapper", "--application-root", app], { stdio: "pipe" });
    const wrapper = path.join(app, "bin", "triangle-local");
    assert.deepEqual(JSON.parse(execFileSync(wrapper, ["send", "a space", "$(literal)"], { encoding: "utf8" })), ["send", "a space", "$(literal)"]);
    const manifest = JSON.parse(readFileSync(path.join(app, "worker-runtime", "supervisor.manifest.json"), "utf8"));
    writeFileSync(path.join(manifest.projectRoot, "packages/agent-worker/src/local-messaging-cli.mjs"), "throw Error('tampered')\n");
    assert.throws(() => execFileSync(wrapper, ["discover"], { stdio: "pipe" }), /Command failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
