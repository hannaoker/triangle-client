import CryptoKit
import Foundation
import TriangleMailboxCore

/// One throwaway agent laid out exactly like `triangle` custody
/// (`<home>/agents/<agent_id>/{agent.json,workload-key.json}`, 0600).
public struct V1TestAgent: Sendable {
    public let profile: ProfileName
    public let material: V1AgentMaterial
    public var agentID: AgentID { material.agentID }
    public var handle: MailboxHandle { material.handle }
    public var workloadID: WorkloadID { material.workloadID }
    public var keyFile: URL { material.keyFile }
    public var seed: String { material.workloadPrivateKeySeed }
}

public enum V1TestCustody {
    public static func temporaryHome() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("triangle-v1-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return root
    }

    public static func hex(_ fill: Character) -> String { String(repeating: fill, count: 32) }

    /// Write one agent into `home`. `fill` picks a deterministic id (`agent_<fill*32>`).
    @discardableResult
    public static func makeAgent(
        home: URL,
        profile: String,
        handle: String,
        fill: Character,
        bounds: [String] = V1AgentMaterial.agentBounds,
        authority: String = "https://thetriangle.dev",
        via: String? = nil
    ) throws -> V1TestAgent {
        let agentID = "agent_" + hex(fill)
        let workloadID = "workload_" + hex(fill)
        let directory = home.appendingPathComponent("agents/\(agentID)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let key = Curve25519.Signing.PrivateKey()
        let jwk: [String: String] = [
            "kty": "OKP", "crv": "Ed25519",
            "x": Base64URL.encode(key.publicKey.rawRepresentation),
            "d": Base64URL.encode(key.rawRepresentation),
        ]
        try writePrivate(directory.appendingPathComponent("workload-key.json"), JSONSerialization.data(withJSONObject: jwk, options: [.sortedKeys]))
        let agent: [String: Any] = [
            "agent_id": agentID, "handle": handle, "name": handle, "workload_id": workloadID,
            "bounds": bounds, "authority": authority, "created_at": "2026-10-18T00:00:00.000Z",
        ]
        try writePrivate(directory.appendingPathComponent("agent.json"), JSONSerialization.data(withJSONObject: agent, options: [.sortedKeys]))
        if let via {
            try writePrivate(
                home.appendingPathComponent("authority.json"),
                JSONSerialization.data(withJSONObject: ["authority": authority, "via": via, "joined_at": "2026-10-18T00:00:00.000Z"], options: [.sortedKeys])
            )
        }
        let material = try V1AgentCredentialLoader.load(keyFile: directory.appendingPathComponent("workload-key.json"))
        return V1TestAgent(profile: try ProfileName(profile), material: material)
    }

    public static func writePrivate(_ url: URL, _ data: Data, mode: Int = 0o600) throws {
        FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: mode])
        try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
    }

    /// An in-memory resolver holding these agents (no files consulted after load).
    public static func resolver(_ agents: [V1TestAgent]) -> InMemoryV1AgentResolver {
        let resolver = InMemoryV1AgentResolver()
        for agent in agents { resolver.set(agent.material, for: agent.profile) }
        return resolver
    }

    /// Convenience: one in-memory agent with no backing files (key file path is synthetic).
    public static func memoryAgent(
        profile: String, handle: String, fill: Character, origin: String = "https://thetriangle.dev",
        scopes: [String] = V1AgentMaterial.agentBounds
    ) throws -> V1TestAgent {
        let agentID = try AgentID("agent_" + hex(fill))
        let originValue = try MeshOrigin(origin, allowLoopbackHTTPForTests: true)
        let material = V1AgentMaterial(
            agentID: agentID, handle: try MailboxHandle(handle), workloadID: try WorkloadID("workload_" + hex(fill)),
            // Same fill -> same agent -> same key (deterministic, test-only).
            privateKey: try Curve25519.Signing.PrivateKey(rawRepresentation: Data(SHA256.hash(data: Data("triangle-v1-test-\(fill)".utf8)))),
            scopes: scopes, authority: originValue, origin: originValue,
            keyFile: URL(fileURLWithPath: "/tmp/triangle-v1-test/agents/\(agentID.value)/workload-key.json")
        )
        return V1TestAgent(profile: try ProfileName(profile), material: material)
    }
}

/// A fake MESH v1 identity plane: token challenges, DPoP token exchange with
/// a verified proof, and `GET /api/v1/agents/me`. Anything else goes to `fallback`.
public final class FakeV1Mesh: MeshTransport, @unchecked Sendable {
    public struct AgentState: Sendable {
        public var agent: V1TestAgent
        public var state: String = "active"
        public var permissions: [String: Bool] = ["dm_owner": true, "join_rooms": true]
        public var revision: Int = 1
        /// Report a different id/handle from `/agents/me` (identity mismatch tests).
        public var reportedAgentID: String?
        public var reportedHandle: String?
    }

    public enum Mode: Sendable {
        case normal
        case offline
        case refuseTokens(code: String, status: Int)
        case meStatus(Int, body: String)
    }

    private let lock = NSLock()
    private var agents: [String: AgentState] = [:]
    private var tokens: [String: String] = [:]
    private var challenges: [String: String] = [:]
    private var counter = 0
    private var _mode: Mode = .normal
    private var _tokenLifetime = 300
    private var _requests: [MeshHTTPRequest] = []
    public let fallback: (@Sendable (MeshHTTPRequest) async throws -> MeshHTTPResponse)?

