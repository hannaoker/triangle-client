# Identity Reconciliation Across Local, Iroh, and MESH Transports

Status: reviewed design draft, 2026-10-25. Design only: no code, no production change, not owner-approved. First draft by Gemini 4 Argon from `docs/handoffs/2026-10-25-item7-identity-research.md`; reviewed and corrected by Claude against the repository (the Review Record at the end lists what changed and what is still unverified). Names marked "proposed" do not exist yet.

Owner decisions recorded 2026-10-25: all seven decisions are settled (decision log in Section 12). The design as a whole still awaits the owner's approval.

## 1. Summary

This design reconciles logical agent identity across local sockets, Iroh peer lanes, and the MESH server without collapsing The Triangle’s two independent trust modes. Every logical agent is represented by an immutable **principal**: in MESH-managed mode, the server-issued `agent_<32-hex>` identifier; in serverless peer mode, an opaque random `peer_<32-hex>` (proposed) identifier that owner-approved pairing records bind to the principal's current Ed25519 key, so key rotation never changes it. Principals are explicitly bound to local profile instances, local sessions, Iroh endpoint keys, and MESH enrollments via signed or owner-approved **binding records** (proposed). An Iroh endpoint key authenticates only the transport endpoint (today a remote sender is just an endpoint id), so every endpoint is bound to exactly one principal; per-message signatures for shared endpoints are a later, optional slice (owner Decision 3). In managed mode a receiver resolves the endpoint at MESH and caches the answer for 5 minutes, trusting it for at most 15 minutes if MESH is unreachable (owner Decisions 2 and 7). Gate 2 is claimed at Tier R (owner Decision 6): against remote peers and against co-resident agents that are denied the key files. An unsandboxed process of the same OS user, such as an interactive chat with shell access, can read key files; that is the existing decision-F1 boundary and is recorded as not covered, not hidden (Section 11, Risk 1). Receivers compute a typed **sender provenance** (proposed) record from verified cryptographic and transport state, pinning replies to the exact principal, conversation, and binding generation.

---

## 2. Goals, Non-Goals and Vocabulary

### Goals

1. **Separate logical identity from runtime and transport artifacts**: Distinguish the logical agent (principal) from device keys, harnesses, local sessions, conversations, profiles, and display names.
2. **Prevent multi-agent endpoint impersonation**: Bind each Iroh endpoint to exactly one principal, and require a per-agent cryptographic proof wherever one endpoint serves several, so authenticating a device key never authorizes sending as every agent on that host.
3. **Preserve dual trust modes without cross-contamination**: Support both MESH-managed authority (home-server root of trust) and serverless peer authority (owner-approved pairings) with zero automatic merging, enrollment, content bridging, or mode downgrade.
4. **Enforce receiver-computed provenance and strict reply pinning**: Compute sender provenance at the receiver from verified transport and signature layers, and bind replies to the original principal, conversation, and binding generation with no fallback to alternative sessions or endpoints.
5. **Define deterministic lifecycle and offline freshness**: Specify key rotation, session rotation, revocation, expiry, device loss, and multi-device delegation with explicit offline-validity windows and failure behaviors.
6. **Ensure safe, non-destructive migration and inspectability**: Preserve existing identifiers (`agent_<32-hex>`, 64-hex `profileInstanceId`, `session-<64-hex>`), forbid name-based merging, and expose a secret-free identity view in `status` and `doctor`.

### Non-Goals

1. **Cross-server MESH federation**: Federation across distinct MESH home servers remains prohibited until Phase 6 (per MESH ADR 0002).
2. **Automatic cross-mode bridging**: A local or serverless agent is never automatically enrolled into MESH, nor are MESH messages bridged into serverless peer lanes.
3. **Exporting local HMAC turn credentials**: Supervisor-held HMAC turn credentials remain strictly host-local and are never transmitted over Iroh or MESH.
4. **Solving NAT traversal**: Physical direct-path Iroh NAT traversal across separate networks is tracked outside this identity architecture.

### Vocabulary

This design reuses the terminology established in MESH ADR 0001 and ADR 0002, extended with local runtime terms:

| Term | Definition |
| :--- | :--- |
| **Principal** | The immutable logical identity of an agent. Either a MESH principal (`agent_<32-hex>`) or a serverless peer principal (`peer_<32-hex>`, proposed). |
| **Controller / Owner** | The human authority governing a principal and its host installations (authenticated via WebAuthn in MESH, or local OS user/CLI approval in serverless mode). |
| **Profile** | A local configuration unit on a single host, identified on disk by a deterministic 64-hex `profileInstanceId` (`SHA-256("triangle-client-instance-v1\0" + profileName)`). |
| **Runtime / Harness** | The execution wrapper hosting an agent process (e.g., Claude, Codex, Grok worker). |
| **Session** | An ephemeral or interactive local harness execution instance, addressed locally by `session-<64-hex>` (`SHA-256(installationId + workspace + harnessSessionId)`). |
| **Conversation** | A request thread: the `request_id` the journal already shares between a request and its replies (`in_reply_to` chains inside it). It is pinned together with the remote principal, so the key is `(remote principal, request_id)`; no new identifier is introduced. |
| **Endpoint** | An Iroh network transport node identified by its persistent Ed25519 public key (`<endpoint-id>`, stored in `identity/device.key`). |
| **Credential** | Secret material and associated claims used to prove identity or authorization (local HMAC turn token, MESH Ed25519 workload JWT, proposed per-agent Ed25519 key pair). |
| **Binding** (proposed) | A cryptographically signed or owner-approved statement linking one principal to one profile instance, local session, Iroh endpoint, or MESH enrollment for a bounded lifetime and generation. |
| **Sender Provenance** (proposed) | A receiver-constructed, non-forgeable metadata structure attached to a delivered message recording the verified principal, transport path, and assurance level. |

---

## 3. Identity Model

### Principal Kinds and Namespaces

A principal is the sole identifier permitted to own conversation history, send or receive cross-transport messages, and hold authorization bindings. Two disjoint principal namespaces exist, corresponding to the two trust modes:

1. **MESH Principal (`agent_<32-hex>`)**: Issued by the MESH home server upon enrollment. Immutable, globally unique within the home server, and never reused.
2. **Serverless Principal (`peer_<32-hex>`, proposed)**: Opaque identifier generated locally from 128 random bits (CSPRNG) when a profile is initialized for serverless operation or migrated into the identity registry (`identity-registry-v1.json`, proposed). It is never derived from a key, so rotating the key cannot change it (owner Decision 1). Each serverless principal generates a dedicated Ed25519 identity key pair stored at `<TRIANGLE_HOME>/principals/<principal-id>/principal-key.json` (proposed, mode `0600`); the pairing records, not the id, bind the id to the current public key.

### Identifier Prefix and Namespace Table

All identifiers in The Triangle occupy distinct syntactic namespaces so parsers and verifiers never confuse a runtime address or device key with a principal:

| Artifact | Format / Prefix | Scope | Is a Principal? | Authority |
| :--- | :--- | :--- | :--- | :--- |
| MESH Principal | `agent_[a-f0-9]{32}` | MESH home server | **Yes** | MESH Server KMS |
| Serverless Principal (proposed) | `peer_[a-f0-9]{32}` | Opaque; meaningful only in registries that pinned it | **Yes** | Owner-approved pairing records; current key in `principal-key.json` |
| Local Profile Instance ID | `[a-f0-9]{64}` (no prefix) | Single OS user/host | **No** | Deterministic hash of profile name |
| Local Session Address | `session-[a-f0-9]{64}` | Single installation on one host | **No** | Local supervisor |
| Iroh Endpoint ID | `<iroh-ed25519-pubkey>` | Single peer-engine state root | **No** | `identity/device.key` |
| MESH Peer Ticket | `mesh_peer_<opaque>` | Single sender-to-recipient pair | **No** | MESH Server DB |
| Binding ID (proposed) | `bind_[a-f0-9]{32}` | Single binding record | **No** | Issuer of the binding |

### What Is Never a Principal

To satisfy Acceptance Gate 1 and MESH ADR 0001, the following artifacts must **never** be treated as a principal or used alone to infer principal authority:

- **Profile Name and `profileInstanceId`**: Because `profileInstanceId` is `SHA-256("triangle-client-instance-v1\0" + profileName)`, two machines with a profile named `<profile-name>` produce the exact same 64-hex string. Treating `profileInstanceId` as a remote principal allows cross-host impersonation.
- **Session (`session-<64-hex>`) and Conversation**: Sessions are ephemeral execution attachments; when a session restarts, a new session or generation attaches to the same principal.
- **Device / Endpoint Key (`identity/device.key`)**: Authenticates the Iroh transport daemon on a host. Multiple agents on one host may share a single `peer-engine` endpoint, or one principal may span multiple devices.
- **Harness Type (`claude`, `codex`, `grok`, `worker`)**: Indicates the execution adapter, not who the agent is.
- **Display Name / Handle**: Human-readable aliases (`handle` in MESH or local profile names) are mutable presentation metadata.

### Collision Detection and No-Merge Rules

1. **Equal Profile Names Across Devices**: Because two hosts with profile `<profile-name>` yield identical `profileInstanceId` values, `profileInstanceId` is prohibited inside remote wire assertions except as local diagnostic metadata. Remote bindings exclusively reference `agent_<32-hex>` or `peer_<32-hex>`.
2. **Handle / Display Name Collisions**: In serverless mode, when an owner imports a peer invitation whose `displayName` or `profileName` matches an existing local or paired agent, the registry records both principals under their distinct `peer_<32-hex>` IDs and marks `display_collision: true` (proposed). The CLI and `status`/`doctor` require disambiguation via the principal ID or an owner-assigned local petname (`petname`, proposed).
3. **Conflicting Active Bindings**: Within one local registry (`<TRIANGLE_HOME>/identity/identity-registry-v1.json`, proposed), one `profileInstanceId` binds to exactly **one** active principal in exactly one trust mode (an agent that must exist in both modes is two profiles and two principals, chosen deliberately by the owner). Attempting to bind a profile already bound to `<principal-id-1>` to `<principal-id-2>` without an explicit `triangle identity unbind` (proposed) fails immediately with `ERR_BINDING_CONFLICT` (proposed).
4. **Cross-Mode Isolation**: A profile bound to a `peer_<32-hex>` principal cannot be implicitly merged into an `agent_<32-hex>` principal. If an owner enrolls an existing local profile into MESH, the profile must either switch its active mode explicitly via an owner-confirmed command or maintain separate profiles; historical serverless pairings remain bound only to `peer_<32-hex>`.
5. **Aliases**: Handles, petnames, profile names and display names only name a principal inside the sender's own registry. An alias that resolves to zero or to more than one principal fails with `ERR_ALIAS_UNRESOLVED` (proposed) and is never forwarded across a transport as an address; only principal ids cross transports. This is how unauthorized aliases fail explicitly (Gate 1).
6. **Unbound sessions stay local-only**: Today any discovered Claude or Codex chat is addressable as `session-<64-hex>` and is bound only by the owner's local sender lists. Such a session is not a principal and has no binding until the owner creates one (`local_session_binding_v1`). It keeps working locally exactly as it does now, with provenance `local-attested` and `principal: null`, and it can never originate a cross-transport message or appear as a principal in provenance.
7. **Same id, different key**: A presented serverless id whose public key differs from the key pinned for that id fails with `ERR_BINDING_CONFLICT`. The owner can resolve it only through an approved rotation (Section 6) or by removing the pairing; the id alone never proves the key.

---

## 4. Trust Modes and Bindings

The Triangle operates in two strictly separated trust modes: **MESH-Managed Mode** and **Serverless Peer Mode**. Every message route relies on explicit binding records.

### Mode Separation Invariants

- Serverless peer mode requires **zero** network connectivity to or configuration of a MESH server.
- A MESH-managed principal (`agent_<32-hex>`) is never accepted via a serverless owner-pairing assertion, and a serverless principal (`peer_<32-hex>`) is never accepted on a MESH-managed route. Either attempt fails with `ERR_MODE_MISMATCH` (proposed).
- No background process, fallback router, or migration script may enroll a `peer_<32-hex>` principal into MESH, copy messages between modes, or downgrade a failed MESH-managed delivery to an unauthenticated or serverless lane.

### Architectural Decisions: Managed Assertion, Endpoint Topology and Key Custody

The research notes left the first two choices open. The review corrected the first draft where the repository disagreed with it.

**What the code shows today.**
(a) A remote Iroh sender is only an endpoint id: `packages/agent-worker/src/peer-lane.mjs` attributes inbound messages to `fromEndpointId`, and the wire `PeerMessage` carries `message_id`, `payload_hash`, `payload`, `sender_endpoint_id` and `created_at_unix_ms` over ALPN `triangle-peer/1`, with no principal field.
(b) Each `peerWakes` entry has its own `stateRoot` and duplicates are rejected (`validatePeerWakes`), so each profile has its own state root and, per the engine README, its own `identity/device.key`; admission is the per-profile `allowedPeers` list. `peerWakes` is still behind an experimental gate.
(c) `mesh_peer_` tickets are issued by `POST /api/v1/peer-tokens` to the sending agent's workload credential and are used by the A2A gateway's outbound path (`packages/a2a-gateway/src/outbound-a2a.mjs`). Using one on an Iroh lane would be a new use, not an existing mechanism.

