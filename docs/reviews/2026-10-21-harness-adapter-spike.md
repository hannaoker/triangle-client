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

Update, 2026-10-21 22:10 PDT: the repoint described above has since been done.
`client/local-messaging.json` points at `client/desktop-binding.json`, the
service restarted at 21:27 on the unchanged installed bundle, and
`triangle-local status` exits 0. See "Shared-host retirement verified" in the
plan.

## Stage A: what `codex queue` does (throwaway CODEX_HOME, mock model)

Run 2026-10-21 22:36-23:01 PDT, adopting the plan's M0 suggestion (b) on the
owner's instruction. Evidence level: **live, in a throwaway home with an owner
stand-in**. It can rule behaviors out. It does not replace the canary in the
real ChatGPT conversation.

### Method and isolation

- Each scenario ran in a fresh throwaway `CODEX_HOME` and `HOME` under a scratch
  directory. A mock Responses-API provider on 127.0.0.1 answered every model
  call: no credentials, no network, no real model.
- The owner stand-in was the ChatGPT-bundled `codex app-server`
  (`0.163.0-alpha.11.1`), started as a stdio child of the test driver. Like the
  app's own server it exposes no listening endpoint. The queue client and the
  persistent-server cases used the Homebrew `0.163.0` build.
- Pins, recorded at the rerun (2026-10-22 06:29Z) in the assets directory's
  `stage-a/results/rerun/versions.txt`: Homebrew `codex-cli 0.163.0` (SHA-256
  `88133672...fdee31`), ChatGPT-bundled `codex-cli 0.163.0-alpha.11.1` (SHA-256
  `9394a943...aeaecd`; ChatGPT app 26.1016.61520, build 21421), macOS 27.0.1
  arm64, Node 22.22.3. The reported run did not hash the binaries; its version
  strings are the same.
- Every process ran under a macOS Seatbelt profile that denied file access to
  the real `~/.codex`, the live Triangle install and its logs, and the real
  managed daemon's socket and lock; denied outbound IP except loopback; and
  denied connecting to the real daemon socket. The rules were tested first with
  allow/deny decoys. No run logged a denial, so nothing tried to reach a denied
  path.
- Real system before and after: same writer-lock holder (PID 39686), same
  managed daemon (PID 16779), same supervisor app-servers, same two entries in
  `/private/tmp/codex-daemon-501`. No harness process or temporary socket was
  left behind.
- Not exercised: the ChatGPT app UI and the app server's own configuration.

### Protocol facts (generated experimental JSON Schema, identical in both builds)

- `thread/queue/add`, `list`, `update`, `delete`, `reorder` and `start`, plus
  the notification `thread/queue/changed {threadId}`. A client opts in with
  `capabilities.experimentalApi` at `initialize`. The official App Server page
  documents none of this.
- `add` takes `{threadId, clientUserMessageId, input[]}` and returns the queued
  submission. A stored item holds only the input and the client id: no model,
  sandbox, approval or cwd. `start` takes a thread id and an optional
  submission id.
- `thread/attachmentOwner/list` lists threads by attachment identity. It is not
  a writer-ownership API.

### Results

