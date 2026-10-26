import assert from "node:assert/strict";
import test from "node:test";

import {
  createUnifiedRouter,
  resolveSend,
  decorateSend,
  decorateStatus,
  decorateReplies,
  decorateSessions,
  statusBlock,
  RouterResolutionError,
} from "../src/unified-router.mjs";

function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  for (const val of Object.values(obj)) {
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }
  return Object.freeze(obj);
}

const INSTANCE_A = "1111111111111111111111111111111111111111111111111111111111111111";
const INSTANCE_B = "2222222222222222222222222222222222222222222222222222222222222222";
const INSTANCE_C = "3333333333333333333333333333333333333333333333333333333333333333";
const INSTANCE_UNBOUND = "8888888888888888888888888888888888888888888888888888888888888888";
const INSTANCE_FOREIGN = "9999999999999999999999999999999999999999999999999999999999999999";

const AGENT_ID_1 = "agent_0123456789abcdef0123456789abcdef";
const AGENT_ID_2 = "agent_fedcba9876543210fedcba9876543210";
const AGENT_ID_UNKNOWN = "agent_00000000000000000000000000000000";
const PEER_ID_1 = "peer_0123456789abcdef0123456789abcdef";

const SAMPLE_RECIPIENTS = deepFreeze([
  { id: INSTANCE_A, label: "profile-alpha" },
  { id: INSTANCE_B, label: "profile-beta" },
  { id: INSTANCE_C, label: "profile-gamma" },
  { id: INSTANCE_UNBOUND, label: "profile-unbound" },
]);

