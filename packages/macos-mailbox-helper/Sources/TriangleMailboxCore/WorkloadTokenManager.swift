import CryptoKit
import Foundation

public enum WorkloadTokenManagerError: Error, Equatable, Sendable {
    case missingWorkloadID
    case invalidResponse
    case tokenExchangeFailed(statusCode: Int)
    case challengeFailed(statusCode: Int)
    /// MESH refused the exchange with an allowlisted v1 code (never free text).
    case refused(code: String, statusCode: Int)
    /// The request URL is not on the origin this token was minted for.
    case originMismatch
}

extension MeshOrigin {
    /// True when `url` has exactly this scheme, host and port.
    public func matches(_ url: URL) -> Bool {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(),
              components.user == nil, components.password == nil
        else { return false }
        components.scheme = scheme
        components.host = host
        components.path = ""
        components.percentEncodedQuery = nil
        components.percentEncodedFragment = nil
        return components.string == rawValue
    }
}

/// v1 workload error codes the helper may surface; anything else is reported by status only.
public enum MeshWorkloadErrorCode {
    public static let allowlisted: Set<String> = [
        "agent_auth_required", "agent_paused", "dpop_replay", "invalid_workload_proof",
        "permission_denied", "rate_limited", "workload_forbidden",
    ]

    /// The allowlisted `error` of a MESH JSON error body, if any.
    public static func code(in body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let code = object["error"] as? String, allowlisted.contains(code) else { return nil }
        return code
    }

    /// The permission key of a `permission_denied` body (a catalog key, never free text).
    public static func permission(in body: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              object["error"] as? String == "permission_denied",
              let key = object["permission"] as? String,
              key.utf8.count <= 64, key.wholeMatch(of: /^[a-z]+(?:\.[a-z_]+)+$/) != nil else { return nil }
        return key
    }
}

