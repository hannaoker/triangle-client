import Foundation
@_spi(CredentialStoreTesting) import TriangleMailboxCore

#if canImport(Security)
import Security
#endif

public enum CredentialStoreContractCases {
    public struct ContractCase: Sendable {
        public let name: String
        public let run: @Sendable () throws -> Void
    }

    public static var all: [ContractCase] {
        var cases: [ContractCase] = [
            .init(name: "credential create refuses replacement", run: createRefusesReplacement),
            .init(name: "credential replacement requires confirmation", run: replacementRequiresConfirmation),
            .init(name: "credential reads are exact", run: exactRead),
            .init(name: "credential deletion is exact-profile", run: exactProfileDeletion),
            .init(name: "credential errors redact secrets", run: secretFreeErrors),
        ]
#if canImport(Security)
        cases.append(.init(name: "credential Security status mapping", run: securityStatusMapping))
        cases.append(.init(name: "credential Data Protection Keychain policy", run: keychainQueryPolicy))
#endif
        return cases
    }

    public static func createRefusesReplacement() throws {
        let store = InMemoryCredentialStore()
        let profile = try ProfileName("codex-mailbox-live")
        try store.create(binding("a"), for: profile)

        try expectStoreError(.duplicateItem, "create replaced an existing binding") {
            try store.create(binding("b"), for: profile)
        }
        try expect(try store.read(for: profile) == binding("a"), "duplicate create changed the stored binding")
    }

    public static func replacementRequiresConfirmation() throws {
        let store = InMemoryCredentialStore()
        let profile = try ProfileName("codex-mailbox-live")
        try store.create(binding("a"), for: profile)

        try expectStoreError(.replacementNotConfirmed, "unconfirmed replacement succeeded") {
            try store.replace(binding("b"), for: profile, confirmation: .notConfirmed)
        }
        try expect(try store.read(for: profile) == binding("a"), "failed replacement changed the stored binding")

        try store.replace(binding("b"), for: profile, confirmation: .confirmed)
        try expect(try store.read(for: profile) == binding("b"), "confirmed replacement did not persist")
    }

    public static func exactRead() throws {
        let store = InMemoryCredentialStore()
        let codex = try ProfileName("codex-mailbox-live")
        let hermes = try ProfileName("hermes-mailbox-live")
        try store.create(binding("a"), for: codex)
        try store.create(binding("b"), for: hermes)

        try expect(try store.read(for: codex) == binding("a"), "read returned the wrong profile binding")
        try expect(try store.read(for: hermes) == binding("b"), "read changed the stored binding")
        try expectStoreError(.itemNotFound, "missing profile read succeeded") {
            try store.read(for: ProfileName("missing"))
        }
    }

    public static func exactProfileDeletion() throws {
        let store = InMemoryCredentialStore()
        let codex = try ProfileName("codex-mailbox-live")
        let hermes = try ProfileName("hermes-mailbox-live")
        try store.create(binding("a"), for: codex)
        try store.create(binding("b"), for: hermes)

        try store.delete(for: codex)
        try expectStoreError(.itemNotFound, "deleted profile remained readable") {
            try store.read(for: codex)
        }
        try expect(try store.read(for: hermes) == binding("b"), "deleting one profile affected another")
        try expectStoreError(.itemNotFound, "deleting a missing profile succeeded") {
            try store.delete(for: codex)
        }
    }

    public static func secretFreeErrors() throws {
        let canary = "mesh_" + String(repeating: "c", count: 64)
        let outputs = CredentialStoreError.allBoundedCases.map {
            String(describing: $0) + String(reflecting: $0)
        }
        for output in outputs {
            try expect(!output.contains(canary), "credential error exposed a secret")
        }
    }

#if canImport(Security)
    public static func securityStatusMapping() throws {
        try expect(KeychainCredentialStore.mapStatus(errSecItemNotFound) == .itemNotFound, "item-not-found status mapping changed")
        try expect(KeychainCredentialStore.mapStatus(errSecInteractionNotAllowed) == .interactionNotAllowed, "interaction status mapping changed")
        try expect(KeychainCredentialStore.mapStatus(errSecDuplicateItem) == .duplicateItem, "duplicate status mapping changed")
        try expect(KeychainCredentialStore.mapStatus(errSecAuthFailed) == .keychainFailure, "unexpected status was not bounded")
    }

    public static func keychainQueryPolicy() throws {
        let profile = try ProfileName("codex-mailbox-live")
        let encoded = Data("disposable-test-binding".utf8)
        let queries: [(String, [CFString: Any])] = [
            ("add", KeychainQueryBuilder.addQuery(for: profile, encodedBinding: encoded)),
            ("copy", KeychainQueryBuilder.copyQuery(for: profile)),
            ("update", KeychainQueryBuilder.updateQuery(for: profile)),
            ("delete", KeychainQueryBuilder.deleteQuery(for: profile)),
        ]

        for (operation, query) in queries {
            try expect(cfEqual(query[kSecClass], kSecClassGenericPassword), "\(operation) omitted generic-password class")
            try expect(query[kSecAttrService] as? String == "dev.thetriangle.mesh.mailbox", "\(operation) changed the fixed service")
            try expect(query[kSecAttrAccount] as? String == profile.value, "\(operation) changed the exact profile account")
            try expect(query[kSecUseDataProtectionKeychain] as? Bool == true, "\(operation) omitted Data Protection Keychain")
            try expect(query[kSecAttrSynchronizable] as? Bool == false, "\(operation) allowed synchronizable credentials")
            try expect(query[kSecAttrAccessGroup] == nil, "\(operation) accepted a caller-controlled access group")
        }

        let add = queries[0].1
        try expect(cfEqual(add[kSecAttrAccessible], kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly), "add changed the unattended local-only accessibility policy")
        try expect(add[kSecValueData] as? Data == encoded, "add changed the encoded binding")

        let copy = queries[1].1
        try expect(copy[kSecReturnData] as? Bool == true, "copy did not request credential data")
        try expect(cfEqual(copy[kSecMatchLimit], kSecMatchLimitOne), "copy did not limit results")
    }

    private static func cfEqual(_ actual: Any?, _ expected: CFTypeRef) -> Bool {
        guard let actual else { return false }
        return CFEqual(actual as CFTypeRef, expected)
    }
#endif

    private static func binding(_ digit: Character) throws -> CredentialBinding {
        try CredentialBinding(
            origin: MeshOrigin("https://thetriangle.dev"),
            agentID: AgentID("agent_" + String(repeating: digit, count: 32)),
            handle: MailboxHandle(digit == "a" ? "codex-mailbox-live" : "hermes-mailbox-live"),
            token: MeshToken("mesh_" + String(repeating: digit, count: 64))
        )
    }

    private static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw ContractFailure(message) }
    }

    private static func expectStoreError<Result>(
        _ expected: CredentialStoreError,
        _ message: String,
        operation: () throws -> Result
    ) throws {
        do {
            _ = try operation()
            throw ContractFailure(message)
        } catch let error as CredentialStoreError {
            guard error == expected else { throw ContractFailure("\(message): wrong store error") }
        } catch {
            throw ContractFailure("\(message): wrong error type")
        }
    }
}
