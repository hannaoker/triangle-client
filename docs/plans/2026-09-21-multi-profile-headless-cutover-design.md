# Multi-Profile Headless Codex Cutover Design

**Date:** 2026-09-21

**Status:** Approved

## Goal

Run every enabled Triangle Client profile whose runtime adapter is `codex` and
whose delivery mode is `headless-app-server` as an independently authenticated
headless Codex drain inside the single `dev.thetriangle.client` supervisor.
Retain desktop-bound App Server delivery only as an optional, explicitly chosen
delivery mode.

## Current failure

The registry can label multiple Codex profiles `headless-app-server`, but the
Swift supervisor currently selects one binding-matched primary profile and
emits one `headlessWake` object. The Node coordinator therefore starts one
headless drain. Other enabled Codex profiles are neither drained nor explicitly
reported as omitted.

On the current Mini, `codex-headless` is the selected primary. The enabled
`codex-bob-test` profile is not drained and its installed credential points to a
retired MESH identity. A running coordinator is therefore necessary but not
sufficient evidence that the multi-profile cutover completed.

## Chosen architecture

Use one launchd-supervised coordinator with one isolated headless drain per
enabled Codex profile.

Each drain owns:

- one MESH mailbox profile and credential;
- one deterministic profile instance ID;
- one claimer lock under the Triangle Client state directory;
- one profile-specific state root, conversation registry, completion journal,
  execution lease, and App Server subprocess;
- one independent polling/backoff lifecycle.

All drains share only immutable runtime artifacts and the configured Codex home
used for the underlying Codex login. Grok Bot and non-Codex adapters remain
outside the headless pool.

The supervisor remains the sole LaunchAgent. The design does not create one
LaunchAgent per profile and does not reintroduce the shared desktop App Server.

## Binding and bootstrap contracts

### Runtime binding

Advance `headless-runtime-binding.json` to a versioned multi-profile document.
The document contains common runtime settings plus a deterministic array of
profile entries. Each entry binds a profile, instance ID, and profile-specific
state root. Profiles are sorted by profile name for stable digests.

The cutover planner derives the array from all enabled Codex profiles in
`headless-app-server` mode. It must reject duplicate profiles/instance IDs,
Grok Bot membership, room pins, unsafe paths, missing credentials, and stale
binding entries. Repeat applications may read the existing single-profile
binding as migration input, but must write only the new schema.

### Swift-to-Node bootstrap

Replace the optional singleton `headlessWake` bootstrap field with a bounded
`headlessWakes` array. Swift resolves and validates each enabled Codex member
independently, including its credential, then emits one secret-confined config
per eligible profile.

An enabled headless Codex profile may not disappear silently. Binding mismatch,
missing credential, dedicated-drain collision, or runtime ineligibility must be
represented as a bounded omission. Cutover acceptance requires no omissions for
enabled Codex profiles.

### Node coordinator

The Node coordinator strictly validates `headlessWakes`, rejects duplicate or
cross-mode instance IDs, and constructs one claimer guard and one drain per
entry. Startup is atomic: acquire/validate all guards and construct all drains
before starting any drain. If startup fails, stop already-started drains and
release every guard in reverse order.

Shutdown aborts and awaits every drain, then releases every guard. A failure in
one polling loop is isolated by its existing retry/backoff behavior and must not
silently stop another profile.

## Credential migration

The cutover never copies credentials between profiles and never silently
registers a new identity. Before enabling a profile, its local credential must
resolve to the intended live MESH identity.

For the Mini migration, `codex-bob-test` must be rebound to the retained
production identity rather than the retired `codex-bob-wake-2609130214`
identity. Credential replacement is performed through the reviewed recovery or
rotation path, with secret values kept out of logs and repository files. The
old local credential is retained only in a restricted rollback backup until the
live canary succeeds, then removed through the normal credential lifecycle.

## Failure handling and rollback

- The helper/runtime installation remains hash-verified and atomically staged.
- The cutover script snapshots the previous binding and registry modes.
- Apply does not retire or disable any legacy service until the new coordinator
  publishes readiness and survives the existing stability gate.
- Any missing enabled profile, credential failure, dual claimer, malformed
  binding, or child startup failure fails the cutover closed.
- Rollback restores the prior helper, runtime manifest/bundle, binding,
  registry modes, and exact loaded-service state.
- Mailbox work remains reply-before-ack; empty or `[NO_REPLY]` output cannot
  settle admitted work.

## Proof matrix

### Contract tests

1. Two enabled Codex headless profiles produce two sorted bootstrap entries.
2. Each entry uses its own profile, instance ID, state root, and credential.
3. Grok Bot and disabled/non-headless profiles never enter the array.
4. Duplicate profiles, duplicate instance IDs, room pins, unsafe paths, and
   unknown keys fail validation.
5. A missing/mismatched binding entry produces an explicit omission and blocks
   cutover acceptance.
6. A loaded dedicated drain for either profile blocks that profile and prevents
   partial multi-profile startup.
7. Node starts and stops every drain and releases every per-profile lock.
8. A later drain startup failure rolls back earlier drains/locks.
9. A stripped coordinator environment without `HOME` still resolves every lock
   from the helper path.
10. Repeat cutover apply migrates and reuses safe existing binding values.

### Release checks

1. Swift host contracts pass.
2. Agent-worker and client-console package suites pass.
3. Client-service, cutover, and worker-render integration suites pass.
4. Installed helper hash and runtime manifest match the committed checkout.
5. `dev.thetriangle.client` is stable with one coordinator and no competing
   shared/dedicated drain LaunchAgents.
6. Live discovery confirms each local profile maps to the intended non-disabled
   MESH identity.
7. One nonce-bound work delivery per enabled Codex profile completes as
   `claim -> substantive threaded reply -> ack` after the final restart.
8. Each tested mailbox is empty afterward and no cross-profile room/thread/state
   contamination is observed.

## Acceptance

The cutover is complete only when all enabled Codex profiles appear in the live
multi-profile bootstrap, have valid distinct credentials, pass a post-restart
end-to-end canary, and the implementation is committed. A green unit test suite
or a stable singleton `codex-headless` process alone is not completion.
