// AD.1: the installed owner CLI and owner-set aliases (docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md, 3.7).
// `send --to NAME` maps a profile name locally first, as it always did. An alias-shaped name that no local map claims is used only
// if discovery lists it for this sender (one discovery round trip); any other name is refused by the CLI as before, and a name that
// cannot be an alias is refused without asking the server at all.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setupLocalMessaging} from '../src/local-messaging-cli.mjs';
import {readPrivateJson,writePrivateJson,createDesktopCredentialBroker} from '../src/local-messaging-auth-broker.mjs';
import {createLocalMessagingSubsystem} from '../src/local-messaging-supervisor-seam.mjs';
import {createOwnerAcl} from '../src/local-messaging-acl.mjs';
import {readIdentityRegistry,setIdentityAlias,updateIdentityRegistry} from '../src/identity-registry.mjs';
import {deriveClientInstanceId} from '../src/identity-primitives.mjs';
import {createTestMemoryJournal,createTestRecoverableDispatcher} from './local-messaging-fixtures.mjs';
import {createInstalledLocalMessagingHost} from '../src/local-messaging-host.mjs';
import {createProfiledReasonerGate} from '../src/concurrency-gate.mjs';
import {createLocalMessagingJournal} from '../src/local-messaging-journal.mjs';
import {upgradeThroughWriter} from './identity-registry-v2-helpers.mjs';

const exec=promisify(execFile),cli=fileURLToPath(new URL('../src/local-messaging-cli.mjs',import.meta.url));

function binding(profile,instance,principal){
 return {schema:'local_profile_binding_v1',binding_id:'bind_'+principal.slice(-32),trust_mode:'mesh-managed',principal_id:principal,profile_name:profile,profile_instance_id:instance,authority_origin:'https://example.test',binding_generation:1,issued_at:'2026-10-26T00:00:00.000Z',revoked_at:null,proof:{kind:'disk_observation',observed_on_disk:true,verified_live_authority:false}};
}

test('installed CLI send uses an owner-set alias only when discovery lists it, and refuses every other name as it always did',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-alias-cli-');fs.chmodSync(root,0o700);let subsystem;
 try {
  const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'old',enabled:false});
  setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'test-thread',recipients:['gravity2']});
  const config=readPrivateJson(configPath),integration=readPrivateJson(config.integrationPath),recipient=config.recipients[0].instanceId;
  const registryRoot=path.join(root,'identity'),principal='agent_'+'b'.repeat(32),elsewhere='agent_'+'c'.repeat(32),elsewhereInstance=deriveClientInstanceId('elsewhere');
  updateIdentityRegistry({root:registryRoot,expectedSequence:0,action:'init',subject:null,mutate:r=>r});
  updateIdentityRegistry({root:registryRoot,expectedSequence:1,action:'bind',subject:recipient,mutate:r=>{r.bindings[recipient]=binding('gravity2',recipient,principal);return r;}});
  updateIdentityRegistry({root:registryRoot,expectedSequence:2,action:'bind',subject:elsewhereInstance,mutate:r=>{r.bindings[elsewhereInstance]=binding('elsewhere',elsewhereInstance,elsewhere);return r;}});
  upgradeThroughWriter(registryRoot,{now:new Date().toISOString()});
  const setAlias=(alias,principalId)=>setIdentityAlias({root:registryRoot,expectedSequence:readIdentityRegistry({root:registryRoot}).registry.sequence,alias,principalId});
  setAlias('builder',principal);
  setAlias('faraway',elsewhere); // bound, but its profile is not a local recipient
  writePrivateJson(path.join(config.stateRoot,'router.json'),{version:1,enabled:true,registryRoot});
  const journal=createTestMemoryJournal(),dispatcher=createTestRecoverableDispatcher({journal});
  // the owner's access list is asked once per discovery, so it counts the round trips the CLI makes to list recipients
  const baseAcl=createOwnerAcl({rules:{[integration.senderId]:[recipient]}});let discoveries=0;
  const ownerAcl={isAllowed:(s,r)=>baseAcl.isAllowed(s,r),checkAllowed:(s,r)=>baseAcl.checkAllowed(s,r),listAuthorizedRecipients:s=>{discoveries+=1;return baseAcl.listAuthorizedRecipients(s);}};
  const broker=createDesktopCredentialBroker({...config,recipients:[recipient],issue:(sender,options)=>subsystem.issueTurnCredential(sender,options)});
  subsystem=createLocalMessagingSubsystem({stateRoot:config.stateRoot,journal,dispatcher,registry:[integration.senderId,recipient],recipientDirectory:[{id:recipient,label:'gravity2',kind:'worker'}],ownerAcl,credentialBroker:params=>({credential:broker.exchange(params),senderId:broker.senderId,threadId:broker.threadId})});
  await subsystem.start();
  const send=(to,id)=>exec(process.execPath,[cli,'send','--config',configPath,'--to',to,'--text','canary','--message-id',id,'--request-id',id]);

  // discovery lists the alias for this sender, so the CLI sends by it and the server resolves it
  const discovered=JSON.parse((await exec(process.execPath,[cli,'discover','--config',configPath])).stdout);
  assert.deepEqual(discovered.entries.find(entry=>entry.id===recipient).send.aliases,['builder']);
  let asked=discoveries;
  const viaAlias=JSON.parse((await send('builder','cli-alias')).stdout);
  assert.equal(discoveries-asked,1,'one discovery to learn the name is an alias');
  assert.equal(viaAlias.admission.accepted,true);assert.equal(viaAlias.admission.target.principal,principal);assert.equal(viaAlias.admission.route,'local');

  // a profile name is still mapped locally, first
  asked=discoveries;
  const viaProfile=JSON.parse((await send('gravity2','cli-profile')).stdout);
  assert.equal(viaProfile.admission.target.profile,'gravity2');
  assert.equal(discoveries-asked,0,'a profile name is mapped locally, without asking the server');

  // a name discovery does not list is refused by the CLI as before: an alias to a recipient that is not local, and a name nobody set
  // (a name that could be an alias costs one discovery; a name that cannot be one costs none)
  for(const [name,roundTrips] of [['faraway',1],['nobody',1],['Builder',0],['x'.repeat(33),0],['has space',0]]){
   asked=discoveries;
   await assert.rejects(send(name,'cli-'+name.toLowerCase().replace(/[^a-z0-9]/g,'-')),error=>{
    assert.equal(error.code,1,name);
    assert.equal(error.stdout,'',name+': refused before any send, so no send result (and no "outcome unknown") is printed');
    assert.equal(JSON.parse(error.stderr).error,'recipient_not_allowed',name);
    return true;
   });
   assert.equal(discoveries-asked,roundTrips,name+': round trips to the server');
  }

  // Checking several enabled harnesses for one unknown session needs one directory read.
  writePrivateJson(configPath, {
    ...config, sessionMessaging: { enabled: true }, grok: { enabled: true }, antigravity: { enabled: true },
  });
  asked = discoveries;
  await assert.rejects(send('session-' + '9'.repeat(64), 'unknown-session'), error => {
    assert.equal(JSON.parse(error.stderr).error, 'recipient_not_allowed');
    assert.equal(error.stdout, '');
    return true;
  });
  assert.equal(discoveries - asked, 1);
 }finally{await subsystem?.stop();fs.rmSync(root,{recursive:true,force:true});}
});

