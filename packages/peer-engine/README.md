# peer-engine

Rust peer connectivity engine for Triangle’s composable client pivot (lane **L3**,
M0b → M2 start). Speaks [iroh](https://crates.io/crates/iroh) for
direct-or-relayed peer links, owns a durable peer journal, and exposes a
**versioned private Unix IPC** surface for the future Node supervisor/broker.

## Boundaries

- **In scope:** device identity (0700/0600 files), endpoint connect, message +
  receipt protocol, journaled duplicate suppression, Unix IPC contract.
- **Out of scope (this PR):** real harness execution via the peer-local
  settlement adapter, macOS/Linux packaging, signed roster admission,
  cross-network NAT proof on two physical machines.
- **Never:** MESH bearers/credentials, workload keys, MESH claim emulation, or
  launching existing runtime drains / `client-supervisor.mjs`.

See [docs/IPC_CONTRACT.md](docs/IPC_CONTRACT.md) (merge point) and
[docs/IROH_AND_PROVENANCE.md](docs/IROH_AND_PROVENANCE.md).

## Requirements

- Rust **stable ≥ 1.91** (iroh 1.3.0 MSRV)
- Linux or macOS (Unix-domain sockets)

## Build & test

```sh
cd packages/peer-engine
cargo test
```

Run the daemon (direct-only for local experiments):

```sh
cargo run -- --state-dir /tmp/peer-a --direct-only
```

This package is **not** wired into the root Node `npm test` runner. The repo has
no GitHub Actions Rust job today; keep CI green by leaving Node suites unchanged.
When a Rust CI job is added under `.github/workflows/`, run
`cargo test --manifest-path packages/peer-engine/Cargo.toml`.

## Layout

| Path | Role |
| --- | --- |
| `$STATE_DIR/` | `0700` private root |
| `$STATE_DIR/identity/device.key` | iroh `SecretKey`, `0600` |
| `$STATE_DIR/journal/peer.jsonl` | append-only journal, `0600`, fsync before notify |
| `$STATE_DIR/ipc/peer-engine.sock` | IPC socket, dir `0700`, socket `0600` |

## Wire protocol

ALPN: `triangle-peer/1`. Length-prefixed JSON envelopes: `message` and
`receipt` (`status: received_peer`). Stable `message_id` + payload hash; duplicates
are journaled as `duplicate_suppressed` without a second inbox row.

## Proven locally

Integration tests under `tests/exchange_and_recovery.rs`:

1. Two in-process engines exchange a message and receipt (direct path).
2. Restart + duplicate redelivery: identity stable, one inbox item, receipt
   marks `duplicate: true`.
3. IPC `hello` / `status` and refusal of injected MESH bearer params.

## Still unverified

- Separate residential/cellular networks and NAT traversal
- Forced relay when direct UDP is blocked
- Self-hosted relay configuration
- Wrong-key / non-member rejection against a signed roster
- Real harness request/reply without MESH/Swift helper