    public init(agents: [V1TestAgent], fallback: (@Sendable (MeshHTTPRequest) async throws -> MeshHTTPResponse)? = nil) {
        for agent in agents { self.agents[agent.workloadID.value] = AgentState(agent: agent) }
        self.fallback = fallback
    }

    public var mode: Mode {
        get { lock.withLock { _mode } }
        set { lock.withLock { _mode = newValue } }
    }

    /// `expires_in` of the tokens this fake issues (seconds).
    public var tokenLifetime: Int {
        get { lock.withLock { _tokenLifetime } }
        set { lock.withLock { _tokenLifetime = newValue } }
    }

    /// Forget every issued token, as a server-side revocation would: they now get 401.
    public func revokeIssuedTokens() {
        lock.withLock { tokens.removeAll() }
    }

    public func update(_ workloadID: WorkloadID, _ change: (inout AgentState) -> Void) {
        lock.withLock {
            if var state = agents[workloadID.value] { change(&state); agents[workloadID.value] = state }
        }
    }

    public var requests: [MeshHTTPRequest] { lock.withLock { _requests } }
    public var issuedTokens: [String] { lock.withLock { Array(tokens.keys) } }
    public func requestCount(path: String) -> Int { requests.filter { $0.url.path == path }.count }

    /// The workload id behind an access token presented with a DPoP proof, if any.
    public func workload(forAuthorization headers: [String: String]) -> String? {
        guard let auth = headers["Authorization"], auth.hasPrefix("Bearer "), headers["DPoP"] != nil else { return nil }
        return lock.withLock { tokens[String(auth.dropFirst(7))] }
    }

    public func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        lock.withLock { _requests.append(request) }
        if case .offline = mode { throw MeshClientError.transportUnavailable }
        switch (request.method, request.url.path) {
        case ("POST", "/api/v1/identity/token-challenges"):
            return challenge(request)
        case ("POST", "/api/v1/identity/tokens"):
            return token(request)
        case ("GET", "/api/v1/agents/me"):
            return me(request)
        default:
            if let fallback { return try await fallback(request) }
            return Self.json(404, ["error": "not_found"], request)
        }
    }

    private func challenge(_ request: MeshHTTPRequest) -> MeshHTTPResponse {
        guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let workloadID = body["workload_id"] as? String
        else { return Self.json(400, ["error": "invalid_request"], request) }
        return lock.withLock {
            guard let state = agents[workloadID] else { return Self.json(403, ["error": "workload_forbidden"], request) }
            counter += 1
            let id = "chal_\(counter)"
            challenges[id] = workloadID
            let origin = request.url.scheme! + "://" + request.url.host! + (request.url.port.map { ":\($0)" } ?? "")
            return Self.json(201, ["challenge": [
                "challenge_id": id, "principal_id": state.agent.agentID.value,
                "audience": origin, "nonce": "nonce_\(counter)",
            ]], request)
        }
    }

    private func token(_ request: MeshHTTPRequest) -> MeshHTTPResponse {
        if case .refuseTokens(let code, let status) = mode { return Self.json(status, ["error": code], request) }
        guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let challengeID = body["challenge_id"] as? String,
              let proof = body["proof"] as? String,
              let scopes = body["requested_scopes"] as? [String]
        else { return Self.json(400, ["error": "invalid_request"], request) }
        return lock.withLock {
            guard let workloadID = challenges.removeValue(forKey: challengeID), let state = agents[workloadID] else {
                return Self.json(401, ["error": "invalid_workload_proof"], request)
            }
            let parts = proof.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 3, let signature = Base64URL.decode(parts[2]),
                  state.agent.material.privateKey.publicKey.isValidSignature(signature, for: Data("\(parts[0]).\(parts[1])".utf8)),
                  Set(scopes).isSubset(of: Set(state.agent.material.scopes))
            else { return Self.json(401, ["error": "invalid_workload_proof"], request) }
            counter += 1
            let token = "at_test_\(counter)_" + UUID().uuidString.lowercased()
            tokens[token] = workloadID
            return Self.json(200, ["access_token": token, "token_type": "DPoP", "expires_in": _tokenLifetime], request)
        }
    }

    private func me(_ request: MeshHTTPRequest) -> MeshHTTPResponse {
        if case .meStatus(let status, let body) = mode {
            return MeshHTTPResponse(statusCode: status, headers: ["Content-Type": "application/json"], body: Data(body.utf8), finalURL: request.url)
        }
        guard let workloadID = workload(forAuthorization: request.headers) else {
            return Self.json(401, ["error": "agent_auth_required"], request)
        }
        return lock.withLock {
            guard let state = agents[workloadID] else { return Self.json(401, ["error": "agent_auth_required"], request) }
            return Self.json(200, [
                "agent": ["id": state.reportedAgentID ?? state.agent.agentID.value, "handle": state.reportedHandle ?? state.agent.handle.value],
                "state": state.state,
                "permissions": state.permissions,
                "revision": state.revision,
            ], request)
        }
    }

    public static func json(_ status: Int, _ object: Any, _ request: MeshHTTPRequest) -> MeshHTTPResponse {
        MeshHTTPResponse(
            statusCode: status,
            headers: ["Content-Type": "application/json"],
            body: (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data(),
            finalURL: request.url
        )
    }
}