| Case | Observed |
| --- | --- |
| No server, unknown thread, default transport | `codex queue` exits 1 in 0.26 s: "thread/queue/add failed: failed to read thread: ... no rollout found for thread id ...". It ran an embedded in-process server (created state databases in the home, spawned no process, started no daemon). |
| Second server runs `thread/resume` on a thread whose writer lock another server holds | Refused: "already has an active writer" (-32600). The owner kept the lock and kept working. |
| Owner idle, default transport | Exit 0 in about 0.1 s, prints "Queued message ID for thread ID." The owner started a turn by itself 5.3-9.4 s later (8 trials; consistent with a roughly 10 s poll). The model saw a plain `user` message with no marker of origin. The queue emptied. |
| Same, with `-m other-model -s danger-full-access -C DIR` | The stored item has text and client id only. The dispatched turn used the thread's own model and its read-only policy. |
| Owner busy (22 s turn) | Queued in 0.4 s. Nothing happened during the turn; the owner dispatched the message the moment the turn completed. No steering, no competing turn. |
| Three messages back to back, idle and busy | One turn per message, in order. Nothing was merged. |
| Thread on disk, no owner | Exit 0. No lock taken, no process started, no turn run, rollout file unchanged. The item waits in `queue_1.sqlite`. A new owner that resumed the thread dispatched it immediately. |
| Persistent server (like the managed daemon) running, thread loaded nowhere; explicit `--remote` and default transport | Queued both times. The server loaded nothing, took no lock and ran no turn. A later owner resumed the thread normally. |
| Black-hole socket at the managed daemon's control-socket location | The default path probes that socket (3 connections, 10 s), then exits 1: "cannot queue through an embedded app server while a local app-server daemon is running; remove configuration overrides or use --remote". With no socket it embeds. |
| Healthy persistent server at the control socket plus a separate stdio owner (the real topology) | Exit 0 in 19 ms. The owner started the turn 9.0 s later; lock unchanged; the persistent server held no lock. An override flag (`-m`) was accepted and had no effect. |
| Explicit `--remote` to the owner's own endpoint | The owner announced the change and dispatched within about 0.2 s. Not applicable to the ChatGPT app, whose server has no endpoint. |
| Protocol: same `clientUserMessageId` added twice while still queued | The second add replaced the first: one item remains, with the newest text. |
| Protocol: same id added again after the first was dispatched | Not deduplicated; a second turn ran. |

### What this answers

1. **Routing.** In the default transport that was tested, with a separate
   stdio owner, `codex queue` does not talk to the thread's owner. It writes to
   the durable queue in the shared `CODEX_HOME`, through the managed daemon if
   the control socket answers and through an embedded server otherwise, and the
   owner picks the item up by polling. An explicit `--remote` endpoint is a
   different, direct route: when the owner exposes one, it announced the change
   and dispatched within about 0.2 s (results table). The ChatGPT-owned server
   exposes no endpoint (no listening or named socket was found), so only the
   shared-queue route applies to it. The tested owner is a stand-in. The only
   observation against the ChatGPT-owned server so far is the ad hoc exchange
   described in the canary protocol, which is not acceptance evidence.
2. **Single ownership.** In every configuration tested, queueing took no writer
   lock, loaded or resumed no thread, and started no turn by itself: the
   lock-holding stand-in, or an owner that resumed the thread later, ran the
   item. A second server's `thread/resume` was refused while the stand-in held
   the lock. This holds for the tested pairing (a Homebrew `0.163.0` server
   against the bundled `0.163.0-alpha.11.1` owner) and the shared-`CODEX_HOME`
   topology. It is not a guarantee for other builds or layouts.
3. **Idle, busy, absent.** Idle: the owner starts a turn by itself, up to about
   10 s later. Busy: the item waits for the turn boundary. Absent: the item
   waits in the database and the owner that next resumes the thread runs it.
   Codex runs one turn per queued message, so every hint queued while the app
   is closed becomes its own turn when the app returns.
4. **Policy.** The invoker's flags do not reach the queued turn. The turn uses
   the thread's own settings.
5. **Receipts and retries.** On success the CLI prints the queued submission id
   and exits 0. The CLI generates a fresh `clientUserMessageId` per call, so a
   retried CLI call duplicates. Over the protocol a stable id replaces a still
   queued item, and `list` and `delete` allow reconciliation. A retry after
   dispatch still duplicates.
6. **Failure modes.** Unknown thread: exit 1 in under 0.3 s. Unresponsive
   managed daemon: exit 1 after 10 s. Wrong `CODEX_HOME`: "no rollout found"
   (fails closed). Codex's compatibility error for a server without
   `thread/queue/add` was not reproduced.
7. **Authenticity.** The queue is an unauthenticated same-user path into any
   thread, and a queued message is indistinguishable from the user's own
   typing. A hint carries no authority; the agent must verify through Triangle's
   own tools.

### Consequences for the plan (suggestions, not adopted)

- The ownership concern that gated the Codex adapter did not materialize in
  any tested configuration (the tested builds and the shared-`CODEX_HOME`
  topology), so `codex queue` looks viable for M2 on that point. The live
  canary must still confirm it against the ChatGPT-owned server.
