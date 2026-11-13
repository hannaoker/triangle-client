import { planIdentityMapping } from "./identity-mapping.mjs";

// The view reads the registry's own words and imports no registry code; a test builds a real v2 registry and fails if this drifts.
const REGISTRY_SCHEMA_V2 = "identity_registry_v2";

function compareCodeUnits(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }
  return obj;
}

function countRecords(collection) {
  return collection !== null && typeof collection === "object" && !Array.isArray(collection)
    ? Object.keys(collection).length
    : 0;
}

const FAULT_BLOCKED_REASONS = new Set([
  "conflicts_with_recorded",
  "duplicate_profile",
  "duplicate_instance_id",
  "malformed_record",
  "custody_fault",
]);

const EXCLUDED_INVENTORY_CODES = new Set([
  "malformed_record",
  "duplicate_profile",
  "duplicate_instance_id",
  "ambiguous_mapping",
  "origin_mismatch",
  "custody_fault",
]);

const MESH_MANAGED = "mesh-managed";
const RUNNER_DELIVERY_MODES = new Set([
  "worker",
  "headless-app-server",
  "headless-cursor-acp",
  "event-driven",
  "grok-bot",
  "mcp-interactive",
]);

// Whether a binding became active after the alias was set. A time that cannot be read counts as "after": the row is flagged for a look.
function issuedAfter(issuedAt, setAt) {
  const issued = Date.parse(issuedAt);
  const set = Date.parse(setAt);
  return Number.isNaN(issued) || Number.isNaN(set) ? true : issued > set;
}

/**
 * What each alias of a v2 registry means right now, one row per alias sorted by name (code units). Reads only what the registry file
 * holds, plus the local recipients of the client configuration when the caller has them (`localRecipients`: `[{ profile,
 * instanceId }]`, or null when they could not be read, in which case `unroutable` and `collides` are not evaluated).
 *
 * `state`, first match wins:
 * - `dangling`: the principal has no active mesh-managed binding, so the alias resolves to nothing;
 * - `unroutable`: it has one, but its profile is not a local recipient, so the alias resolves to nothing;
 * - `ambiguous`: the principal is bound to several local profiles (a legacy duplicate), so a sender that can see the alias gets
 *   alias_unresolved;
 * - `collides`: a local profile has exactly the alias's name: a sender that may message that profile gets alias_unresolved, and
 *   the owner CLI sends to the profile (a profile that differs only in case is no collision: the router compares exactly);
 * - `moved`: the principal's active binding is on another profile than a revoked binding of the same principal, and it was
 *   issued after the alias was set: the principal was bound again since, and the alias may deliver somewhere else than when it was
 *   set (the registry does not keep the profile from that time, so a principal that came back to its first profile is flagged too);
 * - `active`: none of the above.
 *
 * @param {object} options
 * @param {object} options.aliases - The registry's alias map (name -> { principal_id, set_at, generation }).
 * @param {object} options.bindings - The registry's binding map.
 * @param {Array<{ profile: string, instanceId: string }>|null} [options.localRecipients]
 * @returns {Array<object>} Frozen rows.
 */
