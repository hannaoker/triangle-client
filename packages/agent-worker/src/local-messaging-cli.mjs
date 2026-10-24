#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readPrivateJson,writePrivateJson} from './local-messaging-auth-broker.mjs';
import {resolveLocalSocketAddress} from './local-messaging-address.mjs';
import {createLocalControlClient} from './local-messaging-client.mjs';
import {createLocalMessagingMcpHandler,runMcpStdioSession} from './local-messaging-mcp-adapter.mjs';
import {validateInteractiveIntegration,UUID_PATTERN,HEX64_PATTERN} from './local-messaging-interactive-session.mjs';
import {SUPPORTED_CLAUDE_VERSION} from './claude-session-delivery.mjs';
import {coded} from './local-messaging-errors.mjs';

export function defaultLocalConfigPath(env=process.env){return path.join(env.HOME||os.homedir(),'Library/Application Support/The Triangle/client/local-messaging.json');}
function parse(argv){
 const args=[...argv],command=args.shift()||'help',options={};
 const flags=new Set(['config','thread-id','desktop-binding','recipient','state-root','text','text-file','to','message-id','request-id','in-reply-to','wait-ms','wake-id','generation','integration','expected-version','workspace','local-cli','workspace-messaging','sender','claim-id','claim-file','reply-id','limit','cursor','harness']);
 while(args.length){const flag=args.shift();if(flag==='--rebind-thread'){options.rebind=true;continue;}if(!flag.startsWith('--')||!flags.has(flag.slice(2))||!args.length)throw coded('invalid_arguments','Unknown argument or missing value');const key=flag.slice(2),value=args.shift();if(key==='recipient')(options.recipients??=[]).push(value);else if(key==='sender')(options.senders??=[]).push(value);else {if(options[key]!==undefined)throw coded('invalid_arguments','Duplicate argument');options[key]=value;}}
 return {command,options};
}
export function setupLocalMessaging(options,env=process.env){
 const configPath=options.config||defaultLocalConfigPath(env);
 const configDir=path.dirname(configPath);
 const defaultBindingPath=fs.existsSync(path.join(configDir,'desktop-binding.json'))
  ? path.join(configDir,'desktop-binding.json')
  : (fs.existsSync(path.join(configDir,'app-server-binding.json'))
     ? path.join(configDir,'app-server-binding.json')
     : path.join(configDir,'desktop-binding.json'));
 const bindingPath=options['desktop-binding']||defaultBindingPath;
 const stateRoot=options['state-root']||path.join(configDir,'local');
 const integrationPath=path.join(stateRoot,'desktop-integration.json');
 if(!fs.existsSync(bindingPath)&&fs.existsSync(integrationPath)){
  const existing=readPrivateJson(integrationPath);
  if(existing.senderId&&/^[a-f0-9]{64}$/.test(existing.senderId)){
   writePrivateJson(bindingPath,{version:1,instanceId:existing.senderId});
  }
 }
 // Dedicated desktop-sender binding is only read for sender identity; host owns and rewrites that file.
 const binding=readPrivateJson(bindingPath),threadId=options['thread-id'];
 const senderId=binding.instanceId??binding.senderId;
 if(typeof threadId!=='string'||!/^[A-Za-z0-9._:-]{8,120}$/.test(threadId)||!/^[a-f0-9]{64}$/.test(senderId))throw coded('invalid_binding','An existing sender identity and explicit thread are required');
 const profiles=options.recipients||['gravity2'];
 if(profiles.length>32||new Set(profiles).size!==profiles.length||profiles.some(p=>!/^[A-Za-z0-9._-]{1,64}$/.test(p)))throw coded('invalid_recipient','Invalid recipient profiles');
 const recipients=profiles.map(profile=>({profile,instanceId:createHash('sha256').update('triangle-client-instance-v1\0'+profile).digest('hex')}));
 let secret=randomBytes(32).toString('hex'),bindingChanged=true;
 if(fs.existsSync(integrationPath)){
  const existing=readPrivateJson(integrationPath);
  // The desktop thread lives only in the integration file; moving it is an explicit owner action that rotates the capability.
  if(existing.threadId!==threadId&&!options.rebind)throw coded('binding_changed','Explicit --rebind-thread is required to change the desktop thread');
  bindingChanged=existing.senderId!==senderId||existing.threadId!==threadId;
  if(!bindingChanged)secret=existing.secret;
 }
 writePrivateJson(integrationPath,{version:1,bindingId:createHash('sha256').update(senderId+'\0'+threadId).digest('hex').slice(0,32),senderId,threadId,secret});
 const previous=fs.existsSync(configPath)?readPrivateJson(configPath):{};
 const optional=Object.fromEntries(['wake','interactive','discovery','sessionMessaging','inbox'].filter(key=>previous[key]!==undefined).map(key=>[key,previous[key]]));
 // Wake activation belongs to a specific sender/thread, never to a replacement binding.
 if(optional.wake&&bindingChanged)optional.wake={...optional.wake,enabled:false};
 if(optional.inbox&&bindingChanged)optional.inbox={...optional.inbox,enabled:false,bindingId:randomUUID()};
 // Session participation authorizes one specific Codex sender, so a replacement sender must be re-authorized
 // explicitly. A thread-only rebind keeps the sender and therefore keeps participation.
 let sessionMessagingDisabled=false,mcpCleanupRequired=false;
 if(optional.sessionMessaging){
  let authorized=false;
  try{authorized=readPrivateJson(optional.sessionMessaging.integrationPath).allowedSenders?.includes(senderId)===true;}catch{}
  if(!authorized){
   // Fail closed: the new config omits the key, and the old capability is fenced and its managed MCP entry removed when possible.
   delete optional.sessionMessaging;sessionMessagingDisabled=true;
   try{mcpCleanupRequired=disableWorkspaceMessaging({config:configPath},env).mcpCleanupRequired;}catch{mcpCleanupRequired=true;}
  }
 }
 writePrivateJson(configPath,{version:1,enabled:true,stateRoot,bindingPath,integrationPath,recipients,runnerTimeoutMs:previous.runnerTimeoutMs??3600000,...optional});
 return {configPath,senderId,threadId,recipients,requiresServiceRestart:true,...(sessionMessagingDisabled?{sessionMessagingDisabled,mcpCleanupRequired}:{})};
}
const KNOWN_SETUP_KEYS = new Set([
 'configPath',
 'config',
 'stateRoot',
 'state-root',
 'integrationPath',
 'integration-path',
 'senderId',
 'secret',
 'sessionId',
 'bindingId',
 'generation',
 'enabled',
 'revoked',
 'recipients',
]);

