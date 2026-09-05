# macOS Keychain policy

Mailbox credential items use the Data Protection Keychain and are explicitly
non-synchronizable. The fixed generic-password service for mailbox credentials is
`dev.thetriangle.mesh.mailbox`; the validated local profile name is the account.
Installation-scoped watch-grant credentials use a separate service,
`dev.thetriangle.mesh.mailbox-watch`, with the installation id (`inst_…`) as the
account. Create uses `AfterFirstUnlockThisDeviceOnly` so the signed helper can
operate without a prompt after the user's login Keychain becomes available.

Queries intentionally do not accept or set an arbitrary Keychain access group.
They use the signed helper's default Data Protection Keychain application access
group. This keeps credential custody tied to the installed helper rather than to
caller-controlled input.

Reads, updates, and deletes fall back to the legacy login Keychain when the Data
Protection Keychain returns `errSecItemNotFound` or missing entitlements
(`errSecMissingEntitlement`, status `-34018`). Background LaunchAgents pass
`kSecUseAuthenticationUIFail` on legacy probes so macOS cannot show the login
Keychain password dialog; foreground sessions may prompt once for migration.
Creates never write to the legacy Keychain.

Ad-hoc (`--local-ad-hoc`) builds cannot embed Keychain entitlements; macOS AMFI
rejects restricted entitlements on ad-hoc signatures. Use Developer ID signing
for LaunchAgent deployments that must use the Data Protection Keychain.

If credentials were enrolled under an unsigned or entitlement-less build, migrate
them once from an interactive Terminal session:

1. Stop Triangle Client: `launchctl bootout gui/$(id -u)/dev.thetriangle.client`
2. Reinstall the helper with Developer ID signing (recommended for LaunchAgent).
3. For each profile, read the binding in the foreground (this may prompt once):
   `"$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox" status --profile PROFILE`
4. If status reports `profile_state_inconsistent` or `local_authorization_required`
   after reinstall, delete the legacy item and re-enroll from stdin, or use MESH
   credential recovery if the server-side identity is still valid:
   `security delete-generic-password -s dev.thetriangle.mesh.mailbox -a PROFILE`
   `security delete-generic-password -s dev.thetriangle.mesh.workload-key -a PROFILE`
5. Start Triangle Client again after a successful foreground `status`.

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

Identity-v1 mailbox registration may store a **client-fabricated** `mesh_`
compatibility bearer when the server omits `token`. That value is not
server-authorized. Interactive MCP uses workload JWT + DPoP instead; see
[`docs/triangle-client/identity-v1-token-auth.md`](../../docs/triangle-client/identity-v1-token-auth.md).
