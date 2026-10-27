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

AGENTS = {"codex", "hermes", "antigravity"}
LEGACY_COMMON_ARTIFACTS = [
    "packages/agent-worker/src/cli.mjs",
    "packages/agent-worker/src/command-runner.mjs",
    "packages/agent-worker/src/mailbox-client.mjs",
    "packages/agent-worker/src/runtime.mjs",
    "packages/agent-worker/runners/runner-common.mjs",
]
SUPERVISOR_ARTIFACTS = [
    "packages/agent-worker/src/authenticated-app-server-transport.mjs",
    "packages/agent-worker/src/client-supervisor-cli.mjs",
    "packages/agent-worker/src/client-supervisor.mjs",
    "packages/agent-worker/src/concurrency-gate.mjs",
    "packages/agent-worker/src/helper-transaction-proxy.mjs",
    "packages/agent-worker/src/helper-watch-transport.mjs",
    "packages/agent-worker/src/profile-scheduler.mjs",
    "packages/agent-worker/src/shared-codex-app-server.mjs",
    "packages/agent-worker/src/app-server-bind-cli.mjs",
    "packages/agent-worker/src/grok-bot-wake.mjs",
    "packages/agent-worker/src/install-watch-dispatcher.mjs",
    "packages/agent-worker/src/wake-client.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/acp-process.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/acp-protocol.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/config-guards.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/headless-drain-service.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/headless-drain.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/headless-runtime.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/index.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/runtime-home.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/session-registry.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/unattended-policy.mjs",
    "packages/agent-worker/src/cursor-acp-runtime/worker-pool.mjs",
]
# Extracted supervisor schema lands in manifest v6 so existing v4/v5 bundles keep validating.
SUPERVISOR_SCHEMA_ARTIFACTS = [
    "packages/agent-worker/src/client-supervisor-schema.mjs",
]
# Headless claimer flock + open-txn recovery land in manifest v7 so existing v6
# helpers (exact-set match) keep validating until the mailbox helper is rebuilt.
HEADLESS_OWNERSHIP_ARTIFACTS = [
    "packages/agent-worker/src/claimer-advisory-lock.mjs",
    "packages/agent-worker/src/open-transaction-recovery.mjs",
]
COMMON_ARTIFACTS = LEGACY_COMMON_ARTIFACTS + SUPERVISOR_ARTIFACTS
# Permissions v1 (manifest v8): workers authenticate with the agent's workload
# key through the shared triangle-cli protocol core (one JWS/DPoP implementation).
WORKLOAD_CORE_ARTIFACTS = [
    "packages/agent-worker/src/workload-credential.mjs",
    "packages/triangle-cli/src/canonical.mjs",
    "packages/triangle-cli/src/errors.mjs",
    "packages/triangle-cli/src/keys.mjs",
    "packages/triangle-cli/src/protocol.mjs",
    "packages/triangle-cli/src/workload.mjs",
]
LOCAL_MESSAGING_ARTIFACTS = [
    "packages/agent-worker/src/local-messaging-acl.mjs",
    "packages/agent-worker/src/local-messaging-address.mjs",
    "packages/agent-worker/src/local-messaging-client.mjs",
    "packages/agent-worker/src/local-messaging-credentials.mjs",
    "packages/agent-worker/src/local-messaging-errors.mjs",
    "packages/agent-worker/src/local-messaging-journal-contract.mjs",
    "packages/agent-worker/src/local-messaging-mcp-adapter.mjs",
    "packages/agent-worker/src/local-messaging-protocol.mjs",
    "packages/agent-worker/src/local-messaging-rate-limiter.mjs",
    "packages/agent-worker/src/local-messaging-server.mjs",
    "packages/agent-worker/src/local-messaging-supervisor-seam.mjs",
    "packages/agent-worker/src/shared-delivery-journal.mjs",
    "packages/agent-worker/src/delivery-private-path.mjs",
    "packages/agent-worker/src/local-messaging-journal.mjs",
    "packages/agent-worker/src/local-messaging-dispatcher.mjs",
    "packages/agent-worker/src/local-messaging-auth-broker.mjs",
    "packages/agent-worker/src/local-messaging-host.mjs",
    "packages/agent-worker/src/local-messaging-cli.mjs",
]
WAKE_NOTIFICATION_ARTIFACTS = [
    "packages/agent-worker/src/codex-wake-adapter.mjs",
    "packages/agent-worker/src/local-messaging-notifier.mjs",
]
CLAUDE_SESSION_ARTIFACTS = [
    "packages/agent-worker/src/local-messaging-interactive-session.mjs",
    "packages/agent-worker/src/claude-session-delivery.mjs",
    "packages/agent-worker/src/claude-session-mcp-child.mjs",
]
GROK_SESSION_ARTIFACTS = ["packages/agent-worker/src/grok-local-session.mjs"]
ROUTER_ARTIFACTS = [
    "packages/agent-worker/src/identity-primitives.mjs",
    "packages/agent-worker/src/identity-registry.mjs",
    "packages/agent-worker/src/recipient-resolver.mjs",
    "packages/agent-worker/src/router-registry-snapshot.mjs",
    "packages/agent-worker/src/transport-adapter-contract.mjs",
    "packages/agent-worker/src/unified-router.mjs",
]
REPLY_IDENTITY_ARTIFACTS = ['packages/agent-worker/src/local-reply-route-contract.mjs', 'packages/agent-worker/src/local-reply-route-store.mjs', 'packages/agent-worker/src/local-sender-authentication.mjs']
CURRENT_MANIFEST_VERSION = 14
CODEX_HEADLESS_ARTIFACTS = [
    "packages/agent-worker/src/codex-runtime/app-server-process.mjs",
    "packages/agent-worker/src/codex-runtime/app-server-protocol.mjs",
    "packages/agent-worker/src/codex-runtime/completion-reconciler.mjs",
    "packages/agent-worker/src/codex-runtime/config-guards.mjs",
    "packages/agent-worker/src/codex-runtime/conversation-registry.mjs",
    "packages/agent-worker/src/codex-runtime/correlation.mjs",
    "packages/agent-worker/src/codex-runtime/desktop-handoff.mjs",
    "packages/agent-worker/src/codex-runtime/durable-conversation-store.mjs",
    "packages/agent-worker/src/codex-runtime/execution-lease.mjs",
    "packages/agent-worker/src/codex-runtime/execution-state.mjs",
    "packages/agent-worker/src/codex-runtime/headless-drain-cli.mjs",
    "packages/agent-worker/src/codex-runtime/headless-drain-service.mjs",
    "packages/agent-worker/src/codex-runtime/headless-drain.mjs",
    "packages/agent-worker/src/codex-runtime/headless-runtime.mjs",
    "packages/agent-worker/src/codex-runtime/runtime-home.mjs",
    "packages/agent-worker/src/codex-runtime/runtime-manifest.mjs",
    "packages/agent-worker/src/codex-runtime/shared-home-concurrency-probe.mjs",
    "packages/agent-worker/src/codex-runtime/worker-pool.mjs",
    "packages/agent-worker/src/codex-runtime/manifest/runtime-manifest.json",
]


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


