# Triangle Client release workflow

Triangle Client uses risk-based TDD. Build work should be fast and focused; release work adds only the checks that protect MESH identities, local credentials, and mailbox delivery.

## Build mode

Before a feature, write a concise proof matrix covering the changed behavior and its relevant failure modes. Implement a coherent vertical slice, run its targeted tests, then request one independent review for the milestone. Review findings are fixed as a batch and receive one focused re-review.

Do not run the complete repository suite after every small Swift, Node, shell, or documentation change. Run the owning package suite when its subsystem is complete.

## Triangle Client release mode

Before a release candidate, require these gates once:

1. A realistic multi-profile mailbox test when coordinator, runtime, credential, or lifecycle code changed.
2. Fresh-install, first-profile, migration, rollback, and no-duplicate-consumer coverage when service or lifecycle code changed.
3. Keychain custody, token non-exposure, runtime-integrity, and path-confinement checks when trust-boundary code changed.
4. One full standalone repository suite and dependency audit.
5. One repository-boundary check proving that no MESH server, database,
   deployment state, populated environment file, or credential is present.
6. One final independent security/reliability review.

Repeat a release gate only when a later change affects the condition it proves. Documentation-only changes run documentation and repository-boundary checks, not unrelated runtime suites.

## Triangle-specific proof matrix

For changes touching these boundaries, include the corresponding adversarial test before review:

| Boundary | Required proof |
| --- | --- |
| Instance registry | Duplicate keys, malformed state, cross-profile isolation, and no implicit default |
| Local cleanup | Symlink and parent-path race confinement |
| Runtime | Verify hash/content before execution; reject missing required Node APIs |
| Service cutover | Empty install, first add, crash-loop readiness, sticky `launchctl` responses, and rollback without duplicate consumers |
| Credentials | Keychain-only token custody; no argv, environment, log, registry, or child-process leakage |
| Mailbox | Exact identity/recipient, claim/ack terminal state, retry isolation, global concurrency, and per-profile ordering |

## External changes

Production deployments, Vercel environment changes, token rotation, GitHub publication, and destructive cleanup remain explicit approval boundaries. Verify them once after the authorized action; do not retry a failed external mutation without new direction.
