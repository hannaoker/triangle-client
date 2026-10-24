import Foundation
import TriangleMailboxCore

@main
enum TriangleMailboxCLI {
    static func main() async {
        CredentialCustodyPolicy.enforceAtLaunch()
        do {
            let command = try CommandParser.parse(Array(CommandLine.arguments.dropFirst()))
            switch command.command {
            case .bind:
                guard let profile = command.profile, let keyFile = command.keyFile else { throw CommandParseError.missingRequiredFlag }
                let result = try await ProfileBindingService(
                    bindings: LocalCredentialStores.bindings(),
                    transport: URLSessionMeshTransport()
                ).bind(profile: profile, keyFile: URL(fileURLWithPath: keyFile), origin: command.origin)
                try render(result)
                // Nothing is written unless MESH verified the identity, so any
                // other outcome is a failed bind.
                if result.status != .verified { exit(1) }
            case .unbind:
                guard let profile = command.profile else { throw CommandParseError.missingRequiredFlag }
                try ProfileBindingService(
                    bindings: LocalCredentialStores.bindings(),
                    transport: URLSessionMeshTransport()
                ).unbind(profile: profile)
                writeJSON(["profile": profile.value, "status": "unbound"])
            case .status:
                guard let profile = command.profile else { throw CommandParseError.missingRequiredFlag }
                let result = await ProfileBindingService(
                    bindings: LocalCredentialStores.bindings(),
                    transport: URLSessionMeshTransport()
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
                let gate = LocalCredentialStores.credentialGate(transport: transport)
                let result = await MCPProxy(
                    gate: gate,
                    transport: transport,
                    transactionRewriterFactory: { credential, instanceID in
                        guard let workloadAuth = try? credential.workloadAuth(transport: transport) else { return nil }
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
                let gate = LocalCredentialStores.credentialGate(transport: transport)
                try await WorkerLauncher(
                    gate: gate, resolver: FileWorkerCommandResolver(), executor: ExecWorkerExecutor()
                ).launch(profile: profile, worker: worker)
            case .runSupervisor:
                let transport = URLSessionMeshTransport()
                let gate = LocalCredentialStores.credentialGate(transport: transport)
                try await ClientSupervisor(
                    instanceStore: FileClientInstanceStore(),
                    gate: gate,
                    workloadKeyStore: LocalCredentialStores.workload(),
                    resolver: FileWorkerCommandResolver(),
                    processRunner: FoundationClientSupervisorProcessRunner()
                ).run()
            case .preflightSupervisor:
                let transport = URLSessionMeshTransport()
                let gate = LocalCredentialStores.credentialGate(transport: transport)
                try await ClientSupervisor(
                    instanceStore: FileClientInstanceStore(),
                    gate: gate,
                    workloadKeyStore: LocalCredentialStores.workload(),
                    resolver: FileWorkerCommandResolver(),
                    processRunner: FoundationClientSupervisorProcessRunner()
                ).preflight()
            case .watchEnsure, .watchStatus, .watchRevoke, .watchPoll:
                try await runWatch(command)
            case .transactionPreflight, .transactionStatus, .transactionClaim, .transactionClaimNext, .transactionDrainReceipts, .transactionReply,
                 .transactionReadInbound, .transactionAck, .transactionAbandon, .transactionRecordFailure:
                try await runTransaction(command)
            }
        } catch CommandParseError.helpRequested(let command) {
            do {
                let rendered = try WatchCommandHelpRenderer.render(WatchCommandHelp(command: command))
                FileHandle.standardOutput.write(rendered.stdout)
                exit(rendered.exitCode)
            } catch {
                let rendered = CLIOutputRenderer.localValidationFailure
                FileHandle.standardError.write(rendered.stderr)
                exit(rendered.exitCode)
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
        } catch let error as VerifiedCredentialGateError {
            renderCredentialGateFailure(error)
        } catch let error as WatchGrantServiceError {
            renderWatchFailure(error)
        } catch {
            let detail = String(describing: error)
            let payload: [String: Any] = [
                "status": "operation_failed",
                "mustNotReregister": true,
                "safeToRetry": false,
                "errorType": String(describing: type(of: error)),
                "errorDetail": String(detail.prefix(300)),
            ]
            if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
                FileHandle.standardError.write(data)
                FileHandle.standardError.write(Data([0x0a]))
            } else {
                let rendered = CLIOutputRenderer.operationFailure
                FileHandle.standardError.write(rendered.stderr)
            }
            exit(1)
        }
    }

    private static func renderCredentialGateFailure(_ error: VerifiedCredentialGateError) -> Never {
        let payload: [String: Any]
        func failure(_ code: String, safeToRetry: Bool, _ detail: String) -> [String: Any] {
            ["status": "operation_failed", "code": code, "mustNotReregister": true, "safeToRetry": safeToRetry, "detail": detail]
        }
        switch error {
        case .profileNotFound:
            payload = failure("profile_not_found", safeToRetry: false, "No helper profile binding; run `triangle-mailbox bind --profile <name> --key-file <path>`.")
        case .credentialInvalid:
            payload = failure("credential_invalid", safeToRetry: false, "The bound workload key file or agent record is missing, unsafe, or malformed.")
        case .credentialRefused:
            payload = failure("credential_refused", safeToRetry: false, "MESH refused this agent's workload key; run `triangle doctor`.")
        case .agentPaused:
            payload = failure("agent_paused", safeToRetry: false, "The agent is paused; the owner must resume it.")
        case .offline:
            payload = failure("offline", safeToRetry: true, "Profile verification could not reach MESH.")
        case .identityMismatch:
            payload = failure("identity_mismatch", safeToRetry: false, "The bound key does not prove the recorded agent.")
        case .verificationFailed:
            payload = failure("verification_failed", safeToRetry: true, "Profile credential verification failed.")
        }
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
            FileHandle.standardError.write(data)
            FileHandle.standardError.write(Data([0x0a]))
        } else {
            FileHandle.standardError.write(CLIOutputRenderer.operationFailure.stderr)
        }
        exit(1)
    }

    private static func runTransaction(_ command: ParsedCommand) async throws {
        guard let profile = command.profile,
              let protocolOwnership = command.protocolOwnership
        else { throw CommandParseError.missingRequiredFlag }

        let instanceID = ClientInstanceID.derive(profile: profile)
        let transport = URLSessionMeshTransport()
        let gate = LocalCredentialStores.credentialGate(transport: transport)
        let credential = try await gate.credential(for: profile)
        let workloadAuth: WorkloadTokenManager
        do {
            workloadAuth = try credential.workloadAuth(transport: transport)
        } catch {
            throw VerifiedCredentialGateError.credentialInvalid
        }
        let mailboxTransport = AuthenticatedMailboxTransactionTransport(
            origin: credential.origin,
            transport: workloadAuth.observingRefusals(of: transport),
            actorID: credential.agentID
        ) { method, url in
            try await workloadAuth.authorizationHeaders(method: method, url: url)
        }
        let store = FileMailboxTransactionStore(instanceID: instanceID)
        let service = MailboxTransactionService(store: store, transport: mailboxTransport)

        switch command.command {
        case .transactionStatus:
            writeJSON(try service.status(instanceID: instanceID, protocolOwnership: protocolOwnership))
        case .transactionClaimNext:
            writeJSON(try await service.claimNext(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership,
                allowedRoomID: command.roomID.flatMap(MailboxRoomID.init(rawValue:))
            ))
        case .transactionDrainReceipts:
            writeJSON(try await service.drainReceipts(
                instanceID: instanceID,
                protocolOwnership: protocolOwnership
            ))
        case .transactionReadInbound:
            writeJSON(try await service.readInbound(instanceID: instanceID, protocolOwnership: protocolOwnership))
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
                roomSequence: roomSequence,
                replyRequired: Self.parseReplyRequired(item["replyRequired"] ?? item["reply_required"])
            )
        }
    }

    private static func parseReplyRequired(_ value: Any?) -> Bool {
        if let bool = value as? Bool { return bool }
        if let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() {
            return number.boolValue
        }
        return true
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
        // Held long-poll can run up to pollTimeoutSeconds (~25–55) on MESH; keep
        // URLSession above that so the helper does not abort a valid hold.
        let watchConfiguration = URLSessionConfiguration.ephemeral
        watchConfiguration.timeoutIntervalForRequest = 60
        watchConfiguration.timeoutIntervalForResource = 60
        let transport = URLSessionMeshTransport(configuration: watchConfiguration)
        let gate = LocalCredentialStores.credentialGate(transport: transport)
        let service = WatchGrantService(
            store: LocalCredentialStores.watchGrant(),
            transport: transport,
            auth: WorkloadWatchGrantAuthProvider(gate: gate, transport: transport),
            credentialGate: gate,
            instanceStore: FileClientInstanceStore(),
            expiryStore: FileWatchGrantExpiryStore()
        )

        do {
            switch command.command {
            case .watchEnsure:
                guard let actor = command.profile else { throw CommandParseError.missingRequiredFlag }
                let status = try await service.ensureGrant(
                    installationID: installationID,
                    actorProfile: actor,
                    memberProfiles: command.memberProfiles
                )
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
        } catch let error as CommandParseError {
            throw error
        } catch let error as WatchGrantServiceError {
            renderWatchFailure(error)
        } catch let error as VerifiedCredentialGateError {
            renderWatchFailure(error)
        } catch let error as ClientInstanceStoreError {
            renderWatchFailure(error)
        }
    }

    private static func render(_ result: ProfileStatus) throws {
        let rendered = try CLIOutputRenderer.render(result)
        FileHandle.standardOutput.write(rendered.stdout)
        FileHandle.standardError.write(rendered.stderr)
        if rendered.exitCode != 0 { exit(rendered.exitCode) }
    }

    private static func renderWatchFailure(_ error: Error) -> Never {
        do {
            let rendered = try WatchGrantFailureRenderer.render(WatchGrantFailureDiagnosis.from(error))
            FileHandle.standardError.write(rendered.stderr)
            exit(rendered.exitCode)
        } catch {
            let rendered = CLIOutputRenderer.operationFailure
            FileHandle.standardError.write(rendered.stderr)
            exit(rendered.exitCode)
        }
    }
}
