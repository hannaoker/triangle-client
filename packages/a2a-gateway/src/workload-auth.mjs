// Gateway → MESH authentication for permissions v1 (§5.8): the gateway is an
// agent like any other and authenticates with its workload key (a deployment
// secret) via the shared triangle-cli core: a short-lived DPoP-bound access
// token plus a fresh DPoP proof per request. No `mesh_` bearer.
import crypto from "node:crypto";

import { assertPrivateJwk, compactJws } from "../../triangle-cli/src/keys.mjs";
import { AGENT_BOUNDS, WORKLOAD_ID, WORKLOAD_TOKEN_PROOF_PROFILE } from "../../triangle-cli/src/protocol.mjs";
import { dpopProof } from "../../triangle-cli/src/workload.mjs";

const SEED = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

export class WorkloadAuthError extends Error {
  constructor(code, status) {
    super(`Workload authentication failed (${code})`);
    this.name = "WorkloadAuthError";
    this.code = code;
    this.status = status;
  }
}

/** A private Ed25519 JWK (JSON) or its 43-char base64url `d` seed. */
export function parseWorkloadKey(value) {
  const text = typeof value === "string" ? value.trim() : "";
  let jwk;
  if (SEED.test(text)) {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(text, "base64url")]),
      format: "der",
      type: "pkcs8",
    });
    jwk = { crv: "Ed25519", d: text, kty: "OKP", x: crypto.createPublicKey(privateKey).export({ format: "jwk" }).x };
  } else {
    try { jwk = JSON.parse(text); } catch { throw new TypeError("MESH_WORKLOAD_PRIVATE_KEY is invalid"); }
  }
  try { return assertPrivateJwk(jwk); } catch { throw new TypeError("MESH_WORKLOAD_PRIVATE_KEY is invalid"); }
}

async function readJson(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_TOKEN_RESPONSE_BYTES) throw new WorkloadAuthError("mesh_invalid_response", 502);
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * `headers(method, url, { refresh })` → `{ authorization, dpop }` for one
 * request to `url` (the DPoP `htu` is that full URL). Callers retry once with
 * `refresh: true` after a 401.
 */
export function createWorkloadAuth({ meshOrigin, workloadId, workloadPrivateKey, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  if (typeof workloadId !== "string" || !WORKLOAD_ID.test(workloadId)) throw new TypeError("MESH_WORKLOAD_ID is invalid");
  const key = parseWorkloadKey(workloadPrivateKey);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const scopes = [...AGENT_BOUNDS];
  let cached = null;
  let inflight = null;

  async function post(path, body, signal) {
    const response = await fetchImpl(new Request(new URL(path, `${meshOrigin}/`), {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }));
    const payload = await readJson(response);
    if (!response.ok) {
      throw new WorkloadAuthError(typeof payload?.error === "string" ? payload.error.slice(0, 64) : `http_${response.status}`, response.status >= 500 ? 503 : 502);
    }
    return payload;
  }

  async function exchange(signal) {
    const challenge = (await post("/api/v1/identity/token-challenges", { workload_id: workloadId }, signal))?.challenge;
    if (!challenge?.challenge_id || !challenge.nonce || !challenge.principal_id || !challenge.audience) {
      throw new WorkloadAuthError("mesh_invalid_response", 502);
    }
    const proof = compactJws(
      { alg: "EdDSA", kid: workloadId, typ: "mesh-workload-proof+jwt" },
      {
        audience: challenge.audience,
        challenge_id: challenge.challenge_id,
        nonce: challenge.nonce,
        principal_id: challenge.principal_id,
        profile: WORKLOAD_TOKEN_PROOF_PROFILE,
        requested_scopes: scopes,
        workload_id: workloadId,
      },
      key,
    );
    const token = await post("/api/v1/identity/tokens", { challenge_id: challenge.challenge_id, proof, requested_scopes: scopes }, signal);
    if (typeof token?.access_token !== "string" || token.token_type !== "DPoP") throw new WorkloadAuthError("mesh_invalid_response", 502);
    const lifetime = Number.isSafeInteger(token.expires_in) && token.expires_in > 0 ? token.expires_in : 300;
    cached = { token: token.access_token, expiresAt: now() + lifetime * 1000, agentId: challenge.principal_id };
    return cached;
  }

  async function accessToken({ refresh = false, signal } = {}) {
    if (!refresh && cached && cached.expiresAt - 30_000 > now()) return cached;
    if (refresh) cached = null;
    inflight ??= exchange(signal).finally(() => { inflight = null; });
    return inflight;
  }

  async function headers(method, url, { refresh = false, signal } = {}) {
    const { token } = await accessToken({ refresh, signal });
    return { authorization: `Bearer ${token}`, dpop: dpopProof({ workloadKey: key, method, url: String(url), accessToken: token, now: now() }) };
  }

  /** The authenticated agent id (from the token challenge). */
  async function agentId() {
    return (await accessToken()).agentId;
  }

  return Object.freeze({ headers, agentId, secrets: Object.freeze([key.d]) });
}

/** One WL-authenticated fetch with a single fresh-token retry after 401. */
export async function workloadFetch(auth, fetchImpl, url, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  for (let attempt = 0; ; attempt += 1) {
    const auth_ = await auth.headers(method, url, { refresh: attempt > 0, signal: init.signal });
    const response = await fetchImpl(new Request(url, { ...init, method, headers: { ...(init.headers ?? {}), ...auth_ } }));
    if (response.status === 401 && attempt === 0) {
      try { await response.body?.cancel(); } catch {}
      continue;
    }
    return response;
  }
}
