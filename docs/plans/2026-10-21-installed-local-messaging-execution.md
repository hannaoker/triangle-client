# Installed local agent messaging execution plan

> Implementer: use risk-based TDD. Write failing tests for each new behavior and reproduce review defects before fixing them.

Status: execution authorized by user on 2026-10-21. Baseline: upstream main 2443d5f (#105 and #106 merged).
Goal: this existing Codex conversation delegates a bounded coding task to installed gravity2 through the single installed Triangle supervisor, then retrieves and independently verifies its reply and artifacts.

## Motivation and target

#106 supplies tested libraries, not an installed workflow. Complete their production adapters and lifecycle rather than starting another supervisor or importing private APIs from a temporary launcher. Same-host messages remain local; harness inference can still contact its provider. No Iroh or MESH message-delivery fallback.

Installed CLI and MCP entry -> authenticated bound-sender credential exchange -> one installed supervisor -> durable shared-journal adapter and one recoverable dispatcher -> existing Antigravity runner/profile policy -> journaled reply -> explicit retrieve/consume. Replies stay free-form. Native Codex MCP hot attachment is unproven; the supported installed CLI is the immediate tool path, MCP uses the same control API and may need host reload.

The current app-server binding is disabled and points at an older thread. Preserve its existing agent identity and enabled state. Explicit local owner setup must bind the desktop sender to the current thread without silently selecting codex-headless, enrolling another identity or enabling inbound App Server wakes. Record any inability to validate that binding as an acceptance blocker.

## Slice 1: durable production adapters (Antigravity ownership)

Files: new packages/agent-worker/src/shared-delivery-journal.mjs, local-messaging-journal.mjs, local-messaging-dispatcher.mjs; minimal extraction in peer-drain-service.mjs; matching tests. Other agents own supervisor/CLI/packaging; do not edit them.

- Extract reusable private SQLite opening/ownership/path safety from the peer drain; preserve existing peer schema and behavior. Local adapter must use that shared implementation and custody rules, not promote the test fixture database to production or take a second owner lock on the same file.
- Production adapter implements #106 journal contract with atomic full-envelope identity, expected-sender/correlation checks, bounded reply retrieval/consumption, durable causal ancestry and separate custody/runtime states.
- One execution owner claims queued records atomically; crash recovery holds uncertain started executions rather than rerunning them. Queued work resumes. Duplicate notifications/retries never overlap.
- Dispatcher uses injected existing runner and shared supervisor reasoner gate; timeout begins at actual admission. Per-profile execution serialization prevents same-harness overlap. Retain custody until underlying runner terminates. Shutdown waits for complete persistence/admission/execution.
- Tests: reopen persistence, competing owner, duplicate conflict, reply spoof, queued/uncertain restart, concurrency, failed runner, shutdown under delayed admission. No live settings, installs or network tasks.

## Slice 2: supervisor and installed control surface (Codex ownership)

Files: client-supervisor.mjs, client-supervisor-cli.mjs, local-messaging server/seam and executable CLI/MCP entries; focused tests.

- Validate opt-in local configuration and map registered recipient identities to existing resolved runners. Reuse existing execution gate, preserve MESH claim ownership, never add an independent poller for local work.
- Host journal/dispatcher/subsystem lifecycle inside the existing supervisor with startup readiness, failure rollback, isolated diagnostics, orderly shutdown.
- Protected owner-created integration binding fixes sender identity, thread and allowed recipients. A broker authenticates the binding capability and issues short-lived per-call credentials; caller-supplied identity/thread alone is insufficient. Signing secrets stay in supervisor; credentials do not appear in outputs/logs.
- Add supported executable commands for setup/bind, discover, send, status, replies and consume, and MCP stdio mode. Bounded waits return IDs usable after reconnect; no generated script or direct SQLite access for normal operation.
- Child agent turns receive constrained sender/ancestry context; root desktop binding is separate from recipient turns. Enforce existing ACL/rate/loop policy and profile execution policy.

## Slice 3: bootstrap, bundles and diagnostics

Files: Swift ClientSupervisor.swift/WorkerLauncher.swift and contracts, scripts/triangle-worker-install.py, bundle-closure tests, release docs.

- Carry local bootstrap through actual Swift/helper -> Node launch. Preserve disabled defaults and existing lanes.
- Version the exact manifest/Swift artifact allowlists together and include complete import closure; test bundles for every existing harness type.
- Status/doctor reports local route, sender binding, queue/held/runtime health. Missing/disabled is explicit, never healthy by omission.
- Build and stage a reviewed artifact. Back up installed binaries/configuration and service state before replacement; preserve keys, agent identity, harness settings and existing messages.

## Acceptance matrix

1. One installed supervisor owns existing lanes plus local route. No temporary supervisor launcher.
2. Actual installed CLI identifies this conversation's sender and discovers gravity2.
3. Read-only echo request and correlated reply, retrieved after client disconnect; explicit consumption only.
4. Small coding task in dedicated writable checkout: Antigravity makes a bounded change and runs tests; Codex inspects actual diff/test result independently. No automatic merge necessary for proof.
5. Restart service with queued work/replies: recover queued, retain reply, show uncertain work held. No silent replay or duplicate execution.
6. Wrong binding/sender/recipient, expired token and forged reply are refused; no secret leakage. Same-user developer-mode limits documented.
7. Existing MESH/headless/ACP behavior and bundle closure remain intact. Local routing can be tested with delivery network disabled using a fake runner; real model inference requires provider connectivity.
8. MCP protocol subprocess test; host reload requirement reported honestly. Do not claim current-session native tools if only CLI is usable.

Run focused tests at each slice, package checks at integration, one final broad suite with known baseline failures distinguished. Independent review before install/cutover and after material corrections. User authorized implementation and necessary reversible local activation; no unrelated cloud deploy or identity reenrollment.

Finish by recording exact source/install versions, sender/recipient identity, message/correlation IDs, durations, independently inspected coding artifacts, limitations and rollback location. A passing mock test is not the installed milestone.
