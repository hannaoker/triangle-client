# Headless Codex worker runtime with optional desktop handoff

Status: **Phase 0 complete (Mini proved); Phase 1 shadow single-slot in progress**  
Date: 2026-09-20  
Owner: Triangle Client  
Target repository: `triangle-client`

## Decision

Triangle Client will make a pooled, headless Codex App Server runtime the
default execution path for Codex-backed MESH profiles. The existing Shared
Codex App Server remains supported as an explicit, optional desktop-visible
adapter.

The two adapters may resume the same persisted Codex thread at different times,
but they must never own or submit work to that thread concurrently. A durable,
generation-scoped execution lease is the authority for handoff.

For v1, ownership and single-flight are profile-wide: exactly one adapter may
claim or acknowledge a `profile_instance_id`, and at most one conversation for
that profile may have an admitted Codex turn. The pool provides concurrency
across profiles, not interleaved turns within one profile. `grok-bot` profiles
never enter the Codex pool.

This design replaces neither MESH nor the trusted mailbox transaction proxy:

- MESH remains authoritative for identities, rooms, inbound delivery, replies,
  terminal delivery state, and network-visible idempotency.
- The signed helper retains mailbox credentials and performs bounded
  claim/read/reply/ack operations.
- The local Codex runtime owns App Server processes, Codex thread continuity,
  bounded concurrency, cancellation, and crash recovery.
- The desktop adapter is a presentation and interactive-continuation mode, not
  a second consumer or a mirror of headless execution.

## Context

Triangle's current interactive Codex path uses one durable Shared Codex App
Server. A LaunchAgent starts a loopback WebSocket App Server, binds one Codex
thread, launches an isolated ChatGPT desktop profile attached to that server,
and admits MESH work into the visible thread. This proves unattended delivery
into an existing desktop conversation, but it deliberately serializes work
around one bound thread and couples availability to ChatGPT.app.

The existing local runtime also has command-oriented headless adapters. Those
are suitable for transport proofs but do not provide the persistent
conversation-to-thread mapping, pooled App Server lifecycle, sticky assignment,
or turn-level recovery required for a general Codex runtime.

A reference implementation reviewed on 2026-09-20 demonstrates the desired
runtime shape:

- its own persistent MESH connection accepts deliveries;
- the runtime launches private `codex app-server` children over standard I/O;
- each MESH conversation maps to a persisted Codex thread;
- new work uses `thread/start`, existing work uses `thread/resume`, and messages
  run through `turn/start`;
- duplicate active work is not executed again;
- completed work is replayable by idempotency key;
- unacknowledged completion is retried across reconnects; and
- the durable MESH tier atomically owns reply, terminal state, and completion
  idempotency.

Triangle does **not** adopt that implementation's MESH connection. Headless
ingress remains the existing helper watch/poll plus trusted transaction proxy;
Node never receives a MESH credential or opens an authenticated MESH socket.
This document adopts the App Server lifecycle and idempotency properties while
preserving Triangle's existing credential custody, receipt-only semantics, and
reply-before-ack contract.

## Goals

1. Run independent Codex-backed MESH profiles concurrently without requiring a
   desktop window, while retaining one in-flight conversation per profile in
   v1.
2. Preserve Codex context by durably mapping each MESH conversation to one
   Codex thread.
3. Bound local resource use with a supervised App Server pool and explicit
   admission limits.
4. Recover from runtime, App Server, network, and host restarts without
   duplicate model turns or conflicting replies.
5. Persist a substantive reply before acknowledging admitted work.
6. Consume `replyRequired: false` deliveries without starting a model turn or
   posting a MESH reply.
7. Retain the existing desktop-visible path for explicitly selected
   conversations.
8. Permit idle-only, fail-closed handoff between headless and desktop owners.
9. Keep permanent MESH and watch credentials out of Node, App Server arguments,
   logs, prompts, and Codex state.
10. Provide a clean pause/drain operation for upgrades, remote-connection
    settings, and incident response.

## Non-goals

- Mirroring a headless result into a desktop chat and calling that interactive
  ownership.
- Running headless and desktop turns against the same thread concurrently.
- Replacing MESH's mailbox, room event log, or delivery state.
- Moving permanent MESH credentials into the worker runtime.
- Treating App Server process survival as proof of MESH completion.
- Supporting arbitrary public App Server listeners.
- Building a distributed multi-host scheduler in the first release.
- Declaring the desktop adapter deprecated before migration gates pass.

## Terminology

