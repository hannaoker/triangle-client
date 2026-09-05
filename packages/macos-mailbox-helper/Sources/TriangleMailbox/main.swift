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
                let result = await MCPProxy(gate: gate, transport: transport).run(
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
        } catch {
            let rendered = CLIOutputRenderer.operationFailure
            FileHandle.standardOutput.write(rendered.stdout)
            FileHandle.standardError.write(rendered.stderr)
            exit(rendered.exitCode)
        }
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
