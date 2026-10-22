import crypto from "node:crypto";
import { resolveLocalSocketAddress } from "./local-messaging-address.mjs";
import { createLocalControlServer } from "./local-messaging-server.mjs";
import { createLocalControlClient } from "./local-messaging-client.mjs";
import { validateJournalAdapter } from "./local-messaging-journal-contract.mjs";
import { createOwnerAcl } from "./local-messaging-acl.mjs";
import {
  createTurnCapabilityIssuer,
  createTurnCapabilityValidator,
} from "./local-messaging-credentials.mjs";
import {
  createPerSenderRateLimiter,
  createConversationLoopTracker,
} from "./local-messaging-rate-limiter.mjs";
import { coded } from "./local-messaging-errors.mjs";

/**
 * createLocalMessagingSubsystem:
 * Hosted by client-supervisor.mjs.
 *
 * Receives registry, durable journal, execution admission, and turn-capability issuer dependencies.
 * Production requires an injected durable shared-journal adapter (no silent SQLite/memory fallback).
 */
export function createLocalMessagingSubsystem({
  stateRoot,
  registry = [],
  journal,
  dispatcher,
  turnCapabilityIssuer = null,
  turnCapabilityValidator = null,
  credentialBroker = null,
  statusProvider = null,
  aclRules = {},
  ownerAcl = null,
  rateLimiter = null,
  loopTracker = null,
  socketName = "local-control.sock",
  logger = { info() {}, warn() {}, error() {} },
} = {}) {
  if (!stateRoot) throw coded("invalid_options", "stateRoot is required");

  // Production requirement: Injected durable journal adapter is strictly required
  if (!journal) {
    throw coded(
      "journal_required",
      "Durable journal adapter is required. Production default database implementation is prohibited.",
    );
  }
  const activeJournal = validateJournalAdapter(journal);

  // The host owns execution recovery and shutdown; no optional no-op adapter.
  const activeDispatcher = dispatcher;

  if (!activeDispatcher) {
    throw coded(
      "dispatcher_required",
      "Execution dispatcher is required. Missing explicit dispatch implementation.",
    );
  }

  if (
    !(typeof activeDispatcher.start === "function" || typeof activeDispatcher.recover === "function") ||
    !(typeof activeDispatcher.stop === "function" || typeof activeDispatcher.wait === "function")
  ) {
    throw coded("invalid_dispatcher", "Dispatcher requires recovery and shutdown hooks");
  }

  const dispatchHook =
    activeDispatcher.notifyAdmission ||
    activeDispatcher.admitExecution ||
    activeDispatcher.dispatch;
  if (typeof dispatchHook !== "function") {
    throw coded(
      "invalid_dispatcher",
      "Dispatcher must implement notifyAdmission, admitExecution, or dispatch hook",
    );
  }

  const { socketPath } = resolveLocalSocketAddress({ stateRoot, name: socketName });

  // Normalise known profiles from registry
  const knownProfiles = new Set();
  if (Array.isArray(registry)) {
    for (const item of registry) {
      if (typeof item === "string" && item.trim()) {
        knownProfiles.add(item.trim());
      } else if (item && typeof item === "object") {
        const id = item.profile || item.instanceId || item.id;
        if (id && typeof id === "string") knownProfiles.add(id.trim());
      }
    }
  }

  // Issuer / Validator pair: require injected pair or securely generate private in-memory key per subsystem
  let issuer = turnCapabilityIssuer;
  let validator = turnCapabilityValidator;
  if (!issuer || !validator) {
    const privateSubsystemKey = crypto.randomBytes(32).toString("hex");
    issuer = createTurnCapabilityIssuer({ secret: privateSubsystemKey });
    validator = createTurnCapabilityValidator({ secret: privateSubsystemKey });
  }

  const acl = ownerAcl || createOwnerAcl({ rules: aclRules });
  const limiter = rateLimiter || createPerSenderRateLimiter();
  const tracker = loopTracker || createConversationLoopTracker({ journal: activeJournal });

  const server = createLocalControlServer({
    socketPath,
    journal: activeJournal,
    acl,
    credentialValidator: validator,
    credentialBroker,
    statusProvider,
    rateLimiter: limiter,
    loopTracker: tracker,
    dispatcher: activeDispatcher,
    logger,
  });

  let running = false;
  let stopped = false;

  return {
    get socketPath() {
      return socketPath;
    },

    get running() {
      return running;
    },

    async start() {
      if (stopped) throw coded("subsystem_closed", "Subsystem was stopped");
      if (running) return;
      await server.start();
      running = true;
      logger.info?.("Local messaging subsystem started on " + socketPath);
    },

    async stop() {
      if (stopped) return;
      // Close server first, awaiting in-flight executions before closing the journal
      await server.close();
      await activeJournal.close?.();
      running = false;
      stopped = true;
      logger.info?.("Local messaging subsystem stopped");
    },

    issueTurnCredential(senderId, options = {}) {
      if (!senderId || typeof senderId !== "string") {
        throw coded("invalid_sender_id", "senderId must be a non-empty string");
      }
      const trimmedSender = senderId.trim();

      // Enforce registry identities: unknown profile issuance refused if registry is configured
      if (knownProfiles.size > 0 && !knownProfiles.has(trimmedSender)) {
        throw coded("unknown_profile", `Turn credential issuance refused for unknown profile: ${trimmedSender}`);
      }

      return issuer.issue({ senderId: trimmedSender, ...options });
    },

    createClient(senderId, options = {}) {
      // NEVER give validator or private key to clients
      const {
        credentialValidator: _cv,
        turnCapabilityValidator: _tcv,
        turnCapabilityIssuer: _tci,
        secret: _sec,
        capabilitySecret: _csec,
        ...clientOptions
      } = options;

      const turnCredential = this.issueTurnCredential(senderId, clientOptions);
      return createLocalControlClient({
        socketPath,
        turnCredential,
        senderId,
        ...clientOptions,
      });
    },

    status() {
      return {
        enabled: true,
        route: "same-device",
        running,
        socketPath,
        registeredProfiles: Array.from(knownProfiles),
      };
    },
  };
}
