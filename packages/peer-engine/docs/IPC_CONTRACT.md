# Broker ↔ peer-engine IPC contract (v1, draft)

**Status: draft — not frozen.** This is the proposed merge point between the
existing Node supervisor/broker and the Rust `peer-engine`. It becomes frozen
only after the M2 exit gates pass (two physical machines, signed roster, real
peer-local harness) and the broker adapter has been reviewed against it. Until
then, shape changes may land under `protocol_version: 1` as long as this file is
updated in the same PR. Dependent work must not invent a parallel control channel.

| Field | Value |
| --- | --- |
| Protocol version | `1` (`IPC_PROTOCOL_VERSION`) |
| Transport | Unix-domain stream socket only |
| Socket path | `$STATE_DIR/ipc/peer-engine.sock` |
| Directory mode | `0700` |
| Socket mode | `0600` |
| Framing | 4-byte big-endian length + UTF-8 JSON body |
| Max request size | 1 MiB (`MAX_IPC_REQUEST_BYTES`) |
| Max response size | 2 MiB (`MAX_IPC_RESPONSE_BYTES`; fits one max-size inbox item at worst-case JSON escaping) |
| Auth (v1) | Same-UID filesystem permissions on the socket path; no TCP |

There is **no** unauthenticated loopback TCP control endpoint.

## Single instance

`PeerEngine::start` takes an exclusive lock on `$STATE_DIR/engine.lock`; a
second engine on the same state dir fails to start (sole-writer guarantee).
`shutdown` closes the journal for writes before releasing the lock, so a
clone that outlives shutdown cannot append.
`IpcServer::bind` only removes an existing socket path if it is a socket and
nothing answers a connect; a live socket or a non-socket file is an error.

## Secret confinement

The peer engine **must not** receive:

- permanent MESH bearers / `mesh_` tokens
- controller credentials
- unrestricted workload private keys

Any request `params` object containing `mesh_token`, `mesh_bearer`,
`workload_key`, or `controller_credential` is rejected with
`error.code = "secrets_confined"`.

Peer device keys live only under `$STATE_DIR/identity/` (mode `0600`) and are
never exported over IPC.

## Session rules

1. First successful call on a connection **must** be `hello` with
   `protocol_version: 1`.
2. Other methods fail with `hello_required` until hello succeeds.
3. Mismatched `protocol_version` fails with `protocol_mismatch`.

## Request / response shape

```json
// request
{ "protocol_version": 1, "id": "client-opaque-id", "method": "hello", "params": {} }
// success
{ "protocol_version": 1, "id": "client-opaque-id", "result": { } }
// error
{ "protocol_version": 1, "id": "client-opaque-id", "error": { "code": "…", "message": "…" } }
```

## Methods (v1)

| Method | Params | Result |
| --- | --- | --- |
| `hello` | `{}` | `engine_version`, `protocol_version`, `endpoint_id`, `alpn` |
| `status` | `{}` | `endpoint_id`, `state_dir`, `inbox_count` (unconsumed), `outbox_queued`, `journal_records`, `roster_size`, `relay_online` (live home-relay status; `null` when relays disabled) |
| `endpoint_addr` | `{}` | iroh `EndpointAddr` JSON (id + transport addrs) |
| `inbox` | `after_seq?` (default 0), `limit?` (default 50, max 200) | `{ "items": [...], "next_after_seq": n, "has_more": bool }` |
| `ack` | `items: [{ from_endpoint_id, message_id }]` (max 1000) | `{ "acked": n, "already_acked": n, "unknown": [...] }` |
| `send` | `message_id`, `payload`, `peer_addr` | verified `PeerReceipt`, or an error (below) |
| `message_status` | `message_id` | `{ state, attempts, next_attempt_unix_ms, queued_at_unix_ms, reason, ... }` |
| `shutdown` | `{}` | `{ "shutdown": true }` (ends **this session only**; process exit owned by supervisor) |

### `inbox` / `ack`

