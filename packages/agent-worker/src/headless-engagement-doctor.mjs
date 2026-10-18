/**
 * Read-only headless engagement doctor: progress, not presence.
 * Redacts message bodies and credentials. Never deletes open transactions.
 *
 * The complete profile inventory (installation registry reconciled with the
 * Codex, Cursor ACP, and worker bindings) comes from
 * `installation-inventory.mjs`; the Codex v2 binding alone is never treated as
 * the full inventory, and a missing binding/diagnostic is never healthy.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  isAdvisoryLockHeld,
  isPidAlive,
  readClaimerDiagnostics,
} from "./claimer-advisory-lock.mjs";
import { readInstallationInventory, stripSecretKeys, UNAVAILABLE } from "./installation-inventory.mjs";

const HARD_BLOCKER_CODES = new Set([
  "no_ready_generation",
  "binding_mismatch",
  "dual_claimer_conflict",
  "unreadable_custody",
  "runtime_auth_missing",
  "open_transaction_stuck",
  "open_transaction_stalled",
]);

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    return { __error: error?.code ?? "unreadable", path: filePath };
  }
}

function ageMs(isoOrMs, now) {
  if (typeof isoOrMs === "number" && Number.isFinite(isoOrMs)) {
    return Math.max(0, now - isoOrMs);
  }
  if (typeof isoOrMs === "string" && isoOrMs.length > 0) {
    const ms = Date.parse(isoOrMs);
    if (Number.isFinite(ms)) return Math.max(0, now - ms);
  }
  return null;
}

function inspectClaimer(lockPath, { pidAlive = isPidAlive, advisoryHeldAt = isAdvisoryLockHeld } = {}) {
  if (!existsSync(lockPath)) {
    return Object.freeze({ path: lockPath, present: false, advisoryHeld: false });
  }
  let advisoryHeld = false;
  try {
    advisoryHeld = advisoryHeldAt(lockPath);
  } catch {
    advisoryHeld = false;
  }
  const diagnostics = readClaimerDiagnostics(lockPath);
  return Object.freeze({
    path: lockPath,
    present: true,
    advisoryHeld,
    owner: diagnostics?.owner ?? null,
    family: diagnostics?.family ?? null,
    pid: diagnostics?.pid ?? null,
    pidAlive: diagnostics?.pid != null ? pidAlive(diagnostics.pid) : null,
    acquiredAt: diagnostics?.acquiredAt ?? null,
    generation: diagnostics?.generation ?? null,
  });
}

/**
 * @returns {{ ok: boolean, exitCode: number, report: object }}
 */
