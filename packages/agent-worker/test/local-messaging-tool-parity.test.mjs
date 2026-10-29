import test from "node:test";
import assert from "node:assert/strict";
import { MCP_TOOLS as BOUND } from "../src/local-messaging-mcp-adapter.mjs";
import { CLAUDE_MCP_TOOLS as CLAUDE, CODEX_MCP_TOOLS as CODEX } from "../src/claude-session-mcp-child.mjs";
import { STATUS_TOOL_DESCRIPTION } from "../src/local-messaging-protocol.mjs";

// The agent-facing tools exist on three MCP surfaces: the Desktop-bound Codex adapter (BOUND), attached Claude chats
// (CLAUDE) and attached Codex chats (CODEX). They keep one contract. Every intended difference is listed below;
// any other difference in tool names, argument names or required fields, or a listed difference that stops being
// true, fails this test. Argument types, descriptions (except the status tool's) and additionalProperties are not compared.
const BOUND_ONLY_TOOLS = ["triangle_cancel_message"];
const CODEX_ONLY_TOOLS = ["triangle_attach_session"];
// Attached chats generate idempotency IDs and default the generation; the bound adapter keeps requiring them.
const BOUND_EXTRA_REQUIRED = {
  triangle_claim_message: ["claimId"],
  triangle_reply_message: ["replyId"],
  triangle_ack_notification: ["generation"],
};

const names = (tools) => tools.map((tool) => tool.name).sort();
const required = (tool) => [...(tool.inputSchema.required ?? [])].sort();
const properties = (tool) => Object.keys(tool.inputSchema.properties ?? {}).sort();
const index = (tools) => new Map(tools.map((tool) => [tool.name, tool]));

test("the three surfaces expose the same tools apart from the listed exceptions", () => {
  assert.deepEqual(names(BOUND).filter((name) => !BOUND_ONLY_TOOLS.includes(name)), names(CLAUDE));
  assert.deepEqual(names(CODEX).filter((name) => !CODEX_ONLY_TOOLS.includes(name)), names(CLAUDE));
  for (const name of BOUND_ONLY_TOOLS) assert.ok(index(BOUND).has(name) && !index(CLAUDE).has(name), name);
  for (const name of CODEX_ONLY_TOOLS) assert.ok(index(CODEX).has(name) && !index(CLAUDE).has(name), name);
});

test("shared tools take the same arguments on every surface, except the bound adapter's stricter idempotency IDs", () => {
  const bound = index(BOUND);
  const codex = index(CODEX);
  for (const [name, tool] of index(CLAUDE)) {
    assert.deepEqual(properties(bound.get(name)), properties(tool), `${name} properties (bound)`);
    assert.deepEqual(properties(codex.get(name)), properties(tool), `${name} properties (codex)`);
    assert.deepEqual(required(codex.get(name)), required(tool), `${name} required (codex)`);
    assert.deepEqual(
      required(bound.get(name)),
      [...required(tool), ...(BOUND_EXTRA_REQUIRED[name] ?? [])].sort(),
      `${name} required (bound)`,
    );
  }
  const claude = index(CLAUDE);
  for (const [name, extra] of Object.entries(BOUND_EXTRA_REQUIRED)) {
    for (const argument of extra) {
      assert.ok(!required(claude.get(name)).includes(argument), `${name}.${argument} is no longer an exception`);
      assert.ok(properties(claude.get(name)).includes(argument), `${name}.${argument} must stay an accepted argument`);
    }
  }
});

test("triangle_get_status is one verb: messageId optional everywhere and one shared description", () => {
  for (const [label, tools] of [["bound", BOUND], ["claude", CLAUDE], ["codex", CODEX]]) {
    const status = index(tools).get("triangle_get_status");
    assert.deepEqual(required(status), [], `${label} requires no argument`);
    assert.deepEqual(properties(status), ["messageId"], label);
    assert.ok(status.description.startsWith(STATUS_TOOL_DESCRIPTION), `${label} description starts from the shared text`);
  }
});
