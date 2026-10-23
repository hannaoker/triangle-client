# Installed local messaging acceptance — 2026-10-21

Implementation: `23dd636`, diagnostics follow-up `28ad972`, branch `codex/installed-local-messaging`. Same-host delivery is now installed and exercised through the supported `triangle-local` entry and the existing `dev.thetriangle.client` supervisor. No direct `agy` invocation or temporary supervisor was used for the acceptance requests. Antigravity authored the production journal/dispatcher slice; Codex integrated it, independently tested it and fixed review findings.

## Verified outcome

Existing desktop sender `8dc26a2fc9a622dc5ed9e3560fa0533a38b8f0998e7c34108cfb1301c6aaab64` is explicitly bound to this conversation `01a14c05-6603-7921-b744-659195a490a5`. Its inbound wake flag remains false. Recipient gravity2 remains `30966e45dadb53c15bb685a2ac5facac263ca23651010338b6cc73b9e38793c0`; existing runner and developer execution policy are reused.

| Request | Independently observed outcome | Admission to terminal state |
| --- | --- | --- |
| `local-proof-20261021-echo` | Correlated `TRIANGLE_LOCAL_OK`, retrieved by a new CLI process after sender disconnected | 77.335 s |
| `local-proof-20261021-code` | Antigravity created only the requested implementation file in the isolated checkout and returned a correlated completion; Codex inspected it and reran the original two tests | 191.926 s |
| `local-proof-20261021-correction` | Codex added a failing numerical edge test and requested a correction through Triangle. Antigravity wrote the corrected file, but its turn hit the 300 s deadline without returning a reply. Record held as `runner_timeout`; Codex independently inspected the file and passed all three tests | approximately 300 s |

These durations include admission, execution scheduling, model inference and persistence. They are not transport-only latency. The correction is not counted as a successful completed turn merely because its artifact passes tests. It must not be blindly replayed.

Coding proof checkout: `/private/tmp/triangle-local-coding-proof`; artifacts `delegation-proof/retry-delay.mjs` and Codex-owned `retry-delay.test.mjs`. No tracked repository files were modified there; no commits, pushes or merges were requested from Antigravity. The numerical correction safely multiplies the exponent in bounded chunks, avoiding a premature cap for subnormal bases.

## Verification boundaries

- Local/peer/bundle checks: 138 passed, one opt-in real-engine case initially skipped. That real peer-engine case subsequently passed separately with the actual binary.
- Supervisor/wake checks passed 77/77 in the focused run. A later concurrent batch reproduced two known timing-sensitive wake assertions; neither is presented as a clean concurrent-batch pass.
- Production journal/dispatcher/host independent re-review: 23/23 passed after fixing late timeout success, durable reply ancestry, unobserved claim failures and failed-initialization lock leakage.
- Auth broker/CLI protocol checks passed; the final per-message status change passed both real-subprocess host/CLI tests and independent disclosure review.
- Swift host suite exited 0. Strict packaging/legacy-version contracts passed 17/17 after updating v9 expectations and legacy fixture artifact sets.
- Broad agent-worker run: 776 tests, 767 passed, five failed, four skipped. Four failures were stale v8/legacy packaging assertions, subsequently corrected and covered by the passing 17-test run. The remaining installed-Hermes CLI probe failure was already reproduced on the unchanged baseline. A clean broad-suite pass is not claimed.
- Native current-conversation MCP tool attachment has not been proven. The installed CLI is the verified entry; MCP stdio handshake and tool calls pass subprocess tests.
- No cloud deployment, remote identity reenrollment or MESH message fallback occurred.

The first service activation exceeded the existing ten-second readiness timeout, then became ready. Final activation exited 0 and uses the existing `TRIANGLE_READY_TIMEOUT_MS=60000` operator option. This needs a future cold-start latency baseline, not an assertion that the first activation command passed.

## Reliability conclusion

Desktop-to-Antigravity delegation through installed Triangle is demonstrated, including real edits and durable correlated completion. It remains supervised rather than an unconditional coding engine: provider latency, timeout-side effects, explicit recovery and repeated long-task evidence remain operational concerns. Recipient turns also do not yet receive configured outbound Triangle tools for recursive delegation.

## Installed custody and rollback

The pre-activation backup is `/Users/zhenyuhou/Library/Application Support/The Triangle/client/backups/installed-local-20261021`. It contains the old helper, helper checksum, supervisor manifest and desktop binding. The new runtime is manifest v9 and its exact 75-source-file closure was verified against the implementation. The helper SHA-256 is `9bff5fede2faa6730ede446312855e7ca51c0e4bbc9782f2c49600fe572117b6`.

To roll back, first stop the existing service and confirm termination. Restore those four backed-up files with their original modes, move the new local configuration aside so the old helper does not opt in, and start the existing service. Preserve the new private journal for inspection; do not delete messages or credentials. No second supervisor is needed.

Final installed restart retained both completed records, both unconsumed replies and the held timeout, with zero active local executions. The disposable echo reply was then explicitly consumed and retrieval returned no echo replies. The coding reply remains retained.
