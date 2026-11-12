/**
 * R1 Recipient Resolver (Slice 1.1).
 *
 * Resolves a principal recipient ID (`agent_<32-hex>`) to a concrete local
 * runner recipient ID (`<64-hex>`) using an in-memory snapshot of the identity registry.
 *
 * Pure library module:
 * - No filesystem access
 * - No environment variable reads
 * - No side effects or input mutations
 * - Deterministic, deep-frozen result objects
 */

import {
  AGENT_ID_PATTERN,
  ALIAS_PATTERN,
  INSTANCE_ID_PATTERN,
} from "./identity-primitives.mjs";

const PEER_ID_PATTERN = /^peer_[a-f0-9]{32}$/;

function makePassThrough() {
  return Object.freeze({ kind: "pass_through" });
}

function makeResolved({ recipientId, principalId, profile, bindingId }) {
  return Object.freeze({
    kind: "resolved",
    via: "principal",
    recipientId,
    principalId,
    profile,
    bindingId,
  });
}

function makeError(code, reason, candidates = []) {
  const frozenCandidates = candidates.map((cand) =>
    Object.freeze({ id: cand.id, label: cand.label })
  );
  return Object.freeze({
    kind: "error",
    code,
    reason,
    candidates: Object.freeze(frozenCandidates),
  });
}

/**
 * Resolves a recipient identifier to a local recipient instance.
 *
 * @param {object} options
 * @param {string} options.to
 * @param {Array<{ id: string, label: string }>} options.recipients
 * @param {object} [options.snapshot]
 * @returns {object} Deep-frozen resolution result.
 */
export function resolveRecipient(options) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }

  const { to, recipients, snapshot } = options;

  if (typeof to !== "string") {
    throw new TypeError("to must be a string");
  }

  if (!Array.isArray(recipients)) {
    throw new TypeError("recipients must be an array");
  }

  for (const entry of recipients) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      !INSTANCE_ID_PATTERN.test(entry.id) ||
      typeof entry.label !== "string"
    ) {
      throw new TypeError(
        "each recipient must be an object with a 64-hex id and string label"
      );
    }
  }

  // 1. Not principal-shaped -> pass_through
  const isAgent = AGENT_ID_PATTERN.test(to);
  const isPeer = PEER_ID_PATTERN.test(to);

  if (!isAgent && !isPeer) {
    return makePassThrough();
  }

  // 2. peer_... -> recipient_not_found (peer_not_supported)
  // Snapshot is never accessed for peer IDs.
  if (isPeer) {
    return makeError("recipient_not_found", "peer_not_supported");
  }

  // 3. agent_... with snapshot.state "absent" -> recipient_not_found (registry_absent)
  if (snapshot?.state === "absent") {
    return makeError("recipient_not_found", "registry_absent");
  }

  // 4. snapshot.state "unreadable" or any state other than "ok" and "absent" -> route_unavailable (registry_unreadable)
  if (
    snapshot?.state !== "ok" ||
    typeof snapshot?.bindingsFor !== "function"
  ) {
    return makeError("route_unavailable", "registry_unreadable");
  }

  // 5. State "ok": bindings resolution
  let rawBindings;
  try {
    rawBindings = snapshot.bindingsFor(to);
  } catch {
    return makeError("route_unavailable", "registry_unreadable");
  }

  const validBindings = Array.isArray(rawBindings)
    ? rawBindings.filter(
        (b) =>
          b !== null &&
          typeof b === "object" &&
          b.principal_id === to &&
          b.revoked_at === null &&
          b.trust_mode === "mesh-managed"
      )
    : [];

  if (validBindings.length === 0) {
    return makeError("recipient_not_found", "no_binding");
  }

  const recipientById = new Map();
  for (const r of recipients) {
    if (!recipientById.has(r.id)) {
      recipientById.set(r.id, r);
    }
  }

  const kept = [];
  for (const binding of validBindings) {
    const recipient = recipientById.get(binding.profile_instance_id);
    if (recipient !== undefined) {
      kept.push({ binding, recipient });
    }
  }

  if (kept.length === 0) {
    return makeError("route_unavailable", "not_a_local_recipient");
  }

  if (kept.length === 1) {
    const { binding, recipient } = kept[0];
    return makeResolved({
      recipientId: recipient.id,
      principalId: binding.principal_id,
      profile: recipient.label,
      bindingId: binding.binding_id,
    });
  }

  // More than one kept binding -> ambiguous_binding with sorted candidates
  const candidatesById = new Map();
  for (const { recipient } of kept) {
    if (!candidatesById.has(recipient.id)) {
      candidatesById.set(recipient.id, {
        id: recipient.id,
        label: recipient.label,
      });
    }
  }

  const candidates = Array.from(candidatesById.values());
  candidates.sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return makeError("recipient_ambiguous", "ambiguous_binding", candidates);
}

// ---- aliases (AD.1) -------------------------------------------------------------------------------------------------------------
//
// An owner-set alias names one principal in the registry (docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md,
// 3.2 and 3.3). It is VISIBLE to a sender only if the sender may message at least one recipient the alias resolves to. For anyone
// else the name is not an alias at all: it stays an exact id and fails where an unknown name fails, so what a sender can learn
// does not depend on which owner-set names exist. `resolveRecipient` above is unchanged: an alias-shaped string still passes
// through it, and the router asks the functions below first.
//
// `findAliasTargets` and `decideAlias` are pure. The permission question is the caller's: the router asks `canMessage` (async)
// and describeAddresses asks the caller's send gate (sync), then both hand the answer to `decideAlias`, so one rule decides both.

