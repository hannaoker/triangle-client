#if canImport(Security)
import Foundation
import Security

/// Builds the complete selectors used by the credential store.
///
/// The queries intentionally omit `kSecAttrAccessGroup`. The signed helper owns
/// credentials through its default Data Protection Keychain application access
/// group; callers cannot select or broaden that group.
@_spi(CredentialStoreTesting)
public enum KeychainQueryBuilder {
    public static func addQuery(
        for profile: ProfileName,
        encodedBinding: Data
    ) -> [CFString: Any] {
        var query = baseQuery(for: profile)
        query[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        query[kSecValueData] = encodedBinding
        return query
    }

    public static func copyQuery(for profile: ProfileName) -> [CFString: Any] {
        var query = baseQuery(for: profile)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        return query
    }

    public static func updateQuery(for profile: ProfileName) -> [CFString: Any] {
        baseQuery(for: profile)
    }

    public static func deleteQuery(for profile: ProfileName) -> [CFString: Any] {
        baseQuery(for: profile)
    }

    private static func baseQuery(for profile: ProfileName) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: KeychainCredentialStore.service,
            kSecAttrAccount: profile.value,
            kSecUseDataProtectionKeychain: true,
            kSecAttrSynchronizable: false,
        ]
    }
}

public final class KeychainCredentialStore: CredentialStore, @unchecked Sendable {
    static let service = "dev.thetriangle.mesh.mailbox"

    public init() {}

    public func create(_ binding: CredentialBinding, for profile: ProfileName) throws {
        let encoded = try encode(binding)
        var query = KeychainQueryBuilder.addQuery(for: profile, encodedBinding: encoded)
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

    public func read(for profile: ProfileName) throws -> CredentialBinding {
        var result: CFTypeRef?
        let query = KeychainQueryBuilder.copyQuery(for: profile)

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
            throw CredentialStoreError.invalidStoredCredential
        }
        do {
            return try JSONDecoder().decode(CredentialBinding.self, from: encoded)
        } catch {
            throw CredentialStoreError.invalidStoredCredential
        }
    }

    public func replace(
        _ binding: CredentialBinding,
        for profile: ProfileName,
        confirmation: CredentialReplacementConfirmation
    ) throws {
        guard confirmation == .confirmed else {
            throw CredentialStoreError.replacementNotConfirmed
        }
        let attributes: [CFString: Any] = [kSecValueData: try encode(binding)]
        var query = KeychainQueryBuilder.updateQuery(for: profile)
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

    public func delete(for profile: ProfileName) throws {
        var query = KeychainQueryBuilder.deleteQuery(for: profile)
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

    @_spi(CredentialStoreTesting)
    public static func mapStatus(_ status: OSStatus) -> CredentialStoreError {
        switch status {
        case errSecItemNotFound:
            .itemNotFound
        case errSecInteractionNotAllowed:
            .interactionNotAllowed
        case errSecDuplicateItem:
            .duplicateItem
        default:
            .keychainFailure
        }
    }

    private func encode(_ binding: CredentialBinding) throws -> Data {
        do {
            return try JSONEncoder().encode(binding)
        } catch {
            throw CredentialStoreError.keychainFailure
        }
    }
}
#endif
