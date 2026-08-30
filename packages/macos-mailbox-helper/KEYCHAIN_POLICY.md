# macOS Keychain policy

Mailbox credential items use the Data Protection Keychain and are explicitly
non-synchronizable. The fixed generic-password service is
`dev.thetriangle.mesh.mailbox`; the validated local profile name is the account.
Create uses `AfterFirstUnlockThisDeviceOnly` so the signed helper can operate
without a prompt after the user's login Keychain becomes available.

Queries intentionally do not accept or set an arbitrary Keychain access group.
They use the signed helper's default Data Protection Keychain application access
group. This keeps credential custody tied to the installed helper rather than to
caller-controlled input.

The public release requires a stable Developer ID application identifier and
matching Keychain entitlements. Release verification requires an explicitly
opted-in, uniquely named disposable real-Keychain lifecycle test against the
signed artifact; it creates, reads, replaces, and deletes only its own item.
Unit and host contract tests inspect pure query dictionaries and never access a
live Keychain.

The disposable lifecycle scaffold is `scripts/test-keychain-integration.sh`.
It refuses to run unless `TRIANGLE_RUN_DISPOSABLE_KEYCHAIN_TEST=1` is explicitly
set, generates a unique profile, and cleans up only that exact profile. It must
be run as a release gate after the helper has its stable production signature;
ordinary unit-test and build commands do not execute it.
