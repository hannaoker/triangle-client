# Owner revoke command: review and test-hardening checkpoint

2026-10-31 PDT, Claude. Branch `claude/owner-revoke-test-hardening`, based on PR #158
(`codex/owner-revoke-command`) at `ae433fda8c3c376e20665667bc129f55abe0e380`. Continues
`2026-10-30-owner-revoke-command-checkpoint.md`. Tests, three message fixes and this document:
authorization logic, error codes and exit statuses are unchanged. Nothing merged, published or
installed, and no native prompt was shown.

## Verdict on the source

No source defect and no blocker. The full diff at the head above was read, then exercised with
stand-in providers and disposable state in scratch copies. One reviewer; the added tests had a
separate read-only review.

Checked and holding:

- Codex's 133-test focused command reproduces (133 pass, 0 skipped; the native helper is only
  called with `--validate-request`). All 12 packaging tests pass at the head, and again on this
  branch.
- The printed apply command works when copied, including a registry path with a space and an
  apostrophe, and appends exactly one `revoke` audit entry.
- A real SIGINT/SIGTERM through the CLI exits 130/143, the provider sees the abort and the
  registry bytes are unchanged.
- Corrupt JSON, a future schema and a symlinked root fail at plan time with a code and no path.
- Installed layout: release dir 0700 and real, manifest 0600 with one link, helper 0700 with the
  manifest hash, and the default release root resolves to the install. The loader refuses
  test-only and candidate manifests.
- Plan id, canonical target, authenticate-before-lock, lock-time recheck of sequence and exact
  binding, replay refusal and unchanged sibling bindings behave as the earlier checkpoint says.

The terminal and SSH checks are hygiene, not proof of a human: an agent with a pseudo-terminal
passes them. The OS prompt is the only gate.

## What this branch changes

1. Release-capability guards were unpinned: removing any one of about 23 conditions in
   `loadPackagedRevokeProvider` still passed the suite. Added a control plus 32 single-factor
   refusal cases in `identity-revoke-hardening.test.mjs`.
2. SIGINT/SIGTERM registration, the 130/143 exit codes and signal forwarding were unpinned.
   Added child-process tests that deliver the real signal.
3. Not pinned before: the operation shown before authentication, SSH_CLIENT/SSH_TTY, the printed
   apply command, argument-shape errors, malformed confirmations. Added tests for each.
4. The default release root in an installed package was never exercised. The revoke package test
   now swaps in a stand-in helper, flips `testOnly` in the disposable install and checks that the
   installed layout selects it; candidate and ordinary manifests are also asserted to declare no
   command capability.
5. Messages (`cli.mjs`, wording only): a mistyped plan id no longer claims "the registry
   changed"; an expired approval says to run the apply command again; `invalid_owner_operation`,
   `registry_unsafe` and `registry_corrupt` have a specific line. A test pins the wording and
   that no path appears.

Mutation probes (one guard removed at a time, 42 guards, run on the final test code after a
passing baseline): 7 caught before, 39 after. The 3 that survive cannot be reached from a
test: the loader's directory check (unreachable once the manifest path cannot be read) and the
two owner-uid checks (they need another OS user). Three packaging mutants (default release root one level too shallow,
test-only manifests selecting the helper, a candidate build also declaring the command) are
all caught by the packaging tests.

Left as they are: result printing sits inside the try that reports "did not complete" (the
message already says to check status before retrying), and the bridge import catch-all calls
any load failure "package is incomplete".

## Review of the added tests

An independent read-only reviewer ran the first test commit and tried deleting guards. Findings
and what was done:

1. Four loader guards were not actually pinned: the macOS provider repeats the platform, path
   and hash-format checks, so a refusal looked the same with or without the loader's guard.
   Fixed: the tests call `authenticate` with an already-aborted signal, which a selected
   provider answers with 'cancelled' before checking anything and the unavailable provider
   answers with 'unavailable'. The canonical-root case now reaches the release through a
   symlinked parent, and the hash-mismatch case is a separate live-provider test.
2. The packaging test would have launched the real native helper (an OS prompt) if its
   stand-in write were ever lost. Fixed: the manifest pins the stand-in's own hash.
