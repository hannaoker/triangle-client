import Foundation
import TriangleMailboxCore

@main
enum TriangleMailboxCLI {
    static func main() async {
        do {
            let command = try CommandParser.parse(Array(CommandLine.arguments.dropFirst()))
            switch command.command {
            case .enroll:
                guard let profile = command.profile, let origin = command.origin else { throw CommandParseError.missingRequiredFlag }
                let input = try BoundedInputReader.readOneDocument(from: .standardInput)
                let result = try await EnrollmentService(
                    store: KeychainCredentialStore(), transport: URLSessionMeshTransport(),
                    reservation: FileEnrollmentReservation(), journal: FileEnrollmentJournal()
                ).enroll(profile: profile, origin: origin, inputData: input)
                try render(result)
            case .status:
                guard let profile = command.profile else { throw CommandParseError.missingRequiredFlag }
                let result = try await EnrollmentService(
                    store: KeychainCredentialStore(), transport: URLSessionMeshTransport(),
                    reservation: FileEnrollmentReservation(), journal: FileEnrollmentJournal()
                ).status(profile: profile)
                let verifiedAt = result.status == .verified ? Date() : nil
                let rendered = try OperatorStatusRenderer.render(
                    result,
                    verificationTimestamp: verifiedAt
                )
                FileHandle.standardOutput.write(rendered.stdout)
                FileHandle.standardError.write(rendered.stderr)
                if rendered.exitCode != 0 { exit(rendered.exitCode) }
            case .mcp:
                guard let profile = command.profile else { throw CommandParseError.missingRequiredFlag }
                let transport = URLSessionMeshTransport()
                let gate = VerifiedCredentialGate(
                    store: KeychainCredentialStore(), transport: transport,
                    reservation: FileEnrollmentReservation(), journal: FileEnrollmentJournal()
                )
                let workloadKeyStore = KeychainWorkloadKeyStore()
                let result = await MCPProxy(
                    gate: gate,
                    transport: transport,
                    workloadKeyStore: workloadKeyStore,
                    transactionRewriterFactory: { credential, instanceID in
                        let workloadAuth: WorkloadTokenManager?
                        if let workloadRecord = try? workloadKeyStore.read(for: profile) {
                            workloadAuth = try? WorkloadTokenManager(
                                origin: credential.origin,
                                workloadRecord: workloadRecord,
                                transport: transport
                            )
                        } else {
                            workloadAuth = nil
                        }
                        return MCPProxy.productionTransactionRewriter(
                            credential: credential,
                            instanceID: instanceID,
                            transport: transport,
                            workloadAuth: workloadAuth
                        )
                    }
                ).run(
                    profile: profile,
                    input: FileHandleMCPProxyInput(),
                    output: FileHandleMCPProxyOutput()
                )
                switch result {
                case .completed: return
                case .failed: exit(1)
                case .terminatedForSecretInvariant: exit(70)
                }
            case .runWorker:
                guard let profile = command.profile, let worker = command.worker else { throw CommandParseError.missingRequiredFlag }
                let transport = URLSessionMeshTransport()
                let gate = VerifiedCredentialGate(
                    store: KeychainCredentialStore(), transport: transport,
                    reservation: FileEnrollmentReservation(), journal: FileEnrollmentJournal()
                )
                try await WorkerLauncher(
                    gate: gate, resolver: FileWorkerCommandResolver(), executor: ExecWorkerExecutor()
                ).launch(profile: profile, worker: worker)
            case .runSupervisor:
                let transport = URLSessionMeshTransport()
                let gate = VerifiedCredentialGate(
                    store: KeychainCredentialStore(), transport: transport,
                    reservation: FileEnrollmentReservation(), journal: FileEnrollmentJournal()
                )
                try await ClientSupervisor(
                    instanceStore: FileClientInstanceStore(),
                    gate: gate,
                    resolver: FileWorkerCommandResolver(),
                    processRunner: FoundationClientSupervisorProcessRunner()
                ).run()
            case .preflightSupervisor:
                let transport = URLSessionMeshTransport()
                let gate = VerifiedCredentialGate(
                    store: KeychainCredentialStore(), transport: transport,
                    reservation: FileEnrollmentReservation(), journal: FileEnrollmentJournal()
                )
                try await ClientSupervisor(
                    instanceStore: FileClientInstanceStore(),
                    gate: gate,
                    resolver: FileWorkerCommandResolver(),
                    processRunner: FoundationClientSupervisorProcessRunner()
                ).preflight()
            case .watchEnsure, .watchStatus, .watchRevoke, .watchPoll:
                try await runWatch(command)
            case .transactionPreflight, .transactionStatus, .transactionClaim, .transactionReply,
                 .transactionAck, .transactionAbandon, .transactionRecordFailure:
                try await runTransaction(command)
            }
        } catch is CommandParseError {
            let rendered = CLIOutputRenderer.localValidationFailure
            FileHandle.standardOutput.write(rendered.stdout)
            FileHandle.standardError.write(rendered.stderr)
            exit(rendered.exitCode)
        } catch EnrollmentError.invalidInput {
            let rendered = CLIOutputRenderer.localValidationFailure
            FileHandle.standardOutput.write(rendered.stdout)
            FileHandle.standardError.write(rendered.stderr)
            exit(rendered.exitCode)
        } catch MailboxTransactionServiceError.transactionStuck {
            writeJSON(["error": "transaction_stuck"])
            exit(4)
        } catch MailboxTransactionServiceError.unverifiedReplyConflict {
            writeJSON(["error": "unverified_reply_conflict"])
            exit(5)
        } catch {
            let rendered = CLIOutputRenderer.operationFailure
            FileHandle.standardOutput.write(rendered.stdout)
            FileHandle.standardError.write(rendered.stderr)
            exit(rendered.exitCode)
        }
    }