Inbox items are unconsumed received messages ordered by journal `seq`
(`{ seq, message_id, from_endpoint_id, payload_hash, payload, ts_unix_ms }`).
Pages are bounded by `limit` and a ~1 MiB byte budget (at least one item is
always returned). Page with `after_seq = next_after_seq` while `has_more`.
An `ack` batch is validated as a whole before any item is consumed. Messages stay in the inbox until `ack`ed; acked items leave the inbox but keep a
`(sender, message_id, hash)` tombstone so redelivery is still answered as a
duplicate until the tombstone retention (default 7 days) elapses.

### `send` params and outcomes

```json
{ "message_id": "stable-logical-id", "payload": "utf-8 text", "peer_addr": { "id": "<endpoint-id-hex>", "addrs": [ … ] } }
```

`message_id` (1–256 bytes) is unique per sending device. Re-sending the same id with the same
payload to the same peer is idempotent (an already-settled id is answered from
the local journal with `duplicate: true` and is not retransmitted); a different payload or peer is
`conflict`.

**Idempotency window (bounded).** The sender remembers a settled, refused or
expired id only until its tombstone is compacted, `tombstone_retention`
(default 7 days) after it reached that state; the receiver's dedupe tombstone
for an acked item has the same bound. After that window the id is forgotten
and a re-`send` is treated as a **new** message (it may be delivered again).
Callers must therefore never reuse a `message_id` for a new logical message
and must not rely on retry idempotency past the window (generate globally
unique ids, e.g. UUIDv7). The message is journaled `queued_local` (fsync) **after** the
encoded frame is validated, then one attempt is made.

| Error code | Meaning | Journaled? |
| --- | --- | --- |
| `invalid_params` | bad input or encoded frame > `MAX_FRAME_BYTES` | no |
| `conflict` | id reused locally with different payload/peer | no |
| `outbox_full` | too many queued messages | no |
| `terminal` | id already `expired` or `refused` | — |
| `pending` | durably queued; retry loop continues with backoff until expiry | yes (`queued_local`) |
| `refused` | recipient rejected (e.g. `conflict`) or returned an invalid receipt | yes (`refused`) |

A receipt settles the message only if its `message_id`, `payload_hash`,
`status = received_peer`, and `receiver_endpoint_id` match the sent message and
the dialed peer.

## Peer admission (wire side, not IPC)

Inbound connections are admitted only if the TLS-authenticated remote endpoint
id is on the roster (`EngineConfig::allowed_peers`, `--allow-peer`, `--roster`).
An empty roster admits nobody. Non-members are closed (QUIC code 403,
`not_member`) before any frame is read. A message whose `sender_endpoint_id`
differs from the connection identity is rejected (`sender_mismatch`). Per-peer
quotas bound unconsumed inbox items/bytes (`quota_exceeded`, retryable). This is
a static allowlist, **not** the signed roster required by M2.

## Delivery states referenced by the journal

Aligned with pivot plan §7 (peer subset):

| State | Meaning |
| --- | --- |
| `queued_local` | Persisted on sender before network send |
| `received_peer` | Recipient durably accepted the message |
| `settled` | Sender recorded a verified matching receipt |
| `duplicate_suppressed` | Same sender + `message_id` + payload redelivered; inbox unchanged |
| `refused` | Recipient refused, or receipt failed verification (terminal) |
| `expired` | Not settled within the retry window (default 7 days; terminal) |
| `consumed` | Local consumer acked the inbox item |
| `address_updated` | Refreshed dialable address for a queued outbound message |
| `checkpoint` | Compaction marker preserving the `seq` high-water mark |

## Out of scope for v1

- Named pipes (Windows) — later platform packaging
- Peer process attestation beyond UID/socket mode
- Signed roster / directory binding; runtime roster changes over IPC
- Harness execution / settlement adapter RPCs (later M2)
- MESH claim emulation

## Process contract (supervisor ↔ peer-engine daemon)

When managed as a child process by a supervisor (e.g. `packages/agent-worker`'s
`peer-engine-manager.mjs`):

1. **Spawn & Stdio:**
   - The engine is spawned with `detached: false` and stdio `["ignore", "pipe", "pipe"]`.
   - The supervisor must synchronously attach error and stream listeners before awaiting
     any async initialization.
