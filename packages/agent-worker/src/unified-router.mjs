/**
 * Unified Messaging Router Core (Slice R1.3).
 *
 * Library-only routing module that resolves recipient addresses, decorates
 * outgoing and incoming protocol DTOs with route metadata, and tracks
 * operational counters.
 *
 * Injected dependencies:
 * - isEnabled: boolean or function () => boolean
 * - snapshotProvider: registry snapshot provider with .get()
 * - recipients: array or function () => Array<{ id: string, label: string }>
 * - canMessage: async function(senderId, candidateRecipientId)
 */

import { AGENT_ID_PATTERN, ALIAS_PATTERN } from "./identity-primitives.mjs";
import { SUPPORTED_REGISTRY_SCHEMAS } from "./router-registry-snapshot.mjs";
import { decideAlias, findAliasTargets, resolveAliasFor, resolveRecipient } from "./recipient-resolver.mjs";
import { localState } from "./transport-adapter-contract.mjs";
import { LocalMessagingError } from "./local-messaging-errors.mjs";

const PEER_ID_PATTERN = /^peer_[a-f0-9]{32}$/;
const RAW_JOURNAL_FIELDS = Object.freeze(["to_principal", "resolved_via"]);
// Discovery names at most this many aliases per entry; the full list is for the owner (`status --identity`).
const MAX_ALIAS_NAMES_PER_ENTRY = 8;
// The address forms this process resolves, for `local_status`. Exact ids always pass; principals and aliases resolve only while the
// router is enabled. A supervisor from before aliases omits the field, which reads as "no alias form".
const ADDRESS_FORMS_ENABLED = Object.freeze(["alias", "id", "principal"]);
const ADDRESS_FORMS_DISABLED = Object.freeze(["id"]);

/**
 * Error thrown when recipient resolution fails.
 * Extends LocalMessagingError so it integrates transparently with
 * local-messaging RPC error handlers.
 */
export class RouterResolutionError extends LocalMessagingError {
  /**
   * @param {string} code
   * @param {string} reason
   * @param {Array<{ id: string, label: string }>} [candidates]
   */
  constructor(code, reason, candidates = []) {
    super(code, reason || code);
    this.name = "RouterResolutionError";
    this.reason = reason;
    this.candidates = Object.freeze(
      candidates.map((c) => Object.freeze({ id: c.id, label: c.label }))
    );
  }
}

/**
 * Projects a target object into the public target projection:
 * { via: "principal" | "id", principal?, profile? }
 *
 * Validates expected types and shapes, allowlists only public target fields,
 * and strips arbitrary fields and raw journal metadata. Never mutates input.
 *
 * @param {object} targetInput Target object or override.
 * @returns {object} Deep-frozen projected target.
 */
function projectTarget(targetInput) {
  if (targetInput === null || typeof targetInput !== "object" || Array.isArray(targetInput)) {
    throw new TypeError("target must be an object");
  }

  const via = targetInput.via ?? (targetInput.principal ? "principal" : "id");
  if (via !== "principal" && via !== "id") {
    throw new TypeError("target.via must be 'principal' or 'id'");
  }

  const projected = { via };

  if (targetInput.principal !== undefined && targetInput.principal !== null) {
    if (typeof targetInput.principal !== "string") {
      throw new TypeError("target.principal must be a string");
    }
    if (targetInput.principal.length > 0) {
      projected.principal = targetInput.principal;
    }
  }

  if (targetInput.profile !== undefined && targetInput.profile !== null) {
    if (typeof targetInput.profile !== "string") {
      throw new TypeError("target.profile must be a string");
    }
    if (targetInput.profile.length > 0) {
      projected.profile = targetInput.profile;
    }
  }

  return Object.freeze(projected);
}

/**
 * Strips raw internal journal columns (to_principal, resolved_via) from DTOs.
 * Never mutates the input object.
 *
 * @template T
 * @param {T} dto
 * @returns {T} Clean copy without internal journal fields.
 */
