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

import { AGENT_ID_PATTERN } from "./identity-primitives.mjs";
import { resolveRecipient } from "./recipient-resolver.mjs";
import { localState } from "./transport-adapter-contract.mjs";
import { LocalMessagingError } from "./local-messaging-errors.mjs";

const PEER_ID_PATTERN = /^peer_[a-f0-9]{32}$/;
const RAW_JOURNAL_FIELDS = Object.freeze(["to_principal", "resolved_via"]);

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
    },
    errors: {
      recipient_not_found: 0,
      route_unavailable: 0,
      recipient_ambiguous: 0,
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

    const throwOnError = callOptions.throwOnError !== false;
    const effectiveCanMessage = callOptions.canMessage ?? canMessage;
    const effectiveRecipients = callOptions.recipients ?? getRecipients();

    // 1. Router disabled: zero registry reads, pass through untouched
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

    const isAgent = AGENT_ID_PATTERN.test(to);
    const isPeer = PEER_ID_PATTERN.test(to);

    // 2. Non-principal legacy identifier: passes through with via: "id"
    if (!isAgent && !isPeer) {
      counters.resolved.id += 1;

      let boundPrincipal = null;
      let boundProfile = null;

      // Legacy delivery must not fail even if registry is unreadable or absent.
      if (snapshotProvider && typeof snapshotProvider.get === "function") {
        try {
          const snapshot = callOptions.snapshot ?? snapshotProvider.get();
          if (snapshot?.state === "ok") {
            const binding = snapshot.bindingForInstance(to);
            if (binding?.principal_id) {
              boundPrincipal = binding.principal_id;
            }
          }
        } catch {
          // Ignore registry errors for legacy delivery
        }
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
    if (options.target && typeof options.target === "object") {
      target = sanitizeDto(options.target);
    } else if (
      options.resolution?.via === "principal" ||
      options.record?.resolved_via === "principal" ||
      Boolean(options.record?.to_principal)
    ) {
      const recipientId = options.resolution?.resolvedTo || options.record?.recipient;
      const profile = options.resolution?.profile || lookupProfile(recipientId);
      target = {
        via: "principal",
        principal: options.resolution?.principal ?? options.record?.to_principal,
        ...(profile ? { profile } : {}),
      };
    } else {
      target = {
        via: "id",
      };

      const instanceId =
        options.resolution?.resolvedTo || options.record?.recipient || clean.to;
      const profile = options.resolution?.profile || lookupProfile(instanceId);

      if (options.resolution?.principal) {
        target.principal = options.resolution.principal;
        if (profile) {
          target.profile = profile;
        }
      } else {
        if (instanceId && snapshotProvider && typeof snapshotProvider.get === "function") {
          try {
            const snap = options.snapshot ?? snapshotProvider.get();
            if (snap?.state === "ok") {
              const binding = snap.bindingForInstance(instanceId);
              if (binding?.principal_id) {
                target.principal = binding.principal_id;
              }
            }
          } catch {
            // Fail closed on registry access, do not fabricate principal
          }
        }
        if (profile) {
          target.profile = profile;
        }
      }
    }

    return Object.freeze({
      ...clean,
      route: "local",
      state,
      target: Object.freeze(target),
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
    if (options.target && typeof options.target === "object") {
      target = sanitizeDto(options.target);
    } else if (
      options.resolution?.via === "principal" ||
      options.record?.resolved_via === "principal" ||
      Boolean(options.record?.to_principal)
    ) {
      const recipientId = options.resolution?.resolvedTo || options.record?.recipient;
      const profile = options.resolution?.profile || lookupProfile(recipientId);
      target = {
        via: "principal",
        principal: options.resolution?.principal ?? options.record?.to_principal,
        ...(profile ? { profile } : {}),
      };
    } else {
      target = {
        via: "id",
      };

      const recipientId = options.resolution?.resolvedTo || options.record?.recipient;
      const profile = options.resolution?.profile || lookupProfile(recipientId);

      if (options.resolution?.principal) {
        target.principal = options.resolution.principal;
        if (profile) {
          target.profile = profile;
        }
      } else if (recipientId && snapshotProvider && typeof snapshotProvider.get === "function") {
        try {
          const snap = options.snapshot ?? snapshotProvider.get();
          if (snap?.state === "ok") {
            const binding = snap.bindingForInstance(recipientId);
            if (binding?.principal_id) {
              target.principal = binding.principal_id;
            }
          }
        } catch {
          // Do not fabricate principal
        }
      }
      if (profile) {
        target.profile = profile;
      }
    }

    return Object.freeze({
      ...clean,
      route: "local",
      state,
      target: Object.freeze(target),
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
   * Generates status block for local_status.router.
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
        }),
        resolved: Object.freeze({
          principal: counters.resolved.principal,
          id: counters.resolved.id,
        }),
        errors: Object.freeze({ ...counters.errors }),
      });
    }

    let state = "unknown";
    let sequence = 0;

    if (options.snapshot) {
      state = options.snapshot.state ?? "unknown";
      sequence = options.snapshot.sequence ?? 0;
    } else if (snapshotProvider && typeof snapshotProvider.get === "function") {
      try {
        const snap = snapshotProvider.get();
        state = snap?.state ?? "unknown";
        sequence = snap?.sequence ?? 0;
      } catch {
        state = "unreadable";
        sequence = 0;
      }
    }

    return Object.freeze({
      enabled: true,
      registry: Object.freeze({
        state,
        sequence,
      }),
      resolved: Object.freeze({
        principal: counters.resolved.principal,
        id: counters.resolved.id,
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

export function statusBlock(options = {}) {
  const router = options.router ?? createUnifiedRouter(options);
  return router.statusBlock(options);
}