export function describeAliases({ aliases, bindings, localRecipients = null } = {}) {
  const map = aliases !== null && typeof aliases === "object" && !Array.isArray(aliases) ? aliases : {};
  const all = bindings !== null && typeof bindings === "object" && !Array.isArray(bindings)
    ? Object.values(bindings).filter((binding) => binding !== null && typeof binding === "object")
    : [];
  const recipients = Array.isArray(localRecipients) ? localRecipients : null;
  const rows = [];
  for (const name of Object.keys(map).sort(compareCodeUnits)) {
    const record = map[name] !== null && typeof map[name] === "object" ? map[name] : {};
    const principalId = typeof record.principal_id === "string" ? record.principal_id : null;
    const mine = all.filter((binding) => binding.principal_id === principalId && binding.trust_mode === MESH_MANAGED);
    const active = mine.filter((binding) => binding.revoked_at === null);
    const revoked = mine.filter((binding) => binding.revoked_at !== null);
    const local = recipients === null
      ? active
      : active.filter((binding) => recipients.some((recipient) => recipient.instanceId === binding.profile_instance_id));
    const collides = recipients !== null && recipients.some((recipient) => String(recipient.profile) === name);
    const moved = active.length === 1
      && revoked.some((binding) => binding.profile_instance_id !== active[0].profile_instance_id)
      && issuedAfter(active[0].issued_at, record.set_at);
    const reached = local.length === 1 ? local[0] : local.length === 0 && active.length === 1 ? active[0] : null;
    let state = "active";
    if (active.length === 0) state = "dangling";
    else if (local.length === 0) state = "unroutable";
    else if (local.length > 1) state = "ambiguous";
    else if (collides) state = "collides";
    else if (moved) state = "moved";
    rows.push({
      name,
      principalId,
      // the one profile the alias reaches: the only local one, or (when none is local) the only active one, which is then the profile named
      // as unroutable; `profiles` lists every active profile
      profile: reached === null ? null : reached.profile_name,
      profiles: active.map((binding) => binding.profile_name).sort(compareCodeUnits),
      profileInstanceId: reached === null ? null : reached.profile_instance_id,
      state,
      setAt: typeof record.set_at === "string" ? record.set_at : null,
      generation: Number.isSafeInteger(record.generation) ? record.generation : null,
    });
  }
  return rows.map((row) => deepFreeze({ ...row, profiles: [...row.profiles] }));
}

const ALIAS_DIAGNOSTICS = {
  dangling: (row) => ({ message: `Alias ${row.name} points at a principal that has no active binding, so it resolves to nothing.`, action: `Clear it with triangle identity alias clear ${row.name} --client-root DIR, or bind the profile again.` }),
  unroutable: (row) => ({ message: `Alias ${row.name} points at ${row.profile ?? "a profile"} that is not a local recipient in this client configuration, so it resolves to nothing.`, action: `Clear it with triangle identity alias clear ${row.name} --client-root DIR, or add the profile to local messaging.` }),
  ambiguous: (row) => ({ message: `Alias ${row.name} points at a principal bound to several profiles (${row.profiles.join(", ")}); a sender that can see it gets alias_unresolved.`, action: `Clear it with triangle identity alias clear ${row.name} --client-root DIR.` }),
  collides: (row) => ({ message: `Alias ${row.name} has the same name as a local profile; a sender that may message that profile gets alias_unresolved, and the owner CLI sends to the profile.`, action: `Clear it with triangle identity alias clear ${row.name} --client-root DIR.` }),
  moved: (row) => ({ message: `Alias ${row.name}'s principal was bound again after the alias was set, and now reaches ${row.profile}.`, action: `Check that this is still what you meant; otherwise clear it with triangle identity alias clear ${row.name} --client-root DIR.` }),
};

/**
 * What each destination rule of a v2 registry means right now, one row per principal sorted by principalId (code units).
 *
 * `state`, first match wins:
 * - `not_mesh_managed`: the principal has only an active serverless-peer binding, not supported for destination routing;
 * - `dangling`: the principal has no active mesh-managed binding;
 * - `shadowed_by_runner`: the principal has an active runner or bound mcp-interactive profile (`inventory` or `localRecipients`),
 *   so destination routing does not take precedence;
 * - `active`: none of the above.
 */
