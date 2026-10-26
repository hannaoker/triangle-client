import path from "node:path";
import { LocalStateError } from "./errors.mjs";
import { identityInventory } from "./identity-inventory.mjs";

/**
 * Invokes the identity status view generation by combining identity inventory observations
 * and identity registry state into an identity view.
 *
 * @param {object} options
 * @param {string} options.clientRoot - Absolute path to client root.
 * @param {string} options.registryRoot - Absolute path to registry root.
 * @param {Function} [options.readIdentityRegistry]
 * @param {Function} [options.buildIdentityView]
 * @param {Function} [options.identityInventory]
 * @param {Function} [options.pidAlive]
 * @param {Function} [options.advisoryHeldAt]
 * @param {Function|string|number|Date} [options.now]
 * @returns {Promise<object>} Identity view report.
 */
export async function identityStatus({
  clientRoot,
  registryRoot,
  readIdentityRegistry: customReadIdentityRegistry,
  buildIdentityView: customBuildIdentityView,
  identityInventory: customIdentityInventory,
  pidAlive = () => "unknown",
  advisoryHeldAt = () => "unknown",
  now,
} = {}) {
  if (typeof clientRoot !== "string" || !path.isAbsolute(clientRoot)) {
    throw new TypeError("clientRoot must be an absolute path");
  }
  if (typeof registryRoot !== "string" || !path.isAbsolute(registryRoot)) {
    throw new TypeError("registryRoot must be an absolute path");
  }

  let readIdentityRegistry = customReadIdentityRegistry;
  let buildIdentityView = customBuildIdentityView;
  const inventoryBridge = customIdentityInventory ?? identityInventory;

  if (!readIdentityRegistry || !buildIdentityView) {
    let workerRegistry;
    let workerView;
    try {
      workerRegistry = await import("../../agent-worker/src/identity-registry.mjs");
      workerView = await import("../../agent-worker/src/identity-view.mjs");
    } catch (error) {
      const err = new LocalStateError(
        "Identity status foundation (@the-triangle/agent-worker) is not available in this installation."
      );
      err.cause = error;
      throw err;
    }
    readIdentityRegistry ??= workerRegistry.readIdentityRegistry;
    buildIdentityView ??= workerView.buildIdentityView;
  }

  const inventory = await inventoryBridge({
    clientRoot,
    pidAlive,
    advisoryHeldAt,
    ...(now !== undefined ? { now } : {}),
  });

  let registry;
  try {
    registry = await readIdentityRegistry({ root: registryRoot });
  } catch (error) {
    registry = {
      state: "unreadable",
      code: error?.code ?? "unknown",
    };
  }

  const view = buildIdentityView({ inventory, registry });
  return view;
}