def expected_artifacts(agent, version=CURRENT_MANIFEST_VERSION):
    if agent == "supervisor":
        if version not in {8, 9, 10, 11, 12, 13, 14}:
            fail("unsupported supervisor manifest version")
        return expected_artifacts("codex", version)[:-2]
    if agent not in AGENTS:
        fail("invalid worker kind")
    if version == 3:
        common = LEGACY_COMMON_ARTIFACTS
    elif version in {4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14}:
        common = COMMON_ARTIFACTS
    else:
        fail("unsupported manifest version")
    extras = (["packages/agent-worker/src/claimer-cross-runtime.mjs"] if version in {5, 6, 7, 8, 9, 10, 11, 12, 13, 14} else [])
    # The coordinator (client-supervisor-cli.mjs) may launch from any worker's
    # bundle and statically imports codex-runtime/headless-drain-service.mjs, so
    # v7 ships codex-runtime in every bundle; v5/v6 keep their exact sets.
    extras += CODEX_HEADLESS_ARTIFACTS if (version in {7, 8, 9, 10, 11, 12, 13, 14} or (version in {5, 6} and agent == "codex")) else []
    extras += SUPERVISOR_SCHEMA_ARTIFACTS if version in {6, 7, 8, 9, 10, 11, 12, 13, 14} else []
    extras += HEADLESS_OWNERSHIP_ARTIFACTS if version in {7, 8, 9, 10, 11, 12, 13, 14} else []
    extras += WORKLOAD_CORE_ARTIFACTS if version >= 8 else []
    extras += LOCAL_MESSAGING_ARTIFACTS if version >= 9 else []
    extras += WAKE_NOTIFICATION_ARTIFACTS if version >= 10 else []
    extras += CLAUDE_SESSION_ARTIFACTS if version >= 11 else []
    extras += GROK_SESSION_ARTIFACTS if version >= 12 else []
    extras += ROUTER_ARTIFACTS if version >= 13 else []
    extras += REPLY_IDENTITY_ARTIFACTS if version >= 14 else []
    return common + extras + [
        f"packages/agent-worker/runners/{agent}-runner.mjs",
        f"agents/{agent}/worker/agent-worker.json",
    ]


