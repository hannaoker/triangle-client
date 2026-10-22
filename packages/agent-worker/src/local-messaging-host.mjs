import {createHash} from 'node:crypto';
import {createDesktopCredentialBroker,readPrivateJson} from './local-messaging-auth-broker.mjs';
import {createLocalMessagingSubsystem} from './local-messaging-supervisor-seam.mjs';
import {createPerSenderRateLimiter} from './local-messaging-rate-limiter.mjs';
import {coded} from './local-messaging-errors.mjs';

export function loadLocalMessagingConfig(configPath) {
 const config=readPrivateJson(configPath);
 const keys=['version','enabled','stateRoot','bindingPath','integrationPath','recipients','runnerTimeoutMs'];
 if(!config||config.version!==1||config.enabled!==true||Object.keys(config).some(k=>!keys.includes(k))||!Array.isArray(config.recipients)||config.recipients.length<1||config.recipients.length>32)throw coded('invalid_local_config','Invalid local messaging configuration');
 for(const key of ['stateRoot','bindingPath','integrationPath'])if(typeof config[key]!=='string'||!config[key].startsWith('/')||config[key].includes('\0'))throw coded('invalid_local_config','Local paths must be absolute');
 if(config.runnerTimeoutMs!==undefined&&(!Number.isInteger(config.runnerTimeoutMs)||config.runnerTimeoutMs<1000||config.runnerTimeoutMs>600000))throw coded('invalid_local_config','Invalid runner timeout');
 const ids=new Set(),profiles=new Set();
 for(const r of config.recipients){
  if(!r||Object.keys(r).sort().join(',')!=='instanceId,profile'||typeof r.profile!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(r.profile)||!/^[a-f0-9]{64}$/.test(r.instanceId)||ids.has(r.instanceId)||profiles.has(r.profile))throw coded('invalid_local_config','Invalid or duplicate local recipient');
  ids.add(r.instanceId);profiles.add(r.profile);
 }
 return config;
}

export function createInstalledLocalMessagingHost({configPath,runners,gate,logger={}}) {
 const config=loadLocalMessagingConfig(configPath);
 for(const r of config.recipients)if(typeof runners.get(r.instanceId)?.run!=='function')throw coded('local_recipient_unavailable',`Recipient runtime unavailable: ${r.profile}`);
 const integration=readPrivateJson(config.integrationPath);
 const recipientIds=config.recipients.map(r=>r.instanceId);
 const registry=[integration.senderId,...recipientIds];
 const aclRules=Object.fromEntries([[integration.senderId,recipientIds],...recipientIds.map(id=>[id,registry.filter(x=>x!==id)])]);
 const brokerLimit=createPerSenderRateLimiter({maxRequestsPerWindow:120,windowMs:60000});
 let subsystem=null,journal=null,dispatcher=null,startPromise=null,closed=false;
 const broker=createDesktopCredentialBroker({bindingPath:config.bindingPath,integrationPath:config.integrationPath,recipients:recipientIds,issue:(sender,opts)=>subsystem.issueTurnCredential(sender,opts)});
 function baseStatus(){return {route:'same-device',running:subsystem?.running??false,senderId:broker.senderId,threadId:broker.threadId,recipients:config.recipients};}
 async function start() {
  if(closed)throw coded('local_host_closed','Local host is closed');
  if(startPromise)return startPromise;
  startPromise=(async()=>{
   const {createLocalMessagingJournal}=await import('./local-messaging-journal.mjs');
   const {createLocalMessagingDispatcher}=await import('./local-messaging-dispatcher.mjs');
   journal=createLocalMessagingJournal({stateRoot:config.stateRoot,logger});
   dispatcher=createLocalMessagingDispatcher({journal,logger,runnerTimeoutMs:config.runnerTimeoutMs??180000,runRecipient:(job,options)=>{
    const runner=runners.get(job.recipient);
    if(!runner)throw coded('local_recipient_unavailable','Recipient runtime unavailable');
    const request={contextId:'local-'+createHash('sha256').update(`${job.sender}\0${job.requestId}`).digest('hex').slice(0,40),senderId:job.sender,text:job.text};
    return gate.run(()=>{options.signal?.throwIfAborted();options.onStarted?.();return runner.run(request,options);},{signal:options.signal,instanceId:job.recipient});
   }});
   subsystem=createLocalMessagingSubsystem({stateRoot:config.stateRoot,registry,journal,dispatcher,aclRules,logger,statusProvider:async()=>({...baseStatus(),journal:await journal.status(),dispatcher:dispatcher.status()}),credentialBroker:params=>{
    brokerLimit.checkAndConsume('desktop');
    return {credential:broker.exchange(params),senderId:broker.senderId,threadId:broker.threadId};
   }});
   try {await subsystem.start();} catch(error){await subsystem.stop().catch(()=>{});throw error;}
  })();
  try {await startPromise;} catch(error){startPromise=null;throw error;}
 }
 async function stop(){
  closed=true;
  if(startPromise)await startPromise.catch(()=>{});
  if(subsystem)await subsystem.stop();else await journal?.close?.();
 }
 return {
  start,stop,
  status(){return {...baseStatus(),dispatcher:dispatcher?.status?.()??null};},
  async watch({signal}={}){
   await start();
   try {await new Promise(resolve=>{if(signal?.aborted)return resolve();signal?.addEventListener('abort',resolve,{once:true});});}
   finally {await stop();}
   return {stopped:true};
  },
 };
}