2. **Readiness Signal:**
   - The daemon writes its ready indicator to `stderr`:
     `peer-engine ready endpoint_id=<64-hex> ipc=<path>`
   - This line is emitted only after the daemon has successfully taken exclusive ownership
     of `$STATE_DIR/engine.lock` and bound the IPC domain socket.
   - The supervisor treats the engine as ready only when this stderr line has been
     observed and a subsequent IPC `hello` request returns a matching `endpoint_id`.
3. **Signals & Process Lifetime:**
   - Graceful termination is requested via `SIGINT` (Ctrl-C). The daemon catches `SIGINT`,
     flushes and commits pending journal operations, releases the lock, and terminates cleanly.
   - The supervisor waits up to 5 seconds after `SIGINT` before sending `SIGKILL`.
   - The IPC `shutdown` method terminates **only the active IPC session/connection**, not
     the daemon process.
4. **Continuous Stream Drainage:**
   - The engine writes operational logging to stdout and stderr.
   - The supervisor must continuously read and drain both stdout and stderr streams.
     Failure to drain streams will block the daemon once OS pipe buffers (~64 KiB) fill.
5. **Sole-Writer Guarantee & Pre-Flight Probe:**
   - Before spawning, the supervisor probes `$STATE_DIR/ipc/peer-engine.sock`.
   - If an existing socket answers a connection attempt, the supervisor refuses to spawn
     with `engine_already_running` without adopting foreign or orphaned engines.

## Node adapter review record (PR #104)

Review of the experimental Node peer supervisor (`packages/agent-worker`) against the
engine contract identified 15 primary findings and 7 hardening items addressed in #104:

- **F1 / F4 / F10 / F14 (Drain state machine & correlation):** Replaced unbounded retention
  and unverified redelivery with SQLite schema `PRAGMA user_version = 1`. Inbound runner
  failures enter `held`, input payload is kept, and the inbound item is acknowledged so
  the inbox advances. Unsolicited replies and late replies against closed outbound
  correlation are rejected with `correlation_closed`. SQL-level indexed queries prevent
  `LIMIT 200` starvation.
- **F2 / D3 / D4 (Wire protocol validation & outcome delivery):** Inbound execution
  failures emit best-effort terminal `outcome` frames. Size limits enforce maximum payload
  (256 KiB) and wire frames (320 KiB).
- **F3 (Poison items):** Malformed envelopes or unroutable frames are rejected and
  acknowledged immediately without invoking the runner or jamming the inbox.
- **F5 / F11 / F12 / X5 (Manager lifecycle):** Enforced binary path safety (regular file,
  not symlinked, executable, secure ownership). Flags `--relay-only --relay-url <url>`
  are passed together. Socket pre-probe rejects foreign engines without adopting. Stop
  uses `SIGINT` directly with single-flight state machine.
- **F6 / D1 (Supervisor isolation):** Reverted premature packaging additions to production
  closure. Created experimental programmatic entry point `peer-supervisor.mjs` and verified
  production bundle closure guard.
- **F7 (Log stream drainage):** Output streams are continuously drained with line buffering,
  ANSI stripping, and rate limits to prevent engine pipe backpressure deadlocks.
- **F8 / X4 (Lane architecture):** Created `peer-lane.mjs` running one durable wake loop per
  configured profile. Construction is lazy (X4); failure of one profile remains isolated
  as that profile's status and never fails supervisor construction or other lanes.
- **F9 (Context ID derivation):** Scoped runner context IDs deterministically from sender
  and request ID digest.
- **F13 (Path safety & capacity):** Shared `peer/private-path.mjs` and `peer/ipc-client.mjs`
  enforce directory security. 10,000-record cap applies backpressure without dropped acks.
- **F15 (Documentation integrity):** Documentation and quickstart restricted strictly to
  reachable programmatic APIs.

## Compatibility

While draft, shape changes update this document in the same PR. Once frozen,
incompatible changes require bumping `IPC_PROTOCOL_VERSION`; additive optional
fields may land under the same version when ignored by older peers.
