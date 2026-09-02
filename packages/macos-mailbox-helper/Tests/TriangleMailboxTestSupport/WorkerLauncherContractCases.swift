import CryptoKit
import Foundation
@_spi(EnrollmentTesting) import TriangleMailboxCore

public enum WorkerLauncherContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }
    public static let all: [ContractCase] = [
        .init(name: "closed worker kinds receive exact credential environment", run: exactEnvironment),
        .init(name: "ambient credentials and selectors are replaced", run: inheritedSecretsAreReplaced),
        .init(name: "credential never enters worker arguments", run: noSecretInArguments),
        .init(name: "ineligible credential gate never executes", run: gateFailureNeverExecutes),
        .init(name: "resolver is validated before credential release", run: resolverFailureNeverRequestsCredential),
        .init(name: "launcher resolves the exact profile-derived instance", run: exactInstanceSelection),
        .init(name: "worker resolver contract cannot discard instance identity", run: { try instanceIsMandatoryContract() }),
        .init(name: "filesystem resolver rejects unsafe manifests and artifacts", run: { try resolverSafety() }),
        .init(name: "helper-only upgrade resolves exact legacy version-3 runtime", run: { try legacyVersionThreeRuntimeResolves() }),
        .init(name: "legacy version-3 runtime cannot host the shared supervisor", run: { try legacyVersionThreeCannotHostSupervisor() }),
        .init(name: "shared runtime release resolves isolated opaque instance state", run: { try instanceStateIsolation() }),
        .init(name: "concurrent fresh instance resolution is idempotent", run: concurrentFreshRootResolution),
        .init(name: "clean installed runtime resolves and passes Node syntax smoke", run: { try installedBundleResolvesAndSmokes() }),
    ]
    private static let token = "mesh_" + String(repeating: "7", count: 64)
    private static let agentID = "agent_" + String(repeating: "8", count: 32)

    public static func exactEnvironment() async throws {
        for worker in WorkerKind.allCases {
            let executor = RecordingWorkerExecutor()
            let command = WorkerCommand(
                executable: URL(fileURLWithPath: "/trusted/node"),
                arguments: ["/trusted/cli.mjs", "--config", "/trusted/\(worker.rawValue).json", "--watch"],
                workingDirectory: URL(fileURLWithPath: "/trusted"),
                environment: ["PATH": "/trusted/bin", "TRIANGLE_PROJECT_ROOT": "/trusted"]
            )
            let launcher = WorkerLauncher(gate: try gate(), resolver: FixedWorkerResolver(command), executor: executor)
            try await launcher.launch(profile: ProfileName("codex-mailbox-live"), worker: worker, inheritedEnvironment: [:])
            let request = try require(executor.request, "worker was not executed")
            try expect(request.environment["MESH_ORIGIN"] == "https://thetriangle.dev", "origin not exact")
            try expect(request.environment["MESH_AGENT_TOKEN"] == token, "token not exact")
            let expected = worker == .codex ? "CODEX_AGENT_ID" : (worker == .hermes ? "HERMES_AGENT_ID" : "ANTIGRAVITY_AGENT_ID")
            let inactiveKeys: [String] = {
                switch worker {
                case .codex: return ["HERMES_AGENT_ID", "ANTIGRAVITY_AGENT_ID"]
                case .hermes: return ["CODEX_AGENT_ID", "ANTIGRAVITY_AGENT_ID"]
                case .antigravity: return ["CODEX_AGENT_ID", "HERMES_AGENT_ID"]
                }
            }()
            try expect(request.environment[expected] == agentID, "agent ID not exact")
            for inactive in inactiveKeys {
                try expect(request.environment[inactive] == nil, "inactive agent ID remained")
            }
        }
    }

    public static func inheritedSecretsAreReplaced() async throws {
        let executor = RecordingWorkerExecutor()
        let command = WorkerCommand(
            executable: URL(fileURLWithPath: "/trusted/node"), arguments: ["/trusted/cli.mjs", "--watch"],
            workingDirectory: URL(fileURLWithPath: "/trusted"), environment: ["PATH": "/trusted/bin", "TRIANGLE_PROJECT_ROOT": "/trusted"]
        )
        let ambient = [
            "MESH_ORIGIN": "https://evil.example", "MESH_AGENT_TOKEN": "stolen",
            "MESH_OTHER_SELECTOR": "bad", "CODEX_AGENT_ID": "bad", "HERMES_AGENT_ID": "bad", "ANTIGRAVITY_AGENT_ID": "bad",
            "TRIANGLE_PROJECT_ROOT": "/evil", "TRIANGLE_CREDENTIAL_ROOT": "/evil/credentials",
            "PATH": "/evil/bin", "UNRELATED_SECRET": "must-not-pass",
        ]
        try await WorkerLauncher(gate: try gate(), resolver: FixedWorkerResolver(command), executor: executor)
            .launch(profile: ProfileName("codex-mailbox-live"), worker: .codex, inheritedEnvironment: ambient)
        let env = try require(executor.request, "worker missing").environment
        try expect(env["MESH_ORIGIN"] == "https://thetriangle.dev" && env["MESH_AGENT_TOKEN"] == token, "ambient credential won")
        try expect(env["MESH_OTHER_SELECTOR"] == nil && env["HERMES_AGENT_ID"] == nil && env["ANTIGRAVITY_AGENT_ID"] == nil, "ambient selector survived")
        try expect(env["TRIANGLE_PROJECT_ROOT"] == "/trusted" && env["TRIANGLE_CREDENTIAL_ROOT"] == nil, "caller selected project or credential root")
        try expect(env["PATH"] == "/trusted/bin" && env["UNRELATED_SECRET"] == nil, "ambient environment was inherited")
    }

    public static func noSecretInArguments() async throws {
        let executor = RecordingWorkerExecutor()
        let command = WorkerCommand(executable: URL(fileURLWithPath: "/trusted/node"), arguments: ["/trusted/cli.mjs", "--watch"], workingDirectory: URL(fileURLWithPath: "/trusted"), environment: [:])
        try await WorkerLauncher(gate: try gate(), resolver: FixedWorkerResolver(command), executor: executor)
            .launch(profile: ProfileName("codex-mailbox-live"), worker: .hermes, inheritedEnvironment: [:])
        let request = try require(executor.request, "worker missing")
        try expect(!request.executable.path.contains(token) && request.arguments.allSatisfy { !$0.contains(token) }, "secret entered argv")
    }

    public static func gateFailureNeverExecutes() async throws {
        let executor = RecordingWorkerExecutor()
        let empty = InMemoryCredentialStore()
        let transport = IdentityTransport()
        let gate = VerifiedCredentialGate(store: empty, transport: transport, reservation: InMemoryEnrollmentReservation(), journal: InMemoryEnrollmentJournal())
        let command = WorkerCommand(executable: URL(fileURLWithPath: "/trusted/node"), arguments: [], workingDirectory: URL(fileURLWithPath: "/trusted"), environment: [:])
        do {
            try await WorkerLauncher(gate: gate, resolver: FixedWorkerResolver(command), executor: executor)
                .launch(profile: ProfileName("missing"), worker: .codex, inheritedEnvironment: [:])
            throw WorkerContractFailure("missing gate unexpectedly launched")
        } catch is VerifiedCredentialGateError {}
        try expect(executor.request == nil, "gate failure executed worker")
    }

    public static func resolverFailureNeverRequestsCredential() async throws {
        let events = EventRecorder()
        let binding = CredentialBinding(origin: try MeshOrigin("https://thetriangle.dev"), agentID: try AgentID(agentID), handle: try MailboxHandle("codex-mailbox-live"), token: try MeshToken(token))
        let store = RecordingCredentialStore(binding: binding, events: events)
        let profile = try ProfileName("codex-mailbox-live")
        let journal = InMemoryEnrollmentJournal()
        try journal.write(.testing(profile: profile, origin: binding.origin, state: .verified, agentID: binding.agentID, handle: binding.handle, reasonCode: "identity_verified"))
        let gate = VerifiedCredentialGate(store: store, transport: IdentityTransport(), reservation: InMemoryEnrollmentReservation(), journal: journal)
        do {
            try await WorkerLauncher(gate: gate, resolver: FailingWorkerResolver(events: events), executor: RecordingWorkerExecutor())
                .launch(profile: profile, worker: .codex, inheritedEnvironment: [:])
            throw WorkerContractFailure("unsafe resolver unexpectedly launched")
        } catch is WorkerLauncherError {}
        try expect(events.values == ["resolver"], "credential was requested before resolver validation: \(events.values)")
        try expect(store.readCount == 0, "resolver failure requested a bearer credential")
    }

    public static func exactInstanceSelection() async throws {
        let resolver = RecordingInstanceResolver(command: WorkerCommand(
            executable: URL(fileURLWithPath: "/trusted/node"), arguments: [],
            workingDirectory: URL(fileURLWithPath: "/trusted"), environment: [:]
        ))
        let profile = try ProfileName("exact-profile")
        try await WorkerLauncher(gate: try gate(profile: profile), resolver: resolver, executor: RecordingWorkerExecutor())
            .launch(profile: profile, worker: .codex, inheritedEnvironment: [:])
        let selected = try require(resolver.instance, "resolver did not receive an instance")
        try expect(selected.profile == profile, "launcher selected the wrong profile")
        try expect(selected.instanceID == .derive(profile: profile), "launcher selected the wrong opaque ID")
        try expect(selected.runtimeAdapter == .codex, "launcher selected the wrong runtime adapter")
    }

    public static func instanceIsMandatoryContract() throws {
        var packageRoot = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { packageRoot.deleteLastPathComponent() }
        let source = try String(contentsOf: packageRoot.appendingPathComponent("Sources/TriangleMailboxCore/WorkerLauncher.swift"), encoding: .utf8)
        try expect(!source.contains("func resolve(_ worker: WorkerKind) throws -> WorkerCommand"), "legacy resolver contract can discard instance identity")
        try expect(!source.contains("try resolve(worker)"), "default resolver path discards instance identity")
    }

    public static func resolverSafety() throws {
        let valid = try ResolverFixture(); defer { valid.cleanup() }
        _ = try FileWorkerCommandResolver(applicationRoot: valid.applicationRoot).resolve(.codex, instance: try ClientInstance(profile: ProfileName("safe"), runtimeAdapter: .codex))
        for mutation: (ResolverFixture) throws -> Void in [
            { try $0.withManifestMutation("nodeSHA256", value: String(repeating: "0", count: 64)) },
            { try $0.replaceNodeWithSymlink() },
            { try $0.makeNodeAncestorUnsafe() },
            { try $0.escapeProjectRoot() },
            { try $0.makeManifestGroupWritable() },
        ] {
            let fixture = try ResolverFixture(); defer { fixture.cleanup() }
            try fixture.assertRejected { try mutation(fixture) }
        }
    }

    public static func legacyVersionThreeRuntimeResolves() throws {
        let fixture = try ResolverFixture(manifestVersion: 3); defer { fixture.cleanup() }
        _ = try FileWorkerCommandResolver(applicationRoot: fixture.applicationRoot).resolve(
            .codex,
            instance: try ClientInstance(profile: ProfileName("legacy-safe"), runtimeAdapter: .codex)
        )
    }

    public static func legacyVersionThreeCannotHostSupervisor() throws {
        let fixture = try ResolverFixture(manifestVersion: 3); defer { fixture.cleanup() }
        let instance = try ClientInstance(profile: ProfileName("legacy-supervisor-refused"), runtimeAdapter: .codex)
        do {
            _ = try FileWorkerCommandResolver(applicationRoot: fixture.applicationRoot).resolveCoordinator(for: [instance])
            throw WorkerContractFailure("legacy runtime hosted the shared supervisor")
        } catch is WorkerLauncherError {}
    }

    public static func instanceStateIsolation() throws {
        let fixture = try ResolverFixture(); defer { fixture.cleanup() }
        let resolver = FileWorkerCommandResolver(applicationRoot: fixture.applicationRoot)
        let rawProfile = "研究-agent"
        let first = try ClientInstance(profile: ProfileName(rawProfile), runtimeAdapter: .codex)
        let second = try ClientInstance(profile: ProfileName("second-codex"), runtimeAdapter: .codex)
        let firstCommand = try resolver.resolve(.codex, instance: first)
        let secondCommand = try resolver.resolve(.codex, instance: second)
        try expect(firstCommand.executable == secondCommand.executable, "instances did not share installed Node")
        try expect(firstCommand.workingDirectory == secondCommand.workingDirectory, "instances did not share content-addressed bundle")
        try expect(firstCommand.environment["CODEX_CLI"] == secondCommand.environment["CODEX_CLI"], "instances did not share adapter CLI")
        try expect(firstCommand.environment["CODEX_HOME"] != secondCommand.environment["CODEX_HOME"], "Codex model homes collided")
        try expect(firstCommand.environment["TRIANGLE_INSTANCE_TEMP_ROOT"] != secondCommand.environment["TRIANGLE_INSTANCE_TEMP_ROOT"], "instance temp roots collided")
        try expect(firstCommand.environment["TRIANGLE_INSTANCE_ID"] == first.instanceID.value, "instance ID missing")
        try expect(firstCommand.environment["TRIANGLE_MODEL_ROOTS"] == firstCommand.environment["CODEX_HOME"], "model roots did not select exact instance")
        try expect(firstCommand.environment["HERMES_CLI"] == nil && firstCommand.environment["HERMES_HOME"] == nil, "inactive adapter environment leaked")
        try expect(firstCommand.environment.values.allSatisfy { !$0.contains(rawProfile) }, "raw Unicode profile leaked into a runtime path")
        do {
            _ = try resolver.resolve(.hermes, instance: first)
            throw WorkerContractFailure("instance was resolved through the wrong runtime adapter")
        } catch is WorkerLauncherError {}
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture.manifestURL)) as! [String: Any]
        let releaseEnvironment = manifest["environment"] as! [String: String]
        for mutable in ["TRIANGLE_MODEL_STATE_BASE", "TRIANGLE_MODEL_ROOTS", "TRIANGLE_INSTANCE_ID", "TRIANGLE_INSTANCE_TEMP_ROOT", "CODEX_HOME", "HERMES_HOME"] {
            try expect(releaseEnvironment[mutable] == nil, "shared manifest retained mutable instance state: \(mutable)")
        }
    }

    public static func concurrentFreshRootResolution() async throws {
        let fixture = try ResolverFixture(); defer { fixture.cleanup() }
        let resolver = FileWorkerCommandResolver(applicationRoot: fixture.applicationRoot)
        let instances = try (0..<32).map { index in
            try ClientInstance(profile: ProfileName("concurrent-\(index)"), runtimeAdapter: .codex)
        }
        let barrier = AsyncBarrier(participants: instances.count)
        let commands = try await withThrowingTaskGroup(of: WorkerCommand.self) { group in
            for instance in instances {
                group.addTask {
                    await barrier.wait()
                    return try resolver.resolve(.codex, instance: instance)
                }
            }
            var values: [WorkerCommand] = []
            for try await command in group { values.append(command) }
            return values
        }
        try expect(commands.count == instances.count, "concurrent resolutions were lost")
        try expect(Set(commands.compactMap { $0.environment["CODEX_HOME"] }).count == instances.count, "concurrent instances shared mutable model state")
        try expect(Set(commands.map(\.executable)).count == 1, "concurrent instances did not share the immutable runtime")
    }

    public static func installedBundleResolvesAndSmokes() throws {
        let manager = FileManager.default
        let configuredTemporaryRoot = ProcessInfo.processInfo.environment["TMPDIR"] ?? "/tmp"
        let canonicalTemporaryRoot = configuredTemporaryRoot.hasPrefix("/var/") ? "/private\(configuredTemporaryRoot)" : configuredTemporaryRoot
        let temporaryRoot = URL(fileURLWithPath: canonicalTemporaryRoot, isDirectory: true)
        let createdHome = temporaryRoot.appendingPathComponent("triangle-installed-runtime-\(UUID().uuidString)")
        try manager.createDirectory(at: createdHome, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let home = createdHome
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: home.path)
        defer { try? manager.removeItem(at: home) }
        let fakeCLI = home.appendingPathComponent("codex-test-cli")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: fakeCLI)
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fakeCLI.path)
        let nodeSourceDirectory = home.appendingPathComponent("mutable-node-source")
        try manager.createDirectory(at: nodeSourceDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let nodeSource = nodeSourceDirectory.appendingPathComponent("node")
        try Data("#!/bin/sh\nif [ \"$1\" = --check ]; then exit 0; fi\nif [ \"$1\" = --input-type=module ]; then printf 'triangle-node-ok\\n'; exit 0; fi\nexit 64\n".utf8).write(to: nodeSource)
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: nodeSource.path)
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { repository.deleteLastPathComponent() }
        let service = repository.appendingPathComponent("scripts/triangle-worker-service.sh")
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [service.path, "prepare-runtime", "codex"]
        process.environment = ["HOME": home.path, "PATH": "\(nodeSourceDirectory.path):\(ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin")", "CODEX_CLI": fakeCLI.path]
        let installOutput = Pipe(); process.standardOutput = installOutput; process.standardError = installOutput
        try process.run(); process.waitUntilExit()
        let diagnostics = installOutput.fileHandleForReading.readDataToEndOfFile()
        try expect(process.terminationStatus == 0, "clean runtime preparation failed: \(String(decoding: diagnostics, as: UTF8.self))")
        let applicationRoot = home.appendingPathComponent("Library/Application Support/The Triangle")
        try manager.moveItem(at: nodeSource, to: nodeSource.appendingPathExtension("original"))
        try Data("#!/bin/sh\nexit 97\n".utf8).write(to: nodeSource)
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: nodeSource.path)
        let instance = try ClientInstance(profile: ProfileName("smoke"), runtimeAdapter: .codex)
        let command = try FileWorkerCommandResolver(applicationRoot: applicationRoot).resolve(.codex, instance: instance)
        try expect(command.executable.path != nodeSource.path, "resolver retained rename-writable external Node source")
        let smoke = Process(); smoke.executableURL = command.executable; smoke.arguments = ["--check", command.arguments[0]]; smoke.environment = [:]
        let smokeOutput = Pipe(); smoke.standardOutput = smokeOutput; smoke.standardError = smokeOutput
        try smoke.run(); smoke.waitUntilExit()
        let combined = diagnostics + smokeOutput.fileHandleForReading.readDataToEndOfFile()
        try expect(smoke.terminationStatus == 0, "installed worker entry failed Node syntax smoke")
        let rendered = String(decoding: combined, as: UTF8.self)
        try expect(!rendered.contains("MESH_AGENT_TOKEN") && !rendered.contains("mesh_"), "runtime smoke printed credential material")
    }

    private static func gate() throws -> VerifiedCredentialGate { try gate(profile: ProfileName("codex-mailbox-live")) }
    private static func gate(profile: ProfileName) throws -> VerifiedCredentialGate {
        let binding = CredentialBinding(origin: try MeshOrigin("https://thetriangle.dev"), agentID: try AgentID(agentID), handle: try MailboxHandle("codex-mailbox-live"), token: try MeshToken(token))
        let store = InMemoryCredentialStore(); try store.create(binding, for: profile)
        let journal = InMemoryEnrollmentJournal()
        try journal.write(.testing(profile: profile, origin: binding.origin, state: .verified, agentID: binding.agentID, handle: binding.handle, reasonCode: "identity_verified"))
        return VerifiedCredentialGate(store: store, transport: IdentityTransport(), reservation: InMemoryEnrollmentReservation(), journal: journal)
    }
}

