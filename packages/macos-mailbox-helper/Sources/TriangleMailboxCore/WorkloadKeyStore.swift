import CryptoKit
import Foundation
#if canImport(Security)
import Security
#endif

public enum WorkloadKeyStoreError: Error, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case itemNotFound
    case interactionNotAllowed
    case duplicateItem
    case invalidStoredKey
    case keychainFailure

    public var description: String {
        switch self {
        case .itemNotFound: "workload key not found"
        case .interactionNotAllowed: "workload key access is unavailable"
        case .duplicateItem: "workload key already exists"
        case .invalidStoredKey: "stored workload key is invalid"
        case .keychainFailure: "workload key storage failed"
        }
    }

    public var debugDescription: String { description }
}

public struct WorkloadKeyRecord: Equatable, Sendable {
    public let privateKey: Curve25519.Signing.PrivateKey
    public let workloadID: WorkloadID?

    public init(privateKey: Curve25519.Signing.PrivateKey, workloadID: WorkloadID? = nil) {
        self.privateKey = privateKey
        self.workloadID = workloadID
    }

    public static func == (lhs: WorkloadKeyRecord, rhs: WorkloadKeyRecord) -> Bool {
        lhs.privateKey.rawRepresentation == rhs.privateKey.rawRepresentation && lhs.workloadID == rhs.workloadID
    }
}

public protocol WorkloadKeyStore: AnyObject, Sendable {
    func create(_ key: Curve25519.Signing.PrivateKey, workloadID: WorkloadID?, for profile: ProfileName) throws
    func read(for profile: ProfileName) throws -> WorkloadKeyRecord
    func delete(for profile: ProfileName) throws
}

public extension WorkloadKeyStore {
    func create(_ key: Curve25519.Signing.PrivateKey, for profile: ProfileName) throws {
        try create(key, workloadID: nil, for: profile)
    }
}

private struct StoredWorkloadKeyPayload: Codable {
    let version: Int
    let privateKeyBase64: String
    let workloadID: String?
}

public final class InMemoryWorkloadKeyStore: WorkloadKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [ProfileName: WorkloadKeyRecord] = [:]

    public init() {}

    public func create(_ key: Curve25519.Signing.PrivateKey, workloadID: WorkloadID?, for profile: ProfileName) throws {
        lock.lock()
        defer { lock.unlock() }
        guard records[profile] == nil else { throw WorkloadKeyStoreError.duplicateItem }
        records[profile] = WorkloadKeyRecord(privateKey: key, workloadID: workloadID)
    }

    public func read(for profile: ProfileName) throws -> WorkloadKeyRecord {
        lock.lock()
        defer { lock.unlock() }
        guard let record = records[profile] else { throw WorkloadKeyStoreError.itemNotFound }
        return record
    }

    public func delete(for profile: ProfileName) throws {
        lock.lock()
        defer { lock.unlock() }
        records.removeValue(forKey: profile)
    }
}

#if canImport(Security)
public final class KeychainWorkloadKeyStore: WorkloadKeyStore, @unchecked Sendable {
    public static let service = "dev.thetriangle.mesh.workload-key"

    public init() {}

    public func create(_ key: Curve25519.Signing.PrivateKey, workloadID: WorkloadID?, for profile: ProfileName) throws {
        let payload = StoredWorkloadKeyPayload(
            version: 1,
            privateKeyBase64: key.rawRepresentation.base64EncodedString(),
            workloadID: workloadID?.value
        )
        let data = try JSONEncoder().encode(payload)

        var query = baseQuery(for: profile)
        query[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        query[kSecValueData] = data
        var status = SecItemAdd(query as CFDictionary, nil)
#if TRIANGLE_LOCAL_AD_HOC
        if status == -34018 {
            query = KeychainLegacyAccess.legacyQuery(from: query)
            status = SecItemAdd(query as CFDictionary, nil)
        }
#endif
        guard status == errSecSuccess else {
            throw mapStatus(status)
        }
    }

    public func read(for profile: ProfileName) throws -> WorkloadKeyRecord {
        var query = baseQuery(for: profile)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound || status == -34018 {
            let fallbackStatus = SecItemCopyMatching(KeychainLegacyAccess.legacyQuery(from: query) as CFDictionary, &result)
            if fallbackStatus == errSecSuccess {
                status = errSecSuccess
            }
        }
        guard status == errSecSuccess else {
            throw mapStatus(status)
        }
        guard let data = result as? Data else {
            throw WorkloadKeyStoreError.invalidStoredKey
        }

        // Try decoding structured JSON payload first
        if let payload = try? JSONDecoder().decode(StoredWorkloadKeyPayload.self, from: data),
           let rawKey = Data(base64Encoded: payload.privateKeyBase64),
           let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: rawKey) {
            let workloadID = payload.workloadID != nil ? try? WorkloadID(payload.workloadID!) : nil
            return WorkloadKeyRecord(privateKey: privateKey, workloadID: workloadID)
        }

        // Fallback to legacy raw 32-byte representation
        if data.count == 32, let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: data) {
            return WorkloadKeyRecord(privateKey: privateKey, workloadID: nil)
        }

        // Fallback to legacy 64-char hex representation
        if data.count == 64,
           let hexString = String(data: data, encoding: .utf8),
           hexString.wholeMatch(of: /^[a-f0-9]{64}$/) != nil {
            var rawBytes = [UInt8]()
            rawBytes.reserveCapacity(32)
            var index = hexString.startIndex
            while index < hexString.endIndex {
                let nextIndex = hexString.index(index, offsetBy: 2)
                if let byte = UInt8(hexString[index..<nextIndex], radix: 16) {
                    rawBytes.append(byte)
                }
                index = nextIndex
            }
            if rawBytes.count == 32, let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: rawBytes) {
                return WorkloadKeyRecord(privateKey: privateKey, workloadID: nil)
            }
        }

        throw WorkloadKeyStoreError.invalidStoredKey
    }

    public func delete(for profile: ProfileName) throws {
        var query = baseQuery(for: profile)
        var status = SecItemDelete(query as CFDictionary)
        if status == errSecItemNotFound || status == -34018 {
            let fallbackStatus = SecItemDelete(KeychainLegacyAccess.legacyQuery(from: query) as CFDictionary)
            if fallbackStatus == errSecSuccess {
                status = errSecSuccess
            }
        }
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw mapStatus(status)
        }
    }

    private func baseQuery(for profile: ProfileName) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: Self.service,
            kSecAttrAccount: profile.value,
            kSecUseDataProtectionKeychain: true,
            kSecAttrSynchronizable: false,
        ]
    }

    private func mapStatus(_ status: OSStatus) -> WorkloadKeyStoreError {
        switch status {
        case errSecItemNotFound: .itemNotFound
        case errSecDuplicateItem: .duplicateItem
        case errSecInteractionNotAllowed, errSecAuthFailed: .interactionNotAllowed
        case errSecDecode, errSecDataTooLarge: .invalidStoredKey
        default: .keychainFailure
        }
    }
}
#endif