public final class WorkloadTokenManager: @unchecked Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    private static let proofProfile = "mesh.workload-token-proof/1"
    /// A token with less than this much life left is exchanged again.
    static let refreshMargin: TimeInterval = 30

    private let origin: MeshOrigin
    private let workloadID: WorkloadID
    private let privateKey: Curve25519.Signing.PrivateKey
    private let publicJWK: WorkloadPublicJWK
    private let transport: any MeshTransport
    /// v1 scopes: the workload's bounds (`agent.read`, `agent.write`).
    private let requestedScopes: [String]
    /// Tokens other helper processes exchanged for this exact workload key, shared
    /// through storage. Nil keeps a token for this process only.
    private let tokenCache: (any WorkloadTokenCache)?
    private let cacheKey: WorkloadTokenCacheKey
    private let clock: @Sendable () -> TimeInterval
    private let lock = NSLock()
    private var cachedToken: String?
    private var cachedTokenExpiresAt: TimeInterval = 0
    private var refreshTask: Task<String, Error>?

    public init(
        origin: MeshOrigin,
        workloadRecord: WorkloadKeyRecord,
        transport: any MeshTransport,
        tokenCache: (any WorkloadTokenCache)? = nil,
        clock: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) throws {
        guard let workloadID = workloadRecord.workloadID else {
            throw WorkloadTokenManagerError.missingWorkloadID
        }
        self.origin = origin
        self.workloadID = workloadID
        self.privateKey = workloadRecord.privateKey
        self.publicJWK = WorkloadPublicJWK(publicKey: workloadRecord.privateKey.publicKey)
        self.transport = transport
        self.requestedScopes = V1AgentMaterial.agentBounds.filter { workloadRecord.scopes.contains($0) }
        guard !requestedScopes.isEmpty else { throw WorkloadTokenManagerError.invalidResponse }
        self.tokenCache = tokenCache
        self.clock = clock
        self.cacheKey = WorkloadTokenCacheKey(
            origin: origin, workloadID: workloadID, keyThumbprint: publicJWK.jkt, scopes: requestedScopes
        )
    }

    /// Drop a token MESH refused (401), here and in the shared cache, so the next call
    /// exchanges a fresh one. A different token another process stored since stays.
    public func invalidate(_ token: String) {
        lock.withLock {
            if cachedToken == token {
                cachedToken = nil
                cachedTokenExpiresAt = 0
            }
        }
        tokenCache?.remove(for: cacheKey, ifToken: token)
    }

    public var activeAccessToken: String? {
        lock.withLock { cachedToken }
    }

    /// The manager holds a signing key and a live bearer token; neither is ever printed.
    public var description: String { "WorkloadTokenManager(origin: \(origin.value), key: <redacted>, token: <redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["origin": origin.value, "key": "<redacted>", "token": "<redacted>"], displayStyle: .class)
    }

    /// A transport that drops this manager's token whenever MESH answers a request
    /// that carried it with a 401, whichever call site sent the request.
    public func observingRefusals(of transport: any MeshTransport) -> any MeshTransport {
        TokenRefusalObservingTransport(base: transport, auth: self)
    }

    public func authorizationHeaders(method: String, url: URL) async throws -> [String: String] {
        // A token never leaves the origin it was minted for (e.g. a preview
        // `via` member's token must not be sent to a production actor host).
        guard origin.matches(url) else { throw WorkloadTokenManagerError.originMismatch }
        let token = try await fetchToken()
        let dpop = try createDpopProof(method: method, url: url, accessToken: token)
        return [
            "Authorization": "Bearer \(token)",
            "DPoP": dpop,
        ]
    }

    func fetchToken() async throws -> String {
        let now = clock()
        // Create/publish the refresh task in one critical section so a finished
        // task cannot clear refreshTask before it is assigned (single-flight race).
        let task: Task<String, Error> = lock.withLock {
            if let cachedToken, cachedTokenExpiresAt - Self.refreshMargin > now {
                let token = cachedToken
                return Task { token }
            }
            if let existing = refreshTask {
                return existing
            }
            let created = Task<String, Error> {
                do {
                    let token = try await self.sharedTokenOrExchange()
                    self.lock.withLock { self.refreshTask = nil }
                    return token
                } catch {
                    self.lock.withLock { self.refreshTask = nil }
                    throw error
                }
            }
            refreshTask = created
            return created
        }
        return try await task.value
    }

    /// A token another helper process already exchanged for this key and that still
    /// has life left, else a fresh exchange. Anything wrong with the shared cache is
    /// a miss, so the cost of a bad cache is one exchange: today's behavior.
    private func sharedTokenOrExchange() async throws -> String {
        let now = clock()
        if let tokenCache,
           let shared = tokenCache.load(for: cacheKey, now: now),
           shared.isUsable(at: now, margin: Self.refreshMargin) {
            lock.withLock {
                cachedToken = shared.accessToken
                cachedTokenExpiresAt = shared.expiresAt
            }
            return shared.accessToken
        }
        return try await exchangeToken()
    }

    private func exchangeToken() async throws -> String {
        let challenge = try await requestChallenge()
        guard let audience = challenge.audience ?? challenge.origin else {
            throw WorkloadTokenManagerError.invalidResponse
        }
        let proofPayload = compactJSONObject([
            ("audience", RFC8785CanonicalJSON.escapeString(audience)),
            ("challenge_id", RFC8785CanonicalJSON.escapeString(challenge.challengeID)),
            ("nonce", RFC8785CanonicalJSON.escapeString(challenge.nonce)),
            ("principal_id", RFC8785CanonicalJSON.escapeString(challenge.principalID)),
            ("profile", RFC8785CanonicalJSON.escapeString(Self.proofProfile)),
            ("requested_scopes", scopesJSON(requestedScopes)),
            ("workload_id", RFC8785CanonicalJSON.escapeString(workloadID.value)),
        ])
        let proofHeader = compactJSONObject([
            ("alg", "\"EdDSA\""),
            ("kid", RFC8785CanonicalJSON.escapeString(workloadID.value)),
            ("typ", "\"mesh-workload-proof+jwt\""),
        ])
        let proof = try signJWS(headerJSON: proofHeader, payloadJSON: proofPayload)

        guard let tokenURL = URL(string: origin.value + "/api/v1/identity/tokens") else {
            throw WorkloadTokenManagerError.invalidResponse
        }
        let body = try JSONSerialization.data(withJSONObject: [
            "challenge_id": challenge.challengeID,
            "requested_scopes": requestedScopes,
            "proof": proof,
        ] as [String: Any], options: [.sortedKeys])
        guard body.count <= MeshClient.maximumRequestBytes else {
            throw WorkloadTokenManagerError.invalidResponse
        }

        let response = try await transport.send(MeshHTTPRequest(
            method: "POST",
            url: tokenURL,
            headers: [
                "Accept": "application/json",
                "Content-Type": "application/json",
            ],
            body: body
        ))
        guard (200...299).contains(response.statusCode),
              response.body.count <= MeshClient.maximumResponseBytes,
              response.finalURL.absoluteString == tokenURL.absoluteString
        else {
            if let code = MeshWorkloadErrorCode.code(in: response.body) {
                throw WorkloadTokenManagerError.refused(code: code, statusCode: response.statusCode)
            }
            throw WorkloadTokenManagerError.tokenExchangeFailed(statusCode: response.statusCode)
        }

        let payload = try decodeTokenResponse(response.body)
        let lifetime = TimeInterval(payload.expiresIn ?? 300)
        let issuedAt = clock()
        lock.withLock {
            cachedToken = payload.accessToken
            cachedTokenExpiresAt = issuedAt + lifetime
        }
        // Best effort: a token that cannot be shared is still used by this process.
        // One that would not be reusable anyway (about to expire, or a lifetime
        // beyond the cache bound) is not written.
        let shareable = CachedWorkloadToken(accessToken: payload.accessToken, issuedAt: issuedAt, expiresAt: issuedAt + lifetime)
        if shareable.isUsable(at: issuedAt, margin: Self.refreshMargin) {
            tokenCache?.store(shareable, for: cacheKey)
        }
        return payload.accessToken
    }

    private func requestChallenge() async throws -> WorkloadTokenChallengePayload {
        guard let challengeURL = URL(string: origin.value + "/api/v1/identity/token-challenges") else {
            throw WorkloadTokenManagerError.invalidResponse
        }
        let body = try JSONSerialization.data(withJSONObject: [
            "workload_id": workloadID.value,
        ], options: [.sortedKeys])
        let response = try await transport.send(MeshHTTPRequest(
            method: "POST",
            url: challengeURL,
            headers: [
                "Accept": "application/json",
                "Content-Type": "application/json",
            ],
            body: body
        ))
        guard (200...299).contains(response.statusCode),
              response.body.count <= MeshClient.maximumResponseBytes,
              response.finalURL.absoluteString == challengeURL.absoluteString
        else {
            if let code = MeshWorkloadErrorCode.code(in: response.body) {
                throw WorkloadTokenManagerError.refused(code: code, statusCode: response.statusCode)
            }
            throw WorkloadTokenManagerError.challengeFailed(statusCode: response.statusCode)
        }
        return try decodeChallengeResponse(response.body)
    }

    private func createDpopProof(method: String, url: URL, accessToken: String) throws -> String {
        guard url.user == nil, url.password == nil, url.fragment == nil else {
            throw WorkloadTokenManagerError.invalidResponse
        }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.fragment = nil
        guard let htu = components?.url?.absoluteString else {
            throw WorkloadTokenManagerError.invalidResponse
        }
        let athDigest = SHA256.hash(data: Data(accessToken.utf8))
        let ath = Base64URL.encode(Data(athDigest))
        let jwkJSON = publicJWK.canonicalJSONString
        let headerJSON = "{\"alg\":\"EdDSA\",\"jwk\":\(jwkJSON),\"typ\":\"dpop+jwt\"}"
        let payloadJSON = compactJSONObject([
            ("ath", RFC8785CanonicalJSON.escapeString(ath)),
            ("htm", RFC8785CanonicalJSON.escapeString(method.uppercased())),
            ("htu", RFC8785CanonicalJSON.escapeString(htu)),
            ("iat", String(Int(Date().timeIntervalSince1970))),
            ("jti", RFC8785CanonicalJSON.escapeString("proof_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())),
        ])
        return try signJWS(headerJSON: headerJSON, payloadJSON: payloadJSON)
    }

    private func signJWS(headerJSON: String, payloadJSON: String) throws -> String {
        let encodedHeader = Base64URL.encode(Data(headerJSON.utf8))
        let encodedPayload = Base64URL.encode(Data(payloadJSON.utf8))
        let signingInput = "\(encodedHeader).\(encodedPayload)"
        let signature = try privateKey.signature(for: Data(signingInput.utf8))
        return "\(signingInput).\(Base64URL.encode(signature))"
    }

    private func compactJSONObject(_ members: [(String, String)]) -> String {
        "{" + members.map { "\"\($0.0)\":\($0.1)" }.joined(separator: ",") + "}"
    }

    private func scopesJSON(_ scopes: [String]) -> String {
        "[" + scopes.map { RFC8785CanonicalJSON.escapeString($0) }.joined(separator: ",") + "]"
    }

    private struct WorkloadTokenChallengePayload {
        let challengeID: String
        let principalID: String
        let origin: String?
        let audience: String?
        let nonce: String
    }

    private struct WorkloadTokenResponsePayload {
        let accessToken: String
        let expiresIn: Int?
    }

    private func decodeChallengeResponse(_ data: Data) throws -> WorkloadTokenChallengePayload {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let challenge = object["challenge"] as? [String: Any],
              let challengeID = challenge["challenge_id"] as? String,
              let principalID = challenge["principal_id"] as? String,
              let nonce = challenge["nonce"] as? String
        else {
            throw WorkloadTokenManagerError.invalidResponse
        }
        let origin = challenge["origin"] as? String
        let audience = challenge["audience"] as? String
        return WorkloadTokenChallengePayload(
            challengeID: challengeID,
            principalID: principalID,
            origin: origin,
            audience: audience,
            nonce: nonce
        )
    }

    private func decodeTokenResponse(_ data: Data) throws -> WorkloadTokenResponsePayload {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accessToken = object["access_token"] as? String,
              !accessToken.isEmpty,
              object["token_type"] as? String == "DPoP"
        else {
            throw WorkloadTokenManagerError.invalidResponse
        }
        let expiresIn = object["expires_in"] as? Int
        return WorkloadTokenResponsePayload(accessToken: accessToken, expiresIn: expiresIn)
    }
}

/// Drops the workload token MESH refused. It wraps the transport requests are sent
/// on, so every call site is covered without each one handling a 401 itself.
struct TokenRefusalObservingTransport: MeshTransport {
    let base: any MeshTransport
    let auth: WorkloadTokenManager

    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        let response = try await base.send(request)
        if response.statusCode == 401, let token = Self.bearerToken(in: request.headers) {
            auth.invalidate(token)
        }
        return response
    }

    static func bearerToken(in headers: [String: String]) -> String? {
        guard let value = headers.first(where: { $0.key.caseInsensitiveCompare("Authorization") == .orderedSame })?.value,
              value.hasPrefix("Bearer ")
        else { return nil }
        return String(value.dropFirst("Bearer ".count))
    }
}
