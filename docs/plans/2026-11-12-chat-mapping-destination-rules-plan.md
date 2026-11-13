# Plan: Chat Mapping (`D4`), Destination Rules (`AD.5`), and Owner-Approval Kinds (`D5-C`)

Status: Approved for build (`2026-11-12`: owner approved recommended options `CD-1=A` through `CD-7=A`). Baseline: `origin/main` at `02c768a4` (after PR `#178`).
This document authorizes **phased source implementation + tests (`Slice 1` -> `Slice 3`) only**; packaged interactive acceptance and any live package install or mutation to live `~/.config` or `~/Library/Application Support/The Triangle` state still require explicit gate sign-off after build.

Reference design and acceptance inputs:
- [`2026-10-30-identity-destination-design-delta.md`](2026-10-30-identity-destination-design-delta.md) (`U3`: sections `3.A.3`, `3.B`, `3.C.1–3.C.5`, `3.D`, `3.F`, approved decisions `D1–D6`)
- [`2026-10-25-unified-messaging-interface-design.md`](2026-10-25-unified-messaging-interface-design.md) (§4.3–4.6)
- [`2026-11-07-identity-registry-v2-d1-plan.md`](2026-11-07-identity-registry-v2-d1-plan.md) (`D1` registry `v2` schema & audit actions)
- [`2026-11-10-identity-aliases-and-destination-rules-plan.md`](2026-11-10-identity-aliases-and-destination-rules-plan.md) (`AD` aliases & §4 `AD.5` destination rules)
- [`../reviews/2026-10-30-owner-approval-macos-acceptance.md`](../reviews/2026-10-30-owner-approval-macos-acceptance.md) & [`../handoffs/2026-10-31-owner-revoke-command-review-checkpoint.md`](../handoffs/2026-10-31-owner-revoke-command-review-checkpoint.md) (`D5-C` Swift provider & revoke checkpoints)
- [`../reviews/2026-11-12-identity-aliases-ad4-installed-acceptance.md`](../reviews/2026-11-12-identity-aliases-ad4-installed-acceptance.md) (`AD.4` live Mini H2–H4 acceptance baseline)

---

## 1. What this plan covers (and what stays out)

| Scope | Included in this plan | Explicitly out of scope |
| --- | --- | --- |
| **Owner approval (`D5-C`)** | Parameterize `owner-approval` JS + Swift `LAContext` provider + `package-manifest.json` capabilities for `destination.*` and `chat.map.*` (preserving `identity.revoke` compatibility) | Remote push/passkey approvals; Linux interactive OS re-auth daemon; building `profile.move` CLI unless opted in by `CD-7` |
| **Destination rules (`AD.5`)** | `identity-registry.mjs` destination writer (`set`/`clear`), canonical workspace checks, `triangle identity destination set\|clear`, `identity-view` / `identity status` / `doctor --identity` rows & readiness checks, `router-registry-snapshot` export | Remote Iroh / HTTP MESH inbound transport (`admitInbound` wire adapter — future transport slice) |
| **Chat mapping (`D4`)** | Two-layer selector `(harness, workspace) -> principal` + single-chat confirmation + concurrent-chat ambiguity drop-to-unbound; decoupled `senderProvenance` emission, `authenticateAttachedLocalSender`, `describeLocalSession`, `describeChatBinding`, CLI | Multi-consumer multiplexing on one principal; newest-session auto-promotion; `peer_` serverless support (`AD.2` deferral); weakening unmapped attached chats |
| **Lanes & runtime floor** | Non-runner lane isolation (`U3 3.C.4`), supervisor/Swift runtime floor bump (`14 -> 15`), release packaging presets, disposable interactive OS-auth acceptance plan | Serverless `pair` / `unpair` (`AD.2`); key custody changes; changes to `0.2.0-identity.3` live data during planning |

---

## 2. Starting point on `origin/main` (`02c768a4`) and live Mini baseline

Inspected directly against `02c768a4` and read-only Mini state on `2026-11-12`:

