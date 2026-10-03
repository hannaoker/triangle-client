# Triangle finding dispositions

Tracking sheet for [`codebase_review.md`](./codebase_review.md) under [`triangle_implementation_plan.md`](./triangle_implementation_plan.md).

Updated: 2026-10-03 (Phase 0 start). Status values: `confirmed` | `rejected` | `deferred` | `fixed`.

## High priority

| ID | Status | Reproducer / notes | Fix PR | Test | Rollout |
| --- | --- | --- | --- | --- | --- |
| S1 | confirmed | Recovery bumps epochs/keys but not `agents.token_hash`; old `mesh_` still auths | PR1 (pending) | recovery then old bearer 401 | Inventory workload migration first |
| S2 | confirmed | Compat bearer stays after `identity_state → active`; recover-credential can remint | PR1 (pending) | active workload cannot remint/use legacy | Keep approved legacy-only path |
| S3 | confirmed | Heartbeat UPDATE omits `status != disabled` | PR1 (pending) | disabled agent heartbeat fails closed | — |
| S4 | deferred | Two-person / invite binding | PR10 | — | Needs policy choice |
| S5 | confirmed | Unauth challenge mint + no purge | PR2 (pending) | bounded issuance + batch cleanup | Tune limits from traffic |
| M1 | confirmed | Bridge append skips `mailbox_wake_events` | PR7 (pending) | bridged msg wakes held poll | — |
| M2 | confirmed | NULL `lease_expires_at` stuck under enforcement | PR5 (pending) | backfill migration idempotent | Enforce only after zero NULL |
| M3 | confirmed | Batch ack partial commit + non-idempotent retry | PR5 (pending) | processed+pending batch; lost-response retry | — |
| M4 | confirmed | Wake quota / empty retained_floor CHECK | PR7 (pending) | boundary + empty table | — |
| M5 | confirmed | Drizzle journal stops at 0003; SQL to 0014 | PR9 (pending) | fresh DB + upgrade | — |
| M6 | confirmed | 250ms spin + unbounded prune on poll | PR8 (pending) | retention scheduled; cost budget | — |
| C1 | confirmed | Node ack omits `claims` | PR6 (pending) | ack with enforcement on | After PR5 |
| C2 | confirmed | No retry cap / head-of-line block | PR6 (pending) | poison → quarantine | — |
| C3 | confirmed | Deadline rejection unhandled during token fetch | PR4 (pending) | timeout → request error | — |
| C4 | confirmed | Child stdin EPIPE unhandled | PR4 (pending) | EPIPE handled; SIGKILL bound | — |
| C5 | deferred | Grok webhook still wired at runtime | PR11 | — | Mini ops: webhook retired |
| C6 | confirmed | Plist `EnvironmentVariables` vs exact key set | PR3 (pending) | agent add/enable with shipped template | — |
| C7 | confirmed | WorkloadTokenManager single-flight race | PR3 (pending) | concurrent refresh shares one task | — |

## Phase 0 test / tooling (from review §1)

| Item | Status | Notes |
| --- | --- | --- |
| Root `&&` fail-fast test chain | **fixed** | `scripts/run-all-tests.mjs` in both repos (Phase 0) |
| MESH SHA pin for `mailbox-mcp.test.mjs` | **fixed** | Pin purpose = byte integrity; updated to match post-`859a53e` content |
| Client `./app-server-host-support` export allowlist | **fixed** | #64 on `789ca88` |
| Client manifest v6 supervisor gate | **fixed** | #64 |
| Hermes `No module named 'pm'` | **deferred (env)** | Host integration test skips when Hermes packaging broken under sandbox |
| Service tests needing host CLIs | **fixed** | Fixture CLIs + v6 gate: 27/27 on Mini Phase 0 worktree |

## Medium / low (condensed)

All items from review §3 start as `deferred` pending Phase 5 PR10–11 triage. Promote individually when reproduced.