| Term | Meaning |
| --- | --- |
| MESH conversation | In v1, the stable MESH `roomId` carried by a mailbox delivery. |
| Codex thread | Persisted Codex conversation identified by `threadId`. |
| Worker slot | One supervised `codex app-server` child and its protocol connection. |
| Sticky assignment | Preference to reuse the healthy slot that last served a conversation. |
| Execution lease | Durable right for one runtime instance and generation to admit a delivery for a conversation. |
| Execution epoch | Monotonic generation attached to one admitted delivery attempt. |
| Desktop ownership | In v1, the current Shared App Server is the exclusive executor and mailbox claimer for an entire profile. |
| Receipt-only | `replyRequired: false`; claim and acknowledge without model admission or MESH reply. |

## V1 scope decisions

These are implementation constraints, not deferred product questions.

### Conversation identity

| Delivery class | V1 conversation key | Behavior |
| --- | --- | --- |
| Direct or group room mailbox | `roomId` | One Codex thread per `(profile_instance_id, roomId)`. |
| Typed task carrying a room | That same `roomId` | Shares the room's Codex thread. |
| Task without a stable room | Unsupported by the persistent-thread runtime | Leave durable in MESH or use an explicitly configured legacy command adapter; do not invent a key. |

Inbound text, delivery IDs, task IDs, and context IDs are never substituted for
`roomId`. A delivery ID identifies one delivery, not a conversation.

### Ownership and concurrency

- exactly one claim/reply/ack owner exists per `profile_instance_id`;
- v1 permits one admitted or running conversation per profile;
- desktop ownership covers the whole profile, not a subset of conversations;
- a transfer generation is a lock and can never call `turn/start`;
- `grok-bot`, App Server desktop, legacy event-driven, and headless App Server
  adapters are mutually exclusive claimers for one profile; and
- automatic desktop focus/latest-thread rebinding remains forbidden.

### Durable storage

Triangle Client does not currently have a helper SQLite database. V1 extends
the helper's existing hardened file-store pattern with a
`FileCodexConversationStore` under:

```text
~/Library/Application Support/The Triangle/model-state/instances/<instanceId>/codex-runtime/
  profile.json
  conversations/<roomId>.json
  completions/<bounded-idempotency-id>.json
```

Directories are owner-only `0700`; records are regular, single-link `0600`
files. Writes use directory locks, bounded strict JSON, temporary-file fsync,
atomic rename, and parent-directory fsync. Symlinks, unexpected files, duplicate
JSON members, oversized records, and unsafe ownership/modes fail closed. This
store contains identifiers and state only—never message text, assistant output,
MESH credentials, or ChatGPT session material.

## Proposed architecture

```text
                         MESH
              rooms / mailbox / replies / ack
                           |
                           v
              signed triangle-mailbox helper
        credentials, claim/read/reply/ack, durable runtime state
                           |
                           v
                Triangle Client supervisor
                           |
             +-------------+-------------+
             |                           |
             v                           v
   Headless Codex pool             Desktop adapter
   default runtimeMode             optional runtimeMode
   private stdio children          existing loopback WS server
             |                     + isolated ChatGPT UI
       +-----+-----+
       |           |
   app-server  app-server       initial pool size: 2
     slot 1      slot 2         configured maximum: 4
```

### Why private standard I/O for headless workers

Each headless App Server has exactly one controller. Standard I/O therefore
provides the smallest attack surface and ties the child lifecycle directly to
the worker slot. It avoids an unnecessary local listener, capability token,
and orphan client problem.

The desktop adapter remains loopback WebSocket-based because both Triangle and
ChatGPT.app must attach to the same App Server.

### Implementation language

The first implementation belongs in the existing Node coordinator under
`packages/agent-worker`. The protocol and durable schema remain
language-neutral, but adding Rust solely to copy the reference implementation
would duplicate supervision, release, logging, signing, and test machinery.

The signed Swift helper continues to own secrets and bounded durable operations.
No model or App Server logic moves into the helper.

### Codex authentication and runtime home

Headless slots and the optional desktop adapter use one dedicated
Triangle-managed `CODEX_HOME` per installation, separate from the user's ordinary
Codex desktop home. The operator authenticates that home through a supported
Codex login flow; Triangle never copies ChatGPT cookies, exports bearer tokens,
or stores Codex authentication in the MESH helper registry. The path is supplied
through the sanitized child environment, never argv.

Sharing one runtime home is required for cross-slot and desktop handoff of local
thread state, but concurrent App Server safety is not assumed. Phase 0 must prove
that two bundled App Servers can safely start, resume distinct threads, and
recover using the same dedicated home. Until that gate passes, the configured
pool size is forced to one and desktop handoff remains disabled. A failed probe
never falls back to the user's default `~/.codex`.

Each child receives a minimal environment. Stderr is bounded and redacted before
logging; raw diagnostics are not persisted. Authentication files never enter the
helper conversation store, process arguments, status output, or support bundles.

