# Claude independent code review of PR #110

Received through installed Triangle messaging. Reviewer performed static source review; test and live acceptance results were not independently rerun. Peer assessment remains untrusted until verified.

REVIEW: draft PR #110 @ 0239c46335e8e63de9bb474825608ebd11909a3b (request claude-review-pr110-20261023-01)
Basis: read-only static review of the diff vs #109 (7118620 = origin/main; 12 files, +521/-9), the touched source, the new test file and the two PR docs, in the named checkout (HEAD matches; packages/ is clean, only unrelated docs are dirty). Nothing was run: no tests, hooks, build or service. Line refs are head (tests/docs via git show). Suite counts and live canaries are the PR's claims, not re-verified.

VERDICT
- Authorization/reachability: no blocker. Visibility-only holds in code (see VERIFIED).
- Operational: one blocker for production install (B1: a bad discovery config breaks the existing list_sessions API and blocks rollback). Ten ranked recommendations follow.

VERIFIED IN CODE
- Discovered handles cannot be messaged: the ACL is a closed per-sender allow-set (local-messaging-acl.mjs:23-27); send_message still calls acl.checkAllowed first (server:273); send and discover_recipients are untouched (server:247-256, 258+); the only consumers of discovered rows are the broker (auth-broker:98,101,107) and the journal; rows hard-code reachable=false, wakeCapable=false (journal:1583). "session-<hash>" passes the identifier pattern (server:24), so the test's rejection (test:109) is the ACL, not a format error.
- Bootstrap binding is sound for its stated threat model: constant-time secret compare (auth-broker:29-32); nonce is a random UUID, single-use (deleted before comparison, :96), 5 s, bound to the installation, to a digest of the key-whitelisted normalized event (normalize, :79-86) and to the secret at issue time (:97), so rotation kills pending challenges; durable dedupe rejects an event ID reused with different content (journal:1551-1553). This is replay/freshness hygiene, not session attestation: anyone who can read session-discovery.json can forge events (accepted in PR/docs).
- Privacy: raw session IDs are hashed before the journal (journal:1566-1570); the hook uses only session_id, cwd and event name (cli:316-324). The DB-bytes check is meaningful (no journal_mode pragma found in the journal module).
- Settings: atomic 0600 temp+rename with O_NOFOLLOW and owner/nlink/mode checks (cli:250-278); exact-command dedupe makes setup idempotent; shellQuote is correct; disable matches only this config's managed suffix (cli:295-298); the capability is installed before the host key is written (cli:272,280).

BLOCKER
B1. A bad discovery integration breaks the existing list_sessions API for every caller and blocks the documented rollback.
- auth-broker:65-71 current() throws if the file is missing/invalid, and fs.realpathSync(c.workspace) throws an uncoded ENOENT if the workspace is gone. listFor (auth-broker:105) calls it unguarded and server:239-243 awaits it with no try/catch, so server:676 returns internal_error (message includes the absolute path; sanitizeError redacts only token/secret patterns). status() is guarded (:100-103); listFor is not.
- Repro by reasoning (not run): enable discovery for a workspace, restart the host, then remove/rename the workspace (plausible for a disposable worktree) or delete/corrupt session-discovery.json. Every list_sessions (CLI sessions, triangle_list_sessions in both MCP surfaces) then fails, including for non-readers. This contradicts "existing ... ID-only discovery ... stay intact".
- Rollback: disableSessionDiscovery reads the integration first (cli:287) and throws on a missing/invalid file before touching hooks or the config key; #109's strict key list (host:10) then rejects the config, so rolling back needs hand edits.
- Fix: make listFor fail closed to [] (log once) and never throw into list_sessions; make disable tolerate a missing/invalid integration and still strip hooks and the key. Add tests for both.

