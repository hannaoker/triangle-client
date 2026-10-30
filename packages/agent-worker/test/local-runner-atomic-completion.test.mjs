import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createLocalMessagingJournal} from '../src/local-messaging-journal.mjs';
import {createLocalMessagingDispatcher} from '../src/local-messaging-dispatcher.mjs';
import {waitFor} from './local-messaging-fixtures.mjs';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const temporary=()=>fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'triangle-atomic-'));
const request={sender:'owner',recipient:'runner',messageId:'task',requestId:'request',text:'data'};
const reply={sender:'runner',recipient:'owner',messageId:'reply',requestId:'request',inReplyTo:'task',text:'result',metadata:{_loopDepth:2}};

test('runner reply and completion commit together, exact retries stay singular, conflicts write nothing',async()=>{
 const root=temporary();let j;
 try{
  j=createLocalMessagingJournal({stateRoot:root});await j.recordSend(request);await j.claimExecution('task');
  const result=await j.completeExecutionWithReply(reply);assert.equal(result.isDuplicate,false);assert.equal((await j.getRecord('task')).phase,'completed');
  assert.equal((await j.completeExecutionWithReply(reply)).isDuplicate,true);
  await assert.rejects(j.completeExecutionWithReply({...reply,messageId:'different-reply'}),{code:'duplicate_id_conflict'});
  await assert.rejects(j.completeExecutionWithReply({...reply,text:'conflict'}),{code:'duplicate_id_conflict'});
  assert.equal((await j.listReplies({requester:'owner'})).length,1);
  await j.close();j=createLocalMessagingJournal({stateRoot:root});assert.equal((await j.getRecord('task')).phase,'completed');assert.equal((await j.recoverQueued()).toRun.length,0);assert.equal(await j.claimExecution('task'),null);
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('atomic runner completion cannot bypass held work, interactive claims, or reply correlation',async()=>{
 const root=temporary();let j;
 try{
  j=createLocalMessagingJournal({stateRoot:root});await j.recordSend(request);await j.claimExecution('task');
  await assert.rejects(j.completeExecutionWithReply({...reply,recipient:'foreign'}),{code:'invalid_reply_recipient'});
  assert.equal((await j.getRecord('task')).phase,'executing');assert.equal((await j.listReplies({requester:'owner'})).length,0);
  await j.holdExecution('task','runner_timeout');await assert.rejects(j.completeExecutionWithReply(reply),{code:'execution_not_active'});
  await j.recordSend({...request,messageId:'chat',requestId:'chat',recipientType:'interactive'});
  await assert.rejects(j.completeExecutionWithReply({...reply,inReplyTo:'chat',requestId:'chat'}),{code:'invalid_recipient_type'});
  assert.equal((await j.listReplies({requester:'owner'})).length,0);
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('a failed completion update rolls back the reply before dispatcher holds the request',async()=>{
 const root=temporary();let j,d;
 try{
  j=createLocalMessagingJournal({stateRoot:root});await j.recordSend(request);
  const db=new DatabaseSync(path.join(root,'local-messaging.sqlite'));
  db.exec("CREATE TRIGGER fail_completion BEFORE UPDATE ON local_messages WHEN NEW.phase='completed' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END");db.close();
  let calls=0;d=createLocalMessagingDispatcher({journal:j,logger:{error(){}},runRecipient:async()=>{calls++;return {status:'completed',text:'result'};}});await d.start();
  await waitFor(async()=>(await j.getRecord('task')).phase==='held');await d.stop();
  assert.equal((await j.getRecord('task')).reason,'persistence_failure');assert.equal((await j.listReplies({requester:'owner'})).length,0);assert.equal(calls,1);
  await j.close();j=createLocalMessagingJournal({stateRoot:root});assert.equal((await j.getRecord('task')).phase,'held');assert.equal((await j.recoverQueued()).toRun.length,0);
 }finally{await d?.stop();await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

for(const mode of ['before','after'])test('hard crash '+mode+' commit never exposes an orphan reply or replays work',async()=>{
 const root=temporary();let j;
 try{
  const moduleUrl=new URL('../src/local-messaging-journal.mjs',import.meta.url).href;
  const code=`import fs from 'node:fs';import {createRequire} from 'node:module';import {createLocalMessagingJournal} from ${JSON.stringify(moduleUrl)};
   const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
   const j=createLocalMessagingJournal({stateRoot:process.argv[1]});await j.recordSend(${JSON.stringify(request)});await j.claimExecution('task');
   const original=DatabaseSync.prototype.exec;
   DatabaseSync.prototype.exec=function(sql){if(sql.trim()==='COMMIT'){if(process.argv[2]==='before'){fs.writeSync(1,'before_commit\\n');process.kill(process.pid,'SIGKILL');}const result=original.call(this,sql);fs.writeSync(1,'after_commit\\n');process.kill(process.pid,'SIGKILL');return result;}return original.call(this,sql);};
   await j.completeExecutionWithReply(${JSON.stringify(reply)});throw new Error('Crash injection was not reached');`;
  const outcome=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code,root,mode],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('error',reject);p.once('exit',(code,signal)=>resolve({code,signal,out,err}));});
  assert.equal(outcome.out,mode+'_commit\n',outcome.err);assert.equal(outcome.signal,'SIGKILL',outcome.err);
  j=createLocalMessagingJournal({stateRoot:root});const row=await j.getRecord('task'),replies=await j.listReplies({requester:'owner'});
  assert.equal(row.phase,mode==='before'?'held':'completed');assert.equal(replies.length,mode==='before'?0:1);if(mode==='before')assert.equal(row.reason,'crash_recovery');
  assert.equal((await j.recoverQueued()).toRun.length,0);assert.equal(await j.claimExecution('task'),null);
 }finally{await j?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('dispatcher rejects a non-atomic backend instead of falling back to separate writes',async()=>{
 assert.throws(()=>createLocalMessagingDispatcher({journal:{},runRecipient:async()=>{}}),{code:'invalid_dispatcher_options'});
 const root=temporary();const j=createLocalMessagingJournal({stateRoot:root});
 try{const d=createLocalMessagingDispatcher({journal:j,runRecipient:async()=>{}});await assert.rejects(d.start({journal:{}}),{code:'invalid_dispatcher_options'});}finally{await j.close();fs.rmSync(root,{recursive:true,force:true});}
});
