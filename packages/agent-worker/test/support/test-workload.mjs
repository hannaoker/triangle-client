// Test-only workload credential for the permissions-v1 mailbox client. The key
// is a fixed throwaway Ed25519 seed; it is not registered anywhere.
import crypto from "node:crypto";

const SEED = Buffer.alloc(32, 7).toString("base64url");

export const TEST_WORKLOAD = Object.freeze({
  workloadId: "workload_77777777777777777777777777777777",
  workloadPrivateKey: SEED,
});

/**
 * A token source that skips the MESH token exchange, so a fake transport sees
 * only the mailbox calls under test. Every request carries `Bearer <token>`
 * and a DPoP header; `refreshes` counts forced re-exchanges after a 401.
 */
export function testTokens(token = "mesh-secret", { next = [] } = {}) {
  const queue = [...next];
  let current = token;
  const source = {
    refreshes: 0,
    async fetchToken(_signal, { refresh = false } = {}) {
      if (refresh) {
        source.refreshes += 1;
        if (queue.length) current = queue.shift();
      }
      return current;
    },
    createDpopProof(method, url) {
      return `test-dpop.${method}.${crypto.createHash("sha256").update(url).digest("base64url").slice(0, 16)}`;
    },
    invalidate() {},
  };
  return source;
}

/** A distinct, valid workload key seed per label (sha256 → 43-char base64url). */
export function testKey(label) {
  return crypto.createHash("sha256").update(String(label)).digest("base64url");
}
