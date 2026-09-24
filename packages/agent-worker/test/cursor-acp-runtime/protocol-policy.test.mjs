import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAcpMode,
  extractAcpAssistantText,
  resolveWorkloadMode,
} from "../../src/cursor-acp-runtime/acp-protocol.mjs";
import { createUnattendedAcpPolicy } from "../../src/cursor-acp-runtime/unattended-policy.mjs";

test("workload policy maps conversational→ask and tools→agent", () => {
  assert.equal(resolveWorkloadMode("conversational"), "ask");
  assert.equal(resolveWorkloadMode("tools"), "agent");
  assert.equal(resolveWorkloadMode("planning"), "plan");
  assert.equal(assertAcpMode("ask"), "ask");
  assert.throws(() => resolveWorkloadMode("always-ask"), { code: "acp_workload_invalid" });
});

test("unattended policy answers permission + blocking cursor/*", () => {
  const policy = createUnattendedAcpPolicy();
  const permission = policy.answer("session/request_permission", {
    options: [
      { optionId: "allow-once" },
      { optionId: "reject-once" },
    ],
  });
  assert.deepEqual(permission.result.outcome, {
    outcome: "selected",
    optionId: "allow-once",
  });

  const ask = policy.answer("cursor/ask_question", {});
  assert.equal(ask.result.outcome.outcome, "skipped");

  const plan = policy.answer("cursor/create_plan", {});
  assert.equal(plan.result.outcome.outcome, "rejected");

  assert.equal(policy.answer("session/update"), null);
});

test("extractAcpAssistantText joins agent_message_chunk updates", () => {
  const text = extractAcpAssistantText([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
  ]);
  assert.equal(text, "hello world");
});