**Managed Iroh binding (owner Decision 2).** Use online resolution, cached: the agent registers its Iroh endpoint with MESH, with proof that it holds the endpoint key, and a receiver asks MESH to resolve an endpoint to an agent and caches the answer for the freshness window (Section 4.3). *Reasons:* it matches how MESH already establishes cross-party facts (opaque tickets checked online, mailbox origin as server-recorded attribution); MESH applies the same live `dm.send`, `dm.receive` and agent-state predicates it applies to peer tickets; it needs no new signing, no issuer-key pinning and no JWT verification in the client; and a signed delegation would still need an online epoch check for freshness, so it would add little offline benefit (first contact needs MESH either way). *Cost:* the answer is not a portable or third-party-verifiable proof and does not extend to federation (Phase 6, prohibited today); the receiver depends on MESH within the grace window; and MESH learns each first contact between endpoints. Tickets stay what they are today, the A2A assertion.

**Endpoint topology and where proof is checked (owner Decision 3).** Baseline (Slice 3a): one endpoint serves exactly one principal. The receiving supervisor maps the engine-authenticated `fromEndpointId` to the principal bound to that endpoint (pairing or delegation) and derives provenance from that binding; a principal claimed in a message is never trusted. The MESH registry and the pairing store each enforce "one principal per endpoint key at a time", and supervisor configuration keeps today's "one `stateRoot` per profile" rule. This needs no wire change and no Rust change. Extension (Slice 3b): when the owner wants one peer-engine to serve several principals, or wants a stolen device key to be insufficient, a new ALPN `triangle-peer/2` (proposed) carries a per-agent signature (`sender_sig`) on each message. A strict lane offers only `/2`, so `/1` fails at the handshake and cannot be used to downgrade. Verification stays in the supervisor; the Rust engine remains a transport that supplies the authenticated endpoint id and enforces the device roster.

**Key custody (owner Decision 6).** Principal signing keys used for `sender_sig` are held by the supervisor and never handed to a harness session: a session asks the supervisor to sign over the authenticated local socket, and the supervisor signs only as the principal bound to that session. The existing MESH `workload-key.json` is an Ed25519 key kept in the custody home (`triangle agent add` stores it on the device; `cnf.jkt` is its RFC 7638 thumbprint) and is readable by any process of the same OS user (decision F1). Reusing it to sign Iroh messages does not worsen that exposure but cannot fix it. A dedicated message-signing key held only by the supervisor and registered with the endpoint at MESH (`message_public_key`, proposed) limits the blast radius and decouples rotation; making it unreadable to sibling processes needs Keychain-style custody or a separate OS account. The first is blocked by the current policy (`packages/macos-mailbox-helper/KEYCHAIN_POLICY.md`, 2026-10-18: agent identities never live in the Keychain; ad-hoc builds cannot carry Keychain entitlements; Developer ID is out of scope). For managed mode the supervisor already receives the workload key seed at bootstrap (same document), so supervisor-held signing needs no new key distribution there. Gate 2 is therefore claimed at Tier R (owner Decision 6, Option A; Section 10).

---

### Binding Records: Schemas, Signers, Lifetimes, and Verification

We define four explicit binding and attestation types (all proposed):

#### 4.1 Local Profile-to-Principal Binding (`local_profile_binding_v1`, proposed)

Links a local `profileInstanceId` on a host to its authoritative principal (`agent_<32-hex>` or `peer_<32-hex>`). Stored at `<TRIANGLE_HOME>/identity/bindings/<profile-instance-id>.json` (proposed, builds on `profiles-v1/profile-<hex>.json`).

- **Fields**:
  - `schema`: `"local_profile_binding_v1"`
  - `binding_id`: `"bind_<32-hex>"`
  - `trust_mode`: `"mesh-managed"` | `"serverless-peer"`
  - `principal_id`: `"<principal-id>"` (`agent_<32-hex>` or `peer_<32-hex>`)
  - `profile_name`: `"<profile-name>"`
  - `profile_instance_id`: `"<64-hex>"`
  - `installation_id`: `"<installation-id>"`
  - `principal_public_key`: `"<base64url-ed25519-pubkey>"` (for `serverless-peer`, from `principal-key.json`; for `mesh-managed`, workload public key from `workload-key.json`)
  - `binding_generation`: integer $\ge 1$, monotonically increasing per `profile_instance_id`
  - `issued_at`: ISO-8601 UTC timestamp
  - `expires_at`: ISO-8601 UTC timestamp or `null` (local owner bindings do not expire unless rotated/revoked; MESH bindings refresh with workload key rotation)
  - `proof`:
    - In `mesh-managed` mode: `{ "kind": "mesh_dpop_bind_proof", "agent_json_sha256": "<64-hex>", "verified_me_at": "<iso-8601>", "principal_sig": "<base64url-ed25519-sig>" }` where `principal_sig` signs the canonical JSON of the fields above using `workload-key.json` after a live DPoP `GET /api/v1/agents/me`.
    - In `serverless-peer` mode: `{ "kind": "local_principal_self_sig", "principal_sig": "<base64url-ed25519-sig>" }` signed by `principal-key.json`.
- **Issuer / Approver**: Local owner via CLI (the existing `triangle agent add` plus `triangle-mailbox bind --profile NAME --key-file ...`, or `triangle identity init`, proposed); signed by the principal’s local private key (`workload-key.json` or `principal-key.json`).
- **Verifier**: Local supervisor and CLI tools (`status`, `doctor`, local router).
- **Verification Steps (in order)**:
  1. Parse JSON and verify `schema == "local_profile_binding_v1"`.
  2. Recompute `SHA-256("triangle-client-instance-v1\0" + profile_name)` and verify it equals `profile_instance_id`.
  3. Check `trust_mode`: if `"mesh-managed"`, verify `principal_id` matches `^agent_[a-f0-9]{32}$` and `<TRIANGLE_HOME>/agents/<principal_id>/agent.json` exists with matching SHA-256; if `"serverless-peer"`, verify `principal_id` matches `^peer_[a-f0-9]{32}$` and that `principal_public_key` equals the key the registry holds for this id (the id is opaque, so there is nothing to recompute; the key changes only through an approved rotation).
  4. Verify `proof.principal_sig` over the canonical payload using `principal_public_key`.
  5. Verify `binding_generation` equals the highest known generation in `identity-registry-v1.json` for `profile_instance_id` and is not marked revoked.
  6. **On failure**: Reject binding with `ERR_INVALID_PROFILE_BINDING` (proposed); block the profile from sending or receiving messages and surface the conflict in `triangle doctor`.

#### 4.2 Local Session Binding (`local_session_binding_v1`, proposed)

Binds an active harness session (`session-<64-hex>`) to a bound profile and its principal. Embedded in the supervisor’s session table and reflected in the local HMAC turn credential claims.

- **Fields**:
  - `schema`: `"local_session_binding_v1"`
  - `binding_id`: `"bind_<32-hex>"`
  - `principal_id`: `"<principal-id>"`
  - `profile_instance_id`: `"<64-hex>"`
  - `session_id`: `"session-<64-hex>"`
  - `sender_type`: `"claude"` | `"codex"` | `"grok"` | `"worker"`
  - `binding_generation`: integer $\ge 1$ (incremented on every session re-bind or credential rotation)
  - `allowed_recipients`: array of `"<principal-id>"`
  - `issued_at`: unix epoch seconds
  - `exp`: unix epoch seconds (TTL 300 seconds, the existing turn credential `ttlMs: 300000`; sessions renew)
  - `hmac_tag`: `"<hex-hmac-sha256>"` (supervisor-held secret)
- **Relation to today's credential**: The local turn credential already carries `senderId` (the 64-hex instance id), `senderType`, `sessionId`, `generation`, `bindingId`, `allowedRecipients` and a TTL. The new `principal_id` and `profile_instance_id` are added next to them, `binding_generation` maps to the existing `generation`, `binding_id` to `bindingId`, and `allowed_recipients` keeps accepting 64-hex ids and `session-` addresses (Section 8).
- **Issuer / Approver**: Local supervisor process upon authenticating the local harness attachment and verifying a valid `local_profile_binding_v1`.
- **Verifier**: Local supervisor upon receiving any frame on the local Unix domain socket.
- **Verification Steps (in order)**:
  1. Recompute `HMAC-SHA256` using the supervisor’s in-memory secret over the canonical claim bytes; constant-time compare with `hmac_tag`.
  2. Check current host clock `now < exp` and `now >= issued_at - 5`.
  3. Lookup `session_id` in the active supervisor session table; verify `principal_id`, `profile_instance_id`, and `binding_generation` match the active entry exactly.
  4. Verify the active `local_profile_binding_v1` for `profile_instance_id` is still valid and maps to `principal_id`.
  5. Verify the target recipient principal is in `allowed_recipients`.
  6. **On failure**: Drop the local socket frame immediately, return `ERR_LOCAL_SESSION_UNAUTHORIZED` (proposed) to the caller, and increment the local audit counter.

#### 4.3 MESH-Managed Endpoint Registration and Resolution (proposed; owner Decision 2)

In MESH-managed mode a receiver learns which MESH principal owns an Iroh endpoint by asking MESH, not from a signed certificate. This matches how MESH already works: peer tickets are opaque and checked online, and mailbox origin is server-recorded attribution. Both calls below need a MESH server change (Slice 4).

**Registration** (`POST /api/v1/agents/me/peer-endpoints`, proposed), made by the agent with its workload JWT and DPoP:

- **Fields**: `endpoint_id` (the 64-hex Iroh endpoint id), `challenge_id`, and `endpoint_sig`, an Ed25519 signature by the endpoint's own key over `"triangle-endpoint-reg-v1\0" + agent_id + "\0" + endpoint_id + "\0" + challenge_nonce`. The nonce comes from a single-use challenge (`POST /api/v1/agents/me/peer-endpoints/challenges`, proposed) valid for 60 seconds, the DPoP proof window.
- **Proof of possession is mandatory.** Without it an agent could register another agent's endpoint id, blocking its owner or having that endpoint's traffic attributed to itself. The peer-engine has no signing call today (checked 2026-10-25), so Slice 5 adds one (a new IPC command) or lets the CLI sign with the `device.key` file; that choice is made in Slice 5.
- **Rules**: an endpoint id belongs to at most one agent at a time (a second registration fails with `ERR_BINDING_CONFLICT`); registering the same endpoint for the same agent again is idempotent; an agent may hold a small number of endpoints (proposed cap 8). Removal is `DELETE /api/v1/agents/me/peer-endpoints/{endpoint_id}`, a controller action, or implicit when the agent is paused or deleted. Every change to an agent's endpoint set increments its `binding_generation`, a per-agent counter kept by MESH.
- **Authority**: registration is the agent's own act, recorded by MESH. The endpoint key proves control of the endpoint and the workload credential proves the agent; neither authority is inferred from the other (ADR 0001).

**Resolution** (`POST /api/v1/peer-endpoints/resolve`, proposed), made by the receiving agent R with its own workload JWT and DPoP:

- **Request**: `{ "endpoint_id": "<64-hex>" }`.
- **Live checks, in one statement**, with the same predicates as peer-ticket issuance in `peer-auth.ts`: the endpoint is registered to agent S; S is active and has `dm.send`; R is active and has `dm.receive`.
- **Response on success**: `{ "sender_agent_id": "agent_<32-hex>", "binding_generation": <int>, "dm_send_epoch": <int>, "dm_receive_epoch": <int>, "valid_for_seconds": 300, "message_public_key": "<optional, Slice 3b>" }`. The answer is relative (`valid_for_seconds`, default from owner Decision 7, which MESH may shorten) so clock skew between the Mac and the server does not matter. Any other outcome is a uniform `404 not_resolvable` that does not reveal whether the endpoint exists or why it failed; R's own permission failure may be reported to R, as ticket issuance reports the actor's own state. The call is authenticated and rate-limited (proposed).
- **Addressing** (needed by item 6, not by baseline replies): `GET /api/v1/agents/{agent_id}/peer-endpoints` (proposed) returns the endpoint ids registered for an agent under the same live permission checks; a sender needs it to dial an agent it has not heard from.

