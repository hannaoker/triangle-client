import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLocalMessagingJournal } from "../src/local-messaging-journal.mjs";
import { createLocalMessagingDispatcher } from "../src/local-messaging-dispatcher.mjs";
import { waitFor } from "./local-messaging-fixtures.mjs";

function createIsolatedStateRoot(prefix = "triangle-dispatcher-test-") {
  const realTmp = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(realTmp, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

test("dispatcher recovers queued work without blocking startup on the full model turn", async () => {
  const stateRoot = createIsolatedStateRoot();
  const journal = createLocalMessagingJournal({ stateRoot });
  let runnerStarted = false;
  let runnerFinishResolve;
  const runnerFinishPromise = new Promise((resolve) => {
    runnerFinishResolve = resolve;
  });

  try {
    // Populate journal with a queued message
    await journal.recordSend({
      sender: "sender-a",
      recipient: "recipient-1",
      messageId: "msg-queued-startup",
      requestId: "req-q-1",
      text: "queued request",
    });

    const runRecipient = async (job, { onStarted }) => {
      onStarted();
      runnerStarted = true;
      await runnerFinishPromise;
      return { status: "completed", text: "recovered reply" };
    };

    const dispatcher = createLocalMessagingDispatcher({
      journal,
      runRecipient,
      maxConcurrent: 2,
    });

    // Start must return promptly even though model turn is long-running
    let startReturned = false;
    const startPromise = dispatcher.start().then(() => {
      startReturned = true;
    });

    await startPromise;
    assert.equal(startReturned, true, "start() must return promptly and not block on model turn");

    // Wait for the queued job to be picked up
    for (let i = 0; i < 50 && !runnerStarted; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(runnerStarted, true, "queued job must start executing");

    // Finish runner
    runnerFinishResolve();
    await dispatcher.stop();

    // Verify reply was persisted and execution completed
    const record = await journal.getRecord("msg-queued-startup");
    assert.equal(record.phase, "completed");
    const replies = await journal.listReplies({ requester: "sender-a", requestId: "req-q-1" });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, "recovered reply");
    assert.equal(replies[0].inReplyTo, "msg-queued-startup");
  } finally {
    runnerFinishResolve?.();
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("uncertain started executions are held on startup without replay", async () => {
  const stateRoot = createIsolatedStateRoot();
  const journal = createLocalMessagingJournal({ stateRoot });
  const executedJobs = [];

  try {
    await journal.recordSend({
      sender: "sender-a",
      recipient: "recipient-1",
      messageId: "msg-uncertain-executing",
      requestId: "req-u-1",
      text: "in flight when crash happened",
    });
    await journal.claimExecution("msg-uncertain-executing");

    const dispatcher = createLocalMessagingDispatcher({
      journal,
      runRecipient: async (job) => {
        executedJobs.push(job.messageId);
        return { status: "completed", text: "should not run" };
      },
    });

    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 50));

    // Must never replay uncertain started work
    assert.equal(executedJobs.length, 0);

    const record = await journal.getRecord("msg-uncertain-executing");
    assert.equal(record.phase, "held");
    assert.equal(record.reason, "crash_recovery");

    // Duplicate notification for uncertain held record is ignored
    await dispatcher.notifyAdmission({ messageId: "msg-uncertain-executing", recipient: "recipient-1" });
    assert.equal(executedJobs.length, 0);

    await dispatcher.stop();
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("per-recipient serialization prevents same-harness overlap while overall concurrency allows parallel recipients", async () => {
  const stateRoot = createIsolatedStateRoot();
  const journal = createLocalMessagingJournal({ stateRoot });
  const activePerRecipient = new Map();
  let maxActiveR1 = 0;
  let maxOverallActive = 0;
  let currentlyActive = 0;

  try {
    const runRecipient = async (job, { onStarted }) => {
      onStarted();
      const r = job.recipient;
      activePerRecipient.set(r, (activePerRecipient.get(r) || 0) + 1);
      currentlyActive++;
      if (r === "agent-1") {
        maxActiveR1 = Math.max(maxActiveR1, activePerRecipient.get(r));
      }
      maxOverallActive = Math.max(maxOverallActive, currentlyActive);

      await new Promise((resolve) => setTimeout(resolve, 60));

      activePerRecipient.set(r, activePerRecipient.get(r) - 1);
      currentlyActive--;
      return { status: "completed", text: `reply for ${job.messageId}` };
    };

    const dispatcher = createLocalMessagingDispatcher({
      journal,
      runRecipient,
      maxConcurrent: 2,
    });
    await dispatcher.start();

    // Send 2 jobs to agent-1, and 1 job to agent-2
    for (const [id, r] of [
      ["m1", "agent-1"],
      ["m2", "agent-1"],
      ["m3", "agent-2"],
    ]) {
      await journal.recordSend({
        sender: "user",
        recipient: r,
        messageId: id,
        requestId: id,
        text: `task ${id}`,
      });
      await dispatcher.notifyAdmission({
        sender: "user",
        recipient: r,
        messageId: id,
        requestId: id,
        text: `task ${id}`,
      });
    }

    // stop() no longer drains queued work, so wait for every job to finish first
    await waitFor(async () => (await journal.status()).completed === 3, { message: "all three jobs" });
    await dispatcher.stop();

    // Assert agent-1 never ran 2 executions concurrently
    assert.equal(maxActiveR1, 1, "Agent 1 must strictly serialize execution (max active: 1)");
    // Overall concurrency allowed agent-1 and agent-2 to run together
    assert.equal(maxOverallActive, 2, "Distinct recipients must run concurrently up to maxConcurrent (2)");
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("duplicate notifications and retries never overlap or execute duplicate turns", async () => {
  const stateRoot = createIsolatedStateRoot();
  const journal = createLocalMessagingJournal({ stateRoot });
  let invocationCount = 0;

  try {
    await journal.recordSend({
      sender: "user",
      recipient: "agent-1",
      messageId: "msg-dup-test",
      requestId: "req-dup",
      text: "task body",
    });

    const runRecipient = async (job, { onStarted }) => {
      onStarted();
      invocationCount++;
      await new Promise((r) => setTimeout(r, 60));
      return { status: "completed", text: "reply body" };
    };

    const dispatcher = createLocalMessagingDispatcher({
      journal,
      runRecipient,
    });
    await dispatcher.start();

    // Call notifyAdmission twice concurrently
    const job = {
      sender: "user",
      recipient: "agent-1",
      messageId: "msg-dup-test",
      requestId: "req-dup",
      text: "task body",
    };
    await Promise.all([
      dispatcher.notifyAdmission(job),
      dispatcher.notifyAdmission(job),
    ]);

    await waitFor(async () => (await journal.getRecord("msg-dup-test")).phase === "completed", { message: "completion" });
    await dispatcher.stop();

    assert.equal(invocationCount, 1, "Duplicate notifications must execute runner exactly once");
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("timeout begins at actual onStarted rather than shared gate wait", async () => {
  const stateRoot = createIsolatedStateRoot();
  const journal = createLocalMessagingJournal({ stateRoot });

  try {
    await journal.recordSend({
      sender: "user",
      recipient: "agent-1",
      messageId: "msg-timeout-test",
      requestId: "req-to",
      text: "heavy prompt",
    });

    const runRecipient = async (job, { signal, onStarted }) => {
      // Simulate waiting 80ms for supervisor gate BEFORE starting
      await new Promise((r) => setTimeout(r, 80));
      onStarted();

      // Now run until aborted
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("runner_timeout"));
        });
      });
    };

    const dispatcher = createLocalMessagingDispatcher({
      journal,
      runRecipient,
      runnerTimeoutMs: 60, // Short timeout of 60ms
    });
    await dispatcher.start();

    const t0 = Date.now();
    await dispatcher.notifyAdmission({
      sender: "user",
      recipient: "agent-1",
      messageId: "msg-timeout-test",
      requestId: "req-to",
      text: "heavy prompt",
    });

    // Wait until job is held
    for (let i = 0; i < 50; i++) {
      const rec = await journal.getRecord("msg-timeout-test");
      if (rec?.phase === "held") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const elapsed = Date.now() - t0;
    // Since gate wait was 80ms and timeout was 60ms, total elapsed must be >= 130ms (80 + 60)
    assert.ok(elapsed >= 130, `Elapsed ${elapsed}ms must reflect gate wait (80ms) + timeout (60ms)`);

    const rec = await journal.getRecord("msg-timeout-test");
    assert.equal(rec.phase, "held");
    assert.equal(rec.reason, "runner_timeout");

    await dispatcher.stop();
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("abort and stop retain journal ownership until underlying runner actually terminates", async () => {
  const stateRoot = createIsolatedStateRoot();
  const journal = createLocalMessagingJournal({ stateRoot });
  let underlyingRunnerSettled = false;
  let runnerResolve;

  try {
    await journal.recordSend({
      sender: "user",
      recipient: "agent-1",
      messageId: "msg-close-wait",
      requestId: "req-cw",
      text: "slow terminate",
    });

    const runRecipient = async (job, { onStarted }) => {
      onStarted();
      return new Promise((resolve) => {
        runnerResolve = () => {
          underlyingRunnerSettled = true;
          resolve({ status: "completed", text: "done" });
        };
      });
    };

    const dispatcher = createLocalMessagingDispatcher({
      journal,
      runRecipient,
    });
    await dispatcher.start();

    await dispatcher.notifyAdmission({
      sender: "user",
      recipient: "agent-1",
      messageId: "msg-close-wait",
      requestId: "req-cw",
      text: "slow terminate",
    });

    // Initiate stop while runner is in progress
    let stopCompleted = false;
    const stopPromise = dispatcher.stop().then(() => {
      stopCompleted = true;
    });

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(stopCompleted, false, "stop() must not resolve while runner is still executing");

    // Resolve runner
    runnerResolve();
    await stopPromise;
    assert.equal(stopCompleted, true);
    assert.equal(underlyingRunnerSettled, true);
  } finally {
    runnerResolve?.();
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("runtime error records failure and holds execution in journal independently from acceptance", async () => {
  const stateRoot = createIsolatedStateRoot();
  const journal = createLocalMessagingJournal({ stateRoot });

  try {
    await journal.recordSend({
      sender: "user",
      recipient: "agent-1",
      messageId: "msg-err-test",
      requestId: "req-err",
      text: "bad input",
    });

    const runRecipient = async () => {
      throw new Error("model context window exceeded");
    };

    const dispatcher = createLocalMessagingDispatcher({
      journal,
      runRecipient,
    });
    await dispatcher.start();

    // Admission returns promptly without throwing
    await dispatcher.notifyAdmission({
      sender: "user",
      recipient: "agent-1",
      messageId: "msg-err-test",
      requestId: "req-err",
      text: "bad input",
    });

    await dispatcher.stop();

    const record = await journal.getRecord("msg-err-test");
    assert.equal(record.phase, "held");
    assert.equal(record.reason, "runtime_error");
    assert.ok(record.runtimeError.includes("context window exceeded"));
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("transient recipient busy does not wedge queue: other recipients make progress", async () => {
  const stateRoot = createIsolatedStateRoot();
  const journal = createLocalMessagingJournal({ stateRoot });
  let slowRelease;
  const executionOrder = [];

  try {
    const runRecipient = async (job, { onStarted }) => {
      onStarted();
      if (job.messageId === "job-slow-1") {
        await new Promise((resolve) => {
          slowRelease = resolve;
        });
      }
      executionOrder.push(job.messageId);
      return { status: "completed", text: `reply for ${job.messageId}` };
    };

    const dispatcher = createLocalMessagingDispatcher({
      journal,
      runRecipient,
      maxConcurrent: 2,
    });
    await dispatcher.start();

    // Queue:
    // 1. job-slow-1 for agent-A (will block agent-A)
    // 2. job-queued-2 for agent-A (must wait for agent-A to finish slow-1)
    // 3. job-fast-3 for agent-B (must NOT wait for agent-A!)
    for (const [id, r] of [
      ["job-slow-1", "agent-A"],
      ["job-queued-2", "agent-A"],
      ["job-fast-3", "agent-B"],
    ]) {
      await journal.recordSend({ sender: "u", recipient: r, messageId: id, requestId: id, text: id });
      await dispatcher.notifyAdmission({ sender: "u", recipient: r, messageId: id, requestId: id, text: id });
    }

    // Wait 50ms: job-fast-3 should complete while job-slow-1 is still blocked!
    for (let i = 0; i < 30 && !executionOrder.includes("job-fast-3"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(executionOrder.includes("job-fast-3"), "agent-B must not be blocked by busy agent-A");
    assert.equal(executionOrder.includes("job-queued-2"), false, "agent-A second job must wait for first job");

    // Release slow job
    slowRelease();
    await waitFor(() => executionOrder.length === 3, { message: "all three jobs" });
    await dispatcher.stop();

    assert.deepEqual(executionOrder, ["job-fast-3", "job-slow-1", "job-queued-2"]);
  } finally {
    slowRelease?.();
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("causal loop metadata passes to runRecipient", async () => {
  const stateRoot = createIsolatedStateRoot();
  const journal = createLocalMessagingJournal({ stateRoot });
  let capturedJob;

  try {
    await journal.recordSend({
      sender: "agent-caller",
      recipient: "agent-callee",
      messageId: "msg-meta-chain",
      requestId: "req-c-1",
      inReplyTo: "msg-parent-0",
      text: "nested call",
      metadata: { _loopDepth: 3, traceId: "t-123" },
    });

    const runRecipient = async (job) => {
      capturedJob = job;
      return { status: "completed", text: "nested reply" };
    };

    const dispatcher = createLocalMessagingDispatcher({
      journal,
      runRecipient,
    });
    await dispatcher.start();

    await dispatcher.notifyAdmission({
      sender: "agent-caller",
      recipient: "agent-callee",
      messageId: "msg-meta-chain",
      requestId: "req-c-1",
      inReplyTo: "msg-parent-0",
      text: "nested call",
      loopDepth: 3,
      metadata: { _loopDepth: 3, traceId: "t-123" },
    });

    await dispatcher.stop();

    assert.ok(capturedJob);
    assert.equal(capturedJob.messageId, "msg-meta-chain");
    assert.equal(capturedJob.inReplyTo, "msg-parent-0");
    assert.equal(capturedJob.loopDepth, 3);
    assert.equal(capturedJob.metadata?._loopDepth, 3);
    assert.equal(capturedJob.metadata?.traceId, "t-123");
  } finally {
    await journal?.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('late success after deadline is held and never presented as a normal reply',async()=>{
 const stateRoot=createIsolatedStateRoot(),journal=createLocalMessagingJournal({stateRoot});
 const dispatcher=createLocalMessagingDispatcher({journal,runnerTimeoutMs:5,runRecipient:async(job,{onStarted,signal})=>{onStarted();await new Promise(r=>setTimeout(r,30));assert.equal(signal.aborted,true);return {status:'completed',text:'late'};}});
 try{
  await journal.recordSend({sender:'a',recipient:'b',messageId:'late',requestId:'late-req',text:'work'});
  await dispatcher.start();await waitFor(async()=>(await journal.getRecord('late')).phase==='held',{message:'timeout hold'});await dispatcher.stop();
  assert.equal((await journal.getRecord('late')).reason,'runner_timeout');
  assert.deepEqual(await journal.listReplies({requester:'a'}),[]);
 }finally{await dispatcher.stop();await journal.close();fs.rmSync(stateRoot,{recursive:true,force:true});}
});
test('automatic reply keeps authoritative durable ancestry despite runner metadata',async()=>{
 const stateRoot=createIsolatedStateRoot(),journal=createLocalMessagingJournal({stateRoot});
 const dispatcher=createLocalMessagingDispatcher({journal,runRecipient:async()=>({status:'completed',text:'ok',metadata:{_loopDepth:1}})});
 try{
  await journal.recordSend({sender:'a',recipient:'b',messageId:'deep',requestId:'deep-req',text:'work',metadata:{_loopDepth:8}});
  await dispatcher.start();await waitFor(async()=>(await journal.listReplies({requester:'a'})).length===1,{message:'reply'});await dispatcher.stop();
  const [reply]=await journal.listReplies({requester:'a'});assert.equal(reply.metadata._loopDepth,9);
 }finally{await dispatcher.stop();await journal.close();fs.rmSync(stateRoot,{recursive:true,force:true});}
});

test('claim storage failure is contained and does not crash the supervisor',async()=>{
 const stateRoot=createIsolatedStateRoot(),journal=createLocalMessagingJournal({stateRoot});
 const original=journal.claimExecution;let attempts=0;journal.claimExecution=async()=>{attempts++;throw new Error('disk failure');};
 const dispatcher=createLocalMessagingDispatcher({journal,runRecipient:async()=>assert.fail('must not execute')});
 try{
  await journal.recordSend({sender:'a',recipient:'b',messageId:'disk',requestId:'disk-req',text:'work'});
  await dispatcher.start();await waitFor(()=>attempts===1&&dispatcher.status().active===0,{message:'contained claim failure'});await dispatcher.stop();
  assert.equal((await journal.getRecord('disk')).phase,'queued_local');
 }finally{journal.claimExecution=original;await journal.close();fs.rmSync(stateRoot,{recursive:true,force:true});}
});

test('stop waits only for running executions and leaves queued work queued_local for the next start',async()=>{
 const stateRoot=createIsolatedStateRoot(),journal=createLocalMessagingJournal({stateRoot}),started=[];
 let release;const held=new Promise(r=>{release=r;});
 const runRecipient=async(job,{onStarted})=>{onStarted();started.push(job.messageId);if(job.messageId==='q-0')await held;return {status:'completed',text:'ok'};};
 const dispatcher=createLocalMessagingDispatcher({journal,maxConcurrent:1,runRecipient});
 try{
  await dispatcher.start();
  for(let i=0;i<5;i++){
   const envelope={sender:'a',recipient:'b',messageId:`q-${i}`,requestId:`r-${i}`,text:'work'};
   await journal.recordSend(envelope);await dispatcher.notifyAdmission(envelope);
  }
  await waitFor(()=>started.length===1,{message:'first execution'});
  let stopped=false;const stopping=dispatcher.stop().then(()=>{stopped=true;});
  await new Promise(r=>setTimeout(r,40));
  assert.equal(stopped,false,'a running execution is still awaited');
  assert.deepEqual(started,['q-0'],'nothing new starts once stopping');
  release();await stopping;
  assert.deepEqual(started,['q-0'],'queued work was not run during shutdown');
  const status=await journal.status();
  assert.equal(status.queued_local,4);assert.equal(status.completed,1);assert.equal(status.executing,0);
  assert.equal(dispatcher.status().queued,0,'the in-memory queue is dropped, not the journal rows');
  await dispatcher.notifyAdmission({sender:'a',recipient:'b',messageId:'late-admit',requestId:'r',text:'x'});
  assert.deepEqual(started,['q-0'],'admissions after stop are ignored');
  // The next start recovers every untouched queued message.
  const recovered=[];
  const next=createLocalMessagingDispatcher({journal,maxConcurrent:2,runRecipient:async(job,{onStarted})=>{onStarted();recovered.push(job.messageId);return {status:'completed',text:'ok'};}});
  await next.start();
  await waitFor(async()=>(await journal.status()).completed===5,{message:'recovered queue'});await next.stop();
  assert.deepEqual(recovered.sort(),['q-1','q-2','q-3','q-4']);
 }finally{release?.();await journal.close();fs.rmSync(stateRoot,{recursive:true,force:true});}
});
test('stop with nothing running resolves immediately and later admissions stay queued_local',async()=>{
 const stateRoot=createIsolatedStateRoot(),journal=createLocalMessagingJournal({stateRoot});
 try{
  const dispatcher=createLocalMessagingDispatcher({journal,runRecipient:async()=>assert.fail('must not run during shutdown')});
  await dispatcher.start();await dispatcher.stop();
  const envelope={sender:'a',recipient:'b',messageId:'idle',requestId:'idle-req',text:'work'};
  await journal.recordSend(envelope);await dispatcher.notifyAdmission(envelope);
  await new Promise(r=>setTimeout(r,20));
  assert.equal((await journal.getRecord('idle')).phase,'queued_local');
  assert.equal(dispatcher.status().queued,0);
 }finally{await journal.close();fs.rmSync(stateRoot,{recursive:true,force:true});}
});

test('a late success after the deadline stays held, is stored for the owner, and never becomes a reply',async()=>{
 const stateRoot=createIsolatedStateRoot(),journal=createLocalMessagingJournal({stateRoot});
 const dispatcher=createLocalMessagingDispatcher({journal,runnerTimeoutMs:5,runRecipient:async(job,{onStarted})=>{onStarted();await new Promise(r=>setTimeout(r,40));return {status:'completed',text:'late answer'};}});
 try{
  await journal.recordSend({sender:'a',recipient:'b',messageId:'late-kept',requestId:'late-kept-req',text:'work'});
  await journal.recordSend({sender:'a',recipient:'b2',messageId:'plain',requestId:'plain-req',text:'work'});
  await journal.holdExecution('plain','operator_hold');
  await dispatcher.start();await waitFor(async()=>(await journal.getRecord('late-kept')).phase==='held',{message:'timeout hold'});await dispatcher.stop();
  const record=await journal.getRecord('late-kept');
  assert.equal(record.reason,'runner_timeout');assert.equal(record.hasLateResult,true);
  assert.ok(!JSON.stringify(record).includes('late answer'),'record never carries the late text');
  assert.deepEqual(await journal.listReplies({requester:'a'}),[]);
  assert.deepEqual(await journal.getLateResult('late-kept'),{messageId:'late-kept',text:'late answer'});
  assert.equal((await journal.getRecord('plain')).hasLateResult,false);assert.equal(await journal.getLateResult('plain'),null);
 }finally{await dispatcher.stop();await journal.close();fs.rmSync(stateRoot,{recursive:true,force:true});}
});

test('the dispatcher compacts finished records at start and at most hourly, and a failing compaction never disturbs work',async()=>{
 const stateRoot=createIsolatedStateRoot(),journal=createLocalMessagingJournal({stateRoot});
 let clock=Date.UTC(2026,9,21,12,0,0);const calls=[],errors=[];
 const compact=journal.compact.bind(journal);journal.compact=async(options={})=>{calls.push(options.now);return compact(options);};
 const done=[];
 const dispatcher=createLocalMessagingDispatcher({journal,now:()=>clock,logger:{error:(event,detail)=>errors.push({event,code:detail?.code})},runRecipient:async(job,{onStarted})=>{onStarted();done.push(job.messageId);return {status:'completed',text:'ok'};}});
 const admit=async id=>{const envelope={sender:'a',recipient:'b',messageId:id,requestId:`r-${id}`,text:'work'};await journal.recordSend(envelope);await dispatcher.notifyAdmission(envelope);};
 try{
  await dispatcher.start();
  assert.deepEqual(calls,[clock],'compaction runs at start');
  await admit('m1');await admit('m2');
  clock+=59*60*1000;await admit('m3');
  assert.equal(calls.length,1,'at most hourly');
  clock+=2*60*1000;await admit('m4');
  assert.deepEqual(calls,[Date.UTC(2026,9,21,12,0,0),clock],'due again after an hour');
  await waitFor(()=>done.length===4,{message:'all four jobs'});
  journal.compact=async()=>{throw Object.assign(new Error('disk full'),{code:'disk_full'});};
  clock+=2*60*60*1000;await admit('m5');
  await waitFor(()=>done.length===5,{message:'work continues after a compaction failure'});
  assert.deepEqual(errors,[{event:'local_messaging_compaction_failed',code:'disk_full'}]);
  await dispatcher.stop();
 }finally{await dispatcher.stop();await journal.close();fs.rmSync(stateRoot,{recursive:true,force:true});}
});

test('the dispatcher exposes exactly one name per hook: start, stop, notifyAdmission (plus status)',()=>{
 const dispatcher=createLocalMessagingDispatcher({journal:{},runRecipient:async()=>{}});
 assert.deepEqual(Object.keys(dispatcher).sort(),['notifyAdmission','start','status','stop']);
});
