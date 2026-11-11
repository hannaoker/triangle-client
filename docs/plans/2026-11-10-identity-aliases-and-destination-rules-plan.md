# Identity aliases and destination rules (AD): implementation plan

Status: plan, 2026-11-10. No code. The seven owner decisions (AD-1 to AD-7, section 10) are proposals with a recommended option; none is settled. Written by Claude Code and not yet reviewed by anyone else. It turns the first two items of "After D1" in `2026-11-07-identity-registry-v2-d1-plan.md` (section 11) into buildable pieces: owner-set aliases with `alias_unresolved` (U3 3.D.2, interface design 4.2) and the destination rule (U3 3.F.3, interface design 4.5). It authorizes no code, install, alias, destination rule, `peer_` id, pairing or inbound path; every production step stays behind the gates in section 6. Baseline: client main `62b75c1` (PR #170). Every claim about shipped behavior cites source at that baseline; paths are under `packages/agent-worker/src/` unless they start with `docs/`, `test/`, `packages/` or `scripts/`.

## 1. What AD is

D1 froze the shapes: the v2 registry already holds an `aliases` map and a `destinations` map, and its audit vocabulary already has the four action names. AD gives them behavior. It changes no schema and needs no floor cycle (D1-4); the costs are ordinary ones: a writer, a resolver path, two commands, one supervisor restage and one client package.

| In AD | Not in AD |
| :--- | :--- |
| Writer support for `alias_set` and `alias_clear`, with a guard that a plain `set` cannot retarget an alias | Using a destination rule: inbound admission (`admitInbound`), hold-after-receipt, chat mapping (D4), any remote adapter |
| An `alias` address form in the router: resolution, `alias_unresolved`, what each sender may learn, discovery, a journal marker, counters | `peer_` ids, pairing, a pairing's `petname` (a different field), MESH handles, anything that crosses a transport |
| `triangle identity alias set\|clear` (plan first, apply with the plan id and a terminal) and alias rows in `status`/`doctor` | New approval kinds in the Swift provider (only if AD-2 chooses OS authentication) |
| The destination-rule writer, command and view, **designed here but deferred by recommendation** (AD-1, section 4) | Any change to the owner ACL, class grants or session policy: an alias never grants a send |

## 2. Starting point (checked)

- **The shapes exist and are validated.** `aliases`: key is the alias text, record `principal_id`, `set_at`, `generation`, pattern `^[a-z0-9][a-z0-9._-]{0,31}$` (`identity-registry.mjs:156`, `:199`, `validateAliasRecord` `:941`), at most 256 (`:76`). `destinations`: key is a principal, record `harness` (`claude` or `codex`), `workspace`, `set_at`, `generation` (`:157`, `:200`, `validateDestinationRecord` `:968`), at most 256 (`:77`). The registry validator requires an alias target to be the principal of a binding or pairing of the same registry (`alias_target_unknown`, `:1152`) and a destination key to be the principal of a binding (`destination_principal_unbound`, `:1169`). Revoked records still count as targets, because the resolver ignores revoked bindings at resolve time (D1 plan 3.6).
- **The audit names exist.** `alias_set`, `alias_clear`, `destination_set` and `destination_clear` are structurally valid in a v2 chain: the subject is the alias text or a principal id and the binding id is null (`:1265-1277`). Every reader from D1.0 on therefore accepts a chain that contains them.
- **Nothing can write them.** `updateIdentityRegistry` refuses the reserved names with `action_not_available` (`:2279-2281`) and requires the subject to be a 64-hex instance id (`:2285-2287`). `assertMutationMatchesAction` knows `init`, `upgrade`, `bind` and `revoke`, and for `bind` and `revoke` on a v2 registry it insists that `pairings`, `aliases` and `destinations` stay equal (`:2133-2139`).
- **Nothing reads them.** The snapshot provider copies only unrevoked `mesh-managed` bindings (`router-registry-snapshot.mjs:80-82`, `:85-131`). The resolver passes every string that is not `agent_` or `peer_` shaped through unchanged (`recipient-resolver.mjs:86-92`) and the router counts it as `resolved.id` with `via: "id"` (`unified-router.mjs:239-281`).
- **The agent-facing text says "exact id, never a label".** The send tool's `to` argument and the discovery texts (`local-messaging-protocol.mjs:23-26`). The owner CLI maps a worker's profile name or instance id to its id locally, passes an `agent_` id through and refuses anything else client-side (`local-messaging-cli.mjs:665-667`; a `peer_` id gave `recipient_not_allowed` there in the D1.5 negative set).
- **A send resolves before it is authorized.** The server hands the router the sender and a `canMessage` closure (turn claims and ACL) and only afterwards runs the ACL check on the resolved id (`local-messaging-server.mjs:581-605`). Today the router uses `canMessage` only to filter the candidates of `recipient_ambiguous` (`unified-router.mjs:145`, `:347-355`). By that order an unknown principal is `recipient_not_found` and a bound one the sender may not message is `recipient_not_allowed`. That difference is harmless for 128-bit random principal ids and stops being harmless for guessable alias names; the R1 plan (3.2) says to revisit it when aliases arrive.
- **The journal can carry a new marker.** `resolved_via` is a free TEXT column (`local-messaging-journal.mjs:470-471`, added by ALTER at `:572-576`). `isRouteIntentMatch` (`:320`) requires a principal send's stored and incoming `resolved_via` to be `principal`. The agent-visible `target.via` is `principal` or `id` and the projection throws on anything else (`unified-router.mjs:55-63`).
- **Status.** `local_status.router.registry` is `{state, sequence, schema, supportedSchemas}` (`unified-router.mjs:792`, `:829`) plus `rootSha256` added by the server (`local-messaging-server.mjs:444`); `router.errors` and `router.resolved` are counters (`unified-router.mjs:795-796`, `:832-833`).
- **Directory labels.** Worker entries are labelled with their profile names; the two paired conversations have fixed display labels that are not alias-shaped (`local-messaging-host.mjs:114-118`).
- **Another "alias" already exists.** A Grok binding has an `alias` (pattern `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$`, `grok-local-session.mjs:13`) that selects a Grok conversation in the Grok commands and shows in its directory label (`:112`). The router does not resolve it, since it takes exact ids; the two share a word only, and AD.2's help text and runbook say so.
- **Owner CLI and gates.** `triangle identity migrate`, `revoke`, `upgrade-registry` and `restore-registry` plan first and apply with the exact plan id and a terminal (`packages/triangle-cli/src/cli.mjs:342` onward). Only `revoke` uses OS authentication, and the Swift provider knows two action kinds, `profile.move` and `profile.revoke` (`packages/triangle-cli/src/owner-approval.mjs:24`; `scripts/probes/owner-approval-provider.swift:42`). `status --identity` already prints the collection counts (`identity-view.mjs:77`, `doctor.mjs:70-77`) and `restore-registry` already lists aliases among the v2-only data it would lose (`identity-upgrade.mjs:592`).
- **Release mechanics.** A change inside modules the supervisor bundle already lists installs as a supervisor-only restage (D1 plan 7); the client package carries its own copy of the registry module; loaded harness chats keep their tool descriptions until they restart (release checkpoint of 2026-10-30 in `2026-10-29-unified-messaging-next-slices.md`).
- **Live state, last checked read only on 2026-11-09 (D1.5 evidence).** Supervisor manifest v14, bundle `c01e78bb…`; client package 0.2.0-identity.2; registry v2 at sequence 4 with three bindings (`ghost`, `gravity2`, `codex-headless`), no alias and no destination; router enabled. Of the three bindings only `gravity2` is a local recipient. Nothing was read live for this plan.

## 3. Aliases

### 3.1 Contract

U3 3.D.2 and interface design 4.2, as adopted here:

- An alias is an owner-set name in this registry for one principal. One alias names one principal; one principal may have several aliases. The map is installation-wide, not per sender: what a sender may learn about it is limited only by the sender's own permissions (3.3).
- It is a *sending* address, resolved by the router for agents (MCP) and for the owner CLI (through the server). It is not a label (labels never route), never an inbound address, and never leaves the host: no outbound envelope carries it (identity design 3, rule 5).
- It cannot be shaped like a principal, a session address or an instance id (the registry pattern is at most 32 characters of `[a-z0-9._-]`), so no existing exact id can be mistaken for one. A test pins that for every id the host can mint (`deriveClientInstanceId`, `sessionAddress`, the paired-conversation and Grok sender ids).

### 3.2 Resolution

| `to` | Today | With AD (router enabled) |
| :--- | :--- | :--- |
| `agent_` + 32 hex | principal resolution | unchanged |
| `peer_` + 32 hex | `recipient_not_found` / `peer_not_supported` | unchanged |
| alias-shaped | passes through as an exact id and fails later | alias resolution, below |
| anything else | exact id | unchanged |

With the router disabled (`router.json`) nothing changes: alias-shaped strings pass through as today, which is the kill switch.

The alias path, in order:

1. Snapshot `unreadable`: `route_unavailable` / `registry_unreadable`, as for principals. Snapshot `absent` or no such alias: the unresolved answer of 3.3.
2. If a directory label equals the name, the name matches both the local list and the registry, and the first match never wins silently (interface design 4.2): the unresolved answer, with the label's recipient and the alias's recipient as the candidates.
3. Resolve the alias's principal with the existing principal resolution; its reasons (`no_binding`, `not_a_local_recipient`, `ambiguous_binding`) stay internal until 3.3 decides who sees them.
4. Ask `canMessage(sender, recipient)`. Denied: the unresolved answer.
5. Success: the send proceeds with `resolvedTo` the recipient's id. The server's ACL check still runs on it afterwards (`local-messaging-server.mjs:605`), so an alias can never make a denied send succeed.

### 3.3 Errors and what a sender can learn

`alias_unresolved` is a new router error code (the October name). Decision AD-3 (A): a sender learns *why* only when it may message at least one candidate; for everyone else the answer is the generic `alias_unresolved` with reason `unknown_alias` and no candidates, which is exactly what "no such alias" gives. That makes "no such alias" and "exists, but you may not message its target" indistinguishable by code, reason and candidates, which is the oracle the R1 plan said would return with aliases. It protects against an agent probing through the send tool; it does not protect against a same-user process reading the registry file (D1 risk 9, accepted), and timing is not equalized.

| Case | Sender may message a candidate | Any other sender |
| :--- | :--- | :--- |
| No such alias | `alias_unresolved` / `unknown_alias` | same |
| Alias exists, sender may not message its target | n/a | `alias_unresolved` / `unknown_alias` |
| Name equals a directory label | `alias_unresolved` / `alias_collides_with_label` + the candidates it may message | generic |
| Target has no active local binding, or is not a local recipient | no candidate exists, so generic for everyone | generic |
| Target bound to several local profiles | `alias_unresolved` / `ambiguous_binding` + candidates | generic |
| Registry unreadable | `route_unavailable` / `registry_unreadable` for everyone (the same answer as for any principal) | same |

Counters: `router.errors.alias_unresolved` and `router.resolved.alias`, so the owner can prove from the supervisor's own numbers what happened, as the D1.5 negative set did. The owner reads the specifics (dangling, colliding, ambiguous) in `status --identity` (3.7), not from sender errors.

### 3.4 Discovery

For an entry the caller may message, `send.addressKinds` gains `alias` when some alias resolves to exactly that entry through the same resolver a send uses, and the entry gains `send.aliases`: at most 8 names, sorted (AD-7 A). Entries the caller may not message show no alias, matching U2's rule that discovery never names what the caller cannot see. The `to` argument text and the discovery texts change (`local-messaging-protocol.mjs:23-26`); a chat that has not restarted keeps the old text, which says exact ids only, so it will not try an alias unprompted, and an alias works whether or not a chat has seen the new text.

### 3.5 Journal and retries

An alias send is journalled with `to_principal` = the resolved principal and `resolved_via` = `alias`; the alias name is not stored, because it can be retargeted and the principal is the fact. `isRouteIntentMatch` accepts a principal-or-alias retry only when the principals are equal and the two `resolved_via` values are equal. Consequences: a retry with the same message id after the owner cleared and re-set the alias to another principal is refused as a changed intent, as a principal retry would be; a retry by principal id of an alias send is refused too. The agent-visible `target.via` stays `principal` for an alias send (the projection does not accept a third value), so `decorateSend` treats `alias` like `principal`. No schema change; older code reads rows marked `alias` and refuses to retry on them, which fails closed.

### 3.6 The writer (AD.0)

- `alias_set` and `alias_clear` leave the reserved set. The subject check becomes per action: the alias pattern for alias actions, a 64-hex instance id for `bind` and `revoke`; `bindingId` is null. On a v1 registry both stay `action_not_available`.
- The action check for either action requires `bindings`, `pairings` and `destinations` to equal the stored ones and `aliases` to differ from the stored map at the subject key only.
- `alias_set` rules (writer policy; the reader stays permissive, as D1 plan 3.6 says): the target must be the principal of an *active* `mesh-managed` binding of this registry (AD-6 A); a new alias gets `generation` 1; setting an existing alias to the *same* principal renews it (`generation` + 1, new `set_at`); setting it to a *different* principal is refused with `binding_conflict` / `alias_change_requires_clear` (AD-5 A), the same shape as D2's `identity_change_requires_move`; the 256 cap stays `too_many_aliases`.
- `alias_clear` requires the alias to exist (`alias_not_found`) and removes it.
- `revoke` does not cascade: an alias to a revoked principal stays in the map, resolves to nothing, and shows as dangling until cleared. A later rebind of the profile to the same principal revives it (D2 forbids rebinding it to another principal), which is intended.

### 3.7 Commands and view (AD.2)

- `triangle identity alias set NAME TARGET --client-root DIR [--registry-root DIR] [--confirm PLAN_ID]`, TARGET being an `agent_` id or a profile name whose binding is active; `triangle identity alias clear NAME ...`. Same placement as the D1 commands (D1-3 A). The plan prints the registry sequence and audit head, the alias, the target principal and profile, and what a sender will see; it writes nothing. The plan id covers every fact the decision rests on, and applying re-evaluates all of it (`plan_stale` otherwise).
- Refusals at plan time, before any write: name not matching the pattern, a name equal to a profile name known to the client configuration (`alias_collides_with_label`, AD-4 A; labels are not registry data, so the resolver repeats the check), an existing alias with another target, an inactive target, a full map, a v1 registry.
- Apply needs stdin and stdout to be terminals, the D5-B gate of `identity migrate` and `upgrade-registry` (AD-2 A).
- The plan also asks the running supervisor, through the installed `triangle-local status`, which address forms it resolves (`router.registry.addressForms`, a new additive list; a supervisor without it resolves `id` and `principal` only). If `alias` is missing the plan warns that the alias will be recorded but not honored until the supervisor is restaged. That is a warning, not a floor: an alias a supervisor ignores fails closed.
- `status --identity` and `doctor` list alias rows (name, principal, profile, state `active`, `dangling`, `collides` or `ambiguous`); `doctor` warns on any state other than `active`. The view stays `identity_view_v1` and gains rows, as it did for serverless bindings (D1 plan 3.6).
- The owner CLI's `send --to NAME` keeps mapping a profile name first, and passes an alias-shaped name that maps to nothing through to the server (`local-messaging-cli.mjs:665-667`). A name equal to a profile name resolves to the profile there, which is why `alias set` refuses such names.

## 4. Destination rules

### 4.1 Why they wait (AD-1 A)

- **No consumer.** A destination rule decides where a *remote* principal's inbound message lands. No remote inbound exists; a local principal send resolves to the profile's own dispatch.
- **No principal it could apply to.** The recorded rule order is: a runner profile uses the runner, a bound conversation uses that conversation, and only otherwise the rule applies (U3 3.C.2 and 3.C.3). All three live bindings are runner-style workers, so a rule set on any of them would never be consulted. To be re-checked when the piece starts.
- **A different gate.** Where a remote principal's content lands is an authority decision (D4, D5-C), and the Swift provider has no action kind for it.
- **A silent command invites mistakes.** An accepted rule would show no effect anywhere.

So AD records the design below and builds the command with the inbound slice, where it can be exercised end to end.

### 4.2 Shape when built (AD.5)

Key: the principal of an *active* local `mesh-managed` binding (writer policy; the validator needs only a binding). Record: `harness` (`claude` or `codex`), `workspace` (absolute, resolved with `realpath` at set time as the session policy does, `local-messaging-interactive-session.mjs:185-188`, and bounded by the validator), `set_at`, `generation`. One rule per principal. `destination_set` renews or changes it with `generation` + 1; `destination_clear` removes it; the audit subject is the principal id. `status --identity` lists the rules. The approval gate is decided with the inbound slice, where D5-C probably applies.

## 5. Compatibility and fail-closed behavior

| Reader | Registry with aliases |
| :--- | :--- |
| Installed D1 supervisor and client package (`c01e78bb…`, 0.2.0-identity.2) | reads it; the validator and audit chain accept the entries; sends ignore aliases, so an alias-shaped `to` is an exact id that no ACL permits (`recipient_not_allowed`) |
| Pre-D1 readers | already refuse any v2 file |
| AD | resolves aliases as in section 3 |

Invariants that tests must pin:

1. With no aliases in the registry, every resolver, router, discovery and status result equals today's.
2. A registry with aliases leaves `agent_` and exact-id sends unchanged.
3. An alias never makes a send succeed that the ACL denies.
4. "No such alias" and "exists but not yours" give the same code, reason and candidates (3.3).
5. No outbound envelope, reply route or provenance record carries an alias.
6. No id the host can mint is alias-shaped; retargeting needs `clear` then `set`.
7. With the router disabled, alias-shaped strings pass through as today.

## 6. Release train, gates and rollback

**Shape.** Everything stays inside existing modules (`identity-registry`, `recipient-resolver`, `router-registry-snapshot`, `unified-router`, `local-messaging-protocol`, the journal's intent match, `local-messaging-cli`, `identity-view`, the CLI package), so there is no manifest bump and no helper source change: the runtime installs as a supervisor-only restage and the commands ship in the client package. **Order matters.** The supervisor goes first, so that an alias, once set, is honored; the package with the commands second.

**Gates before merge.** The D1 list: trust-boundary regression, `keychain-launch-contract`, the full suite compared with the known baseline (the `ps` host-probe test fails on plain main here; known timing flakes are rerun in isolation), the readiness check, the repository boundary check, and one independent read-only review per code PR.

**Owner gates, each a separate yes.**

| Gate | Step | Live effect |
| :--- | :--- | :--- |
| H1 | Merge AD.0 to AD.2 | None |
| H2 | Install the supervisor restage | Alias resolution exists but there are no aliases; verify principal and id sends, the backlog counts (held, queued, queued_local, pending replies) and `addressForms` |
| H3 | Install the client package with the `alias` commands | Commands available. As in G3, the package build from `main` brings more than the commands (rebuilt helper binaries); check the install receipt first (D1.5 finding) |
| H4 | The owner sets the first alias from their own terminal; read-only checks; the negative probes | An alias exists and is honored. A positive canary needs its own yes, because every local recipient is a worker that would run (`gravity2`) |

**Rollback.**

| Fault | Action |
| :--- | :--- |
| AD runtime misbehaves before H4 | Restore the saved supervisor manifest and restart, as in the D1 install records; the registry is untouched |
| An alias is wrong | `alias clear` (audited); nothing else changes |
| The supervisor must go back to a bundle without alias resolution | Aliases fail closed as in section 5; no registry restore is needed |

## 7. Work breakdown

Each piece is its own PR. AD.0 and AD.1 touch different files and can start together once this plan is accepted; AD.2 needs both. Each code PR gets one independent read-only review (a model review, not a human or Codex review) with my own probes, and CLI pieces are verified from a built package in a no-write, no-network sandbox.

| # | Piece | Content | Verified by |
| :--- | :--- | :--- | :--- |
| AD.0 | Writer | `alias_set` and `alias_clear` in `updateIdentityRegistry` and `assertMutationMatchesAction`, per-action subject check, the rules of 3.6 (all in `identity-registry.mjs`) | Table-driven tests per rule and refusal code; fault injection at every writer stage; concurrent binders and alias writers; chain verification across set and clear; a frozen reader from `62b75c1` (`git archive`, as D1.3 did with `d418fb1`) reads a registry with aliases and ignores them; v1 refuses both actions |
| AD.1 | Resolution | Snapshot `aliasFor`; the pure alias path in `recipient-resolver.mjs`; the router's `resolveSend` branch with `canMessage` before anything is revealed; counters; `describeAddresses` kinds and names; `addressForms` in `local_status`; journal intent match and `decorateSend`; protocol texts; owner-CLI pass-through | Golden tests: invariant 1 for resolver, router, discovery and status; the table of 3.3 for a sender with and without permission; the indistinguishability test; the id-shape test; router disabled passes through |
| AD.2 | Commands and view | `identity alias set\|clear`, the checks of 3.7, the supervisor warning, alias rows in `status`/`doctor`, help text and a runbook `docs/triangle-client/identity-aliases.md` | Scratch-root CLI tests per refusal code; plan-id stability and `plan_stale`; terminal requirement; package run in a no-write sandbox |
| AD.3 | Candidate and rehearsal | Candidate package and bundle; extend the D1.4 runner with alias steps (set, honored send, unauthorized sender, collision, retarget refusal, retry across clear and set, the installed bundle ignoring aliases) | Evidence document under `docs/reviews/` |
| AD.4 | Installed acceptance | Section 6, gates H2 to H4 | Evidence document |
| AD.5 | Destination rules | Section 4.2: writer actions, command, view; no consumer. **Only if AD-1 is B, or with the inbound slice** | As AD.0 and AD.2 |

## 8. Verification and acceptance

- **Unit and golden:** every rule of 3.2, 3.3 and 3.6; invariants 1 to 7 of section 5.
- **Fail-closed:** a frozen `62b75c1` reader against a registry with aliases (AD.0); the installed bundle against a scratch registry with aliases (AD.3).
- **Concurrency and faults:** the writer fault hooks and the multi-process stress with alias writers added.
- **Installed acceptance (AD.4):** (1) after H2, with no aliases, principal and id sends and the status block are as before; (2) the scratch rehearsal passes; (3) after H3 and H4, `discover` shows the `alias` kind and name for the one entry; (4) negative probes through normal interfaces, none of which can run a worker: an unknown alias, a name equal to a profile name, `alias set` of a retarget (refused), the router counters as proof; (5) one positive canary, with its own yes; (6) backlog isolation (held 2, queued 1, queued_local 1, pending replies 14 as of D1.5) and an unchanged journal; (7) `alias clear` returns to the starting state; (8) a restart keeps the alias.
- **A known gap, again:** a sender *without* permission addressing an alias whose target resolves to a local recipient cannot be tried live, because the only local recipient is one this chat may message and grants stay as they are. It is covered by the rehearsal (3).
- **AD is done when** the above passes on the installed system, the review findings are closed and the owner has accepted the evidence. It claims no remote capability.

## 9. Risks

| # | Risk | Handling |
| :--- | :--- | :--- |
| 1 | A same-user process (or an agent with a pseudo-terminal) sets or retargets an alias | The D5-B residual risk of `identity migrate`; retarget needs `clear` then `set`, each audited and visible in `status`; the ACL still decides every send, so an alias redirects a message only among recipients the sender may already message (AD-2 B closes it, at the price of a new Swift action kind) |
| 2 | An alias shadows a name an owner expects to be a profile | Refused at set time, `alias_unresolved` at resolve time, never silently first-match |
| 3 | Alias existence leaks to an agent through error codes | 3.3: identical answers for unknown and unauthorized; limited to what the send tool shows |
| 4 | Loaded chats show stale tool text | Harmless (3.4); a restart picks up the new text |
| 5 | A supervisor rollback or an unrestaged supervisor ignores aliases | Fails closed (section 5); the plan warns when `addressForms` lacks `alias` |
| 6 | The two copies of the registry code (package and bundle) drift | `addressForms` is asked of the running supervisor, as `supportedSchemas` was for D1 |
| 7 | A retry after a retarget is refused | By design (3.5); the sender uses a new message id |
| 8 | An alias to a revoked principal sits unused or revives with a rebind | `status`/`doctor` show it as dangling; revival needs the same principal (D2) |
| 9 | The owner CLI and the server treat a name differently | The set-time refusal makes the two agree; the server repeats the check |
| 10 | A destination rule is built without a consumer and misleads | Deferred (AD-1 A) |

## 10. Owner decisions

**Decision log.** None yet. These are proposals, not authorization to build or install; AD.0 starts on a separate go-ahead and every production step stays behind the gates of section 6.

1. **AD-1 Scope.** **A (recommended):** aliases now (AD.0 to AD.4); the destination-rule writer, command and view with the inbound slice (4.1). **B:** build both now; the rule is inert until inbound exists.
2. **AD-2 Gate for alias set and clear.** **A (recommended):** terminal plus plan id (D5-B), as for `identity migrate` and `upgrade-registry`; an alias grants no send. **B:** OS authentication (D5-A), which needs new action kinds in `owner-approval.mjs` and the Swift provider, a helper rebuild and the owner's live prompt acceptance.
3. **AD-3 What a sender learns.** **A (recommended):** the generic `alias_unresolved` / `unknown_alias` unless the sender may message a candidate (3.3). **B:** distinct codes for unknown, not allowed and ambiguous: simpler, and it tells any local sender which owner-chosen names exist.
4. **AD-4 Name collisions.** **A (recommended):** refuse at set time against the client configuration's profile names, and fail at resolve time as well. **B:** resolve time only.
5. **AD-5 Retargeting.** **A (recommended):** a plain `set` cannot change an existing alias's target; `clear` then `set`. **B:** allow it, with the plan showing old and new target.
6. **AD-6 Targets.** **A (recommended):** the principal of an active `mesh-managed` binding of this registry. **B:** any principal the validator accepts (revoked, or a paired remote one once pairing exists).
7. **AD-7 Discovery.** **A (recommended):** the `alias` kind and up to 8 names per entry the caller may message. **B:** the kind only; names only in `status --identity`.

## 11. After AD

Not authorized by this plan, in dependency order (from D1 plan 11 and U3 3.F): the destination-rule command with chat mapping (D4) and the approval kinds it needs; identity Slice 3a (`peer_` ids and keys, pairing, endpoint binding, the OS re-authentication feasibility check); then `admitInbound`, hold-after-receipt and the Iroh and MESH adapters (U3 3.F.2, 3.F.4 to 3.F.7). None of them is started by AD.

## 12. Evidence and limits

Read at the baseline: the files cited above; the D1 plan and the U3 delta in full; the interface design (4.2, 4.5), the identity design (rule 5, the registry shapes) and the R1 plan (3.2, decision 3) where they mention aliases and destination rules. Not read or verified: the live registry (nothing was queried for this plan; the live facts are those of the D1.5 evidence of 2026-11-09), the Swift provider beyond the cited line, the MESH server and the Rust peer engine, how a given harness caches tool descriptions (taken from the 2026-10-30 release checkpoint), and any timing difference between the answers of 3.3 (not measured). No code was run for this document; the claims of section 5 and the id-shape claim of 3.1 are exactly what AD.0, AD.1 and AD.3 must prove by running them.
