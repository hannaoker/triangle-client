import CryptoKit
import Foundation
#if canImport(Darwin)
import Darwin
#endif

// Permissions v1 custody (Option 1): the `triangle` CLI owns each agent's
// workload key at `<TRIANGLE_HOME>/agents/<agent_id>/workload-key.json` (0600)
// beside `agent.json`. A helper profile is only a pointer to that key file;
// the helper never stores, copies, or mints agent credentials itself.

public enum V1CustodyError: Error, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    case profileNotBound
    case invalidBinding
    case keyFileNotAbsolute
    case keyFileMissing
    case keyFileUnsafe
    case keyFileInvalid
    case agentRecordInvalid
    case agentMismatch
    case bindingUnsupported

    public var description: String {
        switch self {
        case .profileNotBound: "profile is not bound to a triangle agent"
        case .invalidBinding: "profile binding is invalid"
        case .keyFileNotAbsolute: "workload key path must be absolute"
        case .keyFileMissing: "workload key file was not found"
        case .keyFileUnsafe: "workload key file must be a regular 0600 file owned by this user"
        case .keyFileInvalid: "workload key file is not a valid Ed25519 private JWK"
        case .agentRecordInvalid: "agent.json beside the workload key is invalid"
        case .agentMismatch: "agent.json does not match its agent directory"
        case .bindingUnsupported: "helper profiles do not store agent keys; use `triangle agent add`"
        }
    }

    public var debugDescription: String { description }
}

/// A helper profile → the agent key file it uses. Secret-free.
public struct V1ProfileBinding: Codable, Equatable, Sendable {
    public let version: Int
    public let keyFile: String
    /// Optional transport origin (for example a preview deployment URL); defaults
    /// to `authority.json` `via`, then the agent's authority.
    public let origin: String?

    public init(keyFile: String, origin: String? = nil) {
        version = 1
        self.keyFile = keyFile
        self.origin = origin
    }

    private enum CodingKeys: String, CodingKey, CaseIterable { case version, keyFile, origin }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        keyFile = try values.decode(String.self, forKey: .keyFile)
        origin = try values.decodeIfPresent(String.self, forKey: .origin)
        guard version == 1, keyFile.hasPrefix("/"), keyFile.utf8.count <= 1024 else {
            throw V1CustodyError.invalidBinding
        }
    }
}

public protocol V1ProfileBindingStore: AnyObject, Sendable {
    func read(for profile: ProfileName) throws -> V1ProfileBinding
    func write(_ binding: V1ProfileBinding, for profile: ProfileName) throws
    func delete(for profile: ProfileName) throws
    func profiles() throws -> [ProfileName]
    /// Exclusive, cross-process lock held across a bind's check → verify → write.
    func acquireBindLock() throws -> V1BindLease
}

/// Releases a bind lock when released or deallocated.
public final class V1BindLease: @unchecked Sendable {
    private var fd: Int32
    init(fd: Int32) { self.fd = fd }
    public static func unlocked() -> V1BindLease { V1BindLease(fd: -1) }
    public func release() {
        guard fd >= 0 else { return }
        _ = flock(fd, LOCK_UN)
        close(fd)
        fd = -1
    }
    deinit { release() }
}

/// A custody directory: a real directory (no symlink) owned by this user with no
/// group/other bits, as `triangle` and the helper create them (0700).
enum V1PrivateDirectory {
    static func isSafe(_ path: String) -> Bool {
        var info = stat()
        guard lstat(path, &info) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == getuid() && (info.st_mode & 0o077) == 0
    }
}