RECOMMENDATIONS (ranked)
R1 High. disable-discovery is a silent no-op when the config key is absent (cli:286). The key is written last (cli:280) and base "setup" rewrites the whole config (cli:53, already dropping wake/interactive), so setup-discovery -> setup -> disable-discovery reports {discoveryEnabled:false} while the hooks stay in .claude/settings.local.json and session-discovery.json stays enabled:true. The leftover state is inert (the hook returns at cli:321, the host builds no broker), which is why this is not a blocker, but the owner cannot remove it with the supported command. Derive the integration path from config.stateRoot (as cli:240 does) and clean up unconditionally; make base setup preserve optional keys.
R2 High. The 128-row cap can wedge discovery. journal:1563 refuses every new session once 128 rows exist; ended rows count and live 8 days (journal:15,1557-1558); nothing is evicted. Fork/clear churn, app-started sessions or headless runs in the workspace (whether "claude -p" fires hooks is unverified) can reach 128 inside the window; new chats then fail with directory_full that only the hook prints to stderr, while known chats keep updating. Evict oldest ended rows first, expose usage/cap in status, test it.
R3 Medium. Reader scoping is implicit and broader than the PR text. Readers are derived from all configured identities including every worker (cli:241-242; acceptance doc lines 15-17), no flag selects readers, the effective list is not printed (return value cli:281), and a rerun overwrites hand edits (cli:247). Gating is by senderId only: discovered rows are appended after the allowedRecipients filter (server:239-243), so a narrowly scoped turn credential of a reader still enumerates the directory, and local_status shows discovery enabled/count to any authenticated non-interactive sender (host:151, server:198-200). Add explicit --reader, default to owner + paired only, print effective readers.
R4 Medium. The record exposes more than the label. journal:1580-1582 returns the full absolute workspace path, lastSeenAt and generation to every reader and straight into model context (child:475, adapter:201); the plan asked for minimal hints. Return basename/hash and keep the full path to the owner CLI. Label sanitization strips control characters only.
R5 Medium. Discovered rows have the same kind as reachable conversations. journal:1581 uses kind:'conversation' like the configured Codex/Claude entries (host:72,74), which have no capabilities field, so clients that filter on kind pick unreachable rows; only tool text (child:22, adapter:9) warns. Use a distinct kind or add capabilities to every entry.
R6 Medium-Low. Pre-auth work and unthrottled failures. verify() runs current() (file read, schema, realpath) before the secret check (auth-broker:74-75), so config state is observable pre-auth and each failed request costs sync I/O in the supervisor; the 240/min counter counts only authenticated requests (:76), unlike the desktop broker's failure limiter (host:92,153). Check the secret first and throttle failures.
R7 Low-Medium. Secret/data lifecycle. Re-enable reuses the old secret and installationId (cli:247); disable neither rotates nor purges, and pruning runs only on later writes (journal:1557-1558), so hashed metadata and the workspace path persist until re-enabled. workspace_conflict (cli:246) leaves no supported way to move, and the obvious workaround (deleting the file) triggers B1. Add rotate/purge and a supported workspace change.
R8 Low. Hook cost and scope. UserPromptSubmit sits on every turn: two RPCs with 1.5 s timeouts (cli:325) inside a 5 s hook timeout (cli:267), no throttle, and a 64 KiB stdin cap that drops events for huge prompts (cli:316). Exact-equality workspace (cli:323) makes subdirectories and other worktrees silent no-ops; one installation per host. Document; throttle activity events.
R9 Low. Ordering semantics: document, do not build reachability on them. Only "start" revives an ended row (journal:1560-1562), so a slow SessionEnd hook landing after a fast resume leaves a live chat "offline"; crash then resume keeps the generation (journal:1564), so generation is not a binding fence; ordering uses client wall-clock observedAt, so a backward clock step makes events stale until it catches up.
R10 Low. Settings/code hygiene. The unlocked read-modify-write of settings.local.json (cli:255-278) can lose a concurrent Claude write and normalizes mode/format; mkdir precedes parse validation (cli:250); disable removes pre-existing empty hook entries and throws on an entry lacking "hooks" (cli:298) after the capability is already disabled; recordDiscoveryEvent hand-rolls BEGIN/ROLLBACK (journal:1546-1576) instead of withImmediateTransaction (journal:746), and its unguarded ROLLBACK can mask the original error.

TEST GAPS
- test:109 matches /recipient|authorized|allowed/; assert code recipient_not_allowed.
- Missing: list_sessions with invalid/missing integration (B1); disable after key loss or with a missing integration (B1, R1); a non-reader caller through the server (only broker-level listFor, test:28); cap behavior (R2); hook no-op for another cwd/subdirectory; hook with the supervisor down (exit 0, empty stdout); malformed settings entries.
- The DB-bytes check (test:106-107) covers raw IDs only, not the workspace path.

