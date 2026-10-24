import CryptoKit
import Foundation
#if canImport(Darwin)
import Darwin
#endif

// Every helper run is a new process, so a token held only in memory is exchanged
// again by every `transaction-*` run and `mcp` session: two extra MESH calls
// (`token-challenges`, `tokens`) for a token that lives about five minutes. This
// file lets later processes reuse a still-fresh token. It is only a cache: any
// problem with it (missing, corrupt, unsafe, expired, for another key) is a miss
// and the caller exchanges a token exactly as it would without one.

/// What a cached token was exchanged for. A token is only ever reused for exactly
/// this origin, workload, DPoP key and scope set.
public struct WorkloadTokenCacheKey: Hashable, Sendable {
    public let origin: String
    public let workloadID: String
    /// RFC 7638 thumbprint of the DPoP key the token is bound to.
    public let keyThumbprint: String
    /// Sorted, so the same scopes always address the same entry.
    public let scopes: [String]

    public init(origin: MeshOrigin, workloadID: WorkloadID, keyThumbprint: String, scopes: [String]) {
        self.origin = origin.value
        self.workloadID = workloadID.value
        self.keyThumbprint = keyThumbprint
        self.scopes = scopes.sorted()
    }

    /// File-name-safe digest: neither the origin nor the workload id appears in a name.
    var digest: String {
        var data = Data("triangle-workload-token-cache-v1".utf8)
        for part in [origin, workloadID, keyThumbprint] + scopes {
            data.append(0)
            data.append(Data(part.utf8))
        }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// A DPoP-bound access token and the clock it was exchanged against. The value is
/// secret: it is never part of a description, a reflection or an error.
public struct CachedWorkloadToken: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    /// A token is never cached or reused for longer than this, whatever MESH reports.
    public static let maximumLifetime: TimeInterval = 3600
    /// Clock skew tolerated between the process that stored a token and the one reading it.
    static let futureSkew: TimeInterval = 60
    /// The token goes into an `Authorization` header: bounded, visible ASCII, no whitespace.
    static let maximumTokenBytes = 4096
    static let minimumTokenBytes = 16

    public let accessToken: String
    public let issuedAt: TimeInterval
    public let expiresAt: TimeInterval

    public init(accessToken: String, issuedAt: TimeInterval, expiresAt: TimeInterval) {
        self.accessToken = accessToken
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    static func isHeaderSafe(_ token: String) -> Bool {
        let bytes = token.utf8
        return bytes.count >= minimumTokenBytes && bytes.count <= maximumTokenBytes
            && bytes.allSatisfy { $0 >= 0x21 && $0 <= 0x7E }
    }

    /// True when the token can be sent now: well formed, not from the future, a
    /// plausible lifetime, and still at least `margin` seconds from expiry.
    public func isUsable(at now: TimeInterval, margin: TimeInterval) -> Bool {
        guard Self.isHeaderSafe(accessToken), issuedAt.isFinite, expiresAt.isFinite else { return false }
        guard issuedAt <= now + Self.futureSkew else { return false }
        let lifetime = expiresAt - issuedAt
        guard lifetime > 0, lifetime <= Self.maximumLifetime else { return false }
        return expiresAt - margin > now
    }

    public var description: String { "CachedWorkloadToken(accessToken: <redacted>, expiresAt: \(expiresAt))" }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["accessToken": "<redacted>", "issuedAt": issuedAt, "expiresAt": expiresAt], displayStyle: .struct)
    }
}

/// Storage for workload access tokens shared by helper processes. Implementations
/// never throw: a cache that cannot be read or written behaves as an empty one.
public protocol WorkloadTokenCache: AnyObject, Sendable {
    /// The entry for `key`, or nil. Staleness is the caller's decision (`isUsable`).
    func load(for key: WorkloadTokenCacheKey, now: TimeInterval) -> CachedWorkloadToken?
    func store(_ token: CachedWorkloadToken, for key: WorkloadTokenCacheKey)
    /// Forget the entry when it holds `accessToken`; a newer token another process
    /// stored in the meantime stays.
    func remove(for key: WorkloadTokenCacheKey, ifToken accessToken: String)
}

/// Process-local cache for tests and for callers that opt out of persistence.
public final class InMemoryWorkloadTokenCache: WorkloadTokenCache, @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [WorkloadTokenCacheKey: CachedWorkloadToken] = [:]

    public init() {}

    public func load(for key: WorkloadTokenCacheKey, now: TimeInterval) -> CachedWorkloadToken? {
        lock.withLock { entries[key] }
    }

    public func store(_ token: CachedWorkloadToken, for key: WorkloadTokenCacheKey) {
        lock.withLock { entries[key] = token }
    }

    public func remove(for key: WorkloadTokenCacheKey, ifToken accessToken: String) {
        lock.withLock {
            if entries[key]?.accessToken == accessToken { entries.removeValue(forKey: key) }
        }
    }
}