public final class FileV1ProfileBindingStore: V1ProfileBindingStore, @unchecked Sendable {
    public static var defaultRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle/profiles-v1", isDirectory: true)
    }

    private let root: URL
    private let lock = NSLock()

    public init(root: URL = FileV1ProfileBindingStore.defaultRoot) {
        self.root = root
    }

    /// `profile-<utf8 hex>.json`: exact-name and case-distinct on
    /// case-insensitive filesystems (`Foo` and `foo` never share a file).
    static func fileName(for profile: ProfileName) -> String {
        "profile-" + profile.value.utf8.map { String(format: "%02x", $0) }.joined() + ".json"
    }

    static func profile(fromFileName name: String) -> ProfileName? {
        guard name.hasPrefix("profile-"), name.hasSuffix(".json") else { return nil }
        let hex = Array(name.dropFirst(8).dropLast(5))
        guard !hex.isEmpty, hex.count % 2 == 0 else { return nil }
        var bytes: [UInt8] = []
        var index = 0
        while index < hex.count {
            guard let byte = UInt8(String(hex[index...index + 1]), radix: 16),
                  String(hex[index...index + 1]) == String(format: "%02x", byte) else { return nil }
            bytes.append(byte)
            index += 2
        }
        guard let text = String(bytes: bytes, encoding: .utf8) else { return nil }
        return try? ProfileName(text)
    }

    private func url(for profile: ProfileName) -> URL {
        root.appendingPathComponent(Self.fileName(for: profile))
    }

    private func ensureSafeRoot() throws {
        guard V1PrivateDirectory.isSafe(root.path) else { throw V1CustodyError.invalidBinding }
    }

    public func acquireBindLock() throws -> V1BindLease {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try ensureSafeRoot()
        let fd = open(root.appendingPathComponent(".bind.lock").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw V1CustodyError.invalidBinding }
        guard flock(fd, LOCK_EX) == 0 else { close(fd); throw V1CustodyError.invalidBinding }
        return V1BindLease(fd: fd)
    }

    public func read(for profile: ProfileName) throws -> V1ProfileBinding {
        try lock.withLock {
            var rootInfo = stat()
            if lstat(root.path, &rootInfo) != 0, errno == ENOENT { throw V1CustodyError.profileNotBound }
            try ensureSafeRoot()
            let url = url(for: profile)
            let data: Data
            do {
                data = try V1PrivateFile.read(url.path)
            } catch V1CustodyError.keyFileMissing {
                throw V1CustodyError.profileNotBound
            } catch {
                throw V1CustodyError.invalidBinding
            }
            do {
                return try JSONDecoder().decode(V1ProfileBinding.self, from: data)
            } catch {
                throw V1CustodyError.invalidBinding
            }
        }
    }

    public func write(_ binding: V1ProfileBinding, for profile: ProfileName) throws {
        try lock.withLock {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try ensureSafeRoot()
            let url = url(for: profile)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            var data = try encoder.encode(binding)
            data.append(0x0a)
            let temporary = root.appendingPathComponent(".\(UUID().uuidString).tmp")
            guard FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
                throw V1CustodyError.invalidBinding
            }
            do {
                guard rename(temporary.path, url.path) == 0 else { throw V1CustodyError.invalidBinding }
            } catch {
                try? FileManager.default.removeItem(at: temporary)
                throw error
            }
        }
    }

    public func delete(for profile: ProfileName) throws {
        try lock.withLock {
            let url = url(for: profile)
            guard FileManager.default.fileExists(atPath: url.path) else { throw V1CustodyError.profileNotBound }
            try ensureSafeRoot()
            try FileManager.default.removeItem(at: url)
        }
    }

    public func profiles() throws -> [ProfileName] {
        try lock.withLock {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return [] }
            return names.compactMap(Self.profile(fromFileName:)).sorted { $0.value < $1.value }
        }
    }
}

public final class InMemoryV1ProfileBindingStore: V1ProfileBindingStore, @unchecked Sendable {
    private let lock = NSLock()
    private var bindings: [ProfileName: V1ProfileBinding] = [:]
    public init() {}
    public func read(for profile: ProfileName) throws -> V1ProfileBinding {
        try lock.withLock {
            guard let binding = bindings[profile] else { throw V1CustodyError.profileNotBound }
            return binding
        }
    }
    public func write(_ binding: V1ProfileBinding, for profile: ProfileName) throws {
        lock.withLock { bindings[profile] = binding }
    }
    public func delete(for profile: ProfileName) throws {
        try lock.withLock {
            guard bindings.removeValue(forKey: profile) != nil else { throw V1CustodyError.profileNotBound }
        }
    }
    public func profiles() throws -> [ProfileName] {
        lock.withLock { bindings.keys.sorted { $0.value < $1.value } }
    }
    public func acquireBindLock() throws -> V1BindLease { .unlocked() }
}