    private static func runTransaction(_ command: ParsedCommand) async throws {
        guard let profile = command.profile,
              let protocolOwnership = command.protocolOwnership
        else { throw CommandParseError.missingRequiredFlag }

        let instanceID = ClientInstanceID.derive(profile: profile)
        let transport = URLSessionMeshTransport()
        let gate = VerifiedCredentialGate(
            store: KeychainCredentialStore(), transport: transport,
            reservation: FileEnrollmentReservation(), journal: FileEnrollmentJournal()
        )
        let credential = try await gate.credential(for: profile)
        let workloadKeyStore = KeychainWorkloadKeyStore()
        let workloadAuth: WorkloadTokenManager?
        if let workloadRecord = try? workloadKeyStore.read(for: profile) {
            workloadAuth = try? WorkloadTokenManager(
                origin: credential.origin,
                workloadRecord: workloadRecord,
                transport: transport
            )
        } else {
            workloadAuth = nil
        }
        let mailboxTransport = AuthenticatedMailboxTransactionTransport(
            origin: credential.origin,
            transport: transport
        ) { method, url in
            if let workloadAuth {
                return try await workloadAuth.authorizationHeaders(method: method, url: url)
            }
            return ["Authorization": credential.authorizationValue]
        }
        let store = FileMailboxTransactionStore(instanceID: instanceID)
        let service = MailboxTransactionService(store: store, transport: mailboxTransport)

        switch command.command {
        case .transactionStatus:
            writeJSON(try service.status(instanceID: instanceID, protocolOwnership: protocolOwnership))
        case .transactionPreflight:
            let input = try BoundedInputReader.readOneDocument(from: .standardInput, limit: 64 * 1024)
            let candidates = try decodeCandidates(input)
            writeJSON(try service.preflight(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership,
                candidates: candidates
            ))
        case .transactionClaim:
            guard let deliveryID = command.deliveryID,
                  let roomRaw = command.roomID,
                  let roomID = MailboxRoomID(rawValue: roomRaw)
            else { throw CommandParseError.missingRequiredFlag }
            let open = try await service.claim(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership,
                deliveryID: deliveryID,
                roomID: roomID
            )
            writeJSON([
                "deliveryId": open.deliveryID,
                "roomId": open.roomID.value,
                "claimId": open.claimID.value,
                "replyIdempotencyKey": open.replyIdempotencyKey.value,
                "state": open.state.rawValue,
                "protocol": open.protocolOwnership.rawValue,
            ])
        case .transactionReply:
            let input = try BoundedInputReader.readOneDocument(from: .standardInput, limit: 64 * 1024)
            guard let object = try JSONSerialization.jsonObject(with: input) as? [String: Any],
                  let roomRaw = object["roomId"] as? String ?? object["room_id"] as? String,
                  let roomID = MailboxRoomID(rawValue: roomRaw),
                  let text = object["text"] as? String
            else { throw CommandParseError.invalidFlagValue }
            let inReplyRaw = object["inReplyToEventId"] as? String ?? object["in_reply_to_event_id"] as? String
            let open = try await service.reply(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership,
                roomID: roomID,
                text: text,
                inReplyToEventID: inReplyRaw.flatMap(MailboxEventID.init(rawValue:))
            )
            var payload: [String: Any] = [
                "deliveryId": open.deliveryID,
                "state": open.state.rawValue,
                "replyResolution": open.replyResolution.rawValue,
                "replyIdempotencyKey": open.replyIdempotencyKey.value,
            ]
            if let eventID = open.replyEventID {
                payload["replyEventId"] = eventID.value
            }
            writeJSON(payload)
        case .transactionAck:
            try await service.acknowledge(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership,
                deliveryID: nil
            )
            writeJSON(["acknowledged": true])
        case .transactionAbandon:
            guard command.confirmAbandon else { throw CommandParseError.missingRequiredFlag }
            let quarantined = try service.abandon(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership
            )
            writeJSON([
                "quarantined": true,
                "correlationId": quarantined.correlationID,
                "deliveryId": quarantined.deliveryID,
                "serverClaimReleased": false,
            ])
        case .transactionRecordFailure:
            guard let reason = command.failureReason else { throw CommandParseError.missingRequiredFlag }
            let open = try service.recordFailure(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership,
                reason: reason
            )
            writeJSON([
                "deliveryId": open.deliveryID,
                "failureCount": open.failureCount,
                "lastFailureReason": open.lastFailureReason as Any,
                "transactionStuck": open.isStuck,
            ])
        default:
            throw CommandParseError.invalidCommand
        }
    }

