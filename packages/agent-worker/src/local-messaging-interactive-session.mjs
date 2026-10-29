import path from "node:path";
import fs from "node:fs";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { readPrivateJson, withSessionPresence } from "./local-messaging-auth-broker.mjs";
import { createPerSenderRateLimiter } from "./local-messaging-rate-limiter.mjs";
import { coded } from "./local-messaging-errors.mjs";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HEX64_PATTERN = /^[a-f0-9]{64}$/;
const KNOWN_KEYS = new Set([
  "version",
  "type",
  "senderId",
  "sessionId",
  "generation",
  "bindingId",
  "secret",
  "enabled",
  "revoked",
]);

function equalSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateInteractiveIntegration(file) {
  const current = readPrivateJson(file);
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw coded("invalid_interactive_integration", "Invalid interactive integration file schema");
  }
  const keys = Object.keys(current);
  if (keys.length !== KNOWN_KEYS.size || keys.some((k) => !KNOWN_KEYS.has(k))) {
    throw coded("invalid_interactive_integration", "Invalid interactive integration file schema: unknown or missing keys");
  }
  if (
    current.version !== 1 ||
    current.type !== "interactive" ||
    typeof current.senderId !== "string" ||
    !HEX64_PATTERN.test(current.senderId) ||
    typeof current.secret !== "string" ||
    !HEX64_PATTERN.test(current.secret) ||
    typeof current.sessionId !== "string" ||
    !UUID_PATTERN.test(current.sessionId) ||
    !Number.isSafeInteger(current.generation) ||
    current.generation < 1 ||
    typeof current.bindingId !== "string" ||
    !UUID_PATTERN.test(current.bindingId) ||
    typeof current.enabled !== "boolean" ||
    typeof current.revoked !== "boolean"
  ) {
    throw coded("invalid_interactive_integration", "Invalid interactive integration file schema");
  }
  return current;
}

export function createInteractiveSessionBroker({
  integrationPath,
  recipients = [],
  issue,
  readIntegration = validateInteractiveIntegration,
}) {
  if (typeof integrationPath !== "string" || !path.isAbsolute(integrationPath)) {
    throw coded("invalid_broker_options", "integrationPath must be an absolute path");
  }
  if (!Array.isArray(recipients) || recipients.some((r) => typeof r !== "string")) {
    throw coded("invalid_broker_options", "recipients must be an array of strings");
  }
  if (typeof issue !== "function") {
    throw coded("invalid_broker_options", "issue function is required");
  }

  const integration = readIntegration(integrationPath);
  const failureLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 30, windowMs: 60000 });
  const successLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 120, windowMs: 60000 });

  function getCurrent() {
    return readIntegration(integrationPath);
  }

  function verifyTuple(request) {
    const current = getCurrent();
    if (current.enabled !== true) {
      throw coded("session_disabled", "Interactive session is disabled");
    }
    if (current.revoked !== false) {
      throw coded("session_revoked", "Interactive session is revoked");
    }
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      request.bindingId !== current.bindingId ||
      request.sessionId !== current.sessionId ||
      request.generation !== current.generation ||
      !equalSecret(request.secret, current.secret)
    ) {
      throw coded("unauthorized", "Invalid interactive integration credential");
    }
    if (current.senderId !== integration.senderId) {
      throw coded("binding_changed", "Interactive identity changed");
    }
    return current;
  }

  function validateRequest({ claims, senderId }) {
    const current = getCurrent();
    if (current.enabled !== true) {
      throw coded("session_disabled", "Interactive session is disabled");
    }
    if (current.revoked !== false) {
      throw coded("session_revoked", "Interactive session is revoked");
    }
    if (current.senderId !== integration.senderId) {
      throw coded("binding_changed", "Interactive identity changed");
    }
    if (senderId && senderId !== current.senderId) {
      throw coded("unauthorized", "Interactive sender mismatch");
    }
    if (!claims || typeof claims !== "object") {
      throw coded("unauthorized", "Interactive claims required");
    }
    if (claims.senderType !== "interactive") {
      throw coded("unauthorized", "Interactive senderType required");
    }
    if (claims.senderId !== current.senderId) {
      throw coded("unauthorized", "Interactive sender mismatch");
    }
    if (claims.sessionId !== current.sessionId) {
      throw coded("session_fenced", "Interactive session mismatch");
    }
    if (claims.generation !== current.generation) {
      throw coded("generation_fenced", "Interactive generation mismatch");
    }
    if (claims.bindingId !== current.bindingId) {
      throw coded("binding_changed", "Interactive binding mismatch");
    }
    return current;
  }

  function issueGrant(current) {
    const credential = issue(current.senderId, {
      turnId: randomUUID(),
      ttlMs: 300000,
      allowedRecipients: [...recipients],
      sessionId: current.sessionId,
      generation: current.generation,
      bindingId: current.bindingId,
      senderType: "interactive",
    });
    return {
      credential,
      senderId: current.senderId,
      sessionId: current.sessionId,
      generation: current.generation,
      bindingId: current.bindingId,
    };
  }

  return Object.freeze({
    senderId: integration.senderId,
    integrationPath,
    isInteractiveSender(id) {
      return id === integration.senderId;
    },
    verify: verifyTuple,
    validateRequest,
    exchange(request) {
      let current;
      try {
        current = verifyTuple(request);
      } catch (err) {
        failureLimiter.checkAndConsume("failed");
        throw err;
      }
      successLimiter.checkAndConsume("interactive");
      return issueGrant(current);
    },
  });
}