export function setupInteractiveSession(options = {}, env = process.env) {
 for (const k of Object.keys(options)) {
  if (!KNOWN_SETUP_KEYS.has(k)) {
   throw coded('invalid_options', `Unknown option: ${k}`);
  }
 }

 if (options.senderId !== undefined && (!HEX64_PATTERN.test(options.senderId) || typeof options.senderId !== 'string')) {
  throw coded('invalid_options', 'senderId must be 64-char hex string');
 }
 if (options.secret !== undefined && (!HEX64_PATTERN.test(options.secret) || typeof options.secret !== 'string')) {
  throw coded('invalid_options', 'secret must be 64-char hex string');
 }
 if (options.sessionId !== undefined && (!UUID_PATTERN.test(options.sessionId) || typeof options.sessionId !== 'string')) {
  throw coded('invalid_options', 'sessionId must be a valid UUID');
 }
 if (options.bindingId !== undefined && (!UUID_PATTERN.test(options.bindingId) || typeof options.bindingId !== 'string')) {
  throw coded('invalid_options', 'bindingId must be a valid UUID');
 }
 if (options.generation !== undefined && (!Number.isSafeInteger(options.generation) || options.generation < 1)) {
  throw coded('invalid_options', 'generation must be a safe positive integer >= 1');
 }
 if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
  throw coded('invalid_options', 'enabled must be a boolean');
 }
 if (options.revoked !== undefined && typeof options.revoked !== 'boolean') {
  throw coded('invalid_options', 'revoked must be a boolean');
 }

 const configPath = options.configPath || options.config || defaultLocalConfigPath(env);
 const configDir = path.dirname(configPath);
 const stateRoot = options.stateRoot || options['state-root'] || path.join(configDir, 'local');
 const integrationPath = options.integrationPath || options['integration-path'] || path.join(stateRoot, 'claude-integration.json');

 let senderId = options.senderId || randomBytes(32).toString('hex');
 let secret = options.secret || randomBytes(32).toString('hex');
 let sessionId = options.sessionId || randomUUID();
 let bindingId = options.bindingId || randomUUID();
 let generation = options.generation || 1;
 let enabled = options.enabled !== undefined ? options.enabled : false; // Default disabled
 let revoked = options.revoked !== undefined ? options.revoked : false;

 if (fs.existsSync(integrationPath)) {
  let existing;
  try {
   existing = validateInteractiveIntegration(integrationPath);
  } catch (err) {
   throw coded('invalid_existing_state', `Existing interactive integration file is malformed: ${err.message}`);
  }

  if (options.senderId && options.senderId !== existing.senderId) {
   throw coded('invalid_existing_state', 'Cannot change senderId on existing interactive session');
  }
  if (options.sessionId && options.sessionId !== existing.sessionId) {
   throw coded('invalid_existing_state', 'Cannot change sessionId on existing interactive session');
  }
  if (options.bindingId && options.bindingId !== existing.bindingId) {
   throw coded('invalid_existing_state', 'Cannot change bindingId on existing interactive session');
  }
  if (options.secret && options.secret !== existing.secret) {
   throw coded('invalid_existing_state', 'Cannot change secret on existing interactive session without rebind helper');
  }
  if (options.generation !== undefined && options.generation !== existing.generation) {
   throw coded('invalid_existing_state', 'Cannot change generation on existing interactive session');
  }

  if (options.revoked !== undefined && options.revoked !== existing.revoked) {
   throw coded('unsupported_operation', 'Cannot change revoked state on existing interactive session via setup; requires explicit activation or revocation');
  }
  revoked = existing.revoked;

  if (options.enabled !== undefined && options.enabled !== existing.enabled) {
   throw coded('unsupported_operation', 'Cannot change enabled state on existing interactive session via setup; requires explicit activation or revocation');
  }
  enabled = existing.enabled;

  senderId = existing.senderId;
  secret = existing.secret;
  sessionId = existing.sessionId;
  bindingId = existing.bindingId;
  generation = existing.generation;
 }

 writePrivateJson(integrationPath, {
  version: 1,
  type: 'interactive',
  senderId,
  sessionId,
  generation,
  bindingId,
  secret,
  enabled,
  revoked,
 });

 return {
  configPath,
  integrationPath,
  senderId,
  sessionId,
  generation,
  bindingId,
  enabled,
  revoked,
 };
}

