import Testing
import TriangleMailboxTestSupport

@Suite("Cross-session mailbox credential custody")
struct EndToEndTests {
    @Test("enrollment survives restart without exposing either credential")
    func crossSessionLifecycle() async throws {
        try await EndToEndContractCases.crossSessionMailboxLifecycle()
    }
}
