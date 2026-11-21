# Destination rules and local chat mappings (`M6` runbook)

Runbook for `triangle identity destination set|clear` (`AD.5`) and `triangle identity chat-map set|confirm|revoke` (`D4`). Design and post-build decisions: `docs/plans/2026-11-12-chat-mapping-destination-rules-plan.md` (PR `#179`, including §7).

Both features work together to route local principal sends (`agent_<32-hex>`) to a specific attached workspace chat when no local worker runner or paired conversation owns that principal:

- **Destination rules (`AD.5`)** live inside the host-local identity registry (`<application root>/identity/identity-registry-v1.json`, schema `identity_registry_v2`, max `256` entries, audited `destination_set` / `destination_clear`). A rule maps one active `mesh-managed` principal without an active runner to `(harness, workspace)`, where `harness` is `claude` or `codex` and `workspace` is a canonical existing non-symlink directory.
- **Chat mappings (`D4`)** live in `<stateRoot>/chat-mappings-v1.json` (mode `0600` inside a `0700` canonical directory **outside** `identity/`, preserving `identity/` root custody). Binding a principal to a live attached chat has two layers:
  1. `chat-map set` creates a `pending` selector (`sel_<32-hex>`, derived from `sha256(harness + "\0" + canonicalWorkspace)`) binding one `(harness, workspace)` pair to one active `mesh-managed` principal.
  2. `chat-map confirm` binds that selector to the **single** live attached session (`session-<64-hex>`) currently open in `(harness, workspace)`.

Examples use `--client-root "$HOME/Library/Application Support/The Triangle/client"` (quote paths containing spaces). An explicit `--registry-root` must be a canonical directory in the same application root as `--client-root`.

---

## Prerequisites, runtime floor, and approval gates

1. **A `v2` registry (`identity_registry_v2`).** On a `v1` registry, `identity destination` refuses with `registry_not_v2` (and `identity chat-map` requires an active `mesh-managed` binding in a readable registry). Run `triangle identity upgrade-registry` first (`docs/triangle-client/identity-registry-v2-upgrade.md`).
2. **Runtime manifest `v15` and `v15`-capable Swift helpers.**
   - `scripts/triangle-worker-install.py` stages `v15` (`91` supervisor artifacts, adding `packages/agent-worker/src/local-chat-mapping.mjs`), and `WorkerLauncher.swift` accepts manifest versions `5...15`.
   - **Install and rollback ordering:** Install `v15`-capable Swift helpers (`triangle-mailbox`, `triangle-client`) **before** staging `v15` manifests. When rolling back, revert manifests and revoke/remove `chat-mappings-v1.json` **before** downgrading to a pre-`v15` helper (for example `0.2.0-identity.3`, whose `WorkerLauncher` rejects `v15` manifests).
3. **Owner terminal and D5-C OS authentication (`CD-3 = B`, `CD-4 = A`, ratified `2026-11-20`).**
   - Planning (`without --confirm`) writes nothing.
   - Applying (`--confirm PLAN_ID`) for **both** `destination set|clear` and `chat-map set|confirm|revoke` requires:
     - a local interactive terminal on stdin and stdout (`SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`, or a non-TTY stream exits `2`);
     - the exact 64-hex `PLAN_ID` from a fresh plan; and
     - packaged **D5-C OS owner authentication** (`bin/triangle-owner-approval`, via macOS `LAContext`).
4. **Plain vs `--owner-approval identity` client packages.**
   - A plain client package (built without `--owner-approval`) allows read-only planning (`destination set|clear`, `chat-map set|confirm|revoke` without `--confirm`) and inspecting state (`status --identity`, `doctor --identity`), and **fails closed** on `--confirm` with `owner_approval_unavailable`.
   - Applying destination rules or chat mappings requires a Darwin release package built with `--owner-approval identity` (`ownerApproval.commands: ["identity.revoke", "identity.destination", "identity.chat-map"]` in `package-manifest.json`), installed after physical macOS Touch ID / password acceptance (`cancel`, `apply`, `interrupt`, `expire`) on a disposable extract.
5. **Non-runner principal isolation (`DeliveryMode.router` / no active runner).** Destination rules are refused at plan time (`destination_target_has_runner`) if the principal has an active runner profile (`worker`, `headless-app-server`, `headless-cursor-acp`, `event-driven`, `grok-bot`, `mcp-interactive`) or appears in `<client-root>/local-messaging.json`'s `recipients`. Disabled runner profiles or `router`-mode profiles do not trigger runner overlap.