function createMockSnapshot({
  state = "ok",
  sequence = 1,
  bindings = [],
} = {}) {
  const byPrincipal = new Map();
  const byInstance = new Map();

  for (const b of bindings) {
    if (b.revoked_at === null && b.trust_mode === "mesh-managed") {
      let list = byPrincipal.get(b.principal_id);
      if (!list) {
        list = [];
        byPrincipal.set(b.principal_id, list);
      }
      list.push(b);
      byInstance.set(b.profile_instance_id, b);
    }
  }

  return deepFreeze({
    state,
    sequence,
    errorCode: state === "ok" ? null : "registry_error",
    bindingsFor(principalId) {
      return byPrincipal.get(principalId) ?? [];
    },
    bindingForInstance(instanceId) {
      return byInstance.get(instanceId) ?? null;
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Disabled mode: zero registry reads, no added fields, raw field stripping
// ---------------------------------------------------------------------------
test("Family 1: Disabled mode never reads registry or recipients, passes through, and strips raw journal fields", async () => {
  let snapshotReadCount = 0;
  const throwingSnapshotProvider = {
    get() {
      snapshotReadCount += 1;
      throw new Error("registry must never be read in disabled mode");
    },
  };
  let recipientsCallCount = 0;
  const throwingRecipientsProvider = () => {
    recipientsCallCount += 1;
    throw new Error("directory lookup failed");
  };

  const router = createUnifiedRouter({
    enabled: false,
    snapshotProvider: throwingSnapshotProvider,
    recipients: throwingRecipientsProvider,
    canMessage() {
      throw new Error("canMessage must never be evaluated in disabled mode");
    },
  });

  // 1.1 resolveSend passes through without touching snapshotProvider or recipients
  const legacyRes = await router.resolveSend({ senderId: "sender-1", to: "gravity2" });
  assert.equal(legacyRes.ok, true);
  assert.equal(legacyRes.resolvedTo, "gravity2");
  assert.equal(legacyRes.resolved, false);
  assert.equal(legacyRes.via, null);
  assert.equal(legacyRes.route, null);
  assert.equal(snapshotReadCount, 0, "snapshotProvider must not be accessed");
  assert.equal(recipientsCallCount, 0, "recipients provider must not be accessed");

  const agentRes = await router.resolveSend({ senderId: "sender-1", to: AGENT_ID_1 });
  assert.equal(agentRes.ok, true);
  assert.equal(agentRes.resolvedTo, AGENT_ID_1);
  assert.equal(agentRes.resolved, false);
  assert.equal(snapshotReadCount, 0, "snapshotProvider must not be accessed for agent ID in disabled mode");
  assert.equal(recipientsCallCount, 0, "recipients provider must not be accessed in disabled mode");

  // Contract failure 1 repro: throwing recipients provider on legacy-id
  const reproRes = await router.resolveSend({ to: "legacy-id" });
  assert.equal(reproRes.ok, true);
  assert.equal(reproRes.resolvedTo, "legacy-id");
  assert.equal(reproRes.resolved, false);
  assert.equal(snapshotReadCount, 0);
  assert.equal(recipientsCallCount, 0);

  // 1.2 decorateSend strips raw journal fields, does not add route/state/target even with options
  const rawSendResponse = deepFreeze({
    accepted: true,
    messageId: "msg_123",
    requestId: "req_123",
    status: "queued_local",
    isDuplicate: false,
    to_principal: AGENT_ID_1,
    resolved_via: "principal",
  });

  const decoratedSend = router.decorateSend(rawSendResponse, {
    target: { via: "id", privateMetadata: "SHOULD_NOT_BE_PROJECTED" },
  });
  assert.equal(snapshotReadCount, 0);
  assert.equal(recipientsCallCount, 0);
  assert.equal("to_principal" in decoratedSend, false);
  assert.equal("resolved_via" in decoratedSend, false);
  assert.equal("route" in decoratedSend, false);
  assert.equal("state" in decoratedSend, false);
  assert.equal("target" in decoratedSend, false);
  assert.equal(decoratedSend.accepted, true);
  assert.equal(decoratedSend.messageId, "msg_123");
  assert.equal(decoratedSend.status, "queued_local");

  // 1.3 decorateStatus strips raw journal fields, does not add route/state/target
  const rawStatusResponse = deepFreeze({
    messageId: "msg_123",
    phase: "completed",
    reason: null,
    runtimeError: null,
    hasLateResult: false,
    to_principal: AGENT_ID_1,
    resolved_via: "principal",
  });

  const decoratedStatus = router.decorateStatus(rawStatusResponse, {
    target: { via: "principal", principal: AGENT_ID_1 },
  });
  assert.equal(snapshotReadCount, 0);
  assert.equal(recipientsCallCount, 0);
  assert.equal("to_principal" in decoratedStatus, false);
  assert.equal("resolved_via" in decoratedStatus, false);
  assert.equal("route" in decoratedStatus, false);
  assert.equal("state" in decoratedStatus, false);
  assert.equal("target" in decoratedStatus, false);

  // 1.4 decorateReplies strips raw journal fields, does not add route
  const rawReplies = deepFreeze({
    replies: [
      {
        messageId: "rep_1",
        requestId: "req_123",
        text: "hello",
        to_principal: AGENT_ID_1,
        resolved_via: "principal",
      },
    ],
  });

  const decoratedReplies = router.decorateReplies(rawReplies);
  assert.equal(snapshotReadCount, 0);
  assert.equal(recipientsCallCount, 0);
  assert.equal("to_principal" in decoratedReplies.replies[0], false);
  assert.equal("resolved_via" in decoratedReplies.replies[0], false);
  assert.equal("route" in decoratedReplies.replies[0], false);
  assert.equal(decoratedReplies.replies[0].text, "hello");

  // 1.5 decorateSessions strips raw journal fields, does not add principal
  const rawSessions = deepFreeze({
    sessions: [
      {
        id: INSTANCE_A,
        label: "profile-alpha",
        to_principal: AGENT_ID_1,
        resolved_via: "principal",
      },
    ],
  });

  const decoratedSessions = router.decorateSessions(rawSessions);
  assert.equal(snapshotReadCount, 0);
  assert.equal(recipientsCallCount, 0);
  assert.equal("to_principal" in decoratedSessions.sessions[0], false);
  assert.equal("resolved_via" in decoratedSessions.sessions[0], false);
  assert.equal("principal" in decoratedSessions.sessions[0], false);

  // 1.6 statusBlock returns disabled block without touching snapshotProvider
  const status = router.statusBlock();
  assert.equal(snapshotReadCount, 0, "statusBlock must not touch snapshotProvider when disabled");
  assert.equal(recipientsCallCount, 0);
  assert.deepEqual(status, {
    enabled: false,
    registry: {
      state: "disabled",
      sequence: 0,
    },
    resolved: {
      principal: 0,
      id: 0,
    },
    errors: {
      recipient_not_found: 0,
      route_unavailable: 0,
      recipient_ambiguous: 0,
    },
  });
});

// ---------------------------------------------------------------------------
// 2. Principal resolution: success/absent/unreadable/unknown/peer/no-local/ambiguity
// ---------------------------------------------------------------------------
test("Family 2: Principal resolution outcomes (table-driven)", async () => {
  const singleBinding = {
    binding_id: "bind_1",
    principal_id: AGENT_ID_1,
    profile_instance_id: INSTANCE_A,
    trust_mode: "mesh-managed",
    revoked_at: null,
  };

  const foreignBinding = {
    binding_id: "bind_foreign",
    principal_id: AGENT_ID_2,
    profile_instance_id: INSTANCE_FOREIGN,
    trust_mode: "mesh-managed",
    revoked_at: null,
  };

  const ambiguousBindings = [
    {
      binding_id: "bind_a",
      principal_id: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      profile_instance_id: INSTANCE_A,
      trust_mode: "mesh-managed",
      revoked_at: null,
    },
    {
      binding_id: "bind_b",
      principal_id: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      profile_instance_id: INSTANCE_B,
      trust_mode: "mesh-managed",
      revoked_at: null,
    },
  ];

  const goodSnapshot = createMockSnapshot({
    state: "ok",
    sequence: 42,
    bindings: [singleBinding, foreignBinding, ...ambiguousBindings],
  });

  // 2.1 Success
  const routerOk = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => goodSnapshot },
    recipients: SAMPLE_RECIPIENTS,
  });

  const resOk = await routerOk.resolveSend({ senderId: "sender-1", to: AGENT_ID_1 });
  assert.equal(resOk.ok, true);
  assert.equal(resOk.resolvedTo, INSTANCE_A);
  assert.equal(resOk.via, "principal");
  assert.equal(resOk.principal, AGENT_ID_1);
  assert.equal(resOk.profile, "profile-alpha");
  assert.equal(resOk.bindingId, "bind_1");
  assert.equal(resOk.route, "local");

  // 2.2 Absent snapshot -> recipient_not_found / registry_absent
  const routerAbsent = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => createMockSnapshot({ state: "absent" }) },
    recipients: SAMPLE_RECIPIENTS,
  });
  await assert.rejects(
    () => routerAbsent.resolveSend({ senderId: "sender-1", to: AGENT_ID_1 }),
    (err) => {
      assert(err instanceof RouterResolutionError);
      assert.equal(err.code, "recipient_not_found");
      assert.equal(err.reason, "registry_absent");
      return true;
    }
  );

  // 2.3 Unreadable snapshot -> route_unavailable / registry_unreadable
  const routerUnreadable = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => createMockSnapshot({ state: "unreadable" }) },
    recipients: SAMPLE_RECIPIENTS,
  });
  await assert.rejects(
    () => routerUnreadable.resolveSend({ senderId: "sender-1", to: AGENT_ID_1 }),
    (err) => {
      assert(err instanceof RouterResolutionError);
      assert.equal(err.code, "route_unavailable");
      assert.equal(err.reason, "registry_unreadable");
      return true;
    }
  );

  // 2.3b Provider exception -> route_unavailable
  const routerThrowing = createUnifiedRouter({
    enabled: true,
    snapshotProvider: {
      get() {
        const e = new Error("EACCES");
        e.code = "EACCES";
        throw e;
      },
    },
    recipients: SAMPLE_RECIPIENTS,
  });
  await assert.rejects(
    () => routerThrowing.resolveSend({ senderId: "sender-1", to: AGENT_ID_1 }),
    (err) => {
      assert(err instanceof RouterResolutionError);
      assert.equal(err.code, "route_unavailable");
      assert.equal(err.reason, "EACCES");
      return true;
    }
  );

  // 2.4 Unknown principal (no bindings) -> recipient_not_found / no_binding
  await assert.rejects(
    () => routerOk.resolveSend({ senderId: "sender-1", to: AGENT_ID_UNKNOWN }),
    (err) => {
      assert(err instanceof RouterResolutionError);
      assert.equal(err.code, "recipient_not_found");
      assert.equal(err.reason, "no_binding");
      return true;
    }
  );

  // 2.5 Peer ID -> recipient_not_found / peer_not_supported (snapshot never touched)
  let peerSnapshotTouched = false;
  const routerPeer = createUnifiedRouter({
    enabled: true,
    snapshotProvider: {
      get() {
        peerSnapshotTouched = true;
        return goodSnapshot;
      },
    },
    recipients: SAMPLE_RECIPIENTS,
  });
  await assert.rejects(
    () => routerPeer.resolveSend({ senderId: "sender-1", to: PEER_ID_1 }),
    (err) => {
      assert(err instanceof RouterResolutionError);
      assert.equal(err.code, "recipient_not_found");
      assert.equal(err.reason, "peer_not_supported");
      return true;
    }
  );
  assert.equal(peerSnapshotTouched, false, "snapshot must not be touched for peer ID");

  // 2.6 Binding whose profile is not a local recipient -> route_unavailable / not_a_local_recipient
  await assert.rejects(
    () => routerOk.resolveSend({ senderId: "sender-1", to: AGENT_ID_2 }),
    (err) => {
      assert(err instanceof RouterResolutionError);
      assert.equal(err.code, "route_unavailable");
      assert.equal(err.reason, "not_a_local_recipient");
      return true;
    }
  );

  // 2.7 Ambiguity -> recipient_ambiguous / ambiguous_binding
  await assert.rejects(
    () => routerOk.resolveSend({ senderId: "sender-1", to: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    (err) => {
      assert(err instanceof RouterResolutionError);
      assert.equal(err.code, "recipient_ambiguous");
      assert.equal(err.reason, "ambiguous_binding");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Authorized candidate filtering including throwing predicate
// ---------------------------------------------------------------------------
test("Family 3: Injected canMessage filters ambiguity candidates and fails closed", async () => {
  const bindings = [
    {
      binding_id: "bind_a",
      principal_id: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      profile_instance_id: INSTANCE_A,
      trust_mode: "mesh-managed",
      revoked_at: null,
    },
    {
      binding_id: "bind_b",
      principal_id: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      profile_instance_id: INSTANCE_B,
      trust_mode: "mesh-managed",
      revoked_at: null,
    },
    {
      binding_id: "bind_c",
      principal_id: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      profile_instance_id: INSTANCE_C,
      trust_mode: "mesh-managed",
      revoked_at: null,
    },
  ];

  const snapshot = createMockSnapshot({ state: "ok", bindings });

  // 3.1 canMessage allows INSTANCE_A and INSTANCE_B, denies INSTANCE_C
  const routerFiltered = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => snapshot },
    recipients: SAMPLE_RECIPIENTS,
    canMessage: async (_sender, recipientId) => recipientId === INSTANCE_A || recipientId === INSTANCE_B,
  });

  const err1 = await routerFiltered.resolveSend(
    { senderId: "sender-1", to: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { throwOnError: false }
  );
  assert.equal(err1.ok, false);
  assert.equal(err1.code, "recipient_ambiguous");
  assert.equal(err1.reason, "ambiguous_binding");
  assert.deepEqual(err1.candidates, [
    { id: INSTANCE_A, label: "profile-alpha" },
    { id: INSTANCE_B, label: "profile-beta" },
  ]);

  // 3.2 Throwing predicate: fails closed on thrown error
  const routerThrowingPredicate = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => snapshot },
    recipients: SAMPLE_RECIPIENTS,
    canMessage: (sender, recipientId) => {
      if (recipientId === INSTANCE_A) return true;
      if (recipientId === INSTANCE_B) throw new Error("ACL check failed or timeout");
      return false; // INSTANCE_C
    },
  });

  // CRITICAL: Even when only 1 candidate remains, do NOT arbitrarily resolve it!
  const err2 = await routerThrowingPredicate.resolveSend(
    { senderId: "sender-1", to: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { throwOnError: false }
  );
  assert.equal(err2.ok, false);
  assert.equal(err2.code, "recipient_ambiguous");
  assert.equal(err2.reason, "ambiguous_binding");
  assert.equal(err2.candidates.length, 1);
  assert.deepEqual(err2.candidates, [{ id: INSTANCE_A, label: "profile-alpha" }]);

  // 3.3 Throwing predicate that denies all -> candidates: []
  const routerDenyAll = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => snapshot },
    recipients: SAMPLE_RECIPIENTS,
    canMessage: () => {
      throw new Error("denied");
    },
  });

  const err3 = await routerDenyAll.resolveSend(
    { senderId: "sender-1", to: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { throwOnError: false }
  );
  assert.equal(err3.ok, false);
  assert.equal(err3.code, "recipient_ambiguous");
  assert.deepEqual(err3.candidates, []);

  // 3.4 No canMessage provided -> candidates: [] (fail closed)
  const routerNoCanMessage = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => snapshot },
    recipients: SAMPLE_RECIPIENTS,
    canMessage: null,
  });

  const err4 = await routerNoCanMessage.resolveSend(
    { senderId: "sender-1", to: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { throwOnError: false }
  );
  assert.equal(err4.ok, false);
  assert.equal(err4.code, "recipient_ambiguous");
  assert.deepEqual(err4.candidates, []);
});

