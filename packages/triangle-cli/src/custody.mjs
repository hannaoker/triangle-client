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
import { createRequire } from "node:module";
import { closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
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
  // Create missing ancestors one by one and fsync each parent, so a new
  // directory entry is durable before anything inside it is relied on.
  const missing = [];
  for (let cursor = path.resolve(dir); !existsSync(cursor); cursor = path.dirname(cursor)) missing.unshift(cursor);
  for (const created of missing) {
    try { mkdirSync(created, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    syncDir(path.dirname(created));
  }
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
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF", "ENOENT"].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAtomic(file, text, mode) {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
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
  if (!existsSync(file)) return;
  rmSync(file, options);
  syncDir(path.dirname(file));
}

/** Roots locked by this process: re-entry would let two writers interleave. */
const HELD = new Set();
const require = createRequire(import.meta.url);
let sqliteModule = null;
/** node:sqlite (Node ≥22.13 unflagged) without its one-time ExperimentalWarning on stderr. */
function sqlite() {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    if (type === "ExperimentalWarning" && /SQLite/i.test(String(warning?.message ?? warning))) return undefined;
    return original.call(this, warning, ...rest);
  };
  try {
    sqliteModule = require("node:sqlite");
  } catch (error) {
    throw new LocalStateError(`triangle needs Node 22.13 or newer (node:sqlite unavailable: ${error.message}).`);
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
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
   * Exclusive writer lock, held as an SQLite `BEGIN EXCLUSIVE` transaction on
   * `<home>/.lock.db`. SQLite uses OS advisory locks (fcntl), which the kernel
   * releases when the holder exits, so there is no stale-lock takeover at all,
   * and two processes can never both hold it. Re-entry from the same process
   * is refused.
   */
  function withLock(fn) {
    init();
    if (HELD.has(root)) throw new LocalStateError(`${root} is already locked by this process.`);
    const lockFile = p(".lock.db");
    if (!existsSync(lockFile)) {
      try { closeSync(openSync(lockFile, "wx", 0o600)); syncDir(root); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const db = new (sqlite().DatabaseSync)(lockFile);
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      db.close();
      if (/locked|busy/i.test(error.message)) throw new LocalStateError(`Another triangle command is using ${root}; try again when it finishes.`);
      throw error;
    }
    HELD.add(root);
    const release = () => {
      HELD.delete(root);
      try { db.exec("ROLLBACK"); } catch {}
      try { db.close(); } catch {}
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
