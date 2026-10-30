# Unified messaging: current-state review and next implementation slices

Status: reviewed implementation plan, 2026-10-29. Planning only; no new runtime,
identity mapping, delivery permission, network route or installation is authorized
by this document. Baseline: client main `741ff27` (#147), with atomic runner
completion #146 installed on the Mini. This supplements the October 25 unified
interface and identity designs; it supersedes their implementation-status claims
where explicitly noted below, not their recorded owner decisions.

## Motivation and target

Agents should discover an address, send a free-form task, inspect its status and
receive a correlated reply through one stable Triangle interface. They should not
need to know which local harness receives it or guess which opaque identifier is
an agent, session or endpoint. Triangle owns connectivity, custody, identities,
resume and correlation. The requesting agent verifies the result; a rigid coding
result schema is outside this plan.

Preserve the working local product first. The eventual shape remains:

```text
Codex / Claude / other enabled harness
        -> existing Triangle CLI or MCP verbs
        -> authenticated supervisor + resolver + route selection
        -> local delivery | explicitly enabled Iroh | explicitly enabled MESH
        -> original sender's pinned/correlated reply path
```

This is one public contract over distinct authorities and delivery guarantees,
not one merged identity or a transparent content bridge. No automatic fallback,
server enrollment, permission expansion, newest-session substitution or cloud
copy of local content. Cross-machine implementation/installation remains deferred
by the owner's latest priority. Harness capabilities remain different: Grok is
pull-only; an Antigravity worker execution is not a push into an arbitrary
Antigravity desktop conversation.

## Verified baseline

| Area | Current implementation and evidence | Remaining limit |
| --- | --- | --- |
| Shared local verbs | Existing bound Codex and attached Codex/Claude MCP tools; CLI and Grok commands use the local control service | Schema/description parity is incomplete; do not invent another messaging CLI |
| R0 | `transport-adapter-contract.mjs`, `local-adapter.mjs`, conformance tests exist | Local adapter is a library wrapper; production router does not dispatch through a generic multi-transport adapter registry |
| R1 | Production server constructs `createUnifiedRouter`, resolves `agent_` principals to configured local profiles, decorates receipts/status; installed R1 acceptance records a real principal roundtrip | Resolver rejects `peer_` forms; aliases and remote routing are not implemented |
| Identity foundation | Inventory, registry, explicit profile mapping and identity view modules exist | Existing mappings are local observations, not fresh server attestation; local session addresses are not automatically global principals |
| R2 local subset | Attached-chat provenance, reply pins and retry/restart handling implemented; acceptance documented | Installed `reply-identity.json` is disabled. Bound sender and worker profiles are legacy/unpinned. Remote inbound admission and principal destination policy remain unfinished |
| Permissions | Exact sender-to-chat grants shipped in #139; discovery remains visibility-only | Never infer authority from a directory row or a human label |
| Status / recovery | #140/#141 delivery explanations and own-session status; #143 offline owner reconciliation | Do not rebuild these features or equate a claim with observed model progress |
| Completion / restart | #146 atomic successful runner reply+completion; installed fixed-token roundtrip 43.751 s, one reply retained after reload; #147 startup budget 30 s, measured default restart 23.092 s | Source crash injection is not a live process-crash acceptance claim; one reply is not proof of universally exactly-once execution |
| Iroh | Supervisor exposes peer send/replies/status methods behind the experimental lane gate | No invocation of those methods from the inspected local server/CLI; not available through the unified agent tools |
| MESH | Separate mailbox/helper/server path remains distinct | No production unified MESH adapter established by this review; server behavior not freshly audited here |

Machine records: application-root `releases/pr146-install-verification.json` and
`releases/pr147-readiness-verification.json`. Current protected backlog is 14
pending replies, 2 held tasks and 1 queued request. Those are not test fixtures.

## Review findings and design corrections

1. **Recipient metadata is lost at the client boundary.** In
   `local-messaging-server.mjs`, `discover_recipients` returns the legacy
   `recipients` array plus additive `entries` containing `id` and `principal` when
   routing is enabled. `local-messaging-client.mjs:discoverRecipients` returns only
   `res.recipients`. Both MCP adapters then reconstruct `{recipients}`. The agent
   therefore loses metadata that the server already supplied. Fix propagation;
   do not introduce a second registry or new authority.
2. **Contract parity tests have a deliberate blind spot.**
   `local-messaging-tool-parity.test.mjs` compares names, property names and
   required fields, but explicitly excludes argument types, most descriptions
   and `additionalProperties`. The send tool descriptions already differ between
   the bound and attached adapters. This is a maintenance gap, not evidence of
   an authorization exploit. Share definitions where practical and test the
   observable contract, retaining documented surface-specific exceptions.
3. **The original milestone labels are stale.** The October 25 design still
   describes R1/R2 foundations as future. R1 shipped; R2 is a tested local subset,
   disabled for new pin admission. The later R1 plan explicitly superseded the
   original single-release-train decision: local R1 shipped separately, remote
   slices come later. Do not recreate R1 or claim full R2 completion.
4. **“Add an adapter” is insufficient for remote delivery.** Identity proof,
   sender/recipient binding, destination selection, loop/rate limits, deadlines,
   durable handoff and reply custody must precede remote activation. The current
   router is a local resolver/decorator, not evidence these remote guarantees
   already exist. A separate generic admission journal is not needed for the
   local follow-up; evaluate it only when implementing a real remote handoff.
5. **Read-only aggregation and identity binding are separate.** Showing an
   existing principal and its local route is safe within existing visibility;
   assigning that principal to a chat or exporting local content is not an
   incidental discovery change. Preserve those explicit owner decisions.

## Implementation plan

### U1 — Preserve discovery metadata and align the existing interface (next PR)

Outcome: an agent gets the useful identity metadata already available, with the
same semantics on the bound MCP, attached Codex/Claude MCP and owner CLI.

- Add a structured discovery client method/result that retains `recipients` and
  `entries`. Preserve the existing array-returning `discoverRecipients` for
  current library callers; do not silently change its return type or attach
  hidden properties to an array.
- Pass the structured result through CLI `discover`, both MCP adapter paths and
  Grok's equivalent path where it uses this operation. Keep all existing output
  fields and tool names. If the router is disabled or an older host omits
  `entries`, absence means unavailable metadata, not an invented binding.
- Preserve server-side sender/credential filtering. Emit only authorized entries;
  do not join a global inventory into an agent-visible result.
- Align shared discovery/send descriptions and argument schemas. Extend parity
  assertions to meaningful types, bounds and unknown-property policy, after
  documenting existing differences. Do not tighten previously accepted inputs
  casually; reject or normalize consistently at the trusted server boundary.
- Keep deliberate exceptions: bound host status versus own-session status,
  lifecycle attach, unsupported bound cancellation, stable retry-ID requirements.
  This does not grant new approval bypasses. The owner's standing Claude review
  authorization is separate from delivery ACLs and harness tool permissions.

Primary files: `local-messaging-client.mjs`, `local-messaging-cli.mjs`,
`local-messaging-mcp-adapter.mjs`, `claude-session-mcp-child.mjs`, relevant Grok
client path and existing protocol/description constants. Server change only if a
real projection defect is demonstrated; no journal or identity schema migration
is expected. Avoid a new module unless sharing definitions materially reduces
maintenance; account for the runtime bundle closure if one is added.

Pass criteria:

- Authenticated socket-to-client-to-MCP/CLI tests preserve exact authorized
  `id`/`principal` values and the original recipients array.
- An unauthorized recipient never appears in either representation. Missing,
  disabled or unreadable registry cases do not fabricate principals or break
  legacy IDs. Labels remain display-only.
- Type/required-field/unknown-property parity assertions pass with an explicit
  exception list; exercise actual handlers, not snapshots alone.
- Existing resolver, status, retry/correlation, exact-grant and tool suites pass.
- Installed read-only discovery checks agree across the applicable surfaces.
  Loaded tool descriptions require normal harness reload; do not claim additive
  result compatibility means already-loaded schemas/descriptions refresh live.

### U2 — Coherent local route and reachability explanations (second PR)

Outcome: discovery explains who a visible entry is, whether this caller may send,
what delivery path exists, and what is missing, without making the caller join
opaque lists manually.

- Review `sessions`, `discover` and owner identity/status projections together.
  Reuse existing delivery/presence/attachment explanations and server filtering.
  Keep unknown as unknown; configured workers need not have session-style
  reachability booleans.
- Add only missing additive fields: local route, existing principal or null,
  permitted-address kind, and capability/attachment evidence where authoritative.
  Do not publish owner-only inventory, secrets, binding tokens or raw process
  details. A session row's visibility is not delivery permission.
- Define status semantics once: no message ID gives the caller's own session on
  MCP, while CLI owner status stays host-wide; a message ID gives that message's
  delivery observations. Preserve #141.
- Add an owner-facing explanation for disabled reply identity and unbound chats.
  Do not enable pin admission, map principals or create grants in this slice.

Pass criteria: duplicate labels remain separate exact addresses; online but
unattached reports its real attachment limit; unauthorized entries are filtered;
local principal lookup and legacy/profile/session addressing keep working. The
read-only path must not enroll identities, create messages, trigger wakes or
change configuration. This is the local portion of old R4, not remote aggregation.

### U3 — Close the identity/destination design before remote adapters

Design/review first, separate from U1/U2. Inventory actual registry and binding
schemas; preserve existing IDs. Specify explicit session-to-principal authority,
revocation/generation rules, and who owns principal-addressed inbound delivery.
Keep the recorded destination policy: exactly one matching authorized live
session, otherwise hold; never pick the latest session. First use exact addresses
and labels; aliases may follow as an explicit registry extension rather than a
prerequisite for local usability.

The current review/reply standing authorization must not become permission for
principal binding, peer pairing, enrollment or remote content copying. Any permanent
R2 activation is a separately scoped owner decision with fresh installed evidence.

Deliverable: a short schema/authority delta against the October 25 identity design,
not a rewrite of its cryptographic and rotation proposals. No remote rollout.

### Deferred — Iroh, MESH and cross-machine acceptance

Retain the original designs as backlog, with prerequisites reopened against fresh
source before implementation:

- Iroh: explicitly approved peer identity binding, unified send/reply/status,
  conservative inbound destination, existing guard parity, expiry before first
  delivery, durable adapter handoff/idempotency and truthful path evidence.
- MESH: verify current helper/server APIs, workload-key custody, per-request proofs,
  mailbox ownership and reply correlation. An enrolled profile is not permission
  to copy another local chat's content to MESH. No implicit local-to-cloud bridge.
- Remote routes need explicit selection/preference, no fallback, unchanged trust
  modes, original authenticated reply destination and separate custody evidence.
- Two-host and separate-network proof is future acceptance, not a claim made by
  local tests or the installed same-device canary.

## Execution and release

Implement U1 first, one owner and one PR for shared client/MCP files. U2 follows
only after U1's result shape is stable. U3 can be reviewed as design work but
must not expand the U1 patch. Keep the current local production path; do not wire
through the R0 wrapper merely for architectural symmetry.

For U1/U2: focused behavioral checks, independent review when authority projection
changes, complete affected package checks, then source merge and installed
acceptance as distinct steps. Validate bundle manifests/import closure and the
frozen wrapper if touched. Do not assume a manifest version from a historical
plan; determine the actual compatibility change from the patch. Back up existing
runtime/configuration before install; keep old queued/held work untouched. A
read-only projection should not require a new live coding task. If delivery
behavior changes, use a fresh exact-ID owner-authorized canary and consume only
its reply. Source tests never establish a live provider or installed tool result.

## Evidence and boundaries

Fresh source review at `741ff27`; 41 existing resolver/router, adapter conformance,
tool-parity and status tests passed. Log:
`/private/tmp/unified-interface-plan-baseline.log`. This is a review baseline,
not acceptance of the proposed changes. The shared interface and identity designs,
R1/R2 acceptance notes and current source were inspected; no new Reason source
comparison, server audit, remote test or live message was performed for this plan.

Relevant sources: `2026-10-25-unified-messaging-interface-design.md`,
`2026-10-25-r1-router-resolver-implementation-plan.md`,
`2026-10-25-identity-reconciliation-design.md`,
`../handoffs/2026-10-26-r1-installed-acceptance.md`,
`../handoffs/2026-10-26-r2-installed-disabled.md`, current local messaging runbook,
and the implementation files named above.