export function runHeadlessEngagementDoctor({
  clientRoot,
  now = Date.now(),
  pidAlive = isPidAlive,
  advisoryHeldAt = isAdvisoryLockHeld,
  maxBacklogAgeMs = 15 * 60_000,
  maxOpenTxnAgeMs = 15 * 60_000,
} = {}) {
  if (typeof clientRoot !== "string" || !clientRoot.startsWith("/")) {
    throw new TypeError("clientRoot must be an absolute path");
  }

  const blockers = [];
  const warnings = [];
  const readyPath = path.join(clientRoot, "ready.json");
  const activationPath = path.join(clientRoot, "activate.json");
  const bindingPath = path.join(clientRoot, "headless-runtime-binding.json");
  const progressPath = path.join(clientRoot, "headless-progress.json");

  const ready = existsSync(readyPath) ? readJson(readyPath) : null;
  const activation = existsSync(activationPath) ? readJson(activationPath) : null;
  const binding = existsSync(bindingPath) ? readJson(bindingPath) : null;
  const progress = existsSync(progressPath) ? readJson(progressPath) : null;

  if (ready == null || ready.__error || typeof ready.generation !== "string" || ready.generation.length === 0) {
    blockers.push({ code: "no_ready_generation", message: "supervisor ready generation is missing" });
  }

  const profiles = [];
  if (binding != null && !binding.__error && binding.version === 2 && Array.isArray(binding.profiles)) {
    for (const entry of binding.profiles) {
      if (!entry || typeof entry.profile !== "string") continue;
      const profile = entry.profile;
      const claimer = inspectClaimer(path.join(clientRoot, `headless-claimer.${profile}.json`), {
        pidAlive,
        advisoryHeldAt,
      });
      const cursorClaimer = inspectClaimer(
        path.join(clientRoot, `cursor-acp-claimer.${profile}.json`),
        { pidAlive, advisoryHeldAt },
      );
      if (
        claimer.advisoryHeld
        && cursorClaimer.advisoryHeld
        && claimer.family != null
        && cursorClaimer.family != null
        && claimer.family !== cursorClaimer.family
      ) {
        blockers.push({
          code: "dual_claimer_conflict",
          message: `dual claimer families hold locks for ${profile}`,
          profile,
        });
      }

      let openTxn = null;
      if (typeof entry.instanceId === "string" && entry.instanceId.length === 64) {
        const modelStateRoot = path.resolve(clientRoot, "..", "model-state", "instances", entry.instanceId, "mailbox-transactions", "open.json");
        if (existsSync(modelStateRoot)) {
          const raw = readJson(modelStateRoot);
          if (!raw.__error) {
            openTxn = Object.freeze({
              path: modelStateRoot,
              state: raw.state ?? null,
              deliveryId: raw.deliveryId ?? null,
              protocol: raw.protocol ?? null,
              lastFailureReason: raw.lastFailureReason ?? null,
              failureCount: raw.failureCount ?? null,
            });
          } else {
            blockers.push({
              code: "unreadable_custody",
              message: `open transaction unreadable for ${profile}`,
              profile,
            });
          }
        }
      }

      const profileProgress = progress?.profiles?.[profile] ?? progress?.[profile] ?? null;
      const lastKickAt = profileProgress?.lastAcceptedKickAt ?? progress?.lastAcceptedKickAt ?? null;
      const lastClaimAt = profileProgress?.lastClaimAt ?? null;
      const lastReplyAt = profileProgress?.lastReplyAt ?? null;
      const lastAckAt = profileProgress?.lastAckAt ?? null;
      const pendingCount = Number.isSafeInteger(profileProgress?.pendingCount)
        ? profileProgress.pendingCount
        : null;
      const oldestPendingAt = profileProgress?.oldestPendingAt ?? null;
      const oldestPendingAgeMs = ageMs(oldestPendingAt, now);

      if (lastKickAt != null && lastClaimAt != null) {
        const kickMs = Date.parse(lastKickAt);
        const claimMs = Date.parse(lastClaimAt);
        if (Number.isFinite(kickMs) && Number.isFinite(claimMs) && kickMs > claimMs + 60_000) {
          warnings.push({
            code: "kick_ok_drain_stale",
            message: `admit-only kick newer than claim/reply/ack for ${profile}`,
            profile,
          });
        }
      }
      if (oldestPendingAgeMs != null && oldestPendingAgeMs > maxBacklogAgeMs) {
        warnings.push({
          code: "backlog_age",
          message: `pending backlog age elevated for ${profile}`,
          profile,
          oldestPendingAgeMs,
        });
      }
      if (openTxn?.state != null) {
        const openAge = ageMs(profileProgress?.openTxnUpdatedAt ?? null, now);
        if (openAge != null && openAge > maxOpenTxnAgeMs) {
          warnings.push({
            code: "open_txn_age",
            message: `open transaction long-running for ${profile}`,
            profile,
            openAgeMs: openAge,
          });
        }
      }

      profiles.push(Object.freeze({
        profile,
        instanceId: entry.instanceId ?? null,
        stateRoot: entry.stateRoot ?? null,
        claimer,
        cursorAcpClaimer: cursorClaimer,
        openTransaction: openTxn,
        progress: Object.freeze({
          lastAcceptedKickAt: lastKickAt,
          lastClaimAt,
          lastReplyAt,
          lastAckAt,
          pendingCount,
          oldestPendingAt,
          oldestPendingAgeMs,
        }),
      }));
    }
  } else if (binding != null && binding.__error) {
    blockers.push({ code: "binding_mismatch", message: "headless-runtime-binding.json unreadable" });
  } else if (binding == null) {
    // Absence is judged per registered profile by the inventory below
    // (binding_missing for an enabled Codex headless profile).
  } else if (binding.version !== 2) {
    blockers.push({ code: "binding_mismatch", message: "headless binding is not v2" });
  }

  if (binding?.common) {
    for (const key of ["codexHome", "command", "workingDirectory"]) {
      const value = binding.common[key];
      if (typeof value !== "string" || !value.startsWith("/") || !existsSync(value)) {
        blockers.push({
          code: "runtime_auth_missing",
          message: `binding common ${key} missing or unreadable`,
        });
      }
    }
  }

  const inventory = readInstallationInventory({
    clientRoot,
    now,
    pidAlive,
    advisoryHeldAt,
    progress: progress != null && !progress.__error ? progress : null,
    // Same threshold the Codex-binding loop uses, applied to every lane.
    maxOpenTxnAgeMs,
  });
  const seen = new Set([...blockers, ...warnings].map((row) => `${row.code}:${row.profile ?? ""}`));
  for (const row of inventory.blockers) {
    const key = `${row.code}:${row.profile ?? ""}`;
    if (!seen.has(key)) { seen.add(key); blockers.push(row); }
  }
  for (const row of inventory.warnings) {
    const key = `${row.code}:${row.profile ?? ""}`;
    if (!seen.has(key)) { seen.add(key); warnings.push(row); }
  }

  const report = Object.freeze({
    version: 2,
    generatedAt: new Date(now).toISOString(),
    supervisor: Object.freeze({
      readyGeneration: ready?.generation ?? null,
      readyAtMilliseconds: ready?.readyAtMilliseconds ?? null,
      activationGeneration: activation?.generation ?? null,
      parentPid: ready?.parentPid ?? null,
    }),
    watch: Object.freeze({
      connection: progress?.watch?.connection ?? null,
      grantHealth: progress?.watch?.grantHealth ?? null,
    }),
    binding: Object.freeze({
      path: bindingPath,
      version: binding?.version ?? null,
      profileCount: Array.isArray(binding?.profiles) ? binding.profiles.length : 0,
    }),
    profiles: Object.freeze(profiles),
    inventory: stripSecretKeys({
      registry: inventory.registry,
      installationIdentity: inventory.installationIdentity,
      bindings: inventory.bindings,
      profiles: inventory.profiles,
      orphanBindings: inventory.orphanBindings,
      enrolledUnregistered: inventory.enrolledUnregistered,
    }),
    blockers: Object.freeze(blockers),
    warnings: Object.freeze(warnings),
  });

  // Every blocker is hard: inventory faults (missing binding, unverified
  // enrollment, invalid registry) must never yield a healthy exit.
  const hard = blockers.length > 0 || blockers.some((row) => HARD_BLOCKER_CODES.has(row.code));
  const degraded = warnings.some((row) => row.code === "kick_ok_drain_stale");
  const exitCode = hard ? 2 : degraded || warnings.length > 0 ? 1 : 0;
  return Object.freeze({
    // Healthy only when nothing is missing, faulted, or unaccounted for.
    ok: exitCode === 0,
    exitCode,
    report,
  });
}

