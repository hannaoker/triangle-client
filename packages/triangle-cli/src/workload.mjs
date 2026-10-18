// Workload identity (§4.2): exchange a challenge signed by the agent's workload
// key for a short-lived DPoP-bound access token, then sign a DPoP proof per
// request. This replaces every permanent `mesh_` bearer in the client.
import crypto from "node:crypto";

import { MeshApiError } from "./errors.mjs";
import { compactJws, publicJwk } from "./keys.mjs";
import { AGENT_BOUNDS, WORKLOAD_TOKEN_PROOF_PROFILE } from "./protocol.mjs";

/**
 * DPoP proof with canonical JSON. MESH binds `htu` to the full request URL
 * (scheme, host, path and query; no fragment), compared after WHATWG URL
 * serialization, so the proof is valid for exactly one request target.
 */
export function dpopProof({ workloadKey, method, url, accessToken, now = Date.now() }) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.hash) throw new TypeError("Invalid DPoP URL");
  const htu = parsed.toString();
  return compactJws(
    { alg: "EdDSA", jwk: publicJwk(workloadKey), typ: "dpop+jwt" },
    {
      ath: crypto.createHash("sha256").update(accessToken, "ascii").digest("base64url"),
      htm: method.toUpperCase(),
      htu,
      iat: Math.floor(now / 1000),
      jti: `proof_${crypto.randomBytes(16).toString("hex")}`,
    },
    workloadKey,
  );
}

/**
 * A workload session over a transport. `scopes` must be a subset of the
 * workload's registered bounds; the default asks for both.
 */
export function createWorkloadSession({ transport, workloadId, workloadKey, scopes = AGENT_BOUNDS, now = () => Date.now() }) {
  const requested = AGENT_BOUNDS.filter((scope) => scopes.includes(scope));
  if (!requested.length) throw new TypeError("at least one workload scope is required");
  let cached = null;
  let inflight = null;

  async function exchange() {
    const { body: challengeBody } = await transport.request("POST", "/api/v1/identity/token-challenges", { body: { workload_id: workloadId }, mutating: false });
    const challenge = challengeBody?.challenge;
    if (!challenge?.challenge_id || !challenge.nonce || !challenge.principal_id || !challenge.audience) {
      throw new MeshApiError({ status: 200, code: "invalid_token_challenge", serverMessage: "The MESH server returned an unusable token challenge." });
    }
    const proof = compactJws(
      { alg: "EdDSA", kid: workloadId, typ: "mesh-workload-proof+jwt" },
      {
        audience: challenge.audience,
        challenge_id: challenge.challenge_id,
        nonce: challenge.nonce,
        principal_id: challenge.principal_id,
        profile: WORKLOAD_TOKEN_PROOF_PROFILE,
        requested_scopes: requested,
        workload_id: workloadId,
      },
      workloadKey,
    );
    const { body } = await transport.request("POST", "/api/v1/identity/tokens", {
      body: { challenge_id: challenge.challenge_id, proof, requested_scopes: requested },
      mutating: false,
    });
    if (typeof body?.access_token !== "string" || body.token_type !== "DPoP") {
      throw new MeshApiError({ status: 200, code: "invalid_token_response", serverMessage: "The MESH server returned an unusable access token." });
    }
    const lifetime = Number.isSafeInteger(body.expires_in) && body.expires_in > 0 ? body.expires_in : 300;
    cached = { token: body.access_token, expiresAt: now() + lifetime * 1000, principalId: challenge.principal_id };
    return cached;
  }

  async function token({ refresh = false } = {}) {
    if (!refresh && cached && cached.expiresAt - 30_000 > now()) return cached;
    inflight ??= exchange().finally(() => { inflight = null; });
    return inflight;
  }

  /** One WL-authenticated request; a single retry with a fresh token after 401. */
  async function request(method, path, options = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const { token: accessToken } = await token({ refresh: attempt > 0 });
      try {
        return await transport.request(method, path, {
          ...options,
          headers: {
            ...(options.headers ?? {}),
            authorization: `Bearer ${accessToken}`,
            dpop: dpopProof({ workloadKey, method, url: transport.url(path), accessToken }),
          },
        });
      } catch (error) {
        if (attempt === 0 && error instanceof MeshApiError && error.status === 401 && error.code !== "peer_token_invalid") {
          cached = null;
          continue;
        }
        throw error;
      }
    }
  }

  return Object.freeze({ workloadId, token, request });
}
