import Darwin
import Foundation

public enum ClientInstanceStoreError: Error, Equatable, Sendable {
    case duplicateProfile
    case notFound
    case unsafeStorage
    case invalidRecord
}

public protocol ClientInstanceStore: Sendable {
    func create(_ instance: ClientInstance) throws
    func read(profile: ProfileName) throws -> ClientInstance
    func list() throws -> [ClientInstance]
    func setEnabled(_ enabled: Bool, profile: ProfileName) throws
    func remove(profile: ProfileName) throws
}

@_spi(ClientInstanceTesting)
public enum ClientInstanceStoreCrashPoint: Equatable, Sendable {
    case afterTemporaryFsync
    case afterExclusiveRename
}

@_spi(ClientInstanceTesting)
public enum ClientInstanceStoreTransitionPoint: Equatable, Sendable {
    case createBeforeCommit
    case setEnabledAfterRead
}

public final class InMemoryClientInstanceStore: ClientInstanceStore, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [ProfileName: ClientInstance] = [:]
    public init() {}

    public func create(_ instance: ClientInstance) throws {
        try lock.withLock {
            guard records[instance.profile] == nil else { throw ClientInstanceStoreError.duplicateProfile }
            records[instance.profile] = instance
        }
    }

    public func read(profile: ProfileName) throws -> ClientInstance {
        try lock.withLock {
            guard let record = records[profile] else { throw ClientInstanceStoreError.notFound }
            return record
        }
    }

    public func list() throws -> [ClientInstance] {
        lock.withLock { records.values.sorted { $0.profile.value < $1.profile.value } }
    }

    public func setEnabled(_ enabled: Bool, profile: ProfileName) throws {
        try lock.withLock {
            guard let record = records[profile] else { throw ClientInstanceStoreError.notFound }
            records[profile] = try record.settingEnabled(enabled)
        }
    }

    public func remove(profile: ProfileName) throws {
        try lock.withLock {
            guard records.removeValue(forKey: profile) != nil else { throw ClientInstanceStoreError.notFound }
        }
    }
}

public final class FileClientInstanceStore: ClientInstanceStore, @unchecked Sendable {
    private static let maximumBytes = 2048
    private static let inProcessTransitionLock = NSLock()
    private let root: URL
    private let managedDirectories: [URL]
    private let simulatedCrashAt: ClientInstanceStoreCrashPoint?
    private let transitionHook: (@Sendable (ClientInstanceStoreTransitionPoint) -> Void)?

    public convenience init() {
        let applicationRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        let clientRoot = applicationRoot.appendingPathComponent("client", isDirectory: true)
        let instancesRoot = clientRoot.appendingPathComponent("instances", isDirectory: true)
        self.init(root: instancesRoot, managedDirectories: [applicationRoot, clientRoot, instancesRoot], simulatedCrashAt: nil, transitionHook: nil)
    }

    private init(
        root: URL,
        managedDirectories: [URL],
        simulatedCrashAt: ClientInstanceStoreCrashPoint?,
        transitionHook: (@Sendable (ClientInstanceStoreTransitionPoint) -> Void)?
    ) {
        self.root = root
        self.managedDirectories = managedDirectories
        self.simulatedCrashAt = simulatedCrashAt
        self.transitionHook = transitionHook
    }

    @_spi(ClientInstanceTesting)
    public convenience init(
        testRoot: URL,
        simulatedCrashAt: ClientInstanceStoreCrashPoint? = nil,
        transitionHook: (@Sendable (ClientInstanceStoreTransitionPoint) -> Void)? = nil
    ) {
        self.init(root: testRoot, managedDirectories: [testRoot], simulatedCrashAt: simulatedCrashAt, transitionHook: transitionHook)
    }

    @_spi(ClientInstanceTesting)
    public static func metadataIsSafe(mode: Int, owner: Int, linkCount: Int, directory: Bool) -> Bool {
        guard owner == Int(getuid()) else { return false }
        if directory { return mode == 0o700 && linkCount >= 1 }
        return mode == 0o600 && linkCount == 1
    }

    public func create(_ instance: ClientInstance) throws {
        let data = try encode(instance)
        try withDirectoryLock(exclusive: true) { directory in
            let name = filename(instance.instanceID)
            try validateMissingOrExisting(directory: directory, name: name, requireMissing: true)
            transitionHook?(.createBeforeCommit)
            try write(data, directory: directory, name: name, replace: false)
        }
    }