## Component design

### 1. `CodexAppServerProcess`

One object owns one child process and one JSON-RPC connection.

Responsibilities:

- spawn the reviewed Codex binary as `codex app-server`;
- pipe stdin/stdout and isolate stderr as sanitized diagnostics;
- send `initialize`, validate server capabilities and identity, then send
  `initialized`;
- expose bounded calls for `thread/start`, `thread/resume`, `thread/read`,
  `turn/start`, and `turn/interrupt`;
- correlate responses and events by request, thread, and turn identifiers;
- reject unknown or malformed protocol events;
- fail every pending call when the child exits;
- terminate the child on owner shutdown; and
- never receive MESH credentials or raw credential-bearing configuration.

The wrapper must generate or validate schemas against the bundled Codex version
during release verification. Protocol drift is a compatibility failure, not a
best-effort warning.

### 2. `CodexWorkerPool`

The pool owns a bounded set of `CodexAppServerProcess` objects.

Initial policy:

- default size: 2;
- configurable maximum: 4;
- at most one active turn per slot;
- at most one admitted or running conversation per profile in v1;
- FIFO admission within a profile, with fair scheduling across profiles;
- sticky reuse of the last healthy slot for a conversation;
- no queue admission after drain begins; and
- bounded queue length and wait time, both reported without message content.

The pool is an optimization, never the source of conversation identity. It does
not maintain a second delivery queue. The existing profile scheduler remains the
sole admission queue; an admitted Codex turn consumes one host-wide
`maxConcurrentReasoners` permit and one available Codex slot as one composed
permit. An idle slot consumes no global reasoner permit. The pool size is a
Codex-specific upper bound and can never increase the host-wide limit used by
Hermes or other adapters.

If a sticky slot is unavailable, another healthy slot resumes the persisted
thread.

Repeated slot crashes enter exponential backoff with jitter and a circuit-open
state. The supervisor must not create an unbounded restart loop.

### 3. `CodexConversationRegistry`

The signed helper owns the durable local registry. The Node runtime accesses it
through versioned, bounded stdin operations.

Proposed logical profile owner record (`profile.json`):

```text
profile_instance_id
runtime_mode                 headless | desktop
owner_instance_id
owner_generation
ownership_state              owned | transferring
lease_renewed_at
lease_expires_at
active_mesh_room_id
updated_at
```

Proposed conversation record (`conversations/<roomId>.json`):

```text
profile_instance_id
mesh_room_id
codex_thread_id
active_delivery_id
execution_epoch
execution_state              idle | admitted | running | result_ready | reply_persisted | acked
last_worker_slot_id
last_completed_delivery_id
last_reply_event_id
updated_at
```

Keys and constraints:

- the profile owner record is unique per `profile_instance_id`;
- conversation primary key: `(profile_instance_id, mesh_room_id)`;
- `codex_thread_id` is unique within one profile unless an explicit migration
  aliases a conversation;
- ownership changes use compare-and-swap on `owner_generation`;
- one profile-level owner record gates every conversation under that profile;
- `ownership_state = transferring` cannot admit or start a turn;
- an active delivery is unique per conversation;
- an execution epoch increases on every admitted attempt; and
- secret material and inbound message text are forbidden.

The registry is local continuity, not network truth. MESH remains authoritative
for delivery and reply state.

#### Lease liveness

The owner renews its lease while any conversation is `admitted`, `running`,
`result_ready`, or `reply_persisted`. Wall-clock expiry is only a signal for an
idle owner. It can never authorize another owner to steal a non-idle profile.

An expired idle lease may be replaced only by compare-and-swap against the last
observed `owner_generation` and state. Non-idle expiry, clock reversal, excessive
clock skew, or missed renewal freezes admission and requires reconciliation or
operator recovery. The monotonic lease duration is evaluated in-process; durable
timestamps exist for diagnosis, not as sole proof that an active owner is dead.

After host restart, no owner is presumed live. The supervisor reconciles the
open helper transaction, execution state, Codex thread history, and MESH terminal
state before acquiring a new generation.

### 4. `HeadlessCodexRuntime`

Headless ingress is the existing supervisor path: helper-held watch/poll emits a
wake hint, the profile scheduler checks capacity, and the trusted transaction
proxy claims and reads the delivery. The Node runtime never authenticates to MESH
directly. When the pool or global reasoner circuit is saturated, the scheduler
coalesces wake watermarks with bounded backoff and leaves excess work unclaimed;
it does not spin on the same delivery.

The runtime converts one verified MESH delivery into at most one Codex turn.

For a new conversation:

1. acquire the execution lease;
2. reserve a worker slot;
3. call `thread/start` with the configured working directory and sandbox;
4. persist the returned thread identifier before `turn/start`; and
5. admit the delivery.

