import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setupReplyIdentity} from '../src/local-messaging-cli.mjs';
import {writePrivateJson,readPrivateJson} from '../src/local-messaging-auth-broker.mjs';

test('reply identity setup requires upgraded runtime and preserves floor when disabled',t=>{
 const root=fs.mkdtempSync('/private/tmp/r2-setup-');fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const config=path.join(root,'client/local-messaging.json'),manifest=path.join(root,'worker-runtime/supervisor.manifest.json');
 writePrivateJson(config,{version:1,enabled:true});writePrivateJson(manifest,{version:13});
 const options={config,enable:true};
 assert.throws(()=>setupReplyIdentity(options),{code:'runtime_upgrade_required'});
 assert.equal(fs.existsSync(path.join(root,'client/reply-identity.json')),false);
 writePrivateJson(manifest,{version:14});
 const result=setupReplyIdentity(options);assert.equal(result.replyIdentityEnabled,true);
 assert.equal(fs.statSync(result.policyPath).mode&0o777,0o600);
 assert.deepEqual(readPrivateJson(result.policyPath),{version:1,enabled:true});
 assert.equal(setupReplyIdentity({config,disable:true}).minimumRuntime,14);
 assert.deepEqual(readPrivateJson(result.policyPath),{version:1,enabled:false});
 assert.throws(()=>setupReplyIdentity({config,enable:true,disable:true}),{code:'invalid_arguments'});
});
