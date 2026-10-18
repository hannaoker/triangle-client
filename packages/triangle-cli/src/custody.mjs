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
import { randomBytes } from "node:crypto";
import { closeSync, chmodSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
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

/** fsync a directory so a rename/unlink/mkdir inside it survives power loss. */
function syncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (error) {
    // Some platforms/filesystems refuse fsync on directories; nothing more we can do there.
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAtomic(file, text, mode) {
  const dir = path.dirname(file);
  const created = !existsSync(dir);
  ensurePrivateDir(dir);
  if (created) syncDir(path.dirname(dir));
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, mode);
  renameSync(temp, file);
  syncDir(dir);
}

function removeDurable(file, options = { force: true }) {
  rmSync(file, options);
  syncDir(path.dirname(file));
}

/** Roots locked by this process: re-entry would let two writers interleave. */
const HELD = new Set();
const LOCK_INIT_GRACE_MS = 10_000;

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (probe) { return probe.code === "EPERM"; }
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

  const SAFE_NAME = /^[A-Za-z0-9_-]{1,80}$/;
  function cachePath(kind, id) {
    if (!SAFE_NAME.test(kind) || !SAFE_NAME.test(id)) throw new LocalStateError(`invalid cache entry ${kind}/${id}`);
    return p("cache", kind, `${id}.json`);
  }

  function init() {
    ensurePrivateDir(root);
    return api;
  }

  /**
   * Exclusive writer lock. The lock file is created exclusively (O_EXCL) and
   * holds "<pid>:<token>". A lock is stale only when its pid is dead (an empty
   * lock is "being created" during a grace period). Stale takeover renames the
   * lock aside atomically and checks it removed exactly the stale content, so
   * two contenders can never both win; release deletes the lock only if it
   * still carries our token. Re-entry from the same process is refused.
   */
  function withLock(fn) {
    init();
    if (HELD.has(root)) throw new LocalStateError(`${root} is already locked by this process.`);
    const lockFile = p(".lock");
    const token = `${process.pid}:${randomBytes(12).toString("hex")}`;
    const readLock = (file) => { try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      try {
        const fd = openSync(lockFile, "wx", 0o600);
        try { writeSync(fd, token); fsyncSync(fd); } finally { closeSync(fd); }
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const content = readLock(lockFile);
      if (content === null) continue; // released meanwhile
      const holder = Number(content.split(":")[0]);
      if (!content) {
        let age = 0;
        try { age = Date.now() - statSync(lockFile).mtimeMs; } catch { continue; }
        if (age < LOCK_INIT_GRACE_MS) throw new LocalStateError(`Another triangle command is starting on ${root}; try again.`);
      } else if (pidAlive(holder)) {
        throw new LocalStateError(`Another triangle command (pid ${holder}) is using ${root}.`);
      }
      const aside = `${lockFile}.stale-${randomBytes(6).toString("hex")}`;
      try { renameSync(lockFile, aside); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (readLock(aside) !== content) {
        // We moved a lock someone else just created: put it back (never clobber) and back off.
        let restored = false;
        try { linkSync(aside, lockFile); restored = true; } catch {}
        if (restored) { try { unlinkSync(aside); } catch {} }
        throw new LocalStateError(`Another triangle command is using ${root}.`);
      }
      unlinkSync(aside);
    }
    if (!acquired) throw new LocalStateError(`Could not lock ${root}.`);
    HELD.add(root);
    const release = () => {
      HELD.delete(root);
      try { if (readLock(lockFile) === token) unlinkSync(lockFile); } catch {}
    };
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
    removeJournal: (name) => removeDurable(p("journal", `${name}.json`)),
    listJournal: () => (existsSync(p("journal")) ? readdirSync(p("journal")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : []),

    readCache: (kind, id) => readJsonFile(cachePath(kind, id)),
    writeCache: (kind, id, value) => writeAtomic(cachePath(kind, id), `${JSON.stringify(value)}\n`, 0o600),
    removeCache: (kind, id) => rmSync(cachePath(kind, id), { force: true }),
    /** Forget an agent that no longer exists on the server: its workload key and cached views. */
    removeAgent(agentId) {
      rmSync(api.agentDir(agentId), { recursive: true, force: true });
      rmSync(cachePath("permissions", agentId), { force: true });
    },

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
