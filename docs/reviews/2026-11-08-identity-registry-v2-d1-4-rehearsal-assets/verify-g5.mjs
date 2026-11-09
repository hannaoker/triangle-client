#!/usr/bin/env node
// Read-only checks around G5, the upgrade of the live registry.
//   node verify-g5.mjs baseline OUT.json                 before the owner upgrades
//   node verify-g5.mjs verify BASELINE.json OUT.json     after; exit 0 only when every check holds
// Reads the live status, discover, process list, registry files (hashes and, through the installed reader, their contents)
// and the identity-backups directory. Writes nothing under the application root.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [mode, a, b] = process.argv.slice(2);
const app = path.join(os.homedir(), "Library/Application Support/The Triangle");
const client = path.join(app, "client");
const registryDir = path.join(app, "identity");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const local = (args) => JSON.parse(run(path.join(app, "bin/triangle-local"), args));
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

function snapshot() {
  const st = local(["status"]);
  const disc = local(["discover"]);
  const rows = run("/bin/ps", ["-axo", "pid=,ppid=,command="]).split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], command: m[3] }));
  const wrappers = rows.filter((r) => r.command.startsWith(`${app}/bin/triangle-mailbox run-supervisor`));
  const children = rows.filter((r) => wrappers.some((w) => w.pid === r.ppid) && r.command.startsWith(`${app}/worker-runtime/bundles/`));
  const backupsDir = path.join(app, "identity-backups");
  return {
    takenAt: new Date().toISOString(),
    journal: st.journal,
    dispatcher: { active: st.dispatcher.active, queued: st.dispatcher.queued },
    wake: st.wake.deliveryState,
    routerEnabled: st.router.enabled,
    registry: st.router.registry,
    discoverEntries: [...disc.entries].sort((x, y) => (x.id < y.id ? -1 : 1)),
    supervisor: { wrappers: wrappers.map((r) => r.pid), children: children.map((r) => ({ pid: r.pid, bundle: ((/bundles\/([0-9a-f]{12})/.exec(r.command)) || [])[1] ?? null })) },
    registryFiles: { registry: sha(path.join(registryDir, "identity-registry-v1.json")), audit: sha(path.join(registryDir, "registry-audit.jsonl")) },
    backups: fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).sort() : null,
  };
}

if (mode === "baseline") {
  const snap = snapshot();
  fs.writeFileSync(a, JSON.stringify(snap, null, 2) + "\n");
  process.stdout.write(`baseline written: registry ${snap.registry.schema} sequence ${snap.registry.sequence}, backups ${JSON.stringify(snap.backups)}, supervisor pids ${snap.supervisor.wrappers}/${snap.supervisor.children.map((c) => c.pid)}, journal ${JSON.stringify(snap.journal)}\n`);
  process.exit(0);
}