1. **Registry `v2` reserves `destinations`, enforces root custody, and is closed to `chat_mappings`:**
   - `packages/agent-worker/src/identity-registry.mjs` defines `IDENTITY_REGISTRY_SCHEMA_V2 = "identity_registry_v2"` (`:73`), `MAX_REGISTRY_DESTINATIONS = 256` (`:79`), `DESTINATION_HARNESSES = new Set(["claude", "codex"])` (`:161`), `REGISTRY_TOP_KEYS_V2` (`:165`, including `"destinations"`), `DESTINATION_KEYS` (`:204`: `harness`, `workspace`, `set_at`, `generation`), and `AUDIT_ACTIONS_V2` / `RESERVED_AUDIT_ACTIONS` (`:140–158`, including `"destination_set"` and `"destination_clear"`).
   - `validateDestinationRecord` (`:972–1000`) calls `isValidWorkspacePath` (`:605–611`, POSIX syntax/UTF-8 check only — no filesystem `realpathSync` check).
   - `validateIdentityRegistryV2` (`:1002`, dispatched from `validateIdentityRegistry` `:1203–1208`) checks at `:1170–1176` that every destination key is in `localPrincipals` (which includes active, revoked, and `serverless-peer` records in `registry.bindings`, `:1075–1085`), throwing `destination_principal_unbound` otherwise.
   - `validateV2AuditFields` (`:1259–1282`) requires `bindingId === null` and `isPrincipalId(entry.subject)` for `destination_set` / `destination_clear`; `registry-audit.jsonl` entries omit old `destinations` fields (`:1242–1250`).
   - `verifyRootEntriesCustody` (`:1529–1559`) exempts only `identity-registry-v1.json`, `registry-audit.jsonl`, `identity-registry-v1.json.tmp-*`, and `.registry.lock-journal`, applying `assertSafeFileStat` (`regular file, mode 0o600, nlink === 1`) to every other entry in `identity/`. **No extra directories, lock files, SQLite `-wal`/`-shm`, or non-`0o600` files may live inside `identity/`.**
   - `packages/agent-worker/src/identity-view.mjs:163` and `packages/triangle-cli/src/doctor.mjs:77` surface the `destinations` count in `collections`, **but no writer (`setIdentityDestination` / `clearIdentityDestination`), no `assertMutationMatchesAction` branch, no CLI command, and no per-destination readiness diagnostics exist yet**.
   - Source-level boundary test `packages/agent-worker/test/identity-registry.test.mjs:1646–1655` restricts which modules may import `identity-registry.mjs` (`allowedImporters`).

2. **Attached chats are live in the local broker, but provenance is coupled to `replyRoute` / `reply-identity.json`:**
   - `packages/agent-worker/src/local-messaging-interactive-session.mjs` (`createWorkspaceSessionBroker`) resolves workspace canonically via `resolvedWorkspace()` (`realpathSync`) and hardcodes `{ principal: null, authorityOrigin: null, bindingGeneration: null }` in `describeLocalSession` (`:340–341`).
   - `packages/agent-worker/src/local-sender-authentication.mjs:29–30` hardcodes `{ principal: null, authorityOrigin: null, bindingGeneration: null }` in `authenticateAttachedLocalSender`, and `:46` restricts `createAttachedReplyIdentity` reply pinning to `SESSION <-> SESSION` pairs.
   - `packages/agent-worker/src/local-messaging-journal.mjs:735–747` does **not** write `sender_provenance_json` in the base `INSERT` into `local_messages`; it only writes `sender_provenance_json` inside `if (replyRoute)` (`:741–747`), where it also checks `checkAttachedIdentity` on both `local` and `remote` against `local_discovered_sessions` + `local_session_attachments` and requires `recipientType === "interactive"` (`:691–696`). Because `reply-identity.json` defaults to disabled (`local-messaging-server.mjs:659–661`), `D4` provenance would be silently dropped unless `sender_provenance_json` emission is decoupled from `replyRoute`.
   - `packages/agent-worker/src/local-reply-route-contract.mjs:17–26, 45, 81–82` already emits `assurance.principal_binding = "owner-mapped-disk-observation"` when passed non-null `{ principal, authorityOrigin, bindingGeneration }` (`:24` accepts only `agent_<32-hex>` + bare HTTPS `authorityOrigin`), and `local-messaging-client.mjs:11, 78` (`PRINCIPAL_PATTERN = /^agent_[a-f0-9]{32}$/`) drops `peer_` discovery entries.
   - `local-messaging-server.mjs:70–72` returns static `{ binding: "unbound", ... }` from `describeChatBinding()` into host `statusProvider()` (`local-messaging-host.mjs:237`), while attached interactive callers running `local_status` are routed to `ownSessionStatus` (`local-messaging-server.mjs:432–436`), not `statusProvider()`.
   - `recipient-resolver.mjs:73–85` requires recipient `id`s to match 64-hex `INSTANCE_ID_PATTERN` (rejecting `session-<64-hex>`), and `local-messaging-server.mjs:587, 610` checks statically snapshotted `claims.allowedRecipients`.
   - Manifest upper bounds `<= 14` appear in `WorkerLauncher.swift:168` (`5...14`), `:467` (`8...14`), `:614` (`enforceReplyIdentityRuntimeFloor >= 14`), `scripts/triangle-worker-install.py:110` (`CURRENT_MANIFEST_VERSION = 14`), `packages/agent-worker/src/installation-inventory.mjs:61, 652` (`WORKER_MANIFEST_VERSIONS`), and `identity-upgrade.mjs` (`MINIMUM_RUNTIME_MANIFEST = 14`).