export function activateInteractiveSession({ integrationPath }) {
 if (!integrationPath || typeof integrationPath !== 'string') {
  throw coded('invalid_options', 'integrationPath is required');
 }
 const existing = validateInteractiveIntegration(integrationPath);
 const newSecret = randomBytes(32).toString('hex');
 const newGeneration = existing.generation + 1;
 const updated = {
  ...existing,
  secret: newSecret,
  generation: newGeneration,
  enabled: true,
  revoked: false,
 };
 writePrivateJson(integrationPath, updated);
 return updated;
}

export function revokeInteractiveSession({ integrationPath }) {
 if (!integrationPath || typeof integrationPath !== 'string') {
  throw coded('invalid_options', 'integrationPath is required');
 }
 const existing = validateInteractiveIntegration(integrationPath);
 const updated = {
  ...existing,
  enabled: false,
  revoked: true,
 };
 writePrivateJson(integrationPath, updated);
 return updated;
}
export async function reconcileWakeOffline(options,env=process.env){
 const config=readPrivateJson(options.config||defaultLocalConfigPath(env));
 if(config.version!==1||config.enabled!==true)throw coded('local_disabled','Local messaging is disabled');
 if(config.wake?.enabled!==false)throw coded('wake_must_be_disabled','Disable wake explicitly and stop the Triangle service before reconciliation');
 const generation=Number(options.generation),wakeId=options['wake-id'];
 if(!wakeId||!Number.isSafeInteger(generation)||generation<1)throw coded('invalid_arguments','Exact held wake-id and current generation are required');
 const integration=readPrivateJson(config.integrationPath),binding=readPrivateJson(config.bindingPath);
 if((binding.instanceId??binding.senderId)!==integration.senderId)throw coded('binding_changed','Desktop sender identity changed');
 const {createLocalMessagingJournal}=await import('./local-messaging-journal.mjs');
 let journal;
 try {
  journal=createLocalMessagingJournal({stateRoot:config.stateRoot});
  return await journal.reconcileStaleWake({requester:integration.senderId,threadId:integration.threadId,authBindingId:integration.bindingId,wakeId,generation});
 } catch(error){
  if(error?.code==='journal_busy'||error?.code==='drain_busy')throw coded('journal_busy','Stop the Triangle service before offline wake reconciliation');
  throw error;
 } finally {await journal?.close();}
}

