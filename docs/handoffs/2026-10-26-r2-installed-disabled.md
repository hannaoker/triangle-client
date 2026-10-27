# R2 local attached-chat acceptance — 2026-10-26

Status: tested local attached-chat slice accepted; candidate installed and running. New pin admission is disabled and all temporary sender grants are removed. PR #137 merged as `b1c894696ae929dc742a432c0b6762f025a09872`. Installed code was verified equivalent to the merge. Permanent activation and broader grants were not authorized by the canaries.

Runtime code: `9547620`. Native helper code is unchanged from reviewed `98be801` (installed from documentation head `14c891b`). Later commits update evidence only.

## Scope

Receiver-built local-attested provenance and transactional reply-route pins apply only to attached session-to-session requests. They preserve the original sender and reject identity reassignment or generation regression. Unbound principals/authority remain null. Worker profiles and the bound desktop sender remain legacy/unpinned. No remote Iroh/MESH provenance or mapped session principals are claimed.

Existing access controls still apply. Claude-to-Claude senders are not supported by the current policy schema. The tested Claude-to-Codex route used an explicitly owner-approved temporary exact Claude sender entry in the workspace-wide Codex receiver policy. This was not an exact target-only grant. The original allowlist was restored after every bounded test window.

## Source and review evidence

- All 258 relevant source tests pass, including actual socket/HMAC/journal tests, atomic rollback/reopen, attachment races, stale-child denial, bounds and both admission-switch retry directions.
- Native Swift host suite passed, including v13 refusal/v14 acceptance when a disabled policy exists.
- Gemini 3.8 Flash (Medium) independently reviewed `98be801` with no blockers; it reported 11 R2 tests, 70 packaging/inventory/host tests, and successful native host tests.
- Follow-up regression reproduced duplicate_id_conflict when exact pinned requests were retried with new pin admission disabled. Fix `9547620` retains trusted server-fetched route context and verifies live identities. Existing legacy messages remain unpinned on retry after enablement. Gemini independently reviewed this small correction, ran its socket test, and found no blockers.

## Installed evidence

Public ad-hoc helper/client signatures and watch CLI surfaces verified. Manifest v14 is staged and validated for supervisor (90 artifacts) and Codex/Hermes/Antigravity workers (92 each). The frozen triangle-local validator wrapper was refreshed. All four installed hashes for the retry-fix modules match `9547620`.

Machine record: `~/Library/Application Support/The Triangle/releases/r2-install-verification.json`.
Private backups beneath the same root:

- `archive/r2-install-20261027T041803Z`: pre-v14 installation, including the original 65 message-state tuples.
- `archive/r2-install-20261027T043620Z`: pre-retry-fix v14 state, including the completed canary pin.

Archive names use UTC; this acceptance occurred October 26 in America/Los_Angeles. Restoration rehearsal remains owner-waived. The service stop script can report failure while launchd is still SIGTERMed; actual removal was verified before staging.

The private client/reply-identity.json policy persists even when disabled. Updated native and Python validators refuse pre-v14 runtime-only downgrades while it exists. This does not protect deliberate owner deletion of policy or replacement of both validators/helper and runtime. Never send pinned work through an old v13 reader.

## Live request, reply and restart

Owner supplied live Claude sender:
`session-2626b03bf106b80446c258de751c5b008ca861894a5f1fbd03881a05b5cf6a5f`

Owner supplied live Codex recipient:
`session-321051ea845d1891920a4d32839d589f442c629135067c11655bfeec0344ccab`

Native journal independently verifies:

- Request r2-pair-canary-20261026-01 was sent by that Claude session to that Codex session and completed.
- Reply r2-pair-reply-20261026-01 returned exact R2_ATTACHED_PAIR_OK_20261026 to the original Claude sender, with matching requestId/inReplyTo. Claude consumed it. Request-to-reply time: 19378 ms.
- Request and reply persist native senderProvenance with correct authenticated peers, session generation 1, local-attested/unbound assurance, null principals/authority, and a matching original-sender reply pin.
- With the temporary grant removed and new pin creation disabled, a supported restart preserved the identical pin and completed consumed result.
- Claude's exact R2_CLAUDE_PAIR_CONFIRMED setup report was received and consumed by the bound Codex chat.

Both chats initially acknowledged/accepted wakes without executing the setup tasks. The owner directly authorized the canary inside the chats. Wake acceptance was not counted as execution, and this is not unattended idle-chat acceptance.

## Live retry after restart and disablement

The first retry setup, r2-retry-setup-20261026-01, had a 120-second permission window. Its late report was recipient_not_allowed after the original allowlist was restored. It is not a successful duplicate test. That setup and its report are now completed/consumed.

The second setup, r2-retry-setup-20261026-02, reused only the original canary IDs/text, with admission still disabled and a bounded 600-second temporary grant. The owner explicitly approved that exact retry inside Claude. Claude reported accepted=true, isDuplicate=true, status/state=completed and route=local, including the unchanged original provenance. The owner relayed the tool result as well.

Separately from that reported receipt, the test's native database snapshot independently proved that the original message, its sole consumed reply and its reply pin remained identical. No additional canary record or reply was created. The grant was removed as soon as the report arrived; the original allowlist was independently verified. Bound Codex retrieved and consumed the exact report r2-retry-setup-reply-20261026-02 and acknowledged its wake.

## Final state and remaining decisions

- Service running; new pin admission disabled; original receiver allowlist restored.
- All 65 pre-install message phase/updated_at tuples unchanged. Original 14 pending replies and two held tasks untouched. Test reports consumed and retry setup tasks completed.
- Local attached-chat request/reply, persistence and duplicate retry have the evidence above. The duplicate receipt itself is a Claude/tool report; no-reexecution/state preservation is independently journal-verified.
- Permanent activation/grants, unattended execution acceptance, mapped session principals, worker/bound-desktop R2 provenance, and remote transports remain follow-ups. They are not implied by this accepted local slice.
