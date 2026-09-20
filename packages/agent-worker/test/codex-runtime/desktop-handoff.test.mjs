import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDurableConversationStore } from "../../src/codex-runtime/durable-conversation-store.mjs";
import { createDurableConversationRegistry } from "../../src/codex-runtime/conversation-registry.mjs";
import { createExecutionLeaseManager } from "../../src/codex-runtime/execution-lease.mjs";
import {
  createDesktopHandoffController,
  createFakeDesktopOwner,
  resolvePhase4DesktopHandoffConfig,
} from "../../src/codex-runtime/desktop-handoff.mjs";
import { isDesktopHandoffEnabled, loadRuntimeManifest } from "../../src/codex-runtime/index.mjs";

const PROFILE = "a".repeat(64);
const ROOM = `room_${"b".repeat(32)}`;
const THREAD = "thread-handoff-bound-001";
const HEADLESS_OWNER = "headless-owner-1";
const DESKTOP_OWNER = "desktop-owner-1";

const PASSED_MANIFEST = Object.freeze({
  sharedHomeConcurrency: {
    status: "passed",
    forcedPoolSize: 4,
    desktopHandoffEnabled: false,
    fallbackToUserCodexHomeForbidden: true,
  },
  featureFlags: {
    helperConversationStore: false,
    headlessRuntime: false,
    desktopHandoff: false,
  },
});

