# One agent-facing messaging interface over local, Iroh and MESH (item 6 design)

Status: design draft, 2026-10-25. Design only: no code, no production change, not owner-approved. It builds on the item 7 identity design (`2026-10-25-identity-reconciliation-design.md`) and answers the contract in "Follow-up: one agent-facing messaging interface" (`2026-10-23-unified-agent-messaging-follow-up.md`, untracked in the `installed-local-messaging` worktree). The owner's priority update of 2026-10-23 defers cross-machine implementation and remote installation; this document authorizes neither. Names marked "proposed" do not exist yet; facts marked "checked" were read in the code on 2026-10-25. Owner decisions recorded 2026-10-25: all eight are settled (decision log in section 8); the design as a whole still awaits the owner's approval.

## 1. Summary

Agents get one set of verbs (send, discover, status, replies) whatever the route. The supervisor hosts a router that resolves a recipient (principal id, alias, session address or today's local id) to a set of authorized routes, selects one by an explicit rule, persists admission with stable ids before reporting acceptance, hands the message to a transport adapter (local, Iroh peer lane, MESH mailbox), and reports state with per-route evidence. Nothing falls back to another route or trust mode after a failure, and nothing is forwarded between transports automatically. Existing MCP tool names and local RPC names stay; inputs and outputs gain optional fields, so sessions that are already loaded keep working without a reload. Inbound remote messages enter the same local inbox, claim, reply and wake machinery as local ones, carrying the item 7 provenance. The Iroh lane gets its first agent-facing entry. Seven slices, the first of which changes no behavior.

## 2. Goals and non-goals

Goals:

1. One verb set for CLI and MCP over every route, so an agent addresses a recipient without choosing a transport by hand.
2. One place that resolves, authorizes, limits, admits and tracks: the router in the supervisor.
3. Each route keeps its own authority and guarantees (local ACL, peer allowlists and pairings, MESH permissions). The router only adds checks; it never removes one.
4. Honest state: admission, hand-off, receipt, delivery, execution and reply are distinct, and a route that cannot tell says "unknown" instead of guessing.
5. Reuse the item 7 principals, bindings, provenance and reply routes instead of inventing parallel ones.
6. No reload for loaded sessions: names are stable and changes are additive.

Non-goals:

- No content bridge, relaying or implicit forwarding between transports, no automatic fallback to another route, no new enrollment and no weaker authentication (contract item 6).
- No new transport, and no replacement of local IPC or of the harness wake adapters.
- No MESH rooms, groups or history semantics in the unified verbs; those stay `mesh.*` tools.
- No cancellation guarantee. Local cancellation is documented as unsupported and stays that way.
- No coding-task result schema: bodies and results stay free-form text.
- No remote installation or cross-machine rollout (owner priority update of 2026-10-23).

## 3. What exists today (checked)

| Aspect | Local, same host | Iroh peer lane | MESH |
| :--- | :--- | :--- | :--- |
| Agent-facing entry | `triangle-local` commands `send`, `discover`, `sessions`, `status`, `replies`, `consume`, `inbox`, `claim`, `reply`, `ack-wake`; MCP tools `triangle_send_message`, `_list_sessions`, `_list_recipients`, `_get_status`, `_get_replies`, `_consume_reply`, `_list_inbox`, `_claim_message`, `_reply_message`, `_ack_notification`, `_cancel_message` (bound adapter: 11; attached-session children: 10) | **None.** `sendPeerMessage`, `pendingPeerReplies`, `consumePeerReply`, `resolvePeerRecord` and `peerStatus` exist only as supervisor methods (`client-supervisor.mjs`), behind the experimental `peerWakes` gate; no CLI or MCP code calls them | `triangle-mailbox mcp` (stdio MCP proxy): `mesh.agents.find`, `mesh.rooms.direct.open`, `mesh.messages.send`, `mesh.rooms.history`, `mesh.mailbox.list`, `.claim`, `.ack`; helper `transaction-*` commands for workers |
| Recipient addressing | profile name or 64-hex sender id; `session-<64-hex>` for discovered chats | remote Iroh endpoint id (64-hex) that is in the sending profile's `allowedPeers` and has a configured route | agent handle or `agent_<32-hex>` via `mesh.agents.find`, then a direct room |
| Sender identity | signed turn credential (HMAC, supervisor-held) | endpoint id only; no principal | workload JWT with DPoP; origin is server-recorded attribution |
| Admission | journal row written before `{accepted, messageId, requestId, status: queued_local, isDuplicate}` is returned | `outbound` row in the peer journal; application envelope `triangle.peer/1` (`request`, `reply`, `outcome`), payload at most 256 KiB | `mesh.messages.send` appends a room event; idempotency scoped to (sender principal, room, key) |
| Native states | `queued_local`, `executing`, `held`, `completed` (status adds `reason`, a redacted `runtimeError`, `hasLateResult`) | `admitted`, `executing`, `held`, `result`, `reply_failed`, `retry_pending`, `resend_pending`, `reply_received`, `discarded`, `rejected`; engine receipt `received_peer` | event recorded; mailbox delivery rows become `processed` on the recipient's acknowledgement, which is a client assertion, not proof |
| Inbound execution | interactive destinations: inbox, claim and reply by the attached session plus the harness wake adapter; other recipients: the runner dispatcher | the profile's runner command under a concurrency gate (headless); nothing is delivered to an attached chat | worker polling (`deliveryMode: worker`) or interactive MCP (`mcp-interactive`); event-driven wake through watch grants |
| Replies | `list_replies` and `consume_reply` (ownership-checked); client `waitForReply` polls under the caller's deadline | `pendingPeerReplies` (cursor paging) and `consumePeerReply` | recipient replies with `mesh.messages.send` and a deterministic `reply_<32-hex>` key; the sender reads history or its mailbox |
| Limits and guards | per-sender rate limiter, loop tracker with signed parent, per-pair cap of 10 messages per 10 minutes | records cap of 10,000 and the engine's per-peer byte quota; no loop, rate or pair guard found in the drain | server quotas and permission epochs |
| Retention | finished records compacted after 8 days | 8 days of records, 7 days of engine tombstones | 1 year for events, audit records and idempotency tombstones; 30 days for processed delivery rows (ADR 0003, R7-A) |

Gaps against the contract:

1. Three addressing schemes, none of them principal-based, and no alias layer.
2. The Iroh lane has no agent-facing entry and cannot deliver to an attached chat, so "idle conversation wake" (acceptance 3) is not possible on it today.
3. Three state vocabularies and no shared meaning of "delivered".
4. Limits differ: the local guards do not apply to the Iroh lane, so switching route would bypass them.
5. The engine is configured with a relay mode (`default`, `direct-only`, `relay-only`); no observed-path field turned up in its README or source, so "record direct versus relay evidence" probably needs an engine change.
6. Local tool descriptions say "local recipient on this host", which would mislead a model once remote routes exist.
7. Two journals (`local-messaging*.sqlite` and `peer-drain.sqlite`) with no shared index of what was admitted.
8. Nothing expires queued work: the local journal and dispatcher have no age limit on queued messages (only lease expiries and stale wake bindings), and the Iroh drain has no delivery deadline beyond its 8-day record retention cutoff.

### 3.1 What this design takes from item 7

| Item 7 piece | Used here as |
| :--- | :--- |
| Principals (`agent_`, `peer_`) and aliases in the registry | Resolver inputs and outputs (4.2) |
| Bindings: pairings, MESH endpoint registrations, session bindings | The authority that makes a route eligible (4.2, 4.9) |
| `sender_provenance_v1` | Shown on inbound messages and replies; computed by the receiver (4.5, 4.6) |
| Reply routes keyed by remote principal and `request_id` | The only way a reply travels (4.6) |
| Unbound sessions stay local-only | `sender_unbound` for remote sends (4.2) |
| Legacy device-only lanes | Labelled with no principal; delivery only to the owning profile (4.5) |
| MESH registration and online resolve; OS re-authentication for pairing | Prerequisites for the MESH and Iroh adapters, not rebuilt here |

## 4. Design

### 4.1 Shape

```text
CLI / MCP tools (thin; same names)          existing local socket, turn credentials
        |
Supervisor: local messaging server (ACL, limits, loop guard, journal, dispatcher)   [exists]
        |
   Router (proposed): resolver + route table + adapter registry + admission records
        |-- local adapter  (wraps today's journal, dispatcher, inbox, harness wake)
        |-- iroh adapter   (wraps the peer lane; item 7 endpoint bindings)
        `-- mesh adapter   (wraps the helper's MCP proxy; item 7 managed binding)
```

Proposed modules: `unified-router.mjs`, `recipient-resolver.mjs`, `transport-adapter-contract.mjs`, `local-adapter.mjs`, `iroh-adapter.mjs`, `mesh-adapter.mjs`. Clients keep talking only to the supervisor's local socket; none talks to Iroh or MESH directly. The agent-facing entry point stays `triangle-local` and the existing MCP server and tool names (owner decision 3); the installed `bin/` already holds `triangle` (MESH admin), `triangle-client`, `triangle-local` and `triangle-mailbox`, and the hooks and managed Codex block call `triangle-local`. The interactive `triangle-mailbox mcp` tool stays available as the explicit MESH tool for rooms and history; the unified verbs do not replace it.

An adapter implements: `reach(target)`, `send(admittedRecord)`, `poll(since)` for inbound, `status(record)`, `discover(filter)` and `describe()` (maximum payload, reportable states, retention, ordering). `describe()` is how the router knows what a route can and cannot say.

### 4.2 Resolution and route selection

The `to` field accepts these forms, told apart by shape (prefix and length), not by precedence:

1. `session-<64-hex>`: a local discovered chat (installation-scoped, local only).
2. A 64-hex local sender id, or a configured profile name from the local recipient list (today's behavior, unchanged).
3. A principal id: `agent_<32-hex>` or `peer_<32-hex>` (item 7).
4. An alias (petname or MESH handle) that the sender's own registry resolves to exactly one principal.

A name that matches both the local recipient list and the registry is ambiguous and fails as `alias_unresolved`; the first match never wins silently.

An unknown or ambiguous alias fails with `alias_unresolved` and lists the candidate principal ids and labels the sender is authorized to see. Labels never route; only ids do. Resolution yields a target and a **route set**; each route carries `transport`, `trust_mode`, `target` (session, endpoint id, or MESH agent and room), `authority` (the item 7 binding or permission that allows it), `assurance` (item 7 kinds), `reachable` (`yes`, `no` or `unknown`, with evidence and time) and `describe()` data.

Selection rules, applied in order:

| Rule | Behavior |
| :--- | :--- |
| `via` given | Use that transport or fail with `route_unavailable`. Never substitute. |
| Exactly one eligible route | Use it. |
| Target is a session or principal on this host | The local route is chosen; same-host messages never cross a network transport. |
| Several remote routes (for example Iroh and MESH for one managed agent) | Use the owner's stored preference for that principal; with none, fail with `route_ambiguous` and list the routes, with a one-line note that MESH routes expose content to the MESH server. |
| No eligible route | `route_unavailable`, naming what is missing (binding, pairing, permission). |

The owner's preference is a registry field on the principal (`route_preference`, proposed), set by an owner command; it names one transport, never an ordered list, so it cannot act as a fallback chain. Selection happens once, at admission, and is recorded. **There is no fallback.** If the chosen route is down, the message is queued on that route (section 4.3) or the send fails; the caller sees which other routes exist and may send again with `via`, which is a new, explicit send under the same rules. A route preference is never changed by a failure.

A discovered chat that is not bound to a principal (item 7, rule 6) can send on local routes only. Asking it to send on Iroh or MESH fails with `sender_unbound`.

### 4.3 Admission, ids and idempotency

Order of operations for `send`:

1. Authenticate the turn credential (existing), resolve the target, evaluate policy and limits (section 4.9).
2. Validate or generate `messageId` and `requestId` (the existing bounded identifier form, 1 to 256 characters of `[A-Za-z0-9._:-]`).
3. Write the **admission record** in the local journal: ids, sender principal, target, selected route, envelope hash, `deliver_by`, state `admitted`. This commit happens before anything is reported or handed off.
4. Hand off to the adapter. The hand-off is idempotent by `messageId`, so a crash between steps 3 and 4 is repaired at startup by re-handing-off every `admitted` record that has no adapter evidence.
5. Return the custody receipt with the furthest state reached: `{accepted, messageId, requestId, state, status, route, isDuplicate}`.

Rules:

- `messageId` is unique per sender principal across all routes. An exact retry (same ids, same envelope hash, same route) returns the stored record with `isDuplicate: true`. The same `messageId` with a different envelope or a different route fails with `duplicate_id_conflict`; a message is never sent twice on two routes under one id.
- Admission rows and adapter rows are reconciled at startup. A mismatch is shown in `status` as `inconsistent` and is never resolved by re-sending content automatically.
- The local and Iroh adapters queue, because their journals already do. The MESH adapter fails fast with `route_unavailable` when MESH is unreachable in its first cut; whether to add an outbound queue is a later choice, since a hidden queue is the stale-instruction risk below.
- `deliverBy` (proposed, stored as `deliver_by`) bounds how long a message may wait to be delivered. Defaults (owner decision 6): Iroh 24 hours, which survives a night with a sleeping Mac; local none, so the proved same-host behavior does not change unless the owner sets a limit; MESH not applicable. The owner can set or shorten a route's default, and a send can only shorten it further. Expiry applies only to messages not yet delivered: work that is `executing` or `held` is never expired by time. After it passes, the record becomes `expired` and is never delivered. This prevents a stale instruction arriving hours later after a reconnect. The Iroh drain has no delivery deadline of its own beyond its 8-day record retention (checked); whether that retention removes an unacknowledged outbound request at day 8 was not checked.
- Retention follows section 4.11. Missing history is not delivery expiry: without an explicit retained expiry record, preserve native `not_found` / history unavailable. Never fabricate `expired` from compaction.

### 4.4 State model

The caller sees one `state` plus an `evidence` list; every step records when it happened and which component reported it.

| Unified state | Meaning | Local | Iroh | MESH |
| :--- | :--- | :--- | :--- | :--- |
| `admitted` | Persisted by the router; nothing handed off yet | journal row, before dispatch | router record only | router record only |
| `handed_off` | The adapter holds it | `queued_local` | `outbound` row written | `mesh.messages.send` accepted |
| `received` | Destination-side durable custody, with component evidence | same-host journal row; no recipient action implied | engine receipt `received_peer` | not proved by a server-recorded room event alone |
| `delivered` | Recipient retrieval or claim explicitly reported | interactive claim if exposed; a wake or queued inbox alone is insufficient | drain admission alone is insufficient | explicit recipient claim if exposed to sender |
| `executing` | Native execution claim reported; not independent proof the model started | `executing` | `executing` | not reportable |
| `held` | Uncertain execution or a destination problem; owner action needed; never replayed | `held` | `held` | not reportable |
| `completed` | Work finished; a reply may exist | `completed` | `result` | not reportable |
| `replied` | A correlated reply is available | `list_replies` non-empty | `reply_received` | reply event present |
| `failed`, `expired` | Explicit terminal rejection or delivery-deadline expiry | runtime failure remains `held`; expiry requires a future explicit deadline record | preserve recoverable `reply_failed`; do not flatten it into terminal failure | permission or quota denial |

A state that a route cannot report is shown as `unknown` with the reason, and the router never infers it from a later state on another axis. The first state is always `admitted`, so the contract's distinction between admission, delivery, execution and reply is explicit. Existing `status` and `phase` fields stay in the response for compatibility.

### 4.5 Inbound messages and destinations

Every adapter's verified inbound request is admitted into the local journal through one internal call, `admitInbound(origin, envelope)` (proposed), which stores `origin_transport`, `remote_principal`, the remote `request_id` and the item 7 reply route next to the usual fields (additive nullable columns, as earlier features added them). From there the existing dispatcher, inbox, claim, reply and wake machinery applies unchanged.

A remote sender addresses a **principal**, so the receiving supervisor must pick a destination deterministically:

1. If the principal's profile is a headless runner profile, use the runner (today's Iroh behavior).
2. If it has the bound conversation (for example the bound Codex identity), use that.
3. Otherwise apply the principal's **destination rule** (owner decision 7): the owner designates a harness and a workspace, stored with the principal in the item 7 registry (`destination`, proposed). Delivery goes to the one live attached session in that workspace and harness; with none, hold as `no_destination`; with several, hold as `destination_ambiguous`. A rule, not a pinned session id, because session addresses change with every new chat.
4. If the principal has no destination rule and none of the above applies, hold the message with `no_destination`. The router never picks "some" session and never uses the most recently attached one; the owner sees the held message in `status` and sets a rule.

**Mailbox ownership.** The MESH adapter ingests inbound deliveries only for profiles whose `deliveryMode` hands the mailbox to the router (a new value, proposed). Profiles in `worker` or `mcp-interactive` mode are left alone, because two consumers of one mailbox would race on claims. The Iroh runner path is likewise turned off for any profile whose destination is an attached or bound chat.

Provenance (item 7 `sender_provenance_v1`) is attached to the stored record and shown with the message, computed by the receiver and never copied from the payload. Legacy Iroh lanes (`legacy-device-only`) can deliver only to the profile that owns that engine and are labelled as having no principal.

### 4.6 Replies

- On the responding side, a reply travels back along the **reply route** recorded at inbound admission (item 7 section 5: keyed by remote principal and `request_id`, pinning the transport, the remote endpoint or MESH room, and the local session). The responder's `triangle_reply_message` does not choose a route. On the requesting side, the admission record pins the remote principal and the route, and a reply is accepted only from that principal over that route (or an owner-approved failover endpoint), correlated by `request_id` and `in_reply_to`.
- `replies` merges replies for the caller's requests from every adapter. Each carries `route` and `provenance`. Reply text is untrusted data and never becomes infrastructure instructions.
- `consume` stays explicit and ownership-checked. Listing never consumes.
- **Waiting is separate from execution.** `send` returns at admission and never waits for work. `replies` accepts `waitMs` (proposed; default 0, maximum 30 s, owner decision 8) as a bounded long poll under the caller's own deadline. The cap keeps each call well inside harness tool timeouts (Codex documents a 60 s default `tool_timeout_sec`; not checked on this install). Runner and execution budgets (for example the peer drain's 180 s default) are configuration of the destination and are unrelated to how long a caller waits.
- No model-side polling is needed for wake: queued, executing, held and completed are visible in `status`, and harness wake adapters keep their own acknowledgement flow.

### 4.7 Discover

`discover` (and the existing `triangle_list_sessions` and `triangle_list_recipients`) returns **principal-centric entries**: `principal`, an untrusted `label`, `kind` (session, worker, agent, peer), and `routes[]` with `transport`, `reachable`, presence with its evidence, attachment status, assurance and `last_seen`. One principal reachable two ways appears once.

Sources: the local directory (configured recipients and discovered sessions, as today); pairings and registered endpoints (item 7); and MESH `mesh.agents.find`. The MESH source is a network call that tells MESH what the agent is looking for, so it runs only when asked (`via: mesh` or an explicit include flag), never as part of a default listing. Only authorized recipients appear; an unauthorized peer's existence is not disclosed. Visibility never implies reachability, as the existing tool description already says.

### 4.8 Status

Two scopes under the one verb:

- **Message**: `status({messageId})` returns the unified `state`, the `evidence` list, the native phase, `route`, `reason`, a redacted `runtimeError` and `hasLateResult` (existing fields). Only the sender or the recipient principal may read it (`foreign_access_denied`, existing).
- **System** (`status` with no id): per adapter, up or down with the evidence (Iroh engine state, endpoint id, configured relay mode, observed path when the engine reports it; MESH reachability and last successful resolve); queue depths; counts of held, failed, expired and `inconsistent` records; pending replies; and the item 7 identity view. This view is also where `doctor` points.

### 4.9 Policy and limits

Evaluation order for every send, on every route, failing closed at the first refusal: resolve, then authorize (local ACL and sender lists; peer allowlist or pairing; MESH `dm.send` and the recipient's `dm.receive`, preflighted for a fast error but enforced by MESH), then limits, then admit.

- The rate limiter, loop tracker and pair cap move from "local only" to **per (sender principal, target principal) across routes**, so changing route cannot bypass them.
- Remote senders cannot supply a trusted loop depth. The receiving router computes depth from its own journal ancestry (`inReplyTo`) and applies the pair cap to the remote principal.
- Payload limit is the smallest of the route's limit and the local frame limit (Iroh envelope payload 256 KiB, local frame 320 KB); too large fails with `payload_too_large` and names the limit.
- Inbound caps per remote principal bound queue growth; hitting one holds or rejects with a bounded reason code.

### 4.10 Failure semantics

| Situation | Result |
| :--- | :--- |
| Unknown recipient | `not_found`-style `recipient_not_found`; no candidates disclosed beyond authorization |
| Ambiguous alias | `alias_unresolved` with authorized candidates |
| Several remote routes, no preference | `route_ambiguous` with the routes |
| Chosen route down | queued on that route until `deliver_by`, or `route_unavailable` if the route cannot queue (MESH adapter without a queue); never rerouted |
| Unauthorized, stale binding, expired or revoked assertion | `recipient_not_allowed` or the item 7 binding error; fails closed |
| Sender not bound to a principal, remote route | `sender_unbound` |
| Same id, different envelope or route | `duplicate_id_conflict` |
| Exact retry | stored record, `isDuplicate: true`; work is never rerun |
| Uncertain execution | `held`; no automatic replay |
| Supervisor restart | ids and states preserved; `admitted` records re-handed-off; held stays held |
| No destination rule, or none or several live sessions match it | `held` with `no_destination` or `destination_ambiguous` |
| Payload too large | `payload_too_large` |
| Hostile reply text | shown as untrusted data, never executed |

### 4.11 Interface changes, the reload story and retention

| Surface | Change | Reload needed? |
| :--- | :--- | :--- |
| MCP tool names and local RPC names | none | no |
| `send_message` | optional `via`, `deliverBy`; result adds `state`, `route` | no for old callers; a loaded model does not know `via` until it reads it in an error or reloads |
| `list_sessions`, `discover_recipients` | entries add `principal` and `routes[]` | no |
| `get_message_status` | adds `state`, `evidence`, `route` | no |
| `list_replies` | entries add `route`, `provenance`; optional `waitMs` | no |
| Tool descriptions | reworded to say "recipient" instead of "local recipient on this host" | yes, descriptions are fixed when a session starts, so a loaded session keeps the old wording until it restarts |
| `triangle-local` CLI | same commands; `--via`, `--deliver-by`, `--wait` flags | no |

The router also helps loaded sessions without any schema change: error text for `route_ambiguous` and `sender_unbound` tells the model exactly which argument to add or what to ask the owner, and that text arrives in the result.

Retention, stated once for the unified interface: the admission record follows the local journal's 8-day compaction of finished records; the Iroh route adds 7 days of engine tombstones; the MESH route follows MESH's 1-year events and 30-day processed delivery rows. Retention removes evidence; it does not establish delivery-deadline expiry. Until a tombstone contract exists, a missing record remains native `not_found` / history unavailable. Pending local requests, held work and unconsumed replies are not compacted by the finished-record policy.

## 5. Security notes

| Concern | Handling |
| :--- | :--- |
| Router becomes a content bridge | There is no forward or relay verb, and an adapter never writes into another adapter. An agent may send a new message on another route as its own act; the system never does it. |
| Silent route change | No fallback; selection recorded at admission; `route_ambiguous` instead of a default between Iroh and MESH. |
| Stale queued instruction | `deliver_by` expiry (Iroh default 24 hours, local none unless set); `expired` is terminal, and work already executing or held is never expired by time. |
| Discovery leakage | Only authorized recipients are listed; MESH is queried only on request; labels are untrusted display data. |
| Hostile reply or label | Never executed or trusted; provenance comes from the receiver. |
| Loop amplification across transports | Limits keyed per principal pair across routes; receiver-computed depth. |
| Legacy Iroh lane mistaken for a principal | Provenance `legacy-device-only`, no principal, delivery only to the owning profile. |
| Dual-journal drift | Admission record authoritative for "was it admitted"; reconciliation at startup; `inconsistent` is visible and never auto-resent. |
| MESH learns interest from discover or resolve | Documented; MESH discover is explicit. |

## 6. Verification plan

A **conformance suite** runs one scenario matrix against every adapter, using fake transports in CI: admit, hand off, receive, deliver, execute, reply; exact duplicate; conflicting duplicate; restart at each step; offline then reconnect; held; unauthorized; stale binding; oversized; rate and pair caps; foreign status and consume denied; hostile reply text; `deliver_by` expiry. The existing local suites (the 329-test family) must pass unchanged.

| Acceptance (contract) | Evidence |
| :--- | :--- |
| 1. The same CLI and MCP send reaches a local and a remote recipient | Installed-path run: one `send` to a same-host session and one to an Iroh-paired principal, from both Claude and Codex bindings. |
| 2. Codex and Claude discover permitted recipients and retrieve correlated replies | `discover` and `replies` through each binding; provenance shown; local regression suite. |
| 3. Two machines complete request, execution, reply and idle conversation wake over the installed Iroh path, with direct versus relay recorded | Two physical Macs; destination selection to an attached or bound chat (4.5); engine path evidence (needs the engine change in slice R3). |
| 4. Offline queueing, reconnect and restart preserve identity and ids; exact retries do not rerun; uncertain execution stays held | Conformance suite plus a restart test on the installed path. |
| 5. Wrong recipients, stale bindings and unauthorized routes fail closed; reply text is never an instruction | Negative cases in the suite; item 7 binding failures surfaced through the router. |
| 6. Separate internet connections before any NAT claim | Two networks, recorded separately from same-Wi-Fi relay evidence. |

Installed-path evidence is required for slices that change a route; nothing here is claimed from tests alone.

## 7. Implementation slices

| Slice | Delivers | Depends on (item 7) | Rollout and rollback |
| :--- | :--- | :--- | :--- |
| R0 | State vocabulary, adapter contract and the conformance harness with the local adapter; no behavior change | none | tests only |
| R1 | Router with the local adapter and the resolver; principal and alias resolution for local targets; `route` fields in results; `deliverBy` unset for local, so no behavior change | Slice 1a and 1b (registry, migration) | default on for local; flag off restores today's path |
| R2 | `admitInbound`, origin and provenance columns, destination selection | Slice 2 (local provenance, reply routes) | additive columns; flag |
| R3 | Iroh adapter: expose `send`, `replies`, `status` through the router; inbound delivery to attached or bound chats through the destination rule; `deliverBy` default of 24 hours; `waitMs` on `replies`; engine reports observed path | Slice 3a (and 3b if shared endpoints) | opt-in per lane; remote install needs the owner's priority change |
| R4 | Aggregated `discover` and system `status`, including the identity view | Slice 1a | read-only |
| R5 | MESH adapter over the helper's MCP proxy; mailbox ingestion for router-owned profiles; MESH discover on request | Slices 4 and 5 | opt-in; MESH changes already in item 7 |
| R6 | Two-machine and two-network acceptance, docs and runbook | all above | evidence only |

Release mechanics (project experience): the router and adapters are new modules reachable from the entry points, so they bump the runtime manifest (to v13) and need the Swift and helper release path (`WorkerLauncher.swift`, the worker install script, a helper rebuild). Owner decision 4 chose one release train for R1 to R5, which avoids repeated bumps; the alternative, keeping the router inside existing modules to stay on supervisor-runtime-only installs, was declined.

## 8. Owner decisions

**Decision log**

- 2026-10-25, Decision 1: owner chose A. A principal with several remote routes needs a stored owner preference (one transport), otherwise the send fails with `route_ambiguous`. Same-host targets use the local route; there is no fallback.
- 2026-10-25, Decision 2: owner chose A. Verified inbound Iroh and MESH messages enter the local inbox, claim, reply and wake path and reach the bound chat or a designated session; an ambiguous destination holds the message.
- 2026-10-25, Decision 4: owner chose A. The router and adapters ship as new modules in one release train with a single manifest bump (v13) and the Swift and helper release path.
- 2026-10-25, Decision 5: owner chose A. MESH is queried by `discover` only on request.
- 2026-10-25, Decision 3: owner chose A. The entry point stays `triangle-local` with the existing MCP names; an alias can come later.
- 2026-10-25, Decision 6: owner chose A. `deliverBy` defaults to 24 hours on Iroh and to none on local, owner-settable per route, and a send can only shorten it; MESH fails fast.
- 2026-10-25, Decision 7: owner chose A. Principal-addressed messages follow a harness-and-workspace destination rule stored in the item 7 registry; none or several matching live sessions hold the message.
- 2026-10-25, Decision 8: owner chose A. `replies` takes an opt-in `waitMs`, default 0, maximum 30 seconds.
- All eight decisions are settled.

1. **Route choice when a principal has several remote routes.** Options: **A (chosen)**, fail with `route_ambiguous` unless the owner stored a preference (MESH routes expose content to the server); B, a built-in order (local, then Iroh, then MESH); C, always require `via`.
2. **Inbound remote messages for interactive profiles.** Options: **A (chosen)**, deliver them into the local inbox, claim, reply and wake machinery (required for acceptance 3); B, keep Iroh runner-only in the first release.
3. **Entry point.** Options: **A (chosen)**, keep `triangle-local` and the existing MCP names (no reload, no new binary); B, a `triangle-msg` alias in the installed bin; C, fold into the MESH admin `triangle` CLI (needs a MESH session, so not usable in serverless mode).
4. **Release shape.** Options: **A (chosen)**, new router modules and one manifest bump for R1 to R5; B, fit the router into existing modules and keep supervisor-runtime-only installs.
5. **MESH in default discover.** Options: **A (chosen)**, only on request; B, always included.
6. **`deliverBy` defaults.** Options: **A (chosen)**, Iroh 24 hours and local none, owner-settable per route, a send can only shorten; B, 24 hours on both (queued local work would start expiring); C, no default expiry; D, 1 hour.
7. **Destination for principal-addressed messages.** Options: **A (chosen)**, a harness-and-workspace rule that resolves to the one live attached session, otherwise hold; B, the most recently attached session; C, pin one session id (stale after every new chat).
8. **Waiting.** Options: **A (chosen)**, opt-in `waitMs` with default 0 and a 30-second cap; B, no waiting, polling only; C, a 120-second cap (longer than Codex's documented default tool timeout).

## 9. Unverified or open

- Whether MESH exposes a delivery state to the sender beyond "event recorded" (ADR 0004 says acknowledgement is a recipient assertion), and how a MESH reply names the request it answers; the MESH adapter's `delivered`, `executing` and `replied` mapping depends on both.
- Whether the supervisor can drive the helper's MCP proxy or `transaction-*` commands for sending, without new credentials.
- Whether the Iroh drain's 8-day retention removes an unacknowledged outbound request, and whether the engine can report the observed path.
- Which command sets the `destination` rule (it lives in the item 7 registry; the setting command is not designed yet).
- The `peerWakes` lane is still behind an experimental gate; acceptance 3 depends on that gate being retired or accepted.
- Item 7 names its proposed errors `ERR_*`; this document uses the existing lowercase code style (`duplicate_id_conflict`, `route_unavailable`). Implementation should settle on the lowercase style.

## 10. Coverage of the contract

| Contract item | Section |
| :--- | :--- |
| Resolve a stable recipient identity to an authorized route; explicit ambiguity | 4.2 |
| Persist admission and ids before acceptance; dedupe across reconnects and retries; retention; distinguish admission, delivery, execution and reply | 4.3, 4.4, 4.11 |
| Bind replies to the authenticated original sender and conversation | 4.6 (item 7 reply routes) |
| Preserve permissions, allowlists, fencing, conservative uncertain execution, no replay | 4.9, 4.10 |
| Separate waiting from execution budgets; queued, executing, held, completed without model polling | 4.6, 4.8 |
| MESH authority composable; no content bridge, fallback, enrollment or weaker authentication | 2, 4.2, 5 |
| Installed supervisor and supported entries end to end | 4.1, 6, 7 |
| Acceptance 1 to 6 | 6 |

### R0 implementation checkpoint (2026-10-25)

`transport-adapter-contract.mjs` and `local-adapter.mjs` are library-only modules, not imported by production entrypoints or added to the installed runtime manifest. The adapter wraps the existing authenticated local control client; it creates no identities, grants, admissions table, router, background loop or wake path. The caller owns the client and supplies a current credential for each operation.

R0 requires caller-owned stable message and request IDs before sending. Native errors and retry IDs remain with the caller; no automatic send retry or fallback occurs. Remote `via`, delivery deadlines and nonzero waits fail explicitly before authentication or IPC. Discovery keeps visibility metadata separate from current send eligibility. `poll` and `replies` are non-consuming, and `consume` remains explicit. Claims and replies continue through the existing native interface; this is not yet the unified agent-facing tool.

State projection preserves native status and phase. `queued_local` means same-host durable `received`, not recipient delivery; `executing` reports a native claim; `completed` does not establish a correlated reply. Wake acceptance never establishes delivery. Full router timestamps and evidence histories remain later-slice work.

Verification uses the production SQLite journal, real local control server/client and real dispatcher with a controlled test runner. These are isolated conformance tests, not installed-runtime or live-model acceptance. R1 remains dependent on the identity design and its own rollout gates.
