// Smoke tests for the D1.4 rehearsal tooling (docs/reviews/2026-11-08-identity-registry-v2-d1-4-rehearsal-assets).
// The rehearsal itself needs the installed application and a built package, so it is not run here; these tests keep its
// helper scripts from rotting against the code they import: the repository stands in for a runtime bundle.
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
const assets = path.join(repo, "docs/reviews/2026-11-08-identity-registry-v2-d1-4-rehearsal-assets");
const hostScript = path.join(assets, "host.mjs");
const ptyRun = path.join(assets, "pty-run.py");
const driver = path.join(assets, "rehearsal.mjs");
const V1 = "identity_registry_v1";
const V2 = "identity_registry_v2";

function scratch(t) {
  // Short, because a unix socket path may not exceed 100 bytes: fall back to /private/tmp when TMPDIR is long.
  let base = null;
  for (const parent of [fs.realpathSync(os.tmpdir()), "/private/tmp"]) {
    const candidate = fs.mkdtempSync(path.join(parent, "d14t-"));
    fs.chmodSync(candidate, 0o700);
    if (Buffer.byteLength(path.join(candidate, "c/l/local-control.sock")) <= 100) {
      base = candidate;
      break;
    }
    fs.rmSync(candidate, { recursive: true, force: true });
  }
  assert.ok(base, "no scratch directory short enough for a unix socket");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return {
    base,
    client: path.join(base, "c"),
    stateRoot: path.join(base, "c/l"),
    registry: path.join(base, "identity"),
    env: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base, LANG: "C", LC_ALL: "C" },
  };
}

const lastJson = (text) => JSON.parse(text.trim().split("\n").filter(Boolean).pop());

test("the rehearsal driver parses", async () => {
  await exec(process.execPath, ["--check", driver]);
});

test("pty-run.py gives the command a terminal on stdin, stdout and stderr and passes its exit code on", { skip: !fs.existsSync("/usr/bin/python3") }, async () => {
  const probe = "console.log(JSON.stringify([process.stdin.isTTY === true, process.stdout.isTTY === true, process.stderr.isTTY === true]))";
  const ok = await exec("/usr/bin/python3", ["-I", ptyRun, process.execPath, "-e", probe]);
  assert.deepEqual(JSON.parse(ok.stdout.trim()), [true, true, true]);
  assert.match(ok.stderr, /pty-exit: 0\n$/);
  await assert.rejects(
    exec("/usr/bin/python3", ["-I", ptyRun, process.execPath, "-e", "process.exit(3)"]),
    (error) => error.code === 3 && /pty-exit: 3\n$/.test(error.stderr),
  );
  // without a terminal the same probe says false, which is why the helper exists
  const piped = await exec(process.execPath, ["-e", probe]);
  assert.deepEqual(JSON.parse(piped.stdout.trim()), [false, false, false]);
});

test("host.mjs builds a scratch v1 registry, reads it, upgrades it without the floor, and reports the old-style write that v2 refuses", async (t) => {
  const s = scratch(t);
  const helper = async (...args) => lastJson((await exec(process.execPath, [hostScript, ...args], { env: s.env })).stdout);

  const prepared = await helper("prepare", repo, s.client, s.stateRoot, s.registry, "alpha", "beta");
  assert.equal(prepared.ok, true);
  assert.equal(prepared.sequence, 3);
  assert.match(prepared.principals.alpha, /^agent_[0-9a-f]{32}$/);
  assert.notEqual(prepared.principals.alpha, prepared.principals.beta);
  const router = JSON.parse(fs.readFileSync(path.join(s.stateRoot, "router.json"), "utf8"));
  assert.deepEqual([router.enabled, router.registryRoot], [true, s.registry]);

  assert.deepEqual(await helper("read", repo, s.registry), { ok: true, state: "ok", schema: V1, sequence: 3, bindings: 2 });

  assert.deepEqual(await helper("force-upgrade", repo, s.registry), { ok: true, schema: V2, sequence: 4 });
  assert.deepEqual(await helper("read", repo, s.registry), { ok: true, state: "ok", schema: V2, sequence: 4, bindings: 2 });

  // a v1-shaped write on a v2 registry is refused with a code, not thrown
  const before = fs.readFileSync(path.join(s.registry, "identity-registry-v1.json"));
  const refused = await helper("bind", repo, s.registry, "gamma", "4");
  assert.equal(refused.ok, false);
  assert.equal(typeof refused.code, "string");
  assert.deepEqual(fs.readFileSync(path.join(s.registry, "identity-registry-v1.json")), before);
});

test("host.mjs run starts the production host from the bundle's code, prints a ready line and stops cleanly on SIGTERM", async (t) => {
  const s = scratch(t);
  await exec(process.execPath, [hostScript, "prepare", repo, s.client, s.stateRoot, s.registry, "alpha", "beta"], { env: s.env });
  const child = spawn(process.execPath, [hostScript, "run", repo, path.join(s.client, "local-messaging.json")], { env: s.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const ready = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`no ready line: ${stderr}`)), 20000);
    child.stdout.on("data", (d) => {
      buffer += d;
      const line = buffer.split("\n").find((l) => l.includes('"ready"'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    child.on("close", (code) => { clearTimeout(timer); reject(new Error(`host exited early (${code}): ${stderr}`)); });
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.pid, child.pid);
  assert.ok(fs.lstatSync(path.join(s.stateRoot, "local-control.sock")).isSocket());
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const timeout = new Promise((resolve) => setTimeout(() => resolve("the host did not stop within 15 seconds of SIGTERM"), 15000).unref());
  assert.deepEqual(await Promise.race([closed, timeout]), { code: 0, signal: null });
});
