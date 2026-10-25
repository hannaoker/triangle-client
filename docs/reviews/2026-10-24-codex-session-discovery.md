# Codex automatic discovery: visibility-only candidate

Status: implementation candidate; not installed in the production supervisor. This is a bounded part of discovery milestone D3, not completion of D3 or Reason parity.

## Fresh desktop evidence

On 2026-10-24, two existing disposable Codex desktop chats in `/private/tmp/triangle-session-discovery-m0-20261023` executed the own-session metadata probe. The first call required and received owner approval. Both calls completed through the app's owning thread; no separate app-server was launched.

| Chat | MCP process PID | Fresh tool-call metadata SHA-256 | Matching lifecycle evidence |
|---|---:|---|---|
| `01a167f5-2cd8-7dd0-be75-1fc9cf976286` | 63878 | `4d86b7c5adf97c332d3615c60c3aca25165cf7f4342b7dc7ef0e179800bd7f33` | SessionStart/resume with same hash |
| `01a167f6-f911-7380-be6e-c64f25e62e5d` | 74767 | `a21c63c30aa955ebff529057d432eb65e8400e14cc812ab6128bc12e9e5a2db8` | SessionStart/resume with same hash |

Each call supplied matching `_meta.sessionId` and `_meta.threadId`. Both MCP processes had no inherited Codex or Claude session identity. The local probe's metadata-only append log independently recorded the calls at epoch milliseconds 1792874853245 and 1792875107273. App-rendered final JSON was malformed (some null/false fields displayed as bare keys), so these conclusions use the raw probe records, not the rendered final answer. This establishes two resumed desktop identities; it does not establish a shared-process case or future-session timing.

The current standalone executable reports Codex 0.164.0. The exact desktop orchestration build was not independently versioned. These observations must not be generalized to every Codex surface or future release.

## Candidate behavior

Owner command:

```
triangle-local setup-discovery --harness codex --workspace /absolute/workspace
```

Existing `--config` and `--local-cli` options allow an isolated installation. The default harness remains Claude. Setup adds only managed SessionStart, UserPromptSubmit and SessionEnd hooks to `.codex/hooks.json`, preserving unrelated hooks and metadata. SessionEnd uses a three-second timeout; other hooks use five seconds. Hook trust remains subject to Codex approval. No trust bypass is used.

A private, owner-managed harness ceiling explicitly admits Codex lifecycle reports. The default legacy policy admits Claude only. Challenges bind the harness as well as the event, session and workspace. Codex directory handles use a harness namespace; legacy Claude handles remain unchanged, including when both harnesses happen to report the same UUID. Raw UUIDs and prompt/transcript content are not persisted by the discovery journal.

Directory entries show `Codex`, workspace basename, and a short session hash. Their receive/wake capabilities remain false, and presence remains unknown until an end event marks them offline. Discovery supplies neither credentials nor a route to send tasks to the new session. Existing manually bound Codex delivery remains separate. The Claude attachment broker excludes Codex discovery rows.

`disable-discovery` revokes the shared capability, removes managed hooks for both harnesses, and removes discovery/session-messaging configuration. It preserves unrelated hook entries. Status reports opted-in harnesses. A second workspace still requires a separate installation; this change does not introduce a global registry scan.

## Compatibility and rollback

The database migration adds `harness TEXT NOT NULL DEFAULT 'claude'`. Existing rows and Claude handles retain their identity and lifecycle. No message, claim or binding migration is introduced. Legacy event normalization/digests remain unchanged for Claude, including explicit `harness: claude` input.

The optional `harnesses` policy field is deliberately rejected by old discovery brokers rather than treated as a new grant. Before rolling back, run the new `disable-discovery`, confirm hook cleanup, stop the candidate owner, and restore the prior release/configuration. Keep automatic discovery and session messaging disabled on the older release: its directory code does not understand Codex rows and could mislabel retained metadata if re-enabled. Existing manually configured messaging remains available. Do not run old and new owners concurrently.

## Validation

