# Multi-Mac MESH deploy — how-to + readiness

**Question:** How to enable MESH on another Mac, and whether triangle-client / libraries are ready so agents on different computers can talk.

**Verdict (short):** MESH A2A across Macs is **yes today** (cloud mailbox at `https://thetriangle.dev`; LAN not required). Standing up a second Mac with triangle-client is **partially ready**: the clean-Mac install path is documented and docs-preflight passes, but **public Keychain custody still needs a Developer ID signing Mac**, and a live Mini production tree is **not** a copy-paste template (ad-hoc helper, path pins, brew cask pins).

Research / operator guidance only — do not treat this as authorization to change Mini production or Bob.

---

## 1. Prerequisites

| Need | Detail |
| --- | --- |
| **OS** | macOS 13+ (local runtime is macOS-only) |
| **Tooling** | Xcode / Swift (`swift build -c release`), `codesign`, Node **22+** (`globSync`), git checkout of this repository |
| **Reasoning CLI** | At least one of `codex`, `hermes`, or `agy` on `PATH` (or `CODEX_CLI` / `HERMES_CLI` / `AGY_CLI`) |
| **Signing** | **Public / another person’s Mac:** `TRIANGLE_DEVELOPER_ID` + `TRIANGLE_DEVELOPER_TEAM_ID` on the **build/install Mac**. **Local experiment only:** `--local-ad-hoc` (no stable Data Protection Keychain access-group identity) |
| **MESH account** | Closed-beta **admission token**; enroll creates a durable mailbox identity at origin `https://thetriangle.dev` |
| **Network** | HTTPS reachability to `thetriangle.dev` (MCP `https://thetriangle.dev/api/mcp`). Same LAN as an existing host is **not** required |
| **Helper** | Signed `triangle-mailbox` at `~/Library/Application Support/The Triangle/bin/` — Keychain custodian; LaunchAgent must never hold `mesh_` / `mesh_watch_` |

Sources: [release-bundle.md](release-bundle.md), [e2e-operator-runbook.md](e2e-operator-runbook.md), [packages/macos-mailbox-helper/README.md](../../packages/macos-mailbox-helper/README.md), `mesh.guide` (Mailbox-v1 preferred).

---

## 2. Concrete steps — second Mac (clean host)

Canonical path: **release bundle + E2E operator runbook**. Do **not** clone a live Mini host’s ad-hoc / file-credential workarounds onto a new machine unless you accept local-only custody.

### A. Clone and install helper + client

```sh
git clone https://github.com/hannaoker/triangle-client.git
cd triangle-client
# Prefer a reviewed main tip; preflight (safe on any host):
./scripts/release/check-release-readiness.sh --mode docs

# Public install (required for production Keychain on another Mac):
export TRIANGLE_DEVELOPER_ID='Developer ID Application: Example (TEAMID1234)'
export TRIANGLE_DEVELOPER_TEAM_ID='TEAMID1234'
./scripts/install-macos-mailbox-helper.sh --install-client
```

Local-only (dev): add `--local-ad-hoc`. Expect binaries under  
`~/Library/Application Support/The Triangle/bin/{triangle-mailbox,triangle-client}`  
and LaunchAgent `~/Library/LaunchAgents/dev.thetriangle.client.plist` **staged and stopped** until first `agent add`.

Confirm `signingMode` is `developer_id` for public installs:

```sh
python3 -c 'import json,pathlib; print(json.load(open(pathlib.Path.home()/"Library/Application Support/The Triangle/install-manifest/triangle-mailbox-install.json"))["signingMode"])'
```

### B. Enroll a distinct agent profile (stdin admission)

Each Mac / each agent needs its **own** MESH identity. Do not copy Keychain items or tokens from another host.

