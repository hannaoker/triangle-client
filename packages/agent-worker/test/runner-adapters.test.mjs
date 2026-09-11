import assert from "node:assert/strict";
import { chmodSync, existsSync, globSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAgentPrompt as createHermesPrompt,
  createHermesInvocation,
} from "../runners/hermes-runner.mjs";
import { createAgentPrompt as createCodexPrompt } from "../runners/codex-runner.mjs";
import {
  createAgentPrompt as createAntigravityPrompt,
  createAntigravityInvocation,
} from "../runners/antigravity-runner.mjs";
import { createRunnerEnvironment } from "../src/command-runner.mjs";

const request = {
  messageId: "message_1",
  taskId: "task_1",
  contextId: "context_1",
  senderId: "agent_sender",
  recipientId: "agent_receiver",
  text: "What is 2 + 2?",
  replyRequired: true,
};

for (const [name, createPrompt] of [
  ["Hermes", createHermesPrompt],
  ["Codex", createCodexPrompt],
  ["Antigravity", createAntigravityPrompt],
]) {
  test(`${name} adapter produces a bounded peer-response prompt`, () => {
    const prompt = createPrompt(request);
    assert.match(prompt, /What is 2 \+ 2\?/);
    assert.match(prompt, /agent_sender/);
    assert.match(prompt, /Return only the reply/);
    assert.equal(prompt.includes("private-token"), false);
  });
}

