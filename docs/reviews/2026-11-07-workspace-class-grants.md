# Workspace class grants implementation verification

Candidate branch: `claude/workspace-class-grants`, based on main `0452f13` (PRs #158 and #159 merged).
At review time this was a source candidate: nothing was installed, no live policy or grant was changed, and no Mini state was
touched. It was merged to main as `3267715` (PR #160) on 2026-11-07 and installed on the Mini the same day, supervisor runtime
only, with no class grant applied (see "Installation"). The acceptance run is recorded under "Acceptance result".

## Behavior

Session policy version 3 adds `classGrants` (`[{senderHarness, recipientHarness}]`; only `claude` to `codex` and `codex` to
`claude`, at most those two, no duplicates, no extra keys) and a `classRevision` counter. While a class grant stands, every
live attached session of the sender harness in the opted-in workspace may start a conversation with every live attached
session of the recipient harness, so a new chat on either side needs no new grant.

The broker applies it at the three points an exact pair uses: the delivery directory, the credential's recipient claim and
the authoritative send-time check. It applies to session addresses only, never to a hex principal, an ended session, the bound
Codex conversation or a harness messaging itself. Replies still follow claim custody. A reader admitted only by a class grant
is listed only the chats it can reach now. Exact pairs and the workspace-wide sender lists are unchanged and independent.

The owner CLI adds `grant-session-class` (plan, then `--confirm PLAN_ID`) and `revoke-session-class`; `list-session-grants`
reports `classGrants`. Exact grant and revoke keep a version 3 policy at version 3. `setup-session-messaging` keeps class
grants, reports them, drops the ones into a harness under `--exact-only`, and repairs a version 3 file that an older setup
rewrote without the class fields (it can only remove authority).

## The gate, and what it does not do

Creating a class grant needs the printed plan id and both stdin and stdout to be terminals, the "terminal plus plan id" gate
(D5-B) that `identity migrate --confirm` uses. The plan id covers the whole policy except `secret`, including `classRevision`,
which grows with every class grant change, so a printed plan cannot be replayed after a grant and its revoke.

This is a confirmation step, not a security boundary. It stops scripts, agent shells and anything that captures output. It does
not stop a process that opens a pseudo-terminal: a pty from Python's standard library applied a grant on disposable state (see
Verification). Nothing protects the policy file itself from a process running as the same user.

OS authentication (D5-A) is not included. The owner-approval helper validates its action and summary in Swift and accepts only
identity operations, so teaching it this one changes the native helper, the release manifest and the owner's live acceptance.

The approved D5 decision (C) reserves D5-B for first-time profile bindings and asks for D5-A for chat mappings. A class grant is
authority by harness and workspace with no per-chat confirmation, the shape identity rule 3.A.3 refuses to accept for mappings.
No recorded owner decision covered using D5-B here until 2026-11-07, when the owner accepted it for class grants after this
was put to them (see Owner decisions).

## Verification

- Focused: `local-session-codex.test.mjs` passes all 32 tests. The 24 earlier tests are unchanged; 8 are new (policy schema;
  plan, confirm and replay; the CLI program without a terminal; the stdin and stdout checks; end-to-end admission of new
  sessions in both directions, with harness scoping and directory limits; ordinary setup and exact-only; setup repair;
  dormant grants).
- Mutation: 22 mutants of the new logic (policy schema, harness scoping, terminal and stale-plan checks, revision bumps,
  version preservation, setup keep, repair and exact-only, directory limits, dormant flag, error detail, secret in the plan
  digest), all caught. An earlier 12-mutant pass had one survivor, the secret in the plan digest. The independent review
  then found a survivor class, a class grant that ignores the recipient harness, which a Claude-to-Claude denial and a
  directory assertion now catch.
- Full worker suite: 1301 tests, 1297 passed, 3 skipped, 1 failed. The failure is
  `host probe compares pid and exact start time...` in `local-session-discovery.test.mjs`. It fails identically at baseline
  `cb80b1a` (no class grant change) in this execution environment, which restricts the `ps` probe it exercises.
- The real CLI program on disposable state, with no live policy: the plan printed and wrote nothing; applying with no terminal
  was refused with `owner_terminal_required`; applying under a Python pty succeeded and produced a version 3 policy.
- Not run at review time: installed acceptance, any live OS prompt, anything on the Mini (the install is recorded under
  "Installation").

## Independent review

A read-only reviewer (Claude Opus, one pass, 94 tool calls, reproduction scripts on disposable state) checked the first commit.
This is a model review, not a human or Codex review. It found no over-grant in any authorization path (principals, ended or
detached senders, the bound conversation, same-harness targets, disabled harnesses, stale credentials all refused) and no
writer that mishandles a valid policy. Its findings and what became of them:

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | A revoked grant could be re-applied with an old plan id (the id hashed only current content) | Fixed: `classRevision` joins the plan; test replays a plan after grant and revoke |
| 2 | The terminal check looked at stdin only; docs said it stops pipes; D5 does not back using the weaker gate | Fixed: stdin and stdout both required; docs say plainly that no owner decision backs D5-B here; open decision below |
| 3 | An older setup rewrote a version 3 policy without the class fields and neither release could repair it | Fixed: setup repairs such a file; docs warn against running an older setup against version 3 |
| 4 | A class grant listed every recipient-harness chat, idle and ended ones with their titles | Fixed: class-only readers see reachable chats only; test covers an idle and an ended chat |
| 5 | A grant applied before the recipient harness is set up activated silently later | Fixed: plan and apply report `dormant`; the setup result lists `classGrants`; not refused, because ordering is the owner's |
| 6 | Tests never proved scoping to the recipient harness (mutant survived) | Fixed: Claude-to-Claude denial, directory assertion, harness-off test; 22 of 22 mutants caught |
| 7 | The sender's harness is whatever its registration claimed, so a class grant is easier to forge than an exact pair | Documented: inside the same-account boundary; not fixable here |
| 8 | The class commands printed raw errors, including absolute paths | Fixed: detail only for the command's own codes; test with a missing config |
| 9 | Doc nits and the `visible_only` hint mentioned exact grants only | Fixed |

Not adopted from the review: refusing SSH sessions as `identity revoke` does. That check exists there because the OS prompt
needs a GUI session. Here it would stop an owner who administers the Mini remotely, and the gate is a confirmation step either
way; the owner decided on 2026-11-07 not to add it (see Owner decisions).

## Owner decisions

1. **Decided 2026-11-07, in chat:** the terminal-plus-plan-id gate (D5-B) is accepted for class grants. The owner chose it over
   waiting for D5-A (OS authentication), knowing that it is a confirmation step and not a boundary: a pseudo-terminal passes it
   and a process running as the same user can edit the policy file. D5-A stays a possible follow-up, not a precondition. The
   choice covers class grants only; it does not move the D5 decision (C) for identity chat mappings.
2. **Decided 2026-11-07, in chat ("Don't refuse SSH"):** applying a plan does not refuse SSH sessions. It keeps needing only a
   terminal on stdin and stdout plus the plan id, so it works over an SSH pseudo-terminal. `identity revoke --confirm` refuses
   when `SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY` is set (`packages/triangle-cli/src/cli.mjs`) because its OS password prompt
   needs someone at the Mac; this gate has no such prompt, and an environment check would be trivially bypassed. No code change.

Residual risk, unchanged by the gate: any live session of the sender harness in the workspace, including one that has read
untrusted content, can wake a recipient-harness chat and obtain an answer with no person in the loop, because Codex pre-approves
its inbox tools. An exact pair limits that to a chosen chat.

## Upgrade and rollback boundary

Applying the first class grant migrates the private policy to version 3. Older readers reject it: attached sessions disappear
from listings and the supervisor logs `Workspace session messaging unavailable (invalid_session_policy)`, while configured
recipients keep working. Install a matching supervisor, CLI and session MCP runtime, and reload existing MCP children, before
applying. Revoke retains version 3, so rollback needs a compatible private policy together with its matching runtime, or
disabling messaging. Do not run an older `setup-session-messaging` against a version 3 policy.

## Installation (2026-11-07)

The owner asked for the install in chat after the merge. Main `3267715` was installed as the supervisor runtime only.

- Bundle: `4d0a391d51a090fcfc5eda3db93a6ccb180c8b1dc22fb1753951db2a6dce56a2` (from `77fcf89`) became
  `7eb3b2f091562aa4b97a724cd042acb1d8719c101e48eb66a69e1f9609e71026` (from `3267715`). Manifest v14, the same 90 artifacts, the
  same Node. Exactly three artifacts differ: `local-messaging-cli.mjs`, `local-messaging-interactive-session.mjs` and
  `local-messaging-server.mjs`; a dry run in a scratch application root, compared with the old live manifest, showed exactly
  that set. The codex, hermes and antigravity manifests were not restaged: no worker runner imports those files.
- Before: a `git archive` snapshot of `3267715` passed `local-session-codex.test.mjs` (32 of 32) and the
  `supervisor-runtime-bundle` and `worker-bundle-closure` suites (27 of 27). The quiet gate was open (executing 0, dispatcher
  idle, wake idle); the standing backlog (`queued_local` 1, held 2, queued 1, `pendingReplies` 14) was left alone. The live
  supervisor manifest, `session-messaging.json`, `local-messaging.json` and the status were copied to
  `archive/class-grants-20261107T181637Z/`.
- Procedure: `stage-runtime --agent supervisor` into the live application root, `validate-runtime`,
  `triangle-client-service.sh start` with a 60 second readiness timeout, status and grant checks, then `commit-runtime`. The
  script was set to roll back (`rollback-runtime` and a restart) on any failure before the commit; none was needed.
- After: one supervisor process from the new bundle with launchd running; `validate-runtime` OK; journal counts identical to the
  baseline; wake idle; 13 discovered sessions; the router still enabled. The two policy and config files are byte-identical to
  the pre-install copies (policy version 2). The installed `list-session-grants` reports `classGrants: []` with both exact
  pairs unchanged. `grant-session-class` without `--confirm` printed a plan (`applied: false`, `dormant: false`) and wrote
  nothing. A Claude chat running an older session MCP child still listed its Codex exact pair and `gravity2`.
- Not done: no class grant was applied or confirmed, and the live policy is unchanged. Two session MCP children started before
  the install (one Claude chat, one Codex Desktop chat) still run the old bundle; reload them before the first grant is applied
  (see "Policy and rollout" in the runbook).
- Rollback: restore `supervisor.manifest.pre.json` from the archive directory over `worker-runtime/supervisor.manifest.json`
  (mode 0600, atomic write), then run `TRIANGLE_READY_TIMEOUT_MS=60000 scripts/triangle-client-service.sh start`. The old
  bundle is still on disk; the rollback record was consumed by `commit-runtime`.
- Record: `~/Library/Application Support/The Triangle/releases/class-grants-install-verification.json`.

## Owner acceptance once installed

Status 2026-11-07: run the same day on fresh chats; the result is under "Acceptance result" below. The steps stay here as the
checklist for the next install.

On fresh chats, in a real terminal: print the plan and read its `dormant` and `effect`; apply it; from a new Claude chat and
a new Codex chat that never had a grant, check that the Claude chat lists the Codex chat after one heartbeat, sends, and gets
the correlated reply; check that Claude to Claude is refused and that an ended Codex chat disappears from the directory; revoke,
and check that the next send reports `recipient_not_allowed`; confirm `list-session-grants` shows `classGrants: []` and the
policy stays version 3. Record the result beside this note.

## Acceptance result (2026-11-07)

Run at the owner's request in chat, from a fresh Claude chat (`the-triangle-d5`, 4886e6ab) against the live Codex chat 12de4548.
Neither chat appeared in an exact pair. At the start the supervisor and all four session MCP children ran the installed bundle
`7eb3b2f0…`, no `4d0a391d` process remained, and the older Claude chat 4b4cd69b and Codex chat 219b4f0f had ended.

A separate install of main `cc929a0` (PR #145, `grok wait`) moved the supervisor to bundle `9034909d…` at 21:23:36Z, partway
through; it changes only `grok-local-session.mjs` and `local-messaging-cli.mjs`. The apply, directory, send and reply, and
Claude-to-Claude steps (reply at 21:19:51Z) ran on the first supervisor. The revoke (policy file rewritten at 21:27:33Z) and the
refused send after it ran on the second, with this Claude chat's own session MCP child still on `7eb3b2f0…`.

- Plan: `grant-session-class --sender-harness claude --to-harness codex` printed plan `49a5c839…` (`applied: false`,
  `dormant: false`) and wrote nothing. Before the apply the Claude chat's directory listed only `gravity2`.
- Apply: done in the owner's terminal step; the command itself was not observed. The live policy then read version 3 with
  `classGrants: [{claude, codex}]`, both exact pairs unchanged and `requiresServiceRestart: false`.
- Directory: the Claude chat then listed the Codex chat (online, attached, `send.permitted`), no ended Codex chat and no Claude
  chat. The delay after the apply was not timed; the first listing after it already showed the chat.
- Send and reply: message `1575003d…` was accepted (`queued_local`), showed `notified_unclaimed` right after the send and
  `completed` once the reply arrived. The correlated reply read `class-grant acceptance ok 01a1b7d5`; it was consumed and the
  wake acknowledged. The body's short id is not the label id (12de4548); the envelope sender was the 12de4548 address, which
  is what the check relies on.
- Claude to Claude: a send to the other live Claude chat (fd5b502d) failed with `recipient_not_allowed` and stored nothing
  (`not_found` on a status lookup).
- Revoke: `revoke-session-class --sender-harness claude --to-harness codex` needs no `--confirm` and no terminal; it returned
  `changed: true` and `minimumPolicyReaderVersion: 3`. `list-session-grants` then showed version 3, two exact pairs and
  `classGrants: []`. The Codex chat left the directory on the next listing, and the next send failed with
  `recipient_not_allowed`.
- End state: revoked, policy still version 3. Re-applying needs a new plan: the revoke advanced `classRevision`, so the earlier
  plan id is stale.
- Not covered: OS authentication (D5-A) is not part of this change, applying over SSH was not run, and the heartbeat delay was
  not timed.
- Record: `~/Library/Application Support/The Triangle/releases/class-grants-acceptance.json`.