// Local discovery is an owner-installed hook integration, not an agent tool.
const shellQuote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
// Owner-installed workspace files (Claude hook settings, .mcp.json) are replaced atomically: a private temp file
// beside the target, flushed before the rename, so a crash leaves the old file or the new one and never a torn one.
function replaceJsonFile(file,value){
 const temp=`${file}.triangle-${randomUUID()}`;let fd;
 try{
  fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(temp,file);
 }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
}
function discoveryHookSettings(workspace,harness){
 return {directory:path.join(workspace,harness==='codex'?'.codex':'.claude'),filename:harness==='codex'?'hooks.json':'settings.local.json'};
}
export function setupSessionDiscovery(options,env=process.env){
 const harness=options.harness||'claude';
 if(!['claude','codex'].includes(harness))throw coded('invalid_arguments','Discovery harness must be claude or codex');
 const configPath=options.config||defaultLocalConfigPath(env),config=readPrivateJson(configPath);
 if(config.version!==1||config.enabled!==true)throw coded('local_disabled','Local messaging is disabled');
 if(typeof options.workspace!=='string'||!path.isAbsolute(options.workspace))throw coded('invalid_arguments','An explicit absolute workspace is required');
 const workspace=fs.realpathSync(options.workspace);
 const localCli=options['local-cli']||path.join(env.HOME||os.homedir(),'Library/Application Support/The Triangle/bin/triangle-local');
 const wrapper=fs.lstatSync(localCli);
 if(fs.realpathSync(localCli)!==localCli||!wrapper.isFile()||wrapper.uid!==process.getuid()||(wrapper.mode&0o022)||(wrapper.mode&0o111)===0)throw coded('unsafe_path','Local CLI must be an owned canonical executable');
 const integrationPath=path.join(config.stateRoot,'session-discovery.json');
 const readerIds=[readPrivateJson(config.integrationPath).senderId,...config.recipients.map(r=>r.instanceId)];
 if(config.interactive?.enabled)readerIds.push(validateInteractiveIntegration(config.interactive.integrationPath).senderId);
 let integration={version:1,enabled:true,installationId:randomUUID(),secret:randomBytes(32).toString('hex'),workspace,readerIds:[...new Set(readerIds)]};
 if(fs.existsSync(integrationPath)){
  const old=readPrivateJson(integrationPath);
  if(old.workspace!==workspace)throw coded('workspace_conflict','This discovery installation is scoped to another workspace');
  integration={...old,enabled:true,readerIds:integration.readerIds};
 }
 // One workspace capability, with an explicit owner-approved harness ceiling.
 const harnesses=[...new Set([...(integration.harnesses||(fs.existsSync(integrationPath)?['claude']:[])),harness])];
 if(harnesses.includes('codex'))integration={...integration,harnesses};
 const {directory,filename}=discoveryHookSettings(workspace,harness);
 if(!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});
 const info=fs.lstatSync(directory);
 if(!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o022)||fs.realpathSync(directory)!==directory)throw coded('unsafe_path','Unsafe workspace hook settings directory');
 const settingsPath=path.join(directory,filename);
 let settings={};
 if(fs.existsSync(settingsPath)){
  const st=fs.lstatSync(settingsPath);
  if(!st.isFile()||st.uid!==process.getuid()||st.nlink!==1||st.size>1024*1024)throw coded('unsafe_path','Unsafe hook settings');
  settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
 }
 if(!settings||typeof settings!=='object'||Array.isArray(settings)||
   (settings.hooks&& (typeof settings.hooks!=='object'||Array.isArray(settings.hooks))))throw coded('invalid_settings','Invalid hook settings');
 const command=`${shellQuote(localCli)} discovery-hook --config ${shellQuote(configPath)}${harness==='codex'?' --harness codex':''}`;
 settings.hooks??={};
 for(const event of ['SessionStart','SessionEnd','UserPromptSubmit']){
  const entries=settings.hooks[event]??[];
  if(!Array.isArray(entries))throw coded('invalid_settings','Invalid lifecycle hook list');
  if(!entries.some(entry=>entry.hooks?.some(hook=>hook.type==='command'&&hook.command===command)))entries.push({hooks:[{type:'command',command,timeout:harness==='codex'&&event==='SessionEnd'?3:5}]});
  settings.hooks[event]=entries;
 }
 // Install capability first and enable host config last. A partial setup cannot
 // grant message authority, and rerunning setup never duplicates the hooks.
 writePrivateJson(integrationPath,integration);
 replaceJsonFile(settingsPath,settings);
 writePrivateJson(configPath,{...config,discovery:{enabled:true,integrationPath,workspace}});
 return {workspace,settingsPath,harness,requiresServiceRestart:true,requiresHarnessHookApproval:true,discoveryOnly:true};
}

export function disableSessionDiscovery(options,env=process.env){
 const configPath=options.config||defaultLocalConfigPath(env),config=readPrivateJson(configPath);
 const integrationPath=config.discovery?.integrationPath||path.join(config.stateRoot,'session-discovery.json');
 let integration=null;
 try{integration=readPrivateJson(integrationPath);}catch{/* Missing or corrupt capabilities cannot admit new reports. */}
 if(integration)writePrivateJson(integrationPath,{...integration,enabled:false});
 const workspace=options.workspace||config.discovery?.workspace||integration?.workspace;
 let hooksCleanupRequired=false;
 try{
  if(typeof workspace!=='string')throw coded('workspace_unknown','Workspace required for hook cleanup');
  if(!fs.existsSync(workspace))throw coded('workspace_missing','Workspace moved or missing');
  for(const harness of ['claude','codex']){
   const {directory,filename}=discoveryHookSettings(workspace,harness),settingsPath=path.join(directory,filename);
   if(!fs.existsSync(settingsPath))continue;
   const dir=fs.lstatSync(directory),file=fs.lstatSync(settingsPath);
   if(fs.realpathSync(workspace)!==workspace||fs.realpathSync(directory)!==directory||!dir.isDirectory()||dir.uid!==process.getuid()||(dir.mode&0o022)||
     !file.isFile()||file.uid!==process.getuid()||file.nlink!==1||file.size>1024*1024)throw coded('unsafe_path','Unsafe hook settings');
   const settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
   const suffix=` discovery-hook --config ${shellQuote(configPath)}`;
   for(const event of ['SessionStart','SessionEnd','UserPromptSubmit']){
    if(!Array.isArray(settings.hooks?.[event]))continue;
    settings.hooks[event]=settings.hooks[event].flatMap(entry=>{
     if(!Array.isArray(entry?.hooks))return [entry];
     const hooks=entry.hooks.filter(hook=>!(hook.type==='command'&&typeof hook.command==='string'&&(hook.command.endsWith(suffix)||hook.command.endsWith(suffix+' --harness codex'))));
     return hooks.length===entry.hooks.length?[entry]:hooks.length?[{...entry,hooks}]:[];
    });
    if(!settings.hooks[event].length)delete settings.hooks[event];
   }
   if(settings.hooks&&!Object.keys(settings.hooks).length)delete settings.hooks;
   replaceJsonFile(settingsPath,settings);
  }
 }catch{hooksCleanupRequired=true;}
 // Always remove the optional keys, even if hook or MCP cleanup needs an explicit moved workspace.
 const messaging=config.sessionMessaging!==undefined?disableWorkspaceMessaging({config:configPath,workspace:options.workspace},env):null;
 const {discovery,sessionMessaging,...previousSchema}=config;writePrivateJson(configPath,previousSchema);
 return {discoveryEnabled:false,hooksCleanupRequired,...(messaging?{mcpCleanupRequired:messaging.mcpCleanupRequired}:{})};
}

