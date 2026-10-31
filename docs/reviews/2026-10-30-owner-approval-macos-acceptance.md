# macOS owner approval: disposable interactive acceptance

Date: 2026-10-30 PDT (2026-10-31 UTC). Candidate source `4951788`, draft #156,
on the #153–#155 stack. This record does not authorize installation, activation
of an owner command, live registry mutation or remote transport.

## Path exercised

Codex test harness → approval coordinator → pinned candidate native provider →
macOS LocalAuthentication → actual registry revoke adapter → existing exclusive
registry lock and audit writer. Authentication was real, not a stand-in. All
profiles and registry files subject to mutation were disposable fixtures under
`/private/tmp/triangle-owner-auth-acceptance-*`. Live files were read only for
hash comparison. The helper was compiled in Swift 6 mode targeting macOS 13 on
arm64, strict signature verified, private mode 0700, and SHA-256 pinned.

The owner explicitly agreed to cancel the first attempt and approve two later
attempts. Each operation had its own nonce, digest, exact original binding,
registry sequence and bounded deadline.

## Results

| Attempt | Outcome | Time including human interaction | Registry sequence | Additional evidence |
| --- | --- | --- | --- | --- |
| Cancel | `owner_approval_cancelled` | 3.038 s | 4 → 4 | Registry and audit byte-identical |
| Approve first disposable revoke | committed | 7.620 s | 4 → 5 | Exactly one revoke audit; sibling bindings unchanged; replay refused |
| Approve second disposable revoke | committed | 6.380 s | 5 → 6 | Exactly one revoke audit; sibling bindings unchanged; replay refused |

The owner confirmed: **both approval attempts showed a separate prompt and
required the password each time**. This establishes observed fresh password
interaction on this Mini for this run, not universal prevention of OS reuse.
These timings include the human response and are not transport/provider latency
benchmarks.

An initial attempt intended as cancellation returned approved and committed one
disposable revoke after 7.101 s. Work stopped immediately; live state was verified
unchanged. The owner confirmed approving that prompt. It was an accidental
positive attempt, not evidence that a denied prompt was accepted. The three-case
sequence above then ran against a new disposable registry; the initial record
was retained rather than rewritten as a passing cancellation test.

## Preservation and evidence

Before/after hashes matched for the live principal registry and audit, receiver
policy, router/reply-identity policy paths and supervisor/worker manifests. Full
row-set digests matched for live `local_messages`, `local_replies` and
`local_reply_routes`. No live identities, messages or grants were changed. No
provider executable was installed or selected by a production command.

Private durable records under `~/Library/Application Support/The Triangle/releases/`:

- `owner-approval-interactive-acceptance.json`: executable pin, operation digests,
  attempt times/results, preservation hashes and owner observation.
- `owner-approval-initial-attempt.json`: the original approved-instead-of-cancelled
  attempt and the owner's explanation.

Temporary harness: `/private/tmp/owner-auth-live-acceptance.mjs`. Disposable
registry paths are in the private records. The harness is not a production CLI.

## Remaining gates

- Full operation-summary visibility/truncation was not explicitly confirmed by
  the owner; do not claim that UX gate passed.
- Touch ID/Apple Watch and SSH/headless behavior were not accepted. Only the local
  password path was exercised.
- Wrong-password rejection was not exercised; cancellation was the negative case.
- Live timeout/cancellation cleanup was not tested beyond clicking Cancel. Child
  termination and forced cleanup are established by stand-in subprocess tests.
- Review and merge the stack, then package/activate only within a separately
  scoped command rollout. First-time mapping and ordinary messaging remain free
  of these additional prompts.
- Move remains unavailable pending versioned audit/schema work; Linux/Windows
  providers are not implemented. Same-user arbitrary file/code tampering remains
  outside the claimed protection.

## Follow-up source review

The owner later clarified that they did not check full prompt-detail visibility;
that gate remains unverified. No additional prompt was opened for this review.

Review tightened approval identifiers and the native frame matcher to reject a
trailing newline: end-anchored regexes alone could accept one. This changes input
validation, not the OS authentication policy. Regression cases now cover profile,
principal, binding id and nonce. Existing valid identifiers are unchanged.

A committed opt-in test, `packages/triangle-cli/test/owner-approval-native.test.mjs`,
reproduces native validation without `--authenticate`. Set
`TRIANGLE_OWNER_APPROVAL_NATIVE_BIN` to the privately built candidate executable;
the ordinary suite skips it when no executable is supplied. This review explicitly
supplied a freshly compiled, signature-verified Swift 6/macOS 13 arm64 candidate.
The native test checked a valid frame, five invalid frames and missing mode.
108 affected tests passed, zero skipped, including that native test.

The interactive password record above remains scoped to source `4951788` and its
recorded executable hash. The stricter-validation binary was exercised only in
validation mode. Do not relabel it as the exact interactively accepted artifact;
packaged native activation still needs release-artifact acceptance and confirmation
that the full operation details are readable. No live or installed code changed
as part of this follow-up review.
