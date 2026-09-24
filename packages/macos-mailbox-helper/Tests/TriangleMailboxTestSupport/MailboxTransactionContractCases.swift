import CryptoKit
import Foundation
@_spi(MailboxTransactionTesting) import TriangleMailboxCore

public enum MailboxTransactionContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }

    public static let all: [ContractCase] = [
        .init(name: "deterministic claim and reply identifiers", run: deterministicIdentifiers),
        .init(name: "exact open.json schema and ownership", run: exactSchemaAndOwnership),
        .init(name: "one open transaction and nested claim refusal", run: oneOpenAndNestedClaim),
        .init(name: "room mismatch and unrelated ack refusal", run: roomAndAckGuards),
        .init(name: "reply idempotency conflict converges to replied", run: replyIdempotencyConflict),
        .init(name: "retry with different reply text yields one room event", run: differentTextOneEvent),
        .init(name: "unverified 409 without matching event refuses replied and ack", run: unverifiedConflictMissingEvent),
        .init(name: "unverified 409 when history lookup fails refuses replied and ack", run: unverifiedConflictLookupFailure),
        .init(name: "five failures return transaction_stuck", run: fiveFailuresStuck),
        .init(name: "quarantine abandons without releasing server claim", run: quarantineWithoutRelease),
        .init(name: "wrong protocol owner is rejected", run: wrongProtocolOwner),
        .init(name: "malicious parameters and false room IDs", run: maliciousParameters),
        .init(name: "corrupt truncate replace symlink permission faults", run: storageFaultInjection),
        .init(name: "concurrent open of state file", run: concurrentOpen),
        .init(name: "crash before local prepare", run: crashBeforeLocalPrepare),
        .init(name: "crash after local prepare", run: crashAfterLocalPrepare),
        .init(name: "crash after server claim", run: crashAfterServerClaim),
        .init(name: "crash before local reply write", run: crashBeforeLocalReplyWrite),
        .init(name: "crash after reply commit", run: crashAfterReplyCommit),
        .init(name: "crash before ack", run: crashBeforeAck),
        .init(name: "crash after ack", run: crashAfterAck),
        .init(name: "policy evaluator filters list and preflight", run: policyEvaluatorShared),
        .init(name: "claimNext lists preflights and claims pending delivery", run: claimNextFromPendingDelivery),
        .init(name: "claimNext scopes selection to the allowed room", run: claimNextScopesAllowedRoom),
        .init(name: "claimNext receipt-only acks without starting model", run: claimNextReceiptOnlyAcksWithoutModel),
        .init(name: "drainReceipts acks receipts and yields on actionable work", run: drainReceiptsAcksReceiptsAndYieldsOnWork),
        .init(name: "claimNext resumes receipt-only ack after crash", run: claimNextReceiptOnlyResumesAfterCrash),
        .init(name: "claimed inbound survives resume and is read exactly", run: claimedInboundSurvivesResume),
        .init(name: "authenticated inbound read validates exact event contract", run: authenticatedInboundReadContract),
        .init(name: "mailbox list resolves omitted replyRequired from exact room event", run: mailboxListReplyRequiredFallback),
        .init(name: "authenticated reply body includes threading fields", run: authenticatedReplyBodyThreadingFields),
        .init(name: "MCP rewriter ignores model claim and reply IDs", run: mcpRewriterIgnoresModelIDs),
        .init(name: "transaction CLI parser surface", run: transactionCommandParser),
        .init(name: "no message content in storage or status", run: noContentInStorage),
    ]

    private static let room = MailboxRoomID(rawValue: "room_" + String(repeating: "a", count: 32))!
    private static let event = MailboxEventID(rawValue: "event_" + String(repeating: "b", count: 32))!
    private static let profile = try! ProfileName("slice6-proxy")

    public static func deterministicIdentifiers() async throws {
        let instanceID = ClientInstanceID.derive(profile: profile)
        let claim = MailboxTransactionIdentifier.claimId(instanceID: instanceID, deliveryID: 12)
        let reply = MailboxTransactionIdentifier.replyIdempotencyKey(instanceID: instanceID, deliveryID: 12)
        try expect(claim.wholeMatch(of: /^claim_[a-f0-9]{32}$/) != nil, "claim id shape changed")
        try expect(reply.wholeMatch(of: /^reply_[a-f0-9]{32}$/) != nil, "reply id shape changed")

        var framed = Data("triangle-claim-v1".utf8)
        framed.append(0)
        framed.append(contentsOf: instanceID.value.utf8)
        framed.append(0)
        framed.append(contentsOf: "12".utf8)
        let expected = "claim_" + SHA256.hash(data: framed).map { String(format: "%02x", $0) }.joined().prefix(32)
        try expect(claim == String(expected), "claim derivation drifted")
    }

    public static func exactSchemaAndOwnership() async throws {
        try await withFileStore { store, root, instanceID in
            let open = try MailboxOpenTransaction(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                deliveryID: 7,
                roomID: room
            )
            try store.prepare(open)
            let path = root.appendingPathComponent("open.json")
            try expect(try mode(path) == 0o600, "open.json mode is not 0600")
            try expect(try mode(root) == 0o700, "transaction directory mode is not 0700")
            let data = try Data(contentsOf: path)
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            try expect(object?["protocol"] as? String == "coordinator-delivery-v1", "protocol missing")
            try expect(Set(Array((object ?? [:]).keys)) == Set([
                "version", "instanceId", "protocol", "deliveryId", "roomId", "claimId",
                "inboundEventId", "inboundRoomSequence", "replyRequired",
                "replyIdempotencyKey", "state", "replyEventId", "replyResolution",
                "failureCount", "lastFailureReason", "createdAt",
            ]), "open.json schema keys drifted")
            try expect(String(decoding: data, as: UTF8.self).contains("please reply") == false, "message text leaked into store")
        }
    }

    public static func oneOpenAndNestedClaim() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await service.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 1,
            roomID: room,
            modelSuppliedClaimID: "claim_" + String(repeating: "f", count: 32)
        )
        do {
            _ = try await service.claim(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                deliveryID: 2,
                roomID: room
            )
            throw ContractFailure("nested claim was accepted")
        } catch MailboxTransactionServiceError.nestedClaim {
            // expected
        }
        let open = try store.readOpen(instanceID: instanceID)
        try expect(open?.deliveryID == 1, "first delivery was replaced")
        try expect(open?.claimID.value != "claim_" + String(repeating: "f", count: 32), "model claim id was retained")
    }

    public static func roomAndAckGuards() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await service.claim(
            instanceID: instanceID,
            protocolOwnership: .selfServeDrain,
            deliveryID: 3,
            roomID: room
        )
        let otherRoom = MailboxRoomID(rawValue: "room_" + String(repeating: "c", count: 32))!
        do {
            _ = try await service.reply(
                instanceID: instanceID,
                protocolOwnership: .selfServeDrain,
                roomID: otherRoom,
                text: "x"
            )
            throw ContractFailure("false room was accepted")
        } catch MailboxTransactionServiceError.roomMismatch {}

        do {
            try await service.acknowledge(
                instanceID: instanceID,
                protocolOwnership: .selfServeDrain,
                deliveryID: 99
            )
            throw ContractFailure("unrelated ack was accepted before reply")
        } catch MailboxTransactionServiceError.unrelatedAcknowledgement,
                MailboxTransactionServiceError.invalidState {}
    }

    public static func replyIdempotencyConflict() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        transport.replyHandler = { _, _, _, _ in .idempotencyConflict }
        transport.lookupHandler = { _, _ in "event_" + String(repeating: "d", count: 32) }
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await service.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 4,
            roomID: room
        )
        let replied = try await service.reply(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            roomID: room,
            text: "first"
        )
        try expect(replied.state == .replied, "conflict did not mark replied")
        try expect(replied.replyResolution == .idempotencyConflict, "resolution not recorded")
        try expect(replied.replyEventID?.value == "event_" + String(repeating: "d", count: 32), "verified conflict missing event ID")
        try await service.acknowledge(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 4
        )
        try expect(try store.readOpen(instanceID: instanceID) == nil, "ack did not clear open transaction")
    }

    public static func differentTextOneEvent() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await service.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 5,
            roomID: room
        )
        let first = try await service.reply(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            roomID: room,
            text: "alpha"
        )
        try expect(first.replyResolution == .created, "first reply was not created")

        // Simulate crash after reply local write was lost: reopen as claimed with same identifiers.
        let claimed = try MailboxOpenTransaction(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 5,
            roomID: room,
            state: .claimed,
            createdAt: first.createdAt
        )
        let store2 = InMemoryMailboxTransactionStore()
        try store2.prepare(claimed)
        let service2 = MailboxTransactionService(store: store2, transport: transport)
        let second = try await service2.reply(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            roomID: room,
            text: "beta-different"
        )
        // Different text under the same key yields 409; history must recover the original event.
        try expect(second.replyResolution == .idempotencyConflict, "different text did not conflict on same key")
        try expect(second.replyEventID == first.replyEventID, "verified conflict did not recover original event")
        try expect(
            transport.replies.filter { $0.key == claimed.replyIdempotencyKey.value }.count >= 2,
            "retry did not reuse key"
        )
        try expect(
            Set(transport.replies.map(\.key)).count == 1,
            "retry introduced a second reply idempotency key"
        )
        // Verified conflict may ack; the delivery is proven committed under the deterministic key.
        try await service2.acknowledge(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 5
        )
        try expect(try store2.readOpen(instanceID: instanceID) == nil, "verified conflict ack did not clear")
    }

    public static func unverifiedConflictMissingEvent() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        transport.replyHandler = { _, _, _, _ in .idempotencyConflict }
        transport.lookupHandler = { _, _ in nil }
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await service.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 51,
            roomID: room
        )
        do {
            _ = try await service.reply(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                roomID: room,
                text: "unverified"
            )
            throw ContractFailure("missing history match was treated as replied")
        } catch MailboxTransactionServiceError.unverifiedReplyConflict {}

        let open = try store.readOpen(instanceID: instanceID)
        try expect(open?.state == .claimed, "unverified conflict advanced past claimed")
        try expect(open?.replyEventID == nil, "unverified conflict recorded a reply event")
        do {
            try await service.acknowledge(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                deliveryID: 51
            )
            throw ContractFailure("ack was allowed after unverified conflict")
        } catch MailboxTransactionServiceError.invalidState {}
        try expect(try store.readOpen(instanceID: instanceID)?.state == .claimed, "ack cleared unverified open txn")
        try expect(transport.acks.isEmpty, "server ack issued after unverified conflict")
    }

    public static func unverifiedConflictLookupFailure() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        transport.replyHandler = { _, _, _, _ in .idempotencyConflict }
        transport.lookupHandler = { _, _ in throw MailboxTransactionServiceError.upstreamUnavailable }
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await service.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 52,
            roomID: room
        )
        do {
            _ = try await service.reply(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                roomID: room,
                text: "lookup-failed"
            )
            throw ContractFailure("failed history lookup was treated as replied")
        } catch MailboxTransactionServiceError.unverifiedReplyConflict {}

        let open = try store.readOpen(instanceID: instanceID)
        try expect(open?.state == .claimed, "lookup failure advanced past claimed")
        do {
            try await service.acknowledge(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                deliveryID: 52
            )
            throw ContractFailure("ack was allowed after lookup failure")
        } catch MailboxTransactionServiceError.invalidState {}
        try expect(try store.readOpen(instanceID: instanceID)?.state == .claimed, "ack cleared lookup-failed open txn")
        try expect(transport.acks.isEmpty, "server ack issued after lookup failure")
    }

    public static func fiveFailuresStuck() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await service.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 6,
            roomID: room
        )
        for index in 1...4 {
            _ = try service.recordFailure(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                reason: "turn_failed_\(index)"
            )
        }
        do {
            _ = try service.recordFailure(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                reason: "turn_failed_5"
            )
            throw ContractFailure("fifth failure did not stick")
        } catch MailboxTransactionServiceError.transactionStuck {}
        let evaluation = try MailboxPolicyEvaluator.evaluate(
            protocolOwnership: .coordinatorDeliveryV1,
            candidates: [try MailboxDeliveryCandidate(deliveryID: 6, roomID: room, eventID: event, roomSequence: 1)],
            open: try store.readOpen(instanceID: instanceID),
            quarantined: []
        )
        try expect(evaluation.transactionStuck, "policy did not report stuck")
        try expect(!evaluation.shouldStartModel, "stuck transaction still starts model")
    }

    public static func quarantineWithoutRelease() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await service.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 8,
            roomID: room
        )
        let quarantined = try service.abandon(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1
        )
        try expect(quarantined.deliveryID == 8, "quarantine lost delivery")
        try expect(try store.readOpen(instanceID: instanceID) == nil, "open remained after abandon")
        let listed = try store.listQuarantined(instanceID: instanceID)
        try expect(listed.count == 1, "quarantine list empty")
        let evaluation = try MailboxPolicyEvaluator.evaluate(
            protocolOwnership: .coordinatorDeliveryV1,
            candidates: [try MailboxDeliveryCandidate(deliveryID: 8, roomID: room, eventID: event, roomSequence: 1)],
            open: nil,
            quarantined: listed
        )
        try expect(evaluation.actionable.isEmpty, "quarantined delivery remained actionable")
        try expect(transport.acks.isEmpty, "abandon pretended to ack/release claim")
    }

    public static func wrongProtocolOwner() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await service.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 9,
            roomID: room
        )
        do {
            _ = try await service.reply(
                instanceID: instanceID,
                protocolOwnership: .selfServeDrain,
                roomID: room,
                text: "nope"
            )
            throw ContractFailure("cross-protocol reply accepted")
        } catch MailboxTransactionServiceError.protocolMismatch {}
    }

    public static func maliciousParameters() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let rewriter = MCPTransactionRewriter(
            instanceID: ClientInstanceID.derive(profile: profile),
            protocolOwnership: .selfServeDrain,
            store: store,
            transport: transport
        )
        let raw = Data(#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mesh.mailbox.claim","arguments":{"delivery_id":1,"room_id":"room_not_hex","claim_id":"claim_ffffffffffffffffffffffffffffffff"}}}"#.utf8)
        let outcome = await rewriter.rewriteOutgoing(
            requestMethod: "tools/call",
            params: [
                "name": "mesh.mailbox.claim",
                "arguments": [
                    "delivery_id": 1,
                    "room_id": "room_not_hex",
                    "claim_id": "claim_ffffffffffffffffffffffffffffffff",
                ],
            ],
            raw: raw
        )
        guard case .reject = outcome else { throw ContractFailure("malicious room was not rejected") }
    }

    public static func storageFaultInjection() async throws {
        try await withFileStore { store, root, instanceID in
            let open = try MailboxOpenTransaction(
                instanceID: instanceID,
                protocolOwnership: .selfServeDrain,
                deliveryID: 10,
                roomID: room
            )
            try store.prepare(open)
            let path = root.appendingPathComponent("open.json")

            try Data(#"{"version":1,"truncated":true}"#.utf8).write(to: path)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            do {
                _ = try store.readOpen(instanceID: instanceID)
                throw ContractFailure("corrupt record accepted")
            } catch MailboxTransactionStoreError.invalidRecord {}

            try Data("{".utf8).write(to: path)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            do {
                _ = try store.readOpen(instanceID: instanceID)
                throw ContractFailure("truncated record accepted")
            } catch MailboxTransactionStoreError.invalidRecord {}

            try FileManager.default.removeItem(at: path)
            try FileManager.default.createSymbolicLink(atPath: path.path, withDestinationPath: "/dev/null")
            do {
                _ = try store.readOpen(instanceID: instanceID)
                throw ContractFailure("symlink accepted")
            } catch MailboxTransactionStoreError.unsafeStorage {}

            try FileManager.default.removeItem(at: path)
            try store.prepare(open)
            try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: path.path)
            do {
                _ = try store.readOpen(instanceID: instanceID)
                throw ContractFailure("world-writable record accepted")
            } catch MailboxTransactionStoreError.unsafeStorage {}
        }
    }

    public static func concurrentOpen() async throws {
        try await withFileStore { store, _, instanceID in
            let open = try MailboxOpenTransaction(
                instanceID: instanceID,
                protocolOwnership: .selfServeDrain,
                deliveryID: 11,
                roomID: room
            )
            try store.prepare(open)
            do {
                try store.prepare(open)
                throw ContractFailure("concurrent second open accepted")
            } catch MailboxTransactionStoreError.alreadyOpen {}
        }
    }

    public static func crashBeforeLocalPrepare() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(
            store: store,
            transport: transport,
            simulatedCrashAt: .beforeLocalPrepare
        )
        let instanceID = ClientInstanceID.derive(profile: profile)
        do {
            _ = try await service.claim(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                deliveryID: 20,
                roomID: room
            )
            throw ContractFailure("crash before prepare did not interrupt")
        } catch MailboxTransactionServiceError.upstreamUnavailable {}
        try expect(try store.readOpen(instanceID: instanceID) == nil, "prepare leaked before crash")
        try expect(transport.claims.isEmpty, "server claim happened before local prepare")
    }

    public static func crashAfterLocalPrepare() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(
            store: store,
            transport: transport,
            simulatedCrashAt: .afterLocalPrepare
        )
        let instanceID = ClientInstanceID.derive(profile: profile)
        do {
            _ = try await service.claim(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                deliveryID: 21,
                roomID: room
            )
            throw ContractFailure("crash after prepare did not interrupt")
        } catch MailboxTransactionServiceError.upstreamUnavailable {}
        let open = try store.readOpen(instanceID: instanceID)
        try expect(open?.state == .prepared, "prepared state lost")
        try expect(transport.claims.isEmpty, "server claim happened despite crash after prepare")

        // Recovery reuses identifiers.
        let recovered = MailboxTransactionService(store: store, transport: transport)
        let claimed = try await recovered.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 21,
            roomID: room
        )
        try expect(claimed.state == .claimed, "recovery claim failed")
        try expect(claimed.claimID == open?.claimID, "claim id changed after crash recovery")
    }

    public static func crashAfterServerClaim() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(
            store: store,
            transport: transport,
            simulatedCrashAt: .afterServerClaim
        )
        let instanceID = ClientInstanceID.derive(profile: profile)
        do {
            _ = try await service.claim(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                deliveryID: 22,
                roomID: room
            )
            throw ContractFailure("crash after server claim did not interrupt")
        } catch MailboxTransactionServiceError.upstreamUnavailable {}
        try expect(transport.claims.count == 1, "server claim missing")
        let open = try store.readOpen(instanceID: instanceID)
        try expect(open?.state == .prepared, "local state advanced past prepare without durable claimed write")

        transport.claimHandler = { _, claimID in
            MailboxClaimTransportResult(claimed: true, claimID: claimID, idempotent: true)
        }
        let recovered = MailboxTransactionService(store: store, transport: transport)
        let claimed = try await recovered.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 22,
            roomID: room
        )
        try expect(claimed.state == .claimed, "idempotent reclaim recovery failed")
    }

    public static func crashBeforeLocalReplyWrite() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(
            store: store,
            transport: transport,
            simulatedCrashAt: .beforeLocalReplyWrite
        )
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await MailboxTransactionService(store: store, transport: transport).claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 23,
            roomID: room
        )
        do {
            _ = try await service.reply(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                roomID: room,
                text: "hello"
            )
            throw ContractFailure("crash before reply write did not interrupt")
        } catch MailboxTransactionServiceError.upstreamUnavailable {}
        try expect(transport.replies.isEmpty, "reply reached server before local gate")
        try expect(try store.readOpen(instanceID: instanceID)?.state == .claimed, "claimed state lost")
    }

    public static func crashAfterReplyCommit() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let service = MailboxTransactionService(
            store: store,
            transport: transport,
            simulatedCrashAt: .afterReplyCommit
        )
        let instanceID = ClientInstanceID.derive(profile: profile)
        _ = try await MailboxTransactionService(store: store, transport: transport).claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 24,
            roomID: room
        )
        do {
            _ = try await service.reply(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                roomID: room,
                text: "hello"
            )
            throw ContractFailure("crash after reply commit did not interrupt")
        } catch MailboxTransactionServiceError.upstreamUnavailable {}
        let open = try store.readOpen(instanceID: instanceID)
        try expect(open?.state == .replied, "reply commit not durable")
        // Ack must still succeed even across crash.
        try await MailboxTransactionService(store: store, transport: transport).acknowledge(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 24
        )
        try expect(try store.readOpen(instanceID: instanceID) == nil, "ack after crash lost")
        try expect(transport.acks == [24], "ack missing after reply-commit crash")
    }

    public static func crashBeforeAck() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let instanceID = ClientInstanceID.derive(profile: profile)
        let baseline = MailboxTransactionService(store: store, transport: transport)
        _ = try await baseline.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 25,
            roomID: room
        )
        _ = try await baseline.reply(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            roomID: room,
            text: "hello"
        )
        let service = MailboxTransactionService(
            store: store,
            transport: transport,
            simulatedCrashAt: .beforeAck
        )
        do {
            try await service.acknowledge(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                deliveryID: 25
            )
            throw ContractFailure("crash before ack did not interrupt")
        } catch MailboxTransactionServiceError.upstreamUnavailable {}
        try expect(transport.acks.isEmpty, "ack reached server before crash gate")
        try expect(try store.readOpen(instanceID: instanceID)?.state == .replied, "replied state lost")
        try await baseline.acknowledge(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 25
        )
        try expect(transport.acks == [25], "recovery ack failed")
    }

    public static func crashAfterAck() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let instanceID = ClientInstanceID.derive(profile: profile)
        let baseline = MailboxTransactionService(store: store, transport: transport)
        _ = try await baseline.claim(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            deliveryID: 26,
            roomID: room
        )
        _ = try await baseline.reply(
            instanceID: instanceID,
            protocolOwnership: .coordinatorDeliveryV1,
            roomID: room,
            text: "hello"
        )
        let service = MailboxTransactionService(
            store: store,
            transport: transport,
            simulatedCrashAt: .afterAck
        )
        do {
            try await service.acknowledge(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                deliveryID: 26
            )
            throw ContractFailure("crash after ack did not interrupt")
        } catch MailboxTransactionServiceError.upstreamUnavailable {}
        try expect(transport.acks == [26], "server ack missing")
        try expect(try store.readOpen(instanceID: instanceID) == nil, "local clear missing after ack")
    }

    public static func policyEvaluatorShared() async throws {
        let candidates = [
            try MailboxDeliveryCandidate(deliveryID: 1, roomID: room, eventID: event, roomSequence: 1),
            try MailboxDeliveryCandidate(deliveryID: 2, roomID: room, eventID: event, roomSequence: 2),
        ]
        let evaluation = try MailboxPolicyEvaluator.evaluate(
            protocolOwnership: .selfServeDrain,
            candidates: candidates,
            open: nil,
            quarantined: [
                MailboxQuarantinedTransaction(
                    deliveryID: 1,
                    protocolOwnership: .selfServeDrain,
                    correlationID: "q_" + String(repeating: "1", count: 16),
                    quarantinedAt: MailboxTransactionTimestamp.now()
                ),
            ]
        )
        try expect(evaluation.actionable.map { $0.deliveryID } == [2], "quarantined item remained actionable")
        let filtered = MailboxPolicyEvaluator.filterListItems(
            [
                ["deliveryId": 1, "roomId": room.value],
                ["deliveryId": 2, "roomId": room.value],
            ],
            evaluation: evaluation
        )
        try expect(filtered.count == 1 && filtered[0]["deliveryId"] as? Int == 2, "list filter mismatch")
    }

    public static func claimNextFromPendingDelivery() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        transport.pendingCandidates = [
            try MailboxDeliveryCandidate(deliveryID: 51, roomID: room, eventID: event, roomSequence: 3),
        ]
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)

        try expect(try store.readOpen(instanceID: instanceID) == nil, "fixture started with open transaction")
        let payload = try await service.claimNext(
            instanceID: instanceID,
            protocolOwnership: .selfServeDrain
        )
        try expect(transport.listCalls == 1, "claimNext did not list mailbox")
        try expect(transport.claims.map(\.0) == [51], "claimNext did not claim pending delivery")
        try expect(payload["shouldStartModel"] as? Bool == true, "shouldStartModel missing after claim")
        let open = payload["open"] as? [String: Any]
        try expect(open?["deliveryId"] as? Int == 51, "open delivery mismatch")
        try expect(open?["state"] as? String == "claimed", "open state mismatch")
        try expect(try store.readOpen(instanceID: instanceID)?.deliveryID == 51, "local open missing after claimNext")

        // Second call resumes without listing/claiming again.
        let resumed = try await service.claimNext(
            instanceID: instanceID,
            protocolOwnership: .selfServeDrain
        )
        try expect(transport.listCalls == 1, "resume listed mailbox again")
        try expect(transport.claims.count == 1, "resume reclaimed delivery")
        try expect(resumed["shouldStartModel"] as? Bool == true, "resume shouldStartModel false")
        try expect(payload["replyRequired"] as? Bool == true, "work claim missing replyRequired")
    }

    public static func claimNextScopesAllowedRoom() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let allowedRoom = MailboxRoomID(rawValue: "room_" + String(repeating: "c", count: 32))!
        let allowedEvent = MailboxEventID(rawValue: "event_" + String(repeating: "d", count: 32))!
        transport.pendingCandidates = [
            try MailboxDeliveryCandidate(deliveryID: 40, roomID: room, eventID: event, roomSequence: 1),
            try MailboxDeliveryCandidate(deliveryID: 41, roomID: allowedRoom, eventID: allowedEvent, roomSequence: 1),
        ]
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)

        let payload = try await service.claimNext(
            instanceID: instanceID,
            protocolOwnership: .selfServeDrain,
            allowedRoomID: allowedRoom
        )

        try expect(transport.claims.map(\.0) == [41], "claimNext crossed the allowed room boundary")
        let open = payload["open"] as? [String: Any]
        try expect(open?["roomId"] as? String == allowedRoom.value, "claimed room mismatch")
    }

    public static func claimNextReceiptOnlyAcksWithoutModel() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        transport.pendingCandidates = [
            try MailboxDeliveryCandidate(
                deliveryID: 61,
                roomID: room,
                eventID: event,
                roomSequence: 4,
                admitText: "status: completed\nquota ok",
                replyRequired: false
            ),
        ]
        let service = MailboxTransactionService(store: store, transport: transport)
        let instanceID = ClientInstanceID.derive(profile: profile)

        let payload = try await service.claimNext(
            instanceID: instanceID,
            protocolOwnership: .selfServeDrain
        )
        try expect(transport.listCalls == 1, "receipt claimNext did not list mailbox")
        try expect(transport.claims.map(\.0) == [61], "receipt claimNext did not claim")
        try expect(transport.acks == [61], "receipt claimNext did not ack")
        try expect(payload["shouldStartModel"] as? Bool == false, "receipt shouldStartModel true")
        try expect(payload["replyRequired"] as? Bool == false, "receipt replyRequired missing")
        try expect(payload["receiptOnly"] as? Bool == true, "receiptOnly flag missing")
        try expect(payload["open"] is NSNull, "receipt left open transaction")
        try expect(try store.readOpen(instanceID: instanceID) == nil, "receipt left local open.json")
        try expect(payload["admitText"] == nil, "receipt returned admitText")
    }

    public static func drainReceiptsAcksReceiptsAndYieldsOnWork() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let instanceID = ClientInstanceID.derive(profile: profile)

        // Case 1: Receipt-only candidate is claimed and acked
        transport.pendingCandidates = [
            try MailboxDeliveryCandidate(
                deliveryID: 71,
                roomID: room,
                eventID: event,
                roomSequence: 5,
                replyRequired: false
            ),
        ]
        let service = MailboxTransactionService(store: store, transport: transport)
        let receiptPayload = try await service.drainReceipts(
            instanceID: instanceID,
            protocolOwnership: .selfServeDrain
        )
        try expect(transport.claims.map(\.0) == [71], "drainReceipts did not claim receipt")
        try expect(transport.acks == [71], "drainReceipts did not ack receipt")
        try expect(receiptPayload["receiptOnly"] as? Bool == true, "receiptPayload missing receiptOnly")

        // Case 2: Actionable work (replyRequired: true) is NOT claimed by drainReceipts
        let store2 = InMemoryMailboxTransactionStore()
        let transport2 = RecordingMailboxTransactionTransport()
        transport2.pendingCandidates = [
            try MailboxDeliveryCandidate(
                deliveryID: 72,
                roomID: room,
                eventID: event,
                roomSequence: 6,
                replyRequired: true
            ),
        ]
        let service2 = MailboxTransactionService(store: store2, transport: transport2)
        let workPayload = try await service2.drainReceipts(
            instanceID: instanceID,
            protocolOwnership: .selfServeDrain
        )
        try expect(transport2.claims.isEmpty, "drainReceipts claimed actionable work!")
        try expect(transport2.acks.isEmpty, "drainReceipts acked actionable work!")
        try expect(workPayload["actionableWorkPending"] as? Bool == true, "workPayload missing actionableWorkPending")
        try expect(workPayload["replyRequired"] as? Bool == true, "workPayload missing replyRequired")
    }

    public static func claimNextReceiptOnlyResumesAfterCrash() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        transport.pendingCandidates = [
            try MailboxDeliveryCandidate(
                deliveryID: 62,
                roomID: room,
                eventID: event,
                roomSequence: 5,
                replyRequired: false
            ),
        ]
        let instanceID = ClientInstanceID.derive(profile: profile)
        let crashing = MailboxTransactionService(
            store: store,
            transport: transport,
            simulatedCrashAt: .beforeAck
        )
        do {
            _ = try await crashing.claimNext(instanceID: instanceID, protocolOwnership: .selfServeDrain)
            throw ContractFailure("receipt claim did not stop before ack")
        } catch MailboxTransactionServiceError.upstreamUnavailable {}

        let open = try store.readOpen(instanceID: instanceID)
        try expect(open?.state == .claimed, "receipt claim was not durable")
        try expect(open?.replyRequired == false, "receipt-only intent was not durable")
        try expect(transport.acks.isEmpty, "crash-before-ack issued an ack")

        let resumedService = MailboxTransactionService(store: store, transport: transport)
        let payload = try await resumedService.claimNext(
            instanceID: instanceID,
            protocolOwnership: .selfServeDrain
        )
        try expect(payload["receiptOnly"] as? Bool == true, "resumed receipt lost receiptOnly")
        try expect(payload["shouldStartModel"] as? Bool == false, "resumed receipt started model")
        try expect(transport.acks == [62], "resumed receipt was not acked exactly once")
        try expect(try store.readOpen(instanceID: instanceID) == nil, "resumed receipt left open transaction")
        try expect(transport.listCalls == 1, "resume relisted instead of settling durable receipt")
    }

    public static func claimedInboundSurvivesResume() async throws {
        try await withFileStore { store, root, instanceID in
            let transport = RecordingMailboxTransactionTransport()
            transport.pendingCandidates = [
                try MailboxDeliveryCandidate(deliveryID: 52, roomID: room, eventID: event, roomSequence: 17),
            ]
            transport.inboundTextHandler = { roomID, eventID, roomSequence in
                try expect(roomID == room.value, "inbound read escaped claimed room")
                try expect(eventID == event.value, "inbound read escaped claimed event")
                try expect(roomSequence == 17, "inbound read escaped claimed sequence")
                return "CODEX-BOB-E2E-20260913T190000PT"
            }

            let claimingService = MailboxTransactionService(store: store, transport: transport)
            _ = try await claimingService.claimNext(
                instanceID: instanceID,
                protocolOwnership: .selfServeDrain
            )

            let data = try Data(contentsOf: root.appendingPathComponent("open.json"))
            let rendered = String(decoding: data, as: UTF8.self)
            try expect(rendered.contains(event.value), "claimed inbound event ID was not persisted")
            try expect(!rendered.contains("CODEX-BOB-E2E"), "inbound text leaked into transaction store")

            // A new service instance represents a later wake resuming the durable claim.
            let resumedService = MailboxTransactionService(store: store, transport: transport)
            let payload = try await resumedService.readInbound(
                instanceID: instanceID,
                protocolOwnership: .selfServeDrain
            )
            try expect(payload["inboundEventId"] as? String == event.value, "read returned wrong event ID")
            try expect(payload["text"] as? String == "CODEX-BOB-E2E-20260913T190000PT", "read returned wrong text")
            try expect(transport.inboundReadCalls == 1, "inbound event was not fetched exactly once")
        }
    }

    public static func authenticatedReplyBodyThreadingFields() async throws {
        let origin = try MeshOrigin("https://thetriangle.dev")
        let mesh = RecordingAuthenticatedMeshTransport()
        let transport = AuthenticatedMailboxTransactionTransport(
            origin: origin,
            transport: mesh,
            actorID: AgentID(rawValue: "agent_" + String(repeating: "d", count: 32))!
        ) { _, _ in ["Authorization": "Bearer test"] }
        let sourceEvent = event.value
        let result = try await transport.sendReply(
            roomID: room.value,
            idempotencyKey: "reply_" + String(repeating: "d", count: 32),
            text: "threaded reply",
            inReplyToEventID: sourceEvent
        )
        guard case .created = result else { throw ContractFailure("reply did not create") }
        try expect(mesh.requests.count == 1, "expected one room append")
        let request = mesh.requests[0]
        try expect(request.method == "POST", "reply method mismatch")
        try expect(request.url.path.contains("/api/v1/rooms/\(room.value)/events"), "reply path mismatch")
        let object = try JSONSerialization.jsonObject(with: request.body) as? [String: Any]
        try expect(object?["type"] as? String == "message.created", "type missing")
        try expect(object?["in_reply_to_event_id"] == nil, "threading field leaked to top level")
        try expect(object?["inReplyToEventId"] == nil, "camelCase threading field leaked to top level")
        let body = object?["body"] as? [String: Any]
        try expect(body?["text"] as? String == "threaded reply", "text missing from body")
        try expect(body?["replyRequired"] as? Bool == false, "replyRequired missing from body")
        try expect(body?["inReplyToEventId"] as? String == sourceEvent, "inReplyToEventId missing from body")
    }

    public static func authenticatedInboundReadContract() async throws {
        let origin = try MeshOrigin("https://thetriangle.dev")
        let mesh = RecordingAuthenticatedMeshTransport()
        let actor = AgentID(rawValue: "agent_" + String(repeating: "d", count: 32))!
        let sender = "agent_" + String(repeating: "e", count: 32)
        mesh.responseHandler = { request in
            let body = Data(#"{"roomId":"\#(room.value)","items":[{"id":"\#(event.value)","roomId":"\#(room.value)","sequence":17,"senderAgentId":"\#(sender)","type":"message.created","body":{"text":"CODEX-BOB-E2E-EXACTPT"}}]}"#.utf8)
            return MeshHTTPResponse(statusCode: 200, headers: [:], body: body, finalURL: request.url)
        }
        let transport = AuthenticatedMailboxTransactionTransport(
            origin: origin,
            transport: mesh,
            actorID: actor
        ) { _, _ in ["Authorization": "Bearer test"] }

        let text = try await transport.readInboundEvent(roomID: room.value, eventID: event.value, roomSequence: 17)
        try expect(text == "CODEX-BOB-E2E-EXACTPT", "canonical inbound text was not returned")
        guard let request = mesh.requests.first else { throw ContractFailure("inbound history request missing") }
        try expect(request.method == "GET", "inbound history method mismatch")
        try expect(request.url.path == "/api/v1/rooms/\(room.value)/events", "inbound history path mismatch")
        let components = URLComponents(url: request.url, resolvingAgainstBaseURL: false)
        let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        try expect(query == ["after_sequence": "16", "limit": "1"], "inbound history query is not exact")
        try expect(request.headers["Authorization"] == "Bearer test", "inbound history authorization missing")

        mesh.responseHandler = { request in
            let body = Data(#"{"roomId":"\#(room.value)","items":[{"id":"\#(event.value)","roomId":"\#(room.value)","sequence":17,"senderAgentId":"\#(actor.value)","type":"message.created","body":{"text":"must reject self"}}]}"#.utf8)
            return MeshHTTPResponse(statusCode: 200, headers: [:], body: body, finalURL: request.url)
        }
        do {
            _ = try await transport.readInboundEvent(roomID: room.value, eventID: event.value, roomSequence: 17)
            throw ContractFailure("self-sent inbound event was accepted")
        } catch MailboxTransactionServiceError.invalidUpstreamResponse {}
    }

    public static func mailboxListReplyRequiredFallback() async throws {
        let origin = try MeshOrigin("https://thetriangle.dev")
        let mesh = RecordingAuthenticatedMeshTransport()
        let actor = AgentID(rawValue: "agent_" + String(repeating: "d", count: 32))!
        let sender = "agent_" + String(repeating: "e", count: 32)
        mesh.responseHandler = { request in
            if request.url.path == "/api/v1/mailbox" {
                let body = Data(#"{"items":[{"deliveryId":73,"roomId":"\#(room.value)","eventId":"\#(event.value)","roomSequence":17,"text":"Acked."}]}"#.utf8)
                return MeshHTTPResponse(statusCode: 200, headers: [:], body: body, finalURL: request.url)
            }
            let body = Data(#"{"roomId":"\#(room.value)","items":[{"id":"\#(event.value)","sequence":17,"senderAgentId":"\#(sender)","type":"message.created","body":{"text":"Acked.","replyRequired":false}}]}"#.utf8)
            return MeshHTTPResponse(statusCode: 200, headers: [:], body: body, finalURL: request.url)
        }
        let transport = AuthenticatedMailboxTransactionTransport(
            origin: origin,
            transport: mesh,
            actorID: actor
        ) { _, _ in ["Authorization": "Bearer test"] }

        let candidates = try await transport.listPendingCandidates()
        try expect(candidates.count == 1, "mailbox candidate missing")
        try expect(candidates[0].replyRequired == false, "room event replyRequired was not applied")
        try expect(mesh.requests.count == 2, "missing exact room-event fallback request")
        let components = URLComponents(url: mesh.requests[1].url, resolvingAgainstBaseURL: false)
        let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        try expect(query == ["after_sequence": "16", "limit": "1"], "fallback query did not target exact sequence")
    }

    public static func mcpRewriterIgnoresModelIDs() async throws {
        let store = InMemoryMailboxTransactionStore()
        let transport = RecordingMailboxTransactionTransport()
        let instanceID = ClientInstanceID.derive(profile: profile)
        let rewriter = MCPTransactionRewriter(
            instanceID: instanceID,
            protocolOwnership: .selfServeDrain,
            store: store,
            transport: transport
        )
        let modelClaim = "claim_" + String(repeating: "e", count: 32)
        let raw = Data(#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"mesh.mailbox.claim","arguments":{"delivery_id":30,"room_id":"\#(room.value)","claim_id":"\#(modelClaim)"}}}"#.utf8)
        let outcome = await rewriter.rewriteOutgoing(
            requestMethod: "tools/call",
            params: [
                "name": "mesh.mailbox.claim",
                "arguments": [
                    "delivery_id": 30,
                    "room_id": room.value,
                    "claim_id": modelClaim,
                ],
            ],
            raw: raw
        )
        guard case .respond(let body) = outcome else { throw ContractFailure("claim rewrite did not respond") }
        let object = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        let result = object?["result"] as? [String: Any]
        let claimID = result?["claimId"] as? String
        try expect(claimID != modelClaim, "model claim id was honored")
        try expect(claimID == MailboxTransactionIdentifier.claimId(instanceID: instanceID, deliveryID: 30), "deterministic claim missing")
    }

    public static func transactionCommandParser() async throws {
        let parsed = try CommandParser.parse([
            "transaction-claim",
            "--profile", "mailbox",
            "--protocol", "coordinator-delivery-v1",
            "--delivery-id", "12",
            "--room-id", room.value,
            "--event-id", event.value,
        ])
        try expect(parsed.command == .transactionClaim, "claim command rejected")
        try expect(parsed.protocolOwnership == .coordinatorDeliveryV1, "protocol missing")
        try expect(parsed.deliveryID == 12, "delivery missing")

        let claimNext = try CommandParser.parse([
            "transaction-claim-next",
            "--profile", "mailbox",
            "--protocol", "self-serve-drain",
        ])
        try expect(claimNext.command == .transactionClaimNext, "claim-next command rejected")
        try expect(claimNext.protocolOwnership == .selfServeDrain, "claim-next protocol missing")

        let readInbound = try CommandParser.parse([
            "transaction-read-inbound",
            "--profile", "mailbox",
            "--protocol", "self-serve-drain",
        ])
        try expect(readInbound.command == .transactionReadInbound, "read-inbound command rejected")

        let abandon = try CommandParser.parse([
            "transaction-abandon",
            "--profile", "mailbox",
            "--protocol", "self-serve-drain",
            "--confirm",
        ])
        try expect(abandon.confirmAbandon, "confirm missing")

        for invalid in [
            ["transaction-claim", "--profile", "mailbox", "--protocol", "coordinator-delivery-v1"],
            ["transaction-claim-next", "--profile", "mailbox"],
            ["transaction-abandon", "--profile", "mailbox", "--protocol", "self-serve-drain"],
            ["transaction-record-failure", "--profile", "mailbox", "--protocol", "self-serve-drain", "--reason", "BAD"],
        ] {
            do {
                _ = try CommandParser.parse(invalid)
                throw ContractFailure("invalid transaction command accepted")
            } catch is CommandParseError {}
        }
    }

    public static func noContentInStorage() async throws {
        try await withFileStore { store, root, instanceID in
            let transport = RecordingMailboxTransactionTransport()
            let service = MailboxTransactionService(store: store, transport: transport)
            _ = try await service.claim(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                deliveryID: 40,
                roomID: room
            )
            _ = try await service.reply(
                instanceID: instanceID,
                protocolOwnership: .coordinatorDeliveryV1,
                roomID: room,
                text: "SECRET_PEER_TEXT_SHOULD_NOT_PERSIST"
            )
            let data = try Data(contentsOf: root.appendingPathComponent("open.json"))
            let rendered = String(decoding: data, as: UTF8.self)
            try expect(!rendered.contains("SECRET_PEER_TEXT_SHOULD_NOT_PERSIST"), "reply text persisted")
            let status = try service.status(instanceID: instanceID, protocolOwnership: .coordinatorDeliveryV1)
            let statusData = try JSONSerialization.data(withJSONObject: status, options: [.sortedKeys])
            try expect(!String(decoding: statusData, as: UTF8.self).contains("SECRET_PEER_TEXT_SHOULD_NOT_PERSIST"), "status leaked text")
        }
    }

    private static func withFileStore(
        _ body: (FileMailboxTransactionStore, URL, ClientInstanceID) async throws -> Void
    ) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mailbox-txn-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let store = FileMailboxTransactionStore(testRoot: root)
        try await body(store, root, ClientInstanceID.derive(profile: profile))
    }

    private static func mode(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let number = attributes[.posixPermissions] as? NSNumber else {
            throw ContractFailure("missing permissions")
        }
        return number.intValue
    }

    private static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw ContractFailure(message) }
    }
}

private final class RecordingAuthenticatedMeshTransport: MeshTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var requests: [MeshHTTPRequest] = []
    var responseHandler: (@Sendable (MeshHTTPRequest) throws -> MeshHTTPResponse)?

    private func record(_ request: MeshHTTPRequest) {
        lock.lock()
        requests.append(request)
        lock.unlock()
    }

    func send(_ request: MeshHTTPRequest) async throws -> MeshHTTPResponse {
        // Keep NSLock off the async context (macOS 27 SDK marks lock/unlock unavailable there).
        record(request)
        if let responseHandler { return try responseHandler(request) }
        if request.method == "POST", request.url.path.contains("/events") {
            let body = Data(#"{"event":{"id":"event_cccccccccccccccccccccccccccccccc"}}"#.utf8)
            return MeshHTTPResponse(statusCode: 201, headers: [:], body: body, finalURL: request.url)
        }
        return MeshHTTPResponse(statusCode: 200, headers: [:], body: Data(#"{"items":[]}"#.utf8), finalURL: request.url)
    }
}
