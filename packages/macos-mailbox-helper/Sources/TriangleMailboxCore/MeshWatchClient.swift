import Foundation

public enum MeshWatchClientError: Error, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case invalidRequest
    case plaintextOrigin
    case requestTooLarge
    case transportUnavailable
    case redirectRejected
    case crossOriginResponse
    case invalidStatus
    case invalidContentType
    case responseTooLarge
    case invalidResponse
    case rejected(statusCode: Int, code: String)
    case resyncRequired(restartCursor: Int)
    case workloadAuthRequired

    public var description: String {
        switch self {
        case .invalidRequest: "invalid MESH watch request"
        case .plaintextOrigin: "plaintext MESH origin is not allowed"
        case .requestTooLarge: "MESH watch request is too large"
        case .transportUnavailable: "MESH watch is unavailable"
        case .redirectRejected: "MESH watch redirect was rejected"
        case .crossOriginResponse: "MESH watch response origin changed"
        case .invalidStatus: "MESH watch returned an invalid status"
        case .invalidContentType: "MESH watch returned an invalid content type"
        case .responseTooLarge: "MESH watch response is too large"
        case .invalidResponse: "MESH watch returned an invalid response"
        case .rejected(_, let code): "MESH watch request was rejected (\(code))"
        case .resyncRequired: "MESH watch cursor requires resync"
        case .workloadAuthRequired: "MESH watch requires workload authentication"
        }
    }

    public var debugDescription: String { description }
}

/// Thin MESH watch-grant / held-poll client that mirrors server route contracts.
public struct MeshWatchClient: Sendable {
    public static let maximumRequestBytes = 4 * 1024
    public static let maximumResponseBytes = 64 * 1024

    private let transport: any MeshTransport

    public init(transport: any MeshTransport) {
        self.transport = transport
    }

    public func createGrant(
        origin: MeshOrigin,
        installationID: InstallationID,
        agentIDs: [AgentID],
        authorizationHeaders: [String: String],
        replacementCredential: WatchCredential? = nil
    ) async throws -> StagedWatchGrant {
        guard let url = URL(string: origin.value + "/api/v1/mailbox/watch/grants") else {
            throw MeshWatchClientError.invalidRequest
        }
        let bodyObject: [String: Any] = [
            "installation_id": installationID.value,
            "agent_ids": agentIDs.map(\.value),
        ]
        let body = try JSONSerialization.data(withJSONObject: bodyObject, options: [.sortedKeys])
        guard body.count <= Self.maximumRequestBytes else {
            throw MeshWatchClientError.requestTooLarge
        }
        var headers = [
            "Accept": "application/json",
            "Content-Type": "application/json",
        ]
        headers.merge(authorizationHeaders) { _, new in new }
        if let replacementCredential {
            headers["Mesh-Watch-Credential"] = replacementCredential.secretValue
        }
        let response = try await send(
            MeshHTTPRequest(method: "POST", url: url, headers: headers, body: body),
            origin: origin
        )
        guard response.statusCode == 201 else {
            throw rejected(response)
        }
        do {
            try validateEnvelope(response, origin: origin)
            let decoded = try JSONDecoder().decode(CreateWatchGrantResponse.self, from: response.body)
            return try decoded.asStagedGrant()
        } catch let error as MeshWatchClientError {
            throw error
        } catch {
            throw MeshWatchClientError.invalidResponse
        }
    }

    public func joinGrant(
        origin: MeshOrigin,
        grantID: WatchGrantID,
        stagingCredential: WatchStagingCredential,
        authorizationHeaders: [String: String]
    ) async throws {
        guard let url = URL(string: origin.value + "/api/v1/mailbox/watch/grants/\(grantID.value)/join") else {
            throw MeshWatchClientError.invalidRequest
        }
        var headers = ["Accept": "application/json"]
        headers.merge(authorizationHeaders) { _, new in new }
        headers["Mesh-Watch-Staging"] = stagingCredential.secretValue
        let response = try await send(
            MeshHTTPRequest(method: "POST", url: url, headers: headers),
            origin: origin
        )
        guard response.statusCode == 200 else {
            throw rejected(response)
        }
        try validateEnvelope(response, origin: origin)
        do {
            _ = try JSONDecoder().decode(JoinWatchGrantResponse.self, from: response.body)
        } catch {
            throw MeshWatchClientError.invalidResponse
        }
    }

