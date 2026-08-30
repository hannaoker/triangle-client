import Foundation
@_spi(EnrollmentTesting) @_spi(ClientInstanceTesting) import TriangleMailboxCore

public enum EndToEndContractCases {
    public static func crossSessionMailboxLifecycle() async throws {
        let runID = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        let admissionCanary = "admission_\(runID)"
        let tokenCanary = "mesh_\(runID)\(runID)"
        let inheritedCanary = "ambient_\(runID)"
        let agentID = "agent_\(runID)"
        let profile = try ProfileName("integration-\(runID.prefix(20))")
        let neighborProfile = try ProfileName("neighbor-\(runID.prefix(20))")
        let handle = try MailboxHandle("integration-\(runID.prefix(16))")
        let origin = try MeshOrigin("https://thetriangle.dev")
        let store = InMemoryCredentialStore()
        let neighborBinding = CredentialBinding(
            origin: origin,
            agentID: try AgentID("agent_\(String(repeating: "f", count: 32))"),
            handle: try MailboxHandle("neighbor-mailbox"),
            token: try MeshToken("mesh_\(String(repeating: "e", count: 64))")
        )
        try store.create(neighborBinding, for: neighborProfile)

        let root = FileManager.default.temporaryDirectory
            .resolvingSymlinksInPath()
            .appendingPathComponent("triangle-e2e-\(runID)", isDirectory: true)
        let journalRoot = root.appendingPathComponent("journal", isDirectory: true)
        try FileManager.default.createDirectory(
            at: journalRoot,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: root) }

        let journal = FileEnrollmentJournal(testRoot: journalRoot)
        let transport = LifecycleTransport(
            admissionToken: admissionCanary,
            permanentToken: tokenCanary,
            agentID: agentID,
            handle: handle.value
        )
        let enrollmentInput = try JSONSerialization.data(withJSONObject: [
            "admissionToken": admissionCanary,
            "handle": handle.value,
            "name": "Mailbox Integration",
            "description": "Disposable local fixture",
            "capabilities": ["direct-messages"],
        ], options: [.sortedKeys])
        let initialService = EnrollmentService(
            store: store,
            transport: transport,
            reservation: InMemoryEnrollmentReservation(),
            journal: journal
        )
        let enrolled = try await initialService.enroll(profile: profile, origin: origin, inputData: enrollmentInput)
        try expect(enrolled.status == .verified, "enrollment did not finish verified")
        let enrollmentOutput = try CLIOutputRenderer.render(enrolled)

        // A new service instance receives only the profile and durable storage
        // abstractions. It does not receive either credential as input.
        let restartedService = EnrollmentService(
            store: store,
            transport: transport,
            reservation: InMemoryEnrollmentReservation(),
            journal: FileEnrollmentJournal(testRoot: journalRoot)
        )
        let restartedStatus = try await restartedService.status(profile: profile)
        try expect(restartedStatus.status == .verified, "fresh service did not resume the stored identity")

        let firstOutput = CapturedProxyOutput()
        let firstProxy = MCPProxy(
            gate: VerifiedCredentialGate(
                store: store,
                transport: transport,
                reservation: InMemoryEnrollmentReservation(),
                journal: FileEnrollmentJournal(testRoot: journalRoot)
            ),
            transport: transport
        )
        let firstRequest = #"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mesh.mailbox.list","arguments":{"limit":10}}}"#
        let firstResult = await firstProxy.run(
            profile: profile,
            input: Data("\(firstRequest)\n".utf8),
            output: firstOutput
        )
        try expect(firstResult == .completed, "first MCP turn failed")

        // Recreate both proxy and gate to model a new chatbot process/session.
        let secondOutput = CapturedProxyOutput()
        let secondProxy = MCPProxy(
            gate: VerifiedCredentialGate(
                store: store,
                transport: transport,
                reservation: InMemoryEnrollmentReservation(),
                journal: FileEnrollmentJournal(testRoot: journalRoot)
            ),
            transport: transport
        )
        let secondRequest = #"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mesh.messages.send","arguments":{"roomId":"room_fixture","text":"fixture reply"}}}"#
        let secondResult = await secondProxy.run(
            profile: profile,
            input: Data("\(secondRequest)\n".utf8),
            output: secondOutput
        )
        try expect(secondResult == .completed, "second MCP turn failed")
        try expect(transport.mcpMethods == ["mesh.mailbox.list", "mesh.messages.send"], "MCP turns were not forwarded in order")