function sanitizeDto(dto) {
  if (dto === null || typeof dto !== "object") {
    return dto;
  }
  const clean = {};
  for (const [key, val] of Object.entries(dto)) {
    if (!RAW_JOURNAL_FIELDS.includes(key)) {
      clean[key] = val;
    }
  }
  return clean;
}

/**
 * Looks up the principal bound to a local recipient, keeping unknown as unknown: `unbound` is only said when the
 * registry was read (or does not exist yet) and holds no binding; a registry that cannot be read, or holds a binding
 * with an unusable principal, is `unknown`.
 *
 * @param {object|null} snapshot
 * @param {string} instanceId
 * @returns {{ principal: string|null, state: "bound"|"unbound"|"unknown" }}
 */
function lookupPrincipal(snapshot, instanceId) {
  if (snapshot?.state === "absent") {
    return { principal: null, state: "unbound" };
  }
  if (snapshot?.state !== "ok" || typeof snapshot.bindingForInstance !== "function") {
    return { principal: null, state: "unknown" };
  }
  try {
    const principal = snapshot.bindingForInstance(instanceId)?.principal_id;
    if (!principal) return { principal: null, state: "unbound" };
    return typeof principal === "string" && AGENT_ID_PATTERN.test(principal)
      ? { principal, state: "bound" }
      : { principal: null, state: "unknown" };
  } catch {
    return { principal: null, state: "unknown" };
  }
}

/**
 * Evaluates canMessage predicate for an ambiguity candidate.
 * Fails closed on denial or thrown exceptions.
 *
 * @param {Function} canMessage
 * @param {string} senderId
 * @param {string} recipientId
 * @returns {Promise<boolean>}
 */