def content_address(agent, node_hash, artifacts):
    lines = [agent, node_hash] + [f"{name}={artifacts[name]}" for name in sorted(artifacts)]
    return hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()


HERMES_EXEC_QUOTED = re.compile(r'^exec\s+"(/[^"\n$`\\]+)"\s+"\$@"\s*$', re.MULTILINE)
HERMES_EXEC_UNQUOTED = re.compile(r'^exec\s+(/[A-Za-z0-9._+/@%:,=-]+)\s+"\$@"\s*$', re.MULTILINE)


def hermes_exec_target(wrapper):
    """Absolute exec target of a `~/.local/bin/hermes` wrapper, or None.

    Accepts `exec "/abs/path/hermes" "$@"` and `exec /abs/path/hermes "$@"`.
    Unquoted paths are limited to shell-inert characters (no expansion,
    globbing, word splitting, or substitution). Exactly one exec line.
    """
    matches = HERMES_EXEC_QUOTED.findall(wrapper) + HERMES_EXEC_UNQUOTED.findall(wrapper)
    if len(matches) != 1:
        return None
    target = matches[0]
    if "//" in target or "/../" in target + "/" or "/./" in target + "/":
        return None
    return target


def managed_hermes_runtime(entry, launcher):
    if not launcher.startswith("#!/bin/sh\n"):
        return None
    if not entry.endswith("/.hermes/bin/hermes"):
        fail("unsupported Hermes shell entrypoint")
    match = re.search(r"^exec (/[A-Za-z0-9._+/@%:,=-]+) -I -c '", launcher, re.MULTILINE)
    if not match:
        fail("Hermes managed interpreter is unavailable")
    python = checked_file(os.path.realpath(match.group(1)), executable=True, owners={os.getuid(), 0})
    source = os.path.realpath(os.path.join(os.path.dirname(entry), "../.."))
    tools = os.path.join(os.path.dirname(source), "tools")
    lexical_python = match.group(1)
    if (os.path.basename(lexical_python) != "python3" or os.path.basename(os.path.dirname(lexical_python)) != "bin"
            or os.path.dirname(os.path.dirname(os.path.dirname(lexical_python))) != tools
            or os.path.realpath(os.path.dirname(lexical_python)) != os.path.dirname(lexical_python)
            or os.path.dirname(python) != os.path.dirname(lexical_python)
            or not re.fullmatch(r"python3(?:\.\d+)?", os.path.basename(python))):
        fail("Hermes managed interpreter escapes its tool store")
    install_key = hashlib.sha256(source.encode()).hexdigest()[:16]
    install = os.path.join(os.path.dirname(source), "installs", install_key)
    facts_path = checked_file(os.path.join(install, "facts.json"), owners={os.getuid(), 0})
    facts = json.loads(open(facts_path, encoding="utf-8").read())
    selected = facts.get("packages", {}).get("venv", {}).get("environment")
    environments = os.path.join(install, "environments")
    if (not isinstance(selected, str) or not os.path.isabs(selected)
            or os.path.normpath(selected) != selected or os.path.basename(selected) != "venv"
            or os.path.dirname(os.path.dirname(selected)) != environments
            or os.path.realpath(selected) != selected):
        fail("Hermes selected environment escapes its installation")
    checked_dir(selected, safe_mode=True)
    workspace = os.path.join(os.path.dirname(selected), "workspace")
    if os.path.realpath(workspace) != workspace:
        fail("Hermes workspace must not be a symlink")
    checked_dir(workspace, safe_mode=True)
    return source, selected, workspace, python


