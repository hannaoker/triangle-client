# Claude session attachments acceptance — 2026-10-23

Candidate after PR #110; not yet installed in the production supervisor.
Motivation: discovery alone cannot make a session addressable. This adds a
separate owner workspace opt-in, own-MCP attachment, durable child leases,
existing interactive inbox/claim/reply handling, and existing-owner wake.

The receiver policy initially authorizes the bound Codex sender only. Attached
Claude sessions can initiate requests only to configured workers. Replies return
to the original sender. Incoming Codex inbox, general Claude-to-Claude policy,
new worker launch and cross-machine work remain deferred. Raw harness UUIDs are
not persisted by new attachment storage; existing wake bindings use pseudonyms.

## Real Desktop checks against an isolated candidate supervisor

The installed service was unchanged. Only the previously authorized disposable
`/private/tmp/triangle-session-discovery-m0-20261023` workspace was opted in.
The isolated host used a separate socket/journal and a worker runner that refuses
reasoning. Test prompts authorized exact canary IDs only, never arbitrary peer
instructions.

- Desktop fork 5 attached as `session-4889f096645c62df87d9a7bc1a73b160a39a30e2655c50274181139e2e1b1f8e`.
  Request `attachment-live-a-20261023` automatically woke that chat. Correlated
  reply `attachment-live-a-reply` contained exactly `ATTACHMENT_A_OK`.
  Visible chat confirmed acknowledgment of wake `8f6b267c-abc7-41ed-bb1f-734301171d35`, generation 1.
- Desktop fork 6 independently attached as `session-6232bed647a49960e349f11f1a821e2053231c18aaa867197571000b47f36677`.
  Request `attachment-live-b-20261023` automatically woke B; correlated reply
  `attachment-live-b-reply` contained exactly `ATTACHMENT_B_OK`.
  Visible chat confirmed acknowledgment of wake `54a0b186-85f8-4f3d-8e41-b8e7a4b6142e`, generation 1.
- Restarting only the isolated supervisor recovered both exact addresses online.
- `/clear` in B made its old lifecycle ended/offline/unreachable. Sending to
  that address was rejected. A remained online; no redirect occurred.
- Participation and discovery were disabled with both cleanup-required flags
  false. Managed MCP entry/hooks were removed, the original metadata-probe MCP
  preserved, and the isolated supervisor stopped.

Initial eager attachment failed `session_offline`: Claude starts MCP before
SessionStart registration finishes. Lazy attachment on the first tool/heartbeat
fixed this dependency. The Desktop checks cover this final startup approach,
before subsequent policy-rotation/cleanup/path hardening; source tests cover
those changes. No installed-service acceptance is claimed for this candidate.

## Verification

Six attachment tests cover independent inboxes/foreign claims/replies, restart,
capability separation, competing leases, end/close/revocation, startup ordering,
stale generation, immediate policy rotation and missing-workspace degradation.
Existing host/CLI, discovery, Claude MCP/wake, server/client and packaging tests
also run. Final focused counts are appended after completion.

An initial restricted full run passed 920, failed two and skipped four: unchanged
/private/var/tmp socket setup was denied by the execution sandbox, and an unchanged
installed Hermes CLI help check failed there. The rerun with required access
passed 924, failed zero and skipped three (927 total). This full run preceded the
final small policy-rotation/cleanup/path changes; focused results distinguish them.

Release boundaries: candidate review and installed activation remain. Same-account
shell isolation is not claimed. MCP reconnect/new sessions may be needed to load
workspace configuration. Crash detection uses lease expiry when SessionEnd is
absent. Existing task retention/claim behavior is reused; no new expiry or
cancellation guarantee is introduced.

Final focused verification after policy rotation, cleanup and path hardening:
78 passed, zero failed, zero skipped (attachments, discovery, host/CLI, Claude
MCP/wake, server/client and bundle closure). Whitespace check passed. The final
attachment test also checks journal bytes for raw harness session UUIDs.
