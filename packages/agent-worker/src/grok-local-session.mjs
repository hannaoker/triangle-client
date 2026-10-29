// Pull-only Grok participants. Provider context selects a pairing; the private
// capability authenticates it. Same-user shell processes are one trust boundary.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readPrivateJson, writePrivateJson, withPrivateFileLock} from './local-messaging-auth-broker.mjs';
import {createInteractiveSessionBroker, readSessionMessagingPolicy, HEX64_PATTERN, UUID_PATTERN} from './local-messaging-interactive-session.mjs';
import {createLocalControlClient} from './local-messaging-client.mjs';
import {resolveLocalSocketAddress} from './local-messaging-address.mjs';
import {coded} from './local-messaging-errors.mjs';
import {privateDir,privateFile} from './delivery-private-path.mjs';

const ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const ADDRESS = /^(session-)?[a-f0-9]{64}$/;
const KEYS = ['version','type','alias','contextHash','senderId','sessionId','generation','bindingId','secret','enabled','revoked','allowedSenders','allowedRecipients'];
const hash = value => createHash('sha256').update(value).digest('hex');
function contextHash(value) {
  // Observed v0.75.5 subset only. Do not accept encoded/truncated contexts or
  // normalize case without a provider contract. A future format needs re-probing.
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw coded('unsupported_grok_context','Expected observed Grok conversation context');
  }
  return hash(value);
}
function exactIds(ids) {
  return Array.isArray(ids) && ids.length <= 64 && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && ADDRESS.test(id));
}
export function readGrokBinding(file) {
  const b = readPrivateJson(file);
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).sort().join(',') !== [...KEYS].sort().join(',') || b.version !== 1 || b.type !== 'grok' || typeof b.alias !== 'string' || !ALIAS.test(b.alias) ||
      !(b.contextHash === null || (typeof b.contextHash === 'string' && HEX64_PATTERN.test(b.contextHash))) || typeof b.senderId !== 'string' || !HEX64_PATTERN.test(b.senderId) || typeof b.secret !== 'string' || !HEX64_PATTERN.test(b.secret) ||
      !UUID_PATTERN.test(b.sessionId) || !UUID_PATTERN.test(b.bindingId) || !Number.isSafeInteger(b.generation) || b.generation < 1 ||
      typeof b.enabled !== 'boolean' || typeof b.revoked !== 'boolean' || !exactIds(b.allowedSenders) || !exactIds(b.allowedRecipients)) {
    throw coded('invalid_grok_binding','Invalid Grok pairing');
  }
  return b;
}
export function grokBindings(config) {
  const g = config.grok;
  if (g === undefined) return [];
  if (!g || Object.keys(g).sort().join(',') !== 'bindings,enabled' || typeof g.enabled !== 'boolean' || !Array.isArray(g.bindings) || g.bindings.length > 32 ||
      new Set(g.bindings).size !== g.bindings.length || g.bindings.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) {
    throw coded('invalid_grok_config','Invalid Grok configuration');
  }
  const entries = g.bindings.map(file => ({file, ...readGrokBinding(file)}));
  if (new Set(entries.map(b=>b.senderId)).size !== entries.length || new Set(entries.map(b=>b.alias)).size !== entries.length) {
    throw coded('identity_collision','Duplicate Grok identity or alias');
  }
  return entries;
}
export function setupGrok(options, configPath, env = process.env) {
 const config=readPrivateJson(configPath);
 return config.sessionMessaging?.enabled?withPrivateFileLock(config.sessionMessaging.integrationPath,()=>setupGrokLocked(options,configPath,env)):setupGrokLocked(options,configPath,env);
}
function setupGrokLocked(options, configPath, env = process.env) {
  const config = readPrivateJson(configPath), entries = grokBindings(config);
  if (config.version !== 1 || config.enabled !== true) throw coded('local_disabled','Enable local messaging first');
  if (!ALIAS.test(options.alias || '') || entries.some(b=>b.alias === options.alias) || entries.length >= 32) throw coded('invalid_grok_alias','Use a new distinct alias');
  // An owner can pair a metadata-probed hash without disclosing or persisting
  // the raw provider ID. Runtime selection still hashes its own launch context.
  const suppliedHash = options['context-hash'];
  if (suppliedHash !== undefined && (typeof suppliedHash !== 'string' || !HEX64_PATTERN.test(suppliedHash) || options['conversation-id'] !== undefined)) throw coded('invalid_grok_context','Choose one valid context hash or conversation ID');
  const context = options['conversation-id'] ?? env.CURSOR_CONVERSATION_ID;
  const contextDigest = suppliedHash ?? (context === undefined ? null : contextHash(context));
  const allowedSenders = options.senders || [], allowedRecipients = options.recipients || [];
  if (!exactIds(allowedSenders) || !exactIds(allowedRecipients)) throw coded('invalid_grok_grants','Exact recipient and sender addresses required');
  const owner = readPrivateJson(config.integrationPath).senderId;
  const senderId = hash(JSON.stringify(['triangle-grok-conversation-v1', owner, contextDigest ?? ['alias',options.alias]]));
  if (entries.some(b=>b.senderId === senderId) || [owner,...config.recipients.map(r=>r.instanceId)].includes(senderId)) throw coded('identity_collision','Context already paired');
  const binding = {version:1,type:'grok',alias:options.alias,contextHash:contextDigest,senderId,sessionId:randomUUID(),generation:1,bindingId:randomUUID(),secret:randomBytes(32).toString('hex'),enabled:true,revoked:false,allowedSenders,allowedRecipients};
  const file = path.join(config.stateRoot,`grok-${options.alias}.json`);
  if (fs.existsSync(file)) throw coded('pairing_exists','Pairing file already exists');
  // Explicit exact-session grants also opt this principal into the existing
  // workspace policy ceiling; the per-Grok checks still restrict individual peers.
  if ([...allowedSenders,...allowedRecipients].some(id=>id.startsWith('session-'))) {
    if (!config.sessionMessaging?.enabled) throw coded('session_messaging_required','Enable workspace session messaging first');
    const policy = readSessionMessagingPolicy(config.sessionMessaging.integrationPath);
    const nextPolicy={...policy,
      allowedSenders:[...new Set([...policy.allowedSenders,...(allowedRecipients.some(id=>id.startsWith('session-'))?[senderId]:[])])],
      allowedRecipients:[...new Set([...policy.allowedRecipients,...(allowedSenders.some(id=>id.startsWith('session-'))?[senderId]:[])])],
    };
    // Match the shared policy reader before writing ANY pairing/policy/config.
    // Overfilling one list would otherwise disable unrelated Claude sessions.
    if(nextPolicy.allowedSenders.length>64||nextPolicy.allowedRecipients.length>64)throw coded('grok_policy_capacity','Workspace policy cannot admit another Grok principal');
    writePrivateJson(config.sessionMessaging.integrationPath,nextPolicy);
  }
  writePrivateJson(file,binding);
  writePrivateJson(configPath,{...config,grok:{enabled:true,bindings:[...entries.map(b=>b.file),file]}});
  return {senderId,alias:binding.alias,identityMode:contextDigest?'paired-conversation':'explicit-alias',wakeCapable:false,requiresServiceRestart:true};
}
export function disableGrok(options, configPath) {
  const config = readPrivateJson(configPath), entry = grokBindings(config).find(b=>b.alias === options.alias);
  if (!entry) throw coded('unknown_grok_alias','Unknown Grok alias');
  const {file,...binding} = entry;
  if (binding.enabled || !binding.revoked) writePrivateJson(file,{...binding,enabled:false,revoked:true,generation:binding.generation+1,secret:randomBytes(32).toString('hex')});
  return {senderId:binding.senderId,disabled:true,activeClaims:'preserved; no automatic retry or reassignment'};
}
export function createGrokBroker({config, issue}) {
  const entries = grokBindings(config), byId = new Map(entries.map(b=>[b.senderId,b]));
  const brokers = new Map(entries.map(b=>[b.senderId,createInteractiveSessionBroker({integrationPath:b.file,readIntegration:readGrokBinding,recipients:b.allowedRecipients,issue})]));
  function current(id) {
    const entry = byId.get(id);
    if (!entry) throw coded('unknown_grok_identity','Unknown Grok participant');
    const b = readGrokBinding(entry.file);
    if (b.senderId !== id || b.alias !== entry.alias || b.contextHash !== entry.contextHash || JSON.stringify(b.allowedSenders)!==JSON.stringify(entry.allowedSenders) || JSON.stringify(b.allowedRecipients)!==JSON.stringify(entry.allowedRecipients)) throw coded('binding_changed','Pairing changed; restart required');
    if (!config.grok.enabled || !b.enabled || b.revoked) throw coded('session_disabled','Grok pairing disabled');
    return b;
  }
  return {
    ids:entries.map(b=>b.senderId),
    has:id=>byId.has(id),
    directory:entries.map(b=>({id:b.senderId,label:`Grok · ${b.alias}`,kind:'conversation',harness:'grok',presence:'unknown',capabilities:{queueable:true,wakeCapable:false,pullInbox:true}})),
    allowedRecipients(id){return current(id).allowedRecipients;},
    checkAllowed(sender,to){
      if (byId.has(sender) && !current(sender).allowedRecipients.includes(to)) throw coded('recipient_not_allowed','Grok outgoing grant denies recipient');
      if (byId.has(to) && !current(to).allowedSenders.includes(sender)) throw coded('recipient_not_allowed','Grok incoming grant denies sender');
    },
    async validateRequest(args){current(args.senderId);return brokers.get(args.senderId).validateRequest(args);},
    exchange(request){
      const b = entries.find(b=>b.bindingId === request?.bindingId);
      if (!b) throw coded('unauthorized','Invalid Grok pairing');
      const live = current(b.senderId);
      if (request.contextHash !== live.contextHash) throw coded('unauthorized','Grok context mismatch');
      return brokers.get(b.senderId).exchange(request);
    },
  };
}