// ---------------------------------------------------------------------------
// 4. Legacy / session / Grok IDs preserved
// ---------------------------------------------------------------------------
test("Family 4: Legacy, session, and Grok IDs pass through and never depend on registry", async () => {
  const unreadableSnapshot = createMockSnapshot({ state: "unreadable" });

  const router = createUnifiedRouter({
    enabled: true,
    snapshotProvider: {
      get() {
        return unreadableSnapshot; // Registry is broken!
      },
    },
    recipients: SAMPLE_RECIPIENTS,
  });

  const testIds = [
    INSTANCE_A,
    "gravity2",
    "codex-headless",
    `session-${INSTANCE_A}`,
    "grok:default",
    "grok-local-session",
    "desktop-inbox",
  ];

  for (const id of testIds) {
    const res = await router.resolveSend({ senderId: "sender-1", to: id });
    assert.equal(res.ok, true);
    assert.equal(res.to, id);
    assert.equal(res.resolvedTo, id);
    assert.equal(res.resolved, false);
    assert.equal(res.via, "id");
    assert.equal(res.route, "local");
    // Unreadable registry means no principal fabricated:
    assert.equal(res.principal, null);
  }
});

// ---------------------------------------------------------------------------
// 5. Input immutability
// ---------------------------------------------------------------------------
test("Family 5: Native input DTOs are never mutated", async () => {
  const router = createUnifiedRouter({
    enabled: true,
    snapshotProvider: {
      get: () =>
        createMockSnapshot({
          state: "ok",
          bindings: [
            {
              binding_id: "bind_1",
              principal_id: AGENT_ID_1,
              profile_instance_id: INSTANCE_A,
              trust_mode: "mesh-managed",
              revoked_at: null,
            },
          ],
        }),
    },
    recipients: SAMPLE_RECIPIENTS,
  });

  // Frozen send param
  const sendParam = deepFreeze({
    senderId: "sender-1",
    to: AGENT_ID_1,
    text: "hello",
    messageId: "msg_immut",
  });
  const res = await router.resolveSend(sendParam);
  assert.equal(res.resolvedTo, INSTANCE_A);

  // Frozen sendResponse with raw journal fields
  const sendResponse = deepFreeze({
    accepted: true,
    messageId: "msg_123",
    requestId: "req_123",
    status: "queued_local",
    isDuplicate: false,
    to_principal: AGENT_ID_1,
    resolved_via: "principal",
  });
  const decoratedSend = router.decorateSend(sendResponse, { resolution: res });
  assert.equal(sendResponse.to_principal, AGENT_ID_1, "input must remain untouched");
  assert.equal("to_principal" in decoratedSend, false, "decorated output must be clean");

  // Frozen statusResponse with raw journal fields
  const statusResponse = deepFreeze({
    messageId: "msg_123",
    phase: "executing",
    reason: null,
    runtimeError: null,
    hasLateResult: false,
    to_principal: AGENT_ID_1,
    resolved_via: "principal",
  });
  const decoratedStatus = router.decorateStatus(statusResponse, { resolution: res });
  assert.equal(statusResponse.to_principal, AGENT_ID_1);
  assert.equal("to_principal" in decoratedStatus, false);

  // Frozen replies
  const rawRepliesContainer = deepFreeze({
    replies: [
      deepFreeze({
        messageId: "rep_1",
        text: "hi",
        to_principal: AGENT_ID_1,
        resolved_via: "principal",
      }),
    ],
  });
  const decoratedReplies = router.decorateReplies(rawRepliesContainer);
  assert.equal(rawRepliesContainer.replies[0].to_principal, AGENT_ID_1);
  assert.equal("to_principal" in decoratedReplies.replies[0], false);

  // Frozen sessions
  const rawSessionsContainer = deepFreeze({
    sessions: [
      deepFreeze({
        id: INSTANCE_A,
        label: "profile-alpha",
        to_principal: AGENT_ID_1,
        resolved_via: "principal",
      }),
    ],
  });
  const decoratedSessions = router.decorateSessions(rawSessionsContainer);
  assert.equal(rawSessionsContainer.sessions[0].to_principal, AGENT_ID_1);
  assert.equal("to_principal" in decoratedSessions.sessions[0], false);

  // Target overrides are deep-frozen and never mutated
  const targetOverrideSend = deepFreeze({
    via: "id",
    privateMetadata: "SHOULD_NOT_BE_PROJECTED",
    callerCustomTag: "do-not-mutate",
  });
  const decoratedWithTarget = router.decorateSend(sendResponse, { target: targetOverrideSend });
  assert.equal(targetOverrideSend.privateMetadata, "SHOULD_NOT_BE_PROJECTED");
  assert.equal(targetOverrideSend.callerCustomTag, "do-not-mutate");
  assert.equal("privateMetadata" in decoratedWithTarget.target, false);
  assert.equal("callerCustomTag" in decoratedWithTarget.target, false);

  const targetOverrideStatus = deepFreeze({
    via: "principal",
    principal: AGENT_ID_1,
    profile: "profile-alpha",
    secretMetadata: "SHOULD_NOT_BE_PROJECTED",
  });
  const decoratedStatusWithTarget = router.decorateStatus(statusResponse, { target: targetOverrideStatus });
  assert.equal(targetOverrideStatus.secretMetadata, "SHOULD_NOT_BE_PROJECTED");
  assert.equal("secretMetadata" in decoratedStatusWithTarget.target, false);
});

