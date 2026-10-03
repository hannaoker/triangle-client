> Provenance: copied 2026-10-03 from `~/.gemini/antigravity/brain/8985aba3-93ea-459e-b7d8-9a70383ef6b6/codebase_review.md` for durable execution of `triangle_implementation_plan.md`. Reviewed tips at copy time: MESH `5eda208`, client now `789ca88` (was `e181263` in review).

# The Triangle — Codebase Review (2026-10-03)

Scope: `the-triangle/` (MESH server, branch `codex/the-triangle` @ `5eda208`) and `triangle-client/` (branch `cursor/headless-watch-held-poll-83aa` @ `e181263`). ~100k LOC. Four parallel reviewers (auth, mailbox/data, client runtime, Swift helper). I spot-checked the items marked ✅ in the source myself.

## 1. Automated checks

| Check | Result |
|---|---|
| MESH `tsc --noEmit` | ✅ 0 errors |
| MESH `eslint` | 0 errors, 13 warnings (unused vars in tests, `<img>` in `page.tsx`) |
| MESH tests | **1097/1098** — `agent-auth-identity-v1.test.mjs:1680`: the SHA-256 pinned for `mailbox-mcp.test.mjs` is stale. Commit `859a53e` edited the file but did not update the pin. |
| Client `agent-worker` | **416/418**: <br>• `cli.test.mjs:75`: the export allowlist is missing `./app-server-host-support`. <br>• `runner-adapters.test.mjs:394`: the local Hermes install is broken (`No module named 'pm'`), which is an environment problem. |
| Client `tests/triangle-client-service.test.mjs` | **10/27**: "requires at least one trusted version 4 supervisor-capable runtime". Likely environment-dependent (it probes the local codex/hermes CLIs) or fixtures that lag the v6 manifest split in `b14af37`. Needs triage. |
| Client console, cutover, worker-render, Swift host, a2a-gateway, agents/codex, agents/hermes | Pass |

> [!WARNING]
> The root `npm test` scripts chain suites with `&&`. The first failure (agent-worker) hides every suite after it, so `triangle-client-service` was red without anyone seeing it.

**Repo hygiene (`the-triangle`):**
- 389 uncommitted deletions: `docs/investor-video/**` (wav/mp4/png), `bridge/trusted-read-*`, `mesh/app/chatgpt-auth.ts`, `mesh/examples/d1/**`, plus a matching `mesh/README.md` edit.
- `.git` is 325 MB because of the committed media.
- Commit the deletions intentionally. Consider history rewriting or LFS for the media.

## 2. High-priority findings

