# Handoff: identity foundation and the unified router (R1), 2026-10-26

Main is `adbcff0`. No pull request is open. Nothing from R1 is installed. This note says what is done, what is live on this Mac, and what remains. The designs and plans it refers to are in `docs/plans/`.

## 1. Merged since the item 6 and item 7 designs

| PR | What |
| :--- | :--- |
| #122 | R0: adapter contract, local adapter, conformance tests (library only) |
| #123 | Read-only identity inventory and `triangle identity inventory` |
| #124 | Host-local identity registry storage (hash-chained audit log, compare-and-set, crash and race handling) |
| #125 | Owner-confirmed mapping: `triangle identity migrate` plans, then `--confirm PLAN_ID` from a terminal records bindings |
| #126 | Registry defaults to `<application root>/identity` (decision A4); design updated |
| #127 | `triangle status|doctor --identity` section; inventory fixes (health diagnostics out, code-unit order, typed missing-module error) |
| #128 | The R1 implementation plan, with its three owner decisions settled |
| #129 to #131 | R1.0 identity primitives leaf module, R1.1 recipient resolver, R1.2 registry snapshot provider (all library only) |

The pieces built by Antigravity and Gemini (#124 to #127, #130, #131) were reviewed against independent probes, and the CLI pieces (#123, #125, #127) were run from a built package under a no-network, no-write sandbox. The review documents under `docs/reviews/` list what was found and fixed.

## 2. What is live on this Mac

- **Supervisor runtime:** manifest v12, bundle `a0d020fa…`, 81 artifacts, installed 2026-10-25 19:01 UTC from the #121 merge (record: `~/Library/Application Support/The Triangle/releases/pr121-install-verification.json`). Every artifact equals current main.
- **Worker runtimes** (codex, hermes, antigravity): v12, 83 artifacts each, older than the supervisor. Seven files differ from main (`claude-session-mcp-child`, `local-messaging-auth-broker`, `-cli`, `-host`, `-interactive-session`, `-journal`, `-mcp-adapter`), changed by #118, #119 and #121. The next `prepare-runtime` refreshes them.
- **Helper and client binaries:** rebuilt and hand-installed 2026-10-24 21:22 for the v12 cut (#117). `package-install.json` still says 0.2.0-onboarding.4 and no longer matches those two binaries.
- **Identity registry:** does not exist. The mapping is not applied.
- **Proved on the installed system by other sessions:** compaction survival and one short physical sleep/wake (#120), and automatic Desktop attachment on new and archived/reopened chats with automatic wake, claim, reply and ack (#121). Records are in the same `releases/` folder. Not proved: overnight sleep, a prolonged network outage, a second machine, live Claude retrieval.

## 3. What remains

### Owner, no code
1. Apply the identity mapping. `triangle identity migrate --client-root "$HOME/Library/Application Support/The Triangle/client"` prints the plan (3 proposals: `codex-headless`, `ghost`, `gravity2`, all `https://thetriangle.dev`, none blocked); run the printed `--confirm` command from a terminal. The principal tests in the R1 install need this registry. Until it exists, `doctor --identity` exits 1.
2. Decide what to do about profile `bob`: it has an on-disk custody binding that is not registered in the client instances (a warning in `doctor --identity`).
3. Approve the item 6 and item 7 designs as a whole (pending since 2026-10-25).
4. Item 2 timing trials: my script that reports per-session hook-to-registration time is on hold at your request; compaction and sleep/wake were already covered by #120.

### R1 (decisions settled: R1 gets its own v13 install; the router ships dark; principal ids only)
- **R1.3 router core**, library only: `unified-router.mjs` with `resolveSend` (calls the resolver, takes an injected `canMessage` to filter ambiguity candidates), decorators for send, status, replies and sessions that always strip the raw journal fields, and `statusBlock` with counters. Disabled means no registry read and no decoration.
- **R1.4 integration and v13, one PR:** server and host wiring, two nullable journal columns, `client/local/router.json` (separate file, so a rollback to v12 stays safe), `triangle-local setup-router`, the `router` block in `local_status`, the manifest bump (installer lists, Swift launcher and contract cases, `WORKER_MANIFEST_VERSIONS`, four tests), docs. It cannot be split, because main must never stage a bundle that misses a file.
- **R1.5** candidate build and scratch-root rehearsal, **R1.6** installed acceptance. The runbook, with a rollback per phase, is section 6 of the R1 plan. Owner gates: G1 merge, G2 helper install, G3 stage v13 and restart, G4 enable the router. Helper first, runtime second, never together.
- Later: R2 (needs item 7 slice 2), R4 (read-only aggregated status), R3 and R5 (remote, deferred by the 2026-10-23 priority update, bring v14). Item 7 slices 2, 3a (first task: OS re-authentication feasibility), 3b (deferred), 4 and 5 are not started.

### Small follow-ups
- The mapping plan's `summary` repeats each count under two names; `doctor --identity` prints each diagnostic twice; `identityRegistryRoot` is a top-level report key.
- Reconcile `package-install.json` through a proper package install once R1 settles.
- Remove the scratch worktrees listed in section 5.

## 4. How to continue

- Tests use the system Node: `/Users/zhenyuhou/.local/bin/node --test <files>`. The installed bundled Node breaks `tests/client-package.test.mjs`. Python for the installer is `/usr/bin/python3`.
- Suites that cover this area: the identity family (`identity-*`, `installation-inventory`, `recipient-resolver`, `router-registry-snapshot`), the local messaging family (`local-messaging-*`, `client-supervisor-local-messaging`, `transport-adapter-conformance`, `grok-local-session`: 188 tests), `npm --prefix packages/triangle-cli test` (115), `tests/client-package.test.mjs` (9). `scripts/run-all-tests.mjs` has 4 failing suites on main in this environment (triangle-client-service 1 test; a2a-gateway, agents/codex, agents/hermes need workspace links).
- Building with Gemini: the `gemini-coder` skill, one worktree per task from the latest main, model `gemini-3.8-flash-medium` for specified work. Name in the task which existing tests it may update (it once hid an import instead of updating a boundary test), then review the diff for workarounds and write independent probes for the contract. The probes I used lived in the session scratchpad and are not committed.
- Packages and installs: build with `scripts/release/build-client-package.mjs` using the installed binaries as prebuilt inputs (nothing is installed by a build); `stage-runtime` overwrites the live manifest and is not a dry run, so rehearse with a scratch `--application-root`.

## 5. Gotchas

- `agent-worker` timing tests were flaky and #114 fixed three of them; the `triangle-cli` `recovery.test.mjs` lock test can hang (kill its holder processes and rerun).
- Do not touch `~/.codex`: the shared Codex app-server reads it.
- The `discovery-usability` worktree now belongs to another session (`codex/unified-local-adapter`).
- Deleting the directory a background job started from makes its notice say "failed" although it succeeded; read the summary file instead.
- Scratch worktrees from this work, all merged and safe to remove with `git worktree remove` from `triangle-client`: `identity-mapping`, `identity-registry-storage`, `identity-status-doctor`, `r1-resolver`, `r1-snapshot`. The remote branches stay (the repository does not delete branches on merge). `identity-inventory` is Codex's.
