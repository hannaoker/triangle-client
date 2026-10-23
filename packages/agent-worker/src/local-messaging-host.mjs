import {createHash} from 'node:crypto';
import {createDesktopCredentialBroker,readPrivateJson} from './local-messaging-auth-broker.mjs';
import {validateInteractiveIntegration} from './local-messaging-interactive-session.mjs';
import {createLocalMessagingSubsystem} from './local-messaging-supervisor-seam.mjs';
import {createPerSenderRateLimiter} from './local-messaging-rate-limiter.mjs';
import {coded} from './local-messaging-errors.mjs';

export function loadLocalMessagingConfig(configPath) {
 const config=readPrivateJson(configPath);
 const keys=['version','enabled','stateRoot','bindingPath','integrationPath','recipients','runnerTimeoutMs','wake','interactive'];
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
 return config;
}

export function createInstalledLocalMessagingHost({configPath,runners,gate,logger={},wakeAdapter=null,wakeRunner=null,minIntervalMs=null,timerIntervalMs=null,clock=null}) {
 const config=loadLocalMessagingConfig(configPath);
 for(const r of config.recipients)if(typeof runners.get(r.instanceId)?.run!=='function')throw coded('local_recipient_unavailable',`Recipient runtime unavailable: ${r.profile}`);
 const integration=readPrivateJson(config.integrationPath);
 const recipientIds=config.recipients.map(r=>r.instanceId);

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

 const recipientDirectory=[
  {id:integration.senderId,label:'Codex (paired conversation)',kind:'conversation'},
  ...config.recipients.map(r=>({id:r.instanceId,label:r.profile,kind:'worker'})),
  ...(interactiveIntegration?[{id:interactiveIntegration.senderId,label:'Claude (paired conversation)',kind:'conversation'}]:[]),
 ];
 const codexAllowedRecipients=[...recipientIds];
 const registry=[integration.senderId,...recipientIds];
 const aclRules=Object.fromEntries([[integration.senderId,codexAllowedRecipients],...recipientIds.map(id=>[id,registry.filter(x=>x!==id)])]);

 if(interactiveIntegration){
  const claudeId=interactiveIntegration.senderId;
  codexAllowedRecipients.push(claudeId);
  registry.push(claudeId);
  aclRules[claudeId]=[...recipientIds];
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
   let interactiveBroker=null;
   const interactiveRecipients=new Set();
   if(interactiveIntegration){
    const {createInteractiveSessionBroker}=await import('./local-messaging-interactive-session.mjs');
    interactiveBroker=createInteractiveSessionBroker({
     integrationPath:config.interactive.integrationPath,
     recipients:recipientIds,
     issue:(sender,opts)=>subsystem.issueTurnCredential(sender,opts),
    });
    interactiveRecipients.add(interactiveBroker.senderId);
   }
   journal=createLocalMessagingJournal({stateRoot:config.stateRoot,logger});
   if(interactiveIntegration){
    await journal.initInteractiveWakeBinding({
     senderId:interactiveIntegration.senderId,
     sessionId:interactiveIntegration.sessionId,
     generation:interactiveIntegration.generation,
     bindingId:interactiveIntegration.bindingId,
    });
   }
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
    subsystem=createLocalMessagingSubsystem({stateRoot:config.stateRoot,registry,journal,dispatcher,notifier,aclRules,logger,interactiveBroker,interactiveRecipients,recipientDirectory,statusProvider:async()=>({...baseStatus(),journal:await journal.status(),dispatcher:dispatcher.status(),wake:await notifier?.status?.()??null}),credentialBroker:params=>{
     try {broker.verify(params);}
     catch(error){if(error?.code==='unauthorized')brokerFailureLimit.checkAndConsume('failed');throw error;}
     brokerLimit.checkAndConsume('desktop');
     return {credential:broker.issue(),senderId:broker.senderId,threadId:broker.threadId};
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
