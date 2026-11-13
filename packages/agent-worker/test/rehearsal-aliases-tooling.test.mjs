// Smoke tests for the AD.3 rehearsal tooling (docs/reviews/2026-11-12-identity-aliases-ad3-rehearsal-assets).
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
import { clearIdentityAlias, readIdentityRegistry, setIdentityAlias } from "../src/identity-registry.mjs";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const assets = path.join(repo, "docs/reviews/2026-11-12-identity-aliases-ad3-rehearsal-assets");
const d14Assets = path.join(repo, "docs/reviews/2026-11-08-identity-registry-v2-d1-4-rehearsal-assets");
const hostScript = path.join(assets, "alias-host.mjs");
const V1 = "identity_registry_v1";
const V2 = "identity_registry_v2";

function scratch(t) {
  // Short, because a unix socket path may not exceed 100 bytes: fall back to /private/tmp when TMPDIR is long.
  let base = null;
  for (const parent of [fs.realpathSync(os.tmpdir()), "/private/tmp"]) {
    const candidate = fs.mkdtempSync(path.join(parent, "ad3t-"));
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
    registry: path.join(base, "identity"),
    env: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base, LANG: "C", LC_ALL: "C" },
  };
  s.spec = (local, bound, name = "spec.json") => {
    const file = path.join(base, name);
    fs.writeFileSync(file, JSON.stringify({ clientRoot: s.client, stateRoot: s.stateRoot, registryRoot: s.registry, local, bound }));
    return file;
  };
  s.helper = async (...args) => lastJson((await exec(process.execPath, [hostScript, ...args], { env: s.env })).stdout);
  return s;
}

