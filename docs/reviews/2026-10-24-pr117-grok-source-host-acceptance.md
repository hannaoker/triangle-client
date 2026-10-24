# PR #117: live Grok source-host acceptance

2026-10-24, approximately 14:00–14:08 America/Los_Angeles.
Status: **passed for the disposable source-host path**. PR remains a draft;
installed-supervisor acceptance and independent code review are still open.

## What actually ran

Two existing Grok Bot 0.75.5 conversations, Bob and Tech Lead, invoked the candidate
`local-messaging-cli.mjs` through their real LOCAL command tools on the Mini.
Neither had its environment IDs supplied or overridden by Codex. Each participant
used a separate private pairing and exact grants to the other participant.

The transport host was a disposable Node fixture importing the real
`createInstalledLocalMessagingHost` and concurrency gate from the PR worktree.
It had its own config, journal, socket and synthetic owner identity. The required
worker slot was an inert guard that would fail and leave an evidence marker if
invoked; it was never invoked. The real reasoning participants were the two Grok
conversations. Codex did not send, claim, reply or consume on their behalf.

Codex used the app UI to issue tightly bounded owner canary instructions. Every
Grok turn was manually initiated for this test. No native Grok bot handoff,
automatic wake, MESH content bridge, production configuration or production
service restart was used. This is **not** proof of the packaged/installed path.

## Evidence and results

| Check | Evidence | Result |
| --- | --- | --- |
| Two provider contexts | Each bot executed a metadata-only probe, creating a fresh local file with format/presence and SHA-256 only. Both observed values had the supported lowercase UUID v4 shape; hashes were distinct. | Pass |
| Owner-side pairing | Actual `setup-grok --context-hash` CLI calls created separate private bindings. The owner did not need raw provider IDs. | Pass |
| Bob initiates | `grok-bob-request-afprx5zo` admitted under Bob's Grok identity, addressed to Tech Lead, with `recipient_type=interactive`. | Pass |
| Queued delivery across host restart | Journal showed Bob's request `queued_local`; host stopped at 14:03:00 and restarted before Tech Lead pulled it. The request was later claimed and answered once. | Pass |
| Wrong-context denial | Tech Lead's actual `grok status --alias bob` returned exit 1 and `grok_context_mismatch`. A repeated check captured stdout, stderr and exit status into local files, which Codex independently read. | Pass |
| Tech Lead replies | `reply-tech-lead-afprx5zo` correlated to Bob's original message/request, with the expected sender, recipient and exact owner canary text. | Pass |
| Tech Lead initiates | `grok-tech-lead-request-afprx5zo` was admitted under Tech Lead's separate Grok identity. | Pass |
| Bob retrieves and replies | Bob retrieved and consumed the first reply, then claimed Tech Lead's request and sent `reply-bob-afprx5zo`. | Pass |
| Exact send retry | Bob repeated the original message/request IDs and body. Its observed CLI result was `isDuplicate:true`, status `completed`. Independent journal read still showed exactly two requests and two replies. | Pass |
| Both replies consumed | Bob and Tech Lead each consumed only their correlated reply. Independent journal read showed both replies consumed. | Pass |
| Private claims | Both claim files were 0600. CLI claim output omitted the token; the bots did not print the files. | Pass |
| Final custody | Host status: completed 2, queued 0, executing 0, held 0, pending replies 0. | Pass |
| Cleanup | Both disposable bindings disabled/revoked; candidate host exited at 14:07:47.634. Socket absent. Journal retained for evidence. | Pass |

The private local evidence directory is
`/private/tmp/triangle-grok-acceptance-afprx5zo`.
`verified-evidence.json` contains the independently checked non-secret journal
fields and final assertions. This directory also contains private capability and
claim files: do not upload or commit it. Raw provider conversation IDs were not
written into it. Full app transcripts and unrelated chat content were not saved.

## Recorded times

Journal timestamps, in America/Los_Angeles:

| Event | Time |
| --- | --- |
| Bob request admitted | 14:02:20.924 |
| Tech Lead reply committed | 14:04:15.842 |
| Tech Lead reverse request admitted | 14:04:24.010 |
| Bob consumes Tech Lead reply | 14:05:34.337 |
| Bob reply committed | 14:05:48.006 |
| Tech Lead consumes Bob reply | 14:07:06.898 |

These intervals include deliberate host restart, manually issued UI prompts,
model turns and explicit pull timing. They are not transport latency measurements
or evidence of automatic wake. The complete probe-and-canary sequence took about
seven minutes.

## Verification and implementation change

Live preparation exposed a useful setup gap: owner-side pairing should accept a
metadata probe's hash instead of requiring the raw provider ID or asking a bot to
create its own pairing. Added the mutually exclusive `--context-hash` setup option.
Runtime operations still require the actual inherited context and private
capability. Passing a hash as a runtime argument does not authenticate a caller.

After that change, 360/360 focused Node checks pass, including the new hash-pairing
and wrong-context cases. The preceding v12 native launcher validation passed
11/11 tests; no native code changed in this acceptance follow-up. The previous
comparison verified all 31 historical exact artifact sets unchanged.

## Remaining gates

- Independent review of #117, including the new pairing option and permissions.
- Packaged candidate through the existing installed supervisor, with rollback.
- Live Grok-to-Codex and Grok-to-Claude acceptance; only automated fixture coverage
  exists for those peer types in this PR.
- Provider metadata after app restart, routine execution, local approval denial,
  background commands and app sleep. Host restart here is not app restart proof.
- Automatic wake remains a later PR. This test deliberately used explicit pulls.
