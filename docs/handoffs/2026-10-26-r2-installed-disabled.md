# R2 installed with admission disabled — 2026-10-26

Candidate code: `98be801`; installed source/documentation head: `14c891b` on draft PR #137. Candidate installed and exercised with an owner-authorized attached-chat canary. PR #137 is not merged; permanent activation is not authorized. See the final acceptance sections below for current state.

## Verified installation

- Built and installed native helper/client through the public ad-hoc installer with portable file custody. Both signatures and watch CLI surfaces verified.
- Staged and validated manifest v14 for supervisor (90 artifacts), Codex, Hermes and Antigravity (92 each). Refreshed the frozen triangle-local validator wrapper.
- Restarted the supported client service. Installed status reports running and replyIdentity enabled=false, scope attached-chat-pairs.
- Ran the installed `setup-reply-identity --disable` command, creating the private disabled policy and its persistent runtime floor. New pin admission remains off.
- Verified all 65 pre-install message rows retain exact phase and updated_at. Journal still has one queued prior test, 62 completed, two held tasks and 14 pending replies. No reply pins exist. No older replies or held tasks were consumed or claimed.
- All 258 relevant source tests passed. Native host suite passed including v13 denial/v14 acceptance with disabled policy. These are separate from a live attached-chat canary.

Machine evidence: `~/Library/Application Support/The Triangle/releases/r2-install-verification.json`. Private backup: `archive/r2-install-20261027T041803Z` beneath the same root. Earlier snapshot attempts failed before a usable SQLite backup because the shell's old Python lacked backup support; the completed snapshot uses `/usr/bin/python3`. The service stop command returned its known "did not stop" error, but launchctl confirmed the job was absent before installation. Restoration rehearsal remains owner-waived.

## Original installation gates (historical; completed below)

1. Obtain a usable current-code independent review. The restricted Gemini run stalled on denied writes to its own session files and was stopped. A normal-access retry is running; its only output so far says it is waiting for a background test. This is not a completed review or no-blocker finding.
2. The owner has been asked to open a second Claude Code chat in The Triangle workspace and call triangle_get_status. Only one attached chat was reachable at preparation time. Do not impersonate the bound Codex desktop identity as an attached session.
3. Once two authorized live attached chats are available, enable via installed setup command; run one narrowly correlated request/reply, verify native provenance/pin/journal completion, then exercise restart and retry. Preserve all old backlog. Do not infer successful execution from wake acceptance.
4. Record results, resolve review findings, and only then merge/promote. Mapped session principals, worker/bound-desktop R2 provenance and remote transports remain unsupported.

The operational runtime floor applies through the updated helper and validator while the policy path exists, even disabled. It does not protect deliberate owner deletion of policy or replacement of both validators and runtime. Never roll pinned work back to an old reader that ignores pins.

## Live acceptance preparation and permission boundary

The owner opened a second Claude chat, session-2626b03bf106b80446c258de751c5b008ca861894a5f1fbd03881a05b5cf6a5f (raw session 87abd7c9-effd-4dfe-8250-fa6e34254686, generation 1). Its first status call hit ENOENT while installation had the service stopped. After restart, the real control socket exists and the owner confirmed triangle_get_status succeeds. This is attachment evidence, not pinned execution.

Inspection of the actual permission policy shows both Claude and Codex receiver allowlists currently contain only the bound Codex identity. The attached chat pair is therefore not authorized; do not enable or bypass ACLs to force the canary. Claude-to-Claude senders are not supported by this policy schema. The existing Codex receiver policy can name an exact attached Claude sender, but that is a workspace-wide Codex receiver grant, not an exact target-only grant. A scratch Codex address has been requested; before any grant change, make that scope clear to the owner or use an isolated disposable policy. Source tests cannot substitute for this live gate. R2 admission remains disabled.

## Completed installed canary and cleanup

