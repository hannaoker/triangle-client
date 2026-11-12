# Identity aliases: set, change, clear and check

Runbook for `triangle identity alias set` and `triangle identity alias clear`. Design and decisions:
`docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md`. An alias is a short name the owner gives to one local
agent so that agents (and the owner CLI) can address it without its long id. It is recorded in the host-local identity registry
(`<application root>/identity/`) and resolved by the supervisor's router when a message is sent.

An alias is a *sending* address and nothing else. It is not a label (labels never route), not an inbound address, not a
permission (the owner's access list and the credential's scope still decide who may message whom, after the name is resolved),
and it never leaves the host: no outbound envelope, reply route or provenance record carries it.

**An alias is not a Grok alias.** `--alias researcher` in the Grok commands selects a Grok conversation binding. The router does
not resolve it, and an identity alias cannot select a Grok conversation. They share a word only.

Both commands are owner commands: they plan first and write nothing; applying needs the exact plan id and a terminal on
standard input and output. Examples use the default layout; `--client-root` is the client directory
(`~/Library/Application Support/The Triangle/client`), and the registry defaults to `identity/` beside it. An explicit
`--registry-root` must be a directory in the same application root (the client directory's parent).

## What a sender sees

- A sender sees an alias only if it **may message the recipient the alias resolves to**. A name that is an alias for some other
  sender is, for this sender, simply an unknown name: the send fails with `recipient_not_allowed`, with the same text and the same
  counters, so "no such alias" and "exists, but not yours" cannot be told apart.
- A sender that can see an alias finds it in `send.aliases` of that recipient's entry in `triangle_list_recipients` and
  `triangle_list_sessions` (and in the owner CLI's `discover`), and may use it as `to`. Discovery lists at most **eight** names per
  recipient, sorted; a ninth name still resolves on the server but is not listed, and the owner CLI refuses a name that discovery
  does not list. The plan tells you when that happens.
- A visible alias that cannot be used as it stands fails with `alias_unresolved` and a reason: `alias_collides_with_label` (a
  local profile has the same name and the sender may message it) or `ambiguous_binding` (the principal is bound to several local
  profiles). The exact id still works.

## Before you start

1. **A v2 registry.** Aliases live in `identity_registry_v2`. On a v1 registry the plan says `registry_not_v2`: run
   `triangle identity upgrade-registry` first (`docs/triangle-client/identity-registry-v2-upgrade.md`).
2. **The client configuration.** The plan reads `<client root>/local-messaging.json` (a private file, only the profile names and
   instance ids in its `recipients`) to know which profiles are local recipients. Without it the plan is refused
   (`local_messaging_config_missing`, `local_messaging_config_unreadable`).
3. **A supervisor that resolves aliases.** The plan asks the running supervisor (the installed
   `<application root>/bin/triangle-local status`) which address forms it resolves. If `alias` is not among them (a supervisor
   from before the aliases release, or principal routing switched off) the plan says so: the alias is *recorded but not honored*
   until the supervisor is restaged, and a send to the name fails like any unknown name. That is advice, not a floor: the alias
   is recorded either way, and a supervisor that ignores aliases fails closed. If the supervisor cannot be asked, or reads another
   registry directory, the plan says that instead.
4. **A CLI from this release.** These commands come from this release's client package; an older CLI has no `identity alias`.

## Set

```
triangle identity alias set NAME TARGET --client-root DIR
```

`NAME` is 1 to 32 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit. `TARGET` is an `agent_` id or the
name of a local profile that has an active binding. The plan shows the registry's schema, sequence and audit head, the alias, the
target (profile, principal, binding), each check, what a sender will see, the supervisor's answer, the way back and the **plan
ID**. It refuses, naming every reason that applies:

| Code | Meaning |
| :--- | :--- |
| `registry_absent`, `registry_unreadable`, `registry_not_v2`, `registry_schema_unknown` | The registry cannot take an alias |
| `local_messaging_config_missing`, `local_messaging_config_unreadable` | The recipients cannot be checked |
| `alias_name_invalid` | Outside the pattern (capitals are refused, not lowered) |
| `alias_name_reserved` | `claude`, or a name starting `agent_`, `peer_`, `session-`, `bind_` or `pair_` (look-alikes of ids) |
| `alias_collides_with_label` | A local profile has this name, ignoring case |
| `alias_exists` | The name is taken: an alias is created, never overwritten |
| `alias_map_full` | The registry holds its maximum of 256 aliases |
| `alias_target_not_found` | No binding has that principal id or profile name |
| `alias_target_not_active` | The principal's bindings are all revoked |
| `alias_target_not_mesh_managed` | It is a serverless peer; only a MESH-managed local agent can have an alias |
| `alias_target_ambiguous` | The principal has several active bindings (a legacy duplicate) |
| `alias_target_not_local` | The profile is not a local recipient of this client configuration, so a sender could never reach it |

Apply, from a terminal:

```
triangle identity alias set NAME TARGET --client-root DIR --confirm PLAN_ID
```

It re-evaluates everything (`plan_stale` if anything the plan rests on has changed, including the registry, the target and the
client configuration), writes one audited `alias_set` step with a compare-and-set on the planned sequence
(`registry_sequence_conflict` if another write landed in between: nothing was changed), and reads the result back. The plan
writes nothing at all, and neither does a refused apply.

Check it: `triangle-local discover` from a chat that may message that recipient lists the name in that entry's `send.aliases`
(that proves the supervisor loaded the alias), and `triangle status --identity` shows the alias row as `active`.

## Change where a name points

There is no overwrite, on purpose: a target changes only by `clear` and then `set`, each step planned and audited, so a name never
silently moves. Between the two steps the name is an unknown name for every sender.

## Clear

```
triangle identity alias clear NAME --client-root DIR
triangle identity alias clear NAME --client-root DIR --confirm PLAN_ID
```

The plan shows what the alias is now (its target and its state, below). `alias_not_found` if there is no such alias. A dangling
alias, or one with a name the writer would now refuse, can always be cleared; clearing needs the registry but not the client
configuration.

## Look

`triangle status --identity` and `triangle doctor --identity` list the aliases of a v2 registry with a state; `doctor` warns on
every state but `active`. The first state that applies:

| State | Meaning | What to do |
| :--- | :--- | :--- |
| `dangling` | The principal has no active MESH-managed binding (it was revoked). The alias resolves to nothing. | Clear it, or bind the profile again. |
| `unroutable` | The principal is bound, but its profile is not a local recipient of the client configuration. | Clear it, or add the profile to local messaging. |
| `ambiguous` | The principal is bound to several local profiles. A sender that can see the alias gets `alias_unresolved`. | Clear it and revoke the extra binding. |
| `collides` | A local profile has the alias's name (a profile was added after the alias). A sender that may message that profile gets `alias_unresolved`; the owner CLI sends to the profile. | Clear the alias. |
| `moved` | The principal's active binding is on a different profile than a revoked binding of the same principal, and was issued after the alias was set: the alias now delivers somewhere else than when it was set. | Check that is wanted; otherwise clear it. |
| `active` | None of the above. | |

A revoke does not remove an alias that points at the revoked principal; it shows as `dangling` until you clear it. If the client
configuration cannot be read, `unroutable` and `collides` are not judged and `doctor` says so
(`alias_routing_unchecked`).

## If something goes wrong

- **A write stopped partway** (a crash, a power cut). The registry is the old one or the new one, never half; an unfinished audit
  line left by a crash is repaired by the next write. Make a fresh plan and look at it: it says `alias_exists` if the alias did
  get recorded.
- **The supervisor ignores aliases** (it was rolled back to a bundle from before the aliases release). The registry keeps the
  aliases and the old supervisor reads it; sends to the names fail as unknown names. Nothing needs undoing.
- **Restoring an older registry backup** (`restore-registry`) takes the aliases with it: they are v2-only data, so the restore is
  refused unless you add `--discard-v2-data`, and the aliases have to be set again afterwards.

## Exit codes

0 done, or a plan that can be applied; 1 refused or failed; 2 usage error, a stale or malformed plan id, or no terminal for
`--confirm`.