export function describeDestinations({ destinations, bindings, inventory = null, localRecipients = null } = {}) {
  const map = destinations !== null && typeof destinations === "object" && !Array.isArray(destinations) ? destinations : {};
  const allBindings = bindings !== null && typeof bindings === "object" && !Array.isArray(bindings)
    ? Object.values(bindings).filter((binding) => binding !== null && typeof binding === "object")
    : [];
  const recipients = Array.isArray(localRecipients) ? localRecipients : null;
  const inventoryIdentities = Array.isArray(inventory?.identities) ? inventory.identities : [];

  const rows = [];
  for (const principalId of Object.keys(map).sort(compareCodeUnits)) {
    const raw = map[principalId];
    const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const activeMesh = allBindings.filter(
      (b) => b.principal_id === principalId && b.trust_mode === MESH_MANAGED && b.revoked_at === null,
    );
    const activeServerless = allBindings.filter(
      (b) => b.principal_id === principalId && b.trust_mode === "serverless-peer" && b.revoked_at === null,
    );

    const runnerProfiles = new Set();
    if (activeMesh.length > 0) {
      for (const ident of inventoryIdentities) {
        if (!ident || typeof ident !== "object" || ident.principalId !== principalId || !Array.isArray(ident.profiles)) continue;
        for (const prof of ident.profiles) {
          if (!prof || typeof prof !== "object" || prof.enabled === false) continue;
          if (RUNNER_DELIVERY_MODES.has(prof.deliveryMode)) {
            runnerProfiles.add(typeof prof.profile === "string" ? prof.profile : prof.instanceId);
          }
        }
      }
      if (recipients !== null) {
        for (const binding of activeMesh) {
          const match = recipients.find((r) => r.instanceId === binding.profile_instance_id);
          if (match) runnerProfiles.add(match.profile || binding.profile_name);
        }
      }
    }

    let state = "active";
    if (activeMesh.length === 0 && activeServerless.length > 0) state = "not_mesh_managed";
    else if (activeMesh.length === 0) state = "dangling";
    else if (runnerProfiles.size > 0) state = "shadowed_by_runner";

    const profiles = activeMesh.map((b) => b.profile_name).sort(compareCodeUnits);
    const profile =
      activeMesh.length === 1
        ? activeMesh[0].profile_name
        : activeMesh.length === 0 && activeServerless.length === 1
          ? activeServerless[0].profile_name
          : null;

    rows.push({
      principalId,
      profile,
      profiles,
      profileInstanceId: activeMesh.length === 1 ? activeMesh[0].profile_instance_id : null,
      harness: typeof record.harness === "string" ? record.harness : null,
      workspace: typeof record.workspace === "string" ? record.workspace : null,
      state,
      runnerProfiles: [...runnerProfiles].sort(compareCodeUnits),
      setAt: typeof record.set_at === "string" ? record.set_at : null,
      generation: Number.isSafeInteger(record.generation) ? record.generation : null,
    });
  }
  return rows.map((row) => deepFreeze({ ...row, profiles: [...row.profiles], runnerProfiles: [...row.runnerProfiles] }));
}

const DESTINATION_DIAGNOSTICS = {
  dangling: (row) => ({
    message: `Destination rule for ${row.principalId} points at a principal with no active binding, so it routes nothing.`,
    action: `Clear it with triangle identity destination clear ${row.principalId} --client-root DIR.`,
  }),
  not_mesh_managed: (row) => ({
    message: `Destination rule for ${row.principalId} points at a serverless peer, which destination routing does not support.`,
    action: `Clear it with triangle identity destination clear ${row.principalId} --client-root DIR.`,
  }),
  shadowed_by_runner: (row) => ({
    message: `Destination rule for ${row.profile ?? row.principalId} (${row.principalId}) is shadowed by an active runner or interactive profile (${row.runnerProfiles.join(", ") || "local recipient"}).`,
    action: `Switch or disable that runner profile, or clear the rule with triangle identity destination clear ${row.principalId} --client-root DIR.`,
  }),
};

/**
 * Builds a secret-free, deterministic identity view from an identity inventory report
 * and an identity registry read result.
 *
 * @param {object} options
 * @param {object} options.inventory - Output of buildIdentityInventory.
 * @param {object} [options.registry] - Output of readIdentityRegistry or { state: "unreadable", code }.
 * @param {Array<{ profile: string, instanceId: string }>|null} [options.localRecipients] - The client configuration's local
 *   recipients, for the alias rows (null or absent: not known).
 * @returns {object} Deep-frozen identity view. A v2 registry adds `aliases` (see describeAliases); any other registry has no such key.
 */
