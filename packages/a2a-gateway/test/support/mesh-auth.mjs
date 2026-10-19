// Test-only workload credential for the gateway (permissions v1).
import crypto from "node:crypto";

export const TEST_WORKLOAD_ENV = Object.freeze({
  MESH_WORKLOAD_ID: "workload_77777777777777777777777777777777",
  MESH_WORKLOAD_PRIVATE_KEY: crypto.createHash("sha256").update("gateway test key").digest("base64url"),
});

/** A meshAuth that skips the token exchange: every call carries `Bearer <token>` + a DPoP marker. */
export function testMeshAuth(token = "mesh_gateway_agent_secret") {
  const auth = {
    calls: [],
    async headers(method, url, { refresh = false } = {}) {
      auth.calls.push({ method, url, refresh });
      return { authorization: `Bearer ${token}`, dpop: `test-dpop.${method}` };
    },
    async agentId() { return null; },
    secrets: [],
  };
  return auth;
}
