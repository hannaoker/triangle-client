import path from 'node:path';
import fs from 'node:fs';
import {createLocalReplyRouteStore} from './local-reply-route-store.mjs';
import {createAttachedReplyIdentity} from './local-sender-authentication.mjs';
import {randomUUID as cryptoRandomId,createHash} from 'node:crypto';
import {createDesktopCredentialBroker,readPrivateJson,createSessionDiscoveryBroker} from './local-messaging-auth-broker.mjs';
import {createOwnerAcl} from './local-messaging-acl.mjs';
import {UUID_PATTERN,createWorkspaceSessionBroker,validateInteractiveIntegration} from './local-messaging-interactive-session.mjs';
import {createLocalMessagingSubsystem} from './local-messaging-supervisor-seam.mjs';
import {createPerSenderRateLimiter} from './local-messaging-rate-limiter.mjs';
import {coded} from './local-messaging-errors.mjs';
import {grokBindings,createGrokBroker} from './grok-local-session.mjs';

export function loadLocalMessagingConfig(configPath) {
 const config=readPrivateJson(configPath);
 const keys=['version','enabled','stateRoot','bindingPath','integrationPath','recipients','runnerTimeoutMs','wake','interactive','discovery','sessionMessaging','inbox','grok'];
 if(!config||config.version!==1||config.enabled!==true||Object.keys(config).some(k=>!keys.includes(k))||!Array.isArray(config.recipients)||config.recipients.length<1||config.recipients.length>32)throw coded('invalid_local_config','Invalid local messaging configuration');
 for(const key of ['stateRoot','bindingPath','integrationPath'])if(typeof config[key]!=='string'||!config[key].startsWith('/')||config[key].includes('\0'))throw coded('invalid_local_config','Local paths must be absolute');
 if(config.runnerTimeoutMs!==undefined&&(!Number.isInteger(config.runnerTimeoutMs)||config.runnerTimeoutMs<1000||config.runnerTimeoutMs>86400000))throw coded('invalid_local_config','Invalid runner timeout');
 if(config.interactive!==undefined){
  if(!config.interactive||typeof config.interactive!=='object'||Array.isArray(config.interactive))throw coded('invalid_local_config','Invalid interactive configuration');
  const interactiveKeys=['enabled','integrationPath'];
  if(Object.keys(config.interactive).some(k=>!interactiveKeys.includes(k))||typeof config.interactive.enabled!=='boolean')throw coded('invalid_local_config','Invalid interactive configuration');
  if(config.interactive.enabled){
   if(typeof config.interactive.integrationPath!=='string'||!config.interactive.integrationPath.startsWith('/')||config.interactive.integrationPath.includes('\0'))throw coded('invalid_local_config','Interactive integrationPath must be absolute');
  }
 }
 if(config.inbox!==undefined){
  const i=config.inbox;
  if(!i||Object.keys(i).sort().join(',')!=='allowedSenders,bindingId,enabled'||typeof i.enabled!=='boolean'||!UUID_PATTERN.test(i.bindingId)||!Array.isArray(i.allowedSenders)||i.allowedSenders.length>64||new Set(i.allowedSenders).size!==i.allowedSenders.length||i.allowedSenders.some(id=>typeof id!=='string'||!/^(session-)?[a-f0-9]{64}$/.test(id)))throw coded('invalid_local_config','Invalid desktop inbox policy');
 }
 if(config.sessionMessaging!==undefined){
  const m=config.sessionMessaging;
  if(!m||Object.keys(m).sort().join(',')!=='enabled,integrationPath'||typeof m.enabled!=='boolean'||typeof m.integrationPath!=='string'||!m.integrationPath.startsWith('/')||m.integrationPath.includes('\0'))throw coded('invalid_local_config','Invalid workspace messaging config');
  if(m.enabled&&!config.discovery?.enabled)throw coded('invalid_local_config','Workspace messaging requires lifecycle discovery');
 }
 if(config.discovery!==undefined){
  const d=config.discovery;
  if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['enabled','integrationPath','workspace','titles'].includes(k))||typeof d.enabled!=='boolean'||(d.titles!==undefined&&typeof d.titles!=='boolean')||
    (d.enabled&&(typeof d.integrationPath!=='string'||!d.integrationPath.startsWith('/')||d.integrationPath.includes('\0'))))throw coded('invalid_local_config','Invalid discovery configuration');
 }
 if(config.wake!==undefined){
  if(!config.wake||typeof config.wake!=='object'||Array.isArray(config.wake))throw coded('invalid_local_config','Invalid wake configuration');
  const wakeKeys=['enabled','codexPath','codexHome','minIntervalMs','timerIntervalMs','timeoutMs'];
  if(Object.keys(config.wake).some(k=>!wakeKeys.includes(k))||typeof config.wake.enabled!=='boolean')throw coded('invalid_local_config','Invalid wake configuration');
  for(const key of ['codexPath','codexHome']){
   if(config.wake[key]!==undefined){
    if(typeof config.wake[key]!=='string'||!config.wake[key].startsWith('/')||config.wake[key].includes('\0'))throw coded('invalid_local_config','Wake paths must be absolute');
   }
  }
  if(config.wake.enabled){
   if(typeof config.wake.codexPath!=='string'||typeof config.wake.codexHome!=='string')throw coded('invalid_local_config','Enabled wake requires codexPath and codexHome');
  }
  if(config.wake.minIntervalMs!==undefined&&(!Number.isSafeInteger(config.wake.minIntervalMs)||config.wake.minIntervalMs<15000||config.wake.minIntervalMs>86400000))throw coded('invalid_local_config','Wake minIntervalMs must be a safe integer >= 15000');
  if(config.wake.timerIntervalMs!==undefined&&(!Number.isSafeInteger(config.wake.timerIntervalMs)||config.wake.timerIntervalMs<=0||config.wake.timerIntervalMs>86400000))throw coded('invalid_local_config','Wake timerIntervalMs must be a safe positive integer');
  if(config.wake.timeoutMs!==undefined&&(!Number.isSafeInteger(config.wake.timeoutMs)||config.wake.timeoutMs<=0||config.wake.timeoutMs>15000))throw coded('invalid_local_config','Wake timeoutMs must be a safe positive integer <= 15000');
 }
 const ids=new Set(),profiles=new Set();
 for(const r of config.recipients){
  if(!r||Object.keys(r).sort().join(',')!=='instanceId,profile'||typeof r.profile!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(r.profile)||!/^[a-f0-9]{64}$/.test(r.instanceId)||ids.has(r.instanceId)||profiles.has(r.profile))throw coded('invalid_local_config','Invalid or duplicate local recipient');
  ids.add(r.instanceId);profiles.add(r.profile);
 }
 grokBindings(config);
 return config;
}