        let executor = CapturedWorkerExecutor()
        let command = WorkerCommand(
            executable: URL(fileURLWithPath: "/trusted/node"),
            arguments: ["/trusted/agent-worker.mjs", "--watch"],
            workingDirectory: URL(fileURLWithPath: "/trusted"),
            environment: ["PATH": "/trusted/bin", "TRIANGLE_PROJECT_ROOT": "/trusted"]
        )
        let launcher = WorkerLauncher(
            gate: VerifiedCredentialGate(
                store: store,
                transport: transport,
                reservation: InMemoryEnrollmentReservation(),
                journal: FileEnrollmentJournal(testRoot: journalRoot)
            ),
            resolver: FixedWorkerCommandResolver(command: command),
            executor: executor
        )
        try await launcher.launch(
            profile: profile,
            worker: .codex,
            inheritedEnvironment: [
                "MESH_AGENT_TOKEN": inheritedCanary,
                "UNRELATED_SECRET": inheritedCanary,
            ]
        )
        let launch = try require(executor.request, "worker launch was not prepared")
        try expect(launch.environment["MESH_AGENT_TOKEN"] == tokenCanary, "worker did not receive the stored credential")
        try expect(launch.environment["CODEX_AGENT_ID"] == agentID, "worker did not receive the stored identity")
        try expect(launch.environment["UNRELATED_SECRET"] == nil, "ambient secret reached the worker")

        let sanitizer = try runProductionEnvironmentSanitizer(workerEnvironment: launch.environment, root: root)
        let generatedFiles = try regularFileContents(beneath: root)
        let argvSnapshot = Data(
            ([launch.executable.path] + launch.arguments + sanitizer.argv).joined(separator: "\n").utf8
        )
        let visibleArtifacts = [
            enrollmentOutput.stdout,
            enrollmentOutput.stderr,
            firstOutput.stdout,
            firstOutput.stderr,
            secondOutput.stdout,
            secondOutput.stderr,
            argvSnapshot,
            sanitizer.stdout,
            sanitizer.stderr,
        ] + generatedFiles
        for secret in [admissionCanary, tokenCanary, inheritedCanary] {
            let needle = Data(secret.utf8)
            try expect(
                visibleArtifacts.allSatisfy { $0.range(of: needle) == nil },
                "a canary appeared in stdout, stderr, argv, generated files, or the reasoning-child environment"
            )
        }
        try expect(
            !String(decoding: sanitizer.stdout, as: UTF8.self).contains("MESH_AGENT_TOKEN") &&
                !String(decoding: sanitizer.stdout, as: UTF8.self).contains("CODEX_AGENT_ID"),
            "production sanitizer preserved a controller credential selector"
        )

        let instanceRoot = root.appendingPathComponent("client-instances", isDirectory: true)
        let instanceStore = FileClientInstanceStore(testRoot: instanceRoot)
        let profiles = try (0..<10).map { index in
            try ProfileName(index < 6 ? "codex-\(index + 1)" : "hermes-\(index + 1)")
        }
        for (index, clientProfile) in profiles.enumerated() {
            try instanceStore.create(ClientInstance(
                profile: clientProfile,
                runtimeAdapter: index < 6 ? .codex : .hermes
            ))
        }
        let initialInstances = try instanceStore.list()
        try expect(initialInstances.count == 10, "ten Triangle Client instances were not persisted")
        try expect(initialInstances.filter { $0.runtimeAdapter == .codex }.count == 6, "Codex instance count changed")
        try expect(initialInstances.filter { $0.runtimeAdapter == .hermes }.count == 4, "Hermes instance count changed")
        try expect(Set(initialInstances.map(\.instanceID)).count == 10, "instance state was not isolated by opaque ID")