3. **Non-runner profile support (`ClientInstance.DeliveryMode`, `ClientSupervisor`, `installation-inventory`) does not exist yet:**
   - `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/ClientInstance.swift:12` defines `DeliveryMode` (`.worker`, `.eventDriven`, `.mcpInteractive`, `.grokBot`, `.headlessAppServer`, `.headlessCursorAcp`).
   - `ClientSupervisor.swift:289–327, 344–358` switches exhaustively over `instance.deliveryMode` and throws `ClientSupervisorError.noEligibleInstances` if no runner/wake instances exist.
   - `TriangleClientCLI.swift:92–110, 148–159` requires Keychain credential + runtime binary readiness on `agent add`/`enable` and gates launchd on `participatesInClientSupervisor`.
   - `installation-inventory.mjs:139–178, 1171–1215` classifies any unknown `deliveryMode` as `lane_unsupported` (`fault`), requires helper profile bindings + runtime command for enabled profiles, and marks `enabled: false` profiles as `status: "disabled"`.

4. **Owner-approval provider & packaging are hardcoded to `identity.revoke`:**
   - `packages/triangle-cli/src/owner-approval.mjs:25–41` and `scripts/probes/owner-approval-provider.swift:43–51` accept only `"profile.move"` and `"profile.revoke"` with keys `['action', 'registryRoot', 'expectedSequence', 'profileId', 'before', ...('after')]` (no `profile` key; 64-hex `profileId`).
   - `scripts/release/build-client-package.mjs:69–70, 304–308` accepts `--owner-approval` only as `"candidate"` or `"revoke"` and writes hardcoded `commands: ["identity.revoke"]`.
   - **`identity-revoke.mjs:24` enforces exact array equality `canonicalJson(policy.commands) !== canonicalJson(["identity.revoke"])`:** expanding `policy.commands` without updating `identity-revoke.mjs` breaks `identity revoke`.
   - Source-level boundary test `packages/triangle-cli/test/owner-approval-registry.test.mjs:91` restricts imports of `owner-approval-registry.mjs` to itself and `identity-revoke.mjs`.

5. **Live Mini non-secret baseline (`2026-11-12`, corroborated by repo `ad4-installed-acceptance.md`):**
   - `identity-registry-v1.json`: `schema: "identity_registry_v2"`, `sequence: 5`, `3` active `mesh-managed` bindings (`ghost`, `gravity2`, `codex-headless`), `1` alias (`gemini`), `0` pairings, `0` destinations.
   - All three configured profiles on the Mini are active runner profiles (`ghost` = `headless-cursor-acp`, `gravity2` = `worker`, `codex-headless` = `headless-app-server`); none is a non-runner profile. Only `gravity2` is enabled in local messaging recipients (`inbox`, `interactive`, `discovery`, `sessionMessaging` also enabled under `~/Projects/The Triangle`).
   - Installed package is `0.2.0-identity.3` (built without `--owner-approval`, so installed `package-manifest.json` omits `ownerApproval`); worker runtime manifest is `14`; local router is enabled; `reply-identity.json` is disabled. Earlier interactive acceptance (`docs/reviews/2026-10-30-owner-approval-macos-acceptance.md`) tested only candidate `profile.revoke` on disposable `/private/tmp` fixtures (`0.2.0-owner-revoke.2` remained unaccepted/not installed).

---

## 3. Architecture and semantics

### 3.1 Principal & lane scope (`U3 3.C.4` + `mesh-managed` focus)

1. **`mesh-managed` (`agent_<32-hex>`) scope for this train:**
   - Because `local-messaging-client.mjs:11, 78` (`PRINCIPAL_PATTERN`) and `local-reply-route-contract.mjs:24` enforce `agent_<32-hex>` + HTTPS `authorityOrigin` (and `serverless pair`/`unpair` `AD.2` is out of scope), both `D4` chat mapping and `AD.5` destination writers in this train target active **`mesh-managed` (`agent_`)** bindings only and reject `peer_` / revoked / unknown principals.
2. **"One consumer per lane" (`U3 3.C.4`):**
   - Letting an attached chat or destination rule share a principal with an active runner (`worker`, `headless-cursor-acp`, `headless-app-server`, `event-driven`, `mcp-interactive`, `grok-bot`) or an already paired conversation (`inbox`/`interactive`) creates dual consumers (`U3 3.C.4`) and shadows rule 3 under `U3 3.C.2` (runner -> bound conversation -> destination rule).
   - **Recommended model (`CD-2 = A`): Explicit non-runner identity profile (`DeliveryMode.router` or `enabled: false` identity-only profile).**
     - Adding `DeliveryMode.router` across Swift (`ClientInstance.swift`, `ClientSupervisor.swift`, `TriangleClientCLI.swift`) and JS (`installation-inventory.mjs:139–178, 1171–1215`, `identity-inventory.mjs`, `setup-runtime.mjs`) lets a profile participate cleanly in `identity-registry-v2` (`bindings` -> `agent_<32-hex>`) and local supervisor messaging **without** starting a runner adapter or requiring a runner binary (or if owner selects Option B in `CD-2`, an `enabled: false` identity-only profile with adjusted inventory/CLI rules).
     - `chat-map` and `local-messaging-host` refuse configs where the same `principal_id` is claimed by an active runner/paired lane or by two live selectors (`principal_has_active_lane`).