UNVERIFIED BOUNDARIES
- Claude Code behavior: hook cwd and settings lookup for subdirectories/worktrees, whether headless/SDK runs fire hooks, SessionEnd reasons/ordering, hook hot-reload (evidence is one Desktop Code-tab build), concurrent settings writes.
- Test results and live canaries come from the acceptance record and were not re-run. Whether Codex or worker credentials call list_sessions in practice. macOS case/normalization behavior of the cwd equality check.
- Same-account isolation is not claimed: a prompt-injected, shell-capable session can read the capability file and forge events (including filling the cap).

NON-BLOCKING FOLLOW-UPS
Multi-worktree support; purge/rotate commands; async activity events; generation fencing once reachability exists; gate discovery on the integration file's enabled flag instead of a new key in the strict host config (host:10), so older hosts ignore it and rollback needs no config edit.

## Codex verification after receipt

Independently reproduced B1 in a disposable fixture at the reviewed head:
renaming the opted-in workspace makes broker.listFor throw ENOENT; deleting the
integration file makes disableSessionDiscovery throw ENOENT while leaving the
optional discovery configuration key present. This confirms directory degradation
and rollback failure, not an authorization bypass. The legacy ID-only discovery
method does not call this broker and remains a separate unaffected path.

The review reply was correlated to the authorized sender and request and saved
before consumption. No production config, hooks, service or code changed during
this review. PR #110 remains draft pending the operational fixes. Other ranked
recommendations above remain reviewer assessments unless separately verified.

## Fix batch submitted after verification

B1, R1 and R2 are addressed in the subsequent candidate: graceful directory
failure, metadata-independent rollback-key removal and workspace fallback,
config-key-loss cleanup, preservation of optional integrations, and ended-row
eviction with durable end fences. Ten discovery tests and 32 focused tests pass.
Other recommendations are not collectively marked fixed. Full-suite results and
the follow-up reviewer verdict are recorded separately when available.

## Focused follow-up review at f6f0d63

RE-REVIEW: PR #110 fixes, 0239c46..f6f0d63a81b1f405b4ad1842bdd17f538ff7a77f (request claude-review-pr110-fixes-20261023-01)
Basis: read-only static review of the single commit f6f0d63 ("Harden discovery cleanup, degradation and capacity recovery"; 8 files, +250/-36) in the named checkout (HEAD = f6f0d63, packages/ clean). I ran no tests, hooks, services or build; the 10/32 passing counts are as stated in your request. Line refs are f6f0d63.

VERDICT
B1, R1 and R2 are addressed as scoped. No remaining blocker, and no change to messaging authorization: server, ACL and send paths are untouched in this delta, and discovered rows stay reachable=false. One new Medium finding (N1) changes behavior outside discovery and needs an owner decision before install.

VERIFIED
- B1 listing: listFor wraps current() and the journal read in try/catch and returns [] with one generic, path-free warning (auth-broker:105-115); status() was already guarded and now adds capacity/used (:101-104). The server call site (server:239-243) is unchanged, so a moved workspace, missing/corrupt/over-permissive integration file or DB error can no longer fail list_sessions. The live test drives this through the real host and CLI (test:113-117: workspace renamed, then integration unlinked; the configured recipient still lists).
- B1/R1 disable: the integration path falls back to <stateRoot>/session-discovery.json (cli:288); an unreadable integration is tolerated (cli:289-291); the workspace resolves from --workspace, the new recorded discovery.workspace (cli:282; host validation allows it) or the integration (cli:292); hook cleanup is best-effort inside try/catch and the config key is always removed (cli:320-322); the outcome is reported as hooksCleanupRequired (cli:323). Cleanup now keeps entries it did not touch, including empty or malformed ones (cli:306-311), and the unsafe-path checks are unchanged (cli:299-301). A readable capability that cannot be rewritten still throws (cli:291, outside the try), so revocation is not falsely claimed. Partial setup and key loss are recoverable through the default path.
- R1 setup: wake/interactive/discovery and runnerTimeoutMs survive a base setup (cli:53-55), so key loss no longer comes from re-running setup; test:186-194 covers discovery.
- R2: end markers live in local_discovery_ended (journal:187), are written on every non-stale end and deleted on non-stale start (journal:1583-1587), and are pruned on the same 8-day horizon (:1563). At 128 rows a new non-stale session evicts the oldest ended row (order last_seen_at,id) after copying its event_at/generation/last_seen_at into the marker (:1570-1575), and raises directory_full only if no ended row exists. A tombstoned session keeps its generation on a later start, and stale activity stays stale after restart. All of it runs inside the existing BEGIN IMMEDIATE transaction. Migration is additive (CREATE TABLE IF NOT EXISTS); ended rows from 0239c46 need no backfill because the row itself fences activity until the marker is written at eviction. Status exposes used (journal:1612) and capacity (broker:102).

