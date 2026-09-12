import CryptoKit
import Foundation

/// Protocol ownership for an open mailbox transaction.
/// MCP self-serve sessions must not rehydrate coordinator-owned records.
public enum MailboxTransactionProtocol: String, Codable, CaseIterable, Sendable {
    case selfServeDrain = "self-serve-drain"
    case coordinatorDeliveryV1 = "coordinator-delivery-v1"
}

public enum MailboxTransactionState: String, Codable, CaseIterable, Sendable {
    case prepared
    case claimed
    case replied
}

public enum MailboxReplyResolution: String, Codable, CaseIterable, Sendable {
    case none
    case created
    case idempotencyConflict = "idempotency_conflict"
}

public enum MailboxTransactionIdentifier {
    public static let maximumFailureCountBeforeStuck = 5

    public static func claimId(instanceID: ClientInstanceID, deliveryID: Int) -> String {
        prefixedDigest(prefix: "claim_", domain: "triangle-claim-v1", instanceID: instanceID, deliveryID: deliveryID)
    }

    public static func replyIdempotencyKey(instanceID: ClientInstanceID, deliveryID: Int) -> String {
        prefixedDigest(prefix: "reply_", domain: "triangle-reply-v1", instanceID: instanceID, deliveryID: deliveryID)
    }

    private static func prefixedDigest(
        prefix: String,
        domain: String,
        instanceID: ClientInstanceID,
        deliveryID: Int
    ) -> String {
        var framed = Data(domain.utf8)
        framed.append(0)
        framed.append(contentsOf: instanceID.value.utf8)
        framed.append(0)
        framed.append(contentsOf: String(deliveryID).utf8)
        let hex = SHA256.hash(data: framed).map { String(format: "%02x", $0) }.joined()
        return prefix + String(hex.prefix(32))
    }
}

public struct MailboxRoomID: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String
    public var value: String { rawValue }

    public init?(rawValue: String) {
        guard rawValue.wholeMatch(of: /^room_[a-f0-9]{32}$/) != nil else { return nil }
        self.rawValue = rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard let room = Self(rawValue: value) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid room ID")
        }
        self = room
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct MailboxEventID: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String
    public var value: String { rawValue }

    public init?(rawValue: String) {
        guard rawValue.wholeMatch(of: /^event_[a-f0-9]{32}$/) != nil else { return nil }
        self.rawValue = rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard let event = Self(rawValue: value) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid event ID")
        }
        self = event
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct MailboxClaimID: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String
    public var value: String { rawValue }

    public init?(rawValue: String) {
        guard rawValue.wholeMatch(of: /^claim_[a-f0-9]{32}$/) != nil else { return nil }
        self.rawValue = rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard let claim = Self(rawValue: value) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid claim ID")
        }
        self = claim
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct MailboxReplyIdempotencyKey: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String
    public var value: String { rawValue }

    public init?(rawValue: String) {
        guard rawValue.wholeMatch(of: /^reply_[a-f0-9]{32}$/) != nil else { return nil }
        self.rawValue = rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard let key = Self(rawValue: value) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid reply idempotency key")
        }
        self = key
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Non-secret open transaction record (`open.json`).
public struct MailboxOpenTransaction: Codable, Equatable, Sendable {
    public let version: Int
    public let instanceID: ClientInstanceID
    public let protocolOwnership: MailboxTransactionProtocol
    public let deliveryID: Int
    public let roomID: MailboxRoomID
    public let claimID: MailboxClaimID
    public let replyIdempotencyKey: MailboxReplyIdempotencyKey
    public let state: MailboxTransactionState
    public let replyEventID: MailboxEventID?
    public let replyResolution: MailboxReplyResolution
    public let failureCount: Int
    public let lastFailureReason: String?
    public let createdAt: String

