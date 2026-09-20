import Darwin
import Foundation

public enum CodexConversationStoreError: Error, Equatable, Sendable {
    case featureInactive
    case notFound
    case alreadyExists
    case unsafeStorage
    case invalidRecord
}

public protocol CodexConversationStore: Sendable {
    func readProfile(instanceID: ClientInstanceID) throws -> CodexProfileOwnerRecord?
    func writeProfile(_ record: CodexProfileOwnerRecord) throws
    func readConversation(instanceID: ClientInstanceID, roomID: String) throws -> CodexConversationRecord?
    func writeConversation(_ record: CodexConversationRecord) throws
    func readCompletion(instanceID: ClientInstanceID, idempotencyID: String) throws -> CodexCompletionRecord?
    func writeCompletion(_ record: CodexCompletionRecord) throws
}

/// Durable helper-owned Codex conversation registry.
///
/// Path:
/// `~/Library/Application Support/The Triangle/model-state/instances/<id>/codex-runtime/`
///
/// Phase 0 ships the store behind an inactive feature flag. Callers must not
/// activate it for production profiles until later phases flip the flag after
/// Mini Darwin evidence. Records hold identifiers only — never message text,
/// assistant output, MESH credentials, or ChatGPT session material.
public final class FileCodexConversationStore: CodexConversationStore, @unchecked Sendable {
    private static let maximumBytes = 8192
    private static let inProcessLock = NSLock()
    private let root: URL
    private let managedDirectories: [URL]
    private let featureEnabled: Bool

    public convenience init(instanceID: ClientInstanceID) {
        let applicationRoot = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/The Triangle", isDirectory: true)
        let modelState = applicationRoot.appendingPathComponent("model-state", isDirectory: true)
        let instances = modelState.appendingPathComponent("instances", isDirectory: true)
        let instanceRoot = instances.appendingPathComponent(instanceID.value, isDirectory: true)
        let runtime = instanceRoot.appendingPathComponent("codex-runtime", isDirectory: true)
        self.init(
            root: runtime,
            managedDirectories: [applicationRoot, modelState, instances, instanceRoot, runtime],
            featureEnabled: CodexRuntimeFeatureFlags.conversationStoreEnabled
        )
    }

    private init(root: URL, managedDirectories: [URL], featureEnabled: Bool) {
        self.root = root
        self.managedDirectories = managedDirectories
        self.featureEnabled = featureEnabled
    }

    @_spi(CodexRuntimeTesting)
    public convenience init(testRoot: URL, featureEnabled: Bool) {
        let conversations = testRoot.appendingPathComponent("conversations", isDirectory: true)
        let completions = testRoot.appendingPathComponent("completions", isDirectory: true)
        self.init(
            root: testRoot,
            managedDirectories: [testRoot, conversations, completions],
            featureEnabled: featureEnabled
        )
    }

    @_spi(CodexRuntimeTesting)
    public static func metadataIsSafe(mode: Int, owner: Int, linkCount: Int, directory: Bool) -> Bool {
        guard owner == Int(getuid()) else { return false }
        if directory { return mode == 0o700 && linkCount >= 1 }
        return mode == 0o600 && linkCount == 1
    }

    public func readProfile(instanceID: ClientInstanceID) throws -> CodexProfileOwnerRecord? {
        try requireFeature()
        return try withDirectoryLock(exclusive: false) { directory in
            do {
                let record: CodexProfileOwnerRecord = try readJSON(directory: directory, name: "profile.json")
                guard record.profileInstanceID == instanceID else {
                    throw CodexConversationStoreError.invalidRecord
                }
                try rejectSecretMaterial(record)
                return record
            } catch CodexConversationStoreError.notFound {
                return nil
            }
        }
    }

    public func writeProfile(_ record: CodexProfileOwnerRecord) throws {
        try requireFeature()
        try rejectSecretMaterial(record)
        let data = try encode(record)
        try withDirectoryLock(exclusive: true) { directory in
            try write(data, directory: directory, name: "profile.json", replace: true)
        }
    }