For an existing conversation:

1. acquire the execution lease;
2. reserve the sticky or next healthy slot;
3. call `thread/resume` and verify the returned thread identifier;
4. reconcile recent thread history when submission outcome is uncertain; and
5. admit only when no matching completed or in-progress turn already exists.

The runtime, not the model prompt, owns retries, correlation, reply
idempotency, and completion. Every admitted turn carries a bounded, non-secret
correlation tag derived from `(profile_instance_id, delivery_id,
execution_epoch)`. Phase 0 must prefer a schema-supported metadata field. If the
bundled protocol exposes none, the runtime uses a reviewed machine-readable
input preamble and proves that `thread/read` returns it. Only the tag and returned
turn ID are persisted; message bodies are not. Unknown submission recovery
matches the tag or known turn ID before deciding whether another `turn/start` is
safe.

### 5. Existing desktop adapter

The current Shared Codex App Server remains the implementation for
`runtimeMode: desktop`. In v1 this mode owns the entire profile and its mailbox,
not selected conversations. Operators continue to bind the desktop thread
explicitly; focus changes and latest-thread discovery never rebind it.

It continues to provide:

- an authenticated loopback WebSocket endpoint;
- an isolated ChatGPT user-data directory;
- a desktop-resumeable bound thread;
- visible unattended turns; and
- the current reply-before-ack settlement path.

Its binding evolves from a single implicit owner into an explicit conversation
ownership record. Existing binding files remain readable during migration.

## Delivery and execution state machine

### Work requiring a reply

```text
NOTIFIED
  -> CLAIMED
  -> LEASED
  -> ADMITTED
  -> RUNNING
  -> RESULT_READY
  -> REPLY_PERSISTED
  -> ACKED
  -> COMPLETED
```

Rules:

- `CLAIMED` is not model admission.
- `ADMITTED` requires a durable execution epoch and exclusive lease.
- only one turn may be `RUNNING` for a conversation initially;
- empty assistant output and `[NO_REPLY]` fail settlement for work requiring a
  reply;
- `REPLY_PERSISTED` records the canonical MESH reply event identifier before
  acknowledgment;
- `ACKED` is retried idempotently; and
- only MESH terminal state establishes network completion.

### Receipt-only delivery

```text
NOTIFIED -> CLAIMED -> ACKED -> COMPLETED
```

No worker slot is reserved, no Codex thread is created or resumed, and no MESH
reply is posted.

### Admission versus completion

An internal `accepted` or `admitted` event means only that the runtime has taken
responsibility for scheduling the delivery. It must never be interpreted as a
MESH acknowledgment or successful work result.

## Idempotency and duplicate handling

The effective idempotency key is derived from immutable delivery coordinates,
including profile instance, inbound event, claim/delivery identity, and
execution epoch where appropriate.

Behavior:

| Condition | Required behavior |
| --- | --- |
| Duplicate while queued or active | Do not start another Codex turn; return current state. |
| Duplicate after reply persistence | Replay the canonical reply identifier and continue ack reconciliation. |
| Matching duplicate completion | Return the original canonical result; report `applied: false`. |
| Conflicting completion | Reject and quarantine for operator inspection. |
| Disconnect after `turn/start` | Reconcile thread history before retry; never blindly submit. |
| Disconnect after reply persistence | Retry ack using the same durable transaction and reply identifier. |
| Process restart | Reload active records, reconcile with MESH, then resume or quarantine. |

An in-memory completion cache may reduce repeated reads but is never the
authority. Local durable records plus MESH idempotency must survive process and
host restart.

After MESH terminal state is verified, the full local completion record is kept
for seven days. It is then compacted to an identifiers-only tombstone containing
the profile, room, delivery/idempotency identity, canonical reply event ID, and
completion timestamp. Tombstones expire after 30 days. Neither form stores
message or assistant text; later duplicates defer to MESH after local expiry.

## Cross-system completion semantics

Triangle cannot atomically commit one transaction across the local helper store
and remote MESH. The design therefore uses an idempotent reconciliation
protocol:

1. `transaction-reply` persists or returns the canonical MESH reply using a
   deterministic idempotency key.
2. The helper records `REPLY_PERSISTED` and the returned reply event ID.
3. `transaction-ack` advances the MESH delivery terminal state.
4. The helper records local completion and releases the lease.

A crash between any steps replays the same operation. No step invents a new
reply identifier after a canonical reply has been returned.

## Thread ownership and desktop handoff

### Invariants

- At most one owner generation may claim or acknowledge work for a profile.
- At most one owner generation may call `turn/start` for a Codex thread.
- A transfer generation may inspect and verify state but cannot claim, admit,
  acknowledge, or call `turn/start`.

