# R2 local reply identity contract

Status: PR #137 merged as `b1c8946`. The local attached-chat slice is implemented,
installed and accepted on the Mini. New pin creation is disabled by default;
permanent activation and grants were not authorized by the canaries. Current
installation, review and live evidence is in
[the acceptance handoff](../handoffs/2026-10-26-r2-installed-disabled.md).

## Identity and route contract

`createLocalReplyRoute` pins the exact interactive local session address,
authenticated remote address, their nullable principal/authority associations,
session generations and principal-binding generations. Local route keys are
`(local-socket, exact authenticated remote address, requestId)`. A null principal
is not a stable identity; this host-journal key must not become a remote authority
or cross-machine address.

`verifyLocalReplyRoute` permits generation advances for those same identities,
rejects regression and identity/principal/origin reassignment, and returns a new
route. There is no automatic session transfer or selection of a replacement chat.
Contract support for mapped observations does not mean the installed chat broker
has mapped session principals: its principal/authority/binding values remain null.

`createLocalSenderProvenance` is a projection, not an authenticator. The installed
factory validates native HMAC/expiry and exact interactive sender claims, then
uses the real workspace-session broker to recheck policy, discovery, lease,
child and generation. It constructs provenance from those observations, never
message metadata. Assurance is local-attested/unbound, not live MESH verification
or a remote signature.

Only attached session-to-session requests use this slice. Worker profiles and the
bound desktop identity retain legacy flow. Iroh/MESH provenance, peer principals,
new-session launching and explicit session transfer remain deferred.

## Durable admission and reply

The route store uses the journal's SQLite connection. New request insertion,
route pin, receiver-built provenance and admission accounting commit atomically.
Replies verify the existing pin and current native attachment rows within their
transaction; same-session renewal retains the original claim token/session while
old children, cross-session owners and regressions fail. Reply and pin advancement
commit together, or neither does. Duplicate admission returns the original record
without re-pinning.

An original unbound sender may be offline when its reply commits: the reply waits
at that exact original address. Other observation errors fail closed. No route
fallback is implied.

Native provenance is stored separately and exposed as optional senderProvenance.
Pinned sends strip reserved peer-supplied provenance metadata. Internal route keys
are not added to public DTOs. Legacy metadata behavior remains unchanged.

Pinned admission measures the final inbox projection with 4096 bytes of framing
headroom. This fixes a reproduced case where a 261120-byte metadata value was
admitted but its receiver-built provenance made the inbox frame unretrievable.
Oversized requests roll back the request and pin together.

## Admission control and retries

The host constructs the optional verifier with its actual session broker and
HMAC validator, and constructs the route store on its own SQLite connection.
Missing verification dependencies fail closed for pinned work.

triangle-local setup-reply-identity --enable/--disable controls new pin creation
through private client/reply-identity.json. Missing policy disables new pins;
malformed policy disables them and exposes a fixed status error. Disabling does
not disable verification of existing pins or break their exact retries. Existing
legacy messages also remain unpinned on retry after enablement.

Correction 9547620 reproduced and fixed duplicate_id_conflict on a pinned retry
while admission was disabled. Existing-route context comes only from the server's
journal lookup; client parameters cannot supply it. Both switch directions are
covered by the real socket/HMAC/journal regression.

## Runtime and downgrade boundary

Manifest v14 adds the contract, store and authentication modules to every exact
v13 closure: 90 supervisor artifacts and 92 per worker. Python staging/validation,
Swift launching and doctor agree on the version. Node must support the runtime's
unflagged SQLite API.

The policy path persists when disabled. Updated native and Python validators
reject a pre-v14 runtime whenever it exists, including disabled/malformed policy.
Install the new helper and refresh the frozen wrapper before enabling; the setup
command checks manifest version, not helper binary identity. This operational
floor does not protect deliberate owner deletion of policy or replacement of
both validators/helper and runtime. v13 cannot enforce pins and is not a safe
rollback reader for pinned work.

## Verification and practical limits

All 258 relevant source tests passed after correction 9547620, including actual
SQLite reopen/rollback, socket admission, bounds, stale claims and attachment
races. Native host tests passed. Gemini independently reviewed 98be801 and the
9547620 correction with no blockers. An earlier review of 7d652e2 missed the
bounds failure; that earlier no-blocker result is not used as sole evidence.

Installed owner-approved Claude-to-Codex-to-Claude acceptance returned the exact
token in 19378 ms. Native provenance, consumed result and pin survived restart
with new admission disabled. Claude reported an accepted completed duplicate
receipt on the same IDs/text; an independent snapshot proved the original
message, sole consumed reply and pin unchanged. Temporary grants were removed,
test reports consumed and the original backlog preserved.

The chats required direct owner approval before executing peer instructions.
Wake acceptance was not counted as execution. This is not unattended execution
acceptance, permanent activation, all-agent coverage or remote transport proof.
