// `triangle identity alias set|clear` (identity aliases, AD.2): the owner gives a local principal a short sending name, or takes one away.
//
// An alias is a sending address that the supervisor's router resolves for agents (and the owner CLI resolves through discovery); it is
// not a label, an inbound address or a grant. Both commands are plan first and apply with the exact plan id, the way `identity
// upgrade-registry` is: the plan writes nothing and prints the registry's sequence and audit head and every fact the decision rests on;
// applying needs a terminal and a plan id that is still true (`plan_stale` otherwise). The registry write is AD.0's `setIdentityAlias`
// and `clearIdentityAlias`, which create (never overwrite) and audit. The checks that need the client configuration, which the registry
// does not hold, are made here: a name equal to a local profile name, and a target whose profile is a local recipient.
import { createHash } from "node:crypto";
import path from "node:path";

import { canonicalJson } from "./canonical.mjs";
import { LocalStateError } from "./errors.mjs";
import { applicationRootOf, printable, runTriangleLocalStatus, shellQuote } from "./identity-upgrade.mjs";

export const ALIAS_PLAN_SCHEMA = "identity_alias_plan_v1";
export const ALIAS_RESULT_SCHEMA = "identity_alias_result_v1";
export const MAX_LISTED_ALIASES = 8; // what discovery lists for one recipient (AD.1); the rest resolve but are not listed
export const MAX_ALIASES = 256; // the registry's cap (a test pins it to the registry's own constant)

const SCHEMA_V1 = "identity_registry_v1";
const SCHEMA_V2 = "identity_registry_v2";
const PRINCIPAL_ID = /^(?:agent|peer)_[a-f0-9]{32}$/;
const PLAN_ID = /^[a-f0-9]{64}$/;
const MESH_MANAGED = "mesh-managed";
const CONFIG_FILE = "local-messaging.json";