// ---------------------------------------------------------------------------
// 6. Projected send / status / replies / sessions fields
// ---------------------------------------------------------------------------
test("Family 6: Projected fields match section 3.4 specifications", async () => {
  const snapshot = createMockSnapshot({
    state: "ok",
    bindings: [
      {
        binding_id: "bind_a",
        principal_id: AGENT_ID_1,
        profile_instance_id: INSTANCE_A,
        trust_mode: "mesh-managed",
        revoked_at: null,
      },
    ],
  });

  const router = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => snapshot },
    recipients: SAMPLE_RECIPIENTS,
  });

  // 6.1 Send resolution and decoration for principal
  const resPrincipal = await router.resolveSend({ senderId: "sender-1", to: AGENT_ID_1 });
  const sendResp = router.decorateSend(
    {
      accepted: true,
      messageId: "m1",
      requestId: "r1",
      status: "queued_local",
      isDuplicate: false,
    },
    { resolution: resPrincipal }
  );

  assert.deepEqual(sendResp, {
    accepted: true,
    messageId: "m1",
    requestId: "r1",
    status: "queued_local",
    isDuplicate: false,
    route: "local",
    state: "received", // localState("queued_local") === "received"
    target: {
      via: "principal",
      principal: AGENT_ID_1,
      profile: "profile-alpha",
    },
  });

  // 6.2 Send resolution and decoration for legacy bound ID
  const resLegacyBound = await router.resolveSend({ senderId: "sender-1", to: INSTANCE_A });
  const sendRespLegacy = router.decorateSend(
    {
      accepted: true,
      messageId: "m2",
      requestId: "r2",
      status: "executing",
      isDuplicate: false,
    },
    { resolution: resLegacyBound }
  );

  assert.deepEqual(sendRespLegacy, {
    accepted: true,
    messageId: "m2",
    requestId: "r2",
    status: "executing",
    isDuplicate: false,
    route: "local",
    state: "executing", // localState("executing") === "executing"
    target: {
      via: "id",
      principal: AGENT_ID_1,
      profile: "profile-alpha",
    },
  });

  // 6.3 Status projection for held phase
  const statusHeld = router.decorateStatus(
    {
      messageId: "m3",
      phase: "held",
      reason: "manual_intervention_required",
      runtimeError: null,
      hasLateResult: false,
    },
    { resolution: resPrincipal }
  );

  assert.deepEqual(statusHeld, {
    messageId: "m3",
    phase: "held",
    reason: "manual_intervention_required",
    runtimeError: null,
    hasLateResult: false,
    route: "local",
    state: "held", // localState("held") === "held"
    target: {
      via: "principal",
      principal: AGENT_ID_1,
      profile: "profile-alpha",
    },
  });

  // 6.4 Status projection for completed phase
  const statusCompleted = router.decorateStatus(
    {
      messageId: "m4",
      phase: "completed",
      reason: null,
      runtimeError: null,
      hasLateResult: false,
    },
    { resolution: resPrincipal }
  );
  assert.equal(statusCompleted.state, "completed");

  // 6.5 Replies projection
  const replies = router.decorateReplies({
    replies: [
      { messageId: "rep_1", text: "ok" },
      { messageId: "rep_2", text: "done" },
    ],
  });
  assert.equal(replies.replies[0].route, "local");
  assert.equal(replies.replies[1].route, "local");

  // 6.6 Sessions projection
  const sessions = router.decorateSessions({
    sessions: [
      { id: INSTANCE_A, label: "profile-alpha" },
      { id: INSTANCE_UNBOUND, label: "profile-unbound" },
    ],
  });
  assert.equal(sessions.sessions[0].principal, AGENT_ID_1);
  assert.equal(sessions.sessions[1].principal, null, "unbound session must have principal: null");
});

