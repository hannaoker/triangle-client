// Paired interactive Antigravity callers: each pairing holds its own
// local senderId, credential secret, and explicit sender/recipient grants.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readPrivateJson, writePrivateJson, withPrivateFileLock } from "./local-messaging-auth-broker.mjs";
import {
  createInteractiveSessionBroker,
  readSessionMessagingPolicy,
  HEX64_PATTERN,
  UUID_PATTERN,
} from "./local-messaging-interactive-session.mjs";
import { createLocalControlClient } from "./local-messaging-client.mjs";
import { resolveLocalSocketAddress } from "./local-messaging-address.mjs";
import { createLocalMessagingMcpHandler, runMcpStdioSession } from "./local-messaging-mcp-adapter.mjs";
import { coded } from "./local-messaging-errors.mjs";

const ALIAS = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ADDRESS = /^(session-)?[a-f0-9]{64}$/;
const HARNESSES = ["claude", "codex"];
const KEYS = [
  "version",
  "type",
  "alias",
  "senderId",
  "sessionId",
  "generation",
  "bindingId",
  "secret",
  "enabled",
  "revoked",
  "allowedSenders",
  "allowedRecipients",
  "allowedHarnesses",
];

const hash = (value) => createHash("sha256").update(value).digest("hex");

function exactIds(ids) {
  return (
    Array.isArray(ids) &&
    ids.length <= 64 &&
    new Set(ids).size === ids.length &&
    ids.every((id) => typeof id === "string" && ADDRESS.test(id))
  );
}

function exactHarnesses(harnesses) {
  return (
    Array.isArray(harnesses) &&
    new Set(harnesses).size === harnesses.length &&
    harnesses.every((h) => HARNESSES.includes(h))
  );
}

function harnessOfRow(row) {
  return row?.harness === "codex" ? "codex" : "claude";
}

function resolveGrantAddresses(values, config) {
  const list = values || [];
  if (!Array.isArray(list)) {
    throw coded("invalid_antigravity_grants", "Grant addresses must be an array");
  }
  const resolved = [];
  for (const raw of list) {
    if (typeof raw !== "string" || !raw) {
      throw coded("invalid_antigravity_grants", "Exact address or configured recipient profile required");
    }
    if (ADDRESS.test(raw)) {
      resolved.push(raw);
      continue;
    }
    const profile = Array.isArray(config.recipients)
      ? config.recipients.find((r) => r.profile === raw)?.instanceId
      : null;
    if (!profile || !ADDRESS.test(profile)) {
      throw coded("invalid_antigravity_grants", `Unknown recipient or invalid address: ${raw}`);
    }
    resolved.push(profile);
  }
  const unique = [...new Set(resolved)];
  if (!exactIds(unique)) {
    throw coded("invalid_antigravity_grants", "Grant address limit exceeded");
  }
  return unique;
}

export function readAntigravityBinding(file) {
  const b = readPrivateJson(file);
  if (
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    Object.keys(b).sort().join(",") !== [...KEYS].sort().join(",") ||
    b.version !== 1 ||
    b.type !== "antigravity" ||
    typeof b.alias !== "string" ||
    !ALIAS.test(b.alias) ||
    typeof b.senderId !== "string" ||
    !HEX64_PATTERN.test(b.senderId) ||
    typeof b.secret !== "string" ||
    !HEX64_PATTERN.test(b.secret) ||
    !UUID_PATTERN.test(b.sessionId) ||
    !UUID_PATTERN.test(b.bindingId) ||
    !Number.isSafeInteger(b.generation) ||
    b.generation < 1 ||
    typeof b.enabled !== "boolean" ||
    typeof b.revoked !== "boolean" ||
    !exactIds(b.allowedSenders) ||
    !exactIds(b.allowedRecipients) ||
    !exactHarnesses(b.allowedHarnesses)
  ) {
    throw coded("invalid_antigravity_binding", "Invalid Antigravity pairing");
  }
  return b;
}

