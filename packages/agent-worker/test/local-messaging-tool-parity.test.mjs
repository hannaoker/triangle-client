import test from "node:test";
import assert from "node:assert/strict";
import { MCP_TOOLS as BOUND } from "../src/local-messaging-mcp-adapter.mjs";
import { CLAUDE_MCP_TOOLS as CLAUDE, CODEX_MCP_TOOLS as CODEX } from "../src/claude-session-mcp-child.mjs";
import {
  STATUS_TOOL_DESCRIPTION,
  LIST_RECIPIENTS_TOOL_DESCRIPTION,
  SEND_TOOL_DESCRIPTION,
  SEND_TOOL_ARGUMENT_DESCRIPTIONS,
} from "../src/local-messaging-protocol.mjs";

// The agent-facing tools exist on three MCP surfaces: the Desktop-bound Codex adapter (BOUND), attached Claude chats
// (CLAUDE) and attached Codex chats (CODEX). They keep one contract. Every intended difference is listed below;
// any other difference in tool names, argument names, required fields, argument types, descriptions or
// unknown-argument policy, or a listed difference that stops being true, fails this test.
const BOUND_ONLY_TOOLS = ["triangle_cancel_message"];
const CODEX_ONLY_TOOLS = ["triangle_attach_session"];
// Attached chats generate idempotency IDs and default the generation; the bound adapter keeps requiring them.
const BOUND_EXTRA_REQUIRED = {
  triangle_claim_message: ["claimId"],
  triangle_reply_message: ["replyId"],
  triangle_ack_notification: ["generation"],
};
// The bound adapter serves one explicitly enabled Codex conversation and attached chats an interactive session, so
// these tools describe themselves differently. Every other shared tool has one tool text everywhere.
const TOOL_TEXT_EXCEPTIONS = [
  "triangle_list_inbox",
  "triangle_claim_message",
  "triangle_reply_message",
  "triangle_ack_notification",
  "triangle_get_status", // starts from the shared text (checked below); the bound adapter and Codex chats append a sentence
];
// On these tools the bound adapter declares no argument text at all while attached chats describe every argument.
// Argument text is compared everywhere else, including on the tools above whose tool text differs.
const BOUND_UNDESCRIBED_ARGUMENTS = {
  triangle_list_inbox: ["limit", "cursor"],
  triangle_claim_message: ["messageId", "claimId"],
  triangle_reply_message: ["messageId", "claimToken", "replyId", "text"],
};
// The bound adapter declares closed schemas (additionalProperties: false) on its Codex-conversation inbox tools and
// attached chats leave them open. This is the declared schema only: the bound handlers ignore unknown keys.
const BOUND_CLOSED_SCHEMAS = ["triangle_list_inbox", "triangle_claim_message", "triangle_reply_message"];

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

test("shared arguments have the same type and constraints on every surface", () => {
  const bound = index(BOUND);
  const codex = index(CODEX);
  const shape = (tool, argument) => {
    const { description, ...constraints } = tool.inputSchema.properties[argument];
    return constraints;
  };
  for (const [name, tool] of index(CLAUDE)) {
    for (const argument of properties(tool)) {
      assert.ok(shape(tool, argument).type, `${name}.${argument} declares a type`);
      assert.deepEqual(shape(bound.get(name), argument), shape(tool, argument), `${name}.${argument} (bound)`);
      assert.deepEqual(shape(codex.get(name), argument), shape(tool, argument), `${name}.${argument} (codex)`);
    }
  }
});

test("shared tools and arguments are described identically, except the listed differences", () => {
  const bound = index(BOUND);
  const codex = index(CODEX);
  const claude = index(CLAUDE);
  const argumentText = (tool, argument) => tool.inputSchema.properties[argument].description;
  for (const [name, tool] of claude) {
    // Codex chats reuse the Claude tool objects and only add a sentence to the status text about attaching on first use.
    if (name !== "triangle_get_status") assert.equal(codex.get(name).description, tool.description, `${name} text (codex)`);
    if (!TOOL_TEXT_EXCEPTIONS.includes(name)) assert.equal(bound.get(name).description, tool.description, `${name} text (bound)`);
    for (const argument of properties(tool)) {
      assert.equal(argumentText(codex.get(name), argument), argumentText(tool, argument), `${name}.${argument} text (codex)`);
      if (!(BOUND_UNDESCRIBED_ARGUMENTS[name] ?? []).includes(argument)) {
        assert.equal(argumentText(bound.get(name), argument), argumentText(tool, argument), `${name}.${argument} text (bound)`);
      }
    }
  }
  for (const name of TOOL_TEXT_EXCEPTIONS) {
    assert.notEqual(bound.get(name).description, claude.get(name).description, `${name} is no longer a tool text exception`);
  }
  assert.notEqual(codex.get("triangle_get_status").description, claude.get("triangle_get_status").description, "codex status text is no longer an exception");
  for (const [name, argumentNames] of Object.entries(BOUND_UNDESCRIBED_ARGUMENTS)) {
    for (const argument of argumentNames) {
      assert.equal(argumentText(bound.get(name), argument), undefined, `${name}.${argument} is no longer undescribed on the bound adapter`);
      assert.ok(argumentText(claude.get(name), argument), `${name}.${argument} must stay described on attached chats`);
    }
  }
});

test("the declared unknown-argument policy matches on every surface, except the bound inbox tools that declare a closed schema", () => {
  const bound = index(BOUND);
  const codex = index(CODEX);
  const claude = index(CLAUDE);
  for (const [name, tool] of claude) {
    assert.equal(codex.get(name).inputSchema.additionalProperties, tool.inputSchema.additionalProperties, `${name} (codex)`);
    if (BOUND_CLOSED_SCHEMAS.includes(name)) continue;
    assert.equal(bound.get(name).inputSchema.additionalProperties, tool.inputSchema.additionalProperties, `${name} (bound)`);
  }
  for (const name of BOUND_CLOSED_SCHEMAS) {
    assert.equal(bound.get(name).inputSchema.additionalProperties, false, `${name} stays closed on the bound adapter`);
    assert.equal(claude.get(name).inputSchema.additionalProperties, undefined, `${name} is no longer an exception`);
  }
});

test("discovery and send share one contract text that names principals and the unsupported peer form", () => {
  for (const [label, tools] of [["bound", BOUND], ["claude", CLAUDE], ["codex", CODEX]]) {
    const byName = index(tools);
    assert.equal(byName.get("triangle_list_recipients").description, LIST_RECIPIENTS_TOOL_DESCRIPTION, label);
    const send = byName.get("triangle_send_message");
    assert.equal(send.description, SEND_TOOL_DESCRIPTION, label);
    assert.deepEqual(Object.keys(SEND_TOOL_ARGUMENT_DESCRIPTIONS).sort(), properties(send), `${label} send arguments`);
    for (const [argument, text] of Object.entries(SEND_TOOL_ARGUMENT_DESCRIPTIONS)) {
      assert.equal(send.inputSchema.properties[argument].description, text, `${label} ${argument}`);
    }
  }
  assert.match(LIST_RECIPIENTS_TOOL_DESCRIPTION, /entries/);
  assert.match(LIST_RECIPIENTS_TOOL_DESCRIPTION, /principal/);
  assert.match(SEND_TOOL_ARGUMENT_DESCRIPTIONS.to, /agent_/);
  assert.match(SEND_TOOL_ARGUMENT_DESCRIPTIONS.to, /peer_/);
  assert.match(SEND_TOOL_DESCRIPTION, /SAME messageId and requestId/);
});
