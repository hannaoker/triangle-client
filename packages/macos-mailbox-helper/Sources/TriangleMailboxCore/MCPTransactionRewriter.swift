import Foundation

/// Rewrites MCP mailbox claim / send / ack / list through the trusted transaction store.
public struct MCPTransactionRewriter: Sendable {
    public let instanceID: ClientInstanceID
    public let protocolOwnership: MailboxTransactionProtocol
    public let store: any MailboxTransactionStore
    public let transport: any MailboxTransactionTransport

    public init(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol = .selfServeDrain,
        store: any MailboxTransactionStore,
        transport: any MailboxTransactionTransport
    ) {
        self.instanceID = instanceID
        self.protocolOwnership = protocolOwnership
        self.store = store
        self.transport = transport
    }

    public var service: MailboxTransactionService {
        MailboxTransactionService(store: store, transport: transport)
    }

    public enum RewriteOutcome: Sendable {
        case forward(Data)
        case respond(Data)
        case reject(code: Int, message: String)
    }

    public func rewriteOutgoing(requestMethod: String, params: Any?, raw: Data) async -> RewriteOutcome? {
        guard requestMethod == "tools/call",
              let dictionary = params as? [String: Any],
              let name = dictionary["name"] as? String
        else { return nil }

        let arguments = dictionary["arguments"] as? [String: Any] ?? [:]
        switch name {
        case "mesh.mailbox.claim":
            return await rewriteClaim(arguments: arguments, raw: raw)
        case "mesh.messages.send":
            return await rewriteSend(arguments: arguments, raw: raw)
        case "mesh.mailbox.ack":
            return await rewriteAck(arguments: arguments, raw: raw)
        default:
            return nil
        }
    }

    public func filterIncoming(requestMethod: String, params: Any?, responseBody: Data) throws -> Data? {
        guard requestMethod == "tools/call",
              let dictionary = params as? [String: Any],
              let name = dictionary["name"] as? String,
              name == "mesh.mailbox.list"
        else { return nil }

        guard let object = try JSONSerialization.jsonObject(with: responseBody) as? [String: Any],
              var result = object["result"] as? [String: Any]
        else { return nil }

        // MCP tool results often wrap content; also accept a direct items array.
        let open = try store.readOpen(instanceID: instanceID)
        if let open, open.protocolOwnership != protocolOwnership {
            throw MailboxTransactionStoreError.protocolMismatch
        }
        let quarantined = try store.listQuarantined(instanceID: instanceID)
        let evaluation = try MailboxPolicyEvaluator.evaluate(
            protocolOwnership: protocolOwnership,
            candidates: [],
            open: open,
            quarantined: quarantined
        )

        if var structured = result["structuredContent"] as? [String: Any],
           let items = structured["items"] as? [[String: Any]] {
            structured["items"] = MailboxPolicyEvaluator.filterListItems(items, evaluation: evaluation)
            result["structuredContent"] = structured
        } else if let items = result["items"] as? [[String: Any]] {
            result["items"] = MailboxPolicyEvaluator.filterListItems(items, evaluation: evaluation)
        } else {
            return nil
        }

        var rewritten = object
        rewritten["result"] = result
        return try JSONSerialization.data(withJSONObject: rewritten, options: [.sortedKeys])
    }

