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
