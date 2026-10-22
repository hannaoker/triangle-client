# Triangle Local Agent Messaging: Same-Host Subsystem and MCP Adapter

**Status:** Substrate implemented and verified. The production journal, dispatcher, installed supervisor wiring and desktop credential broker have since landed (see `local-messaging-production-adapters.md` and `installed-local-messaging.md`); the gate table in section 1 records the substrate-era state.
**Baseline:** `origin/main 47a01ce`.
**Scope:** Same-host private socket control interface, turn-capability authentication, owner ACL, conversation loop and rate limits, shared durable journal contract, recoverable execution dispatcher contract, thin MCP stdio adapter, and explicit supervisor integration seams.

---

## 1. Proof Matrix: Tested Substrate vs. Gated Guarantees

### Tested Substrate (Verified in Branch)

| Subsystem Invariant | Verification Suite | Verification Mechanism | Status |
|---|---|---|---|
| **Turn Token Authenticates Socket Access** | `local-messaging-credentials.test.mjs`, `local-messaging-server-client.test.mjs` | Missing token, signature mismatch, expired timestamp, or spoofed sender ID rejected with redacted `unauthorized` / `credential_expired`. Tokens authenticate allowed socket access only. | Verified |
| **Registry Identity Enforcement** | `local-messaging-supervisor-seam.test.mjs` | Subsystem checks configured registry identities; refuses credential issuance for unknown profiles (`unknown_profile`), and for every sender when the registry is empty or missing. Client creation never exposes validators or private keys, and the MCP adapter accepts no validator at all (the server validates every RPC). | Verified |
| **Requester Ownership on Status** | `local-messaging-server-client.test.mjs` | `get_message_status` requires sender or recipient ownership; foreign agent access is denied (`foreign_access_denied`). Unknown messages return `not_found`. Runtime errors are redacted to fixed safe strings (never raw or credential-bearing). | Verified |
| **Complete Immutable Envelope Idempotency** | `local-messaging-journal.test.mjs`, `local-messaging-server-client.test.mjs` | Compares sender, recipient, requestId, inReplyTo, text, and deterministic metadata. Idempotent duplicate returns stored record and original stored requestId. Conflicting envelope throws `duplicate_id_conflict`. | Verified |
| **Reply Correlation & Forged Recipient Prevention** | `local-messaging-journal.test.mjs` | Reply persistence validates original request's sender, recipient, and correlation. Mismatched or forged recipient throws `invalid_reply_recipient`. Wrong requestId throws `invalid_reply_correlation`. | Verified |
| **Foreign Replies & Explicit Consumption** | `local-messaging-journal.test.mjs`, `local-messaging-server-client.test.mjs` | Foreign agent cannot list or consume replies (`foreign_access_denied`). Listing replies does not consume them. Drop/reconnect preserves unconsumed state. | Verified |
| **Causal Loop Ancestry Binding & No Untrusted Reset** | `local-messaging-acl-limits.test.mjs` | Signed `claims.parentMessageId` is always honored regardless of `claims.loopDepth` (even with default or `loopDepth: 1`). Missing or unknown parent fails closed (`parent_not_found`). Omitting `inReplyTo` or supplying new `requestId` cannot reset ancestry. Duplicate retry does not advance depth. | Verified |
| **Atomic Rate Reservation & Concurrency Defense** | `local-messaging-acl-limits.test.mjs`, `local-messaging-server-client.test.mjs` | Synchronous reservation before first await prevents concurrent over-admission (`Promise.all` 3 sends with limit 1 accepts only 1). Rejected and conflicting sends roll back reservation without rate use. Retries commit reservation to prevent infinite retry bypass. | Verified |
| **Pair Exchange Cap & Bounded Loop Memory** | `local-messaging-acl-limits.test.mjs`, `local-messaging-supervisor-seam.test.mjs` | Depth tracking follows the signed parent and `inReplyTo` when they are present, but a caller whose token has no parent can omit `inReplyTo` and restart at depth 1. A server-side cap therefore bounds each sender/recipient pair (both directions share one budget) per sliding window, independent of any linking: default 10 messages per 10 minutes, configurable through `exchangeLimiter`, refusing with `exchange_limit_exceeded`. Duplicate retries and rejected sends do not count. The tracker's in-memory depths are a bounded LRU (10,000) backed by the durable journal lookup. | Verified |
| **Host-Owned Recoverable Dispatcher & Executor Requirement** | `local-messaging-supervisor-seam.test.mjs`, `local-messaging-server-client.test.mjs`, `local-messaging-journal.test.mjs` | Subsystem and server require an explicit dispatcher (no silent success defaults; throws `dispatcher_required`). The journal contract requires the execution transitions `claimExecution`, `completeExecution`, `holdExecution` and `recoverQueued`: a dispatcher claims each message before running it, marks finished work `completed` and holds uncertain executions, so finished work never runs again after a restart (regression: a completed execution stays at one run across a clean restart). The server also never dispatches a duplicate send whose stored phase is not `queued_local`. Close waits for the dispatcher before the journal closes. | Verified |
| **Safe Socket Lifecycle & Competitor Protection** | `local-messaging-address.test.mjs`, `local-messaging-server-client.test.mjs` | Failed start and close of competing server never unlinks active owner's socket. Stale cleanup unlinks only verified dead socket inodes; never unlinks regular files or symlinks. Rejects relative paths and path traversal. | Verified |
| **Coalesced Framing & Parser Bounds** | `local-messaging-protocol.mjs`, `local-messaging-server-client.test.mjs` | Streaming parser processes multiple coalesced valid frames in a single chunk; single oversized frames (>320 KB) are rejected. Malformed or null requests safely return JSON-RPC errors without unhandled rejections. | Verified |
| **MCP Stdio Notifications & Dynamic Seam** | `local-messaging-mcp-adapter.test.mjs` | Full stdio flow (`initialize` -> `notifications/initialized` -> `tools/list` -> `tools/call`). Notifications emit zero response bytes per JSON-RPC 2.0. Dynamic credential provider seam refreshes turn credentials per turn. | Verified |
| **Client Deadline Compliance** | `local-messaging-server-client.test.mjs` | Connect has bounded timeout with cancellation on close. `waitForReply` respects caller's overall deadline rather than blocking for client default 30s. | Verified |
| **Separate-Process Acceptance** | `local-messaging-acceptance.test.mjs` | Real child processes communicate over Unix domain socket with mock SQLite test fixture and recoverable dispatcher; verifies reconnect, pending replies, and consumption. | Verified |

