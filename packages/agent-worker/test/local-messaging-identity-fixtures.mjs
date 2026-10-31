import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { updateIdentityRegistry, LOCAL_PROFILE_BINDING_SCHEMA } from "../src/identity-registry.mjs";
import { deriveClientInstanceId } from "../src/identity-primitives.mjs";

// A mesh-managed local profile binding exactly as the router's registry snapshot reads it.
export function makeMeshManagedBinding(profileName, overrides = {}) {
  const hex32 = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
  return {
    schema: LOCAL_PROFILE_BINDING_SCHEMA,
    binding_id: `bind_${hex32(`bind:${profileName}`)}`,
    trust_mode: "mesh-managed",
    principal_id: `agent_${hex32(`agent:${profileName}`)}`,
    profile_name: profileName,
    profile_instance_id: deriveClientInstanceId(profileName),
    authority_origin: "https://thetriangle.dev",
    binding_generation: 1,
    issued_at: "2026-10-25T10:00:00.000Z",
    revoked_at: null,
    proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
    ...overrides,
  };
}

export function initIdentityRegistry(root) {
  return updateIdentityRegistry({ root, expectedSequence: 0, action: "init", subject: null, mutate: (reg) => reg });
}

// expectedSequence is the registry sequence before this write: 1 after init, then one more per binding.
export function bindProfileInRegistry(root, profileName, expectedSequence, overrides = {}) {
  const binding = makeMeshManagedBinding(profileName, overrides);
  updateIdentityRegistry({
    root,
    expectedSequence,
    action: "bind",
    subject: binding.profile_instance_id,
    mutate: (reg) => {
      reg.bindings[binding.profile_instance_id] = binding;
      return reg;
    },
  });
  return binding;
}

// Historical v1 files may already contain duplicate active principals. Seed that
// old shape explicitly; current mutation APIs must not be used to create it.
// Audit entries attest binding ids, not principal content, so retain that history.
export function seedLegacyProfileBinding(root, profileName, expectedSequence, overrides = {}) {
  const binding = makeMeshManagedBinding(profileName, overrides);
  bindProfileInRegistry(root, profileName, expectedSequence);
  const file = path.join(root, "identity-registry-v1.json");
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  registry.bindings[binding.profile_instance_id] = binding;
  fs.writeFileSync(file, JSON.stringify(registry) + "\n", { mode: 0o600 });
  return binding;
}
