import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
export const ST = process.env.ST;
// CLIENT_BIN runs `codex queue` and the persistent server; OWNER_BIN is the owner stand-in (the ChatGPT-bundled build).
export const CLIENT_BIN = process.env.CLIENT_BIN || '/opt/homebrew/Caskroom/codex/0.163.0/bin/codex';
export const OWNER_BIN = process.env.OWNER_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
export const CODEX_HOME = process.env.CODEX_HOME;
export const t0 = Date.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Like Promise.race with a timer, but the timer is cleared so it cannot keep the process alive after the race is decided.
export function raceTimeout(promise, ms, fallback) {
  let t;
  return Promise.race([promise, new Promise((res) => { t = setTimeout(() => res(fallback), ms); })]).finally(() => clearTimeout(t));
}
export function log(...a) { const s = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ` + a.join(' '); console.log(s); fs.appendFileSync(path.join(ST, 'logs', 'driver.log'), s + '\n'); }
export function codexProcs() {
  const r = spawnSync('pgrep', ['-lf', 'codex'], { encoding: 'utf8' });
  const out = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^(\d+)\s+(.*)$/.exec(line.trim());
    // Keep only processes whose executable is named codex. Unrelated commands that merely mention "codex" (for example the
    // icon thumbnailers the ChatGPT app starts) are not ours: they must not be reported as spawned or ever be touched.
    if (m && /(^|\/)codex( |$)/.test(m[2])) out.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return out;
}
// Codex processes that already existed when this run started; they belong to someone else.
const BASELINE_PIDS = new Set(codexProcs().map((p) => p.pid));
export function ppidOf(pid) {
  const r = spawnSync('lsof', ['-nP', '-R', '-p', String(pid), '-a', '-d', 'cwd'], { encoding: 'utf8' });
  const l = (r.stdout || '').split('\n')[1]; if (!l) return null; const c = l.trim().split(/\s+/); return Number(c[2]) || null;
}
export function lsofCount(pid, needle) { const r = spawnSync('lsof', ['-nP', '-p', String(pid)], { encoding: 'utf8' }); return r.stdout.split('\n').filter((l) => l.includes(needle)).length; }
export function lockHolders(threadId) { const f = path.join(CODEX_HOME, 'thread-writer-locks', `${threadId}.lock`); if (!fs.existsSync(f)) return null; const r = spawnSync('lsof', ['-t', f], { encoding: 'utf8' }); return r.stdout.split('\n').filter(Boolean).map(Number); }
export function sql(q) { const db = path.join(CODEX_HOME, 'queue_1.sqlite'); if (!fs.existsSync(db)) return '(no queue_1.sqlite)'; const r = spawnSync('sqlite3', ['-readonly', db, q], { encoding: 'utf8' }); return (r.stdout + r.stderr).trim(); }
export function tree(dir, depth = 3, prefix = '') {
  const out = []; let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name); let sz = ''; try { sz = e.isFile() ? ' ' + fs.statSync(p).size + 'B' : ''; } catch {}
    out.push(prefix + e.name + (e.isDirectory() ? '/' : e.isSymbolicLink() ? '@' : '') + sz);
    if (e.isDirectory() && depth > 1) out.push(...tree(p, depth - 1, prefix + '  '));
  }
  return out;
}
export function mockRequests() { const f = path.join(ST, 'logs', 'mock-requests.jsonl'); if (!fs.existsSync(f)) return []; return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !e.done); }

// JSON-RPC over stdio (JSONL) to an app-server child we own.
export class Owner {
  constructor(name, bin, args = ['app-server'], extraEnv = {}) {
    this.name = name; this.nextId = 1; this.pending = new Map(); this.events = []; this.buf = '';
    this.proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
    this.errFile = path.join(ST, 'logs', `${name}.stderr`); this.rpcFile = path.join(ST, 'logs', `${name}.rpc.jsonl`);
    fs.writeFileSync(this.errFile, ''); fs.writeFileSync(this.rpcFile, '');
    this.proc.stderr.on('data', (d) => fs.appendFileSync(this.errFile, d));
    this.exited = new Promise((res) => this.proc.on('exit', (code, sig) => { this.exitInfo = { code, sig }; res(this.exitInfo); }));
    this.proc.stdout.on('data', (d) => { this.buf += d; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (line.trim()) this.onLine(line); } });
  }
  rec(dir, obj) { fs.appendFileSync(this.rpcFile, JSON.stringify({ t: Date.now(), dir, ...obj }) + '\n'); }
  onLine(line) {
    let msg; try { msg = JSON.parse(line); } catch { this.rec('in-raw', { line: line.slice(0, 300) }); return; }
    this.rec('in', msg);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); p(msg); return; }
    if (msg.id !== undefined && msg.method) { // server-initiated request: decline everything
      this.send({ id: msg.id, result: { decision: 'decline' } }); return; }
    this.events.push({ t: Date.now(), method: msg.method, params: msg.params });
  }
  send(obj) { this.rec('out', obj); this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(to); res(m); });
      this.send({ id, method, params });
    });
  }
  notify(method, params) { this.send(params === undefined ? { method } : { method, params }); }
  async init() {
    const r = await this.request('initialize', { clientInfo: { name: 'stagea-driver', title: 'Stage A driver', version: '0' }, capabilities: { experimentalApi: true } });
    this.notify('initialized'); return r;
  }
  eventsSince(t, methods) { return this.events.filter((e) => e.t >= t && (!methods || methods.some((m) => e.method === m || e.method.startsWith(m)))); }
  async waitEvent(pred, timeoutMs = 30000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { const e = this.events.find(pred); if (e) return e; await sleep(100); } return null; }
  async stop() { try { this.proc.stdin.end(); } catch {} this.proc.kill('SIGTERM'); const r = await raceTimeout(this.exited, 4000, null); if (!r) { this.proc.kill('SIGKILL'); await this.exited; } return this.exitInfo; }
}

// Run a short-lived CLI invocation while sampling which codex processes appear.
export async function runCli({ label, bin, args, env = {}, timeoutMs = 60000, sampleMs = 100 }) {
  const before = new Set(codexProcs().map((p) => p.pid));
  const started = Date.now(); const seen = new Map();
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let out = '', err = ''; child.stdout.on('data', (d) => out += d); child.stderr.on('data', (d) => err += d);
  const exit = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
  const sampler = setInterval(() => { for (const p of codexProcs()) if (!before.has(p.pid) && p.pid !== child.pid && !seen.has(p.pid)) seen.set(p.pid, { ...p, ppid: ppidOf(p.pid), firstSeenMs: Date.now() - started }); }, sampleMs);
  const r = await raceTimeout(exit, timeoutMs, { timeout: true });
  if (r.timeout) { child.kill('SIGKILL'); }
  const dur = Date.now() - started;
  await sleep(1500); for (const p of codexProcs()) if (!before.has(p.pid) && p.pid !== child.pid && !seen.has(p.pid)) seen.set(p.pid, { ...p, ppid: ppidOf(p.pid), firstSeenMs: Date.now() - started });
  clearInterval(sampler);
  const survivors = [...seen.values()].filter((p) => { try { process.kill(p.pid, 0); return true; } catch { return false; } });
  const res = { label, argv: [bin.split('/').slice(-1)[0], ...args], exit: r, durationMs: dur, stdout: out.trim().slice(0, 1500), stderr: err.trim().slice(0, 1500), spawned: [...seen.values()].map((p) => ({ pid: p.pid, ppid: p.ppid, firstSeenMs: p.firstSeenMs, cmd: p.cmd.slice(0, 160) })), survivors: survivors.map((p) => p.pid) };
  fs.appendFileSync(path.join(ST, 'logs', 'cli-runs.jsonl'), JSON.stringify(res) + '\n');
  return res;
}
// Kill only processes provably ours: they hold files under the scratch dir.
export function reapMine(extraPids = []) {
  const killed = [];
  for (const p of codexProcs()) {
    if (BASELINE_PIDS.has(p.pid)) continue; // never inspect or signal a process that predates this run
    if (lsofCount(p.pid, ST) > 0 || extraPids.includes(p.pid)) { try { process.kill(p.pid, 'SIGTERM'); killed.push(p.pid); } catch {} }
  }
  return killed;
}

// Minimal WebSocket-over-unix-socket JSON-RPC client (the app-server control socket speaks websocket).
import net from 'node:net'; import crypto from 'node:crypto';
export class WsOwner {
  constructor(name, sockPath) { this.name = name; this.sockPath = sockPath; this.nextId = 1; this.pending = new Map(); this.events = []; this.rx = Buffer.alloc(0); this.upgraded = false; this.rpcFile = path.join(ST, 'logs', `${name}.rpc.jsonl`); fs.writeFileSync(this.rpcFile, ''); }
  rec(dir, obj) { fs.appendFileSync(this.rpcFile, JSON.stringify({ t: Date.now(), dir, ...obj }) + '\n'); }
  connect() {
    return new Promise((res, rej) => {
      this.sock = net.connect(this.sockPath); const key = crypto.randomBytes(16).toString('base64');
      this.sock.on('connect', () => this.sock.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      this.sock.on('data', (d) => {
        this.rx = Buffer.concat([this.rx, d]);
        if (!this.upgraded) { const i = this.rx.indexOf('\r\n\r\n'); if (i < 0) return; const head = this.rx.slice(0, i).toString(); this.rx = this.rx.slice(i + 4); if (!/^HTTP\/1.1 101/.test(head)) { rej(new Error('ws upgrade failed: ' + head.split('\r\n')[0])); return; } this.upgraded = true; res(); }
        this.drain();
      });
      this.sock.on('error', rej);
    });
  }
  drain() {
    for (;;) {
      const b = this.rx; if (b.length < 2) return; const op = b[0] & 0x0f; let len = b[1] & 0x7f; let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return; const payload = b.slice(off, off + len); this.rx = b.slice(off + len);
      if (op === 1) this.onText(payload.toString('utf8')); else if (op === 9) this.frame(0xA, payload); else if (op === 8) { try { this.sock.end(); } catch {} return; }
    }
  }
  frame(op, payload) {
    const mask = crypto.randomBytes(4); const n = payload.length; let hdr;
    if (n < 126) hdr = Buffer.from([0x80 | op, 0x80 | n]); else if (n < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(n, 2); } else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | op; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
    const masked = Buffer.from(payload); for (let i = 0; i < n; i++) masked[i] ^= mask[i % 4]; this.sock.write(Buffer.concat([hdr, mask, masked]));
  }
  onText(line) {
    let msg; try { msg = JSON.parse(line); } catch { this.rec('in-raw', { line: line.slice(0, 300) }); return; } this.rec('in', msg);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); p(msg); return; }
    if (msg.id !== undefined && msg.method) { this.send({ id: msg.id, result: { decision: 'decline' } }); return; }
    this.events.push({ t: Date.now(), method: msg.method, params: msg.params });
  }
  send(obj) { this.rec('out', obj); this.frame(1, Buffer.from(JSON.stringify(obj))); }
  request(method, params, timeoutMs = 30000) { const id = this.nextId++; return new Promise((res, rej) => { const to = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout ${method}`)); }, timeoutMs); this.pending.set(id, (m) => { clearTimeout(to); res(m); }); this.send({ id, method, params }); }); }
  notify(method, params) { this.send(params === undefined ? { method } : { method, params }); }
  async init() { await this.connect(); const r = await this.request('initialize', { clientInfo: { name: 'stagea-driver', title: 'Stage A driver', version: '0' }, capabilities: { experimentalApi: true } }); this.notify('initialized'); return r; }
  async waitEvent(pred, timeoutMs = 30000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { const e = this.events.find(pred); if (e) return e; await sleep(100); } return null; }
  async stop() { try { this.sock.end(); } catch {} }
}
