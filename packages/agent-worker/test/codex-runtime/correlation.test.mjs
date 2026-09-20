import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertAssistantResultUncontaminated,
  attachCorrelationToTurnStart,
  buildCorrelationTag,
  extractCorrelationFromThreadRead,
  selectCorrelationMode,
  DEFAULT_THREAD_READ_RECONCILE_WINDOW,
} from "../../src/codex-runtime/correlation.mjs";
import {
  createCodexAppServerProcess,
  createFakeAppServerStdioProgram,
} from "../../src/codex-runtime/app-server-process.mjs";

const instanceId = "a".repeat(64);

test("buildCorrelationTag is stable and non-secret", () => {
  const tag = buildCorrelationTag({
    profileInstanceId: instanceId,
    deliveryId: 42,
    executionEpoch: 3,
  });
  assert.match(tag, /^tc1:[a-f0-9]{24}$/);
  assert.equal(
    tag,
    buildCorrelationTag({
      profileInstanceId: instanceId,
      deliveryId: 42,
      executionEpoch: 3,
    }),
  );
  assert.doesNotMatch(tag, /mesh_/);
});

test("metadata correlation prefers clientUserMessageId and survives fake thread/read", async () => {
  assert.equal(selectCorrelationMode({ metadataFieldSurvivesThreadRead: true }), "metadata");
  const home = mkdtempSync(path.join(tmpdir(), "triangle-corr-meta-"));
  const fake = createFakeAppServerStdioProgram();
  const server = createCodexAppServerProcess({
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
  });

  try {
    await server.start();
    await server.initialize({ name: "corr", version: "0" });
    const started = await server.threadStart({
      cwd: home,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const tag = buildCorrelationTag({
      profileInstanceId: instanceId,
      deliveryId: 7,
      executionEpoch: 1,
    });
    const params = attachCorrelationToTurnStart(
      {
        threadId: started.thread.id,
        input: [{ type: "text", text: "please reply with only the word ok" }],
      },
      tag,
      { mode: "metadata" },
    );
    assert.equal(params.clientUserMessageId, tag);
    await server.turnStart(params);
    const read = await server.threadRead({ threadId: started.thread.id, includeTurns: true });
    const found = extractCorrelationFromThreadRead(read, tag);
    assert.equal(found.source, "clientUserMessageId");
    assert.equal(found.tag, tag);
    const texts = assertAssistantResultUncontaminated(read, tag);
    assert.deepEqual(texts, ["fake-assistant-ok"]);
  } finally {
    await server.close({ signal: "SIGKILL", timeoutMs: 1_000 });
    rmSync(home, { recursive: true, force: true });
  }
});

test("input-preamble fallback round-trips without contaminating assistant result", async () => {
  assert.equal(selectCorrelationMode({ metadataFieldSurvivesThreadRead: false }), "preamble");
  const home = mkdtempSync(path.join(tmpdir(), "triangle-corr-preamble-"));
  const fake = createFakeAppServerStdioProgram();
  const server = createCodexAppServerProcess({
    command: fake.command,
    args: fake.args,
    codexHome: home,
    env: { ...process.env, HOME: path.dirname(home) },
  });

  try {
    await server.start();
    await server.initialize({ name: "corr", version: "0" });
    const started = await server.threadStart({
      cwd: home,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const tag = buildCorrelationTag({
      profileInstanceId: instanceId,
      deliveryId: 9,
      executionEpoch: 2,
    });
    const params = attachCorrelationToTurnStart(
      {
        threadId: started.thread.id,
        input: [{ type: "text", text: "user body" }],
      },
      tag,
      { mode: "preamble" },
    );
    assert.equal(params.clientUserMessageId, undefined);
    assert.match(params.input[0].text, /^\[\[triangle-corr:/);
    await server.turnStart(params);
    const read = await server.threadRead({ threadId: started.thread.id, includeTurns: true });
    const found = extractCorrelationFromThreadRead(read, tag);
    assert.equal(found.source, "input-preamble");
    assert.equal(found.tag, tag);
    assertAssistantResultUncontaminated(read, tag);
  } finally {
    await server.close({ signal: "SIGKILL", timeoutMs: 1_000 });
    rmSync(home, { recursive: true, force: true });
  }
});

test("contamination guard fails closed when assistant echoes the marker", () => {
  const tag = buildCorrelationTag({
    profileInstanceId: instanceId,
    deliveryId: 1,
    executionEpoch: 1,
  });
  const contaminated = {
    thread: {
      turns: [
        {
          id: "t1",
          items: [{ type: "agentMessage", id: "a1", text: `echo [[triangle-corr:${tag}]]` }],
        },
      ],
    },
  };
  assert.throws(
    () => assertAssistantResultUncontaminated(contaminated, tag),
    (error) => error.code === "correlation_contaminated_assistant",
  );
});

test("Phase 0 documents a bounded thread/read reconcile window", () => {
  assert.equal(DEFAULT_THREAD_READ_RECONCILE_WINDOW.maxTurns, 8);
  assert.equal(DEFAULT_THREAD_READ_RECONCILE_WINDOW.includeTurns, true);
});
