// Shared helpers of the AD.3 rehearsal driver (rehearsal-aliases.mjs). Copied, with small changes, from the D1.4 driver
// (docs/reviews/2026-11-08-identity-registry-v2-d1-4-rehearsal-assets/rehearsal.mjs), which stays as it was: it is the
// evidence for commit 58df2de and its flow (a baseline that cannot read v2) no longer applies to the installed bundle.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256Buffer = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
export const sha256File = (file) => sha256Buffer(fs.readFileSync(file));
export const sha256Text = (text) => sha256Buffer(Buffer.from(text, "utf8"));
export const mode = (file) => fs.lstatSync(file).mode & 0o7777;
export const octal = (value) => `0${value.toString(8)}`;

// Runs a command without a shell. stdin is closed unless `input` is given. The child leads its own process group so a
// timeout can kill everything it started.
export function run(command, args, { env, cwd, timeoutMs = 60000, label, input } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { env, cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (input !== undefined) child.stdin.end(input);
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started, timedOut: killed, label: label ?? `${path.basename(command)} ${args[0] ?? ""}` });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: String(error), ms: Date.now() - started, timedOut: false, label });
    });
  });
}

export const parseJson = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};
export const lastJsonLine = (text) => {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const value = parseJson(lines[i]);
    if (value !== null) return value;
  }
  return null;
};
export const jsonOf = (result) => parseJson(result.stdout) ?? lastJsonLine(result.stdout) ?? lastJsonLine(result.stderr);

export class CheckFailed extends Error {}
export function check(condition, message, details) {
  if (!condition) {
    const error = new CheckFailed(message);
    error.details = details;
    throw error;
  }
}
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------------------------------- live-root fingerprint

function briefStat(file) {
  try {
    const s = fs.lstatSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, mode: octal(s.mode & 0o7777), ino: s.ino };
  } catch (error) {
    return { error: error.code ?? "error" };
  }
}

async function processList(live) {
  // The supervisor is launchd's `triangle-mailbox run-supervisor` wrapper and its child node process (the installed
  // bundle's node). Other processes of the installed system come and go on their own, so they are not compared.
  const result = await run("/bin/ps", ["-axo", "pid=,ppid=,command="], { env: { PATH: "/usr/bin:/bin" } });
  const rows = result.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  const wrappers = rows.filter((r) => r.command.startsWith(`${live}/bin/triangle-mailbox run-supervisor`));
  const children = rows.filter((r) => wrappers.some((w) => w.pid === r.ppid) && r.command.startsWith(`${live}/worker-runtime/bundles/`));
  return [...wrappers, ...children].map((r) => `${r.pid} ${r.ppid} ${r.command.replace(/\s+/g, " ").slice(0, 200)}`).sort();
}

// What the rehearsal compares before and after: content hashes only for files that carry no secret, stat data (ctime
// included) for everything else. The journal, credentials and other client files are not read.
export async function fingerprintLive(live, releaseVersion, bundleId) {
  const hashed = [
    "worker-runtime/supervisor.manifest.json",
    "worker-runtime/codex.manifest.json",
    "worker-runtime/hermes.manifest.json",
    "worker-runtime/antigravity.manifest.json",
    "bin/triangle-local",
    "bin/triangle",
    "bin/triangle-mailbox",
    "bin/triangle-client",
    "package-install.json",
    `releases/${releaseVersion}/package-manifest.json`,
  ];
  const files = {};
  for (const rel of hashed) {
    const file = path.join(live, rel);
    files[rel] = fs.existsSync(file) ? { sha256: sha256File(file), ...briefStat(file) } : { absent: true };
  }
  const listing = (rel) => (fs.existsSync(path.join(live, rel)) ? fs.readdirSync(path.join(live, rel)).sort() : null);
  const identity = {};
  for (const name of listing("identity") ?? []) identity[name] = briefStat(path.join(live, "identity", name));
  const backups = {};
  for (const name of listing("identity-backups") ?? []) backups[name] = briefStat(path.join(live, "identity-backups", name));
  // The baseline supervisor bundle: one digest over every entry's path, size, mtime, ctime and mode (reading changes none).
  const bundleRoot = path.join(live, "worker-runtime/bundles", bundleId);
  const treeLines = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      const info = fs.lstatSync(full);
      treeLines.push([path.relative(bundleRoot, full), info.size, info.mtimeMs, info.ctimeMs, info.mode & 0o7777].join("\0"));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(bundleRoot);
  const clientFiles = {};
  for (const rel of ["client/local-messaging.json", "client/local/router.json"]) clientFiles[rel] = briefStat(path.join(live, rel));
  return {
    files,
    identityEntries: identity,
    backupEntries: backups,
    baselineBundleTree: { entries: treeLines.length, sha256: sha256Text(treeLines.join("\n")) },
    clientFiles,
    bundles: listing("worker-runtime/bundles"),
    releases: listing("releases"),
    processes: await processList(live),
  };
}
