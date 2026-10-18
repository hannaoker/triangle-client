// Portable protected-file custody (§1.1, pivot §8): one state home per device,
// directories 0700, secret files 0600, atomic writes, one writer at a time.
//
// Layout under the home:
//   authority.json                      authority + optional transport override
//   owner/owner-key.json        (0600)  the device owner key (never given to workers)
//   owner/controller.json               owner_id, controller_id, role, device label, state
//   agents/<agent_id>/agent.json        handle, name, workload_id, bounds
//   agents/<agent_id>/workload-key.json (0600) the agent's workload key
//   journal/<name>.json         (0600)  signed requests persisted before sending
//   cache/permissions/<agent_id>.json   last permissions view + ETag
import { closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { LocalStateError } from "./errors.mjs";
import { assertPrivateJwk } from "./keys.mjs";
import { AGENT_ID } from "./protocol.mjs";

export function defaultHome(env = process.env, platform = process.platform) {
  if (env.TRIANGLE_HOME) return path.resolve(env.TRIANGLE_HOME);
  const home = os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "The Triangle", "v1");
  const state = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(state, "triangle", "v1");
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalStateError(`${dir} is not a directory`);
  if (stat.uid !== process.getuid?.()) throw new LocalStateError(`${dir} is not owned by this user`);
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function writeAtomic(file, text, mode) {
  ensurePrivateDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temp, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, mode);
  renameSync(temp, file);
}

function readJsonFile(file, { secret = false } = {}) {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new LocalStateError(`${file} is not a regular file`);
  if (secret && (stat.mode & 0o077) !== 0) throw new LocalStateError(`${file} is readable by other users; refusing to use it (chmod 600).`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new LocalStateError(`${file} is not valid JSON`);
  }
}

export function openCustody(home = defaultHome()) {
  const root = path.resolve(home);
  const p = (...parts) => path.join(root, ...parts);

  function init() {
    ensurePrivateDir(root);
    return api;
  }

  /** Exclusive writer lock; a stale lock (dead pid) is taken over. */
  function withLock(fn) {
    init();
    const lockFile = p(".lock");
    let fd;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fd = openSync(lockFile, "wx", 0o600);
        writeSync(fd, String(process.pid));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const holder = Number(readFileSync(lockFile, "utf8"));
        let alive = false;
        try { if (Number.isSafeInteger(holder) && holder > 0) { process.kill(holder, 0); alive = true; } } catch (probe) { alive = probe.code === "EPERM"; }
        if (alive && holder !== process.pid) throw new LocalStateError(`Another triangle command (pid ${holder}) is using ${root}.`);
        unlinkSync(lockFile);
      }
    }
    if (fd === undefined) throw new LocalStateError(`Could not lock ${root}.`);
    const release = () => { try { closeSync(fd); } catch {} try { unlinkSync(lockFile); } catch {} };
    let result;
    try {
      result = fn();
    } catch (error) {
      release();
      throw error;
    }
    if (result && typeof result.then === "function") return result.finally(release);
    release();
    return result;
  }

  const api = {
    root,
    init,
    withLock,
    readAuthority: () => readJsonFile(p("authority.json")),
    writeAuthority: (value) => writeAtomic(p("authority.json"), `${JSON.stringify(value, null, 2)}\n`, 0o600),

    readOwnerKey() {
      const value = readJsonFile(p("owner", "owner-key.json"), { secret: true });
      return value ? assertPrivateJwk(value) : null;
    },
    writeOwnerKey(jwk) {
      if (existsSync(p("owner", "owner-key.json"))) throw new LocalStateError("This device already has an owner key; refusing to overwrite it.");
      writeAtomic(p("owner", "owner-key.json"), `${JSON.stringify(assertPrivateJwk(jwk))}\n`, 0o600);
    },
    readController: () => readJsonFile(p("owner", "controller.json")),
    writeController: (value) => writeAtomic(p("owner", "controller.json"), `${JSON.stringify(value, null, 2)}\n`, 0o600),

    agentDir: (agentId) => {
      if (!AGENT_ID.test(agentId)) throw new LocalStateError(`invalid agent id ${agentId}`);
      return p("agents", agentId);
    },
    listAgents() {
      if (!existsSync(p("agents"))) return [];
      return readdirSync(p("agents")).filter((name) => AGENT_ID.test(name)).map((id) => api.readAgent(id)).filter(Boolean);
    },
    readAgent: (agentId) => readJsonFile(path.join(api.agentDir(agentId), "agent.json")),
    writeAgent: (agentId, value) => writeAtomic(path.join(api.agentDir(agentId), "agent.json"), `${JSON.stringify(value, null, 2)}\n`, 0o600),
    readWorkloadKey(agentId) {
      const value = readJsonFile(path.join(api.agentDir(agentId), "workload-key.json"), { secret: true });
      return value ? assertPrivateJwk(value) : null;
    },
    workloadKeyPath: (agentId) => path.join(api.agentDir(agentId), "workload-key.json"),
    writeWorkloadKey: (agentId, jwk) => writeAtomic(path.join(api.agentDir(agentId), "workload-key.json"), `${JSON.stringify(assertPrivateJwk(jwk))}\n`, 0o600),

    /** Pending (not yet bound to an agent id) workload keys live in the journal entry that will create them. */
    readJournal: (name) => readJsonFile(p("journal", `${name}.json`), { secret: true }),
    writeJournal: (name, value) => writeAtomic(p("journal", `${name}.json`), `${JSON.stringify(value)}\n`, 0o600),
    removeJournal: (name) => rmSync(p("journal", `${name}.json`), { force: true }),
    listJournal: () => (existsSync(p("journal")) ? readdirSync(p("journal")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : []),

    readCache: (kind, id) => readJsonFile(p("cache", kind, `${id}.json`)),
    writeCache: (kind, id, value) => writeAtomic(p("cache", kind, `${id}.json`), `${JSON.stringify(value)}\n`, 0o600),

    /** Paths whose mode must stay private, for doctor. */
    auditModes() {
      const problems = [];
      const visit = (dir) => {
        if (!existsSync(dir)) return;
        const stat = statSync(dir);
        if ((stat.mode & 0o077) !== 0) problems.push(dir);
        for (const name of readdirSync(dir)) {
          const full = path.join(dir, name);
          const child = lstatSync(full);
          if (child.isDirectory()) visit(full);
          else if ((child.mode & 0o077) !== 0) problems.push(full);
        }
      };
      visit(root);
      return problems;
    },
  };
  return api;
}