function tempRoot(prefix = "triangle-handoff-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

async function seedHeadlessIdle({ root, clock, threadId = THREAD }) {
  const store = createDurableConversationStore({
    root,
    enabled: true,
    now: clock.now,
  });
  const registry = createDurableConversationRegistry({
    store,
    now: clock.now,
    profileInstanceId: PROFILE,
  });
  const leaseManager = createExecutionLeaseManager({
    store,
    ownerInstanceId: HEADLESS_OWNER,
    now: clock.now,
    leaseDurationMs: 60_000,
  });
  leaseManager.acquire({ profileInstanceId: PROFILE, runtimeMode: "headless" });
  registry.setThread(PROFILE, ROOM, threadId, { workerSlotId: "slot-1" });
  // Ensure idle with no open delivery.
  registry.upsert(PROFILE, ROOM, {
    executionState: "idle",
    activeDeliveryId: null,
    executionEpoch: 1,
  });
  store.writeProfile({
    ...store.readProfile(PROFILE),
    bound_codex_thread_id: threadId,
  });
  return { store, registry, leaseManager };
}

test("Phase 4 feature gate stays off by default; shadow injection enables handoff", () => {
  assert.equal(isDesktopHandoffEnabled(), false);
  assert.equal(loadRuntimeManifest({ forceReload: true }).featureFlags.desktopHandoff, false);
  assert.equal(
    loadRuntimeManifest({ forceReload: true }).sharedHomeConcurrency.desktopHandoffEnabled,
    false,
  );

  const off = resolvePhase4DesktopHandoffConfig(
    {
      profileId: "codex-shadow-test",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "headless",
      shadowTestProfile: true,
    },
    { manifest: PASSED_MANIFEST },
  );
  assert.equal(off.active, false);
  assert.equal(off.desktopHandoffEnabled, false);

  const on = resolvePhase4DesktopHandoffConfig(
    {
      profileId: "codex-shadow-test",
      runtimeAdapter: "codex-app-server",
      runtimeMode: "headless",
      shadowTestProfile: true,
    },
    { manifest: PASSED_MANIFEST, enableHandoff: true },
  );
  assert.equal(on.active, true);
  assert.equal(on.desktopHandoffEnabled, true);
  assert.equal(on.manifestDesktopHandoffEnabled, false);
});

test("headless→desktop and desktop→headless idle handoff succeed (synthetic desktop)", async () => {
  const root = tempRoot();
  const home = tempRoot("triangle-codex-home-");
  const clock = createClock();
  let desktop = null;
  try {
    const { store, leaseManager } = await seedHeadlessIdle({ root, clock });
    desktop = createFakeDesktopOwner({
      ownerInstanceId: DESKTOP_OWNER,
      codexHome: home,
      now: clock.now,
    });
    const handoff = createDesktopHandoffController({
      store,
      leaseManager,
      profileInstanceId: PROFILE,
      headlessOwnerInstanceId: HEADLESS_OWNER,
      desktopOwner: desktop,
      enabled: true,
      now: clock.now,
    });

    const toDesktop = await handoff.handoffToDesktop({ meshRoomId: ROOM });
    assert.equal(toDesktop.ok, true);
    assert.equal(toDesktop.direction, "headless_to_desktop");
    assert.equal(toDesktop.runtimeMode, "desktop");
    assert.equal(toDesktop.boundThreadId, THREAD);
    assert.equal(desktop.isAdmissionOpen(), true);

    const afterDesktop = store.readProfile(PROFILE);
    assert.equal(afterDesktop.runtime_mode, "desktop");
    assert.equal(afterDesktop.ownership_state, "owned");
    assert.equal(afterDesktop.owner_instance_id, DESKTOP_OWNER);
    assert.equal(afterDesktop.desktop_server_identity, desktop.serverIdentity);
    assert.equal(afterDesktop.chatgpt_attachment_state, "attached");

    // Acquire while owned by desktop must not be stealable by headless without handoff.
    assert.throws(
      () => leaseManager.acquire({ profileInstanceId: PROFILE }),
      (error) => error.code === "lease_conflict",
    );

    const toHeadless = await handoff.handoffToHeadless({
      meshRoomId: ROOM,
      verifyResume: async ({ threadId }) => ({ threadId }),
    });
    assert.equal(toHeadless.ok, true);
    assert.equal(toHeadless.direction, "desktop_to_headless");
    assert.equal(toHeadless.runtimeMode, "headless");

    const afterHeadless = store.readProfile(PROFILE);
    assert.equal(afterHeadless.runtime_mode, "headless");
    assert.equal(afterHeadless.owner_instance_id, HEADLESS_OWNER);
    assert.equal(afterHeadless.ownership_state, "owned");
    assert.equal(afterHeadless.desktop_server_identity, null);
  } finally {
    if (desktop) await desktop.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("handoff rejected while running / non-idle / mid-approval", async () => {
  const root = tempRoot();
  const home = tempRoot("triangle-codex-home-");
  const clock = createClock();
  let desktop = null;
  try {
    const { store, registry, leaseManager } = await seedHeadlessIdle({ root, clock });
    desktop = createFakeDesktopOwner({
      ownerInstanceId: DESKTOP_OWNER,
      codexHome: home,
      now: clock.now,
    });
    const handoff = createDesktopHandoffController({
      store,
      leaseManager,
      profileInstanceId: PROFILE,
      headlessOwnerInstanceId: HEADLESS_OWNER,
      desktopOwner: desktop,
      enabled: true,
      now: clock.now,
    });

    registry.upsert(PROFILE, ROOM, {
      executionState: "admitted",
      activeDeliveryId: "delivery_9",
      executionEpoch: 2,
    });
    registry.upsert(PROFILE, ROOM, { executionState: "running" });
    await assert.rejects(
      () => handoff.handoffToDesktop({ meshRoomId: ROOM }),
      (error) => error.code === "handoff_not_idle",
    );
    assert.equal(store.readProfile(PROFILE).runtime_mode, "headless");
    assert.equal(store.readProfile(PROFILE).ownership_state, "owned");

    // Return to idle, but desktop mid-approval.
    registry.upsert(PROFILE, ROOM, { executionState: "idle", activeDeliveryId: null });
    desktop.setPendingApproval(true);
    await assert.rejects(
      () => handoff.handoffToDesktop({ meshRoomId: ROOM }),
      (error) => error.code === "handoff_approval_pending",
    );

    desktop.setPendingApproval(false);
    desktop.setIdle(false);
    await assert.rejects(
      () => handoff.handoffToDesktop({ meshRoomId: ROOM }),
      (error) => error.code === "handoff_not_idle",
    );
  } finally {
    if (desktop) await desktop.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("attach failure before commit rolls back to headless", async () => {
  const root = tempRoot();
  const home = tempRoot("triangle-codex-home-");
  const clock = createClock();
  let desktop = null;
  try {
    const { store, leaseManager } = await seedHeadlessIdle({ root, clock });
    desktop = createFakeDesktopOwner({
      ownerInstanceId: DESKTOP_OWNER,
      codexHome: home,
      now: clock.now,
    });
    desktop.failNextAttachOnce();
    const handoff = createDesktopHandoffController({
      store,
      leaseManager,
      profileInstanceId: PROFILE,
      headlessOwnerInstanceId: HEADLESS_OWNER,
      desktopOwner: desktop,
      enabled: true,
      now: clock.now,
    });

    const genBefore = store.readProfile(PROFILE).owner_generation;
    await assert.rejects(
      () => handoff.handoffToDesktop({ meshRoomId: ROOM }),
      (error) => error.code === "handoff_desktop_attach_failed",
    );
    const after = store.readProfile(PROFILE);
    assert.equal(after.runtime_mode, "headless");
    assert.equal(after.ownership_state, "owned");
    assert.equal(after.owner_instance_id, HEADLESS_OWNER);
    assert.ok(after.owner_generation > genBefore);
    assert.equal(after.admission_frozen, false);
  } finally {
    if (desktop) await desktop.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("post-commit desktop admission failure retains desktop and freezes admission", async () => {
  const root = tempRoot();
  const home = tempRoot("triangle-codex-home-");
  const clock = createClock();
  let desktop = null;
  try {
    const { store, leaseManager } = await seedHeadlessIdle({ root, clock });
    desktop = createFakeDesktopOwner({
      ownerInstanceId: DESKTOP_OWNER,
      codexHome: home,
      now: clock.now,
    });
    desktop.failNextResumeAdmissionOnce();
    const handoff = createDesktopHandoffController({
      store,
      leaseManager,
      profileInstanceId: PROFILE,
      headlessOwnerInstanceId: HEADLESS_OWNER,
      desktopOwner: desktop,
      enabled: true,
      now: clock.now,
    });

    await assert.rejects(
      () => handoff.handoffToDesktop({ meshRoomId: ROOM }),
      (error) => error.code === "handoff_desktop_resume_admission_failed",
    );
    const after = store.readProfile(PROFILE);
    assert.equal(after.runtime_mode, "desktop");
    assert.equal(after.owner_instance_id, DESKTOP_OWNER);
    assert.equal(after.ownership_state, "owned");
    assert.equal(after.admission_frozen, true);
    assert.equal(desktop.isAdmissionOpen(), false);

    // Normal handoff while frozen must fail closed.
    await assert.rejects(
      () => handoff.handoffToHeadless({ meshRoomId: ROOM, verifyResume: async ({ threadId }) => ({ threadId }) }),
      (error) => error.code === "handoff_admission_frozen",
    );
  } finally {
    if (desktop) await desktop.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("recover-desktop and rollback-headless operator recovery (no live ChatGPT.app)", async () => {
  const root = tempRoot();
  const home = tempRoot("triangle-codex-home-");
  const clock = createClock();
  let desktop = null;
  try {
    const { store, leaseManager } = await seedHeadlessIdle({ root, clock });
    desktop = createFakeDesktopOwner({
      ownerInstanceId: DESKTOP_OWNER,
      codexHome: home,
      chatgptAttached: true,
      now: clock.now,
    });
    const handoff = createDesktopHandoffController({
      store,
      leaseManager,
      profileInstanceId: PROFILE,
      headlessOwnerInstanceId: HEADLESS_OWNER,
      desktopOwner: desktop,
      enabled: true,
      now: clock.now,
    });

    await handoff.handoffToDesktop({ meshRoomId: ROOM });

    // Simulate ChatGPT.app absent while App Server stays healthy.
    desktop.setChatgptAttached(false);
    store.writeProfile({
      ...store.readProfile(PROFILE),
      chatgpt_attachment_state: "absent",
      admission_frozen: true,
    });

    const recovered = await handoff.recoverDesktop({ meshRoomId: ROOM });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.action, "recover-desktop");
    assert.equal(recovered.chatgptAttachmentState, "attached");
    assert.equal(store.readProfile(PROFILE).admission_frozen, false);
    assert.equal(store.readProfile(PROFILE).runtime_mode, "desktop");

    // Force a post-commit freeze again, then operator rollback-headless.
    desktop.failNextResumeAdmissionOnce();
    // Already desktop-owned; simulate freeze after a failed reopen.
    leaseManager.freezeAdmissionAfterCommit({
      profileInstanceId: PROFILE,
      expectedGeneration: store.readProfile(PROFILE).owner_generation,
    });
    assert.equal(store.readProfile(PROFILE).admission_frozen, true);

    const rolled = await handoff.rollbackHeadless({
      meshRoomId: ROOM,
      verifyResume: async ({ threadId }) => {
        assert.equal(threadId, THREAD);
        return { threadId };
      },
    });
    assert.equal(rolled.ok, true);
    assert.equal(rolled.action, "rollback-headless");
    assert.equal(rolled.boundThreadId, THREAD);
    const final = store.readProfile(PROFILE);
    assert.equal(final.runtime_mode, "headless");
    assert.equal(final.owner_instance_id, HEADLESS_OWNER);
    assert.equal(final.admission_frozen, false);
    assert.equal(final.ownership_state, "owned");
  } finally {
    if (desktop) await desktop.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("disabled controller rejects handoff; transferring blocks admit", async () => {
  const root = tempRoot();
  const home = tempRoot("triangle-codex-home-");
  const clock = createClock();
  let desktop = null;
  try {
    const { store, leaseManager } = await seedHeadlessIdle({ root, clock });
    desktop = createFakeDesktopOwner({
      ownerInstanceId: DESKTOP_OWNER,
      codexHome: home,
      now: clock.now,
    });
    const disabled = createDesktopHandoffController({
      store,
      leaseManager,
      profileInstanceId: PROFILE,
      headlessOwnerInstanceId: HEADLESS_OWNER,
      desktopOwner: desktop,
      enabled: false,
      now: clock.now,
    });
    await assert.rejects(
      () => disabled.handoffToDesktop({ meshRoomId: ROOM }),
      (error) => error.code === "handoff_disabled",
    );

    const existing = store.readProfile(PROFILE);
    leaseManager.beginTransfer({
      profileInstanceId: PROFILE,
      expectedGeneration: existing.owner_generation,
      transferOwnerInstanceId: "transfer:test",
      targetRuntimeMode: "desktop",
    });
    assert.throws(
      () => leaseManager.acquire({ profileInstanceId: PROFILE }),
      (error) => error.code === "lease_transferring",
    );
    assert.throws(
      () => leaseManager.renew({ profileInstanceId: PROFILE }),
      (error) => error.code === "lease_transferring",
    );

    const report = createDesktopHandoffController({
      store,
      leaseManager,
      profileInstanceId: PROFILE,
      headlessOwnerInstanceId: HEADLESS_OWNER,
      desktopOwner: desktop,
      enabled: true,
      now: clock.now,
    }).doctor();
    assert.equal(report.ownershipState, "transferring");
    assert.equal(report.boundThreadId, THREAD);
    assert.ok(!JSON.stringify(report).includes("mesh_"));
  } finally {
    if (desktop) await desktop.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("P1: frozen leases reject acquire and renew (same owner)", async () => {
  const root = tempRoot();
  const clock = createClock();
  try {
    const { store, leaseManager } = await seedHeadlessIdle({ root, clock });
    const owned = store.readProfile(PROFILE);
    assert.equal(owned.owner_instance_id, HEADLESS_OWNER);

    leaseManager.freezeAdmissionAfterCommit({
      profileInstanceId: PROFILE,
      expectedGeneration: owned.owner_generation,
    });
    assert.equal(store.readProfile(PROFILE).admission_frozen, true);

    assert.throws(
      () => leaseManager.acquire({ profileInstanceId: PROFILE }),
      (error) => error.code === "handoff_admission_frozen",
    );
    assert.throws(
      () => leaseManager.renew({ profileInstanceId: PROFILE }),
      (error) => error.code === "handoff_admission_frozen",
    );

    // Still frozen after rejected acquire/renew — generation unchanged.
    const after = store.readProfile(PROFILE);
    assert.equal(after.admission_frozen, true);
    assert.equal(after.owner_generation, owned.owner_generation);
    assert.equal(after.ownership_state, "owned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1: recover-desktop fails closed while transferring (does not reopen admission)", async () => {
  const root = tempRoot();
  const home = tempRoot("triangle-codex-home-");
  const clock = createClock();
  let desktop = null;
  try {
    const { store, leaseManager } = await seedHeadlessIdle({ root, clock });
    desktop = createFakeDesktopOwner({
      ownerInstanceId: DESKTOP_OWNER,
      codexHome: home,
      now: clock.now,
    });
    const handoff = createDesktopHandoffController({
      store,
      leaseManager,
      profileInstanceId: PROFILE,
      headlessOwnerInstanceId: HEADLESS_OWNER,
      desktopOwner: desktop,
      enabled: true,
      now: clock.now,
    });

    await handoff.handoffToDesktop({ meshRoomId: ROOM });
    assert.equal(desktop.isAdmissionOpen(), true);
    desktop.pauseAdmission();
    assert.equal(desktop.isAdmissionOpen(), false);

    const owned = store.readProfile(PROFILE);
    assert.equal(owned.runtime_mode, "desktop");
    assert.equal(owned.ownership_state, "owned");

    // Begin desktop→headless transfer: runtime_mode stays desktop while transferring.
    leaseManager.beginTransfer({
      profileInstanceId: PROFILE,
      expectedGeneration: owned.owner_generation,
      transferOwnerInstanceId: "transfer:mid",
      targetRuntimeMode: "headless",
    });
    const mid = store.readProfile(PROFILE);
    assert.equal(mid.ownership_state, "transferring");
    assert.equal(mid.runtime_mode, "desktop");

    await assert.rejects(
      () => handoff.recoverDesktop({ meshRoomId: ROOM }),
      (error) => error.code === "lease_transferring",
    );

    const after = store.readProfile(PROFILE);
    assert.equal(after.ownership_state, "transferring");
    assert.equal(after.runtime_mode, "desktop");
    // Must not clear freeze / reopen admission while transferring.
    assert.equal(desktop.isAdmissionOpen(), false);
    assert.equal(handoff.isAdmissionPaused(), false);
  } finally {
    if (desktop) await desktop.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("P2: rejected handoffToHeadless (wrong mode) leaves desktop admission open", async () => {
  const root = tempRoot();
  const home = tempRoot("triangle-codex-home-");
  const clock = createClock();
  let desktop = null;
  try {
    const { store, leaseManager } = await seedHeadlessIdle({ root, clock });
    desktop = createFakeDesktopOwner({
      ownerInstanceId: DESKTOP_OWNER,
      codexHome: home,
      now: clock.now,
    });
    // Simulate desktop already admitting while profile is still headless-owned.
    desktop.resumeAdmission();
    assert.equal(desktop.isAdmissionOpen(), true);

    const handoff = createDesktopHandoffController({
      store,
      leaseManager,
      profileInstanceId: PROFILE,
      headlessOwnerInstanceId: HEADLESS_OWNER,
      desktopOwner: desktop,
      enabled: true,
      now: clock.now,
    });

    await assert.rejects(
      () =>
        handoff.handoffToHeadless({
          meshRoomId: ROOM,
          verifyResume: async ({ threadId }) => ({ threadId }),
        }),
      (error) => error.code === "handoff_wrong_mode",
    );

    assert.equal(store.readProfile(PROFILE).runtime_mode, "headless");
    assert.equal(store.readProfile(PROFILE).ownership_state, "owned");
    assert.equal(handoff.isAdmissionPaused(), false);
    assert.equal(desktop.isAdmissionOpen(), true);
  } finally {
    if (desktop) await desktop.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("P2: rejected handoffToDesktop (wrong mode) does not pause desktop admission", async () => {
  const root = tempRoot();
  const home = tempRoot("triangle-codex-home-");
  const clock = createClock();
  let desktop = null;
  try {
    const { store, leaseManager } = await seedHeadlessIdle({ root, clock });
    desktop = createFakeDesktopOwner({
      ownerInstanceId: DESKTOP_OWNER,
      codexHome: home,
      now: clock.now,
    });
    const handoff = createDesktopHandoffController({
      store,
      leaseManager,
      profileInstanceId: PROFILE,
      headlessOwnerInstanceId: HEADLESS_OWNER,
      desktopOwner: desktop,
      enabled: true,
      now: clock.now,
    });
    await handoff.handoffToDesktop({ meshRoomId: ROOM });
    assert.equal(desktop.isAdmissionOpen(), true);

    await assert.rejects(
      () => handoff.handoffToDesktop({ meshRoomId: ROOM }),
      (error) => error.code === "handoff_wrong_mode",
    );
    assert.equal(handoff.isAdmissionPaused(), false);
    assert.equal(desktop.isAdmissionOpen(), true);
    assert.equal(store.readProfile(PROFILE).runtime_mode, "desktop");
  } finally {
    if (desktop) await desktop.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
