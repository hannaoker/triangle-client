# Claude session adapter — execution slice

## Motivation and context

PR #107 is merged. The Mini runs the merged v10 source, its fresh Antigravity
smoke reply reached the working conversation automatically, and wake is enabled.
The next approved harness-plan milestone is Claude Code bidirectional messaging.
The existing Codex integration secret must not become a shared Claude identity.

Claude Code 2.1.307 is installed. An isolated session-scoped MCP probe confirmed
presence of inherited session ID, messaging socket and token; a harmless model
turn returned CLAUDE_PROBE_OK. This does not establish idle push. No user settings
were modified and no session registry/token files were searched.

## Target shape

One existing Triangle supervisor owns identity, ACLs and durable messages.
A session-local MCP child holds only its own Claude socket credential and scoped
Triangle credential. It delivers fixed notification hints into its own session;
Claude retrieves free-form messages through scoped tools and explicitly replies.
The supervisor never receives Claude's socket token. No extra message daemon,
new model-side reply polling, or development-channel bypass is introduced.

The socket interface is unsupported and pinned to the tested version. Missing,
changed or foreign session capability means pull-only degradation. Socket write
acceptance does not prove conversation execution or acknowledgment.

## Owner-selected surface

The owner selected **Claude Code in the desktop app** as the first acceptance
surface. CLI results below are preliminary transport evidence only. A separate
new desktop scratch conversation is used; existing chats/settings stay intact.

## Work and acceptance gates

1. Isolated capability/idle socket canary: correlate initial idle-ready response,
   later injected turn and exact acknowledgment; keep stdin session open and use
   only the MCP child's inherited credential. No other conversation inspection.
2. TDD delivery primitive: require expected session ID, explicit version pin,
   private owned canonical socket; refuse foreign/change/symlink. Fixed metadata
   template, bounded transport, conservative uncertainty and no implicit retry.
3. Independent primitive review and focused tests; do not label mock success as
   a live supported adapter.
4. Only after the live primitive gate: design scoped session registration and
   credentials, canonical unread obligation subscription and acknowledgment,
   lifecycle/rebind fencing and explicit owner pairing. Existing Codex capability
   is never copied. Write integration tests before shared changes.
5. Versioned bundle closure/setup, real bidirectional Codex/Claude canaries,
   packaging checks and review before installation. Preserve existing settings.

The first implementation owns only the delivery module and its tests. Shared
broker/identity changes, production installation and MESH bridging do not follow
from primitive success alone. No claim of Claude parity until step 5 passes.

## Stage 2 review checkpoint — 2026-10-22

Stage 1 broker/core passed 168 focused tests in the prior verification slice.
It remains source-only and uncommitted; those tests are not Desktop MCP proof.
The installed `bin/triangle-local` entry is the working delegation path. The
top-level `triangle` enrollment CLI and native tool discovery do not establish
whether this separate installed entry exists.

The Stage 2 proposal is not approved for implementation yet. First establish
Gate 0 in a disposable project with a project `.mcp.json`: actual Desktop Code
MCP launch, inherited own-session environment, metadata-only tool response and
clean stdio lifecycle. A shell child receiving these variables is insufficient.
The probe must never dump `process.env`, token values, socket paths or arbitrary
error strings. Do not read or change global Claude configuration. Missing MCP
environment or project support is an unresolved capability gate, not a pass.

Before Stage 2 coding, revise the proposal to define a distinct Claude identity
and durable wake binding. Include inbound queued interactive messages in Claude
obligations; current Codex obligations cover replies and held outgoing work.
Keep authentication, generation fencing, one outstanding hint and uncertainty
state in supervisor-owned broker/journal operations; the session child must not
open SQLite or reuse Codex's wake binding. Preserve all Codex wake behavior.
Socket write acceptance remains separate from model execution and wake ack.
No automatic retry may replay a mutating operation after an unknown outcome.

At that checkpoint only the scratch launch fixture was delegated. Adapter
implementation, installation, packaging and bidirectional acceptance remained
subsequent gates.

### Subsequent source gate

The reviewed Stage 2 adapter and v11 bundle changes are now implemented and
verified. See `../reviews/2026-10-22-claude-session-stage2-review.md`: final package
suite 906 passed, 0 failed, 3 skipped; Swift launcher 11 passed; real staged MCP
entry and legacy installation gate 18 passed. Initial review findings were fixed
and independently re-reviewed. No production install or full live bidirectional
acceptance is implied. The next operational gate is explicit owner pairing of
the actual Claude session, activation through the existing supervisor, then
correlated incoming/outgoing messages and durable acknowledgments.

## Baseline sources

- Existing approved M3: docs/plans/2026-10-21-harness-wake-adapters-plan.md
- Reason protocol reference: https://github.com/reason-machines/reason-network/blob/main/src/agent.rs
- Official channels restrictions: https://code.claude.com/docs/en/channels

Protocol facts are consulted without copying Reason implementation code.