    public func finalizeGrant(
        origin: MeshOrigin,
        grantID: WatchGrantID,
        stagingCredential: WatchStagingCredential,
        authorizationHeaders: [String: String]
    ) async throws -> FinalizedWatchGrant {
        guard let url = URL(string: origin.value + "/api/v1/mailbox/watch/grants/\(grantID.value)/finalize") else {
            throw MeshWatchClientError.invalidRequest
        }
        var headers = ["Accept": "application/json"]
        headers.merge(authorizationHeaders) { _, new in new }
        headers["Mesh-Watch-Staging"] = stagingCredential.secretValue
        let response = try await send(
            MeshHTTPRequest(method: "POST", url: url, headers: headers),
            origin: origin
        )
        guard response.statusCode == 200 else {
            throw rejected(response)
        }
        do {
            try validateEnvelope(response, origin: origin)
            let decoded = try JSONDecoder().decode(FinalizeWatchGrantResponse.self, from: response.body)
            return try decoded.asFinalizedGrant()
        } catch let error as MeshWatchClientError {
            throw error
        } catch {
            throw MeshWatchClientError.invalidResponse
        }
    }

    public func revokeGrant(
        origin: MeshOrigin,
        watchCredential: WatchCredential
    ) async throws {
        guard let url = URL(string: origin.value + "/api/v1/mailbox/watch/grants/revoke") else {
            throw MeshWatchClientError.invalidRequest
        }
        let response = try await send(
            MeshHTTPRequest(
                method: "POST",
                url: url,
                headers: [
                    "Accept": "application/json",
                    "Mesh-Watch-Credential": watchCredential.secretValue,
                ]
            ),
            origin: origin
        )
        guard response.statusCode == 200 else {
            throw rejected(response)
        }
        try validateEnvelope(response, origin: origin)
        do {
            let decoded = try JSONDecoder().decode(RevokeWatchGrantResponse.self, from: response.body)
            guard decoded.state == "revoked" else { throw MeshWatchClientError.invalidResponse }
        } catch let error as MeshWatchClientError {
            throw error
        } catch {
            throw MeshWatchClientError.invalidResponse
        }
    }

    public func poll(
        origin: MeshOrigin,
        watchCredential: WatchCredential,
        cursor: Int
    ) async throws -> WatchPollResponse {
        guard cursor >= 0 else { throw MeshWatchClientError.invalidRequest }
        guard var components = URLComponents(string: origin.value + "/api/v1/mailbox/watch") else {
            throw MeshWatchClientError.invalidRequest
        }
        components.queryItems = [URLQueryItem(name: "cursor", value: String(cursor))]
        guard let url = components.url else { throw MeshWatchClientError.invalidRequest }
        let response = try await send(
            MeshHTTPRequest(
                method: "GET",
                url: url,
                headers: [
                    "Accept": "application/json",
                    "Mesh-Watch-Credential": watchCredential.secretValue,
                ]
            ),
            origin: origin
        )
        if response.statusCode == 409 {
            if let payload = try? JSONDecoder().decode(WatchErrorEnvelope.self, from: response.body),
               payload.error == "resync_required",
               let restart = payload.restartCursor,
               restart >= 0
            {
                throw MeshWatchClientError.resyncRequired(restartCursor: restart)
            }
            throw rejected(response)
        }
        guard response.statusCode == 200 else {
            throw rejected(response)
        }
        do {
            try validateEnvelope(response, origin: origin)
            return try JSONDecoder().decode(WatchPollResponse.self, from: response.body)
        } catch let error as MeshWatchClientError {
            throw error
        } catch {
            throw MeshWatchClientError.invalidResponse
        }
    }

