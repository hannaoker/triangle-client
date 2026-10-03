# Triangle finding dispositions

Tracking sheet for [`codebase_review.md`](./codebase_review.md) under [`triangle_implementation_plan.md`](./triangle_implementation_plan.md).

Updated: 2026-10-03 (merge stack; Bob webhook path removed). Status values: `confirmed` | `rejected` | `deferred` | `fixed` | `removed`.

## High priority

| ID | Status | Reproducer / notes | Fix PR | Test | Rollout |
| --- | --- | --- | --- | --- | --- |
| S1 | fixed (PR1) | Recovery bumps epochs/keys but not `agents.token_hash`; old `mesh_` still auths | [#8](https://github.com/hannaoker/the-triangle/pull/8) | recovery then old bearer 401 | Inventory workload migration first |
| S2 | fixed (PR1) | Compat bearer stays after `identity_state → active`; recover-credential can remint | [#8](https://github.com/hannaoker/the-triangle/pull/8) | active workload cannot remint/use legacy | Keep approved legacy-only path |
| S3 | fixed (PR1) | Heartbeat UPDATE omits `status != disabled` | [#8](https://github.com/hannaoker/the-triangle/pull/8) | disabled agent heartbeat fails closed | — |
| S4 | fixed (PR10) | Invite expiry + one-time accept + creator cannot accept; optional intended subject/email audited only. Distinct Auth0 accounts ≠ separate humans. | [#14](https://github.com/hannaoker/the-triangle/pull/14) | controller-api + registration-conformance | Schema-bound invitee CAS + human assurance remain policy |
| S5 | fixed (PR2) | Unauth challenge mint + no purge | [#9](https://github.com/hannaoker/the-triangle/pull/9) | bounded issuance + batch cleanup | Tune limits from traffic |
| M1 | fixed (PR7) | Bridge append skips `mailbox_wake_events` | [#11](https://github.com/hannaoker/the-triangle/pull/11) | bridged msg wakes held poll | — |
| M2 | fixed (PR5) | NULL `lease_expires_at` stuck under enforcement | [#10](https://github.com/hannaoker/the-triangle/pull/10) | backfill migration idempotent | Enforce only after zero NULL |
| M3 | fixed (PR5) | Batch ack partial commit + non-idempotent retry | [#10](https://github.com/hannaoker/the-triangle/pull/10) | processed+pending batch; lost-response retry | — |
| M4 | fixed (PR7) | Wake quota / empty retained_floor CHECK | [#11](https://github.com/hannaoker/the-triangle/pull/11) | boundary + empty table | — |
| M5 | fixed (PR9) | Drizzle journal stops at 0003; SQL to 0014 | [#12](https://github.com/hannaoker/the-triangle/pull/12) | fresh DB + upgrade | — |
| M6 | fixed (PR8) | 250ms spin + unbounded prune on poll | [#13](https://github.com/hannaoker/the-triangle/pull/13) | retention scheduled; cost budget | — |
| C1 | fixed (PR6) | Node ack omits `claims` | [#68](https://github.com/hannaoker/triangle-client/pull/68) | ack with enforcement on | After PR5 |
| C2 | fixed (PR6) | No retry cap / head-of-line block | [#68](https://github.com/hannaoker/triangle-client/pull/68) | poison → quarantine | — |
| C3 | fixed (PR4) | Deadline rejection unhandled during token fetch | [#67](https://github.com/hannaoker/triangle-client/pull/67) | timeout → request error | — |
| C4 | fixed (PR4) | Child stdin EPIPE unhandled | [#67](https://github.com/hannaoker/triangle-client/pull/67) | EPIPE handled; SIGKILL bound | — |
| C5 | removed | Mini Bob / Grok webhook wake path is removed (not deferred). Install dispatcher anchors on `appServerWake` (or explicit event lanes); do not re-arm webhook. | [#69](https://github.com/hannaoker/triangle-client/pull/69) | supervisor without grokBotWake | Path retired |
| C6 | fixed (PR3) | Plist `EnvironmentVariables` vs exact key set | [#66](https://github.com/hannaoker/triangle-client/pull/66) | agent add/enable with shipped template | — |
| C7 | fixed (PR3) | WorkloadTokenManager single-flight race | [#66](https://github.com/hannaoker/triangle-client/pull/66) | concurrent refresh shares one task | — |

## Phase 0 test / tooling (from review §1)

| Item | Status | Notes |
| --- | --- | --- |
| Root `&&` fail-fast test chain | **fixed** | `scripts/run-all-tests.mjs` in both repos (Phase 0) — MESH [#7](https://github.com/hannaoker/the-triangle/pull/7), client [#65](https://github.com/hannaoker/triangle-client/pull/65) |
| MESH SHA pin for `mailbox-mcp.test.mjs` | **fixed** | Pin purpose = byte integrity; updated to match post-`859a53e` content |
| Client `./app-server-host-support` export allowlist | **fixed** | #64 on `789ca88` |
| Client manifest v6 supervisor gate | **fixed** | #64 |
| Hermes `No module named 'pm'` | **deferred (env)** | Host integration test skips when Hermes packaging broken under sandbox |
| Service tests needing host CLIs | **fixed** | Fixture CLIs + v6 gate: 27/27 on Mini Phase 0 worktree |

## Medium / low (condensed)

| Item | Status | Notes |
| --- | --- | --- |
| openDirectRoom returns closed rooms | **fixed (PR11 MESH)** | [#15](https://github.com/hannaoker/the-triangle/pull/15) — reject `state != active` before reuse |
| Peer introspection ignores disabled senders | **fixed (PR11 MESH)** | [#15](https://github.com/hannaoker/the-triangle/pull/15) — reject `status === disabled` only (Codex P2: preserve idle/etc.) |
| Registration challenge purpose binding | **deferred** | `registration_challenges` has no purpose column (schema.ts); needs migration + issuer/consumer CAS |
| Production default IDs in macos-shared-codex-app-server-host | **fixed (PR11 client)** | [#69](https://github.com/hannaoker/triangle-client/pull/69) — require env or existing binding |
| Mini Bob / Grok webhook wake | **removed** | Path removed; not a deferred re-arm. Supervisor must not depend on `grokBotWake` |
| Lease enforcement | **not enabled** | Per plan; do not flip claim-lease enforcement flags until NULL-lease backfill is zero and clients send claims |

All other items from review §3 remain `deferred` pending later triage.