export async function runSessionDiscoveryHook({configPath,input,harness='claude',stderr=process.stderr}){
 try{
  let text='';for await(const chunk of input){text+=chunk;if(Buffer.byteLength(text)>65536)throw coded('invalid_hook','Hook input exceeds metadata limit');}
  const payload=JSON.parse(text);
  if(!['claude','codex'].includes(harness))throw coded('invalid_hook','Unsupported discovery harness');
  if(!UUID_PATTERN.test(payload.session_id)||typeof payload.cwd!=='string')throw coded('invalid_hook','Missing own-session lifecycle context');
  const kinds={SessionStart:'start',SessionEnd:'end',UserPromptSubmit:'activity'};
  const kind=kinds[payload.hook_event_name];if(!kind)throw coded('invalid_hook','Unsupported lifecycle event');
  const config=readPrivateJson(configPath);if(!config.discovery?.enabled)return 0;
  const integration=readPrivateJson(config.discovery.integrationPath);if(!integration.enabled||!(integration.harnesses||['claude']).includes(harness))return 0;
  const workspace=fs.realpathSync(payload.cwd);if(workspace!==integration.workspace)return 0;
  const event={eventId:randomUUID(),sessionId:payload.session_id,kind,workspace,observedAt:Date.now(),...(harness==='codex'?{harness}:{})};
  const client=createLocalControlClient({socketPath:resolveLocalSocketAddress({stateRoot:config.stateRoot}).socketPath,timeoutMs:1500,connectTimeoutMs:1500});
  try{
   const auth={installationId:integration.installationId,secret:integration.secret};
   const {nonce}=await client.discoveryChallenge({...auth,event});
   await client.reportDiscovery({...auth,nonce,event});
  }finally{await client.close();}
 }catch(error){stderr.write(`Triangle discovery unavailable (${typeof error?.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'hook_error'})\n`);}
 // Hook failure must not block a conversation or leak hook input in diagnostics.
 return 0;
}

