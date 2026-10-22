import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';
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
  if(binding.instanceId!==integration.senderId)throw coded('binding_changed','Desktop identity changed; run explicit owner binding setup');
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
