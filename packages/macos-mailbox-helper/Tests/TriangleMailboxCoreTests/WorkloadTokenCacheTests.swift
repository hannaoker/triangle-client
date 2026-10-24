import Testing
import TriangleMailboxTestSupport

@Suite("Workload token cache")
struct WorkloadTokenCacheTests {
    @Test("workload token cache contract cases", arguments: WorkloadTokenCacheContractCases.all.map(\.name))
    func contract(_ name: String) async throws {
        try await WorkloadTokenCacheContractCases.all.first { $0.name == name }!.run()
    }
}
