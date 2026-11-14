// `triangle identity destination set|clear` (AD.5): the owner configures a default (harness, workspace) destination
// for an active MESH-managed principal (`agent_<32-hex>`) that is not served by a local runner or paired session.
// Both commands plan first and apply with `--confirm PLAN_ID` through D5-C OS owner authentication.
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { canonicalJson } from "./canonical.mjs";
import { LocalStateError } from "./errors.mjs";
import { readLocalRecipients } from "./identity-alias.mjs";
import { identityInventory } from "./identity-inventory.mjs";
import { printable, shellQuote } from "./identity-upgrade.mjs";
import { createOwnerApprovalCoordinator, describeOwnerOperation, normalizeOwnerOperation } from "./owner-approval.mjs";
import { loadPackagedOwnerApprovalProvider } from "./owner-approval-package.mjs";

export const DESTINATION_PLAN_SCHEMA = "identity_destination_plan_v1";
export const DESTINATION_RESULT_SCHEMA = "identity_destination_result_v1";
export const MAX_DESTINATIONS = 256;

const SCHEMA_V1 = "identity_registry_v1";
const SCHEMA_V2 = "identity_registry_v2";
const AGENT_ID = /^agent_[a-f0-9]{32}$/;
const PEER_ID = /^peer_[a-f0-9]{32}$/;
const PLAN_ID = /^[a-f0-9]{64}$/;
const MESH_MANAGED = "mesh-managed";
const RUNNER_DELIVERY_MODES = new Set([
  "worker",
  "headless-app-server",
  "headless-cursor-acp",
  "event-driven",
  "grok-bot",
  "mcp-interactive",
]);

