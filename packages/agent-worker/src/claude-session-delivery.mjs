/**
 * Unsupported, version-pinned Claude inbox transport. Run only inside the MCP
 * child belonging to the session that exported these variables. No registry or
 * token-file discovery. A completed write is NOT proof of session delivery.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {coded} from './local-messaging-errors.mjs';
import {validateSnapshot,formatNotificationTemplate,UUID_REGEX} from './codex-wake-adapter.mjs';

export const SUPPORTED_CLAUDE_VERSION='2.1.307';
export const MAX_TIMEOUT_MS=15000;
export const MAX_FRAME_BYTES=8192;
const ENV_KEYS=['CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN'];
function fail(code){throw coded(code,code.replaceAll('_',' '));}
function canonicalSocketPath(socketPath){
 if(typeof socketPath!=='string'||!path.isAbsolute(socketPath)||socketPath.includes('\0'))fail('unsafe_claude_socket');
 let normalized=socketPath;
 const systemAlias=process.platform==='darwin'?['/var','/tmp'].find(prefix=>socketPath.startsWith(prefix+'/')):null;
 if(systemAlias){
  // Only Apple's fixed root-owned aliases are admitted. Descendants must be
  // canonical, and the socket's immediate parent must still be private/owned.
  const target='/private'+systemAlias;
  const alias=fs.lstatSync(systemAlias);
  if(!alias.isSymbolicLink()||alias.uid!==0||path.resolve('/',fs.readlinkSync(systemAlias))!==target)fail('unsafe_claude_socket');
  for(const directory of ['/','/private',target]){
   const st=fs.lstatSync(directory);
   const trustedTmp=directory==='/private/tmp'&&(st.mode&0o1777)===0o1777;
   if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||((st.mode&0o022)!==0&&!trustedTmp))fail('unsafe_claude_socket');
  }
  normalized=target+socketPath.slice(systemAlias.length);
 }
 if(fs.realpathSync(normalized)!==normalized)fail('unsafe_claude_socket');
 return normalized;
}
function inspectSocket(exportedPath){
 try {
  const socketPath=canonicalSocketPath(exportedPath);
  const parentPath=path.dirname(socketPath);
  const parentFd=fs.openSync(parentPath,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  let parent;try{parent=fs.fstatSync(parentFd)}finally{fs.closeSync(parentFd)}
  const st=fs.lstatSync(socketPath);
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||(parent.mode&0o077)!==0||!st.isSocket()||st.isSymbolicLink()||st.uid!==process.getuid())fail('unsafe_claude_socket');
  return {path:socketPath,dev:st.dev,ino:st.ino,parentDev:parent.dev,parentIno:parent.ino};
 } catch {fail('unsafe_claude_socket');}
}
function capture(env,version){
 if(version!==SUPPORTED_CLAUDE_VERSION)fail('unsupported_claude_version');
 const values=ENV_KEYS.map(k=>env[k]);const [sessionId,socketPath,token]=values;
 if(typeof sessionId!=='string'||!UUID_REGEX.test(sessionId))fail('missing_claude_session');
 if(typeof token!=='string'||!token||Buffer.byteLength(token)>4096||/[\r\n\0]/.test(token))fail('missing_claude_token');
 const socket=inspectSocket(socketPath);
 return {sessionId,socketPath:socket.path,token,values,socket};
}
function capability(sessionId){return Object.freeze({supported:true,mode:'claude-session-socket',supportStatus:'unsupported-internal',version:SUPPORTED_CLAUDE_VERSION,sessionId,deliveryConfirmation:false});}
export function probeClaudeSession({env=process.env,version}={}){
 try{return capability(capture(env,version).sessionId)}catch(error){return Object.freeze({supported:false,mode:'pull',supportStatus:'unsupported-internal',reason:error.code??'claude_capability_unavailable'})}
}
export function createClaudeSessionDelivery({env=process.env,version,connect=options=>net.createConnection(options)}={}){
 const captured=capture(env,version);let active=false;
 function verifySession(expected){
  if(expected!==captured.sessionId)fail('foreign_claude_session');
  if(ENV_KEYS.some((k,i)=>env[k]!==captured.values[i]))fail('claude_session_changed');
  let now;try{now=inspectSocket(captured.values[1])}catch{fail('claude_socket_changed')}
  if(now.path!==captured.socketPath||now.dev!==captured.socket.dev||now.ino!==captured.socket.ino||now.parentDev!==captured.socket.parentDev||now.parentIno!==captured.socket.parentIno)fail('claude_socket_changed');
 }
 async function notify(binding,snapshot,{signal,timeoutMs=5000}={}){
  if(active)fail('claude_delivery_busy');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>MAX_TIMEOUT_MS)fail('invalid_claude_timeout');
  if(!binding||Object.keys(binding).some(k=>!['sessionId','generation'].includes(k))||!Number.isSafeInteger(binding.generation)||binding.generation<1)fail('invalid_claude_binding');
  verifySession(binding.sessionId);
  const safeSnapshot=validateSnapshot(snapshot);
  const text=formatNotificationTemplate({generation:binding.generation},safeSnapshot);
  const frames=JSON.stringify({type:'auth',token:captured.token})+'\n'+JSON.stringify({type:'user',message:{role:'user',content:text}})+'\n';
  if(Buffer.byteLength(frames)>MAX_FRAME_BYTES)fail('claude_frame_too_large');
  if(signal?.aborted)return {state:'not_sent',reason:'aborted'};
  active=true;
  try {
   return await new Promise(resolve=>{
    let socket,timer,outcome,settled=false,wrote=false;
    const close=()=>{if(settled||!outcome)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);resolve(outcome)};
    const finish=result=>{if(outcome)return;outcome=result;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(socket){socket.destroy();}else close()};
    const failure=reason=>finish({state:wrote?'uncertain':'not_sent',reason});
    const onAbort=()=>failure('aborted');
    timer=setTimeout(()=>failure('timeout'),timeoutMs);
    try {
     socket=connect({path:captured.socketPath});
     socket.once('close',()=>{if(!outcome)outcome={state:wrote?'uncertain':'not_sent',reason:'disconnected'};close()});
     socket.on('error',()=>failure('socket_error'));
     socket.once('connect',()=>{
      if(outcome)return;
      try{verifySession(binding.sessionId)}catch{failure('claude_session_changed');return}
      // Set before write: a synchronous throw cannot establish that no bytes escaped.
      wrote=true;
      try{socket.write(frames,error=>{if(error)failure('socket_error');else finish({state:'write_accepted',delivery:'unconfirmed',sessionId:captured.sessionId,wakeId:safeSnapshot.wakeId})})}catch{failure('socket_error')}
     });
     signal?.addEventListener('abort',onAbort,{once:true});
     if(signal?.aborted)onAbort();
    }catch{failure('socket_error')}
   });
  }finally{active=false}
 }
 return Object.freeze({capability:capability(captured.sessionId),notify});
}
