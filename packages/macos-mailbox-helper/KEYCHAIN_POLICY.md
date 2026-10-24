# Credential custody and Keychain policy

**Scope (2026-10-18, permissions v1):** agent identities never live in the
Keychain. The `triangle` CLI owns each agent's Ed25519 workload key at
`<TRIANGLE_HOME>/agents/<agent_id>/workload-key.json` (directories `0700`,
files `0600`, beside a secret-free `agent.json`). The helper keeps only a
`0600` pointer per profile at
`~/Library/Application Support/The Triangle/profiles-v1/profile-<hex>.json`
(`{"version":1,"keyFile":"…","origin":"…"}`) and reads the key file itself
(`V1AgentCredentialLoader`: no-follow regular file owned by the user, no
group/other bits, directory name equal to `agent_id`, public key matching the
private key). There is no static `mesh_` bearer, no helper registration, no
enrollment journal, and no Keychain identity item
(`dev.thetriangle.mesh.mailbox` and `dev.thetriangle.mesh.workload-key` are
gone). Old profiles are not migrated: wipe them and `triangle-mailbox bind`
again.

Handoff to runtimes:

- Workers launched by `run-worker` receive only `TRIANGLE_WORKLOAD_KEY_FILE`
  (the key file path) and `MESH_ORIGIN`; the Node worker opens the file.
- The Triangle Client supervisor bootstrap mailbox carries `workloadId` and the
  43-character base64url Ed25519 seed (`workloadPrivateKey`) on its private
  launch channel only.
- Reasoning children (model CLIs) receive neither: the runner environment is an
  allowlist.

## Workload token cache

Every helper command is a new process, so a workload access token held only in
memory would be exchanged again by every `transaction-*` run and `mcp` session
(`POST /api/v1/identity/token-challenges` and `POST /api/v1/identity/tokens`)
although MESH issues it for about five minutes. The helper therefore shares the
token between processes through one `0600` file per `(origin, workload, key,
scopes)` under
`~/Library/Application Support/The Triangle/credentials/local/workload-token/`
(`WorkloadTokenCache.swift`). It is a cache, not custody:

- The token is DPoP-bound. Every request still carries a fresh DPoP proof signed
  by the workload key, so the file alone cannot authorize a request. The key
  stays in `triangle` custody and is never copied here.
- The directory must be a real `0700` directory owned by this user; each file a
  regular, single-link, `0600`, owner-owned file opened without following
  symlinks. Anything else (permissions, owner, symlink, extra hard link, wrong
  type, oversized, malformed, unknown field, a token that is not header-safe, an
  entry for another key, origin or scope set, an implausible lifetime) is a cache
  miss: the helper exchanges a token exactly as it did before and never repairs
  or follows the unsafe path.
- A token is reused only while more than 30 seconds of life remain, and is never
  written when MESH reports a lifetime beyond one hour. Expired entries are
  deleted when read or when another entry is written.
- Any `401` to a request that carried the token deletes it from memory and disk
  (a newer token another process stored is kept).
- The token is never logged, printed, put in an error or a diagnostic, or written
  anywhere but this file. `credentials/` is the tree runner sandboxes are denied
  (`TRIANGLE_CREDENTIAL_ROOT`).
- Older helpers ignore the directory; deleting it only costs one exchange.

## Watch grants

Installation-scoped watch-grant credentials (`mesh_watch_…`) are still stored
by the helper. Public ad-hoc installs (`signingMode: public_ad_hoc`, built with
`TRIANGLE_FILE_CUSTODY_REQUIRED`) keep them in `0600` files under
`~/Library/Application Support/The Triangle/credentials/local/watch/`
(selection: `CredentialCustodyPolicy.swift`); requesting Keychain custody there
(`TRIANGLE_CREDENTIAL_CUSTODY=keychain`) fails instead of falling back.

`--local-ad-hoc` development installs may keep watch grants in the Data
Protection Keychain under the non-synchronizable generic-password service
`dev.thetriangle.mesh.mailbox-watch`, with the installation id (`inst_…`) as
the account, created `AfterFirstUnlockThisDeviceOnly`. Queries never accept a
caller-chosen access group. Reads, updates, and deletes may fall back to the
legacy login Keychain on `errSecItemNotFound` or `errSecMissingEntitlement`
(`-34018`); background LaunchAgents pass `kSecUseAuthenticationUIFail` so no
dialog can appear. Creates never write to the legacy Keychain.

Ad-hoc builds cannot embed Keychain entitlements (macOS AMFI rejects restricted
entitlements on ad-hoc signatures), so unattended LaunchAgent deployments use
file custody. Developer ID is out of scope.

Unit and host contract tests use temporary homes and in-memory stores; they
never access a live Keychain or real `TRIANGLE_HOME`.