        try instanceStore.setEnabled(false, profile: profiles[5])
        let restartedInstanceStore = FileClientInstanceStore(testRoot: instanceRoot)
        let restartedInstances = try restartedInstanceStore.list()
        try expect(
            restartedInstances.first { $0.profile == profiles[5] }?.enabled == false,
            "exact disabled state did not survive a client restart"
        )
        try restartedInstanceStore.setEnabled(true, profile: profiles[5])
        try restartedInstanceStore.remove(profile: profiles[8])
        let remainingInstances = try restartedInstanceStore.list()
        try expect(remainingInstances.count == 9, "exact instance removal changed the wrong number of records")
        try expect(!remainingInstances.contains { $0.profile == profiles[8] }, "removed instance survived")
        try expect(remainingInstances.contains { $0.profile == profiles[5] && $0.enabled }, "neighbor enable state was lost")
        for data in try regularFileContents(beneath: instanceRoot) {
            try expect(data.range(of: Data(tokenCanary.utf8)) == nil, "permanent token reached the instance registry")
            try expect(data.range(of: Data(inheritedCanary.utf8)) == nil, "ambient secret reached the instance registry")
        }

        try store.delete(for: profile)
        try journal.remove(for: profile)
        do {
            _ = try store.read(for: profile)
            throw EndToEndFailure("deleted profile remained readable")
        } catch CredentialStoreError.itemNotFound {
            // Expected exact deletion.
        }
        try expect(try store.read(for: neighborProfile) == neighborBinding, "exact deletion changed a neighboring item")
        try expect(try regularFileContents(beneath: journalRoot).isEmpty, "exact journal cleanup left generated state")
        try expect(transport.registrationCount == 1, "a fresh session re-registered the mailbox identity")
        try expect(transport.identityCount >= 5, "identity was not freshly authenticated across lifecycle boundaries")
    }
}

private final class LifecycleTransport: MeshTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let admissionToken: String
    private let permanentToken: String
    private let agentID: String
    private let handle: String
    private var registrations = 0
    private var identities = 0
    private var methods: [String] = []

    init(admissionToken: String, permanentToken: String, agentID: String, handle: String) {
        self.admissionToken = admissionToken
        self.permanentToken = permanentToken
        self.agentID = agentID
        self.handle = handle
    }

    var registrationCount: Int { lock.withLock { registrations } }
    var identityCount: Int { lock.withLock { identities } }
    var mcpMethods: [String] { lock.withLock { methods } }

    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        try lock.withLock {
            if request.url.path == "/api/v1/agents/register-mailbox" {
                guard request.headers["X-Mesh-Admission-Token"] == admissionToken,
                      request.headers["Authorization"] == nil,
                      !request.body.contains(Data(admissionToken.utf8))
                else { throw EndToEndFailure("registration credential was sent through the wrong channel") }
                registrations += 1
                let body = Data("""
                {"agent":{"id":"\(agentID)","handle":"\(handle)","name":"Mailbox Integration","description":"Disposable local fixture","endpointUrl":"https://thetriangle.dev/api/v1/mailbox","capabilities":["direct-messages"],"protocolVersion":"mailbox-v1","protocolBinding":"TRIANGLE","conformanceStatus":"unverified","registrationMode":"mailbox","agentCardUrl":"https://thetriangle.dev/api/v1/agents/\(agentID)"},"token":"\(permanentToken)","warning":"Save this token now."}
                """.utf8)
                return jsonResponse(status: 201, path: request.url.path, body: body)
            }
            guard request.headers["Authorization"] == "Bearer \(permanentToken)" else {
                throw EndToEndFailure("authenticated operation omitted the stored bearer")
            }
            if request.url.path == "/api/v1/agents/me" {
                identities += 1
                return jsonResponse(status: 200, path: request.url.path, body: Data("""
                {"agent":{"id":"\(agentID)","name":"Mailbox Integration","handle":"\(handle)","registrationMode":"mailbox","endpointUrl":"https://thetriangle.dev/api/v1/mailbox"}}
                """.utf8))
            }
            guard request.url.path == "/api/mcp",
                  let object = try JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let id = object["id"],
                  let params = object["params"] as? [String: Any],
                  let method = params["name"] as? String
            else { throw EndToEndFailure("unexpected fixture request") }
            methods.append(method)
            let responseObject: [String: Any] = [
                "jsonrpc": "2.0",
                "id": id,
                "result": ["content": [["type": "text", "text": method == "mesh.mailbox.list" ? "empty mailbox" : "reply accepted"]]],
            ]
            return jsonResponse(
                status: 200,
                path: request.url.path,
                body: try JSONSerialization.data(withJSONObject: responseObject, options: [.sortedKeys])
            )
        }
    }

    private func jsonResponse(status: Int, path: String, body: Data) -> MeshHTTPResponse {
        MeshHTTPResponse(
            statusCode: status,
            headers: ["Content-Type": "application/json"],
            body: body,
            finalURL: URL(string: "https://thetriangle.dev\(path)")!
        )
    }
}