---

## Destination rules (`triangle identity destination`)

### Set a destination rule

```sh
triangle identity destination set TARGET \
  --harness claude|codex \
  --workspace /canonical/path/to/workspace \
  --client-root "$HOME/Library/Application Support/The Triangle/client"
```

`TARGET` is an active `mesh-managed` principal ID (`agent_<32-hex>`) or profile name with a single active `mesh-managed` binding. Destination rules are **create-only** (no silent overwrite: `clear` first before setting a different target). The plan writes nothing and prints the `Way back` clear command and `Plan ID`.

Apply from a local owner terminal (triggers OS authentication):

```sh
triangle identity destination set TARGET \
  --harness claude|codex \
  --workspace /canonical/path/to/workspace \
  --client-root "$HOME/Library/Application Support/The Triangle/client" \
  --registry-root "$HOME/Library/Application Support/The Triangle/identity" \
  --confirm PLAN_ID
```

### Clear a destination rule

```sh
triangle identity destination clear TARGET \
  --client-root "$HOME/Library/Application Support/The Triangle/client"

triangle identity destination clear TARGET \
  --client-root "$HOME/Library/Application Support/The Triangle/client" \
  --registry-root "$HOME/Library/Application Support/The Triangle/identity" \
  --confirm PLAN_ID
```

### `identity destination` refusal and error codes

| Code | Meaning |
| :--- | :--- |
| `registry_absent`, `registry_unreadable`, `registry_not_v2`, `registry_schema_unknown`, `registry_not_canonical` | The registry is missing, unreadable, still `v1`, unknown schema, or uses a symlinked/non-canonical path. |
| `local_messaging_config_unreadable` | `<client-root>/local-messaging.json` exists but is invalid/unreadable to the supervisor's loader, so runner overlap cannot be checked (`set` refuses). |
| `destination_harness_invalid` | `--harness` is not `claude` or `codex`. |
| `destination_workspace_invalid`, `destination_workspace_not_found`, `destination_workspace_not_directory`, `destination_workspace_not_canonical` | `--workspace` is not a canonical existing non-symlink directory. |
| `destination_target_not_found`, `destination_target_not_active`, `destination_target_not_mesh_managed`, `destination_target_ambiguous` | `TARGET` does not resolve to one active `mesh-managed` (`agent_`) principal (e.g., `peer_` or revoked). |
| `destination_target_has_runner` | The principal is claimed by an active runner/interactive profile or listed in `local-messaging.json` `recipients`. |
| `destination_exists`, `destination_conflict` | A destination rule already exists for this principal (create-only; `clear` first). |
| `destination_map_full`, `too_many_destinations` | Registry already holds `256` destination rules. |
| `destination_not_found` | No destination rule exists for `TARGET` (`clear`). |
| `confirmation_mismatch`, `plan_stale`, `registry_sequence_conflict`, `owner_approval_stale` | `--confirm` is not 64 hex, state changed since planning, or state changed during OS approval (make a fresh plan). |
| `owner_approval_unavailable`, `owner_approval_cancelled`, `owner_approval_denied`, `owner_approval_expired` | Package lacks `identity.destination` capability, OS prompt was cancelled/denied, or the approval window expired. |
| `invalid_owner_operation`, `registry_busy`, `updated_before_created`, `destination_verification_failed` | Invalid canonical paths/parameters, registry lock held, clock earlier than registry timestamp, or post-write readback mismatch (`destination_verification_failed` marks `writeAttempted: true`; inspect with `triangle status --identity`). |

---

## Chat mappings (`triangle identity chat-map`)

### Store root default (`--store-root`)

When `--store-root` is omitted, the CLI reads `stateRoot` from `<client-root>/local-messaging.json` using the supervisor's loader (`defaultChatMapStoreRoot`) and falls back to `<client-root>/local` if the config is absent or unreadable. That matches the directory where the running supervisor reads `<stateRoot>/chat-mappings-v1.json`.

### Set a selector (`pending`)

Creates a `pending` selector for `(harness, canonicalWorkspace)` pointing to `--principal AGENT_ID`. One selector per `(harness, workspace)` and at most one selector per `principalId`:

