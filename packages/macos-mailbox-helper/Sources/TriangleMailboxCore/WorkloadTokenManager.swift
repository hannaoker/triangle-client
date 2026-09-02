import CryptoKit
import Foundation

public enum WorkloadTokenManagerError: Error, Equatable, Sendable {
    case missingWorkloadID
    case invalidResponse
    case tokenExchangeFailed(statusCode: Int)
    case challengeFailed(statusCode: Int)
}

public final class WorkloadTokenManager: @unchecked Sendable {
    private static let requestedScopes = ["mailbox.read", "mailbox.write"]
    private static let proofProfile = "mesh.workload-token-proof/1"

    private let origin: MeshOrigin
    private let workloadID: WorkloadID
    private let privateKey: Curve25519.Signing.PrivateKey
    private let publicJWK: WorkloadPublicJWK
    private let transport: any MeshTransport
    private let lock = NSLock()
    private var cachedToken: String?
    private var cachedTokenExpiresAt: TimeInterval = 0
    private var refreshTask: Task<String, Error>?

    public init(
        origin: MeshOrigin,
        workloadRecord: WorkloadKeyRecord,
        transport: any MeshTransport
    ) throws {
        guard let workloadID = workloadRecord.workloadID else {
            throw WorkloadTokenManagerError.missingWorkloadID
        }
        self.origin = origin
        self.workloadID = workloadID
        self.privateKey = workloadRecord.privateKey
        self.publicJWK = WorkloadPublicJWK(publicKey: workloadRecord.privateKey.publicKey)
        self.transport = transport
    }

    public var activeAccessToken: String? {
        lock.withLock { cachedToken }
    }

    public func authorizationHeaders(method: String, url: URL) async throws -> [String: String] {
        let token = try await fetchToken()
        let dpop = try createDpopProof(method: method, url: url, accessToken: token)
        return [
            "Authorization": "Bearer \(token)",
            "DPoP": dpop,
        ]
    }

    func fetchToken() async throws -> String {
        let now = Date().timeIntervalSince1970
        if let cached = lock.withLock({ () -> String? in
            if let cachedToken, cachedTokenExpiresAt - 30 > now {
                return cachedToken
            }
            return nil
        }) {
            return cached
        }

        if let existing = lock.withLock({ refreshTask }) {
            return try await existing.value
        }

        let task = Task<String, Error> {
            defer { lock.withLock { refreshTask = nil } }
            return try await exchangeToken()
        }
        lock.withLock { refreshTask = task }
        return try await task.value
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
            ("requested_scopes", scopesJSON(Self.requestedScopes)),
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
            "requested_scopes": Self.requestedScopes,
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
            throw WorkloadTokenManagerError.tokenExchangeFailed(statusCode: response.statusCode)
        }

        let payload = try decodeTokenResponse(response.body)
        let lifetime = TimeInterval(payload.expiresIn ?? 300)
        lock.withLock {
            cachedToken = payload.accessToken
            cachedTokenExpiresAt = Date().timeIntervalSince1970 + lifetime
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
            ("jti", RFC8785CanonicalJSON.escapeString(UUID().uuidString)),
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
              !accessToken.isEmpty
        else {
            throw WorkloadTokenManagerError.invalidResponse
        }
        let expiresIn = object["expires_in"] as? Int
        return WorkloadTokenResponsePayload(accessToken: accessToken, expiresIn: expiresIn)
    }
}