function fail(code, message = code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Text from the command line, the registry, the configuration or the supervisor never puts a control or format character (a bidi
// override, say) on the owner's terminal.
const safe = (value) => printable(value).replace(/\p{Cf}/gu, "?");

function nowIso(now) {
  const value = typeof now === "function" ? now() : now;
  if (value === undefined) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("invalid_now", "The clock is not a valid time.");
  return date.toISOString();
}

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

// ---- the client configuration -------------------------------------------------------------------------------------------------

/**
 * The local recipients of the client configuration (`local-messaging.json` in the client root): the profiles the supervisor sends
 * to. The file is read and validated by the supervisor's own loader (`loadLocalMessagingConfig`), so this command accepts exactly the
 * file the supervisor would, and a plan never rests on a configuration the supervisor would refuse. Returns `{ ok: true, recipients }`
 * sorted by profile, or `{ ok: false, code }`: missing, or not a file the supervisor would load. Only profile names and instance ids
 * are taken from it.
 */
export async function readLocalRecipients(clientRoot, { loadConfig } = {}) {
  const file = path.join(path.resolve(clientRoot), CONFIG_FILE);
  let config;
  try {
    const load = loadConfig ?? (await import("../../agent-worker/src/local-messaging-host.mjs")).loadLocalMessagingConfig;
    config = load(file);
  } catch (error) {
    return { ok: false, code: error?.code === "ENOENT" ? "local_messaging_config_missing" : "local_messaging_config_unreadable", recipients: null };
  }
  if (!isObject(config) || !Array.isArray(config.recipients) || !config.recipients.every((entry) => isObject(entry) && typeof entry.profile === "string" && typeof entry.instanceId === "string")) {
    return { ok: false, code: "local_messaging_config_unreadable", recipients: null };
  }
  const recipients = config.recipients
    .map((entry) => ({ profile: entry.profile, instanceId: entry.instanceId }))
    .sort((a, b) => compareCodeUnits(a.profile, b.profile) || compareCodeUnits(a.instanceId, b.instanceId));
  return { ok: true, code: null, recipients };
}

// ---- the registry -------------------------------------------------------------------------------------------------------------

function checkRegistry(readRegistry, registryRoot) {
  let read;
  try {
    read = readRegistry({ root: registryRoot });
  } catch (error) {
    return { ok: false, code: "registry_unreadable", facts: { state: "unreadable", errorCode: `${error?.code ?? "unknown"}`, schema: null, sequence: null, auditHead: null, aliases: null }, registry: null };
  }
  if (read.state === "absent") {
    return { ok: false, code: "registry_absent", facts: { state: "absent", errorCode: null, schema: null, sequence: null, auditHead: null, aliases: null }, registry: null };
  }
  const registry = read.registry;
  const facts = {
    state: "ok",
    errorCode: null,
    schema: registry.schema,
    sequence: registry.sequence,
    auditHead: { sequence: registry.auditHead.sequence, hash: registry.auditHead.hash },
    aliases: isObject(registry.aliases) ? Object.keys(registry.aliases).length : 0,
  };
  if (registry.schema === SCHEMA_V1) return { ok: false, code: "registry_not_v2", facts, registry };
  if (registry.schema !== SCHEMA_V2) return { ok: false, code: "registry_schema_unknown", facts, registry };
  return { ok: true, code: null, facts, registry };
}

// ---- the target ---------------------------------------------------------------------------------------------------------------

const isActive = (binding) => binding.trust_mode === MESH_MANAGED && binding.revoked_at === null;

/**
 * TARGET is a principal id or a profile name (matched whole and exactly). Returns the binding the alias would reach, or the refusal
 * that applies. A profile name names *that profile's* binding: it must itself be active (a revoked profile is not quietly re-aimed at
 * the profile its principal has moved to; give the `agent_` id for that) and, when the recipients are known, a local recipient. What
 * the router later faces is the principal's active bindings on local recipients, so several of those are ambiguous and ones on profiles
 * that are not local recipients do not count.
 */
function resolveTarget(given, bindings, recipients) {
  const all = Object.values(bindings).filter(isObject);
  const byPrincipal = PRINCIPAL_ID.test(given);
  const named = byPrincipal ? null : all.find((binding) => binding.profile_name === given) ?? null;
  const principalId = byPrincipal ? given : named?.principal_id ?? null;
  const ofPrincipal = principalId === null ? [] : all.filter((binding) => binding.principal_id === principalId);
  if (ofPrincipal.length === 0) return { facts: null, refusal: "alias_target_not_found" };
  const notActive = (binding) => (binding.trust_mode === MESH_MANAGED ? "alias_target_not_active" : "alias_target_not_mesh_managed");
  if (named !== null && !isActive(named)) return { facts: null, refusal: notActive(named) };
  const active = ofPrincipal.filter(isActive);
  if (active.length === 0) return { facts: null, refusal: ofPrincipal.some((binding) => binding.trust_mode === MESH_MANAGED) ? "alias_target_not_active" : "alias_target_not_mesh_managed" };
  const factsOf = (binding) => ({ given, principalId, bindingId: binding.binding_id, profile: binding.profile_name, profileInstanceId: binding.profile_instance_id });
  const local = recipients === null ? active : active.filter((binding) => recipients.some((recipient) => recipient.instanceId === binding.profile_instance_id));
  if (recipients !== null) {
    if (named !== null && !local.includes(named)) return { facts: factsOf(named), refusal: "alias_target_not_local" };
    if (local.length === 0) return { facts: active.length === 1 ? factsOf(active[0]) : null, refusal: "alias_target_not_local" };
  }
  if (local.length > 1) return { facts: null, refusal: "alias_target_ambiguous" };
  return { facts: factsOf(local[0]), refusal: null };
}

// ---- what the running supervisor honors (advice, not part of the plan id) -----------------------------------------------------

async function askSupervisor(runStatus, applicationRoot, clientRoot, registryRoot) {
  let status;
  try {
    status = await runStatus({ applicationRoot, clientRoot });
  } catch (error) {
    return { state: "unknown", reason: "supervisor_unreachable", detail: typeof error?.detail === "string" ? safe(error.detail).slice(0, 64) : null };
  }
  const router = isObject(status?.router) ? status.router : null;
  const registry = isObject(router?.registry) ? router.registry : null;
  const reported = registry?.rootSha256;
  if (typeof reported !== "string" || !PLAN_ID.test(reported)) return { state: "unknown", reason: "registry_root_not_reported", detail: null };
  if (reported !== sha256Hex(registryRoot)) return { state: "unknown", reason: "supervisor_reads_another_registry", detail: null };
  // a router that is switched off resolves nothing, whatever forms it lists
  if (router.enabled === false) return { state: "not_honored", reason: "router_disabled", detail: null };
  const forms = registry.addressForms;
  if (Array.isArray(forms) && forms.includes("alias")) return { state: "honored", reason: null, detail: null };
  return { state: "not_honored", reason: Array.isArray(forms) ? "alias_not_among_address_forms" : "address_forms_not_reported", detail: null };
}

// ---- plan ---------------------------------------------------------------------------------------------------------------------

/**
 * Evaluates the command and describes it. Read-only: it creates no directory and writes no file. The plan id covers every fact the
 * decision rests on: the registry's sequence and audit head, the alias, the target as given and as resolved, and (for `set`) the
 * profile names and instance ids of the client configuration used for the collision and locality checks, and the refusals. It does
 * not cover the supervisor's answer, the discovery preview or the state a `clear` plan shows judged against the configuration: those
 * are advice and move on their own. `clear` reads the registry alone.
 *
 * @param {object} options
 * @param {"set"|"clear"} options.action
 * @param {string} options.name The alias.
 * @param {string} [options.target] An agent_ id or a profile name (set only).
 */
export async function planIdentityAlias({ action, name, target, clientRoot, registryRoot, withAdvice = true, ...deps } = {}) {
  if (action !== "set" && action !== "clear") fail("invalid_action", "The action is set or clear.");
  const worker = await loadWorker(deps);
  const readRegistry = deps.readIdentityRegistry ?? worker.registry.readIdentityRegistry;
  const runStatus = deps.runSupervisorStatus ?? ((args) => runTriangleLocalStatus({ ...args, env: deps.env ?? process.env }));
  const resolvedClient = path.resolve(clientRoot);

  const registry = checkRegistry(readRegistry, registryRoot);
  const config = await readLocalRecipients(resolvedClient, { loadConfig: deps.loadLocalMessagingConfig });
  const recipients = config.ok ? config.recipients : null;
  const aliases = registry.registry && isObject(registry.registry.aliases) ? registry.registry.aliases : {};
  const bindings = registry.registry && isObject(registry.registry.bindings) ? registry.registry.bindings : {};
  const exists = Object.hasOwn(aliases, name);
  const validName = typeof name === "string" && worker.primitives.ALIAS_PATTERN.test(name);

  const refusals = [];
  if (!registry.ok) refusals.push(registry.code);
  if (action === "set" && !config.ok) refusals.push(config.code);

  let resolved = { facts: null };
  let existing = null;
  let currentState = null;
  if (action === "set") {
    if (!validName) refusals.push("alias_name_invalid");
    else if (worker.primitives.isReservedAliasName(name)) refusals.push("alias_name_reserved");
    else if (recipients !== null && recipients.some((recipient) => recipient.profile.toLowerCase() === name)) refusals.push("alias_collides_with_label");
    if (registry.ok && exists) refusals.push("alias_exists");
    if (registry.ok && registry.facts.aliases >= MAX_ALIASES) refusals.push("alias_map_full");
    if (registry.ok) {
      resolved = typeof target === "string" && target.length > 0 ? resolveTarget(target, bindings, recipients) : { facts: null, refusal: "alias_target_not_found" };
      if (resolved.refusal) refusals.push(resolved.refusal);
    }
  } else {
    if (!validName) refusals.push("alias_name_invalid");
    else if (registry.ok && !exists) refusals.push("alias_not_found");
    if (registry.ok && exists) {
      // what the plan rests on is judged from the registry alone; the state shown beside it may use the configuration as well
      const [row] = worker.view.describeAliases({ aliases: { [name]: aliases[name] }, bindings, localRecipients: null });
      existing = { principalId: row.principalId, profile: row.profile, state: row.state, setAt: row.setAt, generation: row.generation };
      currentState = worker.view.describeAliases({ aliases: { [name]: aliases[name] }, bindings, localRecipients: recipients })[0].state;
    }
  }

  const body = {
    schema: ALIAS_PLAN_SCHEMA,
    action,
    clientRoot: resolvedClient,
    registryRoot,
    registry: registry.facts,
    localMessaging: action === "set" ? { state: config.ok ? "ok" : config.code, recipients } : null,
    alias: typeof name === "string" ? name : null,
    targetGiven: action === "set" && typeof target === "string" ? target : null,
    target: action === "set" ? resolved.facts : null,
    existing,
    ready: refusals.length === 0,
    refusals,
  };
  const plan = { ...body, planId: sha256Hex(canonicalJson(body)) };
  if (!withAdvice) return Object.freeze(plan);

  const advice = {};
  if (action === "set" && plan.ready) {
    const names = [...Object.keys(aliases).filter((other) => aliases[other]?.principal_id === plan.target.principalId), name].sort(compareCodeUnits);
    advice.listing = { aliasesOfPrincipal: names.length, listed: names.slice(0, MAX_LISTED_ALIASES), unlisted: names.slice(MAX_LISTED_ALIASES) };
    advice.supervisor = await askSupervisor(runStatus, applicationRootOf(resolvedClient), resolvedClient, registryRoot);
  }
  if (action === "clear" && currentState !== null) advice.currentState = currentState;
  return Object.freeze({ ...plan, advice: Object.freeze(advice) });
}

// ---- apply --------------------------------------------------------------------------------------------------------------------

/**
 * Applies the exact plan: re-evaluates everything, refuses a plan id that is no longer true (`plan_stale`), and writes through
 * AD.0's `setIdentityAlias` / `clearIdentityAlias` with a compare-and-set on the planned sequence.
 */
export async function applyIdentityAlias({ action, name, target, clientRoot, registryRoot, confirm, now, faultHook = null, ...deps } = {}) {
  if (typeof confirm !== "string" || !PLAN_ID.test(confirm)) fail("confirmation_mismatch", "The confirmation is not a plan id.");
  const worker = await loadWorker(deps);
  const plan = await planIdentityAlias({ action, name, target, clientRoot, registryRoot, withAdvice: false, ...deps });
  if (plan.planId !== confirm) fail("plan_stale", "That plan id does not match what is true now. Make a fresh plan and use its id.");
  if (!plan.ready) fail(plan.refusals[0], "The change is refused; see the plan.", { refusals: plan.refusals });
  const at = nowIso(now);
  const write = action === "set"
    ? deps.setIdentityAlias ?? worker.registry.setIdentityAlias
    : deps.clearIdentityAlias ?? worker.registry.clearIdentityAlias;
  let written;
  try {
    written = write({
      root: registryRoot,
      expectedSequence: plan.registry.sequence,
      now: at,
      alias: name,
      ...(action === "set" ? { principalId: plan.target.principalId } : {}),
      faultHook,
    });
  } catch (error) {
    if (error?.code === "registry_sequence_conflict") {
      fail("registry_sequence_conflict", "The registry changed while the command ran. Nothing was changed.", { nothingChanged: true });
    }
    // a failure after the write began: the registry may or may not have changed, and the message says to look
    if (isObject(error) || error instanceof Error) error.writeAttempted = true;
    throw error;
  }
  const after = (deps.readIdentityRegistry ?? worker.registry.readIdentityRegistry)({ root: registryRoot });
  const aliases = after.state === "ok" && isObject(after.registry.aliases) ? after.registry.aliases : null;
  const present = aliases !== null && Object.hasOwn(aliases, name);
  const planned = plan.registry.sequence + 1;
  // Our entry is the planned next sequence. If another write landed after it the registry is further on and the alias may have
  // changed since (someone cleared it, say), which is no failure of this write; at exactly the next sequence it must read as written.
  const verified = after.state === "ok"
    && after.registry.sequence >= planned
    && (after.registry.sequence > planned || (action === "set" ? present && aliases[name].principal_id === plan.target.principalId : aliases !== null && !present));
  if (!verified) fail("alias_verification_failed", "The registry did not read back as the changed registry.", { writeAttempted: true });
  return Object.freeze({
    schema: ALIAS_RESULT_SCHEMA,
    action,
    registryRoot,
    alias: name,
    principal: action === "set" ? plan.target.principalId : plan.existing.principalId,
    profile: action === "set" ? plan.target.profile : plan.existing.profile,
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
  registry_not_v2: "Aliases need an identity_registry_v2 registry; this one is v1. Run `triangle identity upgrade-registry` first.",
  registry_schema_unknown: "The registry has a schema this command does not know.",
  local_messaging_config_missing: "The client has no local messaging configuration (local-messaging.json), so which profiles are local recipients cannot be checked.",
  local_messaging_config_unreadable: "The client's local messaging configuration is not a file the supervisor would load (it must be a private file the supervisor accepts), so which profiles are local recipients cannot be checked.",
  alias_name_invalid: "An alias is 1 to 32 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
  alias_name_reserved: "That name is reserved: `claude`, or a name that starts like an id (agent_, peer_, session-, bind_, pair_).",
  alias_collides_with_label: "A local profile already has this name, or one that differs only in case. A profile with exactly this name would take the name from the alias: a sender that may message it would get alias_unresolved, and the owner CLI would send to the profile.",
  alias_exists: "That alias already exists. An alias is created, never overwritten: clear it first to point the name somewhere else.",
  alias_conflict: "That alias already exists. An alias is created, never overwritten: clear it first to point the name somewhere else.",
  too_many_aliases: `The registry holds ${MAX_ALIASES} aliases, the most it keeps. Clear one first.`,
  alias_map_full: `The registry holds ${MAX_ALIASES} aliases, the most it keeps. Clear one first.`,
  alias_not_found: "There is no alias with that name.",
  alias_target_not_found: "No binding in the registry has that principal id or profile name.",
  alias_target_not_active: "That profile or principal has no active binding (it was revoked). If the principal is active under another profile, give its agent_ id instead.",
  alias_target_not_mesh_managed: "That is a serverless peer, not a MESH-managed local agent. Only a MESH-managed principal can have an alias.",
  alias_target_ambiguous: "That principal has several active bindings on local recipients (a legacy duplicate). A sender could not tell which profile the alias means. Revoke the extra binding first.",
  alias_target_not_local: "That target is not a local recipient in this client's configuration (the profile named, or any active profile of that principal), so a sender could never reach it by the alias.",
  registry_busy: "Another process is writing the registry. Try again in a moment.",
  registry_sequence_conflict: "The registry changed while the command ran. Make a fresh plan.",
  updated_before_created: "This computer's clock is earlier than the registry's last write. Check the date and time, then make a fresh plan.",
  alias_verification_failed: "The registry did not read back as the changed registry. Check it with: triangle status --identity",
  plan_stale: "That plan id does not match what is true now. Make a fresh plan and use its id.",
  confirmation_mismatch: "The confirmation must be the 64-hex plan id printed by the plan.",
};

export function describeAliasRefusal(code) {
  return REFUSALS[code] ?? null;
}

const short = (hash) => (typeof hash === "string" ? hash.slice(0, 12) : "-");
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** The command for a plan, ready to paste: every path quoted, both roots named. */
export function aliasCommand({ action, name, target, clientRoot, registryRoot, confirm = null }) {
  return [
    "triangle identity alias",
    action,
    shellQuote(name),
    ...(action === "set" ? [shellQuote(target)] : []),
    `--client-root ${shellQuote(clientRoot)}`,
    `--registry-root ${shellQuote(registryRoot)}`,
    ...(confirm ? [`--confirm ${confirm}`] : []),
  ].join(" ");
}

const SUPERVISOR_TEXT = {
  honored: () => "The running supervisor resolves aliases (it reports the alias address form), so senders see the name as soon as it re-reads the registry.",
  not_honored: (advice) => (advice.reason === "router_disabled"
    ? "Principal routing is switched off in the running supervisor (router_disabled), so it resolves no alias. The alias would be recorded but not honored until routing is enabled; until then a send to the name fails like any unknown name (recipient_not_allowed)."
    : `The running supervisor does not resolve aliases (${advice.reason}). The alias would be recorded but not honored until the supervisor is restaged; until then a send to the name fails like any unknown name (recipient_not_allowed).`),
  unknown: (advice) => ({
    supervisor_unreachable: `The running supervisor could not be asked whether it resolves aliases (supervisor_unreachable${advice.detail ? `: ${advice.detail}` : ""}).`,
    supervisor_reads_another_registry: "The running supervisor answered about another registry directory (supervisor_reads_another_registry), so its answer says nothing about this one.",
    registry_root_not_reported: "The running supervisor did not say which registry directory it reads (registry_root_not_reported), so its answer says nothing about this one.",
  }[advice.reason] ?? `The running supervisor's answer could not be used (${advice.reason}).`) + " The alias is recorded either way; it is honored only by a supervisor from the aliases release.",
};

export function renderAliasPlan(plan, { clientRoot } = {}) {
  const lines = [];
  const reg = plan.registry;
  const set = plan.action === "set";
  lines.push(`Identity alias plan: ${plan.action} (host-local; changes no identity, authority or other route)`);
  lines.push(`Registry: ${plan.registryRoot}`);
  if (reg.state === "ok") {
    lines.push(`Current:  ${reg.schema.replace(/^identity_registry_/, "")} · sequence ${reg.sequence} · ${plural(reg.aliases, "alias", "aliases")} · audit head ${short(reg.auditHead.hash)}`);
  } else {
    lines.push(`Current:  ${reg.state}${reg.errorCode ? ` (${reg.errorCode})` : ""}`);
  }
  lines.push(`Alias:    ${plan.alias ?? "-"}${set ? "" : plan.existing ? "  (exists)" : "  (not found)"}`);
  if (set && plan.target) {
    lines.push(`Target:   ${plan.target.profile} · ${plan.target.principalId} · binding ${short(plan.target.bindingId)}`);
  } else if (!set && plan.existing) {
    lines.push(`Target:   ${plan.existing.profile ?? "(no single profile)"} · ${plan.existing.principalId ?? "-"} · set ${plan.existing.setAt ?? "-"} · now ${plan.advice?.currentState ?? plan.existing.state}`);
  }
  const blocked = new Set(plan.refusals);
  const mark = (codes) => (codes.some((code) => blocked.has(code)) ? "[blocked]" : "[ok]     ");
  lines.push("Checks (each must hold; nothing is written otherwise):");
  lines.push(`  ${mark(["registry_absent", "registry_unreadable", "registry_not_v2", "registry_schema_unknown"])} the registry reads and is a v2 registry`);
  if (set) {
    lines.push(`  ${mark(["local_messaging_config_missing", "local_messaging_config_unreadable"])} the client configuration lists the local recipients (${plan.localMessaging.recipients ? plan.localMessaging.recipients.map((recipient) => recipient.profile).join(", ") || "none" : plan.localMessaging.state})`);
    lines.push(`  ${mark(["alias_name_invalid", "alias_name_reserved"])} the name fits the pattern and is not reserved`);
    lines.push(`  ${mark(["alias_collides_with_label"])} no local profile has this name`);
    lines.push(`  ${mark(["alias_exists", "alias_map_full"])} the name is free (an alias is created, never overwritten) and the map is not full`);
    lines.push(`  ${mark(["alias_target_not_found", "alias_target_not_active", "alias_target_not_mesh_managed", "alias_target_ambiguous", "alias_target_not_local"])} the target is an active MESH-managed binding on exactly one local recipient`);
  } else {
    lines.push(`  ${mark(["alias_name_invalid", "alias_not_found"])} the alias exists`);
  }
  for (const code of plan.refusals) {
    const text = describeAliasRefusal(code);
    if (text) lines.push(`  - ${code}: ${text}`);
  }
  const advice = plan.advice ?? {};
  if (set && plan.ready) {
    lines.push(`Senders:  a sender that may message ${plan.target.profile} sees \`${plan.alias}\` among that entry's send.aliases and can use it as \`to\`; the owner CLI's \`send --to ${plan.alias}\` works once discovery lists it. A sender that may not message ${plan.target.profile} gets the answer it gets for any unknown name, so it cannot tell the alias exists.`);
  }
  if (advice.listing && advice.listing.unlisted.length > 0) {
    lines.push(`Note:     discovery lists the first ${MAX_LISTED_ALIASES} names of a recipient (${advice.listing.aliasesOfPrincipal} would exist for this principal). Not listed, though a send by the server still resolves them: ${advice.listing.unlisted.join(", ")}. The owner CLI refuses a name that discovery does not list.`);
  }
  if (advice.supervisor) lines.push(`Supervisor: ${SUPERVISOR_TEXT[advice.supervisor.state](advice.supervisor)}`);
  const clientForCommands = clientRoot ?? plan.clientRoot;
  if (set) {
    lines.push(`Way back: ${aliasCommand({ action: "clear", name: plan.alias ?? "NAME", clientRoot: clientForCommands, registryRoot: plan.registryRoot })}   (plan first, then apply with its id)`);
  } else if (plan.ready) {
    lines.push(`Way back: ${aliasCommand({ action: "set", name: plan.alias, target: plan.existing.principalId, clientRoot: clientForCommands, registryRoot: plan.registryRoot })}   (plan first, then apply with its id)`);
  }
  lines.push(`Plan ID: ${plan.planId}`);
  if (plan.ready && clientRoot) {
    lines.push("");
    lines.push("To apply this plan (needs a terminal):");
    lines.push(`  ${aliasCommand({ action: plan.action, name: plan.alias, target: plan.targetGiven, clientRoot, registryRoot: plan.registryRoot, confirm: plan.planId })}`);
  }
  return lines.map(safe).join("\n");
}

export function renderAliasResult(result) {
  const set = result.action === "set";
  return [
    set
      ? `Set the alias ${result.alias} for ${result.profile} (${result.principal}); registry sequence ${result.from.sequence} → ${result.to.sequence}.`
      : `Cleared the alias ${result.alias} (it named ${result.profile ?? "a principal"}, ${result.principal}); registry sequence ${result.from.sequence} → ${result.to.sequence}.`,
    ...(result.laterWrites > 0 ? [`Another write landed after this one (${plural(result.laterWrites, "entry", "entries")}); the registry is now at sequence ${result.to.sequence}.`] : []),
    `Registry: ${result.registryRoot}`,
    set
      ? "A supervisor that resolves aliases picks it up when it next reads the registry. Check what a sender sees with: triangle-local discover (the name appears in send.aliases of that entry)."
      : "Senders stop seeing the name as soon as the supervisor next reads the registry; a send to it then fails like any unknown name.",
    "Check it with: triangle status --identity",
  ].map(safe).join("\n");
}
