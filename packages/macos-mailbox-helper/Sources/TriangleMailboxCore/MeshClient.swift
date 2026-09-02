import Foundation

public struct MeshHTTPRequest: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let method: String
    public let url: URL
    public let headers: [String: String]
    public let body: Data

    public init(method: String, url: URL, headers: [String: String], body: Data = Data()) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
    }

    public var description: String { "MeshHTTPRequest(method: \(method), url: \(url.absoluteString), headers: <redacted>, body: <redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["method": method, "url": url.absoluteString, "headers": "<redacted>", "body": "<redacted>"], displayStyle: .struct)
    }
}

public struct MeshHTTPResponse: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public let statusCode: Int
    public let headers: [String: String]
    public let body: Data
    public let finalURL: URL

    public init(statusCode: Int, headers: [String: String], body: Data, finalURL: URL) {
        self.statusCode = statusCode
        self.headers = headers
        self.body = body
        self.finalURL = finalURL
    }

    public var description: String { "MeshHTTPResponse(statusCode: \(statusCode), finalURL: <redacted>, headers: <redacted>, body: <redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["statusCode": statusCode, "finalURL": "<redacted>", "headers": "<redacted>", "body": "<redacted>"], displayStyle: .struct)
    }
}

public protocol MeshTransport: Sendable {
    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse
}

public enum MeshClientError: Error, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case invalidRequest
    case plaintextOrigin
    case requestTooLarge
    case transportUnavailable
    case redirectRejected
    case crossOriginResponse
    case invalidStatus
    case invalidContentType
    case responseTooLarge
    case responseTooLargeAfterResponse(statusCode: Int)
    case invalidResponse
    case registrationResponseUnusable
    case registrationOutcomeUnknown
    case registrationRejected(statusCode: Int)

    public var description: String {
        switch self {
        case .invalidRequest: "invalid MESH request"
        case .plaintextOrigin: "plaintext MESH origin is not allowed"
        case .requestTooLarge: "MESH request is too large"
        case .transportUnavailable: "MESH is unavailable"
        case .redirectRejected: "MESH redirect was rejected"
        case .crossOriginResponse: "MESH response origin changed"
        case .invalidStatus: "MESH returned an invalid status"
        case .invalidContentType: "MESH returned an invalid content type"
        case .responseTooLarge: "MESH response is too large"
        case .responseTooLargeAfterResponse: "MESH response is too large"
        case .invalidResponse: "MESH returned an invalid response"
        case .registrationResponseUnusable: "mailbox registration succeeded but its response was unusable"
        case .registrationOutcomeUnknown: "mailbox registration outcome is unknown"
        case .registrationRejected: "mailbox registration was rejected"
        }
    }

    public var debugDescription: String { description }
}

public final class URLSessionMeshTransport: NSObject, MeshTransport, URLSessionTaskDelegate, @unchecked Sendable {
    private let configuration: URLSessionConfiguration
    private let redirectLock = NSLock()
    private var redirectEpoch = 0
    private lazy var session: URLSession = {
        let configuration = configuration.copy() as! URLSessionConfiguration
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    public override convenience init() {
        self.init(configuration: .ephemeral)
    }

    public init(configuration: URLSessionConfiguration) {
        self.configuration = configuration.copy() as! URLSessionConfiguration
        super.init()
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        redirectLock.withLock { redirectEpoch += 1 }
        completionHandler(nil)
    }

    public func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        guard request.url.scheme?.lowercased() == "https" else {
            throw MeshClientError.plaintextOrigin
        }
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body.isEmpty ? nil : request.body
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }

        let startingRedirectEpoch = redirectLock.withLock { redirectEpoch }
        do {
            let (bytes, response) = try await session.bytes(for: urlRequest)
            guard let http = response as? HTTPURLResponse, let finalURL = http.url else {
                throw MeshClientError.invalidResponse
            }
            if (300...399).contains(http.statusCode) {
                throw MeshClientError.redirectRejected
            }
            if http.expectedContentLength > MeshClient.maximumResponseBytes {
                throw MeshClientError.responseTooLargeAfterResponse(statusCode: http.statusCode)
            }
            var data = Data()
            data.reserveCapacity(min(http.expectedContentLength > 0 ? Int(http.expectedContentLength) : 0, MeshClient.maximumResponseBytes))
            for try await byte in bytes {
                guard data.count < MeshClient.maximumResponseBytes else {
                    throw MeshClientError.responseTooLargeAfterResponse(statusCode: http.statusCode)
                }
                data.append(byte)
            }
            let headers = responseHeaders(http)
            return MeshHTTPResponse(statusCode: http.statusCode, headers: headers, body: data, finalURL: finalURL)
        } catch let error as MeshClientError {
            throw error
        } catch {
            if redirectLock.withLock({ redirectEpoch > startingRedirectEpoch }) {
                throw MeshClientError.redirectRejected
            }
            throw MeshClientError.transportUnavailable
        }
    }

    private func responseHeaders(_ response: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            if let key = key as? String, let value = value as? String { headers[key] = value }
        }
        return headers
    }
}

