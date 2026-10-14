import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(root, "scripts/macos/enable-headless-engagement.sh");

function instanceId(profile) {
  return crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from("triangle-client-instance-v1\0"),
    Buffer.from(profile),
  ])).digest("hex");
}

function fixture(t, { agents } = {}) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "enable-headless-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.chmodSync(home, 0o700);
  const app = path.join(home, "Library", "Application Support", "The Triangle");
  const client = path.join(app, "client");
  const bin = path.join(app, "bin");
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  const tools = path.join(home, "tools");
  for (const directory of [client, bin, launchAgents, tools]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const workdir = path.join(home, "work");
  const codexHome = path.join(app, "codex-home");
  const command = path.join(bin, "codex");
  fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const helper = path.join(bin, "triangle-mailbox");
  fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  const agentsPath = path.join(home, "agents.json");
  const document = {
    version: 1,
    operation: "list",
    agents: agents ?? [
      {
        profile: "bob",
        instanceId: instanceId("bob"),
        runtimeAdapter: "codex",
        enabled: true,
        deliveryMode: "headless-app-server",
      },
      {
        profile: "interactive",
        instanceId: instanceId("interactive"),
        runtimeAdapter: "codex",
        enabled: true,
        deliveryMode: "mcp-interactive",
      },
      {
        profile: "legacy-grok",
        instanceId: instanceId("legacy-grok"),
        runtimeAdapter: "grok-bot",
        enabled: true,
        deliveryMode: "grok-bot",
      },
      {
        profile: "other-headless",
        instanceId: instanceId("other-headless"),
        runtimeAdapter: "codex",
        enabled: true,
        deliveryMode: "event-driven",
      },
    ],
  };
  fs.writeFileSync(agentsPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(client, "installation.json"),
    `${JSON.stringify({ installationId: "inst_testenable0001" })}\n`,
    { mode: 0o600 },
  );

  // Unrelated binding profile to preserve.
  fs.writeFileSync(
    path.join(client, "headless-runtime-binding.json"),
    `${JSON.stringify({
      version: 2,
      common: {
        adapterVersion: "1",
        installationId: "inst_testenable0001",
        workingDirectory: workdir,
        codexHome,
        command,
        pollIntervalMs: 30000,
      },
      profiles: [
        {
          profile: "unrelated",
          instanceId: instanceId("unrelated"),
          stateRoot: path.join(app, "model-state", "headless-drain", "unrelated"),
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );

  const clientBin = path.join(tools, "triangle-client");
  fs.writeFileSync(clientBin, `#!/bin/bash
set -euo pipefail
store="${agentsPath}"
if [[ "\${1:-}" == agent && "\${2:-}" == list ]]; then
  cat "\$store"
  exit 0
fi
if [[ "\${1:-}" == agent && "\${2:-}" == set-delivery-mode ]]; then
  profile=""; mode=""; shift 2
  while [[ \$# -gt 0 ]]; do
    case "\$1" in --profile) profile=\$2; shift 2 ;; --mode) mode=\$2; shift 2 ;; *) shift ;; esac
  done
  /usr/bin/python3 - "\$store" "\$profile" "\$mode" <<'PY'
import json, sys
path, profile, mode = sys.argv[1:]
doc = json.load(open(path, encoding="utf-8"))
for agent in doc["agents"]:
    if agent["profile"] == profile:
        agent["deliveryMode"] = mode
        break
else:
    raise SystemExit(1)
open(path, "w", encoding="utf-8").write(json.dumps(doc) + "\\n")
PY
  exit 0
fi
if [[ "\${1:-}" == agent && "\${2:-}" == set-runtime ]]; then
  profile=""; runtime=""; shift 2
  while [[ \$# -gt 0 ]]; do
    case "\$1" in --profile) profile=\$2; shift 2 ;; --runtime) runtime=\$2; shift 2 ;; *) shift ;; esac
  done
  /usr/bin/python3 - "\$store" "\$profile" "\$runtime" <<'PY'
import json, sys
path, profile, runtime = sys.argv[1:]
doc = json.load(open(path, encoding="utf-8"))
for agent in doc["agents"]:
    if agent["profile"] == profile:
        agent["runtimeAdapter"] = runtime
        break
else:
    raise SystemExit(1)
open(path, "w", encoding="utf-8").write(json.dumps(doc) + "\\n")
PY
  exit 0