export async function runGrokCommand(operation, options, {configPath,env,input,output}) {
  const config = readPrivateJson(configPath), entries = grokBindings(config);
  if (config.enabled !== true || config.grok?.enabled !== true) throw coded('local_disabled','Grok messaging disabled');
  const context = env.CURSOR_CONVERSATION_ID;
  const digest = context === undefined ? null : contextHash(context);
  // Explicit aliases can select a pairing, never override a conflicting context.
  const b = options.alias ? entries.find(b=>b.alias===options.alias) : digest ? entries.find(b=>b.contextHash===digest) : null;
  if (!b || (b.contextHash !== null && b.contextHash !== digest)) throw coded('grok_context_mismatch','Choose your own paired context or explicit alias');
  if (!b.enabled || b.revoked) throw coded('session_disabled','Grok pairing disabled');
  if (!['status','sessions','send','inbox','claim','reply','replies','consume'].includes(operation)) throw coded('invalid_arguments','Unsupported Grok operation');
  const client = createLocalControlClient({socketPath:resolveLocalSocketAddress({stateRoot:config.stateRoot}).socketPath,senderId:b.senderId});
  const messageText = async () => {
    if (options.text !== undefined) throw coded('invalid_arguments','Use stdin or text-file for Grok message bodies');
    let text = '';
    if (options['text-file']) {
      const fd = fs.openSync(options['text-file'],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > 128*1024) throw coded('invalid_message','Bounded message file required');
        text = fs.readFileSync(fd,'utf8');
      } finally {fs.closeSync(fd);}
    } else {
      const chunks=[];let bytes=0;
      for await (const chunk of input) {
        const bytesChunk=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
        bytes+=bytesChunk.length;if(bytes>128*1024)throw coded('invalid_message','Message too large');
        chunks.push(bytesChunk);
      }
      // Decode once: a pipe can split a UTF-8 character between arbitrary reads.
      text=Buffer.concat(chunks,bytes).toString('utf8');
    }
    if (!text.trim() || Buffer.byteLength(text)>128*1024) throw coded('invalid_message','Bounded nonempty text required');
    return text;
  };
  try {
    const grant = await client.exchangeInteractiveSession({bindingId:b.bindingId,sessionId:b.sessionId,generation:b.generation,secret:b.secret,contextHash:b.contextHash});
    if (grant.senderId!==b.senderId || grant.bindingId!==b.bindingId || grant.generation!==b.generation || grant.sessionId!==b.sessionId) throw coded('binding_changed','Unexpected Grok grant');
    const rpc = {credential:grant.credential}; let result;
    if (operation==='status') result = options['message-id'] !== undefined ? await client.getMessageStatus({messageId:options['message-id']},rpc) : await client.localStatus(rpc);
    if (operation==='sessions') result = {sessions:await client.listSessions(rpc)};
    if (operation==='inbox') {const items=await client.listInbox({limit:options.limit===undefined?50:Number(options.limit),cursor:options.cursor},rpc);result={items:[...items],nextCursor:items.nextCursor};}
    if (operation==='send') {
      if (!options['message-id'] || !options['request-id'] || !options.to) throw coded('invalid_arguments','Exact to, stable message-id and request-id required');
      const text=await messageText();
      try {result=await client.sendMessage({to:options.to,text,messageId:options['message-id'],requestId:options['request-id']},rpc);}
      catch(error){const rejected=['recipient_not_allowed','invalid_params','invalid_request','payload_too_large','rate_limit_exceeded','loop_limit_exceeded','session_disabled','session_offline','generation_fenced'].includes(error.code);output.write(JSON.stringify({messageId:options['message-id'],requestId:options['request-id'],state:rejected?'rejected':'send_outcome_unknown',error:error.code||'send_failed'})+'\n');return 1;}
    }
    if (operation==='claim') {
      if (!options['message-id'] || !options['claim-id'] || !options['claim-file']) throw coded('invalid_arguments','Stable message-id, claim-id and private claim-file required');
      // Reserve exclusively BEFORE admission. Concurrent CLI calls must not
      // overwrite a different operation's claim file (or lose its only token).
      const claimFile=options['claim-file'];
      privateDir(path.dirname(claimFile),{create:true});
      privateFile(claimFile);
      let fd;
      try {
        fd=fs.openSync(claimFile,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
        fs.writeFileSync(fd,JSON.stringify({senderId:b.senderId,messageId:options['message-id'],claimId:options['claim-id'],generation:b.generation})+'\n');fs.fsyncSync(fd);
      } catch(error) {if(error.code==='ELOOP')throw coded('unsafe_path','Claim file must not be a symlink');if(error.code!=='EEXIST')throw error;}
      finally {if(fd!==undefined)fs.closeSync(fd);}
      const prior=readPrivateJson(claimFile);
      if (prior.senderId!==b.senderId || prior.messageId!==options['message-id'] || prior.claimId!==options['claim-id'] || prior.generation!==b.generation) throw coded('claim_file_mismatch','Claim file belongs to another operation');
      const claim=await client.claimInboxMessage({messageId:options['message-id'],claimId:options['claim-id']},rpc);
      if (!claim) throw coded('claim_unavailable','Message is not available');
      writePrivateJson(options['claim-file'],{...claim,senderId:b.senderId,sessionId:b.sessionId,generation:b.generation});
      result={messageId:claim.messageId,claimId:claim.claimId,claimed:true,leaseExpiresAt:claim.leaseExpiresAt};
    }
    if (operation==='reply') {
      if (!options['claim-file'] || !options['message-id'] || !options['reply-id']) throw coded('invalid_arguments','Claim file, message-id and stable reply-id required');
      const claim=readPrivateJson(options['claim-file']);
      if (claim.senderId!==b.senderId || claim.messageId!==options['message-id'] || claim.sessionId!==b.sessionId || claim.generation!==b.generation || typeof claim.claimToken!=='string') throw coded('claim_file_mismatch','Claim does not belong to this binding');
      result=await client.sendReply({messageId:claim.messageId,claimToken:claim.claimToken,replyId:options['reply-id'],text:await messageText()},rpc);
    }
    if (operation==='replies') {
      if (!options['request-id'] && !options['in-reply-to']) throw coded('invalid_arguments','Correlate reply retrieval explicitly');
      result={replies:await client.listReplies({requestId:options['request-id'],inReplyTo:options['in-reply-to']},rpc)};
    }
    if (operation==='consume') result=await client.consumeReply({messageId:options['message-id']},rpc);
    output.write(JSON.stringify(result)+'\n');return 0;
  } finally {await client.close();}
}