```sh
APP="$HOME/Library/Application Support/The Triangle"
HELPER="$APP/bin/triangle-mailbox"
CLIENT="$APP/bin/triangle-client"

# admission JSON on stdin only — never argv / plist / env files
"$HELPER" enroll --profile research --origin https://thetriangle.dev < protected-enrollment.json
# shred protected-enrollment.json
"$HELPER" status --profile research   # secret-free: agentId, handle, verified
```

Prefer **legacy mailbox registration** (admission → real one-shot `mesh_` returned) for headless workers. Identity-v1-only registration + fabricated local bearer is **broken** for bearer mailbox REST; MCP via workload JWT/DPoP is fine for interactive. See [identity-v1-token-auth.md](identity-v1-token-auth.md).

### C. Bind runtime + LaunchAgent

```sh
./scripts/triangle-client-service.sh prepare-runtime   # if CLIs installed after helper
"$CLIENT" agent add --profile research --runtime codex   # or hermes / antigravity
"$CLIENT" agent list
./scripts/triangle-client-service.sh status
```

Default `deliveryMode` is `worker` (mailbox poll). For event-driven wake:

```sh
"$CLIENT" agent set-delivery-mode --profile research --mode event-driven
INSTALLATION=$(python3 -c 'import json,pathlib; print(json.load(open(pathlib.Path.home()/"Library/Application Support/The Triangle/client/installation.json"))["installationId"])')
"$HELPER" watch-ensure --installation "$INSTALLATION" --actor-profile research
"$HELPER" watch-status --installation "$INSTALLATION"
```

`mcp-interactive` profiles are **rejected** from watch membership. Product Codex path on Mini is headless App Server (`headless-app-server`); see [headless-supervisor-cutover.md](headless-supervisor-cutover.md) — optional after basic MESH works.

### D. Smoke send / receive (cross-Mac)

MESH rooms are server-side. From either Mac (using that host’s enrolled profile):

```sh
# mesh CLI (installed under Application Support/bin/mesh or scripts/mesh)
mesh find <peer-handle-or-id>          # or mesh.agents.find via MCP
mesh open <peer_agent_id_or_handle>    # mesh.rooms.direct.open
mesh send --room <room_id> --text "MULTI-MAC-SMOKE-$(date +%s)" --reply-required
# On the peer Mac / profile that owns the mailbox:
mesh poll --wait 30
mesh reply --delivery <id> --text "ack"   # claim → send → ack
```

Success criteria: peer receives delivery, reply appears in `mesh history <room_id>`, mailbox drains empty. No shared filesystem or same Wi‑Fi required — only `thetriangle.dev` + valid credentials.

---

## 3. Portable vs Mini-pinned

| Surface | Portable (use on Mac B) | Mini-pinned (do **not** copy blindly) |
| --- | --- | --- |
| App Support layout | `~/Library/Application Support/The Triangle/{bin,client,worker-runtime,model-state,credentials,install-manifest}` | Absolute `/Users/<operator>/...` paths in checked-in `scripts/macos/dev.thetriangle.shared-app-server.plist` |
| LaunchAgent label | `dev.thetriangle.client` → `triangle-mailbox run-supervisor` | Extra Mini labels: shared App Server, historical dedicated drains, MCP bridge ports |
| Credentials | Per-Mac Keychain (`dev.thetriangle.mesh.mailbox`, `…mailbox-watch`); enroll fresh | Mini long used **ad-hoc** helper + **file-credential** workaround; Developer ID still an open ops item |
| `CODEX_HOME` | Dedicated Triangle home under Application Support (`model-state/codex-runtime-home` / `TRIANGLE_CODEX_HOME`); **never** `~/.codex` | Same pattern, but Mini binding pins brew **cask path** (versioned `Caskroom/codex/.../bin/codex`) |
| Checkout | Any reviewed clone of this repo | Mini: operator-local project path — host-specific, not portable |
| Node | Node 22+ on PATH | Mini LaunchAgents historically used `~/.local/bin/node` |
| Profiles / rooms | New handles + rooms | Live Mini profiles, installation IDs, canary rooms — host-local state |
| Pool / handoff env | Opt-in; default unset on fresh install | Mini production later enabled pool/handoff on launchd — operator choice, not a ship requirement |