```sh
triangle identity chat-map set \
  --principal agent_... \
  --harness claude|codex \
  --workspace /canonical/path/to/workspace \
  --client-root "$HOME/Library/Application Support/The Triangle/client"

# Apply with exact plan output (includes --store-root, --registry-root, and --confirm PLAN_ID):
triangle identity chat-map set \
  --client-root "$HOME/Library/Application Support/The Triangle/client" \
  --store-root "$HOME/Library/Application Support/The Triangle/client/local" \
  --registry-root "$HOME/Library/Application Support/The Triangle/identity" \
  --harness claude|codex \
  --workspace /canonical/path/to/workspace \
  --principal agent_... \
  --confirm PLAN_ID
```

### Confirm the single live attached chat

Requires **exactly one** live attached chat matching `(harness, workspace)` at both plan time and inside the lock at commit time. The confirmed plan binds only that exact `session-<64-hex>` address:

```sh
triangle identity chat-map confirm \
  --harness claude|codex \
  --workspace /canonical/path/to/workspace \
  --client-root "$HOME/Library/Application Support/The Triangle/client"

# Or address by selector ID (`sel_<32-hex>`):
triangle identity chat-map confirm \
  --selector sel_... \
  --client-root "$HOME/Library/Application Support/The Triangle/client" \
  --confirm PLAN_ID
```

### Revoke a chat mapping

Removes the selector and any confirmation:

```sh
triangle identity chat-map revoke \
  --harness claude|codex \
  --workspace /canonical/path/to/workspace \
  --client-root "$HOME/Library/Application Support/The Triangle/client"

triangle identity chat-map revoke \
  --selector sel_... \
  --client-root "$HOME/Library/Application Support/The Triangle/client" \
  --store-root "$HOME/Library/Application Support/The Triangle/client/local" \
  --confirm PLAN_ID
```

### `identity chat-map` error codes

| Code | Meaning |
| :--- | :--- |
| `identity_registry_unavailable` | Registry at `--registry-root` could not be read (`set`). |
| `identity_binding_not_active`, `identity_binding_not_supported` | Principal has no active binding, or its active binding is not `mesh-managed`. |
| `chat_mapping_exists`, `chat_mapping_principal_exists` | A selector already exists for `(harness, workspace)` or for `--principal` (`revoke` first). |
| `chat_mapping_not_found`, `chat_mapping_already_confirmed` | No selector exists for `--selector` / `(harness, workspace)`, or it is already `confirmed`. |
| `chat_mapping_no_live_session`, `chat_mapping_ambiguous_session` | `0` live attached chats (`confirm` needs 1) or `> 1` live attached chats in `(harness, workspace)` (anti-substitution fence). |
| `chat_mapping_session_mismatch`, `chat_mapping_session_conflict` | Live attached chat changed since planning, or that session is already mapped to another selector. |
| `chat_mapping_corrupt`, `chat_mapping_custody`, `chat_mapping_store_missing`, `chat_mapping_invalid_store_root` | `chat-mappings-v1.json` or its store directory failed JSON/schema/permission/ownership/canonical checks (`0700` dir, `0600` non-symlink file). |
| `sequence_mismatch`, `plan_stale`, `confirmation_mismatch`, `owner_approval_stale` | Store sequence or state changed before or during OS approval (re-plan). |
| `owner_approval_unavailable`, `owner_approval_cancelled`, `owner_approval_denied`, `owner_approval_expired` | Package lacks `identity.chat-map` capability, OS prompt was cancelled/denied, or approval window expired. |

---

## What senders see and security behavior (as built)

