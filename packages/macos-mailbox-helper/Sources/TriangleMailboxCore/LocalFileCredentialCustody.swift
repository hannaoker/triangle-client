import CryptoKit
import Foundation
#if canImport(Darwin)
import Darwin
#endif
#if canImport(Security)
import Security
#endif

/// Local Mini / ad-hoc helper custody: 0600 files under Application Support.
/// Opt in with `TRIANGLE_FILE_CREDENTIALS=1` or an `ENABLED` marker written by
/// the export script. Production Developer ID builds keep Keychain-only custody.
public enum LocalCredentialStores {
    public static var rootURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle/credentials/local", isDirectory: true)
    }

    public static var enabledMarkerURL: URL {
        rootURL.appendingPathComponent("ENABLED")
    }

    public static var fileCredentialsEnabled: Bool {
        #if TRIANGLE_LOCAL_AD_HOC
        if let raw = getenv("TRIANGLE_FILE_CREDENTIALS"), String(cString: raw) == "1" {
            return true
        }
        return FileManager.default.isReadableFile(atPath: enabledMarkerURL.path)
        #else
        return false
        #endif
    }

    public static func mailbox() -> any CredentialStore {
        #if canImport(Security)
        if fileCredentialsEnabled { return FileCredentialStore(root: rootURL) }
        return KeychainCredentialStore()
        #else
        return InMemoryCredentialStore()
        #endif
    }

    public static func workload() -> any WorkloadKeyStore {
        #if canImport(Security)
        if fileCredentialsEnabled { return FileWorkloadKeyStore(root: rootURL) }
        return KeychainWorkloadKeyStore()
        #else
        return InMemoryWorkloadKeyStore()
        #endif
    }

    public static func watchGrant() -> any WatchGrantStore {
        #if canImport(Security)
        if fileCredentialsEnabled { return FileWatchGrantStore(root: rootURL) }
        return KeychainWatchGrantStore()
        #else
        return InMemoryWatchGrantStore()
        #endif
    }
}

public final class FileCredentialStore: CredentialStore, @unchecked Sendable {
    private let root: URL
    private let lock = NSLock()

    public init(root: URL = LocalCredentialStores.rootURL) {
        self.root = root.appendingPathComponent("mailbox", isDirectory: true)
    }

    public func create(_ binding: CredentialBinding, for profile: ProfileName) throws {
        try lock.withLock {
            let url = try prepareURL(for: profile)
            guard !FileManager.default.fileExists(atPath: url.path) else {
                throw CredentialStoreError.duplicateItem
            }
            try write(binding, to: url)
        }
    }

    public func read(for profile: ProfileName) throws -> CredentialBinding {
        try lock.withLock {
            let url = try prepareURL(for: profile)
            guard let data = try? Data(contentsOf: url) else {
                throw CredentialStoreError.itemNotFound
            }
            do {
                return try JSONDecoder().decode(CredentialBinding.self, from: data)
            } catch {
                throw CredentialStoreError.invalidStoredCredential
            }
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
        try lock.withLock {
            let url = try prepareURL(for: profile)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw CredentialStoreError.itemNotFound
            }
            try write(binding, to: url)
        }
    }

