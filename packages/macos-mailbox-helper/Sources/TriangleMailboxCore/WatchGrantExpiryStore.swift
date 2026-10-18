import Foundation

/// Secret-free sidecar that remembers when MESH will expire the current watch grant.
///
/// MESH fixes a grant's `expires_at` at create time (finalize does not extend it),
/// and the finalized credential response does not repeat it. The helper keeps the
/// staged `expires_at` here, keyed by grant id, so `watch-ensure` / `watch-status`
/// can report it and the supervisor can renew before expiry.
///
/// This is deliberately *not* a field on `WatchGrantBinding`: that decoder accepts
/// an exact key set, so adding a key would make an older helper treat the current
/// credential as corrupt after a rollback. Older helpers simply ignore this file;
/// bindings without a matching sidecar report no expiry and callers fall back to
/// reactive (rejection-driven) renewal.
public struct WatchGrantExpiryRecord: Codable, Equatable, Sendable {
    public let version: Int
    public let installationID: String
    public let grantID: String
    public let expiresAt: String

    public init(installationID: InstallationID, grantID: WatchGrantID, expiresAt: String) {
        version = 1
        self.installationID = installationID.value
        self.grantID = grantID.value
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey {
        case version
        case installationID = "installationId"
        case grantID = "grantId"
        case expiresAt
    }

    /// Accepts the ISO 8601 UTC forms MESH emits (`2026-10-17T19:39:24.123Z`, with or without fractions).
    public static func isValidTimestamp(_ value: String) -> Bool {
        guard value.count <= 40, value.hasSuffix("Z") else { return false }
        return parse(value) != nil
    }

    public static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let whole = ISO8601DateFormatter()
        whole.formatOptions = [.withInternetDateTime]
        return whole.date(from: value)
    }
}

public protocol WatchGrantExpiryStore: AnyObject, Sendable {
    func write(_ record: WatchGrantExpiryRecord) throws
    func read(for installationID: InstallationID) -> WatchGrantExpiryRecord?
    func delete(for installationID: InstallationID)
}

public final class InMemoryWatchGrantExpiryStore: WatchGrantExpiryStore, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [String: WatchGrantExpiryRecord] = [:]

    public init() {}

    public func write(_ record: WatchGrantExpiryRecord) throws {
        lock.withLock { records[record.installationID] = record }
    }

    public func read(for installationID: InstallationID) -> WatchGrantExpiryRecord? {
        lock.withLock { records[installationID.value] }
    }

    public func delete(for installationID: InstallationID) {
        _ = lock.withLock { records.removeValue(forKey: installationID.value) }
    }
}

/// `~/Library/Application Support/The Triangle/client/watch-grant-expiry/<installation>.json` (0600).
public final class FileWatchGrantExpiryStore: WatchGrantExpiryStore, @unchecked Sendable {
    private let root: URL
    private let lock = NSLock()

    public static var defaultRootURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle/client/watch-grant-expiry", isDirectory: true)
    }

    public init(root: URL = FileWatchGrantExpiryStore.defaultRootURL) {
        self.root = root
    }

    public func write(_ record: WatchGrantExpiryRecord) throws {
        try lock.withLock {
            try FileManager.default.createDirectory(
                at: root,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            let url = root.appendingPathComponent("\(record.installationID).json")
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(record).write(to: url, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }

    public func read(for installationID: InstallationID) -> WatchGrantExpiryRecord? {
        lock.withLock {
            let url = root.appendingPathComponent("\(installationID.value).json")
            guard let data = try? Data(contentsOf: url), data.count <= 4_096,
                  let record = try? JSONDecoder().decode(WatchGrantExpiryRecord.self, from: data),
                  record.version == 1,
                  record.installationID == installationID.value,
                  WatchGrantExpiryRecord.isValidTimestamp(record.expiresAt)
            else { return nil }
            return record
        }
    }

    public func delete(for installationID: InstallationID) {
        lock.withLock {
            let url = root.appendingPathComponent("\(installationID.value).json")
            try? FileManager.default.removeItem(at: url)
        }
    }
}
