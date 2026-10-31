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
