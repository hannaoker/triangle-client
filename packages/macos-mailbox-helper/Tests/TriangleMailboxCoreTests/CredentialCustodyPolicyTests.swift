import Testing
import TriangleMailboxTestSupport

@Suite("Credential custody policy")
struct CredentialCustodyPolicyTests {
    @Test("public ad-hoc release always selects file custody")
    func publicReleaseSelectsFileCustody() throws {
        try CredentialCustodyPolicyContractCases.publicReleaseSelectsFileCustody()
    }

    @Test("public ad-hoc release rejects Keychain custody clearly")
    func publicReleaseRejectsKeychain() throws {
        try CredentialCustodyPolicyContractCases.publicReleaseRejectsKeychain()
    }

    @Test("local ad-hoc keeps Keychain default and file opt-in")
    func localAdHocCompatibility() throws {
        try CredentialCustodyPolicyContractCases.localAdHocCompatibility()
    }

    @Test("non-ad-hoc build never selects file custody implicitly")
    func keychainOnlyBuild() throws {
        try CredentialCustodyPolicyContractCases.keychainOnlyBuild()
    }

    @Test("unknown custody values are rejected")
    func unknownCustodyRejected() throws {
        try CredentialCustodyPolicyContractCases.unknownCustodyRejected()
    }
}