fi
exit 64
`, { mode: 0o700 });

  const stateDir = path.join(home, "launchctl-state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const launchctlLog = path.join(home, "launchctl.log");
  const launchctl = path.join(tools, "launchctl");
  fs.writeFileSync(launchctl, `#!/bin/bash
set -euo pipefail
echo "\$*" >> "${launchctlLog}"
cmd=\$1; shift || true
case "\$cmd" in
  print)
    target=\$1
    label=\${target##*/}
    [[ -f "${stateDir}/\$label" ]] || exit 1
    ;;
  bootstrap)
    domain=\$1; plist=\$2
    label=\$(/usr/bin/basename "\$plist" .plist)
    /usr/bin/touch "${stateDir}/\$label"
    # Simulate ready generation advance.
    /usr/bin/python3 - <<PY
import json, pathlib, time, uuid
ready = pathlib.Path(${JSON.stringify(path.join(client, "ready.json"))})
ready.write_text(json.dumps({
  "version": 1,
  "generation": str(uuid.uuid4()),
  "parentPid": 1,
  "configDigest": "d",
  "readyAtMilliseconds": int(time.time()*1000),
}) + "\\n")
PY
    ;;
  bootout)
    target=\$1
    label=\${target##*/}
    /bin/rm -f "${stateDir}/\$label"
    ;;
  *) exit 0 ;;
esac
`, { mode: 0o700 });

  fs.writeFileSync(
    path.join(launchAgents, "dev.thetriangle.client.plist"),
    `<?xml version="1.0"?><plist><dict><key>Label</key><string>dev.thetriangle.client</string></dict></plist>\n`,
    { mode: 0o600 },
  );

  return {
    home,
    client,
    env: {
      ...process.env,
      HOME: home,
      TRIANGLE_TEST_MODE: "1",
      TRIANGLE_UNAME_S: "Darwin",
      TRIANGLE_CLIENT: clientBin,
      TRIANGLE_MAILBOX_HELPER: helper,
      TRIANGLE_LAUNCHCTL: launchctl,
      TRIANGLE_CODEX_HOME: codexHome,
      CODEX_CLI: command,
      TRIANGLE_HEADLESS_WORKING_DIRECTORY: workdir,
      TRIANGLE_FAKE_UID: "501",
    },
  };
}

function run(args, env) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8", env });
}

test("plan selects unattended defaults and skips mcp-interactive", () => {
  const { env } = fixture(test);
  const result = run(["plan"], env);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.selectedProfiles.sort(), ["bob", "other-headless"]);
  assert.ok(plan.warnings.some((row) => row.code === "mcp_interactive_skipped"));
  assert.deepEqual(plan.preserveUnrelatedProfiles, ["unrelated"]);
});

test("plan include-interactive and migrate-from-grok widen selection", () => {
  const { env } = fixture(test);
  const result = run([
    "plan",
    "--include-interactive",
    "interactive",
    "--migrate-from-grok",
    "legacy-grok",
  ], env);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.ok(plan.selectedProfiles.includes("interactive"));
  assert.ok(plan.selectedProfiles.includes("legacy-grok"));
  assert.ok(plan.runtimeFlips.some((row) => row.profile === "legacy-grok" && row.to === "codex"));
  assert.equal(plan.webhookBinding, "left_disabled");
});

test("apply is idempotent and preserves unrelated binding profiles", () => {
  const { env, client } = fixture(test);
  const first = run(["apply"], env);
  assert.equal(first.status, 0, first.stderr);
  const binding1 = JSON.parse(fs.readFileSync(path.join(client, "headless-runtime-binding.json"), "utf8"));
  assert.ok(binding1.profiles.some((row) => row.profile === "unrelated"));
  assert.ok(binding1.profiles.some((row) => row.profile === "bob"));

  const second = run(["apply"], env);
  assert.equal(second.status, 0, second.stderr);
  const binding2 = JSON.parse(fs.readFileSync(path.join(client, "headless-runtime-binding.json"), "utf8"));
  assert.deepEqual(
    binding2.profiles.map((row) => row.profile).sort(),
    binding1.profiles.map((row) => row.profile).sort(),
  );
});

test("concurrent apply fails closed on configuration lock", () => {
  const { env, client } = fixture(test);
  const lockDir = path.join(client, ".enable-headless-engagement.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`);
  const result = run(["apply"], env);
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /configuration lock/);
});
