# Headless engagement enablement (portable Mac)

Portable automatic engagement on any Mac: watch → kick → claim → reply → ack,
without manual claimer cleanup and without dual claimers or silent redelivery.

## Prerequisites

1. Client tip includes merged [PR #70](https://github.com/hannaoker/triangle-client/pull/70)
   (admit-only kick, headless install-watch anchor, two-field claim resume) **and**
   this enablement change (manifest **v7** + rebuilt helper/client).
2. Helper + client **rebuilt and installed together** with the same signing mode:
   `./scripts/install-macos-mailbox-helper.sh --install-client`
   Staging Node tip alone without a rebuilt `triangle-mailbox` /
   `triangle-client` will fail closed (`invalidManifest`) once
   `prepare-runtime` writes a v7 bundle.
3. Target MESH origin has **watch + lease reclaim** enabled (verify before
   enablement on a new Mac).
4. Grok webhook stays retired — do not re-arm it.
5. Login Keychain unlocked; Codex runtime auth present (`TRIANGLE_CODEX_HOME`,
   `CODEX_CLI`).

### Compatibility notes

- **Manifest v7** adds `claimer-advisory-lock.mjs` and
  `open-transaction-recovery.mjs`. Existing **v6** manifests keep working on
  older helpers (exact-set match unchanged).
- **Do not** run `prepare-runtime` / enablement from this tip on a Mac that
  cannot rebuild Swift yet — leave that machine on its current installed
  helper + v6 runtime.
- **Antigravity / pilot-mac**: this path is Codex/Cursor-ACP headless
  engagement. Skip enablement there; leave the installed v6 antigravity
  runtime untouched until a matching helper release is available.

## Fresh Mac (MacBook) runbook

1. Install helper + client (PR70+ tip).
2. Verify MESH origin watch/reclaim posture for that deployment.
3. Enroll profiles (`triangle-client agent add` / enable as needed).
4. Plan, then apply:

```sh
./scripts/macos/enable-headless-engagement.sh plan
./scripts/macos/enable-headless-engagement.sh apply
```

Optional wideners (not default):

```sh
./scripts/macos/enable-headless-engagement.sh plan \
  --include-interactive <profile> \
  --migrate-from-grok <profile>
```

5. Doctor green:

```sh
./scripts/triangle-client-service.sh doctor
# or
node ./scripts/triangle-headless-engagement-doctor.mjs --json
```

6. Probe DM → reply.

Missing runtime auth fails doctor/enable clearly (no silent empty drain).

Doctor is a read-only, complete inventory. It enumerates every
`client/instances/*.json` registry row (enabled and disabled) and reconciles each
with the binding its lane needs: `headless-runtime-binding.json` (Codex
headless), `cursor-acp-runtime-binding.json` (Cursor ACP), or
`worker-runtime/<adapter>.manifest.json` (worker mode). Per profile it reports
runtime, delivery mode, enabled state, enrollment, owner/generation, effective
poll/watch selection, backlog, and last claim/reply/ack evidence. A field the
local journal does not record prints `unavailable`. Retry/expiry,
capabilities, live watch/grant health, and supervisor admission currently print
`unavailable`. An enabled profile with no binding, unverified enrollment, or an
invalid registry row exits 2. An enabled profile with no progress evidence exits 1.
Disabled profiles are listed and never started. Credential files are checked for
existence only, and message bodies are never read into output.

Outstanding work is judged separately from historical progress. For every lane
(Codex headless, Cursor ACP, worker) doctor reads the profile's helper
`mailbox-transactions/open.json` and applies one policy with the
`maxOpenTxnAgeMs` budget (default 15 minutes): five or more recorded failures
(the helper's own "stuck" threshold) or an over-budget transaction with any
failure exits 2; an over-budget transaction without failures, a transaction
with failures inside the budget, or one without a readable `createdAt` exits 1.
An old `lastClaimAt`/`lastReplyAt`/`lastAckAt` never excuses an open
transaction, and an idle profile with no open transaction is never reported
stalled however old its last completed work is.

Registry profile names follow the persisted Swift `ProfileName` contract: up to
64 UTF-8 bytes, no `/`, `\`, or control/format characters, case, dots, and
underscores preserved. Doctor never renames an identity.

Doctor validates persisted records the way the Swift helper decodes them, so it
never reports healthy for a record the supervisor would reject: registry rows
(exact keys, known `runtimeAdapter`/`deliveryMode`, a row without
`deliveryMode` decodes as `worker`, no stray files), enrollment records (exact
keys, valid origin/agent/handle, same profile as the file), Codex/Cursor ACP
bindings (exact keys, `installationId` equal to `client/installation.json`,
standardized symlink-free state roots, every row an enabled lane member),
worker manifests (structure, release environment, content-addressed bundle;
artifact hashes stay with the launcher and print `integrity=not_verified`), and
open transactions (instance, claim/reply ids, state invariants), and the App
Server binding (readable `app-server-ws.token`, `adapterVersion` "1",
`enabled`, ws/wss endpoint, non-empty room scope/server identity/thread, and
installation and agent ids that match; the agent id is checked against the
verified enrollment record because doctor does not read the keychain). A
violation is a hard fault. App Server watch membership follows the binding's
`instanceId`, as `WatchGrantService` does. Both claimer families holding
advisory locks for one profile is a hard `dual_claimer_conflict` on every lane.
Journals larger than the scan limit report their full count, and activity
comes from the newest rows by mtime (`scanLimited=true`). An enabled `grok-bot`
profile stays `lane_unsupported`: Swift still prepares the wake, but the Node
supervisor rejects any `grokBotWake`.

## Defaults

| Selected by default | Not default |
| --- | --- |
| Enabled Codex on `headless-app-server` | `mcp-interactive` (needs `--include-interactive`) |
| Enabled Codex on `event-driven` | grok-bot (needs `--migrate-from-grok`) |

Webhook binding is left disabled. Unrelated `headless-runtime-binding.json`
profiles are preserved. Dedicated drain LaunchAgents must be folded first via
`cutover-headless-supervisor.sh`.

## Apply semantics

Idempotent: `apply` twice is a no-op success when already healthy.
Sequence: plan → installation config lock → quiesce claimers → stage
`0600`/`0700` files → `set-runtime` (guarded grok-bot→codex) →
`set-delivery-mode` → merge binding → restart supervisor → wait ready
generation → rollback staged config if activation fails.

Concurrent applies fail closed on the flock (`exit 75`).

## Doctor (progress, not presence)

Reports separately: supervisor generation, watch/grant health, last accepted
kick, last claim/reply/ack, pending backlog age, open transaction state,
claimer advisory ownership. Exit non-zero on hard blockers. Never deletes open
transactions. Admit-only kicks with stale drain show as degraded.

## Mini crash drills

After ownership locking + open-txn recovery are installed:

1. Concurrent stale-lock startup (leftover JSON, no manual `rm`) — only one owner.
2. Codex vs Cursor ACP contention — fail closed, no dual claimers.
3. Kill mid claim / reply / ack — resume or visible quarantine; never a second unsolicited reply.
4. Watch expiry/outage — poll timer fallback still drains.
5. Enable interrupt/rollback — failed activation restores prior binding.
6. Multiple + receipt-only messages — receipts settle without model turns.

## CLI

```sh
triangle-client agent set-runtime --profile <p> --runtime codex
triangle-client agent set-delivery-mode --profile <p> --mode headless-app-server
```

`set-runtime` allows idempotent same-adapter and guarded `grok-bot` → `codex`
only.