if (mode !== "verify") { process.stderr.write("usage: verify-g5.mjs baseline OUT | verify BASELINE OUT\n"); process.exit(64); }
const base = JSON.parse(fs.readFileSync(a, "utf8"));
const now = snapshot();
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`); };

// the supervisor reports the new registry
const r = now.registry;
check("router registry block is ok at the next sequence on schema v2, reading both schemas, same registry directory",
  r.state === "ok" && r.sequence === base.registry.sequence + 1 && r.schema === "identity_registry_v2" && same(r.supportedSchemas, ["identity_registry_v1", "identity_registry_v2"]) && r.rootSha256 === base.registry.rootSha256, r);
// nothing else moved
check("held, queued, queued_local and pending replies unchanged; nothing executing; dispatcher and wake idle; router enabled",
  ["held", "queued", "queued_local", "pendingReplies"].every((k) => now.journal[k] === base.journal[k]) && now.journal.executing === 0 && now.dispatcher.active === 0 && now.dispatcher.queued === 0 && now.wake === "idle" && now.routerEnabled === true,
  { before: base.journal, after: now.journal });
check("discover entries (id, principal, state, route, send permission) identical to before", same(now.discoverEntries, base.discoverEntries), { entries: now.discoverEntries.length });
check("the supervisor was not restarted (same wrapper and node child pids)", same(now.supervisor.wrappers, base.supervisor.wrappers) && same(now.supervisor.children.map((c) => c.pid), base.supervisor.children.map((c) => c.pid)), { wrappers: now.supervisor.wrappers, children: now.supervisor.children });

// the backup
const backups = (now.backups ?? []).filter((n) => n.startsWith("backup-v1-"));
const backupDir = backups.length === 1 ? path.join(app, "identity-backups", backups[0]) : null;
check("identity-backups holds exactly one backup-v1-* folder and nothing else", backupDir !== null && now.backups.length === 1, now.backups);
let v1 = null;
if (backupDir) {
  const names = fs.readdirSync(backupDir).sort();
  check("the backup holds exactly the two registry files, equal to the pre-upgrade bytes, modes 0700/0600",
    same(names, ["identity-registry-v1.json", "registry-audit.jsonl"]) && sha(path.join(backupDir, "identity-registry-v1.json")) === base.registryFiles.registry && sha(path.join(backupDir, "registry-audit.jsonl")) === base.registryFiles.audit
      && (fs.statSync(backupDir).mode & 0o777) === 0o700 && names.every((n) => (fs.statSync(path.join(backupDir, n)).mode & 0o777) === 0o600), names);
  v1 = JSON.parse(fs.readFileSync(path.join(backupDir, "identity-registry-v1.json"), "utf8"));
}

// the live registry, read with the installed reader (read only; it verifies the hash chain)
const installedSrc = path.join(app, "releases", JSON.parse(fs.readFileSync(path.join(app, "package-install.json"), "utf8")).version, "packages/agent-worker/src/identity-registry.mjs");
const { readIdentityRegistry } = await import(pathToFileURL(installedSrc).href);
const live = readIdentityRegistry({ root: registryDir });
const reg = live.registry;
check("the installed reader reads the live registry: v2, the next sequence, the same number of bindings, no unfinished write",
  live.state === "ok" && reg.schema === "identity_registry_v2" && reg.sequence === base.registry.sequence + 1 && v1 && Object.keys(reg.bindings).length === Object.keys(v1.bindings).length && live.audit.uncommittedTail === 0,
  { schema: reg.schema, sequence: reg.sequence, bindings: Object.keys(reg.bindings).length, uncommittedTail: live.audit.uncommittedTail });
const audit = fs.readFileSync(path.join(registryDir, "registry-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const oldAudit = v1 ? fs.readFileSync(path.join(backupDir, "registry-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
check("the audit log is the old entries unchanged plus one upgrade entry", v1 && audit.length === oldAudit.length + 1 && same(audit.slice(0, oldAudit.length), oldAudit) && audit[audit.length - 1].action === "upgrade", { actions: audit.map((x) => x.action) });
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const different = v1 ? Object.entries(v1.bindings).filter(([id, old]) => JSON.stringify(canon(reg.bindings[id])) !== JSON.stringify(canon({ ...old, schema: "local_profile_binding_v2", principal_public_key: null }))).map(([, old]) => old.profile_name) : ["(no backup)"];
check("every binding equals its v1 form plus the new schema name and a null public key; the new collections are empty; createdAt unchanged",
  different.length === 0 && ["pairings", "aliases", "destinations"].every((k) => reg[k] && Object.keys(reg[k]).length === 0) && v1 && reg.createdAt === v1.createdAt, { different });

// the installed CLI
let plan = null;
try { plan = JSON.parse(run(path.join(os.homedir(), ".local/bin/triangle"), ["identity", "upgrade-registry", "--client-root", client, "--json"])); } catch (error) { plan = { error: String(error.message).slice(0, 200) }; }
check("a new plan says the registry is already v2 and the floor still passes (nothing to do)", plan && same(plan.refusals, ["registry_already_v2"]) && plan.floor?.manifest?.ok === true && plan.floor?.supervisor?.ok === true, { refusals: plan?.refusals });
let view = "";
try { view = run(path.join(os.homedir(), ".local/bin/triangle"), ["status", "--identity", "--client-root", client]); } catch (error) { view = String(error.stdout ?? error.message); }
const registryLine = view.split("\n").find((l) => /Registry:/.test(l)) ?? "";
check("the installed `triangle status --identity` shows the registry as ok on schema v2", /ok/.test(registryLine) && /identity_registry_v2|v2/.test(registryLine), registryLine.trim().replace(os.homedir(), "~"));

const ok = checks.every((c) => c.ok);
const out = { ok, takenAt: now.takenAt, baselineTakenAt: base.takenAt, backup: backupDir ? path.basename(backupDir) : null, checks, snapshot: { ...now, discoverEntries: `${now.discoverEntries.length} entries` } };
fs.writeFileSync(b, JSON.stringify(out, null, 2) + "\n");
process.stdout.write(`\nverdict: ${ok ? "pass" : "FAIL"} (${checks.filter((c) => c.ok).length}/${checks.length})\n`);
process.exit(ok ? 0 : 1);
