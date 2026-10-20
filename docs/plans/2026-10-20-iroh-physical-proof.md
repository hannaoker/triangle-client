# Isolated iroh two-computer proof

Approved scope: Mac Mini and MacBook Pro, separate internet connections, direct
and forced-relay messaging, offline/restart duplicate recovery, and one real
Codex peer-local request/reply. MESH and its installed lanes stay untouched.
No production release or full signed-roster/hybrid claim.

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

## Ownership

Rust transport worker: engine.rs/main.rs/ipc.rs and transport diagnostics/tests.
Broker worker: tools/peer-proof-broker.mjs and its JS tests/docs only.
Parent: proof plan, setup/orchestration, sandboxed real Codex, physical evidence.