3. The macOS-only private-symlink case vanished silently on Linux. It is now skipped visibly.
4. The `/usr/bin/python3` stand-in opens an install dialog on a Mac without Command Line Tools.
   The new stand-ins run on the test Node (see the Codex review below for the shebang
   follow-up). The older stand-in in `identity-revoke-cli.test.mjs` is unchanged.
5. Overstated names and one weak case: argument-shape cases now carry a valid `--confirm`.
6. The signalled-child test waits for 'close' (after stderr drains) and clears its timer on error.
7. Not done: the stand-in and manifest builder exist in three copies (the sibling test, this
   file, the packaging test); a shared fixture module would stop them drifting.

## Codex review of this PR

Two findings, both fixed in `5ec2b00`:

1. Test portability (medium): the stand-ins used `#!${process.execPath}`, and a shebang cannot
   name an interpreter path with spaces, so the control and packaging tests failed under the
   packaged Node (`.../Application Support/The Triangle/releases/.../bin/node`). Both stand-ins
   are now a `/bin/sh` launcher with the Node path shell-quoted and the approving script inline.
   The packaging fixture also names the Node license it finds beside the Node (the packaged
   Node keeps it under `LICENSES/`), so the suite runs under the packaged Node. Verified: the
   43 hardening tests pass under the regular Node and under the packaged Node, and the revoke
   packaging test passes under both.
2. Message accuracy (low): expiry is also checked after the provider approves and inside the
   registry lock, so "approval expired before it was granted" could be wrong. It now reads "The
   approval window expired. Run the apply command again."

## Private package (not published, not installed)

Built from this branch at `5ec2b00` (the final source; this document is the only later change)
with the prebuilt inputs earlier reviews used (installed helper and client binaries and the
bundled Node 22.22.3 of release `0.2.0-identity.1`, read only), `--owner-approval revoke`, no
`--test-root`. It replaces `0.2.0-owner-revoke.1`, which predated the wording fix and was removed:

- `/private/tmp/triangle-owner-revoke-package/triangle-client-0.2.0-owner-revoke.2-darwin-arm64.tar.gz`
- archive SHA-256 `2e6cf72b90dac78877142f66f36ea3dc8acd433f1a25bd5068d67d770d0b3319`
- installer SHA-256 `be2e6cb95e4274ebeeaa9bf172d7dcc33bc9d96cb9982e861eb59ef730c00de1`
- native helper SHA-256 `440eb808e7ebc196606ec784893be2ff8f0e0529b4fabc143e3e4a8cd5d81bb3`

Verified from a fresh extraction: archive and installer hashes match their sidecars; manifest
`testOnly: false`, no candidate marker, `ownerApproval.commands = ["identity.revoke"]`; all 156
files match the manifest in hash, size, mode and link count; the recorded Swift source hash equals
the tracked source, and the helper verifies with `codesign --strict` as
`dev.thetriangle.owner-approval` and targets macOS 13.0; release dir 0700 and manifest 0600; the package's own Node and CLI give a
read-only plan and refuse a non-terminal apply with registry bytes unchanged; the extracted
layout selects the pinned-helper provider; the native validation test passes against the
packaged helper (validation only). `authenticate` was never called.

For the owner-led acceptance, extract into a fresh private directory and use that copy:

    mkdir -m 700 /private/tmp/triangle-owner-revoke-accept
    tar -xzf /private/tmp/triangle-owner-revoke-package/triangle-client-0.2.0-owner-revoke.2-darwin-arm64.tar.gz -C /private/tmp/triangle-owner-revoke-accept

## Still not done

- Interactive acceptance of the packaged command, TTY and password path, against a new
  disposable registry under a real path (`/private/tmp/...`, not `/tmp/...`): read-only plan,
  non-terminal refusal, then Cancel and Apply with the full details readable, one audit record per
  apply, plan staleness. Add: Ctrl-C while the dialog is open (helper exits, no orphan), an apply
  over SSH (headless refusal) and one expired 60-second approval window. The owner must be
  present; earlier consent covered earlier native-helper tests only.
- Merge, install, publication, any live identity, grant or backlog change. Old pending, queued
  and held Triangle work was not touched.
