import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSandbox, createLinuxRunner } from "../src/runner.mjs";
function fixture() {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "triangle-linux-runner-")),
  );
  for (const dir of [
    "tools",
    "release/bin",
    "release/packages/agent-worker/runners",
    "workspace",
    "model",
    "identity",
    "state",
  ])
    mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
  for (const file of ["tools/codex", "tools/bwrap", "release/bin/node"])
    writeFileSync(path.join(root, file), "fake native", { mode: 0o700 });
  writeFileSync(
    path.join(root, "release/packages/agent-worker/runners/codex-runner.mjs"),
    "//runner",
    { mode: 0o600 },
  );
  return {
    root,
    config: {
      schema: 1,
      profile: "linux-agent",
      agentId: "agent_" + "a".repeat(32),
      identityHome: path.join(root, "identity"),
      authority: "https://thetriangle.dev",
      via: null,
      harness: "codex",
      command: path.join(root, "tools/codex"),
      bwrap: path.join(root, "tools/bwrap"),
      node: path.join(root, "release/bin/node"),
      releaseRoot: path.join(root, "release"),
      workdir: path.join(root, "workspace"),
      modelHome: path.join(root, "model"),
      stateRoot: path.join(root, "state"),
      pollIntervalMs: 30000,
      runnerTimeoutMs: 600000,
    },
  };
}
test("sandbox wraps the outer runner, isolates proc and exposes no ambient credential environment", () => {
  const f = fixture();
  try {
    const s = buildSandbox(f.config, { systemRoots: [] });
    assert.equal(s.command, f.config.bwrap);
    assert.ok(s.args.includes("--unshare-pid"));
    assert.ok(s.args.includes("--unshare-user"));
    assert.ok(s.args.includes("--proc"));
    assert.ok(!s.args.includes("--ro-bind /"));
    const after = s.args.slice(s.args.indexOf("--") + 1);
    assert.equal(after[0], f.config.node);
    assert.match(after[1], /codex-runner.mjs$/);
    assert.equal(s.environment.HOME, f.config.modelHome);
    assert.equal(s.environment.CODEX_HOME, f.config.modelHome);
    assert.equal(s.environment.OPENAI_API_KEY, undefined);
    assert.equal(s.environment.TRIANGLE_HOME, undefined);
    assert.equal(s.environment.NODE_OPTIONS, undefined);
    assert.ok(!s.args.includes(f.config.identityHome));
    assert.ok(!s.args.includes(f.config.stateRoot));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("sandbox refuses workspace/runtime overlap with protected credentials and never falls back", async () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        buildSandbox(
          { ...f.config, workdir: f.config.identityHome },
          { systemRoots: [] },
        ),
      /protected|overlap/i,
    );
    assert.throws(
      () =>
        buildSandbox(
          {
            ...f.config,
            releaseRoot: f.root,
            node: path.join(f.root, "bin/node"),
          },
          { systemRoots: [] },
        ),
      /protected|overlap|runtime/i,
    );
    const r = createLinuxRunner(f.config, { platform: "darwin" });
    await assert.rejects(r.probe(), /Linux|linux/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("writable model state cannot contain trusted host code or executables", () => {
  const f = fixture();
  try {
    for (const trusted of [
      f.config.releaseRoot,
      f.config.bwrap,
      f.config.node,
      f.config.command,
    ])
      assert.throws(
        () =>
          buildSandbox(
            { ...f.config, modelHome: trusted },
            { systemRoots: [] },
          ),
        /overlap|protected/i,
      );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("nonzero harness exits remain ambiguous and diagnostics never expose stderr", async () => {
  const f = fixture();
  try {
    writeFileSync(
      f.config.bwrap,
      "#!/bin/sh\necho private-provider-detail >&2\nexit 13\n",
      { mode: 0o700 },
    );
    const runner = createLinuxRunner(f.config, { platform: "linux" });
    await assert.rejects(runner.run({ text: "test" }), (error) => {
      assert.equal(error.knownFailure, false);
      assert.equal(error.code, "runner_failed");
      assert.doesNotMatch(error.message, /private-provider-detail/);
      return true;
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
