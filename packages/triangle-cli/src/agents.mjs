// Owner-created agents (§3.5): the device owner key signs `agent.create`, and
// the new workload key proves possession in the same request.
import { generateEd25519 } from "./keys.mjs";
import { agentDraft, AGENT_BOUNDS, DEFAULT_PERMISSIONS } from "./protocol.mjs";

export async function addAgent(session, { handle, name, description = "", readOnly = false, permissions = DEFAULT_PERMISSIONS }) {
  return session.custody.withLock(async () => {
    const workloadKey = generateEd25519();
    const draft = agentDraft({ handle, name, description, permissions, bounds: readOnly ? ["agent.read"] : AGENT_BOUNDS, workloadKey });
    const response = await session.ownerOperation("agent.create", null, draft, { workloadKey });
    return response.result;
  });
}

/** Server view (GET /owners/me) joined with which agents have a workload key on this device. */
export async function listAgents(session) {
  const { body } = await session.ownerRequest("GET", "/api/v1/owners/me");
  const local = new Map(session.custody.listAgents().map((agent) => [agent.agent_id, agent]));
  return {
    owner: body.owner,
    calling_controller_id: body.calling_controller_id,
    controllers: body.controllers ?? [],
    agents: (body.agents ?? []).map((agent) => ({ ...agent, on_this_device: local.has(agent.agent_id) })),
  };
}

/** Resolve an agent argument: id, handle, or the only local agent. */
export function resolveAgent(session, ref, serverAgents = null) {
  const local = session.custody.listAgents();
  const candidates = serverAgents ?? local;
  if (!ref) {
    if (local.length === 1) return local[0].agent_id;
    throw new TypeError("Name the agent (id or handle); this device has several or none.");
  }
  const hit = candidates.find((agent) => agent.agent_id === ref || agent.handle === ref);
  if (hit) return hit.agent_id;
  if (/^agent_[0-9a-f]{32}$/.test(ref)) return ref;
  throw new TypeError(`Unknown agent ${ref}.`);
}