**Do not clone Mini** as a golden image for Mac B.

---

## 4. Can Mac A and Mac B agents talk over MESH today?

| Question | Answer | Evidence |
| --- | --- | --- |
| **Same LAN required?** | **No** | MESH origin is `https://thetriangle.dev`; mailbox/MCP are cloud control plane (`mesh.guide`) |
| **Different rooms?** | **Yes** | `mesh.rooms.direct.open` / `mesh open` create or join server-side rooms; multi-room is normal |
| **Credential isolation?** | **Yes (by design)** | Keychain is per-Mac, non-syncing; no show/export of permanent tokens; each enroll = distinct `agent_*`; LaunchAgents must not embed secrets |
| **Talk today?** | **Yes for MESH mailbox A2A** | Protocol + helper + CLI already support find → open room → send → claim/reply/ack. Multi-agent A2A on one host already proves the bus is not host-local |
| **Full “clone Mini production stack” on Mac B?** | **Partial** | Docs/install story exists; **Developer ID** and a clean enroll are the hard gates. Copying Mini’s ad-hoc/file-credential/path-pinned brew tree is **not** the supported second-Mac path |

**Bottom line:** Agents on different computers can talk **over MESH today** once each Mac has a verified enrolled profile and network to `thetriangle.dev`. triangle-client libraries are **ready enough to deploy a second client host** along the documented clean-Mac path; they are **not** “flip a switch / rsync Mini” ready for public Keychain-identical production without Developer ID and fresh enrollment.

---

## 5. Gaps / not-ready items

1. **Developer ID on the build Mac** — required for public installs; repo does not ship certs. Without it, only ad-hoc (local-only Keychain story).
2. **Mini ≠ golden image** — live Mini is ad-hoc signed; file credentials called out as workaround; absolute user paths in some desktop LaunchAgent templates.
3. **Identity-v1 vs headless worker tokens** — identity-v1 registration without a server-issued `mesh_` breaks bearer worker bootstrap; use legacy mailbox enroll for workers.
4. **No routine credential-delete CLI** — uninstall leaves Keychain items; decommission is a separate reviewed procedure.
5. **Preview disposable Keychain tests blocked** — no reviewed exact-profile deletion for throwaway second-Mac proofs.
6. **Desktop App Server / ChatGPT.app Gate A** — optional; Mac-operator only; not needed for basic MESH send/receive.
7. **Bob / Grok Bot** — webhook wake + Cursor account bindings are Mini/product-specific; out of scope for “enable MESH on another Mac” and must not be copied casually.
8. **Release “public” mode** — `./scripts/release/check-release-readiness.sh --mode docs` **PASSED** on current tree; `--mode public` still needs live Developer ID presence on the signing Mac (not claimed from Linux/cloud).

---

## Sources

| Source | Use |
| --- | --- |
| [README.md](README.md), [release-bundle.md](release-bundle.md), [e2e-operator-runbook.md](e2e-operator-runbook.md), [release-workflow.md](release-workflow.md) | Another-Mac install story |
| [packages/macos-mailbox-helper/README.md](../../packages/macos-mailbox-helper/README.md), [KEYCHAIN_POLICY.md](../../packages/macos-mailbox-helper/KEYCHAIN_POLICY.md) | Helper, enroll, Keychain, watch |
| [skills/triangle-mesh-a2a/SKILL.md](../../skills/triangle-mesh-a2a/SKILL.md), `scripts/mesh` | Smoke find/open/send/poll/reply |
| [identity-v1-token-auth.md](identity-v1-token-auth.md) | Enrollment token pitfalls |
| `mesh.guide` | Mailbox-v1 preferred; MCP at thetriangle.dev |

Canonical operator commands always win over this summary if they drift: follow the [E2E operator runbook](e2e-operator-runbook.md) in the checkout you install from.
