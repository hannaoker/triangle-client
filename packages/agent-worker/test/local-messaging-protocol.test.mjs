import test from "node:test";
import assert from "node:assert/strict";
import {
  boundRepliesToEnvelope,
  encodeFrame,
  MAX_PAYLOAD_BYTES,
} from "../src/local-messaging-protocol.mjs";

function reply(messageId, text, extra = {}) {
  return {
    messageId,
    sender: "recipient",
    recipient: "sender",
    requestId: `req-${messageId}`,
    inReplyTo: `msg-${messageId}`,
    text,
    metadata: { _loopDepth: 2 },
    consumed: false,
    createdAt: 1,
    updatedAt: 1,
    cursor: "c",
    ...extra,
  };
}

// The real response envelope around the bounded list must always be encodable.
function fits(replies) {
  assert.doesNotThrow(() => encodeFrame({ protocol_version: 1, id: "11111111-1111-4111-8111-111111111111", result: { replies } }));
}

test("replies that fit pass through untouched", () => {
  const replies = [reply("a", "short"), reply("b", "also short")];
  assert.deepEqual(boundRepliesToEnvelope(replies), replies);
});

test("a reply larger than one response is truncated to fit with explicit fields instead of vanishing", () => {
  const text = "x".repeat(300 * 1024);
  const bounded = boundRepliesToEnvelope([reply("big", text), reply("small", "done")]);
  assert.equal(bounded.length, 1, "the listing always makes progress");
  const [first] = bounded;
  assert.equal(first.messageId, "big");
  assert.equal(first.truncated, true);
  assert.equal(first.originalTextBytes, 300 * 1024);
  assert.ok(first.text.length > 200 * 1024 && first.text.length < text.length);
  assert.ok(text.startsWith(first.text));
  fits(bounded);
});

test("truncation never splits a multi-byte character and accounts for JSON escaping", () => {
  for (const unit of ["é", "😀", "\n", '"']) {
    const text = unit.repeat(300 * 1024);
    const [first] = boundRepliesToEnvelope([reply("big", text)]);
    assert.equal(first.truncated, true);
    assert.equal(first.originalTextBytes, Buffer.byteLength(text, "utf8"));
    assert.ok(first.text.isWellFormed(), "no lone surrogate");
    assert.ok(text.startsWith(first.text));
    fits([first]);
  }
});

test("a later reply that does not fit is deferred whole, then truncated only when it alone exceeds a response", () => {
  const small = reply("small", "done");
  const huge = reply("huge", "y".repeat(300 * 1024));
  const firstPage = boundRepliesToEnvelope([small, huge]);
  assert.deepEqual(firstPage, [small], "an earlier reply is never displaced and the next one is not mangled");
  const secondPage = boundRepliesToEnvelope([huge]);
  assert.equal(secondPage.length, 1);
  assert.equal(secondPage[0].truncated, true);
  assert.equal(secondPage[0].originalTextBytes, 300 * 1024);
  const mid = reply("mid", "z".repeat(200 * 1024));
  const filled = boundRepliesToEnvelope([mid, reply("mid2", "z".repeat(100 * 1024))]);
  assert.deepEqual(filled.map((r) => r.messageId), ["mid"], "a reply that merely overflows the page waits for the next one");
  assert.equal(filled[0].truncated, undefined);
  fits(filled);
});

test("oversized metadata cannot defeat progress either", () => {
  const [first] = boundRepliesToEnvelope([reply("meta", "text", { metadata: { blob: "m".repeat(MAX_PAYLOAD_BYTES) } })]);
  assert.equal(first.truncated, true);
  fits([first]);
});