### Headless to desktop

1. pause new admissions for the entire profile;
2. wait for or explicitly cancel the active turn;
3. require `execution_state = idle` and no open delivery;
4. compare-and-swap the owner to a transfer generation;
5. start or select the desktop App Server;
6. verify `thread/resume` and `thread/read` on the expected thread;
7. commit `runtime_mode = desktop` with the desktop server identity; and
8. reopen admission through the desktop adapter.

Failure before step 7 rolls ownership back to headless. Failure after step 7
leaves desktop as owner and freezes admission until explicit recovery; it must
not silently reactivate headless execution.

Post-commit recovery uses `triangle-client codex-runtime doctor --profile` to
report owner, generation, lease age, execution state, bound thread ID, App Server
health, and ChatGPT attachment state without message text. If the desktop App
Server is healthy but ChatGPT.app is absent, `handoff recover-desktop` relaunches
and verifies the same binding. If the server or thread cannot be verified, the
operator must either restore desktop attachment or run `handoff rollback-headless`;
the latter succeeds only after proving no active turn/open delivery and resuming
the exact thread on a headless slot. Orphaned transfer generations are never
cleared by TTL alone.

### Desktop to headless

The reverse handoff uses the same idle and compare-and-swap gates. The desktop
adapter stops admission, proves no active turn, releases its generation, and a
headless slot verifies resume before becoming owner.

### No mirror mode

Headless execution followed by copying text into ChatGPT is not ownership and
does not preserve tool state or a trustworthy conversation history. This design
does not add such a mode.

## Cancellation

Cancellation is scoped to `(conversation, delivery, execution_epoch)`.

- A queued delivery is removed without starting a turn.
- A running delivery sends `turn/interrupt` once and waits for a terminal event.
- The slot is not reused until terminal state is observed or the child is
  abandoned.
- If the child is abandoned, its process is terminated; a clean slot later
  resumes the persisted thread.
- Cancellation never acknowledges work unless the MESH contract explicitly
  marks it canceled or a bounded failure reply has been persisted.

Late events from a stale epoch are ignored and logged as metadata-only
diagnostics.

## Sandbox and approval policy

The reference runtime uses `approvalPolicy: never`. Triangle may do so only
when the profile's autonomous sandbox is fully resolved before admission.

Required policy:

- Phase 0 generates the schema from the exact bundled Codex binary and records
  the supported sandbox and approval enum allowlist in the immutable runtime
  manifest; Phase 1 cannot start until configuration validation uses that
  allowlist;

- each profile declares an allowed working directory and sandbox class;
- paths are canonicalized and checked against the profile's configured roots;
- an unresolved or unsupported sandbox fails closed before claim admission;
- autonomous workers cannot pause indefinitely awaiting desktop approval;
- elevated or destructive actions require a bounded failure/clarification
  result, not silent escalation;
- App Server child environment contains no MESH credentials; and
- the runtime never places tokens, message bodies, or sensitive prompts in
  process arguments or logs.

Desktop mode may retain interactive approval behavior, but ownership cannot
move to headless while an approval or turn is outstanding.

## Supervision and operations

The existing `dev.thetriangle.client` service should supervise the headless
pool. Do not introduce one LaunchAgent per App Server child.

Required operator operations:

- `status`: slots, queue depth, active conversation count, lease age, owner and
  generation, execution state, circuit state, bound thread ID, and pending
  reconciliation counts;
- `pause`: stop new mailbox admission while leaving active work alone;
- `drain`: pause, finish or cancel bounded active work, then stop App Servers;
- `resume`: revalidate runtime and restart the configured pool;
- `doctor`: verify Codex binary/protocol, helper schema, durable store, sandbox
  roots, and MESH transaction capability; and
- `handoff`: perform an explicit idle-only headless/desktop ownership transfer.

`drain` is the supported preparation for upgrades and for changing desktop
remote-connection settings that reject multiple running Codex instances.

The existing profile scheduler remains the only work queue and retains
per-profile single-flight. `maxConcurrentReasoners` remains the host-wide budget
across Codex, Hermes, and other reasoning adapters. A Codex admission consumes
one global permit and one pool slot together; it never waits in a second hidden
pool queue while holding only one of them.

## Observability

Logs and metrics contain identifiers only in approved opaque or hashed form.
They must not contain message text, assistant output, credentials, environment
dumps, or complete filesystem paths outside reviewed diagnostics.

Minimum metrics:

- worker slots by state;
- queued, admitted, running, and reconciling deliveries;
- admission wait and turn duration;
- thread starts versus resumes;
- duplicate suppression and completion replay counts;
- App Server restart/backoff/circuit events;
- reply persistence and acknowledgment retries;
- stale epoch events;
- lease conflicts and handoff duration; and
- receipt-only deliveries that avoided model admission.

