import Foundation

public enum MailboxTransactionServiceError: Error, Equatable, Sendable {
    case invalidInput
    case protocolMismatch
    case nestedClaim
    case roomMismatch
    case unrelatedAcknowledgement
    case transactionStuck
    case notOpen
    case invalidState
    case claimConflict
    case upstreamUnavailable
    case invalidUpstreamResponse
    case unverifiedReplyConflict
    case secretInvariant
}

public enum MailboxTransactionServiceCrashPoint: Equatable, Sendable {
    case beforeLocalPrepare
    case afterLocalPrepare
    case afterServerClaim
    case beforeLocalReplyWrite
    case afterReplyCommit
    case beforeAck
    case afterAck
}

/// Network boundary used by the trusted transaction proxy (REST, not MCP).
public protocol MailboxTransactionTransport: Sendable {
    /// Metadata-only pending mailbox page (never includes message text).
    func listPendingCandidates() async throws -> [MailboxDeliveryCandidate]
    func claim(deliveryID: Int, claimID: String) async throws -> MailboxClaimTransportResult
    func readInboundEvent(roomID: String, eventID: String, roomSequence: Int) async throws -> String
    func sendReply(
        roomID: String,
        idempotencyKey: String,
        text: String,
        inReplyToEventID: String?
    ) async throws -> MailboxReplyTransportResult
    func lookupReplyEventID(roomID: String, idempotencyKey: String) async throws -> String?
    func acknowledge(deliveryID: Int, claimID: String) async throws
}

public struct MailboxClaimTransportResult: Equatable, Sendable {
    public let claimed: Bool
    public let claimID: String
    public let idempotent: Bool

    public init(claimed: Bool, claimID: String, idempotent: Bool) {
        self.claimed = claimed
        self.claimID = claimID
        self.idempotent = idempotent
    }
}

public enum MailboxReplyTransportResult: Equatable, Sendable {
    case created(eventID: String)
    case idempotencyConflict
}

/// Trusted claim/reply/ack orchestration shared by helper CLI and MCP rewriting.
public struct MailboxTransactionService: Sendable {
    private let store: any MailboxTransactionStore
    private let transport: any MailboxTransactionTransport
    private let simulatedCrashAt: MailboxTransactionServiceCrashPoint?

    public init(
        store: any MailboxTransactionStore,
        transport: any MailboxTransactionTransport,
        simulatedCrashAt: MailboxTransactionServiceCrashPoint? = nil
    ) {
        self.store = store
        self.transport = transport
        self.simulatedCrashAt = simulatedCrashAt
    }

    public func status(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol
    ) throws -> [String: Any] {
        let open = try store.readOpen(instanceID: instanceID)
        if let open, open.protocolOwnership != protocolOwnership {
            throw MailboxTransactionServiceError.protocolMismatch
        }
        let quarantined = try store.listQuarantined(instanceID: instanceID)
        let evaluation = try MailboxPolicyEvaluator.evaluate(
            protocolOwnership: protocolOwnership,
            candidates: [],
            open: open,
            quarantined: quarantined
        )
        return secretFreeStatus(evaluation: evaluation, quarantined: quarantined)
    }

    public func preflight(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol,
        candidates: [MailboxDeliveryCandidate]
    ) throws -> [String: Any] {
        let open = try store.readOpen(instanceID: instanceID)
        if let open, open.protocolOwnership != protocolOwnership {
            throw MailboxTransactionServiceError.protocolMismatch
        }
        let quarantined = try store.listQuarantined(instanceID: instanceID)
        let evaluation = try MailboxPolicyEvaluator.evaluate(
            protocolOwnership: protocolOwnership,
            candidates: candidates,
            open: open,
            quarantined: quarantined
        )
        var payload = secretFreeStatus(evaluation: evaluation, quarantined: quarantined)
        payload["actionable"] = evaluation.actionable.map { candidate in
            [
                "deliveryId": candidate.deliveryID,
                "roomId": candidate.roomID.value,
                "eventId": candidate.eventID.value,
                "roomSequence": candidate.roomSequence,
            ] as [String: Any]
        }
        return payload
    }

