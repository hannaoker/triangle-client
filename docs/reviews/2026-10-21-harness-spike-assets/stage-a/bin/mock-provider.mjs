// Mock Responses API provider for Stage A: no credentials, loopback only.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ST = process.argv[2]; const port = Number(process.argv[3] || 0);
const logDir = path.join(ST, 'logs'); fs.mkdirSync(logDir, { recursive: true });
const reqLog = path.join(logDir, 'mock-requests.jsonl');
let n = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function lastUserText(body) {
  try {
    const items = Array.isArray(body.input) ? body.input : [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && it.role === 'user' && Array.isArray(it.content)) {
        const t = it.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
        if (t) return t;
      }
    }
  } catch {}
  return '';
}
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const id = ++n;
  let body = null; try { body = raw ? JSON.parse(raw) : null; } catch {}
  const entry = { n: id, t: new Date().toISOString(), method: req.method, url: req.url, hasAuthHeader: Boolean(req.headers.authorization) };
  if (body) {
    const inputs = Array.isArray(body.input) ? body.input : [];
    entry.model = body.model; entry.stream = body.stream; entry.inputItems = inputs.length;
    entry.lastUserText = lastUserText(body).slice(0, 300);
    entry.toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    entry.instructionsChars = (body.instructions || '').length;
    fs.writeFileSync(path.join(logDir, `mock-req-${String(id).padStart(3, '0')}.json`), JSON.stringify(body, null, 1));
  }
  fs.appendFileSync(reqLog, JSON.stringify(entry) + '\n');
  if (req.method === 'POST' && /\/responses(\?|$)/.test(req.url)) {
    const text = lastUserText(body || {});
    const m = /\[slow:(\d+)\]/.exec(text); const delay = m ? Number(m[1]) * 1000 : 0;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('response.created', { response: { id: `resp_${id}` } });
    if (delay) await sleep(delay);
    const msg = { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: `ACK ${id}: ${text.slice(0, 60).replace(/\s+/g, ' ')}` }] };
    send('response.output_item.done', { item: msg });
    send('response.completed', { response: { id: `resp_${id}`, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } });
    res.end();
    fs.appendFileSync(reqLog, JSON.stringify({ n: id, t: new Date().toISOString(), done: true, delayMs: delay }) + '\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [], models: [] }));
});
srv.listen(port, '127.0.0.1', () => { fs.writeFileSync(path.join(logDir, 'mock.port'), String(srv.address().port)); console.log('mock listening', srv.address().port); });
