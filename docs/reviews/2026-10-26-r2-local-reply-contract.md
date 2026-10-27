# R2 local reply identity contract — first library slice

This started as a pure library foundation and now includes explicit opt-in server/journal integration, exercised only in disposable tests. The installed host now constructs the optional verifier and pin store, but new pin admission remains disabled by default. Candidate runtime manifest v14 includes the three new modules; the Mini remains installed on v13 and no installed configuration changed. Journal source now includes additive nullable columns and optional reply-pin storage.

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


## Host and runtime integration checkpoint

The host constructs the route store on its own SQLite connection and passes a trusted identity factory through the supervisor subsystem, which supplies the actual HMAC validator. With workspace session messaging enabled, the factory uses that host's real workspace-session broker. With no broker, pinned replies fail closed. The trusted host-construction override `replyIdentityEnabled` otherwise reads the private `client/reply-identity.json` policy, absent by default. A boolean or callback controls new admission only. Existing pinned replies continue through authentication and journal verification when it is false.

Manifest v14 adds exactly three artifacts to each v13 closure: the reply contract, route store and sender-authentication modules. Supervisor bundles contain 90 artifacts and worker bundles 92. Python staging/validation, Swift launch validation, doctor, and fixtures accept v14 while retaining exact historical artifact sets.

Codex reproduced a request that was accepted with 261120 bytes of metadata padding but became unretrievable when receiver-built provenance enlarged its inbox projection past the protocol limit. Pinned admission now measures its final journal projection with 4096 bytes of framing headroom inside the transaction. Oversized requests roll back the request and route together. The regression uses the real socket, journal and signed credentials.

Gemini 3.8 Flash (Medium) independently reviewed frozen source `7d652e2`, reported no blockers, and ran the 10 then-existing R2 tests. It missed the reproducible bounds issue. That review does not cover this subsequent host/packaging change. Focused wiring/closure tests passed 55 tests. The broader run passed 254 of 257 initially, with three exact packaging fixtures requiring their new v14 file list; all eight tests in that corrected packaging suite subsequently passed. The Swift native host suite also completed successfully (exit 0), including the v14 standalone-supervisor artifact fixture.

Remaining release gates: review of this exact head; install the new helper and runtime together; real attached-workspace canaries and restart acceptance. Do not install or enable this as completed R2 acceptance. Worker/bound-desktop lanes remain legacy; no mapped session principal or remote transport support is implied. v13 must not process pinned work as a rollback path.


## Activation and operational downgrade floor

`triangle-local setup-reply-identity --enable` requires an enabled local configuration and an installed supervisor manifest with version at least 14. It atomically writes private `client/reply-identity.json` containing `{version:1,enabled:true}`. `--disable` writes false and retains the file. Neither command changes pairings, grants or the session-messaging policy. The host reloads this tiny policy per admission; absent policy disables new pins, and malformed policy disables admission with a fixed error in status. Existing pins still require the verifier.

The updated native helper and Python manifest validator reject runtime versions below 14 whenever this policy path exists, including disabled/malformed policy and symlinks. Both the supervisor and fallback worker native resolution paths apply the floor. Install the new helper and refresh the frozen validator wrapper before enabling; the setup command's manifest check does not attest the helper binary version. This is protection against ordinary runtime-only downgrade, not deliberate owner deletion of policy or replacement of both validator/helper and runtime. Never describe old v13 binaries as enforcing this new guard.

Disposable tests prove setup rejects v13 before policy creation; enable and disable preserve a 0600 policy and minimum-runtime result; malformed policy is disabled with a status error; the Python renderer refuses a valid legacy runtime after disabled policy creation; and native supervisor resolution refuses v13 but accepts v14 with disabled policy. The 23-test focused activation run and 12-test guard rerun passed. The Swift host suite completed successfully after the new guard and native fixture were added. The Mini's live install and configuration remain untouched.


## Disabled-admission retry correction — 9547620

A follow-up regression reproduced `duplicate_id_conflict` when the exact original pinned request was retried with new pin admission disabled. The server had discarded identity context when the switch was off, changing the route key and reserved-metadata projection used for duplicate matching. The retry factory now receives an existing route only from the server's trusted journal lookup, still validates credentials/live identities and verifies pinned associations/generations, and retains the original pinned canonical projection. Disabling controls new pins only. Conversely, retrying an existing unpinned legacy message after enablement bypasses pin creation, preserving its original semantics.

The existing native socket regression now exercises both switch directions with the real signed-credential server/journal. It failed before the fix and passes after it; all 258 relevant tests pass. Gemini 3.8 Flash (Medium) independently reviewed only commit `9547620`, ran the focused socket test, and reported no blockers. It confirmed incoming client parameters cannot supply existingRoute and no pin mutation occurs on duplicate admission. Native Swift code was unchanged and was not needlessly rebuilt for this correction.
