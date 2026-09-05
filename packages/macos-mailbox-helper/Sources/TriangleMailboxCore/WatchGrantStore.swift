import Foundation

public enum WatchGrantStoreError: Error, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible
{
    case itemNotFound
    case interactionNotAllowed
    case duplicateItem
    case replacementNotConfirmed
    case invalidStoredCredential
    case keychainFailure

    public static let allBoundedCases: [WatchGrantStoreError] = [
        .itemNotFound,
        .interactionNotAllowed,
        .duplicateItem,
        .replacementNotConfirmed,
        .invalidStoredCredential,
        .keychainFailure,
    ]

    public var description: String {
        switch self {
        case .itemNotFound: "watch grant not found"
        case .interactionNotAllowed: "watch grant access is unavailable"
        case .duplicateItem: "watch grant already exists"
        case .replacementNotConfirmed: "watch grant replacement was not confirmed"
        case .invalidStoredCredential: "stored watch grant is invalid"
        case .keychainFailure: "watch grant storage failed"
        }
    }

    public var debugDescription: String { description }
}

public protocol WatchGrantStore: AnyObject, Sendable {
    func create(_ binding: WatchGrantBinding) throws
    func read(for installationID: InstallationID) throws -> WatchGrantBinding
    func replace(_ binding: WatchGrantBinding, confirmation: CredentialReplacementConfirmation) throws
    func delete(for installationID: InstallationID) throws
}

public final class InMemoryWatchGrantStore: WatchGrantStore, @unchecked Sendable {
    private let lock = NSLock()
    private var bindings: [InstallationID: WatchGrantBinding] = [:]

    public init() {}

    public func create(_ binding: WatchGrantBinding) throws {
        lock.lock()
        defer { lock.unlock() }
        guard bindings[binding.installationID] == nil else {
            throw WatchGrantStoreError.duplicateItem
        }
        bindings[binding.installationID] = binding
    }

    public func read(for installationID: InstallationID) throws -> WatchGrantBinding {
        lock.lock()
        defer { lock.unlock() }
        guard let binding = bindings[installationID] else {
            throw WatchGrantStoreError.itemNotFound
        }
        return binding
    }

    public func replace(_ binding: WatchGrantBinding, confirmation: CredentialReplacementConfirmation) throws {
        guard confirmation == .confirmed else {
            throw WatchGrantStoreError.replacementNotConfirmed
        }
        lock.lock()
        defer { lock.unlock() }
        guard bindings[binding.installationID] != nil else {
            throw WatchGrantStoreError.itemNotFound
        }
        bindings[binding.installationID] = binding
    }

    public func delete(for installationID: InstallationID) throws {
        lock.lock()
        defer { lock.unlock() }
        guard bindings.removeValue(forKey: installationID) != nil else {
            throw WatchGrantStoreError.itemNotFound
        }
    }
}

#if canImport(Security)
import Security

@_spi(WatchGrantStoreTesting)
public enum WatchGrantKeychainQueryBuilder {
    public static func addQuery(for installationID: InstallationID, encodedBinding: Data) -> [CFString: Any] {
        var query = baseQuery(for: installationID)
        query[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        query[kSecValueData] = encodedBinding
        return query
    }

    public static func copyQuery(for installationID: InstallationID) -> [CFString: Any] {
        var query = baseQuery(for: installationID)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        return query
    }

    public static func updateQuery(for installationID: InstallationID) -> [CFString: Any] {
        baseQuery(for: installationID)
    }

    public static func deleteQuery(for installationID: InstallationID) -> [CFString: Any] {
        baseQuery(for: installationID)
    }

    private static func baseQuery(for installationID: InstallationID) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: KeychainWatchGrantStore.service,
            kSecAttrAccount: installationID.value,
            kSecUseDataProtectionKeychain: true,
            kSecAttrSynchronizable: false,
        ]
    }
}

public final class KeychainWatchGrantStore: WatchGrantStore, @unchecked Sendable {
    static let service = "dev.thetriangle.mesh.mailbox-watch"

    public init() {}

    public func create(_ binding: WatchGrantBinding) throws {
        let encoded = try encode(binding)
        var query = WatchGrantKeychainQueryBuilder.addQuery(for: binding.installationID, encodedBinding: encoded)
        var status = SecItemAdd(query as CFDictionary, nil)
#if TRIANGLE_LOCAL_AD_HOC
        if status == -34018 {
            query = KeychainLegacyAccess.legacyQuery(from: query)
            status = SecItemAdd(query as CFDictionary, nil)
        }
#endif
        guard status == errSecSuccess else {
            throw Self.mapStatus(status)
        }
    }

    public func read(for installationID: InstallationID) throws -> WatchGrantBinding {
        var result: CFTypeRef?
        let query = WatchGrantKeychainQueryBuilder.copyQuery(for: installationID)
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound || status == -34018 {
            let fallbackStatus = SecItemCopyMatching(KeychainLegacyAccess.legacyQuery(from: query) as CFDictionary, &result)
            if fallbackStatus == errSecSuccess {
                status = errSecSuccess
            }
        }
        guard status == errSecSuccess else {
            throw Self.mapStatus(status)
        }
        guard let encoded = result as? Data else {
            throw WatchGrantStoreError.invalidStoredCredential
        }
        do {
            return try JSONDecoder().decode(WatchGrantBinding.self, from: encoded)
        } catch {
            throw WatchGrantStoreError.invalidStoredCredential
        }
    }

    public func replace(_ binding: WatchGrantBinding, confirmation: CredentialReplacementConfirmation) throws {
        guard confirmation == .confirmed else {
            throw WatchGrantStoreError.replacementNotConfirmed
        }
        let attributes: [CFString: Any] = [kSecValueData: try encode(binding)]
        var query = WatchGrantKeychainQueryBuilder.updateQuery(for: binding.installationID)
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound || status == -34018 {
            let fallbackStatus = SecItemUpdate(KeychainLegacyAccess.legacyQuery(from: query) as CFDictionary, attributes as CFDictionary)
            if fallbackStatus == errSecSuccess {
                status = errSecSuccess
            }
        }
        guard status == errSecSuccess else {
            throw Self.mapStatus(status)
        }
    }

    public func delete(for installationID: InstallationID) throws {
        var query = WatchGrantKeychainQueryBuilder.deleteQuery(for: installationID)
        var status = SecItemDelete(query as CFDictionary)
        if status == errSecItemNotFound || status == -34018 {
            let fallbackStatus = SecItemDelete(KeychainLegacyAccess.legacyQuery(from: query) as CFDictionary)
            if fallbackStatus == errSecSuccess {
                status = errSecSuccess
            }
        }
        guard status == errSecSuccess else {
            throw Self.mapStatus(status)
        }
    }

    @_spi(WatchGrantStoreTesting)
    public static func mapStatus(_ status: OSStatus) -> WatchGrantStoreError {
        switch status {
        case errSecItemNotFound: .itemNotFound
        case errSecInteractionNotAllowed: .interactionNotAllowed
        case errSecDuplicateItem: .duplicateItem
        default: .keychainFailure
        }
    }

    private func encode(_ binding: WatchGrantBinding) throws -> Data {
        do {
            return try JSONEncoder().encode(binding)
        } catch {
            throw WatchGrantStoreError.keychainFailure
        }
    }
}
#endif
