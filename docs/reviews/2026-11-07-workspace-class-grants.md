# Workspace class grants implementation verification

Candidate branch: `claude/workspace-class-grants`, based on main `0452f13` (PRs #158 and #159 merged).
Source candidate only. Nothing is installed, no live policy or grant was changed, and no Mini state was touched.

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
No recorded owner decision covers using D5-B here. That decision is open (see below).

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
- Not run: installed acceptance, any live OS prompt, anything on the Mini.

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
way; the owner can ask for it.

## Owner decisions still open

1. Whether the terminal-plus-plan-id gate is enough for class grants, or class grants wait for D5-A (OS authentication).
2. Whether to refuse SSH sessions for applying a plan.

Residual risk, unchanged by the gate: any live session of the sender harness in the workspace, including one that has read
untrusted content, can wake a recipient-harness chat and obtain an answer with no person in the loop, because Codex pre-approves
its inbox tools. An exact pair limits that to a chosen chat.

## Upgrade and rollback boundary

Applying the first class grant migrates the private policy to version 3. Older readers reject it: attached sessions disappear
from listings and the supervisor logs `Workspace session messaging unavailable (invalid_session_policy)`, while configured
recipients keep working. Install a matching supervisor, CLI and session MCP runtime, and reload existing MCP children, before
applying. Revoke retains version 3, so rollback needs a compatible private policy together with its matching runtime, or
disabling messaging. Do not run an older `setup-session-messaging` against a version 3 policy.

## Owner acceptance once installed

On fresh chats, in a real terminal: print the plan and read its `dormant` and `effect`; apply it; from a new Claude chat and
a new Codex chat that never had a grant, check that the Claude chat lists the Codex chat after one heartbeat, sends, and gets
the correlated reply; check that Claude to Claude is refused and that an ended Codex chat disappears from the directory; revoke,
and check that the next send reports `recipient_not_allowed`; confirm `list-session-grants` shows `classGrants: []` and the
policy stays version 3. Record the result beside this note.
