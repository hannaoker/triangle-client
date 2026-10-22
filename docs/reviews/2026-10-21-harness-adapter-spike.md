# Single-thread ownership verification

Status: **NOT PASSED — partial live ownership observation; restart and delivery gates open.**
Scope: current conversation `01a14c05-6603-7921-b744-659195a490a5`. Read-only runtime/service inspection; no new server, thread resume, queue submission, binding change or service restart.

## Current process ownership

- ChatGPT app PID 54924 owns Codex app-server child PID 55297.
- That child has this exact thread's rollout open and the matching `~/.codex/thread-writer-locks/01a14c05-6603-7921-b744-659195a490a5.lock` file open.
- An all-process `lsof` query for that exact writer-lock file returned only PID 55297. This identifies the currently observed writer; it does not establish restart-safe mutual exclusion for all producers.
- Another Codex stdio app-server exists under a different parent. It did not appear in the exact-thread writer-lock query; no claim is made that every app-server on the machine belongs to this thread.

## Shared-host restart hazard

- `launchctl print gui/501/dev.thetriangle.shared-app-server` returned not loaded. No listener was found at saved `ws://127.0.0.1:49554`.
- Its saved LaunchAgent still has `RunAtLoad:true` and `KeepAlive:true` and points at `triangle-client/scripts/macos-shared-codex-app-server-host.mjs`.
- The production binding has this conversation's thread ID, sender instance `8dc26a2fc9a622dc5ed9e3560fa0533a38b8f0998e7c34108cfb1301c6aaab64`, and `enabled:false`.
- The actual LaunchAgent script's `loadExistingBinding()` reads that file when the binding/token paths exist. It chooses `preferredThreadId` from environment or that binding, launches its own App Server and calls `resolveDesktopExperimentThread`. It does not gate that thread selection/resume on `enabled`.
- Therefore `enabled:false` disables the wake binding but does not establish that a future shared-host startup cannot attempt another resume of this ChatGPT-owned thread. No destructive collision test was performed.

## Installed state versus committed fixes

- Installed supervisor bundle remains `cd5492bd98cfe551318258694dc675bd6c5ce580d3f1181d1a29dddfa3cb5c3a`.
- Installed local configuration still points `bindingPath` at production `client/app-server-binding.json`.
- Inspection of its packaged CLI confirms the old production-binding default and absence of the new separate desktop-sender binding path.
- The owner's committed fixes through `c4182f5` have been integrated into #107, but are not installed. A source fix is not a deployed ownership repair. Changing a future setup default alone also does not restore a production binding already rebound earlier; migration/repair needs explicit evidence.

## Queue and concurrency proof

Installed `codex queue --help` documents existing-session queueing. It does not identify which App Server the command will reach. The observed app-owned server runs over its application connection; no verified CLI route into that exact owner has been established.

No queue probe was submitted: first prove its owner routing without launching another App Server, then send a uniquely labeled canary. No App Server fallback was used. Busy/idle wake, duplicate handling, simultaneous MESH/local arbitration and restart safety remain unverified.

## Required next steps

1. Review/merge and install the binding-separation fixes with an explicit migration for the already-rebound production binding. Preserve this desktop sender's identity and recorded original production thread; do not invent a replacement.
2. Verify the dormant shared-host startup cannot resume the ChatGPT-owned thread, including explicit preferred-thread configuration. Keep one thread owner.
3. Establish the supported queue submission route to PID 55297's actual owner connection. If unavailable, report unsupported; do not spawn/resume a competing server.
4. Run one harmless canary in the correct conversation while busy, then idle; verify owner and correlation independently of CLI exit.
5. Prove a common thread-level arbiter for MESH and local wake, plus restart/deduplication behavior.

Result: **current owner identified; automatic desktop push remains OFF.** The user's push approval is preserved. This failed verification does not revoke approval; it identifies the engineering work needed before activation.

## Follow-up: owner retired shared host

User reported retirement completed; read-only inspection confirmed:

- `~/Library/LaunchAgents/dev.thetriangle.shared-app-server.plist` is absent.
- The shared-host launchd job is not loaded.
- Production `client/app-server-binding.json` is absent.
- The exact thread writer-lock lookup still returns only the ChatGPT-owned
  Codex server PID 55297.

This removes the observed dormant LaunchAgent/binding restart hazard; the
older sections above are historical observations. It does not establish the
queue routing or busy/idle notification proof.

The local configuration is still enabled and points at the removed production
binding. `triangle-local status` now exits 1 with `internal_error`. The next
step is the reviewed dedicated desktop-sender binding migration from the #107
fixes, preserving sender identity, followed by a service health check. Do not
recreate the production binding or resurrect the shared host as a workaround.
No runtime or configuration was changed by this verification.
