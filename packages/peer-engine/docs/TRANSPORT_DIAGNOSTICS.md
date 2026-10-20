# Transport proof interface

`peer-engine --state-dir /private/isolated/state --allow-peer ENDPOINT_ID`
uses normal iroh IP+relay behavior. `--direct-only` disables relays.
`--relay-only` uses iroh 1.3's supported `Endpoint::Builder::clear_ip_transports()`;
IP transports are absent, rather than blocked with global firewall rules.
`--relay-url https://relay.example/` chooses custom relays (repeatable, at most
four credential-free HTTPS origins, 2048 bytes each). Direct-only conflicts
with relay-only and custom relays. All flags are checked before state creation.

`status.transport_policy` reports `direct_only`, `relay_only` or `ip_and_relay`; this is configuration, not observed path evidence.

After private IPC `hello`, call `transport_diagnostics` with `{}` params.
The response is `{ "samples": [...] }`, containing at most 128 recent
connection snapshots, oldest first. Samples are process-local diagnostics,
not a journal extension, and contain no payload text:

```
{
  "peer_endpoint_id": "authenticated remote endpoint id",
  "message_id": "application message id",
  "phase": "before_send | response_received | response_sent",
  "observed_at_unix_ms": 123,
  "paths": [{
    "kind": "direct | relay | custom",
    "selected": true,
    "remote_addr": "iroh transport address",
    "tx_bytes": 123,
    "rx_bytes": 456,
    "rtt_us": 789
  }]
}
```

These are actual `Connection::paths()` snapshots. `selected` identifies the path
selected for application transmission at snapshot time. Byte counters are
per-path QUIC counters and include control/handshake traffic. They do not assign
every payload byte to a path, and a connection can switch paths between samples.
A snapshot with both paths is not proof that a particular message used only one
of them. Inspect before/after snapshots for the same peer/message, and use
transport restrictions plus positive counters for an unambiguous proof.

`relay_online` and `endpoint_addr` remain reachability/candidate information;
neither proves which path carried an exchange. A reused settled message id
returns its existing receipt without transmission and produces no new sample.
Run fresh message ids for transport proof. Physical two-computer and separate
network acceptance remains a separate gate from local tests.
