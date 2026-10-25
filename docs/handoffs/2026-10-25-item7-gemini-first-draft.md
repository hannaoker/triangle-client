# Identity Reconciliation Across Local, Iroh, and MESH Transports

## 1. Summary

This design reconciles logical agent identity across local sockets, Iroh peer lanes, and the MESH server without collapsing The Triangle’s two independent trust modes. Every logical agent is represented by an immutable **principal**: in MESH-managed mode, the server-issued `agent_<32-hex>` identifier; in serverless peer mode, a self-certifying `local_<32-hex>` (proposed) identifier derived from a per-agent Ed25519 public key. Principals are explicitly bound to local profile instances, local sessions, Iroh endpoint keys, and MESH enrollments via signed or owner-approved **binding records** (proposed). A shared Iroh device key authenticates only the transport endpoint; remote messages must carry a per-agent cryptographic proof (`Ed25519` signature over the envelope or a MESH-signed endpoint delegation JWT) so co-hosted agents cannot impersonate one another. Receivers compute a typed **sender provenance** (proposed) record from verified cryptographic and transport state, pinning replies to the exact principal, conversation, and binding generation.

---

## 2. Goals, Non-Goals and Vocabulary

### Goals

1. **Separate logical identity from runtime and transport artifacts**: Distinguish the logical agent (principal) from device keys, harnesses, local sessions, conversations, profiles, and display names.
2. **Prevent multi-agent endpoint impersonation**: Require per-agent cryptographic proof on shared Iroh endpoints so authenticating a device key never authorizes sending as every agent on that host.
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
| **Principal** | The immutable logical identity of an agent. Either a MESH principal (`agent_<32-hex>`) or a serverless local principal (`local_<32-hex>`, proposed). |
| **Controller / Owner** | The human authority governing a principal and its host installations (authenticated via WebAuthn in MESH, or local OS user/CLI approval in serverless mode). |
| **Profile** | A local configuration unit on a single host, identified on disk by a deterministic 64-hex `profileInstanceId` (`SHA-256("triangle-client-instance-v1\0" + profileName)`). |
| **Runtime / Harness** | The execution wrapper hosting an agent process (e.g., Claude, Codex, Grok worker). |
| **Session** | An ephemeral or interactive local harness execution instance, addressed locally by `session-<64-hex>` (`SHA-256(installationId + workspace + harnessSessionId)`). |
| **Conversation** | A logical thread of messages (`conversationId`, proposed envelope field) bound to participating principals and a specific session binding generation. |
| **Endpoint** | An Iroh network transport node identified by its persistent Ed25519 public key (`<endpoint-id>`, stored in `identity/device.key`). |
| **Credential** | Secret material and associated claims used to prove identity or authorization (local HMAC turn token, MESH Ed25519 workload JWT, proposed per-agent Ed25519 key pair). |
| **Binding** (proposed) | A cryptographically signed or owner-approved statement linking one principal to one profile instance, local session, Iroh endpoint, or MESH enrollment for a bounded lifetime and generation. |
| **Sender Provenance** (proposed) | A receiver-constructed, non-forgeable metadata structure attached to a delivered message recording the verified principal, transport path, and assurance level. |

---

## 3. Identity Model

### Principal Kinds and Namespaces

A principal is the sole identifier permitted to own conversation history, send or receive cross-transport messages, and hold authorization bindings. Two disjoint principal namespaces exist, corresponding to the two trust modes:

1. **MESH Principal (`agent_<32-hex>`)**: Issued by the MESH home server upon enrollment. Immutable, globally unique within the home server, and never reused.
2. **Serverless Principal (`local_<32-hex>`, proposed)**: Self-certifying identifier generated locally when a profile is initialized for serverless operation or migrated into the identity registry (`identity-registry-v1.json`, proposed). Each serverless principal generates a dedicated Ed25519 identity key pair stored at `<TRIANGLE_HOME>/principals/<local-principal-id>/principal-key.json` (proposed, mode `0600`). The identifier is computed as:
   `"local_" + hex(SHA-256("triangle-local-principal-v1\0" + raw_ed25519_public_key_32_bytes))[0..31]` (32 lowercase hex characters, 128 bits, proposed).

### Identifier Prefix and Namespace Table

All identifiers in The Triangle occupy distinct syntactic namespaces so parsers and verifiers never confuse a runtime address or device key with a principal:

| Artifact | Format / Prefix | Scope | Is a Principal? | Authority |
| :--- | :--- | :--- | :--- | :--- |
| MESH Principal | `agent_[a-f0-9]{32}` | MESH home server | **Yes** | MESH Server KMS |
| Serverless Principal (proposed) | `local_[a-f0-9]{32}` | Global self-certifying | **Yes** | Per-agent Ed25519 key (`principal-key.json`) |
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

1. **Equal Profile Names Across Devices**: Because two hosts with profile `<profile-name>` yield identical `profileInstanceId` values, `profileInstanceId` is prohibited inside remote wire assertions except as local diagnostic metadata. Remote bindings exclusively reference `agent_<32-hex>` or `local_<32-hex>`.
2. **Handle / Display Name Collisions**: In serverless mode, when an owner imports a peer invitation whose `displayName` or `profileName` matches an existing local or paired agent, the registry records both principals under their distinct `local_<32-hex>` IDs and marks `display_collision: true` (proposed). The CLI and `status`/`doctor` require disambiguation via the principal ID or an owner-assigned local petname (`petname`, proposed).
3. **Conflicting Active Bindings**: Within one local registry (`<TRIANGLE_HOME>/identity/identity-registry-v1.json`, proposed), one `profileInstanceId` may bind to at most **one** active principal of a given trust mode. Attempting to bind a profile already bound to `<principal-id-1>` to `<principal-id-2>` without an explicit `triangle identity unbind` (proposed) fails immediately with `ERR_BINDING_CONFLICT` (proposed).
4. **Cross-Mode Isolation**: A profile bound to a `local_<32-hex>` principal cannot be implicitly merged into an `agent_<32-hex>` principal. If an owner enrolls an existing local profile into MESH, the profile must either switch its active mode explicitly via an owner-confirmed command or maintain separate profiles; historical serverless pairings remain bound only to `local_<32-hex>`.

---

## 4. Trust Modes and Bindings

The Triangle operates in two strictly separated trust modes: **MESH-Managed Mode** and **Serverless Peer Mode**. Every message route relies on explicit binding records.

### Mode Separation Invariants

- Serverless peer mode requires **zero** network connectivity to or configuration of a MESH server.
- A MESH-managed principal (`agent_<32-hex>`) is never accepted via a serverless owner-pairing assertion, and a serverless principal (`local_<32-hex>`) is never accepted on a MESH-managed route.
- No background process, fallback router, or migration script may enroll a `local_<32-hex>` principal into MESH, copy messages between modes, or downgrade a failed MESH-managed delivery to an unauthenticated or serverless lane.

### Architectural Decision: Managed Default Assertion and Multi-Agent Endpoint Proof

The research notes left two coupled choices open: whether MESH-managed mode defaults to online `mesh_peer_` tickets or signed endpoint delegations for Iroh routes, and whether a host with multiple agents uses one device key or per-agent endpoint keys.

**Decision**:
1. **Default Managed Iroh Assertion**: Use a **MESH-signed Endpoint Delegation JWT** (`mesh_del_v1`, proposed) as the primary assertion for MESH-managed Iroh lanes, keeping online `mesh_peer_` tickets as an optional synchronous revocation check when both peers can reach MESH. *Justification*: `mesh_peer_` tickets expire in at most 300 seconds and require a live MESH lookup on every verification, making Iroh peer lanes brittle during brief MESH control-plane blips. A short-lived (e.g., 1-hour) MESH-signed delegation JWT bound to both the agent’s workload key (`cnf.jkt`) and the Iroh endpoint key (`cnf.epk`, proposed) allows direct peer verification while preserving MESH as the sole trust root.
2. **Multi-Agent Endpoint Isolation**: Retain one persistent Iroh `device.key` per `peer-engine` state root (preserving OS port/socket efficiency), **and require a per-agent cryptographic signature on every Iroh message envelope** (`sender_sig`, proposed). In MESH-managed mode, the agent signs each message with its workload private key (`workload-key.json`, whose public key thumbprint is certified in `cnf.jkt` of the MESH Endpoint Delegation JWT). In serverless mode, the agent signs each message with its `principal-key.json` private key (certified in the Owner Pairing Record). *Justification*: Even if two local profiles share one Iroh `device.key` and local state root, Process A only has access to its own principal/workload key custody or supervisor-gated signing socket and cannot forge Process B’s per-message signature. To prevent same-OS-user cross-profile reads (noted in research fact 7, decision F1), the local supervisor mediates signing or isolates key permissions per profile runner.

