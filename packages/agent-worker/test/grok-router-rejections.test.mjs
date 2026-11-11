// AD.1: a Grok bot learns from the CLI's `state` whether a send was refused or its outcome is unknown. A resolution failure that stays
// true until the owner changes something is on the refused side; before aliases the list lacked them. `route_unavailable` is not: it also
// covers a registry that could not be read for a moment, and a retry of a send that was admitted meets the same resolution first.
import assert from "node:assert/strict";
import test from "node:test";

import { GROK_REJECTED_CODES } from "../src/grok-local-session.mjs";
import { createUnifiedRouter } from "../src/unified-router.mjs";

const hex = (char) => char.repeat(64);
const BOB = hex("b");
const CHARLIE = hex("c");
const DAVE = hex("d");
const ERIN = hex("f");
const REMOTE = hex("e");
const P_BOB = `agent_${"1".repeat(32)}`;
const P_REMOTE = `agent_${"3".repeat(32)}`;
const P_SHARED = `agent_${"4".repeat(32)}`;
const RECIPIENTS = [BOB, CHARLIE, DAVE, ERIN].map((id, i) => ({ id, label: ["bob", "charlie", "dave", "erin"][i] }));
const binding = (instance, principal) => ({ binding_id: `bind_${instance.slice(0, 32)}`, principal_id: principal, profile_instance_id: instance, trust_mode: "mesh-managed", revoked_at: null });

function snapshot(state = "ok") {
  const bindings = [binding(BOB, P_BOB), binding(DAVE, P_SHARED), binding(ERIN, P_SHARED), binding(REMOTE, P_REMOTE)];
  const aliases = new Map([["charlie", P_BOB]]);
  return {
    state,
    sequence: 1,
    bindingsFor: (principal) => bindings.filter((item) => item.principal_id === principal),
    bindingForInstance: (instance) => bindings.find((item) => item.profile_instance_id === instance) ?? null,
    aliasFor: (name) => aliases.get(name) ?? null,
    aliasesFor: () => [],
  };
}

test("every durable way the router can fail a send before admitting it counts as a rejection for a Grok bot; an unreadable route does not", async () => {
  const router = (snap) => createUnifiedRouter({ enabled: true, snapshotProvider: { get: () => snap }, recipients: RECIPIENTS, canMessage: async () => true });
  const codes = new Set();
  const attempts = [
    [snapshot(), `peer_${"7".repeat(32)}`],
    [snapshot(), `agent_${"8".repeat(32)}`], // unknown principal
    [snapshot(), P_REMOTE], // bound, but not a local recipient
    [snapshot("unreadable"), P_BOB], // a registry that cannot be read
    [snapshot(), P_SHARED], // two local profiles
    [snapshot(), "charlie"], // an alias that is also a label
  ];
  for (const [snap, to] of attempts) {
    const result = await router(snap).resolveSend({ senderId: "s1", to }, { throwOnError: false });
    assert.equal(result.ok, false, to);
    codes.add(result.code);
  }
  assert.deepEqual([...codes].sort(), ["alias_unresolved", "recipient_ambiguous", "recipient_not_found", "route_unavailable"]);
  for (const code of ["alias_unresolved", "recipient_ambiguous", "recipient_not_found"]) assert.ok(GROK_REJECTED_CODES.includes(code), code);
  assert.equal(GROK_REJECTED_CODES.includes("route_unavailable"), false, "may be a registry read that fails once: the bot keeps the ids and asks again");
});

test("the codes that were refusals before stay refusals, and an unknown or transport error is still an unknown outcome", () => {
  for (const code of ["recipient_not_allowed", "invalid_params", "invalid_request", "payload_too_large", "rate_limit_exceeded", "loop_limit_exceeded", "session_disabled", "session_offline", "generation_fenced"]) {
    assert.ok(GROK_REJECTED_CODES.includes(code), code);
  }
  for (const code of ["send_failed", "connection_timeout", "internal_error", "unknown_error", "duplicate_id_conflict", "route_unavailable"]) {
    assert.equal(GROK_REJECTED_CODES.includes(code), false, code);
  }
  assert.equal(Object.isFrozen(GROK_REJECTED_CODES), true);
});
