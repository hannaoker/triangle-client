import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(root, "scripts/macos/cutover-headless-supervisor.sh");

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function instanceId(profile) {
  return crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from("triangle-client-instance-v1\0"),
    Buffer.from(profile),
  ])).digest("hex");
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "headless-cutover-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.chmodSync(home, 0o700);
  const app = path.join(home, "Library", "Application Support", "The Triangle");
  const client = path.join(app, "client");
  const bin = path.join(app, "bin");
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  const tools = path.join(home, "tools");
  for (const directory of [client, bin, launchAgents, tools]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }

  const workdir = path.join(home, "work");
  const codexHome = path.join(app, "codex-home", "codex-headless");
  const stateRoot = path.join(app, "model-state", "headless-drain", "codex-headless");
  const command = path.join(bin, "codex");
  fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.chmodSync(command, 0o700);
  const helper = path.join(bin, "triangle-mailbox");
  fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.chmodSync(helper, 0o700);

  const agentsPath = path.join(home, "agents.json");
  const agents = {
    version: 1,
    operation: "list",
    agents: [
      {
        profile: "codex-headless",
        instanceId: instanceId("codex-headless"),
        runtimeAdapter: "codex",
        enabled: true,
        deliveryMode: "headless-app-server",
      },
      {
        profile: "codex-bob-test",
        instanceId: instanceId("codex-bob-test"),
        runtimeAdapter: "codex",
        enabled: true,
        deliveryMode: "mcp-interactive",
      },
      {
        profile: "bob",
        instanceId: instanceId("bob"),
        runtimeAdapter: "grok-bot",
        enabled: true,
        deliveryMode: "grok-bot",
      },
    ],
  };
  fs.writeFileSync(agentsPath, `${JSON.stringify(agents)}\n`, { mode: 0o600 });

  const clientBin = path.join(tools, "triangle-client");
  fs.writeFileSync(clientBin, `#!/bin/bash
set -euo pipefail
store="${agentsPath}"
if [[ "\${1:-}" == agent && "\${2:-}" == list ]]; then
  cat "\$store"
  exit 0
fi
if [[ "\${1:-}" == agent && "\${2:-}" == set-delivery-mode ]]; then
  profile=""
  mode=""
  shift 2
  while [[ \$# -gt 0 ]]; do
    case "\$1" in
      --profile) profile=\$2; shift 2 ;;
      --mode) mode=\$2; shift 2 ;;
      *) shift ;;
    esac
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
    raise SystemExit(f"unknown profile {profile}")
open(path, "w", encoding="utf-8").write(json.dumps(doc) + "\\n")
PY
  exit 0
fi
exit 64
`, { mode: 0o700 });
  fs.chmodSync(clientBin, 0o700);

  const stateDir = path.join(home, "launchctl-state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const launchctlLog = path.join(home, "launchctl.log");
  const launchctl = path.join(tools, "launchctl");
  fs.writeFileSync(launchctl, `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "${launchctlLog}"
command=\$1
target=\${2:-}
if [[ "\$command" == bootstrap ]]; then
  label=\$(basename "\$3" .plist)
  /usr/bin/touch "${stateDir}/\$label"
elif [[ "\$command" == bootout ]]; then
  label=\${target##*/}
  /bin/rm -f "${stateDir}/\$label"
elif [[ "\$command" == print ]]; then
  label=\${target##*/}
  [[ -f "${stateDir}/\$label" ]] || exit 113
fi
exit 0
`, { mode: 0o700 });
  fs.chmodSync(launchctl, 0o700);

  fs.writeFileSync(path.join(client, "installation.json"), `${JSON.stringify({
    version: 1,
    installationId: "inst_N7VhDq3mQ2",
  })}\n`, { mode: 0o600 });

  const drainPlist = path.join(launchAgents, "dev.thetriangle.codex-headless-drain.codex-headless.plist");
  fs.writeFileSync(drainPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.thetriangle.codex-headless-drain.codex-headless</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/tmp/headless-drain-cli.mjs</string>
    <string>--profile</string><string>codex-headless</string>
    <string>--room-id</string><string>room_8594d12312e14afbb291fcff60a22048</string>
    <string>--working-directory</string><string>${workdir}</string>
    <string>--codex-home</string><string>${codexHome}</string>
    <string>--codex-cli</string><string>${command}</string>
    <string>--helper</string><string>${helper}</string>
    <string>--state-root</string><string>${stateRoot}</string>
  </array>
</dict>
</plist>
`, { mode: 0o600 });

  fs.writeFileSync(path.join(launchAgents, "dev.thetriangle.client.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>dev.thetriangle.client</string></dict></plist>
`, { mode: 0o600 });

  fs.writeFileSync(path.join(stateDir, "dev.thetriangle.codex-headless-drain.codex-headless"), "");
  fs.writeFileSync(path.join(stateDir, "dev.thetriangle.shared-app-server"), "");
  fs.writeFileSync(path.join(stateDir, "dev.thetriangle.client"), "");

  fs.writeFileSync(path.join(client, "headless-claimer.codex-headless.json"), `${JSON.stringify({
    version: 1,
    profile: "codex-headless",
    owner: "dev.thetriangle.codex-headless-drain",
    pid: 4242,
  })}\n`, { mode: 0o600 });

  return {
    home,
    app,
    client,
    agentsPath,
    launchctlLog,
    drainPlist,
    workdir,
    codexHome,
    stateRoot,
    command,
    env: {
      HOME: home,
      PATH: `${tools}:${process.env.PATH}`,
      TRIANGLE_TEST_MODE: "1",
      TRIANGLE_CLIENT: clientBin,
      TRIANGLE_LAUNCHCTL: launchctl,
      TRIANGLE_FAKE_UID: "501",
      TRIANGLE_HEADLESS_PROFILE: "codex-headless",
    },
  };
}

