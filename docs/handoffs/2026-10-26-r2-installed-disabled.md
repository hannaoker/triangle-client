# R2 installed with admission disabled — 2026-10-26

Candidate code: `98be801`; installed source/documentation head: `14c891b` on draft PR #137. This is candidate installation, not merged or completed R2 acceptance.

## Verified installation

- Built and installed native helper/client through the public ad-hoc installer with portable file custody. Both signatures and watch CLI surfaces verified.
- Staged and validated manifest v14 for supervisor (90 artifacts), Codex, Hermes and Antigravity (92 each). Refreshed the frozen triangle-local validator wrapper.
- Restarted the supported client service. Installed status reports running and replyIdentity enabled=false, scope attached-chat-pairs.
- Ran the installed `setup-reply-identity --disable` command, creating the private disabled policy and its persistent runtime floor. New pin admission remains off.
- Verified all 65 pre-install message rows retain exact phase and updated_at. Journal still has one queued prior test, 62 completed, two held tasks and 14 pending replies. No reply pins exist. No older replies or held tasks were consumed or claimed.
- All 258 relevant source tests passed. Native host suite passed including v13 denial/v14 acceptance with disabled policy. These are separate from a live attached-chat canary.

Machine evidence: `~/Library/Application Support/The Triangle/releases/r2-install-verification.json`. Private backup: `archive/r2-install-20261027T041803Z` beneath the same root. Earlier snapshot attempts failed before a usable SQLite backup because the shell's old Python lacked backup support; the completed snapshot uses `/usr/bin/python3`. The service stop command returned its known "did not stop" error, but launchctl confirmed the job was absent before installation. Restoration rehearsal remains owner-waived.

## Still required

1. Obtain a usable current-code independent review. The restricted Gemini run stalled on denied writes to its own session files and was stopped. A normal-access retry is running; its only output so far says it is waiting for a background test. This is not a completed review or no-blocker finding.
2. The owner has been asked to open a second Claude Code chat in The Triangle workspace and call triangle_get_status. Only one attached chat was reachable at preparation time. Do not impersonate the bound Codex desktop identity as an attached session.
3. Once two authorized live attached chats are available, enable via installed setup command; run one narrowly correlated request/reply, verify native provenance/pin/journal completion, then exercise restart and retry. Preserve all old backlog. Do not infer successful execution from wake acceptance.
4. Record results, resolve review findings, and only then merge/promote. Mapped session principals, worker/bound-desktop R2 provenance and remote transports remain unsupported.

The operational runtime floor applies through the updated helper and validator while the policy path exists, even disabled. It does not protect deliberate owner deletion of policy or replacement of both validators and runtime. Never roll pinned work back to an old reader that ignores pins.

## Live acceptance preparation correction

The owner opened a second Claude chat, session-2626b03bf106b80446c258de751c5b008ca861894a5f1fbd03881a05b5cf6a5f (raw session 87abd7c9-effd-4dfe-8250-fa6e34254686, generation 1). Its first status call hit ENOENT while installation had the service stopped. After restart, the real control socket exists and the owner confirmed triangle_get_status succeeds. This is attachment evidence, not pinned execution.

Inspection of the actual permission policy shows both Claude and Codex receiver allowlists currently contain only the bound Codex identity. The attached chat pair is therefore not authorized; do not enable or bypass ACLs to force the canary. Claude-to-Claude senders are not supported by this policy schema. The existing Codex receiver policy can name an exact attached Claude sender, but that is a workspace-wide Codex receiver grant, not an exact target-only grant. A scratch Codex address has been requested; before any grant change, make that scope clear to the owner or use an isolated disposable policy. Source tests cannot substitute for this live gate. R2 admission remains disabled.
