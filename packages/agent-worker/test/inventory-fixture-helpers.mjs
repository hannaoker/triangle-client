// Shared fixture builders for the doctor inventory tests. Records are shaped
// exactly as the Swift helper persists them, so the inventory's strict
// mirrors of the Swift decoders accept them.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const FIXTURE_INSTALLATION_ID = "inst_fixture_installation_01";

const TMP_ROOT = realpathSync(tmpdir());

/**
 * Swift stores refuse records unless every managed directory is 0700 and the
 * file is 0600, so fixture writes under the temp root keep that custody.
 */
export function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  if (!filePath.startsWith(`${TMP_ROOT}${path.sep}`)) return;
  for (let dir = path.dirname(filePath); dir.startsWith(`${TMP_ROOT}${path.sep}`); dir = path.dirname(dir)) {
    chmodSync(dir, 0o700);
  }
}

export function writeInstallationIdentity(client, installationId = FIXTURE_INSTALLATION_ID) {
  writeJson(path.join(client, "installation.json"), { version: 1, installationId });
}

const hex32 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** The agent id a fixture binding for `profile` resolves to. */
export function boundAgentId(profile) {
  return `agent_${hex32(`agent:${profile}`)}`;
}

/** `triangle` custody root used by fixture bindings (a sibling of the app root). */
export function fixtureTriangleHome(app) {
  return path.join(path.dirname(app), "triangle-home");
}

export function bindingFile(app, profile) {
  return path.join(app, "profiles-v1", `profile-${Buffer.from(profile, "utf8").toString("hex")}.json`);
}

/**
 * A permissions v1 helper binding as Swift `FileV1ProfileBindingStore` and
 * `triangle` custody persist them: `profiles-v1/profile-<hex>.json` -> the agent's
 * `workload-key.json` beside its `agent.json`. The key is a placeholder; the
 * inventory never opens it.
 * Overrides: `binding` (merged into the pointer record), `agent` (merged into
 * agent.json), `omitKey`, `permissions` (`{ revision, permissions }` cache view).
 */
export function writeBinding(app, profile, { binding = {}, agent = {}, omitKey = false, permissions = null } = {}) {
  const agentId = boundAgentId(profile);
  const home = fixtureTriangleHome(app);
  const agentDir = path.join(home, "agents", agentId);
  const keyFile = path.join(agentDir, "workload-key.json");
  const handle = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(profile) && profile.length >= 3 && profile.length <= 32 ? profile : `agent-${hex32(profile).slice(0, 8)}`;
  writeJson(path.join(agentDir, "agent.json"), {
    agent_id: agentId,
    handle,
    name: profile,
    workload_id: `workload_${hex32(`workload:${profile}`)}`,
    bounds: ["agent.read", "agent.write"],
    authority: "https://example.test",
    created_at: "2026-10-18T00:00:00.000Z",
    ...agent,
  });
  if (!omitKey) writeJson(keyFile, { kty: "OKP", crv: "Ed25519", x: "fixture-not-a-key", d: "fixture-not-a-key" });
  if (permissions) writePermissionsCache(app, profile, permissions);
  writeJson(bindingFile(app, profile), { version: 1, keyFile, ...binding });
  return { agentId, keyFile, home };
}

export function writePermissionsCache(app, profile, { revision = 1, permissions = {} } = {}) {
  const agentId = boundAgentId(profile);
  writeJson(path.join(fixtureTriangleHome(app), "cache", "permissions", `${agentId}.json`), {
    etag: `W/"${revision}"`,
    view: { agent_id: agentId, revision, permissions },
  });
}

function txnDigest(prefix, domain, instanceId, deliveryId) {
  const hash = createHash("sha256");
  hash.update(domain);
  hash.update(Buffer.from([0]));
  hash.update(instanceId);
  hash.update(Buffer.from([0]));
  hash.update(String(deliveryId));
  return prefix + hash.digest("hex").slice(0, 32);
}

/** A Swift-valid MailboxOpenTransaction for `instanceId`. */
export function openTransactionRecord(instanceId, {
  deliveryId = 7,
  state = "claimed",
  failureCount = 0,
  lastFailureReason = null,
  createdAt = "2026-10-17T19:50:00.000Z",
  protocol = "coordinator-delivery-v1",
} = {}) {
  return {
    version: 1,
    instanceId,
    protocol,
    deliveryId,
    roomId: `room_${"a".repeat(32)}`,
    inboundEventId: null,
    inboundRoomSequence: null,
    replyRequired: true,
    claimId: txnDigest("claim_", "triangle-claim-v1", instanceId, deliveryId),
    replyIdempotencyKey: txnDigest("reply_", "triangle-reply-v1", instanceId, deliveryId),
    state,
    replyEventId: null,
    replyResolution: "none",
    failureCount,
    lastFailureReason,
    createdAt,
  };
}

/** A structurally valid worker runtime manifest (content-addressed bundle dir). */
export function writeWorkerManifest(app, adapter) {
  const cli = { codex: "CODEX_CLI", hermes: "HERMES_CLI", antigravity: "ANTIGRAVITY_CLI" }[adapter];
  const projectRoot = path.join(app, "worker-runtime", "bundles", createHash("sha256").update(`bundle:${adapter}`).digest("hex"));
  mkdirSync(path.join(projectRoot, "bin"), { recursive: true });
  writeJson(path.join(app, "worker-runtime", `${adapter}.manifest.json`), {
    version: 7,
    nodeSHA256: "0".repeat(64),
    projectRoot,
    environment: {
      PATH: `${projectRoot}/bin:/usr/bin:/bin`,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TRIANGLE_PROJECT_ROOT: projectRoot,
      TRIANGLE_RUNTIME_ROOTS: "",
      [cli]: "/usr/bin/true",
    },
    artifacts: { "packages/agent-worker/src/a.mjs": "0".repeat(64) },
  });
  return projectRoot;
}

/**
 * Give the registry the custody Swift `FileClientInstanceStore` requires:
 * application, client, and instances directories 0700; registry files 0600.
 */
export function secureRegistry(app) {
  const client = path.join(app, "client");
  const instances = path.join(client, "instances");
  for (const dir of [app, client, instances]) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }
  for (const name of readdirSync(instances)) chmodSync(path.join(instances, name), 0o600);
}
