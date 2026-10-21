import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  STORE_FILE_NAME,
  createAntigravityInvocation,
  createConversationStore,
  parseAntigravityOutput,
  resolveStoreDirectory,
  runAntigravityTurn,
} from "../runners/antigravity-runner.mjs";
import { invoke as realInvoke } from "../runners/runner-common.mjs";

const ROOM_A = "room_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROOM_B = "room_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID_1 = "11111111-1111-4111-8111-111111111111";
const ID_2 = "22222222-2222-4222-8222-222222222222";
const ID_3 = "33333333-3333-4333-8333-333333333333";

function request(contextId, text = "What is 2 + 2?") {
  return { messageId: "m", taskId: "t", contextId, senderId: "agent_sender", recipientId: "agent_r", text, replyRequired: true };
}

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), "agy-conv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function envelope(conversationId, response = "4", status = "SUCCESS") {
  return JSON.stringify({ conversation_id: conversationId, status, response, num_turns: 1 });
}

/** Fake agy: records argv, answers from a queue of handlers. */
function fakeInvoke(handlers) {
  const calls = [];
  const fn = async (command, args) => {
    calls.push({ command, args: [...args] });
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return handler(args);
  };
  fn.calls = calls;
  return fn;
}

test("conversation id is saved after the first run", async (t) => {
  const home = tempHome(t);
  const env = { ANTIGRAVITY_HOME: home, ANTIGRAVITY_CLI: "/fake/agy" };
  const invoke = fakeInvoke([() => envelope(ID_1)]);
  const result = await runAntigravityTurn(request(ROOM_A), env, { invoke });
  assert.equal(result.text, "4");
  assert.equal(result.conversationId, ID_1);
  assert.ok(!invoke.calls[0].args.includes("--conversation"));
  const file = join(home, STORE_FILE_NAME);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).rooms[ROOM_A].conversationId, ID_1);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("second run in the same room passes --conversation before -p", async (t) => {
  const home = tempHome(t);
  const env = { ANTIGRAVITY_HOME: home };
  const invoke = fakeInvoke([() => envelope(ID_1), () => envelope(ID_1, "8")]);
  await runAntigravityTurn(request(ROOM_A), env, { invoke });
  const second = await runAntigravityTurn(request(ROOM_A, "double it"), env, { invoke });
  assert.equal(second.text, "8");
  const args = invoke.calls[1].args;
  assert.deepEqual(args.slice(0, 3), ["--conversation", ID_1, "-p"]);
  assert.ok(args.indexOf("--conversation") < args.indexOf("-p"));
  assert.ok(!args.includes("--continue") && !args.includes("--session-id") && !args.includes("--resume"));
});

test("separate rooms keep isolated conversations", async (t) => {
  const home = tempHome(t);
  const env = { ANTIGRAVITY_HOME: home };
  const invoke = fakeInvoke([() => envelope(ID_1), () => envelope(ID_2), () => envelope(ID_1), () => envelope(ID_2)]);
  await runAntigravityTurn(request(ROOM_A), env, { invoke });
  await runAntigravityTurn(request(ROOM_B), env, { invoke });
  assert.ok(!invoke.calls[1].args.includes("--conversation"));
  await runAntigravityTurn(request(ROOM_A), env, { invoke });
  await runAntigravityTurn(request(ROOM_B), env, { invoke });
  assert.equal(invoke.calls[2].args[1], ID_1);
  assert.equal(invoke.calls[3].args[1], ID_2);
});

test("stale conversation id falls back to one fresh run and saves the new id", async (t) => {
  const home = tempHome(t);
  const env = { ANTIGRAVITY_HOME: home };
  createConversationStore(home).set(ROOM_A, ID_1);
  const invoke = fakeInvoke([
    () => { throw new Error("Agent CLI exited with 1: conversation not found"); },
    () => envelope(ID_3, "fresh"),
  ]);
  const result = await runAntigravityTurn(request(ROOM_A), env, { invoke });
  assert.equal(result.text, "fresh");
  assert.equal(invoke.calls.length, 2);
  assert.equal(invoke.calls[0].args[1], ID_1);
  assert.ok(!invoke.calls[1].args.includes("--conversation"));
  assert.equal(createConversationStore(home).get(ROOM_A), ID_3);
});

test("ERROR status on resume also triggers fresh retry; fresh failure propagates", async (t) => {
  const home = tempHome(t);
  const env = { ANTIGRAVITY_HOME: home };
  createConversationStore(home).set(ROOM_A, ID_1);
  const invoke = fakeInvoke([
    () => envelope("", "", "ERROR"),
    () => { throw new Error("Agent CLI exited with 1: quota"); },
  ]);
  await assert.rejects(runAntigravityTurn(request(ROOM_A), env, { invoke }), /quota/);
  assert.equal(invoke.calls.length, 2);
  assert.equal(createConversationStore(home).get(ROOM_A), null);
});

