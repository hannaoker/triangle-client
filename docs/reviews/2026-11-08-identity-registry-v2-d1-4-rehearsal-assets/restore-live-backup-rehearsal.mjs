#!/usr/bin/env node
// Rehearses restoring the REAL live backup over the REAL live v2 registry, in a scratch application root.
//   node restore-live-backup-rehearsal.mjs OUT.json [--installed-app-root DIR]
// Reads (copies) the live identity/ pair and the single identity-backups/backup-v1-* folder; everything else happens in a
// scratch directory with the INSTALLED `triangle` CLI: the restore plan, then the restore with its plan id in a pseudo-terminal.
// Nothing under the installed root is written, and no supervisor is involved (restore needs none).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [outFile, flag, flagValue] = process.argv.slice(2);
if (!outFile) { process.stderr.write("usage: restore-live-backup-rehearsal.mjs OUT.json [--installed-app-root DIR]\n"); process.exit(64); }
const live = path.resolve(flag === "--installed-app-root" ? flagValue : path.join(os.homedir(), "Library/Application Support/The Triangle"));
const triangle = path.join(os.homedir(), ".local/bin/triangle");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const short = (h) => `${h.slice(0, 12)}…`;
const steps = [];
const check = (name, ok, data) => { steps.push({ name, ok: Boolean(ok), ...data }); process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`); if (!ok) throw new Error(`${name} failed: ${JSON.stringify(data).slice(0, 300)}`); };

const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rr-"));
fs.chmodSync(base, 0o700);
let ok = false;
try {
  const backups = fs.readdirSync(path.join(live, "identity-backups")).filter((n) => /^backup-v1-/.test(n));
  check("the live application root has exactly one backup-v1-* folder", backups.length === 1, { backups: backups.length });
  const backupName = backups[0];
  const app = path.join(base, "a");
  const client = path.join(app, "client");
  const registry = path.join(app, "identity");
  const backupsDir = path.join(app, "identity-backups");
  for (const dir of [app, client, registry, backupsDir, path.join(backupsDir, backupName)]) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); }
  const names = ["identity-registry-v1.json", "registry-audit.jsonl"];
  const liveV2 = {};
  for (const n of names) { fs.copyFileSync(path.join(live, "identity", n), path.join(registry, n)); fs.chmodSync(path.join(registry, n), 0o600); liveV2[n] = sha(path.join(registry, n)); }
  const backupHash = {};
  for (const n of names) { fs.copyFileSync(path.join(live, "identity-backups", backupName, n), path.join(backupsDir, backupName, n)); fs.chmodSync(path.join(backupsDir, backupName, n), 0o600); backupHash[n] = sha(path.join(backupsDir, backupName, n)); }
  const v2 = JSON.parse(fs.readFileSync(path.join(registry, names[0]), "utf8"));
  check("the scratch copy holds the live v2 pair and the live backup", v2.schema === "identity_registry_v2" && liveV2[names[0]] !== backupHash[names[0]], { liveSchema: v2.schema, sequence: v2.sequence });

  const env = { HOME: os.homedir(), PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const backupDir = path.join(backupsDir, backupName);
  const cli = ["identity", "restore-registry", "--client-root", client, "--from", backupDir];
  const plan = spawnSync(triangle, [...cli, "--json"], { env, encoding: "utf8" });
  const planJson = (() => { try { return JSON.parse(plan.stdout); } catch { return null; } })();
  check("the restore plan from the real backup is ready: the backup is an earlier state of this registry, only the upgrade entry is discarded, no routing changes, no v2-only data",
    plan.status === 0 && planJson?.ready === true && planJson.relation === "ahead" && JSON.stringify(planJson.discarded.map((d) => d.action)) === JSON.stringify(["upgrade"])
      && Object.values(planJson.routing).every((l) => l.length === 0) && planJson.live.v2Data.any === false && planJson.refusals.length === 0,
    { exit: plan.status, relation: planJson?.relation, discarded: planJson?.discarded?.map((d) => d.action), refusals: planJson?.refusals });

  const apply = spawnSync("/usr/bin/python3", ["-I", path.join(here, "pty-run.py"), triangle, ...cli, "--confirm", planJson.planId, "--json"], { env, encoding: "utf8" });
  check("the restore applies with the plan id in a terminal", /pty-exit: 0/.test(apply.stderr), { stderr: apply.stderr.trim().slice(-120), stdoutTail: apply.stdout.trim().slice(-200) });

  const after = Object.fromEntries(names.map((n) => [n, sha(path.join(registry, n))]));
  check("the registry is now exactly the backup's bytes", names.every((n) => after[n] === backupHash[n]), { registry: short(after[names[0]]), audit: short(after[names[1]]) });
  const archives = fs.readdirSync(backupsDir).filter((n) => n.startsWith("before-restore-"));
  check("the v2 pair was archived byte for byte before anything was replaced", archives.length === 1 && names.every((n) => sha(path.join(backupsDir, archives[0], n)) === liveV2[n]), { archive: archives[0] });
  check("the backup folder itself is unchanged", names.every((n) => sha(path.join(backupDir, n)) === backupHash[n]), {});

  const release = JSON.parse(fs.readFileSync(path.join(live, "package-install.json"), "utf8")).version;
  const { readIdentityRegistry } = await import(pathToFileURL(path.join(live, "releases", release, "packages/agent-worker/src/identity-registry.mjs")).href);
  const read = readIdentityRegistry({ root: registry });
  check("the installed reader reads the restored registry as v1 with the old sequence and the same bindings", read.state === "ok" && read.registry.schema === "identity_registry_v1" && read.registry.sequence === v2.sequence - 1 && Object.keys(read.registry.bindings).length === Object.keys(v2.bindings).length && read.audit.uncommittedTail === 0,
    { schema: read.registry.schema, sequence: read.registry.sequence, bindings: Object.keys(read.registry.bindings).length });
  ok = true;
} catch (error) {
  process.stdout.write(`ERROR ${error.message}\n`);
} finally {
  fs.writeFileSync(outFile, JSON.stringify({ ok, installedCli: "~/.local/bin/triangle", note: "scratch application root; the installed root is only read", steps }, null, 2) + "\n");
  fs.rmSync(base, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