    /// List → preflight → claim the next actionable delivery, or resume an open claim.
    /// Used by App Server wake so a pending mailbox delivery can start a model turn.
    public func claimNext(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol,
        allowedRoomID: MailboxRoomID? = nil
    ) async throws -> [String: Any] {
        if let open = try store.readOpen(instanceID: instanceID) {
            if open.protocolOwnership != protocolOwnership {
                throw MailboxTransactionServiceError.protocolMismatch
            }
            if open.isStuck {
                throw MailboxTransactionServiceError.transactionStuck
            }
            if let allowedRoomID, open.roomID != allowedRoomID {
                throw MailboxTransactionServiceError.roomMismatch
            }
            if open.replyRequired == false {
                return try await settleReceiptOnly(
                    instanceID: instanceID,
                    open: open,
                    quarantined: try store.listQuarantined(instanceID: instanceID)
                )
            }
            let quarantined = try store.listQuarantined(instanceID: instanceID)
            let evaluation = try MailboxPolicyEvaluator.evaluate(
                protocolOwnership: protocolOwnership,
                candidates: [],
                open: open,
                quarantined: quarantined
            )
            return secretFreeStatus(evaluation: evaluation, quarantined: quarantined)
        }

        let candidates: [MailboxDeliveryCandidate]
        do {
            candidates = try await transport.listPendingCandidates()
        } catch {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        let scopedCandidates = allowedRoomID.map { allowed in
            candidates.filter { $0.roomID == allowed }
        } ?? candidates
        let quarantined = try store.listQuarantined(instanceID: instanceID)
        let evaluation = try MailboxPolicyEvaluator.evaluate(
            protocolOwnership: protocolOwnership,
            candidates: scopedCandidates,
            open: nil,
            quarantined: quarantined
        )
        guard let next = evaluation.actionable.min(by: { $0.deliveryID < $1.deliveryID }) else {
            return secretFreeStatus(evaluation: evaluation, quarantined: quarantined)
        }
        let claimed = try await claim(
            instanceID: instanceID,
            protocolOwnership: protocolOwnership,
            deliveryID: next.deliveryID,
            roomID: next.roomID,
            inboundEventID: next.eventID,
            inboundRoomSequence: next.roomSequence,
            replyRequired: next.replyRequired
        )

        // Receipt-only: claim → ack without a model turn or MESH reply (mirrors mailbox-client).
        if next.replyRequired == false {
            return try await settleReceiptOnly(
                instanceID: instanceID,
                open: claimed,
                quarantined: quarantined,
                remainingCandidates: scopedCandidates.filter { $0.deliveryID != next.deliveryID }
            )
        }

        let afterClaim = try MailboxPolicyEvaluator.evaluate(
            protocolOwnership: protocolOwnership,
            candidates: scopedCandidates,
            open: claimed,
            quarantined: quarantined
        )
        var payload = secretFreeStatus(evaluation: afterClaim, quarantined: quarantined)
        payload["replyRequired"] = true
        if let admitText = next.admitText {
            payload["admitText"] = admitText
        }
        return payload
    }

    public func claim(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol,
        deliveryID: Int,
        roomID: MailboxRoomID,
        inboundEventID: MailboxEventID? = nil,
        inboundRoomSequence: Int? = nil,
        replyRequired: Bool = true,
        modelSuppliedClaimID: String? = nil
    ) async throws -> MailboxOpenTransaction {
        _ = modelSuppliedClaimID // intentionally ignored / replaced
        if let existing = try store.readOpen(instanceID: instanceID) {
            if existing.protocolOwnership != protocolOwnership {
                throw MailboxTransactionServiceError.protocolMismatch
            }
            if existing.deliveryID == deliveryID && existing.roomID == roomID {
                if existing.isStuck { throw MailboxTransactionServiceError.transactionStuck }
                // Idempotent resume of the same open claim.
                if existing.state == .prepared {
                    return try await finishClaim(existing)
                }
                return existing
            }
            throw MailboxTransactionServiceError.nestedClaim
        }

        if simulatedCrashAt == .beforeLocalPrepare {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }

        let prepared = try MailboxOpenTransaction(
            instanceID: instanceID,
            protocolOwnership: protocolOwnership,
            deliveryID: deliveryID,
            roomID: roomID,
            inboundEventID: inboundEventID,
            inboundRoomSequence: inboundRoomSequence,
            replyRequired: replyRequired,
            state: .prepared
        )
        try store.prepare(prepared)
        if simulatedCrashAt == .afterLocalPrepare {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        return try await finishClaim(prepared)
    }

    private func settleReceiptOnly(
        instanceID: ClientInstanceID,
        open: MailboxOpenTransaction,
        quarantined: [MailboxQuarantinedTransaction],
        remainingCandidates: [MailboxDeliveryCandidate] = []
    ) async throws -> [String: Any] {
        guard open.state == .claimed, open.replyRequired == false else {
            throw MailboxTransactionServiceError.invalidState
        }
        if simulatedCrashAt == .beforeAck {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        do {
            try await transport.acknowledge(deliveryID: open.deliveryID, claimID: open.claimID.value)
        } catch {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        try store.clear(instanceID: instanceID, expectedDeliveryID: open.deliveryID)
        if simulatedCrashAt == .afterAck {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        let evaluation = try MailboxPolicyEvaluator.evaluate(
            protocolOwnership: open.protocolOwnership,
            candidates: remainingCandidates,
            open: nil,
            quarantined: quarantined
        )
        var payload = secretFreeStatus(evaluation: evaluation, quarantined: quarantined)
        payload["replyRequired"] = false
        payload["receiptOnly"] = true
        return payload
    }

    /// Fetches peer text ephemerally for the exact event bound to the durable open claim.
    public func readInbound(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol
    ) async throws -> [String: Any] {
        guard let open = try store.readOpen(instanceID: instanceID) else {
            throw MailboxTransactionServiceError.notOpen
        }
        guard open.protocolOwnership == protocolOwnership else {
            throw MailboxTransactionServiceError.protocolMismatch
        }
        guard open.state == .claimed,
              let eventID = open.inboundEventID,
              let roomSequence = open.inboundRoomSequence
        else { throw MailboxTransactionServiceError.invalidState }
        let text: String
        do {
            text = try await transport.readInboundEvent(
                roomID: open.roomID.value,
                eventID: eventID.value,
                roomSequence: roomSequence
            )
        } catch MailboxTransactionServiceError.invalidUpstreamResponse {
            throw MailboxTransactionServiceError.invalidUpstreamResponse
        } catch {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        guard !text.isEmpty, text.utf8.count <= 32 * 1024 else {
            throw MailboxTransactionServiceError.invalidUpstreamResponse
        }
        return [
            "deliveryId": open.deliveryID,
            "roomId": open.roomID.value,
            "inboundEventId": eventID.value,
            "text": text,
        ]
    }

    public func reply(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol,
        roomID: MailboxRoomID,
        text: String,
        inReplyToEventID: MailboxEventID? = nil,
        modelSuppliedIdempotencyKey: String? = nil
    ) async throws -> MailboxOpenTransaction {
        _ = modelSuppliedIdempotencyKey // intentionally ignored / replaced
        guard !text.isEmpty, text.utf8.count <= 32 * 1024 else {
            throw MailboxTransactionServiceError.invalidInput
        }
        // Never persist or return peer text from this service.
        guard let open = try store.readOpen(instanceID: instanceID) else {
            throw MailboxTransactionServiceError.notOpen
        }
        guard open.protocolOwnership == protocolOwnership else {
            throw MailboxTransactionServiceError.protocolMismatch
        }
        guard open.roomID == roomID else { throw MailboxTransactionServiceError.roomMismatch }
        if let inboundEventID = open.inboundEventID,
           let inReplyToEventID,
           inReplyToEventID != inboundEventID
        {
            throw MailboxTransactionServiceError.invalidInput
        }
        if open.isStuck { throw MailboxTransactionServiceError.transactionStuck }

        if open.state == .replied {
            return open
        }
        guard open.state == .claimed else { throw MailboxTransactionServiceError.invalidState }

        if simulatedCrashAt == .beforeLocalReplyWrite {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }

        let transportResult: MailboxReplyTransportResult
        do {
            transportResult = try await transport.sendReply(
                roomID: roomID.value,
                idempotencyKey: open.replyIdempotencyKey.value,
                text: text,
                inReplyToEventID: (inReplyToEventID ?? open.inboundEventID)?.value
            )
        } catch {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }

        let next: MailboxOpenTransaction
        switch transportResult {
        case .created(let eventIDRaw):
            guard let eventID = MailboxEventID(rawValue: eventIDRaw) else {
                throw MailboxTransactionServiceError.invalidUpstreamResponse
            }
            next = try open.markingReplied(eventID: eventID, resolution: .created)
        case .idempotencyConflict:
            // A bare HTTP 409 is not proof the intended reply committed. Only mark
            // replied after a successful history lookup recovers the event for the
            // deterministic reply key in this room.
            let recovered: String?
            do {
                recovered = try await transport.lookupReplyEventID(
                    roomID: roomID.value,
                    idempotencyKey: open.replyIdempotencyKey.value
                )
            } catch {
                throw MailboxTransactionServiceError.unverifiedReplyConflict
            }
            guard let recovered, let eventID = MailboxEventID(rawValue: recovered) else {
                throw MailboxTransactionServiceError.unverifiedReplyConflict
            }
            next = try open.markingReplied(eventID: eventID, resolution: .idempotencyConflict)
        }

        try store.replace(next)
        if simulatedCrashAt == .afterReplyCommit {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        return next
    }

    public func acknowledge(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol,
        deliveryID: Int?,
        modelSuppliedDeliveryID: Int? = nil
    ) async throws {
        _ = modelSuppliedDeliveryID
        guard let open = try store.readOpen(instanceID: instanceID) else {
            throw MailboxTransactionServiceError.notOpen
        }
        guard open.protocolOwnership == protocolOwnership else {
            throw MailboxTransactionServiceError.protocolMismatch
        }
        if let deliveryID, deliveryID != open.deliveryID {
            throw MailboxTransactionServiceError.unrelatedAcknowledgement
        }
        // Receipt-only deliveries are claimed and acknowledged atomically in
        // claimNext. A general ack requires a verified committed reply.
        guard open.state == .replied, open.replyEventID != nil else {
            throw MailboxTransactionServiceError.invalidState
        }

        if simulatedCrashAt == .beforeAck {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        do {
            try await transport.acknowledge(deliveryID: open.deliveryID, claimID: open.claimID.value)
        } catch {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        try store.clear(instanceID: instanceID, expectedDeliveryID: open.deliveryID)
        if simulatedCrashAt == .afterAck {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
    }

    public func recordFailure(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol,
        reason: String
    ) throws -> MailboxOpenTransaction {
        guard let open = try store.readOpen(instanceID: instanceID) else {
            throw MailboxTransactionServiceError.notOpen
        }
        guard open.protocolOwnership == protocolOwnership else {
            throw MailboxTransactionServiceError.protocolMismatch
        }
        let next = try open.recordingFailure(reason: reason)
        try store.replace(next)
        if next.isStuck { throw MailboxTransactionServiceError.transactionStuck }
        return next
    }

    public func abandon(
        instanceID: ClientInstanceID,
        protocolOwnership: MailboxTransactionProtocol
    ) throws -> MailboxQuarantinedTransaction {
        guard let open = try store.readOpen(instanceID: instanceID) else {
            throw MailboxTransactionServiceError.notOpen
        }
        guard open.protocolOwnership == protocolOwnership else {
            throw MailboxTransactionServiceError.protocolMismatch
        }
        return try store.abandon(instanceID: instanceID)
    }

    private func finishClaim(_ prepared: MailboxOpenTransaction) async throws -> MailboxOpenTransaction {
        let result: MailboxClaimTransportResult
        do {
            result = try await transport.claim(
                deliveryID: prepared.deliveryID,
                claimID: prepared.claimID.value
            )
        } catch {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        guard result.claimed, result.claimID == prepared.claimID.value else {
            if !result.claimed { throw MailboxTransactionServiceError.claimConflict }
            throw MailboxTransactionServiceError.invalidUpstreamResponse
        }
        if simulatedCrashAt == .afterServerClaim {
            throw MailboxTransactionServiceError.upstreamUnavailable
        }
        let claimed = try prepared.markingClaimed()
        try store.replace(claimed)
        return claimed
    }

    private func secretFreeStatus(
        evaluation: MailboxPolicyEvaluator.Evaluation,
        quarantined: [MailboxQuarantinedTransaction]
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "ruleSetVersion": evaluation.ruleSetVersion,
            "protocol": evaluation.protocolOwnership.rawValue,
            "status": evaluation.status,
            "transactionStuck": evaluation.transactionStuck,
            "shouldStartModel": evaluation.shouldStartModel,
            "suppressedDeliveryIds": evaluation.suppressedDeliveryIDs,
            "quarantined": quarantined.map {
                [
                    "correlationId": $0.correlationID,
                    "deliveryId": $0.deliveryID,
                    "protocol": $0.protocolOwnership.rawValue,
                    "serverClaimReleased": false,
                ] as [String: Any]
            },
        ]
        if let open = evaluation.open {
            payload["open"] = [
                "deliveryId": open.deliveryID,
                "roomId": open.roomID.value,
                "inboundEventId": open.inboundEventID?.value as Any,
                "inboundRoomSequence": open.inboundRoomSequence as Any,
                "claimId": open.claimID.value,
                "replyIdempotencyKey": open.replyIdempotencyKey.value,
                "state": open.state.rawValue,
                "replyEventId": open.replyEventID?.value as Any,
                "replyResolution": open.replyResolution.rawValue,
                "failureCount": open.failureCount,
                "lastFailureReason": open.lastFailureReason as Any,
            ]
        } else {
            payload["open"] = NSNull()
        }
        return payload
    }
}
