# Claude session Stage 2 — review checkpoint

Status: source correction gate accepted after the review below. Not installed or accepted as a live
bidirectional adapter. Gate 0 desktop MCP launch is independently verified in
`2026-10-22-claude-desktop-mcp-gate0.md`.

Antigravity returned request `claude-m3-stage2-implement-20261022`. Parent reran
the local messaging, Claude session, Codex wake and supervisor-boundary suites:
192 tests passed, zero failures or skips. These passing tests did not cover all
required invariants.

## Parent reproductions

1. **Old child adopts a rebound identity during credential refresh.**
   `getValidCredential` in `claude-session-mcp-child.mjs` reads a new integration
   tuple and exchanges it without comparing against the original inherited
   session. Parent created a real broker/control socket and MCP child, made a
   successful inbox call, changed the owner-paired session UUID/binding/generation,
   advanced the clock by 241 seconds, then made another inbox call from the old
   child. It succeeded using the new session. Refresh must fence the captured
   identity/session/binding/generation and never silently adopt a rebind.
2. **Claude cannot retrieve or consume outbound replies.** Its MCP tool list
   omits `triangle_get_replies`, `triangle_consume_reply` and recipient discovery.
   Therefore an outbound request and notification cannot complete a conversation
   through the session's own MCP tools.
3. **Concurrent journal reservations can overlap an open transaction.** Calling
   two `reserveInteractiveWake` operations concurrently on the journal yielded
   one delivery permit and one `ERR_SQLITE_ERROR`. An `await` occurs while the
   single shared SQLite connection holds `BEGIN IMMEDIATE`. Existing race tests
   use separate client IO callbacks and do not cover this scheduling case.
4. **Reservation retry can reuse an acknowledged wake ID.** Parent reserved R,
   acknowledged R, admitted a fresh inbound message, then retried R at +16s.
   It returned `deliveryAllowed: true`. Retry identity must stay deduplicated
   after acknowledgment; otherwise stale acknowledgments can collide with a new
   notification using the same ID.

The parent reproduction script is disposable:
`/private/tmp/triangle-stage2-parent-repro.mjs`. It prints only booleans, missing
tool names and error codes. It uses synthetic credentials and scratch sockets.

## Scope preservation

The pre-existing dirty Darwin alias test fixture was restored to
`/private/var/tmp` before parent verification. No install/runtime manifest or
user settings changes are accepted from this source-only slice. The current
bundle artifact allowlist must be extended and tested in a separate release gate
before these new modules can be installed.

## Independent review

The independent reviewer reproduced the rebind issue and identified additional
blockers: generated mutation retry IDs are lost on errors; a delayed socket
connect can write after child close returns; journal wake methods do not check
their session tuple, while report RPC parameters can override claims. Its new
test run passed 13/13 despite these failures. It concurred with the reservation
replay and transaction-await findings. All seven findings are sent as one
correction batch; completion requires regressions and parent verification.

## Corrected candidate verification

Antigravity returned all seven fixes through Triangle request
`claude-m3-stage2-corrections-20261022`. Parent reran the standalone reproductions:
old-session adoption false, missing outbound tools empty, concurrent reservations
both fulfilled with exactly one permit, and reused acknowledged ID denied.
The independent reviewer repeated actual dropped send/claim/reply responses and
a delayed-connect-after-close probe; retries recovered and post-close writes
were zero. It found no remaining P1/P2 in the scoped fixes.

Parent added actual dropped-response injection as a persistent regression rather
than relying on the earlier success-only test titled transport loss. Parent also
added failing real-process SIGINT/SIGTERM cases, implemented awaited CLI shutdown
and readline closure, and verified both pass; independent re-review passed them.

Final validation:

- Normal agent-worker package suite: 909 tests, 906 passed, 0 failed, 3 skipped.
- Focused adapter/supervisor/Codex/packaging boundary: 216/216 passed before the
  final packaged-MCP smoke test was added; that test is included in the package run.
- Installer and legacy-bundle gate: 18/18 passed, including actual MCP initialize
  and tools/list through the staged wrapper and frozen v11 bundle.
- Swift WorkerLauncher contract suite: 11/11 passed.
- Bundle-closure tests: 14/14 passed; independent packaging review confirmed all
  pre-v11 exact artifact lists are unchanged. v11 adds exactly the three session
  broker/delivery/MCP modules to each worker and standalone supervisor bundle.
- `git diff --check` passed.

The first package run failed four stale packaging fixtures after the v11 bump;
their current-version assertions and legacy artifact removal list were updated.
The final complete package rerun above is clean. Tests use synthetic identities
and private scratch sockets; no live session token is placed in a test fixture.

The disposable staged application root is
`/private/tmp/triangle-claude-v11-candidate`. This is not the installed production
application root. Claude owner pairing, activation of the existing supervisor,
and real bidirectional Claude/Codex/Antigravity canaries remain unclosed gates.
