// Smoke tests for the v15 restage-prep rehearsal tooling (docs/reviews/2026-11-20-restage-prep-fd753b9-rehearsal-assets).
// The full rehearsal needs the installed application and a built package, so it is not run here; these tests keep
// the helper scripts from drifting against the repository modules they import and verify strict signal/stop handling.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const assets = path.join(repo, "docs/reviews/2026-11-20-restage-prep-fd753b9-rehearsal-assets");
const ad3Assets = path.join(repo, "docs/reviews/2026-11-12-identity-aliases-ad3-rehearsal-assets");
const hostScript = path.join(assets, "restage-host.mjs");
const driverPath = path.join(assets, "rehearsal-restage.mjs");
const mutationPath = path.join(assets, "mutation-check.py");

function scratch(t) {
  // Keep unix control socket paths <= 100 bytes; fall back to /private/tmp when TMPDIR is long.
  let base = null;
  for (const parent of [fs.realpathSync(os.tmpdir()), "/private/tmp"]) {
    const candidate = fs.mkdtempSync(path.join(parent, "rstrt-"));
    fs.chmodSync(candidate, 0o700);
    if (Buffer.byteLength(path.join(candidate, "c/l/local-control.sock")) <= 100) {
      base = candidate;
      break;
    }
    fs.rmSync(candidate, { recursive: true, force: true });
  }
  assert.ok(base, "no scratch directory short enough for a unix socket");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const s = {
    base,
    client: path.join(base, "c"),
    stateRoot: path.join(base, "c/l"),
    registry: path.join(base, "id"),
    workspace: path.join(base, "ws"),
    localCli: path.join(base, "triangle-local-stub"),
    env: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base, LANG: "C", LC_ALL: "C" },
  };
  for (const dir of [s.client, s.stateRoot, s.registry, s.workspace]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  fs.writeFileSync(s.localCli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.chmodSync(s.localCli, 0o700);
  s.spec = (opts = {}, name = "spec.json") => {
    const file = path.join(base, name);
    fs.writeFileSync(
      file,
      JSON.stringify({
        clientRoot: s.client,
        stateRoot: s.stateRoot,
        registryRoot: s.registry,
        workspace: s.workspace,
        localCli: s.localCli,
        ...opts,
      }),
    );
    return file;
  };
  s.helper = async (...args) => lastJson((await exec(process.execPath, [hostScript, ...args], { env: s.env })).stdout);
  return s;
}

const lastJson = (text) => JSON.parse(text.trim().split("\n").filter(Boolean).pop());

async function startHostChild(t, args, env) {
  const child = spawn(process.execPath, [hostScript, "run", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const ready = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`no ready line: ${stderr}`)), 20000);
    child.stdout.on("data", (d) => {
      buffer += d;
      const line = buffer.split("\n").find((l) => l.includes('"ready"'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited early (${code}): ${stderr}`));
    });
  });
  return { child, ready, getStderr: () => stderr };
}

test("restage rehearsal JS assets and mutation-check.py parse cleanly", async () => {
  for (const file of ["rehearsal-restage.mjs", "lib.mjs", "restage-host.mjs"]) {
    await exec(process.execPath, ["--check", path.join(assets, file)]);
  }
  await exec("/usr/bin/python3", ["-I", "-c", `import ast; ast.parse(open(${JSON.stringify(mutationPath)}).read())`]);
});

test("pty-run.py matches the AD.3 helper byte for byte", () => {
  assert.deepEqual(fs.readFileSync(path.join(assets, "pty-run.py")), fs.readFileSync(path.join(ad3Assets, "pty-run.py")));
});

test("rehearsal driver's EXPECTED_SUPERVISOR_DIFF lists 12 existing supervisor modules", () => {
  const driver = fs.readFileSync(driverPath, "utf8");
  const block = /const EXPECTED_SUPERVISOR_DIFF = \[([\s\S]*?)\];/.exec(driver)?.[1] ?? "";
  const listed = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(listed.length, 12, `expected 12 modules, got ${listed.length}`);
  assert.deepEqual([...listed].sort(), listed);
  for (const rel of listed) {
    assert.ok(rel.startsWith("packages/agent-worker/src/"), rel);
    assert.ok(fs.existsSync(path.join(repo, rel)), `missing module ${rel}`);
  }
});

test("restage-host.mjs prepare builds v2 config with alias and destination, and run/guards behave cleanly", async (t) => {
  const s = scratch(t);
  const specFile = s.spec({
    local: ["gravity2", "helper"],
    bound: ["gravity2", "helper", "rhea"],
    init: false,
    v2: true,
    alias: { name: "gemini", targetProfile: "gravity2" },
    destination: { targetProfile: "rhea", harness: "claude", workspace: s.workspace },
  });
  const prep = await s.helper("prepare", repo, specFile);
  assert.equal(prep.ok, true);
  assert.equal(prep.registryWasInPlace, false);
  assert.match(prep.principals.gravity2, /^agent_[0-9a-f]{32}$/);
  assert.match(prep.principals.rhea, /^agent_[0-9a-f]{32}$/);
  assert.match(prep.instances.helper, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(prep.configPath));

  const reg = JSON.parse(fs.readFileSync(path.join(s.registry, "identity-registry-v1.json"), "utf8"));
  assert.equal(reg.schema, "identity_registry_v2");
  assert.equal(reg.aliases?.gemini?.principal_id, prep.principals.gravity2);
  assert.equal(reg.destinations?.[prep.principals.rhea]?.harness, "claude");

  // Run host with gravity2 runner omitted, verify notice emitted and clean SIGTERM stop.
  const noticesFile = path.join(s.base, "notices.jsonl");
  const { child, ready } = await startHostChild(
    t,
    [repo, prep.configPath, "--omit-runners", "gravity2", "--notices-file", noticesFile],
    s.env,
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.pid, child.pid);
  assert.ok(fs.lstatSync(path.join(s.stateRoot, "local-control.sock")).isSocket());
  const notices = fs.readFileSync(noticesFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(
    notices.some((n) => n.event === "triangle_client_local_recipient_not_running" && n.profile === "gravity2"),
    `expected unavailable recipient notice in ${JSON.stringify(notices)}`,
  );
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const timeout = new Promise((resolve) => setTimeout(() => resolve("host did not stop within 15s"), 15000).unref());
  assert.deepEqual(await Promise.race([closed, timeout]), { code: 0, signal: null });

  // Direct journal & server reply-id reuse guards.
  const jGuard = await s.helper("journal-reply-guard", repo, path.join(s.base, "jg"), prep.senderId, prep.instances.helper);
  assert.deepEqual(jGuard, {
    ok: true,
    reuseCode: "message_id_in_use",
    replyReuseCode: "message_id_in_use",
    sameIdRetryIsDuplicate: true,
    historicalCollisionRetryIsDuplicate: true,
  });

  const sGuard = await s.helper("server-reply-guard", repo, path.join(s.base, "sg"), prep.senderId, prep.instances.helper);
  assert.deepEqual(sGuard, { ok: true, errorCode: "message_id_in_use", recordSendCalled: false, rateRolledBack: true });
});

test("restage-host.mjs run exits 1 when host.stop() throws", async (t) => {
  const s = scratch(t);
  const fakeBundle = path.join(s.base, "fake-bundle");
  const fakeSrc = path.join(fakeBundle, "packages/agent-worker/src");
  fs.mkdirSync(fakeSrc, { recursive: true });
  fs.writeFileSync(path.join(fakeSrc, "concurrency-gate.mjs"), "export function createProfiledReasonerGate() { return {}; }\n");
  fs.writeFileSync(
    path.join(fakeSrc, "local-messaging-host.mjs"),
    [
      "export function loadLocalMessagingConfig() { return { recipients: [] }; }",
      "export function createInstalledLocalMessagingHost() {",
      '  return { async start() {}, async stop() { throw new Error("boom"); } };',
      "}",
      "",
    ].join("\n"),
  );
  const { child, getStderr } = await startHostChild(t, [fakeBundle, path.join(s.base, "unused.json")], s.env);
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  assert.deepEqual(await closed, { code: 1, signal: null });
  assert.match(getStderr(), /host\.stop failed:.*boom/);
});
