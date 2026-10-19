import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  chmodSync,
  symlinkSync,
  existsSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSetupRuntime,
  profileInstanceId,
  stageRuntimeBundle,
} from "../src/setup-runtime.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
function fixture() {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "triangle-setup-runtime-")),
  );
  const account = path.join(root, "account");
  const app = path.join(account, "Library/Application Support/The Triangle");
  const release = path.join(root, "release");
  for (const dir of [
    account,
    app,
    path.join(app, "bin"),
    path.join(app, "client/instances"),
    path.join(app, "worker-runtime"),
    path.join(app, "profiles-v1"),
    path.join(release, "bin"),
    path.join(release, "packages/agent-worker/src"),
    path.join(account, "native-bin"),
    path.join(account, ".codex"),
  ])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ["triangle-mailbox", "triangle-client"])
    writeFileSync(path.join(app, "bin", name), "fake helper", { mode: 0o700 });
  writeFileSync(path.join(release, "bin/node"), "fake node", { mode: 0o700 });
  for (const name of ["codex", "hermes", "agy", "cursor-agent"])
    writeFileSync(path.join(account, "native-bin", name), "#!/bin/sh\n", {
      mode: 0o700,
    });
  writeFileSync(
    path.join(account, ".codex/auth.json"),
    '{"fake":"test credential"}',
    { mode: 0o600 },
  );
  const artifact = "packages/agent-worker/src/client-supervisor-cli.mjs";
  writeFileSync(path.join(release, artifact), "// fixture\n", { mode: 0o600 });
  writeFileSync(
    path.join(release, "worker-artifacts.json"),
    JSON.stringify({
      version: 8,
      kinds: Object.fromEntries(
        ["codex", "hermes", "antigravity", "supervisor"].map((k) => [
          k,
          [artifact],
        ]),
      ),
    }),
    { mode: 0o600 },
  );
  const releaseFiles = ["bin/node", artifact, "worker-artifacts.json"];
  writeFileSync(
    path.join(release, "package-manifest.json"),
    JSON.stringify({
      schema: 1,
      files: releaseFiles.map((p) => ({
        path: p,
        size: readFileSync(path.join(release, p)).length,
        sha256: hash(readFileSync(path.join(release, p))),
        mode: p.startsWith("bin/") ? 0o700 : 0o600,
      })),
    }),
    { mode: 0o600 },
  );
  const calls = [];
  let registered = false;
  let running = false;
  let bound = false;
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    let data = {};
    if (args[0] === "status")
      data = {
        status: "verified",
        agentId: "agent_" + "a".repeat(32),
        handle: "test-agent",
      };
    if (args[0] === "bind") {
      bound = true;
      data = { status: "verified", agentId: "agent_" + "a".repeat(32) };
    }
    if (args[0] === "agent" && args[1] === "add") {
      registered = true;
      running = true;
      data = {
        agents: [
          { profile: "test-agent", runtimeAdapter: args.at(-1), enabled: true },
        ],
      };
    }
    if (args[0] === "agent" && args[1] === "enable") {
      running = true;
      data = {};
    }
    if (args[0] === "print")
      return {
        code: running ? 0 : 1,
        stdout: running ? "state = running\npid = 1" : "",
        stderr: "",
      };
    return { code: 0, stdout: JSON.stringify(data), stderr: "" };
  };
  const owner = path.join(app, "v1");
  const id = "agent_" + "a".repeat(32);
  const keyFile = path.join(owner, "agents", id, "workload-key.json");
  mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, "{}", { mode: 0o600 });
  writeFileSync(
    path.join(path.dirname(keyFile), "agent.json"),
    JSON.stringify({ agent_id: id, handle: "test-agent" }),
    { mode: 0o600 },
  );
  return {
    root,
    account,
    app,
    release,
    calls,
    run,
    keyFile,
    owner,
    id,
    options: {
      profile: "test-agent",
      harness: "codex",
      workdir: account,
      home: owner,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("preflight rejects missing harness before writing runtime/profile files", async () => {
  const f = fixture();
  try {
    const r = createSetupRuntime({
      accountHome: f.account,
      releaseRoot: f.release,
      platform: "darwin",
      env: { PATH: "/missing" },
      run: f.run,
    });
    await assert.rejects(r.preflight(f.options), /Codex|codex/);
    assert.equal(f.calls.length, 0);
    assert.equal(
      existsSync(path.join(f.app, "worker-runtime/supervisor.manifest.json")),
      false,
    );
  } finally {
    f.cleanup();
  }
});
test("Cursor selects explicit cursor-agent and stages a genuine supervisor host without Codex", async () => {
  const f = fixture();
  try {
    rmSync(path.join(f.account, "native-bin/codex"));
    const r = createSetupRuntime({
      accountHome: f.account,
      releaseRoot: f.release,
      platform: "darwin",
      env: { PATH: path.join(f.account, "native-bin") },
      run: f.run,
    });
    const options = { ...f.options, harness: "cursor" };
    await r.preflight(options);
    const result = await r.configure({
      ...options,
      agent: { agent_id: f.id },
      keyFile: f.keyFile,
    });
    assert.equal(result.state, "running");
    const binding = JSON.parse(
      readFileSync(path.join(f.app, "client/cursor-acp-runtime-binding.json")),
    );
    assert.equal(binding.version, 1);
    assert.match(binding.common.command, /cursor-agent$/);
    assert.equal(
      binding.profiles[0].instanceId,
      profileInstanceId("test-agent"),
    );
    const host = JSON.parse(
      readFileSync(path.join(f.app, "worker-runtime/supervisor.manifest.json")),
    );
    assert.deepEqual(Object.keys(host.environment).sort(), [
      "LANG",
      "LC_ALL",
      "PATH",
    ]);
    assert.equal(
      existsSync(path.join(f.app, "worker-runtime/codex.manifest.json")),
      false,
    );
  } finally {
    f.cleanup();
  }
});
test("preflight rejects existing harness or identity conflicts without a helper call", async () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(
        f.app,
        "client/instances",
        profileInstanceId("test-agent") + ".json",
      ),
      JSON.stringify({
        profile: "test-agent",
        runtimeAdapter: "hermes",
        enabled: true,
      }),
      { mode: 0o600 },
    );
    const r = createSetupRuntime({
      accountHome: f.account,
      releaseRoot: f.release,
      platform: "darwin",
      env: { PATH: path.join(f.account, "native-bin") },
      run: f.run,
    });
    await assert.rejects(r.preflight(f.options), /different harness|conflict/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});
test("runtime staging has exact content address, private modes, and Python-free manifest format", async () => {
  const f = fixture();
  try {
    const m = stageRuntimeBundle({
      appRoot: f.app,
      releaseRoot: f.release,
      kind: "supervisor",
    });
    assert.equal(m.version, 8);
    assert.equal(
      path.basename(m.projectRoot),
      hash(
        [
          "supervisor",
          m.nodeSHA256,
          ...Object.keys(m.artifacts)
            .sort()
            .map((p) => `${p}=${m.artifacts[p]}`),
        ].join("\n") + "\n",
      ),
    );
    const again = stageRuntimeBundle({
      appRoot: f.app,
      releaseRoot: f.release,
      kind: "supervisor",
    });
    assert.equal(again.projectRoot, m.projectRoot);
    chmodSync(path.join(m.projectRoot, "bin/node"), 0o700);
    writeFileSync(path.join(m.projectRoot, "bin/node"), "tampered");
    assert.throws(
      () =>
        stageRuntimeBundle({
          appRoot: f.app,
          releaseRoot: f.release,
          kind: "supervisor",
        }),
      /integrity|corrupt/,
    );
  } finally {
    f.cleanup();
  }
});
test("runtime staging refuses symlink destination and traversal metadata", () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.root, "other"), { mode: 0o700 });
    symlinkSync(
      path.join(f.root, "other"),
      path.join(f.app, "worker-runtime/bundles"),
    );
    assert.throws(
      () =>
        stageRuntimeBundle({
          appRoot: f.app,
          releaseRoot: f.release,
          kind: "supervisor",
        }),
      /symlink|unsafe|canonical/i,
    );
    rmSync(path.join(f.app, "worker-runtime/bundles"));
    writeFileSync(
      path.join(f.release, "worker-artifacts.json"),
      JSON.stringify({ version: 8, kinds: { supervisor: ["../escape"] } }),
    );
    assert.throws(
      () =>
        stageRuntimeBundle({
          appRoot: f.app,
          releaseRoot: f.release,
          kind: "supervisor",
        }),
      /artifact|path/,
    );
  } finally {
    f.cleanup();
  }
});
test("Codex setup binds, reuses sign-in file without changing user settings, then starts via lifecycle CLI", async () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.account, ".codex/config.toml"),
      "keep-my-settings",
    );
    const r = createSetupRuntime({
      accountHome: f.account,
      releaseRoot: f.release,
      platform: "darwin",
      env: { PATH: path.join(f.account, "native-bin") },
      run: f.run,
    });
    await r.preflight(f.options);
    const result = await r.configure({
      ...f.options,
      agent: { agent_id: f.id },
      keyFile: f.keyFile,
    });
    assert.equal(result.state, "running");
    assert.equal(
      readFileSync(path.join(f.account, ".codex/config.toml"), "utf8"),
      "keep-my-settings",
    );
    assert.equal(
      readFileSync(
        path.join(f.app, "model-state/codex-runtime-home/auth.json"),
        "utf8",
      ),
      '{"fake":"test credential"}',
    );
    assert.equal(
      f.calls.some((c) => c.cmd.includes("python") || c.cmd.includes("bash")),
      false,
    );
    const config = JSON.parse(
      readFileSync(path.join(f.app, "client/headless-runtime-binding.json")),
    );
    assert.equal(config.version, 2);
    // Cross-language contract: the real supervisor rejects any other Codex version.
    const swift = readFileSync(
      new URL(
        "../../macos-mailbox-helper/Sources/TriangleMailboxCore/ClientSupervisor.swift",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(swift, /object\["version"\] as\? Int == 2/);
    assert.equal(f.calls[0].args[0], "bind");
  } finally {
    f.cleanup();
  }
});

