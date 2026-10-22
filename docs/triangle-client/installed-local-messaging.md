# Installed local messaging

The existing Triangle supervisor hosts the local control socket, production SQLite journal and recoverable dispatcher. It reuses registered profile runners and serializes their local and MESH turns through one shared reasoner gate. Same-host delivery does not use Iroh or MESH. Harness inference can still use its provider's network connection.

## Install and bind

Stage the supervisor runtime with `scripts/triangle-worker-install.py stage-runtime --agent supervisor` and install its wrapper with `install-local-wrapper --application-root ...`. Manifest v9 packages the complete local messaging closure; exact v8 bundles remain valid. The Swift helper must also support v9 and forward the opted-in configuration path.

The installed entry is `~/Library/Application Support/The Triangle/bin/triangle-local`:

```text
triangle-local setup --thread-id CURRENT_THREAD --recipient gravity2
triangle-local status
triangle-local status --message-id STABLE_ID
triangle-local discover
triangle-local send --to gravity2 --text "Task" --message-id STABLE_ID --request-id STABLE_REQUEST
triangle-local replies --request-id STABLE_REQUEST
triangle-local consume --message-id REPLY_ID
triangle-local mcp
```

Use `--rebind-thread` only as an explicit owner action to move the existing desktop binding to the current conversation. Setup backs up the old binding and preserves its identity and disabled inbound wake flag. It does not enroll a replacement identity. Restart the existing client service after setup. A cold multi-profile start can exceed the service script's default ten-second readiness window; `TRIANGLE_READY_TIMEOUT_MS=60000` is available for the supervised activation check.

## Custody and authority

Setup writes private owner configuration and a capability binding to one sender, thread and recipient allowlist. The supervisor authenticates that binding and issues short-lived turn credentials. It rereads the integration capability on every exchange so rotation revokes old exchanges. The supervisor signing key stays in process. A developer running as the same OS user can read owner files; this interface does not isolate mutually hostile processes sharing that account.

Admission means the immutable envelope was durably stored, not that the agent succeeded. Requests are claimed once; exact retries retain their original IDs. Queued requests recover after restart, while uncertain executing requests become held and are not automatically replayed. Replies are correlated, non-consuming on retrieval, and persisted independently of the client connection. Agent assessments remain free-form and must be independently checked.

Timeout starts when the runner actually acquires the reasoner gate. A late success after timeout stays held instead of becoming a normal reply. Shutdown retains journal ownership until underlying execution settles. Status exposes queue, executing, completed, held, pending-reply and dispatcher counts. MESH or provider authentication failures remain distinct from local route health.

## Scope and limits

The CLI is an installed supported path. The MCP stdio entry uses the same socket API and passes subprocess protocol tests, but adding it to an already running Codex conversation may require a host reload. Do not claim native Triangle tools are available until that host actually exposes them.

This milestone proves desktop-to-registered-agent delegation and durable return delivery. Recipient turns do not yet receive a configured outbound Triangle tool for recursive delegation. End-to-end provider availability, repeated long coding tasks, interruption/resume and multi-machine transport require their own evidence; one successful coding task does not establish universal reliability.
