# R2 local reply identity contract — first library slice

This is a pure library foundation, not a deployed R2 implementation. No production entrypoint imports it; no manifest, credential, registry, journal or installed configuration changes occur.

The local router currently accepts both owner-mapped profiles and unbound chat addresses. A null principal is not a stable identity. For local-only reply routes, the proposed host-journal key is `(local-socket, exact authenticated remote address, requestId)`. This is an explicit local extension of the identity design's `(remote principal, requestId)` key, preventing unrelated unbound sessions from colliding. It must not be reused as remote authority or a cross-machine address.

`createLocalReplyRoute` pins an interactive local session address, authenticated remote address, their nullable principal+authority-origin associations, session generations, and principal-binding generations. `verifyLocalReplyRoute` permits generation advances for the same exact identities, rejects regression and cross-session/principal/origin reassignment, and returns a new route. The caller must durably compare/update this route transactionally with reply admission. Offline/missing identity observations fail rather than select another active chat. No migration/owner-transfer mechanism is implemented.

`createLocalSenderProvenance` projects only explicit receiver-supplied authenticated observations. It does **not authenticate them**. Future server integration must verify credential HMAC, expiry, active attachment/generation and current registry binding before calling it; never construct these inputs from message metadata. Local assurance remains local-attested, with mapped principal association labeled owner-mapped-disk-observation. No live MESH verification, signatures or remote trust mode is implied. Unbound principal/authority/binding generation stay null, while the sender session generation remains explicit.

Tests cover distinct unbound senders with equal request IDs, same-session generation renewal through JSON serialization, cross-session/principal/origin denial, missing/offline observations, transport/key mismatch, malformed identity, input immutability and exclusion of arbitrary payload metadata. Serialization is not durable journal/restart acceptance. The installed v13 product is unchanged.

## Next integration slice

1. Receiver-side construction from actual authenticated broker/registry state; validate claimed bindings without upgrading disk observations into server verification.
2. Additive durable reply-route storage and atomic generation advancement with reply admission; duplicates and crash recovery must preserve original route identity.
3. Filter reserved provenance fields at every public/native boundary and expose receiver-built provenance through an explicit DTO contract.
4. Actual old/new journal compatibility, revoked/stale-binding denial and live Codex/Claude canaries. Decide manifest closure/version changes together with production wiring, never land an incomplete bundle.

Remote Iroh/MESH provenance, peer principals, cross-mode transfers, new-session launching and explicit session transfer remain deferred. No R2 installed or end-to-end claim follows from this library.
