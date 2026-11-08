# Identity registry v2: upgrade and way back

Runbook for `triangle identity upgrade-registry` and `triangle identity restore-registry`. Design and decisions:
`docs/plans/2026-11-07-identity-registry-v2-d1-plan.md`. The upgrade changes the format of the host-local identity registry
(`<application root>/identity/`) from v1 to v2 in one audited step. It grants no authority, creates no identity and changes no
route: the same principals resolve to the same profiles before and after. v2 only makes room for records that later releases
will write (serverless bindings, pairings, aliases, destination rules); nothing in this release writes or reads them.

Both commands are owner commands: they plan first and write nothing; applying needs the exact plan id and a terminal on
standard input and output. Examples use the default layout; `--client-root` is the client directory
(`~/Library/Application Support/The Triangle/client`), and the registry defaults to `identity/` beside it. An explicit
`--registry-root` must be a directory in the same application root (the client directory's parent): the supervisor that is
asked, and the `identity-backups/` folder, are those of that application root.

## Before you start

The upgrade refuses unless all three hold, and the plan shows each one:

1. The registry reads, its audit chain verifies, it is v1 and it has history (`registry_absent`, `registry_unreadable`,
   `registry_needs_history`; an already-upgraded registry is reported as nothing to do, `registry_already_v2`).
2. The supervisor runtime manifest is v14 or later (`runtime_manifest_missing`, `runtime_manifest_unreadable`,
   `runtime_upgrade_required`).
3. **The running supervisor reports that it can read v2, and which registry directory it reads is the one being upgraded**
   (`supervisor_cannot_read_v2`, `supervisor_reads_another_registry`, or `supervisor_unreachable` when it cannot be asked). This
   proves what that process said when it answered; do not restart into an older runtime afterwards. This is what makes the order safe: install the runtime that reads v2, restart into it, and only then
   upgrade. A supervisor older than this release cannot read a v2 registry; it fails closed (principal `agent_` sends are
   refused with `route_unavailable`, exact-id sends keep working), so never upgrade first.

The command asks the supervisor by running the installed `<application root>/bin/triangle-local status`; it needs local
messaging to be set up for the owner, like that command itself.

## Upgrade

```
triangle identity upgrade-registry --client-root DIR
```

Read the plan: the current schema, sequence and audit head, the three floor lines, where the backup will go, and what an older
runtime will do. If it is blocked, no apply command is offered. Otherwise:

```
triangle identity upgrade-registry --client-root DIR --confirm PLAN_ID
```

In order, it re-checks the floor and the plan id (`plan_stale` if anything changed), takes a **backup**, upgrades with a
compare-and-set on the backed-up sequence, and reads the result back. The backup is a private directory
`<application root>/identity-backups/backup-v1-<UTC time>/` holding the two registry files exactly as they were; it is read
back and compared before the upgrade runs, and it lives outside the registry directory on purpose (a directory inside it
would make the registry unreadable). A write that lands between the plan and the backup stops the upgrade (`plan_stale`); one
that lands after the backup stops it at the compare-and-set (`registry_sequence_conflict`); in both cases nothing was upgraded.

Check it: `triangle status --identity` shows `v2` and the record counts (all zero), the same profiles are recorded, and a
principal send still goes to the same profile.

## If something goes wrong

- **The upgrade stopped partway** (a crash, a power cut). The registry is v1 or v2, never half. If it is still v1 it may end in
  one unfinished audit line; this release reads it, and planning and applying again finishes the job (the writer discards the
  line). An older runtime cannot read that line: put the clean pair back first with the restore below. A failure message names
  the backup that was made and prints the command; after a crash or a power cut there is no message, and the backup is the
  newest `backup-v1-*` folder in `identity-backups/`.
- **Go back to v1.** There is no in-place downgrade: an older reader rejects the `upgrade` entry. Restore the backup instead:

  ```
  triangle identity restore-registry --client-root DIR --from BACKUP_DIR
  ```

  The plan shows the live registry, the backup, how their histories relate and every audit entry that would be discarded
  (anything done since the backup, such as a new binding or a revoke, has to be redone). **Read the routing section:** a restore
  replaces the whole registry, so it can undo a revoke (the plan marks it `!`, and the result repeats it: revoke the binding
  again if that is not what you want) or add a binding the live registry does not have (`+`). A restore that would re-activate,
  add or move a binding, or that installs a backup which is not an earlier state of this registry, is refused until you add
  `--accept-routing-changes` (it is part of the plan id): you are then choosing which principals route, so read every `!`, `+`
  and `~` line first. If the live registry holds v2-only data
  (a serverless binding, pairing, alias or destination), which a v1 backup cannot hold, the restore is refused unless you add
  `--discard-v2-data`. Apply with `--confirm PLAN_ID` (and the same flags). Before it replaces anything it copies the live files
  into `<application root>/identity-backups/before-restore-<state>-<UTC time>/`, so nothing is lost.
- **The registry is unreadable or missing.** Restore works then too (the live files are archived as they are).
- **A restore stopped partway.** Run it again from a fresh plan; the previous files are already in the archive, and the next
  restore removes the staging files. A half-restored registry cannot be read, so nothing routed meanwhile and the plan shows
  the backup's bindings as added: add `--accept-routing-changes`.
- A plan id is good for the state it was made for. After a backup or a restore, a plan made earlier is stale even if the
  registry looks the same again (the folder of backups is part of the id).
- Only a v1 backup that reads and verifies, has no unfinished write and lies outside the registry directory can be restored.
  Backups and archives are never deleted by these commands. If a run is killed while a backup is being written, an incomplete
  directory (a restore refuses it as unreadable) and, after a killed restore, staging files named `identity-registry-v1.json.tmp-restore-*`
  in the registry directory can be left behind; the registry reader ignores the files, and both can be removed by hand.

## Refusal codes

| Code | Meaning |
| :--- | :--- |
| `registry_absent`, `registry_unreadable`, `registry_already_v2`, `registry_needs_history` | Floor 1 |
| `runtime_manifest_missing`, `runtime_manifest_unreadable`, `runtime_upgrade_required` | Floor 2 |
| `supervisor_unreachable`, `supervisor_cannot_read_v2`, `supervisor_reads_another_registry` | Floor 3 |
| `plan_stale`, `confirmation_mismatch` | The plan id does not match what is true now, or is not a plan id (exit 2) |
| `registry_sequence_conflict`, `registry_busy`, `registry_changed`, `backup_changed_since_plan` | A write landed after the plan or the backup, another process holds the registry, or the backup directory changed after the plan |
| `restore_would_lose_v2_data` | Needs `--discard-v2-data` |
| `restore_would_change_routing` | Needs `--accept-routing-changes` (re-activates, adds or moves a binding, or the backup is not an earlier state of this registry) |
| `restore_backup_unreadable`, `restore_backup_not_v1`, `restore_backup_unfinished_write`, `backup_overlaps_registry_root` | The backup cannot be restored |

Exit codes: 0 done (or a plan that can be applied, or nothing to do), 1 refused or failed, 2 usage error, a stale plan id, or
no terminal for `--confirm`.
