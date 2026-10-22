import CryptoKit
import Darwin
import Foundation

public enum WorkerLauncherError: Error, Equatable, Sendable {
    case unsafeInstallation
    case invalidManifest
    case integrityMismatch
    case executionFailed
}

public struct WorkerCommand: Equatable, Sendable {
    public let executable: URL
    public let arguments: [String]
    public let workingDirectory: URL
    public let environment: [String: String]

    public init(executable: URL, arguments: [String], workingDirectory: URL, environment: [String: String]) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.environment = environment
    }
}

public protocol WorkerCommandResolving: Sendable {
    func resolve(_ worker: WorkerKind, instance: ClientInstance) throws -> WorkerCommand
}

public protocol ClientSupervisorCommandResolving: Sendable {
    func resolveAdapter(for instance: ClientInstance) throws -> WorkerCommand
    func resolveCoordinator(for instances: [ClientInstance]) throws -> WorkerCommand
}

public struct WorkerExecutionRequest: Equatable, Sendable {
    public let executable: URL
    public let arguments: [String]
    public let workingDirectory: URL
    public let environment: [String: String]
}

public protocol WorkerExecuting: Sendable {
    func execute(_ request: WorkerExecutionRequest) throws
}

public struct WorkerLauncher: Sendable {
    private let gate: VerifiedCredentialGate
    private let resolver: any WorkerCommandResolving
    private let executor: any WorkerExecuting

    public init(gate: VerifiedCredentialGate, resolver: any WorkerCommandResolving, executor: any WorkerExecuting) {
        self.gate = gate
        self.resolver = resolver
        self.executor = executor
    }

    public func launch(
        profile: ProfileName,
        worker: WorkerKind,
        inheritedEnvironment: [String: String] = ProcessInfo.processInfo.environment
    ) async throws {
        _ = inheritedEnvironment // Ambient state is intentionally never inherited by the worker.
        let adapter: RuntimeAdapter = worker == .codex ? .codex : (worker == .hermes ? .hermes : .antigravity)
        let instance = try ClientInstance(profile: profile, runtimeAdapter: adapter)
        let command = try resolver.resolve(worker, instance: instance)
        let credential = try await gate.credential(for: profile)
        // Workers reply and acknowledge; a read-only agent cannot run one.
        guard credential.canWrite else { throw VerifiedCredentialGateError.credentialRefused }
        var environment = command.environment
        environment.keys.filter { key in
            key.hasPrefix("MESH_") || key.hasPrefix("TRIANGLE_WORKLOAD_") || key == "TRIANGLE_IDENTITY_ROOT"
                || key == "CODEX_AGENT_ID" || key == "HERMES_AGENT_ID" || key == "ANTIGRAVITY_AGENT_ID"
        }.forEach { environment.removeValue(forKey: $0) }
        environment["MESH_ORIGIN"] = credential.origin.value
        // Permissions v1: the worker reads this agent's own key file (0600);
        // key material never travels through the environment.
        environment["TRIANGLE_WORKLOAD_KEY_FILE"] = credential.workloadKeyFile.path
        environment["TRIANGLE_IDENTITY_ROOT"] = try Self.isolatedIdentityRoot(for: credential, environment: command.environment)
        environment[worker == .codex ? "CODEX_AGENT_ID" : (worker == .hermes ? "HERMES_AGENT_ID" : "ANTIGRAVITY_AGENT_ID")] = credential.agentID.value
        try executor.execute(WorkerExecutionRequest(
            executable: command.executable,
            arguments: command.arguments,
            workingDirectory: command.workingDirectory,
            environment: environment
        ))
    }
}

extension WorkerLauncher {
    static let sandboxRootKeys = [
        "TRIANGLE_PROJECT_ROOT", "TRIANGLE_CREDENTIAL_ROOT", "TRIANGLE_MODEL_STATE_BASE", "TRIANGLE_MODEL_ROOTS",
        "TRIANGLE_RUNTIME_ROOTS", "TRIANGLE_WRITABLE_RUNTIME_ROOTS", "TRIANGLE_INSTANCE_TEMP_ROOT",
        "CODEX_HOME", "HERMES_HOME", "ANTIGRAVITY_HOME",
    ]