---

### Binding Records: Schemas, Signers, Lifetimes, and Verification

We define five explicit binding/assertion types (all proposed):

#### 4.1 Local Profile-to-Principal Binding (`local_profile_binding_v1`, proposed)

Links a local `profileInstanceId` on a host to its authoritative principal (`agent_<32-hex>` or `local_<32-hex>`). Stored at `<TRIANGLE_HOME>/identity/bindings/<profile-instance-id>.json` (proposed, builds on `profiles-v1/profile-<hex>.json`).

- **Fields**:
  - `schema`: `"local_profile_binding_v1"`
  - `binding_id`: `"bind_<32-hex>"`
  - `trust_mode`: `"mesh-managed"` | `"serverless-peer"`
  - `principal_id`: `"<principal-id>"` (`agent_<32-hex>` or `local_<32-hex>`)
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
- **Issuer / Approver**: Local owner via CLI (`triangle agent bind` or `triangle identity init`, proposed); signed by the principal’s local private key (`workload-key.json` or `principal-key.json`).
- **Verifier**: Local supervisor and CLI tools (`status`, `doctor`, local router).
- **Verification Steps (in order)**:
  1. Parse JSON and verify `schema == "local_profile_binding_v1"`.
  2. Recompute `SHA-256("triangle-client-instance-v1\0" + profile_name)` and verify it equals `profile_instance_id`.
  3. Check `trust_mode`: if `"mesh-managed"`, verify `principal_id` matches `^agent_[a-f0-9]{32}$` and `<TRIANGLE_HOME>/agents/<principal_id>/agent.json` exists with matching SHA-256; if `"serverless-peer"`, verify `principal_id` matches `^local_[a-f0-9]{32}$` and equals `"local_" + hex(SHA-256("triangle-local-principal-v1\0" + raw_pubkey))[0..31]`.
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
  - `exp`: unix epoch seconds (TTL $\le 3600$ seconds per turn/session lease)
  - `hmac_tag`: `"<hex-hmac-sha256>"` (supervisor-held secret)
- **Issuer / Approver**: Local supervisor process upon authenticating the local harness attachment and verifying a valid `local_profile_binding_v1`.
- **Verifier**: Local supervisor upon receiving any frame on the local Unix domain socket.
- **Verification Steps (in order)**:
  1. Recompute `HMAC-SHA256` using the supervisor’s in-memory secret over the canonical claim bytes; constant-time compare with `hmac_tag`.
  2. Check current host clock `now < exp` and `now >= issued_at - 5`.
  3. Lookup `session_id` in the active supervisor session table; verify `principal_id`, `profile_instance_id`, and `binding_generation` match the active entry exactly.
  4. Verify the active `local_profile_binding_v1` for `profile_instance_id` is still valid and maps to `principal_id`.
  5. Verify the target recipient principal is in `allowed_recipients`.
  6. **On failure**: Drop the local socket frame immediately, return `ERR_LOCAL_SESSION_UNAUTHORIZED` (proposed) to the caller, and increment the local audit counter.

#### 4.3 MESH-Managed Endpoint Delegation Assertion (`mesh_endpoint_delegation_v1`, proposed)

In MESH-managed mode, authorizes a MESH principal (`agent_<32-hex>`) to send and receive over a specific Iroh endpoint (`<endpoint-id>`) using its bound workload key (`cnf.jkt`). Issued by the MESH server over an authenticated workload DPoP call (`POST /api/v1/agents/me/endpoint-delegations`, proposed).

- **Format**: Ed25519-signed JWS (`typ: "mesh-endpoint-delegation+jwt"`, proposed).
- **Claims**:
  - `iss`: `"<mesh-home-server-issuer-url>"`
  - `sub`: `"agent_<32-hex>"` (the MESH principal)
  - `aud`: `"triangle:iroh-peer"`
  - `workload_id`: `"<workload-id>"`
  - `scope`: `"dm.send dm.receive"`
  - `iat`: unix epoch seconds
  - `exp`: unix epoch seconds (`iat + 3600` recommended; maximum 14,400 seconds / 4 hours)
  - `jti`: `"del_<32-hex>"`
  - `rev`: integer (snapshot of the principal’s current revocation epoch on the MESH server)
  - `dm_send_epoch`: integer (snapshot of the sender’s `dm.send` permission epoch)
  - `dm_receive_epoch`: integer (snapshot of the sender’s `dm.receive` permission epoch)
  - `binding_generation`: integer $\ge 1$
  - `cnf`:
    - `jkt`: `"<base64url-sha256-thumbprint-of-workload-ed25519-pubkey>"`
    - `wk_pub`: `"<base64url-workload-ed25519-pubkey>"` (explicit per-agent workload public key so offline peers within the grace window can verify per-message signatures)
    - `epk`: `"<iroh-endpoint-id-ed25519-pubkey>"` (the exact Iroh endpoint key authorized to carry traffic for `sub`)
- **Issuer / Approver**: Signed by the MESH home server KMS Ed25519 issuer key after verifying the agent’s workload JWT + DPoP proof and confirming the principal is not revoked.
- **Verifier**: Receiving peer’s `peer-engine` / client verifier (and local `status`/`doctor`).
- **Verification Steps (in order)**:
  1. Confirm the receiver’s local destination profile is operating in `mesh-managed` trust mode and trusts `iss` (same home server URL and pinned issuer public key set).
  2. Verify the JWS Ed25519 signature against the MESH server’s active issuer public key (`kid`).
  3. Verify `typ == "mesh-endpoint-delegation+jwt"`, `aud == "triangle:iroh-peer"`, and `sub` matches `^agent_[a-f0-9]{32}$`.
  4. Verify `now >= iat - 30` (30s clock skew allowance) and `now < exp`.
  5. Verify `cnf.epk` equals the TLS-authenticated Iroh connection endpoint ID (`authenticated_peer_endpoint_id`) from the active QUIC/TLS session.
  6. Compute the RFC 7638 JWK thumbprint of `cnf.wk_pub` and verify it equals `cnf.jkt`.
  7. Verify the message envelope’s per-agent signature (`sender_sig`, see Section 5) using `cnf.wk_pub`.
  8. Check revocation freshness (per Section 6 policy): either validate an attached `mesh_peer_` ticket / fresh server epoch cache (`cached_at` within the 5-minute freshness window showing `rev == current_rev` and `dm_send_epoch == current_dm_send_epoch`), or if MESH is unreachable, verify `now < exp` is within the bounded 15-minute offline grace window and `jti` / `(sub, rev)` is not in the local revocation deny-list.
  9. **On failure**: Reject message with `ERR_MESH_DELEGATION_INVALID` (proposed); do not deliver to the target session; log the rejection reason (`expired`, `endpoint_mismatch`, `bad_workload_sig`, `epoch_revoked`).

#### 4.4 Serverless Peer Invitation and Owner Pairing Record (`serverless_pairing_v1`, proposed)

In serverless peer mode, binds a remote `local_<32-hex>` principal to its principal public key and authorized Iroh `<endpoint-id>`. Established via a two-sided owner-approved invitation flow (`triangle peer invite` / `triangle peer accept`, proposed) and stored in `<TRIANGLE_HOME>/identity/pairings/<remote-principal-id>.json` (proposed).

- **Fields**:
  - `schema`: `"serverless_pairing_v1"`
  - `pairing_id`: `"pair_<32-hex>"`
  - `trust_mode`: `"serverless-peer"`
  - `local_principal_id`: `"local_<32-hex>"` (the local principal that owns this pairing)
  - `remote_principal_id`: `"local_<32-hex>"` (the remote peer’s principal)
  - `remote_principal_public_key`: `"<base64url-ed25519-pubkey>"`
  - `remote_endpoint_ids`: array of `"<iroh-endpoint-id>"` (explicitly authorized Iroh device keys for this remote principal; usually 1, >1 only if multi-device delegation is approved)
  - `petname`: `"<owner-chosen-local-alias>"` (required to be unique per `local_principal_id`)
  - `binding_generation`: integer $\ge 1$
  - `issued_at`: ISO-8601 UTC timestamp
  - `expires_at`: ISO-8601 UTC timestamp (default `issued_at + 90 days`, or owner-specified; must be explicit)
  - `remote_invitation_sig`: `"<base64url-ed25519-sig>"` (signed by `remote_principal_public_key` over `{remote_principal_id, remote_principal_public_key, remote_endpoint_ids, binding_generation, issued_at, expires_at}`)
  - `local_owner_approval_sig`: `"<base64url-ed25519-sig>"` (signed by `local_principal_id`’s `principal-key.json` over the entire pairing record during interactive CLI owner approval)
