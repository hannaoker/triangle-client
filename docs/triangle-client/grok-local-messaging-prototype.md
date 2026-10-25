# Grok Bot pull-only local messaging prototype

2026-10-24. Draft prototype with passed live two-Grok source-host acceptance.
The reviewed candidate is now installed on the Mini's existing supervisor for
bounded acceptance; Grok-to-Codex automatic receiver wake has passed. Full installed
results and remaining boundaries are tracked in
`docs/reviews/2026-10-24-pr117-installed-acceptance.md`.
Base: client main `5b6c5c896eeb3e95a82cd2c3f32360e3710e52a4` (#116).

## Motivation and boundary

A Grok Bot with permission to execute commands on the owner's computer can use
Triangle's existing local service. It must not inherit the desktop Codex identity
just because it invokes the shared CLI. This prototype adds separately paired
participants to the existing supervisor, broker, ACL and journal. It introduces
no server deployment, second daemon, hosted MCP connection or MESH content bridge.
Message text remains free-form; the transport manages identity and delivery.

This is pull-only: another agent can queue a request even with no Grok CLI process
running. Grok checks its inbox on its next explicit command. Queued means stored,
not that the model has seen or executed it. No webhook or idle wake is implemented.
Local transport does not keep model processing on-device.

## Identity and permissions

- Pair each owner-selected conversation separately. The provider context candidate
  is `CURSOR_CONVERSATION_ID`, as observed in Grok Bot 0.75.5. Only the observed
  lowercase UUID v4 format is accepted in this prototype. Other formats fail
  closed; encoded/truncated IDs are not decoded or guessed.
- A versioned hash of the owner installation's desktop identity and the context
  hash produces a distinct Grok address. No Claude address calculation changes.
  The raw provider context is not saved. `CURSOR_REQUEST_ID` is not used for
  message identity: multiple messages in one turn need different operation IDs.
- A context selects a private owner-issued pairing; it does not authenticate by
  itself. A short-lived grant is exchanged for each CLI invocation. Context,
  capability, binding and generation are checked. There is no desktop fallback.
- If provider context is absent, setup creates an explicit-alias pairing, and
  every runtime call must select that alias. A context-bound pairing still
  requires its matching environment context even when an alias is supplied.
- Same-user processes with access to the capability files are one trust boundary.
  This is not isolation against hostile bots sharing the same macOS account.
- `--recipient` grants outbound requests; `--sender` grants inbound requests.
  Both take exact addresses, never display names. No implicit all-bot grants.
  Replies to an already-claimed request do not require a new reverse request grant.
- Grok-to-desktop initiation also requires the desktop's existing `setup-inbox`
  receiver policy. Grok-to-attached-Claude routing requires workspace messaging
  and exact session grants. Pairing updates that workspace policy's ceiling,
  while per-Grok ACL checks still restrict individual sessions in both directions.
- New pairings and grant edits require service restart. `disable-grok` immediately
  revokes the binding and fences issued credentials without restarting the host.
  Re-enable and grant-update UX are deferred; do not hand-edit active capabilities.

## Source CLI usage

Use an isolated test configuration until this candidate is reviewed and installed.
The commands below describe usage; the implementation tests use disposable roots.

```bash
node packages/agent-worker/src/local-messaging-cli.mjs setup-grok \
  --config /absolute/private/test/local.json \
  --alias researcher --context-hash OWNER_VERIFIED_CONVERSATION_SHA256 \
  --recipient EXACT_PEER_ADDRESS --sender EXACT_PEER_ADDRESS
```

The owner can use a hash captured by a metadata-only probe instead of a raw ID.
`--conversation-id` remains an alternative; the two options cannot be combined.
A context hash is only a pairing selector, never a substitute for runtime launch
context or the private capability.

Setup returns the public sender ID, alias, identity mode and restart requirement;
it never returns the capability. Pairing files are private (0600 in a 0700 directory).
Do not pass credentials in arguments or prompts. Do not set conversation context
from an incoming peer message. Provider context must come from the bot's own shell
launch, or the owner must explicitly choose alias mode at pairing time.

After the candidate service starts with that configuration, inside the paired
Grok conversation's own local command tool:

```bash
node packages/agent-worker/src/local-messaging-cli.mjs grok sessions --config CONFIG
node packages/agent-worker/src/local-messaging-cli.mjs grok send \
  --config CONFIG --to EXACT_PEER_ADDRESS \
  --message-id STABLE_MESSAGE_ID --request-id STABLE_REQUEST_ID < request.txt
node packages/agent-worker/src/local-messaging-cli.mjs grok replies \
  --config CONFIG --request-id STABLE_REQUEST_ID
node packages/agent-worker/src/local-messaging-cli.mjs grok consume \
  --config CONFIG --message-id EXACT_REPLY_ID
node packages/agent-worker/src/local-messaging-cli.mjs grok inbox --config CONFIG
node packages/agent-worker/src/local-messaging-cli.mjs grok claim \
  --config CONFIG --message-id EXACT_INCOMING_ID --claim-id STABLE_CLAIM_ID \
  --claim-file /absolute/private/claim.json
node packages/agent-worker/src/local-messaging-cli.mjs grok reply \
  --config CONFIG --message-id EXACT_INCOMING_ID --reply-id STABLE_REPLY_ID \
  --claim-file /absolute/private/claim.json < reply.txt
```

`--text-file` is an alternative to stdin. `--text` is intentionally unavailable
on the Grok surface. Runtime supports status, sessions, send, inbox, claim, reply,
replies and consume. Explicit-alias mode adds `--alias researcher` to each call.
Claim tokens go directly to the private file, never stdout. Claim-file reuse for
another operation and symlinks are refused before claiming the new message.

Keep the same message/request IDs and body when retrying an ambiguous send.
Explicit authorization denials return `rejected`; transport uncertainty returns
`send_outcome_unknown`. Neither means the receiver executed. Replies are retrieved
by correlation and consumed separately. Never reply merely to acknowledge a reply.

## Restart, long tasks and rollback

Enabled pairings remain queueable between commands and after supervisor restart;
there is no attachment heartbeat for a pull-only Grok participant. Directory
metadata reports `queueable: true`, `pullInbox: true`, `wakeCapable: false`, with
unknown presence rather than a false online claim.

The existing interactive claim lease is at most one hour. Credential refresh on a
new CLI call does not renew that lease. There is no new long-task lease renewal in
this prototype. If the host restarts during an active claim, existing journal
recovery holds it as `crash_recovery`; it does not run it again, transfer it, or
accept the old reply as success. Disabling a pairing blocks further authenticated
operations but does not cancel the model's external work. Uncertain held work
requires owner reconciliation; a safe product recovery command is still a gate.

No database migration is needed. Manifest v12 adds only `grok-local-session.mjs`;
installer, Swift launcher and doctor recognize v12, and historical exact artifact
sets remain unchanged. These packaging checks do not mean a release was installed.

To roll back an activated candidate: disable its Grok bindings; restore the prior
immutable runtime and a prior config without the new `grok` key. Keep the journal
and private binding/claim files for reconciliation. Older strict config readers
reject the new key. Previously authorized workspace policy additions alone cannot
revive Grok once its bindings are disabled or absent from the running host.

## Evidence and remaining acceptance

Automated tests use real CLI subprocesses and real local sockets/journal with a
fake reasoning runner. They cover separate identities, queued/restarted delivery,
worker response correlation and consumption, retries, per-direction permissions,
attached Claude routing, desktop receiver opt-in, context mismatch, capability
and generation denial, immediate revocation, private claims and uncertain custody.
Existing local messaging, attachment, notifier and bundle tests run alongside them.

Live Bob ↔ Tech Lead acceptance passed using their actual local command tools,
the candidate CLI and an isolated source host. Both initiated, claimed, replied,
retrieved and consumed correlated canaries; queued delivery survived host restart,
and a wrong-context call was rejected. The fixture worker was never invoked.
See [the acceptance record](../reviews/2026-10-24-pr117-grok-source-host-acceptance.md).
The source host is stopped and its pairings revoked.

Not yet proven: the installed supervisor path, live Grok-to-Codex/Claude traffic,
metadata after app restart, routines, background shells, approval denial or app
sleep. The UUID context contract remains version-pinned installed-source evidence,
not an official provider API guarantee. Re-probe on upgrade. Wake is a later PR.

Next: independent review, then a reviewed packaged candidate on the existing
supervisor with explicit rollback and installed acceptance.

## Prototype verification record

- 360/360 Node tests passed serially across Grok, local messaging, session
  discovery/attachments, Claude adapters, Codex inbox, supervisor, inventory and
  packaging contracts. The existing `/private/var/tmp` fixture required the test
  process to run outside the workspace sandbox.
- 11/11 native WorkerLauncher tests passed, including v8 through v12 standalone
  supervisor resolution and corrupted-bundle rejection. SwiftPM used
  `--disable-sandbox` for its build subprocess in this execution environment;
  no product worker sandbox setting was changed.
- All 31 historical exact artifact sets (worker v3–v11, supervisor v8–v11) match
  the base installer byte-for-byte as lists. v12 adds only the new Grok module.
- `git diff --check` passes. Automated checks and the separate live source-host result do not establish
  production installation acceptance.