    public func delete(for profile: ProfileName) throws {
        try lock.withLock {
            let url = try prepareURL(for: profile)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw CredentialStoreError.itemNotFound
            }
            try FileManager.default.removeItem(at: url)
        }
    }

    private func prepareURL(for profile: ProfileName) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return root.appendingPathComponent("\(profile.value).json")
    }

    private func write(_ binding: CredentialBinding, to url: URL) throws {
        let data = try JSONEncoder().encode(binding)
        try data.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

public final class FileWorkloadKeyStore: WorkloadKeyStore, @unchecked Sendable {
    private let root: URL
    private let lock = NSLock()

    public init(root: URL = LocalCredentialStores.rootURL) {
        self.root = root.appendingPathComponent("workload", isDirectory: true)
    }

    public func create(_ key: Curve25519.Signing.PrivateKey, workloadID: WorkloadID?, for profile: ProfileName) throws {
        try lock.withLock {
            let url = try prepareURL(for: profile)
            guard !FileManager.default.fileExists(atPath: url.path) else {
                throw WorkloadKeyStoreError.duplicateItem
            }
            let payload = StoredWorkloadKeyFilePayload(
                version: 1,
                privateKeyBase64: key.rawRepresentation.base64EncodedString(),
                workloadID: workloadID?.value
            )
            try write(payload, to: url)
        }
    }

    public func read(for profile: ProfileName) throws -> WorkloadKeyRecord {
        try lock.withLock {
            let url = try prepareURL(for: profile)
            guard let data = try? Data(contentsOf: url) else {
                throw WorkloadKeyStoreError.itemNotFound
            }
            if let payload = try? JSONDecoder().decode(StoredWorkloadKeyFilePayload.self, from: data),
               let raw = Data(base64Encoded: payload.privateKeyBase64),
               let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw)
            {
                let workloadID = payload.workloadID.flatMap { try? WorkloadID($0) }
                return WorkloadKeyRecord(privateKey: privateKey, workloadID: workloadID)
            }
            // Legacy raw / hex exports from `security -w`.
            if data.count == 32, let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: data) {
                return WorkloadKeyRecord(privateKey: privateKey, workloadID: nil)
            }
            if let hexString = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               hexString.count == 64,
               hexString.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "0123456789abcdef").contains($0) })
            {
                var rawBytes = [UInt8]()
                rawBytes.reserveCapacity(32)
                var index = hexString.startIndex
                while index < hexString.endIndex {
                    let next = hexString.index(index, offsetBy: 2)
                    if let byte = UInt8(hexString[index..<next], radix: 16) {
                        rawBytes.append(byte)
                    }
                    index = next
                }
                if rawBytes.count == 32,
                   let privateKey = try? Curve25519.Signing.PrivateKey(rawRepresentation: Data(rawBytes))
                {
                    return WorkloadKeyRecord(privateKey: privateKey, workloadID: nil)
                }
            }
            throw WorkloadKeyStoreError.invalidStoredKey
        }
    }

    public func delete(for profile: ProfileName) throws {
        try lock.withLock {
            let url = try prepareURL(for: profile)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw WorkloadKeyStoreError.itemNotFound
            }
            try FileManager.default.removeItem(at: url)
        }
    }

    private func prepareURL(for profile: ProfileName) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return root.appendingPathComponent("\(profile.value).json")
    }

    private func write(_ payload: StoredWorkloadKeyFilePayload, to url: URL) throws {
        let data = try JSONEncoder().encode(payload)
        try data.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

private struct StoredWorkloadKeyFilePayload: Codable, Sendable {
    let version: Int
    let privateKeyBase64: String
    let workloadID: String?
}

public final class FileWatchGrantStore: WatchGrantStore, @unchecked Sendable {
    private let root: URL
    private let lock = NSLock()

    public init(root: URL = LocalCredentialStores.rootURL) {
        self.root = root.appendingPathComponent("watch", isDirectory: true)
    }

    public func create(_ binding: WatchGrantBinding) throws {
        try lock.withLock {
            let url = try prepareURL(for: binding.installationID)
            guard !FileManager.default.fileExists(atPath: url.path) else {
                throw WatchGrantStoreError.duplicateItem
            }
            try write(binding, to: url)
        }
    }

    public func read(for installationID: InstallationID) throws -> WatchGrantBinding {
        try lock.withLock {
            let url = try prepareURL(for: installationID)
            guard let data = try? Data(contentsOf: url) else {
                throw WatchGrantStoreError.itemNotFound
            }
            do {
                return try JSONDecoder().decode(WatchGrantBinding.self, from: data)
            } catch {
                throw WatchGrantStoreError.invalidStoredCredential
            }
        }
    }

    public func replace(_ binding: WatchGrantBinding, confirmation: CredentialReplacementConfirmation) throws {
        guard confirmation == .confirmed else {
            throw WatchGrantStoreError.replacementNotConfirmed
        }
        try lock.withLock {
            let url = try prepareURL(for: binding.installationID)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw WatchGrantStoreError.itemNotFound
            }
            try write(binding, to: url)
        }
    }

    public func delete(for installationID: InstallationID) throws {
        try lock.withLock {
            let url = try prepareURL(for: installationID)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw WatchGrantStoreError.itemNotFound
            }
            try FileManager.default.removeItem(at: url)
        }
    }

    private func prepareURL(for installationID: InstallationID) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return root.appendingPathComponent("\(installationID.value).json")
    }

    private func write(_ binding: WatchGrantBinding, to url: URL) throws {
        let data = try JSONEncoder().encode(binding)
        try data.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