// ---------------------------------------------------------------------------
// 7. Stale or absent binding makes no fabricated principal
// ---------------------------------------------------------------------------
test("Family 7: Stale, revoked, or absent binding never fabricates a principal", async () => {
  const revokedBinding = {
    binding_id: "bind_revoked",
    principal_id: AGENT_ID_1,
    profile_instance_id: INSTANCE_B,
    trust_mode: "mesh-managed",
    revoked_at: "2026-10-25T00:00:00.000Z", // revoked!
  };

  const snapshot = createMockSnapshot({
    state: "ok",
    bindings: [revokedBinding],
  });

  const router = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => snapshot },
    recipients: SAMPLE_RECIPIENTS,
  });

  // 7.1 Legacy send to INSTANCE_B whose binding is revoked
  const resLegacy = await router.resolveSend({ senderId: "sender-1", to: INSTANCE_B });
  const sendResp = router.decorateSend(
    { accepted: true, messageId: "m_rev", requestId: "r_rev", status: "queued_local", isDuplicate: false },
    { resolution: resLegacy }
  );

  assert.equal(sendResp.target.via, "id");
  assert.equal("principal" in sendResp.target, false, "must not fabricate principal for revoked binding");

  // 7.2 Session with revoked binding has principal: null
  const sessions = router.decorateSessions([
    { id: INSTANCE_B, label: "profile-beta" },
    { id: "unknown_id", label: "unknown" },
  ]);
  assert.equal(sessions[0].principal, null);
  assert.equal(sessions[1].principal, null);

  // 7.3 Status for unbound instance has target.via: "id" with no principal
  const statusResp = router.decorateStatus(
    { messageId: "m_unbound", phase: "completed" },
    { record: { recipient: INSTANCE_UNBOUND } }
  );
  assert.equal(statusResp.target.via, "id");
  assert.equal("principal" in statusResp.target, false);
});