test("existing Codex v2 binding adopts its custom authenticated home and verified identity", async () => {
  const f = fixture();
  try {
    const custom = path.join(f.account, "custom-codex");
    mkdirSync(custom, { mode: 0o700 });
    writeFileSync(path.join(custom, "auth.json"), "{}", { mode: 0o600 });
    rmSync(path.join(f.account, ".codex/auth.json"));
    const installationId = "inst_1234567890123456";
    writeFileSync(
      path.join(f.app, "client/installation.json"),
      JSON.stringify({ version: 1, installationId }),
      { mode: 0o600 },
    );
    const config = {
      version: 2,
      common: {
        adapterVersion: "1",
        installationId,
        workingDirectory: f.account,
        codexHome: custom,
        command: path.join(f.account, "native-bin/codex"),
        pollIntervalMs: 30000,
      },
      profiles: [],
    };
    const file = path.join(f.app, "client/headless-runtime-binding.json");
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    writeFileSync(
      path.join(
        f.app,
        "profiles-v1/profile-" +
          Buffer.from("test-agent").toString("hex") +
          ".json",
      ),
      JSON.stringify({ keyFile: f.keyFile }),
      { mode: 0o600 },
    );
    const r = createSetupRuntime({
      accountHome: f.account,
      releaseRoot: f.release,
      platform: "darwin",
      env: { PATH: path.join(f.account, "native-bin") },
      run: f.run,
    });
    assert.equal((await r.preflight(f.options)).agentId, f.id);
    await r.configure({
      ...f.options,
      agent: { agent_id: f.id },
      keyFile: f.keyFile,
    });
    assert.equal(JSON.parse(readFileSync(file)).common.codexHome, custom);
    assert.equal(
      existsSync(path.join(f.app, "model-state/codex-runtime-home")),
      false,
    );
    config.version = 1;
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(r.preflight(f.options), /binding is invalid/);
  } finally {
    f.cleanup();
  }
});