    public func readConversation(instanceID: ClientInstanceID, roomID: String) throws -> CodexConversationRecord? {
        try requireFeature()
        try validateRoomID(roomID)
        return try withDirectoryLock(exclusive: false) { directory in
            let conversations = try openSubdirectory(directory: directory, name: "conversations", create: false)
            defer { close(conversations) }
            do {
                let record: CodexConversationRecord = try readJSON(
                    directory: conversations,
                    name: filename(forRoom: roomID)
                )
                guard record.profileInstanceID == instanceID, record.meshRoomID == roomID else {
                    throw CodexConversationStoreError.invalidRecord
                }
                try rejectSecretMaterial(record)
                return record
            } catch CodexConversationStoreError.notFound {
                return nil
            }
        }
    }

    public func writeConversation(_ record: CodexConversationRecord) throws {
        try requireFeature()
        try validateRoomID(record.meshRoomID)
        try rejectSecretMaterial(record)
        let data = try encode(record)
        try withDirectoryLock(exclusive: true) { directory in
            let conversations = try openSubdirectory(directory: directory, name: "conversations", create: true)
            defer { close(conversations) }
            try write(data, directory: conversations, name: filename(forRoom: record.meshRoomID), replace: true)
        }
    }

    public func readCompletion(instanceID: ClientInstanceID, idempotencyID: String) throws -> CodexCompletionRecord? {
        try requireFeature()
        try validateIdempotencyID(idempotencyID)
        return try withDirectoryLock(exclusive: false) { directory in
            let completions = try openSubdirectory(directory: directory, name: "completions", create: false)
            defer { close(completions) }
            do {
                let record: CodexCompletionRecord = try readJSON(
                    directory: completions,
                    name: filename(forIdempotency: idempotencyID)
                )
                guard record.profileInstanceID == instanceID, record.idempotencyID == idempotencyID else {
                    throw CodexConversationStoreError.invalidRecord
                }
                try rejectSecretMaterial(record)
                return record
            } catch CodexConversationStoreError.notFound {
                return nil
            }
        }
    }

    public func writeCompletion(_ record: CodexCompletionRecord) throws {
        try requireFeature()
        try validateIdempotencyID(record.idempotencyID)
        try rejectSecretMaterial(record)
        let data = try encode(record)
        try withDirectoryLock(exclusive: true) { directory in
            let completions = try openSubdirectory(directory: directory, name: "completions", create: true)
            defer { close(completions) }
            try write(
                data,
                directory: completions,
                name: filename(forIdempotency: record.idempotencyID),
                replace: true
            )
        }
    }

    private func requireFeature() throws {
        guard featureEnabled else { throw CodexConversationStoreError.featureInactive }
    }

    private func validateRoomID(_ roomID: String) throws {
        guard roomID.wholeMatch(of: /^room_[a-f0-9]{32}$/) != nil else {
            throw CodexConversationStoreError.invalidRecord
        }
    }

    private func validateIdempotencyID(_ value: String) throws {
        guard value.wholeMatch(of: /^[A-Za-z0-9._:-]{8,128}$/) != nil else {
            throw CodexConversationStoreError.invalidRecord
        }
    }

    private func filename(forRoom roomID: String) -> String { roomID + ".json" }
    private func filename(forIdempotency idempotencyID: String) -> String { idempotencyID + ".json" }

