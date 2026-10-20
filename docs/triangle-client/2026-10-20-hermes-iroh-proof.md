# Hermes over Iroh: verified local proof

On October 20, 2026, two independent Iroh identities on the Mac mini completed a read-only PR assessment through the new `createProofHermesRunner` adapter. The worker acknowledged execution, the requester received a correlated reply, and the application consumed it. Sanitized identifiers and the reply are in `2026-10-20-hermes-iroh-proof.json`.

The controller fetched PR #101 metadata and diff using its existing GitHub login. Sandboxed Hermes received only that data. The reviewed head was `89a2cd8b27471070dd5ae48a65baa40acf29349b`, containing the shell-selector fix; this assessment does not review the later Hermes adapter changes in the same PR.

## Setup contract

Use a private, isolated `HERMES_HOME` with only the selected model/provider configuration and no unrelated MCP servers. Initialize its own dependency environment with a trusted controller preflight (`hermes status`); do not reuse owner state or permit writes to the owner's install. Discover runtime roots with the installer, including the pinned interpreter, selected dependency generation and exact install facts. Preserve the owner's settings.

Construct `createProofHermesRunner({environment, timeoutMs})` with the existing isolated worker environment. Before starting a broker, call `probe({socketPath})` against the live responder IPC socket and `probeHelp()`. The probe verifies credential and identity read denials, project write denial, and peer IPC connection denial. Supply this runner to the existing proof broker. The controller sends prefetched PR data over Iroh, checks reply sender/request correlation, and calls `consumeReply` at the requester.

The adapter requires native macOS sandboxing and a Hermes CLI supporting `chat --query-file -`. Prompts use stdin; output, input and execution time are bounded. Timeout or cancellation is not evidence of completed work. IP networking permits model access, while Unix peer control remains inaccessible. Provider credentials required for inference remain in the isolated model configuration; GitHub and MESH credentials are not supplied to Hermes.

## Validation and boundaries

The native fake-Hermes adapter tests passed (2 tests, no skips), including cancellation, limits and isolation. The worker package passed 629 tests with 2 skips. Five launcher fixture tests also passed. Independent review found no material issues in the adapter or launcher changes.

This is a same-host, direct-only proof, not a cross-network NAT traversal result, production service rollout, or authorization for GitHub writes. The macOS adapter is proof-only; portable background-service integration remains separate work.

## Explicit developer mode

The proof adapter defaults to `securityMode: 'sandboxed'`. A local controller can deliberately disable the operating-system sandbox:

```js
const runner = createProofHermesRunner({
  environment,
  securityMode: 'developer-unsandboxed',
});
```

This prints a warning and exposes `runner.securityMode` and `runner.isolationEnabled`. Its `probe()` returns `{isolated:false, securityMode:'developer-unsandboxed'}` rather than claiming isolation. Invalid modes are rejected; request text and environment variables cannot select this option.

Developer mode runs Hermes with the controller user's filesystem/network permissions. Environment filtering, the separately configured Hermes home, stdin handling, execution/output limits and cancellation remain, but they are not filesystem isolation: Hermes may read files and credentials available to that user. Only the local controller configuration selects this mode. The mode does not change the installed service or enable writes through GitHub automatically.

The native fixture verifies an actual project write succeeds in developer mode and fails with the default sandbox. Sandboxed behavior retains the live IPC/custody denial probes.

Live developer-mode validation also passed over Iroh on the Mini: Hermes created a temporary file in the configured workspace, reported its directory and file listing, and the requester consumed the correlated reply. The controller independently confirmed the file exists. See `2026-10-20-hermes-developer-proof.json`. An earlier redirection/script attempt was blocked by Hermes's own command-approval rules and quarantined; those rules remain enabled and are distinct from Triangle's operating-system sandbox.