public struct MeshClient: Sendable {
    public static let maximumRequestBytes = 16 * 1024
    public static let maximumResponseBytes = 64 * 1024

    private let transport: any MeshTransport

    public init(transport: any MeshTransport) {
        self.transport = transport
    }

    func requestChallenge(
        origin: MeshOrigin,
        admissionToken: AdmissionToken,
        handle: MailboxHandle,
        workloadID: WorkloadID,
        workloadPublicJWK: WorkloadPublicJWK
    ) async throws -> IdentityRegistrationChallenge {
        guard let url = URL(string: origin.value + "/api/v1/identity/registration-challenges") else {
            throw MeshClientError.invalidRequest
        }
        let bodyObj = ChallengeRequestBody(
            identityProfile: "mesh.identity/1",
            handle: handle.value,
            workloadID: workloadID.value,
            workloadPublicJWK: workloadPublicJWK
        )
        let body = try JSONEncoder().encode(bodyObj)
        guard body.count <= Self.maximumRequestBytes else {
            throw MeshClientError.requestTooLarge
        }
        let request = MeshHTTPRequest(
            method: "POST",
            url: url,
            headers: [
                "Accept": "application/json",
                "Content-Type": "application/json",
                "X-Mesh-Admission-Token": admissionToken.rawValue,
            ],
            body: body
        )
        let response: MeshHTTPResponse
        do {
            response = try await transport.send(request)
        } catch {
            throw MeshClientError.transportUnavailable
        }
        guard response.statusCode == 201 else {
            if [400, 403, 409, 429].contains(response.statusCode) {
                throw MeshClientError.registrationRejected(statusCode: response.statusCode)
            }
            if response.statusCode == 408 || (500...599).contains(response.statusCode) {
                throw MeshClientError.registrationOutcomeUnknown
            }
            throw MeshClientError.invalidStatus
        }
        do {
            try validate(response, expectedStatus: 201, origin: origin)
            let decoded = try JSONDecoder().decode(ChallengeResponseEnvelope.self, from: response.body)
            return decoded.challenge
        } catch {
            throw MeshClientError.invalidResponse
        }
    }

    func registerIdentity(
        origin: MeshOrigin,
        admissionToken: AdmissionToken,
        submission: IdentityRegistrationSubmission
    ) async throws -> RegisteredIdentityPayload {
        guard let url = URL(string: origin.value + "/api/v1/agents/register-mailbox") else {
            throw MeshClientError.invalidRequest
        }
        let body = try JSONEncoder().encode(submission)
        guard body.count <= Self.maximumRequestBytes else {
            throw MeshClientError.requestTooLarge
        }
        let request = MeshHTTPRequest(
            method: "POST",
            url: url,
            headers: [
                "Accept": "application/json",
                "Content-Type": "application/json",
                "X-Mesh-Admission-Token": admissionToken.rawValue,
            ],
            body: body
        )
        let response: MeshHTTPResponse
        do {
            response = try await transport.send(request)
        } catch MeshClientError.responseTooLargeAfterResponse(let statusCode) {
            if statusCode == 201 { throw MeshClientError.registrationResponseUnusable }
            if statusCode == 408 || (500...599).contains(statusCode) { throw MeshClientError.registrationOutcomeUnknown }
            throw MeshClientError.invalidStatus
        }
        guard response.statusCode == 201 else {
            do {
                try validateEnvelope(response, origin: origin)
            } catch MeshClientError.redirectRejected {
                throw MeshClientError.redirectRejected
            } catch {
                throw MeshClientError.registrationOutcomeUnknown
            }
            if response.statusCode == 408 || (500...599).contains(response.statusCode) {
                throw MeshClientError.registrationOutcomeUnknown
            }
            if [400, 403, 409, 429].contains(response.statusCode) {
                throw MeshClientError.registrationRejected(statusCode: response.statusCode)
            }
            try validate(response, expectedStatus: 201, origin: origin)
            throw MeshClientError.registrationRejected(statusCode: response.statusCode)
        }
        do {
            try validate(response, expectedStatus: 201, origin: origin)
            return try JSONDecoder().decode(RegisteredIdentityPayload.self, from: response.body)
        } catch {
            throw MeshClientError.registrationResponseUnusable
        }
    }