---

### 3.2 Part A — Owner-approval (`D5-C`) extension (JS + Swift + Packaging)

#### 1. Shared operation union (`packages/triangle-cli/src/owner-approval.mjs`)

Generalize `normalizeOwnerOperation` and `describeOwnerOperation` as a strict discriminated union `owner_operation_v1`, staying well within `owner-approval-macos.mjs`'s `16384`-byte stdin and `4096`-byte stdout frame limits. Unlike existing `profile.*` operations (`registryRoot`, `expectedSequence`, `profileId`, `before`, `after`), each action declares its exact store root, `expectedSequence`, and expected `before` state cleanly:

| Action | Allowed fields (canonical validated) | Swift prompt summary (recomputed locally in Swift) |
| --- | --- | --- |
| `profile.revoke` *(existing)* | `action`, `registryRoot`, `expectedSequence`, `profileId`, `before` | Unchanged (`identity revoke`) |
| `profile.move` *(existing)* | `action`, `registryRoot`, `expectedSequence`, `profileId`, `before`, `after` | Unchanged |
| `destination.set` *(new, if `CD-4` uses D5-C)* | `action`, `registryRoot`, `expectedSequence`, `principalId`, `harness` (`"claude"`\|`"codex"`), `workspace`, `before` (`null` or prior `{ harness, workspace, generation }`) | `Set destination for <principalId> to <harness> chat in <workspace>` |
| `destination.clear` *(new, if `CD-4` uses D5-C)* | `action`, `registryRoot`, `expectedSequence`, `principalId`, `before` (`{ harness, workspace, generation }`) | `Clear destination for <principalId> (<harness> chat in <workspace>)` |
| `chat.map.set` *(new D4 selector create/move)* | `action`, `storeRoot`, `expectedSequence`, `selectorId`, `harness`, `workspace`, `principalId`, `authorityOrigin`, `bindingGeneration`, `before` (`null` or prior `{ principalId, bindingGeneration }`) | `Map <harness> chats in <workspace> to <principalId>` (or `Move ...`) |
| `chat.map.revoke` *(new D4 selector removal)* | `action`, `storeRoot`, `expectedSequence`, `selectorId`, `harness`, `workspace`, `before` (`{ principalId, bindingGeneration }`) | `Revoke chat mapping for <harness> chats in <workspace> (<principalId>)` |
| `chat.confirm` *(only if `CD-3 = B`)* | `action`, `storeRoot`, `expectedSequence`, `selectorId`, `sessionId`, `harness`, `workspace`, `before` (`{ principalId, bindingGeneration, confirmedSessionId: null \| sessionId }`) | `Confirm attached <harness> chat <short-session> in <workspace> as <principalId>` |

Every operation checks `expectedSequence` and `canonicalJson(currentBefore) === canonicalJson(op.before)` inside the store lock after OS approval returns, throwing `registry_sequence_conflict` / `owner_approval_stale` on any race.

#### 2. Native Swift provider (`scripts/probes/owner-approval-provider.swift`)

- Extend `--validate-request` and `--authenticate` to validate every new `action` with strict field allowlists, regexes (`agent_`, `session-`, `"claude"|"codex"`, bare HTTPS origin, canonical absolute non-symlink paths, positive safe integers), and **locally reconstruct the exact `summary` string in Swift** before passing it to `LAContext`.
- Preserve existing guarantees: zero network calls, zero filesystem registry mutations, `16384`-byte stdin limit, fresh `LAContext` per `--authenticate` call, bounded JSON decision stdout; `cli.mjs:430–431` continues mapping signal/refusal outcomes to CLI exit codes (`130`/`143`/`2`/`1`).
- Add automated `--validate-request` tests in `packages/triangle-cli/test/owner-approval-native.test.mjs` covering valid payloads and missing/extra/spoofed fields across all actions.

#### 3. Packaging & capability model (`build-client-package.mjs` + `identity-revoke.mjs` + shared loader)

