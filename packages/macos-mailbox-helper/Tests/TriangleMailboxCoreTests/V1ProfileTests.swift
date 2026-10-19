import Testing
import TriangleMailboxTestSupport

@Suite("Permissions v1 helper profiles")
struct V1ProfileTests {
    @Test("v1 contract cases", arguments: V1ProfileContractCases.all.map(\.name))
    func contract(_ name: String) async throws {
        try await V1ProfileContractCases.all.first { $0.name == name }!.run()
    }
}
