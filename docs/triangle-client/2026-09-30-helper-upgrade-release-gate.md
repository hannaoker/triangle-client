# Helper upgrade release gate (manifest v6 + host extraction)

Status: operator checklist for cuts that change worker install manifests, extracted
App Server host helpers, or supervisor bundle composition.

Companion automation (Darwin, no live MESH):

- `packages/agent-worker/test/keychain-launch-contract.test.mjs`
- `packages/macos-mailbox-helper/scripts/test-host.sh`
- `packages/macos-mailbox-helper/scripts/test-keychain-integration.sh` (signed helper)

Live canaries require **macOS**, enrolled profiles, and MESH. A visible reply alone
does **not** pass; record the full settlement chain below.

## Evidence to capture (every canary)

Copy this block into your run log. Fill every field or mark `n/a` with reason.

```text
canary_id:
date_utc:
host:
helper_build:          # triangle-mailbox sha256 or release tag
bundle_manifest_version:  # codex.manifest.json "version" (3–6)
bundle_content_address:   # basename of worker-runtime/bundles/<64-hex>
bound_thread_id:       # mcp-interactive / App Server only
inbound_event_id:
delivery_id:
reply_event_id:
final_delivery_state:  # e.g. acked / receipt_settled / transaction_stuck
notes:
```

Derive bundle version without secrets:

```sh
APP="$HOME/Library/Application Support/The Triangle"
python3 -c 'import json,pathlib; m=json.load(open(pathlib.Path("'"$APP"'")/"worker-runtime"/"codex.manifest.json")); print(m["version"], pathlib.Path(m["projectRoot"]).name)'
```

## End-to-end matrix

| Test | Actual flow | Pass condition | Automation / procedure |
| --- | --- | --- | --- |
| **Existing-bundle upgrade** | On a Mac that already has **v4 or v5** Codex bundles from the **previous shipped helper**, install **only** the new helper (+ client if bundled). Restart workers/supervisor. Do **not** re-prepare runtime first. | Codex worker and `dev.thetriangle.client` start; logs show no `invalidManifest` / manifest contract mismatch; coordinator resolves v4/v5 bundles unchanged. | Partial: `keychain-launch-contract.test.mjs` simulates v5-without-schema validation and v5→v6 upgrade via `prepare-runtime`. **Required operator:** real v4/v5 bundles from prior release artifact + helper-only upgrade. |
| **Fresh installation** | Clean `Application Support`, install helper+client, `prepare-runtime`, `agent add`, start service. | Bundle is **v6** (current prepare); supervisor and workers launch from content-addressed bundle only (no checkout paths in argv/env); extracted modules (e.g. `client-supervisor-schema.mjs`) present in manifest and load. | `keychain-launch-contract.test.mjs` (clean prepare); host `clean installed runtime resolves and passes Node syntax smoke`. **Required operator:** full install path on clean Mac. |
| **Headless round trip** | Profile `headless-app-server` or dedicated headless worker; send unique MESH message with `replyRequired: true` to that profile’s room. | Threaded reply with nonce appears on MESH; delivery reaches terminal ack; no duplicate replies on replay. | Unit: `headless-drain.test.mjs`, `headless-runtime-phase2.test.mjs`, transaction crash cases. **Required operator:** live send + history inspection. See [headless-supervisor-cutover.md](headless-supervisor-cutover.md). |
| **Bound desktop round trip** | `mcp-interactive` Codex + durable shared App Server; bind **this** chat’s thread id; leave chat idle; send MESH message with `replyRequired: true`. | **Same** bound thread wakes, assistant answers, MESH gets reply + ack — not another chat. | Unit: `shared-codex-app-server.test.mjs` (admit path). **Required operator:** [shared-codex-app-server-runbook.md](shared-codex-app-server-runbook.md) §5–6. |
| **Bob round trip** | Codex (bound desktop) sends Bob a unique nonce over MESH with `replyRequired: true`; Bob profile wakes unattended. | Bob’s threaded reply returns; Codex side settles delivery; bound desktop shows echo if designed for round-trip. | **Required operator:** runbook §6 + [codex-desktop-wake-handoff.md](codex-desktop-wake-handoff.md) Bob checklist. Abandon stale claims first. |
| **Restart recovery** | With an open transaction (claimed, not yet acked), restart `dev.thetriangle.client` or kill coordinator mid-flight. | Same delivery resumes; no lost message; no duplicate reply events. | Host: `MailboxTransactionContractCases` crash matrix; Node supervisor tests. **Required operator:** one live crash during claim/reply/ack. |
| **Receipt-only** | Send MESH message with `replyRequired: false`. | Delivery settles (receipt ack) without model turn and without MESH reply body. | `headless-drain.test.mjs`, `helper-transaction-proxy.test.mjs`, `shared-codex-app-server.test.mjs`, host receipt-only claim cases. **Required operator:** one live receipt in target room. |

