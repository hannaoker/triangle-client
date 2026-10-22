import { createInstalledLocalMessagingHost } from "./local-messaging-host.mjs";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { createCommandRunner, createRunnerEnvironment } from "./command-runner.mjs";
import { createProfiledReasonerGate } from "./concurrency-gate.mjs";
import {
  createHelperWatchTransport,
  createInstallationWatchTransportFactory,
  ensureHelperWatchGrant,
} from "./helper-watch-transport.mjs";
import {
  INSTALL_WATCH_SAFE_IDLE_POLL_MS,
  createInstallWatchDispatcher,
  resolveInstallWatchCursorPath,
} from "./install-watch-dispatcher.mjs";
import { createMailboxClient, validateMailboxClientOptions } from "./mailbox-client.mjs";
import { createMailboxHarness, createWakeRuntime } from "./profile-scheduler.mjs";
import { createAgentWorker } from "./runtime.mjs";
import {
  createAppServerWakeBridge,
  createAtomicFileBindingStore,
  createAtomicFileCursorStore,
  createAuthenticatedAppServerTransport,
  createCapabilityTokenAuthResolver,
  createProductionAppServerDeliveryResolver,
  createSharedCodexSession,
  createTrustedTransactionProxy,
  validateBinding,
} from "./shared-codex-app-server.mjs";
import {
  CLIENT_SUPERVISOR_CLAIMER_OWNER,
  HEADLESS_WAKE_KEYS as EXACT_HEADLESS_WAKE_KEYS,
  createHeadlessClaimerGuard,
  createInstalledHeadlessDrain,
  normalizeHeadlessWakeConfig,
} from "./codex-runtime/headless-drain-service.mjs";
import {
  CLIENT_SUPERVISOR_CLAIMER_OWNER as CURSOR_ACP_CLIENT_SUPERVISOR_CLAIMER_OWNER,
  createCursorAcpClaimerGuard,
  createInstalledCursorAcpDrain,
  normalizeCursorAcpWakeConfig,
} from "./cursor-acp-runtime/headless-drain-service.mjs";


import {
  APP_SERVER_BINDING_KEYS,
  APP_SERVER_WAKE_KEYS,
  GROK_BOT_BINDING_KEYS,
  GROK_BOT_WAKE_KEYS,
  HEADLESS_WAKE_KEYS,
  INSTALLATION_ID,
  INSTANCE_ID,
  LEGACY_HEADLESS_WAKE_UNSET,
  PEER_WAKE_KEYS,
  hasExactKeys,
  isRenewableWatchCredentialError,
  positiveInteger,
  validateAppServerWake,
  validateCursorAcpWakes,
  validateDrain,
  validateEventWake,
  validateHeadlessWakes,
  validatePeerWakes,
  validateRunner,
} from "./client-supervisor-schema.mjs";

export {
  APP_SERVER_BINDING_KEYS,
  APP_SERVER_WAKE_KEYS,
  GROK_BOT_BINDING_KEYS,
  GROK_BOT_WAKE_KEYS,
  HEADLESS_WAKE_KEYS,
  PEER_WAKE_KEYS,
} from "./client-supervisor-schema.mjs";

/**
 * Installation-scoped watch-grant renewal (reactive + proactive).
 *
 * Kept inside client-supervisor.mjs on purpose: worker bundles are validated by
 * the signed helper against an exact artifact set, so a new module would need a
 * manifest version bump and a helper rebuild before the supervisor could load.
 *
 * MESH fixes a watch grant's `expires_at` at create time (TTL capped at 3600 s;
 * finalize does not extend it). Before L1e the supervisor only renewed after a
 * poll was rejected with `watch_credential_invalid`, so every grant lifetime
 * ended in one logged failure plus a stop / renew / backoff / restart cycle.
 *
 * Helpers that know the expiry return it from `watch-ensure` as `expiresAt`.
 * This registry then schedules ONE proactive renewal per installation at
 * PROACTIVE_RENEWAL_FRACTION of the observed lifetime. All renewals (proactive
 * timer and rejection-driven) go through the same generation / in-flight
 * coalescing, so concurrent triggers share a single `watch-ensure`. When the
 * expiry is unknown (older helper, or the reused-existing probe path) nothing is
 * scheduled and the reactive path is the only renewal, exactly as before.
 */

export const PROACTIVE_RENEWAL_FRACTION = 0.85;
/** Lifetimes shorter than this are not worth a timer; reactive renewal handles them. */
export const PROACTIVE_MIN_LIFETIME_MS = 10_000;
/** After a failed proactive attempt, retry no sooner than this. */
export const PROACTIVE_RETRY_MIN_MS = 15_000;
/** Never schedule a retry closer to expiry than this; let the reactive path take over. */
export const PROACTIVE_RETRY_EXPIRY_MARGIN_MS = 5_000;
/** Cap a single wait so long sleeps stay below Node's 2^31 ms timer limit and re-check the clock. */
export const PROACTIVE_MAX_WAIT_MS = 60 * 60_000;
/** Expiries further out than this are treated as unknown (clock skew / bad data). */
export const MAX_TRUSTED_GRANT_LIFETIME_MS = 7 * 24 * 60 * 60_000;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Parse a helper-reported ISO 8601 UTC expiry into epoch ms, or null when untrusted. */
export function parseGrantExpiry(value, nowMs) {
  if (typeof value !== "string" || value.length > 40 || !ISO_UTC.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (ms <= nowMs || ms - nowMs > MAX_TRUSTED_GRANT_LIFETIME_MS) return null;
  return ms;
}

function isAbort(error) {
  return error?.name === "AbortError";
}

async function defaultSleep(ms, { signal } = {}) {
  await new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}

export function createWatchGrantRenewalRegistry({
  ensureWatchGrant,
  now = () => Date.now(),
  logger = null,
} = {}) {
  if (typeof ensureWatchGrant !== "function") throw new TypeError("ensureWatchGrant is required");
  const states = new Map();

  function state(installationId) {
    let entry = states.get(installationId);
    if (!entry) {
      entry = {
        generation: 0,
        inFlight: null,
        // Expiry bookkeeping. `expiryVersion` changes whenever a new grant is
        // observed so a pending proactive timer for an older grant is discarded.
        expiresAtMs: null,
        renewAtMs: null,
        expiryVersion: 0,
        listeners: new Set(),
        proactiveOwner: null,
      };
      states.set(installationId, entry);
    }
    return entry;
  }

  function notify(entry) {
    for (const listener of [...entry.listeners]) {
      try { listener(); } catch { /* ignore */ }
    }
  }

  /** Record the outcome of a successful `watch-ensure` (initial or renewal). */
  function recordEnsure(installationId, result) {
    const entry = state(installationId);
    const recordedAt = now();
    const expiresAtMs = parseGrantExpiry(result?.expiresAt, recordedAt);
    entry.expiryVersion += 1;
    if (expiresAtMs == null || expiresAtMs - recordedAt < PROACTIVE_MIN_LIFETIME_MS) {
      entry.expiresAtMs = expiresAtMs;
      entry.renewAtMs = null;
    } else {
      entry.expiresAtMs = expiresAtMs;
      entry.renewAtMs = recordedAt + Math.floor((expiresAtMs - recordedAt) * PROACTIVE_RENEWAL_FRACTION);
    }
    notify(entry);
    return entry.expiresAtMs;
  }

  /**
   * Renew through the shared generation / in-flight gate. A caller that observed
   * an older generation reuses the renewal that already happened; concurrent
   * callers on the same generation join one in-flight `watch-ensure`.
   */
  function renew({ helperPath, installationId, actorProfile, signal }, observedGeneration, { trigger = "rejection" } = {}) {
    const entry = state(installationId);
    if (entry.generation !== observedGeneration) {
      return Promise.resolve({ renewed: false, reusedRenewal: true, trigger });
    }
    if (!entry.inFlight) {
      entry.inFlight = Promise.resolve().then(async () => {
        const result = await ensureWatchGrant({ helperPath, installationId, actorProfile, signal });
        entry.generation += 1;
        recordEnsure(installationId, result);
        return { renewed: true, trigger };
      }).finally(() => {
        entry.inFlight = null;
      });
    }
    return entry.inFlight;
  }

  /**
   * One proactive scheduler per installation per supervisor watch(). Resolves
   * when `signal` aborts. A second caller for the same installation is a no-op.
   */
  async function runProactive({ renewal, signal, sleep = defaultSleep }) {
    if (!renewal || typeof renewal.installationId !== "string") return;
    const entry = state(renewal.installationId);
    if (entry.proactiveOwner) return;
    const owner = Symbol("proactive-renewal");
    entry.proactiveOwner = owner;
    let stalls = 0;
    try {
      while (!signal?.aborted) {
        const version = entry.expiryVersion;
        if (entry.renewAtMs == null || stalls >= 3) {
          await waitForChange(entry, version, signal);
          stalls = 0;
          continue;
        }
        const before = now();
        const delay = entry.renewAtMs - before;
        if (delay > 0) {
          await waitOrChange(entry, version, Math.min(delay, PROACTIVE_MAX_WAIT_MS), signal, sleep);
          if (signal?.aborted) return;
          if (entry.expiryVersion !== version) {
            stalls = 0;
            continue;
          }
          if (now() < entry.renewAtMs) {
            // Clock did not reach the target (long wait chunk, or an injected
            // sleep that returns early). Guard against a hot loop.
            stalls = now() === before ? stalls + 1 : 0;
            continue;
          }
        }
        stalls = 0;
        try {
          await renew({ ...renewal, signal }, entry.generation, { trigger: "proactive" });
        } catch (error) {
          if (signal?.aborted || isAbort(error)) return;
          logger?.error?.("triangle_client_watch_grant_proactive_renewal_failed", {
            error: "Proactive watch grant renewal failed",
            code: error?.code,
            status: error?.status ?? error?.httpStatus,
            rejectedCode: typeof error?.rejectedCode === "string" ? error.rejectedCode : undefined,
            failureCode: typeof error?.failureCode === "string" ? error.failureCode : undefined,
          });
          if (entry.expiryVersion === version && entry.expiresAtMs != null) {
            const t = now();
            const retryAt = t + Math.max(PROACTIVE_RETRY_MIN_MS, Math.floor((entry.expiresAtMs - t) / 2));
            entry.renewAtMs = retryAt < entry.expiresAtMs - PROACTIVE_RETRY_EXPIRY_MARGIN_MS ? retryAt : null;
          }
        }
      }
    } finally {
      if (entry.proactiveOwner === owner) entry.proactiveOwner = null;
    }
  }

  function waitForChange(entry, version, signal) {
    if (signal?.aborted || entry.expiryVersion !== version) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        entry.listeners.delete(done);
        signal?.removeEventListener?.("abort", done);
        resolve();
      };
      entry.listeners.add(done);
      signal?.addEventListener?.("abort", done, { once: true });
    });
  }

  async function waitOrChange(entry, version, ms, signal, sleep) {
    if (entry.expiryVersion !== version) return;
    const wake = new AbortController();
    const onChange = () => wake.abort();
    const onAbort = () => wake.abort();
    entry.listeners.add(onChange);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      await sleep(ms, { signal: wake.signal });
    } catch (error) {
      if (!isAbort(error) && !wake.signal.aborted) throw error;
    } finally {
      entry.listeners.delete(onChange);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  return Object.freeze({ state, recordEnsure, renew, runProactive });
}

