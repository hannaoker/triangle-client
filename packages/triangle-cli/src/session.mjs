// A loaded device: custody + transport + (once joined) the owner controller.
import { LocalStateError, MeshApiError, OutcomeUnknownError } from "./errors.mjs";
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

/** HTTP method per owner operation (POST unless listed). Stored in the journal so a replay uses it too. */
export const OPERATION_METHODS = Object.freeze({
  "agent.delete": "DELETE",
  "admin.agent.delete": "DELETE",
});

/** 4xx statuses an intermediary can answer without the origin having refused the request. */
const AMBIGUOUS_4XX = new Set([408, 425, 429]);

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

  async function ownerRequest(method, path, { body, headers = {}, mutating, allowPending = false } = {}) {
    if (controller.state === "pending_approval" && !allowPending) await refreshController();
    if (controller.state !== "active" && !allowPending) throw new LocalStateError(`This device is waiting for approval. On one of your other devices run \`triangle device approve ${controller.fingerprint}\`.`);
    const proof = ownerRequestProof({ controllerId: controller.controller_id, ownerKey, authority: transport.authority, method, url: `${transport.authority}${path}` });
    return transport.request(method, path, { body, mutating, headers: { ...headers, [OWNER_PROOF_HEADER]: proof } });
  }

  /**
   * A device added by a device invite starts pending; once another device
   * approves it, owner reads succeed. Returns the (possibly updated) state.
   */
  async function refreshController() {
    if (!controller || controller.state !== "pending_approval") return controller?.state ?? null;
    try {
      await ownerRequest("GET", "/api/v1/owners/me", { allowPending: true });
    } catch (error) {
      if (error instanceof MeshApiError && (error.status === 403 || error.status === 401)) return controller.state;
      throw error;
    }
    controller.state = "active";
    // Atomic replace; no lock so this also works inside a locked command.
    custody.writeController({ ...custody.readController(), state: "active" });
    return controller.state;
  }

  /** Local effects of a committed operation; run before the journal entry is removed. */
  function applyEffect(entry, result) {
    if (entry.kind === "permissions-update") {
      const { outcome, receipt, ...view } = result ?? {};
      if (Number.isSafeInteger(view.revision)) custody.writeCache("permissions", entry.agent_id, { etag: `W/"${view.revision}"`, view });
      return;
    }
    if (entry.operation === "agent.delete") {
      if (custody.readAgent(entry.target)) custody.removeAgent(entry.target);
      return;
    }
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
        ...(authorityRecord.via ? { via: authorityRecord.via } : {}),
        created_at: new Date().toISOString(),
      });
    }
  }

  /**
   * Send a journaled request. The journal is removed only after the result is
   * installed locally, or when the very first send is definitively refused
   * (a 4xx before anything could have committed). A recovered (replayed) entry
   * may already have committed, so it is kept through any failure, so the
   * only copy of a new workload key is never lost; `triangle resume --abandon`
   * discards it explicitly.
   */
  async function sendJournaled(name, entry, { original = false, retain = false } = {}) {
    let response;
    try {
      response = await transport.request(entry.method ?? "POST", entry.path, { body: entry.body });
    } catch (error) {
      if (error instanceof OutcomeUnknownError) {
        error.resumeHint = "triangle resume";
        if (!entry.outcome_unknown) custody.writeJournal(name, { ...entry, outcome_unknown: true });
      } else if (original && error instanceof MeshApiError && error.status >= 400 && error.status < 500 && !AMBIGUOUS_4XX.has(error.status)) {
        // Definitive refusal of the first send, observed by this process: nothing committed.
        // 408/425/429 are excluded: a proxy in front of the authority can emit them
        // for a request the origin already accepted, so the journal (and with it the
        // only copy of a new workload key) is kept for `triangle resume`.
        custody.removeJournal(name);
      } else if (original && error instanceof MeshApiError && AMBIGUOUS_4XX.has(error.status)) {
        error.message += ` The request may have been applied; it is kept. Retry \`triangle resume\`, or discard it with \`triangle resume --abandon\`.`;
        error.resumeHint = "triangle resume";
      } else if (!original && error instanceof MeshApiError) {
        error.message += ` The earlier attempt may have been applied; its request is kept. Retry \`triangle resume\`, or discard it with \`triangle resume --abandon\`.`;
      }
      throw error;
    }
    applyEffect(entry, response.body);
    // `retain`: the caller removes the journal once it has delivered the result
    // (an invite link exists only in the journal until it has been printed).
    if (!retain) custody.removeJournal(name);
    return response;
  }

  /**
   * Challenge → sign → persist → send. The signed body (and any new workload
   * key) is written 0600 before it is sent, so an unknown outcome is resolved by
   * replaying the identical request (`triangle resume`), which the server
   * answers from its receipt. Keys are never regenerated on retry.
   */
  async function ownerOperation(operation, target, params, { workloadKey = null, extra = {}, deliver = null } = {}) {
    const { body: challenge } = await ownerRequest("POST", "/api/v1/owners/me/challenges", { body: { operation, target }, mutating: false });
    const body = buildOwnerOperation({ authority: transport.authority, controllerId: controller.controller_id, ownerKey, challenge, operation, target, params, workloadKey });
    const name = `op-${body.idempotency_key}`;
    const entry = {
      kind: "owner-operation",
      operation,
      target,
      method: OPERATION_METHODS[operation] ?? "POST",
      path: OPERATION_PATHS[operation](target),
      body,
      created_at: new Date().toISOString(),
      ...(workloadKey ? { workload_key: workloadKey } : {}),
      ...extra,
    };
    custody.writeJournal(name, entry);
    const response = await sendJournaled(name, entry, { original: true, retain: Boolean(deliver) });
    if (deliver) {
      await deliver(response.body);
      custody.removeJournal(name);
    }
    return response.body;
  }

  /** Replay one stored owner operation or permission update exactly as signed. */
  async function replayOperation(name, { retain = false } = {}) {
    const entry = custody.readJournal(name);
    if (!entry || !["owner-operation", "permissions-update"].includes(entry.kind)) throw new LocalStateError(`No pending operation ${name}.`);
    const response = await sendJournaled(name, entry, { retain });
    return { entry, result: response.body };
  }

  /** Workload session for a local agent; scopes default to (and must stay within) its registered bounds. */
  function workloadSession(agentId, { scopes } = {}) {
    const agent = custody.readAgent(agentId);
    const workloadKey = custody.readWorkloadKey(agentId);
    if (!agent || !workloadKey) throw new LocalStateError(`No workload key for ${agentId} on this device.`);
    const bounds = Array.isArray(agent.bounds) && agent.bounds.length ? agent.bounds : ["agent.read"];
    const requested = scopes ?? bounds;
    const outside = requested.filter((scope) => !bounds.includes(scope));
    if (outside.length) throw new TypeError(`${agent.handle ?? agentId} is limited to ${bounds.join(", ")}; cannot request ${outside.join(", ")}.`);
    return createWorkloadSession({ transport, workloadId: agent.workload_id, workloadKey, scopes: requested });
  }

  return {
    custody,
    transport,
    owner: controller ? { ...controller, key: ownerKey } : null,
    ownerRequest,
    ownerOperation,
    sendJournaled,
    refreshController,
    replayOperation,
    workloadSession,
    newIdempotencyKey: () => `idem_${randomHex(12)}`,
  };
}
