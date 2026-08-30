import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCommandRunner, createRunnerEnvironment } from "../src/command-runner.mjs";

const request = {
  messageId: "message_1",
  taskId: "task_1",
  contextId: "context_1",
  senderId: "agent_sender",
  recipientId: "agent_receiver",
  text: "hello",
  replyRequired: true,
};

test("command runner sends normalized JSON on stdin and accepts one result", async () => {
  const script = [
    "let input='';",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => {",
    " const request = JSON.parse(input);",
    " process.stdout.write(JSON.stringify({status:'completed', text:'reply:' + request.text}));",
    "});",
  ].join("");
  const runner = createCommandRunner({
    command: process.execPath,
    args: ["-e", script],
    timeoutMs: 2_000,
  });

  assert.deepEqual(await runner.run(request), {
    status: "completed",
    text: "reply:hello",
  });
});

test("command runner child receives no controller credentials or ambient secrets", async () => {
  const names = [
    "MESH_AGENT_TOKEN",
    "TURSO_AUTH_TOKEN",
    "GATEWAY_INTERNAL_TOKEN",
    "GENERIC_SECRET",
    "GENERIC_TOKEN",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = `private-${name}`;
  try {
    const script = "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({status:'completed',text:JSON.stringify(process.env)})))";
    const runner = createCommandRunner({ command: process.execPath, args: ["-e", script] });
    const childEnv = JSON.parse((await runner.run(request)).text);
    for (const name of names) assert.equal(childEnv[name], undefined, name);
    assert.equal(childEnv.PATH, process.env.PATH);
    const common = { PATH: "/usr/bin", TRIANGLE_PROJECT_ROOT: "/project" };
    assert.deepEqual(createRunnerEnvironment({ ...common, CODEX_CLI: "/bin/codex", CODEX_HOME: "/state/codex" }), {
      PATH: "/usr/bin", CODEX_CLI: "/bin/codex", CODEX_HOME: "/state/codex", TRIANGLE_PROJECT_ROOT: "/project",
    });
    assert.deepEqual(createRunnerEnvironment({ ...common, HERMES_CLI: "/bin/hermes", HERMES_HOME: "/state/hermes" }), {
      PATH: "/usr/bin", HERMES_CLI: "/bin/hermes", HERMES_HOME: "/state/hermes", TRIANGLE_PROJECT_ROOT: "/project",
    });
    assert.throws(() => createRunnerEnvironment({ ...common, CODEX_CLI: "/bin/codex", CODEX_HOME: "/state/codex", HERMES_CLI: "/bin/hermes" }), /single active|inactive|conflicting/i);
    assert.throws(() => createRunnerEnvironment({ ...common, HERMES_CLI: "/bin/hermes", HERMES_HOME: "/state/hermes", CODEX_HOME: "/state/codex" }), /single active|inactive|conflicting/i);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("runner environment preserves exact opaque instance selectors without credentials or inactive adapters", () => {
  const instanceId = "a".repeat(64);
  const instanceTemp = `/Users/test/Library/Caches/The Triangle/instances/${instanceId}`;
  const filtered = createRunnerEnvironment({
    PATH: "/usr/bin",
    TRIANGLE_PROJECT_ROOT: "/project",
    TRIANGLE_INSTANCE_ID: instanceId,
    TRIANGLE_INSTANCE_TEMP_ROOT: instanceTemp,
    CODEX_CLI: "/bin/codex",
    CODEX_HOME: `/state/instances/${instanceId}`,
    MESH_AGENT_TOKEN: "mesh_must-not-survive",
    MESH_ORIGIN: "https://must-not-survive.example",
    HERMES_AGENT_ID: "agent_must-not-survive",
    GENERIC_SECRET: "must-not-survive",
  });
  assert.equal(filtered.TRIANGLE_INSTANCE_ID, instanceId);
  assert.equal(filtered.TRIANGLE_INSTANCE_TEMP_ROOT, instanceTemp);
  assert.equal(filtered.MESH_AGENT_TOKEN, undefined);
  assert.equal(filtered.MESH_ORIGIN, undefined);
  assert.equal(filtered.HERMES_AGENT_ID, undefined);
  assert.equal(filtered.HERMES_CLI, undefined);
  assert.equal(filtered.HERMES_HOME, undefined);
  assert.equal(filtered.GENERIC_SECRET, undefined);
});

test("command runner uses the explicit instance environment instead of ambient process state", async () => {
  const previous = process.env.TRIANGLE_INSTANCE_ID;
  process.env.TRIANGLE_INSTANCE_ID = "f".repeat(64);
  try {
    const expected = "a".repeat(64);
    const script = "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({status:'completed',text:process.env.TRIANGLE_INSTANCE_ID||'missing'})))";
    const runner = createCommandRunner({
      command: process.execPath,
      args: ["-e", script],
      environment: { PATH: process.env.PATH, TRIANGLE_INSTANCE_ID: expected },
    });
    assert.equal((await runner.run(request)).text, expected);
  } finally {
    if (previous === undefined) delete process.env.TRIANGLE_INSTANCE_ID;
    else process.env.TRIANGLE_INSTANCE_ID = previous;
  }
});

test("command runner rejects malformed output", async () => {
  const runner = createCommandRunner({
    command: process.execPath,
    args: ["-e", "process.stdout.write('not-json')"],
    timeoutMs: 2_000,
  });

  await assert.rejects(runner.run(request), /invalid JSON/);
});

test("command runner terminates work that exceeds its timeout", async () => {
  const runner = createCommandRunner({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    timeoutMs: 30,
  });

  await assert.rejects(runner.run(request), /timed out/);
});

test("command runner abort terminates and reaps a real child that ignores SIGTERM", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "triangle-runner-abort-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pidPath = path.join(directory, "pid");
  const secret = "request-secret-must-not-leak";
  const script = [
    "const fs=require('node:fs');",
    "process.on('SIGTERM',()=>{});",
    `fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));`,
    "setInterval(()=>{},1000);",
  ].join("");
  const runner = createCommandRunner({
    command: process.execPath,
    args: ["-e", script],
    timeoutMs: 10_000,
  });
  const controller = new AbortController();
  const running = runner.run({ ...request, text: secret }, { signal: controller.signal });
  let pid;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      pid = Number(await fs.readFile(pidPath, "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assert.equal(Number.isSafeInteger(pid), true);
  controller.abort();
  await assert.rejects(running, (error) => (
    error?.name === "AbortError"
    && error.message === "Runner aborted"
    && !JSON.stringify(error).includes(secret)
  ));
  assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH");
});

test("command runner abort terminates the adapter's reasoning grandchild process group", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process-group test");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "triangle-runner-group-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pidsPath = path.join(directory, "pids.json");
  const grandchild = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const adapter = `const{spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}]);fs.writeFileSync(${JSON.stringify(pidsPath)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)`;
  const runner = createCommandRunner({ command: process.execPath, args: ["-e", adapter], timeoutMs: 10_000 });
  const controller = new AbortController();
  const running = runner.run(request, { signal: controller.signal });
  let pids;
  for (let attempt = 0; attempt < 100 && !pids; attempt += 1) {
    try { pids = JSON.parse(await fs.readFile(pidsPath, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  assert.equal(pids?.length, 2);
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH");
});

for (const mode of ["abort", "timeout"]) {
  test(`command runner ${mode} kills an abort-ignoring reasoning process spawned by production runner-common`, async (t) => {
    if (process.platform === "win32") return t.skip("POSIX process-group test");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `triangle-production-topology-${mode}-`));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const pidPath = path.join(directory, "reasoner.pid");
    const commonUrl = new URL("../runners/runner-common.mjs", import.meta.url).href;
    const adapterPath = path.join(directory, "adapter.mjs");
    const reasoner = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000)`;
    await fs.writeFile(adapterPath, `import { invoke } from ${JSON.stringify(commonUrl)}; await invoke(process.execPath,["-e",${JSON.stringify(reasoner)}],{sandbox:(command,args)=>({command,args})});`);
    const runner = createCommandRunner({ command: process.execPath, args: [adapterPath], timeoutMs: mode === "timeout" ? 100 : 10_000 });
    const controller = new AbortController();
    const running = runner.run(request, { signal: controller.signal });
    let pid;
    for (let attempt = 0; attempt < 100 && !pid; attempt += 1) {
      try { pid = Number(await fs.readFile(pidPath, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.equal(Number.isSafeInteger(pid), true);
    if (mode === "abort") controller.abort();
    await assert.rejects(running, mode === "abort" ? { name: "AbortError" } : /timed out/);
    let gone = false;
    for (let attempt = 0; attempt < 100 && !gone; attempt += 1) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
      catch (error) { if (error?.code === "ESRCH") gone = true; else throw error; }
    }
    assert.equal(gone, true, `reasoning descendant ${pid} was not reaped`);
  });
}

test("command runner contains stdin EPIPE when a child exits before a large request", () => {
  const runnerUrl = new URL("../src/command-runner.mjs", import.meta.url).href;
  const marker = "stdin-secret-must-not-leak";
  const script = `
    import { createCommandRunner } from ${JSON.stringify(runnerUrl)};
    const marker = ${JSON.stringify(marker)};
    const runner = createCommandRunner({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 2000,
    });
    try {
      await runner.run({
        messageId: "message_1", taskId: "task_1", contextId: "context_1",
        senderId: "agent_sender", recipientId: "agent_receiver",
        text: marker + "x".repeat(900000), replyRequired: true,
      });
      process.exitCode = 2;
    } catch (error) {
      const serialized = JSON.stringify({ name: error?.name, message: error?.message });
      if (serialized.includes(marker) || serialized.length > 500) process.exitCode = 3;
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, new RegExp(marker));
});
