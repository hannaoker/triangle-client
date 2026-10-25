# PR #117 installed supervisor acceptance

2026-10-24, approximately 21:25–21:31 America/Los_Angeles. Candidate code:
`c31d305`. **Passed: installed Grok-to-Codex, Grok-to-Antigravity and Grok peer
canaries.** Claude live acceptance and the provider lifecycle checks remain open.

## Installation and custody

Installed the native helper/client, managed `triangle-local` wrapper and immutable
supervisor bundle from the candidate. Manifest v12 has 81 artifacts, bundle digest
`8f0bd7c649564907ac75b9f8c1d221075c9b96fb3711073dc6864ce67ed25318`.
Native signatures and portable file custody checks passed. Used the existing
`dev.thetriangle.client` service; no second daemon or app-server was started.

The service stop command reported failure because its immediate launchctl check
still saw the job; a subsequent launchctl check confirmed the job absent and the
local socket was unavailable before configuration changes. Start then passed its
readiness gate. The previous binaries, manifest, wrapper and local configuration
are retained privately in `/private/tmp/triangle-pr117-installed-sk_q7k0a`.
The baseline journal had 33 completed requests, 14 pending replies, two held tasks
and no queued or executing work. No database reset or identity enrollment occurred.

Paired the existing Grok Bob and Tech Lead conversations from their previously
verified context hashes. Each received a distinct installation-derived address
and exact directional grants. Enabled the existing desktop inbox for Bob only,
with the owner's explicit choice of the already-bound Codex conversation.
Discovery and workspace session messaging remain disabled.

## Grok to Codex

Bob's actual local command tool invoked the installed CLI, using its inherited
context and private pairing. Request `installed-grok-codex-pr117-20261024-01`
was admitted under Bob's identity, not the desktop identity.

The owner-authorized receiver was prepared in a separate completed turn and idle
before the send. Triangle's own automatic wake started the receiver's next turn.
The receiver checked the exact sender/message, claimed only that request, replied
`CODEX_INSTALLED_GROK_OK_PR117` and acknowledged the exact wake/generation.
An independent read-only journal query verified the correlated reply and completed
request. No peer body instruction was needed for receiver execution.

Recorded UTC journal/app times:

| Event | Time |
| --- | --- |
| Bob request committed | 2026-10-25 04:26:09.359 |
| Automatic Codex turn started | 2026-10-25 04:26:13 |
| Codex reply committed | 2026-10-25 04:26:41.284 |
| Receiver turn completed | 2026-10-25 04:26:48 |

Request-to-turn-start was approximately 3.6 seconds; request-to-reply commit was
31.925 seconds. This includes the receiving model's authorization and command
work; it is not a transport-only latency measurement. Bob subsequently retrieved
the exact correlated reply and consumed it at 04:27:40.051 UTC.

## Grok to Antigravity

Tech Lead invoked the installed CLI through its own local tool. Request
`installed-grok-gravity-pr117-20261024-01` was committed at 04:26:50.959 UTC.
The real `gravity2` worker executed it and committed exactly
`ANTIGRAVITY_INSTALLED_GROK_OK_PR117` at 04:27:33.869 UTC, 42.910 seconds later.
Independent journal evidence confirmed both identities and correlation. Tech Lead
then retrieved that exact reply and consumed it at 04:28:27.183 UTC.

This exercised the existing installed dispatcher/worker path, unlike the inert
worker guard in the earlier disposable source-host test. It proves the fixed
reply canary, not an arbitrary coding task or GitHub operation.

## Backlog isolation

An independent read-only aggregate check used the pre-install baseline timestamp.
Across all pre-existing messages and replies, zero `updated_at` values changed
after that baseline. The original 14 replies remained pending and both held tasks
remained held. The check did not retrieve their content.

## Installed Grok peer exchange

Bob sent `installed-grok-peer-pr117-20261024-01` to Tech Lead at
04:27:40.210 UTC. Tech Lead used its own local tool and inherited context to pull
the inbox, verify the exact request, save its claim in a 0600 private file and
commit `GROK_INSTALLED_PEER_REPLY_PR117` at 04:29:04.997 UTC. The reply came from
Tech Lead's distinct Grok identity and correlated to Bob's original request.
Independent journal evidence confirmed the completed request and exact reply.
The 84.787-second interval includes waiting for the owner to initiate Tech Lead's
pull turn; it does not measure an automatic Grok wake.

Bob retrieved the exact peer reply and consumed it at 04:30:51.753 UTC. He then
retried the original request with identical IDs and body through the installed
CLI, which returned `status:completed,isDuplicate:true`. The independent journal
still contained exactly three installed canary requests and three replies, all
completed/consumed. Final status: zero queued/executing work, 36 completed requests,
the original 14 pending replies and two held tasks, wake idle.

The private `installed-evidence.json` beside the rollback snapshot contains only
the selected canary rows, metadata and aggregate assertions. No capability or
claim token is included. The directory also contains private operational files;
do not upload it. Both Grok conversations were idle after the final checks. The
installed candidate and owner-selected pairings remain enabled; the PR is draft.

## Validation and remaining boundaries

- Independent review's two P2 findings were fixed and rechecked; see the separate
  independent-review record.
- Final Grok/local-messaging/bundle-closure checks: 191/191 passed.
- The earlier broader source validation passed 360/360; the two review regressions
  were added afterward and are included in the final focused run above.
- Native launcher validation previously passed 11/11; no native code changed in
  the review follow-up.
- Claude live acceptance remains unproved; no current Claude session was selected
  or granted new access for this test.
- Grok wake remains unimplemented: Grok turns and reply pulls are owner-initiated.
  Codex's existing automatic wake is independently exercised here.
- Provider/app restart, routines, sleep and denied local command approval remain
  separate version-pinned acceptance work. No hosted MCP or MESH bridge is enabled.
