# Linux CLI packaging validation

Scope: self-contained x64 and ARM64 Linux owner CLI packages. These provide
invitation enrollment, device/agent/permissions controls, status and doctor.
They do not install a managed mailbox service, harness daemon or systemd unit.
The macOS runtime remains unchanged; a Linux managed custodian is separate work.

## Verified

- Built both archives on their target Linux ABI using Node 22.22.3 with working
  unflagged SQLite. ARM64 executes natively in the local Linux VM; x64 executes
  through its configured emulation. ELF dependencies are inspected statically
  (core libraries only, expected glibc loader, no RPATH/RUNPATH); actual runtime
  and SQLite probes remain required. Loader tracing crashed under x64 emulation
  and is not silently skipped.
- Each architecture passed all 74 owner CLI tests, including protected-file
  custody, invitations, request signing and setup recovery.
- Each architecture passed 11 package tests, with one inverse-platform rejection
  test skipped. Coverage includes real archive/bootstrap/install with an empty
  tool PATH, native runtime/SQLite, package closure, altered-file refusal,
  private paths, upgrades, rollback, concurrent installations and SIGKILL recovery.
- The final installed CLI on each architecture enrolled and inspected one test
  identity against the fake authority. Repeated setup and reinstall retained the
  same owner key and one agent, with no file-mode problems. These tests used no
  production invitations or credentials.
- Fresh minimal Debian 12 consumers for both architectures contained no Node,
  npm, Python or compiler before installation. After installing only the
  documented OS prerequisites, the standalone installer succeeded, the installed
  CLI help ran with PATH=/nonexistent, and bundled SQLite worked.
- All 23 source/license files in each final manifest match committed source
  ffdde190454d7ea220042232dc97bb35013ffbf2. Each archive has 25 payload files
  including Node, Node's license and Triangle's MIT license.
- macOS regression: 74 owner CLI tests and all 9 package tests passed. Release
  documentation and secret-boundary checks passed. The complete unrelated
  gateway/worker suites were not repeated for this packaging-only change.

## Independent review corrections

Private staging followed by atomic rename prevents partial immutable releases.
A kernel-held account-wide SQLite lock serializes wrapper/receipt checks,
publication and rollback. A private write-ahead install intent recovers a kill
between wrapper and receipt publication, while refusing unrelated changes.
Both new and upgrade interruption windows are tested. Review found no remaining
Critical or Important issue in the final scoped changes. This is process-kill
recovery, not a claim of complete power-loss atomicity for all installed files.

The archive includes the repository's MIT license as well as the Node license.
Code installation is separate from XDG state and never modifies existing MESH
credentials, unrelated wrappers, agent settings or service definitions.

## Artifacts

Version: `0.2.0-linux.1`.

| Architecture | Archive SHA-256 |
| --- | --- |
| ARM64 | `738c6df50f56cb6e5c3c782d641cc35372cc14c4abd2b65059ff309030bf4ab1` |
| x64 | `00350b45e9cf1ee4772bb787e9a8347bd15b820c2ad94d68d2c02b23f0cfd135` |

The Mini workspace retains both archives, standalone installers, checksum files
and sanitized receipts under `releases/triangle-client-0.2.0-linux.1/`, outside
this source checkout. Public release publication is separate from this PR.
Authenticate the installer and archive checksum through the distribution channel;
Linux packages do not claim publisher signing or universal distro compatibility.
