# Harness spike assets (2026-10-21)

Evidence and tooling behind [the harness adapter spike report](../2026-10-21-harness-adapter-spike.md).
Nothing here is product code, and nothing is wired into the test suite.

| Path | What it is |
| --- | --- |
| `stage-a/bin/` | The Stage A harness: driver, mock model provider, sandbox-profile generator, runner scripts. |
| `stage-a/results/` | Pinned versions, exit codes and logs: `reported-run/` behind the numbers in the report, `rerun/` from this preserved copy. |
| `canary/` | `canary-evidence.py`, the strict evidence collector for the live queue canary, and its tests. |

## Stage A: what `codex queue` does

The harness starts Codex app-servers in a throwaway `CODEX_HOME` and `HOME`, with a mock model provider on
127.0.0.1, and runs `codex queue` against them. It exists to learn how the queue behaves without touching the real
`~/.codex`, the real managed daemon or any real conversation, and without credentials.

**Requirements.** macOS with `sandbox-exec`, Node 22, Python 3, `/usr/bin/sqlite3`, and two Codex builds: a client
(`CLIENT_BIN`, runs `codex queue` and the persistent server; the Homebrew build) and an owner stand-in (`OWNER_BIN`,
the ChatGPT-bundled build). Defaults are in `stage-a/bin/lib.mjs`. `bin/versions.sh` records the exact versions and
SHA-256 of both binaries.

**Isolation.** `bin/make-profiles.sh` writes two Seatbelt profiles. Every experiment process (driver, mock, owner,
CLI) runs under them. They deny file access to the real `~/.codex`, the live Triangle install and its logs, and the
real managed daemon's socket and lock; deny all outbound IP except loopback; and deny connecting to the real daemon
socket. They were checked with allow/deny decoy sockets before use. The mock provider needs no credentials and the
harness never reads any.

**Running.**

```bash
cd docs/reviews/2026-10-21-harness-spike-assets/stage-a
WORK=/tmp/stage-a-work bin/run.sh idle        # one scenario
WORK=/tmp/stage-a-work bin/run-all.sh         # all thirteen, with exit codes, logs and a real-state check
bin/gen-schema.sh /tmp/stage-a-work           # protocol facts from the generated experimental JSON Schema
```

Four scenarios (`remote`, `daemonabsent`, `discover`, `topology`) create a unix socket under `/private/tmp/sa-stageA`,
a short path because macOS limits socket paths to 104 bytes. The scenario removes it when it ends.

**Scenarios.**

| Scenario | Checks |
| --- | --- |
| `smoke` | The mock provider, the throwaway home and a plain owner turn work. |
| `nosrv` | `codex queue` with no server and an unknown thread: error, embedded server, no daemon. |
| `twoowners` | A second server's `thread/resume` on a thread whose writer lock another server holds. |
| `idle` | Queue to an idle owner; invoker flags; same `clientUserMessageId` twice while queued. |
| `busy` | Queue to an owner mid-turn: waits for the turn boundary. |
| `multi` | Several messages back to back, idle and busy: one turn each. |
| `latency` | Five idle trials: time from `queue` to the owner starting the turn. |
| `absent` | Thread on disk, no owner: nothing runs; a later owner runs it. |
| `remote` | Explicit `--remote` to an owner that exposes a unix endpoint. |
| `daemonabsent` | A persistent server (like the managed daemon) with the thread loaded nowhere. |
| `discover` | A black-hole socket at the managed daemon's control-socket location. |
| `topology` | Healthy persistent server at the control socket plus a separate stdio owner. |
| `dedupehist` | The same `clientUserMessageId` after the first item was already dispatched. |

**Results.** `stage-a/results/rerun/` holds, for one pass over every scenario: `versions.txt`, `exit-codes.txt`
(one line per scenario with its exit code and duration), `<scenario>.log` (the driver log), `<scenario>.cli-runs.jsonl`
(each `codex queue` invocation with argv, exit code, output and the processes it spawned), `real-state.*.txt` and
`leftovers.txt`. `stage-a/results/reported-run/` holds the same driver logs and CLI records from the run behind the
numbers in the report. Paths are sanitized (`$WORK`, `~`). The exit code is the driver's: 0 means the scenario ran to
the end, not that a particular observation matched. Observations are in the logs and are interpreted in the report.
The `latency` trials run back to back, so each lands at a similar phase of the owner's roughly 10 s poll; they show
the bound (about 10 s), not the spread a random arrival time would give. Other timings vary from run to run.

**Limits.** The owner is a stand-in started by the driver, not the ChatGPT app's own server, and no app UI is
involved. `sandbox-exec` is deprecated by Apple but works on the tested macOS. The harness covers `codex queue`
only.

## Canary evidence collector

`canary/canary-evidence.py ROLLOUT TOKEN [--ack-text TEXT] [--after-token TEXT2] [--allow KIND] [--list-kinds]` reads
a Codex rollout and prints facts only: counts, turn id and trigger, timestamps, record kinds and the acknowledgement
line. Exit codes: PASS 0, FAIL 1, INCONCLUSIVE 2. PASS requires exactly one canary user message (both of its record
forms), one matching turn with a start marker and an explicit `task_complete`, zero tool-like and zero unclassified
records in that turn, and exactly one assistant message containing the acknowledgement. A missing boundary, a
truncated or unparseable transcript, interleaved tool activity or an unrecognised record kind can never produce PASS.
`--after-token` is for busy runs: it also requires the preceding turn (found by its user text) to have ended with
`task_complete` before the canary turn started.

`python3 canary/test_canary_evidence.py` runs 19 cases on synthetic rollouts, including a missing completion marker
with a tool call, a truncated transcript, interleaved events from another turn, duplicate delivery, an aborted turn
and the busy-run ordering check. The collector was also run against two real rollouts: a Stage A rollout (PASS) and
the bound conversation's rollout for an earlier ad hoc exchange, a 20,709-line file written by the ChatGPT-owned
server (PASS; that exchange is described in the spike report).

## Privacy

No credentials are used or stored. Throwaway homes are not copied into the repository. Logs contain thread ids,
process ids, canary text and harness paths only. The collector never prints transcript content other than the
acknowledgement line of the canary turn.
