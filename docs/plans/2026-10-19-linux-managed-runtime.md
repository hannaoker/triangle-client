# Linux managed runtime — Codex first

User approved implementing Linux durable delivery, per-user lifecycle, status,
logs and doctor, with real Codex end-to-end/restart/redelivery proof. Keep the
Mini lanes and their identities untouched. Other harness adapters follow Linux
validation; do not label untested integrations supported.

## Architecture

New private Node package `packages/linux-runtime`, bundled with Linux releases.
The trusted service host reads only the selected workload key and public agent
metadata, not the owner signing key. Reuse shared Ed25519/DPoP and transport;
port the native transaction invariants rather than the in-memory polling map.
One systemd --user unit per profile; private XDG runtime state and model homes.
No network control API: CLI uses private configuration/journals and systemctl.

The model runner receives bounded JSON via stdin and returns bounded JSON stdout.
Wrap the outer Node runner in fail-closed bubblewrap: isolated mount/PID/proc,
private temporary space, approved system/runtime mounts, read-only workdir,
writable isolated model home, provider network. No broad home mount, host proc,
owner/workload files, inherited secrets, or daemon FD. Preflight a real sandbox
before enrollment/start. Codex auth may be copied into its private model home;
never copy unrelated settings or place MESH credentials in model state.

Journal metadata only; no inbound or reply text at rest. Stable claim and reply
IDs match the existing helper. Prepare before claim; persist execution admission
before starting a model. Renew claims during work and abort on ownership loss.
On crash during execution or unresolved result/reply, reconcile the deterministic
reply key then quarantine unknown outcomes rather than silently rerunning a turn.
A verified replied record permits ACK-only recovery. Receipt-only deliveries
never start a model. Known runner failure can retry with bounded backoff; ambiguous
execution requires explicit `service retry --delivery ID --yes` after inspection.
No exactly-once inference or new expiry guarantee is claimed.

## Shared interfaces and ownership

Parent owns `paths.mjs`, `runner.mjs`, `host.mjs`, package metadata/build integration,
public docs, release tests and actual Linux/systemd/provider proof. Paths exports:
`linuxPaths({env,accountHome}) -> {dataRoot,stateRoot,profilesRoot,modelsRoot,workspacesRoot,unitsRoot}`;
`readProfile(profile,{env,accountHome})`, `writeProfile(config,{env,accountHome})`,
`profilePath(profile,options)`, `validateProfile(config)` and private FS utilities.

Profile schema1 exact fields: profile, agentId, identityHome, authority, via(null
or origin), harness(codex), command, bwrap, node, releaseRoot, workdir, modelHome,
stateRoot, pollIntervalMs(30000 default), runnerTimeoutMs(600000 default).
StateRoot is `XDG_STATE_HOME/triangle/runtime-v1/agents/AGENT_ID`; profiles reside
under runtime-v1/profiles. ModelHome: XDG_DATA_HOME/triangle/model-state/PROFILE.
All paths absolute/canonical, private application roots, no symlink aliases.

Transaction worker owns `store.mjs`, `transport.mjs`, `transaction.mjs` and tests.
`openStore({root,agentId}) -> {withLock(async fn),get(),save(record),clear(),status(),
writeHealth(value),readHealth(),retry(deliveryId),close()}`. Kernel-held SQLite
writer lock separate from atomically persisted journal/health. Records schema1
bind agentId and deterministic instanceId, delivery identity, claim ID/reply key,
phase(prepared|claimed|executing|failed|replying|replied|quarantined), reply digest
and verified reply event ID, failure count/reason/timestamps. No bodies.
`createTransport({identityHome,agentId,env,fetchImpl})` -> validated request methods
per existing MESH API, including verify(), list(), claim(record), inbound(record),
findReply(record), reply(record,text), ack(record). No owner key read.
`createCustodian({store,transport,runner,agentId,now,hook}) -> {cycle({signal}),retry(deliveryId)}`.
Runner exposes run(request,{signal}) -> {status:'completed',text}. Cycle serializes
one transaction, records secret-free health, renews lease, handles safe restart.
Hook is a test-only injected function, never environment-controlled production.

Service worker owns `setup-runtime-linux.mjs`, Linux `service.mjs` control module,
`setup.mjs` platform dispatch, CLI service/status/doctor integration and tests.
Adapter same preflight/configure/status interface as macOS; stable agent binding
is returned before new enrollment. CLI: `service start|stop|status|doctor|logs|retry
--profile NAME [--delivery ID --yes] [--lines N]`. Internal `service run --config
PATH` enters parent host (or unit invokes package host directly). Systemd unit
uses bundled Node + host --config PATH, safe quoting, UMask0077, KillMode=control-group,
Restart=on-failure. Keep existing profile binding/mode, no identity replacement.

## Proof matrix

- Actual workload challenge/DPoP request shapes, exact bound event identity,
  deterministic IDs shared with Swift, strict bounded responses.
- Before/after claim, executing crash, lost reply and ACK responses, duplicate
  process exclusion, failed-first-turn retry, receipt-only and paused/revoked agent.
- Lease loss aborts harness and prevents reply/ACK; unknown execution quarantines.
- Sandbox blocks owner/workload key and host proc reads from malicious runner;
  missing/unusable bubblewrap fails closed before invitation consumption.
- Systemd user install/start/stop/restart/readiness, meaningful status/doctor/logs,
  no credentials in units/env/argv/output; configuration collisions rejected.
- Packaged Linux clean install and actual user service with real Codex inference
  over a disposable distinct MESH identity; Mini existing profiles never dual-claim.
- Native Linux tests (ARM64; x64 under existing local emulation) and macOS owner
  CLI/package regression. Independent review in one batch, focused fixes.

## Implementation checkpoint

Implemented the Codex-first runtime, private profile configuration, fail-closed
bubblewrap runner, durable transaction core, systemd lifecycle and Linux package
closure. Live ARM64 MESH/Codex delivery and SIGKILL recovery passed; uncertain
execution quarantines until explicit retry. See
[validation evidence](../reviews/2026-10-19-linux-managed-runtime-validation.md)
for tested boundaries and distribution limitations. Other harnesses remain a
separate follow-up after this Linux milestone.
