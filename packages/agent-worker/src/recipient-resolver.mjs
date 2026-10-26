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
