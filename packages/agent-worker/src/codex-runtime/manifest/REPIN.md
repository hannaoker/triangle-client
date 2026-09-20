# Re-pinning the Codex runtime manifest (Mini Darwin)

Phase 0 pinned sandbox and approval enum allowlists from the upstream App Server
v2 JSON Schema artifact because this Linux environment has no bundled Codex
binary (`ChatGPT.app` Resources `codex`).

## Gap

| Item | Status |
| --- | --- |
| Upstream schema commit | Pinned in `runtime-manifest.json` → `provenance.sourceCommit` |
| Bundled Codex binary version | **Missing here** — set on Mini |
| Live `clientUserMessageId` survival through `thread/read` | **Blocked** — prove on Mini |
| Dual App Server shared `CODEX_HOME` concurrency | **Unproved** — run probe on Mini |

## Mini re-pin procedure

1. Resolve the exact bundled binary used by Triangle Desktop / ChatGPT.app, for
   example:
   `/Applications/ChatGPT.app/Contents/Resources/codex`
2. Record `codex --version` (or equivalent) into
   `provenance.bundledCodexBinary`.
3. Prefer generating enums from that binary when it exposes schema/export:

   ```sh
   node packages/agent-worker/scripts/generate-codex-runtime-manifest.mjs \
     --codex-bin /Applications/ChatGPT.app/Contents/Resources/codex \
     --out packages/agent-worker/src/codex-runtime/manifest/runtime-manifest.json
   ```

4. If the binary cannot emit schemas, re-fetch the matching upstream
   `codex_app_server_protocol.v2.schemas.json` for the **same** Codex version
   commit/tag and run the generator with `--schema-url` / `--source-commit`.
5. Run the focused suite:

   ```sh
   node --test packages/agent-worker/test/codex-runtime/*.test.mjs
   ```

6. Only after the shared-home concurrency probe passes on Darwin may pool size
   leave `1` and desktop handoff leave disabled. A failed probe must never fall
   back to `~/.codex`.


## Mini evidence log (2026-09-20 PT)

- Bundled binary: `/Applications/ChatGPT.app/Contents/Resources/codex` -> `codex-cli 0.155.0-alpha.9.2`
- Schema re-pin: openai/codex tag `rust-v0.155.0-alpha.9.2` commit `4607249e430dac1c961df4dc615beae88e33cec8`
- Node Phase 0 suite: 17/17 after Darwin `realpath` test expects (`/var` vs `/private/var`)
- Live shared-home probe (`live: true`, dual `codex app-server` stdio, dedicated TRIANGLE home): **failed** on `thread/resume` with `no rollout found for thread id ...` after concurrent slot start. Dedicated home was created and wrote sqlite/locks; do **not** promote `sharedHomeConcurrency.status` to `passed`. Recovery must not use `~/.codex`.
- Live `clientUserMessageId` survival through real `thread/read`: **not yet run** (blocked on stable live probe/session).