export async function runLocalMessagingCLI(argv,{env=process.env,input=process.stdin,output=process.stdout}={}){
 const {command,options}=parse(argv);
 if(command==='help'||command==='--help'){output.write('triangle-local: setup, setup-discovery, disable-discovery, setup-session-messaging, disable-session-messaging, setup-inbox, disable-inbox, inbox, claim, reply, status, discover, sessions, send, replies, consume, ack-wake, reconcile-wake, mcp, claude-session-mcp\n');return 0;}
 if(command==='setup-inbox'){output.write(JSON.stringify(setupDesktopInbox(options,env))+'\n');return 0;}
 if(command==='disable-inbox'){output.write(JSON.stringify(disableDesktopInbox(options,env))+'\n');return 0;}
 if(command==='setup-session-messaging'){output.write(JSON.stringify(setupWorkspaceMessaging(options,env))+'\n');return 0;}
 if(command==='disable-session-messaging'){output.write(JSON.stringify(disableWorkspaceMessaging(options,env))+'\n');return 0;}
 if(command==='setup-discovery'){output.write(JSON.stringify(setupSessionDiscovery(options,env))+'\n');return 0;}
 if(command==='discovery-hook')return runSessionDiscoveryHook({configPath:options.config||defaultLocalConfigPath(env),input,harness:options.harness||'claude'});
 if(command==='disable-discovery'){output.write(JSON.stringify(disableSessionDiscovery(options,env))+'\n');return 0;}
 if(command==='reconcile-wake'){
  output.write(JSON.stringify(await reconcileWakeOffline(options,env))+'\n');return 0;
 }
 if(command==='setup'){output.write(JSON.stringify(setupLocalMessaging(options,env))+'\n');return 0;}
 if(command==='claude-session-mcp'){
  const configPath=options.config||defaultLocalConfigPath(env);
  const config=readPrivateJson(configPath);
  const expectedVersion=options['expected-version']||config.interactive?.expectedVersion;
  if(!expectedVersion){
   throw coded('missing_expected_version','Explicit expected Claude version is required');
  }
  const {createClaudeSessionMcpChild,createAttachedClaudeSessionMcpChild}=await import('./claude-session-mcp-child.mjs');
  const factory=options['workspace-messaging']?createAttachedClaudeSessionMcpChild:createClaudeSessionMcpChild;
  const child=await factory({
   policyPath:options['workspace-messaging'],
   configPath,
   integrationPath:options.integration,
   expectedVersion,
   env,
   input,
   output,
  });
  let stopping=null;
  const stop=()=>{
   stopping??=child.close().catch(()=>{process.exitCode=1;}).finally(()=>{input.destroy?.();});
  };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  try {
   await child.run();
  } finally {
   process.removeListener('SIGINT',stop);
   process.removeListener('SIGTERM',stop);
   await child.close();
   if(stopping)await stopping;
  }
  return 0;
 }
 if(!['status','discover','sessions','send','replies','consume','ack-wake','inbox','claim','reply','mcp','claude-session-mcp'].includes(command))throw coded('invalid_arguments','Unknown command');
 const config=readPrivateJson(options.config||defaultLocalConfigPath(env));
 if(config.version!==1||config.enabled!==true)throw coded('local_disabled','Local messaging is disabled');
 const binding=readPrivateJson(config.integrationPath);
 const {socketPath}=resolveLocalSocketAddress({stateRoot:config.stateRoot});
 const client=createLocalControlClient({socketPath,senderId:binding.senderId});
 const credential=async()=>{
  const current=readPrivateJson(config.integrationPath);
  if(current.senderId!==binding.senderId||current.threadId!==binding.threadId||current.bindingId!==binding.bindingId)throw coded('binding_changed','Desktop integration changed');
  const grant=await client.exchangeTurnBinding({bindingId:current.bindingId,threadId:current.threadId,secret:current.secret});
  if(grant.senderId!==binding.senderId||grant.threadId!==binding.threadId)throw coded('binding_changed','Server returned a different sender binding');
  return grant.credential;
 };
 try {
  if(command==='mcp'){
   await runMcpStdioSession({input,output,handler:createLocalMessagingMcpHandler({client,turnCredentialProvider:credential})});return 0;
  }
  const rpcOptions={credential:await credential()};let result;
  if(command==='status')result=options['message-id'] ? await client.getMessageStatus({messageId:options['message-id']},rpcOptions) : await client.localStatus(rpcOptions);
  if(command==='inbox'){const rows=await client.listInbox({limit:options.limit===undefined?50:Number(options.limit),cursor:options.cursor},rpcOptions);result={items:[...rows],nextCursor:rows.nextCursor??null};}
  if(command==='claim'){
   if(!options['message-id']||!options['claim-id'])throw coded('invalid_arguments','Stable message-id and claim-id required');
   result=await client.claimInboxMessage({messageId:options['message-id'],claimId:options['claim-id']},rpcOptions);
  }
  if(command==='reply'){
   if(!options['claim-file']||!options['message-id']||!options['reply-id'])throw coded('invalid_arguments','Private claim-file, message-id and stable reply-id required');
   const claim=readPrivateJson(options['claim-file']);
   if(claim.messageId!==options['message-id']||typeof claim.claimToken!=='string')throw coded('invalid_arguments','Claim file must match the message');
   if(options.text&&options['text-file'])throw coded('invalid_arguments','Use text or text-file, not both');
   const text=options['text-file']?fs.readFileSync(options['text-file'],'utf8'):options.text;
   if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>128*1024)throw coded('invalid_message','Bounded nonempty reply required');
   result=await client.sendReply({messageId:claim.messageId,claimToken:claim.claimToken,replyId:options['reply-id'],text},rpcOptions);
  }
  if(command==='sessions')result={sessions:await client.listSessions(rpcOptions)};
  if(command==='discover')result={senderId:binding.senderId,threadId:binding.threadId,recipients:await client.discoverRecipients(rpcOptions)};
  if(command==='replies')result={senderId:binding.senderId,replies:await client.listReplies({requestId:options['request-id'],inReplyTo:options['in-reply-to']},rpcOptions)};
  if(command==='consume')result=await client.consumeReply({messageId:options['message-id']},rpcOptions);
  if(command==='ack-wake'){
   const wakeId=options['wake-id'],generation=Number(options.generation);
   if(!wakeId||!Number.isInteger(generation)||generation<0)throw coded('invalid_arguments','wake-id and valid generation are required');
   result=await client.ackWake({wakeId,generation},rpcOptions);
  }
  if(command==='send'){
   let to=config.recipients.find(r=>r.profile===options.to||r.instanceId===options.to)?.instanceId;
   if(!to&&config.interactive?.enabled&&config.interactive.integrationPath){
    try {
     const claudeIntegration=readPrivateJson(config.interactive.integrationPath);
     if(options.to==='claude'||options.to===claudeIntegration.senderId){
      to=claudeIntegration.senderId;
     }
    }catch{}
   }
   if(!to&&config.sessionMessaging?.enabled&&/^session-[a-f0-9]{64}$/.test(options.to||'')){
    const sessions=await client.listSessions(rpcOptions);
    if(sessions.some(row=>row.id===options.to&&row.capabilities?.reachable===true))to=options.to;
   }
   if(!to)throw coded('recipient_not_allowed','Choose an explicitly authorized reachable recipient');
   if(options.text&&options['text-file'])throw coded('invalid_arguments','Use text or text-file, not both');
   const text=options['text-file']?fs.readFileSync(options['text-file'],'utf8'):options.text;
   if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>128*1024)throw coded('invalid_message','A bounded nonempty message is required');
   const wait=Number(options['wait-ms']||0);
   if(!Number.isInteger(wait)||wait<0||wait>300000)throw coded('invalid_arguments','wait-ms must be between 0 and 300000');
   const messageId=options['message-id']||randomUUID(),requestId=options['request-id']||randomUUID();
   let admission;
   try { admission=await client.sendMessage({to,text,messageId,requestId},rpcOptions); }
   catch(error) {
    output.write(JSON.stringify({senderId:binding.senderId,messageId,requestId,state:'send_outcome_unknown',error:error?.code||'send_failed'})+'\n');
    return 1;
   }
   result={senderId:binding.senderId,threadId:binding.threadId,admission};
   if(wait){
    const deadline=Date.now()+wait;let refreshAt=Date.now()+240000,activeOptions=rpcOptions;
    try {
     while(Date.now()<deadline){
      if(Date.now()>=refreshAt){activeOptions={credential:await credential()};refreshAt=Date.now()+240000;}
      const replies=await client.listReplies({requestId:admission.requestId,inReplyTo:admission.messageId},{...activeOptions,timeout:Math.min(5000,Math.max(1,deadline-Date.now()))});
      if(replies.length){result.replies=replies;break;}
      await new Promise(r=>setTimeout(r,Math.min(300,Math.max(1,deadline-Date.now()))));
     }
    } catch(error){result.waitError=error?.code||'reply_wait_failed';}
    if(!result.replies)result.waiting=true;
   }
  }
  output.write(JSON.stringify(result)+'\n');return 0;
 } finally {await client.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.exitCode=await runLocalMessagingCLI(process.argv.slice(2));}catch(error){process.stderr.write(JSON.stringify({error:typeof error?.code==='string'?error.code:'local_command_failed',message:'Triangle local command failed; check binding, service status and arguments'})+'\n');process.exitCode=1;}
}