export function formatDoctorReport(report) {
  const lines = [];
  lines.push(`headless engagement doctor @ ${report.generatedAt}`);
  lines.push(
    `supervisor generation=${report.supervisor.readyGeneration ?? "missing"} activation=${report.supervisor.activationGeneration ?? "n/a"}`,
  );
  lines.push(
    `watch connection=${report.watch.connection ?? "unknown"} grant=${report.watch.grantHealth ?? "unknown"}`,
  );
  lines.push(`binding v${report.binding.version ?? "?"} profiles=${report.binding.profileCount}`);
  const inv = report.inventory;
  if (inv) {
    lines.push(
      `registry ${inv.registry.status} profiles=${inv.registry.count} bindings codex=${inv.bindings.codexHeadless.status}[${inv.bindings.codexHeadless.profiles.join(",")}] cursor-acp=${inv.bindings.cursorAcp.status}[${inv.bindings.cursorAcp.profiles.join(",")}]`,
    );
    for (const row of inv.profiles) lines.push(...formatInventoryProfile(row));
    for (const row of inv.orphanBindings) lines.push(`orphan binding ${row.kind}:${row.profile} (not in registry)`);
    if (inv.enrolledUnregistered.length > 0) {
      lines.push(`enrolled but not registered (not started): ${inv.enrolledUnregistered.join(", ")}`);
    }
  }
  for (const profile of report.profiles) {
    const p = profile.progress;
    lines.push(
      `codex-binding ${profile.profile}: kick=${p.lastAcceptedKickAt ?? "-"} claim=${p.lastClaimAt ?? "-"} reply=${p.lastReplyAt ?? "-"} ack=${p.lastAckAt ?? "-"} pending=${p.pendingCount ?? "-"} open=${profile.openTransaction?.state ?? "none"} claimerHeld=${profile.claimer.advisoryHeld}`,
    );
  }
  for (const row of report.blockers) {
    lines.push(`BLOCKER ${row.code}: ${row.message}`);
  }
  for (const row of report.warnings) {
    lines.push(`WARN ${row.code}: ${row.message}`);
  }
  if (report.blockers.length === 0 && report.warnings.length === 0 && (inv?.profiles?.length ?? 0) > 0) {
    lines.push("ok");
  }
  return `${lines.join("\n")}\n`;
}