const lastJson = (text) => JSON.parse(text.trim().split("\n").filter(Boolean).pop());
const auditActions = (s) => fs.readFileSync(path.join(s.registry, "registry-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).action);

test("the rehearsal driver, its shared helpers and the helper script parse", async () => {
  for (const file of ["rehearsal-aliases.mjs", "lib.mjs", "alias-host.mjs"]) await exec(process.execPath, ["--check", path.join(assets, file)]);
  await exec("/usr/bin/python3", ["-I", "-c", `import ast,sys; ast.parse(open(${JSON.stringify(path.join(assets, "mutation-check.py"))}).read())`]);
});

test("the pty helper is the D1.4 one, byte for byte (the two copies must not drift)", () => {
  assert.deepEqual(fs.readFileSync(path.join(assets, "pty-run.py")), fs.readFileSync(path.join(d14Assets, "pty-run.py")));
});

test("alias-host.mjs builds the scratch world: bound and unbound recipients, a bound profile that is not a recipient, a v1 registry", async (t) => {
  const s = scratch(t);
  const prepared = await s.helper("prepare", repo, s.spec(["alpha", "beta", "scratch-b"], ["alpha", "beta", "ghost"]));
  assert.equal(prepared.ok, true);
  assert.equal(prepared.sequence, 4, "init and three binds");
  assert.equal(prepared.registryWasInPlace, false);
  for (const profile of ["alpha", "beta", "ghost"]) assert.match(prepared.principals[profile], /^agent_[0-9a-f]{32}$/, profile);
  assert.equal(prepared.principals["scratch-b"], null, "scratch-b is a recipient without a binding");
  for (const profile of ["alpha", "beta", "scratch-b", "ghost"]) assert.match(prepared.instances[profile], /^[0-9a-f]{64}$/, profile);
  const config = JSON.parse(fs.readFileSync(path.join(s.client, "local-messaging.json"), "utf8"));
  assert.deepEqual(config.recipients.map((r) => r.profile), ["alpha", "beta", "scratch-b"], "ghost is bound and not a local recipient");
  const router = JSON.parse(fs.readFileSync(path.join(s.stateRoot, "router.json"), "utf8"));
  assert.deepEqual([router.enabled, router.registryRoot], [true, s.registry]);
  assert.deepEqual(await s.helper("read", repo, s.registry), { ok: true, state: "ok", schema: V1, sequence: 4, bindings: 3, aliases: {} });
  assert.deepEqual(auditActions(s), ["init", "bind", "bind", "bind"]);
});

test("alias-host.mjs prepare with init:false starts the registry with its first bind, as the live registry does", async (t) => {
  const s = scratch(t);
  const file = path.join(s.base, "spec-noinit.json");
  fs.writeFileSync(file, JSON.stringify({ clientRoot: s.client, stateRoot: s.stateRoot, registryRoot: s.registry, local: ["alpha", "beta"], bound: ["alpha", "beta", "ghost"], init: false }));
  const prepared = await s.helper("prepare", repo, file);
  assert.equal(prepared.sequence, 3);
  assert.deepEqual(auditActions(s), ["bind", "bind", "bind"]);
  assert.deepEqual(await s.helper("read", repo, s.registry), { ok: true, state: "ok", schema: V1, sequence: 3, bindings: 3, aliases: {} });
  assert.deepEqual(await s.helper("force-upgrade", repo, s.registry), { ok: true, schema: V2, sequence: 4 });
});

test("alias-host.mjs ids agrees with the ids prepare derived, and a second prepare adds a recipient without touching the registry", async (t) => {
  const s = scratch(t);
  const first = await s.helper("prepare", repo, s.spec(["alpha", "beta"], ["alpha", "beta"]));
  const ids = await s.helper("ids", repo, "alpha", "late");
  assert.equal(ids.alpha, first.instances.alpha);
  const bytes = () => ["identity-registry-v1.json", "registry-audit.jsonl"].map((name) => fs.readFileSync(path.join(s.registry, name)).toString("hex"));
  const before = bytes();
  const again = await s.helper("prepare", repo, s.spec(["alpha", "beta", "late"], ["alpha", "beta"], "spec2.json"));
  assert.equal(again.registryWasInPlace, true);
  assert.equal(again.sequence, first.sequence);
  assert.equal(again.principals.late, null);
  assert.equal(again.instances.late, ids.late);
  assert.deepEqual(bytes(), before, "the registry in place is not changed by prepare");
  const config = JSON.parse(fs.readFileSync(path.join(s.client, "local-messaging.json"), "utf8"));
  assert.deepEqual(config.recipients.map((r) => r.profile), ["alpha", "beta", "late"]);
});

test("alias-host.mjs upgrades without the floor, reads aliases written by the real writer, and binds with a v2 binding on a v2 registry", async (t) => {
  const s = scratch(t);
  const prepared = await s.helper("prepare", repo, s.spec(["alpha", "beta"], ["alpha", "beta"]));
  assert.deepEqual(await s.helper("force-upgrade", repo, s.registry), { ok: true, schema: V2, sequence: 4 });
  setIdentityAlias({ root: s.registry, expectedSequence: 4, alias: "builder", principalId: prepared.principals.alpha });
  const read = await s.helper("read", repo, s.registry);
  assert.equal(read.schema, V2);
  assert.equal(read.sequence, 5);
  assert.deepEqual(Object.keys(read.aliases), ["builder"]);
  assert.equal(read.aliases.builder.principal_id, prepared.principals.alpha);
  assert.equal(read.aliases.builder.generation, 5);

  // a bind on a v2 registry carries the v2 binding shape, and leaves the alias alone
  assert.deepEqual(await s.helper("bind", repo, s.registry, "gamma", "5"), { ok: true });
  const after = await s.helper("read", repo, s.registry);
  assert.equal(after.sequence, 6);
  assert.equal(after.bindings, 3);
  assert.deepEqual(after.aliases, read.aliases);

  clearIdentityAlias({ root: s.registry, expectedSequence: 6, alias: "builder" });
  assert.deepEqual((await s.helper("read", repo, s.registry)).aliases, {});
  assert.equal(readIdentityRegistry({ root: s.registry }).state, "ok");

  // a stale sequence is refused with a code, not thrown
  const stale = await s.helper("bind", repo, s.registry, "delta", "5");
  assert.equal(stale.ok, false);
  assert.equal(typeof stale.code, "string");
});

test("alias-host.mjs run starts the production host from the bundle's code, prints a ready line and stops cleanly on SIGTERM", async (t) => {
  const s = scratch(t);
  await s.helper("prepare", repo, s.spec(["alpha", "beta"], ["alpha", "beta"]));
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

test("the driver's expected supervisor diff is exactly the list of modules plan section 6 names", () => {
  const driver = fs.readFileSync(path.join(assets, "rehearsal-aliases.mjs"), "utf8");
  const block = /const EXPECTED_SUPERVISOR_DIFF = \[([\s\S]*?)\];/.exec(driver)?.[1] ?? "";
  const listed = [...block.matchAll(/"([^"]+)"/g)].map((m) => path.basename(m[1], ".mjs")).sort();
  assert.deepEqual(listed, [
    "grok-local-session", "identity-primitives", "identity-registry", "local-messaging-cli", "local-messaging-client",
    "local-messaging-journal", "local-messaging-protocol", "local-messaging-server", "recipient-resolver",
    "router-registry-snapshot", "unified-router",
  ]);
  for (const name of listed) assert.ok(fs.existsSync(path.join(repo, "packages/agent-worker/src", `${name}.mjs`)), name);
});