export function setupWorkspaceMessaging(options,env=process.env){
 const configPath=options.config||defaultLocalConfigPath(env),config=readPrivateJson(configPath);
 if(!config.discovery?.enabled)throw coded('discovery_required','Enable lifecycle discovery in this disposable workspace first');
 const d=readPrivateJson(config.discovery.integrationPath);
 if(!d.enabled||!options.workspace||fs.realpathSync(options.workspace)!==d.workspace)throw coded('workspace_mismatch','Explicit opted-in discovery workspace required');
 const wrapper=options['local-cli']||path.join(env.HOME||os.homedir(),'Library/Application Support/The Triangle/bin/triangle-local');
 const st=fs.lstatSync(wrapper);
 if(fs.realpathSync(wrapper)!==wrapper||!st.isFile()||st.uid!==process.getuid()||(st.mode&0o022)||!(st.mode&0o100))throw coded('unsafe_path','Owner installed wrapper required');
 const integrationPath=config.sessionMessaging?.integrationPath||path.join(config.stateRoot,'session-messaging.json');
 const old=fs.existsSync(integrationPath)?readPrivateJson(integrationPath):null;
 const policy={version:1,enabled:true,workspace:d.workspace,installationId:d.installationId,secret:old?.enabled===true&&old?.installationId===d.installationId?old.secret:randomBytes(32).toString('hex'),allowedSenders:[readPrivateJson(config.integrationPath).senderId],allowedRecipients:[...config.recipients.map(r=>r.instanceId),...(config.inbox?.enabled?[readPrivateJson(config.integrationPath).senderId]:[])]};
 const file=path.join(d.workspace,'.mcp.json');
 let mcp={};
 if(fs.existsSync(file)){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.uid!==process.getuid()||stat.nlink!==1||stat.size>1024*1024)throw coded('unsafe_path','Unsafe workspace MCP configuration');
  mcp=JSON.parse(fs.readFileSync(file,'utf8'));
 }
 if(!mcp||typeof mcp!=='object'||Array.isArray(mcp)||mcp.mcpServers&&(typeof mcp.mcpServers!=='object'||Array.isArray(mcp.mcpServers)))throw coded('invalid_settings','Invalid MCP configuration');
 const name='triangle-session';
 const entry={command:wrapper,args:['claude-session-mcp','--config',configPath,'--workspace-messaging',integrationPath,'--expected-version',SUPPORTED_CLAUDE_VERSION]};
 if(mcp.mcpServers?.[name]&&JSON.stringify(mcp.mcpServers[name])!==JSON.stringify(entry))throw coded('integration_exists','Preserve existing Triangle MCP configuration; choose a disposable workspace');
 writePrivateJson(integrationPath,policy);
 // Workspace config is not a credential; preserve unrelated MCP entries atomically.
 replaceJsonFile(file,{...mcp,mcpServers:{...mcp.mcpServers,[name]:entry}});
 writePrivateJson(configPath,{...config,sessionMessaging:{enabled:true,integrationPath}});
 return {workspace:d.workspace,mcpServer:name,requiresServiceRestart:true,requiresMcpReconnect:true,requiresHarnessApproval:true,discoveryOnly:false};
}
export function disableWorkspaceMessaging(options,env=process.env){
 const configPath=options.config||defaultLocalConfigPath(env),config=readPrivateJson(configPath);
 const file=config.sessionMessaging?.integrationPath||path.join(config.stateRoot,'session-messaging.json');
 // Fence the capability first. A missing or unreadable policy cannot admit anyone (the broker and the MCP
 // children read it through the same private reader), so disabling must still converge without it.
 let policy=null;
 try{policy=readPrivateJson(file);}catch{}
 if(policy)writePrivateJson(file,{...policy,enabled:false});
 const {sessionMessaging,...rest}=config;writePrivateJson(configPath,rest);
 let mcpCleanupRequired=false;
 try{
  // The policy names the workspace and discovery records it too, so a damaged policy does not strand the managed entry.
  const workspace=options.workspace||policy?.workspace||config.discovery?.workspace;
  if(typeof workspace!=='string')mcpCleanupRequired=Boolean(policy||sessionMessaging);
  else{
   const mcpPath=path.join(workspace,'.mcp.json');
   if(fs.existsSync(mcpPath)){
    const st=fs.lstatSync(mcpPath);
    if(fs.realpathSync(workspace)!==workspace||!st.isFile()||st.uid!==process.getuid()||st.nlink!==1||st.size>1024*1024)throw coded('unsafe_path','Unsafe MCP settings');
    const mcp=JSON.parse(fs.readFileSync(mcpPath,'utf8')),entry=mcp.mcpServers?.['triangle-session'];
    const args=entry?.args;
    if(Array.isArray(args)&&args[0]==='claude-session-mcp'&&args[1]==='--config'&&args[2]===configPath&&args[3]==='--workspace-messaging'&&args[4]===file){
     delete mcp.mcpServers['triangle-session'];
     replaceJsonFile(mcpPath,mcp);
    }
   }
  }
 }catch{mcpCleanupRequired=true;}
 return {sessionMessagingEnabled:false,mcpCleanupRequired};
}


