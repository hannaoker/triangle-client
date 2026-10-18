// Secret-free read model for dashboards (client-console): this device, its
// owner devices and agents, and each agent's permission toggles.
import { listAgents } from "./agents.mjs";
import { MeshApiError } from "./errors.mjs";
import { fingerprint } from "./keys.mjs";
import { describePermissions, readPermissions } from "./permissions.mjs";
import { openSession } from "./session.mjs";

export async function collectPermissionsModel({ home, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const session = openSession({ home, env, fetchImpl, requireJoined: false });
  const model = { version: 1, joined: Boolean(session.owner), authority: session.transport?.authority ?? null, device: null, devices: [], agents: [], errors: [] };
  if (!session.owner) return model;
  const { controller_id, device_label, state } = session.owner;
  model.device = { controller_id, device_label, fingerprint: session.owner.fingerprint, state: await session.refreshController() ?? state };
  if (model.device.state !== "active") return model;
  try {
    const view = await listAgents(session);
    model.devices = view.controllers.map((c) => ({ controller_id: c.controller_id, device_label: c.device_label, fingerprint: c.jkt ? fingerprint(c.jkt) : null, state: c.state, this_device: c.controller_id === view.calling_controller_id }));
    for (const agent of view.agents) {
      const entry = { agent_id: agent.agent_id, handle: agent.handle, name: agent.name, state: agent.state, on_this_device: agent.on_this_device, revision: agent.revision ?? null, permissions: null, unknown_permissions: [] };
      try {
        const permissions = await readPermissions(session, agent.agent_id);
        const described = describePermissions(permissions);
        entry.revision = permissions.revision;
        entry.permissions = described.known;
        entry.unknown_permissions = described.unknown;
      } catch (error) {
        if (!(error instanceof MeshApiError)) throw error;
        model.errors.push({ agent_id: agent.agent_id, code: error.code, message: error.message });
      }
      model.agents.push(entry);
    }
  } catch (error) {
    if (!(error instanceof MeshApiError)) throw error;
    model.errors.push({ code: error.code, message: error.message });
  }
  return model;
}