// An alias or a principal resolves to the agent first, so an agent that is not running is refused under every name, as by profile.
test('installed host: a send by alias or principal to an agent that is not running is refused like a send by profile, and nothing is recorded',async()=>{
 const root=fs.mkdtempSync('/private/tmp/tri-alias-off-');fs.chmodSync(root,0o700);let host;
 try {
  const configPath=path.join(root,'local.json'),bindingPath=path.join(root,'binding.json');
  writePrivateJson(bindingPath,{instanceId:'a'.repeat(64),threadId:'old',enabled:false});
  setupLocalMessaging({config:configPath,'desktop-binding':bindingPath,'thread-id':'test-thread',recipients:['gravity2']});
  const config=readPrivateJson(configPath),recipient=config.recipients[0].instanceId;
  const registryRoot=path.join(root,'identity'),principal='agent_'+'b'.repeat(32);
  updateIdentityRegistry({root:registryRoot,expectedSequence:0,action:'init',subject:null,mutate:r=>r});
  updateIdentityRegistry({root:registryRoot,expectedSequence:1,action:'bind',subject:recipient,mutate:r=>{r.bindings[recipient]=binding('gravity2',recipient,principal);return r;}});
  upgradeThroughWriter(registryRoot,{now:new Date().toISOString()});
  setIdentityAlias({root:registryRoot,expectedSequence:readIdentityRegistry({root:registryRoot}).registry.sequence,alias:'gemini',principalId:principal});
  writePrivateJson(path.join(config.stateRoot,'router.json'),{version:1,enabled:true,registryRoot});
  host=createInstalledLocalMessagingHost({configPath,runners:new Map(),gate:createProfiledReasonerGate()});
  await host.start();
  for(const [form,to] of [['profile','gravity2'],['alias','gemini'],['principal',principal]]){
   await assert.rejects(exec(process.execPath,[cli,'send','--config',configPath,'--to',to,'--text','new work','--message-id','off-'+form,'--request-id','off-'+form]),
    error=>{assert.equal(JSON.parse(error.stdout).error,'local_recipient_unavailable',form);return true;});
  }
  await host.stop();host=null;
  const journal=createLocalMessagingJournal({stateRoot:config.stateRoot});
  try{for(const form of ['profile','alias','principal'])assert.equal(await journal.getRecord('off-'+form),null,form+': nothing was recorded');}
  finally{await journal.close();}
 }finally{await host?.stop();fs.rmSync(root,{recursive:true,force:true});}
});