The final focused regression command covers `local-*.test.mjs`, `claude-session-*.test.mjs`, and `worker-bundle-closure.test.mjs`. The suite uses a disposable `/private/var/tmp` path for its existing Darwin system-alias test; that test requires filesystem access outside the default sandbox.

Added behavioral coverage:

- Codex reports rejected before explicit opt-in; challenge cannot be reused under another harness.
- Same UUID in both harnesses produces distinct handles and independent end state.
- Mixed hooks coexist, setup is idempotent, unrelated settings survive, and disable cleans both harnesses.
- Spawned Codex hook process reaches the isolated real local host, takes identity from hook input despite a conflicting inherited thread ID, and grants no send authority.
- Pre-Codex journal migrates without changing Claude handle or generation.
- Twenty mixed synthetic sessions retain distinct handles across end/resume and journal restart.

These are protocol/integration simulations, not twenty live desktop chats or a hardware sleep test.

## Remaining live release gates

Before production activation, install the candidate hooks only in the disposable workspace, obtain approval for those new hook definitions, and resume both desktop chats. Verify their automatic directory registrations and timing independently of metadata-only probe results. Then test new-session timing (five trials), resume/fork/compaction/end behavior, restart, opt-out, and offline behavior. An already-idle chat with no lifecycle hook remains undiscovered. Actual conversation titles remain unavailable.

Hook metadata does not currently provide a verified distinction between every interactive, headless and scheduled top-level session. Therefore this candidate must stay scoped to the disposable interactive workspace until that eligibility boundary is resolved; do not enable it indiscriminately in a production workspace containing unattended workers. Subagent hook events are not installed, and no worker or conversation is launched by discovery.

Automatic Codex attachment, arbitrary Codex receive/wake, and full multi-harness delivery parity are not supplied by this slice. Existing bound Codex messaging and Claude attachment behavior are preserved.

Official hook schema reference: https://learn.chatgpt.com/docs/hooks (retrieved 2026-10-24). Documentation supports the hook configuration shape; the desktop observations above are the evidence for this installed surface.

Live preparation checkpoint: candidate configuration and an isolated host are at `/private/tmp/triangle-codex-discovery-d3-20261024`; the scratch workspace's existing probe hooks were preserved and three candidate hooks were added. A fresh desktop metadata call still succeeded but no Codex directory row appeared. The standalone hook-review UI explicitly reported three new/changed hooks requiring review; they were left untrusted. This is an observed trust gate, not a successful registration. The production supervisor/configuration has not been changed. The isolated host has no executable worker implementation and cannot launch a coding agent.

Final regression result: 250 tests passed, zero failures or skips.

## Owner-approved live follow-up — 2026-10-24

The owner explicitly approved the three disposable discovery hooks. Codex 0.164.0's normal trust UI showed exactly three new/changed hooks; “Trust all and continue” was selected for those hooks. No bypass flag or trust-file edit was used.

The two already-loaded desktop probe chats were prompted again. Their metadata calls completed, but no directory registration appeared. This is a measured existing-session reload limitation; caching is the working explanation, not independently proven internals.

A fresh no-tools standalone lifecycle canary returned `DISCOVERY_LIFECYCLE_OK` and automatically registered handle `session-eb61367afaf7d746d604d997517c4d060be29ea878cf640a74b62cc4188a51a5`, label suffix `5e76fdf2`. Its end hook marked it offline at generation 1. Reopening that completed canary through the desktop app and submitting a follow-up produced a fresh SessionStart/resume hook at epoch milliseconds 1792875600051; Triangle recorded the same handle at generation 2 with `lastSeenAt` 1792875600068. The 17 ms difference is a single same-host hook-log-to-journal observation, not a five-trial attachment latency claim. Receive/wake capabilities stayed false.

The new desktop follow-up returned the prior sentinel rather than executing the requested metadata probe. It therefore does not count as another fresh per-call metadata result. The registration/resume conclusion relies on the independent lifecycle log and directory journal; the earlier two desktop metadata proofs remain the per-call identity evidence.

