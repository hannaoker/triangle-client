// The SQLite kernel lock is held independently of the metadata files, across awaits.
import {
  deriveTrustedClaimId,
  deriveTrustedReplyIdempotencyKey,
} from "../../agent-worker/src/helper-transaction-proxy.mjs";
import { openCustody } from "../../triangle-cli/src/custody.mjs";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
const phases = new Set([
  "prepared",
  "claimed",
  "executing",
  "failed",
  "replying",
  "replied",
  "quarantined",
]);
const fields = [
  "schema",
  "agentId",
  "instanceId",
  "deliveryId",
  "roomId",
  "eventId",
  "roomSequence",
  "claimId",
  "replyKey",
  "phase",
  "replyDigest",
  "replyEventId",
  "failureCount",
  "reason",
  "createdAt",
  "updatedAt",
  "nextAttemptAt",
  "receiptOnly",
];
export function openStore({ root, agentId }) {
  if (!path.isAbsolute(root) || !/^agent_[a-f0-9]{32}$/.test(agentId))
    throw Error("invalid_store");
  const custody = openCustody(root).init();
  if (realpathSync(root) !== path.resolve(root))
    throw Error("unsafe_store_path");
  const instanceId = createHash("sha256")
    .update(`triangle-linux-instance-v1\0${root}\0${agentId}`)
    .digest("hex");
  let held = false;
  const file = (name) => path.join(root, name + ".json");
  function read(name) {
    const st = lstatSync(file(name), { throwIfNoEntry: false });
    if (!st) return null;
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.mode & 0o077 ||
      st.size > 16384
    )
      throw Error("unsafe_metadata");
    return JSON.parse(readFileSync(file(name), "utf8"));
  }
  function write(name, value) {
    const tmp = file(name) + ".tmp-" + randomBytes(8).toString("hex");
    let fd;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(value) + "\n");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, file(name));
      sync();
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(tmp, { force: true });
    }
  }
  function sync() {
    const fd = openSync(root, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  function check(r) {
    const ident = (v, p) =>
      typeof v === "string" && new RegExp("^" + p + "_[a-f0-9]{32}$").test(v);
    if (
      !r ||
      r.schema !== 1 ||
      r.agentId !== agentId ||
      r.instanceId !== instanceId ||
      !phases.has(r.phase) ||
      !Number.isSafeInteger(r.deliveryId) ||
      r.deliveryId <= 0 ||
      !ident(r.roomId, "room") ||
      !ident(r.eventId, "event") ||
      !Number.isSafeInteger(r.roomSequence) ||
      r.roomSequence <= 0 ||
      r.claimId !== deriveTrustedClaimId(instanceId, r.deliveryId) ||
      r.replyKey !==
        deriveTrustedReplyIdempotencyKey(instanceId, r.deliveryId) ||
      !Number.isSafeInteger(r.failureCount) ||
      r.failureCount < 0 ||
      !Number.isFinite(r.createdAt) ||
      !Number.isFinite(r.updatedAt)
    )
      throw Error("invalid_journal");
    if (r.replyDigest != null && !/^[a-f0-9]{64}$/.test(r.replyDigest))
      throw Error("invalid_journal");
    if (r.replyEventId != null && !ident(r.replyEventId, "event"))
      throw Error("invalid_journal");
    if (
      r.reason != null &&
      ![
        "unknown_execution",
        "runner_failed",
        "invalid_runner_result",
        "reply_unresolved",
      ].includes(r.reason)
    )
      throw Error("invalid_journal");
    if (r.nextAttemptAt != null && !Number.isFinite(r.nextAttemptAt))
      throw Error("invalid_journal");
    if (r.receiptOnly != null && typeof r.receiptOnly !== "boolean")
      throw Error("invalid_journal");
    for (const k of Object.keys(r))
      if (!fields.includes(k)) throw Error("invalid_journal_field");
    return r;
  }
  function locked() {
    if (!held) throw Error("store_lock_required");
  }
  const api = {
    instanceId,
    withLock(fn) {
      const lf = path.join(root, ".lock.db");
      {
        const st = lstatSync(lf, { throwIfNoEntry: false });
        if (st) {
          if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077)
            throw Error("unsafe_lock");
        }
      }
      return custody.withLock(async () => {
        held = true;
        try {
          return await fn();
        } finally {
          held = false;
        }
      });
    },
    get() {
      const r = read("transaction");
      return r ? check(r) : null;
    },
    save(r) {
      locked();
      write("transaction", check(r));
    },
    clear() {
      locked();
      rmSync(file("transaction"), { force: true });
      sync();
    },
    status() {
      const r = api.get();
      return { schema: 1, agentId, transaction: r, health: api.readHealth() };
    },
    writeHealth(value) {
      const states = new Set([
        "starting",
        "running",
        "stopped",
        "needs_attention",
        "idle",
        "working",
        "completed",
        "quarantined",
        "failed",
        "paused",
        "ownership_lost",
      ]);
      if (!states.has(value.state) || !Number.isFinite(value.updatedAt))
        throw Error("invalid_health");
      const safe = {
        ...(api.readHealth() ?? {}),
        schema: 1,
        agentId,
        state: value.state,
        updatedAt: value.updatedAt,
      };
      if (value.profile !== undefined) {
        if (
          typeof value.profile !== "string" ||
          !/^[A-Za-z0-9_-]{1,80}$/.test(value.profile)
        )
          throw Error("invalid_health");
        safe.profile = value.profile;
      }
      for (const k of ["ready", "verified"])
        if (value[k] !== undefined) {
          if (typeof value[k] !== "boolean") throw Error("invalid_health");
          safe[k] = value[k];
        }
      for (const k of ["pid", "completed"])
        if (value[k] !== undefined) {
          if (!Number.isSafeInteger(value[k]) || value[k] < 0)
            throw Error("invalid_health");
          safe[k] = value[k];
        }
      if (value.verifiedAt !== undefined) {
        if (value.verifiedAt !== null && !Number.isFinite(value.verifiedAt))
          throw Error("invalid_health");
        safe.verifiedAt = value.verifiedAt;
      }
      if (value.lastError !== undefined) {
        if (
          value.lastError !== null &&
          ![
            "runtime_failed",
            "transport_failed",
            "runner_failed",
            "ownership_lost",
            "agent_not_active",
            "invalid_authority_response",
            "store_busy",
          ].includes(value.lastError)
        )
          throw Error("invalid_health");
        safe.lastError = value.lastError;
      }
      write("health", safe);
    },
    readHealth() {
      const v = read("health");
      if (!v) return null;
      const safe = { schema: 1, agentId };
      const states = [
        "starting",
        "running",
        "stopped",
        "needs_attention",
        "idle",
        "working",
        "completed",
        "quarantined",
        "failed",
        "paused",
        "ownership_lost",
      ];
      if (!states.includes(v.state) || !Number.isFinite(v.updatedAt))
        throw Error("invalid_health");
      safe.state = v.state;
      safe.updatedAt = v.updatedAt;
      if (
        typeof v.profile === "string" &&
        /^[A-Za-z0-9_-]{1,80}$/.test(v.profile)
      )
        safe.profile = v.profile;
      for (const k of ["ready", "verified"])
        if (typeof v[k] === "boolean") safe[k] = v[k];
      for (const k of ["pid", "completed"])
        if (Number.isSafeInteger(v[k]) && v[k] >= 0) safe[k] = v[k];
      if (v.verifiedAt === null || Number.isFinite(v.verifiedAt))
        safe.verifiedAt = v.verifiedAt;
      if (
        v.lastError === null ||
        [
          "runtime_failed",
          "transport_failed",
          "runner_failed",
          "ownership_lost",
          "agent_not_active",
          "invalid_authority_response",
          "store_busy",
        ].includes(v.lastError)
      )
        safe.lastError = v.lastError;
      return safe;
    },
    retry(deliveryId) {
      return api.withLock(() => {
        const r = api.get();
        if (
          !r ||
          r.deliveryId !== Number(deliveryId) ||
          !["failed", "quarantined"].includes(r.phase)
        )
          throw Error("retry_ineligible");
        api.save({
          ...r,
          phase: "prepared",
          reason: null,
          nextAttemptAt: 0,
          replyDigest: null,
          replyEventId: null,
          updatedAt: Date.now(),
        });
        return api.status();
      });
    },
    close() {
      if (held) throw Error("store_locked");
    },
  };
  return Object.freeze(api);
}
