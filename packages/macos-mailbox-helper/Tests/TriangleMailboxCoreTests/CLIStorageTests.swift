import Testing
import TriangleMailboxTestSupport

@Suite("Standalone CLI storage")
struct CLIStorageTests {
    @Test func resolution() throws { try CLIStorageContractCases.resolution() }
    @Test func isolation() throws { try CLIStorageContractCases.isolation() }
    @Test func privateFiles() throws { try CLIStorageContractCases.privateFiles() }
    @Test func accessErrors() async throws { try await CLIStorageContractCases.accessErrors() }
}