This establishes automatic registration for one fresh CLI session and the same session resumed in the desktop app. It also demonstrates why the interactive/headless eligibility boundary remains a release blocker for general workspace enablement. Two already-open desktop registrations, five future-session timing trials, fork/compaction lifecycle and real sleep/wake acceptance remain open. PR #118 remains draft.

After the bounded run, candidate discovery was disabled and its three managed hooks removed from the disposable workspace (`hooksCleanupRequired: false`). Existing probe hooks were preserved. The isolated test host was stopped; the production supervisor and configuration were untouched. Journal evidence remains under the private test root for follow-up.

## Follow-up: own-session source guard

The candidate now reads only `SELECT source FROM threads WHERE id=?` for the incoming hook's own UUID from Codex's local `state_5.sqlite`, opened read-only. It never enumerates sessions, selects transcript fields, or opens `transcript_path`. The database and its home must be canonical, owned and not writable by other users; ordinary observed Codex 0755/0644 modes are accepted without chmod. A missing database is never created. Unknown/missing schemas, rows and sources skip registration with a fixed diagnostic code. SQLite busy waiting is bounded to 100 ms.

Measured point lookups for the two disposable original probes returned `cli`; the no-tools unattended canary returned `exec`. The current working chat returned `vscode`. `originator` was `Codex Desktop` even for the exec-origin canary after desktop resume, so originator alone is not a classifier. The guard admits observed `cli`/`vscode` origins and rejects exec, app-server, subagent and unknown origins. An exec-origin thread remains excluded after desktop resume unless a future explicit promotion contract is added.

This is a private-schema compatibility adapter, pinned to the observed Codex 0.164/state_5 layout, not an officially supported Codex discovery API. Source describes session origin, not necessarily its current execution owner: an interactive-origin thread later resumed unattended still requires a separate current-owner exclusion proof. Therefore general production workspace activation remains blocked; this guard narrows admission but does not independently close the entire interactive-versus-unattended gate.

Added tests cover the source allowlist/denylist, absent database without creation, exact-ID lookup, unchanged source bytes, unsafe writable files and symlinks. The spawned hook integration test uses its own metadata fixture, not the user's registry. On the live metadata-only point check, the original CLI-origin probe was eligible and the exec-origin canary was skipped. Final relevant regression result: **251 passed, zero failures or skips**. Node 22 emits its standard experimental SQLite warning when the guard first loads the built-in API; it is non-blocking and carries no session content.

The already-loaded desktop sessions have not been forced to unload or resumed in another app-server. A user-controlled app restart/reload is the next live-test prerequisite. Hook definitions are unchanged from the three previously approved commands; only the candidate implementation has changed. No production installation or configuration was changed.

Pinned hook schema inspected: https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/hooks/schema/generated/session-start.command.input.schema.json — its source enum describes lifecycle start reasons, not desktop/headless execution.

## App-restart attempt and corrected fixture lifetime

After the owner restarted Codex, both original scratch chats made fresh metadata calls (new MCP PIDs 76549 and 77167, hashes still 4d86b7c5 and a21c63c3). Their resume hooks were logged at 1792903283469 and 1792903286648. However, restarting the app had also terminated the tool-owned disposable host. It was restarted only after those resume events. The directory still showed older ended rows, with last-seen times 1792888099917 and 1792888702903; they are not fresh registration evidence. Subsequent delegated metadata turns did not produce fresh registrations. No positive acceptance claim follows from this attempt.

The fixture is now independently hosted by temporary per-user LaunchAgent `dev.thetriangle.discovery-proof-d3`, bootstrapped from `/private/tmp/triangle-codex-discovery-d3-20261024/discovery-proof.plist`. `launchctl print` reports running and its own socket status succeeds. This temporary service uses only the disposable journal and has no executable worker implementation; production `dev.thetriangle.client` is unchanged. Baseline directory evidence was saved privately as `pre-restart-directory.json` under the test root. A further user-controlled app restart is needed to repeat the resume case with the host already available. After acceptance, remove only this temporary job using `launchctl bootout gui/501/dev.thetriangle.discovery-proof-d3` and disable the disposable hooks as before.
