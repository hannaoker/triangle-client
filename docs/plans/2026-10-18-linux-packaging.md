# Linux packaging

User requested Linux packaging after the macOS packaged CLI. Package the existing
portable owner CLI, without claiming a Linux managed mailbox service. The native
Swift supervisor, claim/reply/ack custodian and harness service remain macOS-only.
Linux invitation enrollment and owner controls already use Node and private files.

Deliver native Linux x64 and arm64 archives with bundled compatible Node, its
license, tracked owner CLI source, checksummed manifest and standalone installer.
Use XDG_DATA_HOME/triangle/releases for installed code and existing
XDG_STATE_HOME/triangle/v1 (or TRIANGLE_HOME) for custody. Expose ~/.local/bin/triangle.
Never put credentials in an archive, overwrite an unrelated wrapper, silently
switch identities, or modify macOS service behavior. `triangle setup` should
select identity-only mode by default on Linux unless a harness is explicitly
requested; explicit unsupported service requests fail before invitation use.

Proof matrix:
- Linux-native Node/SQLite validation and x64/arm64 architecture matching.
- Archive hash, bounded regular-only extraction, complete manifest verification
  before bundled Node execution; wrong OS/arch and tampering rejected.
- Clean install, rerun and upgrade preserve custody/settings, reject edited or
  unrelated CLI wrappers and symlink destinations, rollback failed file changes.
- Normal Linux setup defaults to portable enrollment, resumes journaled join,
  and never advertises a running harness service.
- Actual Linux container: build, standalone install with no compiler or external
  Node/Python, installed help and CLI tests; fake-authority invitation integration.
- macOS packaging regressions retain existing checks. Independent review before
  PR, focused fixes and one re-review for material findings.

Implementation ownership: packaging worker owns separate Linux builder/installer
and tests; parent owns shared bootstrap compatibility, Linux setup default,
documentation, Linux native verification and integration. Keep macOS package path
stable rather than broad refactoring. PR stacks on the macOS onboarding branch.
