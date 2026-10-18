import CryptoKit
import Foundation
import TriangleMailboxCore

/// Permissions v1 helper custody: profile bindings point at `triangle` key
/// files, every use is proven with `GET /agents/me`, and nothing is minted.
public enum V1ProfileContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }

    public static let all: [ContractCase] = [
        .init(name: "v1 key files load with via origin and bounds", run: loaderReadsCustody),
        .init(name: "v1 key files fail closed on unsafe layout", run: loaderRejectsUnsafe),
        .init(name: "seed handoff is unpadded base64url the Node worker accepts", run: seedFormat),
        .init(name: "gate proves identity with DPoP agents/me and returns permissions", run: gateVerifies),
        .init(name: "gate maps paused, refused, offline, mismatch", run: gateFailures),
        .init(name: "gate retries once after a stale token 401", run: gateRetriesStaleToken),
        .init(name: "bind writes a 0600 pointer only after verification", run: bindVerifiesBeforeWrite),
        .init(name: "bind never silently replaces another agent", run: bindRefusesReplacement),
        .init(name: "bindings are case-distinct, locked, and custody parents must be private", run: bindingStoreHardening),
        .init(name: "status renders permissions and no key material", run: statusRendersPermissions),
        .init(name: "v1 material and credentials redact the key", run: redaction),
    ]

    public static func loaderReadsCustody() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = try V1TestCustody.makeAgent(
            home: home, profile: "codex", handle: "codex-one", fill: "a",
            authority: "https://mesh-preview.thetriangle.dev", via: "https://preview-deploy.vercel.app"
        )
        try expect(agent.material.authority.value == "https://mesh-preview.thetriangle.dev", "authority lost")
        try expect(agent.material.origin.value == "https://preview-deploy.vercel.app", "via origin not used")
        try expect(agent.material.scopes == ["agent.read", "agent.write"], "bounds not mapped to scopes")
        let override = try V1AgentCredentialLoader.load(keyFile: agent.keyFile, originOverride: try MeshOrigin("https://thetriangle.dev"))
        try expect(override.origin.value == "https://thetriangle.dev", "origin override ignored")

        let readOnly = try V1TestCustody.makeAgent(home: home, profile: "reader", handle: "reader-one", fill: "b", bounds: ["agent.read"])
        try expect(readOnly.material.scopes == ["agent.read"], "read-only agent requested write")
        try expect(readOnly.material.origin.value == "https://thetriangle.dev", "mismatched authority.json via was applied")
    }

    public static func loaderRejectsUnsafe() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = try V1TestCustody.makeAgent(home: home, profile: "codex", handle: "codex-one", fill: "a")
        let directory = agent.keyFile.deletingLastPathComponent()

        try expectThrows("relative key file accepted") {
            try V1AgentCredentialLoader.load(keyFile: URL(string: "agents/x/workload-key.json")!)
        }
        try expectThrows("owner key path accepted") {
            try V1AgentCredentialLoader.load(keyFile: home.appendingPathComponent("owner/owner-key.json"))
        }
        // Group-readable key.
        try FileManager.default.setAttributes([.posixPermissions: 0o640], ofItemAtPath: agent.keyFile.path)
        try expectThrows("group-readable key accepted") { try V1AgentCredentialLoader.load(keyFile: agent.keyFile) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: agent.keyFile.path)
        _ = try V1AgentCredentialLoader.load(keyFile: agent.keyFile)

        // Symlinked key.
        let other = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: other) }
        let linkedDirectory = other.appendingPathComponent("agents/\(agent.agentID.value)", isDirectory: true)
        try FileManager.default.createDirectory(at: linkedDirectory, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: directory.appendingPathComponent("agent.json"), to: linkedDirectory.appendingPathComponent("agent.json"))
        try FileManager.default.createSymbolicLink(at: linkedDirectory.appendingPathComponent("workload-key.json"), withDestinationURL: agent.keyFile)
        try expectThrows("symlinked key accepted") {
            try V1AgentCredentialLoader.load(keyFile: linkedDirectory.appendingPathComponent("workload-key.json"))
        }

        // Key in another agent's directory.
        let wrong = home.appendingPathComponent("agents/agent_\(V1TestCustody.hex("c"))", isDirectory: true)
        try FileManager.default.createDirectory(at: wrong, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: agent.keyFile, to: wrong.appendingPathComponent("workload-key.json"))
        try FileManager.default.copyItem(at: directory.appendingPathComponent("agent.json"), to: wrong.appendingPathComponent("agent.json"))
        try expectThrows("key outside its agent directory accepted") {
            try V1AgentCredentialLoader.load(keyFile: wrong.appendingPathComponent("workload-key.json"))
        }

        // Public key that does not match the private key.
        let mismatched: [String: String] = [
            "kty": "OKP", "crv": "Ed25519",
            "x": Base64URL.encode(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation),
            "d": Base64URL.encode(Curve25519.Signing.PrivateKey().rawRepresentation),
        ]
        try V1TestCustody.writePrivate(agent.keyFile, JSONSerialization.data(withJSONObject: mismatched))
        try expectThrows("mismatched JWK accepted") { try V1AgentCredentialLoader.load(keyFile: agent.keyFile) }

        // Missing agent.json.
        let lone = try V1TestCustody.makeAgent(home: home, profile: "lone", handle: "lone-one", fill: "d")
        try FileManager.default.removeItem(at: lone.keyFile.deletingLastPathComponent().appendingPathComponent("agent.json"))
        try expectThrows("missing agent.json accepted") { try V1AgentCredentialLoader.load(keyFile: lone.keyFile) }
    }

    public static func seedFormat() async throws {
        let agent = try V1TestCustody.memoryAgent(profile: "codex", handle: "codex-one", fill: "a")
        let seed = agent.seed
        try expect(seed.utf8.count == 43, "seed is not 43 characters")
        try expect(seed.wholeMatch(of: /^[A-Za-z0-9_-]{43}$/) != nil, "seed is not unpadded base64url")
        try expect(Base64URL.decode(seed) == agent.material.privateKey.rawRepresentation, "seed does not round-trip")
    }

    public static func gateVerifies() async throws {
        let agent = try V1TestCustody.memoryAgent(profile: "codex", handle: "codex-one", fill: "a")
        let mesh = FakeV1Mesh(agents: [agent])
        let gate = VerifiedCredentialGate(resolver: V1TestCustody.resolver([agent]), transport: mesh)
        let credential = try await gate.credential(for: agent.profile)
        try expect(credential.agentID == agent.agentID, "wrong agent")
        try expect(credential.permissions?["dm_owner"] == true && credential.permissionsRevision == 1, "permissions lost")
        let me = mesh.requests.filter { $0.url.path == "/api/v1/agents/me" }
        try expect(me.count == 1, "agents/me not called once")
        try expect(me[0].headers["DPoP"] != nil && me[0].headers["Authorization"]?.hasPrefix("Bearer at_test_") == true, "agents/me lacked DPoP auth")
        let tokenBody = try JSONSerialization.jsonObject(with: mesh.requests.first { $0.url.path == "/api/v1/identity/tokens" }!.body) as? [String: Any]
        try expect(tokenBody?["requested_scopes"] as? [String] == ["agent.read", "agent.write"], "scopes are not the bounds")
        try expect(mesh.requests.allSatisfy { !$0.url.path.contains("register") && !$0.url.path.contains("admission") }, "self-registration attempted")

        let reader = try V1TestCustody.memoryAgent(profile: "reader", handle: "reader-one", fill: "b", scopes: ["agent.read"])
        let readerMesh = FakeV1Mesh(agents: [reader])
        _ = try await VerifiedCredentialGate(resolver: V1TestCustody.resolver([reader]), transport: readerMesh).credential(for: reader.profile)
        let readerBody = try JSONSerialization.jsonObject(with: readerMesh.requests.first { $0.url.path == "/api/v1/identity/tokens" }!.body) as? [String: Any]
        try expect(readerBody?["requested_scopes"] as? [String] == ["agent.read"], "read-only agent over-requested")
    }

    public static func gateFailures() async throws {
        let agent = try V1TestCustody.memoryAgent(profile: "codex", handle: "codex-one", fill: "a")
        let resolver = V1TestCustody.resolver([agent])
        func check(_ expected: VerifiedCredentialGateError, _ mesh: FakeV1Mesh, _ message: String) async throws {
            do {
                _ = try await VerifiedCredentialGate(resolver: resolver, transport: mesh).credential(for: agent.profile)
                throw ContractFailure("\(message): gate passed")
            } catch let error as VerifiedCredentialGateError {
                try expect(error == expected, "\(message): got \(error)")
            }
        }
        let paused = FakeV1Mesh(agents: [agent]); paused.update(agent.workloadID) { $0.state = "paused" }
        try await check(.agentPaused, paused, "paused state")
        let pausedCode = FakeV1Mesh(agents: [agent]); pausedCode.mode = .meStatus(403, body: #"{"error":"agent_paused"}"#)
        try await check(.agentPaused, pausedCode, "agent_paused code")
        let refused = FakeV1Mesh(agents: [agent]); refused.mode = .refuseTokens(code: "invalid_workload_proof", status: 401)
        try await check(.credentialRefused, refused, "refused proof")
        let limited = FakeV1Mesh(agents: [agent]); limited.mode = .refuseTokens(code: "rate_limited", status: 429)
        try await check(.verificationFailed, limited, "rate limited")
        let forbidden = FakeV1Mesh(agents: [])
        try await check(.credentialRefused, forbidden, "unknown workload")
        let offline = FakeV1Mesh(agents: [agent]); offline.mode = .offline
        try await check(.offline, offline, "offline")
        let mismatch = FakeV1Mesh(agents: [agent]); mismatch.update(agent.workloadID) { $0.reportedAgentID = "agent_" + V1TestCustody.hex("f") }
        try await check(.identityMismatch, mismatch, "id mismatch")
        let leaky = FakeV1Mesh(agents: [agent]); leaky.mode = .meStatus(500, body: #"{"error":"secret_token_abc"}"#)
        try await check(.verificationFailed, leaky, "unknown upstream code")
        do {
            _ = try await VerifiedCredentialGate(resolver: InMemoryV1AgentResolver(), transport: FakeV1Mesh(agents: [])).credential(for: agent.profile)
            throw ContractFailure("unbound profile passed")
        } catch VerifiedCredentialGateError.profileNotFound {}
    }

    public static func gateRetriesStaleToken() async throws {
        let agent = try V1TestCustody.memoryAgent(profile: "codex", handle: "codex-one", fill: "a")
        let mesh = FakeV1Mesh(agents: [agent])
        let manager = try WorkloadTokenManager(origin: agent.material.origin, workloadRecord: agent.material.workloadRecord, transport: mesh)
        let client = MeshClient(transport: mesh)
        _ = try await client.agentSelf(origin: agent.material.origin, auth: manager)
        // Server forgets the token (e.g. revoked session); the next call must re-exchange once.
        let stale = FakeV1Mesh(agents: [agent])
        let staleManager = try WorkloadTokenManager(origin: agent.material.origin, workloadRecord: agent.material.workloadRecord, transport: StaleOnce(inner: stale))
        let me = try await MeshClient(transport: StaleOnce(inner: stale)).agentSelf(origin: agent.material.origin, auth: staleManager)
        try expect(me.agentID == agent.agentID, "retry returned wrong agent")
        try expect(stale.requestCount(path: "/api/v1/identity/tokens") == 2, "stale token was not re-exchanged exactly once")
    }

    public static func bindVerifiesBeforeWrite() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = try V1TestCustody.makeAgent(home: home, profile: "codex", handle: "codex-one", fill: "a")
        let root = home.appendingPathComponent("profiles-v1", isDirectory: true)
        let bindings = FileV1ProfileBindingStore(root: root)

        let refusing = FakeV1Mesh(agents: [agent]); refusing.mode = .refuseTokens(code: "workload_forbidden", status: 403)
        let refused = try await ProfileBindingService(bindings: bindings, transport: refusing)
            .bind(profile: agent.profile, keyFile: agent.keyFile, origin: nil)
        try expect(refused.status == .credentialRefused, "refused bind status \(refused.status)")
        try expect((try? bindings.read(for: agent.profile)) == nil, "refused bind wrote a binding")

        let mesh = FakeV1Mesh(agents: [agent])
        let bound = try await ProfileBindingService(bindings: bindings, transport: mesh)
            .bind(profile: agent.profile, keyFile: agent.keyFile, origin: nil)
        try expect(bound.status == .verified && bound.agentID == agent.agentID.value, "bind failed: \(bound.status)")
        let stored = try bindings.read(for: agent.profile)
        try expect(stored.keyFile == agent.keyFile.path && stored.origin == nil, "binding content changed")
        let file = root.appendingPathComponent("profile-" + Data("codex".utf8).map { String(format: "%02x", $0) }.joined() + ".json")
        let fileMode = (try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue
        let rootMode = (try FileManager.default.attributesOfItem(atPath: root.path)[.posixPermissions] as? NSNumber)?.intValue
        try expect(fileMode == 0o600 && rootMode == 0o700, "binding permissions are not private")
        try expect(!(try String(contentsOf: file, encoding: .utf8)).contains(agent.seed), "binding stored key material")

        let resolved = try FileV1AgentResolver(bindings: bindings).material(for: agent.profile)
        try expect(resolved.agentID == agent.agentID, "resolver did not follow the binding")
        let status = await ProfileBindingService(bindings: bindings, transport: mesh).status(profile: agent.profile)
        try expect(status.status == .verified, "status after bind: \(status.status)")

        try ProfileBindingService(bindings: bindings, transport: mesh).unbind(profile: agent.profile)
        let after = await ProfileBindingService(bindings: bindings, transport: mesh).status(profile: agent.profile)
        try expect(after.status == .profileNotFound && after.operatorAction == .bindProfile, "unbind left a binding")
        try expect(FileManager.default.fileExists(atPath: agent.keyFile.path), "unbind touched triangle custody")
    }

    public static func bindRefusesReplacement() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let first = try V1TestCustody.makeAgent(home: home, profile: "codex", handle: "codex-one", fill: "a")
        let second = try V1TestCustody.makeAgent(home: home, profile: "codex", handle: "codex-two", fill: "b")
        let bindings = FileV1ProfileBindingStore(root: home.appendingPathComponent("profiles-v1"))
        let mesh = FakeV1Mesh(agents: [first, second])
        let service = ProfileBindingService(bindings: bindings, transport: mesh)
        _ = try await service.bind(profile: first.profile, keyFile: first.keyFile, origin: nil)
        let replaced = try await service.bind(profile: first.profile, keyFile: second.keyFile, origin: nil)
        try expect(replaced.status == .identityMismatch && replaced.agentID == first.agentID.value, "replacement was not refused")
        try expect(try bindings.read(for: first.profile).keyFile == first.keyFile.path, "binding was replaced")
        // Rebinding the same agent (e.g. new origin) is allowed.
        let rebound = try await service.bind(profile: first.profile, keyFile: first.keyFile, origin: nil)
        try expect(rebound.status == .verified, "same-agent rebind refused")
    }

    public static func bindingStoreHardening() async throws {
        let home = try V1TestCustody.temporaryHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let upper = try V1TestCustody.makeAgent(home: home, profile: "Foo", handle: "foo-upper", fill: "a")
        let other = try V1TestCustody.makeAgent(home: home, profile: "foo", handle: "foo-lower", fill: "b")
        let root = home.appendingPathComponent("profiles-v1", isDirectory: true)
        let bindings = FileV1ProfileBindingStore(root: root)
        let mesh = FakeV1Mesh(agents: [upper, other])
        let service = ProfileBindingService(bindings: bindings, transport: mesh)

        // Case variants never share a binding (case-insensitive APFS).
        _ = try await service.bind(profile: upper.profile, keyFile: upper.keyFile, origin: nil)
        let lower = try ProfileName("foo")
        try expect((try? bindings.read(for: lower)) == nil, "foo resolved Foo's binding")
        try expect(try bindings.profiles() == [upper.profile], "profile listing lost the exact name")
        try expectThrows("unbind of foo removed Foo") { try service.unbind(profile: lower) }
        try expect((try? bindings.read(for: upper.profile)) != nil, "Foo's binding disappeared")

        // A binding whose key no longer loads is not silently replaced.
        let movedKey = upper.keyFile.deletingLastPathComponent().appendingPathComponent("moved.json")
        try FileManager.default.moveItem(at: upper.keyFile, to: movedKey)
        let replaced = try await service.bind(profile: upper.profile, keyFile: other.keyFile, origin: nil)
        try expect(replaced.status == .identityMismatch, "unloadable binding was replaced: \(replaced.status)")
        try expect(try bindings.read(for: upper.profile).keyFile == upper.keyFile.path, "binding was overwritten")
        try FileManager.default.moveItem(at: movedKey, to: upper.keyFile)

        // Custody parents must be private, real directories.
        let agentsDirectory = home.appendingPathComponent("agents", isDirectory: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: agentsDirectory.path)
        try expectThrows("shared agents directory accepted") { try V1AgentCredentialLoader.load(keyFile: upper.keyFile) }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: agentsDirectory.path)
        let alias = home.appendingPathComponent("alias", isDirectory: true)
        try FileManager.default.createDirectory(at: alias.appendingPathComponent("agents"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let linked = alias.appendingPathComponent("agents/\(upper.agentID.value)")
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: upper.keyFile.deletingLastPathComponent())
        try expectThrows("symlinked agent directory accepted") {
            try V1AgentCredentialLoader.load(keyFile: linked.appendingPathComponent("workload-key.json"))
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
        try expectThrows("shared bindings directory accepted") { try bindings.read(for: upper.profile) }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)

        // Read-only agents verify but cannot run mailbox workers.
        let reader = try V1TestCustody.makeAgent(home: home, profile: "reader", handle: "reader-one", fill: "c", bounds: ["agent.read"])
        let credential = try await VerifiedCredentialGate(resolver: V1TestCustody.resolver([reader]), transport: FakeV1Mesh(agents: [reader])).credential(for: reader.profile)
        try expect(!credential.canWrite, "read-only agent reported write access")
    }

    public static func statusRendersPermissions() async throws {
        let agent = try V1TestCustody.memoryAgent(profile: "codex", handle: "codex-one", fill: "a")
        let status = ProfileStatus(profile: agent.profile, material: agent.material, status: .verified, permissions: ["dm_owner": true, "join_rooms": false], permissionsRevision: 7)
        let rendered = try OperatorStatusRenderer.render(status, verificationTimestamp: Date(timeIntervalSince1970: 1_787_961_600))
        let object = try JSONSerialization.jsonObject(with: rendered.stdout) as? [String: Any]
        try expect(Set(object?.keys ?? [:].keys) == ["profile", "origin", "agentId", "handle", "lifecycle", "verificationTimestamp", "operatorAction", "permissions", "permissionsRevision"], "status keys changed")
        try expect((object?["permissions"] as? [String: Bool]) == ["dm_owner": true, "join_rooms": false], "permissions missing")
        try expect(object?["permissionsRevision"] as? Int == 7 && rendered.exitCode == 0, "revision missing")
        let paused = ProfileStatus.failure(profile: agent.profile, material: agent.material, error: .agentPaused)
        let pausedRendered = try OperatorStatusRenderer.render(paused)
        let pausedObject = try JSONSerialization.jsonObject(with: pausedRendered.stdout) as? [String: Any]
        try expect(pausedObject?["lifecycle"] as? String == "agent_paused" && pausedObject?["operatorAction"] as? String == "resume_agent", "paused not rendered")
        try expect(pausedObject?["permissions"] == nil && pausedRendered.exitCode == 1, "unverified status claimed permissions")
        for output in [rendered.stdout, pausedRendered.stdout] {
            try expect(!String(decoding: output, as: UTF8.self).contains(agent.seed), "status exposed key")
        }
    }

    public static func redaction() async throws {
        let agent = try V1TestCustody.memoryAgent(profile: "codex", handle: "codex-one", fill: "a")
        let credential = VerifiedCredential(material: agent.material)
        var dumps = ""
        dump(agent.material, to: &dumps)
        dump(credential, to: &dumps)
        let outputs = [
            String(describing: agent.material), String(reflecting: agent.material),
            String(describing: credential), String(reflecting: credential), dumps,
        ]
        for output in outputs {
            try expect(!output.contains(agent.seed), "diagnostic exposed workload key")
        }
    }

    private static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw ContractFailure(message) }
    }

    private static func expectThrows<Result>(_ message: String, _ operation: () throws -> Result) throws {
        do {
            _ = try operation()
        } catch {
            return
        }
        throw ContractFailure(message)
    }
}

/// Answers the first `agents/me` with 401 so the caller must re-exchange.
private final class StaleOnce: MeshTransport, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var tripped: Set<ObjectIdentifier> = []
    let inner: FakeV1Mesh
    init(inner: FakeV1Mesh) { self.inner = inner }
    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        if request.url.path == "/api/v1/agents/me" {
            let first = Self.lock.withLock { Self.tripped.insert(ObjectIdentifier(inner)).inserted }
            if first {
                _ = try await inner.send(request)
                return FakeV1Mesh.json(401, ["error": "agent_auth_required"], request)
            }
        }
        return try await inner.send(request)
    }
}
