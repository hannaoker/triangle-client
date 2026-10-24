# Idle request budget

What the Triangle client asks MESH for while nothing is happening, and the knobs
that bound it. The MESH backend (Vercel Hobby) meters invocations and Active CPU,
so an idle machine should cost close to nothing.

## Where idle requests come from

One `triangle-mailbox` process is one helper command, and the supervisor starts a
new process for every command. For an idle machine with a Cursor ACP lane
(`ghost`) and two headless Codex lanes (`bob`, `codex-headless`), all at the
default 30 s `pollIntervalMs`:

| Helper command | Who runs it | MESH requests per run |
| --- | --- | --- |
| `watch-poll` | the install watch dispatcher, one per installation, every ~30 s idle | 1 (`GET /api/v1/mailbox/watch`, authenticated by the watch credential) |
| `transaction-claim-next --profile P` | every Cursor ACP / headless Codex drain, every `pollIntervalMs` | identity gate (`GET /api/v1/agents/me`) + mailbox list (`GET /api/v1/mailbox`), plus the token exchange (`POST token-challenges`, `POST tokens`) when no usable workload token exists |

Before this change every `claim-next` run exchanged its own workload token (4
requests per run) and every lane claimed on every tick.

## Shared workload token (helper)

`WorkloadTokenManager` keeps its DPoP-bound access token in memory, and every
helper command is a new process, so each run used to start with the two-request
exchange. The helper now shares the token between processes through
`~/Library/Application Support/The Triangle/credentials/local/workload-token/`
(one `0600` file per origin, workload, key and scope set). A later process reuses
a token while more than 30 s of life remain, drops it on any `401`, and treats a
missing, corrupt or unsafe entry as a cache miss. Custody, the exact validation
and the guarantees (the token is never logged; every request still carries its
own DPoP proof) are in [`KEYCHAIN_POLICY.md`](../../packages/macos-mailbox-helper/KEYCHAIN_POLICY.md#workload-token-cache).
With a 35 s run cadence and 300 s tokens, one run in eight pays the exchange.

## Wake-driven claims (supervisor)

A lane that is a member of the install watch (it carries an `agentId`) is told
about new mail by the watch hint, which calls the drain's `kick()`; the install
watch also hints every lane once at startup and after a `resync_required`. For
those lanes the poll timer is only a safety net, so while a lane is idle the timer
keeps ticking every `pollIntervalMs` but a tick only claims when one of these
holds (`createDrainIdlePolicy` in `install-watch-dispatcher.mjs`):

- the last attempt, from a hint or a tick, did **not** positively find the mailbox
  empty: it claimed a delivery, settled a receipt, failed, or came from a resolver
  that does not say. A backlog therefore drains and a failure is retried at the
  same pace as before;
- the install watch is not demonstrably delivering (no watch poll has succeeded
  in the last three idle cycles plus a minute, 159 s at the default cadence; a
  poll failed; the grant ensure is retrying or backing off after a 402/429; or the
  dispatcher is not running). Those lanes keep polling exactly as before, so an
  unhealthy watch never leaves a lane waiting five minutes;
- the safety interval (default 300 s, plus up to 20 % jitter) has passed since the
  last attempt.

Lanes that are not watch members (no `agentId`, or no install dispatcher) are
untouched. The 402/429 breakers, grant renewal and the watch's own backoff are
unchanged.

Bounds on delivery latency, with the watch healthy: a delivery that is announced
is claimed within one watch cycle (about 33 s) of the announcement, as before; one
that is never announced (a server that failed to emit the event) is claimed by the
next safety poll, at most 300 s + 20 % + one 30 s tick after the last attempt.

## How to measure

Both layers are reproduced in tests with the real code and a counting fake:

- `swift run TriangleMailboxHostTests` (`WorkloadTokenCacheContractCases`, case
  "idle claim-next requests per helper run and per hour") counts MESH requests by
  method and path for one idle `transaction-claim-next` process, and for 103 such
  processes at a 35 s cadence, with and without the shared token.
- `node --test test/idle-claim-cadence.test.mjs` runs one virtual hour of the
  real install dispatcher, wake client and Cursor ACP / headless Codex drains and
  prints `claim-next` and `watch-poll` helper runs per hour, before and after,
  plus event-to-claim latency, the unannounced-delivery bound and the
  watch-outage fallback.
