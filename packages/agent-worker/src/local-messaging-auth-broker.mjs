import fs from 'node:fs';
import path from 'node:path';
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

// Discovery credentials admit lifecycle metadata only. They never issue a turn
// credential or alter a messaging ACL. Same-account shell isolation is not claimed.
export function createSessionDiscoveryBroker({integrationPath,journal,clock=()=>Date.now(),logger={}}) {
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
  if(!event||typeof event!=='object'||Array.isArray(event)||Object.keys(event).filter(k=>k!=='harness').sort().join(',')!=='eventId,kind,observedAt,sessionId,workspace'||
    (event.harness!==undefined&&!['claude','codex'].includes(event.harness))||
    !(c.harnesses||['claude']).includes(event.harness||'claude')||
    !uuid.test(event.eventId)||!uuid.test(event.sessionId)||!['start','activity','end'].includes(event.kind)||
    event.workspace!==c.workspace||!Number.isSafeInteger(event.observedAt)||event.observedAt>clock()+1000||event.observedAt<clock()-30000)throw coded('invalid_discovery_event','Invalid or stale lifecycle metadata');
  return {eventId:event.eventId.toLowerCase(),sessionId:event.sessionId.toLowerCase(),kind:event.kind,workspace:c.workspace,observedAt:event.observedAt,...(event.harness==='codex'?{harness:'codex'}:{})};
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
    const rows=await journal.listDiscoveredSessions({installationId:c.installationId,workspace:c.workspace});
    warned=false;return rows.filter(r=>(c.harnesses||['claude']).includes(r.harness));
   }catch{
    if(!warned){warned=true;try{logger?.warn?.('Session discovery unavailable; configured recipients remain available');}catch{}}
    return [];
   }
  },
 };
}