### Security (MESH auth)
| # | Finding | Where |
|---|---|---|
| S1 ✅ | **Recovery doesn't revoke the legacy `mesh_` bearer.** The recovery execute step bumps epochs and revokes keys but never rotates `agents.token_hash`. `authenticateAgent` checks only the hash and `status != disabled`, and grants all identity scopes, so a stolen bearer survives "successful" recovery. | [identity-recovery.ts](file:///Users/zhenyuhou/Projects/The%20Triangle/the-triangle/mesh/app/lib/identity-recovery.ts#L1449-L1497), [agent-auth.ts](file:///Users/zhenyuhou/Projects/The%20Triangle/the-triangle/mesh/app/lib/agent-auth.ts#L150-L177) |
| S2 | **The compat bearer survives the move to DPoP workloads.** It stays full-scope and not sender-constrained after `identity_state → active`. `recover-credential` can also mint a new one for active principals. | `workload-identity.ts:583`, `agent-credential-recovery.ts:94` |
| S3 ✅ | **A disabled agent can be re-enabled (TOCTOU).** The SELECT excludes disabled agents, but the follow-up UPDATE sets `status='online'` unconditionally. Fix: add `AND status != 'disabled'`. | [agent-auth.ts](file:///Users/zhenyuhou/Projects/The%20Triangle/the-triangle/mesh/app/lib/agent-auth.ts#L172-L175) |
| S4 | **Two-person rule can be bypassed.** An owner can invite a second account of their own as `security_admin`. Invites are unbound bearer secrets. | `controller-store.ts:155-382` |
| S5 | **Unauthenticated challenge minting with no rate limit, and tables never purged.** Affects `identity_challenges`, `registration_challenges` and `dpop_replay` (storage DoS). `token-challenges` also echoes `principal_id`. | `workload-identity.ts:717`, `registration.ts:250` |

### Correctness (MESH mailbox)
| # | Finding | Where |
|---|---|---|
| M1 ✅ | **The A2A bridge never writes `mailbox_wake_events`.** Held-poll watchers don't wake for bridged messages. The bridge is a hand-copied fork of the append SQL. | `a2a-mailbox-bridge.ts:536-549` vs `mailbox.ts:875-911` |
| M2 | **Claims with `lease_expires_at IS NULL` get stuck permanently once lease enforcement is on.** They can't be acked, reclaimed or renewed, are hidden from listings, and still count toward the 1000-pending quota. Fix: backfill before flipping the flag. | `mailbox.ts:1106,1234,1354,1391` |
| M3 ✅ | **Enforced ack is non-idempotent and can partially commit.** If one ID in a batch is already processed, the other N−1 commit and the call still returns 409. A retry after a lost response also gets 409. | [mailbox.ts](file:///Users/zhenyuhou/Projects/The%20Triangle/the-triangle/mesh/app/lib/mailbox.ts#L1225-L1243) |
| M4 | **Wake row is lost at the quota boundary.** An empty wake table can also violate the `retained_floor` CHECK, which turns the append into a 500. | `mailbox.ts:886-910` |
| M5 ✅ | **Schema drift.** The Drizzle journal and snapshots stop at `0003` while SQL goes to `0014`, so `db:generate` would produce a bogus migration. `schema.ts` defaults the `mesh_a2a_*` timestamps to `CURRENT_TIMESTAMP`, but `parseRow` requires ISO. | `drizzle/meta`, `db/schema.ts:122,159` |
| M6 | **Held poll is a 250 ms database spin loop.** It also runs an unbounded prune `DELETE` on every poll. The wake table grows without bound when nobody polls. | `mailbox-watch.ts:318-468` |

### Correctness (client)
| # | Finding | Where |
|---|---|---|
| C1 ✅ | **Node ack sends no `claims`.** With `MESH_MAILBOX_CLAIM_LEASE_ENFORCEMENT_ENABLED` on, every ack fails, the delivery is retried forever, and the queue head is stuck. The lease is also never renewed, while runner timeouts are 600 s. | [mailbox-client.mjs](file:///Users/zhenyuhou/Projects/The%20Triangle/triangle-client/packages/agent-worker/src/mailbox-client.mjs#L770-L787) |
| C2 | **One bad delivery blocks the mailbox permanently.** Retries have no cap or dead-letter. Listing is always `after=0&limit=1`, so a validation error on the head blocks everything behind it. | `mailbox-client.mjs:851-975` |
| C3 | **Unhandled rejection crashes the worker.** The deadline promise rejects during token fetch before anything is listening, and there is no `unhandledRejection` handler. | `mailbox-client.mjs:553-598` |
| C4 | **EPIPE on child `stdin` crashes the process.** No `'error'` listener on stdin in three spawners. | `helper-transaction-proxy.mjs`, `client-console/helper-runner.mjs`, `runners/runner-common.mjs:350` |
| C5 | **The retired Grok webhook is still live at runtime.** Commit `b14af37` only gated the installer. The install dispatcher also hard-depends on `grokBotWake`. | `client-supervisor.mjs:149,383-412,513` |
| C6 ✅ | **`triangle-client agent add/enable/...` always fails.** Swift `validateInstallation` requires an exact plist key set without `EnvironmentVariables`, but the shipped template has it. Rollback then fails too. Tests use a fixture without the key. | [TriangleClientCLI.swift](file:///Users/zhenyuhou/Projects/The%20Triangle/triangle-client/packages/macos-mailbox-helper/Sources/TriangleMailboxCore/TriangleClientCLI.swift#L360-L367) |
| C7 ✅ | **`WorkloadTokenManager` single-flight race.** Check and assign run in separate lock sections. The task's `defer` can clear `refreshTask` before it is assigned, so a finished or failed task can stick forever. | [WorkloadTokenManager.swift](file:///Users/zhenyuhou/Projects/The%20Triangle/triangle-client/packages/macos-mailbox-helper/Sources/TriangleMailboxCore/WorkloadTokenManager.swift#L64-L73) |

## 3. Medium / Low (condensed)

**MESH**
- Controller JWTs are replayable for privileged actions. The second "fresh" `authenticate()` call re-reads the same header.
- Registration errors echo outbound-fetch internals back to the caller, which can be used as an SSRF oracle.
- Installation-ID squatting on watch grants.
- Reclaimed deliveries end up behind the client's cursor.
- Pending quota is per room: one non-acking member stalls everyone. Each append runs about 5 correlated COUNTs.
- `release()` deletes by `grant_id` instead of `admission_id`.
- Watch deadline is computed after prune and auth, so a 55 s timeout can exceed `maxDuration=60`.
- A2A task listing is O(n) per page. `getTaskCorrelations` silently truncates at 65.
- Peer introspection ignores disabled senders.
- Registration challenges are not bound to a purpose.
- `openDirectRoom` returns closed rooms.
- Claim/watch responses drop the `Retry-After` value.

**Client (Node)**
- Grok `handleWake` drops newer wakes while an attempt is in flight.
- Abort listeners accumulate on the long-lived signal.
- A dead worker loop is never restarted.
- Helper timeouts send SIGTERM with no SIGKILL follow-up.
- Runner hangs when a grandchild holds stdout open.
- `macos-shared-codex-app-server-host.mjs` orphans children and **defaults to real production installation/agent/room IDs**.
- Gateway `getTask` fails on non-`message.created` events.
- `parseReplyRequired("false") === true`.
- The codex-conversations store has unlocked read-modify-write and allows `__proto__` as a key.

**Swift helper**
- Production builds still fall back to the legacy keychain on read. That allows pre-planted credentials, and a deleted credential can come back from the legacy copy.
- File custody uses a non-atomic write followed by chmod.
- The supervisor starts the child before installing signal handlers.
- The legacy worker gets `MESH_AGENT_TOKEN` through the environment.
- The 60 s URLSession timeout vs the 55 s hold leaves a thin margin.
- `try?` hides keychain errors.
- The `SecRandomCopyBytes` return value is ignored.
- `hasPrefix("http://localhost")` check.

## 4. Maintainability
- **Large files:**
  - MESH: `mailbox.ts` (1463), `identity-recovery.ts` (1564), `openapi.json/route.ts` (1688), `mcp/route.ts` (1253).
  - Client: `shared-codex-app-server.mjs` (1292), `headless-runtime.mjs` (1275), `ClientSupervisor.swift` (1711).
- **Duplicated append pipeline** between `mailbox.ts` and `a2a-mailbox-bridge.ts`. This duplication is the direct cause of M1. Extract one statement builder. The ~200-line `changes()`-chained batch in the bridge breaks if statements are reordered.
- **Copied client helpers:** `meshOrigin` validation (×5), bounded-JSON readers (×4), spawn wrappers (×3) and atomic-cursor writers (×3).
- **Leftovers from retired experiments:** `app-server-host-support.mjs` still exports `desktop_experiment_*`, about 400 lines of Grok quota/receipt code serve only the retired route, and `createFakeHarness` ships in `src`.
- **Duplicated route helpers:** route-level `noStoreJson` and integer parsing are copied per route with slight differences.

## 5. Suggested order
1. **S1 / S2 / S3:** revoke or gate the legacy bearer. Small diffs with the largest security impact.
2. **C1 + M2 + M3** before enabling lease enforcement in production: client sends claims, NULL-lease backfill, idempotent ack.
3. **C6, C7:** a broken CLI lifecycle and a token-refresh deadlock.
4. **M1:** bridge wake events, ideally via a shared append builder.
5. **C2–C4:** worker resilience (attempt cap, rejection handling, stdin error listeners).
6. Fix the 3 stale tests and change the root test scripts so one failing suite doesn't hide the rest.
7. M5 schema/journal drift; commit or revert the 389 pending deletions.