Status claims must distinguish mailbox receipt, admission, Codex completion,
reply persistence, MESH acknowledgment, and visible desktop rendering.

## Proposed source layout

```text
packages/agent-worker/src/codex-runtime/
  app-server-process.mjs
  app-server-protocol.mjs
  worker-pool.mjs
  conversation-registry.mjs
  headless-runtime.mjs
  execution-state.mjs
  completion-reconciler.mjs
  desktop-handoff.mjs

packages/agent-worker/test/codex-runtime/
  app-server-process.test.mjs
  worker-pool.test.mjs
  execution-state.test.mjs
  completion-reconciler.test.mjs
  desktop-handoff.test.mjs

packages/macos-mailbox-helper/
  FileCodexConversationStore and bounded registry/lease operations
```

Existing `shared-codex-app-server.mjs` remains the desktop adapter during the
migration. Common protocol parsing may be extracted only after parity tests
protect current desktop behavior.

## Configuration

Proposed profile fields:

```json
{
  "runtimeAdapter": "codex-app-server",
  "runtimeMode": "headless",
  "conversationKey": "roomId",
  "maxInFlightPerProfile": 1,
  "workingDirectory": "/approved/project/path",
  "sandboxClass": "workspace-write",
  "codexPool": {
    "preferredSize": 2,
    "maxSize": 4,
    "maxQueueDepth": 32
  }
}
```

`runtimeMode` defaults to `headless` for newly created Codex profiles only after
the rollout gate. Existing `mcp-interactive` profiles remain desktop-bound until
explicitly migrated.

Configuration changes use the existing transactional reload and rollback path.
A reload must not retire a functioning desktop owner until the replacement
headless runtime proves readiness.

## Failure handling

| Failure | Response |
| --- | --- |
| App Server exits before admission | Release slot; retain claim/lease state; retry with backoff. |
| App Server exits during turn | Mark outcome unknown; reconcile thread history on a clean slot. |
| Malformed App Server event | Quarantine slot; do not acknowledge delivery. |
| MESH disconnect before claim | Reconnect; no execution occurred. |
| MESH disconnect after reply | Retry canonical completion and ack. |
| Helper unavailable | Pause admission; never fall back to Node-held credentials. |
| Lease conflict | Do not run; refresh registry and surface owner metadata. |
| Desktop handoff failure | Roll back before commit or retain desktop ownership after commit. |
| Queue overload | Leave work durable in MESH; do not claim beyond capacity. |
| Repeated child crashes | Open circuit; coalesce wake watermarks with bounded backoff, keep delivery unclaimed/retryable, and require health recovery. |
| Host restart | Reconcile active records and MESH state before accepting new work. |

## Verification strategy

### Unit tests

- App Server framing, request correlation, event validation, and exit behavior.
- Thread start/resume and exact thread identity checks.
- FIFO/fair pool admission, sticky assignment, and bounded queue behavior.
- Atomic lease acquisition, renewal, non-idle no-steal, clock-skew failure, and stale-generation rejection.
- Duplicate active delivery suppression.
- Matching completion replay and conflicting completion rejection.
- Receipt-only no-model path.
- Empty/`[NO_REPLY]` fail-closed settlement.
- Cancellation before start, during turn, and after a late terminal event.
- Secret and content redaction.

### Integration tests

- Fake App Server crash before and after `turn/start` response.
- Lost completion event followed by `thread/read` reconciliation.
- Helper restart between reply persistence and acknowledgment.
- Supervisor restart with queued, running, and reply-persisted records.
- Concurrent duplicate delivery to two worker slots: exactly one turn starts.
- Global reasoner budget composed with pool slots, including a concurrent
  non-Codex reasoner.
- Circuit-open wake storm coalesces watermarks without claim or busy looping.
- Correlation-tag recovery after a lost `turn/start` response.
- Pool saturation leaves excess work unclaimed in MESH.
- Headless-to-desktop and desktop-to-headless handoff at idle.
- Handoff rejection during a turn or approval.
- Old desktop binding compatibility.

### Live canaries

1. New headless conversation: one inbound event, one substantive threaded reply,
   one acknowledgment, quiet mailbox.
2. Existing conversation: second inbound resumes the same Codex thread and uses
   prior context.
3. Forced child termination: clean child resumes without duplicate reply.
4. WSS/network interruption: cached completion reconciles idempotently.
5. Receipt-only event: no Codex turn and no outbound MESH reply.
6. Desktop handoff: visible continuation in the expected ChatGPT thread.
7. Return to headless: same thread resumes only after desktop ownership release.