/// Everything the helper needs about one agent, loaded from v1 custody.
public struct V1AgentMaterial: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public static let agentBounds = ["agent.read", "agent.write"]

    public let agentID: AgentID
    public let handle: MailboxHandle
    public let workloadID: WorkloadID
    public let privateKey: Curve25519.Signing.PrivateKey
    public let scopes: [String]
    /// The MESH authority the agent belongs to.
    public let authority: MeshOrigin
    /// The origin the helper and its worker actually talk to.
    public let origin: MeshOrigin
    public let keyFile: URL

    public init(
        agentID: AgentID, handle: MailboxHandle, workloadID: WorkloadID,
        privateKey: Curve25519.Signing.PrivateKey, scopes: [String] = V1AgentMaterial.agentBounds,
        authority: MeshOrigin, origin: MeshOrigin, keyFile: URL
    ) {
        self.agentID = agentID
        self.handle = handle
        self.workloadID = workloadID
        self.privateKey = privateKey
        self.scopes = scopes
        self.authority = authority
        self.origin = origin
        self.keyFile = keyFile
    }

    public var workloadRecord: WorkloadKeyRecord {
        WorkloadKeyRecord(privateKey: privateKey, workloadID: workloadID, scopes: scopes)
    }

    /// The worker's form of the key: the unpadded base64url Ed25519 seed (43 chars).
    public var workloadPrivateKeySeed: String { Base64URL.encode(privateKey.rawRepresentation) }

    public var description: String {
        "V1AgentMaterial(agentID: \(agentID.value), handle: \(handle.value), workloadID: \(workloadID.value), origin: \(origin.value), key: <redacted>)"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: ["agentID": agentID.value, "handle": handle.value, "workloadID": workloadID.value, "origin": origin.value, "key": "<redacted>"], displayStyle: .struct)
    }
}

/// Resolves a helper profile to its agent material.
public protocol V1AgentResolver: Sendable {
    func material(for profile: ProfileName) throws -> V1AgentMaterial
}

public struct FileV1AgentResolver: V1AgentResolver {
    public let bindings: any V1ProfileBindingStore
    public init(bindings: any V1ProfileBindingStore = FileV1ProfileBindingStore()) { self.bindings = bindings }

    public func material(for profile: ProfileName) throws -> V1AgentMaterial {
        let binding = try bindings.read(for: profile)
        let override = try binding.origin.map { try MeshOrigin($0) }
        return try V1AgentCredentialLoader.load(keyFile: URL(fileURLWithPath: binding.keyFile), originOverride: override)
    }
}

public final class InMemoryV1AgentResolver: V1AgentResolver, @unchecked Sendable {
    private let lock = NSLock()
    private var materials: [ProfileName: V1AgentMaterial] = [:]
    public init() {}
    public func set(_ material: V1AgentMaterial, for profile: ProfileName) { lock.withLock { materials[profile] = material } }
    public func remove(_ profile: ProfileName) { _ = lock.withLock { materials.removeValue(forKey: profile) } }
    public func material(for profile: ProfileName) throws -> V1AgentMaterial {
        try lock.withLock {
            guard let material = materials[profile] else { throw V1CustodyError.profileNotBound }
            return material
        }
    }
}

/// The `WorkloadKeyStore` the rest of the helper reads: backed by v1 custody, read-only.
public final class V1WorkloadKeyStore: WorkloadKeyStore, @unchecked Sendable {
    private let resolver: any V1AgentResolver
    public init(resolver: any V1AgentResolver = FileV1AgentResolver()) { self.resolver = resolver }

    public func create(_ key: Curve25519.Signing.PrivateKey, workloadID: WorkloadID?, for profile: ProfileName) throws {
        throw V1CustodyError.bindingUnsupported
    }

    public func read(for profile: ProfileName) throws -> WorkloadKeyRecord {
        do {
            return try resolver.material(for: profile).workloadRecord
        } catch V1CustodyError.profileNotBound {
            throw WorkloadKeyStoreError.itemNotFound
        } catch {
            throw WorkloadKeyStoreError.invalidStoredKey
        }
    }

    public func delete(for profile: ProfileName) throws {
        throw V1CustodyError.bindingUnsupported
    }
}

public enum V1AgentCredentialLoader {
    public static let maximumFileBytes = 64 * 1024

