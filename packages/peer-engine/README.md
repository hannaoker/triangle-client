# peer-engine

Rust peer connectivity engine for Triangle’s composable client pivot (lane **L3**,
M0b → M2 start). Speaks [iroh](https://crates.io/crates/iroh) for
direct-or-relayed peer links, owns a durable peer journal, and exposes a
**versioned private Unix IPC** surface for the future Node supervisor/broker.

## Boundaries

- **In scope:** device identity (0700/0600 files), endpoint connect, message +
  receipt protocol, journaled duplicate suppression, Unix IPC contract.
- **Also in scope:** static inbound allowlist (empty = admit nobody) with
  per-peer quotas, verified receipts, bounded outbound retry with exponential
  backoff and 7-day expiry, paginated inbox + `ack`, journal compaction, and a
  state-dir lock (single writer).
- **Out of scope (this PR):** real harness execution via the peer-local
  settlement adapter, macOS/Linux packaging, *signed* roster admission,
  cross-network NAT proof on two physical machines.
- **Never:** MESH bearers/credentials, workload keys, MESH claim emulation, or
  launching existing runtime drains / `client-supervisor.mjs`.

See [docs/IPC_CONTRACT.md](docs/IPC_CONTRACT.md) (draft merge point) and
[docs/IROH_AND_PROVENANCE.md](docs/IROH_AND_PROVENANCE.md).

## Requirements

- Rust **stable ≥ 1.91** (iroh 1.3.0 MSRV)
- Linux or macOS (Unix-domain sockets)

## Build & test

```sh
cd packages/peer-engine
cargo test
```

Run the daemon (direct-only for local experiments). `--state-dir` is required;
admit peers explicitly:

```sh
cargo run -- --state-dir /tmp/peer-a --direct-only --allow-peer <peer-endpoint-id>
# or: --roster roster.json   with {"peers": ["<endpoint-id>", ...]}
```

This package is **not** wired into the root Node `npm test` runner. The repo has
no GitHub Actions Rust job today; keep CI green by leaving Node suites unchanged.
When a Rust CI job is added under `.github/workflows/`, run
`cargo test --manifest-path packages/peer-engine/Cargo.toml`.

## Layout

| Path | Role |
| --- | --- |
| `$STATE_DIR/` | `0700` private root |
| `$STATE_DIR/engine.lock` | exclusive lock held while the engine runs |
| `$STATE_DIR/identity/device.key` | iroh `SecretKey`, `0600` |
| `$STATE_DIR/journal/peer.jsonl` | append-only journal, `0600`, fsync before notify/receipt; torn final record truncated on open; compacted on open and every 10k records |
| `$STATE_DIR/ipc/peer-engine.sock` | IPC socket, dir `0700`, socket `0600` |

## Wire protocol

ALPN: `triangle-peer/1`. Length-prefixed JSON envelopes: `message` and
`receipt` (`status: received_peer`). Stable `message_id` + payload hash; duplicates
are journaled as `duplicate_suppressed` without a second inbox row.

## Journal size bound

- Unconsumed inbound: ≤ `max_unconsumed_per_peer` (1000) items and
  `max_unconsumed_bytes_per_peer` (16 MiB) per roster member.
- Queued outbound: ≤ `max_outbox` (1000) messages and `max_outbox_bytes`
  (64 MiB) of payload.
- A `checkpoint` record preserves the `seq` high-water mark across
  compaction, so inbox cursors (`after_seq`) never go backwards.
- Replay and compaction stream records (no whole-file buffering); background
  retries are capped at `max_in_flight` (16) concurrent attempts; inbound
  handlers are capped globally (`max_inbound_handlers`, 64) and per peer
  (`max_inbound_per_peer`, 8).
- A settled `message_id` is never retransmitted; re-sending it returns a
  receipt with `duplicate: true` from the local journal.
- Settled/refused/expired outbound and consumed inbound tombstones: dropped by
  compaction after `tombstone_retention` (7 days).
- Payloads are stored hex-encoded (2×). Retry attempt counters are in memory
  and reset on restart; expiry uses the durable `queued_at` time.

## Proven locally

Integration tests under `tests/exchange_and_recovery.rs` and
`tests/review_regressions.rs` (in-process, direct path):

1. Two engines exchange a message and verified receipt; restart + duplicate
   redelivery keeps one inbox item and returns `duplicate: true`.
2. Inbound dedupe keyed by (sender, id); conflicting payload refused, never acked.
3. Non-member and wrong-key peers rejected; sender-id spoofing rejected;
   per-peer quota then retry after `ack`.
4. Torn journal tail recovery; second engine on the same state dir refused;
   live IPC socket not replaced.
5. Paginated inbox over 1 MiB, `ack`, dedupe after ack.
6. Tampered receipts (hash / receiver) not settled.
7. Unsendable encoded frames rejected before journaling.
8. Startup does not hang on an unreachable relay.
9. Retry with backoff after admission; expiry is terminal and durable.

## Still unverified

- Separate residential/cellular networks and NAT traversal
- Forced relay when direct UDP is blocked
- Self-hosted relay configuration
- Signed roster / directory binding (only a static allowlist exists)
- Real harness request/reply without MESH/Swift helper