private final class CapturedProxyOutput: MCPProxyOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var stdoutStorage = Data()
    private var stderrStorage = Data()
    var stdout: Data { lock.withLock { stdoutStorage } }
    var stderr: Data { lock.withLock { stderrStorage } }
    func writeStdout(_ data: Data) { lock.withLock { stdoutStorage.append(data) } }
    func writeStderr(_ data: Data) { lock.withLock { stderrStorage.append(data) } }
}

private struct FixedWorkerCommandResolver: WorkerCommandResolving {
    let command: WorkerCommand
    func resolve(_ worker: WorkerKind, instance _: ClientInstance) throws -> WorkerCommand { command }
}

private final class CapturedWorkerExecutor: WorkerExecuting, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: WorkerExecutionRequest?
    var request: WorkerExecutionRequest? { lock.withLock { storage } }
    func execute(_ request: WorkerExecutionRequest) throws { lock.withLock { storage = request } }
}

private struct EndToEndFailure: Error, CustomStringConvertible {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { message }
}

private func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    guard try condition() else { throw EndToEndFailure(message) }
}

private func require<T>(_ value: T?, _ message: String) throws -> T {
    guard let value else { throw EndToEndFailure(message) }
    return value
}

private func regularFileContents(beneath root: URL) throws -> [Data] {
    guard let enumerator = FileManager.default.enumerator(
        at: root,
        includingPropertiesForKeys: [.isRegularFileKey],
        options: []
    ) else { return [] }
    var result: [Data] = []
    for case let file as URL in enumerator {
        if try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
            result.append(try Data(contentsOf: file))
        }
    }
    return result
}

private struct SanitizerResult {
    let stdout: Data
    let stderr: Data
    let argv: [String]
}

private func runProductionEnvironmentSanitizer(
    workerEnvironment: [String: String],
    root: URL
) throws -> SanitizerResult {
    var repository = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { repository.deleteLastPathComponent() }
    let sanitizerModule = repository
        .appendingPathComponent("packages/agent-worker/src/command-runner.mjs")
        .absoluteURL
    let fixture = root.appendingPathComponent("reasoning-child-sanitizer.mjs")
    let source = """
    import { createRunnerEnvironment } from \(String(reflecting: sanitizerModule.absoluteString));
    process.stdout.write(JSON.stringify(createRunnerEnvironment(process.env)));
    """
    try Data(source.utf8).write(to: fixture, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fixture.path)

    let node = try locateNode()
    let process = Process()
    process.executableURL = node
    process.arguments = [fixture.path]
    process.environment = workerEnvironment
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    try process.run()
    process.waitUntilExit()
    let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
    let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
    try expect(process.terminationStatus == 0, "production environment sanitizer fixture failed")
    _ = try JSONSerialization.jsonObject(with: stdoutData) as? [String: String]
        ?? { throw EndToEndFailure("production environment sanitizer returned invalid output") }()
    return SanitizerResult(stdout: stdoutData, stderr: stderrData, argv: [node.path, fixture.path])
}

private func locateNode() throws -> URL {
    let manager = FileManager.default
    let environmentPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
    let candidates = environmentPath.split(separator: ":").map {
        URL(fileURLWithPath: String($0)).appendingPathComponent("node")
    }
    guard let node = candidates.first(where: { manager.isExecutableFile(atPath: $0.path) }) else {
        throw EndToEndFailure("Node is unavailable for the production sanitizer integration")
    }
    return node.resolvingSymlinksInPath()
}
