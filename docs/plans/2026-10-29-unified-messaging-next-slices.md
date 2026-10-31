# Unified messaging: current-state review and next implementation slices

Status: reviewed implementation plan, 2026-10-29, revised the same day after an
independent source review (its refinements are folded into U1 and the evidence
section). U1 implementation was started on the owner's go-ahead in chat; this
document itself authorizes no identity mapping, delivery permission, network route,
merge or installation. Baseline: client main `741ff27` (#147), with atomic runner
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
   `res.recipients`. Both MCP adapters then reconstruct `{recipients}`, and the CLI
   `discover` command does the same. The agent therefore loses metadata that the
   server already supplied. No test asserts `entries` at any level (the Public DTO
   test in `r1-integration-v13.test.mjs` is commented as covering it but asserts
   only the array), so the server projection is itself unverified. Fix
   propagation; do not introduce a second registry or new authority.
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

- Add a structured discovery client method, `discoverRecipientDetails`, that
  returns `{recipients, entries?}`. Preserve the existing array-returning
  `discoverRecipients` for current library callers (the R0 local adapter builds
  its send-eligibility set from it); do not silently change its return type or
  attach hidden properties to an array.
- Project `entries` in the client through an allowlist: pass them on only as
  exactly one `{id, principal}` per listed recipient, in the order of `recipients`,
  with `principal` an `agent_` id or null. Ignore other fields and entries for
  unlisted ids, and leave `entries` absent when the host sent none or its list is
  missing, repeated or malformed for any listed recipient. A future server field or
  a malformed frame must not widen what the agent sees, and a listed id never has a
  silently missing entry.
- Pass the structured result through CLI `discover` and both MCP adapter paths
  (`local-messaging-mcp-adapter.mjs` for the bound Codex conversation,
  `claude-session-mcp-child.mjs` for attached Claude and Codex chats). Grok has no
  discover operation, so U1 changes nothing for Grok. Keep all existing output
  fields and tool names. If the router is disabled or an older host omits
  `entries`, absence means unavailable metadata, not an invented binding.
- Document `principal: null` as "none known to this host now". The server also
  returns null while the registry snapshot is `absent` or `unreadable`, so null is
  not proof that a recipient has no identity. A state that tells these apart
  belongs to U2 ("keep unknown as unknown"), not to this slice.
- Preserve server-side sender/credential filtering. Emit only authorized entries;
  do not join a global inventory into an agent-visible result.
- Share one description for `triangle_list_recipients` and one for
  `triangle_send_message` (tool and argument text) across the bound adapter and
  attached chats, defined in `local-messaging-protocol.mjs` beside
  `STATUS_TOOL_DESCRIPTION`. The `to` text names the accepted forms: an exact id
  from discovery, never a label; an `agent_` principal when discovery lists one and
  it names exactly one local recipient (a principal bound to several recipients is
  refused as `recipient_ambiguous`, even when the caller may message only one of
  them, so the id is the fallback); `peer_` addresses are not supported. Property
  types already agree across the three surfaces. Extend the parity assertions to
  types, `additionalProperties` and descriptions of the declared schemas, with
  explicit exception lists that fail once an exception stops being true. Do not
  tighten previously accepted inputs casually; reject or normalize consistently at
  the trusted server boundary.
- Keep deliberate exceptions: bound host status versus own-session status,
  lifecycle attach, unsupported bound cancellation, stable retry-ID requirements.
  This does not grant new approval bypasses. The owner's standing Claude review
  authorization is separate from delivery ACLs and harness tool permissions.

Primary files: `local-messaging-client.mjs`, `local-messaging-cli.mjs`,
`local-messaging-mcp-adapter.mjs`, `claude-session-mcp-child.mjs` and the existing
description constants in `local-messaging-protocol.mjs`. Server change only if a
real projection defect is demonstrated; no journal or identity schema migration
is expected. No new module is needed (shared text lives beside
`STATUS_TOOL_DESCRIPTION`), so the installer file list is unchanged; account for
the runtime bundle closure if one is added later.

Pass criteria:

- A server-level test asserts the `entries` projection itself (router enabled:
  one `{id, principal}` per authorized recipient; router disabled: no `entries`).
- Authenticated socket-to-client-to-MCP/CLI tests preserve exact authorized
  `id`/`principal` values and the original recipients array.
- Client tests with a hostile or older host show the allowlist: extra fields never
  reach the agent, entries for unlisted ids are ignored, and a missing, repeated or
  malformed entry for a listed recipient makes `entries` unavailable.
- Server-level tests also cover an unreadable registry (null principals), a
  credential scoped to one recipient (raw `entries` narrowed with `recipients`) and
  a principal bound to two recipients (listed for both; send by that principal is
  `recipient_ambiguous`).
- An unauthorized recipient never appears in either representation. Missing,
  disabled or unreadable registry cases do not fabricate principals or break
  legacy IDs. Labels remain display-only.
- Type/required-field/unknown-property parity assertions pass with an explicit
  exception list. They compare the declared schemas; the discovery handlers are
  exercised over real sockets on every surface. Unknown-key enforcement stays
  schema-level (the bound handlers ignore extra keys) because tightening accepted
  inputs is out of scope here.
- Existing resolver, router, registry-snapshot, adapter-conformance, status and
  tool-parity suites (the six-file set named in the evidence section), and the
  retry/correlation, exact-grant and tool suites, pass.
- Installed read-only discovery checks agree across the applicable surfaces.
  Loaded tool descriptions require normal harness reload; do not claim additive
  result compatibility means already-loaded schemas/descriptions refresh live.

Status, 2026-10-29: implemented on branch `claude/u1-discovery-metadata`
(`discoverRecipientDetails`, CLI `discover`, both MCP adapters, shared descriptions in
`local-messaging-protocol.mjs`, extended parity test, runbook note). An independent
model review (read-only Opus; not a human or Codex review) found no path that shows an
agent an id or principal it is not authorized for. Its one medium finding (a principal
bound to several recipients cannot replace the id in a send) and its low and nit
findings were fixed: the shared tool text and runbook say so, the client now passes
`entries` on only as one well-formed entry per listed recipient, the parity exceptions
are per argument, and tests now cover an unreadable registry, a scoped credential and
the shared principal. Accepted gap: the attached Codex surface shares the child's
`runSessionTool` and is exercised only through the Claude child. Source tests: the
full agent-worker suite passes (1254 tests, 3 skipped, 0 failures) and the root
runner-contract and packaged-installer tests pass (11). Not done: merge, installed
read-only discovery checks, and the harness reload that refreshes loaded tool
descriptions.

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

Status, 2026-10-30: implemented on branch `claude/u2-route-explanations`, based on U1's
head `257ae70` (PR #148, still open), pushed as draft PR #149. Review of
`sessions`, `discover`, `local_status`/`session_status` and the owner identity view
together: agents get one router-computed explanation per entry on both `sessions` rows
and `discover` entries (`route`, `principal`, `principalState`, `send.permitted`,
`send.addressKinds`), reusing the existing presence, attachment, capability and delivery
fields and the server-side filtering. The owner identity view (`identity_view_v1`,
binding ids, authority origins, registry sequence) stays owner-only and is not projected.
All new fields exist only while principal routing is enabled, so router-off output is
byte-identical to U1 (checked against `257ae70` by the reviewer). `principalState`
(`bound`, `unbound`, `unknown`) resolves the U1 open point that `null` could mean an
unreadable registry; `addressKinds` answers the U1 review's ambiguous-principal finding
per entry without naming other candidates (it reveals no more than the
`recipient_ambiguous` a principal send already returns), so the tool text no longer
carries that caveat. `send.permitted` follows the send gate (owner policy, then
credential scope). For the bound conversation and attached chats, whose scope is issued
from the live ACL, a policy-allowed chat that is down reads permitted with its own
attachment evidence; fixed-scope readers (paired Claude, Grok) are judged by their scope.
A reachable route this caller cannot use reads `not_permitted`, never ready. Discovery-only
rows read `permitted: false`. `triangle-local status` gains an `identity` block explaining
disabled reply identity and unbound chats (read-only; pin admission, principal mapping,
grants and enrolment are untouched). `STATUS_SEMANTICS` defines status once (MCP without
a message ID: own session view; owner CLI: host view; with a message ID: that message's
delivery observations), pinned across surfaces by a real-host test. Tests were written
first and failed for the expected reasons; twelve mutants of the new behaviour were each
caught. An independent read-only Opus review (a model review, not a human or Codex review)
found no blocker, high or authority leak, and one medium (the exemption for a down chat
also applied to fixed-scope readers: fixed), four low and nits (all fixed or documented).
Accepted limits: the bound Codex thread's own chat row reads `permitted` although that
address never receives; the R0 wrapper's `sendEligible` and `send.permitted` answer
different questions; `sessions` rows are passed through by the client as before (only
`entries` are allowlisted); the paired Claude can be granted chats it can never message
(older behaviour, worth a separate setup-time refusal). Source tests: the complete
agent-worker suite passes (1291 tests, 3 skipped, 0 failures; U1 had 1254) and the root
runner-contract and packaged-installer tests pass (11). No new module, so the installer file list is unchanged. Not
done: merge, installed read-only discovery checks, and the harness reload that refreshes
loaded tool descriptions.

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

Status, 2026-10-30: delivered as `2026-10-30-identity-destination-design-delta.md`
(design only, not owner-approved; an independent model review, not a human or Codex review,
found one high, six medium, thirteen low and seven nit issues, all addressed). It lists nine
places where shipped code differs from the October text, the identifiers to preserve, the
session-to-principal, revocation, inbound delivery and alias rules to adopt, what the review and
reply authorization does not cover, the prerequisites for an Iroh or MESH adapter, and six open
owner decisions with recommendations (D1 to D6). The ones that matter most: storage lets a rebind
swap a profile's principal silently (D2); storage lets one principal be bound to several profiles,
and only the migrate planner refuses it, within one inventory (D3); and the terminal-plus-plan-id
gate does not stop a same-user agent from approving its own mapping (D5).

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
`/private/tmp/unified-interface-plan-baseline.log`. That set omitted
`router-registry-snapshot.test.mjs` (10 tests, the registry snapshot behind
`principal`); the independent review re-ran all six files (status, tool-parity,
recipient-resolver, router-registry-snapshot, transport-adapter-conformance,
unified-router) at 51 of 51 passing, and that six-file set is the U1 gate. This is
a review baseline, not acceptance of the proposed changes. The shared interface and identity designs,
R1/R2 acceptance notes and current source were inspected; no new Reason source
comparison, server audit, remote test or live message was performed for this plan.

Relevant sources: `2026-10-25-unified-messaging-interface-design.md`,
`2026-10-25-r1-router-resolver-implementation-plan.md`,
`2026-10-25-identity-reconciliation-design.md`,
`../handoffs/2026-10-26-r1-installed-acceptance.md`,
`../handoffs/2026-10-26-r2-installed-disabled.md`, current local messaging runbook,
and the implementation files named above.


## Release checkpoint — 2026-10-30

PRs #148 (U1), #149 (U2) and #150 (U3) merged in order; main reached
`d16ad24`. U1/U2 bundles were installed on the Mini and every artifact hash
verified. Read-only CLI acceptance preserved metadata for 8 authorized recipients
and route explanations for 46 session entries. All 83 original message records,
79 replies and one reply pin remained unchanged; old queued and held work was
not processed. Reply pin admission stayed disabled. Record:
`~/Library/Application Support/The Triangle/releases/pr148-150-install-verification.json`.
Existing harness chats still need a restart to refresh loaded tool descriptions;
that reload was not performed on owner chats. The independent focused review
passed 101 tests; this does not replace installed MCP acceptance after reload.

U3 decisions D1–D6 were approved with the Codex review corrections: a plain bind
must protect authority origin as well as principal, and stronger approval also
covers revocation. This supersedes the historical “not owner-approved” and open
decision status above. Remote work remains deferred.

The next source slice implements D2 only: refuse principal/authority changes on
plain `bind`, including a revoked record, while retaining same-identity renewal.
No move command, schema migration, registry rewrite, new binding or installation
is included. D3 uniqueness and D5 approval mechanisms remain separate work.


### D3 source follow-up

The D3 patch refuses a second active profile for one principal at the registry's
locked mutation boundary, including reactivation of a revoked record. The mapping
planner also checks active bindings already recorded for other profiles, covering
an identity that moved between inventories. A revoked binding does not reserve a
principal. Existing duplicate v1 registries remain readable and can be resolved
through revocation; this patch neither migrates nor repairs them automatically.
Historical duplicate-directory tests explicitly seed legacy files, rather than
using the new writer to create a forbidden state. No live registry is changed.


### Installed D2/D3 and next D5 gate — 2026-10-30

PRs #151 and #152 are merged, main `77fcf89`. Installed supervisor/worker
artifacts were hash-verified, and the installed registry module passed disposable
identity-change/duplicate refusal, unchanged-on-refusal, renewal and revoked-owner
release checks. Live registry/audit, policy and backlog stayed unchanged.

The older packaged owner CLI initially lacked the planner. A CLI-only package
update to `0.2.0-identity.1` closed that gap: all 151 package files verified, and
the real installed `triangle identity migrate` command passed disposable-inventory
planning and recorded-principal conflict checks without confirmation or writes.
Existing helpers and running service were preserved. See the two installed
verification records named in `2026-10-30-owner-approval-next-slice.md`.

The next D5 work is the provider/operation contract and interactive feasibility,
not remote rollout. The macOS non-interactive capability probe compiled and
reported policy available with normal OS access; no authentication was attempted.
Linux and Windows providers remain unimplemented. No claim of fresh owner
approval, same-user tamper resistance or an accepted interactive prompt follows
from this probe. Existing harness chats still need their separate reload check.
