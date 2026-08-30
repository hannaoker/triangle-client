import Testing
import TriangleMailboxTestSupport

@Suite("Triangle Client signed supervisor bridge")
struct ClientSupervisorTests {
    @Test("exact verified credentials are paired after all paths resolve")
    func exactPairing() async throws { try await ClientSupervisorContractCases.exactPairing() }

    @Test("runtime resolution precedes Keychain access")
    func resolveBeforeCredential() async throws { try await ClientSupervisorContractCases.resolveBeforeCredential() }

    @Test("coordinator failure precedes Keychain access")
    func coordinatorFailure() async throws { try await ClientSupervisorContractCases.coordinatorFailureBeforeCredential() }

    @Test("one bad profile is isolated")
    func badProfileIsolation() async throws { try await ClientSupervisorContractCases.badProfileIsolation() }

    @Test("no eligible profiles fails closed")
    func noEligibleProfile() async throws { try await ClientSupervisorContractCases.noEligibleProfile() }

    @Test("bootstrap is bounded and stdin-only")
    func boundedBootstrap() async throws { try await ClientSupervisorContractCases.boundedAnonymousBootstrap() }

    @Test("coordinator launch is clean")
    func cleanLaunch() async throws { try await ClientSupervisorContractCases.cleanCoordinatorLaunch() }

    @Test("diagnostics redact credentials")
    func redactedDiagnostics() async throws { try await ClientSupervisorContractCases.redactedDiagnostics() }

    @Test("host waits for clean shutdown")
    func shutdownLifecycle() async throws { try await ClientSupervisorContractCases.shutdownLifecycle() }

    @Test("early child exit is contained")
    func earlyExit() async throws { try await ClientSupervisorContractCases.subprocessEarlyExitIsContained() }

    @Test("stdin backpressure is bounded and reaped")
    func backpressure() async throws { try await ClientSupervisorContractCases.subprocessBackpressureTimesOutAndReaps() }

    @Test("TERM-ignoring child is killed")
    func ignoredTermination() async throws { try await ClientSupervisorContractCases.subprocessIgnoredTerminationIsKilled() }

    @Test("signal state is preserved and runs serialize")
    func signals() async throws { try await ClientSupervisorContractCases.signalPreservationAndSerialization() }
}