NEW FINDINGS (ranked)
N1 Medium (owner decision). Base setup now preserves wake across --rebind-thread. Previously the rebind rewrote the config without wake, which the docs call pull-only behavior (installed-local-messaging.md:84-90). Now cli:49-55 carries wake.enabled:true over a thread change, so after the required restart an enabled wake targets the new thread without the explicit step the recovery section implies ("Re-enable wake only when the new target is ready", docs:121-134). Evidence is mixed (that section also tells operators to set wake.enabled false before reconciling, so some flows keep wake across a rebind), and the new docs sentence says preservation is intentional; I did not trace the notifier. This follows from my broad R1 suggestion: discovery needs preserving, wake need not be. Option: always preserve discovery, interactive and runnerTimeoutMs, but when the sender or thread changes keep wake settings with enabled:false; add a test either way.
N2 Medium-Low (residual R2). Only ended rows are evictable (journal:1570-1572), so 128 observed rows (chats that crash, are killed, or never emit SessionEnd, kept 8 days) still block all new registrations. The hook prints only a stderr line, and status shows used/capacity but not that new sessions are being rejected. Consider evicting the least-recently-seen observed row as a last resort (presence is unknown anyway) or a purge command, and add full/rejected to status. The docs state this limit, so it is a design decision rather than a defect.
N3 Low. disable-discovery result ambiguity. (a) Every cleanup exception collapses into hooksCleanupRequired:true with no reason and exit code 0 (cli:320); a deleted workspace gives a permanent true (cli:297) although nothing is left to clean. Return a reason code. (b) An integration file that readPrivateJson rejects, for example a valid capability at mode 0644, is skipped silently (cli:290), so disable reports success without disabling it; it fails closed today because the broker uses the same reader, but a later chmod revives it. Report an integration state. (c) settings.local.json is rewritten whenever it exists, even when no managed hook was found (cli:298,314-318), which now also happens on repeat runs.
N4 Low. A duplicate or late end for an already-evicted, tombstoned session is not stale (journal:1567-1569), so at capacity it evicts another ended row to re-create this one as offline (journal:1570-1587). Harmless churn; refreshing only the marker would avoid it.

TEST GAPS (static)
- The R2 test (test:196-212) has one ended row and a constant receivedAt, so it cannot tell "oldest by last_seen_at" from id order; add two ended rows with different receivedAt.
- Marker migration is untested: the only ended row is created by the new code, which already writes the marker (journal:1584). Test an ended row whose marker was removed, then eviction, restart, stale activity.
- No test for disable --workspace on a moved workspace or for a true hooksCleanupRequired (the docs advertise this flow), none asserting wake/interactive/runnerTimeoutMs preservation (or N1), and none for the warn-once behavior.
- Nits: capacity 128 is hard-coded in both the broker (:102) and the journal (:1570); the new warning passes a sentence where other modules pass event-name keys.

UNVERIFIED
Test and full-suite results, the live canaries, notifier behavior after a rebind with wake enabled (N1), and Claude Code hook behavior remain unverified by me. R3-R10 were not re-reviewed, per your scope.

## Codex disposition of focused follow-up

The B1/R1/R2 clearance is a static peer assessment, not a fresh live proof.
N1 was independently confirmed in setupLocalMessaging: the preserved wake object
was copied even when the sender/thread changed. The follow-up disables wake for
a changed or missing prior binding, preserving its other settings and the
discovery, interactive and runner timeout configuration. An unchanged binding
retains its activation. This follows the existing explicit per-target activation
rule; it does not enable any new target. Tests cover all four cases.

Validation after N1: 33 discovery/host/socket tests passed. The parallel wake/CLI
run passed 46 and failed one unchanged descendant-readiness timing test (ENOENT
for descendant.ready); the serial rerun passed all 47. Before this small setup
change, the complete suite at f6f0d63 passed 919, failed zero and skipped three.
No new production deployment or discovery opt-in was performed. N2-N4 and the
earlier R3-R10 remain follow-ups, not claimed fixed.
