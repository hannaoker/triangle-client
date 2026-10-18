# iroh version choice and provenance

## Selected dependency

| Item | Choice |
| --- | --- |
| Crate | [`iroh`](https://crates.io/crates/iroh) **1.3.0** |
| Published | 2026-09-28 |
| License | MIT OR Apache-2.0 |
| Upstream | https://github.com/n0-computer/iroh |
| MSRV (upstream) | 1.91 (this package declares `rust-version = "1.85"` floor; build with current stable ≥ 1.91) |

## Why 1.3.0

- Current stable line on crates.io at implementation time (post-1.0 API with
  `Endpoint`, `EndpointAddr`, `SecretKey`, relay presets).
- Supports the connectivity modes the plan requires: direct QUIC and n0 relay
  fallback via `presets::N0`, plus `RelayMode::Disabled` for local proofs.
- Dial-by-public-key matches the device-identity model (endpoint id = public key).
- Dual MIT/Apache-2.0 is compatible with this repository’s MIT license.

We intentionally did **not** pin a pre-1.0 `iroh` release: the 0.9x → 1.x break
renamed node/endpoint types, and staying on the current stable avoids a forced
migration during M2/M3a.

## What we use from iroh

- Persistent `SecretKey` / `EndpointId` for device identity
- `Endpoint::builder(presets::N0)` for default relay + address lookup
- `RelayMode::Disabled` for same-host / same-LAN integration tests
- QUIC bidirectional streams for the `triangle-peer/1` message/receipt ALPN

## What we do **not** reuse

### reason-machines / reason-network

No code was copied from Reason Network. The pivot plan’s M0b component-reuse
decision for this spike is: **implement a small owned peer engine** tailored to
Triangle’s journal, IPC, and secret-confinement boundaries.

If a later lane adapts Reason admission/roster ideas, record license, provenance,
and trust limitations in a follow-up note before importing any source.

### Existing Triangle Node packages

This crate does not import or launch:

- `packages/agent-worker` (including `client-supervisor.mjs`)
- macOS mailbox helper / `WorkerLauncher.swift`
- MESH enrollment, DPoP, or claim/reply/ack paths

## Local licenses of direct deps (summary)

Run `cargo tree -f "{p} {l}"` in this directory for a full tree. Direct runtime
deps of note:

| Crate | License (typical) |
| --- | --- |
| iroh | MIT OR Apache-2.0 |
| tokio | MIT |
| serde / serde_json | MIT OR Apache-2.0 |
| sha2 / hex | MIT OR Apache-2.0 |
| uuid | MIT OR Apache-2.0 |
| anyhow / thiserror | MIT OR Apache-2.0 / MIT OR Apache-2.0 |
