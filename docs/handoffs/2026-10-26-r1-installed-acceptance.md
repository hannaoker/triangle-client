# R1 installed acceptance checkpoint — 2026-10-26

Source: main `4f4ca2d` (PR #134 plus the installed-CLI correction #135). The helper was built and installed from the merge; v13 supervisor and all three worker bundles are staged, validated and running. Router is enabled. Identity registry sequence 3 maps existing codex-headless, ghost and gravity2 profiles from disk observations, not live server verification.

Evidence: `~/Library/Application Support/The Triangle/releases/r1-install-verification.json`. Rollback snapshots and stopped-journal files: the archive path recorded in that JSON. The owner waived restoration rehearsal; it remains unverified rather than passed.

## Verified on the Mini

- Native helper/client public ad-hoc signatures and install checks passed. Supervisor manifest v13 has 87 artifacts; codex/hermes/antigravity each have 89. All four `validate-runtime` checks and doctor passed.
- Refreshed the frozen installed triangle-local wrapper using `install-local-wrapper`; the old wrapper rejected v13. This refresh is a necessary rollout step not covered by runtime staging alone.
- Router off/on status was verified. A send through the installed CLI to gravity2 principal `agent_3764a37cb50683d20726bc8d43e21a88` resolved to the existing local worker, returned route local, and received exact `R1_PRINCIPAL_LOOP_OK` in 42.198 seconds. Only that reply was consumed.
- Exact retry while running returned isDuplicate; after a supported service restart, the same request remained completed and its retry returned isDuplicate again. No additional runner execution was admitted.
- Unknown principal returned recipient_not_found. A mapped principal without a configured local recipient returned route_unavailable. Neither negative request was persisted. These do not replace the separate source-suite ACL/capability-denial tests.
- All 61 message rows captured before the install retain phase and updated_at. The 14 old pending replies and two held tasks remain untouched.

## Actual client-path defect fixed

The first installed principal canary was rejected by triangle-local before reaching the router. #135 forwards well-formed principal IDs to server resolution while preserving server ACL and capability checks. Nineteen CLI/R1 tests passed, including a CLI-to-server principal regression. The merged correction was staged into all runtimes before the successful live canary.

## Remaining live acceptance

Claude retrieval/principal send is not proved. A request to the existing paired Claude conversation is queued as `r1-claude-acceptance-20261026-01`. No discovered Claude session is currently reachable. The owner has been asked to open a Claude scratch chat, call triangle_get_status and supply its address. Do not claim enqueueing this request means Claude received or executed it. Retrieve only this request's correlated reply; leave old replies and held work alone.

If the owner supplies a different reachable Claude address, avoid duplicating instructions: establish whether the paired request can be processed or explicitly retire that canary using supported owner controls. Do not borrow session identities or forge credentials.

Full installed acceptance is still conditional on the remaining Claude test and owner acceptance of the evidence. Cross-machine, Iroh/MESH routing and R2 provenance/reply-route work remain deferred. `package-install.json` was already stale; this run used the native helper installer and runtime staging, not a complete distribution-package installation.