    public func read(profile: ProfileName) throws -> ClientInstance {
        let identifier = ClientInstanceID.derive(profile: profile)
        return try withDirectoryLock(exclusive: false) { directory in
            let record = try read(directory: directory, name: filename(identifier))
            guard record.profile == profile, record.instanceID == identifier else { throw ClientInstanceStoreError.invalidRecord }
            return record
        }
    }

    public func list() throws -> [ClientInstance] {
        try withDirectoryLock(exclusive: false) { directory in
            let duplicate = dup(directory)
            guard duplicate >= 0, let stream = fdopendir(duplicate) else {
                if duplicate >= 0 { close(duplicate) }
                throw ClientInstanceStoreError.unsafeStorage
            }
            defer { closedir(stream) }
            var records: [ClientInstance] = []
            while let entry = readdir(stream) {
                let name = withUnsafePointer(to: &entry.pointee.d_name) {
                    $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
                }
                if name == "." || name == ".." || name.hasPrefix(".tmp-") { continue }
                guard name.wholeMatch(of: /^[a-f0-9]{64}\.json$/) != nil else { throw ClientInstanceStoreError.invalidRecord }
                let record = try read(directory: directory, name: name)
                guard name == filename(record.instanceID) else { throw ClientInstanceStoreError.invalidRecord }
                records.append(record)
            }
            let profiles = Set(records.map(\.profile))
            guard profiles.count == records.count else { throw ClientInstanceStoreError.invalidRecord }
            return records.sorted { $0.profile.value < $1.profile.value }
        }
    }

    public func setEnabled(_ enabled: Bool, profile: ProfileName) throws {
        let identifier = ClientInstanceID.derive(profile: profile)
        try withDirectoryLock(exclusive: true) { directory in
            let name = filename(identifier)
            let current = try read(directory: directory, name: name)
            guard current.profile == profile, current.instanceID == identifier else { throw ClientInstanceStoreError.invalidRecord }
            transitionHook?(.setEnabledAfterRead)
            try write(encode(try current.settingEnabled(enabled)), directory: directory, name: name, replace: true)
        }
    }

    public func remove(profile: ProfileName) throws {
        let identifier = ClientInstanceID.derive(profile: profile)
        try withDirectoryLock(exclusive: true) { directory in
            let name = filename(identifier)
            do {
                let record = try read(directory: directory, name: name)
                guard record.profile == profile, record.instanceID == identifier else { throw ClientInstanceStoreError.invalidRecord }
            }
            catch ClientInstanceStoreError.notFound { throw ClientInstanceStoreError.notFound }
            guard unlinkat(directory, name, 0) == 0, fsync(directory) == 0 else { throw ClientInstanceStoreError.unsafeStorage }
        }
    }

    private func withDirectoryLock<T>(exclusive: Bool, _ body: (Int32) throws -> T) throws -> T {
        Self.inProcessTransitionLock.lock()
        defer { Self.inProcessTransitionLock.unlock() }
        let directory = try openRoot()
        defer { close(directory) }
        guard flock(directory, exclusive ? LOCK_EX : LOCK_SH) == 0 else { throw ClientInstanceStoreError.unsafeStorage }
        defer { _ = flock(directory, LOCK_UN) }
        return try body(directory)
    }