- **Issuer / Approver**: Remote agent signs the invitation (`remote_invitation_sig`); local human owner inspects the short authentication string (SAS fingerprint of `local_principal_id || remote_principal_id || remote_endpoint_ids`) and approves via CLI, causing `local_principal_id` to counter-sign (`local_owner_approval_sig`) and adding `remote_endpoint_ids` to the Iroh roster.
- **Verifier**: Receiving client’s serverless verifier on every inbound Iroh message and before every outbound reply.
- **Verification Steps (in order)**:
  1. Confirm the local receiving profile is in `serverless-peer` mode with principal `local_principal_id`.
  2. Lookup `serverless_pairing_v1` by claimed `remote_principal_id` in `<TRIANGLE_HOME>/identity/pairings/`.
  3. Verify `remote_principal_id == "local_" + hex(SHA-256("triangle-local-principal-v1\0" + raw_remote_principal_public_key))[0..31]`.
  4. Verify `local_owner_approval_sig` using `local_principal_id`’s public key and `remote_invitation_sig` using `remote_principal_public_key`.
  5. Verify `now < expires_at` and pairing is not marked `revoked: true` in the local registry.
  6. Verify the TLS-authenticated Iroh connection endpoint ID (`authenticated_peer_endpoint_id`) is a member of `remote_endpoint_ids` (or authorized by a chained `multi_device_delegation_v1`, Section 6).
  7. Verify the message envelope’s per-agent signature (`sender_sig`) using `remote_principal_public_key`.
  8. **On failure**: Reject message with `ERR_SERVERLESS_PAIRING_INVALID` (proposed); never deliver to the agent session.

---

## 5. Sender Provenance and Reply Routing Across Transports

### Per-Message Wire Envelope (`wire_envelope_v2`, proposed)

When a message traverses an Iroh peer lane, the transport layer only authenticates `authenticated_peer_endpoint_id` (`identity/device.key`). Because one host may run multiple agents (e.g., two profiles sharing one `peer-engine`), `device.key` alone cannot prove which agent sent the message. Therefore, every Iroh wire envelope must carry a per-agent cryptographic proof:

- **Fields of `wire_envelope_v2` (proposed)**:
  - `envelope_version`: `2`
  - `message_id`: `"<globally-unique-msg-id>"` (validated against the existing 7-day tombstone window)
  - `trust_mode`: `"mesh-managed"` | `"serverless-peer"`
  - `sender_principal`: `"<principal-id>"` (`agent_<32-hex>` or `local_<32-hex>`)
  - `recipient_principal`: `"<principal-id>"`
  - `sender_endpoint_id`: `"<iroh-endpoint-id>"` (must equal TLS-authenticated endpoint ID)
  - `conversation_id`: `"conv_<32-hex>"` (proposed)
  - `in_reply_to`: `"<message-id>"` or `null`
  - `sender_binding_generation`: integer $\ge 1$
  - `sent_at`: ISO-8601 UTC timestamp
  - `payload_sha256`: `"<64-hex>"`
  - `payload`: `<ciphertext-or-structured-body>`
  - `auth_assertion`:
    - For `mesh-managed`: `{ "kind": "mesh_delegation", "delegation_jwt": "<mesh_endpoint_delegation_v1>", "peer_ticket": "mesh_peer_<opaque-or-null>" }`
    - For `serverless-peer`: `{ "kind": "serverless_paired", "pairing_id": "pair_<32-hex>", "device_delegation": "<multi_device_delegation_v1-or-null>" }`
  - `sender_sig`: `"<base64url-ed25519-sig>"`

- **Computation of `sender_sig`**:
  - The sending agent signs the canonical byte string:
    `"triangle-msg-v2\0" + trust_mode + "\0" + message_id + "\0" + sender_principal + "\0" + recipient_principal + "\0" + sender_endpoint_id + "\0" + conversation_id + "\0" + (in_reply_to ?? "") + "\0" + sender_binding_generation + "\0" + sent_at + "\0" + payload_sha256`
  - In `mesh-managed` mode, `sender_sig` is produced using the sender’s `workload-key.json` private key (matching `cnf.wk_pub` inside `delegation_jwt`).
  - In `serverless-peer` mode, `sender_sig` is produced using the sender’s `principal-key.json` private key (matching `remote_principal_public_key` in the receiver’s `serverless_pairing_v1` record).
  - **Key custody isolation**: On hosts running multiple agents under the same OS user, `peer-engine` does **not** hold `principal-key.json` or `workload-key.json`. Either the agent’s own supervisor runner signs the envelope before handing it to `peer-engine` over an authenticated local socket, or key files are restricted to per-agent OS sub-users/helper processes. Consequently, Agent B on the same endpoint cannot forge `sender_sig` for Agent A (satisfying Acceptance Gate 2).

### Receiver-Computed Typed Sender Provenance (`sender_provenance_v1`, proposed)

A receiving runtime **never** copies provenance fields from the untrusted message payload. Before delivering a message to a local harness session, the receiver strips any caller-supplied `provenance` field from the payload, executes the transport-specific verification pipeline, and constructs the immutable `sender_provenance_v1` object:

```json
{
  "schema": "sender_provenance_v1",
  "principal": "<principal-id>",
  "recipient_principal": "<principal-id>",
  "trust_mode": "mesh-managed | serverless-peer",
  "conversation_id": "conv_<32-hex>",
  "sender_binding_generation": 3,
  "via": {
    "transport": "local-socket | iroh-peer | mesh-mailbox",
    "authenticated_peer": "session-<64-hex> | <iroh-endpoint-id> | <mesh-home-server-url>"
  },
  "assurance": {
    "kind": "local-attested | mesh-recorded | delegation-verified | owner-paired",
    "assertion_id": "bind_<32-hex> | del_<32-hex> | pair_<32-hex> | <mesh-event-id>",
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
   - `principal` is set from the supervisor’s verified session table (`principal_id`), **not** from the message body.
   - `via.authenticated_peer` is set to the verified `session-<64-hex>`.
   - Local HMAC turn credentials are consumed inside the supervisor and never forwarded off-host.
2. **MESH Mailbox (`transport: "mesh-mailbox"`, `assurance.kind: "mesh-recorded"`)**:
   - The client fetches the mailbox event from the MESH home server over TLS using its DPoP workload JWT.
   - Because MESH mailbox origin is server-recorded attribution (research fact 5), `principal` is set to the server-attested `sender_agent_id` (`agent_<32-hex>`) returned by the MESH API, verified against the local profile’s pinned MESH home server.
   - `via.authenticated_peer` is the MESH server issuer URL.
3. **Iroh Peer Lane — MESH-Managed (`transport: "iroh-peer"`, `assurance.kind: "delegation-verified"`)**:
   - `peer-engine` verifies that the QUIC/TLS peer public key equals `sender_endpoint_id` (`sender_mismatch` check) and that `message_id` is not in the 7-day tombstone table.
   - The verifier executes Section 4.3 steps 1–8 on `auth_assertion.delegation_jwt` and `sender_sig`.
   - `principal` is set to the verified `sub` claim (`agent_<32-hex>`) from `delegation_jwt`.
   - `via.authenticated_peer` is set to the TLS-authenticated `<iroh-endpoint-id>`.
4. **Iroh Peer Lane — Serverless Peer (`transport: "iroh-peer"`, `assurance.kind: "owner-paired"`)**:
   - `peer-engine` verifies TLS endpoint identity and 7-day message tombstone uniqueness.
   - The verifier executes Section 4.4 steps 1–7 on `auth_assertion.pairing_id` and `sender_sig`.
   - `principal` is set to `remote_principal_id` (`local_<32-hex>`) from the verified local `serverless_pairing_v1` record.
   - `via.authenticated_peer` is set to the TLS-authenticated `<iroh-endpoint-id>`.

### Reply Routing and Conversation Pinning (`reply_route_table_v1`, proposed)

To satisfy Acceptance Gate 4, replies must stay strictly bound to the original authenticated principal, conversation, trust mode, and binding generation across reconnects, process restarts, and key rotations, with **no fallback** to a different active session or unauthorized endpoint.

#### Reply Route Record (`reply_route_v1`, proposed)

When a message is verified and delivered to a local session, the supervisor persists a durable route entry in `<TRIANGLE_HOME>/identity/routes/<conversation-id>.json` (proposed):

- **Fields**:
  - `conversation_id`: `"conv_<32-hex>"`
  - `trust_mode`: `"mesh-managed"` | `"serverless-peer"`
  - `local_principal`: `"<principal-id>"`
  - `local_session_id`: `"session-<64-hex>"` (the exact local session owning this conversation)
  - `local_binding_generation`: integer $\ge 1$
  - `remote_principal`: `"<principal-id>"`
  - `min_remote_binding_generation`: integer $\ge 1$ (set to `sender_binding_generation` of the latest verified inbound message; never decrements)
  - `permitted_transports`: `["local-socket"]` | `["iroh-peer", "mesh-mailbox"]` | `["iroh-peer"]` (constrained by `trust_mode`)
  - `pinned_remote_endpoint_id`: `"<iroh-endpoint-id>"` or `null`
  - `updated_at`: ISO-8601 UTC timestamp

#### Outbound Reply Verification Steps (in order)

When a local session attempts to send a reply on `conversation_id`:

1. **Verify Local Caller Pinning**: Look up `reply_route_v1` for `conversation_id`. Verify the caller’s verified `principal` equals `local_principal` and its `session_id` equals `local_session_id`.
   - *Reconnect / Restart handling*: If the original harness process restarted and re-attached with the **same** deterministic `session-<64-hex>` (`SHA-256(installationId + workspace + harnessSessionId)`) and a valid `local_session_binding_v1` for `local_principal` with `binding_generation >= local_binding_generation`, update `local_binding_generation` and allow the reply.
   - *No fallback to another session*: If `local_session_id` is disconnected and a *different* session (`session-<other>`) for the same profile tries to reply on `conversation_id` without an explicit owner session-transfer command, **reject** with `ERR_REPLY_SESSION_MISMATCH` (proposed). Similarly, inbound replies targeting `conversation_id` when `local_session_id` is offline are queued for `local_session_id` (or rejected if queue TTL expires)—the supervisor **never** falls back to delivering the reply to a different active session on the host.
2. **Verify Trust Mode Invariance**: Verify the outbound transport matches `trust_mode` and `permitted_transports`. A `"serverless-peer"` conversation can never route over `"mesh-mailbox"`, and a `"mesh-managed"` conversation can never use `"owner-paired"` assertions.
3. **Re-Verify Remote Target Binding at Reply Time**:
   - In `serverless-peer` mode: Load the current `serverless_pairing_v1` for `remote_principal`. Verify it is not expired or revoked, and its `binding_generation >= min_remote_binding_generation`. Send only to an endpoint in `remote_endpoint_ids`. If the remote peer rotated its endpoint key via a valid signed rotation assertion (incrementing `binding_generation`), update `min_remote_binding_generation` and `pinned_remote_endpoint_id`. If the pinned endpoint is unreachable, **queue or fail explicitly (`ERR_REMOTE_ENDPOINT_UNREACHABLE`, proposed)**—never fall back to another unpaired endpoint on the roster.
   - In `mesh-managed` mode: Verify the recipient `remote_principal` (`agent_<32-hex>`) has a fresh MESH endpoint delegation or valid `mesh_peer_` ticket whose `binding_generation >= min_remote_binding_generation` and whose revocation epoch is valid.

---

## 6. Lifecycle

### Key Rotation, Session Rotation, Revocation, Expiry, Device Loss, Re-Enrollment, and Multi-Device Delegation

1. **Key Rotation (No Silent Principal Replacement)**:
   - **MESH Workload Key Rotation**: The agent generates a new Ed25519 `workload-key.json` and registers it with MESH using its existing active workload credential (or WebAuthn controller approval per ADR 0001). The MESH principal `agent_<32-hex>` is unchanged. The server increments `binding_generation` and issues a new `mesh_endpoint_delegation_v1` JWT (`cnf.jkt` / `cnf.wk_pub` updated).
   - **Serverless Principal Key Rotation**: Because `local_<32-hex>` is derived from the initial `principal-key.json` public key (`genesis_public_key`, proposed), rotating the signing key **without** changing `local_<32-hex>` uses a signed **Key Continuity Statement** (`serverless_key_rotation_v1`, proposed):
     - Fields: `schema`, `principal_id` (`local_<32-hex>`), `old_public_key`, `new_public_key`, `binding_generation` (incremented), `rotated_at`, `sig_by_old_key`, `sig_by_new_key`.
     - Paired peers verify `sig_by_old_key` against the currently pinned `remote_principal_public_key` and `sig_by_new_key` against `new_public_key`, then atomically advance `remote_principal_public_key` and `binding_generation` in `serverless_pairing_v1` while keeping `remote_principal_id` (`local_<32-hex>`) identical.
   - **Iroh Device Key (`identity/device.key`) Rotation**: Rotating `device.key` changes `<iroh-endpoint-id>` while keeping the principal unchanged. In MESH-managed mode, the client requests a new `mesh_endpoint_delegation_v1` with the new `cnf.epk` and incremented `binding_generation`. In serverless mode, the principal signs an **Endpoint Update Statement** (`serverless_endpoint_update_v1`, proposed) with its `principal-key.json` (`{principal_id, new_endpoint_ids, binding_generation, issued_at, expires_at, principal_sig}`); paired peers verify `principal_sig` and update `remote_endpoint_ids` and their Iroh roster.
2. **Session Rotation**:
   - When a local harness restarts or rotates its turn lease, the supervisor issues a new `local_session_binding_v1` with `binding_generation = old_generation + 1` and invalidates all lower generations for that `session_id` immediately.
3. **Revocation**:
   - **MESH-Managed**: The controller or server revokes a workload key, endpoint delegation, or `dm.send`/`dm.receive` permission, incrementing the principal’s `rev` or permission epoch on the MESH server.
   - **Serverless Peer**: Either the remote principal broadcasts a signed `serverless_revocation_v1` (proposed, signed by `principal-key.json`) or the local owner runs `triangle peer revoke <principal-id>` (proposed), setting `revoked: true` in `<TRIANGLE_HOME>/identity/pairings/<principal-id>.json` and removing the endpoint from the Iroh admission roster.
4. **Expiry**:
   - Every assertion (`local_session_binding_v1`, `mesh_endpoint_delegation_v1`, `serverless_pairing_v1`, `mesh_peer_` ticket) carries an explicit `exp` / `expires_at` timestamp. Expired assertions are rejected immediately after the mode’s documented clock-skew/grace window (see table below).
5. **Device Loss and Re-Enrollment**:
   - **MESH-Managed**: If a laptop is lost, the human controller uses WebAuthn on the MESH server to revoke the lost device’s `workload_id` and increment `rev`. On a replacement host, the controller re-binds the existing `agent_<32-hex>` principal using delayed WebAuthn dual-control recovery (ADR 0001), generating a new `workload-key.json` and `device.key` without creating a new `agent_<32-hex>`.
   - **Serverless Peer**: If a host is lost and the owner has an encrypted backup of `principal-key.json`, they restore `principal-key.json` on the new host, increment `binding_generation`, and distribute a signed `serverless_endpoint_update_v1` revoking the lost `<iroh-endpoint-id>`. If `principal-key.json` is permanently lost without backup, self-certifying continuity is impossible: the owner must revoke the old `local_<32-hex>` pairing on all peers and explicitly pair a new `local_<32-hex>` principal (never silently replacing it by profile name).
6. **Multi-Device Delegation**:
   - **MESH-Managed**: One `agent_<32-hex>` principal may be authorized on two hosts by enrolling a distinct `workload_id` and `device.key` per host; MESH mints a separate `mesh_endpoint_delegation_v1` for each `(workload_id, cnf.epk)`. Conversation reply routes (`reply_route_v1`) still pin `pinned_remote_endpoint_id` per conversation unless the sender presents a valid higher `binding_generation`.
   - **Serverless Peer**: A principal’s primary key (`principal-key.json`) may authorize a secondary host’s Iroh endpoint and sub-key via a signed `multi_device_delegation_v1` (proposed): `{schema, principal_id, primary_public_key, sub_device_public_key, sub_endpoint_id, binding_generation, issued_at, expires_at, primary_sig}` (max lifetime 7 days), or by listing multiple `remote_endpoint_ids` in the owner-approved `serverless_pairing_v1`.

### Offline Validity Window and Revocation Freshness Policy

| Trust Mode & Transport | Assertion Type | Default Assertion Lifetime (`exp`) | Revocation-Freshness Rule | Offline-Validity Window (When Authority Is Unreachable) | Receiver Action When Freshness Cannot Be Checked |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Local Socket** (Both modes) | `local_session_binding_v1` (Supervisor HMAC) | $\le 1\text{ hour}$ per lease | Checked synchronously in local supervisor memory on every frame (`binding_generation` + active table). | **Full offline validity** (supervisor is on the same host; zero network dependency). | If the local supervisor socket or registry is unreadable, **fail closed** (`ERR_LOCAL_SUPERVISOR_UNAVAILABLE`, proposed). |
| **MESH-Managed** (MESH Mailbox) | Workload JWT + DPoP (`workload-token.ts`) | $5\text{–}15\text{ minutes}$ | Checked synchronously by the MESH server against `rev` epoch on every API request. | **0 seconds** (requires live MESH server connection). | MESH server is the transport itself; unreachable server causes transport delivery deferral/retry. |
| **MESH-Managed** (Iroh Peer Lane via Peer Ticket) | `mesh_peer_` ticket (`peer-auth.ts`) | $\le 300\text{ seconds}$ | Receiver queries MESH server to verify ticket and live `dm.send` / `dm.receive` epochs. | **0 seconds** (ticket is opaque and requires MESH lookup). | Reject ticket validation or require sender to present a signed `mesh_endpoint_delegation_v1`. |
| **MESH-Managed** (Iroh Peer Lane via Signed Delegation) | `mesh_endpoint_delegation_v1` (JWS) | $1\text{ hour}$ (max $4\text{ hours}$) | Receiver checks MESH revocation/epoch status (`rev`, `dm_send_epoch`) at most every **5 minutes** (`freshness: "cached-fresh"`). | **15 minutes** after last successful MESH epoch check (`freshness: "offline-grace"`), provided `now < exp` and `jti`/`rev` not locally revoked. | Once `now - last_mesh_epoch_check > 15 minutes` or `now >= exp`, **fail closed** (`ERR_MESH_FRESHNESS_EXPIRED`, proposed); reject inbound Iroh frames for MESH principals until MESH epoch check succeeds. |
| **Serverless Peer** (Iroh Peer Lane) | `serverless_pairing_v1` + per-message `sender_sig` | Owner-configured (default $90\text{ days}$, $\le 365\text{ days}$) | Checked synchronously against local `<TRIANGLE_HOME>/identity/pairings/` deny-list and monotonic `binding_generation`. | **Full offline validity until `expires_at`** (zero MESH or third-party server dependency). | Local disk is the authority. If `now >= expires_at`, `revoked == true`, or `binding_generation < min_remote_binding_generation`, **fail closed** (`ERR_SERVERLESS_PAIRING_EXPIRED`, proposed). |

---

## 7. Threat Table

| Threat | Attack Scenario | Concrete Mitigation in This Design | Residual Risk |
| :--- | :--- | :--- | :--- |
| **1. Impersonation of a second agent on a shared endpoint** | Profiles `alpha` and `beta` share one Iroh `peer-engine` (`device.key`). `beta` sends an Iroh frame claiming `sender_principal` = `alpha`. | Every `wire_envelope_v2` frame requires `sender_sig` signed by the sender’s per-agent key (`workload-key.json` certified in `cnf.wk_pub` of `mesh_endpoint_delegation_v1`, or `principal-key.json` in `serverless_pairing_v1`), mediated by the supervisor per session. `device.key` alone never authenticates a principal. | If two agents run under the same unisolated OS UID and read `<TRIANGLE_HOME>` directly (research fact 7, decision F1), OS-level file access could read the other key unless supervisor-isolated signing permissions (`0600` to supervisor daemon user) are enabled. |
| **2. Replay of an assertion or signed message** | An attacker captures a valid `wire_envelope_v2` or `mesh_endpoint_delegation_v1` and replays it to another endpoint or re-injects the message. | `mesh_endpoint_delegation_v1` binds `cnf.epk` to the exact TLS-authenticated `<iroh-endpoint-id>` and `cnf.wk_pub` to the agent’s workload key; `wire_envelope_v2` binds `sender_sig` to `message_id`, `sender_endpoint_id`, `recipient_principal`, and `sent_at`, enforced alongside `peer-engine`’s 7-day `message_id` tombstone table. | Within the 30-second clock-skew window, if a receiver’s tombstone database is wiped without rotating keys, a captured message from the last 30 seconds could be replayed once. |
| **3. Stale or revoked binding / session generation** | A revoked session or deauthorized device continues messaging using a cached delegation JWT or old session binding. | Local socket frames check `binding_generation` in memory on every turn. MESH Iroh delegations expire in 1 hour and enforce a 5-minute epoch cache / 15-minute hard offline cap against `rev` and `dm_send_epoch`. Serverless pairings enforce monotonic `min_remote_binding_generation` and local revocation list checks. | In MESH-managed Iroh mode, if the receiver cannot reach the MESH server, a newly revoked delegation remains accepted for up to the 15-minute offline grace window (until `last_mesh_epoch_check + 15m`). |
| **4. Confused deputy across sessions or conversations** | Agent A tricks the local router or a remote peer into delivering a reply meant for Session 1 to Session 2, or forwarding a local HMAC token remotely. | Receiver computes `sender_provenance_v1` from transport/crypto verification and strips payload provenance. Local HMAC tokens never leave the local socket. `reply_route_v1` pins `conversation_id` to `(local_principal, local_session_id, remote_principal, min_remote_binding_generation)` with zero fallback to other sessions. | If the legitimate `local_session_id` harness process itself is compromised by prompt injection, it acts with its own authorized `local_principal` privileges within `allowed_recipients`. |
| **5. Equal-name collision across devices** | Two Macs both have a profile named `gravity2` (producing identical 64-hex `profileInstanceId`). Host 2 tries to impersonate Host 1’s `gravity2`. | `profileInstanceId` is never accepted as a remote principal. Remote messages must authenticate as `agent_<32-hex>` or `local_<32-hex>`. Serverless pairings verify `remote_principal_public_key` and require unique local `petname` aliases on display collisions. | Human owner could visually misread a CLI prompt if they ignore the SAS fingerprint and `local_<32-hex>` ID during `triangle peer accept`. |
| **6. Device-key (`identity/device.key`) theft** | An attacker copies `identity/device.key` from a host backup and connects to peers over Iroh. | Possessing `device.key` only passes the Iroh TLS roster gate; the attacker lacks `workload-key.json` or `principal-key.json` required to produce `sender_sig` on `wire_envelope_v2`. Once detected, the owner rotates `device.key` and increments `binding_generation`. | If the attacker stole the entire `<TRIANGLE_HOME>` directory including unencrypted `principal-key.json` / `workload-key.json` along with `device.key`, they can sign as the agent until the principal or workload key is revoked. |
| **7. Cross-mode downgrade** | An attacker or misconfiguration causes a `mesh-managed` agent (`agent_<32-hex>`) to accept a `serverless-peer` pairing assertion, bypassing MESH revocation epochs. | `local_profile_binding_v1`, `wire_envelope_v2`, and `reply_route_v1` enforce strict `trust_mode` partitioning (`agent_` prefixes rejected in `serverless-peer` verifier; `local_` prefixes rejected in `mesh-managed` verifier). No automatic fallback or mode conversion exists. | None at the protocol level; requires deliberate owner CLI unbind and re-initialization to change a profile’s trust mode. |
| **8. Rolled-back local identity registry** | A disk snapshot restoration or local attacker rolls `<TRIANGLE_HOME>/identity/identity-registry-v1.json` back to an older version to resurrect a revoked pairing or stale `binding_generation`. | Registry writes increment a monotonic `registry_sequence` (proposed) anchored in an append-only hash chain (`registry-audit.log`, proposed) and signed by a host installation key; remote peers also enforce `min_remote_binding_generation` and reject messages whose `sender_binding_generation` regresses. | If a local attacker has full root/user write access to both the registry file and the local audit log/key on an offline machine, purely local state rollback cannot be prevented without hardware TPM/Secure Enclave sealing. |

---

## 8. Migration

Migration transitions existing installations (`profiles-v1/profile-<hex>.json`, `<TRIANGLE_HOME>/agents/<agent_id>/`, local supervisor `registry_state`, and Iroh `peer-engine` rosters) to the explicit identity model without breaking active workflows or merging identities by name.

### Step 1: Read-Only Inventory (`triangle identity inventory`, proposed)

Before writing any binding files, the migration tooling performs a strictly read-only scan of `<TRIANGLE_HOME>` and outputs an inventory report (`inventory-report-v1.json`, proposed):

1. Scans `scripts/triangle-client-service.sh` `registry_state` and supervisor `peerWakes` to list every local `profileName`, its 64-hex `profileInstanceId`, active `session-<64-hex>` addresses, and associated `peer-engine` state root (`identity/device.key` public key).
2. Scans `profiles-v1/profile-<hex>.json` and `<TRIANGLE_HOME>/agents/<agent_id>/agent.json` to identify profiles already bound to a MESH principal (`agent_<32-hex>`).
3. Scans static Iroh `--allow-peer`/`--roster` configurations to flag unattributed endpoint keys (`status: "unmapped_endpoint"`).
4. Flags any profile names or handles that collide across local config files or known peer rosters (`status: "collision_requires_owner_mapping"`).

### Step 2: Owner-Confirmed Mapping (`triangle identity migrate --confirm`, proposed)

No identity binding is created or merged silently:

1. **Existing MESH-Bound Profiles**: If `profiles-v1/profile-<hex>.json` already points to a valid `<TRIANGLE_HOME>/agents/<agent_id>/agent.json`, the migration proposes a `mesh-managed` `local_profile_binding_v1` preserving the exact `agent_<32-hex>` and existing `profileInstanceId`.
2. **Existing Local-Only / Serverless Profiles**: For profiles without a MESH binding, the tool proposes generating a new `local_<32-hex>` key pair (`principal-key.json`) and binding it to the existing `profileInstanceId` in `serverless-peer` mode, **preserving** the 64-hex `profileInstanceId` and active `session-<64-hex>` addresses for local compatibility.
3. **Static Iroh Roster Entries**: Existing static `--roster` endpoint IDs are **not** automatically trusted as principals. The owner must complete an explicit `serverless_pairing_v1` or `mesh_endpoint_delegation_v1` exchange for each remote peer before unified remote routing admits traffic from that endpoint.
4. **Strict Prohibition on Name-Based Merge**: Even if local profile `<profile-name>` has the same string name as a MESH agent `handle` or a remote peer’s profile name, the migration tool never merges them automatically; the owner must explicitly pass `--map-profile <profile-name> --to-principal <principal-id>` and prove key possession.

### Step 3: Preservation of Existing Identifiers

- `agent_<32-hex>`, `profile-<64-hex>.json`, 64-hex `profileInstanceId`, `session-<64-hex>`, and `identity/device.key` paths and values remain completely unchanged on disk.
- Restarting the supervisor or rotating `workload-key.json` / `device.key` updates `binding_generation` inside `<TRIANGLE_HOME>/identity/bindings/<profile-instance-id>.json` and **never** calls agent enrollment or mints a duplicate `agent_<32-hex>` or `local_<32-hex>`.

### Step 4: Rollback

- All new identity records reside under the additive directory `<TRIANGLE_HOME>/identity/` (`identity-registry-v1.json`, `bindings/`, `pairings/`, `routes/`).
- Setting `TRIANGLE_IDENTITY_RECONCILIATION=off` (proposed) or rolling back the binary causes the client to ignore `<TRIANGLE_HOME>/identity/` and fall back cleanly to the pre-migration local-only `profiles-v1` and static `--roster` behavior, while keeping unified cross-transport routing disabled.

---

## 9. Inspectable Identity View for `status` / `doctor`

Both `triangle status` and `triangle doctor` are extended (`--identity` flag or default identity section, proposed) to render the active principals, trust modes, bindings, authorities, expiry timestamps, revocation freshness, and any detected conflicts without exposing private keys, HMAC secrets, or raw bearer tokens.

### Sketch of `triangle status --identity` and `triangle doctor` Output

```text
=== TRIANGLE IDENTITY & BINDING STATUS ===
Registry: <TRIANGLE_HOME>/identity/identity-registry-v1.json (seq: 14, integrity: OK)