// ---------------------------------------------------------------------------
// 8. In-memory counters and statusBlock
// ---------------------------------------------------------------------------
test("Family 8: Deterministic counters and error accounting", async () => {
  const snapshot = createMockSnapshot({
    state: "ok",
    sequence: 7,
    bindings: [
      {
        binding_id: "bind_a",
        principal_id: AGENT_ID_1,
        profile_instance_id: INSTANCE_A,
        trust_mode: "mesh-managed",
        revoked_at: null,
      },
    ],
  });

  const router = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => snapshot },
    recipients: SAMPLE_RECIPIENTS,
  });

  // Initial counters
  assert.deepEqual(router.getCounters(), {
    resolved: { principal: 0, id: 0 },
    errors: { recipient_not_found: 0, route_unavailable: 0, recipient_ambiguous: 0 },
  });

  // Successful principal resolve
  await router.resolveSend({ senderId: "s1", to: AGENT_ID_1 });
  assert.equal(router.getCounters().resolved.principal, 1);

  // Successful legacy resolve
  await router.resolveSend({ senderId: "s1", to: INSTANCE_A });
  await router.resolveSend({ senderId: "s1", to: "gravity2" });
  assert.equal(router.getCounters().resolved.id, 2);

  // Error: recipient_not_found (unknown agent)
  await router.resolveSend({ senderId: "s1", to: AGENT_ID_UNKNOWN }, { throwOnError: false });
  assert.equal(router.getCounters().errors.recipient_not_found, 1);

  // Error: peer ID (recipient_not_found)
  await router.resolveSend({ senderId: "s1", to: PEER_ID_1 }, { throwOnError: false });
  assert.equal(router.getCounters().errors.recipient_not_found, 2);

  // statusBlock verification
  const block = router.statusBlock();
  assert.deepEqual(block, {
    enabled: true,
    registry: {
      state: "ok",
      sequence: 7,
    },
    resolved: {
      principal: 1,
      id: 2,
    },
    errors: {
      recipient_not_found: 2,
      route_unavailable: 0,
      recipient_ambiguous: 0,
    },
  });

  // Reset counters
  router.resetCounters();
  assert.deepEqual(router.getCounters(), {
    resolved: { principal: 0, id: 0 },
    errors: { recipient_not_found: 0, route_unavailable: 0, recipient_ambiguous: 0 },
  });
});