    func register(origin: MeshOrigin, input: EnrollmentInput) async throws -> RegisteredMailbox {
        let payload = RegistrationPayload(
            handle: input.handle.value,
            name: input.name,
            description: input.description,
            capabilities: input.capabilities
        )
        let body = try JSONEncoder().encode(payload)
        guard body.count <= Self.maximumRequestBytes,
              let url = URL(string: origin.value + "/api/v1/agents/register-mailbox")
        else {
            throw MeshClientError.requestTooLarge
        }
        let request = MeshHTTPRequest(
            method: "POST",
            url: url,
            headers: [
                "Accept": "application/json",
                "Content-Type": "application/json",
                "X-Mesh-Admission-Token": input.admissionToken.rawValue,
            ],
            body: body
        )
        let response: MeshHTTPResponse
        do {
            response = try await transport.send(request)
        } catch MeshClientError.responseTooLargeAfterResponse(let statusCode) {
            if statusCode == 201 { throw MeshClientError.registrationResponseUnusable }
            if statusCode == 408 || (500...599).contains(statusCode) { throw MeshClientError.registrationOutcomeUnknown }
            throw MeshClientError.invalidStatus
        }
        guard response.statusCode == 201 else {
            do {
                try validateEnvelope(response, origin: origin)
            } catch MeshClientError.redirectRejected {
                throw MeshClientError.redirectRejected
            } catch {
                throw MeshClientError.registrationOutcomeUnknown
            }
            if response.statusCode == 408 || (500...599).contains(response.statusCode) {
                throw MeshClientError.registrationOutcomeUnknown
            }
            if [400, 403, 409, 429].contains(response.statusCode) {
                throw MeshClientError.registrationRejected(statusCode: response.statusCode)
            }
            try validate(response, expectedStatus: 201, origin: origin)
            throw MeshClientError.registrationRejected(statusCode: response.statusCode)
        }
        do {
            try validate(response, expectedStatus: 201, origin: origin)
            return try JSONDecoder().decode(RegisteredMailbox.self, from: response.body)
        } catch {
            throw MeshClientError.registrationResponseUnusable
        }
    }

    func identity(for binding: CredentialBinding) async throws -> VerifiedMailboxIdentity {
        guard let meURL = URL(string: binding.origin.value + "/api/v1/agents/me") else {
            throw MeshClientError.invalidRequest
        }
        let meRequest = MeshHTTPRequest(
            method: "GET",
            url: meURL,
            headers: [
                "Accept": "application/json",
                "Authorization": "Bearer \(binding.token.secretValue)",
            ]
        )
        let response = try await transport.send(meRequest)
        try validate(response, expectedStatus: 200, origin: binding.origin)
        do {
            return try JSONDecoder().decode(IdentityEnvelope.self, from: response.body).agent
        } catch {
            throw MeshClientError.invalidResponse
        }
    }

    func agentCard(for binding: CredentialBinding) async throws -> VerifiedMailboxIdentity {
        guard let url = URL(string: binding.origin.value + "/api/v1/agents/" + binding.agentID.value) else {
            throw MeshClientError.invalidRequest
        }
        let request = MeshHTTPRequest(
            method: "GET",
            url: url,
            headers: ["Accept": "application/json"]
        )
        let response = try await transport.send(request)
        try validate(response, expectedStatus: 200, origin: binding.origin)
        do {
            return try JSONDecoder().decode(IdentityEnvelope.self, from: response.body).agent
        } catch {
            throw MeshClientError.invalidResponse
        }
    }

    private func validate(_ response: MeshHTTPResponse, expectedStatus: Int, origin: MeshOrigin) throws {
        try validateEnvelope(response, origin: origin)
        guard response.statusCode == expectedStatus else { throw MeshClientError.invalidStatus }
    }

    private func validateEnvelope(_ response: MeshHTTPResponse, origin: MeshOrigin) throws {
        guard response.body.count <= Self.maximumResponseBytes else { throw MeshClientError.responseTooLarge }
        guard !(300...399).contains(response.statusCode) else { throw MeshClientError.redirectRejected }
        guard canonicalOrigin(of: response.finalURL) == origin.value else { throw MeshClientError.crossOriginResponse }
        let contentType = response.headers.first { $0.key.caseInsensitiveCompare("Content-Type") == .orderedSame }?.value
        guard let contentType,
              contentType.split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "application/json"
        else {
            throw MeshClientError.invalidContentType
        }
    }