def discover_runtime_roots(agent, cli):
    roots = [os.path.dirname(cli)]
    if agent == "hermes":
        wrapper = open(cli, encoding="utf-8").read()
        target = hermes_exec_target(wrapper)
        if target is None:
            fail("unsupported Hermes execution chain")
        entry = checked_file(os.path.realpath(target), executable=True, owners={os.getuid(), 0})
        launcher = open(entry, encoding="utf-8").read()
        first = launcher.splitlines()[0]
        managed = managed_hermes_runtime(entry, launcher)
        if not first.startswith("#!/"):
            fail("Hermes entrypoint lacks an absolute interpreter")
        interpreter = managed[3] if managed else checked_file(os.path.realpath(first[2:].split()[0]), executable=True, owners={os.getuid(), 0})
        venv = managed[1] if managed else os.path.dirname(os.path.dirname(entry))
        agent_root = managed[0] if managed else os.path.dirname(venv)
        if managed:
            roots.extend([managed[2], os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(venv))), "facts.json")])
        roots.extend([venv, os.path.dirname(os.path.dirname(interpreter)), agent_root])
        pyvenv_config = os.path.join(venv, "pyvenv.cfg")
        if os.path.exists(pyvenv_config):
            checked_file(pyvenv_config, owners={os.getuid(), 0})
            raw_config = open(pyvenv_config, "rb").read(32769)
            if len(raw_config) > 32768:
                fail("Hermes pyvenv.cfg is too large")
            config = raw_config.decode("utf-8")
            home_match = re.search(r"^\s*home\s*=\s*(.+?)\s*$", config, re.MULTILINE | re.IGNORECASE)
            if home_match:
                base_bin = home_match.group(1)
                if not os.path.isabs(base_bin) or "\x00" in base_bin:
                    fail("Hermes pyvenv.cfg home must be absolute")
                base_bin = checked_dir(os.path.realpath(base_bin), safe_mode=True)
                base_prefix = checked_dir(os.path.dirname(base_bin), safe_mode=True)
                roots.append(base_prefix)
        for finder in glob.glob(os.path.join(venv, "lib", "python*", "site-packages", "__editable___*_finder.py")):
            tree = ast.parse(open(finder, encoding="utf-8").read(), filename=finder)
            for node_value in tree.body:
                if isinstance(node_value, ast.AnnAssign) and isinstance(node_value.target, ast.Name) and node_value.target.id == "MAPPING":
                    for value in ast.literal_eval(node_value.value).values():
                        candidate = value if os.path.exists(value) else value + ".py"
                        if os.path.exists(candidate):
                            resolved = os.path.realpath(candidate)
                            allowed = [agent_root] + ([managed[2]] if managed else [])
                            if not any(resolved.startswith(root + os.sep) for root in allowed) or resolved.startswith(venv + os.sep):
                                fail("Hermes editable runtime escapes its installation root")
                            roots.append(resolved)
    elif agent == "antigravity":
        # agy state: signed-in session (antigravity-cli) and project config (config).
        for state_dir in ("antigravity-cli", "config"):
            gemini_state = os.path.join(os.path.expanduser("~"), ".gemini", state_dir)
            if os.path.isdir(gemini_state):
                roots.append(os.path.realpath(gemini_state))
    return os.pathsep.join(dict.fromkeys(map(os.path.realpath, roots)))