- Adapter constraints that follow from the observations: argv without a shell
  and with only `--thread` and `--message`; the owner's `CODEX_HOME`, never
  the supervisor's runtime home; a submission timeout above 10 s, so a wedged
  daemon is told apart from a slow one; success only on exit 0, and any other
  outcome treated as failed or uncertain.
- Expect up to about 10 s of wake latency. The proof matrix's "one correlated
  wake turn" should allow roughly 15 s.
- Triangle should track one outstanding hint per binding and coalesce, because
  Codex will not, and stale hints replay as separate turns when the app comes
  back.
- Still unproven for the live canary: whether the ChatGPT-owned server polls
  and auto-dispatches like the stand-in; how the app UI shows and handles the
  injected message, including for a conversation that is not in view; and the
  effect on a half-typed draft.

### Reproduction

The harness, its sandbox-profile generator, the pinned builds and the logs are
in [the assets directory](2026-10-21-harness-spike-assets/README.md), committed
together with this report. Nothing in it uses credentials or stores transcript
content.

- `stage-a/bin/run-all.sh` runs all thirteen scenarios and records the pinned
  versions, one exit code and duration per scenario, sanitized driver logs,
  every `codex queue` invocation, and a before/after check of the real Codex
  servers and writer locks. `stage-a/bin/gen-schema.sh` regenerates the protocol
  facts (`stage-a/results/queue-protocol.txt`).
- `stage-a/results/reported-run/` holds the logs behind the numbers above.
- `stage-a/results/rerun/` holds a rerun from the preserved copy (2026-10-22
  06:29Z onward). All thirteen scenarios exited 0 (about four minutes in total).
  Every row of the results table reproduced, the five idle-latency trials landed
  within 0.1 s of the reported ones, the real managed daemon (PID 16779), the
  writer-lock holder (PID 39686), the two lock files and the two entries in the
  daemon socket directory were identical before and after, and no harness
  process or temporary socket was left. The exit code means a scenario ran to
  the end; the observations are in the logs.
- Preserving the harness exposed two defects in it, neither of which changed an
  observation: the process watcher could list unrelated commands that merely
  mention "codex" (icon thumbnailers the ChatGPT app starts), and an uncleared
  timer kept each scenario's process alive for up to a minute after it
  finished. Both are fixed in the preserved copy, so the `spawned` lists in the
  reported-run logs can differ from the rerun's for that reason only.

## Live canary protocol (DRAFT, awaiting owner sign-off)

Nothing in this section has been run. The live steps need the sign-off block
below completed in chat. D7-R approves desktop push. It does not approve
experiments that inject text into a live conversation, hence this protocol.

### Purpose and limits

- Show that `codex queue` delivers one harmless, correlated message into a
  conversation owned by the ChatGPT app's own server, idle and busy, without
  creating a second owner. This closes the gap Stage A left: the real owner
  and the real app UI.
- Triangle is not involved. No supervisor, adapter, binding, `triangle-local`
  or MESH state is read or changed. This tests the Codex primitive only.
- An ad hoc exchange with the token `CANARY_QUEUE_OK` already sits in the bound
  conversation's transcript, from before this protocol and before sign-off. The
  collector reads it as one queue-triggered turn that started 2026-10-22
  04:28:49Z (21:28:49 PDT, before the 21:29 relaunch of ChatGPT), with exactly
  that reply and no tool-like records. Its operator, command and
  queue-to-dispatch timing were not recorded, so it is not counted as B2
  evidence. It does show that the ChatGPT-owned server records a
  queue-dispatched turn with `turn_trigger: queue`, and that the collector parses
  a real transcript of the app's format (20,709 lines).
- Not covered: ChatGPT closed or relaunched, simultaneous MESH and local hints,
  crash windows, long idle periods, Claude, Grok.

### Sign-off (the owner answers in chat; the answers are recorded here)

- [ ] The message template below and the tokens in the sequence table are
  approved as written (or edited: ______)
- [ ] B1, on a new dedicated canary conversation, is approved
- [ ] B2, on the bound conversation, is approved: after B1 passes; idle only,
  or idle and busy
