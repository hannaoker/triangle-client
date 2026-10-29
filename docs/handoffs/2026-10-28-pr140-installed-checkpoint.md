# PR140 installed checkpoint

- PR: https://github.com/hannaoker/triangle-client/pull/140 (draft)
- Branch/worktree: `codex/messaging-status-ux`, `/Users/zhenyuhou/Projects/The Triangle/worktrees/messaging-status-ux`
- Installed source head: `bd357a37273922511589f70d1acc5c82c1246154`.
- Candidate is installed and running on the existing Mini supervisor. Supervisor
  90 artifacts; each Codex/Hermes/Antigravity bundle 92; hashes verified.
- Record: `~/Library/Application Support/The Triangle/releases/pr140-install-verification.json`.
- Backup: `~/Library/Application Support/The Triangle/archive/pr140-20261029T051933Z`.
- Service stop initially took longer than the three-second guard, so no staging
  occurred on that attempt. The stop was confirmed and the successful transaction
  allowed ten seconds. No rollback was needed.
- Installed read-only CLI checks passed for completed, held and queued requests;
  all current directory entries have delivery explanations, and Grok is pull-only.
- Exact equality with the pre-install snapshot: all 78 message rows, 75 reply
  rows and one reply-route row; local config and session policy byte-identical.
  Old 14 pending replies, 2 held tasks and 1 queued request were not acted on.
- Other edge states (notification matching, expired leases, framing) are source
  test evidence, not new installed canaries. See existing review record for full
  test counts and independent review.

Acceptance documentation is now incorporated into the source review and runbook.
The owner chose to continue with Codex after the quota pause. No additional tests,
messages, installation or grant changes are needed for merge preparation.
Merge remains a separate owner action; this checkpoint grants no blanket permission.