    private func canonicalOrigin(of url: URL) -> String? {
        guard let scheme = url.scheme, let host = url.host else { return nil }
        var components = URLComponents()
        components.scheme = scheme.lowercased()
        components.host = host.lowercased()
        components.port = url.port
        return components.string
    }
}

@_spi(EnrollmentTesting)
public struct ChallengeRequestBody: Codable, Sendable {
    public let identityProfile: String
    public let handle: String
    public let workloadID: String
    public let workloadPublicJWK: WorkloadPublicJWK

    public enum CodingKeys: String, CodingKey {
        case identityProfile = "identity_profile"
        case handle
        case workloadID = "workload_id"
        case workloadPublicJWK = "workload_public_jwk"
    }
}

public struct IdentityRegistrationChallenge: Decodable, Sendable {
    public let challengeID: String
    public let expiresAt: String
    public let nonce: String
    public let nonceSHA256: String
    public let origin: String
    public let proofProfile: String
    public let workloadJKT: String
    public let handle: String
    public let identityProfile: String
    public let workloadID: String
    public let workloadPublicJWK: WorkloadPublicJWK

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case challengeID = "challenge_id"
        case expiresAt = "expires_at"
        case nonce
        case nonceSHA256 = "nonce_sha256"
        case origin
        case proofProfile = "proof_profile"
        case workloadJKT = "workload_jkt"
        case handle
        case identityProfile = "identity_profile"
        case workloadID = "workload_id"
        case workloadPublicJWK = "workload_public_jwk"
    }

    public init(from decoder: Decoder) throws {
        try requireExactKeys(decoder, expected: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        challengeID = try values.decode(String.self, forKey: .challengeID)
        expiresAt = try values.decode(String.self, forKey: .expiresAt)
        nonce = try values.decode(String.self, forKey: .nonce)
        nonceSHA256 = try values.decode(String.self, forKey: .nonceSHA256)
        origin = try values.decode(String.self, forKey: .origin)
        proofProfile = try values.decode(String.self, forKey: .proofProfile)
        workloadJKT = try values.decode(String.self, forKey: .workloadJKT)
        handle = try values.decode(String.self, forKey: .handle)
        identityProfile = try values.decode(String.self, forKey: .identityProfile)
        workloadID = try values.decode(String.self, forKey: .workloadID)
        workloadPublicJWK = try values.decode(WorkloadPublicJWK.self, forKey: .workloadPublicJWK)
    }
}

struct ChallengeResponseEnvelope: Decodable {
    let challenge: IdentityRegistrationChallenge

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case challenge
    }

    init(from decoder: Decoder) throws {
        try requireExactKeys(decoder, expected: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        challenge = try values.decode(IdentityRegistrationChallenge.self, forKey: .challenge)
    }
}

@_spi(EnrollmentTesting)
public struct IdentityRegistrationSubmission: Codable, Sendable {
    public let capabilities: [String]
    public let challengeID: String
    public let description: String
    public let handle: String
    public let identityProfile: String
    public let name: String
    public let proof: String
    public let workloadID: String
    public let workloadPublicJWK: WorkloadPublicJWK

    public enum CodingKeys: String, CodingKey {
        case capabilities
        case challengeID = "challenge_id"
        case description
        case handle
        case identityProfile = "identity_profile"
        case name
        case proof
        case workloadID = "workload_id"
        case workloadPublicJWK = "workload_public_jwk"
    }
}

struct RegisteredIdentityPayload: Decodable, Sendable {
    let agent: RegisteredAgent
    let workload: RegisteredWorkload
    let token: MeshToken?
    let warning: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case agent, workload, token, warning
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        agent = try values.decode(RegisteredAgent.self, forKey: .agent)
        workload = try values.decode(RegisteredWorkload.self, forKey: .workload)
        token = try values.decodeIfPresent(MeshToken.self, forKey: .token)
        warning = try values.decodeIfPresent(String.self, forKey: .warning)

        let expectedKeys: [String] = {
            var keys = ["agent", "workload"]
            if token != nil { keys.append("token") }
            if warning != nil { keys.append("warning") }
            return keys
        }()
        try requireExactKeys(decoder, expected: expectedKeys)
    }
}