[1] Profile: "gravity2" (profileInstanceId: <64-hex-instance-id-1>)
    Principal      : agent_<32-hex-id-a>
    Principal Kind : mesh-managed
    Authority      : https://mesh.example.invalid (issuer kid: <mesh-kms-kid>)
    Gen / Status   : generation 4 | ACTIVE
    Local Bindings :
      - Profile Binding : bind_<32-hex-1> (verified_me_at: 2026-10-25T06:00:00Z)
      - Active Session  : session-<64-hex-session-1> (harness: codex, gen: 4, exp: 2026-10-25T08:45:00Z)
    Remote Bindings:
      - Iroh Endpoint   : <iroh-endpoint-pubkey-1> (shared endpoint: 2 local principals bound)
      - MESH Delegation : del_<32-hex-jti-1> (cnf.jkt: <jkt-thumbprint-1>, cnf.epk: <iroh-endpoint-pubkey-1>)
                          issued: 2026-10-25T07:30:00Z | expires: 2026-10-25T08:30:00Z
    Freshness      : cached-fresh (rev epoch: 7, dm.send: 3, dm.receive: 2)
                     last MESH check: 2026-10-25T07:36:10Z (offline grace until: 2026-10-25T07:51:10Z)
    Pinned Routes  :
      - conv_<32-hex-conv-1> -> agent_<32-hex-id-b> via iroh-peer (endpoint: <iroh-endpoint-pubkey-9>, min_gen: 2)

