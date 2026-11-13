#!/usr/bin/python3
"""Does the AD.3 rehearsal notice a broken product? For each mutant: copy the candidate archive with ONE source file changed
(the package manifest is updated to match), commit the mutated tree to a scratch git repository so that the rehearsal's
"packaged files equal the commit" check still holds, and run rehearsal-aliases.mjs on it. A mutant is caught when the run
fails at the step it is expected to. A control run (the archive repacked unchanged) must pass.

usage: mutation-check.py --archive FILE.tar.gz --work DIR [--jobs N] [--only ID,ID] [--keep]

Nothing here touches the installed application root beyond what the rehearsal itself reads.
"""
import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "../../.."))
RUNNER = os.path.join(HERE, "rehearsal-aliases.mjs")
SRC = "packages/agent-worker/src/"
CLI = "packages/triangle-cli/src/"

# (id, file, old text, new text, the step the rehearsal is expected to fail at)
MUTANTS = [
    ("invisible-alias-resolves", SRC + "unified-router.mjs",
     "if (await evaluateCanMessage(effectiveCanMessage, senderId, target.id)) permittedIds.add(target.id);",
     "permittedIds.add(target.id);", "E6"),
    ("label-collision-ignored", SRC + "recipient-resolver.mjs",
     'if (found.labelMatches.some((match) => permitted.has(match.id))) return makeAliasError("alias_collides_with_label");',
     'if (false) return makeAliasError("alias_collides_with_label");', "E8"),
    ("journal-alias-is-another-intent", SRC + "local-messaging-journal.mjs",
     'const PRINCIPAL_INTENT_VIA = new Set(["principal", "alias"]);',
     'const PRINCIPAL_INTENT_VIA = new Set(["principal"]);', "E5"),
    ("discovery-hides-aliases", SRC + "unified-router.mjs",
     "...(aliases.length > 0 ? { aliases: Object.freeze(aliases) } : {}),",
     "...({}),", "E3"),
    ("address-forms-lack-alias", SRC + "unified-router.mjs",
     'const ADDRESS_FORMS_ENABLED = Object.freeze(["alias", "id", "principal"]);',
     'const ADDRESS_FORMS_ENABLED = Object.freeze(["id", "principal"]);', "C2"),
    ("alias-counter-never-moves", SRC + "unified-router.mjs",
     "counters.resolved.alias += 1;", "counters.resolved.alias += 0;", "E4"),
    ("reserved-names-allowed", SRC + "identity-primitives.mjs",
     "RESERVED_ALIAS_WORDS.has(value) || RESERVED_ALIAS_PREFIXES.some((prefix) => value.startsWith(prefix))",
     "false", "E7"),
    ("view-never-says-collides", SRC + "identity-view.mjs",
     'else if (collides) state = "collides";', 'else if (false) state = "collides";', "E8"),
    ("grok-treats-alias-unresolved-as-unknown", SRC + "grok-local-session.mjs",
     "'alias_unresolved',", "", "E8"),
    ("owner-cli-sends-any-alias-shaped-name", SRC + "local-messaging-cli.mjs",
     "if(details.entries?.some(entry=>entry.send?.aliases?.includes(options.to)))to=options.to;",
     "to=options.to;", "C2"),
    ("plan-allows-an-existing-alias", CLI + "identity-alias.mjs",
     'if (registry.ok && exists) refusals.push("alias_exists");', 'if (false) refusals.push("alias_exists");', "E7"),
    ("plan-always-says-honored", CLI + "identity-alias.mjs",
     'return { state: "not_honored", reason: Array.isArray(forms) ? "alias_not_among_address_forms" : "address_forms_not_reported", detail: null };',
     'return { state: "honored", reason: null, detail: null };', "F3"),
    ("plan-allows-a-name-that-is-a-profile", CLI + "identity-alias.mjs",
     "recipients.some((recipient) => recipient.profile.toLowerCase() === name)", "false", "E7"),
    ("apply-needs-no-terminal", CLI + "cli.mjs",
     "(identityDependencies.stdinIsTTY ?? io?.stdin?.isTTY ?? process.stdin?.isTTY) &&", "true ||", "E7"),
    ("clear-does-not-clear", SRC + "identity-registry.mjs",
     "      delete registry.aliases[alias];\n      return registry;", "      return registry;", "E5"),
    ("restore-forgets-v2-data", CLI + "identity-upgrade.mjs",
     'if (inspected.willLoseV2Data && discardV2Data !== true) refusals.push("restore_would_lose_v2_data");',
     'if (false) refusals.push("restore_would_lose_v2_data");', "G2"),
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_archive(path):
    members, data = [], {}
    with tarfile.open(path) as tar:
        for member in tar.getmembers():
            members.append(member)
            data[member.name] = tar.extractfile(member).read() if member.isfile() else None
    return members, data


def write_archive(path, members, data):
    with tarfile.open(path, "w:gz") as tar:
        for member in members:
            if member.isfile():
                member = tarfile.TarInfo.frombuf(member.tobuf(), "utf-8", "surrogateescape")  # a copy
                member.size = len(data[member.name])
                tar.addfile(member, io.BytesIO(data[member.name]))
            else:
                tar.addfile(member)
    with open(path + ".sha256", "w") as handle:
        handle.write("%s  %s\n" % (sha(open(path, "rb").read()), os.path.basename(path)))


def tracked_files():
    """The files git tracks: the rehearsal compares only those packaged files with the committed blobs, so the scratch
    repository holds only them (not the 113 MB node binary and the Swift helpers)."""
    out = subprocess.run(["/usr/bin/git", "-C", REPO, "ls-files", "-z"], capture_output=True, check=True).stdout
    return set(x for x in out.decode("utf-8").split("\0") if x)


def build(archive, mutant, work):
    ident, rel, old, new, _ = mutant
    members, data = read_archive(archive)
    if old is not None:
        text = data[rel].decode("utf-8")
        assert text.count(old) == 1, "%s: the text to change occurs %d times in %s" % (ident, text.count(old), rel)
        data[rel] = text.replace(old, new).encode("utf-8")
        manifest = json.loads(data["package-manifest.json"])
        entry = [f for f in manifest["files"] if f["path"] == rel]
        assert len(entry) == 1
        entry[0]["size"], entry[0]["sha256"] = len(data[rel]), sha(data[rel])
        data["package-manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    base = os.path.join(work, ident)
    shutil.rmtree(base, ignore_errors=True)
    repo = os.path.join(base, "repo")
    os.makedirs(repo)
    tracked = tracked_files()
    for member in members:
        if member.isfile() and member.name in tracked:
            target = os.path.join(repo, member.name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as handle:
                handle.write(data[member.name])
    version = json.loads(data["package-manifest.json"])["version"]
    out = os.path.join(base, "out")
    os.makedirs(out)
    name = "triangle-client-%s-darwin-arm64.tar.gz" % version
    write_archive(os.path.join(out, name), members, data)
    installer = os.path.join(os.path.dirname(archive), "triangle-install-%s.sh" % version)
    shutil.copy2(installer, out)
    env = {"PATH": "/usr/bin:/bin", "HOME": base, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}
    for args in (["init", "-q"], ["add", "-A"], ["-c", "user.name=m", "-c", "user.email=m@example.invalid", "commit", "-q", "-m", "mutant"]):
        subprocess.run(["/usr/bin/git", "-C", repo] + args, env=env, check=True, stdout=subprocess.DEVNULL)
    return base, repo, os.path.join(out, name)


def run(archive, mutant, work):
    base, repo, packed = build(archive, mutant, work)
    results = os.path.join(base, "results")
    proc = subprocess.run(
        [shutil.which("node") or "/Users/zhenyuhou/.local/bin/node", RUNNER, "--candidate-archive", packed, "--source-commit", "HEAD",
         "--repo-root", repo, "--out", results],
        capture_output=True, text=True, timeout=900)
    try:
        report = json.load(open(os.path.join(results, "results.json")))
    except Exception:
        return mutant[0], "no results.json", proc.stdout[-400:] + proc.stderr[-400:]
    failed = (report.get("failure") or {}).get("step")
    return mutant[0], report["verdict"], (failed, (report.get("failure") or {}).get("message", ""))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--only", default="")
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    only = [x for x in args.only.split(",") if x]
    mutants = [("control", None, None, None, None)] + [m for m in MUTANTS if not only or m[0] in only]
    os.makedirs(args.work, exist_ok=True)
    expected = {m[0]: m[4] for m in mutants}
    caught, missed = 0, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(run, os.path.abspath(args.archive), m, os.path.abspath(args.work)): m[0] for m in mutants}
        for future in concurrent.futures.as_completed(futures):
            try:
                ident, verdict, detail = future.result()
            except Exception as error:  # a broken mutant is reported, the others go on
                ident, verdict, detail = futures[future], "error", repr(error)[:300]
            want = expected[ident]
            if ident == "control":
                ok = verdict == "pass"
                print("%-42s %s  (control: the unchanged archive must pass)" % (ident, "ok  " if ok else "FAIL"))
                if not ok:
                    print("   ", detail)
                    missed.append(ident)
                continue
            step = detail[0] if isinstance(detail, tuple) else None
            ok = verdict == "fail" and step == want
            caught += ok
            if not ok:
                missed.append(ident)
            print("%-42s %s  fails at %-5s expected %-5s %s" % (ident, "caught" if ok else "MISSED", step, want, (detail[1][:110] if isinstance(detail, tuple) else detail)))
    print("\ncaught %d of %d mutants%s" % (caught, len(mutants) - 1, "" if not missed else "; problems: " + ", ".join(missed)))
    if not args.keep:
        shutil.rmtree(args.work, ignore_errors=True)
    return 0 if not missed else 1


if __name__ == "__main__":
    sys.exit(main())