function show(value) {
  if (value == null) return "-";
  return String(value);
}

function formatInventoryProfile(row) {
  if (row.registry?.valid === false) {
    return [`profile ${row.profile} [fault] registry entry invalid: ${row.registry.problems.join(",")}`];
  }
  const claimer = row.owner.claimers.find((c) => c.advisoryHeld === true) ?? row.owner.claimers[0] ?? null;
  const owner = claimer
    ? `${claimer.lock} held=${claimer.advisoryHeld} owner=${show(claimer.owner)} family=${show(claimer.family)} pid=${show(claimer.pid)} gen=${show(claimer.generation)}`
    : UNAVAILABLE;
  const ho = row.owner.headlessOwnership;
  const ownership = ho && typeof ho === "object"
    ? ` ownership=${show(ho.ownershipState)} ownerGeneration=${show(ho.ownerGeneration)} leaseExpired=${show(ho.leaseExpired)}`
    : "";
  const a = row.activity;
  const open = row.journal.openTransaction;
  return [
    `profile ${row.profile} [${row.status}] runtime=${row.runtimeAdapter} delivery=${row.deliveryMode} enabled=${row.enabled} lane=${row.lane} support=${row.support}`,
    `  enrollment=${show(row.enrollment.state)} agent=${show(row.enrollment.agentId)} credential=${row.credential} capabilities=${row.capabilities}`,
    `  binding=${row.binding.kind}:${row.binding.status} pollWatch=${row.pollWatch.mode} pollMs=${show(row.pollWatch.pollIntervalMs)} watchMember=${row.pollWatch.watchMember} watch=${show(row.pollWatch.watchConnection)} grant=${show(row.pollWatch.grantHealth)}`,
    `  owner: ${owner}${ownership} admission=${row.owner.supervisorAdmission}`,
    `  activity: claim=${show(a.lastClaimAt)} reply=${show(a.lastReplyAt)}${a.lastReplySource ? `(${a.lastReplySource})` : ""} ack=${show(a.lastAckAt)} conversationUpdate=${show(a.lastConversationUpdateAt)} pending=${show(a.pendingCount)} oldestPendingAgeMs=${show(a.oldestPendingAgeMs)} retryExpiry=${a.retryExpiry}`,
    `  backlog: open=${open ? show(open.state) : "none"} openAgeMs=${show(a.openTransactionAgeMs)} openFailures=${show(a.openTransactionFailureCount)} openHealth=${show(a.openTransactionHealth)} quarantined=${row.journal.quarantinedCount}${row.faults.length ? ` faults=${row.faults.join(",")}` : ""}${row.notes.length ? ` notes=${row.notes.join(",")}` : ""}`,
  ];
}
