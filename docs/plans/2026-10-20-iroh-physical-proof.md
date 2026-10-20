# Isolated iroh two-computer proof

Approved scope: Mac Mini and MacBook Pro, direct and forced-relay messaging,
offline/restart recovery, and one real Codex peer-local request/reply. MESH and
its installed lanes stay untouched. No production release or full
signed-roster/hybrid claim.

## Acceptance and safety

- Build/test the existing peer engine before changing its transport behavior.
- Add transport-only diagnostics and a relay-only option using supported iroh
  transport configuration; verify actual path instead of treating receipt as
  direct-path evidence. No global firewall or VPN/network changes.
- Use isolated 0700 state, fresh device identities and explicit mutual static
  allowlists. SSH may exchange public endpoint addresses and start processes;
  exclude Tailscale IP routes from advertised direct candidates for the proof.
- A small private-IPC proof broker accepts a typed, bounded peer request, runs a
  single injected harness and returns a linked typed reply. Bind responses to
  the authenticated sender, not an address supplied inside the payload.
- Persist admission before inference and deterministic reply identity before
  settlement. A crash during unknown inference quarantines rather than reruns;
  a stored reply retries delivery without another inference. Never ack a peer
  input before its response has been durably admitted to the outbox.
- The real Codex child gets isolated provider state and a read-only workspace;
  deny access to MESH credentials and peer custody/IPC via an outer sandbox.
  The broker may access peer IPC but has no MESH authority or helper dependency.
- Prove direct, forced relay, offline send/reconnect, receiver restart with stable
  identity, duplicate input, and a substantive real-harness linked reply. Record
  command-to-receipt and request-to-reply separately.
- Two processes/VMs on one computer do not meet the physical-machine gate. If the
  MacBook or separate network/SSH is unavailable, finish local preparation and
  name the precise remaining physical proof instead of claiming completion.

## Physical run results (2026-10-20)

- Both Macs were online on the same home Wi-Fi. SSH used Tailscale only for
  private control and file setup; Iroh proof addresses excluded Tailscale IPs.
- Direct-only delivery to the Mini's LAN address did not settle. The MBP Iroh
  log recorded `No route to host` for its QUIC UDP send, while ping and a raw UDP
  probe between those LAN addresses succeeded. Treat direct LAN / hole-punch
  behavior as unresolved; this run does not establish a direct path.
- Forced relay succeeded on both machines. Iroh diagnostics selected
  `https://usw1-1.relay.n0.iroh.link./` for the real Codex request and its
  linked reply. Codex returned `PEER_REAL_CODEX_RESULT 346` and ran once.
- Offline recovery succeeded over the same relay path: the sender queued a test
  message while the Mini was stopped, the MBP service restarted with the same
  identity, then the Mini restarted with its same identity. The outbox settled
  and the Mini observed one matching message before ACK.
- This is a physical-machine relay proof on one network. Separate-network NAT
  traversal/hole punching remains unverified; repeat with the MacBook on a
  phone hotspot. Exact private evidence is under
  `/private/tmp/triangle-peer-physical-20261020/` and is not included in Git.
- The Codex request/reply was a clean fresh run. A prior resumed attempt also
  delivered but its inbox contained a test-only untyped probe; that item was
  explicitly ACKed by exact ID before the clean run. No MESH state was touched.

## Ownership

Rust transport worker: engine.rs/main.rs/ipc.rs and transport diagnostics/tests.
Broker worker: tools/peer-proof-broker.mjs and its JS tests/docs only.
Parent: proof plan, setup/orchestration, sandboxed real Codex, physical evidence.