    private func openRoot() throws -> Int32 {
        for directory in managedDirectories { try ensureSafeDirectory(directory) }
        let descriptor = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw ClientInstanceStoreError.unsafeStorage }
        return descriptor
    }

    private func ensureSafeDirectory(_ directory: URL) throws {
        var metadata = stat()
        if lstat(directory.path, &metadata) != 0 {
            guard errno == ENOENT else { throw ClientInstanceStoreError.unsafeStorage }
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            } catch { throw ClientInstanceStoreError.unsafeStorage }
            guard lstat(directory.path, &metadata) == 0 else { throw ClientInstanceStoreError.unsafeStorage }
        }
        guard (metadata.st_mode & S_IFMT) == S_IFDIR,
              Self.metadataIsSafe(
                  mode: Int(metadata.st_mode & 0o777), owner: Int(metadata.st_uid),
                  linkCount: Int(metadata.st_nlink), directory: true
              )
        else { throw ClientInstanceStoreError.unsafeStorage }
    }

    private func read(directory: Int32, name: String) throws -> ClientInstance {
        let descriptor = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0 {
            if errno == ENOENT { throw ClientInstanceStoreError.notFound }
            throw ClientInstanceStoreError.unsafeStorage
        }
        defer { close(descriptor) }
        try validateFile(descriptor)
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 512)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            guard count >= 0 else { throw ClientInstanceStoreError.unsafeStorage }
            if count == 0 { break }
            data.append(buffer, count: count)
            guard data.count <= Self.maximumBytes else { throw ClientInstanceStoreError.invalidRecord }
        }
        do {
            guard try !StrictClientInstanceJSONScanner.hasDuplicateObjectMembers(data) else {
                throw ClientInstanceStoreError.invalidRecord
            }
            return try JSONDecoder().decode(ClientInstance.self, from: data)
        }
        catch let error as ClientInstanceStoreError { throw error }
        catch { throw ClientInstanceStoreError.invalidRecord }
    }

    private func encode(_ instance: ClientInstance) throws -> Data {
        let data = try JSONEncoder().encode(instance)
        guard data.count <= Self.maximumBytes else { throw ClientInstanceStoreError.invalidRecord }
        return data
    }

    private func write(_ data: Data, directory: Int32, name: String, replace: Bool) throws {
        let temporary = ".tmp-\(UUID().uuidString.lowercased())"
        let descriptor = openat(directory, temporary, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw ClientInstanceStoreError.unsafeStorage }
        var temporaryExists = true
        var preserveTemporary = false
        defer {
            close(descriptor)
            if temporaryExists && !preserveTemporary { _ = unlinkat(directory, temporary, 0) }
        }
        guard fchmod(descriptor, 0o600) == 0 else { throw ClientInstanceStoreError.unsafeStorage }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                guard count > 0 else { throw ClientInstanceStoreError.unsafeStorage }
                offset += count
            }
        }
        guard fsync(descriptor) == 0 else { throw ClientInstanceStoreError.unsafeStorage }
        if !replace, simulatedCrashAt == .afterTemporaryFsync {
            preserveTemporary = true
            throw ClientInstanceStoreError.unsafeStorage
        }
        if replace {
            try validateMissingOrExisting(directory: directory, name: name, requireMissing: false)
            guard renameat(directory, temporary, directory, name) == 0 else { throw ClientInstanceStoreError.unsafeStorage }
            temporaryExists = false
        } else {
            guard renameatx_np(directory, temporary, directory, name, UInt32(RENAME_EXCL)) == 0 else {
                if errno == EEXIST { throw ClientInstanceStoreError.duplicateProfile }
                throw ClientInstanceStoreError.unsafeStorage
            }
            temporaryExists = false
            if simulatedCrashAt == .afterExclusiveRename {
                guard fsync(directory) == 0 else { throw ClientInstanceStoreError.unsafeStorage }
                throw ClientInstanceStoreError.unsafeStorage
            }
        }
        guard fsync(directory) == 0 else { throw ClientInstanceStoreError.unsafeStorage }
    }

    private func validateMissingOrExisting(directory: Int32, name: String, requireMissing: Bool) throws {
        var metadata = stat()
        if fstatat(directory, name, &metadata, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT {
                if requireMissing { return }
                throw ClientInstanceStoreError.notFound
            }
            throw ClientInstanceStoreError.unsafeStorage
        }
        if requireMissing {
            guard (metadata.st_mode & S_IFMT) == S_IFREG,
                  Self.metadataIsSafe(
                      mode: Int(metadata.st_mode & 0o777), owner: Int(metadata.st_uid),
                      linkCount: Int(metadata.st_nlink), directory: false
                  )
            else { throw ClientInstanceStoreError.unsafeStorage }
            throw ClientInstanceStoreError.duplicateProfile
        }
        guard (metadata.st_mode & S_IFMT) == S_IFREG,
              Self.metadataIsSafe(
                  mode: Int(metadata.st_mode & 0o777), owner: Int(metadata.st_uid),
                  linkCount: Int(metadata.st_nlink), directory: false
              )
        else { throw ClientInstanceStoreError.unsafeStorage }
    }

    private func validateFile(_ descriptor: Int32) throws {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              Self.metadataIsSafe(
                  mode: Int(metadata.st_mode & 0o777), owner: Int(metadata.st_uid),
                  linkCount: Int(metadata.st_nlink), directory: false
              )
        else { throw ClientInstanceStoreError.unsafeStorage }
    }

    private func filename(_ identifier: ClientInstanceID) -> String { identifier.value + ".json" }
}

