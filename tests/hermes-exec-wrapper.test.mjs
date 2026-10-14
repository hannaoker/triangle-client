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
