import CryptoKit
import Foundation
#if canImport(Darwin)
import Darwin
#endif
#if canImport(Security)
import Security
#endif

/// Portable file custody for watch grants: 0600 files under Application Support.
/// Agent workload keys live in `triangle` custody (see V1AgentCustody.swift).
/// Public ad-hoc release builds (`TRIANGLE_FILE_CUSTODY_REQUIRED`) always use it.
/// Local ad-hoc builds opt in with `TRIANGLE_FILE_CREDENTIALS=1` or an `ENABLED`
/// marker. Selection lives in `CredentialCustodyPolicy`.
public enum LocalCredentialStores {
    public static var rootURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle/credentials/local", isDirectory: true)
    }

    public static var enabledMarkerURL: URL {
        rootURL.appendingPathComponent("ENABLED")
    }

    public static var fileCredentialsEnabled: Bool {
        CredentialCustodyPolicy.current(fileOptIn: fileOptInRequested) == .file
    }

    static var fileOptInRequested: Bool {
        if let raw = getenv("TRIANGLE_FILE_CREDENTIALS"), String(cString: raw) == "1" {
            return true
        }
        return FileManager.default.isReadableFile(atPath: enabledMarkerURL.path)
    }

    /// Permissions v1: helper profiles point at `triangle` custody key files.
    public static func bindings() -> any V1ProfileBindingStore { FileV1ProfileBindingStore() }

    public static func agents() -> any V1AgentResolver { FileV1AgentResolver(bindings: bindings()) }

    /// Read-only workload keys, resolved through the profile binding (never stored here).
    public static func workload() -> any WorkloadKeyStore { V1WorkloadKeyStore(resolver: agents()) }

    public static func watchGrant() -> any WatchGrantStore {
        #if canImport(Security)
        if fileCredentialsEnabled { return FileWatchGrantStore(root: rootURL) }
        return KeychainWatchGrantStore()
        #else
        return InMemoryWatchGrantStore()
        #endif
    }
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

extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