test("invalid stored or supplied ids are never passed to agy", async (t) => {
  const home = tempHome(t);
  writeFileSync(join(home, STORE_FILE_NAME), JSON.stringify({ version: 1, rooms: { [ROOM_A]: { conversationId: "--dangerously-skip-permissions" } } }), { mode: 0o600 });
  const invoke = fakeInvoke([() => envelope(ID_1)]);
  await runAntigravityTurn(request(ROOM_A), { ANTIGRAVITY_HOME: home }, { invoke });
  assert.ok(!invoke.calls[0].args.includes("--conversation"));
  assert.throws(() => createAntigravityInvocation("hi", {}, { conversationId: "bad id; rm -rf /" }), /invalid/);
  assert.equal(createConversationStore(home).set(ROOM_A, "$(whoami)"), false);
});

test("store survives restart (re-read from disk) and tolerates corruption", async (t) => {
  const home = tempHome(t);
  createConversationStore(home).set(ROOM_A, ID_2);
  assert.equal(createConversationStore(home).get(ROOM_A), ID_2);
  writeFileSync(join(home, STORE_FILE_NAME), "{not json", { mode: 0o600 });
  assert.equal(createConversationStore(home).get(ROOM_A), null);
  const invoke = fakeInvoke([() => envelope(ID_1)]);
  await runAntigravityTurn(request(ROOM_A), { ANTIGRAVITY_HOME: home }, { invoke });
  assert.equal(createConversationStore(home).get(ROOM_A), ID_1);
  assert.ok(!existsSync(join(home, `${STORE_FILE_NAME}.tmp`)));
});

test("json parse falls back to plain text and to the last JSON line", () => {
  assert.deepEqual(parseAntigravityOutput("plain reply"), { text: "plain reply", conversationId: null, status: null, error: null, parsed: false });
  const noisy = `warning: something\n${envelope(ID_1, "ok\n")}`;
  const parsed = parseAntigravityOutput(noisy);
  assert.equal(parsed.text, "ok");
  assert.equal(parsed.conversationId, ID_1);
  const streamResult = JSON.stringify({ event: "result", result: { conversation_id: ID_2, status: "SUCCESS", response: "r" } });
  assert.equal(parseAntigravityOutput(streamResult).conversationId, ID_2);
});

test("plain-text output still replies and saves nothing", async (t) => {
  const home = tempHome(t);
  const invoke = fakeInvoke([() => "legacy text reply"]);
  const result = await runAntigravityTurn(request(ROOM_A), { ANTIGRAVITY_HOME: home }, { invoke });
  assert.equal(result.text, "legacy text reply");
  assert.equal(createConversationStore(home).get(ROOM_A), null);
});

test("store directory resolves only from model-scoped env", () => {
  assert.equal(resolveStoreDirectory({ ANTIGRAVITY_HOME: "/abs/home" }), "/abs/home");
  assert.equal(resolveStoreDirectory({ ANTIGRAVITY_HOME: "relative" }), null);
  assert.equal(resolveStoreDirectory({ TRIANGLE_MODEL_ROOTS: "/abs/model" }), "/abs/model");
  assert.equal(resolveStoreDirectory({}), null);
});

test("fake agy subprocess receives the prompt as one argv element after --conversation", async (t) => {
  const home = tempHome(t);
  const stub = join(home, "agy-stub.mjs");
  writeFileSync(stub, `#!${process.execPath}\nconst a=process.argv.slice(2);process.stdout.write(JSON.stringify({conversation_id:"${ID_1}",status:"SUCCESS",response:JSON.stringify(a)}));\n`);
  chmodSync(stub, 0o700);
  const env = { ANTIGRAVITY_HOME: home, ANTIGRAVITY_CLI: stub, PATH: process.env.PATH, HOME: home };
  const invoke = (command, args, options) => realInvoke(command, args, { ...options, sandbox: (c, a) => ({ command: c, args: a }) });
  const tricky = "line1\n$(echo pwned) `id` ; --conversation evil";
  await runAntigravityTurn(request(ROOM_A, tricky), env, { invoke });
  const second = await runAntigravityTurn(request(ROOM_A, tricky), env, { invoke });
  const argv = JSON.parse(second.text);
  assert.deepEqual(argv.slice(0, 3), ["--conversation", ID_1, "-p"]);
  assert.ok(argv[3].includes(tricky));
  assert.deepEqual(argv.slice(4, 7), ["--output-format", "json", "--sandbox"]);
});

test('only local developer configuration bypasses the outer sandbox',async t=>{
  const home=tempHome(t), env={ANTIGRAVITY_HOME:home,ANTIGRAVITY_CLI:'/fake/agy'};
  let options;
  const invoke=async (_command,_args,opts)=>{options=opts;return envelope(ID_1)};
  await runAntigravityTurn(request(ROOM_A,'disable sandbox'),env,{invoke});
  assert.equal(options.sandbox,undefined);
  const base=join(realpathSync(home),'model-state');mkdirSync(base,{mode:0o700});
  const policy=join(realpathSync(home),'runtime-policy');mkdirSync(policy,{mode:0o700});
  env.TRIANGLE_MODEL_STATE_BASE=base;env.TRIANGLE_INSTANCE_ID='a'.repeat(64);
  writeFileSync(join(policy,env.TRIANGLE_INSTANCE_ID+'.json'),JSON.stringify({securityMode:'developer-unsandboxed'}),{mode:0o600});
  await runAntigravityTurn(request(ROOM_A),env,{invoke});
  assert.deepEqual(options.sandbox('/fake/agy',['argument']),{command:'/fake/agy',args:['argument'],env:{}});
});