struct RegisteredWorkload: Decodable, Sendable {
    let workloadID: String
    let publicJWK: WorkloadPublicJWK
    let jkt: String
    let state: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case workloadID = "workload_id"
        case publicJWK = "public_jwk"
        case jkt
        case state
        case scopes
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        workloadID = try values.decode(String.self, forKey: .workloadID)
        publicJWK = try values.decode(WorkloadPublicJWK.self, forKey: .publicJWK)
        jkt = try values.decode(String.self, forKey: .jkt)
        state = try values.decode(String.self, forKey: .state)
    }
}

private struct RegistrationPayload: Encodable {
    let handle: String
    let name: String
    let description: String
    let capabilities: [String]
}

struct RegisteredMailbox: Decodable, Sendable {
    let agent: RegisteredAgent
    let token: MeshToken
    let warning: String

    private enum CodingKeys: String, CodingKey, CaseIterable { case agent, token, warning }

    init(from decoder: Decoder) throws {
        try requireExactKeys(decoder, expected: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        agent = try values.decode(RegisteredAgent.self, forKey: .agent)
        token = try values.decode(MeshToken.self, forKey: .token)
        warning = try values.decode(String.self, forKey: .warning)
        guard !warning.isEmpty, warning.utf8.count <= 512 else { throw MeshClientError.invalidResponse }
    }
}

struct RegisteredAgent: Decodable, Sendable {
    let id: AgentID
    let handle: MailboxHandle
    let name: String
    let description: String
    let endpointURL: URL
    let capabilities: [String]
    let protocolVersion: String
    let protocolBinding: String
    let conformanceStatus: String
    let registrationMode: String
    let agentCardURL: URL

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, handle, name, description, capabilities, protocolVersion, protocolBinding, conformanceStatus, registrationMode
        case endpointURL = "endpointUrl"
        case agentCardURL = "agentCardUrl"
        case conformanceCheckedAt, conformanceReport, status, lastSeenAt, createdAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(AgentID.self, forKey: .id)
        handle = try values.decode(MailboxHandle.self, forKey: .handle)
        name = try values.decode(String.self, forKey: .name)
        description = try values.decode(String.self, forKey: .description)
        endpointURL = try values.decode(URL.self, forKey: .endpointURL)
        capabilities = try values.decode([String].self, forKey: .capabilities)
        protocolVersion = try values.decode(String.self, forKey: .protocolVersion)
        protocolBinding = try values.decode(String.self, forKey: .protocolBinding)
        conformanceStatus = try values.decode(String.self, forKey: .conformanceStatus)
        registrationMode = try values.decode(String.self, forKey: .registrationMode)
        agentCardURL = try values.decode(URL.self, forKey: .agentCardURL)
        guard registrationMode == "mailbox",
              (1...80).contains(name.utf8.count), description.utf8.count <= 500,
              capabilities.count <= 40,
              protocolVersion.utf8.count <= 64, protocolBinding.utf8.count <= 64,
              conformanceStatus.utf8.count <= 64
        else { throw MeshClientError.invalidResponse }
    }
}

struct VerifiedMailboxIdentity: Decodable, Sendable {
    let id: AgentID
    let name: String
    let handle: MailboxHandle
    let registrationMode: String
    let endpointURL: URL

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, name, handle, registrationMode
        case endpointURL = "endpointUrl"
        case description, capabilities, protocolVersion, protocolBinding, conformanceStatus, conformanceCheckedAt, conformanceReport, status, lastSeenAt, createdAt, agentCardUrl
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(AgentID.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        handle = try values.decode(MailboxHandle.self, forKey: .handle)
        registrationMode = try values.decode(String.self, forKey: .registrationMode)
        endpointURL = try values.decode(URL.self, forKey: .endpointURL)
        guard registrationMode == "mailbox", (1...80).contains(name.utf8.count) else {
            throw MeshClientError.invalidResponse
        }
    }
}

private struct IdentityEnvelope: Decodable {
    let agent: VerifiedMailboxIdentity
    private enum CodingKeys: String, CodingKey, CaseIterable { case agent }
    init(from decoder: Decoder) throws {
        try requireExactKeys(decoder, expected: CodingKeys.allCases.map(\.rawValue))
        agent = try decoder.container(keyedBy: CodingKeys.self).decode(VerifiedMailboxIdentity.self, forKey: .agent)
    }
}

private struct AnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?
    init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }
    init?(intValue: Int) { self.stringValue = String(intValue); self.intValue = intValue }
}

private func requireExactKeys(_ decoder: Decoder, expected: [String]) throws {
    let values = try decoder.container(keyedBy: AnyCodingKey.self)
    guard Set(values.allKeys.map(\.stringValue)) == Set(expected) else {
        throw MeshClientError.invalidResponse
    }
}
