# Owner approval: next bounded slice (D5)

Status: implementation proposal and non-interactive spike, 2026-10-30. D5's policy
is approved; this document does not activate identity writes, request a live
password prompt, or claim that a provider is accepted. Baseline: client main
`77fcf89` with #151 and #152 merged.

## Why this is next

U1/U2 are installed, U3's decisions are recorded, and D2/D3's storage guards are
installed. The packaged owner CLI is now `0.2.0-identity.1`: its actual
`identity migrate` entry point passed disposable-inventory acceptance, including
a conflict with a principal already bound to a different profile. Helpers,
supervisor manifests, live registry/audit and backlog stayed unchanged. Records:

- `~/Library/Application Support/The Triangle/releases/pr151-152-install-verification.json`
- `~/Library/Application Support/The Triangle/releases/owner-cli-identity-install-verification.json`

There is still no owner move/revoke CLI, no mapped attached chat, and no remote
principal route. Do not build a mutation command whose approval check would
merely accept a caller's Boolean or a terminal. First-time inventory mapping keeps
its approved terminal-plus-plan-id flow; ordinary review/reply and messaging must
not acquire extra owner prompts.

## Portable target

Keep the CLI and background service. Core policy and request validation are
platform neutral; OS authentication is a platform adapter, unrelated to key
storage. File-backed credentials remain supported. Neither a desktop app nor
Apple Keychain becomes a prerequisite.

An approved operation binds the exact action, canonical registry location,
expected registry sequence, profile id, old/new principal and authority where
applicable, a random nonce, and a short monotonic deadline. Display a clear
operation summary before authentication. Refuse unexpected fields or a changed
operation rather than silently adjusting the summary.

Use one process to hold the operation, request OS authentication and perform the
commit. Do not grant authority via a JSON file, environment variable, command-line
`--approved` flag, cached sudo login, or an externally supplied `approved: true`.
Do not add a generic privileged shell runner. The core authenticates the owner,
not peer instructions or a remote agent's claims.

After successful authentication, acquire the existing exclusive registry lock,
re-read and compare the registry sequence and original binding, verify the
nonce/deadline has not been used or expired, and perform exactly that operation
through a dedicated audited mutation. A changed sequence or binding invalidates
the authorization; do not replan automatically. Keep the lock out of the human
prompt interval. Cancellation, denial, timeout, unavailable provider or stale
state leaves the registry and audit bytes unchanged.

The future move operation must preserve D3 uniqueness, advance generation and
mint a new binding id. Existing plain `bind` must continue refusing identity
moves. This proposal does not add that operation yet.

## Provider feasibility before integration

macOS first, Linux next, Windows after Linux. Unsupported platforms report an
unavailable provider and refuse authority-changing commands; do not silently
substitute terminal confirmation. Existing messaging and first-time inventory
mapping remain usable without an authentication provider.

- macOS candidate: `LocalAuthentication`, `.deviceOwnerAuthentication`, fresh
  `LAContext` per operation. Apple's `canEvaluatePolicy` tests capability;
  `evaluatePolicy` performs authentication. A positive capability result is not
  approval or proof that a CLI prompt succeeds. The separate probe below never
  calls `evaluatePolicy`. Actual acceptance must establish fresh interaction,
  denial/cancellation, account-password fallback where supported, behavior from
  an ad-hoc signed CLI and SSH/headless unavailability. Don't assume disabling
  biometric reuse alone prevents all prior-authentication reuse.
- Linux candidate: a dedicated polkit action through its authentication agent.
  Verify distribution/service prerequisites, bind process PID and start time,
  and avoid retained `AUTH_SELF_KEEP` / `AUTH_ADMIN_KEEP` authorization. A plain
  successful `pkcheck` is insufficient evidence of fresh approval for this
  exact transaction. Do not install polkit policy in this spike.
- Windows: select and prove an OS provider separately; no implementation or
  availability claim yet. Do not make macOS behavior a cross-platform contract.

The existing same-OS-user threat limit remains: an unrestricted process can
edit user-owned files or replace code. An OS prompt on a supported command does
not make that a security boundary against arbitrary same-user filesystem writes.
Closing that boundary would need a separate custody/privilege design; do not
claim it as an outcome of D5.

## Spike and next gate

`scripts/probes/owner-approval-capability.swift` compiles as a standalone macOS
CLI. It requests no authentication, changes no settings, reads no credentials or
transcripts, and returns only capability/error metadata. Compile and run outside
installed bundles; it is not a new helper product or installation requirement.