function fail(code, message = code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safe = (value) => printable(value).replace(/\p{Cf}/gu, "?");
const isActiveMesh = (binding) => binding.trust_mode === MESH_MANAGED && binding.revoked_at === null;

async function loadWorker(deps) {
  try {
    return {
      registry: deps.registry ?? (await import("../../agent-worker/src/identity-registry.mjs")),
      primitives: await import("../../agent-worker/src/identity-primitives.mjs"),
      view: await import("../../agent-worker/src/identity-view.mjs"),
    };
  } catch (error) {
    const err = new LocalStateError("Identity registry foundation (@the-triangle/agent-worker) is not available in this installation.");
    err.cause = error;
    throw err;
  }
}

function checkRegistry(readRegistry, registryRoot) {
  let read;
  try {
    read = readRegistry({ root: registryRoot });
  } catch (error) {
    return {
      ok: false,
      code: "registry_unreadable",
      facts: { state: "unreadable", errorCode: `${error?.code ?? "unknown"}`, schema: null, sequence: null, auditHead: null, destinations: null },
      registry: null,
    };
  }
  if (read.state === "absent") {
    return { ok: false, code: "registry_absent", facts: { state: "absent", errorCode: null, schema: null, sequence: null, auditHead: null, destinations: null }, registry: null };
  }
  const registry = read.registry;
  const facts = {
    state: "ok",
    errorCode: null,
    schema: registry.schema,
    sequence: registry.sequence,
    auditHead: { sequence: registry.auditHead.sequence, hash: registry.auditHead.hash },
    destinations: isObject(registry.destinations) ? Object.keys(registry.destinations).length : 0,
  };
  if (registry.schema === SCHEMA_V1) return { ok: false, code: "registry_not_v2", facts, registry };
  if (registry.schema !== SCHEMA_V2) return { ok: false, code: "registry_schema_unknown", facts, registry };
  return { ok: true, code: null, facts, registry };
}

function checkCanonicalDirIfPresent(dirPath) {
  const st = lstatSync(dirPath, { throwIfNoEntry: false });
  if (!st) return null;
  try {
    if (path.resolve(dirPath) !== dirPath || realpathSync(dirPath) !== dirPath || !statSync(dirPath).isDirectory()) {
      return "registry_not_canonical";
    }
  } catch {
    return "registry_not_canonical";
  }
  return null;
}

function checkWorkspace(workspace, isValidWorkspacePath) {
  if (!isValidWorkspacePath(workspace)) return "destination_workspace_invalid";
  const lst = lstatSync(workspace, { throwIfNoEntry: false });
  if (!lst) return "destination_workspace_not_found";
  if (lst.isSymbolicLink()) return "destination_workspace_not_canonical";
  let st;
  try {
    st = statSync(workspace);
    if (!st.isDirectory()) return "destination_workspace_not_directory";
    if (realpathSync(workspace) !== workspace) return "destination_workspace_not_canonical";
  } catch {
    return "destination_workspace_not_found";
  }
  return null;
}

function resolveSetTarget(given, bindings) {
  if (typeof given !== "string" || given.length === 0) return { facts: null, refusal: "destination_target_not_found" };
  if (PEER_ID.test(given)) return { facts: null, refusal: "destination_target_not_mesh_managed" };
  const all = Object.values(bindings).filter(isObject);
  const byAgent = AGENT_ID.test(given);
  if (byAgent) {
    const ofPrincipal = all.filter((binding) => binding.principal_id === given);
    if (ofPrincipal.length === 0) return { facts: null, refusal: "destination_target_not_found" };
    const active = ofPrincipal.filter(isActiveMesh);
    if (active.length === 0) {
      return {
        facts: null,
        refusal: ofPrincipal.some((binding) => binding.trust_mode === MESH_MANAGED)
          ? "destination_target_not_active"
          : "destination_target_not_mesh_managed",
      };
    }
    if (active.length > 1) return { facts: null, refusal: "destination_target_ambiguous" };
    const b = active[0];
    return {
      facts: { given, principalId: b.principal_id, bindingId: b.binding_id, profile: b.profile_name, profileInstanceId: b.profile_instance_id },
      refusal: null,
    };
  }
  const named = all.find((binding) => binding.profile_name === given) ?? null;
  if (named === null) return { facts: null, refusal: "destination_target_not_found" };
  if (named.trust_mode !== MESH_MANAGED) return { facts: null, refusal: "destination_target_not_mesh_managed" };
  if (named.revoked_at !== null) return { facts: null, refusal: "destination_target_not_active" };
  const active = all.filter((binding) => binding.principal_id === named.principal_id && isActiveMesh(binding));
  if (active.length > 1) return { facts: null, refusal: "destination_target_ambiguous" };
  return {
    facts: { given, principalId: named.principal_id, bindingId: named.binding_id, profile: named.profile_name, profileInstanceId: named.profile_instance_id },
    refusal: null,
  };
}

function resolveClearPrincipal(given, bindings, destinations) {
  if (typeof given !== "string" || given.length === 0) return { principalId: null, refusal: "destination_target_not_found" };
  if (PEER_ID.test(given)) return { principalId: null, refusal: "destination_target_not_mesh_managed" };
  if (AGENT_ID.test(given)) {
    return Object.hasOwn(destinations, given)
      ? { principalId: given, refusal: null }
      : { principalId: given, refusal: "destination_not_found" };
  }
  const all = Object.values(bindings).filter(isObject);
  const named = all.find((binding) => binding.profile_name === given) ?? null;
  if (named === null) return { principalId: null, refusal: "destination_not_found" };
  if (named.trust_mode !== MESH_MANAGED) return { principalId: named.principal_id, refusal: "destination_target_not_mesh_managed" };
  return Object.hasOwn(destinations, named.principal_id)
    ? { principalId: named.principal_id, refusal: null }
    : { principalId: named.principal_id, refusal: "destination_not_found" };
}

function collectRunnerOverlap({ principalId, profileInstanceId, inventory, recipients }) {
  const names = new Set();
  const identities = Array.isArray(inventory?.identities) ? inventory.identities : [];
  for (const ident of identities) {
    if (!ident || typeof ident !== "object" || ident.principalId !== principalId || !Array.isArray(ident.profiles)) continue;
    for (const prof of ident.profiles) {
      if (!prof || typeof prof !== "object" || prof.enabled === false) continue;
      if (RUNNER_DELIVERY_MODES.has(prof.deliveryMode)) {
        names.add(typeof prof.profile === "string" ? prof.profile : prof.instanceId);
      }
    }
  }
  if (Array.isArray(recipients) && profileInstanceId) {
    const match = recipients.find((r) => r.instanceId === profileInstanceId);
    if (match) names.add(match.profile || match.instanceId);
  }
  return [...names].sort(compareCodeUnits);
}

/**
 * Evaluates `identity destination set|clear` without writing any file.
 */
export async function planIdentityDestination({
  action,
  target,
  harness,
  workspace,
  clientRoot,
  registryRoot,
  withAdvice = true,
  ...deps
} = {}) {
  if (action !== "set" && action !== "clear") fail("invalid_action", "The action is set or clear.");
  const worker = await loadWorker(deps);
  const readRegistry = deps.readIdentityRegistry ?? worker.registry.readIdentityRegistry;
  const resolvedClient = path.resolve(clientRoot);
  const resolvedRegistry = path.resolve(registryRoot);

  const registry = checkRegistry(readRegistry, resolvedRegistry);
  const destinations = registry.registry && isObject(registry.registry.destinations) ? registry.registry.destinations : {};
  const bindings = registry.registry && isObject(registry.registry.bindings) ? registry.registry.bindings : {};

  let config = { ok: true, code: null, recipients: null };
  let inventoryReport = null;
  if (action === "set") {
    config = await readLocalRecipients(resolvedClient, { loadConfig: deps.loadLocalMessagingConfig });
    const readInventory = deps.identityInventory ?? identityInventory;
    inventoryReport = await readInventory({
      clientRoot: resolvedClient,
      pidAlive: deps.pidAlive,
      advisoryHeldAt: deps.advisoryHeldAt,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  } else if (deps.identityInventory) {
    config = await readLocalRecipients(resolvedClient, { loadConfig: deps.loadLocalMessagingConfig });
    inventoryReport = await deps.identityInventory({
      clientRoot: resolvedClient,
      pidAlive: deps.pidAlive,
      advisoryHeldAt: deps.advisoryHeldAt,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  }
  const recipients = config.ok ? config.recipients : null;

  const refusals = [];
  if (!registry.ok) {
    refusals.push(registry.code);
  } else {
    const canonicalProblem = checkCanonicalDirIfPresent(resolvedRegistry);
    if (canonicalProblem) refusals.push(canonicalProblem);
  }
  if (action === "set" && !config.ok && config.code !== "local_messaging_config_missing") {
    refusals.push(config.code);
  }

  let resolved = { facts: null };
  let existing = null;
  let runnerProfiles = [];
  if (action === "set") {
    if (typeof harness !== "string" || !worker.primitives.DESTINATION_HARNESSES.includes(harness)) {
      refusals.push("destination_harness_invalid");
    }
    const wsProblem = checkWorkspace(workspace, worker.primitives.isValidWorkspacePath);
    if (wsProblem) refusals.push(wsProblem);

    if (registry.ok) {
      resolved = resolveSetTarget(target, bindings);
      if (resolved.refusal) {
        refusals.push(resolved.refusal);
      } else {
        const pid = resolved.facts.principalId;
        if (Object.hasOwn(destinations, pid)) refusals.push("destination_exists");
        else if (registry.facts.destinations >= MAX_DESTINATIONS) refusals.push("destination_map_full");
        runnerProfiles = collectRunnerOverlap({
          principalId: pid,
          profileInstanceId: resolved.facts.profileInstanceId,
          inventory: inventoryReport,
          recipients,
        });
        if (runnerProfiles.length > 0) refusals.push("destination_target_has_runner");
      }
    }
  } else if (registry.ok) {
    const clearResolved = resolveClearPrincipal(target, bindings, destinations);
    if (clearResolved.refusal) {
      refusals.push(clearResolved.refusal);
    } else {
      const pid = clearResolved.principalId;
      const [row] = worker.view.describeDestinations({
        destinations: { [pid]: destinations[pid] },
        bindings,
        inventory: inventoryReport,
        localRecipients: recipients,
      });
      existing = {
        principalId: row.principalId,
        profile: row.profile,
        profiles: row.profiles,
        state: row.state,
        harness: row.harness,
        workspace: row.workspace,
        setAt: row.setAt,
        generation: row.generation,
      };
    }
  }

  const body = {
    schema: DESTINATION_PLAN_SCHEMA,
    action,
    clientRoot: resolvedClient,
    registryRoot: resolvedRegistry,
    registry: registry.facts,
    localMessaging: action === "set" ? { state: config.ok ? "ok" : config.code, recipients } : null,
    targetGiven: typeof target === "string" ? target : null,
    target: action === "set" ? resolved.facts : null,
    harness: action === "set" && typeof harness === "string" ? harness : null,
    workspace: action === "set" && typeof workspace === "string" ? workspace : null,
    runnerProfiles,
    existing,
    ready: refusals.length === 0,
    refusals,
  };
  const plan = { ...body, planId: sha256Hex(canonicalJson(body)) };
  if (!withAdvice) return Object.freeze(plan);
  return Object.freeze({ ...plan, advice: Object.freeze({ runnerProfiles: Object.freeze([...runnerProfiles]) }) });
}

/**
 * Applies a previously planned destination rule change after D5-C OS owner authentication.
 */
export async function applyIdentityDestination({
  action,
  target,
  harness,
  workspace,
  clientRoot,
  registryRoot,
  confirm,
  now,
  ownerApprovalProvider,
  releaseRoot,
  platform,
  signal,
  onOperation,
  ...deps
} = {}) {
  if (typeof confirm !== "string" || !PLAN_ID.test(confirm)) {
    fail("confirmation_mismatch", "The confirmation is not a plan id.");
  }
  const worker = await loadWorker(deps);
  const plan = await planIdentityDestination({
    action,
    target,
    harness,
    workspace,
    clientRoot,
    registryRoot,
    withAdvice: false,
    ...deps,
  });
  if (plan.planId !== confirm) {
    fail("plan_stale", "That plan id does not match what is true now. Make a fresh plan and use its id.");
  }
  if (!plan.ready) {
    fail(plan.refusals[0], "The change is refused; see the plan.", { refusals: plan.refusals });
  }

  const operation =
    action === "set"
      ? normalizeOwnerOperation({
          action: "destination.set",
          registryRoot: plan.registryRoot,
          expectedSequence: plan.registry.sequence,
          principalId: plan.target.principalId,
          harness: plan.harness,
          workspace: plan.workspace,
          before: null,
        })
      : normalizeOwnerOperation({
          action: "destination.clear",
          registryRoot: plan.registryRoot,
          expectedSequence: plan.registry.sequence,
          principalId: plan.existing.principalId,
          before: {
            harness: plan.existing.harness,
            workspace: plan.existing.workspace,
            generation: plan.existing.generation,
          },
        });

  const provider =
    ownerApprovalProvider ??
    loadPackagedOwnerApprovalProvider({
      command: "identity.destination",
      releaseRoot,
      platform,
    });
  const adapterFactory =
    deps.createRegistryDestinationAdapter ??
    (await import("./owner-approval-registry.mjs")).createRegistryDestinationAdapter;
  const withLockedRegistry = adapterFactory(operation, { now });
  const coordinator = createOwnerApprovalCoordinator({
    provider,
    withLockedRegistry,
    clockMs: deps.clockMs,
  });
  const handle = coordinator.prepare(operation, {
    ...(deps.approvalTtlMs !== undefined ? { ttlMs: deps.approvalTtlMs } : {}),
  });
  if (typeof onOperation === "function") {
    onOperation(describeOwnerOperation(operation));
  }

  let written;
  try {
    written = await coordinator.execute(handle, { signal });
  } catch (error) {
    if (error?.code === "registry_sequence_conflict") {
      fail("registry_sequence_conflict", "The registry changed while the command ran. Nothing was changed.", { nothingChanged: true });
    }
    throw error;
  }

  const readRegistry = deps.readIdentityRegistry ?? worker.registry.readIdentityRegistry;
  const after = readRegistry({ root: plan.registryRoot });
  const destinations = after.state === "ok" && isObject(after.registry.destinations) ? after.registry.destinations : null;
  const principalId = operation.principalId;
  const planned = plan.registry.sequence + 1;
  const present = destinations !== null && Object.hasOwn(destinations, principalId);
  const matchesWritten =
    present &&
    destinations[principalId].harness === plan.harness &&
    destinations[principalId].workspace === plan.workspace &&
    destinations[principalId].generation === planned;
  const verified =
    after.state === "ok" &&
    after.registry.sequence >= planned &&
    (after.registry.sequence > planned || (action === "set" ? matchesWritten : destinations !== null && !present));
  if (!verified) {
    fail("destination_verification_failed", "The registry did not read back as the changed registry.", { writeAttempted: true });
  }

  return Object.freeze({
    schema: DESTINATION_RESULT_SCHEMA,
    action,
    registryRoot: plan.registryRoot,
    principal: principalId,
    profile: action === "set" ? plan.target.profile : plan.existing.profile,
    harness: action === "set" ? plan.harness : plan.existing.harness,
    workspace: action === "set" ? plan.workspace : plan.existing.workspace,
    from: Object.freeze({ sequence: plan.registry.sequence }),
    to: Object.freeze({ sequence: after.registry.sequence, auditHead: after.registry.auditHead }),
    laterWrites: after.registry.sequence - planned,
    auditEntry: written.auditEntry.action,
  });
}

// ---- wording ------------------------------------------------------------------------------------------------------------------

const REFUSALS = {
  registry_absent: "There is no identity registry here yet.",
  registry_unreadable: "The identity registry cannot be read. Check `triangle status --identity`; do not edit the files by hand.",
  registry_not_v2: "Destination rules need an identity_registry_v2 registry; this one is v1. Run `triangle identity upgrade-registry` first.",
  registry_schema_unknown: "The registry has a schema this command does not know.",
  registry_not_canonical: "The registry directory path is not a canonical directory without symbolic links.",
  local_messaging_config_unreadable: "The client's local messaging configuration is not a file the supervisor would load, so active runners cannot be checked.",
  destination_harness_invalid: "The destination harness must be `claude` or `codex`.",
  destination_workspace_invalid: "The workspace must be a normalized absolute path with no `.` or `..` segments or trailing slash.",
  destination_workspace_not_found: "The workspace directory does not exist.",
  destination_workspace_not_directory: "The workspace path is not a directory.",
  destination_workspace_not_canonical: "The workspace path must be a canonical directory without symbolic links.",
  destination_target_not_found: "No binding in the registry has that principal id or profile name.",
  destination_target_not_active: "That profile or principal has no active MESH-managed binding (it was revoked). Give an active profile or `agent_` id.",
  destination_target_not_mesh_managed: "That is a serverless peer or non-MESH target. Destination rules only support active MESH-managed (`agent_`) principals.",
  destination_target_ambiguous: "That principal has several active MESH-managed bindings. Revoke duplicate bindings first.",
  destination_target_has_runner: "That principal already has an active local runner or bound interactive session. Destination rules apply only when no runner or paired session owns the principal.",
  destination_exists: "That principal already has a destination rule. Clear it first before setting another.",
  destination_conflict: "That principal already has a destination rule. Clear it first before setting another.",
  destination_map_full: `The registry holds ${MAX_DESTINATIONS} destination rules, the most it keeps. Clear one first.`,
  too_many_destinations: `The registry holds ${MAX_DESTINATIONS} destination rules, the most it keeps. Clear one first.`,
  destination_not_found: "There is no destination rule for that target.",
  owner_approval_unavailable: "Local owner authentication is unavailable. This package may not enable destination rule changes.",
  owner_approval_cancelled: "Destination rule change was cancelled.",
  owner_approval_denied: "Owner authentication was denied.",
  owner_approval_expired: "The approval window expired. Run the apply command again.",
  owner_approval_stale: "The destination state changed during approval. Create a fresh plan.",
  invalid_owner_operation: "The destination operation parameters or paths are invalid. Use canonical paths without symbolic links.",
  registry_busy: "Another process is writing the registry. Try again in a moment.",
  registry_sequence_conflict: "The registry changed during approval. Make a fresh plan.",
  updated_before_created: "This computer's clock is earlier than the registry's last write. Check the date and time, then make a fresh plan.",
  destination_verification_failed: "The registry did not read back as the changed registry. Check it with: triangle status --identity",
  plan_stale: "That plan id does not match what is true now. Make a fresh plan and use its id.",
  confirmation_mismatch: "The confirmation must be the 64-hex plan id printed by the plan.",
};

export function describeDestinationRefusal(code) {
  return REFUSALS[code] ?? null;
}

const short = (hash) => (typeof hash === "string" ? hash.slice(0, 12) : "-");
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function destinationCommand({ action, target, harness, workspace, clientRoot, registryRoot, confirm = null }) {
  return [
    "triangle identity destination",
    action,
    shellQuote(target),
    ...(action === "set" ? [`--harness ${shellQuote(harness)}`, `--workspace ${shellQuote(workspace)}`] : []),
    `--client-root ${shellQuote(clientRoot)}`,
    `--registry-root ${shellQuote(registryRoot)}`,
    ...(confirm ? [`--confirm ${confirm}`] : []),
  ].join(" ");
}

export function renderDestinationPlan(plan, { clientRoot } = {}) {
  const lines = [];
  const reg = plan.registry;
  const set = plan.action === "set";
  lines.push(`Identity destination plan: ${plan.action} (requires local owner OS authentication)`);
  lines.push(`Registry: ${plan.registryRoot}`);
  if (reg.state === "ok") {
    lines.push(`Current:  ${reg.schema.replace(/^identity_registry_/, "")} · sequence ${reg.sequence} · ${plural(reg.destinations, "destination")} · audit head ${short(reg.auditHead.hash)}`);
  } else {
    lines.push(`Current:  ${reg.state}${reg.errorCode ? ` (${reg.errorCode})` : ""}`);
  }
  if (set && plan.target) {
    lines.push(`Target:   ${plan.target.profile} · ${plan.target.principalId} · binding ${short(plan.target.bindingId)}`);
    lines.push(`Rule:     ${plan.harness ?? "-"} chat in ${plan.workspace ?? "-"}`);
  } else if (!set && plan.existing) {
    lines.push(`Target:   ${plan.existing.profile ?? "(no single active profile)"} · ${plan.existing.principalId}`);
    lines.push(`Rule:     ${plan.existing.harness} chat in ${plan.existing.workspace} · set ${plan.existing.setAt ?? "-"} · gen ${plan.existing.generation}`);
  } else {
    lines.push(`Target:   ${plan.targetGiven ?? "-"}`);
  }
  const blocked = new Set(plan.refusals);
  const mark = (codes) => (codes.some((code) => blocked.has(code)) ? "[blocked]" : "[ok]     ");
  lines.push("Checks (each must hold; nothing is written otherwise):");
  lines.push(`  ${mark(["registry_absent", "registry_unreadable", "registry_not_v2", "registry_schema_unknown", "registry_not_canonical"])} the registry reads, is v2, and uses a canonical path`);
  if (set) {
    lines.push(`  ${mark(["destination_harness_invalid"])} harness is claude or codex`);
    lines.push(`  ${mark(["destination_workspace_invalid", "destination_workspace_not_found", "destination_workspace_not_directory", "destination_workspace_not_canonical"])} workspace is a canonical existing directory`);
    lines.push(`  ${mark(["destination_target_not_found", "destination_target_not_active", "destination_target_not_mesh_managed", "destination_target_ambiguous"])} target resolves to one active MESH-managed principal`);
    lines.push(`  ${mark(["local_messaging_config_unreadable", "destination_target_has_runner"])} principal has no active local runner or bound interactive session${plan.runnerProfiles.length ? ` (active: ${plan.runnerProfiles.join(", ")})` : ""}`);
    lines.push(`  ${mark(["destination_exists", "destination_map_full"])} no destination rule exists yet for this principal and map is not full`);
  } else {
    lines.push(`  ${mark(["destination_target_not_found", "destination_target_not_mesh_managed", "destination_not_found"])} a destination rule exists for this target`);
  }
  for (const code of plan.refusals) {
    const text = describeDestinationRefusal(code);
    if (text) lines.push(`  - ${code}: ${text}`);
  }
  const clientForCommands = clientRoot ?? plan.clientRoot;
  if (set && plan.ready) {
    lines.push(`Way back: ${destinationCommand({ action: "clear", target: plan.target.principalId, clientRoot: clientForCommands, registryRoot: plan.registryRoot })}   (plan first, then apply with its id)`);
  } else if (!set && plan.ready && plan.existing) {
    lines.push(`Way back: ${destinationCommand({ action: "set", target: plan.existing.principalId, harness: plan.existing.harness, workspace: plan.existing.workspace, clientRoot: clientForCommands, registryRoot: plan.registryRoot })}   (plan first, then apply with its id)`);
  }
  lines.push(`Plan ID: ${plan.planId}`);
  if (plan.ready && clientRoot) {
    lines.push("");
    lines.push("To apply this plan (needs a local owner terminal and OS authentication):");
    lines.push(`  ${destinationCommand({ action: plan.action, target: plan.targetGiven, harness: plan.harness, workspace: plan.workspace, clientRoot, registryRoot: plan.registryRoot, confirm: plan.planId })}`);
  }
  return lines.map(safe).join("\n");
}

export function renderDestinationResult(result) {
  const set = result.action === "set";
  return [
    set
      ? `Set the destination rule for ${result.profile ?? result.principal} (${result.principal}) to ${result.harness} in ${result.workspace}; registry sequence ${result.from.sequence} → ${result.to.sequence}.`
      : `Cleared the destination rule for ${result.profile ?? result.principal} (${result.principal}) (was ${result.harness} in ${result.workspace}); registry sequence ${result.from.sequence} → ${result.to.sequence}.`,
    ...(result.laterWrites > 0 ? [`Another write landed after this one (${plural(result.laterWrites, "entry", "entries")}); the registry is now at sequence ${result.to.sequence}.`] : []),
    `Registry: ${result.registryRoot}`,
    "Check it with: triangle status --identity",
  ].map(safe).join("\n");
}
