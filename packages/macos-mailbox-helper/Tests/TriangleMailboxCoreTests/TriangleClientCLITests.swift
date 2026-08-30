import Testing
import TriangleMailboxTestSupport

@Suite("Triangle Client CLI")
struct TriangleClientCLITests {
    @Test("all Triangle Client CLI contracts")
    func contracts() async throws {
        for contractCase in TriangleClientCLIContractCases.all { try await contractCase.run() }
    }
}
