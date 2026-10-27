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
import { resolvePyvenvBasePrefix, runtimeRootCovers } from "../runners/runner-common.mjs";

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
  const rootNames = ["TRIANGLE_CREDENTIAL_ROOT", "TRIANGLE_IDENTITY_ROOT", "TRIANGLE_PROJECT_ROOT", "TRIANGLE_MODEL_STATE_BASE", "TRIANGLE_MODEL_ROOTS", "TRIANGLE_RUNTIME_ROOTS", "TRIANGLE_INSTANCE_ID", "TRIANGLE_INSTANCE_TEMP_ROOT", "CODEX_HOME", "HERMES_HOME", "TMPDIR"];
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
  const identityRoot = realpathSync(makeTemp(joinPath(tempDirectory(), "triangle-identity-")));
  process.env.TRIANGLE_IDENTITY_ROOT = identityRoot;
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
  process.once("exit", () => [sandboxHome, credentialRoot, identityRoot, projectRoot, outsideRoot].forEach((entry) => removeTree(entry, { recursive: true, force: true })));
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
    if (process.platform === "darwin" && existsSync("/private/var/select/sh")) {
      assert.equal(await invoke(process.execPath, ["-e", "require('node:fs').readlinkSync('/private/var/select/sh');process.stdout.write('shell-selection-readable')"]), "shell-selection-readable");
      await assert.rejects(invoke(process.execPath, ["-e", "require('node:fs').readdirSync('/private/var/select')"]), /Agent CLI exited/);
      assert.equal(await invoke(process.execPath, ["-e", "const r=require('node:child_process').spawnSync('sh',['-c','printf nested-shell-hook-smoke'],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||String(r.error));process.stdout.write(r.stdout)"]), "nested-shell-hook-smoke");
    }
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
      const policyRoot=joinPath(dirname(modelBase),"runtime-policy");mkdirSync(policyRoot,{mode:0o700});
      const policyFile=joinPath(policyRoot,instanceId+".json");writeFile(policyFile,JSON.stringify({securityMode:"sandboxed"}),{mode:0o600});
      await assert.rejects(invoke(process.execPath,["-e",`require('node:fs').writeFileSync(${JSON.stringify(policyFile)},JSON.stringify({securityMode:'developer-unsandboxed'}))`]),/Agent CLI exited/);
      await assert.rejects(invoke(process.execPath,["-e",`require('node:fs').renameSync(${JSON.stringify(joinPath(modelRoot,"state"))},${JSON.stringify(policyFile)})`]),/Agent CLI exited/);
      assert.equal(JSON.parse(readFileSync(policyFile,'utf8')).securityMode,'sandboxed');
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
  const identityHome = join(base, "triangle-v1"); mkdirSync(identityHome, { recursive: true, mode: 0o700 });
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
    TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome,
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
    TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome,
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
  // Permissions v1 custody home: denied in the profile, and rejected when it
  // overlaps the instance model root (a reasoning child could read the key).
  const identityRoot = realpathSync(mkdtempSync(join(tmpdir(), "triangle-identity-")));
  t.after(() => rmSync(identityRoot, { recursive: true, force: true }));
  const sandboxEnv = { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TRIANGLE_INSTANCE_ID: instanceId, TRIANGLE_INSTANCE_TEMP_ROOT: fixedTemporary, CODEX_HOME: boundedModel, HERMES_HOME: undefined, TMPDIR: temporary };
  const { TRIANGLE_IDENTITY_ROOT: _omit, ...withoutIdentity } = sandboxEnv;
  assert.throws(() => sandboxCommand(process.execPath, [], withoutIdentity), /TRIANGLE_IDENTITY_ROOT/);
  const identityProfile = sandboxCommand(process.execPath, ["-e", ""], { ...sandboxEnv, TRIANGLE_IDENTITY_ROOT: identityRoot }).args[1];
  assert.ok(identityProfile.includes(`(deny file-read* file-write* (subpath "${identityRoot}"))`));
  const nestedIdentity = join(boundedModel, "v1"); mkdirSync(nestedIdentity, { recursive: true });
  assert.throws(() => sandboxCommand(process.execPath, [], { ...sandboxEnv, TRIANGLE_IDENTITY_ROOT: nestedIdentity }), /overlap/i);
  const projectIdentity = join(project, "v1"); mkdirSync(projectIdentity, { recursive: true });
  assert.throws(() => sandboxCommand(process.execPath, [], { ...sandboxEnv, TRIANGLE_IDENTITY_ROOT: projectIdentity }), /overlap/i);
  rmSync(projectIdentity, { recursive: true, force: true });
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: model, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /beneath|model state/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: arbitraryModelBase, TRIANGLE_MODEL_ROOTS: arbitraryBoundedModel, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /application-owned|model state base/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: arbitraryRuntime, CODEX_HOME: boundedModel, HERMES_HOME: undefined, TMPDIR: temporary }), /runtime root|installation/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: base, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /application-owned|model state base|unsafe|HOME/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: join(base, ".."), TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /application-owned|model state base|unsafe|HOME|ancestor/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: nestedProject, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /overlap|outside/i);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: `${boundedModel}${process.platform === "win32" ? ";" : ":"}${boundedModel}`, TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), TMPDIR: temporary }), /duplicate/i);
  const rejectsInactiveWithoutContent = (error) => /inactive|active worker|conflicting/i.test(error?.message) && !error.message.includes(inactiveSecret);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: `${join(process.execPath, "..")}\:${arbitraryRuntime}`, HERMES_HOME: boundedModel, CODEX_HOME: undefined, HERMES_CLI: undefined, CODEX_CLI: inactiveCodex }), rejectsInactiveWithoutContent);
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: base, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: modelBase, TRIANGLE_MODEL_ROOTS: boundedModel, TRIANGLE_RUNTIME_ROOTS: `${join(process.execPath, "..")}\:${inactiveHermesBin}`, CODEX_HOME: boundedModel, HERMES_HOME: undefined, CODEX_CLI: undefined, HERMES_CLI: inactiveHermes }), rejectsInactiveWithoutContent);

  const escapedHome = realpathSync(mkdtempSync(join(tmpdir(), "triangle-sandbox-symlink-home-")));
  t.after(() => rmSync(escapedHome, { recursive: true, force: true }));
  const escapedTarget = join(escapedHome, "outside-model-state"); mkdirSync(join(escapedTarget, "model-state", "codex"), { recursive: true });
  mkdirSync(join(escapedHome, "Library", "Application Support"), { recursive: true });
  symlinkSync(escapedTarget, join(escapedHome, "Library", "Application Support", "The Triangle"));
  assert.throws(() => sandboxCommand(process.execPath, [], { ...process.env, HOME: escapedHome, TRIANGLE_PROJECT_ROOT: project, TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome, TRIANGLE_MODEL_STATE_BASE: join(escapedHome, "Library", "Application Support", "The Triangle", "model-state"), TRIANGLE_MODEL_ROOTS: join(escapedTarget, "model-state", "codex"), TRIANGLE_RUNTIME_ROOTS: join(process.execPath, ".."), CODEX_HOME: join(escapedTarget, "model-state", "codex") }), /symlink|application-owned|canonical/i);
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
    ["-p", "ping", "--output-format", "json", "--sandbox", "--log-file", "/tmp/triangle-instance/antigravity-cli.log"],
  );
});

