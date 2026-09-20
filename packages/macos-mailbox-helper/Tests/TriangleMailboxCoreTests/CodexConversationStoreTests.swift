import Testing
import TriangleMailboxTestSupport

@Suite("Codex conversation store (Phase 0 inactive flag)")
struct CodexConversationStoreTests {
    @Test("feature flag inactive by default")
    func featureFlagInactive() async throws {
        try await CodexConversationStoreContractCases.featureFlagInactiveByDefault()
    }

    @Test("inactive store refuses writes")
    func inactiveRefuses() async throws {
        try await CodexConversationStoreContractCases.inactiveStoreRefusesWrites()
    }

    @Test("enabled store writes profile with hardened modes")
    func enabledHardened() async throws {
        try await CodexConversationStoreContractCases.enabledStoreHardenedModes()
    }

    @Test("enabled store rejects secret material")
    func rejectsSecrets() async throws {
        try await CodexConversationStoreContractCases.enabledStoreRejectsSecrets()
    }
}