private enum StrictClientInstanceJSONError: Error { case malformed }

private struct StrictClientInstanceJSONScanner {
    private let bytes: [UInt8]
    private var index = 0
    private var duplicateObjectMembers = false

    static func hasDuplicateObjectMembers(_ data: Data) throws -> Bool {
        var scanner = Self(bytes: Array(data))
        scanner.skipWhitespace()
        try scanner.parseValue()
        scanner.skipWhitespace()
        guard scanner.index == scanner.bytes.count else { throw StrictClientInstanceJSONError.malformed }
        return scanner.duplicateObjectMembers
    }

    private mutating func parseValue() throws {
        skipWhitespace()
        guard let byte = current else { throw StrictClientInstanceJSONError.malformed }
        switch byte {
        case 0x7b: try parseObject()
        case 0x5b: try parseArray()
        case 0x22: _ = try parseString()
        case 0x74: try consumeLiteral("true")
        case 0x66: try consumeLiteral("false")
        case 0x6e: try consumeLiteral("null")
        case 0x2d, 0x30...0x39: try consumeNumber()
        default: throw StrictClientInstanceJSONError.malformed
        }
    }

    private mutating func parseObject() throws {
        try consume(0x7b)
        skipWhitespace()
        if current == 0x7d { index += 1; return }
        var keys = Set<String>()
        while true {
            guard current == 0x22 else { throw StrictClientInstanceJSONError.malformed }
            let key = try parseString()
            if !keys.insert(key).inserted { duplicateObjectMembers = true }
            skipWhitespace()
            try consume(0x3a)
            try parseValue()
            skipWhitespace()
            if current == 0x7d { index += 1; return }
            try consume(0x2c)
            skipWhitespace()
        }
    }

    private mutating func parseArray() throws {
        try consume(0x5b)
        skipWhitespace()
        if current == 0x5d { index += 1; return }
        while true {
            try parseValue()
            skipWhitespace()
            if current == 0x5d { index += 1; return }
            try consume(0x2c)
            skipWhitespace()
        }
    }

    private mutating func parseString() throws -> String {
        let start = index
        try consume(0x22)
        while let byte = current {
            if byte == 0x22 {
                index += 1
                var wrapped = Data([0x5b])
                wrapped.append(contentsOf: bytes[start..<index])
                wrapped.append(0x5d)
                guard let decoded = try? JSONSerialization.jsonObject(with: wrapped) as? [String], decoded.count == 1 else {
                    throw StrictClientInstanceJSONError.malformed
                }
                return decoded[0]
            }
            guard byte >= 0x20 else { throw StrictClientInstanceJSONError.malformed }
            if byte == 0x5c {
                index += 1
                guard current != nil else { throw StrictClientInstanceJSONError.malformed }
            }
            index += 1
        }
        throw StrictClientInstanceJSONError.malformed
    }

    private mutating func consumeLiteral(_ literal: StaticString) throws {
        let expected = Array(String(describing: literal).utf8)
        guard index + expected.count <= bytes.count,
              Array(bytes[index..<(index + expected.count)]) == expected
        else { throw StrictClientInstanceJSONError.malformed }
        index += expected.count
    }

    private mutating func consumeNumber() throws {
        let start = index
        while let byte = current, !Self.isDelimiter(byte) { index += 1 }
        guard index > start else { throw StrictClientInstanceJSONError.malformed }
    }

    private mutating func consume(_ expected: UInt8) throws {
        guard current == expected else { throw StrictClientInstanceJSONError.malformed }
        index += 1
    }

    private mutating func skipWhitespace() {
        while let byte = current, [0x20, 0x09, 0x0a, 0x0d].contains(byte) { index += 1 }
    }

    private var current: UInt8? { index < bytes.count ? bytes[index] : nil }
    private static func isDelimiter(_ byte: UInt8) -> Bool {
        byte == 0x2c || byte == 0x5d || byte == 0x7d || byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d
    }
}