test("existing Codex worker retains delivery mode without joining shared headless members", async () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(
        f.app,
        "client/instances",
        profileInstanceId("test-agent") + ".json",
      ),
      JSON.stringify({
        profile: "test-agent",
        runtimeAdapter: "codex",
        enabled: true,
        deliveryMode: "worker",
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(
        f.app,
        "profiles-v1/profile-" +
          Buffer.from("test-agent").toString("hex") +
          ".json",
      ),
      JSON.stringify({ keyFile: f.keyFile }),
      { mode: 0o600 },
    );
    rmSync(path.join(f.account, ".codex/auth.json"));
    const file = path.join(f.app, "client/headless-runtime-binding.json");
    const untouched = JSON.stringify({
      version: 2,
      common: {},
      profiles: [{ profile: "another-headless-agent" }],
    });
    writeFileSync(file, untouched, { mode: 0o600 });
    const r = createSetupRuntime({
      accountHome: f.account,
      releaseRoot: f.release,
      platform: "darwin",
      env: { PATH: path.join(f.account, "native-bin") },
      run: f.run,
    });
    await r.preflight(f.options);
    await r.configure({
      ...f.options,
      agent: { agent_id: f.id },
      keyFile: f.keyFile,
    });
    assert.equal(readFileSync(file, "utf8"), untouched);
    assert.equal(
      f.calls.some((c) => c.args[0] === "agent" && c.args[1] === "add"),
      false,
    );
  } finally {
    f.cleanup();
  }
});
