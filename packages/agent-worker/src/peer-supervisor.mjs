// Experimental peer supervisor entry point.
// Injects the peer lane factory into the client supervisor.
import { createClientSupervisor as baseCreateClientSupervisor } from "./client-supervisor.mjs";
import { createPeerLane } from "./peer-lane.mjs";
import { createPeerEngineManager } from "./peer-engine-manager.mjs";
import { createPeerDrainService } from "./peer-drain-service.mjs";

export function createPeerSupervisor(options = {}) {
  const {
    createPeerEngine = createPeerEngineManager,
    createPeerDrain = createPeerDrainService,
    createPeerLane: customCreatePeerLane,
    ...rest
  } = options;
  const laneFactory = customCreatePeerLane ?? ((laneOpts) => createPeerLane({
    createPeerEngine,
    createPeerDrain,
    ...laneOpts,
  }));
  return baseCreateClientSupervisor({
    createPeerLane: laneFactory,
    ...rest,
  });
}

export function createClientSupervisor(options = {}) {
  return createPeerSupervisor(options);
}
