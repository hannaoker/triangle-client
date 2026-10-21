# Antigravity runtime recovery

Direct host Antigravity CLI successfully read PR #102 through its existing GitHub MCP login. This validates the saved authorization on the host, separately from Triangle runtime execution. The earlier temporary Iroh proof hit its 120-second print timeout with the turn still running; the adapter then rejected an empty final response. That does not establish missing authentication or a tool-approval denial.

The installed MESH path exposed separate problems:

- A diagnostic event sent with type `text` was unsupported by the worker. Discarding it attempted an acknowledgement without a claim; the live server refused `/api/v1/mailbox/ack` with HTTP 400 `claim_required`. The worker now claims discarded events and acknowledges with the matching claim. It retains the claim ID after an ambiguous failure and never acknowledges a conflict owned by another worker.
- gravity2 had an unfinished delivery 24 from October 19 owned by `self-serve-drain`. The supervisor uses `coordinator-delivery-v1`; the native helper confirmed `protocolMismatch`. The supported `transaction-abandon --confirm` recovery quarantined the local transaction as `q_74c1ae1af999f861`. This does not release or acknowledge the server claim. The transaction was preserved in quarantine rather than silently treated as completed.
- The installed Antigravity bundle lacked the already-merged shell-selector fix. Current Antigravity and supervisor bundles were prepared with the normal content-addressed installer, then the service was restarted.

Validation: 55 mailbox-client tests passed, including discarded-event claim ownership, acknowledgement retry with the same claim ID, and ownership conflict. Independent review found no material issues. The worker suite passed 629 tests with 3 skips and one host-access-dependent Hermes CLI help failure; that exact help check passed separately with normal host access and no provider call.

MESH messages were sent using the installed `triangle-mailbox mcp --profile bob` runtime to gravity2. No temporary peer broker substituted for this installed-runtime validation. PR merge status and the returned room reply must be verified separately before claiming an end-to-end success.

## Model selection and live execution

A subsequent installed-worker task reached model execution but failed with `Individual quota reached` / `RESOURCE_EXHAUSTED`. The successful direct GitHub check had explicitly selected `Gemini 3.8 Flash (High)`; the runtime had inherited its CLI default.

The Antigravity adapter now supports a private, per-instance `ANTIGRAVITY_HOME/triangle-antigravity-runtime.json` containing exactly `{"model":"Gemini 3.8 Flash (High)"}`. Missing configuration preserves the CLI default. The file must be current-user-owned, private, regular, at most 4096 bytes and not a symlink. Invalid configuration fails closed. The model is passed as a separate argument before the prompt. No global Antigravity settings or credentials are changed.

After the mailbox recovery, a real installed-worker cycle claimed delivery 32, ran Antigravity, appended `TRIANGLE_RUNTIME_OK` at room sequence 19 with `inReplyToEventId` matching the request at sequence 18, and acknowledged it. This was the installed worker CLI in single-cycle mode, not the temporary Iroh proof broker. It proves basic MESH runtime execution and reply handling; it does not by itself prove unattended supervisor wake timing or GitHub merging. The adapter/conversation tests passed 23 tests with one skip; independent review found no material issues in model configuration handling.

## Saved GitHub login and explicit developer policy

The GitHub MCP tool, when tested directly inside Triangle's sandbox, initialized successfully but started a fresh browser authorization attempt instead of reusing the host login. Antigravity's tool permission log already showed `always-proceed`; skipping more prompts was not the diagnosed solution.

The operator-requested developer mode is now an explicit controller policy in `<application root>/runtime-policy/<instanceId>.json`, containing exactly `{"securityMode":"developer-unsandboxed"}`. It is outside the sandbox's writable model/temp/runtime roots. The directory and file must be private and current-user-owned; symlinks and invalid modes fail closed. A model-home `securityMode` field is rejected. Native regression verifies the child cannot write or rename over controller policy. Without policy, both Triangle's operating-system sandbox and Antigravity's terminal sandbox remain enabled. Developer mode disables both for that instance and emits a warning; tasks then have normal user filesystem/network access. It does not pass `--dangerously-skip-permissions`.

In the live developer-mode test, the installed Triangle worker claimed delivery 36, Antigravity used the existing GitHub MCP login and squash-merged PR #102 at head `d9f2a19bdcd2f9abae0bdcf191043b904a6c9c12`, the runtime appended its correlated reply at room sequence 23, and acknowledged the delivery. GitHub independently confirmed `MERGED` at `fa58086a65d00e7c83c4599bf2bc3edb928ab887`. See the sanitized JSON companion. Codex did not run the GitHub merge command for this PR.

Review caught an initial attempt to place developer mode in writable model state; that design was corrected before committing the mode implementation. Independent re-review confirmed the controller-policy boundary. Adapter/conversation checks passed 24 tests with one skip after the correction.