// A moved or removed workspace is a readable failure of its own, not a raw ENOENT from realpath.
function resolvedWorkspace(workspace) {
 try { return fs.realpathSync(workspace); }
 catch { throw coded('workspace_missing','Opted-in workspace is missing or was moved'); }
}
// Workspace participation is a distinct owner capability. Discovery credentials never authorize messaging.
export function readSessionMessagingPolicy(file) {
 const c=readPrivateJson(file);
 // `codex` is the optional second harness: its own receiver policy (exact senders, hex principals or session addresses).
 if(!c||typeof c!=='object'||Object.keys(c).filter(k=>k!=='codex'&&k!=='exactPairs').sort().join(',')!=='allowedRecipients,allowedSenders,enabled,installationId,secret,version,workspace'||![1,2].includes(c.version)||typeof c.enabled!=='boolean'||
   !UUID_PATTERN.test(c.installationId)||!HEX64_PATTERN.test(c.secret)||typeof c.workspace!=='string'||!path.isAbsolute(c.workspace)||resolvedWorkspace(c.workspace)!==c.workspace||
   !Array.isArray(c.allowedSenders)||!Array.isArray(c.allowedRecipients)||c.allowedSenders.length>64||c.allowedRecipients.length>64||
   [...c.allowedSenders,...c.allowedRecipients].some(id=>!HEX64_PATTERN.test(id)))throw coded('invalid_session_policy','Invalid workspace messaging policy');
 if(c.codex!==undefined){
  const x=c.codex;
  if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join(',')!=='allowedSenders,enabled'||typeof x.enabled!=='boolean'||!Array.isArray(x.allowedSenders)||
    x.allowedSenders.length>64||new Set(x.allowedSenders).size!==x.allowedSenders.length||x.allowedSenders.some(id=>typeof id!=='string'||!/^(session-)?[a-f0-9]{64}$/.test(id)))throw coded('invalid_session_policy','Invalid workspace messaging policy');
 }
 if(c.version===1&&c.exactPairs!==undefined)throw coded('invalid_session_policy','Exact pairs require policy version 2');
 if(c.version===2){
  const pairs=c.exactPairs;
  if(!Array.isArray(pairs)||pairs.length>128||pairs.some(p=>!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='recipient,sender'||
   typeof p.sender!=='string'||!/^(session-)?[a-f0-9]{64}$/.test(p.sender)||typeof p.recipient!=='string'||!/^session-[a-f0-9]{64}$/.test(p.recipient)||p.sender===p.recipient)||
   new Set(pairs.map(p=>p.sender+'\0'+p.recipient)).size!==pairs.length)throw coded('invalid_session_policy','Invalid exact session pairs');
 }
 return c;
}
// A session's address: derived from the installation, the opted-in workspace and the harness session id, so it is
// stable across MCP children and restarts and the raw id is never stored. Lifecycle discovery (journal), the broker
// and the MCP child must all agree on it, so there is exactly one definition.
export function sessionAddress(installationId,workspace,sessionId){
 return 'session-'+createHash('sha256').update(installationId+'\0'+workspace+'\0'+sessionId.toLowerCase()).digest('hex');
}
// Separate pseudonymous UUID for the existing journal binding protocol, derived from the session id alone.
export function attachedSessionIdentity(sessionId){
 const sessionHash=createHash('sha256').update(sessionId.toLowerCase()).digest('hex');
 return {pseudoSessionId:`${sessionHash.slice(0,8)}-${sessionHash.slice(8,12)}-4${sessionHash.slice(13,16)}-8${sessionHash.slice(17,20)}-${sessionHash.slice(20,32)}`};
}
// Harnesses load MCP servers when a chat starts, so a chat that began before the workspace was opted in (or whose
// server failed to start or was not approved) has no attachment until it is reloaded.
export const ATTACH_HINT='No Triangle MCP child is attached to this chat. Chats load MCP servers when they start: reload or restart this chat, or start a new one, and check that its MCP server was approved.';
// Codex gives its MCP server no chat identity until the chat's first tool call, so a Codex chat attaches then.
export const CODEX_ATTACH_HINT='This Codex chat has not called a Triangle tool yet, or its Triangle MCP server is not loaded. It becomes reachable on its first Triangle tool call (for example triangle_get_status). Codex loads MCP servers when a chat starts: restart the Codex app or start a new chat after setup.';
// Codex addresses live in their own namespace, exactly as lifecycle discovery derives them (see recordDiscoveryEvent).
export const sessionAddressKey=(harness,sessionId)=>harness==='codex'?'codex:'+sessionId:sessionId;
export function createWorkspaceSessionBroker({policyPath,discoveryPath,journal,issue,clock=()=>Date.now(),ownerSenderId=null,configuredRecipients=null,additionalPrincipals=[],codexSenderPrincipals=null,boundIntegrationPath=null,logger=null,processProbe=undefined}) {
 const limiter=createPerSenderRateLimiter({maxRequestsPerWindow:240,windowMs:60000});
 const failures=createPerSenderRateLimiter({maxRequestsPerWindow:30,windowMs:60000});
 const policyScope=c=>c.installationId+':'+createHash('sha256').update(c.secret).digest('hex');
 // A broken policy or journal hides the sessions and leaves only the configured recipients. Say so once per
 // failure (and again once it has recovered) instead of failing silently; codes only, never contents or paths.
 let degradedCode=null;
 const degraded=error=>{
  const code=typeof error?.code==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.code)?error.code:'broker_error';
  if(code===degradedCode)return;degradedCode=code;
  try{logger?.warn?.(`Workspace session messaging unavailable (${code}); configured recipients remain available`);}catch{}
 };
 const healthy=()=>{degradedCode=null;};
 // The policy file is the ceiling the owner granted at setup; it never widens what the live owner
 // configuration allows. A replaced Codex sender or a removed worker loses session access immediately.
 const liveSenders=ownerSenderId===null?null:new Set([ownerSenderId,...additionalPrincipals]);
 const liveRecipients=configuredRecipients===null?null:new Set([...configuredRecipients,...additionalPrincipals]);
 // Who may message a Codex chat is a separate list. Its principals are checked against the live configuration;
 // a session address is an exact sender that is validated when it sends.
 const liveCodexSenders=codexSenderPrincipals===null?null:new Set(codexSenderPrincipals);
 function policy(){const c=readSessionMessagingPolicy(policyPath),d=readPrivateJson(discoveryPath);
  // A harness is on only if the owner opted its discovery in and, for Codex, enabled its messaging.
  const harnesses=d.harnesses||['claude'],claudeOn=harnesses.includes('claude'),codexOn=c.codex?.enabled===true&&harnesses.includes('codex');
  if(!c.enabled||!d.enabled||(!claudeOn&&!codexOn)||c.installationId!==d.installationId||c.workspace!==d.workspace)throw coded('session_disabled','Workspace messaging is disabled');
  const codexSenders=c.codex?.allowedSenders??[];
  const boundThread=boundIntegrationPath?readPrivateJson(boundIntegrationPath).threadId:null;
  return {...c,claudeOn,codexOn,boundSessionId:boundThread?sessionAddress(c.installationId,c.workspace,sessionAddressKey('codex',boundThread)):null,
   allowedSenders:liveSenders?c.allowedSenders.filter(id=>liveSenders.has(id)):c.allowedSenders,
   codexSenders:liveCodexSenders?codexSenders.filter(id=>id.startsWith('session-')||liveCodexSenders.has(id)):codexSenders,
   exactPairs:(c.exactPairs??[]).filter(p=>p.sender.startsWith('session-')||liveSenders===null||liveSenders.has(p.sender)||liveCodexSenders?.has(p.sender)),
   allowedRecipients:liveRecipients?c.allowedRecipients.filter(id=>liveRecipients.has(id)):c.allowedRecipients};}
 // Why a session cannot be reached right now, judged from data already loaded (no I/O); null when it can be.
 const offlineReason=(c,r,a,scope=policyScope(c))=>!r||r.lifecycle==='ended'?'Session has ended or is not discovered'
  :r.id===c.boundSessionId?'This is the bound Codex conversation; use its existing identity and inbox'
  :(r.harness==='codex'?!c.codexOn:!c.claudeOn)?'Messaging is disabled for this harness'
  :!a||a.installation_id!==scope||a.generation!==r.generation||a.expires_at<=clock()?'Session MCP child is offline':null;
 // One policy read, then primary-key lookups: no scan of the directory for a single session.
 async function current(id){
  const c=policy(),r=await journal.getDiscoveredSession({id,installationId:c.installationId,workspace:c.workspace});
  const a=r&&r.lifecycle!=='ended'?await journal.getSessionAttachment(id):null;
  const reason=offlineReason(c,r,a);
  if(reason)throw coded('session_offline',reason);
  return {c,r,a};
 }
 let lastSweep=0;
 function verify(request,harness){let c;try{c=policy();if(!equalSecret(request?.secret,c.secret)||request.installationId!==c.installationId||!UUID_PATTERN.test(request.childId)||!UUID_PATTERN.test(request.sessionId))throw coded('unauthorized','Invalid session attachment capability');}
  catch(error){failures.checkAndConsume('failed');throw error;}
  // Every session has its own budget (the heartbeat plus the occasional fresh grant for tool calls): a chatty session
  // must not starve the other sessions' leases. Only authenticated callers reach this, and idle buckets are swept.
  const now=Date.now();if(now-lastSweep>=60000){lastSweep=now;limiter.sweep();}
  limiter.checkAndConsume(sessionAddress(c.installationId,c.workspace,sessionAddressKey(harness,request.sessionId)));return c;}
 const harnessOf=request=>{
  const harness=request?.harness===undefined?'claude':request.harness;
  if(!['claude','codex'].includes(harness))throw coded('invalid_request','Unsupported session harness');
  return harness;
 };
 // Reachable Codex chats a given sender may message, for its credential's recipient claim. Only senders the owner
 // listed for Codex pay for the scan.
 const mayReceive=(c,sender,row)=>(row.harness==='codex'?c.codexOn:c.claudeOn)&&((row.harness==='codex'?c.codexSenders:c.allowedSenders).includes(sender)||c.exactPairs.some(p=>p.sender===sender&&p.recipient===row.id));
 async function sessionReceiversFor(c,sender){
  if(!c.allowedSenders.includes(sender)&&!c.codexSenders.includes(sender)&&!c.exactPairs.some(p=>p.sender===sender))return [];
  const scope=policyScope(c),attachments=new Map((await journal.listSessionAttachments()).map(a=>[a.id,a]));
  return (await journal.listDiscoveredSessions({installationId:c.installationId,workspace:c.workspace}))
   .filter(row=>mayReceive(c,sender,row)&&offlineReason(c,row,attachments.get(row.id),scope)===null).map(row=>row.id);
 }
 return {
  isInteractiveSender:id=>typeof id==='string'&&id.startsWith('session-'),
  allowedRecipients(){try{const list=[...policy().allowedRecipients];healthy();return list;}catch(error){degraded(error);return [];}},
  async attach(request){
   const harness=harnessOf(request),c=verify(request,harness),key=sessionAddressKey(harness,request.sessionId),identity=attachedSessionIdentity(key);
   if(!(harness==='codex'?c.codexOn:c.claudeOn))throw coded('session_disabled','Messaging is not enabled for this harness');
   const id=sessionAddress(c.installationId,c.workspace,key);
   if(id===c.boundSessionId)throw coded('bound_codex_context','This chat already owns the bound Codex identity; use its existing Triangle inbox instead of session attachment');
   const r=await journal.getDiscoveredSession({id,installationId:c.installationId,workspace:c.workspace});
   if(!r||r.lifecycle==='ended')throw coded('session_offline','Own lifecycle hook must register an active session first');
   if(request.generation!==undefined&&request.generation!==r.generation)throw coded('session_fenced','Session lifecycle generation changed');
   await journal.attachDiscoveredSession({id,childId:request.childId,generation:r.generation,installationId:policyScope(c),wakeCapable:request.wakeCapable===true,now:clock()});
   await journal.bindAttachedSessionWake({senderId:id,sessionId:identity.pseudoSessionId,generation:r.generation,bindingId:request.childId});
   return {senderId:id,sessionId:identity.pseudoSessionId,generation:r.generation,bindingId:request.childId,
    credential:issue(id,{senderType:'interactive',sessionId:identity.pseudoSessionId,generation:r.generation,bindingId:request.childId,turnId:randomUUID(),ttlMs:30000,allowedRecipients:[...c.allowedRecipients,...await sessionReceiversFor(c,id)]})};
  },
  async detach(request){const harness=harnessOf(request),c=verify(request,harness);const id=sessionAddress(c.installationId,c.workspace,sessionAddressKey(harness,request.sessionId));await journal.detachDiscoveredSession({id,childId:request.childId});return {detached:true};},
  async describeLocalSession(id){const {r}=await current(id);
   return Object.freeze({address:id,generation:r.generation,principal:null,authorityOrigin:null,bindingGeneration:null});},
  async validateRequest({claims,senderId}){const {r,a}=await current(senderId);
   if(claims.senderType!=='interactive'||claims.bindingId!==a.child_id||claims.generation!==r.generation)throw coded('session_fenced','Session attachment changed');},
  async checkRecipient(sender,to){if(!to.startsWith('session-'))return;const {c,r}=await current(to);if(!mayReceive(c,sender,r))throw coded('recipient_not_allowed','Session receiver policy denies sender');},
  // One policy read, one directory listing and one attachment listing however many sessions there are.
  async listFor(reader){let result=[];try{
    const c=policy();
    // A reader outside a harness's sender list is simply shown nothing of that harness.
    const claudeReader=c.claudeOn&&c.allowedSenders.includes(reader),codexReader=c.codexOn&&c.codexSenders.includes(reader);
    if(claudeReader||codexReader||c.exactPairs.some(p=>p.sender===reader)){
     const scope=policyScope(c),attachments=new Map((await journal.listSessionAttachments()).map(a=>[a.id,a]));
     const rows=(await journal.listDiscoveredSessions({installationId:c.installationId,workspace:c.workspace})).filter(row=>mayReceive(c,reader,row));
     const up=new Map(rows.map(row=>[row.id,offlineReason(c,row,attachments.get(row.id),scope)===null]));
     // A session without a live lease is not offline: only an end event or a vanished host process says that.
     const listed=await withSessionPresence(rows,{probe:processProbe,now:clock(),leaseOf:row=>up.get(row.id)?attachments.get(row.id).expires_at-30000:null});
     result=listed.map(row=>({...row,attachment:up.get(row.id)?'attached':row.lifecycle==='ended'?'ended':'not-attached',
      ...(!up.get(row.id)&&row.lifecycle!=='ended'?{attachmentHint:row.id===c.boundSessionId?'This is the bound Codex conversation; use its existing Triangle identity and inbox':row.harness==='codex'?CODEX_ATTACH_HINT:ATTACH_HINT}:{}),
      capabilities:{visible:true,reachable:up.get(row.id),wakeCapable:up.get(row.id)&&!!attachments.get(row.id).wake_capable}}));
    }
    healthy();}catch(error){degraded(error);}return result;},
  async recipientIds(reader){return (await this.listFor(reader)).filter(r=>r.capabilities.reachable).map(r=>r.id);},
 };
}
