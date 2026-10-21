// Experimental peer supervisor entry point.
// Injects the peer engine and drain factories into the client supervisor.
import { createClientSupervisor as baseCreateClientSupervisor } from "./client-supervisor.mjs";
import { createPeerEngineManager } from "./peer-engine-manager.mjs";
import { createPeerDrainService } from "./peer-drain-service.mjs";

export function createPeerSupervisor(options = {}) {
  return baseCreateClientSupervisor({
    createPeerEngine: createPeerEngineManager,
    createPeerDrain: createPeerDrainService,
    ...options,
  });
}

export function createClientSupervisor(options = {}) {
  return createPeerSupervisor(options);
}
