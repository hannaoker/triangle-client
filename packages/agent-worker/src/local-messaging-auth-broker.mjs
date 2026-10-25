import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {validatePrivateDirectory} from './local-messaging-address.mjs';
import {coded} from './local-messaging-errors.mjs';

export function readPrivateJson(file) {
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw coded('unsafe_path','Private file must be absolute');
 validatePrivateDirectory(path.dirname(file));
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try {
  const st=fs.fstatSync(fd);
  if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o077)!==0||st.size>1024*1024)throw coded('unsafe_file','Private file ownership or permissions invalid');
  try{return JSON.parse(fs.readFileSync(fd,'utf8'));}
  catch{throw coded('invalid_private_file','Private JSON file is invalid');}
 } finally {fs.closeSync(fd);}
}
export function writePrivateJson(file,value) {
 if(!path.isAbsolute(file))throw coded('unsafe_path','Private file must be absolute');
 const dir=path.dirname(file);validatePrivateDirectory(dir,{create:true});
 if(fs.existsSync(file))readPrivateJson(file);
 const temp=path.join(dir,`.local-${randomUUID()}.tmp`);let fd;
 try {
  fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(temp,file);const parent=fs.openSync(dir,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
 } finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
}
function equalSecret(actual,expected) {
 if(typeof actual!=='string'||typeof expected!=='string')return false;
 const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);
}
export function createDesktopCredentialBroker({bindingPath,integrationPath,recipients,issue}) {
 const integration=readPrivateJson(integrationPath);
 if(integration.version!==1||typeof integration.secret!=='string'||integration.secret.length<64||(!Array.isArray(recipients)||recipients.some(r=>typeof r!=='string'))||typeof issue!=='function')throw coded('invalid_binding','Invalid integration binding');
 // Only the identity is checked: the thread is fixed by the integration file, so the app-server host may move its own binding.
 const validate=()=>{
  const binding=readPrivateJson(bindingPath);
  const expected=binding.instanceId??binding.senderId;
  if(expected!==integration.senderId)throw coded('binding_changed','Desktop identity changed; run explicit owner binding setup');
 };
 validate();
 // The secret is checked first, so an unauthenticated caller learns nothing about owner-side state.
 const verify=request=>{
  const current=readPrivateJson(integrationPath);
  if(!request||request.bindingId!==current.bindingId||request.threadId!==current.threadId||!equalSecret(request.secret,current.secret))throw coded('unauthorized','Invalid desktop integration credential');
  if(current.senderId!==integration.senderId||current.threadId!==integration.threadId||current.bindingId!==integration.bindingId)throw coded('binding_changed','Desktop integration changed');
  validate();
 };
 const issueCredential=()=>issue(integration.senderId,{turnId:randomUUID(),ttlMs:300000,allowedRecipients:[...recipients],conversationId:integration.threadId,loopDepth:1});
 return Object.freeze({
  senderId:integration.senderId, threadId:integration.threadId,
  verify, issue:issueCredential,
  exchange(request) {verify(request);return issueCredential();},
 });
}

