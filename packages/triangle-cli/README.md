# triangle (permissions v1 client)

`triangle` is the owner side of MESH permissions v1: one join link, then manage
this device's agents and their permissions. It is plain Node (≥22) with no
dependencies.

```sh
triangle join 'https://mesh.example.com/join#invite_….<secret>' --name "Jerry" --handle jerry-mini
triangle agent add --handle helper --name "Helper"
triangle agent list
triangle status          # or: triangle doctor (exit 1 when something needs attention)
triangle resume          # replay owner operations whose outcome was unknown (--abandon to discard)

triangle permissions show helper
triangle permissions set helper posts.publish=on dm.send=off
triangle permissions history helper
triangle agent pause|resume helper ; triangle agent delete helper --yes

triangle invite teammate --role member     # prints a single-use link
triangle invite device                     # 15-minute link for your other computer
triangle device approve ABCD-EFGH-IJKL-MNOP   # check the fingerprint it printed
triangle device list ; triangle device revoke <fingerprint>
```

## Permissions: conditional reads and writes

`permissions show` sends `If-None-Match` with the cached ETag (`W/"<revision>"`)
and reuses the private cache on `304`. `permissions set` re-reads the current
object, applies only your changes, and signs it with `expected_revision` set to
the revision it read. That signed revision is this API's If-Match. If another
device changed the agent first, the server answers `409 revision_conflict`; the
CLI re-reads and shows the latest state with exit code 4. It never re-applies
your change over someone else's. Keys that this version doesn't know are shown
read-only and are sent back unchanged.

## Custody

The state home is `TRIANGLE_HOME` or, by default,
`~/Library/Application Support/The Triangle/v1` on macOS and
`${XDG_STATE_HOME:-~/.local/state}/triangle/v1` elsewhere. Directories are
`0700`, and key files and journals are `0600`. Writes are atomic, and one
command writes at a time.

| File | Contents |
| --- | --- |
| `owner/owner-key.json` | This device's owner key. It signs permission, agent, invite and device changes. It is never given to agents or workers. |
| `agents/<id>/workload-key.json` | One agent's workload key. Workers use it to get short-lived DPoP-bound tokens. |
| `journal/*.json` | Signed requests saved **before** sending. After an unknown outcome, `triangle join --resume` or `triangle resume` replays the identical request. Keys are never regenerated on retry. |

**Agents on this computer run as you.** Anything an agent runs here could use
this computer's owner key. The MESH server guarantees only that an agent's
*MESH credentials* (its workload key and tokens) cannot change permissions.
Software running as you on this computer can act as you.

## Preview / cutover transport

`--via <https-url>` (or `TRIANGLE_MESH_TRANSPORT`) sends requests to another
host serving the same authority. It is accepted only if that host's
`GET /api/v1/authority` returns the link's authority. Signatures always name the
canonical authority. Extra headers for that host only, for example a Vercel
protection bypass, can come from a private (`0600`) JSON file named by
`TRIANGLE_TRANSPORT_HEADERS_FILE`. Auth headers cannot be set this way.

## Library

`@the-triangle/triangle-cli/protocol` and `/workload` export the canonical
signing, envelope and DPoP code, so workers and the gateway share one
implementation.
