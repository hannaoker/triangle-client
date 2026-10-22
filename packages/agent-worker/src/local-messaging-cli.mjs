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
import {coded} from './local-messaging-errors.mjs';

export function defaultLocalConfigPath(env=process.env){return path.join(env.HOME||os.homedir(),'Library/Application Support/The Triangle/client/local-messaging.json');}
function parse(argv){
 const args=[...argv],command=args.shift()||'help',options={};
 const flags=new Set(['config','thread-id','desktop-binding','recipient','state-root','text','text-file','to','message-id','request-id','in-reply-to','wait-ms']);
 while(args.length){const flag=args.shift();if(flag==='--rebind-thread'){options.rebind=true;continue;}if(!flag.startsWith('--')||!flags.has(flag.slice(2))||!args.length)throw coded('invalid_arguments','Unknown argument or missing value');const key=flag.slice(2),value=args.shift();if(key==='recipient')(options.recipients??=[]).push(value);else {if(options[key]!==undefined)throw coded('invalid_arguments','Duplicate argument');options[key]=value;}}
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
 let secret=randomBytes(32).toString('hex');
 if(fs.existsSync(integrationPath)){
  const existing=readPrivateJson(integrationPath);
  // The desktop thread lives only in the integration file; moving it is an explicit owner action that rotates the capability.
  if(existing.threadId!==threadId&&!options.rebind)throw coded('binding_changed','Explicit --rebind-thread is required to change the desktop thread');
  if(existing.senderId===senderId&&existing.threadId===threadId)secret=existing.secret;
 }
 writePrivateJson(integrationPath,{version:1,bindingId:createHash('sha256').update(senderId+'\0'+threadId).digest('hex').slice(0,32),senderId,threadId,secret});
 writePrivateJson(configPath,{version:1,enabled:true,stateRoot,bindingPath,integrationPath,recipients,runnerTimeoutMs:3600000});
 return {configPath,senderId,threadId,recipients,requiresServiceRestart:true};
}
export async function runLocalMessagingCLI(argv,{env=process.env,input=process.stdin,output=process.stdout}={}){
 const {command,options}=parse(argv);
 if(command==='help'||command==='--help'){output.write('triangle-local: setup, status, discover, send, replies, consume, mcp\n');return 0;}
 if(command==='setup'){output.write(JSON.stringify(setupLocalMessaging(options,env))+'\n');return 0;}
 if(!['status','discover','send','replies','consume','mcp'].includes(command))throw coded('invalid_arguments','Unknown command');
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
  if(command==='discover')result={senderId:binding.senderId,threadId:binding.threadId,recipients:await client.discoverRecipients(rpcOptions)};
  if(command==='replies')result={senderId:binding.senderId,replies:await client.listReplies({requestId:options['request-id'],inReplyTo:options['in-reply-to']},rpcOptions)};
  if(command==='consume')result=await client.consumeReply({messageId:options['message-id']},rpcOptions);
  if(command==='send'){
   const to=config.recipients.find(r=>r.profile===options.to||r.instanceId===options.to)?.instanceId;
   if(!to)throw coded('recipient_not_allowed','Choose an explicitly configured recipient');
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