private struct FixedWorkerResolver: WorkerCommandResolving { let command: WorkerCommand; init(_ command: WorkerCommand) { self.command = command }; func resolve(_ worker: WorkerKind, instance: ClientInstance) throws -> WorkerCommand { command } }
private struct FailingWorkerResolver: WorkerCommandResolving { let events: EventRecorder; func resolve(_ worker: WorkerKind, instance: ClientInstance) throws -> WorkerCommand { events.append("resolver"); throw WorkerLauncherError.unsafeInstallation } }
private final class RecordingInstanceResolver: WorkerCommandResolving, @unchecked Sendable {
    let command: WorkerCommand
    private let lock = NSLock()
    private var storage: ClientInstance?
    init(command: WorkerCommand) { self.command = command }
    var instance: ClientInstance? { lock.withLock { storage } }
    func resolve(_ worker: WorkerKind, instance: ClientInstance) throws -> WorkerCommand { lock.withLock { storage = instance }; return command }
}
private actor AsyncBarrier {
    private let participants: Int
    private var arrivals = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    init(participants: Int) { self.participants = participants }
    func wait() async {
        arrivals += 1
        if arrivals == participants {
            let pending = waiters
            waiters.removeAll()
            pending.forEach { $0.resume() }
            return
        }
        await withCheckedContinuation { continuation in waiters.append(continuation) }
    }
}
private final class RecordingWorkerExecutor: WorkerExecuting, @unchecked Sendable { var request: WorkerExecutionRequest?; func execute(_ request: WorkerExecutionRequest) throws { self.request = request } }
private final class EventRecorder: @unchecked Sendable { private let lock = NSLock(); private var storage: [String] = []; var values: [String] { lock.withLock { storage } }; func append(_ value: String) { lock.withLock { storage.append(value) } } }
private final class RecordingCredentialStore: CredentialStore, @unchecked Sendable {
    private let binding: CredentialBinding; private let events: EventRecorder; private let lock = NSLock(); private var reads = 0
    init(binding: CredentialBinding, events: EventRecorder) { self.binding = binding; self.events = events }
    var readCount: Int { lock.withLock { reads } }
    func create(_ binding: CredentialBinding, for profile: ProfileName) throws { throw CredentialStoreError.duplicateItem }
    func read(for profile: ProfileName) throws -> CredentialBinding { lock.withLock { reads += 1 }; events.append("credential"); return binding }
    func replace(_ binding: CredentialBinding, for profile: ProfileName, confirmation: CredentialReplacementConfirmation) throws { throw CredentialStoreError.replacementNotConfirmed }
    func delete(for profile: ProfileName) throws { throw CredentialStoreError.itemNotFound }
}
private struct IdentityTransport: MeshTransport {
    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        let body = Data(#"{"agent":{"id":"agent_88888888888888888888888888888888","name":"Codex Mailbox Live","handle":"codex-mailbox-live","registrationMode":"mailbox","endpointUrl":"https://thetriangle.dev/api/v1/mailbox"}}"#.utf8)
        return MeshHTTPResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: body, finalURL: request.url)
    }
}