    private static func decodeCandidates(_ data: Data) throws -> [MailboxDeliveryCandidate] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = object["candidates"] as? [[String: Any]] ?? object["items"] as? [[String: Any]]
        else { throw CommandParseError.invalidFlagValue }
        return try items.map { item in
            guard let deliveryID = item["deliveryId"] as? Int ?? (item["delivery_id"] as? Int),
                  let roomRaw = item["roomId"] as? String ?? item["room_id"] as? String,
                  let roomID = MailboxRoomID(rawValue: roomRaw),
                  let eventRaw = item["eventId"] as? String ?? item["event_id"] as? String,
                  let eventID = MailboxEventID(rawValue: eventRaw),
                  let roomSequence = item["roomSequence"] as? Int ?? item["room_sequence"] as? Int
            else { throw CommandParseError.invalidFlagValue }
            return try MailboxDeliveryCandidate(
                deliveryID: deliveryID,
                roomID: roomID,
                eventID: eventID,
                roomSequence: roomSequence
            )
        }
    }

    private static func writeJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            FileHandle.standardError.write(Data("{\"error\":\"encode_failed\"}\n".utf8))
            exit(1)
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }

    private static func runWatch(_ command: ParsedCommand) async throws {
        guard let installationID = command.installationID else { throw CommandParseError.missingRequiredFlag }
        let transport = URLSessionMeshTransport()
        let gate = VerifiedCredentialGate(
            store: KeychainCredentialStore(), transport: transport,
            reservation: FileEnrollmentReservation(), journal: FileEnrollmentJournal()
        )
        let workloadKeyStore = KeychainWorkloadKeyStore()
        let service = WatchGrantService(
            store: KeychainWatchGrantStore(),
            transport: transport,
            auth: WorkloadWatchGrantAuthProvider(gate: gate, workloadKeyStore: workloadKeyStore, transport: transport),
            credentialGate: gate,
            instanceStore: FileClientInstanceStore()
        )

        switch command.command {
        case .watchEnsure:
            guard let actor = command.profile else { throw CommandParseError.missingRequiredFlag }
            let status = try await service.ensureGrant(installationID: installationID, actorProfile: actor)
            let rendered = try WatchGrantOperatorStatusRenderer.render(status)
            FileHandle.standardOutput.write(rendered.stdout)
            if rendered.exitCode != 0 { exit(rendered.exitCode) }
        case .watchStatus:
            let status = try service.status(installationID: installationID)
            let rendered = try WatchGrantOperatorStatusRenderer.render(status)
            FileHandle.standardOutput.write(rendered.stdout)
            if rendered.exitCode != 0 { exit(rendered.exitCode) }
        case .watchRevoke:
            let status = try await service.revoke(installationID: installationID)
            let rendered = try WatchGrantOperatorStatusRenderer.render(status)
            FileHandle.standardOutput.write(rendered.stdout)
            if rendered.exitCode != 0 { exit(rendered.exitCode) }
        case .watchPoll:
            guard let cursor = command.cursor else { throw CommandParseError.missingRequiredFlag }
            do {
                let response = try await service.poll(installationID: installationID, cursor: cursor)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                var stdout = try encoder.encode(response)
                stdout.append(0x0a)
                FileHandle.standardOutput.write(stdout)
            } catch WatchGrantServiceError.resyncRequired(let restartCursor) {
                let payload: [String: Any] = [
                    "error": "resync_required",
                    "restart_cursor": restartCursor,
                ]
                let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
                FileHandle.standardOutput.write(data)
                FileHandle.standardOutput.write(Data([0x0a]))
                exit(3)
            }
        default:
            throw CommandParseError.invalidCommand
        }
    }

    private static func render(_ result: ProfileStatus) throws {
        let rendered = try CLIOutputRenderer.render(result)
        FileHandle.standardOutput.write(rendered.stdout)
        FileHandle.standardError.write(rendered.stderr)
        if rendered.exitCode != 0 { exit(rendered.exitCode) }
    }
}