export function antigravityBindings(config) {
  const a = config.antigravity;
  if (a === undefined) return [];
  if (
    !a ||
    typeof a !== "object" ||
    Array.isArray(a) ||
    Object.keys(a).sort().join(",") !== "bindings,enabled" ||
    typeof a.enabled !== "boolean" ||
    !Array.isArray(a.bindings) ||
    a.bindings.length > 32 ||
    new Set(a.bindings).size !== a.bindings.length ||
    a.bindings.some((file) => typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0"))
  ) {
    throw coded("invalid_antigravity_config", "Invalid Antigravity configuration");
  }
  const entries = a.bindings.map((file) => ({ file, ...readAntigravityBinding(file) }));
  if (
    new Set(entries.map((b) => b.senderId)).size !== entries.length ||
    new Set(entries.map((b) => b.alias)).size !== entries.length
  ) {
    throw coded("identity_collision", "Duplicate Antigravity identity or alias");
  }
  return entries;
}

function selectAntigravityEntry(entries, alias) {
  if (!entries.length) {
    throw coded("unknown_antigravity_alias", "No Antigravity pairing is configured");
  }
  if (alias !== undefined) {
    const match = entries.find((b) => b.alias === alias);
    if (!match) throw coded("unknown_antigravity_alias", "Unknown Antigravity alias");
    return match;
  }
  if (entries.length === 1) return entries[0];
  throw coded("ambiguous_antigravity_alias", "Specify --alias when multiple Antigravity pairings exist");
}

function collectReservedIds(config) {
  const reserved = [
    readPrivateJson(config.integrationPath).senderId,
    ...(config.recipients || []).map((r) => r.instanceId),
  ];
  if (config.interactive?.enabled && config.interactive.integrationPath) {
    try {
      reserved.push(readPrivateJson(config.interactive.integrationPath).senderId);
    } catch {}
  }
  if (config.grok?.bindings) {
    for (const file of config.grok.bindings) {
      try {
        reserved.push(readPrivateJson(file).senderId);
      } catch {}
    }
  }
  return new Set(reserved.filter((id) => typeof id === "string"));
}

const DEFAULT_IO = Object.freeze({
  readJson: readPrivateJson,
  writeJson: writePrivateJson,
  unlinkFile: (file) => fs.unlinkSync(file),
  exists: (file) => fs.existsSync(file),
});

function resolveIo(io = {}) {
  return { ...DEFAULT_IO, ...io };
}

function planWorkspaceSessionPolicy({
  config,
  senderId,
  allowedSenders,
  allowedHarnesses,
  addedSessions = [],
  removedSessions = [],
}) {
  const needsClaude = allowedHarnesses.includes("claude");
  const needsCodex = allowedHarnesses.includes("codex");
  const needsSessionSenders = allowedSenders.some((id) => id.startsWith("session-"));
  const touchesWorkspace =
    needsClaude || needsCodex || needsSessionSenders || addedSessions.length > 0;
  const hasWorkspacePolicy = Boolean(config.sessionMessaging?.enabled);
  if (touchesWorkspace && !hasWorkspacePolicy) {
    throw coded("session_messaging_required", "Enable workspace session messaging first");
  }
  if (!hasWorkspacePolicy) return null;

  const policyPath = config.sessionMessaging.integrationPath;
  const policy = readSessionMessagingPolicy(policyPath);
  if (needsCodex && policy.codex?.enabled !== true) {
    throw coded("session_messaging_required", "Enable Codex workspace session messaging first");
  }

  let version = policy.version;
  const allowedPolicySenders = needsClaude
    ? [...new Set([...policy.allowedSenders, senderId])]
    : policy.allowedSenders.filter((id) => id !== senderId);
  const allowedPolicyRecipients = needsSessionSenders
    ? [...new Set([...policy.allowedRecipients, senderId])]
    : policy.allowedRecipients.filter((id) => id !== senderId);

  let nextCodex = policy.codex;
  if (policy.codex !== undefined) {
    const codexSenders = needsCodex
      ? [...new Set([...policy.codex.allowedSenders, senderId])]
      : policy.codex.allowedSenders.filter((id) => id !== senderId);
    if (codexSenders.length > 64) {
      throw coded("antigravity_policy_capacity", "Workspace Codex policy cannot admit another principal");
    }
    nextCodex = { ...policy.codex, allowedSenders: codexSenders };
  }

  let exactPairs = policy.exactPairs;
  if (addedSessions.length > 0 || (removedSessions.length > 0 && Array.isArray(policy.exactPairs))) {
    const existing = Array.isArray(policy.exactPairs) ? [...policy.exactPairs] : [];
    const removeSet = new Set(removedSessions);
    const filtered = existing.filter((p) => !(p.sender === senderId && removeSet.has(p.recipient)));
    for (const recipient of addedSessions) {
      if (!filtered.some((p) => p.sender === senderId && p.recipient === recipient)) {
        filtered.push({ sender: senderId, recipient });
      }
    }
    if (filtered.length > 128) {
      throw coded("session_grant_capacity", "Exact session grant capacity reached");
    }
    if (addedSessions.length > 0) version = Math.max(2, version);
    exactPairs = filtered;
  }

  if (allowedPolicySenders.length > 64 || allowedPolicyRecipients.length > 64) {
    throw coded("antigravity_policy_capacity", "Workspace policy cannot admit another principal");
  }

  const nextPolicy = {
    ...policy,
    version,
    allowedSenders: allowedPolicySenders,
    allowedRecipients: allowedPolicyRecipients,
    ...(nextCodex !== undefined ? { codex: nextCodex } : {}),
    ...(exactPairs !== undefined ? { exactPairs } : {}),
  };
  if (JSON.stringify(nextPolicy) === JSON.stringify(policy)) return null;
  return { path: policyPath, existed: true, previousValue: policy, value: nextPolicy };
}

function commitPrivateJsonUpdates(updates, io) {
  const applied = [];
  for (const update of updates) {
    try {
      io.writeJson(update.path, update.value);
      applied.push(update);
    } catch (writeErr) {
      const rollbackErrors = [];
      for (let i = applied.length - 1; i >= 0; i--) {
        const entry = applied[i];
        try {
          if (entry.existed) {
            io.writeJson(entry.path, entry.previousValue);
          } else {
            try {
              io.unlinkFile(entry.path);
            } catch (unlinkErr) {
              if (unlinkErr?.code !== "ENOENT") throw unlinkErr;
            }
          }
        } catch (rbErr) {
          rollbackErrors.push(rbErr);
        }
      }
      if (rollbackErrors.length > 0) {
        const err = coded(
          "antigravity_partial_update_rollback_failed",
          "Antigravity multi-file update failed and rollback did not complete cleanly"
        );
        err.rollbackFailed = true;
        err.failedPhase = update.label ?? "write";
        err.cause = writeErr;
        throw err;
      }
      throw writeErr;
    }
  }
}

function withAntigravityLocks(configPath, io, operation) {
  return withPrivateFileLock(configPath, () => {
    const config = io.readJson(configPath);
    return config.sessionMessaging?.enabled
      ? withPrivateFileLock(config.sessionMessaging.integrationPath, () => operation(config))
      : operation(config);
  });
}

export function setupAntigravity(options, configPath, io = undefined) {
  const resolvedIo = resolveIo(io);
  return withAntigravityLocks(configPath, resolvedIo, (config) =>
    setupAntigravityLocked(options, configPath, config, resolvedIo)
  );
}

function setupAntigravityLocked(options, configPath, config, io) {
  if (config.version !== 1 || config.enabled !== true) {
    throw coded("local_disabled", "Enable local messaging first");
  }
  const entries = antigravityBindings(config);
  const alias = options.alias ?? "antigravity";
  if (!ALIAS.test(alias) || entries.some((b) => b.alias === alias) || entries.length >= 32) {
    throw coded("invalid_antigravity_alias", "Use a new distinct alias");
  }
  const allowedSenders = resolveGrantAddresses(options.senders || [], config);
  const allowedRecipients = resolveGrantAddresses(options.recipients || [], config);
  const allowedHarnesses = HARNESSES.filter(
    (h) => (h === "codex" && options.codexSessions === true) || (h === "claude" && options.claudeSessions === true)
  );
  if (options.codexSessions === false || options.claudeSessions === false) {
    throw coded("invalid_arguments", "Use grant/revoke commands to drop session harness access");
  }

  const owner = io.readJson(config.integrationPath).senderId;
  const senderId = hash(JSON.stringify(["triangle-antigravity-v1", owner, alias]));
  const reserved = collectReservedIds(config);
  if (entries.some((b) => b.senderId === senderId) || reserved.has(senderId)) {
    throw coded("identity_collision", "Antigravity identity collides with existing participant");
  }

  const file = path.join(config.stateRoot, `antigravity-${alias}.json`);
  if (io.exists(file)) {
    throw coded("pairing_exists", "Pairing file already exists");
  }

  const binding = {
    version: 1,
    type: "antigravity",
    alias,
    senderId,
    sessionId: randomUUID(),
    generation: 1,
    bindingId: randomUUID(),
    secret: randomBytes(32).toString("hex"),
    enabled: true,
    revoked: false,
    allowedSenders,
    allowedRecipients,
    allowedHarnesses,
  };

  const policyUpdate = planWorkspaceSessionPolicy({
    config,
    senderId,
    allowedSenders,
    allowedHarnesses,
    addedSessions: allowedRecipients.filter((id) => id.startsWith("session-")),
  });

  const updates = [
    ...(policyUpdate ? [{ ...policyUpdate, label: "session_policy" }] : []),
    { path: file, existed: false, value: binding, label: "pairing" },
    {
      path: configPath,
      existed: true,
      previousValue: config,
      value: {
        ...config,
        antigravity: { enabled: true, bindings: [...entries.map((b) => b.file), file] },
      },
      label: "local_config",
    },
  ];
  commitPrivateJsonUpdates(updates, io);

  return {
    senderId,
    alias: binding.alias,
    bindingFile: file,
    allowedSenders: binding.allowedSenders,
    allowedRecipients: binding.allowedRecipients,
    allowedHarnesses: binding.allowedHarnesses,
    wakeCapable: false,
    requiresServiceRestart: true,
  };
}

export function updateAntigravityGrants(mode, options, configPath, io = undefined) {
  if (mode !== "grant" && mode !== "revoke") {
    throw coded("invalid_arguments", "Unsupported Antigravity grant operation");
  }
  const resolvedIo = resolveIo(io);
  return withAntigravityLocks(configPath, resolvedIo, (config) =>
    updateAntigravityGrantsLocked(mode, options, config, resolvedIo)
  );
}

function updateAntigravityGrantsLocked(mode, options, config, io) {
  if (config.version !== 1 || config.enabled !== true) {
    throw coded("local_disabled", "Enable local messaging first");
  }
  const entry = selectAntigravityEntry(antigravityBindings(config), options.alias);
  const { file, ...binding } = entry;
  if (!binding.enabled || binding.revoked) {
    throw coded("session_disabled", "Antigravity pairing is disabled");
  }
  if (mode === "grant" && (options.codexSessions === false || options.claudeSessions === false)) {
    throw coded("invalid_arguments", "Use revoke-antigravity to remove session harness grants");
  }

  const targetSenders = resolveGrantAddresses(options.senders || [], config);
  const targetRecipients = resolveGrantAddresses(options.recipients || [], config);
  const modCodex = options.codexSessions !== undefined;
  const modClaude = options.claudeSessions !== undefined;

  let nextSenders;
  let nextRecipients;
  let nextHarnesses;
  let addedSessions = [];
  let removedSessions = [];

  if (mode === "grant") {
    nextSenders = [...new Set([...binding.allowedSenders, ...targetSenders])];
    nextRecipients = [...new Set([...binding.allowedRecipients, ...targetRecipients])];
    addedSessions = targetRecipients.filter(
      (id) => id.startsWith("session-") && !binding.allowedRecipients.includes(id)
    );
    const harnesses = new Set(binding.allowedHarnesses);
    if (options.codexSessions === true) harnesses.add("codex");
    if (options.claudeSessions === true) harnesses.add("claude");
    nextHarnesses = HARNESSES.filter((h) => harnesses.has(h));
  } else {
    const dropSenders = new Set(targetSenders);
    const dropRecipients = new Set(targetRecipients);
    nextSenders = binding.allowedSenders.filter((id) => !dropSenders.has(id));
    nextRecipients = binding.allowedRecipients.filter((id) => !dropRecipients.has(id));
    removedSessions = targetRecipients.filter(
      (id) => id.startsWith("session-") && binding.allowedRecipients.includes(id)
    );
    const harnesses = new Set(binding.allowedHarnesses);
    if (modCodex) harnesses.delete("codex");
    if (modClaude) harnesses.delete("claude");
    nextHarnesses = HARNESSES.filter((h) => harnesses.has(h));
  }

  if (!exactIds(nextSenders) || !exactIds(nextRecipients)) {
    throw coded("invalid_antigravity_grants", "Grant address limit exceeded");
  }

  const changed =
    JSON.stringify(nextSenders) !== JSON.stringify(binding.allowedSenders) ||
    JSON.stringify(nextRecipients) !== JSON.stringify(binding.allowedRecipients) ||
    JSON.stringify(nextHarnesses) !== JSON.stringify(binding.allowedHarnesses);

  if (changed) {
    const policyUpdate = planWorkspaceSessionPolicy({
      config,
      senderId: binding.senderId,
      allowedSenders: nextSenders,
      allowedHarnesses: nextHarnesses,
      addedSessions,
      removedSessions,
    });
    const updates = [
      ...(policyUpdate ? [{ ...policyUpdate, label: "session_policy" }] : []),
      {
        path: file,
        existed: true,
        previousValue: binding,
        value: {
          ...binding,
          allowedSenders: nextSenders,
          allowedRecipients: nextRecipients,
          allowedHarnesses: nextHarnesses,
        },
        label: "pairing",
      },
    ];
    commitPrivateJsonUpdates(updates, io);
  }

  return {
    alias: binding.alias,
    senderId: binding.senderId,
    allowedSenders: nextSenders,
    allowedRecipients: nextRecipients,
    allowedHarnesses: nextHarnesses,
    changed,
    requiresServiceRestart: false,
  };
}

export function disableAntigravity(options, configPath, io = undefined) {
  const resolvedIo = resolveIo(io);
  return withAntigravityLocks(configPath, resolvedIo, (config) => {
    const entry = selectAntigravityEntry(antigravityBindings(config), options.alias);
    const { file, ...binding } = entry;
    let policyCleanupRequired = false;
    let policyCleanupError = null;
    if (binding.enabled || !binding.revoked) {
      // Fence the pairing credential first so disable always succeeds even if workspace cleanup fails.
      resolvedIo.writeJson(file, {
        ...binding,
        enabled: false,
        revoked: true,
        generation: binding.generation + 1,
        secret: randomBytes(32).toString("hex"),
      });
      if (config.sessionMessaging?.enabled) {
        try {
          const policyUpdate = planWorkspaceSessionPolicy({
            config,
            senderId: binding.senderId,
            allowedSenders: [],
            allowedHarnesses: [],
            removedSessions: binding.allowedRecipients.filter((id) => id.startsWith("session-")),
          });
          if (policyUpdate) resolvedIo.writeJson(policyUpdate.path, policyUpdate.value);
        } catch (error) {
          policyCleanupRequired = true;
          policyCleanupError = typeof error?.code === "string" ? error.code : "policy_cleanup_failed";
        }
      }
    }
    return {
      alias: binding.alias,
      senderId: binding.senderId,
      disabled: true,
      ...(policyCleanupRequired ? { policyCleanupRequired: true, policyCleanupError } : {}),
      activeClaims: "preserved; no automatic retry or reassignment",
    };
  });
}

export function createAntigravityBroker({ config, issue, getSessionBroker = () => null }) {
  const entries = antigravityBindings(config);
  const byId = new Map(entries.map((b) => [b.senderId, b]));
  const byBindingId = new Map(entries.map((b) => [b.bindingId, b]));

  function current(id) {
    const entry = byId.get(id);
    if (!entry) throw coded("unknown_antigravity_identity", "Unknown Antigravity participant");
    const b = readAntigravityBinding(entry.file);
    if (
      b.senderId !== id ||
      b.alias !== entry.alias ||
      b.bindingId !== entry.bindingId ||
      b.secret !== entry.secret ||
      b.sessionId !== entry.sessionId ||
      b.generation !== entry.generation
    ) {
      throw coded("binding_changed", "Pairing changed; restart required");
    }
    if (!config.antigravity?.enabled || !b.enabled || b.revoked) {
      throw coded("session_disabled", "Antigravity pairing disabled");
    }
    return b;
  }

  async function resolveExchangeRecipients(b) {
    const sessionBroker = getSessionBroker();
    if (!sessionBroker || (!b.allowedHarnesses.length && !b.allowedRecipients.some((id) => id.startsWith("session-")))) {
      return [...b.allowedRecipients];
    }
    const sessionRows = await sessionBroker.listFor(b.senderId);
    const sessionIds = sessionRows
      .filter(
        (row) =>
          row.capabilities?.reachable === true &&
          (b.allowedRecipients.includes(row.id) || b.allowedHarnesses.includes(harnessOfRow(row)))
      )
      .map((row) => row.id);
    return [...new Set([...b.allowedRecipients, ...sessionIds])];
  }

  const brokers = new Map(
    entries.map((b) => [
      b.senderId,
      createInteractiveSessionBroker({
        integrationPath: b.file,
        readIntegration: readAntigravityBinding,
        recipients: b.allowedRecipients,
        resolveRecipients: (live) => resolveExchangeRecipients(live),
        issue,
      }),
    ])
  );

  return {
    ids: entries.map((b) => b.senderId),
    has: (id) => byId.has(id),
    hasBinding: (bindingId) => byBindingId.has(bindingId),
    directory: entries.map((b) => ({
      id: b.senderId,
      label: `Antigravity · ${b.alias}`,
      kind: "conversation",
      harness: "antigravity",
      presence: "unknown",
      capabilities: { queueable: true, wakeCapable: false, pullInbox: true },
    })),
    allowsHarness(sender, harness) {
      const live = current(sender);
      return live.allowedHarnesses.includes(harness);
    },
    async allowedRecipients(id, sessionBroker) {
      const live = current(id);
      if (!sessionBroker || !live.allowedHarnesses.length) {
        return [...live.allowedRecipients];
      }
      const rows = await sessionBroker.listFor(id);
      const harnessIds = rows
        .filter((row) => live.allowedHarnesses.includes(harnessOfRow(row)))
        .map((row) => row.id);
      return [...new Set([...live.allowedRecipients, ...harnessIds])];
    },
    mayListSession(sender, row) {
      const live = current(sender);
      if (live.allowedRecipients.includes(row.id)) return true;
      if (typeof row.id === "string" && row.id.startsWith("session-")) {
        return live.allowedHarnesses.includes(harnessOfRow(row));
      }
      return false;
    },
    async checkAllowed(sender, to, sessionBroker = null) {
      if (byId.has(sender)) {
        const live = current(sender);
        if (!live.allowedRecipients.includes(to)) {
          if (typeof to === "string" && to.startsWith("session-") && live.allowedHarnesses.length > 0) {
            const harness = await sessionBroker?.sessionHarness?.(to);
            if (!harness || !live.allowedHarnesses.includes(harness)) {
              throw coded("recipient_not_allowed", "Antigravity outgoing grant denies session recipient");
            }
          } else {
            throw coded("recipient_not_allowed", "Antigravity outgoing grant denies recipient");
          }
        }
      }
      if (byId.has(to)) {
        const live = current(to);
        if (!live.allowedSenders.includes(sender)) {
          throw coded("recipient_not_allowed", "Antigravity incoming grant denies sender");
        }
      }
    },
    async validateRequest(args) {
      current(args.senderId);
      return brokers.get(args.senderId).validateRequest(args);
    },
    async exchange(request) {
      const b = byBindingId.get(request?.bindingId);
      if (!b) throw coded("unauthorized", "Invalid Antigravity pairing");
      current(b.senderId);
      return brokers.get(b.senderId).exchange(request);
    },
  };
}

export async function runAntigravityMcp(options, { configPath, input = process.stdin, output = process.stdout }) {
  const config = readPrivateJson(configPath);
  if (config.version !== 1 || config.enabled !== true || config.antigravity?.enabled !== true) {
    throw coded("local_disabled", "Antigravity local messaging is disabled");
  }
  const binding = selectAntigravityEntry(antigravityBindings(config), options.alias);
  if (!binding.enabled || binding.revoked) {
    throw coded("session_disabled", "Antigravity pairing is disabled");
  }
  const { socketPath } = resolveLocalSocketAddress({ stateRoot: config.stateRoot });
  const client = createLocalControlClient({ socketPath, senderId: binding.senderId });
  const turnCredentialProvider = async () => {
    const current = readAntigravityBinding(binding.file);
    if (!current.enabled || current.revoked) {
      throw coded("session_disabled", "Antigravity pairing is disabled");
    }
    if (
      current.senderId !== binding.senderId ||
      current.bindingId !== binding.bindingId ||
      current.sessionId !== binding.sessionId ||
      current.generation !== binding.generation
    ) {
      throw coded("binding_changed", "Antigravity pairing changed");
    }
    const grant = await client.exchangeInteractiveSession({
      bindingId: current.bindingId,
      sessionId: current.sessionId,
      generation: current.generation,
      secret: current.secret,
    });
    if (
      grant.senderId !== binding.senderId ||
      grant.bindingId !== current.bindingId ||
      grant.sessionId !== current.sessionId ||
      grant.generation !== current.generation
    ) {
      throw coded("binding_changed", "Server returned a different Antigravity binding");
    }
    return grant.credential;
  };
  try {
    await runMcpStdioSession({
      input,
      output,
      handler: createLocalMessagingMcpHandler({ client, turnCredentialProvider }),
    });
    return 0;
  } finally {
    await client.close();
  }
}