1. **Owner-policy gate first (`M1`).** When a sender sends to a destination-mapped principal (`agent_<32-hex>`), the server checks whether the owner policy allows that sender to message the pinned chat (or, before confirmation, a chat of `destination.harness`) without checking live lease/lifecycle.
   - **Unauthorized sender:** Receives the baseline no-rule error (`route_unavailable`) and increments only the `route_unavailable` counter, indistinguishable from an unmapped principal.
   - **Authorized sender:** Receives the specific destination/mapping state if delivery cannot complete:
     - `chat_mapping_missing` (no `chat-mappings-v1.json` or no matching selector)
     - `chat_mapping_unconfirmed` (selector is `pending`)
     - `chat_mapping_stale_generation` (binding rotated or revoked vs selector's `bindingGeneration` / `authorityOrigin`)
     - `chat_mapping_corrupt`, `chat_mapping_custody`, `chat_mapping_unreadable` (mapping store unreadable or bad permissions)
     - `destination_binding_inactive` (invalid destination binding metadata)
     - `destination_session_offline` (confirmed `session-<64-hex>` is not currently live-attached in `(harness, workspace)`)
     - `destination_session_ambiguous` (`> 1` live attached match for the confirmed session)
   - **Credential scope:** Even when the owner policy allows the sender, actual delivery still requires the server ACL and the target `session-<64-hex>` inside the sender's static turn credential scope (`claims.allowedRecipients`, fixed at attach time; dynamic scope expansion is deferred).
2. **Sender provenance and reply pinning (`M2`, `M3`, ratified `2026-11-20`).**
   - **Reply identity off (default live state, `client/reply-identity.json` `enabled: false`):** Attached chats are not authenticated and carry no `senderProvenance.principal`.
   - **Reply identity on (`enabled: true`):** A confirmed mapped chat carries its `principal` (`assurance.principal_binding = "owner-mapped-disk-observation"`) only while both the confirmed mapping and an active `mesh-managed` binding at the matching generation hold. Revoking the binding in `identity-registry-v1.json` removes the principal on the next send without restarting the host.
   - **Offline requester & in-flight mapping changes:** A reply to an offline requester pinned with a principal fails closed with `session_offline` (retry when back; not queued). After `chat-map confirm` or `revoke`, replies to requests pinned before the change fail closed (`reply_session_mismatch` / `reply_remote_mismatch`).
3. **Aliases vs destination rules.** Identity aliases (`aliases.<name>`) currently resolve to bound local runner recipients and do **not** route via destination rules (tracked for the post-restage follow-up PR).

---

## Inspecting state and troubleshooting

### Identity status and doctor

```sh
triangle status --identity --client-root "$HOME/Library/Application Support/The Triangle/client"
triangle doctor --identity --client-root "$HOME/Library/Application Support/The Triangle/client"
```

When `destinations` is non-empty in a `v2` registry, `status --identity` and `doctor --identity` list each rule with its derived state:

| Row State | Meaning & Operator Action |
| :--- | :--- |
| `active` | Principal has one active `mesh-managed` binding and no runner/local-recipient conflict. |
| `dangling` | Principal has no active binding (revoked). `triangle identity destination clear ...` |
| `not_mesh_managed` | Principal's active binding is a `serverless-peer`. `triangle identity destination clear ...` |
| `shadowed_by_runner` | An enabled runner/interactive profile or `local-messaging.json` recipient holds the principal (`runnerProfiles` listed). Disable/switch the runner profile or clear the rule. |

### Local supervisor status

```sh
"$HOME/Library/Application Support/The Triangle/bin/triangle-local" status
```

- `chatBinding` prints the default host summary (`unbound` view; does not enumerate mappings).
- If any recipient configured in `local-messaging.json` has no running adapter (for example a disabled runner profile), the host stays up and reports `unavailableRecipients: [...]` in `status` (plus one `triangle_client_local_recipient_not_running` notice in the owner log). New sends to that recipient fail with `local_recipient_unavailable` before admission, while existing queued work remains `queued_local` until a start where its runner is active.
- A send attempting to reuse an ID already held by a reply in `local_replies` fails with `message_id_in_use` and leaves no message row (retry under a fresh `messageId`; replies themselves may still reference an existing message's ID, and exact retries of that original message continue to deduplicate).

### Recovery and rollback

- **Drop all chat mappings immediately:** Revoke individual selectors with `triangle identity chat-map revoke`, or remove `<stateRoot>/chat-mappings-v1.json` — all attached chats drop immediately to `unbound` with zero effect on `identity-registry-v1.json`.
- **Restore registry before `v2`:** `triangle identity restore-registry --from ... --discard-v2-data` counts `destinations` as `v2`-only data and refuses without `--discard-v2-data` when destination rules exist. `restore-registry` does not touch `chat-mappings-v1.json`.
- **Corrupt or wrong-mode mapping store:** Fix permissions (`chmod 0700 <stateRoot>`, `chmod 0600 <stateRoot>/chat-mappings-v1.json`) or revoke/remove the corrupt file; the host treats an unreadable store as unmapped for attached chats and denies destination routing to authorized senders with `chat_mapping_corrupt` / `chat_mapping_custody`.

---

## Exit codes

`0` done, or a ready plan; `1` refused plan or failed operation; `2` usage error, malformed/`plan_stale` confirmation, invalid operation, or `--confirm` outside a local non-SSH terminal; `130` (`SIGINT`) or `143` (`SIGTERM`) if interrupted during OS authentication.
