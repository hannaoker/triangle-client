#!/usr/bin/python3
"""Mutation check for the v15 restage prep rehearsal driver (`rehearsal-restage.mjs`).

Repacks the candidate archive with one exact unique source change at a time, updates package-manifest.json
and a scratch git repository of tracked sources, and verifies that `rehearsal-restage.mjs` passes on the
unmutated control and catches every mutant at the expected step.
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
RUNNER = os.path.join(HERE, "rehearsal-restage.mjs")
SRC = "packages/agent-worker/src/"
CLI = "packages/triangle-cli/src/"
DEFAULT_NODE = os.path.expanduser("~/.hermes/node/bin/node")

# Each entry: (id, relative_path, old_unique_snippet, new_snippet, expected_failing_step)
MUTANTS = [
    # #184: host fix & unavailable recipient handling
    (
        "m184-host-throws-on-missing-runner",
        SRC + "local-messaging-host.mjs",
        "for(const r of config.recipients)if(!runnable(r.instanceId))logger.notice?.('triangle_client_local_recipient_not_running',{profile:r.profile,instanceId:r.instanceId});",
        "for(const r of config.recipients)if(!runnable(r.instanceId))throw coded('local_recipient_unavailable',r.profile);",
        "C2",
    ),
    (
        "m184-server-drops-unavailable-guard",
        SRC + "local-messaging-server.mjs",
        '            if (!existingRecord && recipientType === "runner" && typeof runnerAvailable === "function" && !runnerAvailable(effectiveTo)) {\n              throw coded("local_recipient_unavailable", "Recipient is not running; nothing was queued");\n            }',
        '            if (false && !existingRecord && recipientType === "runner" && typeof runnerAvailable === "function" && !runnerAvailable(effectiveTo)) {\n              throw coded("local_recipient_unavailable", "Recipient is not running; nothing was queued");\n            }',
        "C2",
    ),
    (
        "m184-dispatcher-claims-unavailable-runner",
        SRC + "local-messaging-dispatcher.mjs",
        "      for (const job of recovery.toRun) {\n        if (!runnable(job.recipient)) continue;",
        "      for (const job of recovery.toRun) {\n        if (false && !runnable(job.recipient)) continue;",
        "C2",
    ),
    (
        "m184-grok-drops-local-recipient-unavailable",
        SRC + "grok-local-session.mjs",
        ",'local_recipient_unavailable','message_id_in_use',",
        ",'message_id_in_use',",
        "C2",
    ),
    # #185: reply-ID reuse guard
    (
        "m185-server-drops-reply-id-check",
        SRC + "local-messaging-server.mjs",
        '          if (existingRecord && typeof existingRecord.phase !== "string") {\n            rateReservation?.rollback?.();\n            throw coded("message_id_in_use", "messageId is already used by a reply; send with a new messageId");\n          }',
        '          if (false && existingRecord && typeof existingRecord.phase !== "string") {\n            rateReservation?.rollback?.();\n            throw coded("message_id_in_use", "messageId is already used by a reply; send with a new messageId");\n          }',
        "C3",
    ),
    (
        "m185-journal-drops-reply-id-check",
        SRC + "local-messaging-journal.mjs",
        '      if (db.prepare("SELECT 1 FROM local_replies WHERE message_id = ?").get(messageId)) {\n        throw coded("message_id_in_use", `messageId ${messageId} is already used by a reply`);\n      }',
        '      if (false && db.prepare("SELECT 1 FROM local_replies WHERE message_id = ?").get(messageId)) {\n        throw coded("message_id_in_use", `messageId ${messageId} is already used by a reply`);\n      }',
        "C3",
    ),
    (
        "m185-journal-checks-reply-before-retry",
        SRC + "local-messaging-journal.mjs",
        '''    try {
      const existing = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
      if (existing) {
        if (
          existing.canonical_hash === hash &&
          (existing.recipient_type ?? "runner") === recipientType &&
          isRouteIntentMatch(existing, to_principal, resolved_via) &&
          (existing.reply_route_key ?? null) === (replyRoute?.key ?? null)
        ) {
          db.exec("COMMIT");
          return { ...mapMessageRow(existing), isDuplicate: true };
        }
        throw coded("duplicate_id_conflict", `Conflicting envelope for messageId: ${messageId}`);
      }
      // A new message never takes an id a reply already has (getRecord and status look for a message
      // first, then a reply). Replies are not checked against messages, so this comes after the
      // retry check above: a message whose id a reply took still answers its exact retry.
      if (db.prepare("SELECT 1 FROM local_replies WHERE message_id = ?").get(messageId)) {
        throw coded("message_id_in_use", `messageId ${messageId} is already used by a reply`);
      }''',
        '''    try {
      if (db.prepare("SELECT 1 FROM local_replies WHERE message_id = ?").get(messageId)) {
        throw coded("message_id_in_use", `messageId ${messageId} is already used by a reply`);
      }
      const existing = db.prepare("SELECT * FROM local_messages WHERE message_id = ?").get(messageId);
      if (existing) {
        if (
          existing.canonical_hash === hash &&
          (existing.recipient_type ?? "runner") === recipientType &&
          isRouteIntentMatch(existing, to_principal, resolved_via) &&
          (existing.reply_route_key ?? null) === (replyRoute?.key ?? null)
        ) {
          db.exec("COMMIT");
          return { ...mapMessageRow(existing), isDuplicate: true };
        }
        throw coded("duplicate_id_conflict", `Conflicting envelope for messageId: ${messageId}`);
      }''',
        "C3",
    ),
    (
        "m185-grok-drops-message-id-in-use",
        SRC + "grok-local-session.mjs",
        ",'local_recipient_unavailable','message_id_in_use',",
        ",'local_recipient_unavailable',",
        "C3",
    ),
    # #183 M1-M3, M5 & packaging
    (
        "m183-m1-leaks-destination-before-policy",
        SRC + "local-messaging-server.mjs",
        '      if (!mayKnow) return hidden;',
        '      if (false && !mayKnow) return hidden;',
        "C4",
    ),
    (
        "m183-m2-m3-drops-mapped-principal",
        SRC + "local-sender-authentication.mjs",
        '    principal: described?.principal ?? null, authorityOrigin: described?.authorityOrigin ?? null,',
        '    principal: null, authorityOrigin: null,',
        "C5",
    ),
    (
        "m183-m5-chat-map-wrong-store-root",
        CLI + "identity-chat-map.mjs",
        "return path.join(clientRoot, 'local');",
        "return path.join(clientRoot, 'client', 'local');",
        "D2",
    ),
    (
        "bundle-content-address-ignores-node",
        "scripts/triangle-worker-install.py",
        '    lines = [agent, node_hash] + [f"{name}={artifacts[name]}" for name in sorted(artifacts)]',
        '    lines = [agent] + [f"{name}={artifacts[name]}" for name in sorted(artifacts)]',
        "C1",
    ),
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
                copy = tarfile.TarInfo.frombuf(member.tobuf(), "utf-8", "surrogateescape")
                copy.size = len(data[member.name])
                tar.addfile(copy, io.BytesIO(data[member.name]))
            else:
                tar.addfile(member)
    with open(path + ".sha256", "w") as handle:
        handle.write("%s  %s\n" % (sha(open(path, "rb").read()), os.path.basename(path)))


def tracked_files():
    out = subprocess.run(["/usr/bin/git", "-C", REPO, "ls-files", "-z"], capture_output=True, check=True).stdout
    return set(x for x in out.decode("utf-8").split("\0") if x)


def build(archive, mutant, work):
    ident, rel, old, new, _ = mutant
    members, data = read_archive(archive)
    if old is not None:
        text = data[rel].decode("utf-8")
        assert text.count(old) == 1, "%s: snippet occurs %d times in %s" % (ident, text.count(old), rel)
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
    for git_args in (["init", "-q"], ["add", "-A"], ["-c", "user.name=m", "-c", "user.email=m@example.invalid", "commit", "-q", "-m", "mutant"]):
        subprocess.run(["/usr/bin/git", "-C", repo] + git_args, env=env, check=True, stdout=subprocess.DEVNULL)
    return base, repo, os.path.join(out, name)


def run_one(archive, mutant, work, node_bin):
    base, repo, packed = build(archive, mutant, work)
    results = os.path.join(base, "results")
    proc = subprocess.Popen(
        [node_bin, RUNNER, "--candidate-archive", packed, "--source-commit", "HEAD", "--repo-root", repo, "--out", results],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=900)
    except subprocess.TimeoutExpired:
        proc.terminate()
        try:
            stdout, stderr = proc.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
        return mutant[0], "timeout", (None, stdout[-400:] + stderr[-400:])
    try:
        report = json.load(open(os.path.join(results, "results.json")))
    except Exception:
        return mutant[0], "no results.json", stdout[-400:] + stderr[-400:]
    failed = (report.get("failure") or {}).get("step")
    return mutant[0], report["verdict"], (failed, (report.get("failure") or {}).get("message", ""))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--work", required=True)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--only", default="")
    parser.add_argument("--node", default=DEFAULT_NODE)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    node_bin = args.node if os.path.exists(args.node) else (shutil.which("node") or os.path.expanduser("~/.local/bin/node"))
    only = [x for x in args.only.split(",") if x]
    mutants = [("control", None, None, None, None)] + [m for m in MUTANTS if not only or m[0] in only]
    os.makedirs(args.work, exist_ok=True)
    expected = {m[0]: m[4] for m in mutants}
    caught, missed = 0, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(run_one, os.path.abspath(args.archive), m, os.path.abspath(args.work), node_bin): m[0] for m in mutants}
        for future in concurrent.futures.as_completed(futures):
            try:
                ident, verdict, detail = future.result()
            except Exception as error:
                ident, verdict, detail = futures[future], "error", repr(error)[:300]
            want = expected[ident]
            if ident == "control":
                ok = verdict == "pass"
                print("%-44s %s  (control)" % (ident, "ok  " if ok else "FAIL"))
                if not ok:
                    print("   ", detail)
                    missed.append(ident)
                continue
            step = detail[0] if isinstance(detail, tuple) else None
            ok = verdict == "fail" and step == want
            caught += ok
            if not ok:
                missed.append(ident)
            print("%-44s %s  fails at %-5s expected %-5s %s" % (ident, "caught" if ok else "MISSED", step, want, detail[1][:110] if isinstance(detail, tuple) else detail))
    print("\ncaught %d of %d mutants%s" % (caught, len(mutants) - 1, "" if not missed else "; problems: " + ", ".join(missed)))
    if not args.keep:
        shutil.rmtree(args.work, ignore_errors=True)
    return 0 if not missed else 1


if __name__ == "__main__":
    sys.exit(main())
