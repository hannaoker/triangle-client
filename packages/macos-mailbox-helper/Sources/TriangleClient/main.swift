import Darwin
import Foundation
import TriangleMailboxCore

@main
enum TriangleClientCLI {
    static func main() async {
        do {
            let command = try TriangleClientCommandParser.parse(Array(CommandLine.arguments.dropFirst()))
            let transport = URLSessionMeshTransport()
            let service = TriangleClientAgentService(
                instanceStore: FileClientInstanceStore(),
                credentialGate: VerifiedCredentialGate(
                    store: KeychainCredentialStore(), transport: transport,
                    reservation: FileEnrollmentReservation(), journal: FileEnrollmentJournal()
                ),
                runtimeReadiness: { instance in _ = try FileWorkerCommandResolver().resolveAdapter(for: instance) },
                serviceControl: LaunchdTriangleClientServiceControl(),
                stateCleaner: FileTriangleClientMutableStateCleaner(),
                lifecycleLock: FileTriangleClientLifecycleLock()
            )
            FileHandle.standardOutput.write(try await service.execute(command))
        } catch is TriangleClientCommandParseError {
            fail(code: 64, message: "invalid Triangle Client command")
        } catch ClientInstanceStoreError.duplicateProfile {
            fail(code: 65, message: "agent profile already exists")
        } catch ClientInstanceStoreError.notFound {
            fail(code: 66, message: "agent profile not found")
        } catch is VerifiedCredentialGateError {
            fail(code: 69, message: "agent credential is not verified")
        } catch is WorkerLauncherError {
            fail(code: 69, message: "agent runtime is unavailable")
        } catch TriangleClientLifecycleError.rollbackFailed {
            fail(code: 75, message: "Triangle Client rollback failed")
        } catch TriangleClientLifecycleError.cleanupFailed {
            fail(code: 74, message: "Triangle Client mutable-state cleanup failed")
        } catch TriangleClientLifecycleError.reloadFailed {
            fail(code: 75, message: "Triangle Client reload failed")
        } catch {
            fail(code: 70, message: "Triangle Client operation failed")
        }
    }

    private static func fail(code: Int32, message: String) -> Never {
        FileHandle.standardError.write(Data("\(message)\n".utf8)); exit(code)
    }
}