- [ ] Operator: the owner types each command, or the assistant runs each step
  on a per-step go-ahead
- [ ] Time window, with the owner watching ChatGPT (about 30 minutes for B1,
  10 for B2)
- [ ] The canary conversation afterwards: keep, archive or delete
- Approved by ______ on ______ (local time)

### What the owner will see

An ordinary user message appears in the target conversation, carrying the
template text. The agent answers with one line, `canary ack TOKEN`. Your
configured `notify` program (the Computer Use client, `turn-ended`) runs at
the end of the turn, as after any turn. `~/.codex/hooks.json` has only a
`SessionStart` hook, so it should fire only when the new canary conversation
is created. The turn runs at your configured model and effort (`gpt-6-luna`,
high), with your `AGENTS.md`, like any other turn. In the busy run the message
waits until the `sleep 45` turn ends.

### Ground rules

1. One command per run. Never retry or resend; a failure is a result.
2. The command has only `--thread` (by UUID) and `--message`. Run it from an
   empty directory with `CODEX_HOME` unset.
3. Do not use Triangle or the daemon commands, do not kill, restart or quit
   anything, and never edit `queue_1.sqlite`. No CLI command removes a queued
   item; if the app shows one, only the owner removes it there.
4. The owner watches the app and does not type in the target conversation
   during a run.
5. Evidence uses line numbers, timestamps and counts. Quote only the canary
   and acknowledgement lines in the report, never other transcript content.
6. Stop at the first abort condition. Nothing continues "to see what happens".

### Sequence

| Run | Target | State when the command runs | Token | Shows |
| --- | --- | --- | --- | --- |
| B0 | any | any | none | Read-only preflight, repeated right before every run. |
| B1-SETUP | New conversation in an empty scratch folder (not a repository) | The owner types the setup prompt below | none | Creates the target and captures its thread id. |
| B1-IDLE | Canary conversation, in view | Idle | B1-IDLE-01 | Idle delivery, visible. |
| B1-BG | Canary conversation, another conversation in view | Idle | B1-BG-01 | Delivery to a conversation that is not in view. |
| B1-DRAFT (optional) | Canary conversation, in view | Idle, with an unsent draft the owner typed | B1-DRAFT-01 | Whether delivery disturbs a half-typed draft. |
| B1-BUSY | Canary conversation, in view | Mid `sleep 45` turn, 10 to 20 s in | B1-BUSY-01 | Queued behind the turn, then run after it. |
| B2-IDLE | Bound conversation `01a14c05-6603-7921-b744-659195a490a5` | Idle | B2-IDLE-01 | The exact thread the plan is about. |
| B2-BUSY (optional) | Bound conversation | Mid a turn the owner starts | B2-BUSY-01 | Only if the owner wants it; B1-BUSY already covers the mechanism. |

B2 runs only after every B1 run that was approved has passed, and only with a
fresh go-ahead from the owner.

### Preconditions

1. The sign-off block is complete.
2. The B0 preflight passes: exactly one holder of the target thread's lock, a
   `codex app-server` whose parent is `ChatGPT.app/Contents/MacOS/ChatGPT`;
   `command -v codex` is the Homebrew binary; `CODEX_HOME` is unset; and no
   queued items exist for the target.
3. The target is in the state the run needs: for idle, no spinner, no pending
   approval and no queued message shown; for busy, the `sleep 45` turn running.
4. The owner is at the Mac and has nothing in the target they would mind
   interrupting (B2).

B0, copy and paste. It reads only; the last line opens the live queue database
read-only and was validated against a throwaway database only.