function run(action, env) {
  return spawnSync("bash", [script, action], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("plan refuses Linux hosts without TRIANGLE_TEST_MODE", () => {
  const result = spawnSync("bash", [script, "plan"], {
    env: { ...process.env, HOME: "/tmp", TRIANGLE_TEST_MODE: "" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /macOS-only/);
});

test("plan refuses a room pin in the environment", (t) => {
  const f = fixture(t);
  const result = run("plan", { ...f.env, TRIANGLE_HEADLESS_ROOM_ID: "room_77" });
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /room pin/);
});

test("plan refuses grok-bot as the headless drain profile", (t) => {
  const f = fixture(t);
  const result = run("plan", { ...f.env, TRIANGLE_HEADLESS_PROFILE: "bob" });
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /grok_bot_not_in_codex_pool/);
});

test("plan flips remaining mcp-interactive Codex and leaves grok-bot untouched", (t) => {
  const f = fixture(t);
  const result = run("plan", f.env);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.flip, [{
    profile: "codex-bob-test",
    from: "mcp-interactive",
    to: "headless-app-server",
  }]);
  assert.equal(plan.stopSharedAppServer, true);
  assert.equal(plan.bootoutDedicatedDrain, true);
  assert.equal(plan.binding.profile, "codex-headless");
  assert.equal(plan.binding.workingDirectory, f.workdir);
  assert.equal(plan.binding.codexHome, f.codexHome);
  assert.equal(plan.binding.stateRoot, f.stateRoot);
  assert.equal(plan.binding.command, f.command);
  assert.equal("allowedRoomId" in plan.binding, false);
  assert.doesNotMatch(result.stdout, /allowedRoomId|room_77/);
  assert.deepEqual(plan.grokUntouched, [{
    profile: "bob",
    deliveryMode: "grok-bot",
    runtimeAdapter: "grok-bot",
  }]);
});

test("apply writes an unpinned binding, stops desktop, flips Codex, and bootouts the dedicated drain first", (t) => {
  const f = fixture(t);
  const result = run("apply", f.env);
  assert.equal(result.status, 0, result.stderr);

  const agents = JSON.parse(fs.readFileSync(f.agentsPath, "utf8"));
  const byProfile = Object.fromEntries(agents.agents.map((agent) => [agent.profile, agent]));
  assert.equal(byProfile["codex-headless"].deliveryMode, "headless-app-server");
  assert.equal(byProfile["codex-bob-test"].deliveryMode, "headless-app-server");
  assert.equal(byProfile.bob.deliveryMode, "grok-bot");
  assert.equal(byProfile.bob.runtimeAdapter, "grok-bot");

  const bindingPath = path.join(f.client, "headless-runtime-binding.json");
  const binding = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
  assert.equal(mode(bindingPath), 0o600);
  assert.equal("allowedRoomId" in binding, false);
  assert.equal(binding.adapterVersion, "1");
  assert.equal(binding.enabled, true);
  assert.equal(binding.profile, "codex-headless");
  assert.equal(binding.installationId, "inst_N7VhDq3mQ2");
  assert.equal(binding.instanceId, instanceId("codex-headless"));
  assert.equal(binding.pollIntervalMs, 1000);
  assert.doesNotMatch(fs.readFileSync(bindingPath, "utf8"), /allowedRoomId|room_77|room_8594/);

  assert.equal(fs.existsSync(f.drainPlist), false);
  assert.equal(fs.existsSync(path.join(f.client, "headless-claimer.codex-headless.json")), false);

  const log = fs.readFileSync(f.launchctlLog, "utf8");
  const bootoutClient = log.indexOf("bootout gui/501/dev.thetriangle.client");
  const bootoutDrain = log.indexOf("bootout gui/501/dev.thetriangle.codex-headless-drain.codex-headless");
  const bootoutShared = log.indexOf("bootout gui/501/dev.thetriangle.shared-app-server");
  const bootstrapClient = log.indexOf("bootstrap gui/501 ");
  assert.ok(bootoutShared >= 0, "shared-app-server must stop before flipping mcp-interactive");
  assert.ok(bootoutClient >= 0, "client must bootout before dedicated drain removal");
  assert.ok(bootoutDrain > bootoutClient, "dedicated drain must bootout after client");
  assert.ok(bootstrapClient > bootoutDrain, "client must start only after dedicated drain is gone");
});
