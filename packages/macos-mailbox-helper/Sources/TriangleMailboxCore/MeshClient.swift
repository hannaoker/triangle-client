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
        // Preserve caller timeouts (watch-poll sets 60s for held long-poll).
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    public override convenience init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 30
        self.init(configuration: configuration)
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

    /// `GET /api/v1/agents/me` as the agent's workload (v1). One fresh token
    /// exchange after a 401; refusals carry only allowlisted codes.
    public func agentSelf(origin: MeshOrigin, auth: WorkloadTokenManager) async throws -> AgentSelf {
        guard let url = URL(string: origin.value + "/api/v1/agents/me") else {
            throw MeshClientError.invalidRequest
        }
        for attempt in 0..<2 {
            let token = try await auth.fetchToken()
            let headers = try await auth.authorizationHeaders(method: "GET", url: url)
            let response: MeshHTTPResponse
            do {
                response = try await transport.send(MeshHTTPRequest(
                    method: "GET", url: url, headers: headers.merging(["Accept": "application/json"]) { a, _ in a }
                ))
            } catch let error as MeshClientError {
                throw error
            } catch {
                throw MeshClientError.transportUnavailable
            }
            if response.statusCode == 401 && attempt == 0 {
                auth.invalidate(token)
                continue
            }
            if !(200...299).contains(response.statusCode), let code = MeshWorkloadErrorCode.code(in: response.body) {
                throw WorkloadTokenManagerError.refused(code: code, statusCode: response.statusCode)
            }
            try validate(response, expectedStatus: 200, origin: origin)
            return try AgentSelf.decode(response.body)
        }
        throw MeshClientError.invalidStatus
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

/// The parts of `GET /api/v1/agents/me` the helper relies on.
public struct AgentSelf: Sendable, Equatable {
    public let agentID: AgentID
    public let handle: MailboxHandle?
    public let state: String?
    public let permissions: [String: Bool]?
    public let revision: Int?

    static func decode(_ data: Data) throws -> AgentSelf {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let agent = object["agent"] as? [String: Any],
              let rawID = agent["id"] as? String, let agentID = try? AgentID(rawID)
        else { throw MeshClientError.invalidResponse }
        let handle = (agent["handle"] as? String).flatMap { try? MailboxHandle($0) }
        let state = (object["state"] as? String) ?? (agent["state"] as? String)
        var permissions: [String: Bool]?
        if let raw = object["permissions"] as? [String: Any] {
            var parsed: [String: Bool] = [:]
            for (key, value) in raw where key.utf8.count <= 64 {
                if let flag = value as? Bool { parsed[key] = flag }
            }
            permissions = parsed
        }
        let revision = object["revision"] as? Int
        return AgentSelf(agentID: agentID, handle: handle, state: state, permissions: permissions, revision: revision)
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
