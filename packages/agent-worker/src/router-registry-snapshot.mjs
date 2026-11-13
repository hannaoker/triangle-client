import fs from "node:fs";
import path from "node:path";
import { readIdentityRegistry, REGISTRY_FILE_NAME, SUPPORTED_REGISTRY_SCHEMAS } from "./identity-registry.mjs";
import {
  AGENT_ID_PATTERN,
  ALIAS_PATTERN,
  DESTINATION_HARNESSES,
  isValidWorkspacePath,
} from "./identity-primitives.mjs";

// The registry schemas this process can read. The router reports them in `local_status`. They are re-exported here so the
// router itself imports no registry code: the source-level isolation test (identity-registry.test.mjs) lets only approved
// modules name it, and this one is among them.
export { SUPPORTED_REGISTRY_SCHEMAS };

const EMPTY_ARRAY = Object.freeze([]);
const DESTINATION_HARNESS_SET = new Set(DESTINATION_HARNESSES);

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
    schema: null,
    errorCode: null,
    readAt,
    bindingsFor(_principalId) {
      return EMPTY_ARRAY;
    },
    bindingForInstance(_instanceId) {
      return null;
    },
    aliasFor(_name) {
      return null;
    },
    aliasesFor(_principalId) {
      return EMPTY_ARRAY;
    },
    destinationFor(_principalId) {
      return null;
    },
    destinations() {
      return EMPTY_ARRAY;
    },
  });
}

function createUnreadableSnapshot(errorCode, readAt) {
  return deepFreeze({
    state: "unreadable",
    sequence: 0,
    schema: null,
    errorCode,
    readAt,
    bindingsFor(_principalId) {
      return EMPTY_ARRAY;
    },
    bindingForInstance(_instanceId) {
      return null;
    },
    aliasFor(_name) {
      return null;
    },
    aliasesFor(_principalId) {
      return EMPTY_ARRAY;
    },
    destinationFor(_principalId) {
      return null;
    },
    destinations() {
      return EMPTY_ARRAY;
    },
  });
}

function createOkSnapshot(registry, readAt) {
  const sequence =
    typeof registry?.sequence === "number" && Number.isSafeInteger(registry.sequence) && registry.sequence >= 0
      ? registry.sequence
      : 0;
  // The schema of the registry that was read (v1 or v2): the router reports it in `local_status`. Of a v2 file, aliases and
  // destination rules reach routing (pairings are not copied here), and serverless-peer bindings are skipped below.
  const schema = typeof registry?.schema === "string" ? registry.schema : null;

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

  // Aliases (AD.1): only the name and its target principal are copied, from a v2 registry (a v1 one has none). Maps keep a name
  // such as `constructor` an ordinary key. Whether a target is bound, local and messageable is decided at resolve time.
  const aliasTargets = new Map();
  const aliasNamesByPrincipal = new Map();
  const rawAliases = registry?.aliases;
  if (rawAliases && typeof rawAliases === "object") {
    for (const name of Object.keys(rawAliases).sort(compareCodeUnits)) {
      const principal = rawAliases[name]?.principal_id;
      if (typeof principal !== "string" || !ALIAS_PATTERN.test(name)) continue;
      aliasTargets.set(name, principal);
      let names = aliasNamesByPrincipal.get(principal);
      if (!names) {
        names = [];
        aliasNamesByPrincipal.set(principal, names);
      }
      names.push(name);
    }
    for (const names of aliasNamesByPrincipal.values()) Object.freeze(names);
  }

  // Destination rules (AD.5): owner-configured (harness, workspace) defaults keyed by active MESH principal (agent_* only; peer_ deferred).
  const destinationByPrincipal = new Map();
  const destinationEntries = [];
  const rawDestinations = registry?.destinations;
  if (rawDestinations && typeof rawDestinations === "object") {
    for (const principalId of Object.keys(rawDestinations).sort(compareCodeUnits)) {
      const record = rawDestinations[principalId];
      if (
        !record ||
        typeof record !== "object" ||
        !AGENT_ID_PATTERN.test(principalId) ||
        !DESTINATION_HARNESS_SET.has(record.harness) ||
        !isValidWorkspacePath(record.workspace) ||
        !Number.isSafeInteger(record.generation) ||
        record.generation < 1
      ) {
        continue;
      }
      const entry = deepFreeze({
        principalId,
        harness: record.harness,
        workspace: record.workspace,
        setAt: typeof record.set_at === "string" ? record.set_at : null,
        generation: record.generation,
      });
      destinationByPrincipal.set(principalId, entry);
      destinationEntries.push(entry);
    }
  }
  Object.freeze(destinationEntries);

  return deepFreeze({
    state: "ok",
    sequence,
    schema,
    errorCode: null,
    readAt,
    bindingsFor(principalId) {
      return byPrincipal.get(principalId) ?? EMPTY_ARRAY;
    },
    bindingForInstance(instanceId) {
      return byInstance.get(instanceId) ?? null;
    },
    aliasFor(name) {
      return aliasTargets.get(name) ?? null;
    },
    aliasesFor(principalId) {
      return aliasNamesByPrincipal.get(principalId) ?? EMPTY_ARRAY;
    },
    destinationFor(principalId) {
      return destinationByPrincipal.get(principalId) ?? null;
    },
    destinations() {
      return destinationEntries;
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