    /// The `triangle` custody home (<home>/agents/<id>/workload-key.json) must
    /// stay outside every root a seatbelt runner child can read or write; the
    /// Node sandbox (runner-common.mjs) requires it and denies it explicitly.
    /// The headless Codex app-server and Cursor ACP lanes are not covered
    /// (same-user runtime, accepted under F1; v1.1 follow-up).
    static func isolatedIdentityRoot(for credential: VerifiedCredential, environment: [String: String]) throws -> String {
        let identityRoot = credential.workloadKeyFile
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        try requireIsolatedIdentityRoot(identityRoot, from: environment)
        return identityRoot.path
    }

    /// A runner environment for the supervisor bootstrap with the custody home set.
    static func isolatedRunnerEnvironment(_ environment: [String: String], credential: VerifiedCredential) throws -> [String: String] {
        var result = environment
        result["TRIANGLE_IDENTITY_ROOT"] = try isolatedIdentityRoot(for: credential, environment: environment)
        return result
    }

    static func requireIsolatedIdentityRoot(_ identityRoot: URL, from environment: [String: String]) throws {
        // APFS is case-insensitive by default: compare case-folded paths so a
        // differently capitalized model root cannot hide an overlap.
        func canonical(_ path: String) -> String {
            URL(fileURLWithPath: path, isDirectory: true).resolvingSymlinksInPath().standardizedFileURL.path.lowercased()
        }
        func overlaps(_ left: String, _ right: String) -> Bool {
            left == right || left.hasPrefix(right == "/" ? "/" : right + "/") || right.hasPrefix(left == "/" ? "/" : left + "/")
        }
        let identity = canonical(identityRoot.path)
        for key in sandboxRootKeys {
            guard let value = environment[key] else { continue }
            for entry in value.split(separator: ":").map(String.init) where entry.hasPrefix("/") {
                if overlaps(identity, canonical(entry)) { throw WorkerLauncherError.unsafeInstallation }
            }
        }
    }
}

public struct FileWorkerCommandResolver: WorkerCommandResolving, ClientSupervisorCommandResolving {
    private static let allowedEnvironment: Set<String> = [
        "PATH", "LANG", "LC_ALL", "NO_COLOR",
        "TRIANGLE_PROJECT_ROOT", "TRIANGLE_RUNTIME_ROOTS", "CODEX_CLI", "HERMES_CLI", "ANTIGRAVITY_CLI",
    ]
    private let applicationRoot: URL

    private static func artifactPaths(for worker: WorkerKind, manifestVersion: Int) -> Set<String>? {
        let legacy = Set([
            "packages/agent-worker/src/cli.mjs",
            "packages/agent-worker/src/command-runner.mjs",
            "packages/agent-worker/src/mailbox-client.mjs",
            "packages/agent-worker/src/runtime.mjs",
            "packages/agent-worker/runners/runner-common.mjs",
            "packages/agent-worker/runners/\(worker.rawValue)-runner.mjs",
            "agents/\(worker.rawValue)/worker/agent-worker.json",
        ])
        if manifestVersion == 3 { return legacy }
        if manifestVersion == 4 {
            return legacy.union([
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
            ])
        }
        if (5...9).contains(manifestVersion) {
            var artifacts = legacy.union([
                "packages/agent-worker/src/authenticated-app-server-transport.mjs",
                "packages/agent-worker/src/client-supervisor-cli.mjs",
                "packages/agent-worker/src/client-supervisor.mjs",
                "packages/agent-worker/src/claimer-cross-runtime.mjs",
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
            ])
            // v6 schema extraction; v5 bundles omit it.
            if manifestVersion >= 6 {
                artifacts.insert("packages/agent-worker/src/client-supervisor-schema.mjs")
            }
            // v7 headless ownership recovery; v5/v6 helpers keep exact-set match.
            if manifestVersion >= 7 {
                artifacts.insert("packages/agent-worker/src/claimer-advisory-lock.mjs")
                artifacts.insert("packages/agent-worker/src/open-transaction-recovery.mjs")
            }
            // v8 (permissions v1): the workload-key credential loader and the
            // shared triangle-cli protocol core the mailbox client imports.
            if manifestVersion >= 8 {
                artifacts.formUnion([
                    "packages/agent-worker/src/workload-credential.mjs",
                    "packages/triangle-cli/src/canonical.mjs",
                    "packages/triangle-cli/src/errors.mjs",
                    "packages/triangle-cli/src/keys.mjs",
                    "packages/triangle-cli/src/protocol.mjs",
                    "packages/triangle-cli/src/workload.mjs",
                ])
            }
            // v9 installs local agent messaging; earlier exact sets remain valid.
            if manifestVersion >= 9 {
                artifacts.formUnion([
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
                ])
            }
            // The coordinator can run from any worker bundle and imports
            // codex-runtime, so v7 requires it everywhere (v5/v6: codex only).
            if worker == .codex || manifestVersion >= 7 {
                artifacts.formUnion([
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
                ])
            }
            return artifacts
        }
        return nil
    }

