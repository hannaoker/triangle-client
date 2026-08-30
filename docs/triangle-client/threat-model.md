# Triangle Client threat model

## Assets and trust boundary

The protected assets are permanent MESH mailbox tokens, agent-ID/origin
bindings, message confidentiality, profile isolation, and integrity of the code
that can use those identities. Triangle Client assumes a trusted macOS host,
trusted signed local binaries, the user's unlocked login Keychain, and the
configured MESH HTTPS origin.

The Swift host and the local coordinator are inside the trusted computing base.
A permanent token exists in Keychain and remains in trusted-host coordinator
memory for the active service lifetime of each profile because the coordinator
performs authenticated mailbox I/O. This known coordinator memory boundary is
not end-to-end hardware isolation. A reasoning subprocess never receives any
token.

Triangle Client does not protect secrets from a malicious or already
compromised host administrator, injected code inside the trusted coordinator,
Keychain compromise, or a compromised MESH service. It also cannot make an
agent's textual response truthful; adapter/tool policy remains responsible for
what work the model may perform.

## Identity and local isolation

Each profile maps to one fixed adapter and one opaque instance ID. The ID is the
lowercase SHA-256 of the framed domain string
`triangle-client-instance-v1`, a NUL byte, and the profile's UTF-8 bytes. The
full digest names registry, model, cache, and temporary roots; raw profile names
do not become paths.

Registry directories and files require owner-only modes `0700` and `0600`.
Reads recompute the identifier and reject unknown fields, duplicate keys,
unexpected ownership, hard links, and symlink traversal. Updates are serialized
and use exclusive or atomic same-filesystem replacement plus directory fsync.

Immutable runtime code is shared only through a content-addressed bundle whose
manifest, Node executable, and artifacts are re-hashed before launch. Mutable
state is never stored in that shared bundle.

## Secret flow

1. Enrollment sends a one-time admission credential through bounded stdin.
2. The signed helper stores the permanent binding in the non-synchronizing
   Data Protection Keychain and verifies it against MESH.
3. At service start, adapter paths and integrity are checked before credential
   retrieval.
4. The host obtains each exact profile binding and sends a bounded bootstrap
   through an anonymous pipe to the trusted coordinator.
5. The coordinator confines each token to its mailbox client and sends a
   credential-free request to the reasoning adapter.

Tokens are forbidden from process argv, LaunchAgent plists, adapter
environment, profile registry, model filesystem, temporary filesystem, logs,
error descriptions, and result JSON. There is no show or export command and no
fallback plaintext credential file. The adapter sandbox explicitly denies the
credential root and environment files.

## Availability and lifecycle safety

A FIFO global concurrency gate prevents unbounded simultaneous reasoners;
per-profile single-flight preserves ordering. Input/output limits, timeouts,
bounded backoff, cancellation, and TERM-to-KILL escalation constrain stuck or
hostile subprocesses. One profile's failure is isolated from peer loops.

Lifecycle changes are locked and transactional. The service is reloaded and
verified after a registry change. If verification fails, registry state is
rolled back and the previous service state is reapplied. Installation similarly
uses staged files and rollback records. Legacy services are retired only after
the Node coordinator validates its bootstrap, constructs the supervisor, and
the signed host atomically publishes a private mode-`0600` readiness marker. The
marker has a fresh generation, current host PID, bootstrap configuration digest,
and bounded timestamp. Lifecycle control matches it to launchd's current PID and
requires that same running PID to remain stable over a bounded interval. The
coordinator does not begin mailbox polling until legacy consumers are proven
absent and lifecycle control atomically publishes a separate private mode-`0600`
activation marker bound to the ready generation and configuration digest. A
stale marker, crash loop, or merely loaded process cannot retire legacy
consumers. Rollback restores legacy consumers only after the new client is
stopped and explicitly proven absent; otherwise a hard operator error is surfaced
without creating duplicate consumers.

## Residual risks

- A trusted coordinator memory disclosure can expose currently loaded tokens.
- A legitimate model may disclose message content in its provider interaction;
  select adapters and provider policies appropriate for the data.
- Denial of service remains possible through provider outage, Keychain lock,
  MESH outage, disk exhaustion, or resource-heavy prompts.
- Removing an agent intentionally preserves its Keychain identity. Credential
  revocation and deletion require a separately reviewed decommissioning path.
- The current macOS sandbox and Keychain controls do not define a portability
  model for Linux or Windows; this release is macOS only.

Security reports should include the affected Triangle Client release, runtime
adapter, macOS version, and a minimized reproduction with every credential
redacted.
