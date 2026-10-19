# Linux CLI installation

Linux x64 and ARM64 packages bundle Node and the portable `triangle` owner CLI.
They support invitation enrollment, device approval, agents, permissions, status,
and doctor using private-file credentials. This package does not install a
background mailbox service or run harnesses. Existing foreground worker source
is not a substitute for the managed custodian's recovery/lifecycle contract.

Use a Linux distribution compatible with the bundled Node runtime, with Bash,
Perl and its core JSON::PP, Digest::SHA and IO::Uncompress::Gunzip modules, and
standard Unix utilities. No installed Node, npm, Swift or Python is required.
The build/verification environment is Debian 12 with Node 22.22.3; ARM64 runs
natively and x64 runs under local Linux emulation. This is a glibc package;
Alpine/musl and other distributions have not been validated.

Obtain the archive for your architecture, installer and checksum through an
authenticated release channel. From their directory:

```sh
bash triangle-install-VERSION.sh --archive triangle-client-VERSION-linux-x64.tar.gz --sha256 REVIEWED_SHA256
~/.local/bin/triangle setup --profile my-linux-agent
~/.local/bin/triangle status
```

For ARM64, use `linux-arm64` in the archive name. Replace VERSION and
REVIEWED_SHA256 with the exact release values. Public download publication is
separate from this change; the PR does not advertise an invented release URL.
The bootstrap verifies the independent archive checksum, bounds extraction,
rejects unsafe entries, and verifies the manifest before running bundled Node.
An adjacent hash alone does not authenticate a publisher.

Setup defaults to identity-only enrollment on Linux. It prompts privately for an
invitation when needed, can use a private mode-0600 `--invite-file`, and resumes
with `triangle setup --resume`. It does not prompt for a harness or start a
service. An explicit `--harness` request fails before consuming an invitation.
An existing enrolled device can use its stored identity without another invite.
MESH credentials require no Apple Keychain or desktop application.

Installed code lives at `$XDG_DATA_HOME/triangle/releases/VERSION` (default
`~/.local/share/triangle/releases/VERSION`). Credentials and signed operation
journals remain at `$XDG_STATE_HOME/triangle/v1` (default
`~/.local/state/triangle/v1`), or the explicit `TRIANGLE_HOME` / `--home`.
These locations are independent. Add `~/.local/bin` to PATH to use `triangle`.
XDG install paths must be canonical absolute paths with safe ownership/modes.
The installer refuses unrelated/edited wrappers and modified versioned releases;
reruns and upgrades preserve identity and unrelated state.

To remove only the installed launcher and code, remove `~/.local/bin/triangle`
and the package's `triangle` directory under the data home after confirming they
are still package-owned. Keep the state home to preserve credentials. The
installer does not create or enable systemd services.

## Maintainer build and verification

Build on the target architecture's Linux environment with Node supporting
unflagged `node:sqlite`, Git, GNU tar, and `readelf` (binutils). Supply the license from the same
Node distribution as the executable; validation hashes the included license and
runtime, checks native ELF architecture/SQLite, and restricts linked dependencies
to core system libraries with the architecture’s expected glibc loader. It
rejects custom loader paths, RPATH/RUNPATH and noncore dynamic libraries. Static
ELF inspection works under x64 emulation where loader tracing can crash.

```sh
npm run build:package:linux -- --version VERSION --output /absolute/output --node /path/to/node --node-license /path/to/matching/LICENSE
npm run test:install:linux
npm --prefix packages/triangle-cli test
```

Build x64 and ARM64 independently. The package contains tracked owner CLI assets,
its package metadata, installer, Node and both Node/Triangle licenses; it excludes credentials,
macOS helper binaries, launchd files, worker assets and service claims.
