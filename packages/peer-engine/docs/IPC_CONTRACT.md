# Broker ↔ peer-engine IPC contract (v1)

**Merge point.** This document freezes the versioned private IPC surface between
the existing Node supervisor/broker and the Rust `peer-engine`. Dependent work
(M2/M3a broker adapter) must not invent a parallel control channel.

| Field | Value |
| --- | --- |
| Protocol version | `1` (`IPC_PROTOCOL_VERSION`) |
| Transport | Unix-domain stream socket only |
| Socket path | `$STATE_DIR/ipc/peer-engine.sock` |
| Directory mode | `0700` |
| Socket mode | `0600` |
| Framing | 4-byte big-endian length + UTF-8 JSON body |
| Max request size | 1 MiB (`MAX_IPC_REQUEST_BYTES`) |
| Auth (v1) | Same-UID filesystem permissions on the socket path; no TCP |

There is **no** unauthenticated loopback TCP control endpoint.

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
{
  "protocol_version": 1,
  "id": "client-opaque-id",
  "method": "hello",
  "params": {}
}

// success
{
  "protocol_version": 1,
  "id": "client-opaque-id",
  "result": { }
}

// error
{
  "protocol_version": 1,
  "id": "client-opaque-id",
  "error": { "code": "…", "message": "…" }
}
```

## Methods (v1)

| Method | Params | Result |
| --- | --- | --- |
| `hello` | `{}` | `engine_version`, `protocol_version`, `endpoint_id`, `alpn` |
| `status` | `{}` | identity, state dir, inbox count |
| `endpoint_addr` | `{}` | iroh `EndpointAddr` JSON (id + transport addrs) |
| `inbox` | `{}` | `{ "items": [ … ] }` durable received messages |
| `send` | `message_id`, `payload`, `peer_addr` | `PeerReceipt` |
| `shutdown` | `{}` | `{ "shutdown": true }` (session ends; process exit owned by supervisor) |

### `send` params

```json
{
  "message_id": "stable-logical-id",
  "payload": "utf-8 text",
  "peer_addr": { "id": "<endpoint-id-hex>", "addrs": [ … ] }
}
```

`message_id` is the stable logical id used for duplicate suppression across
retries and restarts.

## Delivery states referenced by the journal

Aligned with pivot plan §7 (peer subset for M2 start):

| State | Meaning |
| --- | --- |
| `queued_local` | Persisted on sender before network send |
| `received_peer` | Recipient durably accepted the message |
| `settled` | Sender recorded a matching receipt |
| `duplicate_suppressed` | Same `message_id` redelivered; inbox unchanged |

## Out of scope for v1

- Named pipes (Windows) — later platform packaging
- Peer process attestation beyond UID/socket mode
- Harness execution / settlement adapter RPCs (later M2)
- MESH claim emulation

## Compatibility

Incompatible changes require bumping `IPC_PROTOCOL_VERSION` and updating this
document in the same PR. Additive optional fields may land under the same
version when ignored by older peers.