export function buildIdentityView({ inventory, registry, localRecipients = null } = {}) {
  if (!inventory || typeof inventory !== "object") {
    throw new TypeError("inventory must be a non-null object");
  }

  let registryState = "absent";
  let registrySchema = null;
  let registryCollections = null;
  let registrySequence = 0;
  let auditVerifiedThrough = 0;
  let auditUncommittedTail = 0;
  let errorCode = null;

  if (registry && typeof registry === "object") {
    if (registry.state === "ok") {
      registryState = "ok";
      registrySchema = typeof registry.registry?.schema === "string" ? registry.registry.schema : null;
      // Record counts of the v2 collections; the aliases are shown row by row below.
      if (registrySchema === REGISTRY_SCHEMA_V2) {
        registryCollections = {
          pairings: countRecords(registry.registry.pairings),
          aliases: countRecords(registry.registry.aliases),
          destinations: countRecords(registry.registry.destinations),
        };
      }
      registrySequence = typeof registry.registry?.sequence === "number" ? registry.registry.sequence : 0;
      auditVerifiedThrough = typeof registry.audit?.verifiedThrough === "number" ? registry.audit.verifiedThrough : 0;
      auditUncommittedTail = typeof registry.audit?.uncommittedTail === "number" ? registry.audit.uncommittedTail : 0;
    } else if (registry.state === "unreadable") {
      registryState = "unreadable";
      errorCode = typeof registry.code === "string" ? registry.code : (registry.code != null ? String(registry.code) : "unknown");
    } else if (registry.state === "absent") {
      registryState = "absent";
    }
  }

  const viewRegistry = {
    state: registryState,
    schema: registrySchema,
    collections: registryCollections,
    sequence: registrySequence,
    auditVerifiedThrough,
    auditUncommittedTail,
    errorCode,
  };

  const effectiveRegistryForPlan = registryState === "unreadable"
    ? { state: "absent" }
    : (registry ?? { state: "absent" });

  const plan = planIdentityMapping({ inventory, registry: effectiveRegistryForPlan });

  const existingBindings = (registryState === "ok" && registry?.registry?.bindings && typeof registry.registry.bindings === "object")
    ? registry.registry.bindings
    : {};

  // Serverless-peer bindings (v2 only) are no MESH identity: no inventory evidence applies to them, so they get a row of
  // their own instead of `recorded_only` with a missing-profile warning. (The mapping plan already leaves a profile with a
  // live one out of `localOnly`; a profile whose only serverless binding is revoked shows as `local_only`, like an agent's.)
  const serverlessBindings = Object.values(existingBindings).filter(
    (binding) => binding && typeof binding === "object" && binding.trust_mode === "serverless-peer",
  );

  // Index inventory profiles for quick lookup
  const inventoryInstanceIdsSet = new Set();
  const inventoryIdentitiesByProfile = new Map();

  if (Array.isArray(inventory.identities)) {
    for (const ident of inventory.identities) {
      if (!ident || typeof ident !== "object") continue;
      const principalId = typeof ident.principalId === "string" ? ident.principalId : null;
      const authorityOrigin = typeof ident.authorityOrigin === "string" ? ident.authorityOrigin : null;
      if (Array.isArray(ident.profiles)) {
        for (const p of ident.profiles) {
          if (!p || typeof p !== "object") continue;
          if (typeof p.instanceId === "string") {
            inventoryInstanceIdsSet.add(p.instanceId);
          }
          if (typeof p.profile === "string") {
            inventoryIdentitiesByProfile.set(p.profile, { principalId, authorityOrigin });
          }
        }
      }
    }
  }

  if (Array.isArray(inventory.unmappedProfiles)) {
    for (const u of inventory.unmappedProfiles) {
      if (!u || typeof u !== "object") continue;
      if (typeof u.instanceId === "string") {
        inventoryInstanceIdsSet.add(u.instanceId);
      }
    }
  }

  const profileRows = [];

  // 1. recorded = plan unchanged
  if (Array.isArray(plan.unchanged)) {
    for (const u of plan.unchanged) {
      const regBinding = u.profileInstanceId ? existingBindings[u.profileInstanceId] : null;
      profileRows.push({
        profile: u.profile,
        profileInstanceId: u.profileInstanceId,
        state: "recorded",
        principalId: u.principalId,
        authorityOrigin: u.authorityOrigin,
        bindingId: u.bindingId,
        generation: regBinding?.binding_generation ?? null,
        reason: null,
      });
    }
  }

  // 2. not_recorded = plan proposals
  if (Array.isArray(plan.proposals)) {
    for (const p of plan.proposals) {
      profileRows.push({
        profile: p.profile_name,
        profileInstanceId: p.profile_instance_id,
        state: "not_recorded",
        principalId: p.principal_id,
        authorityOrigin: p.authority_origin,
        bindingId: null,
        generation: null,
        reason: null,
      });
    }
  }

  // 3. blocked = plan blocked
  if (Array.isArray(plan.blocked)) {
    for (const b of plan.blocked) {
      const identInfo = inventoryIdentitiesByProfile.get(b.profile);
      const regBinding = b.profileInstanceId ? existingBindings[b.profileInstanceId] : null;
      profileRows.push({
        profile: b.profile,
        profileInstanceId: b.profileInstanceId,
        state: "blocked",
        principalId: identInfo?.principalId ?? null,
        authorityOrigin: identInfo?.authorityOrigin ?? null,
        bindingId: regBinding?.binding_id ?? null,
        generation: regBinding?.binding_generation ?? null,
        reason: b.reason,
      });
    }
  }

  // 4. local_only = plan localOnly
  if (Array.isArray(plan.localOnly)) {
    for (const l of plan.localOnly) {
      profileRows.push({
        profile: l.profile,
        profileInstanceId: l.profileInstanceId,
        state: "local_only",
        principalId: null,
        authorityOrigin: null,
        bindingId: null,
        generation: null,
        reason: null,
      });
    }
  }

  // 5. recorded_only = registry binding matching no profile in inventory
  if (registryState === "ok") {
    for (const binding of Object.values(existingBindings)) {
      if (!binding || typeof binding !== "object") continue;
      if (binding.trust_mode === "serverless-peer") continue;
      if (!inventoryInstanceIdsSet.has(binding.profile_instance_id)) {
        profileRows.push({
          profile: binding.profile_name,
          profileInstanceId: binding.profile_instance_id,
          state: "recorded_only",
          principalId: binding.principal_id,
          authorityOrigin: binding.authority_origin,
          bindingId: binding.binding_id,
          generation: binding.binding_generation,
          reason: null,
        });
      }
    }
  }

  // 6. serverless = a v2 serverless-peer binding whose profile has no other row (a blocked row for the same profile
  // keeps its place)
  const rowInstanceIds = new Set(profileRows.map((row) => row.profileInstanceId));
  for (const binding of serverlessBindings) {
    if (rowInstanceIds.has(binding.profile_instance_id)) continue;
    profileRows.push({
      profile: binding.profile_name,
      profileInstanceId: binding.profile_instance_id,
      state: "serverless",
      principalId: binding.principal_id,
      authorityOrigin: null,
      bindingId: binding.binding_id,
      generation: binding.binding_generation,
      reason: binding.revoked_at === null ? null : "revoked",
    });
  }

  // Sort profile rows by profile, then profileInstanceId
  profileRows.sort((a, b) => {
    const cmpProf = compareCodeUnits(a.profile, b.profile);
    if (cmpProf !== 0) return cmpProf;
    return compareCodeUnits(a.profileInstanceId, b.profileInstanceId);
  });

  const summary = {
    profiles: profileRows.length,
    recorded: profileRows.filter((p) => p.state === "recorded").length,
    notRecorded: profileRows.filter((p) => p.state === "not_recorded").length,
    blocked: profileRows.filter((p) => p.state === "blocked").length,
    localOnly: profileRows.filter((p) => p.state === "local_only").length,
    recordedOnly: profileRows.filter((p) => p.state === "recorded_only").length,
    serverless: profileRows.filter((p) => p.state === "serverless").length,
    faults: 0,
    warnings: 0,
  };

  const diagnostics = [];

  // Diagnostics:
  // - registry_unreadable (fault)
  if (registryState === "unreadable") {
    diagnostics.push({
      severity: "fault",
      code: "registry_unreadable",
      profile: null,
      message: `The identity registry could not be read (${errorCode}).`,
      action: "Do not edit the files by hand. Restore the registry directory from a backup.",
    });
  }

  // - registry_unfinished_write (warning) when auditUncommittedTail is 1
  if (auditUncommittedTail === 1) {
    diagnostics.push({
      severity: "warning",
      code: "registry_unfinished_write",
      profile: null,
      message: "An interrupted write left an unfinished audit line.",
      action: "The next registry update repairs it.",
    });
  }

  // - identity_not_recorded (warning) when notRecorded > 0
  if (summary.notRecorded > 0) {
    diagnostics.push({
      severity: "warning",
      code: "identity_not_recorded",
      profile: null,
      message: `${summary.notRecorded} profile(s) have a valid MESH binding on disk and no recorded identity binding.`,
      action: "Run triangle identity migrate and review the plan.",
    });
  }

  // - one identity_blocked per blocked row, profile set
  for (const b of profileRows.filter((p) => p.state === "blocked")) {
    const isFault = FAULT_BLOCKED_REASONS.has(b.reason);
    diagnostics.push({
      severity: isFault ? "fault" : "warning",
      code: "identity_blocked",
      profile: b.profile || null,
      message: `Profile ${b.profile} is blocked: ${b.reason}.`,
      action: null,
    });
  }

  // - one recorded_profile_missing (warning) per recorded_only row
  for (const r of profileRows.filter((p) => p.state === "recorded_only")) {
    diagnostics.push({
      severity: "warning",
      code: "recorded_profile_missing",
      profile: r.profile || null,
      message: "A recorded binding has no local profile.",
      action: null,
    });
  }

  // - inventory diagnostics passthrough (excluding covered codes)
  if (Array.isArray(inventory.diagnostics)) {
    for (const d of inventory.diagnostics) {
      if (!d || typeof d !== "object") continue;
      if (EXCLUDED_INVENTORY_CODES.has(d.code)) continue;
      diagnostics.push({
        severity: d.severity === "fault" ? "fault" : "warning",
        code: d.code,
        profile: typeof d.profile === "string" ? d.profile : null,
        message: d.message,
        action: null,
      });
    }
  }

  // Alias and destination rows (v2 only) and one warning for each that does not simply work
  let aliasRows = null;
  let destinationRows = null;
  if (registryState === "ok" && registrySchema === REGISTRY_SCHEMA_V2) {
    aliasRows = describeAliases({ aliases: registry.registry.aliases, bindings: existingBindings, localRecipients });
    for (const row of aliasRows) {
      if (row.state === "active") continue;
      diagnostics.push({ severity: "warning", code: `alias_${row.state}`, profile: row.profile, ...ALIAS_DIAGNOSTICS[row.state](row) });
    }
    if (aliasRows.length > 0 && !Array.isArray(localRecipients)) {
      diagnostics.push({
        severity: "warning",
        code: "alias_routing_unchecked",
        profile: null,
        message: "The client configuration could not be read, so whether the aliases reach a local recipient was not checked.",
        action: null,
      });
    }
    destinationRows = describeDestinations({
      destinations: registry.registry.destinations,
      bindings: existingBindings,
      inventory,
      localRecipients,
    });
    for (const row of destinationRows) {
      if (row.state === "active") continue;
      diagnostics.push({
        severity: "warning",
        code: `destination_${row.state}`,
        profile: row.profile,
        ...DESTINATION_DIAGNOSTICS[row.state](row),
      });
    }
    if (destinationRows.length > 0 && !Array.isArray(localRecipients)) {
      diagnostics.push({
        severity: "warning",
        code: "destination_routing_unchecked",
        profile: null,
        message: "The client configuration could not be read, so whether destination rules are shadowed by a local recipient was not checked.",
        action: null,
      });
    }
  }

  // Sort diagnostics by severity (faults first), then code, then profile, then message
  diagnostics.sort((a, b) => {
    const sevA = a.severity === "fault" ? 0 : 1;
    const sevB = b.severity === "fault" ? 0 : 1;
    if (sevA !== sevB) return sevA - sevB;

    const cmpCode = compareCodeUnits(a.code, b.code);
    if (cmpCode !== 0) return cmpCode;

    const cmpProf = compareCodeUnits(a.profile, b.profile);
    if (cmpProf !== 0) return cmpProf;

    return compareCodeUnits(a.message, b.message);
  });

  summary.faults = diagnostics.filter((d) => d.severity === "fault").length;
  summary.warnings = diagnostics.filter((d) => d.severity === "warning").length;

  const view = {
    schema: "identity_view_v1",
    registry: viewRegistry,
    summary,
    profiles: profileRows,
    ...(aliasRows !== null ? { aliases: aliasRows } : {}),
    ...(destinationRows !== null ? { destinations: destinationRows } : {}),
    diagnostics,
  };

  return deepFreeze(view);
}