test("installed Hermes CLI documents the stdin query-file transport without contacting a provider", (t) => {
  const result = spawn("hermes", ["chat", "--help"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", stderr = "";
  result.stdout.on("data", (chunk) => { output += chunk; });
  result.stderr.on("data", (chunk) => { stderr += chunk; });
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
        assert.equal(code, 0, stderr || "Installed Hermes CLI help failed");
        assert.match(output, /--query-file PATH/);
        assert.match(output, /'-' reads stdin/);
        resolve();
      } catch (error) { reject(error); }
    });
  });
});

test("uv-style pyvenv.cfg base prefix covers encodings (not just bin home)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "triangle-pyvenv-prefix-")));
  try {
    const prefix = join(root, "uv", "python", "cpython-3.11-macos-aarch64-none");
    const binHome = join(prefix, "bin");
    const encodings = join(prefix, "lib", "python3.11", "encodings");
    mkdirSync(binHome, { recursive: true });
    mkdirSync(encodings, { recursive: true });
    writeFileSync(join(encodings, "__init__.py"), "");
    const venv = join(root, "agent", ".venv");
    mkdirSync(venv, { recursive: true });
    writeFileSync(join(venv, "pyvenv.cfg"), `home = ${binHome}\ninclude-system-site-packages = false\n`);
    const basePrefix = resolvePyvenvBasePrefix(venv);
    assert.equal(basePrefix, realpathSync(prefix));
    assert.equal(runtimeRootCovers([realpathSync(binHome)], encodings), false, "bin home alone must not cover encodings");
    assert.ok(runtimeRootCovers([basePrefix], encodings), "dirname(home) base prefix must cover encodings");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pyvenv base-prefix resolution reports lexical symlink aliases needed by sandbox-exec", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "triangle-pyvenv-alias-")));
  try {
    const versionedPrefix = join(root, "uv", "python", "cpython-3.11.15-macos-aarch64-none");
    const aliasPrefix = join(root, "uv", "python", "cpython-3.11-macos-aarch64-none");
    mkdirSync(join(versionedPrefix, "bin"), { recursive: true });
    symlinkSync(versionedPrefix, aliasPrefix);
    const venv = join(root, "agent", ".venv");
    mkdirSync(venv, { recursive: true });
    writeFileSync(join(venv, "pyvenv.cfg"), `home = ${aliasPrefix}/bin\n`);
    const aliases = [];
    const basePrefix = resolvePyvenvBasePrefix(venv, {
      onSymlinkAlias(alias) {
        aliases.push(alias);
      },
    });
    assert.equal(basePrefix, realpathSync(versionedPrefix));
    assert.deepEqual(aliases, [aliasPrefix]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed Hermes and Codex help run under Keychain-launched deny-default sandboxes without provider calls", async (t) => {
  if (process.platform !== "darwin") return t.skip("Darwin sandbox profile");
  const availability = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"]);
  const sandboxAvailable = availability.status === 0;
  const lookup = spawnSync("/bin/bash", ["-lc", "command -v hermes"], { encoding: "utf8" });
  if (lookup.status !== 0) {
    return t.skip("installed Hermes CLI not on PATH (host integration; not a unit fixture)");
  }
  const hermesCLI = realpathSync(lookup.stdout.trim());
  // Probe without sandbox first — broken local Hermes installs (e.g. missing `pm`) are host env, not product regressions.
  const probeHome = mkdtempSync(join(tmpdir(), "triangle-hermes-probe-"));
  const hermesProbe = spawnSync(hermesCLI, ["chat", "--help"], {
    encoding: "utf8",
    env: { ...process.env, HOME: probeHome },
    timeout: 30_000,
  });
  rmSync(probeHome, { recursive: true, force: true });
  if (hermesProbe.status !== 0) {
    return t.skip(
      `host Hermes CLI is not runnable (${(hermesProbe.stderr || hermesProbe.stdout || "").split("\n")[0] || `exit ${hermesProbe.status}`})`,
    );
  }
  const codexLookup = spawnSync("/bin/bash", ["-lc", "command -v codex"], { encoding: "utf8" });
  if (codexLookup.status !== 0) {
    return t.skip("installed Codex CLI not on PATH (host integration; not a unit fixture)");
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), "triangle-hermes-sandbox-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const applicationRoot = join(home, "Library", "Application Support", "The Triangle");
  const credentials = join(applicationRoot, "credentials"); mkdirSync(credentials, { recursive: true, mode: 0o700 });
  const identityHome = join(applicationRoot, "v1"); mkdirSync(identityHome, { recursive: true, mode: 0o700 });
  const modelBase = join(applicationRoot, "model-state");
  const hermesInstanceId = "d".repeat(64);
  const model = join(modelBase, "instances", hermesInstanceId); mkdirSync(model, { recursive: true });
  const hermesTemp = join(home, "Library", "Caches", "The Triangle", "instances", hermesInstanceId); mkdirSync(hermesTemp, { recursive: true });
  const projectRoot = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));
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
  // Pitfall 20 / mesh-a2a-interop: allowlist dirname(home), not bin home — encodings is under lib/.
  const basePrefix = resolvePyvenvBasePrefix(venv);
  if (basePrefix) {
    hermesRuntimeRoots.add(basePrefix);
    const encodingsDirs = globSync(join(basePrefix, "lib", "python*", "encodings"));
    assert.ok(encodingsDirs.length > 0, `expected encodings under ${basePrefix}/lib/python*/encodings`);
    for (const encodingsDir of encodingsDirs) {
      assert.ok(
        runtimeRootCovers(hermesRuntimeRoots, encodingsDir),
        `encodings ${encodingsDir} must be covered by TRIANGLE_RUNTIME_ROOTS`,
      );
    }
  }
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
    TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome,
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
    TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome,
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
  const hermesSandboxDetail = `${result.stderr || result.signal || "Hermes help sandbox failed"}\nruntime=${env.TRIANGLE_RUNTIME_ROOTS}\ninterpreterRules=${command.args[1].split("\\n").filter((line) => /venv\/bin\/python|uv\/python/.test(line)).join(" | ")}`;
  if (
    result.status !== 0 &&
    /No module named ['"]?pm['"]?|ModuleNotFoundError|ERROR: hermes/i.test(hermesSandboxDetail)
  ) {
    return t.skip(`host Hermes packaging broken under sandbox (${hermesSandboxDetail.split("\n").find((line) => /pm|ModuleNotFound|Error/i.test(line)) || "see hermes stderr"})`);
  }
  assert.equal(result.status, 0, hermesSandboxDetail);
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

test("Antigravity sandbox approves agy state roots (~/.gemini/antigravity-cli, ~/.gemini/config) but not arbitrary roots", async (t) => {
  if (process.platform !== "darwin") return t.skip("Darwin sandbox profile");
  const { sandboxCommand } = await import("../runners/runner-common.mjs");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "triangle-agy-sandbox-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const instanceId = "d".repeat(64);
  const project = join(base, "project");
  const credentials = join(base, "credentials");
  const identityHome = join(base, "triangle-v1"); mkdirSync(identityHome, { recursive: true, mode: 0o700 });
  const modelBase = join(base, "Library", "Application Support", "The Triangle", "model-state");
  const model = join(modelBase, "instances", instanceId);
  const temporary = join(base, "Library", "Caches", "The Triangle", "instances", instanceId);
  const cliBin = join(base, ".local", "bin");
  const agyState = join(base, ".gemini", "antigravity-cli");
  const agyConfig = join(base, ".gemini", "config");
  const arbitrary = join(base, "arbitrary-runtime");
  for (const directory of [project, credentials, model, temporary, cliBin, agyState, agyConfig, arbitrary]) mkdirSync(directory, { recursive: true });
  const agy = join(cliBin, "agy"); writeFileSync(agy, "#!/bin/sh\nexit 0\n"); chmodSync(agy, 0o755);
  const env = {
    ...process.env,
    HOME: base,
    TRIANGLE_PROJECT_ROOT: project,
    TRIANGLE_CREDENTIAL_ROOT: credentials, TRIANGLE_IDENTITY_ROOT: identityHome,
    TRIANGLE_MODEL_STATE_BASE: modelBase,
    TRIANGLE_MODEL_ROOTS: model,
    TRIANGLE_RUNTIME_ROOTS: [cliBin, agyState, agyConfig].join(":"),
    TRIANGLE_WRITABLE_RUNTIME_ROOTS: [agyState, agyConfig].join(":"),
    TRIANGLE_INSTANCE_ID: instanceId,
    TRIANGLE_INSTANCE_TEMP_ROOT: temporary,
    ANTIGRAVITY_CLI: agy,
    ANTIGRAVITY_HOME: model,
    CODEX_HOME: undefined,
    HERMES_HOME: undefined,
    CODEX_CLI: undefined,
    HERMES_CLI: undefined,
  };
  const result = sandboxCommand(agy, ["--version"], env);
  assert.equal(result.command, "/usr/bin/sandbox-exec");
  for (const root of [agyState, agyConfig]) assert.match(result.args[1], new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.throws(
    () => sandboxCommand(agy, ["--version"], { ...env, TRIANGLE_RUNTIME_ROOTS: [cliBin, agyState, agyConfig, arbitrary].join(":") }),
    /approved executable installation chain/,
  );
});

test('Antigravity model selection is explicit and instance-local', () => {
  const root=mkdtempSync(join(tmpdir(),'triangle-agy-model-'));
  const config=join(root,'triangle-antigravity-runtime.json');
  try {
    writeFileSync(config,JSON.stringify({model:'Gemini 3.8 Flash (High)'}),{mode:0o600});
    const invocation=createAntigravityInvocation('request --model nope',{ANTIGRAVITY_HOME:root});
    assert.deepEqual(invocation.args.slice(0,2),['--model','Gemini 3.8 Flash (High)']);
    assert.ok(invocation.args.includes('request --model nope'));
    writeFileSync(config,JSON.stringify({securityMode:'developer-unsandboxed'}));
    assert.throws(()=>createAntigravityInvocation('request',{ANTIGRAVITY_HOME:root}),/runtime configuration/);
    writeFileSync(config,JSON.stringify({model:'bad\nmodel'}));
    assert.throws(()=>createAntigravityInvocation('request',{ANTIGRAVITY_HOME:root}),/runtime configuration/);
    rmSync(config);symlinkSync('/etc/hosts',config);
    assert.throws(()=>createAntigravityInvocation('request',{ANTIGRAVITY_HOME:root}),/runtime configuration/);
  } finally {rmSync(root,{recursive:true,force:true})}
});
