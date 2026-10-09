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