    private func send(_ request: MeshHTTPRequest, origin: MeshOrigin) async throws -> MeshHTTPResponse {
        let scheme = request.url.scheme?.lowercased()
        let isHTTPS = scheme == "https"
        let isLoopbackHTTP = scheme == "http" && (
            origin.value.hasPrefix("http://127.0.0.1")
                || origin.value.hasPrefix("http://localhost")
                || origin.value.hasPrefix("http://[::1]")
        )
        guard isHTTPS || isLoopbackHTTP else {
            throw MeshWatchClientError.plaintextOrigin
        }
        do {
            return try await transport.send(request)
        } catch let error as MeshClientError {
            switch error {
            case .plaintextOrigin: throw MeshWatchClientError.plaintextOrigin
            case .redirectRejected: throw MeshWatchClientError.redirectRejected
            case .transportUnavailable: throw MeshWatchClientError.transportUnavailable
            case .responseTooLarge, .responseTooLargeAfterResponse: throw MeshWatchClientError.responseTooLarge
            default: throw MeshWatchClientError.transportUnavailable
            }
        } catch let error as MeshWatchClientError {
            throw error
        } catch {
            throw MeshWatchClientError.transportUnavailable
        }
    }

    private func rejected(_ response: MeshHTTPResponse) -> MeshWatchClientError {
        let code = (try? JSONDecoder().decode(WatchErrorEnvelope.self, from: response.body))?.error ?? "watch_rejected"
        return .rejected(statusCode: response.statusCode, code: code)
    }

    private func validateEnvelope(_ response: MeshHTTPResponse, origin: MeshOrigin) throws {
        guard response.body.count <= Self.maximumResponseBytes else { throw MeshWatchClientError.responseTooLarge }
        guard !(300...399).contains(response.statusCode) else { throw MeshWatchClientError.redirectRejected }
        guard canonicalOrigin(of: response.finalURL) == origin.value else { throw MeshWatchClientError.crossOriginResponse }
        let contentType = response.headers.first { $0.key.caseInsensitiveCompare("Content-Type") == .orderedSame }?.value
        guard let contentType,
              contentType.split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "application/json"
        else {
            throw MeshWatchClientError.invalidContentType
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

private struct CreateWatchGrantResponse: Decodable {
    let grantID: String
    let installationID: String
    let agentIDs: [String]
    let stagingCredential: String
    let expiresAt: String
    let audience: String
    let purpose: String

    private enum CodingKeys: String, CodingKey {
        case grantID = "grant_id"
        case installationID = "installation_id"
        case agentIDs = "agent_ids"
        case stagingCredential = "staging_credential"
        case expiresAt = "expires_at"
        case audience, purpose
    }

    func asStagedGrant() throws -> StagedWatchGrant {
        StagedWatchGrant(
            grantID: try WatchGrantID(grantID),
            installationID: try InstallationID(installationID),
            agentIDs: try agentIDs.map(AgentID.init),
            stagingCredential: try WatchStagingCredential(stagingCredential),
            expiresAt: expiresAt,
            audience: audience,
            purpose: purpose
        )
    }
}

private struct JoinWatchGrantResponse: Decodable {
    let grantID: String
    let agentID: String
    let state: String

    private enum CodingKeys: String, CodingKey {
        case grantID = "grant_id"
        case agentID = "agent_id"
        case state
    }
}

private struct FinalizeWatchGrantResponse: Decodable {
    let grantID: String
    let watchCredential: String
    let audience: String
    let purpose: String

    private enum CodingKeys: String, CodingKey {
        case grantID = "grant_id"
        case watchCredential = "watch_credential"
        case audience, purpose
    }

    func asFinalizedGrant() throws -> FinalizedWatchGrant {
        FinalizedWatchGrant(
            grantID: try WatchGrantID(grantID),
            watchCredential: try WatchCredential(watchCredential),
            audience: audience,
            purpose: purpose
        )
    }
}

private struct RevokeWatchGrantResponse: Decodable {
    let state: String
}

private struct WatchErrorEnvelope: Decodable {
    let error: String
    let restartCursor: Int?

    private enum CodingKeys: String, CodingKey {
        case error
        case restartCursor = "restart_cursor"
    }
}