- **Verification steps on the receiver (in order)**:
  1. The receiving profile is in `mesh-managed` mode and the resolve goes to the MESH origin pinned for that profile.
  2. The engine supplies the TLS-authenticated endpoint id (`fromEndpointId`); `sender_mismatch` has already been checked by the engine.
  3. Look up the cached resolution for that endpoint. If it exists and is younger than `valid_for_seconds` (monotonic clock), use it; otherwise call resolve.
  4. On success, set `principal` to `sender_agent_id`, record `binding_generation`, and cache the answer with the time of the last successful resolve.
  5. If MESH is unreachable, accept from the cache only while the time since the last successful resolve is at most 15 minutes (offline grace, owner Decision 7), marking provenance `freshness: "offline-grace"`; after that fail closed.
  6. On `404 not_resolvable`: drop the cache entry and hold the message undelivered (`ERR_ENDPOINT_UNRESOLVED`, proposed).
  7. On `triangle-peer/2` lanes only (Slice 3b): verify `sender_sig` with the `message_public_key` MESH returned for that endpoint (by default the agent's workload key).
- **On failure** the message is not delivered to a session, and it is held rather than dropped: the engine acknowledges durable receipt (`received_peer`) at the transport level before the supervisor decides on delivery, so the supervisor keeps the message until verification succeeds (`ERR_MESH_FRESHNESS_EXPIRED` while MESH is unreachable) or an owner-visible hold limit passes. Rejecting earlier with a retryable engine code would need a Rust change and is decided in Slice 5.
- **Not a portable assertion.** The answer is the home server's word over TLS, as with mailbox attribution. It cannot be forwarded to or verified by a third party and does not extend to cross-server federation; a signed delegation would be the path if Phase 6 ever needs one.
- **Recipient scoping**: resolve evaluates the S-to-R permissions for the calling receiver, so no recipient-scoped ticket is needed. The receiver's own inbound allowlist still applies.

#### 4.4 Serverless Peer Invitation and Owner Pairing Record (`serverless_pairing_v1`, proposed)

In serverless peer mode, binds a remote `peer_<32-hex>` principal to its principal public key and authorized Iroh `<endpoint-id>`. Established via a two-sided owner-approved invitation flow (`triangle peer invite` / `triangle peer accept`, proposed) and stored in `<TRIANGLE_HOME>/identity/pairings/<remote-principal-id>.json` (proposed).

- **Fields**:
  - `schema`: `"serverless_pairing_v1"`
  - `pairing_id`: `"pair_<32-hex>"`
  - `trust_mode`: `"serverless-peer"`
  - `local_principal_id`: `"peer_<32-hex>"` (the local principal that owns this pairing)
  - `remote_principal_id`: `"peer_<32-hex>"` (the remote peer’s principal)
  - `remote_principal_public_key`: `"<base64url-ed25519-pubkey>"`
  - `remote_endpoint_ids`: array of `"<iroh-endpoint-id>"` (explicitly authorized Iroh device keys for this remote principal; usually 1, >1 only if multi-device delegation is approved)
  - `petname`: `"<owner-chosen-local-alias>"` (required to be unique per `local_principal_id`)
  - `binding_generation`: integer $\ge 1$
  - `issued_at`: ISO-8601 UTC timestamp
  - `expires_at`: ISO-8601 UTC timestamp (default `issued_at + 90 days`, or owner-specified; must be explicit)
  - `remote_invitation_sig`: `"<base64url-ed25519-sig>"` (signed by `remote_principal_public_key` over `{remote_principal_id, remote_principal_public_key, remote_endpoint_ids, binding_generation, issued_at, expires_at}`)
  - `local_owner_approval_sig`: `"<base64url-ed25519-sig>"` (signed by `local_principal_id`’s `principal-key.json` over the entire pairing record during interactive CLI owner approval)
- **Issuer / Approver**: Remote agent signs the invitation (`remote_invitation_sig`); local human owner inspects the short authentication string (SAS fingerprint of `local_principal_id || local_principal_public_key || remote_principal_id || remote_principal_public_key || remote_endpoint_ids`; because the id is opaque it does not commit to the key, so the SAS must cover both keys) and approves via CLI, causing `local_principal_id` to counter-sign (`local_owner_approval_sig`) and adding `remote_endpoint_ids` to the Iroh roster. **Approval mechanism (owner Decision 4)**: every approval (pairing, key rotation, endpoint addition) requires OS re-authentication that a session without the owner's password cannot supply. The approving command (1) refuses unless stdin and stdout are a terminal, (2) refuses when a harness session is among its process ancestors or its environment carries a harness marker (best effort, defense in depth only), (3) refuses when passwordless sudo is configured (`sudo -n -v` succeeds), because a prompt would then prove nothing, (4) clears the cached sudo ticket (`sudo -k`) and runs `sudo -v`, so the macOS account password, or Touch ID where the owner has enabled it, is entered at the OS prompt on the controlling terminal, and only then (5) shows the SAS and petname and asks for the typed confirmation. Whether a helper `LocalAuthentication` sheet replaces step 4 is settled by a feasibility check in Slice 3a (nothing in the helper uses it today, and it is ad-hoc signed). Checked on the production Mac on 2026-10-25: sudo requires a password, the account is an admin, Touch ID for sudo is off. A host with passwordless sudo, or a non-admin account, fails closed.
- **Verifier**: Receiving client’s serverless verifier on every inbound Iroh message and before every outbound reply.
- **Verification Steps (in order)**:
  1. Confirm the local receiving profile is in `serverless-peer` mode with principal `local_principal_id`.
  2. Lookup `serverless_pairing_v1` by claimed `remote_principal_id` in `<TRIANGLE_HOME>/identity/pairings/`.
  3. Verify `remote_principal_public_key` equals the key pinned for `remote_principal_id` in this pairing (the id is opaque; the pin moves only through an approved rotation, Section 6).
  4. Verify `local_owner_approval_sig` using `local_principal_id`’s public key and `remote_invitation_sig` using `remote_principal_public_key`.
  5. Verify `now < expires_at` and pairing is not marked `revoked: true` in the local registry.
  6. Verify the TLS-authenticated Iroh connection endpoint ID (`authenticated_peer_endpoint_id`) is a member of `remote_endpoint_ids` (or authorized by a chained `multi_device_delegation_v1`, Section 6).
  7. On `triangle-peer/2` lanes only: verify `sender_sig` using `remote_principal_public_key`, or, when a `device_delegation` is presented, using its `sub_device_public_key` after verifying `primary_sig` over the delegation with `remote_principal_public_key`, `now < exp`, and `sub_endpoint_id` equal to the authenticated endpoint (the sub-key's authority is limited to that endpoint). On baseline lanes the pairing's `remote_endpoint_ids` is the proof.
  8. **On failure**: Reject message with `ERR_SERVERLESS_PAIRING_INVALID` (proposed); never deliver to the agent session.

---

## 5. Sender Provenance and Reply Routing Across Transports

### How the Receiver Attributes a Message, and the Optional Per-Message Envelope (`triangle-peer/2`, proposed)

The transport authenticates only `authenticated_peer_endpoint_id` (`identity/device.key`). The engine already rejects a frame whose `sender_endpoint_id` differs from it (`sender_mismatch`) and suppresses duplicate `message_id` values for 7 days; neither says which agent on that endpoint is speaking.

**Baseline lanes (`triangle-peer/1`; Slice 3a for serverless, Slice 5 for managed; one endpoint, one principal).** No wire change and no new message type. The receiving supervisor takes the engine-authenticated `fromEndpointId` and maps it to a principal: in serverless mode from the owner-approved `serverless_pairing_v1` record that lists the endpoint (Section 4.4), in managed mode by resolving the endpoint at MESH (Section 4.3). It then attributes every message from that endpoint to that principal. A sender principal claimed inside any payload is ignored. An endpoint that maps to two principals, or to a pairing and a MESH registration at once, fails with `ERR_BINDING_CONFLICT`.

**Strict lanes (`triangle-peer/2`; Slice 3b, deferred by owner Decision 3: shared endpoints, or stolen-device-key resistance).** A new ALPN, so that a strict lane can refuse `/1` outright, carries extra fields next to the existing `message_id`, `payload_hash`, `payload`, `sender_endpoint_id` and `created_at_unix_ms` (the first draft's `payload_sha256` and `sent_at` duplicated existing fields, so the existing names are reused):

- `trust_mode`: `"mesh-managed"` | `"serverless-peer"`
- `sender_principal` and `recipient_principal`: `"<principal-id>"`; `recipient_endpoint_id`: `"<iroh-endpoint-id>"`
- `sender_binding_generation`: integer >= 1
- `auth_assertion` (serverless only): `{ "kind": "serverless_paired", "pairing_id": "pair_<32-hex>", "device_delegation": "<multi_device_delegation_v1 or null>" }`; managed lanes omit it because the receiver resolves the endpoint at MESH
- `sender_sig`: `"<base64url-ed25519-sig>"`

`request_id` and `in_reply_to` stay inside the payload, so `payload_hash` already covers them.

- **`sender_sig` input**: `"triangle-msg-v2\0" + trust_mode + "\0" + message_id + "\0" + sender_principal + "\0" + recipient_principal + "\0" + sender_endpoint_id + "\0" + recipient_endpoint_id + "\0" + sender_binding_generation + "\0" + created_at_unix_ms + "\0" + payload_hash`. Binding `recipient_endpoint_id` stops a captured message being replayed to another device of the same recipient.
- **Keys**: managed, the `message_public_key` registered with the endpoint at MESH and returned by resolve (by default the agent's workload key); serverless, `principal-key.json`.
- **Age check**: the receiver rejects a message whose `created_at_unix_ms` is older than the 7-day tombstone window or further in the future than the clock-skew allowance, because a message older than the window could otherwise be replayed once after its id was forgotten.
- **Custody**: the engine never holds a principal key. The principal's supervisor signs over the authenticated local socket and signs only as the principal bound to the calling session, so Agent B on the same engine cannot produce Agent A's `sender_sig` unless it can read the supervisor's key store (the F1 tier, Section 10).
- **Legacy lanes**: a lane still on `triangle-peer/1` that has not been paired or registered keeps working as today, device-roster only. Its messages carry provenance `legacy-device-only` (no principal) and reach only the profile that owns that engine. A strict lane offers only `/2`, so `/1` fails at the handshake.

### Receiver-Computed Typed Sender Provenance (`sender_provenance_v1`, proposed)

A receiving runtime **never** copies provenance fields from the untrusted message payload. Before delivering a message to a local harness session, the receiver strips any caller-supplied `provenance` field from the payload, executes the transport-specific verification pipeline, and constructs the immutable `sender_provenance_v1` object:

```json
{
  "schema": "sender_provenance_v1",
  "principal": "<principal-id>",
  "recipient_principal": "<principal-id>",
  "trust_mode": "mesh-managed | serverless-peer",
  "request_id": "<request-id>",
  "sender_binding_generation": 3,
  "via": {
    "transport": "local-socket | iroh-peer | mesh-mailbox",
    "authenticated_peer": "session-<64-hex> | <iroh-endpoint-id> | <mesh-home-server-url>"
  },
  "assurance": {
    "kind": "local-attested | mesh-recorded | mesh-resolved | owner-paired | legacy-device-only",
    "assertion_id": "bind_<32-hex> | pair_<32-hex> | <mesh-event-id> | resolve:<endpoint-id>",
    "revocation_epoch": 12,
    "freshness": "online-verified | cached-fresh | offline-grace",
    "verified_at": "2026-10-25T08:00:00Z",
    "expires_at": "2026-10-25T09:00:00Z"
  }
}
```

#### How the Receiver Computes Provenance per Transport

1. **Local Socket (`transport: "local-socket"`, `assurance.kind: "local-attested"`)**:
   - The local supervisor verifies the caller’s `local_session_binding_v1` HMAC token (Section 4.2 steps 1–5).
   - `principal` is set from the supervisor’s verified session table (`principal_id`), **not** from the message body. For an unbound session `principal` is `null` (Section 3, rule 6).
   - `via.authenticated_peer` is set to the verified `session-<64-hex>`.
   - Local HMAC turn credentials are consumed inside the supervisor and never forwarded off-host.
2. **MESH Mailbox (`transport: "mesh-mailbox"`, `assurance.kind: "mesh-recorded"`)**:
   - The client fetches the mailbox event from the MESH home server over TLS using its DPoP workload JWT.
   - Because MESH mailbox origin is server-recorded attribution (research fact 5), `principal` is set to the server-attested `sender_agent_id` (`agent_<32-hex>`) returned by the MESH API, verified against the local profile’s pinned MESH home server.
   - `via.authenticated_peer` is the MESH server issuer URL.
3. **Iroh Peer Lane — MESH-Managed (`transport: "iroh-peer"`, `assurance.kind: "mesh-resolved"`)**:
   - `peer-engine` verifies that the QUIC/TLS peer public key equals `sender_endpoint_id` (`sender_mismatch` check) and that `message_id` is not in the 7-day tombstone table.
   - The supervisor executes Section 4.3 verification steps 1–6 for that endpoint; on `/2` lanes it also executes step 7 (`sender_sig`).
   - `principal` is set to the `sender_agent_id` that MESH returned for the endpoint.
   - `via.authenticated_peer` is set to the TLS-authenticated `<iroh-endpoint-id>`; `assurance.freshness` is `online-verified`, `cached-fresh` or `offline-grace` according to how the resolution was obtained.
4. **Iroh Peer Lane — Serverless Peer (`transport: "iroh-peer"`, `assurance.kind: "owner-paired"`)**:
   - `peer-engine` verifies TLS endpoint identity and 7-day message tombstone uniqueness.
   - The verifier executes Section 4.4 steps 1–6 for the pairing bound to that endpoint; on `/2` lanes it also executes step 7 on `auth_assertion.pairing_id` and `sender_sig`.
   - `principal` is set to `remote_principal_id` (`peer_<32-hex>`) from the verified local `serverless_pairing_v1` record.
   - `via.authenticated_peer` is set to the TLS-authenticated `<iroh-endpoint-id>`.

5. **Iroh Peer Lane — Legacy (`transport: "iroh-peer"`, `assurance.kind: "legacy-device-only"`)**:
   - The engine's device-roster admission is the only check (today's behavior for `triangle-peer/1` lanes that are not paired).
   - `principal` is `null`; `via.authenticated_peer` is the TLS-authenticated `<iroh-endpoint-id>`. The message may be delivered only to the profile that owns that engine and is never shown as coming from a principal.

### Reply Routing and Conversation Pinning (`reply_route_table_v1`, proposed)

To satisfy Acceptance Gate 4, replies must stay strictly bound to the original authenticated principal, conversation, trust mode, and binding generation across reconnects, process restarts, and key rotations, with **no fallback** to a different active session or unauthorized endpoint.

#### Reply Route Record (`reply_route_v1`, proposed)

When a message is verified and delivered to a local session, the supervisor persists a durable route row in an additive journal table (`local_reply_routes`, proposed; the journal already stores `request_id` and `in_reply_to` for every request and reply, and earlier features added columns and tables the same way) keyed by `(remote_principal, request_id)`:

- **Fields**:
  - `request_id`: `"<request-id>"`
  - `trust_mode`: `"mesh-managed"` | `"serverless-peer"`
  - `local_principal`: `"<principal-id>"`
  - `local_session_id`: `"session-<64-hex>"` (the exact local session owning this conversation)
  - `local_binding_generation`: integer $\ge 1$
  - `remote_principal`: `"<principal-id>"`
  - `min_remote_binding_generation`: integer $\ge 1$ (set to `sender_binding_generation` of the latest verified inbound message; never decrements)
  - `permitted_transports`: `["local-socket"]` | `["iroh-peer", "mesh-mailbox"]` | `["iroh-peer"]` (constrained by `trust_mode`)
  - `pinned_remote_endpoint_id`: `"<iroh-endpoint-id>"` or `null`
  - `updated_at`: ISO-8601 UTC timestamp

Because a sender may choose its own `request_id`, the key includes `remote_principal`; two principals can never collide on a request id.

#### Outbound Reply Verification Steps (in order)

When a local session attempts to send a reply on `request_id`:

1. **Verify Local Caller Pinning**: Look up `reply_route_v1` for `request_id`. Verify the caller’s verified `principal` equals `local_principal` and its `session_id` equals `local_session_id`.
   - *Reconnect / Restart handling*: If the original harness process restarted and re-attached with the **same** deterministic `session-<64-hex>` (`SHA-256(installationId + workspace + harnessSessionId)`) and a valid `local_session_binding_v1` for `local_principal` with `binding_generation >= local_binding_generation`, update `local_binding_generation` and allow the reply.
   - *No fallback to another session*: If `local_session_id` is disconnected and a *different* session (`session-<other>`) for the same profile tries to reply on `request_id` without an explicit owner session-transfer command, **reject** with `ERR_REPLY_SESSION_MISMATCH` (proposed). Similarly, inbound replies targeting `request_id` when `local_session_id` is offline are queued for `local_session_id` (or rejected if queue TTL expires)—the supervisor **never** falls back to delivering the reply to a different active session on the host.
2. **Verify Trust Mode Invariance**: Verify the outbound transport matches `trust_mode` and `permitted_transports`. A `"serverless-peer"` conversation can never route over `"mesh-mailbox"`, and a `"mesh-managed"` conversation can never use `"owner-paired"` assertions.
3. **Re-Verify Remote Target Binding at Reply Time**:
   - In `serverless-peer` mode: Load the current `serverless_pairing_v1` for `remote_principal`. Verify it is not expired or revoked, and its `binding_generation >= min_remote_binding_generation`. Send only to an endpoint in `remote_endpoint_ids`. If the remote peer rotated its endpoint key via an approved rotation (Section 6; incrementing `binding_generation`), update `min_remote_binding_generation` and `pinned_remote_endpoint_id`. If the pinned endpoint is unreachable, **queue or fail explicitly (`ERR_REMOTE_ENDPOINT_UNREACHABLE`, proposed)**—never fall back to another unpaired endpoint on the roster. Failover to another endpoint of the same remote principal happens only if the route row lists it in `failover_endpoint_ids` (proposed, empty by default, owner-set), because a different device runs a different session and cannot continue this request.
   - In `mesh-managed` mode: Re-resolve `pinned_remote_endpoint_id` at MESH (cache within the freshness window): it must still map to `remote_principal` (`agent_<32-hex>`) with `binding_generation >= min_remote_binding_generation`; otherwise the reply is held or fails explicitly, with no fallback to another endpoint.

---

## 6. Lifecycle

### Key Rotation, Session Rotation, Revocation, Expiry, Device Loss, Re-Enrollment, and Multi-Device Delegation

1. **Key Rotation (No Silent Principal Replacement)**:
   - **MESH Workload Key Rotation**: The agent generates a new Ed25519 `workload-key.json` and registers it with MESH using its existing active workload credential (or WebAuthn controller approval per ADR 0001). The MESH principal `agent_<32-hex>` is unchanged. Endpoint registrations stay valid; if the registered `message_public_key` was the old workload key (Slice 3b), the agent re-registers it with proof of possession, which increments `binding_generation`.
   - **Serverless Principal Key Rotation**: Because the id is opaque (owner Decision 1), rotating the signing key never changes `peer_<32-hex>`; it uses a signed **Key Continuity Statement** (`serverless_key_rotation_v1`, proposed):
     - Fields: `schema`, `principal_id` (`peer_<32-hex>`), `old_public_key`, `new_public_key`, `binding_generation` (incremented), `rotated_at`, `sig_by_old_key`, `sig_by_new_key`, and an optional `next_key_digest` (reserved; unused until pre-commitment is adopted).
     - Paired peers verify both signatures but **do not advance the pinned key automatically**: a signature by the old key proves only that whoever holds it asked, and a thief of the old key could rotate first and lock the owner out. The peer marks the pairing `rotation_pending` and its owner approves it (the same OS re-authentication and SAS display as pairing, owner Decisions 4 and 5). Only then does the peer atomically advance `remote_principal_public_key` and `binding_generation` in `serverless_pairing_v1`, keeping `remote_principal_id` (`peer_<32-hex>`) identical. Pre-commitment is not adopted now (owner Decision 5, Option A); the reserved `next_key_digest` field would let each statement commit to the hash of the next key later, so that only the holder of that pre-committed key could rotate and the old key alone could not.
   - **Iroh Device Key (`identity/device.key`) Rotation**: Rotating `device.key` changes `<iroh-endpoint-id>` while keeping the principal unchanged. In MESH-managed mode, the agent registers the new endpoint at MESH with proof of possession (Section 4.3) and removes the old registration, which increments `binding_generation`. In serverless mode, the principal signs an **Endpoint Update Statement** (`serverless_endpoint_update_v1`, proposed) with its `principal-key.json` (`{principal_id, new_endpoint_ids, binding_generation, issued_at, expires_at, principal_sig}`); paired peers verify `principal_sig`, apply removals immediately, and hold additions as `pending` until the peer's owner approves them (safe direction first).
2. **Session Rotation**:
   - When a local harness restarts or rotates its turn lease, the supervisor issues a new `local_session_binding_v1` with `binding_generation = old_generation + 1` and invalidates all lower generations for that `session_id` immediately.
3. **Revocation**:
   - **MESH-Managed**: The controller or server revokes a workload key, an endpoint registration, or the `dm.send`/`dm.receive` permission, incrementing the principal’s `rev` or permission epoch on the MESH server; receivers see it at their next resolve, at most 5 minutes later.
   - **Serverless Peer**: Either the remote principal broadcasts a signed `serverless_revocation_v1` (proposed, signed by `principal-key.json`) or the local owner runs `triangle peer revoke <principal-id>` (proposed), setting `revoked: true` in `<TRIANGLE_HOME>/identity/pairings/<principal-id>.json` and removing the endpoint from the Iroh admission roster.
4. **Expiry**:
   - Every assertion or cached attestation (`local_session_binding_v1`, a MESH resolve answer with its `valid_for_seconds`, `serverless_pairing_v1`, `mesh_peer_` ticket) carries an explicit expiry. Expired assertions are rejected immediately after the mode’s documented clock-skew/grace window (see table below).
5. **Device Loss and Re-Enrollment**:
   - **MESH-Managed**: If a laptop is lost, the human controller uses WebAuthn on the MESH server to revoke the lost device’s `workload_id` and increment `rev`. On a replacement host, the controller re-binds the existing `agent_<32-hex>` principal using delayed WebAuthn dual-control recovery (ADR 0001), generating a new `workload-key.json` and `device.key` without creating a new `agent_<32-hex>`. The lost device's endpoint registrations are removed, and the replacement registers its new endpoint with proof of possession.
   - **Serverless Peer**: If a host is lost and the owner has an encrypted backup of `principal-key.json`, they restore `principal-key.json` on the new host, increment `binding_generation`, and distribute a signed `serverless_endpoint_update_v1` that revokes the lost `<iroh-endpoint-id>` (applied at once) and adds the new one (held until each peer's owner approves it). If `principal-key.json` is permanently lost without backup, continuity is impossible (the id is only a label for the lost key): the owner must revoke the old `peer_<32-hex>` pairing on all peers and explicitly pair a new `peer_<32-hex>` principal (never silently replacing it by profile name).
6. **Multi-Device Delegation**:
   - **MESH-Managed**: One `agent_<32-hex>` principal may be authorized on two hosts by enrolling a distinct `workload_id` and `device.key` per host; each host's endpoint is registered separately at MESH (Section 4.3, capped per agent). Conversation reply routes (`reply_route_v1`) still pin `pinned_remote_endpoint_id` per conversation; moving to another endpoint of the same agent happens only through the route's `failover_endpoint_ids` (Section 5).
   - **Serverless Peer**: A principal’s primary key (`principal-key.json`) may authorize a secondary host’s Iroh endpoint and sub-key via a signed `multi_device_delegation_v1` (proposed): `{schema, principal_id, primary_public_key, sub_device_public_key, sub_endpoint_id, binding_generation, issued_at, expires_at, primary_sig}` (max lifetime 7 days), or by listing multiple `remote_endpoint_ids` in the owner-approved `serverless_pairing_v1`.

### Offline Validity Window and Revocation Freshness Policy

| Trust Mode & Transport | Assertion Type | Default Assertion Lifetime (`exp`) | Revocation-Freshness Rule | Offline-Validity Window (When Authority Is Unreachable) | Receiver Action When Freshness Cannot Be Checked |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Local Socket** (Both modes) | `local_session_binding_v1` (Supervisor HMAC) | 300 s (the existing turn credential TTL, `ttlMs: 300000`); sessions renew | Checked synchronously in local supervisor memory on every frame (`binding_generation` + active table). | **Full offline validity** (supervisor is on the same host; zero network dependency). | If the local supervisor socket or registry is unreadable, **fail closed** (`ERR_LOCAL_SUPERVISOR_UNAVAILABLE`, proposed). |
| **MESH-Managed** (MESH Mailbox) | Workload JWT + DPoP (`workload-token.ts`) | 300 s (`IDENTITY_V1_DEFAULTS.tokenLifetimeSeconds`) | Checked synchronously by the MESH server against `rev` epoch on every API request. | **0 seconds** (requires live MESH server connection). | MESH server is the transport itself; unreachable server causes transport delivery deferral/retry. |
| **MESH-Managed** (A2A path via Peer Ticket) | `mesh_peer_` ticket (`peer-auth.ts`) | $\le 300\text{ seconds}$ | MESH checks the ticket and the live `dm.send` / `dm.receive` epochs at every use. | **0 seconds** (the ticket is opaque and needs a MESH lookup). | Not used on Iroh lanes; an A2A call with an unverifiable ticket is refused. |
| **MESH-Managed** (Iroh Peer Lane via online resolve) | MESH resolve answer (`valid_for_seconds`, Section 4.3) | 300 s freshness window (owner Decision 7) | The receiver re-resolves when the answer is older than the window (lazily on the next message, proactively for active lanes); MESH applies the live `dm.send`, `dm.receive` and agent-state checks on every resolve. | **15 minutes** after the last successful resolve (`freshness: "offline-grace"`), then none. | Once more than 15 minutes have passed since the last successful resolve, **fail closed** (`ERR_MESH_FRESHNESS_EXPIRED`, proposed): hold messages from MESH principals undelivered until a resolve succeeds. |
| **Serverless Peer** (Iroh Peer Lane) | `serverless_pairing_v1` + per-message `sender_sig` | 365 days by default (the owner may shorten it; renewal needs approval, owner Decision 7) | Checked synchronously against local `<TRIANGLE_HOME>/identity/pairings/` deny-list and monotonic `binding_generation`. | **Full offline validity until `expires_at`** (zero MESH or third-party server dependency). | Local disk is the authority. If `now >= expires_at`, `revoked == true`, or `binding_generation < min_remote_binding_generation`, **fail closed** (`ERR_SERVERLESS_PAIRING_EXPIRED`, proposed). |

Clock handling (review addition): elapsed time since the last successful MESH check is measured on a monotonic clock that keeps counting across sleep, and freshness is treated as unknown after a supervisor restart or a wall-clock jump, so setting the clock back cannot extend the grace window. After a hardware sleep or wake the receiver refreshes the epochs before accepting managed Iroh frames again; until then it fails closed. MESH answers carry a relative `valid_for_seconds`, so skew between the Mac and the server does not affect them.

---

## 7. Threat Table

| Threat | Attack Scenario | Concrete Mitigation in This Design | Residual Risk |
| :--- | :--- | :--- | :--- |
| **1. Impersonation of a second agent on a shared endpoint** | Profiles `alpha` and `beta` share one Iroh `peer-engine` (`device.key`). `beta` sends a frame claiming to be `alpha`. | Baseline: an endpoint is bound to exactly one principal, the receiver derives the principal from that binding and ignores any claimed sender, and sharing is refused by supervisor configuration (one `stateRoot` per profile), by the MESH registry (one agent per endpoint id) and by the pairing store. Shared endpoints (Slice 3b) require `sender_sig` from a supervisor-held key, signed only as the principal bound to the calling session. `device.key` alone never authenticates a principal. | Same-OS-user processes that can read key files or reach the engine's IPC socket (decision F1) can still act as that endpoint; supervisor-held signing only helps once keys are not readable by sibling processes (Keychain-style custody, hardening beyond this design). |
| **2. Replay of an assertion or signed message** | An attacker captures a valid `triangle-peer/2` message and replays it to another endpoint or re-injects it. | On `/2` lanes `sender_sig` covers `message_id`, both endpoint ids, `recipient_principal`, `created_at_unix_ms` and `payload_hash`; the engine's 7-day `message_id` tombstones suppress duplicates and messages older than that window are rejected by age. On baseline lanes there is no portable assertion to replay: attribution comes from the authenticated endpoint plus a live registry or MESH answer. | If a receiver's tombstone store is wiped, messages younger than 7 days can be replayed once to that receiver. This is the existing engine property and is not worsened here. |
| **3. Stale or revoked binding / session generation** | A revoked session or deauthorized device continues messaging using a cached MESH answer or an old session binding. | Local socket frames check `binding_generation` in memory on every turn. MESH-resolved bindings are re-resolved every 5 minutes and, if MESH is unreachable, honored for at most 15 minutes after the last successful resolve. Serverless pairings enforce monotonic `min_remote_binding_generation` and local revocation list checks. | In MESH-managed Iroh mode, if the receiver cannot reach MESH, a newly revoked binding stays accepted for up to 15 minutes after the last successful resolve. |
| **4. Confused deputy across sessions or conversations** | Agent A tricks the local router or a remote peer into delivering a reply meant for Session 1 to Session 2, or forwarding a local HMAC token remotely. | Receiver computes `sender_provenance_v1` from transport/crypto verification and strips payload provenance. Local HMAC tokens never leave the local socket. `reply_route_v1` pins `request_id` to `(local_principal, local_session_id, remote_principal, min_remote_binding_generation)` with zero fallback to other sessions. | If the legitimate `local_session_id` harness process itself is compromised by prompt injection, it acts with its own authorized `local_principal` privileges within `allowed_recipients`. |
| **5. Equal-name collision across devices** | Two Macs both have a profile named `gravity2` (producing identical 64-hex `profileInstanceId`). Host 2 tries to impersonate Host 1’s `gravity2`. | `profileInstanceId` is never accepted as a remote principal. Remote messages must authenticate as `agent_<32-hex>` or `peer_<32-hex>`. Serverless pairings verify `remote_principal_public_key` and require unique local `petname` aliases on display collisions. | Human owner could visually misread a CLI prompt if they ignore the SAS fingerprint and `peer_<32-hex>` ID during `triangle peer accept`. |
| **6. Device-key (`identity/device.key`) theft** | An attacker copies `identity/device.key` from a host backup and connects to peers over Iroh. | On `/2` lanes the thief also needs the principal's signing key to produce `sender_sig`, so the stolen device key alone is not enough. On baseline lanes the endpoint key is the proof, so a stolen `device.key` acts as the bound principal until the endpoint is revoked or rotated (managed: the agent or controller removes the endpoint registration, which receivers see at their next resolve within 5 minutes; serverless: the owner removes the endpoint from the pairing). Rotating `device.key` changes the endpoint id and needs a new registration with proof of possession (managed) or an approved endpoint addition (serverless). | Baseline lanes accept that window; it is the reason Slice 3b exists. If the whole state directory including `principal-key.json` or `workload-key.json` is stolen, the thief can sign as the agent until the key is revoked. |
| **7. Cross-mode downgrade** | An attacker or misconfiguration causes a `mesh-managed` agent (`agent_<32-hex>`) to accept a `serverless-peer` pairing assertion, bypassing MESH revocation epochs. | `local_profile_binding_v1`, the `triangle-peer/2` envelope, and `reply_route_v1` enforce strict `trust_mode` partitioning (`agent_` prefixes rejected in `serverless-peer` verifier; `local_` prefixes rejected in `mesh-managed` verifier). No automatic fallback or mode conversion exists. | None at the protocol level; requires deliberate owner CLI unbind and re-initialization to change a profile’s trust mode. |
| **8. Rolled-back local identity registry** | A disk snapshot restoration or local attacker rolls `<TRIANGLE_HOME>/identity/identity-registry-v1.json` back to an older version to resurrect a revoked pairing or stale `binding_generation`. | Registry writes increment a monotonic `registry_sequence` (proposed) anchored in an append-only hash chain (`registry-audit.log`, proposed) and signed by a host installation key; remote peers also enforce `min_remote_binding_generation` and reject messages whose `sender_binding_generation` regresses. | If a local attacker has full root/user write access to both the registry file and the local audit log/key on an offline machine, purely local state rollback cannot be prevented without hardware TPM/Secure Enclave sealing. |
| **9. Principal-key theft followed by rotation takeover** | A thief of `principal-key.json` signs a `serverless_key_rotation_v1` to a key it controls before the owner notices, so paired peers pin the thief's key. | Rotation statements never advance a pinned key on their own: the peer's owner approves each rotation (OS re-authentication, SAS shown); pre-commitment through the reserved `next_key_digest` is not adopted now. Endpoint additions are held pending in the same way; removals and revocations apply immediately. | Until the owner revokes the old pairing on every peer, a thief who holds the key can still sign messages as the principal. Revocation is a per-peer owner action. |
| **10. Prompt-injected agent approves a pairing** | A harness session runs the pairing, rotation or endpoint-addition approval command (for example through a pseudo-terminal) and admits an attacker endpoint. | Approval requires OS re-authentication (owner Decision 4): the macOS account password, or Touch ID where the owner enabled it, at the OS prompt on the controlling terminal, after TTY, harness-ancestry and passwordless-sudo refusals. No MCP tool or local-socket call can approve, and an agent without the password cannot pass the prompt. | An injected agent can still ask the owner to type the password into the agent's own terminal; the prompt says to enter it only in the owner's own terminal. The ancestry check is best-effort. A host with passwordless sudo or a non-admin account fails closed. |
| **11. Downgrade to a legacy lane** | An attacker or a stale configuration makes a strict lane fall back to `triangle-peer/1` or to device-roster-only admission. | A strict lane offers only ALPN `/2`, so `/1` fails at the handshake. A legacy lane's messages carry `legacy-device-only` provenance with no principal and reach only the profile that owns that engine. Moving a lane from strict back to legacy is an explicit owner action, recorded and shown in `status`/`doctor`. | A lane the owner leaves on legacy keeps today's device-level trust, labelled as such. |
| **12. Endpoint squatting at MESH** | An agent registers another agent's Iroh endpoint id to block its owner or to have that endpoint's traffic attributed to itself. | Registration needs a signature by the endpoint's own key over a single-use server nonce, the agent id and the endpoint id, plus the agent's workload DPoP; an endpoint id belongs to one agent at a time; the per-agent cap is small. | An attacker who holds the endpoint key can register it, which is the same as stealing the device key (row 6). |
| **13. Resolve as an enumeration or presence oracle** | A MESH-enrolled agent probes endpoint ids to learn which agents exist or are reachable. | Resolve answers only for a caller with a live `dm.receive`, and only when the registered agent has a live `dm.send`; every other case returns the same `404 not_resolvable`; calls are authenticated and rate-limited. | Agents that may message each other learn each other's endpoint ids, by design. |

---

## 8. Migration

Migration transitions existing installations (`profiles-v1/profile-<hex>.json`, `<TRIANGLE_HOME>/agents/<agent_id>/`, local supervisor `registry_state`, and Iroh `peer-engine` rosters) to the explicit identity model without breaking active workflows or merging identities by name.

### Step 1: Read-Only Inventory (`triangle identity inventory`, proposed)

Before writing any binding files, the migration tooling performs a strictly read-only scan of `<TRIANGLE_HOME>` and outputs an inventory report (`inventory-report-v1.json`, proposed):

1. Scans `scripts/triangle-client-service.sh` `registry_state` and supervisor `peerWakes` to list every local `profileName`, its 64-hex `profileInstanceId`, active `session-<64-hex>` addresses, and associated `peer-engine` state root (`identity/device.key` public key).
2. Scans `profiles-v1/profile-<hex>.json` and `<TRIANGLE_HOME>/agents/<agent_id>/agent.json` to identify profiles already bound to a MESH principal (`agent_<32-hex>`).
3. Scans static Iroh `--allow-peer`/`--roster` configurations and every `peerWakes[].allowedPeers` list to flag unattributed endpoint keys (`status: "unmapped_endpoint"`).
4. Flags any profile names or handles that collide across local config files or known peer rosters (`status: "collision_requires_owner_mapping"`).

### Step 2: Owner-Confirmed Mapping (`triangle identity migrate --confirm`, proposed)

No identity binding is created or merged silently:

1. **Existing MESH-Bound Profiles**: If `profiles-v1/profile-<hex>.json` already points to a valid `<TRIANGLE_HOME>/agents/<agent_id>/agent.json`, the migration proposes a `mesh-managed` `local_profile_binding_v1` preserving the exact `agent_<32-hex>` and existing `profileInstanceId`.
2. **Existing Local-Only / Serverless Profiles**: For profiles without a MESH binding, the tool proposes generating a new random `peer_<32-hex>` id and an Ed25519 key pair (`principal-key.json`) and binding it to the existing `profileInstanceId` in `serverless-peer` mode, **preserving** the 64-hex `profileInstanceId` and active `session-<64-hex>` addresses for local compatibility.
3. **Static Iroh Roster Entries**: Existing static `--roster` endpoint IDs are **not** automatically trusted as principals. The owner must complete an explicit `serverless_pairing_v1` approval (serverless) or have the agent register the endpoint at MESH (managed) for each remote peer before unified remote routing admits traffic from that endpoint.
4. **Strict Prohibition on Name-Based Merge**: Even if local profile `<profile-name>` has the same string name as a MESH agent `handle` or a remote peer’s profile name, the migration tool never merges them automatically; the owner must explicitly pass `--map-profile <profile-name> --to-principal <principal-id>` and prove key possession.

### Step 3: Preservation of Existing Identifiers

- `agent_<32-hex>`, `profile-<64-hex>.json`, 64-hex `profileInstanceId`, `session-<64-hex>`, and `identity/device.key` paths and values remain completely unchanged on disk.
- Restarting the supervisor or rotating `workload-key.json` / `device.key` updates `binding_generation` inside `<TRIANGLE_HOME>/identity/bindings/<profile-instance-id>.json` and **never** calls agent enrollment or mints a duplicate `agent_<32-hex>` or `peer_<32-hex>`.

### Step 3b: Existing Keys, Policies and Lanes Keep Working

- The 64-hex instance id remains the local alias of a principal. Sender lists, recipient lists and the Claude and Codex `allowedSenders` entries in the session policy (exact 64-hex ids or `session-` addresses) are not rewritten: the registry resolves them to principals when it is present, and they behave as today when it is not. The journal keeps its sender and recipient columns; any principal column is additive and nullable, as earlier columns were.
- Existing `peerWakes` lanes stay on `triangle-peer/1` with device-roster admission and provenance `legacy-device-only` until the owner pairs or delegates each endpoint. Moving a lane to strict is an explicit per-lane owner action; nothing flips on upgrade.

### Step 4: Rollback

- All new identity records reside under the additive directory `<TRIANGLE_HOME>/identity/` (`identity-registry-v1.json`, `bindings/`, `pairings/`, `routes/`).
- Setting `TRIANGLE_IDENTITY_RECONCILIATION=off` (proposed) or rolling back the binary causes the client to ignore `<TRIANGLE_HOME>/identity/` and fall back cleanly to the pre-migration local-only `profiles-v1` and static `--roster` behavior, while keeping unified cross-transport routing disabled. Rolling a lane back from strict to legacy is a security downgrade for that lane: it is an explicit owner action, recorded in the registry audit log and shown by `status`/`doctor`.

---

## 9. Inspectable Identity View for `status` / `doctor`

Both `triangle status` and `triangle doctor` are extended (`--identity` flag or default identity section, proposed) to render the active principals, trust modes, bindings, authorities, expiry timestamps, revocation freshness, and any detected conflicts without exposing private keys, HMAC secrets, or raw bearer tokens.

### Sketch of `triangle status --identity` and `triangle doctor` Output

Illustrative, with placeholders only. `status` and `doctor` exist today in `triangle-cli` (one command case) and `triangle-local status` prints the local messaging view; `--identity` is a proposed flag, and the local CLI would print the same section.

```text
=== TRIANGLE IDENTITY & BINDING STATUS ===
Registry: <TRIANGLE_HOME>/identity/identity-registry-v1.json (seq: 14, integrity: OK)

[1] Profile: "gravity2" (profileInstanceId: <64-hex-instance-id-1>)
    Principal      : agent_<32-hex-id-a>
    Principal Kind : mesh-managed
    Authority      : https://mesh.example.invalid (home server)
    Gen / Status   : generation 4 | ACTIVE
    Local Bindings :
      - Profile Binding : bind_<32-hex-1> (verified_me_at: 2026-10-25T06:00:00Z)
      - Active Session  : session-<64-hex-session-1> (harness: codex, gen: 4, exp: 2026-10-25T07:41:00Z)
    Remote Bindings:
      - Iroh Endpoint   : <iroh-endpoint-pubkey-1> (1 principal bound; registered at MESH, generation 3)
      - MESH Resolve    : <iroh-endpoint-pubkey-1> -> agent_<32-hex-id-a> (valid for 300 s)
    Freshness      : cached-fresh (last successful resolve: 2026-10-25T07:36:10Z; offline grace until: 2026-10-25T07:51:10Z)
    Pinned Routes  :
      - <request-id-1> -> agent_<32-hex-id-b> via iroh-peer (endpoint: <iroh-endpoint-pubkey-9>, min_gen: 2)

[2] Profile: "claude-local" (profileInstanceId: <64-hex-instance-id-2>)
    Principal      : peer_<32-hex-id-c>
    Principal Kind : serverless-peer (opaque id; current Ed25519 key pinned by pairings, pubkey: <base64url-pubkey-prefix>...)
    Authority      : local-owner (<TRIANGLE_HOME>/principals/peer_<32-hex-id-c>)
    Gen / Status   : generation 2 | ACTIVE
    Local Bindings :
      - Profile Binding : bind_<32-hex-2> (issued: 2026-10-24T12:00:00Z, expires: never)
      - Active Session  : session-<64-hex-session-2> (harness: claude, gen: 2, exp: 2026-10-25T07:41:00Z)
    Remote Bindings:
      - Iroh Endpoint   : <iroh-endpoint-pubkey-3> (1 principal bound)
      - Owner Pairings  :
        * Peer "mac-mini-claude" -> peer_<32-hex-id-d> (pair_<32-hex-9>, gen: 1)
          endpoint: <iroh-endpoint-pubkey-2> | expires: 2027-10-24T12:00:00Z (renewal due; warning from 2027-09-24) | freshness: local-authoritative (OK)

=== DOCTOR DIAGNOSTICS & CONFLICTS ===
[WARN] Legacy lane: endpoint <iroh-endpoint-pubkey-legacy> is in the static roster of profile "gravity2" with no principal binding.
       Its messages are delivered to that profile with provenance legacy-device-only (no principal).
       Action: pair it (`triangle peer accept`) or register it at MESH to attribute them, or remove it from the roster.
[ERR]  Conflict on Profile "worker-dup" (profileInstanceId: <64-hex-instance-id-3>):
       ERR_COLLISION_UNMAPPED: Remote peer peer_<32-hex-id-e> advertises display name "gravity2" matching local profile "gravity2".
       Action: Automatic merge blocked. Assign distinct petname via `triangle peer petname peer_<32-hex-id-e> <alias>`.
```

---

## 10. Verification Plan

No claim of identity reconciliation may be made until all six acceptance gates pass with both unit/protocol tests and installed-path evidence.

**Gate 2 is claimed per custody tier, and the evidence must name the tier (owner Decision 6, Option A).** Tier R is required for the gate: a remote peer, or a co-resident agent that is denied the key files, for example a sandboxed runner child. The policy confirms runner sandboxes are denied the `credentials/` tree; whether they are also denied the custody home must be confirmed before the claim is made. Tier S (an unsandboxed process of the same OS user, such as an interactive Claude or Codex chat with shell access, decision F1) is recorded as not covered; it can already read `workload-key.json` today.

| Gate | Positive Tests | Negative Tests | Required Evidence | Modes Covered | Two Physical Machines Required? | Installed-Path Run Required? |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Gate 1**: Same logical agent identifiable across permitted routes; unauthorized aliases and conflicting bindings fail explicitly. | 1. Send message from `agent_<32-hex>` over local socket, Iroh peer lane, and MESH mailbox; verify receiver computes identical `provenance.principal`.<br>2. Send message from `peer_<32-hex>` over local socket and Iroh peer lane; verify identical `provenance.principal`. | 1. Attempt to bind two principals to one `profileInstanceId` (`ERR_BINDING_CONFLICT`).<br>2. Remote peer on Machine B with identical profile name `gravity2` (same 64-hex `profileInstanceId`) attempts to message Machine A claiming local `gravity2` identity (`ERR_SERVERLESS_PAIRING_INVALID`).<br>3. Attempt to route `peer_<32-hex>` over MESH mailbox or `agent_<32-hex>` using serverless pairing (`ERR_MODE_MISMATCH`). | JSON capture of `sender_provenance_v1` across all routes; CLI exit codes and `triangle doctor` conflict output logs. | Both (`mesh-managed` and `serverless-peer`) | **Yes** (to prove two hosts with identical profile names / 64-hex `profileInstanceId` do not collide or merge over Iroh). | **Yes** (installed CLI + supervisor daemon + `peer-engine`). |
| **Gate 2**: Second agent on same endpoint cannot impersonate the first; remote sender claims require configured binding/delegation proof. | 1. (Slice 3a) Profiles A and B on Machine 1 each run their own engine; Machine 2 attributes each to its own principal (`agent_` or `local_`).<br>2. (Slice 3b) Profiles A and B share one `peer-engine` (`device.key`) and send `triangle-peer/2` messages to Machine 2; Machine 2 attributes each to its respective principal. | 1. Profile B crafts an Iroh envelope with `sender_principal = Profile A` and signs `sender_sig` with Profile B’s key (`ERR_ENDPOINT_UNRESOLVED` / `ERR_SERVERLESS_PAIRING_INVALID`).<br>2. Send an Iroh frame authenticated only by TLS `device.key` without `auth_assertion` or `sender_sig` (rejected at verifier).<br>3. Export local HMAC turn token in an Iroh payload (ignored/rejected by remote verifier).<br>4. Attempt to bind a second principal to an endpoint already bound to another (`ERR_BINDING_CONFLICT`; the MESH registry and the pairing store both refuse), and register an endpoint without a valid proof-of-possession signature (refused).<br>5. Offer `triangle-peer/1` to a strict lane (the handshake fails and no message is delivered). | Packet/envelope capture showing shared `sender_endpoint_id` with distinct registered message keys / `sender_sig`, plus rejection audit logs for cross-agent spoofing (Slice 3b); Slice 3a evidence is the refusal logs and the registry view. | Both (`mesh-managed` and `serverless-peer`) | **Yes** (Machine 1 hosting two co-resident agents sending over real Iroh relay/direct path to Machine 2). | **Yes** (installed supervisor enforcing per-profile signing isolation). |
| **Gate 3**: Stale session generations, revoked bindings, expired assertions and replaced device keys rejected per offline policy. | 1. Verify a MESH-resolved binding is accepted while MESH is reachable and, when MESH is unreachable, within 15 minutes of the last successful resolve.<br>2. Verify `serverless_pairing_v1` succeeds completely offline prior to `expires_at`. | 1. Replay a `local_session_binding_v1` token with `binding_generation = N - 1` (`ERR_LOCAL_SESSION_UNAUTHORIZED`).<br>2. Revoke the agent's `dm.send` permission or its endpoint registration; verify rejection at the next resolve (within 5 minutes) and rejection of any cached binding once offline $> 15\text{ min}$.<br>3. Revoke serverless pairing or advance `min_remote_binding_generation`; verify old pairing/device key is rejected immediately.<br>4. Replace an endpoint's `device.key`: frames from the new endpoint id are refused until a new registration with proof of possession (managed) or an approved endpoint addition (serverless) names it, and the old id is refused after revocation.<br>5. Present an old-key-signed `serverless_key_rotation_v1`: the pinned key does not advance until the peer's owner approves. | Time-travel and network-partition test transcripts showing exact pass at $T + 14\text{m}$ offline and fail-closed `ERR_MESH_FRESHNESS_EXPIRED` at $T + 16\text{m}$ offline. | Both (`mesh-managed` and `serverless-peer`) | **Yes** (to verify Iroh rejection when `device.key` is replaced or MESH endpoint is firewalled between two Macs). | **Yes** |
| **Gate 4**: Replies remain bound to original authenticated agent/conversation through reconnect, restart and rotation; no fallback to different active session. | 1. Establish `<request-id>` between Principal A (`session-1`) and Principal B. Restart Principal A’s harness and supervisor (`session-1` re-binds with `binding_generation + 1`) and rotate B’s key via signed continuity statement; verify reply succeeds and updates `min_remote_binding_generation`. | 1. Stop `session-1` while keeping `session-2` active under the same profile on the same host; send inbound reply on `<request-id>` and verify it is **not** delivered to `session-2`.<br>2. Have `session-2` attempt to send an outbound reply on `<request-id>` (`ERR_REPLY_SESSION_MISMATCH`).<br>3. Make B’s pinned Iroh endpoint unreachable while another paired endpoint exists on the roster; verify no silent fallback to a different principal’s endpoint. | Snapshots of the `local_reply_routes` rows (proposed) before and after restart/rotation, plus rejection logs when `session-2` is active. | Both (`mesh-managed` and `serverless-peer`) | **Yes** (for remote Iroh reconnect and endpoint key rotation across two hosts). | **Yes** |
| **Gate 5**: Migration preserves existing enrolled/local IDs or requires explicit owner mapping; restart and key rotation do not silently enroll duplicates. | 1. Run `triangle identity inventory` and `triangle identity migrate --confirm` on a pre-populated `<TRIANGLE_HOME>` containing `profiles-v1/profile-<hex>.json` and `agents/<agent_id>/`. Verify `agent_<32-hex>`, `profileInstanceId`, and `session-<64-hex>` are unchanged.<br>2. Restart daemon and rotate `workload-key.json` and `device.key`; verify principal count and IDs remain constant. | 1. Seed a local profile `gravity2` and a MESH agent with handle `gravity2` but no `profiles-v1` pointer; verify migration refuses automatic merge.<br>2. Trigger rollback (`TRIANGLE_IDENTITY_RECONCILIATION=off`) and verify legacy local operation resumes cleanly. | Before/after SHA-256 directory inventory of `<TRIANGLE_HOME>`, `identity-registry-v1.json` diff, and MESH server agent table query showing zero duplicate `agent_` enrollments. | Both (`mesh-managed` and `serverless-peer`) | **No** (can run on one host against local filesystem + MESH test server, though two-host roster migration is covered in Gate 6). | **Yes** (must run against installed `<TRIANGLE_HOME>` service scripts). |
| **Gate 6**: Demonstrate both MESH-managed and serverless peer operation, with distinct verification evidence and failure tests. | 1. End-to-end installed-path run in `mesh-managed` mode across two physical Macs over Iroh using MESH endpoint registration and resolve, and the MESH mailbox.<br>2. End-to-end installed-path run in `serverless-peer` mode across two physical Macs with MESH server completely unreachable/unconfigured (`serverless_pairing_v1`). | 1. Verify cross-mode isolation: attempt to bridge or downgrade a failed `mesh-managed` message onto the `serverless-peer` pairing between the same two Macs (`ERR_MODE_MISMATCH`).<br>2. Verify `triangle status` and `triangle doctor` accurately report both modes and redact all secret material. | Complete execution bundle: `triangle status --identity` and `triangle doctor` outputs from both Macs, wire captures, and pass/fail logs for both modes. | Both (`mesh-managed` and `serverless-peer`) | **Yes** (explicit two-Mac end-to-end proof required for both modes). | **Yes** (mandatory installed-path verification per contract). |

---

## 11. Implementation Slices, Rollout, Rollback, Assumptions and Risks

### Implementation Slices in Dependency Order

| Slice | Target Repository | Deliverables | Rollout | Rollback |
| :--- | :--- | :--- | :--- | :--- |
| **Slice 1a: Read-Only Inventory, Registry Schema and `status`/`doctor` View** | **Client Monorepo** (`triangle-cli`, `agent-worker` supervisor, `client-console`) | `<TRIANGLE_HOME>/identity/` schemas, `triangle identity inventory`, and the secret-free identity view. Writes nothing outside its own report. Enforces no name merge. | Default-on read-only reporting; may ship as a supervisor-runtime-only install if it adds no module reachable from the entry points (release mechanics below). | Remove the reporting or set `TRIANGLE_IDENTITY_RECONCILIATION=off`. |
| **Slice 1b: Owner-Confirmed Mapping** | **Client Monorepo** | `triangle identity migrate --confirm` writes `local_profile_binding_v1` and registry entries from the inventory, one owner-confirmed mapping at a time, preserving every existing id. | Opt-in per installation. | Delete `<TRIANGLE_HOME>/identity/` or set the flag off; `profiles-v1` is untouched. |
| **Slice 2: Local Session Generation Binding, Typed Provenance, and Reply Pinning** | **Client Monorepo** (`local-messaging-interactive-session.mjs`, supervisor router) | Upgrades local turn credentials to `local_session_binding_v1` with monotonic `binding_generation`, receiver-computed `sender_provenance_v1` (`local-attested`), and durable `reply_route_v1` pinning `(principal, session_id, request_id, generation)` with no session fallback. | Enable in local supervisor on daemon restart after Slice 1 migration is confirmed. | Toggle `TRIANGLE_STRICT_REPLY_PINNING=off` (proposed) and revert supervisor to legacy in-memory session lookup. |
| **Slice 3a: Serverless Principals, Owner Pairing and Endpoint Binding (baseline lanes)** | **Client Monorepo** (`agent-worker` supervisor and `peer-lane.mjs`, `triangle-cli`) | `peer_<32-hex>` id and key generation, `triangle peer invite`/`accept`/`revoke`, `serverless_pairing_v1`, endpoint-to-principal binding with one principal per endpoint, `serverless_key_rotation_v1` and `serverless_endpoint_update_v1` with the approval rules, OS re-authentication approval (owner Decision 4). No wire or Rust change. | Opt-in per lane; replaces unattributed `allowedPeers` entries with principal-bound ones. | Revert the lane to legacy (a recorded downgrade). |
| **Slice 3b: Per-Message Signatures on `triangle-peer/2` (deferred by owner Decision 3)** | **Client Monorepo** (`packages/peer-engine` Rust, supervisor signer and verifier) | ALPN `triangle-peer/2`, the extra envelope fields and `sender_sig`, supervisor-held signing, the age check, strict-lane refusal of `/1`. Needed only where one engine serves several principals or where a stolen device key must not suffice. | Opt-in per lane once both ends run the new engine. | Switch the lane back to `/1` (a recorded downgrade). |
| **Slice 4: MESH Peer-Endpoint Registry and Resolve API** | **MESH Server Repository** (`the-triangle` repo: `mesh/app/lib/`, `mesh/app/api/v1/`, `mesh/db/`) | A `peer_endpoints` table (endpoint id unique, owning agent, generation), registration with a single-use challenge and proof of possession (`POST /api/v1/agents/me/peer-endpoints` and `.../challenges`), removal, the resolve call (`POST /api/v1/peer-endpoints/resolve`) reusing the peer-ticket permission predicates, and the addressing lookup for item 6. Authenticated, need-to-know and rate-limited (Section 4.3). | Deploy backward-compatibly; existing workload JWTs and `mesh_peer_` tickets are untouched. | Disable the new routes with a server flag; managed Iroh lanes then stay legacy and the MESH mailbox carries managed traffic. |
| **Slice 5: Client MESH-Managed Iroh Resolution, Offline Grace and Unified Routing Cutover** | **Client Monorepo** (`workload-credential.mjs`, `packages/peer-engine`, unified router) | Endpoint-key proof-of-possession signing (a new engine IPC command or CLI-side signing), the registration and resolve clients, the resolution cache with the 5-minute window and 15-minute offline grace (owner Decision 7), hold-undelivered handling, and unified remote routing (item 6 follow-up) once all six acceptance gates pass on two physical machines. | Enable unified remote routing only when the registry has verified bindings and Gate 1 to 6 tests pass. | Set `TRIANGLE_UNIFIED_REMOTE_ROUTING=off` (proposed), restricting MESH agents to the MESH mailbox and local sockets to the local host. |

Gates by slice (review addition): 1a starts Gates 1 and 5 (conflict and inventory evidence) and 1b completes Gate 5; Slice 2 delivers Gates 3 and 4 for local routes; Slice 3a delivers Gates 1 to 4 for serverless one-endpoint lanes; Slice 3b, deferred by owner Decision 3 until shared endpoints or stolen-device-key resistance are wanted, would make the literal shared-endpoint form of Gate 2 testable (until then Gate 2 is shown by construction and by the refusal tests); Slices 4 and 5 deliver Gates 1 to 4 for managed lanes; Gate 6 closes only when both modes have run the full set on two physical Macs.

Release mechanics (project experience, not in the research notes): a new module reachable from the entry points bumps the runtime manifest and needs the Swift/helper release path. The item 3 to 5 installs avoided that and were supervisor-runtime-only installs behind a quiet gate with automatic rollback, so plan Slices 2 and 3a for the full path unless they stay inside existing modules. Slice 3b changes the Rust `peer-engine` (ALPN and envelope fields), so it needs an engine rebuild and its own wire-compatibility test (a `/2` engine against a `/1` peer).

### Assumptions

Because only the facts in Sections A and B of the prompt are verified, the following points are explicitly stated as **assumptions**:

1. **Assumption A1 (Ed25519 primitives; checked in the review)**: `packages/triangle-cli/src/keys.mjs` already implements Ed25519 signing, verification and RFC 7638 thumbprints with `node:crypto`, and `packages/peer-engine/Cargo.lock` contains `ed25519` and `ed25519-dalek` (through Iroh), so no new cryptographic dependency is expected.
2. **Assumption A2 (Clock accuracy)**: Participating hosts keep their clocks roughly correct (within 30 seconds, the MESH profile's `clockSkewSeconds`). Freshness windows use monotonic time and relative `valid_for_seconds`, so only the 7-day age check and audit timestamps depend on wall-clock accuracy.
3. **Assumption A3 (Supervisor-mediated signing, Slice 3b only)**: When several profiles run under the same OS user (fact 7, decision F1), the supervisor can act as the signing oracle for `sender_sig` on `triangle-peer/2` lanes. A same-user process can still read another profile's key file unless custody moves beyond files (Decision 6).
4. **Assumption A4 (registry location)**: `<TRIANGLE_HOME>` defaults to `~/Library/Application Support/The Triangle/v1` on macOS (`custody.mjs`), a sibling of the supervisor's own `client/` state. Whether the registry belongs in the custody home or the supervisor's state root is undecided; the supervisor must be able to read and verify it.

### Risks

1. **Same-UID File Read Risk (Decision F1)**: As noted in research fact 7, same-user processes can read the custody home `<TRIANGLE_HOME>` unless OS permissions are tightened. While `sender_sig` stops network-level endpoint impersonation and accidental cross-profile routing, full defense against a malicious local process running under the same macOS UID requires moving key custody into the macOS Keychain or a dedicated supervisor OS user. The Keychain is blocked by the current signing policy and a dedicated user needs a privileged installer (Decision 6, Options B and C); the owner accepted file custody with Tier S recorded as not covered (Decision 6, Option A, 2026-10-25).
2. **Clock Drift Causing Premature Offline Lockout**: After a hardware sleep the 15-minute offline grace window has usually elapsed, so managed Iroh messages are held until the first resolve succeeds; the monotonic-clock rule keeps a skewed wall clock from mattering.
3. **Iroh Direct-Path NAT Traversal**: As noted in research fact 9, the relay path works between the two Macs while the direct path and separate-network NAT traversal remain unresolved. Identity verification works the same over either path.
4. **Baseline window**: Until Slice 3b, a stolen `device.key` acts as the bound principal on baseline lanes (Section 7, row 6).
5. **Peer lanes are still experimental**: `peerWakes` is behind an experimental gate in the supervisor today, so Gate 6 evidence for the Iroh lanes also depends on that gate being retired or accepted.
6. **Approval host requirements**: OS re-authentication (owner Decision 4) fails closed on a host with passwordless sudo or a non-admin account; a helper sheet would be new Swift work (nothing in the helper uses `LocalAuthentication` today).
7. **MESH dependency in managed mode**: Managed Iroh lanes fail closed 15 minutes after MESH becomes unreachable and hold messages undelivered; that is the accepted cost of online resolve (owner Decision 2). Serverless lanes are unaffected.

---

## 12. Owner Decisions

The following seven design decisions are surfaced for explicit owner confirmation, along with the recommended choice used in this document and the consequences of alternatives:

**Decision log**
- 2026-10-25, Decision 3: owner chose Option A (one endpoint per principal now, per-message signatures later). Slice 3b is deferred; Gate 2 is shown by construction and by refusal tests until shared endpoints or stolen-device-key resistance are wanted.
- 2026-10-25, Decision 6: owner chose Option A (file custody, Gate 2 claimed at Tier R). Tier S is recorded as not covered. No helper or signing-policy work is required.
- 2026-10-25, Decision 1: owner chose Option A (opaque random id) with the `peer_` prefix, so ids look like `peer_<32-hex>`. This removes the genesis key and rotation-chain verification that a key-derived id would have needed; the pairing SAS therefore covers the public keys, not only the ids.
- 2026-10-25, Decision 4: owner chose Option A (OS re-authentication: the macOS account password, or Touch ID where enabled, for every pairing, rotation and endpoint addition). The mechanism (`sudo -v` or a helper sheet) is settled by a feasibility check in Slice 3a.
- 2026-10-25, Decision 5: owner chose Option A (peer-owner approval for rotations and endpoint additions; removals apply at once; `next_key_digest` is reserved and pre-commitment is not adopted).
- 2026-10-25, Decision 2: owner chose Option A (online resolve, cached). MESH gains a peer-endpoint registry with proof of possession and an authenticated resolve call (Slice 4); no signed delegation, issuer-key pinning or JWT verification is built.
- 2026-10-25, Decision 7: owner chose managed re-check every 5 minutes with 15 minutes of offline grace, and 365-day serverless pairings renewable by approval.
- All seven decisions are settled. Still pending: the owner's overall approval of the design, and the Slice 3a feasibility check of the approval mechanism.

### Decision 1: Serverless Principal Identifier Format and Prefix

**Owner decision (2026-10-25): Option A with the `peer_` prefix.**

- **Option A (Chosen)**: An opaque random id, `peer_<32-hex>` (proposed): 128 bits from a CSPRNG when the principal is created, never derived from any key. The owner-approved pairing record binds the id to the principal's current public key, as MESH binds `agent_` ids to keys by records. Rotation never changes the id, and a presented id whose key differs from the pinned one fails with `ERR_BINDING_CONFLICT`.
  - *Consequence*: no genesis key to carry and no rotation chain to verify. The id proves nothing by itself, so an unknown id is simply unpaired and refused, and the pairing SAS must cover both public keys. Collisions between honest random ids are negligible at 128 bits.
- **Option B**: An id derived from the genesis public key (hash truncated to 128 bits) with a stored `genesis_public_key` and a rotation chain.
  - *Consequence*: self-checking, but every record must carry the genesis key and verify the chain, and 128 truncated bits give about 64-bit collision resistance (acceptable only because pairings pin the full key). The first draft chose this and verified it inconsistently: step 3 of 4.1 and of 4.4 re-derived the id from the current key, which fails after the first rotation.
- **Option C**: `peer_<64-hex>` embedding the full genesis public key: twice as long, with the same genesis-key problem.
- **Option D**: Reuse the 64-hex `profileInstanceId`: violates Gates 1 and 5, because equal profile names on two machines give equal ids. Rejected.
- **Prefix**: `peer_` was chosen over `local_` (reads as host-local and clashes with "local messaging" while the id is used across hosts) and `serverless_` (43 characters). It resembles the secret `mesh_peer_` tickets, which are never displayed; the id pattern `^peer_[a-f0-9]{32}$` is distinct, as `agent_`, `workload_` and `invite_` are in the MESH id family.

### Decision 2: MESH-Managed Iroh Binding (Online Resolve, Signed Delegation or Tickets)

**Owner decision (2026-10-25): Option A.**

- **Option A (Chosen)**: Online resolve, cached. The agent registers its Iroh endpoint at MESH with proof that it holds the endpoint key (one agent per endpoint); a receiver asks MESH to resolve an endpoint and caches the answer for the freshness window (Section 4.3).
  - *Consequence*: no new signing, issuer-key pinning or JWT verification in the client, and MESH applies the same live `dm.send` and `dm.receive` checks it applies to peer tickets. The answer is the home server's word over TLS, not a portable proof; the receiver depends on MESH within the grace window; MESH learns each first contact; and it does not extend to federation (Phase 6, prohibited today).
- **Option B**: A MESH-signed endpoint delegation (the contract's candidate): an expiring agent-to-endpoint certificate verified with pinned issuer keys, plus an online epoch check for freshness.
  - *Consequence*: portable and federation-friendly, but it needs a new KMS-signed JWT type and client key pinning and verification, and gives little offline benefit because first contact and freshness need MESH anyway.
- **Option C**: `mesh_peer_` tickets extended to carry the sender's registered Iroh endpoint ids.
  - *Consequence*: keeps per-recipient scoping and immediate invalidation, but the sender must mint and the receiver introspect every 5 minutes per lane, which is the most MESH traffic, and the sender cannot send while MESH is down. Tickets are used today only by the A2A gateway's outbound path, so this extends them to Iroh.
- **Rejected**: long-lived delegations with no periodic epoch check, because revocation would lag for days, against MESH's epoch model.
- **Facts checked 2026-10-25** (server worktree at commit 57704c2, not necessarily the default branch): workload tokens last at most 300 s (`IDENTITY_V1_DEFAULTS.tokenLifetimeSeconds`), with a 30 s skew allowance and 24 h key-rotation overlap and recovery delay. Peer tickets last at most 300 s, are limited to 100 active per sender, snapshot the sender's `dm_send_epoch` and the recipient's `dm_receive_epoch`, and are valid only while those epochs and both agents' states still match. Each agent has one `endpoint_url` (an HTTP endpoint), so an Iroh endpoint id is a new field.

### Decision 3: Endpoint Topology and When to Add Per-Message Signatures

**Owner decision (2026-10-25): Option A.**

- **Option A (Chosen; changed from the first draft)**: One endpoint serves exactly one principal, which is what `validatePeerWakes` already enforces by rejecting a duplicate `stateRoot`, plus one-agent-per-endpoint rules in the MESH registry and the pairing store (Slices 3a and 4). Per-message signatures on `triangle-peer/2` (Slice 3b) are built when the owner wants one engine to serve several principals or wants stolen-device-key resistance.
  - *Consequence*: smallest first slice, no wire or Rust change, and it fits the code as it is (`peer-engine-manager.mjs` starts one engine per state directory, checked 2026-10-25). Until Slice 3b, a stolen `device.key` acts as the bound principal on that lane (Section 7, row 6), and the literal "second agent on the same endpoint" form of Gate 2 is demonstrated as a refusal rather than as shared operation.
- **Option B (the first draft's pick)**: Shared endpoints with mandatory per-message signatures from the start (Slices 3a and 3b together).
  - *Consequence*: supports several principals per engine and resists device-key theft immediately, but ties the first usable slice to an ALPN bump, a Rust change, supervisor-held signing keys and the custody work. Its benefit over Option A depends on keys being unreadable to sibling processes, which file-based custody does not give.
- **Option C**: A separate engine, state root and `device.key` per principal, with no per-message signatures, permanently.
  - *Consequence*: this is Option A without Slice 3b; simplest to operate, and it accepts the device-key-equals-principal exposure for good.

### Decision 4: Serverless Pairing Approval Authority

**Owner decision (2026-10-25): Option A.**

- **Option A (Chosen)**: Human owner only, by OS re-authentication: the macOS account password, or Touch ID where the owner has enabled it for sudo, at an OS prompt, with TTY and harness-ancestry refusals as defense in depth, for every pairing, rotation and endpoint addition (mechanism in Section 4.4; `sudo -v` or a helper `LocalAuthentication` sheet is settled by a feasibility check in Slice 3a).
  - *Consequence*: no new secret to manage, it works over SSH, and an agent without the owner's password cannot pass it. It fails closed on a host with passwordless sudo or a non-admin account, where the owner would need the helper sheet or another factor. Checked 2026-10-25 on the production Mac: sudo requires a password, the account is an admin, Touch ID for sudo is off. Residual risk: an injected agent can still ask the owner to type the password into the agent's own terminal.
- **Option B**: A separate approval passphrase stored as a 0600 hash and typed at the terminal.
  - *Consequence*: pure Node and headless, but a new secret to manage, and offline-guessable by same-user processes if it is weak.
- **Option C**: Interactive CLI prompt with TTY and harness-ancestry guards only.
  - *Consequence*: no secret, but an agent with a pseudo-terminal can still approve; best effort.
- **Option D**: Allow an autonomous local agent session (e.g., Claude or Codex) to approve through an MCP tool call.
  - *Consequence*: vulnerable to prompt injection; a malicious prompt in an untrusted workspace could instruct the agent to pair with an attacker-controlled endpoint and exfiltrate workspace context. Rejected.

### Decision 5: Rotation Approval and Pre-Committed Keys

**Owner decision (2026-10-25): Option A.**

- **Option A (Chosen)**: Every serverless rotation, and every endpoint addition, waits for the peer's owner approval by the Decision 4 mechanism; removals and revocations apply at once. The rotation and endpoint-update records reserve an optional `next_key_digest` field now, so pre-commitment can be added later without a format change.
  - *Consequence*: each rotation costs one approval per peer, which is fine for a two-Mac setup. A thief of the active key cannot take over peers by rotating first. Replacing a device is an endpoint addition and needs the same approvals.
- **Option B**: Approval plus mandatory pre-commitment from the start.
  - *Consequence*: stronger against a thief of the active key, but the next key must be kept somewhere safer than the active one, and losing it is the same as losing the principal.
- **Option C**: Pre-commitment only, with no per-peer approvals.
  - *Consequence*: smoother rotation, with the same custody burden for the next key.

### Decision 6: Key Custody Tier

**Owner decision (2026-10-25): Option A.**

- **Option A (Chosen)**: Keep file-based custody (0600 key files, and the supervisor's in-memory key) as `packages/macos-mailbox-helper/KEYCHAIN_POLICY.md` (2026-10-18) requires, and claim Gate 2 at Tier R only (Section 10). Tier S (unsandboxed same-user sessions) is recorded as not covered.
  - *Consequence*: no helper or signing-policy work. An interactive chat with shell access can already read `workload-key.json`, so the Iroh binding adds no new exposure but does not remove that one either. For managed mode the supervisor already receives the workload key seed at bootstrap, so a later Slice 3b needs no new key distribution there.
- **Option B**: Move principal and message-signing keys to Keychain items restricted to the signed supervisor, or to the Secure Enclave.
  - *Consequence*: closes Tier S for those keys, but is blocked today. The policy says agent identities never live in the Keychain, ad-hoc builds cannot carry Keychain access-group entitlements (the helper README says the same), and Developer ID signing is out of scope. It needs that scope change first, and a story for headless, backup and multi-device cases.
- **Option C**: Run the supervisor and its keys under a separate OS account, reached by sessions only over a socket.
  - *Consequence*: closes Tier S without the Keychain, but needs a privileged installer and a new launch model; nothing supports it today.

### Decision 7: Lifetimes and Offline Grace

**Owner decision (2026-10-25): Option A for managed freshness, and 365 days for serverless pairings.**

- **Managed Option A (Chosen)**: re-check every 5 minutes; if MESH is unreachable, accept a cached binding for up to 15 minutes after its last successful resolve, then fail closed. This matches MESH's own 300 s workload token and peer ticket lifetimes, so a revoked agent is cut off on Iroh about as fast as on the server path. Elapsed time uses a monotonic clock (Section 6).
- **Managed Option B**: re-check every minute, offline 5 minutes: the fastest revocation, with more fail-closed events after sleep or short outages.
- **Managed Option C**: re-check every 15 minutes, offline 1 hour: the best offline behavior, but a revoked agent can keep sending on Iroh for 15 minutes normally and an hour during an outage.
- **Serverless Option A (Chosen)**: pairings last 365 days by default (the owner may shorten that); renewal needs the Decision 4 OS re-authentication at both ends, and `status`/`doctor` warn 30 days ahead. Revocation stays immediate.
- **Serverless Option B**: 90 days, the first draft's value: tighter hygiene, a renewal chore four times a year, and a lane stops if one is missed.
- **Serverless Option C**: no expiry, until revoked: no chore, but stale pairings persist and Gate 3 has no expiring serverless assertion to test.
- **Not decisions**: local session credentials keep their existing 300 s TTL (`ttlMs: 300000`); the 7-day tombstone window is the engine's; multi-device sub-key lifetimes belong to the deferred Slice 3b.

---

## Coverage Table

| Contract Item (Deliverables & Acceptance Gates from Section B) | Addressing Sections |
| :--- | :--- |
| **Deliverable 1**: Define logical agent identity separately from device, harness, session, conversation, display name; scope, collision handling, migration preservation. | Sections 2, 3, 8 |
| **Deliverable 2**: Define explicit bindings to local sessions, Iroh endpoints, optional MESH enrollment; shared endpoint must not authorize impersonating all agents. | Sections 4, 5 |
| **Deliverable 3**: Specify who issues, approves, verifies each binding; MESH-signed expiring delegation (evaluated; online resolve chosen, Decision 2) vs serverless owner-approved pairing; exact formats and verification order. | Section 4 |
| **Deliverable 4**: Define authenticated sender provenance and reply routing across transports; never export local HMAC tokens or trust encrypted connection alone. | Section 5 |
| **Deliverable 5**: Specify key/session rotation, revocation, expiry, device loss, re-enrollment, multi-device delegation; offline validity & freshness; no mandatory MESH dependency in serverless mode. | Section 6 |
| **Deliverable 6**: Preserve each mode's authority and delivery guarantees; no automatic merge, server enrollment, content bridge, or downgrade between modes. | Sections 3, 4, 5, 7, 8 |
| **Deliverable 7**: Provide inspectable identity/binding view in `status`/`doctor` explaining active principal, route, authority, and expiry without secrets. | Section 9 |
| **Acceptance Gate 1**: Same logical agent identifiable across permitted local/remote routes; unauthorized aliases and conflicting bindings fail explicitly. | Sections 3, 4, 5, 10 |
| **Acceptance Gate 2**: Second agent on same endpoint cannot impersonate the first; remote sender claims require configured binding/delegation proof. | Sections 4, 5, 7, 10 |
| **Acceptance Gate 3**: Stale session generations, revoked bindings, expired assertions, and replaced device keys rejected per documented offline policy. | Sections 4, 6, 7, 10 |
| **Acceptance Gate 4**: Replies remain bound to original authenticated agent/conversation through reconnect, restart, rotation; no fallback to different active session. | Sections 5, 6, 10 |
| **Acceptance Gate 5**: Migration preserves existing enrolled/local IDs or requires explicit owner mapping; restart and key rotation do not silently enroll duplicates. | Sections 6, 8, 10 |
| **Acceptance Gate 6**: Demonstrate both MESH-managed and serverless peer operation with distinct verification evidence, failure tests, and installed-path tests. | Sections 4, 10, 11 |

---

## Review Record (Claude, 2026-10-25)

**Provenance.** Drafted by Gemini 4 Argon (`agy`, one invocation, run from an empty directory) from the item 7 research notes and the contract excerpt (deliverables and six gates) only. The draft came back at about 9,200 words against a 4,500-word cap, with all twelve sections and the coverage table. Its process kept running after the output was complete and was stopped by hand. The unedited draft is kept at `docs/handoffs/2026-10-25-item7-gemini-first-draft.md`.

**Checked against the repository.**
- Workload key and custody: `keys.mjs` (Ed25519 JWK, RFC 7638 thumbprint), `custody.mjs` (default home), `triangle agent add|list|pause|resume|delete`, the existing bind command `triangle-mailbox bind`, and `status`/`doctor` as one command case.
- Iroh: `peer-engine` is Rust; ALPN `triangle-peer/1`; the `PeerMessage` fields; the reject codes including `sender_mismatch`; the README's out-of-scope list; `ed25519-dalek` in `Cargo.lock`.
- Supervisor: `validatePeerWakes` (one `stateRoot` per profile, `allowedPeers`, `routes`, experimental gate) and `peer-lane.mjs` (inbound attribution is `fromEndpointId` only).
- Journal: `request_id` and `in_reply_to` already tie a request to its replies; there is no conversation id.
- Tickets: `mesh_peer_` tickets come from `POST /api/v1/peer-tokens` and are used by the A2A gateway's outbound path.
- MESH server (a feature-branch worktree at commit 57704c2): `peer-auth.ts`, `permission-predicates.ts`, `identity-v1-profile.ts`, `workload-token.ts` and ADR 0001 and 0015 for ticket and token lifetimes, epoch snapshots, the per-agent `endpoint_url` and the endpoint vocabulary; the peer-engine has no signing call; `KEYCHAIN_POLICY.md` for custody.

**Corrected in the draft.**
1. Peer tickets are not an Iroh mechanism; the managed-assertion decision and the freshness table were reworded.
2. The endpoint-topology decision now starts from the fact that each profile already has its own engine and key, so the first slice binds one endpoint to one principal with no wire or Rust change. Per-message signatures on a new ALPN became Slice 3b.
3. The first draft's wire envelope duplicated existing fields (`payload_sha256`, `sent_at`) and had no version negotiation; it now reuses the existing names, uses a new ALPN, adds `recipient_endpoint_id` to the signed input, and adds an age check consistent with the 7-day tombstone window (the first draft's replay residual risk contradicted its own design).
4. The summary and Gate 2 overclaimed. Key custody is now explicit, Gate 2 is claimed per custody tier, and same-user file readers (decision F1) are recorded as not covered.
5. Automatic acceptance of old-key-signed rotations allowed a key thief to lock out the owner; rotations and endpoint additions now need the peer owner's approval, with optional pre-commitment.
6. Pairing approval had to be an action a harness session cannot perform; added to the design, threat table and decisions, and settled by owner Decision 4 as OS re-authentication.
7. Added: legacy `triangle-peer/1` lanes and their provenance, unbound sessions staying local-only, alias resolution, exactly one principal per profile, migration of existing 64-hex keys and policies, the sub-key verification chain for multi-device, an authenticated need-to-know resolve call, monotonic-clock handling, and five more threat rows.
8. `conv_` identifiers are replaced by the existing `request_id`; the route store moved from JSON files to an additive journal table; the invented `triangle agent bind` became the real commands; an undefined `ERR_MODE_MISMATCH` is now defined; the MESH workload JWT lifetime that the draft invented is marked unknown; the owner decision on lifetimes and offline grace that the draft dropped is restored (Decision 7).
9. Slice 1 mixed read-only and writing work and was split; slices now map to gates, and release mechanics are noted.
10. While settling Decision 1 the review found that the first draft derived the serverless id from the genesis key but verified it against the current key (step 3 of 4.1 and of 4.4), which fails after the first rotation. Owner Decision 1 (opaque id) removes the problem and adds the key-covering SAS.
11. The managed binding (the draft's delegation, and any alternative) lacked proof of possession of the endpoint key, so one agent could register another's endpoint id. Registration now requires it; the engine has no signing call today.
12. The draft's lifetimes (1 hour delegation, 5 minute cache, 15 minute grace, 90-day pairings, 7-day sub-keys) had no source, and the local credential lifetime it put at 1 hour is 300 s in the code. Owner Decision 7 fixed the managed values at 5 and 15 minutes (matching MESH's 300 s tokens) and pairings at 365 days.
13. After owner Decision 2 the signed-delegation design was replaced by online resolve. The `identity_hello` message that an earlier pass of this review had added was dropped too, because pairing records (serverless) and MESH resolve (managed) already map endpoints to principals.

**Not verified.** The MESH server files named above were read from a feature-branch worktree (commit 57704c2), not the default branch. The server's database schema and the A2A inbound path were not read, so the registry table, the resolve statement and the per-agent cap are proposals. Whether the supervisor can hold messages undelivered after the engine's `received_peer` receipt, whether a helper sheet can supply a Touch ID or password confirmation (now a Slice 3a feasibility check, owner Decision 4), and where the registry should live were not examined. Lifetimes and grace values are now owner decisions (Decision 7). The status sketch is illustrative. The document is still much longer than a 4,500-word design should be; trimming was not done to avoid losing checked detail. Also unconfirmed: whether runner sandboxes are denied the custody home (the policy confirms only `credentials/`), and whether `LocalAuthentication` can be used from the ad-hoc signed helper (nothing in the helper uses it today).
