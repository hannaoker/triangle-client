#!/usr/bin/env python3

import argparse
import ast
import base64
import glob
import hashlib
import json
import os
import shutil
import stat
import sys
import uuid
import re
import subprocess

AGENTS = {"codex", "hermes"}
LEGACY_COMMON_ARTIFACTS = [
    "packages/agent-worker/src/cli.mjs",
    "packages/agent-worker/src/command-runner.mjs",
    "packages/agent-worker/src/mailbox-client.mjs",
    "packages/agent-worker/src/runtime.mjs",
    "packages/agent-worker/runners/runner-common.mjs",
]
SUPERVISOR_ARTIFACTS = [
    "packages/agent-worker/src/client-supervisor-cli.mjs",
    "packages/agent-worker/src/client-supervisor.mjs",
    "packages/agent-worker/src/concurrency-gate.mjs",
]
COMMON_ARTIFACTS = LEGACY_COMMON_ARTIFACTS + SUPERVISOR_ARTIFACTS


def fail(message):
    raise SystemExit(message)


def checked_dir(path, exact_mode=None, safe_mode=False):
    path = os.path.abspath(path)
    if os.path.realpath(path) != path:
        fail("directory path must be canonical and nonsymlink")
    info = os.lstat(path)
    mode = stat.S_IMODE(info.st_mode)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid():
        fail("unsafe directory")
    if exact_mode is not None and mode != exact_mode:
        fail("unsafe directory mode")
    if safe_mode and mode & 0o022:
        fail("unsafe directory mode")
    return path


def ensure_dir(path):
    if os.path.lexists(path):
        return checked_dir(path, exact_mode=0o700)
    os.mkdir(path, 0o700)
    return checked_dir(path, exact_mode=0o700)