## Retired disposable Gate A experiment

`native-desktop-wake-experiment.mjs` and its prototype runner are **deleted**. The
replacement procedure is the **durable** LaunchAgent host:

→ [shared-codex-app-server-runbook.md](shared-codex-app-server-runbook.md)

Pass for “experiment replacement” means either:

1. Successful durable-host attach + bound-thread smoke (desktop canary row above), **or**
2. Documented retirement only (already done in handoff — no active links to deleted paths).

Do not run `node scripts/prototypes/native-desktop-wake-experiment.mjs`.

## Minimum release gate (order)

Run in this order. Do not skip **upgrade** and **fresh install** before live wake
canaries.

1. **CI-safe (Darwin build Mac or CI macOS runner)**  
   - `node --test packages/agent-worker/test/keychain-launch-contract.test.mjs`  
   - `bash packages/macos-mailbox-helper/scripts/test-host.sh`  
   - Optional public ship: `TRIANGLE_RUN_DISPOSABLE_KEYCHAIN_TEST=1 bash packages/macos-mailbox-helper/scripts/test-keychain-integration.sh`

2. **Existing-bundle upgrade (operator, one Mac)**  
   - Leave v4/v5 bundles from previous release in place.  
   - Upgrade helper only → restart client + codex worker → confirm no manifest errors.

3. **Fresh installation (operator, clean Mac or wiped `Application Support`)**  
   - Full [e2e-operator-runbook.md](e2e-operator-runbook.md) through `prepare-runtime` and `agent add`.  
   - Confirm manifest **version 6** and supervisor start.

4. **Live wake canaries (operator, repeat ≥3 idle/restart cycles each)**  
   - Headless round trip  
   - Bound desktop round trip  
   - Bob round trip  
   - Receipt-only control  
   - One restart-recovery during open transaction  

   **One successful canary does not establish unattended reliability.** Repeat after
   idle soak and after `launchctl kickstart` / reboot between attempts.

5. **Record** every canary with the evidence block above.

## Quick failure signals

| Symptom | Likely cause |
| --- | --- |
| `invalidManifest` / manifest contract mismatch on startup | Helper expects v6 schema on v5 bundle (should not happen after v6 split); or corrupted manifest |
| Supervisor exits immediately after upgrade | Bundle version unsupported; run `prepare-runtime` only after confirming v4/v5 still valid |
| Desktop admit lands in wrong chat | Stale `app-server-binding.json` thread id |
| Reply on MESH but delivery not acked | Treat as **fail** — incomplete settlement chain |
| Receipt triggers model turn | Receipt-only regression; check helper `transaction-claim-next` and drain flags |

## Related docs

- [release-workflow.md](release-workflow.md) — shippable checklist  
- [e2e-operator-runbook.md](e2e-operator-runbook.md) — clean install  
- [shared-codex-app-server-runbook.md](shared-codex-app-server-runbook.md) — durable desktop host  
- [2026-09-13-unattended-wake-hosts.md](2026-09-13-unattended-wake-hosts.md) — adapter split  