```bash
THREAD=01a14c05-6603-7921-b744-659195a490a5   # B2 target; for B1 use the canary thread id
echo "codex on PATH : $(command -v codex) ($(codex --version))"
echo "CODEX_HOME    : ${CODEX_HOME:-unset (default ~/.codex)}"
LOCK=~/.codex/thread-writer-locks/$THREAD.lock
HOLDERS=$(lsof -t "$LOCK" 2>/dev/null | tr '\n' ' '); echo "lock holders  : ${HOLDERS:-none}"
for p in $HOLDERS; do ps -o pid=,ppid=,lstart=,command= -p $p | cut -c1-150; echo "  parent: $(ps -o pid=,command= -p "$(ps -o ppid= -p $p | tr -d ' ')" | cut -c1-90)"; done
echo "owner build   : $(/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --version)"
echo "ChatGPT app   : $(defaults read /Applications/ChatGPT.app/Contents/Info CFBundleShortVersionString) (build $(defaults read /Applications/ChatGPT.app/Contents/Info CFBundleVersion))"
D=$(pgrep -f 'app-server.*managed-daemon' | head -1); echo "managed daemon: pid ${D:-none} $(ps -o command= -p "$D" 2>/dev/null | grep -o 'releases/[^/]*')"
echo "control socket: $(ls -l ~/.codex/app-server-control/app-server-control.sock 2>/dev/null | awk '{print $1}')"
echo "rollout       : $(find ~/.codex/sessions -name "*${THREAD}*.jsonl" | head -1)"
echo "queued items  : $(/usr/bin/sqlite3 -readonly ~/.codex/queue_1.sqlite "select count(*) from queued_items where thread_id='$THREAD'")"
```

Values at the 23:08 PDT dry run (every line except the queue count): `codex`
at `/opt/homebrew/bin/codex`, version `0.163.0`; `CODEX_HOME` unset; one lock
holder, PID 39686, parent ChatGPT.app PID 39266; owner build
`0.163.0-alpha.11.1`; ChatGPT app `26.1016.61520` (build 21421); managed
daemon PID 16779 (`0.163.0`); control socket present (a symlink); two lock
files, the bound thread and `01a161e0-41f9-7720-9429-863c06fe1b1b`. Re-read
them at run time. Drift is recorded, not an abort, except a changed lock
holder (A1).

### B1-SETUP: create the target and capture its id

1. In a terminal, before creating anything:

```bash
ls ~/.codex/thread-writer-locks/*.lock | xargs -n1 basename > "${TMPDIR:-/tmp}/locks.before"
```

2. In the ChatGPT app, start a new conversation in an empty scratch folder and
   type this setup prompt:

```
Triangle canary thread setup TRIANGLE-CANARY-SETUP-01. Reply with exactly: ready.
```

3. After the reply, in the terminal:

```bash
ls ~/.codex/thread-writer-locks/*.lock | xargs -n1 basename > "${TMPDIR:-/tmp}/locks.after"
diff "${TMPDIR:-/tmp}/locks.before" "${TMPDIR:-/tmp}/locks.after"
THREAD=<the one new file name without .lock>
R=$(find ~/.codex/sessions -name "*${THREAD}*.jsonl" | head -1)
grep -c TRIANGLE-CANARY-SETUP-01 "$R"
python3 docs/reviews/2026-10-21-harness-spike-assets/canary/canary-evidence.py "$R" TRIANGLE-CANARY-SETUP-01 --ack-text ready --list-kinds
```

Run from the repository root. The thread id is accepted only if exactly one new
lock file appeared, the same server PID holds it, and the grep count is at
least 1. That ties the id to the conversation by content, not by title.

The collector run on the setup exchange is a format check of the evidence
tooling against a real turn of your configured model, before any canary. It must
print PASS. If it prints INCONCLUSIVE only because of record kinds the real app
writes that the collector does not yet know (for example reasoning records), the
owner reviews the `--list-kinds` output and adds each plainly benign kind with
`--allow`, and the protocol records which. Do not type in the conversation again
except as the protocol says.

### Message template

The text has no quotes, backticks, dollar signs or backslashes, so it survives
shell quoting unchanged. `TOKEN` is the value from the sequence table. For
B1-IDLE-01 the expanded text is 252 characters:

```
[Triangle wake canary B1-IDLE-01] Automated test notification sent with codex queue, not typed by the user and not a task. Reply with exactly one line: canary ack B1-IDLE-01. Do nothing else: no tools, no commands, no file reads or edits, no questions.
```

The busy prompt the owner types for B1-BUSY (and B2-BUSY):

```
Triangle canary busy turn. Run exactly one shell command, sleep 45, then reply with exactly: busy done. Do nothing else.
```