    private func rejectSecretMaterial<T: Encodable>(_ value: T) throws {
        let data = try JSONEncoder().encode(value)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CodexConversationStoreError.invalidRecord
        }
        if text.range(of: #"mesh_(?:watch_)?[A-Za-z0-9_-]{8,}"#, options: .regularExpression) != nil {
            throw CodexConversationStoreError.invalidRecord
        }
    }

    private func withDirectoryLock<T>(exclusive: Bool, _ body: (Int32) throws -> T) throws -> T {
        Self.inProcessLock.lock()
        defer { Self.inProcessLock.unlock() }
        let directory = try openRoot()
        defer { close(directory) }
        guard flock(directory, exclusive ? LOCK_EX : LOCK_SH) == 0 else {
            throw CodexConversationStoreError.unsafeStorage
        }
        defer { _ = flock(directory, LOCK_UN) }
        return try body(directory)
    }

    private func openRoot() throws -> Int32 {
        for directory in managedDirectories { try ensureSafeDirectory(directory) }
        let descriptor = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw CodexConversationStoreError.unsafeStorage }
        return descriptor
    }

    private func ensureSafeDirectory(_ directory: URL) throws {
        var metadata = stat()
        if lstat(directory.path, &metadata) != 0 {
            guard errno == ENOENT else { throw CodexConversationStoreError.unsafeStorage }
            do {
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700]
                )
            } catch {
                throw CodexConversationStoreError.unsafeStorage
            }
            guard lstat(directory.path, &metadata) == 0 else {
                throw CodexConversationStoreError.unsafeStorage
            }
        }
        guard (metadata.st_mode & S_IFMT) == S_IFDIR,
              Self.metadataIsSafe(
                  mode: Int(metadata.st_mode & 0o777),
                  owner: Int(metadata.st_uid),
                  linkCount: Int(metadata.st_nlink),
                  directory: true
              )
        else { throw CodexConversationStoreError.unsafeStorage }
    }

    private func openSubdirectory(directory: Int32, name: String, create: Bool) throws -> Int32 {
        var metadata = stat()
        if fstatat(directory, name, &metadata, AT_SYMLINK_NOFOLLOW) != 0 {
            guard errno == ENOENT else { throw CodexConversationStoreError.unsafeStorage }
            guard create else { throw CodexConversationStoreError.notFound }
            guard mkdirat(directory, name, 0o700) == 0, fsync(directory) == 0 else {
                throw CodexConversationStoreError.unsafeStorage
            }
        } else {
            guard (metadata.st_mode & S_IFMT) == S_IFDIR,
                  Self.metadataIsSafe(
                      mode: Int(metadata.st_mode & 0o777),
                      owner: Int(metadata.st_uid),
                      linkCount: Int(metadata.st_nlink),
                      directory: true
                  )
            else { throw CodexConversationStoreError.unsafeStorage }
        }
        let descriptor = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw CodexConversationStoreError.unsafeStorage }
        return descriptor
    }

    private func readJSON<T: Decodable>(directory: Int32, name: String) throws -> T {
        let descriptor = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0 {
            if errno == ENOENT { throw CodexConversationStoreError.notFound }
            throw CodexConversationStoreError.unsafeStorage
        }
        defer { close(descriptor) }
        try validateFile(descriptor)
        let data = try readAll(descriptor)
        do {
            guard try !StrictCodexJSONScanner.hasDuplicateObjectMembers(data) else {
                throw CodexConversationStoreError.invalidRecord
            }
            return try JSONDecoder().decode(T.self, from: data)
        } catch let error as CodexConversationStoreError {
            throw error
        } catch {
            throw CodexConversationStoreError.invalidRecord
        }
    }

    private func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        guard data.count <= Self.maximumBytes else { throw CodexConversationStoreError.invalidRecord }
        return data
    }

    private func write(_ data: Data, directory: Int32, name: String, replace: Bool) throws {
        let temporary = ".tmp-\(UUID().uuidString.lowercased())"
        let descriptor = openat(directory, temporary, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw CodexConversationStoreError.unsafeStorage }
        var temporaryExists = true
        defer {
            close(descriptor)
            if temporaryExists { _ = unlinkat(directory, temporary, 0) }
        }
        guard fchmod(descriptor, 0o600) == 0 else { throw CodexConversationStoreError.unsafeStorage }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                guard count > 0 else { throw CodexConversationStoreError.unsafeStorage }
                offset += count
            }
        }
        guard fsync(descriptor) == 0 else { throw CodexConversationStoreError.unsafeStorage }
        if replace {
            var metadata = stat()
            if fstatat(directory, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 {
                guard (metadata.st_mode & S_IFMT) == S_IFREG,
                      Self.metadataIsSafe(
                          mode: Int(metadata.st_mode & 0o777),
                          owner: Int(metadata.st_uid),
                          linkCount: Int(metadata.st_nlink),
                          directory: false
                      )
                else { throw CodexConversationStoreError.unsafeStorage }
            }
            guard renameat(directory, temporary, directory, name) == 0 else {
                throw CodexConversationStoreError.unsafeStorage
            }
        } else {
            guard renameatx_np(directory, temporary, directory, name, UInt32(RENAME_EXCL)) == 0 else {
                if errno == EEXIST { throw CodexConversationStoreError.alreadyExists }
                throw CodexConversationStoreError.unsafeStorage
            }
        }
        temporaryExists = false
        guard fsync(directory) == 0 else { throw CodexConversationStoreError.unsafeStorage }
    }

    private func validateFile(_ descriptor: Int32) throws {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              Self.metadataIsSafe(
                  mode: Int(metadata.st_mode & 0o777),
                  owner: Int(metadata.st_uid),
                  linkCount: Int(metadata.st_nlink),
                  directory: false
              )
        else { throw CodexConversationStoreError.unsafeStorage }
    }

    private func readAll(_ descriptor: Int32) throws -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 512)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            guard count >= 0 else { throw CodexConversationStoreError.unsafeStorage }
            if count == 0 { break }
            data.append(buffer, count: count)
            guard data.count <= Self.maximumBytes else { throw CodexConversationStoreError.invalidRecord }
        }
        return data
    }
}

