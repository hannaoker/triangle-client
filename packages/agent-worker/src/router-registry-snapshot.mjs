import fs from "node:fs";
import path from "node:path";
import { readIdentityRegistry, REGISTRY_FILE_NAME } from "./identity-registry.mjs";

const EMPTY_ARRAY = Object.freeze([]);

function deepFreeze(obj) {
  if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) {
    return obj;
  }
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val !== null && (typeof val === "object" || typeof val === "function") && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function defaultStatRegistry(root) {
  try {
    const target = path.join(root, REGISTRY_FILE_NAME);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat) {
      return "absent";
    }
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (err) {
    const code = typeof err?.code === "string" && err.code.length > 0 ? err.code : "unknown";
    return `error:${code}`;
  }
}

function createAbsentSnapshot(readAt) {
  return deepFreeze({
    state: "absent",
    sequence: 0,
    errorCode: null,
    readAt,
    bindingsFor(_principalId) {
      return EMPTY_ARRAY;
    },
    bindingForInstance(_instanceId) {
      return null;
    },
  });
}

function createUnreadableSnapshot(errorCode, readAt) {
  return deepFreeze({
    state: "unreadable",
    sequence: 0,
    errorCode,
    readAt,
    bindingsFor(_principalId) {
      return EMPTY_ARRAY;
    },
    bindingForInstance(_instanceId) {
      return null;
    },
  });
}

function createOkSnapshot(registry, readAt) {
  const sequence =
    typeof registry?.sequence === "number" && Number.isSafeInteger(registry.sequence) && registry.sequence >= 0
      ? registry.sequence
      : 0;

  const byPrincipal = new Map();
  const byInstance = new Map();

  const rawBindings = registry?.bindings;
  if (rawBindings && typeof rawBindings === "object") {
    for (const binding of Object.values(rawBindings)) {
      if (
        binding &&
        typeof binding === "object" &&
        binding.revoked_at === null &&
        binding.trust_mode === "mesh-managed"
      ) {
        deepFreeze(binding);
        const pid = binding.principal_id;
        if (typeof pid === "string") {
          let list = byPrincipal.get(pid);
          if (!list) {
            list = [];
            byPrincipal.set(pid, list);
          }
          list.push(binding);
        }
        const iid = binding.profile_instance_id;
        if (typeof iid === "string") {
          byInstance.set(iid, binding);
        }
      }
    }
  }

  for (const [pid, list] of byPrincipal.entries()) {
    list.sort((a, b) => compareCodeUnits(a.profile_instance_id, b.profile_instance_id));
    Object.freeze(list);
  }

  return deepFreeze({
    state: "ok",
    sequence,
    errorCode: null,
    readAt,
    bindingsFor(principalId) {
      return byPrincipal.get(principalId) ?? EMPTY_ARRAY;
    },
    bindingForInstance(instanceId) {
      return byInstance.get(instanceId) ?? null;
    },
  });
}

export function createRegistrySnapshotProvider({
  root,
  readRegistry = readIdentityRegistry,
  statRegistry = defaultStatRegistry,
  now = Date.now,
  ttlMs = 2000,
} = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new TypeError("root must be an absolute path string");
  }
  if (typeof readRegistry !== "function") {
    throw new TypeError("readRegistry must be a function");
  }
  if (typeof statRegistry !== "function") {
    throw new TypeError("statRegistry must be a function");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("ttlMs must be a positive finite number");
  }

  let cachedSnapshot = null;
  let cachedKey = null;

  function get() {
    const currentTime = now();
    const currentKey = statRegistry(root);

    if (
      cachedSnapshot !== null &&
      cachedKey === currentKey &&
      currentTime - cachedSnapshot.readAt >= 0 &&
      currentTime - cachedSnapshot.readAt < ttlMs
    ) {
      return cachedSnapshot;
    }

    let snapshot;
    try {
      const result = readRegistry({ root });
      if (result?.state === "absent") {
        snapshot = createAbsentSnapshot(currentTime);
      } else if (result?.state === "ok") {
        snapshot = createOkSnapshot(result.registry, currentTime);
      } else {
        snapshot = createUnreadableSnapshot("invalid_registry_result", currentTime);
      }
    } catch (err) {
      const errorCode = typeof err?.code === "string" && err.code.length > 0 ? err.code : "unknown";
      snapshot = createUnreadableSnapshot(errorCode, currentTime);
    }

    cachedSnapshot = snapshot;
    cachedKey = currentKey;
    return snapshot;
  }

  function invalidate() {
    cachedSnapshot = null;
    cachedKey = null;
  }

  return {
    get,
    invalidate,
  };
}