- **Fix `identity-revoke.mjs:24` exact-array fragility:** extract a shared packaged capability verifier (e.g. `owner-approval-package.mjs`) that enforces the signed-manifest contract (`schema === 1`, `platform === "darwin"`, `arch === process.arch`, `testOnly === false`, `ownerApprovalCandidate === undefined`, `signingMode === "public_ad_hoc"`, `credentialCustody === "file"`, `policy.version === 1`, `policy.binary === "bin/triangle-owner-approval"`, `files` SHA-256 entry verified at mode `0o700`) and validates that `policy.commands` is an array of unique known command strings containing the caller's required command (`policy.commands.includes("identity.revoke")`, etc.).
- Update `scripts/release/build-client-package.mjs` `--owner-approval`: keep `"candidate"` and `"revoke"`, and add `"identity"` (emitting `["identity.revoke", "identity.destination", "identity.chat-map"]` once accepted).
- Update `packages/triangle-cli/test/owner-approval-registry.test.mjs:91` import boundary rules cleanly if a shared registry/store adapter is added.

---

### 3.3 Part B — Chat Mapping (`D4`: Selector + Single-Chat Confirmation + Uniqueness Fence)

#### 1. Store location & schema (`CD-1`)

- **Option A (Recommended): Dedicated owner-approved store under `client/local/chat-mappings-v1.json` (OUTSIDE `identity/`), leaving `identity-registry` at `v2`.**
  - *Crucial custody rule:* Because `identity-registry.mjs:1529–1559` (`verifyRootEntriesCustody`) rejects any unexempted files/subdirectories/locks inside `identity/`, `chat-mappings-v1.json` (plus its lock/temp files or local mutation journal) **must live under `client/local/` (mode `0o700` dir, `0o600` files, non-symlink checked)** rather than inside `identity/`.
  - Separating D4 from `identity-registry-v1.json` avoids forcing a `v2 -> v3` registry upgrade/restore cycle and keeps ephemeral per-chat confirmation updates out of the 8 MiB append-only `registry-audit.jsonl`.
  - Schema (`version: 1`, monotonic `sequence`, `O_NOFOLLOW` + atomic write under exclusive lock):
    - `selectors`: keyed by `${harness}\0${workspace}` -> `{ selectorId, harness, workspace, principalId, authorityOrigin, bindingGeneration, createdAt, updatedAt }` (at most 1 selector per `(harness, workspace)`; one principal may own at most 1 selector unless `CD-2` forbids duplicates).
    - `confirmations`: keyed by `${harness}\0${workspace}` -> `{ sessionId, selectorId, principalId, bindingGeneration, confirmedAt }` (at most 1 active confirmed session per selector).
- **Option B (`CD-1` alternative):** Upgrade `identity-registry` to `v3` for durable selectors while keeping ephemeral per-chat confirmations in `client/local/`.

#### 2. Two-layer state machine & anti-substitution uniqueness fence (`U3 3.A.3`)

Evaluated deterministically in `local-messaging-interactive-session.mjs` / `local-sender-authentication.mjs` on attach, detach, `list_sessions`, `discover_recipients`, `send_message`, `session_status`, and `local_status`:

1. **Match selector & check registry custody via `router-registry-snapshot.mjs` (`U3 3.B`):**
   - Resolve live registry snapshot (reusing `snapshotProvider` rather than adding a forbidden direct `identity-registry` importer under `identity-registry.test.mjs:1646–1655` and using `identity-primitives.mjs:7–40` patterns).
   - No selector for `(session.harness, canonicalWorkspace)` -> `state: "unbound"`, `principal: null`.
   - Registry unavailable/corrupt or binding missing/revoked/`serverless-peer`/rotated `bindingGeneration !== selector.bindingGeneration` -> fail closed: `state: "stale_principal"`, `principal: null`.
   - Active runner lane or bound `inbox`/`interactive` conversation also holds `selector.principalId` -> `state: "lane_conflict"`, `principal: null` (`U3 3.C.4`).
2. **Count matching live attached sessions in `(selector.harness, selector.workspace)`:**
   - **If `count > 1` (`ambiguous_concurrent_chats`):**
     - **Every** matching attached session evaluates immediately to `principal: null`.
     - **Anti-substitution clearing (`U3 3.A.3`):** immediately **invalidate/clear `confirmations[(harness, workspace)]`** when ambiguity is detected (persisted cleanly or fenced by epoch/confirmation invalidation) so closing the second chat does *not* silently re-promote the surviving chat without a fresh explicit confirmation.
   - **If `count === 1` (`sessionId`):**
     - If `confirmations[(harness, workspace)]` matches `{ sessionId, selectorId, principalId, bindingGeneration }` -> **`state: "mapped"`**, returning `{ principal, authorityOrigin, bindingGeneration, harness, workspace, selectorId }`.
     - Otherwise -> `state: "pending_confirmation"`, `principal: null`.

#### 3. Local provenance, reply pins, status, and CLI

