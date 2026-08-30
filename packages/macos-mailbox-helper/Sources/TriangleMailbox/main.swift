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

    private static func render(_ result: ProfileStatus) throws {
        let rendered = try CLIOutputRenderer.render(result)
        FileHandle.standardOutput.write(rendered.stdout)
        FileHandle.standardError.write(rendered.stderr)
        if rendered.exitCode != 0 { exit(rendered.exitCode) }
    }
}
