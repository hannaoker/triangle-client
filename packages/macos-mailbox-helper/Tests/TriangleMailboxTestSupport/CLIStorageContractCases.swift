import CryptoKit
import Darwin
import Foundation
@_spi(EnrollmentTesting) import TriangleMailboxCore

public enum CLIStorageContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }

    public static let all: [ContractCase] = [
        .init(name: "CLI home precedence and desktop compatibility", run: resolution),
        .init(name: "CLI homes isolate persisted identity, locks and transactions", run: isolation),
        .init(name: "CLI credential files reject links and public permissions", run: privateFiles),
        .init(name: "CLI access errors survive enrollment and MCP gates", run: accessErrors),
    ]

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
    private struct Failure: Error { let message: String }

    public static func resolution() throws {
        let home = URL(fileURLWithPath: "/fixture/user")
        let desktop = home.appendingPathComponent("Library/Application Support/The Triangle")
        let fresh = try CLIStorageConfiguration(arguments: ["status"], environment: [:], userHome: home, desktopExists: false)
        try expect(fresh.standalone && fresh.applicationRoot.path == "/fixture/user/.local/state/triangle", "fresh default")
        let existing = try CLIStorageConfiguration(arguments: ["status"], environment: ["XDG_STATE_HOME": "/fixture/xdg"], userHome: home, desktopExists: true)
        try expect(!existing.standalone && existing.applicationRoot.path == desktop.path, "desktop must retain custody")
        let xdg = try CLIStorageConfiguration(arguments: [], environment: ["XDG_STATE_HOME": "/fixture/xdg"], userHome: home, desktopExists: false)
        try expect(xdg.applicationRoot.path == "/fixture/xdg/triangle", "XDG default")
        let override = try CLIStorageConfiguration(arguments: ["status", "--home", "/fixture/cli", "--profile", "agent"], environment: ["TRIANGLE_HOME": "/fixture/env"], userHome: home, desktopExists: true)
        try expect(override.applicationRoot.path == "/fixture/cli" && override.standalone, "flag precedes environment")
        try expect(override.arguments == ["status", "--profile", "agent"], "global arguments stripped")
        let env = try CLIStorageConfiguration(arguments: [], environment: ["TRIANGLE_HOME": "/fixture/env"], userHome: home)
        try expect(env.applicationRoot.path == "/fixture/env", "environment override")
        let explicitDesktop = try CLIStorageConfiguration(arguments: ["--home=" + desktop.path], environment: [:], userHome: home)
        try expect(!explicitDesktop.standalone, "explicit desktop must not select file custody")
        for args in [["--home"], ["--home", "relative"], ["--home", ""], ["--home", "/"], ["--home", "/a/.."], ["--home", "/a", "--home=/b"]] {
            do {
                _ = try CLIStorageConfiguration(arguments: args, environment: [:], userHome: home)
                throw Failure(message: "invalid home accepted")
            } catch CLIStorageError.invalidHome {}
        }
        do {
            try override.validate(command: .runSupervisor)
            throw Failure(message: "standalone home entered desktop supervisor")
        } catch CLIStorageError.desktopCommandRequiresDesktopHome {}
        try override.validate(command: .mcp)
    }

    private static func temporaryRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("triangle-cli-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return root
    }

    public static func isolation() throws {
        let root = try temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try CLIStorageConfiguration(arguments: ["--home", root.appendingPathComponent("first").path], environment: [:])
        let second = try CLIStorageConfiguration(arguments: ["--home", root.appendingPathComponent("second").path], environment: [:])
        let profile = try ProfileName("ci-agent")
        let lease = try first.reservation().acquire(for: profile)
        defer { lease.release() }
        do {
            _ = try first.reservation().acquire(for: profile)
            throw Failure(message: "same-home lock did not contend")
        } catch EnrollmentReservationError.alreadyInProgress {}
        let otherLease = try second.reservation().acquire(for: profile)
        otherLease.release()
        let binding = CredentialBinding(origin: try MeshOrigin("https://thetriangle.dev"),
            agentID: try AgentID("agent_" + String(repeating: "a", count: 32)),
            handle: try MailboxHandle("ci-agent"), token: try MeshToken("mesh_" + String(repeating: "b", count: 64)))
        try first.mailbox().create(binding, for: profile)
        let key = Curve25519.Signing.PrivateKey()
        try first.workload().create(key, for: profile)
        try first.journal().write(EnrollmentJournalRecord.testing(profile: profile, origin: binding.origin, state: .verified,
            agentID: binding.agentID, handle: binding.handle, reasonCode: "identity_verified"))
        let reopened = try CLIStorageConfiguration(arguments: [], environment: ["TRIANGLE_HOME": first.applicationRoot.path])
        try expect(try reopened.mailbox().read(for: profile).agentID == binding.agentID, "identity did not survive reopening")
        try expect(try reopened.workload().read(for: profile).privateKey.rawRepresentation == key.rawRepresentation, "key did not survive reopening")
        try expect(try reopened.journal().read(for: profile)?.state == .verified, "journal did not survive reopening")
        do {
            _ = try second.mailbox().read(for: profile)
            throw Failure(message: "home leaked credentials")
        } catch CredentialStoreError.itemNotFound {}
        try expect(try second.journal().read(for: profile) == nil, "home leaked journal")
        let third = try CLIStorageConfiguration(arguments: ["--home", root.appendingPathComponent("third").path], environment: [:])
        let thirdLease = try third.reservation().acquire(for: profile)
        thirdLease.release()
        try FileManager.default.createSymbolicLink(at: third.applicationRoot.appendingPathComponent("credentials"),
            withDestinationURL: first.applicationRoot.appendingPathComponent("credentials"))
        var rejectedLink = false
        do { _ = try third.mailbox().read(for: profile) } catch { rejectedLink = true }
        try expect(rejectedLink, "a credential parent symlink escaped the isolated home")
        let instance = ClientInstanceID.derive(profile: profile)
        _ = try FileMailboxTransactionStore(instanceID: instance, applicationRoot: first.applicationRoot).readOpen(instanceID: instance)
        try expect(FileManager.default.fileExists(atPath: first.applicationRoot.appendingPathComponent("model-state/instances/\(instance.value)/mailbox-transactions").path), "transaction store escaped home")
    }

    public static func privateFiles() throws {
        let root = try temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FileWorkloadKeyStore(root: root)
        let profile = try ProfileName("private-agent")
        try store.create(Curve25519.Signing.PrivateKey(), for: profile)
        let file = root.appendingPathComponent("workload/private-agent.json")
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        try expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "credential not private")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        var rejected = false
        do { _ = try store.read(for: profile) } catch { rejected = true }
        try expect(rejected, "public credential accepted")
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let target = root.appendingPathComponent("saved-key")
        try FileManager.default.moveItem(at: file, to: target)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
        rejected = false
        do { _ = try store.read(for: profile) } catch { rejected = true }
        try expect(rejected, "symlink credential accepted")
    }

    public static func accessErrors() async throws {
        let profile = try ProfileName("ci-agent")
        let failure = CLIStorageError.accessDenied(operation: "open profile lock for writing", code: EPERM)
        let transport = NoNetwork()
        let gate = VerifiedCredentialGate(store: InMemoryCredentialStore(), transport: transport,
            reservation: DeniedReservation(), journal: InMemoryEnrollmentJournal())
        do {
            _ = try await gate.credential(for: profile)
            throw Failure(message: "gate accepted denied reservation")
        } catch let error as CLIStorageError { try expect(error == failure, "gate masked access error") }
        let service = EnrollmentService(store: InMemoryCredentialStore(), transport: transport,
            reservation: DeniedReservation(), journal: InMemoryEnrollmentJournal())
        do {
            _ = try await service.status(profile: profile)
            throw Failure(message: "status accepted denied reservation")
        } catch let error as CLIStorageError { try expect(error == failure, "status masked access error") }
        let output = Output()
        let result = await MCPProxy(gate: gate, transport: transport).run(profile: profile,
            input: Data("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n".utf8), output: output)
        try expect(result == .failed && output.stdout.isEmpty, "MCP wrote local errors to protocol stdout")
        try expect(String(decoding: output.stderr, as: UTF8.self).contains("state_access_denied"), "MCP masked access error")
    }

    private struct DeniedReservation: EnrollmentReservation {
        func acquire(for profile: ProfileName) throws -> any EnrollmentReservationLease {
            throw CLIStorageError.accessDenied(operation: "open profile lock for writing", code: EPERM)
        }
    }
    private struct NoNetwork: MeshTransport {
        func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse { throw Failure(message: "unexpected network access") }
    }
    private final class Output: MCPProxyOutput, @unchecked Sendable {
        var stdout = Data()
        var stderr = Data()
        func writeStdout(_ data: Data) { stdout.append(data) }
        func writeStderr(_ data: Data) { stderr.append(data) }
    }
}