const ALIAS_PASS_THROUGH = Object.freeze({ kind: "pass_through" });

function makeAliasResolved({ alias, recipientId, principalId, profile, bindingId }) {
  return Object.freeze({
    kind: "resolved",
    via: "alias",
    alias,
    recipientId,
    principalId,
    profile,
    bindingId,
  });
}

function makeAliasError(reason) {
  return Object.freeze({ kind: "error", code: "alias_unresolved", reason, candidates: Object.freeze([]) });
}

/**
 * What the alias `name` could mean for this host, or null when there is nothing to decide: the name is not alias-shaped, the
 * snapshot cannot answer (absent, unreadable or a test double without alias support), no such alias exists, or its principal has
 * no active mesh-managed binding on a local recipient. Otherwise the recipients the alias resolves to (`targets`, one unless a
 * legacy duplicate binding exists) and the directory recipients labelled with the name (`labelMatches`). No permission is
 * applied here.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {Array<{ id: string, label: string }>} options.recipients
 * @param {object} [options.snapshot]
 * @returns {object|null} Deep-frozen description, or null.
 */
export function findAliasTargets({ name, recipients, snapshot } = {}) {
  if (typeof name !== "string" || !ALIAS_PATTERN.test(name)) return null;
  if (!Array.isArray(recipients)) return null;
  if (snapshot?.state !== "ok" || typeof snapshot.aliasFor !== "function") return null;
  let principalId;
  try {
    principalId = snapshot.aliasFor(name);
  } catch {
    return null;
  }
  // Only a MESH principal routes; a paired remote (peer_) principal never does.
  if (typeof principalId !== "string" || !AGENT_ID_PATTERN.test(principalId)) return null;
  let resolution;
  try {
    resolution = resolveRecipient({ to: principalId, recipients, snapshot });
  } catch {
    return null;
  }
  let targets;
  if (resolution.kind === "resolved") {
    targets = [{ id: resolution.recipientId, label: resolution.profile, bindingId: resolution.bindingId }];
  } else if (resolution.kind === "error" && resolution.code === "recipient_ambiguous") {
    targets = resolution.candidates.map((candidate) => ({ id: candidate.id, label: candidate.label, bindingId: null }));
  } else {
    return null;
  }
  const labelMatches = recipients
    .filter((recipient) => recipient.label === name)
    .map((recipient) => Object.freeze({ id: recipient.id, label: recipient.label }));
  return Object.freeze({
    name,
    principalId,
    targets: Object.freeze(targets.map((target) => Object.freeze(target))),
    labelMatches: Object.freeze(labelMatches),
  });
}

/**
 * Decides what an alias means for one sender, given which of the recipients involved that sender may message.
 *
 * - none of the alias's recipients is messageable: the alias is not visible, `pass_through`;
 * - visible, and the name is also the label of a recipient the sender may message: `alias_unresolved` /
 *   `alias_collides_with_label` (a name that matches both the local list and the registry never wins silently);
 * - visible, and the principal is bound to several local profiles: `alias_unresolved` / `ambiguous_binding`;
 * - otherwise `resolved` with `via: "alias"`.
 *
 * @param {object|null} found Result of `findAliasTargets`.
 * @param {Set<string>|Array<string>} permittedIds Ids among the targets and label matches the sender may message.
 * @returns {object} Deep-frozen decision.
 */
export function decideAlias(found, permittedIds) {
  if (found === null || found === undefined) return ALIAS_PASS_THROUGH;
  const permitted = permittedIds instanceof Set ? permittedIds : new Set(permittedIds);
  if (!found.targets.some((target) => permitted.has(target.id))) return ALIAS_PASS_THROUGH;
  if (found.labelMatches.some((match) => permitted.has(match.id))) return makeAliasError("alias_collides_with_label");
  if (found.targets.length > 1) return makeAliasError("ambiguous_binding");
  const [target] = found.targets;
  return makeAliasResolved({
    alias: found.name,
    recipientId: target.id,
    principalId: found.principalId,
    profile: target.label,
    bindingId: target.bindingId,
  });
}

/**
 * The same decision for a caller that can answer "may this sender message that id?" synchronously (discovery).
 *
 * @param {object} options
 * @param {string} options.name
 * @param {Array<{ id: string, label: string }>} options.recipients
 * @param {object} [options.snapshot]
 * @param {(id: string) => boolean} options.permitted
 * @returns {object} Deep-frozen decision.
 */
export function resolveAliasFor({ name, recipients, snapshot, permitted } = {}) {
  const found = findAliasTargets({ name, recipients, snapshot });
  if (found === null) return ALIAS_PASS_THROUGH;
  const ids = new Set();
  for (const target of found.targets) {
    if (permitted(target.id) === true) ids.add(target.id);
  }
  if (ids.size === 0) return ALIAS_PASS_THROUGH;
  for (const match of found.labelMatches) {
    if (permitted(match.id) === true) ids.add(match.id);
  }
  return decideAlias(found, ids);
}
