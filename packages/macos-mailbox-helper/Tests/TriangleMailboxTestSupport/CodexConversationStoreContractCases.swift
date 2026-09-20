import Foundation
@_spi(CodexRuntimeTesting) import TriangleMailboxCore

public enum CodexConversationStoreContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () async throws -> Void
    }

    public static let all: [ContractCase] = [
        .init(name: "feature flag inactive by default", run: featureFlagInactiveByDefault),
        .init(name: "inactive store refuses writes", run: inactiveStoreRefusesWrites),
        .init(name: "enabled store writes profile with hardened modes", run: enabledStoreHardenedModes),
        .init(name: "enabled store rejects secret material", run: enabledStoreRejectsSecrets),
    ]

    private static let profile = try! ProfileName("codex-runtime-phase0")
    private static let roomID = "room_" + String(repeating: "c", count: 32)

    public static func featureFlagInactiveByDefault() async throws {
        try expect(
            CodexRuntimeFeatureFlags.conversationStoreEnabled == false,
            "conversation store feature flag must stay inactive in Phase 0"
        )
        try expect(
            CodexRuntimeFeatureFlags.headlessRuntimeEnabled == false,
            "headless runtime feature flag must stay inactive in Phase 0"
        )
        try expect(
            CodexRuntimeFeatureFlags.desktopHandoffEnabled == false,
            "desktop handoff feature flag must stay inactive in Phase 0"
        )
    }

    public static func inactiveStoreRefusesWrites() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codex-runtime-inactive-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = FileCodexConversationStore(testRoot: root, featureEnabled: false)
        let instanceID = ClientInstanceID.derive(profile: profile)
        let record = CodexProfileOwnerRecord(
            profileInstanceID: instanceID,
            runtimeMode: .headless,
            ownerInstanceID: "owner-test",
            ownerGeneration: 1,
            ownershipState: .owned,
            leaseRenewedAt: "2026-09-20T00:00:00Z",
            leaseExpiresAt: "2026-09-20T01:00:00Z",
            activeMeshRoomID: nil,
            updatedAt: "2026-09-20T00:00:00Z"
        )
        do {
            try store.writeProfile(record)
            throw ContractExpectationError("inactive store accepted write")
        } catch CodexConversationStoreError.featureInactive {
            // expected
        }
    }

    public static func enabledStoreHardenedModes() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codex-runtime-enabled-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: root) }

        let store = FileCodexConversationStore(testRoot: root, featureEnabled: true)
        let instanceID = ClientInstanceID.derive(profile: profile)
        let profileRecord = CodexProfileOwnerRecord(
            profileInstanceID: instanceID,
            runtimeMode: .headless,
            ownerInstanceID: "owner-test",
            ownerGeneration: 1,
            ownershipState: .owned,
            leaseRenewedAt: "2026-09-20T00:00:00Z",
            leaseExpiresAt: "2026-09-20T01:00:00Z",
            activeMeshRoomID: nil,
            updatedAt: "2026-09-20T00:00:00Z"
        )
        try store.writeProfile(profileRecord)
        let loaded = try store.readProfile(instanceID: instanceID)
        try expect(loaded == profileRecord, "profile round-trip failed")

        let conversation = CodexConversationRecord(
            profileInstanceID: instanceID,
            meshRoomID: roomID,
            codexThreadID: "01a06f9f-2db1-7143-b8b9-08c634cc7999",
            activeDeliveryID: nil,
            executionEpoch: 1,
            executionState: .idle,
            lastWorkerSlotID: "slot-1",
            lastCompletedDeliveryID: nil,
            lastReplyEventID: nil,
            updatedAt: "2026-09-20T00:00:00Z"
        )
        try store.writeConversation(conversation)
        let loadedConversation = try store.readConversation(instanceID: instanceID, roomID: roomID)
        try expect(loadedConversation == conversation, "conversation round-trip failed")

        let profilePath = root.appendingPathComponent("profile.json")
        try expect(try mode(profilePath) == 0o600, "profile.json mode is not 0600")
        try expect(try mode(root) == 0o700, "codex-runtime directory mode is not 0700")

        let data = try Data(contentsOf: profilePath)
        let text = String(data: data, encoding: .utf8) ?? ""
        try expect(!text.contains("mesh_"), "store must not persist mesh credentials")
        try expect(!text.contains("please reply"), "store must not persist message text")
    }

    public static func enabledStoreRejectsSecrets() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codex-runtime-secret-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        defer { try? FileManager.default.removeItem(at: root) }

        let store = FileCodexConversationStore(testRoot: root, featureEnabled: true)
        let instanceID = ClientInstanceID.derive(profile: profile)
        let poisoned = CodexProfileOwnerRecord(
            profileInstanceID: instanceID,
            runtimeMode: .headless,
            ownerInstanceID: "mesh_watch_ABCDEFGHijklmnop",
            ownerGeneration: 1,
            ownershipState: .owned,
            leaseRenewedAt: "2026-09-20T00:00:00Z",
            leaseExpiresAt: "2026-09-20T01:00:00Z",
            activeMeshRoomID: nil,
            updatedAt: "2026-09-20T00:00:00Z"
        )
        do {
            try store.writeProfile(poisoned)
            throw ContractExpectationError("store accepted secret-bearing owner id")
        } catch CodexConversationStoreError.invalidRecord {
            // expected
        }
    }

    private static func mode(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let number = attributes[.posixPermissions] as? NSNumber else {
            throw ContractExpectationError("missing posix permissions")
        }
        return number.intValue
    }

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw ContractExpectationError(message) }
    }
}

private struct ContractExpectationError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