    private func rewriteClaim(arguments: [String: Any], raw: Data) async -> RewriteOutcome {
        guard let deliveryID = intValue(arguments["delivery_id"] ?? arguments["deliveryId"]),
              let roomRaw = arguments["room_id"] as? String ?? arguments["roomId"] as? String,
              let roomID = MailboxRoomID(rawValue: roomRaw)
        else { return .reject(code: -32602, message: "invalid params") }

        let modelClaim = arguments["claim_id"] as? String ?? arguments["claimId"] as? String
        do {
            let open = try await service.claim(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership,
                deliveryID: deliveryID,
                roomID: roomID,
                modelSuppliedClaimID: modelClaim
            )
            // Replace claim_id in the forwarded MCP request with the deterministic value.
            guard var object = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
                  var params = object["params"] as? [String: Any],
                  var args = params["arguments"] as? [String: Any]
            else { return .reject(code: -32602, message: "invalid params") }
            args.removeValue(forKey: "claimId")
            args["claim_id"] = open.claimID.value
            args["delivery_id"] = deliveryID
            params["arguments"] = args
            object["params"] = params
            let rewritten = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            // Claim already performed via trusted transport; return a synthetic success
            // without forwarding a second claim.
            let response: [String: Any] = [
                "jsonrpc": "2.0",
                "id": object["id"] as Any,
                "result": [
                    "claimed": true,
                    "claimId": open.claimID.value,
                    "deliveryId": open.deliveryID,
                    "state": open.state.rawValue,
                    "idempotent": open.state != .prepared,
                ],
            ]
            _ = rewritten
            return .respond(try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]))
        } catch MailboxTransactionServiceError.nestedClaim {
            return .reject(code: -32000, message: "nested_claim")
        } catch MailboxTransactionServiceError.transactionStuck {
            return .reject(code: -32000, message: "transaction_stuck")
        } catch MailboxTransactionServiceError.protocolMismatch {
            return .reject(code: -32000, message: "protocol_mismatch")
        } catch MailboxTransactionServiceError.claimConflict {
            return .reject(code: -32000, message: "delivery_claim_conflict")
        } catch {
            return .reject(code: -32603, message: "claim_failed")
        }
    }

    private func rewriteSend(arguments: [String: Any], raw: Data) async -> RewriteOutcome {
        guard let roomRaw = arguments["room_id"] as? String ?? arguments["roomId"] as? String,
              let roomID = MailboxRoomID(rawValue: roomRaw)
        else { return .reject(code: -32602, message: "invalid params") }

        let text = arguments["text"] as? String
            ?? ((arguments["body"] as? [String: Any])?["text"] as? String)
        guard let text, !text.isEmpty else { return .reject(code: -32602, message: "invalid params") }

        let modelKey = arguments["idempotency_key"] as? String ?? arguments["idempotencyKey"] as? String
        let inReplyRaw = arguments["in_reply_to_event_id"] as? String
            ?? arguments["inReplyToEventId"] as? String
        let inReply = inReplyRaw.flatMap(MailboxEventID.init(rawValue:))

        do {
            let open = try await service.reply(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership,
                roomID: roomID,
                text: text,
                inReplyToEventID: inReply,
                modelSuppliedIdempotencyKey: modelKey
            )
            guard let object = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
                return .reject(code: -32602, message: "invalid params")
            }
            var result: [String: Any] = [
                "state": open.state.rawValue,
                "replyResolution": open.replyResolution.rawValue,
                "replyIdempotencyKey": open.replyIdempotencyKey.value,
            ]
            if let eventID = open.replyEventID {
                result["eventId"] = eventID.value
            }
            let response: [String: Any] = [
                "jsonrpc": "2.0",
                "id": object["id"] as Any,
                "result": result,
            ]
            return .respond(try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]))
        } catch MailboxTransactionServiceError.roomMismatch {
            return .reject(code: -32000, message: "room_mismatch")
        } catch MailboxTransactionServiceError.notOpen {
            return .reject(code: -32000, message: "no_open_transaction")
        } catch MailboxTransactionServiceError.transactionStuck {
            return .reject(code: -32000, message: "transaction_stuck")
        } catch MailboxTransactionServiceError.protocolMismatch {
            return .reject(code: -32000, message: "protocol_mismatch")
        } catch MailboxTransactionServiceError.unverifiedReplyConflict {
            return .reject(code: -32000, message: "unverified_reply_conflict")
        } catch {
            return .reject(code: -32603, message: "reply_failed")
        }
    }

    private func rewriteAck(arguments: [String: Any], raw: Data) async -> RewriteOutcome {
        let deliveryID = intValue(arguments["delivery_id"] ?? arguments["deliveryId"])
        let modelDelivery = intValue(arguments["delivery_id"] ?? arguments["deliveryId"])
        do {
            try await service.acknowledge(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership,
                deliveryID: deliveryID,
                modelSuppliedDeliveryID: modelDelivery
            )
            guard let object = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
                return .reject(code: -32602, message: "invalid params")
            }
            let response: [String: Any] = [
                "jsonrpc": "2.0",
                "id": object["id"] as Any,
                "result": ["acknowledged": true],
            ]
            return .respond(try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]))
        } catch MailboxTransactionServiceError.unrelatedAcknowledgement {
            return .reject(code: -32000, message: "unrelated_acknowledgement")
        } catch MailboxTransactionServiceError.notOpen {
            return .reject(code: -32000, message: "no_open_transaction")
        } catch MailboxTransactionServiceError.invalidState {
            return .reject(code: -32000, message: "invalid_transaction_state")
        } catch MailboxTransactionServiceError.protocolMismatch {
            return .reject(code: -32000, message: "protocol_mismatch")
        } catch {
            return .reject(code: -32603, message: "ack_failed")
        }
    }

    private func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int { return int }
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            return number.intValue
        }
        if let string = value as? String, let int = Int(string), int > 0 { return int }
        return nil
    }
}