Gemini 3.8 Flash (Medium) completed review of code commit `98be801` with no blockers. It reported 11 focused R2 tests, 70 packaging/inventory/host tests, and successful Swift host execution. No review result was inferred from its earlier progress-only output.

The owner supplied a scratch Codex attachment, session-321051ea845d1891920a4d32839d589f442c629135067c11655bfeec0344ccab, then explicitly approved a temporary exact Claude sender grant in the workspace Codex receiver policy. Both chats received setup wakes but initially left requests queued; the owner directly authorized the single canary inside both chats before execution. This is not unattended idle-chat execution acceptance.

The installed journal independently proves:

- `r2-pair-canary-20261026-01` was actually sent by Claude session-2626b03bf106b80446c258de751c5b008ca861894a5f1fbd03881a05b5cf6a5f to that attached Codex chat, and completed.
- Reply `r2-pair-reply-20261026-01` returned exact `R2_ATTACHED_PAIR_OK_20261026` to the original Claude sender, with matching requestId/inReplyTo. Claude consumed it. Request-to-reply time was 19378 ms.
- Both records contain native receiver-built senderProvenance with correct authenticated peer, generation 1, local-attested/unbound assurance and null principal/authority. The matching native reply-route pin is persisted.
- Removed the temporary Claude sender grant and verified the original allowlist exactly. Disabled new pin creation through the installed setup command. Restarted the supported service and verified the identical pin, completed message and consumed exact result remain.
- Claude returned `R2_CLAUDE_PAIR_CONFIRMED` to the bound Codex setup request. Consumed only the two exact setup reports. Original 14 pending replies and two held tasks remain; all 65 pre-install message phase/updated_at tuples remain unchanged.

The candidate is installed and running, with new admission disabled and no temporary grant. PR #137 remains draft. Live duplicate retry after restart was not run; it remains source-test evidence, separate from proven live persistence. A permanent grant/default activation decision and unattended acceptance remain outside this one-canary authorization.

## Retry correction installed — 9547620

A stronger regression found an exact pinned resend fails with duplicate_id_conflict while admission is disabled. Fixed in `9547620`: existing pinned retries keep trusted server-fetched route context and still authenticate/verify identities. Legacy unpinned retries remain unpinned when admission turns on. Both directions are covered by the native socket test; all 258 relevant tests pass. Gemini independently reviewed this small commit with no blockers and ran the focused test successfully.

Staged this correction into all four v14 bundles, refreshed the wrapper and restarted. All installed source hashes for the changed modules match `9547620`; no native Swift changes were needed. The pre-update v14 backup, including the completed pin, is `archive/r2-install-20261027T043620Z`. The stop script's immediate launchd query briefly reported SIGTERMed; waited for actual removal before staging.

One bounded live retry check reused the owner-approved temporary sender grant for only the existing canary IDs, with admission disabled. Its setup request `r2-retry-setup-20261026-01` was accepted but remained queued; no Claude result arrived within 120 seconds. The check removed the grant automatically and proved the original canary message, sole consumed reply and pin remained byte-for-byte/state identical. This does not prove a duplicate resend occurred or passed. Do not count the no-response outcome as a protocol regression, either.

Final verified state: service running, new pin admission disabled, original allowlist restored, original 65 message states unchanged, original 14 pending replies/two held tasks untouched. The one new retry setup instruction remains queued; do not claim it using another session or silently delete it. Source regression and installed hash proof cover the correction; actual live retry completion remains an explicit open gate. PR #137 stays draft.

Late retry report: Claude eventually completed `r2-retry-setup-20261026-01` with `recipient_not_allowed: Session receiver policy denies sender.` The report arrived after the bounded check had restored the original allowlist. This is not a duplicate-success proof and does not demonstrate a pin-verification defect; current receiver policy denies the sender before that path. Consumed only `r2-retry-setup-reply-20261026-01` and acknowledged wake `54de8dc0-cf44-4818-9b4b-4befe7536cf3` generation 1. The retry setup is no longer queued. Original 14 replies/two held tasks remain, and admission is still disabled.