// ---------------------------------------------------------------------------
// 9. Fake server context plus real resolver (End-to-End Simulation)
// ---------------------------------------------------------------------------
test("Family 9: Fake server context wiring simulating local-messaging-server", async () => {
  const snapshot = createMockSnapshot({
    state: "ok",
    sequence: 15,
    bindings: [
      {
        binding_id: "bind_a",
        principal_id: AGENT_ID_1,
        profile_instance_id: INSTANCE_A,
        trust_mode: "mesh-managed",
        revoked_at: null,
      },
    ],
  });

  // Simulated components
  const aclRules = new Map([
    ["sender-allowed", new Set([INSTANCE_A, "gravity2"])],
    ["sender-denied", new Set()],
  ]);

  const acl = {
    async checkAllowed(sender, recipient) {
      const allowed = aclRules.get(sender);
      if (!allowed || !allowed.has(recipient)) {
        const err = new Error(`Recipient ${recipient} is not permitted`);
        err.code = "recipient_not_allowed";
        throw err;
      }
    },
  };

  const journalDb = new Map();
  const journal = {
    async recordSend({ sender, recipient, messageId, requestId, text, to_principal, resolved_via }) {
      const record = {
        messageId,
        requestId,
        sender,
        recipient,
        text,
        phase: "queued_local",
        isDuplicate: false,
        // In R1.4, journal stores nullable columns to_principal & resolved_via:
        to_principal: to_principal ?? null,
        resolved_via: resolved_via ?? null,
      };
      journalDb.set(messageId, record);
      return record;
    },
    async getRecord(messageId) {
      return journalDb.get(messageId) ?? null;
    },
  };

  let serverEnabled = true;

  const router = createUnifiedRouter({
    enabled: () => serverEnabled,
    snapshotProvider: { get: () => snapshot },
    recipients: SAMPLE_RECIPIENTS,
    canMessage: async (sender, candidateId) => {
      try {
        await acl.checkAllowed(sender, candidateId);
        return true;
      } catch {
        return false;
      }
    },
  });

  // Fake server request handler mimicking local-messaging-server.mjs
  async function fakeServerSendMessage({ senderId, to, text, messageId, requestId }) {
    // 1. Router resolution before ACL
    const resolution = await router.resolveSend({ senderId, to });
    const targetRecipient = resolution.resolvedTo;

    // 2. ACL check on resolved concrete target
    await acl.checkAllowed(senderId, targetRecipient);

    // 3. Journal recordSend (storing resolved metadata internally)
    const record = await journal.recordSend({
      sender: senderId,
      recipient: targetRecipient,
      messageId,
      requestId: requestId || messageId,
      text,
      to_principal: resolution.resolved ? resolution.principal : null,
      resolved_via: resolution.resolved ? resolution.via : "id",
    });

    // 4. Decorate custody receipt
    const rawReceipt = {
      accepted: true,
      messageId: record.messageId,
      requestId: record.requestId,
      status: record.phase,
      isDuplicate: record.isDuplicate,
      // Simulate raw journal fields spreading into response:
      to_principal: record.to_principal,
      resolved_via: record.resolved_via,
    };

    return router.decorateSend(rawReceipt, { resolution, record });
  }

  async function fakeServerGetStatus({ messageId }) {
    const record = await journal.getRecord(messageId);
    if (!record) {
      const err = new Error("not found");
      err.code = "not_found";
      throw err;
    }
    const rawStatus = {
      messageId: record.messageId,
      phase: record.phase,
      reason: null,
      runtimeError: null,
      hasLateResult: false,
      // Leaked journal fields:
      to_principal: record.to_principal,
      resolved_via: record.resolved_via,
    };
    return router.decorateStatus(rawStatus, { record });
  }

  // Test Case A: Successful send to principal ID
  const receipt1 = await fakeServerSendMessage({
    senderId: "sender-allowed",
    to: AGENT_ID_1,
    text: "Hello Principal",
    messageId: "msg_principal_1",
  });

  assert.equal(receipt1.accepted, true);
  assert.equal(receipt1.status, "queued_local");
  assert.equal(receipt1.route, "local");
  assert.equal(receipt1.state, "received");
  assert.deepEqual(receipt1.target, {
    via: "principal",
    principal: AGENT_ID_1,
    profile: "profile-alpha",
  });
  assert.equal("to_principal" in receipt1, false, "to_principal must not leak into receipt");
  assert.equal("resolved_via" in receipt1, false, "resolved_via must not leak into receipt");

  // Journal internally stored to_principal
  const journalRow = await journal.getRecord("msg_principal_1");
  assert.equal(journalRow.recipient, INSTANCE_A);
  assert.equal(journalRow.to_principal, AGENT_ID_1);
  assert.equal(journalRow.resolved_via, "principal");

  // Status check for principal message
  const status1 = await fakeServerGetStatus({ messageId: "msg_principal_1" });
  assert.equal(status1.route, "local");
  assert.equal(status1.state, "received");
  assert.deepEqual(status1.target, {
    via: "principal",
    principal: AGENT_ID_1,
    profile: "profile-alpha",
  });
  assert.equal("to_principal" in status1, false);
  assert.equal("resolved_via" in status1, false);

  // Test Case B: Successful legacy send
  const receipt2 = await fakeServerSendMessage({
    senderId: "sender-allowed",
    to: "gravity2",
    text: "Hello Legacy",
    messageId: "msg_legacy_1",
  });
  assert.equal(receipt2.route, "local");
  assert.equal(receipt2.state, "received");
  assert.equal(receipt2.target.via, "id");

  // Test Case C: ACL rejection on resolved ID
  await assert.rejects(
    () =>
      fakeServerSendMessage({
        senderId: "sender-denied",
        to: AGENT_ID_1, // resolves to INSTANCE_A, which sender-denied cannot message
        text: "Forbidden",
        messageId: "msg_denied_1",
      }),
    (err) => err.code === "recipient_not_allowed"
  );

  // Test Case D: Kill switch (disabled mode dynamically via serverEnabled = false)
  serverEnabled = false;

  const receiptDisabled = await fakeServerSendMessage({
    senderId: "sender-allowed",
    to: "gravity2",
    text: "While disabled",
    messageId: "msg_dis_1",
  });
  assert.equal("route" in receiptDisabled, false);
  assert.equal("state" in receiptDisabled, false);
  assert.equal("target" in receiptDisabled, false);
  assert.equal("to_principal" in receiptDisabled, false);
  assert.equal("resolved_via" in receiptDisabled, false);
});

