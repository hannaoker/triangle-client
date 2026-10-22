import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
import * as L from './lib.mjs';
const { Owner, OWNER_BIN, CLIENT_BIN, log, sleep, ST, CODEX_HOME } = L;
const STAGE = process.env.STAGE;
const PORT = process.env.MOCK_PORT;
const DAEMON_DIR = process.env.DAEMON_DIR || '/private/tmp/codex-daemon-' + process.getuid();

async function startMock() {
  const p = spawn('node', [path.join(STAGE, 'bin', 'mock-provider.mjs'), ST, PORT], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => log('mock:', String(d).trim())); p.stderr.on('data', (d) => log('mock-err:', String(d).trim()));
  for (let i = 0; i < 50 && !fs.existsSync(path.join(ST, 'logs', 'mock.port')); i++) await sleep(100);
  return p;
}
async function newThread(owner) {
  const r = await owner.request('thread/start', { cwd: path.join(ST, 'cwd'), approvalPolicy: 'never', sandbox: 'read-only', model: 'mock-model', modelProvider: 'mock' });
  if (r.error) throw new Error('thread/start: ' + JSON.stringify(r.error));
  return r.result.thread.id;
}
async function turn(owner, threadId, text, waitMs = 30000) {
  const t = Date.now();
  const r = await owner.request('turn/start', { threadId, input: [{ type: 'text', text }] });
  if (r.error) throw new Error('turn/start: ' + JSON.stringify(r.error));
  if (waitMs === 0) return { started: r.result, t };
  const done = await owner.waitEvent((e) => e.method === 'turn/completed' && e.t >= t, waitMs);
  return { started: r.result, done, t };
}
const fmtEv = (e) => `${e.method}${e.params && e.params.threadId ? '(' + String(e.params.threadId).slice(-4) + ')' : ''}`;
const evs = (owner, since) => owner.events.filter((e) => e.t >= since).map((e) => `+${((e.t - since) / 1000).toFixed(1)}s ${fmtEv(e)}`).join(' > ') || '(none)';
const saw = (needle) => L.mockRequests().some((r) => (r.lastUserText || '').includes(needle));
const flat = (dir, depth = 4, rel = '') => { const out = []; let ents = []; try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; } for (const e of ents) { const r = path.join(rel, e.name); out.push(r + (e.isDirectory() ? '/' : '')); if (e.isDirectory() && depth > 1) out.push(...flat(dir, depth - 1, r)); } return out.sort(); };
const diffList = (a, b) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });
const daemonNames = () => { try { return fs.readdirSync(DAEMON_DIR).sort(); } catch (e) { return ['(unreadable: ' + e.code + ')']; } };
const redact = (arr) => arr.map((n) => n.replace(/[0-9a-f]{40,}/, '<hash64>'));
const showRes = (res) => log('queue result:', JSON.stringify({ exit: res.exit, ms: res.durationMs, stdout: res.stdout, stderr: res.stderr.slice(0, 400), spawned: res.spawned.map((p) => `${p.pid}(ppid ${p.ppid}) @${p.firstSeenMs}ms ${p.cmd.slice(0, 110)}`), survivors: res.survivors }));
const rollout = (tid) => { try { const base = path.join(CODEX_HOME, 'sessions'); const all = fs.readdirSync(base, { recursive: true }); const f = all.find((n) => String(n).includes(tid) && String(n).endsWith('.jsonl')); return f ? { path: path.join(base, String(f)), size: fs.statSync(path.join(base, String(f))).size } : null; } catch { return null; } };
let daemonBaseline = null;
import { spawnSync } from 'node:child_process';
const quick = (args) => spawnSync(CLIENT_BIN, args, { env: process.env, encoding: 'utf8', timeout: 30000 });