- **Decouple `senderProvenance` from `replyRoute` / `reply-identity.json`:**
  - Update `local-messaging-journal.mjs:735–747` so attached sends record `sender_provenance_json` directly in the base `local_messages` insert whenever `authenticateAttachedLocalSender` supplies mapped provenance — independent of `reply-identity.json` (`local-messaging-server.mjs:659–661`) and independent of `replyRoute`.
  - Keep `local-reply-route-store.mjs:40–53` / `local-reply-route-contract.mjs` reply pinning intact for `SESSION <-> SESSION` sends when `replyPolicy.enabled === true` (and document explicitly in `CD-6` that extending reply pins across runner/desktop <-> mapped-chat paths would require adapting `checkAttachedIdentity` in `local-messaging-journal.mjs:743–744` and offline checks in `local-sender-authentication.mjs:59`).
- **Status surfaces (`local_status`, `session_status`, `list_sessions`):**
  - Replace static `describeChatBinding()` (`local-messaging-server.mjs:70–72`) in host `statusProvider()` (`triangle-local status`) with real D4 selector + attached-chat summary (`mapped`, `pending_confirmation`, `ambiguous_concurrent_chats`, `stale_principal`, `lane_conflict`).
  - Surface each attached session's own mapping state in `ownSessionStatus` / `session_status` (`local-messaging-server.mjs:432–436, 454`) as well so attached interactive sessions can observe whether their own chat is `unbound`, `pending_confirmation`, `mapped`, or `ambiguous_concurrent_chats`.