    public init(applicationRoot: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)) {
        self.applicationRoot = applicationRoot
    }

    public func resolve(_ worker: WorkerKind, instance: ClientInstance) throws -> WorkerCommand {
        let expectedAdapter: RuntimeAdapter = worker == .codex ? .codex : (worker == .hermes ? .hermes : .antigravity)
        guard instance.runtimeAdapter == expectedAdapter,
              instance.instanceID == .derive(profile: instance.profile)
        else { throw WorkerLauncherError.invalidManifest }
        let root = try checkedDirectory(applicationRoot, exactMode: 0o700)
        let runtime = try checkedDirectory(root.appendingPathComponent("worker-runtime", isDirectory: true), exactMode: 0o700)
        let bundles = try checkedDirectory(runtime.appendingPathComponent("bundles", isDirectory: true), exactMode: 0o700)
        let credentialRoot = try checkedDirectory(root.appendingPathComponent("credentials", isDirectory: true), exactMode: 0o700)
        let manifestURL = runtime.appendingPathComponent("\(worker.rawValue).manifest.json")
        try checkedFile(manifestURL, beneath: runtime, exactMode: 0o600, executable: false)
        let data = try boundedRead(manifestURL, maximum: 32 * 1024)
        let manifest: WorkerInstallManifest
        do { manifest = try JSONDecoder().decode(WorkerInstallManifest.self, from: data) }
        catch { throw WorkerLauncherError.invalidManifest }
        let requiredReleaseEnvironment: Set<String> = [
            "PATH", "LANG", "LC_ALL", "TRIANGLE_PROJECT_ROOT", "TRIANGLE_RUNTIME_ROOTS",
            worker == .codex ? "CODEX_CLI" : (worker == .hermes ? "HERMES_CLI" : "ANTIGRAVITY_CLI"),
        ]
        let inactiveCLIs: [String] = {
            switch worker {
            case .codex: return ["HERMES_CLI", "ANTIGRAVITY_CLI"]
            case .hermes: return ["CODEX_CLI", "ANTIGRAVITY_CLI"]
            case .antigravity: return ["CODEX_CLI", "HERMES_CLI"]
            }
        }()
        guard let requiredArtifacts = Self.artifactPaths(for: worker, manifestVersion: manifest.version),
              Set(manifest.environment.keys) == requiredReleaseEnvironment,
              Set(manifest.environment.keys).isSubset(of: Self.allowedEnvironment),
              manifest.environment["TRIANGLE_PROJECT_ROOT"] == manifest.projectRoot,
              Set(manifest.artifacts.keys) == requiredArtifacts,
              !manifest.environment.keys.contains(where: { $0.hasPrefix("MESH_") || $0.hasSuffix("_AGENT_ID") }),
              inactiveCLIs.allSatisfy({ manifest.environment[$0] == nil }),
              manifest.environment.values.allSatisfy({ !$0.contains("\0") && !$0.contains("\n") && !$0.contains("\r") })
        else { throw WorkerLauncherError.invalidManifest }

        let project = URL(fileURLWithPath: manifest.projectRoot, isDirectory: true)
        let canonicalProject = try checkedDirectory(project, exactMode: 0o700)
        guard canonicalProject.deletingLastPathComponent().path == bundles.path,
              canonicalProject.lastPathComponent.count == 64,
              canonicalProject.lastPathComponent.allSatisfy({ $0.isHexDigit && !$0.isUppercase })
        else { throw WorkerLauncherError.unsafeInstallation }
        let node = canonicalProject.appendingPathComponent("bin/node")
        guard manifest.environment["PATH"]?.split(separator: ":", omittingEmptySubsequences: false).first.map(String.init) == manifest.projectRoot + "/bin"
        else { throw WorkerLauncherError.invalidManifest }
        try checkedFile(node, beneath: canonicalProject, exactMode: 0o500, executable: true)
        try verifyHash(node, expected: manifest.nodeSHA256)
        for (relative, expectedHash) in manifest.artifacts {
            let artifact = canonicalProject.appendingPathComponent(relative)
            try checkedFile(artifact, beneath: canonicalProject, exactMode: 0o600, executable: false)
            try verifyHash(artifact, expected: expectedHash)
        }
        let addressLines = [worker.rawValue, manifest.nodeSHA256] + manifest.artifacts.keys.sorted().map { "\($0)=\(manifest.artifacts[$0]!)" }
        let address = SHA256.hash(data: Data((addressLines.joined(separator: "\n") + "\n").utf8)).map { String(format: "%02x", $0) }.joined()
        guard canonicalProject.lastPathComponent == address else { throw WorkerLauncherError.integrityMismatch }
        let script = canonicalProject.appendingPathComponent("packages/agent-worker/src/cli.mjs")
        let config = canonicalProject.appendingPathComponent("agents/\(worker.rawValue)/worker/agent-worker.json")
        let home = root.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard root.path == home.appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true).path else {
            throw WorkerLauncherError.unsafeInstallation
        }
        let modelStateBase = try ensureOwnedDirectory(root.appendingPathComponent("model-state", isDirectory: true), exactMode: 0o700)
        let modelInstances = try ensureOwnedDirectory(modelStateBase.appendingPathComponent("instances", isDirectory: true), exactMode: 0o700)
        let modelRoot = try ensureOwnedDirectory(modelInstances.appendingPathComponent(instance.instanceID.value, isDirectory: true), exactMode: 0o700)
        let library = try checkedDirectory(home.appendingPathComponent("Library", isDirectory: true), exactMode: nil)
        let caches = try ensureOwnedDirectory(library.appendingPathComponent("Caches", isDirectory: true), exactMode: nil)
        let triangleCaches = try ensureOwnedDirectory(caches.appendingPathComponent("The Triangle", isDirectory: true), exactMode: 0o700)
        let cacheInstances = try ensureOwnedDirectory(triangleCaches.appendingPathComponent("instances", isDirectory: true), exactMode: 0o700)
        let instanceTemp = try ensureOwnedDirectory(cacheInstances.appendingPathComponent(instance.instanceID.value, isDirectory: true), exactMode: 0o700)
        var trustedEnvironment = manifest.environment
        trustedEnvironment["HOME"] = home.path
        trustedEnvironment["TRIANGLE_CREDENTIAL_ROOT"] = credentialRoot.path
        trustedEnvironment["TRIANGLE_MODEL_STATE_BASE"] = modelStateBase.path
        trustedEnvironment["TRIANGLE_MODEL_ROOTS"] = modelRoot.path
        trustedEnvironment["TRIANGLE_INSTANCE_ID"] = instance.instanceID.value
        trustedEnvironment["TRIANGLE_INSTANCE_TEMP_ROOT"] = instanceTemp.path
        trustedEnvironment[worker == .codex ? "CODEX_HOME" : (worker == .hermes ? "HERMES_HOME" : "ANTIGRAVITY_HOME")] = modelRoot.path
        if worker == .hermes {
            try provisionHermesEnvironment(home: home, modelRoot: modelRoot)
        }
        if worker == .antigravity {
            // agy writes its signed-in session (antigravity-cli) and project
            // config (config) under ~/.gemini; both are installer runtime roots.
            var writable: [String] = []
            for name in ["antigravity-cli", "config"] {
                let state = home.appendingPathComponent(".gemini/\(name)", isDirectory: true)
                if FileManager.default.fileExists(atPath: state.path) {
                    writable.append(try checkedDirectory(state, exactMode: nil).path)
                }
            }
            if !writable.isEmpty {
                trustedEnvironment["TRIANGLE_WRITABLE_RUNTIME_ROOTS"] = writable.joined(separator: ":")
            }
        }
        return WorkerCommand(
            executable: node,
            arguments: [script.path, "--config", config.path, "--watch"],
            workingDirectory: canonicalProject,
            environment: trustedEnvironment
        )
    }

    public func resolveAdapter(for instance: ClientInstance) throws -> WorkerCommand {
        // grok-bot has no headless runner; wake is host-side (webhook), not worker polling.
        if instance.runtimeAdapter == .grokBot { throw WorkerLauncherError.invalidManifest }
        // cursor-acp has no worker-polling runner; it is served by the
        // supervisor's headless drain (see resolveCursorAcpDrain). It must
        // never fall through to the antigravity worker check.
        if instance.runtimeAdapter == .cursorAcp { throw WorkerLauncherError.invalidManifest }
        let worker: WorkerKind
        switch instance.runtimeAdapter {
        case .codex: worker = .codex
        case .hermes: worker = .hermes
        case .antigravity: worker = .antigravity
        case .grokBot, .cursorAcp: throw WorkerLauncherError.invalidManifest
        }
        let base = try resolve(worker, instance: instance)
        let runner = base.workingDirectory.appendingPathComponent("packages/agent-worker/runners/\(worker.rawValue)-runner.mjs")
        try checkedFile(runner, beneath: base.workingDirectory, exactMode: 0o600, executable: false)
        return WorkerCommand(
            executable: base.executable,
            arguments: [runner.path],
            workingDirectory: base.workingDirectory,
            environment: base.environment
        )
    }

    /// Readiness used by `triangle-client agent add|enable`. cursor-acp
    /// profiles are checked against the headless drain runtime the
    /// supervisor launches; every other adapter keeps `resolveAdapter`.
    public func checkRuntimeReadiness(for instance: ClientInstance) throws {
        if instance.runtimeAdapter == .cursorAcp {
            _ = try resolveCursorAcpDrain(for: instance)
        } else {
            _ = try resolveAdapter(for: instance)
        }
    }

    /// Resolves the integrity-verified cursor-acp headless drain shipped in an
    /// installed supervisor-capable worker bundle (manifest v5+, which carries
    /// `packages/agent-worker/src/cursor-acp-runtime/*`). The Cursor `agent`
    /// CLI itself is pinned per install in cursor-acp-runtime-binding.json and
    /// validated by ClientSupervisor when the drain is bootstrapped.
    /// A harness-independent v8 host. Its content address uses "supervisor",
    /// and its environment contains no worker selectors or credentials.
    private func resolveSupervisorHost(script: String) throws -> WorkerCommand {
        let root = try checkedDirectory(applicationRoot, exactMode: 0o700)
        let runtime = try checkedDirectory(root.appendingPathComponent("worker-runtime"), exactMode: 0o700)
        let bundles = try checkedDirectory(runtime.appendingPathComponent("bundles"), exactMode: 0o700)
        let manifestURL = runtime.appendingPathComponent("supervisor.manifest.json")
        try checkedFile(manifestURL, beneath: runtime, exactMode: 0o600, executable: false)
        let manifest: WorkerInstallManifest
        do { manifest = try JSONDecoder().decode(WorkerInstallManifest.self, from: boundedRead(manifestURL, maximum: 32 * 1024)) }
        catch { throw WorkerLauncherError.invalidManifest }
        let required = Self.artifactPaths(for: .codex, manifestVersion: manifest.version)?.subtracting([
            "packages/agent-worker/runners/codex-runner.mjs", "agents/codex/worker/agent-worker.json",
        ])
        guard (8...9).contains(manifest.version), let required, Set(manifest.artifacts.keys) == required,
              manifest.environment == ["PATH": manifest.projectRoot + "/bin:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"]
        else { throw WorkerLauncherError.invalidManifest }
        let project = try checkedDirectory(URL(fileURLWithPath: manifest.projectRoot), exactMode: 0o700)
        guard project.deletingLastPathComponent().path == bundles.path else { throw WorkerLauncherError.unsafeInstallation }
        let node = project.appendingPathComponent("bin/node")
        try checkedFile(node, beneath: project, exactMode: 0o500, executable: true)
        try verifyHash(node, expected: manifest.nodeSHA256)
        for (relative, hash) in manifest.artifacts {
            let file = project.appendingPathComponent(relative)
            try checkedFile(file, beneath: project, exactMode: 0o600, executable: false)
            try verifyHash(file, expected: hash)
        }
        // Reject extra files, symlinks and unsafe directories, including entries
        // not named in the manifest; do not let an untracked module be loaded.
        var actual = Set<String>()
        func inspect(_ directory: URL, prefix: String = "") throws {
            _ = try checkedDirectory(directory, exactMode: 0o700)
            for child in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
                var metadata = stat()
                guard lstat(child.path, &metadata) == 0 else { throw WorkerLauncherError.unsafeInstallation }
                let relative = prefix + child.lastPathComponent
                if metadata.st_mode & S_IFMT == S_IFDIR { try inspect(child, prefix: relative + "/") }
                else {
                    guard metadata.st_mode & S_IFMT == S_IFREG else { throw WorkerLauncherError.unsafeInstallation }
                    actual.insert(relative)
                }
            }
        }
        try inspect(project)
        guard actual == required.union(["bin/node"]) else { throw WorkerLauncherError.invalidManifest }
        let lines = ["supervisor", manifest.nodeSHA256] + manifest.artifacts.keys.sorted().map { "\($0)=\(manifest.artifacts[$0]!)" }
        let address = SHA256.hash(data: Data((lines.joined(separator: "\n") + "\n").utf8)).map { String(format: "%02x", $0) }.joined()
        guard project.lastPathComponent == address else { throw WorkerLauncherError.integrityMismatch }
        let entry = project.appendingPathComponent(script)
        guard required.contains(script) else { throw WorkerLauncherError.invalidManifest }
        return WorkerCommand(executable: node, arguments: [entry.path], workingDirectory: project, environment: manifest.environment)
    }

    private var hasSupervisorManifest: Bool {
        var metadata = stat()
        return lstat(applicationRoot.appendingPathComponent("worker-runtime/supervisor.manifest.json").path, &metadata) == 0
    }

    public func resolveCursorAcpDrain(for instance: ClientInstance) throws -> WorkerCommand {
        guard instance.runtimeAdapter == .cursorAcp,
              instance.instanceID == .derive(profile: instance.profile)
        else { throw WorkerLauncherError.invalidManifest }
        if hasSupervisorManifest {
            return try resolveSupervisorHost(script: "packages/agent-worker/src/cursor-acp-runtime/headless-drain-service.mjs")
        }
        let runtime = try checkedDirectory(applicationRoot.appendingPathComponent("worker-runtime", isDirectory: true), exactMode: 0o700)
        var lastError: Error = WorkerLauncherError.invalidManifest
        for worker in [WorkerKind.codex, .antigravity, .hermes] {
            guard FileManager.default.fileExists(atPath: runtime.appendingPathComponent("\(worker.rawValue).manifest.json").path) else { continue }
            let adapter: RuntimeAdapter = worker == .codex ? .codex : (worker == .hermes ? .hermes : .antigravity)
            do {
                let host = try ClientInstance(profile: instance.profile, runtimeAdapter: adapter)
                // Full manifest, hash, and content-address verification.
                let base = try resolve(worker, instance: host)
                let drain = base.workingDirectory.appendingPathComponent("packages/agent-worker/src/cursor-acp-runtime/headless-drain-service.mjs")
                try checkedFile(drain, beneath: base.workingDirectory, exactMode: 0o600, executable: false)
                let supervisor = base.workingDirectory.appendingPathComponent("packages/agent-worker/src/client-supervisor-cli.mjs")
                try checkedFile(supervisor, beneath: base.workingDirectory, exactMode: 0o600, executable: false)
                var environment: [String: String] = [:]
                for key in ["PATH", "LANG", "LC_ALL", "NO_COLOR"] {
                    if let value = base.environment[key] { environment[key] = value }
                }
                return WorkerCommand(
                    executable: base.executable,
                    arguments: [drain.path],
                    workingDirectory: base.workingDirectory,
                    environment: environment
                )
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    public func resolveCoordinator(for instances: [ClientInstance]) throws -> WorkerCommand {
        guard !instances.isEmpty else { throw WorkerLauncherError.invalidManifest }
        if hasSupervisorManifest {
            return try resolveSupervisorHost(script: "packages/agent-worker/src/client-supervisor-cli.mjs")
        }
        var attempted = Set<WorkerKind>()
        for instance in instances {
            guard let worker = WorkerKind(rawValue: instance.runtimeAdapter.rawValue) else { continue }
            guard attempted.insert(worker).inserted else { continue }
            let base: WorkerCommand
            do { base = try resolve(worker, instance: instance) }
            catch { continue }
            let runtime = try checkedDirectory(applicationRoot.appendingPathComponent("worker-runtime", isDirectory: true), exactMode: 0o700)
            let manifestURL = runtime.appendingPathComponent("\(worker.rawValue).manifest.json")
            try checkedFile(manifestURL, beneath: runtime, exactMode: 0o600, executable: false)
            let manifest: WorkerInstallManifest
            do { manifest = try JSONDecoder().decode(WorkerInstallManifest.self, from: boundedRead(manifestURL, maximum: 32 * 1024)) }
            catch { throw WorkerLauncherError.invalidManifest }
            guard manifest.version >= 4 else { continue }
            let script = base.workingDirectory.appendingPathComponent("packages/agent-worker/src/client-supervisor-cli.mjs")
            try checkedFile(script, beneath: base.workingDirectory, exactMode: 0o600, executable: false)
            var environment: [String: String] = [:]
            for key in ["PATH", "LANG", "LC_ALL", "NO_COLOR"] {
                if let value = base.environment[key] { environment[key] = value }
            }
            return WorkerCommand(
                executable: base.executable,
                arguments: [script.path],
                workingDirectory: base.workingDirectory,
                environment: environment
            )
        }
        if attempted.isEmpty {
            for worker in WorkerKind.allCases {
                let runtime = try checkedDirectory(applicationRoot.appendingPathComponent("worker-runtime", isDirectory: true), exactMode: 0o700)
                let manifestURL = runtime.appendingPathComponent("\(worker.rawValue).manifest.json")
                guard FileManager.default.fileExists(atPath: manifestURL.path) else { continue }
                guard let manifest = try? JSONDecoder().decode(WorkerInstallManifest.self, from: boundedRead(manifestURL, maximum: 32 * 1024)),
                      manifest.version >= 4
                else { continue }
                let adapter: RuntimeAdapter = worker == .codex ? .codex : (worker == .hermes ? .hermes : .antigravity)
                let host = try ClientInstance(profile: instances[0].profile, runtimeAdapter: adapter)
                guard let base = try? resolve(worker, instance: host) else { continue }
                let script = base.workingDirectory.appendingPathComponent("packages/agent-worker/src/client-supervisor-cli.mjs")
                try checkedFile(script, beneath: base.workingDirectory, exactMode: 0o600, executable: false)
                let environment = base.environment.filter { ["PATH", "LANG", "LC_ALL", "NO_COLOR"].contains($0.key) }
                return WorkerCommand(executable: base.executable, arguments: [script.path], workingDirectory: base.workingDirectory, environment: environment)
            }
        }
        throw WorkerLauncherError.invalidManifest
    }

    private func ensureOwnedDirectory(_ url: URL, exactMode: mode_t?) throws -> URL {
        guard url.standardizedFileURL.path == url.path else { throw WorkerLauncherError.unsafeInstallation }
        // mkdir applies private permissions atomically. Foundation may create
        // the directory before applying its attributes, exposing a transient
        // mode to another resolver racing to validate the same shared parent.
        let result = url.path.withCString { Darwin.mkdir($0, exactMode ?? 0o700) }
        guard result == 0 || errno == EEXIST else { throw WorkerLauncherError.unsafeInstallation }
        // A concurrent creator is accepted only after the same complete
        // nonsymlink, owner and mode checks as a newly created directory.
        return try checkedDirectory(url, exactMode: exactMode)
    }

    private func checkedDirectory(_ url: URL, exactMode: mode_t?) throws -> URL {
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        guard canonical.path == url.standardizedFileURL.path else { throw WorkerLauncherError.unsafeInstallation }
        var metadata = stat()
        guard lstat(url.path, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == getuid(),
              exactMode.map({ metadata.st_mode & 0o777 == $0 }) ?? ((metadata.st_mode & 0o022) == 0)
        else { throw WorkerLauncherError.unsafeInstallation }
        return canonical
    }

    private func checkedFile(_ url: URL, beneath root: URL, exactMode: mode_t?, executable: Bool) throws {
        guard url.path.hasPrefix("/"), isBeneath(url, root: root) else { throw WorkerLauncherError.unsafeInstallation }
        var current = root
        let relative = String(url.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count + 1))
        let components = relative.split(separator: "/").map(String.init)
        for (index, component) in components.enumerated() {
            current.appendPathComponent(component)
            var componentStat = stat()
            guard lstat(current.path, &componentStat) == 0, (componentStat.st_mode & S_IFMT) != S_IFLNK else {
                throw WorkerLauncherError.unsafeInstallation
            }
            if index < components.count - 1 {
                guard (componentStat.st_mode & S_IFMT) == S_IFDIR,
                      componentStat.st_uid == getuid(), componentStat.st_mode & 0o777 == 0o700
                else { throw WorkerLauncherError.unsafeInstallation }
            }
        }
        var metadata = stat()
        guard lstat(url.path, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == getuid(),
              exactMode.map({ metadata.st_mode & 0o777 == $0 }) ?? ((metadata.st_mode & 0o022) == 0),
              !executable || access(url.path, X_OK) == 0
        else { throw WorkerLauncherError.unsafeInstallation }
    }

    private func isBeneath(_ child: URL, root: URL) -> Bool {
        let childPath = child.standardizedFileURL.path
        let rootPath = root.standardizedFileURL.path
        return childPath.hasPrefix(rootPath + "/")
    }

    private func boundedRead(_ url: URL, maximum: Int) throws -> Data {
        let handle: FileHandle
        do { handle = try FileHandle(forReadingFrom: url) } catch { throw WorkerLauncherError.unsafeInstallation }
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximum + 1) ?? Data()
        guard data.count <= maximum else { throw WorkerLauncherError.invalidManifest }
        return data
    }

    private func verifyHash(_ url: URL, expected: String) throws {
        guard expected.wholeMatch(of: /^[a-f0-9]{64}$/) != nil else { throw WorkerLauncherError.invalidManifest }
        let digest = SHA256.hash(data: try boundedRead(url, maximum: 128 * 1024 * 1024))
        let actual = digest.map { String(format: "%02x", $0) }.joined()
        guard actual == expected else { throw WorkerLauncherError.integrityMismatch }
    }

    private func provisionHermesEnvironment(home: URL, modelRoot: URL) throws {
        let destination = modelRoot.appendingPathComponent(".env")
        var destinationMetadata = stat()
        if lstat(destination.path, &destinationMetadata) == 0 {
            guard (destinationMetadata.st_mode & S_IFMT) == S_IFREG,
                  destinationMetadata.st_uid == getuid(),
                  destinationMetadata.st_mode & 0o777 == 0o600
            else { throw WorkerLauncherError.unsafeInstallation }
            return
        }
        let source = home.appendingPathComponent(".hermes/.env")
        var sourceMetadata = stat()
        guard lstat(source.path, &sourceMetadata) == 0,
              (sourceMetadata.st_mode & S_IFMT) == S_IFREG,
              sourceMetadata.st_uid == getuid(),
              sourceMetadata.st_mode & 0o777 == 0o600
        else { return }
        let temporary = modelRoot.appendingPathComponent(".env-\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw WorkerLauncherError.unsafeInstallation }
        defer { close(descriptor) }
        let sourceHandle = try FileHandle(forReadingFrom: source)
        defer { try? sourceHandle.close() }
        let payload = try sourceHandle.read(upToCount: 256 * 1024) ?? Data()
        guard payload.count <= 256 * 1024 else { throw WorkerLauncherError.unsafeInstallation }
        try payload.withUnsafeBytes { raw in
            var offset = 0
            while offset < payload.count {
                let count = Darwin.write(descriptor, raw.baseAddress!.advanced(by: offset), payload.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw WorkerLauncherError.unsafeInstallation }
                offset += count
            }
        }
        guard fsync(descriptor) == 0 else { throw WorkerLauncherError.unsafeInstallation }
        guard rename(temporary.path, destination.path) == 0 else {
            unlink(temporary.path)
            throw WorkerLauncherError.unsafeInstallation
        }
    }
}

private struct WorkerInstallManifest: Decodable {
    let version: Int
    let nodeSHA256: String
    let projectRoot: String
    let environment: [String: String]
    let artifacts: [String: String]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version, nodeSHA256, projectRoot, environment, artifacts
    }
    private struct AnyKey: CodingKey { let stringValue: String; let intValue: Int?; init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }; init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue } }
    init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: AnyKey.self)
        guard Set(all.allKeys.map(\.stringValue)) == Set(CodingKeys.allCases.map(\.rawValue)) else { throw WorkerLauncherError.invalidManifest }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        nodeSHA256 = try values.decode(String.self, forKey: .nodeSHA256)
        projectRoot = try values.decode(String.self, forKey: .projectRoot); environment = try values.decode([String: String].self, forKey: .environment)
        artifacts = try values.decode([String: String].self, forKey: .artifacts)
    }
}

public struct ExecWorkerExecutor: WorkerExecuting {
    public init() {}
    public func execute(_ request: WorkerExecutionRequest) throws {
        let argvValues = [request.executable.path] + request.arguments
        let envValues = request.environment.sorted(by: { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }
        var argv = argvValues.map { strdup($0) as UnsafeMutablePointer<CChar>? } + [nil]
        var envp = envValues.map { strdup($0) as UnsafeMutablePointer<CChar>? } + [nil]
        defer {
            for pointer in argv { if let pointer { Darwin.free(UnsafeMutableRawPointer(pointer)) } }
            for pointer in envp { if let pointer { Darwin.free(UnsafeMutableRawPointer(pointer)) } }
        }
        guard chdir(request.workingDirectory.path) == 0 else { throw WorkerLauncherError.executionFailed }
        _ = request.executable.path.withCString { path in execve(path, &argv, &envp) }
        throw WorkerLauncherError.executionFailed
    }
}
