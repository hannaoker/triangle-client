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
        let adapter: RuntimeAdapter = worker == .codex ? .codex : .hermes
        let instance = try ClientInstance(profile: profile, runtimeAdapter: adapter)
        let command = try resolver.resolve(worker, instance: instance)
        let credential = try await gate.credential(for: profile)
        var environment = command.environment
        environment.keys.filter { key in
            key.hasPrefix("MESH_") || key == "CODEX_AGENT_ID" || key == "HERMES_AGENT_ID"
        }.forEach { environment.removeValue(forKey: $0) }
        environment["MESH_ORIGIN"] = credential.origin.value
        environment["MESH_AGENT_TOKEN"] = credential.binding.token.secretValue
        environment[worker == .codex ? "CODEX_AGENT_ID" : "HERMES_AGENT_ID"] = credential.agentID.value
        try executor.execute(WorkerExecutionRequest(
            executable: command.executable,
            arguments: command.arguments,
            workingDirectory: command.workingDirectory,
            environment: environment
        ))
    }
}

public struct FileWorkerCommandResolver: WorkerCommandResolving, ClientSupervisorCommandResolving {
    private static let allowedEnvironment: Set<String> = [
        "PATH", "LANG", "LC_ALL", "NO_COLOR",
        "TRIANGLE_PROJECT_ROOT", "TRIANGLE_RUNTIME_ROOTS", "CODEX_CLI", "HERMES_CLI",
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
            "\(worker.rawValue)/worker/agent-worker.json",
        ])
        if manifestVersion == 3 { return legacy }
        if manifestVersion == 4 {
            return legacy.union([
                "packages/agent-worker/src/client-supervisor-cli.mjs",
                "packages/agent-worker/src/client-supervisor.mjs",
                "packages/agent-worker/src/concurrency-gate.mjs",
            ])
        }
        return nil
    }

    public init(applicationRoot: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)) {
        self.applicationRoot = applicationRoot
    }

    public func resolve(_ worker: WorkerKind, instance: ClientInstance) throws -> WorkerCommand {
        let expectedAdapter: RuntimeAdapter = worker == .codex ? .codex : .hermes
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
            worker == .codex ? "CODEX_CLI" : "HERMES_CLI",
        ]
        guard let requiredArtifacts = Self.artifactPaths(for: worker, manifestVersion: manifest.version),
              Set(manifest.environment.keys) == requiredReleaseEnvironment,
              Set(manifest.environment.keys).isSubset(of: Self.allowedEnvironment),
              manifest.environment["TRIANGLE_PROJECT_ROOT"] == manifest.projectRoot,
              Set(manifest.artifacts.keys) == requiredArtifacts,
              !manifest.environment.keys.contains(where: { $0.hasPrefix("MESH_") || $0.hasSuffix("_AGENT_ID") }),
              worker == .codex
                ? manifest.environment["HERMES_CLI"] == nil
                : manifest.environment["CODEX_CLI"] == nil,
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
        let config = canonicalProject.appendingPathComponent("\(worker.rawValue)/worker/agent-worker.json")
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
        trustedEnvironment[worker == .codex ? "CODEX_HOME" : "HERMES_HOME"] = modelRoot.path
        return WorkerCommand(
            executable: node,
            arguments: [script.path, "--config", config.path, "--watch"],
            workingDirectory: canonicalProject,
            environment: trustedEnvironment
        )
    }

    public func resolveAdapter(for instance: ClientInstance) throws -> WorkerCommand {
        let worker: WorkerKind = instance.runtimeAdapter == .codex ? .codex : .hermes
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

    public func resolveCoordinator(for instances: [ClientInstance]) throws -> WorkerCommand {
        guard !instances.isEmpty else { throw WorkerLauncherError.invalidManifest }
        var attempted = Set<WorkerKind>()
        for instance in instances {
            let worker: WorkerKind = instance.runtimeAdapter == .codex ? .codex : .hermes
            guard attempted.insert(worker).inserted else { continue }
            let base = try resolve(worker, instance: instance)
            let runtime = try checkedDirectory(applicationRoot.appendingPathComponent("worker-runtime", isDirectory: true), exactMode: 0o700)
            let manifestURL = runtime.appendingPathComponent("\(worker.rawValue).manifest.json")
            try checkedFile(manifestURL, beneath: runtime, exactMode: 0o600, executable: false)
            let manifest: WorkerInstallManifest
            do { manifest = try JSONDecoder().decode(WorkerInstallManifest.self, from: boundedRead(manifestURL, maximum: 32 * 1024)) }
            catch { throw WorkerLauncherError.invalidManifest }
            guard manifest.version == 4 else { continue }
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
        throw WorkerLauncherError.invalidManifest
    }

    private func ensureOwnedDirectory(_ url: URL, exactMode: mode_t?) throws -> URL {
        guard url.standardizedFileURL.path == url.path else { throw WorkerLauncherError.unsafeInstallation }
        do {
            try FileManager.default.createDirectory(
                at: url,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: exactMode ?? 0o700]
            )
        } catch {
            // Another resolver may have won the first-create race. Treat only a
            // fully revalidated, application-owned directory as success.
            do { return try checkedDirectory(url, exactMode: exactMode) }
            catch { throw WorkerLauncherError.unsafeInstallation }
        }
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
