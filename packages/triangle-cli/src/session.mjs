// A loaded device: custody + transport + (once joined) the owner controller.
import { LocalStateError, OutcomeUnknownError } from "./errors.mjs";
import { buildOwnerOperation, OWNER_PROOF_HEADER, ownerRequestProof } from "./protocol.mjs";
import { createTransport, loadTransportHeaders } from "./transport.mjs";
import { openCustody, defaultHome } from "./custody.mjs";
import { randomHex } from "./keys.mjs";
import { createWorkloadSession } from "./workload.mjs";

/** Where each owner operation is posted. */
export const OPERATION_PATHS = Object.freeze({
  "agent.create": () => "/api/v1/agents",
  "agent.pause": (t) => `/api/v1/agents/${t}/pause`,
  "agent.resume": (t) => `/api/v1/agents/${t}/resume`,
  "agent.delete": (t) => `/api/v1/agents/${t}`,
  "invite.create": () => "/api/v1/invites",
  "invite.revoke": (t) => `/api/v1/invites/${t}/revoke`,
  "owner.device.approve": (t) => `/api/v1/owners/me/devices/${t}/approve`,
  "owner.device.revoke": (t) => `/api/v1/owners/me/devices/${t}/revoke`,
  "admin.agent.pause": (t) => `/api/v1/admin/agents/${t}/pause`,
  "admin.agent.delete": (t) => `/api/v1/admin/agents/${t}`,
  "admin.owner.remove": (t) => `/api/v1/admin/owners/${t}/remove`,
});

export function transportOptions(env = process.env) {
  return {
    headers: loadTransportHeaders(env.TRIANGLE_TRANSPORT_HEADERS_FILE),
    allowLoopbackHttp: env.TRIANGLE_ALLOW_LOOPBACK_HTTP === "1",
  };
}

export function openSession({ home = defaultHome(), env = process.env, fetchImpl = globalThis.fetch, requireJoined = true } = {}) {
  const custody = openCustody(home);
  const authorityRecord = custody.readAuthority();
  if (!authorityRecord) {
    if (requireJoined) throw new LocalStateError(`This device has not joined a MESH yet (${custody.root}). Run \`triangle join <link>\`.`);
    return { custody, transport: null, owner: null };
  }
  const options = transportOptions(env);
  const transport = createTransport({ authority: authorityRecord.authority, via: authorityRecord.via ?? null, fetchImpl, ...options });
  const controller = custody.readController();
  const ownerKey = custody.readOwnerKey();
  if (requireJoined && (!controller || !ownerKey)) throw new LocalStateError("This device's owner state is incomplete. Run `triangle doctor`.");

  async function ownerRequest(method, path, { body, headers = {}, mutating } = {}) {
    if (controller.state !== "active") throw new LocalStateError("This device is waiting for approval from another of your devices (`triangle device approve` there).");
    const proof = ownerRequestProof({ controllerId: controller.controller_id, ownerKey, authority: transport.authority, method, url: `${transport.authority}${path}` });
    return transport.request(method, path, { body, mutating, headers: { ...headers, [OWNER_PROOF_HEADER]: proof } });
  }

  /** Local effects of a committed operation; run before the journal entry is removed. */
  function applyEffect(entry, result) {
    if (entry.operation === "agent.create") {
      const agent = result?.result;
      if (!agent?.agent_id || !agent.workload?.workload_id) throw new LocalStateError("agent.create returned no agent; keeping the journal for `triangle resume`.");
      custody.writeWorkloadKey(agent.agent_id, entry.workload_key);
      custody.writeAgent(agent.agent_id, {
        agent_id: agent.agent_id,
        handle: agent.handle,
        name: agent.name,
        workload_id: agent.workload.workload_id,
        bounds: agent.workload.bounds,
        authority: transport.authority,
        created_at: new Date().toISOString(),
      });
    }
  }

  async function sendJournaled(name, entry) {
    let response;
    try {
      response = await transport.request("POST", entry.path, { body: entry.body });
    } catch (error) {
      if (error instanceof OutcomeUnknownError) {
        error.resumeHint = "triangle resume";
      } else {
        custody.removeJournal(name);
      }
      throw error;
    }
    applyEffect(entry, response.body);
    custody.removeJournal(name);
    return response;
  }

  /**
   * Challenge → sign → persist → send. The signed body (and any new workload
   * key) is written 0600 before it is sent, so an unknown outcome is resolved by
   * replaying the identical request (`triangle resume`), which the server
   * answers from its receipt. Keys are never regenerated on retry.
   */
  async function ownerOperation(operation, target, params, { workloadKey = null } = {}) {
    const { body: challenge } = await ownerRequest("POST", "/api/v1/owners/me/challenges", { body: { operation, target }, mutating: false });
    const body = buildOwnerOperation({ authority: transport.authority, controllerId: controller.controller_id, ownerKey, challenge, params, workloadKey });
    const name = `op-${body.idempotency_key}`;
    const entry = {
      kind: "owner-operation",
      operation,
      target,
      path: OPERATION_PATHS[operation](target),
      body,
      created_at: new Date().toISOString(),
      ...(workloadKey ? { workload_key: workloadKey } : {}),
    };
    custody.writeJournal(name, entry);
    const response = await sendJournaled(name, entry);
    return response.body;
  }

  /** Replay one stored owner operation exactly as signed. */
  async function replayOperation(name) {
    const entry = custody.readJournal(name);
    if (!entry || entry.kind !== "owner-operation") throw new LocalStateError(`No pending operation ${name}.`);
    const response = await sendJournaled(name, entry);
    return { entry, result: response.body };
  }

  function workloadSession(agentId, { scopes } = {}) {
    const agent = custody.readAgent(agentId);
    const workloadKey = custody.readWorkloadKey(agentId);
    if (!agent || !workloadKey) throw new LocalStateError(`No workload key for ${agentId} on this device.`);
    return createWorkloadSession({ transport, workloadId: agent.workload_id, workloadKey, scopes });
  }

  return {
    custody,
    transport,
    owner: controller ? { ...controller, key: ownerKey } : null,
    ownerRequest,
    ownerOperation,
    replayOperation,
    workloadSession,
    newIdempotencyKey: () => `idem_${randomHex(12)}`,
  };
}