/**
 * Drain progress evidence journal (`client/headless-progress.json`).
 *
 * The doctor / installation inventory (PR #82) reports a profile `degraded`
 * with `progress_evidence_unavailable` unless it can find claim/reply/ack
 * evidence for it. Codex headless profiles get that from their per-stateRoot
 * completion journal; the Cursor ACP and worker (antigravity, hermes, …) drains
 * have no such journal, so they record it here instead. The reader contract is
 * `progress.profiles[<profile>].{lastClaimAt,lastReplyAt,lastAckAt}` (ISO 8601).
 *
 * Kept inside client-supervisor.mjs on purpose (same reason as the watch-grant
 * registry above): a new module would change the signed worker bundle artifact
 * set and need a manifest bump plus helper rebuild before it could load.
 *
 * Contract:
 * - Evidence only. Timestamps + lane per profile; never message bodies, room or
 *   delivery ids, or credentials.
 * - Atomic: write tmp (0600) + fsync + rename over the target. Readers never see
 *   a torn file.
 * - Serialized: every read-modify-write runs under a kernel advisory lock
 *   (Darwin O_EXLOCK) on the permanent sidecar `headless-progress.json.lock`,
 *   held on an open fd until the rename commits. If the lock cannot be taken
 *   within `lockWaitMs` the write is skipped (no unlocked read-modify-write)
 *   and `record()` returns false with the sanitized code
 *   `progress_journal_lock_unavailable`. The kernel releases the lock when its
 *   owner exits, so there is no stale-lock takeover to race: a successful
 *   write (true) is never erased by another writer's stale snapshot. Other
 *   platforms fail closed (`progress_journal_lock_unsupported_platform`).
 * - Monotonic per field: an older stamp never overwrites a newer one.
 * - Best-effort: recording never throws into the drain; failures are logged
 *   with a sanitized code only.
 */
export const HEADLESS_PROGRESS_FILE = "headless-progress.json";
export const HEADLESS_PROGRESS_VERSION = 1;
export const HEADLESS_PROGRESS_FIELDS = Object.freeze({
  claim: "lastClaimAt",
  reply: "lastReplyAt",
  ack: "lastAckAt",
});
// Swift `CharacterSet.controlCharacters` is Unicode general categories Cc + Cf.
const PROGRESS_PROFILE_CONTROL = /[\p{Cc}\p{Cf}]/u;

/**
 * Persisted profile-name contract (Swift `ProfileName`): non-empty, at most 64
 * UTF-8 bytes, no "/" or "\\", no control/format characters. Kept identical to
 * `isValidProfileName` in installation-inventory.mjs (duplicated so the signed
 * worker bundle artifact set is unchanged).
 */
function isValidProgressProfileName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.isWellFormed()
    && Buffer.byteLength(value, "utf8") <= 64
    && !value.includes("/")
    && !value.includes("\\")
    && !PROGRESS_PROFILE_CONTROL.test(value);
}

// Darwin sys/fcntl.h. Duplicated from claimer-advisory-lock.mjs, which v5/v6
// worker bundles do not ship.
const PROGRESS_DARWIN_O_EXLOCK = 0x20;
const PROGRESS_DARWIN_O_NOFOLLOW = 0x100;
const PROGRESS_LANES = new Set(["cursor-acp", "worker", "event-driven", "codex-headless"]);
const PROGRESS_LOCK_WAIT_MS = 250;
const PROGRESS_MAX_BYTES = 1024 * 1024;

function progressSleepSync(milliseconds) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    // Atomics.wait unavailable: fall through and just retry.
  }
}

function deriveRegistryInstanceId(profile) {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from("triangle-client-instance-v1"), Buffer.from([0]), Buffer.from(profile)]))
    .digest("hex");
}

/** Default production client root: ~/Library/Application Support/The Triangle/client. */
export function defaultHeadlessProgressClientRoot(env = process.env) {
  const home = typeof env?.HOME === "string" && env.HOME.startsWith("/") && !env.HOME.includes("\0")
    ? env.HOME
    : null;
  if (home == null) return null;
  return path.join(home, "Library", "Application Support", "The Triangle", "client");
}