/// `~/Library/Application Support/The Triangle/credentials/local/workload-token/<digest>.json`.
///
/// Custody matches the workload key files this token is bound to: a real directory
/// owned by this user with no group/other bits (0700) holding regular, single-link,
/// owner-only (0600) files, never followed through a symlink. `credentials/` is the
/// tree runner sandboxes are denied (`TRIANGLE_CREDENTIAL_ROOT`). Writes are atomic
/// (temp file + rename), so a reader sees an old or a new entry, never a torn one.
public final class FileWorkloadTokenCache: WorkloadTokenCache, @unchecked Sendable {
    public static var defaultRootURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle/credentials/local/workload-token", isDirectory: true)
    }

    static let maximumFileBytes = 16 * 1024
    private static let fileKeys: Set<String> = [
        "version", "origin", "workloadId", "keyThumbprint", "scopes", "accessToken", "issuedAt", "expiresAt",
    ]

    private let root: URL
    private let owner: uid_t
    private let lock = NSLock()

    /// `owner` is the uid every directory and file must belong to (this user).
    public init(root: URL = FileWorkloadTokenCache.defaultRootURL, owner: uid_t = getuid()) {
        self.root = root
        self.owner = owner
    }

    private func fileURL(for key: WorkloadTokenCacheKey) -> URL {
        root.appendingPathComponent("token-\(key.digest).json")
    }

    public func load(for key: WorkloadTokenCacheKey, now: TimeInterval) -> CachedWorkloadToken? {
        lock.withLock {
            guard directoryIsPrivate() else { return nil }
            let url = fileURL(for: key)
            guard let data = readPrivateFile(url.path) else { return nil }
            guard let token = Self.decode(data, expecting: key) else { return nil }
            if token.expiresAt <= now {
                // Dead entry: do not leave an expired secret on disk.
                unlink(url.path)
                return nil
            }
            return token
        }
    }

    public func store(_ token: CachedWorkloadToken, for key: WorkloadTokenCacheKey) {
        lock.withLock {
            guard ensurePrivateDirectory() else { return }
            guard let data = Self.encode(token, for: key) else { return }
            let temporary = root.appendingPathComponent(".tmp-\(UUID().uuidString.lowercased())")
            let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { return }
            var written = false
            defer {
                close(descriptor)
                if !written { unlink(temporary.path) }
            }
            // The mode must not depend on the umask.
            guard fchmod(descriptor, 0o600) == 0 else { return }
            let complete = data.withUnsafeBytes { buffer -> Bool in
                var offset = 0
                while offset < buffer.count {
                    let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                    if count < 0 {
                        if errno == EINTR { continue }
                        return false
                    }
                    offset += count
                }
                return true
            }
            guard complete, rename(temporary.path, fileURL(for: key).path) == 0 else { return }
            written = true
            pruneExpired(now: token.issuedAt)
        }
    }

    public func remove(for key: WorkloadTokenCacheKey, ifToken accessToken: String) {
        lock.withLock {
            guard directoryIsPrivate() else { return }
            let url = fileURL(for: key)
            guard let data = readPrivateFile(url.path),
                  let current = Self.decode(data, expecting: key),
                  current.accessToken == accessToken
            else { return }
            unlink(url.path)
        }
    }

    // MARK: Filesystem custody

    private func directoryIsPrivate() -> Bool {
        var info = stat()
        guard lstat(root.path, &info) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == owner && (info.st_mode & 0o077) == 0
    }

    /// Creates the directory chain when it is absent and reports whether the leaf is safe.
    private func ensurePrivateDirectory() -> Bool {
        var info = stat()
        if lstat(root.path, &info) != 0 {
            guard errno == ENOENT else { return false }
            do {
                try FileManager.default.createDirectory(
                    at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
                )
            } catch {
                return false
            }
        }
        return directoryIsPrivate()
    }

    /// Reads a small regular file: no symlink, one link, this owner, no group/other bits.
    private func readPrivateFile(_ path: String) -> Data? {
        let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              info.st_nlink == 1,
              info.st_uid == owner,
              (info.st_mode & 0o077) == 0,
              info.st_size > 0,
              info.st_size <= off_t(Self.maximumFileBytes)
        else { return nil }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count < 0 {
                if errno == EINTR { continue }
                return nil
            }
            if count == 0 { break }
            data.append(contentsOf: buffer[0..<count])
            guard data.count <= Self.maximumFileBytes else { return nil }
        }
        return data
    }

    // MARK: Encoding

    private static func encode(_ token: CachedWorkloadToken, for key: WorkloadTokenCacheKey) -> Data? {
        guard CachedWorkloadToken.isHeaderSafe(token.accessToken), token.issuedAt.isFinite, token.expiresAt.isFinite else {
            return nil
        }
        let object: [String: Any] = [
            "version": 1,
            "origin": key.origin,
            "workloadId": key.workloadID,
            "keyThumbprint": key.keyThumbprint,
            "scopes": key.scopes,
            "accessToken": token.accessToken,
            "issuedAt": token.issuedAt,
            "expiresAt": token.expiresAt,
        ]
        guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return nil }
        data.append(0x0a)
        return data
    }

    private static func number(_ value: Any?) -> NSNumber? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return number
    }

    /// Strict: exact key set, exact types, and the entry must describe `key`.
    private static func decode(_ data: Data, expecting key: WorkloadTokenCacheKey) -> CachedWorkloadToken? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == fileKeys,
              number(object["version"])?.intValue == 1,
              object["origin"] as? String == key.origin,
              object["workloadId"] as? String == key.workloadID,
              object["keyThumbprint"] as? String == key.keyThumbprint,
              object["scopes"] as? [String] == key.scopes,
              let accessToken = object["accessToken"] as? String,
              let issuedAt = number(object["issuedAt"])?.doubleValue,
              let expiresAt = number(object["expiresAt"])?.doubleValue,
              CachedWorkloadToken.isHeaderSafe(accessToken)
        else { return nil }
        return CachedWorkloadToken(accessToken: accessToken, issuedAt: issuedAt, expiresAt: expiresAt)
    }

    /// Entries for other keys (a rotated key, another origin) are never read again;
    /// drop the ones that have expired so old secrets do not pile up.
    private func pruneExpired(now: TimeInterval) {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return }
        for name in names where name.hasPrefix("token-") && name.hasSuffix(".json") {
            let path = root.appendingPathComponent(name).path
            guard let data = readPrivateFile(path),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let expiresAt = Self.number(object["expiresAt"])?.doubleValue,
                  expiresAt <= now
            else { continue }
            unlink(path)
        }
    }
}
