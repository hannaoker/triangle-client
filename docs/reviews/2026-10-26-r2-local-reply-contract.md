# R2 local reply identity contract — first library slice

This started as a pure library foundation and now includes explicit opt-in server/journal integration, exercised only in disposable tests. The installed host does not enable it. New library modules are not in the runtime import closure yet; no manifest or installed configuration changed. Journal source now includes additive nullable columns and optional reply-pin storage.

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

## Second library slice: authenticated chat adapter and durable pin operations

`authenticateAttachedLocalSender` uses the existing HMAC credential validator, requires the exact expected session address and interactive claims, then calls the existing live session broker's validateRequest. That broker is responsible for current owner policy, discovery, lease, child and generation checks. This helper is not yet called by the production server. Attached chats remain principal-null because the current registry has no session-to-profile binding contract; a similarly named profile or injected principal cannot fill that gap. Legacy bound desktop identities and worker-profile sender adaptation remain integration work.

`createLocalReplyRouteStore` receives an existing caller-owned SQLite connection and creates only the additive local_reply_routes table. It does not open another journal or own the database lifecycle. Pin creation is immutable/idempotent. `withReply` verifies current identities, calls a synchronous reply writer on the same connection, and advances generations in one BEGIN IMMEDIATE transaction; exceptions roll everything back. It must replace/refactor the journal's existing reply transaction during integration, not wrap that transaction and nest BEGIN statements. Request admission and initial pin creation are not yet one combined transaction; production wiring must make them atomic as well. Caller-supplied callbacks are trusted server code, never peer input, and may not start asynchronous or external side effects.

New tests use a real file-backed SQLite database, reopen it, verify generation persistence, reject cross-session replies before the write callback, and verify rollback after a controlled write failure. Credential tests use the real issuer/validator for signature, sender, expiry and generation rejection, with a controlled broker fixture for active-session fencing. That fixture does not prove real policy/lease integration; existing broker tests and new end-to-end integration must cover it before release.

Nothing here is imported by production entrypoints. Runtime closure/version changes, actual message-journal transaction integration, schema rollback compatibility and live Codex/Claude acceptance remain outstanding. No installation or current runtime change occurred.

## Native server/journal integration checkpoint

The server accepts an internal `replyIdentity` dependency; the journal accepts `replyRouteStoreFactory`. Both default to absent, and the installed host passes neither. `createAttachedReplyIdentity` authenticates the native credential and live broker state for attached-chat pairs, obtains the recipient's live broker observation, and constructs route/provenance itself. Other lanes remain legacy in this slice; no worker or bound-desktop principal association is guessed.

The native message journal now creates request+pin in its existing admission transaction. Its reply transaction verifies the original pin and current attachment rows, commits the reply and generation advances together, and preserves the original claim token/session. Same-session generations may advance after broker verification; old children, cross-session owners and regressions fail. Native attachment/discovery rows are rechecked under the journal transaction so a lease/child change between asynchronous broker verification and commit is rejected. A reply may remain queued for its original offline sender, with no fallback. Same-identity pin generations can also advance with new request admission in that conversation; identity reassignment remains forbidden.

Receiver-built provenance is persisted separately from message metadata and returned as an optional `senderProvenance` field. Reserved peer-supplied provenance keys are removed from metadata only for the new pinned flow; the authenticated factory determines the stored record. Existing unpinned DTOs and authentication behavior remain unchanged. Internal reply-route keys are not added to public message projections.

New tests use the actual production journal and socket server with the real HMAC issuer/validator. They cover atomic pin/request rollback, reply-insert failure rollback, database reopen, native claim token preservation, same-chat renewal, an old child, a simulated attachment change after broker validation, original-sender offline queueing and receiver-built provenance despite forged metadata. The socket test uses a controlled policy-broker fixture plus real discovery/attachment tables; existing workspace-broker tests remain distinct evidence. The broader local-message/R1/packaging run passes 217 tests.

### Remaining before release

- Independent review of the source candidate and its exact supported-lane boundary.
- Actual installed-host construction/configuration of the optional dependencies, with the runtime closure/version update in that same change. No hidden dynamic imports or incomplete staged bundle.
- Real workspace-policy integration canaries, reserved-field/bounds audit and schema downgrade policy. The old v13 module ignores new columns and cannot enforce pins: rollback of pinned work to that module is a security downgrade, not a safe strict-mode rollback. Draining/holding pinned work and owner acceptance must be explicit before any deployment.
- Worker/bound-desktop sender adaptation and mapped session principals remain unsupported rather than fabricated. Remote transports and cross-machine identities remain deferred.

This candidate is not installed; no live journal, mappings, settings or current runtime were changed during R2 implementation.