/// REST transport for mailbox claim / room append / ack using an authenticated MeshTransport.
public struct AuthenticatedMailboxTransactionTransport: MailboxTransactionTransport, Sendable {
    private let origin: MeshOrigin
    private let transport: any MeshTransport
    private let authorizationHeaders: @Sendable (String, URL) async throws -> [String: String]

    public init(
        origin: MeshOrigin,
        transport: any MeshTransport,
        authorizationHeaders: @escaping @Sendable (String, URL) async throws -> [String: String]
    ) {
        self.origin = origin
        self.transport = transport
        self.authorizationHeaders = authorizationHeaders
    }

    public func claim(deliveryID: Int, claimID: String) async throws -> MailboxClaimTransportResult {
        let url = URL(string: origin.value + "/api/v1/mailbox/claim")!
        var headers = [
            "Accept": "application/json",
            "Content-Type": "application/json",
        ]
        headers.merge(try await authorizationHeaders("POST", url)) { _, new in new }
        let body = try JSONSerialization.data(
            withJSONObject: ["delivery_id": deliveryID, "claim_id": claimID],
            options: [.sortedKeys]
        )
        let response = try await transport.send(MeshHTTPRequest(method: "POST", url: url, headers: headers, body: body))
        guard response.statusCode == 200,
              let object = try JSONSerialization.jsonObject(with: response.body) as? [String: Any],
              object["claimed"] as? Bool == true,
              let returnedClaim = object["claimId"] as? String,
              returnedClaim == claimID
        else {
            if response.statusCode == 409 { throw MailboxTransactionServiceError.claimConflict }
            throw MailboxTransactionServiceError.invalidUpstreamResponse
        }
        let idempotent = object["idempotent"] as? Bool ?? false
        return MailboxClaimTransportResult(claimed: true, claimID: claimID, idempotent: idempotent)
    }

    public func sendReply(
        roomID: String,
        idempotencyKey: String,
        text: String,
        inReplyToEventID: String?
    ) async throws -> MailboxReplyTransportResult {
        let url = URL(string: origin.value + "/api/v1/rooms/\(roomID)/messages")!
        var headers = [
            "Accept": "application/json",
            "Content-Type": "application/json",
        ]
        headers.merge(try await authorizationHeaders("POST", url)) { _, new in new }
        var bodyObject: [String: Any] = [
            "idempotency_key": idempotencyKey,
            "body": ["text": text],
        ]
        if let inReplyToEventID {
            bodyObject["in_reply_to_event_id"] = inReplyToEventID
        }
        let body = try JSONSerialization.data(withJSONObject: bodyObject, options: [.sortedKeys])
        let response = try await transport.send(MeshHTTPRequest(method: "POST", url: url, headers: headers, body: body))
        if response.statusCode == 409 {
            return .idempotencyConflict
        }
        guard response.statusCode == 200 || response.statusCode == 201,
              let object = try JSONSerialization.jsonObject(with: response.body) as? [String: Any],
              let event = object["event"] as? [String: Any],
              let eventID = event["id"] as? String
        else { throw MailboxTransactionServiceError.invalidUpstreamResponse }
        return .created(eventID: eventID)
    }