    public var isStuck: Bool { failureCount >= MailboxTransactionIdentifier.maximumFailureCountBeforeStuck }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version
        case instanceID = "instanceId"
        case protocolOwnership = "protocol"
        case deliveryID = "deliveryId"
        case roomID = "roomId"
        case claimID = "claimId"
        case replyIdempotencyKey
        case state
        case replyEventID = "replyEventId"
        case replyResolution
        case failureCount
        case lastFailureReason
        case createdAt
    }

    private struct AnyKey: CodingKey {
        let stringValue: String
        let intValue: Int?
        init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }
        init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue }
    }

    public init(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol,
        deliveryID: Int,
        roomID: MailboxRoomID,
        state: MailboxTransactionState = .prepared,
        replyEventID: MailboxEventID? = nil,
        replyResolution: MailboxReplyResolution = .none,
        failureCount: Int = 0,
        lastFailureReason: String? = nil,
        createdAt: String? = nil
    ) throws {
        let resolvedCreatedAt = createdAt ?? MailboxTransactionTimestamp.now()
        guard deliveryID > 0 else { throw MailboxTransactionStoreError.invalidRecord }
        guard failureCount >= 0, failureCount <= 10_000 else { throw MailboxTransactionStoreError.invalidRecord }
        if let lastFailureReason {
            guard lastFailureReason.wholeMatch(of: /^[a-z][a-z0-9_]{0,63}$/) != nil else {
                throw MailboxTransactionStoreError.invalidRecord
            }
        }
        guard resolvedCreatedAt.wholeMatch(of: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/) != nil else {
            throw MailboxTransactionStoreError.invalidRecord
        }
        let claim = MailboxTransactionIdentifier.claimId(instanceID: instanceID, deliveryID: deliveryID)
        let reply = MailboxTransactionIdentifier.replyIdempotencyKey(instanceID: instanceID, deliveryID: deliveryID)
        guard let claimID = MailboxClaimID(rawValue: claim),
              let replyKey = MailboxReplyIdempotencyKey(rawValue: reply)
        else { throw MailboxTransactionStoreError.invalidRecord }

        self.version = 1
        self.instanceID = instanceID
        self.protocolOwnership = protocolOwnership
        self.deliveryID = deliveryID
        self.roomID = roomID
        self.claimID = claimID
        self.replyIdempotencyKey = replyKey
        self.state = state
        self.replyEventID = replyEventID
        self.replyResolution = replyResolution
        self.failureCount = failureCount
        self.lastFailureReason = lastFailureReason
        self.createdAt = resolvedCreatedAt
    }

    public init(from decoder: Decoder) throws {
        let all = try decoder.container(keyedBy: AnyKey.self)
        let present = Set(all.allKeys.map(\.stringValue))
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        guard present == allowed else { throw MailboxTransactionStoreError.invalidRecord }

        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        guard version == 1 else { throw MailboxTransactionStoreError.invalidRecord }
        instanceID = try values.decode(ClientInstanceID.self, forKey: .instanceID)
        protocolOwnership = try values.decode(MailboxTransactionProtocol.self, forKey: .protocolOwnership)
        deliveryID = try values.decode(Int.self, forKey: .deliveryID)
        guard deliveryID > 0 else { throw MailboxTransactionStoreError.invalidRecord }
        roomID = try values.decode(MailboxRoomID.self, forKey: .roomID)
        claimID = try values.decode(MailboxClaimID.self, forKey: .claimID)
        replyIdempotencyKey = try values.decode(MailboxReplyIdempotencyKey.self, forKey: .replyIdempotencyKey)
        state = try values.decode(MailboxTransactionState.self, forKey: .state)
        replyEventID = try values.decodeIfPresent(MailboxEventID.self, forKey: .replyEventID)
        replyResolution = try values.decode(MailboxReplyResolution.self, forKey: .replyResolution)
        failureCount = try values.decode(Int.self, forKey: .failureCount)
        lastFailureReason = try values.decodeIfPresent(String.self, forKey: .lastFailureReason)
        createdAt = try values.decode(String.self, forKey: .createdAt)

        let expectedClaim = MailboxTransactionIdentifier.claimId(instanceID: instanceID, deliveryID: deliveryID)
        let expectedReply = MailboxTransactionIdentifier.replyIdempotencyKey(instanceID: instanceID, deliveryID: deliveryID)
        guard claimID.value == expectedClaim,
              replyIdempotencyKey.value == expectedReply,
              failureCount >= 0,
              failureCount <= 10_000,
              createdAt.wholeMatch(of: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/) != nil
        else { throw MailboxTransactionStoreError.invalidRecord }
        if let lastFailureReason {
            guard lastFailureReason.wholeMatch(of: /^[a-z][a-z0-9_]{0,63}$/) != nil else {
                throw MailboxTransactionStoreError.invalidRecord
            }
        }
        switch (state, replyResolution, replyEventID) {
        case (.prepared, .none, nil), (.claimed, .none, nil):
            break
        case (.replied, .created, .some), (.replied, .idempotencyConflict, _):
            break
        default:
            throw MailboxTransactionStoreError.invalidRecord
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(instanceID, forKey: .instanceID)
        try container.encode(protocolOwnership, forKey: .protocolOwnership)
        try container.encode(deliveryID, forKey: .deliveryID)
        try container.encode(roomID, forKey: .roomID)
        try container.encode(claimID, forKey: .claimID)
        try container.encode(replyIdempotencyKey, forKey: .replyIdempotencyKey)
        try container.encode(state, forKey: .state)
        try container.encode(replyEventID, forKey: .replyEventID)
        try container.encode(replyResolution, forKey: .replyResolution)
        try container.encode(failureCount, forKey: .failureCount)
        try container.encode(lastFailureReason, forKey: .lastFailureReason)
        try container.encode(createdAt, forKey: .createdAt)
    }

    public func markingClaimed() throws -> Self {
        guard state == .prepared else { throw MailboxTransactionStoreError.invalidTransition }
        return try MailboxOpenTransaction(
            instanceID: instanceID,
            protocolOwnership: protocolOwnership,
            deliveryID: deliveryID,
            roomID: roomID,
            state: .claimed,
            replyEventID: nil,
            replyResolution: .none,
            failureCount: failureCount,
            lastFailureReason: lastFailureReason,
            createdAt: createdAt
        )
    }

    public func markingReplied(eventID: MailboxEventID?, resolution: MailboxReplyResolution) throws -> Self {
        guard state == .claimed || state == .replied else { throw MailboxTransactionStoreError.invalidTransition }
        guard resolution == .created || resolution == .idempotencyConflict else {
            throw MailboxTransactionStoreError.invalidRecord
        }
        if resolution == .created {
            guard eventID != nil else { throw MailboxTransactionStoreError.invalidRecord }
        }
        return try MailboxOpenTransaction(
            instanceID: instanceID,
            protocolOwnership: protocolOwnership,
            deliveryID: deliveryID,
            roomID: roomID,
            state: .replied,
            replyEventID: eventID,
            replyResolution: resolution,
            failureCount: failureCount,
            lastFailureReason: lastFailureReason,
            createdAt: createdAt
        )
    }

    public func recordingFailure(reason: String) throws -> Self {
        guard reason.wholeMatch(of: /^[a-z][a-z0-9_]{0,63}$/) != nil else {
            throw MailboxTransactionStoreError.invalidRecord
        }
        let next = min(failureCount + 1, 10_000)
        return try MailboxOpenTransaction(
            instanceID: instanceID,
            protocolOwnership: protocolOwnership,
            deliveryID: deliveryID,
            roomID: roomID,
            state: state,
            replyEventID: replyEventID,
            replyResolution: replyResolution,
            failureCount: next,
            lastFailureReason: reason,
            createdAt: createdAt
        )
    }
}

/// Metadata-only delivery candidate (never carries message text).
public struct MailboxDeliveryCandidate: Equatable, Sendable {
    public let deliveryID: Int
    public let roomID: MailboxRoomID
    public let eventID: MailboxEventID
    public let roomSequence: Int

    public init(deliveryID: Int, roomID: MailboxRoomID, eventID: MailboxEventID, roomSequence: Int) throws {
        guard deliveryID > 0, roomSequence > 0 else { throw MailboxTransactionStoreError.invalidRecord }
        self.deliveryID = deliveryID
        self.roomID = roomID
        self.eventID = eventID
        self.roomSequence = roomSequence
    }
}

public struct MailboxQuarantinedTransaction: Equatable, Sendable {
    public let deliveryID: Int
    public let protocolOwnership: MailboxTransactionProtocol
    public let correlationID: String
    public let quarantinedAt: String
}

enum MailboxTransactionTimestamp {
    static func now() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        return formatter.string(from: Date())
    }
}