def checked_file(path, mode=None, executable=False, owners=None):
    path = os.path.abspath(path)
    if os.path.realpath(path) != path:
        fail("file path must be canonical and nonsymlink")
    info = os.lstat(path)
    allowed_owners = {os.getuid()} if owners is None else owners
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid not in allowed_owners:
        fail("unsafe file")
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        fail("unsafe file mode")
    if stat.S_IMODE(info.st_mode) & 0o022:
        fail("writable installed file")
    if executable and not os.access(path, os.X_OK):
        fail("executable is not executable")
    return path


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_node_compatibility(node):
    try:
        compatibility = subprocess.run(
            [node, "--input-type=module", "--eval", "import {globSync} from 'node:fs'; const m=Number(process.versions.node.split('.')[0]); if(m<22||typeof globSync!=='function') process.exit(64); process.stdout.write('triangle-node-ok\\n')"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={}, timeout=5, check=False, text=True,
        )
    except (OSError, subprocess.SubprocessError):
        fail("Node 22.0.0 or newer with node:fs globSync is required")
    if compatibility.returncode != 0 or compatibility.stdout != "triangle-node-ok\n":
        fail("Node 22.0.0 or newer with node:fs globSync is required")


def fsync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path, data, mode=0o600):
    parent = os.path.dirname(path)
    if os.path.lexists(path):
        checked_file(path, mode=mode)
    temporary = os.path.join(parent, ".tmp-" + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(descriptor, mode)
        offset = 0
        while offset < len(data):
            offset += os.write(descriptor, data[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    try:
        os.replace(temporary, path)
        fsync_dir(parent)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def copy_regular(source, destination, destination_mode=0o600):
    checked_file(source, owners={os.getuid(), 0})
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    source_info = os.fstat(source_fd)
    if not stat.S_ISREG(source_info.st_mode) or source_info.st_uid not in {os.getuid(), 0} or stat.S_IMODE(source_info.st_mode) & 0o022:
        os.close(source_fd)
        fail("unsafe opened source file")
    destination_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, destination_mode)
    try:
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            offset = 0
            while offset < len(chunk):
                offset += os.write(destination_fd, chunk[offset:])
        os.fchmod(destination_fd, destination_mode)
        os.fsync(destination_fd)
    finally:
        os.close(source_fd)
        os.close(destination_fd)


def expected_artifacts(agent, version=4):
    if agent not in AGENTS:
        fail("invalid worker kind")
    common = LEGACY_COMMON_ARTIFACTS if version == 3 else COMMON_ARTIFACTS if version == 4 else None
    if common is None:
        fail("unsupported manifest version")
    return common + [
        f"packages/agent-worker/runners/{agent}-runner.mjs",
        f"{agent}/worker/agent-worker.json",
    ]


def content_address(agent, node_hash, artifacts):
    lines = [agent, node_hash] + [f"{name}={artifacts[name]}" for name in sorted(artifacts)]
    return hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()


def discover_runtime_roots(agent, cli):
    roots = [os.path.dirname(cli)]
    if agent == "hermes":
        wrapper = open(cli, encoding="utf-8").read()
        match = re.search(r'^exec\s+"([^"\n]+)"\s+"\$@"\s*$', wrapper, re.MULTILINE)
        if not match:
            fail("unsupported Hermes execution chain")
        entry = checked_file(os.path.realpath(match.group(1)), executable=True, owners={os.getuid(), 0})
        first = open(entry, encoding="utf-8").readline().rstrip()
        if not first.startswith("#!/"):
            fail("Hermes entrypoint lacks an absolute interpreter")
        interpreter = checked_file(os.path.realpath(first[2:].split()[0]), executable=True, owners={os.getuid(), 0})
        venv = os.path.dirname(os.path.dirname(entry))
        roots.extend([venv, os.path.dirname(os.path.dirname(interpreter))])
        for finder in glob.glob(os.path.join(venv, "lib", "python*", "site-packages", "__editable___*_finder.py")):
            tree = ast.parse(open(finder, encoding="utf-8").read(), filename=finder)
            for node_value in tree.body:
                if isinstance(node_value, ast.AnnAssign) and isinstance(node_value.target, ast.Name) and node_value.target.id == "MAPPING":
                    for value in ast.literal_eval(node_value.value).values():
                        candidate = value if os.path.exists(value) else value + ".py"
                        if os.path.exists(candidate):
                            roots.append(os.path.realpath(candidate))
    return os.pathsep.join(dict.fromkeys(map(os.path.realpath, roots)))


def strict_manifest(path, agent):
    checked_file(path, mode=0o600)
    raw = open(path, "rb").read(32769)
    if len(raw) > 32768:
        fail("manifest too large")
    value = json.loads(raw)
    if set(value) != {"version", "nodeSHA256", "projectRoot", "environment", "artifacts"}:
        fail("manifest schema mismatch")
    expected_environment = {
        "PATH", "LANG", "LC_ALL", "TRIANGLE_PROJECT_ROOT", "TRIANGLE_RUNTIME_ROOTS",
        "CODEX_CLI" if agent == "codex" else "HERMES_CLI",
    }
    if value["version"] not in {3, 4} or set(value["artifacts"]) != set(expected_artifacts(agent, value["version"])):
        fail("manifest contract mismatch")
    if not isinstance(value["environment"], dict) or set(value["environment"]) != expected_environment:
        fail("manifest environment mismatch")
    if not all(isinstance(item, str) and not any(control in item for control in "\0\n\r") for item in value["environment"].values()):
        fail("manifest environment is unsafe")
    project = checked_dir(value["projectRoot"], exact_mode=0o700)
    bundles = checked_dir(os.path.join(os.path.dirname(path), "bundles"), exact_mode=0o700)
    if os.path.dirname(project) != bundles or not re.fullmatch(r"[0-9a-f]{64}", os.path.basename(project)):
        fail("runtime bundle path is unsafe")
    if value["environment"].get("TRIANGLE_PROJECT_ROOT") != project:
        fail("runtime bundle environment mismatch")
    checked_dir(os.path.join(project, "bin"), exact_mode=0o700)
    if value["environment"].get("PATH", "").split(os.pathsep)[0] != os.path.join(project, "bin"):
        fail("bundled Node must lead runtime PATH")
    node = checked_file(os.path.join(project, "bin", "node"), mode=0o500, executable=True)
    if not isinstance(value["nodeSHA256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["nodeSHA256"]) or sha256(node) != value["nodeSHA256"]:
        fail("node integrity mismatch")
    validate_node_compatibility(node)
    for relative, expected in value["artifacts"].items():
        if relative.startswith("/") or ".." in relative.split("/"):
            fail("invalid artifact path")
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            fail("invalid artifact hash")
        installed = os.path.join(project, relative)
        checked_file(installed, mode=0o600)
        if sha256(installed) != expected:
            fail("artifact integrity mismatch")
    if os.path.basename(project) != content_address(agent, value["nodeSHA256"], value["artifacts"]):
        fail("runtime content address mismatch")
    return value


def stage_runtime(args):
    root = checked_dir(args.application_root, exact_mode=0o700)
    runtime = ensure_dir(os.path.join(root, "worker-runtime"))
    bundles = ensure_dir(os.path.join(runtime, "bundles"))
    node = checked_file(os.path.realpath(args.node), executable=True, owners={os.getuid(), 0})
    if os.path.basename(node) != "node":
        fail("node executable must be canonical node")
    validate_node_compatibility(node)
    cli = checked_file(os.path.realpath(args.cli), executable=True, owners={os.getuid(), 0})
    project = os.path.abspath(args.project_root)
    bundle = os.path.join(bundles, ".stage-" + uuid.uuid4().hex)
    record_path = None
    created_bundle = False
    os.mkdir(bundle, 0o700)
    try:
        node_directory = os.path.join(bundle, "bin")
        os.mkdir(node_directory, 0o700)
        bundled_node = os.path.join(node_directory, "node")
        copy_regular(node, bundled_node, destination_mode=0o500)
        node_hash = sha256(bundled_node)
        artifacts = {}
        for relative in expected_artifacts(args.agent):
            source = os.path.join(project, relative)
            destination = os.path.join(bundle, relative)
            parent = os.path.dirname(destination)
            os.makedirs(parent, mode=0o700, exist_ok=True)
            current = bundle
            for component in os.path.relpath(parent, bundle).split(os.sep):
                if component != ".":
                    current = os.path.join(current, component)
                    os.chmod(current, 0o700)
                    checked_dir(current, exact_mode=0o700)
            copy_regular(source, destination)
            artifacts[relative] = sha256(destination)
        for current, directories, _ in os.walk(bundle, topdown=False):
            for directory in directories:
                fsync_dir(os.path.join(current, directory))
            fsync_dir(current)
        bundle_id = content_address(args.agent, node_hash, artifacts)
        final_bundle = os.path.join(bundles, bundle_id)
        if os.path.lexists(final_bundle):
            checked_dir(final_bundle, exact_mode=0o700)
            existing_node = checked_file(os.path.join(final_bundle, "bin", "node"), mode=0o500, executable=True)
            if sha256(existing_node) != node_hash:
                fail("content-addressed Node mismatch")
            for relative, expected in artifacts.items():
                existing = checked_file(os.path.join(final_bundle, relative), mode=0o600)
                if sha256(existing) != expected:
                    fail("content-addressed artifact mismatch")
            shutil.rmtree(bundle)
        else:
            os.rename(bundle, final_bundle)
            fsync_dir(bundles)
            created_bundle = True
        bundle = final_bundle
        environment = {
            "PATH": os.pathsep.join(dict.fromkeys([os.path.join(bundle, "bin"), os.path.dirname(cli), "/usr/bin", "/bin"])),
            "LANG": "C",
            "LC_ALL": "C",
            "TRIANGLE_PROJECT_ROOT": bundle,
            "TRIANGLE_RUNTIME_ROOTS": discover_runtime_roots(args.agent, cli),
            ("CODEX_CLI" if args.agent == "codex" else "HERMES_CLI"): cli,
        }
        manifest = {
            "version": 4, "nodeSHA256": node_hash,
            "projectRoot": bundle, "environment": environment, "artifacts": artifacts,
        }
        manifest_path = os.path.join(runtime, f"{args.agent}.manifest.json")
        previous = None
        existed = os.path.lexists(manifest_path)
        if existed:
            checked_file(manifest_path, mode=0o600)
            previous = open(manifest_path, "rb").read()
        record_path = os.path.join(runtime, ".rollback-" + args.agent + "-" + uuid.uuid4().hex + ".json")
        record = json.dumps({
            "version": 1, "agent": args.agent, "manifestPath": manifest_path,
            "previousExisted": existed,
            "previousBytes": base64.b64encode(previous or b"").decode("ascii"),
            "newBundle": bundle, "newBundleCreated": created_bundle,
        }, sort_keys=True, separators=(",", ":")).encode()
        atomic_write(record_path, record)
        atomic_write(manifest_path, json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode())
        strict_manifest(manifest_path, args.agent)
        print(record_path)
    except BaseException:
        if record_path is not None and os.path.lexists(record_path):
            finish_runtime(record_path, True)
        elif created_bundle and os.path.isdir(bundle):
            shutil.rmtree(bundle)
            fsync_dir(bundles)
        elif os.path.isdir(bundle) and os.path.basename(bundle).startswith(".stage-"):
            shutil.rmtree(bundle)
        raise


def read_record(path):
    checked_file(path, mode=0o600)
    value = json.loads(open(path, "rb").read())
    if value.get("version") != 1:
        fail("invalid rollback record")
    return value


def finish_runtime(path, rollback):
    value = read_record(path)
    manifest_path = value["manifestPath"]
    runtime = os.path.dirname(path)
    if os.path.dirname(manifest_path) != runtime or not value["newBundle"].startswith(os.path.join(runtime, "bundles") + os.sep):
        fail("unsafe rollback record")
    if rollback:
        if value["previousExisted"]:
            atomic_write(manifest_path, base64.b64decode(value["previousBytes"], validate=True))
        elif os.path.lexists(manifest_path):
            checked_file(manifest_path, mode=0o600)
            os.unlink(manifest_path)
            fsync_dir(runtime)
        if value.get("newBundleCreated") is True and os.path.isdir(value["newBundle"]):
            shutil.rmtree(value["newBundle"])
            fsync_dir(os.path.dirname(value["newBundle"]))
    os.unlink(path)
    fsync_dir(runtime)


def activate_plist(args):
    target = os.path.abspath(args.target)
    parent = checked_dir(os.path.dirname(target), safe_mode=True)
    staged = checked_file(args.staged, mode=0o600)
    if os.path.dirname(staged) != parent:
        fail("staged plist must be in LaunchAgents")
    existed = os.path.lexists(target)
    previous = b""
    if existed:
        checked_file(target, mode=0o600)
        previous = open(target, "rb").read()
    record_path = os.path.join(parent, ".rollback-" + os.path.basename(target) + "-" + uuid.uuid4().hex + ".json")
    record = json.dumps({
        "version": 1, "target": target, "previousExisted": existed,
        "previousBytes": base64.b64encode(previous).decode("ascii"),
    }, sort_keys=True, separators=(",", ":")).encode()
    atomic_write(record_path, record)
    os.replace(staged, target)
    fsync_dir(parent)
    print(record_path)


def finish_plist(path, rollback):
    value = read_record(path)
    target = value["target"]
    parent = os.path.dirname(path)
    if os.path.dirname(target) != parent:
        fail("unsafe plist rollback record")
    if rollback:
        if value["previousExisted"]:
            atomic_write(target, base64.b64decode(value["previousBytes"], validate=True))
        elif os.path.lexists(target):
            checked_file(target, mode=0o600)
            os.unlink(target)
            fsync_dir(parent)
    os.unlink(path)
    fsync_dir(parent)


def ensure_tree(home):
    home = os.path.abspath(home)
    if os.path.realpath(home) != home:
        fail(f"home path must be canonical and nonsymlink: {home} -> {os.path.realpath(home)}")
    home = checked_dir(home, safe_mode=True)
    current = home
    for component in ("Library", "Application Support"):
        current = os.path.join(current, component)
        if os.path.lexists(current):
            checked_dir(current, safe_mode=True)
        else:
            os.mkdir(current, 0o700)
    root = os.path.join(current, "The Triangle")
    if os.path.lexists(root): checked_dir(root, exact_mode=0o700)
    else: os.mkdir(root, 0o700)
    for component in ("bin", "install-manifest", "worker-runtime", "credentials", "model-state"):
        ensure_dir(os.path.join(root, component))
    launch_agents = os.path.join(home, "Library", "LaunchAgents")
    if os.path.lexists(launch_agents): checked_dir(launch_agents, safe_mode=True)
    else: os.mkdir(launch_agents, 0o700)
    logs = os.path.join(home, "Library", "Logs")
    if os.path.lexists(logs): checked_dir(logs, safe_mode=True)
    else: os.mkdir(logs, 0o700)
    triangle_logs = os.path.join(logs, "the-triangle")
    if os.path.lexists(triangle_logs): checked_dir(triangle_logs, safe_mode=True)
    else: os.mkdir(triangle_logs, 0o700)
    print(root)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    stage = sub.add_parser("stage-runtime")
    stage.add_argument("--application-root", required=True); stage.add_argument("--project-root", required=True)
    stage.add_argument("--agent", choices=sorted(AGENTS), required=True); stage.add_argument("--node", required=True)
    stage.add_argument("--cli", required=True)
    validate = sub.add_parser("validate-runtime")
    validate.add_argument("--manifest", required=True); validate.add_argument("--agent", choices=sorted(AGENTS), required=True)
    for name in ("commit-runtime", "rollback-runtime", "commit-plist", "rollback-plist"):
        command = sub.add_parser(name); command.add_argument("record")
    activate = sub.add_parser("activate-plist"); activate.add_argument("--target", required=True); activate.add_argument("--staged", required=True)
    tree = sub.add_parser("ensure-tree"); tree.add_argument("--home", required=True)
    args = parser.parse_args()
    if args.command == "stage-runtime": stage_runtime(args)
    elif args.command == "validate-runtime": strict_manifest(args.manifest, args.agent)
    elif args.command == "commit-runtime": finish_runtime(args.record, False)
    elif args.command == "rollback-runtime": finish_runtime(args.record, True)
    elif args.command == "activate-plist": activate_plist(args)
    elif args.command == "commit-plist": finish_plist(args.record, False)
    elif args.command == "rollback-plist": finish_plist(args.record, True)
    elif args.command == "ensure-tree": ensure_tree(args.home)


if __name__ == "__main__":
    main()
