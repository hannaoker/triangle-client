# Triangle Client release workflow

Triangle Client uses risk-based TDD. Build work should be fast and focused; release work adds only the checks that protect MESH identities, local credentials, and mailbox delivery.

Installable package story: [release-bundle.md](release-bundle.md).
Clean-Mac operator path: [e2e-operator-runbook.md](e2e-operator-runbook.md).

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

## Release readiness checklist

Call a cut **shippable to other machines** only when every applicable box is
checked. Prefer the fail-closed driver (prints no secrets):

```sh
# Docs + boundary scans (safe on Linux CI)
./scripts/release/check-release-readiness.sh --mode docs

# Public ship pretends: require Developer ID env on the build Mac (values not printed)
./scripts/release/check-release-readiness.sh --mode public
```

| # | Gate | Pass criteria |
| --- | --- | --- |
| R1 | Docs package | `release-bundle.md`, `e2e-operator-runbook.md`, helper README, and this workflow agree on install paths, first-start, upgrade, uninstall, and signing |
| R2 | Signing distinction | Public installs require `TRIANGLE_DEVELOPER_ID` + ten-character `TRIANGLE_DEVELOPER_TEAM_ID`; `--local-ad-hoc` is documented as non-public and does **not** provide a stable distributed Keychain identity |
| R3 | Secret boundaries | `verify-secret-boundaries.sh` passes; LaunchAgent templates invoke only `triangle-mailbox run-supervisor`; no `mesh_` / `mesh_watch_` in Node production paths, plists, or operator logs |
| R4 | Repository boundary | No MESH server tree, `.vercel`, populated env files, or committed credentials (release mode item 5) |
| R5 | Runtime suite (code changes) | Applicable items 1–4 and 6 above; docs-only changes skip unrelated runtime suites |
| R6 | Mac Keychain custody (public artifact) | Opt-in disposable Keychain lifecycle against the **signed** helper (`TRIANGLE_RUN_DISPOSABLE_KEYCHAIN_TEST=1`); see `KEYCHAIN_POLICY.md` |
| R7 | E2E operator path | A clean Mac can follow the E2E runbook through install → enroll → prepare runtime → `agent add` → `event-driven` → `watch-ensure` / `watch-status` |
| R8 | Explicit non-blockers recorded | Developer ID cert on build Mac, ChatGPT.app for desktop Gate A / Bob canary, and any live helper watch gaps are called out without claiming Linux completion |

**Do not** mark public release ready from `--mode adhoc-dev`. Ad-hoc requires
`TRIANGLE_ACK_ADHOC_NON_PUBLIC=1` and never satisfies R2 for distribution.

Phase 2 durable wake/scheduling remains **Complete**. App Server / ChatGPT.app
proofs are Mac-operator dependent and do not reopen Phase 2.

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
| Watch grants | Secret-free `watch-status`; `mcp-interactive` rejected from membership; Node uses helper CLI only |

## External changes

Production deployments, Vercel environment changes, token rotation, GitHub publication, and destructive cleanup remain explicit approval boundaries. Verify them once after the authorized action; do not retry a failed external mutation without new direction.