export function createHeadlessProgressJournal({
  clientRoot,
  now = () => Date.now(),
  logger = null,
  pid = process.pid,
  lockWaitMs = PROGRESS_LOCK_WAIT_MS,
  platform = process.platform,
} = {}) {
  if (typeof clientRoot !== "string" || !path.isAbsolute(clientRoot) || clientRoot.includes("\0")) {
    throw new TypeError("clientRoot must be an absolute path");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const filePath = path.join(clientRoot, HEADLESS_PROGRESS_FILE);
  const lockPath = `${filePath}.lock`;

  /**
   * Mutual exclusion is a kernel advisory lock (Darwin O_EXLOCK) held on an
   * open fd for the whole read-modify-write. The kernel drops it when the
   * owner closes the fd or dies, so there is no stale-lock takeover: a live
   * owner, however slow, can never be displaced, and a crashed owner never
   * blocks the next writer. The lock file itself is permanent and is never
   * unlinked (unlinking would let two writers lock different inodes).
   *
   * @returns {number|null} the locked fd, or null when not acquired in time.
   */
  function acquireLock() {
    if (platform !== "darwin") {
      throw Object.assign(new Error("progress journal lock requires macOS"), { code: "progress_journal_lock_unsupported_platform" });
    }
    const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NONBLOCK
      | PROGRESS_DARWIN_O_EXLOCK | PROGRESS_DARWIN_O_NOFOLLOW;
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      let fd;
      try {
        fd = openSync(lockPath, flags, 0o600);
      } catch (error) {
        if (error?.code !== "EAGAIN" && error?.code !== "EWOULDBLOCK") return null;
        if (Date.now() >= deadline) return null;
        progressSleepSync(5);
        continue;
      }
      try {
        if (fstatSync(fd).isFile()) return fd;
      } catch {}
      try { closeSync(fd); } catch {}
      return null;
    }
  }

  function releaseLock(fd) {
    try { closeSync(fd); } catch {}
  }

  function readDocument() {
    let raw;
    try {
      if (statSync(filePath).size > PROGRESS_MAX_BYTES) return null;
      raw = readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  function writeDocument(document) {
    const tmp = `${filePath}.${pid}.${randomBytes(6).toString("hex")}.tmp`;
    let fd = null;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeSync(fd, `${JSON.stringify(document, null, 2)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, filePath);
    } catch (error) {
      if (fd != null) {
        try { closeSync(fd); } catch {}
      }
      try { unlinkSync(tmp); } catch {}
      throw error;
    }
  }

  function laterIso(existing, candidate) {
    const existingMs = typeof existing === "string" ? Date.parse(existing) : Number.NaN;
    return Number.isFinite(existingMs) && existingMs > Date.parse(candidate) ? existing : candidate;
  }

  /** @returns {boolean} true when the evidence was durably written. */
  function record({ profile, lane, phase } = {}) {
    try {
      if (!isValidProgressProfileName(profile)) {
        throw Object.assign(new TypeError("profile is invalid"), { code: "progress_profile_invalid" });
      }
      if (!PROGRESS_LANES.has(lane)) {
        throw Object.assign(new TypeError("lane is invalid"), { code: "progress_lane_invalid" });
      }
      const field = HEADLESS_PROGRESS_FIELDS[phase];
      if (field == null || !Object.hasOwn(HEADLESS_PROGRESS_FIELDS, phase)) {
        throw Object.assign(new TypeError("phase is invalid"), { code: "progress_phase_invalid" });
      }
      const at = new Date(now()).toISOString();
      mkdirSync(clientRoot, { recursive: true, mode: 0o700 });
      const lockFd = acquireLock();
      if (lockFd == null) {
        // Never fall back to an unlocked read-modify-write: it could replace a
        // concurrent writer's successful update with a stale snapshot.
        throw Object.assign(new Error("progress journal lock unavailable"), { code: "progress_journal_lock_unavailable" });
      }
      try {
        const current = readDocument() ?? {};
        // Null-prototype map: every Swift ProfileName, including "__proto__",
        // is stored as an own JSON property.
        const profiles = Object.create(null);
        if (current.profiles && typeof current.profiles === "object" && !Array.isArray(current.profiles)) {
          for (const [name, row] of Object.entries(current.profiles)) profiles[name] = row;
        }
        const existing = Object.hasOwn(profiles, profile) ? profiles[profile] : null;
        const prior = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
        profiles[profile] = {
          ...prior,
          lane,
          [field]: laterIso(prior[field], at),
          updatedAt: laterIso(prior.updatedAt, at),
        };
        writeDocument({
          ...current,
          version: HEADLESS_PROGRESS_VERSION,
          updatedAt: laterIso(current.updatedAt, at),
          profiles,
        });
      } finally {
        releaseLock(lockFd);
      }
      return true;
    } catch (error) {
      try {
        logger?.error?.("triangle_client_progress_journal_write_failed", {
          code: typeof error?.code === "string" ? error.code : "progress_journal_write_failed",
        });
      } catch {}
      return false;
    }
  }

  function forProfile(profile, lane) {
    if (!isValidProgressProfileName(profile)) {
      throw new TypeError("profile is invalid");
    }
    if (!PROGRESS_LANES.has(lane)) throw new TypeError("lane is invalid");
    return Object.freeze({
      profile,
      lane,
      record(phase) {
        return record({ profile, lane, phase });
      },
    });
  }

  /**
   * Worker/eventWake bootstraps carry only the instance id. Resolve the profile
   * from the installation registry row (`client/instances/<id>.json`) and accept
   * it only when the id is the one derived from that profile.
   */
  function forInstance(instanceId, lane) {
    if (typeof instanceId !== "string" || !INSTANCE_ID.test(instanceId)) return null;
    try {
      const row = JSON.parse(readFileSync(path.join(clientRoot, "instances", `${instanceId}.json`), "utf8"));
      const profile = row?.profile;
      if (!isValidProgressProfileName(profile)) return null;
      if (deriveRegistryInstanceId(profile) !== instanceId) return null;
      return forProfile(profile, lane);
    } catch {
      return null;
    }
  }

  return Object.freeze({
    path: filePath,
    clientRoot,
    record,
    forProfile,
    forInstance,
    read: readDocument,
  });
}

export function createClientSupervisor({
  instances = [],
  eventWake = null,
  appServerWake = null,
  grokBotWake = null,
  headlessWakes = null,
  cursorAcpWakes = null,
  peerWakes = null,
  localMessaging = null,
  headlessWake = LEGACY_HEADLESS_WAKE_UNSET,
  createDeliveryClient = createMailboxClient,
  createRunner = createCommandRunner,
  createWorker = createAgentWorker,
  createWake = createWakeRuntime,
  createWatchTransport = createHelperWatchTransport,
  ensureWatchGrant = ensureHelperWatchGrant,
  createHarness = createMailboxHarness,
  createAppServerTransport = createAuthenticatedAppServerTransport,
  createAuthResolver = createCapabilityTokenAuthResolver,
  createBindingStore = createAtomicFileBindingStore,
  createCursorStore = createAtomicFileCursorStore,
  createSession = createSharedCodexSession,
  createWakeBridge = createAppServerWakeBridge,
  createHeadlessDrain = createInstalledHeadlessDrain,
  createClaimerGuard = createHeadlessClaimerGuard,
  createCursorAcpDrain = createInstalledCursorAcpDrain,
  createCursorAcpClaimer = createCursorAcpClaimerGuard,
  createInstallDispatcher = createInstallWatchDispatcher,
  createPeerLane = null,
  createLocalMessagingHost = createInstalledLocalMessagingHost,
  resolveDelivery,
  maxConcurrentReasoners = 2,
  pollIntervalMs = 15_000,
  maxIdlePollIntervalMs = 300_000,
  maxBackoffMs = 300_000,
  idleJitterRatio = 0.1,
  random = Math.random,
  logger = console,
  /** Clock for watch-grant expiry scheduling (tests inject a virtual clock). */
  now = () => Date.now(),
  /**
   * Optional drain progress evidence journal (createHeadlessProgressJournal).
   * When set, worker / eventWake mailbox clients and Cursor ACP drains record
   * claim/reply/ack timestamps to client/headless-progress.json. Null keeps the
   * supervisor free of progress writes (tests, embedded use).
   */
  progressJournal = null,
  /**
   * One install watch dispatcher for App Server, headless Codex, and enrolled
   * Cursor ACP. Kicks register only when agentId is on that wake bootstrap.
   */
  useInstallWatchDispatcher = null,
} = {}) {
  if (headlessWake !== LEGACY_HEADLESS_WAKE_UNSET) {
    throw new TypeError("headlessWake is not supported; use headlessWakes");
  }
  if (
    progressJournal != null
    && (typeof progressJournal.forProfile !== "function" || typeof progressJournal.forInstance !== "function")
  ) {
    throw new TypeError("progressJournal must provide forProfile and forInstance");
  }
  // Mailbox clients report { phase } after a won claim, a persisted reply, and
  // an owned ack. Only attach the hook when a journal resolves this instance.
  function deliveryClientContext(context, lane) {
    const recorder = progressJournal?.forInstance(context.instanceId, lane) ?? null;
    if (recorder == null) return context;
    return Object.freeze({
      ...context,
      onProgress: (event) => recorder.record(event?.phase),
    });
  }
  // Mini Bob / Grok webhook wake path is removed (not deferred). Callers must
  // use appServerWake / eventWake / headlessWakes instead.
  if (grokBotWake != null) {
    throw new TypeError("grokBotWake was removed; Mini Bob webhook wake path is retired");
  }
  if (!Array.isArray(instances) || instances.length > 100) {
    throw new TypeError("instances must contain between 0 and 100 entries");
  }
  const wakeConfig = validateEventWake(eventWake);
  const appServerConfig = validateAppServerWake(appServerWake);
  const headlessConfigs = validateHeadlessWakes(headlessWakes);
  const cursorAcpConfigs = validateCursorAcpWakes(cursorAcpWakes);
  const peerConfigs = validatePeerWakes(peerWakes);
  if (
    instances.length < 1
    && !wakeConfig
    && !appServerConfig
    && headlessConfigs.length === 0
    && cursorAcpConfigs.length === 0
    && peerConfigs.length === 0
  ) {
    throw new TypeError("instances must contain between 1 and 100 entries");
  }
  positiveInteger(maxConcurrentReasoners, "maxConcurrentReasoners");
  const gate = createProfiledReasonerGate({ limit: maxConcurrentReasoners });
  const localRunners = new Map();
  const seen = new Set();
  // One MESH held poll per installation: lanes that share an installationId
  // coalesce onto a single watch-poll.
  const sharedWatchTransport = createInstallationWatchTransportFactory(createWatchTransport);
  // A grant is installation-scoped too. Track its generation so listeners that
  // fail together on one expired credential join (or observe) one renewal, and
  // its MESH expiry so one proactive renewal per installation can run before
  // the credential dies (see watch-grant-renewal.mjs).
  const watchGrantRenewals = createWatchGrantRenewalRegistry({ ensureWatchGrant, now, logger });
  // One install dispatcher. Anchor is appServerWake or a headless Codex wake
  // that carries agentId + installationId. Cursor ACP is a member of that
  // watch, never the anchor or grant actor. Bob webhook removed.
  function readFallbackInstallationId(helperPath) {
    try {
      const raw = readFileSync(
        path.join(path.dirname(helperPath), "..", "client", "installation.json"),
        "utf8",
      );
      const installationId = JSON.parse(raw)?.installationId;
      return typeof installationId === "string" ? installationId : null;
    } catch {
      return null;
    }
  }
  function resolveConfigInstallationId(config) {
    if (typeof config?.installationId === "string") return config.installationId;
    if (typeof config?.helperPath !== "string") return null;
    return readFallbackInstallationId(config.helperPath);
  }
  function resolveRuntimeInstallAnchor(configs) {
    for (const config of configs) {
      if (typeof config.agentId !== "string" || config.agentId.length === 0) continue;
      const installationId = resolveConfigInstallationId(config);
      if (typeof installationId !== "string" || !INSTALLATION_ID.test(installationId)) continue;
      const clientDir = path.resolve(path.dirname(config.helperPath), "..", "client");
      return Object.freeze({
        helperPath: config.helperPath,
        installationId,
        cursorPath: path.join(clientDir, "wake-cursor.json"),
        actorProfile: config.profile,
        ensureBeforeWatch: true,
      });
    }
    return null;
  }
  const headlessInstallAnchor = resolveRuntimeInstallAnchor(headlessConfigs);
  const hasInstallDispatcherAnchor = Boolean(appServerConfig)
    || Boolean(headlessInstallAnchor);
  const installDispatcherEnabled = useInstallWatchDispatcher == null
    ? false
    : Boolean(useInstallWatchDispatcher);
  if (installDispatcherEnabled && !hasInstallDispatcherAnchor) {
    throw new TypeError(
      "useInstallWatchDispatcher requires appServerWake or headlessWakes with installationId as the install watch anchor",
    );
  }

  function watchGrantState(installationId) {
    return watchGrantRenewals.state(installationId);
  }

  async function renewWatchGrant(renewal, observedGeneration) {
    return watchGrantRenewals.renew(renewal, observedGeneration);
  }

  const entries = instances.map((instance) => {
    if (!instance || !INSTANCE_ID.test(instance.instanceId)) {
      throw new TypeError("instanceId must be 64 lowercase hexadecimal characters");
    }
    if (seen.has(instance.instanceId)) throw new TypeError("duplicate instanceId");
    seen.add(instance.instanceId);
    if (!instance.mailbox || typeof instance.mailbox !== "object" || Array.isArray(instance.mailbox)) {
      throw new TypeError("mailbox must be an object");
    }

    const runnerConfig = validateRunner(instance);
    const context = Object.freeze({ instanceId: instance.instanceId });
    const deliveryClient = createDeliveryClient({ ...instance.mailbox }, deliveryClientContext(context, "worker"));
    const adapterRunner = createRunner(runnerConfig, context);
    if (!adapterRunner || typeof adapterRunner.run !== "function") {
      throw new TypeError("createRunner must return a runner");
    }
    localRunners.set(instance.instanceId, adapterRunner);
    const runner = Object.freeze({
      run(request, options = {}) {
        return gate.run(
          () => adapterRunner.run(request, options),
          { signal: options.signal, instanceId: instance.instanceId },
        );
      },
    });
    const worker = createWorker({
      deliveryClient,
      runner,
      pollIntervalMs,
      maxIdlePollIntervalMs,
      maxBackoffMs,
      idleJitterRatio,
      random,
      logger,
    }, context);
    if (!worker || typeof worker.watch !== "function" || typeof worker.runOnce !== "function") {
      throw new TypeError("createWorker must return a worker");
    }
    return Object.freeze({ instanceId: instance.instanceId, worker });
  });

  const clients = new Map();
  const runners = new Map();
  if (wakeConfig) {
    for (const profile of wakeConfig.profiles) {
      if (seen.has(profile.instanceId)) {
        throw new TypeError("eventWake instanceId collides with a worker instance");
      }
    }
    for (const drain of wakeConfig.drains) {
      const context = Object.freeze({ instanceId: drain.instanceId });
      const deliveryClient = createDeliveryClient({ ...drain.mailbox }, deliveryClientContext(context, "event-driven"));
      // Ungated: profile-scheduler holds the shared gate around harness preflight/run.
      const adapterRunner = createRunner(drain.runnerConfig, context);
      if (!adapterRunner || typeof adapterRunner.run !== "function") {
        throw new TypeError("createRunner must return a runner");
      }
      clients.set(drain.instanceId, deliveryClient);
      runners.set(drain.instanceId, adapterRunner);
      localRunners.set(drain.instanceId, adapterRunner);
    }
  }

  if (appServerConfig) {
    if (seen.has(appServerConfig.binding.instanceId)) {
      throw new TypeError("appServerWake instanceId collides with a worker instance");
    }
    if (wakeConfig?.profiles.some((profile) => profile.instanceId === appServerConfig.binding.instanceId)) {
      throw new TypeError("appServerWake instanceId collides with an eventWake profile");
    }
  }

  for (const headlessConfig of headlessConfigs) {
    if (seen.has(headlessConfig.profileInstanceId)) {
      throw new TypeError("headlessWake instanceId collides with a worker instance");
    }
    if (wakeConfig?.profiles.some((profile) => profile.instanceId === headlessConfig.profileInstanceId)) {
      throw new TypeError("headlessWake instanceId collides with an eventWake profile");
    }
    if (appServerConfig?.binding.instanceId === headlessConfig.profileInstanceId) {
      throw new TypeError("headlessWake instanceId collides with an appServerWake profile");
    }
  }

  for (const cursorAcpConfig of cursorAcpConfigs) {
    if (seen.has(cursorAcpConfig.profileInstanceId)) {
      throw new TypeError("cursorAcpWake instanceId collides with a worker instance");
    }
    if (wakeConfig?.profiles.some((profile) => profile.instanceId === cursorAcpConfig.profileInstanceId)) {
      throw new TypeError("cursorAcpWake instanceId collides with an eventWake profile");
    }
    if (appServerConfig?.binding.instanceId === cursorAcpConfig.profileInstanceId) {
      throw new TypeError("cursorAcpWake instanceId collides with an appServerWake profile");
    }
    if (headlessConfigs.some((config) => config.profileInstanceId === cursorAcpConfig.profileInstanceId)) {
      throw new TypeError("cursorAcpWake instanceId collides with a headlessWake profile");
    }
    if (headlessConfigs.some((config) => config.profile === cursorAcpConfig.profile)) {
      throw new TypeError("cursorAcpWake profile collides with a headlessWake profile");
    }
  }

  for (const peerConfig of peerConfigs) {
    if (seen.has(peerConfig.profileInstanceId)) {
      throw new TypeError("peerWake instanceId collides with a worker instance");
    }
    if (wakeConfig?.profiles.some((profile) => profile.instanceId === peerConfig.profileInstanceId)) {
      throw new TypeError("peerWake instanceId collides with an eventWake profile");
    }
    if (appServerConfig?.binding.instanceId === peerConfig.profileInstanceId) {
      throw new TypeError("peerWake instanceId collides with an appServerWake profile");
    }
    if (headlessConfigs.some((config) => config.profileInstanceId === peerConfig.profileInstanceId)) {
      throw new TypeError("peerWake instanceId collides with a headlessWake profile");
    }
    if (cursorAcpConfigs.some((config) => config.profileInstanceId === peerConfig.profileInstanceId)) {
      throw new TypeError("peerWake instanceId collides with a cursorAcpWake profile");
    }
  }

  if (peerConfigs.length > 0 && !createPeerLane) {
    throw new TypeError("peerWakes requires the experimental peer-supervisor.mjs entry point");
  }

  const harness = wakeConfig ? createHarness({ clients, runners, logger }) : null;
  const transport = wakeConfig
    ? sharedWatchTransport({
      helperPath: wakeConfig.helperPath,
      installationId: wakeConfig.installationId,
    })
    : null;
  const wakeRuntime = wakeConfig
    ? createWake({
      profiles: wakeConfig.profiles,
      transport,
      gate,
      harness,
      cursorPath: wakeConfig.cursorPath,
      logger,
    })
    : null;
  if (wakeConfig && (!wakeRuntime || typeof wakeRuntime.start !== "function")) {
    throw new TypeError("createWake must return a wake runtime");
  }

  let appServerBridge = null;
  if (appServerConfig) {
    const authResolver = createAuthResolver({
      serverIdentity: appServerConfig.binding.serverIdentity,
      tokenFile: appServerConfig.authTokenFile,
      tokenEnv: appServerConfig.authTokenEnv,
    });
    const appTransport = createAppServerTransport({
      endpoint: appServerConfig.binding.endpoint,
      resolveAuth: () => authResolver.resolveAuth(),
    });
    const bindingStore = createBindingStore({ filePath: appServerConfig.bindingPath });
    const deliveryResolver = typeof resolveDelivery === "function"
      ? resolveDelivery
      : createProductionAppServerDeliveryResolver({
        helperPath: appServerConfig.helperPath,
        profile: appServerConfig.actorProfile,
        // mcp-interactive App Server claims own the coordinator-delivery lane.
        protocol: "coordinator-delivery-v1",
      });
    const transactionProxy = createTrustedTransactionProxy({
      helperPath: appServerConfig.helperPath,
      profile: appServerConfig.actorProfile,
      protocol: "coordinator-delivery-v1",
    });
    const session = createSession({
      binding: appServerConfig.binding,
      transport: appTransport,
      bindingStore,
      transactionProxy,
      logger,
    });
    const watchTransport = sharedWatchTransport({
      helperPath: appServerConfig.helperPath,
      installationId: appServerConfig.installationId,
    });
    const cursorStore = createCursorStore({ filePath: appServerConfig.cursorPath });
    // App Server joins the install dispatcher when install watch is enabled.
    const appServerCoveredByInstallDispatcher = installDispatcherEnabled;
    appServerBridge = createWakeBridge({
      binding: appServerConfig.binding,
      session,
      watchTransport,
      cursorStore,
      helperPath: appServerConfig.helperPath,
      installationId: appServerConfig.installationId,
      actorProfile: appServerConfig.actorProfile,
      // Supervisor already refreshed the grant with an event-driven actor.
      // Bridge must not re-ensure using the mcp-interactive claim profile.
      ensureBeforeWatch: false,
      resolveDelivery: deliveryResolver,
      ownWatchLoop: !appServerCoveredByInstallDispatcher,
      logger,
    });
    if (!appServerBridge || typeof appServerBridge.start !== "function") {
      throw new TypeError("createWakeBridge must return an App Server wake bridge");
    }
  }

  const headlessEntries = [];
  const headlessWakeSkipReasons = {};
  const headlessAdmissions = [];
  for (const headlessConfig of headlessConfigs) {
    const lockDirectory = path.resolve(path.dirname(headlessConfig.helperPath), "..", "client");
    const lockPath = path.join(lockDirectory, `headless-claimer.${headlessConfig.profile}.json`);
    const headlessClaimer = createClaimerGuard({
      profile: headlessConfig.profile,
      allowedRoomId: headlessConfig.allowedRoomId ?? null,
      helperPath: headlessConfig.helperPath,
      lockPath,
    });
    try {
      headlessClaimer.assertSupervisorMayClaim();
    } catch (error) {
      if (
        error?.code === "dedicated_headless_drain_loaded"
        || error?.code === "supervisor_headless_claimer_active"
        || error?.code === "cursor_acp_claimer_blocks_codex"
        || error?.code === "cursor_acp_drain_blocks_codex"
      ) {
        headlessWakeSkipReasons[headlessConfig.profile] = error.code;
        logger.error?.("triangle_client_headless_wake_skipped", {
          error: "Refusing dual headless mailbox claimers",
          code: error.code,
        });
      } else {
        throw error;
      }
    }
    headlessAdmissions.push({ config: headlessConfig, claimer: headlessClaimer });
  }
  if (Object.keys(headlessWakeSkipReasons).length > 0) {
    for (const config of headlessConfigs) {
      headlessWakeSkipReasons[config.profile] ??= "headless_pool_admission_failed";
    }
  } else {
    for (const { config: headlessConfig, claimer: headlessClaimer } of headlessAdmissions) {
      const drain = createHeadlessDrain(headlessConfig, {
        logger,
        ownerInstanceId: `client-supervisor-${process.pid}`,
      });
      if (!drain || typeof drain.start !== "function" || typeof drain.stop !== "function") {
        throw new TypeError("createHeadlessDrain must return a drain");
      }
      headlessEntries.push(Object.freeze({ config: headlessConfig, drain, claimer: headlessClaimer }));
    }
  }

  const cursorAcpEntries = [];
  const cursorAcpWakeSkipReasons = {};
  const cursorAcpAdmissions = [];
  for (const cursorAcpConfig of cursorAcpConfigs) {
    const lockDirectory = path.resolve(path.dirname(cursorAcpConfig.helperPath), "..", "client");
    const lockPath = path.join(lockDirectory, `cursor-acp-claimer.${cursorAcpConfig.profile}.json`);
    const cursorAcpClaimer = createCursorAcpClaimer({
      profile: cursorAcpConfig.profile,
      shadowTestProfile: cursorAcpConfig.shadowTestProfile === true,
      helperPath: cursorAcpConfig.helperPath,
      lockPath,
    });
    try {
      cursorAcpClaimer.assertSupervisorMayClaim();
    } catch (error) {
      if (
        error?.code === "dedicated_cursor_acp_drain_loaded"
        || error?.code === "supervisor_cursor_acp_claimer_active"
        || error?.code === "codex_drain_blocks_cursor_acp"
        || error?.code === "codex_claimer_blocks_cursor_acp"
      ) {
        cursorAcpWakeSkipReasons[cursorAcpConfig.profile] = error.code;
        logger.error?.("triangle_client_cursor_acp_wake_skipped", {
          error: "Refusing dual Cursor ACP mailbox claimers",
          code: error.code,
        });
      } else {
        throw error;
      }
    }
    cursorAcpAdmissions.push({ config: cursorAcpConfig, claimer: cursorAcpClaimer });
  }
  if (Object.keys(cursorAcpWakeSkipReasons).length > 0) {
    for (const config of cursorAcpConfigs) {
      cursorAcpWakeSkipReasons[config.profile] ??= "cursor_acp_pool_admission_failed";
    }
  } else {
    for (const { config: cursorAcpConfig, claimer: cursorAcpClaimer } of cursorAcpAdmissions) {
      const cursorAcpProgress = progressJournal?.forProfile(cursorAcpConfig.profile, "cursor-acp") ?? null;
      const drain = createCursorAcpDrain(cursorAcpConfig, {
        logger,
        ownerInstanceId: `client-supervisor-${process.pid}`,
        ...(cursorAcpProgress ? { progress: cursorAcpProgress } : {}),
      });
      if (!drain || typeof drain.start !== "function" || typeof drain.stop !== "function") {
        throw new TypeError("createCursorAcpDrain must return a drain");
      }
      cursorAcpEntries.push(Object.freeze({ config: cursorAcpConfig, drain, claimer: cursorAcpClaimer }));
    }
  }

  // Local messaging is optional. Its failures stay inside the local route: the
  // MESH, headless and ACP lanes keep running while watch() retries the host
  // and localStatus() reports the failure code.
  let localHost = null;
  let localFailure = null;
  let localClosed = false;
  let pendingLocalError = null;
  function openLocalHost() {
    localHost = createLocalMessagingHost({
      configPath: localMessaging.configPath, runners: localRunners, gate, logger,
    });
    return localHost;
  }
  function recordLocalFailure(error) {
    const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : "local_messaging_failed";
    localFailure = { code, at: now(), attempts: (localFailure?.attempts ?? 0) + 1 };
  }
  async function stopLocalHost() {
    const host = localHost;
    localHost = null;
    try {
      await host?.stop();
    } catch {
      logger.error?.("triangle_client_local_messaging_stop_failed", { error: "Local messaging host stop failed" });
    }
  }
  if (localMessaging) {
    try {
      openLocalHost();
    } catch (error) {
      pendingLocalError = error;
      recordLocalFailure(error);
    }
  }

  const peerLane = createPeerLane && peerConfigs.length > 0
    ? createPeerLane({
        peerConfigs,
        createRunner,
        gate,
        logger,
      })
    : null;

  let installDispatcher = null;
  if (installDispatcherEnabled && hasInstallDispatcherAnchor) {
    const dispatcherProfiles = [];
    const dispatcherHandlers = new Map();
    const laneCursorStores = [];

    if (appServerBridge && appServerConfig) {
      dispatcherProfiles.push({
        instanceId: appServerConfig.binding.instanceId,
        agentId: appServerConfig.binding.agentId,
      });
      dispatcherHandlers.set(appServerConfig.binding.instanceId, async (wake) => {
        try {
          return await appServerBridge.handleWake(wake);
        } catch (error) {
          logger.error?.("triangle_app_server_wake_admit_failed", {
            code: error?.code,
            message: error?.message,
            instanceId: wake?.instanceId,
          });
          throw error;
        }
      });
      laneCursorStores.push(createCursorStore({ filePath: appServerConfig.cursorPath }));
    }

    const installAnchor = appServerConfig ?? headlessInstallAnchor;
    if (!installAnchor) {
      throw new TypeError(
        "useInstallWatchDispatcher requires appServerWake or headlessWakes with installationId as the install watch anchor",
      );
    }

    // Register kick handlers when agentId is present. Events arrive only after
    // the install grant includes those agent ids. Cursor ACP joins this same
    // profile list — no second watch listener or cursor. shadowTestProfile is
    // accepted for compatibility and does not exclude an enrolled profile.
    function registerDrainKick(entry, { lane, logEvent }) {
      const agentId = entry.config.agentId;
      if (typeof agentId !== "string" || agentId.length === 0) return;
      const installationId = resolveConfigInstallationId(entry.config);
      if (typeof installationId === "string" && installationId !== installAnchor.installationId) {
        throw new TypeError(`${lane} installationId does not match the install watch anchor`);
      }
      if (dispatcherProfiles.some((profile) => profile.agentId === agentId)) {
        throw new TypeError(`${lane} agentId collides with an install dispatcher profile`);
      }
      if (typeof entry.drain.kick !== "function") {
        throw new TypeError(`${lane} drain must expose kick() for install dispatcher`);
      }
      dispatcherProfiles.push({
        instanceId: entry.config.profileInstanceId,
        agentId,
      });
      dispatcherHandlers.set(entry.config.profileInstanceId, async (wake) => {
        const reason = typeof wake?.reason === "string" && wake.reason.length > 0
          ? (wake.reason.startsWith("watch_hint") ? wake.reason : "watch_hint")
          : "watch_hint";
        const result = entry.drain.kick({ reason });
        // Kick is admit-only. Never let an in-flight drain promise hold the
        // install cursor (held watch-poll + drain share the helper).
        if (result && typeof result.then === "function") {
          result.catch((error) => {
            logger.error?.(logEvent, {
              code: error?.code ?? null,
              instanceId: entry.config.profileInstanceId,
            });
          });
          return { status: "accepted", reason };
        }
        return result ?? { status: "accepted", reason };
      });
    }

    for (const entry of headlessEntries) {
      registerDrainKick(entry, {
        lane: "headlessWake",
        logEvent: "triangle_client_headless_kick_failed",
      });
    }
    for (const entry of cursorAcpEntries) {
      registerDrainKick(entry, {
        lane: "cursorAcpWake",
        logEvent: "triangle_client_cursor_acp_kick_failed",
      });
    }

    if (dispatcherProfiles.length === 0) {
      throw new TypeError("useInstallWatchDispatcher requires at least one wake lane profile");
    }
    const installCursorPath = resolveInstallWatchCursorPath(installAnchor.cursorPath);
    const watchTransport = sharedWatchTransport({
      helperPath: installAnchor.helperPath,
      installationId: installAnchor.installationId,
    });
    installDispatcher = createInstallDispatcher({
      profiles: dispatcherProfiles,
      handlers: dispatcherHandlers,
      transport: watchTransport,
      cursorStore: createCursorStore({ filePath: installCursorPath }),
      laneCursorStores,
      // Hobby Fluid memory: 2s reconnect after empty hold burns ~44 GB-hrs/day
      // per always-on watcher. Prefer SAFE idle (30s) so one watcher stays near
      // ~12–22 GB-hrs/day depending on server poll timeout. This is the
      // selected M0a operating cadence; INSTALL_WATCH_HELD_POLL_IDLE_MS (2s)
      // stays a distinct opt-in and is not used by the supervisor.
      idlePollIntervalMs: INSTALL_WATCH_SAFE_IDLE_POLL_MS,
      logger,
    });
    if (!installDispatcher || typeof installDispatcher.start !== "function") {
      throw new TypeError("createInstallDispatcher must return a dispatcher");
    }
  }

  return Object.freeze({
    instanceIds: Object.freeze(entries.map(({ instanceId }) => instanceId)),
    eventWakeProfileIds: Object.freeze(wakeConfig ? wakeConfig.profiles.map(({ instanceId }) => instanceId) : []),
    appServerInstanceId: appServerConfig?.binding.instanceId ?? null,
    grokBotInstanceId: null,
    headlessInstanceIds: Object.freeze(headlessConfigs.map((config) => config.profileInstanceId)),
    cursorAcpInstanceIds: Object.freeze(cursorAcpConfigs.map((config) => config.profileInstanceId)),
    peerInstanceIds: Object.freeze(peerConfigs.map((config) => config.profileInstanceId)),
    eventWake: wakeConfig,
    appServerWake: appServerConfig,
    grokBotWake: null,
    headlessWakes: headlessConfigs,
    cursorAcpWakes: cursorAcpConfigs,
    peerWakes: peerConfigs,
    pendingPeerReplies(options = {}) {
      if (!peerLane) {
        if (options?.profileInstanceId !== undefined) {
          throw new TypeError("Unknown peer profileInstanceId");
        }
        return Promise.resolve([]);
      }
      return peerLane.pendingPeerReplies(options);
    },
    sendPeerMessage(options = {}) {
      if (!peerLane) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      return peerLane.sendPeerMessage(options);
    },
    consumePeerReply(options = {}) {
      if (!peerLane) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      return peerLane.consumePeerReply(options);
    },
    peerStatus(options = {}) {
      if (!peerLane) {
        if (options?.profileInstanceId !== undefined) {
          throw new TypeError("Unknown peer profileInstanceId");
        }
        return Promise.resolve([]);
      }
      return peerLane.peerStatus(options);
    },
    resolvePeerRecord(options = {}) {
      if (!peerLane) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      return peerLane.resolvePeerRecord(options);
    },
    localStatus() {
      if (!localMessaging) return { enabled: false, route: "same-device" };
      let hostStatus = null;
      try {
        hostStatus = localHost?.status() ?? null;
      } catch {
        hostStatus = null;
      }
      // Healthy only when the host says it runs and no failure is outstanding.
      const status = { route: "same-device", ...hostStatus, enabled: true };
      if (localFailure) {
        return { ...status, running: false, state: "failed", failure: { ...localFailure } };
      }
      const running = !localClosed && hostStatus?.running === true;
      return { ...status, running, state: localClosed ? "stopped" : running ? "running" : "starting" };
    },
    async close() {
      localClosed = true;
      await stopLocalHost();
      if (peerLane) {
        await peerLane.close();
      }
    },
    headlessWakeSkipReasons: Object.freeze({ ...headlessWakeSkipReasons }),
    cursorAcpWakeSkipReasons: Object.freeze({ ...cursorAcpWakeSkipReasons }),
    installWatchDispatcherEnabled: installDispatcherEnabled,
    installWatchProfileIds: Object.freeze(
      installDispatcher?.profiles?.map(({ instanceId }) => instanceId) ?? [],
    ),

    async runOnce({ signal } = {}) {
      const results = await Promise.all(entries.map(async ({ instanceId, worker }) => {
        try {
          return { instanceId, ...(await worker.runOnce({ signal })) };
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throw error;
          logger.error?.("triangle_client_instance_failed", {
            instanceId,
            error: "Instance cycle failed",
          });
          return { instanceId, found: null, processed: 0, failed: true };
        }
      }));
      const out = { instances: results };
      if (peerLane) {
        try {
          out.peerInstances = await peerLane.runOnce({ signal });
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throw error;
          // Report a lane failure per peer instance, like a failed worker instance, so the MESH results
          // above still reach the caller (P13).
          out.peerInstances = peerConfigs.map((config) => ({
            profile: config.profile,
            profileInstanceId: config.profileInstanceId,
            instanceId: config.profileInstanceId,
            failed: true,
            code: typeof error?.code === "string" ? error.code : "peer_lane_failed",
          }));
        }
      }
      return out;
    },

    async watch({ signal, sleep } = {}) {
      // Initial watch-grant ensure is scoped to the affected wake loop below so
      // worker / headless / Cursor ACP drains start independently. Persistent
      // 402/429 backoff must not serialize ahead of unrelated mailbox lanes.
      // Preference matches prior supervisor ensure: eventWake > appServer (with
      // event-driven actor). Shared grant renewal stays installation-scoped.
      const wakeEnsure = wakeRuntime && wakeConfig.ensureBeforeWatch
        ? {
          helperPath: wakeConfig.helperPath,
          installationId: wakeConfig.installationId,
          actorProfile: wakeConfig.actorProfile,
        }
        : null;
      const appServerEnsure = !wakeEnsure
        && appServerBridge
        && appServerConfig.ensureBeforeWatch
        && wakeConfig?.actorProfile
        ? {
          // App Server actorProfile is mcp-interactive (claim/reply owner). Grant
          // ensure must use an event-driven actor so notify members can refresh.
          helperPath: appServerConfig.helperPath,
          installationId: appServerConfig.installationId,
          actorProfile: wakeConfig.actorProfile,
        }
        : null;
      const headlessEnsure = !wakeEnsure
        && !appServerEnsure
        && installDispatcher
        && headlessInstallAnchor?.ensureBeforeWatch
        ? {
          helperPath: headlessInstallAnchor.helperPath,
          installationId: headlessInstallAnchor.installationId,
          actorProfile: headlessInstallAnchor.actorProfile,
        }
        : null;

      const workerLoop = Promise.all(entries.map(async ({ instanceId, worker }) => {
        try {
          return { instanceId, ...(await worker.watch({ signal, sleep })) };
        } catch {
          logger.error?.("triangle_client_instance_failed", {
            instanceId,
            error: "Instance loop failed",
          });
          return { instanceId, processed: 0, stopped: false };
        }
      }));

      // Keep wake loops independent and durable: a listener failure must not
      // resolve Promise.all and exit the supervisor (LaunchAgent KeepAlive thrash).
      // Retry until abort instead of returning.
      async function sleepBeforeWakeRetry(delayMs = 5_000) {
        if (typeof sleep === "function") {
          await sleep(delayMs, { signal });
          return;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener?.("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
          if (signal?.aborted) {
            clearTimeout(timer);
            resolve();
          }
        });
      }

      // Proactive renewal schedulers live for this watch() call only: they stop
      // on the caller's abort or once every loop below has settled.
      const proactiveController = new AbortController();
      const proactiveSignal = signal
        ? AbortSignal.any([signal, proactiveController.signal])
        : proactiveController.signal;
      const proactiveRenewals = [];
      function startProactiveRenewal(renewal) {
        if (!renewal) return;
        proactiveRenewals.push(watchGrantRenewals.runProactive({
          renewal,
          signal: proactiveSignal,
          sleep: typeof sleep === "function" ? sleep : undefined,
        }).catch(() => {}));
      }

      async function runDurableWakeLoop({
        start,
        stop = null,
        renewal = null,
        ensure = null,
        logEvent,
        logMessage,
      }) {
        let consecutiveFailures = 0;
        let initialEnsureDone = false;
        startProactiveRenewal(renewal);
        while (!signal?.aborted) {
          let observedGeneration = renewal
            ? watchGrantState(renewal.installationId).generation
            : null;
          try {
            if (ensure && !initialEnsureDone) {
              const ensured = await ensureWatchGrant({ ...ensure, signal });
              initialEnsureDone = true;
              watchGrantRenewals.recordEnsure(ensure.installationId, ensured);
              if (renewal) observedGeneration = watchGrantState(renewal.installationId).generation;
            }
            const result = await start();
            consecutiveFailures = 0;
            return result;
          } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") return null;
            consecutiveFailures += 1;
            const ensureFailed = Boolean(ensure) && !initialEnsureDone;
            const status = error?.status ?? error?.httpStatus;
            if (ensureFailed && (status === 402 || status === 429)) {
              logger.error?.("triangle_client_watch_ensure_failed", {
                error: "Watch grant ensure rejected",
                status,
                code: error?.code,
                rejectedCode: error?.rejectedCode,
              });
            } else {
              logger.error?.(logEvent, {
                error: logMessage,
                code: error?.code,
                status,
                rejectedCode: typeof error?.rejectedCode === "string" ? error.rejectedCode : undefined,
                failureCode: typeof error?.failureCode === "string" ? error.failureCode : undefined,
                message: typeof error?.message === "string" ? error.message.slice(0, 200) : undefined,
              });
            }
            // Clear sticky started/session state before retry so the next
            // start() cannot spam already_started after a watch-poll failure.
            if (typeof stop === "function") {
              try {
                await stop();
              } catch {
                /* ignore stop errors during restart */
              }
            }
            let activeError = error;
            if (renewal && isRenewableWatchCredentialError(error)) {
              try {
                await renewWatchGrant({ ...renewal, signal }, observedGeneration);
              } catch (renewalError) {
                if (signal?.aborted || renewalError?.name === "AbortError") return null;
                activeError = renewalError;
                logger.error?.("triangle_client_watch_grant_renewal_failed", {
                  error: "Watch grant renewal failed",
                  code: renewalError?.code,
                  status: renewalError?.status ?? renewalError?.httpStatus,
                  rejectedCode: typeof renewalError?.rejectedCode === "string"
                    ? renewalError.rejectedCode
                    : undefined,
                  failureCode: typeof renewalError?.failureCode === "string"
                    ? renewalError.failureCode
                    : undefined,
                });
              }
            }
            const code = activeError?.code;
            if (code === "binding_endpoint_changed" || code === "binding_server_identity_changed") {
              await new Promise((resolve) => {
                signal?.addEventListener?.("abort", resolve, { once: true });
                if (signal?.aborted) resolve();
              });
              return null;
            }
            const activeStatus = activeError?.status ?? activeError?.httpStatus;
            let delayMs = Math.min(maxBackoffMs, 5_000 * Math.pow(2, Math.min(consecutiveFailures - 1, 6)));
            if (activeStatus === 402) {
              delayMs = Math.max(delayMs, 15 * 60_000);
            } else if (activeStatus === 429) {
              delayMs = Math.max(delayMs, 30_000);
            }
            const jitter = Math.floor(random() * delayMs * 0.1);
            await sleepBeforeWakeRetry(delayMs + jitter);
          }
        }
        return null;
      }

      const wakeLoop = wakeRuntime
        ? runDurableWakeLoop({
          start: () => wakeRuntime.start({ signal }),
          stop: typeof wakeRuntime.stop === "function" ? () => wakeRuntime.stop() : null,
          renewal: wakeConfig.ensureBeforeWatch ? {
            helperPath: wakeConfig.helperPath,
            installationId: wakeConfig.installationId,
            actorProfile: wakeConfig.actorProfile,
          } : null,
          ensure: wakeEnsure,
          logEvent: "triangle_client_event_wake_failed",
          logMessage: "Event-driven wake listener failed",
        })
        : Promise.resolve(null);

      const installDispatcherLoop = installDispatcher
        ? runDurableWakeLoop({
          start: async () => {
            // Handler-only bridges arm webhook/session state; dispatcher owns the poll.
            if (appServerBridge) {
              await appServerBridge.start({ signal });
            }
            return installDispatcher.start({ signal });
          },
          stop: async () => {
            try {
              await installDispatcher.stop();
            } catch {
              /* ignore */
            }
            if (appServerBridge) {
              try {
                await appServerBridge.stop();
              } catch {
                /* ignore */
              }
            }
          },
          // Grant renewal: prefer event-driven / App Server actor; headless Codex
          // may renew when it is the install-watch anchor. Cursor ACP is never
          // the actor.
          renewal: (() => {
            const anchor = appServerConfig ?? headlessInstallAnchor;
            if (!anchor?.ensureBeforeWatch) return null;
            const actorProfile = wakeConfig?.actorProfile
              ?? headlessInstallAnchor?.actorProfile;
            if (!actorProfile) return null;
            return {
              helperPath: anchor.helperPath,
              installationId: anchor.installationId,
              actorProfile,
            };
          })(),
          ensure: appServerEnsure ?? headlessEnsure,
          logEvent: "triangle_client_install_watch_failed",
          logMessage: "Install watch dispatcher failed",
        })
        : Promise.resolve(null);

      const appServerLoop = installDispatcher
        ? Promise.resolve(null)
        : appServerBridge
          ? runDurableWakeLoop({
            start: () => appServerBridge.start({ signal }),
            stop: () => appServerBridge.stop(),
            renewal: appServerConfig.ensureBeforeWatch && wakeConfig?.actorProfile ? {
              helperPath: appServerConfig.helperPath,
              installationId: appServerConfig.installationId,
              actorProfile: wakeConfig.actorProfile,
            } : null,
            ensure: appServerEnsure,
            logEvent: "triangle_client_app_server_wake_failed",
            logMessage: "App Server bound wake listener failed",
          })
          : Promise.resolve(null);

      function waitForAbort(target) {
        if (target?.aborted) return Promise.resolve();
        if (target == null) return new Promise(() => {});
        return new Promise((resolve) => {
          target.addEventListener("abort", () => resolve(), { once: true });
        });
      }

      const headlessLoop = headlessEntries.length
        ? runDurableWakeLoop({
          start: async () => {
            const acquired = [];
            try {
              for (const entry of headlessEntries) {
                entry.claimer.acquire({ owner: CLIENT_SUPERVISOR_CLAIMER_OWNER });
                acquired.push(entry);
              }
              const starts = headlessEntries.map((entry) => entry.drain.start({ runLoop: true }));
              try {
                await Promise.all(starts);
              } catch (error) {
                // Promise.all rejects on the first failure. Wait for every peer
                // start attempt to settle before rollback so a late start cannot
                // escape after its drain has already been stopped.
                await Promise.allSettled(starts);
                throw error;
              }
              await waitForAbort(signal);
              return headlessEntries.map(({ config }) => ({ status: "stopped", skipped: false, profileInstanceId: config.profileInstanceId }));
            } finally {
              for (const entry of [...headlessEntries].reverse()) {
                try { await entry.drain.stop(); } catch {}
              }
              for (const entry of [...acquired].reverse()) {
                entry.claimer.release({ owner: CLIENT_SUPERVISOR_CLAIMER_OWNER });
              }
            }
          },
          stop: async () => {
            for (const entry of [...headlessEntries].reverse()) {
              try { await entry.drain.stop(); } catch {}
            }
            for (const entry of [...headlessEntries].reverse()) {
              entry.claimer.release({ owner: CLIENT_SUPERVISOR_CLAIMER_OWNER });
            }
          },
          logEvent: "triangle_client_headless_wake_failed",
          logMessage: "Headless Codex drain failed",
        })
        : Promise.resolve(
          headlessConfigs.length
            ? headlessConfigs.map((config) => headlessWakeSkipReasons[config.profile]
              ? { skipped: true, reason: headlessWakeSkipReasons[config.profile], profileInstanceId: config.profileInstanceId }
              : null)
            : [],
        );

      const cursorAcpLoop = cursorAcpEntries.length
        ? runDurableWakeLoop({
          start: async () => {
            const acquired = [];
            try {
              for (const entry of cursorAcpEntries) {
                entry.claimer.acquire({ owner: CURSOR_ACP_CLIENT_SUPERVISOR_CLAIMER_OWNER });
                acquired.push(entry);
              }
              const starts = cursorAcpEntries.map((entry) => entry.drain.start({ runLoop: true }));
              try {
                await Promise.all(starts);
              } catch (error) {
                await Promise.allSettled(starts);
                throw error;
              }
              await waitForAbort(signal);
              return cursorAcpEntries.map(({ config }) => ({
                status: "stopped",
                skipped: false,
                profileInstanceId: config.profileInstanceId,
              }));
            } finally {
              for (const entry of [...cursorAcpEntries].reverse()) {
                try { await entry.drain.stop(); } catch {}
              }
              for (const entry of [...acquired].reverse()) {
                entry.claimer.release({ owner: CURSOR_ACP_CLIENT_SUPERVISOR_CLAIMER_OWNER });
              }
            }
          },
          stop: async () => {
            for (const entry of [...cursorAcpEntries].reverse()) {
              try { await entry.drain.stop(); } catch {}
            }
            for (const entry of [...cursorAcpEntries].reverse()) {
              entry.claimer.release({ owner: CURSOR_ACP_CLIENT_SUPERVISOR_CLAIMER_OWNER });
            }
          },
          logEvent: "triangle_client_cursor_acp_wake_failed",
          logMessage: "Cursor ACP drain failed",
        })
        : Promise.resolve(
          cursorAcpConfigs.length
            ? cursorAcpConfigs.map((config) => cursorAcpWakeSkipReasons[config.profile]
              ? {
                skipped: true,
                reason: cursorAcpWakeSkipReasons[config.profile],
                profileInstanceId: config.profileInstanceId,
              }
              : null)
            : [],
        );

      const peerLoop = peerLane
        ? peerLane.watch({ signal, sleep, runDurableWakeLoop })
        : Promise.resolve([]);

      const localLoop = localMessaging
        ? runDurableWakeLoop({
          start: async () => {
            // A construction failure was recorded when the supervisor was built.
            if (pendingLocalError) {
              const error = pendingLocalError;
              pendingLocalError = null;
              throw error;
            }
            try {
              const host = localHost ?? openLocalHost();
              return await host.watch({ signal, onStarted: () => { localFailure = null; } });
            } catch (error) {
              if (!signal?.aborted) recordLocalFailure(error);
              throw error;
            }
          },
          // Each retry rebuilds the host so it rereads repaired owner files.
          stop: stopLocalHost,
          logEvent: "triangle_client_local_messaging_failed",
          logMessage: "Local messaging host failed",
        })
        : Promise.resolve(null);
      let settled;
      try {
        settled = await Promise.all([
          workerLoop,
          wakeLoop,
          installDispatcherLoop,
          appServerLoop,
          headlessLoop,
          cursorAcpLoop,
          peerLoop,
          localLoop,
        ]);
      } finally {
        proactiveController.abort();
        await Promise.allSettled(proactiveRenewals);
        localClosed = true;
        await stopLocalHost();
      }
      const [instances, wakeResult, installResult, appServerResult, headlessResult, cursorAcpResult, peerResult] = settled;
      return {
        instances,
        eventWake: wakeResult,
        installWatch: installResult,
        appServerWake: appServerResult,
        grokBotWake: null,
        headlessWakes: Array.isArray(headlessResult) ? headlessResult : [headlessResult].filter(Boolean),
        cursorAcpWakes: Array.isArray(cursorAcpResult) ? cursorAcpResult : [cursorAcpResult].filter(Boolean),
        peerWakes: Array.isArray(peerResult) ? peerResult : [peerResult].filter(Boolean),
      };
    },
  });
}
