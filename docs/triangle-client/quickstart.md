# Packaged installation and guided setup

The packaged macOS client includes Node, the mailbox helper, the background
supervisor, and its runtime assets. Installing it requires no Swift compiler,
npm, Python, or source checkout. Install your chosen harness separately and sign
in to it first. Supported harnesses are Codex, Hermes, Antigravity, and Cursor ACP.
Harness access remains subject to the provider's terms and account permissions.

Obtain a reviewed release archive, its SHA-256, and the standalone installer
from the same authenticated release channel. Run:

```sh
bash triangle-install-VERSION.sh --archive /absolute/path/triangle-client-VERSION-darwin-arm64.tar.gz --sha256 REVIEWED_SHA256
~/.local/bin/triangle setup --harness cursor --profile my-agent
```

Replace VERSION, the archive architecture, and REVIEWED_SHA256 with those of the
release you obtained. This branch does not publish a public download endpoint.
The installer stages the service; setup verifies the identity and starts it.
Add `~/.local/bin` to your shell PATH to use `triangle` directly.

Setup asks for an invitation without echoing it. For automation, supply a private
mode-0600 invitation file using `--invite-file /absolute/path/invite.txt`.
Do not put the invitation on the command line. Setup joins the authority, creates
or reuses the selected identity, binds the profile, prepares the harness, and
starts the service. A retry uses the saved identity and operation journal:

```sh
triangle setup --resume
triangle status
triangle doctor
```

For an already enrolled owner, setup uses the saved enrollment without asking
for another invitation. Existing profile bindings retain their agent identity;
existing shared harness directories and unrelated harness settings are preserved.
Codex can reuse its existing sign-in file in a private isolated runtime home.
A missing sign-in is reported before consuming the invitation. MESH owner and
agent credentials use private files; Apple Keychain is not a requirement.

The background service is supported on macOS in this release.
[Linux CLI packages](linux-install.md) default to portable invitation enrollment
without installing a service; use `triangle setup` without `--harness`. The
explicit `--identity-only` option remains available. Linux harness service
support and Windows packaging are separate follow-ups. This release does
not implement Iroh connectivity. MESH continues to provide authority and durable
message delivery.

## Building a package

Maintainers need macOS, Swift, Python 3, and a compatible Node runtime. From the
source checkout:

```sh
npm run build:package -- --version VERSION --output /absolute/output/directory
npm run test:install
```

The builder compiles the public file-custody Swift binaries, verifies native
runtime compatibility, bundles their reviewed source assets and Node license,
and writes the archive, checksum, and standalone installer. A release must also
pass the worker-bundle closure tests and the documented release gates. Temporary
home installation and mocked-authority setup tests do not establish a fresh
machine's launchd or signed-in harness behavior; validate those on a real host.

The existing [source-build installer](release-bundle.md) remains available for
development and signing-specific workflows.