    public static func load(keyFile: URL, originOverride: MeshOrigin? = nil) throws -> V1AgentMaterial {
        let keyPath = keyFile.path
        guard keyPath.hasPrefix("/") else { throw V1CustodyError.keyFileNotAbsolute }
        guard keyFile.lastPathComponent == "workload-key.json" else { throw V1CustodyError.keyFileInvalid }
        let agentDirectory = keyFile.deletingLastPathComponent()
        let agentsDirectory = agentDirectory.deletingLastPathComponent()
        guard agentsDirectory.lastPathComponent == "agents" else { throw V1CustodyError.agentMismatch }
        let home = agentsDirectory.deletingLastPathComponent()
        // Every custody directory must be a real 0700-style directory owned by
        // this user, so a symlinked or shared parent cannot redirect the key.
        for directory in [home, agentsDirectory, agentDirectory] where !V1PrivateDirectory.isSafe(directory.path) {
            throw V1CustodyError.keyFileUnsafe
        }

        let keyData = try V1PrivateFile.read(keyPath)
        let privateKey = try parsePrivateJWK(keyData)

        let agentData: Data
        do {
            agentData = try V1PrivateFile.read(agentDirectory.appendingPathComponent("agent.json").path)
        } catch {
            throw V1CustodyError.agentRecordInvalid
        }
        guard let agent = try? JSONSerialization.jsonObject(with: agentData) as? [String: Any],
              let rawAgentID = agent["agent_id"] as? String, let agentID = try? AgentID(rawAgentID),
              let rawHandle = agent["handle"] as? String, let handle = try? MailboxHandle(rawHandle),
              let rawWorkloadID = agent["workload_id"] as? String, let workloadID = try? WorkloadID(rawWorkloadID),
              let rawAuthority = agent["authority"] as? String, let authority = try? MeshOrigin(rawAuthority)
        else { throw V1CustodyError.agentRecordInvalid }
        guard agentDirectory.lastPathComponent == agentID.value else { throw V1CustodyError.agentMismatch }
        let bounds = (agent["bounds"] as? [String]) ?? V1AgentMaterial.agentBounds
        let scopes = V1AgentMaterial.agentBounds.filter { bounds.contains($0) }
        guard !scopes.isEmpty else { throw V1CustodyError.agentRecordInvalid }

        var origin = authority
        if let originOverride {
            origin = originOverride
        } else if let authorityData = try? V1PrivateFile.read(home.appendingPathComponent("authority.json").path),
                  let record = try? JSONSerialization.jsonObject(with: authorityData) as? [String: Any],
                  (record["authority"] as? String).flatMap({ try? MeshOrigin($0) }) == authority,
                  let via = record["via"] as? String, let viaOrigin = try? MeshOrigin(via) {
            origin = viaOrigin
        }
        return V1AgentMaterial(
            agentID: agentID, handle: handle, workloadID: workloadID, privateKey: privateKey,
            scopes: scopes, authority: authority, origin: origin, keyFile: keyFile
        )
    }

    static func parsePrivateJWK(_ data: Data) throws -> Curve25519.Signing.PrivateKey {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["kty"] as? String == "OKP", object["crv"] as? String == "Ed25519",
              let d = (object["d"] as? String).flatMap(Base64URL.decode), d.count == 32,
              let x = object["x"] as? String,
              let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: d)
        else { throw V1CustodyError.keyFileInvalid }
        guard Base64URL.encode(key.publicKey.rawRepresentation) == x else { throw V1CustodyError.keyFileInvalid }
        return key
    }
}

/// Read a small private file: regular (no symlink, single hard link), owned by this user, no group/other bits.
/// A second hard link could sit inside a sandbox-readable root and bypass the path deny.
enum V1PrivateFile {
    static func read(_ path: String) throws -> Data {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else {
            if errno == ENOENT { throw V1CustodyError.keyFileMissing }
            throw V1CustodyError.keyFileUnsafe
        }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              info.st_nlink == 1,
              info.st_uid == getuid(),
              (info.st_mode & 0o077) == 0,
              info.st_size <= off_t(V1AgentCredentialLoader.maximumFileBytes)
        else { throw V1CustodyError.keyFileUnsafe }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 { throw V1CustodyError.keyFileUnsafe }
            if count == 0 { break }
            data.append(contentsOf: buffer[0..<count])
            guard data.count <= V1AgentCredentialLoader.maximumFileBytes else { throw V1CustodyError.keyFileUnsafe }
        }
        return data
    }
}
