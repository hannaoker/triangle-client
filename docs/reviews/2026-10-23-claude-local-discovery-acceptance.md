# Claude local discovery: visibility-only implementation

## Scope

The first slice discovers session metadata in one owner-opted-in canonical
workspace. It does not pair those sessions, grant send permission, attach a wake
adapter, scan transcripts or token registries, create workers, or bridge to MESH.
Codex automatic discovery is not included. Presence stays unknown unless an end
hook has been observed; there is no heartbeat or claim of online reachability.

## Implementation

`setup-discovery` merges managed SessionStart, SessionEnd and UserPromptSubmit
hooks into `.claude/settings.local.json`, preserving unrelated settings. The
existing installed wrapper runs `discovery-hook`. One private integration file
holds a workspace-scoped installation credential and explicit directory readers
(the currently configured owner/worker/paired identities). No secret appears in
hook commands or diagnostics. This credential admits metadata only and cannot
issue message credentials or change the ACL. The same-OS-account limitation
continues to apply; a shell-capable account owner can read the installation file.

The hook sends only event ID, its own payload session ID, normalized workspace,
event kind and observation time through the private control socket. It ignores
inherited MCP identity, prompt content, transcript paths and messaging tokens.
A five-second single-use challenge binds the event digest and installation;
metadata retries are deduplicated durably. Stale events and activity after an end
cannot reopen the old record. A later start can resume the same handle with a new
generation. Directory state shares the existing exclusively owned SQLite journal.
New tables are additive and ignored by old code.

Raw session IDs are hashed before journal storage. New rows use exact
`session-<hash>` handles and workspace/session-hash-prefix labels,
not actual conversation titles. Capabilities explicitly say visible=true,
reachable=false, wakeCapable=false. An installation's reader policy controls
visibility separately from recipient send scope; existing ACLs still deny sends
to these handles. Legacy ID-only discovery is unchanged. Up to 128 session rows
are retained, with eight-day cleanup on incoming reports. Metadata age is not a
liveness proof.

`disable-discovery` first disables the private installation, then removes only
managed hook commands for this config and removes the optional config key. This
immediately hides discovered entries from a running host and lets older hosts
parse the configuration after rollback. Existing messaging data and active claims
are untouched. Setup and disable do not restart the service or approve hooks.
No new runtime files or manifest version are needed: behavior is contained in
already-packaged modules and checked by bundle-closure tests.

## Tests and live evidence

Six focused tests cover distinct concurrent identities, persistence, stale/end
fencing, generation continuity, workspace/reader scope, bounded challenges,
expiry, replay, key rotation, idempotent setup, settings preservation, real
hook-process/socket/host/CLI integration, rejected sends, and disable/rollback.

An isolated candidate supervisor ran separately from the installed service. Only
the disposable `/private/tmp/triangle-session-discovery-m0-20261023` workspace
received new hooks. In the actual Claude Desktop Code tab:

- An already-open disposable fork appeared on its next ordinary prompt, without
  an app restart or tool call; session prefix fe82ca8e.
- Another already-open chat appeared separately; prefix 69f0e9ff.
- `/clear` ended only 69f0e9ff. Its next turn registered 3f7576da; the other chat
  stayed distinct. All discovered entries remained unreachable.
- A newly created UI fork registered on its first turn; prefix 99e29e2c.
- Restarting only the isolated supervisor preserved all four records exactly.
- Disabling discovery hid all four records, removed the managed disposable hooks,
  and preserved the original metadata-probe settings. The isolated host stopped.

The production Mini service remains on merged PR #109; it was not upgraded or
reconfigured for automatic discovery. Existing idle sessions do not appear until
a hook fires. This is not complete Reason parity, universal hook hot-reload proof,
MCP identity handoff proof, true crash/offline detection, or messaging reachability.

Final privacy canary: removed the stopped prototype's disposable journal, started
a fresh isolated candidate and sent one ordinary prompt in the existing new fork.
The directory showed its session-hash prefix 889d6c4a. Read-only SQLite inspection
confirmed the stored session identity was 64 hex characters, with no raw session
UUID retained. The regression test also checks database bytes for non-retention
of raw input IDs. Disabled discovery, removed its hooks and stopped this host too.
Earlier live prefixes above identify the pre-minimization prototype; final labels
use hashes and are not claimed to match those raw prefixes.

The first full agent-worker run had 914 passes, three skips, and one failure in
the unchanged wake-scheduler async cursor-write test. That suite passed all 22
tests in isolation. The complete rerun with cross-file concurrency limited to two
passed 915 tests with zero failures and three skips (918 total, about 171 seconds).
The original run remains a failed run. A final metadata-minimization adjustment
hashes session IDs before storage and label display; it has a separate raw-ID
non-retention regression check. The final privacy-adjusted candidate also passed
the complete suite: 915 passed, zero failed, three skipped (918 total, about 172
seconds, cross-file concurrency two). Bundle closure checks passed all 14 tests.
No independent code review or production activation is claimed.

## Review-fix batch: B1, R1 and R2

Claude's static review of 0239c46 identified one production blocker, independently
reproduced before edits: missing workspace/integration metadata broke the readable
directory and disable/rollback. The candidate now hides unavailable discovery
entries without failing configured-recipient listing; it emits one generic
warning per unavailable episode without exposing private paths. Disable removes
the optional config key even when discovery metadata is missing/corrupt. Setup
records the workspace in owner config as a cleanup fallback. A moved or unknown
workspace yields hooksCleanupRequired=true; the owner can provide --workspace to
clean the moved hooks without editing files by hand. Unsafe hook paths are never
followed. A valid capability that cannot be disabled still raises an error rather
than falsely claiming revocation.

Base setup preserves optional wake/interactive/discovery settings. Disable also
finds a valid default integration when the config key has been lost. It preserves
unrelated empty/malformed hook entries rather than removing them incidentally.

At capacity the journal evicts the oldest ended directory entry, keeping a
separate durable end marker for the retention window so late activity cannot
resurrect it. Observed entries are not evicted; an all-observed full directory
still reports directory_full. Status exposes used/capacity. End markers also
cover ended entries created before the new table existed.

The expanded discovery suite has ten tests; 32 focused discovery/host/socket tests
passed with zero failures. Full-suite and focused independent re-review results
follow when complete. R3-R10 are not collectively claimed resolved by this batch.