test("runner common strips controller credentials before invoking a reasoning CLI", async (t) => {
  const { invoke, sandboxCommand } = await import("../runners/runner-common.mjs");
  const { mkdtempSync: makeTemp, rmSync: removeTree, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir: tempDirectory } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const secretNames = ["MESH_AGENT_TOKEN", "TURSO_AUTH_TOKEN", "GATEWAY_INTERNAL_TOKEN", "GENERIC_SECRET", "GENERIC_TOKEN"];
  const rootNames = ["TRIANGLE_CREDENTIAL_ROOT", "TRIANGLE_PROJECT_ROOT", "TRIANGLE_MODEL_STATE_BASE", "TRIANGLE_MODEL_ROOTS", "TRIANGLE_RUNTIME_ROOTS", "TRIANGLE_INSTANCE_ID", "TRIANGLE_INSTANCE_TEMP_ROOT", "CODEX_HOME", "HERMES_HOME", "TMPDIR"];
  const names = [...secretNames, ...rootNames, "HOME", "PYTHONPATH"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const sandboxHome = realpathSync(makeTemp(joinPath(tempDirectory(), "triangle-sandbox-home-")));
  const credentialRoot = realpathSync(makeTemp(joinPath(tempDirectory(), "triangle-credentials-")));
  const projectRoot = realpathSync(makeTemp(joinPath(tempDirectory(), "triangle-project-")));
  const outsideRoot = realpathSync(makeTemp(joinPath(tempDirectory(), "triangle-outside-secret-")));
  const nominatedTemp = joinPath(sandboxHome, "Documents", "untrusted-temp"); mkdirSync(nominatedTemp, { recursive: true });
  const instanceId = "a".repeat(64);
  const fixedTemp = joinPath(sandboxHome, "Library", "Caches", "The Triangle", "instances", instanceId); mkdirSync(fixedTemp, { recursive: true });
  const modelBase = joinPath(sandboxHome, "Library", "Application Support", "The Triangle", "model-state"); mkdirSync(modelBase, { recursive: true });
  const modelRoot = joinPath(modelBase, "instances", instanceId); mkdirSync(modelRoot, { recursive: true });
  process.env.TRIANGLE_CREDENTIAL_ROOT = credentialRoot;
  process.env.TRIANGLE_PROJECT_ROOT = projectRoot;
  process.env.TRIANGLE_MODEL_ROOTS = modelRoot;
  process.env.TRIANGLE_MODEL_STATE_BASE = modelBase;
  process.env.CODEX_HOME = modelRoot;
  process.env.TRIANGLE_INSTANCE_ID = instanceId;
  process.env.TRIANGLE_INSTANCE_TEMP_ROOT = fixedTemp;
  delete process.env.HERMES_HOME;
  process.env.TRIANGLE_RUNTIME_ROOTS = joinPath(process.execPath, "..");
  process.env.HOME = sandboxHome;
  process.env.TMPDIR = nominatedTemp;
  const credentialFile = joinPath(credentialRoot, "worker.env");
  const ordinaryFile = joinPath(projectRoot, "ordinary.txt");
  const projectEnv = joinPath(projectRoot, ".env.example");
  const envDirectory = joinPath(projectRoot, ".env");
  const envLocalDirectory = joinPath(projectRoot, ".env.local");
  const envMetaDirectory = joinPath(projectRoot, ".env[prod]");
  const outsideSecret = joinPath(outsideRoot, "secret.txt");
  mkdirSync(joinPath(projectRoot, ".git"));
  for (const directory of [envDirectory, envLocalDirectory, envMetaDirectory]) mkdirSync(directory);
  writeFile(credentialFile, "MESH_AGENT_TOKEN=must-not-read\n");
  writeFile(ordinaryFile, "ordinary\n");
  writeFile(projectEnv, "MODEL_SECRET=must-not-read\n");
  for (const directory of [envDirectory, envLocalDirectory, envMetaDirectory]) writeFile(joinPath(directory, "secret"), "nested-secret\n");
  symlinkSync(joinPath(envDirectory, "secret"), joinPath(projectRoot, "env-alias"));
  writeFile(outsideSecret, "outside-home-secret\n");
  process.once("exit", () => [sandboxHome, credentialRoot, projectRoot, outsideRoot].forEach((entry) => removeTree(entry, { recursive: true, force: true })));
  for (const name of secretNames) process.env[name] = `private-${name}`;
  process.env.PYTHONPATH = outsideRoot;
  try {
    if (process.platform === "darwin") {
      const probe = spawn("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"]);
      const available = await new Promise((resolve) => probe.on("close", (code) => resolve(code === 0)));
      if (!available) return t.skip("sandbox-exec cannot apply profiles in this enclosing sandbox");
    }
    if (process.platform === "darwin") {
      const smoke = sandboxCommand("/usr/bin/true", [], process.env);
      const proc = spawn(smoke.command, smoke.args, { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
      let smokeError = ""; proc.stderr.on("data", (chunk) => { smokeError += chunk; });
      const outcome = await new Promise((resolve) => proc.on("close", (code, signal) => resolve({ code, signal })));
      assert.equal(outcome.code, 0, `/usr/bin/true must run under the generated profile (${outcome.signal || smokeError})`);
    }
    assert.equal(await invoke(process.execPath, ["-e", "process.stdout.write('node-smoke')"]), "node-smoke");
    const childEnv = JSON.parse(await invoke(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"]));
    for (const name of secretNames) assert.equal(childEnv[name], undefined, name);
    assert.equal(childEnv.PYTHONPATH, undefined);
    for (const name of rootNames.filter((name) => name !== "TMPDIR")) assert.equal(childEnv[name], process.env[name], name);
    assert.equal(childEnv.TMPDIR, fixedTemp);
    assert.equal(childEnv.PATH, process.env.PATH);
    assert.match(await invoke(process.execPath, ["-e", `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(ordinaryFile)},'utf8'))`]), /ordinary/);
    assert.match(await invoke(process.execPath, ["-e", `process.stdout.write(require('node:fs').readdirSync(${JSON.stringify(projectRoot)}).join(','))`]), /ordinary\.txt/);
    assert.equal(await invoke(process.execPath, ["-e", "const f=require('node:fs'),p=require('node:path').join(process.env.TMPDIR,'scratch');f.writeFileSync(p,'ok');process.stdout.write(f.readFileSync(p,'utf8'))"]), "ok");
    const homeNames = await invoke(process.execPath, ["-e", `process.stdout.write(require('node:fs').readdirSync(${JSON.stringify(sandboxHome)}).join(','))`]);
    assert.match(homeNames, /Library/);
    const acceptedNames = JSON.parse(await invoke(process.execPath, ["-e", `const f=require('node:fs'),p=${JSON.stringify(joinPath(projectRoot, ".."))},n=f.readdirSync(p);process.stdout.write(JSON.stringify([n.includes(${JSON.stringify(projectRoot.split("/").at(-1))}),n.includes(${JSON.stringify(credentialRoot.split("/").at(-1))})]))`]));
    assert.deepEqual(acceptedNames, [true, true]);
    // Deny-default filesystem policy is enforced by sandbox-exec on Darwin only.
    if (process.platform === "darwin") {
      await assert.rejects(invoke(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(joinPath(projectRoot, "source.txt"))},'no')`]), /Agent CLI exited/);
      await assert.rejects(invoke(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(joinPath(projectRoot, ".git/config"))},'no')`]), /Agent CLI exited/);
      assert.equal(await invoke(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(joinPath(modelRoot, "state"))},'ok');process.stdout.write('model-written')`]), "model-written");
      await assert.rejects(invoke(process.execPath, ["-e", `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(credentialFile)},'utf8'))`]), /Agent CLI exited/);
      await assert.rejects(invoke(process.execPath, ["-e", `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(projectEnv)},'utf8'))`]), /Agent CLI exited/);
      for (const denied of [joinPath(envDirectory, "secret"), joinPath(envLocalDirectory, "secret"), joinPath(envMetaDirectory, "secret"), joinPath(projectRoot, "env-alias")]) {
        await assert.rejects(invoke(process.execPath, ["-e", `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(denied)},'utf8'))`]), /Agent CLI exited/);
      }
      await assert.rejects(invoke(process.execPath, ["-e", `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(outsideSecret)},'utf8'))`]), /Agent CLI exited/);
    } else {
      assert.equal(await invoke(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(joinPath(modelRoot, "state"))},'ok');process.stdout.write('model-written')`]), "model-written");
    }
    assert.match(await invoke(process.execPath, ["-e", "const s=require('node:net').connect(9,'127.0.0.1');s.on('error',e=>process.stdout.write(e.code||'error'))"]), /ECONNREFUSED|ECONNRESET/);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Darwin sandbox is a canonical allowlist with explicit safe model roots", async (t) => {
  if (process.platform !== "darwin") return t.skip("Darwin sandbox profile");
  const { sandboxCommand } = await import("../runners/runner-common.mjs");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "triangle-sandbox-profile-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, "project [safe]");
  const credentials = join(base, "credentials");
  const model = join(base, 'model "root"');
  const modelBase = join(base, "Library", "Application Support", "The Triangle", "model-state");
  const temporary = join(base, "Documents", "temporary");
  const instanceId = "b".repeat(64);
  const fixedTemporary = join(base, "Library", "Caches", "The Triangle", "instances", instanceId);
  const previousInstanceId = process.env.TRIANGLE_INSTANCE_ID;
  const previousInstanceTemp = process.env.TRIANGLE_INSTANCE_TEMP_ROOT;
  process.env.TRIANGLE_INSTANCE_ID = instanceId;
  process.env.TRIANGLE_INSTANCE_TEMP_ROOT = fixedTemporary;
  t.after(() => {
    if (previousInstanceId === undefined) delete process.env.TRIANGLE_INSTANCE_ID; else process.env.TRIANGLE_INSTANCE_ID = previousInstanceId;
    if (previousInstanceTemp === undefined) delete process.env.TRIANGLE_INSTANCE_TEMP_ROOT; else process.env.TRIANGLE_INSTANCE_TEMP_ROOT = previousInstanceTemp;
  });
  const nestedProject = join(credentials, "nested-project");
  const arbitraryModelBase = join(base, "arbitrary-model-state");
  const arbitraryBoundedModel = join(arbitraryModelBase, "codex");
  const arbitraryRuntime = join(base, "arbitrary-runtime");
  for (const directory of [project, credentials, model, modelBase, temporary, fixedTemporary, nestedProject, arbitraryBoundedModel, arbitraryRuntime]) mkdirSync(directory, { recursive: true });
  const boundedModel = join(modelBase, "instances", instanceId); mkdirSync(boundedModel, { recursive: true });
  const inactiveCodex = join(arbitraryRuntime, "inactive-codex"); writeFileSync(inactiveCodex, "#!/bin/sh\nexit 0\n"); chmodSync(inactiveCodex, 0o755);
  const inactiveHermesRoot = join(base, "inactive-hermes");
  const inactiveHermesBin = join(inactiveHermesRoot, "bin");
  const inactiveHermesVenvBin = join(inactiveHermesRoot, "venv", "bin");
  mkdirSync(inactiveHermesBin, { recursive: true }); mkdirSync(inactiveHermesVenvBin, { recursive: true });
  const inactiveHermesEntry = join(inactiveHermesVenvBin, "hermes"); writeFileSync(inactiveHermesEntry, `#!${process.execPath}\n`); chmodSync(inactiveHermesEntry, 0o755);
  const inactiveHermes = join(inactiveHermesBin, "hermes"); writeFileSync(inactiveHermes, `#!/bin/sh\nexec "${inactiveHermesEntry}" "$@"\n`); chmodSync(inactiveHermes, 0o755);
  const inactiveSecret = "cross-agent-file-content-must-not-read";
  writeFileSync(join(arbitraryRuntime, "inactive-secret"), `${inactiveSecret}\n`);
  writeFileSync(join(inactiveHermesBin, "inactive-secret"), `${inactiveSecret}\n`);
  const result = sandboxCommand(process.execPath, ["-e", ""], {
    ...process.env,
    HOME: base,
    TRIANGLE_PROJECT_ROOT: project,
    TRIANGLE_CREDENTIAL_ROOT: credentials,
    TRIANGLE_MODEL_STATE_BASE: modelBase,
    TRIANGLE_MODEL_ROOTS: boundedModel,
    TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."),
    TRIANGLE_INSTANCE_ID: instanceId,
    TRIANGLE_INSTANCE_TEMP_ROOT: fixedTemporary,
    CODEX_HOME: boundedModel,
    HERMES_HOME: undefined,
    TMPDIR: temporary,
  });
  const profile = result.args[1];
  assert.doesNotMatch(profile, /\(allow file-read\*\)/);
  assert.doesNotMatch(profile, new RegExp(`allow file-read\\* file-write\\* \\(subpath "${realpathSync(project).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(profile, /allow network\*/);
  assert.match(profile, /file-read-data \(require-all \(literal "\/"\) \(vnode-type DIRECTORY\)\)/);
  assert.match(profile, new RegExp(`file-read-data[^\\n]*literal "${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(profile, new RegExp(fixedTemporary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(profile, new RegExp(temporary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const mismatchedInstanceId = "c".repeat(64);
  const mismatchedModel = join(modelBase, "instances", mismatchedInstanceId); mkdirSync(mismatchedModel, { recursive: true });
  assert.throws(() => sandboxCommand(process.execPath, [], {
    ...result.env,
    HOME: base,
    TRIANGLE_PROJECT_ROOT: project,
    TRIANGLE_CREDENTIAL_ROOT: credentials,
    TRIANGLE_MODEL_STATE_BASE: modelBase,
    TRIANGLE_MODEL_ROOTS: mismatchedModel,
    TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."),
    CODEX_HOME: mismatchedModel,
    TRIANGLE_INSTANCE_ID: mismatchedInstanceId,
    TRIANGLE_INSTANCE_TEMP_ROOT: fixedTemporary,
  }), /instance.*temp|exact instance/i);
  assert.doesNotMatch(profile, /\(allow file-read-metadata\)\s/);
  assert.match(profile, /^\(allow file-read\* \(literal "\/etc"\)\)$/m);
  assert.doesNotMatch(profile, /\(allow file-read\* \(subpath "\/etc"\)\)/);
  assert.match(profile, /^\(allow file-read\* \(literal "\/var"\)\)$/m);
  assert.doesNotMatch(profile, /\(allow file-read\* \(subpath "\/(?:var|private\/var)"\)\)/);
  assert.doesNotMatch(profile, /\(allow file-read-(?:metadata|data)[^\n]*\(literal "\/var"\)/);
  assert.doesNotMatch(profile, /\(allow file-read\* \((?:literal|subpath) "\/tmp"\)\)/);
  assert.doesNotMatch(profile, /sysctl\*|mach\*|iokit\*/);
  assert.ok(profile.includes(realpathSync(boundedModel).replaceAll('"', '\\"')));
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: model, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /beneath|model state/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_MODEL_STATE_BASE: arbitraryModelBase, TRIANGLE_MODEL_ROOTS: arbitraryBoundedModel, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /application-owned|model state base/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: arbitraryRuntime, CODEX_HOME: boundedModel, HERMES_HOME: undefined, TMPDIR: temporary }), /runtime root|installation/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_MODEL_STATE_BASE: base, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /application-owned|model state base|unsafe|HOME/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_MODEL_STATE_BASE: join(base, ".."), TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /application-owned|model state base|unsafe|HOME|ancestor/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: nestedProject, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /overlap|outside/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: `${boundedModel}${process.platform === "win32" ? ";" : ":"}${boundedModel}`, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /duplicate/i);
  const rejectsInactiveWithoutContent = (error) => /inactive|active worker|conflicting/i.test(error?.message) && !error.message.includes(inactiveSecret);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: `${join(process.execPath, "..")}\:${arbitraryRuntime}`, HERMES_HOME: boundedModel, CODEX_HOME: undefined, HERMES_CLI: undefined, CODEX_CLI: inactiveCodex }), rejectsInactiveWithoutContent);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: `${join(process.execPath, "..")}\:${inactiveHermesBin}`, CODEX_HOME: boundedModel, HERMES_HOME: undefined, CODEX_CLI: undefined, HERMES_CLI: inactiveHermes }), rejectsInactiveWithoutContent);

  const escapedHome = realpathSync(mkdtempSync(join(tmpdir(), "triangle-sandbox-symlink-home-")));
  t.after(() => rmSync(escapedHome, { recursive: true, force: true }));
  const escapedTarget = join(escapedHome, "outside-model-state"); mkdirSync(join(escapedTarget, "model-state", "codex"), { recursive: true });
  mkdirSync(join(escapedHome, "Library", "Application Support"), { recursive: true });
  symlinkSync(escapedTarget, join(escapedHome, "Library", "Application Support", "The Triangle"));
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: escapedHome, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_MODEL_STATE_BASE: join(escapedHome, "Library", "Application Support", "The Triangle", "model-state"), TRIANGLE_MODEL_ROOTS: join(escapedTarget, "model-state", "codex"), TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), CODEX_HOME: join(escapedTarget, "model-state", "codex") }), /symlink|application-owned|canonical/i);
});
test("Hermes adapter uses the supported query-file stdin transport and keeps peer content out of argv", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "agent-worker-hermes-"));
  const capturePath = join(workDir, "capture.json");
  const fakeHermes = join(workDir, "hermes");
  const hermesRequest = {
    ...request,
    text: "triangle-stdin-marker-U7X What is 2 + 2?",
  };
  const hermesMarker = "triangle-stdin-marker-U7X";
  const prompt = createHermesPrompt(hermesRequest);
  const expectedHash = createHash("sha256").update(prompt).digest("hex");
  writeFileSync(
    fakeHermes,
    `#!/usr/bin/env node
let input="";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(process.env.TRIANGLE_CAPTURE_PATH, JSON.stringify({
    argv: process.argv.slice(2),
    argv_has_marker: process.argv.some(arg => arg.includes(process.env.TRIANGLE_EXPECTED_MARKER)),
    prompt_hash: require("node:crypto").createHash("sha256").update(input).digest("hex")
  }));
  process.stdout.write("hermes-reply\\n");
});
`,
  );
  chmodSync(fakeHermes, 0o755);

  try {
    const invocation = createHermesInvocation({ HERMES_CLI: fakeHermes });
    const result = await new Promise((resolve, reject) => {
      const proc = spawn(invocation.command, invocation.args, {
        env: {
          ...process.env,
          HERMES_CLI: fakeHermes,
          TRIANGLE_CAPTURE_PATH: capturePath,
          TRIANGLE_EXPECTED_HASH: expectedHash,
          TRIANGLE_EXPECTED_MARKER: hermesMarker,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      proc.on("error", reject);
      proc.on("close", (code, signal) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`Hermes runner exited ${signal || code}: ${stderr}`));
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });

    const captured = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.equal(captured.argv_has_marker, false);
    assert.deepEqual(captured.argv, ["chat", "--query-file", "-", "--quiet"]);
    assert.equal(captured.prompt_hash, expectedHash);
    assert.equal(captured.prompt_hash.length, expectedHash.length);
    assert.match(result.stdout, /hermes-reply/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("Antigravity adapter routes CLI logs into the instance temp root", () => {
  const invocation = createAntigravityInvocation("ping", {
    ANTIGRAVITY_CLI: "/usr/bin/agy",
    TRIANGLE_INSTANCE_TEMP_ROOT: "/tmp/triangle-instance",
  });
  assert.equal(invocation.command, "/usr/bin/agy");
  assert.deepEqual(
    invocation.args,
    ["-p", "ping", "--output-format", "text", "--sandbox", "--log-file", "/tmp/triangle-instance/antigravity-cli.log"],
  );
});

test("installed Hermes CLI documents the stdin query-file transport without contacting a provider", (t) => {
  const result = spawn("hermes", ["chat", "--help"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  result.stdout.on("data", (chunk) => { output += chunk; });
  return new Promise((resolve, reject) => {
    result.on("error", (error) => {
      if (error?.code === "ENOENT") {
        t.skip("Hermes CLI not installed");
        resolve();
        return;
      }
      reject(error);
    });
    result.on("close", (code) => {
      if (code === 127) { t.skip("Hermes CLI not installed"); resolve(); return; }
      try {
        assert.equal(code, 0);
        assert.match(output, /--query-file PATH/);
        assert.match(output, /'-' reads stdin/);
        resolve();
      } catch (error) { reject(error); }
    });
  });
});

test("installed Hermes and Codex help run under Keychain-launched deny-default sandboxes without provider calls", async (t) => {
  if (process.platform !== "darwin") return t.skip("Darwin sandbox profile");
  const availability = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"]);
  const sandboxAvailable = availability.status === 0;
  const lookup = spawnSync("/bin/bash", ["-lc", "command -v hermes"], { encoding: "utf8" });
  assert.equal(lookup.status, 0, "installed Hermes CLI is required");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "triangle-hermes-sandbox-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const applicationRoot = join(home, "Library", "Application Support", "The Triangle");
  const credentials = join(applicationRoot, "credentials"); mkdirSync(credentials, { recursive: true, mode: 0o700 });
  const modelBase = join(applicationRoot, "model-state");
  const hermesInstanceId = "d".repeat(64);
  const model = join(modelBase, "instances", hermesInstanceId); mkdirSync(model, { recursive: true });
  const hermesTemp = join(home, "Library", "Caches", "The Triangle", "instances", hermesInstanceId); mkdirSync(hermesTemp, { recursive: true });
  const projectRoot = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
  const hermesCLI = realpathSync(lookup.stdout.trim());
  const hermesRuntimeRoots = new Set([dirname(realpathSync(process.execPath)), dirname(hermesCLI)]);
  const wrapper = readFileSync(hermesCLI, "utf8");
  const entryPath = wrapper.match(/^exec\s+"([^"\n]+)"\s+"\$@"\s*$/m)?.[1];
  assert.equal(typeof entryPath, "string", "installed Hermes wrapper has an unsupported execution chain");
  const entry = realpathSync(entryPath);
  const venv = dirname(dirname(entry));
  hermesRuntimeRoots.add(venv);
  const interpreterPath = readFileSync(entry, "utf8").split(/\r?\n/, 1)[0]?.replace(/^#!/, "").split(/\s+/, 1)[0];
  assert.equal(typeof interpreterPath, "string", "installed Hermes entrypoint lacks an interpreter");
  hermesRuntimeRoots.add(dirname(dirname(realpathSync(interpreterPath))));
  for (const finder of globSync(join(venv, "lib", "python*", "site-packages", "__editable___*_finder.py"))) {
    const mapping = readFileSync(finder, "utf8").match(/^MAPPING:.*$/m)?.[0] || "";
    for (const match of mapping.matchAll(/'([^']+)'/g)) {
      if (!match[1].startsWith("/")) continue;
      const candidate = existsSync(match[1]) ? match[1] : (existsSync(`${match[1]}.py`) ? `${match[1]}.py` : null);
      if (candidate) hermesRuntimeRoots.add(realpathSync(candidate));
    }
  }
  const hermesSource = {
    ...process.env,
    HOME: home,
    HERMES_CLI: hermesCLI,
    HERMES_HOME: model,
    TRIANGLE_PROJECT_ROOT: projectRoot,
    TRIANGLE_CREDENTIAL_ROOT: credentials,
    TRIANGLE_MODEL_STATE_BASE: modelBase,
    TRIANGLE_MODEL_ROOTS: model,
    TRIANGLE_RUNTIME_ROOTS: [...hermesRuntimeRoots].join(delimiter),
    TRIANGLE_INSTANCE_ID: hermesInstanceId,
    TRIANGLE_INSTANCE_TEMP_ROOT: hermesTemp,
    TMPDIR: join(home, "Documents", "must-not-grant"),
  };
  delete hermesSource.CODEX_CLI;
  delete hermesSource.CODEX_HOME;
  const env = createRunnerEnvironment(hermesSource);
  const { sandboxCommand } = await import("../runners/runner-common.mjs");
  const command = sandboxCommand(env.HERMES_CLI, ["chat", "--help"], env);
  const codexLookup = spawnSync("/bin/bash", ["-lc", "command -v codex"], { encoding: "utf8" });
  assert.equal(codexLookup.status, 0, "installed Codex CLI is required");
  const codexInstanceId = "e".repeat(64);
  const codexModel = join(modelBase, "instances", codexInstanceId); mkdirSync(codexModel, { recursive: true });
  const codexTemp = join(home, "Library", "Caches", "The Triangle", "instances", codexInstanceId); mkdirSync(codexTemp, { recursive: true });
  const codexCLI = realpathSync(codexLookup.stdout.trim());
  const codexSource = {
    ...process.env,
    HOME: home,
    CODEX_CLI: codexCLI,
    CODEX_HOME: codexModel,
    TRIANGLE_PROJECT_ROOT: projectRoot,
    TRIANGLE_CREDENTIAL_ROOT: credentials,
    TRIANGLE_MODEL_STATE_BASE: modelBase,
    TRIANGLE_MODEL_ROOTS: codexModel,
    TRIANGLE_RUNTIME_ROOTS: [dirname(realpathSync(process.execPath)), dirname(codexCLI)].join(delimiter),
    TRIANGLE_INSTANCE_ID: codexInstanceId,
    TRIANGLE_INSTANCE_TEMP_ROOT: codexTemp,
    TMPDIR: join(home, "Documents", "must-not-grant"),
  };
  delete codexSource.HERMES_CLI;
  delete codexSource.HERMES_HOME;
  const codexEnv = createRunnerEnvironment(codexSource);
  const codexCommand = sandboxCommand(codexEnv.CODEX_CLI, ["--help"], codexEnv);
  if (!sandboxAvailable) return t.skip("sandbox-exec cannot apply profiles in this enclosing sandbox");
  const result = spawnSync(command.command, command.args, { encoding: "utf8", env });
  assert.equal(result.status, 0, `${result.stderr || result.signal || "Hermes help sandbox failed"}\nruntime=${env.TRIANGLE_RUNTIME_ROOTS}\ninterpreterRules=${command.args[1].split("\\n").filter((line) => /venv\/bin\/python|uv\/python/.test(line)).join(" | ")}`);
  assert.match(result.stdout, /--query-file PATH/);
  assert.match(result.stdout, /'-' reads stdin/);
  const etcProbe = sandboxCommand(process.execPath, ["-e", "const fs=require('node:fs'); fs.lstatSync('/etc'); process.stdout.write(String(fs.existsSync('/etc/hermes')))"], env);
  const etcProbeResult = spawnSync(etcProbe.command, etcProbe.args, { encoding: "utf8", env });
  assert.equal(etcProbeResult.status, 0, etcProbeResult.stderr || String(etcProbeResult.signal));
  assert.match(etcProbeResult.stdout, /^(?:true|false)$/);
  const varProbe = sandboxCommand(process.execPath, ["-e", "const fs=require('node:fs'); fs.lstatSync('/var'); try { fs.readdirSync('/var/tmp'); process.exit(9); } catch (error) { if (!['EACCES','EPERM'].includes(error.code)) throw error; process.stdout.write('alias-only'); }"], env);
  const varProbeResult = spawnSync(varProbe.command, varProbe.args, { encoding: "utf8", env });
  assert.equal(varProbeResult.status, 0, varProbeResult.stderr || String(varProbeResult.signal));
  assert.equal(varProbeResult.stdout, "alias-only");

  const codexResult = spawnSync(codexCommand.command, codexCommand.args, { encoding: "utf8", env: codexEnv });
  assert.equal(codexResult.status, 0, codexResult.stderr || String(codexResult.signal));
  assert.match(codexResult.stdout, /Codex|Usage/i);
});
