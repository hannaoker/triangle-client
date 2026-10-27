import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createLocalReplyRoute } from "../src/local-reply-route-contract.mjs";
import { createLocalReplyRouteStore } from "../src/local-reply-route-store.mjs";

const local = { address: `session-${"a".repeat(64)}`, generation: 1 };
const remote = { address: "b".repeat(64), generation: 1 };
const envelope = { sender: remote.address, recipient: local.address, recipientType: "interactive", messageId: "m1", requestId: "r1", text: "request" };

test("real journal atomically admits request+pin and reply+generation, including rollback and reopen", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r2-journal-"));
  fs.chmodSync(root, 0o700);
  let journal;
  t.after(() => { journal?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const open = () => createLocalMessagingJournal({ stateRoot: root, replyRouteStoreFactory: createLocalReplyRouteStore });
  journal = open();
  const control = new DatabaseSync(path.join(root, "local-messaging.sqlite"));
  t.after(() => control.close());
  for (const [id,child] of [[local.address,"child-local"],[remote.address,"child-remote"]]) {
    control.prepare("INSERT INTO local_discovered_sessions(id,installation_id,workspace,session_id,lifecycle,generation,event_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)").run(id,"scope",root,"hash","observed",1,Date.now(),Date.now());
    await journal.attachDiscoveredSession({id,childId:child,generation:1,installationId:"scope",wakeCapable:false});
  }
  const pin = createLocalReplyRoute({ requestId: envelope.requestId, local, remote });
  await journal.recordSend(envelope, { replyRoute: pin, replySenderBindingId: "child-remote" });
  assert.deepEqual(await journal.getReplyRouteForMessage("m1"), pin);
  assert.equal((await journal.recordSend(envelope, { replyRoute: pin, replySenderBindingId: "child-remote" })).isDuplicate, true);
  assert.ok(!Object.hasOwn(await journal.getRecord("m1"), "reply_route_key"));
  // Same sender/request cannot silently move its responder to another chat.
  const different = { ...local, address: `session-${"c".repeat(64)}` };
  control.prepare("INSERT INTO local_discovered_sessions(id,installation_id,workspace,session_id,lifecycle,generation,event_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)").run(different.address,"scope",root,"other-hash","observed",1,Date.now(),Date.now());
  await journal.attachDiscoveredSession({id:different.address,childId:"other-child",generation:1,installationId:"scope",wakeCapable:false});
  await assert.rejects(journal.recordSend({ ...envelope, messageId: "conflict", recipient: different.address }, { replyRoute: createLocalReplyRoute({ requestId: "r1", local: different, remote }), replySenderBindingId: "child-remote" }), { code: "reply_route_conflict" });
  assert.equal(await journal.getRecord("conflict"), null);
  journal.close(); journal = open();
  assert.deepEqual(await journal.getReplyRouteForMessage("m1"), pin);
  const claim = await journal.claimInboxMessage({ messageId: "m1", requester: local.address, sessionId: "same-session", generation: 1, claimId: "claim1" });
  const renewed = { ...local, generation: 2 };
  control.prepare("UPDATE local_discovered_sessions SET generation=2 WHERE id=?").run(local.address);
  await journal.detachDiscoveredSession({id:local.address,childId:"child-local"});
  await journal.attachDiscoveredSession({id:local.address,childId:"child-local-2",generation:2,installationId:"scope",wakeCapable:false});
  const reply = { messageId: "m1", requester: local.address, sessionId: "same-session", generation: 2, claimToken: claim.claimToken, text: "result", replyId: "reply1", replyIdentity: { local: renewed, remote, bindingId: "child-local-2" } };
  await assert.rejects(journal.recordInteractiveReply({ ...reply, replyIdentity: null }), { code: "reply_route_unavailable" });
  await assert.rejects(journal.recordInteractiveReply({ ...reply, generation: 1 }), { code: "session_fenced" });
  await assert.rejects(journal.recordInteractiveReply({ ...reply, replyIdentity: { local: { ...different, generation: 2 }, remote, bindingId: "child-local-2" } }), { code: "reply_session_mismatch" });
  const inject = new DatabaseSync(path.join(root, "local-messaging.sqlite"));
  inject.exec("CREATE TRIGGER fail_reply BEFORE INSERT ON local_replies BEGIN SELECT RAISE(ABORT, 'controlled insert failure'); END");
  await assert.rejects(journal.recordInteractiveReply(reply), /controlled insert failure/);
  assert.equal((await journal.getReplyRouteForMessage("m1")).local.generation, 1);
  assert.equal((await journal.getRecord("m1")).phase, "executing");
  assert.equal((await journal.listReplies({ requester: remote.address })).length, 0);
  inject.exec("DROP TRIGGER fail_reply"); inject.close();
  const result = await journal.recordInteractiveReply(reply);
  assert.equal(result.text, "result");
  assert.equal((await journal.getReplyRouteForMessage("m1")).local.generation, 2);
  assert.equal((await journal.recordInteractiveReply(reply)).isDuplicate, true);
  journal.close(); journal = open();
  assert.equal((await journal.getRecord("m1")).phase, "completed");
  assert.equal((await journal.getReplyRouteForMessage("m1")).local.generation, 2);
  assert.equal((await journal.listReplies({ requester: remote.address })).length, 1);
});

test("pinned work fails closed without store, while old unpinned admission remains compatible", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "r2-journal-off-"));fs.chmodSync(root,0o700);
  let j=createLocalMessagingJournal({stateRoot:root,replyRouteStoreFactory:createLocalReplyRouteStore});
  t.after(()=>{j?.close();fs.rmSync(root,{recursive:true,force:true});});
  const control=new DatabaseSync(path.join(root,"local-messaging.sqlite"));
  for(const id of [local.address,remote.address]){
    control.prepare("INSERT INTO local_discovered_sessions(id,installation_id,workspace,session_id,lifecycle,generation,event_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)").run(id,"scope",root,"hash","observed",1,Date.now(),Date.now());
    await j.attachDiscoveredSession({id,childId:"child",generation:1,installationId:"scope",wakeCapable:false});
  }
  control.close();
  await j.recordSend(envelope,{replySenderBindingId:"child",replyRoute:createLocalReplyRoute({requestId:"r1",local,remote})});
  j.close();j=createLocalMessagingJournal({stateRoot:root});
  await assert.rejects(j.getReplyRouteForMessage("m1"),{code:"reply_route_unavailable"});
  const legacy={...envelope,messageId:"legacy",requestId:"legacy"};
  assert.equal((await j.recordSend(legacy)).isDuplicate,false);
  assert.equal(await j.getReplyRouteForMessage("legacy"),null);
});
