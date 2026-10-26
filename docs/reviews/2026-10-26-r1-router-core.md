# Review: R1.3 Unified Router Core

Date: 2026-10-26
Branch: `codex/r1-router-core`
Base Commit: `adbcff061e2dc3ba9f44625a4d1064cd3f8c68f2` (#131)

## 1. Scope & Intent

Delivers the library-only core of the Unified Router (`packages/agent-worker/src/unified-router.mjs`) implementing `resolveSend`, `decorateSend`, `decorateStatus`, `decorateReplies`, `decorateSessions`, `statusBlock`, and in-memory operational counters.

This implementation is strictly bounded to R1.3:
- **Library-only**: No server, host, dispatcher, CLI, or journal wiring is introduced. Manifest versions, Swift launcher files, and worker installation scripts remain untouched.
- **Import closure integrity**: No existing module imports `unified-router.mjs`. It imports only leaf or existing modules (`identity-primitives.mjs`, `recipient-resolver.mjs`, `transport-adapter-contract.mjs`, `local-messaging-errors.mjs`), ensuring that manifest v12 bundle closures remain 100% valid.
- **No overbuilding**: No cancellation framework, deadlines, persistent queues, cryptography, or generic routing abstractions were built.
- **Strict sanitization & target projection**: Raw SQLite journal-only columns (`to_principal`, `resolved_via`) are sanitized and stripped from all public DTOs in **all** modes (enabled or disabled). Target overrides in `decorateSend` and `decorateStatus` are projected strictly to allowlisted fields (`via`, `principal`, `profile`) with type validation, stripping arbitrary caller fields. Outside `target`, native DTO fields (such as reply text or custom delivery attributes) are preserved as-is. Note that the router does not claim arbitrary caller payloads are secret-free.
- **Input immutability**: All native input DTOs and options are treated as read-only and never mutated.

## 2. Documented Injected API

The module exposes `createUnifiedRouter` alongside individual delegating functions (`resolveSend`, `decorateSend`, `decorateStatus`, `decorateReplies`, `decorateSessions`, `statusBlock`) and the `RouterResolutionError` class.

### 2.1 Factory: `createUnifiedRouter(options)`

```typescript
interface UnifiedRouterOptions {
  // Boolean or dynamic predicate (e.g., checking router.json stat cache)
  enabled?: boolean | (() => boolean);
  // Registry snapshot provider implementing .get()
  snapshotProvider?: { get: () => RegistrySnapshot } | null;
  // Recipient list or getter returning array of { id: string, label: string }
  recipients?: Array<{ id: string; label: string }> | (() => Array<{ id: string; label: string }>);
  // Optional ambiguity filter predicate
  canMessage?: (senderId: string, candidateRecipientId: string) => Promise<boolean | void> | boolean | void;
}
```

### 2.2 `resolveSend(params, callOptions)`

Resolves recipient identifiers before ACL and rate limiter evaluation:
1. **Disabled Mode**: Returns `{ ok: true, resolvedTo: to, to, resolved: false, via: null, principal: null, route: null }` without invoking `snapshotProvider.get()` or accessing the filesystem.
2. **Legacy Identifiers** (64-hex instance IDs, profile names, session addresses, Grok IDs): Passes through untouched (`resolvedTo: to, resolved: false, via: "id", route: "local"`). Checks snapshot for bound principal without failing if registry is absent or unreadable. Increments `counters.resolved.id`.
3. **Peer IDs** (`peer_<32-hex>`): Fails immediately with `recipient_not_found` (reason `peer_not_supported`) without reading the registry snapshot.
4. **Principal IDs** (`agent_<32-hex>`): Reads `snapshotProvider.get()` and calls `resolveRecipient`:
   - Single valid local binding: Resolves to concrete 64-hex instance ID (`resolvedTo: recipientId, via: "principal", principal, profile, route: "local"`). Increments `counters.resolved.principal`.
   - Ambiguous bindings: Passes candidates through `canMessage` filter. See Section 3.
   - Absent registry: Throws `RouterResolutionError("recipient_not_found", "registry_absent")`.
   - Unreadable registry: Throws `RouterResolutionError("route_unavailable", "registry_unreadable")`.
   - Unknown principal: Throws `RouterResolutionError("recipient_not_found", "no_binding")`.
   - Non-local binding: Throws `RouterResolutionError("route_unavailable", "not_a_local_recipient")`.

When `callOptions.throwOnError === false`, returns an error object `{ ok: false, code, reason, candidates, error }` instead of throwing.

### 2.3 Public DTO Decorators

- **`decorateSend(sendResponse, options)`**:
  - In disabled mode: Returns sanitized DTO without added fields (no route/state/target decoration). Independent of recipient and registry providers.
  - In enabled mode: Strips raw journal fields, adds `route: "local"`, `state: localState(sendResponse.status)`, and `target: { via: "principal"|"id", principal?, profile? }`. Accepts target overrides via allowlisted projection, stripping arbitrary metadata. Preserves native DTO fields outside target.
- **`decorateStatus(statusResponse, options)`**:
  - In disabled mode: Returns sanitized DTO without added fields. Independent of recipient and registry providers.
  - In enabled mode: Strips raw journal fields, adds `route: "local"`, `state: localState(statusResponse.phase)`, and projected `target`. Accepts target overrides via allowlisted projection, stripping arbitrary metadata. Preserves native DTO fields outside target.
- **`decorateReplies(responseOrReplies, options)`**:
  - Supports both `{ replies: [...] }` container and raw `[...]` array.
  - Strips raw journal fields. Adds `route: "local"` to each reply item when enabled. Preserves peer reply text.
- **`decorateSessions(responseOrSessions, options)`**:
  - Supports both `{ sessions: [...] }` container and raw `[...]` array.
  - Strips raw journal fields. Adds `principal: string | null` to each session item when enabled (never fabricating a principal for unbound/revoked instances).

### 2.4 Status Block & Deterministic Counters

`statusBlock(options)` returns:
```json
{
  "enabled": false,
  "registry": { "state": "disabled", "sequence": 0 },
  "resolved": { "principal": 0, "id": 0 },
  "errors": {
    "recipient_not_found": 0,
    "route_unavailable": 0,
    "recipient_ambiguous": 0
  }
}
```
- In disabled mode: Never invokes `snapshotProvider.get()`; reports `state: "disabled"`.
- In enabled mode: Queries snapshot state and sequence safely, handling provider exceptions as `state: "unreadable"`.
- Status block hygiene: Internal registry paths, candidate identities, or tokens are never exposed in the status block. (Arbitrary caller payloads elsewhere in messaging DTOs are preserved as-is and are not claimed to be secret-free).
- Deterministic: Counters can be inspected via `getCounters()` and reset via `resetCounters()`.

## 3. Ambiguity Filtering Semantics

When `resolveRecipient` returns `code: "recipient_ambiguous"` with multiple candidates:
1. `canMessage(senderId, candidate.id)` is evaluated for each candidate.
2. Both boolean return values (`true`/`false`) and throwing ACL checkers (returning `undefined` on permit, throwing on deny) are supported.
3. Denied candidates and thrown exceptions fail closed and are dropped from `candidates`.
4. **No Arbitrary Pick**: Even if filtering reduces the authorized candidate list to exactly 1 candidate, the router **never** resolves it. The binding remains fundamentally ambiguous in the registry (`ambiguous_binding`), and the error is preserved.
5. Candidates in the resulting error expose only `{ id, label }`, preventing leak of unauthorized candidate profiles.

## 4. Integration Contract for R1.4

R1.4 will wire `unified-router.mjs` into `local-messaging-server.mjs`:
1. **Placement 1 (Resolution)**: Inside `send_message`, immediately after basic syntax/payload validation and before `acl.checkAllowed`:
   ```javascript
   const resolution = await router.resolveSend({ senderId, to });
   const effectiveTo = resolution.resolvedTo;
   // ACL, turn claims, rate limiters, pair caps, and dispatcher see effectiveTo
   ```
2. **Placement 2 (Journal Recording)**: Pass `resolution.principal` and `resolution.via` to `journal.recordSend`, which populates the new nullable SQLite columns `to_principal` and `resolved_via`.
3. **Placement 3 (Receipt Decoration)**: Decorate receipt before socket write:
   ```javascript
   const decorated = router.decorateSend(rawReceipt, { resolution, record });
   ```
4. **Placement 4 (Status, Replies, Sessions, Local Status)**:
   - `get_message_status` passes result through `router.decorateStatus(resp, { record })`.
   - `list_replies` passes result through `router.decorateReplies(resp)`.
   - `list_sessions` passes result through `router.decorateSessions(resp)`.
   - `local_status` embeds `router: router.statusBlock()`.

## 5. Verification Evidence

The test suite in `packages/agent-worker/test/unified-router.test.mjs` covers 10 distinct families:
- **Family 1**: Disabled mode (zero snapshot reads, zero recipient lookups, throwing provider independence, pass-through, raw journal field stripping, byte-identical responses).
- **Family 2**: Principal resolution table (success, absent snapshot, unreadable snapshot, throwing provider, unknown principal, peer ID isolation, non-local binding, ambiguity).
- **Family 3**: `canMessage` candidate filtering (subset allowed, throwing predicate, all denied, missing predicate fail-closed, single-candidate non-resolution).
- **Family 4**: Legacy, session, and Grok IDs pass-through and resilience against unreadable registry.
- **Family 5**: Native input DTO immutability (deep-frozen inputs with leaked fields and frozen target overrides).
- **Family 6**: Projected field fidelity against section 3.4 (send, status, replies, sessions).
- **Family 7**: Stale, revoked, or absent binding never fabricates a principal.
- **Family 8**: Deterministic operational counters and error accounting.
- **Family 9**: Fake server context simulating `local-messaging-server.mjs` end-to-end.
- **Family 10**: Target override projection, shape validation, and payload preservation.

Test execution run:
```bash
node --test \
  packages/agent-worker/test/unified-router.test.mjs \
  packages/agent-worker/test/recipient-resolver.test.mjs \
  packages/agent-worker/test/router-registry-snapshot.test.mjs \
  packages/agent-worker/test/transport-adapter-conformance.test.mjs
```
Result: **40 passing tests, 0 failures**.
`git diff --check origin/main`: **Clean, zero warnings**.