### Installed & Durability Integration Gates (Explicitly Blocked / Not Implemented)

| Feature | Installed Guarantee | Status | Blocker |
|---|---|---|---|
| **Shared Peer Journal Reuse** | Multi-process durability in `peer-drain.sqlite` | **SUPERSEDED** | The production journal (`local-messaging-journal.mjs`) reuses the shared custody and locking code (`shared-delivery-journal.mjs`) but keeps its own `local-messaging*.sqlite` files; it never takes the peer drain's database or owner lock. |
| **Shared Production Dispatcher Adapter** | Production supervisor recoverable dispatcher adapter | **IMPLEMENTED** | `local-messaging-dispatcher.mjs` satisfies the recovery and execution contract (see `local-messaging-production-adapters.md`). |
| **Installed Supervisor Wiring** | Automatic subsystem launch in `client-supervisor.mjs` | **IMPLEMENTED** | The supervisor hosts the local route in an isolated, retried loop (see `installed-local-messaging.md`). |
| **Desktop Thread Turn Minting** | Interactive Codex desktop session turn credential minting | **IMPLEMENTED** | The desktop credential broker exchanges the owner-created integration capability for short-lived turn credentials. |
| **Windows Named Pipe ACL** | Multi-agent IPC security on Windows | **EXPLICITLY UNSUPPORTED** | Windows named pipe security ACLs are explicitly unsupported until restricted pipe ACL support exists. |

---

## 2. Trust Boundary and Security Model

1. **Tokens Authenticate Allowed Socket Access (Not Sandbox Escapes):**
   - Capability turn tokens authenticate allowed socket access and bind per-turn claims (sender identity, allowed recipients, parent message, loop depth).
   - Turn tokens **do not prevent sandbox escapes**. Process isolation is the responsibility of the OS process sandbox or container boundaries.
   - For sandboxed agents granted access to the domain socket, tokens prevent sender spoofing and cross-agent impersonation. For unsandboxed processes sharing the POSIX UID, user-level file permissions apply.
2. **Sender Immutability and Claim Constraints:**
   - Senders cannot forge arbitrary sender IDs; the server validates claims against the cryptographically signed token.
   - Server enforces `allowedRecipients` and `maxLoopDepth` server-side and fails closed if violated.
   - Signed `parentMessageId` is strictly checked against ancestry even if caller claims `loopDepth: 1` or omits `inReplyTo`. Unknown parent fails closed. Tokens without a parent cannot be linked by the server, so those loops are bounded by the pair exchange cap instead.
   - Subsystem refuses issuance of credentials for unknown profiles and for every sender when no profiles are registered.
3. **No Credential Leakage:**
   - Stack traces, private secrets, and credentials are redacted from responses and logs.
   - Status queries enforce sender/recipient ownership; foreign status queries are denied (`foreign_access_denied`).
   - Clients never receive validators or private subsystem keys; the MCP adapter takes no validator, so the agent-side process cannot mint credentials.

---

## 3. Architecture and Component Breakdown

