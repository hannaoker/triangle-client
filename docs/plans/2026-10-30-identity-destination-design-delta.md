# Identity and destination design delta (U3)

Status: design delta, 2026-10-30. Design and review only: this document authorizes no code, runtime, binding, grant, enrolment, installation or network route, and it is not owner-approved. Baseline: U2 head `27d63d3` (draft PRs #148 and #149, not merged) on client main `741ff27`. It supplements `2026-10-25-identity-reconciliation-design.md` (the identity design) and `2026-10-25-unified-messaging-interface-design.md` (the interface design) and leaves their cryptographic, rotation and lifetime proposals alone. Every claim about shipped behavior cites source at this baseline; paths are under `packages/agent-worker/src/` unless they start with `docs/`, `test/` or `packages/`.

## Purpose

U3 of `2026-10-29-unified-messaging-next-slices.md` asks for the identity and destination design to be closed before any Iroh or MESH adapter is built. This delta says what exists today, where the October text no longer matches the code, which rules to adopt, and which owner decisions are still open. The owner decisions of 2026-10-25 (identity design decisions 1 to 7, interface design decisions 1 to 8) stay in force and are not reopened. Nothing here maps a session to a principal, pairs a peer or activates R2.

## 1. Where shipped code differs from the October text

| # | Topic | October text | Shipped | Consequence |
| --- | --- | --- | --- | --- |
| 1 | Binding record | `local_profile_binding_v1` with `installation_id`, `principal_public_key`, `expires_at`, a signed proof, and `trust_mode` `mesh-managed` or `serverless-peer` (identity design 4.1) | Closed schema. `trust_mode` is only `mesh-managed` (`identity-registry.mjs:314`), `principal_id` only `agent_<32-hex>` (`:317`), `proof` only `disk_observation` with `verified_live_authority: false` (`:372-378`), and unknown keys are refused (`:295-302`). Identity design 4.1 already notes the reduced record. | A `peer_` principal, a key or a signature cannot be stored without a new schema version (D1). |
| 2 | Rebind may change the principal | Binding a profile that is bound to principal 1 to principal 2 fails with `ERR_BINDING_CONFLICT` unless explicitly unbound (identity design 3, rule 3) | `bind` on an existing profile is a rebind: generation + 1, a new `binding_id`, same profile, `revoked_at` null. `principal_id` and `authority_origin` are not constrained (`identity-registry.mjs:1346-1365`). The registry test rebinds to a different principal at a different origin (`test/identity-registry.test.mjs:1911-1930`) and rebinds a revoked binding (`:1990-2013`). `revoke` only sets `revoked_at` (`:1367-1379`). | Storage allows a silent identity swap that the October rule forbids. No command reaches it today: the only non-test writer is `identity migrate` (`identity-mapping.mjs:553-557`; `packages/triangle-cli/src/cli.mjs:52-54`), which adds bindings (D2). |
| 3 | One principal, several profiles | A profile binds to exactly one active principal; silent on the reverse (identity design 3, rule 3) | Nothing makes `principal_id` unique: the validator checks only `binding_id` uniqueness (`identity-registry.mjs:309-312`). The resolver answers `recipient_ambiguous` when several directory recipients keep the principal (`recipient-resolver.mjs:165-183`), `route_unavailable` when none does (`:151-153`), and the router never picks a candidate (`unified-router.mjs:362`). `test/local-messaging-discovery-details.test.mjs` pins it ("a principal bound to two recipients..."), and U2 reports it per entry (`unified-router.mjs:685-733`, `send.addressKinds`). | Such a principal cannot be used as an address (D3). |
| 4 | Sessions have no principal and no persisted binding | `local_session_binding_v1` with `principal_id`, supervisor-issued, 300 s TTL (identity design 4.2) | No such record. An attached chat is its address, `session-` + sha256(installation, workspace, harness-namespaced session id) (`local-messaging-interactive-session.mjs:215-217`, `:229`). Its credential carries the lifecycle `generation` and the MCP child id as `bindingId`, TTL 30 s (`:298-310`), and every request is re-fenced against both (`:314-315`); the child reuses a grant for 15 s (`claude-session-mcp-child.mjs:247`). Principal, authority origin and binding generation of a chat are always null (`local-sender-authentication.mjs:30`; `local-messaging-interactive-session.mjs:312-313`). The bound Codex conversation cannot attach (`:302`). | Session-to-principal authority is entirely unbuilt (D4). |
| 5 | Session generation | `binding_generation` rises on every re-bind or credential rotation (identity design 4.2, 6.2) | The lifecycle generation rises by one only when a start event follows an end event (`local-messaging-journal.mjs:2149`). The directory keeps at most 128 sessions and evicts ended ones (`:2142-2148`); events and end tombstones are kept 8 days (`:20`). The raw harness session id is never stored, only its sha256 (`:2162`). | The counter is a restart count for one address, not an authority epoch. |
| 6 | Reply pins | `reply_route_v1` keyed `(remote principal, request_id)` with `min_remote_binding_generation`, `permitted_transports`, `failover_endpoint_ids` (identity design 5) | `local_reply_route_v1`, keyed `["local-socket", remote address, requestId]` (`local-reply-route-contract.mjs:38-47`). Address, principal, authority origin and generations are pinned attributes; a mismatch refuses the reply and a regression of either generation raises `reply_generation_regressed`; nothing is rerouted (`:49-72`). Stored in `local_reply_routes(route_key, route_json)` on the journal's own connection (`local-reply-route-store.mjs:11`). Created only for attached chat to attached chat while the owner policy `reply-identity.json` is enabled (`local-sender-authentication.mjs:43-46`), which the R2 handoff (2026-10-26) records as disabled; current live state was not read. Workers and the bound desktop sender stay unpinned. | The pin key is an address; a remote-principal key, failover and permitted transports are future work. |
| 7 | Provenance | `sender_provenance_v1` with `via`, `freshness`, `revocation_epoch` per transport (identity design 5) | Built only for attached local pairs: `assurance.kind` `local-attested`, `principal_binding` `unbound` or `owner-mapped-disk-observation`, `principal` null for chats (`local-reply-route-contract.mjs:74-84`), stored as `sender_provenance_json` (`local-messaging-journal.mjs:581`). | Remote fields do not exist yet. |
| 8 | Addressing | Principal id, alias, session address or local id; an unknown or ambiguous alias fails as `alias_unresolved` (interface design 4.2); petnames come with a registry extension (R1 plan decision 3) | A string that is neither `agent_` nor `peer_` shaped passes through as an exact id (`via: "id"`, `unified-router.mjs:238-281`). `peer_` ids fail `peer_not_supported` (`unified-router.mjs:283-297`, `recipient-resolver.mjs:94-98`). There is no alias map, no `alias_unresolved` and no `destination` field. | Unchanged: ids route, labels never do. |
| 9 | Inbound delivery | `admitInbound`, `origin_transport`, `remote_principal`, a destination rule, a router-owned `deliveryMode` (interface design 4.5) | None exists. A principal send resolves to a profile instance in the router's recipient directory (`recipient-resolver.mjs:136-163`), then that profile's normal dispatch applies (runner for workers, inbox for the bound conversation). Attached chats are never principal-addressed. The journal already records how a principal was resolved (`to_principal`, `resolved_via`, `reply_route_key`; `local-messaging-journal.mjs:470-472`), and a retry must repeat the same principal intent (`:320-340`). | Remote inbound ownership is unbuilt. |

## 2. Identifiers that must be preserved

| Identifier | Shape and source | Rule |
| --- | --- | --- |
| Profile instance id | 64-hex, `sha256("triangle-client-instance-v1\0" + profile)` (`identity-primitives.mjs:8`, `:16-22`); the registry key (`identity-registry.mjs:329-335`) | Keep. Never a remote principal (identity design 3). |
| MESH principal | `agent_<32-hex>` (`identity-primitives.mjs:7`) | Keep. The only principal kind the registry can store today. |
| Serverless principal | `peer_<32-hex>`; refused today (`unified-router.mjs:20`, `:283-297`) | Reserved syntax. Do not mint until a schema version can hold it. |
| Binding id | `bind_<32-hex>`, unique per registry (`identity-registry.mjs:74`, `:309-312`) | Keep. A rebind needs a new one (`:1357`). |
| Session address | `session-<64-hex>` (`identity-primitives.mjs:9`); Codex ids are namespaced `codex:<id>` before hashing (`local-messaging-interactive-session.mjs:229`) | Keep both. Do not store raw harness session ids. |
| Request id | `[A-Za-z0-9._:-]{1,256}` (`local-reply-route-contract.mjs:6`) | Keep. |
| Reply pin key | JSON array whose first element is the transport (`local-reply-route-contract.mjs:45`) | Keep. A remote transport adds its own first element beside it. |
| Registry files and caps | `identity-registry-v1.json`, `registry-audit.jsonl`, `.registry.lock`; 1000 bindings, 1 MiB, 8 MiB (`identity-registry.mjs:53-59`) | Keep until D1 introduces a new version beside them. |
| Owner policy files | `reply-identity.json` `{version, enabled}` (`local-messaging-cli.mjs:931-945`), `router.json` (`:945`), session messaging policy v1 and v2 with `exactPairs` (`local-messaging-interactive-session.mjs:191-211`; `local-messaging-cli.mjs:1003-1023`) | Keep. They are owner policy, not bindings. |
| Journal columns and tables | `to_principal`, `resolved_via`, `reply_route_key`, `sender_provenance_json`, and the table `local_discovered_sessions` (`local-messaging-journal.mjs:443-472`, `:581`); the table `local_reply_routes` (`local-reply-route-store.mjs:11`) | Keep; new columns stay additive and nullable, as before. |

## 3. Rules to adopt

### A. Session-to-principal authority

1. Until the owner decides otherwise (D4), no attached chat, discovered session or bound conversation is a principal. Every observation keeps `principal`, `authorityOrigin` and `bindingGeneration` null. This is the shipped behavior and needs no change.
2. A principal's authority comes only from an owner-created registry record. It never comes from a label, a caller-supplied field, a harness type or a same-name profile (the rule the code already states, `local-sender-authentication.mjs:6-9`).
3. If chats are ever mapped, the record names a selector, not a session id: harness plus workspace, the same shape as the recorded destination rule. Every new chat is a new address (`local-messaging-interactive-session.mjs:215-217`) and ended sessions leave after 8 days, so a pinned address goes stale. A chat acts as the principal only while it is the one live attached session the selector matches, judged on each request. With two matches or none it acts as unbound.
4. The supervisor derives the mapped observation from the live registry and the live attachment, never from message metadata (`local-reply-route-contract.mjs:9-11`). The reply pin then records principal, authority origin and binding generation exactly as it does for profiles (`:12-31`).
5. Mappings are created, moved and revoked only by owner commands that need a terminal and a plan id, as `identity migrate --confirm` does. An agent session cannot approve its own mapping. The October OS re-authentication for pairings (identity design decision 4) is not extended to local mappings by this delta (D2).

### B. Revocation and generation

| Counter | Lives in | Advances | Fences |
| --- | --- | --- | --- |
| `binding_generation` | registry binding, profile to principal | +1 on a rebind (`identity-registry.mjs:1355`); `revoke` leaves it unchanged | New principal resolutions: the snapshot provider re-reads when the registry file's stat key changes and at least every 2 s (`router-registry-snapshot.mjs:128`, `:149-160`); the resolver ignores revoked bindings (`recipient-resolver.mjs:121-130`) |
| lifecycle `generation` | discovered-session row | +1 on a start after an end (`local-messaging-journal.mjs:2149`) | Attach (`session_fenced`, `local-messaging-interactive-session.mjs:305`) and every later request (`:314-315`) |
| child id (`bindingId`) | attachment and credential | a new MCP child | The same `validateRequest` check |
| pin generations | reply pin | observed; may not regress | Replies (`local-reply-route-contract.mjs:49-58`) |

1. Revoking a profile binding removes the principal address form for that profile. It does not block delivery: exact-id sends keep routing, because the owner ACL, not the registry, authorizes ids (`unified-router.mjs:238-281`). Blocking delivery stays an owner policy change.
2. A rebind that changes `principal_id` should be its own owner-confirmed action naming the old and the new principal, and storage should refuse it as a plain `bind` (D2). That restores the October `ERR_BINDING_CONFLICT` intent.
3. A pinned conversation whose profile later moves to another principal fails closed (`reply_remote_mismatch`) instead of being rerouted (`local-reply-route-contract.mjs:49-72`). This holds for pinned attached pairs only. An unpinned worker conversation resolves afresh on its next send.
4. Generations never decrease. A restored older registry snapshot is not detected locally, because the audit chain is unsigned (identity design 4.1 status note; threat row 8). That residual risk is accepted with file custody (identity design decision 6).

### C. Principal-addressed inbound delivery

1. Today only local sends exist. A principal resolves to the one bound profile instance in the router's directory, or the send fails (`recipient-resolver.mjs:132-183`).
2. For remote inbound (not built), keep the recorded rule order (interface design 4.5; decisions 2 and 7): a headless runner profile uses the runner; a bound conversation uses that conversation; otherwise the principal's destination rule (harness and workspace) selects the one live attached session; with none the message holds as `no_destination`, with several as `destination_ambiguous`. The router never picks the most recently attached session and never a different profile.
3. Two clarifications close gaps in the October text. First, a principal bound to several local profiles holds inbound as `destination_ambiguous`, and the owner resolves it by revoking a binding or setting a destination rule (D3). Second, a held message and its candidate list are visible to the owner in `status`; the sender sees only a bounded reason code. This matches U2, where discovery never names candidates the caller cannot see.
4. One consumer per lane: a profile's inbound is owned by exactly one of the runner, a router-owned destination or the interactive adapter, and a configuration naming two is refused at load (interface design 4.5, mailbox ownership).
5. Pins for remote conversations key on the verified remote principal and request id (identity design 5), added beside the local key shape.

### D. Exact addresses and labels first; aliases later

1. Exact ids route. Labels never do.
2. Aliases are a registry extension (an `aliases` map, set and clear commands, audit actions; R1 plan decision 3) that must exist before any remote adapter makes guessable names reachable. Contract: owner-set only; one alias names one principal in this registry; an alias that also matches a local id or label fails as `alias_unresolved` and never wins silently; the failure lists candidate ids only to a sender authorized for them; aliases never cross a transport (identity design 3, rule 5).
3. Until then principal sends work for `agent_` ids only, and `peer_` stays refused.

### E. What the review and reply authorization does not cover

The workspace `CLAUDE.md` and `_context.md` (owner decision, 2026-10-29) authorize reviewing Triangle Client changes and sending a correlated reply to the bound Codex conversation when Triangle delivers the request from the verified sender. They do not cover: binding, rebinding or revoking a principal; peer pairing; enrolment into MESH; destination rules; aliases; session grants (`grant-session`); enabling reply pin admission (`reply-identity.json`) or the router (`router.json`); copying local content to another transport; delivery permissions; merges or installs.

### F. Prerequisites before an Iroh or MESH adapter (not designs)

1. A registry schema version that can hold `peer_` principals, `serverless-peer` bindings, aliases and destination rules (D1).
2. `admitInbound` with `origin_transport` and `remote_principal` columns, and reply pins keyed by the remote principal.
3. A command that sets and clears a destination rule, with audit.
4. Endpoint-to-principal binding, one principal per endpoint, with expiry, and the owner approval mechanism of identity design decision 4 (its feasibility check is still pending).
5. For MESH: the peer-endpoint registry and resolve API (identity design Slice 4, in the MESH server repository) and the 5 and 15 minute freshness rules.
6. Hold-after-receipt behavior, so a message acknowledged by the engine can still be held (identity design 4.3), and per-remote-principal inbound caps.
7. Fresh installed evidence for each step, then two-host and separate-network acceptance. Source tests establish none of it.

## 4. Open owner decisions

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | How the registry gains `peer_`, `serverless-peer`, aliases and destination rules | A: a new schema version, introduced by the first slice that needs it; older readers refuse it, as the reply-identity policy does. B: additive optional keys in v1, which means relaxing the closed-schema validators (`identity-registry.mjs:295-302`). | A |
| D2 | Rebind semantics | A: keep storage permissive (today). B: storage refuses a principal change on `bind`; a separate owner-confirmed action moves a profile, with audit. | B, before any command exposes rebind or revoke |
| D3 | One principal bound to several local profiles | A: refuse a second active binding to a principal within one registry. B: allow it; sends and inbound are ambiguous (today). C: allow it with an owner-set primary. | A for the local registry; revisit for multi-device principals when pairing arrives |
| D4 | Chat identity | A: chats stay unbound (today). B: a harness-and-workspace selector with live uniqueness. C: pin an exact session address. | A now; B when a remote flow needs a chat to act as a principal; reject C (stale after every new chat) |
| D5 | Alias extension timing | Before any remote adapter (R1 plan decision 3), or later | Before; the earlier decision stands |
| D6 | Who sees held inbound messages and candidate lists | Owner only with a bounded code to the sender, or authorized senders too | Owner only |
| D7 | Permanent reply pin admission (R2) | Unchanged: a separate owner decision with fresh installed evidence | Unchanged |

## 5. Evidence and limits

Read at the baseline: the source files cited above, the two October designs, the R1 plan and the R1 and R2 handoffs. The relevant tests pass at the baseline (full `packages/agent-worker` suite: 1291 tests, 3 skipped, 0 failures on `27d63d3`). Not read or verified: any installed or live state (including whether `reply-identity.json` or `router.json` is enabled now), the MESH server, the Swift helper and the Rust peer engine, so the October claims about those stay as that design recorded them. Not verified: how a retry behaves when a profile is rebound between two attempts, because the retry check compares the stored principal string and routing intent only (`local-messaging-journal.mjs:320-340`). This delta describes no behavior it did not read in source.
