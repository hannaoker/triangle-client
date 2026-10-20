import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const installer = path.join(root, "scripts/triangle-worker-install.py");
const python = process.platform === "darwin" ? "/usr/bin/python3" : "python3";

function target(wrapper) {
  const program = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('twi', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
    "print(json.dumps(module.hermes_exec_target(sys.stdin.read())))",
  ].join("\n");
  const result = spawnSync(python, ["-c", program, installer], { input: wrapper, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Hermes wrapper accepts quoted absolute exec target", () => {
  assert.equal(target('#!/bin/bash\nexec "/Users/me/.hermes/venv/bin/hermes" "$@"\n'), "/Users/me/.hermes/venv/bin/hermes");
  assert.equal(target('#!/bin/bash\nexec "/Users/me/Hermes Agent/venv/bin/hermes" "$@"\n'), "/Users/me/Hermes Agent/venv/bin/hermes");
});

test("Hermes wrapper accepts unquoted absolute exec target", () => {
  assert.equal(target('#!/bin/bash\nexec /Users/me/.hermes/hermes-agent/venv/bin/hermes "$@"\n'), "/Users/me/.hermes/hermes-agent/venv/bin/hermes");
  assert.equal(target("#!/bin/sh\nexec  /opt/hermes/bin/hermes   \"$@\"  \n"), "/opt/hermes/bin/hermes");
});

test("Hermes wrapper rejects unsafe or ambiguous exec forms", () => {
  for (const wrapper of [
    '#!/bin/bash\nexec hermes "$@"\n', // relative
    '#!/bin/bash\nexec ~/bin/hermes "$@"\n', // tilde expansion
    '#!/bin/bash\nexec $HOME/bin/hermes "$@"\n', // variable expansion
    '#!/bin/bash\nexec "$HOME/bin/hermes" "$@"\n', // quoted variable
    '#!/bin/bash\nexec /opt/$(id -u)/hermes "$@"\n', // substitution
    '#!/bin/bash\nexec /opt/`id`/hermes "$@"\n', // backticks
    '#!/bin/bash\nexec /opt/he*mes "$@"\n', // glob
    '#!/bin/bash\nexec /opt/my hermes "$@"\n', // word splitting
    '#!/bin/bash\nexec /opt/hermes;rm "$@"\n', // command separator
    '#!/bin/bash\nexec /opt/../tmp/hermes "$@"\n', // traversal
    '#!/bin/bash\nexec /opt/hermes $@\n', // unquoted args
    '#!/bin/bash\nexec /opt/hermes "$@" --extra\n', // trailing args
    "#!/bin/bash\nexec '/opt/hermes' \"$@\"\n", // single quotes not supported
    '#!/bin/bash\nexec /opt/a/hermes "$@"\nexec /opt/b/hermes "$@"\n', // ambiguous
    '#!/bin/bash\necho hi\n',
  ]) {
    assert.equal(target(wrapper), null, wrapper);
  }
});

test("runtime and installer agree on Hermes wrapper syntax", async () => {
  const { hermesExecTarget } = await import("../packages/agent-worker/runners/runner-common.mjs");
  for (const wrapper of [
    '#!/bin/sh\nexec /opt/hermes/.hermes/bin/hermes "$@"\n',
    '#!/bin/sh\nexec "/opt/Hermes Agent/venv/bin/hermes" "$@"\n',
    '#!/bin/sh\nexec "$HOME/hermes" "$@"\n',
    '#!/bin/sh\nexec /opt/hermes "$@"\nexec /opt/other "$@"\n',
  ]) assert.equal(hermesExecTarget(wrapper), target(wrapper));
});

test("managed Hermes resolves only selected installation generation", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createHash } = await import("node:crypto");
  const { managedHermesRuntime } = await import("../packages/agent-worker/runners/runner-common.mjs");
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "hermes-managed-")));
  try {
    const source = path.join(base, "hermes-agent");
    const entry = path.join(source, ".hermes/bin/hermes");
    mkdirSync(path.dirname(entry), { recursive: true });
    const key = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const install = path.join(base, "installs", key);
    const venv = path.join(install, "environments", "generation", "venv");
    const workspace = path.join(path.dirname(venv), "workspace");
    mkdirSync(venv, { recursive: true }); mkdirSync(workspace);
    const facts = path.join(install, "facts.json");
    writeFileSync(facts, JSON.stringify({ packages: { venv: { environment: venv } } }));
    const pinnedPython = path.join(base, "tools", "python-fixture", "bin", "python3");
    mkdirSync(path.dirname(pinnedPython), { recursive: true });
    const { chmodSync, symlinkSync } = await import("node:fs");
    writeFileSync(`${pinnedPython}.14`, "fixture"); chmodSync(`${pinnedPython}.14`, 0o755);
    symlinkSync("python3.14", pinnedPython);
    const launcher = `#!/bin/sh\nexec ${pinnedPython} -I -c 'opaque bootstrap never evaluated' "$@"\n`;
    assert.deepEqual(managedHermesRuntime(entry, launcher), { source, venv, workspace, python: pinnedPython });
    const program = "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('t',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.managed_hermes_runtime(sys.argv[2],sys.stdin.read())))";
    const resolved = spawnSync(python, ["-c", program, installer, entry], { input: launcher, encoding: "utf8" });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.deepEqual(JSON.parse(resolved.stdout), [source, venv, workspace, `${pinnedPython}.14`]);
    writeFileSync(facts, JSON.stringify({ packages: { venv: { environment: base } } }));
    assert.throws(() => managedHermesRuntime(entry, launcher), /escapes/);
    assert.notEqual(spawnSync(python, ["-c", program, installer, entry], { input: launcher, encoding: "utf8" }).status, 0);
    assert.throws(() => managedHermesRuntime(entry, '#!/bin/sh\nexec /bin/sh "$@"\n'), /interpreter/);
    assert.throws(() => managedHermesRuntime(entry, '#!/bin/sh\nexec /bin/sh -I -c \'opaque\' "$@"\n'), /tool store/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