    public func lookupReplyEventID(roomID: String, idempotencyKey: String) async throws -> String? {
        // Bounded history lookup: first page only; never logs message text.
        let url = URL(string: origin.value + "/api/v1/rooms/\(roomID)/history?after_sequence=0&limit=50")!
        var headers = ["Accept": "application/json"]
        headers.merge(try await authorizationHeaders("GET", url)) { _, new in new }
        let response = try await transport.send(MeshHTTPRequest(method: "GET", url: url, headers: headers, body: Data()))
        guard response.statusCode == 200,
              let object = try JSONSerialization.jsonObject(with: response.body) as? [String: Any],
              let items = object["items"] as? [[String: Any]]
        else {
            // Transport/parse failure is not "no match" — callers must not treat
            // this as a verified idempotency conflict.
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        for item in items {
            let key = item["idempotency_key"] as? String ?? item["idempotencyKey"] as? String
            if key == idempotencyKey, let id = item["id"] as? String {
                return id
            }
        }
        return nil
    }

    public func acknowledge(deliveryID: Int) async throws {
        let url = URL(string: origin.value + "/api/v1/mailbox/ack")!
        var headers = [
            "Accept": "application/json",
            "Content-Type": "application/json",
        ]
        headers.merge(try await authorizationHeaders("POST", url)) { _, new in new }
        let body = try JSONSerialization.data(
            withJSONObject: ["delivery_ids": [deliveryID]],
            options: [.sortedKeys]
        )
        let response = try await transport.send(MeshHTTPRequest(method: "POST", url: url, headers: headers, body: body))
        guard response.statusCode == 200 else {
            throw MailboxTransactionServiceError.invalidUpstreamResponse
        }
    }
}

/// In-memory transport for crash / contract tests (no message text stored).
public final class RecordingMailboxTransactionTransport: MailboxTransactionTransport, @unchecked Sendable {
    private let lock = NSLock()
    public private(set) var claims: [(Int, String)] = []
    public private(set) var replies: [(roomID: String, key: String, textLength: Int)] = []
    public private(set) var acks: [Int] = []
    public var claimHandler: (@Sendable (Int, String) throws -> MailboxClaimTransportResult)?
    public var replyHandler: (@Sendable (String, String, String, String?) throws -> MailboxReplyTransportResult)?
    public var lookupHandler: (@Sendable (String, String) throws -> String?)?
    public var ackHandler: (@Sendable (Int) throws -> Void)?
    private var committedReplies: [String: (text: String, eventID: String)] = [:]

    public init() {}

    public func claim(deliveryID: Int, claimID: String) async throws -> MailboxClaimTransportResult {
        try lock.withLock {
            claims.append((deliveryID, claimID))
            if let claimHandler { return try claimHandler(deliveryID, claimID) }
            return MailboxClaimTransportResult(claimed: true, claimID: claimID, idempotent: false)
        }
    }

    public func sendReply(
        roomID: String,
        idempotencyKey: String,
        text: String,
        inReplyToEventID: String?
    ) async throws -> MailboxReplyTransportResult {
        try lock.withLock {
            replies.append((roomID, idempotencyKey, text.utf8.count))
            if let replyHandler { return try replyHandler(roomID, idempotencyKey, text, inReplyToEventID) }
            if let existing = committedReplies[idempotencyKey] {
                if existing.text == text {
                    return .created(eventID: existing.eventID)
                }
                return .idempotencyConflict
            }
            let eventID = "event_" + String(repeating: "c", count: 32)
            committedReplies[idempotencyKey] = (text, eventID)
            return .created(eventID: eventID)
        }
    }

    public func lookupReplyEventID(roomID: String, idempotencyKey: String) async throws -> String? {
        try lock.withLock {
            if let lookupHandler { return try lookupHandler(roomID, idempotencyKey) }
            return committedReplies[idempotencyKey]?.eventID
        }
    }

    public func acknowledge(deliveryID: Int) async throws {
        try lock.withLock {
            acks.append(deliveryID)
            if let ackHandler { try ackHandler(deliveryID) }
        }
    }
}
