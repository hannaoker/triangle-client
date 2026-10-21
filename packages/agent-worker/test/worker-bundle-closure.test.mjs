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
  const v8 = /if manifestVersion == 8 \{\s*artifacts\.formUnion\(\[([^\]]*)\]\)/.exec(swift);
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