### Procedure for each run

1. Terminal 1: run B0 and confirm the target is in the state the run needs.
2. Terminal 2: start the observer and leave it running (Ctrl-C ends it):

```bash
THREAD=<id>; RUN=B1-IDLE-01
while true; do printf '%s lock=%s servers=%s\n' "$(date -u +%H:%M:%S)" "$(lsof -t ~/.codex/thread-writer-locks/$THREAD.lock 2>/dev/null | tr '\n' ,)" "$(pgrep -f 'codex.*app-server' | tr '\n' ,)"; sleep 1; done | tee "${TMPDIR:-/tmp}/canary-$RUN.observer"
```

3. Terminal 1: run the command once.

```bash
THREAD=<id>; TOKEN=B1-IDLE-01
cd "$(mktemp -d)"
T0=$(date -u +%Y-%m-%dT%H:%M:%S)Z; echo "T0=$T0"
MSG="[Triangle wake canary $TOKEN] Automated test notification sent with codex queue, not typed by the user and not a task. Reply with exactly one line: canary ack $TOKEN. Do nothing else: no tools, no commands, no file reads or edits, no questions."
codex queue --thread "$THREAD" --message "$MSG"; echo "exit=$?"; date -u +"done %H:%M:%S"
```

4. Watch the app. Note when the message appears and when the reply ends. Allow
   60 s. Do not touch anything.
5. When the canary turn has completed, or after 60 s, collect the evidence
   with the strict collector, from the repository root. For B1-BUSY and
   B2-BUSY add `--after-token "Triangle canary busy turn"`.

```bash
R=$(find ~/.codex/sessions -name "*${THREAD}*.jsonl" | head -1)
python3 docs/reviews/2026-10-21-harness-spike-assets/canary/canary-evidence.py "$R" "$TOKEN"
echo "collector exit=$?"
```

   The collector parses the rollout as JSON. It requires exactly one canary
   user message, a matching turn with a start marker and an explicit
   `task_complete`, and it counts tool-like and unrecognised records only inside
   that turn. A missing marker, a truncated file, interleaved tool activity from
   another turn or an unknown record kind gives INCONCLUSIVE or FAIL, never
   PASS. It prints counts, ids, timestamps, the turn trigger and the
   acknowledgement line only. Exit codes: PASS 0, FAIL 1, INCONCLUSIVE 2. Its
   19 tests (including a missing completion marker, a truncated transcript and
   interleaved events) and a run against a real rollout are described in the
   assets README.
6. Re-run the lock-holder and queued-items lines of B0, then fill in the run
   record.

### Pass criteria (all must hold)

- C1. The command exits 0 and prints exactly `Queued message UUID for thread
  THREAD.`, in 15 s or less (expected well under 1 s).
- C2. The lock holder is the same single PID before, during and after, still a
  child of ChatGPT.app. No new process takes the thread's lock. The managed
  daemon PID is unchanged.
- C3. Idle runs: a turn starts from the canary text within 60 s (expected 10 s
  or less) with no action in the app. Busy run: the `sleep 45` turn finishes
  with its normal output, untouched, and the canary turn starts within 60 s
  after it; the collector's `--after-token` check confirms the busy turn ended
  with `task_complete` before the canary turn started.
- C4. The collector prints PASS: exactly one canary user message, one matching
  turn with a start marker and an explicit `task_complete`, one assistant
  message containing `canary ack TOKEN`, and no tool-like or unrecognised
  records in the turn. INCONCLUSIVE is not a pass. The owner reviews it and,
  only for a record kind that is plainly benign, reruns with `--allow` and
  records that. FAIL is a failure.
- C5. The queued-items count for the target is back to its pre-run value
  within 60 s of the turn starting.
- C6. No error, prompt, stuck spinner or crash appears in the app, and the
  owner's unsent draft (B1-DRAFT) is unchanged.
