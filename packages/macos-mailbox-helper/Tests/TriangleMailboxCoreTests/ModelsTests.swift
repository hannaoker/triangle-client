import Testing
import TriangleMailboxTestSupport

@Suite("Mailbox credential input models")
struct ModelsTests {
    @Test("profile names are bounded and path-safe")
    func profileNames() throws {
        try ModelContractCases.profileNames()
    }

    @Test("MESH origins are HTTPS and origin-only")
    func meshOrigins() throws {
        try ModelContractCases.meshOrigins()
    }

    @Test("loopback HTTP requires the explicit test allowance")
    func loopbackHTTP() throws {
        try ModelContractCases.loopbackHTTP()
    }

    @Test("agent IDs and permanent tokens use their canonical formats")
    func identifiers() throws {
        try ModelContractCases.identifiers()
    }

    @Test("mailbox handles match the public MESH policy")
    func mailboxHandles() throws {
        try ModelContractCases.mailboxHandles()
    }

    @Test("credential bindings decode only the exact version-one schema")
    func strictCredentialBinding() throws {
        try ModelContractCases.strictCredentialBinding()
    }

    @Test("credential diagnostics never reflect the permanent token")
    func credentialDiagnostics() throws {
        try ModelContractCases.credentialDiagnostics()
    }

    @Test("the public command surface is closed")
    func commandParser() throws {
        try ModelContractCases.commandParser()
    }
}
