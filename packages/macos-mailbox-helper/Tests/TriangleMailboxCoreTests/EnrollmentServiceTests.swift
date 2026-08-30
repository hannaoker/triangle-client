import Testing
import TriangleMailboxTestSupport

@Suite("Fail-closed mailbox enrollment")
struct EnrollmentServiceTests {
    @Test("admission token uses only the admission header")
    func admissionHeaderAndMetadata() async throws { try await EnrollmentContractCases.admissionHeaderAndMetadata() }

    @Test("existing and concurrent profiles block duplicate registration")
    func enrollmentPreflightAndReservation() async throws { try await EnrollmentContractCases.enrollmentPreflightAndReservation() }

    @Test("credential is stored before identity verification")
    func storeBeforeVerify() async throws { try await EnrollmentContractCases.storeBeforeVerify() }

    @Test("successful output is sanitized")
    func sanitizedOutput() async throws { try await EnrollmentContractCases.sanitizedOutput() }

    @Test("identity mismatch fails closed")
    func identityMismatch() async throws { try await EnrollmentContractCases.identityMismatch() }

    @Test("persistence failure is registered-not-installed without retry")
    func registeredNotInstalled() async throws { try await EnrollmentContractCases.registeredNotInstalled() }

    @Test("ambiguous registration outcome is distinct and never retried")
    func ambiguousRegistration() async throws { try await EnrollmentContractCases.ambiguousRegistration() }

    @Test("registration HTTP outcomes distinguish ambiguity and rejection")
    func registrationHTTPOutcomes() async throws { try await EnrollmentContractCases.registrationHTTPOutcomes() }

    @Test("post-registration verification outage preserves installed state")
    func registeredInstalledOffline() async throws { try await EnrollmentContractCases.registeredInstalledOffline() }

    @Test("identity mismatch preserves installed state without retry")
    func installedIdentityMismatch() async throws { try await EnrollmentContractCases.installedIdentityMismatch() }

    @Test("authentication rejection preserves installed state without retry")
    func installedAuthenticationRejection() async throws { try await EnrollmentContractCases.installedAuthenticationRejection() }

    @Test("malformed, oversized, redirect, cross-origin, and plaintext responses fail")
    func invalidResponses() async throws { try await EnrollmentContractCases.invalidResponses() }

    @Test("status verifies a durable profile")
    func statusVerification() async throws { try await EnrollmentContractCases.statusVerification() }

    @Test("status is bounded when the network is unavailable")
    func offlineStatus() async throws { try await EnrollmentContractCases.offlineStatus() }

    @Test("status maps missing and locked local profiles")
    func localStatusStates() async throws { try await EnrollmentContractCases.localStatusStates() }

    @Test("the actual URLSession transport enforces the wire contract")
    func urlSessionTransportContract() async throws { try await EnrollmentContractCases.urlSessionTransportContract() }

    @Test("stored credentials require a fresh verified identity")
    func verifiedCredentialGate() async throws { try await EnrollmentContractCases.verifiedCredentialGate() }

    @Test("registration protocol and URLs are exact")
    func exactRegistrationContract() async throws { try await EnrollmentContractCases.exactRegistrationContract() }

    @Test("durable enrollment lifecycle survives process restart")
    func durableEnrollmentLifecycle() async throws { try await EnrollmentContractCases.durableEnrollmentLifecycle() }

    @Test("journal and Keychain state reconcile consistently")
    func journalKeychainReconciliation() async throws { try await EnrollmentContractCases.journalKeychainReconciliation() }

    @Test("diagnostics redact admission and permanent tokens")
    func diagnosticsRedactSecrets() async throws { try await EnrollmentContractCases.diagnosticsRedactSecrets() }
}