Record the local result below. Regardless of result, a later, exact owner-led
interactive acceptance is still needed before enabling an authority-changing
command. Do not trigger a prompt as a side effect of discovery/status/doctor.

Implementation order after the spike:

1. Add the bounded operation contract and a fail-closed provider interface, with
   mismatch, expiry, replay, unavailable, denied, cancelled and stale-state tests.
2. Integrate a macOS provider and an operation-specific committer. Keep it out of
   ordinary messaging and first-time mapping; add no authority via file receipts.
3. Run a disposable interactive approval/denial test with the owner. Verify no
   write on refusal, one exact audited commit on approval, no reuse, and refusal
   after concurrent state changes. Source mocks cannot establish these claims.
4. Only then add the separately audited move/revoke command and package it.
   Actual live registry mutations remain separately scoped owner operations.

D1's schema expansion and remote adapters remain deferred. D4 leaves chats
unbound; D6's owner-only remote holds applies when remote inbound exists.

## Primary references

- [Apple: canEvaluatePolicy](https://developer.apple.com/documentation/localauthentication/lacontext/canevaluatepolicy(_:error:))
- [Apple: evaluatePolicy](https://developer.apple.com/documentation/localauthentication/lacontext/evaluatepolicy(_:localizedreason:reply:))
- [polkit architecture and retained authorization](https://www.freedesktop.org/software/polkit/docs/latest/polkit.8)
- [polkit authorization subjects and interaction flags](https://www.freedesktop.org/software/polkit/docs/latest/eggdbus-interface-org.freedesktop.PolicyKit1.Authority.html)

## Local spike evidence

Compiled on the Mini with `/usr/bin/swiftc` using a disposable module cache;
`codesign --verify --strict` succeeded for the generated executable.

- Restricted execution: `policyAvailable: false`, `NSCocoaErrorDomain` code 4099.
  This is an OS-service-access failure, not evidence that the machine lacks
  owner authentication.
- Normal execution: `policyAvailable: true`, no error.
- Both: `authenticationAttempted: false`, `approvalGranted: false`. No prompt,
  registry mutation, configuration change or installed helper was introduced.

This proves the compiled command can query capability with normal access. It
leaves every interactive acceptance gate above unresolved. Probe executable and
module cache are under `/private/tmp`; the reviewed source is committed here.


## Contract implementation checkpoint

`packages/triangle-cli/src/owner-approval.mjs` now implements the library-only
operation contract. Only profile move/revoke requests are accepted, with closed
fields, canonical existing registry directory, expected sequence, exact active
before identity and (for moves) exact new principal/authority. Requests are copied,
frozen, assigned a random nonce and bounded monotonic deadline, and hashed for
provider display/correlation. There is no serialized approval receipt.

A coordinator-local opaque handle gets one authentication attempt. The trusted
in-process provider receives the immutable challenge; its outcome is not a
CLI/MCP argument. The default provider refuses as unavailable. Denial, cancellation,
provider failure, timeout, late approval and replay cannot enter the commit path.
Cancellation/expiry before dispatch avoids requesting authentication at all.

After approval the coordinator invokes a trusted lock adapter and rechecks the
deadline, cancellation, exact registry sequence and original binding inside its
callback. It passes only the frozen operation to that adapter's committer. No
production lock/commit adapter is connected yet; fake-adapter tests establish
contract sequencing only, not real registry exclusion or durable transactions.
The future adapter must use the actual registry owner lock, revalidate custody,
apply one synchronous audited operation and retain D2/D3. No arbitrary shell or
user-configurable provider is permitted by the intended integration.

Tests cover the operation fields, exact challenge digest, mutation-resistant
snapshot, one-use and cross-coordinator/serialized handle refusal, unavailable/
denied/cancelled/malformed outcomes, provider exceptions, timeout with late result,
pre-dispatch cancellation, changed sequence/principal/origin/generation/binding id,
missing binding and expiry while awaiting the lock. Existing inventory-migrate
and status CLI behavior is exercised alongside it.

This source slice adds no CLI command, OS provider, live prompt, registry writer,
installed artifact or permission. First-time mapping and ordinary messaging stay
unchanged. Production provider, locking/commit integration and interactive
owner acceptance remain the next gates, not claims made by these tests.


## Review correction and revoke-only transaction slice

Review of the v1 registry found `AUDIT_ACTIONS = {init, bind, revoke}` in
`identity-registry.mjs`; both new writes and old readers reject a new move audit
action. D2 correctly forbids an identity change disguised as `bind`. Therefore
move integration must wait for a versioned audit/schema/runtime-floor decision
under D1. Do not relax D2 or add an unreadable audit action to the v1 file.
Revoke can proceed separately using its existing v1 action.

The contract review also found a late-callback gap: an adapter that returned or
threw before invoking its retained callback could otherwise commit after the
caller had already seen failure. The coordinator now permits callback entry only
within the adapter's synchronous call scope. Promise-returning adapters are
refused, and retained/queued callbacks cannot commit afterward. This matches the
registry's existing synchronous lock/transaction, not a promise of asynchronous
lock-adapter support.

`packages/triangle-cli/src/owner-approval-registry.mjs` implements the revoke-only
adapter with the real `updateIdentityRegistry` lock and audit transaction. It
checks the exact operation and original binding in that transaction, uses one
captured timestamp for revocation and audit, preserves every other binding, and
refuses missing, repeated, retained or asynchronous commit callbacks. The
architecture allowlist names this one writer explicitly; a separate test verifies
that no command or runtime imports it. No OS provider or CLI is wired to it.

84 affected tests passed: contract, actual disposable-registry revoke integration,
registry behavior and migrate/status CLI. Test-provider approval appends one real
revoke entry; test-provider denial/cancellation/unavailability, expired approval,
wrong original binding and concurrent sequence changes make no durable change.
These are real transaction tests with fake authentication, not OS approval
acceptance. No installed artifact, live binding, permission or message changed.

Next: implement and review the macOS provider without enabling a command, then
perform a separately scoped owner-led disposable interactive test. Move requires
the D1 compatibility work first; Linux/Windows providers remain unimplemented.


## macOS provider candidate (not activated)

`packages/triangle-cli/src/owner-approval-macos.mjs` connects the provider interface
to an explicitly pinned native executable. The release supplies the canonical
private executable path and SHA-256; peer/CLI input must never select either.
Before each launch it verifies file custody, pin, operation digest, exact shared
summary and remaining deadline. It uses direct pipes and a minimal environment,
not a shell, inherited provider credentials or a cached sudo session. Unsupported
platforms and malformed challenges refuse without spawning.

Replies must be one bounded canonical JSON object with the exact nonce/digest,
a known outcome and a successful process exit. Cancellation, deadline, malformed
or excessive output terminate the child, with bounded SIGKILL fallback, and the
provider waits for child exit. The coordinator still decides whether approval is
fresh and whether the registry operation matches. Hash pinning is not a claim
against arbitrary same-user code/file replacement or the verify/exec race.

`scripts/probes/owner-approval-provider.swift` is a candidate standalone helper.
`--validate-request` only validates and returns unavailable, without creating an
LAContext. `--authenticate` would evaluate `.deviceOwnerAuthentication` with a fresh
context, zero biometric reuse allowance, the exact operation summary and digest.
Cancellation/timeout invalidates the context. No password, token or reusable
approval receipt is returned. OS success is not yet evidence of fresh user
interaction: prior-auth reuse, full-summary visibility, password fallback and
headless behavior remain interactive release gates. The helper is not installed
or selected by a production command.

The Node contract/provider/transaction plus migrate/status checks pass 86 tests.
Provider process tests use pinned disposable Python stand-ins, including wrong
nonce/digest, changed executable, denial/cancellation/unavailability, invalid or
oversized output, nonzero exit, minimal environment and forced cleanup. These
stand-ins do not prove OS authentication. The actual Swift helper compiled under
Swift 6 and passed strict signature verification; five validation-only cases ran
against the native executable. No `--authenticate` invocation occurred.

Next acceptance requires the owner to be present for explicit denial and approval
of a disposable revoke, through this candidate provider and the real transaction
adapter. Verify zero write on denial, one exact audited revoke on approval,
separate fresh interaction on each attempt and bounded cancellation. Do not use a
live principal for this test or enable a command before that evidence is reviewed.

### Interactive password acceptance — 2026-10-30 PDT

The owner-led disposable native test has now run. Cancellation preserved registry
and audit bytes; two separate password approvals each committed one audited revoke
and refused replay. The owner confirmed a separate prompt and password entry each
time. Live identity/policy/manifests and message/reply/pin records stayed unchanged.
See `../reviews/2026-10-30-owner-approval-macos-acceptance.md` for timings, the
initial approved-instead-of-cancelled attempt and remaining limits. This supersedes
the earlier “no native prompt ran” checkpoint only for this acceptance run. It
does not activate a production provider or command. Summary visibility,
biometric/headless behavior and live timeout cleanup remain unaccepted.

### Stack review checkpoint

The #153–#156 follow-up review tightened whole-string identifier matching and
added a reproducible opt-in native validation test. 108 affected tests passed with
the native candidate explicitly supplied (zero skipped). The owner did not check
full prompt-detail visibility, so that gate remains open; no repeat prompt was
triggered. The refreshed candidate differs in validation code from the previously
interactively accepted binary and is not installed or activated. See the review
record for the exact source/interactive evidence boundary.

### Merged stack and packaged candidate

PRs #153–#156 merged in order; main reached `22b48ee`. This merges libraries and
evidence only. No production command selects the provider.

The macOS package builder now has an explicit `--owner-approval candidate` path.
It compiles the tracked native helper in Swift 6 mode for the native architecture
and macOS 13, signs it as `dev.thetriangle.owner-approval`, includes it in the
versioned release and hash manifest, and records disabled activation/source hash.
It does not install a global helper command or select the provider. Ordinary
packages omit the candidate. An `enabled` value is refused before building.

The first full package run passed 10 cases, including a real native candidate in
an isolated install. Two final targeted checks passed after adding ordinary-package
absence and invalid-activation assertions. The real non-test candidate archive
`0.2.0-owner-approval.1` was also built: 155 files verified, native signature
verified, `LC_BUILD_VERSION` reports minimum macOS 13.0, and the native validation
test passed against the extracted package using its bundled Node. Those are
artifact checks, not an OS-13 machine acceptance claim or native authentication.

Archive (private candidate, not published):
`/private/tmp/triangle-owner-approval-package-candidate/triangle-client-0.2.0-owner-approval.1-darwin-arm64.tar.gz`.
SHA-256: `2c40b315c14f7f724659c959e0cb3da723254ab4e0ce14516349558c8ade5e97`.
The versioned helper remains inside the extracted candidate, not the live Mini
install. Existing helpers, service, identities and messaging permissions were not
changed. The exact packaged executable still needs an owner-led disposable prompt
test, including readable full details, before a command rollout.

### Exact archive prompt acceptance completed

The owner-led test now used the exact extracted `0.2.0-owner-approval.1` helper
and packaged libraries. Cancel preserved registry/audit bytes; approval appended
one disposable revoke and refused replay. The owner confirmed full principal and
registry path visibility and fresh password authentication. Live state hashes
matched throughout. The review record above names exact archive/native hashes
and timings; durable evidence is `owner-approval-packaged-acceptance.json` under
the Mini's releases directory. This closes packaged password/visibility acceptance
for that artifact only. The candidate is still not installed, published or selected
by a production command. Review/merge the packaging PR before command rollout.


### Guarded owner revoke command — source implementation

`triangle identity revoke <profile> --registry-root DIR` now proposes a deterministic
read-only plan. It uses only the local registry, not MESH/workload credentials.
Human output includes the exact operation and a shell-quoted apply command.
`--confirm PLAN_ID` re-reads the plan, requires a local terminal (no SSH/headless
apply), displays the operation, and requests fresh native authentication. Wrong
or stale plans never authenticate. A concurrent change during approval refuses
rather than replanning. SIGINT/SIGTERM propagate cancellation and listeners are
removed after the operation. Expected errors are reported without raw paths or
stacks; unrelated commands retain lazy worker-dependency loading.

The source package builder adds the explicit `--owner-approval revoke` capability,
separate from `candidate`. Only a private verified release manifest declaring
`identity.revoke` can select its exact manifest-pinned native helper. Ordinary,
candidate-only, test-only and unsupported-platform releases fail unavailable.
No command-line helper path, `--yes`, JSON approval Boolean, environment token or
terminal alone substitutes for OS authentication. Dependency injection is for
trusted in-process tests, not peer input or a same-user tamper-resistance claim.

This revokes a local principal binding only: exact-id delivery, receiver grants,
MESH credentials and server identities are unchanged. No move/rebind command is
added. Existing default/candidate packages are not enabled by the source change.

Validation: final 133 focused tests passed with native validation explicitly
supplied, zero skipped, covering CLI plan/apply, actual registry transaction,
stale/concurrent state, cancellation, manifest selection/pin, malformed package
and missing worker dependencies, plus existing migrate/status/core behavior.
Apply approvals use stand-in providers or helpers in these tests; there was no
new native prompt. All 12 packaging tests passed, including an isolated installed
revoke-enabled package's read-only plan and refusal of non-terminal apply.
The package run preceded the final interruption/error/render refinements; those
were covered by the final focused run, not a repeated package run.

No live registry, service, CLI install or receiver policy changed. Review the
source PR and obtain exact packaged command/TTY/native acceptance against a fresh
disposable registry before merging/installing a command-enabled release. See the
owner-revoke command handoff for the checkpoint and remaining work.