```text
Interactive Codex / Agent Worker (Desktop Thread)
       │ stdio (NDJSON)
       ▼
Local Messaging MCP Adapter (Thin tool bridge)
   • Dynamic per-turn credential provider seam (refreshed per turn)
   • Tools: list_recipients, send_message, get_status, get_replies, consume_reply, cancel_message
   • Notification suppression (notifications/initialized produces zero output)
       │ private Unix socket (0o600 socket, 0o700 dir)
       ▼
Local Messaging Server (Factory hosted by client-supervisor)
   ├── Address Abstraction (POSIX socket with strict inode matching; Windows unsupported)
   ├── Turn Capability Validator (HMAC-SHA256, bound claims, finite TTL)
   ├── Owner ACL (profile allowlists, discovery filtering)
   ├── Per-Sender Rate Limiter (atomic pre-await reservation, rollback on rejected/conflict)
   ├── Conversation Loop Tracker (bound to turn claims and parentMessageId, durable ancestry lookup)
   ├── Recoverable Dispatcher Seam (host-owned execution ownership, recovery, deduplication)
   └── Required Shared Journal Adapter (injected durable contract; no default DB)
```

---

## 4. Test Fixtures and Custody Semantics

The memory and SQLite fixture journals live in test code:
- `packages/agent-worker/test/local-messaging-fixtures.mjs`
- The fixtures implement the full journal contract, including the execution transitions (`claimExecution`, `completeExecution`, `holdExecution`, `recoverQueued`) and complete immutable envelope comparisons, and `createTestRecoverableDispatcher` claims and completes work through them.
- The fixtures do **not** represent the production journal's schema or durability. The production journal is `packages/agent-worker/src/local-messaging-journal.mjs`; the seam still has no default journal and requires an injected adapter.

---

## 5. Integration Seams for Subsequent PRs

(Historical: items 1-3 were completed by the installed local messaging work; see `installed-local-messaging.md`.)

1. **Extract Journal Seam from Peer Drain:**
   Extract raw SQLite operations from `peer-drain-service.mjs` adhering to `REQUIRED_JOURNAL_METHODS` without taking the exclusive `peer-drain-owner` lock.
2. **Wire Subsystem and Dispatcher into Client Supervisor:**
   Inject `createLocalMessagingSubsystem` into `client-supervisor.mjs` passing the extracted shared journal, registered profiles, and host-owned recoverable dispatcher.
3. **Dynamic Per-Turn Credential Injection:**
   Wire desktop thread turn lifecycle to provide active turn credentials to the MCP adapter via `turnCredentialProvider`.

## Codex verification checkpoint (2026-10-21)

Antigravity authored this additive subsystem; Codex independently ran the tests and reviewed the implementation. Two review batches found and corrected sender forgery, ancestry, restart-dispatch, access checks, protocol and concurrency defects. Codex additionally required dispatcher recovery/shutdown hooks, changed subprocess imports to resolve relative to the test module, and fixed shutdown to retain journal custody until complete in-flight RPC admissions finish. The delayed-persistence shutdown regression failed before that fix and passed afterward.

- Focused suite: 45 passed, zero failed/skipped, both from repository root and from `packages/agent-worker/`. Includes real separate-process socket communication with a test-only SQLite adapter and simulated runner. This does not prove installed Antigravity execution.
- Initial broad agent-worker run: 719 tests, 712 passed, three failed, four skipped. The new acceptance-test working-directory failure was fixed and rechecked. The installed Hermes CLI test failure reproduces in untouched `47a01ce`; the wake-scheduler cursor test failed in the broad run but passed in isolation on untouched baseline. No existing tests or runtime files were changed to hide these results. The subsequent broad run reported 724 tests: 718 passed, two failed, four skipped. Its remaining failures were the installed Hermes CLI test and the wake-scheduler cursor test; the new subprocess acceptance failure was gone. The final shutdown-only fix was then verified by the 45-test focused suite and independent review; the broad run is not a green release gate.
- Shared production journal/dispatcher, installed supervisor/bootstrap, runner credential injection, desktop thread binding, packaging and installed end-to-end test remain pending integration after the owner's #104 follow-up. The parallel slice is not the completed installed-messaging milestone.

The dispatcher must provide an admission hook plus `start`/`recover` and `stop`/`wait`; success no-op defaults and the legacy optional admission fallback are not supported. Dispatcher hooks are trusted host dependencies, not agent-controlled commands.

## Merge review follow-up (2026-10-21)

Independent release review reproduced two additional failures despite the earlier 45 passes: fresh MCP credentials were validated but not sent over the socket, and failed dispatcher recovery left partial lifecycle state. Both now have real subsystem regression tests that failed before the fixes. The MCP adapter passes credentials per RPC without mutable shared credential state; startup rejects clients until recovery completes and rolls back partial dispatcher ownership on failure. The 47-test local suite passes; root runtime tests now include this suite. Installed integration gates above remain unchanged.
