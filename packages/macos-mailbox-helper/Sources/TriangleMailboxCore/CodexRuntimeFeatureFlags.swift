import Foundation

/// Phase 0 feature flags for the headless Codex runtime helper surface.
///
/// All flags remain inactive — no production profile behavior changes until
/// later phases flip them after Mini Darwin evidence gates.
public enum CodexRuntimeFeatureFlags: Sendable {
    /// Helper-owned `FileCodexConversationStore`. Inactive in Phase 0.
    public static let conversationStoreEnabled: Bool = false

    /// Headless App Server runtime admission. Inactive in Phase 0.
    public static let headlessRuntimeEnabled: Bool = false

    /// Desktop handoff. Inactive until shared-home concurrency probe passes.
    public static let desktopHandoffEnabled: Bool = false
}
