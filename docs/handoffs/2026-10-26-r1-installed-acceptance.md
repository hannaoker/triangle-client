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

## Claude installed acceptance — completed

The owner approved workspace-wide Claude attachment on 2026-10-26; setup installed the managed `.mcp.json` entry and the service restarted. Existing Codex settings were preserved. Only the bound Codex identity is allowed to send to Claude. After reload, the owner supplied attached session `session-5f719e7589588c4e1f74cc3a6a69f4ef731dd35c9ee1482e9a344268933ecc69`, generation 2. Discovery reported reachable/wake-capable; the wake was accepted before the request was eventually claimed. Wake acceptance alone was not counted as execution.

Codex independently verified the real journal records for `r1-claude-origin-20261026-01`: sender is that Claude session, recipient is gravity2, stored principal is `agent_3764a37cb50683d20726bc8d43e21a88`, resolved_via principal, phase completed. The correlated worker reply was exactly `R1_CLAUDE_PRINCIPAL_OK`, addressed to the same Claude sender, with matching requestId/inReplyTo and consumed=true. Worker round trip was 44.127 seconds. Claude reported using only Triangle MCP tools; that tool-use claim is separate from the independently verified routing/correlation records. Claude replied to Codex on `r1-claude-session-20261026-01`; Codex consumed only that report and acknowledged its wake.

Machine evidence is updated in `releases/r1-install-verification.json`. The earlier request `r1-claude-acceptance-20261026-01` addressed to the old paired conversation remains a separate queued test request; it was not delivered to this attached session or counted as success. Do not silently delete it or borrow the paired identity to claim it.

## Remaining limits

The installed local principal request/reply checks are now verified for Codex and Claude senders, alongside restart deduplication and negative route checks. The owner still accepts the evidence; cross-machine, Iroh/MESH routing and R2 provenance/reply-route work remain deferred. The owner waived restoration rehearsal. `package-install.json` was already stale; this run used the native helper installer and runtime staging, not a complete distribution-package installation.
