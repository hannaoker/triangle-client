import Testing
import TriangleMailboxTestSupport

@Suite("Keychain-backed worker launcher")
struct WorkerLauncherTests {
    @Test("standalone supervisor supports Cursor-only and rejects corruption")
    func standaloneSupervisor() throws { try WorkerLauncherContractCases.standaloneSupervisorResolvesCursorAndRejectsCorruption() }

    @Test("closed worker kinds receive exact credential environment")
    func exactEnvironment() async throws { try await WorkerLauncherContractCases.exactEnvironment() }

    @Test("ambient credentials and selectors are replaced")
    func inheritedSecrets() async throws { try await WorkerLauncherContractCases.inheritedSecretsAreReplaced() }
    func identityRootIsolated() async throws { try await WorkerLauncherContractCases.identityRootIsIsolated() }

    @Test("credential never enters worker arguments")
    func noArgumentSecret() async throws { try await WorkerLauncherContractCases.noSecretInArguments() }

    @Test("ineligible credential gate never executes")
    func gateFailure() async throws { try await WorkerLauncherContractCases.gateFailureNeverExecutes() }

    @Test("filesystem resolver rejects unsafe manifests and artifacts")
    func resolverSafety() throws { try WorkerLauncherContractCases.resolverSafety() }

    @Test("cursor-acp readiness resolves the verified headless drain")
    func cursorAcpReadiness() throws { try WorkerLauncherContractCases.cursorAcpReadinessResolvesDrain() }

    @Test("cursor-acp readiness rejects bundles without the drain runtime")
    func cursorAcpReadinessRejects() throws { try WorkerLauncherContractCases.cursorAcpReadinessRejectsBundlesWithoutDrain() }

    @Test("cursor-acp never falls through to the antigravity worker check")
    func cursorAcpNotAntigravity() throws { try WorkerLauncherContractCases.cursorAcpDoesNotUseAntigravityWorker() }

    @Test("coordinator has no manifest version ceiling")
    func noManifestCeiling() throws { try WorkerLauncherContractCases.coordinatorHasNoManifestCeiling() }
}