private enum StrictCodexJSONError: Error { case malformed }

private struct StrictCodexJSONScanner {
    private let bytes: [UInt8]
    private var index = 0
    private var duplicateObjectMembers = false

    static func hasDuplicateObjectMembers(_ data: Data) throws -> Bool {
        var scanner = Self(bytes: Array(data))
        scanner.skipWhitespace()
        try scanner.parseValue()
        scanner.skipWhitespace()
        guard scanner.index == scanner.bytes.count else { throw StrictCodexJSONError.malformed }
        return scanner.duplicateObjectMembers
    }

    private mutating func parseValue() throws {
        skipWhitespace()
        guard let byte = current else { throw StrictCodexJSONError.malformed }
        switch byte {
        case 0x7b: try parseObject()
        case 0x5b: try parseArray()
        case 0x22: _ = try parseString()
        case 0x74: try consumeLiteral("true")
        case 0x66: try consumeLiteral("false")
        case 0x6e: try consumeLiteral("null")
        case 0x2d, 0x30...0x39: try consumeNumber()
        default: throw StrictCodexJSONError.malformed
        }
    }

    private mutating func parseObject() throws {
        try consume(0x7b)
        skipWhitespace()
        if current == 0x7d { index += 1; return }
        var keys = Set<String>()
        while true {
            guard current == 0x22 else { throw StrictCodexJSONError.malformed }
            let key = try parseString()
            if !keys.insert(key).inserted { duplicateObjectMembers = true }
            skipWhitespace()
            try consume(0x3a)
            try parseValue()
            skipWhitespace()
            if current == 0x2c {
                index += 1
                skipWhitespace()
                continue
            }
            try consume(0x7d)
            return
        }
    }

    private mutating func parseArray() throws {
        try consume(0x5b)
        skipWhitespace()
        if current == 0x5d { index += 1; return }
        while true {
            try parseValue()
            skipWhitespace()
            if current == 0x2c {
                index += 1
                skipWhitespace()
                continue
            }
            try consume(0x5d)
            return
        }
    }

    private mutating func parseString() throws -> String {
        try consume(0x22)
        var out = [UInt8]()
        while let byte = current {
            index += 1
            if byte == 0x22 { return String(bytes: out, encoding: .utf8) ?? "" }
            if byte == 0x5c {
                guard let escaped = current else { throw StrictCodexJSONError.malformed }
                index += 1
                out.append(escaped)
                continue
            }
            out.append(byte)
        }
        throw StrictCodexJSONError.malformed
    }

    private mutating func consumeLiteral(_ literal: String) throws {
        for scalar in literal.utf8 {
            try consume(scalar)
        }
    }

    private mutating func consumeNumber() throws {
        while let byte = current, (0x30...0x39).contains(byte) || byte == 0x2e || byte == 0x2d || byte == 0x2b || byte == 0x65 || byte == 0x45 {
            index += 1
        }
    }

    private mutating func consume(_ expected: UInt8) throws {
        guard current == expected else { throw StrictCodexJSONError.malformed }
        index += 1
    }

    private mutating func skipWhitespace() {
        while let byte = current, byte == 0x20 || byte == 0x0a || byte == 0x0d || byte == 0x09 {
            index += 1
        }
    }

    private var current: UInt8? {
        guard index < bytes.count else { return nil }
        return bytes[index]
    }
}
