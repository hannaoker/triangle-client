import Testing
import TriangleMailboxTestSupport

@Suite("Mailbox credential custody")
struct CredentialStoreTests {
    @Test("create refuses replacement")
    func createRefusesReplacement() throws {
        try CredentialStoreContractCases.createRefusesReplacement()
    }

    @Test("replacement requires explicit confirmation")
    func replacementRequiresConfirmation() throws {
        try CredentialStoreContractCases.replacementRequiresConfirmation()
    }

    @Test("reads return the exact binding")
    func exactRead() throws {
        try CredentialStoreContractCases.exactRead()
    }

    @Test("deletion is exact-profile only")
    func exactProfileDeletion() throws {
        try CredentialStoreContractCases.exactProfileDeletion()
    }

    @Test("errors never include credentials")
    func secretFreeErrors() throws {
        try CredentialStoreContractCases.secretFreeErrors()
    }

#if canImport(Security)
    @Test("bounded Security.framework status mapping")
    func securityStatusMapping() throws {
        try CredentialStoreContractCases.securityStatusMapping()
    }

    @Test("all operations use the local Data Protection Keychain policy")
    func keychainQueryPolicy() throws {
        try CredentialStoreContractCases.keychainQueryPolicy()
    }
#endif
}