export function createInstalledLocalMessagingHost({configPath,runners,gate,logger={},wakeAdapter=null,wakeRunner=null,minIntervalMs=null,timerIntervalMs=null,clock=null,replyIdentityEnabled=null}) {
 const config=loadLocalMessagingConfig(configPath);
 const replyPolicyPath=path.join(path.dirname(configPath),'reply-identity.json');
 const replyPolicy=()=>{
  try {
   const metadata=fs.lstatSync(replyPolicyPath);
   if(!metadata.isFile()||metadata.nlink!==1||metadata.size>4096)throw new Error('invalid policy');
   const policy=readPrivateJson(replyPolicyPath);
   if(policy.version!==1||typeof policy.enabled!=='boolean'||Object.keys(policy).sort().join(',')!=='enabled,version')throw new Error('invalid policy');
   return {enabled:policy.enabled,minimumRuntime:14};
  }catch(error){return {enabled:false,...(error.code==='ENOENT'?{}:{error:'invalid_reply_identity_policy',minimumRuntime:14})};}
 };
 const admissionEnabled=replyIdentityEnabled??(()=>replyPolicy().enabled);

 for(const r of config.recipients)if(typeof runners.get(r.instanceId)?.run!=='function')throw coded('local_recipient_unavailable',`Recipient runtime unavailable: ${r.profile}`);
 const integration=readPrivateJson(config.integrationPath);
 const recipientIds=config.recipients.map(r=>r.instanceId);
 const inboxEnabled=config.inbox?.enabled===true;
 const inboxPolicy=()=>{try{const current=loadLocalMessagingConfig(configPath).inbox;return inboxEnabled&&current?.enabled?current:null;}catch{return null;}};
 const receivesFrom=sender=>!!inboxPolicy()?.allowedSenders.includes(sender);
 const desktopEpoch=()=>{const c=readPrivateJson(config.integrationPath);return createHash('sha256').update(c.bindingId+'\0'+c.secret+'\0'+c.threadId).digest('hex');};
 const desktopClaims=()=>{const policy=inboxPolicy();if(!policy)throw coded('inbox_disabled','Desktop inbox is disabled');return {senderType:'desktop-inbox',sessionId:policy.bindingId,generation:1,bindingId:desktopEpoch()};};
 const inboxBroker={
  isDesktopSender:id=>id===integration.senderId,
  validateRequest({claims,senderId}){const current=readPrivateJson(config.integrationPath),expected=desktopClaims();if(senderId!==integration.senderId||current.senderId!==integration.senderId||current.threadId!==integration.threadId||claims.senderType!==expected.senderType||claims.sessionId!==expected.sessionId||claims.generation!==expected.generation||claims.bindingId!==expected.bindingId)throw coded('binding_changed','Desktop inbox binding changed');},
 };


 let interactiveIntegration=null;
 if(config.interactive?.enabled){
  interactiveIntegration=validateInteractiveIntegration(config.interactive.integrationPath);
  if(interactiveIntegration.senderId===integration.senderId){
   throw coded('identity_collision','Interactive senderId collides with host Codex senderId');
  }
  if(recipientIds.includes(interactiveIntegration.senderId)){
   throw coded('identity_collision','Interactive senderId collides with worker profile instanceId');
  }
  if(config.recipients.some(r=>r.profile==='claude')){
   throw coded('identity_collision','Worker profile claude collides with interactive destination');
  }
 }

 const grokEntries=grokBindings(config);
 const grokIds=grokEntries.map(b=>b.senderId);
 const reservedIds=[integration.senderId,...recipientIds,...(interactiveIntegration?[interactiveIntegration.senderId]:[])];
 if(grokIds.some(id=>reservedIds.includes(id)))throw coded('identity_collision','Grok identity collides with existing participant');
 const recipientDirectory=[
  {id:integration.senderId,label:'Codex (paired conversation)',kind:'conversation'},
  ...config.recipients.map(r=>({id:r.instanceId,label:r.profile,kind:'worker'})),
  ...(interactiveIntegration?[{id:interactiveIntegration.senderId,label:'Claude (paired conversation)',kind:'conversation'}]:[]),
 ];
 const codexAllowedRecipients=[...recipientIds];
 const registry=[integration.senderId,...recipientIds,...grokIds];
 const aclRules=Object.fromEntries([[integration.senderId,codexAllowedRecipients],...recipientIds.map(id=>[id,reservedIds.filter(x=>x!==id)])]);

 if(interactiveIntegration){
  const claudeId=interactiveIntegration.senderId;
  codexAllowedRecipients.push(claudeId);
  registry.push(claudeId);
  aclRules[claudeId]=[...recipientIds,...(inboxEnabled&&receivesFrom(claudeId)?[integration.senderId]:[])];
  for(const id of recipientIds){
   if(aclRules[id]&&!aclRules[id].includes(claudeId))aclRules[id].push(claudeId);
  }
 }

 // Verified exchanges and failed attempts use separate buckets, so a failing caller cannot lock out the desktop.
 const brokerLimit=createPerSenderRateLimiter({maxRequestsPerWindow:120,windowMs:60000});
 const brokerFailureLimit=createPerSenderRateLimiter({maxRequestsPerWindow:30,windowMs:60000});
 let subsystem=null,journal=null,dispatcher=null,notifier=null,startPromise=null,closed=false;
 const broker=createDesktopCredentialBroker({bindingPath:config.bindingPath,integrationPath:config.integrationPath,recipients:codexAllowedRecipients,issue:(sender,opts)=>subsystem.issueTurnCredential(sender,opts)});
 function baseStatus(){return {route:'same-device',running:subsystem?.running??false,senderId:broker.senderId,threadId:broker.threadId,recipients:config.recipients};}
 async function start() {
  if(closed)throw coded('local_host_closed','Local host is closed');
  if(startPromise)return startPromise;
  startPromise=(async()=>{
   const {createLocalMessagingJournal}=await import('./local-messaging-journal.mjs');
   const {createLocalMessagingDispatcher}=await import('./local-messaging-dispatcher.mjs');
   const {createLocalMessagingNotifier}=await import('./local-messaging-notifier.mjs');
   let interactiveBroker=null,sessionBroker=null;
   const grokBroker=config.grok?createGrokBroker({config,issue:(sender,opts)=>subsystem.issueTurnCredential(sender,opts)}):null;
   const interactiveRecipients=new Set();
   if(interactiveIntegration){
    const {createInteractiveSessionBroker}=await import('./local-messaging-interactive-session.mjs');
    interactiveBroker=createInteractiveSessionBroker({
     integrationPath:config.interactive.integrationPath,
     recipients:[...recipientIds,...grokEntries.filter(b=>b.allowedSenders.includes(interactiveIntegration.senderId)).map(b=>b.senderId),...(inboxEnabled&&receivesFrom(interactiveIntegration.senderId)?[integration.senderId]:[])],
     issue:(sender,opts)=>subsystem.issueTurnCredential(sender,opts),
    });
    interactiveRecipients.add(interactiveBroker.senderId);
   }
   journal=createLocalMessagingJournal({stateRoot:config.stateRoot,logger,titles:config.discovery?.titles!==false,replyRouteStoreFactory:createLocalReplyRouteStore});
   if(interactiveIntegration){
    await journal.initInteractiveWakeBinding({
     senderId:interactiveIntegration.senderId,
     sessionId:interactiveIntegration.sessionId,
     generation:interactiveIntegration.generation,
     bindingId:interactiveIntegration.bindingId,
    });
   }
   if(config.sessionMessaging?.enabled){
    sessionBroker=createWorkspaceSessionBroker({policyPath:config.sessionMessaging.integrationPath,discoveryPath:config.discovery.integrationPath,journal,
     boundIntegrationPath:config.integrationPath,additionalPrincipals:grokIds,ownerSenderId:integration.senderId,configuredRecipients:[...recipientIds,...(inboxEnabled?[integration.senderId]:[])],
     codexSenderPrincipals:[integration.senderId,...recipientIds,...(interactiveIntegration?[interactiveIntegration.senderId]:[]),...grokIds],logger,
     issue:(sender,opts)=>subsystem.issueSessionCredential(sender,opts)});
    const legacy=interactiveBroker;
    interactiveBroker={
     isInteractiveSender:id=>sessionBroker.isInteractiveSender(id)||!!legacy?.isInteractiveSender(id),
     validateRequest:args=>sessionBroker.isInteractiveSender(args.senderId)?sessionBroker.validateRequest(args):legacy.validateRequest(args),
     exchange:args=>{if(!legacy)throw coded('unsupported','No paired session configured');return legacy.exchange(args);},
    };
   }
   if(grokBroker){
    const existing=interactiveBroker;
    interactiveBroker={
     isInteractiveSender:id=>grokBroker.has(id)||!!existing?.isInteractiveSender(id),
     validateRequest:args=>grokBroker.has(args.senderId)?grokBroker.validateRequest(args):existing.validateRequest(args),
     exchange:args=>grokEntries.some(b=>b.bindingId===args?.bindingId)?grokBroker.exchange(args):existing?.exchange(args)??Promise.reject(coded('unauthorized','Invalid interactive binding')),
     filterDirectory:(sender,rows)=>grokBroker.has(sender)?rows.filter(row=>grokBroker.allowedRecipients(sender).includes(row.id)):rows,
    };
   }
   const baseAcl=createOwnerAcl({rules:aclRules});
   const ownerAcl={
    async listAuthorizedRecipients(sender){
     const candidates=[...new Set([...(grokBroker?.has(sender)?grokBroker.allowedRecipients(sender):[]),...grokIds,...baseAcl.listAuthorizedRecipients(sender),...(sessionBroker?await sessionBroker.recipientIds(sender):[]),...(sessionBroker?.isInteractiveSender(sender)?sessionBroker.allowedRecipients():[])])].filter(id=>id!==integration.senderId||receivesFrom(sender));
     const allowed=[];for(const id of candidates){try{await this.checkAllowed(sender,id);allowed.push(id);}catch{}}return allowed;},
    async checkAllowed(sender,to){
     const involvesGrok=grokBroker&&(grokBroker.has(sender)||grokBroker.has(to));
     if(involvesGrok)grokBroker.checkAllowed(sender,to);
     if(to===integration.senderId){if(!inboxEnabled||!receivesFrom(sender))throw coded('recipient_not_allowed','Desktop inbox receiver policy denies sender');return;}
     if(sessionBroker?.isInteractiveSender(to)){await sessionBroker.checkRecipient(sender,to);return;}
     if(sessionBroker?.isInteractiveSender(sender)&&sessionBroker.allowedRecipients().includes(to))return;
     if(involvesGrok){
      if(!registry.includes(sender)&&!sessionBroker?.isInteractiveSender(sender))throw coded('recipient_not_allowed','Unknown sender');
      if(!registry.includes(to))throw coded('recipient_not_allowed','Unknown recipient');
      return;
     }
     baseAcl.checkAllowed(sender,to);
    },
   };
   const sessionRecipients={has:id=>(inboxEnabled&&id===integration.senderId)||!!grokBroker?.has(id)||interactiveRecipients.has(id)||!!sessionBroker?.isInteractiveSender(id)};
   try {
    dispatcher=createLocalMessagingDispatcher({journal,logger,runnerTimeoutMs:config.runnerTimeoutMs??3600000,runRecipient:(job,options)=>{
     const runner=runners.get(job.recipient);
     if(!runner)throw coded('local_recipient_unavailable','Recipient runtime unavailable');
     const request={contextId:'local-'+createHash('sha256').update(`${job.sender}\0${job.requestId}`).digest('hex').slice(0,40),senderId:job.sender,text:job.text};
     return gate.run(async ()=>{
      options.signal?.throwIfAborted();
      options.onStarted?.();
      const res = await runner.run(request,{...options,timeoutMs:config.runnerTimeoutMs??3600000});
      setTimeout(() => notifier?.notifyObligationChange?.(), 20);
      return res;
     },{signal:options.signal,instanceId:job.recipient});
    }});
    notifier=createLocalMessagingNotifier({
     journal,
     inboxEnabled,
     targetIdentity:broker.senderId,
     threadId:broker.threadId,
     bindingId:integration.bindingId,
     generation:integration.generation,
     wakeConfig:config.wake,
     adapter:wakeAdapter,
     runner:wakeRunner,
     logger,
     minIntervalMs:minIntervalMs??config.wake?.minIntervalMs??15000,
     timerIntervalMs:timerIntervalMs??config.wake?.timerIntervalMs??5000,
     clock:clock??{now:()=>Date.now()},
    });
    const discoveryBroker=config.discovery?.enabled?createSessionDiscoveryBroker({integrationPath:config.discovery.integrationPath,journal,logger}):null;
    subsystem=createLocalMessagingSubsystem({stateRoot:config.stateRoot,registry,journal,dispatcher,notifier,aclRules,logger,interactiveBroker,interactiveRecipients:sessionRecipients,recipientDirectory:[...recipientDirectory,...(grokBroker?.directory??[])],discoveryBroker,sessionBroker,replyIdentityFactory:sessionBroker?({credentialValidator})=>createAttachedReplyIdentity({credentialValidator,sessionBroker,enabled:admissionEnabled}):null,ownerAcl,inboxBroker,statusProvider:async()=>({...baseStatus(),replyIdentity:{enabled:!!sessionBroker&&(typeof admissionEnabled==='function'?!!admissionEnabled():admissionEnabled===true),scope:'attached-chat-pairs',...(replyPolicy().error?{error:replyPolicy().error}:{} )},discovery:discoveryBroker?await discoveryBroker.status():{enabled:false},journal:await journal.status(),dispatcher:dispatcher.status(),wake:await notifier?.status?.()??null}),credentialBroker:async params=>{
     try {broker.verify(params);}
     catch(error){if(error?.code==='unauthorized')brokerFailureLimit.checkAndConsume('failed');throw error;}
     brokerLimit.checkAndConsume('desktop');
     return {credential:(sessionBroker||grokBroker)?subsystem.issueTurnCredential(broker.senderId,{turnId:cryptoRandomId(),ttlMs:300000,allowedRecipients:await ownerAcl.listAuthorizedRecipients(broker.senderId),conversationId:broker.threadId,loopDepth:1,...(inboxPolicy()?desktopClaims():{})}):inboxEnabled?subsystem.issueTurnCredential(broker.senderId,{turnId:cryptoRandomId(),ttlMs:300000,allowedRecipients:await ownerAcl.listAuthorizedRecipients(broker.senderId),conversationId:broker.threadId,loopDepth:1,...(inboxPolicy()?desktopClaims():{})}):broker.issue(),senderId:broker.senderId,threadId:broker.threadId};
    }});
    await subsystem.start();
    try {
     await notifier.start();
    } catch(notifierErr){
     await notifier.stop().catch(()=>{});
     await subsystem.stop().catch(()=>{});
     throw notifierErr;
    }
   } catch(error){
    // Release the journal owner lock so the supervisor's retry can reopen it.
    if(notifier)await notifier.stop().catch(()=>{});
    if(subsystem)await subsystem.stop().catch(()=>{});else await journal?.close().catch(()=>{});
    journal=dispatcher=notifier=subsystem=null;
    throw error;
   }
  })();
  try {await startPromise;} catch(error){startPromise=null;throw error;}
 }
 async function stop(){
  closed=true;
  if(startPromise)await startPromise.catch(()=>{});
  if(notifier)await notifier.stop();
  if(subsystem)await subsystem.stop();else await journal?.close?.();
 }
 return {
  start,stop,
  status(){return {...baseStatus(),dispatcher:dispatcher?.status?.()??null};},
  async watch({signal,onStarted}={}){
   await start();
   onStarted?.();
   try {await new Promise(resolve=>{if(signal?.aborted)return resolve();signal?.addEventListener('abort',resolve,{once:true});});}
   finally {await stop();}
   return {stopped:true};
  },
 };
}
