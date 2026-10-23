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

## Baseline sources

- Existing approved M3: docs/plans/2026-10-21-harness-wake-adapters-plan.md
- Reason protocol reference: https://github.com/reason-machines/reason-network/blob/main/src/agent.rs
- Official channels restrictions: https://code.claude.com/docs/en/channels

Protocol facts are consulted without copying Reason implementation code.
