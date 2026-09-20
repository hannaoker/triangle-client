import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowedApprovalPolicy,
  assertAllowedSandboxMode,
  assertAllowedSandboxPolicy,
  loadRuntimeManifest,
  validateHeadlessCodexConfig,
} from "../../src/codex-runtime/runtime-manifest.mjs";

test("runtime manifest pins sandbox and approval allowlists from schema artifact", () => {
  const manifest = loadRuntimeManifest({ forceReload: true });
  assert.equal(manifest.immutable, true);
  assert.deepEqual(manifest.approvalPolicy.stringEnumAllowlist, [
    "untrusted",
    "on-request",
    "never",
  ]);
  assert.deepEqual(manifest.sandboxMode.stringEnumAllowlist, [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]);
  assert.equal(manifest.approvalPolicy.headlessDefault, "never");
  assert.ok(manifest.provenance.sourceCommit);
  assert.equal(manifest.provenance.bundledCodexBinary, null);
  assert.match(manifest.provenance.gap, /Mini must re-pin/i);
});

test("configuration validation rejects values outside the pinned allowlists", () => {
  assert.equal(assertAllowedApprovalPolicy("never"), "never");
  assert.throws(
    () => assertAllowedApprovalPolicy("always"),
    (error) => error.code === "approval_policy_rejected",
  );
  assert.throws(
    () => assertAllowedApprovalPolicy("on-request", { headless: true }),
    (error) => error.code === "approval_policy_rejected",
  );
  assert.throws(
    () => assertAllowedSandboxMode("danger-full-access", { headless: true }),
    (error) => error.code === "sandbox_mode_rejected",
  );
  assert.equal(assertAllowedSandboxMode("workspace-write"), "workspace-write");
  assert.throws(
    () => assertAllowedSandboxMode("full-access"),
    (error) => error.code === "sandbox_mode_rejected",
  );
  assert.throws(
    () => assertAllowedSandboxPolicy({ type: "dangerFullAccess" }, { headless: true }),
    (error) => error.code === "sandbox_policy_rejected",
  );
  assert.equal(
    assertAllowedSandboxPolicy({ type: "workspaceWrite" }, { headless: true }).type,
    "workspaceWrite",
  );
});

test("validateHeadlessCodexConfig rejects unsupported sandboxClass", () => {
  assert.throws(
    () => validateHeadlessCodexConfig({ sandboxClass: "danger-full-access", approvalPolicy: "never" }),
    (error) => error.code === "sandbox_mode_rejected",
  );
  const ok = validateHeadlessCodexConfig({
    sandboxClass: "read-only",
    approvalPolicy: "never",
  });
  assert.equal(ok.sandboxClass, "read-only");
  assert.equal(ok.approvalPolicy, "never");
});