private final class ResolverFixture {
    let applicationRoot: URL
    private let fixtureHome: URL
    private let manager = FileManager.default
    private let node: URL
    private let manifest: URL
    var manifestURL: URL { manifest }
    init(manifestVersion: Int = 4) throws {
        fixtureHome = manager.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("triangle-worker-\(UUID().uuidString)")
        applicationRoot = fixtureHome.appendingPathComponent("Library/Application Support/The Triangle")
        try manager.createDirectory(at: applicationRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: applicationRoot.path)
        let runtime = applicationRoot.appendingPathComponent("worker-runtime")
        try manager.createDirectory(at: runtime, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runtime.path)
        let credentials = applicationRoot.appendingPathComponent("credentials")
        try manager.createDirectory(at: credentials, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: credentials.path)
        let bundles = runtime.appendingPathComponent("bundles")
        let stagedBundle = bundles.appendingPathComponent(".stage")
        try manager.createDirectory(at: stagedBundle, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        for directory in [bundles, stagedBundle] { try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) }
        let stagedNode = stagedBundle.appendingPathComponent("bin/node")
        try manager.createDirectory(at: stagedNode.deletingLastPathComponent(), withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try Data("#!/bin/sh\nif [ \"$1\" = --input-type=module ]; then printf 'triangle-node-ok\\n'; exit 0; fi\nexit 0\n".utf8).write(to: stagedNode); try manager.setAttributes([.posixPermissions: 0o500], ofItemAtPath: stagedNode.path)
        var artifactNames = [
            "packages/agent-worker/src/cli.mjs",
            "packages/agent-worker/src/command-runner.mjs",
            "packages/agent-worker/src/mailbox-client.mjs",
            "packages/agent-worker/src/runtime.mjs",
            "packages/agent-worker/runners/runner-common.mjs",
            "packages/agent-worker/runners/codex-runner.mjs",
            "agents/codex/worker/agent-worker.json",
        ]
        if manifestVersion == 4 {
            artifactNames += [
                "packages/agent-worker/src/client-supervisor-cli.mjs",
                "packages/agent-worker/src/client-supervisor.mjs",
                "packages/agent-worker/src/concurrency-gate.mjs",
            ]
        }
        var artifacts: [String: String] = [:]
        for name in artifactNames {
            let url = stagedBundle.appendingPathComponent(name)
            try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var current = stagedBundle
            for component in name.split(separator: "/").dropLast() { current.appendPathComponent(String(component)); try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: current.path) }
            try Data((name.hasSuffix(".json") ? "{}" : "// fixture").utf8).write(to: url)
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            artifacts[name] = try sha256(url)
        }
        let nodeHash = try sha256(stagedNode)
        let addressLines = ["codex", nodeHash] + artifacts.keys.sorted().map { "\($0)=\(artifacts[$0]!)" }
        let address = SHA256.hash(data: Data((addressLines.joined(separator: "\n") + "\n").utf8)).map { String(format: "%02x", $0) }.joined()
        let bundle = bundles.appendingPathComponent(address)
        try manager.moveItem(at: stagedBundle, to: bundle)
        node = bundle.appendingPathComponent("bin/node")
        manifest = runtime.appendingPathComponent("codex.manifest.json")
        let values: [String: Any] = ["version": manifestVersion, "nodeSHA256": nodeHash, "projectRoot": bundle.path, "environment": ["PATH": bundle.appendingPathComponent("bin").path, "LANG": "C", "LC_ALL": "C", "TRIANGLE_PROJECT_ROOT": bundle.path, "TRIANGLE_RUNTIME_ROOTS": "/usr/bin", "CODEX_CLI": "/usr/bin/true"], "artifacts": artifacts]
        try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]).write(to: manifest)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifest.path)
    }
    func cleanup() { try? manager.removeItem(at: fixtureHome) }
    func withManifestMutation(_ key: String, value: String) throws { var object = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as! [String: Any]; object[key] = value; try JSONSerialization.data(withJSONObject: object).write(to: manifest); try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifest.path) }
    func replaceNodeWithSymlink() throws { let replacement = applicationRoot.appendingPathComponent("outside"); try Data("node".utf8).write(to: replacement); try manager.removeItem(at: node); try manager.createSymbolicLink(at: node, withDestinationURL: replacement) }
    func makeNodeAncestorUnsafe() throws { try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.deletingLastPathComponent().path) }
    func escapeProjectRoot() throws { var object = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as! [String: Any]; let outside = applicationRoot.appendingPathComponent("outside-bundle"); try manager.createDirectory(at: outside, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]); object["projectRoot"] = outside.path; var environment = object["environment"] as! [String: String]; environment["TRIANGLE_PROJECT_ROOT"] = outside.path; object["environment"] = environment; try JSONSerialization.data(withJSONObject: object).write(to: manifest); try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifest.path) }
    func makeManifestGroupWritable() throws { try manager.setAttributes([.posixPermissions: 0o660], ofItemAtPath: manifest.path) }
    func assertRejected(_ mutate: () throws -> Void) throws { try mutate(); do { _ = try FileWorkerCommandResolver(applicationRoot: applicationRoot).resolve(.codex, instance: try ClientInstance(profile: ProfileName("safe"), runtimeAdapter: .codex)); throw WorkerContractFailure("unsafe resolver input accepted") } catch is WorkerLauncherError {} }
}

private func sha256(_ url: URL) throws -> String {
    let result = Process(); result.executableURL = URL(fileURLWithPath: "/usr/bin/shasum"); result.arguments = ["-a", "256", url.path]
    let pipe = Pipe(); result.standardOutput = pipe; try result.run(); result.waitUntilExit()
    return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: " ")[0].description
}
private struct WorkerContractFailure: Error { let message: String; init(_ message: String) { self.message = message } }
private func expect(_ value: @autoclosure () -> Bool, _ message: String) throws { if !value() { throw WorkerContractFailure(message) } }
private func require<T>(_ value: T?, _ message: String) throws -> T { guard let value else { throw WorkerContractFailure(message) }; return value }