// A conversation title is untrusted display text from a harness: bounded, one line, free of control and bidi
// characters, with long token-like runs (a pasted key or id) masked so a secret never becomes a directory label.
const TOKEN_RUN=/(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{28,}/g;
// C0/C1 controls, soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and directional marks,
// line/paragraph separators and embeddings, word joiners and the byte-order mark.
const UNSAFE_TITLE_CHARS=new RegExp('['+[[0,0x1f],[0x7f,0x9f],[0xad],[0x61c],[0x180e],[0x200b,0x200f],[0x2028,0x202e],[0x2060,0x206f],[0xfeff]]
 .map(([from,to=from])=>`\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')+']','gu');
export function sanitizeSessionTitle(value){
 if(typeof value!=='string')return null;
 const cleaned=value.normalize('NFC').replace(UNSAFE_TITLE_CHARS,' ').replace(TOKEN_RUN,'…').replace(/\s+/g,' ').trim();
 if(!cleaned||cleaned==='…')return null;
 const chars=[...cleaned];
 return chars.length>80?chars.slice(0,79).join('').trimEnd()+'…':cleaned;
}

// A session's host process, recorded by its own lifecycle hook and compared by pid *and* exact start time, so a
// reused pid is never mistaken for it. `session`: one process per conversation. `shared`: an app server hosting
// many conversations, whose liveness says the app is up, not that this conversation is open.
const START_FORMAT=/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const normalizedStart=value=>String(value).replace(/\s+/g,' ').trim();
export function validSessionHost(host){
 return !!host&&typeof host==='object'&&!Array.isArray(host)&&Object.keys(host).sort().join(',')==='pid,scope,start'&&
  Number.isSafeInteger(host.pid)&&host.pid>1&&host.pid<=4194304&&['session','shared'].includes(host.scope)&&
  typeof host.start==='string'&&START_FORMAT.test(normalizedStart(host.start));
}
function defaultPs(args){
 return new Promise(resolve=>execFile('/bin/ps',args,{encoding:'utf8',timeout:1500,maxBuffer:1<<20,env:{PATH:'/usr/bin:/bin',LC_ALL:'C',TZ:'UTC'}},
  (error,stdout)=>resolve(error&&!(error.code===1&&typeof stdout==='string')?null:stdout)));
}
// One `ps` call per refresh however many sessions are listed; results are cached briefly. Anything it cannot
// establish is `unknown`, never `gone`.
export function createHostProcessProbe({ps=defaultPs,ttlMs=5000,clock=()=>Date.now()}={}){
 const cache=new Map();
 return async function probe(hosts){
  const now=clock(),result=new Map(),need=new Map();
  for(const {pid,start} of hosts){
   const key=`${pid}:${normalizedStart(start)}`,hit=cache.get(key);
   if(hit&&now-hit.at<ttlMs)result.set(key,hit.state);else need.set(key,{pid,start:normalizedStart(start)});
  }
  if(need.size){
   // The whole table, not `-p <pids>`: macOS ps prints nothing at all when any listed pid is gone, which would
   // make every live session look dead. An empty table is a failed read, not "everything is gone".
   const out=await ps(['-axo','pid=,lstart=']),seen=new Map();
   if(typeof out==='string')for(const line of out.split('\n')){const m=/^\s*(\d+)\s+(.+?)\s*$/.exec(line);if(m)seen.set(Number(m[1]),normalizedStart(m[2]));}
   for(const [key,h] of need){
    const state=seen.size===0?'unknown':seen.get(h.pid)===h.start?'alive':'gone';
    result.set(key,state);if(state!=='unknown')cache.set(key,{state,at:now});
   }
   if(cache.size>1024)for(const [key,hit] of cache)if(now-hit.at>=ttlMs)cache.delete(key);
  }
  return result;
 };
}
const sharedHostProbe=createHostProcessProbe();

// Presence is what the evidence supports and says which evidence it is; it is never inferred from a label, and
// it is not reachability. `lease` is the renewal time of a live attachment lease, or null when there is none.
export function sessionPresence(row,{lease=null,host='unknown',hostScope=null,now=Date.now()}={}){
 if(row.lifecycle==='ended')return {presence:'offline',presenceEvidence:{kind:'end-event',observedAt:row.lastSeenAt}};
 if(lease!==null)return {presence:'online',presenceEvidence:{kind:'mcp-lease',observedAt:lease}};
 if(host==='gone')return {presence:'offline',presenceEvidence:{kind:'host-process-gone',observedAt:now}};
 if(host==='alive')return {presence:hostScope==='session'?'online':'unknown',presenceEvidence:{kind:'host-process',scope:hostScope,observedAt:now}};
 return {presence:'unknown',presenceEvidence:{kind:'none'}};
}
// Adds presence to journal rows and drops the internal host fields. `leaseOf(row)` returns a lease renewal time or null.
export async function withSessionPresence(rows,{probe=sharedHostProbe,leaseOf=null,now=Date.now()}={}){
 const hosts=rows.filter(r=>r.lifecycle!=='ended'&&r._host).map(r=>r._host);
 const states=hosts.length?await probe(hosts).catch(()=>new Map()):new Map();
 return rows.map(({_host,...row})=>{
  const host=_host?states.get(`${_host.pid}:${normalizedStart(_host.start)}`)??'unknown':'unknown';
  return {...row,...sessionPresence(row,{lease:leaseOf?leaseOf(row):null,host,hostScope:_host?.scope??null,now})};
 });
}

// Discovery credentials admit lifecycle metadata only. They never issue a turn
// credential or alter a messaging ACL. Same-account shell isolation is not claimed.
export function createSessionDiscoveryBroker({integrationPath,journal,clock=()=>Date.now(),logger={},processProbe=sharedHostProbe}) {
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const hex=/^[a-f0-9]{64}$/;
 const pending=new Map();
 let warned=false;
 let windowStart=clock(),attempts=0;
 function current(){
  const c=readPrivateJson(integrationPath);
  if(Object.keys(c).filter(k=>k!=='harnesses').sort().join(',')!=='enabled,installationId,readerIds,secret,version,workspace'||c.version!==1||typeof c.enabled!=='boolean'||!uuid.test(c.installationId)||!hex.test(c.secret)||
     typeof c.workspace!=='string'||/[\u0000-\u001f\u007f]/.test(c.workspace)||Buffer.byteLength(JSON.stringify(c.workspace))>512||fs.realpathSync(c.workspace)!==c.workspace||
     (c.harnesses!==undefined&&(!Array.isArray(c.harnesses)||!c.harnesses.length||new Set(c.harnesses).size!==c.harnesses.length||c.harnesses.some(h=>!['claude','codex'].includes(h))))||
     !Array.isArray(c.readerIds)||c.readerIds.length>64||c.readerIds.some(id=>!hex.test(id)))throw coded('invalid_discovery_config','Invalid discovery integration');
  return c;
 }
 function verify(request){
  const now=clock();if(now-windowStart>=60000){windowStart=now;attempts=0;}
  const c=current();
  if(!c.enabled||request?.installationId!==c.installationId||!equalSecret(request?.secret,c.secret))throw coded('unauthorized','Discovery integration unavailable');
  if(++attempts>240)throw coded('rate_limited','Discovery request limit reached');
  return c;
 }
 function normalize(event,c){
  // Optional descriptive metadata: origin (Codex only), a conversation title and the session's host process.
  // None of it identifies or authorizes anything; all of it is bounded here whatever the reporter sent.
  if(!event||typeof event!=='object'||Array.isArray(event)||Object.keys(event).filter(k=>!['harness','origin','title','host'].includes(k)).sort().join(',')!=='eventId,kind,observedAt,sessionId,workspace'||
    (event.harness!==undefined&&!['claude','codex'].includes(event.harness))||
    (event.origin!==undefined&&(event.harness!=='codex'||!['unknown','cli','vscode','exec','app-server','appServer','subagent'].includes(event.origin)))||
    (event.title!==undefined&&(typeof event.title!=='string'||event.title.length>400))||
    (event.host!==undefined&&!validSessionHost(event.host))||
    !(c.harnesses||['claude']).includes(event.harness||'claude')||
    !uuid.test(event.eventId)||!uuid.test(event.sessionId)||!['start','activity','end'].includes(event.kind)||
    event.workspace!==c.workspace||!Number.isSafeInteger(event.observedAt)||event.observedAt>clock()+1000||event.observedAt<clock()-30000)throw coded('invalid_discovery_event','Invalid or stale lifecycle metadata');
  const title=event.title===undefined?null:sanitizeSessionTitle(event.title);
  return {eventId:event.eventId.toLowerCase(),sessionId:event.sessionId.toLowerCase(),kind:event.kind,workspace:c.workspace,observedAt:event.observedAt,...(event.harness==='codex'?{harness:'codex',...(event.origin!==undefined?{origin:event.origin}:{})}:{}),
   ...(title?{title}:{}),...(event.host?{host:{pid:event.host.pid,start:normalizedStart(event.host.start),scope:event.host.scope}}:{})};
 }
 const digest=(event,installationId)=>createHash('sha256').update(installationId+'\0'+JSON.stringify(event)).digest('hex');
 return {
  challenge(request){
   const c=verify(request),event=normalize(request.event,c),now=clock();
   for(const [key,value] of pending)if(value.expiresAt<=now)pending.delete(key);
   if(pending.size>=128)throw coded('too_many_requests','Too many pending discovery challenges');
   const nonce=randomUUID();pending.set(nonce,{digest:digest(event,c.installationId),expiresAt:now+5000,secret:c.secret});
   return {nonce,expiresAt:now+5000};
  },
  async report(request){
   const c=verify(request),event=normalize(request.event,c),challenge=pending.get(request.nonce);
   pending.delete(request.nonce);
   if(!challenge||challenge.expiresAt<=clock()||challenge.digest!==digest(event,c.installationId)||!equalSecret(challenge.secret,c.secret))throw coded('unauthorized','Discovery challenge expired or mismatched');
   return journal.recordDiscoveryEvent({installationId:c.installationId,event,digest:digest(event,c.installationId),receivedAt:clock()});
  },
  async status(){
   try{const c=current();return {enabled:c.enabled,mode:'visibility-only',harnesses:c.harnesses||['claude'],sessions:c.enabled?(await journal.listDiscoveredSessions({installationId:c.installationId,workspace:c.workspace})).filter(r=>(c.harnesses||['claude']).includes(r.harness)).length:0,capacity:128,...(journal.discoveryUsage?await journal.discoveryUsage():{})};}
   catch{return {enabled:false,mode:'visibility-only',error:'invalid_discovery_config'};}
  },
  async listFor(readerId){
   try{
    const c=current();
    if(!c.enabled||!c.readerIds.includes(readerId))return [];
    const rows=(await journal.listDiscoveredSessions({installationId:c.installationId,workspace:c.workspace})).filter(r=>(c.harnesses||['claude']).includes(r.harness));
    const listed=await withSessionPresence(rows,{probe:processProbe,now:clock()});
    warned=false;return listed;
   }catch{
    if(!warned){warned=true;try{logger?.warn?.('Session discovery unavailable; configured recipients remain available');}catch{}}
    return [];
   }
  },
 };
}