def strict_manifest(path, agent):
    if agent == "supervisor":
        runtime = checked_dir(os.path.dirname(path), exact_mode=0o700)
        checked_dir(os.path.dirname(runtime), exact_mode=0o700)
        if os.path.basename(path) != "supervisor.manifest.json":
            fail("invalid supervisor manifest path")
    checked_file(path, mode=0o600)
    raw = open(path, "rb").read(32769)
    if len(raw) > 32768:
        fail("manifest too large")
    value = json.loads(raw)
    if set(value) != {"version", "nodeSHA256", "projectRoot", "environment", "artifacts"}:
        fail("manifest schema mismatch")
    expected_environment = {
        "PATH", "LANG", "LC_ALL", "TRIANGLE_PROJECT_ROOT", "TRIANGLE_RUNTIME_ROOTS",
        "CODEX_CLI" if agent == "codex" else ("HERMES_CLI" if agent == "hermes" else "ANTIGRAVITY_CLI"),
    }
    if agent == "supervisor":
        expected_environment = {"PATH", "LANG", "LC_ALL"}
    if value["version"] not in {3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14} or set(value["artifacts"]) != set(expected_artifacts(agent, value["version"])):
        fail("manifest contract mismatch")
    if not isinstance(value["environment"], dict) or set(value["environment"]) != expected_environment:
        fail("manifest environment mismatch")
    if not all(isinstance(item, str) and not any(control in item for control in "\0\n\r") for item in value["environment"].values()):
        fail("manifest environment is unsafe")
    project = checked_dir(value["projectRoot"], exact_mode=0o700)
    bundles = checked_dir(os.path.join(os.path.dirname(path), "bundles"), exact_mode=0o700)
    if os.path.dirname(project) != bundles or not re.fullmatch(r"[0-9a-f]{64}", os.path.basename(project)):
        fail("runtime bundle path is unsafe")
    if agent != "supervisor" and value["environment"].get("TRIANGLE_PROJECT_ROOT") != project:
        fail("runtime bundle environment mismatch")
    checked_dir(os.path.join(project, "bin"), exact_mode=0o700)
    if value["environment"].get("PATH", "").split(os.pathsep)[0] != os.path.join(project, "bin"):
        fail("bundled Node must lead runtime PATH")
    if agent == "supervisor" and value["environment"] != {"PATH": project + "/bin:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}:
        fail("supervisor environment mismatch")
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
    if agent == "supervisor":
        actual_files = set()
        for current, directories, files in os.walk(project):
            checked_dir(current, exact_mode=0o700)
            for directory in directories:
                checked_dir(os.path.join(current, directory), exact_mode=0o700)
            for name in files:
                actual_files.add(os.path.relpath(os.path.join(current, name), project))
        if actual_files != set(value["artifacts"]) | {"bin/node"}:
            fail("supervisor file set mismatch")
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
    if args.agent != "supervisor" and not args.cli:
        fail("worker runtime requires --cli")
    cli = None if args.agent == "supervisor" else checked_file(os.path.realpath(args.cli), executable=True, owners={os.getuid(), 0})
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
            "PATH": os.pathsep.join(dict.fromkeys([os.path.join(bundle, "bin"), *([] if cli is None else [os.path.dirname(cli)]), "/usr/bin", "/bin"])),
            "LANG": "C",
            "LC_ALL": "C",
            "TRIANGLE_PROJECT_ROOT": bundle,
            "TRIANGLE_RUNTIME_ROOTS": "" if cli is None else discover_runtime_roots(args.agent, cli),
            ("CODEX_CLI" if args.agent == "codex" else ("HERMES_CLI" if args.agent == "hermes" else "ANTIGRAVITY_CLI")): cli,
        }
        if args.agent == "supervisor":
            environment = {"PATH": bundle + "/bin:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
        manifest = {
            "version": CURRENT_MANIFEST_VERSION, "nodeSHA256": node_hash,
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


LOCAL_WRAPPER_MARKER = b"# TRIANGLE_MANAGED_LOCAL_WRAPPER_V1\n"


def run_local_wrapper():
    # The wrapper is a frozen copy of these validators, not a shell launcher.
    root = checked_dir(TRIANGLE_LOCAL_APPLICATION_ROOT, exact_mode=0o700)
    checked_dir(os.path.join(root, "worker-runtime"), exact_mode=0o700)
    manifest = strict_manifest(os.path.join(root, "worker-runtime", "supervisor.manifest.json"), "supervisor")
    if manifest["version"] < 9:
        fail("installed local messaging requires manifest v9")
    node = os.path.join(manifest["projectRoot"], "bin", "node")
    entry = os.path.join(manifest["projectRoot"], "packages/agent-worker/src/local-messaging-cli.mjs")
    os.execve(node, [node, entry, *sys.argv[1:]], dict(os.environ))


def wrapper_interpreter(executable=None):
    # The wrapper embeds a frozen copy of this installer, so it runs under the interpreter that validated it.
    executable = sys.executable if executable is None else executable
    if (
        not isinstance(executable, str)
        or not os.path.isabs(executable)
        or len(executable) > 200
        or re.search(r"[\s\x00-\x1f\x7f]", executable)
        or not os.path.isfile(executable)
        or not os.access(executable, os.X_OK)
    ):
        fail("triangle-local needs an absolute, whitespace-free interpreter path; run the installer with such a Python")
    return executable


def install_local_wrapper(application_root):
    root = checked_dir(application_root, exact_mode=0o700)
    bin_root = ensure_dir(os.path.join(root, "bin"))
    target = os.path.join(bin_root, "triangle-local")
    if os.path.lexists(target):
        checked_file(target, mode=0o700, executable=True)
        with open(target, "rb") as current:
            if LOCAL_WRAPPER_MARKER not in current.read(512):
                fail("refusing unrelated triangle-local replacement")
    with open(__file__, "rb") as source_file:
        source = source_file.read()
    source = source.replace(b"#!/usr/bin/env python3\n", b"", 1)
    header = b"#!" + wrapper_interpreter().encode() + b"\n" + LOCAL_WRAPPER_MARKER
    header += ("TRIANGLE_LOCAL_APPLICATION_ROOT = " + repr(root) + "\n").encode()
    atomic_write(target, header + source, mode=0o700)
    fsync_dir(bin_root)
    print(target)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    local = sub.add_parser("install-local-wrapper"); local.add_argument("--application-root", required=True)
    stage = sub.add_parser("stage-runtime")
    stage.add_argument("--application-root", required=True); stage.add_argument("--project-root", required=True)
    stage.add_argument("--agent", choices=sorted(AGENTS | {"supervisor"}), required=True); stage.add_argument("--node", required=True)
    stage.add_argument("--cli")
    validate = sub.add_parser("validate-runtime")
    validate.add_argument("--manifest", required=True); validate.add_argument("--agent", choices=sorted(AGENTS | {"supervisor"}), required=True)
    for name in ("commit-runtime", "rollback-runtime", "commit-plist", "rollback-plist"):
        command = sub.add_parser(name); command.add_argument("record")
    activate = sub.add_parser("activate-plist"); activate.add_argument("--target", required=True); activate.add_argument("--staged", required=True)
    tree = sub.add_parser("ensure-tree"); tree.add_argument("--home", required=True)
    args = parser.parse_args()
    if args.command == "install-local-wrapper": install_local_wrapper(args.application_root)
    elif args.command == "stage-runtime": stage_runtime(args)
    elif args.command == "validate-runtime": strict_manifest(args.manifest, args.agent)
    elif args.command == "commit-runtime": finish_runtime(args.record, False)
    elif args.command == "rollback-runtime": finish_runtime(args.record, True)
    elif args.command == "activate-plist": activate_plist(args)
    elif args.command == "commit-plist": finish_plist(args.record, False)
    elif args.command == "rollback-plist": finish_plist(args.record, True)
    elif args.command == "ensure-tree": ensure_tree(args.home)


if __name__ == "__main__":
    if "TRIANGLE_LOCAL_APPLICATION_ROOT" in globals():
        run_local_wrapper()
    else:
        main()
