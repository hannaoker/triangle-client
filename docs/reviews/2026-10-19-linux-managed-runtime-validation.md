# Linux managed runtime validation — 2026-10-19

## Scope

Codex background execution on Linux, with portable file custody, durable mailbox
transactions and a per-user systemd service. No macOS service, existing agent
binding, production deployment or database was changed. Test messages used a
new disposable agent; that agent was deleted and its Linux credential copies
removed after the proof. Other Linux harnesses remain unsupported.

## Live ARM64 proof

Debian 12 ARM64 container with Node 22.22.3, systemd user manager, bubblewrap and
the official Codex 0.163.0 native executable, running in an isolated local Colima
Linux VM. The host service authenticated to https://thetriangle.dev with only
the new agent's workload identity. Its identity directory contained public
metadata and that workload key, with no owner key. Codex received a separate
private model home containing only its existing provider login.

- A real sandbox probe checked that unmounted canary/identity state and host
  `/proc/PID/root` were inaccessible, the workspace was read-only, and model
  state was writable. A real Codex turn returned `LINUX_SANDBOX_OK`.
- `triangle service start` installed/enabled a real systemd user unit and
  reported a verified matching PID. Doctor/status inspected its durable state.
- Live delivery 19, source `event_fc2b9f81e0b74a20b2c02b0ead42a395`, produced
  `event_0669c7a49614454d8a9df98eda21c067` with `LINUX_SERVICE_DELIVERY_OK`.
  History showed the expected deterministic reply key and source reference;
  the service reported one completion and no pending journal record after ACK.
- Live delivery 21 was interrupted with SIGKILL while the journal said executing.
  Systemd restarted the host with a new PID. It recorded
  `quarantined / unknown_execution`, with no automatic second inference.
  Explicit `service retry --delivery 21 --yes` then produced
  `event_98e5e421377141cdaa089f69eaa1c1db` with
  `LINUX_RESTART_RECOVERY_OK`. History contained one reply to its source event,
  and the journal cleared after ACK. This is conservative recovery, not an
  exactly-once inference claim.
- Stop completed cleanly. No existing Mini profile was restarted or claimed by
  Linux. The test agent was `agent_9ee949b12169cfd5c9d5ad3e046908dd`.

The VM's Ubuntu AppArmor restriction initially rejected unprivileged user
namespace UID mapping. It was relaxed only in this disposable test VM for the
kernel sandbox proof and restored during cleanup. The product does not disable
host security policy: incompatible bubblewrap/user namespace configuration
fails preflight before enrollment. This proof does not establish support for
all distributions or locked-down containers. The test profile polled at 1 s;
production setup retains the existing conservative 30 s default, with no 5 s
latency promise. The first live request-to-reply took about 24 s, including the
provider turn.

## Automated verification

- Owner CLI suite: 85 passed.
- Runtime plus setup suites: 66 passed before adding one further runner
  stderr-sanitization/ambiguous-exit regression; that runner suite passed 4/4.
- Native ARM64 packaging/bootstrap/installer and service suite: 21 passed,
  one intentional non-Linux platform check skipped. A real archive was built,
  extracted, installed and imported using its bundled Node; all runtime and
  Codex runner module dependencies were present.
- Transaction tests cover persisted claim admission, receipt-only messages,
  failed first execution, explicit retry, unknown execution, lost reply/ACK
  responses, ACK-only restart, process locks, paused identity, and lease
  renewal/expiry aborts. Timing-sensitive renewal coverage uses a runner-entry
  handshake and controlled timers rather than a 30 ms wall-clock lease.

## Independent review

Fixed every material finding from the independent review: writable model state
cannot contain trusted host code/executables; nonzero model exits remain
ambiguous; safe root-owned Codex runtime directories work; custom XDG roots are
persisted in systemd's environment and units are enabled by absolute path.

## Limits

A user manager and usable user namespaces/bubblewrap are required. Continuing
after logout requires administrator-configured user lingering. No new expiry
policy, power-loss guarantee or automatic retry of ambiguous inference is
claimed. Linux runtime support is Codex only. The portable package is glibc;
Alpine/musl and a native x64 kernel sandbox remain unverified. Installed services
pin their code release; stop them before removing that release. Package download
publication and deployment onto a user's permanent Linux machine are separate
from this implementation and disposable verification.