const SCEN = {
  async smoke() {
    const owner = new Owner('owner', OWNER_BIN); await owner.init(); const tid = await newThread(owner);
    const r = await turn(owner, tid, 'seed [slow:0]'); log('turn completed:', Boolean(r.done), 'thread', tid); await owner.stop();
  },

  // S1: no server at all, bogus thread, default transport.
  async nosrv() {
    daemonBaseline = daemonNames();
    const files0 = flat(CODEX_HOME);
    log('baseline daemon dir:', JSON.stringify(redact(daemonBaseline)));
    const res = await L.runCli({ label: 'queue-no-server', bin: CLIENT_BIN, args: ['queue', '--thread', '00000000-0000-7000-8000-000000000001', '--message', 'CANARY-NOSERVER'], timeoutMs: 45000 });
    showRes(res);
    log('home diff:', JSON.stringify(diffList(files0, flat(CODEX_HOME))));
    log('daemon dir diff:', JSON.stringify(diffList(redact(daemonBaseline), redact(daemonNames()))));
    log('mock requests:', L.mockRequests().length);
  },

  // S7: can a second server take a thread whose writer lock another server holds?
  async twoowners() {
    const a = new Owner('ownerA', OWNER_BIN); await a.init(); const tid = await newThread(a); await turn(a, tid, 'seed [slow:0]');
    log('A holds lock:', JSON.stringify(L.lockHolders(tid)), '(A pid', a.proc.pid + ')');
    const b = new Owner('ownerB', CLIENT_BIN); await b.init();
    const t = Date.now();
    const rr = await b.request('thread/resume', { threadId: tid });
    log('B thread/resume ->', JSON.stringify(rr.error || { ok: true, id: rr.result?.thread?.id }).slice(0, 500));
    log('lock holders after B resume attempt:', JSON.stringify(L.lockHolders(tid)));
    log('B loaded list:', JSON.stringify((await b.request('thread/loaded/list', {})).result));
    if (!rr.error) { const tr = await b.request('turn/start', { threadId: tid, input: [{ type: 'text', text: 'FROM-B [slow:0]' }] }); log('B turn/start ->', JSON.stringify(tr.error || 'ok').slice(0, 300)); await sleep(1500); log('mock saw FROM-B:', saw('FROM-B')); }
    const ta = await turn(a, tid, 'A-AGAIN [slow:0]', 15000); log('A can still run a turn:', Boolean(ta.done));
    log('B events:', evs(b, t)); await b.stop(); await a.stop();
  },

  // S2: owner idle, queue via default transport.
  async idle() {
    const owner = new Owner('owner', OWNER_BIN); await owner.init(); const tid = await newThread(owner);
    await turn(owner, tid, 'seed [slow:0]'); await sleep(500);
    daemonBaseline = daemonNames();
    log('IDLE: lock holders', JSON.stringify(L.lockHolders(tid)), 'owner pid', owner.proc.pid);
    const t = Date.now();
    const res = await L.runCli({ label: 'queue-idle', bin: CLIENT_BIN, args: ['queue', '--thread', tid, '--message', 'CANARY-IDLE [slow:0]'], timeoutMs: 60000 });
    showRes(res);
    let dispatched = false; for (let i = 0; i < 40 && !dispatched; i++) { await sleep(500); dispatched = saw('CANARY-IDLE'); }
    log('owner auto-dispatched CANARY-IDLE within 20s:', dispatched);
    log('owner events since queue:', evs(owner, t));
    log('db queued_items:', L.sql('select thread_id, queue_order, substr(payload_json,1,220) from queued_items'));
    log('db revisions:', L.sql('select * from queued_thread_revisions'));
    const list = await owner.request('thread/queue/list', { threadId: tid }); log('thread/queue/list ->', JSON.stringify(list.result || list.error).slice(0, 600));
    if (!dispatched && list.result?.data?.length) {
      const t2 = Date.now(); const st = await owner.request('thread/queue/start', { threadId: tid });
      log('thread/queue/start ->', JSON.stringify(st.result || st.error).slice(0, 300));
      await owner.waitEvent((e) => e.method === 'turn/completed' && e.t >= t2, 20000);
      log('mock saw CANARY-IDLE after explicit start:', saw('CANARY-IDLE'));
    }
    // invoker flags must not leak into the queued item
    const t3 = Date.now();
    const res2 = await L.runCli({ label: 'queue-flags', bin: CLIENT_BIN, args: ['queue', '-m', 'other-model', '-s', 'danger-full-access', '-C', ST, '--thread', tid, '--message', 'CANARY-FLAGS [slow:0]'], timeoutMs: 60000 });
    showRes(res2);
    await sleep(2500);
    const list2 = await owner.request('thread/queue/list', { threadId: tid }); log('queue after flagged add ->', JSON.stringify(list2.result || list2.error).slice(0, 500));
    log('db payload of flagged item:', L.sql("select substr(payload_json,1,400) from queued_items where payload_json like '%CANARY-FLAGS%'"));
    if (list2.result?.data?.length) { const st = await owner.request('thread/queue/start', { threadId: tid }); await owner.waitEvent((e) => e.method === 'turn/completed' && e.t >= t3, 20000); }
    const reqs = L.mockRequests().filter((r) => (r.lastUserText || '').includes('CANARY-FLAGS'));
    for (const r of reqs) { const body = fs.readFileSync(path.join(ST, 'logs', `mock-req-${String(r.n).padStart(3, '0')}.json`), 'utf8'); log('flagged turn request: model =', r.model, '| mentions danger-full-access:', body.includes('danger-full-access'), '| mentions other-model:', body.includes('other-model'), '| mentions read-only:', body.includes('read-only')); }
    // protocol-level idempotency probe
    const a1 = await owner.request('thread/queue/add', { threadId: tid, clientUserMessageId: 'dup-1', input: [{ type: 'text', text: 'DUP-A' }] });
    const a2 = await owner.request('thread/queue/add', { threadId: tid, clientUserMessageId: 'dup-1', input: [{ type: 'text', text: 'DUP-B' }] });
    log('add dup-1 #1 ->', JSON.stringify(a1.result || a1.error).slice(0, 300)); log('add dup-1 #2 ->', JSON.stringify(a2.result || a2.error).slice(0, 300));
    const l3 = await owner.request('thread/queue/list', { threadId: tid }); log('list after dup adds ->', JSON.stringify((l3.result?.data || []).map((d) => ({ id: d.id.slice(-6), cid: d.clientUserMessageId, text: d.input?.[0]?.text }))));
    const first = l3.result?.data?.[0]; if (first) { const d = await owner.request('thread/queue/delete', { threadId: tid, queuedSubmissionId: first.id }); log('delete ->', JSON.stringify(d.result || d.error)); }
    log('daemon dir diff:', JSON.stringify(diffList(redact(daemonBaseline), redact(daemonNames()))));
    await owner.stop();
  },

  // S3: owner mid-turn when the message is queued.
  async busy() {
    const owner = new Owner('owner', OWNER_BIN); await owner.init(); const tid = await newThread(owner);
    await turn(owner, tid, 'seed [slow:0]'); await sleep(300);
    daemonBaseline = daemonNames();
    const tBusy = Date.now(); const slow = await turn(owner, tid, 'HOLD [slow:22]', 0);
    log('BUSY turn started; status:', JSON.stringify(slow.started?.turn?.status));
    await sleep(3000);
    const t = Date.now();
    const res = await L.runCli({ label: 'queue-busy', bin: CLIENT_BIN, args: ['queue', '--thread', tid, '--message', 'CANARY-BUSY [slow:0]'], timeoutMs: 60000 });
    showRes(res);
    const list1 = await owner.request('thread/queue/list', { threadId: tid }); log('queue while busy ->', JSON.stringify((list1.result?.data || []).map((d) => d.input?.[0]?.text)));
    log('owner events since queue (while busy):', evs(owner, t));
    const done = await owner.waitEvent((e) => e.method === 'turn/completed' && e.t >= tBusy, 40000); log('busy turn completed at +' + ((done?.t - tBusy) / 1000).toFixed(1) + 's');
    const tAfter = Date.now(); let dispatched = false; for (let i = 0; i < 50 && !dispatched; i++) { await sleep(500); dispatched = saw('CANARY-BUSY'); }
    log('owner auto-dispatched CANARY-BUSY after the busy turn within 25s:', dispatched);
    log('owner events after busy turn:', evs(owner, tAfter));
    const list2 = await owner.request('thread/queue/list', { threadId: tid }); log('queue after busy turn ->', JSON.stringify((list2.result?.data || []).map((d) => d.input?.[0]?.text)));
    if (!dispatched && list2.result?.data?.length) { const t2 = Date.now(); const st = await owner.request('thread/queue/start', { threadId: tid }); log('thread/queue/start ->', JSON.stringify(st.error || 'ok')); await owner.waitEvent((e) => e.method === 'turn/completed' && e.t >= t2, 20000); log('mock saw CANARY-BUSY after explicit start:', saw('CANARY-BUSY')); }
    log('daemon dir diff:', JSON.stringify(diffList(redact(daemonBaseline), redact(daemonNames()))));
    await owner.stop();
  },

  // S4: thread exists on disk, nobody owns it.
  async absent() {
    const o1 = new Owner('owner1', OWNER_BIN); await o1.init(); const tid = await newThread(o1); await turn(o1, tid, 'seed [slow:0]');
    const ro0 = rollout(tid); await o1.stop(); await sleep(600);
    daemonBaseline = daemonNames(); const files0 = flat(CODEX_HOME);
    log('ABSENT: owner stopped; lock holders:', JSON.stringify(L.lockHolders(tid)), '| rollout', JSON.stringify(ro0 && { size: ro0.size }));
    const res = await L.runCli({ label: 'queue-absent', bin: CLIENT_BIN, args: ['queue', '--thread', tid, '--message', 'CANARY-ABSENT [slow:0]'], timeoutMs: 60000 });
    showRes(res); await sleep(2500);
    log('lock holders after queue:', JSON.stringify(L.lockHolders(tid)));
    log('mock saw CANARY-ABSENT (a turn ran with no owner):', saw('CANARY-ABSENT'), '| mock requests total', L.mockRequests().length);
    log('db queued_items:', L.sql('select thread_id, queue_order, substr(payload_json,1,200) from queued_items'));
    const ro1 = rollout(tid); log('rollout size before/after:', ro0?.size, '/', ro1?.size);
    log('home diff:', JSON.stringify(diffList(files0, flat(CODEX_HOME))));
    log('daemon dir diff:', JSON.stringify(diffList(redact(daemonBaseline), redact(daemonNames()))));
    const o2 = new Owner('owner2', OWNER_BIN); await o2.init(); const t = Date.now();
    const rr = await o2.request('thread/resume', { threadId: tid }); log('owner2 thread/resume ->', JSON.stringify(rr.error || 'ok').slice(0, 300));
    await sleep(8000);
    log('owner2 events after resume:', evs(o2, t));
    const l = await o2.request('thread/queue/list', { threadId: tid }); log('queue after resume ->', JSON.stringify((l.result?.data || []).map((d) => d.input?.[0]?.text)));
    log('mock saw CANARY-ABSENT after owner2 resumed:', saw('CANARY-ABSENT'));
    await o2.stop();
  },

  // S5: explicit remote endpoint (control case).
  async remote() {
    const dir = '/private/tmp/sa-stageA'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); const sock = path.join(dir, 'o.sock');
    const srv = spawn(OWNER_BIN, ['app-server', '--listen', 'unix://' + sock], { stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stderr.on('data', (d) => fs.appendFileSync(path.join(ST, 'logs', 'remote-server.stderr'), d)); srv.stdout.on('data', (d) => fs.appendFileSync(path.join(ST, 'logs', 'remote-server.stdout'), d));
    for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(100);
    log('remote server socket exists:', fs.existsSync(sock));
    try {
      const px = new L.WsOwner('wsclient', sock); const init = await px.init(); log('initialize over websocket-on-unix ->', JSON.stringify(init.result || init.error).slice(0, 160));
      const tid = await newThread(px); await turn(px, tid, 'seed [slow:0]'); await sleep(300);
      const t = Date.now();
      const res = await L.runCli({ label: 'queue-remote', bin: CLIENT_BIN, args: ['queue', '--remote', 'unix://' + sock, '--thread', tid, '--message', 'CANARY-REMOTE [slow:0]'], timeoutMs: 60000 });
      showRes(res);
      let dispatched = false; for (let i = 0; i < 30 && !dispatched; i++) { await sleep(500); dispatched = saw('CANARY-REMOTE'); }
      log('server auto-dispatched CANARY-REMOTE within 15s:', dispatched);
      log('events seen by the websocket client:', evs(px, t));
      const l = await px.request('thread/queue/list', { threadId: tid }); log('queue ->', JSON.stringify((l.result?.data || []).map((d) => d.input?.[0]?.text)));
      await px.stop();
    } finally { srv.kill('SIGTERM'); await sleep(500); try { srv.kill('SIGKILL'); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
  },

  // S9: how long does an idle owner take to notice a message queued through the default (embedded) path?
  async latency() {
    const owner = new Owner('owner', OWNER_BIN); await owner.init(); const tid = await newThread(owner); await turn(owner, tid, 'seed [slow:0]');
    const out = [];
    for (let i = 0; i < 5; i++) {
      await sleep([1000, 3300, 2100, 4700, 1500][i]);
      const tAdd = Date.now(); const r = quick(['queue', '--thread', tid, '--message', `LAT-${i} [slow:0]`]); const tDone = Date.now();
      const ch = await owner.waitEvent((e) => e.method === 'thread/queue/changed' && e.t >= tAdd, 30000);
      const started = await owner.waitEvent((e) => e.method === 'turn/started' && e.t >= tAdd, 30000);
      await owner.waitEvent((e) => e.method === 'turn/completed' && e.t >= tAdd, 30000);
      out.push({ i, cliMs: tDone - tAdd, exit: r.status, changedAfterMs: ch ? ch.t - tAdd : null, turnStartedAfterMs: started ? started.t - tAdd : null });
      log('trial', JSON.stringify(out[i]));
    }
    const ls = out.map((o) => o.turnStartedAfterMs).filter(Boolean); log('turn-start latency ms: min', Math.min(...ls), 'max', Math.max(...ls), 'values', JSON.stringify(ls));
    await owner.stop();
  },

  // S10: several messages queued back to back (idle) and while busy: one turn each, or merged?
  async multi() {
    const owner = new Owner('owner', OWNER_BIN); await owner.init(); const tid = await newThread(owner); await turn(owner, tid, 'seed [slow:0]'); await sleep(500);
    const before = L.mockRequests().length; const t = Date.now();
    for (const n of [1, 2, 3]) quick(['queue', '--thread', tid, '--message', `MULTI-IDLE-${n} [slow:0]`]);
    log('queued 3 idle messages in', Date.now() - t, 'ms'); await sleep(30000);
    const reqs = L.mockRequests().slice(before); log('model requests after 3 idle adds:', reqs.length, JSON.stringify(reqs.map((r) => (r.lastUserText || '').slice(0, 60))));
    log('turn/started events:', owner.events.filter((e) => e.t >= t && e.method === 'turn/started').length, '| owner events:', evs(owner, t).slice(0, 600));
    const b2 = L.mockRequests().length; const tb = Date.now(); const slow = await turn(owner, tid, 'HOLD [slow:12]', 0); await sleep(2000);
    for (const n of [1, 2, 3]) quick(['queue', '--thread', tid, '--message', `MULTI-BUSY-${n} [slow:0]`]);
    log('queued 3 messages while busy'); await owner.waitEvent((e) => e.method === 'turn/completed' && e.t >= tb, 30000); await sleep(25000);
    const reqs2 = L.mockRequests().slice(b2); log('model requests after busy turn + 3 adds:', reqs2.length, JSON.stringify(reqs2.map((r) => (r.lastUserText || '').slice(0, 60))));
    log('turn/started events during busy phase:', owner.events.filter((e) => e.t >= tb && e.method === 'turn/started').length);
    await owner.stop();
  },

  // S11: does the same clientUserMessageId dedupe after the first item was already dispatched?
  async dedupehist() {
    const owner = new Owner('owner', OWNER_BIN); await owner.init(); const tid = await newThread(owner); await turn(owner, tid, 'seed [slow:0]'); await sleep(500);
    const add = (id, text) => owner.request('thread/queue/add', { threadId: tid, clientUserMessageId: id, input: [{ type: 'text', text }] });
    const r1 = await add('hist-1', 'HIST-A [slow:0]'); log('add #1 ->', JSON.stringify(r1.result || r1.error).slice(0, 200));
    let d1 = false; for (let i = 0; i < 30 && !d1; i++) { await sleep(300); d1 = saw('HIST-A'); } log('HIST-A dispatched by the owner itself:', d1);
    await sleep(1500);
    const r2 = await add('hist-1', 'HIST-B [slow:0]'); log('add #2 (same clientUserMessageId, after dispatch) ->', JSON.stringify(r2.result || r2.error).slice(0, 200));
    let d2 = false; for (let i = 0; i < 30 && !d2; i++) { await sleep(300); d2 = saw('HIST-B'); } log('HIST-B dispatched (i.e. NOT deduped against history):', d2);
    const l = await owner.request('thread/queue/list', { threadId: tid }); log('queue now ->', JSON.stringify((l.result?.data || []).map((d) => d.input?.[0]?.text)));
    await owner.stop();
  },

  // S12: a persistent server (like the managed daemon) is running, the thread is on disk but loaded nowhere.
  async daemonabsent() {
    const dir = '/private/tmp/sa-stageA'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); const sock = path.join(dir, 'd.sock');
    const mk = async (name) => { const o = new Owner(name, OWNER_BIN); await o.init(); const tid = await newThread(o); await turn(o, tid, 'seed [slow:0]'); await o.stop(); await sleep(500); return tid; };
    const D = spawn(CLIENT_BIN, ['app-server', '--listen', 'unix://' + sock], { stdio: ['ignore', 'pipe', 'pipe'] });
    D.stderr.on('data', (d) => fs.appendFileSync(path.join(ST, 'logs', 'persistent-server.stderr'), d));
    try {
      for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(100);
      fs.mkdirSync(path.join(CODEX_HOME, 'app-server-control'), { recursive: true }); fs.symlinkSync(sock, path.join(CODEX_HOME, 'app-server-control', 'app-server-control.sock'));
      const t1 = await mk('o-a'), t2 = await mk('o-b');
      log('persistent server pid', D.pid, '| locks before: t1', JSON.stringify(L.lockHolders(t1)), 't2', JSON.stringify(L.lockHolders(t2)));
      // (a) explicit endpoint
      const ra = await L.runCli({ label: 'queue-remote-unowned', bin: CLIENT_BIN, args: ['queue', '--remote', 'unix://' + sock, '--thread', t1, '--message', 'CANARY-DREMOTE [slow:0]'], timeoutMs: 60000 }); showRes(ra);
      await sleep(8000);
      log('(a) explicit --remote: lock holders t1', JSON.stringify(L.lockHolders(t1)), '| persistent server holds locks:', L.lsofCount(D.pid, 'thread-writer-locks'), '| turn ran (mock saw canary):', saw('CANARY-DREMOTE'));
      log('(a) db rows for t1:', L.sql(`select count(*) from queued_items where thread_id='${t1}'`));
      // (b) default transport, control-socket symlink present at the managed-daemon location
      const rb = await L.runCli({ label: 'queue-default-with-control-socket', bin: CLIENT_BIN, args: ['queue', '--thread', t2, '--message', 'CANARY-DDEFAULT [slow:0]'], timeoutMs: 60000 }); showRes(rb);
      await sleep(14000);
      log('(b) default transport: lock holders t2', JSON.stringify(L.lockHolders(t2)), '| persistent server holds locks:', L.lsofCount(D.pid, 'thread-writer-locks'), '| turn ran (mock saw canary):', saw('CANARY-DDEFAULT'));
      log('(b) db rows for t2:', L.sql(`select count(*) from queued_items where thread_id='${t2}'`));
      // a real owner arrives later: is it blocked by the persistent server?
      const o3 = new Owner('o-late', OWNER_BIN); await o3.init(); const rr = await o3.request('thread/resume', { threadId: t2 }); log('late owner thread/resume t2 ->', JSON.stringify(rr.error || 'ok').slice(0, 200)); await o3.stop();
    } finally { D.kill('SIGTERM'); await sleep(500); try { D.kill('SIGKILL'); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
  },

  // S13: does default `codex queue` look for the managed-daemon control socket? Put a black hole there and see.
  async discover() {
    const dir = '/private/tmp/sa-stageA'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); const sock = path.join(dir, 'bh.sock');
    const net = await import('node:net'); let accepted = 0;
    const bh = net.createServer((c) => { accepted++; c.on('error', () => {}); /* never answers */ }); await new Promise((r) => bh.listen(sock, r));
    try {
      const o = new Owner('o-a', OWNER_BIN); await o.init(); const tid = await newThread(o); await turn(o, tid, 'seed [slow:0]'); await o.stop(); await sleep(400);
      // control: no control socket anywhere
      const r0 = await L.runCli({ label: 'queue-no-control-socket', bin: CLIENT_BIN, args: ['queue', '--thread', tid, '--message', 'DISC-0'], timeoutMs: 40000 }); showRes(r0);
      // black hole at the managed-daemon control socket location
      fs.mkdirSync(path.join(CODEX_HOME, 'app-server-control'), { recursive: true }); fs.symlinkSync(sock, path.join(CODEX_HOME, 'app-server-control', 'app-server-control.sock'));
      const r1 = await L.runCli({ label: 'queue-black-hole-control-socket', bin: CLIENT_BIN, args: ['queue', '--thread', tid, '--message', 'DISC-1'], timeoutMs: 40000 }); showRes(r1);
      log('connections accepted by the black hole:', accepted);
      log('queued rows for thread:', L.sql(`select count(*) from queued_items where thread_id='${tid}'`));
    } finally { bh.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  },

  // S14: the real topology: a healthy persistent server at the control socket (like the managed daemon) AND a separate owner holding the thread.
  async topology() {
    const dir = '/private/tmp/sa-stageA'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); const sock = path.join(dir, 'd.sock');
    const D = spawn(CLIENT_BIN, ['app-server', '--listen', 'unix://' + sock], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(100);
      fs.mkdirSync(path.join(CODEX_HOME, 'app-server-control'), { recursive: true }); fs.symlinkSync(sock, path.join(CODEX_HOME, 'app-server-control', 'app-server-control.sock'));
      const O = new Owner('owner', OWNER_BIN); await O.init(); const tid = await newThread(O); await turn(O, tid, 'seed [slow:0]'); await sleep(500);
      log('owner pid', O.proc.pid, '| lock holders', JSON.stringify(L.lockHolders(tid)), '| persistent server pid', D.pid);
      const t = Date.now(); const r1 = await L.runCli({ label: 'queue-default-via-daemon', bin: CLIENT_BIN, args: ['queue', '--thread', tid, '--message', 'TOPO-1 [slow:0]'], timeoutMs: 60000 }); showRes(r1);
      const st = await O.waitEvent((e) => e.method === 'turn/started' && e.t >= t, 30000); log('owner started a turn from the queued message after', st ? ((st.t - t) / 1000).toFixed(1) + 's' : 'NEVER (30s)', '| mock saw TOPO-1:', saw('TOPO-1'));
      log('lock holders after:', JSON.stringify(L.lockHolders(tid)), '| persistent server holds locks:', L.lsofCount(D.pid, 'thread-writer-locks'));
      const r2 = await L.runCli({ label: 'queue-override-flag-with-daemon', bin: CLIENT_BIN, args: ['queue', '-m', 'other-model', '--thread', tid, '--message', 'TOPO-FLAG [slow:0]'], timeoutMs: 60000 }); showRes(r2);
      log('rows queued for thread after flagged attempt:', L.sql(`select count(*) from queued_items where thread_id='${tid}'`));
      await O.stop();
    } finally { D.kill('SIGTERM'); await sleep(500); try { D.kill('SIGKILL'); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
  },
};
const mock = await startMock();
process.on('exit', () => { try { mock.kill('SIGKILL'); } catch {} });
try { await SCEN[process.argv[2]](); } catch (e) { log('SCENARIO ERROR:', e.stack || e); process.exitCode = 1; }
finally {
  mock.kill('SIGTERM');
  try { const killed = L.reapMine(); if (killed.length) log('reaped leftover codex processes:', killed.join(',')); } catch (e) { log('reap error:', e.message); }
  if (daemonBaseline) { const now = daemonNames(); const extra = now.filter((n) => !daemonBaseline.includes(n)); for (const n of extra) { try { fs.rmSync(path.join(DAEMON_DIR, n), { force: true }); log('removed daemon-dir entry created during this run:', n.replace(/[0-9a-f]{40,}/, '<hash64>')); } catch (e) { log('could not remove', n.slice(0, 12), e.code); } } }
  await sleep(300);
}