// ---------------------------------------------------------------------------
// 10. Target override projection, shape validation, and caller payload preservation
// ---------------------------------------------------------------------------
test("Family 10: Target override projection, shape validation, and payload preservation", async () => {
  const router = createUnifiedRouter({
    enabled: true,
    snapshotProvider: { get: () => createMockSnapshot({ state: "ok" }) },
    recipients: SAMPLE_RECIPIENTS,
  });

  // 10.1 decorateSend strips arbitrary fields and raw journal metadata from target override
  // Contract failure 2 repro:
  const sendRepro = router.decorateSend(
    { accepted: true, customHeader: "preserved", text: "outgoing peer message" },
    { target: { via: "id", privateMetadata: "SHOULD_NOT_BE_PROJECTED", to_principal: AGENT_ID_1, resolved_via: "principal" } }
  );
  assert.equal(sendRepro.accepted, true);
  assert.equal(sendRepro.customHeader, "preserved");
  assert.equal(sendRepro.text, "outgoing peer message");
  assert.equal(sendRepro.route, "local");
  assert.equal(sendRepro.state, "received");
  assert.deepEqual(sendRepro.target, { via: "id" });
  assert.equal("privateMetadata" in sendRepro.target, false);
  assert.equal("to_principal" in sendRepro.target, false);
  assert.equal("resolved_via" in sendRepro.target, false);

  // 10.2 decorateStatus strips arbitrary fields from target override
  const statusRepro = router.decorateStatus(
    { messageId: "m_status_1", phase: "completed", peerReplyText: "Preserved reply message text" },
    { target: { via: "principal", principal: AGENT_ID_1, profile: "profile-alpha", privateMetadata: "SHOULD_NOT_BE_PROJECTED", arbitraryLeak: 999 } }
  );
  assert.equal(statusRepro.messageId, "m_status_1");
  assert.equal(statusRepro.peerReplyText, "Preserved reply message text");
  assert.equal(statusRepro.route, "local");
  assert.equal(statusRepro.state, "completed");
  assert.deepEqual(statusRepro.target, {
    via: "principal",
    principal: AGENT_ID_1,
    profile: "profile-alpha",
  });
  assert.equal("privateMetadata" in statusRepro.target, false);
  assert.equal("arbitraryLeak" in statusRepro.target, false);

  // 10.3 Target shape and type validations
  const invalidTargets = [
    "not-an-object",
    null,
    [1, 2, 3],
    { via: "invalid" },
    { via: 123 },
    { via: "id", principal: 123 },
    { via: "id", profile: {} },
  ];

  for (const invalidTarget of invalidTargets) {
    assert.throws(
      () => router.decorateSend({ accepted: true }, { target: invalidTarget }),
      TypeError,
      `decorateSend should throw TypeError for invalid target: ${JSON.stringify(invalidTarget)}`
    );
    assert.throws(
      () => router.decorateStatus({ phase: "completed" }, { target: invalidTarget }),
      TypeError,
      `decorateStatus should throw TypeError for invalid target: ${JSON.stringify(invalidTarget)}`
    );
  }
});
