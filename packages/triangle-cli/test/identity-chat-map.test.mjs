import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../src/cli.mjs";
import {
  identityChatMapConfirm,
  identityChatMapRevoke,
  identityChatMapSet,
} from "../src/identity-chat-map.mjs";
import { deriveClientInstanceId } from "../../agent-worker/src/identity-primitives.mjs";
import { updateIdentityRegistry } from "../../agent-worker/src/identity-registry.mjs";
import { agentBindingV1, peerBindingV2, upgradeThroughWriter } from "../../agent-worker/test/identity-registry-v2-helpers.mjs";

const PRINCIPAL_MESH = "agent_" + "1".repeat(32);
const PRINCIPAL_PEER = "peer_" + "2".repeat(32);
const SESSION_ADDR = "session-" + "9".repeat(64);
const ORIGIN = "https://triangle.example";

function mkDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.chmodSync(dir, 0o700);
  return dir;
}

const meshBinding = agentBindingV1("claude", {
  principal_id: PRINCIPAL_MESH,
  authority_origin: ORIGIN,
  binding_generation: 1,
});
const peerBinding = peerBindingV2("peer-one", {
  principal_id: PRINCIPAL_PEER,
  binding_generation: 1,
});

function setupRegistry(registryRoot) {
  updateIdentityRegistry({
    root: registryRoot,
    expectedSequence: 0,
    actor: "owner",
    action: "init",
    now: "2026-11-12T00:00:00.000Z",
    mutate: (reg) => reg,
  });
  updateIdentityRegistry({
    root: registryRoot,
    expectedSequence: 1,
    actor: "owner",
    action: "bind",
    subject: meshBinding.profile_instance_id,
    now: "2026-11-12T00:00:00.000Z",
    mutate: (reg) => {
      reg.bindings[meshBinding.profile_instance_id] = meshBinding;
      return reg;
    },
  });
  upgradeThroughWriter(registryRoot, { now: "2026-11-12T00:01:00.000Z" });
}

function mockApprovalProvider() {
  return {
    authenticate() {
      return 'approved';
    },
  };
}

test("identity chat-map set (D5-C), confirm (D5-B), and revoke (D5-C) lifecycle", async () => {
  const root = mkDir("triangle-cli-chat-map-");
  const clientRoot = path.join(root, "app");
  const storeRoot = path.join(clientRoot, "client/local");
  const registryRoot = path.join(clientRoot, "identity");
  const workspace = mkDir("triangle-ws-");
  fs.mkdirSync(clientRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(registryRoot, { recursive: true, mode: 0o700 });
  setupRegistry(registryRoot);
  const realWs = fs.realpathSync(workspace);

  try {
    // CD-2: rejects serverless peer principal
    await assert.rejects(() => identityChatMapSet({
      storeRoot,
      registryRoot,
      principal: PRINCIPAL_PEER,
      harness: "claude",
      workspace: realWs,
    }), { code: "invalid_owner_operation" });

    // 1. Plan & Apply Set (D5-C)
    const setPlan = await identityChatMapSet({
      storeRoot,
      registryRoot,
      principal: PRINCIPAL_MESH,
      harness: "claude",
      workspace: realWs,
    });
    assert.equal(setPlan.action, "set");
    const setRes = await identityChatMapSet({
      storeRoot,
      registryRoot,
      principal: PRINCIPAL_MESH,
      harness: "claude",
      workspace: realWs,
      confirm: setPlan.planId,
      provider: mockApprovalProvider(),
    });
    assert.equal(setRes.state, "pending");
    assert.equal(setRes.sequence, 1);

    // 2. Plan & Apply Confirm (D5-B: requires TTY + exact 1 live session)
    const live = [{ address: SESSION_ADDR, harness: "claude", workspace: realWs }];
    const confirmPlan = await identityChatMapConfirm({
      storeRoot,
      selectorId: setRes.selectorId,
      attachedSessions: live,
    });
    assert.equal(confirmPlan.sessionAddress, SESSION_ADDR);

    await assert.rejects(() => identityChatMapConfirm({
      storeRoot,
      selectorId: setRes.selectorId,
      attachedSessions: live,
      confirm: confirmPlan.planId,
      isTty: false,
    }), { code: "owner_tty_required" });

    const confirmed = await identityChatMapConfirm({
      storeRoot,
      selectorId: setRes.selectorId,
      attachedSessions: live,
      confirm: confirmPlan.planId,
      isTty: true,
    });
    assert.equal(confirmed.state, "confirmed");
    assert.equal(confirmed.sessionAddress, SESSION_ADDR);
    assert.equal(confirmed.sequence, 2);

    // 3. Plan & Apply Revoke via CLI (`main`)
    const outPlan = [];
    const code1 = await main([
      "identity", "chat-map", "revoke",
      "--selector", setRes.selectorId,
      "--client-root", clientRoot,
      "--json",
    ], {
      io: { stdout: (s) => outPlan.push(s), stderr: () => {} },
      env: {},
    });
    assert.equal(code1, 0);
    const revokePlan = JSON.parse(outPlan.join(""));

    const outApply = [];
    const code2 = await main([
      "identity", "chat-map", "revoke",
      "--selector", setRes.selectorId,
      "--client-root", clientRoot,
      "--confirm", revokePlan.planId,
      "--json",
    ], {
      io: { stdout: (s) => outApply.push(s), stderr: () => {} },
      env: {},
      identityDependencies: {
        isTerminal: true,
        chatMapProvider: mockApprovalProvider(),
      },
    });
    assert.equal(code2, 0);
    const revokeRes = JSON.parse(outApply.join(""));
    assert.equal(revokeRes.revoked, true);
    assert.equal(revokeRes.sequence, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
