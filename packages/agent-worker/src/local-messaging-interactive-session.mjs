import path from "node:path";
import fs from "node:fs";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { readPrivateJson } from "./local-messaging-auth-broker.mjs";
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

  const integration = validateInteractiveIntegration(integrationPath);
  const failureLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 30, windowMs: 60000 });
  const successLimiter = createPerSenderRateLimiter({ maxRequestsPerWindow: 120, windowMs: 60000 });

  function getCurrent() {
    return validateInteractiveIntegration(integrationPath);
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


// Workspace participation is a distinct owner capability. Discovery credentials never authorize messaging.
export function readSessionMessagingPolicy(file) {
 const c=readPrivateJson(file);
 if(!c||Object.keys(c).sort().join(',')!=='allowedRecipients,allowedSenders,enabled,installationId,secret,version,workspace'||c.version!==1||typeof c.enabled!=='boolean'||
   !UUID_PATTERN.test(c.installationId)||!HEX64_PATTERN.test(c.secret)||typeof c.workspace!=='string'||!path.isAbsolute(c.workspace)||fs.realpathSync(c.workspace)!==c.workspace||
   !Array.isArray(c.allowedSenders)||!Array.isArray(c.allowedRecipients)||c.allowedSenders.length>64||c.allowedRecipients.length>64||
   [...c.allowedSenders,...c.allowedRecipients].some(id=>!HEX64_PATTERN.test(id)))throw coded('invalid_session_policy','Invalid workspace messaging policy');
 return c;
}
export function attachedSessionIdentity(installationId,sessionId){
 // Separate pseudonymous UUID for the existing journal binding protocol.
 const sessionHash=createHash('sha256').update(sessionId.toLowerCase()).digest('hex');
 const pseudo=`${sessionHash.slice(0,8)}-${sessionHash.slice(8,12)}-4${sessionHash.slice(13,16)}-8${sessionHash.slice(17,20)}-${sessionHash.slice(20,32)}`;
 return {sessionHash,pseudoSessionId:pseudo};
}
export function createWorkspaceSessionBroker({policyPath,discoveryPath,journal,issue,clock=()=>Date.now()}) {
 const limiter=createPerSenderRateLimiter({maxRequestsPerWindow:240,windowMs:60000});
 const failures=createPerSenderRateLimiter({maxRequestsPerWindow:30,windowMs:60000});
 const policyScope=c=>c.installationId+':'+createHash('sha256').update(c.secret).digest('hex');
 function policy(){const c=readSessionMessagingPolicy(policyPath),d=readPrivateJson(discoveryPath);
  if(!c.enabled||!d.enabled||c.installationId!==d.installationId||c.workspace!==d.workspace)throw coded('session_disabled','Workspace messaging is disabled');return c;}
 async function rows(){const c=policy();return journal.listDiscoveredSessions({installationId:c.installationId,workspace:c.workspace});}
 async function current(id){
  const c=policy(),r=(await rows()).find(r=>r.id===id);
  if(!r||r.lifecycle==='ended')throw coded('session_offline','Session has ended or is not discovered');
  const a=await journal.getSessionAttachment(id);
  if(!a||a.installation_id!==policyScope(c)||a.generation!==r.generation||a.expires_at<=clock())throw coded('session_offline','Session MCP child is offline');
  return {c,r,a};
 }
 function verify(request){let c;try{c=policy();if(!equalSecret(request?.secret,c.secret)||request.installationId!==c.installationId||!UUID_PATTERN.test(request.childId)||!UUID_PATTERN.test(request.sessionId))throw coded('unauthorized','Invalid session attachment capability');}
  catch(error){failures.checkAndConsume('failed');throw error;}limiter.checkAndConsume('workspace');return c;}
 return {
  isInteractiveSender:id=>typeof id==='string'&&id.startsWith('session-'),
  allowedSender(id){try{return policy().allowedSenders.includes(id);}catch{return false;}},
  allowedRecipients(){try{return [...policy().allowedRecipients];}catch{return [];}},
  async attach(request){
   const c=verify(request),identity=attachedSessionIdentity(c.installationId,request.sessionId);
   const id='session-'+createHash('sha256').update(c.installationId+'\0'+c.workspace+'\0'+request.sessionId.toLowerCase()).digest('hex');
   const r=(await rows()).find(r=>r.id===id);
   if(!r||r.lifecycle==='ended')throw coded('session_offline','Own lifecycle hook must register an active session first');
   if(request.generation!==undefined&&request.generation!==r.generation)throw coded('session_fenced','Session lifecycle generation changed');
   await journal.attachDiscoveredSession({id,childId:request.childId,generation:r.generation,installationId:policyScope(c),wakeCapable:request.wakeCapable===true,now:clock()});
   await journal.initInteractiveWakeBinding({senderId:id,sessionId:identity.pseudoSessionId,generation:r.generation,bindingId:request.childId});
   return {senderId:id,sessionId:identity.pseudoSessionId,generation:r.generation,bindingId:request.childId,
    credential:issue(id,{senderType:'interactive',sessionId:identity.pseudoSessionId,generation:r.generation,bindingId:request.childId,turnId:randomUUID(),ttlMs:30000,allowedRecipients:[...c.allowedRecipients]})};
  },
  async detach(request){const c=verify(request);const id='session-'+createHash('sha256').update(c.installationId+'\0'+c.workspace+'\0'+request.sessionId.toLowerCase()).digest('hex');await journal.detachDiscoveredSession({id,childId:request.childId});return {detached:true};},
  async validateRequest({claims,senderId}){const {r,a}=await current(senderId);
   if(claims.senderType!=='interactive'||claims.bindingId!==a.child_id||claims.generation!==r.generation)throw coded('session_fenced','Session attachment changed');},
  async checkRecipient(sender,to){if(!to.startsWith('session-'))return;const {c}=await current(to);if(!c.allowedSenders.includes(sender))throw coded('recipient_not_allowed','Session receiver policy denies sender');},
  async listFor(reader){let result=[];try{if(!policy().allowedSenders.includes(reader))return [];for(const row of await rows()){
    let online=false,wake=false;try{const {a}=await current(row.id);online=true;wake=!!a.wake_capable;}catch{}
    result.push({...row,presence:online?'online':'offline',capabilities:{visible:true,reachable:online,wakeCapable:online&&wake}});
   }}catch{}return result;},
  async recipientIds(reader){return (await this.listFor(reader)).filter(r=>r.capabilities.reachable).map(r=>r.id);},
 };
}