- C7. Latency (T0 to the user line's timestamp) is recorded. It is a
  measurement, not a pass condition.

### Abort criteria (stop at once and report; no retry, no cleanup by force)

- A1. At preflight, the target's lock does not have exactly one holder, the
  holder is not a `codex app-server` child of ChatGPT.app, or the holder PID
  differs from the previous run without a ChatGPT relaunch. Re-run B0 and
  re-confirm before proceeding.
- A2. The target is not in the state the run needs: busy when idle was
  expected, a pending approval, a queued message already shown, or a draft the
  owner wants to keep (other than B1-DRAFT).
- A3. The command exits non-zero, prints anything but the expected receipt, or
  takes longer than 15 s. Do not retry.
- A4. During or after a run the lock holder changes, a second `codex
  app-server` takes the thread's lock, or any new process holds it. This would
  contradict Stage A's central finding.
- A5. No canary turn starts within 60 s (idle) or within 60 s after the busy
  turn ends. Do not resend. Record FAIL, check the queued-items count, and
  leave the item alone.
- A6. More than one canary turn starts for one command, or any canary turn
  starts without a command.
- A7. The agent does anything beyond the acknowledgement: a tool call, command,
  file read or edit, network access, a question, or a reply that is not the ack
  line. The owner presses Stop in the app; later runs do not proceed.
- A8. The app shows an error, crash, approval prompt caused by the canary, or
  stuck state, or the owner's draft changes unexpectedly.
- A9. The busy turn is interrupted, altered or loses output because of the
  canary.
- A10. The owner calls it off for any reason.

After an abort: issue no further commands against the target, kill nothing,
run the post-run sweep below, and record what happened.

### Run record (one per run)

- Run and token; operator; T0 (UTC) and end time; local time.
- Target: full thread id, conversation title, kind (canary or bound), state
  before (idle or busy), in view or not.
- Environment: macOS version; ChatGPT app version and build; owner server
  build; `codex --version` and `command -v codex`; daemon PID and release;
  `CODEX_HOME`.
- Preflight values: lock holder PID and parent; daemon PID; control socket
  type; queued items before.
- Command: the exact `--message` text, exit code, stdout verbatim, seconds.
- Observer log: file path; any change in the lock holder; any new server PID.
- Collector output, verbatim: verdict, turn id, turn trigger (`queue` means the
  server dispatched it from the queue; anything else means a client did; both
  count as delivery, so record which), start and end lines, timestamps, record
  counts and, for busy runs, where the preceding turn ended. Latency from T0.
- Agent behavior: the acknowledgement line verbatim and any extra text; tool
  activity as the collector reports it.
- What the owner saw: how the message appeared; any queued indicator; any
  notification or badge; where it landed relative to the busy turn; the draft.
- Queued items after, and when checked.
- Result against C1 to C7 (PASS, FAIL or INCONCLUSIVE), with reasons, and any
  deviation from the predictions below.

### After the run

- About 15 minutes later: the queued-items count for each target is back to
  its pre-run value, the lock holder and daemon are unchanged, and the owner
  confirms no stray canary turn appeared.
- Append the run records to this report under a new heading, `## Live canary
  results`. Copy no transcript content beyond the canary and acknowledgement
  lines.
- The owner decides whether to keep, archive or delete the canary conversation.
  The exchange stays in Codex's transcript store unless the conversation is
  deleted.

### Predictions from Stage A (so deviations are visible)

- Exit 0 and the receipt line in under a second.
- Idle: a turn starts by itself within about 10 s. Busy: the message waits and
  runs within about 10 s of the turn ending. Exactly one turn per message.
- Lock holder, daemon and server PIDs unchanged. Queued-items count returns to
  its pre-run value.
- The message shows as an ordinary user message with no marker of origin.

### Outcomes

| Result | Consequence |
| --- | --- |
| Every approved B1 run and B2-IDLE pass | Record "Codex queue proven against the ChatGPT-owned server" in the plan's M0 status. M1 and M2 may use `codex queue` as the Codex transport, subject to their other gates. |
| B1 passes, B2 fails | Treat as specific to the bound thread. Investigate its context and settings. Do not enable push. |
| Delivery does not happen (A5) | Codex push stays OFF; use pull. Evaluate protocol-level access or hooks. No second-owner fallback. |
| Any ownership anomaly (A4) | Stop. Treat as an incident and report at once. |