export function setupDesktopInbox(options,env=process.env){
 const configPath=options.config||defaultLocalConfigPath(env),config=readPrivateJson(configPath),desktop=readPrivateJson(config.integrationPath);
 const allowedSenders=options.senders;
 if(!Array.isArray(allowedSenders)||!allowedSenders.length||allowedSenders.length>64||new Set(allowedSenders).size!==allowedSenders.length||allowedSenders.some(id=>typeof id!=='string'||!/^(session-)?[a-f0-9]{64}$/.test(id)||id===desktop.senderId))throw coded('invalid_arguments','Choose explicit distinct sender IDs with --sender');
 // Workspace participation remains its own capability ceiling; add only the receiver destination.
 if(config.sessionMessaging?.enabled){const file=config.sessionMessaging.integrationPath,policy=readPrivateJson(file);writePrivateJson(file,{...policy,allowedRecipients:[...new Set([...policy.allowedRecipients,desktop.senderId])]});}
 writePrivateJson(configPath,{...config,inbox:{enabled:true,bindingId:randomUUID(),allowedSenders}});
 return {inboxEnabled:true,senderId:desktop.senderId,allowedSenders,automaticWake:config.wake?.enabled===true,requiresServiceRestart:true};
}
export function disableDesktopInbox(options,env=process.env){
 const configPath=options.config||defaultLocalConfigPath(env),config=readPrivateJson(configPath),desktop=readPrivateJson(config.integrationPath);
 // Revoke receiver authority first. A missing workspace policy cannot preserve inbox permission.
 const {inbox,...rest}=config;writePrivateJson(configPath,rest);
 let policyCleanupRequired=false;
 if(config.sessionMessaging?.enabled){try{const file=config.sessionMessaging.integrationPath,policy=readPrivateJson(file);writePrivateJson(file,{...policy,allowedRecipients:policy.allowedRecipients.filter(id=>id!==desktop.senderId)});}catch{policyCleanupRequired=true;}}
 return {inboxEnabled:false,policyCleanupRequired,requiresServiceRestart:true};
}
