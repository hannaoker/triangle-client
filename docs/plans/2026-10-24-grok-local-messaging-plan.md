# Grok Bot local messaging investigation and implementation plan

Date: 2026-10-24. Status: implementation proposal; no Grok binding, permission, wake or test message activated.

## Decision

Support all owner-authorized Grok bots on this Mini as distinct local interactive participants in Triangle's existing messaging service; this integration is not specific to Bob. Start with its local shell calling a narrowly bound Triangle CLI. Reuse the current durable inbox, claims, replies, credentials, ACL and notification machinery. Automatic idle wake is a separate capability, not a prerequisite for useful local messaging. Do not use a second Reason daemon, remote MCP tunnel, or local-to-MESH content bridge for the local path.

Owner-provided assumption (2026-10-24): Grok bots participating in this integration can use their command tool on this Mac Mini. Use that assumption for implementation; do not block on a separate execution-location probe. This is an assumption, not newly measured evidence. Conversation identity and idle wake remain separate checks. Local transport also does not mean messages processed by Grok's model stay on-device.

## Verified evidence and limits

- Installed `/Applications/Grok Bot.app`: bundle `com.anysphere.sand`, version 0.75.5; supports URL schemes grokbot/sand, which alone prove no messaging or wake API.
- Read-only app inspection: Bob exists, MESH Bob Wake Drain is paused, Computer tab says Computer is asleep. No command was sent and no computer awakened. The execution computer was not measured in this inspection; the owner subsequently authorized assuming it is this Mini.
- Cursor's current Work with Grok Bot documentation describes local shell execution under the existing approval policy. This establishes a product capability, not this account's enabled setting or this bot's execution destination.
- Reason's network page documents hosted MCP and routine wake. Issue #85 describes webhook-triggered inbox retrieval. This does not establish a local session injection API. Borrow the small messaging surface and honest delivery capabilities.
- Cached client `origin/main` is `2db1d3495f5c14c997bf1b0b8688a23f9ab6efd2` (PR #113). `triangle-client/` main is 141 commits behind its tracking ref and dirty: do not implement there.
- Investigated active worktree `worktrees/installed-local-messaging`, HEAD `1a33e61630c7d4c23a18d0f6d46062675377909b`, has existing uncommitted documentation. It is not a descendant of cached #113 merge. Do not assume equal histories or overwrite its work. Its symmetric-session plan records #113 installed, manifest v11, 80 artifacts, and a passed Claude-to-idle-Codex canary. This is recorded prior acceptance, not re-executed evidence.
- Installed triangle-local help includes sessions, send, inbox, claim, reply, replies, consume, ack-wake and session setup. Those commands currently obtain a configured identity; simply invoking the existing wrapper from Grok risks speaking as Codex.
- Source restrictions requiring real work: host config has closed keys and a single legacy interactive integration; discovery/journal currently hardcode harness claude and claude-session binding prefixes. sessionAddress currently hashes installation/workspace/session without a harness namespace. A generic Grok MCP child is not already available.
- Terminal GitHub access failed DNS resolution, and process inventory was denied. Remote HEAD and loaded process ownership were not verified. Before implementation, refresh remote refs through an available authorized connection and reconcile installed manifest hashes with the chosen source commit.

## Compatibility contract

Preserve existing local protocol v1 and MESH v1 authorities. Local messages remain in the existing local journal; do not copy their bodies into MESH. Existing configured Antigravity recipients remain worker targets, not automatically discovered GUI sessions. Codex remains its real desktop conversation owner; Claude retains its own session child and delivery adapter. Existing sender IDs, address hashes, credentials, worker profiles and journal rows must continue working.

For Grok, use distinct harness-specific identities, never the registered Bob/Codex profile or one shared identity for every Grok bot. Prefer a provider-supplied stable bot ID for the durable participant address. Bind the current conversation/session separately, and record run IDs only for execution correlation. If only a reliable session ID is available, support session-scoped participation, analogous to Claude; do not invent a durable bot ID from a display name.

Proposed identity contract (new Grok records only):

| Available provider context | Durable participant key | Active binding |
| --- | --- | --- |
| Bot ID plus conversation/session ID | installation + grok + bot + bot ID | conversation/session ID + Triangle binding ID + generation |
| Bot ID only | installation + grok + bot + bot ID | explicit owner-paired context; no automatic conversation-targeted wake claim |
| Session ID only | installation + grok + session + session ID | same session + Triangle binding ID + generation |
| Neither reliably supplied | explicit per-bot owner-paired alias | private capability binding; no automatic bot recognition |

Hash a versioned, unambiguous encoding of these fields into the public address. Normalize only according to the provider's identifier contract; do not assume Grok IDs are UUIDs or case-insensitive. Existing Claude hashes and addresses stay unchanged. A bot retaining its ID keeps its durable identity when its active session changes; fence the old binding and outstanding credentials. Distinct conversations of the same bot must have explicit routing: use separate conversation endpoints or a clearly selected default, never implicit last-session-wins. Discovering a new session must not silently move pending messages or active claims.

Identifiers are not authentication. The broker must also verify an owner-issued capability, exact participant/context binding and generation. Prefer IDs supplied by the supported tool-launch context; a model-provided ID argument alone is not evidence of originating bot identity. Record whether metadata is inherited, per-call or explicitly paired, including behavior across ordinary chats and routines. Same-user processes remain within the local trust boundary; do not claim hostile-bot isolation when they share access to local capability files. If reliable context is absent, use the explicit alias fallback without pretending automatic discovery.

Reuse directional exact-ID grants. Discovery does not grant messaging. Directory capabilities must separate send, pull inbox and idle wake: a valid pull-only Grok participant can receive queued mail without pretending it wakes automatically. Offline/local-execution-denied is visible, never a silent worker substitution.

Keep stable message/request/reply/claim operation IDs on retries, exclusive claims and generation fencing. Retrieving is not consuming; accepted notification is not model execution; ack-wake is not a reply. Never create replies merely acknowledging replies. Retain shared local/MESH submission arbitration for existing threads and bounded loop/rate protection.

## Stage 0: controlled capability probe

1. Sync and pin merged client/server refs, installed bundle/version, loaded supervisor ownership and current recipient IDs. Read current applicable workspace instructions. Reconcile active branches before editing owned files.
2. Assume Bob's command tool executes on this Mini, as directed by the owner. Check CLI availability and approval behavior during the first controlled integration canary; no separate execution-location proof is a prerequisite. Do not dump environment, accounts or credential files.
3. Probe supported shell/tool context for bot ID, conversation/session ID and run ID, logging presence and pseudonymous hashes only. Compare two bots, two conversations of one bot, a fresh run, a routine run and restart/resume. Determine stability, provenance, availability per invocation and whether IDs survive context changes. Select the identity mode from the table above. Do not reverse-engineer connector registration or scrape app auth storage.
4. Inspect supported local MCP configuration only if the product exposes it. Cursor editor MCP setup is not proof that Grok Bot supports stdio MCP. Prefer shell when it works; remote connectors are out of local scope.
5. Record idle-wake options from current documented provider interfaces. No existing-session continue API has been proven. Do not reactivate the retired webhook as a probe.

Exit: proceed to Stage 1 using the owner-provided local execution assumption. If an integration canary contradicts it, report the concrete failure and reassess without creating a tunnel. Only session identity => session-scoped mode; no reliable provider identity => explicit per-bot alias mode, supporting multiple separately paired bots. Missing idle wake => pull-only remains supported.

## Stage 1: local participant and CLI

Create `grok-local-session.mjs` and `grok-local-session.test.mjs` for pairing, credential exchange and lifecycle. Extend `local-messaging-cli.mjs` with proposed commands `setup-grok`, `grok` and `disable-grok`; these names are proposals, not existing commands.

Setup issues a separate private integration binding for each participating Grok bot or session, plus an owner-visible opaque alias. A verified provider bot/session context selects its exact binding; an explicit alias selects the fallback binding. Shared CLI invocation must never default to Bob or the last active Grok bot. The `grok` entry exchanges that binding for short-lived credentials via the current local broker, then dispatches the existing sessions/send/inbox/claim/reply/replies/consume/status operations. Never read or fall back to the desktop Codex integration. Avoid secrets in arguments, tool responses, prompts and logs. Use stdin or private body files for message text. Reuse current size limits and bounded request deadlines; offer a bounded wait for a correlated response only if useful, without a permanent polling process.

Extend `local-messaging-host.mjs`, `local-messaging-interactive-session.mjs`, `local-messaging-server.mjs` and the MCP adapter only where needed to register multiple explicit interactive bindings. Keep old configuration readable and strict validation for new fields. Extract shared operation handling from the Claude child only when required, keeping Claude socket ownership and version checks in its adapter.

Update `local-messaging-journal.mjs` with an additive participant/harness representation. Preserve legacy claude-session rows and address computation. New Grok addresses use a distinct versioned harness namespace; do not change sessionAddress for existing sessions. Replace Claude-specific directory labeling with actual stored harness metadata. Document transactional migration and old-bundle rollback restrictions if schema changes are incompatible.

Tests: wrong alias/secret/generation; disabled binding; foreign claims; no Codex identity fallback; two bots cannot accidentally share an alias or identity; same bot across runs retains its address; same bot across conversations follows explicit routing; session-only context changes fence the previous binding; ID collisions across harnesses and case-sensitive provider IDs; routine/main-chat context mismatch; exact retry after transport loss; request/reply correlation; ACL denial; queued pull-only recipient; restart persistence; revoke during an active claim without releasing execution custody. Test failures through supported CLI entry points as well as broker units.

Exit: Grok can initiate a request to an exact allowed Antigravity worker/Codex/Claude session and retrieve the correlated reply. The same peers can queue work for Grok; Grok explicitly checks, claims and replies. No idle-wake claim yet.

## Stage 2: optional automatic wake

Prefer a documented bot-specific local delivery primitive if Stage 0 finds one. Integrate it behind the current notifier, with probe/notify capability reporting, existing durable wake obligations and one owner per conversation. No UI automation as a production transport, no app private database injection, and no Grok CLI process presented as the existing Grok Bot conversation.

If only routine webhooks are supported, evaluate a NEW bot-specific binding independently. The routine must run the Grok-bound local CLI on this Mini and retrieve locally; the webhook carries only a minimal wake hint, no message body or Triangle credentials. This uses a remote control signal but does not require a remote content store. Prove the routine's actual command destination and bot identity, including across app sleep/restart. Preserve existing local approvals. If this cannot be proven, retain pull-only mode.

Old endpoint prohibition remains. New route needs bounded backoff, provider-disabled/quota diagnostics, coalescing, host allowlisting/no redirects, protected webhook secrets, an uncertainty state after ambiguous acceptance and no blind resend after crash. Distinguish a routine run from continuation of the visible conversation. Verify correlation and visibility rather than counting HTTP 2xx as success.

## Stage 3: installed acceptance and rollout

- Update `scripts/triangle-worker-install.py`, exact bundle closure tests and runtime manifest according to the current packaging contract. Do not alter old immutable manifest allowlists. Build from the synchronized reviewed base in an isolated clean worktree.
- Run focused new tests plus interactive broker, CLI, session attachment/discovery, Codex inbox, notifier, host/dispatcher and bundle-closure suites. Run current MESH/local arbitration regressions when touched. No server deployment should be necessary for Stage 1.
- Install an immutable candidate into the existing service only after artifact verification. Record original service/config for rollback; do not reset accounts or re-enroll Bob.
- Canary matrix: Grok to Antigravity and back; Grok to bound Codex and back; Grok to Claude and back; peers initiating to Grok; exact retry; wrong recipient; revoked generation; supervisor restart; local execution denied/asleep. For Stage 2 separately prove idle and busy behavior, burst coalescing and repeated idle success.
- Record message/request IDs, generation, actual conversation/run, result and consume/wake acknowledgments without bodies or credentials. Distinguish local worker reachability from GUI session reachability.
- Roll back by disabling only the Grok binding and notifier, fencing grants and restoring the prior immutable bundle/config. Preserve queued messages and active claim custody; do not delete the journal.

## Scope and recommendation

First PR: Stage 0 identity/capability evidence plus Stage 1 multi-bot local participation, using the owner-provided assumption that participating Grok bots execute commands on this Mini. Second PR: optional wake only after the provider primitive passes. Multi-bot participation is in scope for Stage 1. Automatic registration/discovery is conditional on verified provider metadata and owner policy; explicit per-bot pairing remains supported. Hosted MCP stays separate. This revises the October 21 hosted-only assumption without changing the local/MESH privacy boundary.

## Sources

- https://cursor.com/docs/grok-bot/work
- https://github.com/reason-machines/reason-network/issues/85
- https://reasonmachines.com/network
- ../plans/2026-10-23-symmetric-local-session-messaging.md
- ../reviews/2026-10-23-codex-local-inbox-acceptance.md
- ../reviews/2026-10-23-local-session-surfaces.md
- ../../packages/agent-worker/src/local-messaging-{cli,host,interactive-session,journal,protocol}.mjs
- ../../packages/agent-worker/src/claude-session-mcp-child.mjs

## Installed-source identity discovery — 2026-10-24

Read-only inspection of Grok Bot 0.75.5 found conditional per-execution injection of CURSOR_CONVERSATION_ID and CURSOR_REQUEST_ID in the local daemon shell executor, including foreground/background forwarding. No dedicated bot-ID injection was found. Prefer probing this concrete conversation-context candidate before designing explicit aliases. Conversation values are URI-encoded, percent-to-underscore transformed and truncated to 200 characters, so do not assume a raw, reversible or collision-free ID. No live bot invocation has yet verified backend field population, cross-bot distinctness, restart stability or routine/main-chat correspondence. Treat it as version-pinned source evidence, not proven reliability. See ../reviews/2026-10-24-grok-shell-identity-investigation.md for evidence and the acceptance matrix.

### Live format observation — 2026-10-24

Bob reported three local shell probes over two turns: CURSOR_CONVERSATION_ID is a 36-character lowercase UUID v4, stable across all three; CURSOR_REQUEST_ID is also UUID v4, stable across two shell calls within one turn and changed in the next turn. The conversation hash independently matches the historical Bob grokAgentId. For these UUIDs no encoding/truncation occurs. Prefer this environment context for owner-paired Grok identity; retain authentication and do not use the per-turn request ID as the sole per-message idempotency key. Cross-bot, restart and routine reliability still need live proof. See the investigation ledger for hashes and exact evidence limits.