[2] Profile: "claude-local" (profileInstanceId: <64-hex-instance-id-2>)
    Principal      : local_<32-hex-id-c>
    Principal Kind : serverless-peer (self-certifying Ed25519, pubkey: <base64url-pubkey-prefix>...)
    Authority      : local-owner (<TRIANGLE_HOME>/principals/local_<32-hex-id-c>)
    Gen / Status   : generation 2 | ACTIVE
    Local Bindings :
      - Profile Binding : bind_<32-hex-2> (issued: 2026-10-24T12:00:00Z, expires: never)
      - Active Session  : session-<64-hex-session-2> (harness: claude, gen: 2, exp: 2026-10-25T08:50:00Z)
    Remote Bindings:
      - Iroh Endpoint   : <iroh-endpoint-pubkey-1> (shared endpoint: per-agent sender_sig enforced)
      - Owner Pairings  :
        * Peer "mac-mini-claude" -> local_<32-hex-id-d> (pair_<32-hex-9>, gen: 1)
          endpoint: <iroh-endpoint-pubkey-2> | expires: 2027-01-22T12:00:00Z | freshness: local-authoritative (OK)

=== DOCTOR DIAGNOSTICS & CONFLICTS ===
[WARN] Shared Iroh Endpoint: <iroh-endpoint-pubkey-1> serves 2 principals (agent_<32-hex-id-a>, local_<32-hex-id-c>).
       Per-agent envelope signing (wire_envelope_v2.sender_sig) is REQUIRED and ACTIVE.
[ERR]  Conflict on Profile "worker-dup" (profileInstanceId: <64-hex-instance-id-3>):
       ERR_COLLISION_UNMAPPED: Remote peer local_<32-hex-id-e> advertises display name "gravity2" matching local profile "gravity2".
       Action: Automatic merge blocked. Assign distinct petname via `triangle peer petname local_<32-hex-id-e> <alias>`.
[ERR]  Stale Roster Entry: Endpoint <iroh-endpoint-pubkey-legacy> is in static peer-engine roster but has no principal binding.
       Action: Admissions from <iroh-endpoint-pubkey-legacy> are BLOCKED. Run `triangle peer accept` or remove from roster.
