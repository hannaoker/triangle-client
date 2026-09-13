import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSecretFree,
  findSecretLeak,
  pickAllowedKeys,
  PROFILE_STATUS_ALLOWED_KEYS,
} from "../src/secrets.mjs";

test("findSecretLeak detects mesh_ tokens", () => {
  const hit = findSecretLeak({ note: `mesh_${"a".repeat(64)}` });
  assert.equal(hit.ok, false);
  assert.equal(hit.kind, "mesh_token");
});

test("findSecretLeak detects mesh_watch_ secrets", () => {
  const hit = findSecretLeak("prefix mesh_watch_ABCDEFGHijklmnop suffix");
  assert.equal(hit.ok, false);
  assert.equal(hit.kind, "mesh_watch_secret");
});

test("assertSecretFree allows operator status shapes", () => {
  const status = {
    profile: "research",
    origin: "https://thetriangle.dev",
    agentId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    handle: "research",
    lifecycle: "verified",
    verificationTimestamp: "2026-09-12T00:00:00.000Z",
    operatorAction: "none",
  };
  assert.deepEqual(assertSecretFree(status), status);
});

test("pickAllowedKeys drops unexpected fields and rejects secrets", () => {
  const filtered = pickAllowedKeys(
    {
      profile: "research",
      origin: "https://thetriangle.dev",
      agentId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      handle: "research",
      lifecycle: "verified",
      verificationTimestamp: "2026-09-12T00:00:00.000Z",
      operatorAction: "none",
      unexpected: "drop-me",
    },
    PROFILE_STATUS_ALLOWED_KEYS,
  );
  assert.equal(filtered.unexpected, undefined);
  assert.equal(filtered.profile, "research");
  assert.throws(
    () =>
      pickAllowedKeys(
        { profile: "x", token: `mesh_${"c".repeat(64)}`, lifecycle: "verified" },
        ["profile", "token", "lifecycle"],
      ),
    (error) => error?.code === "secret_leak" || /mesh_token|Refusing/i.test(error?.message),
  );
});