### Release gates

The default must not flip until all are true:

- focused Node and helper suites pass;
- full repository suites pass or unrelated failures are explicitly bounded;
- Darwin signed-helper and LaunchAgent tests pass;
- crash-boundary, reconnect-storm, concurrent duplicate, and handoff tests pass;
- a wall-clock 24-hour soak passes with no duplicate/lost replies, no lease
  overlap, bounded concurrency, and final watermark convergence;
- existing desktop wake canary still passes independently; and
- operator pause/drain/restart recovery is documented and rehearsed.

Compile success, focused tests, live canaries, and soak evidence are reported as
separate claims.

## Rollout plan

### Phase 0 — protocol and schema spike

- Implement the App Server stdio wrapper against a fake server.
- Generate/validate protocol schemas and pin exact sandbox/approval enum values
  for the bundled Codex version.
- Establish one dedicated Triangle runtime `CODEX_HOME` through a supported login
  flow; prove cross-slot thread resume and concurrent-process safety. Until this
  passes, force pool size one and disable desktop handoff.
- Prove a metadata correlation field or the reviewed input-preamble fallback for
  unknown-submission reconciliation.
- Add the helper-owned hardened file store behind an inactive feature flag.
- No profile behavior changes.

### Phase 1 — single-slot shadow runtime

- Run one headless slot only for an isolated test profile.
- Prove new/resumed thread continuity and reply-before-ack.
- Keep production desktop profiles unchanged.

#### Phase 1 implementation status (2026-09-20)

Shipped under `packages/agent-worker/src/codex-runtime/`:

| Piece | Module |
| --- | --- |
| Single-slot pool (`forcedPoolSize: 1`) | `worker-pool.mjs` |
| In-memory room→thread registry (slot-restart durable) | `conversation-registry.mjs` |
| Reply-before-ack execution stages | `execution-state.mjs` |
| Shadow runtime (test profile only) | `headless-runtime.mjs` |
| Opt-in gating | `config-guards.mjs` → `resolvePhase1ShadowRuntimeConfig` |

**Not in Phase 1:** supervisor migration of production profiles, durable helper
lease/epoch recovery (Phase 2), multi-slot pool (Phase 3), desktop handoff
(Phase 4). Global `featureFlags.headlessRuntime` stays `false`.

##### Operator enablement (test profile only)

1. Isolated profile shape (do **not** set on production mcp-interactive / Bob):

```json
{
  "profileId": "codex-shadow-test",
  "runtimeAdapter": "codex-app-server",
  "runtimeMode": "headless",
  "shadowTestProfile": true,
  "approvalPolicy": "never",
  "sandboxClass": "workspace-write",
  "workingDirectory": "/approved/project/path"
}
```

2. Host enablement (either):

```sh
export TRIANGLE_HEADLESS_SHADOW_ENABLE=1
# or
export TRIANGLE_HEADLESS_SHADOW_PROFILES=codex-shadow-test
```

3. Dedicated Triangle `CODEX_HOME` only; never fall back to `~/.codex`.
   `forcedPoolSize` remains **1**. See
   `packages/agent-worker/src/codex-runtime/manifest/REPIN.md`.

### Phase 2 — durable recovery

- Add lease, epoch, completion reconciliation, restart recovery, and receipt-only
  coverage.
- Run crash-boundary and reconnect tests.

#### Phase 2 implementation status (2026-09-20)

Shipped under `packages/agent-worker/src/codex-runtime/` behind the **same**
Phase 1 shadow opt-in (`shadowTestProfile` + operator enablement). Global
`featureFlags.headlessRuntime` / `helperConversationStore` stay **false**.
`forcedPoolSize` remains **1**.

| Piece | Module |
| --- | --- |
| Durable file store (helper schema mirror) | `durable-conversation-store.mjs` |
| Profile execution lease (acquire/renew/CAS/no-steal) | `execution-lease.mjs` |
| Durable-backed registry | `conversation-registry.mjs` → `createDurableConversationRegistry` |
| Completion replay + restart reconcile | `completion-reconciler.mjs` |
| Receipt-only + recoverAfterRestart + stale epoch | `headless-runtime.mjs` |

**P1 ownership / cancel / timeout / completion gaps fixed (pre-Phase 3):**

- File-backed lease CAS holds an exclusive inter-process lock across
  compare+write (`withProfileLock`); concurrent two-process replace fails closed
  for the loser (`lease_cas_conflict`).
- `cancelDelivery` interrupts via the owning delivery handle /
  `pool.getActiveHandle` — never a second `acquire` while the sole slot is busy
  — and only clears registry state after a confirmed interrupt (else quarantines).