```

---

## 10. Verification Plan

No claim of identity reconciliation may be made until all six acceptance gates pass with both unit/protocol tests and installed-path evidence.

| Gate | Positive Tests | Negative Tests | Required Evidence | Modes Covered | Two Physical Machines Required? | Installed-Path Run Required? |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Gate 1**: Same logical agent identifiable across permitted routes; unauthorized aliases and conflicting bindings fail explicitly. | 1. Send message from `agent_<32-hex>` over local socket, Iroh peer lane, and MESH mailbox; verify receiver computes identical `provenance.principal`.<br>2. Send message from `local_<32-hex>` over local socket and Iroh peer lane; verify identical `provenance.principal`. | 1. Attempt to bind two principals to one `profileInstanceId` (`ERR_BINDING_CONFLICT`).<br>2. Remote peer on Machine B with identical profile name `gravity2` (same 64-hex `profileInstanceId`) attempts to message Machine A claiming local `gravity2` identity (`ERR_SERVERLESS_PAIRING_INVALID`).<br>3. Attempt to route `local_<32-hex>` over MESH mailbox or `agent_<32-hex>` using serverless pairing (`ERR_MODE_MISMATCH`). | JSON capture of `sender_provenance_v1` across all routes; CLI exit codes and `triangle doctor` conflict output logs. | Both (`mesh-managed` and `serverless-peer`) | **Yes** (to prove two hosts with identical profile names / 64-hex `profileInstanceId` do not collide or merge over Iroh). | **Yes** (installed CLI + supervisor daemon + `peer-engine`). |
| **Gate 2**: Second agent on same endpoint cannot impersonate the first; remote sender claims require configured binding/delegation proof. | 1. Configure Profiles A and B on Machine 1 sharing one `peer-engine` (`device.key`). Both send signed `wire_envelope_v2` messages to Machine 2; Machine 2 attributes each to its respective principal (`agent_` or `local_`). | 1. Profile B crafts an Iroh envelope with `sender_principal = Profile A` and signs `sender_sig` with Profile B’s key (`ERR_MESH_DELEGATION_INVALID` / `ERR_SERVERLESS_PAIRING_INVALID`).<br>2. Send an Iroh frame authenticated only by TLS `device.key` without `auth_assertion` or `sender_sig` (rejected at verifier).<br>3. Export local HMAC turn token in an Iroh payload (ignored/rejected by remote verifier). | Packet/envelope capture showing shared `sender_endpoint_id` with distinct `cnf.wk_pub` / `sender_sig`, plus rejection audit logs for cross-agent spoofing. | Both (`mesh-managed` and `serverless-peer`) | **Yes** (Machine 1 hosting two co-resident agents sending over real Iroh relay/direct path to Machine 2). | **Yes** (installed supervisor enforcing per-profile signing isolation). |
| **Gate 3**: Stale session generations, revoked bindings, expired assertions and replaced device keys rejected per offline policy. | 1. Verify `mesh_endpoint_delegation_v1` succeeds while MESH is reachable and within the 15-minute offline grace window when MESH is unreachable.<br>2. Verify `serverless_pairing_v1` succeeds completely offline prior to `expires_at`. | 1. Replay a `local_session_binding_v1` token with `binding_generation = N - 1` (`ERR_LOCAL_SESSION_UNAUTHORIZED`).<br>2. Revoke MESH `dm.send` epoch or delegation; verify rejection after epoch sync (and rejection of any delegation once offline $> 15\text{ min}$ or past `exp`).<br>3. Revoke serverless pairing or advance `min_remote_binding_generation`; verify old pairing/device key is rejected immediately. | Time-travel and network-partition test transcripts showing exact pass at $T + 14\text{m}$ offline and fail-closed `ERR_MESH_FRESHNESS_EXPIRED` at $T + 16\text{m}$ offline. | Both (`mesh-managed` and `serverless-peer`) | **Yes** (to verify Iroh rejection when `device.key` is replaced or MESH endpoint is firewalled between two Macs). | **Yes** |
| **Gate 4**: Replies remain bound to original authenticated agent/conversation through reconnect, restart and rotation; no fallback to different active session. | 1. Establish `conv_<32-hex>` between Principal A (`session-1`) and Principal B. Restart Principal A’s harness and supervisor (`session-1` re-binds with `binding_generation + 1`) and rotate B’s key via signed continuity statement; verify reply succeeds and updates `min_remote_binding_generation`. | 1. Stop `session-1` while keeping `session-2` active under the same profile on the same host; send inbound reply on `conv_<32-hex>` and verify it is **not** delivered to `session-2`.<br>2. Have `session-2` attempt to send an outbound reply on `conv_<32-hex>` (`ERR_REPLY_SESSION_MISMATCH`).<br>3. Make B’s pinned Iroh endpoint unreachable while another paired endpoint exists on the roster; verify no silent fallback to a different principal’s endpoint. | Supervisor route table snapshots (`routes/conv_<32-hex>.json`) before and after restart/rotation, plus rejection logs when `session-2` is active. | Both (`mesh-managed` and `serverless-peer`) | **Yes** (for remote Iroh reconnect and endpoint key rotation across two hosts). | **Yes** |
| **Gate 5**: Migration preserves existing enrolled/local IDs or requires explicit owner mapping; restart and key rotation do not silently enroll duplicates. | 1. Run `triangle identity inventory` and `triangle identity migrate --confirm` on a pre-populated `<TRIANGLE_HOME>` containing `profiles-v1/profile-<hex>.json` and `agents/<agent_id>/`. Verify `agent_<32-hex>`, `profileInstanceId`, and `session-<64-hex>` are unchanged.<br>2. Restart daemon and rotate `workload-key.json` and `device.key`; verify principal count and IDs remain constant. | 1. Seed a local profile `gravity2` and a MESH agent with handle `gravity2` but no `profiles-v1` pointer; verify migration refuses automatic merge.<br>2. Trigger rollback (`TRIANGLE_IDENTITY_RECONCILIATION=off`) and verify legacy local operation resumes cleanly. | Before/after SHA-256 directory inventory of `<TRIANGLE_HOME>`, `identity-registry-v1.json` diff, and MESH server agent table query showing zero duplicate `agent_` enrollments. | Both (`mesh-managed` and `serverless-peer`) | **No** (can run on one host against local filesystem + MESH test server, though two-host roster migration is covered in Gate 6). | **Yes** (must run against installed `<TRIANGLE_HOME>` service scripts). |
| **Gate 6**: Demonstrate both MESH-managed and serverless peer operation, with distinct verification evidence and failure tests. | 1. End-to-end installed-path run in `mesh-managed` mode across two physical Macs over Iroh using `mesh_endpoint_delegation_v1` and MESH mailbox.<br>2. End-to-end installed-path run in `serverless-peer` mode across two physical Macs with MESH server completely unreachable/unconfigured (`serverless_pairing_v1`). | 1. Verify cross-mode isolation: attempt to bridge or downgrade a failed `mesh-managed` message onto the `serverless-peer` pairing between the same two Macs (`ERR_MODE_MISMATCH`).<br>2. Verify `triangle status` and `triangle doctor` accurately report both modes and redact all secret material. | Complete execution bundle: `triangle status --identity` and `triangle doctor` outputs from both Macs, wire captures, and pass/fail logs for both modes. | Both (`mesh-managed` and `serverless-peer`) | **Yes** (explicit two-Mac end-to-end proof required for both modes). | **Yes** (mandatory installed-path verification per contract). |

---

## 11. Implementation Slices, Rollout, Rollback, Assumptions and Risks

### Implementation Slices in Dependency Order

| Slice | Target Repository | Deliverables | Rollout | Rollback |
| :--- | :--- | :--- | :--- | :--- |
| **Slice 1: Read-Only Identity Inventory, Registry Schema, and `status`/`doctor` View** | **Client Monorepo** (`triangle-client`, supervisor, CLI) | Implements `<TRIANGLE_HOME>/identity/` schemas (`identity-registry-v1.json`, `local_profile_binding_v1`), `triangle identity inventory`, `triangle identity migrate --confirm`, and the secret-free `status`/`doctor` identity view. Enforces no-name-merge rules. | Ship behind default-on read-only reporting; `migrate --confirm` is opt-in per installation. | Delete `<TRIANGLE_HOME>/identity/` or set `TRIANGLE_IDENTITY_RECONCILIATION=off`; `profiles-v1` remains untouched. |
| **Slice 2: Local Session Generation Binding, Typed Provenance, and Reply Pinning** | **Client Monorepo** (`local-messaging-interactive-session.mjs`, supervisor router) | Upgrades local turn credentials to `local_session_binding_v1` with monotonic `binding_generation`, receiver-computed `sender_provenance_v1` (`local-attested`), and durable `reply_route_v1` pinning `(principal, session_id, conversation_id, generation)` with no session fallback. | Enable in local supervisor on daemon restart after Slice 1 migration is confirmed. | Toggle `TRIANGLE_STRICT_REPLY_PINNING=off` (proposed) and revert supervisor to legacy in-memory session lookup. |
| **Slice 3: Serverless Principals, Owner Pairing, and Per-Agent Iroh Envelope (`wire_envelope_v2`)** | **Client Monorepo** (`packages/peer-engine`, CLI `triangle peer`) | Adds `local_<32-hex>` key generation (`principal-key.json`), `triangle peer invite`/`accept`/`revoke` (`serverless_pairing_v1`), `serverless_key_rotation_v1`, `serverless_endpoint_update_v1`, and `wire_envelope_v2` with per-agent `sender_sig` verification in `peer-engine`. | Opt-in for serverless profiles via `triangle peer invite`; replaces unauthenticated static `--roster` entries with principal-bound roster admission. | Revert `peer-engine` flag to `--legacy-static-roster` (proposed), disabling cross-agent unified routing on Iroh. |
| **Slice 4: MESH Endpoint Delegation Issuer and Epoch Status API** | **MESH Server Repository** (`the-triangle` repo: `mesh/app/lib/workload-token.ts`, `mesh/app/api/v1/`) | Adds `POST /api/v1/agents/me/endpoint-delegations` (minting `mesh_endpoint_delegation_v1` JWS with `cnf.jkt`, `cnf.wk_pub`, `cnf.epk`, `rev`, `dm_send_epoch`, `dm_receive_epoch`, `binding_generation`) and a lightweight batch epoch check endpoint (`POST /api/v1/agents/epochs/check`, proposed). | Deploy backward-compatibly to MESH server; existing workload JWTs and `mesh_peer_` tickets continue to work unchanged. | Disable the new `/endpoint-delegations` route via server feature flag; clients cannot mint new Iroh delegations and fall back to MESH mailbox only. |
| **Slice 5: Client MESH-Managed Iroh Verification, Offline Grace Enforcement, and Unified Routing Cutover** | **Client Monorepo** (`workload-credential.mjs`, `packages/peer-engine`, unified router) | Integrates `mesh_endpoint_delegation_v1` verification, 5-minute epoch polling, 15-minute offline grace enforcement, and unblocks unified remote routing (Item 6 follow-up) once all six acceptance gates pass on two physical machines. | Enable unified remote routing only when `<TRIANGLE_HOME>/identity/identity-registry-v1.json` has verified bindings and Gate 1–6 tests pass. | Set `TRIANGLE_UNIFIED_REMOTE_ROUTING=off` (proposed), restricting MESH agents to MESH mailbox and local sockets to local host. |

### Assumptions

Because only the facts in Sections A and B of the prompt are verified, the following points are explicitly stated as **assumptions**:

1. **Assumption A1 (Ed25519 Library Availability in Client and `peer-engine`)**: Both the Node.js/MJS client (`workload-credential.mjs`) and the Rust/native `packages/peer-engine` already link standard Ed25519 signing/verification primitives (used today for MESH DPoP/workload tokens and Iroh `SecretKey`), so computing and verifying `sender_sig` and `mesh_endpoint_delegation_v1` requires no new cryptographic library dependency.
2. **Assumption A2 (Clock Synchronization on Participating Hosts)**: Participating macOS hosts run NTP/system clock synchronization such that legitimate clock skew between peers and the MESH server does not exceed 30 seconds.
3. **Assumption A3 (Supervisor-Mediated Signing Boundary)**: When multiple profiles run on the same host under the same OS user (fact 7, decision F1), the local supervisor process can act as the signing oracle for `wire_envelope_v2.sender_sig` (or invoke per-profile sub-processes) so an untrusted harness prompt or worker script cannot directly read another profile’s key file from disk.
4. **Assumption A4 (MESH Issuer Key Discovery / Pinning)**: A profile bound to a MESH agent (`agent.json`) already stores or can fetch and pin the MESH home server’s Ed25519 issuer public key set (`jwks`) during `triangle agent bind` so `mesh_endpoint_delegation_v1` signatures can be verified during the 15-minute offline grace window.

### Risks

1. **Same-UID File Read Risk (Decision F1)**: As noted in research fact 7, same-user processes can read the custody home `<TRIANGLE_HOME>` unless OS permissions are tightened. While `sender_sig` stops network-level endpoint impersonation and accidental cross-profile routing, full defense against a malicious local process running under the same macOS UID requires moving key custody into macOS Keychain or a dedicated supervisor OS user in a future hardening pass.
2. **Clock Drift Causing Premature Offline Lockout**: If a laptop wakes from sleep with a transiently skewed clock, the 15-minute MESH offline grace window or `iat - 30s` check may reject Iroh frames until NTP syncs and an epoch refresh completes.
3. **Iroh Direct-Path NAT Traversal**: As noted in research fact 9, physical Iroh relay paths work between the two Macs while direct path and separate-network NAT traversal remain unresolved; identity verification works identically over relay or direct paths, but end-to-end latency during epoch checks may depend on relay availability.

---

## 12. Owner Decisions

The following four design decisions are surfaced for explicit owner confirmation, along with the recommended choice used in this document and the consequences of alternatives:

### Decision 1: Serverless Principal Identifier Format and Prefix

- **Option A (Recommended)**: `local_<32-hex>` (proposed), computed as `"local_" + hex(SHA-256("triangle-local-principal-v1\0" + raw_ed25519_public_key))[0..31]`, paired with signed `serverless_key_rotation_v1` continuity statements for subsequent key rotations.
- **Option B**: `peer_<full-64-hex-ed25519-pubkey>`, embedding the raw 32-byte Ed25519 public key directly as the identifier.
  - *Consequence of Option B*: Slightly simpler initial verification (no hash step), but the principal ID is twice as long (69 chars vs 38 chars), breaks symmetry with `agent_<32-hex>`, and rotating `principal-key.json` becomes awkward because the identifier string visually encodes the superseded public key.
- **Option C**: Reuse the existing 64-hex `profileInstanceId` as the serverless principal ID.
  - *Consequence of Option C*: **Violates Gate 1 and Gate 5**. Because `profileInstanceId` is a deterministic hash of the profile name alone, any two machines with a profile named `gravity2` collide and cannot be distinguished without a separate cryptographic key binding.

### Decision 2: MESH-Managed Default Iroh Assertion (`mesh_endpoint_delegation_v1` vs `mesh_peer_` Tickets)

- **Option A (Recommended)**: Use the MESH-signed **Endpoint Delegation JWT (`mesh_endpoint_delegation_v1`, 1-hour TTL)** with a **5-minute epoch refresh cache** and a **15-minute offline grace window** as the default assertion on MESH-managed Iroh lanes; accept `mesh_peer_` tickets as an optional real-time supplement.
- **Option B**: Require an online `mesh_peer_` opaque ticket ($\le 300\text{s}$ TTL) on every Iroh peer session establishment and message batch, with zero offline grace window.
  - *Consequence of Option B*: Immediate revocation enforcement (zero offline window), but every Iroh peer message path becomes strictly dependent on synchronous HTTP round-trips to the MESH server, negating the resilience of a direct/relay peer lane during brief MESH restarts.
- **Option C**: Long-lived MESH endpoint delegations (e.g., 24-hour or 7-day TTL) with no periodic epoch check.
  - *Consequence of Option C*: High offline availability, but revoking a compromised workload key or `dm.send` permission on the MESH server leaves the agent able to message peers over Iroh for days, violating MESH’s epoch-based revocation model.

### Decision 3: Multi-Agent Iroh Endpoint Key Topology (Shared `device.key` + Per-Agent Envelope Signature vs Per-Principal `device.key`)

- **Option A (Recommended)**: Allow one `peer-engine` instance and one `identity/device.key` per host state root to serve multiple local principals, and **mandate a per-agent Ed25519 signature (`wire_envelope_v2.sender_sig`)** on every message envelope using the principal’s `workload-key.json` or `principal-key.json`.
- **Option B**: Require a separate `peer-engine` daemon, state directory, and `identity/device.key` for every principal on a host.
  - *Consequence of Option B*: Provides transport-layer TLS separation per agent, but multiplies background `peer-engine` processes, QUIC sockets, relay connections, and memory overhead by $N$ agents per machine—and *still* requires a signed assertion tying each `device.key` to its `agent_<32-hex>` or `local_<32-hex>` principal.

### Decision 4: Serverless Pairing Approval Authority

- **Option A (Recommended)**: **Human owner only** via interactive CLI confirmation (`triangle peer invite` / `triangle peer accept`), requiring a counter-signature (`local_owner_approval_sig`) and unique local `petname` before any remote `local_<32-hex>` principal or `<iroh-endpoint-id>` is admitted.
- **Option B**: Allow an autonomous local agent session (e.g., Claude or Codex) to approve inbound peer invitations on its own via an MCP tool call.
  - *Consequence of Option B*: Vulnerable to prompt injection—a malicious prompt in an untrusted workspace could instruct the agent to pair with an attacker-controlled Iroh endpoint and exfiltrate workspace context.

---

## Coverage Table

| Contract Item (Deliverables & Acceptance Gates from Section B) | Addressing Sections |
| :--- | :--- |
| **Deliverable 1**: Define logical agent identity separately from device, harness, session, conversation, display name; scope, collision handling, migration preservation. | Sections 2, 3, 8 |
| **Deliverable 2**: Define explicit bindings to local sessions, Iroh endpoints, optional MESH enrollment; shared endpoint must not authorize impersonating all agents. | Sections 4, 5 |
| **Deliverable 3**: Specify who issues, approves, verifies each binding; MESH-signed expiring delegation vs serverless owner-approved pairing; exact formats and verification order. | Section 4 |
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