- **CLI commands (`triangle identity chat-map ...`):**
  - `triangle identity chat-map set --harness claude|codex --workspace DIR --target <PROFILE|agent_ID> [--client-root DIR] [--registry-root DIR] [--confirm PLAN_ID]` -> **D5-C** OS re-auth; canonical `realpathSync` directory validation; checks `CD-2` non-runner isolation.
  - `triangle identity chat-map revoke --harness claude|codex --workspace DIR [--client-root DIR] [--registry-root DIR] [--confirm PLAN_ID]` -> **D5-C** OS re-auth; removes selector and clears any stored confirmation.
  - `triangle identity chat-map confirm [SESSION_ID | --harness claude|codex --workspace DIR] [--client-root DIR] [--confirm PLAN_ID]` -> requires **exact 1** live attached session matching an active selector; gate governed by `CD-3` *(noting explicitly that Option A `D5-B` refines `U3`'s broad `D5-C` phrasing just as `AD-2` refined `identity alias`)*.

---

### 3.4 Part C — Destination Rules (`AD.5`: Registry Writer + CLI + View/Doctor + Router)

#### 1. Registry writer (`packages/agent-worker/src/identity-registry.mjs`)

Mirror `setIdentityAlias` / `clearIdentityAlias` (`:2567, 2593`):
- **`setIdentityDestination({ root, principalId, harness, workspace, now, expectedSequence, faultHook })`:**
  - `action: "destination_set"`, `subject: principalId`, `bindingId: null`.
  - Requires `registry.schema === "identity_registry_v2"`, active `mesh-managed` (`agent_<32-hex>`) binding in `registry.bindings`, `harness ∈ {"claude", "codex"}`, canonical existing directory `realpathSync(workspace) === workspace`, `Object.keys(destinations).length < MAX_REGISTRY_DESTINATIONS` (256), create-only (refuse if already set unless moved per `CD-5`).
  - Sets **`generation: expectedSequence + 1`** (matching `setIdentityAlias` at `:2586`, since `registry-audit.jsonl` does not retain cleared `destinations` fields to recover a prior rule's generation).
- **`clearIdentityDestination({ root, principalId, now, expectedSequence, faultHook })`:**
  - `action: "destination_clear"`, `subject: principalId`, `bindingId: null`.
  - Refuses if absent (`destination_not_found`); honors `expectedSequence`.

#### 2. CLI (`triangle identity destination set|clear`)

- `triangle identity destination set <TARGET> --harness claude|codex --workspace DIR --client-root DIR [--registry-root DIR] [--confirm PLAN_ID]`
  - Resolves active `mesh-managed` `<TARGET>` (profile name or `agent_<32-hex>`).
  - Checks runner/bound-conversation overlap (`CD-2`: refuse or warn `shadowed_by_runner`).
  - Two-phase plan / `--confirm <64-hex PLAN_ID>`, local non-SSH TTY + `CD-4` gate (recommended: **D5-C** OS re-auth on `set`).
- `triangle identity destination clear <TARGET> --client-root DIR [--registry-root DIR] [--confirm PLAN_ID]`
  - Shows exact `{ principalId, harness, workspace, generation }` before clearing under TTY + `CD-4`.

#### 3. View, Doctor, and Router integration (`CD-6`)

- **`identity-view.mjs` (`describeDestinations`), `identity-status.mjs`, `doctor.mjs`:**
  - Emit structured destination rows (`ready_1_chat`, `no_attached_chat`, `unconfirmed_chat`, `ambiguous_chats`, `shadowed_by_runner`, `principal_revoked`, `workspace_missing`) alongside `aliases` (keeping clean human formatting when `destinations` is empty).
- **`router-registry-snapshot.mjs`, `recipient-resolver.mjs`, `unified-router.mjs`, `local-messaging-server.mjs` (`CD-6`):**
  - Export validated active `destinations` on `router-registry-snapshot.mjs`.
  - **If `CD-6 = A` (end-to-end local routing):** update local resolution so when an alias or `agent_<32-hex>` targets a non-runner principal with a `destinations[principalId]` rule (and no runner/bound conversation claims it, `U3 3.C.2` rule 3), `unified-router` / `local-messaging-server` resolves **dynamically at send time** to the single confirmed attached session in `(harness, workspace)` — checking sender authorization (`sessionMessaging` / owner ACL / principal-level capability rather than static `allowedRecipients` `INSTANCE_ID_PATTERN` snapshots in `recipient-resolver.mjs:73–85` and `local-messaging-server.mjs:587, 610`!), returning `no_destination` / `destination_ambiguous` / `unconfirmed_chat` when `0`, `>1`, or unconfirmed chats match.
  - **If `CD-6 = B`:** stop at snapshot + CLI + `identity-view`/`doctor` diagnostics and wire delivery in the MESH `admitInbound` slice.

---

## 4. Compatibility, fail-closed invariants, and runtime floor

1. **Supervisor runtime floor (`14 -> 15`):**
   - Bump `CURRENT_MANIFEST_VERSION` (`14 -> 15`) in `scripts/triangle-worker-install.py:110` (and its `{8..14}` checks), `WorkerLauncher.swift:168, 467, 614` (`enforceReplyIdentityRuntimeFloor` + new D4 modules in artifact manifest), `installation-inventory.mjs:61, 652` (`WORKER_MANIFEST_VERSIONS`), and `MINIMUM_RUNTIME_MANIFEST` (`14 -> 15`) in `identity-upgrade.mjs`. Verify `setup-runtime.mjs` checks consistently.
   - Because on-disk manifests can outrun a still-running older supervisor daemon, `triangle identity chat-map` plan/confirm must check **both** on-disk manifest `>= 15` **and** a running `local_status` capability field (e.g. `router.addressForms` / `identity.chatMappingVersion >= 1` + `rootSha256`, matching `identity-upgrade.mjs` probing running `supervisor`), failing closed if the running supervisor cannot enforce D4 uniqueness & revocation fences.
2. **Boundary tests & fail-closed invariants:**
   - Preserve `allowedImporters` in `packages/agent-worker/test/identity-registry.test.mjs:1646–1655` and `packages/triangle-cli/test/owner-approval-registry.test.mjs:91` (updating intentionally only for approved modules).
   - Ambiguous concurrent chats -> all matching attached chats evaluate `principal: null`, stored confirmation invalidated, destination route refuses with `destination_ambiguous`.
   - Revoked / rotated binding -> immediate fail-closed `principal: null` via live snapshot generation comparison.
   - Missing/candidate/unaccepted `ownerApproval`, command missing from `policy.commands`, `testOnly !== false`, SHA-256 mismatch, or SSH session -> `--confirm` refuses fail-closed (`owner_approval_unavailable` / exit `2`).
3. **Rollback:**
   - Clearing/removing `client/local/chat-mappings-v1.json` immediately drops all attached chats to `unbound` with zero impact on `identity-registry-v1.json`.
   - `clearIdentityDestination` clears rules cleanly; `restore-registry --discard-v2-data` already accounts for `destinations`.

---

## 5. Phased build sequence and release gates

Assuming owner decisions in [§6](#6-owner-decisions-required-before-build) are approved:

1. **Build Slice 1 — Owner-approval (`D5-C`) generalization + packaging:**
   - Extend `owner-approval.mjs`, `owner-approval-macos.mjs`, `scripts/probes/owner-approval-provider.swift`, shared `owner-approval-package.mjs`, `identity-revoke.mjs:24` fix, `build-client-package.mjs`, and `--validate-request` tests (keeping `identity.revoke` regression green).
2. **Build Slice 2 — `AD.5` Destination rules (`identity-registry.mjs`, CLI, view/doctor, snapshot):**
   - Implement `setIdentityDestination`, `clearIdentityDestination`, `assertMutationMatchesAction`, `triangle identity destination set|clear`, `describeDestinations`, `doctor --identity`, snapshot export, and writer + CLI hardening tests.
3. **Build Slice 3 — `D4` Chat mapping + runtime floor `15` + non-runner lane (`CD-2`) + router hook (`CD-6`):**
   - Implement `DeliveryMode.router` (or chosen `CD-2` mode) across Swift/inventory/CLI, `client/local/chat-mappings-v1.json`, decoupling of `sender_provenance_json`, uniqueness fence + anti-substitution clearing, `authenticateAttachedLocalSender`, `describeChatBinding`/`ownSessionStatus`, `triangle identity chat-map`, manifest `15`, and end-to-end integration tests.
4. **Packaged Acceptance & Live Install Gate (separate from merge):**
   - Build signed Darwin package (`--owner-approval identity`), extract to disposable dir on Mini, run physical Touch ID / password acceptance (`cancel`, `apply`, `interrupt`, `expire`) for each new OS-auth command, record acceptance evidence, and obtain explicit owner sign-off before live installation or touching live Mini state.

---

## 6. Owner Decisions Required Before Build

| ID | Decision | Options | Recommendation & Why |
| --- | --- | --- | --- |
| **CD-1** | Where D4 chat-mapping state lives | **A.** Dedicated store `client/local/chat-mappings-v1.json` (outside `identity/`) + supervisor floor `15`, keeping `identity-registry` at `v2`<br>**B.** Bump `identity-registry` to `v3` for selectors + `client/local/` for confirmations | **A.** Keeps `identity/` custody intact (`verifyRootEntriesCustody`), avoids a full `v2 -> v3` registry migration cycle, and keeps ephemeral session confirmations out of `registry-audit.jsonl` |
| **CD-2** | Principal & lane model for D4 chats & `destinations` (`U3 3.C.4`) | **A.** Dedicated `DeliveryMode.router` profile across Swift (`ClientInstance`, `ClientSupervisor`, `TriangleClientCLI`) + JS (`installation-inventory`, `identity-inventory`), enforcing strict exclusion from active runners/bound inbox<br>**B.** Dedicated `enabled: false` identity-only profile with adjusted CLI/doctor health rules<br>**C.** Allow sharing a runner profile when manually paused | **A.** Cleanest long-term architecture (`interface design §4.5`); avoids overloading `"disabled"` health diagnostics and cleanly prevents runner shadowing (`U3 3.C.2`) |
| **CD-3** | Approval gate for D4 Layer 2 (`chat confirm` per new attached chat) | **A.** Selector `set`/`revoke` = **D5-C** (OS re-auth); per-chat `confirm` = **D5-B** (local owner TTY + `--confirm PLAN_ID` matching 1 live chat against an OS-approved selector) *(explicit carve-out to `U3 D5-C` wording)*<br>**B.** Both selector `set`/`revoke` AND every individual `chat confirm` = **D5-C** | **A** (or **B** if every new session promotion must prompt Touch ID). With **A**, OS re-auth gates workspace->principal authority while new chats in an approved workspace confirm without repetitive Touch ID prompts |
| **CD-4** | Approval gate for `AD.5` (`destination set\|clear`) | **A.** **D5-C** (OS re-auth) for both `destination set` and `destination clear`<br>**B.** **D5-C** for `set`, **D5-B** (TTY + `--confirm`) for `clear`<br>**C.** **D5-B** for both (like `identity alias`) | **A** (or **B**). Destination rules redirect inbound principal delivery to a workspace; OS re-auth on `set` blocks silent re-pointing from an already-open terminal |
| **CD-5** | Overwrite semantics for `destination set` & `chat-map set` | **A.** Create-only (like `identity alias`: `clear`/`revoke` first to change target)<br>**B.** Allow in-place overwrite with explicit `before -> after` OS-auth plan | **A.** Matches `identity alias`, keeps audit/generation/plan checks minimal, and makes clears explicit audited transitions |
| **CD-6** | Local router scope for `AD.5` + `D4` in this train | **A.** Export `destinations` in `router-registry-snapshot` + wire local `unified-router` / `local-messaging-server` to deliver non-runner destination principals to their single confirmed attached chat dynamically (adapting authorization beyond static `allowedRecipients` snapshots; reply pins stay `SESSION <-> SESSION` until reply-pin expansion)<br>**B.** Export snapshot + CLI + `identity-view`/`doctor` readiness checks only; defer delivery routing to MESH `admitInbound` | **A.** Delivers immediate end-to-end local verification for `AD.5` + `D4` together (keeping `SESSION <-> SESSION` reply pinning separate or noting if runner/desktop replies should wait) |
| **CD-7** | Bundle `profile.move` CLI support in Slice 1? | **A.** Keep `profile.move` CLI deferred; Slice 1 generalizes provider & manifests for `destination.*` + `chat.map.*` only<br>**B.** Build `profile.move` CLI in Slice 1 | **A.** Prevents scope creep while ensuring the generalized `ownerApproval` contract cleanly supports `profile.move` later |