- Turn wait timeout / crash-before-terminal outcome interrupts, restarts the
  slot process, and leaves the delivery non-idle for reconciler quarantine
  before the slot is reusable.
- When the durable store is enabled, a non-empty canonical `replyEventId` is
  required before `reply_persisted`, completion write, or ack; otherwise fail
  closed (`completion_reply_missing`). Non-durable unit paths without a proxy
  may still record order-only settlement.

**Why a Node durable file (not the Darwin helper store yet):** CI and the Linux
agent environment cannot exercise the signed helper's `FileCodexConversationStore`.
Phase 2 activates a schema-compatible Node store only when the shadow runtime
passes `durableStore: { enabled: true, root }`. Production helper
`CodexRuntimeFeatureFlags.conversationStoreEnabled` stays inactive. Records are
identifiers only — no MESH credentials.

**Not in Phase 2:** multi-slot pool (Phase 3), desktop handoff (Phase 4),
default migration / production profile flip (Phase 5). Do **not** start Phase 3
until these P1 fixes remain green on the focused suite.

##### Focused verification

```sh
node --test packages/agent-worker/test/codex-runtime/*.test.mjs
```

Covers lease CAS/conflict/stale-generation/non-idle no-steal, concurrent
two-process CAS, epoch ignore, receipt-only, reply_persisted ack-only restart
recovery, crash-boundary child exit, reconnect after slot restart, cancel
without second acquire, turn-timeout slot quarantine/restart, and durable
replyEventId fail-closed.

### Phase 3 — bounded pool

- Enable two slots for test profiles.
- Prove concurrency, fairness, sticky assignment, overload behavior, and circuit
  breaking.
- Keep maximum four but do not use four by default.

### Phase 4 — optional desktop handoff

- Add explicit idle-only ownership transfer.
- Prove both directions and rollback behavior.
- Retain the existing Shared App Server runbook.

### Phase 5 — default migration

- New Codex profiles default to headless App Server mode.
- Existing `mcp-interactive` profiles require explicit migration.
- After soak and production canaries, migrate selected profiles one at a time.
- Preserve a rollback path to the prior desktop binding or command adapter.

## Compatibility and migration

- Existing `deliveryMode: mcp-interactive` keeps current behavior.
- Existing App Server bindings are not rewritten by installation alone.
- Existing `event-driven` command adapters remain available during migration but
  are not treated as equivalent to the persistent App Server runtime.
- The profile schema version must distinguish legacy command execution,
  headless App Server execution, and desktop App Server execution.
- Runtime bundles remain immutable and content-addressed.
- A failed install or first-start gate restores the previous runtime and service
  configuration without activating a second mailbox consumer.

## Security review checklist

- [ ] No `mesh_` or `mesh_watch_` credentials reach Node or Codex children.
- [ ] No credential or prompt text appears in argv, plist, logs, metrics, or
      durable registry rows.
- [ ] App Server child uses private stdio; desktop listener remains loopback and
      capability-authenticated.
- [ ] Working directories and sandbox classes are validated before claim.
- [ ] Runtime binary and protocol compatibility are integrity-checked.
- [ ] Lease and execution epoch prevent dual owners and stale completion.
- [ ] Reply idempotency key is deterministic and conflict-checked.
- [ ] Receipt-only work cannot reach `turn/start`.
- [ ] Pause/drain does not abandon an unreconciled delivery.
- [ ] Desktop handoff cannot occur during an active turn or approval.

## Phase 0 questions and required evidence

The v1 product decisions above are closed. Phase 0 must still produce evidence
for version- and implementation-dependent details before Phase 1 code is
enabled:

1. Which exact sandbox and approval enum values are generated by the bundled
   Codex version, and does the immutable runtime manifest reject every other
   value?
2. Does the App Server expose a non-secret metadata field that survives
   `thread/read`; if not, does the reviewed correlation preamble round-trip
   without contaminating the assistant result?
3. Can two bundled App Servers safely share the dedicated Triangle
   `CODEX_HOME`, resume distinct threads, and survive forced restart?
4. What bounded `thread/read` window is sufficient once the correlation tag or
   stored turn ID is available?

Per-conversation desktop ownership and production pool size above two are
post-v1 product questions. They do not weaken v1 profile-wide ownership or the
release gates.

## Related documents

- [Project status](PROJECT-STATUS.md)
- [Unattended wake hosts](2026-09-13-unattended-wake-hosts.md)
- [Shared Codex App Server runbook](shared-codex-app-server-runbook.md)
- [Codex desktop wake implementation handoff](codex-desktop-wake-handoff.md)
- [Realtime mailbox Phase 2](2026-09-03-realtime-mailbox-phase-2.md)
- [Release workflow](release-workflow.md)