async function evaluateCanMessage(canMessage, senderId, recipientId) {
  if (typeof canMessage !== "function") {
    return false;
  }
  try {
    const outcome = await canMessage(senderId, recipientId);
    if (outcome === false || outcome === null) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates an instance of the Unified Router core.
 *
 * @param {object} [options]
 * @param {boolean|(() => boolean)} [options.enabled]
 * @param {object} [options.snapshotProvider]
 * @param {Array<{ id: string, label: string }>|(() => Array<{ id: string, label: string }>)} [options.recipients]
 * @param {(senderId: string, recipientId: string) => Promise<boolean|void>|boolean|void} [options.canMessage]
 * @returns {object} Router instance
 */
export function createUnifiedRouter({
  enabled = false,
  snapshotProvider = null,
  recipients = [],
  canMessage = null,
} = {}) {
  const isEnabled = () => (typeof enabled === "function" ? Boolean(enabled()) : Boolean(enabled));

  const getRecipients = () => {
    const list = typeof recipients === "function" ? recipients() : recipients;
    return Array.isArray(list) ? list : [];
  };

  const counters = {
    resolved: {
      principal: 0,
      id: 0,
      alias: 0,
    },
    errors: {
      recipient_not_found: 0,
      route_unavailable: 0,
      recipient_ambiguous: 0,
      alias_unresolved: 0,
    },
  };

  function recordError(code) {
    counters.errors[code] = (counters.errors[code] || 0) + 1;
  }

  /**
   * Resolves a send recipient.
   *
   * @param {object|string} params Send params or recipient address string.
   * @param {string} [params.senderId] Authenticated sender identity.
   * @param {string} [params.to] Recipient address to resolve.
   * @param {object} [callOptions] Per-call options overriding instance defaults.
   * @param {boolean} [callOptions.throwOnError=true]
   * @param {object} [callOptions.snapshot]
   * @param {Array<{ id: string, label: string }>} [callOptions.recipients]
   * @param {Function} [callOptions.canMessage]
   * @returns {Promise<object>} Resolution details.
   */
  async function resolveSend(params, callOptions = {}) {
    const senderId = typeof params === "string" ? callOptions.senderId : params?.senderId;
    const to = typeof params === "string" ? params : params?.to;

    if (typeof to !== "string") {
      throw new TypeError("to must be a string");
    }

    // 1. Router disabled: zero registry/recipient reads, pass through untouched
    if (!isEnabled()) {
      return Object.freeze({
        ok: true,
        resolvedTo: to,
        to,
        resolved: false,
        via: null,
        principal: null,
        profile: null,
        bindingId: null,
        route: null,
      });
    }

    const throwOnError = callOptions.throwOnError !== false;
    const effectiveCanMessage = callOptions.canMessage ?? canMessage;
    const effectiveRecipients = callOptions.recipients ?? getRecipients();

    const isAgent = AGENT_ID_PATTERN.test(to);
    const isPeer = PEER_ID_PATTERN.test(to);

    // 2. Non-principal identifier. The registry is read once for this call, and an unreadable registry is "no snapshot": legacy
    // delivery must not fail even if the registry is unreadable or absent.
    if (!isAgent && !isPeer) {
      let passSnapshot = null;
      if (snapshotProvider && typeof snapshotProvider.get === "function") {
        try {
          passSnapshot = callOptions.snapshot ?? snapshotProvider.get();
        } catch {
          // Ignore registry errors for legacy delivery
          passSnapshot = null;
        }
      }

      // 2a. An owner-set alias that this sender can see (AD.1; recipient-resolver.mjs says what "see" means). For anyone else
      // the name falls through to 2b and is treated exactly as an unknown name is, so nothing about which aliases exist shows.
      if (ALIAS_PATTERN.test(to)) {
        const found = findAliasTargets({ name: to, recipients: effectiveRecipients, snapshot: passSnapshot });
        if (found !== null) {
          const permittedIds = new Set();
          for (const target of found.targets) {
            if (await evaluateCanMessage(effectiveCanMessage, senderId, target.id)) permittedIds.add(target.id);
          }
          if (permittedIds.size > 0) {
            for (const match of found.labelMatches) {
              if (!permittedIds.has(match.id) && (await evaluateCanMessage(effectiveCanMessage, senderId, match.id))) {
                permittedIds.add(match.id);
              }
            }
            const decision = decideAlias(found, permittedIds);
            if (decision.kind === "resolved") {
              counters.resolved.alias += 1;
              return Object.freeze({
                ok: true,
                resolvedTo: decision.recipientId,
                to,
                resolved: true,
                via: "alias",
                principal: decision.principalId,
                profile: decision.profile,
                bindingId: decision.bindingId,
                route: "local",
              });
            }
            if (decision.kind === "error") {
              recordError(decision.code);
              const err = new RouterResolutionError(decision.code, decision.reason);
              if (throwOnError) {
                throw err;
              }
              return Object.freeze({
                ok: false,
                code: decision.code,
                reason: decision.reason,
                candidates: Object.freeze([]),
                error: err,
              });
            }
          }
        }
      }

      // 2b. Everything else passes through with via: "id".
      counters.resolved.id += 1;

      let boundPrincipal = null;
      let boundProfile = null;

      try {
        if (passSnapshot?.state === "ok") {
          const binding = passSnapshot.bindingForInstance(to);
          if (binding?.principal_id) {
            boundPrincipal = binding.principal_id;
          }
        }
      } catch {
        // Ignore registry errors for legacy delivery
      }

      for (const r of effectiveRecipients) {
        if (r.id === to) {
          boundProfile = r.label;
          break;
        }
      }

      return Object.freeze({
        ok: true,
        resolvedTo: to,
        to,
        resolved: false,
        via: "id",
        principal: boundPrincipal,
        profile: boundProfile,
        bindingId: null,
        route: "local",
      });
    }

    // 3. Peer IDs fail without touching snapshot
    if (isPeer) {
      recordError("recipient_not_found");
      const err = new RouterResolutionError("recipient_not_found", "peer_not_supported");
      if (throwOnError) {
        throw err;
      }
      return Object.freeze({
        ok: false,
        code: "recipient_not_found",
        reason: "peer_not_supported",
        candidates: Object.freeze([]),
        error: err,
      });
    }

    // 4. Principal ID (agent_<32-hex>): read snapshot and resolve
    let snapshot = callOptions.snapshot;
    if (!snapshot && snapshotProvider && typeof snapshotProvider.get === "function") {
      try {
        snapshot = snapshotProvider.get();
      } catch (providerErr) {
        recordError("route_unavailable");
        const reason = typeof providerErr?.code === "string" ? providerErr.code : "registry_unreadable";
        const err = new RouterResolutionError("route_unavailable", reason);
        if (throwOnError) {
          throw err;
        }
        return Object.freeze({
          ok: false,
          code: "route_unavailable",
          reason,
          candidates: Object.freeze([]),
          error: err,
        });
      }
    }

    const res = resolveRecipient({
      to,
      recipients: effectiveRecipients,
      snapshot,
    });

    if (res.kind === "resolved") {
      counters.resolved.principal += 1;
      return Object.freeze({
        ok: true,
        resolvedTo: res.recipientId,
        to,
        resolved: true,
        via: "principal",
        principal: res.principalId,
        profile: res.profile,
        bindingId: res.bindingId,
        route: "local",
      });
    }

    // Handle resolution error
    if (res.kind === "error") {
      let filteredCandidates = [];

      if (res.code === "recipient_ambiguous") {
        if (typeof effectiveCanMessage === "function" && Array.isArray(res.candidates)) {
          for (const cand of res.candidates) {
            if (await evaluateCanMessage(effectiveCanMessage, senderId, cand.id)) {
              filteredCandidates.push(cand);
            }
          }
        } else {
          filteredCandidates = [];
        }
      } else if (Array.isArray(res.candidates)) {
        filteredCandidates = [...res.candidates];
      }

      recordError(res.code);

      // CRITICAL: Do not pick an arbitrary remaining candidate to resolve a fundamentally
      // ambiguous binding. Preserve resolver errors/reasons.
      const err = new RouterResolutionError(res.code, res.reason, filteredCandidates);
      if (throwOnError) {
        throw err;
      }
      return Object.freeze({
        ok: false,
        code: res.code,
        reason: res.reason,
        candidates: err.candidates,
        error: err,
      });
    }

    // Fallback pass_through if resolver returned pass_through
    return Object.freeze({
      ok: true,
      resolvedTo: to,
      to,
      resolved: false,
      via: "id",
      principal: null,
      profile: null,
      bindingId: null,
      route: "local",
    });
  }

  function lookupProfile(instanceId) {
    if (!instanceId) return null;
    for (const r of getRecipients()) {
      if (r.id === instanceId) {
        return r.label;
      }
    }
    return null;
  }

  /**
   * Decorates send_message custody receipt response.
   *
   * @param {object} sendResponse Response from server/journal.
   * @param {object} [options]
   * @param {object} [options.resolution] Result of resolveSend.
   * @param {object} [options.record] Journal record.
   * @param {object} [options.target] Target override.
   * @param {string} [options.phase] Phase override.
   * @returns {object} Decorated response.
   */
  function decorateSend(sendResponse, options = {}) {
    if (sendResponse === null || typeof sendResponse !== "object") {
      throw new TypeError("sendResponse must be an object");
    }

    const clean = sanitizeDto(sendResponse);

    if (!isEnabled()) {
      return Object.freeze(clean);
    }

    const phase = clean.status || options.phase || options.record?.phase || "queued_local";
    const state = localState(phase);

    let target;
    // An alias send is reported as the principal it resolved to: the public target has no third form (projectTarget).
    const isPrincipal = options.record
      ? (options.record.resolved_via === "principal" || options.record.resolved_via === "alias" || Boolean(options.record.to_principal))
      : (options.resolution?.via === "principal" || options.resolution?.via === "alias");

    if (options.target !== undefined) {
      target = projectTarget(options.target);
    } else if (isPrincipal) {
      const recipientId = options.record?.recipient || options.resolution?.resolvedTo;
      const profile = options.resolution?.profile || lookupProfile(recipientId);
      const principal = (options.record && "to_principal" in options.record)
        ? options.record.to_principal
        : (options.resolution?.principal ?? null);
      target = projectTarget({
        via: "principal",
        ...(principal ? { principal } : {}),
        ...(profile ? { profile } : {}),
      });
    } else {
      const instanceId =
        options.record?.recipient || options.resolution?.resolvedTo || clean.to;
      const profile = options.resolution?.profile || lookupProfile(instanceId);
      let principal = (options.record && "to_principal" in options.record)
        ? options.record.to_principal
        : options.resolution?.principal;

      if (!principal && !options.record && instanceId && snapshotProvider && typeof snapshotProvider.get === "function") {
        try {
          const snap = options.snapshot ?? snapshotProvider.get();
          if (snap?.state === "ok") {
            const binding = snap.bindingForInstance(instanceId);
            if (binding?.principal_id) {
              principal = binding.principal_id;
            }
          }
        } catch {
          // Fail closed on registry access, do not fabricate principal
        }
      }

      target = projectTarget({
        via: "id",
        ...(principal ? { principal } : {}),
        ...(profile ? { profile } : {}),
      });
    }

    return Object.freeze({
      ...clean,
      route: "local",
      state,
      target,
    });
  }

  /**
   * Decorates get_message_status response.
   *
   * @param {object} statusResponse Status response DTO.
   * @param {object} [options]
   * @param {object} [options.record] Journal record.
   * @param {object} [options.resolution] Resolution metadata.
   * @param {object} [options.target] Explicit target override.
   * @returns {object} Decorated status response.
   */
  function decorateStatus(statusResponse, options = {}) {
    if (statusResponse === null || typeof statusResponse !== "object") {
      throw new TypeError("statusResponse must be an object");
    }

    const clean = sanitizeDto(statusResponse);

    if (!isEnabled()) {
      return Object.freeze(clean);
    }

    const phase = clean.phase || options.record?.phase || "unknown";
    const state = localState(phase);

    let target;
    if (options.target !== undefined) {
      target = projectTarget(options.target);
    } else if (
      options.resolution?.via === "principal" ||
      options.resolution?.via === "alias" ||
      options.record?.resolved_via === "principal" ||
      options.record?.resolved_via === "alias" ||
      Boolean(options.record?.to_principal)
    ) {
      const recipientId = options.resolution?.resolvedTo || options.record?.recipient;
      const profile = options.resolution?.profile || lookupProfile(recipientId);
      const principal = options.resolution?.principal ?? options.record?.to_principal;
      target = projectTarget({
        via: "principal",
        ...(principal ? { principal } : {}),
        ...(profile ? { profile } : {}),
      });
    } else {
      const recipientId = options.resolution?.resolvedTo || options.record?.recipient;
      const profile = options.resolution?.profile || lookupProfile(recipientId);
      let principal = options.resolution?.principal;

      if (!principal && recipientId && snapshotProvider && typeof snapshotProvider.get === "function") {
        try {
          const snap = options.snapshot ?? snapshotProvider.get();
          if (snap?.state === "ok") {
            const binding = snap.bindingForInstance(recipientId);
            if (binding?.principal_id) {
              principal = binding.principal_id;
            }
          }
        } catch {
          // Do not fabricate principal
        }
      }

      target = projectTarget({
        via: "id",
        ...(principal ? { principal } : {}),
        ...(profile ? { profile } : {}),
      });
    }

    return Object.freeze({
      ...clean,
      route: "local",
      state,
      target,
    });
  }

  /**
   * Decorates list_replies response.
   *
   * @param {object|Array} responseOrReplies Replies response object or replies array.
   * @param {object} [options]
   * @returns {object|Array} Decorated replies.
   */
  function decorateReplies(responseOrReplies, options = {}) {
    const isContainer =
      responseOrReplies !== null &&
      typeof responseOrReplies === "object" &&
      Array.isArray(responseOrReplies.replies);

    const list = isContainer ? responseOrReplies.replies : responseOrReplies;
    if (!Array.isArray(list)) {
      throw new TypeError("replies must be an array or an object with a replies array");
    }

    const enabled = isEnabled();
    const processed = list.map((item) => {
      if (item === null || typeof item !== "object") return item;
      const clean = sanitizeDto(item);
      if (!enabled) {
        return Object.freeze(clean);
      }
      return Object.freeze({
        ...clean,
        route: "local",
      });
    });

    if (isContainer) {
      const cleanContainer = sanitizeDto(responseOrReplies);
      return Object.freeze({
        ...cleanContainer,
        replies: Object.freeze(processed),
      });
    }

    return Object.freeze(processed);
  }

  /**
   * Decorates list_sessions response.
   *
   * @param {object|Array} responseOrSessions Sessions response object or sessions array.
   * @param {object} [options]
   * @param {object} [options.snapshot]
   * @returns {object|Array} Decorated sessions.
   */
  function decorateSessions(responseOrSessions, options = {}) {
    const isContainer =
      responseOrSessions !== null &&
      typeof responseOrSessions === "object" &&
      Array.isArray(responseOrSessions.sessions);

    const list = isContainer ? responseOrSessions.sessions : responseOrSessions;
    if (!Array.isArray(list)) {
      throw new TypeError("sessions must be an array or an object with a sessions array");
    }

    const enabled = isEnabled();

    if (!enabled) {
      const processed = list.map((item) => {
        if (item === null || typeof item !== "object") return item;
        return Object.freeze(sanitizeDto(item));
      });
      if (isContainer) {
        const cleanContainer = sanitizeDto(responseOrSessions);
        return Object.freeze({
          ...cleanContainer,
          sessions: Object.freeze(processed),
        });
      }
      return Object.freeze(processed);
    }

    let snapshot = null;
    if (snapshotProvider && typeof snapshotProvider.get === "function") {
      try {
        snapshot = options.snapshot ?? snapshotProvider.get();
      } catch {
        // Snapshot unreadable: sessions return principal: null
      }
    }

    const processed = list.map((item) => {
      if (item === null || typeof item !== "object") return item;
      const clean = sanitizeDto(item);
      let principal = null;
      if (snapshot?.state === "ok" && typeof item.id === "string") {
        const binding = snapshot.bindingForInstance(item.id);
        if (binding?.principal_id) {
          principal = binding.principal_id;
        }
      }
      return Object.freeze({
        ...clean,
        principal,
      });
    });

    if (isContainer) {
      const cleanContainer = sanitizeDto(responseOrSessions);
      return Object.freeze({
        ...cleanContainer,
        sessions: Object.freeze(processed),
      });
    }

    return Object.freeze(processed);
  }

  /**
   * Explains local addresses for one caller, read-only: the route, the principal (and whether "none" is actually
   * known), and which address forms currently reach exactly that recipient. Used by `sessions` and `discover` so a
   * caller does not have to join their lists by hand. Returns null while the router is disabled, so legacy output
   * stays byte-for-byte what it was.
   *
   * Reads the registry snapshot and the local directory only: it resolves nothing through resolveSend, so it never
   * moves the send counters, and it never names another candidate of a shared principal.
   *
   * @param {string[]} ids Exact addresses to explain.
   * @param {object} [options]
   * @param {(id: string) => boolean} [options.permitted] The caller's send gate for an address (owner policy and
   *   credential scope). Without it nothing is claimed about sending and `send` is omitted.
   * @param {object} [options.snapshot]
   * @returns {ReadonlyArray<object>|null} One frozen explanation per id, in order.
   */
  function describeAddresses(ids, options = {}) {
    if (!isEnabled()) return null;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new TypeError("ids must be an array of strings");
    }
    const permitted = typeof options.permitted === "function" ? options.permitted : null;

    let snapshot = options.snapshot ?? null;
    if (!snapshot && snapshotProvider && typeof snapshotProvider.get === "function") {
      try {
        snapshot = snapshotProvider.get();
      } catch {
        snapshot = null; // an unreadable registry is unknown, never "no principal"
      }
    }
    const directory = getRecipients();

    // Whether to:<principal> resolves to exactly this recipient, by the resolver send uses and for any caller.
    const principalNamesOnly = (principal, id) => {
      try {
        const res = resolveRecipient({ to: principal, recipients: directory, snapshot });
        return res.kind === "resolved" && res.recipientId === id;
      } catch {
        return false; // a directory the resolver cannot read offers no principal form
      }
    };

    // The owner-set aliases a send by this caller would resolve to exactly this recipient (AD.1): by the same decision a send
    // makes (recipient-resolver.mjs), so a name is listed only if it is visible to the caller, does not collide with a label the
    // caller can see and is not shared with another recipient. Sorted (the snapshot sorts them) and bounded.
    const aliasNamesFor = (principal, id) => {
      if (typeof snapshot?.aliasesFor !== "function") return [];
      let names;
      try {
        names = snapshot.aliasesFor(principal);
      } catch {
        return [];
      }
      const mayMessage = (candidate) => {
        try {
          return permitted(candidate) === true;
        } catch {
          return false;
        }
      };
      const listed = [];
      for (const name of names) {
        let decision;
        try {
          decision = resolveAliasFor({ name, recipients: directory, snapshot, permitted: mayMessage });
        } catch {
          continue;
        }
        if (decision.kind === "resolved" && decision.recipientId === id) listed.push(name);
        if (listed.length >= MAX_ALIAS_NAMES_PER_ENTRY) break;
      }
      return listed;
    };

    return Object.freeze(
      ids.map((id) => {
        const { principal, state } = lookupPrincipal(snapshot, id);
        const explanation = { id, route: "local", principal, principalState: state };
        if (permitted) {
          let allowed = false;
          try {
            allowed = permitted(id) === true;
          } catch {
            allowed = false;
          }
          const kinds = [];
          let aliases = [];
          if (allowed) {
            kinds.push("id");
            if (principal !== null && principalNamesOnly(principal, id)) kinds.push("principal");
            if (principal !== null) aliases = aliasNamesFor(principal, id);
          }
          // `addressKinds` stays within id and principal: a client from before aliases drops a whole explanation that names another
          // kind, so the alias names travel in their own field, which such a client simply does not pass on.
          explanation.send = Object.freeze({
            permitted: allowed,
            addressKinds: Object.freeze(kinds),
            ...(aliases.length > 0 ? { aliases: Object.freeze(aliases) } : {}),
          });
        }
        return Object.freeze(explanation);
      })
    );
  }

  /**
   * Decorates list_inbox response, ensuring raw internal journal columns
   * (to_principal, resolved_via) are stripped in both router modes while
   * preserving stable pagination and cursor fields.
   *
   * @param {object|Array} responseOrItems Inbox response object or items array.
   * @param {object} [options]
   * @returns {object|Array} Decorated inbox response.
   */
  function decorateInbox(responseOrItems, options = {}) {
    const isContainer =
      responseOrItems !== null &&
      typeof responseOrItems === "object" &&
      Array.isArray(responseOrItems.items);

    const list = isContainer ? responseOrItems.items : responseOrItems;
    if (!Array.isArray(list)) {
      throw new TypeError("inbox items must be an array or an object with an items array");
    }

    const processed = list.map((item) => {
      if (item === null || typeof item !== "object") return item;
      return Object.freeze(sanitizeDto(item));
    });

    if (isContainer) {
      const cleanContainer = sanitizeDto(responseOrItems);
      return Object.freeze({
        ...cleanContainer,
        items: Object.freeze(processed),
        nextCursor: responseOrItems.nextCursor ?? null,
      });
    }

    return Object.freeze(processed);
  }

  /**
   * Generates status block for local_status.router.
   *
   * `registry.schema` is the schema of the registry last read (null when there is none or it cannot be read) and
   * `registry.supportedSchemas` lists every schema this process can read, even while the router is disabled: it is what the
   * registry upgrade asks the running process before it writes a v2 file. A supervisor that predates it omits the field.
   *
   * @param {object} [options]
   * @param {object} [options.snapshot]
   * @returns {object} Status block.
   */
  function statusBlock(options = {}) {
    if (!isEnabled()) {
      return Object.freeze({
        enabled: false,
        registry: Object.freeze({
          state: "disabled",
          sequence: 0,
          schema: null,
          supportedSchemas: SUPPORTED_REGISTRY_SCHEMAS,
          addressForms: ADDRESS_FORMS_DISABLED,
        }),
        resolved: Object.freeze({
          principal: counters.resolved.principal,
          id: counters.resolved.id,
          alias: counters.resolved.alias,
        }),
        errors: Object.freeze({ ...counters.errors }),
      });
    }

    let state = "unknown";
    let sequence = 0;
    let schema = null;

    if (options.snapshot) {
      state = options.snapshot.state ?? "unknown";
      sequence = options.snapshot.sequence ?? 0;
      schema = typeof options.snapshot.schema === "string" ? options.snapshot.schema : null;
    } else if (snapshotProvider && typeof snapshotProvider.get === "function") {
      try {
        const snap = snapshotProvider.get();
        state = snap?.state ?? "unknown";
        sequence = snap?.sequence ?? 0;
        schema = typeof snap?.schema === "string" ? snap.schema : null;
      } catch {
        state = "unreadable";
        sequence = 0;
        schema = null;
      }
    }

    return Object.freeze({
      enabled: true,
      registry: Object.freeze({
        state,
        sequence,
        schema,
        supportedSchemas: SUPPORTED_REGISTRY_SCHEMAS,
        addressForms: ADDRESS_FORMS_ENABLED,
      }),
      resolved: Object.freeze({
        principal: counters.resolved.principal,
        id: counters.resolved.id,
        alias: counters.resolved.alias,
      }),
      errors: Object.freeze({ ...counters.errors }),
    });
  }

  function getCounters() {
    return Object.freeze({
      resolved: Object.freeze({ ...counters.resolved }),
      errors: Object.freeze({ ...counters.errors }),
    });
  }

  function resetCounters() {
    counters.resolved.principal = 0;
    counters.resolved.id = 0;
    counters.resolved.alias = 0;
    for (const key of Object.keys(counters.errors)) {
      counters.errors[key] = 0;
    }
  }

  return Object.freeze({
    resolveSend,
    decorateSend,
    decorateStatus,
    decorateReplies,
    decorateSessions,
    describeAddresses,
    decorateInbox,
    statusBlock,
    getCounters,
    resetCounters,
  });
}

/**
 * Top-level convenience functions delegating to an injected or ephemeral router.
 */
export function resolveSend(params, options = {}) {
  const router = options.router ?? createUnifiedRouter(options);
  return router.resolveSend(params, options);
}

export function decorateSend(sendResponse, options = {}) {
  const router = options.router ?? createUnifiedRouter(options);
  return router.decorateSend(sendResponse, options);
}

export function decorateStatus(statusResponse, options = {}) {
  const router = options.router ?? createUnifiedRouter(options);
  return router.decorateStatus(statusResponse, options);
}

export function decorateReplies(responseOrReplies, options = {}) {
  const router = options.router ?? createUnifiedRouter(options);
  return router.decorateReplies(responseOrReplies, options);
}

export function decorateSessions(responseOrSessions, options = {}) {
  const router = options.router ?? createUnifiedRouter(options);
  return router.decorateSessions(responseOrSessions, options);
}

export function describeAddresses(ids, options = {}) {
  const router = options.router ?? createUnifiedRouter(options);
  return router.describeAddresses(ids, options);
}

export function decorateInbox(responseOrItems, options = {}) {
  const router = options.router ?? createUnifiedRouter(options);
  return router.decorateInbox(responseOrItems, options);
}

export function statusBlock(options = {}) {
  const router = options.router ?? createUnifiedRouter(options);
  return router.statusBlock(options);
}
