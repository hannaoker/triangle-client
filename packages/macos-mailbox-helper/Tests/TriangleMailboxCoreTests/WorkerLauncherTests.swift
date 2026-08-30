import Testing
import TriangleMailboxTestSupport

@Suite("Keychain-backed worker launcher")
struct WorkerLauncherTests {
    @Test("closed worker kinds receive exact credential environment")
    func exactEnvironment() async throws { try await WorkerLauncherContractCases.exactEnvironment() }

    @Test("ambient credentials and selectors are replaced")
    func inheritedSecrets() async throws { try await WorkerLauncherContractCases.inheritedSecretsAreReplaced() }

    @Test("credential never enters worker arguments")
    func noArgumentSecret() async throws { try await WorkerLauncherContractCases.noSecretInArguments() }

    @Test("ineligible credential gate never executes")
    func gateFailure() async throws { try await WorkerLauncherContractCases.gateFailureNeverExecutes() }

    @Test("filesystem resolver rejects unsafe manifests and artifacts")
    func resolverSafety() throws { try WorkerLauncherContractCases.resolverSafety() }
}
