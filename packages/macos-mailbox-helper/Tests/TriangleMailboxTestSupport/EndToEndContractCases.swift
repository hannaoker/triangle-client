import Foundation
@_spi(ClientInstanceTesting) import TriangleMailboxCore

public enum EndToEndContractCases {
    /// Permissions v1: `triangle` custody on disk -> `bind` -> fresh `status`
    /// -> MCP across two sessions -> worker launch with only the key file path.
    public static func crossSessionMailboxLifecycle() async throws {
        let runID = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        let inheritedCanary = "ambient_\(runID)"
        let profile = try ProfileName("integration-\(runID.prefix(20))")
        let neighborProfile = try ProfileName("neighbor-\(runID.prefix(20))")

        let root = FileManager.default.temporaryDirectory
            .resolvingSymlinksInPath()
            .appendingPathComponent("triangle-e2e-\(runID)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("v1", isDirectory: true)
        let agent = try V1TestCustody.makeAgent(home: home, profile: profile.value, handle: "integration-agent", fill: "1")
        let neighbor = try V1TestCustody.makeAgent(home: home, profile: neighborProfile.value, handle: "neighbor-mailbox", fill: "e")
        let bindingRoot = root.appendingPathComponent("profiles-v1", isDirectory: true)
        let bindings = FileV1ProfileBindingStore(root: bindingRoot)
        let methods = MethodRecorder()
        let transport = FakeV1Mesh(agents: [agent, neighbor]) { request in
            guard request.url.path == "/api/mcp",
                  let object = try JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let id = object["id"],
                  let params = object["params"] as? [String: Any],
                  let method = params["name"] as? String
            else { throw EndToEndFailure("unexpected fixture request") }
            methods.append(method)
            return FakeV1Mesh.json(200, [
                "jsonrpc": "2.0", "id": id,
                "result": ["content": [["type": "text", "text": method == "mesh.mailbox.list" ? "empty mailbox" : "reply accepted"]]],
            ], request)
        }
        let mcpAuthorized = MCPAuthorization(mesh: transport)

        let bound = try await ProfileBindingService(bindings: bindings, transport: mcpAuthorized)
            .bind(profile: profile, keyFile: agent.keyFile, origin: nil)
        try expect(bound.status == .verified, "bind did not finish verified")
        _ = try await ProfileBindingService(bindings: bindings, transport: mcpAuthorized)
            .bind(profile: neighborProfile, keyFile: neighbor.keyFile, origin: nil)
        let bindOutput = try CLIOutputRenderer.render(bound)

        // A fresh service gets only the profile and the on-disk pointer.
        let restartedStatus = await ProfileBindingService(bindings: FileV1ProfileBindingStore(root: bindingRoot), transport: mcpAuthorized).status(profile: profile)
        try expect(restartedStatus.status == .verified && restartedStatus.agentID == agent.agentID.value, "fresh service did not resume the bound agent")
        try expect(restartedStatus.permissions?["dm_owner"] == true, "status did not carry permissions")

        func freshGate() -> VerifiedCredentialGate {
            VerifiedCredentialGate(resolver: FileV1AgentResolver(bindings: FileV1ProfileBindingStore(root: bindingRoot)), transport: mcpAuthorized)
        }
        let firstOutput = CapturedProxyOutput()
        let firstRequest = #"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mesh.mailbox.list","arguments":{"limit":10}}}"#
        let firstResult = await MCPProxy(gate: freshGate(), transport: mcpAuthorized).run(profile: profile, input: Data("\(firstRequest)\n".utf8), output: firstOutput)
        try expect(firstResult == .completed, "first MCP turn failed")

        let secondOutput = CapturedProxyOutput()
        let secondRequest = #"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mesh.messages.send","arguments":{"roomId":"room_fixture","text":"fixture reply"}}}"#
        let secondResult = await MCPProxy(gate: freshGate(), transport: mcpAuthorized).run(profile: profile, input: Data("\(secondRequest)\n".utf8), output: secondOutput)
        try expect(secondResult == .completed, "second MCP turn failed")
        try expect(methods.values == ["mesh.mailbox.list", "mesh.messages.send"], "MCP turns were not forwarded in order")
        try expect(mcpAuthorized.mcpWorkloads == [agent.workloadID.value, agent.workloadID.value], "MCP used the wrong agent's token")

        let executor = CapturedWorkerExecutor()
        let command = WorkerCommand(
            executable: URL(fileURLWithPath: "/trusted/node"),
            arguments: ["/trusted/agent-worker.mjs", "--watch"],
            workingDirectory: URL(fileURLWithPath: "/trusted"),
            environment: ["PATH": "/trusted/bin", "TRIANGLE_PROJECT_ROOT": "/trusted"]
        )
        try await WorkerLauncher(gate: freshGate(), resolver: FixedWorkerCommandResolver(command: command), executor: executor)
            .launch(profile: profile, worker: .codex, inheritedEnvironment: ["MESH_AGENT_TOKEN": inheritedCanary, "UNRELATED_SECRET": inheritedCanary])
        let launch = try require(executor.request, "worker launch was not prepared")
        try expect(launch.environment["TRIANGLE_WORKLOAD_KEY_FILE"] == agent.keyFile.path, "worker did not receive its key file")
        try expect(launch.environment["MESH_AGENT_TOKEN"] == nil, "worker received a static bearer")
        try expect(launch.environment["CODEX_AGENT_ID"] == agent.agentID.value, "worker did not receive the bound identity")
        try expect(launch.environment["UNRELATED_SECRET"] == nil, "ambient secret reached the worker")

        let sanitizer = try runProductionEnvironmentSanitizer(workerEnvironment: launch.environment, root: root)
        let argvSnapshot = Data(([launch.executable.path] + launch.arguments + sanitizer.argv).joined(separator: "\n").utf8)
        let visibleArtifacts = [
            bindOutput.stdout, bindOutput.stderr, firstOutput.stdout, firstOutput.stderr,
            secondOutput.stdout, secondOutput.stderr, argvSnapshot, sanitizer.stdout, sanitizer.stderr,
        ] + (try regularFileContents(beneath: bindingRoot))
        for secret in [agent.seed, neighbor.seed, inheritedCanary] + transport.issuedTokens {
            let needle = Data(secret.utf8)
            try expect(visibleArtifacts.allSatisfy { $0.range(of: needle) == nil },
                       "a secret appeared in stdout, stderr, argv, bindings, or the reasoning-child environment")
        }
        let sanitized = String(decoding: sanitizer.stdout, as: UTF8.self)
        try expect(!sanitized.contains("TRIANGLE_WORKLOAD_KEY_FILE") && !sanitized.contains("CODEX_AGENT_ID"),
                   "production sanitizer preserved a controller credential selector")

        let instanceRoot = root.appendingPathComponent("client-instances", isDirectory: true)
        let instanceStore = FileClientInstanceStore(testRoot: instanceRoot)
        let profiles = try (0..<10).map { index in
            try ProfileName(index < 6 ? "codex-\(index + 1)" : "hermes-\(index + 1)")
        }
        for (index, clientProfile) in profiles.enumerated() {
            try instanceStore.create(ClientInstance(profile: clientProfile, runtimeAdapter: index < 6 ? .codex : .hermes))
        }
        let initialInstances = try instanceStore.list()
        try expect(initialInstances.count == 10, "ten Triangle Client instances were not persisted")
        try expect(initialInstances.filter { $0.runtimeAdapter == .codex }.count == 6, "Codex instance count changed")
        try expect(initialInstances.filter { $0.runtimeAdapter == .hermes }.count == 4, "Hermes instance count changed")
        try expect(Set(initialInstances.map(\.instanceID)).count == 10, "instance state was not isolated by opaque ID")
        try instanceStore.setEnabled(false, profile: profiles[5])
        let restartedInstanceStore = FileClientInstanceStore(testRoot: instanceRoot)
        try expect(try restartedInstanceStore.list().first { $0.profile == profiles[5] }?.enabled == false, "exact disabled state did not survive a client restart")
        try restartedInstanceStore.setEnabled(true, profile: profiles[5])
        try restartedInstanceStore.remove(profile: profiles[8])
        let remainingInstances = try restartedInstanceStore.list()
        try expect(remainingInstances.count == 9, "exact instance removal changed the wrong number of records")
        try expect(!remainingInstances.contains { $0.profile == profiles[8] }, "removed instance survived")
        for data in try regularFileContents(beneath: instanceRoot) {
            try expect(data.range(of: Data(agent.seed.utf8)) == nil, "workload key reached the instance registry")
            try expect(data.range(of: Data(inheritedCanary.utf8)) == nil, "ambient secret reached the instance registry")
        }

        try ProfileBindingService(bindings: bindings, transport: mcpAuthorized).unbind(profile: profile)
        do {
            _ = try freshGate().material(for: profile)
            throw EndToEndFailure("unbound profile remained resolvable")
        } catch VerifiedCredentialGateError.profileNotFound {}
        try expect(try freshGate().material(for: neighborProfile).agentID == neighbor.agentID, "unbind changed a neighboring binding")
        try expect(FileManager.default.fileExists(atPath: agent.keyFile.path), "unbind deleted triangle custody")
        try expect(transport.requests.allSatisfy { !$0.url.path.contains("register") }, "the helper attempted self-registration")
        try expect(transport.requestCount(path: "/api/v1/agents/me") >= 5, "identity was not freshly proven across lifecycle boundaries")
    }
}

private final class MethodRecorder: @unchecked Sendable {
    private let lock = NSLock(); private var storage: [String] = []
    var values: [String] { lock.withLock { storage } }
    func append(_ value: String) { lock.withLock { storage.append(value) } }
}

/// Rejects any MCP call that does not carry a live workload token + DPoP.
private final class MCPAuthorization: MeshTransport, @unchecked Sendable {
    let mesh: FakeV1Mesh
    private let lock = NSLock(); private var workloads: [String] = []
    init(mesh: FakeV1Mesh) { self.mesh = mesh }
    var mcpWorkloads: [String] { lock.withLock { workloads } }
    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        if request.url.path == "/api/mcp" {
            guard let workload = mesh.workload(forAuthorization: request.headers) else {
                throw EndToEndFailure("MCP omitted the workload access token")
            }
            lock.withLock { workloads.append(workload) }
        }
        return try await mesh.send(request)
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
