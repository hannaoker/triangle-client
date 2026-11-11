// AD.1: the installed owner CLI and owner-set aliases (docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md, 3.7).
// `send --to NAME` maps a profile name locally first, as it always did. An alias-shaped name that no local map claims is used only
// if discovery lists it for this sender; any other name is refused by the CLI as before, without a round trip to the server.
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
import {readIdentityRegistry,setIdentityAlias,updateIdentityRegistry} from '../src/identity-registry.mjs';
import {deriveClientInstanceId} from '../src/identity-primitives.mjs';
import {createTestMemoryJournal,createTestRecoverableDispatcher} from './local-messaging-fixtures.mjs';
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
  const broker=createDesktopCredentialBroker({...config,recipients:[recipient],issue:(sender,options)=>subsystem.issueTurnCredential(sender,options)});
  subsystem=createLocalMessagingSubsystem({stateRoot:config.stateRoot,journal,dispatcher,registry:[integration.senderId,recipient],recipientDirectory:[{id:recipient,label:'gravity2',kind:'worker'}],aclRules:{[integration.senderId]:[recipient]},credentialBroker:params=>({credential:broker.exchange(params),senderId:broker.senderId,threadId:broker.threadId})});
  await subsystem.start();
  const send=(to,id)=>exec(process.execPath,[cli,'send','--config',configPath,'--to',to,'--text','canary','--message-id',id,'--request-id',id]);

  // discovery lists the alias for this sender, so the CLI sends by it and the server resolves it
  const discovered=JSON.parse((await exec(process.execPath,[cli,'discover','--config',configPath])).stdout);
  assert.deepEqual(discovered.entries.find(entry=>entry.id===recipient).send.aliases,['builder']);
  const viaAlias=JSON.parse((await send('builder','cli-alias')).stdout);
  assert.equal(viaAlias.admission.accepted,true);assert.equal(viaAlias.admission.target.principal,principal);assert.equal(viaAlias.admission.route,'local');

  // a profile name is still mapped locally, first
  const viaProfile=JSON.parse((await send('gravity2','cli-profile')).stdout);
  assert.equal(viaProfile.admission.target.profile,'gravity2');

  // a name discovery does not list is refused by the CLI as before: an alias to a recipient that is not local, and a name nobody set
  for(const name of ['faraway','nobody','Builder']){
   await assert.rejects(send(name,'cli-'+name.toLowerCase()),error=>{
    assert.equal(error.code,1,name);
    assert.equal(error.stdout,'',name+': refused before any send, so no send result (and no "outcome unknown") is printed');
    assert.equal(JSON.parse(error.stderr).error,'recipient_not_allowed',name);
    return true;
   });
  }
 }finally{await subsystem?.stop();fs.rmSync(root,{recursive:true,force:true});}
});
