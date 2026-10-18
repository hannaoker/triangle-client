// An in-process fake MESH v1 authority used as `fetchImpl`. It verifies every
// signature with its own (independent) canonicalization, so a client signing
// bug fails these tests rather than only the live server.
import crypto from "node:crypto";

const enc = (value) => {
  if (Array.isArray(value)) return `[${value.map(enc).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${enc(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const b64urlJson = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const hex = (n = 16) => crypto.randomBytes(n).toString("hex");
const thumb = (jwk) => crypto.createHash("sha256").update(enc({ crv: "Ed25519", kty: "OKP", x: jwk.x })).digest("base64url");
function verify(jwk, bytes, sig) {
  const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
  return crypto.verify(null, Buffer.from(bytes), key, Buffer.from(sig, "base64url"));
}
function verifyJws(compact, jwk) {
  const [h, p, s] = compact.split(".");
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  // Strict: header and payload must be canonical JSON sources.
  if (Buffer.from(h, "base64url").toString() !== enc(header) || Buffer.from(p, "base64url").toString() !== enc(payload)) return null;
  return verify(jwk ?? header.jwk, `${h}.${p}`, s) ? { header, payload } : null;
}

export function createFakeAuthority({ authority = "https://mesh.test", transportBase = authority } = {}) {
  const state = {
    owners: new Map(),
    extraCatalogKeys: [], // simulate a newer server catalog
    controllers: new Map(), // id -> {owner_id, jwk, jkt, state, device_label}
    invites: new Map(), // id -> {kind, secret_hash, role, target_owner_id, redeemed_hash, result}
    challenges: new Map(),
    agents: new Map(), // id -> {owner_id, handle, name, state, permissions, revision, workload}
    workloads: new Map(), // workload_id -> {agent_id, jwk, bounds}
    receipts: new Map(),
    tokens: new Map(),
    jtis: new Set(),
    requests: [],
    failNext: null, // "network" | 500 for the next mutating request to a path matching failPath
    failPath: null,
    dropAfterCommit: false,
  };

  function json(status, body, headers = {}) {
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }
  const err = (status, error, extra = {}) => json(status, { error, message: error, ...extra });

  function mintInvite({ kind = "bootstrap", role = "admin", target_owner_id = null, issuer = null } = {}) {
    const id = `invite_${hex()}`;
    const secret = crypto.randomBytes(32).toString("base64url");
    state.invites.set(id, { kind, role, target_owner_id, issuer, secret_hash: sha256hex(secret) });
    return { id, secret, link: `${authority}/join#${id}.${secret}` };
  }

  // Returns the controller, null (401), or FORBIDDEN (valid proof from a pending/revoked device → 403).
  const FORBIDDEN = Symbol("forbidden");
  const ownerGate = (c) => (c === FORBIDDEN ? err(403, "owner_forbidden") : c ? null : err(401, "owner_auth_required"));

  function ownerFromProof(request, method, path) {
    const proof = request.headers.get("mesh-owner-proof");
    if (!proof) return null;
    const header = b64urlJson(proof.split(".")[0]);
    const controller = state.controllers.get(header.kid);
    if (!controller) return null;
    const verified = verifyJws(proof, controller.jwk);
    if (!verified || verified.header.typ !== "mesh-owner-request+jwt") return null;
    const { payload } = verified;
    const htp = path + new URL(request.url).search;
    if (payload.authority !== authority || payload.htm !== method || payload.htp !== htp || state.jtis.has(payload.jti)) return null;
    if (Math.abs(payload.iat - Date.now() / 1000) > 120) return null;
    state.jtis.add(payload.jti);
    if (controller.state !== "active") return FORBIDDEN;
    return { id: header.kid, ...controller };
  }

  function workloadFromRequest(request, method, url) {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const record = token && state.tokens.get(token);
    if (!record) return null;
    const workload = state.workloads.get(record.workload_id);
    const dpop = request.headers.get("dpop");
    const verified = dpop && verifyJws(dpop);
    if (!verified || verified.header.typ !== "dpop+jwt" || thumb(verified.header.jwk) !== thumb(workload.jwk)) return null;
    const p = verified.payload;
    const ath = crypto.createHash("sha256").update(token, "ascii").digest("base64url");
    if (p.htm !== method || p.htu !== url || p.ath !== ath || state.jtis.has(p.jti)) return null;
    state.jtis.add(p.jti);
    return { ...record, workload };
  }

  function permissionsView(agentId) {
    const agent = state.agents.get(agentId);
    return { agent_id: agentId, agent_state: agent.state, permissions_version: 1, permissions: agent.permissions, revision: agent.revision };
  }

  function provision(ownerId, draft) {
    if ([...state.agents.values()].some((a) => a.handle === draft.handle)) return { error: err(409, "handle_unavailable") };
    const agentId = `agent_${hex()}`;
    const workloadId = `workload_${hex()}`;
    state.agents.set(agentId, { owner_id: ownerId, handle: draft.handle, name: draft.name, state: "active", permissions: draft.permissions, revision: 1, history: [{ revision: 1, previous: null, next: draft.permissions, controller_id: null, device_label: null, created_at: new Date().toISOString() }] });
    state.workloads.set(workloadId, { agent_id: agentId, jwk: draft.workload_public_jwk, bounds: draft.bounds });
    return { agent: { agent_id: agentId, handle: draft.handle, name: draft.name, description: draft.description, state: "active", permissions: draft.permissions, revision: 1, workload: { workload_id: workloadId, jkt: thumb(draft.workload_public_jwk), bounds: draft.bounds } } };
  }

  async function handle(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    if (url.origin !== transportBase) return err(421, "wrong_host");
    const raw = method === "GET" ? "" : await request.text();
    const body = raw ? JSON.parse(raw) : null;
    state.requests.push({ method, path, headers: Object.fromEntries(request.headers), body });
    if (state.failNext && method !== "GET" && (!state.failPath || state.failPath.test(path))) {
      const mode = state.failNext;
      state.failNext = null;
      if (mode === "network") throw new TypeError("fetch failed");
      if (mode === "drop-after-commit") state.dropAfterCommit = true;
      else return err(mode, "operation_unavailable");
    }
    const finish = (response) => {
      if (state.dropAfterCommit) { state.dropAfterCommit = false; throw new TypeError("fetch failed"); }
      return response;
    };
    let m;
    if (method === "GET" && path === "/api/v1/authority") return json(200, { authority: state.servedAuthority ?? authority, permissions_version: 1 });
    if (method === "POST" && (m = /^\/api\/v1\/invites\/(invite_[0-9a-f]{32})\/challenges$/.exec(path))) {
      const id = `invite_challenge_${hex()}`;
      const nonce = crypto.randomBytes(32).toString("base64url");
      state.challenges.set(id, { invite_id: m[1], nonce_sha256: sha256hex(nonce), used: false });
      return json(201, { challenge_id: id, invite_id: m[1], authority, nonce, nonce_sha256: sha256hex(nonce) });
    }
    if (method === "POST" && (m = /^\/api\/v1\/invites\/(invite_[0-9a-f]{32})\/redeem$/.exec(path))) {
      const requestHash = sha256hex(enc(body));
      const receipt = state.receipts.get(`${m[1]}:${requestHash}`);
      if (receipt) return finish(json(200, { outcome: "replayed", result: receipt }));
      const challenge = state.challenges.get(body.challenge_id);
      const invite = state.invites.get(m[1]);
      if (!challenge || challenge.used || !invite) return err(401, "invite_invalid");
      const message = enc({ agent: body.agent, authority: body.authority, challenge_id: body.challenge_id, device_label: body.device_label, display_name: body.display_name, invite_id: body.invite_id, invite_secret_sha256: sha256hex(body.invite_secret), nonce_sha256: challenge.nonce_sha256, owner_public_jwk: body.owner_public_jwk, profile: body.profile });
      if (!verify(body.owner_public_jwk, message, body.owner_proof)) return err(401, "invite_invalid");
      if (body.agent && !verify(body.agent.workload_public_jwk, message, body.workload_proof)) return err(401, "invite_invalid");
      if (invite.secret_hash !== sha256hex(body.invite_secret) || body.authority !== authority) return err(401, "invite_invalid");
      if (invite.redeemed_hash) return err(409, "invite_already_redeemed");
      if (invite.kind === "device" && (body.agent !== null || body.display_name !== null)) return json(400, { error: "invalid_request", message: "A device invite adds a device only: agent and display_name must be null." });
      challenge.used = true;
      const ownerId = invite.kind === "device" ? invite.target_owner_id : `owner_${hex()}`;
      if (invite.kind !== "device") state.owners.set(ownerId, { id: ownerId, display_name: body.display_name, role: invite.role, state: "active" });
      const controllerId = `controller_${hex()}`;
      const jkt = thumb(body.owner_public_jwk);
      const cstate = invite.kind === "device" ? "pending_approval" : "active";
      state.controllers.set(controllerId, { owner_id: ownerId, jwk: body.owner_public_jwk, jkt, state: cstate, device_label: body.device_label, kind: "device-owner" });
      let agent = null;
      if (body.agent) {
        const provisioned = provision(ownerId, body.agent);
        if (provisioned.error) return provisioned.error;
        agent = provisioned.agent;
      }
      const result = { authority, owner_id: ownerId, owner_role: invite.kind === "device" ? null : invite.role, controller: { controller_id: controllerId, jkt, fingerprint: jkt.slice(0, 16).toUpperCase().match(/.{4}/g).join("-"), device_label: body.device_label, state: cstate }, agent };
      invite.redeemed_hash = requestHash;
      state.receipts.set(`${m[1]}:${requestHash}`, result);
      return finish(json(201, { outcome: "applied", result }));
    }
    if (method === "GET" && path === "/api/v1/owners/me") {
      const c = ownerFromProof(request, method, path);
      if (ownerGate(c)) return ownerGate(c);
      return json(200, {
        authority,
        owner: state.owners.get(c.owner_id),
        calling_controller_id: c.id,
        controllers: [...state.controllers].filter(([, v]) => v.owner_id === c.owner_id).map(([id, v]) => ({ controller_id: id, kind: v.kind, jkt: v.jkt, device_label: v.device_label, state: v.state })),
        agents: [...state.agents].filter(([, v]) => v.owner_id === c.owner_id && v.state !== "deleted").map(([id, v]) => ({ agent_id: id, handle: v.handle, name: v.name, state: v.state, revision: v.revision })),
      });
    }
    if (method === "POST" && path === "/api/v1/owners/me/challenges") {
      const c = ownerFromProof(request, method, path);
      if (ownerGate(c)) return ownerGate(c);
      const id = `owner_challenge_${hex()}`;
      const nonce = crypto.randomBytes(32).toString("base64url");
      state.challenges.set(id, { controller_id: c.id, operation: body.operation, target: body.target, nonce_sha256: sha256hex(nonce), used: false });
      return json(201, { challenge_id: id, operation: body.operation, target: body.target, authority, controller_id: c.id, nonce, nonce_sha256: sha256hex(nonce) });
    }
    const opRoutes = [
      [/^\/api\/v1\/agents$/, "agent.create"],
      [/^\/api\/v1\/agents\/(agent_[0-9a-f]{32})\/pause$/, "agent.pause"],
      [/^\/api\/v1\/agents\/(agent_[0-9a-f]{32})\/resume$/, "agent.resume"],
      [/^\/api\/v1\/agents\/(agent_[0-9a-f]{32})$/, "agent.delete"],
      [/^\/api\/v1\/invites$/, "invite.create"],
      [/^\/api\/v1\/invites\/(invite_[0-9a-f]{32})\/revoke$/, "invite.revoke"],
      [/^\/api\/v1\/owners\/me\/devices\/([A-Za-z0-9_-]{43})\/approve$/, "owner.device.approve"],
      [/^\/api\/v1\/owners\/me\/devices\/([A-Za-z0-9_-]{43})\/revoke$/, "owner.device.revoke"],
    ];
    for (const [pattern, operation] of opRoutes) {
      if (!(m = pattern.exec(path))) continue;
      // Real method per route: DELETE /agents/:id; everything else POST (a wrong method is a 404 on Vercel).
      if (method !== (operation === "agent.delete" ? "DELETE" : "POST")) continue;
      const key = `op:${body.controller_id}:${body.idempotency_key}`;
      const requestHash = sha256hex(enc(body));
      const prior = state.receipts.get(key);
      if (prior) return finish(prior.hash === requestHash ? json(200, { outcome: "replayed", result: prior.result }) : err(409, "idempotency_conflict"));
      const challenge = state.challenges.get(body.challenge_id);
      const controller = state.controllers.get(body.controller_id);
      if (!challenge || challenge.used || !controller || controller.state !== "active" || body.operation !== operation || challenge.operation !== operation || (m[1] ?? null) !== body.target) return err(401, "owner_auth_required");
      const message = enc({ authority: body.authority, challenge_id: body.challenge_id, controller_id: body.controller_id, idempotency_key: body.idempotency_key, nonce_sha256: challenge.nonce_sha256, operation: body.operation, params: body.params, profile: body.profile, target: body.target });
      if (!verify(controller.jwk, message, body.proof)) return err(401, "owner_auth_required");
      if (operation === "agent.create" && !verify(body.params.workload_public_jwk, message, body.workload_proof)) return err(401, "owner_auth_required");
      challenge.used = true;
      let result;
      if (operation === "agent.create") {
        const provisioned = provision(controller.owner_id, body.params);
        if (provisioned.error) return provisioned.error;
        result = provisioned.agent;
      } else if (operation === "agent.pause" || operation === "agent.resume") {
        const agent = state.agents.get(body.target);
        agent.state = operation === "agent.pause" ? "paused" : "active";
        result = { agent_id: body.target, state: agent.state };
      } else if (operation === "agent.delete") {
        state.agents.get(body.target).state = "deleted";
        result = { agent_id: body.target, state: "deleted" };
      } else if (operation === "invite.create") {
        const id = `invite_${hex()}`;
        state.invites.set(id, { kind: body.params.kind, role: body.params.role, target_owner_id: body.params.kind === "device" ? controller.owner_id : null, secret_hash: body.params.secret_sha256 });
        result = { invite_id: id, kind: body.params.kind, role: body.params.role, expires_at: new Date(Date.now() + 900_000).toISOString() };
      } else if (operation === "invite.revoke") {
        state.invites.delete(body.target);
        result = { invite_id: body.target, state: "revoked" };
      } else if (operation === "owner.device.approve" || operation === "owner.device.revoke") {
        const entry = [...state.controllers].find(([, v]) => v.jkt === body.target && v.owner_id === controller.owner_id);
        if (!entry) return err(404, "not_found");
        if (operation === "owner.device.approve" && entry[1].state !== "pending_approval") return err(409, "state_conflict");
        if (operation === "owner.device.revoke") {
          const active = [...state.controllers.values()].filter((v) => v.owner_id === controller.owner_id && v.state === "active").length;
          if (entry[1].state === "revoked") return err(409, "state_conflict");
          if (entry[1].state === "active" && active <= 1) return err(409, "last_controller");
        }
        entry[1].state = operation === "owner.device.approve" ? "active" : "revoked";
        result = { controller_id: entry[0], jkt: body.target, state: entry[1].state };
      }
      state.receipts.set(key, { hash: requestHash, result });
      return finish(json(operation === "agent.create" || operation === "invite.create" ? 201 : 200, { outcome: "applied", result }));
    }
    if ((m = /^\/api\/v1\/agents\/(agent_[0-9a-f]{32})\/permissions(\/challenges|\/history)?$/.exec(path)) && !(method === "POST" && !m[2])) {
      const c = ownerFromProof(request, method, path);
      const agent = state.agents.get(m[1]);
      if (ownerGate(c)) return ownerGate(c);
      if (!agent || agent.owner_id !== c.owner_id || agent.state === "deleted") return err(404, "agent_not_found");
      const etag = `W/"${agent.revision}"`;
      if (method === "GET" && !m[2]) {
        if ((request.headers.get("if-none-match") ?? "").split(",").map((s) => s.trim()).includes(etag)) return new Response(null, { status: 304, headers: { etag: etag.replace(/^W\//, "") } }); // like Vercel: W/ dropped on 304
        return json(200, permissionsView(m[1]), { etag });
      }
      if (method === "GET" && m[2] === "/history") {
        const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
        return json(200, { agent_id: m[1], entries: [...agent.history].reverse().slice(0, limit) });
      }
      if (method === "POST" && m[2] === "/challenges") {
        const id = `owner_challenge_${hex()}`;
        const nonce = crypto.randomBytes(32).toString("base64url");
        state.challenges.set(id, { controller_id: c.id, agent_id: m[1], nonce_sha256: sha256hex(nonce), used: false });
        return json(201, { challenge_id: id, operation: "agent.permissions.update", agent_id: m[1], authority, controller_id: c.id, current_revision: agent.revision, nonce, nonce_sha256: sha256hex(nonce) });
      }
    }
    if (method === "POST" && (m = /^\/api\/v1\/agents\/(agent_[0-9a-f]{32})\/permissions$/.exec(path))) {
      const agent = state.agents.get(m[1]);
      const key = `perm:${body.controller_id}:${body.idempotency_key}`;
      const prior = state.receipts.get(key);
      if (prior) return finish(json(200, { ...prior, outcome: "replayed" }));
      const challenge = state.challenges.get(body.challenge_id);
      const controller = state.controllers.get(body.controller_id);
      if (!challenge || challenge.used || !controller || controller.state !== "active") return err(401, "owner_auth_required");
      const message = enc({ agent_id: body.agent_id, authority: body.authority, challenge_id: body.challenge_id, controller_id: body.controller_id, expected_revision: body.expected_revision, idempotency_key: body.idempotency_key, nonce_sha256: challenge.nonce_sha256, permissions: body.permissions, profile: body.profile });
      if (!verify(controller.jwk, message, body.proof)) return err(401, "owner_auth_required");
      challenge.used = true;
      const expectedKeys = ["permissions_version", "dm.receive", "dm.send", "posts.publish", "tasks.claim", "directory.listed", ...state.extraCatalogKeys].sort();
      const sentKeys = Object.keys(body.permissions ?? {}).sort();
      if (sentKeys.join() !== expectedKeys.join() || sentKeys.some((k) => k !== "permissions_version" && typeof body.permissions[k] !== "boolean")) return err(400, "invalid_permissions");
      if (body.expected_revision !== agent.revision) return err(409, "revision_conflict", { current_revision: agent.revision });
      agent.history.push({ revision: agent.revision + 1, previous: agent.permissions, next: body.permissions, controller_id: body.controller_id, device_label: controller.device_label, created_at: new Date().toISOString() });
      agent.permissions = body.permissions;
      agent.revision += 1;
      const response = { ...permissionsView(m[1]), outcome: "applied", updated_by: { controller_id: body.controller_id, device_label: controller.device_label }, receipt: { id: `receipt_${hex()}`, controller_id: body.controller_id } };
      state.receipts.set(key, response);
      return finish(json(200, response, { etag: `W/"${agent.revision}"` }));
    }
    if (method === "POST" && path === "/api/v1/identity/token-challenges") {
      const workload = state.workloads.get(body.workload_id);
      if (!workload) return err(401, "workload_identity_invalid");
      const id = `identity_challenge_${hex()}`;
      const nonce = crypto.randomBytes(32).toString("base64url");
      state.challenges.set(id, { workload_id: body.workload_id, nonce, used: false });
      return json(201, { challenge: { challenge_id: id, workload_id: body.workload_id, principal_id: workload.agent_id, audience: "mesh-test-audience", nonce, expires_at: new Date(Date.now() + 60_000).toISOString() } });
    }
    if (method === "POST" && path === "/api/v1/identity/tokens") {
      const challenge = state.challenges.get(body.challenge_id);
      if (!challenge || challenge.used) return err(401, "invalid_workload_proof");
      const workload = state.workloads.get(challenge.workload_id);
      const verified = verifyJws(body.proof, workload.jwk);
      const p = verified?.payload;
      if (!p || verified.header.typ !== "mesh-workload-proof+jwt" || verified.header.kid !== challenge.workload_id || p.nonce !== challenge.nonce || p.challenge_id !== body.challenge_id || p.profile !== "mesh.workload-token-proof/1" || enc(p.requested_scopes) !== enc(body.requested_scopes) || !body.requested_scopes.every((s) => workload.bounds.includes(s))) return err(401, "invalid_workload_proof");
      challenge.used = true;
      const token = `at_${hex(24)}`;
      state.tokens.set(token, { workload_id: challenge.workload_id, agent_id: workload.agent_id, scopes: body.requested_scopes });
      return json(200, { access_token: token, token_type: "DPoP", expires_in: 300 });
    }
    if (path === "/api/v1/agents/me" && method === "GET") {
      const wl = workloadFromRequest(request, method, new URL(request.url).toString());
      if (!wl) return err(401, "agent_auth_required");
      const agent = state.agents.get(wl.agent_id);
      if (agent.state === "paused") return json(200, { agent: { id: wl.agent_id, state: "paused" }, permissions: agent.permissions, revision: agent.revision });
      return json(200, { agent: { id: wl.agent_id, handle: agent.handle, state: agent.state }, permissions: agent.permissions, revision: agent.revision });
    }
    if (path === "/api/v1/posts" && method === "POST") {
      const wl = workloadFromRequest(request, method, new URL(request.url).toString());
      if (!wl) return err(401, "agent_auth_required");
      const agent = state.agents.get(wl.agent_id);
      if (agent.state === "paused") return err(403, "agent_paused");
      if (!wl.scopes.includes("agent.write")) return err(403, "insufficient_scope");
      if (!agent.permissions["posts.publish"]) return err(403, "permission_denied", { permission: "posts.publish" });
      return json(201, { post: { id: `post_${hex()}` } });
    }
    return err(404, "not_found");
  }

  async function fetchImpl(input, init = {}) {
    const request = input instanceof Request ? input : new Request(input, init);
    return handle(request);
  }

  return { authority, state, mintInvite, fetchImpl };
}
