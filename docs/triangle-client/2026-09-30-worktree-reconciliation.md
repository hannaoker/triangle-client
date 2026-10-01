# Worktree reconciliation (2026-09-30)

Against `origin/main` after fetch. Working checkout: `cursor/headless-watch-held-poll-83aa` @ `2197740`.

Live Mini inventory (read-only):
- Profile `dawn-gemini-mini-two`: `runtimeAdapter: antigravity`, `enabled: false` (decode-compat required).
- LaunchAgent `dev.thetriangle.client`: `TRIANGLE_CODEX_POOL_ENABLE=1`, `TRIANGLE_CODEX_POOL_SIZE=2`, `TRIANGLE_DESKTOP_HANDOFF_ENABLE=1`.
- LaunchAgent `dev.thetriangle.shared-app-server` ProgramArguments host: checkout `scripts/macos-shared-codex-app-server-host.mjs` (imports experiment module — extract before delete).
- Prepared bundles under `~/Library/Application Support/The Triangle/worker-runtime/bundles/` already include `shared-home-concurrency-probe.mjs` and supervisor artifacts.

## Decisions

| Commit | Branch | Decision | Reason |
| --- | --- | --- | --- |
| `0562b75` installer Swift compat mode | fix/swift-6-3-build | **retain** | Not on HEAD/main; merge after simplify |
| `17da737` pre-macOS 12 URLSession | fix/swift-6-3-build | **retain** | Same |
| `05c8ec9` mesh_client room_id | fix/swift-6-3-build | **retain** | Skill-only fix; incorporate with that branch |
| `451a57c` 64 KiB stream + cancel | fix/swift-6-3-build | **retain** | Helper correctness |
| `a021178` cancel test wait | fix/swift-6-3-build | **retain** | Pairs with 451a57c |
| `ea03a21` plist env + decouple codex imports | fix/swift-6-3-build | **retain** | Large Swift delta vs HEAD; Mini already uses TRIANGLE_* env — merge carefully later |
| `008b732` antigravity multi-turn | fix/swift-6-3-build | **retain** | Antigravity not stub; decode-compat this pass |
| `d753cc4` antigravity envelope reject | fix/swift-6-3-build | **retain** | Same |
| `f7ae6a5` supervisor pool 2 | cursor/production-pool-handoff-a4f9 | **retain (do not abandon)** | Live Mini pool=2; cherry-pick onto headless-watch conflicts in `headless-runtime.mjs` — resolve in dedicated merge before Phase 3 worktree removal |
| `9ec6e4c` bundle probe + desktop handoff | cursor/bundle-probe-artifact-a4f9 | **effectively present / retain** | HEAD installer + WorkerLauncher already list probe/handoff; live bundles ship them |

Profile strategy for this simplify pass: **decode-compat** (keep antigravity enum; do not remove runtime/schema).

## Phase 3 removal candidates (not removed in Phase 0)

- `/Users/zhenyuhou/Projects/The Triangle/swift-lock-build-fix`
- `/Users/zhenyuhou/Projects/The Triangle/triangle-client-pool-handoff`
- `/Users/zhenyuhou/Projects/The Triangle/triangle-client-supervisor-env`
- `/private/tmp/triangle-cursor-acp-48`
- `/private/tmp/triangle-fix-pr27`
- `/private/tmp/triangle-fix-pr28`
- `/private/tmp/triangle-pr32-33-review`

## Phase 2 profile strategy (executed)

**Decode-compat chosen.** Keep `RuntimeAdapter.antigravity` / schema decode. Live Mini profile `dawn-gemini-mini-two` remains `enabled: false`. Do not remove antigravity runner/schema in this simplify pass.
